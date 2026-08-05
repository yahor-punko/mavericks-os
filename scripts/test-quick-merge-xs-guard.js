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
//   Part 3 — T-613: --verification-type / --owner batch-wide declaration
//   flags:
//     3a. parseCliArgs/validateFlags default to runtime/developer when both
//         flags are absent.
//     3b. parseCliArgs/validateFlags resolve a valid --verification-type
//         artifact --owner technical-writer pair.
//     3c. single-item piped run with --verification-type artifact --owner
//         technical-writer stamps both fields in BACKLOG.md and
//         TASK_STATUS.md (matches the literal AC example).
//     3d. batch of two items with flags set stamps BOTH items identically
//         (batch-wide, not per-item).
//     3e. flagless single-item piped run still stamps developer/runtime
//         (byte-identical default path).
//     3f/3g. --verification-type visual / manual refused (human-review
//         types can never ride this lane) — entire run refused before any
//         input is collected or file written, allowed set named.
//     3h. --verification-type of an unrecognized value refused, naming the
//         value and the allowed set.
//     3i. --owner of an unrecognized role refused, naming the value and the
//         allowed set.
//   Part 4 — T-616 Defect A: batch-wide flag-resolution echo line, printed
//   after flag validation succeeds and before item collection begins:
//     4a. buildFlagEchoLine() marks both values as defaults when neither flag
//         was supplied, and omits the batch-wide wording.
//     4b. buildFlagEchoLine() states the batch-wide scope in words whenever
//         either flag was explicitly supplied, and does not mark either value
//         as a default.
//     4c. end-to-end: a piped run with both flags prints the echo line
//         (both values + batch-wide wording) BEFORE any registration line.
//     4d. end-to-end: a flagless piped run prints both values marked as
//         defaults.
//   Part 5 — T-616 Defect B: the post-registration validator spawn passes
//   ROOT as its first argument, so it judges the resolved project root
//   rather than process.cwd(). A dedicated second fixture (its own git repo,
//   built with the same git()/commit()/writeUtf8() helpers used above) seeds
//   a pre-existing merged task with no commit evidence — a FAILURE-severity
//   merged_missing_commit_field finding (validator exit 2). Running
//   quick-merge with MAVERICKS_PROJECT_ROOT pointed at that fixture while the
//   process cwd is set to the UNRELATED Part 1-3 fixture must report the
//   Defect-B fixture's own finding, not the cwd repo's state.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  checkXsGuard,
  isSensitivePath,
  parseCliArgs,
  validateFlags,
  buildFlagEchoLine,
  ALLOWED_VERIFICATION_TYPES,
  ALLOWED_OWNER_ROLES,
} = require('./mavp-operator-quick-merge.js');

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

