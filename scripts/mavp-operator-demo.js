#!/usr/bin/env node

/**
 * mavp-operator-demo.js
 *
 * `./scripts/mavp-operator --demo` — a self-contained, narrated walkthrough of
 * the operator loop against a THROWAWAY example project. No docs required: run
 * it and watch the dashboard, the lifecycle, and the drift-catch-fix loop.
 *
 * Every phase builds its own fixture under os.tmpdir() from templates/, then
 * shells out to the REAL operator tools (dashboard / set-status / validator)
 * via child_process — this script never require()s mavp-operator-lib.js or any
 * mutator script in-process, because ROOT resolution would bind to the real
 * repo instead of the fixture. The fixture is always removed afterwards
 * (normal exit or SIGINT) unless --keep is passed.
 *
 * Usage:
 *   ./scripts/mavp-operator --demo [--phase dashboard|lifecycle|drift|all]
 *                                  [--step] [--keep] [--no-color] [--reveal <ms>]
 *
 *   --phase <name>   Which part of the walkthrough to run. Default: all.
 *                     Each phase builds its OWN fixture (they do not share
 *                     state). `drift` seeds its fixture directly to qa_passed
 *                     in both files rather than replaying the lifecycle phase,
 *                     so it stays short on its own.
 *   --reveal <ms>    Pace the walkthrough as discrete full-screen frames for
 *                     capture: clear the screen, show the banner + narration,
 *                     pause <ms>, show the tool output, pause <ms> again.
 *                     Absent or 0 = today's behavior, byte-for-byte (no clears,
 *                     no pauses). Independent of --step (TTY-only Enter pause).
 *   --step / --pause Wait for Enter between banners. Only when stdin is a TTY;
 *                     ignored otherwise (e.g. when piped or run in CI).
 *   --keep           Skip fixture cleanup and print the fixture path(s).
 *   --no-color       Disable ANSI colour in this script's own banners AND
 *                     strip ANSI escape sequences from captured child output
 *                     (set-status / validator hardcode colour codes). Also
 *                     honoured via the NO_COLOR env var.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

const DASHBOARD_SCRIPT = path.join(SCRIPT_DIR, 'mavp-operator-dashboard.js');
const SET_STATUS_SCRIPT = path.join(SCRIPT_DIR, 'mavp-operator-set-status.js');
const VALIDATOR_SCRIPT = path.join(SCRIPT_DIR, 'mavp-validator.js');
const HANDOFF_SCRIPT = path.join(SCRIPT_DIR, 'mavp-operator-handoff.js');
const AGENT_SCRIPT = path.join(SCRIPT_DIR, 'mavp-operator-agent.js');

// mavp-version.js is a pure constant module — it does not resolve ROOT or touch
// the filesystem, so requiring it in-process (unlike the mutator scripts, which
// are always shelled out to) is safe and does not risk binding to the real repo.
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// Fixture bookkeeping — every fixture directory this run creates is tracked
// here so a normal exit OR a SIGINT always cleans it up (unless --keep).
// ---------------------------------------------------------------------------
const activeFixtures = new Set();
let KEEP = false;

// Test-only hook (not a public/documented flag): when set, phaseDashboard
// prints the fixture path and holds briefly right after building its fixture
// so scripts/test-operator-demo.js can deterministically verify SIGINT
// cleanup without racing real-world process timing.
const TEST_HOLD_MS = Number(process.env.__MAVP_DEMO_TEST_HOLD_MS__ || 0);

function cleanupFixture(dir) {
  if (!activeFixtures.has(dir)) return;
  activeFixtures.delete(dir);
  if (KEEP) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // best-effort cleanup — nothing more we can do here
  }
}

function cleanupAllFixtures() {
  for (const dir of [...activeFixtures]) {
    cleanupFixture(dir);
  }
}

process.on('exit', cleanupAllFixtures);
process.on('SIGINT', () => {
  cleanupAllFixtures();
  process.exit(130);
});

// ---------------------------------------------------------------------------
// Safety guard — refuse to build/mutate/run anything outside os.tmpdir().
// This is the last line of defense against ever touching the real repo.
// ---------------------------------------------------------------------------
function assertUnderTmpDir(targetPath) {
  const resolved = path.resolve(targetPath);
  const tmpRoot = path.resolve(os.tmpdir());
  const prefix = tmpRoot.endsWith(path.sep) ? tmpRoot : tmpRoot + path.sep;
  if (resolved !== tmpRoot && !resolved.startsWith(prefix)) {
    throw new Error(`Refusing to operate on a path outside os.tmpdir(): ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Fixture construction — copies all four live-state templates, then applies
// the minimal edits needed for a clean demo (Repo field, last_updated,
// initiative). Mirrors what a real bootstrapped project looks like on day 1.
// ---------------------------------------------------------------------------
function buildFixture(label) {
  const dir = path.join(
    os.tmpdir(),
    `mavp-demo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  assertUnderTmpDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  activeFixtures.add(dir);

  const today = new Date().toISOString().slice(0, 10);

  let backlog = fs.readFileSync(path.join(TEMPLATES_DIR, 'BACKLOG_TEMPLATE.md'), 'utf8');
  const taskStatus = fs.readFileSync(path.join(TEMPLATES_DIR, 'TASK_STATUS_TEMPLATE.md'), 'utf8');
  let processStateMd = fs.readFileSync(path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.md'), 'utf8');
  const processStateJsonRaw = fs.readFileSync(
    path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.json'),
    'utf8'
  );

  // The validator's Repo check only reads BACKLOG.md (TASK_STATUS template has
  // no Repo field at all) — fill in the placeholder so the lifecycle phase's
  // in_progress/ready_for_qa/qa_passed transitions stay clean.
  backlog = backlog.replace(
    '- **Repo:** [optional — repo name(s) this task touches, e.g. example-service]',
    '- **Repo:** demo-service'
  );

  // PROCESS_STATE.md placeholders — otherwise the dashboard phase leaks raw
  // template placeholder text ([Describe the initiative…], [YYYY-MM-DD], etc.)
  // into the captured output. Use the SAME `today` value used for the JSON's
  // last_updated below, so the two artifacts agree.
  processStateMd = processStateMd
    .replace('[Describe the initiative in 1-2 lines]', 'Mavericks demo walkthrough')
    .replace('- [YYYY-MM-DD]: Initiative started.', `- ${today}: Initiative started.`)
    .replace('- [next task → owner]', '- T-001 → developer')
    // trailing "## Last update\n[YYYY-MM-DD]" — only one [YYYY-MM-DD] placeholder
    // remains at this point, so a plain replace() targets it unambiguously.
    .replace('[YYYY-MM-DD]', today);

  const processState = JSON.parse(processStateJsonRaw);
  processState.last_updated = today;
  processState.initiative = 'Mavericks demo walkthrough';
  processState.mavericks_version = MAVERICKS_VERSION;

  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), taskStatus, 'utf8');
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.md'), processStateMd, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'PROCESS_STATE.json'),
    JSON.stringify(processState, null, 2) + '\n',
    'utf8'
  );

  return dir;
}

/** Directly overwrite the Status field of the (single) task block in a fixture file. */
function setStatusFieldDirect(filePath, newStatus) {
  assertUnderTmpDir(filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/(- \*\*Status:\*\*)\s+\S+/, `$1 ${newStatus}`);
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Seed both artifacts straight to the same status (used by the drift phase). */
function seedBothToStatus(dir, status) {
  setStatusFieldDirect(path.join(dir, 'BACKLOG.md'), status);
  setStatusFieldDirect(path.join(dir, 'TASK_STATUS.md'), status);
}

/**
 * Seed a session-phase fixture as if a previous session's rituals had already
 * run here: wave_goal + next_action in PROCESS_STATE.json, a 3-line
 * EXECUTION_LOG.md, and a best-effort git init + commit. Git seeding is
 * entirely optional — any failure is swallowed and HANDOFF.md's git sections
 * simply degrade gracefully to "unavailable".
 */
function seedSessionFixture(dir, today) {
  const processStatePath = assertUnderTmpDir(path.join(dir, 'PROCESS_STATE.json'));
  const processState = JSON.parse(fs.readFileSync(processStatePath, 'utf8'));
  processState.wave_goal = 'Ship the example feature end-to-end';
  processState.next_action = 'T-001 → developer → finish the API tests';
  fs.writeFileSync(processStatePath, JSON.stringify(processState, null, 2) + '\n', 'utf8');

  const executionLogPath = assertUnderTmpDir(path.join(dir, 'EXECUTION_LOG.md'));
  const executionLog = [
    '# Execution Log',
    '',
    `${today} — Spawned developer for T-001 (Example task).`,
  ].join('\n') + '\n';
  fs.writeFileSync(executionLogPath, executionLog, 'utf8');

  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.name=MavP Demo', '-c', 'user.email=demo@example.invalid', 'add', '-A'],
      { cwd: dir, stdio: 'ignore' }
    );
    execFileSync(
      'git',
      ['-c', 'user.name=MavP Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-m', 'Seed demo fixture'],
      { cwd: dir, stdio: 'ignore' }
    );
  } catch (_err) {
    // Best-effort only — git seeding is not required for the story. If it
    // fails here, HANDOFF.md's "Recent git changes" / "Changed files" sections
    // will read "unavailable", which is an acceptable, honest degraded state.
  }
}

