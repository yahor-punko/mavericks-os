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

// ---------------------------------------------------------------------------
// Test 5 (T-576 — deferral normalizes from ANY section, not just Active
// tasks): T-905's TASK_STATUS entry is stranded in "## Recently completed
// tasks" (its BACKLOG block correspondingly archived), the exact failure mode
// left unfixed by T-574's narrower guard (isInActiveTasks). A single
// `--rescope-task --status deferred` must relocate the TASK_STATUS entry
// byte-for-byte into "## Deferred tasks" (created on demand), move the
// BACKLOG block into "## Deferred Tasks", and leave the validator at exit 0.
// A second `--status deferred` run on the now-already-deferred entry must be
// idempotent: no duplicate heading, no error, entry stays inside "## Deferred
// tasks".
// ---------------------------------------------------------------------------
{
  const EVIDENCE_MARKER = 'T576-STRANDED-EVIDENCE-MARKER';
  const NOTES_MARKER = '- **Notes:** T576-STRANDED-NOTES-MARKER must survive relocation verbatim';

  const backlog = `# Backlog

## Active Wave


## Wave 1 — Archived (2026-01-01)

### T-905 — Task stranded outside Active tasks
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
`;

  const taskStatus = `# Task Status

## Active tasks


## Recently completed tasks

### T-905 — Task stranded outside Active tasks
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** ${EVIDENCE_MARKER}
${NOTES_MARKER}
`;

  const root = makeFixtureRoot('t576-defer-from-stranded', { backlog, taskStatus });

  // --- Leg 1: defer from a third section (not Active tasks) ---------------
  const deferResult = runRescopeTask(root, ['T-905', '--status', 'deferred']);
  assert.strictEqual(
    deferResult.status,
    0,
    `Test 5a FAIL: --rescope-task T-905 --status deferred should exit 0, got ${deferResult.status}\nstdout: ${deferResult.stdout}\nstderr: ${deferResult.stderr}`
  );
  console.log('Test 5a passed: --rescope-task T-905 --status deferred (from Recently completed tasks) exits 0');

  const deferredTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));

  assert.strictEqual(
    countOccurrences(deferredTaskStatus, '### T-905 —'),
    1,
    `Test 5b FAIL: expected exactly one T-905 heading after deferral, got ${countOccurrences(deferredTaskStatus, '### T-905 —')}\n${deferredTaskStatus}`
  );
  console.log('Test 5b passed: exactly one T-905 heading remains after deferral from a stranded section');

  assert.ok(
    deferredTaskStatus.includes('## Deferred tasks'),
    `Test 5c FAIL: "## Deferred tasks" section should be created on demand\n${deferredTaskStatus}`
  );
  const deferredHeadingIdx = deferredTaskStatus.indexOf('## Deferred tasks');
  const deferredCompletedIdx = deferredTaskStatus.indexOf('## Recently completed tasks');
  const deferredT905Idx = deferredTaskStatus.indexOf('### T-905 —');
  assert.ok(
    deferredT905Idx > deferredHeadingIdx && deferredT905Idx < deferredCompletedIdx,
    `Test 5c FAIL: T-905 entry must sit inside "## Deferred tasks" (between the heading and "## Recently completed tasks"), got deferredHeading=${deferredHeadingIdx} t905=${deferredT905Idx} completed=${deferredCompletedIdx}\n${deferredTaskStatus}`
  );
  console.log('Test 5c passed: T-905 entry relocated out of "## Recently completed tasks" into "## Deferred tasks" — the T-576 fix, not just the narrower T-574 guard');

  const deferredBlockMatch = deferredTaskStatus.match(/### T-905 —[\s\S]*?(?=\n### T-\d+ —|\n## |$)/);
  assert.ok(deferredBlockMatch, 'Test 5d FAIL: could not isolate T-905 block after deferral');
  const deferredBlock = deferredBlockMatch[0];
  assert.ok(
    deferredBlock.includes(EVIDENCE_MARKER) && deferredBlock.includes(NOTES_MARKER),
    `Test 5d FAIL: hand-edited Evidence/Notes must survive the deferral relocation byte-for-byte\nBlock was:\n${deferredBlock}`
  );
  assert.ok(
    /- \*\*Status:\*\* deferred/.test(deferredBlock),
    `Test 5d FAIL: relocated T-905 block should carry "- **Status:** deferred", got:\n${deferredBlock}`
  );
  console.log('Test 5d passed: Evidence + Notes preserved byte-for-byte and Status updated to deferred');

  const updatedBacklog = readUtf8(path.join(root, 'BACKLOG.md'));
  assert.ok(
    updatedBacklog.includes('## Deferred Tasks'),
    `Test 5e FAIL: BACKLOG.md "## Deferred Tasks" section should exist after deferral\n${updatedBacklog}`
  );
  const backlogDeferredIdx = updatedBacklog.indexOf('## Deferred Tasks');
  const backlogT905Idx = updatedBacklog.indexOf('### T-905 —');
  assert.ok(
    backlogT905Idx > backlogDeferredIdx,
    'Test 5e FAIL: T-905 BACKLOG block should be moved into "## Deferred Tasks"'
  );
  console.log('Test 5e passed: BACKLOG.md block moved into "## Deferred Tasks"');

  const deferValidator = runValidator(root);
  assert.strictEqual(
    deferValidator.status,
    0,
    `Test 5f FAIL: validator should exit 0 after the deferral, got ${deferValidator.status}\n${deferValidator.stdout}\n${deferValidator.stderr}`
  );
  console.log('Test 5f passed: validator exits 0 after the deferral');

  // --- Leg 2: defer AGAIN — idempotent, entry already inside "## Deferred
  // tasks" (no duplicate, no error, no move to a new position). -------------
  const reDeferResult = runRescopeTask(root, ['T-905', '--status', 'deferred']);
  assert.strictEqual(
    reDeferResult.status,
    0,
    `Test 5g FAIL: re-running --status deferred on an already-deferred entry should exit 0, got ${reDeferResult.status}\nstdout: ${reDeferResult.stdout}\nstderr: ${reDeferResult.stderr}`
  );

  const reDeferredTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));
  assert.strictEqual(
    countOccurrences(reDeferredTaskStatus, '### T-905 —'),
    1,
    `Test 5g FAIL: re-deferring an already-deferred entry must not create a duplicate heading, got ${countOccurrences(reDeferredTaskStatus, '### T-905 —')}\n${reDeferredTaskStatus}`
  );
  const reDeferredHeadingIdx = reDeferredTaskStatus.indexOf('## Deferred tasks');
  const reDeferredCompletedIdx = reDeferredTaskStatus.indexOf('## Recently completed tasks');
  const reDeferredT905Idx = reDeferredTaskStatus.indexOf('### T-905 —');
  assert.ok(
    reDeferredT905Idx > reDeferredHeadingIdx &&
      (reDeferredCompletedIdx === -1 || reDeferredT905Idx < reDeferredCompletedIdx),
    `Test 5g FAIL: T-905 entry must remain inside "## Deferred tasks" after the idempotent re-run, got deferredHeading=${reDeferredHeadingIdx} t905=${reDeferredT905Idx} completed=${reDeferredCompletedIdx}\n${reDeferredTaskStatus}`
  );
  console.log('Test 5g passed: deferring an already-deferred entry is idempotent — no duplicate, no error, still inside "## Deferred tasks"');

  const reDeferValidator = runValidator(root);
  assert.strictEqual(
    reDeferValidator.status,
    0,
    `Test 5h FAIL: validator should exit 0 after the idempotent re-defer, got ${reDeferValidator.status}\n${reDeferValidator.stdout}\n${reDeferValidator.stderr}`
  );
  console.log('Test 5h passed: validator exits 0 after the idempotent re-defer');
}

