'use strict';
// Regression test: T-446 — Evidence write ergonomics in set-status/merge-task.
//
// Covers:
//   1. mergeCommitEvidence()/resolveCommitHash() unit behavior (lib-level).
//   2. End-to-end --set-status ... merged --commit <hash> --branch <name>:
//      prior Evidence text (e.g. QA notes) is preserved verbatim, commit+branch
//      appended, no duplication on repeat runs.
//   3. --commit HEAD resolves the current repo's HEAD short hash.
//   4. A format-valid but unreachable/unknown hash prints a non-blocking
//      warning naming the hash and branch; the write still proceeds.
//   5. Non-hex, non-HEAD input to --commit is rejected before any git
//      subprocess runs (no evidence written, non-zero exit).
//   6. Degrades silently (no warning, no crash) when git itself is unavailable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  resolveCommitHash,
  mergeCommitEvidence,
  isValidHashFormat,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const SET_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-status.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function gitQuiet(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Run mavp-operator-set-status.js with the given args, capturing stdout AND
 * stderr combined (the script's warnings go to console.warn / stderr, which
 * execFileSync alone would not capture).
 */
function runSetStatus(args, cwd, env) {
  const result = spawnSync(NODE_BIN, [SET_STATUS_PATH, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeFixture(root, taskId, status, evidence) {
  writeUtf8(path.join(root, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### ${taskId} — Fixture task
- **Status:** ${status}
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### ${taskId} — Fixture task
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** ${evidence}
- **Notes:** —

## Recently completed tasks
`);
}

function taskStatusEvidence(root, taskId) {
  const md = readUtf8(path.join(root, 'TASK_STATUS.md'));
  const escaped = taskId.replace('-', '\\-');
  const m = md.match(new RegExp(`###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Evidence:\\*\\*\\s+([^\\n]+)`, 'm'));
  return m ? m[1] : null;
}

function taskStatusStatus(root, taskId) {
  const md = readUtf8(path.join(root, 'TASK_STATUS.md'));
  const escaped = taskId.replace('-', '\\-');
  const m = md.match(new RegExp(`###\\s+${escaped}\\s+—[\\s\\S]*?- \\*\\*Status:\\*\\*\\s+(\\S+)`, 'm'));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Shared git fixture repo (used for reachable/unreachable/HEAD tests).
// ---------------------------------------------------------------------------
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't446-repo-'));
gitQuiet(REPO, ['init', '-q', '-b', 'main']);
gitQuiet(REPO, ['config', 'user.email', 'demo@example.invalid']);
gitQuiet(REPO, ['config', 'user.name', 'Test']);
writeUtf8(path.join(REPO, 'seed.txt'), 'hello\n');
gitQuiet(REPO, ['add', 'seed.txt']);
gitQuiet(REPO, ['commit', '-q', '-m', 'seed commit']);
const REAL_COMMIT = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const REAL_COMMIT_SHORT = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------------------
// Part 1 — unit: isValidHashFormat / mergeCommitEvidence / resolveCommitHash.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(isValidHashFormat('abc1234'), true, 'Test 1 FAIL: 7-char lowercase hex should be valid');
  assert.strictEqual(isValidHashFormat('ABC1234'), false, 'Test 1 FAIL: uppercase hex must be rejected (regex is lowercase only)');
  assert.strictEqual(isValidHashFormat('abc123'), false, 'Test 1 FAIL: 6-char hex (too short) must be rejected');
  assert.strictEqual(isValidHashFormat('not-a-hash!'), false, 'Test 1 FAIL: non-hex garbage must be rejected');
  assert.strictEqual(isValidHashFormat('HEAD'), false, 'Test 1 FAIL: "HEAD" itself does not match the hex regex (handled separately)');

  const merged1 = mergeCommitEvidence('qa notes: verified manually, all cases pass', 'abc1234', 'main');
  assert.strictEqual(
    merged1,
    'qa notes: verified manually, all cases pass commit: abc1234 branch: main',
    'Test 1 FAIL: mergeCommitEvidence should append, preserving prior text verbatim'
  );

  const merged2 = mergeCommitEvidence(merged1, 'def5678', 'develop');
  assert.strictEqual(
    merged2,
    'qa notes: verified manually, all cases pass commit: def5678 branch: develop',
    'Test 1 FAIL: mergeCommitEvidence should replace an existing commit/branch token in place, not duplicate'
  );
  assert.strictEqual((merged2.match(/commit:/g) || []).length, 1, 'Test 1 FAIL: exactly one "commit:" token expected after re-merge');

  const merged3 = mergeCommitEvidence('—', 'abc1234', 'main');
  assert.strictEqual(merged3, 'commit: abc1234 branch: main', 'Test 1 FAIL: an em-dash placeholder evidence should be treated as empty');

  console.log('Test 1 passed: isValidHashFormat / mergeCommitEvidence behave correctly');
}

// ---------------------------------------------------------------------------
// Part 2 — unit: resolveCommitHash — HEAD resolution, reachable, unreachable,
// invalid format, git-unavailable degrade.
// ---------------------------------------------------------------------------
{
  const headResult = resolveCommitHash(REPO, 'HEAD', 'main');
  assert.strictEqual(headResult.ok, true, 'Test 2a FAIL: HEAD resolution should succeed');
  assert.strictEqual(headResult.hash, REAL_COMMIT_SHORT, 'Test 2a FAIL: HEAD should resolve to the repo short hash');
  assert.strictEqual(headResult.warning, null, 'Test 2a FAIL: HEAD resolution should carry no warning');
  console.log(`Test 2a passed: --commit HEAD resolves to "${headResult.hash}"`);

  const reachableResult = resolveCommitHash(REPO, REAL_COMMIT.slice(0, 7), 'main');
  assert.strictEqual(reachableResult.ok, true, 'Test 2b FAIL: a reachable hash should be ok');
  assert.strictEqual(reachableResult.warning, null, `Test 2b FAIL: a reachable hash should not warn, got: ${reachableResult.warning}`);
  console.log('Test 2b passed: a hash reachable from the branch produces no warning');

  const unreachableResult = resolveCommitHash(REPO, 'deadbee', 'main');
  assert.strictEqual(unreachableResult.ok, true, 'Test 2c FAIL: an unreachable-but-format-valid hash must still be ok:true (non-blocking)');
  assert.ok(unreachableResult.warning, 'Test 2c FAIL: expected a warning for an unreachable/unknown hash');
  assert.ok(unreachableResult.warning.includes('deadbee'), 'Test 2c FAIL: warning should name the hash');
  assert.ok(unreachableResult.warning.includes('main'), 'Test 2c FAIL: warning should name the branch');
  console.log(`Test 2c passed: unreachable hash warns non-blockingly — "${unreachableResult.warning}"`);

  const invalidResult = resolveCommitHash(REPO, 'not-a-hash!', 'main');
  assert.strictEqual(invalidResult.ok, false, 'Test 2d FAIL: non-hex non-HEAD input must be rejected');
  assert.ok(invalidResult.error, 'Test 2d FAIL: expected an error message for invalid input');
  console.log(`Test 2d passed: non-hex input rejected — "${invalidResult.error}"`);

  // Degrade silently when git is unavailable: point resolveCommitHash at a
  // plain (non-git) directory. isInsideGitRepo() returns false there, so the
  // reachability check must produce no warning and not throw.
  const PLAIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't446-plain-'));
  const degradeResult = resolveCommitHash(PLAIN_DIR, 'abc1234', 'main');
  assert.strictEqual(degradeResult.ok, true, 'Test 2e FAIL: should still be ok:true outside a git repo');
  assert.strictEqual(degradeResult.warning, null, 'Test 2e FAIL: should degrade silently (no warning) outside a git repo');
  console.log('Test 2e passed: resolveCommitHash degrades silently (no warning, no throw) outside a git work tree');
  fs.rmSync(PLAIN_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — end-to-end: --set-status ... merged --commit <hash> --branch <name>
// against a real git fixture repo (REPO doubles as MAVERICKS_PROJECT_ROOT so
// git commands run against real history).
// ---------------------------------------------------------------------------
{
  // Start at ready_for_qa (a real, prior status) so the second call below is
  // a genuine status transition (qa_passed -> merged), not a same-status no-op
  // (the pre-existing "Status field not changed" skip guard is untouched by
  // this task and would suppress the file write on a same-status re-run).
  writeFixture(REPO, 'T-900', 'ready_for_qa', 'qa notes: verified manually, all cases pass');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const r1 = runSetStatus(['T-900', 'qa_passed', '--commit', REAL_COMMIT.slice(0, 7), '--branch', 'main'], REPO, env);
  const out1 = r1.output;
  assert.ok(!/Warning:/.test(out1), `Test 3a FAIL: expected no warning for a reachable hash, got:\n${out1}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-900'), 'qa_passed', 'Test 3a FAIL: expected status qa_passed');
  const ev1 = taskStatusEvidence(REPO, 'T-900');
  assert.ok(ev1.startsWith('qa notes: verified manually, all cases pass'), `Test 3a FAIL: prior QA text must be preserved verbatim, got: ${ev1}`);
  assert.ok(ev1.includes(`commit: ${REAL_COMMIT.slice(0, 7)} branch: main`), `Test 3a FAIL: expected commit+branch appended, got: ${ev1}`);
  console.log(`Test 3a passed: append-not-clobber — Evidence is now: "${ev1}"`);

  // Second, genuine status transition (qa_passed -> merged) with a different
  // (but still reachable) hash — the commit/branch token must be updated in
  // place, not duplicated, and the original QA text must still be intact.
  writeUtf8(path.join(REPO, 'seed2.txt'), 'second\n');
  gitQuiet(REPO, ['add', 'seed2.txt']);
  gitQuiet(REPO, ['commit', '-q', '-m', 'second commit']);
  const secondCommit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

  const r2 = runSetStatus(['T-900', 'merged', '--commit', secondCommit, '--branch', 'main'], REPO, env);
  const out2 = r2.output;
  assert.ok(!/Warning:/.test(out2), `Test 3b FAIL: expected no warning, got:\n${out2}`);
  const ev2 = taskStatusEvidence(REPO, 'T-900');
  assert.ok(ev2.startsWith('qa notes: verified manually, all cases pass'), `Test 3b FAIL: prior QA text must remain preserved, got: ${ev2}`);
  assert.ok(ev2.includes(`commit: ${secondCommit} branch: main`), `Test 3b FAIL: expected updated commit, got: ${ev2}`);
  assert.strictEqual((ev2.match(/commit:/g) || []).length, 1, `Test 3b FAIL: expected exactly one commit token, got: ${ev2}`);
  console.log(`Test 3b passed: a second genuine status transition updates commit/branch in place, no duplication — Evidence: "${ev2}"`);
}

// ---------------------------------------------------------------------------
// Part 4 — end-to-end: --commit HEAD resolves the repo HEAD hash.
// ---------------------------------------------------------------------------
{
  writeFixture(REPO, 'T-901', 'qa_passed', 'qa notes: HEAD test');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const { output: out } = runSetStatus(['T-901', 'merged', '--commit', 'HEAD', '--branch', 'main'], REPO, env);
  const headShort = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const ev = taskStatusEvidence(REPO, 'T-901');
  assert.ok(ev.includes(`commit: ${headShort} branch: main`), `Test 4 FAIL: expected HEAD resolved to "${headShort}", got: ${ev}`);
  assert.ok(!/Warning:/.test(out), `Test 4 FAIL: expected no warning for HEAD (always reachable from itself), got:\n${out}`);
  console.log(`Test 4 passed: --commit HEAD resolved and written as "${headShort}"`);
}

// ---------------------------------------------------------------------------
// Part 5 — end-to-end: an unreachable/unknown but format-valid hash warns,
// write still proceeds (non-blocking).
// ---------------------------------------------------------------------------
{
  writeFixture(REPO, 'T-902', 'qa_passed', 'qa notes: unreachable-hash test');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const { output: out } = runSetStatus(['T-902', 'merged', '--commit', 'deadbee', '--branch', 'main'], REPO, env);
  assert.ok(/Warning:.*deadbee.*main/.test(out), `Test 5 FAIL: expected a warning naming the hash and branch, got:\n${out}`);
  const ev = taskStatusEvidence(REPO, 'T-902');
  assert.ok(ev.includes('commit: deadbee branch: main'), `Test 5 FAIL: write should still proceed despite the warning, got: ${ev}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-902'), 'merged', 'Test 5 FAIL: status should still transition to merged (non-blocking)');
  console.log('Test 5 passed: unreachable-hash warning printed, write still proceeds');
}

// ---------------------------------------------------------------------------
// Part 6 — end-to-end: non-hex, non-HEAD input is rejected before any git
// subprocess runs (evidence untouched, non-zero exit).
// ---------------------------------------------------------------------------
{
  writeFixture(REPO, 'T-903', 'qa_passed', 'qa notes: reject-nonhex test');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const { status, output } = runSetStatus(['T-903', 'merged', '--commit', 'not-a-hash!', '--branch', 'main'], REPO, env);
  assert.notStrictEqual(status, 0, 'Test 6 FAIL: expected non-hex --commit input to exit non-zero');
  assert.ok(/Invalid commit hash/.test(output), `Test 6 FAIL: expected an invalid-hash error message, got:\n${output}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-903'), 'qa_passed', 'Test 6 FAIL: status must remain unchanged when --commit is rejected');
  const ev = taskStatusEvidence(REPO, 'T-903');
  assert.strictEqual(ev, 'qa notes: reject-nonhex test', 'Test 6 FAIL: evidence must remain untouched when --commit is rejected');
  console.log('Test 6 passed: non-hex --commit input rejected before any write, status/evidence untouched');
}

// ---------------------------------------------------------------------------
// Part 7 — end-to-end: degrades silently (no crash, no warning) when git
// itself is unavailable (PATH stripped so any `git ...` call fails ENOENT).
// ---------------------------------------------------------------------------
{
  writeFixture(REPO, 'T-904', 'qa_passed', 'qa notes: git-unavailable test');
  // Restrict PATH to only the directory containing the node binary itself, so
  // the validator subprocess (invoked via `node "<validator>"`) still resolves,
  // but any `git ...` call inside resolveCommitHash() fails with ENOENT.
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO, PATH: path.dirname(NODE_BIN) };

  const { output: out } = runSetStatus(['T-904', 'merged', '--commit', 'abc1234', '--branch', 'main'], REPO, env);
  assert.ok(!/Warning:/.test(out), `Test 7 FAIL: expected no warning when git is unavailable, got:\n${out}`);
  const ev = taskStatusEvidence(REPO, 'T-904');
  assert.ok(ev.includes('commit: abc1234 branch: main'), `Test 7 FAIL: write should still proceed when git is unavailable, got: ${ev}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-904'), 'merged', 'Test 7 FAIL: status should still transition to merged');
  console.log('Test 7 passed: degrades silently (no warning, no crash) when git is unavailable');
}

fs.rmSync(REPO, { recursive: true, force: true });

console.log('\nAll T-446 assertions passed.');
