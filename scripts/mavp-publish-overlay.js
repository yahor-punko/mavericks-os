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
//
// No external dependencies — uses only Node's `fs` + `path`.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
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
  const assembledDirArg = process.argv[2];
  const cloneDirArg = process.argv[3];
  if (!assembledDirArg || !cloneDirArg) {
    console.error('Usage: node scripts/mavp-publish-overlay.js <assembled-dir> <clone-dir>');
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

  // Copy: every assembled file lands in the clone, overwriting whatever is there.
  let copied = 0;
  for (const relPath of assembledFiles) {
    copyFile(path.join(assembledDir, relPath), path.join(cloneDir, relPath));
    copied += 1;
  }

  // Delete: clone files not in the assembled tree and not preserved.
  const preservedPaths = [];
  let deleted = 0;
  for (const relPath of cloneFiles) {
    if (assembledSet.has(relPath)) continue; // just (re)written above
    if (isPreserved(relPath, preserveKeys)) {
      preservedPaths.push(relPath);
      continue;
    }
    fs.rmSync(path.join(cloneDir, relPath), { force: true });
    deleted += 1;
  }

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

module.exports = { isPreserved, listFilesRecursive, listCloneFilesExcludingGit };
