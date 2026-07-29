#!/usr/bin/env node
// mavp-publish-overlay.js — overlays an assembled publish tree onto the public
// mirror clone's working tree, deleting genuinely-stale files while preserving
// public-native paths declared in scripts/publish-manifest.json's `preserve`
// bucket (T-356).
//
// Replaces the previously-documented `rsync -a --delete` re-sync step
// (docs/PUBLIC_RELEASE_STRATEGY.md §2 step 4), which unconditionally deleted
// any file present in the clone but absent from the assembled tree — including
// files that live ONLY in the public repo (e.g. .github/ISSUE_TEMPLATE/*),
// wiping them and committing the deletion on the very next sync.
//
// Behavior:
//   - Copy every file from the assembled tree into the clone (overwrite),
//     preserving subdirectories.
//   - Delete every file in the clone that is:
//       (a) NOT present in the assembled tree, AND
//       (b) NOT under .git/, AND
//       (c) NOT matched by a `preserve` entry in publish-manifest.json.
//   - Print a summary: "copied N, deleted M, preserved K" and list the
//     preserved paths, for auditability before a human commits/pushes.
//
// Usage: node scripts/mavp-publish-overlay.js <assembled-dir> <clone-dir>
//         [--allow-mass-delete] [--max-delete-ratio <0-1>]
//         [--max-dir-delete-ratio <0-1>] [--max-move-credit-ratio <0-1>]
//
// Deletion-ratio guard (T-504): defence in depth behind the primary
// non-empty-assembled-tree assertion in mavp-publish-build.js (T-501). Even
// if something upstream hands this script an empty or drastically reduced
// assembled tree, the overlay itself refuses to perform a disproportionate
// deletion rather than silently wiping the clone. See the design-decision
// comments on planDeletion() below for the ratio/denominator rationale.
//
// Per-directory composition guard (T-507): a refinement of the T-504 guard
// above, added because the whole-clone ratio has a structural blind spot — a
// manifest edit that drops one or more entire subdirectories from the ship
// set while the overall file COUNT stays inflated by other, unrelated
// tracked paths can clear the whole-clone ratio even though real structural
// content silently vanished. The baseline for this check is the mirror's OWN
// fetched `edge` tree — the clone working tree as it stands when this script
// runs, i.e. immediately after mavp-publish-build.js's stepCheckoutEdge() —
// which the existing dirty-clone refusal (stepCloneOrPull) and the
// divergence-abort (stepCheckoutEdge) together guarantee equals origin/edge.
// That means this check introduces NO new persisted state of its own:
// poisoning the baseline would require defeating those push gates or a
// force-push to the mirror, which is independently forbidden (DR-006). See
// findDirectoryViolations() below for the rule itself, and the Bootstrap
// case note further down for the deliberate residual (an empty clone — the
// first-ever publish — has no baseline and this check is vacuously skipped;
// the size floor and operator review of that one publish are the only cover
// there).
//
// Move credit (T-507 rounds 1-3) is the one mechanism that can suppress the
// composition guard's deletion counts, so it is the guard's soft spot and is
// constrained on four independent axes, each documented at its own
// definition: content + basename (buildMoveKey()), never for
// location-semantic source paths (isLocationSemantic()), only towards a
// RELATED destination (isRelatedMove(), round 3 mechanism 1), and never for
// more than a bounded fraction of the whole baseline in one run
// (exceedsMoveCreditCap(), round 3 mechanism 2). Tier 1's full-wipe rule
// consults move credit at no point at all (see adjustDirStatsForMoves()'s
// `rawDeleted`).
//
// Committed shape contract (T-533): the one tier here that is NOT a per-run
// delta guard. Every tier described above measures THIS run's deletions or
// relocations against a baseline, and that whole family is composition-
// defeatable in two independent ways, both reproduced by security review:
// credited relocation is count-preserving, so the move-credit budget renews in
// full on every publish (four consecutive runs each relocating just under the
// cap reach the same drained end state a single run would have been refused
// for), and the budgets' denominator is inflatable by unguarded ADDITIONS (a
// padding publish raises the baseline, so the next run's identical drain
// measures smaller). Narrowing move credit again cannot fix either — spreading
// the moves defeats any per-run shape rule. So the overlay also enforces a
// STATE contract: scripts/publish-shape-contract.json (committed, human-
// readable, shipped with the tree) declares a MINIMUM number of files that must
// appear DIRECTLY in each functional directory of the ASSEMBLED tree, and the
// overlay refuses before any write when the end state falls below any of them.
// Run composition is irrelevant to a check on the end state — four runs of 47
// relocations and one run of 147 hit the same floors on the same tree — and
// absolute floors never read the baseline, so additions cannot dilute them.
// See loadShapeContract()/findShapeContractViolations() below, and the ledger
// itself for the seeding fraction, its derivation and the documented residual.
//
// No external dependencies — uses only Node's `fs` + `path` + `crypto`
// (the last one for the move-detection content fingerprint below — still a
// Node built-in, zero npm installs).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

// T-533 — the committed shape contract's location, RELATIVE TO THE ASSEMBLED
// TREE (not to REPO_ROOT like MANIFEST_PATH above). Deliberate: the contract is
// a statement ABOUT the tree being published, so it must travel WITH that tree.
// Anchoring it to REPO_ROOT instead would apply this project's own floors to
// every tree any caller ever overlays — including an adopter project's tree and
// every small test fixture — which is why "absent ledger = silent skip" has to
// be evaluated against the assembled tree to mean anything. The trust level is
// unchanged either way: the assembled tree is produced by
// mavp-publish-assemble.js as an allow-list over the git index, so putting a
// different ledger there means committing a ledger edit or editing
// publish-manifest.json's ship bucket — the same reviewable diff the ledger's
// own `how_to_relax` field names as the sanctioned relaxation.
const SHAPE_CONTRACT_RELATIVE_PATH = 'scripts/publish-shape-contract.json';

// Default deletion-ratio ceiling (T-504): refuse when the planned deletion
// would remove more than this fraction of the clone's non-preserved tracked
// files. Overridable per-run via --max-delete-ratio; the BACKLOG acceptance
// criteria for T-504 explicitly calls this "a configurable threshold", so a
// flag is mandatory here, not a judgment call — --allow-mass-delete alone
// would not satisfy the criteria as written.
const DEFAULT_MAX_DELETE_RATIO = 0.5;

// T-507 — per-directory composition guard constants (see findDirectoryViolations()
// below for the rule they parameterize):
//
//   MIN_DIR_SIZE (default 5): a directory bucket smaller than this is NOT
//   ratio-checked on its own — the ratio math on 1-4 files is too noisy to
//   be a reliable signal (e.g. deleting 2 of 3 files is a 67% ratio that
//   ordinary cleanup would trip constantly), and small directories are
//   exactly where routine additions/removals happen during normal project
//   evolution. This also gives the empty-clone bootstrap case (Test 8
//   below, and the file header's Bootstrap case note) a vacuous pass for
//   free: a fresh clone has zero baseline files, so no directory bucket
//   ever reaches this floor.
//
//   Round-1 security review (F1) found that, measured against this
//   project's own real ship set, MIN_DIR_SIZE exempts 11 of 18 directories
//   from the ratio check ENTIRELY — and they are disproportionately the
//   directories carrying the project's own enforcement machinery
//   (`.claude/hooks/`, `.claude/rules/`, `.github/workflows/`), each a
//   single-digit file count. A one-line manifest edit dropping any one of
//   them (e.g. moving `.github/workflows/ci.yml` from `ship` to `exclude`)
//   was completely silent. Two independent, unconditional rules now cover
//   what the size floor alone cannot (see findDirectoryViolations()):
//   COMPLETE emptying of ANY bucket (deleted === total, total > 0) is
//   always a violation regardless of size — total loss is never routine
//   cleanup — and every bucket below MIN_DIR_SIZE is additionally folded
//   into ONE aggregate bucket that IS ratio-checked, so touching many
//   small, individually-exempt directories at once is no longer invisible
//   just because no single one of them crosses the floor.
//
//   DIR_MAX_DELETE_RATIO (default 0.5): same threshold as the whole-clone
//   ratio (DEFAULT_MAX_DELETE_RATIO) for consistency — a directory losing
//   more than half its own non-preserved content in one run is exactly as
//   suspicious per-directory as it is in aggregate, and reusing the same
//   number avoids inventing a second threshold to justify. Round-1 security
//   review (F2) noted the comparison used to read `ratio > dirMaxDeleteRatio`,
//   so an EXACT half-deletion silently passed; it is now `>=` (see
//   findDirectoryViolations()), applied identically to the whole-clone
//   check below. Per that same review: per-directory ratio-capping is
//   mathematically incapable of lowering the AGGREGATE volume ceiling much
//   below the whole-clone ratio itself — capping N independent buckets at
//   just-under-R still permits an aggregate close to R — so this guard's
//   real, defensible contribution is SHAPE (no bucket, and no aggregate of
//   small buckets, can be silently emptied past the ratio) rather than a
//   materially lower volume bound than T-504 already provides; see the
//   CHANGELOG entry, corrected to say so plainly.
const MIN_DIR_SIZE = 5;
const DIR_MAX_DELETE_RATIO = 0.5;

// T-507 round 1 (F1) — sentinel key for the aggregate bucket that every
// sub-MIN_DIR_SIZE directory is folded into for ratio-checking purposes.
// Deliberately starts with '(' — no real directory path (they use '/' as a
// separator and never start with a parenthesis) can collide with it.
const AGGREGATE_SMALL_DIR_LABEL = '(aggregated small directories, each individually below MIN_DIR_SIZE)';

// T-507 round 1 (F2, "absolute floor on the ship-set count delta") —
// sentinel key for the cross-directory budget-summing check: see
// findDirectoryViolations()'s final block. Per-directory ratio-capping
// alone is mathematically incapable of lowering the AGGREGATE volume
// ceiling much below the whole-clone ratio (N independent buckets each
// capped at just-under-R still sum to close to R) — round 1 review
// reproduced this concretely (a 35.2%/49.7% aggregate deletion, spread
// across several directories each individually within its own budget,
// stayed completely silent). A directory restructured ALONE keeps its full
// per-directory budget (DIR_MAX_DELETE_RATIO) — that is the common,
// legitimate case (a single-area reorg, F3). The moment MORE THAN ONE
// directory bucket is simultaneously touched, the combined deletion is held
// to a materially tighter ceiling: half of DIR_MAX_DELETE_RATIO. Spreading a
// deletion across many directories specifically to stay under each one's
// individual cap is exactly the pattern this closes.
const MULTI_DIR_AGGREGATE_LABEL = '(aggregate across multiple simultaneously-touched directories)';

// T-507 round 3 (N1', mechanism 2) — WHOLE-RUN MOVE-CREDIT CAP.
//
// Mechanism 1 (isRelatedMove()) is the principled fix; this is the backstop
// that generalises past anything relatedness misses, because an attacker CAN
// stay related: relocating every file into an attic directory INSIDE its own
// top-level segment (e.g. a `scripts/` file into `scripts/attic/`) preserves
// the first segment, preserves the basename, avoids a full wipe by leaving
// one file per bucket, and would otherwise drain almost the whole tree with
// every per-directory count zeroed out by credit. So the overlay also refuses
// when the TOTAL number of credited moves in one run is a large fraction of
// the baseline: no legitimate release relocates a quarter of the published
// tree in a single overlay.
//
// MOVE_CREDIT_MAX_RATIO (0.25): deliberately the same number as the
// multi-directory aggregate ceiling (DIR_MAX_DELETE_RATIO / 2) — the
// tightest aggregate bound this file already establishes — so no third
// independent threshold has to be justified. The margin is very wide in
// practice: measured against this project's own real ship set, the
// legitimate multi-directory reorg this guard exists to protect credits
// about 2% of the baseline, while the reproduced hostile run credits ~85%.
// Overridable per-run via --max-move-credit-ratio (T-532), following the
// exact precedent of the two ratio tiers above (--max-delete-ratio,
// --max-dir-delete-ratio): a legitimate restructure that trips ONLY this
// cap — e.g. splitting a large flat directory into subdirectories, every
// destination related, nothing deleted, no bucket emptied — must not force
// the operator to reach for --allow-mass-delete, which stands down every
// tier at once, including the full-wipe rule this file's design states
// must never be laundered. MOVE_CREDIT_MIN_COUNT below stays a fixed
// constant, not flag-governed — the 5-move absolute floor is the noise
// rationale documented on MIN_DIR_SIZE, not a threshold an operator should
// ever need to move.
//
// MOVE_CREDIT_MIN_COUNT (5): an absolute floor below which the ratio is not
// consulted at all, for exactly the reason documented on MIN_DIR_SIZE — the
// fraction is noise on tiny baselines, and a legitimate small reorg (moving
// 4 files of a 7-file tree into a subdirectory — Test 15) is a 57% ratio
// that must not be refused. With fewer than 5 credited moves the absolute
// loss any mis-credit could launder is at most 4 files, below the smallest
// bucket the per-directory rules police at all; above it, on any realistic
// tree, the ratio is what binds (25% of this project's real ship set is
// dozens of files, far above this floor).
//
// Deliberately NOT a per-bucket ceiling: that shape was disproved. The
// legitimate reorg credits 4 of one docs bucket's 7 files (57%), so any
// per-bucket ceiling at or below 50% breaks the very case move credit exists
// to protect. The cap is therefore whole-run only.
const MOVE_CREDIT_MAX_RATIO = 0.25;
const MOVE_CREDIT_MIN_COUNT = 5;

