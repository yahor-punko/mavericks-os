'use strict';
// Regression test: T-534 — mavp-publish-verify-provenance.js (the
// content-provenance gate). Unit-level coverage against synthetic fixtures
// (a throwaway git repo standing in for the private repo, and a synthetic
// assembled-tree directory) — the end-to-end coverage against a real bare
// mirror lives in scripts/test-publish-build.js (Test 30 and neighbors),
// which exercises this module wired into the real build script.
//
// These fixtures deliberately never touch REPO_ROOT (this worktree) or its
// real publish-manifest.json — every manifest, repo and outDir here is
// synthetic and thrown away, so these tests stay fast and independent of
// this repo's own (large, ever-growing) ship set. ONE deliberate exception:
// Test 15 (T-534 round 2) reads this repo's own real committed manifest via
// `git show HEAD:...` as a PINNED CONTROL proving the shape contract accepts
// the manifest unchanged — it never writes anything, and it is the one place
// this file intentionally breaks its own rule above.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mavp-publish-verify-provenance.js');
const {
  verifyAssembledTreeProvenance,
  verifyCommittedTreeProvenance,
  readHeadBlob,
  readAssembledEntry,
  assertGitAvailable,
  validateManifestShape,
  isGitIgnoredInClone,
} = require(SCRIPT);

const tempDirs = [];
function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Builds a throwaway git repo (standing in for the private repo) with a
// given map of { relPath: content } committed at HEAD, and returns its dir.
function makeFixtureRepo(prefix, files) {
  const dir = mkTempDir(prefix);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture User']);
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(path.join(dir, relPath), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture: seed content']);
  return dir;
}

function writeManifest(manifestPath, manifest) {
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// Builds an "assembled tree" directory by literally writing the given map of
// { relPath: content } — standing in for mavp-publish-assemble.js's output,
// without needing to run the real assembler.
function makeAssembledTree(prefix, files) {
  const dir = mkTempDir(prefix);
  for (const [relPath, content] of Object.entries(files)) {
    writeFile(path.join(dir, relPath), content);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Test 1: a clean assembled tree (ship + reset, bytes matching HEAD/starter
// blobs exactly) verifies ok: true.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t1-repo-', {
    'shipped-a.txt': 'ship content A\n',
    'shipped-b/nested.txt': 'ship content B (nested)\n',
    'templates/STARTER_TEMPLATE.md': 'starter template content\n',
    'LIVE_STATE.md': 'this is the LIVE (non-template) content, must never be compared against',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, {
    ship: ['shipped-a.txt', 'shipped-b/nested.txt'],
    reset: { 'LIVE_STATE.md': 'templates/STARTER_TEMPLATE.md' },
  });

  const outDir = makeAssembledTree('mavp-verify-t1-outdir-', {
    'shipped-a.txt': 'ship content A\n',
    'shipped-b/nested.txt': 'ship content B (nested)\n',
    // The reset DESTINATION path is populated with the STARTER's content,
    // exactly as mavp-publish-assemble.js does — never the live content.
    'LIVE_STATE.md': 'starter template content\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    result,
    { ok: true, counts: { ship: 2, reset: 1 } },
    `Test 1 FAIL: expected a clean tree to verify ok with counts, got: ${JSON.stringify(result)}`
  );
  console.log('Test 1 passed: a clean assembled tree (ship + reset content matching HEAD/starter blobs) verifies ok: true, reporting counts {ship:2, reset:1}');
}

// ---------------------------------------------------------------------------
// Test 2: a ship path whose assembled bytes differ from the HEAD blob is
// refused, naming that exact path.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t2-repo-', {
    'shipped-a.txt': 'ORIGINAL ship content\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped-a.txt'], reset: {} });

  const outDir = makeAssembledTree('mavp-verify-t2-outdir-', {
    'shipped-a.txt': 'TAMPERED ship content\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 2 FAIL: expected a content mismatch to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'shipped-a.txt', `Test 2 FAIL: expected the mismatch to name "shipped-a.txt", got: ${JSON.stringify(result)}`);
  assert.ok(/do not match/.test(result.reason), `Test 2 FAIL: expected a content-mismatch reason, got: ${result.reason}`);
  console.log('Test 2 passed: a tampered ship path is refused, naming that exact path');
}

// ---------------------------------------------------------------------------
// Test 3 (TRAP 1 — never a naive per-path HEAD lookup for reset entries): a
// reset destination that is UNTRACKED at HEAD (simulating T-529's
// .claude/settings.json — the destination key itself has no HEAD blob at
// all) must still verify correctly by resolving through the manifest to its
// mapped templates/ starter, which IS tracked. A naive per-path lookup
// (`git show HEAD:<destPath>`) would fail outright here — this proves the
// gate never takes that path.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t3-repo-', {
    'templates/SETTINGS_TEMPLATE.json': '{"starter": true}\n',
    // A non-empty `ship` is mandatory since round 2 (an empty `ship` array
    // is itself a refusal shape — see the manifest-shape tests below); this
    // dummy entry is irrelevant to what Test 3 actually exercises (the
    // reset-destination resolution path) and matches on both sides.
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
  });
  // `.claude/settings.json` (the reset destination key) is deliberately
  // NEVER written into repoDir at all — it has no HEAD blob whatsoever,
  // reproducing the T-529 untracked-reset-key shape exactly.
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, {
    ship: ['dummy-ship.txt'],
    reset: { '.claude/settings.json': 'templates/SETTINGS_TEMPLATE.json' },
  });

  const outDir = makeAssembledTree('mavp-verify-t3-outdir-', {
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
    '.claude/settings.json': '{"starter": true}\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    result,
    { ok: true, counts: { ship: 1, reset: 1 } },
    `Test 3 FAIL: expected the reset destination to verify via its MAPPED starter (untracked destination key notwithstanding), got: ${JSON.stringify(result)}`
  );
  console.log('Test 3 passed: a reset destination untracked at HEAD (T-529 shape) still verifies correctly via its mapped templates/ starter, never a naive per-path HEAD lookup');
}

