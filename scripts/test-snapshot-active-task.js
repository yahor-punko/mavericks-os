'use strict';
// Regression test: T-493 — --snapshot names only in-flight tasks as Active task.
//
// Bug: parseActiveTask() (scripts/mavp-operator-lib.js) picked the FIRST block
// in TASK_STATUS.md's "## Active tasks" section unconditionally, regardless of
// status. When a terminal task (deferred / merged / deprecated) happened to
// sit at the top of that section, --snapshot's "Active task" panel presented
// it as the session's current focus.
//
// Fix: parseActiveTask() now selects the first block whose status is in the
// shared IN_FLIGHT_STATUSES set (also consumed by computeNextAction() in
// scripts/mavp-operator-agent.js), skipping terminal entries; when no
// in-flight task exists it returns null and the panel says so explicitly
// instead of naming a terminal task.
//
// Covers:
//   1. Unit: parseActiveTask() skips a leading `deferred` block and selects
//      the following `in_progress` block.
//   2. Unit: parseActiveTask() returns null when every block in the section
//      is terminal (deferred/merged/deprecated) — no in-flight task exists.
//   3. End-to-end: running the actual mavp-operator-snapshot.js script (via
//      MAVERICKS_PROJECT_ROOT) against a fixture whose Active tasks section
//      leads with a deferred entry followed by an in_progress one prints the
//      in-flight task on the "Active task:" line, not the deferred one.
//   4. End-to-end: the same script against an all-terminal Active tasks
//      fixture prints an explicit "no in-flight task" line rather than
//      naming the terminal entry.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const { IN_FLIGHT_STATUSES, ARCHIVABLE_TERMINAL_STATUSES, TERMINAL_SKIP_STATUSES } = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const SNAPSHOT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-snapshot.js');

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

// ---------------------------------------------------------------------------
// Part 1 — unit: parseActiveTask() (accessed indirectly via
// mavp-operator-lib's internal use inside collectOperatorData, exercised
// end-to-end in Parts 3/4 below) skips a leading deferred block. This part
// verifies the shared status set itself has the expected shape, since
// parseActiveTask is not itself exported (internal helper).
// ---------------------------------------------------------------------------
{
  assert.ok(IN_FLIGHT_STATUSES instanceof Set, 'Test 1 FAIL: IN_FLIGHT_STATUSES must be an exported Set');
  for (const status of ['ready_for_qa', 'qa_in_progress', 'dev_done', 'security_review', 'security_passed', 'ux_review', 'ux_passed', 'in_progress', 'needs_fix']) {
    assert.ok(IN_FLIGHT_STATUSES.has(status), `Test 1 FAIL: expected IN_FLIGHT_STATUSES to include "${status}"`);
  }
  for (const status of ['deferred', 'merged', 'deprecated', 'planned']) {
    assert.ok(!IN_FLIGHT_STATUSES.has(status), `Test 1 FAIL: expected IN_FLIGHT_STATUSES to exclude terminal/not-started status "${status}"`);
  }
  console.log('Test 1 passed: IN_FLIGHT_STATUSES is the shared, exported in-flight status set');
}

