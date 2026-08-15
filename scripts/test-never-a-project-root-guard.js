'use strict';
// Regression test: T-624 — Mutating operator commands refuse a
// never-a-project repo root; repo-identity line duplicated to stderr.
//
// Covers:
//   1. Unit: checkNeverAProjectRoot() discriminator (a) — PROCESS_STATE.json
//      exists and carries the literal shipped placeholder in mavericks_version.
//   2. Unit: checkNeverAProjectRoot() discriminator (a) negative — a real
//      version string proceeds (not blocked).
//   3. Unit: checkNeverAProjectRoot() — a MISSING PROCESS_STATE.json never
//      triggers discriminator (a).
//   4. Unit: checkNeverAProjectRoot() discriminator (b) — root realpath-equals
//      an injected $HOME/.mavericks (no real ~/.mavericks needed).
//   5. Unit: guardMutatingRoot() override env var permits the write.
//   6. Unit: printRepoIdentityHeader({mutating:true}) duplicates its line to
//      stderr; printRepoIdentityHeader() (no options / mutating:false) stays
//      stdout-only (read-only-surface shape, unchanged).
//   7. RED end-to-end: --set-status against a fixture repo whose
//      PROCESS_STATE.json carries the placeholder exits 1 BEFORE any file
//      write (BACKLOG.md/TASK_STATUS.md byte-identical after), and stderr
//      names the resolved path.
//   8. GREEN end-to-end: the canonical repo shape (real version string)
//      proceeds — --set-status actually updates the Status field.
//   9. GREEN end-to-end: the override env var permits the fixture write even
//      though PROCESS_STATE.json still carries the placeholder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  checkNeverAProjectRoot,
  guardMutatingRoot,
  printRepoIdentityHeader,
  NEVER_PROJECT_ROOT_OVERRIDE_ENV,
  NEVER_PROJECT_VERSION_PLACEHOLDER,
} = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const SET_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-status.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk, ...args) => { captured += chunk; return true; };
  try { fn(); } finally { process.stdout.write = originalWrite; }
  return captured;
}

function captureStdoutAndStderr(fn) {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = (chunk, ...args) => { out += chunk; return true; };
  process.stderr.write = (chunk, ...args) => { err += chunk; return true; };
  try { fn(); } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { out, err };
}

function writeFixture(root, taskId, status) {
  writeUtf8(path.join(root, 'BACKLOG.md'), `# BACKLOG

## Selection rules

- unblockers first

## Active Wave

### ${taskId} — Fixture task
- **Status:** ${status}
- **Owner role:** developer
- **Repo:** mavericks
- **Verification type:** runtime
`);
  writeUtf8(path.join(root, 'TASK_STATUS.md'), `# TASK_STATUS

## Active tasks

### ${taskId} — Fixture task
- **Status:** ${status}
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** qa
- **Evidence:** —
- **Notes:** —

## Recently completed tasks
`);
}

