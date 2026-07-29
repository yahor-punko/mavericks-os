#!/usr/bin/env node
// mavp-publish-release.js — stable-release promoter (T-502, implementing DR-006).
//
// Companion to scripts/mavp-publish-build.js (T-501). That script publishes
// every working build to the mirror's `edge` branch, several times a day.
// THIS script is the separate, deliberate act that promotes a verified
// stable milestone: it fast-forwards the mirror's `main` branch to the
// current `edge` tip, tags it `v<MAVERICKS_VERSION>`, derives a multi-section
// release body from CHANGELOG.md, and PRINTS (never executes) the `gh
// release create` command — the human checkpoint DR-006 requires.
//
// Division of responsibility (see mavp-publish-build.js's own header):
// mavp-publish-build.js never tags, never touches `main`, never creates a
// GitHub Release. This script does exactly those three things, and nothing
// else — it does not assemble, scan, or publish a working build itself; run
// mavp-publish-build.js first to get `edge` ahead of `main`.
//
// What this script does, in order (see main() at the bottom):
//   1. Preflight the clone: it must already exist, be a git repo, have an
//      `origin` remote matching <mirror-remote>, and have a clean working
//      tree. This script never creates a clone from scratch — that is
//      mavp-publish-build.js's job, and both scripts are meant to operate on
//      the same persistent clone directory.
//   2. Fetch `origin` (branches + all tags, pruned) so every check below
//      reasons about current remote state, not stale local refs.
//   3. Resolve `edge` and `main` to concrete commit SHAs EXCLUSIVELY from the
//      freshly-fetched `origin/<name>` remote-tracking ref — never from a
//      local branch of the same name. `git fetch` never updates an existing
//      local branch (only its remote-tracking counterpart), so preferring a
//      local branch here would let a stale local `edge`/`main` be silently
//      promoted even after a fresh fetch (security review round 2, M3 — the
//      same failure class recorded for T-488). Refuses if `origin/<name>` is
//      missing for either.
//   4. HARD GATE: refuse (before touching anything) unless `main`'s resolved
//      commit is an ancestor of `edge`'s resolved commit — i.e. unless
//      promoting `main` to the `edge` tip is a genuine fast-forward. This is
//      checked with `git merge-base --is-ancestor` against the read-only
//      resolved SHAs, so the refusal fires before any local branch is
//      touched, before any push, before anything is mutated at all.
//   5. Read `scripts/mavp-version.js` and `CHANGELOG.md` AT THE EDGE TIP via
//      `git show <sha>:<path>` (again: read-only, no checkout, no working-
//      tree mutation) to derive the version to tag and the release body.
//      CHANGELOG.md is also checked for heading-shaped lines that do not
//      match the exact expected `## [x.y.z]` section format (a malformed or
//      wrong-level heading would otherwise silently merge into whichever
//      section was still open, leaking older/newer content across a section
//      boundary — security review round 2, M4/judgment-call) — refuses
//      rather than guess at intent.
//   6. HARD GATE: refuse if `v<version>` already exists as a tag (checked
//      against the tags fetched in step 2, so this covers tags that already
//      exist on the mirror even if this clone never tagged one itself).
//   7. HARD GATE: refuse if no CHANGELOG.md section strictly between the
//      previous stable tag and the version being tagged (inclusive) is found
//      (nothing to release), or if the version being tagged has no matching
//      CHANGELOG.md section at all (the changelog ritual — CLAUDE.md
//      "Version bump" / PUBLIC_RELEASE_STRATEGY.md §5 — was skipped for this
//      version). The extraction itself is bounded on BOTH sides — newer than
//      the previous stable tag AND no newer than the version being tagged —
//      so a CHANGELOG section for a not-yet-tagged future version never
//      leaks into an earlier release's body (security review round 2, M1).
//   8. Only once every gate above has passed does this script touch the
//      clone: sync local `main` to the resolved `origin/main` SHA, fast-
//      forward-merge it to the exact gated `edge` SHA (not a re-resolved
//      ref name, which could have moved since step 4 — M-judgment-call),
//      push `main` to origin, create the tag, push the tag. A module-level
//      flag is set the instant the `main` push succeeds so that any abort()
//      from this point on can truthfully report a PARTIAL promotion instead
//      of the blanket "no push has occurred" (security review round 2, M2).
//   9. Print (never execute, and shell-quoted so a path containing a space
//      or shell metacharacter can't corrupt the command when pasted) the
//      exact `gh release create` command, and print the closing "refresh
//      the adopter-facing source clone" pull step (PUBLIC_RELEASE_STRATEGY.md
//      §2 step 6 — skipping it leaves ~/.mavericks pinned at the previous
//      release, which is exactly the failure mode that step exists to
//      prevent).
//
// This script NEVER executes `gh` — not even to check whether it is
// installed. It only builds the command string and prints it. Printing
// instead of executing is the deliberate human checkpoint the whole feature
// exists to preserve (see the file's own composed evidence in the T-502
// brief) — do not "improve" this into an automatic call.
//
// Usage:
//   node scripts/mavp-publish-release.js <mirror-remote> <clone-dir> \
//     [--body-out <path>]
//
//   <mirror-remote>   URL (or, for fixtures/tests, a local path) of the
//                     public mirror repo. Used only to verify <clone-dir>'s
//                     `origin` remote actually points at it (refuses on a
//                     mismatch) — this script never clones or pushes to any
//                     remote other than the one already configured on the
//                     clone.
//   <clone-dir>       Existing local clone of the mirror (the same
//                     persistent clone mavp-publish-build.js maintains).
//                     Must already be a git repo with `origin` configured.
//   --body-out <path> Optional path to write the derived release-body file.
//                     Defaults to a fresh file in a dedicated temp directory
//                     (path printed in the output). Unlike
//                     mavp-publish-build.js's scratch assembled-tree
//                     directory, this file is deliberately NOT cleaned up on
//                     exit: it is the artifact the human passes to `gh
//                     release create --notes-file`, so it must still exist
//                     after this process ends.
//
// No external dependencies — Node built-ins only (.claude/rules/scripts.md).

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Reused, not duplicated: mavp-publish-build.js already exports the
// remote-comparison helper this script needs for its own "wrong-origin
// clone" refusal (see assertOriginMatches() below). require()-ing it is
// side-effect-free — its main() only runs under `require.main === module`
// (see that file's own bottom guard) — and this script never modifies that
// file (out of scope for T-502; see the brief's "what NOT to change").
// Defensive try/catch mirrors the same reuse pattern already established by
// check-changelog-frozen.js's require of check-publish-manifest.js.
let buildScriptExports = {};
try {
  buildScriptExports = require('./mavp-publish-build.js');
} catch {
  buildScriptExports = {};
}
const normalizeRemoteForCompare =
  buildScriptExports.normalizeRemoteForCompare || ((remote) => remote);

