'use strict';
// T-828 — feedback item schema, intake resolver and the adopter-side
// `--feedback` command (local channel).
//
// Expected values come from the T-828 acceptance criteria, not from observed
// behaviour. Hermetic: MAVERICKS_INTAKE_DIR is pinned to a temp dir in every
// spawn and the real home directory is never read or written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const SCRIPT = path.join(SCRIPTS_DIR, 'mavp-operator-feedback.js');
const LIB_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-lib.js');
const TEMPLATE = path.join(SCRIPTS_DIR, '..', 'templates', 'FEEDBACK_ITEM_TEMPLATE.md');
const lib = require(LIB_PATH);
const { readNamesFileRaw } = require('./mavp-private-names-guard.js');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const tmpRoots = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `fb-${label}-`));
  tmpRoots.push(d);
  return d;
}

function spawnEnv(root, inbox) {
  return {
    ...process.env,
    MAVERICKS_PROJECT_ROOT: root,
    MAVERICKS_INTAKE_DIR: inbox,
    MAVP_PRIVATE_NAMES: '',
  };
}

function run(args, root, inbox) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: spawnEnv(root, inbox),
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}

function fixture(state) {
  const root = mkTmp('root');
  const inbox = path.join(mkTmp('inbox'), 'queue');
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify(
      Object.assign(
        {
          initiative: 'fixture initiative',
          wave: 3,
          wave_goal: 'fixture goal',
          last_updated: '2026-01-01',
          mavericks_version: '9.9.9',
          feedback_alias: 'sample',
        },
        state || {}
      ),
      null,
      2
    ) + '\n'
  );
  return { root, inbox };
}

function itemInput(opts) {
  const o = Object.assign(
    {
      title: 'Wrapper drops a flag',
      kind: 'bug',
      severity: 'normal',
      area: 'operator wrapper',
      observed: 'The flag was ignored.',
      evidence: 'Ran the command; nothing happened.',
      proposal: 'Dispatch the flag.',
      extra: '',
    },
    opts || {}
  );
  const parts = [
    `# <alias>-NNN — ${o.title}`,
    '',
    '- **Schema:** 1',
    '- **Item:** <alias>-NNN',
    '- **Adopter:** <alias>',
    '- **Framework version:** <version>',
    `- **Kind:** ${o.kind}`,
    `- **Severity:** ${o.severity}`,
    `- **Area:** ${o.area}`,
    '- **Submitted:** <YYYY-MM-DD>',
    '- **Channel:** <local|github>',
  ];
  if (o.extra) parts.push(o.extra);
  parts.push('', '## Observed', '', o.observed);
  if (o.evidence !== null) parts.push('', '## Evidence', '', o.evidence);
  parts.push('', '## Proposal', '', o.proposal, '');
  return parts.join('\n');
}

