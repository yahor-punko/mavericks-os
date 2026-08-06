'use strict';
// Regression test: T-600 — commit-time private-name backstop
// (scripts/mavp-private-names-guard.js).
//
// Builds fresh git-repo fixtures under os.tmpdir() for every scenario —
// NEVER touches the real repo. Each fixture gets a fresh COPY of the real
// guard script AND its dependency (scripts/mavp-publish-scan.js), so the
// guard's hardcoded `REPO_ROOT = path.resolve(__dirname, '..')` convention
// resolves against the fixture root, not this repo (same pattern already
// used by scripts/test-manifest-guard.js for mavp-manifest-guard.js).
//
// Each fixture wires a minimal pre-commit hook (mirroring the single
// stanza this task adds to .claude/hooks/pre-commit — see that file) via
// `git config core.hooksPath`, so every assertion below exercises the real
// `git commit` code path, not just a direct script invocation.
//
// Covers the four acceptance-criteria assertions verbatim from BACKLOG.md:
//   1. names file + a staged ship-classified file with a matching
//      identifier in CONTENTS -> git commit is blocked, output names the
//      finding (file, line, category).
//   2. names source absent -> the identical commit proceeds (inert).
//   3. a staged ship file whose NAME embeds the fake prefix (clean
//      content) -> git commit is blocked — kills the contents-only mutant,
//      proves the T-601 scanEntryPath dependency is actually exercised.
//   4. (this file itself) every detectable string is constructed at
//      runtime, never a literal substring in this file's text.
//
// Plus two scope-boundary regression checks:
//   5. an UNSTAGED matching file must never block the commit — scope is
//      STAGED files only.
//   6. a matching identifier in a NON-ship-classified staged file must
//      never block the commit — scope is ship-classified staged files only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const REAL_ROOT = path.resolve(__dirname, '..');
const GUARD_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-private-names-guard.js');
const SCAN_SCRIPT_SRC = path.join(REAL_ROOT, 'scripts', 'mavp-publish-scan.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't600-private-names-guard-'));

// Constructed at RUNTIME (concatenation) — never a literal substring in
// this file's own text, per the shipped-test-fixture secret-string rule
// (.claude/rules/scripts.md) and the adversarial-fixture rule it cites. A
// trailing "-" makes it a prefix match per buildPrivateNameRegexes'
// documented prefix-form rule (see mavp-publish-scan.js).
const FAKE_PREFIX = ['zzzfake', 'corp', '-'].join('');
const FAKE_SEGMENT = ['internal', '-widget'].join('');
const FAKE_IDENTIFIER = `${FAKE_PREFIX}${FAKE_SEGMENT}`;

function initGitRepo(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.copyFileSync(GUARD_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-private-names-guard.js'));
  fs.copyFileSync(SCAN_SCRIPT_SRC, path.join(root, 'scripts', 'mavp-publish-scan.js'));
}

function writeManifest(root, ship) {
  fs.writeFileSync(
    path.join(root, 'scripts', 'publish-manifest.json'),
    JSON.stringify({ ship, exclude: {} }, null, 2),
    'utf8'
  );
}

// Minimal pre-commit hook mirroring the single stanza this task adds to
// .claude/hooks/pre-commit — deliberately NOT the full real hook (which
// also runs the validator/manifest/changelog backstops, none relevant
// here and each dependent on files this fixture does not carry).
function wireHook(root) {
  const hooksDir = path.join(root, '.githooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(
    hookPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ -f "scripts/mavp-private-names-guard.js" ]]; then',
      '  GUARD_EXIT=0',
      '  node scripts/mavp-private-names-guard.js || GUARD_EXIT=$?',
      '  if [[ $GUARD_EXIT -ne 0 ]]; then',
      '    exit 1',
      '  fi',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(hookPath, 0o755);
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
}

function gitAdd(root, files) {
  execFileSync('git', ['add', ...files], { cwd: root });
}

function initialCommit(root) {
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

function commit(root, message) {
  return spawnSync('git', ['commit', '-q', '-m', message], { cwd: root, encoding: 'utf8' });
}

function writeNamesFile(root, raw) {
  fs.mkdirSync(path.join(root, '.mavp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mavp', 'private-names'), raw, 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture builder shared by tests 1, 2, 3, 5, 6 — a canonical-shaped repo
// with README.md and a docs/ directory both ship-classified, hook wired,
// and an initial clean commit already made.
// ---------------------------------------------------------------------------
function makeFixture(name) {
  const root = path.join(TMP_DIR, name);
  initGitRepo(root);
  writeManifest(root, ['README.md', 'docs']);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'hello world\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', '.keep'), '', 'utf8');
  wireHook(root);
  gitAdd(root, [
    'scripts/mavp-private-names-guard.js',
    'scripts/mavp-publish-scan.js',
    'scripts/publish-manifest.json',
    'README.md',
    'docs/.keep',
  ]);
  initialCommit(root);
  return root;
}

// ---------------------------------------------------------------------------
// Test 1: names file present + a staged ship-classified file (README.md)
// with the fake identifier in its CONTENTS -> git commit is blocked, output
// names the finding (file, line, category).
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test1-content-block');
  writeNamesFile(root, `${FAKE_PREFIX}\n`);
  fs.writeFileSync(path.join(root, 'README.md'), `hello world\nsee ${FAKE_IDENTIFIER} for details\n`, 'utf8');
  gitAdd(root, ['README.md']);

  const result = commit(root, 'test 1 content leak');

  assert.notStrictEqual(result.status, 0, `Test 1 FAIL: expected commit to be BLOCKED, got exit ${result.status}`);
  const out = `${result.stdout}${result.stderr}`;
  assert.ok(out.includes('README.md:2'), `Test 1 FAIL: expected finding to name "README.md:2", got:\n${out}`);
  assert.ok(out.includes('[Private repo name]'), `Test 1 FAIL: expected "[Private repo name]" category, got:\n${out}`);
  console.log('Test 1 passed: staged ship file with a private-name match in CONTENTS blocks the commit and names file/line/category');
}

// ---------------------------------------------------------------------------
// Test 2: identical commit, but with the names source ABSENT -> proceeds
// (inert) — no names file, no MAVP_PRIVATE_NAMES env var.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test2-inert-without-names');
  // Deliberately no writeNamesFile() call — .mavp/private-names never created.
  fs.writeFileSync(path.join(root, 'README.md'), `hello world\nsee ${FAKE_IDENTIFIER} for details\n`, 'utf8');
  gitAdd(root, ['README.md']);

  const result = commit(root, 'test 2 identical commit, no names source');

  assert.strictEqual(
    result.status,
    0,
    `Test 2 FAIL: expected commit to PROCEED (inert, no names source), got exit ${result.status}:\n${result.stdout}${result.stderr}`
  );
  console.log('Test 2 passed: with names source absent, the identical commit proceeds (guard is inert)');
}