// T-506 — shared exclusive concurrency lock on the mirror clone directory,
// the same module mavp-publish-build.js acquires. See
// scripts/mavp-publish-lock.js's own header for the full acquisition
// algorithm (liveness-probe on contention, dead-pid stale takeover,
// fail-closed on anything undecidable, NEVER a wall-clock auto-steal).
const { acquireLock } = require('./mavp-publish-lock.js');

function log(message) {
  console.log(message);
}

// Set the instant pushMain() succeeds (see that function) — the ONE state
// transition that changes what abort() is truthfully allowed to say. Before
// this point, "no push has occurred" is always true; from this point on it
// is always false, because the mirror's `main` really did move. Security
// review round 2, M2: a prior version of abort() printed the "no push has
// occurred" footer unconditionally, including when reached from pushTag()
// (i.e. AFTER main was already pushed) — telling the operator a half-
// promoted public mirror was untouched.
let mainPushed = false;
let mainPushedSha = null;

// T-506 — this script had NO exit handler at all before this task: a crash
// here would strand the publish lock (see stepAcquireLock() below) forever,
// with no dead-pid cleanup opportunity until a HUMAN noticed and removed it
// by hand. Set only once acquireLock() has actually succeeded — never
// before — so a failed/contended acquisition never mistakenly tries to
// release a lock this run never held.
//
// T-506 round 2, criterion 3 — this calls the GUARDED release() closure
// acquireLock() returned, never an inline fs.rmSync(lockPath, ...) — see the
// identical note in mavp-publish-build.js's own exit handler for why an
// inline removal here would bypass the token check entirely.
let lockReleaseForCleanup = null;
process.on('exit', () => {
  if (lockReleaseForCleanup) {
    lockReleaseForCleanup();
  }
});

// Without these, a bare SIGINT/SIGTERM (Ctrl-C, or an orchestrator stopping
// the run) terminates the process without necessarily running the 'exit'
// handler above in every Node version/platform combination. Routing both
// signals through process.exit() makes lock cleanup unconditional on an
// operator-initiated interrupt — only an unblockable SIGKILL can still
// strand the lock, which the next run's dead-pid detection then recovers
// from (see mavp-publish-lock.js).
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function abort(message) {
  console.error(`\nABORT: ${message}`);
  if (mainPushed) {
    console.error(
      `ABORT: the mirror's 'main' branch HAS ALREADY been pushed (now at ${mainPushedSha || 'unknown sha'}) — ` +
        'this is a PARTIAL promotion, not a clean no-op. Do not assume nothing happened: inspect the mirror ' +
        '(e.g. `git ls-remote`, `git log`) before taking any recovery action.'
    );
  } else {
    console.error('ABORT: no push has occurred.');
  }
  process.exit(1);
}

// POSIX single-quote shell escaping: wraps `str` in single quotes, replacing
// any embedded single quote with '\'' (close quote, escaped literal quote,
// reopen quote). Used only for the PRINTED gh/pull commands (never for an
// argv actually passed to execFileSync/spawnSync, which already avoid a
// shell entirely) — see file header step 9 / security review round 2, LOW
// finding: an unquoted clone-dir or body-path containing a space or shell
// metacharacter made the printed command wrong or unsafe when pasted.
function shQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Small git helpers (duplicated rather than imported from
// mavp-publish-build.js: that file does not export them, and this task is
// scoped to leave it unmodified — same tradeoff that file's own header
// documents for its duplicated parsePrivateNamesList()).
// ---------------------------------------------------------------------------

function gitCapture(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { ok: true, stdout: out };
  } catch (err) {
    return { ok: false, stdout: err.stdout || '', stderr: err.stderr || '', error: err };
  }
}

function gitRun(cwd, args, description) {
  const result = gitCapture(cwd, args);
  if (!result.ok) {
    abort(
      `${description} failed (git ${args.join(' ')}) in ${cwd}: ` +
        `${(result.stderr || result.stdout || '').trim() || '(no output)'}`
    );
  }
  return result;
}

function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  return gitCapture(dir, ['rev-parse', '--git-dir']).ok;
}