function runSetStatus(args, cwd, env) {
  const result = spawnSync(NODE_BIN, [SET_STATUS_PATH, ...args], { cwd, env, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Part 1 — unit: discriminator (a), the shipped placeholder blocks.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-placeholder-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1 }));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, true, 'Test 1 FAIL: placeholder mavericks_version must block');
  assert.strictEqual(result.discriminator, 'placeholder', 'Test 1 FAIL: expected discriminator "placeholder"');
  console.log('Test 1 passed: shipped placeholder mavericks_version blocks with discriminator "placeholder"');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 2 — unit: discriminator (a) negative, a real version string proceeds.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-real-version-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1 }));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, false, 'Test 2 FAIL: a real version string must not block');
  console.log('Test 2 passed: a real mavericks_version string proceeds (not blocked)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — unit: a MISSING PROCESS_STATE.json never triggers discriminator (a).
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-missing-ps-'));
  const result = checkNeverAProjectRoot(dir);
  assert.strictEqual(result.blocked, false, 'Test 3 FAIL: a missing PROCESS_STATE.json must never block via discriminator (a)');
  assert.strictEqual(result.discriminator, null, 'Test 3 FAIL: expected no discriminator match');
  console.log('Test 3 passed: missing PROCESS_STATE.json never triggers the placeholder discriminator');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 4 — unit: discriminator (b), root realpath-equals injected $HOME/.mavericks.
// ---------------------------------------------------------------------------
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 't624-fakehome-'));
  const fakeDotMavericks = path.join(fakeHome, '.mavericks');
  fs.mkdirSync(fakeDotMavericks);
  const result = checkNeverAProjectRoot(fakeDotMavericks, { homeDir: fakeHome });
  assert.strictEqual(result.blocked, true, 'Test 4 FAIL: root resolving to $HOME/.mavericks must block');
  assert.strictEqual(result.discriminator, 'dot_mavericks', 'Test 4 FAIL: expected discriminator "dot_mavericks"');

  // Sibling directory (NOT .mavericks itself) must not block.
  const siblingDir = path.join(fakeHome, 'not-mavericks');
  fs.mkdirSync(siblingDir);
  const siblingResult = checkNeverAProjectRoot(siblingDir, { homeDir: fakeHome });
  assert.strictEqual(siblingResult.blocked, false, 'Test 4 FAIL: a sibling directory must not be misidentified as $HOME/.mavericks');

  console.log('Test 4 passed: root realpath-equal to injected $HOME/.mavericks blocks with discriminator "dot_mavericks"; a sibling directory does not');
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 5 — unit: guardMutatingRoot() override env var permits the write.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-override-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1 }));

  const blockedResult = guardMutatingRoot(dir, '--set-status', { env: {} });
  assert.strictEqual(blockedResult.blocked, true, 'Test 5 FAIL: no override env var set must block');

  const overriddenResult = guardMutatingRoot(dir, '--set-status', { env: { [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' } });
  assert.strictEqual(overriddenResult.blocked, false, 'Test 5 FAIL: override env var set to "1" must permit the write');
  assert.strictEqual(overriddenResult.overridden, true, 'Test 5 FAIL: expected overridden:true when the env var is set');

  console.log('Test 5 passed: guardMutatingRoot() blocks without the override env var and permits the write when it is set');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 6 — unit: printRepoIdentityHeader duplicates to stderr only when
// mutating:true; read-only-surface shape (no options) stays stdout-only.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't624-header-mutating-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify({ wave: 5, initiative: 'T-624 fixture' }));

  const readOnly = captureStdoutAndStderr(() => printRepoIdentityHeader(dir));
  assert.strictEqual(readOnly.err, '', 'Test 6 FAIL: read-only-surface call (no options) must not write to stderr');
  assert.ok(readOnly.out.includes(`repo: ${dir}`), 'Test 6 FAIL: stdout must still contain the identity line');

  const mutating = captureStdoutAndStderr(() => printRepoIdentityHeader(dir, { mutating: true }));
  assert.strictEqual(mutating.out, mutating.err, 'Test 6 FAIL: mutating:true must duplicate the identity line byte-for-byte to stderr');
  assert.ok(mutating.out.includes(`repo: ${dir} | wave: 5 | initiative: T-624 fixture`), 'Test 6 FAIL: expected full header content');

  console.log('Test 6 passed: printRepoIdentityHeader duplicates to stderr only when mutating:true');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 7 — RED end-to-end: --set-status against a placeholder-carrying
// fixture refuses BEFORE any write; BACKLOG.md/TASK_STATUS.md byte-identical;
// stderr names the resolved path.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-red-'));
  writeFixture(REPO, 'T-960', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1, initiative: 'T-624 red fixture' }));

  const beforeBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  const beforeTaskStatus = readUtf8(path.join(REPO, 'TASK_STATUS.md'));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-960', 'dev_done'], REPO, env);

  assert.strictEqual(r.status, 1, `Test 7 FAIL: expected exit 1, got ${r.status}. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  const afterTaskStatus = readUtf8(path.join(REPO, 'TASK_STATUS.md'));
  assert.strictEqual(afterBacklog, beforeBacklog, 'Test 7 FAIL: BACKLOG.md must be byte-identical after a refused run');
  assert.strictEqual(afterTaskStatus, beforeTaskStatus, 'Test 7 FAIL: TASK_STATUS.md must be byte-identical after a refused run');

  assert.ok(r.stderr.includes(REPO), `Test 7 FAIL: stderr must name the resolved path. stderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes('REFUSED'), 'Test 7 FAIL: stderr must contain the refusal message');
  assert.ok(r.stderr.includes(NEVER_PROJECT_ROOT_OVERRIDE_ENV), 'Test 7 FAIL: stderr must name the override env var');
  assert.ok(r.stdout.includes(REPO), 'Test 7 FAIL: stdout must also name the resolved path (BOTH stdout and stderr required)');

  console.log('Test 7 (RED) passed: --set-status refuses exit 1 before any write against a placeholder-carrying fixture; BACKLOG.md/TASK_STATUS.md byte-identical; stderr names the path');
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 8 — GREEN end-to-end: the canonical repo shape (real version string)
// proceeds — --set-status actually updates Status.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-green-canonical-'));
  writeFixture(REPO, 'T-961', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: '0.44.2', wave: 1, initiative: 'T-624 green fixture' }));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  const r = runSetStatus(['T-961', 'dev_done'], REPO, env);

  // Note: --set-status forwards the VALIDATOR's own exit code (which may
  // legitimately be 1 for an unrelated drifting warning, e.g.
  // dev_done_without_qa on this minimal fixture) — so exit code alone can't
  // distinguish "refused" from "proceeded with a validator warning". The
  // absence of the REFUSED message is what proves the guard did not block.
  assert.ok(!r.stdout.includes('REFUSED'), `Test 8 FAIL: canonical repo shape must not print the refusal message. stdout:\n${r.stdout}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  assert.ok(afterBacklog.includes('**Status:** dev_done'), 'Test 8 FAIL: BACKLOG.md Status must actually be updated to dev_done');

  console.log('Test 8 (GREEN) passed: canonical repo shape (real mavericks_version) proceeds and --set-status updates Status');
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 9 — GREEN end-to-end: the override env var permits the fixture write
// even though PROCESS_STATE.json still carries the placeholder.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't624-green-override-'));
  writeFixture(REPO, 'T-962', 'in_progress');
  writeUtf8(path.join(REPO, 'PROCESS_STATE.json'), JSON.stringify({ mavericks_version: NEVER_PROJECT_VERSION_PLACEHOLDER, wave: 1, initiative: 'T-624 override fixture' }));

  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO, [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' };
  const r = runSetStatus(['T-962', 'dev_done'], REPO, env);

  assert.ok(!r.stdout.includes('REFUSED'), `Test 9 FAIL: override env var must suppress the refusal. stdout:\n${r.stdout}`);

  const afterBacklog = readUtf8(path.join(REPO, 'BACKLOG.md'));
  assert.ok(afterBacklog.includes('**Status:** dev_done'), 'Test 9 FAIL: BACKLOG.md Status must actually be updated to dev_done when the override permits the write');

  console.log('Test 9 (GREEN) passed: override env var permits the write against a placeholder-carrying fixture');
  fs.rmSync(REPO, { recursive: true, force: true });
}

console.log('\nAll T-624 assertions passed.');
