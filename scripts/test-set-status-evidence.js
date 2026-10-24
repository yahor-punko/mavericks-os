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
//   7 (T-774) — --needs-fix-rounds <N> replaces an existing digit-valued
//      needs_fix_rounds: token in place (never appending a second one), or
//      inserts one when absent, on any target status; an invalid/missing
//      value exits 1 before any file is read or written.
//   8 (T-779) — explicit --commit/--needs-fix-rounds persist on a task already
//      at the target status; --from-skipped tasks get no write; the implicit
//      needs_fix_rounds: 0 auto-stamp requires a genuine transition.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  resolveCommitHash,
  mergeCommitEvidence,
  isValidHashFormat,
  locateTaskBlock,
  extractBlockField,
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

/**
 * Read a single field from a specific task's bounded block in a given
 * artifact file (T-608 regression coverage) — uses locateTaskBlock() /
 * extractBlockField(), the same canonical bounded reader the fixed
 * mavp-operator-set-status.js now consumes, so verification here can never
 * paper over a neighbor-block leak by reusing an equally-unbounded reader.
 * Returns null when the task/heading is absent, duplicated, or the field
 * itself is not present.
 */
function readBlockField(root, file, taskId, fieldName) {
  const md = readUtf8(path.join(root, file));
  const loc = locateTaskBlock(md, taskId);
  if (loc.count !== 1) return null;
  return extractBlockField(loc.rawBlock, fieldName);
}

/**
 * Read the full raw block text for a specific task (T-608 regression
 * coverage) — for byte-for-byte "this neighbor block was never touched"
 * comparisons. Returns null when the task/heading is absent or duplicated.
 */
function readRawBlock(root, file, taskId) {
  const md = readUtf8(path.join(root, file));
  const loc = locateTaskBlock(md, taskId);
  return loc.count === 1 ? loc.rawBlock : null;
}

/**
 * Fixture shaped like the T-608 problem statement: an active task
 * (targetId) with NO Evidence line sitting above an ARCHIVED neighbor
 * (archivedId, in "## Recently completed tasks") that DOES carry real
 * Evidence text. This is the exact shape that let the pre-T-608 unbounded
 * matchers read/write past the target block's boundary into the archived
 * one.
 */
