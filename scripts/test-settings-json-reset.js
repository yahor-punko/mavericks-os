'use strict';
// Regression test: T-516 — .claude/settings.json must never ship verbatim.
//
// The Claude Code permission layer appends every approved Bash command
// string to `permissions.allow` verbatim as a session runs, so the live,
// on-disk `.claude/settings.json` is effectively an append-only log of
// arbitrary operator commands — it can accumulate private project names,
// absolute home-directory paths, and scratchpad paths (see the T-516 slice
// for the incident this codifies). scripts/publish-manifest.json now routes
// `.claude/settings.json` through the `reset` bucket instead of `ship`, so
// the assembled public tree always gets the sanitized
// templates/SETTINGS_TEMPLATE.json stub rather than whatever has
// accumulated on disk in this repo.
//
// This test proves that routing is what protects the public tree — not
// coincidence. It mirrors the exact per-path logic
// scripts/mavp-publish-assemble.js's main() loop uses (resolveContained +
// copyFile, exported by that module) against a FAKE extraction tree built
// in a temp dir, rather than a real `git archive HEAD` — this lets the test
// inject a deliberately-polluted settings.json fixture without ever
// committing pollution into this repo's real history.
//
// Central assertion (reads scripts/publish-manifest.json straight off disk,
// so it is load-bearing against the manifest's ACTUAL live classification,
// not a hardcoded assumption): assembling a settings.json polluted with an
// `allow` entry containing a private-name-shaped string AND an absolute
// path produces ZERO findings from scripts/mavp-publish-scan.js once routed
// through the manifest's current bucket. If someone reverts the manifest
// entry back to `ship` (the pre-T-516 shape), this same routing logic
// copies the polluted fixture verbatim instead of the sanitized stub, the
// scan finds the planted strings, and the assertion below fails — proving
// the test exercises the real protection rather than merely running code.
//
// Per .claude/rules/scripts.md "Shipped test-fixture secret-string
// discipline": the private-name-shaped string and the absolute path planted
// in the fixture are built via array-join concatenation so no contiguous
// detectable literal appears anywhere in this file's own static text.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');
const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-scan.js');
const REAL_SETTINGS_TEMPLATE = path.join(REPO_ROOT, 'templates', 'SETTINGS_TEMPLATE.json');

const { resolveContained, copyFile } = require('./mavp-publish-assemble.js');

const SETTINGS_DEST = '.claude/settings.json';

// Fictional private-repo-name-shaped fragment (three word parts joined with
// a hyphen at runtime) — a real project name is never used here, and no
// contiguous private-name-shaped literal exists anywhere in this file's own
// text; only the assembled runtime VALUE has that shape.
const PRIVATE_NAME_FRAGMENT = ['acme', '-', 'vault'].join('');
// Absolute home-directory path fragment (built from separate path segments
// at runtime) — same runtime-construction discipline applies here: no
// contiguous absolute-path-shaped literal appears in this file's own text.
const ABS_PATH_FRAGMENT = ['/', 'Users', '/', 'opuser', '/scratchpad/', 'release-gate.log'].join('');

function buildPollutedSettings() {
  // Shaped like a real accumulated settings.json: the framework default
  // defaultMode, plus an `allow` array carrying an approved Bash command
  // string that happens to embed a private-name-shaped argument and an
  // absolute scratchpad path — exactly the T-516 incident shape.
  return (
    JSON.stringify(
      {
        permissions: {
          defaultMode: 'bypassPermissions',
          allow: [
            `Bash(node scripts/mavp-publish-scan.js /tmp/out --private-names ${PRIVATE_NAME_FRAGMENT})`,
            `Bash(cat ${ABS_PATH_FRAGMENT})`,
          ],
        },
      },
      null,
      2
    ) + '\n'
  );
}

const tempDirs = [];
function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanupTempDirs);

