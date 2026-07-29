#!/usr/bin/env node
// mavp-publish-verify-provenance.js — T-534: content-provenance gate.
//
// Every existing publish-pipeline guard (the size floor, the overlay's
// deletion-ratio tiers, the secret scanner) is PATH-shaped: it reacts to
// paths appearing, disappearing, or moving. None of them react to a file's
// CONTENT being replaced in place while the path set stays untouched — that
// produces zero deletion candidates, an unchanged file count, and (unless the
// replacement happens to contain a known secret shape or private name) zero
// scanner findings. The assembled tree's window between the scan gate
// (mavp-publish-scan.js, step 2 of mavp-publish-build.js) and the push (step
// 7) — plus any defect in the assembler itself — was therefore entirely
// unverified before this file existed.
//
// This script asserts BYTE-LEVEL provenance of an already-assembled tree
// (the output of mavp-publish-assemble.js) against the two things that
// actually define what SHOULD be there, resolved through
// scripts/publish-manifest.json:
//   - every `ship` path's assembled bytes must equal the private repo's own
//     HEAD blob for that SAME path;
//   - every `reset` destination's assembled bytes must equal the HEAD blob of
//     its MAPPED templates/ starter (manifest.reset[destPath]) — never the
//     destination path's own HEAD blob, and never anything read from disk.
//
// TWO TRAPS THIS DELIBERATELY AVOIDS:
//   (1) A naive per-path HEAD lookup for reset destinations. A reset
//       destination (e.g. `.claude/settings.json`) can be UNTRACKED at HEAD
//       in the private repo as of T-529 (see publish-manifest.json's
//       `reset_reasons` entry) — `git show HEAD:<destPath>` for such a path
//       either fails outright or, if it happens to still be tracked, answers
//       a question this gate does not care about. The only thing that
//       defines a reset destination's CORRECT content is its mapped starter
//       in templates/, so that is the ONLY path ever looked up for a reset
//       entry.
//   (2) Reading the live on-disk file (in either the private repo checkout
//       or the assembled tree's own source) instead of the git blob. A
//       reset key being untracked after T-529 means "read it from disk"
//       would silently compare a file to itself, or to nothing, rather than
//       to its actual source of truth. Every "expected" value in this file
//       comes from `git show HEAD:<path>` — never `fs.readFileSync` against
//       the private repo checkout.
//
// FAIL-CLOSED, not fail-open: if git itself is unusable, or a manifest path
// cannot be read from HEAD at all, this is treated as a MISMATCH (refusal),
// never as "nothing to compare, so pass". A check that cannot verify its own
// claim must not report success.
//
// ROUND 2 (security review round 1 returned one HIGH and one MEDIUM):
//   HIGH  — this module used to default `ship` to [] and `reset` to {} when
//           the manifest bucket was absent or mistyped, so a malformed or
//           absent bucket reported ok:true having verified ZERO paths —
//           exactly the "cannot verify its own claim" failure the header
//           above forbids. validateManifestShape() below now refuses on any
//           malformed shape BEFORE a single path is compared (see its own
//           comment for the tolerated/refused boundary).
//   MEDIUM — this module only ever certified the ASSEMBLED tree (tempOutDir),
//           never the tree actually committed onto the mirror clone's local
//           `edge` and pushed. assertCleanSourceRepo() (mavp-publish-build.js)
//           guards the SOURCE repo's cleanliness only — nothing pins or
//           checks the CLONE's own `git add`/`commit` behaviour, so a global
//           `core.autocrlf=true` on a future operator machine can transcode
//           shipped text at `git add -A` inside the clone while this file's
//           assembled-tree check stays GREEN (it never re-reads the clone).
//           verifyCommittedTreeProvenance() below closes this by certifying
//           the CLONE's own committed tree — content AND git-tree mode,
//           git-blob-to-git-blob only, never disk — against the same
//           HEAD/starter blobs. See mavp-publish-build.js's stepCommit() for
//           the paired PREVENTION pin (`-c core.autocrlf=false -c
//           core.safecrlf=false` on the `git add -A` call site) — this
//           module is the DETECTION half of that same fix.
//
// Both rounds also fixed a smaller gap: the default manifest source is now
// `git show HEAD:scripts/publish-manifest.json` (never a disk read) unless
// `--manifest`/`opts.manifestPath` is given as an EXPLICIT override — the
// declared ship/reset set is itself an expected value, and this file's own
// FAIL-CLOSED rule above already forbids reading expected values from disk.
//
// Symlinks: git stores a tracked symlink as a blob whose bytes are the link
// TARGET string (verified: `git show HEAD:<symlink-path>` returns the target
// text, no trailing newline). mavp-publish-assemble.js recreates such paths
// as real symlinks in the assembled tree (fs.symlinkSync), not as text files
// containing the target. So a symlink entry is compared as
// readlink(assembled path) vs the HEAD blob bytes of the tracked path — never
// by following the symlink and reading whatever it happens to resolve to.
//
// No external dependencies — Node built-ins only (.claude/rules/scripts.md).
//
// Usage:
//   node scripts/mavp-publish-verify-provenance.js <assembled-out-dir>
//     [--manifest <path-to-publish-manifest.json>] [--repo-root <path>]
//
//   Exits 0 (silent success message) when every ship path and every reset
//   destination's assembled bytes match their resolved HEAD blob. Exits 1,
//   naming the offending path, on the first mismatch, missing path, or
//   unverifiable comparison found (ship paths are checked before reset
//   destinations; within each bucket, manifest order).

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// The manifest's location RELATIVE to a repo root — used both for the
// HEAD-anchored default read (git show HEAD:<MANIFEST_REL_PATH>) and, via
// path.join(REPO_ROOT, ...), as an informational absolute path. It is never
// used as a disk-read default any more (round 2, criterion 2) — see
// loadManifestFromHead()'s own comment.
const MANIFEST_REL_PATH = path.join('scripts', 'publish-manifest.json');
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, MANIFEST_REL_PATH);

