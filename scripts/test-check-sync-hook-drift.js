'use strict';
// Regression test: T-441 — --check-sync detects a stale/naive managed
// PostToolUse hook in known bootstrapped projects (the source of the false
// "blocking error" noise reported from the field — a naive pre-hardening
// hook lacks the file-path filter, debounce, and unconditional advisory
// exit-0 that composePostToolUseHookCommand() now produces).
//
// Covers:
//   1-2. checkHookDrift() unit coverage: stale (naive hook) vs in-sync
//        (managed entry byte-identical to the freshly composed command).
//   3-5. skip branches: no settings.local.json, no managed PostToolUse
//        entry, malformed JSON — all return null (skip, never an error).
//   6-8. end-to-end via the --check-sync CLI (mavp-operator-check-sync.js),
//        exercising the exact acceptance-criteria wording: stale projects
//        are reported STALE and named the fix "node scripts/mavp-install.js
//        --update <dir>"; in-sync projects report "hook in sync"; skipped
//        projects mention neither.
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { checkHookDrift } = require('./mavp-operator-check-sync.js');
const { composePostToolUseHookCommand } = require('./mavp-install.js');

const CHECK_SYNC_SCRIPT = path.join(__dirname, 'mavp-operator-check-sync.js');
const MAVERICKS_ROOT = path.resolve(__dirname, '..');

// Naive pre-hardening PostToolUse hook: still recognizable as "the managed
// validator hook" by identity (contains the validator filename), but has
// none of the hardening (no file-path filter, no debounce, no fragments,
// no sentinel) — exactly the shape reported from the field as noisy.
const NAIVE_HOOK_CMD = 'node "$MAVERICKS_HOME/scripts/mavp-validator.js"; exit $?';

function makeFixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-check-sync-hook-test-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // Minimal marker so the directory reads as a bootstrapped project if ever
  // scanned that way (not required for the MAVERICKS_PROJECTS env path, but
  // keeps the fixture realistic).
  fs.writeFileSync(
    path.join(dir, 'scripts', 'mavp-operator'),
    '#!/bin/bash\n# delegates via MAVERICKS_PROJECT_ROOT\n'
  );
  return dir;
}

function writeSettingsLocal(dir, settings) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.local.json'),
    JSON.stringify(settings, null, 2)
  );
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCheckSync(fixtureDir) {
  return execFileSync('node', [CHECK_SYNC_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAVERICKS_PROJECTS: fixtureDir,
      MAVERICKS_PROJECT_ROOT: MAVERICKS_ROOT,
    },
  });
}

// --- Test 1: checkHookDrift detects a naive/stale managed hook ---
{
  const dir = makeFixtureProject();
  try {
    writeSettingsLocal(dir, {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: NAIVE_HOOK_CMD }] },
        ],
      },
    });
    const result = checkHookDrift(dir);
    assert.ok(result, 'Test 1 FAIL: expected a result, not null (managed entry should be found)');
    assert.strictEqual(result.stale, true, 'Test 1 FAIL: expected stale: true for naive hook');
    assert.strictEqual(result.current, NAIVE_HOOK_CMD, 'Test 1 FAIL: wrong current command');
    assert.strictEqual(
      result.expected,
      composePostToolUseHookCommand(dir),
      'Test 1 FAIL: expected command should be the freshly composed one'
    );
    console.log('Test 1 passed: checkHookDrift detects a naive/stale managed hook');
  } finally {
    cleanup(dir);
  }
}

// --- Test 2: checkHookDrift reports in sync when the managed entry matches ---
{
  const dir = makeFixtureProject();
  try {
    const expected = composePostToolUseHookCommand(dir);
    writeSettingsLocal(dir, {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: expected }] },
        ],
      },
    });
    const result = checkHookDrift(dir);
    assert.ok(result, 'Test 2 FAIL: expected a result, not null');
    assert.strictEqual(result.stale, false, 'Test 2 FAIL: expected stale: false when commands match');
    console.log('Test 2 passed: checkHookDrift reports in sync when the managed entry matches the freshly composed command');
  } finally {
    cleanup(dir);
  }
}

