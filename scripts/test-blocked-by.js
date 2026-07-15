'use strict';
// Regression test: T-393 — cross-repo Blocked by relation with validator merge gate.
//
// Covers:
//   1. parseBlockedBy() (mavp-operator-lib.js) parses `<repo>/T-NNN` tokens,
//      drops unparsable tokens (bare T-NNN, empty), and treats "—"/null as [].
//   2. checkBlockedBy() (mavp-validator.js) fires blocked_by_open at FAILURE
//      severity when a qa_passed/merged task's blocker is not merged.
//   3. checkBlockedBy() fires blocked_by_open at WARNING severity when the
//      blocked task is ready_for_qa.
//   4. checkBlockedBy() produces NO finding when the blocker is merged.
//   5. checkBlockedBy() fires blocked_by_unresolvable at INFO severity when
//      the repo id has no resolvable path, or the blocker task can't be
//      found in the resolved repo's BACKLOG.md/TASK_STATUS.md.
//   6. Full-stack: parseArtifacts() against synthetic BACKLOG.md/TASK_STATUS.md/
//      docs/REPO_MAP.md fixtures + sibling repo dirs (all in a temp dir — the
//      real mavericks repo is never touched) produces the expected exit code
//      via getExitCode() for the open/merged/unresolvable cases.
//   7. Depends on: parsing (backlogDeps in mavp-operator-agent.js's
//      computeNextAction()) is untouched — a sanity check confirms bare
//      T-NNN tokens are unaffected by parseBlockedBy().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { parseBlockedBy } = require('./mavp-operator-lib.js');
const {
  checkBlockedBy,
  parseArtifacts,
  parseBacklogAllActiveWaveTasks,
  getExitCode,
  getSeverityForCheck,
} = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't393-blocked-by-'));

// ---------------------------------------------------------------------------
// Test 1: parseBlockedBy() parsing behavior.
// ---------------------------------------------------------------------------
{
  assert.deepStrictEqual(
    parseBlockedBy('repo-a/T-100, repo-b/T-200'),
    [{ repo: 'repo-a', taskId: 'T-100' }, { repo: 'repo-b', taskId: 'T-200' }],
    'Test 1a FAIL: comma-separated <repo>/T-NNN tokens should parse to structured pairs'
  );

  assert.deepStrictEqual(parseBlockedBy(null), [], 'Test 1b FAIL: null should parse to []');
  assert.deepStrictEqual(parseBlockedBy('—'), [], 'Test 1c FAIL: placeholder "—" should parse to []');
  assert.deepStrictEqual(parseBlockedBy(''), [], 'Test 1d FAIL: empty string should parse to []');
  assert.deepStrictEqual(
    parseBlockedBy('T-999'),
    [],
    'Test 1e FAIL: a bare T-NNN token (no repo/ prefix) should be silently dropped'
  );

  console.log('Test 1 passed: parseBlockedBy() parses <repo>/T-NNN tokens and drops unparsable ones');
}

// ---------------------------------------------------------------------------
// Test 2 (sanity): Depends on: parsing is untouched by this change — bare
// T-NNN tokens still resolve for the same-repo dependency gate. We assert
// this indirectly: parseBlockedBy() (the NEW function) drops bare T-NNN,
// while the EXISTING Depends on: regex in mavp-operator-agent.js keeps them
// (that regex is untouched by this task — verified by inspection, not
// re-implemented here to avoid duplicating unrelated logic in this test file).
// ---------------------------------------------------------------------------
{
  const agentSource = fs.readFileSync(path.join(__dirname, 'mavp-operator-agent.js'), 'utf8');
  assert.ok(
    agentSource.includes("const depMatch = block.match(/^- \\*\\*Depends on:\\*\\*\\s+(.+)$/m);"),
    'Test 2 FAIL: expected the existing Depends on: field regex to still be present verbatim in mavp-operator-agent.js'
  );
  assert.ok(
    agentSource.includes("const deps = raw === '—' ? [] : raw.split(/[,\\s]+/).filter(d => /^T-\\d+$/.test(d));"),
    'Test 2 FAIL: expected the existing Depends on: token-split/filter logic to be unchanged in mavp-operator-agent.js'
  );

  console.log('Test 2 passed: Depends on: parsing in mavp-operator-agent.js is unchanged');
}

// ---------------------------------------------------------------------------
// Helper: build a fixture root with BACKLOG.md, TASK_STATUS.md, and
// docs/REPO_MAP.md, plus zero or more sibling repo dirs (each with their own
// BACKLOG.md/TASK_STATUS.md). Never touches the real mavericks repo.
// ---------------------------------------------------------------------------
function writeFixture(root, { backlog, taskStatus, repoMap }) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');
  if (repoMap != null) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'REPO_MAP.md'), repoMap, 'utf8');
  }
}

