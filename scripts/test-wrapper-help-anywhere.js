'use strict';
// Regression test: T-909 — both operator wrappers (the canonical
// scripts/mavp-operator and the adopter wrapper produced by buildBashWrapper()
// in mavp-install.js) must print the wrapper help and dispatch NOTHING when
// any argument is --help, not only when it is the first one. The exceptions
// are --agent and --snapshot in first position: those keep their own dispatch.
// --install is deliberately NOT exempt: the installer has no --help handler
// and bootstraps the current directory, so --install --help must print the
// wrapper help and leave an empty directory empty.
//
// Before the fix only a first-position --help was handled. Every other
// position was forwarded to the flag's script as a value or silently dropped,
// so `--set-next-action --help` wrote "--help" into next_action,
// `--close-session --help` ran the whole ritual and committed, and
// `--reflect-skill developer --help` started a paid reflection run (the
// wrapper forwards only the role).
//
// The flag set is NOT hand-listed: it is extracted from each wrapper's own
// dispatch text (the same comparison shape test-wrapper-flag-parity.js reads),
// so a flag added later is covered automatically. "Dispatches nothing" is
// proven two ways: a PATH shim named node logs every node invocation the
// wrapper makes (none may appear), and the fixture project is compared
// byte-for-byte, plus HEAD and `git status --porcelain`, before and after.
//
// Hermetic: every spawn pins MAVERICKS_HOME to the checkout under test, uses
// a scratch HOME (so a pre-fix --feedback run cannot touch the real inbox)
// and a fixed git identity. The installer is run only to obtain the adopter
// wrapper and fixture files, with --stale-source-ok.
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const FRAMEWORK_SCRIPTS = __dirname;
const FRAMEWORK_ROOT = path.join(FRAMEWORK_SCRIPTS, '..');
const CANONICAL_WRAPPER = path.join(FRAMEWORK_SCRIPTS, 'mavp-operator');
const INSTALL_SCRIPT = path.join(FRAMEWORK_SCRIPTS, 'mavp-install.js');
const { buildBashWrapper } = require('./mavp-install.js');

// Flags whose first-position --help keeps its own dispatch (T-909).
const OWN_HELP_FLAGS = new Set(['--agent', '--snapshot']);
// --help itself is the subject, not a flag under test.
const SKIP_FLAGS = new Set(['--help']);
const SAMPLE_VALUE = 'sample-value';
const SPAWN_TIMEOUT_MS = 60000;

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-wrapper-help-anywhere-'));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Same comparison shape the dispatch chain uses in both wrappers.
function extractDispatchedFlags(bashSource) {
  const re = /\$\{1-\}"\s*==\s*"(--[A-Za-z0-9-]+)"/g;
  const flags = new Set();
  let m;
  while ((m = re.exec(bashSource)) !== null) flags.add(m[1]);
  return flags;
}

// node shim: logs each invocation's argv to NODE_SHIM_LOG then execs real node.
const shimDir = path.join(scratchRoot, 'shim-bin');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(
  path.join(shimDir, 'node'),
  '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NODE_SHIM_LOG"\nexec "$REAL_NODE" "$@"\n',
  { mode: 0o755 }
);
const scratchHome = path.join(scratchRoot, 'home');
fs.mkdirSync(scratchHome, { recursive: true });

// Build the template fixture once: installer run (adopter wrapper + project
// artifacts), then a git history. Each case runs against a fresh copy.
const templateDir = path.join(scratchRoot, 'template');
fs.mkdirSync(templateDir, { recursive: true });
execFileSync('node', [INSTALL_SCRIPT, templateDir, '--yes', '--stale-source-ok'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MAVERICKS_HOME: FRAMEWORK_ROOT, HOME: scratchHome },
});
const adopterWrapperRel = path.join('scripts', 'mavp-operator');
assert.ok(fs.existsSync(path.join(templateDir, adopterWrapperRel)), 'FAIL: install did not create the adopter wrapper');
// The installed wrapper must be byte-identical to what buildBashWrapper() emits.
assert.strictEqual(
  fs.readFileSync(path.join(templateDir, adopterWrapperRel), 'utf8'),
  buildBashWrapper(path.join(FRAMEWORK_ROOT)),
  'FAIL: installed adopter wrapper differs from buildBashWrapper() output'
);
// A known next_action so "unchanged" is a real comparison.
const psPath = path.join(templateDir, 'PROCESS_STATE.json');
const ps = JSON.parse(fs.readFileSync(psPath, 'utf8'));
ps.next_action = 'T-001 fixture next action';
fs.writeFileSync(psPath, JSON.stringify(ps, null, 2) + '\n');
git(templateDir, ['init', '-b', 'main', '-q']);
git(templateDir, ['add', '-A']);
git(templateDir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--no-verify', '-q', '-m', 'fixture baseline']);

function hashTree(root) {
  const out = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  })(root);
  return out;
}

