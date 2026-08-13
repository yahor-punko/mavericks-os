'use strict';
// Regression test: T-391 — compute must-read set at session start.
//
// Covers:
//   1. findPreviousCloseSessionCommit() locates the most recent
//      "chore: close session ..." commit marker, walking back from HEAD.
//   2. getFilesChangedSincePreviousCloseSession() returns files changed
//      (committed) since that marker commit.
//   3. Both degrade silently (return null / [], never throw) when there is
//      no close-session commit in history, and when the root is not a git
//      repository at all (git unavailable).
//   4. computeMustRead() unions changed files with context_docs already
//      resolved onto activeSlices, deduplicated.
//   5. Integration: --agent JSON's additive `must_read` field includes both
//      a file changed since the previous close-session commit AND the
//      context_docs declared by an in-flight task's module — the literal
//      acceptance criterion.
//   6. Integration: `must_read` is omitted entirely from --agent JSON when
//      the combined set is empty.
//   7. Integration: --agent JSON still parses (no throw / no crash) when
//      MAVERICKS_PROJECT_ROOT is not a git repository at all.
//   T-644 additions — the working tree, not just committed history, feeds
//   the must-read set:
//   9.  a committed change (A), an uncommitted tracked edit (B), and a new
//       untracked file (C), all made after the close-session marker, ALL
//       appear in computeMustRead()'s output (kills the commit-to-commit-only
//       mutant — i.e. a revert to `git diff <marker> HEAD` alone would drop
//       B and C).
//   10. with a clean working tree (no uncommitted/untracked changes), the
//       output is byte-identical to today's (A only) — no regression.
//   11. untracked discovery respects .gitignore: an ignored untracked file
//       does not appear in the output.
//   12. degrade-silently posture is preserved for the extended function:
//       git unavailable still yields [] and never throws (already exercised
//       by Test 4 above against the new three-call implementation).
//   T-644 fix round 1 — the three calls no longer share one try/catch:
//   13. with call 1 (committed changes) backed by real content and call 3
//       (untracked-file discovery) made to fail via a module-boundary
//       injection (monkey-patching `child_process.execSync`, restored
//       immediately after), the function still returns call 1's file
//       rather than discarding it and returning [] — this is the exact
//       defect QA found in the shared try/catch.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execSync, execFileSync } = require('node:child_process');
// Separate module-object reference (not destructured) so Test 13 can
// monkey-patch the shared `execSync` property through the module boundary
// without disturbing the `execSync`/`execFileSync` bindings this file
// already captured above at require time.
const childProcessModule = require('node:child_process');