function refExists(cloneDir, ref) {
  return gitCapture(cloneDir, ['show-ref', '--verify', '--quiet', ref]).ok;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

// A flag value that is itself flag-shaped (e.g. `--body-out --target`) is
// rejected rather than silently consumed: accepting it would write a file
// literally named `--target` into the CWD (security review round 2, LOW
// finding). Any token starting with `-` is treated as "not a value" —
// legitimate paths do not start with `-`, and a user who genuinely needs one
// can always prefix it (`./-weird/path`).
function looksLikeFlag(value) {
  return value === undefined || value.startsWith('-');
}

function parseArgs(argv) {
  const positional = [];
  let bodyOutPath = null;
  let bodyOutError = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--body-out') {
      const next = argv[i + 1];
      if (looksLikeFlag(next)) {
        bodyOutError = `--body-out requires a path value; got ${next === undefined ? 'nothing' : JSON.stringify(next)}, which looks like a flag — refusing to treat a flag as a --body-out value.`;
      } else {
        bodyOutPath = next;
        i++;
      }
    } else if (arg.startsWith('--body-out=')) {
      const value = arg.slice('--body-out='.length);
      if (looksLikeFlag(value) || value === '') {
        bodyOutError = `--body-out requires a path value; got ${JSON.stringify(value)}, which looks like a flag (or is empty) — refusing.`;
      } else {
        bodyOutPath = value;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    mirrorRemote: positional[0],
    cloneDir: positional[1],
    bodyOutPath: bodyOutPath || null,
    bodyOutError,
  };
}

function printUsage() {
  console.error(
    'Usage: node scripts/mavp-publish-release.js <mirror-remote> <clone-dir> ' +
      '[--body-out <path>]\n' +
      '\n' +
      '  <clone-dir> must already exist as a git clone of <mirror-remote> with ' +
      "'origin' configured and 'edge' ahead of 'main' — run " +
      'mavp-publish-build.js first if it does not.'
  );
}

// ---------------------------------------------------------------------------
// Preflight (read-only except for the fetch, which only reads from origin)
// ---------------------------------------------------------------------------

function assertCloneIsGitRepo(cloneDir) {
  if (!isGitRepo(cloneDir)) {
    abort(
      `${cloneDir} does not exist or is not a git repository — run ` +
        'mavp-publish-build.js first to establish the working-build clone.'
    );
  }
}

function assertOriginMatches(cloneDir, mirrorRemote) {
  const originResult = gitCapture(cloneDir, ['remote', 'get-url', 'origin']);
  if (!originResult.ok) {
    abort(`clone at ${cloneDir} has no 'origin' remote configured — refusing to operate on it.`);
  }
  const actualOrigin = originResult.stdout.trim();
  if (normalizeRemoteForCompare(actualOrigin) !== normalizeRemoteForCompare(mirrorRemote)) {
    abort(
      `clone at ${cloneDir} has origin '${actualOrigin}', which does not match the requested ` +
        `mirror '${mirrorRemote}' — refusing to promote main on a clone pointed at a different remote.`
    );
  }
}

function assertCleanWorkingTree(cloneDir) {
  const status = gitCapture(cloneDir, ['status', '--porcelain']);
  if (!status.ok) {
    abort(`could not read git status of clone at ${cloneDir}`);
  }
  if (status.stdout.trim().length > 0) {
    console.error('\nDirty mirror clone (uncommitted changes):');
    console.error(status.stdout);
    abort(`${cloneDir} has local uncommitted changes — refusing to touch it. Inspect and clean it manually.`);
  }
}

// ---------------------------------------------------------------------------
// T-506 — acquire the exclusive clone-directory lock, immediately before the
// preflight fetch below (this script's first clone-directed git operation
// beyond the already-committed local checks above). Held through the tag
// push at the end of main(): release happens only via the process.on('exit')
// handler above (or the SIGINT/SIGTERM handlers routing into it), never
// explicitly mid-run.
//
// Source-repo reads and the mirror's remote itself need no lock of their own
// — see scripts/mavp-publish-lock.js's file header for why (this script
// never reads a separate "source repo" at all, and the mirror's own
// fast-forward-only push is already git's own compare-and-swap).
// ---------------------------------------------------------------------------

function stepAcquireLock(cloneDir) {
  log(`\n=== Acquiring publish lock for ${cloneDir} ===`);
  let lock;
  try {
    lock = acquireLock(cloneDir, {
      argv: process.argv.slice(2),
      onStaleTakeover: ({ lockPath, holder }) => {
        log(
          `Stale lock detected at ${lockPath} (holder pid ${holder.pid}, started ${holder.start}) is no ` +
            'longer running — taking it over.'
        );
      },
    });
  } catch (err) {
    abort(err.message);
    return; // unreachable (abort() calls process.exit(1)) — kept for clarity.
  }
  lockReleaseForCleanup = lock.release;
  log(`Lock acquired at ${lock.lockPath}.`);
}

function fetchOrigin(cloneDir) {
  const result = gitCapture(cloneDir, ['fetch', 'origin', '--prune', '--tags']);
  if (!result.ok) {
    abort(
      `could not fetch from origin at ${cloneDir} (git fetch origin --prune --tags failed): ` +
        `${(result.stderr || result.stdout || '').trim() || '(no output)'}`
    );
  }
}

// Resolves a branch name to { name, sha } EXCLUSIVELY from the freshly-
// fetched `origin/<branchName>` remote-tracking ref — never from a same-
// named local branch. Returns null if `origin/<branchName>` does not exist.
//
// Security review round 2, M3: a prior version preferred the local branch
// and fell back to `origin/<name>` only when no local branch existed. That
// is backwards from what the file header claims ("every check reasons about
// current remote state, not stale local refs") — `git fetch` NEVER updates
// an already-existing local branch, only its `origin/<name>` counterpart, so
// a stale local `edge` (behind `origin/edge`) was silently promoted and
// tagged instead of the mirror's actual current tip. Resolving only from
// `origin/*` post-fetch removes the stale-local-ref path entirely rather
// than special-casing a divergence check.
function resolveOriginRef(cloneDir, branchName) {
  const remoteName = `origin/${branchName}`;
  if (!refExists(cloneDir, `refs/remotes/${remoteName}`)) return null;
  const sha = gitCapture(cloneDir, ['rev-parse', remoteName]);
  return sha.ok ? { name: remoteName, sha: sha.stdout.trim() } : null;
}

// Security review round 3, LOW-B (optional hardening the reviewer leaned
// toward): resolveOriginRef() trusts the LOCAL `origin/<branchName>`
// remote-tracking ref, which `fetchOrigin()`'s `git fetch origin --prune
// --tags` is assumed to have just brought current. That assumption breaks
// if this clone's `remote.origin.fetch` refspec has been narrowed (e.g. to
// track only `main`) — the fetch still succeeds, but silently never touches
// `origin/edge`, leaving it stale while the mirror's real tip has moved on.
// mavp-publish-build.js never narrows the refspec, so this is exotic, not
// the primary threat model M3 closed — but the check is cheap: `git
// ls-remote origin <ref>` asks the REMOTE directly, bypassing any local
// refspec configuration entirely, so it can never be fooled by a narrowed
// fetch. Returns the remote's actual current SHA for `ref`, or null if the
// remote couldn't be reached / the ref doesn't exist there (callers treat
// null as "cannot verify" and skip the check, matching this codebase's
// established guard-degradation posture — see check-changelog-frozen.js).
// Security review round 4, LOW: a prior version returned a bare `null` for
// BOTH "the remote could not be queried at all" (transient failure — should
// degrade silently, same posture `fetchOrigin()` itself needs) AND "the
// remote answered and the ref genuinely does not exist there" (positive
// knowledge that the locally-resolved ref is bogus — must abort, never
// degrade). Collapsing those into one `null` made the caller treat "the
// mirror told us this branch is gone" the same as "we couldn't ask" —
// reproduced with no transient condition at all: a narrowed refspec (so
// `--prune` never removes the stale `origin/edge`) plus `edge` deleted on
// the mirror silently promoted `main` to a branch tip the mirror no longer
// has. Returns `{ queryFailed, sha }`: `queryFailed: true` only when the
// `ls-remote` invocation itself errored; `sha: null` (with `queryFailed:
// false`) means the remote was reached and reported no such ref.
function lsRemoteSha(cloneDir, ref) {
  const result = gitCapture(cloneDir, ['ls-remote', 'origin', ref]);
  if (!result.ok) return { queryFailed: true, sha: null };
  const line = result.stdout.split('\n').find((l) => l.trim().length > 0);
  return { queryFailed: false, sha: line ? line.split('\t')[0].trim() : null };
}

// Aborts if the local `origin/<branchName>` remote-tracking SHA does not
// match what `git ls-remote` reports as the branch's ACTUAL current tip on
// the remote — see lsRemoteSha()'s comment for why this can differ (a
// narrowed `remote.origin.fetch` refspec), and for why a query FAILURE and
// a genuinely ABSENT ref must be handled differently. Silently skips the
// check only on a query failure (a transient `ls-remote` hiccup that
// `fetchOrigin()` itself already tolerated); aborts on a ref that the
// remote positively reports as absent, and on any SHA mismatch.
function assertRemoteTrackingRefIsCurrent(cloneDir, branchName, resolvedSha) {
  const { queryFailed, sha: trueSha } = lsRemoteSha(cloneDir, `refs/heads/${branchName}`);
  if (queryFailed) return; // could not verify at all — degrade silently
  if (trueSha === null) {
    abort(
      `origin/${branchName} in ${cloneDir} is resolved locally to ${resolvedSha}, but 'git ls-remote origin ` +
        `refs/heads/${branchName}' reports NO SUCH BRANCH on the mirror at all — the local remote-tracking ref is ` +
        'stale/bogus (e.g. the branch was deleted upstream while a narrowed remote.origin.fetch refspec kept ' +
        '--prune from ever removing it locally). Refusing to promote against a ref the mirror does not have.'
    );
  }
  if (trueSha !== resolvedSha) {
    abort(
      `origin/${branchName} in ${cloneDir} (${resolvedSha}) does not match the mirror's ACTUAL current '${branchName}' ` +
        `tip per 'git ls-remote origin refs/heads/${branchName}' (${trueSha}) — the local remote-tracking ref is stale ` +
        "(e.g. a narrowed remote.origin.fetch refspec that fetchOrigin()'s fetch silently didn't update). Refusing to " +
        'promote against a stale tip. Fix the refspec (or re-clone) and retry.'
    );
  }
}

// HARD GATE — see file header step 4. Read-only: uses `git merge-base
// --is-ancestor` against the already-resolved SHAs, never touches any
// branch or the working tree. Aborts before any mutation on failure.
function assertFastForwardPossible(cloneDir, mainSha, edgeSha) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', mainSha, edgeSha], {
    cwd: cloneDir,
    stdio: 'pipe',
  });
  if (result.status === 0) return; // main is an ancestor of edge — fast-forward is safe
  if (result.status === 1) {
    abort(
      `promoting main (${mainSha}) to the edge tip (${edgeSha}) would be a NON-FAST-FORWARD move — ` +
        "main is not an ancestor of edge (they have diverged; main has a commit edge does not contain). " +
        'Refusing to promote. Resolve manually — never force-push either branch (DR-006).'
    );
  }
  abort(
    `could not determine fast-forward eligibility between main (${mainSha}) and edge (${edgeSha}) ` +
      `(git merge-base --is-ancestor exited ${result.status}).`
  );
}

