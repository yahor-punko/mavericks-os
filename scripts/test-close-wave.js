'use strict';
// T-820 — --close-wave is the ONLY wave-advance path.
//
// Asserts, against throwaway git fixtures (never the real repo's artifacts):
//   3a  agent path without --operator-confirmed (absent, empty, blank) refuses
//       with the exact message; nothing written
//   3b  an entry left in Active tasks refuses on BOTH paths, naming the task as
//       `T-NNN still <status>` and --close-session as the sweep
//   3c  wave_goal null on a wave that is not parked refuses on BOTH paths,
//       naming --set-wave-goal
//   3d  validator exit 2 refuses on BOTH paths with no mutation (T-438 contract)
//   --  terminal path: a wrong typed answer (and EOF) aborts byte-identical
//   --  both confirmation paths reach the seven PROCESS_STATE fields, rename the
//       Active Wave heading, commit `chore: close wave N` with the right
//       trailers, and print the EXECUTION_LOG line
//   --  a parked_waves entry waives the goal requirement
//
// Every refusal asserts the three state artifacts AND the git HEAD are
// byte-identical to their pre-run snapshot — "exit 1" alone proves nothing.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const CLOSE_WAVE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-wave.js');
const { OPERATOR_CONFIRMATION_REQUIRED_MESSAGE } = require('./mavp-operator-close-wave.js');

const TMP_ROOT = path.join(os.tmpdir(), 't820-test-' + Date.now());
fs.mkdirSync(TMP_ROOT, { recursive: true });

// close-session's runValidator() resolves the validator from MAVERICKS_SCRIPTS,
// so pointing it at a directory holding only a stub validator makes the exit
// code deterministic (the same technique test-close-session-mode.js uses).
let scriptsDirOverride = null;
function makeFakeValidatorDir(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-fake-validator-'));
  fs.writeFileSync(
    path.join(dir, 'mavp-validator.js'),
    `process.stdout.write('fake validator exit ${exitCode}\\n');\nprocess.exit(${exitCode});\n`
  );
  return dir;
}

const SPAWN_ENV = (dir) => {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: scriptsDirOverride || SCRIPTS_DIR };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};

function git(dir, ...args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const STATE_FILES = ['PROCESS_STATE.json', 'PROCESS_STATE.md', 'BACKLOG.md', 'TASK_STATUS.md'];

function snapshot(dir) {
  const snap = { head: git(dir, 'rev-parse', 'HEAD') };
  for (const f of STATE_FILES) {
    const p = path.join(dir, f);
    snap[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return snap;
}

function assertUnchanged(dir, before, label) {
  const after = snapshot(dir);
  for (const k of Object.keys(before)) {
    assert.strictEqual(after[k], before[k], `${label} FAIL: ${k} changed on a refused/aborted run`);
  }
}

/**
 * @param {object} opts
 * @param {string|null} opts.activeStatus - status of a task LEFT in Active tasks (null = none)
 * @param {object} opts.state - PROCESS_STATE.json overrides
 */
function buildFixture(label, { activeStatus = null, state = {} } = {}) {
  const dir = path.join(TMP_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });

  const openBacklog = activeStatus
    ? `
### T-901 — Open task
- **Status:** ${activeStatus}
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact
`
    : '';
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture task
- **Status:** merged
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** fixture.
${openBacklog}`, 'utf8');

  const openStatus = activeStatus
    ? `### T-901 — Open task
- **Status:** ${activeStatus}
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Notes:** —

`
    : '';
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

${openStatus}## Recently completed tasks

### T-900 — Fixture task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —
`, 'utf8');

  const ps = {
    initiative: 'T-820 fixture',
    stage: 'execution',
    wave: 5,
    wave_session: 3,
    wave_status: 'architect_reviewed',
    wave_goal: 'ship the fixture',
    wave_strategy_note: 'old note',
    parked_waves: [],
    active_slices: [],
    next_action: 'T-901 → developer → leftover pointer',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 901,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: 'Wave 4: prior wave.',
    rechecks: [],
    ...state,
  };
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(ps, null, 2) + '\n', 'utf8');

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.com');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture init');
  return dir;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
}