// A generous ceiling for `git show` output — the largest shipped binary
// assets today are a few hundred KB (docs/assets/*.gif), but this is sized
// well above any current shipped file rather than tuned to today's sizes.
const GIT_SHOW_MAX_BUFFER = 64 * 1024 * 1024;

// Explicit disk override ONLY (`--manifest` / `opts.manifestPath`) — trusts
// the caller. Never used as the default read path any more; see
// loadManifestFromHead() below.
function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw);
}

// T-534 round 2 (criterion 2) — HEAD-ANCHORED MANIFEST READ, the default.
// The declared ship/reset set is itself an "expected value", and this
// file's own FAIL-CLOSED rule (file header) already forbids reading
// expected values from disk. `assertCleanSourceRepo()` in
// mavp-publish-build.js already enforces disk==HEAD for the real pipeline,
// so this is behavior-neutral there — but it is NOT redundant: it is the
// correct default for ANY other caller of this module that does not make
// that same guarantee, and it closes the gap where an uncommitted
// disk-manifest edit could otherwise narrow (or widen) the verified set
// without that edit ever having been reviewed or committed.
function loadManifestFromHead(repoRoot) {
  const blob = readHeadBlob(repoRoot, MANIFEST_REL_PATH);
  if (!blob.ok) {
    throw new Error(
      `could not read the manifest from HEAD (git show HEAD:${MANIFEST_REL_PATH} in ${repoRoot} failed: ${blob.error})`
    );
  }
  return JSON.parse(blob.buffer.toString('utf8'));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A valid manifest path entry: a non-empty string, no leading "/" (never an
// absolute path), no ".." path segment (never a traversal outside the tree
// being compared), and — T-534 round 4 (criterion 3, LOW rider from
// security review round 2, slice A) — no bare "." path segment either. This
// module matches manifest keys as exact strings against git plumbing
// (`git show <ref>:<path>`, `git ls-tree <ref> -- <path>`), never through a
// path-resolution layer that would collapse a redundant "." segment for it —
// so an unnormalized "." segment is a distinct, unintended key shape, the
// same unfuzzed-traversal class round 2's manifest-shape contract already
// closed for ".." and a leading "/".
function isValidRelPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/')) return false;
  const segments = value.split('/');
  if (segments.includes('..')) return false;
  if (segments.includes('.')) return false;
  return true;
}

// T-534 round 2 (criterion 1) — MANIFEST SHAPE CONTRACT. Round 1 defaulted
// `ship` to [] and `reset` to {} on ANY absent/mistyped bucket, so a
// malformed manifest reported ok:true having verified ZERO paths (security
// review round 1, HIGH — the reviewer reproduced this against the real
// manifest with `reset` absent, and separately with `ship` as a non-array
// string plus a tampered file present; both returned {"ok":true}). This
// validates the manifest's SHAPE before a single path is ever compared.
//
// TOLERATED DELIBERATELY (this is the false-refusal boundary, and it is as
// load-bearing as the refusals — every task this wave that added a refusal
// produced a false one, twice caught only by the suite):
//   - an explicitly-present empty `reset: {}` — an unambiguous
//     reviewed-diff declaration. The canonical repo cannot commit an
//     absent-vs-empty `reset` silently either way: 5 of the 6 real reset
//     keys are tracked live-state files whose unclassification reddens
//     `check-publish-manifest` at pre-commit.
//   - unknown top-level keys (`reset_reasons`, `preserve`, `exclude` — these
//     belong to OTHER tools; a key whitelist would have false-refused the
//     manifest the day `preserve` was added).
// REFUSED: an empty `ship` array (a zero-path certificate is the
// vacuous-GREEN class this gate exists to close — and
// assertAssembledTreeNonTrivial() already makes a zero-ship publish
// unproducible in the real pipeline, so this collides with nothing
// legitimate); `ship` absent/non-array; any ship entry or reset key/value
// that is not a non-empty string, or that contains ".." or a leading "/" or
// a bare "." segment; `reset` absent, or present but not a plain
// (non-array) object (today's `typeof === 'object'` check used to accept
// an array — this now refuses that shape explicitly); a reset value (the
// mapped starter) that is not under `templates/`.
//
// T-550 (two amendments from T-534's security review round 2, architect-
// ruled — both fold into THIS contract rather than a separate one, since
// every consumer of validateManifestShape() inherits them for free):
//   (a) the bare-"." segment rejection above is isValidRelPath()'s own
//       rule (see its comment) — restated here only so this function's
//       header stays a complete enumeration of what it refuses.
//   (b) RESET STARTER MUST LIVE UNDER templates/ — the verifier's own file
//       header states the starter is the ONLY thing that defines a reset
//       destination's correct content, yet nothing before this stopped a
//       manifest edit from mapping a reset destination to any OTHER
//       tracked path. Not attacker-reachable today (the manifest is
//       HEAD-anchored, so a change needs a reviewed commit) and
//       behaviour-neutral for the real manifest (all six committed
//       starters already live under templates/) — a prose invariant that
//       was never mechanically enforced, now closed structurally. A
//       future relaxation (a starter living elsewhere) stays a reviewed
//       one-line contract edit, not a silent gap.
function validateManifestShape(manifest) {
  if (!isPlainObject(manifest)) {
    return { ok: false, reason: 'manifest is not a plain (non-array) object at its top level' };
  }
  if (!Array.isArray(manifest.ship)) {
    return { ok: false, reason: '`ship` is missing or not an array' };
  }
  if (manifest.ship.length === 0) {
    return {
      ok: false,
      reason:
        '`ship` is an empty array — a zero-path certificate is the vacuous-GREEN class this gate refuses ' +
        '(assertAssembledTreeNonTrivial already makes a zero-ship publish unproducible in the real pipeline, ' +
        'so this collides with nothing legitimate)',
    };
  }
  for (const shipPath of manifest.ship) {
    if (!isValidRelPath(shipPath)) {
      return {
        ok: false,
        reason: `ship entry ${JSON.stringify(shipPath)} is not a valid relative path (must be a non-empty ` +
          'string, no ".." segment, no leading "/")',
      };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'reset')) {
    return {
      ok: false,
      reason:
        '`reset` is missing — an explicitly-present empty `reset: {}` is tolerated, an absent key is not ' +
        '(this gate cannot tell "nothing to reset" apart from "the bucket was silently dropped")',
    };
  }
  if (!isPlainObject(manifest.reset)) {
    return { ok: false, reason: '`reset` is present but not a plain (non-array) object' };
  }
  for (const [destPath, starterPath] of Object.entries(manifest.reset)) {
    if (!isValidRelPath(destPath)) {
      return { ok: false, reason: `reset destination key ${JSON.stringify(destPath)} is not a valid relative path` };
    }
    if (!isValidRelPath(starterPath)) {
      return {
        ok: false,
        reason:
          `reset destination ${JSON.stringify(destPath)}'s mapped starter ${JSON.stringify(starterPath)} is ` +
          'not a valid relative path',
      };
    }
    // T-550 amendment (b) — see this function's header comment for the
    // ground. Checked as its own segment (not folded into isValidRelPath,
    // which also gates ship entries and reset DESTINATION keys — neither of
    // which is constrained to templates/) so the refusal names the rule
    // that actually fired rather than a generic "invalid path" message.
    if (!starterPath.startsWith('templates/')) {
      return {
        ok: false,
        reason:
          `reset destination ${JSON.stringify(destPath)}'s mapped starter ${JSON.stringify(starterPath)} is ` +
          'not under templates/ — the starter is the only thing that defines a reset destination\'s correct ' +
          'content, so it must live under templates/',
      };
    }
  }
  return { ok: true };
}

// Fails closed rather than let every subsequent `git show` fail individually
// with a less legible error — checked once, up front, so an unusable git
// binary/repo is reported as exactly what it is instead of as N separate
// "could not read blob" findings.
function assertGitAvailable(repoRoot) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        `git is not available or ${repoRoot} is not a usable git repository ` +
        `(git rev-parse --git-dir failed: ${err.stderr || err.message}) — refusing to certify content ` +
        'provenance this script cannot actually verify.',
    };
  }
}

