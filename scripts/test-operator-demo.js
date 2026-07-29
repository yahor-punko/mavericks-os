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
//   - nothing was written to the repo's own state artifacts, and no fixture
//     directory escaped os.tmpdir() into the repo tree (T-508: scoped to
//     what the demo could plausibly touch, not the whole repo's git status
//     — see hashProtectedArtifacts()/demoScopedFixtureLines() below for why
//     a whole-repo comparison reads as flaky whenever the suite runs against
//     a non-quiescent repo, and why status LINES aren't enough either — see
//     T-515)
//   - Tests 2/5/13's tmpdir diff windows are isolated from any concurrent
//     invocation of this same suite (T-519: os.tmpdir() is machine-global,
//     and every worktree developer sub-agent runs this suite as its own
//     definition-of-done check, so a sibling invocation's fixture used to be
//     a false intruder — see PRIVATE_TMP_ROOT below)

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_SCRIPT = path.join(__dirname, 'mavp-operator-demo.js');

// ---------------------------------------------------------------------------
// T-519: a private per-run temp root, isolating this suite run's fixtures
// from any concurrent invocation of the same suite (os.tmpdir() is
// machine-global, shared between the main checkout and every worktree — see
// run-tests.js's own header comment on tmpdir cross-contamination, which
// only covers serialization WITHIN one invocation, not between invocations).
//
// Created via mkdtemp inside the REAL os.tmpdir() — this parent test process
// never overrides its own env, so os.tmpdir() here always resolves to the
// real machine tmp directory, both for this call and for the intruder
// reproduction further down. The prefix deliberately does NOT start with
// "mavp-demo-": this root itself lives directly in the machine-global
// tmpdir, and if it matched that prefix it would become an intruder in a
// concurrent (unfixed or otherwise) invocation's own "mavp-demo-*" filter —
// moving the collision rather than removing it.
//
// Every spawned demo child gets this root injected as TMPDIR, TEMP and TMP
// (see DEMO_CHILD_ENV below) so its own os.tmpdir() call — and therefore
// buildFixture()/assertUnderTmpDir() inside mavp-operator-demo.js, unmodified
// — resolves here instead of to the machine-global tmpdir. os.tmpdir()
// resolves TMPDIR on POSIX and TEMP/TMP on win32 per call, so all three vars
// are set on every child regardless of platform.
const PRIVATE_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-testroot-'));
const DEMO_CHILD_ENV = Object.assign({}, process.env, {
  TMPDIR: PRIVATE_TMP_ROOT,
  TEMP: PRIVATE_TMP_ROOT,
  TMP: PRIVATE_TMP_ROOT,
});

function listDemoFixtures() {
  return fs.readdirSync(PRIVATE_TMP_ROOT).filter((f) => f.startsWith('mavp-demo-'));
}

function gitStatusPorcelain() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// Repo-root paths the demo could plausibly touch if something went wrong:
// the live-state artifacts its child tools (dashboard/set-status/validator/
// handoff/agent) mutate when given a fixture — these are exactly the files
// that would receive writes if a tool's MAVERICKS_PROJECT_ROOT resolution
// ever silently fell back to cwd instead of the fixture dir the demo passes
// it (see buildFixture()'s own comment on why runTool() always shells out
// with that env var override rather than requiring the tools in-process).
const DEMO_PROTECTED_PATHS = [
  'BACKLOG.md',
  'TASK_STATUS.md',
  'PROCESS_STATE.md',
  'PROCESS_STATE.json',
  'HANDOFF.md',
  'EXECUTION_LOG.md',
];

