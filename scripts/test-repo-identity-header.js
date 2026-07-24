'use strict';
// Regression test: T-447 — Repo-identity header on mutating ritual commands.
//
// Covers:
//   1. Unit: printRepoIdentityHeader(root) prints "repo: <root> | wave: N |
//      initiative: <value>" when PROCESS_STATE.json is present and parsable.
//   2. Unit: degrades to a path-only "repo: <root>" line when
//      PROCESS_STATE.json is absent.
//   3. Unit: degrades to a path-only "repo: <root>" line when
//      PROCESS_STATE.json exists but is unparsable (malformed JSON).
//   4. Unit: never throws, even for a nonexistent root path.
//   5. End-to-end: running --set-status against a fixture repo prints that
//      fixture's absolute path and wave number as the FIRST output line.
//   6. Spot-check a second mutating command (--update-status) also prints
//      the header as its first line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { printRepoIdentityHeader } = require('./mavp-operator-lib.js');

const SCRIPTS_DIR = __dirname;
const SET_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-status.js');
const UPDATE_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-update-status.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

/**
 * Capture stdout produced by fn() (which may call console.log synchronously).
 */
function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk, ...args) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return captured;
}

function runScript(scriptPath, args, cwd, env) {
  const result = spawnSync(NODE_BIN, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
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

// ---------------------------------------------------------------------------
// Part 1 — unit: printRepoIdentityHeader with a present, parsable
// PROCESS_STATE.json.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't447-full-'));
  writeUtf8(
    path.join(dir, 'PROCESS_STATE.json'),
    JSON.stringify({ wave: 42, initiative: 'Test initiative' }, null, 2)
  );

  const out = captureStdout(() => printRepoIdentityHeader(dir));
  const firstLine = out.split('\n')[0];
  assert.strictEqual(
    firstLine,
    `repo: ${dir} | wave: 42 | initiative: Test initiative`,
    `Test 1 FAIL: expected full header line, got: "${firstLine}"`
  );
  console.log('Test 1 passed: full header printed when PROCESS_STATE.json is present and parsable');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 2 — unit: degrade to path-only when PROCESS_STATE.json is absent.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't447-absent-'));
  const out = captureStdout(() => printRepoIdentityHeader(dir));
  const firstLine = out.split('\n')[0];
  assert.strictEqual(
    firstLine,
    `repo: ${dir}`,
    `Test 2 FAIL: expected path-only header, got: "${firstLine}"`
  );
  console.log('Test 2 passed: path-only fallback when PROCESS_STATE.json is absent');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 3 — unit: degrade to path-only when PROCESS_STATE.json is unparsable.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't447-malformed-'));
  writeUtf8(path.join(dir, 'PROCESS_STATE.json'), '{ this is not valid JSON');
  const out = captureStdout(() => printRepoIdentityHeader(dir));
  const firstLine = out.split('\n')[0];
  assert.strictEqual(
    firstLine,
    `repo: ${dir}`,
    `Test 3 FAIL: expected path-only header for malformed JSON, got: "${firstLine}"`
  );
  console.log('Test 3 passed: path-only fallback when PROCESS_STATE.json is unparsable');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 4 — unit: never throws, even for a nonexistent root path.
// ---------------------------------------------------------------------------
{
  const bogusRoot = path.join(os.tmpdir(), 't447-does-not-exist-xyz');
  assert.doesNotThrow(() => {
    printRepoIdentityHeader(bogusRoot);
  }, 'Test 4 FAIL: printRepoIdentityHeader must never throw');
  console.log('Test 4 passed: printRepoIdentityHeader never throws for a nonexistent root');
}

// ---------------------------------------------------------------------------
// Part 5 — end-to-end: --set-status against a fixture repo prints that
// fixture's absolute path and wave number as the FIRST output line.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't447-set-status-'));
  writeFixture(REPO, 'T-950', 'in_progress');
  writeUtf8(
    path.join(REPO, 'PROCESS_STATE.json'),
    JSON.stringify({ initiative: 'T-447 fixture', wave: 7 }, null, 2)
  );
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const r = runScript(SET_STATUS_PATH, ['T-950', 'dev_done'], REPO, env);
  const firstLine = r.stdout.split('\n')[0];
  assert.strictEqual(
    firstLine,
    `repo: ${REPO} | wave: 7 | initiative: T-447 fixture`,
    `Test 5 FAIL: expected fixture's absolute path + wave as first output line, got: "${firstLine}"`
  );
  console.log(`Test 5 passed: --set-status prints "${firstLine}" as its first output line`);
  fs.rmSync(REPO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part 6 — spot-check a second mutating command (--update-status) also
// prints the header as its first line.
// ---------------------------------------------------------------------------
{
  const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 't447-update-status-'));
  writeFixture(REPO, 'T-951', 'in_progress');
  writeUtf8(
    path.join(REPO, 'PROCESS_STATE.json'),
    JSON.stringify({ initiative: 'T-447 fixture 2', wave: 9 }, null, 2)
  );
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: REPO };

  const r = runScript(UPDATE_STATUS_PATH, ['T-951', 'dev_done'], REPO, env);
  const firstLine = r.stdout.split('\n')[0];
  assert.strictEqual(
    firstLine,
    `repo: ${REPO} | wave: 9 | initiative: T-447 fixture 2`,
    `Test 6 FAIL: expected fixture's absolute path + wave as first output line, got: "${firstLine}"`
  );
  console.log(`Test 6 passed: --update-status prints "${firstLine}" as its first output line`);
  fs.rmSync(REPO, { recursive: true, force: true });
}

console.log('\nAll T-447 assertions passed.');
