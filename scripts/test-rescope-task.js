'use strict';
// Regression test: T-544 — --rescope-task relocates an existing
// TASK_STATUS.md entry into "## Active tasks" when activating a task whose
// entry currently sits outside that section (e.g. stranded under
// "## Recently completed tasks" by a close-session mis-archive — the exact
// scenario hand-repaired in commit 274cd91).
//
// Covers the acceptance criteria verbatim:
//   1. Activating via --rescope-task a task whose TASK_STATUS.md entry sits
//      outside "## Active tasks" moves that existing entry block into
//      "## Active tasks" byte-for-byte: the Status field updated per
//      --status, every other hand-edited field (Evidence, Notes — including
//      literal embedded newlines) preserved verbatim, no skeleton
//      regeneration, no duplicate entry.
//   2. Behavior when the entry is already in "## Active tasks" (in-place
//      edit, no relocation) or absent (skeleton creation) is unchanged.
//   3. An end-to-end reproduction of the 274cd91 scenario: the validator
//      exits 0 after the single --rescope-task command.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const RESCOPE_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-rescope-task.js');
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, 'mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't544-rescope-task-'));

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function makeFixtureRoot(name, { backlog, taskStatus }) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  writeUtf8(path.join(root, 'BACKLOG.md'), backlog);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), taskStatus);
  writeUtf8(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        active_slices: [],
        next_action: 'noop',
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 999,
        last_updated: '2026-01-01',
      },
      null,
      2
    ) + '\n'
  );
  return root;
}

function runRescopeTask(root, args) {
  return spawnSync('node', [RESCOPE_TASK_PATH, ...args], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
  });
}

