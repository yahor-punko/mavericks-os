'use strict';
// Regression test: T-750 — --set-next-action operator command gated by
// classifyNextAction.
//
// Covers:
//   1. A directive value ("T-NNN -> ...") is written verbatim at exit 0.
//   2. A value containing a volatile fact ("the repo is at 0.44.3") is
//      REFUSED at exit 1: PROCESS_STATE.json stays byte-unchanged and stdout
//      names the matched fact ("0.44.3").
//   3. A value that does not begin with T-NNN is still written (parity with
//      the validator, which only blocks on volatile facts, not on
//      next_action_unverified), with an advisory printed.
//   4. An empty string clears the field to null.
//   5. PROCESS_STATE.md is regenerated after a successful write.
//
// The named mutant this test guards against — "remove the classifier call
// before the write" — is demonstrated manually (not baked into this
// automated suite): with the classifier call removed, case 2 above would
// exit 0 and write the volatile-fact value, and a following
// `node scripts/mavp-validator.js` against that fixture would then exit 2
// with a next_action_volatile_facts finding — exactly the outcome DR-009
// forbids booking. See the developer report for the quoted red/green run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const SET_NEXT_ACTION_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-set-next-action.js');
const NODE_BIN = process.execPath;

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function runSetNextAction(arg, cwd, env) {
  const args = arg === undefined ? [] : [arg];
  const result = spawnSync(NODE_BIN, [SET_NEXT_ACTION_PATH, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeFixture(root, nextAction) {
  writeUtf8(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify(
      {
        initiative: 'test initiative',
        stage: 'execution',
        wave: 1,
        wave_status: 'execution',
        active_slices: [],
        next_action: nextAction,
        blocker: null,
        stage_owner: 'main_agent',
        last_task_id: 1,
        last_updated: '2026-01-01',
        deploy_contours: 0,
        rechecks: [],
      },
      null,
      2
    ) + '\n'
  );
  writeUtf8(path.join(root, 'PROCESS_STATE.md'), '<!-- auto-generated — do not edit manually -->\nstale placeholder\n');
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 't750-fixture-'));

// ---------------------------------------------------------------------------
// Test 1: a directive value ("T-NNN -> ...") is written verbatim at exit 0.
// ---------------------------------------------------------------------------
{
  writeFixture(ROOT, 'T-001 -> developer -> old value');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: ROOT };

  const { status, output } = runSetNextAction('T-123 -> developer -> fix parser', ROOT, env);
  assert.strictEqual(status, 0, `Test 1 FAIL: expected exit 0 for a directive value, got ${status}:\n${output}`);

  const state = JSON.parse(readUtf8(path.join(ROOT, 'PROCESS_STATE.json')));
  assert.strictEqual(
    state.next_action,
    'T-123 -> developer -> fix parser',
    `Test 1 FAIL: expected next_action to equal the input verbatim, got: ${state.next_action}`
  );
  console.log('Test 1 passed: a directive value is written verbatim at exit 0');
}

// ---------------------------------------------------------------------------
// Test 2: a value containing a volatile fact is REFUSED — exit 1, the file
// stays byte-unchanged, and stdout names the matched fact.
// ---------------------------------------------------------------------------
{
  writeFixture(ROOT, 'T-001 -> developer -> untouched value');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: ROOT };
  const before = readUtf8(path.join(ROOT, 'PROCESS_STATE.json'));

  const { status, output } = runSetNextAction('the repo is at 0.44.3', ROOT, env);
  assert.strictEqual(status, 1, `Test 2 FAIL: expected exit 1 for a volatile-fact value, got ${status}:\n${output}`);
  assert.ok(/0\.44\.3/.test(output), `Test 2 FAIL: expected stdout to name the matched fact "0.44.3", got:\n${output}`);
  assert.ok(/REFUSED/.test(output), `Test 2 FAIL: expected an explicit REFUSED message, got:\n${output}`);
  assert.ok(
    /--handoff --notes/.test(output) && /--set-strategy-note/.test(output),
    `Test 2 FAIL: expected stdout to name --handoff --notes and --set-strategy-note as the correct homes for narrative, got:\n${output}`
  );

  const after = readUtf8(path.join(ROOT, 'PROCESS_STATE.json'));
  assert.strictEqual(after, before, 'Test 2 FAIL: PROCESS_STATE.json must be byte-unchanged after a refusal');
  console.log('Test 2 passed: a volatile-fact value is refused at exit 1, file byte-unchanged, fact named in stdout');
}

// ---------------------------------------------------------------------------
// Test 3: a value that does not begin with T-NNN is still WRITTEN (parity
// with the validator, which only blocks on volatile facts) with a
// next_action_unverified advisory printed.
// ---------------------------------------------------------------------------
{
  writeFixture(ROOT, 'T-001 -> developer -> old value');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: ROOT };

  const { status, output } = runSetNextAction('Open next wave', ROOT, env);
  assert.strictEqual(status, 0, `Test 3 FAIL: expected exit 0 for a non-directive, non-volatile value, got ${status}:\n${output}`);
  assert.ok(/next_action_unverified/.test(output), `Test 3 FAIL: expected a next_action_unverified advisory, got:\n${output}`);

  const state = JSON.parse(readUtf8(path.join(ROOT, 'PROCESS_STATE.json')));
  assert.strictEqual(
    state.next_action,
    'Open next wave',
    `Test 3 FAIL: expected the non-directive value to still be written, got: ${state.next_action}`
  );
  console.log('Test 3 passed: a non-directive value is written with a non-blocking next_action_unverified advisory');
}

// ---------------------------------------------------------------------------
// Test 4: an empty string clears the field to null.
// ---------------------------------------------------------------------------
{
  writeFixture(ROOT, 'T-001 -> developer -> old value');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: ROOT };

  const { status, output } = runSetNextAction('', ROOT, env);
  assert.strictEqual(status, 0, `Test 4 FAIL: expected exit 0 for an empty-string clear, got ${status}:\n${output}`);

  const state = JSON.parse(readUtf8(path.join(ROOT, 'PROCESS_STATE.json')));
  assert.strictEqual(state.next_action, null, `Test 4 FAIL: expected next_action cleared to null, got: ${state.next_action}`);
  console.log('Test 4 passed: an empty string clears next_action to null');
}

// ---------------------------------------------------------------------------
// Test 5: a successful write regenerates PROCESS_STATE.md so the
// auto-generated marker stays truthful (no stale content left behind).
// ---------------------------------------------------------------------------
{
  writeFixture(ROOT, 'T-001 -> developer -> old value');
  const env = { ...process.env, MAVERICKS_PROJECT_ROOT: ROOT };

  runSetNextAction('T-777 -> developer -> regenerate the md', ROOT, env);
  const md = readUtf8(path.join(ROOT, 'PROCESS_STATE.md'));
  assert.ok(!/stale placeholder/.test(md), 'Test 5 FAIL: PROCESS_STATE.md still contains the stale fixture placeholder');
  assert.ok(
    md.includes('T-777 -> developer -> regenerate the md'),
    `Test 5 FAIL: expected regenerated PROCESS_STATE.md to reflect the new next_action, got:\n${md}`
  );
  console.log('Test 5 passed: PROCESS_STATE.md is regenerated after a successful write');
}

fs.rmSync(ROOT, { recursive: true, force: true });

console.log('\nAll T-750 assertions passed.');
