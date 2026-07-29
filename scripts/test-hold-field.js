'use strict';
// Regression test: T-496 — DR-005 Hold: field (parsing, --agent/--snapshot
// surfacing, scoped downgrade).
//
// Covers:
//   1. parseHold()/isHoldEmpty() (mavp-operator-lib.js): well-formed parse,
//      placeholder emptiness, and tolerant (non-throwing, non-finding)
//      handling of a malformed value.
//   2. HOLD_DOWNGRADABLE_CHECKS (mavp-validator.js) is a WHITELIST containing
//      exactly `blocked_by_open` — none of the six DR-005 never-downgrade
//      check names are members.
//   3. applyHoldDowngrade() positive case: a warning-severity blocked_by_open
//      finding on a held task is downgraded to info.
//   4. applyHoldDowngrade() strict reading: a FAILURE-severity finding is
//      NEVER downgraded, even when it's the whitelisted check and the task
//      carries a Hold: — this is the merged x unmerged-blocker tier.
//   5. applyHoldDowngrade() control: a task with no Hold: is unaffected.
//   6. Six negative tests (one per DR-005 never-downgrade item) — a held
//      task's merged_missing_commit_field / cross_repo_missing_evidence
//      (evidence-completeness) / status_mismatch (mirror/sync-status) /
//      duplicate_active_task (duplicate-entry detection) /
//      config_check_missing / stale_risk_unverified finding is untouched by
//      applyHoldDowngrade(). Each asserts the real severity is unchanged, so
//      widening HOLD_DOWNGRADABLE_CHECKS to include that check name would
//      make the corresponding assertion fail.
//   7. Full-stack: parseArtifacts() against a synthetic BACKLOG.md/
//      TASK_STATUS.md/docs/REPO_MAP.md fixture (+ sibling repo dirs)
//      reproduces every never-downgrade finding above through the REAL check
//      functions (not synthetic finding objects), confirms the blocked_by_open
//      positive downgrade and no-Hold control end to end, and confirms the
//      merged x unmerged-blocker x Hold: interaction still exits 2.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { isHoldEmpty, parseHold } = require('./mavp-operator-lib.js');
const {
  applyHoldDowngrade,
  HOLD_DOWNGRADABLE_CHECKS,
  parseArtifacts,
  getExitCode,
} = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't496-hold-field-'));

// ---------------------------------------------------------------------------
// Test 1: parseHold() / isHoldEmpty() parsing behavior.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(isHoldEmpty(null), true, 'Test 1a FAIL: null should be empty');
  assert.strictEqual(isHoldEmpty(''), true, 'Test 1b FAIL: empty string should be empty');
  assert.strictEqual(isHoldEmpty('—'), true, 'Test 1c FAIL: em-dash placeholder should be empty');
  assert.strictEqual(isHoldEmpty('-'), true, 'Test 1d FAIL: hyphen placeholder should be empty');
  assert.strictEqual(parseHold(null), null, 'Test 1e FAIL: parseHold(null) should be null');
  assert.strictEqual(parseHold('—'), null, 'Test 1f FAIL: parseHold("—") should be null');

  const wellFormed = parseHold('prod — waiting on a coordinated deploy window (2026-07-24)');
  assert.deepStrictEqual(
    wellFormed,
    { what: 'prod', why: 'waiting on a coordinated deploy window', since: '2026-07-24', raw: 'prod — waiting on a coordinated deploy window (2026-07-24)' },
    `Test 1g FAIL: well-formed Hold: did not parse as expected, got: ${JSON.stringify(wellFormed)}`
  );

  // Malformed value (no " — " separator, no trailing "(since)"): tolerated,
  // not rejected — DR-005 makes Hold: optional and forbids treating its
  // absence as a finding; a malformed-but-present value gets the same
  // no-punishment treatment rather than becoming a new way to fail.
  const malformed = parseHold('just a plain note with no structure');
  assert.strictEqual(malformed.what, 'just a plain note with no structure', 'Test 1h FAIL: malformed value should fall back to the whole string as "what"');
  assert.strictEqual(malformed.why, null, 'Test 1h FAIL: malformed value should have null "why"');
  assert.strictEqual(malformed.since, null, 'Test 1h FAIL: malformed value should have null "since"');

  console.log('Test 1 passed: parseHold()/isHoldEmpty() parse well-formed values and tolerate malformed ones without throwing or rejecting');
}

