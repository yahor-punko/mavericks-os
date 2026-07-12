'use strict';
// Regression test: T-357 — mavp-operator --demo command
//
// Exercises the real CLI (via child_process) end-to-end, mirroring the
// "Verify before finishing" checklist in the task brief:
//   - drift phase prints validator FAILURE status_mismatch with exit 2, then
//     exit 0 after the fix; overall process exit is 0
//   - fixture is created under os.tmpdir() and removed on success
//   - fixture is removed on SIGINT too
//   - --keep prints the fixture path and the fixture survives
//   - --no-color strips ANSI from captured child output
//   - repo git status stays clean (nothing written outside os.tmpdir())

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_SCRIPT = path.join(__dirname, 'mavp-operator-demo.js');

function listDemoFixtures() {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mavp-demo-'));
}

function gitStatusPorcelain() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

const gitStatusBefore = gitStatusPorcelain();

// ---------------------------------------------------------------------------
// Test 1: --phase drift prints status_mismatch / exit 2, then exit 0 after the
//         fix, and the overall process exits 0 (the demo completed the fix).
// ---------------------------------------------------------------------------
{
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--no-color'], {
    encoding: 'utf8',
  });

  assert.ok(output.includes('status_mismatch'), 'Test 1 FAIL: expected "status_mismatch" in drift output');
  assert.ok(
    /Overall result: Misleading \/ repair required/.test(output),
    'Test 1 FAIL: expected the validator FAILURE report in drift output'
  );
  assert.ok(output.includes('validator exit 2'), 'Test 1 FAIL: expected "validator exit 2" note');
  assert.ok(output.includes('validator exit 0'), 'Test 1 FAIL: expected "validator exit 0" note after the fix');
  assert.ok(output.includes('see → drive → catch → fix'), 'Test 1 FAIL: expected closing line');

  console.log('Test 1 passed: drift phase prints FAILURE status_mismatch (exit 2) then exit 0 after fix');
}

// ---------------------------------------------------------------------------
// Test 2: no leftover fixture dirs after a normal (non --keep) run.
// ---------------------------------------------------------------------------
{
  const before = new Set(listDemoFixtures());
  execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--no-color'], { encoding: 'utf8' });
  const after = listDemoFixtures().filter((f) => !before.has(f));
  assert.strictEqual(after.length, 0, `Test 2 FAIL: leftover fixture dirs after normal run: ${after.join(', ')}`);
  console.log('Test 2 passed: fixture removed on normal completion');
}

// ---------------------------------------------------------------------------
// Test 3: --no-color strips ANSI escape sequences from captured child output.
// ---------------------------------------------------------------------------
{
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--no-color'], {
    encoding: 'utf8',
  });
  assert.ok(!/\x1b\[[0-9;]*m/.test(output), 'Test 3 FAIL: found ANSI escape sequences with --no-color');
  console.log('Test 3 passed: --no-color strips ANSI from output');
}

// ---------------------------------------------------------------------------
// Test 4: NO_COLOR env var also disables colour.
// ---------------------------------------------------------------------------
{
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'dashboard'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1' }),
  });
  assert.ok(!/\x1b\[[0-9;]*m/.test(output), 'Test 4 FAIL: found ANSI escape sequences with NO_COLOR env');
  console.log('Test 4 passed: NO_COLOR env var disables colour');
}

// ---------------------------------------------------------------------------
// Test 5: --keep prints the fixture path and the fixture survives on disk;
//         clean it up ourselves afterwards.
// ---------------------------------------------------------------------------
{
  const before = new Set(listDemoFixtures());
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'dashboard', '--keep', '--no-color'], {
    encoding: 'utf8',
  });

  const match = output.match(/Fixture kept at: (\S+)/);
  assert.ok(match, 'Test 5 FAIL: expected "Fixture kept at: <path>" in --keep output');
  const fixturePath = match[1];

  assert.ok(
    path.resolve(fixturePath).startsWith(path.resolve(os.tmpdir()) + path.sep),
    'Test 5 FAIL: kept fixture path is not under os.tmpdir()'
  );
  assert.strictEqual(fs.existsSync(fixturePath), true, 'Test 5 FAIL: kept fixture path does not exist on disk');

  const after = listDemoFixtures().filter((f) => !before.has(f));
  assert.strictEqual(after.length, 1, `Test 5 FAIL: expected exactly 1 new fixture dir, got ${after.length}`);

  fs.rmSync(fixturePath, { recursive: true, force: true });
  console.log('Test 5 passed: --keep prints the fixture path and preserves it on disk');
}

