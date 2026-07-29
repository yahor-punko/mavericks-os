'use strict';
// Regression test: T-506 — scripts/mavp-publish-lock.js, the shared exclusive
// concurrency lock both publish scripts (mavp-publish-build.js,
// mavp-publish-release.js) acquire on the mirror clone directory before
// touching it.
//
// This file covers the lock MODULE directly (module-level, once — see the
// T-506 brief). A separate, single wiring test lives in each of
// test-publish-build.js and test-publish-release.js, proving each script
// actually calls acquireLock() at the right point in its own sequence —
// this file never spawns either publish script.
//
// Live-holder scenarios (contended/stale/interrupt) spawn a small fixture
// script (written to a temp file below) as a REAL child process — a fake/
// mocked pid would not exercise the actual liveness probe this module's
// safety property depends on.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOCK_SCRIPT = path.join(__dirname, 'mavp-publish-lock.js');
const {
  resolveLockPath,
  metadataFilePath,
  takeoverGuardPath,
  tryCreateLockDir,
  readLockMetadata,
  writeLockMetadata,
  probePidLiveness,
  formatAge,
  buildContendedRefusalMessage,
  buildFailClosedMessage,
  identityMatches,
  decideLiveness,
  guardedTakeover,
  generateToken,
  acquireLock,
  releaseLock,
} = require(LOCK_SCRIPT);

