'use strict';
// Regression test: T-517 — check-changelog-frozen.js read the PRIVATE
// canonical repo's tags instead of the mirror clone's whenever GIT_DIR was
// set in the ambient environment (as git sets it for every process it
// invokes, and as a nested/wrapped git invocation can leave set for a
// subprocess) — because GIT_DIR TAKES PRECEDENCE OVER `-C`.
//
// Covers:
//   1. mirrorGitEnv() strips exactly GIT_REPO_ENV_KEYS (GIT_DIR,
//      GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
//      GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_PREFIX) from a
//      copy of process.env, leaving every other key untouched.
//   2. End-to-end, with GIT_DIR set the way a hook would set it (pointing
//      at a PRIVATE repo's .git while the guard's cwd/REPO_ROOT IS that
//      private repo — the real production shape): a version tagged ONLY in
//      the private repo must NOT be reported frozen (no block) — the FALSE
//      FREEZE direction.
//   3. Same shape, the more dangerous direction: a version tagged on the
//      MIRROR but NOT in the private repo MUST still be reported frozen
//      (blocked) — the FALSE PERMIT direction, where an unfixed guard
//      would silently let an edit to an already-published section through.
//
// T-604 adds:
//   4. Freeze-at-or-below-highest-tag rule, not exact-tag-only: with mirror
//      tags topping at a fake v9.2.0, a staged addition inside a section
//      with NO exact tag of its own (9.1.0, below the highest tag) is
//      still blocked and named — kills the exact-tag-only mutant.
//   5. Same fixture, a staged addition inside a strictly-NEWER section
//      (9.3.0, above the highest tag) is NOT blocked — kills the
//      freeze-everything mutant.
//   6. Segment-wise numeric comparison, not lexicographic: with mirror tags
//      topping at a fake v0.10.0, a staged addition inside `## [0.9.0]` is
//      blocked — a string comparator would rank "0.9.0" above "0.10.0" and
//      wrongly leave it editable.
//   7. The existing degrade-silently posture is unchanged by the T-604
//      version-comparison rewrite: no mirror clone resolvable, and a
//      resolved path that isn't a git repo, both still exit 0 with no
//      block message.
//
// T-666 adds a SECOND, INDEPENDENT check — staged CHANGELOG.md heading vs
// the canonical version files (scripts/mavp-version.js), not the mirror:
//   8. A staged `## [9.9.9]` heading with version files declaring `9.8.0`
//      blocks the commit, naming both versions (kills never-fires).
//   9. Same fixture, plus a staged version-file bump to `9.9.9` in the same
//      commit — exits 0 (kills ignores-staged-version-file; proves the
//      legitimate bump commit is never obstructed).
//   10. An entry-only edit added UNDER an EXISTING section (no new heading
//       line staged) — exits 0 (kills fires-on-non-heading-edits).
// These fixtures never set a resolvable MAVERICKS_HOME mirror, so Check A
// (T-604) is a guaranteed no-op in tests 8-10 and only Check B (T-666) is
// exercised.
//
// Fixtures are real throwaway git repos built under os.tmpdir(); the guard
// script itself is copied fresh from this checkout's scripts/ directory
// into each fixture's own scripts/ subdirectory on every run, so REPO_ROOT
// (computed by the guard as `path.resolve(__dirname, '..')`) resolves to
// the fixture repo, and the test always exercises whatever code is
// currently checked in — reverting the fix under test makes assertion 3
// fail for real (see the developer's evidence for the recorded revert/
// restore run; not re-run automatically here since it requires editing the
// shipped source file mid-test-suite, which run-tests.js's serial-execution
// contract does not support safely).
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const GUARD_SOURCE = path.join(SCRIPTS_DIR, 'check-changelog-frozen.js');

