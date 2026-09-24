'use strict';
// Unit test: T-265 — computeDueRechecks helper
// Extended by T-767 — fixture-repo tests asserting --agent / --snapshot
// compute recheck due-dates from the real clock, not PROCESS_STATE.json's
// last_updated field (see mavp-operator-lib.js's todayIso() helper).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { computeDueRechecks, addDays, todayIso } = require('./mavp-operator-lib.js');

// --- Fixtures ---

const TODAY = '2026-06-25';
const YESTERDAY = '2026-06-24';
const LAST_WEEK = '2026-06-18';
const TOMORROW = '2026-06-26';
const NEXT_MONTH = '2026-07-25';

const DUE_TODAY = {
  id: 'RC-1',
  task: 'T-100',
  title: 'Retrain sentiment model',
  due: TODAY,
  interval: '8w',
  armed_at: '2026-04-30',
  note: 'Check accuracy drift',
};

const OVERDUE_YESTERDAY = {
  id: 'RC-2',
  task: 'T-101',
  title: 'Review feature flag TTL',
  due: YESTERDAY,
  armed_at: '2026-05-01',
};

const OVERDUE_OLD = {
  id: 'RC-3',
  task: 'T-102',
  title: 'Audit cache eviction policy',
  due: LAST_WEEK,
  interval: '4w',
  armed_at: '2026-05-21',
};

const FUTURE_TOMORROW = {
  id: 'RC-4',
  task: 'T-103',
  title: 'Verify external API contract',
  due: TOMORROW,
  armed_at: '2026-06-01',
};

const FUTURE_NEXT_MONTH = {
  id: 'RC-5',
  task: 'T-104',
  title: 'Re-evaluate vendor SLA',
  due: NEXT_MONTH,
  armed_at: '2026-06-01',
};

// --- Test 1: due entry (due === today) ---
{
  const result = computeDueRechecks([DUE_TODAY], TODAY);
  assert.strictEqual(result.due.length, 1, 'Test 1 FAIL: expected 1 entry in due');
  assert.strictEqual(result.overdue.length, 0, 'Test 1 FAIL: expected 0 entries in overdue');
  assert.strictEqual(result.due[0].id, 'RC-1', 'Test 1 FAIL: wrong entry in due');
  console.log('Test 1 passed: due entry (due === today)');
}

