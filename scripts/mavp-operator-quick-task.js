#!/usr/bin/env node

/**
 * mavp-operator-quick-task.js
 *
 * Minimal interactive task creation — prompts for title and problem only.
 * All other fields are auto-filled with sensible defaults (TBD placeholders).
 * Appends to BACKLOG.md and TASK_STATUS.md atomically.
 * Runs validator after write and prints full output.
 *
 * Usage: ./scripts/mavp-operator --quick-task
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const {
  readUtf8,
  writeUtf8,
  getNextTaskId,
  insertIntoActiveWave,
  insertIntoActiveTasks,
  updateLastTaskId,
  parseTasksWithRepo,
  getDeployPendingForRepo,
  writeContextBundle,
  printRepoIdentityHeader,
  guardMutatingRoot,
  resolveTaskOrigin,
  ARCHITECT_GATE_ADVISORY,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');

// Resolve validator path: project-mode uses MAVERICKS_SCRIPTS, self-mode uses local scripts/
const MAVERICKS_SCRIPTS = process.env.MAVERICKS_SCRIPTS
  || path.join(require('node:os').homedir(), 'Documents', 'mavericks', 'scripts');
const VALIDATOR = path.join(MAVERICKS_SCRIPTS, 'mavp-validator.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function buildBacklogEntry(id, title, problem, date, repo, origin) {
  return `\n### ${id} — ${title}
- **Status:** planned
- **Priority:** medium
- **Owner role:** developer
- **Repo:** ${repo || 'TBD'}
- **Depends on:** —
- **Problem:** ${problem}
- **Proposed solution:** TBD
- **Acceptance criteria:** TBD
- **Verification type:** TBD
- **Origin:** ${origin}
- **Evidence expected:** TBD
- **Next if passed:** —
`;
}

function buildTaskStatusEntry(id, title, problem, date) {
  return `\n### ${id} — ${title}
- **Status:** planned
- **Owner role:** developer
- **Verification type:** TBD
- **Last verified by:** —
- **Evidence:** —
- **Notes:** Quick-task created ${date}. Problem: ${problem}
`;
}

async function prompt(rl, question) {
  return new Promise(resolve => {
    // If readline is already closed (non-TTY, EOF), resolve with empty string
    if (rl.closed) {
      resolve('');
      return;
    }
    const onClose = () => resolve('');
    rl.once('close', onClose);
    rl.question(`${question}: `, answer => {
      rl.removeListener('close', onClose);
      resolve(answer.trim());
    });
  });
}

/**
 * Parse CLI flags: --title, --problem, --repo (space-separated value —
 * matches the `--flag value` convention used by set-status.js / apply-decomposition.js),
 * plus an optional --origin. Absent flags resolve to null (distinct from an
 * intentionally blank value).
 *
 * `--origin architect` attests that this task went through architect
 * decomposition despite being registered via --quick-task; any other value
 * (or the flag being absent) resolves to Origin: manual (T-531) — see
 * resolveTaskOrigin() in mavp-operator-lib.js. --origin is always optional —
 * it never counts toward the required title/problem/repo trio on non-TTY stdin.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{title: string|null, problem: string|null, repo: string|null, origin: string|null}}
 */