function writeFixture(dir, activeTasksBody) {
  const backlogPath = path.join(dir, 'BACKLOG.md');
  const taskStatusPath = path.join(dir, 'TASK_STATUS.md');
  const processStateJsonPath = path.join(dir, 'PROCESS_STATE.json');

  writeUtf8(backlogPath, `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — fixture task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
`);

  writeUtf8(taskStatusPath, `# TASK_STATUS

## Active tasks

${activeTasksBody}
## Recently completed tasks
`);

  writeUtf8(processStateJsonPath, JSON.stringify({
    initiative: 'T-493 test fixture',
    stage: 'execution',
    wave: 70,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: 'T-900 → developer → do the thing',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 900,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  return { backlogPath, taskStatusPath, processStateJsonPath };
}

// ---------------------------------------------------------------------------
// Part 2 — end-to-end: leading deferred entry followed by an in_progress
// entry. --snapshot must name the in_progress task, not the deferred one.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't493-deferred-first-'));

  writeFixture(TMP, `### T-900 — A deferred task sitting first
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-901 — The actual in-flight task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

`);

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  const output = execFileSync('node', [SNAPSHOT_PATH], { cwd: TMP, env, encoding: 'utf8' });

  assert.ok(
    /^Active task: T-901 — The actual in-flight task$/m.test(output),
    `Test 2 FAIL: expected the in-flight task T-901 to be named as the Active task, got:\n${output}`
  );
  assert.ok(
    !output.includes('Active task: T-900'),
    `Test 2 FAIL: the deferred task T-900 must NOT be named as the Active task, got:\n${output}`
  );
  console.log('Test 2 passed: --snapshot skips a leading deferred entry and names the in_progress task instead');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end: every entry in the Active tasks section is terminal
// (deferred + merged). --snapshot must say so explicitly rather than naming
// either terminal entry.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't493-all-terminal-'));

  writeFixture(TMP, `### T-900 — A deferred task
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-902 — A merged task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main

`);

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  const output = execFileSync('node', [SNAPSHOT_PATH], { cwd: TMP, env, encoding: 'utf8' });

  assert.ok(
    !output.includes('Active task: T-900') && !output.includes('Active task: T-902'),
    `Test 3 FAIL: neither terminal task must be named as the Active task, got:\n${output}`
  );
  assert.ok(
    /^Active task: none — no in-flight task$/m.test(output),
    `Test 3 FAIL: expected the panel to say so explicitly when no in-flight task exists, got:\n${output}`
  );
  console.log('Test 3 passed: --snapshot reports "no in-flight task" explicitly when every Active tasks entry is terminal');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// T-581 — the wave-counter line inside renderThinSnapshot() must never absorb
// an unrecognized status into `planned` via a catch-all `else`. Buckets are
// derived from the shared exported status sets: completed =
// ARCHIVABLE_TERMINAL_STATUSES, in-flight = IN_FLIGHT_STATUSES ∪ qa_passed,
// planned = the literal `planned` only, deferred/deprecated =
// TERMINAL_SKIP_STATUSES as its own visible count, and anything else must
// surface as a visible `unknown` bucket naming the verbatim status.
// ---------------------------------------------------------------------------

function writeWaveFixture(dir, activeTasksBody, wave) {
  const backlogPath = path.join(dir, 'BACKLOG.md');
  const taskStatusPath = path.join(dir, 'TASK_STATUS.md');
  const processStateJsonPath = path.join(dir, 'PROCESS_STATE.json');

  writeUtf8(backlogPath, `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — fixture task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
`);

  writeUtf8(taskStatusPath, `# TASK_STATUS

## Active tasks

${activeTasksBody}
## Recently completed tasks
`);

  writeUtf8(processStateJsonPath, JSON.stringify({
    initiative: 'T-581 test fixture',
    stage: 'execution',
    wave,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: 'T-900 → developer → do the thing',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 900,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  return { backlogPath, taskStatusPath, processStateJsonPath };
}

function runSnapshot(dir) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  return execFileSync('node', [SNAPSHOT_PATH], { cwd: dir, env, encoding: 'utf8' });
}

function waveLine(output) {
  const m = output.match(/^Wave \d+:.*$/m);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Part 5 — the executed pre-fix baseline mutant: a fixture holding
// needs_fix + runtime_verified + deprecated + planned rendered, through the
// unfixed catch-all `else`, exactly `Wave 9: 4 planned` (verified by hand
// against the pre-fix code before this fix landed). Post-fix it must count
// needs_fix as in-flight, runtime_verified as completed, deprecated in the
// skip bucket, and exactly 1 planned — never 4 planned.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't581-buckets-'));

  writeWaveFixture(TMP, `### T-900 — needs fix task
- **Status:** needs_fix
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-901 — runtime verified task
- **Status:** runtime_verified
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main

### T-902 — deprecated task
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-903 — planned task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

`, 9);

  const output = runSnapshot(TMP);
  const line = waveLine(output);

  assert.ok(line, `Test 5 FAIL: expected a "Wave N: ..." line in output, got:\n${output}`);
  assert.ok(!/^Wave 9: 4 planned$/.test(line), `Test 5 FAIL: the pre-fix mutant "Wave 9: 4 planned" must never reappear, got: "${line}"`);
  assert.ok(/\b1 completed\b/.test(line), `Test 5 FAIL: expected runtime_verified to count as 1 completed, got: "${line}"`);
  assert.ok(/\b1 in_progress\b/.test(line), `Test 5 FAIL: expected needs_fix to count as 1 in_progress, got: "${line}"`);
  assert.ok(/\b1 planned\b/.test(line), `Test 5 FAIL: expected exactly 1 planned, got: "${line}"`);
  assert.ok(/\b1 deferred\/deprecated\b/.test(line), `Test 5 FAIL: expected deprecated to sit in a distinct deferred/deprecated bucket, got: "${line}"`);
  console.log(`Test 5 passed: wave line correctly buckets needs_fix/runtime_verified/deprecated/planned — "${line}"`);

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 6 — a nonsense/unrecognized status must surface labeled `unknown`,
// verbatim, never silently absorbed into `planned`.
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't581-unknown-'));

  writeWaveFixture(TMP, `### T-900 — a task with a nonsense status
- **Status:** frobnicating
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

`, 10);

  const output = runSnapshot(TMP);
  const line = waveLine(output);

  assert.ok(line, `Test 6 FAIL: expected a "Wave N: ..." line in output, got:\n${output}`);
  assert.ok(!/\bplanned\b/.test(line), `Test 6 FAIL: the nonsense status must never be counted as planned, got: "${line}"`);
  assert.ok(/\b1 unknown \(frobnicating\)/.test(line), `Test 6 FAIL: expected the unrecognized status to surface labeled "unknown (frobnicating)", got: "${line}"`);
  console.log(`Test 6 passed: an unrecognized status surfaces as a visible unknown bucket naming the verbatim status — "${line}"`);

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 7 — a merged + planned-only fixture still renders a sensible line
// with no empty-bucket noise (no "0 in_progress", no trailing/leading commas).
// ---------------------------------------------------------------------------
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't581-noempty-'));

  writeWaveFixture(TMP, `### T-900 — a merged task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main

### T-901 — a planned task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

`, 11);

  const output = runSnapshot(TMP);
  const line = waveLine(output);

  assert.ok(line, `Test 7 FAIL: expected a "Wave N: ..." line in output, got:\n${output}`);
  assert.strictEqual(line, 'Wave 11: 1 completed, 1 planned', `Test 7 FAIL: expected exactly "Wave 11: 1 completed, 1 planned" with no empty-bucket noise, got: "${line}"`);
  console.log(`Test 7 passed: a merged + planned-only fixture renders with no empty-bucket noise — "${line}"`);

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 8 — sanity check on the exported status sets themselves, so a future
// edit to their membership cannot silently break the bucket derivation
// without also breaking this test.
// ---------------------------------------------------------------------------
{
  assert.ok(ARCHIVABLE_TERMINAL_STATUSES instanceof Set, 'Test 8 FAIL: ARCHIVABLE_TERMINAL_STATUSES must be an exported Set');
  assert.ok(ARCHIVABLE_TERMINAL_STATUSES.has('runtime_verified'), 'Test 8 FAIL: expected ARCHIVABLE_TERMINAL_STATUSES to include "runtime_verified"');
  assert.ok(TERMINAL_SKIP_STATUSES instanceof Set, 'Test 8 FAIL: TERMINAL_SKIP_STATUSES must be an exported Set');
  assert.ok(TERMINAL_SKIP_STATUSES.has('deprecated'), 'Test 8 FAIL: expected TERMINAL_SKIP_STATUSES to include "deprecated"');
  console.log('Test 8 passed: the wave-counter bucket derivation reads from the shared exported status sets');
}

console.log('\nAll T-493/T-581 assertions passed.');
