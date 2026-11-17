'use strict';
const fs = require('fs');
const path = require('path');
const { printRepoIdentityHeader, guardMutatingRoot, handleHelpFlag } = require('./mavp-operator-lib.js');

// T-917: --help is the first statement, before any read or write; without it
// the literal text --help would become the stored strategy note.
if (handleHelpFlag([
  'Usage: ./scripts/mavp-operator --set-strategy-note "text"',
  '',
  'Sets PROCESS_STATE.json wave_strategy_note to the text (an empty string clears it).',
  'The note persists until --close-session. --help prints this text and exits 0',
  'before reading or writing any project state.',
])) return;

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');

printRepoIdentityHeader(ROOT, { mutating: true });

const rootGuard = guardMutatingRoot(ROOT, '--set-strategy-note');
if (rootGuard.blocked) {
  process.exit(1);
}

const note = process.argv[2] !== undefined ? process.argv[2] : null;

let current = {};
try {
  current = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
} catch { /* start fresh */ }

const updated = {
  ...current,
  wave_strategy_note: note || null,
  last_updated: new Date().toISOString().slice(0, 10),
};

fs.writeFileSync(PROCESS_STATE_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');
console.log(note ? `Strategy note set.` : `Strategy note cleared.`);
