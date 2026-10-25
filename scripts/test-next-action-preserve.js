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
//         T-820: waveComplete: true is reached ONLY by --close-wave; Case 5
//         below asserts that end to end and that --close-session never does.
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
// Case 5 (T-820): end to end on an empty Active tasks section with a leftover
//         next_action pointer. --close-session preserves next_action and does
//         NOT increment the wave; --close-wave is the only path that increments
//         it and clears the pointer (the Case 3 contract, reached for real).
// ---------------------------------------------------------------------------
{
  const { spawnSync } = require('node:child_process');
  const dir = path.join(TMP_DIR, 'case5');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n\n## Recently completed tasks\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-820 case 5',
    stage: 'execution',
    wave: 4,
    wave_session: 2,
    wave_status: 'execution',
    wave_goal: 'case 5 goal',
    parked_waves: [],
    active_slices: [],
    next_action: 'T-400 → developer → leftover pointer',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 400,
    last_updated: '2020-01-01',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n', 'utf8');
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith('GIT_')) delete cleanEnv[k];
  const git = (...a) => spawnSync('git', a, { cwd: dir, env: cleanEnv, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture init');

  const env = { ...cleanEnv, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: __dirname };
  const session = spawnSync('node', [path.join(__dirname, 'mavp-operator-close-session.js'), '--non-interactive'], { cwd: dir, env, input: '', encoding: 'utf8' });
  assert.strictEqual(session.status, 0, `Case 5 FAIL: --close-session exited ${session.status}:\n${session.stdout}${session.stderr}`);
  const afterSession = JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
  assert.strictEqual(afterSession.wave, 4, `Case 5 FAIL: --close-session must not increment the wave, got ${afterSession.wave}`);
  assert.strictEqual(afterSession.wave_session, 3, `Case 5 FAIL: wave_session must tick 2 → 3, got ${afterSession.wave_session}`);
  assert.strictEqual(
    afterSession.next_action,
    'T-400 → developer → leftover pointer',
    `Case 5 FAIL: --close-session must preserve next_action on an empty Active tasks section, got ${JSON.stringify(afterSession.next_action)}`
  );

  const wave = spawnSync('node', [path.join(__dirname, 'mavp-operator-close-wave.js'), '--operator-confirmed', 'case 5 statement'], { cwd: dir, env, input: '', encoding: 'utf8' });
  assert.strictEqual(wave.status, 0, `Case 5 FAIL: --close-wave exited ${wave.status}:\n${wave.stdout}${wave.stderr}`);
  const afterWave = JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
  assert.strictEqual(afterWave.wave, 5, `Case 5 FAIL: --close-wave must increment the wave to 5, got ${afterWave.wave}`);
  assert.strictEqual(afterWave.next_action, null, `Case 5 FAIL: --close-wave must clear next_action, got ${JSON.stringify(afterWave.next_action)}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('All T-237 assertions passed.');
