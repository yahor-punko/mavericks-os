'use strict';
// Regression test: T-513 — mavp-publish-build.js (the working-build publish
// orchestrator, T-501) had ZERO test coverage before this file. It is the
// one code path that writes to a public mirror; a prior remediation round
// found two real bypasses in it and it took three security-review rounds to
// close. This file exists so a regression in its scan gate, its
// mandatory-flag gate, or its size floor ships loudly (a red test) instead of
// silently (a QA report nobody re-runs).
//
// Every `<mirror-remote>` used below is a LOCAL `--bare` temp dir standing in
// for the public mirror — never a URL, never a pre-existing clone, never
// anything under an adopter's real checkout. No tag or branch is ever
// created in THIS repository (the fixtures below operate entirely inside
// their own throwaway clones/mirrors).
//
// Structural note (see this task's brief): mavp-publish-build.js resolves
// REPO_ROOT from __dirname, so it always assembles/scans/pushes from whatever
// repository IT physically lives in. Two consequences drive this file's
// design:
//   (a) The mandatory --private-names gate (parsePrivateNamesList) and the
//       pure module.exports helpers (parseArgs, countFilesRecursive,
//       assertAssembledTreeNonTrivial) can be exercised directly against the
//       REAL in-place script/module — the private-names gate runs BEFORE
//       assertCleanSourceRepo() ever reads this repo's git status, so it is
//       unaffected by whatever is dirty in this checkout mid-session (the
//       exact coupling T-508 had to fix in another test). assertAssembled-
//       TreeNonTrivial() is also called directly against the real REPO_ROOT
//       (this worktree) — its git-tracked-count denominator is computed
//       fresh at test-run time via `git ls-files`, never hardcoded, so it
//       stays correct as the repo grows.
//   (b) The three behavioral end-to-end cases (planted-finding abort,
//       legitimate-value pass-through, and the size-floor firing on a
//       reclassified manifest) each need their OWN, self-contained
//       REPO_ROOT — so each clones this repo (`git clone <this repo>
//       <temp dir>`) and runs the CLONE's own copy of mavp-publish-build.js.
//       That clone is committed clean immediately after cloning (and again
//       after any fixture edit), so these cases never depend on this
//       worktree's ambient dirty/clean state either.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(__dirname, 'mavp-publish-build.js');

// T-524: sourced from the real, in-place module purely as a literal-list
// constant for Test 11c's manual probe below (that probe is not testing this
// script's own behavior — it verifies git's own mirror-mode refusal — so
// sourcing from the working-tree copy, same as the other pure-helper requires
// elsewhere in this file, is fine here). Drift resistance for the ACTUAL
// call site is Test 11a's job (see EXPECTED_EDGE_PUSH_ARGS + cloneRepoDir
// require below), not this one.
const { EDGE_PUSH_ARGS } = require(BUILD_SCRIPT);

// T-524: the expected edge-push argv, asserted against the exported
// EDGE_PUSH_ARGS constant below rather than assumed — this literal exists
// here as the INDEPENDENT expectation a test needs, not as a duplicate of
// what the script issues; the script's own argv is read from its own export.
const EXPECTED_EDGE_PUSH_ARGS = [
  'push',
  '--no-follow-tags',
  '--recurse-submodules=no',
  'origin',
  'refs/heads/edge:refs/heads/edge',
];

const tempDirs = [];
function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.on('exit', cleanupTempDirs);

// Pin identity at invocation level, not via cloneRepoFixture(): Test 10's
// cloneDirTarget is produced by mavp-publish-build.js itself (the system
// under test), so a fixture-creation helper can never reach it. `-c` on the
// command line counts as configuration for git's `user.useConfigOnly`, so
// this satisfies even the strictest identity-derivation lockdown.
function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
}

// `git show-ref` exits non-zero when a repo has zero refs (that's exactly
// the "nothing was ever pushed" case Tests 1 and 4 assert on) — capture
// rather than let execFileSync throw on that expected non-zero exit.
function gitShowRefOrEmpty(gitDir) {
  const result = spawnSync('git', ['--git-dir', gitDir, 'show-ref'], { encoding: 'utf8' });
  return (result.stdout || '').trim();
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// Clones THIS repo into a fresh temp dir (never a URL, never the real
// mavericks checkout being mutated) and configures a throwaway fixture
// identity for commits made inside it. The clone's own copy of
// mavp-publish-build.js resolves ITS OWN REPO_ROOT to this temp dir, which is
// exactly the structural workaround this task's brief calls for.
function cloneRepoFixture(prefix) {
  const dir = mkTempDir(prefix);
  execFileSync('git', ['clone', '--quiet', REPO_ROOT, dir]);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture User']);
  return dir;
}

function initBareMirror(prefix) {
  const dir = mkTempDir(prefix);
  execFileSync('git', ['init', '-q', '--bare'], { cwd: dir });
  return dir;
}

// T-514 fixtures: a bare mirror seeded with ONLY a `main` branch (a single
// --allow-empty commit — the "vacuously safe" zero-file case
// mavp-publish-overlay.js's own deletion-ratio guard already documents for a
// freshly bootstrapped `edge`), and deliberately NO `edge` ref at all — this
// is the exact starting shape QA's T-514 reproduction described.
function initBareMirrorWithMain(prefix) {
  const bareDir = initBareMirror(`${prefix}bare-`);
  const seedDir = mkTempDir(`${prefix}seed-`);
  execFileSync('git', ['init', '-q', '-b', 'main', seedDir]);
  git(seedDir, ['config', 'user.email', 'fixture@example.invalid']);
  git(seedDir, ['config', 'user.name', 'Fixture User']);
  git(seedDir, ['commit', '-q', '--allow-empty', '-m', 'seed: empty mirror main']);
  git(seedDir, ['remote', 'add', 'origin', bareDir]);
  git(seedDir, ['push', '-q', 'origin', 'main']);
  return bareDir;
}

// T-587 — the receipt-writer the publish preflight (step 0.5) consumes.
// Sourced from the writer module itself rather than hand-rolling the JSON here,
// so a change to the receipt path or shape cannot silently leave these fixtures
// writing a file nothing reads. Fixtures write it against their own clone's
// HEAD and NEVER run an inner suite: mavp-publish-build.js's gate is
// evidence-based precisely so these clone-based e2e cases stay affordable and
// non-recursive (each assembled tree contains THIS file, which clones again —
// see check-assembled-suite.js's header).
const { writeReceiptForHead } = require(path.join(__dirname, 'check-assembled-suite.js'));

// Runs a CLONE's own scripts/mavp-publish-build.js as a CLI subprocess.
// `extraOpts` (T-523 round 2) is spread into spawnSync's options — used only by
// the cases that must run the script under a modified environment (an exported
// identity, or a `git` wrapper earlier on PATH). Every other call passes
// nothing and keeps inheriting this process's environment unchanged.
//
// T-587: every call writes a fresh assembled-suite receipt for the clone's
// CURRENT HEAD first, so the step-0.5 gate is satisfied for whatever commit
// this particular fixture just created (several cases commit between two runs
// against the same clone). The receipt is git-ignored by the shipped
// .gitignore, so it never dirties the clone the script then requires to be
// clean, and never reaches the assembled tree (which comes from HEAD).
// Tests that must observe the gate REFUSING pass `{ skipReceipt: true }`.
function runBuildCli(cloneRepoDir, args, extraOpts, options) {
  if (!(options && options.skipReceipt)) {
    writeReceiptForHead(cloneRepoDir);
  }
  return spawnSync(process.execPath, [path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'), ...args], {
    encoding: 'utf8',
    ...(extraOpts || {}),
  });
}

// ---------------------------------------------------------------------------
// Test 1 (AC1): a planted scan finding aborts non-zero, with no clone-dir
// created and no push to the mirror.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t1-clone-');
  const bareMirror = initBareMirror('mavp-build-t1-mirror-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t1-parent-'), 'clone-dir-target');
  fs.rmSync(cloneDirTarget, { recursive: true, force: true }); // must not exist yet

  // Built via concatenation, not a contiguous literal, so this exact string
  // does not appear anywhere else in THIS file's own text — this test file
  // is itself ship-classified and lands in the assembled tree the clone
  // scans, so a reused literal would self-match regardless of whether the
  // README plant below ever happened, making the test pass for the wrong
  // reason. Concatenating keeps the README plant the ONLY source of the
  // finding this test asserts on.
  const PRIVATE_NAME = 'zzzT513' + 'Planted' + 'PrivateNameNotReal';
  fs.appendFileSync(
    path.join(cloneRepoDir, 'README.md'),
    `\n${PRIVATE_NAME} planted for T-513 regression coverage\n`
  );
  git(cloneRepoDir, ['add', '-A']);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: plant a private-name finding in README.md']);

  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PRIVATE_NAME},zzzT513FixtureSecondName`,
  ]);

  assert.notStrictEqual(result.status, 0, `Test 1 FAIL: expected non-zero exit on a planted scan finding, got ${result.status}:\n${result.stderr}`);
  assert.ok(
    /secret scan reported findings/.test(result.stderr),
    `Test 1 FAIL: expected the scan-gate ABORT message, got: ${result.stderr}`
  );
  assert.ok(/no push has occurred/.test(result.stderr), `Test 1 FAIL: expected the standard abort footer, got: ${result.stderr}`);
  // mavp-publish-scan.js prints its findings via console.error (stderr), not stdout.
  assert.ok(/Private repo name/.test(result.stderr), `Test 1 FAIL: expected the scanner to report the planted finding, got stderr: ${result.stderr}`);
  assert.ok(/README\.md/.test(result.stderr), `Test 1 FAIL: expected the reported finding to point at README.md (the planted location), got stderr: ${result.stderr}`);

  assert.strictEqual(
    fs.existsSync(cloneDirTarget),
    false,
    'Test 1 FAIL: clone-dir must never be created when the scan gate aborts before step 3'
  );

  const mirrorRefs = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(mirrorRefs, '', 'Test 1 FAIL: mirror bare repo must have zero refs (nothing was ever pushed)');

  console.log('Test 1 passed: a planted scan finding aborts non-zero, clone-dir is never created, mirror has zero refs (nothing pushed)');
}

// ---------------------------------------------------------------------------
// Test 2 (AC2, negative cases): all six degenerate --private-names forms
// exit non-zero AT THE FLAG GATE. Run directly against the real, in-place
// script — this is safe regardless of this worktree's dirty/clean state
// because the mandatory-flag gate in main() runs BEFORE
// assertCleanSourceRepo() ever touches this repo.
// ---------------------------------------------------------------------------
{
  const degenerateForms = [
    { label: 'omitted', args: [] },
    { label: 'comma', args: ['--private-names', ','] },
    { label: 'comma-space-comma', args: ['--private-names', ', ,'] },
    { label: 'double-comma', args: ['--private-names', ',,'] },
    { label: 'whitespace-only', args: ['--private-names', '   '] },
    { label: 'empty', args: ['--private-names', ''] },
  ];

  for (const { label, args } of degenerateForms) {
    const result = spawnSync(
      process.execPath,
      [BUILD_SCRIPT, 'dummy-remote-never-used', 'dummy-clone-dir-never-used', ...args],
      { encoding: 'utf8' }
    );
    assert.notStrictEqual(
      result.status,
      0,
      `Test 2 FAIL (${label}): expected non-zero exit at the --private-names flag gate, got ${result.status}:\n${result.stderr}`
    );
    assert.ok(
      /--private-names is mandatory/.test(result.stderr),
      `Test 2 FAIL (${label}): expected the mandatory-flag gate message, got: ${result.stderr}`
    );
  }
  console.log('Test 2 passed: all six degenerate --private-names forms (omitted, comma, comma-space-comma, double-comma, whitespace-only, empty) exit non-zero at the flag gate');
}

// ---------------------------------------------------------------------------
// Test 3 (AC2, positive case): a legitimate two-name value PASSES the flag
// gate. Proven two ways:
//   (a) unit-level: parsePrivateNamesList() parses it to a 2-element array
//       (the exact thing main()'s gate checks the length of).
//   (b) end-to-end: run a fresh, clean, self-contained clone with the
//       legitimate value and a deliberately bogus local mirror path — the
//       run proceeds past the flag gate (no "mandatory" message) and instead
//       fails later, at the mirror-clone step, proving real pass-through.
// ---------------------------------------------------------------------------
{
  const { parsePrivateNamesList } = require('./mavp-publish-build.js');
  const parsed = parsePrivateNamesList('alpha-name,beta-name');
  assert.strictEqual(parsed.length, 2, `Test 3a FAIL: expected a legitimate two-name value to parse to 2 entries, got ${JSON.stringify(parsed)}`);
  assert.deepStrictEqual(parsed, ['alpha-name', 'beta-name'], 'Test 3a FAIL: unexpected parsed values');
  console.log('Test 3a passed: parsePrivateNamesList() parses a legitimate two-name value to a 2-element array');

  const cloneRepoDir = cloneRepoFixture('mavp-build-t3-clone-');
  const bogusMirror = path.join(mkTempDir('mavp-build-t3-bogus-'), 'does-not-exist-mirror');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t3-parent-'), 'clone-dir-target');

  // This test's assembled tree includes THIS test file itself (it is
  // ship-classified and the clone is made from HEAD, which already contains
  // this file) — Test 3b needs the scan to come back CLEAN so the run
  // proceeds past step 2. Building the names via concatenation (rather than
  // a contiguous literal) means no literal detectable substring appears in
  // this file's own text, so the scanner cannot self-trip on its own fixture
  // value — the same discipline .claude/rules/scripts.md requires for
  // adversarial fixtures.
  const passthroughNameA = 'zzzT513' + 'PassesTheGate' + 'NeverMatchesAnything';
  const passthroughNameB = passthroughNameA + 'Either';

  const result = runBuildCli(cloneRepoDir, [
    bogusMirror,
    cloneDirTarget,
    '--private-names',
    `${passthroughNameA},${passthroughNameB}`,
  ]);

  assert.notStrictEqual(result.status, 0, `Test 3b FAIL: expected the bogus-mirror run to still fail (just not at the flag gate), got ${result.status}`);
  assert.ok(
    !/--private-names is mandatory/.test(result.stderr),
    `Test 3b FAIL: legitimate value must NOT trip the mandatory-flag gate, got: ${result.stderr}`
  );
  assert.ok(
    /clone failed/.test(result.stderr),
    `Test 3b FAIL: expected the run to fail at the mirror-clone step (proving it passed assemble+scan+the flag gate), got: ${result.stderr}`
  );
  assert.strictEqual(fs.existsSync(cloneDirTarget), false, 'Test 3b FAIL: clone-dir must not exist after a failed clone');

  console.log('Test 3b passed: a legitimate two-name value passes the flag gate end-to-end (clean clone runs all the way to a real clone-step failure, not the mandatory-flag gate)');
}

// ---------------------------------------------------------------------------
// Test 4 (AC3): the size floor fires when the ship set is largely
// reclassified to exclude (the exact scenario documented in the file header
// of mavp-publish-build.js: an operator moving most of publish-manifest.json's
// `ship` array into `exclude`). Proven two ways:
//   (a) end-to-end: a fresh clone with its OWN manifest edited to keep only a
//       handful of ship entries — the real assemble+size-floor pipeline
//       fires, before the scan step, before any mirror is touched.
//   (b) unit-level: assertAssembledTreeNonTrivial() called directly (in a
//       subprocess, since it process.exit()s) against a synthetic tiny
//       outDir, using the REAL REPO_ROOT's live git-tracked count (computed
//       fresh here, never hardcoded) as the floor's denominator.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t4-clone-');
  const bareMirror = initBareMirror('mavp-build-t4-mirror-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t4-parent-'), 'clone-dir-target');

  const manifestPath = path.join(cloneRepoDir, 'scripts', 'publish-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const KEEP_SHIP_COUNT = 5;
  assert.ok(manifest.ship.length > KEEP_SHIP_COUNT, 'Test 4 FAIL: fixture assumption broken — manifest has too few ship entries to reclassify');
  const keep = manifest.ship.slice(0, KEEP_SHIP_COUNT);
  const moved = manifest.ship.slice(KEEP_SHIP_COUNT);
  for (const p of moved) {
    manifest.exclude[p] = 'fixture: reclassified for T-513 size-floor regression test';
  }
  manifest.ship = keep;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  git(cloneRepoDir, ['add', '-A']);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: reclassify most ship entries to exclude']);

  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', 'zzzT513NeverMatchesAnything']);

  assert.notStrictEqual(result.status, 0, `Test 4a FAIL: expected non-zero exit when the ship set is largely reclassified to exclude, got ${result.status}`);
  assert.ok(
    /below the .*-file floor/.test(result.stderr),
    `Test 4a FAIL: expected the size-floor ABORT message, got: ${result.stderr}`
  );
  assert.ok(/no push has occurred/.test(result.stderr), 'Test 4a FAIL: expected the standard abort footer');
  assert.strictEqual(fs.existsSync(cloneDirTarget), false, 'Test 4a FAIL: clone-dir must never be created when the size floor aborts before step 3');
  const mirrorRefs = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(mirrorRefs, '', 'Test 4a FAIL: mirror bare repo must have zero refs (nothing was ever pushed)');

  console.log('Test 4a passed: reclassifying most of the ship set to exclude fires the size floor before the scan step, before any mirror is touched');

  // (b) direct unit-level call against the real (uncloned) REPO_ROOT,
  // computing the tracked-file denominator fresh rather than hardcoding it.
  const trackedCount = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean).length;
  const floor = Math.ceil(trackedCount * 0.5);
  assert.ok(floor > 1, 'Test 4b FAIL: fixture assumption broken — computed floor is not usefully greater than 1');

  const tinyOutDir = mkTempDir('mavp-build-t4-tiny-outdir-');
  writeFile(path.join(tinyOutDir, 'only-file.txt'), 'one lonely file\n');

  const belowFloorResult = spawnSync(process.execPath, [
    '-e',
    `require(${JSON.stringify(BUILD_SCRIPT)}).assertAssembledTreeNonTrivial(${JSON.stringify(tinyOutDir)});`,
  ], { encoding: 'utf8' });
  assert.notStrictEqual(belowFloorResult.status, 0, `Test 4b FAIL: expected assertAssembledTreeNonTrivial() to abort on a 1-file tree (floor ${floor}), got ${belowFloorResult.status}`);
  assert.ok(
    /below the .*-file floor/.test(belowFloorResult.stderr),
    `Test 4b FAIL: expected the size-floor ABORT message from the direct call, got: ${belowFloorResult.stderr}`
  );

  console.log(`Test 4b passed: assertAssembledTreeNonTrivial() called directly aborts a 1-file tree against the real ${trackedCount}-tracked-file floor (${floor})`);
}

// ---------------------------------------------------------------------------
// Test 5: assertAssembledTreeNonTrivial() called directly — the completely
// empty tree case, and the passing case (a tree at/above the real floor).
// ---------------------------------------------------------------------------
{
  const emptyOutDir = mkTempDir('mavp-build-t5-empty-outdir-');
  const emptyResult = spawnSync(process.execPath, [
    '-e',
    `require(${JSON.stringify(BUILD_SCRIPT)}).assertAssembledTreeNonTrivial(${JSON.stringify(emptyOutDir)});`,
  ], { encoding: 'utf8' });
  assert.notStrictEqual(emptyResult.status, 0, `Test 5a FAIL: expected a completely empty tree to abort, got ${emptyResult.status}`);
  assert.ok(/completely empty/.test(emptyResult.stderr), `Test 5a FAIL: expected the empty-tree ABORT message, got: ${emptyResult.stderr}`);
  console.log('Test 5a passed: assertAssembledTreeNonTrivial() aborts a completely empty assembled tree');

  const trackedCount = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean).length;
  const floor = Math.ceil(trackedCount * 0.5);
  const passingOutDir = mkTempDir('mavp-build-t5-passing-outdir-');
  for (let i = 0; i < floor + 10; i++) {
    writeFile(path.join(passingOutDir, `file-${i}.txt`), `content ${i}\n`);
  }
  const passingResult = spawnSync(process.execPath, [
    '-e',
    `require(${JSON.stringify(BUILD_SCRIPT)}).assertAssembledTreeNonTrivial(${JSON.stringify(passingOutDir)}); console.log('DID-NOT-ABORT');`,
  ], { encoding: 'utf8' });
  assert.strictEqual(passingResult.status, 0, `Test 5b FAIL: expected a tree above the floor (${floor}) to pass, got ${passingResult.status}:\n${passingResult.stderr}`);
  assert.ok(passingResult.stdout.includes('DID-NOT-ABORT'), 'Test 5b FAIL: expected the call to return control (not abort) on a tree above the floor');
  console.log(`Test 5b passed: assertAssembledTreeNonTrivial() proceeds (does not abort) on a ${floor + 10}-file tree, above the real ${floor}-file floor`);
}

// ---------------------------------------------------------------------------
// Test 6: countFilesRecursive() and parseArgs() unit-level checks —
// independent of git fixtures entirely.
// ---------------------------------------------------------------------------
{
  const { countFilesRecursive, parseArgs } = require('./mavp-publish-build.js');

  const dir = mkTempDir('mavp-build-t6-countfiles-');
  writeFile(path.join(dir, 'a.txt'), 'a\n');
  writeFile(path.join(dir, 'nested', 'b.txt'), 'b\n');
  writeFile(path.join(dir, 'nested', 'deeper', 'c.txt'), 'c\n');
  fs.mkdirSync(path.join(dir, 'empty-subdir'));
  assert.strictEqual(countFilesRecursive(dir), 3, 'Test 6a FAIL: expected countFilesRecursive to count 3 files across nested dirs, ignoring empty directories');

  const emptyDir = mkTempDir('mavp-build-t6-countfiles-empty-');
  assert.strictEqual(countFilesRecursive(emptyDir), 0, 'Test 6a FAIL: expected countFilesRecursive to return 0 for an empty directory');
  console.log('Test 6a passed: countFilesRecursive() counts nested files correctly and returns 0 for an empty tree');

  const parsedDefaults = parseArgs(['remote-a', 'clone-b']);
  assert.strictEqual(parsedDefaults.mirrorRemote, 'remote-a', 'Test 6b FAIL: unexpected mirrorRemote');
  assert.strictEqual(parsedDefaults.cloneDir, 'clone-b', 'Test 6b FAIL: unexpected cloneDir');
  assert.strictEqual(parsedDefaults.privateNames, null, 'Test 6b FAIL: privateNames should default to null');
  assert.strictEqual(parsedDefaults.dryRun, false, 'Test 6b FAIL: dryRun should default to false');
  assert.strictEqual(parsedDefaults.summary, null, 'Test 6b FAIL: summary should default to null');
  assert.strictEqual(parsedDefaults.authorName, null, 'Test 6b FAIL: authorName should default to null');
  assert.strictEqual(parsedDefaults.authorEmail, null, 'Test 6b FAIL: authorEmail should default to null');

  const parsedFull = parseArgs([
    'remote-a',
    'clone-b',
    '--private-names',
    'x,y',
    '--dry-run',
    '--summary',
    'a summary',
    '--author-name',
    'A Name',
    '--author-email',
    'a@example.com',
  ]);
  assert.strictEqual(parsedFull.privateNames, 'x,y', 'Test 6b FAIL: unexpected privateNames (space form)');
  assert.strictEqual(parsedFull.dryRun, true, 'Test 6b FAIL: expected --dry-run to parse true');
  assert.strictEqual(parsedFull.summary, 'a summary', 'Test 6b FAIL: unexpected summary (space form)');
  assert.strictEqual(parsedFull.authorName, 'A Name', 'Test 6b FAIL: unexpected authorName (space form)');
  assert.strictEqual(parsedFull.authorEmail, 'a@example.com', 'Test 6b FAIL: unexpected authorEmail (space form)');

  const parsedEquals = parseArgs([
    'remote-a',
    'clone-b',
    '--private-names=x,y',
    '--summary=a summary',
    '--author-name=A Name',
    '--author-email=a@example.com',
  ]);
  assert.strictEqual(parsedEquals.privateNames, 'x,y', 'Test 6b FAIL: unexpected privateNames (= form)');
  assert.strictEqual(parsedEquals.summary, 'a summary', 'Test 6b FAIL: unexpected summary (= form)');
  assert.strictEqual(parsedEquals.authorName, 'A Name', 'Test 6b FAIL: unexpected authorName (= form)');
  assert.strictEqual(parsedEquals.authorEmail, 'a@example.com', 'Test 6b FAIL: unexpected authorEmail (= form)');

  console.log('Test 6b passed: parseArgs() parses positional args, flags (space and "=" forms), and applies documented defaults');
}

console.log('\nAll T-513 assertions passed.');

// ---------------------------------------------------------------------------
// T-514 — Test 7: a scan-gate abort against a main-only mirror (no `edge`
// ref at all) must still push nothing. Explicitly verified against the exact
// fixture shape (main-only mirror) T-514's reproduction uses, rather than
// assuming Test 1 above already covers this for the new push condition.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t514-abort-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t514-abort-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t514-abort-parent-'), 'clone-dir-target');

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    /refs\/heads\/main/.test(refsBefore) && !/refs\/heads\/edge/.test(refsBefore),
    `Test 7 FAIL: fixture assumption broken — expected a main-only mirror before any run, got: ${refsBefore}`
  );

  const PLANTED = 'zzzT514' + 'AbortPlantedName' + 'NeverReal';
  fs.appendFileSync(
    path.join(cloneRepoDir, 'README.md'),
    `\n${PLANTED} planted for T-514 abort regression coverage\n`
  );
  git(cloneRepoDir, ['add', '-A']);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: plant a private-name finding for T-514 abort test']);

  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},zzzT514AbortSecondName`,
  ]);

  assert.notStrictEqual(result.status, 0, `Test 7 FAIL: expected non-zero exit on a planted scan finding, got ${result.status}:\n${result.stderr}`);
  assert.ok(/secret scan reported findings/.test(result.stderr), `Test 7 FAIL: expected the scan-gate ABORT message, got: ${result.stderr}`);
  assert.strictEqual(fs.existsSync(cloneDirTarget), false, 'Test 7 FAIL: clone-dir must never be created when the scan gate aborts before step 3');

  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfter,
    refsBefore,
    'Test 7 FAIL: a scan-gate abort must leave a main-only mirror completely unchanged — no edge ref, nothing pushed'
  );

  console.log('Test 7 passed: a scan-gate abort against a main-only mirror pushes nothing — refs unchanged (main only, no edge ref created)');
}

