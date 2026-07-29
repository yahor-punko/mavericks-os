'use strict';
// Regression test: T-525 — In-flight status set omits security_needs_fix/
// ux_needs_fix and has four divergent duplicate copies across operator
// surfaces (mavp-operator-lib.js IN_FLIGHT_STATUSES, mavp-operator-agent.js's
// active_slices filter, mavp-operator-dashboard.js's in-flight count, and
// parseTouchesConflicts' activeStatuses).
//
// Bug: a task in security_needs_fix or ux_needs_fix (actively being reworked
// after a failed review) did not appear in --agent's active_slices, was not
// counted by the dashboard's in-flight line, did not participate in
// Touches-conflict detection, and — had the fix only touched the shared Set
// without also updating computeNextAction's STATUS_PRIORITY — would have
// ranked BELOW a fresh `planned` task in next_action (99 vs 4), routing
// attention away from an in-flight fix.
//
// Fix: all three plain duplicate copies are deleted and replaced by imports
// of/derivations from the single shared IN_FLIGHT_STATUSES (in
// mavp-operator-lib.js), which now includes needs_fix, security_needs_fix,
// and ux_needs_fix; STATUS_PRIORITY gained explicit entries for
// security_needs_fix/ux_needs_fix at the same tier (3) as needs_fix.
//
// Covers, per surface:
//   1. Unit: IN_FLIGHT_STATUSES includes needs_fix/security_needs_fix/
//      ux_needs_fix and excludes qa_passed/merged/deferred/deprecated/planned.
//   2. End-to-end: --agent's active_slices includes a task in each of
//      needs_fix/security_needs_fix/ux_needs_fix, and excludes merged/
//      deferred/deprecated/qa_passed.
//   3. End-to-end: the dashboard's in-flight count line includes tasks in
//      each of the three needs-fix statuses.
//   4. Unit: parseTouchesConflicts() detects a Touches conflict for a task
//      in each of needs_fix/security_needs_fix/ux_needs_fix paired with a
//      planned task declaring the same file.
//   5. End-to-end: a security_needs_fix task outranks a planned task in
//      --agent's next_action (the STATUS_PRIORITY regression pin).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const { IN_FLIGHT_STATUSES, parseTouchesConflicts, generateProcessStateMd } = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const AGENT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-agent.js');
const DASHBOARD_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-dashboard.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-in-flight-status-set-${process.pid}-${Date.now()}`
);

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanup);

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

// ---------------------------------------------------------------------------
// Part 1 — unit: IN_FLIGHT_STATUSES membership.
// ---------------------------------------------------------------------------
{
  assert.ok(IN_FLIGHT_STATUSES instanceof Set, 'Test 1 FAIL: IN_FLIGHT_STATUSES must be an exported Set');
  for (const status of [
    'ready_for_qa', 'qa_in_progress', 'dev_done',
    'security_review', 'security_passed', 'security_needs_fix',
    'ux_review', 'ux_passed', 'ux_needs_fix',
    'in_progress', 'needs_fix',
  ]) {
    assert.ok(IN_FLIGHT_STATUSES.has(status), `Test 1 FAIL: expected IN_FLIGHT_STATUSES to include "${status}"`);
  }
  for (const status of ['deferred', 'merged', 'deprecated', 'planned', 'qa_passed']) {
    assert.ok(!IN_FLIGHT_STATUSES.has(status), `Test 1 FAIL: expected IN_FLIGHT_STATUSES to exclude "${status}"`);
  }
  console.log('Test 1 passed: IN_FLIGHT_STATUSES includes all three needs-fix variants and still excludes qa_passed/terminal statuses');
}

// ---------------------------------------------------------------------------
// Fixture builder for the --agent / dashboard end-to-end parts.
// ---------------------------------------------------------------------------
function makeFixtureProject(name) {
  const root = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(root, { recursive: true });

  const backlog = `# BACKLOG

## Active Wave

### T-910 — a needs_fix task
- **Status:** needs_fix
- **Owner role:** developer
- **Repo:** mavericks
- **Touches:** scripts/shared-a.js
- **Verification type:** unit