const { mirrorGitEnv, GIT_REPO_ENV_KEYS } = require('./check-changelog-frozen.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't517-changelog-frozen-'));

function git(root, cmd) {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Builds a throwaway git repo at TMP_DIR/name, initialized with a
// CHANGELOG.md carrying an `## [Unreleased]` section and one more section
// (`sectionVersion`) as its LAST section (so an appended line always lands
// inside it, regardless of file length). Returns the repo root.
function makeChangelogFixture(name, sectionVersion) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  const changelog =
    '# CHANGELOG\n\n' +
    '## [Unreleased]\n\n' +
    '- nothing yet\n\n' +
    `## [${sectionVersion}]\n\n` +
    '- initial entry\n';
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog, 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');
  return root;
}

// Copies the guard script (fresh, from this checkout) into
// <root>/scripts/check-changelog-frozen.js, so the guard's own
// `path.resolve(__dirname, '..')` REPO_ROOT computation resolves to `root`.
function installGuardInto(root) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(GUARD_SOURCE, path.join(scriptsDir, 'check-changelog-frozen.js'));
  return path.join(scriptsDir, 'check-changelog-frozen.js');
}

// Runs the guard (no --if-canonical, so it always enforces) with GIT_DIR
// set to `privateRoot`'s own .git — exactly the shape a hook invocation (or
// any nested git call inheriting an outer GIT_DIR) leaves in the child
// environment — and MAVERICKS_HOME pointed at `mirrorRoot`. cwd is
// `privateRoot`, matching the guard's own REPO_ROOT.
function runGuard(privateRoot, mirrorRoot) {
  const guardPath = installGuardInto(privateRoot);
  const env = Object.assign({}, process.env, {
    GIT_DIR: path.join(privateRoot, '.git'),
    MAVERICKS_HOME: mirrorRoot,
  });
  // Ensure no other ambient GIT_* var leaks in from this test process itself.
  for (const key of GIT_REPO_ENV_KEYS) {
    if (key !== 'GIT_DIR') delete env[key];
  }
  return spawnSync(process.execPath, [guardPath], { cwd: privateRoot, encoding: 'utf8', env });
}

// ---------------------------------------------------------------------------
// Test 1: mirrorGitEnv() strips exactly GIT_REPO_ENV_KEYS, nothing else.
// ---------------------------------------------------------------------------
{
  const savedValues = {};
  for (const key of GIT_REPO_ENV_KEYS) {
    savedValues[key] = process.env[key];
    process.env[key] = `test-value-${key}`;
  }
  process.env.T517_UNRELATED_MARKER = 'should-survive';

  const cleaned = mirrorGitEnv();

  try {
    for (const key of GIT_REPO_ENV_KEYS) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(cleaned, key),
        false,
        `Test 1 FAIL: expected ${key} to be deleted from mirrorGitEnv() output`
      );
    }
    assert.strictEqual(
      cleaned.T517_UNRELATED_MARKER,
      'should-survive',
      'Test 1 FAIL: mirrorGitEnv() must not touch unrelated env keys'
    );
  } finally {
    for (const key of GIT_REPO_ENV_KEYS) {
      if (savedValues[key] === undefined) delete process.env[key];
      else process.env[key] = savedValues[key];
    }
    delete process.env.T517_UNRELATED_MARKER;
  }

  console.log('Test 1 passed: mirrorGitEnv() deletes exactly GIT_REPO_ENV_KEYS and preserves every other env key');
}

