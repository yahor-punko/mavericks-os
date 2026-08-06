'use strict';
// Regression test: T-401 — commit-time and creation-time publish-manifest
// enforcement (mavp-manifest-guard.js + check-publish-manifest.js --if-canonical).
//
// Builds fresh git-repo fixtures under os.tmpdir() for every scenario — NEVER
// touches the real repo. Each fixture gets a fresh COPY of the real script
// under test (scripts/mavp-manifest-guard.js or scripts/check-publish-manifest.js)
// so both scripts' hardcoded `REPO_ROOT = path.resolve(__dirname, '..')`
// convention resolves correctly against the fixture root, not this repo.
//
// Covers:
//   (a) canonical fixture + unclassified new file -> guard prints a stderr
//       advisory naming the path + exits 0.
//   (b) after classifying the path -> guard is silent (exit 0, no output).
//   (c) check-publish-manifest.js --if-canonical exits 1 naming the
//       unclassified path in a canonical fixture.
//   (d) --if-canonical exits 0 with a skip message in a non-canonical
//       fixture (an exclude key not tracked) AND in a repo with no manifest.
//
// Bonus coverage: the guard stays silent on a gitignored path (an explicit
// requirement of the guard's design, even though not one of the four
// acceptance-criteria items).
//
// T-556 — named mutant killers for the guard's behaviour split (WARN AND
// STAND DOWN on a present-but-broken manifest, never silent, never a
// per-file advisory computed off garbage):
//   (e1) truncated/invalid JSON -> exit 0, stderr carries the malformed-
//        manifest advisory, stderr does NOT carry the per-file advisory.
//   (e2) `exclude` as an array -> exit 0, stderr names the shape reason.
//   (e3) no manifest at all -> exit 0, stdout AND stderr both empty.
//   (e4) COHERENCE PIN: the same malformed manifest fed to the guard
//        (exit 0 + advisory) and to check-publish-manifest.js (exit 1) in
//        one fixture, asserting both surfaces flag the same manifest.
//   (e5) COHERENCE PIN, `ship`/`reset` half: same shape as (e4) but with a
//        malformed `ship` (a string, not an array) instead of `exclude` —
//        (e4) alone cannot discriminate a PARTIALLY narrower guard
//        predicate that still checks `exclude`/`preserve` locally but never
//        composes validateManifestShape(), since such a predicate would
//        still catch (e4)'s bad-`exclude` fixture. (e5) is the only
//        assertion a guard-local predicate missing the `ship`/`reset` half
//        of the composed contract would fail.
//
// T-556 — since the guard now requires check-publish-manifest.js (for the
// shared shape contract validateManifestBucketsShape), every fixture that
// copies the guard must ALSO copy the checker and its own dependency
// (mavp-publish-verify-provenance.js) via copyCheckScriptWithDeps(), or the
// guard's require() fails with MODULE_NOT_FOUND against the fixture's own
// scripts/ directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const REAL_ROOT = path.resolve(__dirname, '..');
const GUARD_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-manifest-guard.js');
const CHECK_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'check-publish-manifest.js');
// T-550 — check-publish-manifest.js now requires this module (for the
// shared shape contract), so every fixture that copies CHECK_SCRIPT_SRC
// into a scratch repo must also copy its dependency, or `require()` fails
// with MODULE_NOT_FOUND against the fixture's own scripts/ directory.
const VERIFY_PROVENANCE_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-publish-verify-provenance.js');

function copyCheckScriptWithDeps(root) {
  fs.copyFileSync(CHECK_SCRIPT_SRC, path.join(root, 'scripts', 'check-publish-manifest.js'));
  fs.copyFileSync(VERIFY_PROVENANCE_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-publish-verify-provenance.js'));
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't401-manifest-guard-'));

function initGitRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
}

function gitAdd(root, args) {
  execFileSync('git', ['add', ...args], { cwd: root });
}

