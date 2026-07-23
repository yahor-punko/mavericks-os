'use strict';
// Regression test: T-437 — apply-decomposition per-task repo field + full
// TASK_STATUS stub via the shared lib builder.
//
// Covers the acceptance criteria verbatim:
//   1. A block where task A has "repo: repo-a" and task B has
//      "repo: repo-a, repo-b" produces "- **Repo:** repo-a" on A and
//      "- **Repos:** repo-a, repo-b" on B in BACKLOG.md.
//   2. A task with no repo: gets no Repo line.
//   3. A --repo <name> CLI flag supplies the batch default for tasks
//      without their own repo: (and per-task repo: overrides it).
//   4. TASK_STATUS stubs come from the shared lib buildTaskStatusEntry and
//      contain Status, Owner role, Verification type, Last verified by, and
//      Evidence lines.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const {
  parseTaskBlock,
  buildBacklogEntry,
  buildTaskStatusEntry,
  resolveRepoLine,
  parseCliArgs,
  applyDecompositionFromString,
} = require('./mavp-operator-apply-decomposition.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't437-apply-decomposition-repo-'));

const BACKLOG_FIXTURE = `# Backlog

## Active Wave

`;

const TASK_STATUS_FIXTURE = `# Task Status

## Active tasks

`;

const PROCESS_STATE_FIXTURE = {
  initiative: 'fixture',
  stage: 'execution',
  wave: 1,
  wave_status: 'execution',
  active_slices: [],
  next_action: 'noop',
  blocker: null,
  stage_owner: 'main_agent',
  last_task_id: 900,
  last_updated: '2026-01-01',
};

function makeFixtureRoot(name) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), BACKLOG_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), TASK_STATUS_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(PROCESS_STATE_FIXTURE, null, 2) + '\n', 'utf8');
  return root;
}

// ---------------------------------------------------------------------------
// Test 1: parseTaskBlock captures the repo: field.
// ---------------------------------------------------------------------------
{
  const raw = 'title: Fixture task\nowner_role: developer\nverification_type: runtime\nrepo: repo-a';
  const parsed = parseTaskBlock(raw);
  assert.strictEqual(parsed.repo, 'repo-a', 'Test 1 FAIL: parseTaskBlock should capture repo: field');
  console.log('Test 1 passed: parseTaskBlock captures the repo: field');
}

// ---------------------------------------------------------------------------
// Test 2 (acceptance criterion 1): task A with "repo: repo-a" renders
// "- **Repo:** repo-a"; task B with "repo: repo-a, repo-b" renders
// "- **Repos:** repo-a, repo-b".
// ---------------------------------------------------------------------------
{
  const taskA = { title: 'Task A', owner_role: 'developer', verification_type: 'runtime', repo: 'repo-a' };
  const taskB = { title: 'Task B', owner_role: 'developer', verification_type: 'runtime', repo: 'repo-a, repo-b' };

  const entryA = buildBacklogEntry('T-901', taskA);
  const entryB = buildBacklogEntry('T-902', taskB);

  assert.ok(entryA.includes('- **Repo:** repo-a'), `Test 2 FAIL: task A should render "- **Repo:** repo-a", got:\n${entryA}`);
  assert.ok(!entryA.includes('**Repos:**'), 'Test 2 FAIL: task A must not render a Repos (plural) line');

  assert.ok(entryB.includes('- **Repos:** repo-a, repo-b'), `Test 2 FAIL: task B should render "- **Repos:** repo-a, repo-b", got:\n${entryB}`);
  assert.ok(!entryB.includes('- **Repo:**'), 'Test 2 FAIL: task B must not render a singular Repo line');
  console.log('Test 2 passed: single repo: -> "- **Repo:**", multi repo: -> "- **Repos:**"');
}