// ---------------------------------------------------------------------------
// Test 3: names file present + a staged ship file whose NAME embeds the
// fake prefix (CLEAN content) -> git commit is blocked via the path scan.
// Kills the contents-only mutant; proves scanEntryPath (T-601) is wired in.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test3-path-block');
  writeNamesFile(root, `${FAKE_PREFIX}\n`);
  const leakyName = `${FAKE_IDENTIFIER}-report.txt`;
  fs.writeFileSync(path.join(root, 'docs', leakyName), 'nothing sensitive in here\n', 'utf8');
  gitAdd(root, [`docs/${leakyName}`]);

  const result = commit(root, 'test 3 path leak, clean content');

  assert.notStrictEqual(
    result.status,
    0,
    `Test 3 FAIL: expected commit to be BLOCKED (path-only leak), got exit ${result.status}`
  );
  const out = `${result.stdout}${result.stderr}`;
  assert.ok(
    out.includes(`docs/${leakyName}`) && out.includes('(file path)'),
    `Test 3 FAIL: expected the finding to name "docs/${leakyName}" with the "(file path)" marker, got:\n${out}`
  );
  assert.ok(out.includes('[Private repo name]'), `Test 3 FAIL: expected "[Private repo name]" category, got:\n${out}`);
  console.log(
    'Test 3 passed: a staged ship file whose NAME embeds the fake prefix (clean content) blocks the commit via path scanning'
  );
}

// ---------------------------------------------------------------------------
// Test 4: MAVP_PRIVATE_NAMES env-var fallback also blocks, when no
// .mavp/private-names file exists — proves resolvePrivateNames()'s
// documented fallback path is actually wired through.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test4-env-fallback');
  fs.writeFileSync(path.join(root, 'README.md'), `hello world\nsee ${FAKE_IDENTIFIER} for details\n`, 'utf8');
  gitAdd(root, ['README.md']);

  const result = spawnSync('git', ['commit', '-q', '-m', 'test 4 env fallback'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MAVP_PRIVATE_NAMES: FAKE_PREFIX },
  });

  assert.notStrictEqual(
    result.status,
    0,
    `Test 4 FAIL: expected commit to be BLOCKED via MAVP_PRIVATE_NAMES env fallback, got exit ${result.status}`
  );
  console.log('Test 4 passed: MAVP_PRIVATE_NAMES env-var fallback blocks the commit when no names file exists');
}

// ---------------------------------------------------------------------------
// Test 5: an UNSTAGED file containing the fake identifier must never block
// the commit — scope is STAGED files only.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test5-unstaged-not-scanned');
  writeNamesFile(root, `${FAKE_PREFIX}\n`);
  // Modify README.md's working-tree copy WITHOUT staging it.
  fs.writeFileSync(path.join(root, 'README.md'), `hello world\nsee ${FAKE_IDENTIFIER} for details\n`, 'utf8');
  // Stage and commit an UNRELATED change instead.
  fs.writeFileSync(path.join(root, 'docs', '.keep'), 'unrelated change\n', 'utf8');
  gitAdd(root, ['docs/.keep']);

  const result = commit(root, 'test 5 unrelated staged change, unstaged leak elsewhere');

  assert.strictEqual(
    result.status,
    0,
    `Test 5 FAIL: expected commit to PROCEED (leak is unstaged), got exit ${result.status}:\n${result.stdout}${result.stderr}`
  );
  console.log('Test 5 passed: an unstaged file with a matching identifier never blocks an unrelated commit');
}

// ---------------------------------------------------------------------------
// Test 6: a matching identifier in a staged file that is NOT ship-
// classified (not in the manifest's `ship` list) must never block the
// commit.
// ---------------------------------------------------------------------------
{
  const root = makeFixture('test6-non-ship-not-scanned');
  writeNamesFile(root, `${FAKE_PREFIX}\n`);
  fs.writeFileSync(path.join(root, 'internal-notes.txt'), `see ${FAKE_IDENTIFIER} for details\n`, 'utf8');
  gitAdd(root, ['internal-notes.txt']);

  const result = commit(root, 'test 6 non-ship staged file with matching identifier');

  assert.strictEqual(
    result.status,
    0,
    `Test 6 FAIL: expected commit to PROCEED (file is not ship-classified), got exit ${result.status}:\n${result.stdout}${result.stderr}`
  );
  console.log('Test 6 passed: a matching identifier in a non-ship-classified staged file never blocks the commit');
}

console.log('\nAll T-600 private-names-guard assertions passed.');
