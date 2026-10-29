#!/usr/bin/env node

/**
 * mavp-doc-archive-check.js
 *
 * T-783: read-only "nothing lost" check for the archive-not-delete convention
 * in .claude/rules/docs.md ("Layers and archive-not-delete", T-784). For each
 * commit judged, every non-empty trimmed line REMOVED from a layer-0/1 doc
 * must reappear, trimmed and verbatim, after the commit either in a perimeter
 * doc or in a file under docs/archive/ that the same commit added or modified,
 * unless an added perimeter line AMENDS it in place (T-793, see Decisions).
 *
 * Usage:
 *   ./scripts/mavp-operator --check-archive --range A..B   # first-parent commits of A..B, one at a time
 *   ./scripts/mavp-operator --check-archive --staged       # the index against HEAD
 *   [--root <dir>]  project root (default: $MAVERICKS_PROJECT_ROOT, else cwd)
 *
 * Exit codes: 0 = no removed perimeter line is missing (amended-in-place is not missing); 1 = at least one is
 * missing (each named by commit, file and line text); 2 = usage error, git
 * error, or a history this check cannot judge honestly (a shallow clone).
 *
 * Read-only: writes no files and changes no git state (.claude/rules/scripts.md).
 *
 * The perimeter of a revision (taken at the PARENT for "removed from", and
 * at both parent and child for "found in working") is:
 *   - collectAlwaysLoadedContext() (T-782) run against the revision's git
 *     tree: CLAUDE.md, its @ imports, every .claude/rules/ file — both the
 *     always-loaded ones (layer 0) and the path-scoped ones (layer 1);
 *   - every module context_docs path parsed from docs/MODULES.md at that
 *     revision via parseModuleRegistryFromText() (T-791) — layer 1.
 * Installer-managed files (T-799): when a revision's own tree is NOT a
 * framework source tree (it has no scripts/mavp-operator-lib.js, which
 * adopters never receive), every perimeter file for which
 * isInstallerManagedPath() holds is dropped from that revision's perimeter
 * (in practice the framework-owned .claude/rules/*.md that `mavp-install.js
 * --update` rewrites), and run() prints one summary line naming the files it
 * skipped, only when there are any. In a framework source tree nothing is
 * skipped. Accepted false-negative boundary: an adopter hand-edit that
 * removes a line from a framework-managed rule is unjudged, because --update
 * overwrites that file anyway and the archive duty for framework text belongs
 * to the framework's own history; the adopter's own rule home is
 * .claude/rules/project-*.md (T-788), which stays in the perimeter.
 * A file that leaves the perimeter in the same commit (its @ import removed,
 * or the file deleted or moved) is still judged, because "removed from" uses
 * the parent's perimeter.
 *
 * Decisions (T-783):
 *   - Bucket precedence: a removed line found in a working perimeter doc
 *     counts as found-in-working, even when it is also in an archive file.
 *     found-in-archive therefore counts only lines that actually left layers
 *     0-1 and were archived. A removed line in neither is judged for an
 *     amended descendant (next bullet); only a line with none is missing.
 *     Every removed line lands in exactly one of found-in-working /
 *     found-in-archive / amended-in-place / missing, so the four counts sum to
 *     the removed-line total.
 *   - Blockquoted archive copy (T-851): the archive-side line set also holds,
 *     for each archive line, every form obtained by removing one leading
 *     blockquote marker plus at most one following space, repeatedly, so a
 *     displaced line archived as a quote (nested quotes included) still
 *     matches its verbatim source. One-directional: the removed-side text is
 *     never normalised, so an archive copy may carry more quote markers than
 *     the source line, never fewer, and a source line that is itself a quote
 *     archived with its marker dropped is reported missing. Only the archive
 *     side changes; the multiset counts, amended-in-place and keyed judgments
 *     are untouched.
 *   - Amended in place (T-793): a removed line that is neither verbatim in a
 *     working doc nor in a same-commit archive file is AMENDED-IN-PLACE when
 *     some line ADDED by the same step to a perimeter file (parent perimeter
 *     union child perimeter, the same union as workingFiles) retains at least
 *     AMENDED_RETENTION_THRESHOLD (80%) of its tokens in order, or loses at
 *     most one token. Retention is the longest common subsequence of the two
 *     token lists over the removed line's token count; a token is a
 *     whitespace-separated word with leading and trailing punctuation and
 *     symbol characters stripped, and tokens are compared exactly (case and
 *     inner characters count). A line with no tokens (a bare `---`) never
 *     qualifies, and the one-token floor needs at least one token retained.
 *     Lines added under docs/archive/ are never descendant candidates, so an
 *     archive copy stays strictly verbatim: a 90%-similar line present only in
 *     an archive file is missing. Accepted boundary: a rewrite that drops more
 *     than 20% of a line's words (a clause cut, a long line replaced by a
 *     short summary) is a replacement, not an amendment, and is reported
 *     missing; git is the record of what it said.
 *   - Keyed amendment (T-816): a removed line that is neither found, archived
 *     nor 80%-retained is still AMENDED-IN-PLACE when it is KEYED and its key
 *     is rewritten in the same document. keyOf(line) is the bold text of a
 *     list item whose content begins with a bold span after a `-`, `*`, `+`
 *     or `N.`/`N)` marker, or the trimmed first cell of a table row; a table
 *     separator row (`|---|`), a heading and any other line never key. The
 *     rule applies when the key occurs exactly ONCE among the keyed lines of
 *     the same file at the parent AND exactly once among the keyed lines of
 *     that file at the child, and the child's keyed line is in the step's
 *     ADDED set for that file. Same document only (a path rename is not
 *     keyed), so pairing is one-to-one by construction; a repeated key such
 *     as several `**Note:**` bullets never qualifies. Keyed amendments are
 *     counted INSIDE amended-in-place (the four buckets still sum to the
 *     removed total), reported as `AMENDED ... (key match: <key>)`, and
 *     tallied on the extra `keyed-amendments: K` summary line. Accepted
 *     boundary: a keyed body cut down to its bare lead passes (git is its
 *     record); the human archive duty for a displaced convention-bullet body
 *     is unchanged.
 *   - Duplicate lines (T-806): found-in-working is count-based (multiset), not
 *     set membership. For a removed text X let P(X) be its occurrences across
 *     the parent perimeter files read at the parent and C(X) its occurrences
 *     across the working perimeter union read at the child. The first
 *     max(0, P(X) - C(X)) removed occurrences of X in the step (in file, then
 *     diff order) are NOT credited as found-in-working: they fall through to
 *     the archive / amended-in-place / missing judgment, and only the
 *     remainder count as found-in-working. A line moved within or between
 *     files (count unchanged) is therefore still found; removing one of
 *     several identical lines with nothing archived is missing, even though
 *     an identical line remains elsewhere. Matching is still by trimmed text,
 *     never by position. Named boundary: a line whose tokenize() result is
 *     empty (pure punctuation such as `---`) keeps the old set semantics and
 *     is found whenever the text still occurs anywhere in the working set,
 *     because structural separators are not content. Every other non-empty
 *     trimmed line (a repeated bullet, an @ import line) is counted.
 *   - Range edge cases: --range walks `git rev-list --first-parent A..B`
 *     oldest first. A merge commit is judged by its diff against its FIRST
 *     parent; the files the merge "added or modified" are likewise those that
 *     differ from the first parent, so the two sides of the judgement agree.
 *     A root commit (no parent) can remove nothing, so it is scanned with an
 *     empty parent perimeter and reported as such; --staged on an unborn HEAD
 *     is treated the same way. A shallow clone is refused (exit 2) in
 *     --range mode, because a grafted parent would make the walk's diffs
 *     against history that is not there. --staged only needs HEAD and the
 *     index, which a shallow clone always has, so it is not refused there.
 */

