'use strict';
// Regression test: T-440 — --park-wave / --unpark-wave commands.
//
// Covers:
//   1. moveActiveBlocksToParkedSection() / moveParkedBlocksToActiveSection()
//      unit-level round trip: parking then unparking BACKLOG-shaped content
//      (blank-line preamble) and TASK_STATUS-shaped content (no preamble)
//      restores the original bytes exactly.
//   2. End-to-end: running the actual mavp-operator-park-wave.js script
//      against a fixture project with 3 active tasks —
//        --park-wave --reason "text" moves all Active Wave blocks into
//        "## Wave <N> — Parked" in BACKLOG.md and all Active tasks blocks
//        into "## Parked tasks (Wave <N>)" in TASK_STATUS.md, appends the
//        wave + reason to parked_waves, and --agent afterward reports 0
//        active slices while the validator exits 0.
//   3. --unpark-wave <N> restores all blocks to Active Wave / Active tasks
//      byte-for-byte and removes the parked_waves entry; validator exits 0.
//   4. The wave-number default (omitting N from --park-wave) resolves from
//      PROCESS_STATE.json's `wave` field.
//   5. Error handling: --unpark-wave on a wave that was never parked fails
//      clearly without touching any file.
//   6. T-768: a non-task "### " sub-heading inside the Active Wave preamble
//      (e.g. a wave-goal heading) travels WITH its blocks into the parked
//      section, so unparking after a newer wave's own sub-heading + tasks
//      were added restores a coherent grouping — the older wave's heading
//      immediately followed by its own tasks, not left orphaned under the
//      Active Wave heading while its tasks moved out from under it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const {
  moveActiveBlocksToParkedSection,
  moveParkedBlocksToActiveSection,
  parkedBacklogHeading,
  parkedTaskStatusHeading,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const PARK_WAVE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-park-wave.js');
const AGENT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-agent.js');
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, 'mavp-validator.js');

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

