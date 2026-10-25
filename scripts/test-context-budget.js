'use strict';
// T-782 — always-loaded context character budget.
//
// Fixture-based: builds a synthetic project root per case and asserts on
// collectAlwaysLoadedContext() (import grammar, hop cap, cycles, rule scoping)
// and on the validator's context_size_budget check (info severity, exit 0,
// override handling, per-document naming).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert');

const { collectAlwaysLoadedContext } = require('./mavp-operator-lib.js');
const {
  parseArtifacts,
  getExitCode,
  createFinding,
  renderValidatorReport,
  DEFAULT_ARTIFACT_BUDGETS,
} = require('./mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't782-test-'));
let caseCounter = 0;

function makeRoot(files) {
  caseCounter += 1;
  const root = path.join(TMP_DIR, `case-${caseCounter}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function paths(result) {
  return result.files.map((f) => f.path).sort();
}

const BACKLOG = '# BACKLOG\n\n## Active Wave\n\n## Archived Wave 1\n';
const TASK_STATUS = '# TASK_STATUS\n\n## Active tasks\n\n## Recently completed tasks\n';

// Runs the whole validator parse over a root that carries the minimal state files.
function validate(files, processState) {
  const root = makeRoot({
    'BACKLOG.md': BACKLOG,
    'TASK_STATUS.md': TASK_STATUS,
    ...(processState !== undefined ? { 'PROCESS_STATE.json': JSON.stringify(processState) } : {}),
    ...files,
  });
  const parsed = parseArtifacts({
    backlogPath: path.join(root, 'BACKLOG.md'),
    taskStatusPath: path.join(root, 'TASK_STATUS.md'),
  });
  const findings = parsed.comparison.findings.filter((f) => f.checkName === 'context_size_budget');
  return { parsed, findings, root };
}

// ---------------------------------------------------------------------------
// Test 1: an import from docs/a.md of ../notes/c.md resolves relative to the
// IMPORTING file (root/notes/c.md), and both imports are counted.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': 'top\n@docs/a.md\n',
    'docs/a.md': 'aaaa\n@../notes/c.md\n',
    'notes/c.md': 'cccccc',
  });
  const r = collectAlwaysLoadedContext(root);
  assert.deepStrictEqual(paths(r), ['CLAUDE.md', 'docs/a.md', 'notes/c.md'], `Test 1 FAIL: ${JSON.stringify(r)}`);
  const c = r.files.find((f) => f.path === 'notes/c.md');
  assert.strictEqual(c.chars, 6);
  assert.strictEqual(c.kind, 'import');
  assert.strictEqual(r.total_chars, 'top\n@docs/a.md\n'.length + 'aaaa\n@../notes/c.md\n'.length + 6);
  console.log('Test 1 passed: relative import resolves against the importing file; both imports counted');
}

// ---------------------------------------------------------------------------
// Test 2: hop cap — CLAUDE.md -> f1 -> f2 -> f3 -> f4 -> f5; only four hops
// are followed, so f1..f4 are counted and f5 is not.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': '@f1.md\n',
    'f1.md': '@f2.md\n',
    'f2.md': '@f3.md\n',
    'f3.md': '@f4.md\n',
    'f4.md': '@f5.md\n',
    'f5.md': 'leaf',
  });
  const r = collectAlwaysLoadedContext(root);
  assert.deepStrictEqual(paths(r), ['CLAUDE.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md'], `Test 2 FAIL: ${JSON.stringify(r)}`);
  assert.ok(!r.files.some((f) => f.path === 'f5.md'), 'Test 2 FAIL: f5 is the fifth hop and must not be counted');
  console.log('Test 2 passed: depth capped at four hops');
}

// ---------------------------------------------------------------------------
// Test 3: @ inside a fenced block and inside backticks is not imported.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': ['prose', '```', '@fenced.md', '```', 'inline `@ticked.md` here', '~~~', '@tilde.md', '~~~', '@real.md', ''].join('\n'),
    'fenced.md': 'x',
    'ticked.md': 'x',
    'tilde.md': 'x',
    'real.md': 'x',
  });
  const r = collectAlwaysLoadedContext(root);
  assert.deepStrictEqual(paths(r), ['CLAUDE.md', 'real.md'], `Test 3 FAIL: ${JSON.stringify(r)}`);
  console.log('Test 3 passed: fenced blocks and code spans are skipped');
}

// ---------------------------------------------------------------------------
// Test 4: a two-file cycle terminates and counts each file once.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': '@a.md\n',
    'a.md': '@b.md\n',
    'b.md': ['@a.md', '@CLAUDE.md', ''].join('\n'),
  });
  const r = collectAlwaysLoadedContext(root);
  assert.deepStrictEqual(paths(r), ['CLAUDE.md', 'a.md', 'b.md'], `Test 4 FAIL: ${JSON.stringify(r)}`);
  console.log('Test 4 passed: cycle terminates, each file counted once');
}

// ---------------------------------------------------------------------------
// Test 5: rules — one with paths: frontmatter is bucketed out, one without is
// counted; a nested rule is found recursively.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': 'x',
    '.claude/rules/scoped.md': '---\npaths:\n  - "src/**"\n---\n\nscoped body\n',
    '.claude/rules/inline-scoped.md': '---\npaths: ["a/**"]\n---\nbody\n',
    '.claude/rules/unscoped.md': '# always on\nbody\n',
    '.claude/rules/nested/deep.md': '---\ndescription: no paths here\n---\ndeep\n',
  });
  const r = collectAlwaysLoadedContext(root);
  const rules = r.files.filter((f) => f.kind === 'rule').map((f) => f.path).sort();
  assert.deepStrictEqual(rules, ['.claude/rules/nested/deep.md', '.claude/rules/unscoped.md'], `Test 5 FAIL: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(
    r.path_scoped_rules.map((f) => f.path).sort(),
    ['.claude/rules/inline-scoped.md', '.claude/rules/scoped.md']
  );
  console.log('Test 5 passed: only unscoped rules are counted; scoped ones are bucketed separately');
}

// ---------------------------------------------------------------------------
// Test 6: external and missing targets; email-like and package-like tokens.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({
    'CLAUDE.md': 'mail me at someone@example.com\nsee @../outside.md and @gone.md and "@quoted file.md" and @~/x.md\nuse @types/node here\n',
  });
  const r = collectAlwaysLoadedContext(root);
  assert.deepStrictEqual(
    [...r.external].sort(),
    [path.resolve(root, '..', 'outside.md'), path.join(os.homedir(), 'x.md')].sort(),
    `Test 6 FAIL: external ${JSON.stringify(r.external)}`
  );
  const missing = r.files.filter((f) => f.missing).map((f) => f.path).sort();
  assert.deepStrictEqual(missing, ['gone.md', 'types/node'], `Test 6 FAIL: ${JSON.stringify(r.files)}`);
  assert.ok(r.files.filter((f) => f.missing).every((f) => f.chars === 0));
  assert.strictEqual(r.total_chars, r.files.find((f) => f.kind === 'claude_md').chars);
  console.log('Test 6 passed: external listed not counted; missing listed with chars 0; email and quoted tokens ignored');
}