function gitShow(cloneDir, sha, filePath) {
  const result = gitCapture(cloneDir, ['show', `${sha}:${filePath}`]);
  if (!result.ok) {
    abort(
      `could not read ${filePath} at ${sha} in ${cloneDir} (git show failed): ` +
        `${(result.stderr || result.stdout || '').trim() || '(no output)'}`
    );
  }
  return result.stdout;
}

function listTags(cloneDir) {
  const result = gitRun(cloneDir, ['tag', '-l'], 'listing tags');
  return result.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pure parsing/derivation helpers (no git calls, no abort() — safe to unit
// test directly, exported at the bottom).
// ---------------------------------------------------------------------------

// Extracts MAVERICKS_VERSION out of scripts/mavp-version.js's text content.
// Returns the raw matched string, or null if the field could not be found.
// Does NOT validate shape (numeric x.y.z vs. a forbidden pre-release
// suffix) — callers do that separately (see isPlainNumericVersion below) so
// this stays a pure "did we find a value at all" extractor.
//
// Anchored to the ACTUAL declaration shape scripts/mavp-version.js always
// uses (`module.exports = { MAVERICKS_VERSION: 'x.y.z' };`) rather than a
// bare `MAVERICKS_VERSION\s*:\s*['"]...['"]` search anywhere in the file.
// Security review round 2, judgment call: `.match()` returns the FIRST
// match in the file, so a bare search could be shadowed by an earlier
// COMMENT that happens to mention the constant (e.g. "// bumped from
// MAVERICKS_VERSION: '0.38.2'") landing before the real declaration.
// Requiring the match to sit inside a `module.exports = { ... }` object
// literal makes an ordinary prose comment (which is never inside that
// literal) structurally unable to match.
function parseMavericksVersion(fileContent) {
  const m = fileContent.match(/module\.exports\s*=\s*\{[^}]*\bMAVERICKS_VERSION\s*:\s*['"]([^'"]+)['"][^}]*\}/);
  return m ? m[1].trim() : null;
}

// DR-006: "Version stamps stay purely numeric; pre-release suffixes are
// forbidden in MAVERICKS_VERSION." A version failing this shape check is a
// convention violation, not a normal release — refusing to tag it is a
// defensive belt beyond the AC's literal wording, not a new user-facing
// feature (see the "already-existing tag" gate, which this pairs with).
function isPlainNumericVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

