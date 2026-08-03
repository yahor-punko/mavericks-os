'use strict';
// Regression test: T-593 — getNextTaskId() heading-anchoring + mint-time
// tripwire (wave-72 incident: an un-anchored `/###\s+T-(\d+)/g` matched a
// backticked heading-shaped `T-900` citation sitting mid-prose in a task's
// Problem field, minting T-901 instead of the real next ID and burning the
// 592-900 range via updateLastTaskId()).
//
// Covers:
//   1. (red run, quoted in the T-593 report, not reproduced here — pre-fix
//      code is gone once this fix lands) + green run: a fixture whose real
//      max heading is T-010 plus a backticked heading-shaped `### T-900`
//      citation mid-prose returns T-011 under the anchored regex.
//   2. Duplicate-avoidance is preserved: a fixture with a REAL line-initial
//      `### T-900` heading (hand-registered, no matching last_task_id bump)
//      still returns T-901 (files-max keeps winning), AND the mint-time
//      tripwire fires, naming both the file-scan max and the state max.
//   3. The tripwire does NOT fire when PROCESS_STATE.json is absent (fresh/
//      adopter repo — maxFromState stays 0) or when the two sources agree.
//
// Residual (documented, not hidden): a line-initial heading shape inside a
// FENCED CODE BLOCK still matches — this is a plain line-based scan with no
// fence-tracking, the same fence-blindness shared by every line-based parser
// in this repo (including the validator's block parsers). That residual is
// covered by the mint-time tripwire in test 2 above, not by the regex.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { getNextTaskId } = require('./mavp-operator-lib.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't593-task-id-allocator-'));

// Captures everything written to process.stderr.write() during fn(), then
// restores the original writer regardless of outcome.
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function writeFixture(dir, { backlog, taskStatus, processState }) {
  fs.mkdirSync(dir, { recursive: true });
  const backlogPath = path.join(dir, 'BACKLOG.md');
  const taskStatusPath = path.join(dir, 'TASK_STATUS.md');
  const processStatePath = path.join(dir, 'PROCESS_STATE.json');
  fs.writeFileSync(backlogPath, backlog, 'utf8');
  fs.writeFileSync(taskStatusPath, taskStatus, 'utf8');
  if (processState !== null) {
    fs.writeFileSync(processStatePath, JSON.stringify(processState), 'utf8');
  }
  return { backlogPath, taskStatusPath, processStatePath };
}

// ---------------------------------------------------------------------------
// Test 1 (green run): real max heading T-010, plus a backticked
// heading-shaped citation mid-prose (never line-initial — the citation sits
// inside a `- **Problem:**` bullet, not at column 0). Anchored regex must
// ignore the mid-prose citation entirely and return T-011.
//
// The RED run against pre-fix code (un-anchored `/###\s+T-(\d+)/g`) returned
// T-901 for this exact fixture — that is the live wave-72 reproduction,
// quoted in the T-593 completion report rather than re-executed here, since
// the pre-fix regex no longer exists in this file to run against.
// ---------------------------------------------------------------------------
{
  const dir1 = path.join(TMP_DIR, 'fixture-1-midprose-citation');
  const midProseCitation =
    'An architect fixture cited a backticked heading-shaped `### T-900` ' +
    'example twice mid-prose, once here and once more in this same ' +
    'sentence: `### T-900` — this is the wave-72 incident shape.';
  const { backlogPath, taskStatusPath, processStatePath } = writeFixture(dir1, {
    backlog: `# BACKLOG\n\n## Active Wave\n\n### T-010 — real max heading\n- **Status:** planned\n- **Problem:** ${midProseCitation}\n`,
    taskStatus: `# TASK_STATUS\n\n## Active tasks\n\n### T-010 — real max heading\n- **Status:** planned\n- **Evidence:** —\n\n## Recently completed tasks\n`,
    processState: { last_task_id: 10 },
  });

  const id = getNextTaskId(backlogPath, taskStatusPath, processStatePath);
  assert.strictEqual(id, 'T-011', `Test 1 FAIL: expected T-011 (real max T-010 + 1), got ${id}`);

  console.log('Test 1 passed: anchored regex ignores a backticked heading-shaped citation sitting mid-prose and returns T-011 (green run; pre-fix red run returned T-901, quoted in the T-593 report)');
}

