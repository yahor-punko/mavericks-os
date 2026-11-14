'use strict';
// T-888: renderSessionBrief() (scripts/mavp-operator-lib.js) renders the
// operator-facing session brief the session-start skill used to describe in
// prose. Every assertion below states the contract (the old skill's rendering
// rules and the T-888 acceptance criteria), not whatever the function returned
// when first run.
//
// Covers:
//   1. Wave 7 / session 2 / declared permission mode / no wave goal / one
//      planned task: the required lines appear, and none of the lines that
//      belong to absent fields.
//   2. The permission-mode provenance suffix (declared and verified forms).
//   3. A due, overdue recheck renders with the overdue marker.
//   4. Empty task lists offer "Close wave N" and not "Continue current wave";
//      non-empty lists offer the reverse.
//   5. Conflict, tip, update notice, blocker and the three must-read lists.
//   6. First-run prompt only when firstRun and next_action is null.
//   7. `--agent --brief` end to end on a fixture project, and plain `--agent`
//      still prints parseable JSON.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const { renderSessionBrief } = require('./mavp-operator-lib.js');

function lines(text) {
  return text.split('\n');
}

const base = {
  wave: 7,
  wave_session: 2,
  permission_mode: 'bypassPermissions',
  permission_mode_source: 'settings_file',
  permission_mode_verified: false,
  initiative: 'X',
  wave_goal: null,
  active_slices: [],
  planned_tasks: [{ id: 'T-001', title: 'A', status: 'planned' }],
  next_action: 'T-001 → developer → do',
};

// 1. Required lines present, absent-field lines absent.
{
  const out = renderSessionBrief(base, { firstRun: false });
  const l = lines(out);
  for (const want of [
    '## Wave 7 — Session 2',
    'Permission mode: bypassPermissions (declared — source: settings_file, not verified this session)',
    'Initiative: X',
    'Wave goal: not set — agree one with the operator and record it with --set-wave-goal',
    '- T-001 (planned) — A',
    'Next action: T-001 → developer → do',
  ]) {
    assert.ok(l.includes(want), `Test 1 FAIL: missing line ${JSON.stringify(want)} in:\n${out}`);
  }
  for (const banned of ['Rechecks due', 'Must read:', 'Framework version']) {
    assert.ok(!out.includes(banned), `Test 1 FAIL: unexpected ${JSON.stringify(banned)} in:\n${out}`);
  }
  assert.ok(!out.includes('Restore prompt-free operation'), 'Test 1 FAIL: bypassPermissions must not get the tip');
  console.log('Test 1 passed: required lines present, absent-field lines absent');
}

// 2. Provenance suffix, both forms; session suffix omitted when absent/0.
{
  const verified = renderSessionBrief({ ...base, permission_mode_source: 'hook_payload', permission_mode_verified: true });
  assert.ok(lines(verified).includes('Permission mode: bypassPermissions (verified this session)'), `Test 2 FAIL (verified form):\n${verified}`);
  for (const ws of [null, 0, undefined]) {
    const out = renderSessionBrief({ ...base, wave_session: ws });
    assert.ok(lines(out).includes('## Wave 7'), `Test 2 FAIL: wave_session ${ws} must omit the session suffix:\n${out}`);
  }
  console.log('Test 2 passed: verified form and session-suffix omission');
}