// ---------------------------------------------------------------------------
// Test 2: HOLD_DOWNGRADABLE_CHECKS is a whitelist containing EXACTLY
// blocked_by_open — none of the six DR-005 never-downgrade check names are
// members, by construction (not by a separate blacklist check).
// ---------------------------------------------------------------------------
{
  const NEVER_DOWNGRADE_CHECKS = [
    'merged_missing_commit_field',
    'cross_repo_missing_evidence',
    'status_mismatch',
    'title_mismatch',
    'missing_in_backlog',
    'missing_in_task_status',
    'duplicate_active_task',
    'duplicate_task_id',
    'duplicate_task_status_entry',
    'config_check_missing',
    'stale_risk_unverified',
  ];

  assert.ok(HOLD_DOWNGRADABLE_CHECKS instanceof Set, 'Test 2 FAIL: HOLD_DOWNGRADABLE_CHECKS must be a Set');
  assert.strictEqual(HOLD_DOWNGRADABLE_CHECKS.size, 1, 'Test 2 FAIL: whitelist should contain exactly one entry today');
  assert.ok(HOLD_DOWNGRADABLE_CHECKS.has('blocked_by_open'), 'Test 2 FAIL: whitelist must include blocked_by_open');

  for (const checkName of NEVER_DOWNGRADE_CHECKS) {
    assert.ok(!HOLD_DOWNGRADABLE_CHECKS.has(checkName), `Test 2 FAIL: whitelist must NOT include "${checkName}"`);
  }

  console.log('Test 2 passed: HOLD_DOWNGRADABLE_CHECKS is a whitelist containing exactly blocked_by_open');
}

// ---------------------------------------------------------------------------
// Test 3 (positive): applyHoldDowngrade() downgrades a warning-severity
// blocked_by_open finding on a held task to info.
// ---------------------------------------------------------------------------
{
  const findings = [{ checkName: 'blocked_by_open', taskId: 'T-1', severity: 'warning' }];
  const holdRecords = [{ taskId: 'T-1', hold: 'prod — waiting on a coordinated deploy window (2026-07-24)' }];

  const count = applyHoldDowngrade(findings, holdRecords);

  assert.strictEqual(count, 1, 'Test 3 FAIL: expected exactly 1 finding downgraded');
  assert.strictEqual(findings[0].severity, 'info', 'Test 3 FAIL: expected severity downgraded to info');
  assert.strictEqual(findings[0].holdDowngraded, true, 'Test 3 FAIL: expected holdDowngraded: true to be recorded on the finding');

  console.log('Test 3 passed: applyHoldDowngrade() downgrades an in-scope WARNING finding to INFO on a held task');
}

// ---------------------------------------------------------------------------
// Test 4 (strict reading): applyHoldDowngrade() NEVER downgrades a
// FAILURE-severity finding, even for the whitelisted check name and even
// when the task carries a Hold: — this is the merged x unmerged-blocker tier
// (DR-005: a Hold: explains a wait, it is not permission to ship ahead of an
// unmet dependency).
// ---------------------------------------------------------------------------
{
  const findings = [{ checkName: 'blocked_by_open', taskId: 'T-2', severity: 'failure' }];
  const holdRecords = [{ taskId: 'T-2', hold: 'prod — waiting on a coordinated deploy window (2026-07-24)' }];

  const count = applyHoldDowngrade(findings, holdRecords);

  assert.strictEqual(count, 0, 'Test 4 FAIL: expected 0 findings downgraded');
  assert.strictEqual(findings[0].severity, 'failure', 'Test 4 FAIL: FAILURE severity must never be downgraded by a Hold:');
  assert.strictEqual(findings[0].holdDowngraded, undefined, 'Test 4 FAIL: holdDowngraded must not be set on an untouched finding');

  console.log('Test 4 passed: applyHoldDowngrade() never downgrades a FAILURE-severity finding, even in-scope and even with a Hold: present');
}