// ---------------------------------------------------------------------------
// T-514 — Test 8: THE REPORTED DEFECT, REPRODUCED END TO END.
//   1. --dry-run against a main-only mirror (no `edge` ref): commits locally
//      on `edge`, push intentionally skipped.
//   2. A second, REAL run against the SAME clone dir with UNCHANGED source:
//      finds nothing new to commit, but must still push the ahead commit
//      the dry-run already made.
// Before the fix, step 2 printed "Nothing was committed this run — nothing
// to push." -> "Done." and the mirror held no `edge` ref, forever. Assertions
// below check the MIRROR'S OWN refs (ground truth), not just stdout text.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t514-repro-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t514-repro-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t514-repro-parent-'), 'clone-dir-target');

  const nameA = 'zzzT514' + 'ReproPushAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  const refsBeforeAnyRun = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    /refs\/heads\/main/.test(refsBeforeAnyRun) && !/refs\/heads\/edge/.test(refsBeforeAnyRun),
    `Test 8 FAIL: fixture assumption broken — expected a main-only mirror before any run, got: ${refsBeforeAnyRun}`
  );

  // --- Run 1: --dry-run ---
  const dryRunResult = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${nameA},${nameB}`,
    '--dry-run',
  ]);
  assert.strictEqual(dryRunResult.status, 0, `Test 8 FAIL (dry-run): expected exit 0, got ${dryRunResult.status}:\n${dryRunResult.stderr}`);
  const shaMatch = dryRunResult.stdout.match(/Committed ([0-9a-f]{7,40})/);
  assert.ok(shaMatch, `Test 8 FAIL (dry-run): expected a "Committed <sha>" line in stdout, got: ${dryRunResult.stdout}`);
  const committedSha = shaMatch[1];
  assert.ok(
    /WARNING/.test(dryRunResult.stderr) && /unpushed work/.test(dryRunResult.stderr),
    `Test 8 FAIL (dry-run): expected a loud WARNING that edge has unpushed work, got stderr: ${dryRunResult.stderr}`
  );
  assert.ok(
    !/\nDone\.\s*$/.test(dryRunResult.stdout),
    `Test 8 FAIL (dry-run): expected NOT a bare "Done." when ahead-of-remote work stays unpushed, got stdout tail: ${dryRunResult.stdout.slice(-200)}`
  );

  const refsAfterDryRun = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfterDryRun,
    refsBeforeAnyRun,
    'Test 8 FAIL (dry-run): --dry-run must never push — mirror refs must stay unchanged (main only)'
  );

  // --- Run 2: real run, SAME clone dir, UNCHANGED source ---
  const realRunResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(realRunResult.status, 0, `Test 8 FAIL (real run): expected exit 0, got ${realRunResult.status}:\n${realRunResult.stderr}`);
  assert.ok(
    /No changes staged after overlay/.test(realRunResult.stdout),
    `Test 8 FAIL (real run): expected nothing new to commit on unchanged source, got stdout: ${realRunResult.stdout}`
  );
  assert.ok(
    !/WARNING/.test(realRunResult.stderr),
    `Test 8 FAIL (real run): expected no WARNING once the ahead commit is actually pushed, got stderr: ${realRunResult.stderr}`
  );
  assert.ok(
    /\nDone\.\s*$/.test(realRunResult.stdout),
    `Test 8 FAIL (real run): expected a plain "Done." once the push succeeds, got stdout tail: ${realRunResult.stdout.slice(-200)}`
  );

  const refsAfterRealRun = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    /refs\/heads\/edge/.test(refsAfterRealRun),
    `Test 8 FAIL: THE DEFECT — mirror still has no 'edge' ref after the real run:\n${refsAfterRealRun}`
  );
  assert.ok(
    refsAfterRealRun.includes(`${committedSha} refs/heads/edge`),
    `Test 8 FAIL: mirror's edge ref does not point at the dry-run's own committed sha (${committedSha}) — got:\n${refsAfterRealRun}`
  );

  console.log(
    'Test 8 passed: THE REPORTED DEFECT REPRODUCTION — a --dry-run commit stranded on local edge is ' +
      'pushed by the very next real run against unchanged source; before the fix the mirror held no ' +
      "edge ref at all.\n" +
      `  Mirror refs BEFORE any run:\n${refsBeforeAnyRun.split('\n').map((l) => `    ${l}`).join('\n')}\n` +
      `  Mirror refs AFTER dry-run:\n${(refsAfterDryRun || '    (empty)').split('\n').map((l) => `    ${l}`).join('\n')}\n` +
      `  Mirror refs AFTER real run:\n${refsAfterRealRun.split('\n').map((l) => `    ${l}`).join('\n')}`
  );
}

// ---------------------------------------------------------------------------
// T-514 — Test 9: a local `edge` commit of UNKNOWN PROVENANCE (constructed
// without ever going through mavp-publish-build.js's own commit step, so it
// carries no scan-provenance trailer) must never be pushed, even though it
// is "ahead of origin". Simulates an operator hand-committing directly into
// the mirror clone, bypassing the orchestrator entirely.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t514-unknown-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t514-unknown-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t514-unknown-parent-'), 'clone-dir-target');

  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['checkout', '-q', '-b', 'edge', 'origin/main']);
  git(cloneDirTarget, ['config', 'user.email', 'hand-committer@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Hand Committer']);

  // Build the same content the real assemble+overlay steps would produce,
  // but commit it directly with a plain message — no PUSH_PROVENANCE_TRAILER
  // — exactly what would happen if an operator ran the assemble/overlay
  // scripts by hand (or edited the clone directly) instead of going through
  // mavp-publish-build.js.
  const handAssembleDir = mkTempDir('mavp-build-t514-unknown-assemble-');
  execFileSync(process.execPath, [path.join(cloneRepoDir, 'scripts', 'mavp-publish-assemble.js'), handAssembleDir]);
  execFileSync(process.execPath, [
    path.join(cloneRepoDir, 'scripts', 'mavp-publish-overlay.js'),
    handAssembleDir,
    cloneDirTarget,
  ]);
  git(cloneDirTarget, ['add', '-A']);
  git(cloneDirTarget, ['commit', '-q', '-m', 'hand commit: bypassing the orchestrator, no scan-provenance trailer']);

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    !/refs\/heads\/edge/.test(refsBefore),
    `Test 9 FAIL: fixture assumption broken — mirror must not have an edge ref yet, got: ${refsBefore}`
  );

  const nameA = 'zzzT514' + 'UnknownProvenanceAlpha' + 'NeverMatches';
  const nameB = nameA + 'Beta';
  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);

  // F2 (security review, round 1): a provenance refusal is the SCRIPT
  // unilaterally withholding the requested push (not the caller's own
  // --dry-run instruction), so it must exit non-zero — unlike --dry-run,
  // which stays exit 0 (Test 8 above covers that case and is unchanged).
  assert.strictEqual(
    result.status,
    1,
    `Test 9 FAIL: expected exit 1 (a refused push is the script's own veto, not the caller's --dry-run ` +
      `instruction), got ${result.status}:\n${result.stderr}`
  );
  assert.ok(/WARNING/.test(result.stderr), `Test 9 FAIL: expected a loud WARNING, got stderr: ${result.stderr}`);
  assert.ok(
    /scan-provenance marker/.test(result.stderr),
    `Test 9 FAIL: expected the warning to name the missing scan-provenance marker, got stderr: ${result.stderr}`
  );
  assert.ok(
    !/\nDone\.\s*$/.test(result.stdout),
    `Test 9 FAIL: expected NOT a bare "Done." when a provenance-unverifiable commit is left unpushed, got stdout tail: ${result.stdout.slice(-200)}`
  );

  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfter,
    refsBefore,
    'Test 9 FAIL: a commit lacking scan provenance must never be pushed — mirror refs must stay unchanged'
  );
  assert.ok(
    !/refs\/heads\/edge/.test(refsAfter),
    'Test 9 FAIL: no edge ref should ever appear on the mirror when provenance is unverifiable'
  );

  console.log(
    'Test 9 passed: a local edge commit of unknown provenance (hand-committed, no scan-provenance ' +
      'trailer) is never pushed — loud WARNING instead of a bare Done, mirror refs unchanged'
  );
}

// ---------------------------------------------------------------------------
// T-514 — Test 10: F1 (security review, round 1) — a bare substring trailer
// certifies a MESSAGE, not a TREE. `git commit --amend --no-edit` preserves
// the trailer text while swapping in arbitrary new content. Reproduces the
// reviewer's exact scenario: amend a file under the manifest's SOLE
// `preserve` entry (`.github/ISSUE_TEMPLATE/` — never in the assembled tree,
// never scanned, and the overlay is contractually forbidden from ever
// touching it), which is both the accident shape (a maintainer editing
// mirror-only content directly in the clone) and the attack shape. Before
// the tree-binding fix this published silently (exit 0, bare Done, zero
// warnings); after it, the stamped tree sha no longer matches the amended
// commit's own %T, so the push is refused.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t514-amend-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t514-amend-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t514-amend-parent-'), 'clone-dir-target');

  const nameA = 'zzzT514' + 'AmendGuardAlpha' + 'NeverMatches';
  const nameB = nameA + 'Beta';

  // Run 1: --dry-run strands a trailered (now tree-bound) commit on local edge.
  const dryRunResult = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${nameA},${nameB}`,
    '--dry-run',
  ]);
  assert.strictEqual(dryRunResult.status, 0, `Test 10 FAIL (dry-run): expected exit 0, got ${dryRunResult.status}:\n${dryRunResult.stderr}`);

  const refsBeforeAmend = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    !/refs\/heads\/edge/.test(refsBeforeAmend),
    `Test 10 FAIL: fixture assumption broken — mirror must not have an edge ref yet, got: ${refsBeforeAmend}`
  );

  // F1 reproduction: amend the TREE while keeping the MESSAGE (and so the
  // trailer text) intact via --amend --no-edit.
  writeFile(
    path.join(cloneDirTarget, '.github', 'ISSUE_TEMPLATE', 'amended-after-scan.md'),
    'content that never passed any scan\n'
  );
  git(cloneDirTarget, ['add', '-A']);
  git(cloneDirTarget, ['commit', '-q', '--amend', '--no-edit']);

  // Fixture sanity: clean working tree, trailer text still present (message
  // untouched by --no-edit) — exactly the reviewer's described shape.
  const statusAfterAmend = git(cloneDirTarget, ['status', '--porcelain']);
  assert.strictEqual(
    statusAfterAmend.trim(),
    '',
    'Test 10 FAIL: fixture assumption broken — working tree must be clean after the amend'
  );
  const amendedMessage = git(cloneDirTarget, ['log', '-1', '--format=%B']);
  assert.ok(
    /X-Mavp-Publish-Build: scanned-and-committed-by-this-script/.test(amendedMessage),
    'Test 10 FAIL: fixture assumption broken — the amend must preserve the trailer text (--no-edit)'
  );

  // Run 2: real run, UNCHANGED canonical source.
  const realRunResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);

  assert.strictEqual(
    realRunResult.status,
    1,
    `Test 10 FAIL: expected exit 1 (F1 tree-mismatch refusal + F2 non-zero exit), got ${realRunResult.status}:\n${realRunResult.stdout}\n${realRunResult.stderr}`
  );
  assert.ok(/WARNING/.test(realRunResult.stderr), `Test 10 FAIL: expected a loud WARNING, got stderr: ${realRunResult.stderr}`);
  assert.ok(
    /carry this script's scan-provenance marker/.test(realRunResult.stderr),
    `Test 10 FAIL: expected the provenance-refusal message, got stderr: ${realRunResult.stderr}`
  );
  assert.ok(
    !/\nDone\.\s*$/.test(realRunResult.stdout),
    `Test 10 FAIL: expected NOT a bare "Done." — got stdout tail: ${realRunResult.stdout.slice(-200)}`
  );

  const refsAfterRealRun = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfterRealRun,
    refsBeforeAmend,
    "Test 10 FAIL: THE F1 VULNERABILITY — an amended-tree commit was pushed despite the (message-only) trailer surviving the amend"
  );
  assert.ok(
    !/refs\/heads\/edge/.test(refsAfterRealRun),
    "Test 10 FAIL: no edge ref should ever appear on the mirror when a trailered commit's tree was changed after the fact"
  );

  console.log(
    'Test 10 passed: F1 — a trailered commit whose TREE was changed via `git commit --amend --no-edit` ' +
      '(message/trailer text intact) is refused — tree-sha mismatch caught, mirror refs unchanged'
  );
}

// ---------------------------------------------------------------------------
// T-520 — Test 11: the edge push must not carry local tags to the mirror
// (push.followTags). The old `git push -u origin edge` honors
// push.followTags, so a fixture clone with that config set to true AND a
// reachable ANNOTATED tag (the only kind followTags ever follows — a
// lightweight or unreachable tag would make this assertion vacuous)
// delivered the tag to the mirror alongside 'edge'. Part A runs the real,
// fixed script end to end; Part B is the load-bearing proof that the SAME
// fixture shape, pushed with the pre-fix command directly, actually carries
// the tag; Part C is the mirror-mode safety probe named in this task's
// brief.
// ---------------------------------------------------------------------------