function runQuickMerge(cwd, stdinText, argv = []) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: cwd, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  const res = spawnSync('node', [QUICK_MERGE_PATH, ...argv], {
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

// ---------------------------------------------------------------------------
// Part 3 — T-613: --verification-type / --owner batch-wide declaration flags
// ---------------------------------------------------------------------------

// 3a. parseCliArgs/validateFlags default to runtime/developer when absent.
{
  const flags = validateFlags(parseCliArgs([]));
  assert.deepStrictEqual(
    flags,
    { ok: true, verificationType: 'runtime', owner: 'developer' },
    `Test 3a FAIL: expected default runtime/developer, got ${JSON.stringify(flags)}`,
  );
  console.log('Test 3a passed: absent flags resolve to the unchanged defaults (runtime / developer)');
}

// 3b. parseCliArgs/validateFlags resolve a valid explicit pair.
{
  const flags = validateFlags(parseCliArgs(['--verification-type', 'artifact', '--owner', 'technical-writer']));
  assert.deepStrictEqual(
    flags,
    { ok: true, verificationType: 'artifact', owner: 'technical-writer' },
    `Test 3b FAIL: expected artifact/technical-writer, got ${JSON.stringify(flags)}`,
  );
  console.log('Test 3b passed: --verification-type artifact --owner technical-writer resolves correctly');
}

// 3c. single-item piped run with the flags set stamps both fields (literal AC example).
{
  const stdinText = 'Flagged single item\n' + fixture.compliantHash + '\na docs-only tweak\n';
  const res = runQuickMerge(fixture.TMP, stdinText, ['--verification-type', 'artifact', '--owner', 'technical-writer']);
  assert.strictEqual(res.status, 0, `Test 3c FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const backlogPattern = /### T-\d+ — Flagged single item\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* technical-writer\n- \*\*Repo:\*\* mavericks\n- \*\*Verification type:\*\* artifact/;
  const taskStatusPattern = /### T-\d+ — Flagged single item\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* technical-writer\n- \*\*Verification type:\*\* artifact/;
  assert.ok(backlogPattern.test(backlogAfter), `Test 3c FAIL: expected BACKLOG.md to stamp Owner role technical-writer / Verification type artifact, got:\n${backlogAfter}`);
  assert.ok(taskStatusPattern.test(taskStatusAfter), `Test 3c FAIL: expected TASK_STATUS.md to stamp Owner role technical-writer / Verification type artifact, got:\n${taskStatusAfter}`);

  console.log('Test 3c passed: --verification-type artifact --owner technical-writer stamps both BACKLOG.md and TASK_STATUS.md blocks correctly');
}

// 3d. batch of two items — flags are batch-wide, both items stamped identically.
{
  const payload = 'Flagged batch one\n' + fixture.compliantHash + '\n\nFlagged batch two\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, payload, ['--verification-type', 'unit', '--owner', 'qa']);
  assert.strictEqual(res.status, 0, `Test 3d FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const onePattern = /### T-\d+ — Flagged batch one\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* qa\n- \*\*Repo:\*\* mavericks\n- \*\*Verification type:\*\* unit/;
  const twoPattern = /### T-\d+ — Flagged batch two\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* qa\n- \*\*Repo:\*\* mavericks\n- \*\*Verification type:\*\* unit/;
  assert.ok(onePattern.test(backlogAfter), `Test 3d FAIL: expected item one stamped qa/unit, got:\n${backlogAfter}`);
  assert.ok(twoPattern.test(backlogAfter), `Test 3d FAIL: expected item two stamped qa/unit (batch-wide), got:\n${backlogAfter}`);

  console.log('Test 3d passed: batch-wide flags apply to every item in the run, not just the first');
}

// 3e. flagless single-item piped run still stamps developer/runtime — byte-identical default path.
{
  const stdinText = 'Unflagged default item\n' + fixture.compliantHash + '\na trivial tweak\n';
  const res = runQuickMerge(fixture.TMP, stdinText);
  assert.strictEqual(res.status, 0, `Test 3e FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  const backlogPattern = /### T-\d+ — Unflagged default item\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* developer\n- \*\*Repo:\*\* mavericks\n- \*\*Verification type:\*\* runtime/;
  const taskStatusPattern = /### T-\d+ — Unflagged default item\n- \*\*Status:\*\* merged\n- \*\*Owner role:\*\* developer\n- \*\*Verification type:\*\* runtime/;
  assert.ok(backlogPattern.test(backlogAfter), `Test 3e FAIL: expected default developer/runtime stamping, got:\n${backlogAfter}`);
  assert.ok(taskStatusPattern.test(taskStatusAfter), `Test 3e FAIL: expected default developer/runtime stamping, got:\n${taskStatusAfter}`);

  console.log('Test 3e passed: a flagless run stays byte-identical to the pre-T-613 developer/runtime stamping');
}

// 3f/3g. --verification-type visual and manual are refused (human-review types can never ride this lane).
for (const badType of ['visual', 'manual']) {
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const stdinText = 'Should never register\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, stdinText, ['--verification-type', badType]);

  assert.strictEqual(res.status, 1, `Test 3f/g (${badType}) FAIL: expected exit 1, got ${res.status}. stdout:\n${res.stdout}`);
  assert.ok(res.stdout.includes(`--verification-type "${badType}"`), `Test 3f/g (${badType}) FAIL: expected the invalid value named, got:\n${res.stdout}`);
  for (const allowed of ALLOWED_VERIFICATION_TYPES) {
    assert.ok(res.stdout.includes(allowed), `Test 3f/g (${badType}) FAIL: expected allowed value "${allowed}" named, got:\n${res.stdout}`);
  }
  assert.ok(!res.stdout.includes('Title (required)'), `Test 3f/g (${badType}) FAIL: expected refusal BEFORE input collection, but input-collection output was printed:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.strictEqual(backlogAfter, backlogBefore, `Test 3f/g (${badType}) FAIL: BACKLOG.md must be byte-unchanged`);
  assert.strictEqual(taskStatusAfter, taskStatusBefore, `Test 3f/g (${badType}) FAIL: TASK_STATUS.md must be byte-unchanged`);
  assert.ok(!backlogAfter.includes('Should never register'), `Test 3f/g (${badType}) FAIL: the item must NOT have been registered`);

  console.log(`Test 3f/g passed (--verification-type ${badType}): refused before any write, naming the value and the allowed set (${ALLOWED_VERIFICATION_TYPES.join(', ')})`);
}

// 3h. --verification-type of an unrecognized value is refused.
{
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const stdinText = 'Should never register either\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, stdinText, ['--verification-type', 'bogus-type']);

  assert.strictEqual(res.status, 1, `Test 3h FAIL: expected exit 1, got ${res.status}. stdout:\n${res.stdout}`);
  assert.ok(res.stdout.includes('--verification-type "bogus-type"'), `Test 3h FAIL: expected the invalid value named, got:\n${res.stdout}`);
  assert.ok(res.stdout.includes(ALLOWED_VERIFICATION_TYPES.join(', ')), `Test 3h FAIL: expected the allowed set named, got:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.strictEqual(backlogAfter, backlogBefore, 'Test 3h FAIL: BACKLOG.md must be byte-unchanged');
  assert.strictEqual(taskStatusAfter, taskStatusBefore, 'Test 3h FAIL: TASK_STATUS.md must be byte-unchanged');

  console.log('Test 3h passed: an unrecognized --verification-type value is refused, naming the value and the allowed set');
}

// 3i. --owner of an unrecognized role is refused.
{
  const backlogBefore = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusBefore = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));

  const stdinText = 'Should never register at all\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, stdinText, ['--owner', 'bogus-role']);

  assert.strictEqual(res.status, 1, `Test 3i FAIL: expected exit 1, got ${res.status}. stdout:\n${res.stdout}`);
  assert.ok(res.stdout.includes('--owner "bogus-role"'), `Test 3i FAIL: expected the invalid value named, got:\n${res.stdout}`);
  for (const allowed of ALLOWED_OWNER_ROLES) {
    assert.ok(res.stdout.includes(allowed), `Test 3i FAIL: expected allowed owner role "${allowed}" named, got:\n${res.stdout}`);
  }
  assert.ok(!res.stdout.includes('Title (required)'), `Test 3i FAIL: expected refusal BEFORE input collection, got:\n${res.stdout}`);

  const backlogAfter = readUtf8(path.join(fixture.TMP, 'BACKLOG.md'));
  const taskStatusAfter = readUtf8(path.join(fixture.TMP, 'TASK_STATUS.md'));
  assert.strictEqual(backlogAfter, backlogBefore, 'Test 3i FAIL: BACKLOG.md must be byte-unchanged');
  assert.strictEqual(taskStatusAfter, taskStatusBefore, 'Test 3i FAIL: TASK_STATUS.md must be byte-unchanged');

  console.log('Test 3i passed: an unrecognized --owner value is refused, naming the value and the allowed set');
}

// ---------------------------------------------------------------------------
// Part 4 — T-616 Defect A: batch-wide flag-resolution echo line
// ---------------------------------------------------------------------------

// 4a. buildFlagEchoLine() marks both values as defaults when neither flag was supplied.
{
  const line = buildFlagEchoLine(
    { verificationType: null, owner: null },
    { verificationType: 'runtime', owner: 'developer' },
  );
  assert.ok(line.includes('runtime (default)'), `Test 4a FAIL: expected "runtime (default)" in echo line, got: ${line}`);
  assert.ok(line.includes('developer (default)'), `Test 4a FAIL: expected "developer (default)" in echo line, got: ${line}`);
  assert.ok(!/apply to every item/i.test(line), `Test 4a FAIL: expected NO batch-wide wording on a flagless resolution, got: ${line}`);
  console.log(`Test 4a passed: buildFlagEchoLine() marks both values as defaults when neither flag is supplied — "${line}"`);
}

// 4b. buildFlagEchoLine() states batch-wide scope in words when either flag was explicitly supplied.
{
  const line = buildFlagEchoLine(
    { verificationType: 'artifact', owner: 'technical-writer' },
    { verificationType: 'artifact', owner: 'technical-writer' },
  );
  assert.ok(line.includes('artifact'), `Test 4b FAIL: expected "artifact" in echo line, got: ${line}`);
  assert.ok(!line.includes('artifact (default)'), `Test 4b FAIL: expected verification type NOT marked as default, got: ${line}`);
  assert.ok(line.includes('technical-writer'), `Test 4b FAIL: expected "technical-writer" in echo line, got: ${line}`);
  assert.ok(!line.includes('technical-writer (default)'), `Test 4b FAIL: expected owner NOT marked as default, got: ${line}`);
  assert.ok(/apply to every item in this batch/i.test(line), `Test 4b FAIL: expected batch-wide wording when a flag was explicitly supplied, got: ${line}`);
  console.log(`Test 4b passed: buildFlagEchoLine() states batch-wide scope in words when a flag was explicitly supplied — "${line}"`);
}

// 4c. end-to-end: a piped run with both flags prints the echo line (both values
// + batch-wide wording) BEFORE any registration line.
{
  const stdinText = 'Echo line flagged item\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, stdinText, ['--verification-type', 'artifact', '--owner', 'technical-writer']);
  assert.strictEqual(res.status, 0, `Test 4c FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const expectedEchoLine = 'Verification type: artifact. Owner: technical-writer. These resolved values apply to every item in this batch.';
  const echoIdx = res.stdout.indexOf(expectedEchoLine);
  assert.ok(echoIdx !== -1, `Test 4c FAIL: expected the echo line "${expectedEchoLine}" in stdout, got:\n${res.stdout}`);

  const registrationIdx = res.stdout.indexOf('added (merged)');
  assert.ok(registrationIdx !== -1, `Test 4c FAIL: expected a registration line in stdout, got:\n${res.stdout}`);
  assert.ok(echoIdx < registrationIdx, `Test 4c FAIL: expected the echo line BEFORE the registration line, got echoIdx=${echoIdx} registrationIdx=${registrationIdx}`);

  console.log(`Test 4c passed: flagged piped run prints the echo line before any registration line — "${expectedEchoLine}"`);
}

// 4d. end-to-end: a flagless run prints both values marked as defaults.
{
  const stdinText = 'Echo line flagless item\n' + fixture.compliantHash + '\n\n';
  const res = runQuickMerge(fixture.TMP, stdinText);
  assert.strictEqual(res.status, 0, `Test 4d FAIL: expected exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const expectedEchoLine = 'Verification type: runtime (default). Owner: developer (default).';
  assert.ok(res.stdout.includes(expectedEchoLine), `Test 4d FAIL: expected the default-marked echo line "${expectedEchoLine}" in stdout, got:\n${res.stdout}`);

  console.log(`Test 4d passed: flagless piped run prints both values marked as defaults — "${expectedEchoLine}"`);
}

// ---------------------------------------------------------------------------
// Part 5 — T-616 Defect B: validator spawn passes ROOT as its first argument
// ---------------------------------------------------------------------------

/**
 * A second, independent fixture repo for the Defect-B case: seeds a
 * pre-existing merged task with NO commit evidence (a FAILURE-severity
 * merged_missing_commit_field finding, i.e. validator exit 2), plus one
 * compliant commit so a fresh batch item can still pass the XS guard.
 * Reuses the git()/commit()/writeUtf8() helpers built for Part 1's fixture.
 *
 * The task heading is assembled via concatenation rather than typed as a
 * literal line-initial "### T-" string in this .js source file — see
 * .claude/rules/scripts.md — "Reserved shapes (bounded, not universal)".
 */
function buildDefectBFixture() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't616-rootarg-'));

  git(TMP, ['init', '-q']);
  git(TMP, ['config', 'user.email', 'demo@example.invalid']);
  git(TMP, ['config', 'user.name', 'Test User']);
  git(TMP, ['config', 'commit.gpgsign', 'false']);

  writeUtf8(path.join(TMP, '.gitignore'), 'BACKLOG.md\nTASK_STATUS.md\nPROCESS_STATE.json\nEXECUTION_LOG.md\n');
  writeUtf8(path.join(TMP, 'sample.txt'), 'line1\nline2\nline3\n');

  const heading = '#'.repeat(3);
  const fixtureTaskId = 'T-' + '901';

  writeUtf8(path.join(TMP, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

${heading} ${fixtureTaskId} — Fixture task missing commit evidence
- **Status:** merged
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime

**Problem:** pre-seeded so the validator reports a repair-required finding for THIS fixture.

## Deferred Tasks
`);

  writeUtf8(path.join(TMP, 'TASK_STATUS.md'), `# TASK_STATUS

## Status legend

- \`planned\`
- \`merged\`

## Active tasks

${heading} ${fixtureTaskId} — Fixture task missing commit evidence
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime

- **Evidence:** intentionally has no commit field

## Recently completed tasks
`);

  writeUtf8(path.join(TMP, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'T-616 Defect B fixture',
    stage: 'execution',
    wave: 76,
    wave_status: 'execution',
    wave_goal: null,
    parked_waves: [],
    active_slices: [],
    next_action: 'Open next wave',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 901,
    last_updated: '2026-08-05',
    deploy_contours: 0,
    wave_summary: null,
    rechecks: [],
  }, null, 2) + '\n');

  commit(TMP, 'baseline with pre-existing repair-required task');

  // One small compliant commit so a fresh batch item still passes the XS guard.
  writeUtf8(path.join(TMP, 'sample.txt'), 'line1\nline2 modified\nline3\n');
  const compliantHash = commit(TMP, 'compliant tweak');

  return { TMP, compliantHash, fixtureTaskId };
}

/**
 * Like runQuickMerge(), but MAVERICKS_PROJECT_ROOT and the process cwd are
 * set to two DIFFERENT directories — the exact shape Defect B needed to be
 * exercised against.
 */
function runQuickMergeCrossRoot(envRoot, cwd, stdinText, argv = []) {
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: envRoot, MAVERICKS_SCRIPTS: SCRIPTS_DIR };
  return spawnSync('node', [QUICK_MERGE_PATH, ...argv], {
    cwd,
    env,
    input: stdinText,
    encoding: 'utf8',
  });
}

// 5a. MAVERICKS_PROJECT_ROOT points at the Defect-B fixture (repair-required);
// cwd is the UNRELATED Part 1-3 fixture. A successful run's validator output
// must report the FIXTURE's (Defect-B's) own repair-required finding, not the
// cwd repo's state.
{
  const defectBFixture = buildDefectBFixture();

  const stdinText = 'Defect B probe item\n' + defectBFixture.compliantHash + '\n\n';
  const res = runQuickMergeCrossRoot(defectBFixture.TMP, fixture.TMP, stdinText);

  assert.ok(
    res.stdout.includes(`${defectBFixture.fixtureTaskId} is merged`),
    `Test 5a FAIL: expected the Defect-B fixture's own repair-required finding (naming ${defectBFixture.fixtureTaskId}) in stdout, got:\n${res.stdout}`,
  );
  assert.ok(
    res.stdout.includes('merged_missing_commit_field'),
    `Test 5a FAIL: expected the merged_missing_commit_field check name in stdout, got:\n${res.stdout}`,
  );
  assert.strictEqual(
    res.status, 2,
    `Test 5a FAIL: expected exit 2 (repair required), reflecting the Defect-B fixture's own state, got ${res.status}. stdout:\n${res.stdout}`,
  );
  assert.ok(
    !res.stdout.includes('Validator: healthy'),
    `Test 5a FAIL: expected the run to NOT report the cwd fixture's healthy state, got:\n${res.stdout}`,
  );

  console.log(
    `Test 5a passed: validator spawn passes ROOT — MAVERICKS_PROJECT_ROOT=<Defect-B fixture>, cwd=<unrelated fixture> reports the FIXTURE's own repair-required finding (${defectBFixture.fixtureTaskId}, exit 2), not the cwd repo's state`,
  );

  fs.rmSync(defectBFixture.TMP, { recursive: true, force: true });
}

fs.rmSync(fixture.TMP, { recursive: true, force: true });

console.log('\nAll test-quick-merge-xs-guard.js assertions passed.');