const {
  computeMustRead,
  findPreviousCloseSessionCommit,
  getFilesChangedSincePreviousCloseSession,
} = require('./mavp-operator-lib.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't391-must-read-'));

function git(root, cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build a fixture git repo at TMP_DIR/name with:
 *   1. an initial commit
 *   2. a "chore: close session 2026-01-01" marker commit
 *   3. a follow-up commit that modifies `changedFile` (post-close-session work)
 * Returns the fixture root path.
 */
function makeGitFixture(name, { changedFile = 'src/changed.js' } = {}) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  fs.writeFileSync(path.join(root, 'SESSION.md'), 'session close snapshot\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "chore: close session 2026-01-01"');
  const markerHash = git(root, 'rev-parse HEAD').trim();

  fs.mkdirSync(path.join(root, path.dirname(changedFile)), { recursive: true });
  fs.writeFileSync(path.join(root, changedFile), 'console.log("changed this session");\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "T-391: do some work this session"');

  return { root, markerHash };
}

// ---------------------------------------------------------------------------
// Test 1: findPreviousCloseSessionCommit() locates the marker commit.
// ---------------------------------------------------------------------------
{
  const { root, markerHash } = makeGitFixture('marker-fixture');
  const found = findPreviousCloseSessionCommit(root);
  assert.strictEqual(found, markerHash, 'Test 1 FAIL: expected the "chore: close session" commit hash');
  console.log('Test 1 passed: findPreviousCloseSessionCommit() locates the close-session marker commit');
}

// ---------------------------------------------------------------------------
// Test 2: getFilesChangedSincePreviousCloseSession() returns files changed
// after the marker commit.
// ---------------------------------------------------------------------------
{
  const { root } = makeGitFixture('changed-files-fixture', { changedFile: 'src/x.js' });
  const changed = getFilesChangedSincePreviousCloseSession(root);
  assert.ok(changed.includes('src/x.js'), `Test 2 FAIL: expected "src/x.js" in changed files, got: ${JSON.stringify(changed)}`);
  assert.ok(!changed.includes('SESSION.md'), 'Test 2 FAIL: SESSION.md was committed as part of the marker commit itself, should not appear as "changed since"');
  assert.ok(!changed.includes('README.md'), 'Test 2 FAIL: README.md predates the marker commit, should not appear as "changed since"');
  console.log('Test 2 passed: getFilesChangedSincePreviousCloseSession() returns only files changed after the marker commit');
}

// ---------------------------------------------------------------------------
// Test 3: no close-session commit anywhere in history -> degrades to
// null / [] without throwing.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'no-marker-fixture');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "just a normal commit, no close-session marker"');

  let marker, changed;
  assert.doesNotThrow(() => { marker = findPreviousCloseSessionCommit(root); }, 'Test 3 FAIL: findPreviousCloseSessionCommit must not throw');
  assert.doesNotThrow(() => { changed = getFilesChangedSincePreviousCloseSession(root); }, 'Test 3 FAIL: getFilesChangedSincePreviousCloseSession must not throw');
  assert.strictEqual(marker, null, 'Test 3 FAIL: expected null when no close-session commit exists');
  assert.deepStrictEqual(changed, [], 'Test 3 FAIL: expected [] when no close-session commit exists');
  console.log('Test 3 passed: no close-session commit in history degrades to null/[] without throwing');
}

// ---------------------------------------------------------------------------
// Test 4: root is not a git repository at all (git unavailable for this
// path) -> degrades silently, no throw.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'not-a-git-repo');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');

  let marker, changed, mustRead;
  assert.doesNotThrow(() => { marker = findPreviousCloseSessionCommit(root); }, 'Test 4 FAIL: findPreviousCloseSessionCommit must not throw on a non-git dir');
  assert.doesNotThrow(() => { changed = getFilesChangedSincePreviousCloseSession(root); }, 'Test 4 FAIL: getFilesChangedSincePreviousCloseSession must not throw on a non-git dir');
  assert.doesNotThrow(() => { mustRead = computeMustRead(root, []); }, 'Test 4 FAIL: computeMustRead must not throw on a non-git dir');
  assert.strictEqual(marker, null, 'Test 4 FAIL: expected null on a non-git dir');
  assert.deepStrictEqual(changed, [], 'Test 4 FAIL: expected [] on a non-git dir');
  assert.deepStrictEqual(mustRead, [], 'Test 4 FAIL: expected [] must-read set on a non-git dir with no context_docs');
  console.log('Test 4 passed: a non-git directory degrades silently (no throw) to null/[]');
}

// ---------------------------------------------------------------------------
// Test 5: computeMustRead() unions changed files with context_docs already
// resolved onto activeSlices, deduplicated.
// ---------------------------------------------------------------------------
{
  const { root } = makeGitFixture('compute-must-read-fixture', { changedFile: 'src/y.js' });
  const activeSlices = [
    { id: 'T-900', context_docs: ['docs/AGENT_SPEC.md', 'src/y.js'] }, // src/y.js overlaps with changed files -> dedup
    { id: 'T-901' }, // no context_docs -> ignored
  ];
  const mustRead = computeMustRead(root, activeSlices);
  assert.ok(mustRead.includes('src/y.js'), 'Test 5 FAIL: expected changed file "src/y.js" in must-read set');
  assert.ok(mustRead.includes('docs/AGENT_SPEC.md'), 'Test 5 FAIL: expected context_docs entry "docs/AGENT_SPEC.md" in must-read set');
  const occurrences = mustRead.filter((f) => f === 'src/y.js').length;
  assert.strictEqual(occurrences, 1, 'Test 5 FAIL: "src/y.js" should be deduplicated, appeared more than once');
  console.log('Test 5 passed: computeMustRead() unions changed files and context_docs, deduplicated');
}

