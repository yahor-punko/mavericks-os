#!/usr/bin/env node

/**
 * mavp-operator-prune-worktrees.js
 *
 * T-559: remove ONLY the worktrees classifyWorktrees() puts in the
 * 'clean-and-integrated' class AND that pass the mtime safety condition
 * (WORKTREE_PRUNE_MTIME_THRESHOLD_MS in mavp-operator-lib.js) — never a
 * 'dirty' or 'unintegrated' worktree, and never a worktree whose directory
 * was touched more recently than the threshold, so a just-spawned live
 * agent's still-clean worktree is never removed. Classification is by
 * PATCH-EQUIVALENCE (`git cherry`), not raw reachability — see
 * classifyWorktrees()'s doc comment in mavp-operator-lib.js for why: this
 * project integrates by cherry-pick, so a worktree tip is unreachable from
 * main by construction even after its work is fully, correctly integrated.
 *
 * DEFAULTS TO DRY-RUN — chosen deliberately, mirroring --strip's two-stage
 * confirm for the same reason: pruning removes a worktree's directory AND
 * its `worktree-agent-*` branch ref, an irreversible operation on a shared,
 * repository-global resource (every linked worktree of the same repo shares
 * one `.git` object/ref database, and — per the T-559 brief's OPERATOR
 * CONSTRAINT — a real prune should only ever run with zero live sub-agents).
 * A destructive operator command should never fire on its first invocation;
 * pass --yes to actually delete, otherwise this only PRINTS what would be
 * removed and touches nothing.
 *
 * Usage:
 *   ./scripts/mavp-operator --prune-worktrees [--yes] [--main-ref <ref>] [--mtime-threshold <ms>]
 */

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  classifyWorktrees,
  formatWorktreeHygieneAdvisory,
  printRepoIdentityHeader,
  UnresolvableMainRefError,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function parseArgs(argv) {
  const out = { yes: false, mainRef: 'main', mtimeThresholdMs: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') out.yes = true;
    else if (arg === '--main-ref') out.mainRef = argv[++i];
    else if (arg === '--mtime-threshold') out.mtimeThresholdMs = Number(argv[++i]);
  }
  return out;
}

function removeWorktree(root, entry) {
  execFileSync('git', ['worktree', 'remove', entry.path], { cwd: root, stdio: 'pipe' });
  if (!entry.branch) return { removedWorktree: true, removedBranch: false };
  try {
    execFileSync('git', ['branch', '-D', entry.branch], { cwd: root, stdio: 'pipe' });
    return { removedWorktree: true, removedBranch: true };
  } catch (err) {
    const branchError = (err.stderr || err.message || '').toString().trim();
    return { removedWorktree: true, removedBranch: false, branchError };
  }
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
        `${RED}Worktree prune aborted: mainRef '${err.mainRef}' does not resolve to a commit in this repo.${RESET}`
      );
      console.error(
        `${DIM}Pass --main-ref <ref> naming a ref that does resolve (e.g. --main-ref master).${RESET}`
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const prunable = entries.filter((e) => e.prunable);

  printRepoIdentityHeader(ROOT);
  console.log(`\n${BOLD}Worktree prune${RESET} ${DIM}(patch-equivalence vs ${args.mainRef})${RESET}\n`);
  console.log(`${DIM}${formatWorktreeHygieneAdvisory(entries)}${RESET}\n`);

  if (prunable.length === 0) {
    console.log(`${DIM}No prunable worktrees (clean-and-integrated + past the mtime safety window).${RESET}`);
    return;
  }

  if (!args.yes) {
    console.log(`${YELLOW}DRY RUN — would remove ${prunable.length} worktree(s):${RESET}`);
    for (const e of prunable) {
      console.log(`  ${DIM}${path.relative(ROOT, e.path) || e.path}  [${e.branch || e.head}]${RESET}`);
    }
    console.log(
      `\n${DIM}Re-run with --yes to actually remove. Run the real (--yes) prune only with zero live sub-agents.${RESET}`
    );
    return;
  }

  console.log(`${BOLD}Removing ${prunable.length} worktree(s):${RESET}`);
  let failures = 0;
  for (const e of prunable) {
    const rel = path.relative(ROOT, e.path) || e.path;
    try {
      const result = removeWorktree(ROOT, e);
      if (result.removedBranch) {
        console.log(`  ${GREEN}✓ removed ${rel} + branch ${e.branch}${RESET}`);
      } else if (e.branch) {
        console.log(
          `  ${YELLOW}⚠ removed ${rel}, but branch ${e.branch} could not be deleted: ${result.branchError}${RESET}`
        );
      } else {
        console.log(`  ${GREEN}✓ removed ${rel}${RESET}`);
      }
    } catch (err) {
      failures += 1;
      const msg = (err.stderr || err.message || '').toString().trim();
      console.log(`  ${RED}✗ failed to remove ${rel}: ${msg}${RESET}`);
    }
  }

  process.exitCode = failures > 0 ? 1 : 0;
}

main();
