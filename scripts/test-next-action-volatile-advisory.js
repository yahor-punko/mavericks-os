'use strict';
// Regression test: T-351 — next_action_volatile_facts validator advisory.
//
// Fixture-based: builds a synthetic BACKLOG.md + TASK_STATUS.md + PROCESS_STATE.json
// triple (no active tasks — the check under test reads PROCESS_STATE.json
// next_action independently) and runs the validator's parseArtifacts() against
// each fixture variant, asserting:
//   1. next_action with embedded volatile facts ("v0.25.0", "14 commits unpushed")
//      produces a next_action_volatile_facts finding at info severity, and the
//      exit code stays at the fixture's healthy baseline (0) — info never blocks.
//   2. next_action as a clean routing directive ("T-123 -> developer -> fix parser")
//      produces no finding.
//   3. next_action null / missing produces no finding and does not crash.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const { parseArtifacts, getExitCode } = require('./mavp-validator.js');

const TMP_DIR = path.join(os.tmpdir(), 't351-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave
`;

const TASK_STATUS_FIXTURE = `# TASK_STATUS

## Active tasks

## Recently completed tasks
`;

function writeFixture({ backlogPath, taskStatusPath, processStatePath, processState }) {
  fs.writeFileSync(backlogPath, BACKLOG_FIXTURE, 'utf8');
  fs.writeFileSync(taskStatusPath, TASK_STATUS_FIXTURE, 'utf8');
  if (processState !== undefined) {
    fs.writeFileSync(processStatePath, JSON.stringify(processState, null, 2), 'utf8');
  }
}

function runFixture(caseName, processState) {
  const caseDir = path.join(TMP_DIR, caseName);
  fs.mkdirSync(caseDir, { recursive: true });
  const backlogPath = path.join(caseDir, 'BACKLOG.md');
  const taskStatusPath = path.join(caseDir, 'TASK_STATUS.md');
  const processStatePath = path.join(caseDir, 'PROCESS_STATE.json');
  writeFixture({ backlogPath, taskStatusPath, processStatePath, processState });
  return parseArtifacts({ backlogPath, taskStatusPath });
}

// ---------------------------------------------------------------------------
// Test 1: next_action embeds volatile facts -> finding emitted at info
// severity, and exit code stays at the fixture's healthy baseline (0).
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('volatile', {
    next_action: 'Bumped framework to v0.25.0 after landing 14 commits unpushed to origin — remember to push.',
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.ok(
    finding,
    `Test 1 FAIL: expected a next_action_volatile_facts finding, got findings: ${JSON.stringify(findings, null, 2)}`
  );
  assert.strictEqual(
    finding.severity,
    'info',
    `Test 1 FAIL: next_action_volatile_facts severity should be "info", got: "${finding.severity}"`
  );
  assert.ok(
    /v0\.25\.0/.test(finding.message) && /14 commits/i.test(finding.message),
    `Test 1 FAIL: message should name the matched volatile facts, got: "${finding.message}"`
  );

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(
    exitCode,
    0,
    `Test 1 FAIL: info finding must not change exit code from the fixture's healthy baseline (0), got: ${exitCode}`
  );
  assert.strictEqual(
    parsed.comparison.overallCandidateState,
    'healthy',
    `Test 1 FAIL: overallCandidateState should remain "healthy" (info never blocks), got: "${parsed.comparison.overallCandidateState}"`
  );

  console.log('Test 1 passed: volatile facts in next_action produce an info-severity finding without changing exit code');
}

// ---------------------------------------------------------------------------
// Test 2: next_action is a clean routing directive -> no finding.
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('directive', {
    next_action: 'T-123 -> developer -> fix parser',
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.strictEqual(
    finding,
    undefined,
    `Test 2 FAIL: expected no next_action_volatile_facts finding for a clean directive, got: ${JSON.stringify(finding, null, 2)}`
  );

  console.log('Test 2 passed: clean routing directive produces no finding');
}

// ---------------------------------------------------------------------------
// Test 3: next_action is null -> no finding, no crash.
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('null-next-action', {
    next_action: null,
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.strictEqual(
    finding,
    undefined,
    `Test 3 FAIL: expected no next_action_volatile_facts finding for null next_action, got: ${JSON.stringify(finding, null, 2)}`
  );

  console.log('Test 3 passed: null next_action produces no finding and does not crash');
}

// ---------------------------------------------------------------------------
// Test 4: PROCESS_STATE.json missing entirely (no next_action field at all) ->
// no finding, no crash.
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('missing-process-state', undefined);
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.strictEqual(
    finding,
    undefined,
    `Test 4 FAIL: expected no next_action_volatile_facts finding when PROCESS_STATE.json is absent, got: ${JSON.stringify(finding, null, 2)}`
  );

  console.log('Test 4 passed: missing PROCESS_STATE.json produces no finding and does not crash');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-351 assertions passed.');