'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const {
  collectAlwaysLoadedContext,
  isFrameworkSourceTree,
  isInstallerManagedPath,
  parseModuleRegistryFromText,
  readFileAtRevision,
} = require('./mavp-operator-lib.js');

const INDEX = ':index'; // sentinel revision meaning "the staged index"
const ARCHIVE_PREFIX = 'docs/archive/';
// T-793: a removed line is amended in place when an added perimeter line keeps
// at least this fraction of its tokens in order (LCS). The single place the
// threshold lives; the one-token floor is its small-line companion.
const AMENDED_RETENTION_THRESHOLD = 0.8;
const AMENDED_MAX_LOST_TOKENS = 1;

class UsageError extends Error {}
class GitError extends Error {}

function usage() {
  return [
    'Usage: --check-archive (--range A..B | --staged) [--root <dir>]',
    '  --range A..B  judge each first-parent commit of A..B, oldest first',
    '  --staged      judge the staged index against HEAD (for a pre-commit hook)',
    '  --root <dir>  project root (default: $MAVERICKS_PROJECT_ROOT, else cwd)',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { range: null, staged: false, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--range') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--range requires a value of the form A..B');
      out.range = v;
      i += 1;
    } else if (a.startsWith('--range=')) {
      out.range = a.slice('--range='.length);
    } else if (a === '--staged') {
      out.staged = true;
    } else if (a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError('--root requires a directory');
      out.root = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      throw new UsageError(`unrecognized argument: ${a}`);
    }
  }
  if (out.help) return out;
  if (out.range !== null && out.staged) throw new UsageError('--range and --staged are mutually exclusive');
  if (out.range === null && !out.staged) throw new UsageError('one of --range A..B or --staged is required');
  if (out.range !== null) {
    // Git forbids '..' inside a ref name, so the first '..' is the separator.
    const idx = out.range.indexOf('..');
    const from = idx === -1 ? '' : out.range.slice(0, idx);
    const to = idx === -1 ? '' : out.range.slice(idx + 2);
    if (!from || !to || out.range.includes('...')) throw new UsageError(`--range must be A..B (two dots, both ends named), got: ${out.range}`);
    if (from.startsWith('-') || to.startsWith('-')) throw new UsageError(`--range revisions must not start with '-': ${out.range}`);
    out.from = from;
    out.to = to;
  }
  return out;
}