// --- Part A: the fixed script, end to end. ---
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t520-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t520-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t520-parent-'), 'clone-dir-target');

  const nameA = 'zzzT520' + 'FollowTagsAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  // Run 1: --dry-run bootstraps 'edge' from the mirror's 'main' tip and
  // commits a trailered (provenance-marked) commit locally, without pushing
  // — the same two-run shape Test 8 uses to get a real trailered commit onto
  // local 'edge' before exercising a second, real run.
  const dryRunResult = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${nameA},${nameB}`,
    '--dry-run',
  ]);
  assert.strictEqual(
    dryRunResult.status,
    0,
    `Test 11 FAIL (dry-run): expected exit 0, got ${dryRunResult.status}:\n${dryRunResult.stderr}`
  );

  // T-524: read EDGE_PUSH_ARGS from the CLONE's own committed copy of the
  // script (cloneRepoDir — the exact copy runBuildCli() above just executed),
  // never from the working tree — a working-tree require here would let an
  // uncommitted mutation to the working copy go unobserved, since
  // cloneRepoFixture() clones from committed HEAD, not the dirty working
  // tree. This is observation #1 of two: the static export. Observation #2
  // (below) is the logged command line from the real run, which also catches
  // a call-site drift (e.g. an inline argument added on top of the spread)
  // that a static-export-only check would miss.
  const { EDGE_PUSH_ARGS } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
  assert.deepStrictEqual(
    EDGE_PUSH_ARGS,
    EXPECTED_EDGE_PUSH_ARGS,
    `Test 11 FAIL: EDGE_PUSH_ARGS export drifted from the expected push argv, got: ${JSON.stringify(EDGE_PUSH_ARGS)}`
  );

  // Fixture condition under test: push.followTags=true in the local clone,
  // plus a local ANNOTATED tag on edge's current tip — reachable from edge's
  // history by construction, since it tags the exact commit the next real
  // run's push will carry.
  git(cloneDirTarget, ['config', 'push.followTags', 'true']);
  const ANNOTATED_TAG = 'mavp-t520-annotated-tag';
  git(cloneDirTarget, ['tag', '-a', ANNOTATED_TAG, '-m', 'T-520 fixture: annotated tag reachable from edge']);

  // Fixture sanity: the tag must be genuinely annotated (not lightweight) and
  // genuinely reachable from edge, or push.followTags would never follow it
  // regardless of the fix, making this test vacuous either way.
  const tagType = git(cloneDirTarget, ['cat-file', '-t', ANNOTATED_TAG]).trim();
  assert.strictEqual(
    tagType,
    'tag',
    `Test 11 FAIL: fixture assumption broken — tag must be annotated (git cat-file -t == 'tag'), got '${tagType}'`
  );
  const ancestorCheck = spawnSync('git', ['merge-base', '--is-ancestor', ANNOTATED_TAG, 'edge'], { cwd: cloneDirTarget });
  assert.strictEqual(
    ancestorCheck.status,
    0,
    `Test 11 FAIL: fixture assumption broken — tag must be reachable from (an ancestor of) edge, got exit ${ancestorCheck.status}`
  );

  const refsBeforePush = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    /refs\/heads\/main/.test(refsBeforePush) && !/refs\/heads\/edge/.test(refsBeforePush) && !/refs\/tags\//.test(refsBeforePush),
    `Test 11 FAIL: fixture assumption broken — expected a main-only mirror before any push, got: ${refsBeforePush}`
  );
  const mainLineBefore = refsBeforePush.split('\n').find((line) => line.endsWith('refs/heads/main'));
  const mainShaBefore = mainLineBefore.split(' ')[0];

  // Run 2: real run, UNCHANGED canonical source — nothing new to commit, but
  // the dry-run's trailered commit (which the tag now points at) is still
  // ahead of origin/main and must be pushed (T-514 push condition).
  const realRunResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    realRunResult.status,
    0,
    `Test 11 FAIL: expected exit 0 on the real publish run, got ${realRunResult.status}:\n${realRunResult.stdout}\n${realRunResult.stderr}`
  );

  // T-524, observation #2: the ACTUAL call site's argv, read from the real
  // run's own logged command line — not the static export. This is what
  // catches a call-site drift (e.g. stepPush() adding an inline argument on
  // top of the spread) that observation #1 (the static EDGE_PUSH_ARGS export
  // check above) alone cannot see, since a static export can drift from what
  // the call site actually executes. Deliberately a WHOLE-LINE match (not
  // .includes()) — an inline argument APPENDED to the real command would
  // still leave the expected argv as a leading substring of the logged line,
  // which a substring/.includes() check would miss entirely.
  const expectedPushCommandLine = `Running: git ${EDGE_PUSH_ARGS.join(' ')}`;
  const pushLogLineMatch = realRunResult.stdout.match(/^Running: git .+$/m);
  assert.ok(
    pushLogLineMatch,
    `Test 11 FAIL: no "Running: git ..." logged command line found in stdout:\n${realRunResult.stdout}`
  );
  assert.strictEqual(
    pushLogLineMatch[0],
    expectedPushCommandLine,
    `Test 11 FAIL: expected the logged push command line to equal exactly "${expectedPushCommandLine}", got: "${pushLogLineMatch[0]}"`
  );

  const refsAfterPush = gitShowRefOrEmpty(bareMirror);
  const actualRefNames = refsAfterPush
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[1])
    .sort();
  assert.deepStrictEqual(
    actualRefNames,
    ['refs/heads/edge', 'refs/heads/main'],
    'Test 11 FAIL: THE T-520 FINDING — push.followTags must not carry the annotated tag to the mirror; expected ' +
      `exactly [refs/heads/edge, refs/heads/main], got: ${actualRefNames.join(', ')}`
  );
  assert.ok(
    !/refs\/tags\//.test(refsAfterPush),
    `Test 11 FAIL: no refs/tags/* entry may ever appear on the mirror from an edge publish, got: ${refsAfterPush}`
  );

  const mainLineAfter = refsAfterPush.split('\n').find((line) => line.endsWith('refs/heads/main'));
  const mainShaAfter = mainLineAfter.split(' ')[0];
  assert.strictEqual(
    mainShaAfter,
    mainShaBefore,
    'Test 11 FAIL: refs/heads/main must be completely UNCHANGED by an edge publish — a malformed refspec could ' +
      'push edge onto main instead, publishing unreleased work as the stable branch'
  );

  console.log(
    'Test 11a (AC, real script) passed: push.followTags=true + a reachable ANNOTATED tag on edge — the pushed ' +
      `mirror ref list is exactly [refs/heads/edge, refs/heads/main], no refs/tags/*, refs/heads/main ` +
      `(${mainShaBefore}) is unchanged, the clone's own EDGE_PUSH_ARGS export matches the expected argv, and the ` +
      `real run's logged command line ("${expectedPushCommandLine}") matches it too`
  );
}

// --- Part B: load-bearing proof. The SAME fixture shape (push.followTags=
// true + a reachable annotated tag on edge), pushed with the PRE-T-520
// command directly (never through the script, which now always issues the
// fixed command), must actually carry the tag — proving Part A's fixture
// genuinely exercises the vulnerability class rather than passing vacuously.
{
  const bareMirrorB = initBareMirrorWithMain('mavp-build-t520-loadbearing-');
  const cloneDirB = mkTempDir('mavp-build-t520-loadbearing-clone-');
  fs.rmSync(cloneDirB, { recursive: true, force: true }); // must not exist yet — git clone creates it
  execFileSync('git', ['clone', '--quiet', bareMirrorB, cloneDirB]);
  git(cloneDirB, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirB, ['config', 'user.name', 'Fixture User']);
  git(cloneDirB, ['config', 'push.followTags', 'true']);
  git(cloneDirB, ['checkout', '-q', '-b', 'edge']);
  git(cloneDirB, ['commit', '-q', '--allow-empty', '-m', 'T-520 load-bearing fixture: edge commit']);
  const ANNOTATED_TAG_B = 'mavp-t520-loadbearing-annotated-tag';
  git(cloneDirB, ['tag', '-a', ANNOTATED_TAG_B, '-m', 'T-520 load-bearing fixture: annotated tag reachable from edge']);

  const refsBeforeB = gitShowRefOrEmpty(bareMirrorB);
  assert.ok(
    !/refs\/tags\//.test(refsBeforeB) && !/refs\/heads\/edge/.test(refsBeforeB),
    `Test 11b FAIL: fixture assumption broken — expected a main-only, tag-free mirror before the push, got: ${refsBeforeB}`
  );

  // THE REVERTED COMMAND — exactly what stepPush() issued before T-520.
  execFileSync('git', ['push', '-u', 'origin', 'edge'], { cwd: cloneDirB });

  const refsAfterB = gitShowRefOrEmpty(bareMirrorB);
  assert.ok(
    refsAfterB.includes(`refs/tags/${ANNOTATED_TAG_B}`),
    'Test 11b FAIL: load-bearing proof broken — expected the PRE-T-520 push command (`git push -u origin edge`) ' +
      `to carry the reachable annotated tag to the mirror when push.followTags=true, got refs: ${refsAfterB}`
  );

  console.log(
    'Test 11b (load-bearing proof) passed: the reverted command `git push -u origin edge` with ' +
      `push.followTags=true DID carry the annotated tag (refs/tags/${ANNOTATED_TAG_B}) to the mirror — confirming ` +
      "Test 11a's fixture genuinely exercises the vulnerability class the fix (--no-follow-tags) closes"
  );
}

// --- Part C: mirror-mode safety probe. A remote.origin.mirror=true clone
// must fail LOUDLY on the fixed push line (git refuses combining mirror mode
// with an explicit refspec) instead of silently force-mirroring every local
// ref to the public mirror.
{
  const bareMirrorC = initBareMirrorWithMain('mavp-build-t520-mirrorprobe-');
  const cloneDirC = mkTempDir('mavp-build-t520-mirrorprobe-clone-');
  fs.rmSync(cloneDirC, { recursive: true, force: true }); // must not exist yet — git clone creates it
  execFileSync('git', ['clone', '--quiet', bareMirrorC, cloneDirC]);
  git(cloneDirC, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirC, ['config', 'user.name', 'Fixture User']);
  git(cloneDirC, ['checkout', '-q', '-b', 'edge']);
  git(cloneDirC, ['commit', '-q', '--allow-empty', '-m', 'T-520 mirror-mode probe fixture commit']);
  git(cloneDirC, ['config', 'remote.origin.mirror', 'true']);

  // T-524: sourced from the exported EDGE_PUSH_ARGS constant (top of file)
  // instead of a hardcoded copy of the push flags.
  const probeResult = spawnSync('git', [...EDGE_PUSH_ARGS], { cwd: cloneDirC, encoding: 'utf8' });
  assert.notStrictEqual(
    probeResult.status,
    0,
    `Test 11c FAIL: expected the mirror-mode + explicit-refspec combination to fail loudly, got exit ${probeResult.status}`
  );
  assert.ok(
    /--mirror can't be combined with refspecs/.test(probeResult.stderr),
    `Test 11c FAIL: expected git's own mirror-mode refusal message, got stderr: ${probeResult.stderr}`
  );

  console.log(
    "Test 11c (mirror-mode probe) passed: a remote.origin.mirror=true clone fails loudly on the fixed push line " +
      `(git: "${probeResult.stderr.trim()}") instead of silently force-mirroring every local ref to the public mirror`
  );
}

console.log('\nAll T-514/T-520 assertions passed.');

// ---------------------------------------------------------------------------
// T-523 — Test 12: THE COMMIT-MESSAGE CHANNEL, both input paths, same source
// fixture.
//
// One source repo whose HEAD SUBJECT carries a planted private name (planted
// via an --allow-empty commit, so the assembled TREE is byte-identical to a
// clean clone and the step-2 tree scan stays GREEN — otherwise this test
// would abort at the tree gate and prove nothing about the message channel).
//
//   (a) no --summary  -> the default summary IS that HEAD subject -> the
//       message-scan gate aborts non-zero BEFORE committing: the mirror gets
//       neither a commit nor a push, and local `edge` in the clone dir has
//       zero commits ahead of the tip it was bootstrapped from.
//   (b) a clean explicit --summary, SAME source HEAD, fresh mirror/clone-dir
//       -> publishes, and the mirror's own commit message carries that
//       summary plus a valid (tree-bound) provenance trailer, with the
//       planted name absent.
//
// (b) needs its own clone dir because ANY post-overlay abort — this gate
// included — leaves the previous clone dir with the overlay's writes in it,
// which stepCloneOrPull() then refuses to reuse (a pre-existing property of
// the script, not something this gate introduces).
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523-subject-clone-');

  // Runtime-constructed (never a contiguous literal in this ship-classified
  // file) for the reason spelled out at Test 1: this file lands in the
  // assembled tree the fixture scans, so a literal would make the TREE scan
  // trip on this test file and the run would abort at step 2 — passing for
  // entirely the wrong reason instead of exercising the message channel.
  //
  // BOTH names are runtime-constructed, not just the planted one: EVERY value
  // handed to --private-names becomes an active detection pattern the run's
  // own tree scan applies to this very file, so a contiguous literal for the
  // *second* name self-matches here and aborts the run at step 2 — which
  // would silently turn this test into "the tree gate fired" instead of "the
  // message gate fired". Observed, not theorized: this exact slip made the
  // first version of this test fail once the file was committed (the fixture
  // clones committed HEAD, so an uncommitted file cannot reproduce it).
  const PLANTED = 'zzzT523' + 'SubjectPlanted' + 'PrivateNameNotReal';
  const SECOND_NAME = PLANTED + 'Second';

  // --allow-empty: the plant lives ONLY in the commit subject (git metadata),
  // never in a tracked file, so the assembled tree is unchanged and clean.
  git(cloneRepoDir, ['commit', '-q', '--allow-empty', '-m', `${PLANTED} planted in the HEAD subject for T-523`]);
  const headSubject = git(cloneRepoDir, ['log', '-1', '--pretty=%s']).trim();
  assert.ok(
    headSubject.includes(PLANTED),
    `Test 12 FAIL: fixture assumption broken — HEAD subject must carry the planted name, got: ${headSubject}`
  );
  const trackedContainingPlant = spawnSync('git', ['grep', '-l', PLANTED, 'HEAD'], {
    cwd: cloneRepoDir,
    encoding: 'utf8',
  });
  assert.strictEqual(
    (trackedContainingPlant.stdout || '').trim(),
    '',
    'Test 12 FAIL: fixture assumption broken — the planted name must appear in NO tracked file (only in the ' +
      `commit subject), else the step-2 tree scan aborts first and this test proves nothing. Got: ${trackedContainingPlant.stdout}`
  );

  // --- (a) defaulted summary (the planted HEAD subject), no --summary ---
  const bareMirrorA = initBareMirrorWithMain('mavp-build-t523-default-');
  const cloneDirA = path.join(mkTempDir('mavp-build-t523-default-parent-'), 'clone-dir-target');

  const refsBeforeA = gitShowRefOrEmpty(bareMirrorA);
  assert.ok(
    /refs\/heads\/main/.test(refsBeforeA) && !/refs\/heads\/edge/.test(refsBeforeA),
    `Test 12a FAIL: fixture assumption broken — expected a main-only mirror before the run, got: ${refsBeforeA}`
  );

  const defaultRun = runBuildCli(cloneRepoDir, [bareMirrorA, cloneDirA, '--private-names', `${PLANTED},${SECOND_NAME}`]);

  assert.notStrictEqual(
    defaultRun.status,
    0,
    `Test 12a FAIL: expected non-zero exit when the defaulted (HEAD-subject) summary carries a private name, got ` +
      `${defaultRun.status}:\n${defaultRun.stdout}\n${defaultRun.stderr}`
  );
  // Proof the TREE scan was NOT what fired — it must have been GREEN, and the
  // run must have proceeded all the way to the commit step.
  assert.ok(
    /Scan GREEN/.test(defaultRun.stdout),
    `Test 12a FAIL: the tree scan must be GREEN (this test is about the MESSAGE channel, not the tree), got stdout: ${defaultRun.stdout}`
  );
  assert.ok(
    !/secret scan reported findings/.test(defaultRun.stderr),
    `Test 12a FAIL: the step-2 tree gate must not be the thing that fired, got stderr: ${defaultRun.stderr}`
  );
  assert.ok(
    /finding\(s\) in the composed mirror commit message/.test(defaultRun.stderr),
    `Test 12a FAIL: expected the commit-message gate's finding header, got stderr: ${defaultRun.stderr}`
  );
  assert.ok(
    /\[Private repo name\] message line 1/.test(defaultRun.stderr),
    `Test 12a FAIL: expected the planted name reported on message line 1 (the subject), got stderr: ${defaultRun.stderr}`
  );
  assert.ok(
    /--summary/.test(defaultRun.stderr),
    `Test 12a FAIL: the abort must guide the operator to pass a clean --summary, got stderr: ${defaultRun.stderr}`
  );
  assert.ok(
    /No commit was created/.test(defaultRun.stderr) && /no push has occurred/.test(defaultRun.stderr),
    `Test 12a FAIL: expected the pre-commit/no-push abort footer, got stderr: ${defaultRun.stderr}`
  );

  // GROUND TRUTH #1 — the mirror received nothing at all.
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirrorA),
    refsBeforeA,
    'Test 12a FAIL: mirror refs must be completely unchanged — no commit, no push, no edge ref'
  );
  // GROUND TRUTH #2 — no commit exists even LOCALLY in the clone dir, so a
  // later run's T-514 ahead-range push has nothing unscanned to pick up.
  const aheadCountA = git(cloneDirA, ['rev-list', '--count', 'origin/main..edge']).trim();
  assert.strictEqual(
    aheadCountA,
    '0',
    `Test 12a FAIL: the abort must precede the commit — local 'edge' must be 0 commits ahead of the tip it was ` +
      `bootstrapped from, got ${aheadCountA} ahead`
  );

  console.log(
    'Test 12a passed: a private name in the source HEAD subject (no --summary) aborts non-zero at the ' +
      'commit-message gate with the tree scan GREEN — mirror refs unchanged, and local edge is 0 commits ahead ' +
      '(the abort provably precedes the commit)'
  );

  // --- (b) same source fixture, clean explicit --summary -> publishes ---
  const bareMirrorB = initBareMirrorWithMain('mavp-build-t523-summary-');
  const cloneDirB = path.join(mkTempDir('mavp-build-t523-summary-parent-'), 'clone-dir-target');
  const CLEAN_SUMMARY = 'T-523 working build with a deliberately clean summary line';

  const summaryRun = runBuildCli(cloneRepoDir, [
    bareMirrorB,
    cloneDirB,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    CLEAN_SUMMARY,
  ]);

  assert.strictEqual(
    summaryRun.status,
    0,
    `Test 12b FAIL: expected exit 0 with a clean explicit --summary, got ${summaryRun.status}:\n${summaryRun.stdout}\n${summaryRun.stderr}`
  );
  assert.ok(
    /Commit-message scan GREEN/.test(summaryRun.stdout),
    `Test 12b FAIL: expected the commit-message gate to report GREEN, got stdout: ${summaryRun.stdout}`
  );
  assert.ok(
    /\nDone\.\s*$/.test(summaryRun.stdout),
    `Test 12b FAIL: expected a plain "Done." on a successful publish, got stdout tail: ${summaryRun.stdout.slice(-300)}`
  );

  // GROUND TRUTH — read the message from the MIRROR itself, not from stdout.
  const mirrorRefsB = gitShowRefOrEmpty(bareMirrorB);
  assert.ok(/refs\/heads\/edge/.test(mirrorRefsB), `Test 12b FAIL: mirror must have an edge ref after publishing, got: ${mirrorRefsB}`);
  const mirrorMessage = execFileSync('git', ['--git-dir', bareMirrorB, 'log', '-1', '--format=%B', 'edge'], {
    encoding: 'utf8',
  });
  assert.ok(
    mirrorMessage.includes(`Sync from canonical: ${CLEAN_SUMMARY}`),
    `Test 12b FAIL: the mirror's commit message must carry the explicit summary, got: ${JSON.stringify(mirrorMessage)}`
  );
  assert.ok(
    !mirrorMessage.includes(PLANTED),
    `Test 12b FAIL: the planted HEAD-subject name must be absent from the published message, got: ${JSON.stringify(mirrorMessage)}`
  );

  // The trailer must be present AND still valid (its stamped tree equal to the
  // published commit's own %T) — a published message that carries the summary
  // but a broken trailer would fail the very provenance check T-514 added.
  const { parseProvenanceTreeSha } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
  const stampedTree = parseProvenanceTreeSha(mirrorMessage);
  assert.ok(
    stampedTree,
    `Test 12b FAIL: the published message must carry a well-formed provenance trailer, got: ${JSON.stringify(mirrorMessage)}`
  );
  const publishedTree = execFileSync('git', ['--git-dir', bareMirrorB, 'log', '-1', '--format=%T', 'edge'], {
    encoding: 'utf8',
  }).trim();
  assert.strictEqual(
    stampedTree,
    publishedTree,
    "Test 12b FAIL: the published trailer's stamped tree must equal the published commit's own tree (%T)"
  );

  console.log(
    'Test 12b passed: the SAME planted-HEAD-subject fixture publishes cleanly with an explicit --summary — the ' +
      "mirror's own commit message carries that summary, omits the planted name, and carries a valid " +
      `tree-bound provenance trailer (tree=${publishedTree})`
  );
}

// ---------------------------------------------------------------------------
// T-523 — Test 13: the channel is closed regardless of INPUT SOURCE. A clean
// source HEAD subject plus an explicit --summary carrying the private name
// must abort exactly like the defaulted path did. Without this, a fix that
// only sanitized the default (e.g. dropping the HEAD-subject default
// altogether) would look complete while the operator-supplied half of the
// channel stayed wide open.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523-explicit-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523-explicit-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523-explicit-parent-'), 'clone-dir-target');

  // Runtime-constructed, both of them — see Test 12's comment on why the
  // second name matters as much as the planted one.
  const PLANTED = 'zzzT523' + 'ExplicitSummaryPlanted' + 'NameNotReal';
  const SECOND_NAME = PLANTED + 'Second';

  // Fixture contrast with Test 12: HEAD's own subject is CLEAN here, so the
  // only possible source of the finding is the --summary argument.
  const headSubject = git(cloneRepoDir, ['log', '-1', '--pretty=%s']).trim();
  assert.ok(
    !headSubject.includes(PLANTED),
    `Test 13 FAIL: fixture assumption broken — HEAD subject must be clean here, got: ${headSubject}`
  );

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    `working build touching ${PLANTED} internals`,
  ]);

  assert.notStrictEqual(
    result.status,
    0,
    `Test 13 FAIL: expected non-zero exit when an explicit --summary carries a private name, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Scan GREEN/.test(result.stdout) && !/secret scan reported findings/.test(result.stderr),
    `Test 13 FAIL: the tree scan must be GREEN — this is the message channel, got stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    /finding\(s\) in the composed mirror commit message/.test(result.stderr),
    `Test 13 FAIL: expected the commit-message gate's finding header, got stderr: ${result.stderr}`
  );
  assert.ok(
    /\[Private repo name\] message line 1/.test(result.stderr),
    `Test 13 FAIL: expected the planted name reported on message line 1, got stderr: ${result.stderr}`
  );
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    refsBefore,
    'Test 13 FAIL: mirror refs must be completely unchanged — no commit, no push'
  );
  const aheadCount = git(cloneDirTarget, ['rev-list', '--count', 'origin/main..edge']).trim();
  assert.strictEqual(
    aheadCount,
    '0',
    `Test 13 FAIL: the abort must precede the commit — expected local 'edge' 0 commits ahead, got ${aheadCount}`
  );

  console.log(
    'Test 13 passed: an explicit --summary carrying the private name aborts too (clean HEAD subject, so the ' +
      '--summary argument is the only possible source) — the channel is closed regardless of input source, ' +
      'mirror refs unchanged, local edge 0 commits ahead'
  );
}

// ---------------------------------------------------------------------------
// T-523 — Test 14: unit-level pins on the message gate itself.
//   (a) CLEAN RUN: a realistically-shaped full message — subject + blank line
//       + the REAL provenance trailer built by buildProvenanceTrailerLine()
//       — produces ZERO findings. This is the pin that the T-514 trailer
//       (fixed marker + a 40-hex tree sha) never trips a category; without
//       it, a future category addition could make every publish run abort on
//       its own derived trailer.
//   (b) WHOLE-MESSAGE COVERAGE: a detectable value placed on the TRAILER line
//       (message line 3), with a clean subject, is still found. This pins
//       that the gate scans the full message rather than only the subject —
//       a subject-only implementation passes (a) and Test 12/13 but fails
//       here.
//   (c) The private-name category really is built from the run's OWN list:
//       the same message scanned with an unrelated names list is clean.
// ---------------------------------------------------------------------------
{
  const {
    scanCommitMessageForFindings,
    buildProvenanceTrailerLine,
    COMMIT_MESSAGE_SCAN_LABEL,
  } = require('./mavp-publish-build.js');

  // Runtime-constructed like every other fixture name in this file. These
  // never reach a CLI (this block is purely in-process), but the discipline is
  // uniform on purpose: a later edit that DID pass one of them to
  // --private-names must not have to notice the difference.
  const FIXTURE_NAME = 'zzzT523' + 'UnitLevelName' + 'NotReal';
  const SECOND_FIXTURE_NAME = FIXTURE_NAME + 'Second';
  const UNRELATED_FIXTURE_NAME = 'zzzT523' + 'Unrelated' + 'NameAbsentFromTheMessage';
  const fixtureTreeSha = 'abc123'.repeat(6) + 'abcd'; // 40 hex chars, synthetic
  assert.strictEqual(fixtureTreeSha.length, 40, 'Test 14 FAIL: fixture assumption broken — synthetic tree sha must be 40 chars');

  const trailer = buildProvenanceTrailerLine(fixtureTreeSha);
  const cleanMessage = `Sync from canonical: T-523 ordinary working build subject (a1b2c3d)\n\n${trailer}`;
  const cleanFindings = scanCommitMessageForFindings(cleanMessage, [FIXTURE_NAME, SECOND_FIXTURE_NAME]);
  assert.deepStrictEqual(
    cleanFindings,
    [],
    `Test 14a FAIL: a clean message including the real provenance trailer must produce ZERO findings, got: ${JSON.stringify(cleanFindings)}`
  );
  // Guard against the pin becoming vacuous: the trailer really is part of what
  // was scanned (3 lines), not an empty string that trivially cannot match.
  assert.strictEqual(cleanMessage.split('\n').length, 3, 'Test 14a FAIL: fixture assumption broken — expected a 3-line message');
  assert.ok(/tree=[0-9a-f]{40}/.test(trailer), 'Test 14a FAIL: fixture assumption broken — trailer must embed a 40-hex tree sha');
  console.log(
    `Test 14a passed: the full composed message including the real T-514 provenance trailer ("${trailer}") ` +
      'scans to ZERO findings — the trailer never trips a category'
  );

  const trailerLineMessage = `Sync from canonical: an entirely clean subject line\n\n${trailer} ${FIXTURE_NAME}`;
  const trailerLineFindings = scanCommitMessageForFindings(trailerLineMessage, [FIXTURE_NAME]);
  assert.strictEqual(
    trailerLineFindings.length,
    1,
    `Test 14b FAIL: expected exactly 1 finding for a detectable value on the trailer line, got: ${JSON.stringify(trailerLineFindings)}`
  );
  assert.strictEqual(
    trailerLineFindings[0].line,
    3,
    `Test 14b FAIL: expected the finding on message line 3 (the trailer line) — a subject-only scan would find nothing, got line ${trailerLineFindings[0].line}`
  );
  assert.strictEqual(trailerLineFindings[0].category, 'Private repo name', 'Test 14b FAIL: unexpected category');
  assert.strictEqual(
    trailerLineFindings[0].file,
    COMMIT_MESSAGE_SCAN_LABEL,
    'Test 14b FAIL: findings must be labelled as the composed commit message, not a file path'
  );
  console.log(
    'Test 14b passed: a detectable value on the TRAILER line (message line 3) with a clean subject is still ' +
      'reported — the gate scans the whole message, not just the subject'
  );

  const unrelatedFindings = scanCommitMessageForFindings(trailerLineMessage, [UNRELATED_FIXTURE_NAME]);
  assert.deepStrictEqual(
    unrelatedFindings,
    [],
    `Test 14c FAIL: the private-name category must come from the RUN'S OWN list — an unrelated list must not match, got: ${JSON.stringify(unrelatedFindings)}`
  );
  console.log(
    "Test 14c passed: the same message is clean under an unrelated --private-names list — the private-name " +
      "category is built from the run's own value, not a hardcoded list"
  );
}

console.log('\nAll T-523 (round 1) assertions passed.');

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 15 (H1): THE SECURITY REVIEWER'S OWN REPRODUCTION.
// The creation-time gate is per-commit; the push publishes an ahead RANGE.
// Because the provenance trailer binds to the commit's TREE, a MESSAGE-ONLY
// `git commit --amend` leaves the tree byte-identical, keeps the trailer
// valid, and republishes the reworded message. The second run finds nothing
// staged, so stepCommit() returns early and the creation-time gate is never
// invoked at all — before the range scan in stepPush() this pushed at exit 0
// with no warning, and the mirror's own log carried the planted name.
//
// Not an adversarial route: the script's own --dry-run flow invites the
// operator to inspect the local commits, and `git commit --amend` pre-fills
// the existing message INCLUDING the trailer.
//
// Killer for the mutation "range scan removed from stepPush()": that mutant
// pushes here, so the mirror-refs-unchanged assertion below fails.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-amendmsg-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-amendmsg-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-amendmsg-parent-'), 'clone-dir-target');

  // Runtime-constructed, both names — see Test 12's comment: every value handed
  // to --private-names becomes an active pattern applied to the assembled tree,
  // which contains THIS ship-classified file.
  const PLANTED = 'zzzT523r2' + 'AmendedMessagePlanted' + 'NameNotReal';
  const SECOND_NAME = PLANTED + 'Second';

  // --- Run 1: --dry-run with a CLEAN --summary -> the gate logs GREEN and a
  // trailered commit is left on local `edge`, unpushed (exactly what the
  // script tells the operator to go and inspect). ---
  const dryRun = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    'round-2 fixture: a deliberately clean summary line',
    '--dry-run',
  ]);
  assert.strictEqual(
    dryRun.status,
    0,
    `Test 15 FAIL (dry-run): expected exit 0, got ${dryRun.status}:\n${dryRun.stdout}\n${dryRun.stderr}`
  );
  assert.ok(
    /Commit-message scan GREEN/.test(dryRun.stdout),
    `Test 15 FAIL (dry-run): expected the message gate to log GREEN, got stdout: ${dryRun.stdout}`
  );

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    !/refs\/heads\/edge/.test(refsBefore),
    `Test 15 FAIL: fixture assumption broken — mirror must not have an edge ref yet, got: ${refsBefore}`
  );

  // --- The amend: MESSAGE ONLY. Line 1 (the subject) is reworded to name the
  // planted value; every later line — including the provenance trailer — is
  // carried over verbatim, so the trailer stays valid. ---
  const treeBeforeAmend = git(cloneDirTarget, ['show', '-s', '--format=%T', 'HEAD']).trim();
  const originalLines = git(cloneDirTarget, ['show', '-s', '--format=%B', 'HEAD']).replace(/\n+$/, '').split('\n');
  originalLines[0] = `Sync from canonical: reworded by hand while touching ${PLANTED}`;
  git(cloneDirTarget, ['commit', '-q', '--amend', '-m', originalLines.join('\n')]);

  // Fixture sanity #1: the tree really is byte-identical (a message-only
  // amend), which is precisely why the tree-bound provenance check cannot see
  // this and the range scan has to.
  const treeAfterAmend = git(cloneDirTarget, ['show', '-s', '--format=%T', 'HEAD']).trim();
  assert.strictEqual(
    treeAfterAmend,
    treeBeforeAmend,
    `Test 15 FAIL: fixture assumption broken — a message-only amend must leave the tree identical, got ` +
      `${treeBeforeAmend} -> ${treeAfterAmend}`
  );
  // Fixture sanity #2: the provenance trailer survived AND still validates
  // against the commit's own %T — so the T-514 check passes and the range scan
  // is the only thing that can catch this.
  const { parseProvenanceTreeSha } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
  const amendedMessage = git(cloneDirTarget, ['show', '-s', '--format=%B', 'HEAD']);
  assert.strictEqual(
    parseProvenanceTreeSha(amendedMessage),
    treeAfterAmend,
    'Test 15 FAIL: fixture assumption broken — the amended commit must still carry a VALID (tree-matching) ' +
      'provenance trailer, else this test would be caught by the T-514 provenance check instead'
  );
  assert.ok(
    amendedMessage.includes(PLANTED),
    'Test 15 FAIL: fixture assumption broken — the amended subject must carry the planted name'
  );
  assert.strictEqual(
    git(cloneDirTarget, ['status', '--porcelain']).trim(),
    '',
    'Test 15 FAIL: fixture assumption broken — the clone must be clean after a message-only amend'
  );

  // --- Run 2: real run, SAME clone dir, UNCHANGED source, clean --summary. ---
  const realRun = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    'round-2 fixture: a deliberately clean summary line',
  ]);

  assert.strictEqual(
    realRun.status,
    1,
    `Test 15 FAIL: expected exit 1 (the script withheld a requested push), got ${realRun.status}:\n${realRun.stdout}\n${realRun.stderr}`
  );
  // The load-bearing half of the reviewer's finding: the creation-time gate is
  // never even reached on this run, so it cannot be what refuses.
  assert.ok(
    /No changes staged after overlay/.test(realRun.stdout),
    `Test 15 FAIL: expected stepCommit() to return early on unchanged source (the creation-time gate is ` +
      `never invoked) — got stdout: ${realRun.stdout}`
  );
  assert.ok(
    !/Commit-message scan GREEN/.test(realRun.stdout),
    `Test 15 FAIL: the creation-time gate must NOT have run on this second run, got stdout: ${realRun.stdout}`
  );
  assert.ok(
    /commit message\(s\) about to be pushed/.test(realRun.stderr),
    `Test 15 FAIL: expected the range scan's finding header, got stderr: ${realRun.stderr}`
  );
  assert.ok(
    /\[Private repo name\] message line 1/.test(realRun.stderr),
    `Test 15 FAIL: expected the planted name reported on message line 1 of the amended commit, got stderr: ${realRun.stderr}`
  );
  const amendedSha = git(cloneDirTarget, ['rev-parse', 'HEAD']).trim();
  assert.ok(
    realRun.stderr.includes(amendedSha),
    `Test 15 FAIL: the refusal must name the offending commit (${amendedSha}), got stderr: ${realRun.stderr}`
  );
  assert.ok(
    !/\nDone\.\s*$/.test(realRun.stdout),
    `Test 15 FAIL: expected NOT a bare "Done." on a refused push, got stdout tail: ${realRun.stdout.slice(-200)}`
  );

  // GROUND TRUTH — the mirror, not stdout.
  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfter,
    refsBefore,
    'Test 15 FAIL: THE H1 VULNERABILITY — a message-only-amended commit was pushed, so the mirror now ' +
      "carries a message nothing ever scanned"
  );
  assert.ok(
    !/refs\/heads\/edge/.test(refsAfter),
    'Test 15 FAIL: no edge ref may appear on the mirror when a pushed message trips the scan'
  );
  const mirrorLog = spawnSync('git', ['--git-dir', bareMirror, 'log', '--all', '--format=%B'], { encoding: 'utf8' });
  assert.ok(
    !(mirrorLog.stdout || '').includes(PLANTED),
    "Test 15 FAIL: the planted name must appear nowhere in the mirror's own log"
  );

  console.log(
    'Test 15 passed (H1): a MESSAGE-ONLY `git commit --amend` (tree byte-identical, provenance trailer ' +
      'still valid) is refused by the range scan in stepPush() even though the second run never reaches ' +
      'the creation-time gate — exit 1, mirror refs unchanged, planted name absent from the mirror log'
  );
}

// ---------------------------------------------------------------------------
// T-523 round 2 — shared fixture helper for the H2 cases: a `prepare-commit-msg`
// hook that appends a line to EVERY commit message. This is the ordinary
// "append derived metadata to every commit" hook shape (husky/lefthook-style),
// and `prepare-commit-msg` runs EVEN WITH `-m` — which is why the reviewer's
// reproduction published a five-line message after a run certified three lines
// as scanned.
//
// The appended text is interpolated from a RUNTIME-CONSTRUCTED value, so no
// detectable literal appears in this ship-classified file (the same discipline
// every other fixture name here follows).
// ---------------------------------------------------------------------------
function makePrepareCommitMsgHookDir(prefix, appendedLine) {
  const hooksDir = mkTempDir(prefix);
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');
  fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(appendedLine)} >> "$1"\n`, { mode: 0o755 });
  return hooksDir;
}

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 16 (H2, half 1: the pin). A mirror clone configured
// with core.hooksPath pointing at a message-rewriting `prepare-commit-msg`
// hook must publish the message this run actually scanned — nothing more.
//
// Part A is the load-bearing proof (the reviewer's vector reproduced): the
// SAME clone, committing WITHOUT the pin, really does get the hook's extra
// line — including when core.hooksPath arrives through the higher-precedence
// GIT_CONFIG_COUNT environment form. And WITH the pin (read from the script's
// own exported buildCommitConfigPins(), not a hardcoded copy) both forms are
// inert. `--no-verify` is checked too, because it is the intuitive fix and it
// does NOT work: it skips `pre-commit`/`commit-msg`, not `prepare-commit-msg`.
//
// Part B runs the real script end to end against that clone.
//
// Killer for the mutation "core.hooksPath pin removed": that mutant lets the
// hook append the planted line, the read-back then finds it and aborts, so
// Part B's exit-0 + published-3-line-message assertions fail.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-hook-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-hook-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-hook-parent-'), 'clone-dir-target');

  const PLANTED = 'zzzT523r2' + 'HookAppendedPlanted' + 'NameNotReal';
  const SECOND_NAME = PLANTED + 'Second';
  const HOOK_LINE = `${PLANTED} appended by a message-rewriting hook`;
  const hooksDir = makePrepareCommitMsgHookDir('mavp-build-t523r2-hook-hooksdir-', HOOK_LINE);

  // The clone dir is created HERE (not by the script's first run) so the hook
  // config can be in place before the script's own commit — a test must never
  // touch the machine's global config, and a repo-local core.hooksPath is the
  // same key at strictly LOWER precedence than the global one the reviewer
  // used, so a pin that beats this also beats that.
  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);
  git(cloneDirTarget, ['config', 'core.hooksPath', hooksDir]);

  // --- Part A: the load-bearing probes, in a throwaway clone of the same
  // shape so nothing here perturbs the clone Part B publishes from. ---
  {
    const probeClone = path.join(mkTempDir('mavp-build-t523r2-hook-probe-parent-'), 'probe-clone');
    execFileSync('git', ['clone', '--quiet', bareMirror, probeClone]);
    git(probeClone, ['config', 'user.email', 'fixture@example.invalid']);
    git(probeClone, ['config', 'user.name', 'Fixture User']);
    git(probeClone, ['config', 'core.hooksPath', hooksDir]);

    // `pre` goes before the `commit` subcommand (that is the only position git
    // accepts `-c` in); `post` goes after it (where commit's own flags live).
    const commitProbe = (label, { pre = [], post = [], env } = {}) => {
      execFileSync(
        'git',
        [...pre, 'commit', '-q', '--allow-empty', ...post, '-m', `probe subject (${label})`],
        { cwd: probeClone, env: env || process.env }
      );
      return git(probeClone, ['log', '-1', '--format=%B']);
    };

    const unpinned = commitProbe('unpinned');
    assert.ok(
      unpinned.includes(PLANTED),
      `Test 16a FAIL: load-bearing proof broken — an UNPINNED commit must pick up the prepare-commit-msg ` +
        `hook's appended line (this is the reviewer's vector), got: ${JSON.stringify(unpinned)}`
    );

    const noVerify = commitProbe('no-verify', { post: ['--no-verify'] });
    assert.ok(
      noVerify.includes(PLANTED),
      `Test 16a FAIL: load-bearing proof broken — --no-verify is expected NOT to stop prepare-commit-msg ` +
        `(it skips pre-commit/commit-msg only); if it did, the chosen pin would be the wrong fix. Got: ${JSON.stringify(noVerify)}`
    );

    // The pin, sourced from the CLONE's own committed copy of the script — the
    // exact argv Part B's run will issue, never a hardcoded copy of it.
    const { buildCommitConfigPins } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
    const emptyHooksDir = mkTempDir('mavp-build-t523r2-hook-emptyhooks-');
    assert.deepStrictEqual(
      fs.readdirSync(emptyHooksDir),
      [],
      'Test 16a FAIL: fixture assumption broken — the hooks-free directory must be empty'
    );
    const pins = buildCommitConfigPins(emptyHooksDir);
    assert.ok(
      pins.includes(`core.hooksPath=${emptyHooksDir}`) &&
        pins.includes('commit.gpgSign=false') &&
        pins.includes('commit.cleanup=verbatim'),
      `Test 16a FAIL: the exported commit pins must cover core.hooksPath, commit.gpgSign and commit.cleanup, got: ${JSON.stringify(pins)}`
    );

    const pinned = commitProbe('pinned', { pre: pins });
    assert.ok(
      !pinned.includes(PLANTED),
      `Test 16a FAIL: the pinned commit invocation must leave the hook inert, got: ${JSON.stringify(pinned)}`
    );

    // And the same pin against the HIGHER-precedence environment form of the
    // very same config key — the form that beats a repo-local setting.
    const envConfigPath = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksDir,
    };
    const envUnpinned = commitProbe('env-unpinned', { env: envConfigPath });
    assert.ok(
      envUnpinned.includes(PLANTED),
      `Test 16a FAIL: load-bearing proof broken — core.hooksPath supplied through GIT_CONFIG_COUNT must ` +
        `reach the hook when unpinned, got: ${JSON.stringify(envUnpinned)}`
    );
    const envPinned = commitProbe('env-pinned', { pre: pins, env: envConfigPath });
    assert.ok(
      !envPinned.includes(PLANTED),
      `Test 16a FAIL: the pin must beat the GIT_CONFIG_COUNT environment form of core.hooksPath too, got: ${JSON.stringify(envPinned)}`
    );

    console.log(
      'Test 16a (load-bearing proof) passed: the prepare-commit-msg hook fixture DOES append its line to an ' +
        'unpinned commit — and to a --no-verify commit, and to one whose core.hooksPath came from ' +
        "GIT_CONFIG_COUNT — while the script's own exported commit pins leave it inert in both config forms"
    );
  }

  // --- Part B: the real script, end to end, against the hook-configured clone. ---
  const refsBefore = gitShowRefOrEmpty(bareMirror);
  assert.ok(
    !/refs\/heads\/edge/.test(refsBefore),
    `Test 16b FAIL: fixture assumption broken — mirror must not have an edge ref yet, got: ${refsBefore}`
  );

  const CLEAN_SUMMARY = 'round-2 fixture: entirely clean summary under a message-rewriting hook';
  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    CLEAN_SUMMARY,
  ]);

  assert.strictEqual(
    result.status,
    0,
    `Test 16b FAIL: expected exit 0 (an entirely clean run — the hook must simply never fire), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Commit-message scan GREEN \(3 line\(s\) scanned/.test(result.stdout),
    `Test 16b FAIL: expected the gate to certify 3 scanned lines, got stdout: ${result.stdout}`
  );
  // The certificate must be TRUE, not merely present: no read-back mismatch.
  assert.ok(
    !/is NOT the string this run scanned/.test(result.stderr),
    `Test 16b FAIL: the committed message must equal the scanned string — no read-back mismatch expected ` +
      `when the pin holds, got stderr: ${result.stderr}`
  );
  assert.ok(/\nDone\.\s*$/.test(result.stdout), `Test 16b FAIL: expected a plain "Done.", got stdout tail: ${result.stdout.slice(-200)}`);

  // GROUND TRUTH — read the published message from the MIRROR.
  const mirrorMessage = execFileSync('git', ['--git-dir', bareMirror, 'log', '-1', '--format=%B', 'edge'], {
    encoding: 'utf8',
  });
  const publishedLines = mirrorMessage.replace(/\n+$/, '').split('\n');
  assert.ok(
    !mirrorMessage.includes(PLANTED),
    `Test 16b FAIL: THE H2 VULNERABILITY — the hook's line reached the mirror, so the run's own ` +
      `"3 line(s) scanned" certificate was wrong about what shipped. Published: ${JSON.stringify(mirrorMessage)}`
  );
  assert.strictEqual(
    publishedLines.length,
    3,
    `Test 16b FAIL: expected the published message to be exactly the 3 lines that were scanned, got ` +
      `${publishedLines.length}: ${JSON.stringify(mirrorMessage)}`
  );
  assert.strictEqual(
    publishedLines[0],
    `Sync from canonical: ${CLEAN_SUMMARY}`,
    `Test 16b FAIL: unexpected published subject line: ${JSON.stringify(publishedLines[0])}`
  );

  console.log(
    'Test 16b passed (H2, the pin): with core.hooksPath configured at a message-rewriting ' +
      'prepare-commit-msg hook, the published mirror message is EXACTLY the 3 scanned lines — the hook ' +
      "never fires, and the run's certificate matches what actually shipped"
  );
}

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 17 (H2, half 2: the general closure). Pinning config
// only covers the vectors we managed to enumerate. This case rewrites the
// message through a mechanism NO `git -c` pin can reach: a `git` WRAPPER
// earlier on PATH, which appends a line to the `-m` value and delegates
// everything else to the real git untouched. (Verified against this git: the
// core.hooksPath pin beats both the repo-local and the GIT_CONFIG_COUNT env
// form of that key — see Test 16a — so a config-level vector cannot be used
// here; the closure has to be proven against something outside config.)
//
// The read-back comparison catches it by EFFECT rather than by name: the
// message the commit object records is not the string that was scanned, the
// recorded text is re-scanned, it trips, the commit is undone with
// `git reset --soft HEAD~1`, and the run aborts having transmitted nothing.
//
// Killer for the mutation "read-back comparison removed": that mutant leaves
// the rewritten commit on local `edge` (where the range scan then refuses to
// push it — exit 1 and mirror-unchanged still hold), so the assertion that
// local `edge` is 0 commits ahead is what fails.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-shim-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-shim-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-shim-parent-'), 'clone-dir-target');

  const PLANTED = 'zzzT523r2' + 'WrapperAppendedPlanted' + 'NameNotReal';
  const SECOND_NAME = PLANTED + 'Second';
  const APPENDED_LINE = `${PLANTED} appended by a git wrapper on PATH`;

  // The wrapper: a Node script literally named `git`, shebanged at THIS node
  // binary, placed first on PATH. It rewrites only the `-m` value of a
  // `commit` invocation and execs the real git for everything else, so the
  // rest of the run (clone, fetch, add, log, rev-list, push) behaves normally
  // — including the read-back `git log`, which reports the truth.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  assert.ok(realGit && path.isAbsolute(realGit), `Test 17 FAIL: could not resolve the real git binary, got: ${JSON.stringify(realGit)}`);
  const shimDir = mkTempDir('mavp-build-t523r2-shim-bin-');
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const { spawnSync } = require('node:child_process');\n" +
      `const REAL_GIT = ${JSON.stringify(realGit)};\n` +
      `const APPENDED = ${JSON.stringify(APPENDED_LINE)};\n` +
      'const args = process.argv.slice(2);\n' +
      "const commitIndex = args.indexOf('commit');\n" +
      'if (commitIndex !== -1) {\n' +
      "  const messageIndex = args.indexOf('-m', commitIndex);\n" +
      "  if (messageIndex !== -1 && typeof args[messageIndex + 1] === 'string') {\n" +
      "    args[messageIndex + 1] = args[messageIndex + 1] + '\\n' + APPENDED;\n" +
      '  }\n' +
      '}\n' +
      "const result = spawnSync(REAL_GIT, args, { stdio: 'inherit' });\n" +
      'process.exit(result.status === null ? 1 : result.status);\n',
    { mode: 0o755 }
  );
  const shimEnv = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };

  // Load-bearing proof that the wrapper genuinely rewrites messages (and that
  // it is transparent for everything else) — otherwise this whole case could
  // pass vacuously.
  {
    const probeRepo = mkTempDir('mavp-build-t523r2-shim-probe-');
    execFileSync('git', ['init', '-q', probeRepo]);
    git(probeRepo, ['config', 'user.email', 'fixture@example.invalid']);
    git(probeRepo, ['config', 'user.name', 'Fixture User']);
    const probeResult = spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'probe subject'], {
      cwd: probeRepo,
      env: shimEnv,
      encoding: 'utf8',
    });
    assert.strictEqual(probeResult.status, 0, `Test 17 FAIL (wrapper probe): expected the wrapper to commit successfully, got ${probeResult.status}:\n${probeResult.stderr}`);
    const probeMessage = git(probeRepo, ['log', '-1', '--format=%B']);
    assert.ok(
      probeMessage.includes(PLANTED),
      `Test 17 FAIL (wrapper probe): load-bearing proof broken — the PATH wrapper must actually rewrite the ` +
        `committed message, got: ${JSON.stringify(probeMessage)}`
    );
  }

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  const result = runBuildCli(
    cloneRepoDir,
    [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${PLANTED},${SECOND_NAME}`,
      '--summary',
      'round-2 fixture: clean summary, rewritten behind the gate by a PATH wrapper',
    ],
    { env: shimEnv }
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Test 17 FAIL: expected a non-zero exit when the committed message is not the scanned string, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  // The creation-time gate certified the string it composed — and was right
  // about that string. The read-back is what notices the commit object holds
  // something else.
  assert.ok(
    /Commit-message scan GREEN/.test(result.stdout),
    `Test 17 FAIL: expected the creation-time gate to pass on the composed string, got stdout: ${result.stdout}`
  );
  assert.ok(
    /finding\(s\) in the message the commit ACTUALLY recorded/.test(result.stderr),
    `Test 17 FAIL: expected the read-back mismatch report, got stderr: ${result.stderr}`
  );
  assert.ok(
    /\[Private repo name\] message line 4/.test(result.stderr),
    `Test 17 FAIL: expected the appended line reported as message line 4 of the RECORDED message, got stderr: ${result.stderr}`
  );
  assert.ok(
    /reset --soft HEAD~1/.test(result.stderr) && /nothing was pushed/.test(result.stderr),
    `Test 17 FAIL: expected the abort to state the commit was undone and nothing pushed, got stderr: ${result.stderr}`
  );

  // GROUND TRUTH #1 — the mirror received nothing.
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    refsBefore,
    'Test 17 FAIL: mirror refs must be completely unchanged when the recorded message trips the scan'
  );
  // GROUND TRUTH #2 — and the offending commit is not even left locally, so no
  // later run's ahead-range push has anything unscanned to pick up.
  const aheadCount = git(cloneDirTarget, ['rev-list', '--count', 'origin/main..edge']).trim();
  assert.strictEqual(
    aheadCount,
    '0',
    `Test 17 FAIL: the rewritten commit must be undone (git reset --soft HEAD~1) — expected local 'edge' 0 ` +
      `commits ahead, got ${aheadCount}`
  );
  // And the reset must be --soft: the overlay's content is still staged, not discarded.
  const stagedAfter = git(cloneDirTarget, ['diff', '--cached', '--name-only']).trim();
  assert.ok(
    stagedAfter.length > 0,
    'Test 17 FAIL: the undo must be `reset --soft` (history only) — the overlay\'s staged content must survive'
  );

  console.log(
    'Test 17 passed (H2, the general closure): a `git` wrapper on PATH — a rewriting mechanism no `git -c` ' +
      'pin can reach — appended a line behind the gate; the read-back compared the RECORDED message against ' +
      'the scanned string, re-scanned the recorded text, reported it on message line 4, undid the commit ' +
      '(local edge 0 commits ahead, overlay content still staged) and aborted with the mirror untouched'
  );
}

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 18 (the MEDIUM finding): a CLI-LEVEL case whose planted
// value sits on a NON-SUBJECT line. Test 14b pins whole-message coverage for
// the pure helper only, so a subject-only narrowing placed at the CALL SITE
// (assertCommitMessageScanClean passing just the first line to the pure
// function) survived the entire suite: 14b calls the helper directly, and no
// CLI-level case ever planted a detectable value off the subject line.
//
// A two-line --summary does it: line 1 of the composed message is clean, line 2
// carries the planted name.
//
// Killer for the mutation "subject-only narrowing at the call site": that mutant
// lets the commit happen (the range scan in stepPush() then refuses the push, so
// the exit code and the mirror stay as asserted), which breaks BOTH the
// composed-message finding header assertion and the local-edge-0-ahead
// assertion below.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-secondline-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-secondline-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-secondline-parent-'), 'clone-dir-target');

  const PLANTED = 'zzzT523r2' + 'SecondLinePlanted' + 'NameNotReal';
  const SECOND_NAME = PLANTED + 'Second';

  // Fixture contrast: HEAD's own subject is clean, and the FIRST line of the
  // summary is clean too — the only detectable value is on line 2.
  const headSubject = git(cloneRepoDir, ['log', '-1', '--pretty=%s']).trim();
  assert.ok(
    !headSubject.includes(PLANTED),
    `Test 18 FAIL: fixture assumption broken — HEAD subject must be clean here, got: ${headSubject}`
  );

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${PLANTED},${SECOND_NAME}`,
    '--summary',
    `an entirely clean first line\n${PLANTED} on the second line`,
  ]);

  assert.notStrictEqual(
    result.status,
    0,
    `Test 18 FAIL: expected non-zero exit when message line 2 carries a private name, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Scan GREEN/.test(result.stdout) && !/secret scan reported findings/.test(result.stderr),
    `Test 18 FAIL: the tree scan must be GREEN — this is the message channel, got stdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    /finding\(s\) in the composed mirror commit message/.test(result.stderr),
    `Test 18 FAIL: expected the CREATION-TIME gate's finding header (a call-site subject-only narrowing would ` +
      `instead be caught later, by the range scan), got stderr: ${result.stderr}`
  );
  assert.ok(
    /\[Private repo name\] message line 2/.test(result.stderr),
    `Test 18 FAIL: expected the planted name reported on message line 2, got stderr: ${result.stderr}`
  );
  // The second LOW finding: the abort used to prescribe a corrective re-run that
  // immediately fails, because the overlay has already dirtied the clone and the
  // next run refuses to reuse a dirty clone. The remedy must say so — the shape
  // that trains an operator to reach for a hard reset inside the publish clone
  // is exactly what this wording avoids.
  assert.ok(
    /DIRTY/.test(result.stderr) && /fresh path/.test(result.stderr),
    `Test 18 FAIL: the abort must warn that the clone now holds the overlay's writes and must be cleaned (or ` +
      `a fresh clone dir used) before the corrective re-run, got stderr: ${result.stderr}`
  );
  // Ground truth for that claim: the clone really is dirty at this point.
  assert.ok(
    git(cloneDirTarget, ['status', '--porcelain']).trim().length > 0,
    'Test 18 FAIL: fixture assumption broken — the clone must actually be dirty after a post-overlay abort, ' +
      'else the new abort wording would be describing something untrue'
  );

  // GROUND TRUTH — mirror untouched, and no commit exists even locally.
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    refsBefore,
    'Test 18 FAIL: mirror refs must be completely unchanged — no commit, no push'
  );
  const aheadCount = git(cloneDirTarget, ['rev-list', '--count', 'origin/main..edge']).trim();
  assert.strictEqual(
    aheadCount,
    '0',
    `Test 18 FAIL: the abort must precede the commit — expected local 'edge' 0 commits ahead, got ${aheadCount}`
  );

  console.log(
    'Test 18 passed (MEDIUM): a two-line --summary whose SECOND line carries the planted name aborts at the ' +
      'creation-time gate naming message line 2 — mirror refs unchanged, local edge 0 commits ahead (which ' +
      'is what a call-site subject-only narrowing cannot satisfy)'
  );
}

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 19 (the LOW identity finding): `-c user.name` /
// `-c user.email` LOSE to the GIT_AUTHOR_* / GIT_COMMITTER_* environment
// variables, so the neutral-public-identity guarantee in
// docs/PUBLIC_RELEASE_STRATEGY.md §2 step 5 silently failed wherever those are
// exported. The commit spawn now passes an explicit env that overrides the four
// NAME/EMAIL variables and deletes the two DATE ones.
//
// Part A is the load-bearing proof that env really does beat `-c` in this git.
// Part B runs the real script with all six variables exported and reads the
// published identity back from the mirror.
//
// Killer for the mutation "env scrub removed": the mirror then records the
// exported identity (and the exported date), failing Part B's assertions.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-identity-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-identity-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-identity-parent-'), 'clone-dir-target');

  // Deliberately detectable-but-harmless fixture identity: a reserved
  // (RFC 2606 / RFC 6761) example domain, so this ship-classified file stays
  // scan-clean, and a name/date no real commit would carry.
  const ENV_NAME = 'Zzz Env Identity Must Not Ship';
  const ENV_EMAIL = 'zzz-env-identity@example.invalid';
  const ENV_DATE = '2001-02-03T04:05:06+00:00';
  const PUBLIC_NAME = 'Zzz Public Publisher';
  const PUBLIC_EMAIL = 'zzz-public-publisher@example.invalid';
  // Runtime-constructed like every other --private-names value in this file:
  // this test needs a CLEAN tree scan (the run must publish), and a contiguous
  // literal here becomes an active pattern matched against the assembled tree,
  // which contains this very ship-classified file. Observed, not theorized —
  // the first version of this case used literals, passed while the file was
  // uncommitted, and aborted at the step-2 TREE gate as soon as it was
  // committed (fixture clones take committed HEAD).
  const IDENTITY_NAME_A = 'zzzT523r2' + 'IdentityNever' + 'MatchesAnything';
  const IDENTITY_NAME_B = IDENTITY_NAME_A + 'Either';

  const identityEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: ENV_NAME,
    GIT_AUTHOR_EMAIL: ENV_EMAIL,
    GIT_AUTHOR_DATE: ENV_DATE,
    GIT_COMMITTER_NAME: ENV_NAME,
    GIT_COMMITTER_EMAIL: ENV_EMAIL,
    GIT_COMMITTER_DATE: ENV_DATE,
  };

  // --- Part A: load-bearing proof — with the env exported, `-c user.name` /
  // `-c user.email` are overruled, and the exported dates are recorded too. ---
  {
    const probeRepo = mkTempDir('mavp-build-t523r2-identity-probe-');
    execFileSync('git', ['init', '-q', probeRepo]);
    execFileSync(
      'git',
      ['-c', `user.name=${PUBLIC_NAME}`, '-c', `user.email=${PUBLIC_EMAIL}`, 'commit', '-q', '--allow-empty', '-m', 'identity probe'],
      { cwd: probeRepo, env: identityEnv }
    );
    const probeIdentity = git(probeRepo, ['log', '-1', '--format=%an|%ae|%cn|%ce|%ad']);
    assert.ok(
      probeIdentity.includes(ENV_NAME) && probeIdentity.includes(ENV_EMAIL),
      `Test 19a FAIL: load-bearing proof broken — GIT_AUTHOR_*/GIT_COMMITTER_* are expected to BEAT ` +
        `-c user.name/-c user.email; if they did not, the env scrub would be pinning nothing. Got: ${probeIdentity}`
    );
    assert.ok(
      /2001/.test(probeIdentity),
      `Test 19a FAIL: load-bearing proof broken — GIT_AUTHOR_DATE is expected to be recorded when inherited, got: ${probeIdentity}`
    );
    console.log(
      'Test 19a (load-bearing proof) passed: with the six identity variables exported, `-c user.name` / ' +
        '`-c user.email` are overruled and the exported date is recorded — so an unscrubbed environment really ' +
        'does defeat the neutral-public-identity pins'
    );
  }

  // --- Part B: the real script, same exported environment. ---
  const result = runBuildCli(
    cloneRepoDir,
    [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${IDENTITY_NAME_A},${IDENTITY_NAME_B}`,
      '--summary',
      'round-2 fixture: identity pinning under an exported GIT_AUTHOR_*/GIT_COMMITTER_* environment',
      '--author-name',
      PUBLIC_NAME,
      '--author-email',
      PUBLIC_EMAIL,
    ],
    { env: identityEnv }
  );

  assert.strictEqual(
    result.status,
    0,
    `Test 19b FAIL: expected exit 0 on a clean publish, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );

  // GROUND TRUTH — read the recorded identity from the MIRROR.
  const published = execFileSync(
    'git',
    ['--git-dir', bareMirror, 'log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%ad%n%cd', 'edge'],
    { encoding: 'utf8' }
  );
  const [authorName, authorEmail, committerName, committerEmail, authorDate, committerDate] = published
    .replace(/\n+$/, '')
    .split('\n');

  assert.strictEqual(authorName, PUBLIC_NAME, `Test 19b FAIL: published author name must be the resolved public identity, got: ${authorName}`);
  assert.strictEqual(authorEmail, PUBLIC_EMAIL, `Test 19b FAIL: published author email must be the resolved public identity, got: ${authorEmail}`);
  assert.strictEqual(committerName, PUBLIC_NAME, `Test 19b FAIL: published committer name must be the resolved public identity, got: ${committerName}`);
  assert.strictEqual(committerEmail, PUBLIC_EMAIL, `Test 19b FAIL: published committer email must be the resolved public identity, got: ${committerEmail}`);
  assert.ok(
    !published.includes(ENV_NAME) && !published.includes(ENV_EMAIL),
    `Test 19b FAIL: THE IDENTITY FINDING — the exported environment identity reached the public commit object: ${published}`
  );
  assert.ok(
    !/2001/.test(authorDate) && !/2001/.test(committerDate),
    `Test 19b FAIL: the exported GIT_AUTHOR_DATE/GIT_COMMITTER_DATE must be deleted, not honored, got: ` +
      `${authorDate} / ${committerDate}`
  );

  // The scrub list itself is what the script exports — asserted against the
  // clone's own committed copy, not a hardcoded duplicate.
  const { SCRUBBED_COMMIT_ENV_VARS, buildCommitEnv } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
  assert.deepStrictEqual(
    SCRUBBED_COMMIT_ENV_VARS.slice().sort(),
    ['GIT_AUTHOR_DATE', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_DATE', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME'],
    `Test 19b FAIL: all six identity variables must be in the scrub list, got: ${JSON.stringify(SCRUBBED_COMMIT_ENV_VARS)}`
  );
  const scrubbed = buildCommitEnv({ name: PUBLIC_NAME, email: PUBLIC_EMAIL }, identityEnv);
  assert.strictEqual(scrubbed.GIT_AUTHOR_DATE, undefined, 'Test 19b FAIL: buildCommitEnv() must delete GIT_AUTHOR_DATE');
  assert.strictEqual(scrubbed.GIT_COMMITTER_DATE, undefined, 'Test 19b FAIL: buildCommitEnv() must delete GIT_COMMITTER_DATE');
  assert.strictEqual(scrubbed.GIT_AUTHOR_NAME, PUBLIC_NAME, 'Test 19b FAIL: buildCommitEnv() must override GIT_AUTHOR_NAME');
  assert.strictEqual(scrubbed.GIT_COMMITTER_EMAIL, PUBLIC_EMAIL, 'Test 19b FAIL: buildCommitEnv() must override GIT_COMMITTER_EMAIL');
  assert.strictEqual(scrubbed.PATH, identityEnv.PATH, 'Test 19b FAIL: buildCommitEnv() must leave the rest of the environment intact');

  console.log(
    `Test 19b passed (LOW, identity): with all six GIT_AUTHOR_*/GIT_COMMITTER_* variables exported, the ` +
      `published commit records ${authorName} <${authorEmail}> as both author and committer, the exported ` +
      `identity appears nowhere in the commit object, and the exported 2001 date is absent (recorded: ${authorDate})`
  );
}

// ---------------------------------------------------------------------------
// T-523 round 2 — Test 20: the third commit pin, `commit.cleanup=verbatim`.
// git's default cleanup for `-m` (whitespace) rewrites the message it is
// given: trailing whitespace is stripped. That is a benign rewrite in itself,
// but it means the string the gate scanned is not the string the commit
// records, which is exactly the class the read-back check reports. Pinning
// verbatim keeps composition and artifact identical, so the read-back
// comparison stays a signal about REWRITING rather than about git's own
// normalization.
//
// Killer for the mutation "commit.cleanup=verbatim pin removed": the trailing
// whitespace is then stripped, the published subject stops matching the
// composed one, and the read-back reports a mismatch — both asserted below.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t523r2-cleanup-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t523r2-cleanup-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t523r2-cleanup-parent-'), 'clone-dir-target');

  // Trailing whitespace is what git's default cleanup strips — built by
  // concatenation so an editor or a whitespace linter cannot silently make this
  // fixture vacuous by trimming the file.
  const SUMMARY_WITH_TRAILING_SPACE = 'round-2 fixture: summary with trailing whitespace' + '   ';
  // Runtime-constructed for the same reason as everywhere else in this file —
  // this run must publish, so the tree scan has to stay clean.
  const CLEANUP_NAME_A = 'zzzT523r2' + 'CleanupNever' + 'MatchesAnything';
  const CLEANUP_NAME_B = CLEANUP_NAME_A + 'Either';

  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${CLEANUP_NAME_A},${CLEANUP_NAME_B}`,
    '--summary',
    SUMMARY_WITH_TRAILING_SPACE,
  ]);

  assert.strictEqual(
    result.status,
    0,
    `Test 20 FAIL: expected exit 0 on a clean publish, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    !/is NOT the string this run scanned/.test(result.stderr),
    `Test 20 FAIL: with commit.cleanup=verbatim pinned, the recorded message must equal the scanned string — ` +
      `no read-back mismatch expected, got stderr: ${result.stderr}`
  );

  // GROUND TRUTH — the published subject, byte for byte, from the mirror.
  const mirrorMessage = execFileSync('git', ['--git-dir', bareMirror, 'log', '-1', '--format=%B', 'edge'], {
    encoding: 'utf8',
  });
  const publishedSubject = mirrorMessage.split('\n')[0];
  assert.strictEqual(
    publishedSubject,
    `Sync from canonical: ${SUMMARY_WITH_TRAILING_SPACE}`,
    `Test 20 FAIL: the published subject must be the composed one verbatim (trailing whitespace included), got: ${JSON.stringify(publishedSubject)}`
  );

  console.log(
    'Test 20 passed (H2, the cleanup pin): a summary with trailing whitespace is published verbatim and ' +
      'produces no read-back mismatch — git\'s default cleanup would have rewritten it, making the scanned ' +
      'string differ from the recorded one'
  );
}

console.log('\nAll T-523 (round 2) assertions passed.');

// ---------------------------------------------------------------------------
// T-536 — Test 21: buildOverlayOverrideArgs() unit-level, mutants 1+2+4.
//
// Mutant 1 (parse-but-drop): the `--max-move-credit-ratio` push inside
// buildOverlayOverrideArgs() is deleted. Mutant 2 (wrong-flag mapping): the
// value is pushed under `--allow-mass-delete` (or another ratio flag)
// instead of `--max-move-credit-ratio`. ONE deepStrictEqual on the full
// returned argv array kills both — a partial/substring check would let
// mutant 2 survive (the array would still CONTAIN `--max-move-credit-ratio`
// somewhere plus the wrong extra flag, and a substring/`.includes()` check
// would not notice `--allow-mass-delete` appearing alongside it).
// Mutant 4 (unset-leak): asserted here at the forwarder level too — an
// unset call must return an empty array, not `['--max-move-credit-ratio',
// 'undefined']` or similar.
// ---------------------------------------------------------------------------
{
  const { buildOverlayOverrideArgs } = require('./mavp-publish-build.js');

  const setArgs = buildOverlayOverrideArgs({
    allowMassDelete: false,
    maxDeleteRatio: null,
    maxDirDeleteRatio: null,
    maxMoveCreditRatio: '0.42',
  });
  assert.deepStrictEqual(
    setArgs,
    ['--max-move-credit-ratio', '0.42'],
    `Test 21a FAIL (mutants 1+2): expected exactly ['--max-move-credit-ratio', '0.42'] and nothing else ` +
      `(no --allow-mass-delete, no other ratio flag), got ${JSON.stringify(setArgs)}`
  );
  console.log(
    'Test 21a passed (mutants 1 parse-but-drop, 2 wrong-flag-mapping): buildOverlayOverrideArgs() forwards ' +
      `exactly ['--max-move-credit-ratio', '0.42'] and nothing else when only that flag is set`
  );

  const unsetArgs = buildOverlayOverrideArgs({
    allowMassDelete: false,
    maxDeleteRatio: null,
    maxDirDeleteRatio: null,
    maxMoveCreditRatio: null,
  });
  assert.deepStrictEqual(
    unsetArgs,
    [],
    `Test 21b FAIL (mutant 4, unset-leak): expected an empty array when --max-move-credit-ratio is unset, ` +
      `got ${JSON.stringify(unsetArgs)}`
  );
  assert.ok(
    !unsetArgs.includes('--max-move-credit-ratio'),
    'Test 21b FAIL (mutant 4): unset call must not forward the flag token'
  );
  assert.ok(
    !unsetArgs.some((a) => a === undefined || a === null || a === 'undefined' || a === 'null'),
    'Test 21b FAIL (mutant 4): unset call must not leak undefined/null tokens'
  );
  console.log(
    'Test 21b passed (mutant 4, unset-leak): buildOverlayOverrideArgs() forwards nothing (empty array, no ' +
      'undefined/null tokens) when --max-move-credit-ratio is unset'
  );
}

// ---------------------------------------------------------------------------
// T-536 — Test 22: a REAL, full pipeline run through main() itself, not a
// unit-level call to buildOverlayOverrideArgs()/parseArgs() in isolation.
// This is the T-524 lesson (see this file's Test 11a and the file header):
// a parse-correct, forwarder-correct change can still drop the key where
// main() builds the `overlayOverrides` object handed to stepOverlay(), and
// no unit test of those two functions alone can see that gap.
// stepOverlay() logs the exact overlay command line BEFORE invoking it
// (`=== Step 5/7: overlay (...) ===`), so asserting on that logged line —
// the script's OWN argv, exactly as it is about to run — is the observation
// seam. Never assert against a re-derivation of what the line "should" say.
//
// Mutant 3 (call-site drop): --max-move-credit-ratio is supplied on the CLI
// but main() fails to thread it into the overlayOverrides object passed to
// stepOverlay() — the logged Step 5/7 line would then be missing the flag
// even though parseArgs() and buildOverlayOverrideArgs() are both correct.
// Mutant 4 (unset-leak), asserted again here at the real-run level: a run
// WITHOUT the flag must log no `--max-move-credit-ratio` token and no
// undefined/null leakage in that same Step 5/7 line.
//
// --dry-run is used so this test never needs to reach or depend on the
// mirror push outcome — the overlay step itself (and its log line) runs
// unconditionally before the push step, dry-run or not.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t536-clone-');
  const nameA = 'zzzT536' + 'MoveCreditAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  function findStep5Line(stdout) {
    return stdout.split('\n').find((l) => /Step 5\/7/.test(l));
  }

  // --- Run A: --max-move-credit-ratio SET ---
  const bareMirrorSet = initBareMirrorWithMain('mavp-build-t536-set-');
  const cloneDirTargetSet = path.join(mkTempDir('mavp-build-t536-set-parent-'), 'clone-dir-target');

  const setResult = runBuildCli(cloneRepoDir, [
    bareMirrorSet,
    cloneDirTargetSet,
    '--private-names',
    `${nameA},${nameB}`,
    '--dry-run',
    '--max-move-credit-ratio',
    '0.37',
  ]);
  assert.strictEqual(
    setResult.status,
    0,
    `Test 22a FAIL: expected exit 0 on a --dry-run bootstrap run, got ${setResult.status}:\n${setResult.stderr}`
  );
  const step5LineSet = findStep5Line(setResult.stdout);
  assert.ok(step5LineSet, `Test 22a FAIL: expected a "Step 5/7" line in stdout, got: ${setResult.stdout}`);
  assert.ok(
    step5LineSet.includes('--max-move-credit-ratio 0.37'),
    `Test 22a FAIL (mutant 3, call-site drop): expected the logged Step 5/7 overlay command line to include ` +
      `"--max-move-credit-ratio 0.37", got: ${step5LineSet}`
  );
  console.log(
    `Test 22a passed (mutant 3, call-site drop): a real run invoked with --max-move-credit-ratio 0.37 logs ` +
      `it in the Step 5/7 overlay command line:\n    ${step5LineSet.trim()}`
  );

  // --- Run B: --max-move-credit-ratio UNSET ---
  const bareMirrorUnset = initBareMirrorWithMain('mavp-build-t536-unset-');
  const cloneDirTargetUnset = path.join(mkTempDir('mavp-build-t536-unset-parent-'), 'clone-dir-target');

  const unsetResult = runBuildCli(cloneRepoDir, [
    bareMirrorUnset,
    cloneDirTargetUnset,
    '--private-names',
    `${nameA},${nameB}`,
    '--dry-run',
  ]);
  assert.strictEqual(
    unsetResult.status,
    0,
    `Test 22b FAIL: expected exit 0 on a --dry-run bootstrap run, got ${unsetResult.status}:\n${unsetResult.stderr}`
  );
  const step5LineUnset = findStep5Line(unsetResult.stdout);
  assert.ok(step5LineUnset, `Test 22b FAIL: expected a "Step 5/7" line in stdout, got: ${unsetResult.stdout}`);
  assert.ok(
    !/--max-move-credit-ratio/.test(step5LineUnset),
    `Test 22b FAIL (mutant 4, unset-leak): expected no --max-move-credit-ratio token when the flag is ` +
      `omitted, got: ${step5LineUnset}`
  );
  assert.ok(
    !/undefined|null/.test(step5LineUnset),
    `Test 22b FAIL (mutant 4, unset-leak): expected no undefined/null leakage in the logged overlay command ` +
      `line, got: ${step5LineUnset}`
  );
  console.log(
    `Test 22b passed (mutant 4, unset-leak): a real run WITHOUT --max-move-credit-ratio logs no flag token ` +
      `and no undefined/null leakage in the Step 5/7 overlay command line:\n    ${step5LineUnset.trim()}`
  );
}