// ---------------------------------------------------------------------------
// Test 7: injectable readFile (git-tree readers) is honoured.
// ---------------------------------------------------------------------------
{
  const root = makeRoot({});
  const virtual = { [path.join(root, 'CLAUDE.md')]: '@v.md', [path.join(root, 'v.md')]: 'vvv' };
  const r = collectAlwaysLoadedContext(root, {
    readFile: (p) => (Object.prototype.hasOwnProperty.call(virtual, p) ? virtual[p] : null),
    listMarkdown: () => [],
  });
  assert.deepStrictEqual(paths(r), ['CLAUDE.md', 'v.md']);
  assert.strictEqual(r.total_chars, 8);
  console.log('Test 7 passed: readFile is injectable');
}

// ---------------------------------------------------------------------------
// Test 8: over-budget total yields exactly one info finding naming top
// contributors; exit code stays 0.
// ---------------------------------------------------------------------------
{
  // Five imports of 35000 chars each: every one is under the per-document
  // budget, but together they push the total past always_loaded_max_chars.
  const piece = 'x'.repeat(35000);
  const { parsed, findings } = validate({
    'CLAUDE.md': '@big1.md @big2.md @big3.md @big4.md @big5.md\n',
    'big1.md': piece,
    'big2.md': piece,
    'big3.md': piece,
    'big4.md': piece,
    'big5.md': piece,
  });
  assert.ok(5 * 35000 > DEFAULT_ARTIFACT_BUDGETS.always_loaded_max_chars);
  assert.strictEqual(findings.length, 1, `Test 8 FAIL: expected exactly one finding, got ${JSON.stringify(findings)}`);
  assert.strictEqual(findings[0].severity, 'info');
  assert.match(findings[0].message, /big\d\.md/);
  assert.strictEqual(getExitCode(parsed.comparison.overallCandidateState), 0, 'Test 8 FAIL: info finding must not change the exit code');
  console.log('Test 8 passed: over-budget total -> exactly one info finding, exit 0');
}

