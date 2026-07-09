'use strict';
// Regression test: T-261 — mavp-skill-reflect.js loads install lib, not project lib
// Guards that the script uses require('./mavp-operator-lib') and that loading
// the install lib via its absolute path returns real exports even when
// MAVERICKS_PROJECT_ROOT points at a sentinel-lib directory.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

const TMP_DIR = path.join(os.tmpdir(), 't261-test-' + Date.now());
const SENTINEL_SCRIPTS_DIR = path.join(TMP_DIR, 'scripts');
fs.mkdirSync(SENTINEL_SCRIPTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Build a sentinel lib that would expose __SENTINEL_STALE_LIB__ if loaded
// ---------------------------------------------------------------------------
const SENTINEL_LIB_PATH = path.join(SENTINEL_SCRIPTS_DIR, 'mavp-operator-lib.js');
fs.writeFileSync(
  SENTINEL_LIB_PATH,
  "'use strict';\nmodule.exports = { __SENTINEL_STALE_LIB__: true };\n",
  'utf8'
);

// Point MAVERICKS_PROJECT_ROOT at the sentinel dir so that any ROOT-based
// require(path.join(ROOT, 'scripts', 'mavp-operator-lib.js')) would load the
// sentinel stale lib instead of the real install lib.
process.env.MAVERICKS_PROJECT_ROOT = TMP_DIR;

// ---------------------------------------------------------------------------
// Assertion 1: loading install lib via absolute install path ignores ROOT env
// The fixed script does: require('./mavp-operator-lib') from __dirname (scripts/).
// We simulate the same contract: require the lib via its absolute install path.
// ---------------------------------------------------------------------------
const installLibPath = path.join(__dirname, 'mavp-operator-lib.js');
const lib = require(installLibPath);

assert.strictEqual(
  lib.__SENTINEL_STALE_LIB__,
  undefined,
  'Assertion 1a FAIL: install lib must NOT have __SENTINEL_STALE_LIB__ property'
);

assert.strictEqual(
  typeof lib.extractTrajectories,
  'function',
  'Assertion 1b FAIL: install lib must export extractTrajectories as a function'
);

assert.strictEqual(
  typeof lib.writeTrajectories,
  'function',
  'Assertion 1c FAIL: install lib must export writeTrajectories as a function'
);

assert.strictEqual(
  typeof lib.scoreTrajectory,
  'function',
  'Assertion 1d FAIL: install lib must export scoreTrajectory as a function'
);

// ---------------------------------------------------------------------------
// Assertion 2: string-level check on mavp-skill-reflect.js source
// The fixed script must use the relative require (T-260 fix) and must NOT
// use the old ROOT-based path pattern.
// ---------------------------------------------------------------------------
const reflectSrc = fs.readFileSync(
  path.join(__dirname, 'mavp-skill-reflect.js'),
  'utf8'
);

assert.ok(
  reflectSrc.includes("require('./mavp-operator-lib')"),
  "Assertion 2a FAIL: mavp-skill-reflect.js must contain require('./mavp-operator-lib')"
);

assert.ok(
  !reflectSrc.includes("require(path.join(ROOT, 'scripts', 'mavp-operator-lib"),
  "Assertion 2b FAIL: mavp-skill-reflect.js must NOT contain the old ROOT-based require path"
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-261 assertions passed.');
