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
// T-653 — same waveComplete discriminator, same block: `wave_status` must
// reset to "planning" on wave advance (Part 1) and stay byte-unchanged on a
// mid-wave close (Part 2). Without this, the ending wave's gate state (e.g.
// "architect_reviewed") survives the `...current` spread verbatim onto the
// freshly opened wave, letting it falsely read as already past its own
// architect-review gate. Fixture default below is "architect_reviewed" so
// Part 1 has a real leaked-value regression to detect (not just a fresh
// "planning" that happened to already be correct).
//
// T-820 — the wave no longer advances in --close-session at all. The clears
// above now happen ONLY in --close-wave (updateProcessStateJson(..., true)):
// Part 1 asserts --close-session on a wave-complete state leaves wave,
// wave_goal, wave_strategy_note and wave_status byte-unchanged, and that the
// SAME clears then happen via --close-wave's agent path. Part 3 is the
// interactive --close-session (no goal prompt replacement, no increment) plus
// the --close-wave terminal path's goal prompt for wave N+1.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');
const CLOSE_WAVE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-wave.js');

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
function runCloseSessionInteractiveSequential(dir, argv, steps, scriptPath = CLOSE_SESSION_PATH) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...argv], {
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

// --close-wave commits, so its fixture needs a real (pinned-branch) git repo.
function initGit(dir) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const git = (...a) => spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture init');
}