// ---------------------------------------------------------------------------
// Real-tool invocation — always via child_process, MAVERICKS_PROJECT_ROOT is
// hard-overridden in the child env (never inherited) so the real tools only
// ever see the fixture, never this repo.
// ---------------------------------------------------------------------------
function runTool(scriptPath, args, fixtureDir, opts) {
  assertUnderTmpDir(fixtureDir);
  const env = Object.assign({}, process.env);
  env.MAVERICKS_PROJECT_ROOT = fixtureDir;
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', env });
  } catch (err) {
    stdout = err.stdout || '';
    status = typeof err.status === 'number' ? err.status : 1;
  }
  if (!opts.color) stdout = stripAnsi(stdout);
  return { stdout: stdout.replace(/\n+$/, ''), status };
}

function runValidator(fixtureDir, opts) {
  return runTool(VALIDATOR_SCRIPT, [fixtureDir], fixtureDir, opts);
}

// ---------------------------------------------------------------------------
// Narration helpers
// ---------------------------------------------------------------------------
function colorize(code, text, opts) {
  return opts.color ? `${code}${text}${RESET}` : text;
}

function banner(text, opts) {
  console.log('');
  console.log(colorize(`${BOLD}${CYAN}`, `▶ ${text}`, opts));
}

function note(text, opts) {
  console.log(colorize(DIM, `  ${text}`, opts));
}

