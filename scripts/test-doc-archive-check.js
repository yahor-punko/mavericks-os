'use strict';
// Regression test: T-783 — scripts/mavp-doc-archive-check.js (--check-archive),
// the nothing-lost check for the archive-not-delete convention in
// .claude/rules/docs.md. Builds throwaway fixture git repos and asserts each
// acceptance-criterion case by exit code AND by the summary counts it prints.
//
// Expected values come from the contract (T-783's acceptance criteria), not
// from observed output: a removed perimeter line passes only when it
// reappears trimmed-verbatim in a perimeter doc (parent or child perimeter) or
// in a docs/archive/ file the SAME commit added or modified.
//
// Hermetic: every git call runs with GIT_* variables stripped from the env
// (a caller such as a pre-push hook may export GIT_DIR) and with hooks
// disabled in the fixture.
//
// Plain node, no npm deps (see .claude/rules/scripts.md).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mavp-doc-archive-check.js');

const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
delete ENV.MAVERICKS_PROJECT_ROOT;
ENV.GIT_CONFIG_NOSYSTEM = '1';

const scratchDirs = [];
function scratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(dir, rel, text) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function commit(dir, msg) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function shortOf(dir, rev) {
  return git(dir, ['rev-parse', '--short', rev]);
}

const PARAGRAPH = [
  'Old paragraph line alpha.',
  'Old paragraph line beta.',
  'Old paragraph line gamma.',
];

const GUIDE_BASE = [
  '# Guide',
  '',
  '## Keep',
  '',
  'Keep line one.',
  '',
  '## Old topic',
  '',
  ...PARAGRAPH,
  '',
].join('\n');

const GUIDE_WITHOUT_PARAGRAPH = [
  '# Guide',
  '',
  '## Keep',
  '',
  'Keep line one.',
  '',
  '## Old topic',
  '',
].join('\n');

const GUIDE_STUB = GUIDE_WITHOUT_PARAGRAPH + 'Moved: see docs/archive/GUIDE/2026-10-23-old-topic.md\n';

function archiveText(lines) {
  return [
    '# Archive: docs/GUIDE.md — Old topic',
    '',
    'Source: docs/GUIDE.md; verbatim — never edited',
    '',
    '## Old topic',
    '',
    ...lines,
    '',
  ].join('\n');
}

/** A fixture repo with one base commit holding a small layer-0/1 perimeter. */
function baseRepo() {
  const dir = scratch('mavp-archive-check-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', path.join(dir, '.no-hooks')]);
  write(dir, 'CLAUDE.md', '# Project\n\nProject intro line.\n\n@docs/GUIDE.md\n');
  write(dir, 'docs/GUIDE.md', GUIDE_BASE);
  write(dir, 'docs/OTHER.md', '# Other\n\nOther line one.\nOther line two.\n');
  write(dir, '.claude/rules/always.md', '# Always rule\n\nAlways rule line.\n');
  write(dir, '.claude/rules/scoped.md', '---\npaths:\n  - "src/**"\n---\n# Scoped rule\n\nScoped rule line.\n');
  write(dir, 'docs/MODULES.md', '# Modules\n\n## sample-module\n\n- **label:** Sample\n- **context_docs:** docs/MODDOC.md\n');
  write(dir, 'docs/MODDOC.md', '# Module doc\n\nModule doc line.\n');
  const base = commit(dir, 'base');
  return { dir, base };
}

