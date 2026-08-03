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
    console.log('[SKIP] Test 4 skipped: not the canonical (private) repo — the manifest completeness invariant only holds against the private tracked set');
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

// ---------------------------------------------------------------------------
// T-504 — deletion-ratio guard: refuse mass delete without explicit override.
// ---------------------------------------------------------------------------

// Test 5: an EMPTY assembled tree against a populated clone is refused
// (non-zero exit) and performs NO writes — the clone's files are all still
// present, byte-identical.
{
  const assembledDir = mkTempDir('mavp-overlay-t504-empty-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t504-populated-clone-');

  const readmeContent = 'readme content\n';
  const toolContent = 'console.log("tool");\n';
  const changelogContent = 'changelog content\n';
  writeFile(path.join(cloneDir, 'README.md'), readmeContent);
  writeFile(path.join(cloneDir, 'scripts', 'tool.js'), toolContent);
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent);
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  // assembledDir stays empty (mkTempDir already created it).

  const before = {
    'README.md': fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8'),
    'scripts/tool.js': fs.readFileSync(path.join(cloneDir, 'scripts', 'tool.js'), 'utf8'),
    'CHANGELOG.md': fs.readFileSync(path.join(cloneDir, 'CHANGELOG.md'), 'utf8'),
  };

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );

  assert.notStrictEqual(result.status, 0, `Test 5 FAIL: expected non-zero exit refusing the empty-tree overlay, got ${result.status}`);
  assert.ok(/refusing to overlay/.test(result.stderr), `Test 5 FAIL: expected a refusal message on stderr, got: ${result.stderr}`);
  assert.ok(/3 of 3/.test(result.stderr), `Test 5 FAIL: expected refusal message to state counts (3 of 3), got: ${result.stderr}`);
  assert.ok(/50\.0%/.test(result.stderr), `Test 5 FAIL: expected refusal message to state the threshold, got: ${result.stderr}`);

  // No-writes proof: every clone file is still present, byte-identical.
  for (const [relPath, content] of Object.entries(before)) {
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, relPath), 'utf8'),
      content,
      `Test 5 FAIL: ${relPath} was modified despite the refusal (no-writes guarantee violated)`
    );
  }
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, '.git', 'config'), 'utf8'),
    '[core]\n\trepositoryformatversion = 0\n',
    'Test 5 FAIL: .git/config was modified despite the refusal'
  );
  console.log('Test 5 passed: empty assembled tree vs populated clone is refused with no writes (byte-identical proof)');
}

// Test 6: a normal incremental overlay (a few files changed, one or two
// deleted) is unaffected by the guard and still succeeds.
{
  const assembledDir = mkTempDir('mavp-overlay-t504-incremental-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t504-incremental-clone-');

  // Clone has 6 non-preserved tracked files; assembled tree updates 2 and
  // drops 2 (2/6 = 33% deleted, well under the 50% default threshold).
  writeFile(path.join(cloneDir, 'README.md'), 'old readme\n');
  writeFile(path.join(cloneDir, 'scripts', 'tool.js'), 'old tool\n');
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), 'old changelog\n');
  writeFile(path.join(cloneDir, 'stale-a.md'), 'stale a\n');
  writeFile(path.join(cloneDir, 'stale-b.md'), 'stale b\n');
  writeFile(path.join(cloneDir, 'keep.md'), 'keep me\n');
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  writeFile(path.join(assembledDir, 'README.md'), 'NEW readme\n');
  writeFile(path.join(assembledDir, 'scripts', 'tool.js'), 'NEW tool\n');
  writeFile(path.join(assembledDir, 'CHANGELOG.md'), 'old changelog\n');
  writeFile(path.join(assembledDir, 'keep.md'), 'keep me\n');

  const output = execFileSync('node', [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' });
  assert.ok(/copied 4, deleted 2, preserved 0/.test(output), `Test 6 FAIL: unexpected summary line: ${output}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'stale-a.md')), false, 'Test 6 FAIL: stale-a.md should have been deleted');
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'stale-b.md')), false, 'Test 6 FAIL: stale-b.md should have been deleted');
  assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8'), 'NEW readme\n', 'Test 6 FAIL: README.md not overwritten');
  console.log('Test 6 passed: normal incremental overlay (2/6 = 33% deleted) is unaffected by the T-504 guard');
}

// Test 7: an intentional large deletion is refused WITHOUT the override,
// then proceeds WITH --allow-mass-delete.
{
  const assembledDir = mkTempDir('mavp-overlay-t504-massdelete-assembled-');
  const cloneDirRefused = mkTempDir('mavp-overlay-t504-massdelete-clone-refused-');
  const cloneDirAllowed = mkTempDir('mavp-overlay-t504-massdelete-clone-allowed-');

  // Clone has 4 non-preserved files; assembled tree keeps only 1 (3/4 = 75%
  // deleted — an intentional large deletion, e.g. a real repo prune).
  for (const dir of [cloneDirRefused, cloneDirAllowed]) {
    writeFile(path.join(dir, 'a.md'), 'a\n');
    writeFile(path.join(dir, 'b.md'), 'b\n');
    writeFile(path.join(dir, 'c.md'), 'c\n');
    writeFile(path.join(dir, 'd.md'), 'd\n');
    writeFile(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  }
  writeFile(path.join(assembledDir, 'a.md'), 'a\n');

  const refusedResult = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDirRefused],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(refusedResult.status, 0, `Test 7 FAIL: expected non-zero exit without --allow-mass-delete, got ${refusedResult.status}`);
  assert.ok(/refusing to overlay/.test(refusedResult.stderr), `Test 7 FAIL: expected refusal message, got: ${refusedResult.stderr}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDirRefused, 'b.md')), true, 'Test 7 FAIL: b.md should NOT have been deleted (refused before any write)');

  const allowedOutput = execFileSync(
    'node',
    [OVERLAY_SCRIPT, assembledDir, cloneDirAllowed, '--allow-mass-delete'],
    { encoding: 'utf8' }
  );
  assert.ok(/copied 1, deleted 3, preserved 0/.test(allowedOutput), `Test 7 FAIL: unexpected summary with --allow-mass-delete: ${allowedOutput}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDirAllowed, 'b.md')), false, 'Test 7 FAIL: b.md should have been deleted with --allow-mass-delete');
  assert.strictEqual(fs.existsSync(path.join(cloneDirAllowed, 'a.md')), true, 'Test 7 FAIL: a.md (still shipped) should remain');
  console.log('Test 7 passed: intentional 75% deletion is refused without --allow-mass-delete, proceeds with it');
}

// Test 8: an empty (or near-empty) clone — the first working-build publish
// bootstrap case — succeeds without a spurious refusal or a division-by-zero.
{
  const assembledDir = mkTempDir('mavp-overlay-t504-firstpublish-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t504-firstpublish-clone-');

  // Clone is a fresh `edge` branch bootstrapped from bare `main`: only .git/
  // plumbing exists, zero tracked content — nonPreservedCloneCount is 0.
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFile(path.join(assembledDir, 'README.md'), 'readme\n');
  writeFile(path.join(assembledDir, 'scripts', 'tool.js'), 'console.log("tool");\n');

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.strictEqual(result.status, 0, `Test 8 FAIL: expected exit 0 on a zero-file clone (first publish), got ${result.status}:\n${result.stderr}`);
  assert.ok(/copied 2, deleted 0, preserved 0/.test(result.stdout), `Test 8 FAIL: unexpected summary: ${result.stdout}`);
  assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8'), 'readme\n', 'Test 8 FAIL: README.md not copied on first publish');
  console.log('Test 8 passed: zero-file clone (first working-build publish bootstrap) succeeds — no division-by-zero, no spurious refusal');
}

// Test 9: planDeletion()/parseArgs() unit-level checks — the ratio math and
// flag parsing directly, independent of the CLI subprocess plumbing above.
{
  const { planDeletion, parseArgs, DEFAULT_MAX_DELETE_RATIO } = require('./mavp-publish-overlay.js');

  assert.strictEqual(DEFAULT_MAX_DELETE_RATIO, 0.5, 'Test 9 FAIL: expected default max-delete-ratio of 0.5');

  const plan = planDeletion(
    ['a.md', 'b.md', 'preserved/x.md'],
    new Set(['a.md']),
    ['preserved/']
  );
  assert.deepStrictEqual(plan.deletionCandidates, ['b.md'], 'Test 9 FAIL: unexpected deletionCandidates');
  assert.deepStrictEqual(plan.preservedPaths, ['preserved/x.md'], 'Test 9 FAIL: unexpected preservedPaths');
  assert.strictEqual(plan.nonPreservedCloneCount, 2, 'Test 9 FAIL: expected nonPreservedCloneCount to exclude the preserved path');

  const emptyPlan = planDeletion([], new Set(), []);
  assert.strictEqual(emptyPlan.nonPreservedCloneCount, 0, 'Test 9 FAIL: expected 0 denominator on an empty clone');
  assert.deepStrictEqual(emptyPlan.deletionCandidates, [], 'Test 9 FAIL: expected no deletion candidates on an empty clone');

  const parsedDefault = parseArgs(['/a', '/b']);
  assert.strictEqual(parsedDefault.allowMassDelete, false, 'Test 9 FAIL: allowMassDelete should default to false');
  assert.strictEqual(parsedDefault.maxDeleteRatio, DEFAULT_MAX_DELETE_RATIO, 'Test 9 FAIL: maxDeleteRatio should default to DEFAULT_MAX_DELETE_RATIO');
  assert.deepStrictEqual(parsedDefault.positional, ['/a', '/b'], 'Test 9 FAIL: unexpected positional args');

  const parsedFlags = parseArgs(['/a', '--allow-mass-delete', '/b', '--max-delete-ratio', '0.75']);
  assert.strictEqual(parsedFlags.allowMassDelete, true, 'Test 9 FAIL: expected --allow-mass-delete to be parsed true');
  assert.strictEqual(parsedFlags.maxDeleteRatio, 0.75, 'Test 9 FAIL: expected --max-delete-ratio value to be parsed');
  assert.deepStrictEqual(parsedFlags.positional, ['/a', '/b'], 'Test 9 FAIL: flags should not leak into positional args');

  console.log('Test 9 passed: planDeletion()/parseArgs() unit-level ratio and flag-parsing checks');
}

// ---------------------------------------------------------------------------
// T-507 — per-directory composition guard: refines the T-504 whole-clone
// ratio to also catch a manifest edit that drops whole directories from the
// ship set while the overall file COUNT stays inflated by other, unrelated
// tracked paths — a bypass the whole-clone ratio alone cannot see.
// ---------------------------------------------------------------------------

// Test 10: the reproduced bypass — an entire directory (docs/core/, 6 files)
// is dropped from the ship set, while 40 unrelated padding files elsewhere in
// the clone are left untouched (present in both clone and assembled tree),
// keeping the whole-clone ratio (6 of 46 = ~13%) comfortably under
// DEFAULT_MAX_DELETE_RATIO (50%). The per-directory guard refuses; no writes
// are performed.
{
  const assembledDir = mkTempDir('mavp-overlay-t507-bypass-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t507-bypass-clone-');

  for (let i = 0; i < 6; i++) {
    writeFile(path.join(cloneDir, 'docs', 'core', `page-${i}.md`), `page ${i}\n`);
  }
  for (let i = 0; i < 40; i++) {
    writeFile(path.join(cloneDir, 'padding', `file-${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `file-${i}.md`), `padding ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  // assembledDir deliberately has NOTHING under docs/core/ — the whole
  // directory was dropped from the ship set (the attack this guard exists
  // to catch).

  const before = {};
  for (let i = 0; i < 40; i++) {
    before[`padding/file-${i}.md`] = fs.readFileSync(path.join(cloneDir, 'padding', `file-${i}.md`), 'utf8');
  }
  for (let i = 0; i < 6; i++) {
    before[`docs/core/page-${i}.md`] = fs.readFileSync(path.join(cloneDir, 'docs', 'core', `page-${i}.md`), 'utf8');
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );

  assert.notStrictEqual(
    result.status,
    0,
    `Test 10 FAIL: expected the composition-preserving bypass to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  // Sanity: the whole-clone ratio (6 of 46 =~ 13%) never crosses the 50%
  // DEFAULT_MAX_DELETE_RATIO, so the T-504 whole-clone message must NOT be
  // what refused this run — only the new per-directory guard should fire.
  assert.ok(
    !/planned deletion would remove \d+ of \d+ non-preserved tracked file\(s\) in the clone/.test(result.stderr),
    `Test 10 FAIL: expected the whole-clone ratio guard to stay silent (13% is under 50%) — only the per-directory guard should fire, got: ${result.stderr}`
  );
  assert.ok(/per-directory composition guard/.test(result.stderr), `Test 10 FAIL: expected the per-directory composition guard message, got: ${result.stderr}`);
  assert.ok(/docs\/core/.test(result.stderr), `Test 10 FAIL: expected the refusal to name the docs/core directory, got: ${result.stderr}`);
  assert.ok(/6 of 6/.test(result.stderr), `Test 10 FAIL: expected the refusal to state 6 of 6 deleted in docs/core, got: ${result.stderr}`);
  assert.ok(/100\.0%/.test(result.stderr), `Test 10 FAIL: expected the refusal to state 100.0% for the fully-dropped directory, got: ${result.stderr}`);

  for (const [relPath, content] of Object.entries(before)) {
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, relPath), 'utf8'),
      content,
      `Test 10 FAIL: ${relPath} was modified despite the refusal (no-writes guarantee violated)`
    );
  }
  console.log('Test 10 passed: composition-preserving bypass (whole directory dropped, count padded elsewhere) is refused by the per-directory guard even though the whole-clone ratio clears');
}

// Test 11: ordinary evolution never trips the per-directory guard — adding
// new files/directories (pure additions, never a deletion signal) and
// deleting a SMALL number of files within an existing directory (well under
// the per-directory ratio) both pass.
{
  const assembledDir = mkTempDir('mavp-overlay-t507-ordinary-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t507-ordinary-clone-');

  // docs/core/ has 8 baseline files; 6 are updated in place, 2 are dropped
  // (25% deleted — well under the 50% per-directory ratio).
  for (let i = 0; i < 8; i++) {
    writeFile(path.join(cloneDir, 'docs', 'core', `page-${i}.md`), `old page ${i}\n`);
  }
  for (let i = 0; i < 6; i++) {
    writeFile(path.join(assembledDir, 'docs', 'core', `page-${i}.md`), `new page ${i}\n`);
  }
  // page-6.md and page-7.md are deliberately absent from assembledDir — the
  // small, non-tripping deletion.

  // Pure additions: a brand-new directory that does not exist in the clone
  // at all. Additions must never be treated as a deletion-risk signal.
  for (let i = 0; i < 10; i++) {
    writeFile(path.join(assembledDir, 'docs', 'newstuff', `added-${i}.md`), `added ${i}\n`);
  }

  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const output = execFileSync('node', [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' });
  assert.ok(/copied 16, deleted 2, preserved 0/.test(output), `Test 11 FAIL: unexpected summary line: ${output}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'docs', 'core', 'page-6.md')), false, 'Test 11 FAIL: page-6.md should have been deleted (small, non-tripping deletion)');
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'docs', 'core', 'page-7.md')), false, 'Test 11 FAIL: page-7.md should have been deleted (small, non-tripping deletion)');
  assert.ok(fs.existsSync(path.join(cloneDir, 'docs', 'newstuff', 'added-0.md')), 'Test 11 FAIL: newly added directory/files should be copied in, not treated as a deletion risk');
  console.log('Test 11 passed: ordinary evolution (additions + a small 2/8=25% in-directory deletion) never trips the per-directory guard');
}

// Test 12: dirOf()/findDirectoryViolations() unit-level checks — the T-507
// per-directory rule directly, independent of CLI subprocess plumbing.
// Updated in round 1 (security review): a small-directory FULL WIPE is now
// (correctly) always a violation regardless of size (F1) — the pre-round-1
// version of this test asserted the opposite (that a 100%-deleted 3-file
// directory was never flagged), which was exactly the gap round 1 found.
{
  const {
    dirOf, findDirectoryViolations, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO,
    AGGREGATE_SMALL_DIR_LABEL, MULTI_DIR_AGGREGATE_LABEL, planDeletion,
  } = require('./mavp-publish-overlay.js');

  assert.strictEqual(MIN_DIR_SIZE, 5, 'Test 12 FAIL: expected MIN_DIR_SIZE of 5');
  assert.strictEqual(DIR_MAX_DELETE_RATIO, 0.5, 'Test 12 FAIL: expected DIR_MAX_DELETE_RATIO of 0.5');

  assert.strictEqual(dirOf('a.md'), '', 'Test 12 FAIL: root-level file should map to the empty pseudo-directory');
  assert.strictEqual(dirOf('docs/a.md'), 'docs', 'Test 12 FAIL: unexpected dirOf for a depth-1 path');
  assert.strictEqual(dirOf('docs/core/a.md'), 'docs/core', 'Test 12 FAIL: unexpected dirOf for a depth-2 path — must be the full ancestor path, not just the leaf segment');

  // A directory bucket below MIN_DIR_SIZE with a PARTIAL deletion stays
  // exempt (both individually — ratio math on 3 files is noisy — and via
  // the small-directory aggregate, which itself stays below MIN_DIR_SIZE
  // here since only 1 of 3 files is involved).
  const smallCloneFiles = ['tiny/a.md', 'tiny/b.md', 'tiny/c.md'];
  const smallAssembledSet = new Set(['tiny/b.md', 'tiny/c.md']); // 1 of 3 deleted
  const smallPlan = planDeletion(smallCloneFiles, smallAssembledSet, []);
  const smallViolations = findDirectoryViolations(smallPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.deepStrictEqual(smallViolations, [], 'Test 12 FAIL: a directory below MIN_DIR_SIZE with a partial (non-total) deletion must stay exempt');

  // T-507 round 1 (F1): a directory below MIN_DIR_SIZE that is COMPLETELY
  // wiped IS always a violation — this is the "one manifest line" bypass
  // (e.g. dropping a 1-file .github/workflows/ directory) round 1 reproduced.
  const wipedCloneFiles = ['tiny-wiped/a.md', 'tiny-wiped/b.md', 'tiny-wiped/c.md'];
  const wipedPlan = planDeletion(wipedCloneFiles, new Set(), []);
  const wipedViolations = findDirectoryViolations(wipedPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(wipedViolations.length, 1, 'Test 12 FAIL: expected a full-wipe violation for a completely emptied small directory');
  assert.strictEqual(wipedViolations[0].dir, 'tiny-wiped', 'Test 12 FAIL: unexpected full-wipe violation directory');
  assert.strictEqual(wipedViolations[0].reason, 'full-wipe', 'Test 12 FAIL: expected reason "full-wipe"');

  // A directory bucket exactly AT MIN_DIR_SIZE, entirely deleted, IS a
  // violation (full-wipe rule fires before the ratio rule gets a chance to,
  // but the outcome — a violation — is the same either way).
  const fullCloneFiles = ['big/a.md', 'big/b.md', 'big/c.md', 'big/d.md', 'big/e.md'];
  const fullPlan = planDeletion(fullCloneFiles, new Set(), []);
  const fullViolations = findDirectoryViolations(fullPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(fullViolations.length, 1, 'Test 12 FAIL: expected exactly one violation for a fully-deleted 5-file directory');
  assert.strictEqual(fullViolations[0].dir, 'big', 'Test 12 FAIL: unexpected violation directory');
  assert.strictEqual(fullViolations[0].deleted, 5, 'Test 12 FAIL: unexpected deleted count');
  assert.strictEqual(fullViolations[0].total, 5, 'Test 12 FAIL: unexpected total count');

  // T-507 round 1 (F2): an EXACT half-deletion in a >= MIN_DIR_SIZE bucket
  // is now a violation — it silently passed under the original strict `>`.
  const exactHalfCloneFiles = ['half/a.md', 'half/b.md', 'half/c.md', 'half/d.md', 'half/e.md', 'half/f.md'];
  const exactHalfAssembledSet = new Set(['half/a.md', 'half/b.md', 'half/c.md']); // 3 of 6 kept = exactly 50% deleted
  const exactHalfPlan = planDeletion(exactHalfCloneFiles, exactHalfAssembledSet, []);
  const exactHalfViolations = findDirectoryViolations(exactHalfPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(exactHalfViolations.length, 1, 'Test 12 FAIL: expected an exact 50% per-directory deletion to now be a violation (>=, not >)');
  assert.strictEqual(exactHalfViolations[0].reason, 'ratio', 'Test 12 FAIL: expected reason "ratio"');

  // Nested directories are independent buckets: dropping ALL of a nested
  // subdirectory can be a violation even while its parent directory (which
  // also holds unrelated, untouched files, diluting ITS OWN ratio) stays
  // well under the threshold — this is the "docs/core under half of docs/"
  // scenario the per-directory design exists to catch.
  const nestedCloneFiles = [
    'docs/core/a.md', 'docs/core/b.md', 'docs/core/c.md', 'docs/core/d.md', 'docs/core/e.md',
    'docs/other-1.md', 'docs/other-2.md', 'docs/other-3.md', 'docs/other-4.md', 'docs/other-5.md',
    'docs/other-6.md', 'docs/other-7.md', 'docs/other-8.md', 'docs/other-9.md', 'docs/other-10.md',
  ];
  const nestedAssembledSet = new Set(nestedCloneFiles.filter((p) => p.startsWith('docs/other-')));
  const nestedPlan = planDeletion(nestedCloneFiles, nestedAssembledSet, []);
  const nestedViolations = findDirectoryViolations(nestedPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(nestedViolations.length, 1, 'Test 12 FAIL: expected exactly one violation (docs/core), not the parent docs/ bucket');
  assert.strictEqual(nestedViolations[0].dir, 'docs/core', 'Test 12 FAIL: expected the violation to name the nested docs/core bucket specifically');

  // T-507 round 1 (F1) — the aggregate-of-small-directories rule: four
  // directories, each individually below MIN_DIR_SIZE and each only
  // PARTIALLY deleted (never a full wipe on its own), combine to a 50%
  // aggregate that IS a violation — this is what catches "dropping all 11
  // exempt directories at once" even when no single one of them is fully
  // wiped.
  const manySmallCloneFiles = [
    'small-a/1.md', 'small-a/2.md', 'small-b/1.md', 'small-b/2.md',
    'small-c/1.md', 'small-c/2.md', 'small-d/1.md', 'small-d/2.md',
  ];
  const manySmallAssembledSet = new Set(['small-a/2.md', 'small-b/2.md', 'small-c/2.md', 'small-d/2.md']);
  const manySmallPlan = planDeletion(manySmallCloneFiles, manySmallAssembledSet, []);
  const manySmallViolations = findDirectoryViolations(manySmallPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  const aggregateViolation = manySmallViolations.find((v) => v.reason === 'aggregate');
  assert.ok(aggregateViolation, 'Test 12 FAIL: expected an aggregate-of-small-directories violation');
  assert.strictEqual(aggregateViolation.dir, AGGREGATE_SMALL_DIR_LABEL, 'Test 12 FAIL: unexpected aggregate violation label');
  assert.strictEqual(aggregateViolation.total, 8, 'Test 12 FAIL: unexpected aggregate total');
  assert.strictEqual(aggregateViolation.deleted, 4, 'Test 12 FAIL: unexpected aggregate deleted count');

  // T-507 round 1 (F2) — the multi-directory budget-summing rule: three
  // directories, each individually staying comfortably under its own 50%
  // per-directory budget (30-40%), combine to a 35% aggregate that exceeds
  // the tighter multi-directory ceiling (half of DIR_MAX_DELETE_RATIO =
  // 25%) — this is what catches the reproduced "35.2%/49.7% silent
  // deletion" case that neither the per-directory nor whole-clone ratio
  // alone would ever see as suspicious.
  const multiDirCloneFiles = [
    ...Array.from({ length: 20 }, (_, i) => `dirA/${i}.md`),
    ...Array.from({ length: 20 }, (_, i) => `dirB/${i}.md`),
    ...Array.from({ length: 20 }, (_, i) => `dirC/${i}.md`),
  ];
  // Keep 12 of each 20 (delete 8 of 20 = 40% per directory — each well
  // under its own 50% budget); combined: 24 of 60 = 40% >= 25% multi-dir ceiling.
  const multiDirAssembledSet = new Set([
    ...Array.from({ length: 12 }, (_, i) => `dirA/${i}.md`),
    ...Array.from({ length: 12 }, (_, i) => `dirB/${i}.md`),
    ...Array.from({ length: 12 }, (_, i) => `dirC/${i}.md`),
  ]);
  const multiDirPlan = planDeletion(multiDirCloneFiles, multiDirAssembledSet, []);
  const multiDirViolations = findDirectoryViolations(multiDirPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  const multiDirViolation = multiDirViolations.find((v) => v.reason === 'multi-directory-aggregate');
  assert.ok(multiDirViolation, 'Test 12 FAIL: expected a multi-directory-aggregate violation for the budget-summing case');
  assert.strictEqual(multiDirViolation.dir, MULTI_DIR_AGGREGATE_LABEL, 'Test 12 FAIL: unexpected multi-directory violation label');
  assert.strictEqual(multiDirViolation.total, 60, 'Test 12 FAIL: unexpected multi-directory total');
  assert.strictEqual(multiDirViolation.deleted, 24, 'Test 12 FAIL: unexpected multi-directory deleted count');
  assert.ok(
    !multiDirViolations.some((v) => v.reason === 'ratio'),
    'Test 12 FAIL: no individual directory should trip the per-directory ratio in this scenario (each stays at 40% < 50%)'
  );

  // The SAME multi-directory shape, but with only ONE directory touched
  // (the other two untouched), must NOT trip the multi-directory rule even
  // at a much higher per-directory ratio than the multi-dir ceiling — a
  // single-area restructure keeps its full per-directory budget.
  const singleDirCloneFiles = [
    ...Array.from({ length: 20 }, (_, i) => `dirA/${i}.md`),
    ...Array.from({ length: 20 }, (_, i) => `dirB/${i}.md`),
  ];
  const singleDirAssembledSet = new Set([
    ...Array.from({ length: 12 }, (_, i) => `dirA/${i}.md`), // dirA: 8 of 20 deleted = 40%
    ...Array.from({ length: 20 }, (_, i) => `dirB/${i}.md`), // dirB: untouched
  ]);
  const singleDirPlan = planDeletion(singleDirCloneFiles, singleDirAssembledSet, []);
  const singleDirViolations = findDirectoryViolations(singleDirPlan.dirStats, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.deepStrictEqual(singleDirViolations, [], 'Test 12 FAIL: a single touched directory at 40% must not trip anything (neither its own ratio nor the multi-directory rule)');

  console.log('Test 12 passed: dirOf()/findDirectoryViolations() unit-level checks — full-wipe (any size), >= ratio boundary, small-dir aggregate, and multi-directory budget-summing rules all hold');
}

// Test 13: --allow-mass-delete overrides BOTH the whole-clone AND the
// per-directory guard (single override, one operator decision) — the Test 10
// bypass scenario, re-run with the override, must now succeed.
{
  const assembledDir = mkTempDir('mavp-overlay-t507-override-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t507-override-clone-');

  for (let i = 0; i < 6; i++) {
    writeFile(path.join(cloneDir, 'docs', 'core', `page-${i}.md`), `page ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const output = execFileSync(
    'node',
    [OVERLAY_SCRIPT, assembledDir, cloneDir, '--allow-mass-delete'],
    { encoding: 'utf8' }
  );
  assert.ok(/copied 0, deleted 6, preserved 0/.test(output), `Test 13 FAIL: unexpected summary with --allow-mass-delete: ${output}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'docs', 'core', 'page-0.md')), false, 'Test 13 FAIL: docs/core should have been deleted with --allow-mass-delete');
  // T-507 round 1 (F4): --allow-mass-delete must report what it suppressed,
  // not silently swallow the refusal.
  assert.ok(/NOTE: --allow-mass-delete suppressed/.test(output), `Test 13 FAIL: expected a suppression NOTE, got: ${output}`);
  assert.ok(/whole-clone: 6 of 6/.test(output), `Test 13 FAIL: expected the suppression NOTE to include the whole-clone violation, got: ${output}`);
  assert.ok(/docs\/core: 6 of 6.*\[complete removal\]/.test(output), `Test 13 FAIL: expected the suppression NOTE to include the docs/core full-wipe violation, got: ${output}`);
  console.log('Test 13 passed: --allow-mass-delete overrides the per-directory guard the same way it overrides the whole-clone guard, and reports what it suppressed (F4)');
}

// ---------------------------------------------------------------------------
// T-507 round 1 (security review) — F1 (MIN_DIR_SIZE exemption), F2 (budget-
// summing / exact-half boundary), F3 (move/rename false positives).
// ---------------------------------------------------------------------------

// Test 14: detectMovedPaths()/adjustDirStatsForMoves() unit-level checks —
// the F3 move-detection machinery directly, independent of disk I/O.
{
  const { detectMovedPaths, adjustDirStatsForMoves, dirOf } = require('./mavp-publish-overlay.js');

  // A deletion candidate whose content hash matches an available new-path
  // hash is reclassified as a move.
  const deletionHashes = new Map([
    ['docs/old-a.md', 'hash-A'],
    ['docs/old-b.md', 'hash-B'],
    ['docs/genuinely-gone.md', 'hash-C'],
  ]);
  const newHashes = new Map([
    ['docs/core/new-a.md', 'hash-A'],
    ['docs/core/new-b.md', 'hash-B'],
    ['docs/unrelated-addition.md', 'hash-D'],
  ]);
  const moved = detectMovedPaths(deletionHashes, newHashes);
  assert.strictEqual(moved.size, 2, 'Test 14 FAIL: expected exactly 2 moved paths');
  assert.ok(moved.has('docs/old-a.md'), 'Test 14 FAIL: expected docs/old-a.md to be detected as moved');
  assert.ok(moved.has('docs/old-b.md'), 'Test 14 FAIL: expected docs/old-b.md to be detected as moved');
  assert.ok(!moved.has('docs/genuinely-gone.md'), 'Test 14 FAIL: a deletion candidate with no matching new-path hash must NOT be classified as moved');

  // Duplicate content is matched 1:1 (supply-consuming), not many:1.
  const dupDeletionHashes = new Map([['a.md', 'same'], ['b.md', 'same'], ['c.md', 'same']]);
  const dupNewHashes = new Map([['x.md', 'same']]); // only ONE unit of supply
  const dupMoved = detectMovedPaths(dupDeletionHashes, dupNewHashes);
  assert.strictEqual(dupMoved.size, 1, 'Test 14 FAIL: duplicate-content supply must be consumed 1:1, not matched to all candidates');

  // adjustDirStatsForMoves() decrements only `deleted`, leaves `total`
  // untouched, does not mutate the input, and never goes below zero.
  const dirStats = new Map([
    ['docs', { total: 7, deleted: 4 }],
    ['other', { total: 3, deleted: 0 }],
  ]);
  const adjusted = adjustDirStatsForMoves(dirStats, new Set(['docs/old-a.md', 'docs/old-b.md']));
  assert.strictEqual(adjusted.get('docs').deleted, 2, 'Test 14 FAIL: expected docs.deleted decremented by 2 (one per moved path)');
  assert.strictEqual(adjusted.get('docs').total, 7, 'Test 14 FAIL: total must be unaffected by move-adjustment');
  assert.strictEqual(dirStats.get('docs').deleted, 4, 'Test 14 FAIL: adjustDirStatsForMoves() must not mutate the input Map');
  assert.strictEqual(dirOf('docs/old-a.md'), 'docs', 'Test 14 FAIL: sanity check on dirOf() used above');

  console.log('Test 14 passed: detectMovedPaths()/adjustDirStatsForMoves() unit-level checks');
}

// Test 15: F3 real reproduction — a legitimate reorg (moving 4 of 7 files
// from docs/ into docs/core/, every file still shipped, byte-identical
// content) must NOT be refused, even though the docs/ bucket alone would
// show 4 of 7 = 57.1% "deleted" without move-awareness.
{
  const assembledDir = mkTempDir('mavp-overlay-t507-move-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t507-move-clone-');

  for (let i = 0; i < 7; i++) {
    writeFile(path.join(cloneDir, 'docs', `page-${i}.md`), `content of page ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  // 3 files stay in docs/, byte-identical; 4 files move to docs/core/,
  // byte-identical content, different path.
  for (let i = 0; i < 3; i++) {
    writeFile(path.join(assembledDir, 'docs', `page-${i}.md`), `content of page ${i}\n`);
  }
  for (let i = 3; i < 7; i++) {
    writeFile(path.join(assembledDir, 'docs', 'core', `page-${i}.md`), `content of page ${i}\n`);
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.strictEqual(result.status, 0, `Test 15 FAIL: expected a pure reorg (move, no true loss) to succeed, got exit ${result.status}:\n${result.stderr}`);
  assert.ok(/copied 7, deleted 4, preserved 0/.test(result.stdout), `Test 15 FAIL: unexpected summary: ${result.stdout}`);
  // The old paths ARE physically removed (the files now live under
  // docs/core/) — move-awareness affects only the GUARD's verdict, never
  // the actual copy/delete plan.
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'docs', 'page-3.md')), false, 'Test 15 FAIL: the old docs/page-3.md path should be gone (moved, not duplicated)');
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, 'docs', 'core', 'page-3.md'), 'utf8'),
    'content of page 3\n',
    'Test 15 FAIL: the moved file should exist, byte-identical, at its new path'
  );
  console.log('Test 15 passed: F3 — a legitimate reorg (4 of 7 docs/ files moved into docs/core/, byte-identical) is NOT refused, even though the docs/ bucket alone would show 57.1% "deleted" without move-awareness');
}

