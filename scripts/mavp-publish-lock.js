#!/usr/bin/env node
// mavp-publish-lock.js — shared exclusive concurrency lock for the two
// publish scripts (mavp-publish-build.js, mavp-publish-release.js) that
// operate on the same persistent mirror clone directory (T-506).
//
// Both scripts run unattended, several times a day, and both mutate the SAME
// clone directory (git clone/pull/checkout/commit/push). Nothing before this
// task prevented two concurrent invocations — on the same clone, by the same
// or different scripts — from interleaving: a build run's overlay/commit
// racing a release run's fast-forward-merge/push, or two build runs
// double-committing, is exactly the class of corruption this lock closes.
//
// Design (Node built-ins only — .claude/rules/scripts.md):
//
//   - The lock is a SIBLING directory of the clone dir, never nested inside
//     it: `<clone-dir>.lock`, derived by CANONICALIZING the clone-dir argv
//     (T-506 round 2, H2 — see resolveLockPath() below) so two different
//     SPELLINGS of the identical physical clone directory resolve to the
//     identical lock path and correctly contend. Never inside the clone
//     directory itself — mavp-publish-build.js's first-ever run needs the
//     clone-dir target to be ABSENT for `git clone` to create it, and a lock
//     nested inside it would defeat that.
//
//   - Acquisition is a single non-recursive `fs.mkdirSync(lockPath)`.
//     `{ recursive: true }` is FORBIDDEN for the acquire call: it succeeds
//     silently when the directory already exists, which would make a
//     concurrent invocation think it acquired an exclusive lock it never
//     actually held — the exact race this module exists to prevent. EEXIST
//     means contended. An ENOENT (the clone dir's own parent doesn't exist
//     yet — a legitimate first-run shape) is handled by recursively creating
//     `dirname(lockPath)` and retrying the non-recursive acquire exactly
//     once; any other retry failure is contention (EEXIST) or a real error
//     (rethrown, uncaught by design — an unexpected filesystem error here
//     should surface loudly, not be silently absorbed).
//
//   - Lock metadata (pid, ISO start timestamp, the acquiring invocation's own
//     argv, hostname, and — T-506 round 2 — a per-acquisition random TOKEN)
//     is written into the lock directory once it is held. On contention, a
//     liveness check is run against the RECORDED pid:
//       * alive     -> refuse, naming the holder's pid/age/argv.
//       * dead      -> a CAS-GUARDED takeover (see below) — never an
//                      unconditional remove-then-recreate.
//       * undecidable (corrupt/unreadable metadata, an EPERM probing the
//                      pid, or a recorded hostname that differs from this
//                      host — a pid recorded on another host can never be
//                      meaningfully probed from here) -> FAIL CLOSED, naming
//                      the lock path and a manual-removal instruction. Never
//                      guess "probably dead" from an undecidable signal.
//     There is NO wall-clock-based auto-steal anywhere in this module — a
//     slow but legitimate publish run must never be stolen out from under
//     itself just because it has been running a while. Only a positively
//     dead pid triggers a takeover.
//
//   - T-506 ROUND 2, C1 — the CAS-guarded takeover. Round 1's dead-pid branch
//     did `rmSync` -> retry `mkdirSync` -> write metadata UNCONDITIONALLY, on
//     a liveness decision cached before the mutation ran — a TOCTOU: a slow
//     contender that decided "dead" could delete a lock a FASTER contender
//     had already correctly taken over and was actively holding, then
//     recreate it for itself, leaving both believing they hold it
//     exclusively (reproduced live: 1 of 5 trials, two real OS processes).
//     Round 2 closes this with a compare-and-swap, not a wider re-check
//     window (a re-read immediately before `rmSync` only narrows the race;
//     it does not close it) and not a directory rename (rename atomically
//     moves WHATEVER instance currently sits at the path, not the specific
//     instance a contender examined — two contenders that both decide the
//     SAME instance is dead can each successfully rename away the OTHER's
//     already-completed live takeover, and the double-hold survives rename
//     intact; see this task's brief for the full worked example). The CAS:
//       1. Exclusively create a takeover GUARD FILE *inside* the stale
//          instance via `fs.writeFileSync(guardPath, ..., { flag: 'wx' })`.
//          EEXIST means another takeover is in progress (or crashed
//          mid-takeover before removing its own guard) — fail closed, naming
//          the guard file (residual: a crash here stands a guarded stale
//          lock until a human removes it by hand — see the residuals note
//          below). ENOENT means the whole stale instance already vanished
//          (a faster contender finished its own takeover already) — nothing
//          left to guard; fall straight through to the ordinary single
//          `mkdirSync` retry.
//       2. Having created the guard, RE-READ the metadata (now excluded from
//          any other contender's own guard attempt on the SAME instance) and
//          compare its IDENTITY against the snapshot decided dead: the
//          random TOKEN when the snapshot carries one, else pid+start for a
//          tokenless (pre-this-fix) legacy lock. A match proves nothing
//          changed between the liveness decision and this guarded re-read —
//          safe to remove. A MISMATCH means a faster contender's own
//          takeover already completed (or is completing) between our
//          decision and our guard — we remove only OUR OWN guard file and
//          throw ordinary contention (residual: a crash on this abort path
//          leaves a stray guard file with the same fail-closed containment
//          as residual 1 above).
//       3. On a match, remove the (now guard-file-containing) stale
//          directory and retry the acquire once.
//
//   - T-506 round 2, M2 — releaseLock() is now GUARDED: it takes the
//     RELEASING run's own token and removes the lock directory ONLY when the
//     metadata still names that exact token. A gone directory is a silent
//     no-op (nothing to release). Unreadable metadata, or metadata naming a
//     DIFFERENT token (this run's lock was itself taken over by someone
//     else, or its own metadata was corrupted — see the residuals note
//     below), is a refuse-to-remove no-op — this run must never delete a
//     lock it no longer verifiably owns. `acquireLock()`'s returned
//     `release` closure captures the token internally; every call site keeps
//     calling `lock.release()` with no arguments, unchanged.
//
//   - T-506 round 2, H2 — resolveLockPath() canonicalizes: it walks up from
//     the resolved clone-dir path to the NEAREST EXISTING ancestor,
//     `realpathSync()`s that ancestor, then re-appends the non-existing tail
//     (which by definition contains no symlinks, since it does not exist).
//     A bare `path.resolve()` fallback when the clone dir (or an ancestor of
//     it) is missing would reintroduce exactly the bug this closes, in the
//     one shape that is genuinely vulnerable: the clone-dir argv's OWN last
//     path component (not merely an ancestor of it) is itself a symlink.
//     Appending `.lock` to that argv string then produces a SIBLING name next
//     to the symlink, never something reached through it, so two spellings of
//     the same physical clone directory that differ only in that last
//     component resolve to two physically DISTINCT lock directories under
//     uncanonicalized `path.resolve()` and would then never contend. An
//     ANCESTOR-only symlink (e.g. macOS's own `/tmp` -> `/private/tmp` or
//     `/var` -> `/private/var`) is NOT this bug and was never the
//     vulnerability: the kernel resolves ancestor symlink components
//     transparently during the `mkdirSync` syscall itself, so two spellings
//     differing only in an ancestor already collided via EEXIST under the
//     OLD, pre-fix, uncanonicalized code — whether or not the clone dir (and
//     its lock) already existed.
//
//   - T-506 round 2, criterion 5 — the LEGACY-PATH liveness check. Upgrading
//     to the canonicalized path scheme does not retroactively canonicalize a
//     lock a PRE-FIX run already created at the OLD (uncanonicalized)
//     `path.resolve()`-only spelling. If that old spelling is a genuinely
//     different physical location from the new canonical one (true whenever
//     the clone-dir argv's OWN last path component — not merely an ancestor
//     of it — is itself a symlink; appending `.lock` to a symlink's own name
//     produces a SIBLING file next to the symlink, never something reached
//     through it), a post-fix acquisition at the canonical path would never
//     discover that stray pre-fix lock. Every acquireLock() call therefore
//     also recomputes the OLD-style path for the SAME clone-dir argv and, if
//     something exists there, liveness-decides it (alive -> refuse; dead ->
//     the same CAS-guarded removal; undecidable -> fail closed) BEFORE
//     proceeding to the canonical path. This is why the CHANGELOG for this
//     task carries a one-time upgrade note: a pre-fix run's lock under a
//     DIFFERENT path spelling than THIS run's own argv is still invisible to
//     this check (it only ever recomputes the legacy path for its OWN argv
//     spelling) — do not run a publish across the deploy of this fix. The
//     SAME-spelling case (by far the common one — an operator's own repeated
//     argv) is fully covered.
//
//   - Release is releaseLock() (guarded, see above). Callers are responsible
//     for wiring this into their own process exit / signal handling so the
//     lock is released on every exit path, including a crash (SIGKILL
//     strands the lock directory, which the next run's dead-pid detection
//     then recovers from automatically — there is no other way to detect a
//     SIGKILL after the fact).
//
// NAMED RESIDUALS (T-506 round 2) — every one of these degrades to a
// FAIL-CLOSED state requiring manual (human) lock removal, NEVER to a
// double-hold, which is the entire point of this module:
//   1. A crash between guard-file creation and stale-instance removal
//      strands a guarded stale lock; every later contender then fails closed
//      (guard-EEXIST) until a human removes it.
//   2. A crash on the identity-mismatch abort path (after this contender's
//      own guard file is written but before it is removed again) leaves a
//      stray guard file with the identical fail-closed containment as (1).
//   3. Corrupted own-metadata while a lock is genuinely held makes the
//      guarded release() no-op (refuse-to-remove, since it cannot verify the
//      token) — the NEXT run then fails closed against what looks like an
//      undecidable or foreign-owned lock, again requiring manual removal.
//
// Source-repo reads and the mirror's remote itself need no lock of their
// own: the former never touches the clone directory at all, and the latter
// is already protected by git's own fast-forward-only push (a compare-and-
// swap on the remote ref) — this module only guards the shared LOCAL
// working directory both scripts write into.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCK_METADATA_FILENAME = 'meta.json';
const TAKEOVER_GUARD_FILENAME = 'takeover.guard';

