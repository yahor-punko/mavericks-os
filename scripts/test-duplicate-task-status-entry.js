'use strict';
// Regression test: T-439 — validator: whole-file duplicate-entry detection
// for TASK_STATUS.md.
//
// Covers:
//   1. checkDuplicateTaskStatusEntries() fires duplicate_task_status_entry
//      at WARNING severity when a task heading (### T-NNN) appears in more
//      than one section of TASK_STATUS.md, naming both source sections.
//   2. checkDuplicateTaskStatusEntries() fires duplicate_task_status_entry
//      at WARNING severity when a "## <section>" heading (e.g.
//      "## Recently completed tasks") appears more than once.
//   3. A clean fixture (no duplicates) produces neither finding.
//   4. Full-stack: parseArtifacts() wires the check in and never escalates
//      exit code above 1 (warning), even though other checks may still
//      fire failures independently.
//   5. A FROZEN fixture (embedded in this file, not read from the live repo)
//      reproducing the shape of a real historical incident — T-002 and
//      T-430..T-434 duplicated across two "## Recently completed tasks"
//      sections — is detected deterministically. This must never read the
//      live TASK_STATUS.md from disk: that file is mutable (the Main Agent
//      repairs duplicates as they're found), so asserting against it makes
//      the test's pass/fail outcome depend on unrelated repo state.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const {
  checkDuplicateTaskStatusEntries,
  getSeverityForCheck,
  parseArtifacts,
  getExitCode,
} = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't439-dup-task-status-'));

// ---------------------------------------------------------------------------
// Test 1: duplicate ### T-NNN heading across two sections.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-010 — Duplicated task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit

## Recently completed tasks

### T-010 — Duplicated task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: abc1234
`;

  const findings = checkDuplicateTaskStatusEntries(markdown);
  const taskFindings = findings.filter((f) => f.taskId === 'T-010');

  assert.strictEqual(
    taskFindings.length,
    1,
    `Test 1 FAIL: expected exactly 1 finding for T-010, got: ${JSON.stringify(findings)}`
  );
  const finding = taskFindings[0];
  assert.strictEqual(finding.checkName, 'duplicate_task_status_entry', 'Test 1 FAIL: checkName mismatch');
  assert.strictEqual(finding.severity, 'warning', 'Test 1 FAIL: expected WARNING severity');
  assert.ok(/Active tasks/.test(finding.message), 'Test 1 FAIL: message should name the "Active tasks" source section');
  assert.ok(/Recently completed tasks/.test(finding.message), 'Test 1 FAIL: message should name the "Recently completed tasks" source section');
  assert.strictEqual(finding.details.count, 2, 'Test 1 FAIL: details.count should be 2');

  console.log('Test 1 passed: duplicate ### T-NNN heading across two sections fires duplicate_task_status_entry (WARNING), naming both sections');
}

// ---------------------------------------------------------------------------
// Test 2: duplicate "## Recently completed tasks" section heading.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-020 — Solo task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit

## Recently completed tasks

### T-021 — First completed batch
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: def5678

## Recently completed tasks

### T-022 — Second completed batch
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: ghi9012
`;

  const findings = checkDuplicateTaskStatusEntries(markdown);
  const sectionFindings = findings.filter((f) => f.details && f.details.kind === 'section_heading');

  assert.strictEqual(
    sectionFindings.length,
    1,
    `Test 2 FAIL: expected exactly 1 section-heading finding, got: ${JSON.stringify(findings)}`
  );
  const finding = sectionFindings[0];
  assert.strictEqual(finding.checkName, 'duplicate_task_status_entry', 'Test 2 FAIL: checkName mismatch');
  assert.strictEqual(finding.severity, 'warning', 'Test 2 FAIL: expected WARNING severity');
  assert.ok(/Recently completed tasks/.test(finding.message), 'Test 2 FAIL: message should name the duplicated section');
  assert.strictEqual(finding.details.count, 2, 'Test 2 FAIL: details.count should be 2');

  // No task-heading duplicate should fire here — T-020/T-021/T-022 are each unique.
  const taskFindings = findings.filter((f) => f.details && f.details.kind === 'task_heading');
  assert.strictEqual(taskFindings.length, 0, `Test 2 FAIL: expected no task_heading findings, got: ${JSON.stringify(taskFindings)}`);

  console.log('Test 2 passed: duplicate "## Recently completed tasks" section heading fires duplicate_task_status_entry (WARNING)');
}

// ---------------------------------------------------------------------------
// Test 3: clean fixture produces no findings.
// ---------------------------------------------------------------------------
{
  const markdown = `# TASK_STATUS

## Active tasks

### T-030 — Solo task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit

## Recently completed tasks

### T-031 — Completed task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: jkl3456
`;

  const findings = checkDuplicateTaskStatusEntries(markdown);
  assert.strictEqual(findings.length, 0, `Test 3 FAIL: expected no findings on a clean file, got: ${JSON.stringify(findings)}`);

  console.log('Test 3 passed: a clean TASK_STATUS.md fixture produces no duplicate_task_status_entry findings');
}

