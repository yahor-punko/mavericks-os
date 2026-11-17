'use strict';
// mavp-corpus-guard: always-run
// Corpus-wide guard: run-tests.js appends this to every --filter run (.claude/rules/scripts.md).
// mavp-declared-in: .claude/rules/scripts.md :: Wrapper flag parity
// Regression test: T-917 — every script the operator wrapper dispatches must
// handle --help itself, before any read or write, when it is run DIRECTLY with
// node (the wrapper's own help-anywhere handling, T-909, does not apply to a
// direct `node scripts/<script>.js ...` invocation).
//
// Problem this guards against: the three setter scripts took argv[2] as a value,
// so `node scripts/mavp-operator-set-next-action.js --help` wrote the literal
// text --help into PROCESS_STATE.json's next_action; scripts with no argument
// parsing (close-session, handoff, sync-status, ...) ran their whole ritual.
// Each script now calls handleHelpFlag() from mavp-operator-lib.js as its first
// statement.
//
// The script set is NOT hand-listed: it is extracted from the canonical wrapper
// scripts/mavp-operator's own dispatch table (every `node "$SCRIPT_DIR/<file>"`
// line), so a newly dispatched script that skips the call fails here.
//
// Contract asserted for each dispatched script, run as a child process with
// cwd and MAVERICKS_PROJECT_ROOT both pointing at a throwaway git fixture, for
// `--help` alone and for `sample-value --help` (help in a non-first position):
//   (a) exit 0;
//   (b) stdout is a usage text naming the script's own wrapper flag (or, for
//       the installer-style scripts, its file name), and no two scripts print
//       the same text;
//   (c) the fixture working tree is byte-identical, HEAD is unchanged and
//       `git status --porcelain` stays empty;
//   (d) the scratch HOME stays empty (the feedback inbox lives under HOME).
// Named case: set-next-action --help leaves next_action unchanged.
// Source check: each script references handleHelpFlag, except a named
// exception whose own handler is covered behaviourally by (a)-(d) above.
//
// Hermetic: MAVERICKS_HOME, MAVERICKS_PROJECT_ROOT and HOME are pinned in every
// spawn env. Plain node, no npm deps. Spawns run concurrently to keep this
// always-run guard inside its ~3 second budget. Exit 0 = pass.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.join(SCRIPTS_DIR, '..');
const CANONICAL_WRAPPER = path.join(SCRIPTS_DIR, 'mavp-operator');
const HELPER_NAME = 'handleHelpFlag';
const SPAWN_TIMEOUT_MS = 30000;
const CONCURRENCY = 8;

// Scripts that keep their own, earlier --help handler instead of the shared
// helper. The installer's handler is the first statement of its main() (T-918)
// and is covered behaviourally here and by test-install-help-no-side-effects.js.
const OWN_HANDLER_SCRIPTS = new Map([
  ['mavp-install.js', 'T-918 handler is the first statement of main(); covered by the behavioural cases'],
]);

// ---------------------------------------------------------------------------
// Dispatch table extraction (script file -> wrapper flags that reach it)
// ---------------------------------------------------------------------------
function extractDispatchTable(wrapperSource) {
  const table = new Map();
  const lines = wrapperSource.split('\n');
  let currentFlags = [];
  for (const line of lines) {
    if (/^(el)?if \[\[/.test(line)) {
      currentFlags = [];
      const re = /==\s*"(--[A-Za-z0-9-]+)"/g;
      let m;
      while ((m = re.exec(line)) !== null) currentFlags.push(m[1]);
    }
    const sm = /node\s+"\$SCRIPT_DIR\/([A-Za-z0-9._-]+\.js)"/.exec(line);
    if (sm) {
      const flags = table.get(sm[1]) || new Set();
      for (const f of currentFlags) flags.add(f);
      table.set(sm[1], flags);
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t917-'));
const fixtureDir = path.join(scratchRoot, 'fixture');
const homeDir = path.join(scratchRoot, 'home');
fs.mkdirSync(fixtureDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function git(args) {
  return execFileSync('git', args, { cwd: fixtureDir, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const NEXT_ACTION_SENTINEL = 'T-1 sentinel next action that must survive --help';
fs.writeFileSync(
  path.join(fixtureDir, 'PROCESS_STATE.json'),
  JSON.stringify({ wave: 1, initiative: 'fixture', wave_goal: 'sentinel goal', next_action: NEXT_ACTION_SENTINEL, wave_strategy_note: 'sentinel note', active_slices: [], last_updated: '2026-01-01' }, null, 2) + '\n'
);
fs.writeFileSync(
  path.join(fixtureDir, 'BACKLOG.md'),
  '# Backlog\n\n## Active Wave\n\nNo tasks.\n\n## Deferred Tasks\n\nNone.\n'
);
fs.writeFileSync(
  path.join(fixtureDir, 'TASK_STATUS.md'),
  '# Task Status\n\n## Active tasks\n\nNone.\n'
);
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
const HEAD_BEFORE = git(['rev-parse', 'HEAD']).trim();

function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, 'dir');
        walk(full);
      } else {
        out.set(rel, fs.readFileSync(full).toString('base64'));
      }
    }
  };
  walk(root);
  return out;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [k, v] of before) if (!after.has(k)) changes.push(`removed ${k}`); else if (after.get(k) !== v) changes.push(`modified ${k}`);
  for (const k of after.keys()) if (!before.has(k)) changes.push(`added ${k}`);
  return changes;
}

const TREE_BEFORE = snapshotTree(fixtureDir);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        MAVERICKS_HOME: REPO_ROOT,
        MAVERICKS_PROJECT_ROOT: fixtureDir,
        HOME: homeDir,
        NO_COLOR: '1',
        ...Object.fromEntries(Object.entries(GIT_ENV).filter(([k]) => k.startsWith('GIT_'))),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ script, args, status, signal, stdout, stderr });
    });
  });
}