// --- Test 2: overdue entry (due < today) ---
{
  const result = computeDueRechecks([OVERDUE_YESTERDAY], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 2 FAIL: expected 0 entries in due');
  assert.strictEqual(result.overdue.length, 1, 'Test 2 FAIL: expected 1 entry in overdue');
  assert.strictEqual(result.overdue[0].id, 'RC-2', 'Test 2 FAIL: wrong entry in overdue');
  console.log('Test 2 passed: overdue entry (due < today)');
}

// --- Test 3: future entry not returned ---
{
  const result = computeDueRechecks([FUTURE_TOMORROW, FUTURE_NEXT_MONTH], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 3 FAIL: expected 0 entries in due');
  assert.strictEqual(result.overdue.length, 0, 'Test 3 FAIL: expected 0 entries in overdue');
  console.log('Test 3 passed: future entries excluded');
}

// --- Test 4: malformed due date skipped without throwing ---
{
  const malformedEntries = [
    { id: 'RC-bad1', task: 'T-200', title: 'Missing due field', armed_at: TODAY },
    { id: 'RC-bad2', task: 'T-201', title: 'Null due', due: null, armed_at: TODAY },
    { id: 'RC-bad3', task: 'T-202', title: 'Empty string due', due: '', armed_at: TODAY },
    { id: 'RC-bad4', task: 'T-203', title: 'Invalid format', due: '25-06-2026', armed_at: TODAY },
    { id: 'RC-bad5', task: 'T-204', title: 'Non-string due', due: 20260625, armed_at: TODAY },
    null,
    42,
    'not-an-object',
  ];
  let threw = false;
  let result;
  try {
    result = computeDueRechecks(malformedEntries, TODAY);
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'Test 4 FAIL: computeDueRechecks threw on malformed entries');
  assert.strictEqual(result.due.length, 0, 'Test 4 FAIL: expected 0 due entries for malformed data');
  assert.strictEqual(result.overdue.length, 0, 'Test 4 FAIL: expected 0 overdue entries for malformed data');
  console.log('Test 4 passed: malformed due dates skipped without throwing');
}

// --- Test 5: empty array yields empty result ---
{
  const result = computeDueRechecks([], TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 5 FAIL: expected 0 due entries for empty array');
  assert.strictEqual(result.overdue.length, 0, 'Test 5 FAIL: expected 0 overdue entries for empty array');
  console.log('Test 5 passed: empty array yields empty result');
}

// --- Test 6: absent (undefined) rechecks yields empty result ---
{
  const result = computeDueRechecks(undefined, TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 6 FAIL: expected 0 due entries for undefined');
  assert.strictEqual(result.overdue.length, 0, 'Test 6 FAIL: expected 0 overdue entries for undefined');
  console.log('Test 6 passed: undefined rechecks yields empty result');
}

// --- Test 7: null rechecks yields empty result ---
{
  const result = computeDueRechecks(null, TODAY);
  assert.strictEqual(result.due.length, 0, 'Test 7 FAIL: expected 0 due entries for null');
  assert.strictEqual(result.overdue.length, 0, 'Test 7 FAIL: expected 0 overdue entries for null');
  console.log('Test 7 passed: null rechecks yields empty result');
}

// --- Test 8: mixed set — due, overdue, and future entries together ---
{
  const all = [DUE_TODAY, OVERDUE_YESTERDAY, OVERDUE_OLD, FUTURE_TOMORROW, FUTURE_NEXT_MONTH];
  const result = computeDueRechecks(all, TODAY);
  assert.strictEqual(result.due.length, 1, 'Test 8 FAIL: expected 1 due entry');
  assert.strictEqual(result.overdue.length, 2, 'Test 8 FAIL: expected 2 overdue entries');
  assert.strictEqual(result.due[0].id, 'RC-1', 'Test 8 FAIL: wrong entry in due');
  const overdueIds = result.overdue.map((e) => e.id).sort();
  assert.deepStrictEqual(overdueIds, ['RC-2', 'RC-3'], 'Test 8 FAIL: wrong overdue IDs');
  console.log('Test 8 passed: mixed set correctly partitioned');
}

// ---------------------------------------------------------------------------
// T-767: fixture-repo tests — due/overdue recheck computation reads the real
// clock, not PROCESS_STATE.json's `last_updated` field.
//
// A fixture writes PROCESS_STATE.json with a deliberately stale
// last_updated ("2026-01-01") and a single recheck entry whose `due` is
// computed IN-TEST from the real clock (via the same todayIso()/addDays()
// functions production code uses) — never a hardcoded date. This is what
// distinguishes a real regression test for this defect from one that would
// pass even against the pre-fix code: the pre-fix code fell back to
// last_updated only when last_updated was ABSENT, so a fixture with
// last_updated present would previously miss a due-today/overdue-yesterday
// entry entirely (recheckToday would resolve to "2026-01-01", nowhere near
// the entry's real-clock-relative due date).
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = __dirname;
const AGENT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-agent.js');
const SNAPSHOT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-snapshot.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-rechecks-clock-${process.pid}-${Date.now()}`
);

function cleanupScratch() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanupScratch);

const EMPTY_BACKLOG = '# BACKLOG\n\n## Active Wave\n\n';
const EMPTY_TASK_STATUS = '# TASK_STATUS\n\n## Active tasks\n\n';

function makeFixtureProject(name, dueDate) {
  const root = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), EMPTY_BACKLOG, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), EMPTY_TASK_STATUS, 'utf8');
  const processState = {
    initiative: 'T-767 test fixture',
    stage: 'execution',
    wave: 1,
    // Deliberately stale — the pre-fix code fell back to this value only
    // when absent, so leaving it PRESENT but stale is what exercises the
    // defect: a fixture omitting last_updated entirely would pass under
    // either the buggy or fixed code.
    last_updated: '2026-01-01',
    active_slices: [],
    next_action: 'Open next wave',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 1,
    deploy_contours: 0,
    rechecks: [
      {
        id: 'RC-767',
        task: 'T-767',
        title: 'Fixture recheck entry',
        due: dueDate,
        armed_at: '2026-01-01',
      },
    ],
  };
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n', 'utf8');
  return root;
}

function runAgentJson(root) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  const stdout = execFileSync('node', [AGENT_PATH], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  return JSON.parse(stdout);
}

function runSnapshotText(root) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  return execFileSync('node', [SNAPSHOT_PATH], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
}

// Computed with the SAME date functions the production code uses
// (todayIso() / addDays()), never a hardcoded literal, so this test stays
// valid regardless of what day it actually runs.
const CLOCK_TODAY = todayIso();
const CLOCK_MINUS_ONE_DAY = addDays(CLOCK_TODAY, -1);
const CLOCK_PLUS_ONE_DAY = addDays(CLOCK_TODAY, 1);

// --- Test 9: due = clock-date minus one day -> due_rechecks has exactly
// that entry with overdue: true, despite last_updated being stale. ---
{
  const root = makeFixtureProject('overdue-vs-stale-last-updated', CLOCK_MINUS_ONE_DAY);
  const output = runAgentJson(root);
  assert.ok(Array.isArray(output.due_rechecks), `Test 9 FAIL: expected due_rechecks array, got ${JSON.stringify(output.due_rechecks)}`);
  assert.strictEqual(output.due_rechecks.length, 1, `Test 9 FAIL: expected exactly 1 due_rechecks entry, got ${output.due_rechecks.length}`);
  assert.strictEqual(output.due_rechecks[0].id, 'RC-767', 'Test 9 FAIL: wrong recheck entry surfaced');
  assert.strictEqual(output.due_rechecks[0].overdue, true, 'Test 9 FAIL: expected overdue: true for a due-yesterday entry');
  console.log('Test 9 passed: --agent surfaces a due-yesterday recheck as overdue:true even with a stale last_updated');
}

// --- Test 10: due = clock-date plus one day -> due_rechecks is absent
// entirely (additive-only field, omitted when empty). ---
{
  const root = makeFixtureProject('future-vs-stale-last-updated', CLOCK_PLUS_ONE_DAY);
  const output = runAgentJson(root);
  assert.ok(!('due_rechecks' in output), `Test 10 FAIL: expected due_rechecks to be absent for a future-dated entry, got ${JSON.stringify(output.due_rechecks)}`);
  console.log('Test 10 passed: --agent omits due_rechecks entirely for a future (clock-date +1) entry');
}

// --- Test 11: --snapshot output contains the "Due rechecks:" line for the
// minus-one-day (overdue) fixture. ---
{
  const root = makeFixtureProject('snapshot-overdue-vs-stale-last-updated', CLOCK_MINUS_ONE_DAY);
  const snapshotOutput = runSnapshotText(root);
  assert.ok(snapshotOutput.includes('Due rechecks:'), `Test 11 FAIL: expected --snapshot output to contain "Due rechecks:", got:\n${snapshotOutput}`);
  assert.ok(snapshotOutput.includes('T-767'), `Test 11 FAIL: expected --snapshot output to reference T-767, got:\n${snapshotOutput}`);
  console.log('Test 11 passed: --snapshot output contains "Due rechecks:" for the overdue fixture');
}

// ---------------------------------------------------------------------------
// T-769: armRecheck() accepts exactly one of taskId or wave (explicit title
// required for wave); --arm-recheck CLI stays task-only and unchanged.
// ---------------------------------------------------------------------------
const { armRecheck } = require('./mavp-operator-lib.js');
const ARM_RECHECK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-arm-recheck.js');

function makeArmFixture(name) {
  const root = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n### T-321 — Fixture task title\n- **Status:** merged\n', 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), EMPTY_TASK_STATUS, 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify({ wave: 1, last_updated: '2026-01-01', rechecks: [] }, null, 2) + '\n', 'utf8');
  return {
    root,
    processStateJsonPath: path.join(root, 'PROCESS_STATE.json'),
    backlogPath: path.join(root, 'BACKLOG.md'),
    taskStatusPath: path.join(root, 'TASK_STATUS.md'),
  };
}

// --- Test 12: both taskId and wave -> throws, file untouched ---
{
  const fx = makeArmFixture('arm-both');
  const before = fs.readFileSync(fx.processStateJsonPath, 'utf8');
  assert.throws(
    () => armRecheck({ ...fx, taskId: 'T-321', wave: 4, title: 'Wave 4 — x', due: '2099-01-01', today: CLOCK_TODAY }),
    /exactly one of taskId or wave/,
    'Test 12 FAIL: expected armRecheck to throw when both taskId and wave are given'
  );
  assert.strictEqual(fs.readFileSync(fx.processStateJsonPath, 'utf8'), before, 'Test 12 FAIL: PROCESS_STATE.json must be untouched');
  console.log('Test 12 passed: armRecheck throws when both taskId and wave are given');
}

// --- Test 13: neither taskId nor wave -> throws ---
{
  const fx = makeArmFixture('arm-neither');
  assert.throws(
    () => armRecheck({ ...fx, due: '2099-01-01', today: CLOCK_TODAY }),
    /exactly one of taskId or wave is required/,
    'Test 13 FAIL: expected armRecheck to throw when neither taskId nor wave is given'
  );
  console.log('Test 13 passed: armRecheck throws when neither taskId nor wave is given');
}

// --- Test 14: wave without an explicit title -> throws ---
{
  const fx = makeArmFixture('arm-wave-no-title');
  assert.throws(
    () => armRecheck({ ...fx, wave: 4, due: '2099-01-01', today: CLOCK_TODAY }),
    /explicit title is required/,
    'Test 14 FAIL: expected armRecheck to throw for a wave recheck without a title'
  );
  console.log('Test 14 passed: armRecheck requires an explicit title for a wave recheck');
}

// --- Test 15: wave entry shape — numeric wave, explicit title, no task key ---
{
  const fx = makeArmFixture('arm-wave');
  const { id, entry } = armRecheck({ ...fx, wave: '4', title: 'Wave 4 — waiting', due: '2099-01-01', note: 'n', today: CLOCK_TODAY });
  assert.strictEqual(id, 'RC-1', 'Test 15 FAIL: expected RC-1');
  assert.deepStrictEqual(entry, { id: 'RC-1', wave: 4, title: 'Wave 4 — waiting', due: '2099-01-01', armed_at: CLOCK_TODAY, note: 'n' }, `Test 15 FAIL: wrong wave entry ${JSON.stringify(entry)}`);
  const persisted = JSON.parse(fs.readFileSync(fx.processStateJsonPath, 'utf8'));
  assert.deepStrictEqual(persisted.rechecks, [entry], 'Test 15 FAIL: entry must be persisted');
  console.log('Test 15 passed: armRecheck({ wave, title }) persists {id, wave:<number>, title, due, armed_at, note} with no task key');
}

// --- Test 16: --arm-recheck CLI stays task-only and produces the same task entry shape ---
{
  const fx = makeArmFixture('arm-cli');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: fx.root };
  execFileSync('node', [ARM_RECHECK_PATH, 'T-321', '--due', '2099-01-01', '--interval', '8w'], { cwd: fx.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const persisted = JSON.parse(fs.readFileSync(fx.processStateJsonPath, 'utf8'));
  assert.deepStrictEqual(persisted.rechecks, [{ id: 'RC-1', task: 'T-321', title: 'Fixture task title', due: '2099-01-01', armed_at: todayIso(), interval: '8w' }], `Test 16 FAIL: wrong CLI task entry ${JSON.stringify(persisted.rechecks)}`);
  let refused = false;
  try {
    execFileSync('node', [ARM_RECHECK_PATH, '--wave', '4', '--due', '2099-01-01'], { cwd: fx.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    refused = err.status === 1;
  }
  assert.ok(refused, 'Test 16 FAIL: --arm-recheck CLI must stay task-only (refuse a non-T-NNN first argument)');
  console.log('Test 16 passed: --arm-recheck CLI unchanged — task entry {id, task, title, due, armed_at, interval}; non-task first arg refused');
}

// ---------------------------------------------------------------------------
// T-771: --ack-recheck RC-N --rearm --due YYYY-MM-DD reschedules an
// interval-less recheck (e.g. a wave recheck armed via --park-wave --until,
// which never carries an interval) to an explicit date.
// ---------------------------------------------------------------------------
const ACK_RECHECK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-ack-recheck.js');
const CLOCK_PLUS_THIRTY_DAYS = addDays(CLOCK_TODAY, 30);

function makeAckFixture(name, rechecks) {
  const root = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), EMPTY_BACKLOG, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), EMPTY_TASK_STATUS, 'utf8');
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify({ wave: 1, last_updated: '2026-01-01', rechecks }, null, 2) + '\n',
    'utf8'
  );
  return { root, processStateJsonPath: path.join(root, 'PROCESS_STATE.json') };
}

function runAckRecheckCli(root, args) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  return execFileSync('node', [ACK_RECHECK_PATH, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// --- Test 17: interval-less entry rearmed with --due <today+30> -> due set,
// armed_at = today, entry remains in rechecks[] (contract line: the `due`
// branch in ackRecheck() must actually take effect, not just avoid the
// no-interval throw). ---
{
  const intervalLessEntry = {
    id: 'RC-1',
    wave: 4,
    title: 'Wave 4 — waiting on external review',
    due: '2020-01-01',
    armed_at: '2026-01-01',
    // Deliberately no `interval` key — mirrors a --park-wave --until entry.
  };
  const fx = makeAckFixture('ack-rearm-due-interval-less', [intervalLessEntry]);
  const stdout = runAckRecheckCli(fx.root, ['RC-1', '--rearm', '--due', CLOCK_PLUS_THIRTY_DAYS]);
  assert.ok(stdout.includes(CLOCK_PLUS_THIRTY_DAYS), `Test 17 FAIL: expected stdout to report new due ${CLOCK_PLUS_THIRTY_DAYS}, got:\n${stdout}`);
  const persisted = JSON.parse(fs.readFileSync(fx.processStateJsonPath, 'utf8'));
  assert.strictEqual(persisted.rechecks.length, 1, 'Test 17 FAIL: entry must remain in rechecks[]');
  const rearmed = persisted.rechecks[0];
  assert.strictEqual(rearmed.due, CLOCK_PLUS_THIRTY_DAYS, `Test 17 FAIL: expected due=${CLOCK_PLUS_THIRTY_DAYS}, got ${rearmed.due}`);
  assert.strictEqual(rearmed.armed_at, CLOCK_TODAY, `Test 17 FAIL: expected armed_at=${CLOCK_TODAY}, got ${rearmed.armed_at}`);
  assert.strictEqual(rearmed.wave, 4, 'Test 17 FAIL: wave field must survive rearm');
  assert.strictEqual(rearmed.title, 'Wave 4 — waiting on external review', 'Test 17 FAIL: title field must survive rearm');
  assert.ok(!('interval' in rearmed), 'Test 17 FAIL: no interval should have been fabricated');
  console.log('Test 17 passed: --rearm --due reschedules an interval-less (wave) entry, keeping wave/title, no interval required');
}

// --- Test 18: --rearm --due 2020-01-01 (before today) exits 1, leaving
// PROCESS_STATE.json byte-identical (compute-then-write: validation must
// run before any file write). ---
{
  const entry = { id: 'RC-1', task: 'T-321', title: 'Fixture task', due: '2099-01-01', armed_at: '2026-01-01' };
  const fx = makeAckFixture('ack-rearm-due-past', [entry]);
  const before = fs.readFileSync(fx.processStateJsonPath, 'utf8');
  let exitCode = 0;
  try {
    runAckRecheckCli(fx.root, ['RC-1', '--rearm', '--due', '2020-01-01']);
  } catch (err) {
    exitCode = err.status;
  }
  assert.strictEqual(exitCode, 1, `Test 18 FAIL: expected exit 1 for a past --due, got ${exitCode}`);
  const after = fs.readFileSync(fx.processStateJsonPath, 'utf8');
  assert.strictEqual(after, before, 'Test 18 FAIL: PROCESS_STATE.json must be byte-identical after a rejected --due');
  console.log('Test 18 passed: --rearm --due 2020-01-01 exits 1, file untouched');
}

// --- Test 19: pre-existing --rearm-without-interval error still fires when
// --due is absent (unchanged message, unchanged behavior). ---
{
  const entry = { id: 'RC-1', task: 'T-321', title: 'Fixture task', due: '2099-01-01', armed_at: '2026-01-01' };
  const fx = makeAckFixture('ack-rearm-no-interval-no-due', [entry]);
  let stderr = '';
  let exitCode = 0;
  try {
    runAckRecheckCli(fx.root, ['RC-1', '--rearm']);
  } catch (err) {
    exitCode = err.status;
    stderr = err.stderr || '';
  }
  assert.strictEqual(exitCode, 1, `Test 19 FAIL: expected exit 1, got ${exitCode}`);
  assert.ok(stderr.includes('entry has no interval'), `Test 19 FAIL: expected unchanged no-interval error, got:\n${stderr}`);
  console.log('Test 19 passed: --rearm without --due and without an interval still errors with the pre-existing message');
}

// --- Test 20 (judgment call): --due without --rearm refuses, exit 1, no
// write — acking without --rearm removes the entry, so a due date there is
// meaningless. ---
{
  const entry = { id: 'RC-1', task: 'T-321', title: 'Fixture task', due: '2099-01-01', armed_at: '2026-01-01' };
  const fx = makeAckFixture('ack-due-without-rearm', [entry]);
  const before = fs.readFileSync(fx.processStateJsonPath, 'utf8');
  let exitCode = 0;
  try {
    runAckRecheckCli(fx.root, ['RC-1', '--due', CLOCK_PLUS_THIRTY_DAYS]);
  } catch (err) {
    exitCode = err.status;
  }
  assert.strictEqual(exitCode, 1, `Test 20 FAIL: expected exit 1 for --due without --rearm, got ${exitCode}`);
  const after = fs.readFileSync(fx.processStateJsonPath, 'utf8');
  assert.strictEqual(after, before, 'Test 20 FAIL: PROCESS_STATE.json must be untouched when --due is used without --rearm');
  console.log('Test 20 passed: --due without --rearm refuses (exit 1), no write');
}

console.log('\nAll T-265 assertions passed.');
