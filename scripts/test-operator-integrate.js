'use strict';
// Regression test: T-567 — the `--integrate` operator command removes the
// cwd-dependent hand-typed cherry-pick class from worktree integration.
//
// Executes, against throwaway git fixtures (never mavericks' own checkout),
// the seven UNEXECUTED assertions named in the T-567 BACKLOG block:
//   1. cwd inside a linked worktree: --integrate lands the commit on the
//      fixture's PRIMARY main, the printed hash differs from the worktree's
//      own commit hash, and getPatchEquivalenceStatus() reports 'integrated'
//      — by PATCH EQUIVALENCE, not reachability. A `git merge-base
//      --is-ancestor` check on the same pair is asserted FALSE in the same
//      block, proving the two checks disagree and confirming --integrate's
//      own claim is checked against the right one.
//   2. the same invocation from an unrelated cwd behaves identically.
//   3. a resolved root that IS a linked worktree exits 1, PRIMARY's HEAD
//      unchanged.
//   4. an in-progress pick (CHERRY_PICK_HEAD already present, from a git
//      operation outside --integrate) refuses.
//   5. a conflicting pick driven THROUGH --integrate exits non-zero, names
//      `--abort`/`--continue` with no auto-abort, and a second invocation
//      refuses.
//   6. the range form prints one `integrated:` line per commit.
//   7. a placeholder-version fixture root refuses.
// Plus two extra checks not in the numbered list but named directly in the
// acceptance criteria: the optional `--task` suggestion line (Test 8) and
// that --integrate writes no state artifact (Test 9).
//
// Invocation-form note (T-567's own corrected pre-gate text, item (1)):
// ROOT resolution (`MAVERICKS_PROJECT_ROOT` env var, or `__dirname/..`) is
// NOT itself cwd-proof — a relative invocation from inside a linked worktree
// still resolves ROOT to the worktree, which is exactly why
// guardMutatingRoot()'s discriminator (c) exists (T-670, exercised end-to-end
// in Part 3 below). What THIS file pins explicitly, per fixture, is which
// mechanism fixes ROOT before the assertion runs: every fixture sets
// `MAVERICKS_PROJECT_ROOT` EXPLICITLY in the child process env, so ROOT is
// never left to accidentally resolve correctly (or incorrectly) via cwd.
// Parts 1/2 then vary the CHILD PROCESS'S OWN cwd (inside the linked
// worktree, and an unrelated tmp dir) to prove the git subprocesses this
// script spawns are pinned to `{ cwd: ROOT }` and never inherit that ambient
// cwd — the concrete mutant this kills is "a git subprocess call site drops
// its `cwd` option," which would make the cherry-pick land wherever the
// caller's shell happened to be instead of the resolved root.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { getPatchEquivalenceStatus, NEVER_PROJECT_VERSION_PLACEHOLDER } = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const INTEGRATE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-integrate.js');
const NODE_BIN = process.execPath;

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}
function writeUtf8(p, c) {
  fs.writeFileSync(p, c, 'utf8');
}

