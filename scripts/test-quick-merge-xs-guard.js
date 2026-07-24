'use strict';
// Regression test: T-450 — quick-merge XS guard + batch support.
//
// Covers:
//   Part 1 — unit: checkXsGuard(commitHash, cwd) against real fixture git
//   commits: compliant (ok:true), new file added, sensitive path touched,
//   too many total changed lines, too many files changed, binary file diff,
//   and an unresolvable commit hash.
//   Part 2 — end-to-end via the actual mavp-operator-quick-merge.js script,
//   piped stdin:
//     2a. single-item piped (3 lines) still works — registers 1 merged task
//         with commit: evidence, validator healthy.
//     2b. batch of two compliant items registers two sequential merged
//         T-NNN tasks with commit: evidence, one validator pass.
//     2c. batch containing one bad item (new-file commit) refuses the
//         ENTIRE run, naming the offending item — BACKLOG.md/TASK_STATUS.md
//         are left byte-for-byte unchanged (zero partial registration).
//     2d. batch containing a commit touching a sensitive path refuses,
//         naming the sensitive path — no files written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const { checkXsGuard, isSensitivePath } = require('./mavp-operator-quick-merge.js');

const SCRIPTS_DIR = __dirname;
const QUICK_MERGE_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-quick-merge.js');

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); }

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message, '--no-gpg-sign']);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// ---------------------------------------------------------------------------
// Build a fixture git repo with a baseline commit, then one commit per
// guard scenario. Also seeds BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.json
// so the same repo doubles as a quick-merge project fixture for Part 2.
// ---------------------------------------------------------------------------
function buildFixtureRepo() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't450-xsguard-'));

  git(TMP, ['init', '-q']);
  git(TMP, ['config', 'user.email', 'demo@example.invalid']);
  git(TMP, ['config', 'user.name', 'Test User']);
  git(TMP, ['config', 'commit.gpgsign', 'false']);

  // The quick-merge script under test mutates BACKLOG.md/TASK_STATUS.md/
  // PROCESS_STATE.json directly in the working tree (uncommitted). Keep them
  // untracked/ignored so later `git add -A` guard-fixture commits never pick
  // up those in-flight artifact edits alongside the intentional scenario diff.
  writeUtf8(path.join(TMP, '.gitignore'), 'BACKLOG.md\nTASK_STATUS.md\nPROCESS_STATE.json\nEXECUTION_LOG.md\n');

  // Baseline tracked files — later commits modify these (never add new
  // ones) so the new-file check only fires for the scenario meant to test it.
  writeUtf8(path.join(TMP, 'sample.txt'), 'line1\nline2\nline3\n');
  writeUtf8(path.join(TMP, 'fileA.txt'), 'a\n');
  writeUtf8(path.join(TMP, 'fileB.txt'), 'b\n');
  writeUtf8(path.join(TMP, 'fileC.txt'), 'c\n');
  writeUtf8(path.join(TMP, 'scripts', 'mavp-operator-lib.js'), '// baseline stub\n');
  fs.writeFileSync(path.join(TMP, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));

  writeUtf8(path.join(TMP, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave



## Deferred Tasks
`);
  writeUtf8(path.join(TMP, 'TASK_STATUS.md'), `# TASK_STATUS

## Status legend

- \`planned\`
- \`merged\`

## Active tasks

## Recently completed tasks
`);
  writeUtf8(path.join(TMP, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-450 test fixture',
    stage: 'execution',
    wave: 64,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: 'Open next wave',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 449,
    last_updated: '2026-07-23',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  const baselineHash = commit(TMP, 'baseline');

  // --- compliant: modify sample.txt with a small (<=10 line) tweak ---
  writeUtf8(path.join(TMP, 'sample.txt'), 'line1\nline2 modified\nline3\n');
  const compliantHash = commit(TMP, 'compliant tweak');

  // --- new file: adds a brand-new tracked file ---
  writeUtf8(path.join(TMP, 'new_file.txt'), 'brand new\n');
  const newFileHash = commit(TMP, 'adds a new file');

  // --- sensitive path: modifies scripts/mavp-operator-lib.js (existing) ---
  writeUtf8(path.join(TMP, 'scripts', 'mavp-operator-lib.js'), '// baseline stub\n// tweak\n');
  const sensitiveHash = commit(TMP, 'touches sensitive path');

  // --- too many total lines: rewrite sample.txt with >10 changed lines ---
  writeUtf8(path.join(TMP, 'sample.txt'), Array.from({ length: 12 }, (_, i) => `new line ${i}`).join('\n') + '\n');
  const tooManyLinesHash = commit(TMP, 'too many changed lines');

  // --- too many files: small tweak across 3 existing files ---
  writeUtf8(path.join(TMP, 'fileA.txt'), 'a modified\n');
  writeUtf8(path.join(TMP, 'fileB.txt'), 'b modified\n');
  writeUtf8(path.join(TMP, 'fileC.txt'), 'c modified\n');
  const tooManyFilesHash = commit(TMP, 'touches 3 files');

  // --- binary file: modify image.bin (existing) ---
  fs.writeFileSync(path.join(TMP, 'image.bin'), Buffer.from([9, 9, 9, 0, 128, 200]));
  const binaryHash = commit(TMP, 'modifies binary file');

  return {
    TMP,
    baselineHash,
    compliantHash,
    newFileHash,
    sensitiveHash,
    tooManyLinesHash,
    tooManyFilesHash,
    binaryHash,
  };
}

const fixture = buildFixtureRepo();

// ---------------------------------------------------------------------------
// Part 1 — unit tests against checkXsGuard()
// ---------------------------------------------------------------------------

{
  const verdict = checkXsGuard(fixture.compliantHash, fixture.TMP);
  assert.strictEqual(verdict.ok, true, `Test 1a FAIL: expected compliant commit to pass, got ${JSON.stringify(verdict)}`);
  console.log('Test 1a passed: compliant commit (<=2 files, <=10 lines, no new files, no sensitive path) passes the XS guard');
}

{
  const verdict = checkXsGuard(fixture.newFileHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1b FAIL: expected new-file commit to be refused');
  assert.strictEqual(verdict.violation, 'new_files', `Test 1b FAIL: expected violation "new_files", got "${verdict.violation}"`);
  assert.ok(/zero new files allowed/i.test(verdict.detail), `Test 1b FAIL: expected "zero new files" in detail, got: ${verdict.detail}`);
  assert.ok(verdict.detail.includes('new_file.txt'), `Test 1b FAIL: expected detail to name the added file, got: ${verdict.detail}`);
  console.log(`Test 1b passed: commit adding a new tracked file refused — ${verdict.detail}`);
}

{
  const verdict = checkXsGuard(fixture.sensitiveHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1c FAIL: expected sensitive-path commit to be refused');
  assert.strictEqual(verdict.violation, 'sensitive_path', `Test 1c FAIL: expected violation "sensitive_path", got "${verdict.violation}"`);
  assert.ok(verdict.detail.includes('scripts/mavp-operator-lib.js'), `Test 1c FAIL: expected detail to name the sensitive path, got: ${verdict.detail}`);
  console.log(`Test 1c passed: commit touching scripts/mavp-operator-lib.js refused, naming the sensitive path — ${verdict.detail}`);
}

{
  const verdict = checkXsGuard(fixture.tooManyLinesHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1d FAIL: expected >10-line commit to be refused');
  assert.strictEqual(verdict.violation, 'total_lines', `Test 1d FAIL: expected violation "total_lines", got "${verdict.violation}"`);
  assert.ok(/max 10/.test(verdict.detail), `Test 1d FAIL: expected "max 10" threshold named, got: ${verdict.detail}`);
  console.log(`Test 1d passed: commit with >10 total changed lines refused, naming threshold + measured value — ${verdict.detail}`);
}

{
  const verdict = checkXsGuard(fixture.tooManyFilesHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1e FAIL: expected >2-files commit to be refused');
  assert.strictEqual(verdict.violation, 'files_changed', `Test 1e FAIL: expected violation "files_changed", got "${verdict.violation}"`);
  assert.ok(/3 files \(max 2\)/.test(verdict.detail), `Test 1e FAIL: expected "3 files (max 2)" in detail, got: ${verdict.detail}`);
  console.log(`Test 1e passed: commit touching 3 files refused, naming threshold + measured value — ${verdict.detail}`);
}

{
  const verdict = checkXsGuard(fixture.binaryHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1f FAIL: expected binary-file commit to be refused');
  assert.strictEqual(verdict.violation, 'binary_file', `Test 1f FAIL: expected violation "binary_file", got "${verdict.violation}"`);
  console.log(`Test 1f passed: commit touching a binary file refused (line count not mechanically checkable) — ${verdict.detail}`);
}

{
  const fakeHash = '0123456789abcdef0123456789abcdef01234567';
  const verdict = checkXsGuard(fakeHash, fixture.TMP);
  assert.strictEqual(verdict.ok, false, 'Test 1g FAIL: expected unresolvable commit to be refused');
  assert.strictEqual(verdict.violation, 'unresolvable', `Test 1g FAIL: expected violation "unresolvable", got "${verdict.violation}"`);
  assert.ok(/not resolvable/i.test(verdict.detail), `Test 1g FAIL: expected "not resolvable" in detail, got: ${verdict.detail}`);
  console.log(`Test 1g passed: unresolvable commit hash refused — ${verdict.detail}`);
}

{
  assert.strictEqual(isSensitivePath('scripts/mavp-operator-lib.js'), true, 'Test 1h FAIL: expected exact sensitive path match');
  assert.strictEqual(isSensitivePath('scripts/mavp-operator'), true, 'Test 1h FAIL: expected wrapper self-reference to be sensitive');
  assert.strictEqual(isSensitivePath('scripts/mavp-operator-quick-merge.js'), true, 'Test 1h FAIL: expected guard self-reference to be sensitive');
  assert.strictEqual(isSensitivePath('.claude/hooks/pre-commit'), true, 'Test 1h FAIL: expected .claude/hooks/* prefix match');
  assert.strictEqual(isSensitivePath('scripts/mavp-publish-manifest-tool.js'), true, 'Test 1h FAIL: expected scripts/mavp-publish-* prefix match');
  assert.strictEqual(isSensitivePath('scripts/mavp-operator-park-wave.js'), false, 'Test 1h FAIL: unrelated script must not be flagged sensitive');
  console.log('Test 1h passed: isSensitivePath() matches the exact set + prefixes, and nothing else');
}

// ---------------------------------------------------------------------------
// Part 2 — end-to-end via the actual script, piped stdin.
// ---------------------------------------------------------------------------

function runQuickMerge(cwd, stdinText) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: cwd, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  const res = spawnSync('node', [QUICK_MERGE_PATH], {
    cwd,
    env,
    input: stdinText,
    encoding: 'utf8',
  });
  return res;
}

// 2a. single-item piped (3 lines) still works.
{
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const stdinText = `Single item quick fix\n${fixture.compliantHash}\na trivial tweak\n`;
  const res = runQuickMerge(fixture.TMP, stdinText);

  assert.strictEqual(res.status, 0, `Test 2a FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(res.stdout.includes('T-450 added (merged)'), `Test 2a FAIL: expected T-450 registered, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes('Validator: healthy') || res.stdout.includes('Validator: drifting'), `Test 2a FAIL: expected validator to run, got:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.ok(backlogAfter.includes('### T-450 — Single item quick fix'), 'Test 2a FAIL: expected BACKLOG.md to contain the new task');
  assert.ok(taskStatusAfter.includes(`commit: ${fixture.compliantHash} branch: main`), 'Test 2a FAIL: expected TASK_STATUS.md evidence to contain commit:');
  assert.notStrictEqual(backlogAfter, backlogBefore, 'Test 2a FAIL: BACKLOG.md should have changed');
  assert.notStrictEqual(taskStatusAfter, taskStatusBefore, 'Test 2a FAIL: TASK_STATUS.md should have changed');

  console.log('Test 2a passed: single-item piped (3-line) quick-merge still registers a merged task with commit: evidence');
}

// 2b. batch of two compliant items -> two sequential merged T-NNN, one validator pass.
{
  // Need two distinct compliant commits — reuse compliantHash for one and
  // baselineHash (identical-tree no-op diff against its own parent's parent
  // doesn't exist; instead make a second small compliant commit).
  writeUtf8(path.join(fixture.TMP, 'fileA.txt'), 'a modified again\n');
  git(fixture.TMP, ['add', '-A']);
  git(fixture.TMP, ['commit', '-m', 'second compliant tweak', '--no-gpg-sign']);
  const secondCompliantHash = git(fixture.TMP, ['rev-parse', 'HEAD']);

  // Build the 6-line piped payload explicitly (two items, no note on the second).
  const payload = `Batch item one\n${secondCompliantHash}\nnote one\nBatch item two\n${fixture.compliantHash}\n\n`;

  const res = runQuickMerge(fixture.TMP, payload);
  assert.strictEqual(res.status, 0, `Test 2b FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(res.stdout.includes('T-451'), `Test 2b FAIL: expected T-451 in output, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes('T-452'), `Test 2b FAIL: expected T-452 in output, got:\n${res.stdout}`);

  const validatorRunCount = (res.stdout.match(/Running validator\.\.\./g) || []).length;
  assert.strictEqual(validatorRunCount, 1, `Test 2b FAIL: expected exactly one validator run, got ${validatorRunCount}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.ok(backlogAfter.includes('### T-451 — Batch item one'), 'Test 2b FAIL: expected T-451 block in BACKLOG.md');
  assert.ok(backlogAfter.includes('### T-452 — Batch item two'), 'Test 2b FAIL: expected T-452 block in BACKLOG.md');
  assert.ok(taskStatusAfter.includes(`commit: ${secondCompliantHash} branch: main`), 'Test 2b FAIL: expected T-451 commit evidence');
  assert.ok(taskStatusAfter.includes(`commit: ${fixture.compliantHash} branch: main`), 'Test 2b FAIL: expected T-452 commit evidence');

  const state = JSON.parse(readUtf8(path.join(fixture.TMP, 'PROCESS_STATE.json')));
  assert.strictEqual(state.last_task_id, 452, `Test 2b FAIL: expected last_task_id 452, got ${state.last_task_id}`);

  console.log('Test 2b passed: batch of two compliant items registers two sequential merged T-NNN tasks with commit: evidence, one validator pass');
}

// 2c. batch containing one bad item (new-file commit) refuses the ENTIRE run.
{
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  const stateBefore = readUtf8(path.join(fixture.TMP, 'PROCESS_STATE.json'));

  writeUtf8(path.join(fixture.TMP, 'fileB.txt'), 'b modified again\n');
  git(fixture.TMP, ['add', '-A']);
  git(fixture.TMP, ['commit', '-m', 'third compliant tweak', '--no-gpg-sign']);
  const thirdCompliantHash = git(fixture.TMP, ['rev-parse', 'HEAD']);

  const payload = `Good item\n${thirdCompliantHash}\n\nBad item adds a file\n${fixture.newFileHash}\n\n`;
  const res = runQuickMerge(fixture.TMP, payload);

  assert.notStrictEqual(res.status, 0, `Test 2c FAIL: expected non-zero exit refusing the batch, got ${res.status}`);
  assert.ok(res.stdout.includes('Bad item adds a file'), `Test 2c FAIL: expected offending item named in output, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes('zero new files allowed'), `Test 2c FAIL: expected new_files violation named, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes('no BACKLOG.md/TASK_STATUS.md changes were made'), `Test 2c FAIL: expected zero-partial-registration message, got:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  const stateAfter = readUtf8(path.join(fixture.TMP, 'PROCESS_STATE.json'));
  assert.strictEqual(backlogAfter, backlogBefore, 'Test 2c FAIL: BACKLOG.md must be byte-for-byte unchanged (zero partial registration)');
  assert.strictEqual(taskStatusAfter, taskStatusBefore, 'Test 2c FAIL: TASK_STATUS.md must be byte-for-byte unchanged (zero partial registration)');
  assert.strictEqual(stateAfter, stateBefore, 'Test 2c FAIL: PROCESS_STATE.json must be byte-for-byte unchanged');
  assert.ok(!backlogAfter.includes('Good item'), 'Test 2c FAIL: the good item must NOT have been registered either (zero partial registration)');

  console.log('Test 2c passed: batch with one non-XS commit (new file) refuses the ENTIRE run, naming the offending item, with zero partial registration');
}

// 2d. batch containing a sensitive-path commit refuses, naming the path.
{
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const payload = `Sensitive edit\n${fixture.sensitiveHash}\n\n`;
  const res = runQuickMerge(fixture.TMP, payload);

  assert.notStrictEqual(res.status, 0, `Test 2d FAIL: expected non-zero exit, got ${res.status}`);
  assert.ok(res.stdout.includes('scripts/mavp-operator-lib.js'), `Test 2d FAIL: expected sensitive path named in output, got:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.strictEqual(backlogAfter, backlogBefore, 'Test 2d FAIL: BACKLOG.md must be unchanged after a sensitive-path refusal');
  assert.strictEqual(taskStatusAfter, taskStatusBefore, 'Test 2d FAIL: TASK_STATUS.md must be unchanged after a sensitive-path refusal');

  console.log('Test 2d passed: batch containing a commit touching a sensitive path refuses the run, naming the sensitive path');
}

fs.rmSync(fixture.TMP, { recursive: true, force: true });

console.log('\nAll test-quick-merge-xs-guard.js assertions passed.');
