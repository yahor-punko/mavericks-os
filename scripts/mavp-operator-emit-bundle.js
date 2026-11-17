#!/usr/bin/env node
'use strict';

/**
 * mavp-operator-emit-bundle.js
 *
 * Read-only reporting surface (T-402): prints a task's context prefetch
 * bundle to stdout WITHOUT writing anything to disk. Unlike
 * writeContextBundle() (used at task registration/update time to persist
 * .mavp/context/T-NNN.md), this script calls buildContextBundle() directly
 * and only prints the result — .mavp/context/ mtimes are never touched.
 *
 * Usage: ./scripts/mavp-operator --emit-bundle T-NNN
 *
 * Exit codes:
 *   0 — bundle printed to stdout
 *   1 — missing/invalid argument, or task ID not found in BACKLOG.md/TASK_STATUS.md
 */

const { buildContextBundle, handleHelpFlag } = require('./mavp-operator-lib.js');

function printUsage() {
  console.error('Usage: mavp-operator --emit-bundle T-NNN');
  console.error('');
  console.error('  T-NNN   Task ID to build a context bundle for (read-only; prints to stdout)');
}

function main() {
  // T-917: help first, before the task-id check and any artifact read.
  if (handleHelpFlag([
    'Usage: ./scripts/mavp-operator --emit-bundle T-NNN',
    '',
    'Prints the context prefetch bundle of task T-NNN to stdout. Read-only: writes nothing to disk.',
    '--help prints this text and exits 0 before reading any project state.',
  ])) return;

  const taskId = process.argv[2];

  if (!taskId || !/^T-\d+$/.test(taskId)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const bundle = buildContextBundle(taskId);

  if (bundle == null) {
    process.stderr.write(`Task not found: ${taskId} (not present in BACKLOG.md or TASK_STATUS.md)\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(bundle);
}

main();
