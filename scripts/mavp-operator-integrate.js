#!/usr/bin/env node

/**
 * mavp-operator-integrate.js
 *
 * T-567: cherry-pick a sub-agent's worktree commit (or commit range) into the
 * canonical PRIMARY checkout, with the actual git operation pinned to the
 * resolved project root regardless of the caller's process.cwd() — removing
 * the cwd-dependent hand-typed cherry-pick class recorded against this task
 * (see docs/core/ORCHESTRATION_RULES.md — "Worktree integration — Main
 * Agent", GAP A: the Main Agent's own evidence hash has previously come from
 * the wrong checkout because a bare `git cherry-pick` inherited whatever
 * directory the Bash tool's cwd happened to be sitting in at the time).
 *
 * IMPORTANT — "pin the root, not the cwd" is not the same claim as "cwd never
 * matters". Root resolution below (`process.env.MAVERICKS_PROJECT_ROOT ||
 * __dirname/..`) can itself still resolve to a linked worktree when invoked
 * via a relative path from inside one (the self-hosted wrapper exports no
 * MAVERICKS_PROJECT_ROOT) — that is exactly what guardMutatingRoot()'s
 * discriminator (c) (T-670) exists to refuse. What THIS file guarantees is
 * narrower and is the actual deliverable: once ROOT is resolved (by whatever
 * means), every git subprocess this script spawns is invoked with an
 * explicit `{ cwd: ROOT }` option — never left to inherit process.cwd() — so
 * the cherry-pick always lands in the resolved root's working tree, not
 * wherever the caller's shell happened to be.
 *
 * Usage:
 *   ./scripts/mavp-operator --integrate <commit>                 # single commit
 *   ./scripts/mavp-operator --integrate <base>..<tip>             # range — one
 *                                                                   line per commit,
 *                                                                   oldest first
 *   ./scripts/mavp-operator --integrate <commit> --task T-NNN     # also print a
 *                                                                   ready-to-run
 *                                                                   --set-status
 *                                                                   suggestion
 *
 * `--task` is OPTIONAL — integrating a commit unrelated to any tracked task
 * never requires inventing a task id.
 *
 * Writes NO state artifacts (BACKLOG.md / TASK_STATUS.md / PROCESS_STATE.*):
 * printing a suggested `--set-status` line (only when `--task` is given and
 * resolves to exactly one task block) is the entire extent of this command's
 * involvement with task state. Integration and status-booking stay
 * deliberately decoupled — a human or the Main Agent runs the suggested
 * command separately.
 *
 * Guarded by guardMutatingRoot() (T-624/T-670) FIRST, before any git
 * subprocess runs: a resolved root that is a never-installed tree,
 * $HOME/.mavericks, or a linked (non-primary) git worktree refuses and NAMES
 * the primary checkout path — it never auto-retargets the write to the
 * primary on the caller's behalf (T-624's refusal-over-magic philosophy).
 *
 * Refuses (exit 1) when a cherry-pick or merge is already in progress in the
 * resolved root (CHERRY_PICK_HEAD / MERGE_HEAD present) rather than silently
 * stacking a second pick on top of one still awaiting resolution.
 *
 * On conflict, exits non-zero and names the two recovery commands
 * (`git cherry-pick --abort` / `git cherry-pick --continue`) against the
 * resolved root — it never auto-aborts, leaving the conflicted state for a
 * human to resolve.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {
  printRepoIdentityHeader,
  guardMutatingRoot,
  locateTaskBlock,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function printUsage() {
  console.error(
    `${BOLD}Usage:${RESET} ./scripts/mavp-operator --integrate <commit|base..tip> [--task T-NNN]`
  );
  console.error(`${DIM}  <commit>        a single commit hash/ref to cherry-pick into the resolved root${RESET}`);
  console.error(`${DIM}  <base..tip>     a range — one commit cherry-picked per line, oldest first${RESET}`);
  console.error(`${DIM}  --task T-NNN    optional — prints a ready-to-run --set-status suggestion afterwards${RESET}`);
}

/**
 * Run a git command with cwd EXPLICITLY pinned to `cwd` — never left to
 * inherit process.cwd(). This is the load-bearing property under test: every
 * call site below passes ROOT here, not "whatever directory the caller's
 * shell happens to be sitting in."
 */