function writeManifest(root, manifest) {
  fs.writeFileSync(path.join(root, 'scripts', 'publish-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function runGuard(root, targetPath) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'mavp-manifest-guard.js'), targetPath], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runCheck(root, args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-publish-manifest.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Fixture: canonical repo (manifest present, every `exclude` key tracked).
// ---------------------------------------------------------------------------
function makeCanonicalFixture(name) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initGitRepo(root);
  fs.copyFileSync(GUARD_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-manifest-guard.js'));
  // T-556 — the guard now requires check-publish-manifest.js at load time,
  // so every fixture running the guard needs it (and its own dependency)
  // present in the fixture's scripts/ directory.
  copyCheckScriptWithDeps(root);
  writeManifest(root, {
    ship: [
      'scripts/mavp-manifest-guard.js',
      'scripts/publish-manifest.json',
      'scripts/check-publish-manifest.js',
      'scripts/mavp-publish-verify-provenance.js',
    ],
    reset: {},
    exclude: { 'docs/internal.md': 'internal only, never shipped' },
  });
  fs.writeFileSync(path.join(root, 'docs', 'internal.md'), 'internal\n', 'utf8');
  gitAdd(root, [
    'scripts/mavp-manifest-guard.js',
    'scripts/publish-manifest.json',
    'scripts/check-publish-manifest.js',
    'scripts/mavp-publish-verify-provenance.js',
    'docs/internal.md',
  ]);
  return root;
}

// ---------------------------------------------------------------------------
// Test (a): canonical fixture + unclassified new file -> stderr advisory,
// naming the path and scripts/publish-manifest.json, exit 0.
// ---------------------------------------------------------------------------
{
  const root = makeCanonicalFixture('guard-unclassified');
  fs.writeFileSync(path.join(root, 'docs', 'new-file.md'), 'new content\n', 'utf8');

  const result = runGuard(root, 'docs/new-file.md');

  assert.strictEqual(result.status, 0, `Test (a) FAIL: guard must always exit 0, got ${result.status}\n${result.stderr}`);
  assert.ok(
    result.stderr.includes('docs/new-file.md'),
    `Test (a) FAIL: stderr should name the unclassified path, got:\n${result.stderr}`
  );
  assert.ok(
    result.stderr.includes('scripts/publish-manifest.json'),
    `Test (a) FAIL: stderr should name scripts/publish-manifest.json, got:\n${result.stderr}`
  );
  console.log('Test (a) passed: guard prints stderr advisory naming the unclassified path and the manifest, exits 0');

  // -------------------------------------------------------------------------
  // Test (b): after classifying the path -> guard is silent.
  // -------------------------------------------------------------------------
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'publish-manifest.json'), 'utf8'));
  manifest.ship.push('docs/new-file.md');
  writeManifest(root, manifest);

  const result2 = runGuard(root, 'docs/new-file.md');
  assert.strictEqual(result2.status, 0, 'Test (b) FAIL: guard must exit 0');
  assert.strictEqual(result2.stdout, '', `Test (b) FAIL: expected silent stdout, got: ${result2.stdout}`);
  assert.strictEqual(result2.stderr, '', `Test (b) FAIL: expected silent stderr after classification, got: ${result2.stderr}`);
  console.log('Test (b) passed: guard is silent after the path is classified');
}

// ---------------------------------------------------------------------------
// Bonus: guard stays silent on a gitignored path.
// ---------------------------------------------------------------------------
{
  const root = makeCanonicalFixture('guard-gitignored');
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/scratch/\n', 'utf8');
  fs.mkdirSync(path.join(root, 'docs', 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'scratch', 'temp.md'), 'scratch\n', 'utf8');

  const result = runGuard(root, 'docs/scratch/temp.md');
  assert.strictEqual(result.status, 0, 'Bonus FAIL: guard must exit 0');
  assert.strictEqual(result.stderr, '', `Bonus FAIL: expected silence on gitignored path, got: ${result.stderr}`);
  console.log('Bonus test passed: guard stays silent on a gitignored/untracked-by-intent path');
}