console.log('\nAll T-536 assertions passed.');

// ---------------------------------------------------------------------------
// T-539 — shared helpers for the commit-OBJECT assertions below.
//
// Every case from here on reads the commit object itself (`git cat-file
// commit`) rather than a rendered `git log` line, because the two residuals
// these cases close are HEADERS on the object (`gpgsig`, `encoding`) that no
// message-level string comparison can see: a header-carrying commit
// round-trips through a pinned read-back unchanged and evades it entirely.
// Read as a Buffer, never as a utf8 string, so the encoding case can compare
// BYTES.
// ---------------------------------------------------------------------------
function readCommitObject(repoPath, ref, { bare = false } = {}) {
  return bare
    ? execFileSync('git', ['--git-dir', repoPath, 'cat-file', 'commit', ref])
    : execFileSync('git', ['cat-file', 'commit', ref], { cwd: repoPath });
}

// The header block of a commit object is everything before the first EMPTY
// line; multi-line header values (a signature's armor) are continuation lines
// prefixed with a single space, so they never contain an empty line and this
// split is exact. latin1 is used deliberately — it is a byte-preserving
// decode, and every header NAME is ASCII, so a mislabelled non-UTF-8 value
// cannot corrupt the header scan.
function commitHeaderBlock(buf) {
  const text = buf.toString('latin1');
  const separatorIndex = text.indexOf('\n\n');
  return separatorIndex === -1 ? text : text.slice(0, separatorIndex);
}

