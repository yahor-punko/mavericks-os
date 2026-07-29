'use strict';
// Regression test: T-253 — resolveMode() precedence in mavp-operator-close-session.js
// Regression test: T-431 — close-session commit gate: commit on validator exit 0/1,
// skip only on exit 2, with an explicit "session commit SKIPPED" message.
// Regression test: T-454 — deploy column renders actual deploy/push state
// (not mere merge status) per deploy_contours; degrades to a status-only
// label when reachability can't be determined.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { resolveMode, getDeployLabel, isCommitReachableFromRemote, resolveRemoteTrackingRef, classifyVersionBumpAdvisory, VERSION_BUMP_LINE, VERSION_UNRELEASED_LINE } = require('./mavp-operator-close-session.js');

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

// ---------------------------------------------------------------------------
// T-445 — interactive/non-interactive wave-complete parity + announcement:
// (1) an empty Active tasks section completes the wave identically in both
//     modes, printing an explicit "Wave N complete — archiving + incrementing"
//     line;
// (2) a fixture with one task still open keeps the wave open identically in
//     both modes, printing a line naming that task as the reason;
// (3) an already-merged task sitting in the Active tasks section no longer
//     requires re-answering in the interactive loop and does not block wave
//     completion.
// ---------------------------------------------------------------------------

function readProcessState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
}

