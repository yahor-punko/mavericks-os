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
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-419 assertions passed.');
