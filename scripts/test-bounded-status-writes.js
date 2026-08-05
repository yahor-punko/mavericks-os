'use strict';
// Regression test: T-609 — migrate --update-status and --merge-task writes
// to the bounded task-block helpers (locateTaskBlock/updateTaskField, T-606).
//
// Covers the acceptance criteria verbatim:
//   1. --update-status on a block lacking Status inserts Status into the
//      TARGET block rather than rewriting the next block's (Group A).
//   2. --update-status refuses (no write) on a duplicate heading rather than
//      silently degrading to a first-match write (Group B).
//   3. --update-status on a no-op status change prints a qualified "no
//      change" message, not an unqualified success line, and does not
//      rewrite the file (Group C).
//   4. --merge-task's qa_passed -> merged promotion: given a target block
//      whose TASK_STATUS.md entry lacks an Evidence line, sitting ABOVE an
//      archived task that already has one, the promotion writes merged
//      status + new evidence into the TARGET block only — the archived
//      block is byte-identical afterward (Group D — the defect this task
//      exists to close).
//   5. --merge-task refuses (no write) when the chosen task's heading is
//      duplicated in BACKLOG.md (Group E).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const UPDATE_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-update-status.js');
const MERGE_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-merge-task.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function runUpdateStatus(args, cwd) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: cwd };
  const result = spawnSync(NODE_BIN, [UPDATE_STATUS_PATH, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/**
 * Drive the interactive --merge-task CLI for real: a plain piped `input:`
 * string to spawnSync is unreliable here because Node's readline `.question()`
 * only captures the NEXT 'line' event after being (re-)armed — if multiple
 * answer lines land in the stream before the following question is asked,
 * the extra lines are silently dropped and the prompt stalls forever
 * (verified locally). Instead, use `spawn()` and write each answer only
 * once its corresponding prompt text has actually appeared in stdout so
 * far, mirroring a real interactive session.
 */
function runMergeTask(cwd, answers) {
  return new Promise((resolve) => {
    const env = { ...process.env, MAVERICKS_PROJECT_ROOT: cwd, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
    const child = spawn(NODE_BIN, [MERGE_TASK_PATH], { cwd, env });
    const markers = ['Task ID to merge', "Commit hash (or 'none')", 'Evidence summary'];
    let output = '';
    let sent = 0;
    function maybeAnswer() {
      while (sent < answers.length && sent < markers.length && output.includes(markers[sent])) {
        child.stdin.write(`${answers[sent]}\n`);
        sent++;
      }
    }
    child.stdout.on('data', (d) => { output += d.toString(); maybeAnswer(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('close', (code) => resolve({ status: code, output }));
    child.on('error', (err) => resolve({ status: -1, output: `${output}\nSPAWN ERROR: ${err.message}` }));
  });
}

// ---------------------------------------------------------------------------
// Group A — --update-status inserts a missing Status field into the TARGET
// block only; a neighboring block that already has Status is untouched.
// ---------------------------------------------------------------------------
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't609-a-'));
  writeUtf8(path.join(DIR, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-950 — Fixture target (no Status field)
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-951 — Fixture neighbor (has Status field)
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  writeUtf8(path.join(DIR, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-950 — Fixture target (no Status field)
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —

### T-951 — Fixture neighbor (has Status field)
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
`);

  const before951Backlog = readUtf8(path.join(DIR, 'BACKLOG.md')).match(/### T-951[\s\S]*/)[0];
  const before951TaskStatus = readUtf8(path.join(DIR, 'TASK_STATUS.md')).match(/### T-951[\s\S]*/)[0];

  const { output } = runUpdateStatus(['T-950', 'dev_done'], DIR);

  const backlogAfter = readUtf8(path.join(DIR, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(DIR, 'TASK_STATUS.md'));

  assert.ok(
    /### T-950 — Fixture target \(no Status field\)\n- \*\*Status:\*\* dev_done/.test(backlogAfter),
    `Group A FAIL: expected Status inserted right after T-950's heading in BACKLOG.md, got:\n${backlogAfter}`
  );
  assert.ok(
    /### T-950 — Fixture target \(no Status field\)\n- \*\*Status:\*\* dev_done/.test(taskStatusAfter),
    `Group A FAIL: expected Status inserted right after T-950's heading in TASK_STATUS.md, got:\n${taskStatusAfter}`
  );

  const after951Backlog = backlogAfter.match(/### T-951[\s\S]*/)[0];
  const after951TaskStatus = taskStatusAfter.match(/### T-951[\s\S]*/)[0];
  assert.strictEqual(after951Backlog, before951Backlog, `Group A FAIL: T-951's BACKLOG.md block must be byte-identical after T-950's update, output:\n${output}`);
  assert.strictEqual(after951TaskStatus, before951TaskStatus, `Group A FAIL: T-951's TASK_STATUS.md block must be byte-identical after T-950's update, output:\n${output}`);
  assert.ok(!/T-951.*Status set to/.test(output), `Group A FAIL: output must not claim T-951 was touched:\n${output}`);

  console.log('Group A passed: --update-status inserts a missing Status field into the target block only; neighbor block byte-identical');
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Group B — --update-status refuses (no write) on a duplicate heading.
// ---------------------------------------------------------------------------
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't609-b-'));
  const backlogContent = `# BACKLOG

## Active Wave

### T-960 — Fixture duplicate A
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-960 — Fixture duplicate B
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`;
  writeUtf8(path.join(DIR, 'BACKLOG.md'), backlogContent);
  writeUtf8(path.join(DIR, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-960 — Fixture duplicate A
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
`);

  const { status, output } = runUpdateStatus(['T-960', 'dev_done'], DIR);

  assert.notStrictEqual(status, 0, `Group B FAIL: expected non-zero exit on duplicate heading, got 0. Output:\n${output}`);
  assert.ok(/duplicate/i.test(output), `Group B FAIL: expected a duplicate-heading error message, got:\n${output}`);
  assert.strictEqual(readUtf8(path.join(DIR, 'BACKLOG.md')), backlogContent, 'Group B FAIL: BACKLOG.md must be byte-identical (no write) when the heading is duplicated');

  console.log('Group B passed: --update-status refuses to write on a duplicate heading (no silent first-match write)');
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Group C — a no-op status change (already at the target value) does not
// print an unqualified success line, and does not rewrite the file.
// ---------------------------------------------------------------------------
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't609-c-'));
  writeUtf8(path.join(DIR, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-965 — Fixture already-at-target
- **Status:** in_progress
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  writeUtf8(path.join(DIR, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-965 — Fixture already-at-target
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
`);

  const backlogBefore = readUtf8(path.join(DIR, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(DIR, 'TASK_STATUS.md'));

  const { output } = runUpdateStatus(['T-965', 'in_progress'], DIR);

  assert.ok(!/Status set to/.test(output), `Group C FAIL: expected no unqualified "Status set to" success line for a no-op change, got:\n${output}`);
  assert.ok(/no change/i.test(output), `Group C FAIL: expected a qualified "no change" message, got:\n${output}`);
  assert.strictEqual(readUtf8(path.join(DIR, 'BACKLOG.md')), backlogBefore, 'Group C FAIL: BACKLOG.md must not be rewritten on a no-op status change');
  assert.strictEqual(readUtf8(path.join(DIR, 'TASK_STATUS.md')), taskStatusBefore, 'Group C FAIL: TASK_STATUS.md must not be rewritten on a no-op status change');

  console.log('Group C passed: a no-op status change prints a qualified message and does not rewrite either file');
  fs.rmSync(DIR, { recursive: true, force: true });
}

async function runGroupsDE() {
// ---------------------------------------------------------------------------
// Group D — --merge-task's qa_passed -> merged promotion: the target's
// TASK_STATUS.md entry lacks an Evidence line and sits ABOVE an archived
// task that already has one. The promotion must write merged status + new
// evidence into the TARGET block only; the archived block stays
// byte-identical (T-609's headline defect).
// ---------------------------------------------------------------------------
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't609-d-'));
  writeUtf8(path.join(DIR, 'BACKLOG.md'), `# BACKLOG

## Active Wave

### T-970 — Fixture qa_passed target
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  const archivedBlock = `### T-800 — Fixture archived task
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** archived evidence text, nothing to do with this run
`;
  writeUtf8(path.join(DIR, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### T-970 — Fixture qa_passed target
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa

## Recently completed tasks

${archivedBlock}`);

  const { output } = await runMergeTask(DIR, ['T-970', 'none', 'verified new evidence text for T-970']);

  const backlogAfter = readUtf8(path.join(DIR, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(DIR, 'TASK_STATUS.md'));

  assert.ok(/### T-970[\s\S]*?- \*\*Status:\*\* merged/.test(backlogAfter), `Group D FAIL: expected T-970's BACKLOG.md Status -> merged, got:\n${backlogAfter}`);
  assert.ok(
    /### T-970[\s\S]*?- \*\*Evidence:\*\* verified new evidence text for T-970/.test(taskStatusAfter),
    `Group D FAIL: expected T-970's TASK_STATUS.md entry to gain the new Evidence line, got:\n${taskStatusAfter}`
  );
  assert.ok(
    taskStatusAfter.includes(archivedBlock),
    `Group D FAIL: T-800's archived block must be byte-identical (still containing its original evidence) — the defect this task closes. Output:\n${output}\nFile:\n${taskStatusAfter}`
  );

  console.log('Group D passed: qa_passed -> merged promotion writes into the target block only; archived block byte-identical');
  fs.rmSync(DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Group E — --merge-task refuses (no write) when the chosen task's heading
// is duplicated in BACKLOG.md.
// ---------------------------------------------------------------------------
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't609-e-'));
  const backlogContent = `# BACKLOG

## Active Wave

### T-975 — Fixture duplicate qa_passed A
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

### T-975 — Fixture duplicate qa_passed B
- **Status:** qa_passed
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`;
  writeUtf8(path.join(DIR, 'BACKLOG.md'), backlogContent);
  const taskStatusContent = `# TASK_STATUS

## Active tasks

### T-975 — Fixture duplicate qa_passed A
- **Status:** qa_passed
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
`;
  writeUtf8(path.join(DIR, 'TASK_STATUS.md'), taskStatusContent);

  const { status, output } = await runMergeTask(DIR, ['T-975', 'none', 'evidence text that must never be written']);

  assert.notStrictEqual(status, 0, `Group E FAIL: expected non-zero exit on duplicate heading, got 0. Output:\n${output}`);
  assert.ok(/duplicate/i.test(output), `Group E FAIL: expected a duplicate-heading error message, got:\n${output}`);
  assert.strictEqual(readUtf8(path.join(DIR, 'BACKLOG.md')), backlogContent, 'Group E FAIL: BACKLOG.md must be byte-identical (no write) when the heading is duplicated');
  assert.strictEqual(readUtf8(path.join(DIR, 'TASK_STATUS.md')), taskStatusContent, 'Group E FAIL: TASK_STATUS.md must be byte-identical (no write) when the heading is duplicated');

  console.log('Group E passed: --merge-task refuses to write on a duplicate BACKLOG.md heading (no silent first-match write)');
  fs.rmSync(DIR, { recursive: true, force: true });
}
}

runGroupsDE().then(() => {
  console.log('\nAll T-609 assertions passed.');
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
