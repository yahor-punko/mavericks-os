#!/usr/bin/env node
// mavp-publish-build.js — one-command working-build publisher (T-501, implementing DR-006).
//
// Chains the six-step manual publish ritual (docs/PUBLIC_RELEASE_STRATEGY.md
// §2) plus the DR-006 release-train's `edge` branch into a single command:
//
//   1. assemble    (scripts/mavp-publish-assemble.js)
//   1.5. sanity-check the assembled tree (non-empty + a size floor — see
//        assertAssembledTreeNonTrivial() below; this is a hard gate too)
//   2. scan        (scripts/mavp-publish-scan.js)      <-- HARD GATE, see below
//   3. clone-or-pull the mirror clone
//   4. checkout `edge` (creating it from the mirror's `main` tip if absent)
//   5. overlay     (scripts/mavp-publish-overlay.js)
//   6. commit      (neutral public identity, docs/PUBLIC_RELEASE_STRATEGY.md
//                   §2 step 5, overridable — see PUBLISH_AUTHOR_* below).
//                   The composed commit MESSAGE is itself scanned through the
//                   same category set as the tree, before the commit exists —
//                   see assertCommitMessageScanClean() (T-523). The commit
//                   invocation is CONFIG-PINNED and its identity environment
//                   scrubbed, and the message actually recorded in the commit
//                   object is read back and compared against the string that
//                   was scanned — see stepCommit() and H2 below.
//   7. push `edge` when it is ahead of origin/edge (or origin/edge does not
//      exist yet) — see T-514 below. Always skipped under --dry-run. Every
//      commit message in the pushed RANGE is re-scanned here, immediately
//      before the push — see H1 below.
//
// T-514 — pushing an ahead `edge`, not just a THIS-run commit: step 7 used
// to push only when THIS run's own stepCommit() produced a new commit. That
// stranded working builds forever whenever a run committed (e.g. a
// --dry-run, or a run interrupted after commit but before push) and a LATER
// run found nothing new to commit (unchanged source) — two exit-0 "Done."
// runs with nothing ever published. Step 7 now instead checks whether the
// local `edge` branch is ahead of origin/edge (or origin/edge does not exist
// at all), regardless of which run produced that commit.
//
// Widening the push condition this way must not weaken the HARD GATE below
// (nothing unscanned ever reaches the mirror). The guarantee: stepCommit()
// stamps every commit IT makes with PUSH_PROVENANCE_TRAILER, and it only
// ever runs after stepScan() has already passed in that SAME execution
// (main() is still a strictly linear sequence — see below). So any commit
// carrying that trailer is guaranteed to have passed the scan gate in
// whichever run created it — a --dry-run's commit qualifies exactly as much
// as a real run's. Before pushing, stepPush() walks every commit in the
// ahead range and refuses (loudly, pushing nothing) if even one is missing
// the trailer — e.g. a commit an operator made by hand directly in the
// clone, or by any other means outside this script. This does not defend
// against someone amending an already-trailered commit's content after the
// fact (that requires the same clone-directory write access this script
// already trusts for the "clean working tree" checks elsewhere) — only
// against an untrailered commit being swept up in an ahead-range push.
//
// F1 follow-up (security review, round 1): a bare substring trailer only
// certifies the commit MESSAGE, not its TREE — `git commit --amend --no-edit`
// keeps the trailer text intact while swapping in arbitrary new content, and
// before T-514 that was inert (a run that committed nothing pushed nothing);
// after T-514 it publishes. The trailer now embeds the exact tree sha
// (`git write-tree`, captured right before the commit) and
// commitsMissingProvenance() requires each candidate commit's OWN tree (%T)
// to match the stamped value — closing amend, rebase-onto-different-content,
// and cherry-pick-with-preserved-message in one stroke, since all three
// change the tree.
//
// T-523 H1 (security review, round 2) — the message gate was per-commit AT
// CREATION TIME, but step 7 pushes an ahead RANGE (T-514). The provenance
// trailer binds to the commit's TREE, so a message-only `git commit --amend`
// leaves the tree byte-identical, keeps the trailer valid, and republishes a
// reworded — never scanned — message: the next run finds nothing staged,
// stepCommit() returns early, the creation-time gate is never invoked at all,
// and the push goes out exit 0. That route is not adversarial: this script's
// own --dry-run flow invites the operator to inspect the local commits, and
// `git commit --amend` pre-fills the existing message INCLUDING the trailer,
// so an operator rewording a subject by hand lands exactly there. Fixed by
// scanning the message of EVERY commit in the pushed range inside stepPush()
// — see commitsWithMessageFindings(). stepPush() is the only place that sees
// the message text as it will actually be transmitted, so this one gate also
// covers hand-crafted trailers and commits stranded on local `edge` by a
// version of this script that predates the message gate entirely.
//
// T-523 H2 (security review, round 2) — the string that was SCANNED was not
// necessarily the string that ends up in the commit object. `git` rewrites
// commit messages through the `prepare-commit-msg` hook, which runs EVEN WITH
// `-m`, and `core.hooksPath` from the operator's own (global) config applies
// to the mirror clone: an ordinary "append derived metadata to every commit"
// hook made a run log `Commit-message scan GREEN (3 line(s) scanned...)` and
// then publish a five-line message carrying private text, exit 0 — the run's
// own certificate measurably wrong about what shipped. `--no-verify` does NOT
// close this (it skips `pre-commit`/`commit-msg`, not `prepare-commit-msg`).
// Fixed in BOTH halves, because pinning alone only covers the vectors we
// managed to enumerate:
//   (1) the commit invocation is pinned — buildCommitConfigPins() below
//       (core.hooksPath at a guaranteed-empty dir, commit.gpgSign=false,
//       commit.cleanup=verbatim, i18n.commitEncoding=utf-8) and its
//       environment scrubbed of the six GIT_AUTHOR_*/GIT_COMMITTER_*
//       variables (buildCommitEnv()), which otherwise BEAT `-c user.name`/
//       `-c user.email`; and
//   (2) the message recorded in the commit object is read back
//       (`git log -1 --format=%B`, itself pinned — see
//       MESSAGE_READ_CONFIG_PINS) and compared to the scanned string; on ANY
//       difference the commit is undone (`git reset --soft HEAD~1`) and the
//       run aborts non-zero (T-539). That makes the run's certificate cover
//       the ARTIFACT rather than the INPUT — the same read-the-ground-truth
//       discipline the tests apply by reading published messages from the
//       mirror instead of from stdout.
//
// HARD GATES: this script must never reach step 7 (`git push`) unless:
//   (a) the assembled tree passed the size-sanity check (1.5), AND
//   (b) the secret scan in step 2 is GREEN (zero findings), AND
//   (c) the composed commit message's own scan in step 6 is GREEN — see
//       assertCommitMessageScanClean() (T-523); it runs before the commit
//       exists, so nothing unscanned is ever even committed locally, let
//       alone pushed, AND
//   (c2) the message the commit object actually RECORDS is IDENTICAL to the
//       scanned string (T-539 tightened this from "or re-scans clean" to "no
//       difference at all") — see assertCommittedMessageMatchesScanned()
//       (T-523 H2), AND
//   (c3) EVERY commit message in the range step 7 is about to push scans
//       clean, whichever run created those commits — see
//       commitsWithMessageFindings() (T-523 H1), AND
//   (d) every earlier step exited 0.
// This is the single load-bearing property of the whole script — see DR-006's
// "Consequences" section: the scan gate is the ONLY barrier between the
// private tree and the public mirror under a several-times-a-day cadence.
// Enforcement is structural, not incidental: main() below is a strictly
// linear sequence of steps that each call abort()/process.exit on error, and
// the ONLY call to `git push` is inside stepPush(), the last step in main(),
// textually and temporally after every other step has already succeeded.
//
// Why the size-sanity check (1.5) exists: an assembled tree that is empty,
// or has lost most of its expected content (e.g. an operator emptying
// publish-manifest.json's `ship` array, or reclassifying most tracked paths
// to `exclude` — both routine, non-malicious manifest edits that still pass
// `check-publish-manifest.js`'s completeness check, since every path is
// still classified exactly once), scans as GREEN (a scan over zero/few files
// trivially finds zero secrets) and would otherwise sail through to a mass
// deletion + push against the mirror. See assertAssembledTreeNonTrivial()
// below for the exact floor and its justification. A companion guard for the
// overlay script's OWN blast radius (T-504) is tracked separately since it
// touches a different file and needs its own tests — this check is the
// primary defense, gating BEFORE the mirror is ever touched.
//
// Never tags, never touches the mirror's `main` branch, never creates a
// GitHub Release — that is scripts/mavp-publish-release.js (T-502).
//
// Usage:
//   node scripts/mavp-publish-build.js <mirror-remote> <clone-dir> \
//     --private-names name1,name2,... [--dry-run] [--summary "text"] \
//     [--author-name "Name"] [--author-email "email@example.com"] \
//     [--allow-mass-delete] [--max-delete-ratio <0-1>] [--max-dir-delete-ratio <0-1>] \
//     [--max-move-credit-ratio <0-1>]
//
//   --allow-mass-delete, --max-delete-ratio, --max-dir-delete-ratio (T-507),
//   --max-move-credit-ratio (T-532/T-536) —
//                     passed through UNCHANGED to the overlay step (step 5,
//                     scripts/mavp-publish-overlay.js), which owns the actual
//                     T-504 whole-clone and T-507 per-directory deletion-ratio
//                     guards. Before this, this orchestrator had no way to
//                     forward either override flag at all, so a legitimate
//                     mass-deletion release (an intentional repo restructure)
//                     had no path through mavp-publish-build.js — only
//                     through invoking the overlay script directly, bypassing
//                     every other gate this file provides (assemble, the
//                     size floor, the scan). Omitted flags leave the overlay
//                     script's own defaults (DEFAULT_MAX_DELETE_RATIO,
//                     DIR_MAX_DELETE_RATIO) in effect, unchanged from before.
//
//   <mirror-remote>   URL (or, for fixtures/tests, a local path) of the
//                     public mirror repo to clone/pull/push.
//   <clone-dir>       Local working clone directory (persisted across runs;
//                     created via `git clone` on first use).
//   --private-names   comma-separated private repo/project names, passed
//                     through unchanged to mavp-publish-scan.js. MANDATORY —
//                     unlike mavp-publish-scan.js itself (which treats a
//                     missing list as "detection disabled" and still exits
//                     0), this orchestrator refuses to run without it: this
//                     script exists specifically to gate a private->public
//                     transition, and private-repo-name leakage into shipped
//                     files is a recurring failure in this project's history
//                     (see T-453/T-477/T-479/T-480). There is no legitimate
//                     invocation of THIS script for which skipping that
//                     detection is intentional, so it is required, not
//                     opt-out. RUNTIME-SUPPLIED ONLY — never hardcode a
//                     private name here (see .claude/rules/scripts.md —
//                     shipped test-fixture / private-name discipline; this
//                     file itself is `ship`-classified in
//                     scripts/publish-manifest.json).
//   --dry-run         run every step except the final push (step 7).
//   --summary "text"  optional one-line summary folded into the commit
//                     message ("Sync from canonical: <text>"). Defaults to
//                     the source repo's HEAD subject line. EITHER WAY the
//                     resulting message is scanned before the commit is made
//                     (T-523) — an explicit --summary is not a way around
//                     the gate, it is the remedy the gate points at when the
//                     defaulted HEAD subject is what trips it.
//   --author-name     override the public commit author name. Defaults to
//   --author-email    PUBLISH_AUTHOR_NAME/EMAIL below (this project's own
//                     neutral identity, docs/PUBLIC_RELEASE_STRATEGY.md §2
//                     step 5). Also settable via MAVP_PUBLISH_AUTHOR_NAME /
//                     MAVP_PUBLISH_AUTHOR_EMAIL env vars (argv wins over
//                     env). This file is shipped and installed verbatim into
//                     other projects (this framework's entire purpose), so a
//                     hardcoded-only identity would make every adopter's
//                     mirror publish commits authored as this project's
//                     maintainer — configurable-with-a-safe-default avoids
//                     that without changing this project's own behavior.
//
// No external dependencies — Node built-ins only (.claude/rules/scripts.md).

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ASSEMBLE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-assemble.js');
const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-scan.js');
const OVERLAY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-overlay.js');
const LOCK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-lock.js');
const VERIFY_PROVENANCE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-verify-provenance.js');

// T-506 — shared exclusive concurrency lock on the mirror clone directory.
// See scripts/mavp-publish-lock.js's own header for the full acquisition
// algorithm (liveness-probe on contention, dead-pid stale takeover,
// fail-closed on anything undecidable, NEVER a wall-clock auto-steal).
const { acquireLock } = require(LOCK_SCRIPT);

