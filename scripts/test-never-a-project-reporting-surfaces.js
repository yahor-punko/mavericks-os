'use strict';
// Regression test: T-847 - reporting surfaces (--agent, --snapshot, the
// validator's last_task_id auto-patch, the .mavp/permission-mode record) make
// no state write when the resolved root is a never-a-project root, and --help
// on --agent / --snapshot exits before any side effect.
//
// Covers:
//   1. Unit: guardReportingWrite() maps all four discriminators (placeholder,
//      dot_mavericks, linked_worktree, caller_in_linked_worktree) to skip:true
//      using the injected homeDir/cwd pattern, the override env var to
//      skip:false/overridden:true, an ordinary root to skip:false; and it
//      shares guardMutatingRoot()'s discriminator text via one helper.
//   2. End-to-end F1 (a copy of the framework scripts at <tmp>/home/.mavericks,
//      HOME pointed at <tmp>/home): --help prints usage and leaves
//      PROCESS_STATE.md byte-identical; --agent reports
//      reporting_write_skipped, writes nothing and creates no .mavp/; the
//      snapshot (with and without --help) leaves PROCESS_STATE.md untouched.
//   3. End-to-end F2 (ordinary installed-looking project): --agent and the
//      snapshot still regenerate PROCESS_STATE.md and carry no
//      reporting_write_skipped key (no-false-positive proof).
//   4. F1 with the override env var: regeneration proceeds.
//   5. A SessionStart hook payload on stdin persists .mavp/permission-mode in F2
//      and not in F1.
//   6. F3 (placeholder root whose BACKLOG.md outruns last_task_id): the
//      validator leaves PROCESS_STATE.json byte-identical and reports the
//      existing last_task_id_auto_patched finding with the discriminator text;
//      the same BACKLOG.md in an F2-shaped root still auto-patches.
//
// Fixture paths are built at runtime from os.tmpdir(); no absolute home path
// appears in this file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const lib = require('./mavp-operator-lib.js');
const {
  guardReportingWrite,
  guardMutatingRoot,
  describeNeverProjectDiscriminator,
  checkNeverAProjectRoot,
  NEVER_PROJECT_ROOT_OVERRIDE_ENV,
  NEVER_PROJECT_VERSION_PLACEHOLDER,
} = lib;

const SCRIPTS_DIR = __dirname;
const TEMPLATES_DIR = path.join(SCRIPTS_DIR, '..', 'templates');
const NODE_BIN = process.execPath;
const COPIED_SCRIPTS = [
  'mavp-operator-agent.js',
  'mavp-operator-snapshot.js',
  'mavp-operator-lib.js',
  'mavp-validator.js',
  'mavp-version.js',
];
const GENERATED_HEADER = '<!-- auto-generated — do not edit manually -->';

const tmpRoots = [];
function mkTmp(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mavp-t847-${label}-`)));
  tmpRoots.push(dir);
  return dir;
}
function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); }

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// Build a framework-shaped root: copies (never symlinks) of the five scripts plus
// the state artifacts. `version` null keeps the shipped placeholder.
function buildRoot(root, { version }) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const f of COPIED_SCRIPTS) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, f), path.join(root, 'scripts', f));
  }
  let stateJson = readUtf8(path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.json'));
  if (version) stateJson = stateJson.replace(NEVER_PROJECT_VERSION_PLACEHOLDER, version);
  writeUtf8(path.join(root, 'PROCESS_STATE.json'), stateJson);
  writeUtf8(path.join(root, 'PROCESS_STATE.md'), readUtf8(path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.md')));
  writeUtf8(path.join(root, 'BACKLOG.md'), readUtf8(path.join(TEMPLATES_DIR, 'BACKLOG_TEMPLATE.md')));
  writeUtf8(path.join(root, 'TASK_STATUS.md'), readUtf8(path.join(TEMPLATES_DIR, 'TASK_STATUS_TEMPLATE.md')));
}

function spawnScript(root, home, script, args, { override, stdin } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MAVERICKS_PROJECT_ROOT;
  delete env.MAVERICKS_SCRIPTS;
  delete env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  if (override) env[NEVER_PROJECT_ROOT_OVERRIDE_ENV] = '1';
  const r = spawnSync(NODE_BIN, [path.join('scripts', script), ...args], {
    cwd: root, env, encoding: 'utf8', input: stdin || '',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${String(error && error.stack || error).split('\n').join('\n  ')}`);
  }
}