// ---------------------------------------------------------------------------
// Test 4: a reset destination whose assembled bytes do NOT match its mapped
// starter's HEAD blob is refused, naming the DESTINATION path (not the
// starter path) as the offending manifest entry.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t4-repo-', {
    'templates/BACKLOG_TEMPLATE.md': '# starter backlog\n',
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, {
    ship: ['dummy-ship.txt'],
    reset: { 'BACKLOG.md': 'templates/BACKLOG_TEMPLATE.md' },
  });

  const outDir = makeAssembledTree('mavp-verify-t4-outdir-', {
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
    'BACKLOG.md': '# WRONG content, not the starter\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 4 FAIL: expected a reset-destination mismatch to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'BACKLOG.md', `Test 4 FAIL: expected the mismatch to name the DESTINATION "BACKLOG.md", got: ${JSON.stringify(result)}`);
  assert.ok(/mapped starter/.test(result.reason), `Test 4 FAIL: expected the reason to reference the mapped starter, got: ${result.reason}`);
  console.log('Test 4 passed: a reset destination mismatching its mapped starter is refused, naming the destination path');
}

// ---------------------------------------------------------------------------
// Test 5 (TRAP 2 — never the live on-disk file): the reset destination's
// bytes in the assembled tree happen to equal what a NAIVE read of the
// destination path on the PRIVATE repo's disk would have returned (a
// decoy) — but the gate must still refuse, because the only valid
// comparison target is the mapped starter's HEAD blob, which differs.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t5-repo-', {
    'templates/SETTINGS_TEMPLATE.json': '{"starter": true}\n',
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
    // A decoy on-disk file at the destination path's OWN location, tracked
    // at HEAD with content that matches what the (tampered) assembled tree
    // carries — if the gate ever fell back to comparing against this
    // instead of the mapped starter, it would wrongly pass.
    '.claude/settings.json': '{"decoy": "matches assembled tree, must never be the comparison target"}\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, {
    ship: ['dummy-ship.txt'],
    reset: { '.claude/settings.json': 'templates/SETTINGS_TEMPLATE.json' },
  });

  const outDir = makeAssembledTree('mavp-verify-t5-outdir-', {
    'dummy-ship.txt': 'dummy ship content, irrelevant to this test\n',
    '.claude/settings.json': '{"decoy": "matches assembled tree, must never be the comparison target"}\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 5 FAIL: expected refusal — the assembled bytes match a DECOY at the destination path's own HEAD location, not the mapped starter, and must still be refused, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, '.claude/settings.json', `Test 5 FAIL: unexpected path in result: ${JSON.stringify(result)}`);
  console.log('Test 5 passed: a reset destination matching a decoy at its OWN HEAD path (not its mapped starter) is still refused — the destination path itself is never a valid comparison target');
}

// ---------------------------------------------------------------------------
// Test 6: a symlink ship entry compares readlink() target bytes against the
// HEAD blob (which, for a tracked symlink, IS the target string) — not by
// following the link and reading whatever it resolves to.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t6-repo-', {
    'real-target-dir/file.txt': 'irrelevant content at the resolved target\n',
  });
  // Create a tracked symlink in the fixture repo pointing at the real dir.
  fs.symlinkSync('real-target-dir', path.join(repoDir, 'shipped-symlink'));
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'fixture: add tracked symlink']);

  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped-symlink'], reset: {} });

  const outDir = makeAssembledTree('mavp-verify-t6-outdir-', {});
  fs.symlinkSync('real-target-dir', path.join(outDir, 'shipped-symlink'));

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    result,
    { ok: true, counts: { ship: 1, reset: 0 } },
    `Test 6 FAIL: expected a matching symlink target to verify ok, got: ${JSON.stringify(result)}`
  );
  console.log('Test 6 passed: a symlink ship entry is compared by its link-target string against the HEAD blob, matching git\'s own symlink storage');

  // Companion: a symlink whose TARGET STRING differs is refused.
  const outDirMismatch = makeAssembledTree('mavp-verify-t6b-outdir-', {});
  fs.symlinkSync('a-different-target', path.join(outDirMismatch, 'shipped-symlink'));
  const mismatchResult = verifyAssembledTreeProvenance(outDirMismatch, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(mismatchResult.ok, false, `Test 6b FAIL: expected a differing symlink target to refuse, got: ${JSON.stringify(mismatchResult)}`);
  assert.strictEqual(mismatchResult.path, 'shipped-symlink', `Test 6b FAIL: unexpected path: ${JSON.stringify(mismatchResult)}`);
  console.log('Test 6b passed: a symlink ship entry whose target string differs from the tracked symlink blob is refused');
}

// ---------------------------------------------------------------------------
// Test 7: a ship path missing entirely from the assembled tree is refused,
// naming that path — never silently skipped.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t7-repo-', { 'present.txt': 'content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['present.txt', 'missing-from-assembled.txt'], reset: {} });

  const outDir = makeAssembledTree('mavp-verify-t7-outdir-', { 'present.txt': 'content\n' });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 7 FAIL: expected a missing assembled path to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'missing-from-assembled.txt', `Test 7 FAIL: unexpected path: ${JSON.stringify(result)}`);
  console.log('Test 7 passed: a ship path missing from the assembled tree is refused, naming that path');
}