// T-507 round 3 (N1', mechanism 2) — pure predicate for the cap above, so it
// is unit-testable at its boundary independently of the CLI. Refuses (returns
// true) when the credited-move count reaches BOTH the absolute floor and the
// ratio ceiling. `>=` on the ratio, consistent with every other comparison in
// this file since round 1 (F2) found an exact-boundary hit passing silently
// under a strict `>`. A zero baseline (empty/fully-preserved clone — the
// first-ever publish) is vacuously safe, matching the whole-clone guard's own
// zero-denominator handling.
//
// T-532 — `maxRatio` is now a parameter, defaulting to MOVE_CREDIT_MAX_RATIO,
// so the CLI's --max-move-credit-ratio flag (see parseArgs()) can override
// the ceiling per run without touching MOVE_CREDIT_MIN_COUNT, which is
// deliberately NOT a parameter here (see its own comment above).
function exceedsMoveCreditCap(creditedMoveCount, nonPreservedCloneCount, maxRatio = MOVE_CREDIT_MAX_RATIO) {
  if (nonPreservedCloneCount <= 0) return false;
  if (creditedMoveCount < MOVE_CREDIT_MIN_COUNT) return false;
  return creditedMoveCount / nonPreservedCloneCount >= maxRatio;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// Parses argv (already stripped of argv[0]/argv[1]) into positional args
// plus the T-504/T-507 guard flags. Flags may appear anywhere among the
// positional args (before, between, or after).
function parseArgs(argv) {
  const positional = [];
  let allowMassDelete = false;
  let maxDeleteRatio = DEFAULT_MAX_DELETE_RATIO;
  let maxDirDeleteRatio = DIR_MAX_DELETE_RATIO;
  let maxMoveCreditRatio = MOVE_CREDIT_MAX_RATIO;

  const parseRatioFlag = (flagName, value) => {
    if (value === undefined) {
      fail(`${flagName} requires a value (e.g. ${flagName} 0.5)`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fail(`${flagName} must be a number between 0 and 1 (got: ${value})`);
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-mass-delete') {
      allowMassDelete = true;
    } else if (arg === '--max-delete-ratio') {
      maxDeleteRatio = parseRatioFlag('--max-delete-ratio', argv[i + 1]);
      i += 1; // consume the value
    } else if (arg.startsWith('--max-delete-ratio=')) {
      maxDeleteRatio = parseRatioFlag('--max-delete-ratio', arg.slice('--max-delete-ratio='.length));
    } else if (arg === '--max-dir-delete-ratio') {
      maxDirDeleteRatio = parseRatioFlag('--max-dir-delete-ratio', argv[i + 1]);
      i += 1; // consume the value
    } else if (arg.startsWith('--max-dir-delete-ratio=')) {
      maxDirDeleteRatio = parseRatioFlag('--max-dir-delete-ratio', arg.slice('--max-dir-delete-ratio='.length));
    } else if (arg === '--max-move-credit-ratio') {
      maxMoveCreditRatio = parseRatioFlag('--max-move-credit-ratio', argv[i + 1]);
      i += 1; // consume the value
    } else if (arg.startsWith('--max-move-credit-ratio=')) {
      maxMoveCreditRatio = parseRatioFlag('--max-move-credit-ratio', arg.slice('--max-move-credit-ratio='.length));
    } else {
      positional.push(arg);
    }
  }

  return { positional, allowMassDelete, maxDeleteRatio, maxDirDeleteRatio, maxMoveCreditRatio };
}

// T-504 deletion-ratio guard — single pass over the clone's file list that
// computes both the deletion plan (unchanged behavior) AND the ratio
// denominator, so the two can never drift apart.
//
// Design decisions (see the T-504 brief for the fuller design points):
//
//   - Denominator = "non-preserved tracked files in the clone", counted
//     BEFORE the overlay does anything: every path listCloneFilesExcludingGit
//     returns (which already excludes .git/ — the clone's own plumbing is
//     never part of "tracked content") MINUS every path matched by a
//     `preserve` manifest entry — preserved paths are, by definition, never
//     deletable by this script, so they contribute no risk and must not
//     dilute the ratio. Whether a path also happens to appear in the
//     assembled tree (and so would be overwritten, not deleted) does NOT
//     exclude it from the denominator — the denominator is "how much
//     content exists in the clone that this script is capable of deleting",
//     not "how much is about to be deleted"; that's the numerator.
//   - This script has no git dependency anywhere else in its design (it
//     never shells out to git — see listCloneFilesExcludingGit's plain
//     filesystem walk), and the working fixtures used to test it are plain
//     directories, not real git checkouts. Introducing a `git ls-files`
//     read here for "tracked" would (a) break against those fixtures unless
//     they were upgraded to real repos, and (b) diverge from the rest of
//     the script's filesystem-only model of "the clone's contents" (the
//     copy/delete loops below already treat every non-.git, non-preserved
//     path as fair game). So "tracked" is approximated, consistently with
//     the rest of the file, as "present in the clone's working tree,
//     outside .git". In the real deploy contour the clone IS a fresh
//     checkout of the mirror's branch tip immediately before the overlay
//     runs, so working-tree state and git-tracked state coincide in
//     practice; the residual risk (stray untracked cruft inflating the
//     denominator and so slightly under-counting the true ratio) is
//     documented here rather than silently assumed away, and is acceptable
//     for a defence-in-depth guard whose primary fix already lives upstream
//     in mavp-publish-build.js (T-501).
//   - Zero-denominator (empty or fully-preserved clone) is treated as
//     vacuously safe, not a division error: a fresh `edge` branch bootstrapped
//     from a bare `main` has zero clone files on the very first working-build
//     publish, so nonPreservedCloneCount is 0 and there is nothing to guard —
//     deletedCount is necessarily 0 too (you cannot delete more than zero
//     candidate files), so the ratio is moot. The guard is skipped entirely
//     in that case rather than computing 0/0.
//
// T-507 addition: the same single pass also builds `dirStats`, a
// Map<dir, {total, deleted}> keyed by dirOf(relPath) (see dirOf() below) —
// every non-preserved baseline file's immediate containing directory (root
// files use the empty-string pseudo-directory), counting how many of that
// directory's own files exist in the baseline (`total`) and how many are
// slated for deletion (`deleted`). This is deliberately a DIRECT-CHILDREN
// count, not a recursive one: a directory's bucket only reflects files whose
// dirname is EXACTLY that directory, never files nested further down. That
// is what makes "at any depth" work without a static expected-shape table —
// every directory that appears anywhere in the tree (root, `docs`, and
// `docs/core` are three separate, independent buckets) gets its own
// composition check, so dropping all of `docs/core/` trips the `docs/core`
// bucket directly even though it might be under half of the (unrelated,
// larger) `docs/` bucket as a whole.
function dirOf(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

// T-507 round 2 (N1, tier 2) — the final path segment. Move credit (see
// buildMoveKey()/detectMovedPaths() below) requires this to match between
// the deletion candidate and its claimed new-path counterpart: content
// reappearing under a DIFFERENT filename is not what an ordinary rename
// looks like, and requiring basename preservation closes the residual
// where a partial (non-full-wipe) deletion is laundered by relocating some
// of its files to differently-named copies elsewhere.
function basenameOf(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

// T-507 round 2 (N1, tier 2) — paths under these prefixes carry meaning
// FROM their location: a GitHub Actions workflow only runs from
// `.github/workflows/`, a git hook only fires from `.claude/hooks/`, and a
// rule/agent spec is only loaded from `.claude/rules/`/`.claude/agents/`.
// Relocating one of these files — even byte-identical, even under its own
// original basename — is never a benign rename; it is functional
// disablement while the bytes still ship (the scanner sees identical
// content, the size floor sees an identical count). Deletion candidates
// under these prefixes are therefore NEVER eligible for move credit,
// regardless of content or basename match — see isLocationSemantic() below
// and its use in main().
const LOCATION_SEMANTIC_PREFIXES = ['.github/', '.claude/hooks/', '.claude/rules/', '.claude/agents/'];

function isLocationSemantic(relPath) {
  return LOCATION_SEMANTIC_PREFIXES.some(
    (prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix)
  );
}

// T-507 round 3 (N1', mechanism 1) — the FIRST path segment of a relative
// path, or the empty string for a root-level file (no directory component at
// all). `docs/core/a.md` -> 'docs'; `a.md` -> ''.
function firstSegmentOf(relPath) {
  const idx = relPath.indexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

// T-507 round 3 (N1', mechanism 1) — DESTINATION RELATEDNESS. Rounds 1-2
// granted move credit on key match alone (content + basename), never asking
// WHERE the content reappeared. Round 3's review reproduced the consequence:
// leave exactly one file per directory bucket (defeats the full-wipe rule,
// which reads raw counts), preserve every basename (satisfies the move key),
// stay off the four LOCATION_SEMANTIC_PREFIXES, and re-add every dropped
// file's bytes under one unrelated destination directory — and the great
// majority of the ship set drains with every guard reporting zero loss, the
// secret scanner green (identical bytes) and the size floor green (identical
// count). For path-semantic files, location IS function: a `scripts/`
// directory drained to one file breaks every path-resolved entry point
// (including this overlay's own manifest path), and a drained root removes
// the licence, readme, package manifest and installer. The differential
// control proves move credit was the sole enabler — the identical drop
// WITHOUT the relocation adds was always refused.
//
// The rule implemented here is DERIVED, not enumerated (extending
// LOCATION_SEMANTIC_PREFIXES was explicitly rejected as the wrong shape — it
// misses skills directories, the settings file, the manifest, root-level
// files and templates, several of which are covered today only incidentally
// because they happen to be one-file buckets): move credit requires the
// destination to be RELATED to the source, i.e. to share the source's
// NON-EMPTY first path segment.
//
// Why "shared non-empty first segment" and not the literal
// "same-top-level-segment OR ancestor/descendant" phrasing: the
// ancestor/descendant half is VACUOUS for root-level files, because the root
// pseudo-directory (dirOf() === '') is an ancestor of every directory in the
// tree — so a root-level licence or installer relocated into an attic
// directory would still be credited, which is exactly one of the reproduced
// attack's buckets. Requiring a shared non-empty first segment is the
// non-vacuous form, and it already subsumes the useful part of
// ancestor/descendant: `docs/core/x.md` -> `docs/x.md` (up) and
// `scripts/a.js` -> `scripts/lib/a.js` (down) both share a non-empty first
// segment. A root-level source (no directory component) is therefore related
// only to a root-level destination — and since the move key also requires an
// identical basename, a root-to-root "move" would have to be the same path,
// which a deletion candidate never is. Root-level files consequently receive
// no move credit in practice, which is the correct posture for a bucket
// whose members are load-bearing precisely because of where they sit.
//
// Known, deliberate rejection: a move that crosses top-level directories
// (e.g. `docs/x.md` -> `templates/x.md`) is NOT credited, even though such a
// reorg can be perfectly legitimate. That is a bounded cost — an uncredited
// move only matters when the resulting counts actually trip one of the
// ratio/full-wipe rules, and the operator's documented path for a real
// cross-tree restructure is --allow-mass-delete (which now also reports what
// it suppressed).
function isRelatedMove(sourceRelPath, destRelPath) {
  const sourceSegment = firstSegmentOf(sourceRelPath);
  const destSegment = firstSegmentOf(destRelPath);
  if (sourceSegment === '') return destSegment === ''; // root-level source: root-level destination only
  return sourceSegment === destSegment;
}

function planDeletion(cloneFiles, assembledSet, preserveKeys) {
  const deletionCandidates = [];
  const preservedPaths = [];
  let nonPreservedCloneCount = 0;
  const dirStats = new Map();

  for (const relPath of cloneFiles) {
    const preserved = isPreserved(relPath, preserveKeys);
    if (!preserved) {
      nonPreservedCloneCount += 1;
      const dir = dirOf(relPath);
      let stat = dirStats.get(dir);
      if (!stat) {
        stat = { total: 0, deleted: 0 };
        dirStats.set(dir, stat);
      }
      stat.total += 1;
    }
    if (assembledSet.has(relPath)) continue; // (re)written by the copy step, never deleted
    if (preserved) {
      preservedPaths.push(relPath);
      continue;
    }
    deletionCandidates.push(relPath);
    dirStats.get(dirOf(relPath)).deleted += 1;
  }

  return { deletionCandidates, preservedPaths, nonPreservedCloneCount, dirStats };
}

// T-507 — evaluates the per-directory composition rule against the `dirStats`
// built by planDeletion() above (after move-adjustment — see
// adjustDirStatsForMoves() below; `dirStats` passed in here should already
// have moved-not-deleted files excluded from `deleted`, AND carry
// `rawDeleted` per bucket). Four independent rules, all checked, all sorted
// together into one violations list:
//
//   1. Full wipe, ANY size, using RAW (pre-move-credit) counts (T-507
//      round 1, F1; move-credit exclusion added round 2, N1 tier 1): a
//      bucket with `rawDeleted === total && total > 0` is always a
//      violation, regardless of MIN_DIR_SIZE and regardless of whether
//      move-detection would otherwise have credited some of those files as
//      moved — completely emptying a directory is unambiguously a
//      structural drop, never routine cleanup, and "this directory no
//      longer exists" can never be laundered by relocating its bytes
//      elsewhere (a functionally destructive move — e.g. a git hook or a
//      CI workflow relocated out of the path it only functions from — is
//      exactly what move-credit must NOT excuse here). This is the one
//      rule the size floor never gets to exempt, AND the one rule
//      move-credit never gets to exempt either.
//   2. Per-directory ratio, buckets >= minDirSize (uses MOVE-ADJUSTED
//      `deleted` — a partial, non-total loss can still legitimately be a
//      rename): a violation when
//      `deleted / total >= dirMaxDeleteRatio` (>=, not >, since round 1 (F2)
//      found an EXACT half-deletion silently passed under the original `>`).
//   3. Aggregate of every bucket BELOW minDirSize (T-507 round 1, F1): every
//      sub-minDirSize bucket's total/deleted is folded into ONE synthetic
//      bucket (AGGREGATE_SMALL_DIR_LABEL), which is itself ratio-checked
//      (same >= rule, same minDirSize floor applied to the aggregate's own
//      total) — this is what catches a manifest edit touching many small,
//      individually-exempt directories at once (this project's own
//      `.claude/hooks/`, `.claude/rules/`, `.github/workflows/`, etc.),
//      which stayed invisible under per-bucket-only checking. Buckets
//      already flagged by rule 1 (a full wipe) are excluded from the
//      aggregate sum — they are already reported on their own, and folding
//      them in too would just double-count the same underlying file loss.
//   4. Cross-directory budget-summing (T-507 round 1, F2 — see
//      MULTI_DIR_AGGREGATE_LABEL's comment): once MORE than one bucket is
//      simultaneously touched, the combined deletion across ALL touched
//      buckets (excluding full-wipe ones, already reported alone) must stay
//      under HALF of dirMaxDeleteRatio — closing the loophole where several
//      directories, each individually within its own budget, sum to a large
//      aggregate that neither rule 2 nor the whole-clone ratio would ever
//      see as suspicious on its own.
//
// The empty-clone bootstrap case (dirStats empty) yields zero violations
// from all four rules — vacuously safe, matching the whole-clone guard's
// own zero-denominator handling. Returns violations sorted by directory
// label for deterministic, reproducible error output.
function findDirectoryViolations(dirStats, minDirSize, dirMaxDeleteRatio) {
  const violations = [];
  let aggregateTotal = 0;
  let aggregateDeleted = 0;
  // T-507 round 1 (F2) — cross-directory budget-summing tally. Deliberately
  // excludes buckets already flagged as a full wipe (see the `continue`
  // above) — those are already reported on their own, so folding them in
  // here too would just double-count the same underlying file loss.
  let touchedBuckets = 0;
  let totalAcrossTouchableBuckets = 0;
  let deletedAcrossTouchableBuckets = 0;

  for (const [dir, stat] of dirStats) {
    // T-507 round 2 (N1, tier 1) — full-wipe uses the RAW (pre-move-credit)
    // deleted count. `rawDeleted` is only present when the caller passed a
    // move-adjusted Map (adjustDirStatsForMoves()); a raw `planDeletion()`
    // Map (as used directly by several tests, and by any future caller with
    // no move detection at all) has no such field, so this falls back to
    // `stat.deleted` — which, on a non-move-adjusted Map, already equals
    // the raw count anyway.
    const rawDeleted = stat.rawDeleted !== undefined ? stat.rawDeleted : stat.deleted;
    if (stat.total > 0 && rawDeleted === stat.total) {
      violations.push({ dir, deleted: rawDeleted, total: stat.total, ratio: 1, reason: 'full-wipe' });
      continue;
    }

    totalAcrossTouchableBuckets += stat.total;
    deletedAcrossTouchableBuckets += stat.deleted;
    if (stat.deleted > 0) touchedBuckets += 1;

    if (stat.total < minDirSize) {
      aggregateTotal += stat.total;
      aggregateDeleted += stat.deleted;
      continue;
    }

    const ratio = stat.deleted / stat.total;
    if (ratio >= dirMaxDeleteRatio) {
      violations.push({ dir, deleted: stat.deleted, total: stat.total, ratio, reason: 'ratio' });
    }
  }

  if (aggregateTotal >= minDirSize) {
    const aggregateRatio = aggregateDeleted / aggregateTotal;
    if (aggregateRatio >= dirMaxDeleteRatio) {
      violations.push({
        dir: AGGREGATE_SMALL_DIR_LABEL,
        deleted: aggregateDeleted,
        total: aggregateTotal,
        ratio: aggregateRatio,
        reason: 'aggregate',
      });
    }
  }

  // T-507 round 1 (F2) — see MULTI_DIR_AGGREGATE_LABEL's comment for the
  // full rationale. Only engages once MORE THAN ONE directory bucket is
  // simultaneously touched (a single-area restructure keeps its full
  // per-directory budget); uses the SAME (move-adjusted, by the caller)
  // counts as every other rule in this function, so a multi-directory
  // rename/reorg — all moves, zero true loss — never trips it.
  if (touchedBuckets > 1 && totalAcrossTouchableBuckets > 0) {
    const multiDirRatio = deletedAcrossTouchableBuckets / totalAcrossTouchableBuckets;
    const multiDirCeiling = dirMaxDeleteRatio / 2;
    if (multiDirRatio >= multiDirCeiling) {
      violations.push({
        dir: MULTI_DIR_AGGREGATE_LABEL,
        deleted: deletedAcrossTouchableBuckets,
        total: totalAcrossTouchableBuckets,
        ratio: multiDirRatio,
        reason: 'multi-directory-aggregate',
      });
    }
  }

  violations.sort((a, b) => a.dir.localeCompare(b.dir));
  return violations;
}

// T-507 round 1 (F3) — a rename/move (a file that reappears in the assembled
// tree at a DIFFERENT path, byte-identical content) is NOT genuine deletion,
// and per-directory buckets are small enough denominators that an ordinary
// reorg (e.g. moving most of one directory's files into a sibling) can
// otherwise trip the ratio guard even though nothing was lost — the failure
// mode the brief warned about: the guard cries wolf on ordinary evolution,
// the first inconvenienced operator reaches for --allow-mass-delete, and
// BOTH guards (whole-clone and per-directory) go with it.
//
// T-507 round 2 (N1, tier 2) — round 1's matching was content-only: no
// basename check, no location denylist, no cap. That let ANY deletion
// candidate's bytes reappearing at ANY new path launder it as a move,
// including a single inert copy planted anywhere in the tree, for a
// deletion of any size (not just a full wipe — see tier 1's
// `rawDeleted`/`adjustDirStatsForMoves()` fix for that half of this, which
// this function's caller (main()) does not depend on). This function's
// caller now builds each Map's values as MOVE KEYS via buildMoveKey()
// (basename + content hash, see below) rather than a bare content hash,
// and never includes a deletion candidate under isLocationSemantic() at
// all — so this function's own matching logic is unchanged (it still just
// consumes matching-key supply 1:1), but what counts as "matching" is now
// strictly narrower.
//
// T-507 round 3 (N1', mechanism 1) — key match is no longer sufficient: the
// matched destination must ALSO be related to the source (isRelatedMove()
// above). Rounds 1-2 built the supply as a Map<moveKey, count>, which
// discarded the destination path entirely and made relatedness impossible to
// evaluate here; the supply is now Map<moveKey, destPath[]> so each candidate
// is matched against a destination that is BOTH key-matching AND related.
// The 1:1 consumption semantics are unchanged (a matched destination is
// removed from the supply, so duplicate keys are matched one-for-one, never
// many-to-one).
//
// `deletionCandidateHashes` — Map<relPath, moveKey> for every ELIGIBLE
// (non-semantic-location) path planDeletion() marked as a deletion
// candidate (present in the clone, absent from the assembled tree at that
// same path).
// `newAssembledHashes` — Map<relPath, moveKey> for every assembled path
// that is NOT present in the clone at that same path (i.e. genuinely new
// content, OR a move's destination — this function cannot tell those apart
// by path alone, only by the key plus relatedness).
//
// A deletion candidate is reclassified as "moved" when its key matches an
// available (not yet claimed) new-assembled-path key AT A RELATED
// DESTINATION; matching consumes one unit of that key's supply, so duplicate
// keys are matched 1:1, not many:1.
// Known, accepted limitation: two files with byte-identical content AND the
// same basename (most notably two same-named empty files) are
// indistinguishable by key alone, so a coincidental collision between an
// unrelated deletion and an unrelated addition could be misclassified as a
// "move" — this only ever makes the guard MORE lenient (fewer violations
// among the non-full-wipe, non-semantic-location rules that still consult
// `deleted`), never less, and tier 1's full-wipe rule is immune to it
// entirely (it never reads move-adjusted counts), so it cannot be used to
// force a false refusal, only (rarely, and harmlessly) to under-count a
// genuine small deletion that happens to share both content and name with
// something added elsewhere in the same run.
function detectMovedPaths(deletionCandidateHashes, newAssembledHashes) {
  // Map<moveKey, destPath[]> — the destination paths still available to be
  // claimed under each key, in assembled-tree listing order (deterministic).
  const supply = new Map();
  for (const [destRelPath, hash] of newAssembledHashes) {
    let destinations = supply.get(hash);
    if (!destinations) {
      destinations = [];
      supply.set(hash, destinations);
    }
    destinations.push(destRelPath);
  }

  const moved = new Set();
  for (const [relPath, hash] of deletionCandidateHashes) {
    const destinations = supply.get(hash);
    if (!destinations || destinations.length === 0) continue;
    const matchIndex = destinations.findIndex((destRelPath) => isRelatedMove(relPath, destRelPath));
    if (matchIndex === -1) continue; // key matches, but only at UNRELATED destinations — no credit
    destinations.splice(matchIndex, 1); // consume one unit of supply (1:1, never many:1)
    moved.add(relPath);
  }
  return moved;
}

// T-507 round 2 (N1, tier 2) — the composite key move-credit matching is
// actually performed on: basename (see basenameOf()) plus content
// fingerprint (see fingerprintPath()), joined with '::'. fingerprintPath()'s
// output is either a 64-hex-char sha256 digest or `symlink:<target>` — never
// itself containing '::' — and a basename (the final path segment) cannot
// contain '/', so ambiguous collisions between "a basename that happens to
// end in the literal text before '::'" and "the real separator" are not a
// practical concern; a basename containing the literal substring '::' would
// need to ALSO collide on the full remaining hash to produce a false match,
// which is exactly as unlikely as any other content-hash collision this
// file already accepts as a residual (see detectMovedPaths()'s own comment).
// Content alone is not enough — see detectMovedPaths()'s file-level comment
// for why requiring the SAME basename closes the residual round 1 left open.
function buildMoveKey(relPath, contentHash) {
  return `${basenameOf(relPath)}::${contentHash}`;
}

// T-507 round 1 (F3) — returns a NEW dirStats Map with each moved path's
// directory bucket's `deleted` count decremented by one (never below zero).
// `total` is deliberately left unchanged: the file genuinely existed in that
// directory in the baseline, so "how much content existed here" is
// unaffected by where it ends up — only "how much of it is truly gone"
// (`deleted`) is adjusted. Does not mutate the input Map.
//
// T-507 round 2 (N1, tier 1) — each bucket also carries `rawDeleted`, the
// UNADJUSTED deleted count from before move-credit was applied.
// findDirectoryViolations()'s full-wipe rule reads `rawDeleted`, never
// `deleted`: round 1's move-credit had no basename check, no semantic-path
// denylist, and no cap, so ANY deletion candidate whose bytes reappeared at
// ANY new path — including a single inert copy planted under an unrelated
// directory — was credited as a move and erased a full-wipe finding
// entirely, laundering a functionally destructive relocation (e.g.
// `.claude/hooks/pre-commit` moved to `docs/attic/`, which kills the hook
// while the bytes still ship) as an ordinary rename. A directory that ends
// up with ZERO of its original files remaining is empty regardless of
// where those bytes went; "this directory no longer exists" can never be
// laundered by move-credit, so the full-wipe rule intentionally does not
// receive it.
//
// T-507 round 3 (N1', mechanism 3) — IDEMPOTENCY of `rawDeleted`. Round 2
// recorded as a LOW note that a SECOND call overwrote `rawDeleted` with the
// already-move-adjusted `deleted` count, silently reverting tier 1's
// immunity to move credit: feed this function's own output back in and the
// full-wipe rule would start reading credited-away counts, exactly the
// laundering tier 1 exists to refuse. An existing `rawDeleted` is now
// PRESERVED, making a second call a no-op with respect to it (the `deleted`
// count still adjusts, which is the composable, intended part). Preserve
// rather than throw, deliberately: this is a fail-safe guard whose whole
// job is to refuse rather than crash, and preserving the original raw
// baseline keeps repeated application monotonically SAFER (tier 1 keeps
// seeing the true pre-credit loss) — whereas throwing would convert a
// harmless double call into a hard failure of the publish pipeline with no
// security benefit.
function adjustDirStatsForMoves(dirStats, movedRelPaths) {
  const adjusted = new Map();
  for (const [dir, stat] of dirStats) {
    adjusted.set(dir, {
      total: stat.total,
      deleted: stat.deleted,
      rawDeleted: stat.rawDeleted !== undefined ? stat.rawDeleted : stat.deleted,
    });
  }
  for (const relPath of movedRelPaths) {
    const dir = dirOf(relPath);
    const stat = adjusted.get(dir);
    if (stat && stat.deleted > 0) stat.deleted -= 1;
  }
  return adjusted;
}

// Impure — reads from disk. A symlink's fingerprint is its link-target
// string (never dereferenced, mirroring copyFile()'s symlink handling
// elsewhere in this file); a regular file's fingerprint is a sha256 of its
// bytes. Used only to detect moves (F3) — never for anything security-
// sensitive, so sha256 (not a cryptographic-collision-hardened choice) is a
// deliberate, adequate tool for the job.
function fingerprintPath(baseDir, relPath) {
  const absPath = path.join(baseDir, relPath);
  const stat = fs.lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    return `symlink:${fs.readlinkSync(absPath)}`;
  }
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function loadPreserveBucket() {
  let raw;
  try {
    raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  } catch (err) {
    fail(`could not read manifest at ${MANIFEST_PATH}: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    fail(`could not parse manifest at ${MANIFEST_PATH}: ${err.message}`);
  }
  return manifest.preserve && typeof manifest.preserve === 'object' ? manifest.preserve : {};
}

// T-533 — loads the committed shape contract from the ASSEMBLED tree (see
// SHAPE_CONTRACT_RELATIVE_PATH), following loadPreserveBucket()'s pattern
// above with one deliberate difference in the absent case:
//
//   - ABSENT file  -> returns null, and the caller skips the tier silently.
//     This is what keeps adopter repos, the bootstrap publish and every
//     pre-existing test fixture unaffected: a tree that declares no contract
//     is not checked against one.
//   - PRESENT but unreadable/malformed -> HARD REFUSAL (fail(), exit 1). A
//     ledger that exists but cannot be parsed, or whose floors are not
//     integers of at least 1, must never degrade to "no contract" — that would
//     turn a one-character edit (a stray comma, a floor quoted as a string)
//     into a silent stand-down of the only non-delta tier in this file.
//
// T-540 (T-533 security review, residual 1) — that promise had three holes, all
// reproduced: a ledger declaring an EMPTY `min_direct_files` object, a ledger
// declaring an explicit floor of 0, and a DUPLICATE key whose last value is 0
// (JSON.parse keeps the last) each loaded successfully, enforced nothing, and
// exited 0 with no output — precisely the "degrade to no contract" the paragraph
// above forbids, reachable by a one-character edit. Two rules close all three:
//
//   - A floor below 1 is refused (it used to be below 0). This is not a new
//     policy invented here, it is the ledger's own documented one: its
//     derivation block states every floor is clamped up to a minimum of 1
//     precisely because "a floor of 0 would be a no-op entry". The loader now
//     refuses exactly what its own ledger forbids.
//   - An EMPTY declared set is refused. A present ledger declaring zero floors
//     is not a contract; it is a stand-down wearing a contract's filename, and
//     it is the cheapest possible edit (delete the object's contents). Standing
//     the tier down is a sanctioned operator action, but only via the two
//     REVIEWABLE routes the ledger's `how_to_relax` names — deleting the file,
//     or dropping it from the manifest's ship bucket — never by emptying it in
//     place while the file keeps existing and the log keeps looking normal.
//
// T-541 (T-540 security review, residual 1 continued) — the two rules above
// only close a duplicate key whose LAST value is 0. A duplicate whose LAST
// value is a REAL, nonzero floor that the tree already satisfies restores the
// identical nine-file enforcement evacuation at exit 0, and it is WORSE than
// the zero-value shape because it defeats every other observation channel at
// once: the diff still shows the raised value and reads as an ordinary
// addition, JSON.parse reports the correct KEY COUNT with no anomaly (it
// silently collapses the duplicate to its last value before anything here
// ever sees it), and the enforcement signal below is byte-identical because
// it counts keys rather than checking for repetition. The premise floated
// against this residual — "a surviving duplicate must now carry a nonzero
// floor, i.e. a real floor" — does NOT close it and is deleted here rather
// than preserved: for these small directories a floor of 1 is functionally
// identical to 0 (both just mean "not empty"), which the pre-existing
// full-wipe rule already guarantees for free, so a duplicate landing on 1 (or
// any other nonzero value the tree happens to satisfy) is not actually
// covered by the below-1 rule at all.
//
// There is no way to detect a duplicate key from the PARSED object — by the
// time `declared` exists, JSON.parse has already collapsed it to one entry.
// The check below therefore runs on the RAW TEXT, deliberately narrowed to
// the flat `min_direct_files` object's own span (marker to its own matching
// closing brace, via sliceMinDirectFilesObjectText() below) and never the
// whole file: this ledger's own `derivation.observed_direct_file_counts_at_seeding`
// object legitimately repeats every directory key a second time, so a
// whole-file occurrence count would false-refuse every valid ledger. Within
// that narrowed span, if the number of quoted-key-colon occurrences exceeds
// the number of keys JSON.parse actually kept, some key was declared more
// than once — refuse and name it, regardless of whether the repeated values
// differ or are equal (a check that compares only the two values would miss
// an equal-value duplicate, which is just as much an unreviewed second
// declaration as a differing one).
// ---------------------------------------------------------------------------

// Returns the raw-text span of the FLAT declared `min_direct_files` object
// only — from its own `"min_direct_files":` marker to that object's own
// matching closing brace (brace-depth tracked, so nesting can't confuse it),
// never the whole file. Returns null if the marker or a balanced brace can't
// be found (JSON.parse above will already have failed in that case, so the
// caller never reaches this path with a genuinely malformed file).
function sliceMinDirectFilesObjectText(raw) {
  const marker = /"min_direct_files"\s*:/.exec(raw);
  if (!marker) return null;
  const braceStart = raw.indexOf('{', marker.index + marker[0].length);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(braceStart, i + 1);
    }
  }
  return null; // unbalanced braces — JSON.parse above will already have failed
}

// Returns Map<dir, floor> where `dir` is a dirOf()-style relative directory
// path and the empty string is the root pseudo-directory.
function loadShapeContract(assembledDir) {
  const contractPath = path.join(assembledDir, ...SHAPE_CONTRACT_RELATIVE_PATH.split('/'));
  let raw;
  try {
    raw = fs.readFileSync(contractPath, 'utf8');
  } catch {
    return null; // no contract declared for this tree — tier is skipped silently
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`could not parse the publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH}: ${err.message}`);
  }
  const declared = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed.min_direct_files
    : undefined;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    fail(
      `the publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH} has no "min_direct_files" object — ` +
      'refusing rather than silently proceeding with no contract'
    );
  }
  // T-541 — DUPLICATE-KEY refusal, on the raw text (see the header comment
  // above loadShapeContract for the full reasoning). JSON.parse has already
  // collapsed any duplicate to its last value by the time `declared` exists,
  // so this compares how many times a key was WRITTEN (raw-text occurrences,
  // scoped to the flat object's own span) against how many keys survived
  // parsing. A mismatch means some key was declared more than once —
  // regardless of whether the repeated values differ or are equal.
  const minDirectFilesSlice = sliceMinDirectFilesObjectText(raw);
  if (minDirectFilesSlice !== null) {
    const keyOccurrences = new Map();
    for (const match of minDirectFilesSlice.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
      keyOccurrences.set(match[1], (keyOccurrences.get(match[1]) || 0) + 1);
    }
    let totalOccurrences = 0;
    for (const count of keyOccurrences.values()) totalOccurrences += count;
    if (totalOccurrences > Object.keys(declared).length) {
      const [dupKey] = [...keyOccurrences.entries()].find(([, count]) => count > 1) || [];
      fail(
        `the publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH} declares the key ` +
        `"${dupKey === '' ? '(root)' : dupKey}" more than once in its "min_direct_files" object — ` +
        "refusing rather than silently keeping JSON.parse's last value: a duplicate key defeats every " +
        'other observation channel at once (the diff still reads as an addition, the parsed key count ' +
        'shows no anomaly, and the enforcement signal counts keys rather than strength), regardless of ' +
        'whether the repeated values differ or are equal'
      );
    }
  }
  const floors = new Map();
  for (const [dir, floor] of Object.entries(declared)) {
    // T-540 — below 1, not below 0: a floor of 0 is satisfied by an EMPTY
    // directory, so it enforces nothing at all. See the header note above.
    if (!Number.isInteger(floor) || floor < 1) {
      fail(
        `the publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH} declares a non-integer or ` +
        `below-1 floor for "${dir === '' ? '(root)' : dir}" (got: ${JSON.stringify(floor)}) — ` +
        'every floor must be an integer of at least 1: a floor of 0 is a no-op entry satisfied by an ' +
        "empty directory, which this ledger's own derivation already forbids by clamping every floor " +
        'up to a minimum of 1'
      );
    }
    floors.set(dir, floor);
  }
  // T-540 — a present ledger that declares NO floors is a stand-down, not a
  // contract. Refuse it here rather than returning an empty Map that would make
  // findShapeContractViolations() vacuously green on every tree.
  if (floors.size === 0) {
    fail(
      `the publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH} declares an EMPTY ` +
      '"min_direct_files" set — refusing rather than silently proceeding with no contract: a ledger ' +
      'that declares zero floors enforces nothing, so emptying it in place would stand this tier down ' +
      'while the file keeps existing and the run keeps looking normal'
    );
  }
  return floors;
}

// T-541 round 2 — extracted so the succession gate below can reuse the exact
// same direct-child counting rule findShapeContractViolations() already used
// (rule 2, "REAL": a re-seeded observed count must equal the assembled
// tree's OWN live direct count, not a re-derived one that could disagree).
function buildDirectCountMap(files) {
  const directCounts = new Map();
  for (const relPath of files) {
    const dir = dirOf(relPath);
    directCounts.set(dir, (directCounts.get(dir) || 0) + 1);
  }
  return directCounts;
}

// T-533 — the contract rule itself, deliberately a PURE function of the
// ASSEMBLED tree's own file list plus the declared floors. Note the signature:
// there is no clone/baseline parameter, and there cannot be one. That absence
// IS the mechanism — a floor derived from any fraction of the baseline would be
// just another delta guard with the same two structural defeats (renew it by
// splitting the drain across runs, dilute it by inflating the baseline with
// additions), whereas an absolute floor on the end state cannot be renewed or
// diluted by anything a run's composition does.
//
// Counting is DIRECT-CHILDREN only, matching dirOf() (and matching the
// per-directory bucket semantics used by planDeletion()/findDirectoryViolations()
// above). That is load-bearing rather than incidental: it is precisely why the
// attic-relocation shape is caught, because `scripts/attic/x.js` counts towards
// the `scripts/attic` bucket and NOT towards `scripts`, so draining a directory
// into a subdirectory of itself lowers that directory's own direct count even
// though nothing was deleted and every relocation was legitimately credited.
//
// A declared directory absent from the assembled tree counts as 0 (and so
// violates any floor of 1 or more). `count === floor` PASSES: a floor is a
// minimum, not a trip-line — this file's own history (round 1, F2: an exact
// half-deletion passing silently under a strict `>`) is why that boundary is
// stated explicitly here and pinned by its own test.
//
// Returns violations sorted by directory label, for deterministic output.
function findShapeContractViolations(assembledFiles, floors) {
  const directCounts = buildDirectCountMap(assembledFiles);
  const declared = floors instanceof Map ? floors.entries() : Object.entries(floors || {});
  const violations = [];
  for (const [dir, floor] of declared) {
    const count = directCounts.get(dir) || 0;
    if (count < floor) violations.push({ dir, count, floor });
  }
  violations.sort((a, b) => a.dir.localeCompare(b.dir));
  return violations;
}

// T-533 — shared rendering for one findShapeContractViolations() entry.
// Deliberately contains NOTHING run-variable (no baseline count, no ratio, no
// path outside the tree): the identical drain must produce a byte-identical
// refusal whether or not a padding publish preceded it, and that property is
// asserted differentially in the tests.
function formatShapeContractLine(v) {
  const label = v.dir === '' ? '(root)' : v.dir;
  return `  - ${label}: ${v.count} file(s) directly, below the committed floor of ${v.floor}`;
}

// T-541 (T-540 residual 3) — the enforcement signal's digest term. Sorted
// dir=floor pairs, joined by a comma, sha256'd, first 12 hex characters. Sorting
// makes the digest independent of the ledger's own key order (Map insertion
// order would otherwise leak into the digest for no reason); the pair format
// (rather than, say, a sum) means changing ANY single floor changes the whole
// digest — see the call site's comment for why a sum was rejected.
//
// T-541 round 2 — scope note, deliberate, no code change here: this digest is
// over the PARSED `min_direct_files` MAP only, never the ledger's `derivation`
// block (the seeding record: observed counts, seeded_on). That scope is
// intentional, not an oversight — a digest that also covered `derivation`
// would change on every honest re-seed too, making "the floors changed" and
// "the seeding record was refreshed" indistinguishable from the digest alone.
// Visibility into a derivation-only edit (a re-seed, or a bare `seeded_on`
// bump) is instead owned entirely by the succession gate below
// (checkShapeContractSuccession()) — see its own header comment for the three
// rules and the whole-line output it prints on that path. Test 40's
// PRECOMPUTED digest literals are for this narrower scope and are unchanged.
function shapeContractDigest(floors) {
  const entries = floors instanceof Map ? [...floors.entries()] : Object.entries(floors || {});
  const pairs = entries.map(([dir, floor]) => `${dir}=${floor}`).sort();
  return crypto.createHash('sha256').update(pairs.join(',')).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// T-541 rounds 2+3 — the SUCCESSION GATE.
//
// Round 1's Test 41 recompute invariant reads BOTH its inputs — the recorded
// observed counts and the floor map it validates — from the SAME editable
// ledger file. A coherent one-shot forgery of both passes by construction:
// security review reproduced it end to end on the real assemble -> overlay
// pipeline, editing `observed_direct_file_counts_at_seeding["docs/assets"]`
// from the true 9 down to 3 and `min_direct_files["docs/assets"]` down to
// `floor_rule(3, 0.6)` = 2 in the same commit — every in-ledger check,
// Test 41 included, passes against the attacker's own ledger. No in-file
// predicate can ever close this: the seeding rule is codified IN the file, so
// a forger has everything the test has. Three alternatives were considered
// and rejected: recomputing from LIVE counts has no discriminator (both the
// attack and ordinary growth record BELOW live); in-file append-only-ness is
// defeated by one coherent rewrite of the whole chain; strict
// recorded-equals-live on every run reddens on ordinary growth, which is the
// exact defect Test 39/T-540 already fixed for the floor side.
//
// The fix needs an anchor the SAME commit cannot rewrite. The destination
// CLONE already holds the PREVIOUSLY PUBLISHED ledger — a one-step history no
// attacker commit can retroactively edit, already read here in this read-only
// planning phase (loadClonePublishedLedger() below) alongside the assembled
// tree's own copy.
//
// T-541 round 2 shipped that anchor but left the ACTIVATION condition
// lenient: it short-circuited to dormant whenever the ATTACKER-EDITABLE
// assembled ledger's derivation was missing or partial, and its per-key
// rules iterated EVERY recorded key rather than the ones that actually
// changed. Round 3 closes both holes. The decision function is now TOTAL
// over the assembled side whenever the clone anchor is full — exactly THREE
// accepted states, everything else refuses before any write:
//   - record byte-identical to what the clone last published -> SILENT
//     (ordinary tree growth stays green).
//   - a valid, DATED, delta-verified RE-SEED -> LOUD (a re-seed line, plus
//     any weakening/removed-key lines).
//   - the ledger deleted from the assembled tree entirely -> LOUD STAND-DOWN
//     (how_to_relax's own sanctioned relaxation, made visible rather than
//     silent).
// Every other assembled shape against a full clone anchor — absent
// derivation, partial derivation, a malformed date — REFUSES.
//
// An honest change to the seeding record is, by definition, a RE-SEED, and a
// re-seed has three properties observable AT the publish where it lands. All
// three are checked ONLY when the seeding record itself has actually
// changed — which now includes a bare `derivation.seeded_on` rewrite, not
// just the observed-counts map (round 2's `recordChanged` ignored
// `seeded_on` entirely, despite this header already claiming the gate owned
// bare-bump visibility) — so a publish where NEITHER changed never reaches
// any of them, which is what keeps ordinary tree growth silent and green:
//   1. DATED     — derivation.seeded_on must strictly advance past the
//                  clone's previously published seeded_on. A record that
//                  changed without its date advancing is a falsified
//                  historical observation. Canonical YYYY-MM-DD format is
//                  validated ONLY on the about-to-be-published date, and
//                  ONLY here (never on a dormant publish); a non-canonical
//                  PUBLISHED date (pre-round-3 history the operator cannot
//                  edit) is never refused on its shape — only the
//                  strict-advance comparison is skipped for that one
//                  publish, loudly, so a canonical successor date is never
//                  wedged forever by a malformed lexicographic predecessor.
//   2. REAL      — every re-seeded observed count must equal the assembled
//                  tree's OWN actual direct count at THIS publish (reusing
//                  buildDirectCountMap(), the exact rule
//                  findShapeContractViolations() already uses). The re-seed
//                  moment is the one moment recorded and live must coincide
//                  by definition — this is what keeps the gate dormant on
//                  every publish where the record is untouched, unlike a
//                  strict recorded-equals-live rule applied on every run.
//   3. REACHABLE — every re-seeded observed count must be >= the CLONE's
//                  previously published FLOOR for that directory (the old
//                  FLOOR, deliberately not the old observed count):
//                  legitimate shrinkage from 9 toward a floor of 5, followed
//                  by an honest re-seed AT 5, must pass.
// Rules 2 and 3 are scoped to the DELTA — the directories whose recorded
// observed count actually changed (computeObservedDelta() below) — not
// every recorded key. Iterating every key blamed directories nobody
// touched: a sanctioned partial re-seed of one directory was refused citing
// an UNTOUCHED directory whose recorded count had merely drifted from
// ordinary repo growth (reproduced live: re-seeding docs/assets alone,
// refused citing scripts at a recorded 108 against a live 114). Brand-new
// keys get REAL but not REACHABLE (there is no previously published floor
// to reach for a key that did not exist before — a documented residual).
// Record-removed keys print a loud, non-refusing line rather than
// participating in either rule.
//
// Separately, on EVERY publish where BOTH sides carry a full anchor (record
// changed or not): a floor that moved DOWN, or a declared key that was
// dropped entirely, relative to the clone's previously published ledger,
// prints a loud, NON-refusing WEAKENING line naming the directory and both
// values. This must never be a refusal — the ledger's own how_to_relax names
// "lower a floor, leave the record alone" as the sanctioned relaxation, and
// refusing it here would contradict the ledger's own contract.
//
// Guarantee actually delivered: per-step MONOTONICITY plus MANDATORY
// VISIBILITY — never "forgery is impossible". Residuals, deliberately left
// open (see the ledger's own `succession_gate` field for the operator-facing
// statement of the same four):
//   (a) GENESIS and RECORD-INTRODUCTION — a clone with no ledger at all, or
//     one whose own anchor is itself partial (e.g. a legacy floors-only
//     ledger), has nothing complete to succeed a full derivation against.
//     T-541 round 4: this is no longer silent. Both cases are now a single
//     RECORD-INTRODUCTION event, format- and COHERENT-checked (see the
//     ROUND 4 section below), printing a loud, non-refusing INTRODUCED line
//     rather than refusing an operator who is honestly completing the
//     ledger for the first time. T-541 round 4 CORRECTED: its observed
//     counts are recorded AS CLAIMED, NOT verified against the live tree
//     (trust-on-first-use) — see the ROUND 4 CORRECTED section below for
//     why REAL does not belong here, unlike an established re-seed;
//   (b) an N-step LOUD RATCHET (re-seed 9->5 [weakening line], drain, re-seed
//     5->3 [weakening line], drain, ...) — each step is dated and its own
//     reviewable ledger diff plus a printed weakening event, but nothing
//     here stops a reviewer from rubber-stamping every step;
//   (c) REMOVE-THEN-READD — dropping a key prints a loud removal line, but
//     re-declaring it afresh at the drained count is then a BRAND NEW key
//     with no prior published floor to compare against (T-541 round 4: unless
//     the clone's own legacy anchor already declares a floor for that exact
//     key with no matching observed entry, in which case REACHABLE still
//     applies — see the ROUND 4 section below; against any anchor the gate
//     itself has admitted since round 4 shipped this residual is closed, and
//     the round-4 exception is dead code);
//   (d) out-of-band tampering with the clone MIRROR itself (see
//     loadClonePublishedLedger()'s own malformed-ledger refusal, which names
//     the mirror as the thing to investigate rather than trusting it — and
//     which now fires regardless of the ASSEMBLED side's own state, since
//     mirror integrity is orthogonal to whether the tier is standing down).
// All four are closed by diff review at the same trust level as deleting the
// ledger outright (how_to_relax already accepts that), not by this gate.
//
// ---------------------------------------------------------------------------
// T-541 ROUND 4 — two more holes, both keyed on ATTACKER-EDITABLE input, both
// reproduced end to end at exit 0 on the real CLI, both closed structurally
// rather than by another case-patch:
//
// COHERENT — a same-commit invariant on the ASSEMBLED ledger alone,
// independent of clone/succession history, checked FIRST (before GENESIS,
// before RECORD-INTRODUCTION, before any of the three succession rules):
// whenever the assembled derivation is FULL, every key declared in
// `min_direct_files` must have a matching key in
// `derivation.observed_direct_file_counts_at_seeding`, else REFUSE. A floor
// is a claim derived from an observation; a floored directory with no
// observation is an enforcement value whose provenance was deleted — exactly
// finding 1's shape: delete the OBSERVED key while keeping the (even
// lowered) floor, so the deletion lands in `delta.removed`, is examined by
// neither REAL nor REACHABLE, and the floor keeps enforcing a number nothing
// on the assembled side any longer claims to have measured. COHERENT closes
// this structurally rather than by teaching REAL/REACHABLE about one more
// case: a floor with no matching observation refuses regardless of which
// rule would otherwise have run. Retiring a directory WHOLLY (both its floor
// and its observation together) still passes — loudly, via the pre-existing
// weakening and removed-key lines — because neither side declares the key at
// all. Being unconditional (not gated on the clone's own state) is what lets
// COHERENT also close GENESIS and RECORD-INTRODUCTION (immediately below):
// both now run this exact same check before doing anything else.
//
// RECORD INTRODUCTION IS NOW VALIDATED, not merely logged. Previously GENESIS
// (no clone ledger at all) short-circuited to a silent `return null`
// regardless of the assembled side, and the pre-existing partial-anchor
// INTRODUCED branch logged the event without validating anything about the
// incoming record. Finding 2: a manufactured `seeded_on: "not-a-date"`
// sailed through both paths untouched, became the clone's new anchor, and
// DATED's own historical-leniency clause (see below, now DELETED) then
// treated that self-manufactured value as legacy on the very next publish,
// silently skipping the strict-advance comparison forever after — repeatable,
// since stand-down (deleting the ledger) is non-refusing and genesis was
// unconditionally silent, so a stand-down -> genesis -> re-introduce cycle
// reset the gate invisibly. GENESIS and the pre-existing partial-anchor case
// are now unified into one RECORD-INTRODUCTION event, reached whenever the
// assembled side carries a full derivation and the clone does not carry a
// complete anchor to succeed against: COHERENT has already run
// (unconditionally, above); the incoming `seeded_on` must additionally be
// canonical YYYY-MM-DD (else REFUSE). Only once both hold does introduction
// print its loud, non-refusing INTRODUCED line — genesis is no longer
// silent, which is what makes a stand-down -> genesis -> re-introduce cycle
// a reviewable event at every step instead of an invisible reset.
// Introduction deliberately does NOT apply REACHABLE: the sanctioned
// lower-then-reseed protocol legitimately collapses into a single
// introduction publish when no record existed before, and the weakening line
// still carries that visibility — a documented residual, adjacent to T-545.
//
// T-541 ROUND 4 CORRECTED — REAL IS REMOVED FROM RECORD INTRODUCTION. Round 4
// as first shipped ALSO required every introduced observed count to equal the
// assembled tree's own live direct count (REAL, over every key, since there
// is no delta yet to scope to). That reversed round 3's own deliberate
// dormancy for introduction, and the reversal was an ERROR, not a defensible
// re-weighing: it reddened the single most common introduction case there
// is — an honest mirror catching up to a canonical side that kept growing
// since the record was first seeded (observed 108, live 114 — reproduced end
// to end on the real repo, at exit 1, refusing a publish nobody forged).
// REAL's semantics is "this recorded count was observed AT THIS PUBLISH",
// which is true exactly once: for the changed/added delta of a DATED
// re-seed, where the operator attests a fresh observation of the tree they
// are re-seeding from RIGHT NOW. Introduction instead propagates a
// HISTORICAL record — seeded on the canonical side, commonly weeks earlier —
// into a mirror whose own ledger predates it entirely; comparing that
// historical record against the mirror's CURRENT live tree compares two
// numbers that were never claimed to coincide, a category error rather than
// a security check. REAL at introduction also bound no adversary: a
// same-commit forger who controls both the assembled tree and this ledger in
// one commit simply sets every observed count equal to their own evacuated
// tree's live counts, so REAL here was ALL false-refusal cost against honest
// operators and NO adversarial benefit. Round 4's own criterion 7 already
// listed "floor values at genesis or introduction" as a residual NOT
// protected by this gate, while its criterion 2 simultaneously claimed
// introduced observed values WERE REAL-verified — the design contradicted
// itself in prose versus code, and this correction resolves the
// contradiction in favor of the prose, restoring round 3's dormancy for this
// one path while keeping every other ROUND 4 upgrade (COHERENT, DATED's
// format validation at introduction, the legacy-leniency deletion below).
// Introduction's observed counts are now recorded AS CLAIMED and NOT verified
// against the live tree (trust-on-first-use) — format- and COHERENT-checked,
// nothing more.
//
// THE STRUCTURAL INVARIANT THIS CORRECTION ESTABLISHES, for future editors of
// this gate: A REFUSAL MAY COMPARE A RECORDED VALUE TO THE LIVE TREE ONLY
// WHERE THE RECORD ITSELF ASSERTS OBSERVATION-AT-THIS-PUBLISH — this invariant
// binds REFUSALS alone and does NOT forbid an INFORMATIONAL, non-gating
// printout of that same comparison (T-549's claimed-vs-live term on the
// INTRODUCED line below decides nothing and is read by no accept/refuse
// branch; see the T-549 section above this function for why that printout is
// sanctioned rather than a violation of the invariant it sits beside).
// Rounds 3 and 4
// produced the exact same defect TWICE, in different branches, with the same
// two numbers: round 3's original all-keys Rule 2 (reproduced live: re-seeding
// docs/assets alone was refused citing scripts recorded at 108 against a live
// 114 — an untouched directory blamed for ordinary growth) and round 4's
// introduction REAL (reproduced live: the same 108-vs-114 shape, this time on
// a mirror-catch-up introduction) are both a refusal comparing a HISTORICAL
// recorded value against the LIVE tree, outside the one context — the
// changed/added delta of a DATED re-seed — where the record actually claims
// freshness. After this correction, every live-tree comparison left in this
// gate is greppable to exactly two places: Rule 2 (REAL) and Rule 3
// (REACHABLE, which compares recorded-to-recorded but is scoped by the same
// delta) inside the delta-scoped re-seed path below, plus the ordinary
// end-state floor check in findShapeContractViolations() (ALWAYS live, on
// every publish, regardless of this gate's own state). Every OTHER refusal in
// this gate — duplicate-key, the unparseable-clone mirror refusal,
// full-to-partial regression, COHERENT, both format checks (introduction and
// established re-seed), and DATED's strict-advance comparison — is a static
// ledger-against-ledger or ledger-against-syntax comparison with no live-tree
// term at all, and never misfired. Residual (a) below extends explicitly:
// floor and observed values recorded at GENESIS or INTRODUCTION are not, and
// must never become, subject to a live-tree comparison THAT GATES THE
// DECISION (an INFORMATIONAL print of that same comparison, deciding
// nothing, is sanctioned — see the T-549 section above this function) — the
// not-protected list and the code now agree.
//
// THE DATED LEGACY-LENIENCY BRANCH IS DELETED, not narrowed. Round 3 skipped
// the strict-advance comparison, loudly, whenever the PUBLISHED `seeded_on`
// was not canonical (pre-round-3 history the operator could not edit). Now
// that introduction format-validates every incoming `seeded_on` (immediately
// above), no NEW non-canonical published anchor can ever be created going
// forward, so the branch's justification is gone — keeping it would still
// leave DATED's strict-advance check skippable by whatever non-canonical
// value happened to survive from before this fix shipped. A non-canonical
// PUBLISHED `seeded_on` now REFUSES outright, naming the self-serve
// two-publish repair that needs no mirror surgery: stand down (delete the
// ledger entirely, a loud non-refusing event) then re-introduce it (loud,
// format- and COHERENT-checked; T-541 round 4 CORRECTED — no longer REAL-
// checked, see above). This is safe by an inductive invariant: the only
// write paths through this gate from here on are introduction, byte-
// identical, re-seed and stand-down, and introduction always format- and
// COHERENT-validates — so every full anchor the gate itself ever admits
// from here on is canonical-dated and coherent, PLUS entry-verified against
// the live tree for any key a subsequent re-seed actually touches (an
// introduction-created anchor's observed values stay trust-on-first-use
// until then, by design — see the STRUCTURAL INVARIANT above). The
// canonical repo's own published `seeded_on` is already canonical, so this
// deletion protects nobody on it today; it only closes a hole against the
// future.
//
// ADDED keys gain REACHABLE too, but only CONDITIONALLY: if the clone's
// previously published floor map already declares a floor for a brand-new
// (added) key, that re-seeded count must still be >= that old floor, exactly
// like a changed key. Against any anchor the gate itself has admitted since
// this round shipped this is dead code by construction — COHERENT there
// guarantees a floored key always has a matching observed key, so a key with
// a floor but no prior observed entry cannot exist and therefore can never
// land in `delta.added`. It is live only against a LEGACY (pre-round-4)
// anchor that itself already violates COHERENT — a floor with no matching
// observed entry committed before this rule existed.
//
// THE CERTIFICATE IS NOW GENERATED, not narrated. The re-seed line used to
// assert "every re-seeded observed count verified" as prose sitting BESIDE
// the verification — exactly finding 1's defect class, a certificate that
// quantifies over more than the code actually checked. The line is now built
// directly from the arrays Rules 2/3 iterated (`delta.changed`,
// `delta.added`) plus `delta.removed` — the changed-key count and names, the
// added-key count and names, and the removed-key count and names (with the
// floor each one stood down with, when it had one) — so it cannot claim
// verification of anything the code did not touch. See
// formatReseedCertificateLine() below.
// ---------------------------------------------------------------------------
//
// T-549 (T-541 round 4 security review, MEDIUM residual) — the INTRODUCED
// line now additionally prints, per introduced observed key, the claimed
// count beside the assembled tree's OWN live direct count, labeled
// informational and NOT verified. This closes a DIFFERENTIAL, not the
// trust-on-first-use hole itself — do not read further and try to make this
// a check; it is deliberately a print. The gate already discloses and
// accepts an N-step loud ratchet (residual (b) above) where every weakening
// step names the directory and both values, and the defence is a human
// reading those lines. The STAND-DOWN then RECORD-INTRODUCTION swap (delete
// the ledger, loud WARNING; re-introduce a fabricated one, loud INTRODUCED
// line) was cheaper than that disclosed cost model only because its two
// loud lines carried NO numbers a reviewer could act on: the pre-T-549
// INTRODUCED line said "recorded as claimed, not verified" but never said
// claimed-WHAT against live-WHAT. Printing that pair degrades the swap back
// into the ratchet: a fabricated claimed=1 beside a live tree of 500
// indicts itself at the one moment the human backstop is looking, in the
// same reviewable line.
//
// VERIFICATION-AT-INTRODUCTION REMAINS A DELIBERATE NON-DECISION, not an
// oversight left open for a future round. Trust-on-first-use is inherent to
// the FIRST anchor: any introduction-time CHECK (as opposed to this
// informational print) is satisfiable by a same-commit forger BY
// CONSTRUCTION — they control both the assembled tree and the incoming
// record in the one commit that introduces it, so they simply set claimed
// equal to their own evacuated tree's own live counts, and the check would
// pass having verified nothing an adversary could not fake. Round 4's own
// shipped REAL loop already proved the cost side of this trade, twice, at
// exit 1, against an honest fixture nobody forged (claimed 108, live 114 —
// see the ROUND 4 CORRECTED section above); the same 108-vs-114 shape
// recurs in this task's own test fixture, now PASSING with the
// claimed-vs-live term printed rather than enforced. Do not resurrect a
// REAL-shaped check on this path in a future round; print the numbers and
// let the human backstop decide — which is exactly what the decision
// function below still declines to do: no accept/refuse branch in
// checkShapeContractSuccession() reads the live map this prints, and it is
// computed only on the introduction path, never on a dormant publish.
// ---------------------------------------------------------------------------

// Sorted [key, value] entries of a plain object, for order-independent
// deep-equality-by-string comparisons below.
function sortedEntries(obj) {
  return Object.entries(obj || {}).sort((a, b) => a[0].localeCompare(b[0]));
}

const dirLabelOf = (dir) => (dir === '' ? '(root)' : dir);

// T-541 round 3 — the canonical seeded_on date shape. Validated against
// derivation.seeded_on on the ASSEMBLED (about-to-be-published,
// attacker-editable) side ONLY when the DATED rule is actually evaluated
// (the seeding record changed, or a RECORD-INTRODUCTION is happening) — never
// on a dormant publish, so an odd date sitting at rest is never examined.
// T-541 round 4: the PUBLISHED (clone-anchored, historical) side is now
// ALSO checked against this same shape whenever DATED runs on an established
// (non-introduction) re-seed — round 3's leniency there (skip the
// strict-advance comparison rather than refuse) is DELETED; see
// checkShapeContractSuccession()'s DATED handling below.
const CANONICAL_SEEDED_ON_RE = /^\d{4}-\d{2}-\d{2}$/;

// T-541 round 4 — COHERENT: keys(min_direct_files) must be a subset of
// keys(observed_direct_file_counts_at_seeding) whenever the assembled
// derivation is full. Returns the SORTED list of floor keys with no matching
// observed key (empty when coherent). A pure function of the two maps
// alone — no clone/history dependency, deliberately, since this is a
// same-commit invariant on the assembled ledger, not a succession check.
function findIncoherentFloorKeys(floors, observed) {
  const floorKeys = floors instanceof Map ? [...floors.keys()] : Object.keys(floors || {});
  const observedKeySet = new Set(Object.keys(observed || {}));
  return floorKeys.filter((k) => !observedKeySet.has(k)).sort();
}

// Reads the CLONE's previously-published shape contract. Returns one of:
//   { state: 'none' }    — no ledger FILE at all in the clone (bootstrap /
//                          first-ever publish, or right after a stand-down).
//                          GENESIS: the succession gate has nothing complete
//                          to succeed. T-541 round 4: no longer
//                          unconditionally dormant — see the merged
//                          GENESIS/RECORD-INTRODUCTION handling below.
//   { state: 'partial' } — a ledger file exists and parses, but does not
//                          carry a FULL anchor (missing/malformed
//                          derivation.seeded_on,
//                          derivation.observed_direct_file_counts_at_seeding,
//                          or min_direct_files) — includes legacy
//                          floors-only ledgers. Handled identically to
//                          'none' below once the assembled side carries a
//                          full derivation (T-541 round 4: both are now
//                          RECORD-INTRODUCTION, validated, not merely
//                          logged).
//   { state: 'full', observed, seededOn, floors } — a complete
//                          previously-published ledger to succeed.
// Refuses via fail() (process.exit(1), before any write) ONLY when the file
// EXISTS and is not valid JSON — an out-of-band tampered or corrupted
// mirror, which must be investigated directly rather than silently skipped
// or silently trusted. T-541 round 3: this refusal now fires regardless of
// the ASSEMBLED side's own state (including no-assembled-ledger) — see the
// call site, which invokes checkShapeContractSuccession() unconditionally
// rather than only when the assembled tree itself carries a ledger.
function loadClonePublishedLedger(cloneDir) {
  const contractPath = path.join(cloneDir, ...SHAPE_CONTRACT_RELATIVE_PATH.split('/'));
  let raw;
  try {
    raw = fs.readFileSync(contractPath, 'utf8');
  } catch {
    return { state: 'none' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(
      'refusing to overlay — the publish shape contract succession gate could not parse the PREVIOUSLY ' +
      `PUBLISHED ledger already present in the clone mirror at ${SHAPE_CONTRACT_RELATIVE_PATH} (${err.message}). ` +
      'This gate relies on that clone copy as its external anchor precisely because a same-commit forgery cannot ' +
      'rewrite it — a corrupted or unparseable copy there must be investigated directly (the mirror itself), not ' +
      'silently skipped and not silently trusted. No files were copied or deleted.'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'partial' };
  const derivation = parsed.derivation;
  const floors = parsed.min_direct_files;
  if (
    !derivation || typeof derivation !== 'object' || Array.isArray(derivation) ||
    !derivation.observed_direct_file_counts_at_seeding ||
    typeof derivation.observed_direct_file_counts_at_seeding !== 'object' ||
    Array.isArray(derivation.observed_direct_file_counts_at_seeding) ||
    typeof derivation.seeded_on !== 'string' ||
    !floors || typeof floors !== 'object' || Array.isArray(floors)
  ) {
    return { state: 'partial' }; // no full seeding record to anchor against
  }
  return { state: 'full', observed: derivation.observed_direct_file_counts_at_seeding, seededOn: derivation.seeded_on, floors };
}

// T-541 round 3 — the DELTA between the previously published and
// about-to-be-published observed-count maps: which directories actually
// CHANGED value, which are brand-new ADDED keys, and which were dropped
// (REMOVED) entirely. Rules 2 (REAL) and 3 (REACHABLE) below iterate only
// `changed` (REAL also covers `added`) rather than every recorded key —
// iterating every key blames directories nobody touched (reproduced live:
// re-seeding docs/assets alone was refused blaming scripts, recorded 108
// against a live 114 — ordinary repo growth, not a forgery).
function computeObservedDelta(publishedObserved, currentObserved) {
  const changed = [];
  const added = [];
  const removed = [];
  const allKeys = new Set([...Object.keys(publishedObserved), ...Object.keys(currentObserved)]);
  for (const key of allKeys) {
    const hadOld = Object.prototype.hasOwnProperty.call(publishedObserved, key);
    const hasNew = Object.prototype.hasOwnProperty.call(currentObserved, key);
    if (hadOld && hasNew) {
      if (publishedObserved[key] !== currentObserved[key]) changed.push(key);
    } else if (!hadOld && hasNew) {
      added.push(key);
    } else if (hadOld && !hasNew) {
      removed.push(key);
    }
  }
  changed.sort();
  added.sort();
  removed.sort();
  return { changed, added, removed };
}

// Reads the ASSEMBLED tree's own ledger derivation (the seeding record about
// to be published). Lenient by design (no fail()): loadShapeContract() has
// already validated this same file's min_direct_files shape by the time this
// runs, so a JSON parse failure here is unreachable in practice; a missing or
// incomplete derivation block simply means there is nothing to compare on
// THIS side either, so the gate stays dormant rather than refusing on an
// optional field.
function loadAssembledSeedingRecord(assembledDir) {
  const contractPath = path.join(assembledDir, ...SHAPE_CONTRACT_RELATIVE_PATH.split('/'));
  let raw;
  try {
    raw = fs.readFileSync(contractPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const derivation = parsed && typeof parsed === 'object' ? parsed.derivation : undefined;
  if (
    !derivation || typeof derivation !== 'object' ||
    !derivation.observed_direct_file_counts_at_seeding ||
    typeof derivation.observed_direct_file_counts_at_seeding !== 'object' ||
    Array.isArray(derivation.observed_direct_file_counts_at_seeding) ||
    typeof derivation.seeded_on !== 'string'
  ) {
    return null;
  }
  return { observed: derivation.observed_direct_file_counts_at_seeding, seededOn: derivation.seeded_on };
}

// Builds the per-directory WEAKENING lines (floor lowered, or floor dropped
// entirely) between the clone's previously published floors and the
// about-to-be-published floors. Deliberately independent of whether the
// seeding record changed — how_to_relax's sanctioned "lower a floor, leave
// the record alone" relaxation must surface this line too, never a refusal.
function buildShapeContractWeakeningLines(oldFloors, newFloorsObj) {
  const lines = [];
  for (const [dir, floor] of sortedEntries(newFloorsObj)) {
    if (Object.prototype.hasOwnProperty.call(oldFloors, dir) && floor < oldFloors[dir]) {
      lines.push(`  - ${dirLabelOf(dir)}: floor lowered from ${oldFloors[dir]} to ${floor}`);
    }
  }
  for (const dir of Object.keys(oldFloors).sort()) {
    if (!Object.prototype.hasOwnProperty.call(newFloorsObj, dir)) {
      lines.push(`  - ${dirLabelOf(dir)}: floor removed from the ledger (was ${oldFloors[dir]})`);
    }
  }
  return lines;
}

// The succession gate itself. Returns:
//   null                — dormant: genesis or partial clone anchor against a
//                         not-yet-full assembled record (pre-existing
//                         floors-only fixtures land here), or a full-anchor
//                         byte-identical/grown record with no floor
//                         weakened.
//   { refusal: string }  — REFUSE (caller calls fail()). T-541 round 3: a
//                         full clone anchor refuses on EVERY assembled
//                         shape other than the three accepted states below
//                         (see the header comment above this section);
//                         T-541 round 4: COHERENT and RECORD-INTRODUCTION's
//                         format check can also refuse, independent of the
//                         clone's own anchor state (T-541 round 4 CORRECTED:
//                         RECORD-INTRODUCTION no longer applies REAL — see
//                         the ROUND 4 CORRECTED header section).
//   { standDown: string } — pass, loud non-refusing STAND-DOWN line (full
//                         clone anchor, assembled tree ships no ledger at
//                         all — the sanctioned relaxation, made visible).
//   { introduced: string } — pass, loud non-refusing INTRODUCED line (no
//                         complete clone anchor — genesis or partial — and a
//                         full, format- and COHERENT-checked assembled
//                         derivation appearing for the first time; its
//                         observed counts are trust-on-first-use, NOT
//                         REAL-verified against the live tree).
//   { reseed: {from, to, changedKeys, addedKeys, removedKeys, oldFloors}, weakening: [...], removedKeyLines: [...] }
//                       — pass, print the GENERATED re-seed certificate line
//                         (built from the same arrays the rules iterated),
//                         any weakening lines, and any record-removed-key
//                         lines.
//   { weakening: [...] } — pass (record untouched, both sides full), print
//                         only the weakening lines (non-empty).
function checkShapeContractSuccession(cloneDir, assembledDir, assembledFloors, assembledFiles) {
  const published = loadClonePublishedLedger(cloneDir);

  // assembledFloors === null means loadShapeContract() found no ledger FILE
  // at all in the assembled tree — a present-but-malformed ledger already
  // fails closed inside loadShapeContract() itself (via fail()), before this
  // function is ever reached, so null here is unambiguous "file absent".
  const current = assembledFloors === null ? null : loadAssembledSeedingRecord(assembledDir);

  // T-541 round 4 — COHERENT, checked FIRST and UNCONDITIONALLY whenever the
  // assembled derivation is full: independent of the clone's own state
  // (genesis, partial or full anchor), because it is a same-commit invariant
  // on the assembled ledger alone, never a succession comparison. See the
  // header comment's ROUND 4 section above for the full reasoning — this is
  // what closes finding 1 (delete the observed key, keep the floor).
  if (current !== null) {
    const incoherentKeys = findIncoherentFloorKeys(assembledFloors, current.observed);
    if (incoherentKeys.length > 0) {
      const plural = incoherentKeys.length > 1;
      return {
        refusal:
          `the assembled publish shape contract declares a floor for ${plural ? 'directories' : 'a directory'} ` +
          'with NO matching observed count in derivation.observed_direct_file_counts_at_seeding (COHERENT): ' +
          `${incoherentKeys.map(dirLabelOf).join(', ')} — a floor is a claim derived from an observation, so a ` +
          'floored directory with no observation is an enforcement value whose provenance was deleted; either ' +
          'restore the missing observed count(s), or remove the floor(s) for the same directory/directories too ' +
          '(whole-directory retirement, which prints its own loud removal and weakening lines rather than ' +
          'refusing)'
      };
    }
  }

  // GENESIS (no clone ledger at all) and RECORD-INTRODUCTION (a clone anchor
  // that exists but is not itself complete — includes legacy floors-only
  // ledgers) are unified as of T-541 round 4: both cases previously trusted
  // the incoming record (genesis silently, the pre-existing introduction
  // branch by logging without validating) — finding 2's exact hole, a
  // manufactured non-canonical seeded_on sailing through untouched.
  if (published.state === 'none' || published.state === 'partial') {
    if (current === null) {
      // Nothing complete on the assembled side to introduce yet — stays
      // dormant either way (bootstrap and pre-existing floors-only fixtures
      // unchanged).
      return null;
    }
    // RECORD INTRODUCTION — format- and COHERENT-checked here (COHERENT
    // already ran, unconditionally, above); observed counts are recorded AS
    // CLAIMED and NOT verified against the live tree (trust-on-first-use).
    // T-541 round 4 CORRECTED: REAL previously ran here too, but REAL's
    // semantics — "this recorded count was observed AT THIS PUBLISH" — is
    // true exactly once: for the changed/added delta of a DATED re-seed,
    // where the operator attests a fresh observation. Introduction instead
    // propagates a HISTORICAL record (seeded on the canonical side, weeks
    // earlier) into a mirror whose ledger predates it, so comparing that
    // historical record against the CURRENT live tree is a category error —
    // it refused the single most common introduction case there is, an
    // honest mirror catching up to a canonical side that kept growing after
    // the record was seeded (observed 108, live 114 — reproduced end to
    // end on the real repo). REAL at introduction also bound no adversary:
    // a same-commit forger who controls both the assembled tree and this
    // ledger simply sets observed equal to their own evacuated tree's live
    // counts — the check was all false-refusal cost, no adversarial
    // benefit. REACHABLE is deliberately NOT applied either — see the
    // header comment's ROUND 4 section for why (a documented residual,
    // adjacent to T-545).
    if (!CANONICAL_SEEDED_ON_RE.test(current.seededOn)) {
      return {
        refusal:
          'this publish introduces the shape contract\'s first full seeding record (there is no complete ' +
          `previously published anchor to succeed against yet), but the incoming derivation.seeded_on ` +
          `("${current.seededOn}") is not in the canonical YYYY-MM-DD format — refusing rather than anchoring a ` +
          'future succession chain on an unvalidated date'
      };
    }
    const anchorDescription = published.state === 'none'
      ? 'the clone holds no previously published shape contract at all (first publish, or after a stand-down)'
      : 'the previously published ledger in the clone does not carry a complete anchor (missing or partial ' +
        'derivation, or a legacy floors-only ledger)';
    // T-549 — INFORMATIONAL ONLY, computed and printed ONLY on this
    // introduction path (never on a dormant publish — `current === null`
    // already returned above, and this line is unreachable there), and read
    // by NO accept/refuse branch: the decision to introduce was already made
    // above (format check passed). This is a print, not a gate. Per
    // introduced observed key, name the claimed count beside the assembled
    // tree's OWN live direct count (buildDirectCountMap(), the same helper
    // REAL already uses on an established re-seed) so a fabricated
    // introduction (e.g. claimed 1 while the live tree actually holds 500)
    // is indicted by the same line an honest mirror catch-up (e.g. claimed
    // 108 against a live 114) prints without incident — see the T-549
    // header section above for why this differential, and only this
    // differential, is closed.
    const liveDirectCountsAtIntroduction = buildDirectCountMap(assembledFiles);
    const claimedVsLiveTerm = Object.keys(current.observed).sort()
      .map((dir) => `${dirLabelOf(dir)}: claimed=${current.observed[dir]} live=${liveDirectCountsAtIntroduction.get(dir) || 0}`)
      .join(', ');
    return {
      introduced:
        `the assembled publish shape contract (${SHAPE_CONTRACT_RELATIVE_PATH}) now carries a full seeding ` +
        `record (seeded_on ${current.seededOn}), but ${anchorDescription} — there is nothing complete to succeed ` +
        "this record against yet. This is the record's first full introduction, format- and COHERENT-checked; " +
        'its observed counts are recorded AS CLAIMED and NOT verified against the live tree ' +
        '(trust-on-first-use) — not refused, but logged so the introduction itself is a reviewable event. ' +
        'Per-key claimed-vs-live counts (informational only, NOT verified, NOT a refusal input — the numbers a ' +
        `reviewer needs to judge this introduction for themselves): ${claimedVsLiveTerm}.`
    };
  }

  // published.state === 'full' from here on — a complete external anchor
  // exists, so the decision function below must be TOTAL: every assembled
  // shape either matches one of the three accepted states or refuses.

  if (assembledFloors === null) {
    // The assembled tree ships NO ledger at all. how_to_relax sanctions
    // deleting the file outright as a stand-down of the whole tier — this
    // must never be refused, but must never be silent either.
    return {
      standDown:
        `the assembled tree ships no publish shape contract at ${SHAPE_CONTRACT_RELATIVE_PATH} at all, but the ` +
        `clone holds a previously published, fully-seeded anchor (last seeded ${published.seededOn}) — standing ` +
        'the whole tier down entirely (how_to_relax sanctions deleting the ledger as an accepted relaxation); ' +
        'not refused, but logged so the stand-down itself is a reviewable event.'
    };
  }

  if (current === null) {
    // T-541 round 3 FAIL CLOSED. Round 2 short-circuited here with a bare
    // `return null` (dormant) whenever the assembled derivation was absent
    // or partial — reproduced end to end: the round-1 coherent forgery
    // (observed 9->3, floor 5->2 on one directory) PLUS deleting
    // derivation.seeded_on published at exit 0 with NO output at all, even
    // though the clone held a full anchor to refuse it against. The
    // assembled side is attacker-editable; a seeding record can never go
    // from fully-seeded (per the clone anchor) to absent or partial without
    // explanation. Refuse before any write, naming the three green paths.
    return {
      refusal:
        "the clone holds a previously published, fully-seeded shape contract anchor but the assembled ledger's " +
        'derivation is absent or incomplete (missing or malformed derivation.seeded_on and/or ' +
        'derivation.observed_direct_file_counts_at_seeding) — a seeding record can never regress from complete ' +
        'to absent or partial without explanation; pick one of three green paths: restore the seeding record ' +
        'byte-identical to the previously published one, perform a dated re-seed satisfying DATED, REAL and ' +
        'REACHABLE, or delete the ledger file entirely (the sanctioned stand-down)'
    };
  }

  // Both sides now carry a full anchor — the ordinary succession rules run.
  const newFloorsObj = assembledFloors instanceof Map ? Object.fromEntries(assembledFloors) : { ...assembledFloors };
  const oldFloors = published.floors;

  const delta = computeObservedDelta(published.observed, current.observed);
  const observedChanged = delta.changed.length > 0 || delta.added.length > 0 || delta.removed.length > 0;
  // T-541 round 3 — recordChanged additionally covers a BARE seeded_on
  // rewrite: the header used to claim visibility over a bare bump while
  // recordChanged compared only the observed maps, so a bare rewrite
  // (forward OR backdated) was silently dormant.
  const seededOnChanged = current.seededOn !== published.seededOn;
  const recordChanged = observedChanged || seededOnChanged;

  if (!recordChanged) {
    const weakening = buildShapeContractWeakeningLines(oldFloors, newFloorsObj);
    return weakening.length === 0 ? null : { weakening };
  }

  // Rule 1 — DATED. Format-validated ONLY on the about-to-be-published
  // (attacker-editable) side, and ONLY here, now that recordChanged is true.
  if (!CANONICAL_SEEDED_ON_RE.test(current.seededOn)) {
    return {
      refusal:
        `the shape contract's seeding record changed but the new derivation.seeded_on ("${current.seededOn}") is ` +
        'not in the canonical YYYY-MM-DD format — refusing rather than comparing an unvalidated date'
    };
  }
  // T-541 round 4 — the legacy-leniency branch is DELETED, not narrowed: a
  // non-canonical PUBLISHED seeded_on now REFUSES outright rather than
  // skipping the strict-advance comparison. Safe by the inductive invariant
  // that every full anchor RECORD-INTRODUCTION admits from here on is
  // already canonical-dated (see the header comment's ROUND 4 section) — the
  // repair, named below, needs no mirror surgery.
  if (!CANONICAL_SEEDED_ON_RE.test(published.seededOn)) {
    return {
      refusal:
        "the shape contract's seeding record changed, but the previously published derivation.seeded_on " +
        `("${published.seededOn}") is not in the canonical YYYY-MM-DD format — refusing rather than treating a ` +
        'non-canonical published anchor as trustworthy legacy history; repair via the self-serve two-publish ' +
        'path that needs no mirror surgery: stand down (delete the ledger entirely, a loud non-refusing event), ' +
        'then re-introduce it (loud, format- and COHERENT-checked)'
    };
  }
  if (!(current.seededOn > published.seededOn)) {
    return {
      refusal:
        "the shape contract's seeding record changed but derivation.seeded_on did not advance past the " +
        `previously published ${published.seededOn} — a seeding record that changed without its date advancing ` +
        'is a falsified historical observation, refusing rather than silently accepting it'
    };
  }

  // Rule 3 — REACHABLE, over the DELTA (changed) set, against the OLD FLOOR
  // (not the old observed count). T-541 round 3: scoped to `changed` only —
  // an untouched key's stale recorded count is not this rule's business, and
  // it has the identical blame-the-untouched-directory failure mode as
  // Rule 2 when a floor was raised after seeding.
  for (const dir of delta.changed) {
    const observed = current.observed[dir];
    if (Object.prototype.hasOwnProperty.call(oldFloors, dir) && observed < oldFloors[dir]) {
      return {
        refusal:
          `the re-seeded observed count for "${dirLabelOf(dir)}" (${observed}) is below the previously published ` +
          `floor of ${oldFloors[dir]} for that directory — a re-seed can never certify a directory smaller than ` +
          'the minimum already committed for it; lower the floor explicitly first (a weakening line will be ' +
          'printed) if this shrinkage is actually sanctioned'
      };
    }
  }

  // T-541 round 4 — ADDED keys ALSO get REACHABLE, but only when the
  // clone's previously published floor map already declares a floor for
  // that exact (brand-new-to-the-observed-record) key. Dead code against
  // any anchor the gate itself has admitted since this round shipped (see
  // the header comment's ROUND 4 section) — COHERENT there guarantees a
  // floored key always has a matching observed key, so it could never have
  // landed in `delta.added` in the first place. Live only against a LEGACY
  // (pre-round-4) anchor that itself already violates COHERENT.
  for (const dir of delta.added) {
    if (Object.prototype.hasOwnProperty.call(oldFloors, dir)) {
      const observed = current.observed[dir];
      if (observed < oldFloors[dir]) {
        return {
          refusal:
            `the newly re-seeded observed count for "${dirLabelOf(dir)}" (${observed}) is below the previously ` +
            `published floor of ${oldFloors[dir]} already declared for that directory — a brand-new observed ` +
            'entry can never certify a directory smaller than the minimum already committed for it; lower the ' +
            'floor explicitly first (a weakening line will be printed) if this shrinkage is actually sanctioned'
        };
      }
    }
  }

  // Rule 2 — REAL, over the delta (changed) set PLUS brand-new (added)
  // keys, against the LIVE assembled tree at this publish.
  const directCounts = buildDirectCountMap(assembledFiles);
  for (const dir of [...delta.changed, ...delta.added]) {
    const observed = current.observed[dir];
    const live = directCounts.get(dir) || 0;
    if (observed !== live) {
      return {
        refusal:
          `the re-seeded observed count for "${dirLabelOf(dir)}" (${observed}) does not match the assembled ` +
          `tree's actual direct file count at this publish (${live}) — every re-seeded count must equal the LIVE ` +
          'tree at the moment of re-seeding; the ledger has drifted since it was edited, re-seed again from the ' +
          'tree as it stands now'
      };
    }
  }

  const removedKeyLines = delta.removed.map(
    (dir) => `  - ${dirLabelOf(dir)}: seeding record entry removed (was observed=${published.observed[dir]})`
  );

  // T-541 round 4 — the certificate arrays are the SAME arrays the rules
  // above just iterated (delta.changed, delta.added, delta.removed), never a
  // re-derivation — see formatReseedCertificateLine() and the header
  // comment's ROUND 4 section for why that matters.
  return {
    reseed: {
      from: published.seededOn,
      to: current.seededOn,
      changedKeys: delta.changed,
      addedKeys: delta.added,
      removedKeys: delta.removed,
      oldFloors,
    },
    weakening: buildShapeContractWeakeningLines(oldFloors, newFloorsObj),
    removedKeyLines,
  };
}

