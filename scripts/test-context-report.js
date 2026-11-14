'use strict';
// T-885 — mavp-context-report.js
//
// Fixture-based: builds a git repo in a temp dir and runs the real script as a
// child process (working tree and --rev). Expected numbers are derived from
// the lengths of the fixture strings below, i.e. from the contract (what each
// metric is defined to count), never from a previous run of the script.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert');

const SCRIPT = path.join(__dirname, 'mavp-context-report.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't885-test-'));

// Hermetic git: no host config, pinned identity, no hooks, pinned branch.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function git(root, args) {
  return cp.execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + os.devNull, ...args], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function report(root, extraArgs) {
  const out = cp.execFileSync('node', [SCRIPT, '--json', '--root', root, ...extraArgs], {
    env: { ...GIT_ENV, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

// --- fixture contents (lengths are the contract) ----------------------------
const CLAUDE_MD = '# Fixture\n@docs/a.md\n' + 'c'.repeat(79); // 10 + 11 + 79 = 100 chars
const DOC_A_V1 = 'a'.repeat(40);
const DOC_A_V2 = 'a'.repeat(70);
const RULE_UNSCOPED = 'unscoped rule body ' + 'u'.repeat(31); // 50 chars
const RULE_SCOPED = '---\npaths:\n  - "scripts/**/*.js"\n---\n' + 's'.repeat(60);
const AGENT_ONE = '---\nname: alpha\ndescription: first agent\nmodel: sonnet\n---\n' + 'x'.repeat(200);
const AGENT_TWO = '---\nname: beta\ndescription: "second agent"\nomitClaudeMd: true\n---\n' + 'y'.repeat(120);
const SS_BODY = 'b'.repeat(90);
const SKILL_SS = '---\nname: session-start\ndescription: load state\n---\n' + SS_BODY;
const SKILL_OTHER = '---\nname: other\ndescription: another skill here\n---\nignored body';

const ALWAYS_V1 = CLAUDE_MD.length + DOC_A_V1.length + RULE_UNSCOPED.length;
const ALWAYS_V2 = CLAUDE_MD.length + DOC_A_V2.length + RULE_UNSCOPED.length;
const AGENT_DESC = 'alpha'.length + 'first agent'.length + 'beta'.length + 'second agent'.length;
const SKILL_DESC =
  'session-start'.length + 'load state'.length + 'other'.length + 'another skill here'.length;

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

const root = path.join(TMP, 'repo');
fs.mkdirSync(root, { recursive: true });
git(root, ['init', '-q', '-b', 'main']);
write(root, 'CLAUDE.md', CLAUDE_MD);
write(root, 'docs/a.md', DOC_A_V1);
write(root, '.claude/rules/unscoped.md', RULE_UNSCOPED);
write(root, '.claude/rules/scoped.md', RULE_SCOPED);
write(root, '.claude/agents/alpha.md', AGENT_ONE);
write(root, '.claude/agents/beta.md', AGENT_TWO);
write(root, '.claude/skills/session-start/SKILL.md', SKILL_SS);
write(root, '.claude/skills/other/SKILL.md', SKILL_OTHER);
git(root, ['add', '-A']);
git(root, ['commit', '-q', '-m', 'first']);
write(root, 'docs/a.md', DOC_A_V2);
git(root, ['add', '-A']);
git(root, ['commit', '-q', '-m', 'second']);

// Test 1: exact working-tree numbers.
{
  const r = report(root, []);
  assert.strictEqual(r.always_loaded_chars, ALWAYS_V2, 'always_loaded_chars');
  assert.strictEqual(r.agent_description_chars, AGENT_DESC, 'agent_description_chars');
  assert.strictEqual(r.skill_description_chars, SKILL_DESC, 'skill_description_chars');
  assert.strictEqual(r.session_start_skill_body_chars, SS_BODY.length, 'session_start_skill_body_chars');
  assert.strictEqual(
    r.session_start_static_chars,
    ALWAYS_V2 + AGENT_DESC + SKILL_DESC + SS_BODY.length,
    'session_start_static_chars is the sum of the four'
  );
  console.log('Test 1 passed: exact always_loaded and session_start_static numbers');
}

// Test 2: the path-scoped rule is excluded from always_loaded_chars but listed.
{
  const r = report(root, []);
  assert.strictEqual(r.always_loaded_chars, ALWAYS_V2, 'path-scoped rule must not be counted');
  assert.ok(r.always_loaded_chars < ALWAYS_V2 + RULE_SCOPED.length);
  assert.deepStrictEqual(r.path_scoped_rules, [{ path: '.claude/rules/scoped.md', chars: RULE_SCOPED.length }]);
  console.log('Test 2 passed: path-scoped rule excluded from always_loaded_chars, listed separately');
}

// Test 3: per-role fixed_chars exact; omitClaudeMd true gives layer0 0.
{
  const r = report(root, []);
  const alpha = r.per_role.find((p) => p.role === 'alpha');
  const beta = r.per_role.find((p) => p.role === 'beta');
  assert.deepStrictEqual(alpha, {
    role: 'alpha',
    layer0_chars: ALWAYS_V2,
    spec_body_chars: 200,
    fixed_chars: ALWAYS_V2 + 200,
  });
  assert.deepStrictEqual(beta, { role: 'beta', layer0_chars: 0, spec_body_chars: 120, fixed_chars: 120 });
  assert.strictEqual(r.per_role.length, 2);
  console.log('Test 3 passed: per-role fixed_chars exact; omitClaudeMd true -> layer0_chars 0');
}

// Test 4: two commits give different totals for --rev HEAD~1 and --rev HEAD,
// and the working tree agrees with HEAD.
{
  const prev = report(root, ['--rev', 'HEAD~1']);
  const head = report(root, ['--rev', 'HEAD']);
  assert.strictEqual(prev.always_loaded_chars, ALWAYS_V1);
  assert.strictEqual(head.always_loaded_chars, ALWAYS_V2);
  assert.notStrictEqual(prev.always_loaded_chars, head.always_loaded_chars);
  assert.strictEqual(head.session_start_static_chars - prev.session_start_static_chars, DOC_A_V2.length - DOC_A_V1.length);
  console.log('Test 4 passed: --rev HEAD~1 and --rev HEAD differ by the committed change');
}

// Test 5: --rev reads the committed tree, not the working tree.
{
  write(root, 'docs/a.md', 'z'.repeat(500));
  const head = report(root, ['--rev', 'HEAD']);
  assert.strictEqual(head.always_loaded_chars, ALWAYS_V2, '--rev must ignore uncommitted edits');
  write(root, 'docs/a.md', DOC_A_V2);
  console.log('Test 5 passed: --rev ignores uncommitted working-tree edits');
}

// Test 6: bad or option-shaped refs are refused with exit 2 and no report.
{
  for (const bad of ['no-such-ref', '--output=x']) {
    const res = cp.spawnSync('node', [SCRIPT, '--json', '--root', root, '--rev', bad], {
      env: GIT_ENV,
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 2, `ref ${bad} must exit 2`);
    assert.strictEqual(res.stdout, '', `ref ${bad} must print no report`);
  }
  console.log('Test 6 passed: unknown and option-shaped refs exit 2');
}

// Test 7: table output names what is not counted; the run is read-only.
{
  const before = git(root, ['status', '--porcelain']);
  const out = cp.execFileSync('node', [SCRIPT, '--root', root], { env: GIT_ENV, encoding: 'utf8' });
  assert.match(out, /always_loaded_chars/);
  for (const name of ['harness system prompt', 'auto-memory', '--agent output', 'HANDOFF.md', 'brief']) {
    assert.ok(out.includes(name), `table must name "${name}" as not counted`);
  }
  assert.strictEqual(git(root, ['status', '--porcelain']), before, 'script must not change the tree');
  console.log('Test 7 passed: table names the uncounted sources; no files changed');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('test-context-report: all tests passed');