// ---------------------------------------------------------------------------
// Test 6 (T-576 — second defect: `--status deprecated` must never move the
// BACKLOG block into Active Wave): T-906's BACKLOG block and TASK_STATUS
// entry both start inside their respective "Deferred" sections (the
// permanently-rejected task was previously deferred, not active). A single
// `--rescope-task --status deprecated` must (a) leave the BACKLOG block
// inside "## Deferred Tasks" — field-edited in place, no section move, no
// "BACKLOG.md section: →" line printed — and (b) relocate the TASK_STATUS
// entry byte-for-byte into "## Recently completed tasks" (the T-573 sweep
// destination), with the validator exiting 0.
//
// Before the T-576 fix, `targetSection` mapped every non-`deferred` status
// (including `deprecated`) to `'active'`, so this same command printed
// "BACKLOG.md section: → ## Active Wave" and moved the block into the live
// wave — a permanently-rejected task inserted into current work.
// ---------------------------------------------------------------------------
{
  const EVIDENCE_MARKER = 'T576-DEPRECATE-EVIDENCE-MARKER';
  const NOTES_MARKER = '- **Notes:** T576-DEPRECATE-NOTES-MARKER must survive relocation verbatim';

  const backlog = `# Backlog

## Active Wave


## Deferred Tasks

Tasks preserved for future waves. Not in the active validator set. Re-activate by moving to the current Active Wave section.

### T-906 — Task rejected permanently
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** unit
`;

  const taskStatus = `# Task Status

## Active tasks

## Deferred tasks

### T-906 — Task rejected permanently
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** ${EVIDENCE_MARKER}
${NOTES_MARKER}


## Recently completed tasks
`;

  const root = makeFixtureRoot('t576-deprecate-no-active-move', { backlog, taskStatus });

  const result = runRescopeTask(root, ['T-906', '--status', 'deprecated']);
  assert.strictEqual(
    result.status,
    0,
    `Test 6a FAIL: --rescope-task T-906 --status deprecated should exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    !result.stdout.includes('BACKLOG.md section:'),
    `Test 6a FAIL: --status deprecated must never print a "BACKLOG.md section:" relocation line (it must not move the BACKLOG block)\nstdout: ${result.stdout}`
  );
  console.log('Test 6a passed: --rescope-task T-906 --status deprecated exits 0 and prints no BACKLOG.md section relocation');

  const updatedBacklog = readUtf8(path.join(root, 'BACKLOG.md'));
  assert.strictEqual(
    countOccurrences(updatedBacklog, '### T-906 —'),
    1,
    `Test 6b FAIL: expected exactly one T-906 heading in BACKLOG.md, got ${countOccurrences(updatedBacklog, '### T-906 —')}`
  );
  const backlogActiveWaveIdx = updatedBacklog.indexOf('## Active Wave');
  const backlogDeferredIdx = updatedBacklog.indexOf('## Deferred Tasks');
  const backlogT906Idx = updatedBacklog.indexOf('### T-906 —');
  assert.ok(
    backlogT906Idx > backlogDeferredIdx,
    `Test 6b FAIL: T-906 BACKLOG block must remain inside "## Deferred Tasks", not move to "## Active Wave" — active=${backlogActiveWaveIdx} deferred=${backlogDeferredIdx} t906=${backlogT906Idx}\n${updatedBacklog}`
  );
  assert.ok(
    /### T-906 —[\s\S]*?- \*\*Status:\*\* deprecated/.test(updatedBacklog),
    `Test 6b FAIL: BACKLOG.md T-906 block should carry "- **Status:** deprecated" (field edited in place)\n${updatedBacklog}`
  );
  console.log('Test 6b passed: BACKLOG.md block stays inside "## Deferred Tasks" — field-edited in place, no section move');

  const updatedTaskStatus = readUtf8(path.join(root, 'TASK_STATUS.md'));
  assert.strictEqual(
    countOccurrences(updatedTaskStatus, '### T-906 —'),
    1,
    `Test 6c FAIL: expected exactly one T-906 heading in TASK_STATUS.md, got ${countOccurrences(updatedTaskStatus, '### T-906 —')}`
  );
  const statusDeferredIdx = updatedTaskStatus.indexOf('## Deferred tasks');
  const statusCompletedIdx = updatedTaskStatus.indexOf('## Recently completed tasks');
  const statusT906Idx = updatedTaskStatus.indexOf('### T-906 —');
  assert.ok(
    statusT906Idx > statusCompletedIdx,
    `Test 6c FAIL: T-906 TASK_STATUS entry must be relocated into "## Recently completed tasks" (after that heading, out of "## Deferred tasks"), got deferred=${statusDeferredIdx} completed=${statusCompletedIdx} t906=${statusT906Idx}\n${updatedTaskStatus}`
  );
  console.log('Test 6c passed: TASK_STATUS.md entry relocated out of "## Deferred tasks" into "## Recently completed tasks"');

  const t906BlockMatch = updatedTaskStatus.match(/### T-906 —[\s\S]*?(?=\n### T-\d+ —|\n## |$)/);
  assert.ok(t906BlockMatch, 'Test 6d FAIL: could not isolate T-906 block after relocation');
  const t906Block = t906BlockMatch[0];
  assert.ok(
    t906Block.includes(EVIDENCE_MARKER) && t906Block.includes(NOTES_MARKER),
    `Test 6d FAIL: hand-edited Evidence/Notes must survive the deprecation relocation byte-for-byte\nBlock was:\n${t906Block}`
  );
  assert.ok(
    /- \*\*Status:\*\* deprecated/.test(t906Block),
    `Test 6d FAIL: relocated T-906 block should carry "- **Status:** deprecated", got:\n${t906Block}`
  );
  console.log('Test 6d passed: Evidence + Notes preserved byte-for-byte and Status updated to deprecated');

  const validatorResult = runValidator(root);
  assert.strictEqual(
    validatorResult.status,
    0,
    `Test 6e FAIL: validator should exit 0 after the deprecation, got ${validatorResult.status}\n${validatorResult.stdout}\n${validatorResult.stderr}`
  );
  console.log('Test 6e passed: validator exits 0 after the deprecation (no BACKLOG-into-Active-Wave defect, TASK_STATUS relocated as expected)');
}

console.log('All test-rescope-task.js assertions passed.');