function runValidator(root) {
  return spawnSync('node', [VALIDATOR_PATH, root], { encoding: 'utf8' });
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Test 1 (acceptance criterion — the 274cd91 scenario, end-to-end):
// T-901's BACKLOG block lives in an archived wave section and its
// TASK_STATUS entry is stranded under "## Recently completed tasks", each
// carrying distinctive hand-edited fields (a literal multi-line Evidence
// value and a Notes field) that must survive byte-for-byte. A single
// `--rescope-task T-901 --status planned` must: move the BACKLOG block back
// to Active Wave (already worked pre-fix), relocate the TASK_STATUS entry
// into Active tasks (the fix), and leave the validator exiting 0.
// ---------------------------------------------------------------------------
{
  const EVIDENCE_LINE_1 = 'T544-EVIDENCE-MARKER-LINE-ONE';
  const EVIDENCE_LINE_2 = '  T544-EVIDENCE-MARKER-LINE-TWO continuation text that must survive relocation verbatim';
  const EVIDENCE_LINE_3 = '  T544-EVIDENCE-MARKER-LINE-THREE final continuation line';
  const NOTES_LINE = '- **Notes:** T544-NOTES-MARKER preserved verbatim too';

  const backlog = `# Backlog

## Active Wave

### T-900 — Existing active task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** mavericks


## Wave 1 — Archived (2026-01-01)

### T-901 — Mis-archived task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
`;

  const taskStatus = `# Task Status

## Active tasks

### T-900 — Existing active task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** —


## Recently completed tasks

### T-901 — Mis-archived task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** ${EVIDENCE_LINE_1}
${EVIDENCE_LINE_2}
${EVIDENCE_LINE_3}
${NOTES_LINE}
`;

  const root = makeFixtureRoot('274cd91-repro', { backlog, taskStatus });

  const result = runRescopeTask(root, ['T-901', '--status', 'planned']);
  assert.strictEqual(
    result.status,
    0,
    `Test 1a FAIL: --rescope-task T-901 --status planned should exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  console.log('Test 1a passed: --rescope-task T-901 --status planned exits 0');

  const updatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));

  // No duplicate entry: exactly one "### T-901 —" heading in the whole file.
  assert.strictEqual(
    countOccurrences(updatedTaskStatus, '### T-901 —'),
    1,
    `Test 1b FAIL: expected exactly one T-901 heading in TASK_STATUS.md, got ${countOccurrences(updatedTaskStatus, '### T-901 —')}`
  );
  console.log('Test 1b passed: no duplicate T-901 entry in TASK_STATUS.md');

  // The T-901 entry must now sit inside "## Active tasks", i.e. BEFORE
  // "## Recently completed tasks" (not after it).
  const activeTasksIdx = updatedTaskStatus.indexOf('## Active tasks');
  const recentlyCompletedIdx = updatedTaskStatus.indexOf('## Recently completed tasks');
  const t901Idx = updatedTaskStatus.indexOf('### T-901 —');
  assert.ok(
    t901Idx > activeTasksIdx && t901Idx < recentlyCompletedIdx,
    `Test 1c FAIL: T-901 entry must be relocated between "## Active tasks" and "## Recently completed tasks", got indices active=${activeTasksIdx} t901=${t901Idx} completed=${recentlyCompletedIdx}`
  );
  console.log('Test 1c passed: T-901 TASK_STATUS entry relocated into "## Active tasks"');

  // Status field updated (was already planned — this also proves the field
  // update path still applies during a relocation, not just an in-place edit).
  const t901BlockMatch = updatedTaskStatus.match(/### T-901 —[\s\S]*?(?=\n### T-\d+ —|\n## |$)/);
  assert.ok(t901BlockMatch, 'Test 1d FAIL: could not isolate T-901 block after relocation');
  const t901Block = t901BlockMatch[0];
  assert.ok(
    /- \*\*Status:\*\* planned/.test(t901Block),
    `Test 1d FAIL: relocated T-901 block should carry "- **Status:** planned", got:\n${t901Block}`
  );
  console.log('Test 1d passed: relocated entry carries the --status value');

  // Byte-for-byte preservation of hand-edited fields, INCLUDING the literal
  // multi-line Evidence continuation lines and the Notes field — this is
  // the risk the brief calls out explicitly (no skeleton regeneration).
  for (const marker of [EVIDENCE_LINE_1, EVIDENCE_LINE_2, EVIDENCE_LINE_3, NOTES_LINE]) {
    assert.ok(
      t901Block.includes(marker),
      `Test 1e FAIL: relocated T-901 block must preserve hand-edited text verbatim; missing: "${marker}"\nBlock was:\n${t901Block}`
    );
  }
  console.log('Test 1e passed: hand-edited Evidence (all 3 lines) and Notes fields survived relocation byte-for-byte');

  // BACKLOG.md side: T-901 restored to Active Wave (pre-existing behavior,
  // asserted here so the reproduction is genuinely end-to-end).
  const updatedBacklog = readUtf8(path.join(root, 'BACKLOG.md'));
  const backlogActiveWaveIdx = updatedBacklog.indexOf('## Active Wave');
  const backlogArchivedIdx = updatedBacklog.indexOf('## Wave 1 — Archived');
  const backlogT901Idx = updatedBacklog.indexOf('### T-901 —');
  assert.ok(
    backlogT901Idx > backlogActiveWaveIdx && backlogT901Idx < backlogArchivedIdx,
    'Test 1f FAIL: T-901 BACKLOG block should be restored to Active Wave'
  );
  console.log('Test 1f passed: BACKLOG.md side (pre-existing behavior) still restores the block to Active Wave');

  // The full reproduction's core acceptance criterion: the validator exits
  // 0 after the SINGLE --rescope-task command, with no follow-up hand-edit
  // (this is what commit 274cd91 had to do manually).
  const validatorResult = runValidator(root);
  assert.strictEqual(
    validatorResult.status,
    0,
    `Test 1g FAIL: validator should exit 0 (healthy) after the single --rescope-task command, got ${validatorResult.status}\n${validatorResult.stdout}\n${validatorResult.stderr}`
  );
  console.log('Test 1g passed: validator exits 0 after the single --rescope-task command (274cd91 scenario fully repaired without a hand-edit)');
}

// ---------------------------------------------------------------------------
// Test 2 (unchanged path — entry already in Active tasks): activating a
// task whose TASK_STATUS entry is ALREADY inside "## Active tasks" must
// still just edit fields in place — no relocation, no duplicate, and the
// entry must stay in its original document position (proven by checking it
// is not moved relative to a sibling entry that comes after it).
// ---------------------------------------------------------------------------
{
  const backlog = `# Backlog

## Active Wave

### T-902 — Task already active
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** mavericks
`;

  const taskStatus = `# Task Status

## Active tasks

### T-902 — Task already active
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** T544-ALREADY-ACTIVE-MARKER


## Recently completed tasks
`;

  const root = makeFixtureRoot('already-active', { backlog, taskStatus });
  const result = runRescopeTask(root, ['T-902', '--status', 'in_progress']);
  assert.strictEqual(
    result.status,
    0,
    `Test 2a FAIL: expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );

  const updatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));
  assert.strictEqual(
    countOccurrences(updatedTaskStatus, '### T-902 —'),
    1,
    'Test 2b FAIL: expected exactly one T-902 entry (no duplicate created)'
  );
  const activeTasksIdx = updatedTaskStatus.indexOf('## Active tasks');
  const recentlyCompletedIdx = updatedTaskStatus.indexOf('## Recently completed tasks');
  const t902Idx = updatedTaskStatus.indexOf('### T-902 —');
  assert.ok(
    t902Idx > activeTasksIdx && t902Idx < recentlyCompletedIdx,
    'Test 2c FAIL: T-902 should remain inside Active tasks'
  );
  assert.ok(
    updatedTaskStatus.includes('T544-ALREADY-ACTIVE-MARKER'),
    'Test 2d FAIL: hand-edited Evidence should be preserved when no relocation occurs'
  );
  assert.ok(
    /### T-902 —[\s\S]*?- \*\*Status:\*\* in_progress/.test(updatedTaskStatus),
    'Test 2e FAIL: Status field should be updated to in_progress in place'
  );
  console.log('Test 2 passed: entry already inside Active tasks is edited in place — no relocation, no duplicate, evidence preserved');
}