// 3. Overdue recheck.
{
  const out = renderSessionBrief({ ...base, due_rechecks: [{ id: 'RC-1', task: 'T-9', title: 't', due: '2026-01-01', overdue: true }] });
  assert.ok(out.includes('- T-9 — t (due: 2026-01-01) ⚠ OVERDUE'), `Test 3 FAIL:\n${out}`);
  assert.ok(out.includes('Rechecks due'), 'Test 3 FAIL: callout heading missing');
  const notOverdue = renderSessionBrief({ ...base, due_rechecks: [{ id: 'RC-2', task: 'T-9', title: 't', due: '2026-01-01', overdue: false }] });
  assert.ok(notOverdue.includes('- T-9 — t (due: 2026-01-01)') && !notOverdue.includes('OVERDUE'), `Test 3 FAIL (not overdue):\n${notOverdue}`);
  const waveKeyed = renderSessionBrief({ ...base, due_rechecks: [{ id: 'RC-3', wave: 9, title: 'Wave 9 — external review', due: '2026-10-01', overdue: false }] });
  assert.ok(waveKeyed.includes('- Wave 9 — external review (due: 2026-10-01)'), `Test 3 FAIL (wave-keyed):\n${waveKeyed}`);
  console.log('Test 3 passed: recheck lines');
}

// 4. Options block for empty and non-empty lists.
{
  const empty = renderSessionBrief({ ...base, planned_tasks: [], active_slices: [] });
  assert.ok(empty.includes('Close wave 7'), `Test 4 FAIL: empty case lacks "Close wave 7":\n${empty}`);
  assert.ok(!empty.includes('Continue current wave'), 'Test 4 FAIL: empty case must not offer "Continue current wave"');
  assert.ok(!empty.includes('What would you like to do?'), 'Test 4 FAIL: empty case must not ask the three-option question');
  const nonEmpty = renderSessionBrief(base);
  assert.ok(nonEmpty.includes('Continue current wave') && !nonEmpty.includes('Close wave'), `Test 4 FAIL: non-empty case:\n${nonEmpty}`);
  const activeOnly = renderSessionBrief({ ...base, planned_tasks: undefined, active_slices: [{ id: 'T-2', title: 'B', status: 'in_progress' }] });
  assert.ok(activeOnly.includes('- T-2 (in_progress) — B') && activeOnly.includes('Continue current wave'), `Test 4 FAIL: active-only case:\n${activeOnly}`);
  console.log('Test 4 passed: options blocks');
}

// 5. Conflict, tip, update notice, blocker, must-read lists, counters.
{
  const out = renderSessionBrief({
    ...base,
    permission_mode: 'default',
    permission_mode_conflict: { project: 'default', user_global: 'bypassPermissions' },
    UPDATE_AVAILABLE: 'A newer framework is available.',
    blocker: 'PROCESS_STATE_WARNING',
    wave_goal: 'ship it',
    wave_summary: 'prior',
    wave_strategy_note: 'note',
    must_read: ['a.md'],
    must_read_oversized: [{ path: 'big.md', chars: 50000 }],
    must_read_framework: ['.claude/rules/x.md'],
    intake_untriaged: 3,
    skill_proposals_unreviewed: 2,
    feedback_answers_unacked: 1,
    reporting_write_skipped: { discriminator: 'linked_worktree', resolved_root: '/r', reason: 'x' },
  });
  for (const want of [
    '⚠ Permission mode conflict: project declares "default", user-global (~/.claude/settings.json) declares "bypassPermissions" — precedence between these is harness-owned; verify manually which one governed this session.',
    '> [!TIP] Restore prompt-free operation',
    '> [!NOTE] Framework version',
    '> A newer framework is available.',
    '⚠ Blocker: PROCESS_STATE_WARNING — stop and resolve it before other work',
    'Wave goal: ship it',
    'Previous wave: prior',
    'Strategy note: note',
    'Must read:',
    '- a.md',
    'Oversized (search, do not read whole):',
    '- big.md (50000 chars)',
    'Framework-managed (changed by the last update, not yours to review):',
    '- .claude/rules/x.md',
    '> [!NOTE] Intake: 3 untriaged adopter item(s) — run ./scripts/mavp-operator --intake',
    '> [!NOTE] Skill proposals: 2 awaiting a Decision in SKILL_PROPOSALS/ — review per docs/SKILL_OPTIMIZATION.md section 9',
    'Feedback answers: 1 — run ./scripts/mavp-operator --feedback --status',
    '> [!NOTE] Reporting writes skipped: /r is a never-a-project root (linked_worktree) — PROCESS_STATE.md was not regenerated. Set MAVERICKS_ALLOW_NEVER_PROJECT_ROOT=1 only if that write is intended.',
  ]) {
    assert.ok(lines(out).includes(want), `Test 5 FAIL: missing line ${JSON.stringify(want)} in:\n${out}`);
  }
  assert.ok(!out.includes('Wave goal: not set'), 'Test 5 FAIL: a set goal must not render the not-set line');
  // Order contract: mustRead -> oversized -> framework, each after the permission-mode block.
  const idx = (s) => out.indexOf(s);
  assert.ok(idx('Permission mode:') < idx('Initiative:') && idx('Must read:') < idx('Oversized') && idx('Oversized') < idx('Framework-managed'), `Test 5 FAIL: order:\n${out}`);
  console.log('Test 5 passed: conflict, tip, notices, blocker, must-read lists, counters');
}

