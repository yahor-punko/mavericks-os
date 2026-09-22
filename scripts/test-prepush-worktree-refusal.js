'use strict';
// Regression test: T-753 — .claude/hooks/pre-push refuses pushes issued
// from a linked git worktree, exits 0 from the primary checkout, exits 0
// when MAVP_ALLOW_WORKTREE_PUSH is set, and covers both a bare
// `git push origin <branch>` and an explicit `git push origin HEAD:main`.
//
// Builds a scratch bare "remote" repo, a primary clone with
// core.hooksPath pointing at a copy of the hook, and a linked worktree off
// that clone (worktrees share core.hooksPath — it lives in the shared git
// config, not per-worktree). Plain node + git subprocess, no npm deps.
//
// Hook source is overridable via MAVP_TEST_PREPUSH_HOOK_SRC — used to run
// this exact suite against a deliberately mutated scratch copy of the hook
// (BACKLOG T-753 "Named mutant": delete the git-dir comparison line so a
// worktree push wrongly exits 0) to demonstrate the suite is able to fail.
// See BACKLOG.md T-753 evidence for the quoted red/green runs.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const REAL_HOOK_SRC = path.join(REPO_ROOT, '.claude', 'hooks', 'pre-push');
const HOOK_SRC = process.env.MAVP_TEST_PREPUSH_HOOK_SRC
  ? path.resolve(process.env.MAVP_TEST_PREPUSH_HOOK_SRC)
  : REAL_HOOK_SRC;

assert.ok(fs.existsSync(HOOK_SRC), `hook source not found: ${HOOK_SRC}`);

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tmpDirs = [];
function scratch(prefix) {
  const d = makeScratchDir(prefix);
  tmpDirs.push(d);
  return d;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitPush(cwd, args, extraEnv = {}) {
  return spawnSync('git', ['push', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error('FAIL: ' + message);
  } else {
    console.log('PASS: ' + message);
  }
}

try {
  // --- Scratch bare "remote" ---
  const remoteDir = scratch('mavp-prepush-remote-');
  git(remoteDir, ['init', '--bare', '-q', '-b', 'main']);

  // --- Hooks dir: a COPY of the hook under test, wired via core.hooksPath ---
  const hooksDir = scratch('mavp-prepush-hooks-');
  const hookDst = path.join(hooksDir, 'pre-push');
  fs.copyFileSync(HOOK_SRC, hookDst);
  fs.chmodSync(hookDst, 0o755);

  // --- Primary checkout (a normal clone) ---
  const primaryDir = scratch('mavp-prepush-primary-');
  git(process.cwd(), ['clone', '-q', remoteDir, primaryDir]);
  git(primaryDir, ['config', 'user.email', 'test@example.com']);
  git(primaryDir, ['config', 'user.name', 'Test']);
  git(primaryDir, ['config', 'core.hooksPath', hooksDir]);
  git(primaryDir, ['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(primaryDir, 'README.md'), 'hello\n', 'utf8');
  git(primaryDir, ['add', '-A']);
  git(primaryDir, ['commit', '-q', '-m', 'initial commit']);

  // --- Assertion 1: push from the primary checkout exits 0 ---
  const primaryPush = gitPush(primaryDir, ['origin', 'main']);
  check(
    primaryPush.status === 0,
    `push from the primary checkout exits 0 (got ${primaryPush.status}; stderr: ${primaryPush.stderr})`
  );

  // --- Linked worktree off the primary checkout ---
  const worktreeDir = scratch('mavp-prepush-worktree-');
  git(primaryDir, ['worktree', 'add', '-q', '-b', 'feature-branch', worktreeDir]);
  git(worktreeDir, ['config', 'user.email', 'test@example.com']);
  git(worktreeDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(worktreeDir, 'FEATURE.md'), 'feature\n', 'utf8');
  git(worktreeDir, ['add', '-A']);
  git(worktreeDir, ['commit', '-q', '-m', 'feature commit']);

  const worktreeGitDirRaw = git(worktreeDir, ['rev-parse', '--git-dir']).trim();
  const resolvedWorktreeGitDir = fs.realpathSync(path.resolve(worktreeDir, worktreeGitDirRaw));

  // Sanity: confirm the worktree really is a distinct git-dir from the
  // primary's common-dir before trusting refusal assertions below — a
  // wrongly-built fixture would make every assertion below pass for the
  // wrong reason.
  const worktreeCommonDirRaw = git(worktreeDir, ['rev-parse', '--git-common-dir']).trim();
  const resolvedWorktreeCommonDir = fs.realpathSync(path.resolve(worktreeDir, worktreeCommonDirRaw));
  assert.notStrictEqual(
    resolvedWorktreeGitDir,
    resolvedWorktreeCommonDir,
    'test setup error: worktree git-dir must differ from its common-dir'
  );

  // --- Assertion 2: default push from the linked worktree is refused ---
  const worktreePush = gitPush(worktreeDir, ['origin', 'feature-branch']);
  check(worktreePush.status !== 0, `push from linked worktree is refused (exit ${worktreePush.status})`);
  check(
    worktreePush.stderr.includes(resolvedWorktreeGitDir),
    'refusal stderr names the linked worktree git-dir path'
  );
  check(
    /primary checkout/i.test(worktreePush.stderr) && /Main Agent/i.test(worktreePush.stderr),
    'refusal stderr states pushes belong to the Main Agent from the primary checkout'
  );

  // --- Assertion 3: explicit "push origin HEAD:main" from the worktree is also refused ---
  const worktreePushExplicit = gitPush(worktreeDir, ['origin', 'HEAD:main']);
  check(
    worktreePushExplicit.status !== 0,
    `"push origin HEAD:main" from linked worktree is refused (exit ${worktreePushExplicit.status})`
  );

  // --- Assertion 4: MAVP_ALLOW_WORKTREE_PUSH=1 overrides the refusal ---
  const worktreePushOverride = gitPush(worktreeDir, ['origin', 'feature-branch'], {
    MAVP_ALLOW_WORKTREE_PUSH: '1',
  });
  check(
    worktreePushOverride.status === 0,
    `push from linked worktree with MAVP_ALLOW_WORKTREE_PUSH=1 exits 0 (got ${worktreePushOverride.status}; stderr: ${worktreePushOverride.stderr})`
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed (hook source: ${HOOK_SRC}).`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll T-753 pre-push worktree-refusal assertions passed (hook source: ${HOOK_SRC}).`);
  }
} finally {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
