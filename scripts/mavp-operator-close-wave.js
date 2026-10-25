#!/usr/bin/env node
'use strict';

/**
 * mavp-operator-close-wave.js — T-820
 *
 * The ONLY path that advances the wave counter. --close-session closes a
 * SESSION (sweeps terminal tasks, commits) and never touches wave; a wave
 * advances only when its goal is met AND the operator confirms — never
 * inferred from "all tasks merged".
 *
 * Two confirmation paths, chosen by the same resolveMode() rule --close-session
 * uses (TTY or --interactive -> terminal path; otherwise agent path):
 *
 *   terminal  prints the wave goal / summary / suite receipt / git ahead-behind,
 *             then requires the operator to TYPE the wave number; any other
 *             answer aborts with nothing written.
 *   agent     requires --operator-confirmed "<the operator's exact statement>"
 *             (non-empty); optional --next-goal "text". No prompts, no push.
 *
 * Refusals (exit 1, PROCESS_STATE.json / BACKLOG.md / TASK_STATUS.md untouched):
 *   (a) agent path without --operator-confirmed (or with an empty value)
 *   (b) any entry remaining in TASK_STATUS.md's Active tasks section
 *   (c) wave_goal null while the wave is not listed in parked_waves
 *   (d) validator exit 2 (the T-438 contract)
 * Gates (b)-(d) apply to both paths.
 *
 * There is deliberately no second state-writer here: the mutation is the
 * close-session module's exported updateProcessStateJson() plus the lib's
 * archiveActiveWaveInBacklog()/generateProcessStateMd().
 *
 * Usage:
 *   ./scripts/mavp-operator --close-wave                      (terminal path)
 *   ./scripts/mavp-operator --close-wave --interactive        (force terminal path)
 *   ./scripts/mavp-operator --close-wave --operator-confirmed "<statement>" [--next-goal "text"]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, spawnSync } = require('node:child_process');

const {
  updateProcessStateJson,
  buildAutoSummary,
  runValidator,
  buildSuiteReceiptLine,
  parseActiveTasks,
  resolveMode,
  CI_CHECK_POST_PUSH_LINE,
  CI_CHECK_REMINDER_SUFFIX,
} = require('./mavp-operator-close-session.js');

const {
  archiveActiveWaveInBacklog,
  parseActiveWaveMergedTitles,
  generateProcessStateMd,
  guardMutatingRoot,
  printRepoIdentityHeader,
} = require('./mavp-operator-lib.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const TERMINAL_CONFIRMATION_LABEL = 'typed at terminal';

// Refusal (a): the exact wording is part of the contract (acceptance criteria
// of T-820) — it tells an agent precisely when the flag may be used.
const OPERATOR_CONFIRMATION_REQUIRED_MESSAGE =
  '--close-wave needs operator confirmation. At a terminal: run ./scripts/mavp-operator --close-wave yourself and type the wave number. ' +
  'From an agent session: pass --operator-confirmed "<the operator\'s exact statement from this session>" — only on an explicit operator statement ' +
  'that the wave\'s goal is met; never inferred from "all tasks merged".';

function parseArgs(argv) {
  const args = {
    interactive: false,
    nonInteractive: false,
    operatorConfirmedPresent: false,
    operatorConfirmed: '',
    nextGoal: undefined,
  };
  // A value is the next token unless it is missing or looks like another flag —
  // `--operator-confirmed --next-goal x` must read as an EMPTY statement.
  const valueAfter = (i) => (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--') ? String(argv[i + 1]) : '');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interactive') {
      args.interactive = true;
    } else if (argv[i] === '--non-interactive') {
      args.nonInteractive = true;
    } else if (argv[i] === '--operator-confirmed') {
      args.operatorConfirmedPresent = true;
      args.operatorConfirmed = valueAfter(i);
      if (args.operatorConfirmed !== '') i++;
    } else if (argv[i] === '--next-goal') {
      const v = valueAfter(i);
      if (v !== '') { args.nextGoal = v; i++; }
    }
  }
  return args;
}

function refuse(lines) {
  for (const line of [].concat(lines)) console.error(line);
  process.exitCode = 1;
}

/** One-line, trailer-safe form of a free-text value (no newlines). */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Find the parked_waves entry (a "Wave N — reason" string) for wave N, or null.
 * Returns { reason } — the text after the first dash separator, or the whole
 * entry when it carries none.
 */
function findParkedEntry(parkedWaves, waveNumber) {
  if (!Array.isArray(parkedWaves)) return null;
  const re = new RegExp(`^\\s*Wave\\s+${waveNumber}\\b`, 'i');
  for (const entry of parkedWaves) {
    const text = typeof entry === 'string' ? entry : '';
    if (re.test(text)) {
      const m = text.match(/^\s*Wave\s+\d+\s*[—–-]+\s*(.*)$/i);
      return { reason: m && m[1].trim() ? m[1].trim() : text.trim() };
    }
  }
  return null;
}

