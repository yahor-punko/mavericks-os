#!/usr/bin/env node
// mavp-manifest-guard.js — advisory, creation-time publish-manifest guard (T-401).
//
// Intended to be wired as a PostToolUse hook on Edit|Write: takes the edited/
// written file's path as its single argument and, ONLY when this is the
// canonical (private) repo, checks whether that path is a tracked/new file
// NOT classified in scripts/publish-manifest.json. When it is, prints a
// stderr advisory naming the path and the manifest, plus the required
// action — but ALWAYS exits 0. This is advisory only: it must never block
// the Write/Edit tool call, because the file has to exist before it can be
// classified in the first place. See docs/rca/2026-07-publish-manifest-registration.md
// (RC-2, mechanism (e)) for the incident this closes.
//
// Canonical-detection heuristic (reused verbatim from
// scripts/test-publish-overlay.js's Test 4 gate — do not invent a new one):
// this is the canonical (private) repo iff EVERY key in the manifest's
// `exclude` bucket is a git-tracked path. In the public mirror / adopter
// repos, `exclude` paths are never tracked (they were never shipped), so the
// heuristic naturally resolves to non-canonical there and the guard is inert.
//
// Silent (exit 0, no output) in every one of these cases:
//   - no scripts/publish-manifest.json present (adopter repo without one)
//   - not the canonical repo (public mirror / adopter fork)
//   - not a git repository at all
//   - no path argument given
//   - the target path does not exist on disk
//   - the target path resolves outside the repo root
//   - the target path is gitignored (untracked-by-intent, e.g. node_modules/)
//   - the target path is already classified (ship / reset / exclude)
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

// Canonical iff every `exclude` key is git-tracked (same heuristic as
// scripts/test-publish-overlay.js Test 4 — see module comment above).
function isCanonicalRepo(manifest, trackedList) {
  const exclude = manifest.exclude && typeof manifest.exclude === 'object' ? manifest.exclude : {};
  const trackedSet = new Set(trackedList);
  return Object.keys(exclude).every((k) => trackedSet.has(k));
}

function isIgnored(relPath) {
  const result = spawnSync('git', ['check-ignore', '--quiet', relPath], { cwd: REPO_ROOT });
  return result.status === 0;
}

function main() {
  const argPath = process.argv[2];
  if (!argPath) {
    process.exit(0);
  }

  let manifest;
  try {
    manifest = loadManifest();
  } catch {
    // No manifest at all — nothing to enforce (adopter repo, public mirror).
    process.exit(0);
  }

  let trackedList;
  try {
    trackedList = getTrackedFiles();
  } catch {
    // Not a git repository — nothing to enforce.
    process.exit(0);
  }

  if (!isCanonicalRepo(manifest, trackedList)) {
    process.exit(0);
  }

  const absPath = path.resolve(process.cwd(), argPath);
  const relPath = path.relative(REPO_ROOT, absPath);
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    // Outside the repo root — not our concern.
    process.exit(0);
  }

  if (!fs.existsSync(absPath)) {
    process.exit(0);
  }

  if (isIgnored(relPath)) {
    // Gitignored / untracked-by-intent — never advise on these.
    process.exit(0);
  }

  const ship = Array.isArray(manifest.ship) ? manifest.ship : [];
  const reset = manifest.reset && typeof manifest.reset === 'object' ? manifest.reset : {};
  const exclude = manifest.exclude && typeof manifest.exclude === 'object' ? manifest.exclude : {};
  const classified = new Set([...ship, ...Object.keys(reset), ...Object.keys(exclude)]);

  if (classified.has(relPath)) {
    process.exit(0);
  }

  console.error(`MANIFEST GUARD: ${relPath} is a new/tracked file not classified in scripts/publish-manifest.json.`);
  console.error('Register it in the "ship" or "exclude" bucket before committing (run: node scripts/check-publish-manifest.js).');
  console.error(`If your role's scope excludes scripts/, emit: MANIFEST_REGISTRATION_NEEDED: ${relPath} -> <ship|exclude> (<reason>)`);

  process.exit(0);
}

module.exports = { isCanonicalRepo };

if (require.main === module) {
  main();
}