function parseCliArgs(argv) {
  const flags = { title: null, problem: null, repo: null, origin: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title' && i + 1 < argv.length) {
      flags.title = argv[++i];
    } else if (argv[i] === '--problem' && i + 1 < argv.length) {
      flags.problem = argv[++i];
    } else if (argv[i] === '--repo' && i + 1 < argv.length) {
      flags.repo = argv[++i];
    } else if (argv[i] === '--origin' && i + 1 < argv.length) {
      flags.origin = argv[++i];
    }
  }
  return flags;
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));
  const isTTY = !!process.stdin.isTTY;

  // Hard non-TTY guard — runs before any read/write. Piped/non-interactive stdin
  // must supply all three fields explicitly; otherwise refuse and write nothing.
  if (!isTTY) {
    const missing = [];
    if (flags.title == null) missing.push('--title');
    if (flags.problem == null) missing.push('--problem');
    if (flags.repo == null) missing.push('--repo');
    if (missing.length > 0) {
      console.error(`${RED}quick-task: stdin is not a TTY and required flag(s) are missing: ${missing.join(', ')}${RESET}`);
      console.error(`${DIM}Non-interactive usage: --quick-task --title "<title>" --problem "<problem>" --repo "<repo>"${RESET}`);
      process.exitCode = 1;
      return;
    }
  }

  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--quick-task');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP Quick Task${RESET} ${DIM}${today}${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);
  const id = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);

  console.log(`${CYAN}Next task ID: ${BOLD}${id}${RESET}\n`);

  let title, problem, repo;

  if (flags.title != null && flags.problem != null && flags.repo != null) {
    // Full non-interactive mode — works whether stdin is a TTY or not.
    title = flags.title.trim();
    if (!title) {
      console.error(`${RED}--title must not be empty.${RESET}`);
      process.exitCode = 1;
      return;
    }
    problem = flags.problem.trim();
    repo = flags.repo.trim() || 'TBD';
    console.log(`${DIM}Non-interactive mode — using --title/--problem/--repo.${RESET}`);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    title = flags.title != null ? flags.title.trim() : await prompt(rl, 'Task title');
    if (!title) {
      console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
      rl.close();
      return;
    }

    problem = flags.problem != null ? flags.problem.trim() : await prompt(rl, 'Problem (one line)');
    const repoRaw = flags.repo != null ? flags.repo.trim() : await prompt(rl, 'Repo (e.g. mavericks, example-service, or leave blank)');
    repo = repoRaw || 'TBD';

    rl.close();
  }

  // Resolve Origin: manual by default; --origin architect attests this task
  // went through architect decomposition despite bypassing --apply-decomposition.
  // Print the advisory ONLY when origin resolves to manual (T-531) — this is
  // an advisory signal, not enforcement, so it never blocks task creation.
  const origin = resolveTaskOrigin(flags.origin);
  if (origin === 'manual') {
    console.error(ARCHITECT_GATE_ADVISORY);
  }

  // Warn if the target repo has deploy_pending tasks
  try {
    const psJson = fs.existsSync(PROCESS_STATE_JSON)
      ? JSON.parse(readUtf8(PROCESS_STATE_JSON))
      : {};
    const deployContours = psJson.deploy_contours != null ? psJson.deploy_contours : 2;
    const allTasks = parseTasksWithRepo(readUtf8(TASK_STATUS_MD), readUtf8(BACKLOG_MD));
    const pending = getDeployPendingForRepo(allTasks, repo, deployContours);
    if (pending.length > 0) {
      console.warn(`\n${YELLOW}⚠  Warning: ${pending.length} task(s) in ${repo} have pending deploys. Consider deploying before adding new tasks.${RESET}`);
      pending.forEach(t => console.warn(`   ${DIM}${t.id} — ${t.title}${RESET}`));
    }
  } catch (_) {
    // Non-fatal — continue regardless
  }

  const backlogEntry = buildBacklogEntry(id, title, problem || '—', today, repo, origin);
  const taskStatusEntry = buildTaskStatusEntry(id, title, problem || '—', today);

  const updatedBacklog = insertIntoActiveWave(backlog, backlogEntry);
  const updatedTaskStatus = insertIntoActiveTasks(taskStatus, taskStatusEntry);

  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`\n${GREEN}✓ BACKLOG.md — ${id} added${RESET}`);

  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${id} added${RESET}`);

  const updated = updateLastTaskId(PROCESS_STATE_JSON, id);
  if (updated) {
    console.log(`${GREEN}✓ PROCESS_STATE.json — last_task_id updated to ${id.replace('T-', '')}${RESET}`);
  }

  // Write context prefetch bundle (.mavp/context/T-NNN.md) — best effort, never fatal
  const bundleResult = writeContextBundle(id, { root: ROOT, backlogPath: BACKLOG_MD, taskStatusPath: TASK_STATUS_MD });
  if (bundleResult.ok) {
    console.log(`${GREEN}✓ Context bundle — .mavp/context/${id}.md${RESET}`);
  } else {
    console.log(`${DIM}(context bundle not written: ${bundleResult.reason})${RESET}`);
  }

  // Run validator — print full stdout/stderr, do not swallow output
  console.log(`\n${DIM}Running validator...${RESET}`);
  const validatorResult = spawnSync('node', [VALIDATOR, ROOT], {
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (validatorResult.stdout) {
    process.stdout.write(validatorResult.stdout);
  }
  if (validatorResult.stderr) {
    process.stderr.write(validatorResult.stderr);
  }

  const exitCode = validatorResult.status || 0;
  if (exitCode === 0) {
    console.log(`${GREEN}✓ Validator: healthy${RESET}`);
  } else if (exitCode === 1) {
    console.log(`${YELLOW}⚠ Validator: drifting (exit 1)${RESET}`);
  } else {
    console.log(`${RED}✗ Validator: repair required (exit ${exitCode})${RESET}`);
    process.exitCode = exitCode;
    return;
  }

  console.log(`\n${BOLD}${id} — ${title}${RESET} ${DIM}created${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}quick-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