function commitHasHeader(buf, headerName) {
  return new RegExp(`(^|\\n)${headerName} `).test(commitHeaderBlock(buf));
}

function commitHeaderValue(buf, headerName) {
  const match = commitHeaderBlock(buf).match(new RegExp(`(?:^|\\n)${headerName} (.*)`));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// T-539 — Test 23 (residual 1): the `commit.gpgSign=false` pin, which shipped
// with T-523 and had NO test at all — a mutant removing it at the stepCommit
// call site survived the entire suite. The previous developer's stated reason
// was that testing it needs a real signing key as machine-level state; the
// security reviewer disproved that with `ssh-keygen` into a temp dir plus
// three REPO-LOCAL config values, and this test is that reproduction.
//
// Precedence argument (the same one Test 16a rests on): repo-local config is
// strictly LOWER precedence than the global config an operator's real signing
// setup uses, and `git -c` outranks both — so a pin that beats a repo-local
// commit.gpgSign=true necessarily beats the global case too. No test here ever
// touches the machine's own git config or ssh keys.
//
// Part A is the LOAD-BEARING CONTROL, and it is deliberately fatal rather than
// skippable: if this environment cannot produce a signed commit (no
// `ssh-keygen`, or a git too old for `gpg.format=ssh`), the test FAILS loudly.
// A silent skip here would restore exactly the false confidence this case
// exists to remove — a green suite that proves nothing about the pin.
//
// Killer for the mutation "commit.gpgSign=false filtered out of the pins at
// the stepCommit call site only" (Test 16a, which asserts on
// buildCommitConfigPins()'s own return value, stays green): that mutant signs
// the commit, the run still exits 0 (a signature does not change `%B`, so
// neither the read-back nor the range scan reacts), and the PUBLISHED commit
// object carries a `gpgsig` header — which Part B's cat-file assertion refuses.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t539-sign-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t539-sign-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t539-sign-parent-'), 'clone-dir-target');

  // --- The signing key: generated into a throwaway temp dir, never read from
  // and never written to the operator's own ~/.ssh. Empty passphrase so
  // `ssh-keygen -Y sign` (which git shells out to) never prompts.
  const keyDir = mkTempDir('mavp-build-t539-sign-key-');
  const keyPath = path.join(keyDir, 'id_ed25519');
  const keygen = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', 'zzz-t539-fixture-signing-key', '-f', keyPath],
    { encoding: 'utf8' }
  );
  assert.strictEqual(
    keygen.status,
    0,
    `Test 23 BLOCKED (not skipped): ssh-keygen could not generate the fixture signing key, so the ` +
      `load-bearing control for the commit.gpgSign=false pin cannot be produced in this environment. A ` +
      `silent skip here would let a pin-removing mutant ship green, so this is a hard failure. ssh-keygen ` +
      `exit ${keygen.status}: ${keygen.stderr || keygen.error || 'no output'}`
  );
  assert.ok(
    fs.existsSync(`${keyPath}.pub`),
    'Test 23 BLOCKED (not skipped): ssh-keygen reported success but wrote no public key — the control cannot be produced'
  );
  // The raw key bytes, for the control's "the signature really does embed the
  // operator's own public key" assertion. Decoded from base64 on BOTH sides:
  // the armored signature re-encodes the same bytes at a different base64
  // phase, so a substring check on the base64 TEXT would fail even though the
  // key is genuinely in there.
  const publicKeyBlob = Buffer.from(
    fs.readFileSync(`${keyPath}.pub`, 'utf8').trim().split(/\s+/)[1],
    'base64'
  );

  const configureSigning = (repoDir) => {
    git(repoDir, ['config', 'user.email', 'fixture@example.invalid']);
    git(repoDir, ['config', 'user.name', 'Fixture User']);
    git(repoDir, ['config', 'gpg.format', 'ssh']);
    git(repoDir, ['config', 'user.signingkey', keyPath]);
    git(repoDir, ['config', 'commit.gpgSign', 'true']);
  };

  // The clone dir is created HERE (not by the script's first run) so the
  // signing config is repo-local and in place before the script's own commit.
  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  configureSigning(cloneDirTarget);

  // --- Part A: the load-bearing control, in a throwaway clone of the SAME
  // shape so nothing here perturbs the clone Part B publishes from. ---
  {
    const probeClone = path.join(mkTempDir('mavp-build-t539-sign-probe-parent-'), 'probe-clone');
    execFileSync('git', ['clone', '--quiet', bareMirror, probeClone]);
    configureSigning(probeClone);

    const unpinnedCommit = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'control: unpinned'], {
      cwd: probeClone,
      encoding: 'utf8',
    });
    assert.strictEqual(
      unpinnedCommit.status,
      0,
      `Test 23 BLOCKED (not skipped): this git could not produce an ssh-signed commit at all (gpg.format=ssh ` +
        `needs git >= 2.34), so the load-bearing control for the commit.gpgSign=false pin cannot be produced. ` +
        `Refusing to pass vacuously. git exit ${unpinnedCommit.status}: ${unpinnedCommit.stderr || 'no output'}`
    );

    const unpinnedObject = readCommitObject(probeClone, 'HEAD');
    assert.ok(
      commitHasHeader(unpinnedObject, 'gpgsig'),
      `Test 23 FAIL (load-bearing control broken): an UNPINNED commit in this clone must gain a gpgsig ` +
        `header — that is the whole vector. Without it the pinned assertion below proves nothing. Commit ` +
        `object header block:\n${commitHeaderBlock(unpinnedObject)}`
    );
    // ...and the signature really does carry the operator's own key material
    // into the object, which is the harm the pin prevents (no author override
    // suppresses it).
    const armor = commitHeaderBlock(unpinnedObject)
      .split('\n')
      .map((line) => line.replace(/^ /, ''))
      .join('\n')
      .match(/BEGIN SSH SIGNATURE-----\n([\s\S]*?)-----END SSH SIGNATURE/);
    assert.ok(armor, `Test 23 FAIL (control broken): could not locate the signature armor in the commit object`);
    const signatureBytes = Buffer.from(armor[1].replace(/\s+/g, ''), 'base64');
    assert.ok(
      signatureBytes.includes(publicKeyBlob),
      `Test 23 FAIL (control broken): the signature on the unpinned commit must byte-embed the fixture's own ` +
        `ed25519 public key (${publicKeyBlob.length} bytes) — that embedding is what would reach the public ` +
        `mirror. Signature is ${signatureBytes.length} bytes.`
    );

    // And the pin, read from the CLONE's own committed copy of the script —
    // the exact argv Part B's run will issue, never a hardcoded copy of it.
    const { buildCommitConfigPins } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
    const emptyHooksDir = mkTempDir('mavp-build-t539-sign-emptyhooks-');
    const pins = buildCommitConfigPins(emptyHooksDir);
    assert.ok(
      pins.includes('commit.gpgSign=false'),
      `Test 23 FAIL: the exported commit pins must still cover commit.gpgSign, got: ${JSON.stringify(pins)}`
    );
    const pinnedCommit = spawnSync('git', [...pins, 'commit', '-q', '--allow-empty', '-m', 'control: pinned'], {
      cwd: probeClone,
      encoding: 'utf8',
    });
    assert.strictEqual(
      pinnedCommit.status,
      0,
      `Test 23 FAIL: the pinned commit invocation must succeed, got ${pinnedCommit.status}: ${pinnedCommit.stderr}`
    );
    const pinnedObject = readCommitObject(probeClone, 'HEAD');
    assert.ok(
      !commitHasHeader(pinnedObject, 'gpgsig'),
      `Test 23 FAIL: the pin must suppress the signature header entirely, got header block:\n${commitHeaderBlock(pinnedObject)}`
    );

    console.log(
      'Test 23a (load-bearing control) passed: with repo-local gpg.format=ssh + user.signingkey (a temp-dir ' +
        'ssh-keygen key) + commit.gpgSign=true, an UNPINNED commit gains a gpgsig header whose signature ' +
        `byte-embeds the fixture's own ed25519 public key (${publicKeyBlob.length} key bytes inside ` +
        `${signatureBytes.length} signature bytes) — and the script's own exported pins suppress the header entirely`
    );
  }

  // --- Part B: the real script, end to end, against the signing-configured clone. ---
  const SIGN_NAME_A = 'zzzT539' + 'SignNever' + 'MatchesAnything';
  const SIGN_NAME_B = SIGN_NAME_A + 'Either';
  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${SIGN_NAME_A},${SIGN_NAME_B}`,
    '--summary',
    'T-539 fixture: clean summary published from a signing-configured clone',
  ]);

  assert.strictEqual(
    result.status,
    0,
    `Test 23b FAIL: expected exit 0 on a clean publish, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /\nDone\.\s*$/.test(result.stdout),
    `Test 23b FAIL: expected a plain "Done.", got stdout tail: ${result.stdout.slice(-300)}`
  );

  // GROUND TRUTH — the PUBLISHED commit object, read from the mirror.
  const publishedObject = readCommitObject(bareMirror, 'edge', { bare: true });
  assert.ok(
    !commitHasHeader(publishedObject, 'gpgsig'),
    `Test 23b FAIL: THE gpgSign RESIDUAL — the published commit object carries a gpgsig header, so the ` +
      `operator's signing key material reached the public mirror. Header block:\n${commitHeaderBlock(publishedObject)}`
  );
  assert.ok(
    !publishedObject.includes(publicKeyBlob),
    "Test 23b FAIL: the fixture's public key bytes must appear nowhere in the published commit object"
  );

  console.log(
    'Test 23b passed (residual 1, the gpgSign pin): a clone with repo-local commit.gpgSign=true + ' +
      'gpg.format=ssh + user.signingkey publishes an UNSIGNED commit — no gpgsig header and no key bytes in ' +
      'the published object, while Test 23a proves the same clone DOES sign without the pin'
  );
}

// ---------------------------------------------------------------------------
// T-539 — Test 24 (residual 2): the message-ENCODING pins.
//
// `i18n.commitEncoding` is an ordinary operator setting, not an attack. With a
// legacy value configured, `git commit` stamps an `encoding <that value>`
// header onto the commit object — echoing the operator's own config into the
// public commit and MISLABELLING the message bytes.
//
// MEASURED DEVIATION FROM THE ORIGINAL FINDING'S WORDING, recorded here so a
// later reader does not "fix" this test back to something git does not do:
// git does NOT transcode a `-m` value at commit time (verified against git
// 2.50 while writing this test) — it writes the UTF-8 bytes it was given and
// merely DECLARES a different encoding. The transcode is real but happens on
// the READ side: any later reader asking for a different output encoding
// re-interprets those bytes, which Part A asserts directly. So the
// header-absence assertion, not a byte comparison, is the load-bearing one
// here — a header-carrying commit whose message happens to round-trip
// (anything ASCII does) evades a pure string comparison completely, which is
// exactly what Part B exists to catch.
//
// Killers, and why the two real runs below are in THIS order (Part B ASCII
// first, Part C non-ASCII second) — an assertion failure aborts the whole file,
// so the order decides which assertion each mutant is REPORTED against:
//   - the mutant dropping `i18n.commitEncoding=utf-8` at the stepCommit call
//     site fails PART B's cat-file no-header assertion. Part B's summary is
//     ASCII on purpose: ASCII round-trips through the mislabel byte for byte,
//     so the read-back comparison stays silent and the run still exits 0 — the
//     commit-object header is then the ONLY observable, and it is asserted.
//   - the mutant dropping MESSAGE_READ_CONFIG_PINS from the read-back fails
//     PART C's exit-0 / no-mismatch assertion and leaves Part B green: with the
//     commit correctly recorded as UTF-8 and the read requesting the repo's
//     legacy encoding, `git log` transcodes a NON-ASCII message on output, Node
//     decodes the result as UTF-8, and the tightened read-back refuses what is
//     an entirely benign difference.
// Part C is the acceptance criterion's headline run (non-ASCII --summary, exit
// 0, no mismatch, no WARNING, a plain Done., no encoding header, recorded bytes
// == the UTF-8 of the composed string); Part B is its ASCII companion, which
// exists purely to isolate the commit-side pin.
// ---------------------------------------------------------------------------
{
  // A legacy single-byte encoding, chosen because every non-ASCII codepoint
  // used below is representable in it (so git's iconv conversion succeeds
  // rather than silently falling back to the original bytes).
  const LEGACY_ENCODING = 'ISO-8859-1';
  // Built from a codepoint rather than written as a literal, so no editor,
  // linter or file-encoding conversion can silently make this fixture ASCII
  // (and therefore vacuous).
  const NON_ASCII = String.fromCharCode(0x00e9); // LATIN SMALL LETTER E WITH ACUTE
  const NON_ASCII_SUMMARY = `T-539 fixture: caf${NON_ASCII} non-ASCII summary`;

  const configureLegacyEncoding = (repoDir) => {
    git(repoDir, ['config', 'user.email', 'fixture@example.invalid']);
    git(repoDir, ['config', 'user.name', 'Fixture User']);
    git(repoDir, ['config', 'i18n.commitEncoding', LEGACY_ENCODING]);
  };

  const cloneRepoDir = cloneRepoFixture('mavp-build-t539-enc-clone-');
  const ENC_NAME_A = 'zzzT539' + 'EncNever' + 'MatchesAnything';
  const ENC_NAME_B = ENC_NAME_A + 'Either';

  // --- Part A: the load-bearing control. ---
  {
    const probeBare = initBareMirrorWithMain('mavp-build-t539-enc-probe-');
    const probeClone = path.join(mkTempDir('mavp-build-t539-enc-probe-parent-'), 'probe-clone');
    execFileSync('git', ['clone', '--quiet', probeBare, probeClone]);
    configureLegacyEncoding(probeClone);

    git(probeClone, ['commit', '-q', '--allow-empty', '-m', NON_ASCII_SUMMARY]);
    const unpinnedObject = readCommitObject(probeClone, 'HEAD');
    assert.ok(
      commitHasHeader(unpinnedObject, 'encoding'),
      `Test 24 FAIL (load-bearing control broken): an UNPINNED commit under repo-local ` +
        `i18n.commitEncoding=${LEGACY_ENCODING} must gain an \`encoding\` header — that is the vector. ` +
        `Header block:\n${commitHeaderBlock(unpinnedObject)}`
    );
    assert.strictEqual(
      commitHeaderValue(unpinnedObject, 'encoding'),
      LEGACY_ENCODING,
      `Test 24 FAIL (control broken): the header must echo the operator's OWN configured value, got: ` +
        `${JSON.stringify(commitHeaderValue(unpinnedObject, 'encoding'))}`
    );
    // The byte-level consequence of the mislabel, asserted directly: reading
    // that commit back as UTF-8 does NOT return the composed string, because
    // git converts from the declared legacy encoding on output.
    const mislabelledReadBack = execFileSync(
      'git',
      ['-c', 'i18n.logOutputEncoding=utf-8', 'log', '-1', '--format=%B'],
      { cwd: probeClone }
    );
    assert.notStrictEqual(
      mislabelledReadBack.toString('utf8').replace(/\n+$/, ''),
      NON_ASCII_SUMMARY,
      `Test 24 FAIL (control broken): the mislabelled commit must NOT round-trip — reading it as UTF-8 has ` +
        `to yield transcoded bytes, which is the corruption the pin prevents. Got: ` +
        `${JSON.stringify(mislabelledReadBack.toString('utf8'))}`
    );

    // Now the same clone, committing WITH the script's own exported pins.
    const { buildCommitConfigPins } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
    const emptyHooksDir = mkTempDir('mavp-build-t539-enc-emptyhooks-');
    const pins = buildCommitConfigPins(emptyHooksDir);
    assert.ok(
      pins.includes('i18n.commitEncoding=utf-8'),
      `Test 24 FAIL: the exported commit pins must cover i18n.commitEncoding, got: ${JSON.stringify(pins)}`
    );
    git(probeClone, [...pins, 'commit', '-q', '--allow-empty', '-m', NON_ASCII_SUMMARY]);
    const pinnedObject = readCommitObject(probeClone, 'HEAD');
    assert.ok(
      !commitHasHeader(pinnedObject, 'encoding'),
      `Test 24 FAIL: the pin must suppress the encoding header entirely, got header block:\n${commitHeaderBlock(pinnedObject)}`
    );
    assert.ok(
      pinnedObject.includes(Buffer.from(NON_ASCII_SUMMARY, 'utf8')),
      "Test 24 FAIL: the pinned commit's recorded bytes must be the UTF-8 of the composed string"
    );

    // And the exported READ-side pin, likewise sourced from the clone's own copy.
    const { MESSAGE_READ_CONFIG_PINS } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
    assert.deepStrictEqual(
      MESSAGE_READ_CONFIG_PINS,
      ['-c', 'i18n.logOutputEncoding=utf-8'],
      `Test 24 FAIL: the exported message-read pins drifted, got: ${JSON.stringify(MESSAGE_READ_CONFIG_PINS)}`
    );

    console.log(
      `Test 24a (load-bearing control) passed: under repo-local i18n.commitEncoding=${LEGACY_ENCODING} an ` +
        `UNPINNED commit gains an \`encoding ${LEGACY_ENCODING}\` header echoing the operator's own config, ` +
        `and the mislabelled message no longer round-trips as UTF-8 ` +
        `(${JSON.stringify(mislabelledReadBack.toString('utf8').replace(/\n+$/, ''))}) — while the script's ` +
        'own pins suppress the header and keep the recorded bytes the UTF-8 of the composed string'
    );
  }

  // --- Part B: the real script with an ASCII --summary under the same legacy
  // commitEncoding. Runs FIRST on purpose: this is the case that makes the
  // cat-file no-header assertion the UNIQUE killer for a dropped
  // commitEncoding pin, because ASCII round-trips through the mislabel byte for
  // byte — the read-back comparison stays silent, the run publishes, and the
  // commit-object header is the only observable difference left. ---
  {
    const bareMirror = initBareMirrorWithMain('mavp-build-t539-enc-b-');
    const cloneDirTarget = path.join(mkTempDir('mavp-build-t539-enc-b-parent-'), 'clone-dir-target');
    execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
    configureLegacyEncoding(cloneDirTarget);

    const result = runBuildCli(cloneRepoDir, [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${ENC_NAME_A},${ENC_NAME_B}`,
      '--summary',
      'T-539 fixture: plain ASCII summary under a legacy commit encoding',
    ]);

    assert.strictEqual(
      result.status,
      0,
      `Test 24b FAIL: expected exit 0, got ${result.status}:\n${result.stdout}\n${result.stderr}`
    );
    const publishedObject = readCommitObject(bareMirror, 'edge', { bare: true });
    assert.ok(
      !commitHasHeader(publishedObject, 'encoding'),
      `Test 24b FAIL: THE ENCODING RESIDUAL, in the form no string comparison can see — the published commit ` +
        `object carries an encoding header even though its ASCII message round-tripped cleanly. Header ` +
        `block:\n${commitHeaderBlock(publishedObject)}`
    );

    console.log(
      'Test 24b passed (the commitEncoding pin, isolated): an ASCII summary round-trips through the mislabel ' +
        'unchanged, so the run still exits 0 — and the published commit object carries NO encoding header, ' +
        'which is the only assertion that can catch a dropped commitEncoding pin in this case'
    );
  }

  // --- Part C: the acceptance criterion's headline run — non-ASCII --summary,
  // same legacy commitEncoding. This is the case the DROPPED READ PIN breaks
  // (and it leaves Part B green, which is what separates the two pins). ---
  {
    const bareMirror = initBareMirrorWithMain('mavp-build-t539-enc-c-');
    const cloneDirTarget = path.join(mkTempDir('mavp-build-t539-enc-c-parent-'), 'clone-dir-target');
    execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
    configureLegacyEncoding(cloneDirTarget);

    const result = runBuildCli(cloneRepoDir, [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${ENC_NAME_A},${ENC_NAME_B}`,
      '--summary',
      NON_ASCII_SUMMARY,
    ]);

    assert.strictEqual(
      result.status,
      0,
      `Test 24c FAIL: expected exit 0 publishing a non-ASCII summary under a legacy i18n.commitEncoding, got ` +
        `${result.status}:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      !/is NOT the string this run scanned/.test(result.stderr),
      `Test 24c FAIL: the read-back must report NO mismatch — a benign encoding difference must never be ` +
        `the thing that fires it, got stderr: ${result.stderr}`
    );
    assert.ok(
      !/WARNING/.test(result.stderr),
      `Test 24c FAIL: expected no WARNING at all, got stderr: ${result.stderr}`
    );
    assert.ok(
      /\nDone\.\s*$/.test(result.stdout),
      `Test 24c FAIL: expected a plain "Done.", got stdout tail: ${result.stdout.slice(-300)}`
    );

    // GROUND TRUTH — the published commit object, as BYTES.
    const publishedObject = readCommitObject(bareMirror, 'edge', { bare: true });
    assert.ok(
      !commitHasHeader(publishedObject, 'encoding'),
      `Test 24c FAIL: THE ENCODING RESIDUAL — the published commit object carries an encoding header echoing ` +
        `operator config. Header block:\n${commitHeaderBlock(publishedObject)}`
    );
    const composedSubject = `Sync from canonical: ${NON_ASCII_SUMMARY}`;
    assert.ok(
      publishedObject.includes(Buffer.from(composedSubject, 'utf8')),
      `Test 24c FAIL: the recorded bytes must be the UTF-8 of the composed string. Expected to find ` +
        `${JSON.stringify(Buffer.from(composedSubject, 'utf8').toString('hex').slice(0, 60))}... in the object.`
    );
    // ...and specifically NOT the double-encoded form a mislabel produces.
    const doubleEncoded = Buffer.from(Buffer.from(composedSubject, 'utf8').toString('latin1'), 'utf8');
    assert.ok(
      !publishedObject.includes(doubleEncoded),
      'Test 24c FAIL: the published subject must not be double-encoded'
    );

    console.log(
      `Test 24c passed (residual 2, the read pin): a non-ASCII --summary published under repo-local ` +
        `i18n.commitEncoding=${LEGACY_ENCODING} exits 0 with no mismatch, no WARNING and a plain "Done." — ` +
        'no encoding header on the published object and its recorded bytes are exactly the UTF-8 of the ' +
        'composed string'
    );
  }
}

// ---------------------------------------------------------------------------
// T-539 — Test 25 (residual 3): the read-back now refuses on ANY difference,
// not only on one that trips the scan.
//
// The old behavior WARNED and continued when the rewritten text re-scanned
// clean, which published a string the run's own "Commit-message scan GREEN"
// certificate never covered — and did it on an exit-0 run whose final line
// still read as success. After the pins (hooks-free core.hooksPath,
// commit.cleanup=verbatim, i18n.commitEncoding=utf-8, the read pinned to
// i18n.logOutputEncoding=utf-8, and trailing-newline normalization on both
// sides) there is no enumerable benign cause left for a difference, so a
// difference means an unidentified rewriting mechanism is live inside the
// publish pipeline — the one moment this script must not write.
//
// The seam is Test 17's: a `git` WRAPPER earlier on PATH, which no `git -c`
// pin can reach. The difference from Test 17 is the appended line's CONTENT —
// entirely benign here, so the re-scan comes back clean and the OLD code path
// would have warned and published.
//
// Killer for the mutation "the refusal reverted to warn-and-continue": that
// mutant publishes, so exit 0, the mirror gains an edge ref, local edge stays
// 1 commit ahead and the final line reads "Done." — all four asserted below.
// ---------------------------------------------------------------------------
function makeMessageAppendingGitWrapper(prefix, appendedLine) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  assert.ok(
    realGit && path.isAbsolute(realGit),
    `could not resolve the real git binary, got: ${JSON.stringify(realGit)}`
  );
  const shimDir = mkTempDir(prefix);
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const { spawnSync } = require('node:child_process');\n" +
      `const REAL_GIT = ${JSON.stringify(realGit)};\n` +
      `const APPENDED = ${JSON.stringify(appendedLine)};\n` +
      'const args = process.argv.slice(2);\n' +
      "const commitIndex = args.indexOf('commit');\n" +
      'if (commitIndex !== -1) {\n' +
      "  const messageIndex = args.indexOf('-m', commitIndex);\n" +
      "  if (messageIndex !== -1 && typeof args[messageIndex + 1] === 'string') {\n" +
      "    args[messageIndex + 1] = args[messageIndex + 1] + '\\n' + APPENDED;\n" +
      '  }\n' +
      '}\n' +
      "const result = spawnSync(REAL_GIT, args, { stdio: 'inherit' });\n" +
      'process.exit(result.status === null ? 1 : result.status);\n',
    { mode: 0o755 }
  );
  return { shimDir, env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` } };
}