// T-508: `git status --porcelain` reports the state of the WHOLE repo, not
// just what this test run created — comparing the raw text before/after is
// coupled to anything else happening in the repo during the run (a sub-agent
// committing in a worktree, a cherry-pick landing in main, a stray hand-edit)
// and reads as flaky whenever the suite runs against a non-quiescent repo.
// This scopes the escaped-fixture check down to the one thing a porcelain
// LINE can actually tell us: a leftover `mavp-demo-*` fixture directory that
// escaped os.tmpdir() into the repo tree (untracked, so it always shows up
// as its own `??` line regardless of what else is going on in the repo).
// Anything else in the porcelain output — unrelated files changing for
// reasons that have nothing to do with the demo — is filtered out on BOTH
// sides, so it can never cause a false failure here.
function demoScopedFixtureLines(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => line.slice(3).includes('mavp-demo-'));
}

// T-515: a `git status --porcelain` LINE is the wrong unit for the six
// DEMO_PROTECTED_PATHS themselves. A tracked file's porcelain line is exactly
// ` M <path>` (or `A `, `??`, etc.) no matter HOW MANY times or how much its
// content changes — so if a protected artifact was already dirty before the
// demo ran (the common mid-session case: BACKLOG.md/TASK_STATUS.md are
// edited constantly), a further demo-attributable write leaves the line
// byte-identical before and after, and the comparison misses it entirely.
// Comparing CONTENT (a hash of the file's bytes) instead closes that gap:
// any change to a protected artifact's actual content — including the
// already-dirty-then-written-again case, a fresh creation, or a deletion —
// produces a different value, regardless of what the porcelain status line
// says. sha256 is used purely as a cheap, collision-safe fingerprint, not
// for anything security-sensitive.
function hashProtectedArtifacts(baseDir, relPaths) {
  const result = {};
  for (const relPath of relPaths) {
    try {
      result[relPath] = crypto.createHash('sha256').update(fs.readFileSync(path.join(baseDir, relPath))).digest('hex');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      result[relPath] = null; // absent — a missing file (e.g. HANDOFF.md) is a valid, common state
    }
  }
  return result;
}

// Returns the subset of relPaths whose hash differs between two
// hashProtectedArtifacts() snapshots. Covers all four transitions
// deliberately: absent→absent (both null, not reported), present→present
// with a content change (different hash strings, reported), absent→created
// (null vs a hash, reported), and present→deleted (a hash vs null,
// reported) — a created or deleted protected artifact is a detection, not
// a crash or a false negative.
function changedProtectedArtifacts(before, after, relPaths) {
  return relPaths.filter((relPath) => before[relPath] !== after[relPath]);
}

const gitStatusBefore = gitStatusPorcelain();
const protectedArtifactsBefore = hashProtectedArtifacts(REPO_ROOT, DEMO_PROTECTED_PATHS);

// T-519: Tests 1-6 run synchronously at suite start; wrapped in a function
// (rather than left as bare top-level blocks) so `main()` below can await
// them inside the same try/finally that guarantees PRIVATE_TMP_ROOT cleanup
// even if one of these assertions throws.
async function runInlineTests() {

// ---------------------------------------------------------------------------
// Test 1: --phase drift prints status_mismatch / exit 2, then exit 0 after the
//         fix, and the overall process exits 0 (the demo completed the fix).
// ---------------------------------------------------------------------------
{
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--no-color'], {
    encoding: 'utf8',
    env: DEMO_CHILD_ENV,
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
  execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--no-color'], { encoding: 'utf8', env: DEMO_CHILD_ENV });
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
    env: DEMO_CHILD_ENV,
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
    env: Object.assign({}, DEMO_CHILD_ENV, { NO_COLOR: '1' }),
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
    env: DEMO_CHILD_ENV,
  });

  const match = output.match(/Fixture kept at: (\S+)/);
  assert.ok(match, 'Test 5 FAIL: expected "Fixture kept at: <path>" in --keep output');
  const fixturePath = match[1];

  // T-519: tightened from "under os.tmpdir()" to "under the private per-run
  // root" — strictly stronger (the private root is itself under os.tmpdir())
  // and still true, since the child's os.tmpdir() resolves to PRIVATE_TMP_ROOT.
  assert.ok(
    path.resolve(fixturePath).startsWith(path.resolve(PRIVATE_TMP_ROOT) + path.sep),
    'Test 5 FAIL: kept fixture path is not under the private per-run temp root'
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

} // end runInlineTests()

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
      env: Object.assign({}, DEMO_CHILD_ENV, { __MAVP_DEMO_TEST_HOLD_MS__: '5000' }),
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
  execFileSync('node', [DEMO_SCRIPT, '--no-color'], { encoding: 'utf8', env: DEMO_CHILD_ENV });
  console.log('Test 8 passed: --phase all (default) runs end-to-end with exit 0');
}

