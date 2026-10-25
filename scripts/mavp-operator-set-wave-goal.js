'use strict';
// T-819 — --set-wave-goal operator command.
//
// Before this command the only setter of PROCESS_STATE.json's wave_goal was the
// interactive prompt inside --close-session, which a non-interactive (agent-run)
// close never reaches — so wave_goal was routinely null. This is the sanctioned
// non-interactive write path, a sibling of --set-strategy-note.
//
//   --set-wave-goal "text"   sets wave_goal to the text
//   --set-wave-goal ""       sets wave_goal to null
//   (no argument)            usage + exit 1, BEFORE any read or write
//
// Only wave_goal and last_updated change; PROCESS_STATE.md is regenerated from
// the JSON and the validator runs once at the end.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  printRepoIdentityHeader,
  guardMutatingRoot,
  generateProcessStateMd,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');
const VALIDATOR = path.join(__dirname, 'mavp-validator.js');

// Missing argument: refuse before any read or write (and before any header /
// root-guard output that could imply a mutation is under way).
const raw = process.argv[2];
if (raw === undefined) {
  console.error('Usage: --set-wave-goal "text" (empty string clears)');
  process.exit(1);
}

printRepoIdentityHeader(ROOT, { mutating: true });

const rootGuard = guardMutatingRoot(ROOT, '--set-wave-goal');
if (rootGuard.blocked) {
  process.exit(1);
}

let current = {};
try {
  current = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
} catch { /* start fresh */ }

const goal = raw.trim().length === 0 ? null : raw;

const updated = {
  ...current,
  wave_goal: goal,
  last_updated: new Date().toISOString().slice(0, 10),
};

fs.writeFileSync(PROCESS_STATE_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');
generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);

console.log(goal === null ? 'Wave goal cleared.' : `Wave goal set: ${goal}`);

// Validator runs once at the end (same contract as the other ritual commands).
let validatorExitCode = 0;
try {
  const output = execSync(`node "${VALIDATOR}" "${ROOT}"`, { encoding: 'utf8', stdio: 'pipe' });
  if (output && output.trim()) console.log(output.trim());
  console.log('Validator: healthy (exit 0)');
} catch (err) {
  validatorExitCode = err.status || 2;
  const combined = [(err.stdout || '').trim(), (err.stderr || '').trim()].filter(Boolean).join('\n');
  if (combined) console.log(combined);
  console.log(
    validatorExitCode === 1
      ? 'Validator: drifting (exit 1) — review warnings above'
      : `Validator: repair required (exit ${validatorExitCode}) — fix artifacts before proceeding`
  );
}
process.exitCode = validatorExitCode;
