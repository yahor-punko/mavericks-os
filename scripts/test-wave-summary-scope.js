'use strict';
// Regression test: T-361 — --close-session wave_summary must be scoped to the
// wave being closed, not accumulate every prior wave's merged task titles.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const { parseActiveWaveMergedTitles } = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');

// ---------------------------------------------------------------------------
// Part 1 — unit test: parseActiveWaveMergedTitles(backlogMarkdown)
//
// Fixture has an "## Active Wave" section (Wave 2) with one merged and one
// still-in-progress task, plus a "## Wave 1 — Archived" section holding two
// Wave-1 merged tasks. The helper must return ONLY the Wave-2 merged title.
// ---------------------------------------------------------------------------
const UNIT_BACKLOG_FIXTURE = `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-201 — Wave 2 task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact

### T-202 — Wave 2 task still open
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact

## Wave 1 — Archived

### T-101 — Wave 1 task Alpha
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact

### T-102 — Wave 1 task Beta
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
`;

const unitTitles = parseActiveWaveMergedTitles(UNIT_BACKLOG_FIXTURE);
assert.deepStrictEqual(
  unitTitles,
  ['Wave 2 task'],
  `Unit FAIL: expected only ["Wave 2 task"], got ${JSON.stringify(unitTitles)}`
);

// Non-merged Active Wave task must not leak in
assert.ok(!unitTitles.includes('Wave 2 task still open'), 'Unit FAIL: in_progress task title leaked into result');
// Archived Wave-1 titles must never leak in
assert.ok(!unitTitles.includes('Wave 1 task Alpha'), 'Unit FAIL: archived Wave-1 title leaked into result');
assert.ok(!unitTitles.includes('Wave 1 task Beta'), 'Unit FAIL: archived Wave-1 title leaked into result');

// deployed_dev / deployed_prod also count as terminal/merged for summary purposes
const UNIT_BACKLOG_DEPLOYED = `# BACKLOG

## Active Wave

### T-301 — Deployed dev task
- **Status:** deployed_dev
- **Owner role:** developer
- **Verification type:** runtime

### T-302 — Deployed prod task
- **Status:** deployed_prod
- **Owner role:** developer
- **Verification type:** runtime
`;
const deployedTitles = parseActiveWaveMergedTitles(UNIT_BACKLOG_DEPLOYED);
assert.deepStrictEqual(
  deployedTitles.sort(),
  ['Deployed dev task', 'Deployed prod task'].sort(),
  `Unit FAIL: expected both deployed titles, got ${JSON.stringify(deployedTitles)}`
);

console.log('Part 1 (unit) assertions passed.');

// ---------------------------------------------------------------------------
// Part 2 — end-to-end: two successive wave closes in a temp fixture.
//
// TASK_STATUS.md's "## Recently completed tasks" section already holds
// Wave-1 merged tasks (simulating ~340 tasks accumulated across many prior
// waves). BACKLOG.md's "## Active Wave" holds only the Wave-2 task. A
// non-interactive close must produce a wave_summary naming ONLY the Wave-2
// task, and closing a further Wave-3 must not accumulate Wave-1/Wave-2 text.
// ---------------------------------------------------------------------------
const TMP_DIR = path.join(os.tmpdir(), 't361-test-' + Date.now());
fs.mkdirSync(TMP_DIR, { recursive: true });

const BACKLOG_PATH = path.join(TMP_DIR, 'BACKLOG.md');
const TASK_STATUS_PATH = path.join(TMP_DIR, 'TASK_STATUS.md');
const PROCESS_STATE_JSON_PATH = path.join(TMP_DIR, 'PROCESS_STATE.json');

function writeBacklog(content) {
  fs.writeFileSync(BACKLOG_PATH, content, 'utf8');
}
function writeTaskStatus(content) {
  fs.writeFileSync(TASK_STATUS_PATH, content, 'utf8');
}
function writeProcessState(obj) {
  fs.writeFileSync(PROCESS_STATE_JSON_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function readProcessState() {
  return JSON.parse(fs.readFileSync(PROCESS_STATE_JSON_PATH, 'utf8'));
}

function runCloseSession() {
  return execFileSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], {
    cwd: TMP_DIR,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: TMP_DIR, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    encoding: 'utf8',
  });
}

