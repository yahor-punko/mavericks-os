'use strict';
// Regression test: T-258 — terminal-status trajectory extraction filter
// Guards that extractTrajectories includes merged + deployed_dev + deployed_prod
// and excludes deferred/planned/wrong-role tasks.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const TMP_DIR = path.join(os.tmpdir(), 't258-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Build synthetic TASK_STATUS.md fixture
// Six developer-owned (or qa-owned) task blocks covering all cases:
//   T-001 merged         → must be included
//   T-002 deployed_dev   → must be included
//   T-003 deployed_prod  → must be included
//   T-004 deferred       → must be excluded (non-terminal)
//   T-005 planned        → must be excluded (non-terminal)
//   T-006 merged + qa    → must be excluded (wrong role)
// ---------------------------------------------------------------------------
const taskStatusContent = `# TASK_STATUS

## Active tasks

### T-004 — deferred task
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** deferred indefinitely

### T-005 — planned task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime

## Recently completed tasks

### T-001 — merged developer task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234 branch: main needs_fix_rounds: 0

### T-002 — deployed_dev developer task
- **Status:** deployed_dev
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: def5678 branch: main needs_fix_rounds: 0

### T-003 — deployed_prod developer task
- **Status:** deployed_prod
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: ghi9012 branch: main needs_fix_rounds: 0

### T-006 — merged qa task
- **Status:** merged
- **Owner role:** qa
- **Verification type:** runtime
- **Evidence:** commit: jkl3456 branch: main needs_fix_rounds: 0
`;

// ---------------------------------------------------------------------------
// Build minimal BACKLOG.md fixture (owner role lives in TASK_STATUS in this
// fixture, but backlogPath must be passed so the function does not crash)
// ---------------------------------------------------------------------------
const backlogContent = `# BACKLOG

## Active Wave

### T-004 — deferred task
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** runtime

### T-005 — planned task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
`;

const TASK_STATUS_PATH = path.join(TMP_DIR, 'TASK_STATUS.md');
const BACKLOG_PATH = path.join(TMP_DIR, 'BACKLOG.md');

fs.writeFileSync(TASK_STATUS_PATH, taskStatusContent, 'utf8');
fs.writeFileSync(BACKLOG_PATH, backlogContent, 'utf8');

// Point the module's ROOT at a dir that won't accidentally pick up real files.
// extractTrajectories accepts explicit paths so the ROOT env var is not strictly
// needed here, but we set it as a safeguard.
process.env.MAVERICKS_PROJECT_ROOT = TMP_DIR;

const { extractTrajectories } = require('./mavp-operator-lib.js');

// ---------------------------------------------------------------------------
// Invoke extractTrajectories for the 'developer' role
// ---------------------------------------------------------------------------
const trajectories = extractTrajectories('developer', {
  taskStatusPath: TASK_STATUS_PATH,
  backlogPath: BACKLOG_PATH,
});

// ---------------------------------------------------------------------------
// Assertion 1: exactly three records returned (T-001, T-002, T-003)
// ---------------------------------------------------------------------------
const returnedIds = trajectories.map((t) => t.taskId).sort();
assert.deepStrictEqual(
  returnedIds,
  ['T-001', 'T-002', 'T-003'],
  `Assertion 1 FAIL: expected [T-001, T-002, T-003], got [${returnedIds.join(', ')}]`
);

// ---------------------------------------------------------------------------
// Assertion 2: deferred (T-004) and planned (T-005) are excluded
// ---------------------------------------------------------------------------
const hasT004 = trajectories.some((t) => t.taskId === 'T-004');
const hasT005 = trajectories.some((t) => t.taskId === 'T-005');
assert.strictEqual(hasT004, false, 'Assertion 2a FAIL: T-004 (deferred) must be excluded');
assert.strictEqual(hasT005, false, 'Assertion 2b FAIL: T-005 (planned) must be excluded');

// ---------------------------------------------------------------------------
// Assertion 3: wrong-role task (T-006, qa) is excluded
// ---------------------------------------------------------------------------
const hasT006 = trajectories.some((t) => t.taskId === 'T-006');
assert.strictEqual(hasT006, false, 'Assertion 3 FAIL: T-006 (qa role) must be excluded');

// ---------------------------------------------------------------------------
// Assertion 4: each returned record carries its ACTUAL status string
//   T-001 → 'merged', T-002 → 'deployed_dev', T-003 → 'deployed_prod'
// ---------------------------------------------------------------------------
const byId = Object.fromEntries(trajectories.map((t) => [t.taskId, t]));

assert.strictEqual(
  byId['T-001'].status,
  'merged',
  `Assertion 4a FAIL: T-001 status expected 'merged', got '${byId['T-001'].status}'`
);
assert.strictEqual(
  byId['T-002'].status,
  'deployed_dev',
  `Assertion 4b FAIL: T-002 status expected 'deployed_dev', got '${byId['T-002'].status}'`
);
assert.strictEqual(
  byId['T-003'].status,
  'deployed_prod',
  `Assertion 4c FAIL: T-003 status expected 'deployed_prod', got '${byId['T-003'].status}'`
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-258 assertions passed.');