const tempDirs = [];
function mkTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function cleanupTempDirs() {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.on('exit', cleanupTempDirs);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(conditionFn, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (conditionFn()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await delay(intervalMs);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

// ---------------------------------------------------------------------------
// Fixture: a real child process that acquires the lock on argv[2] and then
// behaves per argv[3] ('success' | 'abort' | 'hold' | 'hold-interruptible').
// Mirrors the exact release-on-exit / signal-handler pattern this task wires
// into both real publish scripts, so the live-process cases below exercise
// the actual pattern, not a stand-in for it.
// ---------------------------------------------------------------------------
// T-546 (folded into this task's criterion 9): SIGINT/SIGTERM handlers are
// registered BEFORE the ACQUIRED line can be observed — matching the
// production handler-first, acquire-second ordering (both real publish
// scripts install their signal handlers at module load, before ever calling
// acquireLock()). Registering them only in the 'hold-interruptible' branch,
// AFTER printing ACQUIRED (the pre-fix shape), left a window under load where
// a parent-sent SIGINT could land before the handler existed, killing the
// child by default disposition (no exit-handler release), which reddened
// Test 10 on the lock-dir assertion. Do not "simplify" this back — the
// window it closes is real, not decorative.
const fixtureDir = mkTempDir('mavp-lock-fixture-');
const fixturePath = path.join(fixtureDir, 'lock-holder-fixture.js');
fs.writeFileSync(
  fixturePath,
  `'use strict';
const { acquireLock } = require(${JSON.stringify(LOCK_SCRIPT)});
const cloneDirArg = process.argv[2];
const mode = process.argv[3];
if (mode === 'hold-interruptible') {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}
let lock;
try {
  lock = acquireLock(cloneDirArg, { argv: process.argv.slice(2) });
} catch (err) {
  console.error('ACQUIRE_FAILED: ' + err.message);
  process.exit(2);
}
process.on('exit', () => { lock.release(); });
console.log('ACQUIRED pid=' + process.pid);
if (mode === 'success') {
  process.exit(0);
} else if (mode === 'abort') {
  process.exit(1);
} else if (mode === 'hold' || mode === 'hold-interruptible') {
  setInterval(() => {}, 60 * 60 * 1000);
}
`
);

function spawnFixture(cloneDirArg, mode) {
  const child = spawn(process.execPath, [fixturePath, cloneDirArg, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutBuf = '';
  child.stderrBuf = '';
  child.stdout.on('data', (d) => { child.stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { child.stderrBuf += d.toString(); });
  return child;
}

async function waitForAcquired(child) {
  await waitFor(() => /ACQUIRED pid=\d+/.test(child.stdoutBuf), { label: 'fixture child to report ACQUIRED' });
}

// ---------------------------------------------------------------------------
// Test 1: resolveLockPath — relative and absolute invocations of the SAME
// clone dir resolve to the identical sibling lock path (so they contend).
// ---------------------------------------------------------------------------
{
  const parent = mkTempDir('mavp-lock-t1-');
  const cloneDirAbs = path.join(parent, 'clone-dir');
  const cloneDirRel = path.relative(process.cwd(), cloneDirAbs);

  const lockPathAbs = resolveLockPath(cloneDirAbs);
  const lockPathRel = resolveLockPath(cloneDirRel);

  // T-506 round 2, criterion 7 — CANONICALIZED expectation, not a bare
  // literal: `parent` already exists (mkTempDir created it), so the
  // ancestor walk stops there and realpathSync()s it — on macOS this
  // resolves e.g. os.tmpdir()'s own /var -> /private/var symlink. `clone-dir`
  // itself does not exist yet, so it is the untouched tail re-appended
  // after the ancestor is canonicalized.
  const expectedLockPath = `${path.join(fs.realpathSync(parent), 'clone-dir')}.lock`;

  assert.strictEqual(
    lockPathAbs,
    expectedLockPath,
    'Test 1 FAIL: expected the CANONICALIZED sibling <clone-dir>.lock path (nearest existing ancestor ' +
      'realpath\'d, non-existing tail re-appended)'
  );
  assert.strictEqual(lockPathAbs, lockPathRel, 'Test 1 FAIL: relative and absolute invocations must resolve to the identical lock path (so they contend)');
  assert.ok(!lockPathAbs.startsWith(cloneDirAbs + path.sep), 'Test 1 FAIL: the lock path must never be nested INSIDE the (uncanonicalized) clone dir');
  assert.ok(
    !lockPathAbs.startsWith(path.join(fs.realpathSync(parent), 'clone-dir') + path.sep),
    'Test 1 FAIL: the CANONICALIZED lock path must never be nested INSIDE the canonicalized clone dir either'
  );

  console.log('Test 1 passed: resolveLockPath is a CANONICALIZED path.resolve()-derived sibling, identical for relative/absolute invocations of the same clone.');
}

// ---------------------------------------------------------------------------
// Test 2: tryCreateLockDir — non-recursive acquire; EEXIST on a second raw
// attempt; ENOENT-missing-parent recovery (create parent, retry once).
// ---------------------------------------------------------------------------
{
  const parent = mkTempDir('mavp-lock-t2-');
  const lockPath = path.join(parent, 'sibling.lock');

  assert.strictEqual(tryCreateLockDir(lockPath), 'acquired', 'Test 2 FAIL: first acquire on a fresh path should succeed');
  assert.ok(fs.existsSync(lockPath) && fs.statSync(lockPath).isDirectory(), 'Test 2 FAIL: lock directory should now exist');

  // Second raw attempt against the SAME still-existing lock dir must report
  // 'contended' (EEXIST), never silently succeed.
  assert.strictEqual(tryCreateLockDir(lockPath), 'contended', 'Test 2 FAIL: a second acquire attempt against an existing lock dir must be contended');

  fs.rmSync(lockPath, { recursive: true, force: true });

  // ENOENT-missing-parent recovery: the clone dir's own parent doesn't exist
  // yet (a legitimate first-run shape) — tryCreateLockDir must create it and
  // retry the acquire once, non-recursively for the lock dir itself.
  const missingParentClone = path.join(parent, 'not-yet-created', 'clone-dir');
  const lockPath2 = resolveLockPath(missingParentClone);
  assert.ok(!fs.existsSync(path.dirname(lockPath2)), 'Test 2 setup FAIL: parent must not exist yet for this case');
  assert.strictEqual(tryCreateLockDir(lockPath2), 'acquired', 'Test 2 FAIL: ENOENT (missing parent) should be recovered from and the acquire retried once');
  assert.ok(fs.existsSync(lockPath2), 'Test 2 FAIL: lock directory should exist after ENOENT recovery');
  fs.rmSync(lockPath2, { recursive: true, force: true });

  console.log('Test 2 passed: non-recursive acquire, EEXIST contention, and ENOENT-missing-parent recovery all behave as specified.');
}

// ---------------------------------------------------------------------------
// Test 3: happy path via a REAL 'success'-mode child — lock metadata carries
// pid/start/argv/hostname while held, and the lock directory is gone after
// the process exits cleanly (exit 0).
// ---------------------------------------------------------------------------
async function runHappySuccessTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t3-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'success');
  // NOTE: 'success' mode exits (and releases) immediately after acquiring —
  // by the time this process observes the ACQUIRED stdout line the child may
  // already be gone, so metadata-while-held is asserted via the 'hold'-mode
  // fixture in Tests 5/6/10 instead, not raced here.
  const { code } = await waitForExit(child);
  assert.ok(/ACQUIRED pid=\d+/.test(child.stdoutBuf), 'Test 3 FAIL: fixture child should have reported ACQUIRED before exiting');
  assert.strictEqual(code, 0, 'Test 3 FAIL: fixture child in success mode should exit 0');
  assert.ok(!fs.existsSync(lockPath), 'Test 3 FAIL: lock directory must be gone after a clean success exit');

  console.log('Test 3 passed: lock is acquired then gone after a clean success exit.');
}

// ---------------------------------------------------------------------------
// Test 4: happy path via a REAL 'abort'-mode child — lock directory is gone
// after an aborted (non-zero) exit too, not only after success.
// ---------------------------------------------------------------------------
async function runHappyAbortTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t4-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'abort');
  // Same race note as Test 3 — 'abort' mode also exits immediately after
  // acquiring, so this waits for exit rather than asserting "still held".
  const { code } = await waitForExit(child);
  assert.ok(/ACQUIRED pid=\d+/.test(child.stdoutBuf), 'Test 4 FAIL: fixture child should have reported ACQUIRED before exiting');
  assert.strictEqual(code, 1, 'Test 4 FAIL: fixture child in abort mode should exit 1');
  assert.ok(!fs.existsSync(lockPath), 'Test 4 FAIL: lock directory must be gone after an ABORT (non-zero) exit path too');

  console.log('Test 4 passed: lock is gone after an abort (non-zero exit) path, not only after success.');
}

// ---------------------------------------------------------------------------
// Test 5 (contended, live holder): a real child holds the lock with a
// BACKDATED start timestamp (simulating a long-running legitimate publish),
// and a concurrent acquireLock() call in THIS process must refuse, naming
// the holder's pid/age/argv — never steal on wall-clock age alone.
// ---------------------------------------------------------------------------
async function runContendedLiveHolderTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t5-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'hold');
  await waitForAcquired(child);

  // Backdate the holder's own recorded start timestamp by ten minutes — a
  // real, still-running process that merely LOOKS old. If acquireLock() ever
  // steals based on age, this is exactly the case that would wrongly permit
  // it; if it drops the liveness check entirely (recursive:true mutant, or
  // any mutant skipping the probe), this is exactly the case that exposes it
  // (the second acquire would silently "succeed" over a still-live holder).
  const meta = readLockMetadata(lockPath);
  assert.ok(meta.ok, 'Test 5 setup FAIL: expected readable metadata from the live holder');
  const backdated = { ...meta.data, start: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
  fs.writeFileSync(metadataFilePath(lockPath), JSON.stringify(backdated, null, 2));

  let threw = null;
  try {
    acquireLock(cloneDir, { argv: ['should-not-acquire'] });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'Test 5 FAIL: acquireLock() must THROW when the recorded holder is alive (this is the assertion a recursive:true mutant, or a dropped liveness check, would fail)');
  assert.ok(threw.message.includes(`held by pid ${child.pid}`), `Test 5 FAIL: refusal must name the holder pid; got: ${threw.message}`);
  assert.ok(threw.message.includes('age'), `Test 5 FAIL: refusal must name the holder age; got: ${threw.message}`);
  assert.ok(threw.message.includes('should-not-acquire') === false, 'Test 5 sanity: refusal must reflect the HOLDER argv, not the failed caller\'s argv');
  assert.ok(threw.message.includes(JSON.stringify(backdated.argv)) || threw.message.includes(String(backdated.argv[0])), `Test 5 FAIL: refusal must name the holder's argv; got: ${threw.message}`);
  assert.ok(!/steal|timeout|expired/i.test(threw.message), 'Test 5 FAIL: refusal message must never suggest a wall-clock steal/timeout path exists');

  // Still held after the failed contended attempt.
  assert.ok(fs.existsSync(lockPath), 'Test 5 FAIL: the live holder\'s lock must be untouched by the failed contended attempt');

  process.kill(child.pid, 'SIGKILL');
  await waitForExit(child);
  fs.rmSync(lockPath, { recursive: true, force: true });

  console.log('Test 5 passed: a live (even long-backdated) holder refuses a concurrent acquire, naming pid/age/argv, with no wall-clock steal.');
}

// ---------------------------------------------------------------------------
// Test 6 (stale, dead pid): SIGKILL strands the lock directory (no exit
// handler runs) with a now-dead pid recorded — the next acquireLock() must
// announce a takeover, remove it, and succeed.
// ---------------------------------------------------------------------------
async function runStaleDeadPidTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t6-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'hold');
  await waitForAcquired(child);
  const holderPid = child.pid;

  process.kill(holderPid, 'SIGKILL');
  await waitForExit(child);
  // SIGKILL bypasses the fixture's own process.on('exit') handler entirely
  // (no cleanup runs) — the lock directory must still be sitting there,
  // stranded, exactly as a real crash would leave it.
  assert.ok(fs.existsSync(lockPath), 'Test 6 setup FAIL: expected the lock dir to survive a SIGKILL (crash-stranding)');
  await waitFor(() => probePidLiveness(holderPid) === 'dead', { label: 'killed holder pid to be reported dead' });

  let announced = null;
  const result = acquireLock(cloneDir, {
    argv: ['fresh-run'],
    onStaleTakeover: (info) => { announced = info; },
  });

  assert.ok(announced, 'Test 6 FAIL: onStaleTakeover callback should fire for a dead-pid takeover');
  assert.strictEqual(announced.holder.pid, holderPid, 'Test 6 FAIL: the announced stale holder pid should be the crashed child\'s pid');
  assert.strictEqual(result.staleTakeover, true, 'Test 6 FAIL: acquireLock() should report staleTakeover: true');
  assert.strictEqual(result.staleHolder.pid, holderPid, 'Test 6 FAIL: result.staleHolder should carry the crashed child\'s pid');
  assert.ok(fs.existsSync(lockPath), 'Test 6 FAIL: a fresh lock should now be held at the same path');

  const freshMeta = readLockMetadata(lockPath);
  assert.ok(freshMeta.ok && freshMeta.data.pid === process.pid, 'Test 6 FAIL: the fresh lock metadata should record THIS process, not the dead one');

  result.release();
  assert.ok(!fs.existsSync(lockPath), 'Test 6 FAIL: release() should remove the freshly-acquired lock');

  console.log('Test 6 passed: a SIGKILL-stranded lock with a dead pid is announced, taken over, and re-acquired for the fresh run.');
}