// ---------------------------------------------------------------------------
// Test 8 (fail-closed on git unavailable): pointing repoRoot at a directory
// that is not a git repository at all must refuse (never silently pass).
// ---------------------------------------------------------------------------
{
  const notARepo = mkTempDir('mavp-verify-t8-notarepo-');
  const manifestPath = path.join(notARepo, 'manifest.json');
  writeManifest(manifestPath, { ship: ['anything.txt'], reset: {} });
  const outDir = makeAssembledTree('mavp-verify-t8-outdir-', { 'anything.txt': 'content\n' });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: notARepo });
  assert.strictEqual(result.ok, false, `Test 8 FAIL: expected a non-git repoRoot to fail closed, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, null, `Test 8 FAIL: expected a whole-run failure (path: null), got: ${JSON.stringify(result)}`);
  assert.ok(/not a usable git repository|not available/.test(result.reason), `Test 8 FAIL: expected a git-unavailable reason, got: ${result.reason}`);

  const availability = assertGitAvailable(notARepo);
  assert.strictEqual(availability.ok, false, 'Test 8 FAIL: assertGitAvailable() must also report false directly for a non-git directory');
  console.log('Test 8 passed: a repoRoot that is not a usable git repository fails CLOSED (refusal), never silently passes');
}

// ---------------------------------------------------------------------------
// Test 9: a manifest that cannot be read/parsed fails closed.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t9-repo-', { 'a.txt': 'content\n' });
  const manifestPath = path.join(repoDir, 'does-not-exist-manifest.json');
  const outDir = makeAssembledTree('mavp-verify-t9-outdir-', {});

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 9 FAIL: expected a missing manifest to fail closed, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, null, `Test 9 FAIL: expected a whole-run failure (path: null), got: ${JSON.stringify(result)}`);
  console.log('Test 9 passed: an unreadable manifest fails closed');
}

// ---------------------------------------------------------------------------
// Test 10 (mutant kill — "compare the assembled tree against itself"): a
// hollow implementation that reads its "expected" value from the ASSEMBLED
// TREE instead of the HEAD/starter blob would report ok:true for ANY
// content, including deliberately WRONG content that has no relationship to
// HEAD at all. This direct unit call constructs exactly that trap: the
// assembled tree's content has NO relationship whatsoever to the fixture
// repo's real HEAD content, so only a genuine cross-check against HEAD (not
// a self-referential one) can correctly refuse it.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t10-repo-', {
    'shipped.txt': 'THE REAL HEAD CONTENT — never present in the assembled tree below\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'], reset: {} });

  const outDir = makeAssembledTree('mavp-verify-t10-outdir-', {
    'shipped.txt': 'COMPLETELY UNRELATED CONTENT — a self-compare mutant would still call this a match\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 10 FAIL (this is the "compare against itself" mutant kill): the assembled tree's content bears no ` +
      `relationship to the fixture repo's real HEAD content, so the check MUST refuse — a self-referential ` +
      `comparison would incorrectly report ok:true here regardless of content, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, 'shipped.txt', `Test 10 FAIL: unexpected path: ${JSON.stringify(result)}`);
  console.log('Test 10 passed: an assembled tree with content unrelated to HEAD is refused — proves the comparison target is the real HEAD blob, never the assembled tree compared against itself');
}

// ---------------------------------------------------------------------------
// Test 11: CLI entry point — exit 0 on a clean tree, exit 1 (naming the
// path) on a tampered one, and a bare invocation with no <out-dir> prints
// usage and exits 1.
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t11-repo-', { 'a.txt': 'clean content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['a.txt'], reset: {} });

  const cleanOutDir = makeAssembledTree('mavp-verify-t11-clean-outdir-', { 'a.txt': 'clean content\n' });
  const cleanResult = spawnSync(process.execPath, [
    SCRIPT,
    cleanOutDir,
    '--manifest',
    manifestPath,
    '--repo-root',
    repoDir,
  ], { encoding: 'utf8' });
  assert.strictEqual(cleanResult.status, 0, `Test 11a FAIL: expected exit 0 on a clean CLI run, got ${cleanResult.status}:\n${cleanResult.stderr}`);
  assert.ok(/GREEN/.test(cleanResult.stdout), `Test 11a FAIL: expected a GREEN confirmation on stdout, got: ${cleanResult.stdout}`);

  const tamperedOutDir = makeAssembledTree('mavp-verify-t11-tampered-outdir-', { 'a.txt': 'TAMPERED content\n' });
  const tamperedResult = spawnSync(process.execPath, [
    SCRIPT,
    tamperedOutDir,
    '--manifest',
    manifestPath,
    '--repo-root',
    repoDir,
  ], { encoding: 'utf8' });
  assert.notStrictEqual(tamperedResult.status, 0, `Test 11b FAIL: expected non-zero exit on a tampered CLI run, got ${tamperedResult.status}`);
  assert.ok(/ABORT:/.test(tamperedResult.stderr), `Test 11b FAIL: expected an ABORT line on stderr, got: ${tamperedResult.stderr}`);
  assert.ok(/"a\.txt"/.test(tamperedResult.stderr), `Test 11b FAIL: expected the mismatched path named on stderr, got: ${tamperedResult.stderr}`);

  const noArgsResult = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.notStrictEqual(noArgsResult.status, 0, `Test 11c FAIL: expected non-zero exit with no <out-dir> argument, got ${noArgsResult.status}`);
  assert.ok(/Usage:/.test(noArgsResult.stderr), `Test 11c FAIL: expected a usage line on stderr, got: ${noArgsResult.stderr}`);

  console.log('Test 11 passed: CLI entry point exits 0 with a GREEN message on a clean tree, exits non-zero naming the mismatched path on a tampered tree, and prints usage + exits non-zero with no <out-dir>');
}

// ---------------------------------------------------------------------------
// T-534 ROUND 2 — manifest shape contract (criterion 1): Tests 12a/12b/13/14/15
// ---------------------------------------------------------------------------

// Test 12a (round-1 reviewer's reproduction #1, verbatim): `reset` absent
// entirely used to default to {} and report ok:true having verified reset
// paths that were never checked. Now refused before any path is compared.
{
  const repoDir = makeFixtureRepo('mavp-verify-t12a-repo-', { 'shipped.txt': 'content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'] }); // `reset` deliberately absent
  const outDir = makeAssembledTree('mavp-verify-t12a-outdir-', { 'shipped.txt': 'content\n' });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 12a FAIL: expected an absent 'reset' key to refuse (round-1 reviewer's reproduction #1), got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, null, `Test 12a FAIL: expected a whole-run refusal (path: null), got: ${JSON.stringify(result)}`);
  assert.ok(/reset.*missing/i.test(result.reason), `Test 12a FAIL: expected a reason naming the missing 'reset' key, got: ${result.reason}`);
  console.log("Test 12a passed: an absent 'reset' key (round-1 reviewer's reproduction #1) is refused, never defaulted to {}");
}

// Test 12b (round-1 reviewer's reproduction #2, verbatim): `ship` as a
// non-array string, WITH a tampered file present in the assembled tree —
// used to default `ship` to [] (verifying zero paths) and report ok:true
// regardless of the tamper. Now refused on the shape alone.
{
  const repoDir = makeFixtureRepo('mavp-verify-t12b-repo-', { 'shipped.txt': 'ORIGINAL content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeFile(manifestPath, JSON.stringify({ ship: 'shipped.txt', reset: {} }) + '\n'); // ship is a STRING
  const outDir = makeAssembledTree('mavp-verify-t12b-outdir-', { 'shipped.txt': 'TAMPERED content\n' });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 12b FAIL: expected a non-array 'ship' (round-1 reviewer's reproduction #2, tamper present) to refuse, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, null, `Test 12b FAIL: expected a whole-run refusal (path: null), got: ${JSON.stringify(result)}`);
  assert.ok(/ship.*missing or not an array/i.test(result.reason), `Test 12b FAIL: expected a reason naming the malformed 'ship', got: ${result.reason}`);
  console.log("Test 12b passed: a non-array 'ship' (round-1 reviewer's reproduction #2, tamper present) is refused on shape alone, before any path comparison");
}

// Test 13: one refusal case per distinct manifest-shape violation, exercised
// directly against validateManifestShape() (a pure function — no fixture
// repos needed for a shape-only check).
{
  const cases = [
    { label: 'top-level array', manifest: ['not', 'an', 'object'], expectRe: /not a plain/ },
    { label: 'top-level null', manifest: null, expectRe: /not a plain/ },
    { label: 'ship missing', manifest: { reset: {} }, expectRe: /ship.*missing or not an array/i },
    { label: 'ship not an array (object)', manifest: { ship: {}, reset: {} }, expectRe: /ship.*missing or not an array/i },
    { label: 'ship empty array', manifest: { ship: [], reset: {} }, expectRe: /empty array/i },
    { label: 'ship entry not a string', manifest: { ship: [42], reset: {} }, expectRe: /not a valid relative path/i },
    { label: 'ship entry empty string', manifest: { ship: [''], reset: {} }, expectRe: /not a valid relative path/i },
    { label: 'ship entry leading slash', manifest: { ship: ['/etc/passwd'], reset: {} }, expectRe: /not a valid relative path/i },
    { label: 'ship entry traversal', manifest: { ship: ['a/../../etc/passwd'], reset: {} }, expectRe: /not a valid relative path/i },
    // T-534 round 4 (criterion 3, LOW rider) — a bare "." segment, distinct
    // from the ".." traversal case above.
    { label: 'ship entry bare-dot segment', manifest: { ship: ['a/./b.txt'], reset: {} }, expectRe: /not a valid relative path/i },
    { label: 'reset missing', manifest: { ship: ['a.txt'] }, expectRe: /reset.*missing/i },
    { label: 'reset is an array', manifest: { ship: ['a.txt'], reset: [] }, expectRe: /not a plain \(non-array\) object/ },
    {
      label: 'reset destination key traversal',
      manifest: { ship: ['a.txt'], reset: { '../escape': 'templates/X.md' } },
      expectRe: /reset destination key/i,
    },
    { label: 'reset value invalid', manifest: { ship: ['a.txt'], reset: { 'dest.md': '' } }, expectRe: /mapped starter/i },
  ];
  for (const { label, manifest, expectRe } of cases) {
    const result = validateManifestShape(manifest);
    assert.strictEqual(result.ok, false, `Test 13 FAIL (${label}): expected a shape refusal, got: ${JSON.stringify(result)}`);
    assert.ok(expectRe.test(result.reason), `Test 13 FAIL (${label}): reason did not match ${expectRe}, got: ${result.reason}`);
  }
  console.log(`Test 13 passed: ${cases.length} distinct manifest-shape refusal cases each refuse with a shape-specific reason`);
}

// Test 14 (the false-refusal boundary — deliberately TOLERATED shapes): an
// explicitly-present empty `reset: {}`, and unknown top-level keys
// (reset_reasons/preserve/exclude belong to other tools) must both pass.
{
  const tolerated = [
    { label: 'explicit empty reset', manifest: { ship: ['a.txt'], reset: {} } },
    {
      label: 'unknown top-level keys',
      manifest: { ship: ['a.txt'], reset: {}, reset_reasons: {}, preserve: {}, exclude: {} },
    },
  ];
  for (const { label, manifest } of tolerated) {
    const result = validateManifestShape(manifest);
    assert.deepStrictEqual(result, { ok: true }, `Test 14 FAIL (${label}): expected this deliberately-tolerated shape to pass, got: ${JSON.stringify(result)}`);
  }
  console.log('Test 14 passed: an explicitly-present empty `reset: {}` and unknown top-level keys are deliberately tolerated (the false-refusal boundary)');
}

// Test 15 (PINNED CONTROL): this repo's own real, committed
// scripts/publish-manifest.json (read via HEAD, never disk) passes the
// shape contract unchanged — the one deliberate exception to this file's
// "never touch REPO_ROOT" rule (see the file header note).
{
  const pinnedControlRepoRoot = path.resolve(__dirname, '..');
  const realManifestRaw = execFileSync('git', ['show', 'HEAD:scripts/publish-manifest.json'], {
    cwd: pinnedControlRepoRoot,
    encoding: 'utf8',
  });
  const realManifest = JSON.parse(realManifestRaw);
  const result = validateManifestShape(realManifest);
  assert.deepStrictEqual(
    result,
    { ok: true },
    `Test 15 FAIL: expected this repo's own real committed manifest to pass shape validation unchanged, got: ${JSON.stringify(result)}`
  );
  console.log("Test 15 passed (pinned control): this repo's own real committed scripts/publish-manifest.json passes the shape contract unchanged");
}