async function runAll(jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await runScript(jobs[i].script, jobs[i].args);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function main() {
  const table = extractDispatchTable(fs.readFileSync(CANONICAL_WRAPPER, 'utf8'));
  const scripts = [...table.keys()].sort();

  // Guard the extraction itself: a regex that silently matched nothing would
  // make every later assertion vacuous.
  assert.ok(scripts.length >= 30, `dispatch table extraction found only ${scripts.length} scripts`);
  for (const must of ['mavp-operator-set-next-action.js', 'mavp-operator-close-session.js', 'mavp-validator.js', 'mavp-install.js', 'mavp-skill-reflect.js', 'mavp-operator-dashboard.js']) {
    assert.ok(table.has(must), `dispatch table extraction lost ${must}`);
  }

  const failures = [];
  const fail = (msg) => failures.push(msg);

  // Source check.
  for (const script of scripts) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8');
    if (OWN_HANDLER_SCRIPTS.has(script)) continue;
    if (!src.includes(`${HELPER_NAME}(`)) fail(`${script}: dispatched by the wrapper but never calls ${HELPER_NAME}()`);
  }
  const lib = require('./mavp-operator-lib.js');
  if (typeof lib[HELPER_NAME] !== 'function') fail(`mavp-operator-lib.js does not export ${HELPER_NAME}`);

  // Named case, run alone and first so its outcome cannot be masked by the
  // concurrent batch below: set-next-action --help must leave next_action as is
  // (the pre-change script stored the literal text --help).
  const named = await runScript('mavp-operator-set-next-action.js', ['--help']);
  const namedState = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'PROCESS_STATE.json'), 'utf8'));
  if (named.status !== 0) fail(`named case: set-next-action --help exited ${named.status}`);
  if (namedState.next_action !== NEXT_ACTION_SENTINEL) {
    fail(`named case: set-next-action --help changed next_action to ${JSON.stringify(namedState.next_action)}`);
  }

  // Behavioural cases.
  const ARG_SHAPES = [['--help'], ['sample-value', '--help']];
  const jobs = [];
  for (const script of scripts) for (const args of ARG_SHAPES) jobs.push({ script, args });
  const results = await runAll(jobs);

  const stdoutByScript = new Map();
  for (const r of results) {
    const label = `${r.script} ${r.args.join(' ')}`;
    if (r.status !== 0) {
      fail(`${label}: expected exit 0, got status=${r.status} signal=${r.signal} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
      continue;
    }
    if (!/usage/i.test(r.stdout)) fail(`${label}: stdout is not a usage text: ${JSON.stringify(r.stdout.slice(0, 200))}`);
    const flags = [...table.get(r.script)];
    const names = flags.length ? flags : [r.script];
    const ownName = names.concat(r.script).some((n) => r.stdout.includes(n));
    if (!ownName) fail(`${label}: usage names neither ${names.join('/')} nor the script file`);
    if (r.args.length === 1) {
      if (stdoutByScript.has(r.stdout) && stdoutByScript.get(r.stdout) !== r.script) {
        fail(`${r.script}: usage text is identical to ${stdoutByScript.get(r.stdout)}'s`);
      }
      stdoutByScript.set(r.stdout, r.script);
    }
  }

  // Fixture integrity after every run.
  const changes = diffSnapshots(TREE_BEFORE, snapshotTree(fixtureDir));
  if (changes.length) fail(`fixture working tree changed: ${changes.join(', ')}`);
  const headAfter = git(['rev-parse', 'HEAD']).trim();
  if (headAfter !== HEAD_BEFORE) fail(`fixture HEAD moved: ${HEAD_BEFORE} -> ${headAfter}`);
  const porcelain = git(['status', '--porcelain']).trim();
  if (porcelain !== '') fail(`fixture git status not clean: ${porcelain}`);
  const homeEntries = fs.readdirSync(homeDir);
  if (homeEntries.length) fail(`scratch HOME gained entries: ${homeEntries.join(', ')}`);

  // Named case: set-next-action --help leaves next_action unchanged.
  const state = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'PROCESS_STATE.json'), 'utf8'));
  if (state.next_action !== NEXT_ACTION_SENTINEL) fail(`next_action changed to ${JSON.stringify(state.next_action)}`);

  fs.rmSync(scratchRoot, { recursive: true, force: true });

  if (failures.length) {
    console.error(`FAIL: test-script-help-no-side-effects (${failures.length} problem(s))`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASS: test-script-help-no-side-effects (${scripts.length} dispatched scripts x ${ARG_SHAPES.length} argument shapes)`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
