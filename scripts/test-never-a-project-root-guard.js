'use strict';
// Regression test: T-624 — Mutating operator commands refuse a
// never-a-project repo root; repo-identity line duplicated to stderr.
//
// Covers:
//   1. Unit: checkNeverAProjectRoot() discriminator (a) — PROCESS_STATE.json
//      exists and carries the literal shipped placeholder in mavericks_version.
//   2. Unit: checkNeverAProjectRoot() discriminator (a) negative — a real
//      version string proceeds (not blocked).
//   3. Unit: checkNeverAProjectRoot() — a MISSING PROCESS_STATE.json never
//      triggers discriminator (a).
//   4. Unit: checkNeverAProjectRoot() discriminator (b) — root realpath-equals
//      an injected $HOME/.mavericks (no real ~/.mavericks needed).
//   5. Unit: guardMutatingRoot() override env var permits the write.
//   6. Unit: printRepoIdentityHeader({mutating:true}) duplicates its line to
//      stderr; printRepoIdentityHeader() (no options / mutating:false) stays
//      stdout-only (read-only-surface shape, unchanged).
//   7. RED end-to-end: --set-status against a fixture repo whose
//      PROCESS_STATE.json carries the placeholder exits 1 BEFORE any file
//      write (BACKLOG.md/TASK_STATUS.md byte-identical after), and stderr
//      names the resolved path.
//   8. GREEN end-to-end: the canonical repo shape (real version string)
//      proceeds — --set-status actually updates the Status field.
//   9. GREEN end-to-end: the override env var permits the fixture write even
//      though PROCESS_STATE.json still carries the placeholder.
//
// T-670 additions — discriminator (c), linked-worktree refusal:
//  10. RED end-to-end + unit: a real `git worktree add` linked worktree
//      blocks (discriminator "linked_worktree", primaryWorktreePath set);
//      --set-status pointed at the linked worktree exits 1 BEFORE any file
//      write, byte-unchanged, stderr names the primary checkout path.
//  11. GREEN end-to-end: the override env var permits the write against the
//      same linked-worktree root.
//  12. GREEN end-to-end + unit: the PRIMARY checkout of that same repo
//      proceeds (not blocked) and --set-status actually updates Status.
//  13. Unit: bare-repo-plus-worktrees layout (git init --bare, then `git
//      worktree add` off the bare clone) proceeds — the bare-primary
//      exemption, so this layout is never permanently blocked.
//  14. Unit: a non-git directory (and one that no longer exists) proceeds
//      without throwing — listGitWorktrees()/checkNeverAProjectRoot() degrade
//      silently.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  checkNeverAProjectRoot,
  guardMutatingRoot,
  printRepoIdentityHeader,
  listGitWorktrees,
  NEVER_PROJECT_ROOT_OVERRIDE_ENV,
  NEVER_PROJECT_VERSION_PLACEHOLDER,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const SET_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-status.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk, ...args) => { captured += chunk; return true; };
  try { fn(); } finally { process.stdout.write = originalWrite; }
  return captured;
}

function captureStdoutAndStderr(fn) {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = (chunk, ...args) => { out += chunk; return true; };
  process.stderr.write = (chunk, ...args) => { err += chunk; return true; };
  try { fn(); } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { out, err };
}