// --- Wave 2 fixture: BACKLOG Active Wave has T-201 (merged); TASK_STATUS.md
//     Active tasks also has T-201 (merged) and Recently completed already
//     holds the (much larger, simulating history) Wave-1 tasks.
writeBacklog(`# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-201 — Wave 2 task
- **Status:** merged
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>
`);

writeTaskStatus(`# TASK_STATUS

## Active tasks

### T-201 — Wave 2 task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —

## Recently completed tasks

### T-101 — Wave 1 task Alpha
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: 1111111 branch: main
- **Notes:** —

### T-102 — Wave 1 task Beta
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: 2222222 branch: main
- **Notes:** —
`);

writeProcessState({
  initiative: 'T-361 test fixture',
  stage: 'execution',
  wave: 2,
  wave_session: 1,
  wave_status: 'execution',
  wave_goal: null,
  parked_waves: [],
  active_slices: ['T-201'],
  next_action: 'T-201 → developer → wave 2 task',
  blocker: null,
  stage_owner: 'main_agent',
  last_task_id: 201,
  last_updated: '2026-01-01',
  deploy_contours: 0,
  wave_summary: 'Wave 1: Wave 1 task Alpha; Wave 1 task Beta.',
  rechecks: [],
});

runCloseSession();

const afterWave2Close = readProcessState();
assert.strictEqual(afterWave2Close.wave, 3, `E2E FAIL: expected wave to advance to 3, got ${afterWave2Close.wave}`);
assert.ok(
  typeof afterWave2Close.wave_summary === 'string' && afterWave2Close.wave_summary.includes('Wave 2 task'),
  `E2E FAIL: wave_summary should mention "Wave 2 task", got: ${afterWave2Close.wave_summary}`
);
assert.ok(
  !afterWave2Close.wave_summary.includes('Wave 1 task Alpha') && !afterWave2Close.wave_summary.includes('Wave 1 task Beta'),
  `E2E FAIL: wave_summary must not contain Wave-1 titles, got: ${afterWave2Close.wave_summary}`
);
const wave2SummaryLength = afterWave2Close.wave_summary.length;

console.log(`Part 2a (wave 2 close) passed — wave_summary: "${afterWave2Close.wave_summary}"`);

