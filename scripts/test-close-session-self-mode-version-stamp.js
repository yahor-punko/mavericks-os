'use strict';
// Regression/feature test: T-660 — --close-session stamps
// PROCESS_STATE.json's mavericks_version to the current framework version
// during its existing PROCESS_STATE.json write (updateProcessStateJson()),
// strictly gated to SELF-MODE — the resolved project root (ROOT)
// realpath-equals the framework installation root that scripts/
// mavp-version.js lives in.
//
// Nothing else refreshes mavericks_version after a version bump in the
// framework's own repo, so a lagging value falsely prints an
// update-available notice at every session start (this had to be
// hand-synced across two consecutive waves before this fix). The tier-
// correct fix is a write at the close-session ritual's EXISTING
// PROCESS_STATE.json write point, not a new one — this test asserts that
// write, not a bespoke code path.
//
// Two mutants named in T-660's acceptance criteria, each with its own part:
//   Part 1 (self-mode)   — kills the "never stamps" mutant: a self-mode
//                           fixture with a LAGGING mavericks_version must
//                           read the fixture's own current framework
//                           version after close.
//   Part 2 (adopter-mode, value present)   — kills the "stamps everywhere"
//                           mutant: an adopter-shaped fixture (distinct
//                           project root vs. framework root) must leave a
//                           PRE-EXISTING mavericks_version byte-unchanged.
//   Part 3 (adopter-mode, value absent)    — the same mutant's sharper
//                           edge case: an adopter fixture that never set
//                           mavericks_version at all must still have NO
//                           such key after close — not null, not "".
//
// "Self-mode" fixture construction: mavp-operator-lib.js, mavp-validator.js
// and check-changelog-frozen.js are never synced into an adopter project —
// close-session.js always resolves them via MAVERICKS_SCRIPTS (see
// resolveMavericksScriptsDir()'s doc comment in
// mavp-operator-close-session.js) — so a fixture can legitimately BE the
// framework installation for the purposes of this test by symlinking those
// three files (none of which requires any OTHER sibling script — verified
// by inspection of their own `require()` lists) into a fixture scripts/
// directory, then dropping in a REAL (non-symlinked) mavp-version.js with a
// known literal version string. Setting MAVERICKS_PROJECT_ROOT to the
// fixture root and MAVERICKS_SCRIPTS to that same fixture's scripts/
// directory makes ROOT and the resolved framework root the exact same
// string — self-mode, deterministically, with no dependence on the real
// checkout's actual current version.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const REAL_SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(REAL_SCRIPTS_DIR, 'mavp-operator-close-session.js');

const TMP_ROOT = path.join(os.tmpdir(), 't660-test-' + Date.now());
fs.mkdirSync(TMP_ROOT, { recursive: true });