// ---------------------------------------------------------------------------
// Test (c): check-publish-manifest.js --if-canonical exits 1 naming the
// unclassified path in a canonical fixture.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'check-canonical');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initGitRepo(root);
  copyCheckScriptWithDeps(root);
  writeManifest(root, {
    ship: ['scripts/publish-manifest.json', 'scripts/check-publish-manifest.js', 'docs/classified.md'],
    reset: {},
    exclude: { 'docs/internal.md': 'internal only' },
  });
  fs.writeFileSync(path.join(root, 'docs', 'classified.md'), 'classified\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'internal.md'), 'internal\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'uncls.md'), 'unclassified\n', 'utf8');
  gitAdd(root, [
    'scripts/publish-manifest.json',
    'scripts/check-publish-manifest.js',
    'docs/classified.md',
    'docs/internal.md',
    'docs/uncls.md',
  ]);

  const result = runCheck(root, ['--if-canonical']);
  assert.strictEqual(result.status, 1, `Test (c) FAIL: expected exit 1, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stderr.includes('docs/uncls.md'),
    `Test (c) FAIL: expected stderr to name docs/uncls.md, got:\n${result.stderr}`
  );
  console.log('Test (c) passed: --if-canonical exits 1 naming the unclassified path in a canonical fixture');
}

// ---------------------------------------------------------------------------
// Test (d1): --if-canonical exits 0 with a skip message in a non-canonical
// fixture (an exclude key not tracked).
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'check-noncanonical');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  initGitRepo(root);
  copyCheckScriptWithDeps(root);
  writeManifest(root, {
    ship: ['scripts/publish-manifest.json'],
    reset: {},
    exclude: { 'docs/never-tracked.md': 'not shipped in the public mirror' },
  });
  gitAdd(root, ['scripts/publish-manifest.json', 'scripts/check-publish-manifest.js']);

  const result = runCheck(root, ['--if-canonical']);
  assert.strictEqual(result.status, 0, `Test (d1) FAIL: expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    /skip/i.test(result.stdout),
    `Test (d1) FAIL: expected a skip message on stdout, got:\n${result.stdout}`
  );
  console.log('Test (d1) passed: --if-canonical exits 0 with a skip message in a non-canonical fixture');
}