// ---------------------------------------------------------------------------
// Test 8c (T-798): the rendered report labels a project-level finding
// "[project]" (never the bracketed null), the total-budget action names the
// module context_docs route, and task-keyed findings keep "[T-123]" in the
// Failures/Warnings block and in the info "## Findings" block.
// ---------------------------------------------------------------------------
{
  const piece = 'x'.repeat(35000);
  const { parsed, findings } = validate({
    'CLAUDE.md': '@big1.md @big2.md @big3.md @big4.md @big5.md\n',
    'big1.md': piece, 'big2.md': piece, 'big3.md': piece, 'big4.md': piece, 'big5.md': piece,
  });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].taskId, null, 'Test 8c FAIL: fixture finding must be project-level (taskId null)');
  assert.match(findings[0].suggestedAction, /context_docs/, 'Test 8c FAIL: suggestedAction must name context_docs');
  assert.match(findings[0].suggestedAction, /docs\/MODULES\.md/, 'Test 8c FAIL: suggestedAction must name docs/MODULES.md');
  const report = renderValidatorReport(parsed);
  assert.ok(report.includes('- [project] context_size_budget'), `Test 8c FAIL: missing project label in:\n${report}`);
  assert.ok(!report.includes('[null]'), 'Test 8c FAIL: report must not contain the bracketed null label');
  assert.ok(!report.includes('[undefined]'), 'Test 8c FAIL: report must not contain the bracketed undefined label');

  // Task-keyed labels unchanged, in the warning block and the info block.
  const synthetic = {
    ...parsed,
    comparison: {
      ...parsed.comparison,
      findings: [
        createFinding({ checkName: 'zz_warn_check', severity: 'warning', taskId: 'T-123', message: 'm', repairTarget: 'r', suggestedAction: 'a' }),
        createFinding({ checkName: 'zz_info_check', severity: 'info', taskId: 'T-123', message: 'm', repairTarget: 'r', suggestedAction: 'a' }),
        createFinding({ checkName: 'zz_warn_proj', severity: 'warning', taskId: undefined, message: 'm', repairTarget: 'r', suggestedAction: 'a' }),
        createFinding({ checkName: 'zz_info_proj', severity: 'info', taskId: null, message: 'm', repairTarget: 'r', suggestedAction: 'a' }),
        createFinding({ checkName: 'zz_info_agg', severity: 'info', taskId: 'AGGREGATE', message: 'm', repairTarget: 'r', suggestedAction: 'a' }),
      ],
    },
  };
  const synth = renderValidatorReport(synthetic);
  assert.ok(synth.includes('- [T-123] zz_warn_check\n'), 'Test 8c FAIL: warning block must keep [T-123]');
  assert.ok(synth.includes('- [T-123] zz_info_check: m'), 'Test 8c FAIL: info block must keep [T-123]');
  assert.ok(synth.includes('- [project] zz_warn_proj\n'), 'Test 8c FAIL: undefined taskId must render [project] in warning block');
  assert.ok(synth.includes('- [project] zz_info_proj: m'), 'Test 8c FAIL: null taskId must render [project] in info block');
  assert.ok(synth.includes('- [AGGREGATE] zz_info_agg: m'), 'Test 8c FAIL: AGGREGATE label must be unchanged');
  console.log('Test 8c passed: [project] label, context_docs route in action, [T-123]/[AGGREGATE] unchanged');
}