// Reads the git blob at <ref>:<relPath> in repoDir, as raw bytes — never the
// working-directory disk. Returns { ok:false } (never throws) on any
// failure, including "path does not exist in the tree at <ref>" — that is
// itself a mismatch this gate must report, not silently skip.
function readBlobAtRef(repoDir, ref, relPath) {
  try {
    const buffer = execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: repoDir,
      maxBuffer: GIT_SHOW_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, error: err.stderr || err.message || String(err) };
  }
}

// Convenience alias kept as its own exported name (existing callers/tests
// use it directly) — HEAD is just one particular ref of readBlobAtRef().
function readHeadBlob(repoRoot, relPath) {
  return readBlobAtRef(repoRoot, 'HEAD', relPath);
}

// Reads the git-tree MODE (e.g. "100644", "100755", "120000") recorded for
// <relPath> at <ref> in repoDir, via `git ls-tree` — never `fs.statSync`
// (T-534 round 2, criterion 4: mode is compared ONLY git-to-git, on both
// sides, precisely to avoid a disk-umask false refusal; comparing it
// git-to-git is what catches an exec-bit flip a blob-only comparison would
// miss). Returns { ok:false } (never throws) when the path is not present in
// the tree listing or `git ls-tree` itself fails.
function readTreeMode(repoDir, ref, relPath) {
  try {
    const out = execFileSync('git', ['ls-tree', ref, '--', relPath], { cwd: repoDir, encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.length > 0);
    if (!line) {
      return { ok: false, error: `"${relPath}" is not present in the "${ref}" tree listing (git ls-tree returned nothing)` };
    }
    const mode = line.split(/\s+/)[0];
    return { ok: true, mode };
  } catch (err) {
    return { ok: false, error: err.stderr || err.message || String(err) };
  }
}

// True when relPath is excluded by a .gitignore reachable from cloneDir's
// working tree.
//
// T-534 ROUND 5 (security review round 3, finding A) — THE REAL INVARIANT,
// replacing a comment that used to assert something FALSE: ignore rules
// govern UNTRACKED paths only. A path already present in the git INDEX
// stages regardless of any exclude pattern that later matches it — this is
// documented git behavior, and `git check-ignore` NEVER reports a tracked
// path as ignored (verified live: a tracked file matching an ignore
// pattern exits 1 here with no rule reported, while the very same `git add
// -A` still stages its modification). This is exactly WHY the old
// ignore-only-keyed skip at both call sites below happened to be safe for
// a TRACKED reset destination even before this round's re-key: for a
// tracked path this function already returns false, so neither call site
// ever skipped a path that genuinely needed verifying. `.claude/
// settings.json` is the intended STEADY STATE of "ignored AND tracked" —
// the shipped `.gitignore` protects an ADOPTER's local pollution, while the
// destination stays a real tracked path in the mirror clone from the
// publish that first committed it (before this ignore rule existed) — this
// function correctly returns false for it, and it is fully verified below
// regardless of the match.
//
// The residual this round closes: relying on THIS function's index-
// awareness alone, undocumented and unpinned, made the old skip
// INCIDENTALLY correct rather than correct by construction — a future
// refactor swapping check-ignore for `--no-index` or a hand-rolled pattern
// match would silently reopen the reviewer's reported hole with nothing
// turning red. Both call sites below now ALSO require explicit presence-
// awareness (isPathInCommittedTree() here, isPathInIndex() in
// mavp-publish-build.js) so the skip's correctness no longer depends on
// this function's particular implementation.
function isGitIgnoredInClone(cloneDir, relPath) {
  const result = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: cloneDir });
  return result.status === 0;
}

