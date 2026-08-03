'use strict';
// Regression test: T-543 — validator checks for cross-section terminal-status
// disagreement (failure) and non-terminal blocks in TASK_STATUS's completed
// sections (warning).
//
// Extended by T-575 (Tests F-K below) for the REVERSE direction:
// reverse_terminal_status_disagreement (failure) — a TASK_STATUS record
// claiming terminal status while the same-ID BACKLOG record is non-terminal.
// Both T-543 checks are gated on the BACKLOG side being terminal, so before
// T-575 the mirror-image shape (BACKLOG T-810 `deferred` under
// `## Deferred Tasks`, TASK_STATUS T-810 `merged` under `## Active tasks`)
// raised zero findings and exited 0.
//
// Reproduces the exact shape of the 2026-07-26 corruption (see 274cd91's
// commit message and `git show 6bcdf1e -- BACKLOG.md`): a task's BACKLOG
// block gets archived out of "## Active Wave" with a fabricated `merged`
// status and no evidence, while its TASK_STATUS.md block sits under
// "## Recently completed tasks" still carrying `planned` — a disagreement
// that compareRecords()'s active-section-only status_mismatch check cannot
// see once both blocks have left their active sections.
//
// Builds fixture BACKLOG.md + TASK_STATUS.md pairs (no PROCESS_STATE.json —
// PROCESS_STATE-dependent checks degrade silently on read errors, matching
// the precedent in test-validator-review-statuses.js) and runs the
// validator CLI as a subprocess.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');
const REPO_ROOT = path.resolve(__dirname, '..');

// --- T-585: canonical-repo gate for the real-artifact layer ----------------
// Tests K and L below read this repo's REAL BACKLOG.md / TASK_STATUS.md and
// assert a non-trivial (>100) parsed record count. That claim is only
// required to hold in the canonical private repo. `scripts/publish-manifest.json`
// classifies both artifacts as `reset` -> one-record `templates/` starters, so
// in the public mirror (and in any adopter fork) those files hold exactly ONE
// `### T-` record each and the vacuity guard throws — which is exactly what
// reddened 0.40.0's mirror CI on all three node cells (backlog=1
// task_status=1).
//
// Two DIFFERENT questions, deliberately kept apart:
//   - "is this an environment where the claim is required to hold?" -> the
//     gate below (canonical-repo detection).
//   - "did the claim actually engage?" -> the `> 100` record count, which
//     stays a HARD assertion INSIDE the gate. Making the vacuity guard itself
//     conditional on input size was considered and rejected: the guard exists
//     to catch a parser regression returning an empty set in the canonical
//     repo, and a size-conditional form would read that regression as "small
//     input, skip" — fail-open, the exact shape T-573 removed elsewhere.
//
// Detection REUSES the exported isCanonicalRepo() ("every `exclude` key is
// git-tracked") from check-publish-manifest.js rather than re-implementing it
// — see that function's own comment ("do not invent a new one"). Same
// defensive load/degrade posture as check-changelog-frozen.js's
// repoIsCanonical(): a missing helper, a missing/unparseable manifest, or a
// non-git directory all read as NON-canonical instead of throwing.
let isCanonicalRepoHelper = null;
try {
  ({ isCanonicalRepo: isCanonicalRepoHelper } = require('./check-publish-manifest.js'));
} catch {
  isCanonicalRepoHelper = null;
}

/** True iff `repoRoot` is the canonical private repo. Never throws. */
function repoIsCanonical(repoRoot) {
  if (typeof isCanonicalRepoHelper !== 'function') return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts', 'publish-manifest.json'), 'utf8'));
  } catch {
    return false;
  }
  try {
    // stderr ignored: in a non-git directory git writes "fatal: not a git
    // repository" before exiting non-zero, and that line would otherwise
    // land in the CI log of every non-canonical run as if something broke.
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
    return isCanonicalRepoHelper(manifest, tracked);
  } catch {
    // Not a git repo / git unavailable — treat as non-canonical.
    return false;
  }
}

