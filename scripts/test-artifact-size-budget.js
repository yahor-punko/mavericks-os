'use strict';
// Regression test: T-395 — artifact_size_budget + state_in_claude_md validator advisories.
// Extended by T-442 — scaling the two Active-section budgets by active task count.
//
// Fixture-based: builds synthetic BACKLOG.md / TASK_STATUS.md / PROCESS_STATE.json /
// CLAUDE.md / HANDOFF.md fixtures in a temp dir per case and runs the validator's
// parseArtifacts() against each, asserting:
//   1. Over-budget CLAUDE.md, HANDOFF.md, BACKLOG.md Active Wave section, and
//      TASK_STATUS.md Active tasks section each produce an info-severity
//      artifact_size_budget finding, and the exit code stays 0 (info never blocks).
//   2. Under-budget fixtures (all four artifacts comfortably inside the default
//      budgets) produce zero artifact_size_budget findings.
//   3. An artifact_budgets override in PROCESS_STATE.json changes the effective
//      budget: a fixture that would trip on defaults stays clean under a raised
//      override, and a fixture that would pass on defaults trips under a
//      lowered override.
//   4. CLAUDE.md containing task-state-shaped lines (### T-NNN heading or
//      - **Status:** field) produces an info-severity state_in_claude_md finding;
//      a CLAUDE.md with neither produces no finding.
//   5. Archived sections (content outside the current Active Wave / Active tasks
//      heading) are never counted toward the budget.
//   6. (T-442) The two Active-section budgets scale with active task count:
//      a 24-task/340-line section passes while a 3-task/340-line section
//      still fires, for both BACKLOG.md Active Wave and TASK_STATUS.md Active
//      tasks; an explicit artifact_budgets override still takes precedence
//      over the computed value; the check stays info severity and never
//      affects exit code.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const {
  parseArtifacts,
  getExitCode,
  DEFAULT_ARTIFACT_BUDGETS,
  BACKLOG_ACTIVE_WAVE_PER_TASK_LINES,
  TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES,
} = require('./mavp-validator.js');