// ---------------------------------------------------------------------------
// Test (d2): --if-canonical exits 0 with a skip message in a repo with no
// manifest at all.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'check-nomanifest');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  initGitRepo(root);
  copyCheckScriptWithDeps(root);
  gitAdd(root, ['scripts/check-publish-manifest.js']);

  const result = runCheck(root, ['--if-canonical']);
  assert.strictEqual(result.status, 0, `Test (d2) FAIL: expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    /skip/i.test(result.stdout),
    `Test (d2) FAIL: expected a skip message on stdout, got:\n${result.stdout}`
  );
  console.log('Test (d2) passed: --if-canonical exits 0 with a skip message in a repo with no manifest');
}

// ---------------------------------------------------------------------------
// Test (e1): truncated/invalid JSON manifest -> guard exits 0, stderr carries
// the malformed-manifest advisory, stderr does NOT carry the per-file
// advisory. Kills both the keep-the-silent-catch mutant (which would exit 0
// with empty stderr, indistinguishable from the ENOENT case) and the
// warn-but-still-advise mutant (which would additionally print the per-file
// "is a new/tracked file not classified" line computed off a defaulted {}).
// ---------------------------------------------------------------------------
{
  const root = makeCanonicalFixture('guard-invalid-json');
  fs.writeFileSync(path.join(root, 'docs', 'new-file.md'), 'new content\n', 'utf8');
  // Truncate the manifest to invalid JSON (unterminated object).
  fs.writeFileSync(path.join(root, 'scripts', 'publish-manifest.json'), '{ "ship": [ "a", ', 'utf8');

  const result = runGuard(root, 'docs/new-file.md');
  assert.strictEqual(result.status, 0, `Test (e1) FAIL: guard must exit 0, got ${result.status}\n${result.stderr}`);
  assert.ok(
    /MANIFEST GUARD:/.test(result.stderr) && /could not be parsed/i.test(result.stderr),
    `Test (e1) FAIL: expected the malformed-manifest advisory on stderr, got:\n${result.stderr}`
  );
  assert.ok(
    !result.stderr.includes('is a new/tracked file not classified'),
    `Test (e1) FAIL: the per-file advisory must NOT appear when the manifest itself is broken, got:\n${result.stderr}`
  );
  console.log('Test (e1) passed: invalid JSON -> exit 0, malformed-manifest advisory present, per-file advisory absent');
}

// ---------------------------------------------------------------------------
// Test (e2): `exclude` as an array -> guard exits 0, stderr names the shape
// reason. Kills a parse-only try/catch with no shape gate (i.e. one that
// only discriminates ENOENT vs. JSON.parse failure but never validates the
// parsed shape).
// ---------------------------------------------------------------------------
let e2Root; // reused by the (e4) coherence pin below
{
  const root = path.join(TMP_DIR, 'guard-bad-exclude-shape');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  initGitRepo(root);
  fs.copyFileSync(GUARD_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-manifest-guard.js'));
  copyCheckScriptWithDeps(root);
  writeManifest(root, {
    ship: ['scripts/mavp-manifest-guard.js', 'scripts/publish-manifest.json'],
    reset: {},
    // Malformed: `exclude` must be a plain object, not an array.
    exclude: ['docs/internal.md'],
  });
  gitAdd(root, [
    'scripts/mavp-manifest-guard.js',
    'scripts/publish-manifest.json',
    'scripts/check-publish-manifest.js',
    'scripts/mavp-publish-verify-provenance.js',
  ]);

  const result = runGuard(root, 'scripts/mavp-manifest-guard.js');
  assert.strictEqual(result.status, 0, `Test (e2) FAIL: guard must exit 0, got ${result.status}\n${result.stderr}`);
  assert.ok(
    /MANIFEST GUARD:/.test(result.stderr) && /exclude.*not a plain/i.test(result.stderr),
    `Test (e2) FAIL: expected stderr to name the \`exclude\` shape reason, got:\n${result.stderr}`
  );
  console.log('Test (e2) passed: `exclude` as an array -> exit 0, stderr names the shape reason');
  e2Root = root;
}

// ---------------------------------------------------------------------------
// Test (e3): no manifest at all -> guard exits 0 with stdout AND stderr both
// empty. Kills a warn-on-ENOENT mutant (one that would also advise on the
// documented adopter/mirror silence case).
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'guard-no-manifest');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initGitRepo(root);
  fs.copyFileSync(GUARD_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-manifest-guard.js'));
  copyCheckScriptWithDeps(root);
  fs.writeFileSync(path.join(root, 'docs', 'new-file.md'), 'new content\n', 'utf8');
  gitAdd(root, [
    'scripts/mavp-manifest-guard.js',
    'scripts/check-publish-manifest.js',
    'scripts/mavp-publish-verify-provenance.js',
    'docs/new-file.md',
  ]);

  const result = runGuard(root, 'docs/new-file.md');
  assert.strictEqual(result.status, 0, `Test (e3) FAIL: guard must exit 0, got ${result.status}\n${result.stderr}`);
  assert.strictEqual(result.stdout, '', `Test (e3) FAIL: expected empty stdout with no manifest, got: ${result.stdout}`);
  assert.strictEqual(result.stderr, '', `Test (e3) FAIL: expected empty stderr with no manifest, got: ${result.stderr}`);
  console.log('Test (e3) passed: no manifest at all -> exit 0, stdout AND stderr both empty');
}