// Mirrors the exact per-path routing scripts/mavp-publish-assemble.js's
// main() loop performs for ONE destination path: if the manifest classifies
// destPath under `reset`, copy from its starter template; if under `ship`,
// copy the destPath itself verbatim. Uses the SAME resolveContained/copyFile
// primitives the real script exports (no reimplementation of the copy
// logic), against a fake extraction tree instead of `git archive HEAD`.
function simulateManifestRoutingForOnePath({ extractDir, outDir, destPath, manifest }) {
  const ship = Array.isArray(manifest.ship) ? manifest.ship : [];
  const reset = manifest.reset && typeof manifest.reset === 'object' ? manifest.reset : {};

  const inReset = Object.prototype.hasOwnProperty.call(reset, destPath);
  const inShip = ship.includes(destPath);

  if (inReset) {
    const starterPath = reset[destPath];
    const srcPath = resolveContained(extractDir, starterPath, 'reset starter path');
    const resolvedDestPath = resolveContained(outDir, destPath, 'reset destination path');
    copyFile(srcPath, resolvedDestPath);
    return { bucket: 'reset', starterPath };
  }
  if (inShip) {
    const srcPath = resolveContained(extractDir, destPath, 'ship source path');
    const resolvedDestPath = resolveContained(outDir, destPath, 'ship destination path');
    copyFile(srcPath, resolvedDestPath);
    return { bucket: 'ship' };
  }
  throw new Error(
    `test fixture error: "${destPath}" is classified in neither ship nor reset in the live manifest — ` +
      'manifest may be malformed.'
  );
}

function runScan(dir) {
  return execFileSync(process.execPath, [SCAN_SCRIPT, dir, '--private-names', PRIVATE_NAME_FRAGMENT], {
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// Test 1 (central, load-bearing): a settings.json polluted with a
// private-name-shaped allow entry AND an absolute path produces ZERO
// findings once routed through the manifest's LIVE classification.
// ---------------------------------------------------------------------------
{
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const extractDir = mkTempDir('mavp-settings-reset-extract-');
  const outDir = mkTempDir('mavp-settings-reset-out-');

  fs.mkdirSync(path.join(extractDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(extractDir, SETTINGS_DEST), buildPollutedSettings());
  fs.mkdirSync(path.join(extractDir, 'templates'), { recursive: true });
  fs.copyFileSync(REAL_SETTINGS_TEMPLATE, path.join(extractDir, 'templates', 'SETTINGS_TEMPLATE.json'));

  const routing = simulateManifestRoutingForOnePath({ extractDir, outDir, destPath: SETTINGS_DEST, manifest });

  const scanOutput = runScan(outDir);
  assert.ok(
    /zero findings/.test(scanOutput),
    `Test 1 FAIL: expected zero findings from the assembled tree (manifest bucket: ${routing.bucket}), got:\n${scanOutput}`
  );
  console.log(
    `Test 1 passed: a settings.json polluted with a private-name + absolute-path allow entry produces ` +
      `ZERO findings once assembled through the manifest's "${routing.bucket}" route for ${SETTINGS_DEST}`
  );

  // ---------------------------------------------------------------------------
  // Test 2: the shipped stub itself is a valid, usable settings file — only
  // meaningful when the live manifest currently chose the reset route (the
  // AC's required shape); skipped harmlessly if a future change legitimately
  // moves this to exclude instead (in which case Test 1 already covers the
  // "zero findings" requirement via an absent file).
  // ---------------------------------------------------------------------------
  if (routing.bucket === 'reset') {
    const shippedRaw = fs.readFileSync(path.join(outDir, SETTINGS_DEST), 'utf8');
    const shipped = JSON.parse(shippedRaw);
    assert.strictEqual(
      shipped.permissions && shipped.permissions.defaultMode,
      'bypassPermissions',
      'Test 2 FAIL: shipped settings.json stub is missing permissions.defaultMode — not a valid, usable settings file'
    );
    assert.strictEqual(
      shipped.permissions.allow,
      undefined,
      'Test 2 FAIL: shipped settings.json stub unexpectedly carries an allow entry'
    );
    assert.strictEqual(
      shipped.permissions.deny,
      undefined,
      'Test 2 FAIL: shipped settings.json stub unexpectedly carries a deny entry'
    );
    assert.ok(
      !shippedRaw.includes(PRIVATE_NAME_FRAGMENT) && !shippedRaw.includes(ABS_PATH_FRAGMENT),
      'Test 2 FAIL: shipped settings.json stub still contains the planted private-name or absolute-path fragment'
    );
    console.log('Test 2 passed: the shipped stub is a valid settings file (defaultMode only, no allow/deny) with no pollution carried over');
  } else {
    console.log(`Test 2 skipped: manifest currently routes ${SETTINGS_DEST} through "${routing.bucket}", not "reset"`);
  }
}

console.log('\nAll T-516 settings-json-reset assertions passed.');