function writeFixtureWithArchivedNeighbor(root, targetId, targetStatus, archivedId, archivedEvidence) {
  writeUtf8(path.join(root, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### ${targetId} — Fixture target task
- **Status:** ${targetStatus}
- **Owner role:** developer
- **Verification type:** runtime
`);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### ${targetId} — Fixture target task
- **Status:** ${targetStatus}
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —

## Recently completed tasks

### ${archivedId} — Fixture archived neighbor
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** ${archivedEvidence}
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

// ---------------------------------------------------------------------------
// Part 8 (T-608 regression) — end-to-end: a target block with NO Evidence
// line, sitting above an ARCHIVED neighbor block that carries a real
// Evidence commit. `--set-status <target> merged --commit <hash>` must
// INSERT an Evidence line into the TARGET's own block and leave the
// archived block byte-for-byte identical — the defect this task closes
// wrote the new commit into the archived block's Evidence field instead
// (and appended needs_fix_rounds onto it), because the pre-fix matchers'
// `[\s\S]*?` gap did not stop at the intervening "## Recently completed
// tasks" heading.
// ---------------------------------------------------------------------------
{
  writeFixtureWithArchivedNeighbor(REPO, 'T-950', 'ready_for_qa', 'T-951', 'commit: deadbee1 branch: main');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const archivedBefore = readRawBlock(REPO, 'TASK_STATUS.md', 'T-951');
  assert.ok(archivedBefore, 'Test 8 setup FAIL: T-951 fixture block should be present');
  assert.strictEqual(
    readBlockField(REPO, 'TASK_STATUS.md', 'T-950', 'Evidence'),
    null,
    'Test 8 setup FAIL: T-950 fixture must start with no Evidence field'
  );

  writeUtf8(path.join(REPO, 'seed3.txt'), 'third\n');
  gitQuiet(REPO, ['add', 'seed3.txt']);
  gitQuiet(REPO, ['commit', '-q', '-m', 'third commit']);
  const thirdCommit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

  runSetStatus(['T-950', 'merged', '--commit', thirdCommit, '--branch', 'main'], REPO, env);

  const targetEvidence = readBlockField(REPO, 'TASK_STATUS.md', 'T-950', 'Evidence');
  assert.ok(targetEvidence, 'Test 8 FAIL: expected an Evidence line to be INSERTED into the target block');
  assert.ok(
    targetEvidence.includes(`commit: ${thirdCommit} branch: main`),
    `Test 8 FAIL: expected target Evidence to carry the new commit, got: ${targetEvidence}`
  );
  assert.strictEqual(
    readBlockField(REPO, 'TASK_STATUS.md', 'T-950', 'Status'),
    'merged',
    'Test 8 FAIL: target status should transition to merged'
  );

  const archivedAfter = readRawBlock(REPO, 'TASK_STATUS.md', 'T-951');
  assert.strictEqual(
    archivedAfter,
    archivedBefore,
    'Test 8 FAIL: archived neighbor block must remain byte-for-byte identical — the pre-fix defect wrote the new commit (and needs_fix_rounds) into this block instead'
  );
  assert.strictEqual(
    readBlockField(REPO, 'TASK_STATUS.md', 'T-951', 'Evidence'),
    'commit: deadbee1 branch: main',
    "Test 8 FAIL: archived block must retain its own original commit hash, not the target's"
  );
  console.log(`Test 8 passed: Evidence-less target block gets Evidence inserted directly; archived neighbor untouched — target Evidence: "${targetEvidence}"`);
}

// ---------------------------------------------------------------------------
// Part 9 (T-608 regression) — end-to-end: the --from guard on a target
// block with NO Status line must skip with an explicit "currently unknown"
// warning, never comparing against an archived neighbor's Status. The
// fixture places the neighbor's Status EQUAL to --from's expected value —
// under the pre-fix unbounded matcher this made the guard treat a missing
// target status as a MATCH and proceed to mutate it; the fix must instead
// skip and leave both blocks untouched.
// ---------------------------------------------------------------------------
{
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  // T-952 exists ONLY in TASK_STATUS.md (no BACKLOG.md record at all), so the
  // guard's backlog-side read is forced to fall through to the TASK_STATUS
  // read this test targets — the vulnerable path.
  writeUtf8(path.join(REPO, 'BACKLOG.md'), `# BACKLOG

## Active Wave
`);
  writeUtf8(path.join(REPO, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-952 — Fixture missing-status task
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —

## Recently completed tasks

### T-953 — Fixture archived neighbor with matching status
- **Status:** ready_for_qa
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** commit: cafebabe branch: main
`);

  const neighborBefore = readRawBlock(REPO, 'TASK_STATUS.md', 'T-953');
  assert.strictEqual(
    readBlockField(REPO, 'TASK_STATUS.md', 'T-952', 'Status'),
    null,
    'Test 9 setup FAIL: T-952 fixture must start with no Status field'
  );

  const { output } = runSetStatus(['T-952', 'merged', '--from', 'ready_for_qa'], REPO, env);

  assert.ok(
    /currently "unknown", not "ready_for_qa" — skipped \(--from guard\)/.test(output),
    `Test 9 FAIL: expected an explicit "currently unknown" --from-guard warning, got:\n${output}`
  );
  assert.strictEqual(
    readBlockField(REPO, 'TASK_STATUS.md', 'T-952', 'Status'),
    null,
    'Test 9 FAIL: target must remain unchanged (still no Status field) after the guard skip'
  );
  const neighborAfter = readRawBlock(REPO, 'TASK_STATUS.md', 'T-953');
  assert.strictEqual(
    neighborAfter,
    neighborBefore,
    "Test 9 FAIL: archived neighbor's block must never be read into or mutated by the --from guard"
  );
  console.log('Test 9 passed: --from guard on a Status-less target skips with an explicit "currently unknown" warning, never matching a neighbor\'s status');
}

// ---------------------------------------------------------------------------
// Part 10 (T-774) — --needs-fix-rounds <N>: replaces an existing digit-valued
// needs_fix_rounds: token in place, inserts one when absent, applies on any
// target status (not only merged), and rejects an invalid/missing value
// before any file is read or written.
// ---------------------------------------------------------------------------
{
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  // (a) existing digit value gets REPLACED in place — exactly one match.
  // Uses a genuine status transition (ready_for_qa -> qa_passed) so the file
  // write actually fires — a same-status no-op is suppressed by the
  // pre-existing "Status field not changed" skip guard (untouched by this
  // task) and would leave the Evidence write unpersisted too.
  writeFixture(REPO, 'T-960', 'ready_for_qa', 'commit: abc1234 branch: main needs_fix_rounds: 0');
  const rA = runSetStatus(['T-960', 'qa_passed', '--needs-fix-rounds', '1'], REPO, env);
  assert.ok(!/Error:/.test(rA.output), `Test 10a FAIL: expected no error, got:\n${rA.output}`);
  const evA = taskStatusEvidence(REPO, 'T-960');
  assert.ok(evA.includes('needs_fix_rounds: 1'), `Test 10a FAIL: expected needs_fix_rounds: 1, got: ${evA}`);
  assert.strictEqual(
    (evA.match(/needs_fix_rounds:/g) || []).length,
    1,
    `Test 10a FAIL: expected exactly one needs_fix_rounds: token, got: ${evA}`
  );
  assert.ok(evA.includes('commit: abc1234 branch: main'), `Test 10a FAIL: prior commit evidence must be preserved, got: ${evA}`);
  console.log(`Test 10a passed: existing needs_fix_rounds: 0 replaced in place — Evidence: "${evA}"`);

  // (b) absent field + --needs-fix-rounds 2 on `merged` yields a single
  // needs_fix_rounds: 2 — no 0 stamped beside it (the auto-stamp branch must
  // not also fire).
  writeFixture(REPO, 'T-961', 'qa_passed', 'qa notes: no needs_fix_rounds yet');
  const rB = runSetStatus(['T-961', 'merged', '--needs-fix-rounds', '2'], REPO, env);
  assert.ok(!/Error:/.test(rB.output), `Test 10b FAIL: expected no error, got:\n${rB.output}`);
  assert.ok(/Evidence written: needs_fix_rounds: 2/.test(rB.output), `Test 10b FAIL: expected the explicit-write summary line, got:\n${rB.output}`);
  assert.ok(!/needs_fix_rounds: 0 added where absent/.test(rB.output), `Test 10b FAIL: the auto-stamp-0 line must not print when the flag is supplied, got:\n${rB.output}`);
  const evB = taskStatusEvidence(REPO, 'T-961');
  assert.ok(evB.includes('needs_fix_rounds: 2'), `Test 10b FAIL: expected needs_fix_rounds: 2, got: ${evB}`);
  assert.strictEqual(
    (evB.match(/needs_fix_rounds:/g) || []).length,
    1,
    `Test 10b FAIL: expected exactly one needs_fix_rounds: token (no stamped 0 beside it), got: ${evB}`
  );
  console.log(`Test 10b passed: absent field + --needs-fix-rounds 2 on merged yields a single token — Evidence: "${evB}"`);

  // (c) absent field, no flag, merged yields needs_fix_rounds: 0 — existing
  // behaviour preserved byte-for-byte.
  writeFixture(REPO, 'T-962', 'qa_passed', 'qa notes: no needs_fix_rounds yet either');
  const rC = runSetStatus(['T-962', 'merged'], REPO, env);
  assert.ok(/Evidence: needs_fix_rounds: 0 added where absent/.test(rC.output), `Test 10c FAIL: expected the legacy stamp-0 summary line, got:\n${rC.output}`);
  const evC = taskStatusEvidence(REPO, 'T-962');
  assert.ok(evC.includes('needs_fix_rounds: 0'), `Test 10c FAIL: expected needs_fix_rounds: 0, got: ${evC}`);
  console.log(`Test 10c passed: omitted flag preserves the existing auto-stamp-0-on-merged behaviour — Evidence: "${evC}"`);

  // (d) --needs-fix-rounds x exits 1 and the fixture file is unchanged (hash
  // compared) — rejected before any file is read or written.
  writeFixture(REPO, 'T-963', 'qa_passed', 'qa notes: reject-non-digit test');
  const taskStatusPath = path.join(REPO, 'TASK_STATUS.md');
  const backlogPath = path.join(REPO, 'BACKLOG.md');
  const hashOf = (p) => crypto.createHash('sha256').update(readUtf8(p)).digest('hex');
  const taskStatusHashBefore = hashOf(taskStatusPath);
  const backlogHashBefore = hashOf(backlogPath);
  const rD = runSetStatus(['T-963', 'merged', '--needs-fix-rounds', 'x'], REPO, env);
  assert.notStrictEqual(rD.status, 0, 'Test 10d FAIL: expected --needs-fix-rounds x to exit non-zero');
  assert.ok(/--needs-fix-rounds requires a non-negative integer value/.test(rD.output), `Test 10d FAIL: expected a usage/error line, got:\n${rD.output}`);
  assert.strictEqual(hashOf(taskStatusPath), taskStatusHashBefore, 'Test 10d FAIL: TASK_STATUS.md must be byte-for-byte unchanged when --needs-fix-rounds is rejected');
  assert.strictEqual(hashOf(backlogPath), backlogHashBefore, 'Test 10d FAIL: BACKLOG.md must be byte-for-byte unchanged when --needs-fix-rounds is rejected');
  assert.strictEqual(taskStatusStatus(REPO, 'T-963'), 'qa_passed', 'Test 10d FAIL: status must remain unchanged when --needs-fix-rounds is rejected');
  console.log('Test 10d passed: non-digit --needs-fix-rounds value rejected before any write, files byte-for-byte unchanged (hash compared)');

  // Also cover a missing value (flag at end of argv with nothing following).
  writeFixture(REPO, 'T-964', 'qa_passed', 'qa notes: missing-value test');
  const rE = runSetStatus(['T-964', 'merged', '--needs-fix-rounds'], REPO, env);
  assert.notStrictEqual(rE.status, 0, 'Test 10e FAIL: expected a missing --needs-fix-rounds value to exit non-zero');
  assert.ok(/--needs-fix-rounds requires a non-negative integer value/.test(rE.output), `Test 10e FAIL: expected a usage/error line, got:\n${rE.output}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-964'), 'qa_passed', 'Test 10e FAIL: status must remain unchanged when --needs-fix-rounds value is missing');
  console.log('Test 10e passed: missing --needs-fix-rounds value rejected before any write');
}

// ---------------------------------------------------------------------------
// Part 11 (T-779) — explicit evidence flags persist on a task already at the
// target status; a --from-skipped task receives no write of any kind; the
// implicit needs_fix_rounds: 0 auto-stamp fires only on a genuine transition.
// ---------------------------------------------------------------------------
{
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  const taskStatusPath = path.join(REPO, 'TASK_STATUS.md');
  const backlogPath = path.join(REPO, 'BACKLOG.md');
  const hashOf = (p) => crypto.createHash('sha256').update(readUtf8(p)).digest('hex');

  // A second reachable commit (short hash) distinct from REAL_COMMIT_SHORT.
  gitQuiet(REPO, ['commit', '-q', '--allow-empty', '-m', 'second commit']);
  const SECOND_COMMIT_SHORT = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notStrictEqual(SECOND_COMMIT_SHORT, REAL_COMMIT_SHORT, 'Test 11 setup FAIL: need two distinct reachable hashes');

  // (a) already-merged task, --needs-fix-rounds 2 alone: persisted.
  const fixtureA = () =>
    writeFixture(REPO, 'T-970', 'merged', `commit: ${REAL_COMMIT_SHORT} branch: main needs_fix_rounds: 0`);
  fixtureA();
  const rA = runSetStatus(['T-970', 'merged', '--needs-fix-rounds', '2'], REPO, env);
  assert.notStrictEqual(rA.status, 2, `Test 11a FAIL: exit must not be 2, got:\n${rA.output}`);
  const evA = taskStatusEvidence(REPO, 'T-970');
  assert.ok(evA.includes('needs_fix_rounds: 2'), `Test 11a FAIL: expected needs_fix_rounds: 2, got: ${evA}`);
  assert.ok(evA.includes(`commit: ${REAL_COMMIT_SHORT} branch: main`), `Test 11a FAIL: hash+branch must be preserved, got: ${evA}`);
  assert.strictEqual((evA.match(/needs_fix_rounds:/g) || []).length, 1, `Test 11a FAIL: expected exactly one needs_fix_rounds: token, got: ${evA}`);
  assert.strictEqual(taskStatusStatus(REPO, 'T-970'), 'merged', 'Test 11a FAIL: Status must remain merged');
  assert.ok(/Evidence updated, status unchanged \(1\): T-970/.test(rA.output), `Test 11a FAIL: expected the evidence-updated summary line, got:\n${rA.output}`);
  assert.ok(!/Skipped/.test(rA.output), `Test 11a FAIL: task must not be reported Skipped, got:\n${rA.output}`);
  console.log(`Test 11a passed: same-status --needs-fix-rounds persisted — Evidence: "${evA}"`);

  // (b) same shape with --commit <other reachable hash> alone. Existing
  // mergeCommitEvidence() REPLACES an existing commit/branch token in place
  // (and preserves the surrounding text) — asserted as-is; merge semantics
  // are not changed by this task.
  fixtureA();
  const rB = runSetStatus(['T-970', 'merged', '--commit', SECOND_COMMIT_SHORT], REPO, env);
  assert.notStrictEqual(rB.status, 2, `Test 11b FAIL: exit must not be 2, got:\n${rB.output}`);
  const evB = taskStatusEvidence(REPO, 'T-970');
  assert.strictEqual(
    evB,
    `commit: ${SECOND_COMMIT_SHORT} branch: main needs_fix_rounds: 0`,
    `Test 11b FAIL: commit token must be replaced in place with prior text preserved, got: ${evB}`
  );
  assert.ok(!evB.includes(REAL_COMMIT_SHORT), `Test 11b FAIL: old hash must be gone (replaced, not appended), got: ${evB}`);
  assert.ok(/Evidence updated, status unchanged \(1\): T-970/.test(rB.output), `Test 11b FAIL: expected the evidence-updated summary line, got:\n${rB.output}`);
  console.log(`Test 11b passed: same-status --commit persisted (replaced in place) — Evidence: "${evB}"`);

  // (c) --from-skipped task: byte-identical, warning names the --from guard.
  writeFixture(REPO, 'T-971', 'qa_passed', 'qa notes: from-guard test');
  const tsHashC = hashOf(taskStatusPath);
  const blHashC = hashOf(backlogPath);
  const rC = runSetStatus(['T-971', 'merged', '--from', 'ready_for_qa', '--needs-fix-rounds', '3'], REPO, env);
  assert.strictEqual(hashOf(taskStatusPath), tsHashC, 'Test 11c FAIL: TASK_STATUS.md must be byte-identical for a --from-skipped task');
  assert.strictEqual(hashOf(backlogPath), blHashC, 'Test 11c FAIL: BACKLOG.md must be byte-identical for a --from-skipped task');
  assert.ok(/--from guard/.test(rC.output), `Test 11c FAIL: expected the --from guard warning, got:\n${rC.output}`);
  console.log('Test 11c passed: --from-skipped task receives no write (hash compared), --from guard warning printed');

  // (d) already-merged, no needs_fix_rounds:, no flags: no auto-stamp, no write.
  writeFixture(REPO, 'T-972', 'merged', `commit: ${REAL_COMMIT_SHORT} branch: main`);
  const tsHashD = hashOf(taskStatusPath);
  const rD = runSetStatus(['T-972', 'merged'], REPO, env);
  assert.strictEqual(hashOf(taskStatusPath), tsHashD, 'Test 11d FAIL: TASK_STATUS.md must be byte-identical (auto-stamp needs a transition)');
  assert.ok(!/needs_fix_rounds/.test(readUtf8(taskStatusPath)), 'Test 11d FAIL: no needs_fix_rounds token may appear');
  assert.ok(!/needs_fix_rounds: 0 added where absent/.test(rD.output), `Test 11d FAIL: stamp summary line must not print, got:\n${rD.output}`);
  console.log('Test 11d passed: same-status merged with no flags writes nothing and stamps nothing');

  // (e) two-task batch: T-973 transitions, T-974 is same-status with
  // --needs-fix-rounds 1 — both persisted, T-974 under the evidence line.
  writeUtf8(backlogPath, `# BACKLOG

## Active Wave

### T-973 — Fixture transitioning task
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-974 — Fixture same-status task
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  writeUtf8(taskStatusPath, `# TASK_STATUS

## Active tasks

### T-973 — Fixture transitioning task
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** qa notes: batch test
- **Notes:** —

### T-974 — Fixture same-status task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** commit: ${REAL_COMMIT_SHORT} branch: main needs_fix_rounds: 0
- **Notes:** —

## Recently completed tasks
`);
  const rE = runSetStatus(['T-973,T-974', 'merged', '--needs-fix-rounds', '1'], REPO, env);
  assert.strictEqual(taskStatusStatus(REPO, 'T-973'), 'merged', 'Test 11e FAIL: T-973 must transition');
  assert.ok(taskStatusEvidence(REPO, 'T-973').includes('needs_fix_rounds: 1'), 'Test 11e FAIL: T-973 evidence must carry needs_fix_rounds: 1');
  const evE = taskStatusEvidence(REPO, 'T-974');
  assert.strictEqual(evE, `commit: ${REAL_COMMIT_SHORT} branch: main needs_fix_rounds: 1`, `Test 11e FAIL: T-974 evidence must be updated, got: ${evE}`);
  assert.ok(/Updated \(1\): T-973/.test(rE.output), `Test 11e FAIL: expected T-973 in the Updated line, got:\n${rE.output}`);
  assert.ok(/Evidence updated, status unchanged \(1\): T-974/.test(rE.output), `Test 11e FAIL: expected T-974 in the evidence-updated line, got:\n${rE.output}`);
  console.log('Test 11e passed: batch persists the transitioning task and the same-status evidence-only task');

  // (f) named mutant: reverting the write condition to `if (updated.length > 0)`
  // makes (a)'s evidence-only write vanish. Toggled in-process on the real
  // source with an unconditional restore.
  {
    const original = readUtf8(SET_STATUS_PATH);
    const liveCondition = 'if (backlog !== backlogAsRead || taskStatus !== taskStatusAsRead) {';
    assert.ok(original.includes(liveCondition), 'Test 11f setup FAIL: live write condition not found in source');
    const mutant = original.replace(liveCondition, 'if (updated.length > 0) {');
    assert.notStrictEqual(mutant, original, 'Test 11f setup FAIL: mutation did not change the source');
    let redBytesIdentical;
    try {
      writeUtf8(SET_STATUS_PATH, mutant);
      fixtureA();
      const before = hashOf(taskStatusPath);
      runSetStatus(['T-970', 'merged', '--needs-fix-rounds', '2'], REPO, env);
      redBytesIdentical = hashOf(taskStatusPath) === before;
    } finally {
      writeUtf8(SET_STATUS_PATH, original);
    }
    assert.strictEqual(readUtf8(SET_STATUS_PATH), original, 'Test 11f FAIL: source must be restored byte-for-byte');
    assert.strictEqual(redBytesIdentical, true, 'Test 11f FAIL (red): under the updated.length > 0 mutant, the same-status write must NOT persist');
    fixtureA();
    const beforeGreen = hashOf(taskStatusPath);
    runSetStatus(['T-970', 'merged', '--needs-fix-rounds', '2'], REPO, env);
    assert.notStrictEqual(hashOf(taskStatusPath), beforeGreen, 'Test 11f FAIL (green): restored source must persist the same-status write');
    console.log('Test 11f passed: mutant (updated.length > 0) leaves file byte-identical [red]; restored source persists it [green]');
  }

  // (g) annotated-only Evidence block already at target status, with
  // --needs-fix-rounds 1: refused by the T-778 gate — exit 1, byte-identical.
  writeFixture(REPO, 'T-975', 'merged', 'commit: abc1234 branch: main');
  writeUtf8(
    taskStatusPath,
    readUtf8(taskStatusPath).replace('- **Evidence:**', '- **Evidence (2026-09-20, QA):**')
  );
  const tsHashG = hashOf(taskStatusPath);
  const blHashG = hashOf(backlogPath);
  const rG = runSetStatus(['T-975', 'merged', '--needs-fix-rounds', '1'], REPO, env);
  assert.strictEqual(rG.status, 1, `Test 11g FAIL: expected exit 1, got ${rG.status}:\n${rG.output}`);
  assert.ok(/refusing to write/.test(rG.output), `Test 11g FAIL: expected the T-778 refusal, got:\n${rG.output}`);
  assert.strictEqual(hashOf(taskStatusPath), tsHashG, 'Test 11g FAIL: TASK_STATUS.md must be byte-identical');
  assert.strictEqual(hashOf(backlogPath), blHashG, 'Test 11g FAIL: BACKLOG.md must be byte-identical');
  console.log('Test 11g passed: annotated-only Evidence at target status refused by the T-778 gate (exit 1, byte-identical)');
}

fs.rmSync(REPO, { recursive: true, force: true });

console.log('\nAll T-446 / T-608 / T-774 / T-779 assertions passed.');