function makeOneOpenTaskFixtureRepo(waveNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t445-open-fixture-'));

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
      '### T-200 — Task still in flight',
      '- **Status:** planned',
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
      '### T-200 — Task still in flight',
      '- **Status:** planned',
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
        initiative: 'T-445 open fixture',
        stage: 'execution',
        wave: waveNumber,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: [],
        next_action: null,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 200,
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

function makeAlreadyMergedFixtureRepo(waveNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t445-merged-fixture-'));

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
      '### T-300 — Already merged task',
      '- **Status:** qa_passed',
      '- **Owner role:** developer',
      '- **Repo:** mavericks',
      '- **Verification type:** artifact',
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
      '### T-300 — Already merged task',
      '- **Status:** merged',
      '- **Owner role:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** qa',
      '- **Evidence:** commit: bbbbbbb branch: main',
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
        initiative: 'T-445 already-merged fixture',
        stage: 'execution',
        wave: waveNumber,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: [],
        next_action: null,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 300,
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

// Case 14: empty Active tasks section, wave=3 — non-interactive completes the
// wave and prints the explicit announcement.
{
  const repoDir = makeFixtureRepo();
  // makeFixtureRepo() seeds wave: 1 — bump it to 3 to prove the announcement
  // names whatever wave is actually open, not a hardcoded number.
  const ps = readProcessState(repoDir);
  ps.wave = 3;
  fs.writeFileSync(path.join(repoDir, 'PROCESS_STATE.json'), JSON.stringify(ps, null, 2) + '\n');
  execFileSync('git', ['commit', '-aqm', 'fixture: set wave 3'], { cwd: repoDir });

  const result = runCloseSessionCli(repoDir, __dirname, ['--non-interactive']);

  assert.ok(
    /Wave 3 complete — archiving \+ incrementing/.test(result.stdout),
    `Case 14 FAIL: expected explicit wave-complete announcement, got:\n${result.stdout}`
  );
  const after = readProcessState(repoDir);
  assert.strictEqual(after.wave, 4, `Case 14 FAIL: expected wave to bump to 4, got ${after.wave}`);

  console.log('Case 14 passed: non-interactive completes an empty-Active-tasks wave and announces it');

  cleanup(repoDir);
}

// Case 15: identical empty-Active-tasks fixture, interactive mode — same
// wave-complete decision and same announcement as Case 14. Only prompt
// reached is "Next action" (wave_goal already set, no active tasks to
// answer) — a single blank line accepts the default.
{
  const repoDir = makeFixtureRepo();
  const ps = readProcessState(repoDir);
  ps.wave = 3;
  fs.writeFileSync(path.join(repoDir, 'PROCESS_STATE.json'), JSON.stringify(ps, null, 2) + '\n');
  execFileSync('git', ['commit', '-aqm', 'fixture: set wave 3'], { cwd: repoDir });

  const result = runCloseSessionCli(repoDir, __dirname, ['--interactive'], '\n\n');

  assert.ok(
    /Wave 3 complete — archiving \+ incrementing/.test(result.stdout),
    `Case 15 FAIL: expected explicit wave-complete announcement (interactive), got:\n${result.stdout}`
  );
  const after = readProcessState(repoDir);
  assert.strictEqual(after.wave, 4, `Case 15 FAIL: expected wave to bump to 4 (interactive), got ${after.wave}`);

  console.log('Case 15 passed: interactive completes an empty-Active-tasks wave and announces it — parity with Case 14');

  cleanup(repoDir);
}

// Case 16: one task still planned, wave=5 — non-interactive keeps the wave
// open and names the task as the reason.
{
  const repoDir = makeOneOpenTaskFixtureRepo(5);
  const result = runCloseSessionCli(repoDir, __dirname, ['--non-interactive']);

  assert.ok(
    /Wave 5 stays open — T-200 still planned/.test(result.stdout),
    `Case 16 FAIL: expected explicit "stays open" line naming T-200, got:\n${result.stdout}`
  );
  const after = readProcessState(repoDir);
  assert.strictEqual(after.wave, 5, `Case 16 FAIL: expected wave to remain 5, got ${after.wave}`);

  console.log('Case 16 passed: non-interactive keeps an open wave open and names the blocking task');

  cleanup(repoDir);
}

// Case 17: identical one-open-task fixture, interactive mode — same
// wave-stays-open decision and same announcement naming T-200. Two blank-line
// answers: skip the T-200 merge/needs_fix/keep prompt, then accept the
// default "Next action".
{
  const repoDir = makeOneOpenTaskFixtureRepo(5);
  const result = runCloseSessionCli(repoDir, __dirname, ['--interactive'], '\n\n');

  assert.ok(
    /Wave 5 stays open — T-200 still planned/.test(result.stdout),
    `Case 17 FAIL: expected explicit "stays open" line naming T-200 (interactive), got:\n${result.stdout}`
  );
  const after = readProcessState(repoDir);
  assert.strictEqual(after.wave, 5, `Case 17 FAIL: expected wave to remain 5 (interactive), got ${after.wave}`);

  console.log('Case 17 passed: interactive keeps an open wave open and names the blocking task — parity with Case 16');

  cleanup(repoDir);
}

// Case 18: an already-merged task sitting in TASK_STATUS's Active tasks
// section (not yet archived) — interactive mode must NOT prompt
// [m]/[n]/[k]/[enter] for it, must auto-archive it, and must complete the
// wave without requiring the operator to answer for it. Only the "Next
// action" prompt is reached (blank-line accepts the default).
{
  const repoDir = makeAlreadyMergedFixtureRepo(7);
  const result = runCloseSessionCli(repoDir, __dirname, ['--interactive'], '\n');

  assert.ok(
    /T-300 → moved to completed \(was already merged\)/.test(result.stdout),
    `Case 18 FAIL: expected T-300 to be auto-archived without prompting, got:\n${result.stdout}`
  );
  assert.ok(
    !/T-300.*\[m\]erged \/ \[n\]eeds_fix/.test(result.stdout),
    `Case 18 FAIL: T-300 must not be re-prompted with the merged/needs_fix/keep question, got:\n${result.stdout}`
  );
  assert.ok(
    /Wave 7 complete — archiving \+ incrementing/.test(result.stdout),
    `Case 18 FAIL: expected the wave to complete without requiring re-answering T-300, got:\n${result.stdout}`
  );
  const after = readProcessState(repoDir);
  assert.strictEqual(after.wave, 8, `Case 18 FAIL: expected wave to bump to 8, got ${after.wave}`);

  console.log('Case 18 passed: already-merged task auto-archives without prompting and does not block wave completion');

  cleanup(repoDir);
}

// --- T-454: getDeployLabel() / isCommitReachableFromRemote() / resolveRemoteTrackingRef() ---

/**
 * Build a bare-plus-clone git fixture: `dir` has a bare "origin" remote and
 * one commit pushed to origin/main, then a second local-only commit not
 * pushed. Returns { dir, pushedCommit, unpushedCommit }.
 */
function makeRemoteFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t454-remote-fixture-'));
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t454-bare-'));

  execFileSync('git', ['init', '-q', '--bare'], { cwd: bareDir });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fixture: init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: pushed commit'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir });
  const pushedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  execFileSync('git', ['add', 'b.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: unpushed commit'], { cwd: dir });
  const unpushedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  return { dir, bareDir, pushedCommit, unpushedCommit };
}

function makeNoRemoteFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t454-noremote-fixture-'));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'fixture: init'], { cwd: dir });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, commit };
}