function pause(opts) {
  if (!opts.step) return Promise.resolve();
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(colorize(DIM, '  Press Enter to continue…', opts), () => {
      rl.close();
      resolve();
    });
  });
}

function announceKeep(dir, opts) {
  if (!KEEP) return;
  console.log(colorize(YELLOW, `Fixture kept at: ${dir}`, opts));
}

// ---------------------------------------------------------------------------
// --reveal pacing — discrete full-screen frames for GIF/tape capture. An
// explicit write (NOT console.clear(), which no-ops off-TTY and would break
// capture/tests) of the standard "clear + scrollback + home" ANSI sequence.
// Only ever invoked when opts.reveal > 0 — with --reveal absent/0 neither
// function has any effect, keeping today's behavior byte-for-byte.
// ---------------------------------------------------------------------------
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function revealSleep(opts) {
  if (!opts.reveal || opts.reveal <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, opts.reveal));
}

function maybeClear(opts) {
  if (opts.reveal > 0) clearScreen();
}

// ---------------------------------------------------------------------------
// Phase 1 — dashboard @ planned
// ---------------------------------------------------------------------------
async function phaseDashboard(opts) {
  const dir = buildFixture('dashboard');

  maybeClear(opts);
  banner('Step 1 — Dashboard shows a fresh task at planned', opts);
  note('Fixture built from templates/ — BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.md, PROCESS_STATE.json.', opts);

  if (TEST_HOLD_MS > 0) {
    console.log(`__FIXTURE_READY__ ${dir}`);
    await new Promise((resolve) => setTimeout(resolve, TEST_HOLD_MS));
  }

  await pause(opts);
  await revealSleep(opts);

  const result = runTool(DASHBOARD_SCRIPT, [], dir, opts);
  console.log(result.stdout);
  await revealSleep(opts);

  cleanupFixture(dir);
  announceKeep(dir, opts);
  await pause(opts);
}