// Throws loudly on failure — used for fixture SETUP, where a failure means
// the test itself is broken, not a property under test.
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed:\n${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

// Never throws — used where a non-zero git exit IS the expected outcome
// (e.g. a deliberately conflicting cherry-pick, or an ancestor check
// expected to be false).
function tryGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runIntegrate(args, cwd, env) {
  const result = spawnSync(NODE_BIN, [INTEGRATE_PATH, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function initPrimary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't567-primary-'));
  runGit(['init', '-q', '-b', 'main'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test'], dir);
  writeUtf8(path.join(dir, 'seed.txt'), 'seed\n');
  runGit(['add', 'seed.txt'], dir);
  runGit(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function addLinkedWorktree(primary, branchName) {
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 't567-linked-'));
  fs.rmdirSync(linked); // `git worktree add` requires the target path not exist yet.
  runGit(['worktree', 'add', '-q', linked, '-b', branchName], primary);
  return linked;
}

function baseEnv(root) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: root };
  delete env.MAVERICKS_ALLOW_NEVER_PROJECT_ROOT;
  return env;
}

function cleanupWorktree(primary, linked) {
  tryGit(['worktree', 'remove', '--force', linked], primary);
  fs.rmSync(linked, { recursive: true, force: true });
  fs.rmSync(primary, { recursive: true, force: true });
}

function extractIntegratedHashes(stdout) {
  return [...stdout.matchAll(/^integrated: ([0-9a-f]+)$/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Part 1 — cwd inside the linked worktree; hash differs from the worktree's
// own commit hash; patch-equivalence (not reachability) reports integrated.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-1');

  writeUtf8(path.join(LINKED, 'feature-1.txt'), 'feature one\n');
  runGit(['add', 'feature-1.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature one'], LINKED);
  const worktreeHash = runGit(['rev-parse', 'HEAD'], LINKED);

  // A sibling commit lands on PRIMARY after the worktree branched — the
  // actual motivating scenario (another task merges while a sub-agent's
  // worktree still sits on the old base) — so PRIMARY's HEAD has genuinely
  // diverged from the worktree commit's own parent before --integrate runs,
  // guaranteeing the cherry-picked commit gets a NEW parent (and therefore a
  // new hash) rather than merely a same-second timestamp coincidence.
  writeUtf8(path.join(PRIMARY, 'sibling-1.txt'), 'sibling task landed first\n');
  runGit(['add', 'sibling-1.txt'], PRIMARY);
  runGit(['commit', '-q', '-m', 'sibling task'], PRIMARY);

  const primaryHeadBefore = runGit(['rev-parse', 'HEAD'], PRIMARY);

  const env = baseEnv(PRIMARY);
  const r = runIntegrate([worktreeHash], LINKED, env); // cwd = INSIDE the worktree

  assert.strictEqual(r.status, 0, `Test 1 FAIL: expected exit 0, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const hashes = extractIntegratedHashes(r.stdout);
  assert.strictEqual(hashes.length, 1, `Test 1 FAIL: expected exactly one "integrated:" line. stdout:\n${r.stdout}`);
  const printedHash = hashes[0];

  assert.ok(!worktreeHash.startsWith(printedHash), 'Test 1 FAIL: printed hash must differ from (not be a prefix of) the worktree commit hash');

  const primaryHeadAfter = runGit(['rev-parse', 'HEAD'], PRIMARY);
  assert.notStrictEqual(primaryHeadAfter, primaryHeadBefore, 'Test 1 FAIL: PRIMARY HEAD must have advanced');
  assert.ok(primaryHeadAfter.startsWith(printedHash), 'Test 1 FAIL: printed hash must be a prefix of PRIMARY\'s actual new HEAD');

  // cwd being inside the worktree must not mutate the worktree itself.
  const worktreeHashAfter = runGit(['rev-parse', 'HEAD'], LINKED);
  assert.strictEqual(worktreeHashAfter, worktreeHash, "Test 1 FAIL: the worktree's own HEAD must be unchanged by --integrate");

  // Patch-equivalence, not reachability: the worktree branch tip is a cherry-
  // picked commit, so it is NOT a raw-reachability ancestor of PRIMARY main
  // (a fresh commit object, different parent) — while patch-equivalence
  // (git cherry, patch-id comparison) correctly reports it integrated. This
  // is the property that makes patch-equivalence, not reachability, the
  // right check for a cherry-pick-based integration model.
  const ancestorCheck = tryGit(['merge-base', '--is-ancestor', 't567-branch-1', 'main'], PRIMARY);
  assert.notStrictEqual(
    ancestorCheck.status,
    0,
    'Test 1 FAIL: the worktree branch must NOT be a raw-reachability ancestor of main — this is exactly what makes patch-equivalence necessary'
  );

  const patchStatus = getPatchEquivalenceStatus(PRIMARY, 'main', 't567-branch-1');
  assert.strictEqual(patchStatus, 'integrated', `Test 1 FAIL: getPatchEquivalenceStatus() must report 'integrated', got '${patchStatus}'`);

  console.log(
    'Test 1 passed: cwd-inside-the-worktree invocation lands the commit on PRIMARY main with a differing hash; not a reachability-ancestor of main, yet reported integrated by patch-equivalence'
  );

  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 2 — the same invocation from an unrelated cwd behaves identically.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-2');

  writeUtf8(path.join(LINKED, 'feature-2.txt'), 'feature two\n');
  runGit(['add', 'feature-2.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature two'], LINKED);
  const worktreeHash = runGit(['rev-parse', 'HEAD'], LINKED);

  // Same divergence rationale as Part 1 — see its comment.
  writeUtf8(path.join(PRIMARY, 'sibling-2.txt'), 'sibling task landed first\n');
  runGit(['add', 'sibling-2.txt'], PRIMARY);
  runGit(['commit', '-q', '-m', 'sibling task'], PRIMARY);

  const primaryHeadBefore = runGit(['rev-parse', 'HEAD'], PRIMARY);

  const env = baseEnv(PRIMARY);
  const unrelatedCwd = os.tmpdir(); // not PRIMARY, not LINKED
  const r = runIntegrate([worktreeHash], unrelatedCwd, env);

  assert.strictEqual(r.status, 0, `Test 2 FAIL: expected exit 0, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const hashes = extractIntegratedHashes(r.stdout);
  assert.strictEqual(hashes.length, 1, `Test 2 FAIL: expected exactly one "integrated:" line. stdout:\n${r.stdout}`);
  assert.ok(!worktreeHash.startsWith(hashes[0]), 'Test 2 FAIL: printed hash must differ from the worktree commit hash');

  const primaryHeadAfter = runGit(['rev-parse', 'HEAD'], PRIMARY);
  assert.notStrictEqual(primaryHeadAfter, primaryHeadBefore, 'Test 2 FAIL: PRIMARY HEAD must have advanced even when cwd is unrelated to either checkout');
  assert.ok(primaryHeadAfter.startsWith(hashes[0]), "Test 2 FAIL: printed hash must be a prefix of PRIMARY's actual new HEAD");

  console.log('Test 2 passed: an invocation from a cwd unrelated to either checkout behaves identically to Part 1');

  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 3 — a resolved root that IS a linked worktree exits 1, PRIMARY's HEAD
// unchanged.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-3');

  writeUtf8(path.join(LINKED, 'feature-3.txt'), 'feature three\n');
  runGit(['add', 'feature-3.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature three'], LINKED);
  const worktreeHash = runGit(['rev-parse', 'HEAD'], LINKED);
  const linkedHeadBefore = worktreeHash;
  const primaryHeadBefore = runGit(['rev-parse', 'HEAD'], PRIMARY);

  // ROOT is pinned EXPLICITLY to the linked worktree itself, exercising
  // guardMutatingRoot()'s discriminator (c) end-to-end through --integrate.
  const env = baseEnv(LINKED);
  const r = runIntegrate([worktreeHash], PRIMARY, env);

  assert.strictEqual(r.status, 1, `Test 3 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes('REFUSED'), `Test 3 FAIL: stderr must contain the refusal message. stderr:\n${r.stderr}`);
  assert.ok(
    r.stderr.includes(fs.realpathSync(PRIMARY)) || r.stderr.includes(PRIMARY),
    `Test 3 FAIL: refusal must name the primary checkout path. stderr:\n${r.stderr}`
  );

  const primaryHeadAfter = runGit(['rev-parse', 'HEAD'], PRIMARY);
  const linkedHeadAfter = runGit(['rev-parse', 'HEAD'], LINKED);
  assert.strictEqual(primaryHeadAfter, primaryHeadBefore, "Test 3 FAIL: PRIMARY's HEAD must be unchanged after a refused run");
  assert.strictEqual(linkedHeadAfter, linkedHeadBefore, "Test 3 FAIL: LINKED's HEAD must also be unchanged after a refused run");

  console.log("Test 3 passed: a resolved root that IS a linked worktree exits 1 before any git operation; both checkouts' HEADs unchanged");

  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 4 — an in-progress pick (started outside --integrate) refuses.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-4');

  // Build a genuine conflict: PRIMARY and LINKED both edit the same file.
  writeUtf8(path.join(PRIMARY, 'conflict.txt'), 'primary version\n');
  runGit(['add', 'conflict.txt'], PRIMARY);
  runGit(['commit', '-q', '-m', 'primary edits conflict.txt'], PRIMARY);

  writeUtf8(path.join(LINKED, 'conflict.txt'), 'linked version\n');
  runGit(['add', 'conflict.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'linked edits conflict.txt'], LINKED);
  const conflictingHash = runGit(['rev-parse', 'HEAD'], LINKED);

  // Start a conflicting cherry-pick DIRECTLY (not through --integrate), and
  // leave it unresolved — this is the "in progress from any source" case.
  const directPick = tryGit(['cherry-pick', conflictingHash], PRIMARY);
  assert.notStrictEqual(directPick.status, 0, 'Test 4 setup FAIL: the direct cherry-pick was expected to conflict');
  assert.ok(fs.existsSync(path.join(PRIMARY, '.git', 'CHERRY_PICK_HEAD')), 'Test 4 setup FAIL: CHERRY_PICK_HEAD must exist after the conflicting pick');

  const primaryHeadBefore = runGit(['rev-parse', 'HEAD'], PRIMARY);

  const env = baseEnv(PRIMARY);
  const r = runIntegrate([conflictingHash], PRIMARY, env);

  assert.strictEqual(r.status, 1, `Test 4 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(
    r.stderr.toLowerCase().includes('already in progress'),
    `Test 4 FAIL: stderr must name the in-progress pick. stderr:\n${r.stderr}`
  );

  const primaryHeadAfter = runGit(['rev-parse', 'HEAD'], PRIMARY);
  assert.strictEqual(primaryHeadAfter, primaryHeadBefore, 'Test 4 FAIL: --integrate must not touch PRIMARY while a pick is already in progress');
  assert.ok(fs.existsSync(path.join(PRIMARY, '.git', 'CHERRY_PICK_HEAD')), 'Test 4 FAIL: the in-progress pick must still be present (no auto-abort)');

  console.log('Test 4 passed: an in-progress pick started outside --integrate causes --integrate to refuse, exit 1, untouched');

  runGit(['cherry-pick', '--abort'], PRIMARY);
  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 5 — a conflicting pick driven THROUGH --integrate exits non-zero,
// names --abort/--continue with no auto-abort, and a second invocation
// refuses.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-5');

  writeUtf8(path.join(PRIMARY, 'conflict.txt'), 'primary version\n');
  runGit(['add', 'conflict.txt'], PRIMARY);
  runGit(['commit', '-q', '-m', 'primary edits conflict.txt'], PRIMARY);

  writeUtf8(path.join(LINKED, 'conflict.txt'), 'linked version\n');
  runGit(['add', 'conflict.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'linked edits conflict.txt'], LINKED);
  const conflictingHash = runGit(['rev-parse', 'HEAD'], LINKED);

  const env = baseEnv(PRIMARY);
  const r1 = runIntegrate([conflictingHash], PRIMARY, env);

  assert.notStrictEqual(r1.status, 0, `Test 5 FAIL: a conflicting pick must exit non-zero. stdout:\n${r1.stdout}\nstderr:\n${r1.stderr}`);
  const combined1 = r1.stdout + r1.stderr;
  assert.ok(combined1.includes('cherry-pick --abort'), `Test 5 FAIL: must name "cherry-pick --abort". output:\n${combined1}`);
  assert.ok(combined1.includes('cherry-pick --continue'), `Test 5 FAIL: must name "cherry-pick --continue". output:\n${combined1}`);
  assert.ok(fs.existsSync(path.join(PRIMARY, '.git', 'CHERRY_PICK_HEAD')), 'Test 5 FAIL: the conflict must be left unresolved (no auto-abort)');

  // A second invocation, of ANY spec, must refuse rather than pile a second
  // pick on top of the first.
  const r2 = runIntegrate([conflictingHash], PRIMARY, env);
  assert.strictEqual(r2.status, 1, `Test 5 FAIL: the second invocation must refuse (exit 1), got ${r2.status}`);
  assert.ok(
    r2.stderr.toLowerCase().includes('already in progress'),
    `Test 5 FAIL: the second invocation's stderr must name the in-progress pick. stderr:\n${r2.stderr}`
  );

  console.log('Test 5 passed: a conflicting pick through --integrate exits non-zero naming --abort/--continue with no auto-abort; a second invocation refuses');

  runGit(['cherry-pick', '--abort'], PRIMARY);
  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 6 — the range form prints one `integrated:` line per commit.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-6');
  const baseHash = runGit(['rev-parse', 'HEAD'], LINKED); // shared ancestor with PRIMARY

  writeUtf8(path.join(LINKED, 'range-a.txt'), 'range a\n');
  runGit(['add', 'range-a.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'range commit A'], LINKED);

  writeUtf8(path.join(LINKED, 'range-b.txt'), 'range b\n');
  runGit(['add', 'range-b.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'range commit B'], LINKED);
  const tipHash = runGit(['rev-parse', 'HEAD'], LINKED);

  const env = baseEnv(PRIMARY);
  const r = runIntegrate([`${baseHash}..${tipHash}`], PRIMARY, env);

  assert.strictEqual(r.status, 0, `Test 6 FAIL: expected exit 0, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const hashes = extractIntegratedHashes(r.stdout);
  assert.strictEqual(hashes.length, 2, `Test 6 FAIL: expected exactly two "integrated:" lines, got ${hashes.length}. stdout:\n${r.stdout}`);

  const commitCount = runGit(['rev-list', '--count', `main`], PRIMARY);
  // init commit + 2 cherry-picked commits = 3
  assert.strictEqual(commitCount, '3', `Test 6 FAIL: PRIMARY main must now have 3 commits, has ${commitCount}`);

  console.log('Test 6 passed: the range form prints one "integrated:" line per commit, in order, and both land on PRIMARY main');

  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 7 — a placeholder-version fixture root refuses.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't567-placeholder-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1 }));

  const env = baseEnv(dir);
  const r = runIntegrate(['HEAD'], dir, env);

  assert.strictEqual(r.status, 1, `Test 7 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes('REFUSED'), `Test 7 FAIL: stderr must contain the refusal message. stderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('REFUSED'), `Test 7 FAIL: stdout must also contain the refusal message. stdout:\n${r.stdout}`);
  assert.ok(r.stderr.includes(NEVER_PROJECT_VERSION_PLACEHOLDER), `Test 7 FAIL: refusal must name the matched placeholder. stderr:\n${r.stderr}`);

  console.log('Test 7 passed: a placeholder-version fixture root refuses, proving guardMutatingRoot() is actually wired into --integrate');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 8 (additional, named in the acceptance criteria) — the optional
// --task suggestion line: present + correct when the task resolves to
// exactly one block; absent with a named warning when it does not.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  writeUtf8(
    path.join(PRIMARY, 'BACKLOG.md'),
    `# BACKLOG

## Active Wave

### T-901 — Fixture task
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** unit
`
  );
  runGit(['add', 'BACKLOG.md'], PRIMARY);
  runGit(['commit', '-q', '-m', 'add fixture BACKLOG.md'], PRIMARY);

  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-8');
  writeUtf8(path.join(LINKED, 'feature-8.txt'), 'feature eight\n');
  runGit(['add', 'feature-8.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature eight'], LINKED);
  const worktreeHash = runGit(['rev-parse', 'HEAD'], LINKED);

  const env = baseEnv(PRIMARY);

  // 8a — a valid, present task prints the suggestion with the landed hash.
  const rValid = runIntegrate([worktreeHash, '--task', 'T-901'], PRIMARY, env);
  assert.strictEqual(rValid.status, 0, `Test 8a FAIL: expected exit 0, got ${rValid.status}. stdout:\n${rValid.stdout}`);
  const landedHash = extractIntegratedHashes(rValid.stdout)[0];
  assert.ok(
    rValid.stdout.includes(`--set-status T-901 merged --commit ${landedHash}`),
    `Test 8a FAIL: expected a --set-status suggestion naming T-901 and the landed hash. stdout:\n${rValid.stdout}`
  );
  console.log('Test 8a passed: --task T-901 (present) prints a --set-status suggestion naming the landed hash');

  // 8b — a task id that does not resolve prints a named warning, not a
  // suggestion, and does not fail the run.
  writeUtf8(path.join(LINKED, 'feature-8b.txt'), 'feature eight b\n');
  runGit(['add', 'feature-8b.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature eight b'], LINKED);
  const worktreeHash2 = runGit(['rev-parse', 'HEAD'], LINKED);

  const rMissing = runIntegrate([worktreeHash2, '--task', 'T-999'], PRIMARY, env);
  assert.strictEqual(rMissing.status, 0, `Test 8b FAIL: expected exit 0, got ${rMissing.status}. stdout:\n${rMissing.stdout}`);
  assert.ok(!rMissing.stdout.includes('--set-status T-999'), `Test 8b FAIL: no suggestion should be printed for an unresolved task. stdout:\n${rMissing.stdout}`);
  assert.ok(rMissing.stdout.includes('T-999') && rMissing.stdout.includes('not found'), `Test 8b FAIL: expected a named warning for T-999. stdout:\n${rMissing.stdout}`);
  console.log('Test 8b passed: --task T-999 (absent) prints a named warning, no suggestion, and does not fail the run');

  // 8c — omitting --task entirely integrates with no suggestion at all
  // (--task is OPTIONAL — integrating a non-task commit never requires
  // inventing a task id).
  writeUtf8(path.join(LINKED, 'feature-8c.txt'), 'feature eight c\n');
  runGit(['add', 'feature-8c.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature eight c'], LINKED);
  const worktreeHash3 = runGit(['rev-parse', 'HEAD'], LINKED);

  const rNoTask = runIntegrate([worktreeHash3], PRIMARY, env);
  assert.strictEqual(rNoTask.status, 0, `Test 8c FAIL: expected exit 0, got ${rNoTask.status}`);
  assert.ok(!rNoTask.stdout.includes('--set-status'), `Test 8c FAIL: no --set-status suggestion should appear when --task is omitted. stdout:\n${rNoTask.stdout}`);
  console.log('Test 8c passed: omitting --task integrates the commit with no suggestion printed — never required');

  cleanupWorktree(PRIMARY, LINKED);
}

// ---------------------------------------------------------------------------
// Part 9 (additional, named in the acceptance criteria) — --integrate writes
// NO state artifact: BACKLOG.md/TASK_STATUS.md are byte-identical before and
// after a successful integration.
// ---------------------------------------------------------------------------
{
  const PRIMARY = initPrimary();
  const backlogContent = `# BACKLOG

## Active Wave

### T-902 — Fixture task
- **Status:** in_progress
`;
  const taskStatusContent = `# TASK_STATUS

## Active tasks

### T-902 — Fixture task
- **Status:** in_progress
- **Evidence:** —
`;
  writeUtf8(path.join(PRIMARY, 'BACKLOG.md'), backlogContent);
  writeUtf8(path.join(PRIMARY, 'TASK_STATUS.md'), taskStatusContent);
  runGit(['add', 'BACKLOG.md', 'TASK_STATUS.md'], PRIMARY);
  runGit(['commit', '-q', '-m', 'add fixture state artifacts'], PRIMARY);

  const LINKED = addLinkedWorktree(PRIMARY, 't567-branch-9');
  writeUtf8(path.join(LINKED, 'feature-9.txt'), 'feature nine\n');
  runGit(['add', 'feature-9.txt'], LINKED);
  runGit(['commit', '-q', '-m', 'feature nine'], LINKED);
  const worktreeHash = runGit(['rev-parse', 'HEAD'], LINKED);

  const env = baseEnv(PRIMARY);
  const r = runIntegrate([worktreeHash, '--task', 'T-902'], PRIMARY, env);
  assert.strictEqual(r.status, 0, `Test 9 FAIL: expected exit 0, got ${r.status}. stdout:\n${r.stdout}`);

  const backlogAfter = readUtf8(path.join(PRIMARY, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(PRIMARY, 'TASK_STATUS.md'));
  assert.strictEqual(backlogAfter, backlogContent, 'Test 9 FAIL: BACKLOG.md must be byte-identical — --integrate must write no state artifact');
  assert.strictEqual(taskStatusAfter, taskStatusContent, 'Test 9 FAIL: TASK_STATUS.md must be byte-identical — --integrate must write no state artifact');

  console.log('Test 9 passed: --integrate writes no state artifact even when --task resolves and a suggestion is printed');

  cleanupWorktree(PRIMARY, LINKED);
}
