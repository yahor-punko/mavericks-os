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
// Exit code 0 = clean (every tracked path classified exactly once, no stale entries).
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

function main() {
  let manifest;
  try {
    manifest = loadManifest();
  } catch (err) {
    console.error(`ERROR: could not read/parse manifest at ${MANIFEST_PATH}: ${err.message}`);
    process.exit(1);
  }

  const ship = Array.isArray(manifest.ship) ? manifest.ship : [];
  const reset = manifest.reset && typeof manifest.reset === 'object' ? manifest.reset : {};
  const exclude = manifest.exclude && typeof manifest.exclude === 'object' ? manifest.exclude : {};

  // Build a map of path -> [buckets it appears in], to detect double-classification.
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

  const tracked = getTrackedFiles();
  const trackedSet = new Set(tracked);
  const manifestPaths = new Set(classification.keys());

  const missingFromManifest = tracked.filter((p) => !manifestPaths.has(p));
  const staleInManifest = [...manifestPaths].filter((p) => !trackedSet.has(p));
  const doubleClassified = [...classification.entries()].filter(([, buckets]) => buckets.length > 1);

  let ok = true;

  if (missingFromManifest.length > 0) {
    ok = false;
    console.error(`\nUNCLASSIFIED tracked paths (${missingFromManifest.length}) — missing from manifest:`);
    for (const p of missingFromManifest.sort()) console.error(`  - ${p}`);
  }

  if (staleInManifest.length > 0) {
    ok = false;
    console.error(`\nSTALE manifest entries (${staleInManifest.length}) — no longer tracked by git:`);
    for (const p of staleInManifest.sort()) console.error(`  - ${p}`);
  }

  if (doubleClassified.length > 0) {
    ok = false;
    console.error(`\nDOUBLE-CLASSIFIED paths (${doubleClassified.length}) — appear in more than one bucket:`);
    for (const [p, buckets] of doubleClassified.sort((a, b) => a[0].localeCompare(b[0]))) {
      console.error(`  - ${p} -> [${buckets.join(', ')}]`);
    }
  }

  if (!ok) {
    console.error('\nFAIL: publish manifest is incomplete or inconsistent. See details above.');
    process.exit(1);
  }

  console.log('OK: publish manifest classifies every tracked path exactly once.');
  console.log(
    `  ship: ${ship.length}  reset: ${Object.keys(reset).length}  exclude: ${Object.keys(exclude).length}  ` +
      `total classified: ${classification.size}  tracked: ${tracked.length}`
  );
  process.exit(0);
}

main();
