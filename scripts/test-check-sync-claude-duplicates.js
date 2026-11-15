'use strict';
// Unit test: T-894 — findClaudeMdOnDemandDuplicates() and the --check-sync advisory built on it,
// plus the adopter-run framework-root resolution. Every fixture is a temp-dir framework root and
// project; every spawn of the check-sync script pins MAVERICKS_PROJECTS, MAVERICKS_PROJECT_ROOT and
// HOME so no resolution chain reaches a real install.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { findClaudeMdOnDemandDuplicates } = require('./mavp-operator-lib.js');
const { resolveFrameworkRoot } = require('./mavp-operator-check-sync.js');

const CHECK_SYNC = path.join(__dirname, 'mavp-operator-check-sync.js');
const SCRIPT_ROOT = path.resolve(__dirname, '..');

const SENTINEL = 'SENTINELTOKEN' + '4242';
const RULE_LINE = 'The sample rule insists that every fixture line stays long enough to count as text.';
const SKILL_LINE = 'The sample skill describes a step that only the framework copy of the skill carries.';
const SHORT_SHARED = 'Short shared line 20';
const CMD_LONG = './scripts/mavp-operator --close-session   # ' + SENTINEL + ' closes the session and sweeps every terminal task out of the active lists';
const CMD_SHORT = './scripts/mavp-operator --go #'; // 30 chars
const AUTHORED_LINE = 'This project authored line is long enough to be checked and carries ' + SENTINEL + ' inside it.';

assert.ok(RULE_LINE.trim().length >= 60 && SKILL_LINE.trim().length >= 60, 'fixture: long lines are 60+ chars');
assert.strictEqual(SHORT_SHARED.length, 20, 'fixture: shared short line is 20 chars');
assert.ok(CMD_LONG.length >= 120, 'fixture: long command is 120+ chars');
assert.strictEqual(CMD_SHORT.length, 30, 'fixture: short command is 30 chars');

