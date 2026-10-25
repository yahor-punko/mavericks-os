'use strict';
// T-829 — framework-side `--intake`: list with dedupe / version-lag hints,
// `--brief`, `--triage` with CHANGELOG-derived Ships in, `--publish-answers`,
// and the two additive `--agent` counters.
//
// Expected values come from the T-829 acceptance criteria, not from observed
// behaviour. Hermetic: MAVERICKS_PROJECT_ROOT points at a fixture framework
// root and MAVERICKS_INTAKE_DIR at a temp inbox in every spawn; the real home
// directory is never read or written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const INTAKE = path.join(SCRIPTS_DIR, 'mavp-operator-intake.js');
const AGENT = path.join(SCRIPTS_DIR, 'mavp-operator-agent.js');
const lib = require(path.join(SCRIPTS_DIR, 'mavp-operator-lib.js'));

const tmpRoots = [];
process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `intake-${label}-`));
  tmpRoots.push(d);
  return d;
}

const today = () => new Date().toISOString().slice(0, 10);

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- Something new (T-901).',
  '',
  '## [0.60.0] — 2026-01-01',
  '',
  '- Something shipped (T-900).',
  '',
  '## [0.50.0] — 2025-01-01',
  '',
  '- Old thing (T-50).',
  '',
].join('\n');

// Task headings are built at runtime so no literal heading-shaped line sits at column zero here.
const heading = (id, title) => `${'#'.repeat(3)} ${id} — ${title}`;
const BACKLOG = [
  '# BACKLOG',
  '',
  '## Active Wave',
  '',
  heading('T-901', 'Active fix'),
  '- **Status:** planned',
  '',
  heading('T-902', 'Fix not in the changelog yet'),
  '- **Status:** planned',
  '',
  '## Wave 1 — archived',
  '',
  heading('T-900', 'Archived fix'),
  '- **Status:** merged',
  '',
].join('\n');

function frameworkRoot(opts) {
  const root = mkTmp('fw');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'mavp-operator-lib.js'), '// fixture marker\n');
  fs.writeFileSync(path.join(root, 'scripts', 'mavp-version.js'), "module.exports = { MAVERICKS_VERSION: '0.60.1' };\n");
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), BACKLOG);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), (opts && opts.changelog) || CHANGELOG);
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n\n');
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify({ initiative: 'fixture', stage: 'execution', wave: 1, active_slices: [], next_action: null, last_updated: '2026-01-01' }, null, 2) + '\n'
  );
  return root;
}

function env(root, inbox) {
  return { ...process.env, MAVERICKS_PROJECT_ROOT: root, MAVERICKS_INTAKE_DIR: inbox, MAVP_PRIVATE_NAMES: '' };
}

function run(script, args, root, inbox) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env: env(root, inbox), encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}
const intake = (args, root, inbox) => run(INTAKE, args, root, inbox);

function writeItem(inbox, id, o) {
  const opts = Object.assign(
    {
      title: 'Wrapper drops a flag',
      kind: 'bug',
      severity: 'normal',
      area: 'operator wrapper',
      version: '0.60.1',
      channel: 'local',
      extra: {},
      observed: 'The flag was ignored.',
      evidence: 'Ran the command; nothing happened.',
      proposal: 'Dispatch the flag.',
    },
    o || {}
  );
  const alias = id.replace(/-\d+$/, '');
  const fields = Object.assign(
    { Adopter: alias, 'Framework version': opts.version, Kind: opts.kind, Severity: opts.severity, Area: opts.area, Submitted: '2026-01-02', Channel: opts.channel },
    opts.extra
  );
  fs.mkdirSync(inbox, { recursive: true });
  const text = lib.renderFeedbackItem({
    id,
    title: opts.title,
    fields,
    sections: { Observed: opts.observed, Evidence: opts.evidence, Proposal: opts.proposal },
  });
  fs.writeFileSync(path.join(inbox, `${id}.md`), text);
  return path.join(inbox, `${id}.md`);
}

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Pure helpers: computeShipsIn / semverCompare (criterion 2 and 4)
// ---------------------------------------------------------------------------
{
  assert.strictEqual(lib.semverCompare('0.60.0', '0.59.9'), 1);
  assert.strictEqual(lib.semverCompare('0.59.0', '0.60.0'), -1);
  assert.strictEqual(lib.semverCompare('1.0.0', '1.0.0'), 0);
  assert.strictEqual(lib.computeShipsIn(CHANGELOG, 'T-900', '0.60.1'), 'released in 0.60.0');
  assert.strictEqual(lib.computeShipsIn(CHANGELOG, 'T-901', '0.60.1'), 'unreleased (next after 0.60.1)');
  assert.strictEqual(lib.computeShipsIn(CHANGELOG, 'T-902', '0.60.1'), 'not yet in CHANGELOG');
  // A longer id sharing a prefix must not match, and a bare mention without the parenthetical does not count.
  assert.strictEqual(lib.computeShipsIn(CHANGELOG, 'T-90', '0.60.1'), 'not yet in CHANGELOG');
  assert.strictEqual(lib.computeShipsIn(CHANGELOG, 'T-50', '0.60.1'), 'released in 0.50.0');
  const multi = '## [Unreleased]\n\n- A (T-1, T-2).\n\n## [0.2.0]\n\n- B (T-3).\n\n## [0.1.0]\n\n- C (T-3).\n';
  assert.strictEqual(lib.computeShipsIn(multi, 'T-2', '0.2.0'), 'unreleased (next after 0.2.0)');
  assert.strictEqual(lib.computeShipsIn(multi, 'T-3', '0.2.0'), 'released in 0.1.0', 'lowest citing version wins');
  assert.strictEqual(lib.computeShipsIn('## [0.3.0]\n\n- see T-7 for more\n', 'T-7', '0.3.0'), 'not yet in CHANGELOG');
  console.log('PASS computeShipsIn / semverCompare');
}