// --- Test 3: checkHookDrift returns null (skip) when there's no settings.local.json ---
{
  const dir = makeFixtureProject();
  try {
    const result = checkHookDrift(dir);
    assert.strictEqual(result, null, 'Test 3 FAIL: expected null when no settings.local.json exists');
    console.log('Test 3 passed: checkHookDrift returns null (skip, no error) when no settings.local.json exists');
  } finally {
    cleanup(dir);
  }
}

// --- Test 4: checkHookDrift returns null (skip) when there's no managed entry ---
{
  const dir = makeFixtureProject();
  try {
    writeSettingsLocal(dir, {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "custom operator hook"' }] },
        ],
      },
    });
    const result = checkHookDrift(dir);
    assert.strictEqual(result, null, 'Test 4 FAIL: expected null when no managed entry is found');
    console.log('Test 4 passed: checkHookDrift returns null (skip, no error) when no managed entry is found');
  } finally {
    cleanup(dir);
  }
}

// --- Test 5: checkHookDrift returns null (skip) for malformed JSON ---
{
  const dir = makeFixtureProject();
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{ not valid json');
    const result = checkHookDrift(dir);
    assert.strictEqual(result, null, 'Test 5 FAIL: expected null for malformed settings.local.json');
    console.log('Test 5 passed: checkHookDrift returns null (skip, no error/throw) for malformed JSON');
  } finally {
    cleanup(dir);
  }
}

// --- Test 6: end-to-end --check-sync reports a naive hook as STALE and names the fix ---
{
  const dir = makeFixtureProject();
  try {
    writeSettingsLocal(dir, {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: NAIVE_HOOK_CMD }] },
        ],
      },
    });
    const output = runCheckSync(dir);
    assert.ok(output.includes('hook STALE'), `Test 6 FAIL: expected "hook STALE" in output:\n${output}`);
    assert.ok(
      output.includes(`node scripts/mavp-install.js --update ${dir}`),
      `Test 6 FAIL: expected the fix command naming this dir in output:\n${output}`
    );
    console.log('Test 6 passed: --check-sync reports a naive/stale hook as STALE and names the fix');
  } finally {
    cleanup(dir);
  }
}

// --- Test 7: end-to-end --check-sync reports an in-sync hook ---
{
  const dir = makeFixtureProject();
  try {
    const expected = composePostToolUseHookCommand(dir);
    writeSettingsLocal(dir, {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: expected }] },
        ],
      },
    });
    const output = runCheckSync(dir);
    assert.ok(output.includes('hook in sync'), `Test 7 FAIL: expected "hook in sync" in output:\n${output}`);
    assert.ok(!output.includes('hook STALE'), `Test 7 FAIL: did not expect "hook STALE" in output:\n${output}`);
    console.log('Test 7 passed: --check-sync reports the hook in sync when the managed entry matches');
  } finally {
    cleanup(dir);
  }
}

// --- Test 8: end-to-end --check-sync skips projects with no settings file or no managed entry, without error ---
{
  const dirNoSettings = makeFixtureProject();
  const dirNoManagedEntry = makeFixtureProject();
  try {
    writeSettingsLocal(dirNoManagedEntry, {
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "custom operator hook"' }] },
        ],
      },
    });

    const outputNoSettings = runCheckSync(dirNoSettings);
    assert.ok(!outputNoSettings.includes('hook STALE'), `Test 8a FAIL: unexpected "hook STALE":\n${outputNoSettings}`);
    assert.ok(!outputNoSettings.includes('hook in sync'), `Test 8a FAIL: unexpected "hook in sync":\n${outputNoSettings}`);

    const outputNoManaged = runCheckSync(dirNoManagedEntry);
    assert.ok(!outputNoManaged.includes('hook STALE'), `Test 8b FAIL: unexpected "hook STALE":\n${outputNoManaged}`);
    assert.ok(!outputNoManaged.includes('hook in sync'), `Test 8b FAIL: unexpected "hook in sync":\n${outputNoManaged}`);

    console.log('Test 8 passed: --check-sync skips projects with no settings file or no managed entry, without error');
  } finally {
    cleanup(dirNoSettings);
    cleanup(dirNoManagedEntry);
  }
}

console.log('\nAll T-441 check-sync hook-drift assertions passed.');