// T-541 round 4, criterion 5 — builds the re-seed CERTIFICATE line directly
// from the arrays Rules 2/3 iterated (`reseed.changedKeys`, `.addedKeys`)
// plus `reseed.removedKeys`, never as prose written beside the verification.
// A certificate built this way cannot quantify over anything the code did
// not check — exactly what closes finding 1's defect class (a "verified"
// claim about a directory neither rule touched).
function formatReseedCertificateLine(reseed) {
  const { from, to, changedKeys, addedKeys, removedKeys, oldFloors } = reseed;
  const namesOrNone = (keys) => (keys.length > 0 ? keys.map(dirLabelOf).join(', ') : 'none');
  const changedPart =
    `${changedKeys.length} changed ke${changedKeys.length === 1 ? 'y' : 'ys'} REAL+REACHABLE-verified ` +
    `(${namesOrNone(changedKeys)})`;
  const addedPart =
    `${addedKeys.length} added ke${addedKeys.length === 1 ? 'y' : 'ys'} REAL-verified (${namesOrNone(addedKeys)})`;
  const removedNames = removedKeys.map((dir) => {
    const floor = Object.prototype.hasOwnProperty.call(oldFloors, dir) ? oldFloors[dir] : null;
    return floor === null ? dirLabelOf(dir) : `${dirLabelOf(dir)} (floor ${floor})`;
  });
  const removedPart =
    `${removedKeys.length} entr${removedKeys.length === 1 ? 'y' : 'ies'} stood down with their floor(s) ` +
    `(${removedNames.length > 0 ? removedNames.join(', ') : 'none'})`;
  return (
    `Publish shape contract succession (${SHAPE_CONTRACT_RELATIVE_PATH}): seeding record re-seeded on ${to} ` +
    `(previously published ${from}) — ${changedPart}; ${addedPart}; ${removedPart}.`
  );
}

