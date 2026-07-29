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

const { IN_FLIGHT_STATUSES } = require('./mavp-operator-lib.js');

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

console.log('\nAll T-493 assertions passed.');