// ---------------------------------------------------------------------------
// Test 5 (control): applyHoldDowngrade() leaves a task with no Hold:
// completely unaffected.
// ---------------------------------------------------------------------------
{
  const findings = [{ checkName: 'blocked_by_open', taskId: 'T-3', severity: 'warning' }];
  const count = applyHoldDowngrade(findings, []);

  assert.strictEqual(count, 0, 'Test 5 FAIL: expected 0 findings downgraded with no Hold: records');
  assert.strictEqual(findings[0].severity, 'warning', 'Test 5 FAIL: severity must be unchanged with no Hold:');

  console.log('Test 5 passed: applyHoldDowngrade() is a no-op for a task with no Hold: (unaffected control)');
}

// ---------------------------------------------------------------------------
// Test 6 (six negative tests): a held task's finding for each DR-005
// never-downgrade check name is untouched by applyHoldDowngrade(). Each
// sub-test would FAIL if HOLD_DOWNGRADABLE_CHECKS were later widened to
// include that check name — that is the whole point of these six.
// ---------------------------------------------------------------------------
{
  const NEVER_DOWNGRADE_CASES = [
    { checkName: 'merged_missing_commit_field', severity: 'failure', label: 'merged_missing_commit_field' },
    { checkName: 'cross_repo_missing_evidence', severity: 'warning', label: 'evidence-completeness (cross_repo_missing_evidence)' },
    { checkName: 'status_mismatch', severity: 'failure', label: 'mirror/sync-status (status_mismatch)' },
    { checkName: 'duplicate_active_task', severity: 'failure', label: 'duplicate-entry detection (duplicate_active_task)' },
    { checkName: 'config_check_missing', severity: 'warning', label: 'config_check (config_check_missing)' },
    { checkName: 'stale_risk_unverified', severity: 'warning', label: 'stale_verified (stale_risk_unverified)' },
  ];

  for (const [i, testCase] of NEVER_DOWNGRADE_CASES.entries()) {
    const taskId = `T-6${i}0`;
    const findings = [{ checkName: testCase.checkName, taskId, severity: testCase.severity }];
    const holdRecords = [{ taskId, hold: 'staging — deliberately held for this test (2026-07-25)' }];

    const count = applyHoldDowngrade(findings, holdRecords);

    assert.strictEqual(count, 0, `Test 6.${i + 1} FAIL: ${testCase.label} must not be downgraded — expected 0 downgrades`);
    assert.strictEqual(findings[0].severity, testCase.severity, `Test 6.${i + 1} FAIL: ${testCase.label} severity changed from ${testCase.severity} — a Hold: must never touch this check`);
    assert.strictEqual(findings[0].holdDowngraded, undefined, `Test 6.${i + 1} FAIL: ${testCase.label} must not be flagged holdDowngraded`);

    console.log(`Test 6.${i + 1} passed: a held task's ${testCase.label} finding is untouched by applyHoldDowngrade()`);
  }
}

// ---------------------------------------------------------------------------
// Full-stack fixture: BACKLOG.md/TASK_STATUS.md/docs/REPO_MAP.md + sibling
// repo dirs, reproducing every never-downgrade case above via the REAL check
// functions (compareRecords/checkConfigCheck/etc., not synthetic finding
// objects), plus the blocked_by_open positive/control/strict-merged cases.
// ---------------------------------------------------------------------------
function siblingFixture(root, taskId, status) {
  fs.mkdirSync(root, { recursive: true });
  const body = `### ${taskId} — Sibling blocker task\n\n- **Status:** ${status}\n- **Owner role:** developer\n- **Verification type:** unit\n`;
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), `# BACKLOG\n\n## Active Wave\n\n${body}`, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS\n\n## Active tasks\n\n${body}\n## Recently completed tasks\n`, 'utf8');
}

function withProjectRoot(root, fn) {
  const original = process.env.MAVERICKS_PROJECT_ROOT;
  process.env.MAVERICKS_PROJECT_ROOT = root;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.MAVERICKS_PROJECT_ROOT;
    else process.env.MAVERICKS_PROJECT_ROOT = original;
  }
}

