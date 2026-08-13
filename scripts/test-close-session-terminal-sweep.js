'use strict';
// Regression test: T-573 — --close-session must treat `deferred`/`deprecated`
// entries left in TASK_STATUS.md's "## Active tasks" section as TERMINAL:
// sweep them out and derive wave completion from what actually remains.
//
// The incident (2026-08-02): Wave 70's real work was fully merged and
// archived, yet `--close-session` did not advance the wave. PROCESS_STATE.json
// stayed at wave 70 and only wave_session ticked 10 → 11, because seven
// terminal entries (1 `deprecated`, 6 `deferred`) were still sitting in the
// Active tasks section, so `remainingTasks.length === 0` was never true and
// the wave latched open across sessions.
//
// Part 1 reproduces that exact shape and asserts the wave now closes.
// Part 2 is the over-application guard set: the sweep must be an EXPLICIT
// skip-list ({deferred, deprecated}), never "everything that is not
// in-flight" — so `qa_passed`, `planned`, `in_progress` AND an unrecognized
// status must each still keep the wave open (fail-closed).
// Part 3 asserts a swept `deferred` entry cannot contaminate the computed
// next_action when a real in-flight task sits behind it.
// Part 4 asserts `runtime_verified` (a POST-merge status) counts as completed
// work and lets the wave advance.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');

const { assertMergedRecordsUncontaminated } = require('./mavp-operator-close-session.js');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, 'mavp-validator.js');

const TMP_ROOT = path.join(os.tmpdir(), 't573-test-' + Date.now());
fs.mkdirSync(TMP_ROOT, { recursive: true });

const createdDirs = [];

function newFixtureDir(label) {
  const dir = path.join(TMP_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

/**
 * Deliberately tolerant of a non-zero exit (spawnSync, not execFileSync):
 * the T-573 contamination guard in syncBacklogMergedTasks() throws, so a
 * tripped guard must surface as a readable assertion naming the defect, not
 * as an execFileSync exception swallowing the run's output.
 *
 * @returns {{ status: number|null, out: string }} combined stdout+stderr
 */
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
 * The exact lines of a `### T-NNN` block (heading through the line before the
 * next `###`/`##` heading), for byte-identity comparison across a run.
 */
function extractTaskBlock(markdown, taskId) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (new RegExp(`^###\\s+${taskId}(\\s+—|\\s*$)`).test(lines[i])) start = i;
    } else if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return start === -1 ? null : lines.slice(start, end).join('\n');
}

function runValidator(dir) {
  const r = spawnSync('node', [VALIDATOR_PATH, dir], { encoding: 'utf8' });
  return { status: r.status, output: (r.stdout || '') + (r.stderr || '') };
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
}