// ---------------------------------------------------------------------------
// Test 2 (FALSE FREEZE direction): version tagged ONLY in the private repo
// -> the guard must NOT report it frozen (no block), because the tag lookup
// must hit the MIRROR, not the private repo GIT_DIR happens to point at.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeChangelogFixture('t2-private', '1.2.3');
  git(privateRoot, 'tag v1.2.3'); // tagged ONLY in the private repo

  const mirrorRoot = makeChangelogFixture('t2-mirror', '1.2.3');
  git(mirrorRoot, 'tag v0.0.1'); // mirror has A tag, just never v1.2.3

  // Stage an edit into the [1.2.3] section (the LAST section -> append at EOF).
  fs.appendFileSync(path.join(privateRoot, 'CHANGELOG.md'), '- newly staged line for T-517 test 2\n');
  git(privateRoot, 'add -A');

  const result = runGuard(privateRoot, mirrorRoot);
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(
    result.status,
    0,
    `Test 2 FAIL (FALSE FREEZE): expected exit 0 (not frozen) since the mirror has no v1.2.3 tag, got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    !output.includes('COMMIT BLOCKED'),
    `Test 2 FAIL (FALSE FREEZE): expected no block message, got:\n${output}`
  );

  console.log('Test 2 passed: a version tagged ONLY in the private repo is NOT reported frozen (GIT_DIR set as a hook would set it)');
}

// ---------------------------------------------------------------------------
// Test 3 (FALSE PERMIT direction — the dangerous one): version tagged on the
// MIRROR but NOT in the private repo -> the guard MUST still report it
// frozen (block). An unfixed guard would read the private repo's tags
// (via the GIT_DIR override) instead of the mirror's, find no matching tag,
// and silently let the edit to an already-published section through.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeChangelogFixture('t3-private', '9.9.9');
  // Deliberately do NOT tag the private repo with v9.9.9.

  const mirrorRoot = makeChangelogFixture('t3-mirror', '9.9.9');
  git(mirrorRoot, 'tag v9.9.9'); // tagged ONLY on the mirror

  fs.appendFileSync(path.join(privateRoot, 'CHANGELOG.md'), '- newly staged line for T-517 test 3\n');
  git(privateRoot, 'add -A');

  const result = runGuard(privateRoot, mirrorRoot);
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(
    result.status,
    1,
    `Test 3 FAIL (FALSE PERMIT): expected exit 1 (BLOCKED) since the mirror has tag v9.9.9, got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    output.includes('COMMIT BLOCKED') && output.includes('9.9.9'),
    `Test 3 FAIL (FALSE PERMIT): expected a block message naming 9.9.9, got:\n${output}`
  );

  console.log('Test 3 passed: a version tagged on the MIRROR but absent from the private repo IS still reported frozen (blocks) — the dangerous direction is covered');
}

// ---------------------------------------------------------------------------
// T-604 fixtures: freeze-at-or-below-highest-mirror-tag rule.
// ---------------------------------------------------------------------------

// Builds a throwaway git repo at TMP_DIR/name with an `## [Unreleased]`
// section followed by one `## [version]` section per entry in `versions`,
// in the given order (caller controls ordering — real CHANGELOG.md lists
// newest first, but this rule must not depend on section order).
function makeMultiSectionFixture(name, versions) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  let changelog = '# CHANGELOG\n\n## [Unreleased]\n\n- nothing yet\n\n';
  for (const v of versions) {
    changelog += `## [${v}]\n\n- initial entry for ${v}\n\n`;
  }
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog, 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');
  return root;
}

// Builds a throwaway git repo at TMP_DIR/name carrying exactly the given
// tag names (no CHANGELOG.md needed — this fixture only ever serves as a
// MAVERICKS_HOME mirror clone, and the guard only reads its tags).
function makeTaggedMirrorFixture(name, tags) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');
  fs.writeFileSync(path.join(root, 'README.md'), 'mirror fixture\n', 'utf8');
  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');
  for (const t of tags) git(root, `tag ${t}`);
  return root;
}

// Inserts a new bullet line immediately after `## [version]`'s heading
// blank line, so the addition lands inside that section regardless of
// whether the section is last in the file.
function appendLineToSection(root, version, line) {
  const filePath = path.join(root, 'CHANGELOG.md');
  const content = fs.readFileSync(filePath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`(## \\[${escaped}\\]\\n\\n)`);
  const updated = content.replace(headingRe, `$1${line}\n`);
  if (updated === content) {
    throw new Error(`fixture setup error: section [${version}] heading not found`);
  }
  fs.writeFileSync(filePath, updated, 'utf8');
}

// Runs the guard with no ambient GIT_* override (unlike runGuard() above,
// which deliberately exercises the T-517 GIT_DIR-hardening shape) — these
// T-604 fixtures are testing the version-comparison rule itself, not the
// GIT_DIR precedence hardening.
function runGuardPlain(privateRoot, mirrorRoot) {
  const guardPath = installGuardInto(privateRoot);
  const env = Object.assign({}, process.env, { MAVERICKS_HOME: mirrorRoot });
  for (const key of GIT_REPO_ENV_KEYS) delete env[key];
  return spawnSync(process.execPath, [guardPath], { cwd: privateRoot, encoding: 'utf8', env });
}

