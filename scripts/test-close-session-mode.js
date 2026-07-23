'use strict';
// Regression test: T-253 — resolveMode() precedence in mavp-operator-close-session.js
// Regression test: T-431 — close-session commit gate: commit on validator exit 0/1,
// skip only on exit 2, with an explicit "session commit SKIPPED" message.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { resolveMode } = require('./mavp-operator-close-session.js');

// 1. --interactive flag always wins → 'interactive'
assert.strictEqual(
  resolveMode({ interactive: true }),
  'interactive',
  'Case 1 FAIL: interactive:true should return "interactive"'
);

// 2. --non-interactive flag (no --interactive) → 'non-interactive'
assert.strictEqual(
  resolveMode({ nonInteractive: true }),
  'non-interactive',
  'Case 2 FAIL: nonInteractive:true should return "non-interactive"'
);

// 3. No flags, TTY detected → 'interactive'
assert.strictEqual(
  resolveMode({ isTTY: true }),
  'interactive',
  'Case 3 FAIL: isTTY:true with no flags should return "interactive"'
);

// 4. No flags, non-TTY → 'non-interactive'
assert.strictEqual(
  resolveMode({ isTTY: false }),
  'non-interactive',
  'Case 4 FAIL: isTTY:false with no flags should return "non-interactive"'
);

// 5. No flags, isTTY undefined (e.g. piped stdin) → 'non-interactive'
assert.strictEqual(
  resolveMode({ isTTY: undefined }),
  'non-interactive',
  'Case 5 FAIL: isTTY:undefined with no flags should return "non-interactive"'
);

// 6. Both --interactive and --non-interactive set → --interactive wins
assert.strictEqual(
  resolveMode({ interactive: true, nonInteractive: true }),
  'interactive',
  'Case 6 FAIL: interactive:true should win over nonInteractive:true'
);

// 7. --non-interactive set, TTY present → explicit flag beats TTY detect
assert.strictEqual(
  resolveMode({ nonInteractive: true, isTTY: true }),
  'non-interactive',
  'Case 7 FAIL: nonInteractive:true should win over isTTY:true'
);

console.log('All T-253 assertions passed.');

// ---------------------------------------------------------------------------
// T-431 — commit gate: exit 0/1 commit, exit 2 skips with an explicit message.
//
// Each case spins up a throwaway git repo fixture (BACKLOG.md/TASK_STATUS.md/
// PROCESS_STATE.json) plus a fake mavp-validator.js whose exit code is fixed,
// then runs the real mavp-operator-close-session.js CLI against it via
// MAVERICKS_PROJECT_ROOT / MAVERICKS_SCRIPTS env overrides — exercising the
// actual commit-gate code path end to end, not just a unit of the logic.
// ---------------------------------------------------------------------------

