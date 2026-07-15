'use strict';
// Regression test: T-392 — repo-map artifact (schema doc, template, parser,
// validator check).
//
// Covers:
//   1. parseRepoMap() (mavp-operator-lib.js) on a fixture docs/REPO_MAP.md —
//      returns the full registry with all declared fields.
//   2. parseRepoMap() returns {} (empty map, no throw) when the file is absent.
//   3. checkRepoIds() (mavp-validator.js) fires an unknown_repo_id warning when
//      a task's Repo: value is not a known ID in the map.
//   4. checkRepoIds() does NOT fire — returns [] — when there is no repo map
//      file (skips silently, matching the unknown_module_id precedent).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { parseRepoMap } = require('./mavp-operator-lib.js');
const { checkRepoIds, getSeverityForCheck } = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't392-repo-map-'));

const REPO_MAP_FIXTURE = `# Repo Map — Schema Reference

## What the repo map is used for

Meta section — must be skipped, not treated as a repo id.

## example-repo

- **label:** Example Repo
- **path:** /home/dev/projects/example-repo
- **domain:** example.com
- **deploy_path:** /var/www/example
- **downstream:** other-repo, another-repo
- **docs:** docs/ARCHITECTURE.md, README.md

## Example entry (generic placeholder — replace with your own)

    ## my-repo

    - **label:** My Repo
    - **path:** /home/me/projects/my-repo
`;

// ---------------------------------------------------------------------------
// Test 1: parseRepoMap() on a fixture docs/REPO_MAP.md returns the full
// registry with all declared fields, and skips meta/example sections.
// ---------------------------------------------------------------------------
{
  const fixtureRoot = path.join(TMP_DIR, 'with-map');
  fs.mkdirSync(path.join(fixtureRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'docs', 'REPO_MAP.md'), REPO_MAP_FIXTURE, 'utf8');

  const registry = parseRepoMap(fixtureRoot);

  assert.deepStrictEqual(
    Object.keys(registry),
    ['example-repo'],
    `Test 1 FAIL: expected only "example-repo" as a registry key, got: ${JSON.stringify(Object.keys(registry))}`
  );

  const entry = registry['example-repo'];
  assert.strictEqual(entry.label, 'Example Repo', 'Test 1 FAIL: label mismatch');
  assert.strictEqual(entry.path, '/home/dev/projects/example-repo', 'Test 1 FAIL: path mismatch');
  assert.strictEqual(entry.domain, 'example.com', 'Test 1 FAIL: domain mismatch');
  assert.strictEqual(entry.deploy_path, '/var/www/example', 'Test 1 FAIL: deploy_path mismatch');
  assert.deepStrictEqual(entry.downstream, ['other-repo', 'another-repo'], 'Test 1 FAIL: downstream mismatch');
  assert.deepStrictEqual(entry.docs, ['docs/ARCHITECTURE.md', 'README.md'], 'Test 1 FAIL: docs mismatch');

  console.log('Test 1 passed: parseRepoMap() returns the full registry from a fixture docs/REPO_MAP.md');
}

// ---------------------------------------------------------------------------
// Test 2: parseRepoMap() returns {} (no throw) when docs/REPO_MAP.md is absent.
// ---------------------------------------------------------------------------
{
  const emptyRoot = path.join(TMP_DIR, 'without-map');
  fs.mkdirSync(emptyRoot, { recursive: true });

  let registry;
  assert.doesNotThrow(() => {
    registry = parseRepoMap(emptyRoot);
  }, 'Test 2 FAIL: parseRepoMap() must not throw when docs/REPO_MAP.md is absent');

  assert.deepStrictEqual(registry, {}, `Test 2 FAIL: expected {}, got: ${JSON.stringify(registry)}`);

  console.log('Test 2 passed: parseRepoMap() returns an empty map when the file is absent');
}

// ---------------------------------------------------------------------------
// Test 3: checkRepoIds() fires an unknown_repo_id warning when a task's
// Repo: value is not a known ID in the map.
// ---------------------------------------------------------------------------
{
  const mapPath = path.join(TMP_DIR, 'repo-map-for-check.md');
  fs.writeFileSync(mapPath, REPO_MAP_FIXTURE, 'utf8');

  const backlogRecords = [
    { taskId: 'T-900', repo: 'not-a-real-repo' },
  ];

  const findings = checkRepoIds(backlogRecords, mapPath);

  assert.strictEqual(findings.length, 1, `Test 3 FAIL: expected exactly 1 finding, got: ${JSON.stringify(findings)}`);
  const finding = findings[0];
  assert.strictEqual(finding.checkName, 'unknown_repo_id', 'Test 3 FAIL: checkName mismatch');
  assert.strictEqual(finding.taskId, 'T-900', 'Test 3 FAIL: taskId mismatch');
  assert.strictEqual(finding.severity, 'warning', 'Test 3 FAIL: severity should be warning');
  assert.strictEqual(getSeverityForCheck('unknown_repo_id'), 'warning', 'Test 3 FAIL: getSeverityForCheck mismatch');
  assert.ok(
    /not-a-real-repo/.test(finding.message) && /docs\/REPO_MAP\.md/.test(finding.message),
    `Test 3 FAIL: message should name the repo id and docs/REPO_MAP.md, got: "${finding.message}"`
  );

  console.log('Test 3 passed: checkRepoIds() fires an unknown_repo_id warning for an unlisted Repo: value');
}

// ---------------------------------------------------------------------------
// Test 3b: checkRepoIds() does NOT fire for a Repo: value that IS in the map.
// ---------------------------------------------------------------------------
{
  const mapPath = path.join(TMP_DIR, 'repo-map-for-check.md');
  const backlogRecords = [
    { taskId: 'T-901', repo: 'example-repo' },
  ];

  const findings = checkRepoIds(backlogRecords, mapPath);

  assert.strictEqual(findings.length, 0, `Test 3b FAIL: expected no findings, got: ${JSON.stringify(findings)}`);

  console.log('Test 3b passed: checkRepoIds() does not fire for a known Repo: value');
}

// ---------------------------------------------------------------------------
// Test 4: checkRepoIds() does NOT fire (returns []) when there is no repo map
// file — skips silently, matching the unknown_module_id precedent.
// ---------------------------------------------------------------------------
{
  const missingMapPath = path.join(TMP_DIR, 'this-file-does-not-exist.md');
  const backlogRecords = [
    { taskId: 'T-902', repo: 'anything-goes-here' },
  ];

  const findings = checkRepoIds(backlogRecords, missingMapPath);

  assert.strictEqual(
    findings.length,
    0,
    `Test 4 FAIL: expected no findings when repo map is absent, got: ${JSON.stringify(findings)}`
  );

  console.log('Test 4 passed: checkRepoIds() skips silently (no findings) when there is no repo map file');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-392 assertions passed.');
