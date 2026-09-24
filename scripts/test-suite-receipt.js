'use strict';
// T-763 — full-suite receipt: writer (scripts/run-tests.js), checker
// (scripts/mavp-suite-receipt.js), canonical-only mode, and reachability
// through .claude/hooks/pre-push on a real `git push`.
//
// Every behavioural case runs inside a SCRATCH CLONE built under
// os.tmpdir(): a seed repo is committed, bare-cloned into a scratch
// "remote", and cloned back out into the working copy the cases use. The
// scratch clone carries COPIES of the real runner, the real receipt helper,
// the real canonical-heuristic module (and its one dependency) and the real
// CI workflow file — so the runner, the checker and the hook under test are
// this checkout's own code, and the staleness rule is judged against CI's
// real paths-ignore list, not a hand-copied one. Its test set is two tiny
// files, never this repo's suite: an unfiltered run of the real suite from
// inside a test would recurse (this file would run itself).
//
// Plain node + git subprocess, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.join(__dirname, '..');
const receiptLib = require('./mavp-suite-receipt.js');
const { RECEIPT_RELATIVE_PATH, REMEDY_COMMAND, parsePathsIgnore, patternToRegExp } = receiptLib;

const COPIED_SCRIPTS = [
  'run-tests.js',
  'mavp-suite-receipt.js',
  'check-publish-manifest.js',
  'mavp-publish-verify-provenance.js',
];

const tmpDirs = [];
function scratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// Scrub any ambient GIT_DIR (e.g. when this suite is itself launched from a
// git hook) so every fixture git call discovers its repo from cwd.
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