function makeTmpDir(label) {
  const tmpDir = path.join(os.tmpdir(), `t543-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function writeFixture(tmpDir, backlogMarkdown, taskStatusMarkdown) {
  fs.writeFileSync(path.join(tmpDir, 'BACKLOG.md'), backlogMarkdown, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'TASK_STATUS.md'), taskStatusMarkdown, 'utf8');
}

function runValidator(tmpDir) {
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [VALIDATOR_PATH, tmpDir], { encoding: 'utf8' });
  } catch (error) {
    stdout = error.stdout ? error.stdout.toString() : '';
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }
  return { stdout, exitCode };
}

function baseBacklog({ archivedStatus, extraField = '' }) {
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo

## Wave 99 — Archived (mid-wave)

### T-901 — Fixture task fabricated ${archivedStatus} in archived section
- **Status:** ${archivedStatus}
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo${extraField}
`;
}

function baseTaskStatus({ completedSectionStatus, extraField = '' }) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

## Recently completed tasks

### T-901 — Fixture task fabricated in archived section
- **Status:** ${completedSectionStatus}
- **Owner:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Evidence:** —${extraField}
`;
}

let passCount = 0;
function check(label, condition, extra) {
  assert.ok(condition, `FAIL (${label})${extra ? `: ${extra}` : ''}`);
  passCount += 1;
}

// --- Test A: corruption fixture fires BOTH checks, exit code 2 -------------
{
  const tmpDir = makeTmpDir('corruption-fires');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged' }),
    baseTaskStatus({ completedSectionStatus: 'planned' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check('corruption fixture exit code', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  check(
    'corruption fixture fires cross_section_terminal_status_disagreement',
    /cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'corruption fixture fires non_terminal_status_in_completed_section',
    /non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test B: consistent terminal statuses on both sides — neither check fires ---
{
  const tmpDir = makeTmpDir('consistent-terminal');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged', extraField: '\n- **Type:** improvement' }),
    baseTaskStatus({
      completedSectionStatus: 'merged',
      extraField: '\n- **Evidence:** commit: abc1234 branch: main',
    })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'consistent-terminal does not fire cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'consistent-terminal does not fire non_terminal_status_in_completed_section',
    !/non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  // exit code may still be non-zero from unrelated checks (e.g. commit
  // reachability against a synthetic hash) — not asserted here, since this
  // test's scope is only the two new checks' firing behavior.
  void exitCode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test C: Superseded by skips both checks -------------------------------
{
  const tmpDir = makeTmpDir('superseded-skip');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged', extraField: '\n- **Superseded by:** T-999' }),
    baseTaskStatus({ completedSectionStatus: 'planned' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'superseded backlog record skips cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test D: deprecated TASK_STATUS record skips both checks ---------------
{
  const tmpDir = makeTmpDir('deprecated-skip');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'merged' }),
    baseTaskStatus({ completedSectionStatus: 'deprecated' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'deprecated task_status record skips cross_section_terminal_status_disagreement',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'deprecated task_status record skips non_terminal_status_in_completed_section',
    !/non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test E: non-terminal status in "Recently completed tasks" fires the ---
// --- warning check even with NO corresponding BACKLOG terminal record   ---
{
  const tmpDir = makeTmpDir('warning-only');
  writeFixture(
    tmpDir,
    baseBacklog({ archivedStatus: 'deployed_prod' }),
    baseTaskStatus({ completedSectionStatus: 'in_progress' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'in_progress in Recently completed fires non_terminal_status_in_completed_section',
    /non_terminal_status_in_completed_section/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'deployed_prod vs in_progress also fires the failure-severity check',
    /cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check('warning-only+failure fixture exits 2', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// =========================================================================
// T-575 — reverse direction: TASK_STATUS terminal x BACKLOG non-terminal
// =========================================================================

// Reproduces the exact reported shape: BACKLOG T-810 `deferred` under
// "## Deferred Tasks", TASK_STATUS T-810 `merged` under "## Active tasks".
// `deferred` is deliberately used as the BACKLOG status because it is NOT in
// ACTIVE_BACKLOG_STATUSES, so parseBacklogActiveTasks() drops the block
// entirely and compareRecords()'s active-vs-active status_mismatch can never
// see it — the reverse check must catch it from the whole-file record set.
// `inActiveWave: true` places the SAME T-810 block inside the real
// "## Active Wave" section (the one parseBacklogActiveTasks() reads) instead
// of "## Deferred Tasks", to demonstrate that section placement is not what
// hides the shape.
function reverseBacklog({ backlogStatus, inActiveWave = false, extraField = '' }) {
  const t810Block = `### T-810 — Fixture task reverse-direction disagreement
- **Status:** ${backlogStatus}
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo${extraField}`;

  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
${inActiveWave ? `\n${t810Block}\n` : ''}
## Deferred Tasks
${inActiveWave ? '\n- (empty)\n' : `\n${t810Block}\n`}`;
}

