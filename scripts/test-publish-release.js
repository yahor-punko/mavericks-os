'use strict';
// Regression test: T-502 — stable-release promoter script.
//
// Every fixture here is a LOCAL git repo (a `--bare` temp dir standing in
// for the public mirror, plus a working clone) — never a real remote, never
// `~/.mavericks`, never a real GitHub URL, per the T-502 brief's safety
// constraint. `gh` is never executed by the script under test; Test 5 below
// proves that with a fake `gh` shim on PATH.
//
// Covers:
//   1. The AC's exact behavioral assertion: edge ahead of main, previous
//      stable tag v0.38.2, edge-tip version file at 0.39.0 -> main moves to
//      the edge tip, tag v0.39.0 is created, and the emitted body contains
//      the [0.39.0] section and NOTHING at or below [0.38.2] (checked in
//      both directions: presence of the new section, absence of the old
//      one's heading AND its body text).
//   2. Non-fast-forward promotion (main has a commit edge does not contain)
//      is refused, and the mirror's main ref is left untouched.
//   3. An already-existing tag is refused before any mutation (mirror main
//      is left untouched).
//   4. Multi-section case: TWO sections newer than the previous stable tag
//      both land in the body, in document order, with the older tagged
//      section still excluded.
//   5. `gh` is never executed (a fake `gh` shim on PATH proves it was never
//      invoked), and the printed command is the exact string this test
//      asserts on.
//   6. Pure-function unit checks (parseChangelogSections/extractReleaseSections/
//      computePreviousStableVersion/compareVersions/parseMavericksVersion/
//      isPlainNumericVersion/parseArgs/renderReleaseBody) directly against
//      module.exports, independent of any git fixture.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const RELEASE_SCRIPT = path.join(__dirname, 'mavp-publish-release.js');

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function initBareMirror() {
  const dir = mkTempDir('mavp-release-bare-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: dir });
  return dir;
}

function initWorkingClone() {
  const dir = mkTempDir('mavp-release-clone-');
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture User']);
  return dir;
}

function versionFileContent(version) {
  return `module.exports = { MAVERICKS_VERSION: '${version}' };\n`;
}

// sections: array of { version, date, body }, newest first (house style).
function changelogContent(sections) {
  let out = '# Changelog\n\n## [Unreleased]\n\n';
  for (const s of sections) {
    out += `## [${s.version}] — ${s.date}\n\n${s.body}\n\n`;
  }
  return out;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

// ---------------------------------------------------------------------------
// Test 1: AC's exact behavioral assertion.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' },
      { version: '0.38.1', date: '2026-07-19', body: '### Added\n\n- older content\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- new stuff for the 0.39.0 release\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' },
      { version: '0.38.1', date: '2026-07-19', body: '### Added\n\n- older content\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const bodyPath = path.join(mkTempDir('mavp-release-body1-'), 'release-body.md');
  const stdout = execFileSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], {
    encoding: 'utf8',
  });

  const mirrorMainSha = git(bareDir, ['rev-parse', 'main']).trim();
  const mirrorEdgeSha = git(bareDir, ['rev-parse', 'edge']).trim();
  assert.strictEqual(mirrorMainSha, mirrorEdgeSha, 'Test 1 FAIL: mirror main should now equal the edge tip');

  const tagSha = git(bareDir, ['rev-parse', 'v0.39.0']).trim();
  assert.strictEqual(tagSha, mirrorEdgeSha, 'Test 1 FAIL: tag v0.39.0 should point at the edge tip');

  const body = fs.readFileSync(bodyPath, 'utf8');
  assert.ok(body.includes('## [0.39.0]'), 'Test 1 FAIL: body should contain the [0.39.0] section heading');
  assert.ok(body.includes('new stuff for the 0.39.0 release'), 'Test 1 FAIL: body should contain the [0.39.0] section body');
  assert.ok(!body.includes('## [0.38.2]'), 'Test 1 FAIL: body must NOT contain the [0.38.2] section heading');
  assert.ok(!body.includes('base release content'), 'Test 1 FAIL: body must NOT contain [0.38.2] section body text');
  assert.ok(!body.includes('## [0.38.1]'), 'Test 1 FAIL: body must NOT contain the [0.38.1] section heading (older than 0.38.2)');
  assert.ok(!body.includes('older content'), 'Test 1 FAIL: body must NOT contain [0.38.1] section body text');
  assert.ok(!body.includes('## [Unreleased]'), 'Test 1 FAIL: body must NOT contain the Unreleased heading');

  assert.ok(stdout.includes("gh release create 'v0.39.0'"), 'Test 1 FAIL: expected the (shell-quoted) gh command to be printed');
  assert.ok(stdout.includes(bodyPath), 'Test 1 FAIL: expected the printed command to reference the body file path');
  assert.ok(stdout.includes('git -C'), 'Test 1 FAIL: expected the closing mirror-clone pull step to be printed');
  assert.ok(stdout.includes('pull'), 'Test 1 FAIL: expected the closing mirror-clone pull step to be printed');

  console.log('Test 1 passed: edge-ahead-of-main fixture promotes main, tags v0.39.0, and emits a body bounded exactly at (0.38.2, 0.39.0]');
}

// ---------------------------------------------------------------------------
// Test 2: non-fast-forward promotion is refused; mirror main untouched.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'edge-only.md'), 'edge content\n');
  commitAll(cloneDir, 'fixture: edge-only commit');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);

  // Diverge main with a commit edge does NOT contain.
  git(cloneDir, ['checkout', '-q', 'main']);
  writeFile(path.join(cloneDir, 'main-only.md'), 'main content\n');
  commitAll(cloneDir, 'fixture: main-only diverging commit');
  git(cloneDir, ['push', '-q', 'origin', 'main']);

  const mirrorMainShaBefore = git(bareDir, ['rev-parse', 'main']).trim();

  const bodyPath = path.join(mkTempDir('mavp-release-body2-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 2 FAIL: expected non-zero exit on a non-fast-forward promotion, got ${result.status}`);
  assert.ok(/NON-FAST-FORWARD/.test(result.stderr), `Test 2 FAIL: expected a NON-FAST-FORWARD refusal, got: ${result.stderr}`);
  assert.ok(/no push has occurred/.test(result.stderr), `Test 2 FAIL: expected the standard abort footer, got: ${result.stderr}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, mirrorMainShaBefore, 'Test 2 FAIL: mirror main must be untouched after a refused non-fast-forward promotion');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 2 FAIL: no release-body file should have been written on a refused run');

  console.log('Test 2 passed: non-fast-forward promotion is refused and the mirror main ref is left untouched');
}

// ---------------------------------------------------------------------------
// Test 3: an already-existing tag is refused, before any mutation.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  const baseSha = git(cloneDir, ['rev-parse', 'HEAD']).trim();

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- new stuff\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Pre-create v0.39.0 directly on the bare mirror (simulating "already released").
  git(bareDir, ['tag', 'v0.39.0', baseSha]);

  const bodyPath = path.join(mkTempDir('mavp-release-body3-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 3 FAIL: expected non-zero exit when the tag already exists, got ${result.status}`);
  assert.ok(/already exists/.test(result.stderr), `Test 3 FAIL: expected an "already exists" refusal, got: ${result.stderr}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, baseSha, 'Test 3 FAIL: mirror main must be untouched (still at base, not promoted) after the tag-exists refusal');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 3 FAIL: no release-body file should have been written on a refused run');

  console.log('Test 3 passed: an already-existing tag is refused before any mutation (mirror main untouched)');
}

// ---------------------------------------------------------------------------
// Test 4: multi-section case — TWO sections newer than the previous stable
// tag both land in the body, in document order.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' }])
  );
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.1'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.1', date: '2026-07-25', body: '### Fixed\n\n- second intermediate working build\n' },
      { version: '0.39.0', date: '2026-07-24', body: '### Added\n\n- first intermediate working build\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: two intermediate working builds, edge at 0.39.1');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const bodyPath = path.join(mkTempDir('mavp-release-body4-'), 'release-body.md');
  execFileSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  const tagSha = git(bareDir, ['rev-parse', 'v0.39.1']).trim();
  const mirrorEdgeSha = git(bareDir, ['rev-parse', 'edge']).trim();
  assert.strictEqual(tagSha, mirrorEdgeSha, 'Test 4 FAIL: tag v0.39.1 should point at the edge tip');

  const body = fs.readFileSync(bodyPath, 'utf8');
  assert.ok(body.includes('## [0.39.1]'), 'Test 4 FAIL: body should contain the [0.39.1] section heading');
  assert.ok(body.includes('second intermediate working build'), 'Test 4 FAIL: body should contain the [0.39.1] section body');
  assert.ok(body.includes('## [0.39.0]'), 'Test 4 FAIL: body should ALSO contain the [0.39.0] section heading (multi-section)');
  assert.ok(body.includes('first intermediate working build'), 'Test 4 FAIL: body should contain the [0.39.0] section body');
  assert.ok(!body.includes('## [0.38.2]'), 'Test 4 FAIL: body must NOT contain the already-tagged [0.38.2] section');
  assert.ok(!body.includes('base release content'), 'Test 4 FAIL: body must NOT contain [0.38.2] section body text');

  const idx391 = body.indexOf('## [0.39.1]');
  const idx390 = body.indexOf('## [0.39.0]');
  assert.ok(idx391 >= 0 && idx390 >= 0 && idx391 < idx390, 'Test 4 FAIL: expected [0.39.1] to appear before [0.39.0] in the body (document order)');

  console.log('Test 4 passed: two sections newer than the previous stable tag both land in the body, in order');
}

// ---------------------------------------------------------------------------
// Test 5: `gh` is never executed — proven with a fake `gh` shim on PATH.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- new stuff\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Fake `gh` shim: if ever invoked, it writes a marker file. Placed first
  // on PATH so it would shadow any real `gh` on the test machine too.
  const fakeBinDir = mkTempDir('mavp-release-fakebin-');
  const markerPath = path.join(fakeBinDir, 'gh-invoked.marker');
  const fakeGhPath = path.join(fakeBinDir, 'gh');
  fs.writeFileSync(fakeGhPath, `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`);
  fs.chmodSync(fakeGhPath, 0o755);

  const bodyPath = path.join(mkTempDir('mavp-release-body5-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` },
  });

  assert.strictEqual(result.status, 0, `Test 5 FAIL: expected exit 0, got ${result.status}:\n${result.stderr}`);
  assert.strictEqual(fs.existsSync(markerPath), false, 'Test 5 FAIL: gh was invoked (marker file exists) — the script must only print the command');
  assert.ok(result.stdout.includes("gh release create 'v0.39.0'"), 'Test 5 FAIL: expected the exact (shell-quoted) gh command to be printed on stdout');
  assert.ok(result.stdout.includes('--notes-file'), 'Test 5 FAIL: expected --notes-file in the printed gh command');
  assert.ok(result.stdout.includes('never executes it'), 'Test 5 FAIL: expected the human-checkpoint framing line to be printed');

  console.log('Test 5 passed: gh is never executed (fake-shim proof) — the exact command is printed instead');
}