// Case 19: deploy_contours=1, merged task, evidence commit reachable from
// origin/<branch> (no @{upstream} configured — must fall back to
// origin/<branch>) → auto-deploy label renders.
{
  const { dir, bareDir, pushedCommit } = makeRemoteFixtureRepo();

  assert.strictEqual(
    resolveRemoteTrackingRef(dir),
    'origin/main',
    'Case 19 FAIL: expected resolveRemoteTrackingRef() to fall back to origin/<branch> when no @{upstream} is configured'
  );
  assert.strictEqual(
    isCommitReachableFromRemote(dir, pushedCommit),
    true,
    'Case 19 FAIL: expected pushed commit to be reachable from origin/main'
  );
  assert.strictEqual(
    getDeployLabel(1, 'merged', pushedCommit, dir),
    '✓ авто-деплой',
    'Case 19 FAIL: expected auto-deploy label for a pushed commit under deploy_contours=1'
  );

  console.log('Case 19 passed: deploy_contours=1 + reachable commit renders auto-deploy label');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(bareDir, { recursive: true, force: true });
}

// Case 20: deploy_contours=1, merged task, evidence commit NOT reachable
// from the remote-tracking ref (held on a local-only commit) → "held / not
// pushed" label, never the auto-deploy label.
{
  const { dir, bareDir, unpushedCommit } = makeRemoteFixtureRepo();

  assert.strictEqual(
    isCommitReachableFromRemote(dir, unpushedCommit),
    false,
    'Case 20 FAIL: expected unpushed commit to be reported unreachable from origin/main'
  );
  const label = getDeployLabel(1, 'merged', unpushedCommit, dir);
  assert.ok(
    /HELD/.test(label) && !/авто-деплой/.test(label),
    `Case 20 FAIL: expected a held/not-pushed label, got "${label}"`
  );

  console.log('Case 20 passed: deploy_contours=1 + unreachable commit renders a held/not-pushed label, not auto-deploy');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(bareDir, { recursive: true, force: true });
}

// Case 21: deploy_contours=0 mirrors the same reachable/unreachable behavior
// as deploy_contours=1 (terminal "деплоен" label instead of "авто-деплой").
{
  const { dir, bareDir, pushedCommit, unpushedCommit } = makeRemoteFixtureRepo();

  assert.strictEqual(
    getDeployLabel(0, 'merged', pushedCommit, dir),
    '✓ задеплоен',
    'Case 21 FAIL: expected terminal deployed label for a pushed commit under deploy_contours=0'
  );
  const heldLabel = getDeployLabel(0, 'merged', unpushedCommit, dir);
  assert.ok(
    /HELD/.test(heldLabel),
    `Case 21 FAIL: expected held label for an unpushed commit under deploy_contours=0, got "${heldLabel}"`
  );

  console.log('Case 21 passed: deploy_contours=0 renders terminal label only when the commit is actually pushed');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(bareDir, { recursive: true, force: true });
}

