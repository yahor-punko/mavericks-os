#!/usr/bin/env node
// mavp-publish-assemble.js — assembles the public copy-forward publish tree (T-332).
//
// Reads scripts/publish-manifest.json (T-331) and builds an output directory
// containing:
//   - every `ship` path, byte-for-byte as tracked at HEAD
//   - every `reset` destination, populated from its mapped templates/ starter's
//     HEAD content (so the live-state artifact in the output equals the starter)
//   - nothing else (no `exclude` paths, no untracked/on-disk-only files)
//
// CRITICAL: all file content is sourced from the git index at HEAD via
// `git archive HEAD`, never read from the working-directory disk. This makes
// untracked files (e.g. .claude/settings.local.json, .claude/mcp.json)
// structurally unreachable, regardless of what secrets they may contain on disk.
//
// Before assembling, this script runs the same completeness check as
// check-publish-manifest.js (invoked as a child process) and fails closed
// (exits non-zero, assembles nothing) if any tracked path is unclassified,
// stale, or double-classified.
//
// After assembling, it runs a built-in completeness check on the OUTPUT tree
// in both directions: every manifest ship path + every reset destination must
// be present, and nothing else may be present. Exits non-zero on any mismatch.
//
// Usage: node scripts/mavp-publish-assemble.js <out-dir>
//
// T-550: this script used to default `ship` to [] and `reset` to {} when
// either bucket was absent or mistyped (`Array.isArray(manifest.ship) ?
// manifest.ship : []` / the object-typeof equivalent for `reset`) — the
// same vacuous-GREEN class T-534 round 2 closed for the provenance
// verifier, just reached from a different entry point: instead of
// certifying zero paths, this script would ASSEMBLE zero (or a silently
// narrowed) ship set and report success. loadManifest() below now refuses
// via validateManifestShape() (reused, never re-implemented, from
// mavp-publish-verify-provenance.js — the established shared home for this
// contract) before main() ever reads `manifest.ship`/`manifest.reset`.
// TRUTH ANCHOR for this consumer specifically: the disk manifest compared
// against the HEAD tree extraction below (extractHeadTreeToTemp) — never
// the git index (that is check-publish-manifest.js's job) and never the
// verifier's own HEAD-anchored manifest read (this script's whole point is
// assembling from whatever is CURRENTLY on disk, uncommitted edits
// included, so it must read the disk manifest, not HEAD's).
//
// No external dependencies — uses only Node's `child_process`, `fs`, `path`, `os`.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');
const CHECK_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-publish-manifest.js');
const VERIFY_PROVENANCE_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'mavp-publish-verify-provenance.js');

// T-550 — reused (never re-implemented) from the established shared home;
// see this file's header for why this is the right truth anchor for THIS
// consumer even though the rule itself is shared.
const { validateManifestShape } = require(VERIFY_PROVENANCE_SCRIPT_PATH);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function loadManifest() {
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
  const shapeCheck = validateManifestShape(manifest);
  if (!shapeCheck.ok) {
    fail(`manifest at ${MANIFEST_PATH} failed shape validation: ${shapeCheck.reason}`);
  }
  return manifest;
}

// Runs the T-331 completeness check as a child process. Fails closed (exits
// non-zero, assembles nothing) if the manifest does not classify every
// git-tracked path exactly once.
function runPreflightCompletenessCheck() {
  const result = require('node:child_process').spawnSync(
    process.execPath,
    [CHECK_SCRIPT_PATH],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );

  if (result.error) {
    fail(`failed to run completeness check (${CHECK_SCRIPT_PATH}): ${result.error.message}`);
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    console.error(
      '\nFAIL: preflight manifest completeness check failed (see paths above). ' +
        'Assembling nothing (fail closed).'
    );
    process.exit(result.status === 0 ? 1 : result.status);
  }
}

// Extracts the full HEAD tree (git-index content only, never the working
// directory) into a fresh temp directory via `git archive` + `tar`, and
// returns the temp directory path. Caller is responsible for cleanup.
function extractHeadTreeToTemp() {
  const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-publish-head-'));
  const tarPath = path.join(tempExtractDir, '.head-archive.tar');

  execFileSync('git', ['archive', '--format=tar', 'HEAD', '-o', tarPath], {
    cwd: REPO_ROOT,
  });
  execFileSync('tar', ['-xf', tarPath, '-C', tempExtractDir]);
  fs.unlinkSync(tarPath);

  return tempExtractDir;
}

// Copies a tracked entry (regular file OR symlink) from the git-archive
// extraction into the output tree, preserving symlinks as symlinks (git
// itself may track symlinks, e.g. `.claude/skills/*` shortcuts). Using
// fs.copyFileSync on a symlink can fail on macOS (ENOTSUP), so symlinks are
// detected via lstat and recreated explicitly instead of dereferenced.
// fs.existsSync() follows symlinks (uses stat), so a dangling or
// relative-outside-tree symlink (e.g. `.claude/skills/*` shortcuts) would
// incorrectly report as absent even though the tracked entry itself exists
// in the extraction. Use lstat so symlink entries themselves count as present.
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Resolves `relPath` under `parentDir` and asserts the result stays inside
// `parentDir`, via path.relative: the resolved path only escapes when
// relPath contains ".." segments that walk past parentDir's root, in which
// case the relative result either starts with ".." or is itself absolute
// (path.relative can return an absolute path on some platforms when the two
// paths share no common root). Fails closed (non-zero, no write attempted)
// rather than silently clamping or stripping the offending segments, because
// a manifest entry that tries to escape its parent is a hostile/corrupt
// input, not something to "fix and continue". Applied to BOTH the
// extraction-side source resolution (tempExtractDir) and the output-side
// destination resolution (outDir) for every ship/reset entry — the same
// manifest string is untrusted in both directions.
function resolveContained(parentDir, relPath, label) {
  const resolved = path.join(parentDir, relPath);
  const rel = path.relative(parentDir, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    fail(
      `${label} "${relPath}" resolves outside of "${parentDir}" (path escape refused). ` +
        'Manifest entries must never contain ".." segments.'
    );
  }
  return resolved;
}

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

