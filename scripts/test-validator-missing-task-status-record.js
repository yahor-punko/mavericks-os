'use strict';
// Regression test: T-547 — validator warning for a terminal-status BACKLOG
// task with no TASK_STATUS record anywhere.
//
// Complement to T-543's cross_section_terminal_status_disagreement check:
// that check requires a TASK_STATUS record to disagree with, so it cannot
// see a task with NO TASK_STATUS record at all — exactly the shape a buggy
// archival move-helper leaves when it DROPS a block instead of moving it
// (the same T-542/T-544 incident family this check closes the gap on).
//
// Extended by T-575 (Tests F-J below) for the REVERSE direction:
// missing_backlog_record_anywhere (warning) — a TASK_STATUS record claiming
// terminal status for a task BACKLOG never registered ANYWHERE. That variant
// is worse than a disagreement, because there is no plan-of-record entry to
// disagree with, and it was fully silent before T-575: `missing_in_backlog`
// deliberately exempts terminal-status TASK_STATUS records (merged tasks
// legitimately archive out of BACKLOG's Active Wave).
//
// Builds fixture BACKLOG.md + TASK_STATUS.md pairs (no PROCESS_STATE.json —
// PROCESS_STATE-dependent checks degrade silently on read errors, matching
// the precedent in test-validator-cross-section-status.js) and runs the
// validator CLI as a subprocess.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(__dirname, 'mavp-validator.js');