// Test 8b: the finding names only the top five contributors.
{
  const files = { 'CLAUDE.md': Array.from({ length: 7 }, (_, i) => `@d${i}.md`).join('\n') + '\n' };
  for (let i = 0; i < 7; i += 1) files[`d${i}.md`] = 'y'.repeat(100 + i);
  const { findings } = validate(files, { artifact_budgets: { always_loaded_max_chars: 100 } });
  assert.strictEqual(findings.length, 1);
  const named = (findings[0].message.match(/d\d\.md/g) || []).sort();
  assert.deepStrictEqual(named, ['d2.md', 'd3.md', 'd4.md', 'd5.md', 'd6.md'], `Test 8b FAIL: ${findings[0].message}`);
  console.log('Test 8b passed: message names the top five contributors by chars');
}

// ---------------------------------------------------------------------------
// Test 9: per-document overflow names the file (import, unscoped rule, and
// module context_docs); an under-budget total produces no total finding.
// ---------------------------------------------------------------------------
{
  const over = 'z'.repeat(DEFAULT_ARTIFACT_BUDGETS.imported_doc_max_chars + 5);
  const { findings } = validate({
    'CLAUDE.md': '@imp.md\n',
    'imp.md': over,
    '.claude/rules/fat.md': over,
    'docs/MODULES.md': '# Modules\n\n## widget\n- **label:** Widget\n- **repos:** r\n- **context_docs:** docs/ctx.md\n- **default_owner:** developer\n',
    'docs/ctx.md': over,
  });
  const msgs = findings.map((f) => f.message).join('\n');
  assert.strictEqual(findings.length, 3, `Test 9 FAIL: ${msgs}`);
  for (const name of ['imp.md', '.claude/rules/fat.md', 'docs/ctx.md']) {
    assert.ok(msgs.includes(name), `Test 9 FAIL: ${name} not named in\n${msgs}`);
  }
  assert.ok(findings.every((f) => f.severity === 'info'));
  console.log('Test 9 passed: per-document overflow names each imported doc, unscoped rule and module context_doc');
}

// ---------------------------------------------------------------------------
// Test 10: overrides change the outcome in both directions, for both budgets.
// ---------------------------------------------------------------------------
{
  const mid = 'm'.repeat(5000);
  const files = { 'CLAUDE.md': '@mid.md\n', 'mid.md': mid };
  assert.strictEqual(validate(files).findings.length, 0, 'Test 10 FAIL: defaults should be clean');
  const lowered = validate(files, { artifact_budgets: { always_loaded_max_chars: 1000, imported_doc_max_chars: 1000 } }).findings;
  assert.strictEqual(lowered.length, 2, `Test 10 FAIL: lowered overrides should fire total + per-doc, got ${JSON.stringify(lowered)}`);

  const big = 'b'.repeat(DEFAULT_ARTIFACT_BUDGETS.imported_doc_max_chars + 100);
  const bigFiles = { 'CLAUDE.md': '@big.md\n', 'big.md': big };
  assert.strictEqual(validate(bigFiles).findings.length, 1, 'Test 10 FAIL: defaults should fire per-doc');
  const raised = validate(bigFiles, { artifact_budgets: { imported_doc_max_chars: 1000000 } }).findings;
  assert.strictEqual(raised.length, 0, `Test 10 FAIL: raised override should silence per-doc, got ${JSON.stringify(raised)}`);

  const hugeFiles = { 'CLAUDE.md': '@h.md\n', 'h.md': 'h'.repeat(DEFAULT_ARTIFACT_BUDGETS.always_loaded_max_chars + 100) };
  const total = validate(hugeFiles, { artifact_budgets: { always_loaded_max_chars: 10000000, imported_doc_max_chars: 10000000 } }).findings;
  assert.strictEqual(total.length, 0, 'Test 10 FAIL: raised total override should silence the total finding');
  console.log('Test 10 passed: artifact_budgets overrides change the outcome in both directions');
}