// Test 16: F1 real reproduction — a single-file directory (modeling e.g.
// .github/workflows/ci.yml) dropped entirely from the ship set, padded with
// enough unrelated untouched files elsewhere that BOTH the whole-clone ratio
// (well under 50%) and the old per-directory floor (a 1-file bucket was
// exempt pre-round-1) would have stayed silent. Refused by the round-1
// full-wipe-any-size rule.
{
  const assembledDir = mkTempDir('mavp-overlay-t507-oneline-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t507-oneline-clone-');

  writeFile(path.join(cloneDir, 'ci-workflow', 'ci.yml'), 'name: CI\n');
  for (let i = 0; i < 20; i++) {
    writeFile(path.join(cloneDir, 'padding', `file-${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `file-${i}.md`), `padding ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  // assembledDir has NOTHING under ci-workflow/ — the one manifest-line
  // removal.

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 16 FAIL: expected the one-line small-directory drop to be refused, got exit ${result.status}`);
  assert.ok(/ci-workflow: 1 of 1 \(100\.0%\) \[complete removal\]/.test(result.stderr), `Test 16 FAIL: expected a full-wipe refusal naming ci-workflow, got: ${result.stderr}`);
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'ci-workflow', 'ci.yml')), true, 'Test 16 FAIL: no writes should have happened — ci-workflow/ci.yml must still exist');
  console.log('Test 16 passed: F1 — a one-line manifest edit dropping a single-file directory (e.g. .github/workflows/ci.yml) is refused by the full-wipe-any-size rule, even though the whole-clone ratio (1/21 = 4.8%) never notices');
}

// ---------------------------------------------------------------------------
// T-507 round 2 (N1, HIGH) — round 1's move-detection had no basename check,
// no location denylist, and no cap: ANY deletion candidate whose bytes
// reappeared at ANY new path was credited as a move, laundering a
// functionally destructive relocation (path-semantic files like git hooks
// and CI workflows only function from their original location) as an
// ordinary rename, for a deletion of ANY size, without limit.
//
// Tier 1: the full-wipe rule (findDirectoryViolations()'s rule 1) now reads
// RAW, pre-move-credit counts — a directory ending up with ZERO of its
// original files is empty regardless of where the bytes went.
// Tier 2: move credit additionally requires (a) the SAME basename, and (b)
// the source path is NOT under a semantic-location prefix (.github/,
// .claude/hooks/, .claude/rules/, .claude/agents/) — denied outright there,
// regardless of content or basename match.
// ---------------------------------------------------------------------------

// Test 17: the T3/T4 control pair — identical one-file deletion
// (.claude/hooks/pre-commit, padded so the whole-clone ratio never
// notices), differing only by whether one inert byte-identical copy is
// planted at an unrelated path. Both must refuse identically — laundering
// the drop with an unrelated copy must not change the outcome at all.
{
  function buildT3T4Fixture(withLaunderingCopy) {
    const assembledDir = mkTempDir('mavp-overlay-n1-t3t4-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-n1-t3t4-clone-');
    const hookContent = '#!/bin/sh\nnode scripts/mavp-validator.js "$(pwd)"\n';
    writeFile(path.join(cloneDir, '.claude', 'hooks', 'pre-commit'), hookContent);
    for (let i = 0; i < 20; i++) {
      writeFile(path.join(cloneDir, 'padding', `f${i}.md`), `padding ${i}\n`);
      writeFile(path.join(assembledDir, 'padding', `f${i}.md`), `padding ${i}\n`);
    }
    if (withLaunderingCopy) {
      writeFile(path.join(assembledDir, 'docs', 'attic', 'pre-commit'), hookContent);
    }
    writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return { assembledDir, cloneDir };
  }

  const t4 = buildT3T4Fixture(false);
  const t4Result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, t4.assembledDir, t4.cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(t4Result.status, 0, `Test 17 FAIL (T4 control): expected refusal, got exit ${t4Result.status}`);
  assert.ok(/\.claude\/hooks: 1 of 1 \(100\.0%\) \[complete removal\]/.test(t4Result.stderr), `Test 17 FAIL (T4): unexpected stderr: ${t4Result.stderr}`);

  const t3 = buildT3T4Fixture(true);
  const t3Result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, t3.assembledDir, t3.cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(t3Result.status, 0, `Test 17 FAIL (T3 laundering): expected refusal identical to T4, got exit ${t3Result.status}`);
  assert.ok(/\.claude\/hooks: 1 of 1 \(100\.0%\) \[complete removal\]/.test(t3Result.stderr), `Test 17 FAIL (T3): unexpected stderr: ${t3Result.stderr}`);
  console.log('Test 17 passed: N1 T3/T4 control pair — a one-file semantic-location drop refuses identically whether or not an inert byte-identical copy is planted elsewhere');
}

// Test 18: L2 — a PARTIAL deletion (not a full wipe) inside a
// semantic-location directory (.claude/agents/, 10 files, 6 dropped, 4
// remain), each dropped file laundered with its ORIGINAL basename
// preserved. Tier 1 alone would NOT catch this (not a full wipe); the
// semantic-path denylist must deny credit regardless of the basename match.
{
  const assembledDir = mkTempDir('mavp-overlay-n1-l2-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1-l2-clone-');
  for (let i = 0; i < 10; i++) {
    writeFile(path.join(cloneDir, '.claude', 'agents', `agent-${i}.md`), `agent spec ${i}\n`);
  }
  for (let i = 0; i < 4; i++) {
    writeFile(path.join(assembledDir, '.claude', 'agents', `agent-${i}.md`), `agent spec ${i}\n`);
  }
  for (let i = 4; i < 10; i++) {
    writeFile(path.join(assembledDir, 'docs', 'other-place', `agent-${i}.md`), `agent spec ${i}\n`);
  }
  for (let i = 0; i < 20; i++) {
    writeFile(path.join(cloneDir, 'padding', `f${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `f${i}.md`), `padding ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 18 FAIL: expected refusal, got exit ${result.status}`);
  assert.ok(/\.claude\/agents: 6 of 10 \(60\.0%\)/.test(result.stderr), `Test 18 FAIL: unexpected stderr: ${result.stderr}`);
  console.log('Test 18 passed: N1 L2 — a partial (non-full-wipe) deletion inside a semantic-location directory is refused; same-basename laundering does not excuse it');
}

// Test 19: L4 — a PARTIAL deletion (not a full wipe) inside an ORDINARY
// (non-semantic) directory, laundered under a DIFFERENT basename. Tier 2's
// basename requirement must deny credit.
{
  const assembledDir = mkTempDir('mavp-overlay-n1-l4-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1-l4-clone-');
  for (let i = 0; i < 10; i++) {
    writeFile(path.join(cloneDir, 'bigdir', `page-${i}.md`), `page content ${i}\n`);
  }
  for (let i = 0; i < 4; i++) {
    writeFile(path.join(assembledDir, 'bigdir', `page-${i}.md`), `page content ${i}\n`);
  }
  for (let i = 4; i < 10; i++) {
    writeFile(path.join(assembledDir, 'docs', 'attic', `renamed-copy-${i}.md`), `page content ${i}\n`);
  }
  for (let i = 0; i < 20; i++) {
    writeFile(path.join(cloneDir, 'padding', `f${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `f${i}.md`), `padding ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 19 FAIL: expected refusal, got exit ${result.status}`);
  assert.ok(/bigdir: 6 of 10 \(60\.0%\)/.test(result.stderr), `Test 19 FAIL: unexpected stderr: ${result.stderr}`);
  console.log('Test 19 passed: N1 L4 — a partial deletion laundered under a DIFFERENT basename is refused; content match alone does not excuse it');
}

// Test 20: L5 — mass laundering, every directory in the tree emptied and
// every file's content relocated (byte-identical) elsewhere. The maximal
// case: must refuse.
{
  const assembledDir = mkTempDir('mavp-overlay-n1-l5-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1-l5-clone-');
  const dirs = ['scripts', 'docs/core', '.claude/agents', '.claude/rules', '.github/workflows', 'templates'];
  let n = 0;
  for (const dir of dirs) {
    for (let i = 0; i < 8; i++) {
      const content = `unique content for ${dir}/${n}\n`;
      writeFile(path.join(cloneDir, dir, `f${i}.md`), content);
      writeFile(path.join(assembledDir, 'docs', 'attic', `laundered-${n}.md`), content);
      n += 1;
    }
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 20 FAIL: expected refusal, got exit ${result.status}`);
  console.log('Test 20 passed: N1 L5 — mass laundering (every directory emptied, all content relocated) is refused');
}

// Test 21: symlink laundering — a symlink under a semantic-location
// directory, dropped entirely, with a same-basename/same-target symlink
// planted at a new path (fingerprintPath() gives symlinks a
// `symlink:<target>` fingerprint, so this would satisfy content+basename
// matching). The semantic-path denylist must still deny credit.
{
  const assembledDir = mkTempDir('mavp-overlay-n1-symlink-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1-symlink-clone-');
  fs.mkdirSync(path.join(cloneDir, '.claude', 'hooks'), { recursive: true });
  fs.symlinkSync('../../scripts/mavp-validator.js', path.join(cloneDir, '.claude', 'hooks', 'pre-commit'));
  fs.mkdirSync(path.join(assembledDir, 'docs', 'attic'), { recursive: true });
  fs.symlinkSync('../../scripts/mavp-validator.js', path.join(assembledDir, 'docs', 'attic', 'pre-commit'));
  for (let i = 0; i < 20; i++) {
    writeFile(path.join(cloneDir, 'padding', `f${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `f${i}.md`), `padding ${i}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 21 FAIL: expected refusal, got exit ${result.status}`);
  assert.ok(/\.claude\/hooks: 1 of 1 \(100\.0%\) \[complete removal\]/.test(result.stderr), `Test 21 FAIL: unexpected stderr: ${result.stderr}`);
  console.log('Test 21 passed: N1 symlink laundering — a semantic-location symlink drop refuses even when a same-basename/same-target symlink is planted elsewhere');
}

// Test 22: unit-level checks for the tier 1/tier 2 helpers directly.
{
  const {
    basenameOf, isLocationSemantic, buildMoveKey, adjustDirStatsForMoves, findDirectoryViolations,
    planDeletion, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO,
  } = require('./mavp-publish-overlay.js');

  assert.strictEqual(basenameOf('a.md'), 'a.md', 'Test 22 FAIL: root-level basenameOf');
  assert.strictEqual(basenameOf('docs/core/a.md'), 'a.md', 'Test 22 FAIL: nested basenameOf');

  assert.ok(isLocationSemantic('.github/workflows/ci.yml'), 'Test 22 FAIL: .github/ should be semantic');
  assert.ok(isLocationSemantic('.claude/hooks/pre-commit'), 'Test 22 FAIL: .claude/hooks/ should be semantic');
  assert.ok(isLocationSemantic('.claude/rules/scripts.md'), 'Test 22 FAIL: .claude/rules/ should be semantic');
  assert.ok(isLocationSemantic('.claude/agents/developer.md'), 'Test 22 FAIL: .claude/agents/ should be semantic');
  assert.ok(!isLocationSemantic('docs/core/a.md'), 'Test 22 FAIL: docs/core/ should NOT be semantic');
  assert.ok(!isLocationSemantic('.claude/skills/foo.md'), 'Test 22 FAIL: .claude/skills/ (not in the denylist) should NOT be semantic');

  assert.notStrictEqual(
    buildMoveKey('a/x.md', 'HASH'),
    buildMoveKey('b/y.md', 'HASH'),
    'Test 22 FAIL: buildMoveKey must differ when basenames differ, same hash'
  );
  assert.strictEqual(
    buildMoveKey('a/x.md', 'HASH'),
    buildMoveKey('b/x.md', 'HASH'),
    'Test 22 FAIL: buildMoveKey must match when basenames and hash both match, regardless of directory'
  );

  // Tier 1 unit check: adjustDirStatsForMoves() preserves rawDeleted even
  // after crediting a move, and findDirectoryViolations() uses rawDeleted
  // for the full-wipe rule.
  const dirStats = planDeletion(['solo/a.md'], new Set(), []).dirStats;
  const adjusted = adjustDirStatsForMoves(dirStats, new Set(['solo/a.md'])); // credit the only file as "moved"
  assert.strictEqual(adjusted.get('solo').deleted, 0, 'Test 22 FAIL: adjusted deleted should be 0 after crediting the move');
  assert.strictEqual(adjusted.get('solo').rawDeleted, 1, 'Test 22 FAIL: rawDeleted must stay 1 regardless of move-credit');
  const violations = findDirectoryViolations(adjusted, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(violations.length, 1, 'Test 22 FAIL: expected the full-wipe rule to fire using rawDeleted despite move-credit zeroing out deleted');
  assert.strictEqual(violations[0].reason, 'full-wipe', 'Test 22 FAIL: expected reason full-wipe');

  console.log('Test 22 passed: basenameOf()/isLocationSemantic()/buildMoveKey() unit checks, and rawDeleted survives move-credit for the full-wipe rule');
}

// ---------------------------------------------------------------------------
// T-507 round 3 (N1', HIGH) — rounds 1-2 NARROWED move credit but did not
// close it. The surviving attack: leave exactly ONE file per directory bucket
// (defeats the full-wipe rule, which reads raw counts), preserve every
// basename (satisfies the move key), stay off the four
// LOCATION_SEMANTIC_PREFIXES, and re-add every dropped file's bytes under one
// unrelated destination — draining the great majority of the ship set with
// every guard reporting zero loss.
//
// Two mechanisms close it, and each is covered by its own killer test below:
//   Mechanism 1 (relatedness): credit only towards a destination sharing the
//   source's non-empty first path segment; a root-level source is related
//   only to a root-level destination. Killer: Test 23.
//   Mechanism 2 (whole-run cap): total credited moves may not reach
//   MOVE_CREDIT_MAX_RATIO of the baseline (with a MOVE_CREDIT_MIN_COUNT
//   absolute floor). Killers: Test 25 (end-to-end) and Test 26 (boundary).
//   Mechanism 3 (rawDeleted idempotency). Killer: Test 27.
// Test 28 is the load-bearing negative control: ordinary multi-directory
// evolution must still pass.
// ---------------------------------------------------------------------------

// Test 23: mechanism 1 unit checks — firstSegmentOf()/isRelatedMove() and
// detectMovedPaths()'s use of them, in BOTH directions (credited and not).
{
  const { firstSegmentOf, isRelatedMove, detectMovedPaths } = require('./mavp-publish-overlay.js');

  assert.strictEqual(firstSegmentOf('a.md'), '', 'Test 23 FAIL: a root-level path has no first segment');
  assert.strictEqual(firstSegmentOf('docs/a.md'), 'docs', 'Test 23 FAIL: unexpected first segment at depth 1');
  assert.strictEqual(firstSegmentOf('docs/core/a.md'), 'docs', 'Test 23 FAIL: first segment must be the TOP-level segment, not the parent dir');

  // Related: same first segment (sibling), descendant, and ancestor.
  assert.ok(isRelatedMove('docs/a.md', 'docs/sub/a.md'), 'Test 23 FAIL: descendant within the same tree must be related');
  assert.ok(isRelatedMove('docs/core/a.md', 'docs/a.md'), 'Test 23 FAIL: ancestor within the same tree must be related');
  assert.ok(isRelatedMove('scripts/a.js', 'scripts/lib/a.js'), 'Test 23 FAIL: same-top-level-segment move must be related');
  assert.ok(isRelatedMove('LICENSE', 'NOTICE'), 'Test 23 FAIL: a root-level source and a root-level destination are related');

  // NOT related: different first segment, and the vacuity hazard — a
  // root-level source relocated into ANY subdirectory. The root
  // pseudo-directory is an ancestor of every directory in the tree, so a
  // literal "ancestor/descendant" reading would have credited this, which is
  // exactly one of the reproduced attack's buckets (licence, readme, package
  // manifest, installer all live at root).
  assert.ok(!isRelatedMove('scripts/a.js', 'attic/a.js'), 'Test 23 FAIL: a different first segment must NOT be related');
  assert.ok(!isRelatedMove('docs/a.md', 'templates/a.md'), 'Test 23 FAIL: a cross-top-level move must NOT be related');
  assert.ok(!isRelatedMove('LICENSE', 'attic/LICENSE'), 'Test 23 FAIL: a root-level source relocated into a subdirectory must NOT be related');
  assert.ok(!isRelatedMove('attic/LICENSE', 'LICENSE'), 'Test 23 FAIL: a subdirectory source relocated to root must NOT be related');

  // detectMovedPaths() honours relatedness: same key, different destinations.
  const deletionKeys = new Map([
    ['docs/a.md', 'a.md::HASH-A'],           // related destination available
    ['docs/core/b.md', 'b.md::HASH-B'],      // related destination available (ancestor)
    ['scripts/c.js', 'c.js::HASH-C'],        // ONLY an unrelated destination available
    ['LICENSE', 'LICENSE::HASH-D'],          // ONLY a subdirectory destination available
  ]);
  const newKeys = new Map([
    ['docs/sub/a.md', 'a.md::HASH-A'],
    ['docs/b.md', 'b.md::HASH-B'],
    ['attic/c.js', 'c.js::HASH-C'],
    ['attic/LICENSE', 'LICENSE::HASH-D'],
  ]);
  const moved = detectMovedPaths(deletionKeys, newKeys);
  assert.ok(moved.has('docs/a.md'), 'Test 23 FAIL: same-first-segment (descendant) destination must be credited');
  assert.ok(moved.has('docs/core/b.md'), 'Test 23 FAIL: ancestor-within-one-tree destination must be credited');
  assert.ok(!moved.has('scripts/c.js'), 'Test 23 FAIL: a key match at an UNRELATED destination must NOT be credited');
  assert.ok(!moved.has('LICENSE'), 'Test 23 FAIL: a root-level source relocated into a subdirectory must NOT be credited');
  assert.strictEqual(moved.size, 2, 'Test 23 FAIL: expected exactly the two related moves to be credited');

  // 1:1 consumption still holds AND is relatedness-aware: two same-key
  // candidates, one related destination plus one unrelated one — exactly one
  // credit is available, and the unrelated destination never provides it.
  const dupDeletionKeys = new Map([['docs/x.md', 'x.md::SAME'], ['docs/y.md', 'x.md::SAME']]);
  const dupNewKeys = new Map([['attic/x.md', 'x.md::SAME'], ['docs/sub/x.md', 'x.md::SAME']]);
  const dupMoved = detectMovedPaths(dupDeletionKeys, dupNewKeys);
  assert.strictEqual(dupMoved.size, 1, 'Test 23 FAIL: only the single RELATED destination may be consumed (1:1, and never the unrelated one)');

  console.log('Test 23 passed: mechanism 1 — relatedness credits same-first-segment/ancestor/descendant moves and denies unrelated destinations and root-level-into-subdirectory relocations');
}

// Test 24: the round-3 attack, end-to-end, at an UNRELATED destination — one
// file left per bucket, every basename preserved, off the semantic-location
// denylist, ~90% of the baseline drained, every byte re-added under a single
// unrelated `attic/` directory. Plus the differential control: the identical
// drop with NO relocation adds must refuse identically, proving move credit
// no longer changes the outcome.
//
// Two runs per fixture. With default flags the whole-clone ratio is what
// refuses first (the drop is 89.7% of the baseline, and relatedness means
// none of it is credited away any more — that guard firing is the point).
// The second run passes --max-delete-ratio 1 to stand the whole-clone tier
// down, isolating the per-directory COMPOSITION guard as the refusing tier —
// the attacker's own best case, where padding keeps the whole-clone ratio
// clear.
{
  function buildRound3Fixture(withRelocationAdds) {
    const assembledDir = mkTempDir('mavp-overlay-n1p-attack-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-n1p-attack-clone-');
    // Globally unique basenames so every relocated file can keep its own
    // basename while landing in one flat attic directory (the attack
    // preserves basenames — that is what satisfies the move key).
    const buckets = [
      { dir: 'scripts', count: 20, name: (i) => `s-tool-${i}.js` },
      { dir: 'docs', count: 10, name: (i) => `d-page-${i}.md` },
      { dir: 'docs/core', count: 8, name: (i) => `dc-page-${i}.md` },
      { dir: 'templates', count: 8, name: (i) => `t-${i}.md` },
      { dir: 'skills', count: 6, name: (i) => `sk-${i}.md` },
      { dir: '', count: 6, name: (i) => `r-${i}.md` }, // root-level pseudo-directory
    ];
    let drained = 0;
    let baseline = 0;
    for (const bucket of buckets) {
      for (let i = 0; i < bucket.count; i++) {
        const rel = bucket.dir ? `${bucket.dir}/${bucket.name(i)}` : bucket.name(i);
        const content = `content of ${rel}\n`;
        writeFile(path.join(cloneDir, rel), content);
        baseline += 1;
        if (i === 0) {
          writeFile(path.join(assembledDir, rel), content); // the ONE file left behind per bucket
        } else {
          drained += 1;
          if (withRelocationAdds) {
            writeFile(path.join(assembledDir, 'attic', bucket.name(i)), content);
          }
        }
      }
    }
    writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return { assembledDir, cloneDir, baseline, drained };
  }

  const violationLinesOf = (stderr) => stderr.split('\n').filter((l) => l.startsWith('  - ')).join('\n');

  const attack = buildRound3Fixture(true);
  const control = buildRound3Fixture(false);
  assert.strictEqual(attack.baseline, 58, 'Test 24 FAIL: unexpected fixture baseline size');
  assert.strictEqual(attack.drained, 52, 'Test 24 FAIL: unexpected fixture drain size');

  for (const [label, fixture] of [['attack', attack], ['control', control]]) {
    const result = require('node:child_process').spawnSync(
      process.execPath, [OVERLAY_SCRIPT, fixture.assembledDir, fixture.cloneDir], { encoding: 'utf8' }
    );
    assert.notStrictEqual(result.status, 0, `Test 24 FAIL (${label}, default flags): expected a refusal, got exit ${result.status}:\n${result.stdout}`);
    assert.ok(/refusing to overlay/.test(result.stderr), `Test 24 FAIL (${label}): expected a refusal message, got: ${result.stderr}`);
    // No-writes proof: the drained files are all still in the clone.
    assert.ok(fs.existsSync(path.join(fixture.cloneDir, 'scripts', 's-tool-5.js')), `Test 24 FAIL (${label}): no writes should have happened`);
    assert.ok(fs.existsSync(path.join(fixture.cloneDir, 'r-3.md')), `Test 24 FAIL (${label}): no writes should have happened (root bucket)`);
  }

  // Isolate the composition guard: stand the whole-clone tier down.
  const compositionRuns = ['attack', 'control'].map((label) => {
    const fixture = label === 'attack' ? attack : control;
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [OVERLAY_SCRIPT, fixture.assembledDir, fixture.cloneDir, '--max-delete-ratio', '1'],
      { encoding: 'utf8' }
    );
    assert.notStrictEqual(result.status, 0, `Test 24 FAIL (${label}, composition-only): expected the composition guard to refuse, got exit ${result.status}:\n${result.stdout}`);
    assert.ok(
      /per-directory composition guard/.test(result.stderr),
      `Test 24 FAIL (${label}, composition-only): expected the per-directory composition guard to be the refusing tier, got: ${result.stderr}`
    );
    assert.ok(
      /scripts: 19 of 20 \(95\.0%\)/.test(result.stderr),
      `Test 24 FAIL (${label}, composition-only): expected the scripts bucket's 19-of-20 drain to be named, got: ${result.stderr}`
    );
    assert.ok(
      /\(root\): 5 of 6 \(83\.3%\)/.test(result.stderr),
      `Test 24 FAIL (${label}, composition-only): expected the root pseudo-directory's drain to be named, got: ${result.stderr}`
    );
    return violationLinesOf(result.stderr);
  });

  // The differential control: relocating every byte to an unrelated
  // destination now changes NOTHING about the verdict.
  assert.strictEqual(
    compositionRuns[0],
    compositionRuns[1],
    'Test 24 FAIL: the laundered attack and the no-relocation control must produce byte-identical composition findings'
  );

  console.log('Test 24 passed: mechanism 1 end-to-end — the round-3 attack (one file left per bucket, basenames preserved, 52 of 58 drained, all bytes re-added under an unrelated attic directory) is refused, and the differential control without the relocation adds refuses identically');
}

// Test 25: mechanism 2 end-to-end — the attacker's answer to relatedness:
// relocate every file into an attic directory INSIDE its own top-level
// segment, so every credit is legitimately RELATED, every basename matches,
// every byte is identical, and no bucket is fully wiped. Every
// per-directory count is credited away to zero and the whole-clone ratio
// sees zero loss, so the whole-run move-credit cap is the ONLY remaining
// signal — and it must refuse.
{
  function buildInTreeRelocationFixture() {
    const assembledDir = mkTempDir('mavp-overlay-n1p-cap-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-n1p-cap-clone-');
    for (const dir of ['scripts', 'docs', 'templates']) {
      for (let i = 0; i < 20; i++) {
        const name = `${dir}-file-${i}.md`;
        const content = `content of ${dir}/${name}\n`;
        writeFile(path.join(cloneDir, dir, name), content);
        if (i === 0) {
          writeFile(path.join(assembledDir, dir, name), content); // one file left behind
        } else {
          writeFile(path.join(assembledDir, dir, 'attic', name), content); // RELATED destination
        }
      }
    }
    writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return { assembledDir, cloneDir };
  }

  const refused = buildInTreeRelocationFixture();
  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, refused.assembledDir, refused.cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(result.status, 0, `Test 25 FAIL: expected the whole-run move-credit cap to refuse, got exit ${result.status}:\n${result.stdout}`);
  assert.ok(
    /move credit was granted to 57 of 60 non-preserved tracked file\(s\) in the clone \(95\.0%\)/.test(result.stderr),
    `Test 25 FAIL: expected the refusal to name the credited-move count and the baseline, got: ${result.stderr}`
  );
  assert.ok(
    /25\.0% whole-run move-credit cap/.test(result.stderr),
    `Test 25 FAIL: expected the refusal to name the threshold, got: ${result.stderr}`
  );
  // The cap really is the only tier that fires here: every per-directory
  // count and the whole-clone count are credited away to zero.
  assert.ok(
    !/per-directory composition guard/.test(result.stderr),
    `Test 25 FAIL: the per-directory guard should see zero loss in this shape (all credits are related) — the cap must be what refuses, got: ${result.stderr}`
  );
  assert.ok(
    !/planned deletion would remove \d+ of \d+ non-preserved tracked file\(s\)/.test(result.stderr),
    `Test 25 FAIL: the whole-clone ratio should see zero loss in this shape — the cap must be what refuses, got: ${result.stderr}`
  );
  assert.ok(fs.existsSync(path.join(refused.cloneDir, 'scripts', 'scripts-file-5.md')), 'Test 25 FAIL: no writes should have happened');

  // T-507 round 1 (F4) discipline: the verdict is computed unconditionally,
  // so --allow-mass-delete suppresses the refusal but still REPORTS it.
  const allowed = buildInTreeRelocationFixture();
  const allowedOutput = execFileSync(
    'node', [OVERLAY_SCRIPT, allowed.assembledDir, allowed.cloneDir, '--allow-mass-delete'], { encoding: 'utf8' }
  );
  assert.ok(/NOTE: --allow-mass-delete suppressed/.test(allowedOutput), `Test 25 FAIL: expected a suppression NOTE, got: ${allowedOutput}`);
  assert.ok(
    /move-credit cap: 57 of 60 \(95\.0%\) >= 25\.0% whole-run move-credit cap/.test(allowedOutput),
    `Test 25 FAIL: expected the suppressed move-credit cap refusal to be reported under --allow-mass-delete, got: ${allowedOutput}`
  );
  assert.ok(/copied 60, deleted 57, preserved 0/.test(allowedOutput), `Test 25 FAIL: unexpected summary under --allow-mass-delete: ${allowedOutput}`);

  console.log('Test 25 passed: mechanism 2 end-to-end — an in-tree (RELATED) mass relocation that zeroes out every per-directory and whole-clone count is refused by the whole-run move-credit cap alone, and the refusal is still reported under --allow-mass-delete');
}

// Test 26: mechanism 2 unit boundary — exceedsMoveCreditCap() at, just under,
// and just over its ratio, plus the absolute floor and the empty-baseline
// bootstrap case.
{
  const {
    exceedsMoveCreditCap, MOVE_CREDIT_MAX_RATIO, MOVE_CREDIT_MIN_COUNT,
  } = require('./mavp-publish-overlay.js');

  assert.strictEqual(MOVE_CREDIT_MAX_RATIO, 0.25, 'Test 26 FAIL: expected a 0.25 whole-run move-credit cap');
  assert.strictEqual(MOVE_CREDIT_MIN_COUNT, 5, 'Test 26 FAIL: expected an absolute floor of 5 credited moves');

  assert.strictEqual(exceedsMoveCreditCap(9, 40), false, 'Test 26 FAIL: 9 of 40 (22.5%) is just under the cap and must pass');
  assert.strictEqual(exceedsMoveCreditCap(10, 40), true, 'Test 26 FAIL: 10 of 40 is EXACTLY 25% and must be refused (>=, not >)');
  assert.strictEqual(exceedsMoveCreditCap(11, 40), true, 'Test 26 FAIL: 11 of 40 (27.5%) is over the cap and must be refused');

  // The absolute floor: Test 15's legitimate 4-of-7 reorg is a 57% ratio and
  // must still pass; one more credited move in the same tiny tree does not.
  assert.strictEqual(exceedsMoveCreditCap(4, 7), false, 'Test 26 FAIL: below the absolute floor the ratio must not be consulted (Test 15 legitimate reorg shape)');
  assert.strictEqual(exceedsMoveCreditCap(5, 7), true, 'Test 26 FAIL: at the absolute floor with a ratio over the cap, the run must be refused');

  // Bootstrap: an empty/fully-preserved clone is vacuously safe, never a
  // division error.
  assert.strictEqual(exceedsMoveCreditCap(0, 0), false, 'Test 26 FAIL: a zero baseline must be vacuously safe');

  console.log('Test 26 passed: mechanism 2 boundary — exceedsMoveCreditCap() passes just under 25%, refuses at and over it, respects its absolute floor, and is vacuous on an empty baseline');
}

// Test 27: mechanism 3 — adjustDirStatsForMoves() is idempotent with respect
// to `rawDeleted`. Round 2 recorded as a LOW note that a SECOND call
// overwrote rawDeleted with the already-adjusted count, silently reverting
// tier 1's immunity to move credit.
{
  const {
    adjustDirStatsForMoves, findDirectoryViolations, planDeletion, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO,
  } = require('./mavp-publish-overlay.js');

  const dirStats = planDeletion(['solo/a.md', 'solo/b.md'], new Set(), []).dirStats; // 2 of 2 deleted
  const once = adjustDirStatsForMoves(dirStats, new Set(['solo/a.md', 'solo/b.md']));
  assert.strictEqual(once.get('solo').deleted, 0, 'Test 27 FAIL: both files credited as moves, so adjusted deleted should be 0');
  assert.strictEqual(once.get('solo').rawDeleted, 2, 'Test 27 FAIL: rawDeleted must be the pre-credit count after the first call');

  // Second call, feeding this function's own output back in.
  const twice = adjustDirStatsForMoves(once, new Set(['solo/a.md']));
  assert.strictEqual(twice.get('solo').rawDeleted, 2, 'Test 27 FAIL: a second call must NOT overwrite rawDeleted with the already-adjusted count');
  assert.strictEqual(twice.get('solo').deleted, 0, 'Test 27 FAIL: deleted must never go below zero on re-application');
  assert.strictEqual(twice.get('solo').total, 2, 'Test 27 FAIL: total must be unaffected by move-adjustment');
  assert.strictEqual(once.get('solo').rawDeleted, 2, 'Test 27 FAIL: the second call must not mutate its input Map');

  // Tier 1's full-wipe rule still fires after the double call.
  const violations = findDirectoryViolations(twice, MIN_DIR_SIZE, DIR_MAX_DELETE_RATIO);
  assert.strictEqual(violations.length, 1, 'Test 27 FAIL: expected the full-wipe rule to still fire after a double adjustment');
  assert.strictEqual(violations[0].reason, 'full-wipe', 'Test 27 FAIL: expected reason full-wipe after a double adjustment');
  assert.strictEqual(violations[0].deleted, 2, 'Test 27 FAIL: the full-wipe finding must report the RAW pre-credit count');

  console.log('Test 27 passed: mechanism 3 — adjustDirStatsForMoves() called twice yields the same rawDeleted, and tier 1\'s full-wipe rule still fires after the double call');
}

// Test 28: the load-bearing negative control — ordinary multi-directory
// evolution must still PASS with both new mechanisms active. A legitimate
// reorg moves 4 of one docs bucket's 7 files into docs/core/ (the 57%
// per-bucket credit that DISPROVES any per-bucket move-credit ceiling at or
// below 50%) AND 3 of a 30-file scripts bucket into scripts/lib/ — every
// destination related, every basename preserved, nothing lost. Total credit
// is 7 of a 60-file baseline (11.7%), comfortably under the whole-run cap.
{
  const assembledDir = mkTempDir('mavp-overlay-n1p-ordinary-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1p-ordinary-clone-');

  const layout = [
    { dir: 'docs', count: 7, name: (i) => `page-${i}.md` },
    { dir: 'scripts', count: 30, name: (i) => `tool-${i}.js` },
    { dir: 'templates', count: 10, name: (i) => `tpl-${i}.md` },
    { dir: 'skills', count: 8, name: (i) => `skill-${i}.md` },
    { dir: '', count: 5, name: (i) => `root-${i}.md` },
  ];
  const contentOf = (rel) => `content of ${rel}\n`;
  let baseline = 0;
  for (const bucket of layout) {
    for (let i = 0; i < bucket.count; i++) {
      const rel = bucket.dir ? `${bucket.dir}/${bucket.name(i)}` : bucket.name(i);
      writeFile(path.join(cloneDir, rel), contentOf(rel));
      baseline += 1;
      // Where each file lands in the assembled tree: docs/ files 3-6 move
      // down into docs/core/, scripts/ files 0-2 move down into scripts/lib/,
      // everything else ships from its original path.
      let dest = rel;
      if (bucket.dir === 'docs' && i >= 3) dest = `docs/core/${bucket.name(i)}`;
      if (bucket.dir === 'scripts' && i < 3) dest = `scripts/lib/${bucket.name(i)}`;
      writeFile(path.join(assembledDir, dest), contentOf(rel));
    }
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  assert.strictEqual(baseline, 60, 'Test 28 FAIL: unexpected fixture baseline size');

  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.strictEqual(result.status, 0, `Test 28 FAIL: an ordinary multi-directory reorg must NOT be refused, got exit ${result.status}:\n${result.stderr}`);
  assert.ok(/copied 60, deleted 7, preserved 0/.test(result.stdout), `Test 28 FAIL: unexpected summary: ${result.stdout}`);
  assert.ok(
    !/NOTE: --allow-mass-delete suppressed/.test(result.stdout),
    `Test 28 FAIL: nothing should have been suppressed on a clean run: ${result.stdout}`
  );
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, 'docs', 'core', 'page-3.md'), 'utf8'),
    contentOf('docs/page-3.md'),
    'Test 28 FAIL: the moved docs file should exist byte-identical at its new path'
  );
  assert.strictEqual(fs.existsSync(path.join(cloneDir, 'docs', 'page-3.md')), false, 'Test 28 FAIL: the old docs/page-3.md path should be gone (moved, not duplicated)');
  assert.strictEqual(
    fs.readFileSync(path.join(cloneDir, 'scripts', 'lib', 'tool-0.js'), 'utf8'),
    contentOf('scripts/tool-0.js'),
    'Test 28 FAIL: the moved scripts file should exist byte-identical at its new path'
  );

  console.log('Test 28 passed: ordinary multi-directory evolution — 4 of 7 docs files into docs/core/ plus 3 of 30 scripts files into scripts/lib/ (7 of 60 credited = 11.7%) still passes with relatedness and the whole-run cap active');
}

// Test 29: T-532 — the whole-run move-credit cap gets its own stand-down
// flag, --max-move-credit-ratio, following the exact precedent of
// --max-delete-ratio/--max-dir-delete-ratio. Reproduces the security
// reviewer's plausible legitimate release: a flat 105-file scripts/
// directory split into three related subdirectories, nothing deleted, no
// bucket emptied. 49 of the resulting 194-file baseline are credited moves
// (25.3%), which the cap alone refuses by default — forcing the operator to
// --allow-mass-delete (dropping every tier, including the full-wipe rule)
// is exactly the cries-wolf failure move credit exists to prevent. Raising
// only this tier's own ceiling must let the identical fixture through with
// no suppression at all.
{
  function buildScriptsSplitFixture() {
    const assembledDir = mkTempDir('mavp-overlay-n1p-flag-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-n1p-flag-clone-');
    const subdirs = ['sub-a', 'sub-b', 'sub-c'];
    for (let i = 0; i < 105; i++) {
      const name = `scripts-file-${i}.js`;
      const content = `content of scripts/${name}\n`;
      writeFile(path.join(cloneDir, 'scripts', name), content);
      if (i < 56) {
        writeFile(path.join(assembledDir, 'scripts', name), content); // stays in place
      } else {
        const sub = subdirs[i % subdirs.length];
        writeFile(path.join(assembledDir, 'scripts', sub, name), content); // related move
      }
    }
    for (let i = 0; i < 89; i++) {
      const name = `doc-file-${i}.md`;
      const content = `content of docs/${name}\n`;
      writeFile(path.join(cloneDir, 'docs', name), content);
      writeFile(path.join(assembledDir, 'docs', name), content); // untouched
    }
    writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    return { assembledDir, cloneDir };
  }

  // Fixture arithmetic sanity: 105 + 89 = 194 baseline; 105 - 56 = 49 moved
  // (49 / 194 = 25.3%, over the default 25.0% cap).
  assert.strictEqual(105 + 89, 194, 'Test 29 FAIL: fixture baseline arithmetic sanity check');
  assert.strictEqual(105 - 56, 49, 'Test 29 FAIL: fixture moved-count arithmetic sanity check');

  const refused = buildScriptsSplitFixture();
  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, refused.assembledDir, refused.cloneDir], { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 29 FAIL: expected the default cap to refuse a 49-of-194 (25.3%) related-move split, got exit ${result.status}:\n${result.stdout}`
  );

  // Whole-line assertion (not substring) — a substring assertion is how a
  // mutant survived earlier in this wave.
  const expectedLine = 'ERROR: refusing to overlay — move credit was granted to 49 of 194 non-preserved tracked file(s) in the clone (25.3%), meeting or exceeding the 25.0% whole-run move-credit cap (--max-move-credit-ratio). Move credit suppresses the per-directory and whole-clone deletion guards for the files it covers, so relocating this much of the published tree in a single overlay is refused on its own: for path-semantic files location IS function, and a mass relocation can disable the tree while every content-level gate (secret scan, size floor) still reports success. No files were copied or deleted. If this restructure is intentional, re-run with --allow-mass-delete (or raise the threshold with --max-move-credit-ratio).';
  const actualLine = result.stderr.split('\n').find((l) => l.startsWith('ERROR: refusing to overlay — move credit'));
  assert.strictEqual(
    actualLine,
    expectedLine,
    `Test 29 FAIL: expected the refusal to be this exact whole line, naming --max-move-credit-ratio verbatim, got:\n${result.stderr}`
  );
  assert.ok(fs.existsSync(path.join(refused.cloneDir, 'scripts', 'scripts-file-0.js')), 'Test 29 FAIL: no writes should have happened on refusal');

  // Raising ONLY this tier's own ceiling above 25.3% must let the SAME
  // fixture through cleanly, with NO suppression NOTE at all — proving the
  // flag actually reaches exceedsMoveCreditCap()'s call path rather than
  // being parsed and then ignored in favor of the hardcoded constant.
  const allowed = buildScriptsSplitFixture();
  const allowedOutput = execFileSync(
    'node', [OVERLAY_SCRIPT, allowed.assembledDir, allowed.cloneDir, '--max-move-credit-ratio', '0.3'],
    { encoding: 'utf8' }
  );
  assert.ok(
    !/NOTE: --allow-mass-delete suppressed/.test(allowedOutput),
    `Test 29 FAIL: --max-move-credit-ratio 0.3 should let this fixture through with no suppression NOTE at all, got: ${allowedOutput}`
  );
  assert.ok(
    /copied 194, deleted 49, preserved 0/.test(allowedOutput),
    `Test 29 FAIL: unexpected summary under --max-move-credit-ratio 0.3: ${allowedOutput}`
  );
  assert.strictEqual(
    fs.readFileSync(path.join(allowed.cloneDir, 'scripts', 'sub-c', 'scripts-file-56.js'), 'utf8'),
    'content of scripts/scripts-file-56.js\n',
    'Test 29 FAIL: the moved file should exist byte-identical at its related destination'
  );

  console.log('Test 29 passed: T-532 — --max-move-credit-ratio names itself verbatim in the cap refusal, reproduces the reviewer\'s scripts/-split fixture (49 of 194 = 25.3%) refusing by default, and 0.3 lets it through with no suppression NOTE');
}

// Test 30: T-532 tier independence — --max-move-credit-ratio 1 stands the
// cap down and NOTHING else. A fully-wiped, non-preserved, non-relocatable
// small bucket (5 of 5 files, at exactly MIN_DIR_SIZE, so the ratio rule
// would also apply — the full-wipe rule must be what fires, not that ratio)
// in the SAME overlay run as a large credited relocation must still refuse,
// via the full-wipe rule specifically, even though the cap itself is fully
// stood down for the whole run.
{
  const assembledDir = mkTempDir('mavp-overlay-n1p-tier-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-n1p-tier-clone-');
  const subdirs = ['sub-a', 'sub-b', 'sub-c'];
  for (let i = 0; i < 105; i++) {
    const name = `scripts-file-${i}.js`;
    const content = `content of scripts/${name}\n`;
    writeFile(path.join(cloneDir, 'scripts', name), content);
    if (i < 56) {
      writeFile(path.join(assembledDir, 'scripts', name), content);
    } else {
      const sub = subdirs[i % subdirs.length];
      writeFile(path.join(assembledDir, 'scripts', sub, name), content);
    }
  }
  for (let i = 0; i < 89; i++) {
    const name = `doc-file-${i}.md`;
    const content = `content of docs/${name}\n`;
    writeFile(path.join(cloneDir, 'docs', name), content);
    writeFile(path.join(assembledDir, 'docs', name), content);
  }
  // The bucket the full-wipe rule must catch: gone from the assembled tree
  // outright, and its content/basename appears nowhere else in either tree
  // — no move credit is possible, so this is genuine, unambiguous loss of
  // the whole bucket, non-preserved (publish-manifest.json's `preserve`
  // bucket has no entry covering it).
  for (let i = 0; i < 5; i++) {
    const name = `templates-file-${i}.md`;
    writeFile(path.join(cloneDir, 'templates', name), `content of templates/${name}\n`);
  }
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir, '--max-move-credit-ratio', '1'],
    { encoding: 'utf8' }
  );
  assert.strictEqual(
    result.status, 1,
    `Test 30 FAIL: expected exit 1 via the full-wipe rule even with the move-credit cap fully stood down, got exit ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /per-directory composition guard/.test(result.stderr),
    `Test 30 FAIL: expected the per-directory guard (carrying the full-wipe rule) to be what refuses, got: ${result.stderr}`
  );
  assert.ok(
    /templates: 5 of 5 \(100\.0%\) \[complete removal\]/.test(result.stderr),
    `Test 30 FAIL: expected the templates/ bucket to be reported as a complete removal (the full-wipe rule), got: ${result.stderr}`
  );
  // The move-credit cap and the whole-clone ratio must NOT be what refuses
  // here — the cap is genuinely stood down by the flag (not merely masked
  // by an earlier refusal), and the whole-clone ratio (5 of 199 = 2.5%)
  // never comes close to tripping. This is what makes the test non-vacuous:
  // the wiped bucket, and only the full-wipe rule, is doing the refusing.
  assert.ok(
    !/whole-run move-credit cap/.test(result.stderr),
    `Test 30 FAIL: the move-credit cap should be fully stood down by --max-move-credit-ratio 1 and never fire, got: ${result.stderr}`
  );
  assert.ok(
    !/planned deletion would remove \d+ of \d+ non-preserved tracked file\(s\)/.test(result.stderr),
    `Test 30 FAIL: the whole-clone ratio should not fire in this shape, got: ${result.stderr}`
  );
  assert.ok(fs.existsSync(path.join(cloneDir, 'templates', 'templates-file-0.md')), 'Test 30 FAIL: no writes should have happened on refusal');

  console.log('Test 30 passed: T-532 tier independence — --max-move-credit-ratio 1 stands down the cap alone; a fully-wiped non-preserved bucket in the same run is still refused via the full-wipe rule specifically');
}

// ---------------------------------------------------------------------------
// T-533 — COMMITTED PUBLISH SHAPE CONTRACT (the first tier here that is NOT a
// per-run delta guard).
//
// Round-4 security review proved the per-run family cannot be patched into
// composition-safety, two independent ways:
//   - MULTI-RUN RENEWAL: credited relocation is count-preserving, so the
//     move-credit budget renews IN FULL every publish. Four consecutive
//     overlays each relocating 47 of a 194-file baseline into
//     `<top-segment>/attic/` all exit 0 with no suppression NOTE and reach the
//     same end state as the round-3 attack — 147 of 194 files off their
//     functional paths — with every content-level gate green throughout.
//   - DENOMINATOR INFLATION: the guards police deletions and relocations but
//     never ADDITIONS, so a padding publish inflates the baseline and the same
//     drain measures smaller against it.
// Narrowing move credit again cannot close either (spreading the moves defeats
// any per-run shape rule), so the closure is a floor on the assembled END
// STATE, declared in a committed ledger. Run composition is irrelevant to a
// check on the end state, and absolute floors never read the baseline at all.
//
// Killers, one per mechanism:
//   Test 31 — the rule and its boundary (count == floor passes), the ledger
//     loader's fail-closed behavior, and the committed floors' own invariants.
//   Test 32 — criterion 1: the four-run 47-of-194 attic drain. Includes the
//     ledger-absent control proving all four runs pass today, and a
//     deep-drain re-check proving the floor named does not move when the
//     baseline shrinks (killing any baseline-derived floor).
//   Test 33 — criterion 3: T-526's 51-of-104 `scripts/` pure deletion.
//   Test 34 — criterion 4: --allow-mass-delete does not suppress a contract
//     refusal, and no runtime override of any kind exists.
//   Test 35 — criterion 5: the real ship set assembled against itself passes.
//   Test 36 — the exact-boundary and negative controls.
// Every pre-existing test above is untouched and unaffected: none of their
// fixtures declares a contract, and an absent ledger is skipped silently.
// ---------------------------------------------------------------------------

const {
  SHAPE_CONTRACT_RELATIVE_PATH: T533_CONTRACT_REL,
  loadShapeContract: t533LoadContract,
  findShapeContractViolations: t533FindViolations,
  listFilesRecursive: t533ListFiles,
  listCloneFilesExcludingGit: listCloneFilesForT533,
} = require('./mavp-publish-overlay.js');

const contentOfT533 = (rel) => `content of ${rel}\n`;

const T533_REAL_CONTRACT = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, ...T533_CONTRACT_REL.split('/')), 'utf8')
);
const T533_REAL_FLOORS = T533_REAL_CONTRACT.min_direct_files;