{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t539-clean-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t539-clean-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t539-clean-parent-'), 'clone-dir-target');

  // Deliberately carries NOTHING any detection category matches: no private
  // name, no path, no address, no token shape. That is the entire point — the
  // re-scan must come back clean so this exercises the DIFFERENCE-only refusal.
  const BENIGN_APPENDED_LINE = 'Appended-By-Fixture: a benign extra line with no detectable content';
  const { env: shimEnv } = makeMessageAppendingGitWrapper(
    'mavp-build-t539-clean-bin-',
    BENIGN_APPENDED_LINE
  );

  const CLEAN_NAME_A = 'zzzT539' + 'CleanRewriteNever' + 'MatchesAnything';
  const CLEAN_NAME_B = CLEAN_NAME_A + 'Either';

  // Load-bearing proof that the wrapper genuinely rewrites (and that the
  // appended line really is clean under this run's own category set, so this
  // case cannot silently degrade into a second copy of Test 17).
  {
    const probeRepo = mkTempDir('mavp-build-t539-clean-probe-');
    execFileSync('git', ['init', '-q', probeRepo]);
    git(probeRepo, ['config', 'user.email', 'fixture@example.invalid']);
    git(probeRepo, ['config', 'user.name', 'Fixture User']);
    const probeResult = spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'probe subject'], {
      cwd: probeRepo,
      env: shimEnv,
      encoding: 'utf8',
    });
    assert.strictEqual(
      probeResult.status,
      0,
      `Test 25 FAIL (wrapper probe): expected the wrapper to commit successfully, got ${probeResult.status}:\n${probeResult.stderr}`
    );
    assert.ok(
      git(probeRepo, ['log', '-1', '--format=%B']).includes(BENIGN_APPENDED_LINE),
      'Test 25 FAIL (wrapper probe): load-bearing proof broken — the PATH wrapper must actually append its line'
    );
    // ...and the appended line scans CLEAN under the run's own category set,
    // read from the clone's own copy of the scanner-backed helper.
    const { scanCommitMessageForFindings } = require(path.join(cloneRepoDir, 'scripts', 'mavp-publish-build.js'));
    assert.deepStrictEqual(
      scanCommitMessageForFindings(BENIGN_APPENDED_LINE, [CLEAN_NAME_A, CLEAN_NAME_B]),
      [],
      'Test 25 FAIL (fixture broken): the appended line must scan CLEAN, or this case degenerates into Test 17'
    );
  }

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  const result = runBuildCli(
    cloneRepoDir,
    [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${CLEAN_NAME_A},${CLEAN_NAME_B}`,
      '--summary',
      'T-539 fixture: clean summary, rewritten behind the gate with benign text',
    ],
    { env: shimEnv }
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Test 25 FAIL: THE FAIL-OPEN — a recorded message that is not the scanned string must be refused even ` +
      `when it re-scans clean, got exit ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Commit-message scan GREEN/.test(result.stdout),
    `Test 25 FAIL: the creation-time gate must still pass on the composed string, got stdout: ${result.stdout}`
  );
  assert.ok(
    /is NOT the string this run scanned/.test(result.stderr),
    `Test 25 FAIL: expected the read-back to report the difference, got stderr: ${result.stderr}`
  );
  assert.ok(
    /ZERO findings/.test(result.stderr),
    `Test 25 FAIL: the diagnostics must state that the recorded text re-scanned CLEAN (that is what makes ` +
      `this the difference-only refusal rather than Test 17's), got stderr: ${result.stderr}`
  );
  assert.ok(
    /refuses on the DIFFERENCE alone/.test(result.stderr),
    `Test 25 FAIL: the abort must say it refuses on the difference alone, got stderr: ${result.stderr}`
  );
  assert.ok(
    /reset --soft HEAD~1/.test(result.stderr) && /nothing was pushed/.test(result.stderr),
    `Test 25 FAIL: the clean branch must ALSO undo the commit through the existing reset-soft machinery, got ` +
      `stderr: ${result.stderr}`
  );
  // No success-shaped final line — neither main()'s bare "Done." nor its
  // "Done — WARNING above" form. (Matched at end-of-output / on the whole
  // form deliberately: step 1's assemble script prints its own unrelated
  // "Done. Output written to: ..." line mid-run, which is not a final line.)
  assert.ok(
    !/\nDone\.\s*$/.test(result.stdout) && !/\nDone — /.test(result.stdout),
    `Test 25 FAIL: a refused run must not end in any success-shaped "Done" line, got stdout tail: ${result.stdout.slice(-300)}`
  );

  // GROUND TRUTH #1 — the mirror is byte-identical.
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    refsBefore,
    'Test 25 FAIL: mirror refs must be completely unchanged when the recorded message differs from the scanned string'
  );
  // GROUND TRUTH #2 — and the commit is not left on local `edge` either.
  const aheadCount = git(cloneDirTarget, ['rev-list', '--count', 'origin/main..edge']).trim();
  assert.strictEqual(
    aheadCount,
    '0',
    `Test 25 FAIL: the rewritten commit must be undone via reset --soft — expected local 'edge' 0 commits ` +
      `ahead, got ${aheadCount}`
  );
  const stagedAfter = git(cloneDirTarget, ['diff', '--cached', '--name-only']).trim();
  assert.ok(
    stagedAfter.length > 0,
    "Test 25 FAIL: the undo must be `reset --soft` (history only) — the overlay's staged content must survive"
  );

  console.log(
    'Test 25 passed (residual 3, fail closed on ANY difference): a PATH `git` wrapper appended a BENIGN line ' +
      'behind the gate; the recorded text re-scanned to ZERO findings and the run refused anyway — exit ' +
      `${result.status}, commit undone (local edge 0 ahead, overlay content still staged), mirror refs ` +
      'byte-identical, and no success-shaped final line'
  );
}

// ---------------------------------------------------------------------------
// T-539 — Test 26 (residual 4): BOTH fail-closed returns in
// commitsWithMessageFindings() — the range-hash read and the per-commit body
// read. A fail-open mutant on either survived the whole suite, because the
// PROVENANCE gate issues the byte-identical git command a few lines earlier
// and refuses first: any wrapper that fails "the command" fails the provenance
// gate's copy of it, and the test then passes for the wrong reason.
//
// So the wrapper here COUNTS matching invocations and fails only the SECOND
// one — the message enumeration's own — delegating the provenance gate's first
// call to real git. Each case therefore asserts BOTH that the message scan's
// refusal text is present AND that the provenance refusal text is ABSENT, plus
// that the wrapper's counter actually reached 2 (which is the proof that call
// #1 really was delegated rather than never issued).
//
// The `-c` pins both call sites now carry (MESSAGE_READ_CONFIG_PINS) are
// stripped before shape-matching, so this wrapper matches on the git command
// itself and stays correct if a future pin is added or removed.
//
// Killers:
//   - `if (!hashesResult.ok) return null;` -> `return [];` fails Case A only.
//   - `if (!bodyResult.ok) return null;` -> `continue;` fails Case B only.
// Each mutant leaves the OTHER case green, which is what makes them two
// distinct fail-closed returns rather than one.
// ---------------------------------------------------------------------------
function makeCountingGitWrapper(prefix, mode) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = mkTempDir(prefix);
  const statePath = path.join(shimDir, 'invocation-count.json');
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const fs = require('node:fs');\n" +
      "const { spawnSync } = require('node:child_process');\n" +
      `const REAL_GIT = ${JSON.stringify(realGit)};\n` +
      `const STATE = ${JSON.stringify(statePath)};\n` +
      `const MODE = ${JSON.stringify(mode)};\n` +
      'const args = process.argv.slice(2);\n' +
      '// Strip leading `-c <value>` pairs so the shape match is about the git\n' +
      '// COMMAND, not about which config the caller happens to pin.\n' +
      'let i = 0;\n' +
      "while (args[i] === '-c') i += 2;\n" +
      'const shape = args.slice(i);\n' +
      "const isRangeHashRead = shape[0] === 'log' && shape.includes('--format=%H');\n" +
      "const isBodyRead = shape[0] === 'show' && shape.includes('-s') && shape.includes('--format=%B');\n" +
      "const matches = MODE === 'range' ? isRangeHashRead : isBodyRead;\n" +
      'if (matches) {\n' +
      '  let count = 0;\n' +
      "  try { count = JSON.parse(fs.readFileSync(STATE, 'utf8')).count; } catch (err) { count = 0; }\n" +
      '  count += 1;\n' +
      '  fs.writeFileSync(STATE, JSON.stringify({ count }));\n' +
      '  if (count === 2) {\n' +
      "    process.stderr.write('fixture wrapper: failing invocation #2 of the ' + MODE + ' read only\\n');\n" +
      '    process.exit(97);\n' +
      '  }\n' +
      '}\n' +
      "const result = spawnSync(REAL_GIT, args, { stdio: 'inherit' });\n" +
      'process.exit(result.status === null ? 1 : result.status);\n',
    { mode: 0o755 }
  );
  return {
    env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` },
    readCount: () => {
      try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8')).count;
      } catch (err) {
        return 0;
      }
    },
  };
}

for (const { mode, label, criterion } of [
  { mode: 'range', label: 'Test 26a', criterion: 'the range-hash read (`git log <range> --format=%H`)' },
  { mode: 'body', label: 'Test 26b', criterion: 'the per-commit body read (`git show -s --format=%B <hash>`)' },
]) {
  const cloneRepoDir = cloneRepoFixture(`mavp-build-t539-failclosed-${mode}-clone-`);
  const bareMirror = initBareMirrorWithMain(`mavp-build-t539-failclosed-${mode}-`);
  const cloneDirTarget = path.join(
    mkTempDir(`mavp-build-t539-failclosed-${mode}-parent-`),
    'clone-dir-target'
  );

  const wrapper = makeCountingGitWrapper(`mavp-build-t539-failclosed-${mode}-bin-`, mode);
  const NAME_A = 'zzzT539' + 'FailClosedNever' + 'MatchesAnything';
  const NAME_B = NAME_A + 'Either';

  const refsBefore = gitShowRefOrEmpty(bareMirror);
  const result = runBuildCli(
    cloneRepoDir,
    [
      bareMirror,
      cloneDirTarget,
      '--private-names',
      `${NAME_A},${NAME_B}`,
      '--summary',
      `T-539 fixture: clean summary with ${mode} read made to fail`,
    ],
    { env: wrapper.env }
  );

  assert.strictEqual(
    result.status,
    1,
    `${label} FAIL: expected exit 1 (the script withheld a requested push), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  // The MESSAGE scan's own refusal — not the provenance gate's.
  assert.ok(
    /could not read the commit messages ahead of origin/.test(result.stderr),
    `${label} FAIL: expected the message-scan's own fail-closed refusal, got stderr: ${result.stderr}`
  );
  assert.ok(
    /an unreadable one is treated as unscanned/.test(result.stderr),
    `${label} FAIL: expected the message-scan refusal's own reasoning line, got stderr: ${result.stderr}`
  );
  // ...and NOT the provenance gate's, which issues the byte-identical command
  // a few lines earlier and would otherwise shadow this entirely.
  assert.ok(
    !/could not enumerate the commits ahead of origin/.test(result.stderr),
    `${label} FAIL: the PROVENANCE refusal must be absent — if it fired, this case passed for the wrong ` +
      `reason (the wrapper failed the wrong invocation), got stderr: ${result.stderr}`
  );
  assert.ok(
    !/do not\s+carry this script's scan-provenance marker/.test(result.stderr.replace(/\s+/g, ' ')),
    `${label} FAIL: the provenance marker refusal must be absent too, got stderr: ${result.stderr}`
  );
  // Proof the first (provenance-gate) invocation really was DELEGATED rather
  // than never issued: the counter saw exactly two matching invocations.
  assert.strictEqual(
    wrapper.readCount(),
    2,
    `${label} FAIL: the wrapper must have seen exactly 2 matching invocations (provenance gate's, delegated; ` +
      `message scan's, failed) — got ${wrapper.readCount()}, so the fixture is not exercising what it claims`
  );
  assert.ok(
    !/\nDone\.\s*$/.test(result.stdout),
    `${label} FAIL: expected NOT a bare "Done." on a refused push, got stdout tail: ${result.stdout.slice(-300)}`
  );

  // GROUND TRUTH — nothing was pushed.
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    refsBefore,
    `${label} FAIL: THE FAIL-OPEN — mirror refs changed even though the message range could not be scanned`
  );

  console.log(
    `${label} passed (residual 4, fail closed): with ${criterion} made to fail for the MESSAGE scan only ` +
      `(the provenance gate's byte-identical earlier call delegated to real git — wrapper saw exactly ` +
      `${wrapper.readCount()} matching invocations), the run exits 1 with the message-scan refusal present, ` +
      'the provenance refusal absent, and the mirror refs unchanged'
  );
}

// ---------------------------------------------------------------------------
// T-539 — Test 27 (residual 5): normalizeMessageForCompare(), directly.
//
// The mismatch path now scans the RAW read-back stdout rather than this
// normalized string. That decoupling is observationally equivalent today, but
// it REMOVES the only thing that was pinning the normalizer: Test 17's
// assertion that the appended line is reported on "message line 4" failed if
// the normalizer collapsed newlines. This unit test is the compensating pin,
// and it is the semantically matched one — it asserts what the normalizer must
// and must not do, instead of inferring it from a line number downstream.
//
// Killer for the mutation "widened to collapse all whitespace"
// (`/\s+$/`, `/\s+/g -> ' '`, `.trim()`, etc.): every assertion below that
// preserves internal, leading or trailing NON-newline whitespace fails.
// ---------------------------------------------------------------------------
{
  const { normalizeMessageForCompare } = require('./mavp-publish-build.js');

  // 1. Trailing newlines — and ONLY those — are stripped, however many.
  assert.strictEqual(
    normalizeMessageForCompare('subject\n\n\n'),
    'subject',
    'Test 27 FAIL: every trailing newline must be stripped'
  );
  assert.strictEqual(
    normalizeMessageForCompare('subject'),
    'subject',
    'Test 27 FAIL: a message with no trailing newline must be returned unchanged'
  );

  // 2. Leading whitespace is PRESERVED (a `.trim()`/`\s+` mutant fails here).
  assert.strictEqual(
    normalizeMessageForCompare('  indented subject\n'),
    '  indented subject',
    'Test 27 FAIL: leading whitespace must be preserved'
  );

  // 3. Trailing NON-newline whitespace is PRESERVED — this is what makes
  //    commit.cleanup=verbatim observable (see Test 20). A `/\s+$/` mutant
  //    fails exactly here.
  const trailingSpaces = 'subject with trailing spaces' + '   ';
  assert.strictEqual(
    normalizeMessageForCompare(`${trailingSpaces}\n`),
    trailingSpaces,
    'Test 27 FAIL: trailing spaces/tabs must be preserved — only trailing NEWLINES carry no information'
  );

  // 4. Internal whitespace, blank lines and internal newlines are PRESERVED.
  //    The appended-line vector this whole read-back exists to catch IS an
  //    internal newline, so a collapsing mutant would erase the signal.
  const structured = 'subject\n\nbody  with   runs\n\ttabbed line\n\nlast line';
  assert.strictEqual(
    normalizeMessageForCompare(`${structured}\n\n`),
    structured,
    'Test 27 FAIL: internal newlines, blank lines and internal whitespace runs must all be preserved'
  );

  // 5. And the property the read-back comparison depends on: an APPENDED LINE
  //    is never normalized away, so it always shows up as a difference.
  assert.notStrictEqual(
    normalizeMessageForCompare('subject\n\ntrailer\nappended\n'),
    normalizeMessageForCompare('subject\n\ntrailer\n'),
    'Test 27 FAIL: an appended line must survive normalization as a DIFFERENCE — that is the whole vector'
  );

  // 6. Non-string input is coerced, not thrown on (the function is called with
  //    whatever gitCapture returned).
  assert.strictEqual(normalizeMessageForCompare(42), '42', 'Test 27 FAIL: non-string input must be coerced');

  console.log(
    'Test 27 passed (residual 5, the normalizer): normalizeMessageForCompare() strips ONLY trailing newlines ' +
      '— leading whitespace, trailing spaces, internal whitespace runs, blank lines and appended lines are ' +
      'all preserved, so the read-back comparison keeps seeing every difference it must refuse'
  );
}

console.log('\nAll T-539 assertions passed.');

// ---------------------------------------------------------------------------
// Test 28 (T-506, lock wiring) — a live-held lock on <clone-dir> refuses the
// run BEFORE stepCloneOrPull (this script's first clone-directed git
// operation), proving build.js actually calls acquireLock() at the
// documented point in its sequence — not merely that the lock MODULE works
// in isolation (see test-publish-lock.js for that). Dropping the acquireLock
// call site from build.js's main() would make THIS test fail (the run would
// sail past our planted live lock, clone the mirror, and very likely
// succeed), which is the wiring guarantee this single test exists for.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t28-clone-');
  const bareMirror = initBareMirror('mavp-build-t28-mirror-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t28-parent-'), 'clone-dir-target');
  fs.rmSync(cloneDirTarget, { recursive: true, force: true }); // must not exist yet

  const { resolveLockPath, metadataFilePath } = require(path.join(__dirname, 'mavp-publish-lock.js'));
  const lockPath = resolveLockPath(cloneDirTarget);
  fs.mkdirSync(lockPath);
  // This TEST process's own pid — guaranteed alive for the entire duration
  // of this test, so the CLI run under test contends against a genuinely
  // live holder, exactly like Test 5 in test-publish-lock.js.
  fs.writeFileSync(
    metadataFilePath(lockPath),
    JSON.stringify(
      {
        pid: process.pid,
        start: new Date().toISOString(),
        argv: ['fixture-held-lock-for-t506-wiring-test'],
        hostname: os.hostname(),
      },
      null,
      2
    )
  );

  // Built via concatenation, not a contiguous literal — this test file is
  // itself ship-classified, so a reused literal would self-match the scan
  // (see Test 1's own comment / .claude/rules/scripts.md).
  const t28PrivateName1 = 'zzzT506' + 'Wiring' + 'FixtureName';
  const t28PrivateName2 = 'zzzT506' + 'Fixture' + 'SecondName';
  const result = runBuildCli(cloneRepoDir, [
    bareMirror,
    cloneDirTarget,
    '--private-names',
    `${t28PrivateName1},${t28PrivateName2}`,
  ]);

  assert.notStrictEqual(
    result.status,
    0,
    `Test 28 FAIL: expected non-zero exit when the clone-dir lock is held by a live pid, got ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    (result.stderr || '').includes('publish lock') && (result.stderr || '').includes(`held by pid ${process.pid}`),
    `Test 28 FAIL: expected the refusal to name the lock and holder pid (proving build.js calls acquireLock() before ` +
      `stepCloneOrPull); got:\n${result.stderr}`
  );
  assert.ok(
    !fs.existsSync(cloneDirTarget),
    'Test 28 FAIL: the clone dir must never be created when the lock refuses BEFORE stepCloneOrPull'
  );
  assert.strictEqual(
    gitShowRefOrEmpty(bareMirror),
    '',
    'Test 28 FAIL: the mirror must remain untouched (no refs) when the lock refuses before any clone-directed operation'
  );

  fs.rmSync(lockPath, { recursive: true, force: true });

  console.log(
    'Test 28 passed: a live-held lock on <clone-dir> refuses the run before stepCloneOrPull (build.js calls ' +
      'acquireLock() at the documented point) — mirror and clone dir both untouched.'
  );
}

// ---------------------------------------------------------------------------
// Test 29 (T-506 round 2, criterion 8) — proves the EXIT-HANDLER cleanup
// actually calls the GUARDED release (lock.release()), never an inline
// fs.rmSync(lockPath, ...): a PATH `git` wrapper intercepts stepCloneOrPull's
// `git clone` (the first clone-directed operation AFTER the lock is
// acquired) and, from INSIDE the same run, mutates the just-written lock
// metadata to a FOREIGN token before failing the clone — fully deterministic
// (no multi-process race: the mutation happens synchronously within this
// one process's own call sequence, well after its own acquireLock() call
// already wrote the real metadata). The run then aborts via its normal
// abort() -> process.exit(1) -> 'exit' handler path. If the exit handler
// still did an inline unconditional rmSync, the lock directory would be gone
// regardless of the token; wired to the guarded release(), it must survive
// with the foreign token untouched.
// ---------------------------------------------------------------------------
function makeTokenMutatingGitWrapper(prefix, metadataFilePathToMutate, foreignToken) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = mkTempDir(prefix);
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const fs = require('node:fs');\n" +
      `const META = ${JSON.stringify(metadataFilePathToMutate)};\n` +
      `const FOREIGN_TOKEN = ${JSON.stringify(foreignToken)};\n` +
      'const args = process.argv.slice(2);\n' +
      "if (args[0] === 'clone') {\n" +
      '  const data = JSON.parse(fs.readFileSync(META, \'utf8\'));\n' +
      '  data.token = FOREIGN_TOKEN;\n' +
      "  fs.writeFileSync(META, JSON.stringify(data, null, 2));\n" +
      "  process.stderr.write('fixture wrapper: mutated lock token to a foreign value before clone\\n');\n" +
      '  process.exit(97);\n' +
      '}\n' +
      "const { spawnSync } = require('node:child_process');\n" +
      `const REAL_GIT = ${JSON.stringify(realGit)};\n` +
      "const result = spawnSync(REAL_GIT, args, { stdio: 'inherit' });\n" +
      'process.exit(result.status === null ? 1 : result.status);\n',
    { mode: 0o755 }
  );
  return { env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` } };
}

{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t29-clone-');
  const bareMirror = initBareMirror('mavp-build-t29-mirror-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t29-parent-'), 'clone-dir-target');
  fs.rmSync(cloneDirTarget, { recursive: true, force: true }); // must not exist yet

  const { resolveLockPath, metadataFilePath, readLockMetadata } = require(path.join(__dirname, 'mavp-publish-lock.js'));
  const lockPath = resolveLockPath(cloneDirTarget);
  const metaPath = metadataFilePath(lockPath);
  const foreignToken = 'zzzT506Round2ForeignTokenMutatedByTest29';

  const wrapper = makeTokenMutatingGitWrapper('mavp-build-t29-bin-', metaPath, foreignToken);
  const t29PrivateName1 = 'zzzT506' + 'Round2' + 'WiringFixtureName';
  const t29PrivateName2 = t29PrivateName1 + 'Second';

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${t29PrivateName1},${t29PrivateName2}`],
    { env: wrapper.env }
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Test 29 FAIL: expected the wrapper-forced clone failure to abort the run non-zero, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /mutated lock token to a foreign value/.test(result.stderr),
    `Test 29 setup FAIL: expected proof the wrapper actually ran and mutated the token; got stderr:\n${result.stderr}`
  );
  assert.ok(
    fs.existsSync(lockPath),
    'Test 29 FAIL: the lock directory must SURVIVE the exit handler — a foreign token must refuse the guarded release, ' +
      'proving the exit handler calls lock.release() (guarded) rather than an inline fs.rmSync (unconditional)'
  );
  const survivingMeta = readLockMetadata(lockPath);
  assert.ok(
    survivingMeta.ok && survivingMeta.data.token === foreignToken,
    `Test 29 FAIL: the surviving metadata must still carry the FOREIGN token untouched; got: ${JSON.stringify(survivingMeta)}`
  );

  fs.rmSync(lockPath, { recursive: true, force: true });
  fs.rmSync(cloneDirTarget, { recursive: true, force: true });

  console.log(
    'Test 29 passed: build.js\'s exit handler refuses to remove a lock whose metadata token no longer matches this ' +
      "run's own — it calls the GUARDED release(), not an inline fs.rmSync."
  );
}

console.log('\nAll T-506 (build.js lock wiring) assertions passed.');

// ---------------------------------------------------------------------------
// T-534 — Tests 30a/30b/30c: the content-provenance gate (assembled tree vs
// HEAD blobs / mapped templates/ starter blobs), end-to-end against a real
// bare mirror. Uses the TEST-ONLY seam mavp-publish-build.js exposes via
// MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH (see build.js's own comment on
// applyTestOnlyProvenanceTamperSeam()) to deterministically reproduce "the
// assembled tree tampered with after scan, before push" — no multi-process
// race, no timing dependency: the tamper happens synchronously, in-process,
// right after stepScan() returns.
// ---------------------------------------------------------------------------

// Test 30a (AC1) — a one-byte tamper planted in the assembled tree after the
// scan gate aborts the build naming the tampered path, with the mirror's
// refs byte-identical before and after (nothing pushed).
//
// ACCURACY NOTE (T-534 round 2 live-mutant matrix): this test's tamper seam
// (MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH) corrupts tempOutDir BEFORE stepOverlay
// copies it into the clone, so the same corrupted byte lands in the commit
// too — verified live: deleting stepVerifyProvenance() (step 6.5) from
// main()'s sequence does NOT flip this test's assertions, because step 6.6
// (stepVerifyCommittedProvenance, reading the clone's own committed blob)
// independently refuses the identical tamper, with the same undo-on-refusal
// and the same "content-provenance check failed" substring in its message.
// This is a defense-in-depth property, not a gap — for THIS tamper class the
// two gates are equivalent, since anything reaching tempOutDir before
// overlay necessarily reaches the commit too. The scenario that uniquely
// requires step 6.6 (a corruption introduced ONLY during the clone's own
// `git add`, never visible in tempOutDir) is exercised by Test 31's
// core.autocrlf=true fixture — see this task's evidence for the live
// mutant-kill demonstration there (applied and reverted, never left in a
// commit).
//
// T-534 round 2 (criterion 5, UNDO-ON-REFUSAL): also asserts local `edge` in
// the clone is 0 commits ahead of origin/main post-abort — the commit
// stepCommit() made this run must be undone, so a later run's ahead-range
// push (T-514) can never pick up and transmit the tamper-detected tree.
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534a-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534a-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t534a-parent-'), 'clone-dir-target');

  const nameA = 'zzzT534' + 'ProvenanceGateAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const TAMPER_PATH = 'NOTICE';

  const refsBefore = gitShowRefOrEmpty(bareMirror);

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH: TAMPER_PATH } }
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Test 30a FAIL: expected non-zero exit on a planted content tamper, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /content-provenance check failed/.test(result.stderr),
    `Test 30a FAIL: expected the content-provenance ABORT message, got: ${result.stderr}`
  );
  assert.ok(
    result.stderr.includes(`for path "${TAMPER_PATH}"`),
    `Test 30a FAIL: expected the mismatched path "${TAMPER_PATH}" named in the abort, got: ${result.stderr}`
  );
  assert.ok(/no push has occurred/.test(result.stderr), 'Test 30a FAIL: expected the standard abort footer');
  assert.ok(
    result.stdout.includes('[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH set'),
    `Test 30a setup FAIL: expected proof the tamper seam actually fired, got stdout:\n${result.stdout}`
  );

  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfter,
    refsBefore,
    'Test 30a FAIL: mirror refs must be byte-identical before and after the aborted run (nothing pushed) — ' +
      `before:\n${refsBefore}\nafter:\n${refsAfter}`
  );

  // T-534 round 2 (criterion 5): the commit stepCommit() made this run must
  // have been undone — local `edge` in cloneDirTarget is back at
  // origin/main's tip (the bootstrap base), 0 commits ahead.
  const edgeSha = git(cloneDirTarget, ['rev-parse', 'edge']).trim();
  const originMainSha = git(cloneDirTarget, ['rev-parse', 'origin/main']).trim();
  assert.strictEqual(
    edgeSha,
    originMainSha,
    "Test 30a FAIL: expected local 'edge' to be reset back to origin/main's tip (0 ahead) post-abort — the " +
      `commit this run made must be undone, got edge=${edgeSha} origin/main=${originMainSha}`
  );

  console.log(
    `Test 30a passed: a one-byte tamper planted in the assembled tree (path "${TAMPER_PATH}") after the scan ` +
      'gate aborts the build naming that exact path, with the mirror refs byte-identical before and after ' +
      "(nothing pushed) and local 'edge' reset back to 0-ahead (the commit this run made was undone)"
  );
}

// ---------------------------------------------------------------------------
// Test 30b (AC2) — the tamper preserves the path set exactly (an existing
// path's content is replaced in place — nothing added, nothing removed) and
// the refusal names a CONTENT mismatch, never a missing/extra path — kills a
// mutant that reduces the check to comparing only path SETS between the
// assembled tree and the manifest/HEAD.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534b-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534b-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t534b-parent-'), 'clone-dir-target');

  const nameA = 'zzzT534' + 'ProvenanceGateBravo' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const TAMPER_PATH = 'NOTICE';

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH: TAMPER_PATH } }
  );
  assert.notStrictEqual(result.status, 0, `Test 30b FAIL: expected non-zero exit, got ${result.status}:\n${result.stderr}`);

  // The abort message names a CONTENT mismatch specifically, not a
  // missing/extra path (a path-set-only check would never produce this
  // wording, since it never compares bytes at all).
  assert.ok(
    /do not match the private repo's HEAD blob/.test(result.stderr),
    `Test 30b FAIL: expected content-mismatch wording naming the private repo's HEAD blob, got: ${result.stderr}`
  );
  assert.ok(
    !/is missing \(or cannot read\)/.test(result.stderr),
    `Test 30b FAIL: this must be reported as a CONTENT mismatch, not a missing-path finding: ${result.stderr}`
  );

  // The path SET was preserved exactly. stepCommit() already ran (and
  // committed the overlaid, tampered tree onto local 'edge') before the gate
  // fired — but T-534 round 2 (criterion 5, UNDO-ON-REFUSAL) then UNDOES that
  // commit (git reset --soft HEAD~1) before aborting, so 'edge' ITSELF no
  // longer points at the tampered tree post-abort. The committed-pre-abort
  // tree is instead re-anchored via the clone's own reflog: `edge@{1}` is the
  // commit that existed immediately before the reset moved `edge` back —
  // exactly the tampered commit this assertion is about (edge@{0} is the
  // post-undo tip, i.e. origin/main's bootstrap tip). Its path set must equal
  // the manifest's ship+reset paths MINUS any reset destination the overlay
  // clone's own shipped .gitignore excludes from `git add -A` (e.g.
  // `.claude/settings.json`, deliberately untracked since T-529 — see
  // publish-manifest.json's reset_reasons; that exclusion is pre-existing
  // pipeline behavior, not something this gate changes, and computed HERE
  // via `git check-ignore` rather than assumed/hardcoded) — proving the
  // tamper added/removed nothing beyond that already-documented residual.
  const manifest = JSON.parse(fs.readFileSync(path.join(cloneRepoDir, 'scripts', 'publish-manifest.json'), 'utf8'));
  const allManifestPaths = [...manifest.ship, ...Object.keys(manifest.reset)];
  const isGitIgnoredInClone = (relPath) => spawnSync('git', ['check-ignore', '-q', relPath], { cwd: cloneDirTarget }).status === 0;
  const expectedCommittedPaths = allManifestPaths.filter((p) => !isGitIgnoredInClone(p)).sort();
  const committedPaths = git(cloneDirTarget, ['ls-tree', '-r', '--name-only', 'edge@{1}'])
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepStrictEqual(
    committedPaths,
    expectedCommittedPaths,
    'Test 30b FAIL: expected the committed (pre-abort, reflog-anchored via edge@{1}) tree\'s path SET to equal ' +
      "the manifest's ship+reset paths minus any gitignored-in-the-clone reset destinations exactly (path set " +
      `preserved by the tamper) — got ${committedPaths.length} committed path(s) vs ${expectedCommittedPaths.length} expected`
  );
  assert.ok(
    committedPaths.includes(TAMPER_PATH),
    `Test 30b FAIL: expected the tampered path "${TAMPER_PATH}" to still be present (a content-only change), ` +
      `got paths: ${committedPaths.slice(0, 5).join(', ')}...`
  );

  // T-534 round 2 (criterion 5): 'edge' ITSELF (edge@{0}, post-undo) must be
  // back at origin/main's tip — 0 commits ahead, since the tampered commit
  // was undone.
  const edgeSha = git(cloneDirTarget, ['rev-parse', 'edge']).trim();
  const originMainSha = git(cloneDirTarget, ['rev-parse', 'origin/main']).trim();
  assert.strictEqual(
    edgeSha,
    originMainSha,
    "Test 30b FAIL: expected local 'edge' to be reset back to origin/main's tip (0 ahead) post-abort, got " +
      `edge=${edgeSha} origin/main=${originMainSha}`
  );

  console.log(
    `Test 30b passed: the tamper preserves the path set exactly (the committed, pre-abort tree's ` +
      `${committedPaths.length}-path set, re-anchored via edge@{1} in the reflog, matches the manifest's ` +
      "ship+reset paths minus gitignored-in-clone reset destinations, unchanged), the refusal names a CONTENT " +
      "mismatch, never a missing/extra path, and 'edge' itself is back at 0-ahead (the tampered commit was undone)"
  );
}