// ---------------------------------------------------------------------------
// Test 7 (undecidable — corrupt/unreadable metadata): FAIL CLOSED, never
// guess dead. Message names the lock path and a manual-removal instruction.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t7-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath);
  fs.writeFileSync(metadataFilePath(lockPath), '{ this is not valid JSON');

  assert.throws(
    () => acquireLock(cloneDir),
    (err) => {
      assert.ok(err.message.includes('UNDECIDABLE'), `Test 7 FAIL: expected UNDECIDABLE in message; got: ${err.message}`);
      assert.ok(err.message.includes(lockPath), `Test 7 FAIL: expected the lock path named in the message; got: ${err.message}`);
      assert.ok(/rm -rf/.test(err.message), `Test 7 FAIL: expected a manual-removal instruction; got: ${err.message}`);
      return true;
    },
    'Test 7 FAIL: acquireLock() must fail closed on corrupt/unreadable metadata'
  );
  assert.ok(fs.existsSync(lockPath), 'Test 7 FAIL: a fail-closed refusal must NOT remove the lock directory itself');

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log('Test 7 passed: corrupt/unreadable lock metadata fails closed, naming the lock path and a manual-removal instruction.');
}

// ---------------------------------------------------------------------------
// Test 8 (undecidable — cross-host hostname mismatch): a pid recorded on a
// different host can never be meaningfully probed from here.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t8-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath);
  writeLockMetadata(lockPath, ['fixture']);
  const meta = readLockMetadata(lockPath);
  fs.writeFileSync(
    metadataFilePath(lockPath),
    JSON.stringify({ ...meta.data, hostname: `${os.hostname()}-definitely-a-different-host` }, null, 2)
  );

  assert.throws(
    () => acquireLock(cloneDir),
    (err) => {
      assert.ok(err.message.includes('UNDECIDABLE'), `Test 8 FAIL: expected UNDECIDABLE in message; got: ${err.message}`);
      assert.ok(err.message.includes('differs from this host'), `Test 8 FAIL: expected the cross-host reason; got: ${err.message}`);
      assert.ok(err.message.includes(lockPath), `Test 8 FAIL: expected the lock path named in the message; got: ${err.message}`);
      return true;
    },
    'Test 8 FAIL: acquireLock() must fail closed on a recorded hostname that differs from this host'
  );

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log('Test 8 passed: a cross-host hostname mismatch fails closed rather than probing a pid that could not possibly mean anything on this host.');
}