// T-534 — the content-provenance gate. See mavp-publish-verify-provenance.js's
// own header for the full threat model and the two traps it avoids (never a
// naive per-path HEAD lookup for reset destinations, never a live on-disk
// read). Required here (not spawned as a subprocess) the same way
// acquireLock() above is, so stepVerifyProvenance() below can act on its
// structured { ok, path, reason } return value directly.
//
// T-534 round 2 — verifyCommittedTreeProvenance certifies the CLONE's own
// committed tree (step 6.6, see its own comment below) — the MEDIUM this
// round closes structurally: assembled-tree certification alone never sees
// what the clone's own `git add`/`commit` actually produced.
//
// T-534 round 4 — readTreeMode/isGitIgnoredInClone/resolveManifestBuckets are
// reused (never re-implemented) by stepCommit()'s mode-binding pass below,
// which sources every ship/reset path's expected mode git-to-git the same
// way step 6.6 already does.
//
// T-534 round 5 — isPathInIndex is the mode-binding pass's own re-keyed
// presence predicate (see bindStagedFileModesToHeadOrAbort()'s call site
// comment): the gitignored-reset skip fires only when a destination is BOTH
// absent from the post-`git add -A` index AND ignore-matched, never on the
// ignore match alone.
const {
  verifyAssembledTreeProvenance,
  verifyCommittedTreeProvenance,
  readTreeMode,
  isGitIgnoredInClone,
  isPathInIndex,
  resolveManifestBuckets,
} = require(VERIFY_PROVENANCE_SCRIPT);

// Shared private-names parsing (T-511) and shared detection machinery
// (T-523) — requiring the scanner module here does NOT execute it:
// mavp-publish-scan.js guards its main() behind a `require.main === module`
// check (T-505), so this require() only pulls in the exported helpers below,
// never runs a scan, never touches the filesystem, and never exits. See
// parsePrivateNamesList's own comment in mavp-publish-scan.js for why this is
// the single source of truth for the split/trim/filter rule shared by this
// gate and the scanner's own detection.
//
// buildCategories + scanTextAgainstCategories are the very same two pieces
// the scanner's own CLI uses on the assembled tree (see mavp-publish-scan.js
// main()), so the commit-message gate below detects exactly what the tree
// scan detects — one category definition, one text-scanning implementation,
// and no temp file needed to scan a string.
const { parsePrivateNamesList, buildCategories, scanTextAgainstCategories } = require(SCAN_SCRIPT);

// Neutral public commit identity — docs/PUBLIC_RELEASE_STRATEGY.md §2 step 5.
// This is the maintainer's real, already-public OSS contact address (also
// explicitly allow-listed in mavp-publish-scan.js's EMAIL_ALLOWLIST) — not a
// personal account email, and not a private name. These are DEFAULTS only —
// overridable via --author-name/--author-email or MAVP_PUBLISH_AUTHOR_*
// (see file header) so an adopter installing this file verbatim does not
// silently publish commits authored as this project's maintainer.
const PUBLISH_AUTHOR_NAME = 'Yahor Punko';
const PUBLISH_AUTHOR_EMAIL = 'yahorpunko@gmail.com';

// T-514 — provenance marker stamped into every commit stepCommit() makes,
// folded into the commit message body as a trailer-shaped line. Its presence
// is the only thing distinguishing "this commit passed the scan gate in some
// run of this script" from "this commit landed on local edge some other
// way" (hand-committed by an operator poking at the clone, or produced by a
// different tool entirely). See stepPush()/commitsMissingProvenance() below.
//
// F1: this fixed string is only the marker PREFIX. Each stamped commit
// appends " tree=<sha>" (see buildProvenanceTrailerLine()/stepCommit()) —
// the exact tree the commit carries at commit time, per `git write-tree`.
// Binding to the tree (not just the message) is what makes the check
// resistant to `--amend`: an amend that changes content but keeps the
// message intact also changes the tree, so the stamped sha stops matching
// the commit's own %T.
const PUSH_PROVENANCE_TRAILER = 'X-Mavp-Publish-Build: scanned-and-committed-by-this-script';

function buildProvenanceTrailerLine(treeSha) {
  return `${PUSH_PROVENANCE_TRAILER} tree=${treeSha}`;
}

// Matches PUSH_PROVENANCE_TRAILER exactly (escaped — it's a fixed literal,
// not meant to be a regex source) followed by " tree=<40-hex-char-sha>".
const PROVENANCE_TRAILER_RE = new RegExp(
  `${PUSH_PROVENANCE_TRAILER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tree=([0-9a-f]{40})`
);

// Returns the tree sha stamped in a commit message body, or null if the
// trailer is absent or malformed (no 40-hex-char sha immediately after it).
function parseProvenanceTreeSha(body) {
  const match = PROVENANCE_TRAILER_RE.exec(body);
  return match ? match[1] : null;
}

// Minimum fraction of the source repo's total git-tracked file count that
// the assembled tree must contain. Derived INDEPENDENTLY of
// publish-manifest.json's own self-reported completeness (comparing against
// the manifest would offer no protection against the exact attack this
// guards — an operator editing the manifest itself), by comparing against
// `git ls-files` at REPO_ROOT instead. This repo currently ships ~90% of its
// tracked paths (ship + reset vs. total tracked), so 0.5 leaves a wide
// margin against false positives from legitimate manifest evolution while
// still catching "most of the ship set got lost" (e.g. an emptied or
// near-emptied `ship` array), not just the total-wipeout case a bare
// non-zero check would catch.
const ASSEMBLED_TREE_MIN_RATIO = 0.5;

function log(message) {
  console.log(message);
}

// Cleanup registered once the temp assembled-tree dir exists. Using
// process.on('exit') rather than a try/finally around main()'s body is
// deliberate: `finally` blocks do NOT run when `process.exit()` is called
// from inside the try block (Node's documented behavior — process.exit()
// terminates immediately), so a try/finally here would silently leave the
// assembled tree behind on every abort() path — including the scan-failure
// path, where that leftover tree is by definition the exact content that
// tripped the scanner. The 'exit' event, by contrast, fires synchronously as
// part of the actual process shutdown sequence, so it runs after
// process.exit(0) (success) AND after process.exit(1) (any abort()).
let tempOutDirForCleanup = null;
// T-523 H2 — the guaranteed-empty directory core.hooksPath is pinned at for
// the commit invocation (see createEmptyHooksDir()); cleaned up on the same
// 'exit' path, for the same reason.
let emptyHooksDirForCleanup = null;
// T-506 — the sibling <clone-dir>.lock directory this run acquired (see
// stepAcquireLock() below), released on the same 'exit' path so it comes
// down on EVERY exit path — success, any abort(), and (via the SIGINT/
// SIGTERM handlers immediately below, which route through process.exit())
// an operator interrupt mid-run. Set only once acquireLock() has actually
// succeeded — never before — so a failed/contended acquisition never
// mistakenly tries to release a lock this run never held.
//
// T-506 round 2, criterion 3 — this calls the GUARDED release() closure
// acquireLock() returned, never an inline fs.rmSync(lockPath, ...). An
// inline removal here would bypass the token check entirely — releasing
// (i.e. destroying) whatever currently sits at this lock path even if it is
// no longer the instance THIS run acquired, which is exactly the load-
// bearing gap round 2's security review found: fixing the lock module alone
// would have fixed nothing at the one destruction site that actually runs.
let lockReleaseForCleanup = null;
process.on('exit', () => {
  if (tempOutDirForCleanup) {
    fs.rmSync(tempOutDirForCleanup, { recursive: true, force: true });
  }
  if (emptyHooksDirForCleanup) {
    fs.rmSync(emptyHooksDirForCleanup, { recursive: true, force: true });
  }
  if (lockReleaseForCleanup) {
    lockReleaseForCleanup();
  }
});

// T-506 — without these, a bare SIGINT/SIGTERM (Ctrl-C, or an orchestrator
// stopping the run) terminates the process without necessarily running the
// 'exit' handler above in every Node version/platform combination. Routing
// both signals through process.exit() makes lock (and the other scratch-dir)
// cleanup unconditional on an operator-initiated interrupt — only an
// unblockable SIGKILL can still strand the lock, which the next run's
// dead-pid detection then recovers from (see mavp-publish-lock.js).
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function abort(message) {
  console.error(`\nABORT: ${message}`);
  console.error('ABORT: no push has occurred.');
  process.exit(1);
}

function runInherit(command, args, opts) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...opts });
  if (result.error) {
    return { ok: false, status: -1, error: result.error };
  }
  return { ok: result.status === 0, status: result.status };
}

function gitCapture(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8' });
    return { ok: true, stdout: out };
  } catch (err) {
    return { ok: false, stdout: err.stdout || '', stderr: err.stderr || '', error: err };
  }
}

// `extraOpts` (T-523 H2) lets a single call site hand spawnSync an explicit
// `env` — used only by the commit invocation, which must not inherit the
// GIT_AUTHOR_*/GIT_COMMITTER_* variables (they beat `-c user.name`/`-c
// user.email`). Every other call site passes nothing and keeps inheriting
// process.env unchanged.
function gitRunInherit(cwd, args, description, extraOpts) {
  const result = runInherit('git', args, { cwd, ...(extraOpts || {}) });
  if (!result.ok) {
    abort(`${description} failed (git ${args.join(' ')}) in ${cwd}`);
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  let privateNames = null;
  let dryRun = false;
  let summary = null;
  let authorName = null;
  let authorEmail = null;
  let allowMassDelete = false;
  let maxDeleteRatio = null;
  let maxDirDeleteRatio = null;
  let maxMoveCreditRatio = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--private-names') {
      privateNames = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--private-names=')) {
      privateNames = arg.slice('--private-names='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--summary') {
      summary = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--summary=')) {
      summary = arg.slice('--summary='.length);
    } else if (arg === '--author-name') {
      authorName = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--author-name=')) {
      authorName = arg.slice('--author-name='.length);
    } else if (arg === '--author-email') {
      authorEmail = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--author-email=')) {
      authorEmail = arg.slice('--author-email='.length);
    } else if (arg === '--allow-mass-delete') {
      allowMassDelete = true;
    } else if (arg === '--max-delete-ratio') {
      maxDeleteRatio = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--max-delete-ratio=')) {
      maxDeleteRatio = arg.slice('--max-delete-ratio='.length);
    } else if (arg === '--max-dir-delete-ratio') {
      maxDirDeleteRatio = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--max-dir-delete-ratio=')) {
      maxDirDeleteRatio = arg.slice('--max-dir-delete-ratio='.length);
    } else if (arg === '--max-move-credit-ratio') {
      maxMoveCreditRatio = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--max-move-credit-ratio=')) {
      maxMoveCreditRatio = arg.slice('--max-move-credit-ratio='.length);
    } else {
      positional.push(arg);
    }
  }

  return {
    mirrorRemote: positional[0],
    cloneDir: positional[1],
    privateNames,
    dryRun,
    summary,
    authorName,
    authorEmail,
    allowMassDelete,
    maxDeleteRatio,
    maxDirDeleteRatio,
    maxMoveCreditRatio,
  };
}

function printUsage() {
  console.error(
    'Usage: node scripts/mavp-publish-build.js <mirror-remote> <clone-dir> ' +
      '--private-names name1,name2,... [--dry-run] [--summary "text"] ' +
      '[--author-name "Name"] [--author-email "email@example.com"] ' +
      '[--allow-mass-delete] [--max-delete-ratio <0-1>] [--max-dir-delete-ratio <0-1>] ' +
      '[--max-move-credit-ratio <0-1>]\n' +
      '\n' +
      "  --private-names is MANDATORY (no opt-out) — see the file header comment.\n" +
      '  --allow-mass-delete, --max-delete-ratio, --max-dir-delete-ratio, --max-move-credit-ratio\n' +
      '  are passed through unchanged to the overlay step (scripts/mavp-publish-overlay.js) —\n' +
      '  see T-507/T-532; omitted flags leave the overlay script\'s own defaults in effect.'
  );
}

// Resolves the public commit identity: --author-name/--author-email argv
// wins, then MAVP_PUBLISH_AUTHOR_NAME/EMAIL env vars, then the project's own
// neutral default (PUBLISH_AUTHOR_NAME/EMAIL above).
function resolveAuthorIdentity(argvName, argvEmail) {
  const name = argvName || process.env.MAVP_PUBLISH_AUTHOR_NAME || PUBLISH_AUTHOR_NAME;
  const email = argvEmail || process.env.MAVP_PUBLISH_AUTHOR_EMAIL || PUBLISH_AUTHOR_EMAIL;
  return { name, email };
}

// ---------------------------------------------------------------------------
// Step 0 (preflight) — refuse on an unclean source repo. Publishing a tree
// that does not correspond to any single commit makes the resulting public
// build unreproducible (which exact source state produced it would be
// unanswerable from git history alone), so this script requires a clean
// working tree in the private canonical repo before it does anything else.
// ---------------------------------------------------------------------------

function assertCleanSourceRepo() {
  const status = gitCapture(REPO_ROOT, ['status', '--porcelain']);
  if (!status.ok) {
    abort(`could not read git status of source repo at ${REPO_ROOT}`);
  }
  if (status.stdout.trim().length > 0) {
    console.error('\nDirty source repo (uncommitted changes):');
    console.error(status.stdout);
    abort(
      `${REPO_ROOT} has uncommitted changes — commit or stash them first. ` +
        'Publishing a tree that does not match any commit makes the build unreproducible.'
    );
  }
}

// ---------------------------------------------------------------------------
// Step 1 — assemble
// ---------------------------------------------------------------------------