// --- Wave 3 fixture: archiveActiveWaveInBacklog already renamed the Wave-2
//     heading and reinserted a fresh empty "## Active Wave" (real behavior of
//     the script we just ran) — add a Wave-3 task there. TASK_STATUS.md now
//     has T-201 in "Recently completed" (moved by the script); add T-301 to
//     "## Active tasks" for the new wave.
const backlogAfterWave2 = fs.readFileSync(BACKLOG_PATH, 'utf8');
assert.ok(backlogAfterWave2.includes('## Wave 2 — Archived'), 'E2E FAIL: expected BACKLOG.md Wave 2 heading to be archived');
assert.ok(/^## Active Wave\s*$/m.test(backlogAfterWave2), 'E2E FAIL: expected a fresh empty "## Active Wave" heading after archive');

const backlogWithWave3 = backlogAfterWave2.replace(
  /## Active Wave\s*\n/,
  `## Active Wave

### T-301 — Wave 3 task
- **Status:** merged
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>

`
);
writeBacklog(backlogWithWave3);

const taskStatusAfterWave2 = fs.readFileSync(TASK_STATUS_PATH, 'utf8');
const taskStatusWithWave3 = taskStatusAfterWave2.replace(
  /## Active tasks\s*\n/,
  `## Active tasks

### T-301 — Wave 3 task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: 3333333 branch: main
- **Notes:** —

`
);
writeTaskStatus(taskStatusWithWave3);

runCloseSession();

const afterWave3Close = readProcessState();
assert.strictEqual(afterWave3Close.wave, 4, `E2E FAIL: expected wave to advance to 4, got ${afterWave3Close.wave}`);
assert.ok(
  typeof afterWave3Close.wave_summary === 'string' && afterWave3Close.wave_summary.includes('Wave 3 task'),
  `E2E FAIL: wave_summary should mention "Wave 3 task", got: ${afterWave3Close.wave_summary}`
);
assert.ok(
  !afterWave3Close.wave_summary.includes('Wave 2 task') &&
    !afterWave3Close.wave_summary.includes('Wave 1 task Alpha') &&
    !afterWave3Close.wave_summary.includes('Wave 1 task Beta'),
  `E2E FAIL: wave_summary must not contain prior-wave titles, got: ${afterWave3Close.wave_summary}`
);
assert.ok(
  afterWave3Close.wave_summary.length <= wave2SummaryLength + 20,
  `E2E FAIL: wave_summary length grew cumulatively (wave2: ${wave2SummaryLength} chars, wave3: ${afterWave3Close.wave_summary.length} chars) — expected bounded, not-accumulating length`
);

console.log(`Part 2b (wave 3 close) passed — wave_summary: "${afterWave3Close.wave_summary}"`);

// ---------------------------------------------------------------------------
// Part 3 — mid-wave close (wave NOT complete) must NOT clobber wave_summary
// with an auto-generated value. Only a fully-merged wave close should write
// the auto summary; explicit --summary is unaffected by this gate (not
// exercised here — see acceptance criteria / brief).
// ---------------------------------------------------------------------------
const MIDWAVE_DIR = path.join(os.tmpdir(), 't361-midwave-test-' + Date.now());
fs.mkdirSync(MIDWAVE_DIR, { recursive: true });

fs.writeFileSync(
  path.join(MIDWAVE_DIR, 'BACKLOG.md'),
  `# BACKLOG

## Active Wave

### T-401 — Still in progress task
- **Status:** in_progress
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact
`,
  'utf8'
);

fs.writeFileSync(
  path.join(MIDWAVE_DIR, 'TASK_STATUS.md'),
  `# TASK_STATUS

## Active tasks

### T-401 — Still in progress task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Notes:** —

## Recently completed tasks

`,
  'utf8'
);

const PRESERVED_SUMMARY = 'Wave 4: pre-existing summary that must survive a mid-wave close.';
fs.writeFileSync(
  path.join(MIDWAVE_DIR, 'PROCESS_STATE.json'),
  JSON.stringify(
    {
      initiative: 'T-361 mid-wave fixture',
      stage: 'execution',
      wave: 4,
      wave_session: 1,
      wave_status: 'execution',
      wave_goal: null,
      parked_waves: [],
      active_slices: ['T-401'],
      next_action: 'T-401 → developer → keep going',
      blocker: null,
      stage_owner: 'main_agent',
      last_task_id: 401,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      wave_summary: PRESERVED_SUMMARY,
      rechecks: [],
    },
    null,
    2
  ) + '\n',
  'utf8'
);

execFileSync('node', [CLOSE_SESSION_PATH, '--non-interactive'], {
  cwd: MIDWAVE_DIR,
  env: { ...process.env, MAVERICKS_PROJECT_ROOT: MIDWAVE_DIR, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
  encoding: 'utf8',
});

const midwaveState = JSON.parse(fs.readFileSync(path.join(MIDWAVE_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  midwaveState.wave_summary,
  PRESERVED_SUMMARY,
  `Part 3 FAIL: wave_summary should be preserved unchanged on a mid-wave (not-all-merged) close, got: ${midwaveState.wave_summary}`
);
assert.strictEqual(midwaveState.wave, 4, 'Part 3 FAIL: wave should NOT advance on a mid-wave close');

console.log('Part 3 (mid-wave gate) assertions passed.');

// ---------------------------------------------------------------------------
// Part 4 — T-366: flagless, non-TTY close (no --non-interactive / --interactive
// flag at all). Parts 1-3 above all pass --non-interactive explicitly, which is
// exactly why the T-366 bug was invisible: resolveMode() dispatches to
// runNonInteractive whenever stdin is not a TTY, flag or no flag, but the old
// auto-summary gate keyed on the args.nonInteractive FLAG rather than the
// resolved mode, so a flagless non-TTY close (e.g. agent Bash) silently kept
// the stale wave_summary. execFileSync's default stdio pipes stdin, so
// process.stdin.isTTY is undefined in the child and resolveMode() picks
// 'non-interactive' with no flags needed.
// ---------------------------------------------------------------------------

function runCloseSessionFlaglessNonTTY(dir, extraArgs = []) {
  return execFileSync('node', [CLOSE_SESSION_PATH, ...extraArgs], {
    cwd: dir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

// --- Part 4a: all-merged Active Wave, flagless non-TTY close must auto-scope
//     wave_summary to the current wave, exactly as the explicit-flag path does.
const FLAGLESS_DIR = path.join(os.tmpdir(), 't366-flagless-test-' + Date.now());
fs.mkdirSync(FLAGLESS_DIR, { recursive: true });

function writeFlagless(waveDir, { backlog, taskStatus, processState }) {
  fs.writeFileSync(path.join(waveDir, 'BACKLOG.md'), backlog, 'utf8');
  fs.writeFileSync(path.join(waveDir, 'TASK_STATUS.md'), taskStatus, 'utf8');
  fs.writeFileSync(path.join(waveDir, 'PROCESS_STATE.json'), JSON.stringify(processState, null, 2) + '\n', 'utf8');
}

const FLAGLESS_BACKLOG = `# BACKLOG

## Active Wave

### T-201 — Wave 2 task
- **Status:** merged
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>
`;

const FLAGLESS_TASK_STATUS = `# TASK_STATUS

## Active tasks

### T-201 — Wave 2 task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —

## Recently completed tasks

`;

function flaglessProcessState(overrides) {
  return {
    initiative: 'T-366 flagless fixture',
    stage: 'execution',
    wave: 2,
    wave_session: 1,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: ['T-201'],
    next_action: 'T-201 → developer → wave 2 task',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 201,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    wave_summary: 'OLD STALE ACCUMULATED SUMMARY',
    rechecks: [],
    ...overrides,
  };
}

writeFlagless(FLAGLESS_DIR, {
  backlog: FLAGLESS_BACKLOG,
  taskStatus: FLAGLESS_TASK_STATUS,
  processState: flaglessProcessState(),
});

runCloseSessionFlaglessNonTTY(FLAGLESS_DIR);

const flaglessState = JSON.parse(fs.readFileSync(path.join(FLAGLESS_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  flaglessState.wave_summary,
  'Wave 2: Wave 2 task.',
  `Part 4a FAIL: flagless non-TTY all-merged close should auto-scope wave_summary, got: ${flaglessState.wave_summary}`
);

console.log(`Part 4a (flagless non-TTY all-merged close) passed — wave_summary: "${flaglessState.wave_summary}"`);

// --- Part 4b: mid-wave (one in_progress task), flagless non-TTY close must
//     leave the stale wave_summary untouched (T-361 allMerged gate retained).
const FLAGLESS_MIDWAVE_DIR = path.join(os.tmpdir(), 't366-flagless-midwave-test-' + Date.now());
fs.mkdirSync(FLAGLESS_MIDWAVE_DIR, { recursive: true });

writeFlagless(FLAGLESS_MIDWAVE_DIR, {
  backlog: `# BACKLOG

## Active Wave

### T-401 — Still in progress task
- **Status:** in_progress
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact
`,
  taskStatus: `# TASK_STATUS

## Active tasks

### T-401 — Still in progress task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Notes:** —

## Recently completed tasks

`,
  processState: flaglessProcessState({
    wave: 4,
    active_slices: ['T-401'],
    next_action: 'T-401 → developer → keep going',
    last_task_id: 401,
  }),
});

runCloseSessionFlaglessNonTTY(FLAGLESS_MIDWAVE_DIR);

const flaglessMidwaveState = JSON.parse(fs.readFileSync(path.join(FLAGLESS_MIDWAVE_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  flaglessMidwaveState.wave_summary,
  'OLD STALE ACCUMULATED SUMMARY',
  `Part 4b FAIL: mid-wave flagless non-TTY close must leave wave_summary unchanged, got: ${flaglessMidwaveState.wave_summary}`
);
assert.strictEqual(flaglessMidwaveState.wave, 4, 'Part 4b FAIL: wave should NOT advance on a mid-wave close');

console.log('Part 4b (flagless non-TTY mid-wave gate) assertions passed.');

// --- Part 4c: all-merged, flagless non-TTY close WITH --summary "explicit"
//     must let the explicit summary win over auto-generation.
const FLAGLESS_EXPLICIT_DIR = path.join(os.tmpdir(), 't366-flagless-explicit-test-' + Date.now());
fs.mkdirSync(FLAGLESS_EXPLICIT_DIR, { recursive: true });

writeFlagless(FLAGLESS_EXPLICIT_DIR, {
  backlog: FLAGLESS_BACKLOG,
  taskStatus: FLAGLESS_TASK_STATUS,
  processState: flaglessProcessState(),
});

runCloseSessionFlaglessNonTTY(FLAGLESS_EXPLICIT_DIR, ['--summary', 'explicit']);

const flaglessExplicitState = JSON.parse(fs.readFileSync(path.join(FLAGLESS_EXPLICIT_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  flaglessExplicitState.wave_summary,
  'explicit',
  `Part 4c FAIL: explicit --summary should win on a flagless non-TTY all-merged close, got: ${flaglessExplicitState.wave_summary}`
);

console.log('Part 4c (flagless non-TTY explicit --summary wins) assertions passed.');

fs.rmSync(FLAGLESS_DIR, { recursive: true, force: true });
fs.rmSync(FLAGLESS_MIDWAVE_DIR, { recursive: true, force: true });
fs.rmSync(FLAGLESS_EXPLICIT_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Part 5 — T-367: runInteractive() never wrote wave_summary; its only
// summary-slot write was wave_goal via the default summaryKey. This drives
// the ACTUAL interactive path (--interactive, scripted stdin over readline)
// rather than unit-testing a helper in isolation, since the bug lived in the
// wiring between runInteractive() and updateProcessStateJson(), not in a
// pure function — a scripted end-to-end pass is the only way to catch a
// regression in that wiring.
// ---------------------------------------------------------------------------

// Node's readline.Interface, over a piped (non-TTY) stdin, delivers ALL
// buffered input as soon as it arrives — it does not wait for each
// rl.question() call before consuming the next line. Handing the whole
// scripted transcript to the child up front (via execFileSync's `input`
// option, or a single write-then-end) causes every line after the first
// to be consumed as an ownerless 'line' event ahead of the matching
// question(), and the interface then auto-closes on stdin EOF — so the
// SECOND rl.question() throws ERR_USE_AFTER_CLOSE and the process hangs
// waiting on a promise that will never resolve. The only reliable way to
// drive a readline-based CLI end-to-end is to watch its stdout for each
// prompt and write the next answer only once that prompt has appeared,
// mirroring how a real human types at a real terminal one line at a time.
function driveInteractive(dir, steps, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [CLOSE_SESSION_PATH, '--interactive'],
      {
        cwd: dir,
        env: { ...process.env, MAVERICKS_PROJECT_ROOT: dir, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let stepIdx = 0;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(
        `driveInteractive timed out after ${timeoutMs}ms (answered ${stepIdx}/${steps.length} prompts)\n` +
        `--- stdout so far ---\n${stdout}\n--- stderr ---\n${stderr}`
      ));
    }, timeoutMs);

    function tryAdvance() {
      while (stepIdx < steps.length && stdout.includes(steps[stepIdx].waitFor)) {
        const step = steps[stepIdx];
        stepIdx += 1;
        child.stdin.write(step.send);
      }
      if (stepIdx >= steps.length) {
        child.stdin.end();
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      tryAdvance();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stepIdx < steps.length) {
        reject(new Error(
          `driveInteractive: process closed (code ${code}) before all prompts were answered ` +
          `(answered ${stepIdx}/${steps.length})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        ));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

// The interactive driver above is async (spawn + stdout watching), so Parts
// 5a/5b and the final cleanup/summary run inside this IIFE. A thrown/rejected
// assertion here surfaces as an unhandled rejection, which Node treats as a
// non-zero exit — same failure signal as the synchronous asserts in Parts 1-4
// above.
(async () => {

// --- Part 5a: wave-complete interactive close. Fixture mirrors Part 2's
//     wave-2 shape (BACKLOG Active Wave + TASK_STATUS Active tasks both show
//     T-201 already merged; a real operator run would be finalizing/
//     confirming it). wave_goal is pre-seeded so runInteractive's
//     "!currentWaveGoal" prompt is skipped, keeping the scripted stdin small
//     and isolating this test to the wave_summary behavior under test.
//
//     T-445: a task already at a terminal status (merged/deployed_dev/
//     deployed_prod) when the interactive loop starts is now auto-archived
//     without prompting — the [m]/[n]/[k]/[enter] question and its notes
//     follow-up are never shown for T-201, so this fixture's only prompts
//     are "Next action" and "Run git push?".
//
//     Scripted stdin, one answer per prompt in order:
//       ""   -> "Next action [...]:" prompt: skip (wave is complete anyway)
//       "n"  -> "Run git push? [Y/n]:" prompt: decline (fixture isn't a real
//               git remote; declining keeps the test hermetic)
const INTERACTIVE_DIR = path.join(os.tmpdir(), 't367-interactive-test-' + Date.now());
fs.mkdirSync(INTERACTIVE_DIR, { recursive: true });

const PRESERVED_WAVE_GOAL = 'Wave 2 goal — pre-existing, must survive unchanged.';

fs.writeFileSync(
  path.join(INTERACTIVE_DIR, 'BACKLOG.md'),
  `# BACKLOG

## Active Wave

### T-201 — Wave 2 task
- **Status:** merged
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** test fixture.

**Acceptance criteria:** test fixture.

**Evidence expected:** commit: <hash>
`,
  'utf8'
);

fs.writeFileSync(
  path.join(INTERACTIVE_DIR, 'TASK_STATUS.md'),
  `# TASK_STATUS

## Active tasks

### T-201 — Wave 2 task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** commit: aaaaaaa branch: main
- **Notes:** —

## Recently completed tasks

`,
  'utf8'
);

fs.writeFileSync(
  path.join(INTERACTIVE_DIR, 'PROCESS_STATE.json'),
  JSON.stringify(
    {
      initiative: 'T-367 interactive fixture',
      stage: 'execution',
      wave: 2,
      wave_session: 1,
      wave_status: 'execution',
      wave_goal: PRESERVED_WAVE_GOAL,
      parked_waves: [],
      active_slices: ['T-201'],
      next_action: 'T-201 → developer → wave 2 task',
      blocker: null,
      stage_owner: 'main_agent',
      last_task_id: 201,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      wave_summary: 'OLD STALE SUMMARY FROM A PRIOR WAVE',
      rechecks: [],
    },
    null,
    2
  ) + '\n',
  'utf8'
);

await driveInteractive(INTERACTIVE_DIR, [
  { waitFor: 'Next action', send: '\n' },
  { waitFor: 'Run git push?', send: 'n\n' },
]);

const interactiveState = JSON.parse(fs.readFileSync(path.join(INTERACTIVE_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  interactiveState.wave_summary,
  'Wave 2: Wave 2 task.',
  `Part 5a FAIL: interactive wave-complete close should write the scoped wave_summary, got: ${interactiveState.wave_summary}`
);
assert.strictEqual(
  interactiveState.wave_goal,
  PRESERVED_WAVE_GOAL,
  `Part 5a FAIL: pre-existing wave_goal must survive an interactive close unchanged, got: ${interactiveState.wave_goal}`
);
assert.strictEqual(interactiveState.wave, 3, `Part 5a FAIL: expected wave to advance to 3, got ${interactiveState.wave}`);

console.log(`Part 5a (interactive wave-complete close) passed — wave_summary: "${interactiveState.wave_summary}"`);

// --- Part 5b: mid-wave interactive close (operator skips the only active
//     task, leaving it in_progress) must leave wave_summary untouched.
//     Scripted stdin:
//       ""  -> T-401 status prompt: skip (leaves it in_progress; allMerged=false)
//       ""  -> "Next action [...]:" prompt: skip
//     No push prompt fires since the wave isn't complete.
const INTERACTIVE_MIDWAVE_DIR = path.join(os.tmpdir(), 't367-interactive-midwave-test-' + Date.now());
fs.mkdirSync(INTERACTIVE_MIDWAVE_DIR, { recursive: true });

const PRESERVED_INTERACTIVE_SUMMARY = 'Wave 4: pre-existing summary that must survive a mid-wave interactive close.';

fs.writeFileSync(
  path.join(INTERACTIVE_MIDWAVE_DIR, 'BACKLOG.md'),
  `# BACKLOG

## Active Wave

### T-401 — Still in progress task
- **Status:** in_progress
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact
`,
  'utf8'
);

fs.writeFileSync(
  path.join(INTERACTIVE_MIDWAVE_DIR, 'TASK_STATUS.md'),
  `# TASK_STATUS

## Active tasks

### T-401 — Still in progress task
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Notes:** —

## Recently completed tasks

`,
  'utf8'
);

fs.writeFileSync(
  path.join(INTERACTIVE_MIDWAVE_DIR, 'PROCESS_STATE.json'),
  JSON.stringify(
    {
      initiative: 'T-367 interactive mid-wave fixture',
      stage: 'execution',
      wave: 4,
      wave_session: 1,
      wave_status: 'execution',
      wave_goal: 'Existing goal, irrelevant to this assertion.',
      parked_waves: [],
      active_slices: ['T-401'],
      next_action: 'T-401 → developer → keep going',
      blocker: null,
      stage_owner: 'main_agent',
      last_task_id: 401,
      last_updated: '2026-01-01',
      deploy_contours: 0,
      wave_summary: PRESERVED_INTERACTIVE_SUMMARY,
      rechecks: [],
    },
    null,
    2
  ) + '\n',
  'utf8'
);

await driveInteractive(INTERACTIVE_MIDWAVE_DIR, [
  { waitFor: '[enter] skip:', send: '\n' },
  { waitFor: 'Next action', send: '\n' },
]);

const interactiveMidwaveState = JSON.parse(fs.readFileSync(path.join(INTERACTIVE_MIDWAVE_DIR, 'PROCESS_STATE.json'), 'utf8'));
assert.strictEqual(
  interactiveMidwaveState.wave_summary,
  PRESERVED_INTERACTIVE_SUMMARY,
  `Part 5b FAIL: mid-wave interactive close must leave wave_summary unchanged, got: ${interactiveMidwaveState.wave_summary}`
);
assert.strictEqual(interactiveMidwaveState.wave, 4, 'Part 5b FAIL: wave should NOT advance on a mid-wave interactive close');

console.log('Part 5b (mid-wave interactive gate) assertions passed.');

fs.rmSync(INTERACTIVE_DIR, { recursive: true, force: true });
fs.rmSync(INTERACTIVE_MIDWAVE_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.rmSync(MIDWAVE_DIR, { recursive: true, force: true });

console.log('All T-361/T-366/T-367 assertions passed.');

})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
