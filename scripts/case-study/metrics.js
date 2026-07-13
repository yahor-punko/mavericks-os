#!/usr/bin/env node
'use strict';
// metrics.js — codifies the CONTROL-REPOSITORY measurement method behind
// the case study documented under docs/case-studies/.
//
// This is a RE-MEASUREMENT AID, not a public reproducibility script. The
// measured repository (the control repo) is private — this script takes
// the target repo's path as an argument so it can be re-run by the
// operator against that private repo to reproduce the case-study figures.
// It contains no private paths, repo names, or credentials; the only
// project-specific constant is the documented Mavericks-adoption cutoff
// date (2026-04-17), which is already public in the case study itself.
//
// The private repo-name TOKEN used to compute distinct_target_repos and
// any historical typo/alias normalization are NEVER hardcoded here (T-390)
// — both are supplied at runtime by the operator via --repo-prefix and
// repeatable --alias flags, so this source file can ship publicly without
// naming the measured repository.
//
// Usage (NEUTRAL example — substitute the operator's real private prefix
// and any historical typo aliases at run time; these are never baked in):
//   node scripts/case-study/metrics.js <target-repo-path> \
//     --repo-prefix acme- [--alias acme-widgts=acme-widgets] \
//     [--cutoff YYYY-MM-DD] [--snapshot-date YYYY-MM-DD]
//
// Emits a single JSON object to stdout with exactly these keys:
//   snapshot_date, commits_baseline, commits_mavp, merged, deployed_prod,
//   deferred, waves, checkpoints, repo_field_tasks, distinct_target_repos,
//   multi_repo_tasks
//
// Deliberately NOT emitted: `repositories` (repo count) and
// `aws_lambda_functions` (deployed Lambda count) — those figures are
// operator-verified externally against live production infrastructure and
// are not computable from the control repository's git/artifact history
// alone. Also removed (T-390): the discredited `per_repo_evidence_lines`
// key, whose withdrawn measurement method is no longer defensible — no key
// in this script's output may assert the retracted 148/17 figures.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_CUTOFF = '2026-04-17'; // documented Mavericks-adoption date

function runGit(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
}

// Splits each commit's committer-date ISO timestamp on 'T' and compares the
// date portion lexicographically against the cutoff (both are YYYY-MM-DD,
// so lexicographic comparison equals chronological comparison). This
// replicates the awk date-split method rather than `git log --since=`,
// which stops the DAG walk on the first out-of-range commit per parent
// path and undercounts merge-heavy history.
function splitCommitsByCutoff(repoPath, cutoffDate) {
  const raw = runGit(repoPath, ['log', '--format=%cI']);
  const dates = raw.split('\n').filter(Boolean).map((iso) => iso.split('T')[0]);
  let baseline = 0;
  let mavp = 0;
  for (const d of dates) {
    if (d < cutoffDate) baseline++;
    else mavp++;
  }
  return { commits_baseline: baseline, commits_mavp: mavp };
}

// Counts commit subjects since the cutoff whose text contains "close
// session" (case-insensitive), matching the "chore: close session ..."
// convention. Uses `--since` (unlike the baseline/mavp commit split above)
// because this is a bounded lookup against a known message convention, not
// a DAG-walk-sensitive full-history split.
function countCheckpoints(repoPath, cutoffDate) {
  const raw = runGit(repoPath, ['log', `--since=${cutoffDate}`, '--format=%s']);
  const subjects = raw.split('\n').filter(Boolean);
  return subjects.filter((s) => /close session/i.test(s)).length;
}

function countLinesContaining(text, literalSubstring) {
  return text.split('\n').filter((line) => line.includes(literalSubstring)).length;
}

// Replicates `grep -cE '\*\*Repo:\*\*' BACKLOG.md` — counts lines
// containing the literal SINGULAR field marker "**Repo:**". Deliberately
// does not match the plural "**Repos:**" cross-repo field, which is a
// distinct marker (an 's' sits between "Repo" and the colon), matching the
// documented grep pattern exactly.
const REPO_FIELD_MARKER_RE = /\*\*Repo:\*\*/;