function writeInput(dir, text, name) {
  const p = path.join(dir, name || 'input.md');
  fs.writeFileSync(p, text);
  return p;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Template (criterion 1)
// ---------------------------------------------------------------------------
{
  const text = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(/^# <alias>-NNN — <title>$/m.test(text), 'template title line shape');
  const parsed = lib.parseFeedbackItem(text);
  assert.strictEqual(parsed.fields.Schema, '1');
  for (const name of [
    'Schema', 'Item', 'Adopter', 'Framework version', 'Kind', 'Severity', 'Area', 'Submitted',
    'Channel', 'Issue', 'Workaround', 'Disposition', 'Ships in', 'Retire workaround', 'Triaged',
    'Published', 'Acknowledged',
  ]) {
    assert.ok(text.includes(`- **${name}:**`), `template carries field ${name}`);
  }
  for (const name of ['Observed', 'Evidence', 'Proposal', 'Answer']) {
    assert.ok(new RegExp(`^## ${name}$`, 'm').test(text), `template carries section ${name}`);
  }
  assert.ok(!text.includes('/' + 'Users' + '/'), 'template holds no absolute user path');
  console.log('PASS template carries every field and section, parses at schema 1');
}

// ---------------------------------------------------------------------------
// Library (criterion 2)
// ---------------------------------------------------------------------------
{
  assert.strictEqual(lib.FEEDBACK_SCHEMA_VERSION, 1);
  assert.ok(lib.FEEDBACK_ALIAS_PATTERN.test('sample'));
  assert.ok(!lib.FEEDBACK_ALIAS_PATTERN.test('my-repo'));
  assert.ok(!lib.FEEDBACK_ALIAS_PATTERN.test('a'));
  assert.ok(!lib.FEEDBACK_ALIAS_PATTERN.test('9abc'));
  assert.ok(lib.FEEDBACK_ALIAS_PATTERN.test('a' + 'b'.repeat(23)));
  assert.ok(!lib.FEEDBACK_ALIAS_PATTERN.test('a' + 'b'.repeat(24)));

  // unknown fields ignored; known fields and sections parsed
  const md = [
    '# sample-007 — A title — with a dash',
    '',
    '- **Schema:** 1',
    '- **Item:** sample-007',
    '- **Mystery:** ignored',
    '- **Kind:** question',
    '',
    '## Observed',
    '',
    'line one',
    '```',
    '## Evidence',
    '```',
    '',
    '## Evidence',
    '',
    'real evidence',
    '',
  ].join('\n');
  const p = lib.parseFeedbackItem(md);
  assert.strictEqual(p.id, 'sample-007');
  assert.strictEqual(p.title, 'A title — with a dash');
  assert.strictEqual(p.fields.Kind, 'question');
  assert.ok(!('Mystery' in p.fields), 'unknown field ignored');
  assert.strictEqual(p.sections.Evidence, 'real evidence');
  assert.ok(p.sections.Observed.includes('## Evidence'), 'fenced heading stays in its section');

  // newer schema throws naming the version
  assert.throws(() => lib.parseFeedbackItem(md.replace('**Schema:** 1', '**Schema:** 2')), /version 2/);
  assert.throws(() => lib.parseFeedbackItem('# x — y\n\n- **Kind:** bug\n'), /Schema/);

  // render -> parse round trip
  const rendered = lib.renderFeedbackItem({
    id: 'sample-010',
    title: 'Round trip',
    fields: { Adopter: 'sample', Kind: 'bug', Severity: 'low', Area: 'docs', Disposition: 'fixed-in T-900' },
    sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
  });
  const rp = lib.parseFeedbackItem(rendered);
  assert.strictEqual(rp.id, 'sample-010');
  assert.strictEqual(rp.fields.Disposition, 'fixed-in T-900');
  assert.strictEqual(rp.fields.Schema, '1');
  assert.deepStrictEqual([rp.sections.Observed, rp.sections.Evidence, rp.sections.Proposal], ['o', 'e', 'p']);

  // resolveIntakeDir: env override, else <home>/.mavericks-intake
  const saved = process.env.MAVERICKS_INTAKE_DIR;
  process.env.MAVERICKS_INTAKE_DIR = path.join(os.tmpdir(), 'fb-override');
  assert.strictEqual(lib.resolveIntakeDir(), path.resolve(path.join(os.tmpdir(), 'fb-override')));
  delete process.env.MAVERICKS_INTAKE_DIR;
  assert.strictEqual(lib.resolveIntakeDir(), path.join(os.homedir(), '.mavericks-intake'));
  if (saved !== undefined) process.env.MAVERICKS_INTAKE_DIR = saved;

  // listIntakeItems + allocation order
  const dir = path.join(mkTmp('alloc'), 'queue');
  assert.deepStrictEqual(lib.listIntakeItems(dir), [], 'missing dir lists empty');
  assert.strictEqual(lib.allocateFeedbackItemId(dir, 'sample').id, 'sample-001');
  assert.strictEqual(lib.allocateFeedbackItemId(dir, 'sample').id, 'sample-002');
  assert.strictEqual(lib.allocateFeedbackItemId(dir, 'other').id, 'other-001');
  fs.writeFileSync(path.join(dir, 'sample-009.md'), '');
  assert.strictEqual(lib.allocateFeedbackItemId(dir, 'sample').id, 'sample-010', 'highest N plus one');
  assert.throws(() => lib.allocateFeedbackItemId(dir, 'my-repo'), /alias/);
  assert.deepStrictEqual(
    lib.listIntakeItems(dir).map((e) => e.id),
    ['other-001', 'sample-001', 'sample-002', 'sample-009', 'sample-010']
  );
  console.log('PASS library parse/render/resolve/list/allocate');
}

// ---------------------------------------------------------------------------
// Exclusive-create allocation (criterion 2) — deterministic stale-listing race
// ---------------------------------------------------------------------------
{
  const dir = path.join(mkTmp('race'), 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const existing = path.join(dir, 'sample-001.md');
  fs.writeFileSync(existing, 'EXISTING');
  const realReaddir = fs.readdirSync;
  let stale = true;
  fs.readdirSync = function patched(p, ...rest) {
    if (stale && path.resolve(String(p)) === path.resolve(dir)) {
      stale = false;
      return []; // a concurrent allocator's view from before sample-001 existed
    }
    return realReaddir.call(fs, p, ...rest);
  };
  let result;
  try {
    result = lib.allocateFeedbackItemId(dir, 'sample', (id) => `body for ${id}`);
  } finally {
    fs.readdirSync = realReaddir;
  }
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'EXISTING', 'existing item never overwritten');
  assert.strictEqual(result.id, 'sample-002', 'collision re-scans and takes the next id');
  assert.strictEqual(fs.readFileSync(result.path, 'utf8'), 'body for sample-002');
  console.log('PASS exclusive-create allocation survives a stale listing');
}

// ---------------------------------------------------------------------------
// T-840 — trailing-whitespace handling in parse/render is linear (criteria 1, 3, 4)
// ---------------------------------------------------------------------------
{
  const RUN = ' '.repeat(65336);
  const timed = (fn) => {
    const start = process.hrtime.bigint();
    const value = fn();
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
  };
  const budgetMs = 200;
  const header = ['# sample-001 — title', '- **Schema:** 1', '- **Item:** sample-001', ''];

  // (1) Four hostile shapes, each under 200 ms (the former patterns took more than two seconds each).
  const observedItem = header.concat(['## Observed', '', RUN + 'x', '', '## Evidence', '', 'e']).join('\n');
  const a = timed(() => lib.parseFeedbackItem(observedItem));
  assert.strictEqual(a.value.sections.Observed, RUN + 'x', 'a long whitespace run inside a section survives parsing');
  assert.ok(a.ms < budgetMs, `parse of a section with a 65k-space run took ${a.ms.toFixed(1)} ms (budget ${budgetMs})`);

  const headingItem = ['# x' + RUN + 'y', '- **Schema:** 1', '', '## Observed', '', 'obs', '', '## x' + RUN + 'y', '', 'after'].join('\n');
  const b = timed(() => lib.parseFeedbackItem(headingItem));
  assert.strictEqual(b.value.title, 'x' + RUN + 'y', 'title heading with a long whitespace run keeps its text');
  assert.strictEqual(b.value.sections.Observed, 'obs', 'an unknown heading with a long whitespace run ends the section');
  assert.ok(b.ms < budgetMs, `parse of a long-whitespace h1 and h2 took ${b.ms.toFixed(1)} ms (budget ${budgetMs})`);

  const c = timed(() => lib.renderFeedbackItem({ id: 'sample-001', title: 't', fields: { Schema: '1' }, sections: { Observed: RUN + 'x' } }));
  assert.ok(c.value.includes('## Observed\n\n' + RUN + 'x\n'), 'render keeps a section body that opens with a long whitespace run');
  assert.ok(c.ms < budgetMs, `render of a section with a 65k-space run took ${c.ms.toFixed(1)} ms (budget ${budgetMs})`);

  const d = timed(() => lib.renderFeedbackItem({ id: 'sample-001', title: 't', fields: { Schema: '1' }, sections: { Proposal: 'p', Answer: RUN + 'x' } }));
  assert.ok(d.value.endsWith('## Answer\n\n' + RUN + 'x\n'), 'render ends with the Answer body and one newline');
  assert.ok(d.ms < budgetMs, `render of a long-whitespace Answer took ${d.ms.toFixed(1)} ms (budget ${budgetMs})`);

  // (3) Parse semantics of headings, asserted on parseFeedbackItem output.
  const parseTail = (tail) => lib.parseFeedbackItem(header.concat(['## Observed', '', 'obs', '', '## Evidence', '', 'ev', tail]).join('\n'));
  assert.deepStrictEqual(parseTail('## Proposal   \nprop').sections, { Observed: 'obs', Evidence: 'ev', Proposal: 'prop' }, 'trailing spaces after a heading name');
  assert.deepStrictEqual(parseTail('## Proposal\r\nprop').sections, { Observed: 'obs', Evidence: 'ev', Proposal: 'prop' }, 'a carriage return after a heading name');
  assert.deepStrictEqual(parseTail('##   \nbody').sections, { Observed: 'obs', Evidence: 'ev' }, 'two-plus whitespace characters after the hashes end the section and open no known section');
  assert.deepStrictEqual(parseTail('##\t\t\nbody').sections, { Observed: 'obs', Evidence: 'ev' }, 'whitespace-only heading made of tabs');
  assert.deepStrictEqual(parseTail('##  \r\nbody').sections, { Observed: 'obs', Evidence: 'ev' }, 'two spaces and a carriage return still make a heading');
  assert.strictEqual(parseTail('## \r\nbody').sections.Evidence, 'ev\n## \r\nbody', 'a space and a carriage return is not a heading and stays a body line');
  // The next two are pinned from the behaviour of the former pattern, which needed a second character.
  assert.strictEqual(parseTail('## \nbody').sections.Evidence, 'ev\n## \nbody', 'hashes and a single space are not a heading');
  assert.strictEqual(parseTail('##\nbody').sections.Evidence, 'ev\n##\nbody', 'bare hashes are not a heading');
  assert.strictEqual(parseTail('##Proposal\nbody').sections.Evidence, 'ev\n##Proposal\nbody', 'no space after the hashes is not a heading');
  const crTitle = lib.parseFeedbackItem('# sample-009 — Title\r\n- **Schema:** 1\n');
  assert.strictEqual(crTitle.title, 'Title');
  assert.strictEqual(crTitle.id, 'sample-009');

  // (4) Render output unchanged: Answer omitted when empty, trailing blank lines dropped, one final newline.
  const expected = [
    '# sample-001 — t',
    '',
    '- **Schema:** 1',
    '- **Item:** sample-001',
    '- **Adopter:**',
    '- **Framework version:**',
    '- **Kind:**',
    '- **Severity:**',
    '- **Area:**',
    '- **Submitted:**',
    '- **Channel:**',
    '',
    '## Observed',
    '',
    'obs',
    '',
    '## Evidence',
    '',
    '',
    '',
    '## Proposal',
    '',
    'p',
    '',
  ].join('\n');
  const rendered = lib.renderFeedbackItem({ id: 'sample-001', title: 't', sections: { Observed: '\n\nobs  \n\n', Proposal: 'p  \n \n', Answer: ' \n ' } });
  assert.strictEqual(rendered, expected, 'render drops an empty Answer, trims section bodies and ends with exactly one newline');
  const withAnswer = lib.renderFeedbackItem({ id: 'sample-001', title: 't', sections: { Answer: 'a\n\n\n' } });
  assert.ok(withAnswer.endsWith('## Answer\n\na\n') && !withAnswer.endsWith('\n\n'), 'a non-empty Answer is the last section and ends with one newline');
  console.log('PASS T-840 parse and render stay linear on long whitespace runs, semantics unchanged');
}

async function concurrentAllocation() {
  const dir = path.join(mkTmp('conc'), 'queue');
  const code =
    `const l=require(${JSON.stringify(LIB_PATH)});` +
    `process.stdout.write(l.allocateFeedbackItemId(${JSON.stringify(dir)},'sample').id);`;
  const runOne = () =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', code], { env: spawnEnv(dir, dir) });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('error', reject);
      c.on('close', (status) => (status === 0 ? resolve(out) : reject(new Error(`exit ${status}`))));
    });
  const ids = await Promise.all(Array.from({ length: 8 }, runOne));
  assert.strictEqual(new Set(ids).size, 8, `eight concurrent allocations share no id: ${ids.join(',')}`);
  console.log('PASS eight concurrent allocations yield eight distinct ids');
}