function newFixtureDir(label) {
  const dir = path.join(TMP_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SELF_MODE_FIXTURE_VERSION = '9.9.9-t660-selfmode-fixture';
const ADOPTER_LOCAL_VERSION_FILE_VALUE = '8.8.8-t660-adopter-local-legacy-copy';

/**
 * Drop a REAL (non-symlinked) scripts/mavp-version.js into an adopter
 * fixture root, distinct from both SELF_MODE_FIXTURE_VERSION and whatever
 * this checkout's actual current version happens to be. This models the
 * "legacy project with a local mavp-operator-lib.js/mavp-version.js copy"
 * case resolveMavericksScriptsDir()'s own doc comment names as candidate
 * (b) — without it, readCurrentMavericksVersion() (which deliberately reads
 * from ROOT, not MAVERICKS_SCRIPTS_DIR — see its doc comment in
 * mavp-operator-close-session.js) would find no file at all in a bare
 * adopter fixture, return null, and the "stamps everywhere" mutant would
 * pass for the wrong reason (skipped by readCurrentMavericksVersion()'s own
 * null-guard, never reaching the SELF_MODE gate this test exists to check).
 * With this file present, an unguarded stamp is directly observable: it
 * would overwrite mavericks_version with this exact literal.
 */
function setupAdopterLocalVersionFile(dir) {
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${ADOPTER_LOCAL_VERSION_FILE_VALUE}' };\n`,
    'utf8'
  );
}

/**
 * Turn `dir` into a self-mode fixture: a scripts/ subdirectory carrying
 * symlinks to the real mavp-operator-lib.js / mavp-validator.js /
 * check-changelog-frozen.js (none of which require any sibling script, so a
 * symlink alone is sufficient — no transitive copying needed), plus a real,
 * non-symlinked mavp-version.js with a fixed, fixture-only version literal.
 * Returns the fixture's scripts/ absolute path (the value to pass as
 * MAVERICKS_SCRIPTS so ROOT === dirname(MAVERICKS_SCRIPTS) === dir).
 */
function setupSelfModeScriptsDir(dir) {
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const f of ['mavp-operator-lib.js', 'mavp-validator.js', 'check-changelog-frozen.js']) {
    fs.symlinkSync(path.join(REAL_SCRIPTS_DIR, f), path.join(scriptsDir, f));
  }
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${SELF_MODE_FIXTURE_VERSION}' };\n`,
    'utf8'
  );
  return scriptsDir;
}

function runCloseSession(dir, mavericksScriptsDir) {
  const r = spawnSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: mavericksScriptsDir },
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
}

function readRawState(dir) {
  return fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8');
}

