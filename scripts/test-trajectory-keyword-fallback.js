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
//
// T-903 section (further down): terminal-success tasks are never labelled
// outcome failed and never carry the evidence_error flag.

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
// T-903 — extractTrajectories must not label a terminal-success task a QA
// failure on evidence keywords, and must not emit the evidence_error flag.
// Every expected value below is written from the T-903 acceptance criteria
// (outcome set {passed, skipped} for terminal-success tasks; base scores
// passed 1.0 / skipped 0.8; needsFix penalty 0.1 per round beyond the first;
// validator-block penalty 0.2), not read off a run.
//
// Fixture tasks are runtime-verified (not artifact) so the outcome comes from
// the evidence-keyword branch rather than the artifact short-circuit.
// ---------------------------------------------------------------------------
const TMP_DIR_903 = path.join(os.tmpdir(), 't903-test-' + Date.now());
fs.mkdirSync(TMP_DIR_903, { recursive: true });

const task903 = (id, title, evidence) => `### ${id} — ${title}
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Evidence:** ${evidence}
`;

const status903 = `# TASK_STATUS

## Recently completed tasks

${task903('T-101', 'mutant red run and zero-error count, no pass keyword',
  'commit: abc1234 branch: main mutant run FAILED (failures=1) as expected, then restored. Log tail: INFO 0 errors.')}
${task903('T-102', 'identifier and log field containing the word failed',
  'commit: abc1235 branch: main grep hit the ReadFailed identifier; log field delivery=failed seen in the fixture.')}
${task903('T-103', 'pass token plus a quoted failure',
  'commit: abc1236 branch: main qa_passed; the mutant run showed 1 failed before the fix was restored.')}
${task903('T-104', 'explicit fix rounds, no pass keyword',
  'commit: abc1237 branch: main needs_fix_rounds: 4 after review.')}
${task903('T-105', 'explicit validator block, no pass keyword',
  'commit: abc1238 branch: main validator_blocked: true once during the work.')}
${task903('T-106', 'scope deviation wording',
  'commit: abc1239 branch: main an edit landed outside scope and was reported.')}
`;

const BACKLOG_PATH_903 = path.join(TMP_DIR_903, 'BACKLOG.md');
const TASK_STATUS_PATH_903 = path.join(TMP_DIR_903, 'TASK_STATUS.md');
fs.writeFileSync(BACKLOG_PATH_903, backlogContent, 'utf8');
fs.writeFileSync(TASK_STATUS_PATH_903, status903, 'utf8');

const { scoreTrajectory } = require('./mavp-operator-lib.js');
const traj903 = extractTrajectories('developer', {
  taskStatusPath: TASK_STATUS_PATH_903,
  backlogPath: BACKLOG_PATH_903,
});
const by903 = Object.fromEntries(traj903.map((t) => [t.taskId, t]));

assert.strictEqual(
  traj903.length,
  6,
  `T-903 setup FAIL: expected 6 trajectories, got ${traj903.length}`
);

// (a) Quoted mutant red run (FAILED, failures=1) and a zero-error count, no
// pass keyword -> skipped, no flags, 0.8. Kills: re-adding the `failed`
// branch, and re-adding the evidence_error push on the bare substring.
assert.strictEqual(by903['T-101'].qaOutcome, 'skipped',
  `T-903 (a) FAIL: expected outcome skipped, got ${by903['T-101'].qaOutcome}`);
assert.deepStrictEqual(by903['T-101'].evidenceFlags, [],
  `T-903 (a) FAIL: expected no flags, got ${JSON.stringify(by903['T-101'].evidenceFlags)}`);
assert.strictEqual(scoreTrajectory(by903['T-101']), 0.8,
  `T-903 (a) FAIL: expected score 0.8, got ${scoreTrajectory(by903['T-101'])}`);

// (b) An identifier ending in ReadFailed and a log field delivery=failed ->
// skipped and 0.8.
assert.strictEqual(by903['T-102'].qaOutcome, 'skipped',
  `T-903 (b) FAIL: expected outcome skipped, got ${by903['T-102'].qaOutcome}`);
assert.strictEqual(scoreTrajectory(by903['T-102']), 0.8,
  `T-903 (b) FAIL: expected score 0.8, got ${scoreTrajectory(by903['T-102'])}`);

// (c) qa_passed plus the words "1 failed" in the mutant run -> passed, 1.0.
assert.strictEqual(by903['T-103'].qaOutcome, 'passed',
  `T-903 (c) FAIL: expected outcome passed, got ${by903['T-103'].qaOutcome}`);
assert.strictEqual(scoreTrajectory(by903['T-103']), 1.0,
  `T-903 (c) FAIL: expected score 1.0, got ${scoreTrajectory(by903['T-103'])}`);

// (d) needs_fix_rounds: 4 and no pass keyword -> skipped, 0.8 - 0.1*3 = 0.5.
assert.strictEqual(by903['T-104'].qaOutcome, 'skipped',
  `T-903 (d) FAIL: expected outcome skipped, got ${by903['T-104'].qaOutcome}`);
assert.strictEqual(scoreTrajectory(by903['T-104']), 0.5,
  `T-903 (d) FAIL: expected score 0.5, got ${scoreTrajectory(by903['T-104'])}`);

// (e) validator_blocked: true and no pass keyword -> 0.8 - 0.2 = 0.6.
assert.strictEqual(scoreTrajectory(by903['T-105']), 0.6,
  `T-903 (e) FAIL: expected score 0.6, got ${scoreTrajectory(by903['T-105'])}`);

// (f) The words "outside scope" still yield the scope_deviation flag (flags
// other than evidence_error are unchanged).
assert.ok(by903['T-106'].evidenceFlags.includes('scope_deviation'),
  `T-903 (f) FAIL: expected scope_deviation flag, got ${JSON.stringify(by903['T-106'].evidenceFlags)}`);

fs.rmSync(TMP_DIR_903, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-560 and T-903 assertions passed.');