// ---------------------------------------------------------------------------
// Phase 2 — lifecycle: in_progress → ready_for_qa → qa_passed
// ---------------------------------------------------------------------------
async function phaseLifecycle(opts) {
  const dir = buildFixture('lifecycle');

  maybeClear(opts);
  banner('Step 2 — Walk the lifecycle: in_progress → ready_for_qa → qa_passed', opts);
  note('One command updates BOTH BACKLOG.md and TASK_STATUS.md, then re-validates.', opts);
  await pause(opts);
  await revealSleep(opts);

  const transitions = ['in_progress', 'ready_for_qa', 'qa_passed'];
  for (const status of transitions) {
    maybeClear(opts);
    banner(`set-status T-001 ${status}`, opts);
    await revealSleep(opts);

    const result = runTool(SET_STATUS_SCRIPT, ['T-001', status], dir, opts);
    console.log(result.stdout);
    note(`validator exit ${result.status} — ${result.status === 0 ? 'healthy' : 'unexpected'}`, opts);
    await revealSleep(opts);
    await pause(opts);
  }

  cleanupFixture(dir);
  announceKeep(dir, opts);
}

// ---------------------------------------------------------------------------
// Phase 3 — drift: hand-edit one file, catch it, fix it
// ---------------------------------------------------------------------------
async function phaseDrift(opts) {
  const dir = buildFixture('drift');
  seedBothToStatus(dir, 'qa_passed');

  maybeClear(opts);
  banner('Step 3 — Seed a task straight to qa_passed (skips the lifecycle for speed)', opts);
  note('BACKLOG.md and TASK_STATUS.md both say qa_passed — in sync.', opts);
  await pause(opts);
  await revealSleep(opts);

  maybeClear(opts);
  banner('Step 3b — An agent hand-edits TASK_STATUS.md and forgets BACKLOG.md', opts);
  setStatusFieldDirect(path.join(dir, 'TASK_STATUS.md'), 'needs_fix');
  note('TASK_STATUS.md now says needs_fix. BACKLOG.md still says qa_passed. That is drift.', opts);
  await pause(opts);
  await revealSleep(opts);

  maybeClear(opts);
  banner('Step 4 — Run the validator', opts);
  await revealSleep(opts);
  const failResult = runValidator(dir, opts);
  console.log(failResult.stdout);
  note(`validator exit ${failResult.status} — a pre-commit hook blocks the commit here.`, opts);
  await pause(opts);
  await revealSleep(opts);

  maybeClear(opts);
  banner('Step 5 — Re-align both files with one command', opts);
  await revealSleep(opts);
  const fixResult = runTool(SET_STATUS_SCRIPT, ['T-001', 'needs_fix'], dir, opts);
  console.log(fixResult.stdout);
  note(`validator exit ${fixResult.status} — clean again.`, opts);
  await revealSleep(opts);

  cleanupFixture(dir);
  announceKeep(dir, opts);

  console.log('');
  console.log(colorize(`${BOLD}${GREEN}`, 'see → drive → catch → fix', opts));

  return { failExit: failResult.status, fixExit: fixResult.status };
}