function stepAssemble(outDir) {
  log(`\n=== Step 1/7: assemble (${ASSEMBLE_SCRIPT} ${outDir}) ===`);
  const result = runInherit(process.execPath, [ASSEMBLE_SCRIPT, outDir], { cwd: REPO_ROOT });
  if (!result.ok) {
    abort('assemble step failed — see output above.');
  }
}

// ---------------------------------------------------------------------------
// Step 1.5 — assembled-tree size sanity check (hard gate, see file header)
// ---------------------------------------------------------------------------

function countFilesRecursive(dir) {
  let count = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink() || entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return count;
}

function assertAssembledTreeNonTrivial(outDir) {
  log('\n=== Step 1.5/7: assembled-tree size sanity check (hard gate) ===');
  const fileCount = countFilesRecursive(outDir);

  if (fileCount === 0) {
    abort(
      `assembled tree at ${outDir} is completely empty — refusing to scan/publish nothing as if ` +
        'it were a real build.'
    );
  }

  // Fail CLOSED, not open, when the denominator itself cannot be computed.
  // A prior version warned and fell back to the non-empty check only here —
  // that is the wrong direction: this is a HARD GATE (see file header), and
  // silently downgrading it at exactly the moment `git` is unreliable (e.g.
  // a concurrent invocation contending on .git/index.lock — see the
  // concurrency note in this task's evidence) removes the one check that
  // exists to catch large-scale ship-set loss, right when something is
  // already going wrong. A gate that cannot measure must stop the run, not
  // quietly become a weaker gate.
  const trackedResult = gitCapture(REPO_ROOT, ['ls-files']);
  if (!trackedResult.ok) {
    abort(
      `could not compute the git-tracked file count at ${REPO_ROOT} (git ls-files failed: ` +
        `${trackedResult.stderr || trackedResult.stdout || 'no output'}) — the size-floor check has no ` +
        'denominator to compare against. Refusing to scan/publish rather than silently skipping the floor.'
    );
  }

  const trackedCount = trackedResult.stdout.split('\n').filter(Boolean).length;
  if (trackedCount === 0) {
    log('Source repo reports 0 tracked files — skipping the ratio floor (nothing to compare against).');
    return;
  }

  const floor = Math.ceil(trackedCount * ASSEMBLED_TREE_MIN_RATIO);
  if (fileCount < floor) {
    abort(
      `assembled tree has only ${fileCount} file(s), below the ${floor}-file floor derived from ` +
        `${trackedCount} git-tracked path(s) at HEAD (ratio ${ASSEMBLED_TREE_MIN_RATIO}). This looks ` +
        "like most of the manifest's ship set was lost (e.g. reclassified to 'exclude'), not a " +
        'legitimate build — refusing to scan/publish.'
    );
  }

  log(`Assembled tree has ${fileCount} file(s) (>= ${floor}-file floor from ${trackedCount} tracked). Proceeding.`);
}

// ---------------------------------------------------------------------------
// Step 2 — scan (the hard gate)
// ---------------------------------------------------------------------------

function stepScan(outDir, privateNames) {
  log(`\n=== Step 2/7: secret scan (${SCAN_SCRIPT} ${outDir}) — HARD GATE ===`);
  const args = [SCAN_SCRIPT, outDir, '--private-names', privateNames];
  const result = runInherit(process.execPath, args, { cwd: REPO_ROOT });
  if (!result.ok) {
    abort(
      'secret scan reported findings (see output above) — refusing to proceed. ' +
        'This is the only barrier between the private tree and the public mirror; it never yields.'
    );
  }
  log('Scan GREEN — proceeding.');
}

// ---------------------------------------------------------------------------
// Step 2.5 — acquire the exclusive clone-directory lock (T-506)
// ---------------------------------------------------------------------------
//
// Acquired AFTER the scan gate (step 2) passes and IMMEDIATELY BEFORE the
// first clone-directed git operation (stepCloneOrPull, step 3) — nothing
// between this call and stepCloneOrPull() touches <clone-dir>. Held through
// stepPush() (step 7): release happens only via the process.on('exit')
// handler above (or the SIGINT/SIGTERM handlers routing into it), never
// explicitly mid-run, so a --dry-run run is covered exactly like a real one
// — --dry-run still writes into the clone (checkout/overlay/commit), it just
// never reaches step 7's push.
//
// Source-repo reads (assemble/scan against REPO_ROOT, both already done by
// this point) and the mirror's remote itself need no lock of their own — see
// scripts/mavp-publish-lock.js's file header for why (the former never
// touches the clone directory; the latter is already protected by git's own
// fast-forward-only push).
function stepAcquireLock(cloneDir) {
  log(`\n=== Step 2.5/7: acquire publish lock for ${cloneDir} ===`);
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

// ---------------------------------------------------------------------------
// Step 3 — clone-or-pull the mirror
// ---------------------------------------------------------------------------

function isLocalPath(remote) {
  return !remote.includes('://') && !remote.includes('@');
}

function normalizeRemoteForCompare(remote) {
  if (isLocalPath(remote)) return path.resolve(remote);
  return remote;
}

function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  const result = gitCapture(dir, ['rev-parse', '--git-dir']);
  return result.ok;
}

function stepCloneOrPull(mirrorRemote, cloneDir) {
  log(`\n=== Step 3/7: clone-or-pull mirror (${mirrorRemote} -> ${cloneDir}) ===`);

  if (!isGitRepo(cloneDir)) {
    log(`No existing clone at ${cloneDir} — cloning fresh.`);
    fs.mkdirSync(path.dirname(path.resolve(cloneDir)), { recursive: true });
    gitRunInherit(REPO_ROOT, ['clone', mirrorRemote, cloneDir], 'clone');
    return;
  }

  log(`Existing clone found at ${cloneDir} — verifying before reuse.`);

  // Refuse (never reset) on an unexpected remote — this clone dir may not
  // even point at the mirror we were asked to publish to.
  const originUrlResult = gitCapture(cloneDir, ['remote', 'get-url', 'origin']);
  if (!originUrlResult.ok) {
    abort(`existing clone at ${cloneDir} has no 'origin' remote configured — refusing to reuse it.`);
  }
  const actualOrigin = originUrlResult.stdout.trim();
  if (normalizeRemoteForCompare(actualOrigin) !== normalizeRemoteForCompare(mirrorRemote)) {
    abort(
      `existing clone at ${cloneDir} has origin '${actualOrigin}', which does not match the ` +
        `requested mirror '${mirrorRemote}' — refusing to reuse a clone pointed at a different remote.`
    );
  }

  // Refuse (never reset) on a dirty working tree — resetting a human's
  // in-progress local state in a script that runs unattended several times a
  // day is exactly the kind of destructive surprise this must not do.
  const status = gitCapture(cloneDir, ['status', '--porcelain']);
  if (!status.ok) {
    abort(`could not read git status of clone at ${cloneDir}`);
  }
  if (status.stdout.trim().length > 0) {
    console.error('\nDirty mirror clone (uncommitted changes):');
    console.error(status.stdout);
    abort(
      `${cloneDir} has local uncommitted changes — refusing to touch it. ` +
        'Inspect and clean it manually, or point <clone-dir> at a fresh path.'
    );
  }

  gitRunInherit(cloneDir, ['fetch', 'origin', '--prune'], 'fetch');
}

// ---------------------------------------------------------------------------
// Step 4 — checkout `edge` (creating it from `main`'s tip when absent)
// ---------------------------------------------------------------------------

function refExists(cloneDir, ref) {
  const result = gitCapture(cloneDir, ['show-ref', '--verify', '--quiet', ref]);
  return result.ok;
}

function stepCheckoutEdge(cloneDir) {
  log("\n=== Step 4/7: checkout 'edge' ===");

  const hasLocalEdge = refExists(cloneDir, 'refs/heads/edge');
  const hasRemoteEdge = refExists(cloneDir, 'refs/remotes/origin/edge');
  const hasRemoteMain = refExists(cloneDir, 'refs/remotes/origin/main');

  if (hasLocalEdge) {
    gitRunInherit(cloneDir, ['checkout', 'edge'], "checkout local 'edge'");
    if (hasRemoteEdge) {
      const ffResult = gitCapture(cloneDir, ['merge', '--ff-only', 'origin/edge']);
      if (!ffResult.ok) {
        console.error(ffResult.stderr || ffResult.stdout || '');
        abort(
          `local 'edge' in ${cloneDir} has diverged from origin/edge — refusing to auto-resolve ` +
            '(never force-pushed, never reset). Inspect and resolve manually.'
        );
      }
    }
    return;
  }

  if (hasRemoteEdge) {
    log("Remote 'edge' exists — creating local tracking branch.");
    gitRunInherit(cloneDir, ['checkout', '-b', 'edge', 'origin/edge'], "checkout new 'edge' from origin/edge");
    return;
  }

  // No `edge` anywhere yet — this is the release-train's first-ever working
  // build. Per DR-006 and the T-501 acceptance criteria, `edge` is created
  // automatically from the mirror's `main` tip: this act is only LOCAL to
  // the clone at this point (nothing is visible on the public remote until
  // the push in step 7, which is itself gated on a clean scan), so there is
  // no unreviewed public side effect from doing this without a separate
  // flag. Requiring an extra flag here would just be a checklist step a
  // human can forget under the very time pressure DR-006 is trying to
  // remove.
  if (!hasRemoteMain) {
    abort(`mirror at origin has neither 'edge' nor 'main' — cannot bootstrap 'edge' from a tip that does not exist.`);
  }
  log("No 'edge' branch found anywhere — creating it from the mirror's 'main' tip (origin/main).");
  gitRunInherit(cloneDir, ['checkout', '-b', 'edge', 'origin/main'], "checkout new 'edge' from origin/main");
}

// ---------------------------------------------------------------------------
// Step 5 — overlay
// ---------------------------------------------------------------------------

// T-507/T-536 — builds the extra overlay CLI args from this script's own
// --allow-mass-delete/--max-delete-ratio/--max-dir-delete-ratio/
// --max-move-credit-ratio flags, so they reach the overlay's T-504/T-507/
// T-532 guards unchanged. A flag left unset here (null) is simply omitted —
// the overlay script falls back to its own documented defaults, exactly as
// if this pass-through did not exist. T-536 closes the gap where the only
// way to stand down the T-532 whole-run move-credit cap through this
// orchestrator was --allow-mass-delete, which also drops the full-wipe rule
// that must never be laundered — --max-move-credit-ratio is its own,
// narrowly-scoped stand-down, exactly like the two ratio flags above it.
function buildOverlayOverrideArgs({ allowMassDelete, maxDeleteRatio, maxDirDeleteRatio, maxMoveCreditRatio }) {
  const args = [];
  if (allowMassDelete) args.push('--allow-mass-delete');
  if (maxDeleteRatio !== null && maxDeleteRatio !== undefined) {
    args.push('--max-delete-ratio', String(maxDeleteRatio));
  }
  if (maxDirDeleteRatio !== null && maxDirDeleteRatio !== undefined) {
    args.push('--max-dir-delete-ratio', String(maxDirDeleteRatio));
  }
  if (maxMoveCreditRatio !== null && maxMoveCreditRatio !== undefined) {
    args.push('--max-move-credit-ratio', String(maxMoveCreditRatio));
  }
  return args;
}

function stepOverlay(outDir, cloneDir, overlayOverrides) {
  const extraArgs = buildOverlayOverrideArgs(overlayOverrides || {});
  log(
    `\n=== Step 5/7: overlay (${OVERLAY_SCRIPT} ${outDir} ${cloneDir}` +
      `${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}) ===`
  );
  const result = runInherit(process.execPath, [OVERLAY_SCRIPT, outDir, cloneDir, ...extraArgs], { cwd: REPO_ROOT });
  if (!result.ok) {
    abort('overlay step failed — see output above.');
  }
}

// ---------------------------------------------------------------------------
// Step 6 — commit (neutral, overridable identity)
// ---------------------------------------------------------------------------

function resolveSummary(explicitSummary) {
  if (explicitSummary) return explicitSummary;
  // T-539: pinned — this subject line is an INPUT to the composed (and
  // published) commit message, so it must be read as UTF-8 regardless of the
  // machine's i18n.logOutputEncoding/i18n.commitEncoding.
  const subjectResult = gitCapture(REPO_ROOT, [...MESSAGE_READ_CONFIG_PINS, 'log', '-1', '--pretty=%s']);
  const subject = subjectResult.ok ? subjectResult.stdout.trim() : '';
  const hashResult = gitCapture(REPO_ROOT, ['rev-parse', '--short', 'HEAD']);
  const hash = hashResult.ok ? hashResult.stdout.trim() : 'unknown';
  return subject ? `${subject} (${hash})` : `working build (${hash})`;
}

