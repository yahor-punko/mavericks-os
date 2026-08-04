'use strict';
// Regression test: T-601 — mavp-publish-scan.js entry-path detection.
//
// Before T-601, every detection category ran against file CONTENTS
// (scanFile) and symlink TARGET strings (scanSymlinkTarget), but never
// against an entry's own tree-relative PATH string. A ship-classified file
// whose NAME embeds a private repo name would therefore publish undetected
// even though its bytes were perfectly clean. T-601 adds scanEntryPath (and
// wires it into main()'s per-entry loop) to close that gap.
//
// Exercises the CLI (mavp-publish-scan.js as a subprocess) against small
// fixture trees, mirroring the existing test-publish-scan.js pattern — the
// literal detectable string below (a fake private repo name) is constructed
// ONLY at runtime via string concatenation, never as a literal substring in
// this file's own text, per the shipped-test-fixture secret-string rule
// (.claude/rules/scripts.md) and the adversarial-fixture rule it cites.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCAN_SCRIPT = path.join(__dirname, 'mavp-publish-scan.js');

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

function runScan(dir, extraArgs = []) {
  return spawnSync(process.execPath, [SCAN_SCRIPT, dir, ...extraArgs], { encoding: 'utf8' });
}

// Constructed at RUNTIME (concatenation) — never a literal substring in this
// file's text. A trailing "-" makes it a prefix match per buildPrivateName-
// Regexes' documented prefix-form rule (see mavp-publish-scan.js).
const FAKE_PRIVATE_PREFIX = ['acme', '-'].join('');
const FAKE_PRIVATE_NAME_SEGMENT = ['internal', '-widget'].join('');
const FAKE_FILENAME = `report-${FAKE_PRIVATE_PREFIX}${FAKE_PRIVATE_NAME_SEGMENT}.txt`;

// ---------------------------------------------------------------------------
// Test 1: a temp tree containing a file whose NAME embeds the fake private
// name (file CONTENT is neutral) is reported by the scan — exactly that
// path is named as a finding, with the "(file path)" location marker
// (distinguishable from a line number and from the existing "(symlink
// target)" marker), attributed to the "Private repo name" category.
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-path-leak-');
  fs.writeFileSync(path.join(dir, FAKE_FILENAME), 'nothing sensitive in here\n');

  const result = runScan(dir, ['--private-names', FAKE_PRIVATE_PREFIX]);

  assert.strictEqual(
    result.status,
    1,
    `Test 1 FAIL: expected exit 1 (findings present), got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    result.stderr.includes(FAKE_FILENAME),
    `Test 1 FAIL: expected the finding to name the leaking path "${FAKE_FILENAME}", got:\n${result.stderr}`
  );
  assert.ok(
    result.stderr.includes('(file path)'),
    `Test 1 FAIL: expected the "(file path)" location marker in output, got:\n${result.stderr}`
  );
  assert.ok(
    result.stderr.includes('[Private repo name]'),
    `Test 1 FAIL: expected the finding attributed to the "Private repo name" category, got:\n${result.stderr}`
  );
  console.log(
    'Test 1 passed: a file whose NAME embeds a private name (clean content) is reported via path scanning, exactly naming that path with the "(file path)" marker'
  );
}

// ---------------------------------------------------------------------------
// Test 2: the same tree shape but with a neutral filename (and the SAME
// neutral content) yields zero findings — this kills the always-fires
// mutant (a scanEntryPath implementation that reports regardless of the
// actual text scanned would still pass Test 1 but fail here).
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-path-clean-');
  fs.writeFileSync(path.join(dir, 'report-neutral-name.txt'), 'nothing sensitive in here\n');

  const result = runScan(dir, ['--private-names', FAKE_PRIVATE_PREFIX]);

  assert.strictEqual(
    result.status,
    0,
    `Test 2 FAIL: expected exit 0 (zero findings) for a neutral filename, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /zero findings/.test(result.stdout),
    `Test 2 FAIL: expected "zero findings" in stdout, got: ${result.stdout}`
  );
  console.log('Test 2 passed: a neutral filename (no private name embedded) produces zero findings');
}

console.log('\nAll T-601 scan-path assertions passed.');
