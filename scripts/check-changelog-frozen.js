#!/usr/bin/env node
// check-changelog-frozen.js — pre-commit guard for the frozen-changelog-section
// rule (T-498, mechanized by T-499).
//
// docs/PUBLIC_RELEASE_STRATEGY.md §5 "Frozen-section rule": once `v<version>`
// is tagged on the PUBLIC MIRROR, that version's `## [x.y.z]` CHANGELOG.md
// section is immutable — no additions, no edits, no re-wording, even to fix
// a typo. New work opens a new section instead of reopening an already-tagged
// one.
//
// This script maps every staged CHANGELOG.md hunk to the `## [x.y.z]`
// section it lands in (in the STAGED/new version of the file) and exits
// non-zero, naming the version, when that version's tag already exists on
// the resolved mirror clone.
//
// Removal-vs-addition design decision (see inline comment on
// `hunk.newCount === 0` below): a hunk that is a PURE DELETION (adds no
// lines to the new file) can never reintroduce prose into an
// already-published section, so it is exempt. A hunk that adds or replaces
// lines landing inside a frozen section IS blocked — this also catches a
// "rewording"/typo-fix edit, since that shows up as removed-line +
// added-line, and the added line still lands in the frozen section.
// This distinction is deliberate: it lets a remediation commit that MOVES
// misfiled content OUT of an already-tagged section (pure deletion there)
// and INTO a new, not-yet-tagged section (pure addition there) land cleanly,
// while still catching the actual failure mode this guard exists for — new
// prose being added into an already-released section.
//
// Diff-attribution hardening: git's line diff has no concept of a "move" —
// when a block of text is relocated near where it used to be (e.g. a
// section heading + its bullet reappearing a few lines later), Myers' diff
// can attribute this as "replace old heading with new heading" (a
// newCount>0 hunk) plus "pure-add the original heading+bullet elsewhere" (a
// second newCount>0 hunk) even though not one byte of that reappearing text
// is actually new — it already existed verbatim in HEAD's CHANGELOG.md.
// Blocking on hunk shape alone would therefore false-positive on exactly
// the kind of same-repo relocation this guard must not fight (see the
// "What NOT to do" reasoning in T-499's brief). So an added line is only
// counted as a real addition — and checked against the frozen-section map —
// when its exact (trimmed) text does NOT already appear anywhere in HEAD's
// CHANGELOG.md. Blank lines never count. This keeps the guard blocking
// genuinely new prose (like today's incident) while not blocking a
// same-text relocation that the differ happened to attribute unfavorably.
//
// Resolution order for the mirror clone: MAVERICKS_HOME env var if set,
// otherwise ~/.mavericks — the same order the rule documents (§5) and the
// same order the rest of the framework resolves its source (see
// .claude/hooks/pre-commit, scripts/mavp-install.js).
//
// Tag lookup is INTENDED to always hit the resolved mirror clone, never the
// local/private repo. The private canonical repo is NOT guaranteed to be
// tag-free — it can and does carry version tags (e.g. v0.39.0, v0.39.1,
// stamped ahead of a mirror release during an in-progress wave), so relying
// on "the private repo has no tags" as a safety net is wrong (T-517
// corrected this — a prior version of this comment asserted the opposite).
// The real safety net is GIT_DIR hardening (see below): every mirror-
// directed git call in this file must actually resolve the mirror clone
// regardless of what tags the private repo happens to carry.
//
// GIT_DIR HARDENING (T-517): git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
// in the environment of processes it invokes (hooks, and any nested `git`
// call that inherits an already-set GIT_DIR from an outer invocation), and
// GIT_DIR TAKES PRECEDENCE OVER `-C`. So `git -C <mirror> tag -l` with
// GIT_DIR pointing at this (private) repo's `.git` lists THIS repo's tags,
// not the mirror's — proved directly: bare `git -C ~/.mavericks tag -l`
// ends at v0.38.2, while the same command with GIT_DIR set to the private
// repo's `.git` returns v0.39.0/v0.39.1 (the private repo's own tags,
// silently substituted for the mirror's). Every git invocation below that
// targets the mirror clone runs through mirrorGitEnv(), which DELETES
// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, and GIT_PREFIX from the
// child's environment rather than trying to overwrite them with "correct"
// values — an explicitly absent key is easier to reason about than a
// second source of truth that could itself go stale. (GIT_PREFIX doesn't
// actually change which repo gets resolved — it only affects pathspec
// interpretation relative to an invocation subdirectory — but none of the
// mirror-directed calls below pass pathspecs, so stripping it is
// belt-and-suspenders, not load-bearing.)
//
// Best-effort fetch (~4s timeout) before the tag check, following the same
// shape as detectBehindUpstreamGuard() in scripts/mavp-install.js
// (lines ~1026-1062): a fetch failure (offline, timeout, no network) is
// swallowed and the check falls through to whatever tags are already known
// locally in the mirror clone.
//
// Degrades silently to a no-op (exit 0, no stderr) when: no mirror clone
// resolves, the resolved path is not a git repo, there is no staged
// CHANGELOG.md diff, or git fails for any reason. This mirrors the
// established guard-degradation posture used by the behind-upstream and
// stale-source guards — a guard that hard-fails offline would get disabled
// by the first person who travels.
//
// Only STAGED hunks in CHANGELOG.md count. Unstaged edits and all other
// files are none of this guard's business.
//
// `--if-canonical` flag: gates the whole check on being run inside the
// canonical (private) repo, reusing check-publish-manifest.js's
// isCanonicalRepo() heuristic ("every `exclude` key is git-tracked") rather
// than inventing a new one — same mechanism the pre-commit hook already
// uses for the publish-manifest backstop. In a non-canonical repo (public
// mirror / adopter fork) or a repo with no manifest, prints a short skip
// message and exits 0. A CHANGELOG.md is not framework-managed outside the
// canonical repo, so the guard must be inert there.
//
// No external dependencies — Node's child_process/fs/path/os only.

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'publish-manifest.json');