const CLOSE_SESSION_SCRIPT = path.join(__dirname, 'mavp-operator-close-session.js');

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-close-session-fixture-'));

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });

  fs.writeFileSync(
    path.join(dir, 'BACKLOG.md'),
    ['# Backlog', '', '## Active Wave — Wave 1', '', 'Nothing scheduled.', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'TASK_STATUS.md'),
    ['# Task Status', '', '## Active tasks', '', '## Recently completed tasks', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: [],
        next_action: null,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 1,
        last_updated: '2020-01-01',
        deploy_contours: 0,
        wave_summary: null,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial state'], { cwd: dir });

  return dir;
}

function makeFakeValidatorDir(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-fake-validator-'));
  fs.writeFileSync(
    path.join(dir, 'mavp-validator.js'),
    `process.stdout.write('fake validator exit ${exitCode}\\n');\nprocess.exit(${exitCode});\n`
  );
  return dir;
}

function headCommitCount(dir) {
  return parseInt(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
    10
  );
}

function runCloseSessionCli(repoDir, fakeScriptsDir, argv, input) {
  return spawnSync(process.execPath, [CLOSE_SESSION_SCRIPT, ...argv], {
    cwd: repoDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: repoDir, MAVERICKS_SCRIPTS: fakeScriptsDir },
    input: input !== undefined ? input : '',
    encoding: 'utf8',
  });
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

// Case 8: non-interactive, validator exits 1 (drifting) — commit IS created,
// no SKIPPED message.
{
  const repoDir = makeFixtureRepo();
  const fakeScriptsDir = makeFakeValidatorDir(1);
  const before = headCommitCount(repoDir);
  const result = runCloseSessionCli(repoDir, fakeScriptsDir, ['--non-interactive']);
  const after = headCommitCount(repoDir);

  assert.strictEqual(
    after,
    before + 1,
    `Case 8 FAIL: expected a new commit on validator exit 1 (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repoDir, encoding: 'utf8' }).trim();
  assert.ok(
    /^chore: close session \d{4}-\d{2}-\d{2}$/.test(subject),
    `Case 8 FAIL: unexpected commit subject "${subject}"`
  );
  const changedFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  // TASK_STATUS.md content is byte-identical (no active tasks to change), so
  // git stages no diff for it — the guaranteed-to-change tracked file every
  // close-session run touches is PROCESS_STATE.json (last_updated/wave_session
  // always refresh).
  assert.ok(changedFiles.includes('PROCESS_STATE.json'), 'Case 8 FAIL: expected PROCESS_STATE.json in the commit');
  assert.ok(
    !/session commit SKIPPED/.test(result.stdout),
    'Case 8 FAIL: should not print "session commit SKIPPED" on exit 1'
  );

  cleanup(repoDir, fakeScriptsDir);
}

// Case 9: non-interactive, validator exits 2 (repair required) — NO commit,
// explicit SKIPPED line naming exit 2.
{
  const repoDir = makeFixtureRepo();
  const fakeScriptsDir = makeFakeValidatorDir(2);
  const before = headCommitCount(repoDir);
  const result = runCloseSessionCli(repoDir, fakeScriptsDir, ['--non-interactive']);
  const after = headCommitCount(repoDir);

  assert.strictEqual(after, before, 'Case 9 FAIL: no commit should be created when validator exits 2');
  assert.ok(
    /session commit SKIPPED/.test(result.stdout),
    `Case 9 FAIL: expected explicit "session commit SKIPPED" line (stdout: ${result.stdout})`
  );
  assert.ok(
    /exit 2/.test(result.stdout),
    `Case 9 FAIL: SKIPPED output should name validator exit 2 (stdout: ${result.stdout})`
  );

  cleanup(repoDir, fakeScriptsDir);
}

// Case 10: interactive path, validator exits 1 — same commit behavior as
// non-interactive. wave_goal is already set in the fixture and there are no
// active tasks, so the only prompt reached is "Next action" — answered with
// a bare newline (accept the default).
{
  const repoDir = makeFixtureRepo();
  const fakeScriptsDir = makeFakeValidatorDir(1);
  const before = headCommitCount(repoDir);
  const result = runCloseSessionCli(repoDir, fakeScriptsDir, ['--interactive'], '\n');
  const after = headCommitCount(repoDir);

  assert.strictEqual(
    after,
    before + 1,
    `Case 10 FAIL: expected a new commit on validator exit 1 (interactive) (stdout: ${result.stdout}\nstderr: ${result.stderr})`
  );
  assert.ok(
    !/session commit SKIPPED/.test(result.stdout),
    'Case 10 FAIL: should not print "session commit SKIPPED" on exit 1 (interactive)'
  );

  cleanup(repoDir, fakeScriptsDir);
}

// Case 11: interactive path, validator exits 2 — NO commit, explicit SKIPPED
// line naming exit 2.
{
  const repoDir = makeFixtureRepo();
  const fakeScriptsDir = makeFakeValidatorDir(2);
  const before = headCommitCount(repoDir);
  const result = runCloseSessionCli(repoDir, fakeScriptsDir, ['--interactive'], '\n');
  const after = headCommitCount(repoDir);

  assert.strictEqual(after, before, 'Case 11 FAIL: no commit should be created when validator exits 2 (interactive)');
  assert.ok(
    /session commit SKIPPED/.test(result.stdout),
    `Case 11 FAIL: expected explicit "session commit SKIPPED" line (interactive) (stdout: ${result.stdout})`
  );
  assert.ok(
    /exit 2/.test(result.stdout),
    `Case 11 FAIL: SKIPPED output should name validator exit 2 (interactive) (stdout: ${result.stdout})`
  );

  cleanup(repoDir, fakeScriptsDir);
}

console.log('All T-431 assertions passed.');

// ---------------------------------------------------------------------------
// T-438 — (1) mid-wave symmetric archival: a task merged mid-wave must be
// archived out of BACKLOG.md's Active Wave section (with its Status field
// set to merged) in lockstep with TASK_STATUS.md's move to "Recently
// completed tasks" — otherwise sync-status recreates a skeleton entry and
// the validator can block on missing_in_task_status.
// (2) validator-before-mutation ordering: PROCESS_STATE.json's wave/
// wave_session must stay unchanged when the validator exit 2s, and a
// subsequent repaired re-run must bump them exactly once (no double-bump).
// ---------------------------------------------------------------------------

const SYNC_STATUS_SCRIPT = path.join(__dirname, 'mavp-operator-sync-status.js');

function makeMidWaveFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t438-fixture-'));

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });

  fs.writeFileSync(
    path.join(dir, 'BACKLOG.md'),
    [
      '# BACKLOG',
      '',
      '## Active Wave',
      '',
      '### T-100 — Merged task one',
      '- **Status:** qa_passed',
      '- **Owner role:** developer',
      '- **Repo:** mavericks',
      '- **Verification type:** artifact',
      '',
      '### T-101 — In flight task',
      '- **Status:** in_progress',
      '- **Owner role:** developer',
      '- **Repo:** mavericks',
      '- **Verification type:** runtime',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'TASK_STATUS.md'),
    [
      '# TASK_STATUS',
      '',
      '## Active tasks',
      '',
      '### T-100 — Merged task one',
      '- **Status:** merged',
      '- **Owner role:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** qa',
      '- **Evidence:** commit: aaaaaaa branch: main',
      '- **Notes:** —',
      '',
      '### T-101 — In flight task',
      '- **Status:** in_progress',
      '- **Owner role:** developer',
      '- **Verification type:** runtime',
      '- **Last verified by:** —',
      '- **Evidence:** —',
      '- **Notes:** —',
      '',
      '## Recently completed tasks',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(dir, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'T-438 fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: ['T-101'],
        next_action: 'T-101 → developer → do the thing',
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 101,
        last_updated: '2020-01-01',
        deploy_contours: 0,
        wave_summary: null,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial state'], { cwd: dir });

  return dir;
}

// Case 12: mid-wave symmetric archival, real scripts + real validator (no
// fake — MAVERICKS_SCRIPTS points at the actual scripts/ dir).
{
  const repoDir = makeMidWaveFixtureRepo();
  const result = runCloseSessionCli(repoDir, __dirname, ['--non-interactive']);

  const backlogAfter = fs.readFileSync(path.join(repoDir, 'BACKLOG.md'), 'utf8');
  const taskStatusAfter = fs.readFileSync(path.join(repoDir, 'TASK_STATUS.md'), 'utf8');

  // (a) BACKLOG.md: T-100's Status field is now merged.
  const midWaveArchiveIdx = backlogAfter.indexOf('## Wave 1 — Archived (mid-wave)');
  assert.ok(midWaveArchiveIdx !== -1, `Case 12 FAIL: expected a mid-wave archive heading in BACKLOG.md, got:\n${backlogAfter}`);
  const archivedSection = backlogAfter.slice(midWaveArchiveIdx);
  assert.ok(
    /### T-100 — Merged task one\n- \*\*Status:\*\* merged/.test(archivedSection),
    `Case 12 FAIL: expected T-100's BACKLOG Status set to merged inside the archive section, got:\n${archivedSection}`
  );

  // (b) BACKLOG.md: T-100's block moved out of Active Wave; T-101 untouched in place.
  const activeWaveSection = backlogAfter.slice(backlogAfter.indexOf('## Active Wave'), midWaveArchiveIdx);
  assert.ok(!activeWaveSection.includes('### T-100'), `Case 12 FAIL: T-100 must not remain under Active Wave, got:\n${activeWaveSection}`);
  assert.ok(
    /### T-101 — In flight task\n- \*\*Status:\*\* in_progress/.test(activeWaveSection),
    `Case 12 FAIL: T-101 must remain untouched (status in_progress) under Active Wave, got:\n${activeWaveSection}`
  );

  // (c) TASK_STATUS.md: T-100 moved to Recently completed tasks; T-101 remains Active.
  const completedIdx = taskStatusAfter.indexOf('## Recently completed tasks');
  assert.ok(taskStatusAfter.indexOf('### T-100') > completedIdx, 'Case 12 FAIL: T-100 must be in TASK_STATUS Recently completed tasks');
  assert.ok(taskStatusAfter.indexOf('### T-101') < completedIdx, 'Case 12 FAIL: T-101 must remain in TASK_STATUS Active tasks');

  // (d) A subsequent sync-status run emits nothing (no skeleton re-created).
  const syncOutput = execFileSync('node', [SYNC_STATUS_SCRIPT], {
    cwd: repoDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: repoDir },
    encoding: 'utf8',
  });
  assert.strictEqual(syncOutput, '', `Case 12 FAIL: sync-status should emit nothing (no skeleton re-created), got:\n${syncOutput}`);

  // (e) The validator (run inside --close-session) exits healthy.
  assert.ok(
    /Validator passed/.test(result.stdout),
    `Case 12 FAIL: expected validator to pass, got:\n${result.stdout}\nstderr: ${result.stderr}`
  );

  console.log('Case 12 passed: mid-wave symmetric archival keeps BACKLOG.md and TASK_STATUS.md in sync — sync-status silent, validator healthy');

  cleanup(repoDir);
}

