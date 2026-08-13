'use strict';
// Regression test: T-648 — `wave_goal` and `wave_strategy_note` must be
// cleared ONLY on a wave-advance close (waveComplete), never on every close.
//
// The incident (observed twice in one session): wave-78 close left
// `wave_goal` describing already-shipped work because the interactive prompt
// only fires `if (!currentWaveGoal)` — a stale non-empty goal suppressed its
// own replacement. wave-79 close carried the SAME defect. Symmetrically,
// `wave_strategy_note: null` in updateProcessStateJson() was unconditional,
// so a mid-wave close erased intra-wave context the (still open) wave still
// needed — the real wave-78 note loss.
//
// The fix scopes both clears to the `waveComplete` boolean the function
// already computes, mirroring `wave_session`'s existing reset-on-advance
// contract. This file asserts:
//   Part 1 — non-interactive, wave-complete close clears BOTH fields.
//   Part 2 — non-interactive, mid-wave close preserves BOTH byte-for-byte.
//   Part 3 — interactive, wave-complete close: the wave-goal prompt fires
//            despite a preset goal, and an empty answer leaves null (never
//            restores the stale value).
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');

const TMP_ROOT = path.join(os.tmpdir(), 't648-test-' + Date.now());
fs.mkdirSync(TMP_ROOT, { recursive: true });

