'use strict';
// Regression test: T-918 — `mavp-install.js --help` / `-h` prints usage and writes nothing.
//
// Problem this guards against: main() picked the target with
// `args.find(a => !a.startsWith('-'))` and fell back to process.cwd(), so
// `node scripts/mavp-install.js --help` ran a REAL bootstrap in the current
// directory. The help check is now the first statement of main(), before the
// banner and before any guard (so no git fetch is started).
//
// Contract asserted here, for the real installer script run as a child process
// with cwd (and any target) inside throwaway directories:
//   (a) from an empty directory, --help and -h exit 0, print a usage text naming
//       the target argument and every flag main() parses, do not print the
//       bootstrap banner, and leave the directory empty.
//   (b) the same holds with a target before/after the flag and with each mode:
//       <target> --help, --help <target>, --check --help, --update --help,
//       --hooks-only --help, --yes --help, and --strip <fixture> --help (the
//       fixture project stays byte-identical).
//   (e) without --help the installer still behaves as before (--check on an
//       empty directory still prints the banner and reports not bootstrapped).
//
// The set of flags the usage must name is derived from the installer source
// (every `args.includes('<flag>')` literal), not hand-listed, so a flag added
// to main() later without a usage line fails here.
//
// Hermetic: MAVERICKS_HOME and HOME are pinned in every spawn env. Plain node,
// no npm deps. Exit 0 = pass.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const BANNER = 'Mavericks Bootstrap';

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-t918-'));
let dirCounter = 0;

function freshDir(label) {
  const d = path.join(scratchRoot, `${label}-${dirCounter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runInstaller(cwd, args) {
  const home = freshDir('home');
  const res = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { ...process.env, MAVERICKS_HOME: REPO_ROOT, HOME: home, NO_COLOR: '1' }
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Recursive snapshot: relative path -> file content (or a dir marker).
function snapshot(root) {
  const out = {};
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        out[rel + '/'] = '<dir>';
        walk(full);
      } else if (st.isSymbolicLink()) {
        out[rel] = '<link>' + fs.readlinkSync(full);
      } else {
        out[rel] = fs.readFileSync(full).toString('base64');
      }
    }
  })(root);
  return out;
}

// Flags main() parses, derived from the installer source.
function parsedFlags() {
  const src = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
  const start = src.indexOf('async function main()');
  assert.ok(start > 0, 'main() not found in installer source');
  const body = src.slice(start);
  const flags = new Set();
  const re = /args\.includes\('(-[A-Za-z-]+)'\)/g;
  let m;
  while ((m = re.exec(body))) flags.add(m[1]);
  return [...flags];
}

function assertNamesFlag(text, flag) {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.ok(new RegExp(`(^|[\\s,])${esc}($|[\\s,])`, 'm').test(text), `usage text does not name ${flag}`);
}

function assertUsage(res, label) {
  assert.strictEqual(res.status, 0, `${label}: expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.ok(/^Usage:/m.test(res.stdout), `${label}: stdout has no Usage line\n${res.stdout}`);
  assert.ok(!res.stdout.includes(BANNER), `${label}: bootstrap banner printed`);
  assert.ok(/target-dir/.test(res.stdout), `${label}: usage does not name the target argument`);
  for (const f of parsedFlags()) assertNamesFlag(res.stdout, f);
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}\n${err.stack || err}`);
    process.exitCode = 1;
  }
}

test('derived flag list covers the documented flags', () => {
  const flags = parsedFlags();
  for (const f of ['--check', '--update', '--strip', '--hooks-only', '--yes', '--no-hooks',
    '--transcript-archive', '--stale-source-ok', '--help', '-h']) {
    assert.ok(flags.includes(f), `installer source no longer parses ${f} via args.includes (found: ${flags.join(' ')})`);
  }
});

for (const flag of ['--help', '-h']) {
  test(`(a) ${flag} from an empty directory: usage, exit 0, no banner, directory stays empty`, () => {
    const cwd = freshDir('empty');
    const res = runInstaller(cwd, [flag]);
    assertUsage(res, flag);
    assert.deepStrictEqual(fs.readdirSync(cwd), [], `${flag}: directory not empty after run`);
  });
}

const emptyCases = [
  ['target then --help', (t) => [t, '--help']],
  ['--help then target', (t) => ['--help', t]],
  ['target then -h', (t) => [t, '-h']],
  ['--check --help', () => ['--check', '--help']],
  ['--check target --help', (t) => ['--check', t, '--help']],
  ['--update --help', () => ['--update', '--help']],
  ['--update target --help', (t) => ['--update', t, '--help']],
  ['--hooks-only --help', () => ['--hooks-only', '--help']],
  ['--hooks-only target --help', (t) => ['--hooks-only', t, '--help']],
  ['--yes --help', () => ['--yes', '--help']],
  ['--transcript-archive --stale-source-ok --help', () => ['--transcript-archive', '--stale-source-ok', '--help']]
];
for (const [label, build] of emptyCases) {
  test(`(b) ${label}: usage, exit 0, cwd and target stay empty`, () => {
    const cwd = freshDir('cwd');
    const target = freshDir('target');
    const res = runInstaller(cwd, build(target));
    assertUsage(res, label);
    assert.deepStrictEqual(fs.readdirSync(cwd), [], `${label}: cwd not empty`);
    assert.deepStrictEqual(fs.readdirSync(target), [], `${label}: target not empty`);
  });
}

test('(b) --strip <fixture> --help: usage, exit 0, fixture byte-identical', () => {
  const cwd = freshDir('cwd');
  const fixture = freshDir('fixture');
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixture, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'scripts', 'mavp-operator'), '#!/bin/bash\necho fixture wrapper\n');
  fs.writeFileSync(path.join(fixture, '.claude', 'agents', 'developer.md'), 'fixture agent\n');
  fs.writeFileSync(path.join(fixture, 'BACKLOG.md'), '# Backlog\n');
  fs.writeFileSync(path.join(fixture, 'TASK_STATUS.md'), '# Task Status\n');
  fs.writeFileSync(path.join(fixture, 'PROCESS_STATE.json'), '{"wave":1}\n');
  const before = snapshot(fixture);
  const res = runInstaller(cwd, ['--strip', fixture, '--help']);
  assertUsage(res, '--strip <fixture> --help');
  assert.deepStrictEqual(snapshot(fixture), before, 'fixture changed');
  assert.deepStrictEqual(fs.readdirSync(cwd), [], 'cwd not empty');
});

test('(e) without --help the installer still runs: --check on an empty directory prints the banner', () => {
  const target = freshDir('target');
  const res = runInstaller(freshDir('cwd'), ['--check', target]);
  assert.ok(res.stdout.includes(BANNER), `banner missing without --help\n${res.stdout}`);
  assert.ok(!/^Usage:/m.test(res.stdout), 'usage text printed without --help');
  assert.deepStrictEqual(fs.readdirSync(target), [], '--check wrote into the target');
});

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch { /* best effort */ }

console.log(`${passed} passed`);