// Compares two "x.y.z" numeric version strings. Returns <0, 0, or >0 the
// usual comparator way. Non-numeric or missing parts coerce to 0 — this is
// safe ONLY because callers restrict input to isPlainNumericVersion()-shaped
// strings before calling this (unlike the unsafe comparator DR-006 documents
// finding elsewhere in this codebase, which is exactly why suffixes are
// forbidden rather than "fixed" — see docs/core/DECISIONS.md DR-006).
function compareVersions(a, b) {
  const partsA = a.split('.').map((p) => parseInt(p, 10));
  const partsB = b.split('.').map((p) => parseInt(p, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const na = Number.isFinite(partsA[i]) ? partsA[i] : 0;
    const nb = Number.isFinite(partsB[i]) ? partsB[i] : 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

const CHANGELOG_HEADING_RE = /^##\s*\[([^\]]+)\]/;
// Matches a markdown heading of ANY level (1-6) immediately followed by a
// bracketed token — i.e. something that LOOKS LIKE an attempted version/
// section reference (`## [x.y.z]`, `### [x.y.z]`, `# [Unreleased]`, etc.),
// as opposed to an ordinary Keep-a-Changelog sub-heading like `### Added` or
// `### Fixed` (no bracket, and real house style for this project — must
// never be flagged). Used in findMalformedHeadingLines() below to catch a
// heading-shaped version reference that is NOT a valid `## [x.y.z]` section
// (wrong heading level, a typo) so it can be refused rather than silently
// absorbed into whichever section happens to still be open.
const SUSPICIOUS_HEADING_RE = /^#{1,6}\s*\[/;
// Matches either CommonMark fence character (security review round 3,
// LOW-A: a prior version only recognized ``` and missed ~~~).
//
// Indent is capped at 0-3 literal spaces (T-518): CommonMark caps a fence
// delimiter's leading indentation at three spaces — a fence-looking line
// indented FOUR OR MORE spaces is not a fence delimiter at all (it is, at
// most, part of an indented code block, which this parser does not model).
// The prior `\s*` accepted any amount of indentation, so a PAIR of
// 4-or-more-space-indented fence-looking lines could bracket a real `##
// [x.y.z]` version heading between them; the heading was wrongly marked
// `inFence` and silently merged upward into the still-open section above —
// an upward-merge leak distinct from (and closing the last remaining case
// alongside) the M4/NEW-1/round-4 leaks already fixed. Deliberately
// space-only, not `\s`: a leading TAB is — per CommonMark's tab-stop-4
// equivalence for block-structure indentation — already AT the four-column
// threshold that disqualifies a fence delimiter, so a tab-indented
// fence-looking line correctly falls outside the 0-3 allowance too (pinned
// by a dedicated assertion in test-publish-release.js, not left as an
// unstated side effect of switching character classes).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Single shared fence-state walk used by ALL THREE of
// parseChangelogSections() / findMalformedHeadingLines() /
// findUnterminatedFenceLine() below (security review round 3, NEW-1 root
// cause): round 2 gave each of the first two functions its OWN independent
// `inFence` boolean. Both copies moved in lockstep for balanced fences, but
// there was no single place that could ever notice an UNBALANCED one — an
// unterminated ```-fence made both functions permanently treat "everything
// after it" as fenced content for the rest of the file, so a genuine `##
// [0.40.0]` heading past the unterminated fence was silently swallowed by
// parseChangelogSections() into the still-open (older) section AND, because
// findMalformedHeadingLines() used the identical `if (inFence) continue`
// shortcut, never flagged as suspicious either. The fix that closed one leak
// (fence-awareness, so an EXAMPLE heading inside a real fence isn't a real
// section) reopened the exact class of leak it was meant to prevent, via an
// unterminated fence instead of a heading. Computing fence state ONCE, in one
// function, and deriving all three answers from it removes the possibility
// of the two copies ever diverging again — and makes "is this fence
// balanced at EOF" a question with exactly one implementation to get right.
//
// Fence character TYPE matters, per CommonMark: a ~~~-fenced block is not
// closed by a ``` line (and vice versa) — it stays open, and the ``` line
// is just ordinary content inside it. Tracked via `fenceChar` (null = not
// fenced; '`' or '~' while fenced) rather than a bare boolean toggle.
//
// Returns:
//   states               — array of { text, inFence } (1:1 with `content`'s
//                           lines). `inFence` is true for a fence DELIMITER
//                           line itself (opening or closing) as well as
//                           every line strictly between them — i.e. "treat
//                           this line as ordinary fenced content, never as a
//                           candidate section heading".
//   unterminatedFenceLine — the 1-indexed line number where the fence that
//                           is STILL OPEN at end-of-file began, or null if
//                           every opened fence was properly closed.
function computeChangelogLineStates(content) {
  const lines = content.split('\n');
  const states = [];
  let fenceChar = null;
  let fenceOpenLength = null;
  let fenceOpenedAtLine = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0]; // '`' or '~'
      const markerLength = fenceMatch[1].length;
      if (fenceChar === null) {
        fenceChar = marker; // opening delimiter
        fenceOpenLength = markerLength;
        fenceOpenedAtLine = i + 1;
      } else if (marker === fenceChar && markerLength >= fenceOpenLength) {
        // Security review round 4, BLOCKER: CommonMark requires a closing
        // fence to be the SAME character AND AT LEAST AS LONG as the
        // opener — a shorter same-character fence (e.g. a stray ``` line
        // closing a ```` opener) does NOT close it. A prior version
        // compared only the character, so a 4-backtick fence containing an
        // unrelated 3-backtick example (a realistic shape for a
        // documentation-heavy CHANGELOG) was falsely reported as closed by
        // that inner 3-backtick line, reopening NEW-1 through a different
        // door: findUnterminatedFenceLine() returned null and every
        // heading after the TRUE close was silently swallowed.
        fenceChar = null; // matching closing delimiter
        fenceOpenLength = null;
        fenceOpenedAtLine = null;
      }
      // else: either a different fence character, or the SAME character
      // but too short to close the open fence — per CommonMark neither
      // closes it; both are ordinary fenced content, so fall through and
      // mark this line inFence below.
      states.push({ text: line, inFence: true });
      continue;
    }
    states.push({ text: line, inFence: fenceChar !== null });
  }

  return {
    states,
    unterminatedFenceLine: fenceChar !== null ? fenceOpenedAtLine : null,
  };
}