// True when relPath is present in the git TREE at `ref` inside cloneDir —
// used by verifyCommittedTreeProvenance()'s reset-destination re-key (T-534
// round 5) to decide whether the gitignored-reset skip may fire (see the
// call site's own comment). `git ls-tree <ref> -- <relPath>` exits 0 with
// EMPTY stdout for a path genuinely absent from the tree at `ref` (a clean,
// non-error result — the same exit-code shape isGitIgnoredInClone() above
// relies on for check-ignore) and non-zero ONLY on a genuine git failure
// (bad ref, unreadable repo, corrupt objects). Returns { ok:false } (never
// throws) on the latter — a git ERROR is fail-closed for the caller, never
// treated as "absent".
function isPathInCommittedTree(cloneDir, ref, relPath) {
  const result = spawnSync('git', ['ls-tree', ref, '--', relPath], { cwd: cloneDir, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `git ls-tree exited with status ${result.status}` };
  }
  return { ok: true, present: result.stdout.trim().length > 0 };
}

// True when relPath is present in the git INDEX inside cloneDir — used by
// mavp-publish-build.js's bindStagedFileModesToHeadOrAbort() (T-534 round
// 5 re-key) to decide whether its gitignored-reset skip may fire, checked
// on the POST-`git add -A` index (the same index isGitIgnoredInClone()
// above would consult at that point). `git ls-files --cached -- <relPath>`
// exits 0 with EMPTY stdout for a path genuinely absent from the index (a
// clean, non-error result, mirroring isPathInCommittedTree()'s exit-code
// shape) and non-zero ONLY on a genuine git failure. Returns { ok:false }
// (never throws) on the latter — a git ERROR is fail-closed for the
// caller, never treated as "absent". Exported for mavp-publish-build.js —
// this file is the established shared home for these predicates (it
// already exports readTreeMode/isGitIgnoredInClone/resolveManifestBuckets
// for the same reason).
function isPathInIndex(cloneDir, relPath) {
  const result = spawnSync('git', ['ls-files', '--cached', '--', relPath], { cwd: cloneDir, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() || `git ls-files exited with status ${result.status}` };
  }
  return { ok: true, present: result.stdout.trim().length > 0 };
}

