'use strict';
// Regression test: T-505 — mavp-publish-assemble.js path containment.
//
// Exercises resolveContained() (added by T-505) directly against fixture
// data via the module.exports the script now provides (same pattern
// check-publish-manifest.js already uses for testability):
//
//   1. A well-behaved relative path resolves inside its parent and returns
//      the joined path (no exit, no side effect) — the happy path used by
//      every legitimate ship/reset manifest entry.
//   2. A manifest entry containing ".." segments that would resolve OUTSIDE
//      its parent directory is refused: the process exits non-zero and
//      writes NOTHING outside the intended parent. Verified in a child
//      process (spawnSync) because resolveContained() calls process.exit()
//      on the escape path, which would otherwise kill the test runner.
//   3. Simulates the exact source-then-destination call order the real
//      assemble loop uses (resolveContained(src) -> existence check ->
//      resolveContained(dest) -> copy) with a malicious entry, and proves
//      no file is written anywhere under a sibling "must-stay-clean"
//      directory once the escape is refused.
//
// Why not drive this end-to-end through the real CLI against this repo's
// own manifest? A manifest entry with literal ".." segments can never
// pass the T-331 preflight completeness check in the first place — git
// itself can never track a path whose component is literally ".." (the
// filesystem resolves it away before `git add` ever sees it), so the
// preflight step would always reject such an entry before reaching
// resolveContained(). That is exactly why resolveContained() is
// defense-in-depth against a hand-edited/corrupt manifest rather than
// something reachable via the git-backed happy path — see the T-505 code
// comment on resolveContained() in mavp-publish-assemble.js. Testing the
// exported function directly (verification_type: unit, per BACKLOG T-505)
// is therefore the correct level, not a workaround.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ASSEMBLE_SCRIPT = path.join(__dirname, 'mavp-publish-assemble.js');
const { resolveContained, pathExists, copyFile } = require('./mavp-publish-assemble.js');

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

// ---------------------------------------------------------------------------
// Test 1: well-behaved relative path stays contained (happy path).
// ---------------------------------------------------------------------------
{
  const parent = mkTempDir('mavp-containment-parent-');
  const resolved = resolveContained(parent, 'docs/CLAUDE.md', 'ship destination path');
  assert.strictEqual(
    resolved,
    path.join(parent, 'docs', 'CLAUDE.md'),
    'Test 1 FAIL: a normal relative path should resolve to the expected joined path'
  );
  console.log('Test 1 passed: a well-behaved relative path resolves inside its parent unchanged');
}

// ---------------------------------------------------------------------------
// Test 2: a ".." escape attempt is refused — non-zero exit, in a child
// process (resolveContained calls process.exit() on the escape branch).
// ---------------------------------------------------------------------------
{
  const parent = mkTempDir('mavp-containment-parent-');
  const escapeRelPath = '../../../../etc/mavp-t505-escape-fixture.txt';

  const childScript = `
    const { resolveContained } = require(${JSON.stringify(ASSEMBLE_SCRIPT)});
    resolveContained(${JSON.stringify(parent)}, ${JSON.stringify(escapeRelPath)}, 'ship destination path');
    console.log('UNREACHABLE — resolveContained should have exited before this line');
  `;

  const result = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, 'Test 2 FAIL: escape attempt should exit non-zero');
  assert.ok(
    !result.stdout.includes('UNREACHABLE'),
    'Test 2 FAIL: resolveContained should have exited before returning a value'
  );
  assert.ok(
    /path escape refused/.test(result.stderr),
    `Test 2 FAIL: expected "path escape refused" in stderr, got:\n${result.stderr}`
  );
  console.log('Test 2 passed: a ".." escape attempt exits non-zero with "path escape refused" and never returns a path');
}

