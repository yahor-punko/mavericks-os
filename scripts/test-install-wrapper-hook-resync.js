'use strict';
// Regression test: T-336 — --update re-syncs generated wiring
// (bash wrapper + PostToolUse validator hook) with wrapper flag parity.
//
// Seeds a scratch target project with:
//   (i)  a STALE scripts/mavp-operator whose --validate line calls the pre-T-329
//        validator name (parliamentary-validator-parser-v1.js), and
//   (ii) a .claude/settings.local.json whose PostToolUse hook command references
//        the old validator name, alongside other keys (permissions, effortLevel,
//        fallbackModel) that must survive byte-for-byte.
// Runs `mavp-install.js --update <scratch>` and asserts:
//   1. wrapper --validate line now calls mavp-validator.js with "$PROJECT_ROOT";
//   2. wrapper no longer references parliamentary-validator-parser-v1.js;
//   3. settings.local.json PostToolUse hook command references mavp-validator.js
//      and no longer references the old name;
//   4. all other settings.local.json keys are unchanged (deep-equal);
//   5. the regenerated wrapper's flag set is a superset of a representative
//      live downstream wrapper's baseline flags.
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const OLD_VALIDATOR = 'parliamentary-validator-parser-v1.js';
const NEW_VALIDATOR = 'mavp-validator.js';

// Baseline wrapper flag set from a representative live downstream wrapper
// (see BACKLOG T-336 criterion 3). The regenerated template must be a
// superset of these.
const BASELINE_WRAPPER_FLAGS = [
  '--snapshot', '--handoff', '--agent', '--close-session', '--new-task',
  '--quick-task', '--apply-decomposition', '--ingest-decomposition', '--absorb-task',
  '--quick-merge', '--update-task', '--merge-task', '--update-status', '--set-status',
  '--rename-task', '--sync-status', '--reflect-skill', '--validate', '--install',
  '--strip', '--version',
];

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const scratch = makeScratchDir('mavp-install-resync-');
try {
  const scriptsDir = path.join(scratch, 'scripts');
  const claudeDir = path.join(scratch, '.claude');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });

  // (i) Seed a STALE wrapper referencing the old validator name.
  const wrapperPath = path.join(scriptsDir, 'mavp-operator');
  const staleWrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
    'PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"',
    'MAVERICKS="${MAVERICKS_HOME:-$HOME/Documents/mavericks}/scripts"',
    'if [[ "${1-}" == "--validate" ]]; then',
    '  shift',
    `  node "$MAVERICKS/${OLD_VALIDATOR}" "$PROJECT_ROOT" "$@"`,
    'else',
    '  node "$MAVERICKS/mavp-operator-dashboard.js" "$@"',
    'fi',
    '',
  ].join('\n');
  fs.writeFileSync(wrapperPath, staleWrapper, 'utf8');

  // (ii) Seed a settings.local.json with a stale PostToolUse hook command + other keys.
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const staleHookCommand =
    `INPUT=$(cat); case "$FP" in *BACKLOG.md|*TASK_STATUS.md) ;; *) exit 0 ;; esac; ` +
    `VOUT=$(node "$MAVERICKS/${OLD_VALIDATOR}" 2>&1); VCODE=$?; exit 0`;
  const seededSettings = {
    effortLevel: 'high',
    alwaysThinkingEnabled: true,
    fallbackModel: ['claude-opus-4-8'],
    permissions: {
      allow: [
        'Bash(node:*)',
        // inert stale allow-list entry — MUST be left untouched (out of scope)
        `Bash(node scripts/${OLD_VALIDATOR}:*)`,
      ],
    },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'cd . && ./scripts/mavp-operator --agent' }] },
      ],
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: staleHookCommand }] },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(seededSettings, null, 2) + '\n', 'utf8');

  // Run --update.
  execFileSync('node', [INSTALL_SCRIPT, '--update', scratch], { encoding: 'utf8' });

  // --- Assertion 1 + 2: wrapper --validate now targets mavp-validator.js with "$PROJECT_ROOT" ---
  const newWrapper = fs.readFileSync(wrapperPath, 'utf8');
  assert.ok(
    !newWrapper.includes(OLD_VALIDATOR),
    'FAIL: regenerated wrapper still references ' + OLD_VALIDATOR
  );
  assert.match(
    newWrapper,
    /node "\$MAVERICKS\/mavp-validator\.js" "\$PROJECT_ROOT" "\$@"/,
    'FAIL: wrapper --validate line does not call mavp-validator.js with "$PROJECT_ROOT"'
  );
  console.log('Assertion 1+2 passed: wrapper --validate → mavp-validator.js "$PROJECT_ROOT"');

  // --- Assertion 3: settings.local.json PostToolUse hook command re-pointed ---
  const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const updatedHookCmd = updatedSettings.hooks.PostToolUse[0].hooks[0].command;
  assert.ok(
    !updatedHookCmd.includes(OLD_VALIDATOR),
    'FAIL: PostToolUse hook command still references ' + OLD_VALIDATOR
  );
  assert.ok(
    updatedHookCmd.includes(NEW_VALIDATOR),
    'FAIL: PostToolUse hook command does not reference ' + NEW_VALIDATOR
  );
  console.log('Assertion 3 passed: PostToolUse hook command → mavp-validator.js');

  // --- Assertion 4: all other settings.local.json keys unchanged ---
  assert.deepStrictEqual(
    updatedSettings.permissions,
    seededSettings.permissions,
    'FAIL: permissions changed (inert stale allow-list entry must be left untouched)'
  );
  assert.strictEqual(updatedSettings.effortLevel, 'high', 'FAIL: effortLevel changed');
  assert.strictEqual(updatedSettings.alwaysThinkingEnabled, true, 'FAIL: alwaysThinkingEnabled changed');
  assert.deepStrictEqual(
    updatedSettings.fallbackModel,
    ['claude-opus-4-8'],
    'FAIL: fallbackModel changed'
  );
  assert.deepStrictEqual(
    updatedSettings.hooks.SessionStart,
    seededSettings.hooks.SessionStart,
    'FAIL: non-mavp SessionStart hook changed'
  );
  // The stale allow-list entry (referencing the old name) MUST still be present verbatim.
  assert.ok(
    updatedSettings.permissions.allow.includes(`Bash(node scripts/${OLD_VALIDATOR}:*)`),
    'FAIL: inert stale permission allow-list entry was rewritten (out of scope)'
  );
  // The updated hook command must differ from the stale one ONLY by the filename token.
  assert.strictEqual(
    staleHookCommand.split(OLD_VALIDATOR).join(NEW_VALIDATOR),
    updatedHookCmd,
    'FAIL: hook command changed by more than the validator filename token'
  );
  console.log('Assertion 4 passed: all other settings.local.json keys unchanged (incl. inert allow-list entry)');

  // --- Assertion 5: wrapper flag set is a superset of the baseline ---
  const missing = BASELINE_WRAPPER_FLAGS.filter(flag => !newWrapper.includes(`"${flag}"`));
  assert.strictEqual(
    missing.length,
    0,
    'FAIL: regenerated wrapper is missing baseline wrapper flags: ' + missing.join(', ')
  );
  console.log('Assertion 5 passed: wrapper flag set is a superset of the baseline (' + BASELINE_WRAPPER_FLAGS.length + ' flags)');

  console.log('\nAll T-336 wrapper/hook resync assertions passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
