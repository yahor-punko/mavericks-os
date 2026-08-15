#!/usr/bin/env node

/**
 * mavp-operator-new-task.js
 *
 * Interactive task creation — appends to BACKLOG.md and TASK_STATUS.md atomically.
 * Auto-increments task ID from highest existing T-NNN.
 * Runs validator after write.
 *
 * Usage: ./scripts/mavp-operator --new-task
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
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
  buildTaskStatusEntry,
  printRepoIdentityHeader,
  guardMutatingRoot,
  resolveTaskOrigin,
  ARCHITECT_GATE_ADVISORY,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const VALIDATOR = path.join(
  process.env.MAVERICKS_SCRIPTS || path.join(require('node:os').homedir(), 'Documents', 'mavericks', 'scripts'),
  'mavp-validator.js'
);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function buildBacklogEntry(id, title, owner, repo, dependsOn, requiresUx, criteria, verificationType, origin) {
  return `\n### ${id} — ${title}
- **Status:** planned
- **Owner role:** ${owner}
- **Repo:** ${repo || 'TBD'}
- **Depends on:** ${dependsOn || '—'}
- **Requires ux:** ${requiresUx}
- **Acceptance criteria:** ${criteria || '[fill in]'}
- **Verification type:** ${verificationType}
- **Origin:** ${origin}
- **Evidence expected:** —
`;
}

async function prompt(rl, question, fallback) {
  return new Promise(resolve => {
    const q = fallback !== undefined ? `${question} [${fallback}]: ` : `${question}: `;
    rl.question(q, answer => resolve(answer.trim() || fallback || ''));
  });
}

/**
 * Parse CLI flags for non-interactive task creation: --title (required when
 * stdin is not a TTY), plus optional --owner, --repo, --depends-on,
 * --requires-ux, --criteria, --verification-type, --origin. Space-separated
 * value — matches the `--flag value` convention used by set-status.js /
 * apply-decomposition.js. Absent flags resolve to null so callers can
 * distinguish "not passed" from "passed blank".
 *
 * `--origin architect` attests that this task went through architect
 * decomposition despite being registered via --new-task; any other value
 * (or the flag being absent) resolves to Origin: manual (T-531) — see
 * resolveTaskOrigin() in mavp-operator-lib.js.
 *
 * @param {string[]} argv - process.argv.slice(2)
 */
function parseCliArgs(argv) {
  const flags = {
    title: null, owner: null, repo: null, dependsOn: null,
    requiresUx: null, criteria: null, verificationType: null, origin: null,
  };
  const map = {
    '--title': 'title',
    '--owner': 'owner',
    '--repo': 'repo',
    '--depends-on': 'dependsOn',
    '--requires-ux': 'requiresUx',
    '--criteria': 'criteria',
    '--verification-type': 'verificationType',
    '--origin': 'origin',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = map[argv[i]];
    if (key && i + 1 < argv.length) {
      flags[key] = argv[++i];
    }
  }
  return flags;
}