// ---------------------------------------------------------------------------
// Test 9 (undecidable — EPERM probing the pid): the pid exists but this
// process cannot signal it — never treated as dead.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t9-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath);
  writeLockMetadata(lockPath, ['fixture']);

  const realKill = process.kill;
  const fakePid = 999999; // arbitrary — never actually probed for real below
  process.kill = (pid, signal) => {
    if (pid === fakePid) {
      const err = new Error('EPERM test double');
      err.code = 'EPERM';
      throw err;
    }
    return realKill.call(process, pid, signal);
  };
  try {
    const meta = readLockMetadata(lockPath);
    fs.writeFileSync(metadataFilePath(lockPath), JSON.stringify({ ...meta.data, pid: fakePid }, null, 2));

    assert.throws(
      () => acquireLock(cloneDir),
      (err) => {
        assert.ok(err.message.includes('UNDECIDABLE'), `Test 9 FAIL: expected UNDECIDABLE in message; got: ${err.message}`);
        assert.ok(err.message.includes('could not be determined'), `Test 9 FAIL: expected the EPERM-probe reason; got: ${err.message}`);
        return true;
      },
      'Test 9 FAIL: acquireLock() must fail closed when the liveness probe itself errors (EPERM)'
    );
    assert.strictEqual(probePidLiveness(fakePid), 'undecidable', 'Test 9 FAIL: probePidLiveness must report undecidable (never dead) on EPERM');
  } finally {
    process.kill = realKill;
  }

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log('Test 9 passed: an EPERM probing the recorded pid is undecidable, never treated as dead.');
}

// ---------------------------------------------------------------------------
// Test 10 (interrupt): SIGINT mid-run against a real child that installs the
// same SIGINT/SIGTERM -> process.exit() -> 'exit'-handler-release pattern
// both publish scripts now use. Lock dir must be gone; exit must be non-zero.
// ---------------------------------------------------------------------------
async function runInterruptTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t10-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'hold-interruptible');
  await waitForAcquired(child);
  assert.ok(fs.existsSync(lockPath), 'Test 10 FAIL: lock should be held before the interrupt');

  process.kill(child.pid, 'SIGINT');
  const { code } = await waitForExit(child);

  // T-546 — pinned to EXACTLY 130 (the handler path's own process.exit(130)),
  // not merely "non-zero": a default-disposition signal death (code null,
  // signal 'SIGINT') would previously satisfy a bare notStrictEqual(0)
  // check while never having run the release-on-exit handler at all.
  assert.strictEqual(code, 130, `Test 10 FAIL: expected exit code exactly 130 (the SIGINT handler path), got ${code}`);
  assert.ok(!fs.existsSync(lockPath), 'Test 10 FAIL: lock directory must be removed after a SIGINT mid-run');

  console.log('Test 10 passed: SIGINT mid-run removes the lock directory and exits exactly 130 (handler path).');
}

