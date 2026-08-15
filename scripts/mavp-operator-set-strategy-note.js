'use strict';
const fs = require('fs');
const path = require('path');
const { printRepoIdentityHeader, guardMutatingRoot } = require('./mavp-operator-lib.js');

const ROOT = path.resolve(__dirname, '..');
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
