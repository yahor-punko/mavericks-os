'use strict';
// Regression test: T-422 — opt-in --transcript-archive installer flag.
//
// mavp-install.js gains an opt-in `--transcript-archive` flag (default OFF)
// that merges a sentinel-identified managed SessionStart hook invoking
// scripts/mavp-transcript-archive.js, via the same mergeManagedHooks()
// machinery used for the validator/lifecycle hooks, and adds
// `.mavp/transcripts/` to the target project's .gitignore.
//
// This test asserts:
//   1. fresh install WITHOUT the flag adds no transcript-archive SessionStart
//      entry, and no .mavp/transcripts/ line in .gitignore
//   2. fresh install WITH the flag adds exactly one such entry (alongside the
//      existing agent-brief SessionStart entry) and the gitignore line
//   3. `--update` WITHOUT the flag on a project where the entry is already
//      present preserves it (does not remove it)
//   4. a second `--update` (still without the flag) is idempotent — no
//      further change to settings.local.json
//   5. `--hooks-only --transcript-archive` adds the entry to an
//      already-bootstrapped project that was never installed with the flag
//   6. disable path: manually removing the managed entry, then running
//      `--update` without the flag, leaves it removed (not re-added)
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const TA_IDENTITY = 'mavp-transcript-archive.js';

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSettings(scratch) {
  return JSON.parse(fs.readFileSync(path.join(scratch, '.claude', 'settings.local.json'), 'utf8'));
}

function readGitignore(scratch) {
  const p = path.join(scratch, '.gitignore');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function sessionStartTAEntries(settings) {
  return (settings.hooks.SessionStart || []).filter(
    entry => entry && Array.isArray(entry.hooks) &&
      entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(TA_IDENTITY))
  );
}

function runInstall(args) {
  return execFileSync('node', [INSTALL_SCRIPT].concat(args), { encoding: 'utf8' });
}

const cleanupDirs = [];
function trackedScratch(prefix) {
  const dir = makeScratchDir(prefix);
  cleanupDirs.push(dir);
  return dir;
}

try {
  // ============================================================
  // Assertion 1: fresh install WITHOUT the flag adds no entry
  // ============================================================
  const scratchNoFlag = trackedScratch('mavp-ta-install-noflag-');
  runInstall([scratchNoFlag, '--yes']);
  const settingsNoFlag = readSettings(scratchNoFlag);
  assert.strictEqual(
    sessionStartTAEntries(settingsNoFlag).length,
    0,
    'FAIL: fresh install WITHOUT --transcript-archive added a transcript-archive SessionStart entry'
  );
  assert.ok(
    !readGitignore(scratchNoFlag).includes('.mavp/transcripts/'),
    'FAIL: fresh install WITHOUT --transcript-archive added .mavp/transcripts/ to .gitignore'
  );
  console.log('Assertion 1 passed: fresh install without the flag adds no entry and no gitignore line');

  // ============================================================
  // Assertion 2: fresh install WITH the flag adds exactly one entry + gitignore line
  // ============================================================
  const scratchFlag = trackedScratch('mavp-ta-install-flag-');
  runInstall([scratchFlag, '--yes', '--transcript-archive']);
  const settingsFlag = readSettings(scratchFlag);
  const taEntries = sessionStartTAEntries(settingsFlag);
  assert.strictEqual(
    taEntries.length,
    1,
    `FAIL: fresh install WITH --transcript-archive should add exactly one entry, found ${taEntries.length}`
  );
  assert.ok(
    Array.isArray(settingsFlag.hooks.SessionStart) && settingsFlag.hooks.SessionStart.length === 2,
    'FAIL: expected exactly 2 SessionStart entries (agent-brief + transcript-archive)'
  );
  assert.ok(
    readGitignore(scratchFlag).includes('.mavp/transcripts/'),
    'FAIL: fresh install WITH --transcript-archive did not add .mavp/transcripts/ to .gitignore'
  );
  console.log('Assertion 2 passed: fresh install with the flag adds exactly one entry and the gitignore line');

  // ============================================================
  // Assertion 3 + 4: --update WITHOUT the flag preserves the entry, and is idempotent
  // ============================================================
  runInstall(['--update', scratchFlag]);
  const settingsAfterUpdate1 = readSettings(scratchFlag);
  assert.strictEqual(
    sessionStartTAEntries(settingsAfterUpdate1).length,
    1,
    'FAIL: --update WITHOUT --transcript-archive removed the already-present entry — must preserve it'
  );
  console.log('Assertion 3 passed: --update without the flag preserves an already-present entry');

  const beforeSecondUpdate = readSettings(scratchFlag);
  runInstall(['--update', scratchFlag]);
  const afterSecondUpdate = readSettings(scratchFlag);
  assert.deepStrictEqual(
    afterSecondUpdate,
    beforeSecondUpdate,
    'FAIL: a second --update (still without the flag) changed settings.local.json — not idempotent'
  );
  console.log('Assertion 4 passed: a second --update is idempotent (no further change)');

  // ============================================================
  // Assertion 5: --hooks-only --transcript-archive adds the entry to a
  // project that was never installed with the flag
  // ============================================================
  const scratchHooksOnly = trackedScratch('mavp-ta-hooksonly-');
  runInstall([scratchHooksOnly, '--yes']);
  assert.strictEqual(
    sessionStartTAEntries(readSettings(scratchHooksOnly)).length,
    0,
    'sanity: fresh install without the flag should not have the entry yet'
  );
  runInstall(['--hooks-only', scratchHooksOnly, '--transcript-archive']);
  const settingsHooksOnly = readSettings(scratchHooksOnly);
  assert.strictEqual(
    sessionStartTAEntries(settingsHooksOnly).length,
    1,
    'FAIL: --hooks-only --transcript-archive did not add the entry to an already-bootstrapped project'
  );
  assert.ok(
    readGitignore(scratchHooksOnly).includes('.mavp/transcripts/'),
    'FAIL: --hooks-only --transcript-archive did not add .mavp/transcripts/ to .gitignore'
  );
  console.log('Assertion 5 passed: --hooks-only --transcript-archive adds the entry to an existing project');

  // ============================================================
  // Assertion 6: disable path — manual removal + --update without the flag
  // leaves it removed (not re-added)
  // ============================================================
  const settingsPathHooksOnly = path.join(scratchHooksOnly, '.claude', 'settings.local.json');
  const settingsToEdit = readSettings(scratchHooksOnly);
  settingsToEdit.hooks.SessionStart = settingsToEdit.hooks.SessionStart.filter(
    entry => !(entry && Array.isArray(entry.hooks) &&
      entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(TA_IDENTITY)))
  );
  fs.writeFileSync(settingsPathHooksOnly, JSON.stringify(settingsToEdit, null, 2) + '\n', 'utf8');
  assert.strictEqual(
    sessionStartTAEntries(readSettings(scratchHooksOnly)).length,
    0,
    'sanity: manual removal should leave zero transcript-archive entries'
  );

  runInstall(['--update', scratchHooksOnly]);
  assert.strictEqual(
    sessionStartTAEntries(readSettings(scratchHooksOnly)).length,
    0,
    'FAIL: --update without --transcript-archive re-added a manually-removed entry — disable path is broken'
  );
  console.log('Assertion 6 passed: manually removing the entry then running --update without the flag leaves it removed (disable path)');

  console.log('\nAll T-422 --transcript-archive installer assertions passed.');
} finally {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