// ---------------------------------------------------------------------------
// Test (e4): COHERENCE PIN — the SAME malformed manifest fed to the guard
// (exit 0 + advisory) and to check-publish-manifest.js (exit 1) in one
// fixture, asserting both surfaces flag the same manifest. Kills the
// guard-grows-its-own-narrower-predicate drift mutant: if the guard ever
// re-implements its own shape check instead of importing
// validateManifestBucketsShape from the checker, this coherence pin is the
// only assertion that would catch the two predicates diverging.
// ---------------------------------------------------------------------------
{
  const guardResult = runGuard(e2Root, 'scripts/mavp-manifest-guard.js');
  const checkResult = runCheck(e2Root, []);

  assert.strictEqual(guardResult.status, 0, `Test (e4) FAIL: guard must exit 0, got ${guardResult.status}`);
  assert.ok(
    /MANIFEST GUARD:/.test(guardResult.stderr) && /exclude.*not a plain/i.test(guardResult.stderr),
    `Test (e4) FAIL: expected the guard to flag the same malformed \`exclude\` bucket, got:\n${guardResult.stderr}`
  );
  assert.strictEqual(checkResult.status, 1, `Test (e4) FAIL: checker must exit 1 on the same manifest, got ${checkResult.status}`);
  assert.ok(
    /exclude.*not a plain/i.test(checkResult.stderr),
    `Test (e4) FAIL: expected the checker to name the same \`exclude\` shape reason, got:\n${checkResult.stderr}`
  );
  console.log('Test (e4) passed: guard (exit 0 + advisory) and checker (exit 1) agree on the same malformed manifest');
}

// ---------------------------------------------------------------------------
// Test (e5): COHERENCE PIN, `ship`/`reset` half — the (e4) fixture only ever
// exercises a malformed `exclude` bucket, which a PARTIALLY narrower guard
// predicate (one that still checks `exclude`/`preserve` locally but never
// composes validateManifestShape(), so it silently skips `ship`/`reset`)
// would pass straight through undetected. This fixture malforms `ship`
// instead (a string, not an array) with `exclude`/`reset` both well-formed,
// so it can ONLY be caught by a predicate that actually reuses
// validateManifestShape() — exactly what validateManifestBucketsShape()
// composes. Same coherence shape as (e4): guard exits 0 + advisory, checker
// exits 1, both name the same manifest.
// ---------------------------------------------------------------------------
{
  const root = path.join(TMP_DIR, 'guard-bad-ship-shape');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  initGitRepo(root);
  fs.copyFileSync(GUARD_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-manifest-guard.js'));
  copyCheckScriptWithDeps(root);
  writeManifest(root, {
    // Malformed: `ship` must be an array, not a string.
    ship: 'scripts/mavp-manifest-guard.js',
    reset: {},
    exclude: {},
  });
  gitAdd(root, [
    'scripts/mavp-manifest-guard.js',
    'scripts/publish-manifest.json',
    'scripts/check-publish-manifest.js',
    'scripts/mavp-publish-verify-provenance.js',
  ]);

  const guardResult = runGuard(root, 'scripts/mavp-manifest-guard.js');
  const checkResult = runCheck(root, []);

  assert.strictEqual(guardResult.status, 0, `Test (e5) FAIL: guard must exit 0, got ${guardResult.status}\n${guardResult.stderr}`);
  assert.ok(
    /MANIFEST GUARD:/.test(guardResult.stderr) && /ship.*not an array/i.test(guardResult.stderr),
    `Test (e5) FAIL: expected the guard to flag the malformed \`ship\` bucket, got:\n${guardResult.stderr}`
  );
  assert.ok(
    !guardResult.stderr.includes('is a new/tracked file not classified'),
    `Test (e5) FAIL: the per-file advisory must NOT appear when \`ship\` itself is malformed, got:\n${guardResult.stderr}`
  );
  assert.strictEqual(checkResult.status, 1, `Test (e5) FAIL: checker must exit 1 on the same manifest, got ${checkResult.status}`);
  assert.ok(
    /ship.*not an array/i.test(checkResult.stderr),
    `Test (e5) FAIL: expected the checker to name the same \`ship\` shape reason, got:\n${checkResult.stderr}`
  );
  console.log(
    'Test (e5) passed: malformed `ship` (not `exclude`) -> guard (exit 0 + advisory) and checker (exit 1) still agree — ' +
      'kills a PARTIALLY narrower guard predicate that checks exclude/preserve but skips ship/reset'
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-401/T-556 assertions passed.');