// Writes a fixture ledger at the same tree-relative path the overlay reads.
function t533WriteContract(treeDir, floors) {
  writeFile(
    path.join(treeDir, ...T533_CONTRACT_REL.split('/')),
    `${JSON.stringify({ min_direct_files: floors }, null, 2)}\n`
  );
}

// Fixture ledgers are seeded from the REAL committed floors, never from
// invented numbers — that is what makes the subsumption criteria bite: an
// under-seeded floor in the committed ledger fails these tests directly.
function t533RealFloorsFor(dirs, label) {
  const out = {};
  for (const dir of dirs) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(T533_REAL_FLOORS, dir),
      `${label} FAIL: the committed ledger must declare a floor for "${dir === '' ? '(root)' : dir}"`
    );
    out[dir] = T533_REAL_FLOORS[dir];
  }
  return out;
}

const t533ErrorLineOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('ERROR: refusing to overlay — the assembled tree does not satisfy'));
const t533FindingLinesOf = (stderr) => stderr.split('\n').filter((l) => l.startsWith('  - ')).join('\n');
const t533WriteGitDir = (cloneDir) =>
  writeFile(path.join(cloneDir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');

// The exact refusal line for a SINGLE violated directory (whole-line literal,
// Test 29 precedent — a substring assertion is how a mutant survived earlier in
// this wave). Deliberately contains nothing run-variable: no baseline count, no
// ratio, no absolute path.
const T533_EXPECTED_ERROR_LINE_ONE =
  'ERROR: refusing to overlay — the assembled tree does not satisfy the committed publish shape contract ' +
  '(scripts/publish-shape-contract.json): 1 declared directory holds fewer files DIRECTLY than the ' +
  "committed minimum. This tier checks the END STATE of the tree being published, not this run's delta, " +
  'so it cannot be renewed by spreading a drain across several runs nor diluted by inflating the tree ' +
  'with additions. It is not suppressed by --allow-mass-delete and has no runtime override: if this ' +
  'shape change is intentional, edit the committed ledger (scripts/publish-shape-contract.json) — that ' +
  'edit is the operator-review moment this contract exists to create. No files were copied or deleted. ' +
  'Affected directory:';

// Test 31: the rule, its boundary, and the loader's fail-closed behavior.
{
  // Absent ledger -> null, so the tier is skipped silently (this is what keeps
  // every pre-existing fixture, and any adopter tree, unaffected).
  const bareTree = mkTempDir('mavp-overlay-t533-absent-');
  assert.strictEqual(t533LoadContract(bareTree), null, 'Test 31 FAIL: an absent ledger must load as null (silent skip)');

  // STRUCTURAL: the rule takes the assembled file list and the floors, and
  // NOTHING else. There is no baseline parameter and there must never be one —
  // a floor derived from the baseline would be another delta guard.
  assert.strictEqual(
    t533FindViolations.length, 2,
    'Test 31 FAIL: findShapeContractViolations() must take exactly (assembledFiles, floors) — a baseline parameter would make it a delta guard'
  );

  const files = ['scripts/a.js', 'scripts/attic/b.js', 'scripts/attic/c.js', 'root.md', 'docs/core/x.md'];

  // DIRECT-CHILDREN semantics (dirOf(), non-recursive) — the load-bearing
  // detail: relocating a file into a subdirectory of its own directory lowers
  // that directory's own direct count.
  assert.deepStrictEqual(
    t533FindViolations(files, { scripts: 2 }), [{ dir: 'scripts', count: 1, floor: 2 }],
    'Test 31 FAIL: files nested under scripts/attic/ must NOT count towards the scripts bucket'
  );
  assert.deepStrictEqual(
    t533FindViolations(files, { docs: 1 }), [{ dir: 'docs', count: 0, floor: 1 }],
    'Test 31 FAIL: a declared directory holding only nested content counts 0 directly'
  );
  // The root pseudo-directory, keyed by the empty string.
  assert.deepStrictEqual(
    t533FindViolations(files, { '': 2 }), [{ dir: '', count: 1, floor: 2 }],
    'Test 31 FAIL: the root pseudo-directory must be checkable via the empty-string key'
  );
  assert.deepStrictEqual(t533FindViolations(files, { '': 1 }), [], 'Test 31 FAIL: root at its floor must pass');
  // Undeclared directories are never checked (additive growth needs no edit).
  assert.deepStrictEqual(t533FindViolations(files, {}), [], 'Test 31 FAIL: an empty contract declares nothing and must find nothing');

  // THE BOUNDARY: count === floor PASSES (a floor is a minimum, not a
  // trip-line); one below refuses.
  const three = ['d/a.md', 'd/b.md', 'd/c.md'];
  assert.deepStrictEqual(t533FindViolations(three, { d: 3 }), [], 'Test 31 FAIL: count === floor must PASS');
  assert.deepStrictEqual(
    t533FindViolations(three, { d: 4 }), [{ dir: 'd', count: 3, floor: 4 }],
    'Test 31 FAIL: exactly one file below the floor must refuse'
  );

  // Deterministic ordering, and a Map is accepted as well as a plain object.
  assert.deepStrictEqual(
    t533FindViolations([], { z: 1, a: 1, m: 1 }).map((v) => v.dir), ['a', 'm', 'z'],
    'Test 31 FAIL: violations must be sorted by directory label'
  );
  assert.deepStrictEqual(
    t533FindViolations(files, new Map([['scripts', 2]])), [{ dir: 'scripts', count: 1, floor: 2 }],
    'Test 31 FAIL: a Map of floors must be accepted (that is what the CLI passes)'
  );

  // The COMMITTED ledger's own invariants.
  assert.ok(
    Object.prototype.hasOwnProperty.call(T533_REAL_FLOORS, ''),
    'Test 31 FAIL: the committed ledger must declare the root pseudo-directory'
  );
  for (const [dir, floor] of Object.entries(T533_REAL_FLOORS)) {
    assert.ok(
      Number.isInteger(floor) && floor >= 1,
      `Test 31 FAIL: the committed floor for "${dir === '' ? '(root)' : dir}" must be an integer >= 1 (a floor of 0 is a no-op entry), got ${JSON.stringify(floor)}`
    );
  }
  assert.ok(
    T533_REAL_FLOORS.scripts >= 54,
    `Test 31 FAIL: the committed scripts floor must be at least 54 — T-526's reproduction leaves 53 files directly in scripts/, and a floor at or below 53 passes at equality (Test 33 is the end-to-end killer), got ${T533_REAL_FLOORS.scripts}`
  );
  assert.ok(
    T533_REAL_CONTRACT.derivation && typeof T533_REAL_CONTRACT.derivation.fraction === 'number',
    'Test 31 FAIL: the committed ledger must record its seeding fraction in a derivation block'
  );

  // FAIL-CLOSED: a ledger that EXISTS but cannot be read must refuse, never
  // degrade to "no contract" — otherwise a stray comma or a quoted floor is a
  // silent stand-down of the only non-delta tier in the file.
  const malformedCases = [
    { label: 'unparseable JSON', body: '{ "min_direct_files": { "scripts": 4, } }', expect: /could not parse the publish shape contract/ },
    { label: 'no min_direct_files', body: '{ "derivation": {} }', expect: /has no "min_direct_files" object/ },
    // T-540 widened the threshold from "below 0" to "below 1", so the shared
    // refusal message now says "below-1" where it used to say "negative". The
    // three DEGENERATE shapes that threshold closes have their own killer,
    // Test 38 — these two cases are T-533's originals, unchanged in substance.
    { label: 'a floor quoted as a string', body: '{ "min_direct_files": { "scripts": "4" } }', expect: /non-integer or below-1 floor for "scripts"/ },
    { label: 'a negative floor', body: '{ "min_direct_files": { "": -1 } }', expect: /non-integer or below-1 floor for "\(root\)"/ },
  ];
  for (const testCase of malformedCases) {
    const assembledDir = mkTempDir('mavp-overlay-t533-malformed-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t533-malformed-clone-');
    writeFile(path.join(assembledDir, 'keep.md'), 'keep\n');
    writeFile(path.join(cloneDir, 'keep.md'), 'keep\n');
    t533WriteGitDir(cloneDir);
    writeFile(path.join(assembledDir, ...T533_CONTRACT_REL.split('/')), testCase.body);
    const result = require('node:child_process').spawnSync(
      process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
    );
    assert.strictEqual(
      result.status, 1,
      `Test 31 FAIL (${testCase.label}): a present-but-malformed ledger must refuse, got exit ${result.status}:\n${result.stdout}`
    );
    assert.ok(
      testCase.expect.test(result.stderr),
      `Test 31 FAIL (${testCase.label}): unexpected refusal message: ${result.stderr}`
    );
  }

  console.log('Test 31 passed: the contract rule is direct-children-only, root-aware, passes at count === floor, refuses one below, reads no baseline at all, and a present-but-malformed ledger fails closed');
}

// T-540 criterion 4 — RECORDING ONLY, no test and no mutation. T-533's criterion
// 2 named "the mutant that lowers a floor" as the killer for its floors. Which
// assertion actually kills it is worth writing down, because the obvious answer
// is wrong: it is NOT Test 37's byte-equality differential between the padded and
// unpadded refusals. That differential compares two refusals to EACH OTHER, and
// Test 37's padding lands in an UNDECLARED directory (`pad/`), so lowering a
// declared floor changes both refusals identically and the equality still holds.
// What kills it in Test 37 is the separate literal `expectedFindings` assertion,
// which pins each directory's floor by value. And the semantically matched,
// strictly stronger pin lives in Test 32: the floor-does-not-move assertion
// (`floorNamedIn(run1.stderr) === floorNamedIn(run3.stderr)`) compares the floor
// named against a 105-file baseline with the floor named against a 13-file one,
// which no baseline-derived or baseline-scaled floor can satisfy. Read together:
// Test 37 pins the VALUES, Test 32 pins that the values are ABSOLUTE.
//
// Test 32 (criterion 1): the FOUR-RUN 47-of-194 attic drain. Run 1 is refused
// by the contract. The ledger-absent control runs all four overlays to
// completion (exit 0 each) and reaches the drained end state, which is what
// proves the drain is real, that no delta tier catches it, and that the
// contract is the sole thing that closes it.
{
  const buckets = [
    { dir: 'scripts', total: 105, stay: 13, name: (i) => `s-tool-${i}.js` },
    { dir: 'docs', total: 20, stay: 5, name: (i) => `d-page-${i}.md` },
    { dir: 'docs/core', total: 20, stay: 5, name: (i) => `dc-page-${i}.md` },
    { dir: 'templates', total: 20, stay: 5, name: (i) => `t-${i}.md` },
    { dir: 'skills', total: 15, stay: 5, name: (i) => `sk-${i}.md` },
    // Root-level files are deliberately NOT drained: a root-level source is
    // related only to a root-level destination (T-507 round 3, mechanism 1),
    // so relocating them earns no credit and would trip the delta tiers — the
    // surviving attack shape has to leave root alone.
    { dir: '', total: 14, stay: 14, name: (i) => `r-${i}.md` },
  ];
  const relOf = (bucket, i) => (bucket.dir ? `${bucket.dir}/${bucket.name(i)}` : bucket.name(i));
  const contentOf = (rel) => `content of ${rel}\n`;
  // The attack's destination: an attic directory INSIDE the source's own
  // top-level segment, so every credit is legitimately RELATED and every
  // basename is preserved.
  const atticOf = (rel) => {
    const slash = rel.indexOf('/');
    const lastSlash = rel.lastIndexOf('/');
    return `${rel.slice(0, slash)}/attic/${rel.slice(lastSlash + 1)}`;
  };

  const baseline = [];
  const drainable = [];
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.total; i++) {
      const rel = relOf(bucket, i);
      baseline.push(rel);
      if (i >= bucket.stay) drainable.push(rel);
    }
  }
  assert.strictEqual(baseline.length, 194, 'Test 32 FAIL: unexpected fixture baseline size');
  assert.strictEqual(drainable.length, 147, 'Test 32 FAIL: unexpected drainable-file count');

  const buildClone = () => {
    const cloneDir = mkTempDir('mavp-overlay-t533-drain-clone-');
    for (const rel of baseline) writeFile(path.join(cloneDir, rel), contentOf(rel));
    t533WriteGitDir(cloneDir);
    return cloneDir;
  };
  // The assembled tree after `drainedCount` cumulative relocations.
  const buildAssembled = (drainedCount, withContract) => {
    const assembledDir = mkTempDir('mavp-overlay-t533-drain-assembled-');
    const drained = new Set(drainable.slice(0, drainedCount));
    for (const rel of baseline) {
      writeFile(path.join(assembledDir, drained.has(rel) ? atticOf(rel) : rel), contentOf(rel));
    }
    if (withContract) {
      t533WriteContract(assembledDir, t533RealFloorsFor(['', 'scripts', 'docs', 'docs/core', 'templates', 'skills'], 'Test 32'));
    }
    return assembledDir;
  };

  // ---- The reviewer's reproduction: four runs, no ledger, all green. ----
  const controlClone = buildClone();
  const cumulative = [47, 94, 141, 147];
  const snapshots = [];
  cumulative.forEach((drainedCount, idx) => {
    const assembledDir = buildAssembled(drainedCount, false);
    const result = require('node:child_process').spawnSync(
      process.execPath, [OVERLAY_SCRIPT, assembledDir, controlClone], { encoding: 'utf8' }
    );
    assert.strictEqual(
      result.status, 0,
      `Test 32 FAIL (control run ${idx + 1}): the multi-run drain must still pass every per-run tier with no ledger present, got exit ${result.status}:\n${result.stderr}`
    );
    assert.ok(
      !/NOTE: --allow-mass-delete suppressed/.test(result.stdout),
      `Test 32 FAIL (control run ${idx + 1}): nothing should have been suppressed — the run is genuinely clean: ${result.stdout}`
    );
    const snapshot = mkTempDir('mavp-overlay-t533-drain-snapshot-');
    fs.cpSync(controlClone, snapshot, { recursive: true });
    snapshots.push(snapshot);
  });
  const controlEnd = listCloneFilesForT533(controlClone);
  assert.strictEqual(controlEnd.length, 194, 'Test 32 FAIL: the drain is count-preserving — the end state must still hold 194 files');
  assert.strictEqual(
    controlEnd.filter((rel) => rel.split('/').includes('attic')).length, 147,
    'Test 32 FAIL: the four-run control must end with 147 of 194 files off their functional paths'
  );
  assert.strictEqual(
    controlEnd.filter((rel) => rel.startsWith('scripts/') && !rel.startsWith('scripts/attic/')).length, 13,
    'Test 32 FAIL: the four-run control must drain scripts/ down to its 13 left-behind files'
  );

  // ---- Run 1, WITH the committed floors: refused before anything moves. ----
  const clone1 = buildClone();
  const assembled1 = buildAssembled(47, true);
  const run1 = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembled1, clone1], { encoding: 'utf8' }
  );
  assert.strictEqual(
    run1.status, 1,
    `Test 32 FAIL: run 1 of the attic drain must be refused by the shape contract, got exit ${run1.status}:\n${run1.stdout}`
  );
  assert.strictEqual(
    t533ErrorLineOf(run1.stderr), T533_EXPECTED_ERROR_LINE_ONE,
    `Test 32 FAIL: expected the refusal to be this exact whole line, naming the ledger path verbatim, got:\n${run1.stderr}`
  );
  assert.strictEqual(
    t533FindingLinesOf(run1.stderr),
    '  - scripts: 59 file(s) directly, below the committed floor of 64',
    `Test 32 FAIL: expected the finding to name the directory, its assembled direct count and its floor, got:\n${run1.stderr}`
  );
  // No-writes proof: every file the run would have relocated is still in place.
  assert.ok(fs.existsSync(path.join(clone1, 'scripts', 's-tool-13.js')), 'Test 32 FAIL: no writes should have happened on refusal');
  assert.strictEqual(listCloneFilesForT533(clone1).length, 194, 'Test 32 FAIL: the clone must be untouched after the refusal');
  assert.strictEqual(
    fs.existsSync(path.join(clone1, 'scripts', 'attic')), false,
    'Test 32 FAIL: no attic directory should have been created on refusal'
  );

  // ---- The state-guard property: re-check run 3 against the DEEP-DRAINED
  // clone from the control sequence (post-run-2, where scripts/ holds only 13
  // files directly). The floor named must be IDENTICAL to run 1's even though
  // the baseline it is measured against has collapsed from 105 to 13 — that is
  // what a baseline-derived floor could never do, and it is why splitting the
  // drain across runs buys nothing.
  const assembled3 = buildAssembled(141, true);
  const run3 = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembled3, snapshots[1]], { encoding: 'utf8' }
  );
  assert.strictEqual(
    run3.status, 1,
    `Test 32 FAIL: run 3 against the already-drained clone must also be refused, got exit ${run3.status}:\n${run3.stdout}`
  );
  assert.strictEqual(
    t533FindingLinesOf(run3.stderr),
    [
      '  - docs/core: 5 file(s) directly, below the committed floor of 7',
      '  - scripts: 14 file(s) directly, below the committed floor of 64',
      '  - templates: 5 file(s) directly, below the committed floor of 9',
    ].join('\n'),
    `Test 32 FAIL: unexpected deep-drain findings:\n${run3.stderr}`
  );
  const floorNamedIn = (stderr) => {
    const line = stderr.split('\n').find((l) => l.startsWith('  - scripts: '));
    return line && line.slice(line.lastIndexOf(' ') + 1);
  };
  assert.strictEqual(
    floorNamedIn(run1.stderr), floorNamedIn(run3.stderr),
    'Test 32 FAIL: the scripts floor must be the SAME absolute number whether the clone holds 105 or 13 files directly in scripts/ — a baseline-derived floor would move with it'
  );

  console.log('Test 32 passed: criterion 1 — the four-run 47-of-194 attic drain passes every per-run tier four times with no ledger (147 of 194 files relocated, scripts/ down to 13), and run 1 is refused by the committed contract naming the ledger path, directory, floor and assembled count; the same floor is named against a baseline collapsed to 13, so splitting the drain buys nothing');
}