// ---------------------------------------------------------------------------
// Criterion 1: refuses outside the framework repository
// ---------------------------------------------------------------------------
{
  const notFramework = mkTmp('adopter');
  const inbox = path.join(mkTmp('inbox'), 'q');
  const r = intake([], notFramework, inbox);
  assert.strictEqual(r.status, 1, r.all);
  assert.ok(
    r.all.includes(`--intake runs in the framework repository (no scripts/mavp-operator-lib.js under ${notFramework})`),
    r.all
  );
  console.log('PASS refuses outside the framework repository');
}

// ---------------------------------------------------------------------------
// Criterion 2: list, hints, read-only
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const p1 = writeItem(inbox, 'sample-001', { area: '--close-session', title: 'First report', extra: { Disposition: 'by-design', Triaged: '2026-01-03' } });
  const p2 = writeItem(inbox, 'sample-002', { area: '--Close-Session', title: 'Second report' });
  const p3 = writeItem(inbox, 'other-001', { area: '--close-session', title: 'Other adopter', kind: 'proposal', severity: 'low' });
  const p4 = writeItem(inbox, 'laggard-001', {
    area: 'something else',
    title: 'Laggard bug',
    version: '0.59.0',
    extra: { Disposition: 'fixed-in T-900', 'Ships in': 'released in 0.60.0', Triaged: '2026-01-03' },
  });
  const before = [p1, p2, p3, p4].map(read);
  const repoBefore = ['BACKLOG.md', 'CHANGELOG.md', 'PROCESS_STATE.json', 'TASK_STATUS.md'].map((f) => read(path.join(root, f)));

  const r = intake([], root, inbox);
  assert.strictEqual(r.status, 0, r.all);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('sample-002 bug/normal [local] sample@0.60.1 — Second report — new'), r.out);
  assert.ok(lines.includes('sample-001 bug/normal [local] sample@0.60.1 — First report — triaged'), r.out);
  assert.ok(lines.includes('other-001 proposal/low [local] other@0.60.1 — Other adopter — new'), r.out);
  const idx = lines.indexOf('sample-002 bug/normal [local] sample@0.60.1 — Second report — new');
  assert.ok(/possible repeat of sample-001 \(by-design, /.test(lines[idx + 1]), `hint follows the item: ${lines[idx + 1]}`);
  const otherIdx = lines.indexOf('other-001 proposal/low [local] other@0.60.1 — Other adopter — new');
  assert.ok(!/possible repeat/.test(lines[otherIdx + 1] || ''), 'a different alias gets no repeat hint');
  assert.ok(
    r.out.includes('alias laggard is on 0.59.0; 1 fixes for laggard are unreleased: laggard-001'),
    `version-lag hint missing:\n${r.out}`
  );
  assert.ok(!/alias sample is on/.test(r.out), 'alias sample has no fixed-in items, so no lag hint');
  assert.deepStrictEqual([p1, p2, p3, p4].map(read), before, 'list does not touch the inbox');
  assert.deepStrictEqual(
    ['BACKLOG.md', 'CHANGELOG.md', 'PROCESS_STATE.json', 'TASK_STATUS.md'].map((f) => read(path.join(root, f))),
    repoBefore,
    'list does not touch repo artifacts'
  );

  // an unreleased fix also lags
  const inbox2 = path.join(mkTmp('inbox'), 'q');
  writeItem(inbox2, 'sample-001', { extra: { Disposition: 'fixed-in T-901', 'Ships in': 'unreleased (next after 0.60.1)', Triaged: '2026-01-03' } });
  const r2 = intake([], root, inbox2);
  assert.ok(r2.out.includes('alias sample is on 0.60.1; 1 fixes for sample are unreleased: sample-001'), r2.out);
  console.log('PASS list, repeat hint, version-lag hint, read-only');
}