{
  const mainRoot = path.join(TMP_DIR, 'full-stack');
  const sib960 = path.join(TMP_DIR, 'sibling-960');
  const sib961 = path.join(TMP_DIR, 'sibling-961');
  const sib962 = path.join(TMP_DIR, 'sibling-962');
  siblingFixture(sib960, 'T-500', 'in_progress');
  siblingFixture(sib961, 'T-501', 'in_progress');
  siblingFixture(sib962, 'T-502', 'in_progress');

  const HOLD_LINE = '- **Hold:** staging — waiting on a coordinated window (2026-07-24)';

  fs.mkdirSync(mainRoot, { recursive: true });
  fs.mkdirSync(path.join(mainRoot, 'docs'), { recursive: true });

  fs.writeFileSync(path.join(mainRoot, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-950 — mirror check target (missing_in_task_status)
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
${HOLD_LINE}

### T-951 — duplicate entry target
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
${HOLD_LINE}

### T-951 — duplicate entry target (second copy)
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit

### T-952 — config check target
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
- **Requires config check:** true
${HOLD_LINE}

### T-953 — stale risk target
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
- **Stale risk:** true
${HOLD_LINE}

### T-954 — cross-repo evidence target
- **Status:** merged
- **Owner role:** developer
- **Repos:** repo-a, repo-b
- **Verification type:** unit
${HOLD_LINE}

### T-955 — merged missing commit target
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
${HOLD_LINE}

### T-960 — blocked_by positive downgrade (qa_passed + Hold)
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
- **Blocked by:** sibling-repo-960/T-500
${HOLD_LINE}

### T-961 — blocked_by control (no Hold)
- **Status:** ready_for_qa
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
- **Blocked by:** sibling-repo-961/T-501

### T-962 — blocked_by strict merged + Hold (never downgraded)
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
- **Blocked by:** sibling-repo-962/T-502
${HOLD_LINE}
`, 'utf8');

  fs.writeFileSync(path.join(mainRoot, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-951 — duplicate entry target
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —

### T-952 — config check target
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: aaa1111

### T-953 — stale risk target
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: bbb2222 branch: main

### T-954 — cross-repo evidence target
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: ccc3333 (repo-a)

### T-955 — merged missing commit target
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —

### T-960 — blocked_by positive downgrade (qa_passed + Hold)
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —

### T-961 — blocked_by control (no Hold)
- **Status:** ready_for_qa
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —

### T-962 — blocked_by strict merged + Hold (never downgraded)
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** commit: ddd4444

## Recently completed tasks
`, 'utf8');

  fs.writeFileSync(path.join(mainRoot, 'docs', 'REPO_MAP.md'), `# Repo Map

## sibling-repo-960

- **label:** Sibling Repo 960
- **path:** ${sib960}

## sibling-repo-961

- **label:** Sibling Repo 961
- **path:** ${sib961}

## sibling-repo-962

- **label:** Sibling Repo 962
- **path:** ${sib962}
`, 'utf8');

  const parsed = withProjectRoot(mainRoot, () =>
    parseArtifacts({
      backlogPath: path.join(mainRoot, 'BACKLOG.md'),
      taskStatusPath: path.join(mainRoot, 'TASK_STATUS.md'),
    })
  );

  const findByTask = (checkName, taskId) =>
    parsed.comparison.findings.find((f) => f.checkName === checkName && f.taskId === taskId);

  // --- Six never-downgrade findings, all on tasks carrying a Hold: field ---
  const f950 = findByTask('missing_in_task_status', 'T-950');
  assert.ok(f950, `Full-stack FAIL: expected missing_in_task_status for held T-950, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f950.severity, 'failure', 'Full-stack FAIL: missing_in_task_status severity must stay failure on a held task');
  assert.strictEqual(f950.holdDowngraded, undefined, 'Full-stack FAIL: missing_in_task_status must not be flagged holdDowngraded');

  const f951 = findByTask('duplicate_active_task', 'T-951') || findByTask('duplicate_task_id', 'T-951');
  assert.ok(f951, `Full-stack FAIL: expected a duplicate-entry finding for held T-951, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f951.holdDowngraded, undefined, 'Full-stack FAIL: duplicate-entry finding must not be flagged holdDowngraded');

  const f952 = findByTask('config_check_missing', 'T-952');
  assert.ok(f952, `Full-stack FAIL: expected config_check_missing for held T-952, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f952.severity, 'warning', 'Full-stack FAIL: config_check_missing severity must stay warning on a held task');
  assert.strictEqual(f952.holdDowngraded, undefined, 'Full-stack FAIL: config_check_missing must not be flagged holdDowngraded');

  const f953 = findByTask('stale_risk_unverified', 'T-953');
  assert.ok(f953, `Full-stack FAIL: expected stale_risk_unverified for held T-953, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f953.severity, 'warning', 'Full-stack FAIL: stale_risk_unverified severity must stay warning on a held task');
  assert.strictEqual(f953.holdDowngraded, undefined, 'Full-stack FAIL: stale_risk_unverified must not be flagged holdDowngraded');

  const f954 = findByTask('cross_repo_missing_evidence', 'T-954');
  assert.ok(f954, `Full-stack FAIL: expected cross_repo_missing_evidence for held T-954, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f954.severity, 'warning', 'Full-stack FAIL: cross_repo_missing_evidence severity must stay warning on a held task');
  assert.strictEqual(f954.holdDowngraded, undefined, 'Full-stack FAIL: cross_repo_missing_evidence must not be flagged holdDowngraded');

  const f955 = findByTask('merged_missing_commit_field', 'T-955');
  assert.ok(f955, `Full-stack FAIL: expected merged_missing_commit_field for held T-955, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(f955.severity, 'failure', 'Full-stack FAIL: merged_missing_commit_field severity must stay failure on a held task');
  assert.strictEqual(f955.holdDowngraded, undefined, 'Full-stack FAIL: merged_missing_commit_field must not be flagged holdDowngraded');

  // --- blocked_by_open: positive downgrade, control, strict-merged ---
  const f960 = findByTask('blocked_by_open', 'T-960');
  assert.ok(f960, 'Full-stack FAIL: expected blocked_by_open for T-960');
  assert.strictEqual(f960.severity, 'info', 'Full-stack FAIL: T-960 (qa_passed + Hold, in-scope check) should be downgraded from warning to info');
  assert.strictEqual(f960.holdDowngraded, true, 'Full-stack FAIL: T-960 should be flagged holdDowngraded');

  const f961 = findByTask('blocked_by_open', 'T-961');
  assert.ok(f961, 'Full-stack FAIL: expected blocked_by_open for T-961');
  assert.strictEqual(f961.severity, 'warning', 'Full-stack FAIL: T-961 (no Hold:) must stay at its normal warning tier — unaffected control');
  assert.strictEqual(f961.holdDowngraded, undefined, 'Full-stack FAIL: T-961 must not be flagged holdDowngraded');

  const f962 = findByTask('blocked_by_open', 'T-962');
  assert.ok(f962, 'Full-stack FAIL: expected blocked_by_open for T-962');
  assert.strictEqual(f962.severity, 'failure', 'Full-stack FAIL: T-962 (merged + unmerged blocker + Hold:) must stay FAILURE — a Hold: explains a wait, not permission to ship ahead of a dependency');
  assert.strictEqual(f962.holdDowngraded, undefined, 'Full-stack FAIL: T-962 must not be flagged holdDowngraded');

  assert.strictEqual(getExitCode(parsed.comparison.overallCandidateState), 2, 'Full-stack FAIL: expected exit code 2 (failures present: missing_in_task_status, merged_missing_commit_field, blocked_by_open on T-962)');

  console.log('Full-stack test passed: real check functions still produce every never-downgrade finding on held tasks; blocked_by_open downgrades only the in-scope, non-failure, held case; merged x unmerged-blocker x Hold: stays FAILURE/exit 2');
}

console.log('\nAll T-496 assertions passed.');