// Returns true when `relPath` (using '/' separators, relative to the clone
// root) is covered by a `preserve` entry: an entry ending in '/' preserves
// everything under that prefix; an entry without a trailing '/' preserves
// that exact path only. No glob library — this repo is zero-dep.
function isPreserved(relPath, preserveKeys) {
  for (const key of preserveKeys) {
    if (key.endsWith('/')) {
      if (relPath === key.slice(0, -1) || relPath.startsWith(key)) return true;
    } else if (relPath === key) {
      return true;
    }
  }
  return false;
}

// Symlink-safe copy, mirroring mavp-publish-assemble.js's copyFile: detects
// symlinks via lstat and recreates them explicitly rather than dereferencing
// (fs.copyFileSync on a symlink can fail on macOS).
function copyFile(srcPath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const stat = fs.lstatSync(srcPath);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(srcPath);
    fs.rmSync(destPath, { force: true });
    fs.symlinkSync(linkTarget, destPath);
  } else {
    fs.copyFileSync(srcPath, destPath);
  }
}

// Recursively lists all file/symlink paths under `dir`, relative to `dir`,
// using '/' as the separator. Mirrors mavp-publish-assemble.js's
// listFilesRecursive. Uses withFileTypes (lstat semantics) so a symlink is
// listed as its own leaf entry rather than dereferenced.
function listFilesRecursive(dir) {
  const results = [];
  const walk = (current, relPrefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        results.push(rel);
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return results;
}

// Recursively lists all file/symlink paths under `dir`, relative to `dir`,
// but SKIPS any directory named exactly `.git` at the top level of `dir`
// (the clone's own git plumbing must never be touched or deleted).
function listCloneFilesExcludingGit(cloneDir) {
  const results = [];
  const walk = (current, relPrefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (rel === '.git' || rel.startsWith('.git/')) continue;
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        results.push(rel);
      } else if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  if (fs.existsSync(cloneDir)) walk(cloneDir, '');
  return results;
}

// Shared rendering for one findDirectoryViolations() entry, used both when
// refusing (stderr) and when reporting a --allow-mass-delete suppression
// (stdout, F4) — so the two can never drift apart in wording.
function formatDirViolationLine(v) {
  const label = v.dir === '' ? '(root)' : v.dir;
  const reasonLabel =
    v.reason === 'full-wipe' ? ' [complete removal]' :
    v.reason === 'aggregate' ? ' [aggregate of small directories]' :
    v.reason === 'multi-directory-aggregate' ? ' [multiple directories touched at once]' :
    '';
  return `  - ${label}: ${v.deleted} of ${v.total} (${(v.ratio * 100).toFixed(1)}%)${reasonLabel}`;
}

// Removes empty directories left behind after deleting their contents
// (walks bottom-up so nested empties collapse too). Never removes `root`
// itself, and never descends into `.git`.
function pruneEmptyDirs(root) {
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '.git' && current === root) continue;
        walk(path.join(current, entry.name));
      }
    }
    if (current !== root) {
      const remaining = fs.readdirSync(current);
      if (remaining.length === 0) fs.rmdirSync(current);
    }
  };
  walk(root);
}