// ---------------------------------------------------------------------------
// Phase 4 — session: memory-transfer walkthrough across a session boundary.
// Beat 1 (previous session): a wave goal + next action are set, T-001 goes
// in_progress, then --handoff captures context as the session ends.
// Beat 2 (next session, empty chat): the session-start skill's two real
// commands — --agent and the HANDOFF.md read/delete — surface that same
// state with no chat history involved.
// ---------------------------------------------------------------------------
async function phaseSession(opts) {
  const dir = buildFixture('session');
  const today = new Date().toISOString().slice(0, 10);

  // --- Beat 1: the previous session ---------------------------------------
  maybeClear(opts);
  banner('Step 1 — A session at work: wave goal set, task in flight', opts);
  seedSessionFixture(dir, today);
  note(
    "The wave goal and next action were recorded by the previous session's rituals — seeded here so the story starts mid-flight.",
    opts
  );
  await pause(opts);
  await revealSleep(opts);

  const setStatusResult = runTool(SET_STATUS_SCRIPT, ['T-001', 'in_progress'], dir, opts);
  console.log(setStatusResult.stdout);
  note(
    `set-status T-001 in_progress ${setStatusResult.status === 0 ? 'success' : 'unexpected'} — validator exit ${setStatusResult.status}`,
    opts
  );
  await revealSleep(opts);
  await pause(opts);

  maybeClear(opts);
  banner('Step 2 — Session ends: capture context with --handoff', opts);
  await revealSleep(opts);
  const handoffNotes = 'Token refresh still failing on staging — resume with the API tests.';
  const handoffResult = runTool(HANDOFF_SCRIPT, ['--notes', handoffNotes], dir, opts);
  console.log(handoffResult.stdout);
  note('Claude Code exits. The chat history is gone. The files remain.', opts);
  await revealSleep(opts);
  await pause(opts);

  // --- Beat 2: the next session --------------------------------------------
  maybeClear(opts);
  banner('Step 3 — New session, empty chat: the session-start skill reads files, not scrollback', opts);
  note('The skill runs two things — the --agent brief and the HANDOFF check. Same commands, run here for real:', opts);
  await revealSleep(opts);
  const agentResult = runTool(AGENT_SCRIPT, [], dir, opts);
  console.log(agentResult.stdout);
  await revealSleep(opts);
  await pause(opts);

  maybeClear(opts);
  banner('Step 4 — The handoff note from the previous session', opts);
  const handoffPath = assertUnderTmpDir(path.join(dir, 'HANDOFF.md'));
  const handoffContents = fs.readFileSync(handoffPath, 'utf8');
  console.log(handoffContents);
  fs.rmSync(handoffPath, { force: true });
  note(
    'The skill deletes HANDOFF.md after reading — it is single-use and never leaks into a third session.',
    opts
  );
  await revealSleep(opts);

  cleanupFixture(dir);
  announceKeep(dir, opts);

  console.log('');
  console.log(colorize(`${BOLD}${GREEN}`, 'state lives in files, not in chat history', opts));
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------
const VALID_PHASES = ['dashboard', 'lifecycle', 'drift', 'session', 'all'];

function parseArgs(argv) {
  const opts = { phase: 'all', step: false, keep: false, color: true, reveal: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--phase') {
      opts.phase = argv[++i];
    } else if (arg === '--step' || arg === '--pause') {
      opts.step = true;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--no-color') {
      opts.color = false;
    } else if (arg === '--reveal') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 10000) {
        throw new Error(`Invalid --reveal value "${raw}" — expected an integer between 1 and 10000 (ms).`);
      }
      opts.reveal = value;
    }
  }
  if (process.env.NO_COLOR) opts.color = false;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  KEEP = opts.keep;

  if (!VALID_PHASES.includes(opts.phase)) {
    console.error(`Unknown --phase "${opts.phase}". Valid: ${VALID_PHASES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    colorize(`${BOLD}${CYAN}`, 'MavP Operator — guided demo (throwaway fixture, no docs required)', opts)
  );

  if (opts.phase === 'dashboard' || opts.phase === 'all') {
    await phaseDashboard(opts);
  }
  if (opts.phase === 'lifecycle' || opts.phase === 'all') {
    await phaseLifecycle(opts);
  }
  if (opts.phase === 'drift' || opts.phase === 'all') {
    await phaseDrift(opts);
  }
  if (opts.phase === 'session' || opts.phase === 'all') {
    await phaseSession(opts);
  }

  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((error) => {
    cleanupAllFixtures();
    console.error(`Demo failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertUnderTmpDir,
  buildFixture,
  setStatusFieldDirect,
  seedBothToStatus,
  runTool,
  runValidator,
  parseArgs,
  stripAnsi,
  cleanupFixture,
  cleanupAllFixtures,
  activeFixtures,
};