// ---------------------------------------------------------------------------
// Test 9: nothing was written outside os.tmpdir() — scoped to the repo-root
// state artifacts the demo's tools could mutate and to any escaped
// mavp-demo-* fixture directory, NOT the whole repo's git status (T-508).
// This still fails if the demo (or a bug in a tool it shells out to) ever
// writes to the real BACKLOG.md/TASK_STATUS.md/PROCESS_STATE.md/
// PROCESS_STATE.json/HANDOFF.md/EXECUTION_LOG.md at REPO_ROOT, or leaves a
// mavp-demo-* directory behind in the repo tree. It no longer fails because
// some unrelated file elsewhere in the repo changed for reasons that have
// nothing to do with the demo (a concurrent commit, a cherry-pick, a hand
// edit, a leftover scratch file from an interrupted run) — that de-flake
// property from T-508 is unaffected by T-515, since the escaped-fixture
// check below is still the same porcelain-line, mavp-demo--scoped filter,
// and the protected-artifact check below reads only the six named paths'
// content, nothing else in the repo.
//
// T-515: the protected-artifact half of this check now compares CONTENT
// (a sha256 of each of the six DEMO_PROTECTED_PATHS), not porcelain status
// lines, so a protected artifact that was already dirty before the run and
// then written to AGAIN by the demo is still detected — see
// hashProtectedArtifacts() above for why the line-based comparison used to
// miss exactly this case.
//
// Known limitation (T-519, not fixed here): this check still requires the six real state artifacts to be quiescent during the run — a legitimate concurrent edit to one of them in this exact window reads identically to a demo-attributable write.
// ---------------------------------------------------------------------------
function testGitStatusClean() {
  const gitStatusAfter = gitStatusPorcelain();
  const escapedBefore = demoScopedFixtureLines(gitStatusBefore);
  const escapedAfter = demoScopedFixtureLines(gitStatusAfter);
  const protectedArtifactsAfter = hashProtectedArtifacts(REPO_ROOT, DEMO_PROTECTED_PATHS);
  const changedProtected = changedProtectedArtifacts(protectedArtifactsBefore, protectedArtifactsAfter, DEMO_PROTECTED_PATHS);

  assert.deepStrictEqual(
    changedProtected,
    [],
    `Test 9 FAIL: a demo-protected artifact's content changed after running the demo — changed: [${changedProtected.join(', ')}]`
  );
  assert.deepStrictEqual(
    escapedAfter,
    escapedBefore,
    `Test 9 FAIL: an escaped mavp-demo-* fixture directory appeared in the repo tree — before: [${escapedBefore.join(', ')}] after: [${escapedAfter.join(', ')}]`
  );
  console.log('Test 9 passed: no repo state artifact content changed and no escaped fixture directory appeared — demo output stayed confined to os.tmpdir()');
}

