'use strict';
// Unit test: T-433 — --check-sync warns on ~/.mavericks version drift vs canonical

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readMaverticksVersion, checkHomeMavericksDrift } = require('./mavp-operator-check-sync.js');

function makeFixtureRoot(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-check-sync-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  if (version !== null) {
    fs.writeFileSync(
      path.join(dir, 'scripts', 'mavp-version.js'),
      `module.exports = { MAVERICKS_VERSION: '${version}' };\n`
    );
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Test 1: readMaverticksVersion reads a valid version file ---
{
  const root = makeFixtureRoot('0.33.0');
  try {
    const version = readMaverticksVersion(root);
    assert.strictEqual(version, '0.33.0', 'Test 1 FAIL: expected version 0.33.0');
    console.log('Test 1 passed: readMaverticksVersion reads a valid version file');
  } finally {
    cleanup(root);
  }
}

// --- Test 2: readMaverticksVersion returns null when version file is missing ---
{
  const root = makeFixtureRoot(null);
  try {
    const version = readMaverticksVersion(root);
    assert.strictEqual(version, null, 'Test 2 FAIL: expected null for missing version file');
    console.log('Test 2 passed: readMaverticksVersion returns null when version file is missing');
  } finally {
    cleanup(root);
  }
}

// --- Test 3: readMaverticksVersion returns null for a nonexistent root ---
{
  const version = readMaverticksVersion('/definitely/does/not/exist/mavericks');
  assert.strictEqual(version, null, 'Test 3 FAIL: expected null for nonexistent root');
  console.log('Test 3 passed: readMaverticksVersion returns null for a nonexistent root');
}

// --- Test 4: checkHomeMavericksDrift detects drift when versions differ ---
{
  const canonicalRoot = makeFixtureRoot('0.33.0');
  const homeRoot = makeFixtureRoot('0.32.2');
  try {
    const result = checkHomeMavericksDrift(canonicalRoot, homeRoot);
    assert.ok(result, 'Test 4 FAIL: expected a drift result');
    assert.strictEqual(result.homeVersion, '0.32.2', 'Test 4 FAIL: wrong homeVersion');
    assert.strictEqual(result.canonicalVersion, '0.33.0', 'Test 4 FAIL: wrong canonicalVersion');
    assert.strictEqual(result.homePath, homeRoot, 'Test 4 FAIL: wrong homePath');
    console.log('Test 4 passed: checkHomeMavericksDrift detects drift when versions differ');
  } finally {
    cleanup(canonicalRoot);
    cleanup(homeRoot);
  }
}

// --- Test 5: checkHomeMavericksDrift returns null when versions match ---
{
  const canonicalRoot = makeFixtureRoot('0.33.0');
  const homeRoot = makeFixtureRoot('0.33.0');
  try {
    const result = checkHomeMavericksDrift(canonicalRoot, homeRoot);
    assert.strictEqual(result, null, 'Test 5 FAIL: expected null when versions match');
    console.log('Test 5 passed: checkHomeMavericksDrift returns null when versions match');
  } finally {
    cleanup(canonicalRoot);
    cleanup(homeRoot);
  }
}

// --- Test 6: checkHomeMavericksDrift returns null when home checkout does not exist ---
{
  const canonicalRoot = makeFixtureRoot('0.33.0');
  try {
    const result = checkHomeMavericksDrift(canonicalRoot, '/definitely/does/not/exist/.mavericks');
    assert.strictEqual(result, null, 'Test 6 FAIL: expected null when home checkout does not exist');
    console.log('Test 6 passed: checkHomeMavericksDrift returns null when home checkout does not exist');
  } finally {
    cleanup(canonicalRoot);
  }
}

// --- Test 7: checkHomeMavericksDrift returns null when home version file is unreadable ---
{
  const canonicalRoot = makeFixtureRoot('0.33.0');
  const homeRoot = makeFixtureRoot(null); // dir exists, but no scripts/mavp-version.js
  try {
    const result = checkHomeMavericksDrift(canonicalRoot, homeRoot);
    assert.strictEqual(result, null, 'Test 7 FAIL: expected null when home version file is unreadable');
    console.log('Test 7 passed: checkHomeMavericksDrift returns null when home version file is unreadable');
  } finally {
    cleanup(canonicalRoot);
    cleanup(homeRoot);
  }
}

console.log('\nAll T-433 assertions passed.');
