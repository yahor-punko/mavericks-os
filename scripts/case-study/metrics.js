#!/usr/bin/env node
'use strict';
// metrics.js — codifies the CONTROL-REPOSITORY measurement method
// behind the "Synth" case study (docs/case-studies/synth.md).
//
// This is a RE-MEASUREMENT AID, not a public reproducibility script. The
// measured repository (the Synth control repo) is private — this script
// takes the target repo's path as an argument so it can be re-run by the
// operator against that private repo to reproduce the case-study figures.
// It contains no private paths, repo names, or credentials; the only
// project-specific constant is the documented Mavericks-adoption cutoff
// date (2026-04-17), which is already public in the case study itself.
//
// Usage:
//   node scripts/case-study/metrics.js <target-repo-path> \
//     [--cutoff YYYY-MM-DD] [--snapshot-date YYYY-MM-DD]
//
// Emits a single JSON object to stdout with exactly these keys:
//   snapshot_date, commits_baseline, commits_mavp, merged, deployed_prod,
//   deferred, waves, checkpoints, repos_field_tasks, per_repo_evidence_lines
//
// Deliberately NOT emitted: `repositories` (repo count) and
// `aws_lambda_functions` (deployed Lambda count) — those figures are
// operator-verified externally against live production infrastructure and
// are not computable from the control repository's git/artifact history
// alone.
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

// Replicates `grep -cE '^commit: .+\([a-zA-Z0-9._-]+\)'` — counts lines
// starting with "commit: " followed by any text and a parenthesised
// repo-name suffix (the per-repo evidence-line convention).
const PER_REPO_EVIDENCE_RE = /^commit: .+\([a-zA-Z0-9._-]+\)/;

function countPerRepoEvidenceLines(text) {
  return text.split('\n').filter((line) => PER_REPO_EVIDENCE_RE.test(line)).length;
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
// the fixture test).
function computeMetrics({ repoPath, cutoffDate = DEFAULT_CUTOFF, snapshotDate }) {
  if (!repoPath) throw new Error('repoPath is required');
  if (!snapshotDate) throw new Error('snapshotDate is required (pass explicitly — no Date.now() fallback)');

  const { commits_baseline, commits_mavp } = splitCommitsByCutoff(repoPath, cutoffDate);
  const checkpoints = countCheckpoints(repoPath, cutoffDate);

  const backlog = readArtifact(repoPath, 'BACKLOG.md');
  const merged = countLinesContaining(backlog, '**Status:** merged');
  const deployed_prod = countLinesContaining(backlog, '**Status:** deployed_prod');
  const deferred = countLinesContaining(backlog, '**Status:** deferred');
  const repos_field_tasks = countLinesContaining(backlog, '**Repos:**');

  const taskStatus = readArtifact(repoPath, 'TASK_STATUS.md');
  const per_repo_evidence_lines = countPerRepoEvidenceLines(taskStatus);

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
    repos_field_tasks,
    per_repo_evidence_lines,
  };
}

function parseArgs(argv) {
  const positional = [];
  let cutoff = DEFAULT_CUTOFF;
  let snapshotDate = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cutoff') {
      cutoff = argv[i + 1];
      i++;
    } else if (argv[i] === '--snapshot-date') {
      snapshotDate = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { repoPath: positional[0], cutoff, snapshotDate };
}

function main() {
  const { repoPath, cutoff, snapshotDate } = parseArgs(process.argv.slice(2));
  if (!repoPath) {
    console.error('Usage: node scripts/case-study/metrics.js <target-repo-path> [--cutoff YYYY-MM-DD] [--snapshot-date YYYY-MM-DD]');
    process.exit(1);
  }
  // CLI-layer convenience default: the run date, computed here (not inside
  // computeMetrics) and passed in as an explicit option — see the
  // snapshotDate contract on computeMetrics above.
  const resolvedSnapshotDate = snapshotDate || new Date().toISOString().slice(0, 10);
  const metrics = computeMetrics({ repoPath: path.resolve(repoPath), cutoffDate: cutoff, snapshotDate: resolvedSnapshotDate });
  console.log(JSON.stringify(metrics, null, 2));
}

module.exports = { computeMetrics, DEFAULT_CUTOFF };

if (require.main === module) {
  main();
}