// Case 22: deploy_contours=2 — deployed_dev/deployed_prod/merged/other each
// get their own label; deployed_dev and deployed_prod must NOT fall through
// to the "not merged" label (the bug this task fixes).
{
  const { dir, commit } = makeNoRemoteFixtureRepo();

  assert.strictEqual(getDeployLabel(2, 'deployed_dev', commit, dir), '✓ в dev', 'Case 22 FAIL: deployed_dev label');
  assert.strictEqual(getDeployLabel(2, 'deployed_prod', commit, dir), '✓ в проде', 'Case 22 FAIL: deployed_prod label');
  assert.strictEqual(getDeployLabel(2, 'merged', commit, dir), '⏳ не задеплоен', 'Case 22 FAIL: merged, not-deployed label');
  assert.strictEqual(getDeployLabel(2, 'in_progress', commit, dir), '⏳ не смёрджен', 'Case 22 FAIL: not-merged fallthrough label for a genuinely unmerged status');

  console.log('Case 22 passed: deploy_contours=2 maps deployed_dev/deployed_prod/merged to distinct labels — no fallthrough bug');

  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 23: no remote configured degrades to a status-only label without
// throwing (deploy_contours 0 and 1), and resolveRemoteTrackingRef()/
// isCommitReachableFromRemote() both return null rather than false.
{
  const { dir, commit } = makeNoRemoteFixtureRepo();

  assert.strictEqual(resolveRemoteTrackingRef(dir), null, 'Case 23 FAIL: expected null ref with no remote configured');
  assert.strictEqual(isCommitReachableFromRemote(dir, commit), null, 'Case 23 FAIL: expected null reachability with no remote configured');
  assert.strictEqual(getDeployLabel(1, 'merged', commit, dir), 'merged', 'Case 23 FAIL: expected status-only label with no remote (contours=1)');
  assert.strictEqual(getDeployLabel(0, 'merged', commit, dir), 'merged', 'Case 23 FAIL: expected status-only label with no remote (contours=0)');
  assert.doesNotThrow(() => getDeployLabel(1, 'merged', null, dir), 'Case 23 FAIL: getDeployLabel must not throw with a null evidence commit');
  assert.doesNotThrow(() => getDeployLabel(1, 'merged', commit, '/nonexistent-git-root-xyz'), 'Case 23 FAIL: getDeployLabel must not throw on a non-git root');

  console.log('Case 23 passed: no remote configured degrades to a status-only label without throwing');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('All T-445 assertions passed.');

// ---------------------------------------------------------------------------
// T-530 — checkVersionBump() gained release-awareness: before advising a
// version bump it now checks whether the CURRENT version is already tagged
// on the public mirror (resolved via MAVERICKS_HOME, exclusively through
// check-changelog-frozen.js's exported resolveMirrorHome()/isGitRepo()/
// getMirrorTags() — never a re-implemented `git -C <mirror> ...` call).
//
// Covers the three required cases end-to-end via the real CLI
// (mavp-operator-close-session.js --non-interactive), with whole-line
// assertions against the exported VERSION_BUMP_LINE / VERSION_UNRELEASED_LINE
// constants (not a re-typed substring):
//
//   1. current version tagged on the mirror + scripts/ drift -> bump
//      advisory (today's line, unchanged).
//   2. current version untagged on the mirror + scripts/ drift -> the
//      informational "unreleased and accumulating" line, and the bump
//      advisory line is ABSENT.
//   3. mirror unresolvable (MAVERICKS_HOME points nowhere) -> degrades to
//      case 1's bump-advisory behavior, unchanged from before T-530.
//
// Plus the GIT_DIR decoy case (T-517's lesson, reused rather than
// re-learned): GIT_DIR set to the fixture's OWN .git (the realistic
// hook-execution shape — see check-changelog-frozen.js's GIT_DIR HARDENING
// comment) while that same fixture repo ALSO carries a tag for the current
// version — carrying it the way the private canonical repo genuinely can
// (T-517's comment: "the private canonical repo is NOT guaranteed to be
// tag-free"). MAVERICKS_HOME points at a separate mirror fixture that does
// NOT carry that tag. The decision must still follow the MAVERICKS_HOME
// mirror (untagged -> informational line, no bump advisory) — a call path
// that dropped mirrorGitEnv() (i.e. read the mirror's tags via a plain
// `git -C <mirror> tag -l` inheriting the ambient GIT_DIR) would instead
// see the decoy's tag through GIT_DIR-precedence-over--C and wrongly print
// the bump advisory.
// ---------------------------------------------------------------------------

function gitT530(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitAllT530(dir, message) {
  gitT530(dir, ['add', '-A']);
  gitT530(dir, ['commit', '-q', '-m', message]);
}

// Writes the minimal BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.json triple
// close-session.js needs to run its non-interactive path cleanly (empty
// Active Wave — same shape as makeFixtureRepo() above). Does NOT commit —
// caller commits once mavp-version.js is also written, so the FIRST commit
// is the "version bump" commit checkVersionBump() diffs everything else
// against.
function seedStateFilesT530(dir) {
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
        initiative: 'T-530 fixture',
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
}

// Builds a throwaway "project" git repo whose scripts/mavp-version.js
// declares `version`, then commits a SECOND, later change under scripts/ —
// the drift checkVersionBump() reacts to. Returns the repo dir.
function makeVersionBumpFixtureRepo(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't530-fixture-'));
  gitT530(dir, ['init', '-q']);
  gitT530(dir, ['config', 'user.email', 'demo@example.invalid']);
  gitT530(dir, ['config', 'user.name', 'Fixture User']);

  seedStateFilesT530(dir);
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${version}' };\n`
  );
  commitAllT530(dir, `fixture: initial state, version ${version}`);

  // Drift: a later commit that touches scripts/ but not mavp-version.js.
  fs.writeFileSync(path.join(scriptsDir, 'dummy.js'), '// fixture drift file\n');
  commitAllT530(dir, 'fixture: scripts drift after version bump');

  return dir;
}