// ---------------------------------------------------------------------------
// Criterion 3: --brief
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const observed = ['Line one of the observation.', '', '```', '## not a heading', '```', '', 'Trailing paragraph with  double  spaces.'].join('\n');
  writeItem(inbox, 'sample-001', { area: 'brief area', title: 'Briefed item', observed, evidence: 'Evidence body.', proposal: 'Proposal body.' });
  writeItem(inbox, 'sample-002', { area: 'brief area', title: 'Triaged item', extra: { Disposition: 'deferred', Triaged: '2026-01-03' } });
  writeItem(inbox, 'sample-003', { area: 'Brief Area', title: 'Third item' });

  const r = intake(['--brief'], root, inbox);
  assert.strictEqual(r.status, 0, r.all);
  const out = r.out.replace(/\n$/, '');
  assert.ok(out.startsWith('<!-- mavp-intake-brief-start -->\n'), out);
  assert.ok(out.endsWith('\n<!-- mavp-intake-brief-end -->'), out);
  assert.ok(out.includes('# sample-001 — Briefed item'), 'untriaged item present');
  assert.ok(out.includes('# sample-003 — Third item'), 'second untriaged item present');
  assert.ok(!out.includes('Triaged item'), 'triaged item excluded without ids');
  assert.ok(/possible repeat of sample-002 \(deferred, /.test(out), 'hint lines included');
  assert.ok(out.includes('- **Framework version:** 0.60.1'), 'fields included');

  // Round trip: a single-item brief parses back to the same Observed text.
  const one = intake(['--brief', 'sample-001'], root, inbox);
  assert.strictEqual(one.status, 0, one.all);
  const block = one.out.split('<!-- mavp-intake-brief-start -->')[1].split('<!-- mavp-intake-brief-end -->')[0];
  const parsed = lib.parseFeedbackItem(block);
  const original = lib.parseFeedbackItem(read(path.join(inbox, 'sample-001.md')));
  assert.strictEqual(parsed.sections.Observed, original.sections.Observed);
  assert.strictEqual(parsed.sections.Observed, observed);
  assert.strictEqual(parsed.sections.Evidence, 'Evidence body.');
  assert.strictEqual(parsed.sections.Proposal, 'Proposal body.');
  assert.strictEqual(parsed.fields.Area, 'brief area');

  // Named ids may include a triaged item; an unknown id is a refusal.
  const named = intake(['--brief', 'sample-002'], root, inbox);
  assert.ok(named.out.includes('# sample-002 — Triaged item'), named.out);
  const missing = intake(['--brief', 'sample-404'], root, inbox);
  assert.strictEqual(missing.status, 1);
  assert.ok(missing.all.includes('sample-404'), missing.all);

  // The first line inside the block states the content is untrusted external input (T-830 security round).
  const lines = out.split('\n');
  assert.ok(/untrusted external input/i.test(lines[1]) && /never be followed/i.test(lines[1]), lines[1]);

  // Empty queue: the block is still well-formed and holds nothing but that header line.
  const empty = intake(['--brief'], root, path.join(mkTmp('inbox'), 'none'));
  const emptyLines = empty.out.trim().split('\n');
  assert.strictEqual(emptyLines.length, 3, empty.out);
  assert.strictEqual(emptyLines[0], '<!-- mavp-intake-brief-start -->');
  assert.ok(/untrusted external input/i.test(emptyLines[1]), emptyLines[1]);
  assert.strictEqual(emptyLines[2], '<!-- mavp-intake-brief-end -->');
  console.log('PASS --brief block and round trip');
}