// ---------------------------------------------------------------------------
// Integration fixtures: --agent JSON via MAVERICKS_PROJECT_ROOT.
// ---------------------------------------------------------------------------

const AGENT_SCRIPT = path.join(__dirname, 'mavp-operator-agent.js');

const MODULES_FIXTURE = `# Module Registry — Schema Reference

## test-module

- **label:** Test Module
- **repos:** test-repo
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/AGENT_SPEC.md
- **default_owner:** developer
- **qa_checklist:**
  - Check the thing
`;

const BACKLOG_FIXTURE = `# Backlog

## Active Wave

### T-900 — Fixture task with module
- **Status:** in_progress
- **Owner role:** developer
- **Module:** test-module
- **Verification type:** unit

**Problem:** Fixture problem statement.

**Acceptance criteria:** Fixture acceptance criteria.
`;

const TASK_STATUS_FIXTURE = `# Task Status

## Active tasks

### T-900 — Fixture task with module
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —
`;

const BACKLOG_NO_TASKS = `# Backlog

## Active Wave

`;

const TASK_STATUS_NO_TASKS = `# Task Status

## Active tasks

`;

function addMinimalState(root, { backlog = BACKLOG_FIXTURE, taskStatus = TASK_STATUS_FIXTURE } = {}) {
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), taskStatus, 'utf8');
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify({ initiative: 'fixture-init', stage: 'execution', wave: 1, active_slices: ['T-900'] }, null, 2) + '\n',
    'utf8'
  );
}

function runAgent(projectRoot) {
  const stdout = execFileSync('node', [AGENT_SCRIPT], {
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: projectRoot },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Test 6: --agent JSON's must_read field includes a file changed since the
// previous close-session commit AND the context_docs declared by an
// in-flight task's module — the literal T-391 acceptance criterion.
// ---------------------------------------------------------------------------
{
  const { root } = makeGitFixture('agent-integration-fixture', { changedFile: 'src/must-read-me.js' });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), MODULES_FIXTURE, 'utf8');
  addMinimalState(root);

  const output = runAgent(root);
  assert.ok(Array.isArray(output.must_read), 'Test 6 FAIL: expected output.must_read to be an array');
  assert.ok(
    output.must_read.includes('src/must-read-me.js'),
    `Test 6 FAIL: expected must_read to include the file changed since close-session, got: ${JSON.stringify(output.must_read)}`
  );
  assert.ok(
    output.must_read.includes('docs/AGENT_SPEC.md'),
    `Test 6 FAIL: expected must_read to include the in-flight task's context_docs, got: ${JSON.stringify(output.must_read)}`
  );
  console.log('Test 6 passed: --agent must_read includes both the changed file (X) and the in-flight task context_docs (Y)');
}

// ---------------------------------------------------------------------------
// Test 7: must_read is omitted entirely from --agent JSON when the combined
// set is empty (no git repo, no in-flight tasks/context_docs).
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'agent-empty-fixture');
  fs.mkdirSync(root, { recursive: true });
  addMinimalState(root, { backlog: BACKLOG_NO_TASKS, taskStatus: TASK_STATUS_NO_TASKS });

  const output = runAgent(root);
  assert.ok(!('must_read' in output), `Test 7 FAIL: expected must_read to be omitted when empty, got: ${JSON.stringify(output.must_read)}`);
  console.log('Test 7 passed: --agent omits must_read entirely when the combined set is empty');
}

