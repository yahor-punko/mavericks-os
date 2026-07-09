'use strict';
// Unit test: T-315 / T-319 — shared .claude/settings.json defaultMode propagation
//
// Runs mavp-install.js against scratch directories and asserts on the
// generated/updated .claude/settings.json. Plain node, no npm deps.
//
// T-319 flipped the framework default from acceptEdits to bypassPermissions and
// added a three-way --update migration (see scripts/test-install-bypass-default.js
// for the dedicated four-case coverage of that migration).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSettings(dir) {
  const p = path.join(dir, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- Test 1: fresh install creates .claude/settings.json with defaultMode bypassPermissions ---
{
  const scratch = makeScratchDir('mavp-install-fresh-');
  try {
    // Fresh install prompts "Create N file(s)...? [Y/n]" — answer 'y' via stdin.
    execFileSync('node', [INSTALL_SCRIPT, scratch], {
      input: 'y\n',
      encoding: 'utf8',
    });

    const settingsPath = path.join(scratch, '.claude', 'settings.json');
    assert.strictEqual(fs.existsSync(settingsPath), true, 'Test 1 FAIL: .claude/settings.json was not created');

    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions && settings.permissions.defaultMode,
      'bypassPermissions',
      'Test 1 FAIL: permissions.defaultMode !== "bypassPermissions"'
    );
    console.log('Test 1 passed: fresh install creates settings.json with defaultMode bypassPermissions');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Test 2: --update on a project whose settings.json already sets defaultMode "plan" leaves it untouched ---
{
  const scratch = makeScratchDir('mavp-install-update-plan-');
  try {
    const claudeDir = path.join(scratch, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: 'plan' } }, null, 2) + '\n',
      'utf8'
    );

    execFileSync('node', [INSTALL_SCRIPT, '--update', scratch], { encoding: 'utf8' });

    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions.defaultMode,
      'plan',
      'Test 2 FAIL: --update overwrote an existing defaultMode value'
    );
    console.log('Test 2 passed: --update leaves existing defaultMode "plan" untouched');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Test 3: --update adds permissions.defaultMode when absent ---
{
  const scratch = makeScratchDir('mavp-install-update-absent-');
  try {
    // Case 3a: settings.json exists but has no permissions.defaultMode key at all.
    const claudeDir = path.join(scratch, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ someOtherKey: true }, null, 2) + '\n', 'utf8');

    execFileSync('node', [INSTALL_SCRIPT, '--update', scratch], { encoding: 'utf8' });

    let settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions && settings.permissions.defaultMode,
      'bypassPermissions',
      'Test 3a FAIL: --update did not backfill missing defaultMode key'
    );
    assert.strictEqual(settings.someOtherKey, true, 'Test 3a FAIL: --update clobbered unrelated existing key');
    console.log('Test 3a passed: --update backfills defaultMode when key absent from existing settings.json');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

{
  // Case 3b: settings.json does not exist at all before --update.
  const scratch = makeScratchDir('mavp-install-update-missing-file-');
  try {
    execFileSync('node', [INSTALL_SCRIPT, '--update', scratch], { encoding: 'utf8' });

    const settingsPath = path.join(scratch, '.claude', 'settings.json');
    assert.strictEqual(fs.existsSync(settingsPath), true, 'Test 3b FAIL: --update did not create settings.json');
    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions && settings.permissions.defaultMode,
      'bypassPermissions',
      'Test 3b FAIL: --update-created settings.json missing defaultMode bypassPermissions'
    );
    console.log('Test 3b passed: --update creates settings.json with defaultMode when file absent');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Test 4: settings.local.json seeding behavior is unchanged (still created on fresh install with hooks) ---
{
  const scratch = makeScratchDir('mavp-install-local-unchanged-');
  try {
    execFileSync('node', [INSTALL_SCRIPT, scratch], {
      input: 'y\n',
      encoding: 'utf8',
    });

    const localSettingsPath = path.join(scratch, '.claude', 'settings.local.json');
    assert.strictEqual(fs.existsSync(localSettingsPath), true, 'Test 4 FAIL: settings.local.json was not created');
    const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
    assert.strictEqual(typeof localSettings.hooks, 'object', 'Test 4 FAIL: settings.local.json missing hooks block');
    assert.strictEqual(
      Array.isArray(localSettings.fallbackModel),
      true,
      'Test 4 FAIL: settings.local.json missing fallbackModel'
    );
    // settings.local.json must NOT carry permissions.defaultMode from this change —
    // that policy now lives exclusively in the shared, committed settings.json.
    assert.strictEqual(
      localSettings.permissions,
      undefined,
      'Test 4 FAIL: settings.local.json unexpectedly gained a permissions key'
    );
    console.log('Test 4 passed: settings.local.json seeding behavior unchanged');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('\nAll T-315 assertions passed.');
console.log('(see scripts/test-install-bypass-default.js for T-319 four-case migration coverage)');