### T-911 — a security_needs_fix task
- **Status:** security_needs_fix
- **Owner role:** developer
- **Repo:** mavericks
- **Touches:** scripts/shared-b.js
- **Verification type:** unit

### T-912 — a ux_needs_fix task
- **Status:** ux_needs_fix
- **Owner role:** developer
- **Repo:** mavericks
- **Touches:** scripts/shared-c.js
- **Verification type:** unit

### T-913 — a merged task
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit

### T-914 — a qa_passed task (awaits Main-Agent merge, not sub-agent work)
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit

### T-920 — a fresh planned task, no dependencies
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Depends on:** —
- **Verification type:** unit

### T-930 — a second planned task, competes for Touches on shared-a.js
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Depends on:** —
- **Touches:** scripts/shared-a.js
- **Verification type:** unit

### T-931 — a second planned task, competes for Touches on shared-b.js
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Depends on:** —
- **Touches:** scripts/shared-b.js
- **Verification type:** unit

### T-932 — a second planned task, competes for Touches on shared-c.js
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Depends on:** —
- **Touches:** scripts/shared-c.js
- **Verification type:** unit
`;

  const taskStatus = `# TASK_STATUS

## Active tasks

### T-910 — a needs_fix task
- **Status:** needs_fix
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-911 — a security_needs_fix task
- **Status:** security_needs_fix
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-912 — a ux_needs_fix task
- **Status:** ux_needs_fix
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

### T-913 — a merged task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** qa
- **Evidence:** commit: aaaaaaa branch: main

### T-914 — a qa_passed task (awaits Main-Agent merge, not sub-agent work)
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** qa
- **Evidence:** —