// ---------------------------------------------------------------------------
// Test 8: --agent JSON still parses without error when MAVERICKS_PROJECT_ROOT
// is not a git repository at all (git unavailable for that path) — this
// task's in-flight module context_docs still surface, changed-files portion
// degrades silently.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'agent-no-git-fixture');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), MODULES_FIXTURE, 'utf8');
  addMinimalState(root);

  let output;
  assert.doesNotThrow(() => { output = runAgent(root); }, 'Test 8 FAIL: --agent must not throw/crash when root is not a git repository');
  assert.ok(
    output.must_read && output.must_read.includes('docs/AGENT_SPEC.md'),
    `Test 8 FAIL: expected must_read to still include context_docs even with no git repo, got: ${JSON.stringify(output.must_read)}`
  );
  console.log('Test 8 passed: --agent JSON still parses and surfaces context_docs when MAVERICKS_PROJECT_ROOT is not a git repository');
}

// ---------------------------------------------------------------------------
// T-644: working-tree fixture builder.
//
// Builds a fixture repo whose last "chore: close session ..." commit is
// followed by:
//   (a) a committed change to fileA.js
//   (b) an uncommitted tracked edit to fileB.js (tracked since before the
//       marker commit, edited after it, never re-committed)
//   (c) a new untracked file fileC.js
// Optionally also seeds a .gitignore covering `ignored.log` plus an
// untracked `ignored.log` file, to exercise .gitignore-respecting discovery.
// ---------------------------------------------------------------------------
function makeWorkingTreeFixture(name, { withGitignore = false } = {}) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'fileB.js'), 'console.log("original B");\n', 'utf8');
  if (withGitignore) {
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.log\n', 'utf8');
  }
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');

  fs.writeFileSync(path.join(root, 'SESSION.md'), 'session close snapshot\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "chore: close session 2026-01-01"');

  // (a) committed change to fileA.js, after the marker.
  fs.writeFileSync(path.join(root, 'fileA.js'), 'console.log("committed A");\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "T-644: committed work this session"');

  // (b) uncommitted tracked edit to fileB.js — never re-committed. Simulates
  // an abruptly-dead session's in-progress edit to a tracked file.
  fs.writeFileSync(path.join(root, 'fileB.js'), 'console.log("uncommitted edit to B");\n', 'utf8');

  // (c) new untracked file fileC.js. Simulates a new file (e.g. an
  // EXECUTION_LOG.md entry) the dead session never `git add`ed.
  fs.writeFileSync(path.join(root, 'fileC.js'), 'console.log("untracked C");\n', 'utf8');

  if (withGitignore) {
    // Untracked but ignored — must never appear in the must-read set.
    fs.writeFileSync(path.join(root, 'ignored.log'), 'noise\n', 'utf8');
  }

  return root;
}

// ---------------------------------------------------------------------------
// Test 9: committed (A), uncommitted tracked (B), and untracked (C) changes
// after the close-session marker ALL appear in computeMustRead()'s output.
// ---------------------------------------------------------------------------
{
  const root = makeWorkingTreeFixture('working-tree-fixture');
  const mustRead = computeMustRead(root, []);
  assert.ok(mustRead.includes('fileA.js'), `Test 9 FAIL: expected committed change "fileA.js" in must-read set, got: ${JSON.stringify(mustRead)}`);
  assert.ok(mustRead.includes('fileB.js'), `Test 9 FAIL: expected uncommitted tracked edit "fileB.js" in must-read set, got: ${JSON.stringify(mustRead)}`);
  assert.ok(mustRead.includes('fileC.js'), `Test 9 FAIL: expected untracked file "fileC.js" in must-read set, got: ${JSON.stringify(mustRead)}`);
  console.log('Test 9 passed: computeMustRead() includes committed (A), uncommitted tracked (B), and untracked (C) changes made after the close-session marker');
}

