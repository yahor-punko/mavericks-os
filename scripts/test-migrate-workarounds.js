'use strict';
// T-831 — workaround retirement: tag pattern, CHANGELOG supersedes parser,
// harness memory resolver, retirability classifier, the read-only `--migrate`
// command and the post-`--update` advisory.
//
// Expected values come from the T-831 acceptance criteria, not from observed
// behaviour. Hermetic: MAVERICKS_INTAKE_DIR, MAVERICKS_PROJECT_ROOT and the home
// directory (HOME/USERPROFILE) are pinned to temp dirs in every spawn, so neither
// the real home directory nor the real harness memory is ever read. Tag literals
// are assembled at runtime so no contiguous tag sits in this ship file's text.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.join(SCRIPTS_DIR, '..');
const MIGRATE = path.join(SCRIPTS_DIR, 'mavp-operator-migrate.js');
const INSTALL = path.join(SCRIPTS_DIR, 'mavp-install.js');
const lib = require('./mavp-operator-lib.js');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const tag = (id) => ['mavp-workaround', id].join(':');

const tmpRoots = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mig-${label}-`));
  tmpRoots.push(d);
  return d;
}

function writeItem(inbox, id, fields) {
  fs.mkdirSync(inbox, { recursive: true });
  const text = lib.renderFeedbackItem({
    id,
    title: `Item ${id}`,
    fields: Object.assign(
      { Adopter: 'sample', 'Framework version': '0.50.0', Kind: 'bug', Severity: 'normal', Area: 'operator', Submitted: '2026-01-01', Channel: 'local' },
      fields
    ),
    sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
  });
  fs.writeFileSync(path.join(inbox, `${id}.md`), text);
}

function git(root, args) {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function hashTree(...dirs) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else h.update(`${abs}\0`).update(fs.readFileSync(abs)).update('\0');
    }
  };
  for (const d of dirs) walk(d);
  return h.digest('hex');
}

// Fixture adopter repo + inbox + fake home carrying a harness memory dir.
function fixture(opts = {}) {
  const root = fs.realpathSync(mkTmp('root'));
  const inbox = path.join(mkTmp('inbox'), 'queue');
  const home = fs.realpathSync(mkTmp('home'));
  git(root, ['init', '-q', '-b', 'main']);
  const state = { initiative: 'fixture', wave: 1, mavericks_version: opts.installed || '0.60.1' };
  if (opts.alias !== null) state.feedback_alias = opts.alias || 'sample';
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), `# Project\n\nUse the stop-gap here ${tag('sample-001')} until fixed.\n`);
  fs.mkdirSync(path.join(root, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'rules', 'project-local.md'), `# Local\n\nplain line\nOther stop-gap ${tag('sample-002')}\n`);
  fs.writeFileSync(path.join(root, 'untracked-but-ignored.md'), `${tag('sample-001')} in an untracked file\n`);
  git(root, ['add', 'PROCESS_STATE.json', 'CLAUDE.md', '.claude/rules/project-local.md']);
  git(root, ['commit', '-q', '-m', 'fixture']);

  const memDir = path.join(home, '.claude', 'projects', root.replace(/[\\/]/g, '-'), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'feedback_notes.md'), '# Notes\n\nAlways commit HANDOFF.md before closing.\nan unrelated line\n');

  writeItem(inbox, 'sample-001', { Disposition: 'fixed-in T-900', 'Ships in': 'released in 0.60.0', Workaround: tag('sample-001') });
  writeItem(inbox, 'sample-002', { Disposition: 'deferred', Workaround: tag('sample-002') });
  return { root, inbox, home, memDir };
}

function env(fx, extra) {
  return Object.assign({}, process.env, {
    MAVERICKS_PROJECT_ROOT: fx.root,
    MAVERICKS_INTAKE_DIR: fx.inbox,
    HOME: fx.home,
    USERPROFILE: fx.home,
    MAVERICKS_HOME: REPO_ROOT,
  }, extra || {});
}