// ---------------------------------------------------------------------------
// Test 30c (AC3) — a clean run (no tamper) pushes, and the pushed 'edge' tree
// matches HEAD blobs one-to-one for every ship path, and the mapped
// templates/ starter's HEAD blob for every reset destination — mechanizing
// the blob-level check the earlier orchestrator QA performed manually.
//
// Paired with test-publish-verify-provenance.js's own direct unit-level kill
// (its Test 10) for the "compare the assembled tree against itself" mutant:
// a black-box CLEAN run cannot itself discriminate that specific bug, since
// with no tamper present the assembler already produces byte-correct output
// regardless of whether the verifier's internal comparison target is HEAD
// (correct) or the assembled tree itself (a hollow self-compare) — both
// produce the SAME pushed bytes when nothing is wrong. The unit-level test
// constructs the deliberately-mismatched scenario needed to actually
// distinguish the two implementations; THIS case instead proves the real
// pipeline's OUTPUT is byte-correct end to end, independent of the
// verifier's own internal logic — the property the task's evidence needs
// demonstrated against a genuine push, not just a synthetic fixture.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534c-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534c-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t534c-parent-'), 'clone-dir-target');

  const nameA = 'zzzT534' + 'ProvenanceGateCharlie' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    result.status,
    0,
    `Test 30c FAIL: expected a clean run to exit 0, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Content-provenance check GREEN/.test(result.stdout),
    `Test 30c FAIL: expected the content-provenance GREEN confirmation in stdout, got: ${result.stdout}`
  );

  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.ok(/refs\/heads\/edge/.test(refsAfter), `Test 30c FAIL: expected 'edge' to have been pushed, got refs: ${refsAfter}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(cloneRepoDir, 'scripts', 'publish-manifest.json'), 'utf8'));

  function mirrorBlob(relPath) {
    return execFileSync('git', ['--git-dir', bareMirror, 'show', `edge:${relPath}`]);
  }
  function sourceHeadBlob(relPath) {
    return execFileSync('git', ['show', `HEAD:${relPath}`], { cwd: cloneRepoDir });
  }
  // Same residual as Test 30b: a reset destination gitignored in the shipped
  // tree itself (e.g. `.claude/settings.json`, T-529) never gets committed
  // to the mirror at all — pre-existing pipeline behavior, not something
  // this gate touches. Computed dynamically, never hardcoded.
  const isGitIgnoredInClone = (relPath) => spawnSync('git', ['check-ignore', '-q', relPath], { cwd: cloneDirTarget }).status === 0;

  let checkedShip = 0;
  for (const shipPath of manifest.ship) {
    const pushed = mirrorBlob(shipPath);
    const head = sourceHeadBlob(shipPath);
    assert.ok(
      pushed.equals(head),
      `Test 30c FAIL: pushed ship path "${shipPath}" does not byte-match the source repo's HEAD blob for that path`
    );
    checkedShip++;
  }

  let checkedReset = 0;
  let skippedGitignoredReset = 0;
  for (const destPath of Object.keys(manifest.reset)) {
    const starterPath = manifest.reset[destPath];
    const starterHead = sourceHeadBlob(starterPath);
    if (isGitIgnoredInClone(destPath)) {
      // Never reaches the mirror commit (gitignored in the shipped tree) —
      // instead confirm the overlay itself placed the correct starter bytes
      // on disk in the clone, the only verifiable trace of it post-push.
      const onDisk = fs.readFileSync(path.join(cloneDirTarget, destPath));
      assert.ok(
        onDisk.equals(starterHead),
        `Test 30c FAIL: gitignored-in-clone reset destination "${destPath}" was not overlaid with its ` +
          "mapped starter's bytes on disk"
      );
      skippedGitignoredReset++;
      continue;
    }
    const pushed = mirrorBlob(destPath);
    assert.ok(
      pushed.equals(starterHead),
      `Test 30c FAIL: pushed reset destination "${destPath}" does not byte-match its mapped starter ` +
        `"${starterPath}"'s HEAD blob`
    );
    checkedReset++;
  }

  console.log(
    `Test 30c passed: a clean run pushes, and the pushed 'edge' tree matches HEAD blobs one-to-one for all ` +
      `${checkedShip} ship path(s), and starter blobs for all ${checkedReset} pushed reset destination(s)` +
      (skippedGitignoredReset
        ? ` (${skippedGitignoredReset} reset destination(s) gitignored-in-clone verified on disk instead, ` +
          'per the T-529 residual)'
        : '')
  );
}

// ---------------------------------------------------------------------------
// T-534 ROUND 3 — Test 30d (criterion 3's e2e leg, the ONE round-2 residual):
// a post-scan planted UNDECLARED extra file (an ADDITION, never a content
// tamper) aborts the build naming the planted path and the completeness
// sweep's own class wording, with the mirror untouched and local 'edge'
// undone back to 0-ahead. Cloned from Test 30a's harness (same fixture
// builder, same local bare mirror, never a real remote) but exercising the
// DIFFERENT test-only seam (MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH, see
// applyTestOnlyProvenanceExtraFileSeam()'s own comment in
// mavp-publish-build.js) that ADDS a path the manifest never declared,
// rather than mutating a declared one in place.
//
// THIS TEST EXISTS BECAUSE OF 4a35fe8: the T-534 round 2 developer initially
// claimed Test 30a alone killed the stepVerifyProvenance() invocation
// deletion, then HONESTLY CORRECTED that claim at commit 4a35fe8 on
// discovering step 6.6 (stepVerifyCommittedProvenance) independently refuses
// the identical BYTE tamper — so 30a's mutant-kill is genuinely
// overlapping/redundant with 6.6 for that tamper class. For an ADDITION,
// by contrast, no such overlap exists: every gate that runs BEFORE the seam
// (assembler set-equality, assertAssembledTreeNonTrivial, stepScan) is
// structurally blind to a planted extra path with no matching secret shape;
// every overlay refusal is deletion-shaped ("additions cannot dilute them" —
// the overlay's own comment); stepCommit()'s message gate scans only the
// message, and its tree=<sha> trailer is self-consistent with the tampered
// tree by construction; step 6.6 iterates DECLARED ship/reset paths only and
// was deliberately given no clone-side set-equality (criterion 4's own
// recorded residual); and stepPush()'s range walk checks markers and
// messages, never content. So with the sweep OR its invocation deleted, a
// planted undeclared file ships to the mirror at exit 0 — this test (and
// only this test) can see that. Both live mutant kills, including the
// "Test 30a still passes under the step-6.5-invocation-deletion mutant"
// observation that confirms 30d is that mutant's UNIQUE killer, are quoted
// in this task's evidence (run once each, reverted immediately, never
// committed).
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534d-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534d-');
  const cloneDirTarget = path.join(mkTempDir('mavp-build-t534d-parent-'), 'clone-dir-target');

  const nameA = 'zzzT534' + 'ProvenanceGateDelta' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  // Undeclared in the fixture's real committed manifest (neither a ship
  // entry nor a reset destination) — verified at authoring time via
  // scripts/publish-manifest.json; collides with no fixture ship or reset
  // path, so the completeness sweep sees it as a pure, unambiguous addition.
  const EXTRA_PATH = 'EXTRA-T534D-UNDECLARED.txt';

  const refsBefore = gitShowRefOrEmpty(bareMirror);

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH: EXTRA_PATH } }
  );

  // (a) non-zero exit.
  assert.notStrictEqual(
    result.status,
    0,
    `Test 30d FAIL: expected non-zero exit on a planted undeclared extra file, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );

  // (b) proof the seam actually fired — a silently-inert seam must be a
  // regression, never a silent pass.
  assert.ok(
    result.stdout.includes('[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH set'),
    `Test 30d setup FAIL: expected proof the extra-file seam actually fired, got stdout:\n${result.stdout}`
  );

  // (c) stderr names the planted path AND matches the sweep's own class
  // wording for an undeclared path — the ADDITION-vs-content-mismatch class
  // discriminator, in the same spirit as Test 30b's right-class assertion.
  assert.ok(
    result.stderr.includes(`"${EXTRA_PATH}"`),
    `Test 30d FAIL: expected the planted path "${EXTRA_PATH}" named in the abort, got: ${result.stderr}`
  );
  assert.ok(
    /is not declared in ship or reset — an unexpected addition after assembly/.test(result.stderr),
    `Test 30d FAIL: expected the completeness sweep's own "unexpected addition after assembly" class wording, got: ${result.stderr}`
  );
  assert.ok(
    !/do not match the private repo's HEAD blob/.test(result.stderr),
    `Test 30d FAIL: this must be reported as an ADDITION, never a content mismatch, got: ${result.stderr}`
  );

  // (d) the standard abort footer.
  assert.ok(/no push has occurred/.test(result.stderr), 'Test 30d FAIL: expected the standard abort footer');

  // (e) mirror refs byte-identical before vs after the aborted run (nothing
  // pushed) — the exact 30a pattern.
  const refsAfter = gitShowRefOrEmpty(bareMirror);
  assert.strictEqual(
    refsAfter,
    refsBefore,
    'Test 30d FAIL: mirror refs must be byte-identical before and after the aborted run (nothing pushed) — ' +
      `before:\n${refsBefore}\nafter:\n${refsAfter}`
  );

  // (f) local 'edge' 0 ahead of origin post-abort — the 30a/30b rev-list
  // pattern, exercising undo-on-refusal for the ADDITION class, which was
  // previously demonstrated only for byte tampers.
  const edgeSha = git(cloneDirTarget, ['rev-parse', 'edge']).trim();
  const originMainSha = git(cloneDirTarget, ['rev-parse', 'origin/main']).trim();
  assert.strictEqual(
    edgeSha,
    originMainSha,
    "Test 30d FAIL: expected local 'edge' to be reset back to origin/main's tip (0 ahead) post-abort — the " +
      `commit this run made must be undone, got edge=${edgeSha} origin/main=${originMainSha}`
  );

  console.log(
    `Test 30d passed: a post-scan planted UNDECLARED extra file (path "${EXTRA_PATH}") aborts the build ` +
      "naming that exact path and the sweep's own \"unexpected addition after assembly\" class wording, " +
      "with the mirror refs byte-identical before and after (nothing pushed) and local 'edge' reset back to " +
      '0-ahead (the commit this run made was undone)'
  );
}

// ---------------------------------------------------------------------------
// T-534 ROUND 2 — Test 31 (criterion 6, e2e control): a mirror CLONE carrying
// repo-local core.autocrlf=true publishes at exit 0 with the CRLF canary's
// pushed blob byte-equal to source HEAD. Proves the `-c core.autocrlf=false
// -c core.safecrlf=false` pin on stepCommit()'s `git add -A` call site
// outranks a repo-local core.autocrlf, so the canary's CRLF bytes survive
// the clone's own add/commit unchanged — the PREVENTION half of the T-534
// round 2 MEDIUM fix. Also exercises step 6.6 (committed-tree certification)
// passing GREEN on a real pipeline run, not just a synthetic fixture.
//
// The mutant that drops this pin (leaving step 6.6 wired) is killed by THIS
// SAME fixture: without the pin, `git add -A` inside the core.autocrlf=true
// clone normalizes the canary's CRLF to LF, and step 6.6 (which reads the
// ACTUAL committed blob, unlike step 6.5's tempOutDir-only comparison)
// refuses, naming the canary path. That mutant, and the further mutant that
// ALSO deletes step 6.6's invocation (at which point the normalized canary
// would ship undetected), were both run live against a real bare mirror and
// reverted before this commit — see this task's evidence for the exact
// exit codes and refusal text observed for each.
// ---------------------------------------------------------------------------
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534r2-crlf-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534r2-crlf-');

  const nameA = 'zzzT534' + 'Round2CrlfCanary' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  // Pre-create the mirror clone with repo-local core.autocrlf=true — the
  // exact "future operator machine" shape the round-1 MEDIUM described.
  // stepCloneOrPull() reuses an existing, clean, correctly-origined clone
  // dir rather than cloning fresh, so this config survives into the run.
  const cloneParent = mkTempDir('mavp-build-t534r2-crlf-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');
  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'core.autocrlf', 'true']);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);

  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    result.status,
    0,
    `Test 31 FAIL: expected a clean run through a core.autocrlf=true clone to exit 0 (the add-site pin must ` +
      `prevent normalization), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 31 FAIL: expected the step 6.6 GREEN confirmation in stdout, got: ${result.stdout}`
  );

  const canaryPushed = execFileSync('git', ['--git-dir', bareMirror, 'show', 'edge:scripts/publish-crlf-canary.txt']);
  const canarySourceHead = execFileSync('git', ['show', 'HEAD:scripts/publish-crlf-canary.txt'], { cwd: cloneRepoDir });
  assert.ok(
    canaryPushed.equals(canarySourceHead),
    'Test 31 FAIL: expected the CRLF canary\'s pushed blob to be byte-identical to source HEAD (CRLF preserved) ' +
      'through a core.autocrlf=true clone'
  );
  assert.ok(
    canaryPushed.includes(Buffer.from('\r\n')),
    'Test 31 FAIL: expected the pushed canary blob to still contain CRLF bytes (not normalized away)'
  );

  console.log(
    "Test 31 passed: a mirror clone with repo-local core.autocrlf=true publishes at exit 0, step 6.6 reports " +
      "GREEN, and the CRLF canary's pushed blob is byte-identical to source HEAD (CRLF preserved through the " +
      "add-site pin)"
  );
}

// ---------------------------------------------------------------------------
// T-534 ROUND 4 — security review round 2 closed two findings, both on the
// `git add -A` call site in stepCommit(): MODE BINDING (Tests 32-35, M1-M4)
// and the ATTRIBUTES PIN (Tests 36-38, A1-A4). See mavp-publish-build.js's
// own MODE BINDING / ATTRIBUTES PIN comments above stepCommit() for the full
// rationale, the architect's rejection of the reviewer's proposed
// `-c core.fileMode=true` fix, and why both orderings are load-bearing.
// ---------------------------------------------------------------------------

// Test 32 (M1) — MODE BINDING, +x direction: a clone with repo-local
// core.fileMode=false; the private fixture flips a ship path 644->755
// (content byte-for-byte unchanged); the clone's on-disk file is force-set
// back to 644 via MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE right after the
// overlay writes it (decoupling disk from the correct target — see that
// seam's own comment for why this decoupling cannot be produced naturally on
// this platform, where fs.copyFileSync faithfully propagates the source
// mode). Publish succeeds and `git ls-tree HEAD` in the clone shows 100755
// despite disk staying at 644 — proving the bound mode came from HEAD
// (git-to-git), never from a disk read.
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534m1-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534m1-');
  const cloneParent = mkTempDir('mavp-build-t534m1-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');

  const nameA = 'zzzT534' + 'ModeBindAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const SHIP_PATH = 'NOTICE';

  // Pre-create the clone (Test 31 pattern) with repo-local core.fileMode=false
  // — the exact scenario the finding describes (network-mounted/Windows-
  // backed checkouts commonly carry this setting).
  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'core.fileMode', 'false']);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);

  // Baseline publish: SHIP_PATH commits at its real HEAD mode (100644).
  const baselineResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    baselineResult.status,
    0,
    `Test 32 FAIL (baseline): expected exit 0, got ${baselineResult.status}:\n${baselineResult.stdout}\n${baselineResult.stderr}`
  );
  const baselineMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(baselineMode, '100644', `Test 32 FAIL (baseline): expected "${SHIP_PATH}" committed at 100644, got ${baselineMode}`);

  // Flip SHIP_PATH to executable in the PRIVATE fixture repo — an honest
  // chmod +x, content unchanged.
  fs.chmodSync(path.join(cloneRepoDir, SHIP_PATH), 0o755);
  git(cloneRepoDir, ['add', SHIP_PATH]);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: flip NOTICE to executable (T-534 round 4, M1)']);
  const fixtureMode = git(cloneRepoDir, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(fixtureMode, '100755', `Test 32 FAIL: fixture assumption broken — expected the private repo HEAD mode to now be 100755, got ${fixtureMode}`);

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE: `${SHIP_PATH}=644` } }
  );
  assert.strictEqual(
    result.status,
    0,
    `Test 32 FAIL: expected exit 0 (an honest mode-only flip must publish cleanly), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    result.stdout.includes('[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE set'),
    `Test 32 setup FAIL: expected proof the force-disk-mode seam fired, got stdout:\n${result.stdout}`
  );
  assert.ok(
    /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 32 FAIL: expected step 6.6 GREEN, got: ${result.stdout}`
  );

  const diskModeOctal = (fs.statSync(path.join(cloneDirTarget, SHIP_PATH)).mode & 0o777).toString(8);
  assert.strictEqual(
    diskModeOctal,
    '644',
    `Test 32 FAIL: expected the clone's on-disk "${SHIP_PATH}" mode to remain 644 (the seam-forced, ` +
      `DECOUPLED value) post-publish, got ${diskModeOctal}`
  );

  const committedMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    committedMode,
    '100755',
    'Test 32 FAIL: THE FIX — expected the clone\'s committed git-tree mode to be bound to the private repo\'s ' +
      `new HEAD mode (100755) despite disk staying at 644 and core.fileMode=false, got ${committedMode}`
  );

  console.log(
    `Test 32 passed (M1, mode binding +x): a core.fileMode=false clone with "${SHIP_PATH}" flipped 644->755 ` +
      'in the private repo, and the clone\'s own disk mode forced back to 644, still commits at 100755 — the ' +
      'bound mode came from HEAD (git-to-git), never a disk read'
  );
}

// Test 33 (M2) — MODE BINDING, -x direction: the reverse flip (755->644) on
// an already-executable ship path (scripts/mavp-operator), with the clone's
// disk file force-held at 755 (the opposite decoupling from Test 32),
// proving the binding pass is direction-complete and kills a +x/-x swap.
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534m2-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534m2-');
  const cloneParent = mkTempDir('mavp-build-t534m2-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');

  const nameA = 'zzzT534' + 'ModeBindBravo' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const SHIP_PATH = 'scripts/mavp-operator';

  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'core.fileMode', 'false']);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);

  const baselineResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    baselineResult.status,
    0,
    `Test 33 FAIL (baseline): expected exit 0, got ${baselineResult.status}:\n${baselineResult.stdout}\n${baselineResult.stderr}`
  );
  const baselineMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(baselineMode, '100755', `Test 33 FAIL (baseline): expected "${SHIP_PATH}" committed at 100755, got ${baselineMode}`);

  // Flip SHIP_PATH to non-executable in the PRIVATE fixture repo — content
  // unchanged, the opposite direction from Test 32.
  fs.chmodSync(path.join(cloneRepoDir, SHIP_PATH), 0o644);
  git(cloneRepoDir, ['add', SHIP_PATH]);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: flip mavp-operator to non-executable (T-534 round 4, M2)']);
  const fixtureMode = git(cloneRepoDir, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(fixtureMode, '100644', `Test 33 FAIL: fixture assumption broken — expected the private repo HEAD mode to now be 100644, got ${fixtureMode}`);

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE: `${SHIP_PATH}=755` } }
  );
  assert.strictEqual(
    result.status,
    0,
    `Test 33 FAIL: expected exit 0, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    result.stdout.includes('[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE set'),
    `Test 33 setup FAIL: expected proof the force-disk-mode seam fired, got stdout:\n${result.stdout}`
  );

  const diskModeOctal = (fs.statSync(path.join(cloneDirTarget, SHIP_PATH)).mode & 0o777).toString(8);
  assert.strictEqual(
    diskModeOctal,
    '755',
    `Test 33 FAIL: expected the clone's on-disk "${SHIP_PATH}" mode to remain 755 (the seam-forced, ` +
      `DECOUPLED value) post-publish, got ${diskModeOctal}`
  );

  const committedMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    committedMode,
    '100644',
    'Test 33 FAIL: THE FIX — expected the clone\'s committed git-tree mode to be bound to the private repo\'s ' +
      `new HEAD mode (100644) despite disk staying at 755, got ${committedMode}`
  );

  console.log(
    `Test 33 passed (M2, mode binding -x): direction-complete with Test 32 — "${SHIP_PATH}" flipped 755->644 ` +
      'in the private repo, disk forced to stay at 755, still commits at 100644'
  );
}

// Test 34 (M3) — a mode-ONLY publish (zero byte changes anywhere) still
// commits, step 6.6 reports GREEN, and the committed mode equals the new
// HEAD mode. This is the ordering killer: if binding ran AFTER
// hasStagedChanges()'s early return, this exact scenario would print "No
// changes staged after overlay" and commitResult.committed would be false,
// leaving the STALE mode committed and step 6.6 refusing against it (the
// original bug this whole criterion fixes).
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534m3-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534m3-');
  const cloneParent = mkTempDir('mavp-build-t534m3-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');

  const nameA = 'zzzT534' + 'ModeBindCharlie' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const SHIP_PATH = 'NOTICE';

  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'core.fileMode', 'false']);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);

  const baselineResult = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(baselineResult.status, 0, `Test 34 FAIL (baseline): expected exit 0, got ${baselineResult.status}:\n${baselineResult.stderr}`);

  fs.chmodSync(path.join(cloneRepoDir, SHIP_PATH), 0o755);
  git(cloneRepoDir, ['add', SHIP_PATH]);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: mode-only flip, zero byte changes (T-534 round 4, M3)']);

  // No force-disk-mode seam this time — a genuinely natural, unmodified run.
  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    result.status,
    0,
    `Test 34 FAIL: expected exit 0, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    !/No changes staged after overlay/.test(result.stdout),
    `Test 34 FAIL: THE ORDERING BUG — a mode-only publish reported nothing staged, meaning the mode-binding ` +
      `pass never ran before the early return, got stdout:\n${result.stdout}`
  );
  assert.ok(
    /Committed .* on 'edge'/.test(result.stdout),
    `Test 34 FAIL: expected stepCommit() to report a real commit for this mode-only publish, got: ${result.stdout}`
  );
  assert.ok(
    /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 34 FAIL: expected step 6.6 GREEN, got: ${result.stdout}`
  );

  const committedMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', SHIP_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    committedMode,
    '100755',
    `Test 34 FAIL: expected the mode-only publish's committed mode to equal the new HEAD mode (100755), got ${committedMode}`
  );

  console.log(
    'Test 34 passed (M3, mode-only publish): a publish with zero byte changes anywhere still commits (binding ' +
      "ran before hasStagedChanges()'s early return), step 6.6 is GREEN, and the committed mode equals the new HEAD mode"
  );
}

// Test 35 (M4, unit) — resolveChmodFlagForHeadMode() refuses on any
// unexpected or unreadable HEAD mode, with a named message (kills removing
// the fail-closed arm), and correctly maps the two bindable regular-file
// modes plus the symlink skip.
{
  const { resolveChmodFlagForHeadMode } = require('./mavp-publish-build.js');

  assert.deepStrictEqual(
    resolveChmodFlagForHeadMode('100755'),
    { ok: true, flag: '+x' },
    'Test 35 FAIL: expected 100755 to resolve to the +x chmod flag'
  );
  assert.deepStrictEqual(
    resolveChmodFlagForHeadMode('100644'),
    { ok: true, flag: '-x' },
    'Test 35 FAIL: expected 100644 to resolve to the -x chmod flag'
  );
  assert.deepStrictEqual(
    resolveChmodFlagForHeadMode('120000'),
    { ok: true, skip: true },
    'Test 35 FAIL: expected 120000 (symlink) to resolve to a skip'
  );

  const unexpectedModes = ['040000', '160000', '100000', 'garbage', ''];
  for (const mode of unexpectedModes) {
    const result = resolveChmodFlagForHeadMode(mode);
    assert.strictEqual(result.ok, false, `Test 35 FAIL (mode "${mode}"): expected a refusal, got: ${JSON.stringify(result)}`);
    assert.ok(
      /unexpected git-tree mode/.test(result.reason),
      `Test 35 FAIL (mode "${mode}"): expected a named "unexpected git-tree mode" refusal reason, got: ${result.reason}`
    );
  }

  console.log(
    'Test 35 passed (M4, unit): resolveChmodFlagForHeadMode() maps 100755/100644/120000 correctly and refuses ' +
      `${unexpectedModes.length} unexpected/unreadable modes with a named message`
  );
}