function snapshotState(root) {
  return {
    files: hashTree(root),
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    status: git(root, ['status', '--porcelain']),
  };
}

let caseCounter = 0;
function runCase(wrapperKind, args, opts = {}) {
  const dir = path.join(scratchRoot, `case-${caseCounter++}`);
  fs.cpSync(templateDir, dir, { recursive: true });
  const shimLog = path.join(scratchRoot, `shim-${caseCounter}.log`);
  const wrapper = wrapperKind === 'canonical' ? CANONICAL_WRAPPER : path.join(dir, adopterWrapperRel);
  const before = snapshotState(dir);
  const res = spawnSync(wrapper, args, {
    cwd: opts.cwd || dir,
    encoding: 'utf8',
    input: '',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: shimDir + path.delimiter + process.env.PATH,
      NODE_SHIM_LOG: shimLog,
      REAL_NODE: process.execPath,
      MAVERICKS_HOME: FRAMEWORK_ROOT,
      MAVERICKS_PROJECT_ROOT: dir,
      HOME: scratchHome,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  });
  const after = snapshotState(dir);
  const nodeCalls = fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').split('\n').filter(Boolean) : [];
  return { dir, before, after, nodeCalls, code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', timedOut: res.error && res.error.code === 'ETIMEDOUT' };
}

function describeChange(before, after) {
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changed = [...names].filter((n) => before.files[n] !== after.files[n]);
  return `changed files: [${changed.join(', ')}]; HEAD ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}; status before=${JSON.stringify(before.status)} after=${JSON.stringify(after.status)}`;
}

function assertHelpOnly(label, r) {
  assert.ok(!r.timedOut, `FAIL (${label}): timed out — the flag was dispatched instead of printing help`);
  assert.strictEqual(r.code, 0, `FAIL (${label}): exit ${r.code}, expected 0. stderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('Usage: ./scripts/mavp-operator [flag]') && r.stdout.includes('Flags:'), `FAIL (${label}): wrapper help was not printed. stdout:\n${r.stdout.slice(0, 300)}`);
  assert.deepStrictEqual(r.nodeCalls, [], `FAIL (${label}): the wrapper invoked node (dispatched a script): ${JSON.stringify(r.nodeCalls)}`);
  assert.deepStrictEqual(r.after.files, r.before.files, `FAIL (${label}): fixture files changed — ${describeChange(r.before, r.after)}`);
  assert.strictEqual(r.after.head, r.before.head, `FAIL (${label}): HEAD moved — ${describeChange(r.before, r.after)}`);
  assert.strictEqual(r.after.status, r.before.status, `FAIL (${label}): git status --porcelain changed — ${describeChange(r.before, r.after)}`);
}

const wrappers = [
  { kind: 'canonical', source: fs.readFileSync(CANONICAL_WRAPPER, 'utf8') },
  { kind: 'adopter', source: fs.readFileSync(path.join(templateDir, adopterWrapperRel), 'utf8') },
];

try {
  for (const { kind, source } of wrappers) {
    const flags = [...extractDispatchedFlags(source)].filter((f) => !SKIP_FLAGS.has(f)).sort();
    assert.ok(flags.length > 10, `FAIL (${kind}): extracted only ${flags.length} flags, regex likely broken`);
    const helpFlags = flags.filter((f) => !OWN_HELP_FLAGS.has(f));
    for (const f of OWN_HELP_FLAGS) assert.ok(flags.includes(f), `FAIL (${kind}): expected own-help flag ${f} to be dispatched by the wrapper`);

    // Generic sweep: flag --help, and flag <sample value> --help.
    for (const flag of helpFlags) {
      assertHelpOnly(`${kind}: ${flag} --help`, runCase(kind, [flag, '--help']));
      assertHelpOnly(`${kind}: ${flag} ${SAMPLE_VALUE} --help`, runCase(kind, [flag, SAMPLE_VALUE, '--help']));
    }
    console.log(`Sweep passed (${kind}): ${helpFlags.length} flags x 2 forms print help and dispatch nothing`);

    // Named case 1: --set-next-action --help leaves next_action unchanged.
    {
      const r = runCase(kind, ['--set-next-action', '--help']);
      assertHelpOnly(`${kind}: --set-next-action --help`, r);
      const nextAction = JSON.parse(fs.readFileSync(path.join(r.dir, 'PROCESS_STATE.json'), 'utf8')).next_action;
      assert.strictEqual(nextAction, 'T-001 fixture next action', `FAIL (${kind}): next_action changed to ${JSON.stringify(nextAction)}`);
    }
    // Named case 2: --close-session --help creates no commit.
    {
      const r = runCase(kind, ['--close-session', '--help']);
      assertHelpOnly(`${kind}: --close-session --help`, r);
      const count = git(r.dir, ['rev-list', '--count', 'HEAD']).trim();
      assert.strictEqual(count, '1', `FAIL (${kind}): --close-session --help left ${count} commits, expected the 1 baseline commit`);
    }
    // Named case 3: --reflect-skill developer --help does not start the reflection script.
    {
      const r = runCase(kind, ['--reflect-skill', 'developer', '--help']);
      assertHelpOnly(`${kind}: --reflect-skill developer --help`, r);
      assert.ok(!r.nodeCalls.some((c) => c.includes('mavp-skill-reflect.js')), `FAIL (${kind}): the reflection script was started`);
    }
    console.log(`Named cases passed (${kind}): --set-next-action, --close-session, --reflect-skill`);

    // The exceptions keep their own dispatch: not the wrapper help, and the
    // flag's script is the one invoked.
    const scriptFor = { '--agent': 'mavp-operator-agent.js', '--snapshot': 'mavp-operator-snapshot.js' };
    for (const flag of OWN_HELP_FLAGS) {
      const r = runCase(kind, [flag, '--help']);
      assert.ok(!r.timedOut, `FAIL (${kind}): ${flag} --help timed out`);
      assert.strictEqual(r.code, 0, `FAIL (${kind}): ${flag} --help exit ${r.code}. stderr:\n${r.stderr}`);
      assert.ok(!r.stdout.includes('Flags:'), `FAIL (${kind}): ${flag} --help printed the wrapper help instead of its own dispatch`);
      assert.ok(r.nodeCalls.some((c) => c.includes(scriptFor[flag])), `FAIL (${kind}): ${flag} --help did not dispatch ${scriptFor[flag]}: ${JSON.stringify(r.nodeCalls)}`);
      // --agent and --snapshot print their own usage text.
      assert.ok(/usage/i.test(r.stdout + r.stderr), `FAIL (${kind}): ${flag} --help printed no usage text. output:\n${(r.stdout + r.stderr).slice(0, 300)}`);
    }
    console.log(`Exceptions passed (${kind}): --agent, --snapshot --help keep their own dispatch`);

    // --install is not exempt: from an empty directory, --install --help prints
    // the wrapper help, never starts the installer and leaves the directory empty.
    for (const installArgs of [['--install', '--help'], ['--install', SAMPLE_VALUE, '--help']]) {
      const emptyDir = fs.mkdtempSync(path.join(scratchRoot, 'empty-'));
      const r = runCase(kind, installArgs, { cwd: emptyDir });
      const label = `${kind}: ${installArgs.join(' ')} in an empty directory`;
      assert.ok(!r.timedOut, `FAIL (${label}): timed out`);
      assert.strictEqual(r.code, 0, `FAIL (${label}): exit ${r.code}. stderr:\n${r.stderr}`);
      assert.ok(r.stdout.includes('Usage: ./scripts/mavp-operator [flag]') && r.stdout.includes('Flags:'), `FAIL (${label}): wrapper help was not printed. stdout:\n${r.stdout.slice(0, 300)}`);
      assert.ok(!r.nodeCalls.some((c) => c.includes('mavp-install.js')), `FAIL (${label}): mavp-install.js was started: ${JSON.stringify(r.nodeCalls)}`);
      assert.deepStrictEqual(fs.readdirSync(emptyDir), [], `FAIL (${label}): the directory is no longer empty: ${fs.readdirSync(emptyDir).join(', ')}`);
    }
    console.log(`Install case passed (${kind}): --install --help prints help, does not start the installer, leaves an empty directory empty`);
  }
  console.log('\nAll T-909 wrapper-help-anywhere assertions passed.');
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
