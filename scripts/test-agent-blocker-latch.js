'use strict';
// Regression test: T-512 — --agent blocker latch must derive
// PROCESS_STATE_WARNING from the live validator exit-2 result it already
// computes (runValidatorCheck()), not from a substring scan of every string
// field in PROCESS_STATE.json.
//
// Prior defect: mavp-operator-agent.js latched blocker: 'PROCESS_STATE_WARNING'
// whenever ANY string field in PROCESS_STATE.json (wave_goal, wave_summary,
// wave_strategy_note, etc.) contained the literal phrase "REPAIR REQUIRED" —
// even narrative prose describing the problem, with a healthy live validator.
// That false-positived session-start every time such prose was written.
//
// Covers:
//   1. Healthy fixture with wave_goal / wave_summary / wave_strategy_note EACH
//      containing "REPAIR REQUIRED" and blocker: null -> --agent JSON has
//      blocker === null and no WARNING field (the false positive is dead).
//   2. Fixture with a genuine validator exit-2 condition (a merged task in
//      TASK_STATUS.md with no commit: evidence) -> blocker ===
//      "PROCESS_STATE_WARNING" and WARNING contains "REPAIR REQUIRED".
//   3. An explicit non-null json.blocker string passes through verbatim.
//   4. blocker: "none" and blocker: "" each normalize to null.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const AGENT_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-agent.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-agent-blocker-latch-${process.pid}-${Date.now()}`
);

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}
process.on('exit', cleanup);

function makeFixtureProject(name, { backlog, taskStatus, processState }) {
  const root = path.join(SCRATCH_ROOT, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n', 'utf8');
  return root;
}

function runAgent(root) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  const stdout = execFileSync('node', [AGENT_PATH], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  return JSON.parse(stdout);
}

const EMPTY_BACKLOG = '# BACKLOG\n\n## Active Wave\n\n';
const EMPTY_TASK_STATUS = '# TASK_STATUS\n\n## Active tasks\n\n';

// ---------------------------------------------------------------------------
// Test 1: healthy fixture, narrative fields each contain "REPAIR REQUIRED",
// blocker: null -> blocker must be null and no WARNING field emitted.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureProject('healthy-repair-phrase', {
    backlog: EMPTY_BACKLOG,
    taskStatus: EMPTY_TASK_STATUS,
    processState: {
      initiative: 'T-512 test fixture',
      stage: 'execution',
      wave: 1,
      wave_goal: 'Fix the latch so a wave_goal describing what permanently latches REPAIR REQUIRED does not itself trip it.',
      wave_summary: 'Wave summary text that also quotes REPAIR REQUIRED for regression coverage.',
      wave_strategy_note: 'Strategy note mentioning REPAIR REQUIRED as a narrative reference only.',
      active_slices: [],
      next_action: 'Open next wave',
      blocker: null,
      stage_owner: 'main_agent',
      last_task_id: 1,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      wave_summary_final: null,
      rechecks: [],
    },
  });

  const output = runAgent(root);
  assert.strictEqual(output.blocker, null, `Test 1 FAIL: expected blocker null, got ${JSON.stringify(output.blocker)}. Full output: ${JSON.stringify(output)}`);
  assert.ok(!('WARNING' in output), `Test 1 FAIL: expected no WARNING field, got ${JSON.stringify(output.WARNING)}`);
  console.log('Test 1 passed: healthy fixture with "REPAIR REQUIRED" in wave_goal/wave_summary/wave_strategy_note yields blocker: null and no WARNING (false positive is dead)');
}