// ---- Unit: guardReportingWrite -------------------------------------------
const home = mkTmp('home');
const nonGitCwd = mkTmp('cwd');

check('guardReportingWrite: placeholder discriminator -> skip:true', () => {
  const root = mkTmp('placeholder');
  buildRoot(root, { version: null });
  const g = guardReportingWrite(root, '--agent', { homeDir: home, cwd: nonGitCwd, env: {} });
  assert.strictEqual(g.skip, true);
  assert.strictEqual(g.discriminator, 'placeholder');
  assert.strictEqual(g.overridden, false);
  assert.strictEqual(g.resolvedRoot, root);
});

check('guardReportingWrite: dot_mavericks discriminator -> skip:true (checked before placeholder)', () => {
  const root = path.join(home, '.mavericks');
  buildRoot(root, { version: null });
  const g = guardReportingWrite(root, '--agent', { homeDir: home, cwd: nonGitCwd, env: {} });
  assert.strictEqual(g.skip, true);
  assert.strictEqual(g.discriminator, 'dot_mavericks');
  assert.strictEqual(g.resolvedRoot, root);
});

// git fixtures for the two worktree discriminators
const gitBase = mkTmp('git');
const primary = path.join(gitBase, 'primary');
const linked = path.join(gitBase, 'linked');
fs.mkdirSync(primary);
run('git', ['init', '-q', '-b', 'main'], primary);
run('git', ['config', 'user.email', 'test@example.com'], primary);
run('git', ['config', 'user.name', 'Test'], primary);
writeUtf8(path.join(primary, 'seed.txt'), 'seed\n');
run('git', ['add', 'seed.txt'], primary);
run('git', ['commit', '-q', '-m', 'init'], primary);
run('git', ['worktree', 'add', '-q', '-b', 'linked-branch', linked], primary);
const realPrimary = fs.realpathSync(primary);
const realLinked = fs.realpathSync(linked);

check('guardReportingWrite: linked_worktree discriminator -> skip:true', () => {
  const g = guardReportingWrite(linked, '--snapshot', { homeDir: home, cwd: nonGitCwd, env: {} });
  assert.strictEqual(g.skip, true);
  assert.strictEqual(g.discriminator, 'linked_worktree');
  assert.strictEqual(g.resolvedRoot, realLinked);
});

check('guardReportingWrite: caller_in_linked_worktree discriminator -> skip:true', () => {
  const g = guardReportingWrite(primary, '--agent', { homeDir: home, cwd: linked, env: {} });
  assert.strictEqual(g.skip, true);
  assert.strictEqual(g.discriminator, 'caller_in_linked_worktree');
  assert.strictEqual(g.resolvedRoot, realPrimary);
});

check('guardReportingWrite: override env var -> skip:false, overridden:true (for every discriminator)', () => {
  const env = { [NEVER_PROJECT_ROOT_OVERRIDE_ENV]: '1' };
  for (const [root, cwd] of [[linked, nonGitCwd], [primary, linked], [path.join(home, '.mavericks'), nonGitCwd]]) {
    const g = guardReportingWrite(root, '--agent', { homeDir: home, cwd, env });
    assert.strictEqual(g.skip, false);
    assert.strictEqual(g.overridden, true);
  }
});

check('guardReportingWrite: ordinary root -> skip:false, overridden:false, never prints or exits', () => {
  const root = mkTmp('ordinary');
  buildRoot(root, { version: '1.2.3' });
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let printed = '';
  process.stdout.write = (c) => { printed += c; return true; };
  process.stderr.write = (c) => { printed += c; return true; };
  let g;
  try { g = guardReportingWrite(root, '--agent', { homeDir: home, cwd: nonGitCwd, env: {} }); } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.strictEqual(g.skip, false);
  assert.strictEqual(g.overridden, false);
  assert.strictEqual(g.discriminator, null);
  assert.strictEqual(printed, '');
});