function main() {
  const { positional, allowMassDelete, maxDeleteRatio, maxDirDeleteRatio, maxMoveCreditRatio } =
    parseArgs(process.argv.slice(2));
  const [assembledDirArg, cloneDirArg] = positional;
  if (!assembledDirArg || !cloneDirArg) {
    console.error(
      'Usage: node scripts/mavp-publish-overlay.js <assembled-dir> <clone-dir> ' +
      '[--allow-mass-delete] [--max-delete-ratio <0-1>] [--max-dir-delete-ratio <0-1>] ' +
      '[--max-move-credit-ratio <0-1>]'
    );
    process.exit(1);
  }

  const assembledDir = path.resolve(assembledDirArg);
  const cloneDir = path.resolve(cloneDirArg);

  if (!fs.existsSync(assembledDir)) fail(`assembled dir not found: ${assembledDir}`);
  if (!fs.existsSync(cloneDir)) fail(`clone dir not found: ${cloneDir}`);

  const preserve = loadPreserveBucket();
  const preserveKeys = Object.keys(preserve);

  const assembledFiles = listFilesRecursive(assembledDir);
  const assembledSet = new Set(assembledFiles);
  const cloneFiles = listCloneFilesExcludingGit(cloneDir);
  const cloneFileSet = new Set(cloneFiles);

  // T-533 — COMMITTED SHAPE CONTRACT, checked FIRST, before any delta tier and
  // before the deletion plan is even computed (so it is write-free by
  // construction, not merely by ordering). Checked first for two reasons:
  //   - It is the only tier that reads nothing but the END STATE, so it needs
  //     no plan, no baseline and no move detection to reach a verdict.
  //   - It must never be MASKED by a delta tier that happens to fire in the
  //     same run. That matters concretely: the same 147-file relocation trips
  //     the whole-run move-credit cap when the baseline is small and clears it
  //     when a padding publish has inflated the baseline, so if a delta tier
  //     could exit first, the refusal an operator sees would depend on the
  //     padding — exactly the run-composition sensitivity this tier exists to
  //     remove. Checking it first makes the refusal for a given end state
  //     byte-identical regardless of how the tree got there.
  // Consequence, deliberately accepted: on a contract-violating tree run with
  // --allow-mass-delete, the process exits here and the F4 suppression NOTE for
  // the delta tiers is not reached. The run is refused either way, and the
  // contract refusal names its own (non-suppressible) escape route.
  const shapeFloors = loadShapeContract(assembledDir);
  const shapeViolations = shapeFloors === null ? [] : findShapeContractViolations(assembledFiles, shapeFloors);
  if (shapeViolations.length > 0) {
    const plural = shapeViolations.length === 1;
    console.error(
      'ERROR: refusing to overlay — the assembled tree does not satisfy the committed publish shape ' +
      `contract (${SHAPE_CONTRACT_RELATIVE_PATH}): ${shapeViolations.length} declared ` +
      `director${plural ? 'y holds' : 'ies hold'} fewer files DIRECTLY than the committed minimum. ` +
      "This tier checks the END STATE of the tree being published, not this run's delta, so it cannot " +
      'be renewed by spreading a drain across several runs nor diluted by inflating the tree with ' +
      'additions. It is not suppressed by --allow-mass-delete and has no runtime override: if this ' +
      `shape change is intentional, edit the committed ledger (${SHAPE_CONTRACT_RELATIVE_PATH}) — that ` +
      'edit is the operator-review moment this contract exists to create. No files were copied or ' +
      `deleted. Affected director${plural ? 'y' : 'ies'}:`
    );
    for (const v of shapeViolations) {
      console.error(formatShapeContractLine(v));
    }
    process.exit(1);
  }

  // T-541 rounds 2+3 — the SUCCESSION GATE. Reached only once the ordinary
  // floor check above has already passed — this is precisely the case the
  // ordinary check cannot see through: the reviewer's reproduction lowers
  // BOTH the observed count and the floor in the same edit (9/5 -> 3/2), so
  // the floor check above measures 3 >= 2 and passes cleanly. Invoked
  // UNCONDITIONALLY (T-541 round 3) — even when the assembled tree ships no
  // ledger at all (shapeFloors === null): a full clone anchor must still be
  // able to refuse an absent/partial assembled derivation, and an
  // unparseable clone ledger must still refuse regardless of the assembled
  // side's own state. See checkShapeContractSuccession()'s own header
  // comment for the full mechanism, the three discrimination rules, and the
  // residuals this does NOT close.
  const successionResult = checkShapeContractSuccession(cloneDir, assembledDir, shapeFloors, assembledFiles);
  if (successionResult && successionResult.refusal) {
    fail(
      'refusing to overlay — the publish shape contract succession gate rejected this publish: ' +
      `${successionResult.refusal}. No files were copied or deleted.`
    );
  }
  if (successionResult && successionResult.standDown) {
    console.error(
      `WARNING: publish shape contract succession (${SHAPE_CONTRACT_RELATIVE_PATH}): ${successionResult.standDown}`
    );
  }
  if (successionResult && successionResult.introduced) {
    console.error(
      `Publish shape contract succession (${SHAPE_CONTRACT_RELATIVE_PATH}): ${successionResult.introduced}`
    );
  }
  if (successionResult && successionResult.reseed) {
    // T-541 round 4 — GENERATED, not narrated: see formatReseedCertificateLine().
    console.error(formatReseedCertificateLine(successionResult.reseed));
  }
  if (successionResult && successionResult.removedKeyLines && successionResult.removedKeyLines.length > 0) {
    console.error(
      `WARNING: publish shape contract (${SHAPE_CONTRACT_RELATIVE_PATH}) seeding record entries removed ` +
      'relative to the previously published ledger:'
    );
    for (const line of successionResult.removedKeyLines) {
      console.error(line);
    }
  }
  if (successionResult && successionResult.weakening && successionResult.weakening.length > 0) {
    console.error(
      `WARNING: publish shape contract (${SHAPE_CONTRACT_RELATIVE_PATH}) floor(s) weakened relative to the ` +
      'previously published ledger:'
    );
    for (const line of successionResult.weakening) {
      console.error(line);
    }
  }

  // T-540 (T-533 security review, residual 3) — the ENFORCEMENT SIGNAL. Until
  // now the pass path printed nothing, so a release log was byte-identical
  // whether every declared floor had been enforced or the tier had stood down
  // entirely (ledger deleted, or dropped from the manifest's ship bucket — both
  // sanctioned, both silent). An operator reading the log could not tell the
  // difference, which made "the contract ran" an inference from the ABSENCE of a
  // refusal rather than a positive statement. Exactly one whole line, on the
  // pass path only, naming the ledger path and the number of floors enforced.
  // A ledger-less run deliberately prints nothing at all — that asymmetry is
  // what makes the line's presence informative rather than boilerplate.
  //
  // T-541 (T-540 residual 3) — the COUNT term alone is compensation-defeatable:
  // lowering one floor while raising another by the same amount leaves the
  // enforced COUNT, and therefore this whole line, byte-identical even though
  // the actual enforcement shifted. A SUM of the floor values was considered
  // and rejected for the identical reason (lowering one floor and raising
  // another by the same amount restores a byte-identical sum too). A digest
  // over every declared dir=floor PAIR changes if ANY single floor changes —
  // no combination of a raise and a lower can cancel out inside a hash — so it
  // is added alongside the count term, which stays for human readability.
  if (shapeFloors !== null) {
    const enforced = shapeFloors.size;
    const digest = shapeContractDigest(shapeFloors);
    console.log(
      `Publish shape contract (${SHAPE_CONTRACT_RELATIVE_PATH}): ${enforced} declared directory ` +
      `floor${enforced === 1 ? '' : 's'} enforced against the assembled tree (digest ${digest}) — all satisfied.`
    );
  }

  // Compute the full deletion plan FIRST — this is read-only (no copy, no
  // delete, no mkdir) — so the T-504/T-507 guards below can refuse with an
  // absolute guarantee that zero writes have happened yet.
  const { deletionCandidates, preservedPaths, nonPreservedCloneCount, dirStats } =
    planDeletion(cloneFiles, assembledSet, preserveKeys);

  // T-507 round 1 (F3) — move detection: a deletion candidate whose content
  // reappears at a DIFFERENT path in the assembled tree is a rename/move,
  // not genuine loss. `newAssembledPaths` are assembled paths absent from
  // the clone at that same path (new content OR a move's destination —
  // the move key is what tells them apart). Move-adjustment is applied to
  // the per-directory/aggregate/multi-directory guard's `deleted` counts
  // (via dirStatsForGuard) AND, separately, to the whole-clone ratio's own
  // deletedCount below — but NEVER to tier 1's full-wipe rule, which reads
  // `rawDeleted` and is therefore immune to move-credit entirely (see
  // adjustDirStatsForMoves()'s comment). Only the PHYSICAL copy/delete plan
  // (deletionCandidates itself, and the `deleted` count in the final
  // summary further down) is unaffected: moved files are still physically
  // absent from their old path in the clone and still get deleted there.
  //
  // T-507 round 2 (N1, tier 2) — two restrictions on eligibility, applied
  // BEFORE anything is handed to detectMovedPaths():
  //   - a deletion candidate under isLocationSemantic() (`.github/`,
  //     `.claude/hooks/`, `.claude/rules/`, `.claude/agents/`) is never
  //     added to `deletionCandidateHashes` at all — it can NEVER receive
  //     move credit, regardless of content or basename match, because its
  //     function comes from its location, not its bytes.
  //   - every remaining candidate/destination pair is keyed by
  //     buildMoveKey() (basename + content fingerprint), not content alone
  //     — content reappearing under a DIFFERENT filename is not what an
  //     ordinary rename looks like.
  //
  // T-507 round 3 (N1', mechanisms 1 and 2) — two further restrictions, both
  // derived rather than enumerated (LOCATION_SEMANTIC_PREFIXES is left
  // exactly as it is, a correct hard rule for its own four prefixes, but it
  // is the wrong SHAPE to be the fix here):
  //   - relatedness: detectMovedPaths() now credits a candidate only against
  //     a key-matching destination that is RELATED to it (shares its
  //     non-empty first path segment) — see isRelatedMove().
  //   - whole-run cap: however the individual credits are earned, the TOTAL
  //     credited in one run is capped against the baseline — see
  //     exceedsMoveCreditCap() and its use below.
  const newAssembledPaths = assembledFiles.filter((relPath) => !cloneFileSet.has(relPath));
  const deletionCandidateHashes = new Map();
  for (const relPath of deletionCandidates) {
    if (isLocationSemantic(relPath)) continue; // never eligible for move credit (tier 2)
    deletionCandidateHashes.set(relPath, buildMoveKey(relPath, fingerprintPath(cloneDir, relPath)));
  }
  const newAssembledHashes = new Map();
  for (const relPath of newAssembledPaths) {
    newAssembledHashes.set(relPath, buildMoveKey(relPath, fingerprintPath(assembledDir, relPath)));
  }
  const movedPaths = detectMovedPaths(deletionCandidateHashes, newAssembledHashes);
  const dirStatsForGuard = adjustDirStatsForMoves(dirStats, movedPaths);

  // T-507 round 3 (N1', mechanism 2) — whole-run move-credit cap verdict,
  // computed UNCONDITIONALLY (F4 discipline: never short-circuited by
  // allowMassDelete, so a suppressed refusal is still reported below).
  const moveCreditExceeds = exceedsMoveCreditCap(movedPaths.size, nonPreservedCloneCount, maxMoveCreditRatio);
  const moveCreditRatio = nonPreservedCloneCount === 0 ? 0 : movedPaths.size / nonPreservedCloneCount;

  // `deletedCount` here is the move-adjusted TRUE loss count, used only for
  // the whole-clone ratio guard's decision and messaging below — never for
  // the physical delete loop or the final "Overlay complete" summary
  // further down, which each compute their own count directly from
  // `deletionCandidates` (the actual, unadjusted list of paths to remove).
  const deletedCount = deletionCandidates.length - movedPaths.size;
  const ratio = nonPreservedCloneCount === 0 ? 0 : deletedCount / nonPreservedCloneCount;
  // T-507 round 1 (F2): an EXACT half-deletion used to pass silently under
  // the original strict `>`. Tightened to `>=` — but ONLY once the clone is
  // large enough (>= MIN_DIR_SIZE non-preserved files) for the ratio to be a
  // meaningful signal in the first place; below that, the same noise
  // rationale documented on MIN_DIR_SIZE applies (e.g. a 1-of-2 = exactly
  // 50% overlay is routine, not suspicious, and this is exactly the
  // regression a first pass at this fix reproduced against the base T-356
  // fixture — Test 1 below). This is also literally the "absolute floor on
  // the ship-set count delta" the round-1 review asked for: it is the SAME
  // whole-clone check T-504 already established, now (a) move-aware, same
  // as the per-directory guard — a small fixture where a rename happens to
  // dominate the whole clone (Test 15 below) must not be refused just
  // because of its size — and (b) closed against the exact-half boundary at
  // realistic tree sizes, so per-directory budget-summing cannot land
  // exactly on the 50% line undetected.
  const wholeCloneRatioIsStrict = nonPreservedCloneCount < MIN_DIR_SIZE;
  const wholeCloneExceeds =
    nonPreservedCloneCount > 0 && (wholeCloneRatioIsStrict ? ratio > maxDeleteRatio : ratio >= maxDeleteRatio);

  if (wholeCloneExceeds && !allowMassDelete) {
    console.error(
      `ERROR: refusing to overlay — planned deletion would remove ${deletedCount} of ` +
      `${nonPreservedCloneCount} non-preserved tracked file(s) in the clone ` +
      `(${(ratio * 100).toFixed(1)}%), ${wholeCloneRatioIsStrict ? 'exceeding' : 'meeting or exceeding'} ` +
      `the ${(maxDeleteRatio * 100).toFixed(1)}% max-delete-ratio threshold. No files were copied or ` +
      'deleted. If this deletion is intentional, re-run with --allow-mass-delete (or raise the ' +
      'threshold with --max-delete-ratio).'
    );
    process.exit(1);
  }

  // T-507 — per-directory composition guard, IN ADDITION to the whole-clone
  // ratio above: refuses when any single directory, or the aggregate of all
  // small directories, meets or exceeds maxDirDeleteRatio, or is completely
  // emptied outright (see findDirectoryViolations() for the exact three
  // rules). This is the check that catches the composition-preserving
  // bypass the whole-clone ratio structurally cannot see — see the file
  // header's "Per-directory composition guard" note. Uses dirStatsForGuard
  // (move-adjusted), not the raw dirStats, so a rename/reorg is not
  // mistaken for deletion (T-507 round 1, F3).
  const dirViolations = findDirectoryViolations(dirStatsForGuard, MIN_DIR_SIZE, maxDirDeleteRatio);

  // T-507 round 1 (F4): compute both guards' verdicts UNCONDITIONALLY (never
  // short-circuited by allowMassDelete) so a suppressed refusal can be
  // reported, not silently swallowed — an operator passing --allow-mass-delete
  // could not previously tell whether it actually suppressed anything.
  if (dirViolations.length > 0 && !allowMassDelete) {
    console.error(
      'ERROR: refusing to overlay — planned deletion would meet or exceed ' +
      `${(maxDirDeleteRatio * 100).toFixed(1)}% of the non-preserved tracked files in ` +
      `${dirViolations.length} director${dirViolations.length === 1 ? 'y' : 'ies'} of the clone ` +
      '(or completely empty one), exceeding the per-directory composition guard (checked in ' +
      'addition to the whole-clone max-delete-ratio above). No files were copied or deleted. ' +
      `Affected director${dirViolations.length === 1 ? 'y' : 'ies'}:`
    );
    for (const v of dirViolations) {
      console.error(formatDirViolationLine(v));
    }
    console.error(
      'If this directory-level deletion is intentional (e.g. a real restructure), re-run with ' +
      '--allow-mass-delete (or raise the threshold with --max-dir-delete-ratio).'
    );
    process.exit(1);
  }

  // T-507 round 3 (N1', mechanism 2) — the whole-run move-credit cap: even
  // when every individual credit is legitimately earned (related destination,
  // matching basename, matching content, no full wipe), crediting this much
  // of the baseline as "moved" in one overlay is not ordinary evolution. It
  // is the backstop for the case relatedness cannot see: an attacker who
  // relocates every file into an attic directory INSIDE its own top-level
  // segment keeps every per-directory count credited away to zero, so this
  // total is the only remaining signal.
  if (moveCreditExceeds && !allowMassDelete) {
    console.error(
      `ERROR: refusing to overlay — move credit was granted to ${movedPaths.size} of ` +
      `${nonPreservedCloneCount} non-preserved tracked file(s) in the clone ` +
      `(${(moveCreditRatio * 100).toFixed(1)}%), meeting or exceeding the ` +
      `${(maxMoveCreditRatio * 100).toFixed(1)}% whole-run move-credit cap (--max-move-credit-ratio). ` +
      'Move credit suppresses the per-directory and whole-clone deletion guards for the files it ' +
      'covers, so relocating this much of the published tree in a single overlay is refused on its ' +
      'own: for path-semantic files location IS function, and a mass relocation can disable the tree ' +
      'while every content-level gate (secret scan, size floor) still reports success. No files were ' +
      'copied or deleted. If this restructure is intentional, re-run with --allow-mass-delete (or ' +
      'raise the threshold with --max-move-credit-ratio).'
    );
    process.exit(1);
  }

  // T-507 round 1 (F4): --allow-mass-delete overrides BOTH guards silently
  // otherwise — report exactly what was suppressed, so an operator who
  // passed the flag out of habit (or because a PREVIOUS run needed it) can
  // see whether THIS run actually needed it too. T-507 round 3 (N1') adds the
  // whole-run move-credit cap to the same reporting path.
  if (allowMassDelete && (wholeCloneExceeds || dirViolations.length > 0 || moveCreditExceeds)) {
    console.log(
      '\nNOTE: --allow-mass-delete suppressed the following refusal(s) that would otherwise have ' +
      'blocked this overlay:'
    );
    if (wholeCloneExceeds) {
      console.log(
        `  - whole-clone: ${deletedCount} of ${nonPreservedCloneCount} ` +
        `(${(ratio * 100).toFixed(1)}%) >= ${(maxDeleteRatio * 100).toFixed(1)}% max-delete-ratio`
      );
    }
    for (const v of dirViolations) {
      console.log(formatDirViolationLine(v));
    }
    if (moveCreditExceeds) {
      console.log(
        `  - move-credit cap: ${movedPaths.size} of ${nonPreservedCloneCount} ` +
        `(${(moveCreditRatio * 100).toFixed(1)}%) >= ` +
        `${(maxMoveCreditRatio * 100).toFixed(1)}% whole-run move-credit cap (--max-move-credit-ratio)`
      );
    }
  }

  // Copy: every assembled file lands in the clone, overwriting whatever is there.
  let copied = 0;
  for (const relPath of assembledFiles) {
    copyFile(path.join(assembledDir, relPath), path.join(cloneDir, relPath));
    copied += 1;
  }

  // Delete: the plan computed above, unchanged.
  for (const relPath of deletionCandidates) {
    fs.rmSync(path.join(cloneDir, relPath), { force: true });
  }
  const deleted = deletionCandidates.length;

  pruneEmptyDirs(cloneDir);

  console.log(`\nOverlay complete: copied ${copied}, deleted ${deleted}, preserved ${preservedPaths.length}`);
  if (preservedPaths.length > 0) {
    console.log('Preserved paths (public-native — never deleted by the overlay):');
    for (const p of preservedPaths.sort()) console.log(`  - ${p}`);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  isPreserved,
  listFilesRecursive,
  listCloneFilesExcludingGit,
  parseArgs,
  planDeletion,
  DEFAULT_MAX_DELETE_RATIO,
  dirOf,
  findDirectoryViolations,
  MIN_DIR_SIZE,
  DIR_MAX_DELETE_RATIO,
  AGGREGATE_SMALL_DIR_LABEL,
  MULTI_DIR_AGGREGATE_LABEL,
  detectMovedPaths,
  adjustDirStatsForMoves,
  fingerprintPath,
  basenameOf,
  isLocationSemantic,
  LOCATION_SEMANTIC_PREFIXES,
  buildMoveKey,
  firstSegmentOf,
  isRelatedMove,
  exceedsMoveCreditCap,
  MOVE_CREDIT_MAX_RATIO,
  MOVE_CREDIT_MIN_COUNT,
  SHAPE_CONTRACT_RELATIVE_PATH,
  loadShapeContract,
  findShapeContractViolations,
  formatShapeContractLine,
  shapeContractDigest,
  buildDirectCountMap,
  loadClonePublishedLedger,
  loadAssembledSeedingRecord,
  checkShapeContractSuccession,
  computeObservedDelta,
  CANONICAL_SEEDED_ON_RE,
  findIncoherentFloorKeys,
  formatReseedCertificateLine,
};