// ---------------------------------------------------------------------------
// Step 6's own hard gate (T-523) — the commit MESSAGE is a publication
// channel, exactly like file content is
// ---------------------------------------------------------------------------
//
// Step 2 scans the assembled TREE. The commit message that ships alongside it
// was never scanned by anything: it is composed here out of either the
// private repo's own HEAD subject line (the default — arbitrary private text,
// e.g. a subject naming a private repo, an internal hostname or an absolute
// home-directory path) or an operator-supplied --summary. BOTH inputs land in
// the same published field, so making --summary mandatory would not have
// closed the channel — the message itself has to go through the gate,
// whichever input produced it.
//
// What is scanned: the FULL composed message — subject line, blank separator,
// and the T-514 provenance trailer — not just the summary the operator sees.
// The trailer is derived (a fixed marker plus `git write-tree`'s output), so
// it is not an operator-controlled channel, but it is published text and it
// costs nothing to include; scanning the whole string is also the only shape
// that cannot silently stop covering a line someone appends to the message
// later.
//
// DELIBERATELY EXCLUDED — the commit author identity (author.name /
// author.email; see resolveAuthorIdentity()). Recording the rationale rather
// than leaving the omission as silence: that identity is not derived from
// private repo content at all (it is either this file's neutral default or an
// explicit operator override), and this project's own default IS a
// deliberately-published OSS contact address — one the scanner's email
// category matches and its EMAIL_ALLOWLIST then has to except by name. So
// feeding identity through this gate would block a value whose entire purpose
// is to be public, and would depend on an allow-list entry to unblock it,
// while adding no coverage: an operator passing --author-email is declaring a
// publication intent about their own identity, not leaking text derived from
// the private tree. Only the message is scanned here.

// The `filePath` slot scanTextAgainstCategories() reports findings against.
// The message never touches disk, so this is a label, not a path — and it is
// deliberately free of anything the scanner itself could match.
const COMMIT_MESSAGE_SCAN_LABEL = '<composed mirror commit message>';

// Pure: returns the findings for `message`, never logs, never exits. Scans
// EVERY line (subject, blank separator, trailer) — the body of a commit
// message is published to the mirror exactly like its subject is, so a
// subject-only scan would leave the rest of the channel open.
// `privateNames` is the run's own parsed --private-names array (mandatory for
// this script — see main()'s gate), so the private-name category is always
// active here, built from the run's value rather than any hardcoded list.
function scanCommitMessageForFindings(message, privateNames) {
  const categories = buildCategories(privateNames);
  const findings = [];
  const lines = String(message).split('\n');
  for (let i = 0; i < lines.length; i++) {
    scanTextAgainstCategories(COMMIT_MESSAGE_SCAN_LABEL, i + 1, lines[i], findings, categories);
  }
  return findings;
}

// HARD GATE. Call site is the statement immediately before the `git commit`
// invocation in stepCommit() below, with nothing in between — so when this
// aborts, no commit exists: nothing is stranded on local `edge` for a later
// run's ahead-range push (T-514) to pick up, and nothing reaches the mirror.
//
// Only the (already redacted) findings are printed, never the message itself:
// echoing the offending text would make this gate's own output a second leak
// path, the same reason mavp-publish-scan.js redacts long matches.
function assertCommitMessageScanClean(message, privateNames) {
  const findings = scanCommitMessageForFindings(message, privateNames);
  const lineCount = String(message).split('\n').length;

  if (findings.length === 0) {
    log(`Commit-message scan GREEN (${lineCount} line(s) scanned, same categories as the tree) — proceeding to commit.`);
    return;
  }

  console.error(`\nFOUND ${findings.length} finding(s) in the composed mirror commit message:\n`);
  for (const f of findings) {
    console.error(`  [${f.category}] message line ${f.line}  ${f.match}`);
  }
  abort(
    'the composed mirror commit message tripped the secret scan (finding(s) above) — refusing to ' +
      'commit it. A commit message is published to the mirror exactly like file content is, so it goes ' +
      'through the same gate as the assembled tree. Re-run with an explicit, clean --summary "text": the ' +
      "default summary is the private repo's own HEAD subject line, which is the usual source of an " +
      'unscanned private reference here. No commit was created. NOTE BEFORE RE-RUNNING: the overlay step ' +
      'already wrote the assembled tree into the mirror clone before this gate ran, so that clone is now ' +
      'DIRTY and the next run will refuse to reuse it (this script never resets a clone it did not dirty ' +
      'by commit). Clean the clone yourself (inspect it first, then discard those working-tree changes) ' +
      'or point <clone-dir> at a fresh path for the corrective run.'
  );
}

// ---------------------------------------------------------------------------
// T-523 H2 — pinning the commit invocation, and verifying the message the
// commit object actually RECORDS
// ---------------------------------------------------------------------------

// Config pinned on the commit invocation itself (`git -c ...`), so the
// recorded commit is a property of THIS command rather than of the operator's
// git config — the same discipline T-520 applied to the push line, one step
// earlier:
//   core.hooksPath=<empty dir>  `prepare-commit-msg` runs EVEN WITH `-m` and
//                     can rewrite the message that was just scanned;
//                     `core.hooksPath` from the operator's global config
//                     applies to the mirror clone. `--no-verify` does NOT
//                     close this (it skips `pre-commit`/`commit-msg` only) —
//                     pointing core.hooksPath at a directory containing no
//                     hooks does. Verified to beat both the clone's own
//                     config and the higher-precedence GIT_CONFIG_COUNT
//                     environment form.
//   commit.gpgSign=false
//                     a globally configured signing key otherwise embeds the
//                     operator's real key UID in the public commit object,
//                     which no author override suppresses.
//   commit.cleanup=verbatim
//                     keeps git from rewriting the scanned string (whitespace
//                     cleanup / comment stripping), so the read-back check
//                     below compares like with like instead of tolerating a
//                     class of "expected" rewrites.
//   i18n.commitEncoding=utf-8
//                     (T-539) an operator with a legacy `i18n.commitEncoding`
//                     — an ordinary setting, not an attack — makes git stamp
//                     an `encoding <that value>` header onto the commit
//                     object, echoing the operator's own config into the
//                     public commit and MISLABELLING the message bytes (git
//                     does NOT transcode a `-m` value; it only declares the
//                     encoding). Every later reader that asks for a different
//                     output encoding then re-interprets those bytes, so the
//                     mislabel is a real corruption of the published message,
//                     not a cosmetic header. Pinning utf-8 makes git omit the
//                     header entirely and keeps the recorded bytes the UTF-8
//                     of the composed string.
// The `-c` values are placed BEFORE the `commit` subcommand (the only position
// git accepts) and before the identity pins, which stay where they were.
function buildCommitConfigPins(emptyHooksDir) {
  return [
    '-c',
    `core.hooksPath=${emptyHooksDir}`,
    '-c',
    'commit.gpgSign=false',
    '-c',
    'commit.cleanup=verbatim',
    '-c',
    'i18n.commitEncoding=utf-8',
  ];
}

// T-539 — the read side of the same class. `git log`/`git show` re-encode a
// commit message from the commit's declared encoding to
// `i18n.logOutputEncoding` (which DEFAULTS to `i18n.commitEncoding`, itself
// defaulting to UTF-8). So an operator global for either key silently turns
// every message this script reads into non-UTF-8 bytes, which Node then
// decodes as UTF-8 — mojibake. That corrupts three things at once: the default
// `--summary` read from the private repo's HEAD subject (an INPUT to the
// composed message), the range scan's per-commit message reads (a GATE), and
// the read-back comparison (which would then report a mismatch for an entirely
// benign reason on any non-ASCII message). Pinned on every one of those reads
// so the bytes this script compares and scans are always UTF-8, whatever the
// machine is configured for. `-c` outranks both the repo-local and the global
// config form (verified for `core.hooksPath` in this file's own tests).
const MESSAGE_READ_CONFIG_PINS = ['-c', 'i18n.logOutputEncoding=utf-8'];

// Creates the guaranteed-empty directory core.hooksPath is pinned at, and
// fails closed if it is somehow not empty — a hooks dir that turned out to
// contain a hook would silently re-open exactly the vector this closes.
function createEmptyHooksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-publish-nohooks-'));
  emptyHooksDirForCleanup = dir;
  const entries = fs.readdirSync(dir);
  if (entries.length !== 0) {
    abort(
      `the hooks-free directory created for the commit invocation (${dir}) is not empty ` +
        `(${entries.join(', ')}) — refusing to commit with a core.hooksPath that could still run a ` +
        'message-rewriting hook.'
    );
  }
  return dir;
}

// The six identity variables that OUTRANK `-c user.name`/`-c user.email`:
// GIT_AUTHOR_* and GIT_COMMITTER_* (NAME/EMAIL/DATE). With any of them
// exported, the neutral-public-identity guarantee in
// docs/PUBLIC_RELEASE_STRATEGY.md §2 step 5 silently failed — the commit
// recorded the environment's identity instead. NAME/EMAIL are OVERRIDDEN with
// the resolved identity (belt and braces with the `-c` pins, and authoritative
// because env wins); the two DATE variables are DELETED, so the commit is
// timestamped now rather than at whatever moment an inherited GIT_*_DATE
// names. Nothing else in the environment is touched.
const SCRUBBED_COMMIT_ENV_VARS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
];

function buildCommitEnv(author, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  for (const name of SCRUBBED_COMMIT_ENV_VARS) {
    delete env[name];
  }
  env.GIT_AUTHOR_NAME = author.name;
  env.GIT_AUTHOR_EMAIL = author.email;
  env.GIT_COMMITTER_NAME = author.name;
  env.GIT_COMMITTER_EMAIL = author.email;
  return env;
}

// `git log -1 --format=%B` appends a separator newline of its own, and
// `commit.cleanup=verbatim` preserves whatever trailing newlines the message
// had — so trailing newlines carry no information here and are normalized
// away on BOTH sides. NOTHING ELSE is normalized, and that is load-bearing
// rather than incidental (T-539): an appended LINE — the whole point of the
// vector this guards — survives, and so does every other difference the
// read-back must now refuse. Widening this to collapse internal whitespace,
// blank lines or leading whitespace would silently re-open a rewrite channel
// through the comparison itself, which is why it carries a direct unit test of
// its own instead of being pinned only through the end-to-end read-back case.
function normalizeMessageForCompare(message) {
  return String(message).replace(/\n+$/, '');
}

// The general closure (T-523 H2, half 2). Pinning only covers the vectors we
// enumerated; this compares the ARTIFACT against the INPUT, so any rewriting
// mechanism — a hook the pin missed, a `git` wrapper earlier on PATH, a future
// config knob — is caught by its effect rather than by name.
//
// T-539 — FAIL CLOSED ON ANY DIFFERENCE. This used to refuse only when the
// RECORDED text itself tripped the scan, and to WARN-and-continue when it
// re-scanned clean. That fail-open published a string the run's own
// certificate never covered, which is the same "the certificate describes
// something adjacent to what shipped" class this file has already closed three
// times. And there is no benign cause left for a difference: the commit
// invocation pins a hooks-free core.hooksPath, commit.cleanup=verbatim and
// i18n.commitEncoding=utf-8; this read pins i18n.logOutputEncoding=utf-8; the
// `-c` form outranks GIT_CONFIG_PARAMETERS/GIT_CONFIG_COUNT as well as the
// repo-local and global files; and trailing newlines are normalized away on
// BOTH sides. So a difference now means an unidentified rewriting mechanism is
// live INSIDE the publish pipeline — precisely the moment this script must not
// write to the mirror.
//
// The re-scan is kept, as DIAGNOSTICS only: it tells the operator whether the
// recorded text ALSO leaks something (a leak plus a rewriter) or is merely
// different (a rewriter alone). Both branches undo the commit
// (`git reset --soft HEAD~1`, which touches history only — the working tree and
// index keep the overlay's staged content exactly as they were) and abort
// non-zero, so nothing unscanned is left on local `edge` for a later run's
// ahead-range push either way.
function assertCommittedMessageMatchesScanned(cloneDir, scannedMessage, privateNames) {
  const readBack = gitCapture(cloneDir, [...MESSAGE_READ_CONFIG_PINS, 'log', '-1', '--format=%B']);
  if (!readBack.ok) {
    abort(
      `could not read back the message of the commit just created in ${cloneDir} (git log -1 ` +
        `--format=%B failed: ${readBack.stderr || readBack.stdout || 'no output'}) — refusing to treat an ` +
        'unverifiable commit message as scanned.'
    );
  }

  const committed = normalizeMessageForCompare(readBack.stdout);
  const scanned = normalizeMessageForCompare(scannedMessage);
  if (committed === scanned) {
    return;
  }

  // T-539: scan the RAW read-back stdout, not the normalized string. The
  // normalizer exists to make the COMPARISON tolerant of a trailing-newline
  // difference that carries no information; the scan should see the bytes git
  // actually handed back, with nothing pre-processed out of them. (Observably
  // equivalent today — normalizeMessageForCompare only strips trailing
  // newlines, and no finding can live there — which is why the normalizer now
  // carries its own direct unit test instead of being pinned only through
  // this call.)
  const findings = scanCommitMessageForFindings(readBack.stdout, privateNames);
  const committedLineCount = committed.split('\n').length;
  const scannedLineCount = scanned.split('\n').length;
  const countSuffix = `${committedLineCount} line(s) recorded vs ${scannedLineCount} scanned`;

  if (findings.length > 0) {
    console.error(
      `\nFOUND ${findings.length} finding(s) in the message the commit ACTUALLY recorded (it is NOT the ` +
        `string this run scanned — ${countSuffix}):\n`
    );
    for (const f of findings) {
      console.error(`  [${f.category}] message line ${f.line}  ${f.match}`);
    }
  } else {
    console.error(
      `\nThe message recorded by the commit in ${cloneDir} is NOT the string this run scanned ` +
        `(${countSuffix}). Re-scanned the text the commit ACTUALLY carries: ZERO findings — so this is a ` +
        'rewriting problem, not a leak. It is refused all the same: see the abort below.'
    );
  }

  const reset = gitCapture(cloneDir, ['reset', '--soft', 'HEAD~1']);
  if (!reset.ok) {
    abort(
      `the commit just created in ${cloneDir} carries a message that was rewritten after the scan` +
        `${findings.length > 0 ? ' and trips it (finding(s) above)' : ''}, and undoing that commit failed ` +
        `(git reset --soft HEAD~1: ${reset.stderr || reset.stdout || 'no output'}). REMOVE THAT COMMIT BY ` +
        'HAND before any further run — it is on local `edge` and a later run pushes an ahead range.'
    );
  }
  abort(
    'the message the commit actually recorded is not the string that was scanned' +
      (findings.length > 0
        ? ', and the recorded text ALSO trips the secret scan (finding(s) above)'
        : ' (the recorded text does not itself trip the secret scan — see the note above; this run refuses ' +
          'on the DIFFERENCE alone, because after this script\'s commit and message-read pins there is no ' +
          'benign cause left for one, so a difference means an unidentified rewriting mechanism is live ' +
          'inside the publish pipeline)') +
      ' — something rewrote the message between composition and the commit object (a ' +
      '`prepare-commit-msg` hook runs even with `-m`, and a `git` wrapper on PATH can rewrite it too). ' +
      'The commit has been undone (git reset --soft HEAD~1), so nothing unscanned is left on local `edge` ' +
      'and nothing was pushed. Find and remove the rewriting mechanism before re-running. NOTE BEFORE ' +
      "RE-RUNNING: the clone still holds the overlay's writes, so it is DIRTY and the next run will " +
      'refuse to reuse it — clean it yourself or point <clone-dir> at a fresh path.'
  );
}