// ---------------------------------------------------------------------------
// Test 6: pure-function unit checks, independent of any git fixture.
// ---------------------------------------------------------------------------
{
  const {
    parseArgs,
    parseMavericksVersion,
    isPlainNumericVersion,
    compareVersions,
    parseChangelogSections,
    findMalformedHeadingLines,
    findUnterminatedFenceLine,
    computePreviousStableVersion,
    extractReleaseSections,
    renderReleaseBody,
    shQuote,
  } = require('./mavp-publish-release.js');

  // parseArgs
  const parsed = parseArgs(['remote-a', 'clone-b', '--body-out', '/tmp/out.md']);
  assert.strictEqual(parsed.mirrorRemote, 'remote-a', 'Test 6 FAIL: unexpected mirrorRemote');
  assert.strictEqual(parsed.cloneDir, 'clone-b', 'Test 6 FAIL: unexpected cloneDir');
  assert.strictEqual(parsed.bodyOutPath, '/tmp/out.md', 'Test 6 FAIL: unexpected bodyOutPath');
  assert.strictEqual(parsed.bodyOutError, null, 'Test 6 FAIL: a legitimate --body-out value should not error');
  const parsedNoBody = parseArgs(['remote-a', 'clone-b']);
  assert.strictEqual(parsedNoBody.bodyOutPath, null, 'Test 6 FAIL: bodyOutPath should default to null');

  // security review round 2, LOW: --body-out whose value is itself a flag
  // must be rejected, not silently accepted as a literal filename.
  const parsedFlagValue = parseArgs(['remote-a', 'clone-b', '--body-out', '--target']);
  assert.strictEqual(parsedFlagValue.bodyOutPath, null, 'Test 6 FAIL: a flag-shaped --body-out value must not be accepted as a path');
  assert.ok(parsedFlagValue.bodyOutError, 'Test 6 FAIL: expected bodyOutError to be set for a flag-shaped value');
  assert.ok(/looks like a flag/.test(parsedFlagValue.bodyOutError), 'Test 6 FAIL: unexpected bodyOutError message');
  const parsedFlagValueEq = parseArgs(['remote-a', 'clone-b', '--body-out=--target']);
  assert.ok(parsedFlagValueEq.bodyOutError, 'Test 6 FAIL: expected bodyOutError for the --body-out=--target form too');
  const parsedMissingValue = parseArgs(['remote-a', 'clone-b', '--body-out']);
  assert.ok(parsedMissingValue.bodyOutError, 'Test 6 FAIL: expected bodyOutError when --body-out has no following value at all');

  // parseMavericksVersion / isPlainNumericVersion
  assert.strictEqual(
    parseMavericksVersion("module.exports = { MAVERICKS_VERSION: '0.39.0' };\n"),
    '0.39.0',
    'Test 6 FAIL: expected to parse MAVERICKS_VERSION'
  );
  assert.strictEqual(parseMavericksVersion('no version here'), null, 'Test 6 FAIL: expected null on unparseable content');
  // security review round 2, judgment call: a comment mentioning the
  // constant BEFORE the real module.exports declaration must not shadow it
  // (.match() returns the leftmost match — a bare search would have failed
  // this).
  assert.strictEqual(
    parseMavericksVersion(
      "// bumped from MAVERICKS_VERSION: '0.38.2' last time\nmodule.exports = { MAVERICKS_VERSION: '0.39.0' };\n"
    ),
    '0.39.0',
    'Test 6 FAIL: a preceding comment mentioning MAVERICKS_VERSION must not shadow the real module.exports value'
  );
  assert.strictEqual(isPlainNumericVersion('0.39.0'), true, 'Test 6 FAIL: 0.39.0 should be plain-numeric');
  assert.strictEqual(isPlainNumericVersion('0.39.0-rc.1'), false, 'Test 6 FAIL: a pre-release suffix must not be plain-numeric (DR-006)');

  // compareVersions
  assert.ok(compareVersions('0.39.0', '0.38.2') > 0, 'Test 6 FAIL: 0.39.0 should compare greater than 0.38.2');
  assert.ok(compareVersions('0.38.2', '0.39.0') < 0, 'Test 6 FAIL: 0.38.2 should compare less than 0.39.0');
  assert.strictEqual(compareVersions('0.39.0', '0.39.0'), 0, 'Test 6 FAIL: equal versions should compare equal');

  // parseChangelogSections / extractReleaseSections / computePreviousStableVersion
  const fixtureChangelog = changelogContent([
    { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' },
    { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- y\n' },
  ]);
  const sections = parseChangelogSections(fixtureChangelog);
  assert.deepStrictEqual(sections.map((s) => s.version), ['Unreleased', '0.39.0', '0.38.2'], 'Test 6 FAIL: unexpected section list');

  // Fence-awareness (security review round 2, judgment call): a heading
  // INSIDE a ```-fenced example block must not be parsed as a real section.
  const fencedChangelog =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
    'Example format:\n```\n## [9.9.9] — 2099-01-01\n```\n\n- real content\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  const fencedSections = parseChangelogSections(fencedChangelog);
  assert.deepStrictEqual(
    fencedSections.map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.2'],
    'Test 6 FAIL: a heading inside a fenced code block must not be parsed as a real section'
  );
  assert.ok(
    fencedSections.find((s) => s.version === '0.39.0').text.includes('9.9.9'),
    'Test 6 FAIL: the fenced example line should still be present as ordinary text inside its real section'
  );

  // security review round 3, LOW-A: a ~~~ (tilde) fence must be recognized
  // exactly like a ``` fence — a heading inside it must not be a real
  // section either.
  const tildeFencedChangelog =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
    'Example format:\n~~~\n## [9.9.9] — 2099-01-01\n~~~\n\n- real content\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  const tildeFencedSections = parseChangelogSections(tildeFencedChangelog);
  assert.deepStrictEqual(
    tildeFencedSections.map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.2'],
    'Test 6 FAIL: a heading inside a ~~~-fenced code block must not be parsed as a real section (LOW-A)'
  );
  assert.deepStrictEqual(
    findUnterminatedFenceLine(tildeFencedChangelog),
    null,
    'Test 6 FAIL: a properly-closed ~~~ fence must not be reported as unterminated'
  );

  // security review round 4, coverage gap: CommonMark type-matching itself
  // had no test — `else if (true)` in place of `else if (fenceChar ===
  // marker)` left the suite green. A ``` fence containing a ~~~ line (and
  // vice versa) must NOT be closed by the mismatched-type line; only a
  // SAME-character, sufficiently-long delimiter closes it.
  const mixedTypeChangelogBacktickOuter =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
    'Mixed fence types:\n```\n~~~\n## [9.9.9] — 2099-01-01\n~~~\n```\n\n- real content\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  assert.strictEqual(
    findUnterminatedFenceLine(mixedTypeChangelogBacktickOuter),
    null,
    "Test 6 FAIL: a ``` fence containing a ~~~ line, properly closed by a later ```, must not be reported as unterminated"
  );
  assert.deepStrictEqual(
    parseChangelogSections(mixedTypeChangelogBacktickOuter).map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.2'],
    "Test 6 FAIL: the 9.9.9 heading inside the ~~~-typed inner line (within a ``` fence) must still not be a real section"
  );
  const mixedTypeChangelogTildeOuter =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
    'Mixed fence types (reversed):\n~~~\n```\n## [8.8.8] — 2088-01-01\n```\n~~~\n\n- real content\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  assert.strictEqual(
    findUnterminatedFenceLine(mixedTypeChangelogTildeOuter),
    null,
    "Test 6 FAIL: a ~~~ fence containing a ``` line, properly closed by a later ~~~, must not be reported as unterminated"
  );
  assert.deepStrictEqual(
    parseChangelogSections(mixedTypeChangelogTildeOuter).map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.2'],
    "Test 6 FAIL: the 8.8.8 heading inside the ```-typed inner line (within a ~~~ fence) must still not be a real section"
  );

  // security review round 3, NEW-1: findUnterminatedFenceLine() — the
  // guard that closes the regression the fence-awareness fix itself
  // introduced.
  assert.strictEqual(
    findUnterminatedFenceLine(fencedChangelog),
    null,
    'Test 6 FAIL: a properly-closed ``` fence must not be reported as unterminated'
  );
  const unterminatedChangelog =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
    'Example usage:\n```sh\necho hello\n\n## [0.40.0] — 2026-08-01\n\n### Added\n\n' +
    '- future work, must not leak\n\n## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  assert.strictEqual(
    findUnterminatedFenceLine(unterminatedChangelog),
    10,
    'Test 6 FAIL: expected the unterminated fence to be reported at its opening line (10)'
  );
  // Prove the exact regression: without the unterminated-fence check,
  // parseChangelogSections() silently swallows the 0.40.0 heading (and its
  // content) into the still-open 0.39.0 section, and findMalformedHeadingLines()
  // does not flag it either (its own `if (inFence) continue` shortcut hides it
  // too) — this is NEW-1's exact failure mode.
  const leakedByUnterminatedFence = parseChangelogSections(unterminatedChangelog);
  // Note: 0.38.2's heading is ALSO swallowed here, not just 0.40.0's — an
  // unterminated fence merges EVERYTHING after it (forever, to EOF) into
  // whichever section was open, which is exactly why this must abort rather
  // than attempt any partial recovery.
  assert.deepStrictEqual(
    leakedByUnterminatedFence.map((s) => s.version),
    ['Unreleased', '0.39.0'],
    'Test 6 FAIL: demonstrating NEW-1 — the 0.40.0 (and 0.38.2) headings should be absent (silently swallowed) from parseChangelogSections() output when the fence is unterminated'
  );
  assert.ok(
    leakedByUnterminatedFence.find((s) => s.version === '0.39.0').text.includes('0.40.0'),
    'Test 6 FAIL: demonstrating NEW-1 — the 0.40.0 heading text should have merged into the 0.39.0 section (this is exactly what findUnterminatedFenceLine() must catch before extraction runs)'
  );
  assert.deepStrictEqual(
    findMalformedHeadingLines(unterminatedChangelog),
    [],
    'Test 6 FAIL: demonstrating NEW-1 — findMalformedHeadingLines() alone does NOT catch the swallowed heading either (both are fence-aware in the same way)'
  );

  // findMalformedHeadingLines (security review round 2, M4): a wrong-level
  // heading (### instead of ##) must be flagged rather than silently merged.
  const cleanChangelog = changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' }]);
  assert.deepStrictEqual(findMalformedHeadingLines(cleanChangelog), [], 'Test 6 FAIL: a clean CHANGELOG should have no malformed headings');
  const malformedChangelog =
    '# Changelog\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n- new stuff\n\n' +
    '### [0.38.2] — 2026-07-20\n\n### Added\n\n- base (WRONG heading LEVEL — should be ##)\n';
  const malformed = findMalformedHeadingLines(malformedChangelog);
  assert.strictEqual(malformed.length, 1, 'Test 6 FAIL: expected exactly one malformed heading to be flagged');
  assert.ok(malformed[0].text.includes('### [0.38.2]'), 'Test 6 FAIL: unexpected malformed heading text');
  // Prove the leak this guards against: without the check, the malformed
  // heading's content silently merges into the PRECEDING (0.39.0) section.
  const leakedSections = parseChangelogSections(malformedChangelog);
  assert.strictEqual(leakedSections.length, 1, 'Test 6 FAIL: demonstrating the leak — malformed heading should NOT open a new section');
  assert.ok(
    leakedSections[0].text.includes('WRONG heading LEVEL'),
    'Test 6 FAIL: demonstrating the leak — the malformed section text should have merged into 0.39.0 (this is exactly what findMalformedHeadingLines() must catch before extraction runs)'
  );

  assert.strictEqual(computePreviousStableVersion(['v0.38.2', 'v0.38.1', 'not-a-version']), '0.38.2', 'Test 6 FAIL: unexpected max stable version');
  assert.strictEqual(computePreviousStableVersion([]), null, 'Test 6 FAIL: expected null when there are no tags at all');

  const extracted = extractReleaseSections(fixtureChangelog, '0.38.2', '0.39.0');
  assert.strictEqual(extracted.length, 1, 'Test 6 FAIL: expected exactly one extracted section');
  assert.strictEqual(extracted[0].version, '0.39.0', 'Test 6 FAIL: expected the 0.39.0 section to be extracted');

  const extractedNoPrevious = extractReleaseSections(fixtureChangelog, null, '0.39.0');
  assert.strictEqual(extractedNoPrevious.length, 2, 'Test 6 FAIL: with no previous tag, both real sections at/below the tagged version should qualify');

  // security review round 2, M1: a section NEWER than the tagged version
  // must be excluded even when it is newer than previousStableVersion too.
  const withFutureSection = changelogContent([
    { version: '0.40.0', date: '2026-08-01', body: '### Added\n\n- future work, not yet tagged\n' },
    { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' },
    { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- y\n' },
  ]);
  const boundedAt390 = extractReleaseSections(withFutureSection, '0.38.2', '0.39.0');
  assert.deepStrictEqual(
    boundedAt390.map((s) => s.version),
    ['0.39.0'],
    'Test 6 FAIL: extractReleaseSections must exclude a CHANGELOG section newer than the tagged version'
  );

  const body = renderReleaseBody(extracted);
  assert.ok(body.includes('## [0.39.0]') && body.endsWith('\n'), 'Test 6 FAIL: unexpected rendered body shape');

  // shQuote (security review round 2, LOW)
  assert.strictEqual(shQuote('/plain/path'), "'/plain/path'", 'Test 6 FAIL: unexpected shQuote output for a plain path');
  assert.strictEqual(
    shQuote("/path with spaces/it's-here.md"),
    "'/path with spaces/it'\\''s-here.md'",
    'Test 6 FAIL: unexpected shQuote escaping for an embedded single quote'
  );
  assert.strictEqual(shQuote('$(rm -rf /)'), "'$(rm -rf /)'", 'Test 6 FAIL: shQuote must neutralize shell metacharacters by quoting, not stripping them');

  console.log('Test 6 passed: pure-function unit checks (parsing, extraction, version comparison, fence-awareness, malformed-heading detection, arg parsing, shQuote) all hold');
}

// ---------------------------------------------------------------------------
// Test 7 — M1: a CHANGELOG section NEWER than the version being tagged must
// NOT leak into the release body (edge tip stamped 0.39.0, but CHANGELOG
// already has a 0.40.0 section from a later, not-yet-stamped commit).
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  // Version file still stamped 0.39.0 (this is the release being cut), but
  // the CHANGELOG already has a 0.40.0 section from a later commit in the
  // same multi-commit wave — the exact scenario M1 was reproduced against.
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.40.0', date: '2026-08-01', body: '### Added\n\n- NEXT release notes, must not leak early\n' },
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- this release only\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge has both 0.39.0 and a premature 0.40.0 section');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const bodyPath = path.join(mkTempDir('mavp-release-body7-'), 'release-body.md');
  execFileSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  const tagSha = git(bareDir, ['rev-parse', 'v0.39.0']).trim();
  assert.ok(tagSha, 'Test 7 FAIL: expected tag v0.39.0 to have been created');

  const body = fs.readFileSync(bodyPath, 'utf8');
  assert.ok(body.includes('## [0.39.0]'), 'Test 7 FAIL: body should contain the [0.39.0] section');
  assert.ok(body.includes('this release only'), 'Test 7 FAIL: body should contain the [0.39.0] section text');
  assert.ok(!body.includes('## [0.40.0]'), 'Test 7 FAIL: body must NOT contain the [0.40.0] section (newer than the tagged version)');
  assert.ok(!body.includes('NEXT release notes'), 'Test 7 FAIL: body must NOT contain the [0.40.0] section text (would leak the next release early)');

  console.log('Test 7 passed: a CHANGELOG section newer than the tagged version is excluded from the release body (M1)');
}