// ---------------------------------------------------------------------------
// T-534 ROUND 2 — HEAD-anchored manifest read (criterion 2): Test 16
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t16-repo-', {
    'scripts/publish-manifest.json': JSON.stringify({ ship: ['shipped-a.txt', 'shipped-b.txt'], reset: {} }, null, 2) + '\n',
    'shipped-a.txt': 'content A\n',
    'shipped-b.txt': 'content B\n',
  });

  // Narrow the manifest ON DISK, WITHOUT committing — dropping shipped-b.txt.
  fs.writeFileSync(
    path.join(repoDir, 'scripts', 'publish-manifest.json'),
    JSON.stringify({ ship: ['shipped-a.txt'], reset: {} }, null, 2) + '\n'
  );
  const dirtyStatus = git(repoDir, ['status', '--porcelain']);
  assert.ok(/publish-manifest\.json/.test(dirtyStatus), 'Test 16 setup FAIL: expected the on-disk manifest edit to be uncommitted');

  // The assembled tree matches the NARROWED (disk) manifest exactly — it is
  // MISSING shipped-b.txt, which the committed (HEAD) manifest still
  // declares. If the default read used disk, this would wrongly pass.
  const outDir = makeAssembledTree('mavp-verify-t16-outdir-', { 'shipped-a.txt': 'content A\n' });

  const result = verifyAssembledTreeProvenance(outDir, { repoRoot: repoDir }); // NO manifestPath — default path
  assert.strictEqual(
    result.ok,
    false,
    `Test 16 FAIL: expected the HEAD-anchored default to still see shipped-b.txt (from the committed manifest) and refuse, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(
    result.path,
    'shipped-b.txt',
    `Test 16 FAIL: expected the missing HEAD-declared path "shipped-b.txt" to be named, got: ${JSON.stringify(result)}`
  );
  console.log('Test 16 passed: an uncommitted disk-manifest edit cannot narrow the verified set via the default (HEAD-anchored) manifest read');
}

// ---------------------------------------------------------------------------
// T-534 ROUND 2 — completeness sweep (criterion 3): Test 17
// ---------------------------------------------------------------------------
{
  const repoDir = makeFixtureRepo('mavp-verify-t17-repo-', { 'shipped.txt': 'clean content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'], reset: {} });

  const outDir = makeAssembledTree('mavp-verify-t17-outdir-', {
    'shipped.txt': 'clean content\n',
    'unexpected-extra-file.txt': 'planted after assembly — not declared anywhere in the manifest\n',
  });

  const result = verifyAssembledTreeProvenance(outDir, { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 17 FAIL: expected an undeclared extra path to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'unexpected-extra-file.txt', `Test 17 FAIL: expected the extra path to be named, got: ${JSON.stringify(result)}`);
  assert.ok(/unexpected addition/.test(result.reason), `Test 17 FAIL: expected an "unexpected addition" reason, got: ${result.reason}`);
  console.log('Test 17 passed (mutant kill — sweep deletion): an assembled tree containing an undeclared extra path (a post-assembly addition) is refused by the completeness sweep, naming that exact path — every ship/reset path is present and byte-correct, so no other check would have caught this');
}

// ---------------------------------------------------------------------------
// T-534 ROUND 2 — committed-tree certification (criterion 4): Tests 18-23
// ---------------------------------------------------------------------------

// Test 18: a clean committed clone tree (ship + reset, content AND mode
// matching HEAD/starter) verifies ok:true.
{
  const repoDir = makeFixtureRepo('mavp-verify-t18-repo-', {
    'shipped.txt': 'ship content\n',
    'templates/STARTER.md': 'starter content\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'], reset: { 'LIVE.md': 'templates/STARTER.md' } });

  const cloneDir = makeFixtureRepo('mavp-verify-t18-clone-', {
    'shipped.txt': 'ship content\n',
    'LIVE.md': 'starter content\n',
  });

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    result,
    { ok: true, counts: { ship: 1, reset: 1 } },
    `Test 18 FAIL: expected a clean committed tree to verify ok, got: ${JSON.stringify(result)}`
  );
  console.log('Test 18 passed: verifyCommittedTreeProvenance() verifies a clean committed clone tree ok:true against HEAD/starter blobs');
}

// Test 19 (T-534 round 2 MEDIUM, closed): a committed ship path whose bytes
// differ from the private repo's HEAD blob is refused — even though this is
// exactly the class verifyAssembledTreeProvenance() (step 6.5) cannot see,
// since it never re-reads the clone after commit.
{
  const repoDir = makeFixtureRepo('mavp-verify-t19-repo-', { 'shipped.txt': 'ORIGINAL content\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'], reset: {} });

  const cloneDir = makeFixtureRepo('mavp-verify-t19-clone-', { 'shipped.txt': 'CORRUPTED content\n' });

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 19 FAIL: expected a committed-tree content mismatch to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'shipped.txt', `Test 19 FAIL: unexpected path: ${JSON.stringify(result)}`);
  assert.ok(/do not match the private/.test(result.reason), `Test 19 FAIL: expected a content-mismatch reason, got: ${result.reason}`);
  console.log('Test 19 passed: a committed ship path whose bytes differ from the private repo HEAD blob is refused — this is the MEDIUM this task closes structurally');
}

// Test 20: a committed reset destination mismatching its mapped starter's
// HEAD blob is refused, naming the destination path.
{
  const repoDir = makeFixtureRepo('mavp-verify-t20-repo-', {
    'dummy.txt': 'dummy ship content\n',
    'templates/STARTER.md': 'starter content\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['dummy.txt'], reset: { 'LIVE.md': 'templates/STARTER.md' } });

  const cloneDir = makeFixtureRepo('mavp-verify-t20-clone-', {
    'dummy.txt': 'dummy ship content\n',
    'LIVE.md': 'WRONG content, not the starter\n',
  });

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.strictEqual(result.ok, false, `Test 20 FAIL: expected a committed reset-destination mismatch to refuse, got: ${JSON.stringify(result)}`);
  assert.strictEqual(result.path, 'LIVE.md', `Test 20 FAIL: unexpected path: ${JSON.stringify(result)}`);
  assert.ok(/mapped starter/.test(result.reason), `Test 20 FAIL: expected a reason referencing the mapped starter, got: ${result.reason}`);
  console.log("Test 20 passed: a committed reset destination mismatching its mapped starter's HEAD blob is refused, naming the destination path");
}

// Test 21 (T-529 residual, NOT a false refusal): a reset destination
// gitignored in the clone never reaches the committed git tree via
// `git add -A` — this must be SKIPPED, not refused as a missing path.
{
  const repoDir = makeFixtureRepo('mavp-verify-t21-repo-', {
    'dummy.txt': 'dummy ship content\n',
    'templates/SETTINGS.json': '{"starter": true}\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['dummy.txt'], reset: { '.claude/settings.json': 'templates/SETTINGS.json' } });

  const cloneDir = makeFixtureRepo('mavp-verify-t21-clone-', { 'dummy.txt': 'dummy ship content\n' });
  writeFile(path.join(cloneDir, '.gitignore'), '.claude/settings.json\n');
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-q', '-m', 'fixture: gitignore the reset destination']);
  // Present on DISK (as the overlay would leave it) but gitignored, so
  // `git add -A` never staged it — it has no committed git-tree entry.
  writeFile(path.join(cloneDir, '.claude/settings.json'), '{"starter": true}\n');

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    result,
    { ok: true, counts: { ship: 1, reset: 1 } },
    `Test 21 FAIL: expected a gitignored-in-clone reset destination to be skipped (T-529 residual), not refused, got: ${JSON.stringify(result)}`
  );
  console.log('Test 21 passed: a reset destination gitignored in the clone (T-529 residual — never reaches the committed git tree) is skipped, not falsely refused');
}

// Test 22 (mutant kill — mode-check deletion): a committed file whose
// CONTENT is byte-identical to the private repo's HEAD blob but whose
// git-tree MODE differs (an exec-bit flip) is refused. A blob-only
// comparison would have missed this entirely.
{
  const repoDir = makeFixtureRepo('mavp-verify-t22-repo-', { 'scripts/tool': '#!/bin/sh\necho hi\n' });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['scripts/tool'], reset: {} });

  const cloneDir = mkTempDir('mavp-verify-t22-clone-');
  execFileSync('git', ['init', '-q', '-b', 'main', cloneDir]);
  git(cloneDir, ['config', 'user.email', 'fixture@example.invalid']);
  git(cloneDir, ['config', 'user.name', 'Fixture User']);
  writeFile(path.join(cloneDir, 'scripts/tool'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(cloneDir, 'scripts/tool'), 0o755); // exec-bit flip; content byte-identical
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-q', '-m', 'fixture: commit with an exec-bit flip (content identical)']);

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 22 FAIL: expected a content-identical exec-bit flip to refuse on MODE alone, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, 'scripts/tool', `Test 22 FAIL: unexpected path: ${JSON.stringify(result)}`);
  assert.ok(/git-tree mode/.test(result.reason), `Test 22 FAIL: expected a mode-mismatch reason, got: ${result.reason}`);
  console.log('Test 22 passed (mutant kill — mode-check deletion): a content-identical exec-bit flip on the committed tree is refused by the git-tree MODE comparison alone — a blob-only comparison would have missed it');
}

// Test 23 (mutant kill — clone-side SELF-COMPARE): a hollow implementation
// that reads the clone's OWN committed blob twice (instead of cross-checking
// the private repo's real HEAD) would report ok:true for ANY clone content.
// This fixture's clone content bears NO relationship to the private repo's
// real HEAD content, so only a genuine cross-repo comparison can refuse it —
// the e2e seam (scripts/test-publish-build.js) cannot discriminate this
// mutant, since a real clean pipeline run produces byte-correct output
// regardless of which comparison target the verifier used internally (same
// reasoning as Test 10 above, and as Test 30c's own comment documents).
{
  const repoDir = makeFixtureRepo('mavp-verify-t23-repo-', {
    'shipped.txt': 'THE REAL PRIVATE-REPO HEAD CONTENT — never present in the clone below\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['shipped.txt'], reset: {} });

  const cloneDir = makeFixtureRepo('mavp-verify-t23-clone-', {
    'shipped.txt':
      'COMPLETELY UNRELATED CLONE CONTENT — a self-compare mutant (reading the committed blob twice instead ' +
      'of cross-checking the private repo HEAD) would still call this a match\n',
  });

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 23 FAIL (this is the clone-side "self-compare" mutant kill): the clone's committed content bears no ` +
      `relationship to the private repo's real HEAD content, so the check MUST refuse, got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, 'shipped.txt', `Test 23 FAIL: unexpected path: ${JSON.stringify(result)}`);
  console.log(
    "Test 23 passed: a committed clone tree whose content bears no relationship to the private repo's real " +
      "HEAD is refused — proves the comparison target is repoRoot's real HEAD blob, never the clone's own " +
      'committed blob read twice (the e2e seam cannot discriminate this; only a unit-level cross-repo fixture can)'
  );
}

// Test 24 (T-534 round 2, criterion 6 — CANARY BYTE ASSERTION): this repo's
// own real committed scripts/publish-crlf-canary.txt actually contains CRLF
// bytes at HEAD, guarding against a future editor/tool silently normalizing
// it to LF (which would quietly defeat the canary's entire purpose without
// any test ever noticing). Read via `git show HEAD:...`, never disk, for
// the same reason every other expected value in this file is — the ONE
// other deliberate REPO_ROOT exception besides Test 15's pinned control.
{
  const pinnedControlRepoRoot = path.resolve(__dirname, '..');
  const canaryHeadBlob = execFileSync('git', ['show', 'HEAD:scripts/publish-crlf-canary.txt'], {
    cwd: pinnedControlRepoRoot,
  });
  assert.ok(
    canaryHeadBlob.includes(Buffer.from('\r\n')),
    'Test 24 FAIL: expected scripts/publish-crlf-canary.txt\'s HEAD blob to contain CRLF bytes — if this fails, ' +
      'something (an editor, a tool, a git config) normalized the canary to LF, silently defeating its purpose'
  );
  console.log("Test 24 passed (canary byte assertion): scripts/publish-crlf-canary.txt's HEAD blob still contains real CRLF bytes");
}

// Test 25 (T-534 ROUND 5, criterion 4 — 6.6 RE-KEY REGRESSION, doubling as
// the reviewer's requested live reproduction of finding A): a reset
// destination TRACKED at HEAD's own committed tree, with divergent
// (tampered) bytes, must be FULLY VERIFIED AND REFUSED even when a
// working-tree `.gitignore` matches it — never silently skipped.
//
// Constructing this live requires an index/ref DIVERGENCE, because real git
// never lets a path be BOTH present in a ref's committed tree AND reported
// "ignored" by the SAME, synchronized index (isGitIgnoredInClone() is
// index-based; a path in the index is never reported ignored — see that
// function's own comment). So: commit the destination TRACKED with
// tampered bytes (HEAD's tree now has it), then `git rm --cached` it
// WITHOUT a further commit — HEAD's tree still carries the tampered blob
// (nothing was re-committed), but the INDEX no longer tracks it, so
// `check-ignore` now reports it ignored once a matching `.gitignore` is
// added. This is exactly the "protection is incidentally correct" residual
// finding A describes: the OLD ignore-only-keyed skip would silently pass
// this (isGitIgnoredInClone() alone reports true); the RE-KEYED skip below
// requires ALSO being absent from the committed tree at `ref` — which this
// fixture's `ref` (HEAD) is NOT, so it is never skipped, and refuses on the
// genuine content mismatch. Named mutant: reverting the re-keyed condition
// back to `if (isGitIgnoredInClone(cloneDir, destPath)) continue;` alone
// turns this red (see the report's live mutant-kill quote).
//
// SCOPE NOTE (T-534 round 6): the index/ref divergence this fixture
// constructs (`git rm --cached` with no further commit) is UNREACHABLE at
// the real pipeline's own call point — `--dry-run` still commits, and a
// no-new-commit run stages nothing, so the clone's index equals its HEAD
// tree there. Test 25 therefore pins `verifyCommittedTreeProvenance()`'s
// own untrusted-input contract as an exported, standalone-callable
// primitive, not a reproduction of any state the pipeline itself can reach
// today. This does NOT weaken 6.6's re-key: its two checks read two
// DIFFERENT stores (a caller-supplied ref and the index) that genuinely
// diverge within the function's declared domain, and a certifying gate
// over an untrusted, persistent on-disk clone must not assume the
// pipeline's own well-formedness — unlike the binder re-key (see Test 40's
// header), this one is mutant-killable right here, not merely
// invariant-conditioned.
{
  const repoDir = makeFixtureRepo('mavp-verify-t25-repo-', {
    'dummy.txt': 'dummy ship content\n',
    'templates/SETTINGS.json': '{"starter": true}\n',
  });
  const manifestPath = path.join(repoDir, 'manifest.json');
  writeManifest(manifestPath, { ship: ['dummy.txt'], reset: { '.claude/settings.json': 'templates/SETTINGS.json' } });

  // Tampered case: destination committed TRACKED with bytes divergent from
  // the mapped starter, then unstaged from the index (HEAD keeps the
  // tampered blob), then a matching .gitignore is added on disk.
  const cloneDir = makeFixtureRepo('mavp-verify-t25-clone-', {
    'dummy.txt': 'dummy ship content\n',
    '.claude/settings.json': '{"starter": true, "TAMPERED": true}\n',
  });
  git(cloneDir, ['rm', '--cached', '-q', '.claude/settings.json']);
  writeFile(path.join(cloneDir, '.gitignore'), '.claude/settings.json\n');

  // Sanity: this fixture must actually exercise finding A's TRUE premise —
  // check-ignore reports the (now-unstaged) destination ignored — or the
  // repro proves nothing.
  assert.strictEqual(
    isGitIgnoredInClone(cloneDir, '.claude/settings.json'),
    true,
    'Test 25 setup FAIL: expected check-ignore to report the destination ignored once unstaged from the index ' +
      '— if not, this fixture is not exercising the reported shape at all'
  );

  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.strictEqual(
    result.ok,
    false,
    `Test 25 FAIL: expected a committed-tree-tracked, ignore-matched reset destination with tampered bytes to ` +
      `be REFUSED (never silently skipped), got: ${JSON.stringify(result)}`
  );
  assert.strictEqual(result.path, '.claude/settings.json', `Test 25 FAIL: unexpected path: ${JSON.stringify(result)}`);
  assert.ok(
    /mapped starter/.test(result.reason),
    `Test 25 FAIL: expected a content-mismatch reason referencing the mapped starter, got: ${result.reason}`
  );

  // Control: same shape (committed-tracked, then unstaged, then
  // gitignored), bytes matching the starter exactly — passes.
  const controlCloneDir = makeFixtureRepo('mavp-verify-t25-control-clone-', {
    'dummy.txt': 'dummy ship content\n',
    '.claude/settings.json': '{"starter": true}\n',
  });
  git(controlCloneDir, ['rm', '--cached', '-q', '.claude/settings.json']);
  writeFile(path.join(controlCloneDir, '.gitignore'), '.claude/settings.json\n');
  assert.strictEqual(
    isGitIgnoredInClone(controlCloneDir, '.claude/settings.json'),
    true,
    'Test 25 FAIL (control setup): expected check-ignore to report the control destination ignored too'
  );
  const controlResult = verifyCommittedTreeProvenance(controlCloneDir, 'HEAD', { manifestPath, repoRoot: repoDir });
  assert.deepStrictEqual(
    controlResult,
    { ok: true, counts: { ship: 1, reset: 1 } },
    `Test 25 FAIL (control): expected a committed-tree-tracked, ignore-matched destination with matching bytes ` +
      `and mode to verify ok, got: ${JSON.stringify(controlResult)}`
  );

  console.log(
    'Test 25 passed (round 5, criterion 4 — 6.6 regression / live reproduction): a reset destination present ' +
      'in the committed tree at ref is fully verified regardless of an ignore match on the (now out of sync) ' +
      'index, refusing on a genuine content mismatch and passing on a matching control'
  );
}

// Test 26 (T-534 ROUND 6 — THE ENABLING-INVARIANT PIN for BOTH re-keyed
// skip sites, in mavp-publish-build.js's bindStagedFileModesToHeadOrAbort()
// and this module's own verifyCommittedTreeProvenance()): both re-keys read
// "skip <=> absent AND ignored" rather than "skip <=> ignored" alone, and
// that only differs from ignore-only keying when a TRACKED path can still
// be reported ignored — which never happens, because `git check-ignore`
// never reports a path present in the index as ignored. Written THROUGH
// isGitIgnoredInClone() plus a LIVE `git add -A`, never against raw `git
// check-ignore` directly: a raw-git assertion would pin git's own
// behaviour but would NOT redden if this codebase's OWN predicate were
// reimplemented (e.g. swapped for `check-ignore --no-index`, or a
// hand-rolled `.gitignore` matcher) — exactly the refactor class both
// re-keyed conditions exist to guard against, per T-534 round 6's ruling
// (see mavp-publish-build.js's binder call-site comment and this module's
// own re-keyed-skip comments for the full reasoning).
//
// Named mutant, run live and reverted (T-534 round 6): reimplementing
// isGitIgnoredInClone() with `spawnSync('git', ['check-ignore', '-q',
// '--no-index', relPath], ...)` turns assertion (a) below red — `--no-index`
// reports a path ignored purely from pattern-matching, IGNORING whether the
// path is tracked, so the tracked+ignore-matched fixture below flips to
// "ignored" and the assertion that it is NOT fails. Reverted immediately
// after confirming the red result; `git log` shows no trace of the mutant.
{
  // The tracked file MUST be committed BEFORE `.gitignore` exists — adding
  // both in the SAME `git add -A` sweep (as makeFixtureRepo's single
  // helper call would) makes git silently exclude the never-before-tracked,
  // now-matched file from the add entirely, so it would never become
  // tracked at all and the fixture would not exercise the claimed shape.
  const repoDir = makeFixtureRepo('mavp-verify-t26-repo-', {
    'tracked-match.txt': 'tracked original content\n',
  });
  writeFile(path.join(repoDir, '.gitignore'), 'tracked-match.txt\nuntracked-match.txt\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'fixture: add .gitignore after tracked-match.txt is already tracked']);

  // (a) a TRACKED file matching a .gitignore pattern -> the predicate
  // returns false. This is the assertion the `--no-index` mutant kills.
  assert.strictEqual(
    isGitIgnoredInClone(repoDir, 'tracked-match.txt'),
    false,
    'Test 26 FAIL (a): expected isGitIgnoredInClone to return false for a TRACKED path matching a .gitignore ' +
      'pattern — if this fails, the enabling invariant both re-keyed skip sites depend on no longer holds'
  );

  // (b) modifying that tracked file and running `git add -A` DOES stage the
  // modification — ignore rules never shield a path already tracked.
  writeFile(path.join(repoDir, 'tracked-match.txt'), 'tracked MODIFIED content\n');
  git(repoDir, ['add', '-A']);
  const stagedAfterModify = git(repoDir, ['diff', '--cached', '--name-only']).trim();
  assert.strictEqual(
    stagedAfterModify,
    'tracked-match.txt',
    `Test 26 FAIL (b): expected the tracked, ignore-matched file's modification to be staged by 'git add -A', ` +
      `got staged paths: ${JSON.stringify(stagedAfterModify)}`
  );

  // (c) control: an UNTRACKED file matching the same pattern -> the
  // predicate returns true, and 'git add -A' does not stage it.
  writeFile(path.join(repoDir, 'untracked-match.txt'), 'untracked content\n');
  assert.strictEqual(
    isGitIgnoredInClone(repoDir, 'untracked-match.txt'),
    true,
    'Test 26 FAIL (c control): expected isGitIgnoredInClone to return true for an UNTRACKED path matching a ' +
      '.gitignore pattern'
  );
  git(repoDir, ['add', '-A']);
  const stagedAfterControl = git(repoDir, ['diff', '--cached', '--name-only']).trim().split('\n');
  assert.ok(
    !stagedAfterControl.includes('untracked-match.txt'),
    `Test 26 FAIL (c control): expected the untracked, ignore-matched file to remain unstaged after 'git add -A', ` +
      `got staged paths: ${JSON.stringify(stagedAfterControl)}`
  );

  console.log(
    'Test 26 passed (round 6 — enabling-invariant pin for both re-keyed skip sites): a TRACKED path matching a ' +
      '.gitignore pattern is never reported ignored and its modification is always staged by git add -A, while ' +
      'a genuinely UNTRACKED, ignore-matched path is reported ignored and never staged'
  );
}

console.log('\nAll T-534 (content-provenance gate, unit-level) assertions passed.');
