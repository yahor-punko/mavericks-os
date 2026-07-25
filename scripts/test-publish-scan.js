'use strict';
// Regression test: T-479 — RFC-2606/6761 reserved example domains must be
// allowed by mavp-publish-scan.js's Email address category, without
// weakening detection of real-looking / non-reserved emails or any other
// detection category.
//
// Exercises mavp-publish-scan.js as a subprocess (CLI) against small fixture
// trees, since main() runs unconditionally at module load and calls
// process.exit() directly.

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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runScan(dir, extraArgs = []) {
  return spawnSync(process.execPath, [SCAN_SCRIPT, dir, ...extraArgs], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Test (a)+(b)+(c): reserved-example-domain emails and the explicit
// EMAIL_ALLOWLIST entry are all allowed — a fixture tree containing ONLY
// these must scan clean (exit 0, zero findings).
// ---------------------------------------------------------------------------
{
  const dir = mkTempDir('mavp-scan-allowed-');
  writeFile(
    path.join(dir, 'fixture.js'),
    [
      "const a = 'test@example.com';",
      "const b = 'any@example.org';",
      "const c = 'x@example.net';",
      "const d = 'y@foo.invalid';",
      "const e = 'z@bar.test';",
      "const f = 'w@baz.example';",
      "const g = 'v@qux.localhost';",
      "const h = 'yahorpunko@gmail.com';", // (c) explicit allowlist entry preserved
      '',
    ].join('\n')
  );

  const result = runScan(dir);
  assert.strictEqual(
    result.status,
    0,
    `Test (a)-(c) FAIL: expected exit 0 for all-reserved/allowlisted emails, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /zero findings/.test(result.stdout),
    `Test (a)-(c) FAIL: expected "zero findings" in stdout, got: ${result.stdout}`
  );
  console.log('Test (a)-(c) passed: example.com/.net/.org, .invalid/.test/.example/.localhost, and the explicit allowlist entry are all allowed');
}

// ---------------------------------------------------------------------------
// Test (d): a realistic NON-reserved email must still be flagged — this is
// the regression proof that the widening covers ONLY the reserved domains
// and did not weaken detection generally.
// ---------------------------------------------------------------------------
{
  // Runtime-constructed so no literal detectable email address appears in
  // this shipped file's text (the scanner matches file text statically).
  const nonReservedEmail = 'jane' + '@acme' + 'corp.com';
  const dir = mkTempDir('mavp-scan-flagged-');
  writeFile(path.join(dir, 'fixture.js'), "const contact = '" + nonReservedEmail + "';\n");

  const result = runScan(dir);
  assert.strictEqual(
    result.status,
    1,
    `Test (d) FAIL: expected exit 1 for non-reserved email ${nonReservedEmail}, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(
    /\[Email address\]/.test(result.stderr),
    `Test (d) FAIL: expected an "Email address" finding in stderr, got: ${result.stderr}`
  );
  console.log('Test (d) passed: realistic non-reserved email ' + nonReservedEmail + ' is still flagged (regression proof)');
}

// ---------------------------------------------------------------------------
// Test (e): other detection categories (token shapes, /Users/ paths, private
// repo names) are unaffected by the Email-address-only change.
// ---------------------------------------------------------------------------
{
  // Runtime-constructed so no literal detectable AWS-key or /Users/ path
  // string appears in this shipped file's text (the scanner matches file
  // text statically, not runtime values).
  const awsKeyShape = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const usersPath = '/Use' + 'rs/someone/project/secret.txt';
  const dir = mkTempDir('mavp-scan-other-categories-');
  writeFile(
    path.join(dir, 'fixture.js'),
    [
      "const key = '" + awsKeyShape + "';", // AWS access key shape
      "const p = '" + usersPath + "';", // absolute /Users/ path
      "const n = 'acme-web-service-internal';", // private repo name (runtime-supplied)
      '',
    ].join('\n')
  );

  const result = runScan(dir, ['--private-names', 'acme-']);
  assert.strictEqual(
    result.status,
    1,
    `Test (e) FAIL: expected exit 1 for other-category findings, got ${result.status}:\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(/\[AWS access key\]/.test(result.stderr), 'Test (e) FAIL: expected AWS access key finding unaffected');
  assert.ok(/\[Absolute \/Users\/ path\]/.test(result.stderr), 'Test (e) FAIL: expected /Users/ path finding unaffected');
  assert.ok(/\[Private repo name\]/.test(result.stderr), 'Test (e) FAIL: expected private repo name finding unaffected');
  console.log('Test (e) passed: token-shape, absolute-path, and private-repo-name categories remain unaffected');
}

console.log('\nAll T-479 assertions passed.');