// ---------------------------------------------------------------------------
// Test 4: exact-tag-only mutant killer. Mirror tags top out at v9.2.0 (no
// v9.1.0 tag exists anywhere). A staged addition inside `## [9.1.0]` must
// still be blocked and named, because 9.1.0 is AT-OR-BELOW the highest
// stable mirror tag (9.2.0) even though its own exact tag was never cut.
// ---------------------------------------------------------------------------
{
  const mirrorRoot = makeTaggedMirrorFixture('t604-mirror-1', ['v9.0.0', 'v9.2.0']);
  const privateRoot = makeMultiSectionFixture('t604-private-1', ['9.3.0', '9.1.0']);
  appendLineToSection(privateRoot, '9.1.0', '- newly staged line for T-604 test 4 (9.1.0)');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, mirrorRoot);
  const output = (result.stdout || '') + (result.stderr || '');

  assert.notStrictEqual(
    result.status,
    0,
    `Test 4 FAIL (exact-tag-only mutant): expected non-zero exit since 9.1.0 is at-or-below the highest mirror tag (9.2.0), got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    output.includes('9.1.0'),
    `Test 4 FAIL (exact-tag-only mutant): expected the block message to name 9.1.0, got:\n${output}`
  );

  console.log('Test 4 passed: a section below the highest mirror tag is blocked even with no exact tag of its own (kills the exact-tag-only mutant)');
}

// ---------------------------------------------------------------------------
// Test 5: freeze-everything mutant killer. Same fixture shape as Test 4 —
// a staged addition inside `## [9.3.0]` (strictly ABOVE the highest mirror
// tag, 9.2.0) must NOT be blocked.
// ---------------------------------------------------------------------------
{
  const mirrorRoot = makeTaggedMirrorFixture('t604-mirror-2', ['v9.0.0', 'v9.2.0']);
  const privateRoot = makeMultiSectionFixture('t604-private-2', ['9.3.0', '9.1.0']);
  appendLineToSection(privateRoot, '9.3.0', '- newly staged line for T-604 test 5 (9.3.0)');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, mirrorRoot);
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(
    result.status,
    0,
    `Test 5 FAIL (freeze-everything mutant): expected exit 0 since 9.3.0 is strictly above the highest mirror tag (9.2.0), got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    !output.includes('COMMIT BLOCKED'),
    `Test 5 FAIL (freeze-everything mutant): expected no block message, got:\n${output}`
  );

  console.log('Test 5 passed: a strictly-newer section stays editable (kills the freeze-everything mutant)');
}

// ---------------------------------------------------------------------------
// Test 6: string/lexicographic-comparator mutant killer. Mirror tags top
// out at v0.10.0. A staged addition inside `## [0.9.0]` must be blocked —
// a lexicographic ("0.9.0" > "0.10.0") comparator would wrongly call this
// section newer than the highest tag and leave it editable.
// ---------------------------------------------------------------------------
{
  const mirrorRoot = makeTaggedMirrorFixture('t604-mirror-3', ['v0.9.0', 'v0.10.0']);
  const privateRoot = makeMultiSectionFixture('t604-private-3', ['0.10.0', '0.9.0']);
  appendLineToSection(privateRoot, '0.9.0', '- newly staged line for T-604 test 6 (0.9.0)');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, mirrorRoot);
  const output = (result.stdout || '') + (result.stderr || '');

  assert.notStrictEqual(
    result.status,
    0,
    `Test 6 FAIL (string-comparator mutant): expected non-zero exit since 0.9.0 is segment-wise at-or-below 0.10.0, got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    output.includes('0.9.0'),
    `Test 6 FAIL (string-comparator mutant): expected the block message to name 0.9.0, got:\n${output}`
  );

  console.log('Test 6 passed: 0.9.0 is correctly ranked below 0.10.0 by segment-wise numeric comparison (kills the lexicographic-comparator mutant)');
}

// ---------------------------------------------------------------------------
// Test 7: degrade-silently posture is unchanged by the T-604 rewrite.
// (a) No mirror clone resolvable (MAVERICKS_HOME points at a path that
//     doesn't exist) -> exit 0, no block message.
// (b) The resolved MAVERICKS_HOME path exists but is not a git repo ->
//     exit 0, no block message.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeMultiSectionFixture('t604-private-degrade', ['9.1.0']);
  appendLineToSection(privateRoot, '9.1.0', '- newly staged line for T-604 test 7');
  git(privateRoot, 'add -A');

  // (a) MAVERICKS_HOME does not exist on disk at all.
  const missingMirror = path.join(TMP_DIR, 't604-mirror-does-not-exist');
  const resultA = runGuardPlain(privateRoot, missingMirror);
  const outputA = (resultA.stdout || '') + (resultA.stderr || '');
  assert.strictEqual(
    resultA.status,
    0,
    `Test 7a FAIL (no mirror resolvable): expected exit 0, got ${resultA.status}. Output:\n${outputA}`
  );
  assert.strictEqual(
    outputA.trim(),
    '',
    `Test 7a FAIL (no mirror resolvable): expected no output at all, got:\n${outputA}`
  );

  // (b) MAVERICKS_HOME exists but is not a git repo (plain directory).
  const notAGitRepo = path.join(TMP_DIR, 't604-mirror-not-a-repo');
  fs.mkdirSync(notAGitRepo, { recursive: true });
  fs.writeFileSync(path.join(notAGitRepo, 'somefile.txt'), 'not a git repo\n', 'utf8');
  const resultB = runGuardPlain(privateRoot, notAGitRepo);
  const outputB = (resultB.stdout || '') + (resultB.stderr || '');
  assert.strictEqual(
    resultB.status,
    0,
    `Test 7b FAIL (mirror path not a git repo): expected exit 0, got ${resultB.status}. Output:\n${outputB}`
  );
  assert.strictEqual(
    outputB.trim(),
    '',
    `Test 7b FAIL (mirror path not a git repo): expected no output at all, got:\n${outputB}`
  );

  console.log('Test 7 passed: degrade-silently posture (no mirror resolvable / not a git repo) is unchanged — exit 0, no output');
}

// ---------------------------------------------------------------------------
// T-666 fixtures: staged CHANGELOG heading vs. canonical version files.
// ---------------------------------------------------------------------------

// Builds a throwaway git repo at TMP_DIR/name with a CHANGELOG.md
// (Unreleased + one dated section per `changelogVersions`, in order) AND a
// scripts/mavp-version.js declaring `versionFileVersion` — the fixture
// shape needed to exercise the T-666 check independently of Check A/T-604
// (no mirror tags are ever configured for these fixtures).
function makeVersionFileFixture(name, changelogVersions, versionFileVersion) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init -q');
  git(root, 'config user.email demo@example.invalid');
  git(root, 'config user.name "Test Fixture"');

  let changelog = '# CHANGELOG\n\n## [Unreleased]\n\n- nothing yet\n\n';
  for (const v of changelogVersions) {
    changelog += `## [${v}]\n\n- initial entry for ${v}\n\n`;
  }
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog, 'utf8');

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${versionFileVersion}' };\n`,
    'utf8'
  );

  git(root, 'add -A');
  git(root, 'commit -q -m "initial commit"');
  return root;
}

