'use strict';
// Regression test: T-418 — silence no-op output in mavp-operator-sync-status.js
// so the PostToolUse hook stops surfacing error-looking feedback on every
// BACKLOG/TASK_STATUS edit.
//
// Covers:
//   1. No-op path (BACKLOG.md and TASK_STATUS.md statuses already in sync):
//      running the script produces zero bytes on stdout AND stderr, exit 0.
//   2. Mutation path (a status difference between BACKLOG.md and
//      TASK_STATUS.md): TASK_STATUS.md is updated and exactly one stderr
//      line "sync-status: synced T-NNN: <old> -> <new>" is emitted.
//   3. Real-error path (missing files) still emits stderr.
//
// Also covers (T-432 — heading-title mirror):
//   5. Titles already match: silent no-op preserved (T-418 contract holds).
//   6. A BACKLOG heading title differing from the TASK_STATUS heading title:
//      the TASK_STATUS heading is rewritten and exactly one stderr line
//      "sync-status: retitled T-NNN" is emitted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mavp-operator-sync-status.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't418-sync-status-'));

function makeFixture(
  name,
  {
    backlogStatus = 'in_progress',
    taskStatusStatus = 'in_progress',
    backlogTitle = 'Fixture task',
    taskStatusTitle = 'Fixture task',
  } = {}
) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# Backlog\n\n## Active Wave\n\n### T-900 — ${backlogTitle}\n- **Status:** ${backlogStatus}\n- **Owner role:** developer\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# Task Status\n\n## Active tasks\n\n### T-900 — ${taskStatusTitle}\n- **Status:** ${taskStatusStatus}\n- **Owner role:** developer\n- **Evidence:** —\n`,
    'utf8'
  );

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
// Test 1: statuses already in sync -> zero bytes on stdout AND stderr, exit 0.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('in-sync-fixture', { backlogStatus: 'in_progress', taskStatusStatus: 'in_progress' });
  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 1 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 1 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stderr, 'utf8'),
    0,
    `Test 1 FAIL: expected zero bytes on stderr, got: ${JSON.stringify(result.stderr)}`
  );
  console.log('Test 1 passed: statuses already in sync produces zero bytes on stdout and stderr, exit 0');
}

// ---------------------------------------------------------------------------
// Test 2: a status difference -> TASK_STATUS.md updated + exactly one
// "sync-status: synced T-NNN: <old> -> <new>" stderr line.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('mutation-fixture', { backlogStatus: 'in_progress', taskStatusStatus: 'planned' });
  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 2 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: synced T-900: planned -> in_progress\n',
    `Test 2 FAIL: expected exactly the mutation line, got: ${JSON.stringify(result.stderr)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 2 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    updated.includes('- **Status:** in_progress'),
    `Test 2 FAIL: expected TASK_STATUS.md Status line updated to in_progress, got:\n${updated}`
  );
  console.log('Test 2 passed: a status difference updates TASK_STATUS.md and emits exactly the mutation line on stderr');
}

// ---------------------------------------------------------------------------
// Test 3: real errors (missing files) still emit stderr.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'missing-files-fixture');
  fs.mkdirSync(root, { recursive: true });
  // Neither BACKLOG.md nor TASK_STATUS.md exist in this fixture root.

  const result = run(root);
  assert.strictEqual(result.status, 0, `Test 3 FAIL: expected exit 0 (non-fatal), got ${result.status}`);
  assert.ok(
    result.stderr.includes('sync-status: BACKLOG.md not found'),
    `Test 3 FAIL: expected a stderr message about the missing BACKLOG.md, got: ${JSON.stringify(result.stderr)}`
  );
  console.log('Test 3 passed: a real error (missing files) still emits stderr');
}

// ---------------------------------------------------------------------------
// Test 4: no "## Active Wave" section / no tasks in it -> silent no-op too.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'no-active-wave-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# Backlog\n\nNo active wave section here.\n', 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# Task Status\n\n## Active tasks\n\n', 'utf8');

  const result = run(root);
  assert.strictEqual(result.status, 0, `Test 4 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 4 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stderr, 'utf8'),
    0,
    `Test 4 FAIL: expected zero bytes on stderr, got: ${JSON.stringify(result.stderr)}`
  );
  console.log('Test 4 passed: a missing "## Active Wave" section (no tasks to sync) is a silent no-op');
}

// ---------------------------------------------------------------------------
// Test 5 (T-432): titles already match -> silent no-op preserved.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('titles-in-sync-fixture', {
    backlogTitle: 'Fixture task',
    taskStatusTitle: 'Fixture task',
  });
  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 5 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 5 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stderr, 'utf8'),
    0,
    `Test 5 FAIL: expected zero bytes on stderr, got: ${JSON.stringify(result.stderr)}`
  );
  console.log('Test 5 passed: matching titles produce zero bytes on stdout and stderr, exit 0 (T-418 contract preserved)');
}

// ---------------------------------------------------------------------------
// Test 6 (T-432): a BACKLOG heading title differing from the TASK_STATUS
// heading title -> TASK_STATUS heading rewritten + exactly one
// "sync-status: retitled T-NNN" stderr line.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('retitle-fixture', {
    backlogTitle: 'New title',
    taskStatusTitle: 'Old title',
  });
  const result = run(root);

  assert.strictEqual(result.status, 0, `Test 6 FAIL: expected exit 0, got ${result.status}`);
  assert.strictEqual(
    result.stderr,
    'sync-status: retitled T-900\n',
    `Test 6 FAIL: expected exactly the retitled line, got: ${JSON.stringify(result.stderr)}`
  );
  assert.strictEqual(
    Buffer.byteLength(result.stdout, 'utf8'),
    0,
    `Test 6 FAIL: expected zero bytes on stdout, got: ${JSON.stringify(result.stdout)}`
  );

  const updated = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');
  assert.ok(
    updated.includes('### T-900 — New title'),
    `Test 6 FAIL: expected TASK_STATUS.md heading rewritten to "New title", got:\n${updated}`
  );
  assert.ok(
    !updated.includes('### T-900 — Old title'),
    `Test 6 FAIL: expected old title to be gone, got:\n${updated}`
  );
  console.log('Test 6 passed: a title mismatch rewrites the TASK_STATUS heading and emits exactly the retitled line');

  // Re-running against the now-retitled fixture must be a silent no-op.
  const secondRun = run(root);
  assert.strictEqual(secondRun.status, 0, `Test 6b FAIL: expected exit 0, got ${secondRun.status}`);
  assert.strictEqual(
    Buffer.byteLength(secondRun.stdout, 'utf8') + Buffer.byteLength(secondRun.stderr, 'utf8'),
    0,
    `Test 6b FAIL: expected a silent no-op on re-run, got stdout=${JSON.stringify(secondRun.stdout)} stderr=${JSON.stringify(secondRun.stderr)}`
  );
  console.log('Test 6b passed: re-running after a retitle is a silent no-op (idempotent)');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-418 assertions passed.');