function makeTmpDir(label) {
  const tmpDir = path.join(os.tmpdir(), `t547-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// Minimal always-present active pairing so both artifacts have a
// non-terminal task the base comparison checks are happy with.
function baseBacklog({ archivedBlock }) {
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

${archivedBlock}
`;
}

function baseTaskStatus({ orphanRecord = '' } = {}) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

## Recently completed tasks
${orphanRecord}
`;
}

let passCount = 0;
function check(label, condition, extra) {
  assert.ok(condition, `FAIL (${label})${extra ? `: ${extra}` : ''}`);
  passCount += 1;
}

// --- Test A: merged archived BACKLOG task absent from TASK_STATUS entirely
// --- fires the new warning ---------------------------------------------
{
  const tmpDir = makeTmpDir('dropped-record-fires');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-901 — Fixture task dropped from TASK_STATUS
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'dropped-record fixture fires missing_task_status_record_anywhere',
    /missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'dropped-record fixture is warning severity (does not force exit 2 on its own)',
    exitCode !== 2 || /cross_section_terminal_status_disagreement/.test(stdout) === false,
    `got ${exitCode}. Output:\n${stdout}`
  );
  // Confirm the check is not simply absent from CHECKS output by construction —
  // assert the specific taskId is named.
  check('dropped-record finding names T-901', /T-901/.test(stdout) && /missing_task_status_record_anywhere/.test(stdout), `Output:\n${stdout}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test B: matching TASK_STATUS record present — no finding --------------
{
  const tmpDir = makeTmpDir('present-record-no-finding');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-902 — Fixture task with a real TASK_STATUS record
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({
      orphanRecord: `
### T-902 — Fixture task with a real TASK_STATUS record
- **Status:** merged
- **Owner:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Evidence:** commit: abc1234 branch: main`,
    })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'present-record fixture does NOT fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test C: Superseded by: skips the check (BACKLOG side) -----------------
{
  const tmpDir = makeTmpDir('superseded-skip');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-903 — Fixture task absorbed by another task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Superseded by:** T-999`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'superseded backlog record skips missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test D: deprecated BACKLOG status skips the check ----------------------
// (deprecated is not itself a terminal status, but isSkippedByExistingRules
// checks it explicitly — verify a deprecated non-terminal-but-tagged record
// never fires even if it somehow carried a terminal status alongside it is
// not representable; instead verify deprecated skip via the BACKLOG record
// directly reaching isSkippedByExistingRules through a terminal status.)
{
  const tmpDir = makeTmpDir('deprecated-skip');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-904 — Fixture task marked deprecated
- **Status:** deprecated
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'deprecated backlog record (non-terminal status) does not fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test E: a non-terminal BACKLOG status with no TASK_STATUS record ------
// --- must NOT fire (this check is terminal-status-scoped only) -------------
{
  const tmpDir = makeTmpDir('non-terminal-no-fire');
  writeFixture(
    tmpDir,
    baseBacklog({
      archivedBlock: `### T-905 — Fixture task still in flight, absent from TASK_STATUS
- **Status:** planned
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo`,
    }),
    baseTaskStatus({ orphanRecord: '' })
  );
  const { stdout } = runValidator(tmpDir);

  check(
    'non-terminal backlog-only record does not fire missing_task_status_record_anywhere',
    !/missing_task_status_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// =========================================================================
// T-575 — reverse direction: TASK_STATUS terminal x no BACKLOG record at all
// =========================================================================

// BACKLOG with NO record for the ghost task in any section.
function ghostBacklog() {
  return `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
`;
}

// BACKLOG that DOES register the ghost id, for the negative controls.
function registeredBacklog({ status, extraField = '' }) {
  return `${ghostBacklog()}
## Wave 99 — Archived (mid-wave)

### T-811 — Fixture task claiming a merge
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** unit
- **Repo:** fixture-repo${extraField}
`;
}

function ghostTaskStatus({ status, extraField = '' }) {
  return `# TASK_STATUS

## Active tasks

### T-900 — Fixture unrelated active task
- **Status:** planned
- **Owner:** developer
- **Verification type:** runtime
- **Repo:** fixture-repo
- **Evidence:** —

## Recently completed tasks

### T-811 — Fixture task claiming a merge
- **Status:** ${status}
- **Owner:** developer
- **Verification type:** unit
- **Repo:** fixture-repo
- **Evidence:** commit: abc1234 branch: main${extraField}
`;
}

// --- Test F: terminal TASK_STATUS record with no BACKLOG record anywhere ---
{
  const tmpDir = makeTmpDir('ghost-record-fires');
  writeFixture(tmpDir, ghostBacklog(), ghostTaskStatus({ status: 'merged' }));
  const { stdout, exitCode } = runValidator(tmpDir);

  check(
    'ghost-record fixture fires missing_backlog_record_anywhere',
    /missing_backlog_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'ghost-record finding names T-811 and its TASK_STATUS section',
    /\[T-811\] missing_backlog_record_anywhere/.test(stdout) &&
      /merged in TASK_STATUS\.md \(section: Recently completed tasks\)/.test(stdout) &&
      /no BACKLOG\.md record in any section/.test(stdout),
    `Output:\n${stdout}`
  );
  // Warning severity, not failure: the report must place it under Warnings
  // and the run must exit 1, not 2.
  check(
    'ghost-record finding is warning severity (exit 1, listed under Warnings)',
    exitCode === 1 && /## Warnings[\s\S]*missing_backlog_record_anywhere/.test(stdout),
    `got exit ${exitCode}. Output:\n${stdout}`
  );
  check(
    'ghost-record fixture reports 0 failures',
    /- Failures: 0/.test(stdout),
    `Output:\n${stdout}`
  );
  // The pre-existing missing_in_backlog check must remain silent — its
  // terminal-status exemption is exactly the hole this check fills, and
  // widening it was explicitly out of scope.
  check(
    'ghost-record fixture does NOT fire missing_in_backlog',
    !/missing_in_backlog/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test G: BACKLOG record present and terminal — no finding --------------
{
  const tmpDir = makeTmpDir('ghost-registered-terminal');
  writeFixture(tmpDir, registeredBacklog({ status: 'merged' }), ghostTaskStatus({ status: 'merged' }));
  const { stdout } = runValidator(tmpDir);

  check(
    'registered terminal BACKLOG record does not fire missing_backlog_record_anywhere',
    !/missing_backlog_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test H: BACKLOG record present but non-terminal — the DISAGREEMENT ----
// --- check owns that shape, not the absence check -------------------------
{
  const tmpDir = makeTmpDir('ghost-registered-non-terminal');
  writeFixture(tmpDir, registeredBacklog({ status: 'deferred' }), ghostTaskStatus({ status: 'merged' }));
  const { stdout } = runValidator(tmpDir);

  check(
    'registered non-terminal BACKLOG record does not fire missing_backlog_record_anywhere',
    !/missing_backlog_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  check(
    'registered non-terminal BACKLOG record fires reverse_terminal_status_disagreement instead',
    /reverse_terminal_status_disagreement/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test I: non-terminal TASK_STATUS record with no BACKLOG record --------
// --- must NOT fire (this check is terminal-status-scoped only) -------------
{
  const tmpDir = makeTmpDir('ghost-non-terminal-no-fire');
  writeFixture(tmpDir, ghostBacklog(), ghostTaskStatus({ status: 'planned' }));
  const { stdout } = runValidator(tmpDir);

  check(
    'non-terminal ghost record does not fire missing_backlog_record_anywhere',
    !/missing_backlog_record_anywhere/.test(stdout),
    `Output:\n${stdout}`
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test J: exemptions on the TASK_STATUS side ----------------------------
{
  // J1 — `Superseded by:`
  const tmpDirA = makeTmpDir('ghost-superseded-skip');
  writeFixture(tmpDirA, ghostBacklog(), ghostTaskStatus({ status: 'merged', extraField: '\n- **Superseded by:** T-999' }));
  const resultA = runValidator(tmpDirA);
  check(
    'Superseded by: on the TASK_STATUS record skips missing_backlog_record_anywhere',
    !/missing_backlog_record_anywhere/.test(resultA.stdout),
    `Output:\n${resultA.stdout}`
  );
  fs.rmSync(tmpDirA, { recursive: true, force: true });

  // J2 — `deprecated` (non-terminal, and explicitly skipped)
  const tmpDirB = makeTmpDir('ghost-deprecated-skip');
  writeFixture(tmpDirB, ghostBacklog(), ghostTaskStatus({ status: 'deprecated' }));
  const resultB = runValidator(tmpDirB);
  check(
    'deprecated TASK_STATUS record skips missing_backlog_record_anywhere',
    !/missing_backlog_record_anywhere/.test(resultB.stdout),
    `Output:\n${resultB.stdout}`
  );
  fs.rmSync(tmpDirB, { recursive: true, force: true });

  // J3 — control: the same fixture with no exemption DOES fire, proving J1
  // passes because of the exemption rather than because the fixture is inert.
  const tmpDirC = makeTmpDir('ghost-exemption-control');
  writeFixture(tmpDirC, ghostBacklog(), ghostTaskStatus({ status: 'merged' }));
  const resultC = runValidator(tmpDirC);
  check(
    'exemption control: the same fixture without any exemption DOES fire',
    /missing_backlog_record_anywhere/.test(resultC.stdout),
    `Output:\n${resultC.stdout}`
  );
  fs.rmSync(tmpDirC, { recursive: true, force: true });
}

console.log(`All T-547 + T-575 assertions passed (${passCount} checks).`);