// ---------------------------------------------------------------------------
// Command (criteria 3, 5)
// ---------------------------------------------------------------------------
function commandTests() {
  // valid submission -> sample-001, then sample-002
  {
    const { root, inbox } = fixture();
    const input = writeInput(root, itemInput());
    const r1 = run(['--file', input], root, inbox);
    assert.strictEqual(r1.status, 0, r1.all);
    assert.ok(r1.out.split('\n').includes(`feedback: sample-001 written to ${inbox}`), r1.out);
    const written = path.join(inbox, 'sample-001.md');
    assert.ok(fs.existsSync(written), 'sample-001.md exists');
    const p = lib.parseFeedbackItem(fs.readFileSync(written, 'utf8'));
    assert.strictEqual(p.fields.Item, 'sample-001');
    assert.strictEqual(p.fields.Adopter, 'sample');
    assert.strictEqual(p.fields['Framework version'], '9.9.9');
    assert.strictEqual(p.fields.Channel, 'local');
    assert.strictEqual(p.fields.Submitted, todayIso());
    assert.strictEqual(p.fields.Kind, 'bug');
    assert.strictEqual(p.title, 'Wrapper drops a flag');
    assert.strictEqual(p.sections.Evidence, 'Ran the command; nothing happened.');
    const r2 = run(['--file', input], root, inbox);
    assert.strictEqual(r2.status, 0, r2.all);
    assert.ok(r2.out.split('\n').includes(`feedback: sample-002 written to ${inbox}`), r2.out);
    assert.ok(fs.existsSync(path.join(inbox, 'sample-002.md')));
    console.log('PASS valid items become sample-001 then sample-002');
  }

  // framework version falls back to the resolved framework version
  {
    const { root, inbox } = fixture();
    const state = JSON.parse(fs.readFileSync(path.join(root, 'PROCESS_STATE.json'), 'utf8'));
    delete state.mavericks_version;
    fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n');
    const r = run(['--file', writeInput(root, itemInput())], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    const p = lib.parseFeedbackItem(fs.readFileSync(path.join(inbox, 'sample-001.md'), 'utf8'));
    assert.strictEqual(p.fields['Framework version'], `${MAVERICKS_VERSION} (resolved)`);
    console.log('PASS framework version falls back to the resolved version');
  }

  // workaround marker is recorded in its literal form
  {
    const { root, inbox } = fixture();
    const input = writeInput(root, itemInput({ extra: '- **Workaround:** mavp-workaround:<alias>-NNN' }));
    const r = run(['--file', input], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    const p = lib.parseFeedbackItem(fs.readFileSync(path.join(inbox, 'sample-001.md'), 'utf8'));
    assert.strictEqual(p.fields.Workaround, 'mavp-workaround:sample-001');
    console.log('PASS workaround marker uses the allocated id');
  }

  // missing ## Evidence -> exit 1 naming the section, inbox stays empty
  {
    const { root, inbox } = fixture();
    const r = run(['--file', writeInput(root, itemInput({ evidence: null }))], root, inbox);
    assert.strictEqual(r.status, 1, r.all);
    assert.ok(/Evidence/.test(r.all), `output names the section: ${r.all}`);
    const left = fs.existsSync(inbox) ? fs.readdirSync(inbox) : [];
    assert.deepStrictEqual(left, [], 'inbox stays empty');
    console.log('PASS missing Evidence section refused, inbox empty');
  }

  // invalid Kind refused
  {
    const { root, inbox } = fixture();
    const r = run(['--file', writeInput(root, itemInput({ kind: '<bug|proposal|question>' }))], root, inbox);
    assert.strictEqual(r.status, 1, r.all);
    assert.ok(/Kind/.test(r.all), r.all);
    console.log('PASS unfilled Kind refused');
  }

  // alias my-repo refused by the pattern
  {
    const { root, inbox } = fixture();
    const r = run(['--file', writeInput(root, itemInput()), '--adopter', 'my-repo'], root, inbox);
    assert.strictEqual(r.status, 1, r.all);
    assert.ok(/my-repo/.test(r.all), r.all);
    assert.ok(!fs.existsSync(inbox) || fs.readdirSync(inbox).length === 0, 'nothing written');
    const s = run(['--set-alias', 'my-repo'], root, inbox);
    assert.strictEqual(s.status, 1, s.all);
    console.log('PASS alias my-repo refused by the pattern');
  }

  // no alias anywhere -> exit 1 naming --set-alias
  {
    const { root, inbox } = fixture();
    const state = JSON.parse(fs.readFileSync(path.join(root, 'PROCESS_STATE.json'), 'utf8'));
    delete state.feedback_alias;
    fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n');
    const r = run(['--file', writeInput(root, itemInput())], root, inbox);
    assert.strictEqual(r.status, 1, r.all);
    assert.ok(r.all.includes('--set-alias'), r.all);
    console.log('PASS missing alias refused naming --set-alias');
  }

  // alias matching the private-name category refused (needs no local names file)
  if (readNamesFileRaw() === null) {
    const { root, inbox } = fixture();
    const env = { ...spawnEnv(root, inbox), MAVP_PRIVATE_NAMES: 'fixtureprivate' };
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--file', writeInput(root, itemInput()), '--adopter', 'fixtureprivate'],
      { cwd: root, env, encoding: 'utf8' }
    );
    assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.ok(/Private repo name/.test(`${r.stdout}${r.stderr}`), `${r.stdout}${r.stderr}`);
    console.log('PASS alias matching a private name refused');
  } else {
    console.log('NOTE private-name alias refusal not exercised: a local private-names file overrides the env value');
  }

  // absolute-home-path line: still written, advisory names the category and line
  {
    const { root, inbox } = fixture();
    const homePath = '/' + 'Users' + '/someone/project/file.txt';
    const input = writeInput(root, itemInput({ evidence: `see ${homePath} for details` }));
    const r = run(['--file', input], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    assert.ok(fs.existsSync(path.join(inbox, 'sample-001.md')), 'still written');
    const written = fs.readFileSync(path.join(inbox, 'sample-001.md'), 'utf8');
    const lineNo = written.split('\n').findIndex((l) => l.includes(homePath)) + 1;
    assert.ok(lineNo > 0, 'path line present in written file');
    assert.ok(
      new RegExp(`advisory: \\[Absolute /Users/ path\\] line ${lineNo} `).test(r.out),
      `advisory names category and line ${lineNo}: ${r.out}`
    );
    assert.ok(!r.out.includes(homePath), 'advisory does not echo the path');
    console.log('PASS home-path line written with a non-blocking advisory');
  }

  // --status prints the disposition
  {
    const { root, inbox } = fixture();
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(
      path.join(inbox, 'sample-001.md'),
      lib.renderFeedbackItem({
        id: 'sample-001',
        title: 'Wrapper drops a flag',
        fields: {
          Adopter: 'sample', Kind: 'bug', Severity: 'high', Area: 'wrapper',
          Disposition: 'fixed-in T-900', 'Ships in': '0.52.0', 'Retire workaround': 'yes',
        },
        sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
      })
    );
    fs.writeFileSync(
      path.join(inbox, 'sample-002.md'),
      lib.renderFeedbackItem({
        id: 'sample-002',
        title: 'Second',
        fields: { Adopter: 'sample', Kind: 'question', Severity: 'low', Area: 'docs' },
        sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
      })
    );
    const r = run(['--status'], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    const lines = r.out.split('\n');
    assert.ok(
      lines.includes('sample-001 bug/high — Wrapper drops a flag — fixed-in T-900 — 0.52.0 — yes'),
      r.out
    );
    assert.ok(lines.includes('sample-002 question/low — Second — new — — — —'), r.out);
    console.log('PASS --status prints disposition, ships-in and retire-workaround');
  }

  // --ack stamps today's date and changes no other field
  {
    const { root, inbox } = fixture();
    run(['--file', writeInput(root, itemInput())], root, inbox);
    const file = path.join(inbox, 'sample-001.md');
    // a hand-added unknown field must survive the ack byte-for-byte
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- **Channel:** local', '- **Channel:** local\n- **Mystery:** keep me'));
    const before = fs.readFileSync(file, 'utf8');
    const r = run(['--ack', 'sample-001'], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    const after = fs.readFileSync(file, 'utf8');
    const pa = lib.parseFeedbackItem(after);
    assert.strictEqual(pa.fields.Acknowledged, todayIso());
    const pb = lib.parseFeedbackItem(before);
    const fieldsA = Object.assign({}, pa.fields);
    delete fieldsA.Acknowledged;
    const fieldsB = Object.assign({}, pb.fields);
    delete fieldsB.Acknowledged;
    assert.deepStrictEqual(fieldsA, fieldsB, 'no other field changes');
    assert.deepStrictEqual(pa.sections, pb.sections, 'sections unchanged');
    const strip = (t) => t.split('\n').filter((l) => !l.startsWith('- **Acknowledged:**')).join('\n');
    assert.strictEqual(strip(after), strip(before), 'every other line is byte-identical');
    assert.ok(after.includes('- **Mystery:** keep me'), 'unknown field line preserved');
    const missing = run(['--ack', 'sample-099'], root, inbox);
    assert.strictEqual(missing.status, 1, missing.all);
    console.log('PASS --ack stamps today and changes nothing else');
  }

  // --set-alias persists feedback_alias, every other key unchanged
  {
    const { root, inbox } = fixture({ feedback_alias: undefined, wave_goal: 'keep me', rechecks: [{ id: 'RC-1' }] });
    const file = path.join(root, 'PROCESS_STATE.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!('feedback_alias' in before));
    const r = run(['--set-alias', 'sample'], root, inbox);
    assert.strictEqual(r.status, 0, r.all);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.feedback_alias, 'sample');
    const rest = Object.assign({}, after);
    delete rest.feedback_alias;
    assert.deepStrictEqual(rest, before, 'every other key unchanged');
    console.log('PASS --set-alias persists the alias only');
  }
}

// ---------------------------------------------------------------------------
// Wrapper dispatch (criterion 4)
// ---------------------------------------------------------------------------
function wrapperTests() {
  const canonical = fs.readFileSync(path.join(SCRIPTS_DIR, 'mavp-operator'), 'utf8');
  assert.ok(/\$\{1-\}" == "--feedback"/.test(canonical), 'canonical wrapper dispatches --feedback');
  assert.ok(canonical.includes('mavp-operator-feedback.js" "$@"'), 'canonical passes "$@" through');
  assert.ok(canonical.includes('echo "  --feedback '), 'canonical help lists --feedback');
  const installer = fs.readFileSync(path.join(SCRIPTS_DIR, 'mavp-install.js'), 'utf8');
  assert.ok(installer.includes('== "--feedback"'), 'adopter wrapper template dispatches --feedback');
  assert.ok(installer.includes('mavp-operator-feedback.js" "$@"'), 'adopter passes "$@" through');
  assert.ok(installer.includes('echo "  --feedback '), 'adopter help lists --feedback');

  const { root, inbox } = fixture();
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'mavp-operator'), '--feedback', '--status'], {
    cwd: root,
    env: spawnEnv(root, inbox),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(`${r.stdout}`.includes('feedback: no items for sample'), r.stdout);
  console.log('PASS both wrappers dispatch --feedback; canonical wrapper runs it');
}

(async () => {
  try {
    commandTests();
    wrapperTests();
    await concurrentAllocation();
    console.log('test-feedback-local: all assertions passed');
  } finally {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