// ---------------------------------------------------------------------------
// Test 3 (acceptance criterion 2): a task with no repo: gets no Repo line.
// ---------------------------------------------------------------------------
{
  const taskC = { title: 'Task C', owner_role: 'developer', verification_type: 'runtime' };
  const entryC = buildBacklogEntry('T-903', taskC);
  assert.ok(!entryC.includes('**Repo'), `Test 3 FAIL: task with no repo: should have no Repo/Repos line, got:\n${entryC}`);
  assert.strictEqual(resolveRepoLine(taskC, undefined), null, 'Test 3 FAIL: resolveRepoLine should return null with no repo and no batch default');
  console.log('Test 3 passed: task with no repo: and no batch default gets no Repo line');
}

// ---------------------------------------------------------------------------
// Test 4 (acceptance criterion 3): --repo <name> CLI flag supplies the batch
// default for tasks without their own repo:; per-task repo: overrides it.
// ---------------------------------------------------------------------------
{
  // parseCliArgs recognises --repo and an optional positional FILE.
  const parsedFlagFirst = parseCliArgs(['--repo', 'batch-repo', 'decomposition.md']);
  assert.deepStrictEqual(parsedFlagFirst, { filePath: 'decomposition.md', repoName: 'batch-repo' }, 'Test 4a FAIL: parseCliArgs should parse --repo before FILE');

  const parsedFileFirst = parseCliArgs(['decomposition.md', '--repo', 'batch-repo']);
  assert.deepStrictEqual(parsedFileFirst, { filePath: 'decomposition.md', repoName: 'batch-repo' }, 'Test 4b FAIL: parseCliArgs should parse --repo after FILE');

  const parsedNoFile = parseCliArgs(['--repo', 'batch-repo']);
  assert.deepStrictEqual(parsedNoFile, { filePath: null, repoName: 'batch-repo' }, 'Test 4c FAIL: parseCliArgs should handle --repo with no FILE (stdin mode)');
  console.log('Test 4 passed: parseCliArgs() extracts --repo <name> regardless of position, and works with stdin (no FILE)');

  // Task with no repo: field gets the batch default from --repo.
  const taskNoRepo = { title: 'Task D', owner_role: 'developer', verification_type: 'runtime' };
  const entryD = buildBacklogEntry('T-904', taskNoRepo, 'batch-repo');
  assert.ok(entryD.includes('- **Repo:** batch-repo'), `Test 4d FAIL: task with no repo: should inherit --repo batch default, got:\n${entryD}`);
  console.log('Test 4d passed: task with no repo: field inherits the --repo batch default');

  // Task with its own repo: field overrides the batch default.
  const taskOwnRepo = { title: 'Task E', owner_role: 'developer', verification_type: 'runtime', repo: 'repo-a' };
  const entryE = buildBacklogEntry('T-905', taskOwnRepo, 'batch-repo');
  assert.ok(entryE.includes('- **Repo:** repo-a'), `Test 4e FAIL: per-task repo: should override the --repo batch default, got:\n${entryE}`);
  assert.ok(!entryE.includes('batch-repo'), 'Test 4e FAIL: batch default must not leak in when task has its own repo:');
  console.log('Test 4e passed: per-task repo: overrides the --repo batch default');
}

// ---------------------------------------------------------------------------
// Test 5 (acceptance criterion 4): TASK_STATUS stubs come from the shared
// lib buildTaskStatusEntry and contain Status, Owner role, Verification
// type, Last verified by, and Evidence lines.
// ---------------------------------------------------------------------------
{
  const entry = buildTaskStatusEntry('T-906', 'Fixture task', 'developer', 'runtime', 'planned');
  assert.ok(entry.includes('### T-906 — Fixture task'), 'Test 5 FAIL: stub should contain the task heading');
  assert.ok(entry.includes('- **Status:** planned'), 'Test 5 FAIL: stub should contain Status line');
  assert.ok(entry.includes('- **Owner role:** developer'), 'Test 5 FAIL: stub should contain Owner role line');
  assert.ok(entry.includes('- **Verification type:** runtime'), 'Test 5 FAIL: stub should contain Verification type line');
  assert.ok(entry.includes('- **Last verified by:** —'), 'Test 5 FAIL: stub should contain Last verified by line (from shared lib, was missing in the drifted local copy)');
  assert.ok(entry.includes('- **Evidence:** —'), 'Test 5 FAIL: stub should contain Evidence line (from shared lib, was missing in the drifted local copy)');
  console.log('Test 5 passed: TASK_STATUS stub contains Status, Owner role, Verification type, Last verified by, and Evidence lines');
}

