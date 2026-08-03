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

// Marker token a test prints on a line to flag a documented, gated stand-down
// (e.g. a canonical-repo-only check that skips on a mirror/adopter checkout).
// A passing test's stdout/stderr is suppressed by default (76 files, most
// chatty) EXCEPT for lines carrying this literal token — those are surfaced,
// indented, under the PASS line, and rolled into a "Stand-downs:" summary at
// the end. This keeps a documented gate stand-down visible in the aggregated
// (mirror) CI log instead of silently absent (T-588).
//
// RESERVED: line-initial-only (after optional leading whitespace) — see
// extractSkipLines() below, which matches via trimStart().startsWith(),
// not a substring search. A test's PASS-line description or any other
// prose must never START a line with this literal token; describe the
// stand-down mechanism in words instead. Mentioning it mid-line in prose
// is fine and will NOT match (T-596 — T-588 itself tripped this: its own
// test's PASS-line descriptions mentioned the token in prose, the
// pre-fix substring matcher matched the runner's own stdout, and the
// full suite reported a false stand-down).
const SKIP_TOKEN = '[SKIP]';

// Returns the lines of `text` that start with the literal SKIP_TOKEN
// (after stripping leading whitespace), in order. Anchored to
// line-initial rather than a bare substring search so a line that merely
// MENTIONS the token in prose (e.g. mid-sentence) is never mistaken for an
// actual stand-down emission. trimStart() (rather than a strict column-0
// startsWith) is required because at least one live emitter
// (test-validator-cross-section-status.js) indents the token with leading
// spaces.
function extractSkipLines(text) {
  if (!text) return [];
  return text.split('\n').filter((line) => line.trimStart().startsWith(SKIP_TOKEN));
}

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

// Hermetic identity env — makes every child test process refuse to derive a
// git commit identity from ambient machine/OS state (global/system config,
// gecos full name, etc). Without this, suite green depends on whichever
// identity happens to be configured on the machine running it (masked on
// macOS, where git synthesizes an identity from the OS user when config is
// silent; absent on bare ubuntu CI runners, which is what turned this
// class into a real outage). GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM point git
// at empty files instead of the real global/system config, and the
// GIT_CONFIG_COUNT/KEY_0/VALUE_0 triple injects `user.useConfigOnly=true`
// as if it were passed via `-c` on every git invocation — command-line `-c`
// counts as configuration for this key, so it forces git to refuse any
// derived identity rather than silently inventing one. A no-op config-only
// scrub (nulling global/system config alone) does NOT work: it is
// insufficient on any platform where git can derive an identity outside of
// config (verified — macOS synthesizes one from the OS user, so a
// config-only scrub is a no-op there and locally). Enforcement lives here,
// in the runner, rather than in ci.yml, so it covers local runs, CI, and
// adopter machines uniformly, and CI inherits it for free because CI runs
// `npm test`.
//
// Residual channels — verified, not hypothetical, so a future edit here
// does not accidentally "re-discover" them as bugs:
//   - GIT_AUTHOR_* / GIT_COMMITTER_* env vars OUTRANK user.useConfigOnly and
//     bypass this guard entirely; EMAIL does NOT bypass it (also verified —
//     stronger than expected, worth recording since it's the opposite of
//     GIT_AUTHOR_*/GIT_COMMITTER_*'s behavior).
//   - Running a single test file directly (`node scripts/test-X.js`, i.e.
//     not through this runner) bypasses this env entirely — the guard only
//     applies inside `npm test` / `node scripts/run-tests.js`.
//   - A per-test env object that overrides GIT_CONFIG_COUNT (even to the
//     same value, e.g. to add its own single `-c` entry for an unrelated
//     probe) silently exits this guard for that git invocation, because it
//     replaces rather than extends the GIT_CONFIG_COUNT/KEY_N/VALUE_N set.
//     scripts/test-publish-build.js Test 16a does exactly this for a
//     core.hooksPath probe, and is harmless today ONLY because that
//     probe's clone sets a local identity via config beforehand — any such
//     site MUST supply identity by other config means, since this failure
//     mode is silent (the guard just doesn't fire) rather than loud.
const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'user.useConfigOnly',
  GIT_CONFIG_VALUE_0: 'true',
};

function runOne(filePath) {
  const result = spawnSync(process.execPath, [filePath], {
    cwd: SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_GIT_ENV },
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
  const standDowns = [];
  for (const filePath of testFiles) {
    const r = runOne(filePath);
    results.push(r);
    if (r.passed) {
      console.log(`PASS  ${r.file}`);
      const skipLines = [...extractSkipLines(r.stdout), ...extractSkipLines(r.stderr)];
      if (skipLines.length > 0) {
        console.log(skipLines.map((l) => `      ${l}`).join('\n'));
        standDowns.push(r.file);
      }
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
  console.log(`Stand-downs: ${standDowns.length}${standDowns.length > 0 ? ` (${standDowns.join(', ')})` : ''}`);
  if (failedCount > 0) {
    console.log(`Failed: ${failedResults.map((r) => r.file).join(', ')}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main();