// 6. First-run prompt.
{
  const first = renderSessionBrief({ ...base, planned_tasks: [], next_action: null }, { firstRun: true });
  assert.ok(first.includes('What are you building?'), `Test 6 FAIL: first-run prompt missing:\n${first}`);
  assert.ok(!first.includes('Next action: null') && !first.includes('Options:') && !first.includes('Close wave'), `Test 6 FAIL: first-run extras:\n${first}`);
  const firstWithAction = renderSessionBrief(base, { firstRun: true });
  assert.ok(!firstWithAction.includes('What are you building?') && firstWithAction.includes('Next action: T-001 → developer → do'), 'Test 6 FAIL: non-null next_action on first run follows the normal branches');
  const notFirst = renderSessionBrief({ ...base, planned_tasks: [], next_action: null }, { firstRun: false });
  assert.ok(!notFirst.includes('What are you building?') && !notFirst.includes('Next action: null'), `Test 6 FAIL: non-first-run:\n${notFirst}`);
  console.log('Test 6 passed: first-run prompt');
}

// 7. End to end through the real entry point, in a fixture project outside any git tree.
{
  const scratch = fs.mkdtempSync(path.join(process.env.CLAUDE_SCRATCHPAD || os.tmpdir(), 'test-session-brief-'));
  process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'BACKLOG.md'), '# BACKLOG\n\n## Active Wave\n\n', 'utf8');
  fs.writeFileSync(path.join(scratch, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n\n', 'utf8');
  fs.writeFileSync(path.join(scratch, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'Fixture initiative',
    stage: 'execution',
    wave: 7,
    wave_session: 2,
    wave_goal: null,
    active_slices: [],
    next_action: 'Open next wave',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 1,
    last_updated: '2026-01-01',
    deploy_contours: 0,
    rechecks: [],
  }, null, 2) + '\n', 'utf8');
  const env = {
    ...process.env,
    MAVERICKS_PROJECT_ROOT: scratch,
    MAVERICKS_USER_GLOBAL_SETTINGS_PATH: path.join(scratch, 'no-such-user-settings.json'),
  };
  const agent = path.join(__dirname, 'mavp-operator-agent.js');
  const brief = execFileSync('node', [agent, '--brief'], { cwd: scratch, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.ok(lines(brief).includes('## Wave 7 — Session 2'), `Test 7 FAIL: brief header missing:\n${brief}`);
  assert.ok(brief.includes('Initiative: Fixture initiative') && brief.includes('Next action: Open next wave') && brief.includes('Close wave 7'), `Test 7 FAIL: brief body:\n${brief}`);
  assert.throws(() => JSON.parse(brief), 'Test 7 FAIL: --brief output must not be JSON');
  const json = JSON.parse(execFileSync('node', [agent], { cwd: scratch, env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.strictEqual(json.wave, 7, 'Test 7 FAIL: plain --agent must still print the JSON object');
  console.log('Test 7 passed: --agent --brief prints the brief; plain --agent still prints JSON');
}

console.log('\nAll T-888 session-brief assertions passed.');
