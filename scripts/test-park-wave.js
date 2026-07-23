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

console.log('\nAll test-park-wave.js assertions passed.');
