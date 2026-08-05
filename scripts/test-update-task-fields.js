'use strict';
// Regression test: T-607 — --update-task's field writes migrated onto the
// bounded task-block helpers (T-606), fixing two compounding defects in the
// old `updateFieldInMarkdown` regex:
//
//   1. `(###\s+TaskId\s+—[\s\S]*?- \*\*Field:\*\*)\s+\S+` had an UNBOUNDED
//      lazy gap — when the target block lacked the requested field, the
//      match ran straight through later blocks and wrote into the first one
//      that happened to carry the field, silently corrupting it.
//   2. The owner write used field name "Owner", but every entry builder
//      (buildTaskStatusEntry, --new-task, --apply-decomposition) emits
//      "Owner role" — so a well-formed active block could never match, and
//      the command printed a success line regardless of whether anything
//      was actually written.
//
// Covers the acceptance criteria verbatim:
//   1. Given the field-report fixture (an active task with no "Owner role"
//      line, plus archived tasks carrying bare "Owner" lines),
//      `--update-task <id> ready_for_qa qa` writes "Owner role: qa" into the
//      TARGET block only, in BOTH BACKLOG.md and TASK_STATUS.md.
//   2. Every archived block (the ones the old bug used to corrupt) stays
//      byte-for-byte identical.
//   3. A run whose requested field write changes nothing (task not found,
//      or duplicate heading) prints a warning instead of the plain success
//      line, and does not silently degrade into a no-op success report.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const UPDATE_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-update-task.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't607-update-task-fields-'));

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeUtf8(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

// The field-report fixture: an active task (in BACKLOG's Active Wave /
// TASK_STATUS's Active tasks) with no "Owner role" line at all, followed by
// TWO archived/completed blocks that each carry a bare legacy "Owner" line
// — the exact shape the reported defect corrupted (the unbounded regex ran
// past the target block, matched the first archived block's "Owner" line,
// and rewrote it).
function fixtureBacklog() {
  return [
    '# BACKLOG',
    '',
    '## Active Wave',
    '',
    '### T-901 — Fixture target task',
    '- **Status:** dev_done',
    '- **Type:** feature',
    '- **Verification type:** runtime',
    '',
    '## Recently completed tasks',
    '',
    '### T-801 — Fixture archived task one',
    '- **Status:** merged',
    '- **Owner:** developer',
    '- **Verification type:** runtime',
    '',
    '### T-802 — Fixture archived task two',
    '- **Status:** merged',
    '- **Owner:** product-docs',
    '- **Verification type:** runtime',
    '',
  ].join('\n');
}

function fixtureTaskStatus() {
  return [
    '# TASK STATUS',
    '',
    '## Active tasks',
    '',
    '### T-901 — Fixture target task',
    '- **Status:** dev_done',
    '- **Evidence:** —',
    '',
    '## Recently completed tasks',
    '',
    '### T-801 — Fixture archived task one',
    '- **Status:** merged',
    '- **Owner:** developer',
    '- **Evidence:** commit: 1111111',
    '',
    '### T-802 — Fixture archived task two',
    '- **Status:** merged',
    '- **Owner:** product-docs',
    '- **Evidence:** commit: 2222222',
    '',
  ].join('\n');
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

function runUpdateTask(root, args) {
  return spawnSync('node', [UPDATE_TASK_PATH, ...args], {
    cwd: root,
    env: {
      ...process.env,
      MAVERICKS_PROJECT_ROOT: root,
      MAVERICKS_SCRIPTS: SCRIPTS_DIR,
    },
    encoding: 'utf8',
  });
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok - ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL - ${label}`);
    console.log(`    ${err.message}`);
  }
}

console.log('T-607 --update-task field-write tests');

// ---------------------------------------------------------------------------
// Test 1 (acceptance criterion): target-block write + archived blocks
// untouched, in BOTH files.
{
  const root = makeFixtureRoot('t1-target-and-archived', {
    backlog: fixtureBacklog(),
    taskStatus: fixtureTaskStatus(),
  });

  const before801Backlog = fixtureBacklog().match(/### T-801[\s\S]*?(?=\n### T-802)/)[0];
  const before802Backlog = fixtureBacklog().match(/### T-802[\s\S]*$/)[0];
  const before801Status = fixtureTaskStatus().match(/### T-801[\s\S]*?(?=\n### T-802)/)[0];
  const before802Status = fixtureTaskStatus().match(/### T-802[\s\S]*$/)[0];

  const result = runUpdateTask(root, ['T-901', 'ready_for_qa', 'qa']);

  check('exits without throwing (spawnSync completed)', () => {
    assert.strictEqual(result.error, undefined, `spawn error: ${result.error}`);
  });

  const backlogAfter = readUtf8(path.join(root, 'BACKLOG.md'));
  const statusAfter = readUtf8(path.join(root, 'TASK_STATUS.md'));

  check('BACKLOG.md target block T-901 gets Status: ready_for_qa', () => {
    const block = backlogAfter.match(/### T-901[\s\S]*?(?=\n### |\n## |$)/)[0];
    assert.match(block, /- \*\*Status:\*\* ready_for_qa/);
  });

  check('BACKLOG.md target block T-901 gets Owner role: qa', () => {
    const block = backlogAfter.match(/### T-901[\s\S]*?(?=\n### |\n## |$)/)[0];
    assert.match(block, /- \*\*Owner role:\*\* qa/);
  });

  check('TASK_STATUS.md target block T-901 gets Status: ready_for_qa', () => {
    const block = statusAfter.match(/### T-901[\s\S]*?(?=\n### |\n## |$)/)[0];
    assert.match(block, /- \*\*Status:\*\* ready_for_qa/);
  });

  check('TASK_STATUS.md target block T-901 gets Owner role: qa', () => {
    const block = statusAfter.match(/### T-901[\s\S]*?(?=\n### |\n## |$)/)[0];
    assert.match(block, /- \*\*Owner role:\*\* qa/);
  });

  check('BACKLOG.md T-801 archived block stays byte-identical', () => {
    const after = backlogAfter.match(/### T-801[\s\S]*?(?=\n### T-802)/)[0];
    assert.strictEqual(after, before801Backlog);
  });

  check('BACKLOG.md T-802 archived block stays byte-identical', () => {
    const after = backlogAfter.match(/### T-802[\s\S]*$/)[0];
    assert.strictEqual(after, before802Backlog);
  });

  check('TASK_STATUS.md T-801 archived block stays byte-identical', () => {
    const after = statusAfter.match(/### T-801[\s\S]*?(?=\n### T-802)/)[0];
    assert.strictEqual(after, before801Status);
  });

  check('TASK_STATUS.md T-802 archived block stays byte-identical', () => {
    const after = statusAfter.match(/### T-802[\s\S]*$/)[0];
    assert.strictEqual(after, before802Status);
  });

  check('success line printed (both writes succeeded)', () => {
    assert.match(result.stdout, /✓ T-901 → ready_for_qa \(owner → qa\)/);
  });
}

// ---------------------------------------------------------------------------
// Test 2 (acceptance criterion): task_not_found — requested write changes
// nothing, so the command must print a warning, not the success line.
{
  const root = makeFixtureRoot('t2-task-not-found', {
    backlog: fixtureBacklog(),
    taskStatus: fixtureTaskStatus(),
  });

  const backlogBefore = readUtf8(path.join(root, 'BACKLOG.md'));
  const statusBefore = readUtf8(path.join(root, 'TASK_STATUS.md'));

  const result = runUpdateTask(root, ['T-999', 'ready_for_qa', 'qa']);

  check('unknown task ID: no plain success line printed', () => {
    assert.doesNotMatch(result.stdout, /✓ T-999 → ready_for_qa/);
  });

  check('unknown task ID: warning printed with reason task_not_found', () => {
    assert.match(result.stdout, /⚠.*T-999.*task_not_found/);
  });

  check('unknown task ID: files unchanged', () => {
    assert.strictEqual(readUtf8(path.join(root, 'BACKLOG.md')), backlogBefore);
    assert.strictEqual(readUtf8(path.join(root, 'TASK_STATUS.md')), statusBefore);
  });
}

// ---------------------------------------------------------------------------
// Test 3 (acceptance criterion): duplicate_heading — must not silently
// degrade into a first-match write; warning printed, no corruption.
{
  const dupBacklog = [
    '# BACKLOG',
    '',
    '## Active Wave',
    '',
    '### T-903 — Fixture duplicate task (first)',
    '- **Status:** dev_done',
    '',
    '### T-903 — Fixture duplicate task (second)',
    '- **Status:** dev_done',
    '',
  ].join('\n');
  const dupTaskStatus = [
    '# TASK STATUS',
    '',
    '## Active tasks',
    '',
    '### T-903 — Fixture duplicate task (first)',
    '- **Status:** dev_done',
    '',
    '### T-903 — Fixture duplicate task (second)',
    '- **Status:** dev_done',
    '',
  ].join('\n');

  const root = makeFixtureRoot('t3-duplicate-heading', {
    backlog: dupBacklog,
    taskStatus: dupTaskStatus,
  });

  const backlogBefore = readUtf8(path.join(root, 'BACKLOG.md'));
  const statusBefore = readUtf8(path.join(root, 'TASK_STATUS.md'));

  const result = runUpdateTask(root, ['T-903', 'ready_for_qa']);

  check('duplicate heading: no plain success line printed', () => {
    assert.doesNotMatch(result.stdout, /✓ T-903 → ready_for_qa/);
  });

  check('duplicate heading: warning printed with reason duplicate_heading', () => {
    assert.match(result.stdout, /⚠.*T-903.*duplicate_heading/);
  });

  check('duplicate heading: files unchanged (no first-match write)', () => {
    assert.strictEqual(readUtf8(path.join(root, 'BACKLOG.md')), backlogBefore);
    assert.strictEqual(readUtf8(path.join(root, 'TASK_STATUS.md')), statusBefore);
  });
}

// ---------------------------------------------------------------------------
// Test 4 (acceptance criterion, spaces in value): an owner value containing
// a space must be written whole, not truncated to its first token — this is
// exercised implicitly by every assertion above (`qa` has no space), so
// pin it explicitly here against a multi-word value.
{
  const root = makeFixtureRoot('t4-owner-value-with-spaces', {
    backlog: fixtureBacklog(),
    taskStatus: fixtureTaskStatus(),
  });

  runUpdateTask(root, ['T-901', 'ready_for_qa', 'product docs']);

  const backlogAfter = readUtf8(path.join(root, 'BACKLOG.md'));
  check('owner value containing a space is written whole, not truncated', () => {
    const block = backlogAfter.match(/### T-901[\s\S]*?(?=\n### |\n## |$)/)[0];
    assert.match(block, /- \*\*Owner role:\*\* product docs$/m);
  });
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('All checks passed.');
}