// Test 33 (criterion 3): T-526 SUBSUMPTION, enforced rather than assumed. The
// reviewer's 51-of-104 `scripts/` PURE deletion (no relocation, no additions)
// clears every per-run tier by design — 49.0% per-directory (under 50%), one
// bucket touched (so the multi-directory ceiling never engages), 26.3% of the
// whole clone — and must now be refused by the contract.
{
  const buildFixture = (withContract) => {
    const assembledDir = mkTempDir('mavp-overlay-t533-t526-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t533-t526-clone-');
    // The ledger itself occupies one of scripts/'s slots when present (as it
    // does in the real ship set), so both variants hold exactly 104 files
    // directly in scripts/ and leave exactly 53 — 51 deleted either way.
    const tools = withContract ? 103 : 104;
    const kept = withContract ? 52 : 53;
    for (let i = 0; i < tools; i++) {
      const rel = `scripts/tool-${i}.js`;
      writeFile(path.join(cloneDir, rel), contentOfT533(rel));
      if (i < kept) writeFile(path.join(assembledDir, rel), contentOfT533(rel));
    }
    for (let i = 0; i < 90; i++) {
      const rel = `docs/d-page-${i}.md`;
      writeFile(path.join(cloneDir, rel), contentOfT533(rel));
      writeFile(path.join(assembledDir, rel), contentOfT533(rel));
    }
    if (withContract) {
      const floors = t533RealFloorsFor(['scripts', 'docs'], 'Test 33');
      t533WriteContract(assembledDir, floors);
      t533WriteContract(cloneDir, floors); // already published, so not a deletion
    }
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // The differential control: with no ledger, this is T-526 exactly — the
  // deletion goes through, all 51 files are removed, exit 0.
  const control = buildFixture(false);
  const controlOutput = execFileSync('node', [OVERLAY_SCRIPT, control.assembledDir, control.cloneDir], { encoding: 'utf8' });
  assert.ok(
    /copied 143, deleted 51, preserved 0/.test(controlOutput),
    `Test 33 FAIL (control): the 51-of-104 pure deletion must still slip past every per-run tier with no ledger present — that is the hole this contract closes: ${controlOutput}`
  );

  const fixture = buildFixture(true);
  const result = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, fixture.assembledDir, fixture.cloneDir], { encoding: 'utf8' }
  );
  assert.strictEqual(
    result.status, 1,
    `Test 33 FAIL: the 51-of-104 scripts/ deletion must be refused via the contract, got exit ${result.status}:\n${result.stdout}`
  );
  assert.strictEqual(
    t533ErrorLineOf(result.stderr), T533_EXPECTED_ERROR_LINE_ONE,
    `Test 33 FAIL: expected the exact contract refusal line, got:\n${result.stderr}`
  );
  // 53 is the number that pins the floor: a floor at or below 53 passes here
  // at equality (count === floor is a pass, by design), so an under-seeded
  // committed floor fails this assertion.
  assert.strictEqual(
    t533FindingLinesOf(result.stderr),
    `  - scripts: 53 file(s) directly, below the committed floor of ${T533_REAL_FLOORS.scripts}`,
    `Test 33 FAIL: expected the finding to name scripts/'s 53 remaining files against the committed floor, got:\n${result.stderr}`
  );
  assert.ok(
    T533_REAL_FLOORS.scripts > 53,
    'Test 33 FAIL: a committed scripts floor at or below 53 would pass this very reproduction — the subsumption would be fiction'
  );
  assert.strictEqual(
    fs.existsSync(path.join(fixture.cloneDir, 'scripts', 'tool-102.js')), true,
    'Test 33 FAIL: no writes should have happened on refusal (tool-102.js is one of the 51 deletion candidates)'
  );

  console.log('Test 33 passed: criterion 3 — T-526\'s 51-of-104 scripts/ pure deletion still passes every per-run tier with no ledger (51 files deleted, exit 0) and is refused by the contract at 53 files against the committed floor, so a floor at or below 53 fails this test');
}

// Test 34 (criterion 4): NO runtime override, and --allow-mass-delete does not
// suppress a contract refusal. The fixture is chosen so the same shape ALSO
// trips a delta tier the flag genuinely does suppress (a 10-of-18 root
// deletion, 55.6%), so the third run proves the flag works and the refusal in
// run 2 is not an artifact of a broken flag.
{
  const buildFixture = (withContract) => {
    const assembledDir = mkTempDir('mavp-overlay-t533-flag-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t533-flag-clone-');
    for (let i = 0; i < 18; i++) {
      const rel = `r-${i}.md`;
      writeFile(path.join(cloneDir, rel), contentOfT533(rel));
      if (i < 8) writeFile(path.join(assembledDir, rel), contentOfT533(rel));
    }
    for (let i = 0; i < 90; i++) {
      const rel = `docs/d-page-${i}.md`;
      writeFile(path.join(cloneDir, rel), contentOfT533(rel));
      writeFile(path.join(assembledDir, rel), contentOfT533(rel));
    }
    if (withContract) {
      const floors = t533RealFloorsFor(['', 'docs'], 'Test 34');
      t533WriteContract(assembledDir, floors);
      t533WriteContract(cloneDir, floors);
    }
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  const plain = buildFixture(true);
  const refused = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, plain.assembledDir, plain.cloneDir], { encoding: 'utf8' }
  );
  assert.strictEqual(refused.status, 1, `Test 34 FAIL: expected a refusal without the flag, got exit ${refused.status}`);
  assert.strictEqual(
    t533ErrorLineOf(refused.stderr), T533_EXPECTED_ERROR_LINE_ONE,
    `Test 34 FAIL: expected the exact contract refusal line, got:\n${refused.stderr}`
  );
  assert.strictEqual(
    t533FindingLinesOf(refused.stderr),
    '  - (root): 8 file(s) directly, below the committed floor of 10',
    `Test 34 FAIL: expected the ROOT pseudo-directory to be named as "(root)" with its count and floor, got:\n${refused.stderr}`
  );

  // The criterion: pass the flag and the contract still refuses, byte-identically.
  const withFlag = buildFixture(true);
  const suppressed = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, withFlag.assembledDir, withFlag.cloneDir, '--allow-mass-delete'],
    { encoding: 'utf8' }
  );
  assert.strictEqual(
    suppressed.status, 1,
    `Test 34 FAIL: --allow-mass-delete must NOT suppress a contract refusal, got exit ${suppressed.status}:\n${suppressed.stdout}`
  );
  assert.strictEqual(
    suppressed.stderr, refused.stderr,
    `Test 34 FAIL: --allow-mass-delete must not even alter the contract refusal, got:\n${suppressed.stderr}`
  );
  assert.strictEqual(
    fs.existsSync(path.join(withFlag.cloneDir, 'r-17.md')), true,
    'Test 34 FAIL: no writes should have happened even with --allow-mass-delete passed'
  );

  // Non-vacuity: the very same shape, with no ledger, IS let through by the
  // flag — so the flag is working, and the contract is what it cannot reach.
  const noLedger = buildFixture(false);
  const allowedOutput = execFileSync(
    'node', [OVERLAY_SCRIPT, noLedger.assembledDir, noLedger.cloneDir, '--allow-mass-delete'], { encoding: 'utf8' }
  );
  assert.ok(/NOTE: --allow-mass-delete suppressed/.test(allowedOutput), `Test 34 FAIL: expected a suppression NOTE, got: ${allowedOutput}`);
  assert.ok(
    /\(root\): 10 of 18 \(55\.6%\)/.test(allowedOutput),
    `Test 34 FAIL: expected the flag to suppress the per-directory refusal on the root bucket, got: ${allowedOutput}`
  );
  assert.ok(/copied 98, deleted 10, preserved 0/.test(allowedOutput), `Test 34 FAIL: unexpected summary: ${allowedOutput}`);

  // NO RUNTIME OVERRIDE of any kind: no flag, and no environment variable.
  const overlaySource = fs.readFileSync(OVERLAY_SCRIPT, 'utf8');
  assert.ok(
    !/process\.env/.test(overlaySource),
    'Test 34 FAIL: the overlay must read no environment variable at all — an env-var contract path or opt-out would be a runtime override'
  );
  const flagNames = (overlaySource.match(/--[a-z][a-z-]+/g) || []).filter((f) => /contract|shape|floor/.test(f));
  assert.deepStrictEqual(
    flagNames, [],
    `Test 34 FAIL: no contract-related CLI flag may exist — the sanctioned relaxation is an edit to the committed ledger, got: ${flagNames.join(', ')}`
  );
  const { parseArgs } = require('./mavp-publish-overlay.js');
  assert.deepStrictEqual(
    Object.keys(parseArgs(['/a', '/b'])).sort(),
    ['allowMassDelete', 'maxDeleteRatio', 'maxDirDeleteRatio', 'maxMoveCreditRatio', 'positional'],
    'Test 34 FAIL: parseArgs() must expose no new contract-related option'
  );

  console.log('Test 34 passed: criterion 4 — a contract refusal (root pseudo-directory, 8 against a floor of 10) is byte-identical with and without --allow-mass-delete, the same shape without a ledger IS let through by that flag, and no flag or environment variable can relax the contract');
}

// Test 35 (criterion 5): the REAL current ship set, assembled and overlaid
// against itself, passes with ZERO contract findings. Gated on the canonical
// repo for the same reason as Test 4 — the assembled shape only matches the
// committed floors against the private tracked set.
{
  let isCanonical;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'publish-manifest.json'), 'utf8'));
    const trackedOutput = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const trackedSet = new Set(trackedOutput.split('\n').filter(Boolean));
    isCanonical = Object.keys(manifest.exclude).every((k) => trackedSet.has(k));
  } catch {
    isCanonical = false;
  }

  if (!isCanonical) {
    console.log('[SKIP] Test 35 skipped: not the canonical (private) repo — the committed floors are seeded from the private tracked set');
  } else {
    const assembledDir = mkTempDir('mavp-overlay-t533-real-assembled-');
    const assemble = require('node:child_process').spawnSync(
      process.execPath, [path.join(__dirname, 'mavp-publish-assemble.js'), assembledDir],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.strictEqual(assemble.status, 0, `Test 35 FAIL: could not assemble the real ship set:\n${assemble.stdout}\n${assemble.stderr}`);

    // Non-vacuity first: the contract must actually BE in the assembled ship
    // set (i.e. classified `ship`), or "zero findings" would mean nothing.
    const floors = t533LoadContract(assembledDir);
    assert.ok(
      floors && floors.size > 0,
      'Test 35 FAIL: the committed ledger must ship — it is read from the assembled tree, so a ledger classified `exclude` would silently stand the whole tier down'
    );
    assert.deepStrictEqual(
      t533FindViolations(t533ListFiles(assembledDir), floors), [],
      'Test 35 FAIL: the real current ship set must satisfy its own committed floors with zero findings'
    );

    // And end-to-end: assembled against itself.
    const cloneDir = mkTempDir('mavp-overlay-t533-real-clone-');
    fs.cpSync(assembledDir, cloneDir, { recursive: true });
    t533WriteGitDir(cloneDir);
    const overlay = require('node:child_process').spawnSync(
      process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
    );
    assert.strictEqual(
      overlay.status, 0,
      `Test 35 FAIL: the real ship set overlaid onto itself must pass, got exit ${overlay.status}:\n${overlay.stderr}`
    );
    assert.ok(/deleted 0, preserved 0/.test(overlay.stdout), `Test 35 FAIL: unexpected summary: ${overlay.stdout}`);
    assert.ok(
      !/NOTE: --allow-mass-delete suppressed/.test(overlay.stdout),
      `Test 35 FAIL: nothing should have been suppressed: ${overlay.stdout}`
    );
    console.log(`Test 35 passed: criterion 5 — the real current ship set (${t533ListFiles(assembledDir).length} files) satisfies all ${floors.size} committed floors with zero findings and overlays onto itself cleanly`);
  }
}

// Test 36: the exact-boundary pin and the negative control, end-to-end. A tree
// built to sit EXACTLY at every committed floor passes; one file short in one
// bucket refuses; and the same one-file-short shape with no ledger passes,
// because a single-file deletion is ordinary evolution that every delta tier
// correctly allows.
{
  const buildCompliantTree = () => {
    const treeDir = mkTempDir('mavp-overlay-t533-boundary-tree-');
    for (const [dir, floor] of Object.entries(T533_REAL_FLOORS)) {
      // The ledger itself occupies one slot in its own directory.
      const fileCount = dir === 'scripts' ? floor - 1 : floor;
      for (let i = 0; i < fileCount; i++) {
        const rel = dir === '' ? `f-${i}.md` : `${dir}/f-${i}.md`;
        writeFile(path.join(treeDir, ...rel.split('/')), contentOfT533(rel));
      }
    }
    t533WriteContract(treeDir, T533_REAL_FLOORS);
    return treeDir;
  };

  const assembledDir = buildCompliantTree();
  const assembledFiles = t533ListFiles(assembledDir);

  // At the floor: zero findings. One above every floor: EVERY declared
  // directory reports — which proves the fixture sits exactly ON the boundary
  // rather than comfortably above it.
  assert.deepStrictEqual(
    t533FindViolations(assembledFiles, T533_REAL_FLOORS), [],
    'Test 36 FAIL: a tree sitting exactly at every committed floor must pass (count === floor is a pass)'
  );
  const plusOne = Object.fromEntries(Object.entries(T533_REAL_FLOORS).map(([dir, floor]) => [dir, floor + 1]));
  assert.strictEqual(
    t533FindViolations(assembledFiles, plusOne).length, Object.keys(T533_REAL_FLOORS).length,
    'Test 36 FAIL: with every floor raised by one, EVERY declared directory must report — otherwise this fixture is not on the boundary'
  );

  const cloneDir = mkTempDir('mavp-overlay-t533-boundary-clone-');
  fs.cpSync(assembledDir, cloneDir, { recursive: true });
  t533WriteGitDir(cloneDir);
  const atFloor = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  assert.strictEqual(
    atFloor.status, 0,
    `Test 36 FAIL: an overlay whose end state sits exactly at every floor must pass, got exit ${atFloor.status}:\n${atFloor.stderr}`
  );

  // One file short in one bucket (docs: 4 -> 3) — refused.
  const shortAssembled = mkTempDir('mavp-overlay-t533-boundary-short-assembled-');
  fs.cpSync(assembledDir, shortAssembled, { recursive: true });
  fs.rmSync(path.join(shortAssembled, 'docs', `f-${T533_REAL_FLOORS.docs - 1}.md`));
  const shortClone = mkTempDir('mavp-overlay-t533-boundary-short-clone-');
  fs.cpSync(assembledDir, shortClone, { recursive: true });
  t533WriteGitDir(shortClone);
  const short = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, shortAssembled, shortClone], { encoding: 'utf8' }
  );
  assert.strictEqual(short.status, 1, `Test 36 FAIL: one file below a floor must refuse, got exit ${short.status}:\n${short.stdout}`);
  assert.strictEqual(
    t533FindingLinesOf(short.stderr),
    `  - docs: ${T533_REAL_FLOORS.docs - 1} file(s) directly, below the committed floor of ${T533_REAL_FLOORS.docs}`,
    `Test 36 FAIL: unexpected finding for the one-file-short bucket:\n${short.stderr}`
  );

  // The same one-file-short shape with NO ledger passes — a single-file
  // deletion is ordinary evolution, so the contract is the only thing that
  // refused above.
  const noLedgerAssembled = mkTempDir('mavp-overlay-t533-boundary-noledger-assembled-');
  fs.cpSync(shortAssembled, noLedgerAssembled, { recursive: true });
  fs.rmSync(path.join(noLedgerAssembled, ...T533_CONTRACT_REL.split('/')));
  const noLedgerClone = mkTempDir('mavp-overlay-t533-boundary-noledger-clone-');
  fs.cpSync(assembledDir, noLedgerClone, { recursive: true });
  t533WriteGitDir(noLedgerClone);
  const noLedger = require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, noLedgerAssembled, noLedgerClone], { encoding: 'utf8' }
  );
  assert.strictEqual(
    noLedger.status, 0,
    `Test 36 FAIL: the identical one-file-short shape must pass with no ledger present, got exit ${noLedger.status}:\n${noLedger.stderr}`
  );

  console.log('Test 36 passed: a tree exactly at every committed floor passes (and reports every directory when each floor is raised by one), one file below a floor refuses, and the identical shape with no ledger passes');
}

// Test 37 (criterion 2): the DENOMINATOR-INFLATION collapse is dead. The
// overlay guards deletions and relocations but never ADDITIONS, so a padding
// publish inflates the baseline every per-run ratio is measured against: the
// same 147-file single-run relocation that the move-credit cap refuses at
// 75.8% of a 194-file baseline clears it at 18.5% of a padded one, collapsing
// the four-run drain into two runs. Both halves are reproduced here WITHOUT the
// ledger (the collapse is real), and with the ledger both are refused with a
// BYTE-IDENTICAL contract refusal — the differential-equality assertion, Test
// 24's precedent — because absolute floors on the assembled end state never
// read the baseline at all.
//
// T-540 criterion 4 — RECORDING ONLY, no test and no mutation: the byte-equality
// differential below is NOT what kills a lowered-floor mutant. The padding this
// test adds lands in an UNDECLARED directory, so a lowered floor moves both
// refusals in lockstep and the equality survives. The killer here is the literal
// `expectedFindings` assertion (each floor pinned by value); the semantically
// matched, stronger pin is Test 32's floor-does-not-move assertion. See the
// fuller note above Test 32.
{
  const buckets = [
    { dir: 'scripts', total: 105, stay: 13, name: (i) => `s-tool-${i}.js` },
    { dir: 'docs', total: 20, stay: 5, name: (i) => `d-page-${i}.md` },
    { dir: 'docs/core', total: 20, stay: 5, name: (i) => `dc-page-${i}.md` },
    { dir: 'templates', total: 20, stay: 5, name: (i) => `t-${i}.md` },
    { dir: 'skills', total: 15, stay: 5, name: (i) => `sk-${i}.md` },
    { dir: '', total: 14, stay: 14, name: (i) => `r-${i}.md` },
  ];
  const atticOf = (rel) => `${rel.slice(0, rel.indexOf('/'))}/attic/${rel.slice(rel.lastIndexOf('/') + 1)}`;
  const baseline = [];
  const drainable = [];
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.total; i++) {
      const rel = bucket.dir ? `${bucket.dir}/${bucket.name(i)}` : bucket.name(i);
      baseline.push(rel);
      if (i >= bucket.stay) drainable.push(rel);
    }
  }
  assert.strictEqual(baseline.length, 194, 'Test 37 FAIL: unexpected baseline size');
  assert.strictEqual(drainable.length, 147, 'Test 37 FAIL: unexpected relocation size');
  const PADDING = 600;
  const contractFloors = () => t533RealFloorsFor(['', 'scripts', 'docs', 'docs/core', 'templates', 'skills'], 'Test 37');

  const buildClone = () => {
    const cloneDir = mkTempDir('mavp-overlay-t533-inflate-clone-');
    for (const rel of baseline) writeFile(path.join(cloneDir, rel), contentOfT533(rel));
    t533WriteGitDir(cloneDir);
    return cloneDir;
  };
  // `relocate`: move every drainable file into its own top-level segment's
  // attic (all credited: related destination, identical basename, identical
  // bytes). `padding`: add PADDING files in an UNDECLARED directory, which is
  // what inflates the baseline for the next run.
  const buildAssembled = ({ relocate, padding, withContract }) => {
    const assembledDir = mkTempDir('mavp-overlay-t533-inflate-assembled-');
    const drained = new Set(relocate ? drainable : []);
    for (const rel of baseline) {
      writeFile(path.join(assembledDir, drained.has(rel) ? atticOf(rel) : rel), contentOfT533(rel));
    }
    if (padding) {
      for (let i = 0; i < PADDING; i++) {
        const rel = `pad/pad-${i}.md`;
        writeFile(path.join(assembledDir, `pad/pad-${i}.md`), contentOfT533(rel));
      }
    }
    if (withContract) t533WriteContract(assembledDir, contractFloors());
    return assembledDir;
  };
  const runOverlay = (assembledDir, cloneDir) =>
    require('node:child_process').spawnSync(process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' });

  // ---- Reproduce the collapse itself, with NO ledger anywhere. ----
  // Unpadded: 147 of 194 credited (75.8%) — the move-credit cap refuses.
  const unpaddedControlClone = buildClone();
  const unpaddedControl = runOverlay(buildAssembled({ relocate: true, padding: false, withContract: false }), unpaddedControlClone);
  assert.strictEqual(
    unpaddedControl.status, 1,
    `Test 37 FAIL (unpadded control): a 147-of-194 single-run relocation must be refused by the move-credit cap, got exit ${unpaddedControl.status}`
  );
  assert.ok(
    /move credit was granted to 147 of 194 non-preserved tracked file\(s\) in the clone \(75\.8%\)/.test(unpaddedControl.stderr),
    `Test 37 FAIL (unpadded control): expected the cap to be the refusing tier, got: ${unpaddedControl.stderr}`
  );
  // Padded: run 1 publishes the padding (zero deletions), run 2 performs the
  // IDENTICAL relocation and now measures 18.5% — the cap clears.
  const paddedControlClone = buildClone();
  const padRun = runOverlay(buildAssembled({ relocate: false, padding: true, withContract: false }), paddedControlClone);
  assert.strictEqual(padRun.status, 0, `Test 37 FAIL (padding run): a pure-addition publish must pass, got exit ${padRun.status}:\n${padRun.stderr}`);
  assert.strictEqual(
    listCloneFilesForT533(paddedControlClone).length, baseline.length + PADDING,
    'Test 37 FAIL (padding run): the padding must have inflated the clone baseline'
  );
  const paddedControl = runOverlay(buildAssembled({ relocate: true, padding: true, withContract: false }), paddedControlClone);
  assert.strictEqual(
    paddedControl.status, 0,
    `Test 37 FAIL (padded control): the collapse must reproduce — the same 147-file relocation passes once the baseline is inflated, got exit ${paddedControl.status}:\n${paddedControl.stderr}`
  );
  assert.ok(
    !/NOTE: --allow-mass-delete suppressed/.test(paddedControl.stdout),
    `Test 37 FAIL (padded control): the collapse is silent, not suppressed: ${paddedControl.stdout}`
  );
  assert.strictEqual(
    listCloneFilesForT533(paddedControlClone).filter((rel) => rel.split('/').includes('attic')).length, 147,
    'Test 37 FAIL (padded control): the single padded run must relocate all 147 files'
  );

  // ---- With the committed floors: both are refused, byte-identically. ----
  const unpadded = runOverlay(buildAssembled({ relocate: true, padding: false, withContract: true }), buildClone());
  const paddedClone = buildClone();
  const paddedSetup = runOverlay(buildAssembled({ relocate: false, padding: true, withContract: true }), paddedClone);
  assert.strictEqual(paddedSetup.status, 0, `Test 37 FAIL: the padding publish must still pass with the ledger present, got exit ${paddedSetup.status}:\n${paddedSetup.stderr}`);
  const padded = runOverlay(buildAssembled({ relocate: true, padding: true, withContract: true }), paddedClone);

  const expectedErrorLineThree =
    'ERROR: refusing to overlay — the assembled tree does not satisfy the committed publish shape contract ' +
    '(scripts/publish-shape-contract.json): 3 declared directories hold fewer files DIRECTLY than the ' +
    "committed minimum. This tier checks the END STATE of the tree being published, not this run's delta, " +
    'so it cannot be renewed by spreading a drain across several runs nor diluted by inflating the tree ' +
    'with additions. It is not suppressed by --allow-mass-delete and has no runtime override: if this ' +
    'shape change is intentional, edit the committed ledger (scripts/publish-shape-contract.json) — that ' +
    'edit is the operator-review moment this contract exists to create. No files were copied or deleted. ' +
    'Affected directories:';
  const expectedFindings = [
    '  - docs/core: 5 file(s) directly, below the committed floor of 7',
    '  - scripts: 14 file(s) directly, below the committed floor of 64',
    '  - templates: 5 file(s) directly, below the committed floor of 9',
  ].join('\n');

  for (const [label, result] of [['unpadded', unpadded], ['padded', padded]]) {
    assert.strictEqual(result.status, 1, `Test 37 FAIL (${label}): expected a contract refusal, got exit ${result.status}:\n${result.stdout}`);
  }

  // THE differential, asserted BEFORE the literal expectations so that it is
  // this assertion — not a hardcoded number elsewhere — that kills a
  // baseline-derived floor: byte equality of the entire refusal across a
  // 194-file baseline and a 795-file one. Any floor computed from a ratio of
  // the clone baseline (whole-clone or per-directory) scales with it and breaks
  // this equality; an absolute floor on the assembled end state cannot.
  assert.strictEqual(
    padded.stderr, unpadded.stderr,
    'Test 37 FAIL: the identical relocation must produce a BYTE-IDENTICAL contract refusal whether or not a padding publish inflated the baseline first'
  );

  for (const [label, result] of [['unpadded', unpadded], ['padded', padded]]) {
    assert.strictEqual(t533ErrorLineOf(result.stderr), expectedErrorLineThree, `Test 37 FAIL (${label}): unexpected refusal line:\n${result.stderr}`);
    assert.strictEqual(t533FindingLinesOf(result.stderr), expectedFindings, `Test 37 FAIL (${label}): unexpected findings:\n${result.stderr}`);
  }

  console.log('Test 37 passed: criterion 2 — the denominator-inflation collapse reproduces with no ledger (147-of-194 refused by the cap at 75.8%, the same relocation passing at 18.5% after a 600-file padding publish) and is dead with the contract: both runs refuse with byte-identical stderr across a 194-file and a 795-file baseline');
}

// ---------------------------------------------------------------------------
// T-540 — the three residuals T-533's security review left open. Tests 38-40.
// T-541 closes four confirmed residuals of ITS OWN review, folded into the
// same tests plus a new Test 41 — see each test's own comment for the T-541
// addition.
//
//   Test 38 (criterion 1) — DEGENERATE LEDGER SHAPES. The loader's own header
//     promised that a present-but-malformed ledger is a hard refusal and never
//     degrades to "no contract". Five shapes broke that promise at exit 0 with
//     no output and no contract: an empty declared object, an explicit zero
//     floor, and three duplicate-key shapes (last value zero, last value a
//     REAL nonzero floor the tree already satisfies, and equal repeated
//     values). The below-1 rule and the empty-set rule close the first two;
//     explicit duplicate-key detection on the raw text (T-541) closes all
//     three duplicate shapes uniformly, regardless of whether the repeated
//     values differ or are equal — plus the control that the real committed
//     ledger still loads under all of it, unedited.
//   Test 39 (criterion 2) — the NINE-FILE ENFORCEMENT REMOVAL against the real
//     ship set. The 0.6 fraction collapses to 1 on a 3-file bucket, i.e. "not
//     empty" — a line the pre-existing full-wipe rule already drew — and every
//     small bucket here is this project's own enforcement machinery. Each of the
//     three raised floors is asserted through its OWN violation line, so
//     reverting any single integer fails its own assertion rather than hiding
//     behind the other two still refusing the run. T-541: control A now
//     asserts count >= floor (a legitimate addition must not redden this
//     control), and both the per-directory and whole-block expected remaining
//     counts DERIVE from live directory counts minus the fixed drop rather
//     than hardcoded literals, so growth (e.g. a twelfth agent spec) does not
//     make the fixture rot; a growth guard per attacked directory asserts the
//     fixed drop still crosses its floor.
//   Test 40 (criterion 3) — the ENFORCEMENT SIGNAL. A release log used to be
//     byte-identical whether 18 floors were enforced or the tier had stood
//     down. T-541 adds a digest term (12 hex of sha256 over sorted dir=floor
//     pairs) alongside the count term, closing a SUM-shaped compensation gap:
//     two ledgers with the same key count but different floor values now
//     print different lines.
//   Test 41 (T-541 round 2 RESCOPE — a DRIFT INVARIANT, not a forgery check).
//     Round 1 shipped this as "the recompute invariant" (criterion 4) closing
//     the fourth residual outright. Round-2 security review found that framing
//     unclosable as specified: the test reads BOTH its inputs — the recorded
//     observed counts AND the floor map — from the SAME editable ledger file
//     it validates, so a coherent one-shot forgery of both (edit observed AND
//     floor together, e.g. 9/5 -> 3/2 on docs/assets) passes this test by
//     construction — reproduced end to end on the real assemble -> overlay
//     pipeline, draining a directory three files below its true committed
//     floor at exit 0. No in-file predicate can ever close that: the seeding
//     rule is codified IN the file, so a forger has everything the test has.
//     Test 41's CODE is unchanged (still recomputes floor_rule over the
//     recorded observed counts and deep-equals the committed floor map for
//     all 18 keys, still catches a changed fraction, a perturbed floor, or an
//     added/removed key) — what changes is the CLAIM: it is a drift invariant
//     that the committed floors still match what the codified algorithm
//     computes from the recorded observations, i.e. it catches a SLOPPY
//     re-seed (arithmetic mistake, stale fraction, a forgotten key) where the
//     observed-count edit and the floor edit disagree with the algorithm. It
//     does NOT and cannot catch a COHERENT forgery where both are edited
//     together to agree with each other. That forgery class is owned by the
//     new Test 42 / checkShapeContractSuccession() below, whose guarantee is
//     per-step MONOTONICITY plus MANDATORY VISIBILITY — never "forgery is
//     impossible". See scripts/publish-shape-contract.json's own
//     `succession_gate` field for the residuals this still does not close
//     (an N-step loud ratchet, remove-then-readd, and out-of-band mirror
//     tampering — all three closed by diff review at the same trust level as
//     deleting the ledger outright, not by any executable check).
//   Test 42 (T-541 round 2) — the SUCCESSION GATE. Compares the clone's
//     PREVIOUSLY PUBLISHED shape-contract ledger (the external anchor a
//     same-commit forgery cannot rewrite) against the one about to be
//     published: DATED (seeded_on must strictly advance on any change to the
//     seeding record), REAL (a re-seeded observed count must equal the
//     assembled tree's own live direct count at this publish) and REACHABLE
//     (a re-seeded observed count must be >= the previously published FLOOR).
//     A publish where the record is untouched never reaches any of the
//     three — dormant, byte-identical to no gate at all — but any floor that
//     moved down (or was dropped) still prints a loud, non-refusing
//     weakening line, preserving the ledger's own sanctioned floor-only
//     relaxation.
//
// ---------------------------------------------------------------------------