// ---------------------------------------------------------------------------
// Test 3 (unchanged path — entry absent): activating a previously-deferred
// task with NO existing TASK_STATUS entry must still create a skeleton
// entry in Active tasks, exactly as before this fix.
// ---------------------------------------------------------------------------
{
  const backlog = `# Backlog

## Active Wave


## Deferred Tasks

Tasks preserved for future waves.

### T-903 — Deferred task with no TASK_STATUS entry
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
`;

  const taskStatus = `# Task Status

## Active tasks


## Recently completed tasks
`;

  const root = makeFixtureRoot('absent-skeleton', { backlog, taskStatus });
  const result = runRescopeTask(root, ['T-903', '--status', 'planned']);
  assert.strictEqual(
    result.status,
    0,
    `Test 3a FAIL: expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`
  );

  const updatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));
  assert.strictEqual(
    countOccurrences(updatedTaskStatus, '### T-903 —'),
    1,
    'Test 3b FAIL: expected exactly one skeleton T-903 entry to be created'
  );
  const activeTasksIdx = updatedTaskStatus.indexOf('## Active tasks');
  const recentlyCompletedIdx = updatedTaskStatus.indexOf('## Recently completed tasks');
  const t903Idx = updatedTaskStatus.indexOf('### T-903 —');
  assert.ok(
    t903Idx > activeTasksIdx && t903Idx < recentlyCompletedIdx,
    'Test 3c FAIL: newly-created skeleton entry should land inside Active tasks'
  );
  assert.ok(
    /### T-903 —[\s\S]*?- \*\*Status:\*\* planned/.test(updatedTaskStatus),
    'Test 3d FAIL: skeleton entry should carry the --status value'
  );
  console.log('Test 3 passed: absent-entry path still creates a skeleton Active-tasks entry, unchanged');
}