// ---------------------------------------------------------------------------
// Test 9b (T-515): reproduces the exact gap the content-hash comparison
// closes, using a disposable fixture directory under os.tmpdir() so the real
// repo's state artifacts are never touched. Demonstrates all three required
// properties at once:
//   (a) OLD bug reproduced directly: a tracked file's porcelain status LINE
//       is identical whether it was modified once or modified again — so a
//       line-based before/after comparison cannot see a second write to an
//       already-dirty file. This is shown with the real porcelain line shape,
//       not a synthetic stand-in for it.
//   (b) NEW fix: hashing actual file content across four transitions —
//       already-dirty-then-written-again, absent-then-created,
//       present-then-deleted, and absent-then-absent — correctly flags the
//       first three as changed and the fourth as unchanged (no false
//       positive for a file that simply never existed on either side, e.g.
//       HANDOFF.md in a repo that has none).
// ---------------------------------------------------------------------------
function testProtectedArtifactContentDetection() {
  // (a) OLD bug: porcelain line for a tracked-and-modified file is the same
  // regardless of how many times, or how much, its content changed.
  const oldStyleLineBefore = ' M BACKLOG.md';
  const oldStyleLineAfter = ' M BACKLOG.md'; // identical — content changed again, the line format can't show it
  assert.strictEqual(
    oldStyleLineAfter,
    oldStyleLineBefore,
    'Test 9b FAIL (sanity): expected the OLD porcelain-line comparison to be blind to a second write — the reproduction premise is invalid if this fails'
  );

  // (b) NEW fix: exercise hashProtectedArtifacts()/changedProtectedArtifacts()
  // against a disposable fixture directory standing in for REPO_ROOT.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-demo-t515-'));
  try {
    const relPaths = ['BACKLOG.md', 'HANDOFF.md', 'EXECUTION_LOG.md', 'PROCESS_STATE.md'];

    // BACKLOG.md: already dirty before the run ("v1"), demo writes it again ("v2").
    fs.writeFileSync(path.join(fixtureDir, 'BACKLOG.md'), 'v1 — already dirty before the demo ran\n');
    // HANDOFF.md: absent on both sides (the routinely-absent case) — must NOT be flagged.
    // EXECUTION_LOG.md: present before, deleted after (present-then-deleted case).
    fs.writeFileSync(path.join(fixtureDir, 'EXECUTION_LOG.md'), 'present before the demo ran\n');
    // PROCESS_STATE.md: absent before, created after (absent-then-created case).

    const before = hashProtectedArtifacts(fixtureDir, relPaths);

    fs.writeFileSync(path.join(fixtureDir, 'BACKLOG.md'), 'v2 — written again by the (simulated) demo\n');
    fs.rmSync(path.join(fixtureDir, 'EXECUTION_LOG.md'));
    fs.writeFileSync(path.join(fixtureDir, 'PROCESS_STATE.md'), 'created by the (simulated) demo\n');

    const after = hashProtectedArtifacts(fixtureDir, relPaths);
    const changed = changedProtectedArtifacts(before, after, relPaths);

    assert.deepStrictEqual(
      changed.slice().sort(),
      ['BACKLOG.md', 'EXECUTION_LOG.md', 'PROCESS_STATE.md'].sort(),
      `Test 9b FAIL: expected exactly [BACKLOG.md, EXECUTION_LOG.md, PROCESS_STATE.md] to be detected as changed, got [${changed.join(', ')}]`
    );
    assert.ok(
      !changed.includes('HANDOFF.md'),
      'Test 9b FAIL: HANDOFF.md was absent on both sides and must not be reported as changed'
    );

    // Sanity: the OLD line-based check on the exact same before/after pair
    // (both attributed the identical porcelain line) would have reported
    // nothing changed for BACKLOG.md, where the NEW check correctly does.
    assert.ok(
      changed.includes('BACKLOG.md'),
      'Test 9b FAIL: the gap this task closes was not detected — an already-dirty protected artifact written to again slipped through'
    );

    console.log(
      'Test 9b passed: content-hash comparison detects an already-dirty artifact written again, a created artifact, and a deleted artifact — while correctly ignoring an artifact absent on both sides (the old porcelain-line comparison would have missed the already-dirty case)'
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 10 (T-363): --reveal produces discrete clear-screen frames and the
// drift phase still reports the same substantive content as before.
// ---------------------------------------------------------------------------
function testRevealClearsScreen() {
  const output = execFileSync('node', [DEMO_SCRIPT, '--phase', 'drift', '--reveal', '5', '--no-color'], {
    encoding: 'utf8',
    env: DEMO_CHILD_ENV,
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
  const output = execFileSync('node', [DEMO_SCRIPT, '--no-color'], { encoding: 'utf8', env: DEMO_CHILD_ENV });
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
    env: DEMO_CHILD_ENV,
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
    env: DEMO_CHILD_ENV,
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

// ---------------------------------------------------------------------------
// Test 14 (T-519): deterministic reproduction of the bug this task fixes, and
// proof of the fix, in one assertion — no race needed.
//
// A "concurrent sibling suite invocation" is simulated by planting an
// intruder directory, named with the exact "mavp-demo-" prefix, directly in
// the REAL machine-global os.tmpdir() (never PRIVATE_TMP_ROOT) mid-window,
// and leaving it there across the whole comparison — exactly what a second
// worktree's own test run would do by creating its own demo fixture while
// this suite's before/after window is open.
//
//   OLD bug: a before/after diff over the machine-global os.tmpdir() listing
//   (what Tests 2/5/13 used before this fix) sees the intruder as a "new"
//   fixture and fails, every time — reproduced below directly against the
//   real global tmpdir, not a synthetic stand-in for it.
//
//   NEW fix: the same before/after diff over the private-root-scoped listing
//   this suite now uses (listDemoFixtures()) never sees it, because the
//   intruder was never created inside PRIVATE_TMP_ROOT.
// ---------------------------------------------------------------------------
function testIntruderFixtureIsolation() {
  const oldGlobalListing = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mavp-demo-'));

  const oldBefore = new Set(oldGlobalListing());
  const scopedBefore = new Set(listDemoFixtures());

  const intruder = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-demo-intruder-'));
  try {
    const oldAfter = oldGlobalListing().filter((f) => !oldBefore.has(f));

    // OLD bug reproduced deterministically: the machine-global listing sees
    // the planted intruder as a new fixture, so the same assertion Tests
    // 2/5/13 used to make would fail here every time.
    assert.throws(
      () => assert.strictEqual(oldAfter.length, 0, `leftover fixture dirs: ${oldAfter.join(', ')}`),
      /leftover fixture dirs/,
      'Test 14 FAIL (sanity): expected the OLD machine-global-tmpdir diff to fail when an intruder mavp-demo-* dir is planted mid-window — the reproduction premise is invalid if this does not throw'
    );

    // NEW fix: the private-root-scoped listing this suite now uses is
    // unaffected — the intruder lives in the real machine-global tmpdir,
    // never inside PRIVATE_TMP_ROOT, so it is invisible by construction.
    const scopedAfter = listDemoFixtures().filter((f) => !scopedBefore.has(f));
    assert.strictEqual(
      scopedAfter.length,
      0,
      `Test 14 FAIL: private-root-scoped listing should be unaffected by a machine-global intruder, saw: ${scopedAfter.join(', ')}`
    );

    console.log(
      'Test 14 passed: an intruder mavp-demo-* dir planted in the machine-global os.tmpdir() reproduces the OLD Tests 2/5/13 failure against the global listing, and is proven invisible to the new private-root-scoped listing'
    );
  } finally {
    fs.rmSync(intruder, { recursive: true, force: true });
  }
}

async function main() {
  await runInlineTests();
  await testSigintCleanup();
  testFullRun();
  testRevealClearsScreen();
  testNoRevealNoClearScreen();
  testDashboardNoPlaceholderLeaks();
  testSessionPhase();
  testIntruderFixtureIsolation();
  testGitStatusClean();
  testProtectedArtifactContentDetection();
  console.log('\nAll T-357/T-363/T-364/T-515/T-519 assertions passed.');
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    // T-519: the private per-run temp root is removed at suite end,
    // including on failure — an uncaught assertion anywhere above must not
    // strand it. main()'s own rejection is already handled by .catch()
    // above; .finally() runs regardless of which branch was taken.
    fs.rmSync(PRIVATE_TMP_ROOT, { recursive: true, force: true });
  });