// ---------------------------------------------------------------------------
// Test 11: claude_md_max_lines is unchanged and the new defaults are as specified.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(DEFAULT_ARTIFACT_BUDGETS.claude_md_max_lines, 400);
  assert.strictEqual(DEFAULT_ARTIFACT_BUDGETS.always_loaded_max_chars, 160000);
  assert.strictEqual(DEFAULT_ARTIFACT_BUDGETS.imported_doc_max_chars, 40000);
  console.log('Test 11 passed: budget defaults');
}

// ===========================================================================
// T-791 — per-document max_chars exceptions (doc_limits), the doc_limit_ratchet
// check, and the text-level registry parser.
// ===========================================================================
const { execFileSync } = require('node:child_process');
const { parseModuleRegistry, parseModuleRegistryFromText } = require('./mavp-operator-lib.js');

function modulesDoc(limitsLine) {
  return [
    '# Modules', '', '## widget', '- **label:** Widget', '- **repos:** r',
    '- **context_docs:** docs/ctx.md, docs/other.md',
    ...(limitsLine === null ? [] : [`- **doc_limits:** ${limitsLine}`]),
    '- **default_owner:** developer', '',
  ].join('\n');
}

function gitIn(root, args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Builds a fixture root. When headModules is a string, a real git repo is
// created whose single commit records that docs/MODULES.md; the working tree
// then gets workingModules. headModules === null means no git repo at all.
function ratchetRoot({ headModules, workingModules, docChars }) {
  const root = makeRoot({
    'BACKLOG.md': BACKLOG,
    'TASK_STATUS.md': TASK_STATUS,
    'CLAUDE.md': 'x\n',
    'docs/ctx.md': 'c'.repeat(docChars),
  });
  if (headModules !== null) {
    gitIn(root, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), headModules, 'utf8');
    gitIn(root, ['add', '-A']);
    gitIn(root, ['commit', '-q', '-m', 'fixture head']);
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), workingModules, 'utf8');
  const parsed = parseArtifacts({
    backlogPath: path.join(root, 'BACKLOG.md'),
    taskStatusPath: path.join(root, 'TASK_STATUS.md'),
  });
  const by = (name) => parsed.comparison.findings.filter((f) => f.checkName === name);
  return { parsed, budget: by('context_size_budget'), ratchet: by('doc_limit_ratchet'), root };
}

// ---------------------------------------------------------------------------
// Test 12: a 50,000-char doc with max_chars: 60000 (T-999) yields no per-doc
// finding; the control without the exception yields one.
// ---------------------------------------------------------------------------
{
  const withLimit = modulesDoc('docs/ctx.md max_chars: 60000 (T-999)');
  const r = ratchetRoot({ headModules: withLimit, workingModules: withLimit, docChars: 50000 });
  assert.strictEqual(r.budget.length, 0, `Test 12 FAIL: exception must replace imported_doc_max_chars, got ${JSON.stringify(r.budget)}`);
  assert.strictEqual(r.ratchet.length, 0, `Test 12 FAIL: unchanged exception must not trip the ratchet, got ${JSON.stringify(r.ratchet)}`);
  assert.strictEqual(getExitCode(r.parsed.comparison.overallCandidateState), 0);

  const bare = modulesDoc(null);
  const control = ratchetRoot({ headModules: bare, workingModules: bare, docChars: 50000 });
  assert.strictEqual(control.budget.length, 1, `Test 12 FAIL: control (no exception) should fire once, got ${JSON.stringify(control.budget)}`);
  console.log('Test 12 passed: exception of 60000 silences a 50,000-char doc; control without it fires');
}