// ---------------------------------------------------------------------------
// Test 3: nothing is written outside the intended parent when the real
// assemble-loop call order (resolve src -> exists check -> resolve dest ->
// copy) hits a malicious entry — simulated with the exported primitives in
// the SAME order main() uses, proving the escape is caught before any I/O.
// ---------------------------------------------------------------------------
{
  const tempExtractDir = mkTempDir('mavp-containment-src-');
  const outDir = mkTempDir('mavp-containment-out-');
  const sentinelParentDir = mkTempDir('mavp-containment-sentinel-parent-');
  // A directory placed as a SIBLING of outDir — this is what a `../` escape
  // from outDir would land in. It starts empty; the assertion is that it
  // stays empty.
  const outDirParent = path.dirname(outDir);

  // A legitimate ship entry: written first, exactly like main()'s loop
  // would for any well-formed manifest entry — proves the "well-behaved
  // entries still get copied" side of the story, not just the refusal.
  fs.writeFileSync(path.join(tempExtractDir, 'good.txt'), 'legit content\n');
  {
    const srcPath = resolveContained(tempExtractDir, 'good.txt', 'ship source path');
    assert.ok(pathExists(srcPath), 'Test 3 setup FAIL: good.txt should exist in the fake extraction');
    const destPath = resolveContained(outDir, 'good.txt', 'ship destination path');
    copyFile(srcPath, destPath);
  }
  assert.ok(
    fs.existsSync(path.join(outDir, 'good.txt')),
    'Test 3 FAIL: a well-behaved entry should still be copied into outDir'
  );

  // A malicious ship entry attempting to escape outDir via "..". Run the
  // identical resolve-then-copy sequence in a CHILD PROCESS (the escape
  // resolution calls process.exit()), then assert the sentinel directory
  // — a sibling of outDir, the escape's landing zone — remains empty.
  const maliciousRelPath = '../mavp-t505-escape-fixture.txt';
  const childScript = `
    const { resolveContained, pathExists, copyFile } = require(${JSON.stringify(ASSEMBLE_SCRIPT)});
    const fs = require('node:fs');
    const path = require('node:path');
    const tempExtractDir = ${JSON.stringify(tempExtractDir)};
    const outDir = ${JSON.stringify(outDir)};
    const maliciousRelPath = ${JSON.stringify(maliciousRelPath)};
    fs.writeFileSync(path.join(tempExtractDir, 'evil-source.txt'), 'attacker-controlled content\\n');
    // Mirror main()'s real loop body exactly: resolve source (contained to
    // tempExtractDir), existence check, THEN resolve destination (contained
    // to outDir) before ever calling copyFile.
    const srcPath = resolveContained(tempExtractDir, 'evil-source.txt', 'ship source path');
    if (!pathExists(srcPath)) { console.error('setup broken'); process.exit(3); }
    const destPath = resolveContained(outDir, maliciousRelPath, 'ship destination path');
    copyFile(srcPath, destPath);
    console.log('UNREACHABLE — copyFile should never have been called');
  `;
  const result = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, 'Test 3 FAIL: malicious destination entry should exit non-zero');
  assert.ok(
    !result.stdout.includes('UNREACHABLE'),
    'Test 3 FAIL: copyFile must never be reached for a malicious destination entry'
  );

  // The escape target ("../mavp-t505-escape-fixture.txt" relative to outDir)
  // would land directly in outDirParent (outDir's own parent). Prove it was
  // never created there.
  const wouldHaveEscapedTo = path.join(outDirParent, 'mavp-t505-escape-fixture.txt');
  assert.ok(
    !fs.existsSync(wouldHaveEscapedTo),
    `Test 3 FAIL: escape target was written outside outDir at ${wouldHaveEscapedTo}`
  );
  // Also confirm the sentinel directory (a clean control location) never
  // received anything either.
  assert.deepStrictEqual(
    fs.readdirSync(sentinelParentDir),
    [],
    'Test 3 FAIL: sentinel control directory should remain untouched'
  );
  console.log('Test 3 passed: malicious ".." destination entry refused before copyFile — nothing written outside outDir');
}

console.log('\nAll T-505 assemble-containment assertions passed.');
