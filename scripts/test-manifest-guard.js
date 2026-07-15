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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const REAL_ROOT = path.resolve(__dirname, '..');
const GUARD_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-manifest-guard.js');
const CHECK_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'check-publish-manifest.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't401-manifest-guard-'));

function initGitRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
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
  writeManifest(root, {
    ship: ['scripts/mavp-manifest-guard.js', 'scripts/publish-manifest.json'],
    reset: {},
    exclude: { 'docs/internal.md': 'internal only, never shipped' },
  });
  fs.writeFileSync(path.join(root, 'docs', 'internal.md'), 'internal\n', 'utf8');
  gitAdd(root, ['scripts/mavp-manifest-guard.js', 'scripts/publish-manifest.json', 'docs/internal.md']);
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
  fs.copyFileSync(CHECK_SCRIPT_SRC, path.join(root, 'scripts', 'check-publish-manifest.js'));
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
  fs.copyFileSync(CHECK_SCRIPT_SRC, path.join(root, 'scripts', 'check-publish-manifest.js'));
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
  fs.copyFileSync(CHECK_SCRIPT_SRC, path.join(root, 'scripts', 'check-publish-manifest.js'));
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
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-401 assertions passed.');