// Walks up from `absPath` to the nearest ancestor that actually exists.
// Returns `absPath` itself when it already exists. Stops at the filesystem
// root if nothing along the chain exists (defensive — should not happen in
// practice since the root always exists).
function nearestExistingAncestor(absPath) {
  let current = absPath;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current; // reached the root without finding anything
    current = parent;
  }
}

// Canonicalized sibling-directory lock path (T-506 round 2, H2): walks up to
// the nearest EXISTING ancestor of the resolved clone-dir path, realpathSync
// that ancestor (dereferencing any symlink — including one at the clone-dir
// path itself, when the clone dir already exists), then re-appends the
// non-existing tail unchanged (it contains no symlinks by definition, since
// it does not exist). See file header for why a plain path.resolve() alone
// is insufficient.
function resolveLockPath(cloneDirArg) {
  const resolved = path.resolve(cloneDirArg);
  const ancestor = nearestExistingAncestor(resolved);
  const tail = path.relative(ancestor, resolved);

  let canonicalAncestor;
  try {
    canonicalAncestor = fs.realpathSync(ancestor);
  } catch {
    // Should not happen (nearestExistingAncestor only returns a path that
    // fs.existsSync just reported as existing) — fail soft to the
    // uncanonicalized ancestor rather than throw from a path-resolution
    // helper.
    canonicalAncestor = ancestor;
  }

  const canonicalResolved = tail === '' ? canonicalAncestor : path.join(canonicalAncestor, tail);
  return `${canonicalResolved}.lock`;
}