function reverseTaskStatus({ taskStatusStatus, extraField = '' }) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

### T-810 — Fixture task reverse-direction disagreement
- **Status:** ${taskStatusStatus}
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** commit: abc1234 branch: main${extraField}
`;
}

// --- Test F: the exact T-810 shape fires the failure check, exit 2 ---------
{
  const tmpDir = makeTmpDir('reverse-deferred-vs-merged');
  writeFixture(
    tmpDir,
    reverseBacklog({ backlogStatus: 'deferred' }),
    reverseTaskStatus({ taskStatusStatus: 'merged' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check('reverse T-810 fixture exits 2', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  check(
    'reverse T-810 fixture fires reverse_terminal_status_disagreement',
    /reverse_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'reverse T-810 finding names T-810 and both statuses',
    /\[T-810\] reverse_terminal_status_disagreement/.test(stdout) &&
      /merged in TASK_STATUS\.md \(section: Active tasks\)/.test(stdout) &&
      /BACKLOG\.md \(section: Deferred Tasks\) still records status deferred/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'reverse T-810 finding routes repair through --rescope-task / --update-status',
    /--rescope-task T-810 --status merged/.test(stdout) && /--update-status T-810 merged/.test(stdout),
    `Output:\n${stdout}`
  );
  // Direction separation: the forward check must stay silent on this shape.
  check(
    'reverse T-810 fixture does NOT fire the forward cross_section check',
    !/cross_section_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test G: status filter, not section filter — the same disagreement -----
// --- sitting in the REAL "## Active Wave" section is still invisible to ----
// --- status_mismatch (parseBacklogActiveTasks() drops `deferred`) and must -
// --- still be caught by the reverse check ---------------------------------
{
  const tmpDir = makeTmpDir('reverse-deferred-in-active-wave');
  writeFixture(
    tmpDir,
    reverseBacklog({ backlogStatus: 'deferred', inActiveWave: true }),
    reverseTaskStatus({ taskStatusStatus: 'deployed_prod' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'reverse check fires when the BACKLOG block sits in Active Wave',
    /reverse_terminal_status_disagreement/.test(stdout) && /T-810/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'reverse Active-Wave finding reports section: Active Wave and deployed_prod',
    /deployed_prod in TASK_STATUS\.md/.test(stdout) &&
      /BACKLOG\.md \(section: Active Wave\) still records status deferred/.test(stdout),
    `Output:\n${stdout}`
  );
  // The status filter is what hides it: `deferred` is not in
  // ACTIVE_BACKLOG_STATUSES, so T-900 is the ONLY parsed active record even
  // though T-810's block is physically in the same section.
  check(
    'deferred block in Active Wave is dropped by the active-status filter',
    /- Backlog active records: 1/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'Active-Wave placement does not produce a status_mismatch finding',
    !/status_mismatch/.test(stdout),
    `Output:\n${stdout}`
  );
  check('reverse Active-Wave fixture exits 2', exitCode === 2, `got ${exitCode}. Output:\n${stdout}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test H: both sides terminal — no reverse finding ----------------------
{
  const tmpDir = makeTmpDir('reverse-both-terminal');
  writeFixture(
    tmpDir,
    reverseBacklog({ backlogStatus: 'merged' }),
    reverseTaskStatus({ taskStatusStatus: 'merged' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'both-terminal fixture does not fire reverse_terminal_status_disagreement',
    !/reverse_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test I: non-terminal on BOTH sides — no reverse finding ---------------
{
  const tmpDir = makeTmpDir('reverse-both-non-terminal');
  writeFixture(
    tmpDir,
    reverseBacklog({ backlogStatus: 'deferred' }),
    reverseTaskStatus({ taskStatusStatus: 'deferred' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'both-non-terminal fixture does not fire reverse_terminal_status_disagreement',
    !/reverse_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test J: exemptions on BOTH sides --------------------------------------
{
  // J1 — `Superseded by:` on the TASK_STATUS (terminal) side
  const tmpDirA = makeTmpDir('reverse-superseded-task-status');
  writeFixture(
    tmpDirA,
    reverseBacklog({ backlogStatus: 'deferred' }),
    reverseTaskStatus({ taskStatusStatus: 'merged', extraField: '\n- **Superseded by:** T-999' })
  );
  const resultA = runValidator(tmpDirA);
  check(
    'Superseded by: on the TASK_STATUS side skips reverse_terminal_status_disagreement',
    !/reverse_terminal_status_disagreement/.test(resultA.stdout),
    `Output:\n${resultA.stdout}`
  );
  fs.rmSync(tmpDirA, { recursive: true, force: true });

  // J2 — `Superseded by:` on the BACKLOG (non-terminal) side
  const tmpDirB = makeTmpDir('reverse-superseded-backlog');
  writeFixture(
    tmpDirB,
    reverseBacklog({ backlogStatus: 'deferred', extraField: '\n- **Superseded by:** T-999' }),
    reverseTaskStatus({ taskStatusStatus: 'merged' })
  );
  const resultB = runValidator(tmpDirB);
  check(
    'Superseded by: on the BACKLOG side skips reverse_terminal_status_disagreement',
    !/reverse_terminal_status_disagreement/.test(resultB.stdout),
    `Output:\n${resultB.stdout}`
  );
  fs.rmSync(tmpDirB, { recursive: true, force: true });

  // J3 — `deprecated` on the BACKLOG (non-terminal) side
  const tmpDirC = makeTmpDir('reverse-deprecated-backlog');
  writeFixture(
    tmpDirC,
    reverseBacklog({ backlogStatus: 'deprecated' }),
    reverseTaskStatus({ taskStatusStatus: 'merged' })
  );
  const resultC = runValidator(tmpDirC);
  check(
    'deprecated BACKLOG record skips reverse_terminal_status_disagreement',
    !/reverse_terminal_status_disagreement/.test(resultC.stdout),
    `Output:\n${resultC.stdout}`
  );
  fs.rmSync(tmpDirC, { recursive: true, force: true });

  // J4 — control: strip the exemption and the SAME fixture must fire, proving
  // J1-J3 pass because of the exemption rather than because the fixture was
  // inert to begin with.
  const tmpDirD = makeTmpDir('reverse-exemption-control');
  writeFixture(
    tmpDirD,
    reverseBacklog({ backlogStatus: 'deferred' }),
    reverseTaskStatus({ taskStatusStatus: 'merged' })
  );
  const resultD = runValidator(tmpDirD);
  check(
    'exemption control: the same fixture without any exemption DOES fire',
    /reverse_terminal_status_disagreement/.test(resultD.stdout),
    `Output:\n${resultD.stdout}`
  );
  fs.rmSync(tmpDirD, { recursive: true, force: true });
}

// --- Test K: false-positive guard against this repo's REAL artifacts -------
// The new checks read whole-file record sets over 500+ real task blocks each,
// so a mis-scoped gate would light up live state.
//
// SCOPE RULE — this guard may only ever fail because of the two T-575 checks.
// It must NOT assert that the repo is globally validator-clean. run-tests.js
// is a commit gate, so an assertion on whole-repo health would redden the
// suite (and block every commit) the first time a wave carries an unrelated
// warning — a self-inflicted latch, and precisely the class of defect this
// wave exists to remove. Global validator health is a property of the repo on
// a given day; "these two checks do not fire on real artifacts" is a property
// of the code under test. Only the latter belongs here.
//
// Three layers, in increasing scope:
//   (1) attributable, HARD — call the two checks directly against the real
//       BACKLOG.md/TASK_STATUS.md and require zero findings from each.
//   (2) end-to-end, HARD but NARROW — run the whole validator CLI against the
//       real repo and fail only if one of the two T-575 check names appears
//       in the report. This is not redundant with (1): the direct calls
//       bypass the CHECKS registry and parseArtifacts() wiring, so only this
//       layer would catch a check registered against the wrong record set.
//       Every other finding in that report is ignored by design.
//   (3) baseline, ADVISORY — the same run's exit code and failure/warning
//       counts are printed for a human, never asserted.
//
// T-585 — this whole layer (Test K AND Test L) only runs in the canonical
// repo; see the repoIsCanonical() note at the top of this file. Everything
// above (fixture Tests A-J, the logic coverage) runs everywhere, unchanged.
const NEW_CHECK_NAMES = ['reverse_terminal_status_disagreement', 'missing_backlog_record_anywhere'];

/** The T-575 check names present in a validator report — the only failure signal this guard honours. */
function newCheckNamesIn(validatorStdout) {
  return NEW_CHECK_NAMES.filter((name) => validatorStdout.includes(name));
}

const REAL_ARTIFACT_LAYER = repoIsCanonical(REPO_ROOT);
if (!REAL_ARTIFACT_LAYER) {
  console.log(
    '  [SKIP] Tests K + L (real-artifact layer) — NON-CANONICAL REPO: publish-manifest.json ships ' +
      'BACKLOG.md/TASK_STATUS.md as one-record templates/ starters, so this repo has no live task ' +
      'artifacts to read and the >100-record vacuity guard cannot hold here (T-585). The guard stays a ' +
      'HARD assertion inside the gate, and fixture Tests A-J above ran in full.'
  );
}

if (REAL_ARTIFACT_LAYER) {
  const validator = require(path.join(REPO_ROOT, 'scripts', 'mavp-validator.js'));

  const realBacklog = fs.readFileSync(path.join(REPO_ROOT, 'BACKLOG.md'), 'utf8');
  const realTaskStatus = fs.readFileSync(path.join(REPO_ROOT, 'TASK_STATUS.md'), 'utf8');
  const backlogAll = validator.parseAllTaskBlocksBySection(realBacklog, 'backlog');
  const taskStatusAll = validator.parseAllTaskBlocksBySection(realTaskStatus, 'task_status');

  // Proof-of-engagement (T-585): print the real counts unconditionally, so a
  // canonical run visibly demonstrates the layer READ live artifacts rather
  // than merely not having been skipped.
  console.log(
    `  [advisory] real-artifact layer ENGAGED (canonical repo): parsed ` +
      `${backlogAll.length} BACKLOG.md records, ${taskStatusAll.length} TASK_STATUS.md records`
  );

  // Guard against the guard being vacuous: if the parsers ever returned an
  // empty set, "zero findings" below would pass for the wrong reason.
  check(
    'false-positive guard reads a non-trivial real record set',
    backlogAll.length > 100 && taskStatusAll.length > 100,
    `backlog=${backlogAll.length} task_status=${taskStatusAll.length}`
  );

  // --- Layer 1: attributable, hard ---
  const reverseFindings = validator.checkReverseTerminalStatusDisagreement(backlogAll, taskStatusAll);
  const missingFindings = validator.checkMissingBacklogRecordAnywhere(backlogAll, taskStatusAll);

  check(
    'reverse_terminal_status_disagreement raises 0 findings on real artifacts',
    reverseFindings.length === 0,
    `got ${reverseFindings.length}: ${JSON.stringify(reverseFindings.map((f) => f.message))}`
  );
  check(
    'missing_backlog_record_anywhere raises 0 findings on real artifacts',
    missingFindings.length === 0,
    `got ${missingFindings.length}: ${JSON.stringify(missingFindings.map((f) => f.message))}`
  );

  // --- Layer 2: end-to-end, hard but narrow ---
  const { stdout, exitCode } = runValidator(REPO_ROOT);
  check(
    'no T-575 check name appears in the real-repo validator report',
    newCheckNamesIn(stdout).length === 0,
    `fired: ${JSON.stringify(newCheckNamesIn(stdout))}. Output:\n${stdout}`
  );

  // --- Layer 3: baseline, advisory only — reported, never asserted ---
  const failuresLine = (stdout.match(/- Failures: \d+/) || ['- Failures: ?'])[0];
  const warningsLine = (stdout.match(/- Warnings: \d+/) || ['- Warnings: ?'])[0];
  console.log(
    `  [advisory] real-repo validator baseline: exit ${exitCode}, ${failuresLine.trim()}, ${warningsLine.trim()}` +
      (exitCode === 0 ? '' : ' — unrelated to T-575 (layer 2 above is the T-575 signal); not a suite failure')
  );
}

// --- Test L: prove layer 3 cannot redden the suite ------------------------
// Constructed condition, not an assertion of intent: copy the REAL artifacts,
// inject one task that makes the real validator emit an UNRELATED warning
// (in_progress with no `Repo:` field -> missing_repo_field), run the real
// validator CLI over the result, and confirm the guard's failure signal
// (newCheckNamesIn) stays empty while the run itself is genuinely non-clean.
// This is what makes "advisory" a measured fact rather than a claim about
// code I wrote.
//
// This test must itself obey Test K's scope rule, or it just reintroduces the
// coupling one layer down. So it deliberately does NOT assert an exact exit
// code or warning count — the real repo is allowed to carry findings of its
// own. It asserts only the DELTA the probe is responsible for: a
// missing_repo_field finding naming the probe id, a non-clean exit, and an
// empty T-575 signal. The probe id is chosen at runtime from a range verified
// absent in both artifacts, so it can never collide with a real task and
// manufacture duplicate_task_id / duplicate_active_task noise.
//
// T-585 — gated on the SAME canonical-repo condition as Test K, because it
// reads the same real artifacts. Before T-585 this test carried the mirror
// defect LATENTLY: it never reached the point of failing only because Test K
// threw first and aborted the file. Gating K alone would have traded one
// mirror failure for the next one.

/** First `T-NNN` in [from, to] that appears in none of the given texts. */
function pickUnusedTaskId(texts, from = 880, to = 999) {
  for (let n = from; n <= to; n += 1) {
    const id = `T-${n}`;
    if (!texts.some((t) => t.includes(id))) return id;
  }
  return null;
}

if (REAL_ARTIFACT_LAYER) {
  const tmpDir = makeTmpDir('advisory-tolerates-unrelated-warning');

  const realBacklog = fs.readFileSync(path.join(REPO_ROOT, 'BACKLOG.md'), 'utf8');
  const realTaskStatus = fs.readFileSync(path.join(REPO_ROOT, 'TASK_STATUS.md'), 'utf8');

  const probeId = pickUnusedTaskId([realBacklog, realTaskStatus]);
  check('found an unused task id for the unrelated-warning probe', probeId !== null, 'T-880..T-999 all in use');

  const injectedBacklog = realBacklog.replace(
    /^## Active Wave\s*$/m,
    `## Active Wave\n\n### ${probeId} — Fixture unrelated-warning probe\n- **Status:** in_progress\n- **Owner role:** developer\n- **Verification type:** runtime`
  );
  const injectedTaskStatus = realTaskStatus.replace(
    /^## Active tasks\s*$/m,
    `## Active tasks\n\n### ${probeId} — Fixture unrelated-warning probe\n- **Status:** in_progress\n- **Owner:** developer\n- **Verification type:** runtime\n- **Evidence:** —`
  );

  // The injection must actually have landed — a silently failed replace would
  // make this whole test vacuous.
  check(
    'unrelated-warning probe was injected into both real artifacts',
    injectedBacklog !== realBacklog && injectedTaskStatus !== realTaskStatus,
    'the "## Active Wave" / "## Active tasks" heading replace did not match'
  );

  writeFixture(tmpDir, injectedBacklog, injectedTaskStatus);
  const { stdout, exitCode } = runValidator(tmpDir);

  // (a) The condition is real: the probe genuinely made this run non-clean.
  //     Asserted as a delta (named finding + non-zero exit), never as an
  //     exact count — see the scope note above.
  check(
    'probe run really does report an unrelated missing_repo_field finding',
    new RegExp(`\\[${probeId}\\] missing_repo_field`).test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'probe run is genuinely not validator-clean',
    exitCode !== 0,
    `expected a non-zero exit from the injected warning, got ${exitCode}. Output:\n${stdout}`
  );
  // (b) And the guard's failure signal is still empty — so an unrelated
  //     warning on live state cannot redden this suite.
  check(
    'an unrelated warning does NOT trip the T-575 guard',
    newCheckNamesIn(stdout).length === 0,
    `fired: ${JSON.stringify(newCheckNamesIn(stdout))}. Output:\n${stdout}`
  );
  // (c) Control: the guard is not simply blind — feed it a report that DOES
  //     name a new check and confirm it reacts.
  check(
    'the guard still reacts when a T-575 check name IS present',
    newCheckNamesIn('- [T-810] reverse_terminal_status_disagreement: ...').length === 1,
    'newCheckNamesIn() failed to detect a T-575 check name'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(
  `All T-543 + T-575 assertions passed (${passCount} checks` +
    (REAL_ARTIFACT_LAYER ? ', real-artifact layer INCLUDED).' : ', real-artifact layer SKIPPED — see above).')
);