function migrate(fx, args, extra) {
  const r = spawnSync(process.execPath, [MIGRATE, ...(args || [])], { cwd: fx.root, env: env(fx, extra), encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}

function libTests() {
  // WORKAROUND_TAG_PATTERN
  const m = `prefix text ${tag('sample-001')} trailing`.match(lib.WORKAROUND_TAG_PATTERN);
  assert.ok(m, 'tag matches anywhere on a line');
  assert.strictEqual(m[1], 'sample-001', 'capture group is the item id');
  assert.ok(!lib.WORKAROUND_TAG_PATTERN.test('mavp-workaround:<alias>-NNN'), 'the placeholder form is not a tag');
  assert.ok(!lib.WORKAROUND_TAG_PATTERN.test('mavp-workaround: sample-001'), 'a space after the colon is not a tag');

  // parseChangelogSupersedes
  const changelog = [
    '# Changelog',
    '## [Unreleased]',
    '- **Supersedes adopter workarounds:** `pending phrase`',
    '## [0.60.0] — 2026-01-01',
    '- fixed something (T-900)',
    '- **Supersedes adopter workarounds:** `commit HANDOFF.md`, `second phrase`',
    '## [0.59.0] — 2025-12-01',
    '- nothing here',
    '## [0.58.0] — 2025-11-01',
    'Supersedes adopter workarounds: `no bold marker so ignored`',
  ].join('\n');
  assert.deepStrictEqual(lib.parseChangelogSupersedes(changelog), [
    { version: 'Unreleased', phrases: ['pending phrase'] },
    { version: '0.60.0', phrases: ['commit HANDOFF.md', 'second phrase'] },
  ]);
  assert.deepStrictEqual(lib.parseChangelogSupersedes(''), []);

  // resolveHarnessMemoryDir
  const home = fs.realpathSync(mkTmp('lhome'));
  const projectRoot = path.join(fs.realpathSync(mkTmp('lroot')), 'proj');
  assert.strictEqual(lib.resolveHarnessMemoryDir(projectRoot, { home }), null, 'null when the directory does not exist');
  const expected = path.join(home, '.claude', 'projects', projectRoot.replace(/[\\/]/g, '-'), 'memory');
  fs.mkdirSync(expected, { recursive: true });
  assert.strictEqual(lib.resolveHarnessMemoryDir(projectRoot, { home }), expected);
  assert.ok(!path.basename(path.dirname(expected)).includes(path.sep), 'slug has no path separator left');

  // computeRetirableWorkarounds
  const entry = (id, fields) => ({ id, item: { fields: Object.assign({ Workaround: tag(id) }, fields) } });
  const items = [
    entry('sample-001', { Disposition: 'fixed-in T-900', 'Ships in': 'released in 0.60.0' }),
    entry('sample-002', { Disposition: 'deferred' }),
    entry('sample-003', { Disposition: 'fixed-in T-901', 'Ships in': 'released in 0.60.10' }),
    entry('sample-004', { Disposition: 'fixed-in T-902', 'Ships in': 'unreleased (next after 0.60.1)' }),
    entry('sample-005', { Disposition: 'fixed-in T-903', 'Ships in': 'not yet in CHANGELOG' }),
    entry('sample-006', { Disposition: 'fixed-in T-904', 'Ships in': 'released in 0.60.1' }),
    { id: 'sample-007', item: null },
    { id: 'sample-008', item: { fields: { Disposition: 'fixed-in T-905', 'Ships in': 'released in 0.60.0' } } },
  ];
  const byId = (installed) => Object.fromEntries(lib.computeRetirableWorkarounds(items, installed).map((c) => [c.id, c]));
  const at0601 = byId('0.60.1');
  assert.strictEqual(at0601['sample-001'].status, 'retire');
  assert.strictEqual(at0601['sample-001'].fixedIn, 'T-900');
  assert.strictEqual(at0601['sample-001'].shipsIn, '0.60.0');
  assert.strictEqual(at0601['sample-002'].status, 'keep-open');
  assert.strictEqual(at0601['sample-003'].status, 'keep-pending', '0.60.10 is later than 0.60.1 (numeric, not lexical)');
  assert.strictEqual(at0601['sample-004'].status, 'keep-pending');
  assert.strictEqual(at0601['sample-005'].status, 'keep-pending');
  assert.strictEqual(at0601['sample-006'].status, 'retire', 'equal version retires');
  assert.ok(!('sample-007' in at0601), 'unreadable items are skipped');
  assert.ok(!('sample-008' in at0601), 'an item with no Workaround field is not tagged, so it is omitted');
  const free = lib.classifyFeedbackItem(items[7], '0.60.1');
  assert.strictEqual(free.status, 'retire', 'the per-item classifier does not require a Workaround field');
  // T-835: a posted GitHub item reports its issue so --migrate can point at `--feedback --pull`
  const posted = lib.classifyFeedbackItem(
    { id: 'sample-009', item: { fields: { Channel: 'github', Issue: 'example-org/sample-repo#41' } } },
    '0.60.1'
  );
  assert.strictEqual(posted.status, 'keep-open');
  assert.strictEqual(posted.issue, 'example-org/sample-repo#41');
  assert.strictEqual(at0601['sample-002'].issue, null, 'a local-channel item has no issue');
  assert.strictEqual(
    lib.classifyFeedbackItem({ id: 'sample-010', item: { fields: { Channel: 'github', Issue: 'not a ref' } } }, '0.60.1').issue,
    null,
    'an unparseable Issue value is not reported'
  );
  assert.strictEqual(byId('0.59.0')['sample-001'].status, 'keep-pending');
  assert.strictEqual(byId('0.60.10')['sample-003'].status, 'retire');
  console.log('PASS lib: tag pattern, supersedes parser, memory resolver, classifier');
}

function migrateTests() {
  const fx = fixture();
  const before = hashTree(fx.root, path.dirname(fx.inbox), fx.home);
  const r = migrate(fx);
  const after = hashTree(fx.root, path.dirname(fx.inbox), fx.home);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(before, after, 'fixture tree hash must be identical before and after --migrate (read-only)');

  const retireLines = r.out.split('\n').filter((l) => l.startsWith('retire:'));
  const keepLines = r.out.split('\n').filter((l) => l.startsWith('keep:'));
  assert.strictEqual(retireLines.length, 1, r.out);
  assert.ok(retireLines[0].includes('CLAUDE.md:3'), retireLines[0]);
  assert.strictEqual(
    retireLines[0],
    `retire: CLAUDE.md:3 — ${tag('sample-001')} — fixed in T-900, released in 0.60.0 (installed 0.60.1)`
  );
  assert.strictEqual(keepLines.length, 1, r.out);
  assert.strictEqual(keepLines[0], `keep: ${path.join('.claude', 'rules', 'project-local.md')}:4 — ${tag('sample-002')} — open`);
  assert.ok(!r.out.includes('untracked-but-ignored'), 'untracked files are outside git ls-files');
  assert.ok(r.out.includes('workaround retirement: 1 to retire, 1 to keep'), r.out);
  assert.ok(!r.out.includes('possible legacy workaround'), 'no legacy output without --legacy');
  console.log('PASS migrate: installed 0.60.1 -> one retire line, one keep line, tree untouched');

  // Installed 0.59.0: the fix is not installed yet.
  const old = fixture({ installed: '0.59.0' });
  const ro = migrate(old);
  assert.strictEqual(ro.status, 0, ro.all);
  assert.ok(!ro.out.split('\n').some((l) => l.startsWith('retire:')), ro.out);
  assert.ok(ro.out.includes(`keep: CLAUDE.md:3 — ${tag('sample-001')} — ships in 0.60.0`), ro.out);
  assert.ok(ro.out.includes('workaround retirement: 0 to retire, 2 to keep'), ro.out);
  console.log('PASS migrate: installed 0.59.0 -> keep ... ships in 0.60.0');

  // Tag whose item is not in the inbox.
  fs.appendFileSync(path.join(fx.root, 'CLAUDE.md'), `Stray ${tag('sample-077')} tag\n`);
  const ru = migrate(fx);
  assert.ok(ru.out.includes(`unknown item: ${tag('sample-077')}`), ru.out);
  console.log('PASS migrate: unknown item reported');

  // Tags inside harness memory are found too.
  fs.writeFileSync(path.join(fx.memDir, 'tagged.md'), `note ${tag('sample-001')}\n`);
  const rm = migrate(fx);
  assert.ok(rm.out.split('\n').some((l) => l.startsWith('retire:') && l.includes(path.join(fx.memDir, 'tagged.md'))), rm.out);
  fs.rmSync(path.join(fx.memDir, 'tagged.md'));

  // A tag whose inbox item records no Workaround field is still classified per tag.
  writeItem(fx.inbox, 'sample-003', { Disposition: 'fixed-in T-901', 'Ships in': 'released in 0.60.1' });
  fs.appendFileSync(path.join(fx.root, 'CLAUDE.md'), `Third ${tag('sample-003')} tag\n`);
  const rw = migrate(fx);
  assert.ok(
    rw.out.includes(`retire: CLAUDE.md:5 — ${tag('sample-003')} — fixed in T-901, released in 0.60.1 (installed 0.60.1)`),
    rw.out
  );

  // Alias absent: exit 1 naming the setter.
  const noAlias = fixture({ alias: null });
  const rn = migrate(noAlias);
  assert.strictEqual(rn.status, 1, rn.all);
  assert.ok(rn.all.includes('--feedback --set-alias'), rn.all);
  console.log('PASS migrate: absent alias exits 1 naming --feedback --set-alias');
}

function legacyTests() {
  const fx = fixture();
  const changelog = path.join(mkTmp('cl'), 'CHANGELOG.md');
  fs.writeFileSync(
    changelog,
    [
      '# Changelog',
      '## [Unreleased]',
      '- **Supersedes adopter workarounds:** `an unreleased phrase`',
      '## [0.70.0] — 2026-02-01',
      '- **Supersedes adopter workarounds:** `a future phrase`',
      '## [0.60.0] — 2026-01-01',
      '- **Supersedes adopter workarounds:** `commit HANDOFF.md`',
      '',
    ].join('\n')
  );
  fs.appendFileSync(path.join(fx.root, 'CLAUDE.md'), 'a future phrase and an unreleased phrase live here\n');
  git(fx.root, ['add', 'CLAUDE.md']);
  const extra = { MAVERICKS_MIGRATE_CHANGELOG: changelog };
  const before = hashTree(fx.root, path.dirname(fx.inbox), fx.home, path.dirname(changelog));
  const r = migrate(fx, ['--legacy'], extra);
  assert.strictEqual(before, hashTree(fx.root, path.dirname(fx.inbox), fx.home, path.dirname(changelog)), '--legacy is read-only');
  assert.strictEqual(r.status, 0, r.all);
  const legacy = r.out.split('\n').filter((l) => l.startsWith('possible legacy workaround:'));
  assert.strictEqual(legacy.length, 1, r.out);
  assert.strictEqual(
    legacy[0],
    `possible legacy workaround: ${path.join(fx.memDir, 'feedback_notes.md')}:3 — matches "commit HANDOFF.md" (superseded in 0.60.0)`
  );
  assert.ok(!r.out.includes('feedback_notes.md:4'), 'the unrelated memory line is not reported');
  assert.ok(!r.out.includes('a future phrase'), 'phrases of versions above the installed one are not matched');
  assert.ok(!r.out.includes('an unreleased phrase'), 'Unreleased phrases are not matched');
  // Without --legacy the same fixture reports no legacy hit.
  assert.ok(!migrate(fx, [], extra).out.includes('possible legacy workaround'));
  console.log('PASS migrate --legacy: memory-dir line reported once; unrelated, future and unreleased phrases silent');
}

function wrapperTests() {
  const canonical = fs.readFileSync(path.join(SCRIPTS_DIR, 'mavp-operator'), 'utf8');
  assert.ok(canonical.includes('== "--migrate"'), 'canonical wrapper dispatches --migrate');
  assert.ok(canonical.includes('mavp-operator-migrate.js" "$@"'), 'canonical passes "$@" through');
  const installer = fs.readFileSync(INSTALL, 'utf8');
  assert.ok(installer.includes('== "--migrate"'), 'adopter wrapper template dispatches --migrate');
  assert.ok(installer.includes('mavp-operator-migrate.js" "$@"'), 'adopter passes "$@" through');

  const fx = fixture();
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'mavp-operator'), '--migrate', '--legacy'], {
    cwd: fx.root,
    env: env(fx, { MAVERICKS_MIGRATE_CHANGELOG: path.join(fx.root, 'no-such-changelog.md') }),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes('workaround retirement: 1 to retire, 1 to keep'), r.stdout);
  console.log('PASS wrappers: --migrate dispatched with "$@" passthrough (--legacy reached the script)');
}

