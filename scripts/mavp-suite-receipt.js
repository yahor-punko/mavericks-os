#!/usr/bin/env node
// mavp-declared-in: CLAUDE.md :: Wave closure
// mavp-suite-receipt.js — gives the once-per-wave "run the full suite on main"
// duty an OBSERVABLE form (a receipt) and a hard stop at `git push` (T-763).
//
// WHY THIS FILE EXISTS — the duty was pure prose: worktree developers run
// only filtered subsets (never the full suite, see
// docs/core/ORCHESTRATION_RULES.md — "Test-execution scope (worktree
// developers)"), and the one unfiltered integration run on main that
// compensates for that was owed by the Main Agent with nothing recording
// whether it happened. A duty with no observable form is indistinguishable
// from one that was skipped, and the first thing that noticed a skip was CI,
// after the push.
//
// TWO HALVES, one shared contract (both live in THIS file so the path, the
// shape and the staleness rule can never drift apart):
//   1. WRITER — scripts/run-tests.js calls writeReceiptIfEligible() at the end
//      of every run. A receipt is written ONLY by an unfiltered run in which
//      every test file passed, against a tracked tree with no modified
//      non-state file (at the start AND at the end of the run), at a HEAD that
//      did not move during the run. Every other run writes nothing and prints
//      exactly one "Suite receipt: not written — <why>" line.
//   2. CHECKER — `node scripts/mavp-suite-receipt.js [--if-canonical]` (wired
//      into .claude/hooks/pre-push) exits 0 when the receipt is current and 1
//      otherwise, naming the receipt commit, HEAD, the first offending path
//      and the exact remedy command.
//
// STALENESS USES CI'S OWN DEFINITION, READ FROM THE WORKFLOW FILE. A receipt
// is current when its commit equals HEAD, OR when every path the two commits'
// trees differ in matches the CI workflow's `on.push.paths-ignore` list —
// i.e. exactly the diffs for which CI itself would not run. This is
// load-bearing, not a convenience: the `chore: close session` commit touches
// only state artifacts, so an exact-HEAD rule (the one
// scripts/check-assembled-suite.js deliberately uses for the PUBLISH gate)
// would make this PUSH gate fight the close-session ritual on every wave —
// suite, close-session, suite again, push. The list is parsed out of
// .github/workflows/ci.yml at check time rather than copied into this file,
// so there is no second list that can drift silently. When the workflow file
// is absent or uses a filter syntax this parser does not model (negation,
// `?`, `+`, character classes), the checker FAILS CLOSED to exact-HEAD
// binding and says so in its message.
//
// THE RECEIPT IS AN ANTI-FORGETFULNESS DEVICE, NOT AN ANTI-ADVERSARY ONE —
// the same stance scripts/check-assembled-suite.js states, verbatim in
// spirit: it is a plain JSON file in a git-ignored directory, forgeable by
// writing a fake file, which is exactly as hard as deleting the hook stanza.
// That is acceptable because the observed threat is omission, not malice.
// Unlike the publish gate, this push gate DOES carry an escape hatch
// (MAVP_SKIP_SUITE_RECEIPT=1, honoured by .claude/hooks/pre-push, never by
// this script) because a push can be urgent in ways a publish cannot — e.g.
// pushing a CI fix while the suite is known red for an unrelated reason.
//
// CANONICAL-ONLY MODE — `--if-canonical` exits 0 with a SKIP line in any
// repository that is not the canonical private repo, reusing
// isCanonicalRepo() from scripts/check-publish-manifest.js (every `exclude`
// key is git-tracked) rather than inventing a second heuristic. A repo with
// no scripts/publish-manifest.json at all is non-canonical, matching
// check-publish-manifest.js's own `--if-canonical` stance.
//
// NAMING CONSTRAINT: deliberately NOT named test-*.js, so run-tests.js never
// discovers it as a test file.
//
// Usage:
//   node scripts/mavp-suite-receipt.js [--if-canonical]
//
// No external dependencies — Node built-ins only (.claude/rules/scripts.md).

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Receipt location, relative to the repo root. Git-ignored (see .gitignore):
// an untracked-but-unignored receipt would make `git status --porcelain`
// non-empty, and a tracked one would be content that changes every run.
const RECEIPT_RELATIVE_PATH = path.join('.mavp', 'suite-receipt.json');

// Bumped only on an incompatible shape change; a receipt at any other schema
// reads as "no current receipt" (fail closed).
const RECEIPT_SCHEMA = 1;

