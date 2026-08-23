'use strict';
// Regression test: T-559 — operator worktree hygiene: classification report
// (`--worktree-report`) + guarded prune (`--prune-worktrees`).
//
// Core claim under test: classification MUST use PATCH-EQUIVALENCE (`git
// cherry`), not raw reachability (`merge-base --is-ancestor` /
// `branch --merged`) — this project integrates by cherry-pick, so a
// worktree tip is unreachable from main by construction even after its work
// is fully, correctly integrated. Test 1 below both classifies the fixture
// AND proves, independently, that the "clean-and-integrated" worktree's tip
// really is unreachable from main by raw ancestry — the only way
// classifyWorktrees() could still call it clean-and-integrated is via
// patch-equivalence.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  classifyWorktrees,
  formatWorktreeHygieneAdvisory,
  formatWorktreePruneSuggestion,
  getPatchEquivalenceStatus,
  UnresolvableMainRefError,
  WORKTREE_PRUNE_MTIME_THRESHOLD_MS,
} = require('./mavp-operator-lib.js');
const { buildWorktreeHygieneAdvisory } = require('./mavp-operator-close-session.js');

const PRUNE_SCRIPT = path.join(__dirname, 'mavp-operator-prune-worktrees.js');
const CLOSE_SESSION_SCRIPT = path.join(__dirname, 'mavp-operator-close-session.js');
const WORKTREE_REPORT_SCRIPT = path.join(__dirname, 'mavp-operator-worktree-report.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Build a repo at <tmp>/main with three linked worktrees under
 * <tmp>/main/.claude/worktrees/ — one of each class the classifier defines:
 *   agent-dirty        — uncommitted changes present
 *   agent-unintegrated — a committed commit that was NEVER integrated
 *   agent-integrated    — clean, and its commit IS patch-equivalent to a
 *                         commit already cherry-picked onto main (so its
 *                         tip stays unreachable from main by construction,
 *                         exactly like a real integrated agent worktree)
 * Also seeds minimal BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.json so the
 * same fixture can drive a real `--close-session` CLI run.
 */
function makeWorktreeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t559-fixture-'));
  const mainDir = path.join(tmp, 'main');
  fs.mkdirSync(mainDir);
  git(['init', '-q', '-b', 'main'], mainDir);
  git(['config', 'user.email', 'demo@example.invalid'], mainDir);
  git(['config', 'user.name', 'Fixture User'], mainDir);
  fs.writeFileSync(path.join(mainDir, 'base.txt'), 'base\n');
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'initial'], mainDir);

  fs.writeFileSync(
    path.join(mainDir, 'BACKLOG.md'),
    ['# Backlog', '', '## Active Wave — Wave 1', '', 'Nothing scheduled.', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(mainDir, 'TASK_STATUS.md'),
    ['# Task Status', '', '## Active tasks', '', '## Recently completed tasks', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(mainDir, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: [],
        next_action: null,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 1,
        last_updated: '2020-01-01',
        deploy_contours: 0,
        wave_summary: null,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'fixture: state artifacts'], mainDir);

  const worktreesDir = path.join(mainDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });

  const dirtyDir = path.join(worktreesDir, 'agent-dirty');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-dirty', dirtyDir], mainDir);
  fs.appendFileSync(path.join(dirtyDir, 'base.txt'), 'dirty change\n');

  const unintegratedDir = path.join(worktreesDir, 'agent-unintegrated');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-unintegrated', unintegratedDir], mainDir);
  fs.writeFileSync(path.join(unintegratedDir, 'never-integrated.txt'), 'unintegrated work\n');
  git(['add', '-A'], unintegratedDir);
  git(['commit', '-q', '-m', 'unintegrated work'], unintegratedDir);

  const integratedDir = path.join(worktreesDir, 'agent-integrated');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-integrated', integratedDir], mainDir);
  fs.writeFileSync(path.join(integratedDir, 'integrated-work.txt'), 'work to cherry-pick\n');
  git(['add', '-A'], integratedDir);
  git(['commit', '-q', '-m', 'work to be cherry-picked'], integratedDir);
  const integratedHash = git(['rev-parse', 'HEAD'], integratedDir).trim();

  // Advance main with unrelated work BEFORE cherry-picking, so the
  // cherry-pick cannot silently fast-forward (git's cherry-pick reuses the
  // exact same commit object — same hash — when HEAD already equals the
  // cherry-picked commit's parent, which would defeat this fixture's whole
  // point). This mirrors the real pattern: other work lands on main between
  // when an agent's worktree branches and when its work is integrated.
  fs.writeFileSync(path.join(mainDir, 'main-progress.txt'), 'unrelated main-only progress\n');
  // NOT `git add -A` here — the worktree directories already exist under
  // .claude/worktrees/ at this point, and -A would sweep them in as
  // (harmless but noisy) embedded-repository gitlinks. Add only the file
  // this step actually intends to commit.
  git(['add', 'main-progress.txt'], mainDir);
  git(['commit', '-q', '-m', 'unrelated main progress'], mainDir);

  // Integration in this project happens by cherry-pick, deliberately never a
  // merge/rebase — so the worktree tip stays unreachable from main even
  // though the content is fully integrated. Because main advanced above,
  // this cherry-pick creates a genuinely NEW commit (different hash from
  // integratedHash) — exactly the scenario raw reachability gets wrong and
  // patch-equivalence gets right.
  git(['cherry-pick', integratedHash], mainDir);

  return { tmp, mainDir, dirtyDir, unintegratedDir, integratedDir };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Age a worktree directory's mtime past WORKTREE_PRUNE_MTIME_THRESHOLD_MS so
 * a clean-and-integrated entry classifies as genuinely `prunable` under the
 * REAL (default, unoverridden) mtime safety window — as opposed to Test 2's
 * approach of overriding `mtimeThresholdMs` down to 0. T-710's live
 * close-session assertions specifically want the real threshold exercised
 * via `fs.utimesSync`, following the existing fixture-aging approach used
 * elsewhere in this file.
 */
function ageWorktreeDirectory(dirPath) {
  const past = new Date(Date.now() - (WORKTREE_PRUNE_MTIME_THRESHOLD_MS + 60 * 1000));
  fs.utimesSync(dirPath, past, past);
}

function runPruneCli(mainDir, argv) {
  return spawnSync(process.execPath, [PRUNE_SCRIPT, ...argv], {
    cwd: mainDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: mainDir },
    encoding: 'utf8',
  });
}

