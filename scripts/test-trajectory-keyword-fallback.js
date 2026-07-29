'use strict';
// Regression test: T-560 — keyword fallback in extractTrajectories must not
// count the literal field-name token `needs_fix_rounds` as fix-round
// occurrences, while genuine prose keyword mentions ("entered needs_fix
// twice") must still count.
//
// Both fixture tasks use verification type "artifact" so qaOutcome resolves
// to "skipped" — this deliberately sidesteps the separate "subtract 1 when
// qaOutcome === 'passed'" adjustment in extractTrajectories, keeping this
// test isolated to the keyword-fallback regex itself.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const TMP_DIR = path.join(os.tmpdir(), 't560-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Build synthetic TASK_STATUS.md fixture
//   T-001 — evidence contains only digitless "needs_fix_rounds: N" mentions
//           (documentation of the field name, no digit-valued occurrence, no
//           other needs_fix text) → needsFixCount must be 0
//   T-002 — evidence contains two genuine prose "needs_fix" keyword mentions,
//           no explicit needs_fix_rounds field at all → needsFixCount must be 2
// ---------------------------------------------------------------------------
const taskStatusContent = `# TASK_STATUS

## Recently completed tasks

### T-001 — digitless needs_fix_rounds field-name mentions only
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Evidence:** commit: abc1234 branch: main added a section with instructions to record needs_fix_rounds: N, and added guidance to include needs_fix_rounds: N on repeat passes.

### T-002 — genuine prose needs_fix keyword mentions
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Evidence:** commit: def5678 branch: main the task entered needs_fix once during review and needs_fix again after a follow-up round before being resolved.
`;

const backlogContent = `# BACKLOG

## Active Wave
`;

const TASK_STATUS_PATH = path.join(TMP_DIR, 'TASK_STATUS.md');
const BACKLOG_PATH = path.join(TMP_DIR, 'BACKLOG.md');

fs.writeFileSync(TASK_STATUS_PATH, taskStatusContent, 'utf8');
fs.writeFileSync(BACKLOG_PATH, backlogContent, 'utf8');

process.env.MAVERICKS_PROJECT_ROOT = TMP_DIR;

const { extractTrajectories } = require('./mavp-operator-lib.js');

const trajectories = extractTrajectories('developer', {
  taskStatusPath: TASK_STATUS_PATH,
  backlogPath: BACKLOG_PATH,
});

const byId = Object.fromEntries(trajectories.map((t) => [t.taskId, t]));

// ---------------------------------------------------------------------------
// Assertion 1: both records extracted
// ---------------------------------------------------------------------------
assert.strictEqual(
  trajectories.length,
  2,
  `Assertion 1 FAIL: expected 2 trajectories, got ${trajectories.length}`
);

// ---------------------------------------------------------------------------
// Assertion 2 (mutant killer — "leave regex untouched"):
// T-001's evidence has only digitless needs_fix_rounds field-name mentions
// and no digit-valued explicit field and no other needs_fix text.
// needsFixCount must be 0, not 2.
// ---------------------------------------------------------------------------
assert.strictEqual(
  byId['T-001'].needsFixCount,
  0,
  `Assertion 2 FAIL: expected T-001.needsFixCount === 0 (digitless needs_fix_rounds field-name mentions must not count), got ${byId['T-001'].needsFixCount}`
);

// ---------------------------------------------------------------------------
// Assertion 3 (mutant killer — "over-broad exclusion"):
// T-002's evidence has two genuine prose needs_fix keyword mentions and no
// explicit field. needsFixCount must still be 2.
// ---------------------------------------------------------------------------
assert.strictEqual(
  byId['T-002'].needsFixCount,
  2,
  `Assertion 3 FAIL: expected T-002.needsFixCount === 2 (genuine prose needs_fix mentions must still count), got ${byId['T-002'].needsFixCount}`
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-560 assertions passed.');