// Builds a throwaway "mirror" git repo, optionally pre-tagged with the
// given version strings (each normalized to `v<x.y.z>` if not already
// prefixed).
function makeMirrorFixtureRepo(taggedVersions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't530-mirror-'));
  gitT530(dir, ['init', '-q']);
  gitT530(dir, ['config', 'user.email', 'demo@example.invalid']);
  gitT530(dir, ['config', 'user.name', 'Mirror Fixture']);
  gitT530(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture: mirror init']);
  for (const v of taggedVersions || []) {
    gitT530(dir, ['tag', v.startsWith('v') ? v : `v${v}`]);
  }
  return dir;
}

function runCloseSessionCliWithEnv(repoDir, extraEnv) {
  return spawnSync(process.execPath, [CLOSE_SESSION_SCRIPT, '--non-interactive'], {
    cwd: repoDir,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: repoDir, MAVERICKS_SCRIPTS: __dirname, ...extraEnv },
    encoding: 'utf8',
  });
}

// --- Pure unit coverage of classifyVersionBumpAdvisory() — no git/fs involved. ---
{
  assert.strictEqual(
    classifyVersionBumpAdvisory({ changes: null, currentVersion: '1.2.3', tags: new Set(['v1.2.3']) }),
    null,
    'T-530 Unit FAIL: no changes at all must return null regardless of tag state'
  );
  assert.deepStrictEqual(
    classifyVersionBumpAdvisory({ changes: 'abc', currentVersion: '1.2.3', tags: new Set(['v1.2.3']) }),
    { kind: 'bump', changes: 'abc' },
    'T-530 Unit FAIL: tagged current version + changes must classify as bump'
  );
  assert.deepStrictEqual(
    classifyVersionBumpAdvisory({ changes: 'abc', currentVersion: '1.2.3', tags: new Set(['v1.1.0']) }),
    { kind: 'unreleased', changes: 'abc' },
    'T-530 Unit FAIL: untagged current version + changes must classify as unreleased'
  );
  assert.deepStrictEqual(
    classifyVersionBumpAdvisory({ changes: 'abc', currentVersion: '1.2.3', tags: null }),
    { kind: 'bump', changes: 'abc' },
    'T-530 Unit FAIL: unresolvable mirror (tags null) must degrade to bump, unchanged from pre-T-530 behavior'
  );
  assert.deepStrictEqual(
    classifyVersionBumpAdvisory({ changes: 'abc', currentVersion: null, tags: new Set(['v1.2.3']) }),
    { kind: 'bump', changes: 'abc' },
    'T-530 Unit FAIL: unknown current version must degrade to bump'
  );

  console.log('T-530 unit tests passed: classifyVersionBumpAdvisory() covers tagged/untagged/unresolvable/unknown-version');
}