const TMP_DIR = path.join(os.tmpdir(), 't395-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

function repeatLines(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

function buildBacklog({ activeWaveLineCount = 5 } = {}) {
  const activeWaveBody = repeatLines('- filler line', activeWaveLineCount);
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

${activeWaveBody}

## Archived Wave 1

${repeatLines('- archived filler line', 5000)}
`;
}

function buildTaskStatus({ activeTasksLineCount = 5 } = {}) {
  const activeBody = repeatLines('- filler line', activeTasksLineCount);
  return `# TASK_STATUS

## Active tasks

${activeBody}

## Recently completed tasks

${repeatLines('- archived completed filler line', 5000)}
`;
}

function buildClaudeMd({ extraLineCount = 5, includeStateLines = false } = {}) {
  const filler = repeatLines('- convention bullet', extraLineCount);
  const stateLines = includeStateLines
    ? '\n### T-042 — Some task title\n- **Status:** in_progress\n'
    : '';
  return `# CLAUDE.md

## What this repo is

Fixture project.

${filler}
${stateLines}`;
}

function buildHandoffMd({ lineCount = 5 } = {}) {
  return `# HANDOFF\n\n${repeatLines('- handoff note', lineCount)}\n`;
}

// T-442: build `taskCount` real "### T-NNN — Title" task blocks (so
// getTaskBlocks() picks them up as active tasks) padded with filler bullets so
// the section BODY is exactly `bodyLineCount` lines long. Status is `planned`
// so these fixtures don't need a Repo: field to avoid unrelated (warning-only)
// missing_repo_field noise.
function buildTaskBodyLines(taskCount, bodyLineCount, { status = 'planned' } = {}) {
  const lines = [];
  for (let i = 1; i <= taskCount; i += 1) {
    lines.push(`### T-${String(i).padStart(3, '0')} — Task ${i}`);
    lines.push(`- **Status:** ${status}`);
  }
  let filler = 0;
  while (lines.length < bodyLineCount) {
    filler += 1;
    lines.push(`- filler line ${filler}`);
  }
  return lines.slice(0, bodyLineCount).join('\n');
}

// T-442: a bare-minimum mirror of `taskCount` task entries (heading + Status
// only) for the OTHER artifact — so a fixture testing the BACKLOG.md Active
// Wave scaling has matching TASK_STATUS.md entries (and vice versa) and
// doesn't trip the unrelated missing_in_task_status / missing_in_backlog
// failure-severity checks, which would otherwise pollute the exit code.
function buildMirrorSection(taskCount, { status = 'planned' } = {}) {
  const lines = [];
  for (let i = 1; i <= taskCount; i += 1) {
    lines.push(`### T-${String(i).padStart(3, '0')} — Task ${i}`);
    lines.push(`- **Status:** ${status}`);
  }
  return lines.join('\n');
}

function buildBacklogMirror(taskCount) {
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

${buildMirrorSection(taskCount)}

## Archived Wave 1

${repeatLines('- archived filler line', 5000)}
`;
}

function buildTaskStatusMirror(taskCount) {
  return `# TASK_STATUS

## Active tasks

${buildMirrorSection(taskCount)}

## Recently completed tasks

${repeatLines('- archived completed filler line', 5000)}
`;
}

// Builds a BACKLOG.md fixture whose `## Active Wave` section is EXACTLY
// `totalSectionLines` lines long (heading + blank + body + blank before the
// next `## ` heading = body length + 3) and contains `taskCount` real task
// blocks.
function buildBacklogWithTasks({ taskCount, totalSectionLines }) {
  const bodyLineCount = totalSectionLines - 3;
  const body = buildTaskBodyLines(taskCount, bodyLineCount);
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

${body}

## Archived Wave 1

${repeatLines('- archived filler line', 5000)}
`;
}

// Same shape as buildBacklogWithTasks but for TASK_STATUS.md's `## Active tasks`.
function buildTaskStatusWithTasks({ taskCount, totalSectionLines }) {
  const bodyLineCount = totalSectionLines - 3;
  const body = buildTaskBodyLines(taskCount, bodyLineCount);
  return `# TASK_STATUS

## Active tasks

${body}

## Recently completed tasks

${repeatLines('- archived completed filler line', 5000)}
`;
}

function writeFixture(caseName, { backlog, taskStatus, processState, claudeMd, handoffMd }) {
  const caseDir = path.join(TMP_DIR, caseName);
  fs.mkdirSync(caseDir, { recursive: true });
  const backlogPath = path.join(caseDir, 'BACKLOG.md');
  const taskStatusPath = path.join(caseDir, 'TASK_STATUS.md');
  const processStatePath = path.join(caseDir, 'PROCESS_STATE.json');

  fs.writeFileSync(backlogPath, backlog, 'utf8');
  fs.writeFileSync(taskStatusPath, taskStatus, 'utf8');
  if (processState !== undefined) {
    fs.writeFileSync(processStatePath, JSON.stringify(processState, null, 2), 'utf8');
  }
  if (claudeMd !== undefined) {
    fs.writeFileSync(path.join(caseDir, 'CLAUDE.md'), claudeMd, 'utf8');
  }
  if (handoffMd !== undefined) {
    fs.writeFileSync(path.join(caseDir, 'HANDOFF.md'), handoffMd, 'utf8');
  }

  return { backlogPath, taskStatusPath, processStatePath };
}

function findAll(parsed, checkName) {
  return parsed.comparison.findings.filter((f) => f.checkName === checkName);
}

// ---------------------------------------------------------------------------
// Test 1: over-budget CLAUDE.md -> info finding, exit code stays healthy (0).
// ---------------------------------------------------------------------------
{
  const overBudgetLines = DEFAULT_ARTIFACT_BUDGETS.claude_md_max_lines + 50;
  const { backlogPath, taskStatusPath } = writeFixture('over-claude', {
    backlog: buildBacklog(),
    taskStatus: buildTaskStatus(),
    processState: {},
    claudeMd: buildClaudeMd({ extraLineCount: overBudgetLines }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const claudeFinding = findings.find((f) => /CLAUDE\.md/.test(f.message));

  assert.ok(claudeFinding, `Test 1 FAIL: expected an artifact_size_budget finding for CLAUDE.md, got: ${JSON.stringify(findings, null, 2)}`);
  assert.strictEqual(claudeFinding.severity, 'info', `Test 1 FAIL: severity should be "info", got: "${claudeFinding.severity}"`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 1 FAIL: info finding must not change exit code, got: ${exitCode}`);
  assert.strictEqual(parsed.comparison.overallCandidateState, 'healthy', `Test 1 FAIL: overallCandidateState should remain "healthy", got: "${parsed.comparison.overallCandidateState}"`);

  console.log('Test 1 passed: over-budget CLAUDE.md produces an info-severity artifact_size_budget finding without changing exit code');
}

// ---------------------------------------------------------------------------
// Test 2: over-budget HANDOFF.md, BACKLOG.md Active Wave, TASK_STATUS.md
// Active tasks each independently produce a finding.
// ---------------------------------------------------------------------------
{
  const { backlogPath, taskStatusPath } = writeFixture('over-handoff-and-sections', {
    backlog: buildBacklog({ activeWaveLineCount: DEFAULT_ARTIFACT_BUDGETS.backlog_active_wave_max_lines + 20 }),
    taskStatus: buildTaskStatus({ activeTasksLineCount: DEFAULT_ARTIFACT_BUDGETS.task_status_active_tasks_max_lines + 20 }),
    processState: {},
    claudeMd: buildClaudeMd(),
    handoffMd: buildHandoffMd({ lineCount: DEFAULT_ARTIFACT_BUDGETS.handoff_md_max_lines + 20 }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');

  assert.ok(findings.some((f) => /HANDOFF\.md/.test(f.message)), `Test 2 FAIL: expected HANDOFF.md finding, got: ${JSON.stringify(findings, null, 2)}`);
  assert.ok(findings.some((f) => /BACKLOG\.md Active Wave/.test(f.message)), `Test 2 FAIL: expected BACKLOG.md Active Wave finding, got: ${JSON.stringify(findings, null, 2)}`);
  assert.ok(findings.some((f) => /TASK_STATUS\.md Active tasks/.test(f.message)), `Test 2 FAIL: expected TASK_STATUS.md Active tasks finding, got: ${JSON.stringify(findings, null, 2)}`);
  assert.ok(findings.every((f) => f.severity === 'info'), `Test 2 FAIL: all findings must be info severity, got: ${JSON.stringify(findings, null, 2)}`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 2 FAIL: info findings must not change exit code, got: ${exitCode}`);

  console.log('Test 2 passed: over-budget HANDOFF.md, BACKLOG.md Active Wave, and TASK_STATUS.md Active tasks each independently fire artifact_size_budget');
}

// ---------------------------------------------------------------------------
// Test 3: under-budget fixture -> no artifact_size_budget findings at all.
// ---------------------------------------------------------------------------
{
  const { backlogPath, taskStatusPath } = writeFixture('under-budget', {
    backlog: buildBacklog({ activeWaveLineCount: 5 }),
    taskStatus: buildTaskStatus({ activeTasksLineCount: 5 }),
    processState: {},
    claudeMd: buildClaudeMd({ extraLineCount: 5 }),
    handoffMd: buildHandoffMd({ lineCount: 5 }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');

  assert.strictEqual(findings.length, 0, `Test 3 FAIL: expected no artifact_size_budget findings for an under-budget fixture, got: ${JSON.stringify(findings, null, 2)}`);

  console.log('Test 3 passed: under-budget fixture produces zero artifact_size_budget findings');
}

// ---------------------------------------------------------------------------
// Test 4: artifact_budgets override in PROCESS_STATE.json.
// 4a. Raising the CLAUDE.md budget silences a fixture that would otherwise trip.
// 4b. Lowering the BACKLOG.md Active Wave budget trips a fixture that would
//     otherwise be clean under defaults.
// ---------------------------------------------------------------------------
{
  const overBudgetLines = DEFAULT_ARTIFACT_BUDGETS.claude_md_max_lines + 50;
  const { backlogPath, taskStatusPath } = writeFixture('override-raise-claude', {
    backlog: buildBacklog(),
    taskStatus: buildTaskStatus(),
    processState: {
      artifact_budgets: {
        claude_md_max_lines: DEFAULT_ARTIFACT_BUDGETS.claude_md_max_lines + 1000,
      },
    },
    claudeMd: buildClaudeMd({ extraLineCount: overBudgetLines }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const claudeFinding = findings.find((f) => /CLAUDE\.md/.test(f.message));

  assert.strictEqual(claudeFinding, undefined, `Test 4a FAIL: raised override should silence the CLAUDE.md finding, got: ${JSON.stringify(claudeFinding, null, 2)}`);

  console.log('Test 4a passed: raising claude_md_max_lines via artifact_budgets override silences an otherwise-tripping fixture');
}

{
  const { backlogPath, taskStatusPath } = writeFixture('override-lower-backlog', {
    backlog: buildBacklog({ activeWaveLineCount: 5 }),
    taskStatus: buildTaskStatus({ activeTasksLineCount: 5 }),
    processState: {
      artifact_budgets: {
        backlog_active_wave_max_lines: 3,
      },
    },
    claudeMd: buildClaudeMd({ extraLineCount: 5 }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const backlogFinding = findings.find((f) => /BACKLOG\.md Active Wave/.test(f.message));

  assert.ok(backlogFinding, `Test 4b FAIL: lowered override should trip a fixture that is clean under defaults, got: ${JSON.stringify(findings, null, 2)}`);
  assert.strictEqual(backlogFinding.severity, 'info', `Test 4b FAIL: severity should be "info", got: "${backlogFinding.severity}"`);
  assert.ok(/budget of 3/.test(backlogFinding.message), `Test 4b FAIL: message should reflect the overridden budget of 3, got: "${backlogFinding.message}"`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 4b FAIL: info finding must not change exit code, got: ${exitCode}`);

  console.log('Test 4b passed: lowering backlog_active_wave_max_lines via artifact_budgets override trips an otherwise-clean fixture');
}

// ---------------------------------------------------------------------------
// Test 5: state_in_claude_md fires when CLAUDE.md has ### T-NNN or - **Status:**
// lines; does not fire otherwise.
// ---------------------------------------------------------------------------
{
  const { backlogPath, taskStatusPath } = writeFixture('state-in-claude-md', {
    backlog: buildBacklog(),
    taskStatus: buildTaskStatus(),
    processState: {},
    claudeMd: buildClaudeMd({ extraLineCount: 5, includeStateLines: true }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const finding = parsed.comparison.findings.find((f) => f.checkName === 'state_in_claude_md');

  assert.ok(finding, `Test 5 FAIL: expected a state_in_claude_md finding, got findings: ${JSON.stringify(parsed.comparison.findings, null, 2)}`);
  assert.strictEqual(finding.severity, 'info', `Test 5 FAIL: severity should be "info", got: "${finding.severity}"`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 5 FAIL: info finding must not change exit code, got: ${exitCode}`);

  console.log('Test 5 passed: CLAUDE.md with task-state-shaped lines produces an info-severity state_in_claude_md finding');
}

{
  const { backlogPath, taskStatusPath } = writeFixture('no-state-in-claude-md', {
    backlog: buildBacklog(),
    taskStatus: buildTaskStatus(),
    processState: {},
    claudeMd: buildClaudeMd({ extraLineCount: 5, includeStateLines: false }),
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const finding = parsed.comparison.findings.find((f) => f.checkName === 'state_in_claude_md');

  assert.strictEqual(finding, undefined, `Test 6 FAIL: expected no state_in_claude_md finding for a clean CLAUDE.md, got: ${JSON.stringify(finding, null, 2)}`);

  console.log('Test 6 passed: CLAUDE.md with no task-state-shaped lines produces no state_in_claude_md finding');
}

// ---------------------------------------------------------------------------
// Test 7: archived sections are never counted — a fixture with a huge archived
// wave/completed-tasks section but a small active section produces no finding.
// (buildBacklog/buildTaskStatus already append 5000-line archived sections;
// this test just asserts that alone does not trip the budget.)
// ---------------------------------------------------------------------------
{
  const { backlogPath, taskStatusPath } = writeFixture('archived-not-counted', {
    backlog: buildBacklog({ activeWaveLineCount: 5 }),
    taskStatus: buildTaskStatus({ activeTasksLineCount: 5 }),
    processState: {},
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const sectionFindings = findings.filter((f) => /Active Wave|Active tasks/.test(f.message));

  assert.strictEqual(sectionFindings.length, 0, `Test 7 FAIL: 5000-line archived sections must not be counted toward the active-section budget, got: ${JSON.stringify(sectionFindings, null, 2)}`);

  console.log('Test 7 passed: archived wave/completed sections are excluded from the active-section line count');
}

// ---------------------------------------------------------------------------
// Test 8 (T-442): BACKLOG.md Active Wave scaling — a 24-task/340-line section
// passes (24 * BACKLOG_ACTIVE_WAVE_PER_TASK_LINES=15 = 360 >= 340) while a
// 3-task/340-line section still fires (3 * 15 = 45 stays under the 200-line
// static floor, so 340 > 200 trips).
// ---------------------------------------------------------------------------
assert.strictEqual(BACKLOG_ACTIVE_WAVE_PER_TASK_LINES, 15, 'Test 8 precondition: this test assumes a per-task allowance of 15 lines for BACKLOG Active Wave');

{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-backlog-24-tasks-pass', {
    backlog: buildBacklogWithTasks({ taskCount: 24, totalSectionLines: 340 }),
    taskStatus: buildTaskStatusMirror(24),
    processState: {},
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const backlogFinding = findings.find((f) => /BACKLOG\.md Active Wave/.test(f.message));

  assert.strictEqual(backlogFinding, undefined, `Test 8 FAIL: a 24-task/340-line Active Wave section should not trip the scaled budget (24*15=360 >= 340), got: ${JSON.stringify(backlogFinding, null, 2)}`);

  console.log('Test 8 passed: a 24-task/340-line BACKLOG.md Active Wave section produces no artifact_size_budget finding (scaled budget covers it)');
}

{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-backlog-3-tasks-fire', {
    backlog: buildBacklogWithTasks({ taskCount: 3, totalSectionLines: 340 }),
    taskStatus: buildTaskStatusMirror(3),
    processState: {},
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const backlogFinding = findings.find((f) => /BACKLOG\.md Active Wave/.test(f.message));

  assert.ok(backlogFinding, `Test 9 FAIL: a 3-task/340-line Active Wave section should still trip (scaled budget stays at the 200-line static floor), got findings: ${JSON.stringify(findings, null, 2)}`);
  assert.strictEqual(backlogFinding.severity, 'info', `Test 9 FAIL: severity should be "info", got: "${backlogFinding.severity}"`);
  assert.ok(/budget of 200/.test(backlogFinding.message), `Test 9 FAIL: expected the static floor of 200 in the message, got: "${backlogFinding.message}"`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 9 FAIL: info finding must not change exit code, got: ${exitCode}`);

  console.log('Test 9 passed: a 3-task/340-line BACKLOG.md Active Wave section still produces an info-severity artifact_size_budget finding (falls back to the 200-line static floor)');
}

// ---------------------------------------------------------------------------
// Test 10 (T-442): TASK_STATUS.md Active tasks scaling — analogous behavior
// using its own per-task allowance (10) and static floor (150): a 20-task
// section covering 190 lines passes (20*10=200 >= 190) while a 3-task section
// with the same 190 lines still fires (3*10=30 stays under the 150 floor).
// ---------------------------------------------------------------------------
assert.strictEqual(TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES, 10, 'Test 10 precondition: this test assumes a per-task allowance of 10 lines for TASK_STATUS Active tasks');

{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-taskstatus-20-tasks-pass', {
    backlog: buildBacklogMirror(20),
    taskStatus: buildTaskStatusWithTasks({ taskCount: 20, totalSectionLines: 190 }),
    processState: {},
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const taskStatusFinding = findings.find((f) => /TASK_STATUS\.md Active tasks/.test(f.message));

  assert.strictEqual(taskStatusFinding, undefined, `Test 10 FAIL: a 20-task/190-line Active tasks section should not trip the scaled budget (20*10=200 >= 190), got: ${JSON.stringify(taskStatusFinding, null, 2)}`);

  console.log('Test 10 passed: a 20-task/190-line TASK_STATUS.md Active tasks section produces no artifact_size_budget finding (scaled budget covers it)');
}

{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-taskstatus-3-tasks-fire', {
    backlog: buildBacklogMirror(3),
    taskStatus: buildTaskStatusWithTasks({ taskCount: 3, totalSectionLines: 190 }),
    processState: {},
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const taskStatusFinding = findings.find((f) => /TASK_STATUS\.md Active tasks/.test(f.message));

  assert.ok(taskStatusFinding, `Test 11 FAIL: a 3-task/190-line Active tasks section should still trip (scaled budget stays at the 150-line static floor), got findings: ${JSON.stringify(findings, null, 2)}`);
  assert.strictEqual(taskStatusFinding.severity, 'info', `Test 11 FAIL: severity should be "info", got: "${taskStatusFinding.severity}"`);
  assert.ok(/budget of 150/.test(taskStatusFinding.message), `Test 11 FAIL: expected the static floor of 150 in the message, got: "${taskStatusFinding.message}"`);

  const exitCode = getExitCode(parsed.comparison.overallCandidateState);
  assert.strictEqual(exitCode, 0, `Test 11 FAIL: info finding must not change exit code, got: ${exitCode}`);

  console.log('Test 11 passed: a 3-task/190-line TASK_STATUS.md Active tasks section still produces an info-severity artifact_size_budget finding (falls back to the 150-line static floor)');
}

// ---------------------------------------------------------------------------
// Test 12 (T-442): an explicit artifact_budgets override takes precedence
// over the computed (scaled) value, in both directions.
// 12a. A 24-task/340-line Active Wave section (which the scaled budget of 360
//      would pass) still fires when an override lowers the budget to 100.
// 12b. A 3-task/340-line Active Wave section (which falls back to the
//      200-line static floor and fires) stays clean when an override raises
//      the budget to 1000.
// ---------------------------------------------------------------------------
{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-override-lower-wins', {
    backlog: buildBacklogWithTasks({ taskCount: 24, totalSectionLines: 340 }),
    taskStatus: buildTaskStatusMirror(24),
    processState: {
      artifact_budgets: {
        backlog_active_wave_max_lines: 100,
      },
    },
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const backlogFinding = findings.find((f) => /BACKLOG\.md Active Wave/.test(f.message));

  assert.ok(backlogFinding, `Test 12a FAIL: an explicit override of 100 should win over the scaled budget of 360 and trip the finding, got findings: ${JSON.stringify(findings, null, 2)}`);
  assert.ok(/budget of 100/.test(backlogFinding.message), `Test 12a FAIL: expected the override value of 100 in the message, got: "${backlogFinding.message}"`);

  console.log('Test 12a passed: a lowered artifact_budgets override wins over a scaled budget that would otherwise have passed');
}

{
  const { backlogPath, taskStatusPath } = writeFixture('scaled-override-raise-wins', {
    backlog: buildBacklogWithTasks({ taskCount: 3, totalSectionLines: 340 }),
    taskStatus: buildTaskStatusMirror(3),
    processState: {
      artifact_budgets: {
        backlog_active_wave_max_lines: 1000,
      },
    },
  });

  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const findings = findAll(parsed, 'artifact_size_budget');
  const backlogFinding = findings.find((f) => /BACKLOG\.md Active Wave/.test(f.message));

  assert.strictEqual(backlogFinding, undefined, `Test 12b FAIL: an explicit override of 1000 should win over the scaled/floor budget and silence the finding, got: ${JSON.stringify(backlogFinding, null, 2)}`);

  console.log('Test 12b passed: a raised artifact_budgets override wins over a scaled budget that would otherwise have fired');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-395 + T-442 assertions passed.');
