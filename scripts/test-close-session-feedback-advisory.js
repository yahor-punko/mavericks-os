'use strict';
// T-833 — session-end feedback capture: the `mavp-feedback:` note convention, drafts
// (`--feedback --draft/--drafts/--discard/--file`) and the non-blocking --close-session advisory
// in adopter roots.
//
// Expected values come from the T-833 acceptance criteria, not from observed behaviour.
// Hermetic: MAVERICKS_INTAKE_DIR, MAVERICKS_PROJECT_ROOT and MAVERICKS_SCRIPTS are pinned in every
// spawn; the real home directory is never read or written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const CLOSE_SESSION = path.join(SCRIPTS_DIR, 'mavp-operator-close-session.js');
const FEEDBACK = path.join(SCRIPTS_DIR, 'mavp-operator-feedback.js');
const lib = require(path.join(SCRIPTS_DIR, 'mavp-operator-lib.js'));

const tmpRoots = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `fbadv-${label}-`));
  tmpRoots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// The note token is built at runtime so no line of this file begins with it.
const TOKEN = 'mavp-feedback' + ':';
const noteLine = (text, date) => `- ${date ? date + ' ' : ''}${TOKEN} ${text}`;

const PRE_NOTE = 'Pre-commit note must never be listed';
const FIRST_NOTE = 'Close session should explain its diff base';
const SECOND_NOTE = 'Drafts command lacks a json mode';
const SECOND_AREA = '--feedback --drafts';
const SECOND_KIND = 'proposal';
const DRAFT_TITLE = 'Existing draft about hooks';
const DRAFT_SUMMARY = 'The hook output is easy to miss';
const MIDLINE = `Prose that mentions ${TOKEN} in the middle of a sentence`;

