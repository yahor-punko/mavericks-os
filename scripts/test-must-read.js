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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execSync, execFileSync } = require('node:child_process');

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
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-391 assertions passed.');
