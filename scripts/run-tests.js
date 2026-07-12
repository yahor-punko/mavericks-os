#!/usr/bin/env node
'use strict';
// Aggregate test runner — discovers and serially runs every scripts/test-*.js
// file, printing a per-file PASS/FAIL line and a final summary.
//
// Serial execution is required (not parallel): several test fixtures build
// scratch files/dirs in os.tmpdir() and at least one test asserts on tmpdir
// listings by prefix — running tests in parallel could cross-contaminate
// those fixtures.
//
// Usage:
//   node scripts/run-tests.js                 # run all scripts/test-*.js
//   node scripts/run-tests.js --filter <str>   # run only files whose
//                                               # basename contains <str>
//
// Exit code: 0 if all tests pass, non-zero if any test fails.
//
// Node built-ins only — no npm dependencies (see .claude/rules/scripts.md).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const SELF_BASENAME = path.basename(__filename);

function parseArgs(argv) {
  let filter = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--filter') {
      filter = argv[i + 1] || null;
      i++;
    }
  }
  return { filter };
}

function discoverTestFiles(filter) {
  const entries = fs.readdirSync(SCRIPTS_DIR);
  return entries
    .filter((name) => name.startsWith('test-') && name.endsWith('.js'))
    .filter((name) => name !== SELF_BASENAME)
    .filter((name) => (filter ? name.includes(filter) : true))
    .sort()
    .map((name) => path.join(SCRIPTS_DIR, name));
}

function runOne(filePath) {
  const result = spawnSync(process.execPath, [filePath], {
    cwd: SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const passed = result.status === 0 && !result.error;
  return {
    file: path.basename(filePath),
    passed,
    status: result.error ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function main() {
  const { filter } = parseArgs(process.argv.slice(2));
  const testFiles = discoverTestFiles(filter);

  if (testFiles.length === 0) {
    console.log(filter
      ? `No test files matched filter "${filter}".`
      : 'No test files found.');
    process.exitCode = filter ? 1 : 0;
    return;
  }

  console.log(`Running ${testFiles.length} test file(s)${filter ? ` (filter: "${filter}")` : ''}...\n`);

  const results = [];
  for (const filePath of testFiles) {
    const r = runOne(filePath);
    results.push(r);
    if (r.passed) {
      console.log(`PASS  ${r.file}`);
    } else {
      console.log(`FAIL  ${r.file} (exit ${r.status})`);
      if (r.stdout.trim()) {
        console.log(r.stdout.trim().split('\n').map((l) => `      ${l}`).join('\n'));
      }
      if (r.stderr.trim()) {
        console.log(r.stderr.trim().split('\n').map((l) => `      ${l}`).join('\n'));
      }
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedResults = results.filter((r) => !r.passed);
  const failedCount = failedResults.length;

  console.log('');
  console.log(`Summary: ${passedCount} passed, ${failedCount} failed (of ${results.length} total)`);
  if (failedCount > 0) {
    console.log(`Failed: ${failedResults.map((r) => r.file).join(', ')}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main();