// Returns true when there is at least one staged change to commit.
function hasStagedChanges(cloneDir) {
  const result = gitCapture(cloneDir, ['diff', '--cached', '--quiet']);
  // git diff --cached --quiet exits 0 when there is NO difference, 1 when
  // there IS a difference. gitCapture treats non-zero exit as ok:false.
  return !result.ok;
}

// ---------------------------------------------------------------------------
// T-534 round 4 (criterion 2) — ATTRIBUTES PIN (prevention, git-attribute
// layer)
// ---------------------------------------------------------------------------
//
// The `-c core.autocrlf=false -c core.safecrlf=false` pin below (stepCommit's
// `git add -A` call) neutralizes only the CONFIG layer. Attribute-driven
// text/eol normalization is a SEPARATE mechanism that outranks core.autocrlf
// and ignores those `-c` flags entirely — reproduced live (security review
// round 2, slice C): an in-tree `.gitattributes` carrying `* text=auto`
// normalizes the CRLF canary straight through the config pin, and so does an
// UNTRACKED `$GIT_DIR/info/attributes` — the second vector matters more
// (never committed, invisible to every shipped-file check, the same
// future-operator-machine class criterion 6/round 2 already guards against).
// Attribute SOURCES have a strict precedence order and `$GIT_DIR/info/
// attributes` is the HIGHEST, outranking in-tree `.gitattributes`, global
// `core.attributesFile`, and system — verified live: this pin beats an
// in-tree `* text=auto` rule and the canary's CRLF bytes survive. Since the
// publish clone is a pipeline-owned resource, this OWNS that file rather
// than merely documenting the gap: called before `git add -A` (below), it
// overwrites `$GIT_DIR/info/attributes` with exactly this content,
// read-back-verified, aborting fail-closed before add on any write or
// read-back failure. `-filter` additionally closes CLEAN FILTERS (a live
// byte-rewrite channel of the same class).
//
// T-534 ROUND 5 (security review round 3, finding B) — RECLASSIFIED: `-eol`
// and `-ident` are NOT both "subsumed riders" as this comment used to claim.
// `-eol` IS genuinely subsumed — verified, no distinct rewrite mechanism
// beyond what `-text`/`-filter` already close — and stays DECLINED a
// dedicated test, not deferred, on that verified ground. `-ident` is NOT:
// ident conversion is a CLEAN-direction rewrite with its own trigger
// (a literal pre-expanded `$Id: <hex> $` marker plus an `ident` attribute)
// independent of text/eol/filter — a file carrying such a marker is
// silently collapsed back to `$Id$` at `git add -A` when the pin omits
// `-ident`, verified live. Production already includes `-ident` in the
// constant below, so nothing is exploitable today — but it is an
// INDEPENDENT channel, not a rider, and gets its own test (Test 39 in
// scripts/test-publish-build.js; mutant: deleting `-ident` from
// CLONE_OWNED_GIT_ATTRIBUTES_CONTENT turns it red).
//
// COMPLETE by source enumeration, not a labelled workaround: the four
// attribute sources are info/attributes (owned here), in-tree, global, and
// system — the latter three are all outranked by the one this pin owns. The
// `-c` pins above stay as the config-layer prevention, and step 6.6
// (stepVerifyCommittedProvenance) stays the general DETECTION backstop for
// any unnamed mechanism this enumeration missed.
const CLONE_OWNED_GIT_ATTRIBUTES_CONTENT = '* -text -eol -filter -ident\n';

// Resolved via `git rev-parse --absolute-git-dir` — NEVER a hardcoded
// `.git/`, which would silently miss a worktree or a separated git dir
// (`--separate-git-dir`, `$GIT_DIR` override) and pin the wrong file.
function resolveAbsoluteGitDirOrAbort(cloneDir) {
  const result = gitCapture(cloneDir, ['rev-parse', '--absolute-git-dir']);
  if (!result.ok) {
    abort(
      `could not resolve the clone's own git directory in ${cloneDir} (git rev-parse --absolute-git-dir ` +
        `failed: ${result.stderr || result.stdout || 'no output'}) — refusing to pin clone-owned git ` +
        'attributes without a verified target path.'
    );
  }
  return result.stdout.trim();
}

function pinCloneGitAttributesOrAbort(cloneDir) {
  const gitDir = resolveAbsoluteGitDirOrAbort(cloneDir);
  const infoDir = path.join(gitDir, 'info');
  const attributesPath = path.join(infoDir, 'attributes');
  const alreadyExisted = fs.existsSync(attributesPath);
  try {
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(attributesPath, CLONE_OWNED_GIT_ATTRIBUTES_CONTENT);
  } catch (err) {
    abort(
      `could not write ${attributesPath} — the pipeline-owned, HIGHEST-precedence git-attributes source (see ` +
        `the ATTRIBUTES PIN comment above stepCommit()) — before staging: ${err.message}`
    );
  }
  let readBack;
  try {
    readBack = fs.readFileSync(attributesPath, 'utf8');
  } catch (err) {
    abort(
      `could not read back ${attributesPath} immediately after writing it — refusing to proceed with an ` +
        `unverified attributes pin: ${err.message}`
    );
  }
  if (readBack !== CLONE_OWNED_GIT_ATTRIBUTES_CONTENT) {
    abort(
      `read-back of ${attributesPath} did not match what was just written (wrote ` +
        `${JSON.stringify(CLONE_OWNED_GIT_ATTRIBUTES_CONTENT)}, read ${JSON.stringify(readBack)}) — refusing ` +
        'to proceed with an unverified attributes pin.'
    );
  }
  log(
    `${alreadyExisted ? 'Replaced pre-existing' : 'Wrote'} ${attributesPath} with the pipeline-owned attributes ` +
      `pin (${JSON.stringify(CLONE_OWNED_GIT_ATTRIBUTES_CONTENT)}).`
  );
}

// ---------------------------------------------------------------------------
// T-534 round 4 (criterion 1) — MODE BINDING (replacing the security
// reviewer's proposed `-c core.fileMode=true`, which the architect REJECTED)
// ---------------------------------------------------------------------------
//
// THE FINDING: the mirror clone is persistent across publishes, so it
// carries the mode a previous publish committed. With `core.fileMode=false`
// in the clone — the ordinary setting on network-mounted or Windows-backed
// checkouts, present precisely to silence permission-bit noise — `git add
// -A`/`git diff` IGNORE the working tree's executable bit entirely when
// deciding what changed (verified live: a content-identical exec-bit flip on
// disk produces zero `git status` output and stages nothing), so an honest
// `chmod +x` in the private repo is never restaged; step 6.6 then compares
// the STALE committed mode against current HEAD and refuses immediately
// before push.
//
// THE REVIEWER'S FIX (`-c core.fileMode=true` on the `git add -A` call site)
// IS REJECTED ON TWO GROUNDS, both verified: (1) `git clone` PROBES the
// filesystem and writes `core.fileMode` itself — forcing `true` overrides
// git's own determination and stages whatever uniform bit a FAT/exFAT/
// network mount reports, trading a rare false refusal on a handful of paths
// for a near-certain one on every ship/reset path, on exactly the platforms
// the setting exists to serve. (2) `fileMode=true` still routes mode truth
// through DISK OBSERVATION of the clone, which this pipeline has eliminated
// everywhere else (step 6.6's own doctrine: git-to-git on both sides, never
// `fs.statSync`, precisely to avoid a disk-umask false refusal). NO
// `core.fileMode` pin is added in EITHER direction here: once binding exists,
// such a pin has no observable effect on any path step 6.6 certifies, making
// it an unkillable-mutant rule — this paragraph records why the reviewer's
// proposed fix was rejected, per this wave's AC discipline.
//
// THE RULED SHAPE: `git update-index --chmod=+x|-x` — documented for
// filesystems without a working exec bit, and a ZERO-FILESYSTEM-READ
// operation (verified live: with `core.fileMode=false` and the clone's disk
// file left at a stale mode, `git update-index --chmod` still moved the
// index entry to the correct mode) — edits the clone INDEX entry directly
// for every manifest ship path and every non-gitignored-in-clone reset
// destination, sourcing the expected mode git-to-git from the private repo's
// own HEAD (ship) or the mapped templates/ starter's HEAD (reset), reusing
// mavp-publish-verify-provenance.js's readTreeMode()/isGitIgnoredInClone()/
// resolveManifestBuckets() exports rather than re-implementing manifest
// resolution a third time.
//
// TWO ORDERINGS ARE LOAD-BEARING:
//   (a) AFTER `git add -A`, BEFORE hasStagedChanges() — a mode-ONLY publish
//       (no byte changes) stages no content diff; `git update-index --chmod`
//       is itself what makes the index differ from HEAD for that path, so
//       binding must run before the early-return check below or that publish
//       would report `committed: false` and step 6.6 would then refuse
//       against the STALE tip it never got a chance to fix.
//   (b) BEFORE `git write-tree` (below) — the provenance trailer's tree sha
//       must cover the bound modes, not a tree computed before they existed.
//
// Paths whose HEAD mode is 120000 (symlink) are SKIPPED — see
// resolveChmodFlagForHeadMode()'s own comment; this is a NAMED RESIDUAL for
// the adjacent `core.symlinks=false` class, already DETECTION-covered by
// step 6.6 and unreachable in practice since the overlay's own
// symlink-copy path fails earlier for such a mismatch. Any HEAD mode outside
// {100644, 100755, 120000}, any unreadable mode, or any `update-index`
// failure aborts fail-closed BEFORE commit.
function resolveChmodFlagForHeadMode(mode) {
  if (mode === '100755') return { ok: true, flag: '+x' };
  if (mode === '100644') return { ok: true, flag: '-x' };
  if (mode === '120000') return { ok: true, skip: true };
  return {
    ok: false,
    reason: `unexpected git-tree mode "${mode}" — refusing to bind a clone index mode this gate does not recognize`,
  };
}

// Binds ONE clone-index path's mode to whatever mode is recorded for
// `sourceRelPath` at HEAD in `sourceRepoRoot` (the private repo for a ship
// path; the mapped templates/ starter for a reset destination). Zero
// filesystem reads on either side — `readTreeMode` (git-to-git) and `git
// update-index --chmod` (index-to-index) are the only operations here.
function bindOnePathModeOrAbort(cloneDir, indexPath, sourceRepoRoot, sourceRelPath) {
  const headMode = readTreeMode(sourceRepoRoot, 'HEAD', sourceRelPath);
  if (!headMode.ok) {
    abort(
      `mode binding for clone index path "${indexPath}": could not read the HEAD git-tree mode for ` +
        `"${sourceRelPath}" in ${sourceRepoRoot} (${headMode.error}) — refusing to bind an unverifiable mode.`
    );
  }
  const resolved = resolveChmodFlagForHeadMode(headMode.mode);
  if (!resolved.ok) {
    abort(`mode binding for clone index path "${indexPath}" (source "${sourceRelPath}"): ${resolved.reason}`);
  }
  if (resolved.skip) {
    return; // symlink (120000) — see this section's own named-residual comment.
  }
  const chmod = gitCapture(cloneDir, ['update-index', `--chmod=${resolved.flag}`, indexPath]);
  if (!chmod.ok) {
    abort(
      `mode binding for clone index path "${indexPath}": git update-index --chmod=${resolved.flag} failed in ` +
        `${cloneDir} (${chmod.stderr || chmod.stdout || 'no output'}) — refusing to commit an unbound mode.`
    );
  }
}