// Recursively lists all file paths (including symlinks-to-files, matched by
// git's own bookkeeping — git tracks symlinks as blobs) under `dir`, relative
// to `dir`, using '/' as the separator (matching git's path convention).
// Uses lstat semantics (via withFileTypes, which does not follow symlinks)
// so a symlink is listed as its own leaf entry rather than dereferenced.
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

function main() {
  const outDirArg = process.argv[2];
  if (!outDirArg) {
    console.error('Usage: node scripts/mavp-publish-assemble.js <out-dir>');
    process.exit(1);
  }
  const outDir = path.resolve(outDirArg);

  // Guardrail: never assemble into the mavericks repo itself.
  if (outDir === REPO_ROOT || outDir.startsWith(REPO_ROOT + path.sep)) {
    fail(`refusing to assemble into a path inside the source repo: ${outDir}`);
  }

  // T-550 — loadManifest() already refused above (via validateManifestShape)
  // on any malformed shape, so `manifest.ship`/`manifest.reset` are read
  // directly here rather than through the old defaulting idiom.
  const manifest = loadManifest();
  const ship = manifest.ship;
  const reset = manifest.reset;
  // exclude is read for completeness but intentionally never copied.

  console.log('Running preflight manifest completeness check...');
  runPreflightCompletenessCheck();
  console.log('OK: manifest classifies every tracked path exactly once.\n');

  console.log('Extracting HEAD tree from the git index (not the working directory disk)...');
  const tempExtractDir = extractHeadTreeToTemp();

  try {
    // Fresh output directory — remove any stale prior contents so the
    // post-assembly completeness check reflects only this run's output.
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`Assembling ${ship.length} ship path(s)...`);
    for (const shipPath of ship) {
      const srcPath = resolveContained(tempExtractDir, shipPath, 'ship source path');
      if (!pathExists(srcPath)) {
        fail(`ship path "${shipPath}" not found in HEAD tree extraction — manifest/index mismatch.`);
      }
      const destPath = resolveContained(outDir, shipPath, 'ship destination path');
      copyFile(srcPath, destPath);
    }

    const resetDestPaths = Object.keys(reset);
    console.log(`Assembling ${resetDestPaths.length} reset destination(s) from their templates/ starters...`);
    for (const destPath of resetDestPaths) {
      const starterPath = reset[destPath];
      const srcPath = resolveContained(tempExtractDir, starterPath, 'reset starter path');
      if (!pathExists(srcPath)) {
        fail(
          `reset starter "${starterPath}" (for destination "${destPath}") not found in HEAD tree extraction.`
        );
      }
      const resolvedDestPath = resolveContained(outDir, destPath, 'reset destination path');
      copyFile(srcPath, resolvedDestPath);
    }

    // exclude paths are omitted entirely — no action needed.

    console.log('\nRunning post-assembly completeness check on the output tree...');
    const expected = new Set([...ship, ...resetDestPaths]);
    const actual = new Set(listFilesRecursive(outDir));

    const missingFromOutput = [...expected].filter((p) => !actual.has(p));
    const unexpectedInOutput = [...actual].filter((p) => !expected.has(p));

    let ok = true;
    if (missingFromOutput.length > 0) {
      ok = false;
      console.error(`\nMISSING from assembled output (${missingFromOutput.length}):`);
      for (const p of missingFromOutput.sort()) console.error(`  - ${p}`);
    }
    if (unexpectedInOutput.length > 0) {
      ok = false;
      console.error(`\nUNEXPECTED in assembled output (${unexpectedInOutput.length}):`);
      for (const p of unexpectedInOutput.sort()) console.error(`  - ${p}`);
    }

    if (!ok) {
      console.error('\nFAIL: assembled output does not match manifest ship-set + reset destinations.');
      process.exit(1);
    }

    console.log(
      `OK: assembled output contains exactly the expected ${expected.size} file(s) ` +
        `(ship: ${ship.length}, reset: ${resetDestPaths.length}).`
    );
    console.log(`\nDone. Output written to: ${outDir}`);
    process.exit(0);
  } finally {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
}

// Exported for the T-505 regression test (test-publish-assemble-containment.js)
// to exercise resolveContained()/pathExists()/copyFile() directly against
// fixture data — mirrors the module.exports pattern already used by
// check-publish-manifest.js. CLI behavior (`node scripts/mavp-publish-assemble.js
// <out-dir>`) is unchanged: main() still runs unconditionally when this file
// is executed directly.
module.exports = { resolveContained, pathExists, copyFile, listFilesRecursive };

if (require.main === module) {
  main();
}