## Recently completed tasks
`;

  const processState = {
    initiative: 'T-525 test fixture',
    stage: 'execution',
    wave: 70,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 932,
    last_updated: '2026-07-26',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  };

  writeUtf8(path.join(root, 'BACKLOG.md'), backlog);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), taskStatus);
  writeUtf8(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n');
  // The dashboard reads PROCESS_STATE.md directly (unlike --agent, which
  // regenerates it itself in main()) — generate it up front so both surfaces
  // can run against this fixture without throwing on a missing file.
  generateProcessStateMd(path.join(root, 'PROCESS_STATE.json'), path.join(root, 'PROCESS_STATE.md'));

  return root;
}

const FIXTURE_ROOT = makeFixtureProject('fixture');

// ---------------------------------------------------------------------------
// Part 2 — end-to-end: --agent's active_slices.
// ---------------------------------------------------------------------------
{
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: FIXTURE_ROOT };
  const stdout = execFileSync('node', [AGENT_PATH], { cwd: FIXTURE_ROOT, env, encoding: 'utf8', timeout: 15000 });
  const json = JSON.parse(stdout);
  const activeIds = (json.active_slices || []).map((t) => t.id);

  for (const id of ['T-910', 'T-911', 'T-912']) {
    assert.ok(activeIds.includes(id), `Test 2 FAIL: expected active_slices to include ${id}, got: ${JSON.stringify(activeIds)}`);
  }
  for (const id of ['T-913', 'T-914']) {
    assert.ok(!activeIds.includes(id), `Test 2 FAIL: expected active_slices to EXCLUDE terminal/qa_passed task ${id}, got: ${JSON.stringify(activeIds)}`);
  }
  console.log('Test 2 passed: --agent active_slices includes needs_fix/security_needs_fix/ux_needs_fix tasks and excludes merged/qa_passed');
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end: dashboard in-flight count.
// ---------------------------------------------------------------------------
{
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: FIXTURE_ROOT };
  const stdout = execFileSync('node', [DASHBOARD_PATH], { cwd: FIXTURE_ROOT, env, encoding: 'utf8', timeout: 15000 });
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/In-flight:\s+(\d+)\s+task/);
  assert.ok(match, `Test 3 FAIL: expected an "In-flight: N tasks" line in dashboard output, got:\n${plain}`);
  const count = Number(match[1]);
  // At least the three needs-fix tasks (T-910/911/912) must be counted.
  assert.ok(count >= 3, `Test 3 FAIL: expected in-flight count >= 3 (needs_fix + security_needs_fix + ux_needs_fix), got ${count}`);
  console.log(`Test 3 passed: dashboard in-flight count (${count}) includes the three needs-fix tasks`);
}

// ---------------------------------------------------------------------------
// Part 4 — unit: parseTouchesConflicts() participation for needs-fix statuses.
// ---------------------------------------------------------------------------
{
  const backlogContent = readUtf8(path.join(FIXTURE_ROOT, 'BACKLOG.md'));
  const conflicts = parseTouchesConflicts(backlogContent);

  const cases = [
    { file: 'scripts/shared-a.js', needsFixTask: 'T-910', plannedTask: 'T-930' },
    { file: 'scripts/shared-b.js', needsFixTask: 'T-911', plannedTask: 'T-931' },
    { file: 'scripts/shared-c.js', needsFixTask: 'T-912', plannedTask: 'T-932' },
  ];

  for (const c of cases) {
    const found = conflicts.find((conf) => conf.file === c.file);
    assert.ok(found, `Test 4 FAIL: expected a Touches conflict for ${c.file}, got: ${JSON.stringify(conflicts)}`);
    assert.ok(found.tasks.includes(c.needsFixTask), `Test 4 FAIL: expected ${c.file} conflict to include ${c.needsFixTask}, got: ${JSON.stringify(found)}`);
    assert.ok(found.tasks.includes(c.plannedTask), `Test 4 FAIL: expected ${c.file} conflict to include ${c.plannedTask}, got: ${JSON.stringify(found)}`);
  }
  console.log('Test 4 passed: parseTouchesConflicts() detects conflicts for needs_fix/security_needs_fix/ux_needs_fix tasks');
}

// ---------------------------------------------------------------------------
// Part 5 — end-to-end: STATUS_PRIORITY regression pin. A security_needs_fix
// task must outrank a fresh planned task in next_action. Isolated fixture
// (only one in-flight task, one planned task) so tie-breaking against other
// same-tier in-flight tasks in the Part 2-4 fixture cannot mask the result.
// ---------------------------------------------------------------------------
{
  const root = path.join(SCRATCH_ROOT, 'priority-pin');
  fs.mkdirSync(root, { recursive: true });

  const backlog = `# BACKLOG

## Active Wave

### T-940 — a security_needs_fix task under active fix
- **Status:** security_needs_fix
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit

### T-941 — a fresh planned task with no dependencies
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Depends on:** —
- **Verification type:** unit
`;

  const taskStatus = `# TASK_STATUS

## Active tasks

### T-940 — a security_needs_fix task under active fix
- **Status:** security_needs_fix
- **Owner role:** developer
- **Verification type:** unit
- **Last verified by:** —
- **Evidence:** —

## Recently completed tasks
`;

  const processState = {
    initiative: 'T-525 priority-pin fixture',
    stage: 'execution',
    wave: 70,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 941,
    last_updated: '2026-07-26',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  };

  writeUtf8(path.join(root, 'BACKLOG.md'), backlog);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), taskStatus);
  writeUtf8(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n');
  generateProcessStateMd(path.join(root, 'PROCESS_STATE.json'), path.join(root, 'PROCESS_STATE.md'));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  const stdout = execFileSync('node', [AGENT_PATH], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const json = JSON.parse(stdout);

  assert.ok(
    typeof json.next_action === 'string' && json.next_action.startsWith('T-940'),
    `Test 5 FAIL: expected next_action to route to the in-flight security_needs_fix task T-940 ahead of the planned T-941, got: ${JSON.stringify(json.next_action)}`
  );
  console.log(`Test 5 passed: next_action (${JSON.stringify(json.next_action)}) routes to the security_needs_fix task ahead of a planned task`);
}

console.log('\nAll T-525 assertions passed.');