check('guardReportingWrite shares guardMutatingRoot discriminator text via one helper', () => {
  const cases = [
    [linked, nonGitCwd],
    [primary, linked],
    [path.join(home, '.mavericks'), nonGitCwd],
  ];
  for (const [root, cwd] of cases) {
    const opts = { homeDir: home, cwd, env: {} };
    const check0 = checkNeverAProjectRoot(root, opts);
    assert.strictEqual(check0.blocked, true);
    const expected = describeNeverProjectDiscriminator(check0);
    const g = guardReportingWrite(root, '--agent', opts);
    assert.strictEqual(g.discriminatorText, expected);
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    let printed = '';
    process.stdout.write = (c) => { printed += c; return true; };
    process.stderr.write = (c) => { printed += c; return true; };
    try { guardMutatingRoot(root, '--set-status', opts); } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    assert.ok(printed.includes(`matched discriminator: ${expected}`), 'mutating refusal carries the shared text');
  }
});

// ---- End-to-end: F1 (framework-source clone shape) -------------------------
const f1Home = mkTmp('f1home');
const F1 = path.join(f1Home, '.mavericks');
buildRoot(F1, { version: null });
const f1MdBefore = readUtf8(path.join(F1, 'PROCESS_STATE.md'));

function assertF1Untouched() {
  assert.strictEqual(readUtf8(path.join(F1, 'PROCESS_STATE.md')), f1MdBefore, 'PROCESS_STATE.md byte-identical');
  assert.ok(!fs.existsSync(path.join(F1, '.mavp')), 'no .mavp directory created');
}

check('F1: --agent --help exits 0 with a usage line first, state untouched', () => {
  const r = spawnScript(F1, f1Home, 'mavp-operator-agent.js', ['--help']);
  assert.strictEqual(r.status, 0);
  const first = r.stdout.split('\n').find((l) => l.trim() !== '');
  assert.ok(first && first.startsWith('Usage:'), `first non-empty line is a usage line, got: ${first}`);
  assert.notStrictEqual(first.trim(), '{');
  assertF1Untouched();
});

check('F1: --agent reports reporting_write_skipped dot_mavericks, one stderr note, no writes', () => {
  const r = spawnScript(F1, f1Home, 'mavp-operator-agent.js', []);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.reporting_write_skipped.discriminator, 'dot_mavericks');
  const noteLines = r.stderr.split('\n').filter((l) => l.trim());
  assert.strictEqual(noteLines.length, 1, `exactly one stderr note line, got: ${JSON.stringify(noteLines)}`);
  assert.ok(noteLines[0].includes(F1), 'note names the resolved path');
  assertF1Untouched();
});

check('F1: --snapshot prints the snapshot and leaves PROCESS_STATE.md untouched', () => {
  const r = spawnScript(F1, f1Home, 'mavp-operator-snapshot.js', []);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0, 'snapshot on stdout');
  assertF1Untouched();
});

check('F1: --snapshot --help exits 0 with usage, state untouched', () => {
  const r = spawnScript(F1, f1Home, 'mavp-operator-snapshot.js', ['--help']);
  assert.strictEqual(r.status, 0);
  const first = r.stdout.split('\n').find((l) => l.trim() !== '');
  assert.ok(first && first.startsWith('Usage:'), `got: ${first}`);
  assertF1Untouched();
});

check('F1: a SessionStart hook payload on stdin creates no .mavp/permission-mode', () => {
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', permission_mode: 'acceptEdits', session_id: 'sess-1' });
  const r = spawnScript(F1, f1Home, 'mavp-operator-agent.js', [], { stdin: payload });
  assert.strictEqual(r.status, 0, r.stderr);
  assertF1Untouched();
});

// ---- End-to-end: F2 (ordinary project) ---------------------------------
const f2Home = mkTmp('f2home');
const F2 = mkTmp('f2proj');
buildRoot(F2, { version: '1.2.3' });