const roots = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
function put(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const RULE_BODY = '# Sample rule\n\n' + RULE_LINE + '\n' + SHORT_SHARED + '\n';
const SKILL_BODY = '# Sample skill\n\n' + SKILL_LINE + '\n';
const COMMANDS_DOC = '# Commands\n\n### --close-session\n\n- text\n\n### --go\n\n- text\n';

function makeFramework() {
  const fw = tmp('mavp-dup-fw-');
  put(fw, 'scripts/mavp-operator-lib.js', '// marker\n');
  put(fw, 'scripts/mavp-version.js', "module.exports = { MAVERICKS_VERSION: '9.9.9' };\n");
  put(fw, '.claude/rules/sample-rule.md', RULE_BODY);
  put(fw, '.claude/skills/sample-skill/SKILL.md', SKILL_BODY);
  put(fw, 'docs/core/OPERATOR_COMMANDS.md', COMMANDS_DOC);
  return fw;
}

function claudeMdWithDuplicates() {
  return [
    '# Project',
    AUTHORED_LINE,
    RULE_LINE,
    SKILL_LINE,
    SHORT_SHARED,
    '```bash',
    CMD_LONG,
    CMD_SHORT,
    '```',
    '',
  ].join('\n');
}

function makeProject(parent, name, claudeMd, withRuleCopy, withSkillCopy) {
  const proj = path.join(parent, name);
  fs.mkdirSync(proj, { recursive: true });
  if (claudeMd !== null) put(proj, 'CLAUDE.md', claudeMd);
  if (withRuleCopy) put(proj, '.claude/rules/sample-rule.md', RULE_BODY);
  if (withSkillCopy) put(proj, '.claude/skills/sample-skill/SKILL.md', SKILL_BODY);
  return proj;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runCheckSync(env) {
  const r = spawnSync(process.execPath, [CHECK_SYNC], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return { status: r.status, out: stripAnsi(r.stdout || ''), err: r.stderr || '' };
}

try {
  // --- Test 1: criteria 1 and 2 — tiers, states, floors, char sums ---
  {
    const fw = makeFramework();
    const proj = makeProject(tmp('mavp-dup-proj-'), 'p', claudeMdWithDuplicates(), true, false);
    const r = findClaudeMdOnDemandDuplicates(proj, { frameworkRoot: fw });
    assert.strictEqual(r.skipped, null, 'Test 1 FAIL: not skipped');
    assert.strictEqual(r.claude_md_chars, claudeMdWithDuplicates().length, 'Test 1 FAIL: claude_md_chars');
    assert.ok(r.always_loaded_chars >= r.claude_md_chars, 'Test 1 FAIL: always_loaded_chars covers CLAUDE.md');
    assert.strictEqual(r.matches.length, 3, 'Test 1 FAIL: exactly three matches, got ' + JSON.stringify(r.matches));
    const byLine = (n) => r.matches.find((m) => m.line === n);
    // CLAUDE.md line numbers: 1 heading, 2 authored, 3 rule line, 4 skill line, 5 short shared, 6 fence, 7 long cmd, 8 short cmd
    assert.deepStrictEqual(byLine(3), { line: 3, chars: RULE_LINE.length + 1, home: '.claude/rules/sample-rule.md', tier: 'verbatim', state: 'in_project' }, 'Test 1 FAIL: rule line');
    assert.deepStrictEqual(byLine(4), { line: 4, chars: SKILL_LINE.length + 1, home: '.claude/skills/sample-skill/SKILL.md', tier: 'verbatim', state: 'after_update' }, 'Test 1 FAIL: skill line');
    assert.deepStrictEqual(byLine(7), { line: 7, chars: CMD_LONG.length + 1, home: 'docs/core/OPERATOR_COMMANDS.md', tier: 'command', state: 'framework_doc' }, 'Test 1 FAIL: long command line');
    assert.strictEqual(byLine(2), undefined, 'Test 1 FAIL: project-authored line must not be reported');
    assert.strictEqual(byLine(5), undefined, 'Test 1 FAIL: 20-char shared line must not be reported');
    assert.strictEqual(byLine(8), undefined, 'Test 1 FAIL: 30-char fenced command must not be reported');
    assert.strictEqual(r.removable_now_chars, RULE_LINE.length + CMD_LONG.length + 2, 'Test 1 FAIL: removable_now_chars');
    assert.strictEqual(r.removable_after_update_chars, SKILL_LINE.length + 1, 'Test 1 FAIL: removable_after_update_chars');
    console.log('Test 1 passed: verbatim in_project / after_update and command framework_doc, floors and char sums');
  }

  // --- Test 2: a command line outside a fence is not a command match ---
  {
    const fw = makeFramework();
    const proj = makeProject(tmp('mavp-dup-proj-'), 'p', '# P\n' + CMD_LONG + '\n', false, false);
    const r = findClaudeMdOnDemandDuplicates(proj, { frameworkRoot: fw });
    assert.deepStrictEqual(r.matches, [], 'Test 2 FAIL: an unfenced command line must not be reported');
    console.log('Test 2 passed: unfenced command line not reported');
  }

  // --- Test 3: criterion 3 — skipped reasons, never throws ---
  {
    const fw = makeFramework();
    const sourceTree = makeProject(tmp('mavp-dup-proj-'), 'src', claudeMdWithDuplicates(), true, false);
    put(sourceTree, 'scripts/mavp-operator-lib.js', '// marker\n');
    assert.strictEqual(findClaudeMdOnDemandDuplicates(sourceTree, { frameworkRoot: fw }).skipped, 'framework_source_tree', 'Test 3 FAIL: source tree');
    const noClaude = makeProject(tmp('mavp-dup-proj-'), 'none', null, true, false);
    const rn = findClaudeMdOnDemandDuplicates(noClaude, { frameworkRoot: fw });
    assert.strictEqual(rn.skipped, 'no_claude_md', 'Test 3 FAIL: no CLAUDE.md');
    assert.deepStrictEqual(rn.matches, [], 'Test 3 FAIL: skipped result has no matches');
    const proj = makeProject(tmp('mavp-dup-proj-'), 'p', claudeMdWithDuplicates(), true, false);
    assert.strictEqual(findClaudeMdOnDemandDuplicates(proj, { frameworkRoot: path.join(fw, 'absent') }).skipped, 'no_framework_root', 'Test 3 FAIL: missing framework root');
    for (const bad of [undefined, null, 42, {}]) {
      const rb = findClaudeMdOnDemandDuplicates(bad, { frameworkRoot: fw });
      assert.strictEqual(typeof rb.skipped, 'string', 'Test 3 FAIL: garbage input is skipped, not thrown');
    }
    console.log('Test 3 passed: framework_source_tree, no_claude_md, no_framework_root, never throws');
  }

  // --- Test 4: criteria 4 and 5 — check-sync advisory output, exit code, summary, privacy ---
  {
    const fw = makeFramework();
    const home = tmp('mavp-dup-home-');
    const dup = makeProject(home, 'proj-dup', claudeMdWithDuplicates(), true, false);
    const clean = makeProject(home, 'proj-clean', '# Clean\n' + AUTHORED_LINE + '\n', true, true);
    const synced = makeProject(home, 'proj-synced', '# Synced\n' + RULE_LINE + '\n', true, true);
    const cmd = {
      HOME: home,
      MAVERICKS_PROJECT_ROOT: fw,
    };

    const first = runCheckSync({ ...cmd, MAVERICKS_PROJECTS: dup + ':' + clean });
    assert.strictEqual(first.status, 0, 'Test 4 FAIL: exit code 0, stderr: ' + first.err);
    const summary = `CLAUDE.md: ${claudeMdWithDuplicates().length} chars`;
    assert.ok(first.out.includes(summary), 'Test 4 FAIL: summary line, got:\n' + first.out);
    assert.ok(first.out.includes(`removable now ${RULE_LINE.length + CMD_LONG.length + 2} chars, after update ${SKILL_LINE.length + 1} chars`), 'Test 4 FAIL: removable counts, got:\n' + first.out);
    assert.ok(/\.claude\/rules\/sample-rule\.md — in_project — CLAUDE\.md line 3\b/.test(first.out), 'Test 4 FAIL: rule home line, got:\n' + first.out);
    assert.ok(/\.claude\/skills\/sample-skill\/SKILL\.md — after_update — CLAUDE\.md line 4\b/.test(first.out), 'Test 4 FAIL: skill home line');
    assert.ok(/docs\/core\/OPERATOR_COMMANDS\.md — framework_doc — CLAUDE\.md line 7\b/.test(first.out), 'Test 4 FAIL: command home line');
    assert.ok(first.out.includes('CLAUDE.md: no duplicated on-demand text'), 'Test 4 FAIL: clean project no-duplicates line');
    assert.ok(first.out.includes('--check-archive') && first.out.includes('docs/archive/'), 'Test 4 FAIL: closing line names the archive step');
    // proj-dup lacks the skill, so the sync summary reports drift; the advisory must not change that
    assert.ok(first.out.includes('1 file(s) drifted') && first.out.includes('to resync a drifted project'), 'Test 4 FAIL: drift summary unchanged, got:\n' + first.out);
    assert.ok(!first.out.includes('All projects in sync.'), 'Test 4 FAIL: drift summary must not say in sync');
    // criterion 5: privacy
    assert.ok(!first.out.includes(SENTINEL) && !first.err.includes(SENTINEL), 'Test 4 FAIL: sentinel leaked to output');
    for (const text of [RULE_LINE, SKILL_LINE, AUTHORED_LINE]) {
      assert.ok(!first.out.includes(text), 'Test 4 FAIL: project text printed');
    }

    // in-sync summary stays when the advisory fires
    const second = runCheckSync({ ...cmd, MAVERICKS_PROJECTS: synced });
    assert.strictEqual(second.status, 0, 'Test 4 FAIL: exit code 0 (synced)');
    assert.ok(second.out.includes('All projects in sync.'), 'Test 4 FAIL: in-sync summary unchanged, got:\n' + second.out);
    assert.ok(/removable now \d+ chars/.test(second.out), 'Test 4 FAIL: advisory present beside in-sync summary');
    console.log('Test 4 passed: advisory lines, exit 0, unchanged summaries, no project text printed');
  }

  // --- Test 5: criterion 6 — root resolution ---
  {
    const fw = makeFramework();
    const home = tmp('mavp-dup-home-');
    const alpha = makeProject(home, 'adopter-alpha', '# A\n', false, false);
    const beta = makeProject(home, 'adopter-beta', '# B\n', false, false);
    const r = runCheckSync({ HOME: home, MAVERICKS_PROJECT_ROOT: alpha, MAVERICKS_PROJECTS: beta });
    assert.strictEqual(r.status, 0, 'Test 5 FAIL: exit code 0, stderr: ' + r.err);
    assert.ok(r.out.includes('comparing against ' + SCRIPT_ROOT), 'Test 5 FAIL: header names the script checkout, got:\n' + r.out);
    assert.ok(!r.out.includes('comparing against ' + alpha), 'Test 5 FAIL: header must not name the adopter root');
    const ia = r.out.indexOf('adopter-alpha');
    const ib = r.out.indexOf('adopter-beta');
    assert.ok(ia !== -1 && ib !== -1 && ia < ib, 'Test 5 FAIL: both projects checked, adopter root first, got:\n' + r.out);
    assert.ok(r.out.includes('Checking 2 project(s)'), 'Test 5 FAIL: two projects checked');

    const viaTree = runCheckSync({ HOME: home, MAVERICKS_PROJECT_ROOT: fw, MAVERICKS_PROJECTS: beta });
    assert.ok(viaTree.out.includes('comparing against ' + fw), 'Test 5 FAIL: framework source tree named as today, got:\n' + viaTree.out);
    assert.ok(viaTree.out.includes('Checking 1 project(s)'), 'Test 5 FAIL: nothing added for a framework root');

    const unit = resolveFrameworkRoot(alpha, SCRIPT_ROOT);
    assert.deepStrictEqual(unit, { frameworkRoot: SCRIPT_ROOT, adopterRoot: alpha }, 'Test 5 FAIL: resolveFrameworkRoot adopter');
    assert.deepStrictEqual(resolveFrameworkRoot(fw, SCRIPT_ROOT), { frameworkRoot: fw, adopterRoot: null }, 'Test 5 FAIL: resolveFrameworkRoot framework');
    assert.deepStrictEqual(resolveFrameworkRoot(undefined, SCRIPT_ROOT), { frameworkRoot: SCRIPT_ROOT, adopterRoot: null }, 'Test 5 FAIL: resolveFrameworkRoot unset');
    console.log('Test 5 passed: adopter-run root resolution and framework-tree root unchanged');
  }
} finally {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('All check-sync CLAUDE.md duplicate tests passed');