// ---------------------------------------------------------------------------
// Test 11: pure message/formatting helpers, and probePidLiveness on a known
// dead pid (obtained by waiting for a real short-lived child to actually
// exit — never a guessed/hardcoded "probably free" pid number).
// ---------------------------------------------------------------------------
async function runPureHelperTest() {
  assert.strictEqual(probePidLiveness(process.pid), 'alive', 'Test 11 FAIL: this process\'s own pid must be reported alive');

  const shortLived = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = shortLived.pid;
  await waitForExit(shortLived);
  await waitFor(() => probePidLiveness(deadPid) === 'dead', { label: 'short-lived child pid to be reported dead after it exits' });

  const startIso = new Date(Date.now() - 65 * 1000).toISOString();
  const age = formatAge(startIso);
  assert.ok(/^\d+m\d+s$/.test(age), `Test 11 FAIL: expected an "Nm Ns"-shaped age for ~65s ago; got: ${age}`);

  const refusal = buildContendedRefusalMessage('/tmp/example.lock', { pid: 4242, start: startIso, argv: ['a', 'b'] });
  assert.ok(refusal.includes('4242'), 'Test 11 FAIL: contended refusal must name the pid');
  assert.ok(refusal.includes('/tmp/example.lock'), 'Test 11 FAIL: contended refusal must name the lock path');
  assert.ok(refusal.includes(JSON.stringify(['a', 'b'])), 'Test 11 FAIL: contended refusal must name the holder argv');

  const failClosed = buildFailClosedMessage('/tmp/example.lock', 'some reason');
  assert.ok(failClosed.includes('UNDECIDABLE'), 'Test 11 FAIL: fail-closed message must say UNDECIDABLE');
  assert.ok(failClosed.includes('/tmp/example.lock'), 'Test 11 FAIL: fail-closed message must name the lock path');
  assert.ok(/rm -rf/.test(failClosed), 'Test 11 FAIL: fail-closed message must include a manual-removal instruction');

  console.log('Test 11 passed: pure formatting/message helpers behave as specified, and probePidLiveness correctly reports a real dead pid.');
}

// ===========================================================================
// T-506 ROUND 2 — CAS-guarded takeover, guarded release, canonicalization,
// legacy-path decisions. NO probabilistic/stress race test is added here
// (the reviewer's own reproduction fired once in five trials — a
// probabilistic test in a commit-gating suite is worse than no test); every
// case below binds the MECHANISM directly (a pre-planted guard file, a
// swapped token, a mismatched release token) rather than trying to race it.
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 12 (guard exclusivity): a pre-planted guard file makes
// guardedTakeover() throw (fail closed), WITHOUT touching the stale lock
// directory's metadata or the guard file itself, and without ever invoking
// onStaleTakeover.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t12-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath, { recursive: true });
  const token = generateToken();
  writeLockMetadata(lockPath, ['t12-fixture'], token);

  const guardPath = takeoverGuardPath(lockPath);
  fs.writeFileSync(guardPath, 'pre-existing guard (simulating an in-progress or crashed takeover)');
  const metadataBefore = fs.readFileSync(metadataFilePath(lockPath), 'utf8');

  assert.throws(
    () =>
      guardedTakeover(lockPath, { pid: 999999, start: new Date().toISOString(), token }, () => {
        throw new Error('Test 12 FAIL: onStaleTakeover must never fire when the guard file already exists');
      }),
    (err) => {
      assert.ok(err.message.includes(lockPath), `Test 12 FAIL: expected the lock path named; got: ${err.message}`);
      assert.ok(err.message.includes(guardPath), `Test 12 FAIL: expected the guard path named; got: ${err.message}`);
      return true;
    },
    'Test 12 FAIL: guardedTakeover() must throw (fail closed) when a guard file already exists'
  );

  assert.strictEqual(
    fs.readFileSync(metadataFilePath(lockPath), 'utf8'),
    metadataBefore,
    "Test 12 FAIL: the stale lock directory's metadata must survive BYTE-FOR-BYTE when the guard already exists"
  );
  assert.ok(fs.existsSync(guardPath), 'Test 12 FAIL: the pre-existing guard file itself must be left untouched');
  assert.ok(fs.existsSync(lockPath), 'Test 12 FAIL: the stale lock directory itself must still exist');

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log(
    'Test 12 passed: a pre-planted guard file makes guardedTakeover() throw (fail closed) without touching the ' +
      'stale lock directory at all.'
  );
}

// ---------------------------------------------------------------------------
// Test 13 (CAS re-validation): the lock's identity changes (a faster
// contender's own takeover) between the moment THIS contender decided it
// dead and the moment its guard-protected re-read runs — the takeover must
// abort, the WINNING instance must survive intact, and only OUR OWN guard
// file is removed.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t13-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath, { recursive: true });
  const decidedSnapshot = writeLockMetadata(lockPath, ['t13-original'], generateToken());

  // Simulate the faster contender's own completed takeover: a DIFFERENT
  // token now sits at the same lock path.
  const swappedToken = generateToken();
  writeLockMetadata(lockPath, ['t13-faster-contender'], swappedToken);

  let announced = false;
  let threw = null;
  try {
    guardedTakeover(lockPath, decidedSnapshot, () => {
      announced = true;
    });
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'Test 13 FAIL: guardedTakeover() must throw when the post-guard identity no longer matches the decided-dead snapshot');
  assert.ok(/changed identity/.test(threw.message), `Test 13 FAIL: expected the race-lost message; got: ${threw.message}`);
  assert.ok(!announced, 'Test 13 FAIL: onStaleTakeover must never fire on a lost race');

  assert.ok(fs.existsSync(lockPath), "Test 13 FAIL: the lock directory (the winning contender's own instance) must survive intact");
  const survivingMeta = readLockMetadata(lockPath);
  assert.ok(
    survivingMeta.ok && survivingMeta.data.token === swappedToken,
    "Test 13 FAIL: the surviving metadata must still be the WINNING contender's own (swapped) token"
  );
  assert.ok(!fs.existsSync(takeoverGuardPath(lockPath)), 'Test 13 FAIL: only OUR OWN guard file should have been removed — none should remain');

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log(
    "Test 13 passed: a token swap after the dead decision (a faster contender's takeover) aborts ours, leaves the " +
      'winning instance intact, and removes only our own guard file.'
  );
}