// ---------------------------------------------------------------------------
// Test 4 (full-stack): parseArtifacts() wires the check in via mergeFindings()
// and never escalates exit code above 1 (warning) purely from this check.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'fixture-full-stack');
  fs.mkdirSync(root, { recursive: true });

  const backlog = `# BACKLOG

## Active Wave

### T-040 — Sample task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
`;

  const taskStatus = `# TASK_STATUS

## Active tasks

### T-040 — Sample task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: mno7890

## Recently completed tasks

### T-040 — Sample task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: mno7890
`;

  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');

  const parsed = parseArtifacts({
    backlogPath: path.join(root, 'BACKLOG.md'),
    taskStatusPath: path.join(root, 'TASK_STATUS.md'),
  });

  const finding = parsed.comparison.findings.find(
    (f) => f.checkName === 'duplicate_task_status_entry' && f.taskId === 'T-040'
  );
  assert.ok(finding, `Test 4 FAIL: expected a duplicate_task_status_entry finding for T-040, got: ${JSON.stringify(parsed.comparison.findings)}`);
  assert.strictEqual(finding.severity, 'warning', 'Test 4 FAIL: expected WARNING severity');
  assert.strictEqual(
    getExitCode(parsed.comparison.overallCandidateState),
    1,
    'Test 4 FAIL: expected exit code 1 (drifting/warning), never 2 (failure) from this check alone'
  );
  assert.strictEqual(
    getSeverityForCheck('duplicate_task_status_entry'),
    'warning',
    'Test 4 FAIL: getSeverityForCheck default for duplicate_task_status_entry should be warning'
  );

  console.log('Test 4 passed: full-stack parseArtifacts() fixture with a duplicated task heading fires duplicate_task_status_entry (WARNING) and exits 1, never 2');
}

// ---------------------------------------------------------------------------
// Test 5: FROZEN fixture reproducing the shape of the historical archival
// fallout this repo's TASK_STATUS.md once had (T-002 and T-430..T-434
// duplicated across two "## Recently completed tasks" sections). This must
// NOT read the live TASK_STATUS.md from disk — that file is mutable
// (the Main Agent repairs duplicates it finds), so a test asserting against
// it is non-deterministic across the task's lifetime. The fixture below is a
// static string embedded in this test file, independent of repo state.
// ---------------------------------------------------------------------------
{
  const frozenMarkdown = `# TASK_STATUS

## Status legend

- planned, in_progress, dev_done, ready_for_qa, qa_passed, merged

## Active tasks

### T-435 — Unrelated in-flight task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit

## Recently completed tasks

### T-434 — Document close-session commit contract
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Evidence:**
  - commit: aaa1111

### T-433 — check-sync: warn on version drift
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: bbb2222

### T-432 — sync-status: mirror BACKLOG heading title
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: ccc3333

### T-431 — close-session commit gate
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: ddd4444

### T-430 — Hook script resolution
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: eee5555

## Recently completed tasks

### T-434 — Document close-session commit contract
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Evidence:**
  - commit: aaa1111

### T-433 — check-sync: warn on version drift
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: bbb2222

### T-432 — sync-status: mirror BACKLOG heading title
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: ccc3333

### T-431 — close-session commit gate
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: ddd4444

### T-430 — Hook script resolution
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: eee5555

### T-002 — Operationalize pilot on the Mavericks project
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: fff6666

### T-002 — Operationalize pilot on the Mavericks project
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:**
  - commit: fff6666
`;

  const findings = checkDuplicateTaskStatusEntries(frozenMarkdown);
  const duplicatedTaskIds = new Set(
    findings.filter((f) => f.details && f.details.kind === 'task_heading').map((f) => f.taskId)
  );
  const expectedDuplicateIds = ['T-002', 'T-430', 'T-431', 'T-432', 'T-433', 'T-434'];

  for (const taskId of expectedDuplicateIds) {
    assert.ok(
      duplicatedTaskIds.has(taskId),
      `Test 5 FAIL: expected ${taskId} to be reported as a duplicate in the frozen fixture. Found IDs: ${JSON.stringify([...duplicatedTaskIds])}`
    );
  }
  assert.strictEqual(
    duplicatedTaskIds.size,
    expectedDuplicateIds.length,
    `Test 5 FAIL: expected exactly ${expectedDuplicateIds.length} duplicated task IDs, got: ${JSON.stringify([...duplicatedTaskIds])}`
  );

  const sectionFinding = findings.find(
    (f) => f.details && f.details.kind === 'section_heading' && f.details.sectionName === 'Recently completed tasks'
  );
  assert.ok(
    sectionFinding,
    `Test 5 FAIL: expected a duplicate "## Recently completed tasks" section-heading finding, got: ${JSON.stringify(findings)}`
  );
  assert.strictEqual(sectionFinding.details.count, 2, 'Test 5 FAIL: expected the section heading to be counted twice');

  console.log(`Test 5 passed: a frozen fixture reproducing the historical archival-fallout shape (${expectedDuplicateIds.join(', ')} duplicated across two "## Recently completed tasks" sections) is detected deterministically, independent of the live repo's TASK_STATUS.md`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-439 assertions passed.');