// The OLD (pre-T-506-round-2), uncanonicalized sibling-directory lock path
// for the SAME clone-dir argv — used only by the legacy-path liveness check
// (see file header). Never used for THIS run's own acquisition target.
function legacyResolveLockPath(cloneDirArg) {
  return `${path.resolve(cloneDirArg)}.lock`;
}

function metadataFilePath(lockPath) {
  return path.join(lockPath, LOCK_METADATA_FILENAME);
}

function takeoverGuardPath(lockPath) {
  return path.join(lockPath, TAKEOVER_GUARD_FILENAME);
}

// A short, per-acquisition random token (T-506 round 2, C1) — the identity a
// CAS-guarded takeover re-validates against before removing a decided-dead
// lock, and the identity a guarded release() must match before removing a
// held one.
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Returns 'acquired' or 'contended'. NEVER passes { recursive: true } to the
// acquiring mkdirSync call — see file header. Throws on any other error
// (including a second, unexpected failure after the ENOENT-recovery retry).
function tryCreateLockDir(lockPath) {
  try {
    fs.mkdirSync(lockPath);
    return 'acquired';
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'contended';
    if (err && err.code === 'ENOENT') {
      // The clone dir's own parent doesn't exist yet — a legitimate
      // first-run shape. Create it, then retry the acquire ONCE, still
      // non-recursively for the lock directory itself.
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      try {
        fs.mkdirSync(lockPath);
        return 'acquired';
      } catch (err2) {
        if (err2 && err2.code === 'EEXIST') return 'contended';
        throw err2;
      }
    }
    throw err;
  }
}