function runGit(args, cwd) {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * True when `name` (CHERRY_PICK_HEAD or MERGE_HEAD) exists in `root`'s git
 * directory. Resolved via `git rev-parse --git-path <name>` rather than a
 * hardcoded `.git/<name>` join, so this is correct both for a normal
 * checkout AND for a linked worktree (whose CHERRY_PICK_HEAD/MERGE_HEAD live
 * under the worktree's own private git-dir, not the shared common one).
 */
function gitHeadPathExists(root, name) {
  try {
    const gitPath = runGit(['rev-parse', '--git-path', name], root).trim();
    const resolved = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function main() {
  printRepoIdentityHeader(ROOT, { mutating: true });

  // T-743 round 2: `--integrate` is the single adjudicated exemption from
  // discriminator (d) (the caller-in-linked-worktree refusal). It satisfies
  // all three conjuncts of the exemption predicate documented on
  // checkNeverAProjectRoot(): (i) every git subprocess below is explicitly
  // cwd-pinned to ROOT, so this command has no exposure to the vector (d)
  // targets; (ii) it writes no state artifacts (see `.claude/rules/scripts.md`,
  // which already records that --integrate "is NOT an artifact writer in the
  // same sense"); (iii) the worktree-integration ritual actively MANDATES
  // worktree-proximate invocation (inspect the worktree, then integrate), so
  // refusing a worktree cwd would break a legitimate invocation rather than
  // catch an escape. The exemption disables (d) ONLY — discriminators (a),
  // (b) and (c) still apply, so a resolved ROOT that IS a linked worktree
  // continues to refuse via (c). A second exemption requires a
  // docs/core/GATE_LEDGER.md amendment, not just another call site.
  const rootGuard = guardMutatingRoot(ROOT, '--integrate', { skipCallerWorktreeCheck: true });
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

  const argv = process.argv.slice(2);
  let taskId = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task' && i + 1 < argv.length) {
      taskId = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }

  const spec = positional[0];
  if (!spec) {
    console.error(`${RED}Error: a commit or range is required.${RESET}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (taskId !== null && !/^T-\d+$/i.test(taskId)) {
    console.error(`${RED}Error: invalid task ID format "${taskId}" — expected T-NNN.${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Refuse before touching anything if a pick or merge is already in
  // progress in the resolved root — never stack a second cherry-pick on top
  // of one still awaiting resolution.
  if (gitHeadPathExists(ROOT, 'CHERRY_PICK_HEAD')) {
    console.error(`${RED}REFUSED: a cherry-pick is already in progress at ${ROOT}.${RESET}`);
    console.error(`${DIM}  resolve it first: git -C "${ROOT}" cherry-pick --abort      # discard${RESET}`);
    console.error(`${DIM}                 or git -C "${ROOT}" cherry-pick --continue   # after resolving conflicts${RESET}`);
    process.exitCode = 1;
    return;
  }
  if (gitHeadPathExists(ROOT, 'MERGE_HEAD')) {
    console.error(`${RED}REFUSED: a merge is already in progress at ${ROOT}.${RESET}`);
    console.error(`${DIM}  resolve it first: git -C "${ROOT}" merge --abort${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Resolve the commit list up front. A range (containing "..") is expanded
  // via `git rev-list --reverse`, oldest first, so multiple commits land
  // (and print) in their original order; a single ref is resolved to its
  // full hash so a bad ref is caught here, before any cherry-pick runs.
  let commits;
  try {
    if (spec.includes('..')) {
      const out = runGit(['rev-list', '--reverse', spec], ROOT);
      commits = out.split('\n').map((l) => l.trim()).filter(Boolean);
      if (commits.length === 0) {
        console.log(`${YELLOW}No commits in range "${spec}" — nothing to integrate.${RESET}`);
        process.exitCode = 0;
        return;
      }
    } else {
      const full = runGit(['rev-parse', spec], ROOT).trim();
      commits = [full];
    }
  } catch (err) {
    console.error(`${RED}Error: could not resolve "${spec}" in ${ROOT}.${RESET}`);
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) console.error(DIM + stderr + RESET);
    process.exitCode = 1;
    return;
  }

  const landed = [];
  for (const commit of commits) {
    try {
      runGit(['cherry-pick', commit], ROOT);
    } catch (err) {
      const stderr = (err.stderr || '').toString().trim();
      const stdout = (err.stdout || '').toString().trim();
      console.error('');
      console.error(`${RED}CONFLICT: cherry-pick of ${commit.slice(0, 7)} stopped at ${ROOT} — no auto-abort.${RESET}`);
      if (stdout) console.error(DIM + stdout + RESET);
      if (stderr) console.error(DIM + stderr + RESET);
      console.error(`${YELLOW}Resolve the conflict, then run one of:${RESET}`);
      console.error(`  git -C "${ROOT}" cherry-pick --abort      # discard this pick`);
      console.error(`  git -C "${ROOT}" cherry-pick --continue   # after fixing conflicts and staging the result`);
      if (landed.length > 0) {
        console.log('');
        console.log(`${GREEN}Landed before the conflict:${RESET}`);
        for (const h of landed) console.log(`integrated: ${h}`);
      }
      process.exitCode = 1;
      return;
    }
    const shortHash = runGit(['rev-parse', '--short', 'HEAD'], ROOT).trim();
    landed.push(shortHash);
    console.log(`integrated: ${shortHash}`);
  }

  if (taskId) {
    const upperTaskId = taskId.toUpperCase();
    const backlogPath = path.join(ROOT, 'BACKLOG.md');
    let found = false;
    if (fs.existsSync(backlogPath)) {
      const backlog = fs.readFileSync(backlogPath, 'utf8');
      const loc = locateTaskBlock(backlog, upperTaskId);
      found = loc.count === 1;
    }
    console.log('');
    if (found) {
      const lastHash = landed[landed.length - 1];
      console.log(`${CYAN}Suggested next step (this command writes no state itself):${RESET}`);
      console.log(`  ./scripts/mavp-operator --set-status ${upperTaskId} merged --commit ${lastHash}`);
    } else {
      console.log(
        `${YELLOW}${upperTaskId} not found (or duplicated) in ${backlogPath} — no --set-status suggestion printed.${RESET}`
      );
    }
  }

  process.exitCode = 0;
}

main();
