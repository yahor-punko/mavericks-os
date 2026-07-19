#!/usr/bin/env node

/**
 * mavp-transcript-archive.js
 *
 * Sweeps this project's Claude Code session transcripts out of Claude's local
 * storage — `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, deleted by
 * Claude Code after ~cleanupPeriodDays (30 days by default) — into
 * `<project>/.mavp/transcripts/<session-id>.jsonl`, so a DR `Session:`
 * provenance id (see docs/core/DECISIONS.md) stays resolvable past that
 * cleanup window in projects that opted in to this archive at bootstrap.
 * See `mavp-install.js --transcript-archive` and
 * docs/core/BOOTSTRAP_GUIDE.md — "Transcript archive".
 *
 * <cwd-slug> is the project's absolute cwd with every "/" replaced by "-"
 * (Claude Code's own directory-naming rule for ~/.claude/projects/).
 *
 * Opt-in only, never git-tracked: the installer adds `.mavp/transcripts/` to
 * the target project's .gitignore whenever this hook is activated.
 * Transcripts are privacy-sensitive full session content — they must stay
 * local-disk-only.
 *
 * v1 is a SWEEP, not a single-copy: every session transcript for this project
 * present in Claude's storage dir is copied into the archive when the
 * archived copy is absent, or when the source transcript is newer (by mtime)
 * than what's already archived. A transcript that exists only in the archive
 * (source already deleted by Claude Code's cleanup) is never touched by the
 * copy phase of this sweep.
 *
 * v2 (T-423) adds an opt-in, bounded retention prune of the ARCHIVE only —
 * never the live source transcripts under Claude's storage dir. Retention is
 * configured via MAVP_TRANSCRIPT_RETENTION_DAYS (max age in days, matching
 * this script's existing env-var config style). Default is UNLIMITED —
 * nothing is ever deleted unless an operator explicitly sets this env var to
 * a positive number — preserving v1 behavior exactly out of the box. When
 * set, every sweep run also deletes any archived *.jsonl file whose mtime is
 * older than the configured number of days.
 *
 * Doctrine (same as the validator PostToolUse hook): this script must NEVER
 * break a session. It always exits 0. Any problem is reported to stderr only.
 *
 * Env overrides (primarily for tests / non-standard layouts):
 *   MAVP_TRANSCRIPT_SOURCE_DIR      — overrides the derived Claude storage
 *                                     directory entirely (skips the slug
 *                                     derivation from cwd).
 *   MAVP_TRANSCRIPT_DEST_DIR        — overrides the archive destination
 *                                     directory (default:
 *                                     <project>/.mavp/transcripts).
 *   MAVP_TRANSCRIPT_RETENTION_DAYS  — max age (in days) an archived
 *                                     transcript may reach before being
 *                                     pruned. Unset, empty, non-numeric, or
 *                                     <= 0 means UNLIMITED (no pruning — v1
 *                                     behavior). Only ever deletes files
 *                                     under the archive dest dir, never the
 *                                     source.
 *
 * Usage: node mavp-transcript-archive.js
 *   Run from the project root — the installer's managed SessionStart hook
 *   `cd`s there first, matching the existing SessionStart/PostCompact
 *   lifecycle hook pattern in mavp-install.js.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Tolerance (in ms) absorbing filesystem mtime-precision loss on the copy
 * round-trip: copy() -> utimesSync(dest, src.mtime) can truncate dest's mtime
 * on coarser-granularity filesystems (e.g. whole-second precision on some CI
 * runners), leaving dest.mtime slightly BELOW the original src.mtimeMs even
 * though nothing actually changed. Without this tolerance, the very next
 * sweep would see `src.mtimeMs > dest.mtimeMs` and re-copy an unchanged file
 * forever, breaking idempotency (T-429). 1000ms comfortably covers up to
 * whole-second granularity loss while still detecting genuine changes (which
 * in practice advance mtime by far more than a second).
 */
const TOLERANCE_MS = 1000;

/**
 * Claude Code's project-directory slug rule: the absolute cwd with every
 * "/" replaced by "-" (e.g. "/abs/path/project" -> "-abs-path-project").
 */
function deriveProjectSlug(absoluteCwd) {
  return absoluteCwd.split('/').join('-');
}

/**
 * Resolve the source directory Claude Code stores this project's transcripts
 * in. MAVP_TRANSCRIPT_SOURCE_DIR overrides it entirely (tests point this at a
 * fixture dir instead of touching ~/.claude/projects/).
 */
function resolveSourceDir(projectDir) {
  if (process.env.MAVP_TRANSCRIPT_SOURCE_DIR) return process.env.MAVP_TRANSCRIPT_SOURCE_DIR;
  const slug = deriveProjectSlug(projectDir);
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

/**
 * Resolve the archive destination directory. MAVP_TRANSCRIPT_DEST_DIR
 * overrides it entirely (tests point this at a scratch dir).
 */
function resolveDestDir(projectDir) {
  if (process.env.MAVP_TRANSCRIPT_DEST_DIR) return process.env.MAVP_TRANSCRIPT_DEST_DIR;
  return path.join(projectDir, '.mavp', 'transcripts');
}

/**
 * Parse the MAVP_TRANSCRIPT_RETENTION_DAYS env value into a positive finite
 * number of days, or null meaning "unlimited — never prune" (the default,
 * v1-preserving behavior). Unset, empty, non-numeric, or <= 0 all resolve to
 * null so an operator can never accidentally enable pruning via a malformed
 * value.
 */
function parseRetentionDays(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Resolve the configured retention window (in days) from
 * MAVP_TRANSCRIPT_RETENTION_DAYS. Returns null for "unlimited" (default).
 */
function resolveRetentionDays() {
  return parseRetentionDays(process.env.MAVP_TRANSCRIPT_RETENTION_DAYS);
}

/**
 * Prune the ARCHIVE (destDir) only — never the live source transcripts — of
 * any *.jsonl file whose mtime is older than retentionDays. When
 * retentionDays is null (unlimited/default), this is a no-op: nothing is
 * ever deleted, matching v1 behavior exactly.
 *
 * Returns { deleted: string[], errors: string[] }. Never throws for expected
 * conditions (missing dest dir, per-file stat/delete failures) — those are
 * collected into `errors` instead.
 */
function pruneArchive(destDir, retentionDays) {
  const result = { deleted: [], errors: [] };
  if (retentionDays === null || retentionDays === undefined) return result;

  let entries;
  try {
    entries = fs.readdirSync(destDir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      result.errors.push(`could not read archive dir ${destDir} for pruning: ${e.message}`);
    }
    return result;
  }

  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => e.name);

  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const name of jsonlFiles) {
    const filePath = path.join(destDir, name);
    try {
      const stat = fs.statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        result.deleted.push(name);
      }
    } catch (e) {
      result.errors.push(`could not prune ${name}: ${e.message}`);
    }
  }

  return result;
}