// Reads an entry from the assembled tree. A symlink entry is read via
// readlinkSync (its target STRING is the comparable value, matching what git
// itself stores for a symlink blob — see file header); a regular file is
// read via readFileSync. Uses lstat so a symlink entry is never followed.
function readAssembledEntry(outDir, relPath) {
  const abs = path.join(outDir, relPath);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (stat.isSymbolicLink()) {
    return { ok: true, buffer: Buffer.from(fs.readlinkSync(abs)) };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `not a regular file or symlink (mode-shaped entry unsupported for provenance comparison)` };
  }
  try {
    return { ok: true, buffer: fs.readFileSync(abs) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Recursively lists every FILE or SYMLINK entry (never a directory itself,
// and a symlink is never followed) under outDir, as manifest-relative
// forward-slash paths — used only by the completeness sweep below. Throws
// on an unreadable directory (the caller turns that into a whole-run
// refusal, same fail-closed posture as everything else in this file).
function listAssembledTreePaths(outDir) {
  const results = [];
  function walk(relDir) {
    const absDir = relDir ? path.join(outDir, relDir) : outDir;
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else {
        results.push(relPath);
      }
    }
  }
  walk('');
  return results;
}

// T-534 round 4 (criterion 1, MODE BINDING) — shared manifest resolution.
// mavp-publish-build.js's stepCommit() needs the SAME declared ship/reset
// sets this file already loads and shape-validates for its two verify
// functions below, so it can bind the clone's index modes to the same
// paths — never a hand-rolled re-load or re-validation of the manifest a
// THIRD place, which is exactly how the two verify functions would drift
// out of step with a caller doing its own thing. Same load path as both
// verify functions (HEAD-anchored by default, `opts.manifestPath` as the
// explicit disk override), same shape contract, returned as a plain
// `{ ok, ship, reset }` / `{ ok: false, reason }` pair rather than a
// throwing call, so a caller can fail closed with its own wording.
function resolveManifestBuckets(options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || REPO_ROOT;
  let manifest;
  try {
    manifest = opts.manifestPath ? loadManifest(opts.manifestPath) : loadManifestFromHead(repoRoot);
  } catch (err) {
    return {
      ok: false,
      reason: opts.manifestPath
        ? `could not read/parse manifest at ${opts.manifestPath}: ${err.message}`
        : `could not read/parse manifest: ${err.message}`,
    };
  }
  const shapeCheck = validateManifestShape(manifest);
  if (!shapeCheck.ok) {
    return { ok: false, reason: shapeCheck.reason };
  }
  return { ok: true, ship: manifest.ship, reset: manifest.reset };
}

// Pure verification. Never logs, never exits — returns
// { ok: true, counts: { ship, reset } } or { ok: false, path, reason }.
// `path` is the manifest path (ship path, or reset DESTINATION path) the
// mismatch/failure is about, or null when the failure is not about any
// single path (e.g. git unusable, the manifest itself could not be read, or
// it failed the shape contract).
function verifyAssembledTreeProvenance(outDir, options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || REPO_ROOT;

  const gitCheck = assertGitAvailable(repoRoot);
  if (!gitCheck.ok) {
    return { ok: false, path: null, reason: gitCheck.reason };
  }

  let manifest;
  try {
    manifest = opts.manifestPath ? loadManifest(opts.manifestPath) : loadManifestFromHead(repoRoot);
  } catch (err) {
    return {
      ok: false,
      path: null,
      reason: opts.manifestPath
        ? `could not read/parse manifest at ${opts.manifestPath}: ${err.message}`
        : `could not read/parse manifest: ${err.message}`,
    };
  }

  const shapeCheck = validateManifestShape(manifest);
  if (!shapeCheck.ok) {
    return { ok: false, path: null, reason: shapeCheck.reason };
  }

  const ship = manifest.ship;
  const reset = manifest.reset;

  // Ship entries: assembled bytes at <shipPath> must equal HEAD:<shipPath>
  // in the PRIVATE repo (repoRoot) — a direct, per-path HEAD lookup is
  // correct here (unlike reset destinations below) because a ship path is,
  // by definition, tracked at HEAD (mavp-publish-assemble.js already fails
  // closed if it is not — see its own preflight completeness check).
  for (const shipPath of ship) {
    const assembled = readAssembledEntry(outDir, shipPath);
    if (!assembled.ok) {
      return {
        ok: false,
        path: shipPath,
        reason: `assembled tree is missing (or cannot read) ship path "${shipPath}": ${assembled.error}`,
      };
    }
    const head = readHeadBlob(repoRoot, shipPath);
    if (!head.ok) {
      return {
        ok: false,
        path: shipPath,
        reason:
          `could not read the private repo's HEAD blob for ship path "${shipPath}" (git show HEAD:${shipPath} ` +
          `failed: ${head.error}) — refusing to certify unverifiable provenance`,
      };
    }
    if (!assembled.buffer.equals(head.buffer)) {
      return {
        ok: false,
        path: shipPath,
        reason: `assembled bytes for ship path "${shipPath}" do not match the private repo's HEAD blob for that path`,
      };
    }
  }

  // Reset destinations: assembled bytes at <destPath> must equal
  // HEAD:<starterPath> — the MAPPED templates/ starter (manifest.reset[destPath]),
  // NEVER destPath's own HEAD blob (see file header trap 1) and never a
  // disk read of either path (trap 2).
  for (const destPath of Object.keys(reset)) {
    const starterPath = reset[destPath];
    const assembled = readAssembledEntry(outDir, destPath);
    if (!assembled.ok) {
      return {
        ok: false,
        path: destPath,
        reason: `assembled tree is missing (or cannot read) reset destination "${destPath}": ${assembled.error}`,
      };
    }
    const head = readHeadBlob(repoRoot, starterPath);
    if (!head.ok) {
      return {
        ok: false,
        path: destPath,
        reason:
          `could not read the private repo's HEAD blob for reset starter "${starterPath}" (mapped from ` +
          `destination "${destPath}"; git show HEAD:${starterPath} failed: ${head.error}) — refusing to ` +
          'certify unverifiable provenance',
      };
    }
    if (!assembled.buffer.equals(head.buffer)) {
      return {
        ok: false,
        path: destPath,
        reason:
          `assembled bytes for reset destination "${destPath}" do not match its mapped starter ` +
          `"${starterPath}"'s HEAD blob`,
      };
    }
  }

  // T-534 round 2 (criterion 3) — COMPLETENESS SWEEP. The loops above only
  // ever look FOR a declared path; they never enumerate what is actually
  // present, so they already catch every MISSING ship/reset path but cannot
  // react to an EXTRA path added to the assembled tree after assembly (a
  // planted addition post-scan produces zero deletion candidates, an
  // unchanged expected-path count, and — barring a coincidental secret-shaped
  // name — zero scan findings: the exact blind spot none of the other gates
  // cover). This sweep asserts the assembled tree's recursive file set
  // equals ship UNION reset-destinations EXACTLY.
  let assembledPaths;
  try {
    assembledPaths = listAssembledTreePaths(outDir);
  } catch (err) {
    return { ok: false, path: null, reason: `could not enumerate the assembled tree at ${outDir}: ${err.message}` };
  }
  const expected = new Set(ship);
  for (const destPath of Object.keys(reset)) expected.add(destPath);
  const actual = new Set(assembledPaths);
  for (const p of assembledPaths) {
    if (!expected.has(p)) {
      return {
        ok: false,
        path: p,
        reason: `assembled tree contains "${p}", which is not declared in ship or reset — an unexpected addition after assembly`,
      };
    }
  }
  for (const p of expected) {
    if (!actual.has(p)) {
      return {
        ok: false,
        path: p,
        reason: `assembled tree is missing "${p}" from its recursive file set (declared in ship or reset but absent from the tree)`,
      };
    }
  }

  return { ok: true, counts: { ship: ship.length, reset: Object.keys(reset).length } };
}

// T-534 round 2 (criterion 4) — COMMITTED-TREE CERTIFICATION. Closes the
// MEDIUM structurally: verifyAssembledTreeProvenance() above certifies
// tempOutDir (the assembled tree BEFORE it is staged/committed) — it never
// sees what actually landed in the commit on the clone's local `edge`,
// which is the tree stepPush() in mavp-publish-build.js actually transmits.
// This compares, for every ship path and reset destination, the blob at
// `<ref>:<path>` in `cloneDir` against the SAME expected blob this file
// already resolves for the assembled-tree check (private-repo HEAD for
// ship, mapped templates/ starter HEAD for reset) — git-blob-to-git-blob on
// BOTH sides, never disk (symlinks compare as target strings; no lstat,
// locale or umask surface) — PLUS a `git ls-tree` MODE comparison, also
// git-to-git only, because blob equality alone misses an exec-bit flip
// (e.g. on `scripts/mavp-operator`).
//
// Deliberately NO clone-side set-equality: the committed tree legitimately
// carries preserve-bucket paths whose shape stays owned by the overlay's own
// guards (T-504/T-507/T-532/T-533), and duplicating that ownership here is
// exactly where a false refusal would breed.
//
// T-534 ROUND 5 (security review round 3, finding A) — RE-KEYED, and the
// comment corrected: it used to claim a gitignored reset destination "never
// reaches the clone's committed git tree at all via `git add -A`" — that
// claim is FALSE whenever the destination is already TRACKED (all six
// reset destinations are tracked at the mirror's origin/main today,
// including `.claude/settings.json`, whose committed blob is byte-
// identical to its mapped starter). The real invariant (see
// isGitIgnoredInClone()'s own comment): ignore rules govern UNTRACKED paths
// only, so this loop's skip below fires ONLY when the destination is BOTH
// absent from the committed tree at `ref` (via isPathInCommittedTree(),
// never inferred from the ignore match alone) AND ignore-matched — a
// tracked destination is fully verified regardless of any ignore match. A
// git ERROR from the presence check (as distinct from clean absence) is
// fail-closed here, never treated as a skip.
//
// `ref` is caller-supplied (mavp-publish-build.js passes 'HEAD', since
// `edge` is the checked-out branch in cloneDir at the point this runs) so
// this stays a pure, reusable primitive rather than assuming a branch name.
//
// T-534 ROUND 6 scope note: this re-key's mutant IS killable — see Test 25
// in scripts/test-publish-verify-provenance.js — but that test's index/ref
// divergence is unreachable at this pipeline's own call point (Test 25's
// own header explains why); it pins this exported function's
// untrusted-input contract, not a state the pipeline itself can reach.
// Unlike the mode binder's re-key (mavp-publish-build.js), which is a
// provably equivalent mutant for every pipeline-reachable e2e input and is
// kept instead as an invariant-conditioned guard (see that call site's own
// comment and Test 26 in this file's own test suite).
function verifyCommittedTreeProvenance(cloneDir, ref, options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || REPO_ROOT;

  const sourceGitCheck = assertGitAvailable(repoRoot);
  if (!sourceGitCheck.ok) {
    return { ok: false, path: null, reason: sourceGitCheck.reason };
  }
  const cloneGitCheck = assertGitAvailable(cloneDir);
  if (!cloneGitCheck.ok) {
    return { ok: false, path: null, reason: `committed-tree check target ${cloneDir}: ${cloneGitCheck.reason}` };
  }

  let manifest;
  try {
    manifest = opts.manifestPath ? loadManifest(opts.manifestPath) : loadManifestFromHead(repoRoot);
  } catch (err) {
    return {
      ok: false,
      path: null,
      reason: opts.manifestPath
        ? `could not read/parse manifest at ${opts.manifestPath}: ${err.message}`
        : `could not read/parse manifest: ${err.message}`,
    };
  }

  const shapeCheck = validateManifestShape(manifest);
  if (!shapeCheck.ok) {
    return { ok: false, path: null, reason: shapeCheck.reason };
  }

  const ship = manifest.ship;
  const reset = manifest.reset;

  for (const shipPath of ship) {
    const committed = readBlobAtRef(cloneDir, ref, shipPath);
    if (!committed.ok) {
      return {
        ok: false,
        path: shipPath,
        reason: `committed tree "${ref}" in ${cloneDir} is missing (or cannot read) ship path "${shipPath}": ${committed.error}`,
      };
    }
    const head = readHeadBlob(repoRoot, shipPath);
    if (!head.ok) {
      return {
        ok: false,
        path: shipPath,
        reason:
          `could not read the private repo's HEAD blob for ship path "${shipPath}" (git show HEAD:${shipPath} ` +
          `failed: ${head.error}) — refusing to certify unverifiable provenance`,
      };
    }
    if (!committed.buffer.equals(head.buffer)) {
      return {
        ok: false,
        path: shipPath,
        reason:
          `committed bytes for ship path "${shipPath}" at "${ref}" in ${cloneDir} do not match the private ` +
          "repo's HEAD blob for that path",
      };
    }
    const committedMode = readTreeMode(cloneDir, ref, shipPath);
    const headMode = readTreeMode(repoRoot, 'HEAD', shipPath);
    if (!committedMode.ok || !headMode.ok) {
      return {
        ok: false,
        path: shipPath,
        reason:
          `could not read git-tree mode for ship path "${shipPath}" (committed: ` +
          `${committedMode.ok ? committedMode.mode : committedMode.error}; HEAD: ` +
          `${headMode.ok ? headMode.mode : headMode.error}) — refusing to certify an unverifiable mode`,
      };
    }
    if (committedMode.mode !== headMode.mode) {
      return {
        ok: false,
        path: shipPath,
        reason:
          `committed git-tree mode for ship path "${shipPath}" at "${ref}" (${committedMode.mode}) does not ` +
          `match the private repo's HEAD mode (${headMode.mode})`,
      };
    }
  }

  for (const destPath of Object.keys(reset)) {
    const starterPath = reset[destPath];
    // T-534 round 5 re-key — see this function's own header comment above
    // for the full rationale. Presence is checked FIRST and fails closed on
    // a git error; the skip fires only for a destination BOTH absent from
    // the committed tree at `ref` AND ignore-matched.
    const treePresence = isPathInCommittedTree(cloneDir, ref, destPath);
    if (!treePresence.ok) {
      return {
        ok: false,
        path: destPath,
        reason:
          `could not determine whether reset destination "${destPath}" is present in the committed tree ` +
          `"${ref}" in ${cloneDir} (${treePresence.error}) — refusing to certify unverifiable provenance`,
      };
    }
    if (!treePresence.present && isGitIgnoredInClone(cloneDir, destPath)) {
      continue;
    }
    const committed = readBlobAtRef(cloneDir, ref, destPath);
    if (!committed.ok) {
      return {
        ok: false,
        path: destPath,
        reason: `committed tree "${ref}" in ${cloneDir} is missing (or cannot read) reset destination "${destPath}": ${committed.error}`,
      };
    }
    const head = readHeadBlob(repoRoot, starterPath);
    if (!head.ok) {
      return {
        ok: false,
        path: destPath,
        reason:
          `could not read the private repo's HEAD blob for reset starter "${starterPath}" (mapped from ` +
          `destination "${destPath}"; git show HEAD:${starterPath} failed: ${head.error}) — refusing to ` +
          'certify unverifiable provenance',
      };
    }
    if (!committed.buffer.equals(head.buffer)) {
      return {
        ok: false,
        path: destPath,
        reason:
          `committed bytes for reset destination "${destPath}" at "${ref}" in ${cloneDir} do not match its ` +
          `mapped starter "${starterPath}"'s HEAD blob`,
      };
    }
    const committedMode = readTreeMode(cloneDir, ref, destPath);
    const headMode = readTreeMode(repoRoot, 'HEAD', starterPath);
    if (!committedMode.ok || !headMode.ok) {
      return {
        ok: false,
        path: destPath,
        reason:
          `could not read git-tree mode for reset destination "${destPath}" (committed: ` +
          `${committedMode.ok ? committedMode.mode : committedMode.error}; starter HEAD: ` +
          `${headMode.ok ? headMode.mode : headMode.error}) — refusing to certify an unverifiable mode`,
      };
    }
    if (committedMode.mode !== headMode.mode) {
      return {
        ok: false,
        path: destPath,
        reason:
          `committed git-tree mode for reset destination "${destPath}" at "${ref}" (${committedMode.mode}) ` +
          `does not match its mapped starter "${starterPath}"'s HEAD mode (${headMode.mode})`,
      };
    }
  }

  return { ok: true, counts: { ship: ship.length, reset: Object.keys(reset).length } };
}

function parseArgs(argv) {
  const positional = [];
  let manifestPath = null;
  let repoRoot = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest') {
      manifestPath = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--manifest=')) {
      manifestPath = arg.slice('--manifest='.length);
    } else if (arg === '--repo-root') {
      repoRoot = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--repo-root=')) {
      repoRoot = arg.slice('--repo-root='.length);
    } else {
      positional.push(arg);
    }
  }
  return { outDir: positional[0], manifestPath, repoRoot };
}

