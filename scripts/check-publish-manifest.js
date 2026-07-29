#!/usr/bin/env node
// check-publish-manifest.js — completeness check for scripts/publish-manifest.json (T-331).
//
// Verifies that scripts/publish-manifest.json classifies EVERY git-tracked path
// exactly once, as one of: ship (array), reset (object keyed by live-state path),
// or exclude (object keyed by path). Fails closed:
//   - any tracked path missing from the manifest (e.g. a NEW file added since the
//     manifest was written) is reported as an error, not silently skipped.
//   - any manifest path that is no longer tracked (a stale entry) is reported.
//   - any path classified in more than one bucket is reported.
//
// Reset-bucket keys may legitimately be UNTRACKED (T-529): a reset destination
// is a live-state artifact the assembler always repopulates from its mapped
// `templates/` starter (never from the live file — see
// scripts/mavp-publish-assemble.js), so nothing requires the destination path
// itself to be git-tracked. `.claude/settings.json` is untracked deliberately
// (the Claude Code permission layer appends operator command strings to it,
// which must never enter the git index — see .gitignore for the fresh-clone
// seed-from-template note). An untracked reset key is therefore exempt from
// the STALE-entry check below, but the exemption is narrow, not a blanket
// pass: its mapped STARTER path (the `templates/` file the assembler actually
// copies) MUST still be git-tracked, since that is what ships. A reset key
// whose starter is also untracked is reported as a distinct failure.
//
// `preserve` (T-356) is a SEPARATE namespace, not one of the three tracked-path
// buckets above: it names paths that exist ONLY in the public mirror (e.g.
// `.github/ISSUE_TEMPLATE/*`), never in the private git index. Its entries are
// therefore excluded from the tracked-path classification/stale checks (they
// would otherwise always fail as STALE, since git never tracks them here).
// Instead, `preserve` gets its own fail-closed check: no `preserve` entry may
// cover a path git DOES track (exact match, or prefix match for entries ending
// in "/") — that would silently shadow a real tracked path in the manifest's
// completeness accounting.
//
// Exit code 0 = clean (every tracked path classified exactly once, no stale
// entries, no preserve entry shadows a tracked path).
// Exit code 1 = one or more problems found (see stdout for details).
//
// `--if-canonical` flag (T-401): gates the whole check on being run inside
// the canonical (private) repo, using the same "every `exclude` key is
// git-tracked" heuristic as scripts/test-publish-overlay.js's Test 4. In the
// canonical repo, behaves exactly as the default (unflagged) invocation. In
// a non-canonical repo (public mirror / adopter fork — an exclude key is not
// tracked) OR a repo with no manifest at all, prints a short skip message
// and exits 0. This lets `--if-canonical` be wired unconditionally into a
// shared pre-commit hook without breaking non-canonical checkouts. Default
// (no flag) behavior is completely unchanged.
//
// T-550: this script used to accept ANY manifest shape that parsed as JSON,
// silently defaulting `ship`/`reset`/`exclude`/`preserve` to []/{} on a
// mistyped or absent bucket (see the old inline `Array.isArray(...) ? ... :
// []` idiom this replaced) — the exact same vacuous-GREEN class T-534 round
// 2 closed for the provenance verifier (see that module's own header). A
// malformed manifest now refuses via validateManifestBucketsShape() below
// BEFORE the completeness check ever runs, instead of quietly certifying a
// narrower (or empty) set than the manifest actually declares.
//
// No external dependencies — uses only Node's `child_process` + `fs`/`path`.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');
const VERIFY_PROVENANCE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-verify-provenance.js');

// T-550 — reuse (never re-implement) the shape contract T-534 round 2
// pinned for the provenance verifier, so `ship`/`reset` and the two T-550
// amendments (bare-"." rejection, reset-starter-under-templates/) stay a
// SINGLE definition shared by every consumer, instead of drifting out of
// step the way the pre-T-550 defaulting idiom already had (this script,
// the assembler, and the verifier each answered "what counts as valid"
// differently).
const { validateManifestShape, isPlainObject } = require(VERIFY_PROVENANCE_SCRIPT);

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