function runCloseSessionCli(mainDir, argv) {
  return spawnSync(process.execPath, [CLOSE_SESSION_SCRIPT, ...argv], {
    cwd: mainDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: mainDir, MAVERICKS_SCRIPTS: __dirname },
    input: '',
    encoding: 'utf8',
  });
}

function runWorktreeReportCli(mainDir, argv) {
  return spawnSync(process.execPath, [WORKTREE_REPORT_SCRIPT, ...argv], {
    cwd: mainDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: mainDir },
    encoding: 'utf8',
  });
}

/**
 * T-633: a fixture whose OWN `git init` is deliberately pinned to `master`
 * (never left to the host default — this is a pin, same as the `main` pin
 * everywhere else in this file, just the other branch name), specifically to
 * exercise `classifyWorktrees()`'s default `mainRef: 'main'` against a repo
 * where `'main'` genuinely does not resolve. One clean, genuinely
 * cherry-pick-integrated worktree — enough to prove `--main-ref master`
 * classifies it correctly once the right ref is named, while the default
 * invocation must refuse before classifying anything.
 */
function makeMasterDefaultWorktreeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t633-master-fixture-'));
  const mainDir = path.join(tmp, 'main');
  fs.mkdirSync(mainDir);
  git(['init', '-q', '-b', 'master'], mainDir);
  git(['config', 'user.email', 'demo@example.invalid'], mainDir);
  git(['config', 'user.name', 'Fixture User'], mainDir);
  fs.writeFileSync(path.join(mainDir, 'base.txt'), 'base\n');
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'initial'], mainDir);

  fs.writeFileSync(
    path.join(mainDir, 'BACKLOG.md'),
    ['# Backlog', '', '## Active Wave — Wave 1', '', 'Nothing scheduled.', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(mainDir, 'TASK_STATUS.md'),
    ['# Task Status', '', '## Active tasks', '', '## Recently completed tasks', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(mainDir, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: [],
        next_action: null,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 1,
        last_updated: '2020-01-01',
        deploy_contours: 0,
        wave_summary: null,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'fixture: state artifacts'], mainDir);

  const worktreesDir = path.join(mainDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });

  const integratedDir = path.join(worktreesDir, 'agent-integrated');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-integrated', integratedDir], mainDir);
  fs.writeFileSync(path.join(integratedDir, 'integrated-work.txt'), 'work to cherry-pick\n');
  git(['add', '-A'], integratedDir);
  git(['commit', '-q', '-m', 'work to be cherry-picked'], integratedDir);
  const integratedHash = git(['rev-parse', 'HEAD'], integratedDir).trim();

  fs.writeFileSync(path.join(mainDir, 'main-progress.txt'), 'unrelated main-only progress\n');
  git(['add', 'main-progress.txt'], mainDir);
  git(['commit', '-q', '-m', 'unrelated main progress'], mainDir);

  git(['cherry-pick', integratedHash], mainDir);

  return { tmp, mainDir, integratedDir };
}