// ---------------------------------------------------------------------------
// Test 8 — M2: when the mirror's main push succeeds but the SUBSEQUENT tag
// push fails, the abort message must truthfully report the partial
// promotion instead of the blanket "no push has occurred" — and must not
// guess an unestablished cause.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  // Pre-receive hook: accept branch pushes, reject every tag push. Proves
  // the exact reviewer-reproduced scenario (main genuinely advances, no tag
  // is created).
  const hookPath = path.join(bareDir, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(
    hookPath,
    '#!/bin/sh\nwhile read oldrev newrev refname; do\n  case "$refname" in\n    refs/tags/*)\n      echo "rejected: no tags allowed" >&2\n      exit 1\n      ;;\n  esac\ndone\nexit 0\n'
  );
  fs.chmodSync(hookPath, 0o755);

  const cloneDir = initWorkingClone();
  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- new stuff\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const edgeSha = git(cloneDir, ['rev-parse', 'edge']).trim();

  const bodyPath = path.join(mkTempDir('mavp-release-body8-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 8 FAIL: expected non-zero exit when the tag push is rejected, got ${result.status}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, edgeSha, 'Test 8 FAIL: mirror main SHOULD have genuinely advanced to the edge tip (main push succeeds; only the tag push is rejected)');

  assert.ok(
    /HAS ALREADY been pushed/.test(result.stderr),
    `Test 8 FAIL: expected a truthful "main HAS ALREADY been pushed" message, got: ${result.stderr}`
  );
  assert.ok(
    result.stderr.includes(edgeSha),
    `Test 8 FAIL: expected the abort message to name the sha main was pushed to, got: ${result.stderr}`
  );
  assert.ok(
    !/no push has occurred/.test(result.stderr),
    `Test 8 FAIL: must NOT print the blanket "no push has occurred" footer once main has genuinely moved, got: ${result.stderr}`
  );
  assert.ok(
    !/concurrent run/.test(result.stderr),
    `Test 8 FAIL: must not speculate an unestablished cause ("concurrent run") — the real cause here is a pre-receive rejection, got: ${result.stderr}`
  );

  const tagList = git(bareDir, ['tag', '-l']).trim();
  assert.strictEqual(tagList, '', 'Test 8 FAIL: no tag should exist on the mirror (the tag push was rejected)');

  console.log('Test 8 passed: a partial promotion (main pushed, tag rejected) is reported truthfully, with no unestablished-cause guess (M2)');
}

// ---------------------------------------------------------------------------
// Test 9 — M3: a STALE local 'edge' branch (behind the mirror's true
// origin/edge tip) must never be promoted — the script must always resolve
// from the freshly-fetched origin/edge, not a same-named local branch.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  // First edge commit (0.39.0 stamped) — this is what cloneDir's LOCAL edge
  // branch will be stuck at.
  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- stale local tip content\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge at 0.39.0 (this will become the STALE local tip)');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  const staleEdgeSha = git(cloneDir, ['rev-parse', 'edge']).trim();
  git(cloneDir, ['checkout', '-q', 'main']);

  // A SEPARATE clone of the SAME bare mirror advances 'edge' further, to
  // 0.39.1 — simulating another operator/process pushing a newer working
  // build. cloneDir's local 'edge' branch is never fetched/merged forward,
  // so it stays at staleEdgeSha while origin/edge (on the mirror) moves on.
  const secondCloneDir = initWorkingClone();
  git(secondCloneDir, ['remote', 'add', 'origin', bareDir]);
  git(secondCloneDir, ['fetch', '-q', 'origin']);
  git(secondCloneDir, ['checkout', '-q', '-b', 'edge', 'origin/edge']);
  writeFile(path.join(secondCloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.1'));
  writeFile(
    path.join(secondCloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.1', date: '2026-07-26', body: '### Fixed\n\n- true current tip content\n' },
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- stale local tip content\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(secondCloneDir, 'fixture: a second clone advances edge to 0.39.1 (the TRUE current tip)');
  git(secondCloneDir, ['push', '-q', 'origin', 'edge']);
  const trueEdgeSha = git(secondCloneDir, ['rev-parse', 'edge']).trim();
  assert.notStrictEqual(staleEdgeSha, trueEdgeSha, 'Test 9 setup FAIL: stale and true edge tips must differ');

  // cloneDir's local 'edge' branch is STILL at staleEdgeSha — never advanced.
  assert.strictEqual(git(cloneDir, ['rev-parse', 'edge']).trim(), staleEdgeSha, 'Test 9 setup FAIL: cloneDir local edge should still be stale before running the script');

  const bodyPath = path.join(mkTempDir('mavp-release-body9-'), 'release-body.md');
  execFileSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  const mirrorMainSha = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(
    mirrorMainSha,
    trueEdgeSha,
    `Test 9 FAIL: mirror main must be promoted to the TRUE current origin/edge tip (${trueEdgeSha}), not the stale local edge branch (${staleEdgeSha})`
  );
  assert.notStrictEqual(mirrorMainSha, staleEdgeSha, 'Test 9 FAIL: mirror main must NOT be promoted to the stale local edge tip');

  const tagSha = git(bareDir, ['rev-parse', 'v0.39.1']).trim();
  assert.strictEqual(tagSha, trueEdgeSha, 'Test 9 FAIL: expected tag v0.39.1 (the true current version) to have been created, not v0.39.0');

  const body = fs.readFileSync(bodyPath, 'utf8');
  assert.ok(body.includes('true current tip content'), 'Test 9 FAIL: body should reflect the TRUE current tip content');

  console.log("Test 9 passed: a stale local 'edge' branch is never promoted — resolution always uses the freshly-fetched origin/edge (M3)");
}

// ---------------------------------------------------------------------------
// Test 10 — M4 mutant coverage: no CHANGELOG section matching the tagged
// version at all is refused.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  // Version file stamped 0.39.0, but the CHANGELOG ritual was skipped: no
  // '## [0.39.0]' section exists anywhere.
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: version bumped to 0.39.0 but CHANGELOG ritual skipped');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, `Test 10 FAIL: expected non-zero exit when no CHANGELOG section matches the tagged version, got ${result.status}`);
  assert.ok(/has no '## \[0\.39\.0\]' section/.test(result.stderr), `Test 10 FAIL: expected the no-matching-section refusal, got: ${result.stderr}`);
  assert.strictEqual(git(bareDir, ['rev-parse', 'main']).trim(), git(cloneDir, ['rev-parse', 'main']).trim(), 'Test 10 FAIL: mirror main must be untouched');

  console.log('Test 10 passed: no CHANGELOG section matching the tagged version is refused (M4 mutant coverage)');
}

// ---------------------------------------------------------------------------
// Test 11 — M4 mutant coverage: a non-numeric (pre-release-suffixed)
// MAVERICKS_VERSION is refused.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0-rc.1'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0-rc.1', date: '2026-07-25', body: '### Added\n\n- x\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge stamped with a forbidden pre-release suffix');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, `Test 11 FAIL: expected non-zero exit on a non-numeric version, got ${result.status}`);
  assert.ok(/not a plain numeric/.test(result.stderr), `Test 11 FAIL: expected the non-numeric-version refusal, got: ${result.stderr}`);
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), '', 'Test 11 FAIL: no tag should have been created');

  console.log('Test 11 passed: a non-numeric (pre-release-suffixed) MAVERICKS_VERSION is refused (M4 mutant coverage)');
}

// ---------------------------------------------------------------------------
// Test 12 — M4 mutant coverage: a dirty working tree in the clone is
// refused.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Dirty the working tree with an uncommitted change.
  writeFile(path.join(cloneDir, 'uncommitted.md'), 'oops\n');

  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, `Test 12 FAIL: expected non-zero exit on a dirty working tree, got ${result.status}`);
  assert.ok(/uncommitted changes/.test(result.stderr), `Test 12 FAIL: expected the dirty-working-tree refusal, got: ${result.stderr}`);
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), '', 'Test 12 FAIL: no tag should have been created');

  console.log('Test 12 passed: a dirty working tree is refused (M4 mutant coverage)');
}