// Inserts a brand-new `## [version]` section (heading + one bullet)
// immediately after the `## [Unreleased]` block — a genuinely NEW heading
// line, distinct from appendLineToSection() above (which adds a bullet
// UNDER an EXISTING heading and never introduces a new heading line).
function insertNewSection(root, version, bulletText) {
  const filePath = path.join(root, 'CHANGELOG.md');
  const content = fs.readFileSync(filePath, 'utf8');
  const marker = '## [Unreleased]\n\n- nothing yet\n\n';
  const idx = content.indexOf(marker);
  if (idx === -1) throw new Error('fixture setup error: Unreleased marker not found');
  const insertion = `## [${version}]\n\n${bulletText}\n\n`;
  const updated = content.slice(0, idx + marker.length) + insertion + content.slice(idx + marker.length);
  fs.writeFileSync(filePath, updated, 'utf8');
}

// Overwrites the fixture's scripts/mavp-version.js with a new declared
// version — the working-tree half of "stage the matching version-file
// bump"; caller still needs `git add -A` to actually stage it.
function bumpVersionFile(root, newVersion) {
  fs.writeFileSync(
    path.join(root, 'scripts', 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${newVersion}' };\n`,
    'utf8'
  );
}

// A MAVERICKS_HOME that never resolves — guarantees Check A (T-604) is a
// no-op in every T-666 fixture below, so only Check B (T-666) is exercised.
function noMirror(label) {
  return path.join(TMP_DIR, `t666-no-mirror-${label}`);
}

// ---------------------------------------------------------------------------
// Test 8: never-fires mutant killer. Staged `## [9.9.9]` heading with
// version files declaring `9.8.0` -> blocks the commit, naming both.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeVersionFileFixture('t666-private-8', ['9.5.0'], '9.8.0');
  insertNewSection(privateRoot, '9.9.9', '- newly opened section for T-666 test 8');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, noMirror('8'));
  const output = (result.stdout || '') + (result.stderr || '');

  assert.notStrictEqual(
    result.status,
    0,
    `Test 8 FAIL (never-fires mutant): expected non-zero exit since 9.9.9 is strictly ahead of the version files (9.8.0), got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    output.includes('9.9.9'),
    `Test 8 FAIL (never-fires mutant): expected the block message to name the staged heading version 9.9.9, got:\n${output}`
  );
  assert.ok(
    output.includes('9.8.0'),
    `Test 8 FAIL (never-fires mutant): expected the block message to name the version-files version 9.8.0, got:\n${output}`
  );

  console.log('Test 8 passed: a staged CHANGELOG heading strictly ahead of the version files blocks the commit, naming both versions (kills never-fires)');
}

// ---------------------------------------------------------------------------
// Test 9: ignores-staged-version-file mutant killer. Same fixture as Test
// 8, plus the SAME commit stages a version-file bump to 9.9.9 -> exits 0.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeVersionFileFixture('t666-private-9', ['9.5.0'], '9.8.0');
  insertNewSection(privateRoot, '9.9.9', '- newly opened section for T-666 test 9');
  bumpVersionFile(privateRoot, '9.9.9');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, noMirror('9'));
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(
    result.status,
    0,
    `Test 9 FAIL (ignores-staged-version-file mutant): expected exit 0 since the version file is staged to bump to 9.9.9 in the same commit, got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    !output.includes('COMMIT BLOCKED'),
    `Test 9 FAIL (ignores-staged-version-file mutant): expected no block message, got:\n${output}`
  );

  console.log('Test 9 passed: staging the matching version-file bump alongside the new section passes — the legitimate bump commit is never obstructed (kills ignores-staged-version-file)');
}