function bindStagedFileModesToHeadOrAbort(cloneDir) {
  const buckets = resolveManifestBuckets({ repoRoot: REPO_ROOT });
  if (!buckets.ok) {
    abort(`mode binding: could not resolve the manifest (${buckets.reason}) — refusing to commit unbound modes.`);
  }
  for (const shipPath of buckets.ship) {
    bindOnePathModeOrAbort(cloneDir, shipPath, REPO_ROOT, shipPath);
  }
  for (const destPath of Object.keys(buckets.reset)) {
    // T-534 ROUND 5 (security review round 3, finding A) — RE-KEYED, the
    // "NO NEW TEST" paragraph this used to carry is RETIRED (superseded by
    // Test 40 in scripts/test-publish-build.js). The comment it replaced
    // asserted a gitignored reset destination "never reaches `git add -A`
    // at all" — FALSE whenever the destination is already TRACKED (all six
    // reset destinations are tracked at the mirror's origin/main today,
    // including `.claude/settings.json`). The real invariant (see
    // isGitIgnoredInClone()'s own comment in mavp-publish-verify-
    // provenance.js): ignore rules govern UNTRACKED paths only, so this
    // skip fires ONLY when the destination is BOTH absent from the
    // post-`git add -A` index (via isPathInIndex(), never inferred from
    // the ignore match alone) AND ignore-matched — a tracked destination
    // binds unconditionally below, and an untracked+not-ignored
    // destination falls through to `bindOnePathModeOrAbort`'s existing
    // fail-closed `update-index` abort. A git ERROR from the presence
    // check (as distinct from clean absence) is fail-closed here too,
    // never treated as a skip.
    //
    // T-534 ROUND 6 — HONESTY ADMISSION: this re-key is a PROVABLY
    // EQUIVALENT MUTANT for every reachable e2e input today. Both reads
    // above consult the SAME post-`git add -A` index at the SAME instant,
    // and `check-ignore` never reports an indexed path as ignored, so
    // "absent AND ignored" collapses to "ignored" alone across the whole
    // domain — reverting the presence check to ignore-only keying turns no
    // existing test red (Test 40 in scripts/test-publish-build.js cannot
    // discriminate it; see that test's own header). It is kept anyway as a
    // runtime INVARIANT-CONDITIONED GUARD against isGitIgnoredInClone()'s
    // index-awareness itself changing underneath it (a `--no-index`
    // refactor, a hand-rolled matcher, or a git behaviour change) — an
    // external invariant that only a test written through the predicate
    // itself can pin. scripts/test-publish-verify-provenance.js's Test 26
    // is that pin.
    const indexPresence = isPathInIndex(cloneDir, destPath);
    if (!indexPresence.ok) {
      abort(
        `mode binding: could not determine whether reset destination "${destPath}" is present in the clone's ` +
          `git index (${indexPresence.error}) — refusing to bind an unverifiable mode.`
      );
    }
    if (!indexPresence.present && isGitIgnoredInClone(cloneDir, destPath)) {
      continue;
    }
    const starterPath = buckets.reset[destPath];
    bindOnePathModeOrAbort(cloneDir, destPath, REPO_ROOT, starterPath);
  }
}

// T-534 round 4 TEST-ONLY SEAM (mode binding) — inert unless
// MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE is set, which no real invocation of
// this script ever does. Value shape: "<clone-relative-path>=<octal-mode>"
// (e.g. "NOTICE=644"). Called from main(), right after stepOverlay() has
// already copied the assembled tree into the clone, it forcibly overwrites
// the named path's ON-DISK permission bits to the given octal value —
// deliberately DECOUPLING the clone's disk-observed mode from its correct
// git-tracked target. This exists because on a POSIX filesystem with a
// working exec bit (this developer's own, and most CI machines'),
// fs.copyFileSync propagates the source mode faithfully, so the disk-vs-HEAD
// mismatch this task's finding actually targets (a FAT/exFAT/network-mounted
// or Windows-backed checkout, where the exec bit either does not exist or
// does not stick) cannot be reproduced by simply flipping a mode in the
// private fixture repo and letting the real pipeline run end to end — see
// scripts/test-publish-build.js's Tests 32/33. A mode-binding implementation
// that ever consulted disk (fs.statSync) instead of git-to-git would bind
// the WRONG mode under this seam; only the ruled shape produces the correct
// one regardless of what this seam forces onto disk.
function applyTestOnlyForceDiskModeSeam(cloneDir) {
  const raw = process.env.MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE;
  if (!raw) return;
  const eqIndex = raw.indexOf('=');
  const relPath = raw.slice(0, eqIndex);
  const octal = raw.slice(eqIndex + 1);
  const absPath = path.join(cloneDir, relPath);
  fs.chmodSync(absPath, parseInt(octal, 8));
  log(
    `[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE set — forced on-disk mode of "${relPath}" to ${octal} ` +
      'in the clone, decoupled from its git-tracked mode.'
  );
}

function stepCommit(cloneDir, summary, author, privateNames) {
  log('\n=== Step 6/7: commit ===');
  // T-534 round 4 (criterion 2) — ATTRIBUTES PIN, the git-attribute layer.
  // Must run BEFORE `git add -A` below, since it is what `add` reads to
  // decide whether to normalize. See the ATTRIBUTES PIN comment above this
  // function for the full rationale and the precedence claim.
  pinCloneGitAttributesOrAbort(cloneDir);
  // T-534 round 2 (criterion 6) — TRANSFORM PREVENTION, the config layer. A
  // global `core.autocrlf=true` on a future operator machine would otherwise
  // silently normalize CRLF-committed text (e.g. scripts/publish-crlf-
  // canary.txt) to LF at THIS `git add -A` call — the exact clone-side
  // add/commit transcoding step 6.6 (stepVerifyCommittedProvenance) exists to
  // DETECT. This pin is the PREVENTION half of that same fix (T-539
  // precedent: pin first, verify after) — it outranks any repo-local or
  // global core.autocrlf/core.safecrlf, so the index this run stages is
  // never transcoded regardless of what the clone's own git config says.
  // TWO LAYERS ARE NOW ENFORCED (T-534 round 4 rescope) — this `-c` pin is
  // the CONFIG layer; pinCloneGitAttributesOrAbort() above is the ATTRIBUTE
  // layer (the highest-precedence source, which outranks and ignores these
  // `-c` flags); step 6.6 stays the general DETECTION backstop for any
  // unnamed mechanism outside both.
  gitRunInherit(
    cloneDir,
    ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '-A'],
    'stage overlay changes'
  );

  // T-534 round 4 (criterion 1) — MODE BINDING. Must run AFTER `git add -A`
  // above and BEFORE hasStagedChanges() below — see the MODE BINDING comment
  // above this function for why both orderings are load-bearing.
  bindStagedFileModesToHeadOrAbort(cloneDir);

  if (!hasStagedChanges(cloneDir)) {
    log('No changes staged after overlay — nothing to publish this run.');
    return { committed: false };
  }

  // F1: bind the trailer to the TREE being committed, not just the message.
  // `git write-tree` reports the tree the index (already staged via `add -A`
  // above) will produce — exactly the tree this commit is about to carry.
  const treeResult = gitCapture(cloneDir, ['write-tree']);
  if (!treeResult.ok) {
    abort(
      `could not compute the tree about to be committed in ${cloneDir} (git write-tree failed: ` +
        `${treeResult.stderr || treeResult.stdout || 'no output'}) — refusing to commit without a tree ` +
        'to bind the scan-provenance trailer to.'
    );
  }
  const treeSha = treeResult.stdout.trim();

  // The trailer is stamped on every commit THIS script makes, unconditionally
  // (dry-run or not) — it is what lets a later run recognize this commit as
  // scan-gate-verified regardless of which run eventually pushes it. See the
  // T-514 file-header note and PUSH_PROVENANCE_TRAILER's own comment.
  const message = `Sync from canonical: ${summary}\n\n${buildProvenanceTrailerLine(treeSha)}`;

  // T-523 HARD GATE — scan the FULL composed message (subject + trailer)
  // before the commit exists. This call and the gitRunInherit(...'commit'...)
  // immediately below it are adjacent by design: there is no statement between
  // them, so an abort here provably precedes any commit. Nothing is staged
  // into history, nothing lands on local `edge`, nothing is pushed.
  assertCommitMessageScanClean(message, privateNames);

  // T-523 H2 — pinned config, scrubbed identity environment. The `-c` pins
  // come first (git only accepts them before the subcommand); the identity
  // pins stay exactly where they were, and are now backed by an explicit env
  // that the six GIT_AUTHOR_*/GIT_COMMITTER_* variables cannot outrank.
  const commitArgs = [
    ...buildCommitConfigPins(createEmptyHooksDir()),
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '-m',
    message,
  ];
  gitRunInherit(cloneDir, commitArgs, 'commit', { env: buildCommitEnv(author) });

  // T-523 H2 — the certificate must cover the artifact, not the input: verify
  // the commit object records the very string that was scanned a moment ago,
  // and undo + abort if it records something else that trips the scan.
  assertCommittedMessageMatchesScanned(cloneDir, message, privateNames);

  const shaResult = gitCapture(cloneDir, ['rev-parse', 'HEAD']);
  log(
    `Committed ${shaResult.ok ? shaResult.stdout.trim() : '(unknown sha)'} on 'edge' as ` +
      `${author.name} <${author.email}>: ${message}`
  );
  return { committed: true };
}

// ---------------------------------------------------------------------------
// Step 6.5 — content-provenance verification (T-534, hard gate)
// ---------------------------------------------------------------------------
//
// Every gate above this point is PATH-shaped: the size floor (1.5) reacts to
// file COUNT, the secret scan (2) reacts to known finding SHAPES, and the
// overlay's own deletion-ratio guards (T-504/T-507/T-532/T-533) react to
// paths disappearing or moving. None of them react to a file's CONTENT being
// swapped in place while the path set stays exactly as expected — that
// produces zero deletion candidates, an unchanged file count, and (barring a
// coincidental secret-shaped replacement) zero scan findings. This gate
// closes that blind spot: it asserts every ship path's assembled bytes equal
// the private repo's own HEAD blob for that path, and every reset
// destination's assembled bytes equal its MAPPED templates/ starter's HEAD
// blob — see mavp-publish-verify-provenance.js's own header for the full
// threat model and the two traps it deliberately avoids (never a naive
// per-path HEAD lookup for a reset destination, since a reset key may be
// untracked at HEAD after T-529; never a live on-disk read).
//
// Runs UNCONDITIONALLY (dry-run or not, whether or not stepCommit() actually
// made a new commit this run) against the same tempOutDir stepAssemble()
// populated and stepScan() already scanned — the exact tree whose window
// between scan and push this gate exists to cover. Placed immediately before
// step 7 (the only place `git push` is ever called), so an abort here
// provably precedes any push; nothing between assemble and this point is
// re-ordered or skipped.
//
// `cloneDir` and `committedThisRun` (T-534 round 2, criterion 5) are threaded
// through so a refusal here can UNDO the commit stepCommit() just made —
// see undoCommitMadeThisRunOrAbort()'s own comment.
function stepVerifyProvenance(outDir, cloneDir, committedThisRun) {
  log('\n=== Step 6.5/7: content-provenance verification (assembled tree vs HEAD blobs) — HARD GATE ===');
  const result = verifyAssembledTreeProvenance(outDir, { repoRoot: REPO_ROOT });
  if (!result.ok) {
    undoCommitMadeThisRunOrAbort(
      cloneDir,
      committedThisRun,
      `content-provenance check failed${result.path ? ` for path "${result.path}"` : ''}: ${result.reason} — ` +
        'the assembled tree no longer matches the private repo HEAD blob (or, for a reset destination, its ' +
        'mapped templates/ starter blob) for that path. This is the last check before push, and it is the ' +
        'only barrier against a content-only tamper of the assembled tree (a replacement that leaves the ' +
        'path set, file count, and secret scan all looking clean) — refusing to publish content that cannot ' +
        'be verified against its source of truth.'
    );
    return;
  }
  log(
    `Content-provenance check GREEN — ${result.counts.ship} ship path(s), ${result.counts.reset} reset ` +
      'destination(s) verified against HEAD blobs / starter blobs.'
  );
}

// ---------------------------------------------------------------------------
// T-534 round 2 (criterion 5) — UNDO-ON-REFUSAL
// ---------------------------------------------------------------------------
//
// When THIS run's own stepCommit() created a new commit and step 6.5 or 6.6
// refuses, that commit is undone via the SAME `git reset --soft HEAD~1`
// machinery assertCommittedMessageMatchesScanned() (T-539) already
// established — history only; the working tree and index keep the overlay's
// staged content exactly as they were — BEFORE aborting, so a
// tamper-detected tree can never strand on local `edge` for a later run's
// ahead-range push (T-514) to pick up and transmit anyway.
//
// When stepCommit() made NO new commit this run (source unchanged since the
// last publish), NOTHING is reset here — a previously certified tip must
// never be undone by a later run's refusal.
function undoCommitMadeThisRunOrAbort(cloneDir, committedThisRun, reasonForRefusal) {
  if (!committedThisRun) {
    abort(reasonForRefusal);
    return;
  }
  const reset = gitCapture(cloneDir, ['reset', '--soft', 'HEAD~1']);
  if (!reset.ok) {
    abort(
      `${reasonForRefusal} The commit this run made in ${cloneDir} could not be undone (git reset --soft ` +
        `HEAD~1 failed: ${reset.stderr || reset.stdout || 'no output'}) — REMOVE THAT COMMIT BY HAND before ` +
        "any further run: it is on local 'edge' and a later run's ahead-range push would otherwise transmit it."
    );
    return;
  }
  abort(
    `${reasonForRefusal} The commit this run made in ${cloneDir} has been undone (git reset --soft HEAD~1) — ` +
      "nothing unscanned or unverified is left on local 'edge', and nothing was pushed."
  );
}