// Loaded lazily/defensively — the two scripts ship together (both `ship`
// classified in publish-manifest.json), but a require() failure here must
// never crash this guard; it should just make repoIsCanonical() report
// false (same "degrade silently" posture as the rest of this file).
let isCanonicalRepo = null;
try {
  ({ isCanonicalRepo } = require('./check-publish-manifest.js'));
} catch {
  isCanonicalRepo = null;
}

// Returns true iff this repo is the canonical private repo, per the same
// heuristic check-publish-manifest.js --if-canonical uses. Returns false
// (never throws) when there's no manifest, the helper couldn't load, or
// git fails for any reason.
function repoIsCanonical() {
  if (!isCanonicalRepo) return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return false;
  }
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    return isCanonicalRepo(manifest, tracked);
  } catch {
    return false;
  }
}

function resolveMirrorHome() {
  const envHome = process.env.MAVERICKS_HOME;
  if (envHome && envHome.trim()) return envHome.trim();
  return path.join(os.homedir(), '.mavericks');
}

// Git env vars that determine which repository/work-tree/index/object-store
// a git invocation actually resolves against, in precedence order OVER
// `-C <dir>`. See the GIT_DIR HARDENING note in the file header. Deleted
// (never overwritten) from the child env for every git call below that
// targets the mirror clone — GIT_PREFIX is included for completeness even
// though none of these calls pass pathspecs (so it isn't load-bearing here).
const GIT_REPO_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

// Returns a copy of process.env with every GIT_REPO_ENV_KEYS entry deleted.
// Use for every git invocation that targets the mirror clone via `-C` — an
// ambient GIT_DIR (or friends) inherited from an outer hook/git invocation
// can otherwise silently redirect the child at a different repository (the
// private canonical repo, in this file's case) without the `-C` flag itself
// giving any indication that happened.
function mirrorGitEnv() {
  const env = Object.assign({}, process.env);
  for (const key of GIT_REPO_ENV_KEYS) delete env[key];
  return env;
}

function isGitRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'pipe',
      env: mirrorGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

// Returns a Set of tag names present in the mirror clone, or null on any
// failure (caller treats null as "degrade silently, exit 0").
function getMirrorTags(mirrorHome) {
  // Best-effort fetch — mandatory attempt, discarded result (same shape as
  // detectBehindUpstreamGuard in scripts/mavp-install.js).
  try {
    execFileSync('git', ['-C', mirrorHome, 'fetch', '--tags', '--quiet'], {
      stdio: 'pipe',
      timeout: 4000,
      env: mirrorGitEnv(),
    });
  } catch {
    // offline / timeout / no network — swallow and fall through to
    // whatever tags are already known locally.
  }

  try {
    const out = execFileSync('git', ['-C', mirrorHome, 'tag', '-l'], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: mirrorGitEnv(),
    });
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

// Parses `git diff --cached -U0 -- CHANGELOG.md` output into a list of
// { oldStart, oldCount, newStart, newCount } hunks.
function parseHunks(diffOutput) {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/;
  const hunks = [];
  for (const line of diffOutput.split('\n')) {
    const m = line.match(hunkRe);
    if (!m) continue;
    hunks.push({
      oldStart: parseInt(m[1], 10),
      oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
      newStart: parseInt(m[3], 10),
      newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    });
  }
  return hunks;
}

// Builds a list of { start, end, version } line ranges (1-indexed,
// inclusive) from CHANGELOG.md content, one entry per `## [x.y.z]` heading.
// A line before the first heading maps to no entry (findVersionForLine
// returns null for it).
function buildSectionMap(content) {
  const lines = content.split('\n');
  const headingRe = /^##\s*\[([^\]]+)\]/;
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) headings.push({ line: i + 1, version: m[1].trim() });
  }
  return headings.map((h, idx) => ({
    start: h.line,
    end: idx + 1 < headings.length ? headings[idx + 1].line - 1 : Infinity,
    version: h.version,
  }));
}

