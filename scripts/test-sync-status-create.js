'use strict';
// Regression test: T-419 — auto-create missing TASK_STATUS entries in
// sync-status to complete the BACKLOG mirror. A task present in BACKLOG.md's
// Active Wave but absent from TASK_STATUS.md's Active tasks section should
// get a skeleton Active-tasks entry created (same shape --new-task writes,
// via the shared mavp-operator-lib entry builder), carrying BACKLOG's
// status, with exactly one stderr line "sync-status: created T-NNN entry".
//
// Covers:
//   1. Create — a new BACKLOG task absent from TASK_STATUS.md gets an entry
//      + the "created" line.
//   2. Skip-deprecated — a BACKLOG task with `- **Status:** deprecated` is
//      skipped: no entry, no output.
//   3. Skip-superseded — a BACKLOG task with a real `- **Superseded by:**`
//      value is skipped: no entry, no output.
//   4. Create-then-retitle (T-432) — after a skeleton entry is created with
//      BACKLOG's title, a subsequent BACKLOG rename is mirrored on its own
//      re-run as exactly one "sync-status: retitled T-NNN" line (no
//      duplicate "created" line for an entry that already exists).
//   6. Stranded-in-Deferred (T-578) — a BACKLOG task whose TASK_STATUS
//      heading exists ONLY inside "## Deferred tasks" gets no duplicate
//      heading created; the existing block is still status-synced in place,
//      its Notes marker survives verbatim, and exactly one stderr advisory
//      names the task, the section, and --rescope-task as the repair path.
//   7. Stranded-in-Recently-completed (T-578) — same as #6 but for a task
//      stranded in "## Recently completed tasks".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mavp-operator-sync-status.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't419-sync-status-create-'));

function writeFixture(name, backlogBody) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), `# Backlog\n\n## Active Wave\n${backlogBody}`, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# Task Status\n\n## Active tasks\n\n', 'utf8');
  return root;
}