function runCloseWave(dir, argv, input = '') {
  const r = spawnSync('node', [CLOSE_WAVE_PATH, ...argv], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    input,
    encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function runCloseWaveInteractiveSequential(dir, argv, steps) {
  return runCloseSessionInteractiveSequential(dir, argv, steps, CLOSE_WAVE_PATH);
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
    wave_status: 'architect_reviewed',
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
initGit(completeDir);

// 1a — --close-session NEVER advances the wave (T-820): the same empty-Active-
// tasks state that used to complete the wave now leaves every wave-scoped
// field and the Active Wave heading byte-unchanged.
const completeOut = runCloseSession(completeDir).out;
assert.ok(
  completeOut.includes('Wave 5 \u2014 all tasks merged; wave stays open until the operator confirms the goal is met and --close-wave runs (goal: old goal)'),
  `Part 1 FAIL: expected the T-820 announcement for an empty Active tasks section, got:\n${completeOut}`
);

const keptState = readState(completeDir);
assert.strictEqual(keptState.wave, 5, `Part 1 FAIL: --close-session must not advance the wave, got ${keptState.wave}`);
assert.strictEqual(keptState.wave_session, 4, `Part 1 FAIL: wave_session must still increment on --close-session, got ${keptState.wave_session}`);
assert.strictEqual(keptState.wave_goal, 'old goal', `Part 1 FAIL: wave_goal must be untouched by --close-session, got ${JSON.stringify(keptState.wave_goal)}`);
assert.strictEqual(keptState.wave_strategy_note, 'old note', `Part 1 FAIL: wave_strategy_note must be untouched by --close-session, got ${JSON.stringify(keptState.wave_strategy_note)}`);
assert.strictEqual(keptState.wave_status, 'architect_reviewed', `Part 1 FAIL: wave_status must be untouched by --close-session, got ${JSON.stringify(keptState.wave_status)}`);
assert.ok(
  fs.readFileSync(path.join(completeDir, 'BACKLOG.md'), 'utf8').includes('## Active Wave'),
  'Part 1 FAIL: the Active Wave heading must survive --close-session'
);

// 1b — the T-648/T-653 clears now belong to --close-wave. Kills the "clearing
// removed entirely" mutant: without the waveComplete-gated clear in
// updateProcessStateJson(), the three fields below would keep their old values.
const closeWaveRun = runCloseWave(completeDir, ['--operator-confirmed', 'fixture statement']);
assert.strictEqual(closeWaveRun.status, 0, `Part 1 FAIL: --close-wave expected exit 0, got ${closeWaveRun.status}:\n${closeWaveRun.out}`);
const completeState = readState(completeDir);
assert.strictEqual(completeState.wave, 6, `Part 1 FAIL: expected wave 5 \u2192 6 via --close-wave, got ${completeState.wave}`);
assert.strictEqual(
  completeState.wave_goal,
  null,
  `Part 1 FAIL: expected wave_goal cleared to null on --close-wave, got ${JSON.stringify(completeState.wave_goal)}`
);
assert.strictEqual(
  completeState.wave_strategy_note,
  null,
  `Part 1 FAIL: expected wave_strategy_note cleared to null on --close-wave, got ${JSON.stringify(completeState.wave_strategy_note)}`
);
assert.strictEqual(
  completeState.wave_status,
  'planning',
  `Part 1 FAIL: expected wave_status reset to "planning" on --close-wave, got ${JSON.stringify(completeState.wave_status)}`
);

console.log('Part 1 (--close-session leaves wave fields untouched; --close-wave clears wave_goal, wave_strategy_note AND resets wave_status) passed.');

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
assert.strictEqual(
  midWaveState.wave_status,
  'architect_reviewed',
  `Part 2 FAIL: expected wave_status preserved byte-unchanged on a mid-wave close, got ${JSON.stringify(midWaveState.wave_status)}`
);

console.log('Part 2 (mid-wave close preserves wave_goal, wave_strategy_note AND wave_status byte-for-byte) passed.');

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
  // 3a — interactive --close-session on a wave-complete state: a preset goal is
  // NOT replaced (the replacement prompt moved to --close-wave), so only the
  // "Next action" prompt and the push prompt fire; the wave does not advance.
  const interactiveDir = newFixtureDir('interactive-wave-complete');
  buildFixture(interactiveDir, 'merged');
  initGit(interactiveDir);

  const { out: interactiveOut } = await runCloseSessionInteractiveSequential(interactiveDir, ['--interactive'], [
    { match: 'Next action [', answer: '' },
    // An empty Active tasks section still ends with the separate "Run git
    // push?" prompt — decline it so the child process exits.
    { match: 'Run git push?', answer: 'n' },
  ]);

  assert.ok(
    interactiveOut.includes('wave stays open until the operator confirms the goal is met and --close-wave runs (goal: old goal)'),
    `Part 3 FAIL: expected the interactive close to print the T-820 announcement, got:\n${interactiveOut}`
  );
  assert.ok(
    !interactiveOut.includes('Enter wave goal'),
    `Part 3 FAIL: the wave-goal replacement prompt must not fire on --close-session when a goal is preset, got:\n${interactiveOut}`
  );
  const keptInteractive = readState(interactiveDir);
  assert.strictEqual(keptInteractive.wave, 5, `Part 3 FAIL: interactive --close-session must not advance the wave, got ${keptInteractive.wave}`);
  assert.strictEqual(keptInteractive.wave_goal, 'old goal', `Part 3 FAIL: preset wave_goal must survive, got ${JSON.stringify(keptInteractive.wave_goal)}`);
  assert.strictEqual(keptInteractive.wave_strategy_note, 'old note', `Part 3 FAIL: wave_strategy_note must survive, got ${JSON.stringify(keptInteractive.wave_strategy_note)}`);
  assert.strictEqual(keptInteractive.wave_status, 'architect_reviewed', `Part 3 FAIL: wave_status must survive, got ${JSON.stringify(keptInteractive.wave_status)}`);

  // 3b — the terminal --close-wave path: the typed wave number confirms, the
  // "Goal for wave N+1" prompt fires, and an empty answer leaves wave_goal null
  // (never restoring the stale value).
  const { out: terminalOut } = await runCloseWaveInteractiveSequential(interactiveDir, ['--interactive'], [
    { match: 'Type the wave number', answer: '5' },
    { match: 'Goal for wave 6 (Enter to leave unset):', answer: '' },
    { match: 'Run git push?', answer: 'n' },
  ]);
  assert.ok(terminalOut.includes('Wave 5 closed'), `Part 3 FAIL: expected the terminal close to finish, got:\n${terminalOut}`);
  const terminalState = readState(interactiveDir);
  assert.strictEqual(terminalState.wave, 6, `Part 3 FAIL: expected wave 5 \u2192 6 via the terminal path, got ${terminalState.wave}`);
  assert.strictEqual(
    terminalState.wave_goal,
    null,
    `Part 3 FAIL: expected an empty prompt answer to leave wave_goal null (not restore "old goal"), got ${JSON.stringify(terminalState.wave_goal)}`
  );
  assert.strictEqual(terminalState.wave_strategy_note, null, `Part 3 FAIL: expected wave_strategy_note cleared, got ${JSON.stringify(terminalState.wave_strategy_note)}`);
  assert.strictEqual(terminalState.wave_status, 'planning', `Part 3 FAIL: expected wave_status reset to "planning", got ${JSON.stringify(terminalState.wave_status)}`);

  console.log('Part 3 (interactive --close-session: no increment, no goal replacement; --close-wave terminal path: goal prompt for N+1, empty answer leaves null) passed.');
  console.log('\nAll T-648/T-820 wave_goal/wave_strategy_note scoping assertions passed.');
}

runPart3().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