// ---------------------------------------------------------------------------
// Test 14 (guarded release): releaseLock() removes ONLY on a matching
// token — a foreign token, unreadable metadata, and an already-gone
// directory are all safe no-ops (never throw, never remove).
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t14-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  fs.mkdirSync(lockPath, { recursive: true });
  const ownToken = generateToken();
  writeLockMetadata(lockPath, ['t14-fixture'], ownToken);

  releaseLock(lockPath, generateToken());
  assert.ok(fs.existsSync(lockPath), 'Test 14 FAIL: releaseLock() must NOT remove the lock when the token does not match (foreign token)');

  releaseLock(lockPath, ownToken);
  assert.ok(!fs.existsSync(lockPath), 'Test 14 FAIL: releaseLock() must remove the lock when the token matches (own token)');

  assert.doesNotThrow(
    () => releaseLock(lockPath, ownToken),
    'Test 14 FAIL: releaseLock() on an already-gone lock must be a silent no-op, never throw'
  );

  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(metadataFilePath(lockPath), '{ not valid json');
  releaseLock(lockPath, ownToken);
  assert.ok(fs.existsSync(lockPath), 'Test 14 FAIL: releaseLock() must NOT remove the lock when its metadata is unreadable');

  fs.rmSync(lockPath, { recursive: true, force: true });
  console.log(
    'Test 14 passed: releaseLock() removes ONLY on a matching token — a foreign token, unreadable metadata, and ' +
      'an already-gone directory are all safe no-ops.'
  );
}

// ---------------------------------------------------------------------------
// Test 15 (distinct tokens): two separate acquisitions of the same clone
// dir record two DIFFERENT tokens.
// ---------------------------------------------------------------------------
{
  const cloneDir = path.join(mkTempDir('mavp-lock-t15-'), 'clone-dir');

  const first = acquireLock(cloneDir, { argv: ['t15-first'] });
  const firstMeta = readLockMetadata(first.lockPath);
  assert.ok(
    firstMeta.ok && typeof firstMeta.data.token === 'string' && firstMeta.data.token.length > 0,
    'Test 15 FAIL: a fresh acquisition must record a non-empty token'
  );
  first.release();

  const second = acquireLock(cloneDir, { argv: ['t15-second'] });
  const secondMeta = readLockMetadata(second.lockPath);
  assert.ok(secondMeta.ok, 'Test 15 setup FAIL: expected readable metadata on the second acquisition');
  assert.notStrictEqual(secondMeta.data.token, firstMeta.data.token, 'Test 15 FAIL: two separate acquisitions must record DISTINCT tokens');
  second.release();

  console.log('Test 15 passed: distinct tokens are recorded across two separate acquisitions of the same clone dir.');
}

// ---------------------------------------------------------------------------
// Test 16 (tokenless-metadata backward compat, async): a lock stranded by a
// SIGKILL is downgraded to a pre-T-506-round-2 LEGACY (tokenless) metadata
// shape — the dead-pid takeover must still succeed via pid+start identity,
// and the NEW acquisition it produces must write a real token regardless.
// ---------------------------------------------------------------------------
async function runTokenlessBackwardCompatTest() {
  const cloneDir = path.join(mkTempDir('mavp-lock-t16-'), 'clone-dir');
  const lockPath = resolveLockPath(cloneDir);
  const child = spawnFixture(cloneDir, 'hold');
  await waitForAcquired(child);
  const holderPid = child.pid;

  process.kill(holderPid, 'SIGKILL');
  await waitForExit(child);
  assert.ok(fs.existsSync(lockPath), 'Test 16 setup FAIL: expected the lock dir to survive the SIGKILL');
  await waitFor(() => probePidLiveness(holderPid) === 'dead', { label: 'killed holder pid to be reported dead' });

  const realMeta = readLockMetadata(lockPath);
  assert.ok(realMeta.ok, 'Test 16 setup FAIL: expected readable metadata from the killed holder');
  const { token, ...tokenless } = realMeta.data;
  fs.writeFileSync(metadataFilePath(lockPath), JSON.stringify(tokenless, null, 2));
  assert.ok(
    !('token' in JSON.parse(fs.readFileSync(metadataFilePath(lockPath), 'utf8'))),
    'Test 16 setup FAIL: expected a genuinely tokenless (legacy-shaped) metadata file'
  );

  let announced = null;
  const result = acquireLock(cloneDir, {
    argv: ['t16-fresh-run'],
    onStaleTakeover: (info) => {
      announced = info;
    },
  });

  assert.ok(announced, 'Test 16 FAIL: onStaleTakeover should fire for a tokenless (legacy) dead-pid takeover too');
  assert.strictEqual(announced.holder.pid, holderPid, "Test 16 FAIL: the announced stale holder pid should be the crashed child's pid");
  assert.strictEqual(result.staleTakeover, true, 'Test 16 FAIL: acquireLock() should report staleTakeover: true');

  const freshMeta = readLockMetadata(result.lockPath);
  assert.ok(freshMeta.ok && freshMeta.data.pid === process.pid, 'Test 16 FAIL: the fresh lock metadata should record THIS process');
  assert.ok(
    typeof freshMeta.data.token === 'string' && freshMeta.data.token.length > 0,
    'Test 16 FAIL: the NEW acquisition must write a real token even though the takeover it replaced was tokenless'
  );

  result.release();
  assert.ok(!fs.existsSync(lockPath), 'Test 16 FAIL: release() should remove the freshly-acquired lock');

  console.log(
    'Test 16 passed: a tokenless (pre-T-506-round-2 legacy) dead-pid lock is still correctly taken over via ' +
      'pid+start identity, and the new acquisition writes a real token.'
  );
}