// Test 38 (criterion 1): the degenerate ledger shapes, end-to-end.
{
  // Every case goes through the CLI rather than an in-process loadShapeContract()
  // call: the loader refuses via fail() -> process.exit(1), which in-process
  // would take this runner down with it.
  const buildTree = (ledgerBody) => {
    // Assembled and clone hold the SAME files, so the run has zero deletions and
    // is unconditionally clean for every other tier. Any refusal is therefore
    // attributable to the ledger's shape alone — and the differential control
    // below proves it by swapping in a well-formed ledger on the same tree.
    const assembledDir = mkTempDir('mavp-overlay-t540-degenerate-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t540-degenerate-clone-');
    for (const rel of ['keep.md', 'd/a.md', 'd/b.md']) {
      writeFile(path.join(assembledDir, ...rel.split('/')), contentOfT533(rel));
      writeFile(path.join(cloneDir, ...rel.split('/')), contentOfT533(rel));
    }
    t533WriteGitDir(cloneDir);
    if (ledgerBody !== null) {
      writeFile(path.join(assembledDir, ...T533_CONTRACT_REL.split('/')), ledgerBody);
    }
    return { assembledDir, cloneDir };
  };
  const runOverlay = (assembledDir, cloneDir) => require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );

  const degenerateCases = [
    {
      label: 'an EMPTY declared object',
      // Closed by the empty-declared-set check. Killer for the mutant that
      // removes that check: without it the tier is a no-op at exit 0.
      body: '{ "min_direct_files": {} }',
      expect: /declares an EMPTY "min_direct_files" set/,
    },
    {
      label: 'an explicit zero floor',
      // Closed by the below-1 threshold. Killer for the mutant reverting the
      // threshold to below-0: a floor of 0 is satisfied by an EMPTY directory.
      body: '{ "min_direct_files": { "d": 0 } }',
      expect: /non-integer or below-1 floor for "d" \(got: 0\)/,
    },
    {
      label: 'a DUPLICATE key whose last value is zero',
      // T-541: now closed by explicit duplicate-key detection (see the two
      // cases below for why the below-1 rule alone is NOT sufficient — a
      // duplicate whose last value is a real floor the tree already
      // satisfies survives it).
      body: '{ "min_direct_files": { "d": 2, "d": 0 } }',
      expect: /declares the key "d" more than once/,
    },
    {
      label: 'a DUPLICATE key with a real nonzero last value the tree already satisfies',
      // T-541 residual: the below-1 rule alone only catches a duplicate whose
      // last value is 0. This tree holds exactly 2 files under "d", so under
      // the old rule this duplicate (last value 2) would load, enforce
      // nothing about the repetition, and pass at exit 0 — restoring the full
      // nine-file enforcement evacuation while the diff, the parsed key
      // count, and the enforcement signal all looked normal. Killer for the
      // mutant that removes the duplicate-key check entirely.
      body: '{ "min_direct_files": { "d": 1, "d": 2 } }',
      expect: /declares the key "d" more than once/,
    },
    {
      label: 'a DUPLICATE key with EQUAL values',
      // Kills a value-comparison-only mutant (e.g. "refuse only when the
      // first and last values differ"): a duplicate with IDENTICAL values is
      // still an unreviewed second declaration and must still refuse.
      body: '{ "min_direct_files": { "d": 2, "d": 2 } }',
      expect: /declares the key "d" more than once/,
    },
  ];

  for (const testCase of degenerateCases) {
    const { assembledDir, cloneDir } = buildTree(testCase.body);
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 38 FAIL (${testCase.label}): a present ledger of this shape must REFUSE — silently enforcing nothing at exit 0 is exactly the degradation the loader's contract forbids. Got exit ${result.status}, stdout:\n${result.stdout}`
    );
    assert.ok(
      testCase.expect.test(result.stderr),
      `Test 38 FAIL (${testCase.label}): unexpected refusal message:\n${result.stderr}`
    );
    // The refusal must NAME THE LEDGER PATH — an operator has to know which file
    // to fix, and the path is the only actionable thing in the message.
    assert.ok(
      result.stderr.includes(T533_CONTRACT_REL),
      `Test 38 FAIL (${testCase.label}): the refusal must name the ledger path "${T533_CONTRACT_REL}" verbatim:\n${result.stderr}`
    );
    assert.strictEqual(
      result.stdout, '',
      `Test 38 FAIL (${testCase.label}): a refusing run must print nothing on stdout — in particular not the enforcement signal, which would claim floors were enforced:\n${result.stdout}`
    );
  }

  // DIFFERENTIAL CONTROL: the identical tree with a WELL-FORMED one-entry ledger
  // passes at exit 0. So the three refusals above come from the ledger's shape,
  // not from anything about the fixture.
  const wellFormed = buildTree('{ "min_direct_files": { "d": 2 } }');
  const wellFormedRun = runOverlay(wellFormed.assembledDir, wellFormed.cloneDir);
  assert.strictEqual(
    wellFormedRun.status, 0,
    `Test 38 FAIL (control): the same tree with a well-formed ledger must pass, got exit ${wellFormedRun.status}:\n${wellFormedRun.stderr}`
  );

  // CONTROL: the REAL committed ledger still loads under both new rules, with no
  // edit needed beyond the three raised integers — the tightenings are pure.
  // (In-process on purpose: if the committed ledger were invalid, fail() would
  // exit(1) here and take this runner down loudly rather than skipping.)
  const realLedgerTree = mkTempDir('mavp-overlay-t540-real-ledger-');
  writeFile(
    path.join(realLedgerTree, ...T533_CONTRACT_REL.split('/')),
    fs.readFileSync(path.join(REPO_ROOT, ...T533_CONTRACT_REL.split('/')), 'utf8')
  );
  const loadedReal = t533LoadContract(realLedgerTree);
  assert.ok(loadedReal instanceof Map, 'Test 38 FAIL: the real committed ledger must load as a Map of floors');
  assert.deepStrictEqual(
    Object.fromEntries(loadedReal), T533_REAL_FLOORS,
    'Test 38 FAIL: the loaded floors must be exactly the committed ledger\'s min_direct_files'
  );
  assert.ok(loadedReal.size > 0, 'Test 38 FAIL: the real committed ledger must declare at least one floor');

  // VALUE PIN for the three floors T-540 raised, with the derivation arithmetic
  // in each message. Test 39 is the end-to-end killer but is canonical-repo
  // gated; this pin holds everywhere, so a silent revert of any one integer
  // fails here too.
  const t540RaisedFloors = [
    { dir: '.claude', floor: 2, was: 1, why: 'observed 3, small-directory term: max(floor(3*0.6)=1, 3-1=2, 0) = 2' },
    { dir: '.claude/rules', floor: 3, was: 1, why: 'observed 3, location-semantic term: max(floor(3*0.6)=1, 3-1=2, 3) = 3' },
    { dir: '.claude/agents', floor: 11, was: 6, why: 'observed 11, location-semantic term: max(floor(11*0.6)=6, 0, 11) = 11' },
  ];
  for (const { dir, floor, was, why } of t540RaisedFloors) {
    assert.strictEqual(
      loadedReal.get(dir), floor,
      `Test 38 FAIL: the committed floor for "${dir}" must be ${floor} (${why}); ${was} was the pre-T-540 flat-fraction value, which the pre-existing full-wipe rule already covered`
    );
  }

  // The derivation block must codify the COMPLETE algorithm, not just the base
  // fraction. This is what makes the armed re-seeding recheck reproducible: a
  // re-seed from a then-current ship set with the flat fraction alone would
  // silently regress all three floors above.
  const derivation = T533_REAL_CONTRACT.derivation;
  assert.ok(
    typeof derivation.floor_rule === 'string',
    'Test 38 FAIL: the derivation block must carry a floor_rule string stating the complete seeding algorithm'
  );
  for (const [term, pattern] of [
    ['the base fraction', /fraction/],
    ['the small-directory observed-minus-one rule', /observed\(dir\) - 1/],
    ['the location-semantic floor-equals-observed rule', /isLocationSemantic\(dir\) \? observed\(dir\)/],
    ['the max-wins combination', /max\(/],
    ['the clamp to a minimum of 1', /clamped up to a minimum of 1/],
  ]) {
    assert.ok(
      pattern.test(derivation.floor_rule),
      `Test 38 FAIL: derivation.floor_rule must state ${term} — otherwise a re-seed regresses to a flat fraction. Got: ${derivation.floor_rule}`
    );
  }
  assert.ok(
    typeof derivation.legitimate_release_cost === 'string' &&
      /EQUALITY/.test(derivation.legitimate_release_cost) &&
      /one-line edit/.test(derivation.legitimate_release_cost),
    'Test 38 FAIL: the derivation must state the legitimate-release costs in prose — small non-enforcement shrinkage passing at equality, and the one-line ledger edit a location-semantic removal now requires'
  );

  console.log('Test 38 passed: criterion 1 — an empty declared set, an explicit zero floor, and a duplicate key (last value zero, last value a real nonzero floor the tree already satisfies, and equal repeated values) each REFUSE naming the ledger path (all used to enforce nothing at exit 0, and a nonzero-floor duplicate is not actually closed by the below-1 rule), the same tree with a well-formed ledger passes, the real committed ledger still loads unedited, and the derivation block codifies all four parts of the seeding algorithm');
}