// ---------------------------------------------------------------------------
// Test 2: genuine validator exit-2 condition — a merged task in TASK_STATUS.md
// with no commit: (or infra:/artifact:) evidence -> blocker must be
// "PROCESS_STATE_WARNING" and WARNING must contain "REPAIR REQUIRED".
// ---------------------------------------------------------------------------
{
  const taskStatusWithBadMerge = `# TASK_STATUS

## Active tasks

### T-900 — Fixture merged task missing commit evidence
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** —
`;

  const root = makeFixtureProject('genuine-repair-required', {
    backlog: EMPTY_BACKLOG,
    taskStatus: taskStatusWithBadMerge,
    processState: {
      initiative: 'T-512 test fixture',
      stage: 'execution',
      wave: 1,
      active_slices: [],
      next_action: 'Open next wave',
      blocker: null,
      stage_owner: 'main_agent',
      last_task_id: 900,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      rechecks: [],
    },
  });

  const output = runAgent(root);
  assert.strictEqual(output.blocker, 'PROCESS_STATE_WARNING', `Test 2 FAIL: expected blocker "PROCESS_STATE_WARNING", got ${JSON.stringify(output.blocker)}. Full output: ${JSON.stringify(output)}`);
  assert.ok(typeof output.WARNING === 'string' && output.WARNING.includes('REPAIR REQUIRED'), `Test 2 FAIL: expected WARNING to contain "REPAIR REQUIRED", got ${JSON.stringify(output.WARNING)}`);
  console.log('Test 2 passed: a genuine validator exit-2 condition (merged task with no commit: evidence) yields blocker: "PROCESS_STATE_WARNING" and WARNING containing "REPAIR REQUIRED"');
}

// ---------------------------------------------------------------------------
// Test 3: explicit non-null json.blocker passes through verbatim (healthy
// artifacts, no validator exit-2 condition).
// ---------------------------------------------------------------------------
{
  const root = makeFixtureProject('explicit-blocker-passthrough', {
    backlog: EMPTY_BACKLOG,
    taskStatus: EMPTY_TASK_STATUS,
    processState: {
      initiative: 'T-512 test fixture',
      stage: 'execution',
      wave: 1,
      active_slices: [],
      next_action: 'Open next wave',
      blocker: 'waiting on external review',
      stage_owner: 'main_agent',
      last_task_id: 1,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      rechecks: [],
    },
  });

  const output = runAgent(root);
  assert.strictEqual(output.blocker, 'waiting on external review', `Test 3 FAIL: expected explicit blocker string to pass through verbatim, got ${JSON.stringify(output.blocker)}`);
  console.log('Test 3 passed: an explicit non-null json.blocker string passes through verbatim');
}

// ---------------------------------------------------------------------------
// Test 4: blocker: "none" and blocker: "" both normalize to null.
// ---------------------------------------------------------------------------
{
  const rootNone = makeFixtureProject('blocker-none-string', {
    backlog: EMPTY_BACKLOG,
    taskStatus: EMPTY_TASK_STATUS,
    processState: {
      initiative: 'T-512 test fixture',
      stage: 'execution',
      wave: 1,
      active_slices: [],
      next_action: 'Open next wave',
      blocker: 'none',
      stage_owner: 'main_agent',
      last_task_id: 1,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      rechecks: [],
    },
  });
  const outputNone = runAgent(rootNone);
  assert.strictEqual(outputNone.blocker, null, `Test 4a FAIL: expected blocker: "none" to normalize to null, got ${JSON.stringify(outputNone.blocker)}`);
  console.log('Test 4a passed: blocker: "none" normalizes to null');

  const rootEmpty = makeFixtureProject('blocker-empty-string', {
    backlog: EMPTY_BACKLOG,
    taskStatus: EMPTY_TASK_STATUS,
    processState: {
      initiative: 'T-512 test fixture',
      stage: 'execution',
      wave: 1,
      active_slices: [],
      next_action: 'Open next wave',
      blocker: '',
      stage_owner: 'main_agent',
      last_task_id: 1,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      rechecks: [],
    },
  });
  const outputEmpty = runAgent(rootEmpty);
  assert.strictEqual(outputEmpty.blocker, null, `Test 4b FAIL: expected blocker: "" to normalize to null, got ${JSON.stringify(outputEmpty.blocker)}`);
  console.log('Test 4b passed: blocker: "" normalizes to null');
}

console.log('\nAll T-512 --agent blocker latch assertions passed.');