/** Agent path: piped (non-TTY) stdin, no --interactive. */
function runAgent(dir, argv, input = '') {
  const r = spawnSync('node', [CLOSE_WAVE_PATH, ...argv], { cwd: dir, env: SPAWN_ENV(dir), input, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Terminal path: --interactive, answers written only once the matching prompt
 * text has appeared (readline over piped stdin does not deliver a second
 * buffered line to a later question — same constraint documented in
 * test-close-session-terminal-sweep.js).
 */
function runTerminal(dir, steps, extraArgv = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLOSE_WAVE_PATH, '--interactive', ...extraArgv], { cwd: dir, env: SPAWN_ENV(dir) });
    let out = '';
    let i = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runTerminal timed out at step ${i} (${steps[i] && steps[i].match}). Output so far:\n${out}`));
    }, 15000);
    function advance() {
      while (i < steps.length && out.includes(steps[i].match)) {
        if (steps[i].answer === null) child.stdin.end();
        else child.stdin.write(steps[i].answer + '\n');
        i++;
      }
    }
    child.stdout.on('data', (d) => { out += d.toString(); advance(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const FIELDS_AFTER_CLOSE = (state, expectedGoal) => {
  assert.strictEqual(state.wave, 6, `wave expected 6, got ${state.wave}`);
  assert.strictEqual(state.wave_session, 1, `wave_session expected 1, got ${state.wave_session}`);
  assert.strictEqual(state.stage, 'planning', `stage expected planning, got ${state.stage}`);
  assert.strictEqual(state.wave_strategy_note, null, `wave_strategy_note expected null, got ${JSON.stringify(state.wave_strategy_note)}`);
  assert.strictEqual(state.wave_status, 'planning', `wave_status expected planning, got ${state.wave_status}`);
  assert.strictEqual(state.wave_goal, expectedGoal, `wave_goal expected ${JSON.stringify(expectedGoal)}, got ${JSON.stringify(state.wave_goal)}`);
  assert.strictEqual(state.wave_summary, 'Wave 5: 1 task(s) completed — Fixture task.', `wave_summary unexpected: ${state.wave_summary}`);
};

async function main() {
  // ------------------------------------------------------------------ 3a
  {
    const dir = buildFixture('refuse-3a');
    const before = snapshot(dir);
    for (const [label, argv] of [
      ['no flag', []],
      ['empty value', ['--operator-confirmed', '']],
      ['blank value', ['--operator-confirmed', '   ']],
      ['flag then another flag', ['--operator-confirmed', '--next-goal', 'x']],
    ]) {
      const r = runAgent(dir, argv);
      assert.strictEqual(r.status, 1, `3a (${label}) FAIL: expected exit 1, got ${r.status}:\n${r.out}`);
      assert.ok(
        r.out.includes(OPERATOR_CONFIRMATION_REQUIRED_MESSAGE),
        `3a (${label}) FAIL: exact refusal message missing, got:\n${r.out}`
      );
      assertUnchanged(dir, before, `3a (${label})`);
    }
    // The message text is the contract — pin it literally, not just via the export.
    assert.strictEqual(
      OPERATOR_CONFIRMATION_REQUIRED_MESSAGE,
      '--close-wave needs operator confirmation. At a terminal: run ./scripts/mavp-operator --close-wave yourself and type the wave number. From an agent session: pass --operator-confirmed "<the operator\'s exact statement from this session>" — only on an explicit operator statement that the wave\'s goal is met; never inferred from "all tasks merged".'
    );
    console.log('3a passed: agent path without a non-empty --operator-confirmed refuses with the exact message, byte-identical.');
  }

  // ------------------------------------------------------------------ 3b
  {
    const dir = buildFixture('refuse-3b', { activeStatus: 'in_progress' });
    const before = snapshot(dir);
    const agent = runAgent(dir, ['--operator-confirmed', 'fixture statement']);
    assert.strictEqual(agent.status, 1, `3b agent FAIL: expected exit 1, got ${agent.status}:\n${agent.out}`);
    assert.ok(agent.out.includes('T-901 still in_progress'), `3b agent FAIL: expected "T-901 still in_progress", got:\n${agent.out}`);
    assert.ok(agent.out.includes('--close-session'), `3b agent FAIL: expected --close-session named as the sweep, got:\n${agent.out}`);
    assertUnchanged(dir, before, '3b agent');

    const term = await runTerminal(dir, []);
    assert.strictEqual(term.status, 1, `3b terminal FAIL: expected exit 1, got ${term.status}:\n${term.out}`);
    assert.ok(term.out.includes('T-901 still in_progress') && term.out.includes('--close-session'), `3b terminal FAIL:\n${term.out}`);
    assert.ok(!term.out.includes('Type the wave number'), `3b terminal FAIL: must refuse BEFORE prompting, got:\n${term.out}`);
    assertUnchanged(dir, before, '3b terminal');
    console.log('3b passed: an Active-tasks entry refuses on both paths, lists "T-901 still in_progress", names --close-session.');
  }

  // ------------------------------------------------------------------ 3c
  {
    const dir = buildFixture('refuse-3c', { state: { wave_goal: null, parked_waves: ['Wave 4 — a different wave is parked'] } });
    const before = snapshot(dir);
    const agent = runAgent(dir, ['--operator-confirmed', 'fixture statement']);
    assert.strictEqual(agent.status, 1, `3c agent FAIL: expected exit 1, got ${agent.status}:\n${agent.out}`);
    assert.ok(agent.out.includes('--set-wave-goal'), `3c agent FAIL: expected --set-wave-goal named, got:\n${agent.out}`);
    assertUnchanged(dir, before, '3c agent');

    const term = await runTerminal(dir, []);
    assert.strictEqual(term.status, 1, `3c terminal FAIL: expected exit 1, got ${term.status}:\n${term.out}`);
    assert.ok(term.out.includes('--set-wave-goal') && !term.out.includes('Type the wave number'), `3c terminal FAIL:\n${term.out}`);
    assertUnchanged(dir, before, '3c terminal');

    // A blank goal counts as no goal.
    const blank = buildFixture('refuse-3c-blank', { state: { wave_goal: '   ' } });
    const blankBefore = snapshot(blank);
    const blankRun = runAgent(blank, ['--operator-confirmed', 'fixture statement']);
    assert.strictEqual(blankRun.status, 1, `3c blank FAIL: expected exit 1:\n${blankRun.out}`);
    assertUnchanged(blank, blankBefore, '3c blank');
    console.log('3c passed: wave_goal null/blank on a wave that is not parked refuses on both paths, naming --set-wave-goal.');
  }

  // ------------------------------------------------------------------ 3d
  {
    const dir = buildFixture('refuse-3d');
    const before = snapshot(dir);
    scriptsDirOverride = makeFakeValidatorDir(2);
    const agent = runAgent(dir, ['--operator-confirmed', 'fixture statement']);
    assert.strictEqual(agent.status, 1, `3d agent FAIL: expected exit 1, got ${agent.status}:\n${agent.out}`);
    assert.ok(/validator exit 2/.test(agent.out), `3d agent FAIL: expected "validator exit 2", got:\n${agent.out}`);
    assertUnchanged(dir, before, '3d agent');

    const term = await runTerminal(dir, []);
    assert.strictEqual(term.status, 1, `3d terminal FAIL: expected exit 1, got ${term.status}:\n${term.out}`);
    assert.ok(/validator exit 2/.test(term.out) && !term.out.includes('Type the wave number'), `3d terminal FAIL:\n${term.out}`);
    assertUnchanged(dir, before, '3d terminal');
    scriptsDirOverride = null;
    console.log('3d passed: validator exit 2 refuses on both paths with no mutation.');
  }

  // ------------------------------------------- terminal wrong answer / EOF
  {
    const dir = buildFixture('terminal-abort');
    const before = snapshot(dir);
    for (const wrong of ['6', 'yes', '', '5x']) {
      const r = await runTerminal(dir, [{ match: 'Type the wave number', answer: wrong }]);
      assert.strictEqual(r.status, 1, `abort (${JSON.stringify(wrong)}) FAIL: expected exit 1, got ${r.status}:\n${r.out}`);
      assert.ok(r.out.includes('Aborted'), `abort (${JSON.stringify(wrong)}) FAIL: expected an abort line, got:\n${r.out}`);
      assert.ok(!r.out.includes('Goal for wave'), `abort (${JSON.stringify(wrong)}) FAIL: must not reach the next-goal prompt:\n${r.out}`);
      assertUnchanged(dir, before, `abort (${JSON.stringify(wrong)})`);
    }
    // EOF with no answer at all (stdin closed) is an abort too, never a silent exit 0.
    const eof = await runTerminal(dir, [{ match: 'Type the wave number', answer: null }]);
    assert.strictEqual(eof.status, 1, `abort (EOF) FAIL: expected exit 1, got ${eof.status}:\n${eof.out}`);
    assertUnchanged(dir, before, 'abort (EOF)');

    // The terminal path prints goal, summary and the git line before asking.
    const r = await runTerminal(dir, [{ match: 'Type the wave number', answer: 'no' }]);
    assert.ok(r.out.includes('Wave 5 goal: ship the fixture'), `terminal FAIL: expected "Wave 5 goal: ship the fixture", got:\n${r.out}`);
    assert.ok(r.out.includes('Wave 5: 1 task(s) completed — Fixture task.'), `terminal FAIL: expected the auto-summary line, got:\n${r.out}`);
    assert.ok(/git: main/.test(r.out), `terminal FAIL: expected the informational git status line, got:\n${r.out}`);
    console.log('terminal abort passed: wrong answers and EOF abort byte-identical; goal/summary/git lines print before the prompt.');
  }

  // ------------------------------------------------------- agent success
  {
    const dir = buildFixture('success-agent');
    const statement = 'The wave goal is met, close wave 5.';
    const r = runAgent(dir, ['--operator-confirmed', statement, '--next-goal', 'wave six goal']);
    assert.strictEqual(r.status, 0, `agent success FAIL: expected exit 0, got ${r.status}:\n${r.out}`);
    FIELDS_AFTER_CLOSE(readState(dir), 'wave six goal');

    const backlog = fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8');
    assert.ok(backlog.includes('## Wave 5 — Archived'), `agent success FAIL: expected "## Wave 5 — Archived", got:\n${backlog}`);
    assert.ok(/^## Active Wave\s*$/m.test(backlog), 'agent success FAIL: expected a fresh empty "## Active Wave" heading');
    assert.ok(fs.readFileSync(path.join(dir, 'PROCESS_STATE.md'), 'utf8').includes('6'), 'agent success FAIL: PROCESS_STATE.md should be regenerated');

    assert.strictEqual(git(dir, 'log', '-1', '--format=%s'), 'chore: close wave 5');
    const body = git(dir, 'log', '-1', '--format=%B');
    assert.ok(body.includes(`Operator-Confirmed: ${statement}`), `agent success FAIL: Operator-Confirmed trailer missing, got:\n${body}`);
    assert.ok(body.includes('Wave-Goal: ship the fixture'), `agent success FAIL: Wave-Goal trailer missing, got:\n${body}`);
    // Parsed by git itself: proves the block is a real trailer paragraph, not just text.
    assert.strictEqual(git(dir, 'log', '-1', '--format=%(trailers:key=Operator-Confirmed,valueonly)'), statement);
    assert.strictEqual(git(dir, 'log', '-1', '--format=%(trailers:key=Wave-Goal,valueonly)'), 'ship the fixture');

    const shortHash = git(dir, 'rev-parse', '--short', 'HEAD');
    const logLine = `wave close: W5 → W6 — goal: "ship the fixture" — operator-confirmed: "${statement}" — close commit ${shortHash}`;
    assert.ok(r.out.includes(logLine), `agent success FAIL: EXECUTION_LOG line missing/wrong.\nexpected: ${logLine}\ngot:\n${r.out}`);
    const printed = r.out.split('\n').find((l) => l.startsWith('wave close:'));
    assert.ok(!/commit:/i.test(printed), `agent success FAIL: the printed line must not contain the literal key form: ${printed}`);

    assert.ok(r.out.includes('Wave 5 closed — wave 6 open'), `agent success FAIL: closing line missing, got:\n${r.out}`);
    assert.ok(r.out.includes('git push') && r.out.includes('gh run watch --exit-status'), `agent success FAIL: expected push reminder + CI suffix, got:\n${r.out}`);
    assert.ok(!r.out.includes('Pushed'), 'agent success FAIL: the agent path must never push');
    console.log('agent path passed: seven fields, heading rename, commit subject + trailers, EXECUTION_LOG line, push reminder.');

    // No --next-goal -> wave_goal null.
    const dir2 = buildFixture('success-agent-nogoal');
    const r2 = runAgent(dir2, ['--operator-confirmed', 'ok']);
    assert.strictEqual(r2.status, 0, `agent no-goal FAIL:\n${r2.out}`);
    FIELDS_AFTER_CLOSE(readState(dir2), null);
  }

  // ----------------------------------------------------- terminal success
  {
    const dir = buildFixture('success-terminal');
    const r = await runTerminal(dir, [
      { match: 'Type the wave number', answer: '5' },
      { match: 'Goal for wave 6 (Enter to leave unset):', answer: 'terminal goal six' },
      { match: 'Run git push?', answer: 'n' },
    ]);
    assert.strictEqual(r.status, 0, `terminal success FAIL: expected exit 0, got ${r.status}:\n${r.out}`);
    FIELDS_AFTER_CLOSE(readState(dir), 'terminal goal six');
    assert.ok(fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8').includes('## Wave 5 — Archived'), 'terminal success FAIL: heading rename');
    assert.strictEqual(git(dir, 'log', '-1', '--format=%s'), 'chore: close wave 5');
    const body = git(dir, 'log', '-1', '--format=%B');
    assert.ok(body.includes('Operator-Confirmed: typed at terminal'), `terminal success FAIL: trailer missing, got:\n${body}`);
    assert.ok(body.includes('Wave-Goal: ship the fixture'), `terminal success FAIL: Wave-Goal trailer missing, got:\n${body}`);
    const shortHash = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.ok(
      r.out.includes(`wave close: W5 → W6 — goal: "ship the fixture" — operator-confirmed: "typed at terminal" — close commit ${shortHash}`),
      `terminal success FAIL: EXECUTION_LOG line missing, got:\n${r.out}`
    );
    assert.ok(r.out.includes('Wave 5 closed — wave 6 open'), `terminal success FAIL: closing line missing:\n${r.out}`);
    console.log('terminal path passed: typed number confirms, next-goal prompt, trailers, EXECUTION_LOG line.');

    // Empty next-goal answer leaves wave_goal null.
    const dir2 = buildFixture('success-terminal-nogoal');
    const r2 = await runTerminal(dir2, [
      { match: 'Type the wave number', answer: '5' },
      { match: 'Goal for wave 6 (Enter to leave unset):', answer: '' },
      { match: 'Run git push?', answer: 'n' },
    ]);
    assert.strictEqual(r2.status, 0, `terminal no-goal FAIL:\n${r2.out}`);
    FIELDS_AFTER_CLOSE(readState(dir2), null);
  }

  // --------------------------------------------------------- parked waiver
  {
    const state = { wave_goal: null, parked_waves: ['Wave 5 — waiting on external review'] };
    const dir = buildFixture('parked-agent', { state });
    const r = runAgent(dir, ['--operator-confirmed', 'park-close it']);
    assert.strictEqual(r.status, 0, `parked agent FAIL: expected exit 0, got ${r.status}:\n${r.out}`);
    FIELDS_AFTER_CLOSE(readState(dir), null);
    assert.ok(git(dir, 'log', '-1', '--format=%B').includes('Wave-Goal: parked — waiting on external review'), 'parked agent FAIL: Wave-Goal trailer');
    assert.ok(r.out.includes('goal: "parked — waiting on external review"'), `parked agent FAIL: EXECUTION_LOG line, got:\n${r.out}`);

    const dir2 = buildFixture('parked-terminal', { state });
    const t = await runTerminal(dir2, [
      { match: 'Type the wave number', answer: '5' },
      { match: 'Goal for wave 6', answer: '' },
      { match: 'Run git push?', answer: 'n' },
    ]);
    assert.strictEqual(t.status, 0, `parked terminal FAIL: expected exit 0, got ${t.status}:\n${t.out}`);
    assert.ok(t.out.includes('Wave 5 is parked — waiting on external review'), `parked terminal FAIL: expected the parked line, got:\n${t.out}`);
    assert.ok(!t.out.includes('Wave 5 goal:'), 'parked terminal FAIL: must print the parked line instead of a goal line');
    console.log('parked-wave waiver passed on both paths.');
  }

  // ------------------------------------- double-bump protection (Case 13)
  {
    // A refused (validator exit 2) run must not bump; after repair the re-run
    // bumps exactly once.
    const dir = buildFixture('double-bump');
    const before = readState(dir);
    scriptsDirOverride = makeFakeValidatorDir(2);
    const refused = runAgent(dir, ['--operator-confirmed', 'ok']);
    assert.strictEqual(refused.status, 1, `double-bump FAIL: expected the exit-2 run to refuse:\n${refused.out}`);
    const afterRefused = readState(dir);
    assert.strictEqual(afterRefused.wave, before.wave, 'double-bump FAIL: wave must be unchanged after a validator exit-2 refusal');
    assert.strictEqual(afterRefused.wave_session, before.wave_session, 'double-bump FAIL: wave_session must be unchanged after a refusal');

    // "Repair": the validator now exits 0; re-run.
    scriptsDirOverride = makeFakeValidatorDir(0);
    const repaired = runAgent(dir, ['--operator-confirmed', 'ok']);
    assert.strictEqual(repaired.status, 0, `double-bump FAIL: repaired re-run should succeed:\n${repaired.out}`);
    assert.strictEqual(readState(dir).wave, before.wave + 1, `double-bump FAIL: expected exactly one bump, got ${readState(dir).wave}`);
    console.log('Case 13 protection passed: a validator exit-2 refusal leaves wave/wave_session unchanged; the repaired re-run bumps exactly once.');
  }

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  console.log('\nAll T-820 --close-wave assertions passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
