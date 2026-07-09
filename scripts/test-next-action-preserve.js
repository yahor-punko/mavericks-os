'use strict';
// Regression test: T-237 — next_action preservation logic in updateProcessStateJson

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');

// Use a temp dir so the module reads/writes there without touching the real project
const TMP_DIR = path.join(os.tmpdir(), 't237-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

// Minimal BACKLOG.md so parseBacklogStatuses / filterStaleSlices don't crash
fs.writeFileSync(path.join(TMP_DIR, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n', 'utf8');
// TASK_STATUS.md is not required by updateProcessStateJson; create empty to be safe
fs.writeFileSync(path.join(TMP_DIR, 'TASK_STATUS.md'), '', 'utf8');

// Set env var before requiring the module so ROOT resolves to TMP_DIR
process.env.MAVERICKS_PROJECT_ROOT = TMP_DIR;

const { updateProcessStateJson } = require('./mavp-operator-close-session.js');

const PS_PATH = path.join(TMP_DIR, 'PROCESS_STATE.json');

function writeState(obj) {
  fs.writeFileSync(PS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readState() {
  return JSON.parse(fs.readFileSync(PS_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Case 1: preserve — current.next_action not empty, wave NOT complete,
//         explicitNextAction: false  →  result = current.next_action
// ---------------------------------------------------------------------------
writeState({
  wave: 1,
  wave_session: 3,
  next_action: 'T-100 → developer → implement thing',
  active_slices: [],
});

updateProcessStateJson(
  'T-200 → qa → review',   // computed nextAction (should be ignored)
  false,                    // waveComplete = false
  null,                     // summaryValue
  { explicitNextAction: false }
);

const case1 = readState();
assert.strictEqual(
  case1.next_action,
  'T-100 → developer → implement thing',
  'Case 1 FAIL: existing next_action should be preserved when wave not complete and no explicit override'
);

// ---------------------------------------------------------------------------
// Case 2: compute-fallback — current.next_action null, wave NOT complete
//         →  result = computed nextAction
// ---------------------------------------------------------------------------
writeState({
  wave: 1,
  wave_session: 1,
  next_action: null,
  active_slices: [],
});

updateProcessStateJson(
  'T-300 → developer → new thing',  // computed nextAction
  false,                              // waveComplete = false
  null,
  {}
);

const case2 = readState();
assert.strictEqual(
  case2.next_action,
  'T-300 → developer → new thing',
  'Case 2 FAIL: computed nextAction should be used when current.next_action is null'
);

// ---------------------------------------------------------------------------
// Case 3: wave-complete reset — current.next_action not empty, waveComplete: true
//         →  result = null (when no nextAction passed)
// ---------------------------------------------------------------------------
writeState({
  wave: 2,
  wave_session: 2,
  next_action: 'T-400 → developer → old action',
  active_slices: [],
});

updateProcessStateJson(
  null,    // no computed nextAction
  true,    // waveComplete = true
  null,
  {}
);

const case3 = readState();
assert.strictEqual(
  case3.next_action,
  null,
  'Case 3 FAIL: next_action should be reset to null on wave complete with no nextAction'
);

// Also verify wave was incremented
assert.strictEqual(case3.wave, 3, 'Case 3 FAIL: wave should have been incremented on wave complete');

// ---------------------------------------------------------------------------
// Case 4: explicit override — current.next_action not empty, explicitNextAction: true
//         →  result = passed nextAction
// ---------------------------------------------------------------------------
writeState({
  wave: 3,
  wave_session: 1,
  next_action: 'T-500 → developer → preserve this',
  active_slices: [],
});

updateProcessStateJson(
  'T-600 → qa → explicit override',  // explicit operator override
  false,                               // waveComplete = false
  null,
  { explicitNextAction: true }
);

const case4 = readState();
assert.strictEqual(
  case4.next_action,
  'T-600 → qa → explicit override',
  'Case 4 FAIL: explicit nextAction should override current.next_action'
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-237 assertions passed.');