function findVersionForLine(sectionMap, line) {
  for (const range of sectionMap) {
    if (line >= range.start && line <= range.end) return range.version;
  }
  return null;
}

function main() {
  try {
    const ifCanonical = process.argv.slice(2).includes('--if-canonical');
    if (ifCanonical && !repoIsCanonical()) {
      console.log(
        'SKIP: non-canonical repo (an exclude key is not git-tracked) — --if-canonical only enforces in the canonical private repo.'
      );
      process.exit(0);
    }

    const mirrorHome = resolveMirrorHome();
    if (!fs.existsSync(mirrorHome) || !isGitRepo(mirrorHome)) {
      process.exit(0); // no mirror clone resolvable — degrade silently
    }

    const tags = getMirrorTags(mirrorHome);
    if (!tags) process.exit(0); // git failed for any reason — degrade silently

    let diffOutput;
    try {
      diffOutput = execFileSync(
        'git',
        ['diff', '--cached', '-U0', '--', 'CHANGELOG.md'],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
    } catch {
      process.exit(0);
    }
    if (!diffOutput || !diffOutput.trim()) process.exit(0); // nothing staged

    const hunks = parseHunks(diffOutput);
    if (hunks.length === 0) process.exit(0);

    let stagedContent;
    try {
      stagedContent = execFileSync('git', ['show', ':CHANGELOG.md'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch {
      process.exit(0);
    }

    const sectionMap = buildSectionMap(stagedContent);
    const stagedLines = stagedContent.split('\n');

    // HEAD's line text (trimmed, non-blank) — used by the diff-attribution
    // hardening above: a staged "added" line whose exact text already
    // existed in HEAD is not new content, regardless of which hunk shape
    // git's differ happened to produce for it. Degrades to an empty set
    // (nothing exempted this way) when there's no HEAD to read (e.g. the
    // very first commit in a repo — that can never be an already-tagged
    // version on a mirror anyway).
    let oldLineSet = new Set();
    try {
      const oldContent = execFileSync('git', ['show', 'HEAD:CHANGELOG.md'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      oldLineSet = new Set(
        oldContent.split('\n').map((l) => l.trim()).filter(Boolean)
      );
    } catch {
      // no HEAD / no such path at HEAD — oldLineSet stays empty.
    }

    // version -> true, collected across all hunks so one error message can
    // name every frozen section touched by this commit.
    const blockedVersions = new Set();

    for (const hunk of hunks) {
      // Pure deletion (no lines added to the new file) — see the
      // removal-vs-addition design note at the top of this file. Never
      // blocks: it cannot reintroduce prose into an already-published
      // section.
      if (hunk.newCount === 0) continue;

      const rangeStart = hunk.newStart;
      const rangeEnd = hunk.newStart + hunk.newCount - 1;

      // Check every line in the added/replaced range — a hunk that spans a
      // section boundary (part in a frozen section, part in a newer one)
      // is blocked if ANY line in it falls inside an already-tagged
      // section. This is a deliberate fail-closed choice: partial overlap
      // with frozen content is still an edit to frozen content.
      for (let line = rangeStart; line <= rangeEnd; line++) {
        const lineText = (stagedLines[line - 1] || '').trim();
        if (!lineText) continue; // blank lines never count as prose
        if (oldLineSet.has(lineText)) continue; // not new — see hardening note above

        const version = findVersionForLine(sectionMap, line);
        if (!version) continue;
        if (version.toLowerCase() === 'unreleased') continue;

        const tagName = version.startsWith('v') ? version : `v${version}`;
        if (tags.has(tagName)) blockedVersions.add(version);
      }
    }

    if (blockedVersions.size > 0) {
      const versionList = [...blockedVersions].sort().join(', ');
      console.error(
        `COMMIT BLOCKED: staged CHANGELOG.md edit(s) touch already-released section(s): ${versionList}`
      );
      console.error(
        `These version(s) are tagged on the mirror (${mirrorHome}) — per docs/PUBLIC_RELEASE_STRATEGY.md ` +
          `§5 "Frozen-section rule", an already-tagged section is immutable. Open a new version section instead.`
      );
      process.exit(1);
    }

    process.exit(0);
  } catch {
    // Any unexpected failure — degrade silently (established guard posture).
    process.exit(0);
  }
}

module.exports = {
  parseHunks,
  buildSectionMap,
  findVersionForLine,
  resolveMirrorHome,
  mirrorGitEnv,
  GIT_REPO_ENV_KEYS,
  getMirrorTags,
  isGitRepo,
};

if (require.main === module) {
  main();
}