// ---------------------------------------------------------------------------
// Step 6.6 — committed-tree content-provenance verification (T-534 round 2,
// criterion 4, hard gate)
// ---------------------------------------------------------------------------
//
// Step 6.5 above certifies tempOutDir — the assembled tree BEFORE it is ever
// staged/committed. It never looks at what actually landed in the commit
// stepCommit() just made on local `edge`, which is the tree stepPush() (step
// 7) actually transmits. Nothing pins or checks the CLONE's own add/commit
// behaviour on its own (assertCleanSourceRepo() guards the SOURCE repo
// only) — a global `core.autocrlf=true`, or a hostile in-tree/global/system
// git-attributes rule, on a future operator machine could transcode shipped
// text at `git add -A` INSIDE THE CLONE while step 6.5 stays GREEN (it never
// re-reads the clone). T-534 round 4 (criterion 2) — PREVENTION is now TWO
// layers, both in stepCommit(): the `-c core.autocrlf=false -c
// core.safecrlf=false` pin (the CONFIG layer) and pinCloneGitAttributesOrAbort()
// owning `$GIT_DIR/info/attributes` (the ATTRIBUTE layer, which outranks and
// ignores the config-layer flags — see that function's own comment for the
// precedence claim). This step is the DETECTION half for BOTH layers, plus
// the general backstop for any unnamed mechanism outside them — belt and
// braces.
//
// Certifies, for every ship path and reset destination, the clone's
// COMMITTED tree (content git-blob-to-git-blob, plus git-tree MODE, both
// comparisons git-to-git only — see verifyCommittedTreeProvenance()'s own
// comment) against the same private-repo HEAD (ship) / mapped templates/
// starter HEAD (reset) this file already resolves for step 6.5. T-534 round 4
// (criterion 1) — the MODE half of this comparison is now backed by
// stepCommit()'s own mode-binding pass, which binds the clone's committed
// mode to the same HEAD/starter mode this step independently re-derives and
// compares against.
//
// Runs unconditionally (dry-run or not, whether or not stepCommit() made a
// new commit this run) against `HEAD` in cloneDir — `edge` is the branch
// checked out there (stepCheckoutEdge()), so a no-new-commit run's tip still
// matches current HEAD blobs and needs no special-casing.
function stepVerifyCommittedProvenance(cloneDir, committedThisRun) {
  log("\n=== Step 6.6/7: committed-tree content-provenance verification (local 'edge' vs HEAD blobs) — HARD GATE ===");
  const result = verifyCommittedTreeProvenance(cloneDir, 'HEAD', { repoRoot: REPO_ROOT });
  if (!result.ok) {
    undoCommitMadeThisRunOrAbort(
      cloneDir,
      committedThisRun,
      `committed-tree content-provenance check failed${result.path ? ` for path "${result.path}"` : ''}: ` +
        `${result.reason} — the commit on local 'edge' in ${cloneDir} no longer matches the private repo's ` +
        "own HEAD (or, for a reset destination, its mapped templates/ starter HEAD), by content or by git " +
        'mode. This certifies what stepPush() actually transmits, not the temp assembled tree — refusing to ' +
        'publish a committed tree that cannot be verified against its source of truth.'
    );
    return;
  }
  log(
    `Committed-tree content-provenance check GREEN — ${result.counts.ship} ship path(s), ` +
      `${result.counts.reset} reset destination(s) verified against HEAD blobs / starter blobs for local 'edge'.`
  );
}

// T-534 TEST-ONLY SEAM — inert unless MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH is
// set in the environment, which no real invocation of this script ever does
// (the var name is deliberately long and namespaced so it cannot collide
// with anything an operator would plausibly set). When set, right after the
// scan gate (step 2) has already passed, it flips one byte of the named
// file inside the assembled tree — reproducing, deterministically and
// in-process, the EXACT scenario stepVerifyProvenance() above exists to
// catch: the assembled tree being tampered with after it was scanned and
// before it is pushed. See scripts/test-publish-build.js's T-534 end-to-end
// cases for how this is exercised.
function applyTestOnlyProvenanceTamperSeam(outDir) {
  const relPath = process.env.MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH;
  if (!relPath) return;
  const absPath = path.join(outDir, relPath);
  const buf = fs.readFileSync(absPath);
  const mutated = Buffer.from(buf);
  if (mutated.length === 0) {
    fs.writeFileSync(absPath, Buffer.from([0x58])); // a single 'X' byte — was empty
  } else {
    mutated[0] = mutated[0] ^ 0xff; // flip the first byte — guarantees a one-byte content change
    fs.writeFileSync(absPath, mutated);
  }
  log(`[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH set — tampered one byte of assembled path "${relPath}".`);
}

// T-534 round 2 TEST-ONLY SEAM (criterion 3, the completeness sweep) —
// inert unless MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH is set, which no real
// invocation ever does. When set, right after the scan gate has already
// passed, it PLANTS a new file (not declared anywhere in the manifest) into
// the assembled tree — reproducing, deterministically, the exact
// "unexpected addition after assembly" scenario the completeness sweep in
// verifyAssembledTreeProvenance() exists to catch. Distinct from the
// byte-tamper seam above (which mutates an EXISTING declared path); this one
// ADDS a path, which the per-path ship/reset loops structurally cannot react
// to since they only ever look FOR declared paths.
function applyTestOnlyProvenanceExtraFileSeam(outDir) {
  const relPath = process.env.MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH;
  if (!relPath) return;
  const absPath = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, 'planted by MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH — not declared in the manifest\n');
  log(`[TEST SEAM] MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH set — planted undeclared extra path "${relPath}".`);
}

// ---------------------------------------------------------------------------
// Step 7 — push (T-514: gated on local `edge` being ahead of origin, not on
// whether THIS run committed; --dry-run still never pushes)
// ---------------------------------------------------------------------------

// The range of commits about to be pushed, expressed as a git rev-range
// (or a bare ref name in the degenerate fallback below). Computed the same
// way both to decide WHETHER to push and to decide WHAT to provenance-check
// — the two must never drift apart, or the check could examine a different
// set of commits than the ones `git push` actually sends.
function computeAheadRange(cloneDir) {
  if (refExists(cloneDir, 'refs/remotes/origin/edge')) {
    return 'origin/edge..edge';
  }
  if (refExists(cloneDir, 'refs/remotes/origin/main')) {
    // origin/edge does not exist yet — stepCheckoutEdge bootstraps `edge`
    // from origin/main's tip, so only commits ADDED since that tip are new;
    // origin/main's own history is already public and not this script's
    // concern here.
    return 'origin/main..edge';
  }
  // Defensive fallback only — stepCheckoutEdge already aborts the whole run
  // earlier if neither origin/edge nor origin/main exists, so this branch
  // should be unreachable in normal operation. If somehow reached, treat the
  // entirety of local `edge` as the ahead range rather than assume nothing
  // needs checking.
  return 'edge';
}