// Test 39 (criterion 2): the reviewer's NINE-FILE enforcement removal against the
// REAL ship set — 2 of 3 rules files, 5 of 11 agent specs, 2 of 3 top-level
// .claude files, removed in one publish. Canonical-repo gated for the same reason
// as Tests 4 and 35: the committed floors are seeded from the private tracked set.
{
  let isCanonical;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'publish-manifest.json'), 'utf8'));
    const trackedSet = new Set(
      execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    );
    isCanonical = Object.keys(manifest.exclude).every((k) => trackedSet.has(k));
  } catch {
    isCanonical = false;
  }

  if (!isCanonical) {
    console.log('[SKIP] Test 39 skipped: not the canonical (private) repo — the enforcement-directory floors are seeded from the private tracked set');
  } else {
    const { dirOf: dirOfForT540 } = require('./mavp-publish-overlay.js');
    const realAssembled = mkTempDir('mavp-overlay-t540-real-assembled-');
    const assemble = require('node:child_process').spawnSync(
      process.execPath, [path.join(__dirname, 'mavp-publish-assemble.js'), realAssembled],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    assert.strictEqual(assemble.status, 0, `Test 39 FAIL: could not assemble the real ship set:\n${assemble.stdout}\n${assemble.stderr}`);

    const realFiles = t533ListFiles(realAssembled);
    const directChildrenOf = (dir) => realFiles.filter((rel) => dirOfForT540(rel) === dir).sort();

    // CONTROL A: the untouched real ship set passes. T-541 — asserts count AT
    // LEAST floor rather than equality: a floor is a minimum, not a
    // trip-line, and a legitimate addition (e.g. a twelfth agent spec) must
    // not redden this control. Equality is not required for the fixture to be
    // meaningful — it merely happens to hold today.
    const agentsCount = directChildrenOf('.claude/agents').length;
    assert.ok(
      agentsCount >= T533_REAL_FLOORS['.claude/agents'],
      `Test 39 FAIL (control A): the real ship set must hold at least ${T533_REAL_FLOORS['.claude/agents']} agent specs directly (a floor is a minimum — additions must not redden this control), got ${agentsCount}`
    );
    assert.deepStrictEqual(
      t533FindViolations(realFiles, T533_REAL_FLOORS), [],
      'Test 39 FAIL (control A): the untouched real ship set must satisfy every raised floor with zero findings — the tightening must cost nothing on a legitimate release'
    );

    // The reproduction. Files are chosen positionally (the last N of each
    // directory's sorted direct children), never by name, so the fixture does not
    // rot when a rule, agent spec or top-level file is added or renamed.
    const dropped = [
      ...directChildrenOf('.claude/rules').slice(-2),
      ...directChildrenOf('.claude/agents').slice(-5),
      ...directChildrenOf('.claude').slice(-2),
    ];
    assert.strictEqual(dropped.length, 9, `Test 39 FAIL: the reproduction must remove exactly 9 enforcement files, got ${dropped.length}`);

    // T-541 — dropped-count and remaining-count helpers, DERIVED from the live
    // tree rather than hardcoded literals. A hardcoded remaining-count literal
    // (e.g. "6") gates ADDITIONS as well as removals: a twelfth agent spec
    // makes 12 minus 5 dropped equal 7 where a literal "6" expects 6, reddening
    // the suite on ordinary growth even after the equality control above is
    // relaxed. Only the floor itself (T533_REAL_FLOORS) still comes from the
    // recorded floors map — floors are the thing under test, not a derived
    // quantity.
    const dropCountFor = (dir) => dropped.filter((rel) => dirOfForT540(rel) === dir).length;
    const remainingCountFor = (dir) => directChildrenOf(dir).length - dropCountFor(dir);

    const buildAttacked = (withLedger) => {
      const assembledDir = mkTempDir('mavp-overlay-t540-attacked-assembled-');
      fs.cpSync(realAssembled, assembledDir, { recursive: true });
      for (const rel of dropped) fs.rmSync(path.join(assembledDir, ...rel.split('/')));
      if (!withLedger) fs.rmSync(path.join(assembledDir, ...T533_CONTRACT_REL.split('/')));
      const cloneDir = mkTempDir('mavp-overlay-t540-attacked-clone-');
      fs.cpSync(realAssembled, cloneDir, { recursive: true });
      t533WriteGitDir(cloneDir);
      return { assembledDir, cloneDir };
    };
    const runOverlay = ({ assembledDir, cloneDir }) => require('node:child_process').spawnSync(
      process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
    );

    // CONTROL B: the residual, reproduced. With no ledger, the same nine-file
    // removal goes through at exit 0 — every per-run tier passes it (5 of 11
    // agent specs is 45.5%, under the per-directory ratio; the other two
    // buckets are below MIN_DIR_SIZE and neither is fully wiped; the
    // small-directory aggregate and whole-clone ratios are nowhere near). The
    // clone here carries the REAL committed ledger (full derivation, T-541
    // rounds 2/3) copied byte-for-byte before the drop, so this is the
    // full-anchor x no-assembled-ledger cell of the T-541 round 3 truth
    // table: the sanctioned stand-down, which must be LOUD (not silent, as
    // round 2 left it) but must still NOT refuse.
    const noLedger = runOverlay(buildAttacked(false));
    assert.strictEqual(
      noLedger.status, 0,
      `Test 39 FAIL (control B): the nine-file enforcement removal must still pass every per-run tier with no ledger — that is the residual this test closes. Got exit ${noLedger.status}:\n${noLedger.stderr}`
    );
    assert.ok(
      /^WARNING: publish shape contract succession \(/.test(noLedger.stderr) && /stand(ing| down)/.test(noLedger.stderr),
      `Test 39 FAIL (control B, T-541 round 3): the assembled tree ships no ledger against a full clone anchor — must print a loud, non-refusing stand-down line naming the tier standing down. Got:\n${noLedger.stderr}`
    );
    assert.ok(
      !/NOTE: --allow-mass-delete suppressed/.test(noLedger.stdout),
      `Test 39 FAIL (control B): nothing should have been suppressed — the run is genuinely clean: ${noLedger.stdout}`
    );

    // WITH the ledger: refused, before any write.
    const attacked = buildAttacked(true);
    const refused = runOverlay(attacked);
    assert.strictEqual(
      refused.status, 1,
      `Test 39 FAIL: the nine-file enforcement removal must be refused by the contract, got exit ${refused.status}:\n${refused.stdout}`
    );

    // T-541 — GROWTH GUARD, one per attacked directory: the fixed nine-file
    // drop must still cross its own floor even after live growth (a fixed-size
    // attack must not be silently diluted by legitimate directory growth). If
    // this ever fails, the reproduction's drop counts above need to grow to
    // match — that is the actionable instruction the message gives.
    for (const dir of ['.claude', '.claude/agents', '.claude/rules']) {
      const remaining = remainingCountFor(dir);
      assert.ok(
        remaining < T533_REAL_FLOORS[dir],
        `Test 39 FAIL (growth guard): dropping ${dropCountFor(dir)} file(s) from "${dir}" (currently ${directChildrenOf(dir).length} directly) leaves ${remaining}, which no longer crosses the committed floor of ${T533_REAL_FLOORS[dir]} — the directory has grown enough that this fixture's fixed drop count needs to increase to keep reproducing a violation`
      );
    }

    // EACH of the three raised floors asserted through its OWN violation line.
    // Deliberately three separate assertions rather than one whole-block compare:
    // reverting a single raised integer still leaves the other two refusing the
    // run, so a "was it refused" (or even a "how many findings") assertion would
    // not detect it — only that directory's own line disappears. T-541: the
    // expected remaining COUNT is now derived from the live tree minus the
    // fixed drop (remainingCountFor) rather than a hardcoded literal, while the
    // FLOOR half of the line still comes from the recorded floors map — see
    // the header note above for why a hardcoded remaining-count literal also
    // gates additions, not just removals.
    const findingLineFor = (dir) =>
      refused.stderr.split('\n').find((l) => l.startsWith(`  - ${dir}: `));
    for (const dir of ['.claude', '.claude/agents', '.claude/rules']) {
      const count = remainingCountFor(dir);
      assert.strictEqual(
        findingLineFor(dir),
        `  - ${dir}: ${count} file(s) directly, below the committed floor of ${T533_REAL_FLOORS[dir]}`,
        `Test 39 FAIL: "${dir}" must report its own violation line naming ${count} remaining file(s) against the committed floor of ${T533_REAL_FLOORS[dir]} — reverting this one floor removes exactly this line while the run stays refused by the other two. Got:\n${refused.stderr}`
      );
    }
    // And nothing else fires: exactly these three directories, in sorted order.
    // Same derivation rule as above (live count minus fixed drop, floor from
    // the recorded map), so this whole-block compare doesn't rot on growth
    // either.
    assert.strictEqual(
      t533FindingLinesOf(refused.stderr),
      [
        `  - .claude: ${remainingCountFor('.claude')} file(s) directly, below the committed floor of ${T533_REAL_FLOORS['.claude']}`,
        `  - .claude/agents: ${remainingCountFor('.claude/agents')} file(s) directly, below the committed floor of ${T533_REAL_FLOORS['.claude/agents']}`,
        `  - .claude/rules: ${remainingCountFor('.claude/rules')} file(s) directly, below the committed floor of ${T533_REAL_FLOORS['.claude/rules']}`,
      ].join('\n'),
      `Test 39 FAIL: unexpected finding set:\n${refused.stderr}`
    );
    // No writes: every dropped file is still in the clone.
    for (const rel of dropped) {
      assert.strictEqual(
        fs.existsSync(path.join(attacked.cloneDir, ...rel.split('/'))), true,
        `Test 39 FAIL: no writes should have happened on refusal — ${rel} was one of the nine deletion candidates`
      );
    }

    console.log(`Test 39 passed: criterion 2 — nine enforcement files (2 of 3 rules, 5 of ${agentsCount} agent specs, 2 of 3 top-level bucket files) still pass every per-run tier at exit 0 with no ledger (T-541 round 3: loud stand-down against the real full clone anchor, never silent), and are refused by the raised floors with all three directories reporting their own DERIVED (live count minus fixed drop) violation line and a growth guard; the untouched ship set passes with the agents bucket at count >= floor === ${T533_REAL_FLOORS['.claude/agents']} (observed ${agentsCount})`);
  }
}

// Test 40 (criterion 3): the ENFORCEMENT SIGNAL — exactly one whole line on the
// pass path, naming the ledger path, the number of floors enforced, and (T-541)
// a digest over every declared dir=floor pair. A ledger-less run prints
// nothing, which is what makes the line informative.
//
// T-541 — every digest literal below is PRECOMPUTED independently of
// scripts/mavp-publish-overlay.js's shapeContractDigest() helper (sha256 of
// the exact "dir=floor" string, first 12 hex characters — reproducible with
// `printf '%s' 'd=2' | shasum -a 256`), never recomputed in-test by that same
// helper: a broken digest function would otherwise verify itself.
{
  const buildTree = (floors) => {
    const assembledDir = mkTempDir('mavp-overlay-t540-signal-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t540-signal-clone-');
    for (const rel of ['keep.md', 'd/a.md', 'd/b.md']) {
      writeFile(path.join(assembledDir, ...rel.split('/')), contentOfT533(rel));
      writeFile(path.join(cloneDir, ...rel.split('/')), contentOfT533(rel));
    }
    t533WriteGitDir(cloneDir);
    if (floors !== null) t533WriteContract(assembledDir, floors);
    return { assembledDir, cloneDir };
  };
  const runOverlay = ({ assembledDir, cloneDir }) => require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  const signalLinesOf = (stdout) => stdout.split('\n').filter((l) => l.startsWith('Publish shape contract ('));

  // Whole-line literals (Test 29/Test 31 precedent — a substring assertion is how
  // a mutant survived earlier in this wave), including the singular/plural form
  // and (T-541) the precomputed digest.
  const oneFloor = runOverlay(buildTree({ d: 2 }));
  assert.strictEqual(oneFloor.status, 0, `Test 40 FAIL: a passing run must exit 0, got ${oneFloor.status}:\n${oneFloor.stderr}`);
  assert.deepStrictEqual(
    signalLinesOf(oneFloor.stdout),
    [`Publish shape contract (${T533_CONTRACT_REL}): 1 declared directory floor enforced against the assembled tree (digest b5fcb2506318) — all satisfied.`],
    `Test 40 FAIL: a run that loads and passes the contract must print EXACTLY ONE whole-line signal naming the ledger path, the number of floors enforced, and the digest. Got:\n${oneFloor.stdout}`
  );

  const twoFloors = runOverlay(buildTree({ d: 2, '': 1 }));
  assert.strictEqual(twoFloors.status, 0, `Test 40 FAIL: a passing run must exit 0, got ${twoFloors.status}:\n${twoFloors.stderr}`);
  assert.deepStrictEqual(
    signalLinesOf(twoFloors.stdout),
    [`Publish shape contract (${T533_CONTRACT_REL}): 2 declared directory floors enforced against the assembled tree (digest f32307ea2fc1) — all satisfied.`],
    `Test 40 FAIL: the signal must count the floors actually enforced (2 here), pluralize, and print the digest over both sorted dir=floor pairs. Got:\n${twoFloors.stdout}`
  );

  // T-541 — DIGEST DIFFERENTIATION: two ledgers with the IDENTICAL key count
  // (1) but a DIFFERENT floor value must print different signal lines. A SUM
  // term would fail this the same way it fails the compensation case (see the
  // production comment) only when two floors move oppositely; a single floor
  // changing alone is the simplest case that already tells sum and digest
  // apart in the OTHER direction — a sum of 1 and a sum of 2 already differ,
  // so this alone does not kill a SUM mutant, but it does kill a mutant that
  // hardcodes the digest or derives it from the enforced COUNT alone (which
  // Test 40's two cases above already share no digest for, at counts 1 vs 2 —
  // this case pins that two SAME-count ledgers differ too).
  const oneFloorAlt = runOverlay(buildTree({ d: 1 }));
  assert.strictEqual(oneFloorAlt.status, 0, `Test 40 FAIL: a passing run must exit 0, got ${oneFloorAlt.status}:\n${oneFloorAlt.stderr}`);
  assert.deepStrictEqual(
    signalLinesOf(oneFloorAlt.stdout),
    [`Publish shape contract (${T533_CONTRACT_REL}): 1 declared directory floor enforced against the assembled tree (digest 35520a95b798) — all satisfied.`],
    `Test 40 FAIL: unexpected signal line for a different floor value at the same declared key count. Got:\n${oneFloorAlt.stdout}`
  );
  assert.notStrictEqual(
    signalLinesOf(oneFloorAlt.stdout)[0], signalLinesOf(oneFloor.stdout)[0],
    'Test 40 FAIL: two ledgers with identical key counts (1) but different floor values (1 vs 2) must print different signal lines — the digest term exists precisely so the count term alone cannot make them look the same'
  );

  // A LEDGER-LESS run prints no signal at all. Without this asymmetry the line
  // would be boilerplate: its whole value is that its absence means the tier did
  // not run.
  const noLedger = runOverlay(buildTree(null));
  assert.strictEqual(noLedger.status, 0, `Test 40 FAIL: a ledger-less run must still pass, got ${noLedger.status}:\n${noLedger.stderr}`);
  assert.deepStrictEqual(
    signalLinesOf(noLedger.stdout), [],
    `Test 40 FAIL: a ledger-less run must print NO enforcement signal — an absent ledger is a silent skip. Got:\n${noLedger.stdout}`
  );

  // A REFUSING run prints no signal either: it must never claim floors were
  // satisfied while it is refusing on them.
  const refusing = runOverlay(buildTree({ d: 3 }));
  assert.strictEqual(refusing.status, 1, `Test 40 FAIL: a below-floor tree must refuse, got ${refusing.status}:\n${refusing.stdout}`);
  assert.deepStrictEqual(
    signalLinesOf(refusing.stdout), [],
    `Test 40 FAIL: a refusing run must print no "all satisfied" signal. Got:\n${refusing.stdout}`
  );

  console.log('Test 40 passed: criterion 3 — a run that loads and passes the contract prints exactly one whole-line signal naming the ledger path, the floor count (singular and plural forms pinned) and a precomputed digest over sorted dir=floor pairs, two same-count ledgers with different floor values print different digests, while a ledger-less run and a refusing run print none');
}

// Test 41 (T-541 round 2 RESCOPE): a DRIFT INVARIANT, not a forgery check —
// see the header block above this section for the full rescope rationale. An
// 8-week recheck is armed to re-seed these floors, and the ledger's codified
// `floor_rule` (plus its four term fields) is exactly what that recheck must
// reproduce. Until round 1 that codification was verified only TEXTUALLY —
// Test 38's five regex phrases against the derivation.floor_rule STRING, plus
// three floor-value literals — which checks that the algorithm is DESCRIBED
// correctly, not that the committed floors actually MATCH what the
// description computes. This test recomputes the whole rule as CODE, using
// the overlay's own exported isLocationSemantic() predicate (so the two
// tiers can never independently drift — same reasoning as the ledger's own
// derivation block) and the ledger's own recorded fraction, over the
// RECORDED observed counts — deliberately NOT the live assembled tree:
// floors are minimums, so ordinary tree growth must never redden this
// suite, which is the identical mistake Test 39's hardcoded remaining-count
// literals made for criterion 2. What this test does NOT and cannot catch:
// a COHERENT one-shot forgery that edits the recorded observed counts AND
// the floor map TOGETHER so they still agree with floor_rule — both live in
// this same ledger, so a forger has everything this test has. That forgery
// class is Test 42's job, via an anchor (the clone's previously published
// ledger copy) this ledger file itself cannot provide.
{
  const { isLocationSemantic: t541IsLocationSemantic } = require('./mavp-publish-overlay.js');
  const observedCounts = T533_REAL_CONTRACT.derivation.observed_direct_file_counts_at_seeding;
  const fraction = T533_REAL_CONTRACT.derivation.fraction;
  assert.ok(
    observedCounts && typeof fraction === 'number',
    'Test 41 FAIL: the committed ledger must record both observed_direct_file_counts_at_seeding and derivation.fraction for this recompute to run against'
  );

  // The seeding algorithm, AS CODE: derivation.floor_rule's three terms (base
  // fraction, small-directory, location-semantic), max-combined, then clamped
  // up to a minimum of 1 — see derivation.floor_rule_term_* for the prose this
  // mirrors.
  function recomputeFloorRule(counts, frac) {
    const out = {};
    for (const [dir, observed] of Object.entries(counts)) {
      const baseFractionTerm = Math.floor(observed * frac);
      const smallDirectoryTerm = observed <= 4 ? observed - 1 : 0;
      const locationSemanticTerm = t541IsLocationSemantic(dir) ? observed : 0;
      out[dir] = Math.max(baseFractionTerm, smallDirectoryTerm, locationSemanticTerm, 1);
    }
    return out;
  }

  const recomputed = recomputeFloorRule(observedCounts, fraction);

  // T-545 — the SANCTIONED FLOOR-LOWERING GREEN PATH. An optional top-level
  // `floor_relaxations` field ({dir: {floor, on, why}}) folds the declared
  // keys' values over the pure recompute before the deep-equal below, so a
  // sanctioned lowering (floor dropped, seeding record left untouched) can
  // pass this invariant while a SILENT lowering (same floor drop, no
  // declaration) still reddens it. Deliberately top level, never inside
  // `derivation` — see scripts/publish-shape-contract.json's `succession_gate`
  // for why that placement is what keeps the succession gate provably
  // dormant on this path. `fold` and `validateFloorRelaxations` are pure and
  // in-process only (no fail()/process.exit anywhere in either) — the
  // validity rule below is a CI-time test assertion, never a publish-time
  // refusal, which is exactly criterion 3's requirement.
  function foldFloorRelaxations(floors, relaxations) {
    const out = { ...floors };
    for (const [dir, entry] of Object.entries(relaxations || {})) {
      out[dir] = entry.floor;
    }
    return out;
  }

  function validateFloorRelaxations(relaxations, minDirectFiles, recomputedFloors) {
    const errors = [];
    for (const [dir, entry] of Object.entries(relaxations || {})) {
      const label = dir === '' ? '(root)' : dir;
      if (!Object.prototype.hasOwnProperty.call(minDirectFiles, dir)) {
        errors.push(`floor_relaxations declares "${label}" which is not a key of min_direct_files`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`floor_relaxations["${label}"] must be an object with floor, on and why`);
        continue;
      }
      const { floor, on, why } = entry;
      if (!Number.isInteger(floor) || floor < 1) {
        errors.push(`floor_relaxations["${label}"].floor must be an integer >= 1 (got ${JSON.stringify(floor)})`);
      } else if (floor >= recomputedFloors[dir]) {
        errors.push(
          `floor_relaxations["${label}"].floor (${floor}) must be STRICTLY BELOW the recomputed floor ` +
          `(${recomputedFloors[dir]}) for that directory — this relaxation is stale or raise-shaped; delete the entry`
        );
      }
      if (typeof on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
        errors.push(`floor_relaxations["${label}"].on must be a canonical YYYY-MM-DD date (got ${JSON.stringify(on)})`);
      }
      if (typeof why !== 'string' || why.trim() === '') {
        errors.push(`floor_relaxations["${label}"].why must be a non-empty string`);
      }
    }
    return errors;
  }

  const realFloorRelaxations = T533_REAL_CONTRACT.floor_relaxations || {};

  // THE INVARIANT: fold(recompute, floor_relaxations) deep-equals the
  // committed floor map for ALL 18 keys — which gives key-set equality for
  // free, since deepStrictEqual fails outright on an extra or missing key on
  // either side. The real committed ledger declares no relaxations today, so
  // fold is the identity here and this is the pinned control: unchanged
  // behavior from before T-545.
  const folded = foldFloorRelaxations(recomputed, realFloorRelaxations);
  assert.deepStrictEqual(
    folded, T533_REAL_FLOORS,
    "Test 41 FAIL: recomputing the ledger's own codified floor_rule over the RECORDED observed counts and " +
    'the recorded fraction, folded with any declared floor_relaxations, must deep-equal the committed floor ' +
    'map for all 18 keys — a mismatch means the committed floors have drifted from the algorithm that is ' +
    'supposed to have produced them (or from a declared relaxation)'
  );
  assert.strictEqual(
    Object.keys(T533_REAL_FLOORS).length, 18,
    'Test 41 FAIL: the committed floor map must declare exactly 18 keys for this invariant to mean anything'
  );
  assert.deepStrictEqual(
    validateFloorRelaxations(realFloorRelaxations, T533_REAL_FLOORS, recomputed), [],
    'Test 41 FAIL: the committed ledger\'s own floor_relaxations (if any) must be valid'
  );

  // MUTANT 1 — the fraction. A changed fraction must NOT still produce the
  // committed floor map.
  assert.notDeepStrictEqual(
    recomputeFloorRule(observedCounts, fraction + 0.05), T533_REAL_FLOORS,
    'Test 41 FAIL: changing the fraction must break the deep-equal against the committed floor map'
  );

  // MUTANT 2 — perturbing any SINGLE floor by one. Looped over every key so a
  // mutant landing on any one specific directory is still caught, not just an
  // arbitrarily chosen one.
  for (const dir of Object.keys(T533_REAL_FLOORS)) {
    const perturbed = { ...T533_REAL_FLOORS, [dir]: T533_REAL_FLOORS[dir] + 1 };
    assert.notDeepStrictEqual(
      recomputed, perturbed,
      `Test 41 FAIL: perturbing "${dir === '' ? '(root)' : dir}" by one must break the deep-equal against the recomputed result`
    );
  }

  // MUTANT 3 — adding a key, and separately removing one. Key-set equality is
  // a free consequence of deepStrictEqual, not a separately maintained check.
  assert.notDeepStrictEqual(
    recomputed, { ...T533_REAL_FLOORS, 'synthetic/added-directory': 1 },
    'Test 41 FAIL: adding a key must break the deep-equal against the recomputed result'
  );
  const withOneKeyRemoved = { ...T533_REAL_FLOORS };
  delete withOneKeyRemoved[Object.keys(withOneKeyRemoved)[0]];
  assert.notDeepStrictEqual(
    recomputed, withOneKeyRemoved,
    'Test 41 FAIL: removing a key must break the deep-equal against the recomputed result'
  );

  // T-545 criterion 2 — DECLARED vs SILENT. A fixture pair byte-identical
  // except for the relaxation entry, run through the SAME fold/validate code
  // the real ledger uses above. "templates" is observed 16, recomputed floor
  // 9 (16*0.6=9.6 -> 9); the fixture lowers its COMMITTED floor to 5.
  const t545Dir = 'templates';
  assert.strictEqual(
    recomputed[t545Dir], 9,
    'Test 41 FAIL: fixture assumption broken — "templates" must recompute to floor 9 for the T-545 fixtures below to mean anything'
  );
  const t545LoweredCommittedFloors = { ...T533_REAL_FLOORS, [t545Dir]: 5 };
  const t545Relaxations = {
    [t545Dir]: { floor: 5, on: '2026-07-27', why: 'draining templates ahead of a planned trim' },
  };

  // DECLARED — the lowering WITH the relaxation entry passes.
  assert.deepStrictEqual(
    foldFloorRelaxations(recomputed, t545Relaxations), t545LoweredCommittedFloors,
    'Test 41 FAIL (T-545 declared): a lowered floor WITH its matching floor_relaxations entry must fold to equal the lowered committed floor map'
  );
  assert.deepStrictEqual(
    validateFloorRelaxations(t545Relaxations, t545LoweredCommittedFloors, recomputed), [],
    'Test 41 FAIL (T-545 declared): a strictly-below, canonically-dated, non-empty-reason relaxation must validate clean'
  );

  // SILENT — the SAME lowered committed floor map WITHOUT the relaxation
  // declared must still fail (a silent regression stays red).
  assert.notDeepStrictEqual(
    foldFloorRelaxations(recomputed, {}), t545LoweredCommittedFloors,
    'Test 41 FAIL (T-545 silent): the identical lowered committed floor map WITHOUT a declared relaxation must NOT fold to equal it — a silent lowering must stay red'
  );

  // MUTANT KILL A — deleting the fold. Comparing the raw, un-folded recompute
  // directly against the declared-lowering fixture must fail: only the fold
  // produces the declared value, so a mutant that deletes foldFloorRelaxations
  // (falling back to the bare recompute) fails the declared fixture.
  assert.notDeepStrictEqual(
    recomputed, t545LoweredCommittedFloors,
    'Test 41 FAIL (T-545 mutant A): deleting the fold (using the bare recompute) must fail the declared fixture — the fold is load-bearing, not cosmetic'
  );

  // MUTANT KILL B — deleting the strictly-below check. A raise-shaped entry
  // (floor >= the recomputed value, i.e. not actually a lowering) must be
  // REJECTED by the real validator, but a mutant missing that one branch
  // would silently accept it.
  const t545RaiseShaped = {
    [t545Dir]: { floor: 12, on: '2026-07-27', why: 'not actually a lowering' },
  };
  function t545MutantValidateMissingStrictlyBelow(relaxations, minDirectFiles) {
    const errors = [];
    for (const [dir, entry] of Object.entries(relaxations || {})) {
      const label = dir === '' ? '(root)' : dir;
      if (!Object.prototype.hasOwnProperty.call(minDirectFiles, dir)) {
        errors.push(`floor_relaxations declares "${label}" which is not a key of min_direct_files`);
        continue;
      }
      const { floor, on, why } = entry;
      if (!Number.isInteger(floor) || floor < 1) {
        errors.push(`floor_relaxations["${label}"].floor must be an integer >= 1 (got ${JSON.stringify(floor)})`);
      }
      // (the strictly-below-recomputed check is DELETED in this mutant)
      if (typeof on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
        errors.push(`floor_relaxations["${label}"].on must be a canonical YYYY-MM-DD date (got ${JSON.stringify(on)})`);
      }
      if (typeof why !== 'string' || why.trim() === '') {
        errors.push(`floor_relaxations["${label}"].why must be a non-empty string`);
      }
    }
    return errors;
  }
  assert.deepStrictEqual(
    t545MutantValidateMissingStrictlyBelow(t545RaiseShaped, T533_REAL_FLOORS), [],
    'Test 41 FAIL (T-545 mutant B setup): the mutant validator missing the strictly-below check must accept the raise-shaped entry (demonstrating the hole before the fix)'
  );
  const t545RealValidationOfRaise = validateFloorRelaxations(t545RaiseShaped, T533_REAL_FLOORS, recomputed);
  assert.strictEqual(
    t545RealValidationOfRaise.length, 1,
    `Test 41 FAIL (T-545 mutant B): the real validator must reject the raise-shaped entry (floor 12 >= recomputed 9). Got: ${JSON.stringify(t545RealValidationOfRaise)}`
  );
  assert.ok(
    /STRICTLY BELOW/.test(t545RealValidationOfRaise[0]),
    `Test 41 FAIL (T-545 mutant B): rejection message must name the strictly-below rule. Got: ${t545RealValidationOfRaise[0]}`
  );

  // T-545 criterion 3 — VALIDITY, CI-ONLY. Every case below is asserted via
  // validateFloorRelaxations() alone — a pure, in-process function with no
  // fail()/process.exit call anywhere in it, which is what makes every one of
  // these a CI-time test finding and never a publish-time refusal.

  // (a) SUBSET — a key not present in min_direct_files.
  const t545NotSubset = validateFloorRelaxations(
    { 'synthetic/not-a-real-directory': { floor: 1, on: '2026-07-27', why: 'x' } },
    T533_REAL_FLOORS, recomputed
  );
  assert.strictEqual(t545NotSubset.length, 1, `Test 41 FAIL (T-545 validity/subset): expected exactly one error. Got: ${JSON.stringify(t545NotSubset)}`);
  assert.ok(/not a key of min_direct_files/.test(t545NotSubset[0]), `Test 41 FAIL (T-545 validity/subset): wrong message: ${t545NotSubset[0]}`);

  // (b) non-integer / below-1 floor.
  const t545NonInteger = validateFloorRelaxations(
    { [t545Dir]: { floor: 3.5, on: '2026-07-27', why: 'x' } }, T533_REAL_FLOORS, recomputed
  );
  assert.strictEqual(t545NonInteger.length, 1, `Test 41 FAIL (T-545 validity/non-integer): expected exactly one error. Got: ${JSON.stringify(t545NonInteger)}`);
  assert.ok(/integer >= 1/.test(t545NonInteger[0]), `Test 41 FAIL (T-545 validity/non-integer): wrong message: ${t545NonInteger[0]}`);

  const t545BelowOne = validateFloorRelaxations(
    { [t545Dir]: { floor: 0, on: '2026-07-27', why: 'x' } }, T533_REAL_FLOORS, recomputed
  );
  assert.strictEqual(t545BelowOne.length, 1, `Test 41 FAIL (T-545 validity/below-1): expected exactly one error. Got: ${JSON.stringify(t545BelowOne)}`);
  assert.ok(/integer >= 1/.test(t545BelowOne[0]), `Test 41 FAIL (T-545 validity/below-1): wrong message: ${t545BelowOne[0]}`);

  // (c) STALE / RAISE-SHAPED, self-cleaning: a floor that no longer sits
  // strictly below the recomputed value — including the SELF-CLEANING case
  // where a LATER re-seed dropped the recomputed floor down to (or below) a
  // previously-valid declared relaxation. Simulated here by recomputing
  // against a post-re-seed observed-count map where "templates" shrank so its
  // own recomputed floor now equals the once-valid relaxation of 5.
  const t545PostReseedObserved = { ...observedCounts, [t545Dir]: 9 }; // was 16
  const t545PostReseedRecomputed = recomputeFloorRule(t545PostReseedObserved, fraction);
  assert.strictEqual(
    t545PostReseedRecomputed[t545Dir], 5,
    'Test 41 FAIL: fixture assumption broken — the simulated re-seed must drop "templates"\' recomputed floor to 5'
  );
  const t545StaleAfterReseed = validateFloorRelaxations(
    t545Relaxations, T533_REAL_FLOORS, t545PostReseedRecomputed
  );
  assert.strictEqual(
    t545StaleAfterReseed.length, 1,
    `Test 41 FAIL (T-545 validity/self-cleaning): a relaxation whose declared floor now sits at or above the RE-SEEDED recomputed floor must be flagged stale. Got: ${JSON.stringify(t545StaleAfterReseed)}`
  );
  assert.ok(
    /delete the entry/.test(t545StaleAfterReseed[0]),
    `Test 41 FAIL (T-545 validity/self-cleaning): message must name the one-line fix (delete the entry). Got: ${t545StaleAfterReseed[0]}`
  );

  // (d) malformed `on`.
  const t545BadDate = validateFloorRelaxations(
    { [t545Dir]: { floor: 5, on: '07/27/2026', why: 'x' } }, T533_REAL_FLOORS, recomputed
  );
  assert.strictEqual(t545BadDate.length, 1, `Test 41 FAIL (T-545 validity/date): expected exactly one error. Got: ${JSON.stringify(t545BadDate)}`);
  assert.ok(/canonical YYYY-MM-DD/.test(t545BadDate[0]), `Test 41 FAIL (T-545 validity/date): wrong message: ${t545BadDate[0]}`);

  // (e) empty `why`.
  const t545EmptyWhy = validateFloorRelaxations(
    { [t545Dir]: { floor: 5, on: '2026-07-27', why: '   ' } }, T533_REAL_FLOORS, recomputed
  );
  assert.strictEqual(t545EmptyWhy.length, 1, `Test 41 FAIL (T-545 validity/why): expected exactly one error. Got: ${JSON.stringify(t545EmptyWhy)}`);
  assert.ok(/non-empty string/.test(t545EmptyWhy[0]), `Test 41 FAIL (T-545 validity/why): wrong message: ${t545EmptyWhy[0]}`);

  const t545RelaxationNames = Object.keys(realFloorRelaxations);
  console.log(
    "Test 41 passed: DRIFT INVARIANT (T-541 round 2 rescope) — recomputing the ledger's own codified " +
    "floor_rule (base fraction, small-directory term, location-semantic term via the overlay's own exported " +
    'isLocationSemantic(), max, clamp to 1) over the RECORDED observed counts and the recorded fraction, ' +
    'FOLDED WITH ANY DECLARED floor_relaxations (T-545), deep-equals the committed floor map for all 18 keys ' +
    '(key-set equality included for free); changing the fraction, perturbing any single floor by one, and ' +
    'adding or removing any key each break the deep-equal — this catches a SLOPPY re-seed, never a coherent ' +
    'forgery that edits observed counts and floors together (Test 42 owns that); ' +
    `${t545RelaxationNames.length} active relaxation(s) in the real ledger today` +
    (t545RelaxationNames.length
      ? ` (${t545RelaxationNames.map((d) => (d === '' ? '(root)' : d)).join(', ')})`
      : ' (none)') +
    '; T-545 — a floor-only lowering declared via floor_relaxations passes (fixture: "templates" 9 -> 5 ' +
    'declared), the identical lowering left undeclared still fails, deleting the fold fails the declared ' +
    'fixture, a raise-shaped entry is rejected by name (and accepted by a mutant missing the strictly-below ' +
    'check), and each of subset/integer/stale-or-raise/date/reason validity is independently reddened'
  );
}

// ---------------------------------------------------------------------------
// Test 42 (T-541 round 2): the SUCCESSION GATE, end to end against the real
// CLI (never in-process — checkShapeContractSuccession() can call fail() ->
// process.exit(1), which in-process would take this runner down with it).
//
// Every fixture writes a FULL ledger (derivation.seeded_on +
// derivation.observed_direct_file_counts_at_seeding + min_direct_files) to
// whichever of {clone, assembled} is meant to carry a seeding record — this
// is deliberately different from Test 38/39/40's `t533WriteContract()`
// helper, which writes floors only with no derivation block at all, and
// which is exactly why those pre-existing fixtures are unaffected by this
// gate (see loadClonePublishedLedger()'s own comment: a ledger with no full
// seeding record is treated as "no anchor", not refused).
// ---------------------------------------------------------------------------
{
  const t541WriteFullLedger = (treeDir, { seededOn, observed, floors }) => {
    writeFile(
      path.join(treeDir, ...T533_CONTRACT_REL.split('/')),
      `${JSON.stringify(
        { derivation: { seeded_on: seededOn, observed_direct_file_counts_at_seeding: observed }, min_direct_files: floors },
        null, 2
      )}\n`
    );
  };
  const t541WriteDirFiles = (treeDir, dir, count) => {
    for (let i = 0; i < count; i++) {
      const rel = dir ? `${dir}/f${i}.md` : `f${i}.md`;
      writeFile(path.join(treeDir, ...rel.split('/')), contentOfT533(rel));
    }
  };
  const runOverlay = (assembledDir, cloneDir) => require('node:child_process').spawnSync(
    process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
  );
  const successionRefusalOf = (stderr) =>
    stderr.split('\n').find((l) => l.startsWith('ERROR: refusing to overlay — the publish shape contract succession gate'));
  const reseedLineOf = (stderr) =>
    stderr.split('\n').find((l) => l.startsWith('Publish shape contract succession ('));
  const weakeningHeaderOf = (stderr) =>
    stderr.split('\n').find((l) => l.startsWith('WARNING: publish shape contract'));
  const weakeningLinesOf = (stderr) =>
    stderr.split('\n').filter((l) => l.startsWith('  - ') && /floor (lowered|removed)/.test(l));
  const enforcementSignalOf = (stdout) =>
    stdout.split('\n').filter((l) => l.startsWith('Publish shape contract ('));

  // Common baseline: 3 files under "d" plus a top-level keep.md, in BOTH
  // clone and assembled, so every OTHER tier (deletion ratio, move credit,
  // full-wipe) is unconditionally clean and any refusal below is
  // attributable to the succession gate alone. Each case overrides the "d"
  // file count where it needs a different LIVE count.
  const buildBaseline = (dCount) => {
    const assembledDir = mkTempDir('mavp-overlay-t541-succession-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t541-succession-clone-');
    for (const dir of [assembledDir, cloneDir]) {
      writeFile(path.join(dir, 'keep.md'), contentOfT533('keep.md'));
      t541WriteDirFiles(dir, 'd', dCount);
    }
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // CASE 1 — the reviewer's reproduction verbatim: clone observed=9/floor=5,
  // assembled observed=3/floor=2, seeded_on UNCHANGED. The ORDINARY floor
  // check alone would pass here (live count 3 >= floor 2) — this is exactly
  // why round 1's ledger-only recompute invariant could not catch it, and
  // exactly what the succession gate exists to close.
  {
    const { assembledDir, cloneDir } = buildBaseline(3);
    t541WriteFullLedger(cloneDir, { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 5 } });
    t541WriteFullLedger(assembledDir, { seededOn: '2026-01-01', observed: { d: 3 }, floors: { d: 2 } });
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 42 FAIL (case 1, reviewer's reproduction): must be REFUSED even though the ordinary floor check (3 >= 2) passes. Got exit ${result.status}, stdout:\n${result.stdout}`
    );
    assert.strictEqual(result.stdout, '', `Test 42 FAIL (case 1): a refusing run must print nothing on stdout:\n${result.stdout}`);
    const refusal = successionRefusalOf(result.stderr);
    assert.ok(refusal, `Test 42 FAIL (case 1): expected a succession-gate refusal line on stderr:\n${result.stderr}`);
    assert.ok(
      /seeding record .* changed/.test(refusal) && /did not advance/.test(refusal) && refusal.includes('2026-01-01'),
      `Test 42 FAIL (case 1): refusal must name the seeding record change without seeded_on advancing, and the previously published date. Got:\n${refusal}`
    );
  }

  // CASE 2a — the same forgery with seeded_on ADVANCED: rule 1 (DATED) now
  // passes, so this must be caught by rule 3 (REACHABLE) instead — the
  // re-seeded observed count (3) is below the previously published FLOOR
  // (5). The live tree count is set to 3 (equal to the re-seeded observed
  // count) so rule 2 (REAL) passes and does NOT independently fire here —
  // isolating this refusal to rule 3 alone.
  {
    const { assembledDir, cloneDir } = buildBaseline(3);
    t541WriteFullLedger(cloneDir, { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 5 } });
    t541WriteFullLedger(assembledDir, { seededOn: '2026-02-01', observed: { d: 3 }, floors: { d: 2 } });
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 42 FAIL (case 2a, reachable): must be REFUSED — re-seeded observed 3 is below the previously published floor 5. Got exit ${result.status}, stdout:\n${result.stdout}`
    );
    const refusal = successionRefusalOf(result.stderr);
    assert.ok(refusal, `Test 42 FAIL (case 2a): expected a succession-gate refusal line:\n${result.stderr}`);
    assert.ok(
      refusal.includes('"d"') && refusal.includes('(3)') && /below the previously published floor of 5/.test(refusal),
      `Test 42 FAIL (case 2a): refusal must name "d", the re-seeded count 3, and the previously published floor 5. Got:\n${refusal}`
    );
  }

  // CASE 2b — INDEPENDENTLY refused when a re-seeded observed count differs
  // from the assembled tree's actual direct count at THIS publish (rule 2,
  // REAL). Re-seeded observed = 6, which is >= the previously published
  // floor of 5 (rule 3 passes cleanly), but the live tree actually holds
  // only 5 files under "d" — the ledger drifted after being edited.
  {
    const { assembledDir, cloneDir } = buildBaseline(5);
    t541WriteFullLedger(cloneDir, { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 5 } });
    t541WriteFullLedger(assembledDir, { seededOn: '2026-02-01', observed: { d: 6 }, floors: { d: 3 } });
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 42 FAIL (case 2b, real/drift): must be REFUSED — re-seeded observed 6 does not match the live tree's actual count of 5. Got exit ${result.status}, stdout:\n${result.stdout}`
    );
    const refusal = successionRefusalOf(result.stderr);
    assert.ok(refusal, `Test 42 FAIL (case 2b): expected a succession-gate refusal line:\n${result.stderr}`);
    assert.ok(
      refusal.includes('"d"') && refusal.includes('(6)') && refusal.includes('(5)') && /does not match the assembled tree/.test(refusal),
      `Test 42 FAIL (case 2b): refusal must name "d", the re-seeded count 6, and the live count 5. Got:\n${refusal}`
    );
  }

  // CASE 3 — an UNTOUCHED ledger (byte-identical seeding record) with a
  // GROWN assembled tree, against a full CLONE anchor: exits 0 with the
  // byte-identical enforcement signal and NO succession output at all.
  //
  // T-541 ROUND 4 NOTE: round 2/3 also proved this byte-identical to a "no
  // clone ledger at all" (genesis) control — i.e. genesis contributed
  // nothing beyond the ordinary floor check. Round 4 deliberately ENDS that
  // equivalence (finding 2: genesis's unconditional silence was exactly what
  // made a stand-down -> genesis -> re-introduce cycle invisible) — genesis
  // with a full, valid assembled derivation is now a loud, non-refusing
  // RECORD-INTRODUCTION event instead of a silent no-op. The differential
  // control below is kept, but its assertion is now the OPPOSITE of round
  // 2/3's: the two outputs are asserted to DIFFER, and the genesis side
  // carries the loud INTRODUCED line. See Test 43 (truth table) and Test 50
  // (T-541 round 4, criterion 2) for the full genesis/introduction coverage.
  {
    const identicalLedger = { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 2 } };
    const withClone = buildBaseline(6); // grown well past the floor of 2
    t541WriteFullLedger(withClone.assembledDir, identicalLedger);
    t541WriteFullLedger(withClone.cloneDir, identicalLedger);
    const withCloneResult = runOverlay(withClone.assembledDir, withClone.cloneDir);
    assert.strictEqual(
      withCloneResult.status, 0,
      `Test 42 FAIL (case 3, with untouched clone ledger): growth against an untouched floor must pass, got exit ${withCloneResult.status}:\n${withCloneResult.stderr}`
    );
    assert.strictEqual(withCloneResult.stderr, '', `Test 42 FAIL (case 3): an untouched record must print NO succession output whatsoever:\n${withCloneResult.stderr}`);
    assert.strictEqual(
      enforcementSignalOf(withCloneResult.stdout).length, 1,
      `Test 42 FAIL (case 3): the ordinary enforcement signal must still print exactly once:\n${withCloneResult.stdout}`
    );

    // The SAME record introduced at GENESIS (no clone ledger at all)
    // instead, with its observed count matched to THIS run's own live tree
    // (9) — a coincidence this fixture keeps for readability only, since
    // T-541 round 4 CORRECTED means introduction does not check observed
    // counts against the live tree at all (trust-on-first-use). T-541
    // round 4: this must now PASS LOUDLY with an INTRODUCED line — no
    // longer dormant, and therefore no longer byte-identical to the
    // withClone case above.
    const noClone = buildBaseline(9);
    t541WriteFullLedger(noClone.assembledDir, identicalLedger);
    // Deliberately no ledger written to noClone.cloneDir at all.
    const noCloneResult = runOverlay(noClone.assembledDir, noClone.cloneDir);
    assert.strictEqual(
      noCloneResult.status, 0,
      `Test 42 FAIL (case 3, genesis introduction): must PASS, got exit ${noCloneResult.status}:\n${noCloneResult.stderr}`
    );
    assert.ok(
      /first full introduction/.test(noCloneResult.stderr),
      `Test 42 FAIL (case 3, genesis introduction): expected a loud INTRODUCED line (T-541 round 4 — genesis is no longer silent):\n${noCloneResult.stderr}`
    );
    assert.notStrictEqual(
      withCloneResult.stderr, noCloneResult.stderr,
      'Test 42 FAIL (case 3): T-541 round 4 deliberately ENDS the round-2/3 equivalence between "untouched clone ' +
      'anchor" and "no clone at all" — genesis must now diverge (loud) from an established, unchanged anchor (silent)'
    );
  }

  // CASE 4 — an HONEST RE-SEED: seeded_on advanced, the re-seeded observed
  // count (5) equals BOTH the live tree's actual direct count (rule 2) and
  // is >= the previously published floor of 5 (rule 3). Exits 0 printing a
  // DATED re-seed line; the floor also moved down (5 -> 3) in the same
  // re-seed, so a WEAKENING line is printed alongside it.
  {
    const { assembledDir, cloneDir } = buildBaseline(5);
    t541WriteFullLedger(cloneDir, { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 5 } });
    t541WriteFullLedger(assembledDir, { seededOn: '2026-03-01', observed: { d: 5 }, floors: { d: 3 } });
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 42 FAIL (case 4, honest re-seed): must PASS, got exit ${result.status}:\n${result.stderr}`);
    const reseedLine = reseedLineOf(result.stderr);
    assert.ok(reseedLine, `Test 42 FAIL (case 4): expected a dated re-seed line on stderr:\n${result.stderr}`);
    assert.ok(
      reseedLine.includes('2026-03-01') && reseedLine.includes('2026-01-01'),
      `Test 42 FAIL (case 4): re-seed line must name both the new and the previously published seeded_on dates:\n${reseedLine}`
    );
    assert.ok(weakeningHeaderOf(result.stderr), `Test 42 FAIL (case 4): expected a weakening header line:\n${result.stderr}`);
    assert.deepStrictEqual(
      weakeningLinesOf(result.stderr), ['  - d: floor lowered from 5 to 3'],
      `Test 42 FAIL (case 4): expected exactly one weakening line naming "d" lowered from 5 to 3. Got:\n${result.stderr}`
    );
    assert.strictEqual(
      enforcementSignalOf(result.stdout).length, 1,
      `Test 42 FAIL (case 4): the ordinary enforcement signal must still print on the pass path:\n${result.stdout}`
    );
  }

  // CASE 5 — a FLOOR-ONLY lowering with the seeding record UNTOUCHED: NOT
  // refused (how_to_relax's sanctioned relaxation preserved), but the
  // weakening line still prints. No re-seed line, since the record itself
  // never changed.
  {
    const { assembledDir, cloneDir } = buildBaseline(9);
    const unchangedRecord = { seededOn: '2026-01-01', observed: { d: 9 } };
    t541WriteFullLedger(cloneDir, { ...unchangedRecord, floors: { d: 5 } });
    t541WriteFullLedger(assembledDir, { ...unchangedRecord, floors: { d: 3 } });
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 42 FAIL (case 5, floor-only lowering): must NOT be refused, got exit ${result.status}:\n${result.stderr}`);
    assert.strictEqual(
      reseedLineOf(result.stderr), undefined,
      `Test 42 FAIL (case 5): no re-seed line should print — the seeding record itself never changed:\n${result.stderr}`
    );
    assert.deepStrictEqual(
      weakeningLinesOf(result.stderr), ['  - d: floor lowered from 5 to 3'],
      `Test 42 FAIL (case 5): expected exactly one weakening line naming "d" lowered from 5 to 3. Got:\n${result.stderr}`
    );
  }

  // CASE 6a — a clone with NO ledger at all (bootstrap / first-ever publish)
  // and an assembled ledger carrying FLOORS ONLY (no derivation block at
  // all, unlike this test's other cases): the succession gate has nothing
  // complete to check on either side (current stays null), so it skips
  // silently and the ordinary floor check still enforces normally. T-541
  // round 4 note: a FULL assembled derivation here would now be a
  // RECORD-INTRODUCTION event (see Test 43/50) rather than staying dormant —
  // this case is deliberately kept to a bare floors-only ledger so it
  // continues to test the succession gate's ABSENCE, unaffected by that
  // change.
  {
    const { assembledDir, cloneDir } = buildBaseline(4);
    t533WriteContract(assembledDir, { d: 2 });
    // Deliberately no ledger written to cloneDir.
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 42 FAIL (case 6a, no clone ledger): must PASS, got exit ${result.status}:\n${result.stderr}`);
    assert.strictEqual(result.stderr, '', `Test 42 FAIL (case 6a): a ledger-less clone must produce NO succession output:\n${result.stderr}`);
    assert.strictEqual(
      enforcementSignalOf(result.stdout).length, 1,
      `Test 42 FAIL (case 6a): the ordinary enforcement signal must still print:\n${result.stdout}`
    );
  }

  // CASE 6b — a clone with an UNPARSEABLE (out-of-band tampered/corrupted)
  // ledger: refused, naming the mirror as the object to investigate.
  {
    const { assembledDir, cloneDir } = buildBaseline(4);
    t533WriteContract(assembledDir, { d: 2 });
    writeFile(path.join(cloneDir, ...T533_CONTRACT_REL.split('/')), '{ this is not valid json');
    const result = runOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 1, `Test 42 FAIL (case 6b, malformed clone ledger): must REFUSE, got exit ${result.status}:\n${result.stdout}`);
    assert.strictEqual(result.stdout, '', `Test 42 FAIL (case 6b): a refusing run must print nothing on stdout:\n${result.stdout}`);
    const refusal = successionRefusalOf(result.stderr);
    assert.ok(refusal, `Test 42 FAIL (case 6b): expected a succession-gate refusal line:\n${result.stderr}`);
    assert.ok(
      /mirror/.test(refusal) && refusal.includes(T533_CONTRACT_REL),
      `Test 42 FAIL (case 6b): refusal must name the mirror as the thing to investigate, and the ledger path. Got:\n${refusal}`
    );
  }

  console.log(
    'Test 42 passed: T-541 round 2 SUCCESSION GATE — the reviewer\'s reproduction (record changed, seeded_on ' +
    'unchanged) is refused naming the falsified date; advancing seeded_on is independently refused by REACHABLE ' +
    '(re-seeded count below the previously published floor) and by REAL (re-seeded count drifted from the live ' +
    'tree); an untouched record with a grown tree is byte-identical to no clone ledger at all (dormant); an ' +
    "honest re-seed passes printing a dated re-seed line plus a weakening line for the floor that moved down; a " +
    'floor-only lowering with the record untouched passes with only the weakening line (how_to_relax preserved); ' +
    'a clone with no ledger skips silently; a clone with an unparseable ledger refuses naming the mirror'
  );
}

// ---------------------------------------------------------------------------
// T-541 round 3 — shared fixture helpers for Tests 43-47 below. Every
// fixture uses a single non-location-semantic directory ("d") so the
// unrelated per-run composition tiers (deletion ratio, move credit,
// full-wipe) never interfere with what is under test: the succession gate's
// decision function over {clone anchor state} x {assembled derivation
// state}.
// ---------------------------------------------------------------------------
const t541LedgerPath = (treeDir) => path.join(treeDir, ...T533_CONTRACT_REL.split('/'));
const t541WriteDirFilesShared = (treeDir, dir, count) => {
  for (let i = 0; i < count; i++) {
    const rel = dir ? `${dir}/f${i}.md` : `f${i}.md`;
    writeFile(path.join(treeDir, ...rel.split('/')), contentOfT533(rel));
  }
};
const t541WriteFull = (treeDir, { seededOn, observed, floors }) => {
  writeFile(
    t541LedgerPath(treeDir),
    `${JSON.stringify(
      { derivation: { seeded_on: seededOn, observed_direct_file_counts_at_seeding: observed }, min_direct_files: floors },
      null, 2
    )}\n`
  );
};
const t541WriteFloorsOnly = (treeDir, floors) => {
  writeFile(t541LedgerPath(treeDir), `${JSON.stringify({ min_direct_files: floors }, null, 2)}\n`);
};
const t541WritePartialDerivation = (treeDir, floors) => {
  // derivation present but seeded_on absent — the exact round-2 reproduction
  // shape (forge observed+floor together, then delete seeded_on).
  writeFile(
    t541LedgerPath(treeDir),
    `${JSON.stringify(
      { derivation: { observed_direct_file_counts_at_seeding: { d: 5 } }, min_direct_files: floors },
      null, 2
    )}\n`
  );
};
const t541WriteUnparseable = (treeDir) => {
  writeFile(t541LedgerPath(treeDir), '{ this is not valid json');
};
const t541RunOverlay = (assembledDir, cloneDir) => require('node:child_process').spawnSync(
  process.execPath, [OVERLAY_SCRIPT, assembledDir, cloneDir], { encoding: 'utf8' }
);
const t541SuccessionRefusalOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('ERROR: refusing to overlay — the publish shape contract succession gate'));
const t541StandDownLineOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('WARNING: publish shape contract succession ('));
const t541IntroducedLineOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('Publish shape contract succession (') && /first full introduction/.test(l));
const t541ReseedLineOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('Publish shape contract succession (') && /seeding record re-seeded on/.test(l));
const t541DatedNoteOf = (stderr) =>
  stderr.split('\n').find((l) => l.startsWith('NOTE: the previously published derivation.seeded_on'));

// ---------------------------------------------------------------------------
// Test 43 (T-541 round 3, criteria 1+2): FAIL CLOSED, and the full
// clone-state x assembled-state TRUTH TABLE.
//
// Every fixture: a shared "d" directory holding 6 files in both clone and
// assembled trees (a pure no-op relative to each other — no deletions, no
// moves, so no unrelated composition tier can fire), plus a reference floor
// of 2 (well under 6) so the ORDINARY shape-contract floor check never fires
// either — isolating every assertion below to the succession gate alone.
// ---------------------------------------------------------------------------
{
  const T543_FLOOR = 2;
  const T543_OBSERVED = 6;
  const T543_DATE = '2026-01-01';

  const t543WriteCloneState = {
    'no-file': () => {},
    unparseable: (dir) => t541WriteUnparseable(dir),
    'partial-anchor': (dir) => t541WriteFloorsOnly(dir, { d: T543_FLOOR }),
    'full-anchor': (dir) => t541WriteFull(dir, { seededOn: T543_DATE, observed: { d: T543_OBSERVED }, floors: { d: T543_FLOOR } }),
  };
  const t543WriteAssembledState = {
    'no-ledger': () => {},
    'floors-only': (dir) => t541WriteFloorsOnly(dir, { d: T543_FLOOR }),
    'partial-derivation': (dir) => t541WritePartialDerivation(dir, { d: T543_FLOOR }),
    'full-derivation': (dir) => t541WriteFull(dir, { seededOn: T543_DATE, observed: { d: T543_OBSERVED }, floors: { d: T543_FLOOR } }),
  };

  // [cloneState, assembledState, expectedVerdict]
  const T543_TRUTH_TABLE = [
    ['no-file', 'no-ledger', 'dormant'],
    ['no-file', 'floors-only', 'dormant'],
    ['no-file', 'partial-derivation', 'dormant'],
    // T-541 round 4: genesis (no clone file) + a FULL assembled derivation is
    // no longer dormant — it is a RECORD-INTRODUCTION event, format- and
    // COHERENT-checked, printing a loud INTRODUCED line (finding 2's fix:
    // genesis's silence was what made stand-down -> genesis -> re-introduce
    // invisible). T-541 round 4 CORRECTED: introduction does NOT apply REAL,
    // so this cell would pass regardless of whether the ledger's recorded
    // observed=6 matched the live tree; it happens to match here purely for
    // fixture readability.
    ['no-file', 'full-derivation', 'introduced'],
    ['unparseable', 'no-ledger', 'refuse-mirror'],
    ['unparseable', 'floors-only', 'refuse-mirror'],
    ['unparseable', 'partial-derivation', 'refuse-mirror'],
    ['unparseable', 'full-derivation', 'refuse-mirror'],
    ['partial-anchor', 'no-ledger', 'dormant'],
    ['partial-anchor', 'floors-only', 'dormant'],
    ['partial-anchor', 'partial-derivation', 'dormant'],
    ['partial-anchor', 'full-derivation', 'introduced'],
    ['full-anchor', 'no-ledger', 'standDown'],
    ['full-anchor', 'floors-only', 'refuse-fail-closed'],
    ['full-anchor', 'partial-derivation', 'refuse-fail-closed'],
    ['full-anchor', 'full-derivation', 'dormant'],
  ];

  for (const [cloneState, assembledState, expected] of T543_TRUTH_TABLE) {
    const assembledDir = mkTempDir('mavp-overlay-t543-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t543-clone-');
    for (const dir of [assembledDir, cloneDir]) {
      writeFile(path.join(dir, 'keep.md'), contentOfT533('keep.md'));
      t541WriteDirFilesShared(dir, 'd', T543_OBSERVED);
      // The ledger itself lives at scripts/publish-shape-contract.json — a
      // stable companion set under scripts/ (present identically in BOTH
      // trees) keeps that directory well above MIN_DIR_SIZE and the ledger
      // file's own presence/absence a ~5% change at most, so no unrelated
      // per-run composition tier (full-wipe, per-directory ratio) can ever
      // fire purely because one fixture state writes the ledger and another
      // doesn't.
      t541WriteDirFilesShared(dir, 'scripts', 20);
    }
    t533WriteGitDir(cloneDir);
    t543WriteCloneState[cloneState](cloneDir);
    t543WriteAssembledState[assembledState](assembledDir);

    const result = t541RunOverlay(assembledDir, cloneDir);
    const label = `clone=${cloneState} x assembled=${assembledState}`;

    if (expected === 'dormant') {
      assert.strictEqual(result.status, 0, `Test 43 FAIL (${label}): expected dormant (exit 0), got exit ${result.status}:\n${result.stdout}\n${result.stderr}`);
      assert.strictEqual(result.stderr, '', `Test 43 FAIL (${label}): dormant cell must print no succession output at all:\n${result.stderr}`);
    } else if (expected === 'refuse-mirror') {
      assert.strictEqual(result.status, 1, `Test 43 FAIL (${label}): expected a mirror refusal (exit 1), got exit ${result.status}:\n${result.stdout}`);
      assert.strictEqual(result.stdout, '', `Test 43 FAIL (${label}): a refusing run must print nothing on stdout:\n${result.stdout}`);
      const refusal = t541SuccessionRefusalOf(result.stderr);
      assert.ok(refusal && /mirror/.test(refusal), `Test 43 FAIL (${label}): expected a refusal naming the mirror:\n${result.stderr}`);
    } else if (expected === 'introduced') {
      assert.strictEqual(result.status, 0, `Test 43 FAIL (${label}): expected pass with an INTRODUCED line, got exit ${result.status}:\n${result.stderr}`);
      assert.ok(t541IntroducedLineOf(result.stderr), `Test 43 FAIL (${label}): expected a loud, non-refusing record-introduced line:\n${result.stderr}`);
    } else if (expected === 'standDown') {
      assert.strictEqual(result.status, 0, `Test 43 FAIL (${label}): expected pass with a STAND-DOWN line, got exit ${result.status}:\n${result.stderr}`);
      assert.ok(t541StandDownLineOf(result.stderr), `Test 43 FAIL (${label}): expected a loud, non-refusing stand-down line:\n${result.stderr}`);
    } else if (expected === 'refuse-fail-closed') {
      assert.strictEqual(result.status, 1, `Test 43 FAIL (${label}): expected a FAIL CLOSED refusal (exit 1), got exit ${result.status}:\n${result.stdout}`);
      assert.strictEqual(result.stdout, '', `Test 43 FAIL (${label}): a refusing run must print nothing on stdout:\n${result.stdout}`);
      const refusal = t541SuccessionRefusalOf(result.stderr);
      assert.ok(
        refusal && /absent or incomplete/.test(refusal) && /three green paths|byte-identical|dated re-seed|delete the ledger/.test(refusal),
        `Test 43 FAIL (${label}): expected a FAIL CLOSED refusal naming the three green paths:\n${result.stderr}`
      );
    } else {
      throw new Error(`Test 43 internal error: unknown expected verdict "${expected}"`);
    }
  }

  // MUTANT DEMONSTRATION (criterion 1) — the round-2 short-circuit
  // (`if (current === null) return null;` reached unconditionally once a
  // full clone anchor is confirmed) is exercised directly here via a
  // reproduction of the reviewer's exact scenario: a coherent forgery
  // (observed+floor edited together) PLUS a deleted seeded_on. This is the
  // ['full-anchor', 'partial-derivation', 'refuse-fail-closed'] cell above,
  // already asserted — this block re-runs it standalone with a comment
  // trail for the evidence report (see the developer report for the actual
  // mutant-reverted-and-reran demonstration, since reintroducing the
  // short-circuit requires editing the source file, not something a
  // permanent test in this file can safely do to itself).
  {
    const assembledDir = mkTempDir('mavp-overlay-t543-reviewer-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t543-reviewer-clone-');
    for (const dir of [assembledDir, cloneDir]) {
      writeFile(path.join(dir, 'keep.md'), contentOfT533('keep.md'));
      t541WriteDirFilesShared(dir, 'd', 3);
    }
    t533WriteGitDir(cloneDir);
    t541WriteFull(cloneDir, { seededOn: '2026-01-01', observed: { d: 9 }, floors: { d: 5 } });
    // The forgery: observed 9->3, floor 5->2 (coherent, passes the ordinary
    // floor check at 3>=2) PLUS seeded_on deleted entirely (partial
    // derivation).
    t541WritePartialDerivation(assembledDir, { d: 2 });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 43 FAIL (reviewer's round-3 reproduction): must REFUSE before any write even though the ordinary floor check (3 >= 2) passes, got exit ${result.status}, stdout:\n${result.stdout}`
    );
    assert.strictEqual(result.stdout, '', `Test 43 FAIL (reviewer's reproduction): a refusing run must print nothing on stdout:\n${result.stdout}`);
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, 'd', 'f0.md'), 'utf8'), contentOfT533('d/f0.md'),
      'Test 43 FAIL (reviewer\'s reproduction): the clone must be completely untouched after the refusal'
    );
  }

  console.log(
    'Test 43 passed: T-541 round 3/4 FAIL CLOSED + TRUTH TABLE — all 16 cells of {no clone file, unparseable clone, ' +
    'partial anchor, full anchor} x {no assembled ledger, floors-only, partial derivation, full derivation} verified ' +
    '(unparseable clone refuses in every column; full anchor x absent-or-partial derivation refuses; full anchor x ' +
    'no assembled ledger prints a non-refusing stand-down line; both partial-anchor and no-clone-file x ' +
    'full-derivation now print a non-refusing INTRODUCED line, format- and COHERENT-checked (T-541 round 4, ' +
    'CORRECTED — no REAL check against the live tree), ' +
    'genesis is no longer unconditionally silent; every remaining no-clone-file and partial-anchor cell stays ' +
    "dormant); the round-2 reviewer's reproduction (coherent forgery plus a deleted seeded_on) is refused before " +
    'any write with the clone left completely untouched'
  );
}