// T-550 — THE SHARED SHAPE CONTRACT for this consumer. Composes
// validateManifestShape() (the verifier's ship/reset/starter contract,
// reused unchanged) with the two extra buckets THIS script reads that the
// verifier never touches: `exclude` and `preserve`. Each is optional — an
// absent bucket is tolerated (this script's own completeness logic already
// treats "no exclude entries" and "no preserve entries" as a legitimate,
// if unusual, manifest) — but a PRESENT-and-malformed one (an array, a
// string, any non-plain-object) is refused with a named defect rather than
// silently defaulting to {} the way the pre-T-550 code did (see the old
// `manifest.exclude && typeof manifest.exclude === 'object' ? ... : {}`
// idiom this replaced). Never checks `ship`/`reset` itself a second time —
// that would drift from validateManifestShape() the moment either changed.
function validateManifestBucketsShape(manifest) {
  const shapeCheck = validateManifestShape(manifest);
  if (!shapeCheck.ok) return shapeCheck;
  if (Object.prototype.hasOwnProperty.call(manifest, 'exclude') && !isPlainObject(manifest.exclude)) {
    return { ok: false, reason: '`exclude` is present but not a plain (non-array) object' };
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'preserve') && !isPlainObject(manifest.preserve)) {
    return { ok: false, reason: '`preserve` is present but not a plain (non-array) object' };
  }
  return { ok: true };
}

// Returns the list of tracked paths (from `trackedList`) shadowed by a
// `preserve` entry: an entry ending in "/" shadows every tracked path under
// that prefix; an entry without a trailing "/" shadows that exact tracked
// path. Exported for reuse by the regression test.
function findPreserveShadowsTracked(preserve, trackedList) {
  const preserveKeys = Object.keys(preserve);
  const shadowed = [];
  for (const trackedPath of trackedList) {
    for (const preserveKey of preserveKeys) {
      const isPrefix = preserveKey.endsWith('/');
      const matches = isPrefix
        ? trackedPath === preserveKey.slice(0, -1) || trackedPath.startsWith(preserveKey)
        : trackedPath === preserveKey;
      if (matches) {
        shadowed.push({ trackedPath, preserveKey });
        break;
      }
    }
  }
  return shadowed;
}

// Runs the full completeness + preserve-shadow check against an explicit
// manifest object and tracked-file list (no process.exit, no I/O) so the
// regression test can exercise it directly against fixture data.
function validateManifest(manifest, trackedList) {
  const ship = Array.isArray(manifest.ship) ? manifest.ship : [];
  const reset = manifest.reset && typeof manifest.reset === 'object' ? manifest.reset : {};
  const exclude = manifest.exclude && typeof manifest.exclude === 'object' ? manifest.exclude : {};
  const preserve = manifest.preserve && typeof manifest.preserve === 'object' ? manifest.preserve : {};

  // Build a map of path -> [buckets it appears in], to detect double-classification.
  // `preserve` is intentionally NOT recorded here — it is a separate namespace
  // for public-native paths that are never git-tracked in this repo.
  const classification = new Map();
  const record = (bucketName, list) => {
    for (const p of list) {
      if (!classification.has(p)) classification.set(p, []);
      classification.get(p).push(bucketName);
    }
  };
  record('ship', ship);
  record('reset', Object.keys(reset));
  record('exclude', Object.keys(exclude));

  const trackedSet = new Set(trackedList);
  const manifestPaths = new Set(classification.keys());

  // Reset-bucket keys are allowed to be untracked (T-529) — see the module
  // comment above. Compute the untracked-reset-key set once so it can both
  // (a) be exempted from the STALE-entry check and (b) drive the narrow
  // replacement invariant: the reset key's mapped STARTER path must be
  // git-tracked, since that is what actually ships.
  const resetKeys = Object.keys(reset);
  const untrackedResetKeySet = new Set(resetKeys.filter((k) => !trackedSet.has(k)));
  const resetStarterUntracked = [...untrackedResetKeySet]
    .filter((destPath) => !trackedSet.has(reset[destPath]))
    .map((destPath) => ({ destPath, starterPath: reset[destPath] }));

  const missingFromManifest = trackedList.filter((p) => !manifestPaths.has(p));
  const staleInManifest = [...manifestPaths].filter(
    (p) => !trackedSet.has(p) && !untrackedResetKeySet.has(p)
  );
  const doubleClassified = [...classification.entries()].filter(([, buckets]) => buckets.length > 1);
  const preserveShadowsTracked = findPreserveShadowsTracked(preserve, trackedList);

  const problems = [];

  if (missingFromManifest.length > 0) {
    problems.push({
      title: `UNCLASSIFIED tracked paths (${missingFromManifest.length}) — missing from manifest:`,
      lines: missingFromManifest.sort(),
    });
  }

  if (staleInManifest.length > 0) {
    problems.push({
      title: `STALE manifest entries (${staleInManifest.length}) — no longer tracked by git:`,
      lines: staleInManifest.sort(),
    });
  }

  if (resetStarterUntracked.length > 0) {
    problems.push({
      title:
        `RESET STARTER UNTRACKED (${resetStarterUntracked.length}) — an untracked reset destination's ` +
        `mapped starter must be git-tracked, since that is what ships:`,
      lines: resetStarterUntracked
        .sort((a, b) => a.destPath.localeCompare(b.destPath))
        .map(({ destPath, starterPath }) => `${destPath} -> starter "${starterPath}" is not git-tracked`),
    });
  }

  if (doubleClassified.length > 0) {
    problems.push({
      title: `DOUBLE-CLASSIFIED paths (${doubleClassified.length}) — appear in more than one bucket:`,
      lines: doubleClassified
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([p, buckets]) => `${p} -> [${buckets.join(', ')}]`),
    });
  }

  if (preserveShadowsTracked.length > 0) {
    problems.push({
      title:
        `PRESERVE entries shadow git-tracked paths (${preserveShadowsTracked.length}) — narrow these entries, ` +
        `a preserve path must never cover a path the private repo already tracks:`,
      lines: preserveShadowsTracked
        .sort((a, b) => a.trackedPath.localeCompare(b.trackedPath))
        .map(({ trackedPath, preserveKey }) => `${trackedPath} <- shadowed by preserve["${preserveKey}"]`),
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      ship: ship.length,
      reset: Object.keys(reset).length,
      exclude: Object.keys(exclude).length,
      preserve: Object.keys(preserve).length,
      classified: classification.size,
      tracked: trackedList.length,
    },
  };
}