check('F2: --agent regenerates PROCESS_STATE.md and carries no reporting_write_skipped', () => {
  const r = spawnScript(F2, f2Home, 'mavp-operator-agent.js', []);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!('reporting_write_skipped' in JSON.parse(r.stdout)));
  assert.strictEqual(readUtf8(path.join(F2, 'PROCESS_STATE.md')).split('\n')[0], GENERATED_HEADER);
});

check('F2: --snapshot regenerates PROCESS_STATE.md', () => {
  writeUtf8(path.join(F2, 'PROCESS_STATE.md'), readUtf8(path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.md')));
  const r = spawnScript(F2, f2Home, 'mavp-operator-snapshot.js', []);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readUtf8(path.join(F2, 'PROCESS_STATE.md')).split('\n')[0], GENERATED_HEADER);
});

check('F2: a SessionStart hook payload on stdin creates .mavp/permission-mode', () => {
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', permission_mode: 'acceptEdits', session_id: 'sess-2' });
  const r = spawnScript(F2, f2Home, 'mavp-operator-agent.js', [], { stdin: payload });
  assert.strictEqual(r.status, 0, r.stderr);
  const record = JSON.parse(readUtf8(path.join(F2, '.mavp', 'permission-mode')));
  assert.strictEqual(record.mode, 'acceptEdits');
});

// ---- F1 with the override --------------------------------------------------
check('F1 + override env var: regeneration proceeds', () => {
  const r = spawnScript(F1, f1Home, 'mavp-operator-agent.js', [], { override: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!('reporting_write_skipped' in JSON.parse(r.stdout)));
  assert.strictEqual(readUtf8(path.join(F1, 'PROCESS_STATE.md')).split('\n')[0], GENERATED_HEADER);
});

// ---- F3: validator auto-patch skipped in a placeholder root ------------------
function backlogWithHighTask() {
  return readUtf8(path.join(TEMPLATES_DIR, 'BACKLOG_TEMPLATE.md')).replace('### T-001 — Example task', '### T-099 — Example task');
}
function validatorFindings(root, home0) {
  const r = spawnScript(root, home0, 'mavp-validator.js', [root, '--json']);
  const parsed = JSON.parse(r.stdout);
  return parsed.comparison.findings.filter((f) => f.checkName === 'last_task_id_auto_patched');
}

check('F3: validator leaves a placeholder root PROCESS_STATE.json byte-identical, reports the discriminator text', () => {
  const F3 = mkTmp('f3');
  buildRoot(F3, { version: null });
  writeUtf8(path.join(F3, 'BACKLOG.md'), backlogWithHighTask());
  const before = readUtf8(path.join(F3, 'PROCESS_STATE.json'));
  const findings = validatorFindings(F3, mkTmp('f3home'));
  assert.strictEqual(readUtf8(path.join(F3, 'PROCESS_STATE.json')), before, 'PROCESS_STATE.json byte-identical');
  assert.strictEqual(findings.length, 1);
  assert.ok(findings[0].message.includes(`mavericks_version is the shipped placeholder "${NEVER_PROJECT_VERSION_PLACEHOLDER}"`), findings[0].message);
  assert.strictEqual(findings[0].severity, 'info', 'severity unchanged');
});

check('F3 shape in an ordinary root: the validator still auto-patches last_task_id', () => {
  const F2b = mkTmp('f2b');
  buildRoot(F2b, { version: '1.2.3' });
  writeUtf8(path.join(F2b, 'BACKLOG.md'), backlogWithHighTask());
  const findings = validatorFindings(F2b, mkTmp('f2bhome'));
  assert.strictEqual(findings.length, 1);
  assert.ok(findings[0].message.includes('auto-patched: 1 → 99'), findings[0].message);
  assert.strictEqual(JSON.parse(readUtf8(path.join(F2b, 'PROCESS_STATE.json'))).last_task_id, 99);
});

// ---- cleanup -----------------------------------------------------------------
try { run('git', ['worktree', 'remove', '--force', linked], primary); } catch { /* best effort */ }
for (const dir of tmpRoots) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