// ---------------------------------------------------------------------------
// Part 1 — unit: round trip on BACKLOG-shaped content (blank-line preamble).
// ---------------------------------------------------------------------------
{
  const backlog = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave



### T-001 — First
- **Status:** in_progress
- **Owner role:** developer

### T-002 — Second
- **Status:** ready_for_qa
- **Owner role:** developer

### T-003 — Third
- **Status:** planned
- **Owner role:** developer

## Deferred Tasks

### T-900 — deferred
- **Status:** deferred
`;

  const parked = moveActiveBlocksToParkedSection(backlog, /^##\s+Active Wave/i, parkedBacklogHeading(5));
  assert.strictEqual(parked.ok, true, 'Test 1 FAIL: expected ok:true parking BACKLOG-shaped content');
  assert.deepStrictEqual(parked.taskIds, ['T-001', 'T-002', 'T-003'], 'Test 1 FAIL: expected all 3 task ids parked');
  assert.ok(parked.updated.includes('## Wave 5 — Parked'), 'Test 1 FAIL: expected parked heading present');
  assert.ok(!parked.updated.slice(0, parked.updated.indexOf('## Wave 5 — Parked')).includes('### T-001'), 'Test 1 FAIL: T-001 must not remain under Active Wave');

  const unparked = moveParkedBlocksToActiveSection(parked.updated, /^##\s+Active Wave/i, parkedBacklogHeading(5));
  assert.strictEqual(unparked.ok, true, 'Test 1 FAIL: expected ok:true unparking BACKLOG-shaped content');
  assert.deepStrictEqual(unparked.taskIds, ['T-001', 'T-002', 'T-003'], 'Test 1 FAIL: expected all 3 task ids restored');
  assert.strictEqual(unparked.updated, backlog, 'Test 1 FAIL: BACKLOG-shaped content must restore byte-for-byte');

  console.log('Test 1 passed: BACKLOG-shaped (blank-preamble) content round-trips byte-for-byte through park/unpark');
}

// ---------------------------------------------------------------------------
// Part 2 — unit: round trip on TASK_STATUS-shaped content (no preamble —
// heading immediately followed by the first task block).
// ---------------------------------------------------------------------------
{
  const taskStatus = `# TASK_STATUS

## Status legend

- \`planned\`

## Active tasks

### T-001 — First
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime

### T-002 — Second
- **Status:** ready_for_qa
- **Owner role:** developer
- **Verification type:** runtime

## Recently completed tasks

### T-050 — done
- **Status:** merged
`;

  const parked = moveActiveBlocksToParkedSection(taskStatus, /^##\s+Active tasks\s*$/m, parkedTaskStatusHeading(5));
  assert.strictEqual(parked.ok, true, 'Test 2 FAIL: expected ok:true parking TASK_STATUS-shaped content');
  assert.deepStrictEqual(parked.taskIds, ['T-001', 'T-002'], 'Test 2 FAIL: expected both task ids parked');
  assert.ok(parked.updated.includes('## Parked tasks (Wave 5)'), 'Test 2 FAIL: expected parked heading present');

  const unparked = moveParkedBlocksToActiveSection(parked.updated, /^##\s+Active tasks\s*$/m, parkedTaskStatusHeading(5));
  assert.strictEqual(unparked.ok, true, 'Test 2 FAIL: expected ok:true unparking TASK_STATUS-shaped content');
  assert.deepStrictEqual(unparked.taskIds, ['T-001', 'T-002'], 'Test 2 FAIL: expected both task ids restored');
  assert.strictEqual(unparked.updated, taskStatus, 'Test 2 FAIL: TASK_STATUS-shaped content must restore byte-for-byte');

  console.log('Test 2 passed: TASK_STATUS-shaped (no-preamble) content round-trips byte-for-byte through park/unpark');
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end: run the actual mavp-operator-park-wave.js script
// against a fixture project with 3 active tasks.
// ---------------------------------------------------------------------------
function buildFixture() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't440-e2e-'));
  const BACKLOG_PATH = path.join(TMP, 'BACKLOG.md');
  const TASK_STATUS_PATH = path.join(TMP, 'TASK_STATUS.md');
  const PROCESS_STATE_JSON_PATH = path.join(TMP, 'PROCESS_STATE.json');

  const backlogOriginal = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave



### T-100 — First
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-101 — Second
- **Status:** ready_for_qa
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-102 — Third
- **Status:** planned
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

## Deferred Tasks

### T-900 — deferred thing
- **Status:** deferred
`;

  const taskStatusOriginal = `# TASK_STATUS

## Status legend

- \`planned\`
- \`in_progress\`

## Active tasks

### T-100 — First
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime

### T-101 — Second
- **Status:** ready_for_qa
- **Owner role:** developer
- **Verification type:** runtime

### T-102 — Third
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime

## Recently completed tasks
`;

  writeUtf8(BACKLOG_PATH, backlogOriginal);
  writeUtf8(TASK_STATUS_PATH, taskStatusOriginal);
  writeUtf8(PROCESS_STATE_JSON_PATH, JSON.stringify({
    initiative: 'T-440 test fixture',
    stage: 'execution',
    wave: 9,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: 'T-100 → developer → do the thing',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 102,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  return { TMP, BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH, backlogOriginal, taskStatusOriginal };
}

{
  const { TMP, BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH, backlogOriginal, taskStatusOriginal } = buildFixture();
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };

  // --- --park-wave --reason "text" (wave number defaults from PROCESS_STATE.json) ---
  const parkOutput = execFileSync('node', [PARK_WAVE_PATH, '--park-wave', '--reason', 'external review pending'], { cwd: TMP, env, encoding: 'utf8' });
  assert.ok(parkOutput.includes('parked 3 task(s)'), `Test 3 FAIL: expected BACKLOG park output to report 3 tasks, got:\n${parkOutput}`);
  assert.ok(parkOutput.includes('Validator: healthy'), `Test 3 FAIL: expected validator healthy after park, got:\n${parkOutput}`);
  console.log('Test 3a passed: --park-wave (default wave number) moved 3 tasks and validator reports Healthy');

  const backlogAfterPark = readUtf8(BACKLOG_PATH);
  const taskStatusAfterPark = readUtf8(TASK_STATUS_PATH);
  const stateAfterPark = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));

  assert.ok(backlogAfterPark.includes('## Wave 9 — Parked'), 'Test 3 FAIL: expected BACKLOG.md "## Wave 9 — Parked" section');
  const backlogActiveWaveSection = backlogAfterPark.slice(
    backlogAfterPark.indexOf('## Active Wave'),
    backlogAfterPark.indexOf('## Wave 9 — Parked')
  );
  assert.ok(!/### T-10[0-2]/.test(backlogActiveWaveSection), 'Test 3 FAIL: no active task blocks should remain under BACKLOG Active Wave');
  assert.ok(backlogAfterPark.includes('### T-100') && backlogAfterPark.includes('### T-101') && backlogAfterPark.includes('### T-102'), 'Test 3 FAIL: all 3 tasks should be present in the parked BACKLOG section');

  assert.ok(taskStatusAfterPark.includes('## Parked tasks (Wave 9)'), 'Test 3 FAIL: expected TASK_STATUS.md "## Parked tasks (Wave 9)" section');
  const taskStatusActiveSection = taskStatusAfterPark.slice(
    taskStatusAfterPark.indexOf('## Active tasks'),
    taskStatusAfterPark.indexOf('## Parked tasks (Wave 9)')
  );
  assert.ok(!/### T-10[0-2]/.test(taskStatusActiveSection), 'Test 3 FAIL: no active task blocks should remain under TASK_STATUS Active tasks');

  assert.deepStrictEqual(stateAfterPark.parked_waves, ['Wave 9 — external review pending'], 'Test 3 FAIL: expected parked_waves to record the wave + reason');

  console.log('Test 3b passed: BACKLOG/TASK_STATUS blocks relocated to parked sections, parked_waves recorded');

  // --agent reports 0 active slices
  const agentOutput = execFileSync('node', [AGENT_PATH], { cwd: TMP, env, encoding: 'utf8' });
  const agentJson = JSON.parse(agentOutput);
  assert.strictEqual(agentJson.active_slices.length, 0, `Test 3 FAIL: expected --agent to report 0 active slices, got ${agentJson.active_slices.length}`);
  console.log('Test 3c passed: --agent reports 0 active slices after --park-wave');

  // validator exits 0 (healthy)
  let validatorExit = 0;
  try {
    execFileSync('node', [VALIDATOR_PATH, TMP], { encoding: 'utf8' });
  } catch (err) {
    validatorExit = err.status;
  }
  assert.strictEqual(validatorExit, 0, `Test 3 FAIL: expected validator to exit 0 after --park-wave, got ${validatorExit}`);
  console.log('Test 3d passed: validator exits 0 (healthy) after --park-wave');

  // --- --unpark-wave 9 ---
  const unparkOutput = execFileSync('node', [PARK_WAVE_PATH, '--unpark-wave', '9'], { cwd: TMP, env, encoding: 'utf8' });
  assert.ok(unparkOutput.includes('restored 3 task(s)'), `Test 3 FAIL: expected unpark output to report 3 tasks restored, got:\n${unparkOutput}`);
  assert.ok(unparkOutput.includes('Validator: healthy'), `Test 3 FAIL: expected validator healthy after unpark, got:\n${unparkOutput}`);
  console.log('Test 3e passed: --unpark-wave 9 restored 3 tasks and validator reports Healthy');

  const backlogAfterUnpark = readUtf8(BACKLOG_PATH);
  const taskStatusAfterUnpark = readUtf8(TASK_STATUS_PATH);
  const stateAfterUnpark = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));

  assert.strictEqual(backlogAfterUnpark, backlogOriginal, 'Test 3 FAIL: BACKLOG.md must restore byte-for-byte after --unpark-wave');
  assert.strictEqual(taskStatusAfterUnpark, taskStatusOriginal, 'Test 3 FAIL: TASK_STATUS.md must restore byte-for-byte after --unpark-wave');
  assert.deepStrictEqual(stateAfterUnpark.parked_waves, [], 'Test 3 FAIL: parked_waves entry must be removed after --unpark-wave');
  assert.ok(!backlogAfterUnpark.includes('## Wave 9 — Parked'), 'Test 3 FAIL: parked BACKLOG heading must be removed after --unpark-wave');
  assert.ok(!taskStatusAfterUnpark.includes('## Parked tasks (Wave 9)'), 'Test 3 FAIL: parked TASK_STATUS heading must be removed after --unpark-wave');

  console.log('Test 3f passed: --unpark-wave 9 restores BACKLOG.md and TASK_STATUS.md byte-for-byte and removes the parked_waves entry');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 4 — error handling: --unpark-wave on a wave that was never parked
// fails clearly without touching any file.
// ---------------------------------------------------------------------------
{
  const { TMP, BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH } = buildFixture();
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };

  const backlogBefore = readUtf8(BACKLOG_PATH);
  const taskStatusBefore = readUtf8(TASK_STATUS_PATH);
  const stateBefore = readUtf8(PROCESS_STATE_JSON_PATH);

  let threw = false;
  try {
    execFileSync('node', [PARK_WAVE_PATH, '--unpark-wave', '9'], { cwd: TMP, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 2, `Test 4 FAIL: expected exit 2 for un-parked wave, got ${err.status}`);
    const combined = `${err.stdout || ''}${err.stderr || ''}`;
    assert.ok(/no "## Wave 9 — Parked" section found/i.test(combined), `Test 4 FAIL: expected clear error message, got:\n${combined}`);
  }
  assert.ok(threw, 'Test 4 FAIL: expected --unpark-wave on a never-parked wave to fail');

  assert.strictEqual(readUtf8(BACKLOG_PATH), backlogBefore, 'Test 4 FAIL: BACKLOG.md must be untouched on failed --unpark-wave');
  assert.strictEqual(readUtf8(TASK_STATUS_PATH), taskStatusBefore, 'Test 4 FAIL: TASK_STATUS.md must be untouched on failed --unpark-wave');
  assert.strictEqual(readUtf8(PROCESS_STATE_JSON_PATH), stateBefore, 'Test 4 FAIL: PROCESS_STATE.json must be untouched on failed --unpark-wave');

  console.log('Test 4 passed: --unpark-wave on a never-parked wave fails clearly (exit 2) without touching any file');

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 5 — T-768: a non-task "### " sub-heading in the Active Wave preamble
// travels with its blocks through park/unpark, so a wave parked under its
// own sub-heading — then unparked after a newer wave's sub-heading + tasks
// were added to Active Wave in the meantime — restores as a coherent
// grouping instead of leaving an orphaned heading behind.
// ---------------------------------------------------------------------------
{
  const backlog = `# BACKLOG

## Active Wave

### Wave 12 — old goal

### T-001 — First
- **Status:** in_progress
- **Owner role:** developer

### T-002 — Second
- **Status:** ready_for_qa
- **Owner role:** developer

## Deferred Tasks

### T-900 — deferred
- **Status:** deferred
`;

  const parked = moveActiveBlocksToParkedSection(backlog, /^##\s+Active Wave/i, parkedBacklogHeading(12));
  assert.strictEqual(parked.ok, true, 'Test 5 FAIL: expected ok:true parking sub-headed Active Wave content');
  assert.deepStrictEqual(parked.taskIds, ['T-001', 'T-002'], 'Test 5 FAIL: expected both task ids parked');

  // The Active Wave section itself must now be preamble-only (no orphaned
  // "### Wave 12 — old goal" heading left behind) — the heading must have
  // travelled into the parked section instead.
  const parkedHeadingIdx = parked.updated.indexOf('## Wave 12 — Parked');
  const activeWaveSection = parked.updated.slice(parked.updated.indexOf('## Active Wave'), parkedHeadingIdx);
  assert.ok(!activeWaveSection.includes('### Wave 12'), 'Test 5 FAIL: "### Wave 12 — old goal" heading must not remain orphaned under Active Wave after park');
  assert.ok(parked.updated.slice(parkedHeadingIdx).includes('### Wave 12 — old goal'), 'Test 5 FAIL: "### Wave 12 — old goal" heading must appear in the parked section');

  // A newer wave opens: its own sub-heading + task land under the now
  // preamble-only Active Wave section, immediately before the parked section.
  const newWaveContent = '### Wave 13 — new goal\n\n### T-003 — Third\n- **Status:** planned\n- **Owner role:** developer\n\n';
  const withWave13 = parked.updated.slice(0, parkedHeadingIdx) + newWaveContent + parked.updated.slice(parkedHeadingIdx);

  const unparked = moveParkedBlocksToActiveSection(withWave13, /^##\s+Active Wave/i, parkedBacklogHeading(12));
  assert.strictEqual(unparked.ok, true, 'Test 5 FAIL: expected ok:true unparking sub-headed content');
  assert.deepStrictEqual(unparked.taskIds, ['T-001', 'T-002'], 'Test 5 FAIL: expected both parked task ids restored');

  const restoredActiveWaveSection = unparked.updated.slice(
    unparked.updated.indexOf('## Active Wave'),
    unparked.updated.indexOf('## Deferred Tasks')
  );
  const order = ['### Wave 13 — new goal', '### T-003', '### Wave 12 — old goal', '### T-001', '### T-002']
    .map((needle) => restoredActiveWaveSection.indexOf(needle));
  assert.ok(order.every((idx) => idx !== -1), `Test 5 FAIL: expected all five markers present, got indices ${JSON.stringify(order)}`);
  assert.ok(
    order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4],
    `Test 5 FAIL: expected order Wave13 heading, T-003, Wave12 heading, T-001, T-002 — got indices ${JSON.stringify(order)}`
  );
  // No orphan heading: "### Wave 12 — old goal" must be immediately followed
  // (modulo blank lines) by its own "### T-001" block, not stranded alone.
  const wave12Idx = restoredActiveWaveSection.indexOf('### Wave 12 — old goal');
  const betweenWave12AndT001 = restoredActiveWaveSection.slice(wave12Idx, restoredActiveWaveSection.indexOf('### T-001'));
  assert.ok(!/###\s+Wave\s+13/.test(betweenWave12AndT001), 'Test 5 FAIL: no orphan heading — nothing but blank lines should sit between Wave 12 heading and its T-001 block');

  console.log('Test 5 passed: T-768 — non-task sub-heading travels with its blocks through park/unpark, restoring a coherent grouping with no orphan heading');
}

// ---------------------------------------------------------------------------
// Part 6 — T-769: --park-wave --until YYYY-MM-DD arms a wave-level recheck
// that --unpark-wave auto-acks.
//
// Clock handling: --until is validated "not before today", so the CLI can
// never itself arm an already-overdue entry. The e2e therefore parks with
// --until = the real clock date (due today -> surfaces, overdue:false) via
// the real CLI path, then simulates the clock advancing one day by rewriting
// ONLY the armed entry's `due` in the fixture's PROCESS_STATE.json to
// clock-date minus one day, to exercise the overdue path. No production
// clock seam is added and criterion 1's validation is not weakened.
// ---------------------------------------------------------------------------
{
  const { todayIso, addDays, recheckRef } = require('./mavp-operator-lib.js');
  const SNAPSHOT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-snapshot.js');
  const DASHBOARD_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-dashboard.js');
  const CLOCK_TODAY = todayIso();
  const CLOCK_MINUS_ONE_DAY = addDays(CLOCK_TODAY, -1);

  function runExpectingExit(args, env, cwd) {
    try {
      const stdout = execFileSync('node', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, out: stdout };
    } catch (err) {
      return { status: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  function findFindings(node, checkName, acc = []) {
    if (Array.isArray(node)) {
      node.forEach((n) => findFindings(n, checkName, acc));
    } else if (node && typeof node === 'object') {
      if (node.checkName === checkName) acc.push(node);
      Object.values(node).forEach((v) => findFindings(v, checkName, acc));
    }
    return acc;
  }

  // --- 6a: --until rejects a past date and a wrong-format date BEFORE any write ---
  {
    const { TMP, BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH } = buildFixture();
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };
    const before = [BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH].map(readUtf8);
    for (const bad of ['2020-01-01', '31-12-2030', CLOCK_MINUS_ONE_DAY, '2030-02-31']) {
      const r = runExpectingExit([PARK_WAVE_PATH, '--park-wave', '9', '--reason', 'r', '--until', bad], env, TMP);
      assert.strictEqual(r.status, 1, `Test 6a FAIL: expected exit 1 for --until ${bad}, got ${r.status}:\n${r.out}`);
      assert.ok(/Invalid --until value/.test(r.out), `Test 6a FAIL: expected an "Invalid --until value" error for ${bad}, got:\n${r.out}`);
      const after = [BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH].map(readUtf8);
      assert.deepStrictEqual(after, before, `Test 6a FAIL: BACKLOG.md / TASK_STATUS.md / PROCESS_STATE.json must be untouched after rejected --until ${bad}`);
    }
    console.log('Test 6a passed: --until 2020-01-01, 31-12-2030, yesterday and 2030-02-31 each exit 1 before any write, all three files untouched');
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // --- 6b..6h: full park --until -> surfaces -> overdue -> unpark auto-ack round trip ---
  {
    const { TMP, BACKLOG_PATH, TASK_STATUS_PATH, PROCESS_STATE_JSON_PATH, backlogOriginal, taskStatusOriginal } = buildFixture();
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };

    const parkOut = execFileSync('node', [PARK_WAVE_PATH, '--park-wave', '9', '--reason', 'r', '--until', CLOCK_TODAY], { cwd: TMP, env, encoding: 'utf8' });
    assert.ok(parkOut.includes('parked 3 task(s)'), `Test 6b FAIL: expected 3 tasks parked, got:\n${parkOut}`);
    assert.ok(parkOut.includes('Validator: healthy'), `Test 6b FAIL: expected validator healthy after park --until, got:\n${parkOut}`);
    const stateAfterPark = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
    assert.deepStrictEqual(stateAfterPark.parked_waves, ['Wave 9 — r'], 'Test 6b FAIL: parked_waves must record the wave + reason');
    assert.deepStrictEqual(stateAfterPark.rechecks, [{
      id: 'RC-1',
      wave: 9,
      title: 'Wave 9 — r',
      due: CLOCK_TODAY,
      armed_at: CLOCK_TODAY,
      note: 'parked wave — resume with --unpark-wave 9',
    }], `Test 6b FAIL: expected exactly one wave recheck entry, got ${JSON.stringify(stateAfterPark.rechecks)}`);
    assert.ok(!('task' in stateAfterPark.rechecks[0]), 'Test 6b FAIL: a wave recheck entry must carry no "task" key');
    assert.strictEqual(typeof stateAfterPark.rechecks[0].wave, 'number', 'Test 6b FAIL: "wave" must be stored as a number');
    console.log('Test 6b passed: --park-wave 9 --reason "r" --until <today> appends parked_waves AND a {id, wave:9, title, due, armed_at, note} recheck with no task key');

    // due today -> --agent surfaces it with overdue:false
    const agentToday = JSON.parse(execFileSync('node', [AGENT_PATH], { cwd: TMP, env, encoding: 'utf8' }));
    assert.ok(Array.isArray(agentToday.due_rechecks), `Test 6c FAIL: expected due_rechecks, got ${JSON.stringify(agentToday.due_rechecks)}`);
    const todayEntry = agentToday.due_rechecks.find((e) => e.wave === 9);
    assert.ok(todayEntry, `Test 6c FAIL: expected a due_rechecks entry with wave 9, got ${JSON.stringify(agentToday.due_rechecks)}`);
    assert.strictEqual(todayEntry.overdue, false, 'Test 6c FAIL: a due-today wave recheck must be overdue:false');
    console.log('Test 6c passed: --agent due_rechecks carries the additive wave:9 field (due today, overdue:false)');

    // Simulate the clock advancing past the due date (see Part 6 header).
    const advanced = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
    advanced.rechecks[0].due = CLOCK_MINUS_ONE_DAY;
    writeUtf8(PROCESS_STATE_JSON_PATH, JSON.stringify(advanced, null, 2) + '\n');

    const agentOverdue = JSON.parse(execFileSync('node', [AGENT_PATH], { cwd: TMP, env, encoding: 'utf8' }));
    const overdueEntry = (agentOverdue.due_rechecks || []).find((e) => e.wave === 9);
    assert.ok(overdueEntry, `Test 6d FAIL: expected a due_rechecks entry with wave 9, got ${JSON.stringify(agentOverdue.due_rechecks)}`);
    assert.strictEqual(overdueEntry.overdue, true, 'Test 6d FAIL: a due-yesterday wave recheck must be overdue:true');
    assert.ok(!('task' in overdueEntry), 'Test 6d FAIL: --agent wave entry must not invent a task field');
    console.log('Test 6d passed: --agent due_rechecks entry has wave 9 and overdue:true once the due date is past');

    const snapshotOut = execFileSync('node', [SNAPSHOT_PATH], { cwd: TMP, env, encoding: 'utf8' });
    const dueLine = snapshotOut.split('\n').find((l) => l.startsWith('Due rechecks:'));
    assert.ok(dueLine && dueLine.includes('Wave 9'), `Test 6e FAIL: expected a "Due rechecks:" line naming Wave 9, got:\n${snapshotOut}`);
    console.log(`Test 6e passed: --snapshot line reads: ${dueLine}`);

    const dashOut = execFileSync('node', [DASHBOARD_PATH], { cwd: TMP, env, encoding: 'utf8' });
    const dashIdx = dashOut.indexOf('Due Rechecks');
    assert.ok(dashIdx !== -1 && dashOut.slice(dashIdx).includes('Wave 9 — r'), `Test 6f FAIL: expected dashboard Due Rechecks panel naming "Wave 9 — r", got:\n${dashOut}`);
    assert.ok(!dashOut.includes('Wave 9 — Wave 9'), 'Test 6f FAIL: dashboard must not repeat the wave ref in front of a title that already names it');
    console.log('Test 6f passed: dashboard Due Rechecks panel names Wave 9');

    // validator: info-severity overdue_recheck naming Wave 9, exit 0
    const validatorText = runExpectingExit([VALIDATOR_PATH, TMP], env, TMP);
    assert.strictEqual(validatorText.status, 0, `Test 6g FAIL: validator must still exit 0 with an overdue wave recheck, got ${validatorText.status}:\n${validatorText.out}`);
    assert.ok(/overdue_recheck: Recheck RC-1 for Wave 9 \("Wave 9 — r"\)/.test(validatorText.out), `Test 6g FAIL: expected overdue_recheck naming Wave 9, got:\n${validatorText.out}`);
    const validatorJson = JSON.parse(runExpectingExit([VALIDATOR_PATH, TMP, '--json'], env, TMP).out);
    const overdueFindings = findFindings(validatorJson, 'overdue_recheck');
    assert.ok(overdueFindings.length >= 1, 'Test 6g FAIL: expected an overdue_recheck finding in --json output');
    const f = overdueFindings[0];
    assert.strictEqual(f.severity, 'info', `Test 6g FAIL: overdue_recheck must be info severity, got ${f.severity}`);
    assert.strictEqual(f.taskId, 'Wave 9', `Test 6g FAIL: finding ref must be "Wave 9", got ${f.taskId}`);
    assert.ok(f.suggestedAction.includes('--unpark-wave 9') && f.suggestedAction.includes('--ack-recheck RC-1'), `Test 6g FAIL: suggestedAction must name --unpark-wave 9 / --ack-recheck RC-1, got: ${f.suggestedAction}`);
    console.log(`Test 6g passed: validator exit 0 with info overdue_recheck for Wave 9; suggestedAction: ${f.suggestedAction}`);

    // --unpark-wave 9 auto-acks
    const unparkOut = execFileSync('node', [PARK_WAVE_PATH, '--unpark-wave', '9'], { cwd: TMP, env, encoding: 'utf8' });
    const ackedLines = unparkOut.split('\n').filter((l) => l.startsWith('acked '));
    assert.deepStrictEqual(ackedLines, ['acked RC-1 (parked-wave reminder)'], `Test 6h FAIL: expected exactly one acked line, got:\n${unparkOut}`);
    const stateAfterUnpark = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
    assert.deepStrictEqual(stateAfterUnpark.rechecks, [], 'Test 6h FAIL: rechecks[] must be empty after --unpark-wave 9');
    assert.deepStrictEqual(stateAfterUnpark.parked_waves, [], 'Test 6h FAIL: parked_waves must be empty after --unpark-wave 9');
    assert.strictEqual(readUtf8(BACKLOG_PATH), backlogOriginal, 'Test 6h FAIL: BACKLOG.md must restore byte-for-byte');
    assert.strictEqual(readUtf8(TASK_STATUS_PATH), taskStatusOriginal, 'Test 6h FAIL: TASK_STATUS.md must restore byte-for-byte');
    console.log('Test 6h passed: --unpark-wave 9 prints "acked RC-1 (parked-wave reminder)", empties rechecks[] and parked_waves, restores BACKLOG/TASK_STATUS byte-for-byte');
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // --- 6i: --unpark-wave removes EVERY entry for that wave, keeps the rest ---
  {
    const { TMP, PROCESS_STATE_JSON_PATH } = buildFixture();
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };
    execFileSync('node', [PARK_WAVE_PATH, '--park-wave', '9', '--reason', 'r', '--until', CLOCK_TODAY], { cwd: TMP, env, encoding: 'utf8' });
    const st = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
    st.rechecks.push(
      { id: 'RC-2', wave: 9, title: 'Wave 9 — second', due: '2099-01-01', armed_at: CLOCK_TODAY },
      { id: 'RC-3', wave: 10, title: 'Wave 10 — other', due: '2099-01-01', armed_at: CLOCK_TODAY },
      { id: 'RC-4', task: 'T-100', title: 'task recheck', due: '2099-01-01', armed_at: CLOCK_TODAY },
    );
    writeUtf8(PROCESS_STATE_JSON_PATH, JSON.stringify(st, null, 2) + '\n');
    const out = execFileSync('node', [PARK_WAVE_PATH, '--unpark-wave', '9'], { cwd: TMP, env, encoding: 'utf8' });
    const acked = out.split('\n').filter((l) => l.startsWith('acked '));
    assert.deepStrictEqual(acked, ['acked RC-1 (parked-wave reminder)', 'acked RC-2 (parked-wave reminder)'], `Test 6i FAIL: expected one acked line per wave-9 entry, got:\n${out}`);
    const remaining = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH)).rechecks.map((e) => e.id);
    assert.deepStrictEqual(remaining, ['RC-3', 'RC-4'], `Test 6i FAIL: wave-10 and task entries must survive, got ${JSON.stringify(remaining)}`);
    console.log('Test 6i passed: --unpark-wave 9 acks every wave-9 entry (RC-1, RC-2) and keeps the wave-10 and task entries');
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // --- 6j: --park-wave WITHOUT --until writes no recheck, prints no recheck
  // line; unpark with no matching entry prints no acked line. ---
  {
    const { TMP, PROCESS_STATE_JSON_PATH } = buildFixture();
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: TMP };
    const parkOut = execFileSync('node', [PARK_WAVE_PATH, '--park-wave', '9', '--reason', 'r'], { cwd: TMP, env, encoding: 'utf8' });
    assert.ok(!/rechecks:/.test(parkOut), `Test 6j FAIL: park without --until must print no rechecks line, got:\n${parkOut}`);
    const st = JSON.parse(readUtf8(PROCESS_STATE_JSON_PATH));
    assert.deepStrictEqual(st.rechecks, [], 'Test 6j FAIL: park without --until must leave rechecks[] untouched');
    const unparkOut = execFileSync('node', [PARK_WAVE_PATH, '--unpark-wave', '9'], { cwd: TMP, env, encoding: 'utf8' });
    assert.ok(!/^acked /m.test(unparkOut), `Test 6j FAIL: unpark with no matching recheck must print no acked line, got:\n${unparkOut}`);
    console.log('Test 6j passed: --park-wave without --until arms nothing; --unpark-wave with no matching entry prints no acked line');
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  // --- 6k: recheckRef() contract ---
  assert.strictEqual(recheckRef({ id: 'RC-1', task: 'T-123' }), 'T-123', 'Test 6k FAIL: task entry ref');
  assert.strictEqual(recheckRef({ id: 'RC-2', wave: 9 }), 'Wave 9', 'Test 6k FAIL: wave entry ref');
  assert.strictEqual(recheckRef({ id: 'RC-3' }), 'RC-3', 'Test 6k FAIL: fallback to id');
  console.log('Test 6k passed: recheckRef() -> T-NNN for task, "Wave N" for wave, id otherwise');

  // --- 6l: both wrappers' --help document --until (T-761 lesson) ---
  {
    const canonicalHelp = execFileSync('bash', [path.join(SCRIPTS_DIR, 'mavp-operator'), '--help'], { encoding: 'utf8' });
    assert.ok(/--park-wave .*--until YYYY-MM-DD/.test(canonicalHelp), `Test 6l FAIL: canonical --help must document --park-wave --until, got:\n${canonicalHelp}`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't769-wrapper-'));
    try {
      execFileSync('node', [path.join(SCRIPTS_DIR, 'mavp-install.js'), scratch, '--yes', '--stale-source-ok'], { encoding: 'utf8' });
      const adopterWrapper = path.join(scratch, 'scripts', 'mavp-operator');
      const adopterHelp = execFileSync('bash', [adopterWrapper, '--help'], { encoding: 'utf8', env: { ...process.env, MAVERICKS_HOME: path.dirname(SCRIPTS_DIR) } }); // hermetic pin (.claude/rules/scripts.md)
      assert.ok(/--park-wave .*--until YYYY-MM-DD/.test(adopterHelp), `Test 6l FAIL: adopter wrapper --help must document --park-wave --until, got:\n${adopterHelp}`);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('Test 6l passed: canonical scripts/mavp-operator --help and the buildBashWrapper() adopter wrapper --help both document --until');
  }
}

console.log('\nAll test-park-wave.js assertions passed.');