// ---------------------------------------------------------------------------
// Test 2: duplicate-avoidance preserved. A REAL line-initial `### T-900`
// heading (hand-registered, last_task_id not bumped to match) still returns
// T-901 — files-max must keep winning the max() — AND the tripwire fires,
// naming both values.
// ---------------------------------------------------------------------------
{
  const dir2 = path.join(TMP_DIR, 'fixture-2-real-heading-drift');
  const { backlogPath, taskStatusPath, processStatePath } = writeFixture(dir2, {
    backlog: `# BACKLOG\n\n## Active Wave\n\n### T-900 — hand-registered, no state bump\n- **Status:** planned\n`,
    taskStatus: `# TASK_STATUS\n\n## Active tasks\n\n### T-900 — hand-registered, no state bump\n- **Status:** planned\n- **Evidence:** —\n\n## Recently completed tasks\n`,
    processState: { last_task_id: 10 },
  });

  let id;
  const stderrOutput = captureStderr(() => {
    id = getNextTaskId(backlogPath, taskStatusPath, processStatePath);
  });

  assert.strictEqual(id, 'T-901', `Test 2 FAIL: expected T-901 (files-max wins over state), got ${id}`);
  assert.ok(stderrOutput.includes('900'), `Test 2 FAIL: tripwire output must name the file-scan max (900), got: ${stderrOutput}`);
  assert.ok(stderrOutput.includes('10'), `Test 2 FAIL: tripwire output must name the state max (10), got: ${stderrOutput}`);

  console.log(`Test 2 passed: a real line-initial T-900 heading with a stale last_task_id (10) still returns T-901 (duplicate-avoidance preserved) AND fires the tripwire naming both values — captured stderr: ${JSON.stringify(stderrOutput.trim())}`);
}

// ---------------------------------------------------------------------------
// Test 3a: tripwire does NOT fire when PROCESS_STATE.json is absent (fresh/
// adopter repo — maxFromState stays 0). Same file-scan shape as test 2.
// ---------------------------------------------------------------------------
{
  const dir3a = path.join(TMP_DIR, 'fixture-3a-no-state');
  const { backlogPath, taskStatusPath, processStatePath } = writeFixture(dir3a, {
    backlog: `# BACKLOG\n\n## Active Wave\n\n### T-900 — no PROCESS_STATE.json at all\n- **Status:** planned\n`,
    taskStatus: `# TASK_STATUS\n\n## Active tasks\n\n### T-900 — no PROCESS_STATE.json at all\n- **Status:** planned\n- **Evidence:** —\n\n## Recently completed tasks\n`,
    processState: null,
  });
  assert.ok(!fs.existsSync(processStatePath), 'Test 3a setup FAIL: PROCESS_STATE.json should not exist for this fixture');

  let id;
  const stderrOutput = captureStderr(() => {
    id = getNextTaskId(backlogPath, taskStatusPath, processStatePath);
  });

  assert.strictEqual(id, 'T-901', `Test 3a FAIL: expected T-901 (files-max only, no state), got ${id}`);
  assert.strictEqual(stderrOutput, '', `Test 3a FAIL: tripwire must NOT fire when PROCESS_STATE.json is absent, got: ${stderrOutput}`);

  console.log('Test 3a passed: tripwire does NOT fire when PROCESS_STATE.json is absent (maxFromState stays 0)');
}

// ---------------------------------------------------------------------------
// Test 3b: tripwire does NOT fire when the two sources agree
// (maxFromFiles === maxFromState).
// ---------------------------------------------------------------------------
{
  const dir3b = path.join(TMP_DIR, 'fixture-3b-agreeing-state');
  const { backlogPath, taskStatusPath, processStatePath } = writeFixture(dir3b, {
    backlog: `# BACKLOG\n\n## Active Wave\n\n### T-010 — files and state agree\n- **Status:** planned\n`,
    taskStatus: `# TASK_STATUS\n\n## Active tasks\n\n### T-010 — files and state agree\n- **Status:** planned\n- **Evidence:** —\n\n## Recently completed tasks\n`,
    processState: { last_task_id: 10 },
  });

  let id;
  const stderrOutput = captureStderr(() => {
    id = getNextTaskId(backlogPath, taskStatusPath, processStatePath);
  });

  assert.strictEqual(id, 'T-011', `Test 3b FAIL: expected T-011, got ${id}`);
  assert.strictEqual(stderrOutput, '', `Test 3b FAIL: tripwire must NOT fire when files and state agree, got: ${stderrOutput}`);

  console.log('Test 3b passed: tripwire does NOT fire when maxFromFiles equals maxFromState (agreeing sources)');
}

console.log('\nAll T-593 assertions passed.');