// Returns the commit count in `range`, or null if it could not be computed
// (treated as "unknown — assume ahead, fail closed" by the caller).
function countAhead(cloneDir, range) {
  const result = gitCapture(cloneDir, ['rev-list', '--count', range]);
  if (!result.ok) return null;
  const n = parseInt(result.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// Returns the list of commit hashes in `range` that do NOT carry a VALID
// PUSH_PROVENANCE_TRAILER — one whose stamped tree sha matches the commit's
// OWN tree (%T) — or null if the range could not even be enumerated (fail
// closed — treated as "provenance unverifiable" by the caller, not as
// "nothing missing"). F1: a trailer whose message text is present but whose
// stamped tree does not match %T (the message survived an `--amend` that
// changed the tree) is treated exactly like a missing trailer — refused.
function commitsMissingProvenance(cloneDir, range) {
  const hashesResult = gitCapture(cloneDir, ['log', range, '--format=%H']);
  if (!hashesResult.ok) return null;
  const hashes = hashesResult.stdout.split('\n').filter(Boolean);
  const missing = [];
  for (const hash of hashes) {
    // T-539: pinned like every other message read (MESSAGE_READ_CONFIG_PINS) —
    // the trailer is parsed out of this text, so a legacy output encoding would
    // mangle it. Deliberately the SAME argv commitsWithMessageFindings() below
    // issues, so the two gates read byte-identical commands.
    const bodyResult = gitCapture(cloneDir, [...MESSAGE_READ_CONFIG_PINS, 'show', '-s', '--format=%B', hash]);
    const body = bodyResult.ok ? bodyResult.stdout : '';
    const stampedTree = parseProvenanceTreeSha(body);
    if (!stampedTree) {
      missing.push(hash);
      continue;
    }
    const actualTreeResult = gitCapture(cloneDir, ['show', '-s', '--format=%T', hash]);
    const actualTree = actualTreeResult.ok ? actualTreeResult.stdout.trim() : null;
    if (!actualTree || actualTree !== stampedTree) {
      missing.push(hash);
    }
  }
  return missing;
}

// T-523 H1 — the message gate, applied to the RANGE about to be transmitted.
// Returns an array of { hash, findings } for every commit in `range` whose
// FULL message trips the scan, or null if the range could not be enumerated or
// a message could not be read (fail closed — treated as "unverifiable" by the
// caller, never as "clean").
//
// Why here and not only at creation time: stepCommit()'s gate runs on the
// string this run composed, and does not run at all when a run has nothing to
// commit (unchanged source) — yet step 7 still pushes whatever is ahead, from
// whichever run created it. So this is the only place that sees the message
// text as it will actually be transmitted, and it therefore also covers a
// message-only `--amend` (tree unchanged, provenance trailer still valid), a
// hand-crafted trailer, and a commit stranded on local `edge` by a version of
// this script that predates the message gate.
//
// `privateNames` is main()'s own already-parsed --private-names list, threaded
// through stepPush() — the same value stepCommit() gets, so the range scan and
// the creation-time gate can never disagree about what counts as a finding.
function commitsWithMessageFindings(cloneDir, range, privateNames) {
  const hashesResult = gitCapture(cloneDir, ['log', range, '--format=%H']);
  if (!hashesResult.ok) return null;
  const hashes = hashesResult.stdout.split('\n').filter(Boolean);
  const offenders = [];
  for (const hash of hashes) {
    // T-539: pinned (MESSAGE_READ_CONFIG_PINS) so the bytes this GATE scans are
    // UTF-8 whatever i18n.logOutputEncoding/i18n.commitEncoding say.
    const bodyResult = gitCapture(cloneDir, [...MESSAGE_READ_CONFIG_PINS, 'show', '-s', '--format=%B', hash]);
    if (!bodyResult.ok) return null;
    const findings = scanCommitMessageForFindings(bodyResult.stdout, privateNames);
    if (findings.length > 0) {
      offenders.push({ hash, findings });
    }
  }
  return offenders;
}

// Returns { pushed, warning, refusedPush }. `warning`, when non-null, is a
// message main() must surface loudly (never folded silently into a bare
// "Done.") — see the "Also required by the AC" note in this task's brief: a
// silent exit-0 leaving ahead-of-remote work unpushed is a defect in its own
// right, independent of the push condition itself.
//
// F2 (security review, round 1): `refusedPush` distinguishes "the CALLER
// asked for this" (--dry-run: exit 0 is correct, unchanged) from "the SCRIPT
// itself unilaterally withheld the push" (a provenance refusal, or an
// unenumerable ahead range: exit 1 — the caller asked to publish and did not
// get it, for a suspected integrity problem in the publish pipeline, which is
// the last condition that should report success to an automated caller).
//
// T-520 (security review, T-514 follow-up): the transmitted ref set must be
// a property of THIS command, not of the clone's or machine's git config.
//   --no-follow-tags   closes push.followTags. An explicit refspec alone
//                      does NOT disable followTags — that config applies
//                      even when a refspec is given on the command line, so
//                      both are required to close this class; a fixture
//                      clone with push.followTags=true and a reachable
//                      annotated tag otherwise carries that tag to the
//                      mirror alongside 'edge'.
//   refs/heads/edge:refs/heads/edge (fully-qualified, on both sides)
//                      makes push.default, remote.origin.push and ref-DWIM
//                      structurally inert, and makes a
//                      remote.origin.mirror=true clone fail loudly instead
//                      of silently force-mirroring every local ref to the
//                      public mirror (git refuses combining mirror mode
//                      with an explicit refspec).
//   --recurse-submodules=no
//                      pins the last config-driven transmit vector; inert
//                      today (the assembled tree has no .gitmodules) but
//                      cheap to pin so a future submodule can't silently
//                      widen what gets sent.
//   (no -u/--set-upstream)
//                      verified vestigial: nothing in this script reads an
//                      upstream — stepCloneOrPull() fetches explicitly and
//                      computeAheadRange() uses the literal
//                      'origin/edge..edge', never '@{u}'.
//   (no --atomic)      a single fully-qualified refspec gives atomicity
//                      nothing to group; adding it would misleadingly imply
//                      multi-ref pushes happen here.
// Accepted residual, NOT fixed here (different class — destination trust,
// not transmitted-ref-set): url.<base>.pushInsteadOf can rewrite the
// destination URL itself, and no push flag closes that; it would equally
// affect this script's own clone/fetch, so it is out of scope for this fix.
//
// T-524: exported so tests observe this script's actual argv instead of
// maintaining their own hardcoded copy of the command (a hardcoded test copy
// tests git, not this script). stepPush() spreads this verbatim with no
// inline additions — see stepPush() below.
const EDGE_PUSH_ARGS = [
  'push',
  '--no-follow-tags',
  '--recurse-submodules=no',
  'origin',
  'refs/heads/edge:refs/heads/edge',
];

function stepPush(cloneDir, dryRun, privateNames) {
  log("\n=== Step 7/7: push 'edge' ===");

  const range = computeAheadRange(cloneDir);
  const aheadCount = countAhead(cloneDir, range);

  if (aheadCount === 0) {
    log(`Local 'edge' is not ahead of origin (${range} is empty) — nothing to push.`);
    return { pushed: false, warning: null, refusedPush: false };
  }

  if (aheadCount === null) {
    log(
      `Could not determine how far local 'edge' is ahead of origin (git rev-list --count ${range} ` +
        'failed) — treating this as ahead-of-remote to be safe.'
    );
  } else {
    log(`Local 'edge' is ${aheadCount} commit(s) ahead of origin (${range}).`);
  }

  if (dryRun) {
    log(`[dry-run] Skipping push. Inspect the local commit(s) in ${cloneDir} (branch 'edge').`);
    return {
      pushed: false,
      warning:
        `local 'edge' in ${cloneDir} has unpushed work that --dry-run intentionally did not push. ` +
        'Run again WITHOUT --dry-run against the same clone dir to publish it, or it stays stranded.',
      refusedPush: false,
    };
  }

  const missing = commitsMissingProvenance(cloneDir, range);
  if (missing === null) {
    return {
      pushed: false,
      warning:
        `refusing to push: could not enumerate the commits ahead of origin (${range}) in ${cloneDir} ` +
        'to verify they passed this script\'s scan gate. Inspect the clone manually before pushing by hand.',
      refusedPush: true,
    };
  }
  if (missing.length > 0) {
    return {
      pushed: false,
      warning:
        `refusing to push: ${missing.length} commit(s) ahead of origin on 'edge' in ${cloneDir} do not ` +
        `carry this script's scan-provenance marker (${missing.slice(0, 5).join(', ')}` +
        `${missing.length > 5 ? ', ...' : ''}) — they may have been committed outside this script (by ` +
        'hand, or by another tool), or a trailered commit\'s tree was changed after the fact (e.g. ' +
        '`--amend`), and never passed the scan gate for the tree they now carry. Refusing to push an ' +
        'unverifiable history. Inspect those commits and either remove/replace them or re-run this ' +
        'script to add a fresh scanned commit on top.',
      refusedPush: true,
    };
  }

  // T-523 H1 HARD GATE — the messages about to be transmitted. Runs AFTER the
  // provenance check (so provenance is still the first thing reported when
  // both are wrong) and BEFORE the push invocation below, with nothing between
  // this block and it that could reach the network.
  const messageOffenders = commitsWithMessageFindings(cloneDir, range, privateNames);
  if (messageOffenders === null) {
    return {
      pushed: false,
      warning:
        `refusing to push: could not read the commit messages ahead of origin (${range}) in ${cloneDir} ` +
        'to scan them before transmitting. A commit message is published exactly like file content is, so ' +
        'an unreadable one is treated as unscanned. Inspect the clone manually before pushing by hand.',
      refusedPush: true,
    };
  }
  if (messageOffenders.length > 0) {
    console.error(
      `\nFOUND finding(s) in ${messageOffenders.length} commit message(s) about to be pushed from ` +
        `${cloneDir} (${range}):\n`
    );
    for (const offender of messageOffenders) {
      for (const f of offender.findings) {
        console.error(`  ${offender.hash}  [${f.category}] message line ${f.line}  ${f.match}`);
      }
    }
    return {
      pushed: false,
      warning:
        `refusing to push: ${messageOffenders.length} commit message(s) in the range about to be pushed ` +
        `(${range}) trip the secret scan (finding(s) above: ` +
        `${messageOffenders.slice(0, 5).map((o) => o.hash).join(', ')}` +
        `${messageOffenders.length > 5 ? ', ...' : ''}). A commit message is published to the mirror ` +
        'exactly like file content is, and the message of an ALREADY-COMMITTED commit can differ from the ' +
        'one this script scanned when it created it (e.g. a message-only `git commit --amend`, which ' +
        "leaves the tree — and so the provenance trailer — valid). Rewrite or drop those commits in the " +
        'clone (they are local only; nothing was transmitted) before pushing.',
      refusedPush: true,
    };
  }

  // This is the ONLY call to `git push` in this script, and it is only ever
  // reached after every prior step (including the size-sanity check and the
  // scan gate, in whichever run produced each ahead commit) has already
  // succeeded — see the file-header comment.
  //
  // T-524: the argv is a single exported constant (EDGE_PUSH_ARGS, declared
  // above stepPush) so a test can observe exactly what this call site issues
  // instead of maintaining its own hardcoded copy of the command — a
  // hardcoded test copy tests git, not this script (see this task's brief).
  // `pushArgs` is spread from EDGE_PUSH_ARGS with no inline additions, and is
  // the SAME array both logged and passed to gitRunInherit — deliberately one
  // variable, not two independently-written literals, so a future edit that
  // adds an argument at this call site cannot do so without it also showing
  // up in the logged line a test observes.
  const pushArgs = [...EDGE_PUSH_ARGS];
  log(`Running: git ${pushArgs.join(' ')}`);
  gitRunInherit(cloneDir, pushArgs, "push 'edge'");
  log(`Pushed 'edge' to origin from ${cloneDir}.`);
  return { pushed: true, warning: null, refusedPush: false };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const {
    mirrorRemote,
    cloneDir,
    privateNames,
    dryRun,
    summary,
    authorName,
    authorEmail,
    allowMassDelete,
    maxDeleteRatio,
    maxDirDeleteRatio,
    maxMoveCreditRatio,
  } = parseArgs(process.argv.slice(2));

  if (!mirrorRemote || !cloneDir) {
    printUsage();
    process.exit(1);
  }

  let parsedPrivateNames;
  try {
    parsedPrivateNames = parsePrivateNamesList(privateNames);
  } catch (err) {
    printUsage();
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
  if (parsedPrivateNames.length === 0) {
    printUsage();
    console.error(
      '\nERROR: --private-names is mandatory for this script (see file header) and must resolve to ' +
        'at least one non-empty name after comma-splitting and trimming — refusing to run with ' +
        `private-repo-name detection effectively disabled (got: ${JSON.stringify(privateNames)}).`
    );
    process.exit(1);
  }

  assertCleanSourceRepo();

  const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-publish-build-'));
  tempOutDirForCleanup = tempOutDir;

  stepAssemble(tempOutDir);
  assertAssembledTreeNonTrivial(tempOutDir);
  stepScan(tempOutDir, privateNames);
  // T-534 TEST SEAM — inert unless MAVP_PUBLISH_BUILD_TEST_TAMPER_PATH is set
  // (see applyTestOnlyProvenanceTamperSeam()'s own comment). Placed right
  // after the scan gate, so a planted tamper here reproduces exactly the
  // "assembled tree modified after scan, before push" scenario
  // stepVerifyProvenance() exists to catch.
  applyTestOnlyProvenanceTamperSeam(tempOutDir);
  // T-534 round 2 TEST SEAM — inert unless
  // MAVP_PUBLISH_BUILD_TEST_EXTRA_FILE_PATH is set (see
  // applyTestOnlyProvenanceExtraFileSeam()'s own comment). Same placement as
  // the byte-tamper seam above, for the same reason.
  applyTestOnlyProvenanceExtraFileSeam(tempOutDir);

  // Everything from here on touches the mirror clone. Nothing above this
  // line ever writes to the mirror or pushes anywhere.
  stepAcquireLock(cloneDir);
  stepCloneOrPull(mirrorRemote, cloneDir);
  stepCheckoutEdge(cloneDir);
  stepOverlay(tempOutDir, cloneDir, { allowMassDelete, maxDeleteRatio, maxDirDeleteRatio, maxMoveCreditRatio });
  // T-534 round 4 TEST SEAM — inert unless
  // MAVP_PUBLISH_BUILD_TEST_FORCE_DISK_MODE is set (see
  // applyTestOnlyForceDiskModeSeam()'s own comment). Placed right after the
  // overlay has written the clone's working tree, before stepCommit() runs
  // its mode-binding pass.
  applyTestOnlyForceDiskModeSeam(cloneDir);
  const resolvedSummary = resolveSummary(summary);
  const author = resolveAuthorIdentity(authorName, authorEmail);
  // parsedPrivateNames (not the raw string): the commit-message gate needs the
  // same already-parsed list buildCategories() expects, and it is the run's
  // own mandatory --private-names value — never a hardcoded list.
  const commitResult = stepCommit(cloneDir, resolvedSummary, author, parsedPrivateNames);
  // T-534 HARD GATE — immediately before push (step 7), on the SAME tempOutDir
  // stepScan() already scanned. Runs unconditionally, regardless of whether
  // stepCommit() found anything new to commit this run. commitResult.committed
  // (round 2, criterion 5) lets a refusal here undo THIS run's own commit
  // without ever touching a previously certified tip.
  stepVerifyProvenance(tempOutDir, cloneDir, commitResult.committed);
  // T-534 round 2 (criterion 4) HARD GATE — certifies the clone's own
  // COMMITTED tree, not just the temp assembled tree above. Same
  // undo-on-refusal semantics as step 6.5.
  stepVerifyCommittedProvenance(cloneDir, commitResult.committed);
  // parsedPrivateNames again (T-523 H1): the range scan in stepPush() is the
  // same gate as stepCommit()'s, applied to what is actually about to be
  // transmitted, so it must use the same run-supplied list — never a second,
  // independently-derived one.
  const { warning, refusedPush } = stepPush(cloneDir, dryRun, parsedPrivateNames);

  if (warning) {
    // Loud and on stderr, and the final line deliberately does NOT read as a
    // bare "Done." — see T-514: an exit-0 run that silently leaves
    // ahead-of-remote work unpushed is the reported defect in its own right.
    console.error(`\nWARNING: ${warning}`);
    log("\nDone — WARNING above: 'edge' still has unpushed work.");
  } else {
    log('\nDone.');
  }
  // F2: --dry-run intentionally not pushing is success (exit 0, unchanged).
  // The script itself refusing to push (a provenance problem) is not — the
  // caller asked to publish and did not get it, so this exits non-zero like
  // every other refusal path in this script.
  process.exit(refusedPush ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  normalizeRemoteForCompare,
  isLocalPath,
  resolveSummary,
  resolveAuthorIdentity,
  parsePrivateNamesList,
  countFilesRecursive,
  assertAssembledTreeNonTrivial,
  ASSEMBLED_TREE_MIN_RATIO,
  PUSH_PROVENANCE_TRAILER,
  buildProvenanceTrailerLine,
  parseProvenanceTreeSha,
  computeAheadRange,
  countAhead,
  commitsMissingProvenance,
  EDGE_PUSH_ARGS,
  // T-523 — exported so tests can exercise the message gate directly: the
  // pure findings function (every line of the full message, private-name
  // category included) and the aborting wrapper stepCommit() actually calls.
  scanCommitMessageForFindings,
  assertCommitMessageScanClean,
  COMMIT_MESSAGE_SCAN_LABEL,
  // T-523 round 2 — H1's range scan, H2's commit pins / identity-env scrub /
  // read-back comparison, exported so tests can observe the actual argv and
  // env this script builds instead of maintaining their own copies.
  commitsWithMessageFindings,
  buildCommitConfigPins,
  // T-539 — the read-side pins, exported so tests read the script's own argv
  // rather than a hardcoded copy (EDGE_PUSH_ARGS precedent).
  MESSAGE_READ_CONFIG_PINS,
  buildCommitEnv,
  SCRUBBED_COMMIT_ENV_VARS,
  normalizeMessageForCompare,
  assertCommittedMessageMatchesScanned,
  // T-536 — exported so tests can observe the forwarder's own returned argv
  // for the overlay override flags (parse-but-drop / wrong-flag-mapping
  // mutants), following the EDGE_PUSH_ARGS precedent above.
  buildOverlayOverrideArgs,
  // T-534 round 4 — exported so tests can exercise the mode-binding helper
  // and the attributes pin directly (M4 unit case; A2/A3 call the real pin
  // function rather than duplicating its logic, and read the exact pinned
  // content rather than duplicating that literal).
  resolveChmodFlagForHeadMode,
  pinCloneGitAttributesOrAbort,
  CLONE_OWNED_GIT_ATTRIBUTES_CONTENT,
};