// ---------------------------------------------------------------------------
// Test 6: end-to-end through applyDecompositionFromString() — confirms the
// full pipeline (parse -> build -> write) produces the same repo-field
// behavior on real BACKLOG.md/TASK_STATUS.md fixture files, and that the
// written TASK_STATUS.md entry matches the shared-lib stub shape.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('e2e-fixture');
  const prevRoot = process.env.MAVERICKS_PROJECT_ROOT;
  process.env.MAVERICKS_PROJECT_ROOT = root;

  // Force module to re-resolve ROOT-dependent paths by re-requiring in a
  // fresh module cache entry keyed on the env var — mavp-operator-apply-
  // decomposition.js reads MAVERICKS_PROJECT_ROOT at module-load time, so we
  // delete it from require.cache and re-require.
  delete require.cache[require.resolve('./mavp-operator-apply-decomposition.js')];
  const fresh = require('./mavp-operator-apply-decomposition.js');

  const input = `<!-- mavp-decomposition-start -->
title: Task A
owner_role: developer
depends_on: —
verification_type: runtime
problem: Problem A.
acceptance_criteria: Criteria A.
repo: repo-a
---
title: Task B
owner_role: developer
depends_on: —
verification_type: runtime
problem: Problem B.
acceptance_criteria: Criteria B.
repo: repo-a, repo-b
---
title: Task C (no repo)
owner_role: developer
depends_on: —
verification_type: runtime
problem: Problem C.
acceptance_criteria: Criteria C.
<!-- mavp-decomposition-end -->`;

  return fresh.applyDecompositionFromString(input).then(() => {
    const backlogOut = fs.readFileSync(path.join(root, 'BACKLOG.md'), 'utf8');
    const taskStatusOut = fs.readFileSync(path.join(root, 'TASK_STATUS.md'), 'utf8');

    assert.ok(backlogOut.includes('- **Repo:** repo-a') && backlogOut.includes('### T-901 — Task A'), `Test 6 FAIL: BACKLOG.md should have T-901 with Repo: repo-a, got:\n${backlogOut}`);
    assert.ok(backlogOut.includes('- **Repos:** repo-a, repo-b'), `Test 6 FAIL: BACKLOG.md should have Repos: repo-a, repo-b for T-902, got:\n${backlogOut}`);
    assert.ok(backlogOut.includes('### T-903 — Task C (no repo)'), 'Test 6 FAIL: T-903 should be registered');
    // T-903 (no repo:) must not pick up any Repo/Repos line.
    const t903Block = backlogOut.split('### T-903')[1] || '';
    assert.ok(!t903Block.includes('**Repo'), `Test 6 FAIL: T-903 (no repo:) should have no Repo line, got:\n${t903Block}`);

    assert.ok(taskStatusOut.includes('- **Last verified by:** —') && taskStatusOut.includes('- **Evidence:** —'), `Test 6 FAIL: TASK_STATUS.md stubs should include Last verified by and Evidence lines, got:\n${taskStatusOut}`);

    console.log('Test 6 passed: end-to-end applyDecompositionFromString() writes correct Repo/Repos lines and full TASK_STATUS stubs');

    if (prevRoot === undefined) delete process.env.MAVERICKS_PROJECT_ROOT;
    else process.env.MAVERICKS_PROJECT_ROOT = prevRoot;

    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    console.log('\nAll T-437 assertions passed.');
  });
}