function git(dir, ...args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function envFor(root, inbox) {
  return {
    ...process.env,
    MAVERICKS_PROJECT_ROOT: root,
    MAVERICKS_SCRIPTS: SCRIPTS_DIR,
    MAVERICKS_INTAKE_DIR: inbox,
    MAVP_PRIVATE_NAMES: '',
  };
}

function feedbackCli(root, inbox, args) {
  const r = spawnSync(process.execPath, [FEEDBACK, ...args], { cwd: root, env: envFor(root, inbox), encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}

const STATE = {
  initiative: 'fixture initiative',
  stage: 'execution',
  wave: 3,
  wave_session: 1,
  wave_status: 'planning',
  wave_goal: 'fixture goal',
  parked_waves: [],
  active_slices: [],
  next_action: 'Open next wave',
  blocker: null,
  stage_owner: 'main_agent',
  last_task_id: 1,
  last_updated: '2026-01-01',
  deploy_contours: 0,
  rechecks: [],
  feedback_alias: 'sample',
};

// An adopter repo: no scripts/mavp-operator-lib.js under it. EXECUTION_LOG.md carries one note line
// BEFORE the `chore: close session` commit; `withNotes` adds the post-commit material.
function buildAdopter(label, { withNotes, alias = 'sample', frameworkRoot = false }) {
  const dir = mkTmp(label);
  const inbox = path.join(mkTmp(`${label}-inbox`), 'queue');
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n## Wave 2 — Archived\n\n### T-001 — Fixture work\n- **Status:** merged\n- **Owner role:** developer\n- **Verification type:** artifact\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n\n## Recently completed tasks\n\n### T-001 — Fixture work\n- **Status:** merged\n- **Owner role:** developer\n- **Verification type:** artifact\n- **Last verified by:** qa\n- **Evidence:** artifact: fixture\n- **Notes:** —\n', 'utf8');
  const state = { ...STATE };
  if (alias) state.feedback_alias = alias;
  else delete state.feedback_alias;
  fs.writeFileSync(path.join(dir, 'PROCESS_STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'EXECUTION_LOG.md'), ['# EXECUTION_LOG', '', noteLine(PRE_NOTE, '2026-09-01'), ''].join('\n'), 'utf8');
  if (frameworkRoot) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'mavp-operator-lib.js'), "'use strict';\n", 'utf8');
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.com');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'chore: close session 2026-09-30');

  if (withNotes) {
    fs.appendFileSync(path.join(dir, 'EXECUTION_LOG.md'), [
      noteLine(FIRST_NOTE, '2026-10-24'),
      noteLine(`${SECOND_NOTE} (area: ${SECOND_AREA}; kind: ${SECOND_KIND})`),
      `- 2026-10-24 ${MIDLINE}`,
      '',
    ].join('\n'), 'utf8');
    if (alias) {
      // An inbox item whose title equals the first post-commit note, and one existing draft with a Summary.
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, 'sample-001.md'), lib.renderFeedbackItem({
        id: 'sample-001',
        title: FIRST_NOTE,
        fields: { Adopter: 'sample', 'Framework version': '9.9.9', Kind: 'bug', Severity: 'normal', Area: 'close-session', Submitted: '2026-10-01', Channel: 'local' },
        sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
      }), 'utf8');
      const made = feedbackCli(dir, inbox, ['--draft', DRAFT_TITLE, '--summary', DRAFT_SUMMARY]);
      assert.strictEqual(made.status, 0, `SETUP FAIL: draft creation failed: ${made.all}`);
    }
  }
  return { dir, inbox };
}

function draftPath(inbox, n) {
  return path.join(inbox, 'drafts', `sample-draft-${n}.md`);
}

function runNonInteractive(fx) {
  const r = spawnSync(process.execPath, [CLOSE_SESSION, '--non-interactive'], {
    cwd: fx.dir, env: envFor(fx.dir, fx.inbox), input: '', encoding: 'utf8',
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// Interactive: write each answer only once its prompt text has appeared (the prompt-helper pattern
// from scripts/test-close-session-terminal-sweep.js).
function runInteractive(fx) {
  const steps = [
    { match: 'Next action [', answer: '' },
    { match: 'Run git push?', answer: 'n' },
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLOSE_SESSION, '--interactive'], { cwd: fx.dir, env: envFor(fx.dir, fx.inbox) });
    let out = '';
    let i = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`interactive close timed out on step ${i}. Output so far:\n${out}`));
    }, 30000);
    const advance = () => {
      while (i < steps.length && out.includes(steps[i].match)) {
        child.stdin.write(steps[i].answer + '\n');
        i++;
      }
    };
    child.stdout.on('data', (d) => { out += d.toString(); advance(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

function assertBytesMatchControl(withDir, controlDir, label) {
  for (const f of ['BACKLOG.md', 'TASK_STATUS.md', 'PROCESS_STATE.json']) {
    assert.strictEqual(read(withDir, f), read(controlDir, f), `${label}: ${f} must be byte-identical to the control run (the advisory never touches artifacts)`);
  }
}

const NON_INTERACTIVE_TRAILER_START = 'If an operator is present: raise the approval modal now (harness question tool, multi-select over the drafts above by title + summary, plus "Send none"); submit only approved drafts with ./scripts/mavp-operator --feedback --file <draft>; unselected drafts stay drafts. Headless: drafts are kept and listed again at the next interactive session. GitHub publication additionally needs --feedback --github --operator-confirmed "<the operator\'s statement>".';
const TERMINAL_TRAILER = 'To submit a draft, run ./scripts/mavp-operator --feedback --file <path> (running it is your approval); drafts not submitted are listed again next session.';

function assertAdvisoryLists(out, fx, label) {
  assert.ok(out.includes('Feedback from this session: 1 noted, 1 drafted'), `${label}: header must read "1 noted, 1 drafted", got:\n${out}`);
  assert.ok(out.includes('already submitted: sample-001'), `${label}: first note must be deduped against the inbox item`);
  const expectedCmd = `./scripts/mavp-operator --feedback --draft "${SECOND_NOTE}" --area "${SECOND_AREA}" --kind ${SECOND_KIND}`;
  assert.ok(out.includes(expectedCmd), `${label}: missing exact draft command ${expectedCmd}, got:\n${out}`);
  assert.ok(out.includes(`${draftPath(fx.inbox, 1)} — ${DRAFT_TITLE} — ${DRAFT_SUMMARY}`), `${label}: missing the draft's path/title/summary line, got:\n${out}`);
  assert.ok(!out.includes(PRE_NOTE), `${label}: a note from before the previous close-session commit must not be listed`);
  assert.ok(!out.includes(MIDLINE) && !out.includes('Prose that mentions'), `${label}: a mid-line mention must not be listed`);
  assert.ok(!out.includes(`--draft "${FIRST_NOTE}"`), `${label}: an already-submitted note must not get a draft command`);
}

async function main() {
  // --- Part 1: note parser (lib is the single source of truth) --------------------------------
  {
    const text = [
      noteLine('plain note'),
      noteLine('dated note (area: operator command; kind: bug)', '2026-10-25'),
      noteLine('odd kind (kind: wish)'),
      `Prose mentioning ${TOKEN} mid-line`,
      `- bullet text then ${TOKEN} mid-line`,
      `prose with a dash - ${TOKEN} after it is still mid-line`,
      '- `' + TOKEN + '` cited backticked in a bullet',
    ].join('\n');
    const notes = lib.parseFeedbackNotes(text);
    assert.deepStrictEqual(notes, [
      { line: 1, title: 'plain note', area: null, kind: null },
      { line: 2, title: 'dated note', area: 'operator command', kind: 'bug' },
      { line: 3, title: 'odd kind', area: null, kind: null },
    ], 'Part 1: parseFeedbackNotes must keep line-initial notes only and read hints');
    assert.ok(lib.FEEDBACK_NOTE_PATTERN instanceof RegExp, 'Part 1: FEEDBACK_NOTE_PATTERN must be exported');
    assert.ok(!lib.FEEDBACK_NOTE_PATTERN.test(`some text ${TOKEN} here`), 'Part 1: a mid-line mention must never match');
    console.log('Part 1 (note parser) passed.');
  }

  // --- Part 2: non-interactive advisory + control ---------------------------------------------
  {
    const fx = buildAdopter('ni', { withNotes: true });
    const control = buildAdopter('ni-control', { withNotes: false });
    const run = runNonInteractive(fx);
    const ctl = runNonInteractive(control);
    assertAdvisoryLists(run.out, fx, 'Part 2');
    assert.ok(run.out.includes(NON_INTERACTIVE_TRAILER_START), `Part 2: non-interactive trailer missing, got:\n${run.out}`);
    assert.ok(run.out.includes('"Send none"') && run.out.includes('approval modal'), 'Part 2: trailer must name the modal and "Send none"');
    assert.ok(!run.out.includes(TERMINAL_TRAILER), 'Part 2: the terminal trailer belongs to the interactive path only');
    assert.ok(run.out.indexOf('Feedback from this session') < run.out.indexOf(NON_INTERACTIVE_TRAILER_START), 'Part 2: header precedes trailer');
    assert.strictEqual(run.status, ctl.status, 'Part 2: exit code must equal the control run');
    assertBytesMatchControl(fx.dir, control.dir, 'Part 2');
    assert.ok(!ctl.out.includes('Feedback from this session'), 'Part 2: the control run (no notes, no drafts) must print no advisory');
    assert.ok(fs.existsSync(draftPath(fx.inbox, 1)), 'Part 2: the close never submits — the draft must still exist');
    assert.strictEqual(fs.readdirSync(fx.inbox).filter((f) => /^sample-\d+\.md$/.test(f)).join(','), 'sample-001.md', 'Part 2: the close must not create inbox items');
    console.log('Part 2 (non-interactive advisory) passed.');
  }

  // --- Part 3: interactive advisory, before the push prompt -----------------------------------
  {
    const fx = buildAdopter('tty', { withNotes: true });
    const control = buildAdopter('tty-control', { withNotes: false });
    const run = await runInteractive(fx);
    const ctl = await runInteractive(control);
    assertAdvisoryLists(run.out, fx, 'Part 3');
    assert.ok(run.out.includes(TERMINAL_TRAILER), `Part 3: terminal trailer missing, got:\n${run.out}`);
    assert.ok(!run.out.includes('approval modal'), 'Part 3: the non-interactive trailer belongs to the agent path only');
    assert.ok(run.out.indexOf(TERMINAL_TRAILER) < run.out.indexOf('Run git push?'), 'Part 3: terminal trailer must print before the push prompt');
    assert.strictEqual(run.status, ctl.status, 'Part 3: exit code must equal the control run');
    assertBytesMatchControl(fx.dir, control.dir, 'Part 3');
    assert.ok(!ctl.out.includes('Feedback from this session'), 'Part 3: the control run must print no advisory');
    assert.ok(fs.existsSync(draftPath(fx.inbox, 1)), 'Part 3: the close never submits — the draft must still exist');
    console.log('Part 3 (interactive advisory) passed.');
  }

  // --- Part 4: framework root prints nothing; nothing to say prints nothing --------------------
  {
    const fw = buildAdopter('fw', { withNotes: true, frameworkRoot: true });
    const run = runNonInteractive(fw);
    assert.ok(!run.out.includes('Feedback from this session'), `Part 4: a framework root must print no advisory, got:\n${run.out}`);
    assert.strictEqual(lib.parseFeedbackNotes(read(fw.dir, 'EXECUTION_LOG.md')).length, 3, 'Part 4 SETUP: the framework fixture does carry note lines');
    const { buildFeedbackCaptureAdvisory } = require(CLOSE_SESSION);
    assert.strictEqual(buildFeedbackCaptureAdvisory(fw.dir, { mode: 'non-interactive', intakeDir: fw.inbox }), null, 'Part 4: buildFeedbackCaptureAdvisory must return null in a framework root');

    const quiet = buildAdopter('quiet', { withNotes: false });
    const quietRun = runNonInteractive(quiet);
    assert.ok(!/Feedback from this session|approval modal|--feedback/.test(quietRun.out), `Part 4: no notes and no drafts must print no advisory line at all, got:\n${quietRun.out}`);
    assert.strictEqual(buildFeedbackCaptureAdvisory(quiet.dir, { intakeDir: quiet.inbox }), null, 'Part 4: null when nothing to say');
    console.log('Part 4 (framework root / nothing to say) passed.');
  }

  // --- Part 5: no persisted alias -> --set-alias first line ------------------------------------
  {
    const fx = buildAdopter('noalias', { withNotes: true, alias: null });
    const run = runNonInteractive(fx);
    const lines = run.out.split('\n');
    const headerIdx = lines.findIndex((l) => l.includes('Feedback from this session:'));
    assert.ok(headerIdx >= 0, `Part 5: advisory must print even without an alias, got:\n${run.out}`);
    assert.ok(lines[headerIdx].includes('2 noted, 0 drafted'), `Part 5: without an alias nothing can be deduped, got: ${lines[headerIdx]}`);
    assert.ok(lines[headerIdx + 1].includes('./scripts/mavp-operator --feedback --set-alias <your-alias>'), `Part 5: --set-alias must be the first line after the header, got: ${lines[headerIdx + 1]}`);
    assert.ok(lines[headerIdx + 1].includes('placeholder'), 'Part 5: the placeholder must be named as such');
    console.log('Part 5 (no alias) passed.');
  }

  // --- Part 6: --feedback --draft / --drafts / --file / --discard ------------------------------
  {
    const root = mkTmp('cli');
    const inbox = path.join(mkTmp('cli-inbox'), 'queue');
    fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify({ ...STATE }, null, 2) + '\n');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'sample-001.md'), lib.renderFeedbackItem({
      id: 'sample-001', title: 'earlier', fields: { Adopter: 'sample', Kind: 'bug', Severity: 'normal', Area: 'x', Submitted: '2026-10-01', Channel: 'local' },
      sections: { Observed: 'o', Evidence: 'e', Proposal: 'p' },
    }));

    const made = feedbackCli(root, inbox, ['--draft', 'x', '--summary', 's', '--kind', 'bug']);
    assert.strictEqual(made.status, 0, made.all);
    const p1 = draftPath(inbox, 1);
    assert.ok(made.out.includes(`draft: ${p1} — fill Observed/Evidence/Proposal; submission happens only after the operator approves it`), `Part 6: draft line, got:\n${made.out}`);
    const parsed = lib.parseFeedbackItem(fs.readFileSync(p1, 'utf8'));
    assert.strictEqual(parsed.fields.Summary, 's', 'Part 6: parsed Summary');
    assert.strictEqual(parsed.fields.Kind, 'bug', 'Part 6: parsed Kind');
    assert.strictEqual(parsed.title, 'x', 'Part 6: parsed title');
    assert.strictEqual(parsed.fields.Item, '', 'Part 6: no Item id is allocated for a draft');
    for (const sec of ['Observed', 'Evidence', 'Proposal']) assert.strictEqual(parsed.sections[sec], '', `Part 6: ${sec} left empty`);
    assert.deepStrictEqual(fs.readdirSync(inbox).filter((f) => /^sample-\d+\.md$/.test(f)), ['sample-001.md'], 'Part 6: drafting allocates no item id');

    const listed = feedbackCli(root, inbox, ['--drafts']);
    assert.strictEqual(listed.status, 0, listed.all);
    assert.ok(listed.out.split('\n').includes(`${p1} — x — s`), `Part 6: --drafts must list "<path> — x — s", got:\n${listed.out}`);

    // A draft without a Summary lists the first non-empty line of Observed, then a dash.
    const p2made = feedbackCli(root, inbox, ['--draft', 'no summary']);
    const p2 = draftPath(inbox, 2);
    assert.strictEqual(p2made.status, 0, p2made.all);
    assert.ok(feedbackCli(root, inbox, ['--drafts']).out.split('\n').includes(`${p2} — no summary — —`), 'Part 6: empty summary and empty Observed list as a dash');
    fs.writeFileSync(p2, fs.readFileSync(p2, 'utf8').replace('## Observed\n', '## Observed\n\nFirst observed line\nsecond line\n'));
    assert.ok(feedbackCli(root, inbox, ['--drafts']).out.split('\n').includes(`${p2} — no summary — First observed line`), 'Part 6: falls back to the first non-empty Observed line');

    // Submit draft 1: fill the required fields, then --file submits sample-002 and removes the draft.
    let text = fs.readFileSync(p1, 'utf8')
      .replace(/^- \*\*Severity:\*\*.*$/m, '- **Severity:** normal')
      .replace(/^- \*\*Area:\*\*.*$/m, '- **Area:** close-session')
      .replace('## Observed\n', '## Observed\n\nWhat happened.\n')
      .replace('## Evidence\n', '## Evidence\n\nRan the command.\n')
      .replace('## Proposal\n', '## Proposal\n\nChange it.\n');
    fs.writeFileSync(p1, text);
    const sub = feedbackCli(root, inbox, ['--file', p1]);
    assert.strictEqual(sub.status, 0, sub.all);
    assert.ok(sub.out.includes('feedback: sample-002 written to'), `Part 6: --file must submit sample-002, got:\n${sub.out}`);
    assert.ok(fs.existsSync(path.join(inbox, 'sample-002.md')), 'Part 6: the item file exists');
    assert.ok(!fs.existsSync(p1), 'Part 6: the submitted draft is removed');
    assert.ok(fs.existsSync(p2), 'Part 6: submitting one draft leaves the others');

    // Discard deletes only the named draft.
    const keep = feedbackCli(root, inbox, ['--draft', 'keep me']);
    assert.strictEqual(keep.status, 0, keep.all);
    const p3 = draftPath(inbox, 3);
    const disc = feedbackCli(root, inbox, ['--discard', p2]);
    assert.strictEqual(disc.status, 0, disc.all);
    assert.ok(!fs.existsSync(p2), 'Part 6: --discard deletes the named draft');
    assert.ok(fs.existsSync(p3), 'Part 6: --discard deletes nothing else');
    assert.ok(fs.existsSync(path.join(inbox, 'sample-002.md')) && fs.existsSync(path.join(inbox, 'sample-001.md')), 'Part 6: items are untouched');

    // No traversal and no files outside <inbox>/drafts/.
    const outside = path.join(mkTmp('outside'), 'sample-draft-9.md');
    fs.writeFileSync(outside, 'keep');
    const refusedOutside = feedbackCli(root, inbox, ['--discard', outside]);
    assert.strictEqual(refusedOutside.status, 1, 'Part 6: --discard refuses a path outside the drafts directory');
    assert.ok(fs.existsSync(outside), 'Part 6: the outside file survives');
    const traversal = feedbackCli(root, inbox, ['--discard', path.join(inbox, 'drafts', '..', 'sample-001.md')]);
    assert.strictEqual(traversal.status, 1, 'Part 6: --discard refuses traversal');
    assert.ok(fs.existsSync(path.join(inbox, 'sample-001.md')), 'Part 6: traversal target survives');
    const notDraft = path.join(inbox, 'drafts', 'notes.md');
    fs.writeFileSync(notDraft, 'keep');
    assert.strictEqual(feedbackCli(root, inbox, ['--discard', notDraft]).status, 1, 'Part 6: --discard refuses non-draft names inside drafts/');
    assert.ok(fs.existsSync(notDraft), 'Part 6: non-draft file survives');

    // No persisted alias: each draft command exits 1 naming --set-alias.
    const bare = mkTmp('bare');
    fs.writeFileSync(path.join(bare, 'PROCESS_STATE.json'), JSON.stringify({ initiative: 'x' }) + '\n');
    for (const args of [['--draft', 't'], ['--drafts'], ['--discard', p3], ['--file', p3]]) {
      const r = feedbackCli(bare, inbox, args);
      assert.strictEqual(r.status, 1, `Part 6: ${args[0]} without an alias must exit 1`);
      assert.ok(r.all.includes('--feedback --set-alias'), `Part 6: ${args[0]} without an alias must name --feedback --set-alias, got:\n${r.all}`);
    }
    assert.ok(fs.existsSync(p3), 'Part 6: refused commands touch nothing');
    console.log('Part 6 (draft commands) passed.');
  }

  console.log('All T-833 feedback capture assertions passed.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