function run(root) {
  const result = spawnSync('node', [SCRIPT], {
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Test 1: create — a new BACKLOG task absent from TASK_STATUS.md gets a
// skeleton entry + exactly the "created" line.
// ---------------------------------------------------------------------------
{
  const root = writeFixture(
    'create-fixture',
    `
### T-900 — Fixture task needing a TASK_STATUS entry
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
`
  );

  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 1 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: created T-900 entry\n',
    `Test 1 FAIL: expected exactly the created line, got: ${JSON.stringify(result.stderr)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 1 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    updated.includes('### T-900 — Fixture task needing a TASK_STATUS entry'),
    `Test 1 FAIL: expected new heading in TASK_STATUS.md, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Status:** in_progress'),
    `Test 1 FAIL: expected seeded status in_progress, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Owner role:** developer'),
    `Test 1 FAIL: expected owner role carried over, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Verification type:** runtime'),
    `Test 1 FAIL: expected verification type carried over, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Last verified by:** —') && updated.includes('- **Evidence:** —'),
    `Test 1 FAIL: expected skeleton shape (Last verified by / Evidence placeholders), got:\n${updated}`
  );
  console.log('Test 1 passed: missing BACKLOG task gets a skeleton TASK_STATUS entry + exactly the created line');

  // Re-running against the now-synced fixture must be a silent no-op.
  const secondRun = run(root);
  assert.strictEqual(secondRun.status, 0, `Test 1b FAIL: expected exit 0, got ${secondRun.status}`);
  assert.strictEqual(
    Buffer.byteLength(secondRun.stdout, 'utf8') + Buffer.byteLength(secondRun.stderr, 'utf8'),
    0,
    `Test 1b FAIL: expected a silent no-op on re-run, got stdout=${JSON.stringify(secondRun.stdout)} stderr=${JSON.stringify(secondRun.stderr)}`
  );
  console.log('Test 1b passed: re-running after creation is a silent no-op (idempotent)');
}

// ---------------------------------------------------------------------------
// Test 2: skip-deprecated — a BACKLOG task with Status: deprecated produces
// no entry and no output.
// ---------------------------------------------------------------------------
{
  const root = writeFixture(
    'skip-deprecated-fixture',
    `
### T-901 — Deprecated fixture task
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** runtime
`
  );

  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 2 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'),
    0,
    `Test 2 FAIL: expected zero bytes on stdout+stderr for a deprecated task, got stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    !updated.includes('T-901'),
    `Test 2 FAIL: expected no T-901 entry to be created, got:\n${updated}`
  );
  console.log('Test 2 passed: a deprecated BACKLOG task is skipped — no entry, no output');
}

// ---------------------------------------------------------------------------
// Test 3: skip-superseded — a BACKLOG task with a real Superseded by: value
// produces no entry and no output.
// ---------------------------------------------------------------------------
{
  const root = writeFixture(
    'skip-superseded-fixture',
    `
### T-902 — Superseded fixture task
- **Status:** planned
- **Owner role:** developer
- **Superseded by:** T-900
- **Verification type:** runtime
`
  );

  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 3 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8'),
    0,
    `Test 3 FAIL: expected zero bytes on stdout+stderr for a superseded task, got stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    !updated.includes('T-902'),
    `Test 3 FAIL: expected no T-902 entry to be created, got:\n${updated}`
  );
  console.log('Test 3 passed: a superseded BACKLOG task is skipped — no entry, no output');
}

// ---------------------------------------------------------------------------
// Test 4 (T-432): create-then-retitle — after a skeleton entry is created,
// renaming the task in BACKLOG.md and re-running mirrors the new title on
// TASK_STATUS.md's heading with exactly one "retitled" line (no "created"
// line, since the entry already exists).
// ---------------------------------------------------------------------------
{
  const root = writeFixture(
    'create-then-retitle-fixture',
    `
### T-903 — Original fixture title
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
`
  );

  const created = run(root);
  assert.strictEqual(created.status, 0, `Test 4 FAIL (create step): expected exit 0, got ${created.status}`);
  assert.strictEqual(
    created.stderr,
    'sync-status: created T-903 entry\n',
    `Test 4 FAIL (create step): expected exactly the created line, got: ${JSON.stringify(created.stderr)}`
  );

  // Simulate a direct rename in BACKLOG.md (e.g. a manual edit rather than --rename-task).
  const backlogPath = path.join(root, 'BACKLOG.md');
  const renamedBacklog = fs
    .readFileSync(backlogPath, 'utf8')
    .replace('### T-903 — Original fixture title', '### T-903 — Renamed fixture title');
  fs.writeFileSync(backlogPath, renamedBacklog, 'utf8');

  const retitled = run(root);
  assert.strictEqual(retitled.status, 0, `Test 4 FAIL (retitle step): expected exit 0, got ${retitled.status}`);
  assert.strictEqual(
    retitled.stderr,
    'sync-status: retitled T-903\n',
    `Test 4 FAIL (retitle step): expected exactly the retitled line, got: ${JSON.stringify(retitled.stderr)}`
  );
  assert.strictEqual(
    Buffer.byteLength(retitled.stdout, 'utf8'),
    0,
    `Test 4 FAIL (retitle step): expected zero bytes on stdout, got: ${JSON.stringify(retitled.stdout)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    updated.includes('### T-903 — Renamed fixture title'),
    `Test 4 FAIL: expected TASK_STATUS.md heading rewritten to the renamed title, got:\n${updated}`
  );
  console.log('Test 4 passed: a BACKLOG rename after auto-creation is mirrored as exactly the retitled line');
}

// ---------------------------------------------------------------------------
// Test 5 (T-485): four-section adopter layout — "## Active tasks" is
// followed by "## Parked — Wave N" and "## Deferred tasks" before
// "## Recently completed tasks". A skeleton entry created for a BACKLOG task
// missing from TASK_STATUS.md must land inside "## Active tasks" (not the
// intermediate sections), and a second sync-status pass over the resulting
// file must create no duplicate.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'four-section-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# Backlog

## Active Wave
### T-904 — Fixture task in a four-section adopter layout
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# Task Status

## Active tasks

### T-800 — Pre-existing active task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —

## Parked — Wave 3
### T-700 — A parked task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —

## Deferred tasks
### T-600 — A deferred task
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —

## Recently completed tasks
### T-500 — A completed task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** commit: abc1234
`,
    'utf8'
  );

  const result = run(root);
  assert.strictEqual(result.status, 0, `Test 5 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: created T-904 entry\n',
    `Test 5 FAIL: expected exactly the created line, got: ${JSON.stringify(result.stderr)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');

  // Assertion (a): the new entry lands inside "## Active tasks", i.e. before
  // "## Parked — Wave 3" (the next "## " heading after "## Active tasks"),
  // and NOT inside the intermediate Parked/Deferred sections.
  const activeSectionStart = updated.indexOf('## Active tasks');
  const parkedSectionStart = updated.indexOf('## Parked — Wave 3');
  const deferredSectionStart = updated.indexOf('## Deferred tasks');
  const newEntryIdx = updated.indexOf('### T-904');
  assert.ok(
    activeSectionStart !== -1 && parkedSectionStart !== -1 && newEntryIdx !== -1,
    `Test 5 FAIL: expected all anchor sections and the new entry to be present, got:\n${updated}`
  );
  assert.ok(
    newEntryIdx > activeSectionStart && newEntryIdx < parkedSectionStart,
    `Test 5 FAIL: expected T-904 entry to land inside "## Active tasks" (between index ${activeSectionStart} and ${parkedSectionStart}), got at index ${newEntryIdx}:\n${updated}`
  );
  assert.ok(
    newEntryIdx < deferredSectionStart,
    `Test 5 FAIL: expected T-904 entry to land before "## Deferred tasks", got at index ${newEntryIdx}:\n${updated}`
  );
  console.log('Test 5a passed: new skeleton entry lands inside "## Active tasks", not an intermediate section');

  // Assertion (b): a second sync-status pass over the resulting file (which
  // now already contains T-904 in BACKLOG's Active Wave AND in TASK_STATUS's
  // Active tasks section) must be a silent no-op — no duplicate T-904 entry,
  // no further output. This is the assertion that proves the
  // self-multiplication bug (an entry misplaced outside "## Active tasks"
  // being endlessly re-created) is dead.
  const secondRun = run(root);
  assert.strictEqual(secondRun.status, 0, `Test 5b FAIL: expected exit 0, got ${secondRun.status}`);
  assert.strictEqual(
    Buffer.byteLength(secondRun.stdout, 'utf8') + Buffer.byteLength(secondRun.stderr, 'utf8'),
    0,
    `Test 5b FAIL: expected a silent no-op on second run, got stdout=${JSON.stringify(secondRun.stdout)} stderr=${JSON.stringify(secondRun.stderr)}`
  );

  const afterSecondRun = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  const occurrences = (afterSecondRun.match(/### T-904\b/g) || []).length;
  assert.strictEqual(
    occurrences,
    1,
    `Test 5b FAIL: expected exactly one T-904 entry after a second sync-status pass, found ${occurrences}, got:\n${afterSecondRun}`
  );
  console.log('Test 5b passed: a second sync-status pass creates no duplicate T-904 entry (self-multiplication is dead)');
}

// ---------------------------------------------------------------------------
// Test 6 (T-578): stranded-in-Deferred — a BACKLOG task (`planned`) whose
// TASK_STATUS heading exists ONLY inside "## Deferred tasks" (with a Notes
// marker) must not get a duplicate heading created. The existing block is
// still status-synced in place, the Notes marker survives verbatim, and
// exactly one stderr advisory names the task, the section, and
// --rescope-task.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'stranded-deferred-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# Backlog

## Active Wave
### T-900 — Fixture task deferred stranded
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# Task Status

## Active tasks

## Deferred tasks
### T-900 — Fixture task deferred stranded
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —
- **Notes:** stranded marker text should survive
`,
    'utf8'
  );

  const before = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  const beforeCount = (before.match(/### T-900\b/g) || []).length;
  assert.strictEqual(beforeCount, 1, `Test 6 FAIL: expected 1 heading before running, got ${beforeCount}`);

  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 6 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: synced T-900: deferred -> planned\n' +
      'sync-status: T-900 found in ## Deferred tasks, not in "## Active tasks" — use --rescope-task to relocate\n',
    `Test 6 FAIL: expected exactly the synced line + one stranded advisory, got: ${JSON.stringify(result.stderr)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 6 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  const afterCount = (updated.match(/### T-900\b/g) || []).length;
  assert.strictEqual(
    afterCount,
    1,
    `Test 6 FAIL: expected heading count to stay exactly 1 (pre-fix baseline was 2), got ${afterCount}, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Notes:** stranded marker text should survive'),
    `Test 6 FAIL: expected the Notes marker to survive verbatim, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Status:** planned'),
    `Test 6 FAIL: expected the existing stranded block to be status-synced to planned, got:\n${updated}`
  );
  assert.ok(
    !updated.includes('## Active tasks\n\n### T-900') && !updated.includes('## Active tasks\n### T-900'),
    `Test 6 FAIL: expected no new T-900 skeleton inside "## Active tasks", got:\n${updated}`
  );
  console.log('Test 6 passed: a task stranded in "## Deferred tasks" is not duplicated, its block is still status-synced, its Notes marker survives, and exactly one stderr advisory is emitted');

  // A second run with the status already in sync must still surface the
  // advisory (the structural stranding is unresolved) but must not touch
  // the file (no duplicate, no rewrite of the unchanged block).
  const secondRun = run(root);
  assert.strictEqual(secondRun.status, 0, `Test 6b FAIL: expected exit 0, got ${secondRun.status}`);
  assert.strictEqual(
    secondRun.stderr,
    'sync-status: T-900 found in ## Deferred tasks, not in "## Active tasks" — use --rescope-task to relocate\n',
    `Test 6b FAIL: expected exactly the stranded advisory (no synced line, status already matches), got: ${JSON.stringify(secondRun.stderr)}`
  );
  const afterSecond = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.strictEqual(
    (afterSecond.match(/### T-900\b/g) || []).length,
    1,
    `Test 6b FAIL: expected heading count to stay exactly 1 on a second run, got:\n${afterSecond}`
  );
  console.log('Test 6b passed: a second run against an already-synced stranded task re-surfaces the advisory without touching the file');
}

// ---------------------------------------------------------------------------
// Test 7 (T-578): stranded-in-Recently-completed — same defect, entry
// stranded in "## Recently completed tasks" instead of "## Deferred tasks".
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'stranded-completed-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# Backlog

## Active Wave
### T-901 — Fixture task completed stranded
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# Task Status

## Active tasks

## Recently completed tasks
### T-901 — Fixture task completed stranded
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** commit: abc1234
- **Notes:** completed marker text should survive
`,
    'utf8'
  );

  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 7 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: synced T-901: merged -> planned\n' +
      'sync-status: T-901 found in ## Recently completed tasks, not in "## Active tasks" — use --rescope-task to relocate\n',
    `Test 7 FAIL: expected exactly the synced line + one stranded advisory, got: ${JSON.stringify(result.stderr)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  const afterCount = (updated.match(/### T-901\b/g) || []).length;
  assert.strictEqual(
    afterCount,
    1,
    `Test 7 FAIL: expected heading count to stay exactly 1, got ${afterCount}, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Notes:** completed marker text should survive'),
    `Test 7 FAIL: expected the Notes marker to survive verbatim, got:\n${updated}`
  );
  assert.ok(
    updated.includes('- **Evidence:** commit: abc1234'),
    `Test 7 FAIL: expected the Evidence field to survive verbatim, got:\n${updated}`
  );
  console.log('Test 7 passed: a task stranded in "## Recently completed tasks" is not duplicated, its block is still status-synced, and exactly one stderr advisory is emitted');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-419/T-485/T-578 assertions passed.');