// Case 13: validator exits 2 — PROCESS_STATE.json wave/wave_session are left
// byte-for-byte unchanged; a subsequent repaired (exit 0) re-run bumps the
// wave exactly once (no double-bump from the aborted attempt).
{
  const repoDir = makeFixtureRepo();
  const fakeScriptsDirExit2 = makeFakeValidatorDir(2);

  const before = JSON.parse(fs.readFileSync(path.join(repoDir, 'PROCESS_STATE.json'), 'utf8'));

  const abortedResult = runCloseSessionCli(repoDir, fakeScriptsDirExit2, ['--non-interactive']);
  assert.ok(
    /session commit SKIPPED/.test(abortedResult.stdout),
    `Case 13 FAIL: expected session commit SKIPPED on the aborted run, got:\n${abortedResult.stdout}`
  );

  const afterAbort = JSON.parse(fs.readFileSync(path.join(repoDir, 'PROCESS_STATE.json'), 'utf8'));
  assert.strictEqual(afterAbort.wave, before.wave, 'Case 13 FAIL: wave must be unchanged after a validator exit-2 abort');
  assert.strictEqual(
    afterAbort.wave_session,
    before.wave_session,
    'Case 13 FAIL: wave_session must be unchanged after a validator exit-2 abort'
  );

  // "Repair": point at a validator that now exits 0, then re-run.
  const fakeScriptsDirExit0 = makeFakeValidatorDir(0);
  runCloseSessionCli(repoDir, fakeScriptsDirExit0, ['--non-interactive']);

  const afterRepair = JSON.parse(fs.readFileSync(path.join(repoDir, 'PROCESS_STATE.json'), 'utf8'));
  assert.strictEqual(
    afterRepair.wave,
    (before.wave || 1) + 1,
    `Case 13 FAIL: expected wave to bump exactly once after the repaired re-run, got before=${before.wave} after=${afterRepair.wave}`
  );

  console.log('Case 13 passed: validator exit 2 leaves PROCESS_STATE.json wave/wave_session unchanged; repaired re-run bumps exactly once');

  cleanup(repoDir, fakeScriptsDirExit2, fakeScriptsDirExit0);
}

console.log('All T-438 assertions passed.');
