#!/usr/bin/env node
// mavp-private-names-guard.js — commit-time private-name backstop (T-600).
//
// A colliding private identifier merged in wave 72 surfaced two waves later
// as an aborted release build. The root cause was DETECTION LATENCY, not a
// missing rule: the publish gate (scripts/mavp-publish-scan.js) already
// catches this class, but it only runs at release time, and it was not run
// between merge and release. This guard closes the latency gap by running
// the SAME detection categories at COMMIT time, in the canonical repo only.
//
// Scope — STAGED ship-classified files ONLY, not the whole tracked ship set:
//   - an unstaged edit must never block an unrelated commit
//   - the incident class is a colliding identifier BEING COMMITTED
//   - the full-set sweep stays the publish gate's job (mavp-publish-scan.js
//     against an assembled tree) — this script never assembles a tree
//   - this keeps the guard O(staged files), not O(tracked files)
//
// Scans PATHS as well as CONTENTS, reusing scanEntryPath (T-601) from
// mavp-publish-scan.js — a commit-time gate that only scanned contents would
// be born with the exact blind spot T-601 just closed at publish time. Per
// scanEntryPath's own doc comment, this is exactly the shape it was designed
// for: no assembled tree exists at commit time, so the same repo-relative
// staged path string is passed for both its `identityPath` and `relPath`
// arguments.
//
// Names source — a gitignored `.mavp/private-names` file (single line,
// comma-separated, byte-compatible with parsePrivateNamesList()), with the
// existing MAVP_PRIVATE_NAMES env var as fallback via resolvePrivateNames().
// The real names list can never live in a tracked file (that would defeat
// its own purpose), which is exactly why no shipped CI test can catch this
// class — only a canonical-repo-local mechanism can.
//
// Inertness is FREE, not something this script builds extra gating for:
// `core.hooksPath` is a relative path, so worktree commits DO run the
// tracked hook, but no worktree, adopter repo, or mirror clone ever has the
// untracked names file (or the env var set) — absent names source means
// zero usable names, buildCategories() adds no "Private repo name" category
// beyond the always-on shape-based ones, and... actually: even the
// always-on categories (EXA token, AWS key, /Users/ path, email, etc.) would
// still run and could theoretically fire in a non-canonical repo. That is
// intentional, not a gap — those categories are equally valid secret/PII
// hygiene in ANY repo, canonical or not, and a real finding there is never a
// false positive worth suppressing. What "inert" means here, precisely, is:
// this guard cannot itself be the difference between "safe to commit" and
// "not" when its very reason for existing (a private-name collision) has no
// names to detect against — which is exactly the case when the untracked
// names source is absent.
//
// Failure mode — CONSERVATIVE. This guard runs inside a blocking pre-commit
// hook on THIS repo's own commits, including this task's own commits. A bug
// here that throws must never block every commit in the repo — so main() is
// wrapped in a top-level try/catch that fails OPEN (exits 0, prints a
// warning) on any unexpected internal error. The only path that blocks a
// commit is an actual, positively-identified finding.
//
// No external dependencies — reuses mavp-publish-scan.js's exported scanning
// primitives (never duplicates their logic) plus Node's `fs`/`path`/
// `child_process`.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  scanTextAgainstCategories,
  scanEntryPath,
  buildCategories,
  resolvePrivateNames,
  PATH_LOCATION_MARKER,
} = require('./mavp-publish-scan.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const NAMES_FILE = path.join(REPO_ROOT, '.mavp', 'private-names');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

// Reads the names-source file's raw content (trimmed), or null when the file
// does not exist. Returning null (not '') on absence matters: it lets
// resolvePrivateNames() fall through to the MAVP_PRIVATE_NAMES env var
// fallback exactly the way its own cliValue-vs-undefined contract expects —
// see mavp-publish-scan.js's resolvePrivateNames() doc comment.
function readNamesFileRaw() {
  try {
    return fs.readFileSync(NAMES_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

// Loads the manifest's `ship` array, or null when no manifest exists at all
// (adopter repos, worktrees, the public mirror — this guard has nothing to
// classify staged files against there, so callers treat null as "inert").
function loadShipList() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
  return Array.isArray(manifest.ship) ? manifest.ship : [];
}

// A staged path is ship-classified when it exactly matches a `ship` entry,
// or sits nested under a `ship` entry that names a directory (the assembler
// copies ship directories recursively — see mavp-publish-assemble.js).
function isShipClassified(relPath, shipList) {
  for (const entry of shipList) {
    if (relPath === entry) return true;
    if (relPath.startsWith(`${entry}/`)) return true;
  }
  return false;
}

// Returns the list of staged (index) paths that are Added/Copied/Modified/
// Renamed — i.e. paths whose STAGED content is about to be committed. Pure
// deletions (D) are deliberately excluded: a deleted path has no staged
// content left to scan, and scanning its path string alone would be a
// no-value false-positive surface (a private name in a path that is being
// REMOVED from the tree is not a new leak).
function getStagedFiles() {
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-M'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

// Reads a staged path's STAGED (index) blob content via `git show :<path>` —
// never the working-tree copy, which could differ from what is about to be
// committed. Returns null for anything unreadable as UTF-8 text (binary
// blobs, etc.) — the caller still runs the path-string scan for such files,
// just skips the content scan.
function readStagedContent(relPath) {
  try {
    return execFileSync('git', ['show', `:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
}

function runGuard() {
  const rawNames = readNamesFileRaw();
  const privateNames = resolvePrivateNames(rawNames);

  if (privateNames.length === 0) {
    console.log(
      'SKIP: mavp-private-names-guard — no names source (.mavp/private-names ' +
        'or MAVP_PRIVATE_NAMES) — inert.'
    );
    return 0;
  }

  const shipList = loadShipList();
  if (shipList === null) {
    console.log('SKIP: mavp-private-names-guard — no scripts/publish-manifest.json — inert.');
    return 0;
  }

  const categories = buildCategories(privateNames);
  const staged = getStagedFiles();
  const shipStaged = staged.filter((relPath) => isShipClassified(relPath, shipList));

  const findings = [];
  for (const relPath of shipStaged) {
    // Path scan first (T-601 dependency) — runs regardless of whether the
    // content scan below succeeds, so a leak in the NAME alone is caught
    // even for binary/unreadable files.
    scanEntryPath(relPath, relPath, findings, categories);

    const content = readStagedContent(relPath);
    if (content === null) continue;
    const lines = content.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      scanTextAgainstCategories(relPath, i + 1, lines[i], findings, categories);
    }
  }

  if (findings.length === 0) {
    console.log(
      `OK: mavp-private-names-guard — scanned ${shipStaged.length} staged ship-classified ` +
        'file(s) — zero findings.'
    );
    return 0;
  }

  console.error(`FOUND ${findings.length} finding(s) in staged file(s):\n`);
  for (const f of findings) {
    const loc = f.line === PATH_LOCATION_MARKER ? `${f.file} (${PATH_LOCATION_MARKER})` : `${f.file}:${f.line}`;
    console.error(`  [${f.category}] ${loc}  ${f.match}`);
  }
  console.error('\nBLOCKED: private-name collision detected in staged ship-classified file(s) — see above.');
  return 1;
}

function main() {
  let exitCode;
  try {
    exitCode = runGuard();
  } catch (err) {
    // Conservative failure mode (see file header): an internal bug in this
    // guard must never block every commit in the repo. Fail OPEN, loudly.
    console.error(
      `WARNING: mavp-private-names-guard crashed unexpectedly (${err && err.message}) — ` +
        'failing open (not blocking this commit).'
    );
    process.exit(0);
  }
  process.exit(exitCode);
}

module.exports = {
  readNamesFileRaw,
  loadShipList,
  isShipClassified,
  getStagedFiles,
  readStagedContent,
  runGuard,
};

if (require.main === module) {
  main();
}