// ---------------------------------------------------------------------------
// Test 13 — M4 mutant coverage: a mirror-remote argument that does not match
// the clone's configured origin is refused (wrong-origin clone).
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const wrongBareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Pass a DIFFERENT mirror-remote (wrongBareDir) than what cloneDir's
  // origin actually points at (bareDir).
  const result = spawnSync('node', [RELEASE_SCRIPT, wrongBareDir, cloneDir], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, `Test 13 FAIL: expected non-zero exit on a wrong-origin clone, got ${result.status}`);
  assert.ok(/does not match the requested/.test(result.stderr), `Test 13 FAIL: expected the wrong-origin refusal, got: ${result.stderr}`);
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), '', 'Test 13 FAIL: no tag should have been created on the real mirror');

  console.log('Test 13 passed: a wrong-origin clone is refused (M4 mutant coverage)');
}

// ---------------------------------------------------------------------------
// Test 14 — NEW-1 (security review round 3): an UNTERMINATED fenced code
// block in the tagged section swallows a later, genuinely newer section
// heading into the currently-open section — main() must refuse rather than
// publish it. Reproduces the reviewer's exact scenario: 0.39.0's section
// contains an unterminated ```sh example, followed by a real `## [0.40.0]`
// section.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  // Raw CHANGELOG content (not the changelogContent() helper — this needs an
  // UNTERMINATED fence, which the helper can't express): 0.39.0's section
  // opens a ```sh example and never closes it before EOF, swallowing the
  // real `## [0.40.0]` heading and its content that follows.
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    '# Changelog\n\n' +
      '## [Unreleased]\n\n' +
      '## [0.39.0] — 2026-07-25\n\n' +
      '### Added\n\n' +
      'Example usage:\n' +
      '```sh\n' +
      'echo hello\n' +
      '\n' +
      '## [0.40.0] — 2026-08-01\n\n' +
      '### Added\n\n' +
      '- future work, must not leak (swallowed by the unterminated fence above)\n\n' +
      '## [0.38.2] — 2026-07-20\n\n' +
      '### Added\n\n' +
      '- base\n'
  );
  commitAll(cloneDir, 'fixture: edge 0.39.0 with an unterminated fenced example');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const preRunMainSha = git(bareDir, ['rev-parse', 'main']).trim();

  const bodyPath = path.join(mkTempDir('mavp-release-body14-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 14 FAIL: expected non-zero exit on an unterminated fence, got ${result.status}`);
  assert.ok(/unterminated fenced code block/.test(result.stderr), `Test 14 FAIL: expected the unterminated-fence refusal, got: ${result.stderr}`);
  assert.ok(/opened at line 10/.test(result.stderr), `Test 14 FAIL: expected the refusal to name the opening line (10), got: ${result.stderr}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, preRunMainSha, 'Test 14 FAIL: mirror main must be untouched after the unterminated-fence refusal');
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), 'v0.38.2', 'Test 14 FAIL: no NEW tag should have been created (only the pre-existing v0.38.2)');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 14 FAIL: no release-body file should have been written on a refused run');

  console.log('Test 14 passed: an unterminated fenced code block is refused rather than silently swallowing a later real section (NEW-1)');
}

// ---------------------------------------------------------------------------
// Test 15 — NEW-2 (security review round 3): the malformed-heading refusal
// itself, exercised end-to-end through main() — round 2's test only proved
// findMalformedHeadingLines()/parseChangelogSections() detect and leak the
// pattern; it never asserted that main() actually refuses. Reproduces a
// `### [0.38.2]` (wrong heading level) placed after a valid `## [0.39.0]`
// section.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  // Raw CHANGELOG content: a wrong-level `### [0.38.2]` heading (three
  // hashes instead of two) after the real 0.39.0 section.
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    '# Changelog\n\n' +
      '## [Unreleased]\n\n' +
      '## [0.39.0] — 2026-07-25\n\n' +
      '### Added\n\n' +
      '- new stuff\n\n' +
      '### [0.38.2] — 2026-07-20\n\n' +
      '### Added\n\n' +
      '- base (WRONG heading level — should be ##, would otherwise merge into 0.39.0)\n'
  );
  commitAll(cloneDir, 'fixture: edge 0.39.0 with a malformed (wrong-level) heading for 0.38.2');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const preRunMainSha = git(bareDir, ['rev-parse', 'main']).trim();

  const bodyPath = path.join(mkTempDir('mavp-release-body15-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 15 FAIL: expected non-zero exit on a malformed (wrong-level) heading, got ${result.status}`);
  assert.ok(/contains 1 heading-shaped line/.test(result.stderr), `Test 15 FAIL: expected the malformed-heading refusal, got: ${result.stderr}`);
  assert.ok(result.stderr.includes('### [0.38.2]'), `Test 15 FAIL: expected the offending heading text to be named, got: ${result.stderr}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, preRunMainSha, 'Test 15 FAIL: mirror main must be untouched after the malformed-heading refusal');
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), 'v0.38.2', 'Test 15 FAIL: no NEW tag should have been created (only the pre-existing v0.38.2)');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 15 FAIL: no release-body file should have been written on a refused run');

  console.log("Test 15 passed: main() genuinely refuses on a malformed (wrong-level) heading, end to end (NEW-2 — the guard round 2's test never actually exercised)");
}

// ---------------------------------------------------------------------------
// Test 16 — LOW-B (security review round 3, optional hardening): a clone
// whose `remote.origin.fetch` refspec has been narrowed to track only
// `main` leaves a STALE local origin/edge after fetchOrigin()'s fetch —
// the mirror's real edge tip has moved on, but the narrowed refspec means
// the fetch silently never updates the local tracking ref for it. The
// cross-check against `git ls-remote origin refs/heads/edge` must catch
// this and refuse, rather than promote the stale tip.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- stale tip content\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge at 0.39.0 (this will become the STALE origin/edge)');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const staleEdgeSha = git(cloneDir, ['rev-parse', 'edge']).trim();

  // Narrow the fetch refspec to 'main' only — cloneDir's fetchOrigin() will
  // still succeed, but will never again update origin/edge.
  git(cloneDir, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);

  // A SEPARATE clone of the same bare mirror advances 'edge' further.
  const secondCloneDir = initWorkingClone();
  git(secondCloneDir, ['remote', 'add', 'origin', bareDir]);
  git(secondCloneDir, ['fetch', '-q', 'origin']);
  git(secondCloneDir, ['checkout', '-q', '-b', 'edge', 'origin/edge']);
  writeFile(path.join(secondCloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.1'));
  writeFile(
    path.join(secondCloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.1', date: '2026-07-26', body: '### Fixed\n\n- true current tip content\n' },
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- stale tip content\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' },
    ])
  );
  commitAll(secondCloneDir, 'fixture: a second clone advances edge to 0.39.1 (the TRUE current tip)');
  git(secondCloneDir, ['push', '-q', 'origin', 'edge']);
  const trueEdgeSha = git(secondCloneDir, ['rev-parse', 'edge']).trim();
  assert.notStrictEqual(staleEdgeSha, trueEdgeSha, 'Test 16 setup FAIL: stale and true edge tips must differ');

  const bodyPath = path.join(mkTempDir('mavp-release-body16-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 16 FAIL: expected non-zero exit on a narrowed-refspec stale origin/edge, got ${result.status}`);
  assert.ok(/does not match the mirror's ACTUAL current 'edge' tip/.test(result.stderr), `Test 16 FAIL: expected the stale-remote-tracking-ref refusal, got: ${result.stderr}`);
  assert.ok(result.stderr.includes(staleEdgeSha), `Test 16 FAIL: expected the stale sha to be named, got: ${result.stderr}`);
  assert.ok(result.stderr.includes(trueEdgeSha), `Test 16 FAIL: expected the true remote sha to be named, got: ${result.stderr}`);

  const mirrorMainSha = git(bareDir, ['rev-parse', 'main']).trim();
  assert.notStrictEqual(mirrorMainSha, staleEdgeSha, 'Test 16 FAIL: mirror main must NOT have been promoted to the stale edge tip');
  assert.notStrictEqual(mirrorMainSha, trueEdgeSha, 'Test 16 FAIL: mirror main must be untouched entirely (refused before any promotion)');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 16 FAIL: no release-body file should have been written on a refused run');

  console.log('Test 16 passed: a narrowed remote.origin.fetch refspec leaving a stale origin/edge is caught by the git ls-remote cross-check (LOW-B)');
}

// ---------------------------------------------------------------------------
// Test 17 — BLOCKER (security review round 4): fence delimiter LENGTH must
// be honored, not just the character. A four-backtick fence containing an
// inner three-backtick example (a realistic documentation shape) must NOT
// be closed by that shorter, same-character inner fence — reopens NEW-1
// through a different door if fence length is ignored.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  // A four-backtick fence opens (line 10) and stays open across a genuinely
  // NEWER `## [0.40.0]` heading (swallowing it into 0.39.0's own text, the
  // exact NEW-1 leak shape) before finally being "closed" by a single
  // SHORTER three-backtick line — which, if length is ignored, falsely
  // closes the four-backtick opener. This is deliberately NOT symmetric
  // (open+close pair of inner delimiters would leave the document
  // unterminated either way, proving nothing) — the single mismatched
  // closer is exactly what lets a length-blind parser resume normal
  // heading parsing afterward, which is what makes 0.40.0's already-merged
  // content escape extractReleaseSections()'s upper bound entirely: it is
  // never a distinct section to filter, it is already inline text inside
  // 0.39.0's own published body.
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    '# Changelog\n\n' +
      '## [Unreleased]\n\n' +
      '## [0.39.0] — 2026-07-25\n\n' +
      '### Added\n\n' +
      'Example usage:\n' +
      '````\n' +
      'echo hello\n' +
      '\n' +
      '## [0.40.0] — 2026-08-01\n\n' +
      '### Added\n\n' +
      '- SECRET UNRELEASED FUTURE WORK, must not leak\n\n' +
      'more content still inside the fence\n' +
      '```\n' +
      '\n' +
      '## [0.38.2] — 2026-07-20\n\n' +
      '### Added\n\n' +
      '- base\n'
  );
  commitAll(cloneDir, 'fixture: edge 0.39.0 with a 4-backtick fence falsely closeable by a later, shorter 3-backtick line');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const preRunMainSha = git(bareDir, ['rev-parse', 'main']).trim();

  const bodyPath = path.join(mkTempDir('mavp-release-body17-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 17 FAIL: expected non-zero exit on a length-mismatched fence, got ${result.status}`);
  assert.ok(/unterminated fenced code block/.test(result.stderr), `Test 17 FAIL: expected the unterminated-fence refusal, got: ${result.stderr}`);
  assert.ok(/opened at line 10/.test(result.stderr), `Test 17 FAIL: expected the refusal to name the opening line (10), got: ${result.stderr}`);

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainShaAfter, preRunMainSha, 'Test 17 FAIL: mirror main must be untouched after the length-mismatched-fence refusal');
  assert.strictEqual(git(bareDir, ['tag', '-l']).trim(), 'v0.38.2', 'Test 17 FAIL: no NEW tag should have been created (only the pre-existing v0.38.2)');
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 17 FAIL: no release-body file should have been written on a refused run');

  console.log('Test 17 passed: a shorter same-character fence does not falsely close a longer opener — fence LENGTH is honored (BLOCKER)');
}

// ---------------------------------------------------------------------------
// Test 18 — LOW (security review round 4): `ls-remote` reporting a ref as
// genuinely ABSENT must abort, not degrade silently like a query failure
// does. Reproduced with NO transient network condition: a narrowed refspec
// (so `--prune` never removes the stale `origin/edge`) plus `edge` deleted
// on the mirror.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0 (soon to be deleted on the mirror)');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);
  const staleEdgeSha = git(cloneDir, ['rev-parse', 'edge']).trim();

  // Narrow the refspec so a later --prune fetch never removes the now-stale
  // origin/edge tracking ref once 'edge' is deleted on the mirror.
  git(cloneDir, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);

  // Delete 'edge' on the actual mirror, from a SEPARATE clone (no transient
  // condition — a deliberate, successful, permanent deletion).
  const secondCloneDir = initWorkingClone();
  git(secondCloneDir, ['remote', 'add', 'origin', bareDir]);
  git(secondCloneDir, ['fetch', '-q', 'origin']);
  git(secondCloneDir, ['push', '-q', 'origin', '--delete', 'edge']);

  const bodyPath = path.join(mkTempDir('mavp-release-body18-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 18 FAIL: expected non-zero exit when the mirror no longer has 'edge' at all, got ${result.status}`);
  assert.ok(/NO SUCH BRANCH/.test(result.stderr), `Test 18 FAIL: expected the ref-absent refusal, got: ${result.stderr}`);
  assert.ok(result.stderr.includes(staleEdgeSha), `Test 18 FAIL: expected the stale locally-resolved sha to be named, got: ${result.stderr}`);

  const mirrorMainSha = git(bareDir, ['rev-parse', 'main']).trim();
  assert.notStrictEqual(mirrorMainSha, staleEdgeSha, "Test 18 FAIL: mirror main must NOT have been promoted to a branch tip the mirror no longer has");
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 18 FAIL: no release-body file should have been written on a refused run');

  console.log("Test 18 passed: git ls-remote reporting 'edge' as genuinely absent aborts rather than degrading silently (LOW)");
}

// ---------------------------------------------------------------------------
// Test 19 — security review round 4, coverage gap: the ls-remote cross-check
// on 'main' specifically (Test 16 only ever covered 'edge' — deleting the
// `assertRemoteTrackingRefIsCurrent(cloneDir, 'main', ...)` call alone would
// have survived the whole suite). Narrows the refspec to 'edge' ONLY (so a
// later fetch never updates origin/main), then advances the mirror's main
// independently (bypassing this tool entirely — e.g. a manual push) so the
// locally-resolved origin/main goes stale while origin/edge stays current.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(path.join(cloneDir, 'CHANGELOG.md'), changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }]));
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['fetch', '-q', 'origin']); // establish baseline origin/main tracking ref
  const staleMainSha = git(cloneDir, ['rev-parse', 'origin/main']).trim();

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- x\n' }, { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base\n' }])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Narrow the refspec to 'edge' ONLY — a later fetch will never touch
  // origin/main again, so it stays pinned at staleMainSha.
  git(cloneDir, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/edge:refs/remotes/origin/edge']);

  // A SEPARATE clone advances the mirror's real 'main' independently
  // (bypassing this tool entirely — e.g. a manual/emergency push).
  const secondCloneDir = initWorkingClone();
  git(secondCloneDir, ['remote', 'add', 'origin', bareDir]);
  git(secondCloneDir, ['fetch', '-q', 'origin']);
  git(secondCloneDir, ['checkout', '-q', 'main']);
  writeFile(path.join(secondCloneDir, 'manual-change.md'), 'bypassed the tool\n');
  git(secondCloneDir, ['add', '-A']);
  git(secondCloneDir, ['commit', '-q', '-m', "fixture: main advanced independently, bypassing this tool"]);
  git(secondCloneDir, ['push', '-q', 'origin', 'main']);
  const trueMainSha = git(secondCloneDir, ['rev-parse', 'main']).trim();
  assert.notStrictEqual(staleMainSha, trueMainSha, 'Test 19 setup FAIL: stale and true main tips must differ');

  const bodyPath = path.join(mkTempDir('mavp-release-body19-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(result.status, 0, `Test 19 FAIL: expected non-zero exit on a stale origin/main, got ${result.status}`);
  assert.ok(
    /origin\/main .* does not match the mirror's ACTUAL current 'main' tip/.test(result.stderr),
    `Test 19 FAIL: expected the main-side stale-remote-tracking-ref refusal, got: ${result.stderr}`
  );
  assert.ok(result.stderr.includes(staleMainSha), `Test 19 FAIL: expected the stale main sha to be named, got: ${result.stderr}`);
  assert.ok(result.stderr.includes(trueMainSha), `Test 19 FAIL: expected the true remote main sha to be named, got: ${result.stderr}`);
  assert.strictEqual(fs.existsSync(bodyPath), false, 'Test 19 FAIL: no release-body file should have been written on a refused run');

  console.log("Test 19 passed: the ls-remote cross-check also fires for a stale origin/main specifically, not just origin/edge (coverage gap)");
}

// ---------------------------------------------------------------------------
// Test 20 — T-518: FENCE_RE caps fence-delimiter indentation at three
// spaces, per CommonMark. A prior version accepted any amount of leading
// whitespace (`\s*`), so a PAIR of 4-or-more-space-indented fence-looking
// lines could bracket a real `## [x.y.z]` version heading between them,
// silently merging that section's content upward into the still-open
// section above it — the last known upward-merge class (the security
// reviewer's differential fuzz measured 8888/47106 fuzzed documents in this
// class, all bounded to already-public content in this project's
// newest-first house style, so this is a correctness fix, not a
// confidentiality one).
// ---------------------------------------------------------------------------
{
  const { parseChangelogSections, findUnterminatedFenceLine } = require('./mavp-publish-release.js');

  // Group 1 — reproduce the upward-merge: a pair of 4-space-indented
  // fence-looking lines bracketing a REAL `## [0.38.5]` heading. Under the
  // OLD `\s*` regex both lines were recognized as fence delimiters, so the
  // heading between them was wrongly marked `inFence` and merged upward
  // into 0.39.0. Under the FIXED `{0,3}` regex neither line is a fence
  // delimiter at all, so 0.38.5 parses as its own section.
  const fourSpaceIndentedFenceChangelog =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n- x\n\n' +
    '    ```\n' +
    '## [0.38.5] — 2026-07-22\n\n### Added\n\n- middle stuff, must not merge upward\n\n' +
    '    ```\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  const fourSpaceSections = parseChangelogSections(fourSpaceIndentedFenceChangelog);
  assert.deepStrictEqual(
    fourSpaceSections.map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.5', '0.38.2'],
    'Test 20 FAIL: a pair of 4-space-indented fence-looking lines must NOT suppress the real 0.38.5 heading between them (T-518)'
  );
  assert.ok(
    !fourSpaceSections.find((s) => s.version === '0.39.0').text.includes('middle stuff'),
    "Test 20 FAIL: 0.38.5's content must not have merged upward into 0.39.0 (T-518 upward-merge class)"
  );
  assert.ok(
    fourSpaceSections.find((s) => s.version === '0.38.5').text.includes('middle stuff'),
    "Test 20 FAIL: 0.38.5's own content should live in its own section, not be swallowed"
  );

  // Group 2 — 0, 1, 2 and 3-space indented fences must still work AS
  // fences: a heading-shaped example line bracketed by them must still be
  // suppressed (not parsed as a real section), exactly as before this fix.
  for (const indent of ['', ' ', '  ', '   ']) {
    const fenced =
      '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n' +
      'Example format:\n' + indent + '```\n## [9.9.9] — 2099-01-01\n' + indent + '```\n\n- real content\n\n' +
      '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
    const sections = parseChangelogSections(fenced);
    assert.deepStrictEqual(
      sections.map((s) => s.version),
      ['Unreleased', '0.39.0', '0.38.2'],
      `Test 20 FAIL: a ${indent.length}-space-indented fence pair must still suppress the inner 9.9.9 heading (T-518)`
    );
    assert.ok(
      sections.find((s) => s.version === '0.39.0').text.includes('9.9.9'),
      `Test 20 FAIL: the ${indent.length}-space-indented fenced example line should still be present as ordinary text inside its real section`
    );
    assert.strictEqual(
      findUnterminatedFenceLine(fenced),
      null,
      `Test 20 FAIL: a properly-closed ${indent.length}-space-indented fence must not be reported as unterminated`
    );
  }

  // Group 3 — tab decision, pinned: a leading TAB is NOT treated as a fence
  // delimiter, the same disqualification as 4+ spaces (see FENCE_RE's
  // comment in mavp-publish-release.js for the CommonMark tab-stop-4
  // rationale). A tab-indented fence-looking pair must NOT suppress a real
  // heading between them, exactly like the 4-space case in Group 1 — and
  // must not be reported as an unterminated fence either, since no fence
  // ever opens in the first place.
  const tabIndentedFenceChangelog =
    '# Changelog\n\n## [Unreleased]\n\n## [0.39.0] — 2026-07-25\n\n### Added\n\n- x\n\n' +
    '\t```\n' +
    '## [0.38.5] — 2026-07-22\n\n### Added\n\n- middle stuff, must not merge upward\n\n' +
    '\t```\n\n' +
    '## [0.38.2] — 2026-07-20\n\n### Added\n\n- base\n';
  const tabSections = parseChangelogSections(tabIndentedFenceChangelog);
  assert.deepStrictEqual(
    tabSections.map((s) => s.version),
    ['Unreleased', '0.39.0', '0.38.5', '0.38.2'],
    'Test 20 FAIL: a tab-indented fence-looking pair must NOT suppress the real 0.38.5 heading between them (T-518 tab decision)'
  );
  assert.strictEqual(
    findUnterminatedFenceLine(tabIndentedFenceChangelog),
    null,
    'Test 20 FAIL: a tab-indented fence-looking line never opens a fence at all, so nothing is ever left unterminated (T-518 tab decision)'
  );

  console.log(
    'Test 20 passed: FENCE_RE caps fence-delimiter indentation at three spaces per CommonMark — ' +
    '4+ spaces and tabs no longer count as delimiters, 0-3 spaces still do (T-518)'
  );
}

// ---------------------------------------------------------------------------
// Test 21 — T-522: a stray LOCAL ANNOTATED tag, reachable from `main` and
// missing on the mirror, must NEVER ride along to the mirror on `pushMain`'s
// `git push ... main`, even when `push.followTags=true` is configured on the
// clone (a common global git setting). Without `--no-follow-tags`, git
// itself — not this script — would push every annotated tag reachable from
// the pushed ref that the remote lacks, bypassing the "tag already exists"
// gate entirely (that gate only ever checks `v<version>`). All three
// conditions in the AC are load-bearing and are proven not to matter when
// varied: annotated (a lightweight stray tag is never auto-followed by
// `--follow-tags`), reachable from main (an unreachable stray tag is never
// considered), and missing on the mirror (already-present tags are never
// re-pushed). This test plants exactly the load-bearing combination.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- release content\n' }])
  );
  commitAll(cloneDir, 'fixture: base commit (this will become the STALE main tip promoted from)');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  // Plant the stray tag AFTER the mirror has already seen this commit as
  // `main` — so it is unambiguously reachable from main, and unambiguously
  // missing on the mirror (it is never pushed anywhere below).
  git(cloneDir, ['tag', '-a', 'stray-local-checkpoint', '-m', 'stray local annotated tag, never meant to ship']);
  const strayTagObjectType = git(cloneDir, ['cat-file', '-t', 'stray-local-checkpoint']).trim();
  assert.strictEqual(
    strayTagObjectType,
    'tag',
    "Test 21 FAIL: fixture setup bug — 'git cat-file -t' must report 'tag' (an actual annotated tag object), " +
      'not a lightweight ref, or this test would prove nothing'
  );

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'NOTES.md'), 'edge advances one commit ahead of main\n');
  commitAll(cloneDir, 'fixture: edge advances one commit ahead of main (nothing else needs to change)');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  // Sanity: the stray tag is genuinely reachable from the post-promotion
  // main tip (edge's ancestor is the tagged base commit) and genuinely
  // absent from the mirror before the run.
  const edgeSha = git(cloneDir, ['rev-parse', 'edge']).trim();
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', 'stray-local-checkpoint', edgeSha], {
    cwd: cloneDir,
  });
  assert.strictEqual(
    isAncestor.status,
    0,
    'Test 21 FAIL: fixture setup bug — the stray tag must be reachable from the post-promotion main/edge tip'
  );
  assert.strictEqual(
    git(bareDir, ['tag', '-l']).trim(),
    '',
    'Test 21 FAIL: fixture setup bug — the mirror must have no tags at all before the run'
  );

  // Configure `push.followTags=true` on the clone ONLY NOW, after all
  // fixture setup pushes are already done — this is the common global git
  // setting the script itself must be safe under. Scoped to this fixture
  // clone's local repo config only; never touches real/global git config.
  git(cloneDir, ['config', 'push.followTags', 'true']);

  const bodyPath = path.join(mkTempDir('mavp-release-body21-'), 'release-body.md');
  execFileSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  const mirrorTags = git(bareDir, ['tag', '-l']).trim().split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(
    mirrorTags,
    ['v0.39.0'],
    `Test 21 FAIL: mirror tag list must contain EXACTLY the release tag v0.39.0 with the stray tag absent ` +
      `(push.followTags=true must never leak a stray annotated tag past --no-follow-tags) — got: ${JSON.stringify(mirrorTags)}`
  );
  assert.ok(
    !mirrorTags.includes('stray-local-checkpoint'),
    'Test 21 FAIL: the stray local annotated tag must NOT have reached the mirror'
  );

  const mirrorMainSha = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(mirrorMainSha, edgeSha, "Test 21 FAIL: mirror 'main' should have been promoted to the edge tip");
  const mirrorRefs = git(bareDir, ['for-each-ref', '--format=%(refname)'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepStrictEqual(
    mirrorRefs,
    ['refs/heads/edge', 'refs/heads/main', 'refs/tags/v0.39.0'],
    `Test 21 FAIL: exactly refs/heads/main, refs/heads/edge, and refs/tags/v0.39.0 should exist on the mirror ` +
      `— no other branch or tag should have been touched — got: ${JSON.stringify(mirrorRefs)}`
  );

  console.log(
    'Test 21 passed: a stray local ANNOTATED tag reachable from main and missing on the mirror does not ride ' +
    'along on pushMain even under push.followTags=true — the mirror ends up with exactly the release tag (T-522)'
  );
}

console.log('\nAll T-502 assertions passed.');

// ---------------------------------------------------------------------------
// Test 22 (T-506, lock wiring) — a live-held lock on <clone-dir> refuses the
// run BEFORE the preflight fetch (this script's first clone-directed git
// operation), proving release.js actually calls acquireLock() at the
// documented point in its sequence, with the mirror's 'main' left
// completely untouched. Dropping the acquireLock call site from release.js's
// main() would make THIS test fail (the run would sail past our planted
// live lock and promote main to the edge tip), which is the wiring
// guarantee this single test exists for — see test-publish-lock.js for the
// lock MODULE's own (much larger) coverage, not duplicated here.
// ---------------------------------------------------------------------------
{
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();

  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.38.2'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([{ version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' }])
  );
  commitAll(cloneDir, 'fixture: base at 0.38.2');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);
  git(cloneDir, ['tag', 'v0.38.2']);
  git(cloneDir, ['push', '-q', 'origin', 'v0.38.2']);

  git(cloneDir, ['checkout', '-q', '-b', 'edge']);
  writeFile(path.join(cloneDir, 'scripts', 'mavp-version.js'), versionFileContent('0.39.0'));
  writeFile(
    path.join(cloneDir, 'CHANGELOG.md'),
    changelogContent([
      { version: '0.39.0', date: '2026-07-25', body: '### Added\n\n- new stuff for the 0.39.0 release\n' },
      { version: '0.38.2', date: '2026-07-20', body: '### Added\n\n- base release content\n' },
    ])
  );
  commitAll(cloneDir, 'fixture: edge bump to 0.39.0');
  git(cloneDir, ['push', '-q', '-u', 'origin', 'edge']);
  git(cloneDir, ['checkout', '-q', 'main']);

  const mirrorMainShaBefore = git(bareDir, ['rev-parse', 'main']).trim();

  const { resolveLockPath, metadataFilePath } = require(path.join(__dirname, 'mavp-publish-lock.js'));
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath);
  // This TEST process's own pid — guaranteed alive for the entire duration
  // of this test, so the CLI run under test contends against a genuinely
  // live holder (same technique as test-publish-lock.js's Test 5).
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

  const bodyPath = path.join(mkTempDir('mavp-release-body22-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], { encoding: 'utf8' });

  assert.notStrictEqual(
    result.status,
    0,
    `Test 22 FAIL: expected non-zero exit when the clone-dir lock is held by a live pid, got ${result.status}:\n${result.stderr}`
  );
  assert.ok(
    (result.stderr || '').includes('publish lock') && (result.stderr || '').includes(`held by pid ${process.pid}`),
    `Test 22 FAIL: expected the refusal to name the lock and holder pid (proving release.js calls acquireLock() ` +
      `before the preflight fetch); got:\n${result.stderr}`
  );
  assert.ok(
    (result.stderr || '').includes('no push has occurred'),
    `Test 22 FAIL: expected the "no push has occurred" footer (the lock refuses before ANY mutation); got:\n${result.stderr}`
  );

  const mirrorMainShaAfter = git(bareDir, ['rev-parse', 'main']).trim();
  assert.strictEqual(
    mirrorMainShaAfter,
    mirrorMainShaBefore,
    "Test 22 FAIL: the mirror's 'main' must be completely untouched when the lock refuses before the preflight fetch"
  );
  const mirrorTags = git(bareDir, ['tag', '-l']).trim().split('\n').filter(Boolean);
  assert.deepStrictEqual(
    mirrorTags,
    ['v0.38.2'],
    `Test 22 FAIL: only the pre-existing fixture tag v0.38.2 should exist — v0.39.0 must NOT have been created ` +
      `when the lock refuses this early; got: ${JSON.stringify(mirrorTags)}`
  );

  fs.rmSync(lockPath, { recursive: true, force: true });

  console.log(
    'Test 22 passed: a live-held lock on <clone-dir> refuses the run before the preflight fetch (release.js calls ' +
      "acquireLock() at the documented point) — mirror 'main' and tags both untouched."
  );
}

// ---------------------------------------------------------------------------
// Test 23 (T-506 round 2, criterion 8) — proves the EXIT-HANDLER cleanup
// actually calls the GUARDED release (lock.release()), never an inline
// fs.rmSync(lockPath, ...): a PATH `git` wrapper intercepts fetchOrigin's
// `git fetch origin --prune --tags` (the first clone-directed operation
// AFTER the lock is acquired) and, from INSIDE the same run, mutates the
// just-written lock metadata to a FOREIGN token before failing the fetch —
// fully deterministic (no multi-process race: the mutation happens
// synchronously within this one process's own call sequence, well after its
// own acquireLock() call already wrote the real metadata). The run then
// aborts via its normal abort() -> process.exit(1) -> 'exit' handler path.
// If the exit handler still did an inline unconditional rmSync, the lock
// directory would be gone regardless of the token; wired to the guarded
// release(), it must survive with the foreign token untouched.
// ---------------------------------------------------------------------------
function makeTokenMutatingGitWrapper(metadataFilePathToMutate, foreignToken) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const shimDir = mkTempDir('mavp-release-t23-bin-');
  fs.writeFileSync(
    path.join(shimDir, 'git'),
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      "const fs = require('node:fs');\n" +
      `const META = ${JSON.stringify(metadataFilePathToMutate)};\n` +
      `const FOREIGN_TOKEN = ${JSON.stringify(foreignToken)};\n` +
      'const args = process.argv.slice(2);\n' +
      "if (args[0] === 'fetch') {\n" +
      '  const data = JSON.parse(fs.readFileSync(META, \'utf8\'));\n' +
      '  data.token = FOREIGN_TOKEN;\n' +
      "  fs.writeFileSync(META, JSON.stringify(data, null, 2));\n" +
      "  process.stderr.write('fixture wrapper: mutated lock token to a foreign value before fetch\\n');\n" +
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
  const bareDir = initBareMirror();
  const cloneDir = initWorkingClone();
  writeFile(path.join(cloneDir, 'README.md'), 'fixture\n');
  commitAll(cloneDir, 'fixture: base commit for T-506 round 2 wiring test');
  git(cloneDir, ['remote', 'add', 'origin', bareDir]);
  git(cloneDir, ['push', '-q', 'origin', 'HEAD:main']);

  const { resolveLockPath, metadataFilePath, readLockMetadata } = require(path.join(__dirname, 'mavp-publish-lock.js'));
  const lockPath = resolveLockPath(cloneDir);
  const metaPath = metadataFilePath(lockPath);
  const foreignToken = 'zzzT506Round2ForeignTokenReleaseWiringTest23';

  const wrapper = makeTokenMutatingGitWrapper(metaPath, foreignToken);
  const bodyPath = path.join(mkTempDir('mavp-release-body23-'), 'release-body.md');
  const result = spawnSync('node', [RELEASE_SCRIPT, bareDir, cloneDir, '--body-out', bodyPath], {
    encoding: 'utf8',
    env: wrapper.env,
  });

  assert.notStrictEqual(
    result.status,
    0,
    `Test 23 FAIL: expected the wrapper-forced fetch failure to abort the run non-zero, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /mutated lock token to a foreign value/.test(result.stderr),
    `Test 23 setup FAIL: expected proof the wrapper actually ran and mutated the token; got stderr:\n${result.stderr}`
  );
  assert.ok(
    fs.existsSync(lockPath),
    'Test 23 FAIL: the lock directory must SURVIVE the exit handler — a foreign token must refuse the guarded release, ' +
      'proving the exit handler calls lock.release() (guarded) rather than an inline fs.rmSync (unconditional)'
  );
  const survivingMeta = readLockMetadata(lockPath);
  assert.ok(
    survivingMeta.ok && survivingMeta.data.token === foreignToken,
    `Test 23 FAIL: the surviving metadata must still carry the FOREIGN token untouched; got: ${JSON.stringify(survivingMeta)}`
  );

  fs.rmSync(lockPath, { recursive: true, force: true });

  console.log(
    "Test 23 passed: release.js's exit handler refuses to remove a lock whose metadata token no longer matches " +
      "this run's own — it calls the GUARDED release(), not an inline fs.rmSync."
  );
}

console.log('\nAll T-506 (release.js lock wiring) assertions passed.');