/** Content of TASK_STATUS.md's "## Active tasks" section only. */
function activeTasksSection(dir) {
  const md = fs.readFileSync(path.join(dir, 'TASK_STATUS.md'), 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active tasks/.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** Content of an arbitrary "## <heading>" section of TASK_STATUS.md. */
function namedSection(dir, heading) {
  const md = fs.readFileSync(path.join(dir, 'TASK_STATUS.md'), 'utf8');
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

function writeProcessState(dir, overrides) {
  const state = {
    initiative: 'T-573 test fixture',
    stage: 'execution',
    wave: 70,
    wave_session: 11,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: null,
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 730,
    last_updated: '2026-08-02',
    deploy_contours: 0,
    wave_summary: 'Wave 69: prior wave.',
    rechecks: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// The incident fixture: TASK_STATUS.md "## Active tasks" holds exactly one
// `deprecated` entry (carrying a `Superseded by:` field and a unique Evidence
// marker) plus three `deferred` entries (each carrying a unique Notes marker),
// and ZERO in-flight tasks. BACKLOG.md's Active Wave is empty — the wave's
// real work (T-700) was already merged and archived out of it, which is
// precisely the state that should close the wave.
//
// T-575: T-700's BACKLOG block must be PRESENT in an archived section, not
// absent from BACKLOG.md altogether. Archival moves a block into
// `## Wave N — Archived...` within the same file; it never deletes it, so a
// merged TASK_STATUS record with no BACKLOG record anywhere is a state the
// real tooling cannot produce. The fixture previously modelled "archived out
// of Active Wave" by omitting the block entirely, which T-575's new
// `missing_backlog_record_anywhere` check correctly flags. The heading below
// deliberately omits the "(mid-wave)" suffix so the Part 1 assertion that no
// swept deferred/deprecated record triggered mid-wave archival stays
// load-bearing rather than being satisfied by fixture text.
//
// `extraActive` / `extraBacklog` let the Part 2 guards drop one additional
// task into the same fixture without duplicating all of it.
// ---------------------------------------------------------------------------
function buildIncidentFixture(dir, { extraActive = '', extraBacklog = '', processState = {} } = {}) {
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave
${extraBacklog}
## Wave 69 — Archived

### T-700 — Wave 70 real work
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact

## Deferred Tasks

### T-711 — Deferred alpha
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact

### T-712 — Deferred beta
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact

### T-713 — Deferred gamma
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact

### T-720 — Deprecated one
- **Status:** deprecated
- **Superseded by:** T-711
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-720 — Deprecated one
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** artifact
- **Superseded by:** T-711
- **Last verified by:** —
- **Evidence:** MARKER-EVIDENCE-720
- **Notes:** —

### T-711 — Deferred alpha
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** MARKER-NOTES-711

### T-712 — Deferred beta
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** MARKER-NOTES-712

### T-713 — Deferred gamma
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** MARKER-NOTES-713
${extraActive}
## Recently completed tasks

### T-700 — Wave 70 real work
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** artifact: fixture
- **Notes:** —
`, 'utf8');

  writeProcessState(dir, processState);
}

// ---------------------------------------------------------------------------
// Part 1 — the incident: an Active tasks section holding ONLY terminal
// (deferred/deprecated) entries must close the wave.
// ---------------------------------------------------------------------------
const incidentDir = newFixtureDir('incident');
buildIncidentFixture(incidentDir);

// Whole-block snapshots taken BEFORE the run, for the byte-identity assertion
// further down: a swept task's BACKLOG block must come out unchanged to the
// byte, not merely "still present" or "still says deferred".
const backlogBefore = fs.readFileSync(path.join(incidentDir, 'BACKLOG.md'), 'utf8');
const backlogBlocksBefore = new Map(
  ['T-711', 'T-712', 'T-713', 'T-720'].map((id) => [id, extractTaskBlock(backlogBefore, id)])
);
for (const [id, block] of backlogBlocksBefore) {
  assert.ok(block, `Part 1 SETUP FAIL: fixture BACKLOG.md has no ${id} block to snapshot`);
}

const incidentRun = runCloseSession(incidentDir);
const incidentOut = incidentRun.out;

assert.strictEqual(
  incidentRun.status,
  0,
  `Part 1 FAIL: close-session exited ${incidentRun.status} on the incident fixture — a clean sweep must not trip the contamination guard. Output:\n${incidentOut}`
);
assert.ok(
  !/refusing to (mirror|promote)/.test(incidentOut),
  `Part 1 FAIL: the contamination guard fired on a clean sweep, got:\n${incidentOut}`
);
assert.ok(
  incidentOut.includes('Wave 70 complete'),
  `Part 1 FAIL: expected the close-session output to announce "Wave 70 complete", got:\n${incidentOut}`
);

const incidentState = readState(incidentDir);
assert.strictEqual(incidentState.wave, 71, `Part 1 FAIL: expected wave 70 → 71, got ${incidentState.wave}`);
assert.strictEqual(incidentState.wave_session, 1, `Part 1 FAIL: expected wave_session to reset to 1, got ${incidentState.wave_session}`);
assert.strictEqual(incidentState.next_action, null, `Part 1 FAIL: expected next_action cleared on wave complete, got ${JSON.stringify(incidentState.next_action)}`);

const incidentActive = activeTasksSection(incidentDir);
assert.ok(
  !/^###\s+T-\d+/m.test(incidentActive),
  `Part 1 FAIL: "## Active tasks" must hold no task headings after the sweep, got:\n${incidentActive}`
);

// Markers must survive relocation VERBATIM, in their destination sections.
const deferredSection = namedSection(incidentDir, '## Deferred tasks');
assert.ok(deferredSection !== null, 'Part 1 FAIL: expected a "## Deferred tasks" section to be created on demand');
for (const id of ['711', '712', '713']) {
  assert.ok(
    deferredSection.includes(`### T-${id} —`),
    `Part 1 FAIL: T-${id} block missing from "## Deferred tasks", got:\n${deferredSection}`
  );
  assert.ok(
    deferredSection.includes(`- **Notes:** MARKER-NOTES-${id}`),
    `Part 1 FAIL: T-${id}'s Notes marker did not survive relocation verbatim, got:\n${deferredSection}`
  );
}

const completedSection = namedSection(incidentDir, '## Recently completed tasks');
assert.ok(completedSection !== null, 'Part 1 FAIL: expected a "## Recently completed tasks" section');
assert.ok(
  completedSection.includes('### T-720 —'),
  `Part 1 FAIL: the deprecated T-720 block must land in "## Recently completed tasks", got:\n${completedSection}`
);
assert.ok(
  completedSection.includes('- **Evidence:** MARKER-EVIDENCE-720') && completedSection.includes('- **Superseded by:** T-711'),
  `Part 1 FAIL: T-720's Evidence/Superseded by fields did not survive relocation verbatim, got:\n${completedSection}`
);
// A deprecated entry must NOT be diverted into the deferred section.
assert.ok(
  !deferredSection.includes('### T-720'),
  `Part 1 FAIL: deprecated T-720 leaked into "## Deferred tasks", got:\n${deferredSection}`
);

// The BACKLOG side must be untouched by the sweep: a deferred task's block
// stays under "## Deferred Tasks" byte-for-byte, never rewritten and never
// archived into the wave's mid-wave archive by syncBacklogMergedTasks().
const incidentBacklog = fs.readFileSync(path.join(incidentDir, 'BACKLOG.md'), 'utf8');
const backlogDeferredStart = incidentBacklog.indexOf('## Deferred Tasks');
assert.ok(backlogDeferredStart !== -1, 'Part 1 FAIL: BACKLOG.md "## Deferred Tasks" section disappeared');
for (const id of ['711', '712', '713']) {
  const idx = incidentBacklog.indexOf(`### T-${id} —`);
  assert.ok(idx > backlogDeferredStart, `Part 1 FAIL: BACKLOG T-${id} left "## Deferred Tasks"`);
}
// Byte-identity, whole block — not just the Status line. A forced-`merged`
// contamination (the realistic refactor that folds the deferred branch into
// the merged path) rewrites these Status fields, and this is the assertion
// that names that defect directly rather than letting it surface three steps
// later as "the wave failed to advance".
for (const [id, before] of backlogBlocksBefore) {
  const after = extractTaskBlock(incidentBacklog, id);
  assert.strictEqual(
    after,
    before,
    `Part 1 FAIL: ${id}'s BACKLOG block was modified by the close. A swept deferred/deprecated task must never reach mergedTaskRecords — syncBacklogMergedTasks() rewrites Status and archives the block.\n--- before ---\n${before}\n--- after ---\n${after}`
  );
}
assert.ok(
  !incidentBacklog.includes('Archived (mid-wave)'),
  'Part 1 FAIL: a swept deferred/deprecated record triggered BACKLOG mid-wave archival — it must never reach mergedTaskRecords'
);

// The post-run fixture must be validator-clean.
const incidentValidation = runValidator(incidentDir);
assert.strictEqual(
  incidentValidation.status,
  0,
  `Part 1 FAIL: expected validator exit 0 on the post-run fixture, got exit ${incidentValidation.status}:\n${incidentValidation.output}`
);

console.log('Part 1 (incident: terminal-only Active tasks closes the wave) passed.');

// ---------------------------------------------------------------------------
// Part 2 — over-application guards. The skip set is {deferred, deprecated}
// ONLY. Each of these four statuses must still hold the wave open at 70.
// `qa_passed` and `planned` are the load-bearing cases: both sit OUTSIDE
// IN_FLIGHT_STATUSES deliberately, so a set derived from it would sweep them
// and ship an unfinished wave. `unicorn_status` stands in for a typo'd or
// future status — an unknown value must fail CLOSED.
// ---------------------------------------------------------------------------
const guardStatuses = ['qa_passed', 'planned', 'in_progress', 'unicorn_status'];

for (const status of guardStatuses) {
  const dir = newFixtureDir(`guard-${status}`);
  buildIncidentFixture(dir, {
    extraActive: `
### T-730 — Guard task (${status})
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —
`,
    extraBacklog: `
### T-730 — Guard task (${status})
- **Status:** ${status}
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** fixture.

**Acceptance criteria:** fixture.

**Evidence expected:** commit: <hash>
`,
  });

  const out = runCloseSession(dir).out;
  assert.ok(
    out.includes('stays open'),
    `Part 2 FAIL (${status}): expected the wave to stay open, got:\n${out}`
  );
  assert.ok(
    out.includes(`T-730 still ${status}`),
    `Part 2 FAIL (${status}): expected the announcement to name T-730 as the blocker, got:\n${out}`
  );

  const state = readState(dir);
  assert.strictEqual(
    state.wave,
    70,
    `Part 2 FAIL (${status}): wave must stay at 70 while T-730 is ${status}, got ${state.wave}`
  );

  // The terminal entries around it were still swept — the guard is about the
  // non-terminal task alone keeping the wave open.
  const remaining = activeTasksSection(dir);
  assert.ok(
    remaining.includes('### T-730 —'),
    `Part 2 FAIL (${status}): T-730 must remain in "## Active tasks", got:\n${remaining}`
  );
  for (const id of ['711', '712', '713', '720']) {
    assert.ok(
      !remaining.includes(`### T-${id} `),
      `Part 2 FAIL (${status}): terminal T-${id} should still have been swept out of "## Active tasks", got:\n${remaining}`
    );
  }

  console.log(`Part 2 guard passed — "${status}" keeps Wave 70 open.`);
}

// ---------------------------------------------------------------------------
// Part 3 — next_action contamination. A `deferred` entry listed BEFORE an
// in-flight one must not become the computed next_action: the pre-fix code
// took remainingTasks[0], which was the deferred block.
// ---------------------------------------------------------------------------
const orderDir = newFixtureDir('next-action-order');
fs.writeFileSync(path.join(orderDir, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-741 — Real in-flight work
- **Status:** in_progress
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** artifact

**Problem:** fixture.

**Acceptance criteria:** fixture.

**Evidence expected:** commit: <hash>

## Deferred Tasks

### T-740 — Deferred but listed first
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

fs.writeFileSync(path.join(orderDir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-740 — Deferred but listed first
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

### T-741 — Real in-flight work
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`, 'utf8');

writeProcessState(orderDir, { next_action: null, last_task_id: 741 });

const orderOut = runCloseSession(orderDir).out;
assert.ok(orderOut.includes('stays open'), `Part 3 FAIL: expected the wave to stay open, got:\n${orderOut}`);

const orderState = readState(orderDir);
assert.ok(
  typeof orderState.next_action === 'string' && orderState.next_action.startsWith('T-741'),
  `Part 3 FAIL: next_action must name the in_progress T-741, got ${JSON.stringify(orderState.next_action)}`
);
assert.ok(
  !orderState.next_action.includes('T-740'),
  `Part 3 FAIL: the deferred T-740 contaminated next_action: ${JSON.stringify(orderState.next_action)}`
);
assert.strictEqual(orderState.wave, 70, `Part 3 FAIL: wave must stay at 70, got ${orderState.wave}`);

console.log('Part 3 (deferred entry cannot contaminate next_action) passed.');

// ---------------------------------------------------------------------------
// Part 4 — `runtime_verified` is a POST-merge status, so it counts as
// completed work: a wave whose only Active tasks entry is runtime_verified
// must advance.
// ---------------------------------------------------------------------------
const rvDir = newFixtureDir('runtime-verified');
fs.writeFileSync(path.join(rvDir, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-750 — Runtime verified task
- **Status:** runtime_verified
- **Repo:** mavericks
- **Owner role:** developer
- **Verification type:** runtime

**Problem:** fixture.

**Acceptance criteria:** fixture.

**Evidence expected:** commit: <hash>
`, 'utf8');

fs.writeFileSync(path.join(rvDir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-750 — Runtime verified task
- **Status:** runtime_verified
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** commit: abc1234 branch: main
- **Notes:** —

## Recently completed tasks
`, 'utf8');

writeProcessState(rvDir, { wave: 80, wave_session: 4, last_task_id: 750 });

const rvOut = runCloseSession(rvDir).out;
assert.ok(
  rvOut.includes('Wave 80 complete'),
  `Part 4 FAIL: expected "Wave 80 complete" for a runtime_verified-only wave, got:\n${rvOut}`
);

const rvState = readState(rvDir);
assert.strictEqual(rvState.wave, 81, `Part 4 FAIL: expected wave 80 → 81, got ${rvState.wave}`);
assert.strictEqual(rvState.wave_session, 1, `Part 4 FAIL: expected wave_session to reset to 1, got ${rvState.wave_session}`);

const rvCompleted = namedSection(rvDir, '## Recently completed tasks');
assert.ok(
  rvCompleted.includes('### T-750 —'),
  `Part 4 FAIL: the runtime_verified block must be swept into "## Recently completed tasks", got:\n${rvCompleted}`
);

console.log('Part 4 (runtime_verified counts as completed) passed.');

// T-648: this fixture sweeps every task out of Active tasks, so the wave is
// complete — the wave-goal prompt now fires unconditionally on wave-complete
// (not only when unset), which needs a SECOND resolved `rl.question()`.
// Readline over a piped, already-EOF'd stdin only delivers the first
// buffered line to the first pending question (no listener is attached yet
// for the second when both lines land in the same data chunk), so a second
// static-input answer never resolves and the process exits early once the
// event loop drains. This spawns the process live and writes each answer
// only once its matching prompt text has appeared in the accumulated
// output, in order — matching how real interactive input actually arrives.
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

// Part 5+ run inside an async main() so runCloseSessionInteractiveSequential()
// (a Promise) can be awaited before Part 6/7 continue.
async function main() {

// ---------------------------------------------------------------------------
// Part 5 — the INTERACTIVE path must sweep identically. Before T-573 this
// path was strictly worse than the non-interactive one: each terminal entry
// got the same [m]/[n]/[k]/[enter] prompt as real work, and an Enter-skip left
// it counted as remaining. `wave_goal` is preset, but the wave is complete
// (every task swept out of Active tasks), so T-648 means the goal prompt
// fires anyway — three sequential answers: "Next action", "Enter wave
// goal", and the trailing "Run git push?" prompt.
// ---------------------------------------------------------------------------
const interactiveDir = newFixtureDir('interactive');
buildIncidentFixture(interactiveDir, { processState: { wave_goal: 'preset — must still be replaced by the prompt on wave-complete' } });

const { out: interactiveOut } = await runCloseSessionInteractiveSequential(interactiveDir, ['--interactive'], [
  { match: 'Next action [', answer: '' },
  { match: 'Enter wave goal', answer: '' },
  { match: 'Run git push?', answer: 'n' },
]);

assert.ok(
  interactiveOut.includes('Wave 70 complete'),
  `Part 5 FAIL: interactive close must announce "Wave 70 complete", got:\n${interactiveOut}`
);
assert.ok(
  !/\[m\]erged \/ \[n\]eeds_fix/.test(interactiveOut),
  `Part 5 FAIL: a deferred/deprecated entry must never be prompted for, got:\n${interactiveOut}`
);

const interactiveState = readState(interactiveDir);
assert.strictEqual(interactiveState.wave, 71, `Part 5 FAIL: expected wave 70 → 71 interactively, got ${interactiveState.wave}`);
assert.strictEqual(interactiveState.wave_session, 1, `Part 5 FAIL: expected wave_session to reset to 1, got ${interactiveState.wave_session}`);

const interactiveActive = activeTasksSection(interactiveDir);
assert.ok(
  !/^###\s+T-\d+/m.test(interactiveActive),
  `Part 5 FAIL: "## Active tasks" must hold no task headings after the interactive sweep, got:\n${interactiveActive}`
);
const interactiveDeferred = namedSection(interactiveDir, '## Deferred tasks');
assert.ok(
  interactiveDeferred !== null && interactiveDeferred.includes('- **Notes:** MARKER-NOTES-711'),
  `Part 5 FAIL: interactive sweep must relocate deferred blocks verbatim into "## Deferred tasks", got:\n${interactiveDeferred}`
);
assert.ok(
  !fs.readFileSync(path.join(interactiveDir, 'BACKLOG.md'), 'utf8').includes('Archived (mid-wave)'),
  'Part 5 FAIL: the interactive sweep fed a swept record to syncBacklogMergedTasks()'
);

console.log('Part 5 (interactive path sweeps identically) passed.');

// ---------------------------------------------------------------------------
// Part 6 — the contamination guard itself, unit-level.
//
// This is the assertion that actually kills BOTH known contamination shapes,
// including the one no end-to-end file check can see. If a future refactor
// folds the deferred branch into the merged path, one of these two rules
// fires with a message naming the defect.
//
//   Shape B (same status): mergedTaskRecords gets {id, status: 'deferred'}.
//     End-to-end this is INVISIBLE — updateTaskStatusField rewrites
//     `deferred` → `deferred` byte-for-byte and
//     archiveMergedTasksFromActiveWave() skips a block that is neither in
//     `## Active Wave` nor in ARCHIVABLE_TERMINAL_STATUSES, so BACKLOG.md
//     comes out identical and Part 1's byte-identity check stays silent.
//     Only rule 1 (record contract) sees it.
//
//   Shape A (forced merged): mergedTaskRecords gets {id, status: 'merged'}.
//     Rule 1 cannot see this — `merged` IS archivable. Rule 2 catches it by
//     reading the task's CURRENT BACKLOG status.
// ---------------------------------------------------------------------------
const GUARD_BACKLOG = `# BACKLOG

## Active Wave

### T-800 — Genuinely merged task
- **Status:** merged
- **Owner role:** developer

## Deferred Tasks

### T-711 — Deferred alpha
- **Status:** deferred
- **Owner role:** developer

### T-720 — Deprecated one
- **Status:** deprecated
- **Owner role:** developer
`;

// Negative control FIRST: legitimate input must NOT throw, otherwise the two
// positive cases below would pass for the wrong reason (a guard that rejects
// everything "catches" every mutant while breaking production).
assert.doesNotThrow(
  () => assertMergedRecordsUncontaminated([{ id: 'T-800', status: 'merged' }], GUARD_BACKLOG),
  'Part 6 FAIL: the guard rejected a legitimate merged record — it must be inert on the real path'
);
for (const status of ['deployed_dev', 'deployed_prod', 'runtime_verified']) {
  assert.doesNotThrow(
    () => assertMergedRecordsUncontaminated([{ id: 'T-800', status }], GUARD_BACKLOG),
    `Part 6 FAIL: the guard rejected a legitimate "${status}" record`
  );
}
// A record for a task absent from BACKLOG.md is not this guard's business.
assert.doesNotThrow(
  () => assertMergedRecordsUncontaminated([{ id: 'T-999', status: 'merged' }], GUARD_BACKLOG),
  'Part 6 FAIL: the guard threw on a record whose id has no BACKLOG block'
);

// Shape B — same-status leak. Rule 1.
for (const status of ['deferred', 'deprecated']) {
  assert.throws(
    () => assertMergedRecordsUncontaminated([{ id: 'T-711', status }], GUARD_BACKLOG),
    (err) => /refusing to mirror T-711 into BACKLOG\.md with status "/.test(err.message),
    `Part 6 FAIL: same-status contamination ({id, status: "${status}"}) was not refused — this shape leaves BACKLOG.md byte-identical, so the guard is the ONLY thing that can catch it`
  );
}

// Shape A — forced-merged leak on a deferred block. Rule 2.
assert.throws(
  () => assertMergedRecordsUncontaminated([{ id: 'T-711', status: 'merged' }], GUARD_BACKLOG),
  (err) => /refusing to promote T-711 from "deferred" to "merged"/.test(err.message),
  'Part 6 FAIL: forced-merged contamination of a deferred BACKLOG block was not refused'
);
assert.throws(
  () => assertMergedRecordsUncontaminated([{ id: 'T-720', status: 'merged' }], GUARD_BACKLOG),
  (err) => /refusing to promote T-720 from "deprecated" to "merged"/.test(err.message),
  'Part 6 FAIL: forced-merged contamination of a deprecated BACKLOG block was not refused'
);

// A contaminated record mixed in among legitimate ones must still be caught.
assert.throws(
  () => assertMergedRecordsUncontaminated(
    [{ id: 'T-800', status: 'merged' }, { id: 'T-711', status: 'merged' }],
    GUARD_BACKLOG
  ),
  (err) => /refusing to promote T-711/.test(err.message),
  'Part 6 FAIL: contamination hidden behind a legitimate record was not caught'
);

console.log('Part 6 (contamination guard refuses both leak shapes) passed.');

// ---------------------------------------------------------------------------
// Part 7 — the guard must be WIRED, not merely present. Part 6 calls
// assertMergedRecordsUncontaminated() directly, so it would keep passing if
// someone deleted the call from syncBacklogMergedTasks(); and shape B is
// invisible to every file-level assertion, so nothing else would notice.
//
// This drives the guard through the real production path with NO source
// mutation, using a legitimate pre-existing drift: T-810 is `merged` in
// TASK_STATUS.md's Active tasks (so the ordinary already-terminal sweep puts
// it into mergedTaskRecords) while its BACKLOG block still sits under
// "## Deferred Tasks" reading `deferred`. Rule 2 must refuse to promote it,
// and BACKLOG.md must come out untouched.
//
// The validator is BLIND to this exact drift — verified: exit 0, "Overall
// result: Healthy", "No mismatches detected". Its two relevant checks are
// gated on the BACKLOG-side status in opposite directions and `deferred`
// satisfies neither (see assertMergedRecordsUncontaminated()'s doc comment in
// mavp-operator-close-session.js for the traced detail). So this guard, and
// therefore this test, is the only thing covering the shape.
// ---------------------------------------------------------------------------
const wiringDir = newFixtureDir('guard-wiring');
fs.writeFileSync(path.join(wiringDir, 'BACKLOG.md'), `# BACKLOG

## Active Wave

## Deferred Tasks

### T-810 — Stale deferred in BACKLOG, merged in TASK_STATUS
- **Status:** deferred
- **Owner role:** developer
- **Verification type:** artifact
`, 'utf8');

fs.writeFileSync(path.join(wiringDir, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-810 — Stale deferred in BACKLOG, merged in TASK_STATUS
- **Status:** merged
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** qa
- **Evidence:** artifact: fixture
- **Notes:** —

## Recently completed tasks
`, 'utf8');

writeProcessState(wiringDir, { last_task_id: 810 });

const wiringBacklogBefore = fs.readFileSync(path.join(wiringDir, 'BACKLOG.md'), 'utf8');
const wiringRun = runCloseSession(wiringDir);

assert.notStrictEqual(
  wiringRun.status,
  0,
  `Part 7 FAIL: close-session exited 0 — the contamination guard is not wired into syncBacklogMergedTasks(). Output:\n${wiringRun.out}`
);
assert.ok(
  /refusing to promote T-810 from "deferred" to "merged"/.test(wiringRun.out),
  `Part 7 FAIL: expected the guard's refusal to surface through the real close-session path, got:\n${wiringRun.out}`
);
assert.strictEqual(
  fs.readFileSync(path.join(wiringDir, 'BACKLOG.md'), 'utf8'),
  wiringBacklogBefore,
  'Part 7 FAIL: BACKLOG.md was modified before the guard fired — the guard must run BEFORE any BACKLOG write'
);

console.log('Part 7 (guard is wired into the production path) passed.');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

console.log('All T-573 assertions passed.');

}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
