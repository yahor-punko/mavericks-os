#!/usr/bin/env node

/**
 * mavp-operator-worktree-report.js
 *
 * T-559: read-only operator report classifying every linked (agent) git
 * worktree of the current repo into exactly one of three classes:
 *   - dirty                 — uncommitted changes present
 *   - unintegrated           — clean, but carries commits with no
 *                              patch-equivalent commit reachable from main
 *   - clean-and-integrated   — clean, and every commit ahead of main (if any)
 *                              is patch-equivalent to a commit already in main
 *
 * Classification uses PATCH-EQUIVALENCE (`git cherry`), never raw
 * reachability (`merge-base --is-ancestor` / `branch --merged`) — this
 * project integrates by cherry-pick, so a worktree tip is unreachable from
 * main by construction even after its work is fully integrated. See
 * classifyWorktrees()'s doc comment in mavp-operator-lib.js for the full
 * rationale; that single implementation is also what feeds the
 * `--close-session` worktree-hygiene advisory, so both surfaces can never
 * drift apart.
 *
 * Read-only: this script never mutates a worktree, branch, or artifact file
 * — see .claude/rules/scripts.md's reporting-surface rule. Use
 * `--prune-worktrees` to actually remove anything.
 *
 * Usage:
 *   ./scripts/mavp-operator --worktree-report [--main-ref <ref>] [--mtime-threshold <ms>] [--json]
 */

'use strict';

const path = require('node:path');
const {
  classifyWorktrees,
  formatWorktreeHygieneAdvisory,
  printRepoIdentityHeader,
  relativeTime,
  UnresolvableMainRefError,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

const CLASS_COLOR = {
  dirty: RED,
  unintegrated: YELLOW,
  'clean-and-integrated': GREEN,
};

function parseArgs(argv) {
  const out = { mainRef: 'main', mtimeThresholdMs: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--main-ref') out.mainRef = argv[++i];
    else if (arg === '--mtime-threshold') out.mtimeThresholdMs = Number(argv[++i]);
    else if (arg === '--json') out.json = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = { mainRef: args.mainRef };
  if (Number.isFinite(args.mtimeThresholdMs)) options.mtimeThresholdMs = args.mtimeThresholdMs;

  let entries;
  try {
    entries = classifyWorktrees(ROOT, options);
  } catch (err) {
    if (err instanceof UnresolvableMainRefError) {
      console.error(
        `${RED}Worktree report aborted: mainRef '${err.mainRef}' does not resolve to a commit in this repo.${RESET}`
      );
      console.error(
        `${DIM}Pass --main-ref <ref> naming a ref that does resolve (e.g. --main-ref master).${RESET}`
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (args.json) {
    console.log(JSON.stringify({ root: ROOT, mainRef: args.mainRef, entries }, null, 2));
    return;
  }

  printRepoIdentityHeader(ROOT);
  console.log(`\n${BOLD}Worktree report${RESET} ${DIM}(patch-equivalence vs ${args.mainRef})${RESET}\n`);

  if (entries.length === 0) {
    console.log(`${DIM}No linked agent worktrees found.${RESET}`);
    return;
  }

  for (const e of entries) {
    const color = CLASS_COLOR[e.classification] || RESET;
    const rel = path.relative(ROOT, e.path) || e.path;
    const age = e.ageMs != null ? relativeTime(new Date(Date.now() - e.ageMs).toISOString()) : 'unknown';
    console.log(`  ${color}${e.classification.padEnd(20)}${RESET} ${rel}  ${DIM}[${e.branch || e.head || '(detached)'}]${RESET}`);
    console.log(
      `      ${DIM}dirty=${e.dirty} patch=${e.patchStatus} mtime-age=${age} prunable=${e.prunable}${RESET}`
    );
  }

  console.log('');
  console.log(`${CYAN}${formatWorktreeHygieneAdvisory(entries)}${RESET}`);
}

main();