function gitSyncLine() {
  const r = spawnSync('git', ['-C', ROOT, 'status', '-sb'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split(/\r?\n/)[0];
  return first ? first.replace(/^##\s*/, '') : null;
}

function tryGitPush() {
  try {
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask one question on a shared readline interface. Resolves null when the
 * input closes first (EOF on a piped stdin) so an unanswered confirmation is a
 * clean abort instead of a silent process exit.
 */
function makeAsker(rl) {
  let closed = false;
  rl.on('close', () => { closed = true; });
  return (question) => new Promise((resolve) => {
    if (closed) { resolve(null); return; }
    const onClose = () => resolve(null);
    rl.once('close', onClose);
    rl.question(question, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

async function main() {
  printRepoIdentityHeader(ROOT, { mutating: true });

  const rootGuard = guardMutatingRoot(ROOT, '--close-wave');
  if (rootGuard.blocked) {
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const mode = resolveMode({ interactive: args.interactive, nonInteractive: args.nonInteractive, isTTY: process.stdin.isTTY });
  const terminalPath = mode === 'interactive';
  const statement = oneLine(args.operatorConfirmed);

  // Refusal (a) — agent path needs the operator's statement. Checked before
  // anything is read so nothing can be written on this path.
  if (!terminalPath && statement === '') {
    refuse(OPERATOR_CONFIRMATION_REQUIRED_MESSAGE);
    return;
  }

  let ps = {};
  try {
    ps = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
  } catch (e) {
    refuse(`--close-wave refused — cannot read PROCESS_STATE.json (${e.message}); nothing was changed.`);
    return;
  }
  const waveN = Number(ps.wave) || 1;

  // Refusal (b) — Active tasks must be empty; --close-session is the sweep.
  const taskStatusContent = fs.existsSync(TASK_STATUS_MD) ? fs.readFileSync(TASK_STATUS_MD, 'utf8') : '';
  const remaining = parseActiveTasks(taskStatusContent);
  if (remaining.length > 0) {
    refuse([
      `--close-wave refused — wave ${waveN} still has entries in TASK_STATUS.md's Active tasks:`,
      ...remaining.map((t) => `  ${t.id} still ${t.status}`),
      'Sweep finished work out of Active tasks with --close-session, then re-run --close-wave. Nothing was changed.',
    ]);
    return;
  }

  // Refusal (c) — a goal must exist unless the wave is parked (parked waves
  // waive the goal requirement).
  const goalText = typeof ps.wave_goal === 'string' && ps.wave_goal.trim() !== '' ? ps.wave_goal : null;
  const parked = findParkedEntry(ps.parked_waves, waveN);
  if (goalText === null && !parked) {
    refuse([
      `--close-wave refused — wave ${waveN} has no wave_goal and is not listed in parked_waves, so there is nothing to confirm as met.`,
      'Record the goal with --set-wave-goal "<goal>" first, then re-run --close-wave. Nothing was changed.',
    ]);
    return;
  }

  // Refusal (d) — the T-438 contract: validator exit 2 blocks, with no mutation.
  const validatorResult = runValidator();
  if (validatorResult.code === 2) {
    refuse([
      `--close-wave refused — validator exit 2 (repair required); nothing was changed.`,
      String(validatorResult.output || '').trim(),
    ].filter(Boolean));
    return;
  }

  const backlogBefore = fs.existsSync(BACKLOG_MD) ? fs.readFileSync(BACKLOG_MD, 'utf8') : '';
  const mergedTitles = parseActiveWaveMergedTitles(backlogBefore, waveN);
  const autoSummary = buildAutoSummary(waveN, mergedTitles);
  const goalForTrailer = goalText !== null ? goalText : `parked — ${parked.reason}`;

  let nextGoal = args.nextGoal;
  let confirmationLabel = statement;
  let rl = null;
  let ask = null;

  if (terminalPath) {
    console.log(`\n${BOLD}MavP Close Wave${RESET}\n`);
    console.log(goalText !== null ? `Wave ${waveN} goal: ${goalText}` : `Wave ${waveN} is parked — ${parked.reason}`);
    console.log(autoSummary);
    const receipt = buildSuiteReceiptLine(ROOT);
    if (receipt) console.log(receipt);
    const sync = gitSyncLine();
    if (sync) console.log(`${DIM}git: ${sync}${RESET}`);
    console.log('');

    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask = makeAsker(rl);
    const typed = await ask(`Type the wave number (${waveN}) to confirm its goal is met and close it: `);
    if (typed === null || typed.trim() !== String(waveN)) {
      if (rl) rl.close();
      console.log(`\nAborted — wave number not confirmed; nothing was changed.`);
      process.exitCode = 1;
      return;
    }
    const goalAnswer = await ask(`Goal for wave ${waveN + 1} (Enter to leave unset): `);
    const trimmed = goalAnswer === null ? '' : goalAnswer.trim();
    nextGoal = trimmed ? trimmed : undefined;
    confirmationLabel = TERMINAL_CONFIRMATION_LABEL;
  }

  // --- mutation (confirmation obtained; every gate passed) ------------------
  // Archive the Active Wave heading FIRST: the lib helper writes nothing when
  // it refuses (multiple Active Wave headings), so a refusal here still leaves
  // PROCESS_STATE.json untouched.
  const archiveResult = archiveActiveWaveInBacklog(BACKLOG_MD, waveN);
  if (!archiveResult.ok) {
    if (rl) rl.close();
    refuse([`--close-wave refused — BACKLOG.md wave archive failed; nothing was changed:`, archiveResult.warning]);
    return;
  }
  if (archiveResult.archived) {
    console.log(`${GREEN}✓ BACKLOG.md — Wave ${waveN} heading archived${RESET}`);
  } else if (archiveResult.warning) {
    console.log(`${YELLOW}⚠ ${archiveResult.warning}${RESET}`);
  }

  const { wave: newWave } = updateProcessStateJson(null, true, nextGoal, { waveSummary: autoSummary });
  console.log(`${GREEN}✓ PROCESS_STATE.json updated — wave → ${newWave}${RESET}`);
  generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);
  console.log(`${GREEN}✓ PROCESS_STATE.md regenerated from JSON${RESET}`);
  console.log(`  ${DIM}wave_summary written: ${autoSummary}${RESET}`);

  // Commit: subject `chore: close wave N`, trailers in the final paragraph.
  let closeHash = null;
  const subject = `chore: close wave ${waveN}`;
  const trailers = `Operator-Confirmed: ${confirmationLabel}\nWave-Goal: ${oneLine(goalForTrailer)}`;
  const addRes = spawnSync('git', ['-C', ROOT, 'add', '-u'], { encoding: 'utf8' });
  const commitRes = addRes.status === 0
    ? spawnSync('git', ['-C', ROOT, 'commit', '-m', subject, '-m', trailers], { encoding: 'utf8' })
    : addRes;
  if (commitRes.status === 0) {
    console.log(`${GREEN}✓ Wave close committed${RESET}`);
    const head = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    if (head.status === 0) closeHash = head.stdout.trim();
  } else {
    const msg = `${commitRes.stdout || ''}${commitRes.stderr || ''}`.trim();
    console.log(`${YELLOW}⚠ git commit failed: ${msg}${RESET}`);
    process.exitCode = 1;
  }

  // The EXECUTION_LOG.md line the Main Agent pastes. Deliberately avoids the
  // literal evidence-key form (the key, a colon and a hash) — a bare hash only.
  if (closeHash) {
    console.log(`\n${BOLD}EXECUTION_LOG line:${RESET}`);
    console.log(`wave close: W${waveN} → W${newWave} — goal: "${oneLine(goalForTrailer)}" — operator-confirmed: "${confirmationLabel}" — close commit ${closeHash}`);
  }

  if (terminalPath) {
    const suiteReceiptLine = buildSuiteReceiptLine(ROOT);
    if (suiteReceiptLine) console.log(`\n${suiteReceiptLine}`);
    const pushAnswer = await ask('Run git push? [Y/n]: ');
    rl.close();
    if (pushAnswer !== null && pushAnswer.trim().toLowerCase() !== 'n') {
      console.log('');
      if (tryGitPush()) {
        console.log(`${GREEN}✓ Pushed${RESET}`);
        console.log(CI_CHECK_POST_PUSH_LINE);
      } else {
        console.log(`${YELLOW}⚠ Push failed or skipped — push manually if needed${RESET}`);
      }
    } else {
      console.log(`${DIM}Push skipped — remember to push the wave close${RESET}`);
    }
  } else {
    console.log(`\n${CYAN}${BOLD}Run \`git push\` to publish the wave close${RESET}${CI_CHECK_REMINDER_SUFFIX}`);
    const suiteReceiptLine = buildSuiteReceiptLine(ROOT);
    if (suiteReceiptLine) console.log(suiteReceiptLine);
  }

  console.log(`\n${BOLD}Wave ${waveN} closed — wave ${newWave} open${RESET}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`close-wave failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { OPERATOR_CONFIRMATION_REQUIRED_MESSAGE, parseArgs, findParkedEntry, TERMINAL_CONFIRMATION_LABEL };