function siblingFixture(root, taskId, status) {
  fs.mkdirSync(root, { recursive: true });
  const body = `### ${taskId} — Sibling blocker task

- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** unit
`;
  fs.writeFileSync(
    path.join(root, 'BACKLOG.md'),
    `# BACKLOG\n\n## Active Wave\n\n${body}`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'TASK_STATUS.md'),
    `# TASK_STATUS\n\n## Active tasks\n\n${body}\n## Recently completed tasks\n`,
    'utf8'
  );
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

// ---------------------------------------------------------------------------
// Test 3: checkBlockedBy() direct unit test — FAILURE severity for a
// qa_passed task with an open (non-merged) cross-repo blocker.
// ---------------------------------------------------------------------------
{
  const siblingDir = path.join(TMP_DIR, 'unit-open-sibling');
  siblingFixture(siblingDir, 'T-500', 'in_progress');

  const records = [
    { taskId: 'T-600', status: 'qa_passed', blockedBy: 'sibling-repo/T-500' },
  ];
  const repoMap = { 'sibling-repo': { path: siblingDir } };

  const findings = checkBlockedBy(records, { repoMap });

  assert.strictEqual(findings.length, 1, `Test 3 FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
  const finding = findings[0];
  assert.strictEqual(finding.checkName, 'blocked_by_open', 'Test 3 FAIL: checkName mismatch');
  assert.strictEqual(finding.severity, 'failure', 'Test 3 FAIL: expected FAILURE severity for qa_passed blocked task');
  assert.strictEqual(finding.taskId, 'T-600', 'Test 3 FAIL: taskId mismatch');
  assert.ok(/sibling-repo\/T-500/.test(finding.message), 'Test 3 FAIL: message should name the blocker reference');

  console.log('Test 3 passed: checkBlockedBy() fires blocked_by_open at FAILURE severity for a qa_passed task with an open blocker');
}

// ---------------------------------------------------------------------------
// Test 4: checkBlockedBy() direct unit test — WARNING severity for a
// ready_for_qa task with an open cross-repo blocker.
// ---------------------------------------------------------------------------
{
  const siblingDir = path.join(TMP_DIR, 'unit-warning-sibling');
  siblingFixture(siblingDir, 'T-501', 'dev_done');

  const records = [
    { taskId: 'T-601', status: 'ready_for_qa', blockedBy: 'sibling-repo/T-501' },
  ];
  const repoMap = { 'sibling-repo': { path: siblingDir } };

  const findings = checkBlockedBy(records, { repoMap });

  assert.strictEqual(findings.length, 1, `Test 4 FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
  assert.strictEqual(findings[0].checkName, 'blocked_by_open', 'Test 4 FAIL: checkName mismatch');
  assert.strictEqual(findings[0].severity, 'warning', 'Test 4 FAIL: expected WARNING severity for ready_for_qa blocked task');

  console.log('Test 4 passed: checkBlockedBy() fires blocked_by_open at WARNING severity for a ready_for_qa task with an open blocker');
}

// ---------------------------------------------------------------------------
// Test 5: checkBlockedBy() direct unit test — NO finding when the blocker is
// merged.
// ---------------------------------------------------------------------------
{
  const siblingDir = path.join(TMP_DIR, 'unit-merged-sibling');
  siblingFixture(siblingDir, 'T-502', 'merged');

  const records = [
    { taskId: 'T-602', status: 'merged', blockedBy: 'sibling-repo/T-502' },
  ];
  const repoMap = { 'sibling-repo': { path: siblingDir } };

  const findings = checkBlockedBy(records, { repoMap });

  assert.strictEqual(findings.length, 0, `Test 5 FAIL: expected no findings when blocker is merged, got: ${JSON.stringify(findings)}`);

  console.log('Test 5 passed: checkBlockedBy() produces no finding when the cross-repo blocker is merged');
}

// ---------------------------------------------------------------------------
// Test 6: checkBlockedBy() direct unit test — blocked_by_unresolvable at INFO
// severity for (a) an unknown repo id and (b) a resolvable repo whose blocker
// task cannot be found.
// ---------------------------------------------------------------------------
{
  const knownSiblingDir = path.join(TMP_DIR, 'unit-unresolvable-known-sibling');
  siblingFixture(knownSiblingDir, 'T-503', 'in_progress'); // T-888 (referenced below) does NOT exist here

  const records = [
    { taskId: 'T-603', status: 'merged', blockedBy: 'unknown-repo/T-777, sibling-repo/T-888' },
  ];
  const repoMap = { 'sibling-repo': { path: knownSiblingDir } };

  const findings = checkBlockedBy(records, { repoMap });

  assert.strictEqual(findings.length, 2, `Test 6 FAIL: expected exactly 2 findings, got: ${JSON.stringify(findings)}`);
  for (const finding of findings) {
    assert.strictEqual(finding.checkName, 'blocked_by_unresolvable', 'Test 6 FAIL: checkName mismatch');
    assert.strictEqual(finding.severity, 'info', 'Test 6 FAIL: expected INFO severity');
  }
  assert.ok(
    findings.some((f) => /unknown-repo\/T-777/.test(f.message)),
    'Test 6 FAIL: expected a finding naming the unresolvable repo id "unknown-repo"'
  );
  assert.ok(
    findings.some((f) => /sibling-repo\/T-888/.test(f.message)),
    'Test 6 FAIL: expected a finding naming the unfindable blocker task "sibling-repo/T-888"'
  );
  assert.strictEqual(
    getSeverityForCheck('blocked_by_unresolvable'),
    'info',
    'Test 6 FAIL: getSeverityForCheck default for blocked_by_unresolvable should be info'
  );
  assert.strictEqual(
    getSeverityForCheck('blocked_by_open'),
    'failure',
    'Test 6 FAIL: getSeverityForCheck default for blocked_by_open should be failure'
  );

  console.log('Test 6 passed: checkBlockedBy() fires blocked_by_unresolvable at INFO severity for an unknown repo id and an unfindable blocker task');
}

// ---------------------------------------------------------------------------
// Test 7: checkBlockedBy() does nothing for a task with no Blocked by: field
// (the mavericks-repo default) — silent no-op, matching unknown_module_id /
// unknown_repo_id precedent for absent optional fields.
// ---------------------------------------------------------------------------
{
  const records = [
    { taskId: 'T-604', status: 'merged', blockedBy: null },
    { taskId: 'T-605', status: 'planned', blockedBy: 'sibling-repo/T-999' }, // status not gated
  ];

  const findings = checkBlockedBy(records, { repoMap: {} });

  assert.strictEqual(findings.length, 0, `Test 7 FAIL: expected no findings, got: ${JSON.stringify(findings)}`);

  console.log('Test 7 passed: checkBlockedBy() is a silent no-op for tasks with no Blocked by: field or a non-gated status');
}

// ---------------------------------------------------------------------------
// Test 8 (full-stack, fixture A — OPEN blocker): parseArtifacts() against a
// synthetic BACKLOG.md/TASK_STATUS.md/docs/REPO_MAP.md fixture + a sibling
// repo dir (all under TMP_DIR) produces blocked_by_open at FAILURE severity
// and getExitCode() === 2. The real mavericks repo is never touched.
// ---------------------------------------------------------------------------
{
  const mainRoot = path.join(TMP_DIR, 'fixture-open');
  const siblingDir = path.join(TMP_DIR, 'fixture-open-sibling');
  siblingFixture(siblingDir, 'T-500', 'in_progress');

  writeFixture(mainRoot, {
    backlog: `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-700 — Ship feature depending on sibling repo
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** main-repo
- **Blocked by:** sibling-repo/T-500
`,
    taskStatus: `# TASK_STATUS

## Active tasks

### T-700 — Ship feature depending on sibling repo
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —

## Recently completed tasks
`,
    repoMap: `# Repo Map

## sibling-repo

- **label:** Sibling Repo
- **path:** ${siblingDir}
`,
  });

  const parsed = withProjectRoot(mainRoot, () =>
    parseArtifacts({
      backlogPath: path.join(mainRoot, 'BACKLOG.md'),
      taskStatusPath: path.join(mainRoot, 'TASK_STATUS.md'),
    })
  );

  const finding = parsed.comparison.findings.find(
    (f) => f.checkName === 'blocked_by_open' && f.taskId === 'T-700'
  );
  assert.ok(finding, `Test 8 FAIL: expected a blocked_by_open finding for T-700, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(finding.severity, 'failure', 'Test 8 FAIL: expected FAILURE severity');
  assert.strictEqual(getExitCode(parsed.comparison.overallCandidateState), 2, 'Test 8 FAIL: expected exit code 2');

  console.log('Test 8 passed: full-stack fixture with an OPEN cross-repo blocker fires blocked_by_open (FAILURE) and exits 2');
}

// ---------------------------------------------------------------------------
// Test 9 (full-stack, fixture B — MERGED blocker): no blocked_by_* finding,
// exit code 0.
// ---------------------------------------------------------------------------
{
  const mainRoot = path.join(TMP_DIR, 'fixture-merged');
  const siblingDir = path.join(TMP_DIR, 'fixture-merged-sibling');
  siblingFixture(siblingDir, 'T-501', 'merged');

  writeFixture(mainRoot, {
    backlog: `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-701 — Ship feature depending on sibling repo (blocker merged)
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** main-repo
- **Blocked by:** sibling-repo/T-501
`,
    taskStatus: `# TASK_STATUS

## Active tasks

### T-701 — Ship feature depending on sibling repo (blocker merged)
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: abc1234

## Recently completed tasks
`,
    repoMap: `# Repo Map

## sibling-repo

- **label:** Sibling Repo
- **path:** ${siblingDir}
`,
  });

  const parsed = withProjectRoot(mainRoot, () =>
    parseArtifacts({
      backlogPath: path.join(mainRoot, 'BACKLOG.md'),
      taskStatusPath: path.join(mainRoot, 'TASK_STATUS.md'),
    })
  );

  const blockedFindings = parsed.comparison.findings.filter(
    (f) => f.taskId === 'T-701' && f.checkName.startsWith('blocked_by_')
  );
  assert.strictEqual(
    blockedFindings.length,
    0,
    `Test 9 FAIL: expected no blocked_by_* findings for T-701, got: ${JSON.stringify(blockedFindings)}`
  );
  assert.strictEqual(getExitCode(parsed.comparison.overallCandidateState), 0, 'Test 9 FAIL: expected exit code 0 (Healthy)');

  console.log('Test 9 passed: full-stack fixture with a MERGED cross-repo blocker produces no finding and exits 0');
}

// ---------------------------------------------------------------------------
// Test 10 (full-stack, fixture C — UNRESOLVABLE blocker): info-severity
// blocked_by_unresolvable, never blocks — exit code 0.
// ---------------------------------------------------------------------------
{
  const mainRoot = path.join(TMP_DIR, 'fixture-unresolvable');

  writeFixture(mainRoot, {
    backlog: `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-702 — Ship feature depending on a mis-declared sibling repo
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** main-repo
- **Blocked by:** ghost-repo/T-999
`,
    taskStatus: `# TASK_STATUS

## Active tasks

### T-702 — Ship feature depending on a mis-declared sibling repo
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: def5678

## Recently completed tasks
`,
    repoMap: `# Repo Map

## some-other-repo

- **label:** Unrelated Repo
- **path:** ${path.join(TMP_DIR, 'does-not-matter')}
`,
  });

  const parsed = withProjectRoot(mainRoot, () =>
    parseArtifacts({
      backlogPath: path.join(mainRoot, 'BACKLOG.md'),
      taskStatusPath: path.join(mainRoot, 'TASK_STATUS.md'),
    })
  );

  const finding = parsed.comparison.findings.find(
    (f) => f.checkName === 'blocked_by_unresolvable' && f.taskId === 'T-702'
  );
  assert.ok(finding, `Test 10 FAIL: expected a blocked_by_unresolvable finding for T-702, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(finding.severity, 'info', 'Test 10 FAIL: expected INFO severity');
  assert.strictEqual(getExitCode(parsed.comparison.overallCandidateState), 0, 'Test 10 FAIL: expected exit code 0 (info never blocks)');

  console.log('Test 10 passed: full-stack fixture with an UNRESOLVABLE cross-repo blocker fires blocked_by_unresolvable (INFO) and still exits 0');
}

// ---------------------------------------------------------------------------
// Test 11: checkBlockedBy() against real backlog records shape — confirms
// parseBacklogAllActiveWaveTasks() output plugs into checkBlockedBy() without
// adaptation (blockedBy field is populated by parseTaskBlock()'s getField()).
// ---------------------------------------------------------------------------
{
  const siblingDir = path.join(TMP_DIR, 'unit-shape-sibling');
  siblingFixture(siblingDir, 'T-504', 'merged');

  const markdown = `# BACKLOG

## Active Wave

### T-703 — Shape check task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Blocked by:** sibling-repo/T-504
`;
  const records = parseBacklogAllActiveWaveTasks(markdown);
  assert.strictEqual(records.length, 1, 'Test 11 FAIL: expected exactly 1 parsed record');
  assert.strictEqual(records[0].blockedBy, 'sibling-repo/T-504', 'Test 11 FAIL: blockedBy field should be populated by parseTaskBlock()');

  const findings = checkBlockedBy(records, { repoMap: { 'sibling-repo': { path: siblingDir } } });
  assert.strictEqual(findings.length, 0, `Test 11 FAIL: expected no findings (blocker merged), got: ${JSON.stringify(findings)}`);

  console.log('Test 11 passed: parseBacklogAllActiveWaveTasks() output (with blockedBy field) plugs directly into checkBlockedBy()');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-393 assertions passed.');