function countRepoFieldTasks(backlogText) {
  return backlogText.split('\n').filter((line) => REPO_FIELD_MARKER_RE.test(line)).length;
}

// Extracts the field value that follows each `**Repo:**` marker on its
// line — everything up to end of line, mirroring the `[^|]*` capture in the
// documented `grep -hoE '\*\*Repo:\*\*[^|]*'` pipeline (no `|` characters
// appear in these field values in practice, so this is equivalent to
// "rest of line").
const REPO_FIELD_VALUE_RE = /\*\*Repo:\*\*([^\n]*)/g;

function extractRepoFieldValues(backlogText) {
  const values = [];
  let match;
  while ((match = REPO_FIELD_VALUE_RE.exec(backlogText)) !== null) {
    values.push(match[1]);
  }
  return values;
}

// Escapes regex metacharacters in a runtime-supplied prefix so it can be
// safely interpolated into a RegExp source string.
function escapeForRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds the repo-target-token extraction regex from a runtime-supplied
// prefix (e.g. "acme-"). Never derived from a hardcoded private name (T-390)
// — the prefix always comes from the operator's --repo-prefix flag.
function buildRepoRefRegex(repoPrefix) {
  return new RegExp(`${escapeForRegex(repoPrefix)}[a-z0-9-]+`, 'g');
}

// Applies a repeatable set of runtime-supplied {from, to} alias pairs to a
// single extracted repo-ref, as an exact-match (whole-token) replacement.
// Used to normalize historical typos in task data (e.g. a misspelled repo
// name) without ever hardcoding the misspelling in source.
function applyAliases(repoRef, aliases) {
  for (const { from, to } of aliases) {
    if (repoRef === from) return to;
  }
  return repoRef;
}

// Counts the number of distinct canonical repositories named as task
// targets across all `**Repo:**` field values. Extracts tokens matching the
// runtime-supplied repoPrefix, applies runtime-supplied aliases, and dedupes.
// NOTE: this script runs against a single target repo and cannot see
// sibling repo directories — it reports the distinct target REFS it
// observes in this repo's own BACKLOG.md, not a verified count of repos
// that actually exist. Any cross-check against a canonical list of known
// repos happens externally, outside this script.
function countDistinctTargetRepos(backlogText, repoPrefix, aliases) {
  const repoRefRe = buildRepoRefRegex(repoPrefix);
  const distinct = new Set();
  for (const value of extractRepoFieldValues(backlogText)) {
    const refs = value.match(repoRefRe) || [];
    for (const ref of refs) {
      distinct.add(applyAliases(ref, aliases));
    }
  }
  return distinct.size;
}

// Replicates:
//   grep -hoE '\*\*Repo:\*\*[^|]*' BACKLOG.md \
//     | sed 's/\*\*Repo:\*\*//' \
//     | grep -cE ',|\+'
// Counts `**Repo:**` field values that name more than one repo, using a
// comma or `+` separator.
const MULTI_REPO_SEPARATOR_RE = /,|\+/;

function countMultiRepoTasks(backlogText) {
  return extractRepoFieldValues(backlogText).filter((value) => MULTI_REPO_SEPARATOR_RE.test(value)).length;
}