// Parses CHANGELOG.md content into an ordered list of { version, text }
// sections, one per `## [x.y.z]` (or `## [Unreleased]`) heading, in the
// order they appear in the file (house style is newest-first). `text` is
// the heading line plus every line up to (not including) the next heading,
// with trailing blank lines trimmed. Lines before the first heading (the
// "# Changelog" preamble) are not part of any section and are dropped.
//
// Fence-aware (security review round 2, judgment call): a `## [x.y.z]`-
// shaped line inside a fenced code block (e.g. a doc example illustrating
// the CHANGELOG format) is never treated as a real section — only fence
// state, never a real published release, would otherwise leak into the
// extracted set. Callers MUST also check findUnterminatedFenceLine() and
// refuse before trusting this function's output — an unbalanced fence makes
// this function silently swallow every later heading too (security review
// round 3, NEW-1); this function does not raise that error itself so it can
// stay a pure, always-succeeds parser for direct unit testing.
function parseChangelogSections(content) {
  const { states } = computeChangelogLineStates(content);
  const sections = [];
  let current = null;

  for (const { text: line, inFence } of states) {
    const m = !inFence && line.match(CHANGELOG_HEADING_RE);
    if (m) {
      if (current) sections.push(current);
      current = { version: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return sections.map((s) => ({
    version: s.version,
    text: s.lines.join('\n').replace(/\s+$/, ''),
  }));
}

// Scans CHANGELOG.md content for heading-shaped lines that LOOK LIKE an
// attempted version/section reference (a heading of any level immediately
// followed by a bracketed token — see SUSPICIOUS_HEADING_RE) but do NOT
// match the exact expected `## [x.y.z]` section format — e.g. a wrong
// heading level (`### [0.38.2]`), or any other bracket-shaped typo. Left
// undetected, such a line does not reset parseChangelogSections()'s
// `current` section, so everything from the malformed heading through the
// next VALID heading silently merges into whichever section was still open
// — meaning content meant for a separate (possibly older, already-excluded)
// section leaks into the section being published (security review round 2,
// M4). Returns a list of { line, text } for every offending line found
// (empty = clean).
//
// Deliberately narrow: an ordinary Keep-a-Changelog sub-heading like
// `### Added` / `### Fixed` (no bracket) is this project's real house style
// and must never be flagged — only a BRACKETED heading at the wrong level
// looks like a botched attempt at a version section. Fence-aware for the
// same reason as parseChangelogSections() (shares the same fence-state
// computation — see computeChangelogLineStates()'s comment for why that
// sharing itself is the fix for NEW-1).
function findMalformedHeadingLines(content) {
  const { states } = computeChangelogLineStates(content);
  const offenders = [];

  for (let i = 0; i < states.length; i++) {
    const { text: line, inFence } = states[i];
    if (inFence) continue;
    if (!SUSPICIOUS_HEADING_RE.test(line)) continue;
    if (CHANGELOG_HEADING_RE.test(line)) continue; // valid section heading
    offenders.push({ line: i + 1, text: line });
  }
  return offenders;
}

// Security review round 3, NEW-1: an unterminated fence (a ```/~~~ opened
// but never closed before EOF) makes parseChangelogSections() AND
// findMalformedHeadingLines() both silently treat every subsequent line —
// including a genuine `## [x.y.z]` heading for a NEWER, not-yet-tagged
// version — as ordinary fenced content of whichever section was open when
// the fence opened. That silently merges a future release's notes into an
// earlier one's published body, bypassing extractReleaseSections()'s upper
// bound entirely (the upper bound never sees a heading that was never
// recognized as a heading). An unterminated fence is a defect in
// CHANGELOG.md in its own right — refusing is correct and cheap. Returns
// the 1-indexed line where the still-open fence began, or null if every
// fence in the document is properly closed.
function findUnterminatedFenceLine(content) {
  return computeChangelogLineStates(content).unterminatedFenceLine;
}

// Finds the highest `v<x.y.z>` tag among tagNames (tags not shaped exactly
// like `v<numeric x.y.z>` are ignored for this computation — a stray legacy
// tag must not corrupt "what was the previous stable release"). Returns the
// bare version string (no leading `v`), or null if no such tag exists yet
// (first-ever stable release on this mirror).
function computePreviousStableVersion(tagNames) {
  let max = null;
  for (const tag of tagNames) {
    const m = tag.match(/^v(\d+\.\d+\.\d+)$/);
    if (!m) continue;
    const version = m[1];
    if (max === null || compareVersions(version, max) > 0) max = version;
  }
  return max;
}

// AC: "extracts all CHANGELOG.md sections newer than the previous stable
// tag". `previousStableVersion` of null means there is no prior stable tag
// at all (first release) — every real (non-"Unreleased") section qualifies
// on the lower bound. The `Unreleased` heading itself never qualifies — see
// the file header's step 7 and the module-level comment above
// parseChangelogSections().
//
// `taggedVersion` is the REQUIRED upper bound (security review round 2, M1):
// a section is included only if it is newer than `previousStableVersion`
// AND no newer than `taggedVersion`. Without this upper bound, a CHANGELOG
// section for a version that hasn't been stamped/tagged yet (e.g. `##
// [0.40.0]` landing in a multi-commit wave before `scripts/mavp-version.js`
// is bumped to it) would be extracted and published early into THIS
// release's body — a real, non-adversarial scenario for this project's own
// release ritual, not a hypothetical.
function extractReleaseSections(changelogContent, previousStableVersion, taggedVersion) {
  const allSections = parseChangelogSections(changelogContent);
  return allSections.filter((section) => {
    if (section.version.toLowerCase() === 'unreleased') return false;
    if (compareVersions(section.version, taggedVersion) > 0) return false;
    if (previousStableVersion === null) return true;
    return compareVersions(section.version, previousStableVersion) > 0;
  });
}

// Concatenates extracted sections (already in document order) into the
// release-body text, blank-line separated, single trailing newline.
function renderReleaseBody(sections) {
  return sections.map((s) => s.text.trim()).join('\n\n') + '\n';
}

// Resolves the adopter-facing mirror clone path exactly like
// check-changelog-frozen.js's resolveMirrorHome(): MAVERICKS_HOME env var if
// set, otherwise `~/.mavericks` computed via os.homedir() at RUNTIME — this
// deliberately keeps any machine-specific home-directory location entirely
// out of this shipped file's source text (see .claude/rules/scripts.md —
// private-name / absolute-path discipline).
function resolveMirrorHome() {
  const envHome = process.env.MAVERICKS_HOME;
  if (envHome && envHome.trim()) return envHome.trim();
  return path.join(os.homedir(), '.mavericks');
}

// ---------------------------------------------------------------------------
// Mutation phase (only reached after every gate above has passed)
// ---------------------------------------------------------------------------

// Syncs the local 'main' branch to EXACTLY `mainSha` (the gated,
// origin-resolved SHA from resolveOriginRef() — see main()), creating the
// branch if absent or resetting it if present. `-B` is deliberate: origin is
// the authoritative source for `main` (per M3 above), so any local `main`
// drift — including commits never pushed anywhere — is intentionally
// discarded here rather than merged with; this clone is a dedicated
// automation checkout, not an operator's daily-driver working copy.
function syncLocalMainTo(cloneDir, mainSha) {
  gitRun(cloneDir, ['checkout', '-B', 'main', mainSha], "sync local 'main' to origin/main");
}

// Fast-forward-merges the exact gated `edgeSha` (a commit SHA, never a
// re-resolved ref name) into the currently-checked-out branch. Security
// review round 2, judgment call: merging by ref name (`edge` or
// `origin/edge`) re-resolves the ref at merge time, which could in principle
// have moved between the assertFastForwardPossible() ancestor check and
// this call (e.g. a concurrent fetch — see T-506). Merging the captured SHA
// directly makes that window irrelevant: there is nothing left to re-
// resolve.
function mergeFastForward(cloneDir, edgeSha) {
  const result = gitCapture(cloneDir, ['merge', '--ff-only', edgeSha]);
  if (!result.ok) {
    // Defensive re-check: assertFastForwardPossible() already verified this
    // via merge-base against the resolved SHAs before any mutation, so
    // reaching this branch means something changed underneath us between
    // that check and now (e.g. another process). Abort rather than assume.
    abort(
      `git merge --ff-only ${edgeSha} failed in ${cloneDir} despite passing the earlier ` +
        `ancestor check — refusing rather than guessing why: ${(result.stderr || result.stdout || '').trim()}`
    );
  }
}

function pushMain(cloneDir) {
  // --no-follow-tags: without this, push.followTags=true (a common global
  // git setting) would carry every annotated tag reachable from main and
  // missing on the remote along with this push — including a stray local
  // tag created after step 2's `fetch --tags` equalized existing tags. Such
  // a tag would bypass the already-exists gate entirely (that gate checks
  // only v<version>) and reach the mirror unvetted. The explicit refspec
  // also removes DWIM ambiguity about which ref is being pushed/updated.
  const result = gitCapture(cloneDir, [
    'push',
    '--no-follow-tags',
    'origin',
    'refs/heads/main:refs/heads/main',
  ]);
  if (!result.ok) {
    abort(
      `git push origin main failed in ${cloneDir} — the remote likely rejected a non-fast-forward ` +
        `push (main may have moved on origin since the last fetch): ${(result.stderr || result.stdout || '').trim()}`
    );
  }
  // From this instant on, the mirror's main branch has genuinely moved —
  // see abort()'s mainPushed handling above (security review round 2, M2).
  mainPushed = true;
  const headResult = gitCapture(cloneDir, ['rev-parse', 'HEAD']);
  mainPushedSha = headResult.ok ? headResult.stdout.trim() : 'unknown sha';
}

function createTag(cloneDir, tagName) {
  gitRun(cloneDir, ['tag', tagName], `creating tag ${tagName}`);
}

function pushTag(cloneDir, tagName) {
  // --no-follow-tags: this tag (created by createTag() as a lightweight tag,
  // no -a/-m) still travels — it is named explicitly in the refspec below,
  // not delivered via tag-following. The flag only suppresses git from also
  // following any OTHER annotated tag reachable from main that happens to be
  // missing on the remote (see pushMain()'s comment for why that matters).
  // The explicit refspec also removes DWIM ambiguity about the pushed ref.
  const result = gitCapture(cloneDir, [
    'push',
    '--no-follow-tags',
    'origin',
    `refs/tags/${tagName}:refs/tags/${tagName}`,
  ]);
  if (!result.ok) {
    // Clean up the local-only tag so a re-run isn't blocked by the
    // "tag already exists" gate against a tag that never actually reached
    // the mirror.
    gitCapture(cloneDir, ['tag', '-d', tagName]);
    // Security review round 2, M2: do not guess at a cause we have not
    // established (a prior version speculated "may already have this tag
    // from a concurrent run", which was wrong in the reviewer's reproduction
    // — a pre-receive hook rejection, not a concurrent run). State only what
    // is known: the push failed, the local-only tag was removed, and the
    // mirror's main is already-pushed (mainPushed is true by the time this
    // function can run — see main()'s ordering) so abort() itself reports
    // that partial state; this message adds nothing but the raw git error.
    abort(
      `git push origin ${tagName} failed in ${cloneDir} (local tag ${tagName} removed): ` +
        `${(result.stderr || result.stdout || '').trim() || '(no output)'}`
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const { mirrorRemote, cloneDir, bodyOutPath, bodyOutError } = parseArgs(process.argv.slice(2));

  if (bodyOutError) {
    printUsage();
    console.error(`\nERROR: ${bodyOutError}`);
    process.exit(1);
  }
  if (!mirrorRemote || !cloneDir) {
    printUsage();
    process.exit(1);
  }

  log(`\n=== Preflight: verifying clone at ${cloneDir} ===`);
  assertCloneIsGitRepo(cloneDir);
  assertOriginMatches(cloneDir, mirrorRemote);
  assertCleanWorkingTree(cloneDir);

  stepAcquireLock(cloneDir);

  log("\n=== Fetching 'origin' (branches + tags) ===");
  fetchOrigin(cloneDir);

  // Resolved EXCLUSIVELY from origin/* (never a local branch) — see M3 in
  // resolveOriginRef()'s own comment and the file header step 3.
  const edgeRef = resolveOriginRef(cloneDir, 'edge');
  if (!edgeRef) {
    abort(
      "mirror has no 'edge' branch (origin/edge, post-fetch) to promote from — run " +
        'mavp-publish-build.js first to establish it.'
    );
  }
  const mainRef = resolveOriginRef(cloneDir, 'main');
  if (!mainRef) {
    abort("mirror has no 'main' branch (origin/main, post-fetch) found.");
  }

  // Security review round 3, LOW-B: cross-check the local origin/* refs
  // against the remote's own report (git ls-remote), which a narrowed
  // fetch refspec cannot fool — see assertRemoteTrackingRefIsCurrent()'s
  // comment.
  assertRemoteTrackingRefIsCurrent(cloneDir, 'edge', edgeRef.sha);
  assertRemoteTrackingRefIsCurrent(cloneDir, 'main', mainRef.sha);

  log(`\n=== Checking fast-forward eligibility: main (${mainRef.sha}) -> edge (${edgeRef.sha}) ===`);
  assertFastForwardPossible(cloneDir, mainRef.sha, edgeRef.sha);
  log('Fast-forward is possible (main is an ancestor of edge). Proceeding.');

  log('\n=== Reading version + CHANGELOG.md at the edge tip (read-only, no checkout yet) ===');
  const versionFileContent = gitShow(cloneDir, edgeRef.sha, 'scripts/mavp-version.js');
  const version = parseMavericksVersion(versionFileContent);
  if (!version) {
    abort(
      `could not parse MAVERICKS_VERSION out of scripts/mavp-version.js at the edge tip (${edgeRef.sha}) — ` +
        "expected a `module.exports = { MAVERICKS_VERSION: 'x.y.z' }` declaration."
    );
  }
  if (!isPlainNumericVersion(version)) {
    abort(
      `MAVERICKS_VERSION '${version}' at the edge tip (${edgeRef.sha}) is not a plain numeric x.y.z version — ` +
        'DR-006 forbids pre-release suffixes (docs/core/DECISIONS.md). Refusing to tag a non-numeric version.'
    );
  }
  const tagName = `v${version}`;
  log(`Version at edge tip: ${version} (tag: ${tagName})`);

  const existingTags = listTags(cloneDir);
  if (existingTags.includes(tagName)) {
    abort(`tag ${tagName} already exists on this clone/mirror — refusing to re-tag an already-released version.`);
  }

  const changelogContent = gitShow(cloneDir, edgeRef.sha, 'CHANGELOG.md');

  // Security review round 3, NEW-1: check BEFORE trusting either
  // findMalformedHeadingLines() or extractReleaseSections() — both are
  // built on parseChangelogSections(), which silently treats everything
  // after an unbalanced fence as fenced content, including a genuine future
  // version heading. Refuse rather than risk that silent merge.
  const unterminatedFenceLine = findUnterminatedFenceLine(changelogContent);
  if (unterminatedFenceLine !== null) {
    abort(
      `CHANGELOG.md at the edge tip (${edgeRef.sha}) has an unterminated fenced code block opened at line ` +
        `${unterminatedFenceLine} (a \`\`\` or ~~~ with no matching closer before end of file) — refusing, ` +
        'because every line after an unclosed fence is silently treated as fenced content, including any ' +
        'real CHANGELOG section heading that comes after it. Close the fence and retry.'
    );
  }

  const malformedHeadings = findMalformedHeadingLines(changelogContent);
  if (malformedHeadings.length > 0) {
    const first = malformedHeadings[0];
    abort(
      `CHANGELOG.md at the edge tip (${edgeRef.sha}) contains ${malformedHeadings.length} heading-shaped line(s) ` +
        `that do not match the expected '## [x.y.z]' section format (e.g. line ${first.line}: ${JSON.stringify(first.text)}) ` +
        '— refusing rather than risk silently merging misfiled content into an adjacent section. Fix the CHANGELOG heading and retry.'
    );
  }

  const previousStableVersion = computePreviousStableVersion(existingTags);
  log(
    previousStableVersion
      ? `Previous stable tag: v${previousStableVersion}`
      : 'No previous stable tag found — this is the first stable release on this mirror.'
  );

  const sections = extractReleaseSections(changelogContent, previousStableVersion, version);
  if (sections.length === 0) {
    abort(
      previousStableVersion
        ? `no CHANGELOG.md section newer than the previous stable tag v${previousStableVersion} (and no newer ` +
          `than the tagged version ${version}) was found at the edge tip (${edgeRef.sha}) — nothing to release.`
        : `no CHANGELOG.md section was found at the edge tip (${edgeRef.sha}) — nothing to release.`
    );
  }
  if (!sections.some((s) => s.version === version)) {
    abort(
      `CHANGELOG.md at the edge tip (${edgeRef.sha}) has no '## [${version}]' section — the version-bump ` +
        'changelog ritual (CLAUDE.md "Version bump" / PUBLIC_RELEASE_STRATEGY.md §5) appears to have been ' +
        'skipped for this version. Refusing to tag it without a matching changelog entry.'
    );
  }
  log(`Extracted ${sections.length} section(s) for the release body: ${sections.map((s) => s.version).join(', ')}`);

  const body = renderReleaseBody(sections);
  const bodyPath = bodyOutPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-release-body-')), 'release-body.md');
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, body);
  log(`Release body written to ${bodyPath}`);

  // -------------------------------------------------------------------------
  // Everything above this line is read-only against origin (fetch) or purely
  // local reads (git show / merge-base against SHAs). Nothing has mutated
  // the clone's branches, the working tree, or the mirror. Every mutation
  // below is gated on every check above having already passed.
  // -------------------------------------------------------------------------

  log("\n=== Promoting: sync main to origin/main, fast-forward to edge, push, tag, push tag ===");
  syncLocalMainTo(cloneDir, mainRef.sha);
  mergeFastForward(cloneDir, edgeRef.sha);
  pushMain(cloneDir);
  log(`Pushed 'main' to origin at ${edgeRef.sha}.`);
  createTag(cloneDir, tagName);
  pushTag(cloneDir, tagName);
  log(`Created and pushed tag ${tagName}.`);

  // NEVER executed — see file header. This is the deliberate human
  // checkpoint the whole feature exists to preserve. Every free-form value
  // (cloneDir, bodyPath) is shell-quoted via shQuote() — security review
  // round 2, LOW finding: an unquoted path containing a space or shell
  // metacharacter produced a wrong or unsafe command when pasted. tagName is
  // already gated to a strict `\d+\.\d+\.\d+` shape (isPlainNumericVersion)
  // and quoted here too, for uniform defense-in-depth rather than relying
  // solely on that upstream gate.
  const ghCommand =
    `gh release create ${shQuote(tagName)} --title ${shQuote(tagName)} ` +
    `--notes-file ${shQuote(bodyPath)} --target main`;
  log('\n=== Next step (human checkpoint) — run this yourself; this script never executes it ===');
  log(`(cd ${shQuote(cloneDir)} && ${ghCommand})`);

  const mirrorHome = resolveMirrorHome();
  log('\n=== Closing step — refresh the adopter-facing source clone (PUBLIC_RELEASE_STRATEGY.md §2 step 6) ===');
  log(`git -C ${shQuote(mirrorHome)} pull`);

  log('\nDone.');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseMavericksVersion,
  isPlainNumericVersion,
  compareVersions,
  parseChangelogSections,
  findMalformedHeadingLines,
  findUnterminatedFenceLine,
  computePreviousStableVersion,
  extractReleaseSections,
  renderReleaseBody,
  resolveMirrorHome,
  shQuote,
};