// ---------------------------------------------------------------------------
// Test 13: raising 60000 (HEAD) to 70000 (working tree) yields exactly one
// doc_limit_ratchet finding at info severity, exit 0.
// ---------------------------------------------------------------------------
{
  const r = ratchetRoot({
    headModules: modulesDoc('docs/ctx.md max_chars: 60000 (T-999)'),
    workingModules: modulesDoc('docs/ctx.md max_chars: 70000 (T-999)'),
    docChars: 50000,
  });
  assert.strictEqual(r.ratchet.length, 1, `Test 13 FAIL: expected exactly one ratchet finding, got ${JSON.stringify(r.ratchet)}`);
  assert.strictEqual(r.ratchet[0].severity, 'info');
  assert.match(r.ratchet[0].message, /docs\/ctx\.md/);
  assert.match(r.ratchet[0].message, /70000/);
  assert.match(r.ratchet[0].message, /60000/);
  assert.strictEqual(r.budget.length, 0, 'Test 13 FAIL: 50,000 chars is within the 70000 exception');
  assert.strictEqual(getExitCode(r.parsed.comparison.overallCandidateState), 0, 'Test 13 FAIL: ratchet finding must not change the exit code');
  console.log('Test 13 passed: raising an exception above its HEAD value -> exactly one doc_limit_ratchet finding, exit 0');
}

// ---------------------------------------------------------------------------
// Test 14: lowering 60000 (HEAD) to 55000 (working tree) yields no finding.
// ---------------------------------------------------------------------------
{
  const r = ratchetRoot({
    headModules: modulesDoc('docs/ctx.md max_chars: 60000 (T-999)'),
    workingModules: modulesDoc('docs/ctx.md max_chars: 55000 (T-999)'),
    docChars: 50000,
  });
  assert.strictEqual(r.ratchet.length, 0, `Test 14 FAIL: lowering must be clean, got ${JSON.stringify(r.ratchet)}`);
  assert.strictEqual(r.budget.length, 0);
  console.log('Test 14 passed: lowering an exception raises no finding');
}

// ---------------------------------------------------------------------------
// Test 15: an exception of 40000 against a 50,000-char doc yields exactly one
// doc_limit_ratchet finding (smaller than the document's current size). The
// document also exceeds its own limit, so context_size_budget reports it too.
// ---------------------------------------------------------------------------
{
  const doc = modulesDoc('docs/ctx.md max_chars: 40000 (T-999)');
  const r = ratchetRoot({ headModules: doc, workingModules: doc, docChars: 50000 });
  assert.strictEqual(r.ratchet.length, 1, `Test 15 FAIL: expected exactly one ratchet finding, got ${JSON.stringify(r.ratchet)}`);
  assert.match(r.ratchet[0].message, /smaller than the document/);
  assert.strictEqual(r.budget.length, 1, 'Test 15 FAIL: the doc exceeds its own 40000 exception, context_size_budget names it');
  assert.match(r.budget[0].message, /T-999/);
  assert.strictEqual(getExitCode(r.parsed.comparison.overallCandidateState), 0);
  console.log('Test 15 passed: exception smaller than the document -> one doc_limit_ratchet finding, exit 0');
}

// ---------------------------------------------------------------------------
// Test 16: degrades silently without git history — no repo at all, and a repo
// whose HEAD lacks docs/MODULES.md — so the raise cannot be compared and no
// ratchet finding appears (and nothing throws).
// ---------------------------------------------------------------------------
{
  const raised = modulesDoc('docs/ctx.md max_chars: 70000 (T-999)');
  const noGit = ratchetRoot({ headModules: null, workingModules: raised, docChars: 50000 });
  assert.strictEqual(noGit.ratchet.length, 0, `Test 16 FAIL: no git repo -> no comparison, got ${JSON.stringify(noGit.ratchet)}`);

  const root = makeRoot({ 'BACKLOG.md': BACKLOG, 'TASK_STATUS.md': TASK_STATUS, 'CLAUDE.md': 'x\n', 'docs/ctx.md': 'c'.repeat(50000) });
  gitIn(root, ['init', '-q', '-b', 'main']);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'head without modules doc']);
  fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), raised, 'utf8');
  const parsed = parseArtifacts({ backlogPath: path.join(root, 'BACKLOG.md'), taskStatusPath: path.join(root, 'TASK_STATUS.md') });
  assert.strictEqual(parsed.comparison.findings.filter((f) => f.checkName === 'doc_limit_ratchet').length, 0, 'Test 16 FAIL: file absent at HEAD -> no comparison');
  console.log('Test 16 passed: no git / no file at HEAD degrades silently');
}