// `token` is optional (T-506 round 2) — omitted entirely from the written
// JSON (via JSON.stringify dropping an `undefined` value) for direct legacy-
// style test fixtures that intentionally plant tokenless metadata to exercise
// the backward-compatibility takeover path.
function writeLockMetadata(lockPath, argv, token) {
  const data = {
    pid: process.pid,
    start: new Date().toISOString(),
    argv: argv || process.argv.slice(2),
    hostname: os.hostname(),
    token,
  };
  fs.writeFileSync(metadataFilePath(lockPath), JSON.stringify(data, null, 2));
  return data;
}

// Returns { ok: true, data } or { ok: false, reason }. Never throws — a
// corrupt or unreadable metadata file is a normal (if rare) undecidable
// state this module must fail closed on, not crash on.
function readLockMetadata(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(metadataFilePath(lockPath), 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read lock metadata file (${err.message})` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `lock metadata file is not valid JSON (${err.message})` };
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !Number.isInteger(data.pid) ||
    typeof data.hostname !== 'string' ||
    !data.hostname ||
    typeof data.start !== 'string' ||
    !data.start
  ) {
    return { ok: false, reason: 'lock metadata file is missing required fields (pid/hostname/start)' };
  }
  return { ok: true, data };
}

// Liveness-checks `pid` via the zero-signal probe (process.kill(pid, 0)
// sends no actual signal — it only tests existence/permission). Returns
// 'alive' | 'dead' | 'undecidable'. NEVER returns 'dead' for anything other
// than a definitive ESRCH (no such process) — an EPERM (process exists, but
// this user cannot signal it) or any other unexpected error is undecidable,
// not dead, because treating an undecidable signal as "dead" would silently
// steal a live lock.
function probePidLiveness(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'undecidable';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err && err.code === 'ESRCH') return 'dead';
    return 'undecidable';
  }
}

// Human-readable age string derived from an ISO start timestamp, for the
// contended-refusal message. Never used to make a decision — only pins are
// what decide, not the clock (see file header — no wall-clock auto-steal).
function formatAge(startIso) {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return 'unknown age';
  const deltaMs = Math.max(0, Date.now() - startMs);
  const totalSeconds = Math.floor(deltaMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}m`;
}

function buildContendedRefusalMessage(lockPath, holder) {
  return (
    `publish lock at ${lockPath} is held by pid ${holder.pid} (age ${formatAge(holder.start)}, started ` +
    `${holder.start}, argv: ${JSON.stringify(holder.argv)}) and that process is still running on this host — ` +
    'refusing to proceed. Wait for it to finish, or investigate it yourself before removing the lock by hand.'
  );
}

function buildFailClosedMessage(lockPath, reason) {
  return (
    `publish lock at ${lockPath} is in an UNDECIDABLE state (${reason}) — refusing to guess whether it is ` +
    'safe to proceed (fail closed; this module never auto-steals a lock on a timeout). If you have ' +
    `independently verified no publish process is actually running against this clone, remove the lock ` +
    `directory by hand (rm -rf ${lockPath}) and re-run.`
  );
}

// T-506 round 2 — the guard-file-already-present fail-closed message
// (residual 1/2 in the file header: a takeover in progress, or a prior
// takeover attempt that crashed before removing its own guard).
function buildGuardPresentMessage(lockPath, guardPath) {
  return (
    `publish lock at ${lockPath} has a takeover guard file already present at ${guardPath} — another process's ` +
    'takeover of this stale lock is in progress right now, or a prior takeover attempt crashed before removing ' +
    'its own guard file — refusing to guess which (fail closed; this module never auto-steals a lock on a ' +
    'timeout). If you have independently verified no publish process is actually running against this clone or ' +
    `performing a takeover, remove both the guard file and the lock directory by hand (rm -rf ${lockPath}) and ` +
    're-run.'
  );
}

// T-506 round 2 — thrown when a CAS-guarded re-read shows the lock's
// identity no longer matches the snapshot decided dead: a faster contender's
// own takeover already won the race. This is ORDINARY contention, not a
// fail-closed/undecidable state — simply re-running resolves it.
function buildRaceLostMessage(lockPath) {
  return (
    `publish lock at ${lockPath} changed identity after being decided dead — another process's takeover of the ` +
    'same stale lock won the race first. Re-run.'
  );
}

class LockAcquisitionError extends Error {}

// True when `current` metadata identifies the SAME acquisition instance as
// `snapshot` (the metadata read at the moment liveness was decided 'dead').
// Compares the random TOKEN when the snapshot carries one (every lock
// written by this fixed module always does); falls back to pid+start for a
// tokenless snapshot (a pre-T-506-round-2 legacy lock — backward
// compatibility for the takeover path only, never for a NEW acquisition,
// which always writes a token).
function identityMatches(current, snapshot) {
  if (snapshot.token) {
    return current.token === snapshot.token;
  }
  return current.pid === snapshot.pid && current.start === snapshot.start;
}

// Liveness-decides whatever lock metadata (if any) sits at `lockPath`.
// Returns { status: 'alive' | 'dead' | 'undecidable', data?, reason? } —
// `data` is the read metadata snapshot (present for 'alive' and 'dead', and
// for the hostname-mismatch 'undecidable' case); `reason` is present only
// for 'undecidable'. Never throws.
function decideLiveness(lockPath) {
  const meta = readLockMetadata(lockPath);
  if (!meta.ok) {
    return { status: 'undecidable', reason: meta.reason };
  }
  if (meta.data.hostname !== os.hostname()) {
    return {
      status: 'undecidable',
      reason:
        `lock metadata records hostname '${meta.data.hostname}', which differs from this host ` +
        `'${os.hostname()}' — a pid recorded on another host cannot be liveness-probed from here`,
      data: meta.data,
    };
  }
  const liveness = probePidLiveness(meta.data.pid);
  if (liveness === 'alive') return { status: 'alive', data: meta.data };
  if (liveness === 'undecidable') {
    return {
      status: 'undecidable',
      reason: `liveness of recorded pid ${meta.data.pid} could not be determined`,
      data: meta.data,
    };
  }
  return { status: 'dead', data: meta.data };
}

// T-506 round 2, C1 — the CAS-guarded takeover of a lock at `lockPath` whose
// liveness was already decided 'dead' against `decidedSnapshot` (the
// metadata read at decision time). See file header for the full algorithm
// and the residuals it accepts.
//
// Returns (never throws for these outcomes):
//   'removed' — the stale instance was safely, CAS-verified removed. The
//               caller may now attempt an ordinary acquire at `lockPath`.
//   'gone'    — the guard-file creation hit ENOENT: the stale instance had
//               ALREADY vanished entirely (a faster contender finished its
//               own takeover before we even got to guard it). Nothing left
//               to remove — the caller falls straight through to an ordinary
//               acquire attempt, exactly as if this function had removed it.
//
// Throws a LockAcquisitionError in exactly two cases:
//   - the guard file already exists (buildGuardPresentMessage) — fail closed.
//   - the post-guard re-read shows the lock's identity no longer matches
//     `decidedSnapshot` (buildRaceLostMessage) — ordinary contention, not
//     fail-closed; the caller should NOT retry an acquire in this same call
//     (the winning contender now legitimately holds it).
function guardedTakeover(lockPath, decidedSnapshot, onStaleTakeover) {
  const guardPath = takeoverGuardPath(lockPath);
  try {
    fs.writeFileSync(
      guardPath,
      JSON.stringify({ takerPid: process.pid, takerStart: new Date().toISOString() }, null, 2),
      { flag: 'wx' }
    );
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new LockAcquisitionError(buildGuardPresentMessage(lockPath, guardPath));
    }
    if (err && err.code === 'ENOENT') {
      return 'gone';
    }
    throw err;
  }

  const recheck = readLockMetadata(lockPath);
  const stillMatches = recheck.ok && identityMatches(recheck.data, decidedSnapshot);
  if (!stillMatches) {
    fs.rmSync(guardPath, { force: true });
    throw new LockAcquisitionError(buildRaceLostMessage(lockPath));
  }

  if (typeof onStaleTakeover === 'function') {
    onStaleTakeover({ lockPath, holder: decidedSnapshot });
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
  return 'removed';
}

// T-506 round 2, criterion 5 — pure cleanup of a stray lock at the OLD
// (uncanonicalized) path spelling for this same clone-dir argv, if one
// exists. Throws on 'alive' (ordinary contended refusal, naming the legacy
// path) or 'undecidable' (fail closed, naming the legacy path). On 'dead',
// delegates to guardedTakeover() — whose 'removed'/'gone' outcomes, and its
// guard-EEXIST/race-lost throws, all apply identically here; unlike the
// primary acquisition path, this call never itself tries to acquire
// anything afterward — once it returns (or the guard/race throw propagates)
// the legacy path is no longer a hazard for THIS acquisition attempt either
// way.
function resolveLegacyPathIfPresent(legacyLockPath, canonicalLockPath, onStaleTakeover) {
  if (!fs.existsSync(legacyLockPath)) return;

  // If the legacy spelling is merely a DIFFERENT STRING for the IDENTICAL
  // physical location the canonical path also resolves to (the common case
  // whenever an ANCESTOR of the clone dir is a symlink — e.g. macOS's own
  // /tmp -> /private/tmp or /var -> /private/var — where intermediate
  // symlinks are transparently followed by the filesystem for every
  // operation anyway), there is nothing extra to do here: the ordinary
  // canonical-path acquisition below will discover and liveness-decide that
  // SAME lock directory on its own. This check exists only for a legacy
  // lock that is genuinely a DIFFERENT physical directory — true whenever
  // the clone-dir argv's OWN last path component (not merely an ancestor of
  // it) is itself a symlink, since appending `.lock` to a symlink's own name
  // produces a sibling file next to the symlink, never something reached
  // through it (see file header).
  let legacyRealPath;
  try {
    legacyRealPath = fs.realpathSync(legacyLockPath);
  } catch {
    legacyRealPath = null; // unreadable/broken symlink — fall through and liveness-decide it anyway
  }
  if (legacyRealPath === canonicalLockPath) return;

  const decision = decideLiveness(legacyLockPath);
  if (decision.status === 'undecidable') {
    throw new LockAcquisitionError(buildFailClosedMessage(legacyLockPath, decision.reason));
  }
  if (decision.status === 'alive') {
    throw new LockAcquisitionError(buildContendedRefusalMessage(legacyLockPath, decision.data));
  }
  guardedTakeover(legacyLockPath, decision.data, onStaleTakeover);
}

// Attempts to acquire the exclusive lock for `cloneDirArg`. On success
// returns { lockPath, release, staleTakeover, staleHolder }. On failure
// THROWS a LockAcquisitionError whose .message is ready to hand straight to
// the calling script's own abort()/refusal reporting.
//
// `argv` — the invoking CLI's own args (e.g. process.argv.slice(2)),
// recorded in the lock metadata; defaults to this process's own argv when
// omitted.
// `onStaleTakeover` — optional callback, invoked with { lockPath, holder }
// immediately before a detected-dead lock is removed and retried, so the
// calling script can announce the takeover in its own log format. This
// module itself never logs anything — it is a pure decision/mutation
// module, easier to unit test directly.
function acquireLock(cloneDirArg, { argv, onStaleTakeover } = {}) {
  const canonicalLockPath = resolveLockPath(cloneDirArg);
  const legacyLockPath = legacyResolveLockPath(cloneDirArg);

  // T-506 round 2 — a stray pre-fix lock under the OLD uncanonicalized
  // spelling of THIS SAME clone-dir argv is invisible to the canonical-path
  // acquisition below unless checked explicitly first (see file header).
  if (legacyLockPath !== canonicalLockPath) {
    resolveLegacyPathIfPresent(legacyLockPath, canonicalLockPath, onStaleTakeover);
  }

  if (tryCreateLockDir(canonicalLockPath) === 'acquired') {
    const token = generateToken();
    writeLockMetadata(canonicalLockPath, argv, token);
    return {
      lockPath: canonicalLockPath,
      release: () => releaseLock(canonicalLockPath, token),
      staleTakeover: false,
      staleHolder: null,
    };
  }

  // Contended. Liveness-check the recorded holder — never a wall-clock
  // timeout (see file header).
  const decision = decideLiveness(canonicalLockPath);
  if (decision.status === 'undecidable') {
    throw new LockAcquisitionError(buildFailClosedMessage(canonicalLockPath, decision.reason));
  }
  if (decision.status === 'alive') {
    throw new LockAcquisitionError(buildContendedRefusalMessage(canonicalLockPath, decision.data));
  }

  // dead — CAS-guarded takeover (see guardedTakeover()'s own doc comment for
  // the full algorithm; both its non-throwing outcomes fall through to the
  // same single ordinary acquire retry below).
  guardedTakeover(canonicalLockPath, decision.data, onStaleTakeover);

  if (tryCreateLockDir(canonicalLockPath) !== 'acquired') {
    // Raced with a different process re-acquiring in the gap between the
    // takeover completing and this retry — treat as ordinary contention
    // rather than assume anything about whoever got there first.
    throw new LockAcquisitionError(
      `publish lock at ${canonicalLockPath} became contended again immediately after a stale-lock takeover ` +
        'attempt — another process appears to have acquired it first. Re-run.'
    );
  }
  const token = generateToken();
  writeLockMetadata(canonicalLockPath, argv, token);
  return {
    lockPath: canonicalLockPath,
    release: () => releaseLock(canonicalLockPath, token),
    staleTakeover: true,
    staleHolder: decision.data,
  };
}

// T-506 round 2, M2 — guarded release: removes the lock directory ONLY when
// its metadata still names `token` (the exact token THIS run's own
// acquireLock() call recorded). A gone directory is a silent no-op (nothing
// to release — e.g. this run's own lock was already cleaned up). Unreadable
// metadata, or metadata naming a DIFFERENT token, is a refuse-to-remove
// no-op: this run must never delete a lock it can no longer verifiably own
// (see the residuals note in the file header).
function releaseLock(lockPath, token) {
  if (!fs.existsSync(lockPath)) return;
  const meta = readLockMetadata(lockPath);
  if (!meta.ok) return;
  if (meta.data.token !== token) return;
  fs.rmSync(lockPath, { recursive: true, force: true });
}

module.exports = {
  LOCK_METADATA_FILENAME,
  TAKEOVER_GUARD_FILENAME,
  resolveLockPath,
  metadataFilePath,
  takeoverGuardPath,
  tryCreateLockDir,
  writeLockMetadata,
  readLockMetadata,
  probePidLiveness,
  formatAge,
  buildContendedRefusalMessage,
  buildFailClosedMessage,
  buildGuardPresentMessage,
  buildRaceLostMessage,
  identityMatches,
  decideLiveness,
  guardedTakeover,
  generateToken,
  LockAcquisitionError,
  acquireLock,
  releaseLock,
};