// ---------------------------------------------------------------------------
// Test 1 — classifyWorktrees() classifies each of the three worktrees into
// exactly the right class, via patch-equivalence, not raw reachability.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();
  const entries = classifyWorktrees(fx.mainDir, { mainRef: 'main' });
  const byBranch = Object.fromEntries(entries.map((e) => [e.branch, e]));

  assert.strictEqual(entries.length, 3, `Test 1 FAIL: expected 3 linked worktrees, got ${entries.length}`);
  assert.strictEqual(
    byBranch['worktree-agent-dirty'].classification,
    'dirty',
    'Test 1 FAIL: dirty worktree misclassified'
  );
  assert.strictEqual(
    byBranch['worktree-agent-unintegrated'].classification,
    'unintegrated',
    'Test 1 FAIL: unintegrated worktree misclassified'
  );
  assert.strictEqual(
    byBranch['worktree-agent-integrated'].classification,
    'clean-and-integrated',
    'Test 1 FAIL: clean-and-integrated worktree misclassified — this is the exact case raw ' +
      'reachability gets WRONG (a cherry-picked commit is unreachable from main by construction)'
  );

  // Prove the fixture invariant: the integrated worktree's tip is NOT a raw
  // ancestor of main. If it WERE an ancestor, a naive reachability check
  // would happen to get this case right too, and the test would prove
  // nothing about patch-equivalence specifically.
  const isAncestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', 'worktree-agent-integrated', 'main'],
    { cwd: fx.mainDir }
  );
  assert.notStrictEqual(
    isAncestor.status,
    0,
    'Test 1 FAIL: fixture invariant broken — the integrated worktree tip must NOT be a raw ' +
      'ancestor of main (that is the whole point of this fixture)'
  );

  console.log(
    'Test 1 passed: classifyWorktrees() correctly classifies dirty/unintegrated/clean-and-integrated ' +
      'via patch-equivalence, in a fixture where raw reachability would misclassify the integrated worktree.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 2 — mtime safety condition: a freshly-created clean-and-integrated
// worktree is NOT prunable (protects a just-spawned live agent's still-clean
// worktree); it becomes prunable once the mtime threshold is overridden down
// to 0 (simulating an aged worktree).
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();

  const freshEntries = classifyWorktrees(fx.mainDir, { mainRef: 'main' });
  const freshIntegrated = freshEntries.find((e) => e.branch === 'worktree-agent-integrated');
  assert.strictEqual(
    freshIntegrated.classification,
    'clean-and-integrated',
    'Test 2 FAIL: expected clean-and-integrated classification'
  );
  assert.strictEqual(
    freshIntegrated.prunable,
    false,
    'Test 2 FAIL: a freshly-created worktree must NOT be prunable by default (mtime safety window)'
  );

  const agedEntries = classifyWorktrees(fx.mainDir, { mainRef: 'main', mtimeThresholdMs: 0 });
  const agedIntegrated = agedEntries.find((e) => e.branch === 'worktree-agent-integrated');
  assert.strictEqual(
    agedIntegrated.prunable,
    true,
    'Test 2 FAIL: with mtimeThresholdMs overridden to 0, the clean-and-integrated worktree should become prunable'
  );
  const agedDirty = agedEntries.find((e) => e.branch === 'worktree-agent-dirty');
  const agedUnintegrated = agedEntries.find((e) => e.branch === 'worktree-agent-unintegrated');
  assert.strictEqual(agedDirty.prunable, false, 'Test 2 FAIL: dirty worktree must never be prunable regardless of mtime');
  assert.strictEqual(
    agedUnintegrated.prunable,
    false,
    'Test 2 FAIL: unintegrated worktree must never be prunable regardless of mtime'
  );

  console.log(
    'Test 2 passed: mtime safety condition withholds pruning for a fresh worktree, and only the ' +
      'clean-and-integrated class becomes prunable once the safety window is overridden.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 3 (mutant-killer) — a real `--prune-worktrees --yes` run removes ONLY
// the clean-and-integrated worktree; the dirty and unintegrated worktrees
// both survive.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();

  const dryRun = runPruneCli(fx.mainDir, ['--mtime-threshold', '0']);
  assert.strictEqual(dryRun.status, 0, `Test 3 FAIL: dry-run should exit 0 (stdout: ${dryRun.stdout}\nstderr: ${dryRun.stderr})`);
  assert.ok(/DRY RUN/.test(dryRun.stdout), `Test 3 FAIL: expected a DRY RUN banner (stdout: ${dryRun.stdout})`);
  assert.ok(fs.existsSync(fx.integratedDir), 'Test 3 FAIL: dry-run must not remove anything');

  const realRun = runPruneCli(fx.mainDir, ['--yes', '--mtime-threshold', '0']);
  assert.strictEqual(
    realRun.status,
    0,
    `Test 3 FAIL: real prune run should exit 0 (stdout: ${realRun.stdout}\nstderr: ${realRun.stderr})`
  );

  // The clean-and-integrated worktree is gone (directory AND branch).
  assert.ok(!fs.existsSync(fx.integratedDir), 'Test 3 FAIL: clean-and-integrated worktree directory should be removed');
  const branchList = git(['branch', '--list', 'worktree-agent-integrated'], fx.mainDir).trim();
  assert.strictEqual(branchList, '', 'Test 3 FAIL: clean-and-integrated worktree branch should be deleted');

  // Mutant-killer assertion: the dirty and unintegrated worktrees BOTH
  // survive the prune run untouched.
  assert.ok(fs.existsSync(fx.dirtyDir), 'Test 3 FAIL (mutant-killer): dirty worktree must survive the prune run');
  assert.ok(
    fs.existsSync(fx.unintegratedDir),
    'Test 3 FAIL (mutant-killer): unintegrated worktree must survive the prune run'
  );
  const dirtyBranchList = git(['branch', '--list', 'worktree-agent-dirty'], fx.mainDir).trim();
  const unintegratedBranchList = git(['branch', '--list', 'worktree-agent-unintegrated'], fx.mainDir).trim();
  assert.ok(dirtyBranchList.includes('worktree-agent-dirty'), 'Test 3 FAIL (mutant-killer): dirty branch must survive');
  assert.ok(
    unintegratedBranchList.includes('worktree-agent-unintegrated'),
    'Test 3 FAIL (mutant-killer): unintegrated branch must survive'
  );

  const worktreeListAfter = git(['worktree', 'list'], fx.mainDir);
  assert.ok(worktreeListAfter.includes('agent-dirty'), 'Test 3 FAIL: git worktree list must still show agent-dirty');
  assert.ok(
    worktreeListAfter.includes('agent-unintegrated'),
    'Test 3 FAIL: git worktree list must still show agent-unintegrated'
  );
  assert.ok(
    !worktreeListAfter.includes('agent-integrated'),
    'Test 3 FAIL: git worktree list must no longer show agent-integrated'
  );

  console.log(
    'Test 3 passed (mutant-killer): --prune-worktrees --yes removed ONLY the clean-and-integrated ' +
      'worktree; the dirty and unintegrated worktrees both survived the run.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 4 — buildWorktreeHygieneAdvisory() returns null when
// `.claude/worktrees` is absent/empty, and the correct one-line summary
// (shared formatWorktreeHygieneAdvisory() implementation) when populated.
// ---------------------------------------------------------------------------
{
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t559-empty-'));
  git(['init', '-q', '-b', 'main'], emptyRepo);
  const noWorktreesAdvisory = buildWorktreeHygieneAdvisory(emptyRepo);
  assert.strictEqual(
    noWorktreesAdvisory,
    null,
    'Test 4 FAIL: advisory must be null when .claude/worktrees does not exist'
  );
  cleanup(emptyRepo);

  const fx = makeWorktreeFixture();
  const advisory = buildWorktreeHygieneAdvisory(fx.mainDir);
  assert.ok(advisory, 'Test 4 FAIL: advisory should be non-null when .claude/worktrees is populated');
  assert.ok(/^Worktree hygiene: 3 agent worktree\(s\)/.test(advisory), `Test 4 FAIL: unexpected advisory text: ${advisory}`);
  assert.ok(/1 dirty/.test(advisory), `Test 4 FAIL: expected "1 dirty" in advisory: ${advisory}`);
  assert.ok(/1 unintegrated/.test(advisory), `Test 4 FAIL: expected "1 unintegrated" in advisory: ${advisory}`);
  assert.ok(
    /1 clean-and-integrated/.test(advisory),
    `Test 4 FAIL: expected "1 clean-and-integrated" in advisory: ${advisory}`
  );
  assert.strictEqual(
    advisory,
    formatWorktreeHygieneAdvisory(classifyWorktrees(fx.mainDir)),
    'Test 4 FAIL: buildWorktreeHygieneAdvisory() must delegate to the shared formatWorktreeHygieneAdvisory() implementation'
  );

  // T-710: on this all-fresh fixture, none of the three worktrees is
  // prunable (the clean-and-integrated one is too recently created), so the
  // composed advisory must still equal ONLY the shared counts line — no
  // suggestion line appended. Confirms the no-suggestion case is untouched
  // by the composition added in this task.
  assert.strictEqual(
    advisory.split('\n').length,
    1,
    `Test 4 FAIL: an all-fresh fixture must produce a single-line advisory (no suggestion line): ${advisory}`
  );

  cleanup(fx.tmp);

  // T-710: extend the delegation invariant to the COMPOSED case — age the
  // clean-and-integrated worktree past the real mtime safety window so it
  // becomes genuinely prunable, then assert line 1 equals the shared counts
  // formatter and line 2 equals formatWorktreePruneSuggestion(entries).
  const fx2 = makeWorktreeFixture();
  ageWorktreeDirectory(fx2.integratedDir);
  const entries2 = classifyWorktrees(fx2.mainDir);
  const advisory2 = buildWorktreeHygieneAdvisory(fx2.mainDir);
  const lines2 = advisory2.split('\n');
  assert.strictEqual(
    lines2.length,
    2,
    `Test 4 FAIL: an aged-prunable fixture must produce a two-line composed advisory: ${advisory2}`
  );
  assert.strictEqual(
    lines2[0],
    formatWorktreeHygieneAdvisory(entries2),
    'Test 4 FAIL: composed advisory line 1 must equal the shared counts formatter, byte-for-byte'
  );
  assert.strictEqual(
    lines2[1],
    formatWorktreePruneSuggestion(entries2),
    'Test 4 FAIL: composed advisory line 2 must equal formatWorktreePruneSuggestion(entries), byte-for-byte'
  );

  console.log(
    'Test 4 passed: buildWorktreeHygieneAdvisory() degrades to null when absent/empty, matches the shared ' +
      'formatter (single line) when no worktree is prunable, and composes counts+suggestion (two lines, each ' +
      "matching the shared formatters byte-for-byte) once a worktree is genuinely prunable."
  );
  cleanup(fx2.tmp);
}

// ---------------------------------------------------------------------------
// Test 5 — a real `--close-session --non-interactive` run prints the
// worktree-hygiene advisory line and NEVER prunes anything.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();

  const result = runCloseSessionCli(fx.mainDir, ['--non-interactive']);
  assert.ok(
    /Worktree hygiene: 3 agent worktree\(s\) — 1 dirty, 1 unintegrated, 1 clean-and-integrated/.test(result.stdout),
    `Test 5 FAIL: expected the worktree-hygiene advisory line in close-session output (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );

  // close-session must NEVER prune — all three worktrees still exist.
  assert.ok(fs.existsSync(fx.dirtyDir), 'Test 5 FAIL: close-session must never remove the dirty worktree');
  assert.ok(fs.existsSync(fx.unintegratedDir), 'Test 5 FAIL: close-session must never remove the unintegrated worktree');
  assert.ok(
    fs.existsSync(fx.integratedDir),
    'Test 5 FAIL: close-session must never remove the clean-and-integrated worktree either — it is advisory-only'
  );

  console.log(
    'Test 5 passed: --close-session --non-interactive prints the worktree-hygiene advisory line and prunes nothing.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 6 (T-633) — an unresolvable mainRef throws UnresolvableMainRefError
// BEFORE any per-worktree work, on a repo that otherwise classifies fine.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();

  assert.throws(
    () => classifyWorktrees(fx.mainDir, { mainRef: 'totally-bogus-ref-does-not-exist' }),
    UnresolvableMainRefError,
    'Test 6 FAIL: classifyWorktrees() must throw UnresolvableMainRefError for an unresolvable mainRef'
  );
  try {
    classifyWorktrees(fx.mainDir, { mainRef: 'totally-bogus-ref-does-not-exist' });
    assert.fail('Test 6 FAIL: expected classifyWorktrees() to throw');
  } catch (err) {
    assert.ok(err instanceof UnresolvableMainRefError, 'Test 6 FAIL: wrong error type');
    assert.strictEqual(err.code, 'UNRESOLVABLE_MAIN_REF', 'Test 6 FAIL: wrong error code');
    assert.strictEqual(
      err.mainRef,
      'totally-bogus-ref-does-not-exist',
      'Test 6 FAIL: error must carry the offending ref'
    );
  }

  // The same repo classifies correctly with a resolvable mainRef — the throw
  // above is specific to the bad ref, not a fixture problem.
  const entries = classifyWorktrees(fx.mainDir, { mainRef: 'main' });
  assert.strictEqual(entries.length, 3, 'Test 6 FAIL: fixture should still classify normally with a valid mainRef');

  console.log(
    'Test 6 passed: classifyWorktrees() throws UnresolvableMainRefError for an unresolvable mainRef, ' +
      'naming the offending ref, while a valid mainRef on the same repo still classifies normally.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 7 (T-633, mutant-killer for the caller-vs-per-entry distinction) — the
// per-worktree getPatchEquivalenceStatus() 'unknown' fallback for an
// individually broken worktree (missing commit object) is preserved
// byte-for-byte: classifyWorktrees() does NOT throw, and the broken entry's
// patchStatus is 'unknown' with classification 'unintegrated' — the same
// conservative fallback as before this task, on a mainRef that resolves fine.
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t633-broken-object-'));
  const mainDir = path.join(tmp, 'main');
  fs.mkdirSync(mainDir);
  git(['init', '-q', '-b', 'main'], mainDir);
  git(['config', 'user.email', 'demo@example.invalid'], mainDir);
  git(['config', 'user.name', 'Fixture User'], mainDir);
  fs.writeFileSync(path.join(mainDir, 'base.txt'), 'base\n');
  git(['add', '-A'], mainDir);
  git(['commit', '-q', '-m', 'initial'], mainDir);

  const worktreesDir = path.join(mainDir, '.claude', 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });

  const brokenDir = path.join(worktreesDir, 'agent-broken');
  git(['worktree', 'add', '-q', '-b', 'worktree-agent-broken', brokenDir], mainDir);
  fs.writeFileSync(path.join(brokenDir, 'broken-work.txt'), 'broken work\n');
  git(['add', '-A'], brokenDir);
  git(['commit', '-q', '-m', 'broken worktree commit'], brokenDir);
  const brokenHash = git(['rev-parse', 'HEAD'], brokenDir).trim();

  // Directly confirm getPatchEquivalenceStatus()'s own documented fallback
  // for a git failure (here: a ref lookup against a deliberately bogus ref)
  // still returns 'unknown', unchanged by this task.
  assert.strictEqual(
    getPatchEquivalenceStatus(mainDir, 'main', 'this-ref-does-not-exist'),
    'unknown',
    'Test 7 FAIL: getPatchEquivalenceStatus() must still return \'unknown\' on a git failure'
  );

  // Now break the worktree for real: delete the loose object backing its own
  // HEAD commit, simulating exactly the "broken worktree, missing object"
  // case this task's brief calls out as the fallback that must be preserved.
  const objPath = path.join(mainDir, '.git', 'objects', brokenHash.slice(0, 2), brokenHash.slice(2));
  assert.ok(fs.existsSync(objPath), 'Test 7 FAIL: fixture invariant — the loose object must exist before deletion');
  fs.unlinkSync(objPath);

  let entries;
  assert.doesNotThrow(
    () => {
      entries = classifyWorktrees(mainDir, { mainRef: 'main' });
    },
    'Test 7 FAIL: classifyWorktrees() must NOT throw for a single broken worktree when mainRef itself resolves fine'
  );
  assert.strictEqual(entries.length, 1, 'Test 7 FAIL: expected exactly one linked worktree');
  assert.strictEqual(
    entries[0].patchStatus,
    'unknown',
    'Test 7 FAIL: the broken worktree\'s patchStatus must fall back to \'unknown\''
  );
  assert.strictEqual(
    entries[0].classification,
    'unintegrated',
    'Test 7 FAIL: the broken worktree must conservatively classify as \'unintegrated\', never \'clean-and-integrated\''
  );

  console.log(
    'Test 7 passed: the per-entry unknown-to-unintegrated conservative fallback for an individually ' +
      'broken worktree (missing commit object) is preserved — classifyWorktrees() does not throw, and ' +
      'only that entry degrades, while a resolvable mainRef never triggers the caller-level refusal.'
  );
  cleanup(tmp);
}

// ---------------------------------------------------------------------------
// Test 8 (T-633) — on a fixture whose OWN git init is pinned to `master`
// (never the host default), the default `--worktree-report` invocation
// (implicit mainRef 'main', which does not exist here) exits non-zero,
// names 'main', and points at --main-ref — BEFORE printing any per-worktree
// classification.
// ---------------------------------------------------------------------------
{
  const fx = makeMasterDefaultWorktreeFixture();

  const result = runWorktreeReportCli(fx.mainDir, []);
  assert.notStrictEqual(
    result.status,
    0,
    `Test 8 FAIL: default-ref --worktree-report must exit non-zero on a master-default repo (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /mainRef 'main'/.test(result.stderr),
    `Test 8 FAIL: expected the refusal to name 'main' (stderr: ${result.stderr})`
  );
  assert.ok(
    /--main-ref/.test(result.stderr),
    `Test 8 FAIL: expected the refusal to point at --main-ref (stderr: ${result.stderr})`
  );
  assert.strictEqual(
    result.stdout,
    '',
    `Test 8 FAIL: no per-worktree classification may print before the refusal (stdout: ${result.stdout})`
  );

  console.log(
    'Test 8 passed: default-ref --worktree-report on a master-default repo exits non-zero, names \'main\', ' +
      'points at --main-ref, and prints no per-worktree classification.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 9 (T-633) — the SAME master-default fixture, invoked with
// `--main-ref master`, classifies the genuinely cherry-pick-integrated
// worktree as clean-and-integrated (the correct half the architect already
// executed and quoted in the brief; this is its first codified assertion).
// ---------------------------------------------------------------------------
{
  const fx = makeMasterDefaultWorktreeFixture();

  const result = runWorktreeReportCli(fx.mainDir, ['--main-ref', 'master']);
  assert.strictEqual(
    result.status,
    0,
    `Test 9 FAIL: --main-ref master should exit 0 on this fixture (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /clean-and-integrated/.test(result.stdout),
    `Test 9 FAIL: expected clean-and-integrated classification (stdout: ${result.stdout})`
  );

  // Cross-check via the library function directly, not just CLI text.
  const entries = classifyWorktrees(fx.mainDir, { mainRef: 'master' });
  assert.strictEqual(entries.length, 1, 'Test 9 FAIL: expected exactly one linked worktree');
  assert.strictEqual(
    entries[0].classification,
    'clean-and-integrated',
    'Test 9 FAIL: the integrated worktree must classify as clean-and-integrated once the correct ref is named'
  );

  console.log(
    'Test 9 passed: on the same master-default fixture, --main-ref master correctly classifies the ' +
      'integrated worktree as clean-and-integrated.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 10 (T-633) — on the master-default fixture, --close-session
// --non-interactive still completes (exit 0) and degrades the worktree-
// hygiene advisory to a single line naming the unresolved ref, rather than
// throwing or silently printing nothing.
// ---------------------------------------------------------------------------
{
  const fx = makeMasterDefaultWorktreeFixture();

  const result = runCloseSessionCli(fx.mainDir, ['--non-interactive']);
  assert.strictEqual(
    result.status,
    0,
    `Test 10 FAIL: close-session must still complete on an unresolvable mainRef (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /Worktree hygiene: unable to classify — mainRef 'main' does not resolve to a commit/.test(result.stdout),
    `Test 10 FAIL: expected the degraded single-line advisory naming 'main' (stdout: ${result.stdout})`
  );
  assert.ok(
    /--worktree-report --main-ref/.test(result.stdout),
    `Test 10 FAIL: expected the degraded advisory to point at --worktree-report --main-ref (stdout: ${result.stdout})`
  );

  // T-710 (stand-down): the degraded UnresolvableMainRefError line must
  // carry NO prune-suggestion text — a suggestion derived from a
  // classification that never ran would be an unsound proposal.
  assert.ok(
    !/--prune-worktrees/.test(result.stdout),
    `Test 10 FAIL (T-710): the UnresolvableMainRefError stand-down line must not mention --prune-worktrees ` +
      `(stdout: ${result.stdout})`
  );
  assert.ok(
    !/Suggested:/.test(result.stdout),
    `Test 10 FAIL (T-710): the UnresolvableMainRefError stand-down line must carry no suggestion text at all ` +
      `(stdout: ${result.stdout})`
  );

  console.log(
    'Test 10 passed: --close-session --non-interactive completes on a master-default repo and degrades ' +
      'the worktree-hygiene advisory to a single line naming the unresolved ref, with no prune-suggestion text.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 11 (T-633) — the Definition of Done also names --prune-worktrees
// explicitly: on the same master-default fixture, the default invocation
// must exit non-zero, naming 'main' and pointing at --main-ref, BEFORE
// printing any per-worktree classification (and no dry-run banner either).
// ---------------------------------------------------------------------------
{
  const fx = makeMasterDefaultWorktreeFixture();

  const result = runPruneCli(fx.mainDir, []);
  assert.notStrictEqual(
    result.status,
    0,
    `Test 11 FAIL: default-ref --prune-worktrees must exit non-zero on a master-default repo (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /mainRef 'main'/.test(result.stderr),
    `Test 11 FAIL: expected the refusal to name 'main' (stderr: ${result.stderr})`
  );
  assert.ok(
    /--main-ref/.test(result.stderr),
    `Test 11 FAIL: expected the refusal to point at --main-ref (stderr: ${result.stderr})`
  );
  assert.strictEqual(
    result.stdout,
    '',
    `Test 11 FAIL: no per-worktree classification (nor a DRY RUN banner) may print before the refusal (stdout: ${result.stdout})`
  );
  assert.ok(fs.existsSync(fx.integratedDir), 'Test 11 FAIL: the refusal path must not touch the worktree');

  console.log(
    'Test 11 passed: default-ref --prune-worktrees on a master-default repo exits non-zero, names \'main\', ' +
      'points at --main-ref, and prints nothing (no classification, no dry-run banner) before refusing.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 12 (T-710) — unit: formatWorktreePruneSuggestion() returns null at
// prunable == 0 (both the all-fresh case and the clean-but-mtime-held
// case), returns a non-null string at prunable > 0, and appends the
// held-back clause exactly when clean-and-integrated count exceeds
// prunable count.
// ---------------------------------------------------------------------------
{
  // All-fresh: no clean-and-integrated entries at all.
  assert.strictEqual(
    formatWorktreePruneSuggestion([
      { classification: 'dirty', prunable: false },
      { classification: 'unintegrated', prunable: false },
    ]),
    null,
    'Test 12 FAIL: suggestion must be null when no entry is clean-and-integrated'
  );

  // Clean-but-mtime-held: clean-and-integrated entries exist, but none is
  // prunable (all held back by the mtime window).
  assert.strictEqual(
    formatWorktreePruneSuggestion([
      { classification: 'clean-and-integrated', prunable: false },
      { classification: 'clean-and-integrated', prunable: false },
    ]),
    null,
    'Test 12 FAIL: suggestion must be null when clean-and-integrated entries exist but none is prunable'
  );

  // prunable > 0, clean === prunable: no held-back clause.
  const noClauseSuggestion = formatWorktreePruneSuggestion([
    { classification: 'clean-and-integrated', prunable: true },
    { classification: 'clean-and-integrated', prunable: true },
  ]);
  assert.ok(noClauseSuggestion, 'Test 12 FAIL: suggestion must be non-null when prunable > 0');
  assert.ok(
    !/held back/.test(noClauseSuggestion),
    `Test 12 FAIL: no held-back clause expected when clean-and-integrated === prunable: ${noClauseSuggestion}`
  );
  assert.ok(
    /preview 2 removable worktree\(s\)/.test(noClauseSuggestion),
    `Test 12 FAIL: expected the prunable count in the suggestion text: ${noClauseSuggestion}`
  );

  // prunable > 0, clean > prunable: held-back clause present, naming the gap.
  const withClauseSuggestion = formatWorktreePruneSuggestion([
    { classification: 'clean-and-integrated', prunable: true },
    { classification: 'clean-and-integrated', prunable: false },
    { classification: 'unintegrated', prunable: false },
  ]);
  assert.ok(withClauseSuggestion, 'Test 12 FAIL: suggestion must be non-null when prunable > 0');
  assert.ok(
    /1 more clean-and-integrated held back by the mtime safety window/.test(withClauseSuggestion),
    `Test 12 FAIL: expected the held-back clause naming the gap (1): ${withClauseSuggestion}`
  );

  console.log(
    'Test 12 passed: formatWorktreePruneSuggestion() is null at prunable == 0 (both all-fresh and ' +
      'clean-but-mtime-held), non-null at prunable > 0, and appends the held-back clause exactly when ' +
      'clean-and-integrated count exceeds prunable count.'
  );
}

// ---------------------------------------------------------------------------
// Test 13 (T-710, mutant-killer) — the RUNNABLE COMMAND quoted inside the
// suggestion line is exactly the dry-run form and NEVER contains --yes.
// (The surrounding prose is allowed to reference "--yes" as the manual
// follow-up step — see the brief's "attach the zero-live-sub-agents
// constraint to the --yes step in the line's wording" — so this asserts
// against the QUOTED command substring specifically, not the whole line;
// checking the whole line would false-fail on that legitimate wording.)
// Verified to actually fail against a mutant that appends --yes inside the
// quotes (see task evidence — mutated mavp-operator-lib.js, re-ran this
// file, reverted).
// ---------------------------------------------------------------------------
{
  const suggestion = formatWorktreePruneSuggestion([
    { classification: 'clean-and-integrated', prunable: true },
  ]);
  assert.ok(suggestion, 'Test 13 FAIL: expected a non-null suggestion');

  const match = /run '([^']+)'/.exec(suggestion);
  assert.ok(match, `Test 13 FAIL: expected a single-quoted runnable command in the suggestion: ${suggestion}`);
  assert.strictEqual(
    match[1],
    './scripts/mavp-operator --prune-worktrees',
    `Test 13 FAIL (mutant-killer): the quoted runnable command must be exactly the dry-run form, no --yes: ${suggestion}`
  );

  console.log(
    'Test 13 passed (mutant-killer): the quoted runnable command is exactly the dry-run form and never contains --yes.'
  );
}

// ---------------------------------------------------------------------------
// Test 14 (T-710) — a real `--close-session --non-interactive` run, on a
// fixture with one clean-and-integrated worktree aged past the REAL mtime
// safety window (via fs.utimesSync, not an overridden threshold), prints
// BOTH the counts line and the suggestion line, and removes no worktree.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();
  ageWorktreeDirectory(fx.integratedDir);

  const result = runCloseSessionCli(fx.mainDir, ['--non-interactive']);
  assert.ok(
    /Worktree hygiene: 3 agent worktree\(s\) — 1 dirty, 1 unintegrated, 1 clean-and-integrated \(1 prunable\)/.test(
      result.stdout
    ),
    `Test 14 FAIL: expected the counts line with 1 prunable (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /Suggested: run '\.\/scripts\/mavp-operator --prune-worktrees' \(dry-run\)/.test(result.stdout),
    `Test 14 FAIL: expected the suggestion line in close-session output (stdout: ${result.stdout})`
  );
  // The quoted RUNNABLE command must never contain --yes (prose elsewhere in
  // the line is allowed to mention "--yes" as the manual follow-up step).
  const quotedCommandMatch = /run '([^']+)'/.exec(result.stdout);
  assert.ok(quotedCommandMatch, `Test 14 FAIL: expected a quoted runnable command (stdout: ${result.stdout})`);
  assert.strictEqual(
    quotedCommandMatch[1],
    './scripts/mavp-operator --prune-worktrees',
    `Test 14 FAIL: the quoted runnable command must be exactly the dry-run form, no --yes (stdout: ${result.stdout})`
  );

  // close-session must remove NO worktree, even though one is now prunable.
  assert.ok(fs.existsSync(fx.dirtyDir), 'Test 14 FAIL: close-session must never remove the dirty worktree');
  assert.ok(
    fs.existsSync(fx.unintegratedDir),
    'Test 14 FAIL: close-session must never remove the unintegrated worktree'
  );
  assert.ok(
    fs.existsSync(fx.integratedDir),
    'Test 14 FAIL: close-session must never remove the clean-and-integrated worktree either, even though ' +
      'it is now prunable — the advisory is propose-only'
  );

  console.log(
    'Test 14 passed: --close-session --non-interactive prints both the counts line and the suggestion line ' +
      'on a genuinely-aged-prunable fixture, and removes no worktree.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 15 (T-710, absence) — on the all-fresh fixture (no worktree aged),
// --close-session --non-interactive prints the counts line but NO
// suggestion line.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();

  const result = runCloseSessionCli(fx.mainDir, ['--non-interactive']);
  assert.ok(
    /Worktree hygiene: 3 agent worktree\(s\) — 1 dirty, 1 unintegrated, 1 clean-and-integrated \(0 prunable\)/.test(
      result.stdout
    ),
    `Test 15 FAIL: expected the counts line with 0 prunable (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    !/Suggested:/.test(result.stdout),
    `Test 15 FAIL: an all-fresh fixture (0 prunable) must print no suggestion line (stdout: ${result.stdout})`
  );
  assert.ok(
    !/--prune-worktrees --yes/.test(result.stdout),
    `Test 15 FAIL: no destructive command text may appear (stdout: ${result.stdout})`
  );

  console.log(
    'Test 15 passed: on the all-fresh fixture (0 prunable), --close-session --non-interactive prints the ' +
      'counts line only, with no suggestion line.'
  );
  cleanup(fx.tmp);
}

// ---------------------------------------------------------------------------
// Test 16 (T-710) — --worktree-report also appends the suggestion line
// after its existing summary line, once a worktree is genuinely prunable
// (same aged fixture as Test 14), and prints nothing extra when none is.
// ---------------------------------------------------------------------------
{
  const fx = makeWorktreeFixture();
  ageWorktreeDirectory(fx.integratedDir);

  const result = runWorktreeReportCli(fx.mainDir, []);
  assert.strictEqual(
    result.status,
    0,
    `Test 16 FAIL: --worktree-report should exit 0 (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    /\(1 prunable\)/.test(result.stdout),
    `Test 16 FAIL: expected "(1 prunable)" in --worktree-report output (stdout: ${result.stdout})`
  );
  assert.ok(
    /Suggested: run '\.\/scripts\/mavp-operator --prune-worktrees' \(dry-run\)/.test(result.stdout),
    `Test 16 FAIL: expected the suggestion line appended after the summary line (stdout: ${result.stdout})`
  );

  console.log('Test 16 passed: --worktree-report appends the suggestion line once a worktree is genuinely prunable.');
  cleanup(fx.tmp);
}

console.log('All T-559/T-633/T-710 assertions passed.');