// Test 36 (A1 + A4) — a hostile `<clone>/$GIT_DIR/info/attributes` (an
// untracked, never-committed file — the vector that matters most, since it
// is invisible to every shipped-file check) is pre-planted BEFORE the
// publish runs. The production pin must overwrite it before `git add -A`;
// publish succeeds and the CRLF canary's blob in the clone still contains
// real CRLF bytes (A1, kills removing the write). A4 (same run): the fix
// must OWN `$GIT_DIR/info/attributes`, never write an in-tree
// `.gitattributes` file instead — `git ls-tree -r HEAD --name-only` in the
// clone must contain no `.gitattributes` entry.
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534a1-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534a1-');
  const cloneParent = mkTempDir('mavp-build-t534a1-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');

  const nameA = 'zzzT534' + 'AttrPinAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';

  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);

  // Pre-plant the hostile, untracked attributes file — a text-auto rule that
  // would normalize the CRLF canary if it survives to `git add -A`.
  const hostileAttributesPath = path.join(cloneDirTarget, '.git', 'info', 'attributes');
  fs.mkdirSync(path.dirname(hostileAttributesPath), { recursive: true });
  const HOSTILE_TEXT_AUTO_RULE = ['*', 'text=auto'].join(' ') + '\n';
  fs.writeFileSync(hostileAttributesPath, HOSTILE_TEXT_AUTO_RULE);

  const result = runBuildCli(cloneRepoDir, [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`]);
  assert.strictEqual(
    result.status,
    0,
    `Test 36 FAIL: expected exit 0, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 36 FAIL: expected step 6.6 GREEN, got: ${result.stdout}`
  );

  const canaryPushed = execFileSync('git', ['--git-dir', bareMirror, 'show', 'edge:scripts/publish-crlf-canary.txt']);
  assert.ok(
    canaryPushed.includes(Buffer.from('\r\n')),
    "Test 36 FAIL (A1): expected the CRLF canary's pushed blob to still contain CRLF bytes despite a " +
      'pre-planted hostile untracked attributes file — the pin must have overwritten it before `git add -A`'
  );

  // A4 — no in-tree .gitattributes was committed.
  const committedPaths = git(cloneDirTarget, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  assert.ok(
    !committedPaths.includes('.gitattributes'),
    'Test 36 FAIL (A4): expected no in-tree .gitattributes to have been committed — the pin must own ' +
      `$GIT_DIR/info/attributes, never an in-tree file, got committed paths including: ` +
      `${committedPaths.filter((p) => p.includes('gitattributes')).join(', ')}`
  );

  // Confirm the untracked file itself now holds exactly the pipeline-owned pin.
  const { CLONE_OWNED_GIT_ATTRIBUTES_CONTENT } = require('./mavp-publish-build.js');
  const finalAttributes = fs.readFileSync(hostileAttributesPath, 'utf8');
  assert.strictEqual(
    finalAttributes,
    CLONE_OWNED_GIT_ATTRIBUTES_CONTENT,
    `Test 36 FAIL: expected $GIT_DIR/info/attributes to hold exactly the pipeline-owned pin, got: ${JSON.stringify(finalAttributes)}`
  );

  console.log(
    'Test 36 passed (A1 + A4): a pre-planted hostile untracked $GIT_DIR/info/attributes file is overwritten ' +
      "before `git add -A` — the CRLF canary survives and no in-tree .gitattributes was ever committed"
  );
}

// Test 37 (A2, unit) — a scratch repo with a worktree `.gitattributes`
// carrying a text-auto rule PLUS the exact pin (via the real, exported
// pinCloneGitAttributesOrAbort()) keeps CRLF bytes, with an anti-vacuity
// CONTROL (same repo shape, no pin call) that actually normalizes to LF —
// proving the repro is genuine and kills both a missing `-text` and a
// wrong-precedence write (writing anywhere but the highest-precedence
// source would leave this control-vs-pinned pair identical).
{
  const { pinCloneGitAttributesOrAbort } = require('./mavp-publish-build.js');
  const CRLF_CONTENT = Buffer.from('line one\r\nline two\r\n');

  function setupTextAutoRepo(dir) {
    execFileSync('git', ['init', '-q', dir]);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    git(dir, ['config', 'user.name', 'Fixture User']);
    writeFile(path.join(dir, '.gitattributes'), ['*', 'text=auto'].join(' ') + '\n');
    fs.writeFileSync(path.join(dir, 'crlf.txt'), CRLF_CONTENT);
  }

  // Anti-vacuity control: no pin call — the in-tree text=auto rule must
  // actually fire and normalize CRLF to LF, or this repro proves nothing.
  const controlDir = mkTempDir('mavp-build-t534a2-control-');
  setupTextAutoRepo(controlDir);
  git(controlDir, ['add', '-A']);
  git(controlDir, ['commit', '-q', '-m', 'control: no attributes pin']);
  const controlBlob = execFileSync('git', ['show', 'HEAD:crlf.txt'], { cwd: controlDir });
  assert.ok(
    !controlBlob.includes(Buffer.from('\r\n')),
    'Test 37 FAIL (control setup): expected the CONTROL (no pin) to actually normalize CRLF to LF via the ' +
      'in-tree text=auto rule — if it does not, this repro is not exercising attribute-driven normalization at all'
  );

  // Pinned: pinCloneGitAttributesOrAbort() called before `git add -A`.
  const pinnedDir = mkTempDir('mavp-build-t534a2-pinned-');
  setupTextAutoRepo(pinnedDir);
  pinCloneGitAttributesOrAbort(pinnedDir);
  git(pinnedDir, ['add', '-A']);
  git(pinnedDir, ['commit', '-q', '-m', 'pinned: with attributes pin']);
  const pinnedBlob = execFileSync('git', ['show', 'HEAD:crlf.txt'], { cwd: pinnedDir });
  assert.ok(
    pinnedBlob.equals(CRLF_CONTENT),
    'Test 37 FAIL: expected CRLF preserved byte-for-byte with the attributes pin active, despite an in-tree ' +
      `text=auto rule, got: ${JSON.stringify(pinnedBlob.toString('latin1'))}`
  );

  console.log(
    'Test 37 passed (A2, unit): a worktree text=auto rule normalizes CRLF to LF without the pin (control), ' +
      'and preserves it byte-for-byte with the real pinCloneGitAttributesOrAbort() called first'
  );
}

// Test 38 (A3, unit) — a `filter=` attribute wired to a configured CLEAN
// command that visibly rewrites bytes: with the pin, the staged blob is
// byte-identical to disk (the clean filter never fires); a CONTROL (same
// repo shape, no pin) shows the rewrite, proving the repro is genuine and
// killing a pin missing `-filter`.
{
  const { pinCloneGitAttributesOrAbort } = require('./mavp-publish-build.js');
  const ORIGINAL_CONTENT = Buffer.from('hello world\n');

  function setupFilterRepo(dir) {
    execFileSync('git', ['init', '-q', dir]);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    git(dir, ['config', 'user.name', 'Fixture User']);
    // A clean filter that visibly rewrites bytes — deterministic, no
    // external dependency beyond a POSIX shell utility.
    git(dir, ['config', 'filter.uppercaseTest.clean', "tr 'a-z' 'A-Z'"]);
    git(dir, ['config', 'filter.uppercaseTest.smudge', 'cat']);
    writeFile(path.join(dir, '.gitattributes'), '* filter=uppercaseTest\n');
    fs.writeFileSync(path.join(dir, 'lower.txt'), ORIGINAL_CONTENT);
  }

  // Anti-vacuity control: no pin — the clean filter must actually rewrite
  // bytes, or this repro proves nothing.
  const controlDir = mkTempDir('mavp-build-t534a3-control-');
  setupFilterRepo(controlDir);
  git(controlDir, ['add', '-A']);
  git(controlDir, ['commit', '-q', '-m', 'control: no attributes pin']);
  const controlStaged = execFileSync('git', ['show', 'HEAD:lower.txt'], { cwd: controlDir });
  assert.ok(
    !controlStaged.equals(ORIGINAL_CONTENT),
    'Test 38 FAIL (control setup): expected the CONTROL (no pin) to actually rewrite bytes via the configured ' +
      'clean filter — if not, this repro is not exercising a clean filter at all'
  );

  const pinnedDir = mkTempDir('mavp-build-t534a3-pinned-');
  setupFilterRepo(pinnedDir);
  pinCloneGitAttributesOrAbort(pinnedDir);
  git(pinnedDir, ['add', '-A']);
  git(pinnedDir, ['commit', '-q', '-m', 'pinned: with attributes pin']);
  const pinnedStaged = execFileSync('git', ['show', 'HEAD:lower.txt'], { cwd: pinnedDir });
  assert.ok(
    pinnedStaged.equals(ORIGINAL_CONTENT),
    'Test 38 FAIL: expected the staged blob to be byte-identical to disk (the clean filter must never fire) ' +
      `with the attributes pin active, got: ${JSON.stringify(pinnedStaged.toString('latin1'))}`
  );

  console.log(
    'Test 38 passed (A3, unit): a configured clean filter visibly rewrites bytes without the pin (control), ' +
      'and never fires (staged blob byte-identical to disk) with the real pinCloneGitAttributesOrAbort() called first'
  );
}

// Test 39 (T-534 round 5, criterion 7 — the `-ident` RECLASSIFICATION): a
// worktree `* ident` attribute collapses a pre-expanded `$Id: <hex> $`
// marker back to `$Id$` at `git add -A` — a CLEAN-direction rewrite
// independent of text/eol/filter, NOT a "subsumed rider" as the old comment
// claimed. Control (no pin) actually collapses it, proving the repro is
// genuine; pinned (the real pinCloneGitAttributesOrAbort() called first, an
// `* -text -eol -filter -ident` line) preserves the marker byte-for-byte,
// since `-ident` in the pipeline-owned, highest-precedence
// `$GIT_DIR/info/attributes` outranks the in-tree `* ident` rule. Named
// mutant: deleting `-ident` from CLONE_OWNED_GIT_ATTRIBUTES_CONTENT turns
// this red (the in-tree `ident` attribute would then be unopposed, so the
// pinned run would ALSO collapse the marker — see the report's live
// mutant-kill quote).
{
  const { pinCloneGitAttributesOrAbort } = require('./mavp-publish-build.js');
  // A literal git ident marker — not a secret/credential shape, just the
  // documented `$Id: <40-hex> $` form git itself expands/collapses.
  const PRE_EXPANDED_MARKER = Buffer.from('$Id: ' + '0123456789abcdef0123456789abcdef01234567' + ' $\n');

  function setupIdentRepo(dir) {
    execFileSync('git', ['init', '-q', dir]);
    git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    git(dir, ['config', 'user.name', 'Fixture User']);
    writeFile(path.join(dir, '.gitattributes'), '* ident\n');
    fs.writeFileSync(path.join(dir, 'ident.txt'), PRE_EXPANDED_MARKER);
  }

  // Anti-vacuity control: no pin — the in-tree ident attribute must
  // actually collapse the marker, or this repro proves nothing.
  const controlDir = mkTempDir('mavp-build-t534id-control-');
  setupIdentRepo(controlDir);
  git(controlDir, ['add', '-A']);
  git(controlDir, ['commit', '-q', '-m', 'control: no attributes pin']);
  const controlStaged = execFileSync('git', ['show', 'HEAD:ident.txt'], { cwd: controlDir });
  assert.ok(
    !controlStaged.equals(PRE_EXPANDED_MARKER),
    'Test 39 FAIL (control setup): expected the CONTROL (no pin) to actually collapse the pre-expanded $Id$ ' +
      'marker via the in-tree ident attribute — if not, this repro is not exercising ident conversion at all'
  );

  const pinnedDir = mkTempDir('mavp-build-t534id-pinned-');
  setupIdentRepo(pinnedDir);
  pinCloneGitAttributesOrAbort(pinnedDir);
  git(pinnedDir, ['add', '-A']);
  git(pinnedDir, ['commit', '-q', '-m', 'pinned: with attributes pin']);
  const pinnedStaged = execFileSync('git', ['show', 'HEAD:ident.txt'], { cwd: pinnedDir });
  assert.ok(
    pinnedStaged.equals(PRE_EXPANDED_MARKER),
    'Test 39 FAIL: expected the pre-expanded $Id$ marker preserved byte-for-byte with the attributes pin ' +
      `active, got: ${JSON.stringify(pinnedStaged.toString('latin1'))}`
  );

  console.log(
    'Test 39 passed (round 5, criterion 7 — ident reclassification): a worktree ident attribute collapses a ' +
      'pre-expanded $Id$ marker without the pin (control), and preserves it byte-for-byte with the real ' +
      'pinCloneGitAttributesOrAbort() called first'
  );
}

// Test 40 (T-534 round 5, criteria 5+6 — BINDER RE-KEY e2e, folding the
// false-refusal controls): a real pipeline publish where the PERSISTENT
// clone already TRACKS a reset destination (.claude/settings.json) matched
// by the shipped `.gitignore` — the exact "5 of 6 tracked, one already
// escaping the ignore rule from a publish that predates it" steady state
// finding A describes. The private fixture's mapped starter is flipped
// executable (an honest chmod +x, content unchanged) so this genuinely
// exercises MODE BINDING, and round 4's
// MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE seam decouples the clone's
// on-disk mode from its git-tracked mode (same reasoning as Tests 32/33:
// this platform's fs.copyFileSync would otherwise faithfully propagate the
// source mode, masking whether the bound mode came from git or disk).
// Publish succeeds and `git ls-tree HEAD` shows the committed mode equal to
// the starter's NEW HEAD mode. Folded false-refusal controls (criterion 6):
// the tracked+ignored destination's committed BLOB stays byte-equal to the
// starter's HEAD blob (never falsely tampered by the re-key), and a
// SEPARATE, genuinely untracked+ignored reset destination (any of the other
// five) still skips and the whole publish is green.
//
// CORRECTED CLAIM (T-534 round 6): reverting the binder's re-keyed
// condition to ignore-only keying does NOT turn this test red. It is a
// PROVABLY EQUIVALENT MUTANT over the entire reachable input domain here:
// `git check-ignore` never reports a path present in the index as ignored,
// and the binder's presence check and its ignore check both read the SAME
// post-`git add -A` index at the SAME instant, so "absent AND ignored"
// collapses to "ignored" alone for every fixture an ordinary e2e can build.
// No test in this file can discriminate the reversion. The re-key is kept
// anyway as a runtime INVARIANT-CONDITIONED GUARD: it protects against a
// future refactor of `isGitIgnoredInClone` itself (e.g. swapping to
// `check-ignore --no-index`, a hand-rolled `.gitignore` matcher, or a git
// behaviour change on an operator machine) breaking that index-awareness —
// a risk a test can only pin at the invariant's own predicate, never
// reproduce end-to-end through this pipeline. scripts/test-publish-verify-
// provenance.js's Test 26 is that pin; see its header for the live
// mutant-kill this test's claim was retracted in favor of. This test's
// ASSERTIONS below are unchanged and still bind real behaviour (end-to-end
// mode binding of a tracked+ignored destination, plus both false-refusal
// controls) — only the mutant CLAIM above was false and is now retracted.
{
  const cloneRepoDir = cloneRepoFixture('mavp-build-t534binder-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t534binder-');
  const cloneParent = mkTempDir('mavp-build-t534binder-parent-');
  const cloneDirTarget = path.join(cloneParent, 'clone-dir-target');

  const nameA = 'zzzT534' + 'GitignoreBinderAlpha' + 'NeverMatchesAnything';
  const nameB = nameA + 'Beta';
  const DEST_PATH = '.claude/settings.json';
  const STARTER_PATH = 'templates/SETTINGS_TEMPLATE.json';

  // Flip the mapped starter's mode to executable in the PRIVATE fixture
  // repo — content unchanged — so the committed mode this test asserts
  // could only be right if the binder actually bound it (the default mode
  // would otherwise coincidentally already be 100644/off).
  fs.chmodSync(path.join(cloneRepoDir, STARTER_PATH), 0o755);
  git(cloneRepoDir, ['add', STARTER_PATH]);
  git(cloneRepoDir, ['commit', '-q', '-m', 'fixture: flip SETTINGS_TEMPLATE.json to executable (T-534 round 5)']);
  const starterHeadMode = git(cloneRepoDir, ['ls-tree', 'HEAD', '--', STARTER_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    starterHeadMode,
    '100755',
    `Test 40 FAIL: fixture assumption broken — expected the starter's HEAD mode to now be 100755, got ${starterHeadMode}`
  );
  const starterHeadBytes = execFileSync('git', ['show', `HEAD:${STARTER_PATH}`], { cwd: cloneRepoDir });

  // Pre-seed the PERSISTENT clone's `edge` branch: DEST_PATH already
  // TRACKED with the template's ORIGINAL (pre-flip) bytes — simulating a
  // publish that committed it before the shipped `.gitignore` rule existed,
  // the real steady state for `.claude/settings.json` today.
  execFileSync('git', ['clone', '--quiet', bareMirror, cloneDirTarget]);
  git(cloneDirTarget, ['config', 'core.fileMode', 'false']);
  git(cloneDirTarget, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDirTarget, ['config', 'user.name', 'Fixture User']);
  git(cloneDirTarget, ['checkout', '-b', 'edge']);
  writeFile(path.join(cloneDirTarget, DEST_PATH), '{"starter": true}\n');
  git(cloneDirTarget, ['add', '-f', DEST_PATH]);
  git(cloneDirTarget, ['commit', '-q', '-m', 'fixture: pre-seed DEST_PATH tracked (pre-dates the ignore rule)']);
  git(cloneDirTarget, ['push', '-q', 'origin', 'edge']);
  const preSeedMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', DEST_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    preSeedMode,
    '100644',
    `Test 40 FAIL: fixture assumption broken — expected the pre-seeded DEST_PATH mode to be 100644, got ${preSeedMode}`
  );

  const result = runBuildCli(
    cloneRepoDir,
    [bareMirror, cloneDirTarget, '--private-names', `${nameA},${nameB}`],
    { env: { ...process.env, MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE: `${DEST_PATH}=644` } }
  );
  assert.strictEqual(
    result.status,
    0,
    `Test 40 FAIL: expected exit 0 (a tracked+ignored destination must publish cleanly), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    result.stdout.includes('[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE set'),
    `Test 40 setup FAIL: expected proof the force-disk-mode seam fired, got stdout:\n${result.stdout}`
  );
  assert.ok(
    /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 40 FAIL: expected step 6.6 GREEN, got: ${result.stdout}`
  );

  const diskModeOctal = (fs.statSync(path.join(cloneDirTarget, DEST_PATH)).mode & 0o777).toString(8);
  assert.strictEqual(
    diskModeOctal,
    '644',
    `Test 40 FAIL: expected the clone's on-disk "${DEST_PATH}" mode to remain 644 (the seam-forced, DECOUPLED ` +
      `value) post-publish, got ${diskModeOctal}`
  );

  const committedMode = git(cloneDirTarget, ['ls-tree', 'HEAD', '--', DEST_PATH]).trim().split(/\s+/)[0];
  assert.strictEqual(
    committedMode,
    '100755',
    'Test 40 FAIL: THE FIX — expected the tracked+ignored destination\'s committed git-tree mode to be bound ' +
      `to the starter's new HEAD mode (100755) despite disk staying at 644 and core.fileMode=false, got ${committedMode}`
  );

  // Folded false-refusal control (criterion 6, part 1): the committed BLOB
  // still matches the starter's HEAD blob exactly — the re-key never
  // falsely tampers with a tracked+ignored destination's content.
  const committedBytes = execFileSync('git', ['show', `HEAD:${DEST_PATH}`], { cwd: cloneDirTarget });
  assert.ok(
    committedBytes.equals(starterHeadBytes),
    `Test 40 FAIL: expected the tracked+ignored destination's committed blob to stay byte-equal to the ` +
      "starter's HEAD blob, got a mismatch"
  );

  // Folded false-refusal control (criterion 6, part 2): a genuinely
  // untracked+ignored reset destination (any of the other five — this repo
  // clone never tracked BACKLOG.md/TASK_STATUS.md/etc under their reset
  // destinations before this run) still skips cleanly, and the whole
  // publish stayed green (already asserted above by the exit-0 check) —
  // named here as the second half of criterion 6's fold.
  assert.ok(
    /Content-provenance check GREEN/.test(result.stdout) || /Committed-tree content-provenance check GREEN/.test(result.stdout),
    `Test 40 FAIL: expected both provenance gates GREEN, proving the untracked reset destinations skipped ` +
      `cleanly alongside the tracked one, got: ${result.stdout}`
  );

  console.log(
    'Test 40 passed (round 5, criteria 5+6 — binder re-key e2e + false-refusal folds): a persistent clone ' +
      'already tracking a gitignore-matched reset destination binds its mode from the starter\'s new HEAD mode ' +
      '(core.fileMode=false, disk mode force-decoupled), the committed blob stays byte-equal to the starter, ' +
      'and the publish stays green throughout'
  );
}

// ---------------------------------------------------------------------------
// Test 41 (T-587): the assembled-suite receipt gate refuses — with NO receipt,
// and with a STALE-commit receipt — before anything touches the mirror, and
// names the exact command to run. Both cases abort at step 0.5, so neither
// assembles, scans, clones, nor runs any suite: they are cheap.
//
// Able-to-fail demonstration is structural here: the third case in this block
// is the SAME publish with a current receipt (written by runBuildCli's default
// path), which proceeds all the way to a real push against the local bare
// mirror. If the gate were inert, the first two cases would take that same
// exit-0 path and their notStrictEqual(status, 0) assertions would fail.
// ---------------------------------------------------------------------------
{
  const { ASSEMBLED_SUITE_CHECK_COMMAND } = require(BUILD_SCRIPT);
  const { receiptPathFor, writeReceipt } = require(path.join(__dirname, 'check-assembled-suite.js'));

  const cloneRepoDir = cloneRepoFixture('mavp-build-t587-clone-');
  const bareMirror = initBareMirrorWithMain('mavp-build-t587-');
  const parentDir = mkTempDir('mavp-build-t587-parent-');
  // Built by concatenation, never as contiguous literals: this file is
  // ship-classified, so 41c's assembled tree CONTAINS it, and a literal here
  // would self-match in the step-2 scan and abort the very run 41c asserts
  // reaches a push (the T-513 trap this file's other cases already document).
  const nameA = 'zzzT587' + 'ReceiptGateAlpha' + 'NeverMatches';
  const nameB = nameA + 'Beta';
  const NAMES = `${nameA},${nameB}`;

  // --- 41a: no receipt at all ---
  const noReceiptCloneDir = path.join(parentDir, 'clone-dir-no-receipt');
  assert.strictEqual(
    fs.existsSync(receiptPathFor(cloneRepoDir)),
    false,
    'Test 41a FAIL: the fixture clone must start with no assembled-suite receipt'
  );
  const noReceiptRun = runBuildCli(cloneRepoDir, [bareMirror, noReceiptCloneDir, '--private-names', NAMES], undefined, {
    skipReceipt: true,
  });
  assert.notStrictEqual(
    noReceiptRun.status,
    0,
    `Test 41a FAIL: expected a non-zero exit with no assembled-suite receipt, got ${noReceiptRun.status}:\n${noReceiptRun.stdout}\n${noReceiptRun.stderr}`
  );
  assert.ok(
    /no current assembled-suite receipt/.test(noReceiptRun.stderr),
    `Test 41a FAIL: expected the receipt-gate refusal, got: ${noReceiptRun.stderr}`
  );
  assert.ok(
    noReceiptRun.stderr.includes(ASSEMBLED_SUITE_CHECK_COMMAND),
    `Test 41a FAIL: the refusal must name the exact command to run (${ASSEMBLED_SUITE_CHECK_COMMAND}), got: ${noReceiptRun.stderr}`
  );
  // Refusing BEFORE anything touches the mirror: no assembly, no scan output,
  // no clone dir, and a mirror still holding only its seeded `main`.
  assert.ok(
    !/Step 1\/7: assemble/.test(noReceiptRun.stdout),
    `Test 41a FAIL: the gate must refuse before the assemble step runs, got stdout: ${noReceiptRun.stdout}`
  );
  assert.strictEqual(
    fs.existsSync(noReceiptCloneDir),
    false,
    'Test 41a FAIL: clone-dir must never be created when the receipt gate refuses'
  );
  assert.ok(
    !/refs\/heads\/edge/.test(gitShowRefOrEmpty(bareMirror)),
    'Test 41a FAIL: the mirror must have no `edge` ref (nothing was published)'
  );

  // --- 41b: a receipt recorded against a DIFFERENT commit (stale) ---
  const staleCloneDir = path.join(parentDir, 'clone-dir-stale-receipt');
  const staleCommit = 'b'.repeat(40);
  writeReceipt(cloneRepoDir, {
    commit: staleCommit,
    suite: { total: 76, passed: 76, failed: 0 },
    summaryLine: 'Summary: 76 passed, 0 failed (of 76 total)',
    assembledTestFiles: 76,
    assembledFileCount: 212,
    note: 'Test 41b fixture: an all-green receipt bound to a commit that is not HEAD',
  });
  const headSha = git(cloneRepoDir, ['rev-parse', 'HEAD']).trim();
  assert.notStrictEqual(headSha, staleCommit, 'Test 41b FAIL: the fixture stale commit must differ from HEAD');
  const staleRun = runBuildCli(cloneRepoDir, [bareMirror, staleCloneDir, '--private-names', NAMES], undefined, {
    skipReceipt: true,
  });
  assert.notStrictEqual(
    staleRun.status,
    0,
    `Test 41b FAIL: expected a non-zero exit on a stale-commit receipt, got ${staleRun.status}:\n${staleRun.stdout}\n${staleRun.stderr}`
  );
  assert.ok(
    /it is STALE/.test(staleRun.stderr) && staleRun.stderr.includes(staleCommit) && staleRun.stderr.includes(headSha),
    `Test 41b FAIL: expected a STALE refusal naming both the receipt's commit and HEAD, got: ${staleRun.stderr}`
  );
  assert.ok(
    staleRun.stderr.includes(ASSEMBLED_SUITE_CHECK_COMMAND),
    `Test 41b FAIL: the stale refusal must name the exact command to run, got: ${staleRun.stderr}`
  );
  assert.ok(
    !/Step 1\/7: assemble/.test(staleRun.stdout),
    `Test 41b FAIL: the gate must refuse before the assemble step runs, got stdout: ${staleRun.stdout}`
  );
  assert.strictEqual(
    fs.existsSync(staleCloneDir),
    false,
    'Test 41b FAIL: clone-dir must never be created when the receipt is stale'
  );

  // --- 41c: THE SAME publish with a current receipt proceeds and publishes ---
  const okCloneDir = path.join(parentDir, 'clone-dir-current-receipt');
  const okRun = runBuildCli(cloneRepoDir, [bareMirror, okCloneDir, '--private-names', NAMES]);
  assert.strictEqual(
    okRun.status,
    0,
    `Test 41c FAIL: expected exit 0 once a receipt matching HEAD exists, got ${okRun.status}:\n${okRun.stdout}\n${okRun.stderr}`
  );
  assert.ok(
    /Receipt current: /.test(okRun.stdout) && okRun.stdout.includes(headSha),
    `Test 41c FAIL: expected the gate to log the current receipt (naming HEAD ${headSha}), got stdout: ${okRun.stdout}`
  );
  assert.ok(
    /Step 1\/7: assemble/.test(okRun.stdout) && /Scan GREEN/.test(okRun.stdout),
    `Test 41c FAIL: expected the run to proceed past the gate into assemble+scan, got stdout: ${okRun.stdout}`
  );
  // GROUND TRUTH — the mirror's own refs, not stdout text.
  assert.ok(
    /refs\/heads\/edge/.test(gitShowRefOrEmpty(bareMirror)),
    `Test 41c FAIL: expected the mirror to hold an 'edge' ref after a gated-and-passed publish, got refs: ${gitShowRefOrEmpty(bareMirror)}`
  );

  console.log(
    'Test 41 passed (T-587): the assembled-suite receipt gate refuses with no receipt and with a ' +
      'stale-commit receipt — each before any assemble/scan/clone, naming the exact check command — and the ' +
      'same publish proceeds to a real push once a receipt matching HEAD exists'
  );
}

console.log('\nAll T-534 (content-provenance gate) assertions passed.');
