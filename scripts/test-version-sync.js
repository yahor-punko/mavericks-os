'use strict';
// Regression test: T-375 — package.json "version" must stay in sync with
// MAVERICKS_VERSION in scripts/mavp-version.js. Drift here means release
// tooling and package.json disagree about which version is shipping.

const assert = require('node:assert');

const pkg = require('../package.json');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

assert.strictEqual(
  pkg.version,
  MAVERICKS_VERSION,
  `Version drift: package.json version "${pkg.version}" does not match ` +
  `MAVERICKS_VERSION "${MAVERICKS_VERSION}" in scripts/mavp-version.js. ` +
  `Bump one to match the other.`
);

console.log(`test-version-sync passed: package.json version (${pkg.version}) matches MAVERICKS_VERSION (${MAVERICKS_VERSION})`);
