'use strict';
// Regression test: T-577 — mavp-install.js seeds/merges VS Code exclusion
// settings for .claude/worktrees.
//
// Field report 2026-08-02: the harness creates a `.claude/worktrees/agent-*`
// directory per background sub-agent and never removes it. Unexcluded, VS
// Code's file explorer, search index, and file watcher all surface the
// accumulated worktrees, and its Git extension has been observed treating the
// pile as (or alongside) real repository state.
//
// mergeVscodeWorktreeExclusions() in mavp-install.js additively/idempotently
// merges three keys into the target project's .vscode/settings.json:
// files.exclude, search.exclude, files.watcherExclude — each carrying the
// managed `.claude/worktrees` glob set to `true` — following the
// mergeManagedHooks() precedent: never touches unrelated keys, never
// overwrites a pre-existing conflicting value for the managed sub-key
// (prints a notice instead), and is a no-op on a second run.
//
// This test asserts:
//   1. fresh-install creation: a fresh `mavp-install.js <scratch>` run creates
//      .vscode/settings.json with all three managed keys, each carrying the
//      expected glob pattern set to `true`.
//   2. merge preserving unrelated user keys: an existing .vscode/settings.json
//      with unrelated top-level keys and unrelated sub-entries under a
//      managed key survives byte-identical alongside the newly-added glob.
//   3. second-run no-op: calling the merge twice leaves the file byte-identical
//      after the second call, and the second call reports 0 changes.
//   4. conflict-preserved-with-notice: a pre-existing conflicting value
//      (not `true`) for the managed glob sub-key is left untouched, and a
//      notice is printed rather than the value being silently overwritten.
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  mergeVscodeWorktreeExclusions,
  VSCODE_WORKTREES_EXCLUDE_PATTERN,
  VSCODE_WORKTREES_WATCHER_EXCLUDE_PATTERN,
} = require('./mavp-install.js');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readVscodeSettings(scratch) {
  return JSON.parse(fs.readFileSync(path.join(scratch, '.vscode', 'settings.json'), 'utf8'));
}

function withCapturedConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

const cleanupDirs = [];
function trackedScratchDir(prefix) {
  const dir = makeScratchDir(prefix);
  cleanupDirs.push(dir);
  return dir;
}