// ---------------------------------------------------------------------------
// Test 17 (canonicalization, criterion 4): a symlink-ALIASED ancestor
// directory makes resolveLockPath() converge on the identical canonical
// path via EITHER spelling, both when the clone dir already exists through
// the alias AND when it does not exist yet — and acquiring through one
// spelling makes the other spelling's acquire throw the contended refusal
// (the SAME physical lock, not two).
// ---------------------------------------------------------------------------
{
  const parent = mkTempDir('mavp-lock-t17-');
  const realDir = path.join(parent, 'real-target');
  fs.mkdirSync(realDir);
  const aliasDir = path.join(parent, 'alias-to-real');
  fs.symlinkSync(realDir, aliasDir, 'dir');

  const cloneViaReal = path.join(realDir, 'clone-dir');
  const cloneViaAlias = path.join(aliasDir, 'clone-dir');

  // Case A: clone dir MISSING under both spellings.
  assert.ok(!fs.existsSync(cloneViaReal), 'Test 17 setup FAIL: clone dir must not exist yet (missing case)');
  assert.strictEqual(
    resolveLockPath(cloneViaAlias),
    resolveLockPath(cloneViaReal),
    'Test 17 FAIL: alias and real spellings must resolve to the identical lock path when the clone dir does NOT exist yet'
  );

  // Case B: clone dir EXISTS (created via the real spelling, reachable
  // through the alias too).
  fs.mkdirSync(cloneViaReal);
  assert.strictEqual(
    resolveLockPath(cloneViaAlias),
    resolveLockPath(cloneViaReal),
    'Test 17 FAIL: alias and real spellings must resolve to the identical lock path when the clone dir DOES exist'
  );

  // Acquiring via one spelling genuinely contends the other.
  const held = acquireLock(cloneViaReal, { argv: ['t17-real'] });
  let threw = null;
  try {
    acquireLock(cloneViaAlias, { argv: ['t17-alias'] });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'Test 17 FAIL: acquiring via the ALIAS spelling must throw when the REAL spelling already holds the identical physical lock');
  assert.ok(/held by pid/.test(threw.message), `Test 17 FAIL: expected the ordinary contended-refusal message; got: ${threw.message}`);
  held.release();
  assert.ok(!fs.existsSync(resolveLockPath(cloneViaReal)), 'Test 17 FAIL: release() should remove the lock');

  console.log(
    'Test 17 passed: resolveLockPath canonicalizes a symlink-ALIASED ancestor to the identical physical lock ' +
      'path, both when the clone dir exists and when it does not, and cross-spelling acquisition genuinely contends.'
  );
}

// ---------------------------------------------------------------------------
// Test 18 (legacy-path decisions, criterion 5, async): the clone-dir
// ARGUMENT ITSELF is a symlink — the construction that makes the OLD
// (uncanonicalized) `${path.resolve(arg)}.lock` a genuinely DIFFERENT
// physical location from the canonical one (appending `.lock` to a
// symlink's own name produces a sibling of the symlink, never something
// reached through it). Three sub-cases: alive (refuse), dead (removed,
// canonical acquisition proceeds), undecidable (fail closed).
// ---------------------------------------------------------------------------
function makeAliasedCloneDir(prefix) {
  const parent = mkTempDir(prefix);
  const realCloneDir = path.join(parent, 'real-clone-dir');
  fs.mkdirSync(realCloneDir);
  const aliasCloneDir = path.join(parent, 'alias-clone-dir');
  fs.symlinkSync(realCloneDir, aliasCloneDir, 'dir');
  return aliasCloneDir;
}