function writeProcessState(dir, overrides) {
  const state = {
    initiative: 'T-660 test fixture',
    stage: 'execution',
    wave: 5,
    wave_session: 3,
    wave_status: 'planning',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 900,
    last_updated: '2026-08-01',
    deploy_contours: 0,
    wave_summary: 'Wave 4: prior wave.',
    rechecks: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** A single in_progress task — holds the wave open, exercising the common
 * mid-wave close path (updateProcessStateJson still runs on every close,
 * mid-wave or wave-complete — see T-648's wave-goal-scope test for the same
 * discriminator). Using mid-wave (rather than wave-complete) also sidesteps
 * having to answer the interactive wave-goal/push prompts irrelevant here.
 */
function buildFixture(dir, processStateOverrides) {
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-900 — Fixture task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** artifact: fixture
- **Notes:** —

## Recently completed tasks
`, 'utf8');

  writeProcessState(dir, processStateOverrides);
}

// ---------------------------------------------------------------------------
// Part 1 — self-mode fixture, LAGGING preset mavericks_version. Kills the
// "never stamps" mutant: without the SELF_MODE-gated write in
// updateProcessStateJson(), mavericks_version would still read the stale
// preset value after close instead of the fixture's own current framework
// version.
// ---------------------------------------------------------------------------
const selfModeDir = newFixtureDir('self-mode');
const selfModeScriptsDir = setupSelfModeScriptsDir(selfModeDir);
buildFixture(selfModeDir, { mavericks_version: '0.1.0-lagging' });

const selfModeResult = runCloseSession(selfModeDir, selfModeScriptsDir);
assert.strictEqual(
  selfModeResult.status, 0,
  `Part 1 FAIL: expected close-session to exit 0 in the self-mode fixture, got ${selfModeResult.status}. Output:\n${selfModeResult.out}`
);

const selfModeState = readState(selfModeDir);
assert.strictEqual(
  selfModeState.mavericks_version,
  SELF_MODE_FIXTURE_VERSION,
  `Part 1 FAIL: expected mavericks_version stamped to the fixture's current framework version "${SELF_MODE_FIXTURE_VERSION}" after a self-mode close, got ${JSON.stringify(selfModeState.mavericks_version)}. This is the "never stamps" mutant.`
);

console.log(`Part 1 (self-mode close stamps mavericks_version to "${SELF_MODE_FIXTURE_VERSION}", killing the never-stamps mutant) passed.`);

// ---------------------------------------------------------------------------
// Part 2 — adopter-shaped fixture (distinct project root vs. the resolved
// framework root — MAVERICKS_SCRIPTS points at THIS repo's real scripts/
// directory, whose parent is NOT the fixture dir), PRESET mavericks_version.
// Kills the "stamps everywhere" mutant: byte-unchanged means still exactly
// the preset value, never overwritten with whatever this checkout's real
// current version happens to be.
// ---------------------------------------------------------------------------
const adopterPresentDir = newFixtureDir('adopter-present');
buildFixture(adopterPresentDir, { mavericks_version: 'adopter-installed-1.2.3' });
setupAdopterLocalVersionFile(adopterPresentDir);
const adopterPresentBefore = readRawState(adopterPresentDir);

const adopterPresentResult = runCloseSession(adopterPresentDir, REAL_SCRIPTS_DIR);
assert.strictEqual(
  adopterPresentResult.status, 0,
  `Part 2 FAIL: expected close-session to exit 0 in the adopter fixture, got ${adopterPresentResult.status}. Output:\n${adopterPresentResult.out}`
);

const adopterPresentState = readState(adopterPresentDir);
assert.strictEqual(
  adopterPresentState.mavericks_version,
  'adopter-installed-1.2.3',
  `Part 2 FAIL: expected mavericks_version to stay BYTE-UNCHANGED ("adopter-installed-1.2.3") in adopter mode, got ${JSON.stringify(adopterPresentState.mavericks_version)}. This is the "stamps everywhere" mutant.`
);
assert.notStrictEqual(
  adopterPresentState.mavericks_version,
  SELF_MODE_FIXTURE_VERSION,
  'Part 2 FAIL: adopter fixture must never pick up the self-mode fixture version string (cross-contamination between fixtures).'
);
assert.notStrictEqual(
  adopterPresentState.mavericks_version,
  ADOPTER_LOCAL_VERSION_FILE_VALUE,
  `Part 2 FAIL: adopter fixture must never pick up its own local (legacy-copy-shaped) scripts/mavp-version.js value "${ADOPTER_LOCAL_VERSION_FILE_VALUE}" either — this is the concrete, directly observable shape of the "stamps everywhere" mutant.`
);

console.log('Part 2 (adopter-mode close leaves a preset mavericks_version byte-unchanged) passed.');

// ---------------------------------------------------------------------------
// Part 3 — adopter-shaped fixture with NO mavericks_version key at all
// (typical: most adopter projects never had one stamped). Byte-unchanged
// means "still absent", not "present and null/empty" — a subtly different
// failure mode than Part 2's "overwritten with a different string".
// ---------------------------------------------------------------------------
const adopterAbsentDir = newFixtureDir('adopter-absent');
buildFixture(adopterAbsentDir, {}); // no mavericks_version override — key absent
setupAdopterLocalVersionFile(adopterAbsentDir);
assert.ok(
  !Object.prototype.hasOwnProperty.call(readState(adopterAbsentDir), 'mavericks_version'),
  'Part 3 setup FAIL: fixture must not carry a mavericks_version key before close.'
);

const adopterAbsentResult = runCloseSession(adopterAbsentDir, REAL_SCRIPTS_DIR);
assert.strictEqual(
  adopterAbsentResult.status, 0,
  `Part 3 FAIL: expected close-session to exit 0 in the adopter-absent fixture, got ${adopterAbsentResult.status}. Output:\n${adopterAbsentResult.out}`
);

const adopterAbsentState = readState(adopterAbsentDir);
assert.ok(
  !Object.prototype.hasOwnProperty.call(adopterAbsentState, 'mavericks_version'),
  `Part 3 FAIL: expected mavericks_version to remain ABSENT (not null/empty) after an adopter-mode close, got key present with value ${JSON.stringify(adopterAbsentState.mavericks_version)}.`
);

console.log('Part 3 (adopter-mode close on a fixture with no mavericks_version key at all leaves it absent, not null/empty) passed.');

console.log('\nAll T-660 self-mode mavericks_version stamp assertions passed.');