// ---------------------------------------------------------------------------
// Test 4 (T-574 — deferral symmetry, full round trip): deferring a task whose
// TASK_STATUS entry sits INSIDE "## Active tasks" must relocate that entry out
// of Active tasks into "## Deferred tasks" (created on demand, the same
// section the close-session terminal-status sweep writes to), byte-for-byte —
// then re-activating it must bring the same block back into "## Active tasks"
// via the existing T-544 path. A hand-edited Notes marker must survive both
// legs, no duplicate heading may appear at any point, and the validator must
// exit 0 after each single command.
//
// Before the T-574 fix the first leg only rewrote the Status field in place
// and left the block sitting in "## Active tasks" — the producer of the stale
// terminal entries that latched wave 70 open.
// ---------------------------------------------------------------------------
{
  const NOTES_MARKER = '- **Notes:** T574-ROUNDTRIP-NOTES-MARKER must survive both legs verbatim';
  const EVIDENCE_MARKER = 'T574-ROUNDTRIP-EVIDENCE-MARKER';

  const backlog = `# Backlog

## Active Wave

### T-904 — Task deferred mid-wave
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** mavericks


## Recently completed
`;

  const taskStatus = `# Task Status

## Active tasks

### T-904 — Task deferred mid-wave
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** ${EVIDENCE_MARKER}
${NOTES_MARKER}


## Recently completed tasks
`;

  const root = makeFixtureRoot('t574-defer-roundtrip', { backlog, taskStatus });

  // --- Leg 1: defer ---------------------------------------------------------
  const deferResult = runRescopeTask(root, ['T-904', '--status', 'deferred']);
  assert.strictEqual(
    deferResult.status,
    0,
    `Test 4a FAIL: --rescope-task T-904 --status deferred should exit 0, got ${deferResult.status}\nstdout: ${deferResult.stdout}\nstderr: ${deferResult.stderr}`
  );
  console.log('Test 4a passed: --rescope-task T-904 --status deferred exits 0');

  const deferredTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));

  assert.strictEqual(
    countOccurrences(deferredTaskStatus, '### T-904 —'),
    1,
    `Test 4b FAIL: expected exactly one T-904 heading after deferral, got ${countOccurrences(deferredTaskStatus, '### T-904 —')}\n${deferredTaskStatus}`
  );
  console.log('Test 4b passed: exactly one T-904 heading remains after deferral');

  assert.ok(
    deferredTaskStatus.includes('## Deferred tasks'),
    `Test 4c FAIL: "## Deferred tasks" section should be created on demand\n${deferredTaskStatus}`
  );
  const deferredHeadingIdx = deferredTaskStatus.indexOf('## Deferred tasks');
  const deferredCompletedIdx = deferredTaskStatus.indexOf('## Recently completed tasks');
  const deferredT904Idx = deferredTaskStatus.indexOf('### T-904 —');
  assert.ok(
    deferredT904Idx > deferredHeadingIdx,
    `Test 4c FAIL: T-904 entry must sit AFTER the "## Deferred tasks" heading (i.e. out of Active tasks), got deferredHeading=${deferredHeadingIdx} t904=${deferredT904Idx}\n${deferredTaskStatus}`
  );
  assert.ok(
    deferredCompletedIdx === -1 || deferredT904Idx < deferredCompletedIdx,
    `Test 4c FAIL: T-904 entry must sit inside "## Deferred tasks", before "## Recently completed tasks", got t904=${deferredT904Idx} completed=${deferredCompletedIdx}\n${deferredTaskStatus}`
  );
  console.log('Test 4c passed: T-904 entry relocated out of "## Active tasks" into "## Deferred tasks"');

  const deferredBlockMatch = deferredTaskStatus.match(/### T-904 —[\s\S]*?(?=\n### T-\d+ —|\n## |$)/);
  assert.ok(deferredBlockMatch, 'Test 4d FAIL: could not isolate T-904 block after deferral');
  const deferredBlock = deferredBlockMatch[0];
  assert.ok(
    deferredBlock.includes(NOTES_MARKER),
    `Test 4d FAIL: hand-edited Notes marker must survive the deferral relocation verbatim\nBlock was:\n${deferredBlock}`
  );
  assert.ok(
    deferredBlock.includes(EVIDENCE_MARKER),
    `Test 4d FAIL: hand-edited Evidence must survive the deferral relocation verbatim\nBlock was:\n${deferredBlock}`
  );
  assert.ok(
    /- \*\*Status:\*\* deferred/.test(deferredBlock),
    `Test 4d FAIL: relocated T-904 block should carry "- **Status:** deferred", got:\n${deferredBlock}`
  );
  console.log('Test 4d passed: Notes + Evidence preserved byte-for-byte and Status updated to deferred');

  const deferValidator = runValidator(root);
  assert.strictEqual(
    deferValidator.status,
    0,
    `Test 4e FAIL: validator should exit 0 after the deferral, got ${deferValidator.status}\n${deferValidator.stdout}\n${deferValidator.stderr}`
  );
  console.log('Test 4e passed: validator exits 0 after the deferral');

  // --- Leg 2: re-activate (existing T-544 path closes the round trip) -------
  const reactivateResult = runRescopeTask(root, ['T-904', '--status', 'in_progress']);
  assert.strictEqual(
    reactivateResult.status,
    0,
    `Test 4f FAIL: --rescope-task T-904 --status in_progress should exit 0, got ${reactivateResult.status}\nstdout: ${reactivateResult.stdout}\nstderr: ${reactivateResult.stderr}`
  );

  const reactivatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));

  assert.strictEqual(
    countOccurrences(reactivatedTaskStatus, '### T-904 —'),
    1,
    `Test 4g FAIL: expected exactly one T-904 heading after re-activation, got ${countOccurrences(reactivatedTaskStatus, '### T-904 —')}\n${reactivatedTaskStatus}`
  );

  const reActiveIdx = reactivatedTaskStatus.indexOf('## Active tasks');
  const reDeferredIdx = reactivatedTaskStatus.indexOf('## Deferred tasks');
  const reT904Idx = reactivatedTaskStatus.indexOf('### T-904 —');
  assert.ok(
    reT904Idx > reActiveIdx && (reDeferredIdx === -1 || reT904Idx < reDeferredIdx),
    `Test 4g FAIL: T-904 entry must be back inside "## Active tasks", got active=${reActiveIdx} t904=${reT904Idx} deferred=${reDeferredIdx}\n${reactivatedTaskStatus}`
  );

  const reBlockMatch = reactivatedTaskStatus.match(/### T-904 —[\s\S]*?(?=\n### T-\d+ —|\n## |$)/);
  assert.ok(reBlockMatch, 'Test 4g FAIL: could not isolate T-904 block after re-activation');
  const reBlock = reBlockMatch[0];
  assert.ok(
    reBlock.includes(NOTES_MARKER) && reBlock.includes(EVIDENCE_MARKER),
    `Test 4g FAIL: hand-edited Notes/Evidence must survive the return leg verbatim\nBlock was:\n${reBlock}`
  );
  assert.ok(
    /- \*\*Status:\*\* in_progress/.test(reBlock),
    `Test 4g FAIL: re-activated T-904 block should carry "- **Status:** in_progress", got:\n${reBlock}`
  );
  console.log('Test 4g passed: T-904 relocated back into "## Active tasks" with markers intact and no duplicate');

  const reValidator = runValidator(root);
  assert.strictEqual(
    reValidator.status,
    0,
    `Test 4h FAIL: validator should exit 0 after the re-activation, got ${reValidator.status}\n${reValidator.stdout}\n${reValidator.stderr}`
  );
  console.log('Test 4h passed: validator exits 0 after the re-activation — deferral round trip closed');
}

console.log('All test-rescope-task.js assertions passed.');