// ---------------------------------------------------------------------------
// Test 6: fixture is created strictly under os.tmpdir() — buildFixture() guard.
// ---------------------------------------------------------------------------
{
  const { buildFixture, assertUnderTmpDir } = require('./mavp-operator-demo.js');
  const dir = buildFixture('unittest');
  try {
    assert.ok(
      path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
      'Test 6 FAIL: buildFixture() produced a path outside os.tmpdir()'
    );
    assert.strictEqual(fs.existsSync(path.join(dir, 'BACKLOG.md')), true, 'Test 6 FAIL: BACKLOG.md missing from fixture');
    assert.strictEqual(fs.existsSync(path.join(dir, 'TASK_STATUS.md')), true, 'Test 6 FAIL: TASK_STATUS.md missing from fixture');
    assert.strictEqual(fs.existsSync(path.join(dir, 'PROCESS_STATE.md')), true, 'Test 6 FAIL: PROCESS_STATE.md missing from fixture');
    assert.strictEqual(fs.existsSync(path.join(dir, 'PROCESS_STATE.json')), true, 'Test 6 FAIL: PROCESS_STATE.json missing from fixture');

    const backlog = fs.readFileSync(path.join(dir, 'BACKLOG.md'), 'utf8');
    assert.ok(backlog.includes('- **Repo:** demo-service'), 'Test 6 FAIL: BACKLOG.md T-001 missing Repo: demo-service');

    const taskStatus = fs.readFileSync(path.join(dir, 'TASK_STATUS.md'), 'utf8');
    assert.ok(!taskStatus.includes('demo-service'), 'Test 6 FAIL: TASK_STATUS.md should not have been given a Repo field');

    const processState = JSON.parse(fs.readFileSync(path.join(dir, 'PROCESS_STATE.json'), 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(processState.last_updated, today, 'Test 6 FAIL: PROCESS_STATE.json last_updated not patched to today');
    assert.strictEqual(processState.initiative, 'Mavericks demo walkthrough', 'Test 6 FAIL: PROCESS_STATE.json initiative not set');

    // T-363 — mavericks_version placeholder must be patched to the real version,
    // and PROCESS_STATE.md must have all its template placeholders resolved.
    const { MAVERICKS_VERSION } = require('./mavp-version.js');
    assert.strictEqual(
      processState.mavericks_version,
      MAVERICKS_VERSION,
      'Test 6 FAIL: PROCESS_STATE.json mavericks_version not patched to the real framework version'
    );
    assert.notStrictEqual(
      processState.mavericks_version,
      '__MAVERICKS_VERSION__',
      'Test 6 FAIL: PROCESS_STATE.json mavericks_version still has the raw template placeholder'
    );

    const processStateMd = fs.readFileSync(path.join(dir, 'PROCESS_STATE.md'), 'utf8');
    assert.ok(
      !processStateMd.includes('[Describe the initiative'),
      'Test 6 FAIL: PROCESS_STATE.md still has the initiative placeholder'
    );
    assert.ok(
      !processStateMd.includes('[YYYY-MM-DD]'),
      'Test 6 FAIL: PROCESS_STATE.md still has a [YYYY-MM-DD] placeholder'
    );
    assert.ok(
      !processStateMd.includes('[next task'),
      'Test 6 FAIL: PROCESS_STATE.md still has the "[next task → owner]" placeholder'
    );
    assert.ok(
      processStateMd.includes(`- ${today}: Initiative started.`),
      'Test 6 FAIL: PROCESS_STATE.md "Last meaningful movement" not patched to today'
    );
    assert.ok(
      processStateMd.includes('- T-001 → developer'),
      'Test 6 FAIL: PROCESS_STATE.md "Next expected handoff" not patched'
    );
    assert.ok(
      processStateMd.trim().endsWith(today),
      'Test 6 FAIL: PROCESS_STATE.md "Last update" not patched to today'
    );

    assert.throws(
      () => assertUnderTmpDir('/etc/passwd'),
      /Refusing to operate/,
      'Test 6 FAIL: assertUnderTmpDir() should throw for a path outside os.tmpdir()'
    );
    assert.throws(
      () => assertUnderTmpDir(REPO_ROOT),
      /Refusing to operate/,
      'Test 6 FAIL: assertUnderTmpDir() should throw for the real repo root'
    );

    console.log('Test 6 passed: buildFixture() writes all 4 artifacts under os.tmpdir() with expected edits');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 7: SIGINT mid-run removes the fixture directory it had created.
//
// Uses the demo's test-only __MAVP_DEMO_TEST_HOLD_MS__ hook (env var) to make
// this deterministic: the child process prints "__FIXTURE_READY__ <dir>"
// right after building its fixture and then holds, so the test can confirm
// the fixture exists, send a real SIGINT, and confirm the fixture is gone —
// without racing arbitrary process timing.
// ---------------------------------------------------------------------------
async function testSigintCleanup() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [DEMO_SCRIPT, '--phase', 'dashboard', '--no-color'], {
      env: Object.assign({}, process.env, { __MAVP_DEMO_TEST_HOLD_MS__: '5000' }),
    });

    let stdout = '';
    let fixtureDir = null;
    let sawFixtureBeforeKill = false;

    const timeoutGuard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Test 7 FAIL: demo process never printed __FIXTURE_READY__ within 5s'));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!fixtureDir) {
        const match = stdout.match(/__FIXTURE_READY__ (\S+)/);
        if (match) {
          fixtureDir = match[1];
          sawFixtureBeforeKill = fs.existsSync(fixtureDir);
          child.kill('SIGINT');
        }
      }
    });

    child.on('exit', () => {
      clearTimeout(timeoutGuard);
      try {
        assert.ok(fixtureDir, 'Test 7 FAIL: never observed a __FIXTURE_READY__ line');
        assert.strictEqual(
          sawFixtureBeforeKill,
          true,
          'Test 7 FAIL: fixture did not exist at the moment SIGINT was sent'
        );
        assert.strictEqual(
          fs.existsSync(fixtureDir),
          false,
          `Test 7 FAIL: fixture ${fixtureDir} still exists after SIGINT`
        );
        console.log('Test 7 passed: fixture removed when the demo is interrupted with SIGINT');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Test 8: --phase all runs end-to-end with overall exit 0.
// ---------------------------------------------------------------------------
function testFullRun() {
  execFileSync('node', [DEMO_SCRIPT, '--no-color'], { encoding: 'utf8' });
  console.log('Test 8 passed: --phase all (default) runs end-to-end with exit 0');
}

// ---------------------------------------------------------------------------
// Test 9: nothing was written outside os.tmpdir() — repo git status unchanged.
// ---------------------------------------------------------------------------
function testGitStatusClean() {
  const gitStatusAfter = gitStatusPorcelain();
  assert.strictEqual(
    gitStatusAfter,
    gitStatusBefore,
    'Test 9 FAIL: repo git status changed after running the demo — something was written outside os.tmpdir()'
  );
  console.log('Test 9 passed: git status unchanged — nothing written outside os.tmpdir()');
}

// ---------------------------------------------------------------------------
// Test 10 (T-363): --reveal produces discrete clear-screen frames and the
// drift phase still reports the same substantive content as before.
// ---------------------------------------------------------------------------
function testRevealClearsScreen() {
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--reveal', '5', '--no-color'], {
    encoding: 'utf8',
  });
  const clearCount = (output.match(/\x1b\[2J/g) || []).length;
  assert.ok(clearCount >= 1, `Test 10 FAIL: expected >=1 clear-screen sequence with --reveal, got ${clearCount}`);
  assert.ok(output.includes('status_mismatch'), 'Test 10 FAIL: expected "status_mismatch" in --reveal drift output');
  assert.ok(output.includes('validator exit 2'), 'Test 10 FAIL: expected "validator exit 2" note with --reveal');
  assert.ok(output.includes('validator exit 0'), 'Test 10 FAIL: expected "validator exit 0" note with --reveal');
  console.log('Test 10 passed: --reveal produces >=1 clear-screen frame and preserves drift phase content');
}

// ---------------------------------------------------------------------------
// Test 11 (T-363): back-compat guard — a default run (no --reveal) contains
// ZERO clear-screen sequences. Today's behavior stays byte-for-byte.
// ---------------------------------------------------------------------------
function testNoRevealNoClearScreen() {
  const output = execFileSync('node', [DEMO_SCRIPT, '--no-color'], { encoding: 'utf8' });
  const clearCount = (output.match(/\x1b\[2J/g) || []).length;
  assert.strictEqual(
    clearCount,
    0,
    `Test 11 FAIL: expected 0 clear-screen sequences without --reveal, got ${clearCount}`
  );
  console.log('Test 11 passed: default run (no --reveal) contains zero clear-screen sequences');
}

// ---------------------------------------------------------------------------
// Test 12 (T-363): dashboard phase has no leaked template placeholders and no
// spurious UPDATE_AVAILABLE line (mavericks_version now matches the real repo).
// ---------------------------------------------------------------------------
function testDashboardNoPlaceholderLeaks() {
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'dashboard', '--no-color'], {
    encoding: 'utf8',
  });
  assert.ok(!/\[YYYY-MM-DD\]/.test(output), 'Test 12 FAIL: found a [YYYY-MM-DD] placeholder leak in dashboard output');
  assert.ok(!/\[next task/.test(output), 'Test 12 FAIL: found a "[next task" placeholder leak in dashboard output');
  assert.ok(!/UPDATE_AVAILABLE/.test(output), 'Test 12 FAIL: found a spurious UPDATE_AVAILABLE line in dashboard output');
  console.log('Test 12 passed: dashboard phase has no placeholder or UPDATE_AVAILABLE leaks');
}

// ---------------------------------------------------------------------------
// Test 13 (T-364): --phase session tells the two-beat memory-transfer story —
// wave goal + next action seeded, a real set-status, a real --handoff, a real
// --agent frame surfacing that state, and a real HANDOFF.md read + delete —
// all appearing in order, fixture removed after, overall exit 0.
// ---------------------------------------------------------------------------
function testSessionPhase() {
  const before = new Set(listDemoFixtures());
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'session', '--no-color'], {
    encoding: 'utf8',
  });

  const markers = [
    'set-status T-001 in_progress success',
    'HANDOFF.md written',
    '"wave_goal": "Ship the example feature end-to-end"',
    '"id": "T-001"',
    '"status": "in_progress"',
    'Token refresh still failing on staging',
    'The skill deletes HANDOFF.md after reading',
  ];

  let lastIndex = -1;
  for (const marker of markers) {
    const idx = output.indexOf(marker);
    assert.ok(idx !== -1, `Test 13 FAIL: expected to find "${marker}" in --phase session output`);
    assert.ok(
      idx > lastIndex,
      `Test 13 FAIL: expected "${marker}" to appear after the previous marker (found out of order)`
    );
    lastIndex = idx;
  }

  assert.ok(
    output.includes('state lives in files, not in chat history'),
    'Test 13 FAIL: expected the closing line "state lives in files, not in chat history"'
  );

  const after = listDemoFixtures().filter((f) => !before.has(f));
  assert.strictEqual(
    after.length,
    0,
    `Test 13 FAIL: leftover fixture dirs after --phase session: ${after.join(', ')}`
  );

  console.log('Test 13 passed: --phase session tells the two-beat memory-transfer story in order, fixture removed');
}

(async () => {
  await testSigintCleanup();
  testFullRun();
  testRevealClearsScreen();
  testNoRevealNoClearScreen();
  testDashboardNoPlaceholderLeaks();
  testSessionPhase();
  testGitStatusClean();
  console.log('\nAll T-357/T-363/T-364 assertions passed.');
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