// ---------------------------------------------------------------------------
// Test 10: with a clean working tree, the output is byte-identical to
// today's behavior (A only — no regression from the working-tree extension).
// ---------------------------------------------------------------------------
{
  const { root } = makeGitFixture('clean-tree-fixture', { changedFile: 'src/onlyA.js' });
  const changed = getFilesChangedSincePreviousCloseSession(root);
  assert.deepStrictEqual(
    changed.slice().sort(),
    ['src/onlyA.js'],
    `Test 10 FAIL: expected exactly ["src/onlyA.js"] on a clean working tree, got: ${JSON.stringify(changed)}`
  );
  console.log('Test 10 passed: a clean working tree yields exactly the committed change (A only) — no regression');
}

// ---------------------------------------------------------------------------
// Test 11: untracked discovery respects .gitignore — an ignored untracked
// file does not appear in the output.
// ---------------------------------------------------------------------------
{
  const root = makeWorkingTreeFixture('gitignore-fixture', { withGitignore: true });
  const mustRead = computeMustRead(root, []);
  assert.ok(!mustRead.includes('ignored.log'), `Test 11 FAIL: expected ignored untracked "ignored.log" to be excluded, got: ${JSON.stringify(mustRead)}`);
  // Sanity: the non-ignored untracked file from the same fixture still shows up.
  assert.ok(mustRead.includes('fileC.js'), `Test 11 FAIL: expected non-ignored untracked "fileC.js" to still appear, got: ${JSON.stringify(mustRead)}`);
  console.log('Test 11 passed: untracked discovery respects .gitignore — ignored files are excluded, non-ignored untracked files still appear');
}

// ---------------------------------------------------------------------------
// Test 12: degrade-silently posture is preserved for the extended (three
// git-call) implementation — a non-git directory still yields [] and never
// throws (re-asserts Test 4's contract against the new implementation).
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'not-a-git-repo-extended');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');

  let changed;
  assert.doesNotThrow(() => { changed = getFilesChangedSincePreviousCloseSession(root); }, 'Test 12 FAIL: getFilesChangedSincePreviousCloseSession must not throw on a non-git dir');
  assert.deepStrictEqual(changed, [], 'Test 12 FAIL: expected [] on a non-git dir with the extended implementation');
  console.log('Test 12 passed: degrade-silently posture preserved for the extended (working-tree-aware) implementation');
}

// ---------------------------------------------------------------------------
// Test 13: call 3 (untracked-file discovery) is made to throw via a
// module-boundary injection — monkey-patching `child_process.execSync` to
// throw only for the `git ls-files` invocation, restored in a finally block
// immediately after. Call 1 (committed changes) has real content in this
// fixture. Before this fix, all three calls shared one try/catch, so call
// 3's throw discarded call 1's already-successful result and the function
// returned []. After this fix, call 1's result must survive.
// ---------------------------------------------------------------------------
{
  const { root } = makeGitFixture('call3-failure-fixture', { changedFile: 'src/survivesCall3.js' });

  const originalExecSync = childProcessModule.execSync;
  childProcessModule.execSync = function patchedExecSync(command, options) {
    if (typeof command === 'string' && command.includes('ls-files')) {
      throw new Error('T-644 Test 13: injected failure simulating ENOBUFS on git ls-files');
    }
    return originalExecSync(command, options);
  };

  let changed;
  try {
    assert.doesNotThrow(
      () => { changed = getFilesChangedSincePreviousCloseSession(root); },
      'Test 13 FAIL: getFilesChangedSincePreviousCloseSession must not throw even when the untracked-file call throws'
    );
  } finally {
    childProcessModule.execSync = originalExecSync;
  }

  assert.ok(
    changed.includes('src/survivesCall3.js'),
    `Test 13 FAIL: expected call 1's result "src/survivesCall3.js" to survive call 3's injected failure, got: ${JSON.stringify(changed)}`
  );
  console.log('Test 13 passed: call 1\'s result survives when call 3 (untracked-file discovery) throws — the three git calls are independently guarded');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-391/T-644 assertions passed.');
