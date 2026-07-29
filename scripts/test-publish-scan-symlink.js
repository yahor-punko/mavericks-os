'use strict';
// Regression test: T-505 — mavp-publish-scan.js symlink-target detection.
//
// Before T-505, walk() did `if (entry.isSymbolicLink()) continue;` — a
// ship-classified tracked symlink whose TARGET STRING embedded a private
// path (e.g. an absolute home-directory filesystem path, or a private repo
// name) reached the public tree completely ungated, because the scanner
// never looked at it. T-505 makes walk() record symlinks separately and
// scan their target string (via readlinkSync, never dereferenced/followed)
// through the same detection categories used for file content.
//
// Exercises the exported primitives (walk, scanSymlinkTarget,
// scanTextAgainstCategories) directly against fixture symlinks — the
// literal detectable strings below (a fake absolute home-directory path, a
// fake private repo name) live ONLY inside dynamically-created symlink
// targets on disk under a scratch temp dir, never as literal substrings in
// this file's own text, per the shipped-test-fixture secret-string rule
// (.claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { walk, scanSymlinkTarget, scanFile } = require('./mavp-publish-scan.js');

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

const BASE_CATEGORIES = [
  {
    name: 'Absolute /Users/ path',
    regexes: [() => /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g],
  },
];

function buildPrivateNameCategory(names) {
  return {
    name: 'Private repo name',
    regexes: names.map((name) => () => new RegExp(`\\b${name}\\b`, 'gi')),
  };
}

// Construct the detectable strings at RUNTIME (concatenation), never as a
// literal substring anywhere in this file's text — see file header.
const FAKE_USERNAME = ['som', 'e', 'operator'].join('');
const FAKE_ABS_PATH = ['/Users/', FAKE_USERNAME, '/projects/private-repo/secret.txt'].join('');
const FAKE_PRIVATE_REPO_NAME = ['acme', '-', 'internal', '-service'].join('');

// ---------------------------------------------------------------------------
// Test 1: walk() records a symlink entry separately from regular files
// (type: 'symlink'), and never recurses into / dereferences it.
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-symlink-walk-');
  fs.writeFileSync(path.join(dir, 'regular.txt'), 'hello\n');
  fs.symlinkSync(FAKE_ABS_PATH, path.join(dir, 'a-link'));

  const entries = walk(dir, []);
  const byType = { file: [], symlink: [] };
  for (const e of entries) byType[e.type].push(e.path);

  assert.strictEqual(byType.file.length, 1, 'Test 1 FAIL: expected exactly one regular file entry');
  assert.strictEqual(byType.symlink.length, 1, 'Test 1 FAIL: expected exactly one symlink entry');
  assert.ok(byType.symlink[0].endsWith('a-link'), 'Test 1 FAIL: symlink entry path mismatch');
  console.log('Test 1 passed: walk() records symlinks as a distinct type instead of skipping them');
}

// ---------------------------------------------------------------------------
// Test 2: a symlink whose target embeds a private (/Users/) path is
// reported by scanSymlinkTarget() — non-zero findings, named in the result,
// and the finding is attributed to the "Absolute /Users/ path" category
// (the existing detection category, not a bespoke new one).
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-symlink-abspath-');
  const linkPath = path.join(dir, 'leaky-link');
  fs.symlinkSync(FAKE_ABS_PATH, linkPath);

  const findings = [];
  scanSymlinkTarget(linkPath, findings, BASE_CATEGORIES);

  assert.strictEqual(findings.length, 1, `Test 2 FAIL: expected exactly one finding, got ${findings.length}`);
  assert.strictEqual(findings[0].category, 'Absolute /Users/ path', 'Test 2 FAIL: wrong category attributed');
  assert.strictEqual(findings[0].file, linkPath, 'Test 2 FAIL: finding should reference the symlink path itself');
  assert.strictEqual(findings[0].line, null, 'Test 2 FAIL: a symlink-target finding has no line number (null)');
  console.log('Test 2 passed: a symlink whose target embeds an absolute /Users/ path is reported (non-zero findings, named)');
}

// ---------------------------------------------------------------------------
// Test 3: a symlink whose target embeds a private repo name is reported
// through the runtime-supplied "Private repo name" category — proving
// symlink targets flow through ALL detection categories, not just one.
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-symlink-reponame-');
  const linkPath = path.join(dir, 'leaky-repo-link');
  const target = `../../${FAKE_PRIVATE_REPO_NAME}/lambda/handler.py`;
  fs.symlinkSync(target, linkPath);

  const categories = [buildPrivateNameCategory([FAKE_PRIVATE_REPO_NAME])];
  const findings = [];
  scanSymlinkTarget(linkPath, findings, categories);

  assert.strictEqual(findings.length, 1, `Test 3 FAIL: expected exactly one finding, got ${findings.length}`);
  assert.strictEqual(findings[0].category, 'Private repo name', 'Test 3 FAIL: wrong category attributed');
  console.log('Test 3 passed: a symlink target embedding a private repo name is reported via the private-name category');
}

// ---------------------------------------------------------------------------
// Test 4: scanSymlinkTarget() never dereferences the link — it must not
// attempt to read file content at the (nonexistent/dangling) target, only
// the target string itself. A dangling symlink must not throw or crash.
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-symlink-dangling-');
  const linkPath = path.join(dir, 'dangling-link');
  fs.symlinkSync('/this/path/definitely/does/not/exist/on/any/machine', linkPath);

  const findings = [];
  assert.doesNotThrow(() => {
    scanSymlinkTarget(linkPath, findings, BASE_CATEGORIES);
  }, 'Test 4 FAIL: scanning a dangling symlink target must not throw');
  console.log('Test 4 passed: a dangling symlink target is scanned as a string without dereferencing/throwing');
}

// ---------------------------------------------------------------------------
// Test 5: regression — a clean symlink with an ordinary relative target
// (matching the shape actually shipped today, e.g. "../.agents/skills/x")
// produces zero findings, same as before this change.
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-symlink-clean-');
  const linkPath = path.join(dir, 'clean-link');
  fs.symlinkSync('../.agents/skills/frontend-design', linkPath);

  const findings = [];
  scanSymlinkTarget(linkPath, findings, BASE_CATEGORIES);
  assert.strictEqual(findings.length, 0, 'Test 5 FAIL: an ordinary relative symlink target should produce zero findings');
  console.log('Test 5 passed: an ordinary relative symlink target (no private path) produces zero findings');
}

console.log('\nAll T-505 scan-symlink assertions passed.');