function readArtifact(repoPath, fileName) {
  const filePath = path.join(repoPath, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected artifact not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

// Computes the full metrics object. Takes snapshotDate as a required
// option — this function never calls Date.now() itself, so results are
// fully deterministic given the same repo state and inputs (required for
// the fixture test). repoPrefix is likewise required — this function never
// bakes in a private repo-name literal (T-390); the operator supplies it
// at runtime. aliases (optional, default []) is an array of {from, to}
// pairs applied before dedupe.
function computeMetrics({ repoPath, cutoffDate = DEFAULT_CUTOFF, snapshotDate, repoPrefix, aliases = [] }) {
  if (!repoPath) throw new Error('repoPath is required');
  if (!snapshotDate) throw new Error('snapshotDate is required (pass explicitly — no Date.now() fallback)');
  if (!repoPrefix) throw new Error('repoPrefix is required (pass --repo-prefix explicitly — no private repo-name default is baked in)');

  const { commits_baseline, commits_mavp } = splitCommitsByCutoff(repoPath, cutoffDate);
  const checkpoints = countCheckpoints(repoPath, cutoffDate);

  const backlog = readArtifact(repoPath, 'BACKLOG.md');
  const merged = countLinesContaining(backlog, '**Status:** merged');
  const deployed_prod = countLinesContaining(backlog, '**Status:** deployed_prod');
  const deferred = countLinesContaining(backlog, '**Status:** deferred');
  const repo_field_tasks = countRepoFieldTasks(backlog);
  const distinct_target_repos = countDistinctTargetRepos(backlog, repoPrefix, aliases);
  const multi_repo_tasks = countMultiRepoTasks(backlog);

  const processStateRaw = readArtifact(repoPath, 'PROCESS_STATE.json');
  const processState = JSON.parse(processStateRaw);
  const waves = processState.wave;

  return {
    snapshot_date: snapshotDate,
    commits_baseline,
    commits_mavp,
    merged,
    deployed_prod,
    deferred,
    waves,
    checkpoints,
    repo_field_tasks,
    distinct_target_repos,
    multi_repo_tasks,
  };
}

function parseArgs(argv) {
  const positional = [];
  let cutoff = DEFAULT_CUTOFF;
  let snapshotDate = null;
  let repoPrefix = null;
  const aliases = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff') {
      cutoff = argv[i + 1];
      i++;
    } else if (argv[i] === '--snapshot-date') {
      snapshotDate = argv[i + 1];
      i++;
    } else if (argv[i] === '--repo-prefix') {
      repoPrefix = argv[i + 1];
      i++;
    } else if (argv[i] === '--alias') {
      const raw = argv[i + 1];
      i++;
      const eq = raw.indexOf('=');
      if (eq === -1) {
        throw new Error(`--alias must be in the form <from>=<to>, got: ${raw}`);
      }
      aliases.push({ from: raw.slice(0, eq), to: raw.slice(eq + 1) });
    } else {
      positional.push(argv[i]);
    }
  }
  return { repoPath: positional[0], cutoff, snapshotDate, repoPrefix, aliases };
}

function main() {
  const { repoPath, cutoff, snapshotDate, repoPrefix, aliases } = parseArgs(process.argv.slice(2));
  if (!repoPath || !repoPrefix) {
    console.error(
      'Usage: node scripts/case-study/metrics.js <target-repo-path> --repo-prefix <prefix> ' +
        '[--alias <from>=<to>] [--cutoff YYYY-MM-DD] [--snapshot-date YYYY-MM-DD]\n' +
        'Example (neutral): node scripts/case-study/metrics.js /path/to/repo --repo-prefix acme- --alias acme-widgts=acme-widgets'
    );
    process.exit(1);
  }
  // CLI-layer convenience default: the run date, computed here (not inside
  // computeMetrics) and passed in as an explicit option — see the
  // snapshotDate contract on computeMetrics above.
  const resolvedSnapshotDate = snapshotDate || new Date().toISOString().slice(0, 10);
  const metrics = computeMetrics({
    repoPath: path.resolve(repoPath),
    cutoffDate: cutoff,
    snapshotDate: resolvedSnapshotDate,
    repoPrefix,
    aliases,
  });
  console.log(JSON.stringify(metrics, null, 2));
}

module.exports = { computeMetrics, DEFAULT_CUTOFF };

if (require.main === module) {
  main();
}