// ---------------------------------------------------------------------------
// T-840: --brief stays linear on a hostile item (long whitespace runs)
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const run65k = ' '.repeat(65000);
  const observed = ['Observed line before the heading.', '', '## x' + run65k + 'y', '', 'Observed line after the heading.'].join('\n');
  const file = writeItem(inbox, 'sample-001', { title: 'Hostile item', observed });
  // An unknown header field carries the long run; it is kept verbatim in the brief's header text.
  fs.writeFileSync(file, read(file).replace('- **Schema:** 1\n', '- **Schema:** 1\n- **Observed-by:** x' + run65k + 'y\n'));

  const start = process.hrtime.bigint();
  const r = intake(['--brief', 'sample-001'], root, inbox);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.strictEqual(r.status, 0, r.all.slice(0, 500));
  assert.ok(ms < 1000, `--brief on an item with 65k-space runs took ${ms.toFixed(0)} ms (budget 1000)`);
  assert.ok(r.out.includes('Observed line before the heading.'), 'the brief still carries the item Observed section');
  assert.ok(r.out.includes('- **Observed-by:** x' + run65k + 'y'), 'the header line with the long run is kept');
  console.log('PASS --brief on a hostile long-whitespace item completes quickly');
}

// ---------------------------------------------------------------------------
// Criterion 4: --triage
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const workaround = { Workaround: 'mavp-workaround:sample-001' };

  // fixed-in a released task, with a Workaround
  const p1 = writeItem(inbox, 'sample-001', { extra: workaround });
  const orig1 = read(p1);
  const r1 = intake(['--triage', 'sample-001', '--disposition', 'fixed-in T-900', '--note', 'Fixed in the next patch.'], root, inbox);
  assert.strictEqual(r1.status, 0, r1.all);
  const after1 = read(p1);
  const f1 = lib.parseFeedbackItem(after1);
  assert.strictEqual(f1.fields.Disposition, 'fixed-in T-900');
  assert.strictEqual(f1.fields['Ships in'], 'released in 0.60.0');
  assert.strictEqual(f1.fields['Retire workaround'], 'after 0.60.0');
  assert.strictEqual(f1.fields.Triaged, today());
  assert.strictEqual(f1.sections.Answer, 'Fixed in the next patch.');
  // every other line of the item is byte-unchanged
  const added = ['- **Disposition:** fixed-in T-900', '- **Ships in:** released in 0.60.0', '- **Retire workaround:** after 0.60.0', `- **Triaged:** ${today()}`];
  const withoutAdded = after1.split('\n').filter((l) => !added.includes(l)).join('\n');
  assert.ok(
    withoutAdded.startsWith(orig1.replace(/\s+$/, '')),
    'removing the four written lines leaves the original item byte-for-byte as a prefix'
  );
  assert.strictEqual(withoutAdded.slice(orig1.replace(/\s+$/, '').length), '\n\n## Answer\n\nFixed in the next patch.\n', 'only the Answer section is appended');

  // fixed-in an unreleased task, with a Workaround
  const p2 = writeItem(inbox, 'sample-002', { extra: workaround });
  const r2 = intake(['--triage', 'sample-002', '--disposition', 'fixed-in T-901'], root, inbox);
  assert.strictEqual(r2.status, 0, r2.all);
  const f2 = lib.parseFeedbackItem(read(p2));
  assert.strictEqual(f2.fields['Ships in'], 'unreleased (next after 0.60.1)');
  assert.strictEqual(f2.fields['Retire workaround'], 'after next release');
  assert.strictEqual(f2.sections.Answer, undefined, 'no note, no Answer section');

  // fixed-in a task not in the CHANGELOG, no Workaround: no Retire workaround line
  const p3 = writeItem(inbox, 'sample-003');
  const r3 = intake(['--triage', 'sample-003', '--disposition', 'fixed-in T-902'], root, inbox);
  assert.strictEqual(r3.status, 0, r3.all);
  const f3 = lib.parseFeedbackItem(read(p3));
  assert.strictEqual(f3.fields['Ships in'], 'not yet in CHANGELOG');
  assert.ok(!('Retire workaround' in f3.fields), 'no Workaround field means no Retire workaround');

  // a task heading that does not exist: exit 1, file byte-identical
  const p4 = writeItem(inbox, 'sample-004', { extra: workaround });
  const orig4 = read(p4);
  const r4 = intake(['--triage', 'sample-004', '--disposition', 'fixed-in T-999'], root, inbox);
  assert.strictEqual(r4.status, 1, r4.all);
  assert.ok(r4.all.includes('T-999'), r4.all);
  assert.strictEqual(read(p4), orig4, 'file untouched when the task does not exist');

  // an invalid disposition: exit 1, grammar listed, file untouched
  for (const bad of ['fixed', 'fixed-in', 'fixed-in 900', 'wontfix', 'duplicate-of', 'by-design now', '']) {
    const r = intake(['--triage', 'sample-004', '--disposition', bad], root, inbox);
    assert.strictEqual(r.status, 1, `"${bad}" should be refused: ${r.all}`);
    for (const g of ['fixed-in T-NNN', 'by-design', 'deferred', 'duplicate-of <item>', 'not-reproduced']) {
      assert.ok(r.all.includes(g), `grammar line ${g} missing for "${bad}": ${r.all}`);
    }
    assert.strictEqual(read(p4), orig4, `file untouched after refusing "${bad}"`);
  }

  // an unknown item id
  const r5 = intake(['--triage', 'sample-404', '--disposition', 'deferred'], root, inbox);
  assert.strictEqual(r5.status, 1);
  assert.ok(r5.all.includes('sample-404'), r5.all);

  // the remaining accepted dispositions, with and without a note
  for (const [n, d] of [['5', 'by-design'], ['6', 'deferred'], ['7', 'duplicate-of sample-001'], ['8', 'not-reproduced']]) {
    const id = `sample-00${n}`;
    const p = writeItem(inbox, id, { extra: workaround });
    const r = intake(['--triage', id, '--disposition', d, '--note', `Note for ${d}.`], root, inbox);
    assert.strictEqual(r.status, 0, `${d}: ${r.all}`);
    const f = lib.parseFeedbackItem(read(p));
    assert.strictEqual(f.fields.Disposition, d);
    assert.strictEqual(f.fields.Triaged, today());
    assert.strictEqual(f.sections.Answer, `Note for ${d}.`);
    assert.ok(!('Ships in' in f.fields), `${d}: no Ships in`);
    assert.ok(!('Retire workaround' in f.fields), `${d}: no Retire workaround`);
  }

  // re-triage replaces the Answer and clears a stale Ships in
  const rt = intake(['--triage', 'sample-001', '--disposition', 'deferred', '--note', 'Changed my mind.'], root, inbox);
  assert.strictEqual(rt.status, 0, rt.all);
  const fr = lib.parseFeedbackItem(read(p1));
  assert.strictEqual(fr.fields.Disposition, 'deferred');
  assert.strictEqual(fr.fields['Ships in'], '');
  assert.strictEqual(fr.fields['Retire workaround'], '');
  assert.strictEqual(fr.sections.Answer, 'Changed my mind.');
  console.log('PASS --triage');
}