// ---------------------------------------------------------------------------
// Test 10: fires-on-non-heading-edits mutant killer. An entry-only edit
// added UNDER an EXISTING section (no new heading line staged at all) ->
// exits 0, even though the section's version (9.5.0) sits below the
// version files' version (9.8.0) — irrelevant here, since no heading was
// opened.
// ---------------------------------------------------------------------------
{
  const privateRoot = makeVersionFileFixture('t666-private-10', ['9.5.0'], '9.8.0');
  appendLineToSection(privateRoot, '9.5.0', '- an ordinary changelog entry for T-666 test 10');
  git(privateRoot, 'add -A');

  const result = runGuardPlain(privateRoot, noMirror('10'));
  const output = (result.stdout || '') + (result.stderr || '');

  assert.strictEqual(
    result.status,
    0,
    `Test 10 FAIL (fires-on-non-heading-edits mutant): expected exit 0 for an entry-only edit under an existing section, got ${result.status}. Output:\n${output}`
  );
  assert.ok(
    !output.includes('COMMIT BLOCKED'),
    `Test 10 FAIL (fires-on-non-heading-edits mutant): expected no block message, got:\n${output}`
  );

  console.log('Test 10 passed: an entry-only edit under an EXISTING section never fires the new-heading-vs-version-files check (kills fires-on-non-heading-edits)');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-517/T-604/T-666 assertions passed.');
