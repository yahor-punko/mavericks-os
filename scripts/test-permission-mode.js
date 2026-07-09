'use strict';
// Unit test: T-316 — readPermissionMode helper + --agent JSON permission_mode field
// Extended by T-318 — runtime permission-mode detection from hook stdin payload
// Extended by T-321 — persisted runtime permission_mode + close-session push gate precedence

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readPermissionMode } = require('./mavp-operator-lib.js');

const SCRATCH_ROOT = path.join(
  process.env.CLAUDE_SCRATCHPAD || os.tmpdir(),
  `test-permission-mode-${process.pid}-${Date.now()}`
);

function makeFixture(name, { local, shared } = {}) {
  const root = path.join(SCRATCH_ROOT, name);
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  if (local !== undefined) {
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify(local, null, 2), 'utf8');
  }
  if (shared !== undefined) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(shared, null, 2), 'utf8');
  }
  return root;
}

function cleanup() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}

process.on('exit', cleanup);

// --- Unit-level tests: readPermissionMode(root) directly ---

// Test 1: settings.json sets defaultMode "acceptEdits", no local override
{
  const root = makeFixture('shared-only', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const mode = readPermissionMode(root);
  assert.strictEqual(mode, 'acceptEdits', 'Test 1 FAIL: expected "acceptEdits" from settings.json');
  console.log('Test 1 passed: readPermissionMode resolves "acceptEdits" from settings.json (no local override)');
}

// Test 2: settings.local.json "plan" overrides settings.json "acceptEdits" (local wins)
{
  const root = makeFixture('local-override', {
    local: { permissions: { defaultMode: 'plan' } },
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const mode = readPermissionMode(root);
  assert.strictEqual(mode, 'plan', 'Test 2 FAIL: expected "plan" — local should win over shared');
  console.log('Test 2 passed: readPermissionMode resolves "plan" from settings.local.json (local wins over shared)');
}

// Test 3: neither file sets a mode -> "default"
{
  const root = makeFixture('neither-set', {});
  const mode = readPermissionMode(root);
  assert.strictEqual(mode, 'default', 'Test 3 FAIL: expected "default" when neither file exists');
  console.log('Test 3 passed: readPermissionMode falls back to "default" when neither file is present');
}

// Test 3b: files exist but do not set permissions.defaultMode -> "default"
{
  const root = makeFixture('present-but-unset', {
    local: { env: { FOO: 'bar' } },
    shared: { permissions: { allow: ['Bash(ls)'] } },
  });
  const mode = readPermissionMode(root);
  assert.strictEqual(mode, 'default', 'Test 3b FAIL: expected "default" when neither file sets defaultMode');
  console.log('Test 3b passed: readPermissionMode falls back to "default" when files exist but set no mode');
}

// Test 3c: malformed JSON is swallowed gracefully -> falls through / "default"
{
  const root = makeFixture('malformed', {});
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{ not valid json', 'utf8');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }), 'utf8');
  const mode = readPermissionMode(root);
  assert.strictEqual(mode, 'acceptEdits', 'Test 3c FAIL: malformed local settings should be skipped, falling through to shared');
  console.log('Test 3c passed: malformed settings.local.json is swallowed gracefully, falls through to settings.json');
}

// Test 4: helper performs no writes — mtime of fixture files unchanged after read
{
  const root = makeFixture('no-writes', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const sharedPath = path.join(root, '.claude', 'settings.json');
  const before = fs.statSync(sharedPath).mtimeMs;
  readPermissionMode(root);
  const after = fs.statSync(sharedPath).mtimeMs;
  assert.strictEqual(after, before, 'Test 4 FAIL: readPermissionMode must not modify files (mtime changed)');
  console.log('Test 4 passed: readPermissionMode performs no writes (mtime unchanged)');
}

// --- Integration: --agent JSON surfaces permission_mode additively via MAVERICKS_PROJECT_ROOT ---

const AGENT_SCRIPT = path.join(__dirname, 'mavp-operator-agent.js');

function runAgent(projectRoot, { input, timeout } = {}) {
  const options = {
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: projectRoot },
    encoding: 'utf8',
  };
  if (input !== undefined) options.input = input;
  if (timeout !== undefined) options.timeout = timeout;
  const stdout = execFileSync('node', [AGENT_SCRIPT], options);
  return JSON.parse(stdout);
}

// Test 5: --agent JSON contains "permission_mode": "acceptEdits" (shared only)
{
  const root = makeFixture('agent-shared-only', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const output = runAgent(root);
  assert.strictEqual(output.permission_mode, 'acceptEdits', 'Test 5 FAIL: expected "acceptEdits" in --agent JSON');
  assert.ok('initiative' in output, 'Test 5 FAIL: existing "initiative" field must still be present');
  assert.ok('stage' in output, 'Test 5 FAIL: existing "stage" field must still be present');
  console.log('Test 5 passed: --agent JSON contains "permission_mode": "acceptEdits" (shared only), existing fields intact');
}

// Test 6: --agent JSON local override "plan" wins over shared "acceptEdits"
{
  const root = makeFixture('agent-local-override', {
    local: { permissions: { defaultMode: 'plan' } },
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const output = runAgent(root);
  assert.strictEqual(output.permission_mode, 'plan', 'Test 6 FAIL: expected "plan" (local wins) in --agent JSON');
  console.log('Test 6 passed: --agent JSON emits "plan" when local overrides shared "acceptEdits"');
}

// Test 7: --agent JSON emits "default" when neither file sets a mode
{
  const root = makeFixture('agent-neither', {});
  const output = runAgent(root);
  assert.strictEqual(output.permission_mode, 'default', 'Test 7 FAIL: expected "default" in --agent JSON');
  console.log('Test 7 passed: --agent JSON emits "default" when neither settings file sets a mode');
}

// --- T-318: SessionStart hook stdin payload override, with no-hang guarantee ---

// Test 8: stdin payload with "permission_mode": "plan" overrides settings-file "acceptEdits"
{
  const root = makeFixture('agent-stdin-override', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const hookPayload = JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'startup',
    permission_mode: 'plan',
  });
  const output = runAgent(root, { input: hookPayload, timeout: 5000 });
  assert.strictEqual(output.permission_mode, 'plan', 'Test 8 FAIL: expected "plan" from stdin hook payload to override settings-file "acceptEdits"');
  console.log('Test 8 passed: --agent JSON emits "plan" from SessionStart hook stdin payload, overriding settings-file "acceptEdits"');
}

// Test 9: no stdin payload -> falls back to settings-file resolution AND does not hang.
// A hard timeout on the child process proves this: if the fix ever blocked reading stdin
// (e.g. reading from an open TTY-like fd with no EOF), execFileSync would throw ETIMEDOUT
// and this test would fail loudly instead of hanging the whole suite.
{
  const root = makeFixture('agent-no-stdin-payload', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const start = Date.now();
  let output;
  try {
    // No `input` option — mirrors the skill's `!` command path, which invokes
    // agent.js with no piped payload (stdin is either a TTY or an empty pipe).
    output = runAgent(root, { timeout: 5000 });
  } catch (err) {
    assert.fail(`Test 9 FAIL: agent.js hung or errored with no stdin payload — ${err.message}`);
  }
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 5000, `Test 9 FAIL: agent.js took ${elapsedMs}ms with no stdin payload — expected a prompt, non-blocking return`);
  assert.strictEqual(output.permission_mode, 'acceptEdits', 'Test 9 FAIL: expected fallback to settings-file "acceptEdits" when no stdin payload is present');
  console.log(`Test 9 passed: --agent JSON falls back to settings-file "acceptEdits" with no stdin payload, returned promptly (${elapsedMs}ms), no hang`);
}

// --- T-321: persisted runtime permission_mode + close-session push gate precedence ---

const CLOSE_SESSION_SCRIPT = path.join(__dirname, 'mavp-operator-close-session.js');

// Minimal close-session fixture: settings.json (shared permission mode),
// an empty "## Active tasks" section (so the wave is immediately "complete"
// with no active tasks), and a bare PROCESS_STATE.json/BACKLOG.md.
function makeCloseSessionFixture(name, { shared } = {}) {
  const root = makeFixture(name, { shared });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# BACKLOG\n', 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# TASK_STATUS\n\n## Active tasks\n', 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), '{}\n', 'utf8');
  return root;
}

function runCloseSessionPush(root) {
  return execFileSync('node', [CLOSE_SESSION_SCRIPT, '--non-interactive', '--push'], {
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 10000,
  });
}

// Test 10: hook payload with permission_mode "bypassPermissions" is persisted to
// .mavp/permission-mode even when settings files say "acceptEdits", and a
// subsequent non-interactive close-session --push suppresses the push with the
// gate message (persisted value takes precedence over settings-file resolution).
{
  const root = makeCloseSessionFixture('close-session-persisted-bypass', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });

  const hookPayload = JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'startup',
    permission_mode: 'bypassPermissions',
  });
  runAgent(root, { input: hookPayload, timeout: 5000 });

  const stateFilePath = path.join(root, '.mavp', 'permission-mode');
  assert.ok(fs.existsSync(stateFilePath), 'Test 10 FAIL: expected .mavp/permission-mode to be written by agent.js');
  assert.strictEqual(
    fs.readFileSync(stateFilePath, 'utf8').trim(),
    'bypassPermissions',
    'Test 10 FAIL: expected persisted state file to contain "bypassPermissions"'
  );

  const output = runCloseSessionPush(root);
  assert.ok(
    output.includes('push suppressed under bypassPermissions'),
    'Test 10 FAIL: expected close-session --push to print the bypassPermissions gate message ' +
      `even though settings.json says "acceptEdits". Output was:\n${output}`
  );
  console.log('Test 10 passed: hook payload permission_mode is persisted to .mavp/permission-mode, and close-session --push honors it over settings-file "acceptEdits"');
}

// Test 11: no persisted state file present — close-session falls back to
// readPermissionMode(ROOT) with unchanged (T-320) behavior in both directions.
{
  // 11a: settings say "bypassPermissions", no state file -> still suppressed
  const rootBypass = makeCloseSessionFixture('close-session-no-state-bypass', {
    shared: { permissions: { defaultMode: 'bypassPermissions' } },
  });
  assert.ok(!fs.existsSync(path.join(rootBypass, '.mavp', 'permission-mode')), 'Test 11a FAIL: fixture must start with no state file');
  const outputBypass = runCloseSessionPush(rootBypass);
  assert.ok(
    outputBypass.includes('push suppressed under bypassPermissions'),
    `Test 11a FAIL: expected fallback to settings-file "bypassPermissions" to suppress push. Output was:\n${outputBypass}`
  );
  console.log('Test 11a passed: no state file — close-session falls back to settings-file "bypassPermissions" (suppressed), unchanged T-320 behavior');

  // 11b: settings say "acceptEdits", no state file -> push is attempted (not suppressed)
  const rootAccept = makeCloseSessionFixture('close-session-no-state-accept', {
    shared: { permissions: { defaultMode: 'acceptEdits' } },
  });
  const outputAccept = runCloseSessionPush(rootAccept);
  assert.ok(
    !outputAccept.includes('push suppressed under bypassPermissions'),
    `Test 11b FAIL: expected no gate message when falling back to settings-file "acceptEdits". Output was:\n${outputAccept}`
  );
  console.log('Test 11b passed: no state file — close-session falls back to settings-file "acceptEdits" (not suppressed), unchanged T-320 behavior');
}

console.log('\nAll permission_mode tests passed.');