// ---------------------------------------------------------------------------
// Test 44 (T-541 round 3, criterion 3): the DELTA SET. Rules 2 (REAL) and 3
// (REACHABLE) must scope to the directories whose recorded observed count
// actually CHANGED, never every recorded key — reproduced against a
// live-repo-shaped fixture: re-seeding "docs/assets" alone while "scripts"
// sits stale at a recorded count below its live count (ordinary growth,
// exactly T-540's review measurement of 108 recorded against a live tree
// that had grown to 109 and beyond).
// ---------------------------------------------------------------------------
{
  const buildT544Fixture = () => {
    const assembledDir = mkTempDir('mavp-overlay-t544-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t544-clone-');
    // "scripts": clone and assembled both hold 108 files directly — a pure
    // ADDITION of 6 more (114 total) on the assembled side, never a
    // deletion, so no per-run composition tier can fire on it.
    for (const dir of [assembledDir, cloneDir]) t541WriteDirFilesShared(dir, 'scripts', 108);
    t541WriteDirFilesShared(assembledDir, 'scripts', 114); // overwrites 0..107, adds 108..113
    // "docs/assets": clone holds 9, assembled holds 12 — again a pure
    // ADDITION, re-seeded to match the live count exactly.
    t541WriteDirFilesShared(cloneDir, 'docs/assets', 9);
    t541WriteDirFilesShared(assembledDir, 'docs/assets', 12);
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // CASE 1 — the live-repo-shaped partial re-seed PASSES. "docs/assets" is
  // re-seeded (9 -> 12, matching the live count, >= the old floor of 5).
  // "scripts" is left UNTOUCHED in the ledger (stays recorded at 108) even
  // though the live tree has grown to 114 — this must never be examined by
  // Rule 2/3 because it never entered the delta.
  {
    const { assembledDir, cloneDir } = buildT544Fixture();
    t541WriteFull(cloneDir, {
      seededOn: '2026-01-01',
      observed: { scripts: 108, 'docs/assets': 9 },
      floors: { scripts: 64, 'docs/assets': 5 },
    });
    t541WriteFull(assembledDir, {
      seededOn: '2026-02-01',
      observed: { scripts: 108, 'docs/assets': 12 }, // scripts UNCHANGED (stale); docs/assets re-seeded
      floors: { scripts: 64, 'docs/assets': 5 },
    });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 0,
      `Test 44 FAIL (case 1, live-repo partial re-seed): must PASS — scripts' stale recorded count must never be examined, got exit ${result.status}:\n${result.stderr}`
    );
    const reseedLine = t541ReseedLineOf(result.stderr);
    assert.ok(reseedLine, `Test 44 FAIL (case 1): expected a dated re-seed line on stderr:\n${result.stderr}`);
    assert.ok(
      reseedLine.includes('2026-02-01') && reseedLine.includes('2026-01-01'),
      `Test 44 FAIL (case 1): expected the re-seed line to name both dates. Got:\n${reseedLine}`
    );
    // "scripts" must never appear as a BLAMED directory (quoted, as every
    // per-directory refusal/finding line names it) — the ledger path itself
    // legitimately contains the substring "scripts/", so that alone is not
    // evidence of anything.
    assert.strictEqual(
      result.stderr.split('\n').filter((l) => /"scripts"/.test(l)).length, 0,
      `Test 44 FAIL (case 1): "scripts" must never appear as a quoted (blamed) directory in stderr — it never entered the delta:\n${result.stderr}`
    );
  }

  // MUTANT DEMONSTRATION (criterion 3) — reverting Rules 2/3 to iterate
  // EVERY recorded key (not just the delta) reproduces the exact blame-the-
  // untouched-directory failure this criterion closes. Demonstrated here by
  // calling checkShapeContractSuccession() in-process with a hand-rolled
  // ALL-KEYS variant built from the same exported helpers, so the mutant's
  // behavior is pinned without requiring a source edit inside this test
  // file (see the developer report for the actual source-level
  // revert-and-rerun demonstration).
  {
    const {
      loadClonePublishedLedger: t544LoadClone,
      loadAssembledSeedingRecord: t544LoadCurrent,
      buildDirectCountMap: t544BuildDirectCountMap,
    } = require('./mavp-publish-overlay.js');

    const { assembledDir, cloneDir } = buildT544Fixture();
    t541WriteFull(cloneDir, {
      seededOn: '2026-01-01',
      observed: { scripts: 108, 'docs/assets': 9 },
      floors: { scripts: 64, 'docs/assets': 5 },
    });
    t541WriteFull(assembledDir, {
      seededOn: '2026-02-01',
      observed: { scripts: 108, 'docs/assets': 12 },
      floors: { scripts: 64, 'docs/assets': 5 },
    });

    const published = t544LoadClone(cloneDir);
    const current = t544LoadCurrent(assembledDir);
    assert.strictEqual(published.state, 'full', 'Test 44 mutant setup FAIL: expected a full clone anchor');
    assert.ok(current, 'Test 44 mutant setup FAIL: expected a full assembled derivation');

    const assembledFilesForMutant = t533ListFiles(assembledDir);
    const directCounts = t544BuildDirectCountMap(assembledFilesForMutant);

    // The ALL-KEYS mutant: Rule 2 (REAL) iterating every recorded key
    // instead of just the delta.
    let mutantRefusal = null;
    for (const [dir, observed] of Object.entries(current.observed)) {
      const live = directCounts.get(dir) || 0;
      if (observed !== live) {
        mutantRefusal = `the re-seeded observed count for "${dir}" (${observed}) does not match the assembled tree's actual direct file count at this publish (${live})`;
        break;
      }
    }
    assert.ok(
      mutantRefusal && /"scripts"/.test(mutantRefusal),
      `Test 44 FAIL: the all-keys mutant must reproduce a refusal blaming "scripts" (recorded 108 vs live 114) — mutant did not survive as expected. Got: ${mutantRefusal}`
    );
  }

  console.log(
    'Test 44 passed: T-541 round 3 DELTA SET — a live-repo-shaped partial re-seed (re-seeding "docs/assets" alone, ' +
    '9 -> 12, while "scripts" stays recorded at a stale 108 against a live 114) PASSES and prints a re-seed line ' +
    'that blames nobody, with "scripts" never once appearing in stderr; the all-keys mutant (Rule 2 iterating ' +
    'every recorded key) is demonstrated to reproduce the exact blame-the-untouched-directory refusal this ' +
    'criterion closes'
  );
}

// ---------------------------------------------------------------------------
// Test 45 (T-541 round 3, criterion 5): recordChanged now ADDITIONALLY
// covers a bare `derivation.seeded_on` rewrite — a forward bump with an
// otherwise byte-identical record is a valid loud re-seed with an EMPTY
// delta; a backdate refuses via DATED.
// ---------------------------------------------------------------------------
{
  const buildT545Baseline = () => {
    const assembledDir = mkTempDir('mavp-overlay-t545-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t545-clone-');
    for (const dir of [assembledDir, cloneDir]) {
      writeFile(path.join(dir, 'keep.md'), contentOfT533('keep.md'));
      t541WriteDirFilesShared(dir, 'd', 5);
    }
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // CASE A — a BARE FORWARD BUMP: seeded_on advances, observed is
  // byte-identical on both sides (empty delta). Must PASS printing a re-seed
  // line — round 2's recordChanged ignored seeded_on entirely, so this used
  // to be silently dormant.
  {
    const { assembledDir, cloneDir } = buildT545Baseline();
    t541WriteFull(cloneDir, { seededOn: '2026-01-01', observed: { d: 5 }, floors: { d: 2 } });
    t541WriteFull(assembledDir, { seededOn: '2026-03-01', observed: { d: 5 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 45 FAIL (case A, bare forward bump): must PASS, got exit ${result.status}:\n${result.stderr}`);
    const reseedLine = t541ReseedLineOf(result.stderr);
    assert.ok(
      reseedLine && reseedLine.includes('2026-03-01') && reseedLine.includes('2026-01-01'),
      `Test 45 FAIL (case A): expected a dated re-seed line naming both dates (empty delta, no directory need be named):\n${result.stderr}`
    );
  }

  // CASE B — a BACKDATE with an otherwise untouched record: must REFUSE via
  // DATED (current.seededOn is not > published.seededOn).
  {
    const { assembledDir, cloneDir } = buildT545Baseline();
    t541WriteFull(cloneDir, { seededOn: '2026-03-01', observed: { d: 5 }, floors: { d: 2 } });
    t541WriteFull(assembledDir, { seededOn: '2026-01-01', observed: { d: 5 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 1, `Test 45 FAIL (case B, backdate): must REFUSE, got exit ${result.status}:\n${result.stdout}`);
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && /did not advance/.test(refusal) && refusal.includes('2026-03-01'),
      `Test 45 FAIL (case B): expected a DATED refusal naming the previously published date. Got:\n${result.stderr}`
    );
  }

  console.log(
    'Test 45 passed: T-541 round 3 recordChanged COVERS seeded_on — a bare forward bump with an empty observed ' +
    'delta passes as a valid loud re-seed naming both dates; a backdate with an otherwise untouched record refuses ' +
    'via DATED'
  );
}

// ---------------------------------------------------------------------------
// Test 46 (T-541 round 3 criterion 6, round 4 criterion 3): DATED format
// semantics. Canonical YYYY-MM-DD is validated on the about-to-be-published
// date whenever DATED is evaluated (case A, unchanged since round 3). Round
// 3 additionally let a malformed PUBLISHED (historical) date skip the
// strict-advance comparison, loudly, so a canonical successor was never
// wedged by a malformed lexicographic predecessor — round 4 DELETES that
// leniency entirely (case B, rewritten): a non-canonical PUBLISHED
// seeded_on now REFUSES outright, naming the self-serve two-publish repair
// (stand down, then re-introduce) that needs no mirror surgery.
// ---------------------------------------------------------------------------
{
  const buildT546Baseline = (assembledDCount) => {
    const assembledDir = mkTempDir('mavp-overlay-t546-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t546-clone-');
    writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
    writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
    t541WriteDirFilesShared(cloneDir, 'd', 5);
    t541WriteDirFilesShared(assembledDir, 'd', assembledDCount);
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // CASE A — current.seededOn is NOT canonical (malformed on the
  // attacker-editable side): must REFUSE naming the format problem, even
  // though the underlying re-seed data would otherwise be consistent.
  {
    const { assembledDir, cloneDir } = buildT546Baseline(6);
    t541WriteFull(cloneDir, { seededOn: '2026-01-01', observed: { d: 5 }, floors: { d: 2 } });
    t541WriteFull(assembledDir, { seededOn: '2026-7-4', observed: { d: 6 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 1, `Test 46 FAIL (case A, malformed current date): must REFUSE, got exit ${result.status}:\n${result.stdout}`);
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && /canonical YYYY-MM-DD format/.test(refusal) && refusal.includes('2026-7-4'),
      `Test 46 FAIL (case A): expected a refusal naming the malformed current date and the canonical format. Got:\n${result.stderr}`
    );
  }

  // CASE B (T-541 ROUND 4 — REWRITTEN): the PUBLISHED (clone-anchored,
  // historical) date is malformed (pre-round-4 history). Round 3 skipped the
  // strict-advance comparison here, loudly, and let the re-seed pass. Round 4
  // DELETES that leniency: a non-canonical PUBLISHED seeded_on now REFUSES
  // outright, naming the self-serve two-publish repair, and the deleted NOTE
  // never prints again.
  {
    const { assembledDir, cloneDir } = buildT546Baseline(6);
    t541WriteFull(cloneDir, { seededOn: '2026-7-4', observed: { d: 5 }, floors: { d: 2 } });
    t541WriteFull(assembledDir, { seededOn: '2026-07-27', observed: { d: 6 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 46 FAIL (case B, round 4 — non-canonical published date now refuses): must REFUSE, got exit ${result.status}:\n${result.stderr}`
    );
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && /canonical YYYY-MM-DD format/.test(refusal) && refusal.includes('2026-7-4') && /stand down/.test(refusal),
      `Test 46 FAIL (case B): expected a refusal naming the malformed published date, the canonical format, and the stand-down repair. Got:\n${result.stderr}`
    );
    assert.strictEqual(
      t541DatedNoteOf(result.stderr), undefined,
      'Test 46 FAIL (case B): the round-3 legacy-leniency NOTE is DELETED in round 4 — it must never print again'
    );
  }

  console.log(
    'Test 46 passed: T-541 round 3+4 DATED FORMAT SEMANTICS — a malformed about-to-be-published seeded_on refuses ' +
    'naming the canonical YYYY-MM-DD format (case A, unchanged since round 3); round 4 DELETES the round-3 ' +
    'legacy-leniency branch entirely — a malformed PUBLISHED (historical) date now REFUSES outright (case B), ' +
    'naming the self-serve two-publish repair (stand down, then re-introduce), and the deleted NOTE never prints'
  );
}

// ---------------------------------------------------------------------------
// Test 47 (T-541 round 3, criterion 4): NO REOPENING. Leaving a recorded
// observed count stale (never re-seeded, so it never enters the delta) does
// NOT create any additional pass path — an actual drain of the LIVE tree is
// still bounded by the ordinary end-state floor check
// (findShapeContractViolations), which reads live counts, never the
// (possibly stale) recorded ones.
// ---------------------------------------------------------------------------
{
  const buildT547Fixture = (assembledDCount) => {
    const assembledDir = mkTempDir('mavp-overlay-t547-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t547-clone-');
    writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
    writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
    t541WriteDirFilesShared(cloneDir, 'd', 6);
    t541WriteDirFilesShared(assembledDir, 'd', assembledDCount);
    t533WriteGitDir(cloneDir);
    // Both ledgers carry a FULL, IDENTICAL derivation — the "d" observed
    // count (6) is stale and untouched on both sides, so recordChanged is
    // false and the succession gate is fully dormant; only the ordinary
    // shape-contract floor check (against the LIVE tree) can decide this.
    const identical = { seededOn: '2026-01-01', observed: { d: 6 }, floors: { d: 5 } };
    t541WriteFull(cloneDir, identical);
    t541WriteFull(assembledDir, identical);
    return { assembledDir, cloneDir };
  };

  // Drain to EXACTLY the floor (6 -> 5): a floor is a minimum, must PASS,
  // and the succession gate must stay fully silent (record untouched).
  {
    const { assembledDir, cloneDir } = buildT547Fixture(5);
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 47 FAIL (drain to floor): must PASS, got exit ${result.status}:\n${result.stderr}`);
    assert.strictEqual(result.stderr, '', `Test 47 FAIL (drain to floor): the succession gate must be fully silent (record untouched on both sides):\n${result.stderr}`);
  }

  // Drain ONE FILE PAST the floor (6 -> 4): must REFUSE via the ORDINARY
  // shape-contract end-state check — never the succession gate, which never
  // even examines "d" (its recorded count never changed).
  {
    const { assembledDir, cloneDir } = buildT547Fixture(4);
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 1, `Test 47 FAIL (drain past floor): must REFUSE, got exit ${result.status}:\n${result.stdout}`);
    assert.ok(
      result.stderr.split('\n').includes('  - d: 4 file(s) directly, below the committed floor of 5'),
      `Test 47 FAIL (drain past floor): expected the ORDINARY shape-contract finding line naming the live count against the floor. Got:\n${result.stderr}`
    );
    assert.strictEqual(
      t541SuccessionRefusalOf(result.stderr), undefined,
      `Test 47 FAIL (drain past floor): this must be the ORDINARY floor refusal, not a succession-gate refusal (the recorded count never changed, so it never entered the delta):\n${result.stderr}`
    );
  }

  console.log(
    'Test 47 passed: T-541 round 3 NO REOPENING — leaving a recorded observed count stale (never re-seeded, never ' +
    'entering the delta) creates no additional pass path: draining the LIVE tree to exactly its floor still passes ' +
    '(minimum, not a trip-line) with the succession gate fully silent, and draining one file further still refuses ' +
    'via the ORDINARY end-state floor check — the recorded count was never the defence line, the floor always was'
  );
}

// ---------------------------------------------------------------------------
// Test 48 (T-541 round 4, criterion 6): the OBSERVED-DELTA PARTITION,
// GENERATED from its own membership-vector definition rather than a
// hand-picked case list. K = keys(published.observed) ∪ keys(current.observed)
// has exactly four REALIZABLE cells over (inPub, inCur) plus the
// equal/not-equal refinement of the (1,1) cell — (0,0) is impossible since
// every k is drawn from the union by construction. Round 3 failed precisely
// because "changed/added" was enumerated by intuition and felt exhaustive;
// this test instead builds ONE key per cell PROGRAMMATICALLY from the
// membership-vector table below, so a fifth part cannot exist ungenerated.
// ---------------------------------------------------------------------------
{
  const { computeObservedDelta: t548ComputeObservedDelta } = require('./mavp-publish-overlay.js');

  // The membership-vector definition — the SOURCE the fixture is generated
  // from, not a parallel hand-list of cases. `bucket: null` marks the fourth
  // disposition (UNCHANGED), which deliberately has NO array of its own.
  const T548_CELLS = [
    { label: '(1,1,=) UNCHANGED', inPub: true, inCur: true, changeValue: false, bucket: null },
    { label: '(1,1,≠) CHANGED', inPub: true, inCur: true, changeValue: true, bucket: 'changed' },
    { label: '(1,0) REMOVED', inPub: true, inCur: false, bucket: 'removed' },
    { label: '(0,1) ADDED', inPub: false, inCur: true, bucket: 'added' },
  ];

  // Build ONE published/current observed-map pair mechanically from the
  // cell table above: one dedicated key per cell, with presence and value
  // driven entirely by the cell's own (inPub, inCur, changeValue) shape —
  // never a hand-picked key/value chosen to make a specific case work.
  const published = {};
  const current = {};
  const keysByBucket = { changed: [], added: [], removed: [], unchanged: [] };
  T548_CELLS.forEach((cell, i) => {
    const key = `dir-cell-${i}`;
    const bucketName = cell.bucket || 'unchanged';
    keysByBucket[bucketName].push(key);
    if (cell.inPub) published[key] = 10;
    if (cell.inCur) current[key] = cell.changeValue ? 11 : 10;
  });

  const delta = t548ComputeObservedDelta(published, current);

  assert.deepStrictEqual(
    delta.changed, keysByBucket.changed,
    `Test 48 FAIL: CHANGED bucket mismatch. Got: ${JSON.stringify(delta.changed)}, expected: ${JSON.stringify(keysByBucket.changed)}`
  );
  assert.deepStrictEqual(
    delta.added, keysByBucket.added,
    `Test 48 FAIL: ADDED bucket mismatch. Got: ${JSON.stringify(delta.added)}, expected: ${JSON.stringify(keysByBucket.added)}`
  );
  assert.deepStrictEqual(
    delta.removed, keysByBucket.removed,
    `Test 48 FAIL: REMOVED bucket mismatch. Got: ${JSON.stringify(delta.removed)}, expected: ${JSON.stringify(keysByBucket.removed)}`
  );
  // The fourth disposition (UNCHANGED) has no bucket array at all by design
  // — its key must appear in NONE of the three, which is exactly what a
  // (0,0)-impossible, four-cell-total partition predicts.
  for (const key of keysByBucket.unchanged) {
    assert.ok(
      !delta.changed.includes(key) && !delta.added.includes(key) && !delta.removed.includes(key),
      `Test 48 FAIL: unchanged key "${key}" must appear in no bucket at all`
    );
  }

  // TOTALITY + DISJOINTNESS — every key in K = keys(published) ∪ keys(current)
  // is claimed by AT MOST ONE of the three named buckets (the remaining case
  // being UNCHANGED, i.e. no bucket at all) — mechanically checked against
  // the union rather than assumed, so a mutant that double-classifies a key
  // would be caught here even though it might still pass the per-bucket
  // deep-equal checks above by coincidence.
  const allKeys = new Set([...Object.keys(published), ...Object.keys(current)]);
  assert.strictEqual(
    allKeys.size, T548_CELLS.length,
    'Test 48 FAIL: fixture setup did not generate exactly one distinct key per cell'
  );
  for (const key of allKeys) {
    const memberships = [delta.changed.includes(key), delta.added.includes(key), delta.removed.includes(key)];
    const bucketCount = memberships.filter(Boolean).length;
    assert.ok(bucketCount <= 1, `Test 48 FAIL: key "${key}" claimed by more than one bucket — the partition is not disjoint`);
  }

  console.log(
    'Test 48 passed: T-541 round 4 criterion 6 — the observed-delta partition is GENERATED from its own ' +
    'membership-vector table (K = keys(published) ∪ keys(current), (0,0) impossible by construction), covering ' +
    'all four realizable cells {(1,1,=) UNCHANGED, (1,1,≠) CHANGED, (1,0) REMOVED, (0,1) ADDED} mechanically ' +
    'rather than as a hand-picked case list, with every key in the union claimed by at most one bucket'
  );
}

// ---------------------------------------------------------------------------
// Test 49 (T-541 round 4, criterion 1): COHERENT. Round 3's totality claim
// was refuted by finding 1 — deleting the OBSERVED key while keeping the
// (even lowered) floor lands the deletion in `delta.removed`, examined by
// neither REAL nor REACHABLE, so the certificate could print "verified"
// about a directory neither rule touched. COHERENT closes this structurally:
// every floor key must have a matching observed key whenever the assembled
// derivation is full, regardless of the clone's own anchor state.
// ---------------------------------------------------------------------------
{
  const { findIncoherentFloorKeys: t549FindIncoherentFloorKeys } = require('./mavp-publish-overlay.js');

  // CASE A — finding 1's exact replay: the clone's previously published
  // anchor holds docs/assets at observed=9/floor=5. The forgery lowers the
  // floor to 2 AND deletes the observed key entirely (rather than editing
  // it, round 1's shape) while the live tree drains to 4 — three files
  // below the historically published floor of 5, but the ORDINARY floor
  // check (4 >= 2) passes cleanly. Must REFUSE before any write.
  {
    const assembledDir = mkTempDir('mavp-overlay-t549-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t549-clone-');
    writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
    writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
    t541WriteDirFilesShared(cloneDir, 'docs/assets', 9);
    t541WriteDirFilesShared(assembledDir, 'docs/assets', 4);
    t533WriteGitDir(cloneDir);
    t541WriteFull(cloneDir, { seededOn: '2026-01-01', observed: { 'docs/assets': 9 }, floors: { 'docs/assets': 5 } });
    // The observed key is DELETED entirely (empty observed map); the floor
    // is lowered but kept declared.
    t541WriteFull(assembledDir, { seededOn: '2026-02-01', observed: {}, floors: { 'docs/assets': 2 } });

    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 49 FAIL (case A, finding-1 replay): must REFUSE before any write even though the ordinary floor check (4 >= 2) passes, got exit ${result.status}, stdout:\n${result.stdout}`
    );
    assert.strictEqual(result.stdout, '', `Test 49 FAIL (case A): a refusing run must print nothing on stdout:\n${result.stdout}`);
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && /COHERENT/.test(refusal) && /docs\/assets/.test(refusal),
      `Test 49 FAIL (case A): expected a COHERENT refusal naming "docs/assets". Got:\n${result.stderr}`
    );
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, 'docs', 'assets', 'f0.md'), 'utf8'), contentOfT533('docs/assets/f0.md'),
      'Test 49 FAIL (case A): the clone must be completely untouched after the refusal'
    );
  }

  // CASE B — WHOLE-DIRECTORY RETIREMENT: both the floor AND the observation
  // are removed TOGETHER. Must PASS loudly, printing BOTH the removed-key
  // WARNING line and the floor-removed WEAKENING line — COHERENT is
  // satisfied trivially because neither side declares the key at all.
  {
    const assembledDir = mkTempDir('mavp-overlay-t549b-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t549b-clone-');
    writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
    writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
    t541WriteDirFilesShared(cloneDir, 'stable', 3);
    t541WriteDirFilesShared(assembledDir, 'stable', 3);
    t533WriteGitDir(cloneDir);
    t541WriteFull(cloneDir, {
      seededOn: '2026-01-01',
      observed: { 'docs/assets': 9, stable: 3 },
      floors: { 'docs/assets': 5, stable: 1 },
    });
    // "docs/assets" retired WHOLLY — dropped from both observed AND floors.
    t541WriteFull(assembledDir, {
      seededOn: '2026-02-01',
      observed: { stable: 3 },
      floors: { stable: 1 },
    });

    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 0,
      `Test 49 FAIL (case B, whole-directory retirement): must PASS, got exit ${result.status}:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.split('\n').includes('  - docs/assets: seeding record entry removed (was observed=9)'),
      `Test 49 FAIL (case B): expected the loud removed-key WARNING line. Got:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.split('\n').includes('  - docs/assets: floor removed from the ledger (was 5)'),
      `Test 49 FAIL (case B): expected the loud floor-removed WEAKENING line. Got:\n${result.stderr}`
    );
  }

  // CASE C — the REAL committed ledger satisfies COHERENT today: every
  // declared floor key has a matching observed key (18 keys = 18 keys).
  {
    const incoherent = t549FindIncoherentFloorKeys(T533_REAL_FLOORS, T533_REAL_CONTRACT.derivation.observed_direct_file_counts_at_seeding);
    assert.deepStrictEqual(incoherent, [], `Test 49 FAIL (case C): the real committed ledger must be COHERENT (no floor without a matching observed key), got: ${JSON.stringify(incoherent)}`);
    assert.strictEqual(Object.keys(T533_REAL_FLOORS).length, 18, 'Test 49 FAIL (case C): expected 18 declared floor keys');
    assert.strictEqual(
      Object.keys(T533_REAL_CONTRACT.derivation.observed_direct_file_counts_at_seeding).length, 18,
      'Test 49 FAIL (case C): expected 18 declared observed keys'
    );
  }

  console.log(
    'Test 49 passed: T-541 round 4 criterion 1 — COHERENT closes finding 1 structurally: the exact replay (observed ' +
    'key deleted, floor kept lowered, live tree drained below the previously published floor) refuses before any ' +
    'write even though the ordinary floor check passes, naming the incoherent directory; whole-directory retirement ' +
    '(floor AND observation removed together) still passes loudly with both the removal and weakening lines; the ' +
    'real committed ledger satisfies COHERENT today (18 keys = 18 keys)'
  );
}

