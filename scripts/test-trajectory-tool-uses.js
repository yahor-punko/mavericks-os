'use strict';
// Regression test: T-312 — optional tool_uses evidence field extraction
// Guards that extractTrajectories():
//   1. Parses `tool_uses: <N>` from a task's evidence block into `toolUses: N`
//      on the resulting trajectory record when present.
//   2. Omits `toolUses` (does not crash, does not default it) when the
//      evidence block has no `tool_uses:` field.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const TMP_DIR = path.join(os.tmpdir(), 't312-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Build synthetic TASK_STATUS.md fixture
//   T-001 merged developer task WITH tool_uses: 41  → toolUses must be 41
//   T-002 merged developer task WITHOUT tool_uses   → toolUses must be omitted
// ---------------------------------------------------------------------------
const taskStatusContent = `# TASK_STATUS

## Recently completed tasks

### T-001 — merged developer task with tool_uses
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: abc1234 branch: main needs_fix_rounds: 0 tool_uses: 41

### T-002 — merged developer task without tool_uses
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** commit: def5678 branch: main needs_fix_rounds: 0
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
// Assertion 2: T-001 (has tool_uses: 41) → toolUses === 41
// ---------------------------------------------------------------------------
assert.strictEqual(
  byId['T-001'].toolUses,
  41,
  `Assertion 2 FAIL: expected T-001.toolUses === 41, got ${byId['T-001'].toolUses}`
);

// ---------------------------------------------------------------------------
// Assertion 3: T-002 (no tool_uses field) → toolUses omitted (not present as own property)
// ---------------------------------------------------------------------------
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(byId['T-002'], 'toolUses'),
  false,
  `Assertion 3 FAIL: expected T-002 to omit toolUses, got ${JSON.stringify(byId['T-002'])}`
);

// ---------------------------------------------------------------------------
// Assertion 4: existing fields on T-002 remain intact (no crash, no side effects)
// ---------------------------------------------------------------------------
assert.strictEqual(byId['T-002'].status, 'merged', 'Assertion 4 FAIL: T-002 status should be merged');
assert.strictEqual(byId['T-002'].needsFixCount, 0, 'Assertion 4 FAIL: T-002 needsFixCount should be 0');

// ---------------------------------------------------------------------------
// Assertion 5: JSONL round-trip via writeTrajectories — present case serializes
// "toolUses":41 and absent case has no "toolUses" key in the written line.
// ---------------------------------------------------------------------------
const { writeTrajectories } = require('./mavp-operator-lib.js');
const OUT_DIR = path.join(TMP_DIR, 'trajectories-out');
writeTrajectories('developer', trajectories, { outputDir: OUT_DIR });
const jsonlContent = fs.readFileSync(path.join(OUT_DIR, 'developer.jsonl'), 'utf8');
const lines = jsonlContent.trim().split('\n').map((l) => JSON.parse(l));
const writtenById = Object.fromEntries(lines.map((r) => [r.taskId, r]));

assert.strictEqual(
  writtenById['T-001'].toolUses,
  41,
  'Assertion 5a FAIL: JSONL record for T-001 should contain "toolUses": 41'
);
assert.strictEqual(
  jsonlContent.includes('"toolUses":41') || jsonlContent.includes('"toolUses": 41'),
  true,
  'Assertion 5b FAIL: raw JSONL text should literally contain toolUses:41 for T-001'
);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(writtenById['T-002'], 'toolUses'),
  false,
  'Assertion 5c FAIL: JSONL record for T-002 should omit toolUses key'
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-312 assertions passed.');