// ---------------------------------------------------------------------------
// Criterion 5: --publish-answers
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const p1 = writeItem(inbox, 'sample-001', { extra: { Workaround: 'mavp-workaround:sample-001' } });
  intake(['--triage', 'sample-001', '--disposition', 'fixed-in T-901', '--note', 'Soon.'], root, inbox);
  const pg = writeItem(inbox, 'sample-002', { channel: 'github', extra: { Issue: 'example-org/sample-repo#12', Disposition: 'fixed-in T-901', 'Ships in': 'unreleased (next after 0.60.1)', Triaged: '2026-01-03' } });
  const pn = writeItem(inbox, 'sample-003');
  const pb = writeItem(inbox, 'sample-004', { extra: { Disposition: 'by-design', Triaged: '2026-01-03' } });
  const mid = lib.parseFeedbackItem(read(p1));
  assert.strictEqual(mid.fields['Retire workaround'], 'after next release');
  const githubBefore = read(pg);
  const newBefore = read(pn);
  const byDesignBefore = read(pb);

  // T-901 ships: move its entry under a numbered section and rerun
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG.replace('- Something new (T-901).\n', '').replace('- Something shipped (T-900).', '- Something shipped (T-900).\n- Something new (T-901).'));
  const before = read(p1);
  const r = intake(['--publish-answers'], root, inbox);
  assert.strictEqual(r.status, 0, r.all);
  assert.ok(r.out.includes('would post: sample-002 (#12)'), r.out);
  const after = read(p1);
  const f = lib.parseFeedbackItem(after);
  assert.strictEqual(f.fields['Ships in'], 'released in 0.60.0');
  assert.strictEqual(f.fields['Retire workaround'], 'after 0.60.0');
  const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  assert.deepStrictEqual(changed, ['- **Ships in:** released in 0.60.0', '- **Retire workaround:** after 0.60.0'], 'only the two lines change');
  assert.strictEqual(read(pg), githubBefore, 'github-channel item skipped');
  assert.strictEqual(read(pn), newBefore, 'untriaged item untouched');
  assert.strictEqual(read(pb), byDesignBefore, 'non-fixed-in item untouched');

  // idempotent
  const again = intake(['--publish-answers'], root, inbox);
  assert.strictEqual(read(p1), after, 'second run changes nothing');
  assert.ok(/unchanged sample-001/.test(again.out), again.out);
  console.log('PASS --publish-answers');
}