// The exact remedy command every refusal names. Exported so the close-session
// advisory and the tests reference the same literal.
const REMEDY_COMMAND = 'node scripts/run-tests.js';

// CI's own staleness definition lives here (on.push.paths-ignore).
const CI_WORKFLOW_RELATIVE_PATH = path.join('.github', 'workflows', 'ci.yml');

// Line prefix shared by every line the writer prints and every line the
// close-session advisory prints, so each surface emits exactly one
// greppable line.
const LINE_PREFIX = 'Suite receipt:';

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

// Git exports GIT_DIR (and sometimes GIT_WORK_TREE / GIT_INDEX_FILE) into the
// environment of hooks it runs, and GIT_DIR takes precedence over cwd-based
// discovery. This script is invoked from .claude/hooks/pre-push, so every git
// call strips those variables and lets git discover the repository from the
// explicit cwd instead — the same hardening scripts/check-changelog-frozen.js
// applies (T-517).
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: gitEnv(),
  });
}

/** Resolves the working-tree root containing `dir`, or null outside a repo. */
function resolveGitRoot(dir) {
  try {
    const out = git(dir, ['rev-parse', '--show-toplevel']).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** `root`'s HEAD as a full 40-hex sha, or null. */
function headCommitOf(root) {
  try {
    const out = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function commitExists(root, sha) {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function splitNul(out) {
  return String(out).split('\0').filter(Boolean);
}

/**
 * Tracked paths that differ between HEAD and the working tree (staged or
 * unstaged, including deletions). Untracked files are deliberately not
 * listed — the contract is about the TRACKED tree matching a commit.
 * `--no-renames` reports both sides of a rename. Returns null when the diff
 * cannot be computed (e.g. no commit yet).
 */
function listModifiedTrackedPaths(root) {
  try {
    return splitNul(git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']));
  } catch {
    return null;
  }
}

/** Paths whose content differs between two commits' trees, or null. */
function listChangedPathsBetween(root, fromSha, toSha) {
  try {
    return splitNul(git(root, ['diff', '--name-only', '--no-renames', '-z', fromSha, toSha, '--']));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CI paths-ignore — the staleness definition, read from the workflow file
// ---------------------------------------------------------------------------

function stripYamlScalar(raw) {
  let value = raw.trim();
  // Trailing comment (only when separated by whitespace — '#' can appear
  // inside a quoted value, which this parser treats as unsupported below).
  const hashAt = value.search(/\s#/);
  if (hashAt !== -1) value = value.slice(0, hashAt).trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  return value;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isSkippable(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/**
 * Extracts `on.push.paths-ignore` from a GitHub Actions workflow's text.
 * Deliberately small: it models only the block-style YAML this repo's
 * ci.yml uses. Returns an array of patterns, or null when the list cannot be
 * located or uses a construct this parser does not model — the caller treats
 * null as "fall back to exact-HEAD binding" (fail closed), never as "ignore
 * everything".
 */
function parsePathsIgnore(workflowText) {
  const lines = String(workflowText).split(/\r?\n/);
  let i = lines.findIndex((l) => /^(on|'on'|"on"):\s*(#.*)?$/.test(l));
  if (i === -1) return null;
  // Find `push:` as a direct child of `on:`.
  let pushIndent = -1;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const ind = indentOf(line);
    if (ind === 0) return null; // left the `on:` block without finding push
    if (/^\s*push:\s*(#.*)?$/.test(line)) {
      pushIndent = ind;
      break;
    }
  }
  if (pushIndent === -1) return null;
  // Find `paths-ignore:` as a child of `push:`.
  let listIndent = -1;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const ind = indentOf(line);
    if (ind <= pushIndent) return []; // push block has no paths-ignore at all
    if (/^\s*paths-ignore:\s*(#.*)?$/.test(line)) {
      listIndent = ind;
      break;
    }
  }
  if (listIndent === -1) return [];
  const patterns = [];
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    const ind = indentOf(line);
    if (ind <= listIndent) break;
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (!m) return null; // not a block sequence item — unmodelled shape
    const value = stripYamlScalar(m[1]);
    if (!value) return null;
    patterns.push(value);
  }
  if (patterns.length === 0) return null;
  // Constructs whose GitHub filter semantics this matcher does not model
  // (negation, `?`/`+` quantifiers, character classes) — fail closed.
  if (patterns.some((p) => /[!?+[\]]/.test(p))) return null;
  return patterns;
}

/**
 * Compiles one GitHub path-filter pattern (the supported subset: literal
 * characters, `*`, `**`) into an anchored RegExp over a repo-relative path.
 * `*` never crosses `/`; `**` does; a `**` + slash prefix also matches zero
 * directories.
 */
function patternToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else {
      re += ch.replace(/[\\^$.|(){}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAnyPattern(filePath, patterns) {
  return patterns.some((p) => patternToRegExp(p).test(filePath));
}

/**
 * Reads CI's paths-ignore list from `root`'s workflow file.
 * Returns `{ patterns: string[] | null, source }` — patterns is null when the
 * file is absent or unparseable (fail closed).
 */
function readCiPathsIgnore(root) {
  const source = CI_WORKFLOW_RELATIVE_PATH;
  let text;
  try {
    text = fs.readFileSync(path.join(root, source), 'utf8');
  } catch {
    return { patterns: null, source };
  }
  return { patterns: parsePathsIgnore(text), source };
}

/** First path in `paths` NOT covered by `patterns` (all paths when null). */
function firstNonIgnoredPath(paths, patterns) {
  for (const p of paths) {
    if (!patterns || !matchesAnyPattern(p, patterns)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipt read/write
// ---------------------------------------------------------------------------

function receiptPathFor(root) {
  return path.join(root, RECEIPT_RELATIVE_PATH);
}

/**
 * Reads and shape-validates `root`'s receipt. Never throws; every failure
 * returns `{ ok: false, reason }`. Greenness is re-derived from the recorded
 * numbers rather than trusted from the file's existence.
 */
function readSuiteReceipt(root) {
  const receiptPath = receiptPathFor(root);
  let raw;
  try {
    raw = fs.readFileSync(receiptPath, 'utf8');
  } catch {
    return { ok: false, absent: true, reason: `no receipt at ${RECEIPT_RELATIVE_PATH}` };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `receipt at ${RECEIPT_RELATIVE_PATH} is not valid JSON (${err.message})` };
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reason: `receipt at ${RECEIPT_RELATIVE_PATH} is not a JSON object` };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) {
    return { ok: false, reason: `receipt at ${RECEIPT_RELATIVE_PATH} has schema ${JSON.stringify(receipt.schema)}, expected ${RECEIPT_SCHEMA}` };
  }
  if (typeof receipt.commit !== 'string' || !/^[0-9a-f]{40}$/.test(receipt.commit)) {
    return { ok: false, reason: `receipt at ${RECEIPT_RELATIVE_PATH} has no full 40-hex commit field` };
  }
  const suite = receipt.suite || {};
  const { total, passed, failed } = suite;
  if (!Number.isInteger(total) || !Number.isInteger(passed) || !Number.isInteger(failed) ||
      total <= 0 || failed !== 0 || passed !== total) {
    return { ok: false, reason: `receipt at ${RECEIPT_RELATIVE_PATH} does not record an all-green suite (${JSON.stringify(suite)})` };
  }
  return { ok: true, receipt };
}

function writeSuiteReceipt(root, { commit, summaryLine, suite, standDowns }) {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    commit,
    generated_at: new Date().toISOString(),
    summary_line: summaryLine,
    suite,
    stand_downs: Array.isArray(standDowns) ? standDowns : [],
  };
  const receiptPath = receiptPathFor(root);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { receipt, receiptPath };
}

// ---------------------------------------------------------------------------
// Writer side — called by scripts/run-tests.js
// ---------------------------------------------------------------------------

/**
 * First modified tracked NON-state path in `root`, or null when the tracked
 * tree is clean apart from state artifacts. "State" means CI's own
 * paths-ignore set — the same definition the checker uses, so a receipt
 * earned while BACKLOG.md is mid-edit is exactly as valid as the checker
 * would later judge it. Returns `{ error }` when the diff cannot be read.
 */
function firstModifiedNonStatePath(root) {
  const modified = listModifiedTrackedPaths(root);
  if (modified === null) return { error: 'could not diff the working tree against HEAD' };
  const { patterns } = readCiPathsIgnore(root);
  return { path: firstNonIgnoredPath(modified, patterns) };
}

/**
 * Captures the pre-run facts the writer needs. Called by run-tests.js BEFORE
 * any test file runs, so a test that dirties the tree cannot launder itself.
 */
function captureRunStart(scriptsDir) {
  const root = resolveGitRoot(scriptsDir);
  if (!root) return { root: null };
  return { root, head: headCommitOf(root), dirty: firstModifiedNonStatePath(root) };
}

/**
 * Decides whether this run earns a receipt and, if so, writes it.
 * Returns the single line run-tests.js prints — always exactly one line,
 * beginning with LINE_PREFIX.
 */
function writeReceiptIfEligible({ start, filter, failedFiles, summaryLine, total, passed, standDowns }) {
  if (filter) {
    return `${LINE_PREFIX} not written — filtered run (--filter "${filter}"); only an unfiltered run of every test file can earn a receipt.`;
  }
  if (failedFiles && failedFiles.length > 0) {
    return `${LINE_PREFIX} not written — ${failedFiles.length} test file(s) failed (${failedFiles.join(', ')}); only an all-green run earns a receipt.`;
  }
  if (!start || !start.root) {
    return `${LINE_PREFIX} not written — the runner is not inside a git repository, so there is no commit to bind a receipt to.`;
  }
  if (!start.head) {
    return `${LINE_PREFIX} not written — could not resolve HEAD at the start of the run.`;
  }
  if (start.dirty.error) {
    return `${LINE_PREFIX} not written — ${start.dirty.error} at the start of the run.`;
  }
  if (start.dirty.path) {
    return `${LINE_PREFIX} not written — tracked non-state file modified at the start of the run: ${start.dirty.path} (commit or revert it; only CI paths-ignore state paths may differ from HEAD).`;
  }
  const headNow = headCommitOf(start.root);
  if (headNow !== start.head) {
    return `${LINE_PREFIX} not written — HEAD moved during the run (${start.head.slice(0, 7)} -> ${headNow ? headNow.slice(0, 7) : 'unresolvable'}), so no single commit was tested.`;
  }
  const dirtyNow = firstModifiedNonStatePath(start.root);
  if (dirtyNow.error) {
    return `${LINE_PREFIX} not written — ${dirtyNow.error} at the end of the run.`;
  }
  if (dirtyNow.path) {
    return `${LINE_PREFIX} not written — tracked non-state file modified during the run: ${dirtyNow.path} (a test left the tree dirty, so the run no longer matches HEAD).`;
  }
  writeSuiteReceipt(start.root, {
    commit: start.head,
    summaryLine,
    suite: { total, passed, failed: 0 },
    standDowns,
  });
  return `${LINE_PREFIX} written — ${RECEIPT_RELATIVE_PATH} records HEAD ${start.head}.`;
}

// ---------------------------------------------------------------------------
// Checker side — the pre-push gate and the close-session advisory
// ---------------------------------------------------------------------------

function isCanonicalRoot(root) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'publish-manifest.json'), 'utf8'));
  } catch {
    return false; // no (readable) manifest => non-canonical, as check-publish-manifest.js --if-canonical
  }
  let tracked;
  try {
    tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  } catch {
    return false;
  }
  // Lazy: only the canonical-only mode needs it, and a runner copied alone
  // into a scratch dir never reaches this path.
  const { isCanonicalRepo } = require(path.join(__dirname, 'check-publish-manifest.js'));
  return isCanonicalRepo(manifest, tracked);
}

/**
 * Evaluates `root`'s receipt against its HEAD. Never throws.
 * Returns `{ ok, status, message, receiptCommit, head, offendingPath }` where
 * status is one of: current | current_state_only | missing | invalid | stale.
 */
function checkReceipt(root) {
  const head = headCommitOf(root);
  if (!head) {
    return { ok: false, status: 'stale', head: null, receiptCommit: null, offendingPath: null,
      message: `${LINE_PREFIX} cannot check — HEAD is unresolvable in ${root}. Remedy: ${REMEDY_COMMAND}` };
  }
  const read = readSuiteReceipt(root);
  if (!read.ok) {
    const status = read.absent ? 'missing' : 'invalid';
    return { ok: false, status, head, receiptCommit: null, offendingPath: null,
      message: `${LINE_PREFIX} ${status.toUpperCase()} — ${read.reason}; receipt commit: none, HEAD: ${head}. ` +
        `Remedy: run \`${REMEDY_COMMAND}\` (unfiltered, all green, clean tracked tree) on this commit, then push again.` };
  }
  const receiptCommit = read.receipt.commit;
  if (receiptCommit === head) {
    return { ok: true, status: 'current', head, receiptCommit, offendingPath: null,
      message: `${LINE_PREFIX} current — the receipt records HEAD ${head} (${read.receipt.summary_line || 'summary not recorded'}).` };
  }
  const { patterns, source } = readCiPathsIgnore(root);
  const fallbackNote = patterns ? '' : ` (${source} paths-ignore could not be read, so only an exact-HEAD receipt counts)`;
  let offendingPath = null;
  if (!commitExists(root, receiptCommit)) {
    offendingPath = '(receipt commit not found in this repository)';
  } else {
    const changed = listChangedPathsBetween(root, receiptCommit, head);
    if (changed === null) {
      offendingPath = '(could not diff the receipt commit against HEAD)';
    } else {
      offendingPath = firstNonIgnoredPath(changed, patterns);
      if (offendingPath === null) {
        return { ok: true, status: 'current_state_only', head, receiptCommit, offendingPath: null,
          message: `${LINE_PREFIX} current — receipt commit ${receiptCommit} differs from HEAD ${head} only in ` +
            `${source} paths-ignore paths (${changed.length} changed), which CI itself would not run for.` };
      }
    }
  }
  return { ok: false, status: 'stale', head, receiptCommit, offendingPath,
    message: `${LINE_PREFIX} STALE — receipt commit: ${receiptCommit}, HEAD: ${head}, first offending path: ` +
      `${offendingPath}${fallbackNote}. Remedy: run \`${REMEDY_COMMAND}\` (unfiltered, all green, clean tracked tree) on this commit, then push again.` };
}

/**
 * The single propose-only line --close-session prints beside its
 * wave-complete push reminder. Read-only (git reads + one file read), never
 * throws, never blocks: it only names the receipt's state and the remedy.
 */
function formatCloseSessionReceiptLine(root) {
  try {
    if (!isCanonicalRoot(root)) {
      return `${LINE_PREFIX} not checked — non-canonical repo (the pre-push suite-receipt gate only enforces in the canonical repo).`;
    }
    const result = checkReceipt(root);
    if (result.ok) {
      const short = result.receiptCommit.slice(0, 7);
      return result.status === 'current'
        ? `${LINE_PREFIX} current for HEAD ${short} — the pre-push gate will let this push through.`
        : `${LINE_PREFIX} current — recorded at ${short}; HEAD differs only in CI paths-ignore (state) paths, so the pre-push gate will let this push through.`;
    }
    const why = result.status === 'stale'
      ? `stale (first offending path since ${result.receiptCommit ? result.receiptCommit.slice(0, 7) : 'the receipt'}: ${result.offendingPath})`
      : result.status;
    return `${LINE_PREFIX} ${why} — run \`${REMEDY_COMMAND}\` (unfiltered) before \`git push\`; the pre-push hook refuses the push without a current receipt.`;
  } catch (err) {
    return `${LINE_PREFIX} could not be checked (${err.message}) — run \`${REMEDY_COMMAND}\` (unfiltered) before \`git push\` to be safe.`;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const ifCanonical = argv.includes('--if-canonical');
  const root = resolveGitRoot(path.resolve(__dirname, '..'));
  if (!root) {
    console.error(`${LINE_PREFIX} cannot check — ${path.resolve(__dirname, '..')} is not inside a git repository.`);
    return 1;
  }
  if (ifCanonical && !isCanonicalRoot(root)) {
    console.log(`SKIP: ${LINE_PREFIX.slice(0, -1).toLowerCase()} gate — non-canonical repo (no manifest, or an exclude key is not git-tracked); --if-canonical only enforces in the canonical private repo.`);
    return 0;
  }
  const result = checkReceipt(root);
  if (result.ok) {
    console.log(result.message);
    return 0;
  }
  console.error(result.message);
  return 1;
}

module.exports = {
  RECEIPT_RELATIVE_PATH,
  RECEIPT_SCHEMA,
  REMEDY_COMMAND,
  CI_WORKFLOW_RELATIVE_PATH,
  LINE_PREFIX,
  parsePathsIgnore,
  patternToRegExp,
  matchesAnyPattern,
  readCiPathsIgnore,
  resolveGitRoot,
  headCommitOf,
  readSuiteReceipt,
  writeSuiteReceipt,
  captureRunStart,
  writeReceiptIfEligible,
  isCanonicalRoot,
  checkReceipt,
  formatCloseSessionReceiptLine,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