async function runLegacyPathDecisionTest() {
  // Sub-case 18a: legacy lock is LIVE -> refuse, naming the legacy path; the
  // canonical path must never be created.
  {
    const aliasCloneDir = makeAliasedCloneDir('mavp-lock-t18a-');
    const legacyLockPath = `${path.resolve(aliasCloneDir)}.lock`;
    const canonicalLockPath = resolveLockPath(aliasCloneDir);
    assert.notStrictEqual(legacyLockPath, canonicalLockPath, 'Test 18a setup FAIL: expected the legacy and canonical lock paths to be genuinely distinct');

    fs.mkdirSync(legacyLockPath);
    writeLockMetadata(legacyLockPath, ['t18a-legacy-holder']); // tokenless — genuinely legacy-shaped

    let threw = null;
    try {
      acquireLock(aliasCloneDir, { argv: ['t18a-new-run'] });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'Test 18a FAIL: acquireLock() must refuse when a LIVE legacy-spelled lock exists');
    assert.ok(threw.message.includes(legacyLockPath), `Test 18a FAIL: expected the LEGACY path named; got: ${threw.message}`);
    assert.ok(
      threw.message.includes(`held by pid ${process.pid}`),
      `Test 18a FAIL: expected this test process's own pid named as the holder; got: ${threw.message}`
    );
    assert.ok(!fs.existsSync(canonicalLockPath), 'Test 18a FAIL: the canonical lock path must never be created when the legacy check refuses first');

    fs.rmSync(legacyLockPath, { recursive: true, force: true });
    console.log('Test 18a passed: a LIVE legacy-spelled lock (genuinely distinct from the canonical path) refuses the run, naming the legacy path.');
  }

  // Sub-case 18b: legacy lock is DEAD -> removed, and acquisition proceeds
  // and succeeds at the CANONICAL path.
  {
    const aliasCloneDir = makeAliasedCloneDir('mavp-lock-t18b-');
    const legacyLockPath = `${path.resolve(aliasCloneDir)}.lock`;
    const canonicalLockPath = resolveLockPath(aliasCloneDir);

    const shortLived = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = shortLived.pid;
    await waitForExit(shortLived);
    await waitFor(() => probePidLiveness(deadPid) === 'dead', { label: 'short-lived child pid to be reported dead' });

    fs.mkdirSync(legacyLockPath);
    fs.writeFileSync(
      metadataFilePath(legacyLockPath),
      JSON.stringify(
        { pid: deadPid, start: new Date().toISOString(), argv: ['t18b-dead-legacy-holder'], hostname: os.hostname() },
        null,
        2
      )
    );

    let announced = null;
    const result = acquireLock(aliasCloneDir, {
      argv: ['t18b-new-run'],
      onStaleTakeover: (info) => {
        announced = info;
      },
    });

    assert.ok(announced, 'Test 18b FAIL: onStaleTakeover should fire for the dead LEGACY lock');
    assert.strictEqual(announced.lockPath, legacyLockPath, 'Test 18b FAIL: the announced lockPath should be the LEGACY path, not the canonical one');
    assert.ok(!fs.existsSync(legacyLockPath), 'Test 18b FAIL: the dead legacy lock must be removed');
    assert.strictEqual(result.lockPath, canonicalLockPath, 'Test 18b FAIL: acquisition must succeed at the CANONICAL path');
    assert.ok(fs.existsSync(canonicalLockPath), 'Test 18b FAIL: the canonical lock must now be held');

    result.release();
    console.log('Test 18b passed: a DEAD legacy-spelled lock is removed via the legacy-path check, and acquisition proceeds and succeeds at the canonical path.');
  }

  // Sub-case 18c: legacy lock is UNDECIDABLE (corrupt metadata) -> fail
  // closed, naming the legacy path; canonical path never created.
  {
    const aliasCloneDir = makeAliasedCloneDir('mavp-lock-t18c-');
    const legacyLockPath = `${path.resolve(aliasCloneDir)}.lock`;
    const canonicalLockPath = resolveLockPath(aliasCloneDir);

    fs.mkdirSync(legacyLockPath);
    fs.writeFileSync(metadataFilePath(legacyLockPath), '{ not valid json at all');

    assert.throws(
      () => acquireLock(aliasCloneDir, { argv: ['t18c-new-run'] }),
      (err) => {
        assert.ok(err.message.includes('UNDECIDABLE'), `Test 18c FAIL: expected UNDECIDABLE; got: ${err.message}`);
        assert.ok(err.message.includes(legacyLockPath), `Test 18c FAIL: expected the LEGACY path named; got: ${err.message}`);
        return true;
      },
      'Test 18c FAIL: acquireLock() must fail closed on an undecidable LEGACY lock'
    );
    assert.ok(!fs.existsSync(canonicalLockPath), 'Test 18c FAIL: the canonical lock path must never be created when the legacy check fails closed');

    fs.rmSync(legacyLockPath, { recursive: true, force: true });
    console.log('Test 18c passed: an UNDECIDABLE legacy-spelled lock fails closed, naming the legacy path — the canonical path is never touched.');
  }
}

// ---------------------------------------------------------------------------
// Run the process-based (async) tests serially, then report.
// ---------------------------------------------------------------------------
async function main() {
  await runHappySuccessTest();
  await runHappyAbortTest();
  await runContendedLiveHolderTest();
  await runStaleDeadPidTest();
  await runInterruptTest();
  await runPureHelperTest();
  await runTokenlessBackwardCompatTest();
  await runLegacyPathDecisionTest();
  console.log('\nAll mavp-publish-lock.js tests passed.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
