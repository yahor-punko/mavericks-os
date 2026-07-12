'use strict';
// Regression test: T-356 — publish re-sync must preserve public-native files
//
// Exercises:
//   1. mavp-publish-overlay.js against a fake assembled dir + fake clone dir:
//      a stale file is deleted, an outdated shipped file is overwritten, a
//      public-native preserved file (.github/ISSUE_TEMPLATE/bug_report.md)
//      survives byte-identical, and .git/ is never touched.
//   2. check-publish-manifest.js's preserve-shadow check: fails when a
//      `preserve` entry covers a git-tracked path, passes on the real manifest.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const OVERLAY_SCRIPT = path.join(__dirname, 'mavp-publish-overlay.js');
const CHECK_SCRIPT = path.join(__dirname, 'check-publish-manifest.js');

const { validateManifest } = require('./check-publish-manifest.js');

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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Test 1: overlay copies, deletes stale, preserves public-native files, and
//         never touches .git/.
// ---------------------------------------------------------------------------
{
  const assembledDir = mkTempDir('mavp-overlay-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-clone-');

  // Fake assembled tree.
  writeFile(path.join(assembledDir, 'shipped.md'), 'NEW shipped content\n');
  writeFile(path.join(assembledDir, 'scripts', 'tool.js'), 'console.log("tool");\n');

  // Fake clone tree: stale file, outdated shipped file, .git sentinel, and a
  // public-native preserved file.
  writeFile(path.join(cloneDir, 'old-shipped.md'), 'stale content that should be deleted\n');
  writeFile(path.join(cloneDir, 'shipped.md'), 'OLD outdated shipped content\n');
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  const bugReportContent = '---\nname: Bug report\n---\nDescribe the bug.\n';
  writeFile(path.join(cloneDir, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), bugReportContent);

  const output = execFileSync('node', [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' });

  assert.ok(/copied 2, deleted 1, preserved 1/.test(output), `Test 1 FAIL: unexpected summary line: ${output}`);
  assert.ok(output.includes('.github/ISSUE_TEMPLATE/bug_report.md'), 'Test 1 FAIL: preserved path not listed in output');

  // bug_report.md survives byte-identical.
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'utf8'),
    bugReportContent,
    'Test 1 FAIL: preserved .github file was not byte-identical after overlay'
  );

  // old-shipped.md deleted.
  assert.strictEqual(
    fs.existsSync(path.join(cloneDir, 'old-shipped.md')),
    false,
    'Test 1 FAIL: stale old-shipped.md was not deleted'
  );

  // shipped.md overwritten with assembled content.
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, 'shipped.md'), 'utf8'),
    'NEW shipped content\n',
    'Test 1 FAIL: shipped.md was not overwritten with assembled content'
  );

  // new file from assembled tree copied in.
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, 'scripts', 'tool.js'), 'utf8'),
    'console.log("tool");\n',
    'Test 1 FAIL: scripts/tool.js was not copied into the clone'
  );

  // .git/config untouched.
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8'),
    '[core]\n\trepositoryformatversion = 0\n',
    'Test 1 FAIL: .git/config was modified by the overlay'
  );

  console.log('Test 1 passed: overlay copies, deletes stale, preserves .github/*, never touches .git/');
}

// ---------------------------------------------------------------------------
// Test 2: check-publish-manifest.js's validateManifest() fails when a
//         `preserve` entry covers a git-tracked path.
// ---------------------------------------------------------------------------
{
  const trackedFixture = ['README.md', 'scripts/foo.js', '.github/workflows/ci.yml'];
  const manifestFixture = {
    ship: ['README.md', 'scripts/foo.js'],
    reset: {},
    exclude: {},
    // Shadows the tracked .github/workflows/ci.yml path — must fail.
    preserve: { '.github/': 'public-native' },
  };

  const result = validateManifest(manifestFixture, trackedFixture);
  assert.strictEqual(result.ok, false, 'Test 2 FAIL: expected validateManifest() to fail on a shadowing preserve entry');
  const shadowProblem = result.problems.find((p) => p.title.includes('PRESERVE entries shadow'));
  assert.ok(shadowProblem, 'Test 2 FAIL: expected a PRESERVE-shadow problem to be reported');
  assert.ok(
    shadowProblem.lines.some((l) => l.includes('.github/workflows/ci.yml')),
    'Test 2 FAIL: expected the shadowed tracked path to be named in the problem details'
  );
  console.log('Test 2 passed: validateManifest() fails closed when a preserve entry shadows a tracked path');
}

// ---------------------------------------------------------------------------
// Test 3: validateManifest() passes when the preserve entry does NOT shadow
//         any tracked path (mirrors the real manifest's situation).
// ---------------------------------------------------------------------------
{
  const trackedFixture = ['README.md', 'scripts/foo.js'];
  const manifestFixture = {
    ship: ['README.md', 'scripts/foo.js'],
    reset: {},
    exclude: {},
    preserve: { '.github/': 'public-native' },
  };

  const result = validateManifest(manifestFixture, trackedFixture);
  assert.strictEqual(result.ok, true, 'Test 3 FAIL: expected validateManifest() to pass when preserve does not shadow tracked paths');
  console.log('Test 3 passed: validateManifest() passes when preserve entries do not shadow tracked paths');
}

// ---------------------------------------------------------------------------
// Test 4: the REAL scripts/publish-manifest.json exits 0 via the CLI
//         (private repo tracks no .github/, so the preserve entry is safe).
//
// This test's invariant (manifest classifies exactly the tracked set) only
// holds against the private canonical repo's tracked file set. In the public
// mirror, `exclude` entries are never tracked (they're excluded from
// publish) and `.github/ISSUE_TEMPLATE/*` is preserve-tracked there, so the
// real-manifest check always fails there for reasons that are not bugs. Skip
// this test outside the canonical repo; Tests 1-3 still run everywhere.
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'publish-manifest.json'), 'utf8'));

  let isCanonical;
  try {
    const trackedOutput = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const trackedSet = new Set(trackedOutput.split('\n').filter(Boolean));
    isCanonical = Object.keys(manifest.exclude).every((k) => trackedSet.has(k));
  } catch {
    // Not a git repo (e.g. a tarball checkout) — treat as non-canonical.
    isCanonical = false;
  }

  if (!isCanonical) {
    console.log('Test 4 skipped: not the canonical (private) repo — the manifest completeness invariant only holds against the private tracked set');
  } else {
    const result = require('node:child_process').spawnSync(process.execPath, [CHECK_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, `Test 4 FAIL: check-publish-manifest.js exited ${result.status} on the real manifest:\n${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes('preserve: '), 'Test 4 FAIL: expected preserve count in check-publish-manifest.js output');
    console.log('Test 4 passed: check-publish-manifest.js exits 0 on the real manifest (preserve entry does not shadow any tracked path)');
  }
}

console.log('\nAll T-356 assertions passed.');