// Canonical iff every `exclude` key is git-tracked (same heuristic used by
// scripts/test-publish-overlay.js Test 4 and scripts/mavp-manifest-guard.js
// — do not invent a new one).
function isCanonicalRepo(manifest, trackedList) {
  const exclude = manifest.exclude && typeof manifest.exclude === 'object' ? manifest.exclude : {};
  const trackedSet = new Set(trackedList);
  return Object.keys(exclude).every((k) => trackedSet.has(k));
}

function main() {
  const ifCanonical = process.argv.slice(2).includes('--if-canonical');

  let manifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    if (ifCanonical) {
      console.log(`SKIP: no manifest found at ${MANIFEST_PATH} — --if-canonical treats a repo with no manifest as non-canonical.`);
      process.exit(0);
    }
    console.error(`ERROR: could not read/parse manifest at ${MANIFEST_PATH}: ${err.message}`);
    process.exit(1);
  }

  // T-550 — SHAPE REFUSAL, before a single path is classified. A manifest
  // that parses as JSON but does not match the shared shape contract (see
  // validateManifestBucketsShape()'s own comment) refuses here with a
  // named defect, unconditionally (including under --if-canonical — a
  // present-but-malformed manifest is a real defect, never grounds to
  // silently treat the repo as non-canonical).
  const shapeCheck = validateManifestBucketsShape(manifest);
  if (!shapeCheck.ok) {
    console.error(`ERROR: manifest failed shape validation: ${shapeCheck.reason}`);
    process.exit(1);
  }

  const tracked = getTrackedFiles();

  if (ifCanonical && !isCanonicalRepo(manifest, tracked)) {
    console.log('SKIP: non-canonical repo (an exclude key is not git-tracked) — --if-canonical only enforces in the canonical private repo.');
    process.exit(0);
  }

  const result = validateManifest(manifest, tracked);

  for (const problem of result.problems) {
    console.error(`\n${problem.title}`);
    for (const line of problem.lines) console.error(`  - ${line}`);
  }

  if (!result.ok) {
    console.error('\nFAIL: publish manifest is incomplete or inconsistent. See details above.');
    process.exit(1);
  }

  console.log('OK: publish manifest classifies every tracked path exactly once.');
  console.log(
    `  ship: ${result.counts.ship}  reset: ${result.counts.reset}  exclude: ${result.counts.exclude}  ` +
      `preserve: ${result.counts.preserve}  total classified: ${result.counts.classified}  ` +
      `tracked: ${result.counts.tracked}`
  );
  process.exit(0);
}

module.exports = {
  validateManifest,
  findPreserveShadowsTracked,
  isCanonicalRepo,
  // T-550 — the shape contract for this consumer's own two extra buckets
  // (`exclude`/`preserve`, layered on top of the reused ship/reset
  // contract), exported for its own regression test to exercise directly.
  // mavp-publish-assemble.js does NOT require this — it never reads
  // exclude/preserve, so it calls validateManifestShape() directly from
  // mavp-publish-verify-provenance.js instead of pulling in this extra hop.
  validateManifestBucketsShape,
};

if (require.main === module) {
  main();
}