// ---------------------------------------------------------------------------
// Criterion 6: --agent counters
// ---------------------------------------------------------------------------
{
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  const agent = (r, i) => {
    const out = run(AGENT, [], r, i);
    assert.strictEqual(out.status, 0, out.all);
    return JSON.parse(out.out);
  };
  assert.ok(!('intake_untriaged' in agent(root, inbox)), 'omitted when the inbox is empty');
  writeItem(inbox, 'sample-001');
  writeItem(inbox, 'sample-002');
  writeItem(inbox, 'sample-003', { extra: { Disposition: 'deferred', Triaged: '2026-01-03' } });
  const a = agent(root, inbox);
  assert.strictEqual(a.intake_untriaged, 2);
  assert.ok(!('feedback_answers_unacked' in a), 'adopter counter is not reported at the framework root');
  intake(['--triage', 'sample-001', '--disposition', 'deferred'], root, inbox);
  intake(['--triage', 'sample-002', '--disposition', 'deferred'], root, inbox);
  assert.ok(!('intake_untriaged' in agent(root, inbox)), 'omitted at zero');

  // adopter root: no lib under it, feedback_alias set
  const adopter = mkTmp('adopter');
  fs.writeFileSync(path.join(adopter, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n');
  fs.writeFileSync(path.join(adopter, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n\n');
  fs.writeFileSync(
    path.join(adopter, 'PROCESS_STATE.json'),
    JSON.stringify({ initiative: 'adopter', stage: 'execution', wave: 1, active_slices: [], next_action: null, last_updated: '2026-01-01', feedback_alias: 'sample' }, null, 2) + '\n'
  );
  writeItem(inbox, 'other-001', { extra: { Disposition: 'deferred', Triaged: '2026-01-03' } });
  writeItem(inbox, 'sample-004', { extra: { Disposition: 'deferred', Triaged: '2026-01-03', Acknowledged: '2026-01-04' } });
  const b = agent(adopter, inbox);
  // sample-001, sample-002, sample-003 have a Disposition and no Acknowledged; sample-004 is acknowledged; other-001 is another alias
  assert.strictEqual(b.feedback_answers_unacked, 3);
  assert.ok(!('intake_untriaged' in b), 'framework counter is not reported at an adopter root');
  for (const id of ['sample-001', 'sample-002', 'sample-003']) {
    const p = path.join(inbox, `${id}.md`);
    fs.writeFileSync(p, lib.setFeedbackField(read(p), 'Acknowledged', '2026-01-05'));
  }
  assert.ok(!('feedback_answers_unacked' in agent(adopter, inbox)), 'omitted at zero');
  console.log('PASS --agent counters');
}

// ---------------------------------------------------------------------------
// Criterion 7: both wrappers dispatch --intake
// ---------------------------------------------------------------------------
{
  const canonical = read(path.join(SCRIPTS_DIR, 'mavp-operator'));
  assert.ok(/\$\{1-\}" == "--intake"/.test(canonical), 'canonical wrapper dispatches --intake');
  assert.ok(canonical.includes('mavp-operator-intake.js" "$@"'), 'canonical passes "$@" through');
  const installer = read(path.join(SCRIPTS_DIR, 'mavp-install.js'));
  assert.ok(installer.includes('== "--intake"'), 'adopter wrapper template dispatches --intake');
  assert.ok(installer.includes('mavp-operator-intake.js" "$@"'), 'adopter passes "$@" through');
  const root = frameworkRoot();
  const inbox = path.join(mkTmp('inbox'), 'q');
  writeItem(inbox, 'sample-001', { title: 'Via the wrapper' });
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'mavp-operator'), '--intake'], { cwd: root, env: env(root, inbox), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes('sample-001 bug/normal [local] sample@0.60.1 — Via the wrapper — new'), r.stdout);
  console.log('PASS both wrappers dispatch --intake; canonical wrapper runs it');
}

console.log('test-intake: all assertions passed');