function newFixtureDir(label) {
  const dir = path.join(TMP_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCloseSession(dir, argv = ['--non-interactive'], input = '') {
  const r = spawnSync('node', [CLOSE_SESSION_PATH, ...argv], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    input,
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Interactive multi-prompt runs cannot use spawnSync's static `input`
 * buffer: readline over a piped, already-EOF'd stdin only resolves the
 * FIRST `rl.question()` call — a second pending question never receives
 * its buffered answer and the process simply exits once the event loop
 * drains (an unresolved Promise does not keep Node alive on its own). This
 * is the same constraint documented in test-close-session-terminal-sweep.js
 * ("readline over a piped, EOF'd stdin only delivers the first buffered
 * line"), verified directly against a two-question readline harness while
 * building this test.
 *
 * Real interactive input never has this problem because each keystroke/line
 * arrives as its own stream event; this helper reproduces that by spawning
 * the process live and writing each answer only once its matching prompt
 * text has actually appeared in the accumulated output, in order.
 *
 * @param {string} dir - fixture directory (becomes MAVERICKS_PROJECT_ROOT)
 * @param {string[]} argv - close-session CLI args (e.g. ['--interactive'])
 * @param {Array<{match: string, answer: string}>} steps - in order, the
 *   substring that must appear in cumulative stdout before the given answer
 *   line is written to stdin
 * @returns {Promise<{status: number|null, out: string}>}
 */
function runCloseSessionInteractiveSequential(dir, argv, steps) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLOSE_SESSION_PATH, ...argv], {
      cwd: dir,
      env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    });
    let out = '';
    let stepIndex = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runCloseSessionInteractiveSequential timed out waiting on step ${stepIndex} (${steps[stepIndex] && steps[stepIndex].match}). Output so far:\n${out}`));
    }, 15000);
    function maybeAdvance() {
      while (stepIndex < steps.length && out.includes(steps[stepIndex].match)) {
        child.stdin.write(steps[stepIndex].answer + '\n');
        stepIndex++;
      }
    }
    child.stdout.on('data', (d) => { out += d.toString(); maybeAdvance(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
}

function writeProcessState(dir, overrides) {
  const state = {
    initiative: 'T-648 test fixture',
    stage: 'execution',
    wave: 5,
    wave_session: 3,
    wave_status: 'execution',
    wave_goal: 'old goal',
    wave_strategy_note: 'old note',
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 900,
    last_updated: '2026-08-01',
    deploy_contours: 0,
    wave_summary: 'Wave 4: prior wave.',
    rechecks: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * @param {string} taskStatus - the single fixture task's status ('merged'
 *   closes the wave via the ALREADY_TERMINAL_STATUSES auto-archive path;
 *   'in_progress' leaves it in Active tasks, holding the wave open).
 */
function buildFixture(dir, taskStatus, processStateOverrides) {
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture task
- **Status:** ${taskStatus}
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-900 — Fixture task
- **Status:** ${taskStatus}
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** artifact: fixture
- **Notes:** —

## Recently completed tasks
`, 'utf8');

  writeProcessState(dir, processStateOverrides);
}

// ---------------------------------------------------------------------------
// Part 1 — wave-complete non-interactive close clears BOTH wave_goal and
// wave_strategy_note. Kills the "clearing removed entirely" mutant: without
// the waveComplete-gated clear in updateProcessStateJson(), this assertion
// fails because both fields would still read "old goal"/"old note".
// ---------------------------------------------------------------------------
const completeDir = newFixtureDir('wave-complete');
buildFixture(completeDir, 'merged');

const completeOut = runCloseSession(completeDir).out;
assert.ok(
  completeOut.includes('Wave 5 complete'),
  `Part 1 FAIL: expected the close to announce "Wave 5 complete", got:\n${completeOut}`
);

const completeState = readState(completeDir);
assert.strictEqual(completeState.wave, 6, `Part 1 FAIL: expected wave 5 → 6, got ${completeState.wave}`);
assert.strictEqual(
  completeState.wave_goal,
  null,
  `Part 1 FAIL: expected wave_goal cleared to null on wave-complete close, got ${JSON.stringify(completeState.wave_goal)}`
);
assert.strictEqual(
  completeState.wave_strategy_note,
  null,
  `Part 1 FAIL: expected wave_strategy_note cleared to null on wave-complete close, got ${JSON.stringify(completeState.wave_strategy_note)}`
);

console.log('Part 1 (wave-complete close clears wave_goal AND wave_strategy_note) passed.');

// ---------------------------------------------------------------------------
// Part 2 — the SAME fixture shape but mid-wave (one task still in_progress)
// preserves BOTH fields byte-for-byte. Kills the "clearing made
// unconditional" mutant: if wave_strategy_note: null (or an unconditional
// wave_goal clear) were reinstated outside the waveComplete branch, this
// assertion fails because both fields would read null instead of surviving.
// ---------------------------------------------------------------------------
const midWaveDir = newFixtureDir('mid-wave');
buildFixture(midWaveDir, 'in_progress');

const midWaveOut = runCloseSession(midWaveDir).out;
assert.ok(
  midWaveOut.includes('stays open'),
  `Part 2 FAIL: expected the wave to stay open, got:\n${midWaveOut}`
);

const midWaveState = readState(midWaveDir);
assert.strictEqual(midWaveState.wave, 5, `Part 2 FAIL: expected wave to stay at 5, got ${midWaveState.wave}`);
assert.strictEqual(
  midWaveState.wave_goal,
  'old goal',
  `Part 2 FAIL: expected wave_goal preserved verbatim on a mid-wave close, got ${JSON.stringify(midWaveState.wave_goal)}`
);
assert.strictEqual(
  midWaveState.wave_strategy_note,
  'old note',
  `Part 2 FAIL: expected wave_strategy_note preserved verbatim on a mid-wave close, got ${JSON.stringify(midWaveState.wave_strategy_note)}`
);

console.log('Part 2 (mid-wave close preserves wave_goal AND wave_strategy_note byte-for-byte) passed.');

// ---------------------------------------------------------------------------
// Part 3 — interactive mode, wave-complete close, with a preset (non-empty)
// wave_goal already on disk. The wave-goal prompt must fire regardless (the
// pre-fix gate was `if (!currentWaveGoal)`, which a stale non-empty goal
// would suppress), and answering it with an empty line must leave wave_goal
// null rather than falling back to the preset "old goal" value.
//
// Two prompts fire in order: the unconditional "Next action" prompt (blank
// — accept the computed default), then the wave-goal prompt (blank — skip).
// Answered sequentially via runCloseSessionInteractiveSequential() — see its
// doc comment for why a static piped-input buffer cannot deliver both.
// ---------------------------------------------------------------------------
async function runPart3() {
  const interactiveDir = newFixtureDir('interactive-wave-complete');
  buildFixture(interactiveDir, 'merged');

  const { out: interactiveOut } = await runCloseSessionInteractiveSequential(interactiveDir, ['--interactive'], [
    { match: 'Next action [', answer: '' },
    { match: 'Enter wave goal', answer: '' },
    // A wave-complete close ends with a separate "Run git push?" prompt
    // (its own readline interface, after PROCESS_STATE.json is already
    // written) — decline it so the child process exits.
    { match: 'Run git push?', answer: 'n' },
  ]);

  assert.ok(
    interactiveOut.includes('Wave 5 complete'),
    `Part 3 FAIL: expected the interactive close to announce "Wave 5 complete", got:\n${interactiveOut}`
  );
  assert.ok(
    interactiveOut.includes('Enter wave goal'),
    `Part 3 FAIL: expected the wave-goal prompt to fire on a wave-complete close despite a preset goal, got:\n${interactiveOut}`
  );

  const interactiveState = readState(interactiveDir);
  assert.strictEqual(interactiveState.wave, 6, `Part 3 FAIL: expected wave 5 → 6 interactively, got ${interactiveState.wave}`);
  assert.strictEqual(
    interactiveState.wave_goal,
    null,
    `Part 3 FAIL: expected an empty prompt answer to leave wave_goal null (not restore "old goal"), got ${JSON.stringify(interactiveState.wave_goal)}`
  );
  assert.strictEqual(
    interactiveState.wave_strategy_note,
    null,
    `Part 3 FAIL: expected wave_strategy_note cleared on the interactive wave-complete close, got ${JSON.stringify(interactiveState.wave_strategy_note)}`
  );

  console.log('Part 3 (interactive wave-complete close: prompt fires despite preset goal; empty answer leaves null) passed.');
  console.log('\nAll T-648 wave_goal/wave_strategy_note scoping assertions passed.');
}

runPart3().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