function installerAdvisoryTests() {
  const ADVISORY = /^workaround retirement: (\d+) tagged workaround\(s\) now fixed in the installed version — run \.\/scripts\/mavp-operator --migrate$/m;
  const target = fs.realpathSync(mkTmp('adopter'));
  const inbox = path.join(mkTmp('inbox'), 'queue');
  const home = fs.realpathSync(mkTmp('ihome'));
  const spawnEnv = Object.assign({}, process.env, { MAVERICKS_HOME: REPO_ROOT, MAVERICKS_INTAKE_DIR: inbox, HOME: home, USERPROFILE: home });
  const install = (args) => {
    const r = spawnSync(process.execPath, [INSTALL, ...args, '--stale-source-ok'], { input: 'y\n', env: spawnEnv, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  };
  install([target]);
  const psPath = path.join(target, 'PROCESS_STATE.json');
  const setAlias = (alias) => {
    const ps = JSON.parse(fs.readFileSync(psPath, 'utf8'));
    if (alias === null) delete ps.feedback_alias;
    else ps.feedback_alias = alias;
    fs.writeFileSync(psPath, JSON.stringify(ps, null, 2) + '\n');
  };

  // Absent alias, then alias with absent inbox: silent.
  setAlias(null);
  assert.doesNotMatch(install(['--update', target]), ADVISORY, 'no alias -> no advisory');
  setAlias('sample');
  assert.doesNotMatch(install(['--update', target]), ADVISORY, 'absent inbox -> no advisory');

  // Zero retirable items (fix releases after the installed version): silent.
  writeItem(inbox, 'sample-001', { Disposition: 'fixed-in T-900', 'Ships in': 'released in 999.0.0', Workaround: tag('sample-001') });
  writeItem(inbox, 'sample-002', { Disposition: 'deferred' });
  assert.doesNotMatch(install(['--update', target]), ADVISORY, 'zero retirable -> no advisory');

  // A fixed-in, released item with NO Workaround field is not a tagged workaround: silent.
  writeItem(inbox, 'sample-001', { Disposition: 'fixed-in T-900', 'Ships in': `released in ${MAVERICKS_VERSION}` });
  assert.doesNotMatch(install(['--update', target]), ADVISORY, 'fixed item without a Workaround field -> no advisory');

  // One retirable item (released at the installed version): exactly one advisory line, after "Update complete."
  writeItem(inbox, 'sample-001', { Disposition: 'fixed-in T-900', 'Ships in': `released in ${MAVERICKS_VERSION}`, Workaround: tag('sample-001') });
  const out = install(['--update', target]);
  const m = out.match(ADVISORY);
  assert.ok(m, out);
  assert.strictEqual(m[1], '1');
  assert.strictEqual((out.match(/^workaround retirement:/gm) || []).length, 1, 'exactly one advisory line');
  assert.ok(out.indexOf('Update complete.') !== -1 && out.indexOf('Update complete.') < out.indexOf(m[0]), 'advisory follows the Update complete line');
  console.log('PASS installer: advisory appears on --update exactly when the retire count is nonzero');
}

try {
  libTests();
  migrateTests();
  legacyTests();
  wrapperTests();
  installerAdvisoryTests();
  console.log('test-migrate-workarounds: all assertions passed');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
}
