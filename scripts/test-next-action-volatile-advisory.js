'use strict';
// Regression test: T-351 — next_action_volatile_facts validator advisory.
// Escalated to FAILURE severity by T-628 (RC-1,
// docs/rca/2026-08-operator-channel-state-artifacts.md) once
// classifyNextAction() was narrowed to volatile-FACT POSITION in the same
// task — see scripts/test-next-action-classify.js Cases G/H/I for the
// classifier-level narrowing coverage this test does not duplicate.
//
// Fixture-based: builds a synthetic BACKLOG.md + TASK_STATUS.md + PROCESS_STATE.json
// triple (no active tasks — the check under test reads PROCESS_STATE.json
// next_action independently) and runs the validator's parseArtifacts() against
// each fixture variant, asserting:
//   1. next_action with an embedded state-assertion volatile fact ("v0.25.0"
//      asserted as current state) plus a commit-count phrase ("14 commits
//      unpushed") produces a next_action_volatile_facts finding at FAILURE
//      severity, and the exit code escalates to 2 (repair required) — this
//      now blocks, which is the whole point of T-628.
//   2. next_action as a clean routing directive ("T-123 -> developer -> fix parser")
//      produces no finding.
//   3. next_action null / missing produces no finding and does not crash.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const { parseArtifacts, getExitCode } = require('./mavp-validator.js');
const { ACTION_TARGET_FOLLOWER_NOUNS } = require('./mavp-operator-lib.js');

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
// Test 1: next_action embeds volatile facts -> finding emitted at FAILURE
// severity, and exit code escalates to 2 (repair required).
//
// Fixture text uses "is now at v0.25.0" (a state-assertion form) rather than
// "to v0.25.0" — under T-628's position-based narrowing, "to X" is an
// ACTION_TARGET_PRECEDER (the "<verb> to X" construction) and would no
// longer flag; "is ... at X" is a STATE_ASSERTION_PRECEDER and correctly
// still does. See scripts/test-next-action-classify.js Cases G/H/I.
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('volatile', {
    next_action: 'The framework is now at v0.25.0 after landing 14 commits unpushed to origin — remember to push.',
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.ok(
    finding,
    `Test 1 FAIL: expected a next_action_volatile_facts finding, got findings: ${JSON.stringify(findings, null, 2)}`
  );
  assert.strictEqual(
    finding.severity,
    'failure',
    `Test 1 FAIL: next_action_volatile_facts severity should be "failure", got: "${finding.severity}"`
  );
  assert.ok(
    /v0\.25\.0/.test(finding.message) && /14 commits/i.test(finding.message),
    `Test 1 FAIL: message should name the matched volatile facts, got: "${finding.message}"`
  );

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(
    exitCode,
    2,
    `Test 1 FAIL: failure finding must escalate exit code to 2 (repair required), got: ${exitCode}`
  );
  assert.strictEqual(
    parsed.comparison.overallCandidateState,
    'misleading_repair_required',
    `Test 1 FAIL: overallCandidateState should be "misleading_repair_required" (failure blocks), got: "${parsed.comparison.overallCandidateState}"`
  );

  console.log('Test 1 passed: volatile facts in next_action produce a failure-severity finding and escalate exit code to 2');
}

// ---------------------------------------------------------------------------
// Test 1b: an action-target version literal (narrowed clean by T-628) does
// NOT produce a finding, and the exit code stays at the fixture's healthy
// baseline (0) — the escalation must never fire on top of the old (too
// broad) matcher boundary.
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('action-target', {
    next_action: 'T-631 → developer → bump to 0.43.0 and open the CHANGELOG section',
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.strictEqual(
    finding,
    undefined,
    `Test 1b FAIL: expected no next_action_volatile_facts finding for an action-target directive, got: ${JSON.stringify(finding, null, 2)}`
  );

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(
    exitCode,
    0,
    `Test 1b FAIL: expected exit code 0 (healthy) for a legitimate action-target directive, got: ${exitCode}`
  );

  console.log('Test 1b passed: a legitimate action-target directive produces no finding and no exit-code escalation');
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
// Test 5 (T-694): suggestedAction derives its noun enumeration from
// ACTION_TARGET_FOLLOWER_NOUNS (mavp-operator-lib.js) — it must name every
// noun in that list (including the newly added "promotion"), and severity
// stays "failure" (unchanged by this task).
// ---------------------------------------------------------------------------
{
  const parsed = runFixture('suggested-action-nouns', {
    next_action: 'The framework is now at v0.25.0 after landing 14 commits unpushed to origin — remember to push.',
  });
  const findings = parsed.comparison.findings;
  const finding = findings.find((f) => f.checkName === 'next_action_volatile_facts');

  assert.ok(finding, 'Test 5 FAIL: expected a next_action_volatile_facts finding');
  assert.strictEqual(
    finding.severity,
    'failure',
    `Test 5 FAIL: severity must remain "failure" (unchanged by T-694), got: "${finding.severity}"`
  );
  for (const noun of ACTION_TARGET_FOLLOWER_NOUNS) {
    assert.ok(
      finding.suggestedAction.includes(noun),
      `Test 5 FAIL: expected suggestedAction to name noun "${noun}" from ACTION_TARGET_FOLLOWER_NOUNS, got: "${finding.suggestedAction}"`
    );
  }
  assert.ok(
    finding.suggestedAction.includes('promotion'),
    `Test 5 FAIL: expected suggestedAction to name the newly added "promotion" noun, got: "${finding.suggestedAction}"`
  );
  // States the actual grammar, not just "lead with the target noun".
  assert.ok(
    /immediately/i.test(finding.suggestedAction) && /state-assertion/i.test(finding.suggestedAction),
    `Test 5 FAIL: expected suggestedAction to state the adjacency + state-assertion-wins grammar, got: "${finding.suggestedAction}"`
  );
  console.log('Test 5 passed: suggestedAction names every noun in ACTION_TARGET_FOLLOWER_NOUNS (including "promotion") and describes the actual grammar; severity unchanged at "failure"');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-351/T-694 assertions passed.');
