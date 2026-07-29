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
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-517 assertions passed.');