// ---------------------------------------------------------------------------
// Test 50 (T-541 round 4, criterion 2; round 4 CORRECTED, criterion 4):
// RECORD INTRODUCTION IS NOW VALIDATED, but NOT against the live tree.
// Finding 2's exact reproduction — a manufactured, non-canonical seeded_on
// sailing through introduction untouched — is refused on BOTH a genesis (no
// clone ledger at all) and a partial (legacy floors-only) clone anchor.
// CASE C is the round 4 CORRECTED fixture: an honest MIRROR-CATCH-UP
// introduction (partial clone anchor, assembled full record whose
// HISTORICAL observed count is strictly below the LIVE direct count — the
// exact 108-vs-114 shape that caught round 4's own shipped REAL loop
// refusing an honest publish on the real repo) must PASS, and round 4's
// shipped REAL loop is demonstrated as the mutant that refuses it. A
// genuinely honest post-stand-down genesis re-introduction still passes,
// loudly, once format and COHERENT check out (no REAL requirement).
// ---------------------------------------------------------------------------
{
  const buildT550Fixture = (dCount) => {
    const assembledDir = mkTempDir('mavp-overlay-t550-assembled-');
    const cloneDir = mkTempDir('mavp-overlay-t550-clone-');
    writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
    writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
    t541WriteDirFilesShared(assembledDir, 'd', dCount);
    t533WriteGitDir(cloneDir);
    return { assembledDir, cloneDir };
  };

  // CASE A — GENESIS (no clone ledger file at all) introducing a full
  // record with a manufactured, non-canonical seeded_on: finding 2's exact
  // reproduction. Must REFUSE — genesis is no longer unconditionally silent.
  {
    const { assembledDir, cloneDir } = buildT550Fixture(5);
    t541WriteFull(assembledDir, { seededOn: 'not-a-date', observed: { d: 5 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 50 FAIL (case A, genesis + manufactured date): must REFUSE, got exit ${result.status}:\n${result.stdout}`
    );
    assert.strictEqual(result.stdout, '', `Test 50 FAIL (case A): a refusing run must print nothing on stdout:\n${result.stdout}`);
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && refusal.includes('not-a-date') && /canonical YYYY-MM-DD format/.test(refusal),
      `Test 50 FAIL (case A): expected a refusal naming the manufactured date and the canonical format. Got:\n${result.stderr}`
    );
  }

  // CASE B — a PARTIAL clone anchor (legacy floors-only ledger) introducing
  // the SAME manufactured, non-canonical seeded_on: must ALSO refuse.
  {
    const { assembledDir, cloneDir } = buildT550Fixture(5);
    t541WriteFloorsOnly(cloneDir, { d: 2 });
    t541WriteFull(assembledDir, { seededOn: 'not-a-date', observed: { d: 5 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 1,
      `Test 50 FAIL (case B, partial anchor + manufactured date): must REFUSE, got exit ${result.status}:\n${result.stdout}`
    );
    const refusal = t541SuccessionRefusalOf(result.stderr);
    assert.ok(
      refusal && refusal.includes('not-a-date') && /canonical YYYY-MM-DD format/.test(refusal),
      `Test 50 FAIL (case B): expected a refusal naming the manufactured date and the canonical format. Got:\n${result.stderr}`
    );
  }

  // CASE C — HONEST MIRROR-CATCH-UP (T-541 round 4 CORRECTED): a PARTIAL
  // clone anchor (legacy floors-only ledger) introducing a full record whose
  // HISTORICAL observed count (108) is strictly below the LIVE direct file
  // count (114) — the exact shape reproduced end to end on the real repo at
  // exit 1 by round 4's own shipped REAL loop. Must PASS: introduction no
  // longer applies REAL, so a mirror honestly catching up to a canonical
  // side that kept growing since the record was seeded is never refused.
  {
    const { assembledDir, cloneDir } = buildT550Fixture(114); // live tree holds 114 "d" files
    t541WriteFloorsOnly(cloneDir, { d: 2 }); // partial (legacy) clone anchor
    t541WriteFull(assembledDir, { seededOn: '2026-01-01', observed: { d: 108 }, floors: { d: 2 } }); // historical 108, live 114
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(
      result.status, 0,
      `Test 50 FAIL (case C, honest mirror-catch-up): must PASS — introduction no longer applies REAL, got exit ${result.status}:\n${result.stderr}`
    );
    const introLine = t541IntroducedLineOf(result.stderr);
    assert.ok(introLine, `Test 50 FAIL (case C): expected a loud INTRODUCED line, got:\n${result.stderr}`);
    assert.ok(
      /trust-on-first-use/.test(introLine) && !/REAL/.test(introLine),
      `Test 50 FAIL (case C): expected the INTRODUCED line to name trust-on-first-use and make no REAL claim. Got:\n${introLine}`
    );
    // T-549 — the HONEST CATCH-UP fixture named in the task's own AC: an
    // introduction whose historical claimed count (108) sits below the live
    // tree's actual count (114, the real repo's own shape) must PASS (already
    // asserted above) AND the same INTRODUCED line must now additionally name
    // both numbers, informationally, without refusing.
    assert.ok(
      introLine.includes('claimed=108') && introLine.includes('live=114'),
      `Test 50 FAIL (case C, T-549): expected the INTRODUCED line to print the claimed-vs-live pair (claimed=108, ` +
      `live=114) for the honest catch-up, informationally and without refusing. Got:\n${introLine}`
    );

    // MUTANT DEMONSTRATION (criterion 4) — round 4's shipped REAL loop (over
    // EVERY observed key at introduction, since there is no delta yet to
    // scope to) is reconstructed here via the exported helpers and shown to
    // refuse this exact honest fixture (see the developer report for the
    // actual source-level mutant-applied-and-reverted demonstration).
    const {
      loadAssembledSeedingRecord: t550LoadCurrent,
      buildDirectCountMap: t550BuildDirectCountMap,
    } = require('./mavp-publish-overlay.js');
    const current = t550LoadCurrent(assembledDir);
    assert.ok(current, 'Test 50 mutant setup FAIL: expected a full assembled derivation');
    const assembledFilesForMutant = t533ListFiles(assembledDir);
    const introDirectCounts = t550BuildDirectCountMap(assembledFilesForMutant);
    let mutantRefusal = null;
    for (const [dir, observed] of Object.entries(current.observed).sort((a, b) => a[0].localeCompare(b[0]))) {
      const live = introDirectCounts.get(dir) || 0;
      if (observed !== live) {
        mutantRefusal = `the observed count for "${dir}" (${observed}) does not match the assembled tree's actual direct file count at this publish (${live})`;
        break;
      }
    }
    assert.ok(
      mutantRefusal && /"d"/.test(mutantRefusal) && mutantRefusal.includes('108') && mutantRefusal.includes('114'),
      `Test 50 FAIL: round 4's shipped REAL loop must reproduce a refusal on this honest mirror-catch-up fixture ` +
      `(recorded 108 vs live 114) — mutant did not survive as expected. Got: ${mutantRefusal}`
    );
  }

  // CASE D — an honest POST-STAND-DOWN GENESIS RE-INTRODUCTION: canonical
  // date, coherent floors, observed counts trusted as claimed (no REAL
  // requirement, T-541 round 4 CORRECTED). Must PASS with a loud,
  // non-refusing INTRODUCED line — genesis is no longer silent.
  {
    const { assembledDir, cloneDir } = buildT550Fixture(5);
    t541WriteFull(assembledDir, { seededOn: '2026-01-01', observed: { d: 5 }, floors: { d: 2 } });
    const result = t541RunOverlay(assembledDir, cloneDir);
    assert.strictEqual(result.status, 0, `Test 50 FAIL (case D, honest genesis re-introduction): must PASS, got exit ${result.status}:\n${result.stderr}`);
    const introLine = t541IntroducedLineOf(result.stderr);
    assert.ok(introLine, `Test 50 FAIL (case D): expected a loud INTRODUCED line, got:\n${result.stderr}`);
    assert.ok(
      /format- and COHERENT-checked/.test(introLine) && /trust-on-first-use/.test(introLine) && !/REAL/.test(introLine),
      `Test 50 FAIL (case D): expected the INTRODUCED line to name format- and COHERENT-checked plus ` +
      `trust-on-first-use, with no REAL claim. Got:\n${introLine}`
    );
  }

  console.log(
    "Test 50 passed: T-541 round 4 criterion 2, round 4 CORRECTED criterion 4 — RECORD INTRODUCTION is validated " +
    "on format and COHERENT: finding 2's manufactured, non-canonical seeded_on is refused on BOTH a genesis (no " +
    'clone file) and a partial (legacy floors-only) clone anchor; an honest MIRROR-CATCH-UP introduction (partial ' +
    'anchor, historical observed 108 against a live 114) now PASSES since introduction no longer applies REAL, ' +
    "with round 4's own shipped REAL loop demonstrated as the mutant that would have refused it; an honest " +
    'post-stand-down genesis re-introduction still passes with a loud, non-refusing INTRODUCED line naming ' +
    'format- and COHERENT-checked plus trust-on-first-use — genesis is no longer unconditionally silent'
  );
}

// ---------------------------------------------------------------------------
// Test 51 (T-541 round 4, criterion 4): ADDED keys gain REACHABLE too, but
// only against a LEGACY (pre-round-4) published anchor that itself already
// violates COHERENT — a floor with no matching prior observed entry. Dead
// code against any anchor the gate itself has admitted since round 4
// shipped (COHERENT there guarantees a floored key always has a matching
// observed key, so it could never appear as "added" in the first place).
// ---------------------------------------------------------------------------
{
  const assembledDir = mkTempDir('mavp-overlay-t551-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t551-clone-');
  writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
  writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
  t541WriteDirFilesShared(cloneDir, 'x', 3);
  t541WriteDirFilesShared(assembledDir, 'x', 3);
  t541WriteDirFilesShared(assembledDir, 'newkey', 3); // the live tree for the added key: 3 files
  t533WriteGitDir(cloneDir);

  // The LEGACY published anchor: floors declares "newkey" at 5, but the
  // published observed map never recorded it at all — a floor with no
  // matching observation, i.e. an anchor that would itself fail COHERENT if
  // it were being checked today (it is not — COHERENT only runs on the
  // ASSEMBLED side; the clone's own historical anchor is trusted as-is).
  t541WriteFull(cloneDir, {
    seededOn: '2026-01-01',
    observed: { x: 3 }, // no "newkey" entry at all
    floors: { x: 1, newkey: 5 },
  });
  // The assembled side re-seeds "newkey" for the first time (ADDED, since
  // absent from published.observed) at 3 — below the legacy floor of 5.
  t541WriteFull(assembledDir, {
    seededOn: '2026-02-01',
    observed: { x: 3, newkey: 3 },
    floors: { x: 1, newkey: 2 },
  });

  const result = t541RunOverlay(assembledDir, cloneDir);
  assert.strictEqual(
    result.status, 1,
    `Test 51 FAIL: an ADDED key re-seeded below a legacy anchor's already-declared floor must REFUSE, got exit ${result.status}:\n${result.stdout}`
  );
  assert.strictEqual(result.stdout, '', `Test 51 FAIL: a refusing run must print nothing on stdout:\n${result.stdout}`);
  const refusal = t541SuccessionRefusalOf(result.stderr);
  assert.ok(
    refusal && refusal.includes('"newkey"') && refusal.includes('below the previously') && refusal.includes('5'),
    `Test 51 FAIL: expected a REACHABLE refusal naming "newkey", its re-seeded count and the legacy floor of 5. Got:\n${result.stderr}`
  );

  console.log(
    'Test 51 passed: T-541 round 4 criterion 4 — an ADDED key (absent from the published observed map) still gets ' +
    'REACHABLE-checked against a legacy anchor\'s already-declared floor for that same directory (newkey: ' +
    're-seeded at 3, legacy floor 5, refused); this rule is dead code against any anchor the gate itself has ' +
    'admitted since round 4 shipped, since COHERENT there guarantees a floored key always has a matching prior ' +
    'observed entry'
  );
}

// ---------------------------------------------------------------------------
// Test 52 (T-541 round 4, criterion 5): THE CERTIFICATE IS GENERATED, not
// narrated. A mixed changed/added/removed publish must produce a re-seed
// certificate line whose counts and NAMES are taken directly from the
// arrays the rules iterated (delta.changed, delta.added, delta.removed) —
// never prose that could claim more than the code actually checked.
// ---------------------------------------------------------------------------
{
  const assembledDir = mkTempDir('mavp-overlay-t552-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t552-clone-');
  writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
  writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
  t541WriteDirFilesShared(cloneDir, 'c', 5);
  t541WriteDirFilesShared(assembledDir, 'c', 6); // CHANGED: 5 -> 6
  t541WriteDirFilesShared(cloneDir, 'u', 3);
  t541WriteDirFilesShared(assembledDir, 'u', 3); // UNCHANGED
  t541WriteDirFilesShared(assembledDir, 'a', 2); // ADDED (brand new)
  // "r" is retired WHOLLY (both observed and floor removed) — no live files
  // needed for it on the assembled side.
  t533WriteGitDir(cloneDir);

  t541WriteFull(cloneDir, {
    seededOn: '2026-01-01',
    observed: { c: 5, r: 4, u: 3 },
    floors: { c: 2, r: 1, u: 1 },
  });
  t541WriteFull(assembledDir, {
    seededOn: '2026-02-01',
    observed: { c: 6, u: 3, a: 2 },
    floors: { c: 3, u: 1, a: 1 },
  });

  const result = t541RunOverlay(assembledDir, cloneDir);
  assert.strictEqual(result.status, 0, `Test 52 FAIL: a mixed changed/added/removed publish must PASS, got exit ${result.status}:\n${result.stderr}`);
  const reseedLine = t541ReseedLineOf(result.stderr);
  assert.ok(reseedLine, `Test 52 FAIL: expected a generated re-seed certificate line:\n${result.stderr}`);
  assert.ok(
    reseedLine.includes('1 changed key REAL+REACHABLE-verified (c)'),
    `Test 52 FAIL: expected the CHANGED part to name exactly "c". Got:\n${reseedLine}`
  );
  assert.ok(
    reseedLine.includes('1 added key REAL-verified (a)'),
    `Test 52 FAIL: expected the ADDED part to name exactly "a". Got:\n${reseedLine}`
  );
  assert.ok(
    reseedLine.includes('1 entry stood down with their floor(s) (r (floor 1))'),
    `Test 52 FAIL: expected the REMOVED part to name "r" with its stood-down floor (1). Got:\n${reseedLine}`
  );
  // "u" (unchanged) must never appear quoted as a bucket member anywhere in
  // the certificate line — it never entered any delta bucket.
  assert.ok(
    !new RegExp('\\(u\\)|\\bu,|, u\\b').test(reseedLine),
    `Test 52 FAIL: unchanged key "u" must never appear as a bucket member in the certificate line. Got:\n${reseedLine}`
  );

  console.log(
    'Test 52 passed: T-541 round 4 criterion 5 — the re-seed certificate line for a mixed changed/added/removed ' +
    'publish is GENERATED directly from the arrays the rules iterated: "1 changed key REAL+REACHABLE-verified (c); ' +
    '1 added key REAL-verified (a); 1 entry stood down with their floor(s) (r (floor 1))" — the unchanged key "u" ' +
    'never appears as a bucket member anywhere in the line'
  );
}

// ---------------------------------------------------------------------------
// Test 53 (T-549, T-541 round 4 security review MEDIUM residual): the
// reviewer's own live-CLI chain — a genuine full anchor, then a STAND-DOWN,
// then a FABRICATED RECORD-INTRODUCTION claiming a directory was observed at
// 1 while the assembled tree's OWN live direct count under that same
// directory is actually 500. Per the module header's T-549 section, steps 1
// and 2 (the genuine anchor, then the stand-down that empties it) are
// represented by their OUTPUT STATE alone — the clone holding no ledger at
// all — exactly matching every other fixture in this suite's convention
// (Test 42/50 seed clone/assembled state directly rather than re-deriving it
// via an intervening overlay run) and exactly what a real stand-down leaves
// behind (the stand-down branch itself is already covered end to end
// elsewhere, e.g. Test 43's cell ['full-anchor', 'no-ledger', 'standDown']).
// This fixture picks up at step 3: the fabricated re-introduction. Must PASS
// (introduction is TOFU by design, not REAL-checked — see the header's ROUND
// 4 CORRECTED / T-549 sections) with the INTRODUCED line naming BOTH the
// fabricated claimed count and the live tree's actual count, so the forgery
// indicts itself in the very line that would otherwise have read identically
// to an honest catch-up.
// ---------------------------------------------------------------------------
{
  const assembledDir = mkTempDir('mavp-overlay-t549-fabricated-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t549-fabricated-clone-');
  writeFile(path.join(cloneDir, 'keep.md'), contentOfT533('keep.md'));
  writeFile(path.join(assembledDir, 'keep.md'), contentOfT533('keep.md'));
  // The LIVE tree actually holds 500 files directly under "X" at this
  // publish — the true count a same-commit forger evacuated away from in
  // the reviewer's reproduction.
  t541WriteDirFilesShared(assembledDir, 'X', 500);
  t533WriteGitDir(cloneDir);
  // Clone holds NO ledger at all (post-stand-down state) — a genuine "X"
  // anchor at observed=500/floor=300 was established at some earlier
  // publish, then the tier was stood down (WARNING, ledger deleted from the
  // clone), which is exactly the precondition this RECORD-INTRODUCTION path
  // requires (published.state === 'none').
  //
  // The FABRICATED re-introduction: claims "X" was observed at only 1 (with
  // a matching floor of 1, so the ordinary shape-contract floor check below
  // also passes cleanly on this manufactured low bar) while the live tree
  // above actually holds 500.
  t541WriteFull(assembledDir, { seededOn: '2026-03-01', observed: { X: 1 }, floors: { X: 1 } });

  const result = t541RunOverlay(assembledDir, cloneDir);
  assert.strictEqual(
    result.status, 0,
    `Test 53 FAIL: a fabricated re-introduction must still PASS (TOFU by design, not a refusal) — got exit ${result.status}:\n${result.stderr}`
  );
  const introLine = t541IntroducedLineOf(result.stderr);
  assert.ok(introLine, `Test 53 FAIL: expected a loud INTRODUCED line, got:\n${result.stderr}`);
  assert.ok(
    introLine.includes('claimed=1') && introLine.includes('live=500'),
    `Test 53 FAIL: expected the INTRODUCED line to name BOTH the fabricated claimed count (1) and the live tree's ` +
    `actual count (500) so the forgery indicts itself in the reviewable line. Got:\n${introLine}`
  );
  assert.ok(
    /trust-on-first-use/.test(introLine) && !/REAL/.test(introLine),
    `Test 53 FAIL: the claimed-vs-live term must remain informational, not a REAL-shaped check — the decision ` +
    `function must still admit this fabricated introduction. Got:\n${introLine}`
  );

  console.log(
    "Test 53 passed: T-549 — the reviewer's own stand-down -> fabricated-re-introduction chain (claimed 1 against " +
    'a live 500) now prints BOTH numbers on the loud INTRODUCED line, informationally, without adding any new ' +
    'refusal — the publish still passes (TOFU is a deliberate non-decision this task does not close), but the ' +
    'forgery is no longer indistinguishable from an honest mirror catch-up in the release log'
  );
}

// =============================================================================
// T-527 — END-TO-END COVERAGE FOR COMPOSITION RULES BOUND ONLY BY A UNIT TEST.
//
// Every rule in findDirectoryViolations() (T-507) is exercised by Test 12
// directly against the function — a fast, precise UNIT check — but Test 12
// never drives the real CLI, so a defect in main()'s own WIRING of these
// rules (the wrong variable read, a dropped call, a mis-ordered check) could
// ship even while Test 12 stays green. Tests 54-58 below close that gap for
// the five rules that had no CLI-driven killer at all: the per-directory >=
// boundary (54), the multi-directory aggregate ceiling (55), the small-
// directory aggregate (56), the whole-clone >=-with-floor boundary (57, which
// had NO killer of any kind, unit or e2e), and the tier-1 full-wipe rule's
// immunity to move credit on a basename-preserving relocation (58, which
// also had no e2e killer — Test 13's laundering fixture renames its files,
// so rawDeleted and move-adjusted deleted coincide there and the fixture
// cannot discriminate the two).
//
// MUTATION PROTOCOL (per the T-527 brief): for each of the five rules, the
// developer applied the named mutant live, once, to scripts/mavp-publish-
// overlay.js, ran the existing suite to confirm what — if anything — already
// reacts, ran the new Test 5N here to confirm IT reacts, then reverted the
// mutant immediately. No mutant was ever committed. Full results, including
// any correction to the brief's own mutant-survival claims, are quoted in
// the T-527 evidence rather than re-derived here.
//
// THE OBLIGATION THIS TASK CLOSES IS NOW INVERTED, per the brief: this five-
// case sweep is a ONE-TIME CLOSURE AUDIT of rules that predate the
// discipline, not a standing re-run obligation. Every future refusal tier
// added to findDirectoryViolations() (or to any sibling composition rule in
// this file) must land WITH ITS OWN end-to-end killer in the SAME task that
// adds the rule — see T-533's shape-contract rule and T-541/T-548/T-549's
// succession gate for tasks that already followed this shape without being
// told to. A rule with only a unit-level killer is, from this task forward,
// an incomplete task, not a follow-up backlog item.
// =============================================================================

// Test 54 (T-527 case 1): the per-directory >= boundary, END TO END, at an
// exact-half single-bucket reproduction (52 of 104 deleted) — Test 12 already
// pins this exact boundary directly against findDirectoryViolations(), but no
// CLI-driven case does. Padded with an untouched 10-file directory so the
// WHOLE-CLONE ratio (52 of 114 = 45.6%) stays safely under its own 50%
// threshold and cannot preempt (or duplicate) this rule's refusal.
// Live mutant (reverted immediately, never committed): findDirectoryViolations()'s
// rule-2 condition `if (ratio >= dirMaxDeleteRatio)` reverted to `if (ratio >
// dirMaxDeleteRatio)`.
{
  const assembledDir = mkTempDir('mavp-overlay-t527-c1-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t527-c1-clone-');
  for (let i = 0; i < 104; i++) {
    writeFile(path.join(cloneDir, 'bigdir', `f${i}.md`), `bigdir file ${i}\n`);
  }
  for (let i = 0; i < 52; i++) {
    writeFile(path.join(assembledDir, 'bigdir', `f${i}.md`), `bigdir file ${i}\n`);
  }
  for (let i = 0; i < 10; i++) {
    writeFile(path.join(cloneDir, 'pad', `p${i}.md`), `pad ${i}\n`);
    writeFile(path.join(assembledDir, 'pad', `p${i}.md`), `pad ${i}\n`);
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 54 FAIL: expected the exact-half per-directory deletion (52 of 104) to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    /bigdir: 52 of 104 \(50\.0%\)/.test(result.stderr),
    `Test 54 FAIL: expected the refusal to name bigdir at exactly 50.0% (52 of 104), got: ${result.stderr}`
  );
  assert.ok(
    /per-directory composition guard/.test(result.stderr),
    `Test 54 FAIL: expected the PER-DIRECTORY guard's own message, got: ${result.stderr}`
  );
  assert.ok(
    !/planned deletion would remove \d+ of \d+ non-preserved tracked file/.test(result.stderr),
    `Test 54 FAIL: the WHOLE-CLONE guard's own refusal wording must not appear — 45.6% must stay silent, got: ${result.stderr}`
  );
  assert.strictEqual(
    fs.existsSync(path.join(cloneDir, 'bigdir', 'f52.md')), true,
    'Test 54 FAIL: no writes should have happened — bigdir/f52.md must still exist'
  );
  console.log('Test 54 passed: T-527 case 1 — per-directory >= boundary (52 of 104, exact half) is refused end-to-end, closing the gap left by Test 12\'s unit-only coverage');
}

// Test 55 (T-527 case 2): the multi-directory aggregate ceiling, END TO END,
// at a two-bucket 49-of-193 aggregate (alpha: 100 files/25 deleted = 25%;
// beta: 93 files/24 deleted = 25.8%) — each bucket individually stays well
// under its own 50% per-directory budget, but the COMBINED deletion across
// both simultaneously-touched buckets (49 of 193 = 25.4%) meets the tighter
// multi-directory ceiling (half of the per-directory ratio, 25%). No padding
// is needed: with no full-wipe bucket in play, the whole-clone ratio is
// mathematically identical to the multi-directory ratio here (49/193 =
// 25.4%), which is comfortably under the whole-clone's own 50% threshold, so
// only the multi-directory rule reacts.
// Live mutant (reverted immediately, never committed): the entire
// `if (touchedBuckets > 1 && totalAcrossTouchableBuckets > 0) { ... }` block
// in findDirectoryViolations() neutralized (condition forced false).
{
  const assembledDir = mkTempDir('mavp-overlay-t527-c2-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t527-c2-clone-');
  for (let i = 0; i < 100; i++) {
    writeFile(path.join(cloneDir, 'alpha', `f${i}.md`), `alpha file ${i}\n`);
  }
  for (let i = 25; i < 100; i++) { // keep 75 of 100 (delete 25 = 25%)
    writeFile(path.join(assembledDir, 'alpha', `f${i}.md`), `alpha file ${i}\n`);
  }
  for (let i = 0; i < 93; i++) {
    writeFile(path.join(cloneDir, 'beta', `f${i}.md`), `beta file ${i}\n`);
  }
  for (let i = 24; i < 93; i++) { // keep 69 of 93 (delete 24 = 25.8%)
    writeFile(path.join(assembledDir, 'beta', `f${i}.md`), `beta file ${i}\n`);
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 55 FAIL: expected the two-bucket 49-of-193 aggregate to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    /\(aggregate across multiple simultaneously-touched directories\): 49 of 193 \(25\.4%\)/.test(result.stderr),
    `Test 55 FAIL: expected the multi-directory aggregate refusal naming 49 of 193 (25.4%), got: ${result.stderr}`
  );
  assert.ok(
    !/alpha: /.test(result.stderr) && !/beta: /.test(result.stderr),
    `Test 55 FAIL: neither individual bucket (25%/25.8%, both under the 50% per-directory budget) should be named as its own violation, got: ${result.stderr}`
  );
  assert.ok(
    !/max-delete-ratio threshold/.test(result.stderr),
    `Test 55 FAIL: the whole-clone guard (25.4%, well under 50%) must stay silent — the multi-directory rule alone must refuse, got: ${result.stderr}`
  );
  console.log('Test 55 passed: T-527 case 2 — multi-directory aggregate ceiling (49 of 193 across two buckets, each individually within its own 50% budget) is refused end-to-end');
}

// Test 56 (T-527 case 3): a small-directory aggregate drop, END TO END — two
// directories, each individually below MIN_DIR_SIZE (4 files each, so
// exempt from the per-directory ratio rule) and each only PARTIALLY deleted
// (never a full wipe on its own: 3 of 4, then 2 of 4), fold into one
// synthetic bucket that IS a violation (5 of 8 = 62.5% >= 50%). A large
// untouched padding directory (50 files) dilutes both the whole-clone ratio
// AND the multi-directory ratio (5 of 58 = 8.6%, comfortably under both the
// 50% and 25% ceilings) without diluting the small-directory aggregate at
// all (the padding bucket is >= MIN_DIR_SIZE, so it is never folded in) —
// isolating the aggregate-of-small-directories rule as the sole refusing tier.
// Live mutant (reverted immediately, never committed): the entire
// `if (aggregateTotal >= minDirSize) { ... }` block in
// findDirectoryViolations() neutralized (condition forced false).
{
  const assembledDir = mkTempDir('mavp-overlay-t527-c3-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t527-c3-clone-');
  const small1 = ['a.md', 'b.md', 'c.md', 'd.md'];
  for (const name of small1) writeFile(path.join(cloneDir, 'small-1', name), `small-1 ${name}\n`);
  writeFile(path.join(assembledDir, 'small-1', 'a.md'), 'small-1 a.md\n'); // keep 1 of 4 (delete 3)
  const small2 = ['a.md', 'b.md', 'c.md', 'd.md'];
  for (const name of small2) writeFile(path.join(cloneDir, 'small-2', name), `small-2 ${name}\n`);
  writeFile(path.join(assembledDir, 'small-2', 'a.md'), 'small-2 a.md\n');
  writeFile(path.join(assembledDir, 'small-2', 'b.md'), 'small-2 b.md\n'); // keep 2 of 4 (delete 2)
  for (let i = 0; i < 50; i++) {
    writeFile(path.join(cloneDir, 'pad', `p${i}.md`), `pad ${i}\n`);
    writeFile(path.join(assembledDir, 'pad', `p${i}.md`), `pad ${i}\n`);
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 56 FAIL: expected the small-directory aggregate drop (5 of 8) to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    /\(aggregated small directories, each individually below MIN_DIR_SIZE\): 5 of 8 \(62\.5%\)/.test(result.stderr),
    `Test 56 FAIL: expected the small-directory aggregate refusal naming 5 of 8 (62.5%), got: ${result.stderr}`
  );
  assert.ok(
    !/max-delete-ratio threshold/.test(result.stderr) &&
    !/aggregate across multiple simultaneously-touched directories/.test(result.stderr),
    `Test 56 FAIL: neither the whole-clone guard (8.6%) nor the multi-directory guard (8.6%, both well under their ` +
    `ceilings) should fire — the small-directory aggregate rule alone must refuse, got: ${result.stderr}`
  );
  console.log('Test 56 passed: T-527 case 3 — small-directory aggregate drop (5 of 8 across two individually-exempt directories) is refused end-to-end, with the whole-clone and multi-directory guards both confirmed silent');
}

// Test 57 (T-527 case 4): the whole-clone >=-with-floor boundary, END TO
// END — currently unbound at ANY level, unit or e2e. A single touched
// directory (bigdir: 6 files, 5 deleted = 83.3%, comfortably under a
// deliberately widened --max-dir-delete-ratio of 1.0) plus an untouched
// 4-file directory (smalldir, folded into the aggregate-of-small check but
// below MIN_DIR_SIZE so never evaluated) bring the WHOLE-CLONE ratio to
// exactly 5 of 10 = 50.0%. Widening --max-dir-delete-ratio to 1.0 (its
// maximum) neutralizes every per-directory-family rule so the whole-clone
// tier is the sole possible refusing guard — round 1's own floor logic
// (nonPreservedCloneCount >= MIN_DIR_SIZE switches the comparison from
// strict `>` to `>=`) is exactly what this case pins, since 10 >= 5.
// Live mutant (reverted immediately, never committed): main()'s
// `wholeCloneRatioIsStrict ? ratio > maxDeleteRatio : ratio >= maxDeleteRatio`
// reverted to `wholeCloneRatioIsStrict ? ratio > maxDeleteRatio : ratio > maxDeleteRatio`
// (the non-strict branch's `>=` reverted to `>`).
{
  const assembledDir = mkTempDir('mavp-overlay-t527-c4-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t527-c4-clone-');
  for (let i = 0; i < 6; i++) {
    writeFile(path.join(cloneDir, 'bigdir', `f${i}.md`), `bigdir file ${i}\n`);
  }
  writeFile(path.join(assembledDir, 'bigdir', 'f0.md'), 'bigdir file 0\n'); // keep 1 of 6 (delete 5)
  for (let i = 0; i < 4; i++) {
    writeFile(path.join(cloneDir, 'smalldir', `f${i}.md`), `smalldir file ${i}\n`);
    writeFile(path.join(assembledDir, 'smalldir', `f${i}.md`), `smalldir file ${i}\n`); // fully kept
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir, '--max-dir-delete-ratio', '1'],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 57 FAIL: expected the exact-half whole-clone deletion (5 of 10) to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    /refusing to overlay — planned deletion would remove 5 of 10 non-preserved tracked file\(s\)/.test(result.stderr),
    `Test 57 FAIL: expected the whole-clone refusal naming 5 of 10, got: ${result.stderr}`
  );
  assert.ok(
    /meeting or exceeding/.test(result.stderr),
    `Test 57 FAIL: at nonPreservedCloneCount (10) >= MIN_DIR_SIZE (5), the message must use the non-strict ` +
    `"meeting or exceeding" wording (the >= branch), got: ${result.stderr}`
  );
  assert.strictEqual(
    fs.existsSync(path.join(cloneDir, 'bigdir', 'f1.md')), true,
    'Test 57 FAIL: no writes should have happened — bigdir/f1.md must still exist'
  );
  console.log('Test 57 passed: T-527 case 4 — whole-clone >=-with-floor boundary (5 of 10, exact half, at/above MIN_DIR_SIZE) is refused end-to-end — previously unbound at any level');
}

// Test 58 (T-527 case 5): the tier-1 laundered full wipe — a directory
// (widgets/, 5 files, exactly MIN_DIR_SIZE) fully wiped from its original
// location while every file's CONTENT and BASENAME reappear at a RELATED
// destination (widgets/archive/ — same first path segment, so isRelatedMove()
// credits it) — move credit zeroes the ADJUSTED deleted count for this
// bucket to 0, so every OTHER tier (per-directory ratio, aggregates,
// whole-clone) sees nothing. Only tier 1, reading rawDeleted (immune to move
// credit by design), must still refuse. Padded with 20 untouched files so
// the whole-run move-credit cap (5 of 25 = 20%, under its 25% ceiling) does
// not ALSO refuse and mask this rule's own mutant.
// Live mutant (reverted immediately, never committed): findDirectoryViolations()'s
// `const rawDeleted = stat.rawDeleted !== undefined ? stat.rawDeleted : stat.deleted;`
// changed to `const rawDeleted = stat.deleted;` (tier 1 made to consult the
// move-adjusted count instead of the raw one).
{
  const assembledDir = mkTempDir('mavp-overlay-t527-c5-assembled-');
  const cloneDir = mkTempDir('mavp-overlay-t527-c5-clone-');
  for (let i = 0; i < 5; i++) {
    writeFile(path.join(cloneDir, 'widgets', `f${i}.md`), `widgets file ${i}\n`);
    // Relocated, byte-identical, same basename, RELATED destination (shares
    // the 'widgets' first segment) — the exact laundering shape this rule
    // must see through.
    writeFile(path.join(assembledDir, 'widgets', 'archive', `f${i}.md`), `widgets file ${i}\n`);
  }
  for (let i = 0; i < 20; i++) {
    writeFile(path.join(cloneDir, 'padding', `p${i}.md`), `padding ${i}\n`);
    writeFile(path.join(assembledDir, 'padding', `p${i}.md`), `padding ${i}\n`);
  }

  const result = require('node:child_process').spawnSync(
    process.execPath,
    [OVERLAY_SCRIPT, assembledDir, cloneDir],
    { encoding: 'utf8' }
  );
  assert.notStrictEqual(
    result.status, 0,
    `Test 58 FAIL: expected the basename-preserving laundered full wipe of widgets/ to be refused, got exit ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    /widgets: 5 of 5 \(100\.0%\) \[complete removal\]/.test(result.stderr),
    `Test 58 FAIL: expected the full-wipe refusal naming widgets at 5 of 5 (100.0%), got: ${result.stderr}`
  );
  assert.ok(
    !/move-credit cap/.test(result.stderr),
    `Test 58 FAIL: expected the FULL-WIPE tier to be the refusing rule, not the whole-run move-credit cap ` +
    `(padded to 20%, well under its 25% ceiling), got: ${result.stderr}`
  );
  assert.strictEqual(
    fs.existsSync(path.join(cloneDir, 'widgets', 'f0.md')), true,
    'Test 58 FAIL: no writes should have happened — widgets/f0.md must still exist'
  );
  console.log('Test 58 passed: T-527 case 5 — the tier-1 laundered full wipe (widgets/ fully drained, every file relocated byte-identical under its own basename to a RELATED destination) is refused via rawDeleted, immune to move credit');
}

console.log('\nAll T-356 + T-504 + T-507 + T-532 + T-533 + T-540 + T-541 (rounds 1-4) + T-549 security fixes assertions passed.');