// Case 24: current version TAGGED on the mirror + scripts/ drift -> bump
// advisory (today's line), informational line ABSENT.
{
  const repoDir = makeVersionBumpFixtureRepo('1.0.0');
  const mirrorDir = makeMirrorFixtureRepo(['1.0.0']);

  const result = runCloseSessionCliWithEnv(repoDir, { MAVERICKS_HOME: mirrorDir });
  const lines = (result.stdout || '').split('\n');

  assert.ok(
    lines.includes(VERSION_BUMP_LINE),
    `Case 24 FAIL: expected the exact bump-advisory line in stdout, got:\n${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    !lines.includes(VERSION_UNRELEASED_LINE),
    `Case 24 FAIL: informational unreleased line must be ABSENT when the current version is tagged, got:\n${result.stdout}`
  );

  console.log('Case 24 passed: current version tagged on the mirror + scripts drift -> bump advisory (unchanged)');

  cleanup(repoDir, mirrorDir);
}

// Case 25: current version UNTAGGED on the mirror + scripts/ drift ->
// informational unreleased-and-accumulating line, bump advisory ABSENT.
// This is the case a mutation removing release-awareness (always advising)
// must fail — see the mutation check quoted in the developer's evidence.
{
  const repoDir = makeVersionBumpFixtureRepo('2.0.0');
  // Mirror carries A tag, just never 2.0.0 — proves the classification
  // reads tag NAMES, not merely "does the mirror have any tags at all".
  const mirrorDir = makeMirrorFixtureRepo(['1.9.0']);

  const result = runCloseSessionCliWithEnv(repoDir, { MAVERICKS_HOME: mirrorDir });
  const lines = (result.stdout || '').split('\n');

  assert.ok(
    lines.includes(VERSION_UNRELEASED_LINE),
    `Case 25 FAIL: expected the exact informational unreleased line in stdout, got:\n${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    !lines.includes(VERSION_BUMP_LINE),
    `Case 25 FAIL: bump advisory must be ABSENT when the current version is untagged (would orphan it), got:\n${result.stdout}`
  );

  console.log('Case 25 passed: current version untagged on the mirror + scripts drift -> informational line only, no bump advisory');

  cleanup(repoDir, mirrorDir);
}

// Case 26: mirror unresolvable (MAVERICKS_HOME points at a path that does
// not exist) -> degrades to Case 24's bump-advisory behavior, unchanged
// from before T-530.
{
  const repoDir = makeVersionBumpFixtureRepo('3.0.0');
  const noSuchMirror = path.join(os.tmpdir(), `t530-no-such-mirror-${process.pid}-${Date.now()}`);

  const result = runCloseSessionCliWithEnv(repoDir, { MAVERICKS_HOME: noSuchMirror });
  const lines = (result.stdout || '').split('\n');

  assert.ok(
    lines.includes(VERSION_BUMP_LINE),
    `Case 26 FAIL: expected the bump-advisory line when the mirror is unresolvable (degrade unchanged), got:\n${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    !lines.includes(VERSION_UNRELEASED_LINE),
    `Case 26 FAIL: informational line must be ABSENT when the mirror is unresolvable, got:\n${result.stdout}`
  );

  console.log('Case 26 passed: unresolvable mirror degrades to the unchanged pre-T-530 bump-advisory behavior');

  cleanup(repoDir);
}

// Case 27 (GIT_DIR decoy — the load-bearing T-517-reuse proof): GIT_DIR set
// to the fixture repo's OWN .git (the realistic hook-execution shape) while
// that SAME repo carries a tag for the current version (the decoy). A
// SEPARATE MAVERICKS_HOME mirror fixture does NOT carry that tag. The
// decision must still follow the MAVERICKS_HOME mirror (untagged) ->
// informational line, bump advisory ABSENT — proving the tag read actually
// went through mirrorGitEnv() (via isGitRepo()/getMirrorTags()) rather than
// being shadowed by the ambient GIT_DIR.
{
  const repoDir = makeVersionBumpFixtureRepo('4.0.0');
  // The decoy tag: the fixture repo (== GIT_DIR target == cwd) carries a
  // tag for the CURRENT version — exactly the "private repo carries a
  // version tag ahead of the mirror" shape check-changelog-frozen.js's
  // header comment describes as real and expected.
  gitT530(repoDir, ['tag', 'v4.0.0']);

  // Non-vacuousness check (per the brief): the decoy repo genuinely has the
  // tag, and the mirror genuinely does not.
  const decoyTags = gitT530(repoDir, ['tag', '-l']).trim().split('\n');
  assert.ok(decoyTags.includes('v4.0.0'), 'Case 27 FAIL (fixture bug): decoy repo must carry v4.0.0');

  const mirrorDir = makeMirrorFixtureRepo(['3.9.0']); // never 4.0.0
  const mirrorTags = gitT530(mirrorDir, ['tag', '-l']).trim().split('\n').filter(Boolean);
  assert.ok(!mirrorTags.includes('v4.0.0'), 'Case 27 FAIL (fixture bug): mirror must NOT carry v4.0.0');

  const result = runCloseSessionCliWithEnv(repoDir, {
    MAVERICKS_HOME: mirrorDir,
    GIT_DIR: path.join(repoDir, '.git'),
  });
  const lines = (result.stdout || '').split('\n');

  assert.ok(
    lines.includes(VERSION_UNRELEASED_LINE),
    `Case 27 FAIL: expected the decision to follow the MAVERICKS_HOME mirror (untagged) even with GIT_DIR pointed at a decoy carrying the tag, got:\n${result.stdout}\nstderr: ${result.stderr}`
  );
  assert.ok(
    !lines.includes(VERSION_BUMP_LINE),
    `Case 27 FAIL: bump advisory must be ABSENT — a call path that dropped mirrorGitEnv() would read the decoy's tag via GIT_DIR and wrongly print it, got:\n${result.stdout}`
  );

  console.log('Case 27 passed: GIT_DIR decoy carrying the current version tag does not override the MAVERICKS_HOME mirror\'s (untagged) tag state');

  cleanup(repoDir, mirrorDir);
}

console.log('All T-530 assertions passed.');

// ---------------------------------------------------------------------------
// T-542 — end-to-end reproduction of the 2026-07-26 close-session incident:
// a task heading that merely MENTIONS another task's ID (e.g. "### T-541 —
// Close the four T-540 security residuals — ...") must never be treated as
// that other task's heading by the status/move helpers. Before the fix,
// running --close-session over this exact layout fabricated `merged` onto
// T-541 (still `planned`, never touched) and stranded T-540's real merged
// block in Active tasks. Mutant demonstration: reverting
// isTaskHeadingFor()/moveTaskToCompleted()'s identity guard back to the
// substring `includes(taskId + ' ')` test reproduces exactly that
// corruption and fails this case.
// ---------------------------------------------------------------------------

// Case 28: real scripts + real validator (MAVERICKS_SCRIPTS = __dirname).
// T-540 already sits at Status: merged in TASK_STATUS.md's Active tasks
// (mirrors the incident: Main Agent had already set it merged before this
// close-session run); T-541 is `planned` and was never touched by anyone.
{
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t542-fixture-'));

  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'demo@example.invalid'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Fixture User'], { cwd: repoDir });

  fs.writeFileSync(
    path.join(repoDir, 'BACKLOG.md'),
    [
      '# BACKLOG',
      '',
      '## Active Wave',
      '',
      '### T-540 — Fix the four security residuals',
      '- **Status:** merged',
      '- **Owner role:** developer',
      '- **Repo:** mavericks',
      '- **Verification type:** artifact',
      '',
      '### T-541 — Close the four T-540 security residuals — follow-up audit',
      '- **Status:** planned',
      '- **Owner role:** developer',
      '- **Repo:** mavericks',
      '- **Verification type:** artifact',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'TASK_STATUS.md'),
    [
      '# TASK_STATUS',
      '',
      '## Active tasks',
      '',
      '### T-540 — Fix the four security residuals',
      '- **Status:** merged',
      '- **Owner role:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** qa',
      '- **Evidence:** commit: aaaaaaa branch: main',
      '- **Notes:** —',
      '',
      '### T-541 — Close the four T-540 security residuals — follow-up audit',
      '- **Status:** planned',
      '- **Owner role:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** —',
      '- **Evidence:** —',
      '- **Notes:** —',
      '',
      '## Recently completed tasks',
      '',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'T-542 fixture',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        wave_goal: 'fixture wave goal',
        parked_waves: [],
        active_slices: ['T-541'],
        next_action: 'T-541 → developer → follow-up audit',
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 541,
        last_updated: '2020-01-01',
        deploy_contours: 0,
        wave_summary: null,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );

  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial state'], { cwd: repoDir });

  const result = runCloseSessionCli(repoDir, __dirname, ['--non-interactive']);

  const backlogAfter = fs.readFileSync(path.join(repoDir, 'BACKLOG.md'), 'utf8');
  const taskStatusAfter = fs.readFileSync(path.join(repoDir, 'TASK_STATUS.md'), 'utf8');

  // (a) TASK_STATUS.md: T-540 moved to Recently completed; T-541 stays in
  // Active tasks, still `planned`, NOT archived.
  const completedIdx = taskStatusAfter.indexOf('## Recently completed tasks');
  assert.ok(
    taskStatusAfter.indexOf('### T-540') > completedIdx,
    `Case 28 FAIL: T-540 must be moved to TASK_STATUS Recently completed, got:\n${taskStatusAfter}`
  );
  const activeSectionTS = taskStatusAfter.slice(taskStatusAfter.indexOf('## Active tasks'), completedIdx);
  assert.ok(
    /### T-541 — Close the four T-540 security residuals — follow-up audit\n- \*\*Status:\*\* planned/.test(activeSectionTS),
    `Case 28 FAIL: T-541 must remain in TASK_STATUS Active tasks, still planned, got:\n${activeSectionTS}`
  );

  // (b) BACKLOG.md: T-540 archived (mid-wave); T-541 remains under Active
  // Wave, still `planned`, untouched.
  const midWaveArchiveIdx = backlogAfter.indexOf('## Wave 1 — Archived (mid-wave)');
  assert.ok(
    midWaveArchiveIdx !== -1,
    `Case 28 FAIL: expected a mid-wave archive heading in BACKLOG.md, got:\n${backlogAfter}`
  );
  const activeWaveSection = backlogAfter.slice(backlogAfter.indexOf('## Active Wave'), midWaveArchiveIdx);
  assert.ok(
    !activeWaveSection.includes('### T-540'),
    `Case 28 FAIL: T-540 must not remain under BACKLOG Active Wave, got:\n${activeWaveSection}`
  );
  assert.ok(
    /### T-541 — Close the four T-540 security residuals — follow-up audit\n- \*\*Status:\*\* planned/.test(activeWaveSection),
    `Case 28 FAIL: T-541 must remain under BACKLOG Active Wave, still planned (not fabricated to merged), got:\n${activeWaveSection}`
  );

  // (c) The validator (run inside --close-session) genuinely passes — not a
  // false-healthy reading over corrupted state (that was the tell in the
  // real incident: the fabrication passed validation because the mislabeled
  // T-541 block had already been archived out of every checked section).
  assert.ok(
    /Validator passed/.test(result.stdout),
    `Case 28 FAIL: expected validator to pass, got:\n${result.stdout}\nstderr: ${result.stderr}`
  );

  console.log('Case 28 passed: close-session over the incident layout keeps T-541 planned in both artifacts/sections and does not archive it; only T-540 moves');

  cleanup(repoDir);
}

console.log('All T-542 assertions passed.');