try {
  // ============================================================
  // Assertion 1: fresh-install creation via the full installer entrypoint —
  // proves the wiring into main(), not just the unit-level function.
  // ============================================================
  const freshScratch = trackedScratchDir('mavp-vscode-fresh-');
  execFileSync('node', [INSTALL_SCRIPT, freshScratch, '--stale-source-ok'], { encoding: 'utf8' });

  const freshSettingsPath = path.join(freshScratch, '.vscode', 'settings.json');
  assert.ok(fs.existsSync(freshSettingsPath), 'FAIL: fresh install did not create .vscode/settings.json');
  const freshSettings = readVscodeSettings(freshScratch);
  assert.strictEqual(
    freshSettings['files.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    true,
    'FAIL: fresh install did not seed files.exclude with the worktrees pattern'
  );
  assert.strictEqual(
    freshSettings['search.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    true,
    'FAIL: fresh install did not seed search.exclude with the worktrees pattern'
  );
  assert.strictEqual(
    freshSettings['files.watcherExclude'][VSCODE_WORKTREES_WATCHER_EXCLUDE_PATTERN],
    true,
    'FAIL: fresh install did not seed files.watcherExclude with the deep-glob worktrees pattern'
  );
  console.log('Assertion 1 passed: fresh install creates .vscode/settings.json with the three managed keys');

  // ============================================================
  // Assertion 2: merge preserving unrelated user keys (unit-level, direct
  // function call — deterministic control over the starting shape).
  // ============================================================
  const mergeScratch = trackedScratchDir('mavp-vscode-merge-');
  fs.mkdirSync(path.join(mergeScratch, '.vscode'), { recursive: true });
  const preExisting = {
    'editor.tabSize': 2,
    'files.exclude': { '**/node_modules': true, '**/.git': true },
    'search.exclude': { '**/dist': true },
  };
  fs.writeFileSync(
    path.join(mergeScratch, '.vscode', 'settings.json'),
    JSON.stringify(preExisting, null, 2) + '\n',
    'utf8'
  );

  const changeCount2 = mergeVscodeWorktreeExclusions(mergeScratch);
  const afterMerge = readVscodeSettings(mergeScratch);

  assert.strictEqual(afterMerge['editor.tabSize'], 2, 'FAIL: unrelated top-level key was not preserved');
  assert.strictEqual(
    afterMerge['files.exclude']['**/node_modules'],
    true,
    'FAIL: unrelated pre-existing files.exclude sub-entry (**/node_modules) was not preserved'
  );
  assert.strictEqual(
    afterMerge['files.exclude']['**/.git'],
    true,
    'FAIL: unrelated pre-existing files.exclude sub-entry (**/.git) was not preserved'
  );
  assert.strictEqual(
    afterMerge['search.exclude']['**/dist'],
    true,
    'FAIL: unrelated pre-existing search.exclude sub-entry (**/dist) was not preserved'
  );
  assert.strictEqual(
    afterMerge['files.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    true,
    'FAIL: files.exclude worktrees pattern was not added during merge'
  );
  assert.strictEqual(
    afterMerge['search.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    true,
    'FAIL: search.exclude worktrees pattern was not added during merge'
  );
  assert.strictEqual(
    afterMerge['files.watcherExclude'][VSCODE_WORKTREES_WATCHER_EXCLUDE_PATTERN],
    true,
    'FAIL: files.watcherExclude worktrees pattern was not added during merge (key was absent before)'
  );
  assert.strictEqual(changeCount2, 3, 'FAIL: expected exactly 3 key additions (files.exclude, search.exclude, files.watcherExclude)');
  console.log('Assertion 2 passed: merge preserves unrelated top-level keys and unrelated sub-entries under managed keys');

  // ============================================================
  // Assertion 3: second-run no-op (idempotent).
  // ============================================================
  const beforeSecondRun = fs.readFileSync(path.join(mergeScratch, '.vscode', 'settings.json'), 'utf8');
  const changeCountSecond = mergeVscodeWorktreeExclusions(mergeScratch);
  const afterSecondRun = fs.readFileSync(path.join(mergeScratch, '.vscode', 'settings.json'), 'utf8');
  assert.strictEqual(changeCountSecond, 0, 'FAIL: second run reported non-zero changes — not idempotent');
  assert.strictEqual(afterSecondRun, beforeSecondRun, 'FAIL: second run produced a diff in .vscode/settings.json — not idempotent');
  console.log('Assertion 3 passed: second run is a no-op (0 changes, byte-identical file)');

  // ============================================================
  // Assertion 4: conflict-preserved-with-notice.
  // ============================================================
  const conflictScratch = trackedScratchDir('mavp-vscode-conflict-');
  fs.mkdirSync(path.join(conflictScratch, '.vscode'), { recursive: true });
  const conflictSeed = {
    'files.exclude': { [VSCODE_WORKTREES_EXCLUDE_PATTERN]: false },
  };
  fs.writeFileSync(
    path.join(conflictScratch, '.vscode', 'settings.json'),
    JSON.stringify(conflictSeed, null, 2) + '\n',
    'utf8'
  );

  const { result: conflictChangeCount, lines: conflictLines } = withCapturedConsole(() =>
    mergeVscodeWorktreeExclusions(conflictScratch)
  );
  const afterConflict = readVscodeSettings(conflictScratch);
  assert.strictEqual(
    afterConflict['files.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    false,
    'FAIL: pre-existing conflicting value (false) was overwritten — must be left untouched'
  );
  // search.exclude and files.watcherExclude were absent from the seed, so they
  // ARE added — only the genuinely conflicting sub-key is skipped.
  assert.strictEqual(conflictChangeCount, 2, 'FAIL: expected exactly 2 additions (search.exclude, files.watcherExclude) alongside the 1 preserved conflict');
  const noticeLine = conflictLines.find(l => l.includes('notice') && l.includes(VSCODE_WORKTREES_EXCLUDE_PATTERN));
  assert.ok(noticeLine, `FAIL: no notice line printed for the conflicting files.exclude value; got lines: ${JSON.stringify(conflictLines)}`);
  console.log('Assertion 4 passed: pre-existing conflicting value left untouched, notice printed:', noticeLine);

  // ============================================================
  // Assertion 5 (bonus — --update wiring): merge also runs on --update against
  // an already-bootstrapped project, same idempotent contract.
  // ============================================================
  const updateScratch = trackedScratchDir('mavp-vscode-update-');
  execFileSync('node', [INSTALL_SCRIPT, updateScratch, '--stale-source-ok'], { encoding: 'utf8' });
  // Remove the freshly-seeded .vscode/settings.json to simulate an older
  // bootstrap that pre-dates this feature, then run --update.
  fs.rmSync(path.join(updateScratch, '.vscode'), { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(updateScratch, '.vscode', 'settings.json')), 'sanity: .vscode removed before --update');
  execFileSync('node', [INSTALL_SCRIPT, '--update', updateScratch, '--stale-source-ok'], { encoding: 'utf8' });
  const updateSettings = readVscodeSettings(updateScratch);
  assert.strictEqual(
    updateSettings['files.exclude'][VSCODE_WORKTREES_EXCLUDE_PATTERN],
    true,
    'FAIL: --update did not (re-)seed files.exclude worktrees pattern'
  );
  console.log('Assertion 5 passed: --update merges the same VS Code exclusions into an already-bootstrapped project');

  console.log('\nAll T-577 VS Code worktree-exclusion assertions passed.');
} finally {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