function git(root, args, { allowFail = false } = {}) {
  try {
    return cp.execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFail) return null;
    const stderr = err && err.stderr ? String(err.stderr).trim() : String(err && err.message);
    throw new GitError(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

function splitLines(text) {
  return String(text).split('\n').filter((l) => l.length > 0);
}

/** Every blob path at a revision (or in the index), as a Set. */
function treePaths(root, rev) {
  const out = rev === INDEX
    ? git(root, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached'])
    : git(root, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-z', '--name-only', rev]);
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Per-revision reader: file text by repo-relative path, backed by `git show`
 * (readFileAtRevision). Only paths that are blobs at the revision are read,
 * so a path naming a directory never returns a tree listing.
 */
function makeRevisionReader(root, rev) {
  const paths = treePaths(root, rev);
  const cache = new Map();
  const gitRev = rev === INDEX ? '' : rev; // `git show :path` reads stage 0 of the index
  return {
    paths,
    read(rel) {
      if (!paths.has(rel)) return null;
      if (cache.has(rel)) return cache.get(rel);
      const text = readFileAtRevision(root, gitRev, rel);
      cache.set(rel, text);
      return text;
    },
  };
}

function normalizeRel(p) {
  return String(p).trim().replace(/^\.\//, '').split(path.sep).join('/');
}

/**
 * Perimeter (layers 0-1) of one revision plus the installer-managed files left
 * out of it (T-799): { paths, skipped }, both sorted arrays of repo-relative
 * paths. `skipped` is non-empty only when the revision's own tree is not a
 * framework source tree (no scripts/mavp-operator-lib.js at that revision).
 */
function computePerimeterDetail(root, reader) {
  const absRoot = path.resolve(root);
  const toRel = (abs) => path.relative(absRoot, abs).split(path.sep).join('/');
  const ctx = collectAlwaysLoadedContext(absRoot, {
    readFile: (abs) => {
      const rel = toRel(abs);
      if (rel.startsWith('..')) return null;
      return reader.read(rel);
    },
    listMarkdown: (absDir) => {
      const prefix = `${toRel(absDir)}/`;
      return [...reader.paths]
        .filter((p) => p.startsWith(prefix) && /\.md$/i.test(p))
        .sort()
        .map((p) => path.join(absRoot, ...p.split('/')));
    },
  });
  const set = new Set();
  for (const f of ctx.files) if (!f.missing) set.add(f.path);
  for (const f of ctx.path_scoped_rules) set.add(f.path);
  const modulesText = reader.read('docs/MODULES.md');
  if (typeof modulesText === 'string') {
    const registry = parseModuleRegistryFromText(modulesText);
    for (const entry of Object.values(registry)) {
      for (const doc of entry.context_docs || []) {
        const rel = normalizeRel(doc);
        if (rel && reader.paths.has(rel)) set.add(rel);
      }
    }
  }
  const skipped = [];
  if (!isFrameworkSourceTree(root, { exists: (rel) => reader.paths.has(rel) })) {
    for (const rel of [...set]) {
      if (isInstallerManagedPath(rel)) {
        set.delete(rel);
        skipped.push(rel);
      }
    }
  }
  return { paths: [...set].sort(), skipped: skipped.sort() };
}

/** Perimeter (layers 0-1) of one revision: a sorted array of repo-relative paths. */
function computePerimeter(root, reader) {
  return computePerimeterDetail(root, reader).paths;
}

/** Lines removed and added in one file between two revisions (raw, untrimmed). */
function diffLines(root, parentRev, childRev, rel) {
  const base = ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff',
    '--no-textconv', '--no-renames', '--text'];
  const args = childRev === INDEX
    ? [...base, '--cached', parentRev, '--', `:(literal)${rel}`]
    : [...base, parentRev, childRev, '--', `:(literal)${rel}`];
  const out = git(root, args);
  const removed = [];
  const added = [];
  let inHunk = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (line.startsWith('diff --git')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

/** Whitespace-split words, leading/trailing punctuation and symbols stripped, empties dropped. */
function tokenize(text) {
  return String(text).trim().split(/\s+/)
    .map((t) => t.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    .filter(Boolean);
}

/** Length of the longest common subsequence of two token arrays. */
function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Judge a removed line against candidate token lists (the lines the step
 * added). Returns { amended, retention }: retention is the best LCS / token
 * count ratio found (0 when the line has no tokens).
 */
function judgeAmended(removedText, candidates) {
  const rt = tokenize(removedText);
  if (rt.length === 0) return { amended: false, retention: 0 };
  let bestLcs = 0;
  for (const ct of candidates) {
    if (ct.length <= bestLcs) continue; // cannot beat the best so far
    const l = lcsLength(rt, ct);
    if (l > bestLcs) bestLcs = l;
    if (bestLcs === rt.length) break;
  }
  const retention = bestLcs / rt.length;
  const amended = bestLcs > 0
    && (retention >= AMENDED_RETENTION_THRESHOLD || rt.length - bestLcs <= AMENDED_MAX_LOST_TOKENS);
  return { amended, retention };
}

/** Files under docs/archive/ that the child revision added or modified relative to the parent. */
function touchedArchiveFiles(root, parentRev, childRev) {
  // The convention names archives docs/archive/<DOC_NAME>/<YYYY-MM-DD>-<slug>.md,
  // but this check deliberately accepts ANY added or modified file under
  // docs/archive/: its job is "nothing lost", not naming enforcement.
  const base = ['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '--no-renames'];
  const args = childRev === INDEX
    ? [...base, '--cached', parentRev, '--', `:(literal)${ARCHIVE_PREFIX}`]
    : [...base, parentRev, childRev, '--', `:(literal)${ARCHIVE_PREFIX}`];
  const parts = git(root, args).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const file = parts[i + 1];
    if ((status === 'A' || status === 'M') && file.startsWith(ARCHIVE_PREFIX)) files.push(file);
  }
  return files;
}

function lineSet(reader, files) {
  const set = new Set();
  for (const rel of files) {
    const text = reader.read(rel);
    if (typeof text !== 'string') continue;
    for (const l of text.split(/\r?\n/)) {
      let t = l.trim();
      if (t) set.add(t);
      // T-851: also admit every form with one more leading blockquote marker
      // (and at most one following space) removed, so a verbatim copy archived
      // as a quote still matches. Archive side only; never applied to removed text.
      while (t.startsWith('>')) {
        t = t.slice(t.startsWith('> ') ? 2 : 1);
        if (t) set.add(t);
      }
    }
  }
  return set;
}

/** Occurrences of each non-empty trimmed line across the given files (T-806: multiset). */
function lineCounts(reader, files) {
  const counts = new Map();
  for (const rel of files) {
    const text = reader.read(rel);
    if (typeof text !== 'string') continue;
    for (const l of text.split(/\r?\n/)) {
      const t = l.trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return counts;
}

/**
 * T-816: the key of a line, or null. A list item whose content begins with a
 * bold span keys on that span's text; a table row keys on its trimmed first
 * cell (a separator row never keys). Headings and every other line: null.
 */
function keyOf(line) {
  const t = String(line).trim();
  const item = t.match(/^(?:[-*+]|\d+[.)])\s+\*\*(.+?)\*\*/);
  if (item) {
    const k = item[1].trim();
    return k || null;
  }
  if (t.startsWith('|')) {
    const cells = t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) return null;
    return cells[0] || null;
  }
  return null;
}

/** Keyed lines of one file at a revision: Map key -> array of trimmed lines (T-816). */
function keyedLines(reader, rel) {
  const map = new Map();
  const text = reader.paths.has(rel) ? reader.read(rel) : null;
  if (typeof text !== 'string') return map;
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    const k = keyOf(t);
    if (k === null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

/**
 * Judge one parent->child step. parentRev is null for a root commit / unborn HEAD.
 * Returns { label, perimeter, removed, working, archive, amended: [{file, text, retention}], missing: [{file, text}] }.
 */
function judgeStep(root, { parentRev, childRev, label, readers }) {
  const result = { label, perimeter: [], skipped: [], removed: 0, working: 0, archive: 0, amended: [], missing: [], root: parentRev === null };
  if (parentRev === null) return result;
  const parentReader = readers.get(parentRev);
  const childReader = readers.get(childRev);
  const parentPerimeter = readers.perimeter(parentRev);
  const childPerimeter = readers.perimeter(childRev);
  result.perimeter = parentPerimeter;
  // T-799: installer-managed files dropped from the parent's perimeter (adopter trees only).
  result.skipped = typeof readers.skipped === 'function' ? readers.skipped(parentRev) : [];

  // Target sets, both read AFTER the step (at the child).
  const workingFiles = [...new Set([...parentPerimeter, ...childPerimeter])];
  const workingCounts = lineCounts(childReader, workingFiles);
  // T-806: occurrences at the parent, to compute per-text deficits P(X) - C(X).
  const parentCounts = lineCounts(parentReader, parentPerimeter.filter((rel) => parentReader.paths.has(rel)));
  const deficit = new Map(); // text -> removed occurrences still owed to the archive/amended/missing judgment
  const deficitOf = (text) => {
    if (!deficit.has(text)) {
      deficit.set(text, Math.max(0, (parentCounts.get(text) || 0) - (workingCounts.get(text) || 0)));
    }
    return deficit.get(text);
  };
  const archiveLines = lineSet(childReader, touchedArchiveFiles(root, parentRev, childRev));

  // Descendant candidates: lines the step ADDED to any working perimeter file
  // (never docs/archive/), tokenised once and only when a line needs them.
  let candidates = null;
  const addedCandidates = () => {
    if (candidates === null) {
      candidates = [];
      for (const rel of workingFiles) {
        if (rel.startsWith(ARCHIVE_PREFIX)) continue;
        for (const raw of diffLines(root, parentRev, childRev, rel).added) {
          const t = tokenize(raw);
          if (t.length) candidates.push(t);
        }
      }
    }
    return candidates;
  };

  // T-816: trimmed lines the step added to one file (cached per file).
  const addedByFile = new Map();
  const addedTrimmed = (rel) => {
    if (!addedByFile.has(rel)) {
      addedByFile.set(rel, new Set(diffLines(root, parentRev, childRev, rel).added.map((l) => l.trim()).filter(Boolean)));
    }
    return addedByFile.get(rel);
  };

  for (const rel of parentPerimeter) {
    if (!parentReader.paths.has(rel)) continue;
    for (const raw of diffLines(root, parentRev, childRev, rel).removed) {
      const text = raw.trim();
      if (!text) continue;
      result.removed += 1;
      // Bucket precedence: working, then archive, then amended (see header).
      // T-806: count-based found-in-working; punctuation-only lines keep set semantics.
      if (workingCounts.has(text)) {
        if (tokenize(text).length === 0) { result.working += 1; continue; }
        const owed = deficitOf(text);
        if (owed > 0) deficit.set(text, owed - 1);
        else { result.working += 1; continue; }
      }
      if (archiveLines.has(text)) { result.archive += 1; continue; }
      const j = judgeAmended(text, addedCandidates());
      if (j.amended) { result.amended.push({ file: rel, text, retention: j.retention }); continue; }
      // T-816: keyed same-document rewrite (unique key at parent and child, child line added).
      const key = keyOf(text);
      if (key !== null) {
        const atParent = keyedLines(parentReader, rel).get(key) || [];
        const atChild = keyedLines(childReader, rel).get(key) || [];
        if (atParent.length === 1 && atChild.length === 1 && addedTrimmed(rel).has(atChild[0])) {
          result.amended.push({ file: rel, text, retention: 0, key });
          continue;
        }
      }
      result.missing.push({ file: rel, text });
    }
  }
  return result;
}

function makeReaderPool(root) {
  const readers = new Map();
  const perimeters = new Map();
  const skippedByRev = new Map();
  return {
    get(rev) {
      if (!readers.has(rev)) readers.set(rev, makeRevisionReader(root, rev));
      return readers.get(rev);
    },
    perimeter(rev) {
      if (!perimeters.has(rev)) {
        const d = computePerimeterDetail(root, this.get(rev));
        perimeters.set(rev, d.paths);
        skippedByRev.set(rev, d.skipped);
      }
      return perimeters.get(rev);
    },
    skipped(rev) {
      this.perimeter(rev);
      return skippedByRev.get(rev);
    },
  };
}

function resolveRoot(opt) {
  const start = path.resolve(opt || process.env.MAVERICKS_PROJECT_ROOT || process.cwd());
  const top = git(start, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top === null) throw new GitError(`not a git repository: ${start}`);
  return top.trim();
}

function verifyCommit(root, rev) {
  const out = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  if (out === null || !out.trim()) throw new GitError(`revision does not resolve to a commit: ${rev}`);
  return out.trim();
}

function shortHash(root, full) {
  return git(root, ['rev-parse', '--short', full]).trim();
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const root = resolveRoot(opts.root);
  const pool = makeReaderPool(root);
  const steps = [];
  let header;

  if (opts.range !== null) {
    const shallow = git(root, ['rev-parse', '--is-shallow-repository']).trim();
    if (shallow === 'true') {
      throw new GitError(
        'shallow clone: this repository has grafted history, so --range cannot judge every commit\'s ' +
        'parent honestly. Refusing rather than reporting a false pass — run `git fetch --unshallow` first.',
      );
    }
    const from = verifyCommit(root, opts.from);
    const to = verifyCommit(root, opts.to);
    const list = git(root, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    header = `check-archive: range ${opts.range} (${list.length} first-parent commit(s))`;
    for (const c of list) {
      const parents = git(root, ['rev-list', '--parents', '-n', '1', c]).trim().split(/\s+/).slice(1);
      steps.push({ parentRev: parents.length ? parents[0] : null, childRev: c, label: shortHash(root, c), merge: parents.length > 1 });
    }
  } else {
    const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
    const headHash = head && head.trim() ? head.trim() : null;
    header = 'check-archive: staged index against HEAD';
    steps.push({ parentRev: headHash, childRev: INDEX, label: 'staged' });
  }

  console.log(header);
  const perimeterUnion = new Set();
  const skippedUnion = new Set();
  let removed = 0;
  let working = 0;
  let archive = 0;
  const amended = [];
  const missing = [];
  for (const step of steps) {
    const r = judgeStep(root, { ...step, readers: pool });
    if (r.root) {
      console.log(`  ${r.label}: ${step.childRev === INDEX ? 'unborn HEAD' : 'root commit'} (no parent) — nothing can be removed`);
    } else if (step.merge) {
      console.log(`  ${r.label}: merge commit — judged against its first parent`);
    }
    for (const f of r.perimeter) perimeterUnion.add(f);
    for (const f of r.skipped) skippedUnion.add(f);
    removed += r.removed;
    working += r.working;
    archive += r.archive;
    for (const a of r.amended) amended.push({ commit: r.label, ...a });
    for (const m of r.missing) missing.push({ commit: r.label, ...m });
  }

  for (const a of amended) {
    const how = a.key !== undefined ? `key match: ${a.key}` : `${Math.round(a.retention * 100)}% retained`;
    console.log(`  AMENDED ${a.commit} ${a.file} (${how}): ${a.text}`);
  }
  for (const m of missing) {
    console.log(`  MISSING ${m.commit} ${m.file}: ${m.text}`);
  }
  console.log('Summary:');
  console.log(`  commits scanned: ${steps.length}`);
  console.log(`  perimeter files: ${perimeterUnion.size}${perimeterUnion.size ? ` (${[...perimeterUnion].sort().join(', ')})` : ''}`);
  if (skippedUnion.size > 0) {
    console.log(`  skipped installer-managed files (not in this adopter's perimeter): ${[...skippedUnion].sort().join(', ')}`);
  }
  console.log(`  removed lines: ${removed}`);
  console.log(`  found-in-working: ${working}`);
  console.log(`  found-in-archive: ${archive}`);
  console.log(`  amended-in-place: ${amended.length}`);
  console.log(`  keyed-amendments: ${amended.filter((a) => a.key !== undefined).length}`);
  console.log(`  missing: ${missing.length}`);
  if (removed === 0) console.log('0 removed lines in perimeter');
  if (missing.length > 0) {
    console.log(`Result: FAIL — ${missing.length} removed perimeter line(s) reappear in no perimeter doc, in no docs/archive/ file touched by the same commit, and have no amended descendant`);
    return 1;
  }
  console.log(`Result: PASS — all ${removed} removed perimeter line(s) accounted for (${working} in working docs, ${archive} in same-commit archive files, ${amended.length} amended in place)`);
  return 0;
}

if (require.main === module) {
  let code;
  try {
    code = run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`check-archive: ${err.message}`);
      console.error(usage());
      code = 2;
    } else {
      console.error(`check-archive: ${err instanceof GitError ? err.message : `error: ${err && err.stack ? err.stack : err}`}`);
      code = 2;
    }
  }
  // exitCode, not exit(): let a piped stdout drain before the process ends.
  process.exitCode = code;
}

module.exports = { parseArgs, run, computePerimeter, computePerimeterDetail, judgeStep, tokenize, judgeAmended, keyOf, AMENDED_RETENTION_THRESHOLD };