function main() {
  const { outDir: outDirArg, manifestPath, repoRoot } = parseArgs(process.argv.slice(2));
  if (!outDirArg) {
    console.error(
      'Usage: node scripts/mavp-publish-verify-provenance.js <assembled-out-dir> ' +
        '[--manifest <path>] [--repo-root <path>]'
    );
    process.exit(1);
  }
  const outDir = path.resolve(outDirArg);
  const result = verifyAssembledTreeProvenance(outDir, {
    manifestPath: manifestPath ? path.resolve(manifestPath) : undefined,
    repoRoot: repoRoot ? path.resolve(repoRoot) : undefined,
  });
  if (!result.ok) {
    console.error(
      `ABORT: content-provenance check failed${result.path ? ` for path "${result.path}"` : ''}: ${result.reason}`
    );
    process.exit(1);
  }
  console.log(
    `Content-provenance check GREEN — ${result.counts.ship} ship path(s) and ${result.counts.reset} reset ` +
      'destination(s) in the assembled tree verified against their resolved HEAD blob (private repo HEAD for ' +
      'ship paths, mapped templates/ starter HEAD for reset destinations).'
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  verifyAssembledTreeProvenance,
  verifyCommittedTreeProvenance,
  readHeadBlob,
  readBlobAtRef,
  readTreeMode,
  readAssembledEntry,
  assertGitAvailable,
  validateManifestShape,
  isValidRelPath,
  // T-550 — exported so check-publish-manifest.js can validate its own two
  // extra buckets (`exclude`, `preserve`) as plain objects using the exact
  // same primitive validateManifestShape() uses for its top level and
  // `reset`, rather than a second hand-rolled `typeof` check.
  isPlainObject,
  isGitIgnoredInClone,
  // T-534 round 5 — presence predicates, shared home (see their own
  // comments): the committed-tree side used internally by
  // verifyCommittedTreeProvenance() above; the index side exported for
  // mavp-publish-build.js's bindStagedFileModesToHeadOrAbort() re-key.
  isPathInCommittedTree,
  isPathInIndex,
  // T-534 round 4 — the shared manifest-resolution helper, so
  // mavp-publish-build.js's mode-binding pass sources ship/reset through the
  // exact same HEAD-anchored load + shape-validate path as this file's own
  // verify functions, rather than re-implementing it.
  resolveManifestBuckets,
  REPO_ROOT,
  DEFAULT_MANIFEST_PATH,
  MANIFEST_REL_PATH,
};