/**
 * Sweep every *.jsonl transcript from sourceDir into destDir. A file is
 * copied when the destination copy is absent, or when the source is newer
 * (by mtime) than the existing archived copy — otherwise it is skipped.
 * The archived copy's mtime is set to match the source's mtime after copy,
 * so a later run can tell "already archived, unchanged" apart from "source
 * updated since the last sweep" without hashing file contents.
 *
 * Never deletes anything itself — a transcript that exists only in destDir
 * (its source already cleaned up by Claude Code) is left untouched by this
 * function. Retention-based pruning of destDir is a separate, opt-in step —
 * see pruneArchive() (T-423).
 *
 * Returns { copied: string[], skipped: string[], errors: string[] }. Never
 * throws for expected conditions (missing source dir, per-file copy
 * failures) — those are collected into `errors` instead.
 */
function sweep(sourceDir, destDir) {
  const result = { copied: [], skipped: [], errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (e) {
    // Missing source dir is the normal case (no sessions yet, or Claude
    // Code's cleanup already ran) — not an error worth surfacing.
    if (e.code !== 'ENOENT') {
      result.errors.push(`could not read source dir ${sourceDir}: ${e.message}`);
    }
    return result;
  }

  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
    .map(e => e.name);
  if (jsonlFiles.length === 0) return result;

  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    result.errors.push(`could not create archive dir ${destDir}: ${e.message}`);
    return result;
  }

  for (const name of jsonlFiles) {
    const srcPath = path.join(sourceDir, name);
    const destPath = path.join(destDir, name);
    try {
      const srcStat = fs.statSync(srcPath);
      let shouldCopy = true;
      if (fs.existsSync(destPath)) {
        const destStat = fs.statSync(destPath);
        // A strict `srcStat.mtimeMs > destStat.mtimeMs` comparison is not
        // idempotent: after copying, dest mtime is set to src mtime via
        // utimesSync, but utimesSync stores the value at the DESTINATION
        // filesystem's mtime granularity (some filesystems/CI runners only
        // keep whole-second or coarser precision). That round-trip can
        // truncate dest.mtime slightly below the original srcStat.mtimeMs,
        // making the very next sweep see src > dest again and re-copy an
        // unchanged file. TOLERANCE_MS absorbs up to ~1s of that precision
        // loss: only treat the source as "genuinely newer" when it exceeds
        // the archived copy's mtime by more than the tolerance.
        shouldCopy = srcStat.mtimeMs - destStat.mtimeMs > TOLERANCE_MS;
      }
      if (!shouldCopy) {
        result.skipped.push(name);
        continue;
      }
      fs.copyFileSync(srcPath, destPath);
      // Pass fractional-second numbers (not Date objects — those truncate to
      // whole milliseconds and would leave a sub-ms drift that makes the very
      // next sweep re-copy this file, breaking idempotency).
      fs.utimesSync(destPath, srcStat.atimeMs / 1000, srcStat.mtimeMs / 1000);
      result.copied.push(name);
    } catch (e) {
      result.errors.push(`could not archive ${name}: ${e.message}`);
    }
  }

  return result;
}

function main() {
  const projectDir = process.cwd();
  const sourceDir = resolveSourceDir(projectDir);
  const destDir = resolveDestDir(projectDir);
  const retentionDays = resolveRetentionDays();

  let result;
  try {
    result = sweep(sourceDir, destDir);
  } catch (e) {
    process.stderr.write(`mavp-transcript-archive: unexpected error: ${e.message}\n`);
    process.exitCode = 0;
    return;
  }

  for (const name of result.copied) {
    process.stdout.write(`mavp-transcript-archive: archived ${name}\n`);
  }
  for (const msg of result.errors) {
    process.stderr.write(`mavp-transcript-archive: ${msg}\n`);
  }

  let pruneResult;
  try {
    pruneResult = pruneArchive(destDir, retentionDays);
  } catch (e) {
    process.stderr.write(`mavp-transcript-archive: unexpected pruning error: ${e.message}\n`);
    process.exitCode = 0;
    return;
  }

  for (const name of pruneResult.deleted) {
    process.stdout.write(`mavp-transcript-archive: pruned ${name} (older than ${retentionDays}d retention)\n`);
  }
  for (const msg of pruneResult.errors) {
    process.stderr.write(`mavp-transcript-archive: ${msg}\n`);
  }

  process.exitCode = 0;
}

if (require.main === module) {
  main();
}

module.exports = {
  deriveProjectSlug,
  resolveSourceDir,
  resolveDestDir,
  parseRetentionDays,
  resolveRetentionDays,
  sweep,
  pruneArchive,
};
