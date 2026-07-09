#!/usr/bin/env node

/**
 * mavp-operator-handoff.js
 *
 * Produces a single-use HANDOFF.md context file at the repo root for
 * cross-session continuity.
 *
 * Usage:
 *   ./scripts/mavp-operator --handoff
 *   ./scripts/mavp-operator --handoff --notes "text to append as Operator notes"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, collectOperatorData } = require('./mavp-operator-lib');

const HANDOFF_PATH = path.join(ROOT, 'HANDOFF.md');
const EXECUTION_LOG_PATH = path.join(ROOT, 'EXECUTION_LOG.md');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { notes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--notes' && argv[i + 1]) {
      args.notes = argv[++i];
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Git helpers — fail gracefully
// ---------------------------------------------------------------------------

function runGit(gitArgs) {
  try {
    const result = spawnSync('git', gitArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout.trimEnd();
  } catch {
    return null;
  }
}

function getGitLog() {
  const output = runGit(['log', '--oneline', '-10']);
  return output !== null ? output || 'none' : 'unavailable';
}

function getGitDiffStat() {
  const output = runGit(['diff', '--stat', 'HEAD']);
  return output !== null ? output || 'none' : 'unavailable';
}

// ---------------------------------------------------------------------------
// EXECUTION_LOG tail
// ---------------------------------------------------------------------------

function getExecutionLogTail(lines = 40) {
  try {
    if (!fs.existsSync(EXECUTION_LOG_PATH)) {
      return 'none';
    }
    const content = fs.readFileSync(EXECUTION_LOG_PATH, 'utf8');
    const allLines = content.split(/\r?\n/);
    const tail = allLines.slice(-lines);
    const result = tail.join('\n').trim();
    return result || 'none';
  } catch {
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

function formatTimestamp() {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${isoDate} ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Build HANDOFF.md content
// ---------------------------------------------------------------------------

function buildHandoff(data, notes) {
  const { workflow_state: workflow } = data;

  const timestamp = formatTimestamp();

  const taskLine = workflow.active_task && workflow.active_task !== 'none'
    ? workflow.active_task
    : 'none';

  const blockerValue = workflow.blockers && workflow.blockers.length > 0
    ? workflow.blockers.join(', ')
    : 'none';

  const gitLog = getGitLog();
  const diffStat = getGitDiffStat();
  const executionLogTail = getExecutionLogTail(40);

  const sections = [
    `# MavP Handoff — ${timestamp}`,
    '',
    '## Active task context',
    `- Task: ${taskLine}`,
    `- Status: ${workflow.task_status || 'unknown'}`,
    `- Owner: ${workflow.owner || 'unknown'}`,
    `- Wave: ${workflow.wave != null ? workflow.wave : 'unknown'} (${workflow.wave_status || 'unknown'})`,
    `- Next action: ${workflow.next_action || 'none'}`,
    `- Blockers: ${blockerValue}`,
    '',
    '## Recent git changes',
    gitLog,
    '',
    '## Changed files (since last commit)',
    diffStat,
    '',
    '## EXECUTION_LOG tail (last 40 lines)',
    executionLogTail,
  ];

  if (notes !== null) {
    sections.push('');
    sections.push('## Operator notes');
    sections.push(notes);
  }

  // Ensure file ends with a single newline
  return sections.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (fs.existsSync(HANDOFF_PATH)) {
    console.log('Warning: HANDOFF.md already exists — overwriting.');
  }

  const data = collectOperatorData();
  const content = buildHandoff(data, args.notes);

  fs.writeFileSync(HANDOFF_PATH, content, 'utf8');
  console.log(`HANDOFF.md written to ${HANDOFF_PATH}`);
}

main();