// ---------------------------------------------------------------------------
// Test 17: parseModuleRegistryFromText holds the parsing body; doc_limits parse
// into {path: {max_chars, task}}, context_docs keeps its comma-split, malformed
// entries are skipped, and an entry without the field has doc_limits {}.
// ---------------------------------------------------------------------------
{
  const text = [
    '# Modules', '', '## What', '- **label:** meta', '',
    '## alpha', '- **label:** Alpha', '- **repos:** r1, r2',
    '- **context_docs:** docs/a.md, docs/b.md',
    '- **doc_limits:** docs/a.md max_chars: 60000 (T-999), `docs/b.md` max_chars: 45000 (T-998), docs/c.md max_chars: lots (T-1), docs/d.md max_chars: 5',
    '- **default_owner:** qa',
    '- **qa_checklist:**', '  - step one', '',
    '## beta', '- **label:** Beta', '- **context_docs:** docs/z.md', '',
  ].join('\n');
  const reg = parseModuleRegistryFromText(text);
  assert.deepStrictEqual(Object.keys(reg), ['alpha', 'beta'], 'Test 17 FAIL: meta heading skipped, both modules found');
  assert.deepStrictEqual(reg.alpha.context_docs, ['docs/a.md', 'docs/b.md']);
  assert.deepStrictEqual(reg.alpha.repos, ['r1', 'r2']);
  assert.strictEqual(reg.alpha.default_owner, 'qa');
  assert.deepStrictEqual(reg.alpha.qa_checklist, ['step one'], `Test 17 FAIL: qa_checklist must be exactly the one item, got ${JSON.stringify(reg.alpha.qa_checklist)}`);
  assert.deepStrictEqual(reg.alpha.doc_limits, {
    'docs/a.md': { max_chars: 60000, task: 'T-999', owner: 'T-999' },
    'docs/b.md': { max_chars: 45000, task: 'T-998', owner: 'T-998' },
  }, `Test 17 FAIL: ${JSON.stringify(reg.alpha.doc_limits)}`);
  assert.deepStrictEqual(reg.beta.doc_limits, {});
  assert.deepStrictEqual(reg.beta.context_docs, ['docs/z.md']);
  assert.deepStrictEqual(parseModuleRegistryFromText(''), {});
  assert.deepStrictEqual(parseModuleRegistryFromText(undefined), {});

  // parseModuleRegistry(root) delegates to the text helper after reading docs/MODULES.md.
  const root = makeRoot({ 'docs/MODULES.md': text });
  assert.deepStrictEqual(parseModuleRegistry(root), reg, 'Test 17 FAIL: parseModuleRegistry(root) must equal the text-helper result');
  assert.deepStrictEqual(parseModuleRegistry(makeRoot({})), {}, 'Test 17 FAIL: missing file -> {}');
  console.log('Test 17 passed: text helper parses doc_limits; parseModuleRegistry delegates; malformed entries skipped');
}