async function main() {
  const flags = parseCliArgs(process.argv.slice(2));
  const isTTY = !!process.stdin.isTTY;

  // Hard non-TTY guard — runs before any read/write. Title has no meaningful
  // default (a blank title cancels task creation), so it must be supplied
  // explicitly when stdin can't be prompted interactively.
  if (!isTTY && flags.title == null) {
    console.error(`${RED}new-task: stdin is not a TTY and required flag --title is missing.${RESET}`);
    console.error(`${DIM}Non-interactive usage: --new-task --title "<title>" [--owner <role>] [--repo <name>] [--depends-on <T-NNN>] [--requires-ux <y/n>] [--criteria "..."] [--verification-type <type>]${RESET}`);
    process.exitCode = 1;
    return;
  }

  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--new-task');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${BOLD}MavP New Task${RESET} ${DIM}${today}${RESET}\n`);

  if (!fs.existsSync(BACKLOG_MD) || !fs.existsSync(TASK_STATUS_MD)) {
    console.error(`${RED}BACKLOG.md or TASK_STATUS.md not found in ${ROOT}${RESET}`);
    process.exitCode = 1;
    return;
  }

  const backlog = readUtf8(BACKLOG_MD);
  const taskStatus = readUtf8(TASK_STATUS_MD);
  const id = getNextTaskId(BACKLOG_MD, TASK_STATUS_MD, PROCESS_STATE_JSON);

  console.log(`${CYAN}Next task ID: ${BOLD}${id}${RESET}\n`);

  let title, owner, repo, dependsOn, requiresUx, criteria, verificationType;

  if (flags.title != null) {
    // Non-interactive mode — works whether stdin is a TTY or not. Any flag
    // not passed falls back to the same default the interactive prompt uses.
    title = flags.title.trim();
    if (!title) {
      console.error(`${RED}--title must not be empty.${RESET}`);
      process.exitCode = 1;
      return;
    }
    owner = (flags.owner != null ? flags.owner.trim() : '') || 'developer';
    repo = (flags.repo != null ? flags.repo.trim() : '') || 'TBD';
    dependsOn = flags.dependsOn != null ? flags.dependsOn.trim() : '';
    requiresUx = flags.requiresUx != null && /^y/i.test(flags.requiresUx.trim()) ? 'true' : 'false';
    criteria = flags.criteria != null ? flags.criteria.trim() : '';
    verificationType = (flags.verificationType != null ? flags.verificationType.trim() : '') || 'artifact';
    console.log(`${DIM}Non-interactive mode — using --title and any other flags supplied (unset fields use defaults).${RESET}`);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    title = await prompt(rl, 'Title');
    if (!title) {
      console.log(`${DIM}Cancelled — title is required.${RESET}\n`);
      rl.close();
      return;
    }

    const ownerRaw = await prompt(rl, 'Owner (developer/qa/ux/orchestrator)', 'developer');
    owner = ownerRaw || 'developer';

    const repoRaw = await prompt(rl, 'Repo (e.g. mavericks, example-service, or leave blank)', '');
    repo = repoRaw || 'TBD';
    dependsOn = await prompt(rl, 'Depends on (T-NNN, or leave blank)', '');
    const requiresUxRaw = await prompt(rl, 'Requires UX review? (y/N)', 'n');
    requiresUx = /^y/i.test(requiresUxRaw) ? 'true' : 'false';
    criteria = await prompt(rl, 'Acceptance criteria (or leave blank)', '');
    const verificationTypeRaw = await prompt(rl, 'Verification type (artifact/runtime/visual/manual)', 'artifact');
    verificationType = verificationTypeRaw || 'artifact';

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
    const allTasks = parseTasksWithRepo(taskStatus, backlog);
    const pending = getDeployPendingForRepo(allTasks, repo, deployContours);
    if (pending.length > 0) {
      console.warn(`\n${YELLOW}⚠  Warning: ${pending.length} task(s) in ${repo} have pending deploys. Consider deploying before adding new tasks.${RESET}`);
      pending.forEach(t => console.warn(`   ${DIM}${t.id} — ${t.title}${RESET}`));
    }
  } catch (_) {
    // Non-fatal — continue regardless
  }

  const backlogEntry = buildBacklogEntry(id, title, owner, repo, dependsOn, requiresUx, criteria, verificationType, origin);
  const taskStatusEntry = buildTaskStatusEntry(id, title, owner, verificationType);

  const updatedBacklog = insertIntoActiveWave(backlog, backlogEntry);
  const updatedTaskStatus = insertIntoActiveTasks(taskStatus, taskStatusEntry);

  writeUtf8(BACKLOG_MD, updatedBacklog);
  console.log(`\n${GREEN}✓ BACKLOG.md — ${id} added${RESET}`);

  writeUtf8(TASK_STATUS_MD, updatedTaskStatus);
  console.log(`${GREEN}✓ TASK_STATUS.md — ${id} added${RESET}`);

  // Update last_task_id in PROCESS_STATE.json
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

  // Run validator
  try {
    execSync(`node "${VALIDATOR}" "${ROOT}"`, { stdio: 'pipe' });
    console.log(`${GREEN}✓ Validator passed${RESET}`);
  } catch (err) {
    const code = err.status;
    console.log(`${YELLOW}⚠ Validator exit ${code} — check artifacts${RESET}`);
  }

  console.log(`\n${BOLD}${id} — ${title}${RESET} ${DIM}(${owner}${requiresUx === 'true' ? ', requires UX' : ''})${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}new-task failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
