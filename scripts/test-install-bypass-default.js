'use strict';
// Unit test: T-319 — flip framework default permission mode to bypassPermissions
//
// Covers the four acceptance-criteria cases for the three-way --update migration
// plus the fresh-seed default. Runs mavp-install.js against scratch directories
// and asserts on the generated/updated .claude/settings.json (and, for the
// migration case, on the console output). Plain node, no npm deps.

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

// --- Case 1: fresh install into an empty fixture dir seeds bypassPermissions ---
{
  const scratch = makeScratchDir('mavp-install-bypass-fresh-');
  try {
    // Fresh install prompts "Create N file(s)...? [Y/n]" — answer 'y' via stdin.
    execFileSync('node', [INSTALL_SCRIPT, scratch, '--stale-source-ok'], {
      input: 'y\n',
      encoding: 'utf8',
    });

    const settingsPath = path.join(scratch, '.claude', 'settings.json');
    assert.strictEqual(fs.existsSync(settingsPath), true, 'Case 1 FAIL: .claude/settings.json was not created');

    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions && settings.permissions.defaultMode,
      'bypassPermissions',
      'Case 1 FAIL: fresh-seeded defaultMode !== "bypassPermissions"'
    );
    console.log('Case 1 passed: fresh install seeds defaultMode bypassPermissions');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Case 2: --update against a fixture with defaultMode acceptEdits migrates to
//     bypassPermissions and prints a console migration line ---
{
  const scratch = makeScratchDir('mavp-install-bypass-migrate-');
  try {
    const claudeDir = path.join(scratch, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }, null, 2) + '\n',
      'utf8'
    );

    const output = execFileSync('node', [INSTALL_SCRIPT, '--update', scratch, '--stale-source-ok'], { encoding: 'utf8' });

    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions.defaultMode,
      'bypassPermissions',
      'Case 2 FAIL: --update did not migrate acceptEdits to bypassPermissions'
    );
    assert.match(
      output,
      /migrated: acceptEdits.*bypassPermissions/i,
      'Case 2 FAIL: --update did not print a console migration line'
    );
    console.log('Case 2 passed: --update migrates acceptEdits to bypassPermissions with a console line');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Case 3: --update against a fixture with defaultMode "plan" (or any non-acceptEdits
//     value) leaves it unchanged — this is the deliberate per-project opt-out ---
for (const deliberateValue of ['plan', 'default', 'dontAsk', 'bypassPermissions']) {
  const scratch = makeScratchDir(`mavp-install-bypass-optout-${deliberateValue}-`);
  try {
    const claudeDir = path.join(scratch, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: deliberateValue } }, null, 2) + '\n',
      'utf8'
    );

    execFileSync('node', [INSTALL_SCRIPT, '--update', scratch, '--stale-source-ok'], { encoding: 'utf8' });

    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions.defaultMode,
      deliberateValue,
      `Case 3 FAIL (${deliberateValue}): --update overwrote a deliberate non-acceptEdits value`
    );
    console.log(`Case 3 passed: --update leaves existing defaultMode "${deliberateValue}" untouched`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Case 4: --update against a fixture with no settings.json seeds bypassPermissions ---
{
  const scratch = makeScratchDir('mavp-install-bypass-missing-file-');
  try {
    execFileSync('node', [INSTALL_SCRIPT, '--update', scratch, '--stale-source-ok'], { encoding: 'utf8' });

    const settingsPath = path.join(scratch, '.claude', 'settings.json');
    assert.strictEqual(fs.existsSync(settingsPath), true, 'Case 4 FAIL: --update did not create settings.json');
    const settings = readSettings(scratch);
    assert.strictEqual(
      settings.permissions && settings.permissions.defaultMode,
      'bypassPermissions',
      'Case 4 FAIL: --update-created settings.json missing defaultMode bypassPermissions'
    );
    console.log('Case 4 passed: --update seeds bypassPermissions when settings.json is absent');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('\nAll T-319 assertions passed (4 cases + opt-out value sweep).');