function writeFixture(root, taskId, status) {
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
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`);
}

function runSetStatus(args, cwd, env) {
  const result = spawnSync(NODE_BIN, [SET_STATUS_PATH, ...args], { cwd, env, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// T-670: real `git` invocations for building linked-worktree fixtures.
// Throws (via a non-zero exit) if the underlying git command fails — callers
// are setting up fixtures, so a setup failure should fail the test loudly
// rather than degrade silently (degrade-silently is a property of the guard
// under test, not of this fixture helper).
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout || '';
}

function initGitRepoWithCommit(dir) {
  runGit(['init', '-q', '-b', 'main'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test'], dir);
  writeUtf8(path.join(dir, 'seed.txt'), 'seed\n');
  runGit(['add', 'seed.txt'], dir);
  runGit(['commit', '-q', '-m', 'init'], dir);
}

// ---------------------------------------------------------------------------
// Part 1 — unit: discriminator (a), the shipped placeholder blocks.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-placeholder-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1 }));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, true, 'Test 1 FAIL: placeholder mavericks_version must block');
  assert.strictEqual(result.discriminator, 'placeholder', 'Test 1 FAIL: expected discriminator "placeholder"');
  console.log('Test 1 passed: shipped placeholder mavericks_version blocks with discriminator "placeholder"');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 2 — unit: discriminator (a) negative, a real version string proceeds.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-real-version-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1 }));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, false, 'Test 2 FAIL: a real version string must not block');
  console.log('Test 2 passed: a real mavericks_version string proceeds (not blocked)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — unit: a MISSING PROCESS_STATE.json never triggers discriminator (a).
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-missing-ps-'));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, false, 'Test 3 FAIL: a missing PROCESS_STATE.json must never block via discriminator (a)');
  assert.strictEqual(result.discriminator, null, 'Test 3 FAIL: expected no discriminator match');
  console.log('Test 3 passed: missing PROCESS_STATE.json never triggers the placeholder discriminator');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 4 — unit: discriminator (b), root realpath-equals injected $HOME/.mavericks.
// ---------------------------------------------------------------------------
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 't624-fakehome-'));
  const fakeDotMavericks = path.join(fakeHome, '.mavericks');
  fs.mkdirSync(fakeDotMavericks);
  const result = checkNeverAProjectRoot(fakeDotMavericks, { homeDir: fakeHome });
  assert.strictEqual(result.blocked, true, 'Test 4 FAIL: root resolving to $HOME/.mavericks must block');
  assert.strictEqual(result.discriminator, 'dot_mavericks', 'Test 4 FAIL: expected discriminator "dot_mavericks"');

  // Sibling directory (NOT .mavericks itself) must not block.
  const siblingDir = path.join(fakeHome, 'not-mavericks');
  fs.mkdirSync(siblingDir);
  const siblingResult = checkNeverAProjectRoot(siblingDir, { homeDir: fakeHome });
  assert.strictEqual(siblingResult.blocked, false, 'Test 4 FAIL: a sibling directory must not be misidentified as $HOME/.mavericks');

  console.log('Test 4 passed: root realpath-equal to injected $HOME/.mavericks blocks with discriminator "dot_mavericks"; a sibling directory does not');
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 5 — unit: guardMutatingRoot() override env var permits the write.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-override-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1 }));

  const blockedResult = guardMutatingRoot(dir, '--set-status', { env: {} });
  assert.strictEqual(blockedResult.blocked, true, 'Test 5 FAIL: no override env var set must block');

  const overriddenResult = guardMutatingRoot(dir, '--set-status', { env: { [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' } });
  assert.strictEqual(overriddenResult.blocked, false, 'Test 5 FAIL: override env var set to "1" must permit the write');
  assert.strictEqual(overriddenResult.overridden, true, 'Test 5 FAIL: expected overridden:true when the env var is set');

  console.log('Test 5 passed: guardMutatingRoot() blocks without the override env var and permits the write when it is set');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 6 — unit: printRepoIdentityHeader duplicates to stderr only when
// mutating:true; read-only-surface shape (no options) stays stdout-only.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-header-mutating-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ wave: 5, initiative: 'T-624 fixture' }));

  const readOnly = captureStdoutAndStderr(() => printRepoIdentityHeader(dir));
  assert.strictEqual(readOnly.err, '', 'Test 6 FAIL: read-only-surface call (no options) must not write to stderr');
  assert.ok(readOnly.out.includes(`repo: ${dir}`), 'Test 6 FAIL: stdout must still contain the identity line');

  const mutating = captureStdoutAndStderr(() => printRepoIdentityHeader(dir, { mutating: true }));
  assert.strictEqual(mutating.out, mutating.err, 'Test 6 FAIL: mutating:true must duplicate the identity line byte-for-byte to stderr');
  assert.ok(mutating.out.includes(`repo: ${dir} | wave: 5 | initiative: T-624 fixture`), 'Test 6 FAIL: expected full header content');

  console.log('Test 6 passed: printRepoIdentityHeader duplicates to stderr only when mutating:true');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 7 — RED end-to-end: --set-status against a placeholder-carrying
// fixture refuses BEFORE any write; BACKLOG.md/TASK_STATUS.md byte-identical;
// stderr names the resolved path.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-red-'));
  writeFixture(REPO, 'T-960', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1, initiative: 'T-624 red fixture' }));

  const beforeBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  const beforeTaskStatus = readUtf8(path.join(REPO, 'TASK_STATUS.md'));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-960', 'dev_done'], REPO, env);

  assert.strictEqual(r.status, 1, `Test 7 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  const afterTaskStatus = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  assert.strictEqual(afterBacklog, beforeBacklog, 'Test 7 FAIL: BACKLOG.md must be byte-identical after a refused run');
  assert.strictEqual(afterTaskStatus, beforeTaskStatus, 'Test 7 FAIL: TASK_STATUS.md must be byte-identical after a refused run');

  assert.ok(r.stderr.includes(REPO), `Test 7 FAIL: stderr must name the resolved path. stderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes('REFUSED'), 'Test 7 FAIL: stderr must contain the refusal message');
  assert.ok(r.stderr.includes(NEVER_PROJECT_ROOT_OVERRIDE_ENV), 'Test 7 FAIL: stderr must name the override env var');
  assert.ok(r.stdout.includes(REPO), 'Test 7 FAIL: stdout must also name the resolved path (BOTH stdout and stderr required)');

  console.log('Test 7 (RED) passed: --set-status refuses exit 1 before any write against a placeholder-carrying fixture; BACKLOG.md/TASK_STATUS.md byte-identical; stderr names the path');
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 8 — GREEN end-to-end: the canonical repo shape (real version string)
// proceeds — --set-status actually updates Status.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-green-canonical-'));
  writeFixture(REPO, 'T-961', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1, initiative: 'T-624 green fixture' }));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-961', 'dev_done'], REPO, env);

  // Note: --set-status forwards the VALIDATOR's own exit code (which may
  // legitimately be 1 for an unrelated drifting warning, e.g.
  // dev_done_without_qa on this minimal fixture) — so exit code alone can't
  // distinguish "refused" from "proceeded with a validator warning". The
  // absence of the REFUSED message is what proves the guard did not block.
  assert.ok(!r.stdout.includes('REFUSED'), `Test 8 FAIL: canonical repo shape must not print the refusal message. stdout:\n${r.stdout}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  assert.ok(afterBacklog.includes('**Status:** dev_done'), 'Test 8 FAIL: BACKLOG.md Status must actually be updated to dev_done');

  console.log('Test 8 (GREEN) passed: canonical repo shape (real mavericks_version) proceeds and --set-status updates Status');
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 9 — GREEN end-to-end: the override env var permits the fixture write
// even though PROCESS_STATE.json still carries the placeholder.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-green-override-'));
  writeFixture(REPO, 'T-962', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1, initiative: 'T-624 override fixture' }));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO, [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' };
  const r = runSetStatus(['T-962', 'dev_done'], REPO, env);

  assert.ok(!r.stdout.includes('REFUSED'), `Test 9 FAIL: override env var must suppress the refusal. stdout:\n${r.stdout}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  assert.ok(afterBacklog.includes('**Status:** dev_done'), 'Test 9 FAIL: BACKLOG.md Status must actually be updated to dev_done when the override permits the write');

  console.log('Test 9 (GREEN) passed: override env var permits the write against a placeholder-carrying fixture');
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 10 — RED end-to-end + unit: a real linked git worktree blocks.
// ---------------------------------------------------------------------------
{
  const PRIMARY = fs.mkdtempSync(path.join(os.tmpdir(), 't670-primary-'));
  initGitRepoWithCommit(PRIMARY);
  writeFixture(PRIMARY, 'T-970', 'in_progress');
  writeUtf8(path.join(PRIMARY, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1, initiative: 'T-670 primary fixture' }));

  const LINKED = fs.mkdtempSync(path.join(os.tmpdir(), 't670-linked-'));
  fs.rmdirSync(LINKED); // `git worktree add` requires the target path not exist yet.
  runGit(['worktree', 'add', '-q', LINKED, '-b', 't670-linked-branch'], PRIMARY);
  // The linked worktree checks out only what's tracked by git (seed.txt);
  // BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.json are untracked fixtures we
  // add directly, mirroring the real-world case: an operator invocation
  // whose cwd sits inside a linked worktree that has its OWN untracked
  // state artifacts (or none at all yet) — the guard must still catch it.
  writeFixture(LINKED, 'T-970', 'in_progress');
  writeUtf8(path.join(LINKED, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1, initiative: 'T-670 linked fixture' }));

  // Unit: checkNeverAProjectRoot() directly.
  const unitResult = checkNeverAProjectRoot(LINKED);
  assert.strictEqual(unitResult.blocked, true, 'Test 10 FAIL: a linked worktree root must block');
  assert.strictEqual(unitResult.discriminator, 'linked_worktree', 'Test 10 FAIL: expected discriminator "linked_worktree"');
  assert.strictEqual(fs.realpathSync(unitResult.primaryWorktreePath), fs.realpathSync(PRIMARY), 'Test 10 FAIL: primaryWorktreePath must name the primary checkout');

  // End-to-end (RED): --set-status against the linked worktree refuses
  // BEFORE any write.
  const beforeBacklog = readUtf8(path.join(LINKED, 'BACKLOG.md'));
  const beforeTaskStatus = readUtf8(path.join(LINKED, 'TASK_STATUS.md'));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: LINKED };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-970', 'dev_done'], LINKED, env);

  assert.strictEqual(r.status, 1, `Test 10 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const afterBacklog = readUtf8(path.join(LINKED, 'BACKLOG.md'));
  const afterTaskStatus = readUtf8(path.join(LINKED, 'TASK_STATUS.md'));
  assert.strictEqual(afterBacklog, beforeBacklog, 'Test 10 FAIL: BACKLOG.md must be byte-identical after a refused run');
  assert.strictEqual(afterTaskStatus, beforeTaskStatus, 'Test 10 FAIL: TASK_STATUS.md must be byte-identical after a refused run');

  assert.ok(r.stderr.includes('REFUSED'), 'Test 10 FAIL: stderr must contain the refusal message');
  assert.ok(r.stderr.includes(fs.realpathSync(PRIMARY)) || r.stderr.includes(PRIMARY), `Test 10 FAIL: stderr must name the primary checkout path. stderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes(NEVER_PROJECT_ROOT_OVERRIDE_ENV), 'Test 10 FAIL: stderr must name the override env var');
  assert.ok(r.stdout.includes('REFUSED'), 'Test 10 FAIL: stdout must also contain the refusal message (BOTH stdout and stderr required)');

  console.log('Test 10 (RED) passed: a real `git worktree add` linked worktree blocks with discriminator "linked_worktree"; --set-status refuses exit 1 before any write; stderr names the primary checkout path');

  // ---------------------------------------------------------------------------
  // Part 11 — GREEN end-to-end: the override env var permits the write
  // against the same linked-worktree root.
  // ---------------------------------------------------------------------------
  const overrideEnv = { ...process.env, MAVERICKS_PROJECT_ROOT: LINKED, [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' };
  const overrideResult = runSetStatus(['T-970', 'dev_done'], LINKED, overrideEnv);
  assert.ok(!overrideResult.stdout.includes('REFUSED'), `Test 11 FAIL: override env var must suppress the refusal. stdout:\n${overrideResult.stdout}`);
  const overriddenBacklog = readUtf8(path.join(LINKED, 'BACKLOG.md'));
  assert.ok(overriddenBacklog.includes('**Status:** dev_done'), 'Test 11 FAIL: BACKLOG.md Status must actually be updated when the override permits the write');
  console.log('Test 11 (GREEN) passed: override env var permits the write against a linked-worktree root');

  // ---------------------------------------------------------------------------
  // Part 12 — GREEN end-to-end + unit: the PRIMARY checkout proceeds.
  // ---------------------------------------------------------------------------
  const primaryUnitResult = checkNeverAProjectRoot(PRIMARY);
  assert.strictEqual(primaryUnitResult.blocked, false, 'Test 12 FAIL: the primary checkout must not be blocked as a linked worktree');

  const primaryEnv = { ...process.env, MAVERICKS_PROJECT_ROOT: PRIMARY };
  delete primaryEnv[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const primaryResult = runSetStatus(['T-970', 'dev_done'], PRIMARY, primaryEnv);
  assert.ok(!primaryResult.stdout.includes('REFUSED'), `Test 12 FAIL: the primary checkout must not print the refusal message. stdout:\n${primaryResult.stdout}`);
  const primaryBacklog = readUtf8(path.join(PRIMARY, 'BACKLOG.md'));
  assert.ok(primaryBacklog.includes('**Status:** dev_done'), 'Test 12 FAIL: BACKLOG.md Status must actually be updated to dev_done at the primary checkout');
  console.log('Test 12 (GREEN) passed: the primary checkout of the same repo proceeds and --set-status updates Status');

  fs.rmSync(LINKED, { recursive: true, force: true });
  runGit(['worktree', 'prune'], PRIMARY);
  fs.rmSync(PRIMARY, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 13 — unit: bare-repo-plus-worktrees layout proceeds (kills the
// bare-layout false positive — the bare-primary exemption).
// ---------------------------------------------------------------------------
{
  const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 't670-bare-src-'));
  initGitRepoWithCommit(SRC);

  const BARE = fs.mkdtempSync(path.join(os.tmpdir(), 't670-bare-'));
  fs.rmdirSync(BARE);
  runGit(['clone', '-q', '--bare', SRC, BARE]);

  const WT = fs.mkdtempSync(path.join(os.tmpdir(), 't670-bare-wt-'));
  fs.rmdirSync(WT);
  runGit(['worktree', 'add', '-q', WT], BARE);

  // Sanity: confirm the primary entry really is reported bare before relying
  // on the exemption it feeds.
  const worktrees = listGitWorktrees(WT);
  assert.ok(worktrees.length >= 2, 'Test 13 FAIL: expected at least the bare primary + the linked worktree entry');
  assert.strictEqual(worktrees[0].bare, true, 'Test 13 FAIL: expected the first (primary) entry to be reported bare');

  writeFixture(WT, 'T-971', 'in_progress');
  writeUtf8(path.join(WT, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1, initiative: 'T-670 bare-layout fixture' }));

  const unitResult = checkNeverAProjectRoot(WT);
  assert.strictEqual(unitResult.blocked, false, 'Test 13 FAIL: a worktree off a bare primary must not be blocked as "linked_worktree" (bare-primary exemption)');

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: WT };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-971', 'dev_done'], WT, env);
  assert.ok(!r.stdout.includes('REFUSED'), `Test 13 FAIL: bare-repo-plus-worktrees layout must not be refused. stdout:\n${r.stdout}`);
  const afterBacklog = readUtf8(path.join(WT, 'BACKLOG.md'));
  assert.ok(afterBacklog.includes('**Status:** dev_done'), 'Test 13 FAIL: BACKLOG.md Status must actually be updated in the bare-repo-plus-worktrees layout');

  console.log('Test 13 passed: bare-repo-plus-worktrees layout proceeds (bare-primary exemption) — checked directly via listGitWorktrees() and end-to-end via --set-status');

  fs.rmSync(WT, { recursive: true, force: true });
  runGit(['worktree', 'prune'], BARE);
  fs.rmSync(BARE, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 14 — unit: a non-git directory (and one that no longer exists)
// proceeds without throwing.
// ---------------------------------------------------------------------------
{
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 't670-nongit-'));
  assert.doesNotThrow(() => listGitWorktrees(nonGitDir), 'Test 14 FAIL: listGitWorktrees() must never throw on a non-git directory');
  assert.deepStrictEqual(listGitWorktrees(nonGitDir), [], 'Test 14 FAIL: listGitWorktrees() must degrade to [] on a non-git directory');

  let nonGitResult;
  assert.doesNotThrow(() => { nonGitResult = checkNeverAProjectRoot(nonGitDir); }, 'Test 14 FAIL: checkNeverAProjectRoot() must never throw on a non-git directory');
  assert.strictEqual(nonGitResult.blocked, false, 'Test 14 FAIL: a non-git directory must not be blocked');
  fs.rmSync(nonGitDir, { recursive: true, force: true });

  // A path that no longer exists at all (already removed above) — the
  // guard must still degrade silently rather than throw.
  let missingResult;
  assert.doesNotThrow(() => { missingResult = checkNeverAProjectRoot(nonGitDir); }, 'Test 14 FAIL: checkNeverAProjectRoot() must never throw on a removed/non-existent path');
  assert.strictEqual(missingResult.blocked, false, 'Test 14 FAIL: a removed/non-existent path must not be blocked');

  console.log('Test 14 passed: a non-git directory (and a removed path) proceed without throwing');
}

console.log('\nAll T-624/T-670 assertions passed.');