// ---------------------------------------------------------------------------
// Test 18 (T-805): qa_checklist parsing. Indented items are collected, a
// following top-level field line terminates the list and still parses, an
// unindented `- item` directly after the header is accepted, and the shipped
// template's module-a yields exactly its two items.
// ---------------------------------------------------------------------------
{
  const twoIndented = [
    '## A', '- **label:** A', '- **context_docs:** docs/A.md',
    '- **qa_checklist:**', '  - first', '  - second',
    '- **doc_limits:** docs/A.md max_chars: 50000 (T-1)', '',
  ].join('\n');
  const a = parseModuleRegistryFromText(twoIndented).A;
  assert.deepStrictEqual(a.qa_checklist, ['first', 'second'], `Test 18 FAIL: ${JSON.stringify(a.qa_checklist)}`);
  assert.deepStrictEqual(a.doc_limits, { 'docs/A.md': { max_chars: 50000, task: 'T-1', owner: 'T-1' } });
  assert.deepStrictEqual(a.context_docs, ['docs/A.md']);

  const unindented = ['## B', '- **qa_checklist:**', '- bare item', '- **default_owner:** qa', '## C', '- **label:** C', ''].join('\n');
  const reg = parseModuleRegistryFromText(unindented);
  assert.deepStrictEqual(reg.B.qa_checklist, ['bare item'], 'Test 18 FAIL: unindented item after the header is still accepted');
  assert.strictEqual(reg.B.default_owner, 'qa');
  assert.deepStrictEqual(reg.C.qa_checklist, [], 'Test 18 FAIL: a ## heading ends the list; next module has none');

  const tpl = parseModuleRegistryFromText(fs.readFileSync(path.join(__dirname, '..', 'templates', 'MODULES.md'), 'utf8'));
  assert.deepStrictEqual(tpl['module-a'].qa_checklist, ['Add QA steps specific to this module', 'Verify expected behavior in staging before promoting'], `Test 18 FAIL: ${JSON.stringify(tpl['module-a'].qa_checklist)}`);
  console.log('Test 18 passed: qa_checklist collects indented/unindented items and stops at a top-level field or heading');
}

// ---------------------------------------------------------------------------
// Test 19 (T-805): doc_limits owner is any single whitespace-free token in the
// parentheses; a DR owner parses, is exposed as `owner`, and flows through the
// validator (exception honoured, per-document message names the owner).
// ---------------------------------------------------------------------------
{
  const reg = parseModuleRegistryFromText(modulesDoc('docs/x.md max_chars: 50000 (DR-016), docs/y.md max_chars: 40000 (docs-owner), docs/z.md max_chars: 3 (two words)'));
  assert.deepStrictEqual(reg.widget.doc_limits, {
    'docs/x.md': { max_chars: 50000, task: 'DR-016', owner: 'DR-016' },
    'docs/y.md': { max_chars: 40000, task: 'docs-owner', owner: 'docs-owner' },
  }, `Test 19 FAIL: ${JSON.stringify(reg.widget.doc_limits)}`);

  const within = modulesDoc('docs/ctx.md max_chars: 60000 (DR-016)');
  const ok = ratchetRoot({ headModules: within, workingModules: within, docChars: 50000 });
  assert.strictEqual(ok.budget.length, 0, `Test 19 FAIL: DR-owned exception must be honoured, got ${JSON.stringify(ok.budget)}`);
  assert.strictEqual(ok.ratchet.length, 0);
  const raised = ratchetRoot({ headModules: within, workingModules: modulesDoc('docs/ctx.md max_chars: 70000 (DR-016)'), docChars: 50000 });
  assert.strictEqual(raised.ratchet.length, 1, `Test 19 FAIL: ratchet must still fire for a DR owner, got ${JSON.stringify(raised.ratchet)}`);
  assert.match(raised.ratchet[0].message, /DR-016/);
  const tight = modulesDoc('docs/ctx.md max_chars: 40000 (DR-016)');
  const over = ratchetRoot({ headModules: tight, workingModules: tight, docChars: 50000 });
  assert.strictEqual(over.budget.length, 1);
  assert.match(over.budget[0].message, /DR-016/, `Test 19 FAIL: per-document message must name the DR owner, got ${over.budget[0].message}`);
  console.log('Test 19 passed: non-task doc_limits owner parses, is exposed as owner, and works with the ratchet and validator messages');
}

fs.rmSync(TMP_DIR, { recursive: true, force: true });
console.log('\nAll T-782, T-791 and T-805 assertions passed.');