function check(dir, args) {
  const r = spawnSync('node', [SCRIPT, '--root', dir, ...args], { env: ENV, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function count(out, label) {
  const m = out.match(new RegExp(`^\\s*${label}: (\\d+)`, 'm'));
  assert.ok(m, `FAIL: summary line "${label}:" not found in output:\n${out}`);
  return Number(m[1]);
}

function assertSumsToTotal(out) {
  assert.strictEqual(
    count(out, 'found-in-working') + count(out, 'found-in-archive') + count(out, 'amended-in-place') + count(out, 'missing'),
    count(out, 'removed lines'),
    `FAIL: buckets do not sum to the removed-line total:\n${out}`,
  );
}

const results = [];
function test(name, fn) {
  fn();
  results.push(name);
  console.log(`  ok - ${name}`);
}

try {
  test('paragraph moved verbatim to a same-commit archive file passes, found-in-archive = paragraph line count', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(PARAGRAPH));
    const c = commit(dir, 'archive old topic');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'commits scanned'), 1, r.out);
    assert.strictEqual(count(r.out, 'removed lines'), PARAGRAPH.length, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), PARAGRAPH.length, r.out);
    assert.strictEqual(count(r.out, 'found-in-working'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    // Perimeter: CLAUDE.md, its import, both rules (layer 0 and layer 1), the module context doc.
    assert.strictEqual(count(r.out, 'perimeter files'), 5, r.out);
    assert.ok(!/^0 removed lines in perimeter$/m.test(r.out), r.out);
    assert.ok(/^Result: PASS/m.test(r.out), r.out);
    assertSumsToTotal(r.out);
  });

  test('deletion without archive exits 1 naming commit, file and line text', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    const c = commit(dir, 'delete old topic');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'missing'), PARAGRAPH.length, r.out);
    for (const line of PARAGRAPH) {
      assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${line}`), `FAIL: missing line not named: ${line}\n${r.out}`);
    }
    assert.ok(/^Result: FAIL/m.test(r.out), r.out);
    assertSumsToTotal(r.out);
  });

  test('archive copy with one changed character exits 1 for exactly that line', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    const altered = [PARAGRAPH[0], 'Old paragraph line betA.', PARAGRAPH[2]];
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(altered));
    const c = commit(dir, 'archive with a typo');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'missing'), 1, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), 2, r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${PARAGRAPH[1]}`), r.out);
    assertSumsToTotal(r.out);
  });

  test('archive landing in the next commit exits 1 for the deleting commit', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    const del = commit(dir, 'delete old topic');
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(PARAGRAPH));
    const arc = commit(dir, 'archive it one commit late');
    const r = check(dir, ['--range', `${base}..${arc}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'commits scanned'), 2, r.out);
    assert.strictEqual(count(r.out, 'missing'), PARAGRAPH.length, r.out);
    for (const line of PARAGRAPH) {
      assert.ok(r.out.includes(`MISSING ${shortOf(dir, del)} docs/GUIDE.md: ${line}`), `FAIL: deleting commit not named for: ${line}\n${r.out}`);
    }
    assert.ok(!r.out.includes(`MISSING ${shortOf(dir, arc)}`), r.out);
  });

  test('an archive file the commit did NOT touch does not count, even when it holds the lines', () => {
    const { dir } = baseRepo();
    write(dir, 'docs/archive/GUIDE/2026-01-01-earlier.md', archiveText(PARAGRAPH));
    const earlier = commit(dir, 'an earlier, unrelated archive file');
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    const c = commit(dir, 'delete without touching any archive file');
    const r = check(dir, ['--range', `${earlier}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'missing'), PARAGRAPH.length, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), 0, r.out);
  });

  test('a modified (not only added) archive file counts', () => {
    const { dir } = baseRepo();
    write(dir, 'docs/archive/GUIDE/2026-01-01-earlier.md', '# Earlier archive\n');
    const earlier = commit(dir, 'an earlier archive file');
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    write(dir, 'docs/archive/GUIDE/2026-01-01-earlier.md', `# Earlier archive\n\n${PARAGRAPH.join('\n')}\n`);
    const c = commit(dir, 'append the paragraph to an existing archive file');
    const r = check(dir, ['--range', `${earlier}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'found-in-archive'), PARAGRAPH.length, r.out);
  });

  test('removing the doc\'s @ import in the same commit as the deletion still exits 1', () => {
    const { dir, base } = baseRepo();
    write(dir, 'CLAUDE.md', '# Project\n\nProject intro line.\n');
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    // The removed import line itself is archived, so the only missing lines
    // are the paragraph's — the doc that just left the perimeter is still judged.
    write(dir, 'docs/archive/CLAUDE/2026-10-23-guide-import.md', '# Archive\n\n@docs/GUIDE.md\n');
    const c = commit(dir, 'drop import and paragraph');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'missing'), PARAGRAPH.length, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), 1, r.out);
    for (const line of PARAGRAPH) {
      assert.ok(r.out.includes(`docs/GUIDE.md: ${line}`), `FAIL: ${line}\n${r.out}`);
    }
    assertSumsToTotal(r.out);
  });

  test('a line moved into a doc that leaves the perimeter in the same commit is found-in-working (parent perimeter read after the commit)', () => {
    const { dir, base } = baseRepo();
    // CLAUDE.md drops its import of docs/GUIDE.md (that import line is
    // archived) and moves "Project intro line." into docs/GUIDE.md, which is
    // in the parent perimeter only.
    write(dir, 'CLAUDE.md', '# Project\n');
    write(dir, 'docs/GUIDE.md', `${GUIDE_BASE}Project intro line.\n`);
    write(dir, 'docs/archive/CLAUDE/2026-10-23-guide-import.md', '# Archive\n\n@docs/GUIDE.md\n');
    const c = commit(dir, 'move intro line, drop import');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 2, r.out);
    assert.strictEqual(count(r.out, 'found-in-working'), 1, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), 1, r.out);
  });

  test('moving the doc out of the perimeter (git mv outside, import removed) does not exempt it', () => {
    const { dir, base } = baseRepo();
    write(dir, 'CLAUDE.md', '# Project\n\nProject intro line.\n');
    git(dir, ['mv', 'docs/GUIDE.md', 'docs/notes-GUIDE.md']);
    write(dir, 'docs/archive/CLAUDE/2026-10-23-guide-import.md', '# Archive\n\n@docs/GUIDE.md\n');
    const c = commit(dir, 'move guide out of the perimeter');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    for (const line of PARAGRAPH) {
      assert.ok(r.out.includes(`docs/GUIDE.md: ${line}`), `FAIL: ${line}\n${r.out}`);
    }
  });

  test('deletion from a non-perimeter file exits 0 with the "0 removed lines in perimeter" line', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/OTHER.md', '# Other\n');
    const c = commit(dir, 'trim other');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 0, r.out);
    assert.ok(/^0 removed lines in perimeter$/m.test(r.out), `FAIL: explicit zero line absent:\n${r.out}`);
  });

  test('always-loaded rule, path-scoped rule and module context doc are each in the perimeter', () => {
    for (const [rel, body] of [
      ['.claude/rules/always.md', '# Always rule\n'],
      ['.claude/rules/scoped.md', '---\npaths:\n  - "src/**"\n---\n# Scoped rule\n'],
      ['docs/MODDOC.md', '# Module doc\n'],
    ]) {
      const { dir, base } = baseRepo();
      write(dir, rel, body);
      const c = commit(dir, `trim ${rel}`);
      const r = check(dir, ['--range', `${base}..${c}`]);
      assert.strictEqual(r.code, 1, `FAIL: expected exit 1 for ${rel}:\n${r.out}`);
      assert.strictEqual(count(r.out, 'missing'), 1, r.out);
      assert.ok(r.out.includes(` ${rel}: `), r.out);
    }
  });

  test('bucket precedence: a line also surviving in a working doc counts as found-in-working', () => {
    const { dir, base } = baseRepo();
    // The surviving copy goes into a DIFFERENT perimeter doc, so git's diff
    // still reports all three paragraph lines as removed from docs/GUIDE.md.
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    write(dir, 'docs/MODDOC.md', `# Module doc\n\nModule doc line.\n${PARAGRAPH[0]}\n`);
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(PARAGRAPH));
    const c = commit(dir, 'archive, one line kept');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual(count(r.out, 'found-in-working'), 1, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), PARAGRAPH.length - 1, r.out);
    assertSumsToTotal(r.out);
  });

  test('merge commit is judged against its first parent', () => {
    const { dir } = baseRepo();
    const mainBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(dir, ['checkout', '-q', '-b', 'side']);
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    commit(dir, 'side: delete paragraph');
    git(dir, ['checkout', '-q', mainBranch]);
    const before = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    const merge = git(dir, ['rev-parse', 'HEAD']);
    const r = check(dir, ['--range', `${before}..${merge}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'commits scanned'), 1, r.out);
    assert.ok(r.out.includes('merge commit'), r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, merge)} docs/GUIDE.md: ${PARAGRAPH[0]}`), r.out);
  });

  test('--staged mirrors the pass case', () => {
    const { dir } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_STUB);
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(PARAGRAPH));
    git(dir, ['add', '-A']);
    const r = check(dir, ['--staged']);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'found-in-archive'), PARAGRAPH.length, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
  });

  test('--staged mirrors the no-archive fail, and judges the index, not the working tree', () => {
    const { dir } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    git(dir, ['add', '-A']);
    // An UNSTAGED archive copy must not rescue the staged deletion.
    write(dir, 'docs/archive/GUIDE/2026-10-23-old-topic.md', archiveText(PARAGRAPH));
    const r = check(dir, ['--staged']);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'missing'), PARAGRAPH.length, r.out);
    assert.ok(r.out.includes(`MISSING staged docs/GUIDE.md: ${PARAGRAPH[0]}`), r.out);
  });

  test('--staged on an unborn HEAD reports it and removes nothing', () => {
    const dir = scratch('mavp-archive-check-unborn-');
    git(dir, ['init', '-q', '-b', 'main']);
    write(dir, 'CLAUDE.md', '# Project\n');
    git(dir, ['add', '-A']);
    const r = check(dir, ['--staged']);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes('unborn HEAD'), r.out);
    assert.ok(/^0 removed lines in perimeter$/m.test(r.out), r.out);
  });

  test('a shallow clone is refused by name with exit 2 in --range mode', () => {
    const { dir } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    commit(dir, 'delete');
    const clone = scratch('mavp-archive-check-shallow-');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, clone], { env: ENV, stdio: 'ignore' });
    assert.strictEqual(git(clone, ['rev-parse', '--is-shallow-repository']), 'true');
    const r = check(clone, ['--range', 'HEAD..HEAD']);
    assert.strictEqual(r.code, 2, `FAIL: expected exit 2:\n${r.out}`);
    assert.ok(r.out.includes('shallow clone'), r.out);
    assert.ok(!/Result: PASS/.test(r.out), r.out);
  });

  test('usage and git errors exit 2', () => {
    const { dir } = baseRepo();
    for (const args of [[], ['--range', 'HEAD'], ['--range', 'HEAD...HEAD'], ['--staged', '--range', 'HEAD..HEAD'], ['--bogus'], ['--range', 'nope..HEAD']]) {
      const r = check(dir, args);
      assert.strictEqual(r.code, 2, `FAIL: expected exit 2 for ${JSON.stringify(args)}:\n${r.out}`);
    }
    const notRepo = scratch('mavp-archive-check-norepo-');
    const r = check(notRepo, ['--staged']);
    assert.strictEqual(r.code, 2, r.out);
    assert.ok(r.out.includes('not a git repository'), r.out);
  });

  test('the check writes no files', () => {
    const { dir, base } = baseRepo();
    write(dir, 'docs/GUIDE.md', GUIDE_WITHOUT_PARAGRAPH);
    const c = commit(dir, 'delete');
    const before = git(dir, ['status', '--porcelain', '--ignored']);
    check(dir, ['--range', `${base}..${c}`]);
    check(dir, ['--staged']);
    assert.strictEqual(git(dir, ['status', '--porcelain', '--ignored']), before);
  });

  // ---- T-793: amended-in-place bucket. Expected values come from the rule
  // (80% of tokens retained in order, or at most one token lost; descendants
  // only from added perimeter lines, never from archive files).
  const TEN = 'one two three four five six seven eight nine ten';

  /** baseRepo plus one extra layer-1 line committed into the base. */
  function repoWithLine(line) {
    const { dir } = baseRepo();
    write(dir, 'docs/GUIDE.md', `${GUIDE_BASE}${line}\n`);
    const base = commit(dir, 'add the long line');
    return { dir, base };
  }

  function replaceInGuide(dir, from, to) {
    const text = fs.readFileSync(path.join(dir, 'docs', 'GUIDE.md'), 'utf8');
    assert.ok(text.includes(from), `fixture sanity: ${from} not in GUIDE.md`);
    write(dir, 'docs/GUIDE.md', to === null ? text.replace(`${from}\n`, '') : text.replace(from, to));
  }

  test('pure extension of a line (all its words, in order, plus more) is amended-in-place, exit 0', () => {
    const { dir, base } = baseRepo();
    replaceInGuide(dir, PARAGRAPH[1], 'Old paragraph line beta, now with several more words added.');
    const c = commit(dir, 'extend a line in place');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 1, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 1, r.out);
    assert.strictEqual(count(r.out, 'found-in-working'), 0, r.out);
    assert.strictEqual(count(r.out, 'found-in-archive'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    assert.ok(r.out.includes(`AMENDED ${shortOf(dir, c)} docs/GUIDE.md (100% retained): ${PARAGRAPH[1]}`), r.out);
    assert.ok(/^Result: PASS.*1 amended in place/m.test(r.out), r.out);
    assertSumsToTotal(r.out);
  });

  test('one-word swap on a 3-token line is amended via the one-word floor (67% retained)', () => {
    const { dir, base } = baseRepo();
    replaceInGuide(dir, 'Keep line one.', 'Keep line two.');
    const c = commit(dir, 'swap one word');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 1, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 1, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    assert.ok(r.out.includes(`AMENDED ${shortOf(dir, c)} docs/GUIDE.md (67% retained): Keep line one.`), r.out);
    assertSumsToTotal(r.out);
  });

  test('a 10-token line whose descendant keeps 8 tokens in order is amended (80% boundary)', () => {
    const { dir, base } = repoWithLine(TEN);
    replaceInGuide(dir, TEN, 'one two three four five six seven eight tail');
    const c = commit(dir, 'keep 8 of 10');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 1, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 1, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    assert.ok(r.out.includes('(80% retained)'), r.out);
    assertSumsToTotal(r.out);
  });

  test('a 10-token line whose descendant keeps only 7 tokens is missing, exit 1, line named', () => {
    const { dir, base } = repoWithLine(TEN);
    replaceInGuide(dir, TEN, 'one two three four five six seven tail more');
    const c = commit(dir, 'keep 7 of 10');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 1, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 1, r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${TEN}`), r.out);
    assertSumsToTotal(r.out);
  });

  test('a 10-token line replaced by a 3-token summary sharing 2 tokens is missing', () => {
    const { dir, base } = repoWithLine(TEN);
    replaceInGuide(dir, TEN, 'one two summary');
    const c = commit(dir, 'replace by a summary');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'amended-in-place'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 1, r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${TEN}`), r.out);
    assertSumsToTotal(r.out);
  });

  test('a descendant in a perimeter file other than the one the line left still counts (parent union child perimeter)', () => {
    const { dir, base } = baseRepo();
    replaceInGuide(dir, PARAGRAPH[1], null);
    write(dir, 'docs/MODDOC.md', '# Module doc\n\nModule doc line.\nOld paragraph line beta plus a trailing clause.\n');
    const c = commit(dir, 'extend the line into the module doc');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'amended-in-place'), 1, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    assertSumsToTotal(r.out);
  });

  test('a >=80% descendant that sits only in a non-perimeter doc does not rescue the line', () => {
    const { dir, base } = baseRepo();
    replaceInGuide(dir, PARAGRAPH[1], null);
    write(dir, 'docs/OTHER.md', '# Other\n\nOther line one.\nOther line two.\nOld paragraph line beta, extended here.\n');
    const c = commit(dir, 'extension lands outside the perimeter');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'amended-in-place'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 1, r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${PARAGRAPH[1]}`), r.out);
    assertSumsToTotal(r.out);
  });

  test('a 90%-similar line present only in a same-commit archive file is missing (archive copies stay verbatim)', () => {
    const { dir, base } = repoWithLine(TEN);
    replaceInGuide(dir, TEN, null);
    write(dir, 'docs/archive/GUIDE/2026-10-23-ten.md', archiveText(['one two three four five six seven eight nine']));
    const c = commit(dir, 'archive a near copy');
    const r = check(dir, ['--range', `${base}..${c}`]);
    assert.strictEqual(r.code, 1, `FAIL: expected exit 1:\n${r.out}`);
    assert.strictEqual(count(r.out, 'found-in-archive'), 0, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 0, r.out);
    assert.strictEqual(count(r.out, 'missing'), 1, r.out);
    assert.ok(r.out.includes(`MISSING ${shortOf(dir, c)} docs/GUIDE.md: ${TEN}`), r.out);
    assertSumsToTotal(r.out);
  });

  test('--staged mirrors the pure-extension pass', () => {
    const { dir } = baseRepo();
    replaceInGuide(dir, PARAGRAPH[1], 'Old paragraph line beta, now with several more words added.');
    git(dir, ['add', '-A']);
    const r = check(dir, ['--staged']);
    assert.strictEqual(r.code, 0, `FAIL: expected exit 0:\n${r.out}`);
    assert.strictEqual(count(r.out, 'removed lines'), 1, r.out);
    assert.strictEqual(count(r.out, 'amended-in-place'), 1, r.out);
    assert.strictEqual(count(r.out, 'missing'), 0, r.out);
    assert.ok(r.out.includes(`AMENDED staged docs/GUIDE.md (100% retained): ${PARAGRAPH[1]}`), r.out);
    assertSumsToTotal(r.out);
  });

  console.log(`PASS: test-doc-archive-check (${results.length} cases)`);
} finally {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
}
