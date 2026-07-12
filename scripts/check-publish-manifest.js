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
// No external dependencies — uses only Node's `child_process` + `fs`/`path`.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
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

  const missingFromManifest = trackedList.filter((p) => !manifestPaths.has(p));
  const staleInManifest = [...manifestPaths].filter((p) => !trackedSet.has(p));
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

function main() {
  let manifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    console.error(`ERROR: could not read/parse manifest at ${MANIFEST_PATH}: ${err.message}`);
    process.exit(1);
  }

  const tracked = getTrackedFiles();
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

module.exports = { validateManifest, findPreserveShadowsTracked };

if (require.main === module) {
  main();
}