function setIdentity(dir) {
  git(dir, ['config', 'user.email', 'receipt-fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Receipt Fixture']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

/** Seed repo -> bare scratch remote -> scratch clone. Returns { work, remote }. */
function makeScratchClone() {
  const seed = scratch('mavp-receipt-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  setIdentity(seed);
  fs.mkdirSync(path.join(seed, 'scripts'), { recursive: true });
  for (const name of COPIED_SCRIPTS) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, name), path.join(seed, 'scripts', name));
  }
  write(seed, '.github/workflows/ci.yml', fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
  write(seed, '.gitignore', '.mavp/suite-receipt.json\n');
  write(seed, 'BACKLOG.md', '# Backlog\n');
  write(seed, 'PROCESS_STATE.json', '{}\n');
  write(seed, 'README.md', 'fixture\n');
  write(seed, 'scripts/test-alpha.js', "'use strict';\nconsole.log('alpha ok');\n");
  write(seed, 'scripts/test-beta.js', "'use strict';\nconsole.log('beta ok');\n");
  commitAll(seed, 'fixture: seed');
  const remote = scratch('mavp-receipt-remote-');
  git(os.tmpdir(), ['clone', '-q', '--bare', seed, path.join(remote, 'origin.git')]);
  const workParent = scratch('mavp-receipt-work-');
  const work = path.join(workParent, 'clone');
  git(os.tmpdir(), ['clone', '-q', path.join(remote, 'origin.git'), work]);
  setIdentity(work);
  return { work, remote: path.join(remote, 'origin.git') };
}

function runRunner(work, args) {
  const r = spawnSync(process.execPath, ['scripts/run-tests.js', ...(args || [])], {
    cwd: work,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runChecker(work, args) {
  const r = spawnSync(process.execPath, ['scripts/mavp-suite-receipt.js', ...(args || [])], {
    cwd: work,
    encoding: 'utf8',
    env: cleanEnv(),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function receiptLines(stdout) {
  return stdout.split('\n').filter((l) => l.startsWith('Suite receipt:'));
}

function receiptPath(work) {
  return path.join(work, RECEIPT_RELATIVE_PATH);
}

function removeReceipt(work) {
  fs.rmSync(receiptPath(work), { force: true });
}

function head(work) {
  return git(work, ['rev-parse', 'HEAD']).trim();
}

try {
  // -------------------------------------------------------------------------
  // Unit: the staleness definition is CI's own, read from the workflow file.
  // -------------------------------------------------------------------------
  {
    const patterns = parsePathsIgnore(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    assert.ok(Array.isArray(patterns) && patterns.length > 0, `expected a non-empty paths-ignore list from ci.yml, got ${JSON.stringify(patterns)}`);
    // The contract that matters: every file a `chore: close session` commit
    // can touch must be inside CI's paths-ignore, or the push gate would
    // fight the close-session ritual.
    for (const stateFile of ['BACKLOG.md', 'TASK_STATUS.md', 'PROCESS_STATE.json', 'PROCESS_STATE.md']) {
      assert.ok(
        patterns.some((p) => patternToRegExp(p).test(stateFile)),
        `close-session state file ${stateFile} must be covered by ci.yml paths-ignore (${JSON.stringify(patterns)})`
      );
    }
    assert.ok(!patterns.some((p) => patternToRegExp(p).test('scripts/run-tests.js')), 'scripts/ must never be ignored');
    assert.ok(patternToRegExp('SKILL_PROPOSALS/**').test('SKILL_PROPOSALS/a/b.md'), '** must cross directories');
    assert.ok(!patternToRegExp('BACKLOG.md').test('docs/BACKLOG.md'), 'a bare filename pattern is root-anchored');
    assert.ok(!patternToRegExp('*.md').test('docs/x.md'), '* must not cross /');
    const negated = 'on:\n  push:\n    paths-ignore:\n      - BACKLOG.md\n      - ' + '!' + 'scripts/**\n';
    assert.strictEqual(parsePathsIgnore(negated), null, 'an unmodelled filter construct must fail closed (null)');
    assert.strictEqual(parsePathsIgnore('name: x\n'), null, 'a workflow with no on: block must fail closed (null)');
    console.log('PASS: paths-ignore is parsed from ci.yml, covers every close-session state file, and fails closed on unmodelled syntax');
  }

  const { work, remote } = makeScratchClone();

  // -------------------------------------------------------------------------
  // Criterion 1 — the writer.
  // -------------------------------------------------------------------------
  {
    const r = runRunner(work);
    assert.strictEqual(r.status, 0, `unfiltered green run should exit 0:\n${r.stdout}${r.stderr}`);
    const lines = receiptLines(r.stdout);
    assert.strictEqual(lines.length, 1, `expected exactly one receipt line, got:\n${r.stdout}`);
    assert.ok(lines[0].startsWith('Suite receipt: written'), `expected a written line, got: ${lines[0]}`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath(work), 'utf8'));
    assert.strictEqual(receipt.commit, head(work), 'receipt must name the exact HEAD (full sha)');
    assert.strictEqual(receipt.summary_line, 'Summary: 2 passed, 0 failed (of 2 total)', 'receipt must carry the printed summary line');
    assert.ok(r.stdout.includes(receipt.summary_line), 'the recorded summary line must be the one the runner printed');
    const ts = Date.parse(receipt.generated_at);
    assert.ok(Number.isFinite(ts) && Math.abs(Date.now() - ts) < 10 * 60 * 1000, `receipt must carry a current timestamp, got ${receipt.generated_at}`);
    assert.strictEqual(git(work, ['status', '--porcelain']), '', 'the receipt must be git-ignored (status stays clean)');
    console.log('PASS: criterion 1 — unfiltered all-green run writes a git-ignored receipt naming HEAD, the summary line and a timestamp');
  }

  {
    removeReceipt(work);
    const r = runRunner(work, ['--filter', 'alpha']);
    assert.strictEqual(r.status, 0, `filtered green run should exit 0:\n${r.stdout}`);
    const lines = receiptLines(r.stdout);
    assert.strictEqual(lines.length, 1, `expected exactly one receipt line, got:\n${r.stdout}`);
    assert.ok(/not written — filtered run/.test(lines[0]), `expected the filtered-run reason, got: ${lines[0]}`);
    assert.ok(!fs.existsSync(receiptPath(work)), 'a filtered run must write no receipt');
    console.log('PASS: criterion 1 — a filtered run writes no receipt and prints one line saying why');
  }

  {
    removeReceipt(work);
    write(work, 'scripts/test-zz-deliberate-fail.js', "'use strict';\nconsole.error('deliberate failure');\nprocess.exit(1);\n");
    const r = runRunner(work);
    fs.rmSync(path.join(work, 'scripts', 'test-zz-deliberate-fail.js'));
    assert.strictEqual(r.status, 1, `a run with a failing file should exit 1:\n${r.stdout}`);
    const lines = receiptLines(r.stdout);
    assert.strictEqual(lines.length, 1, `expected exactly one receipt line, got:\n${r.stdout}`);
    assert.ok(/not written — 1 test file\(s\) failed \(test-zz-deliberate-fail\.js\)/.test(lines[0]), `expected the failing-file reason, got: ${lines[0]}`);
    assert.ok(!fs.existsSync(receiptPath(work)), 'a run with a failing file must write no receipt');
    console.log('PASS: criterion 1 — a run with a deliberately failing extra test file writes no receipt and says why');
  }

  {
    removeReceipt(work);
    fs.appendFileSync(path.join(work, 'scripts', 'test-alpha.js'), '// local edit\n');
    const r = runRunner(work);
    git(work, ['checkout', 'HEAD', '--', 'scripts/test-alpha.js']);
    assert.strictEqual(r.status, 0, `the suite itself still passes:\n${r.stdout}`);
    const lines = receiptLines(r.stdout);
    assert.strictEqual(lines.length, 1, `expected exactly one receipt line, got:\n${r.stdout}`);
    assert.ok(/not written — tracked non-state file modified at the start of the run: scripts\/test-alpha\.js/.test(lines[0]), `expected the modified-file reason naming the path, got: ${lines[0]}`);
    assert.ok(!fs.existsSync(receiptPath(work)), 'a run over a modified tracked non-state file must write no receipt');
    console.log('PASS: criterion 1 — a run with a modified tracked non-state file writes no receipt and names the file');
  }

  {
    // A test that dirties a tracked file DURING the run cannot launder itself.
    removeReceipt(work);
    write(work, 'scripts/test-zz-dirtier.js', "'use strict';\nrequire('node:fs').appendFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'dirtied\\n');\n");
    const r = runRunner(work);
    fs.rmSync(path.join(work, 'scripts', 'test-zz-dirtier.js'));
    git(work, ['checkout', 'HEAD', '--', 'README.md']);
    const lines = receiptLines(r.stdout);
    assert.strictEqual(lines.length, 1, `expected exactly one receipt line, got:\n${r.stdout}`);
    assert.ok(/modified during the run: README\.md/.test(lines[0]), `expected the dirtied-during-run reason, got: ${lines[0]}`);
    assert.ok(!fs.existsSync(receiptPath(work)), 'a run that dirtied the tree must write no receipt');
    console.log('PASS: a test that modifies a tracked file during the run prevents the receipt');
  }

  {
    // State artifacts are exempt: CI's own paths-ignore set, same as the checker.
    removeReceipt(work);
    fs.appendFileSync(path.join(work, 'BACKLOG.md'), 'mid-edit\n');
    const r = runRunner(work);
    git(work, ['checkout', 'HEAD', '--', 'BACKLOG.md']);
    assert.ok(receiptLines(r.stdout)[0].startsWith('Suite receipt: written'), `a state-only modification must not block the receipt:\n${r.stdout}`);
    console.log('PASS: a modified state artifact (CI paths-ignore) does not block the receipt');
  }

  // -------------------------------------------------------------------------
  // Criterion 2 — the checker, both directions.
  // -------------------------------------------------------------------------
  const receiptCommit = head(work);
  {
    const r = runChecker(work);
    assert.strictEqual(r.status, 0, `receipt at HEAD must exit 0:\n${r.stdout}${r.stderr}`);
    assert.ok(/current — the receipt records HEAD/.test(r.stdout), `expected the current line, got:\n${r.stdout}`);
    console.log('PASS: criterion 2 — receipt commit == HEAD exits 0');
  }
  {
    fs.appendFileSync(path.join(work, 'BACKLOG.md'), 'close-session edit\n');
    write(work, 'PROCESS_STATE.json', '{"wave": 2}\n');
    write(work, 'SKILL_PROPOSALS/developer/proposal.md', 'proposal\n');
    const stateHead = commitAll(work, 'chore: close session 2026-01-01');
    const r = runChecker(work);
    assert.strictEqual(r.status, 0, `a state-only follow-up commit must keep the receipt current:\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(receiptCommit) && r.stdout.includes(stateHead), `expected both commits named, got:\n${r.stdout}`);
    assert.ok(/only in .* paths-ignore paths \(3 changed\)/.test(r.stdout), `expected the paths-ignore explanation, got:\n${r.stdout}`);
    console.log('PASS: criterion 2 — a state-only follow-up commit (paths-ignore only) exits 0');
  }
  {
    fs.appendFileSync(path.join(work, 'scripts', 'test-beta.js'), '// content change\n');
    fs.appendFileSync(path.join(work, 'BACKLOG.md'), 'and a state edit\n');
    const scriptsHead = commitAll(work, 'content: change a script');
    const r = runChecker(work);
    assert.strictEqual(r.status, 1, `a scripts/ follow-up commit must exit 1:\n${r.stdout}${r.stderr}`);
    const msg = r.stderr;
    assert.ok(msg.includes(`receipt commit: ${receiptCommit}`), `must name the receipt commit:\n${msg}`);
    assert.ok(msg.includes(`HEAD: ${scriptsHead}`), `must name HEAD:\n${msg}`);
    assert.ok(msg.includes('first offending path: scripts/test-beta.js'), `must name the first offending (non-ignored) path:\n${msg}`);
    assert.ok(msg.includes(REMEDY_COMMAND), `must name the exact remedy command:\n${msg}`);
    console.log('PASS: criterion 2 — a scripts/ follow-up commit exits 1 naming receipt commit, HEAD, first offending path and remedy');
  }
  {
    removeReceipt(work);
    const r = runChecker(work);
    assert.strictEqual(r.status, 1, 'no receipt must exit 1');
    assert.ok(/MISSING/.test(r.stderr) && r.stderr.includes(REMEDY_COMMAND), `expected MISSING + remedy:\n${r.stderr}`);
    write(work, RECEIPT_RELATIVE_PATH, '{not json');
    const bad = runChecker(work);
    assert.strictEqual(bad.status, 1, 'an unparseable receipt must exit 1');
    assert.ok(/INVALID/.test(bad.stderr), `expected INVALID:\n${bad.stderr}`);
    removeReceipt(work);
    console.log('PASS: criterion 2 — a missing or unparseable receipt exits 1 with the remedy');
  }

  // -------------------------------------------------------------------------
  // Criterion 3 — canonical-only mode reuses check-publish-manifest's heuristic.
  // -------------------------------------------------------------------------
  {
    const r = runChecker(work, ['--if-canonical']);
    assert.strictEqual(r.status, 0, `no manifest => non-canonical => exit 0:\n${r.stdout}${r.stderr}`);
    assert.ok(/^SKIP: .*non-canonical repo/m.test(r.stdout), `expected a SKIP line, got:\n${r.stdout}`);

    write(work, 'scripts/publish-manifest.json', JSON.stringify({ ship: [], exclude: { 'notes/untracked-private.md': 'not tracked here' } }, null, 2) + '\n');
    commitAll(work, 'manifest with an untracked exclude key');
    const r2 = runChecker(work, ['--if-canonical']);
    assert.strictEqual(r2.status, 0, `an untracked exclude key => non-canonical => exit 0:\n${r2.stdout}${r2.stderr}`);
    assert.ok(/^SKIP: /m.test(r2.stdout), `expected a SKIP line, got:\n${r2.stdout}`);

    write(work, 'scripts/publish-manifest.json', JSON.stringify({ ship: [], exclude: { 'BACKLOG.md': 'state' } }, null, 2) + '\n');
    commitAll(work, 'manifest whose exclude keys are all tracked');
    const r3 = runChecker(work, ['--if-canonical']);
    assert.strictEqual(r3.status, 1, `canonical + no receipt => exit 1:\n${r3.stdout}${r3.stderr}`);
    assert.ok(/MISSING/.test(r3.stderr), `expected MISSING in canonical mode:\n${r3.stderr}`);
    console.log('PASS: criterion 3 — --if-canonical skips (exit 0) in non-canonical repos and enforces in a canonical one');
  }

  // -------------------------------------------------------------------------
  // Criterion 4 — reachability through the real hook on a real `git push`.
  // -------------------------------------------------------------------------
  {
    const hooksDir = scratch('mavp-receipt-hooks-');
    fs.copyFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'pre-push'), path.join(hooksDir, 'pre-push'));
    fs.chmodSync(path.join(hooksDir, 'pre-push'), 0o755);
    git(work, ['config', 'core.hooksPath', hooksDir]);

    const push = (extra) => {
      const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: work, encoding: 'utf8', env: cleanEnv(extra) });
      return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stderr: r.stderr || '' };
    };
    const remoteMain = () => git(remote, ['rev-parse', 'refs/heads/main']).trim();

    const before = remoteMain();
    const p1 = push();
    assert.notStrictEqual(p1.status, 0, `push with no receipt must be refused:\n${p1.out}`);
    assert.ok(/Suite receipt: MISSING/.test(p1.stderr), `push stderr must carry the checker's message:\n${p1.stderr}`);
    assert.ok(p1.stderr.includes(REMEDY_COMMAND) && /PUSH REFUSED/.test(p1.stderr), `push stderr must carry the remedy + refusal:\n${p1.stderr}`);
    assert.strictEqual(remoteMain(), before, 'a refused push must not move the remote');
    console.log('PASS: criterion 4 — git push with no receipt is refused and stderr carries the checker message');

    const pAllow = push({ MAVP_ALLOW_WORKTREE_PUSH: '1' });
    assert.notStrictEqual(pAllow.status, 0, `the worktree escape hatch must NOT bypass the receipt gate:\n${pAllow.out}`);
    console.log('PASS: MAVP_ALLOW_WORKTREE_PUSH does not bypass the suite-receipt gate');

    const p2 = push({ MAVP_SKIP_SUITE_RECEIPT: '1' });
    assert.strictEqual(p2.status, 0, `push with MAVP_SKIP_SUITE_RECEIPT=1 must proceed:\n${p2.out}`);
    assert.strictEqual(remoteMain(), head(work), 'the escape-hatch push must reach the remote');
    console.log('PASS: criterion 4 — the documented escape hatch lets the same push proceed');

    fs.appendFileSync(path.join(work, 'scripts', 'test-alpha.js'), '// another content change\n');
    commitAll(work, 'content: another change');
    const earn = runRunner(work);
    assert.ok(receiptLines(earn.stdout)[0].startsWith('Suite receipt: written'), `expected to earn a receipt:\n${earn.stdout}`);
    const p3 = push();
    assert.strictEqual(p3.status, 0, `push with a current receipt must proceed:\n${p3.out}`);
    assert.ok(/Suite receipt: current/.test(p3.out), `expected the checker's current line in push output:\n${p3.out}`);
    assert.strictEqual(remoteMain(), head(work), 'the receipted push must reach the remote');
    console.log('PASS: criterion 4 — with a current receipt the push proceeds');

    fs.appendFileSync(path.join(work, 'BACKLOG.md'), 'close\n');
    commitAll(work, 'chore: close session 2026-01-02');
    const p4 = push();
    assert.strictEqual(p4.status, 0, `a state-only close-session commit on top of a receipt must still push:\n${p4.out}`);
    console.log('PASS: a close-session (state-only) commit on top of a current receipt still pushes');
  }

  console.log('\nAll T-763 suite-receipt assertions passed.');
} finally {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
