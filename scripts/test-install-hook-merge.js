'use strict';
// Regression test: T-404 — installer activates the shipped hook fragments.
//
// Fresh install composes buildPostToolUseHookCommand() + the doc-sync and
// manifest-guard fragment strings (read live from templates/*.fragment.json)
// into a single sentinel-prefixed managed PostToolUse command. `--update`
// merges that composition into an existing project's .claude/settings.local.json
// idempotently: replaces the managed entry (however stale/naive it is),
// appends it if absent, adds SessionStart/PostCompact only if absent, and
// never touches unrelated hook entries.
//
// This test seeds a scratch fixture with:
//   - no settings.local.json initially written by the installer (we hand-seed
//     it directly to control its exact starting shape), containing:
//     (i)  one "legacy naive" PostToolUse entry (matcher Edit|Write) — an old
//          validate-only hook with no fragments, no sentinel;
//     (ii) one operator-custom PostToolUse entry (matcher Bash) that must
//          survive untouched.
// Runs `mavp-install.js --update <scratch>` and asserts:
//   1. the managed PostToolUse command contains all three tokens
//      (mavp-validator.js, mavp-operator-doc-sync-check.js,
//      mavp-manifest-guard.js), each positioned before the final `exit 0`;
//   2. the legacy entry was REPLACED in place, not duplicated (PostToolUse
//      array length unchanged);
//   3. the custom Bash entry survives byte-identical;
//   4. a second --update leaves settings.local.json deep-equal (no dup hook,
//      no further command change);
//   5. --no-hooks leaves the hooks block completely untouched;
//   6. (T-457) the hook always exits 0, and full validator output is printed
//      to stderr ONLY when the validator itself exits 2 (repair required):
//      (a) a validator exit-1 condition (ENOENT on a missing BACKLOG.md)
//          produces NO stderr; (b) an unrelated file path exits 0 silently;
//      (c) a genuine validator exit-1 (drifting/warning-only) fixture
//          produces NO stderr; (d) a genuine validator exit-2 (repair
//          required/failure) fixture prints the full validator report on
//          stderr; (e) (T-628) the same exit-2 fixture, edited via a
//          PROCESS_STATE.json payload instead of BACKLOG.md, also prints the
//          full validator report — proving the file-path filter now fires on
//          PROCESS_STATE.json too.
//   7. (T-430) buildPostToolUseHookCommand() self-preference: a self-hosting
//      checkout (own scripts/mavp-validator.js) resolves MAVERICKS to its own
//      scripts/, never a stale MAVERICKS_HOME.
//   8. (T-435) buildTranscriptArchiveHookCommand() self-preference: same
//      proof as (7), but for the opt-in transcript-archive SessionStart hook.
//   9-11. (T-488) migration of the pre-T-304 seeded `--validate` PostToolUse
//      hook (commit ca43986: a bare `cd <dir> && ./scripts/mavp-operator
//      --validate 2>&1`, no file filter, no debounce, exit code propagated,
//      stderr folded into stdout):
//      9.  legacy fingerprint present ALONE → replaced by the composed
//          managed command; exactly one PostToolUse Edit|Write entry remains.
//      10. legacy fingerprint AND the current sentinel-managed entry BOTH
//          present (two separate PostToolUse array entries) → collapses to
//          exactly one managed entry, not two.
//      11. an operator-authored hook that merely *mentions* --validate (e.g.
//          extra piping after the redirect) but does not match the exact
//          historical fingerprint → survives byte-identical; a fresh managed
//          entry is appended alongside it (unrecognised-hook + append-new
//          behavior unchanged from pre-T-488).
//      9-unit-security. (T-488, security review round 2) the wildcarded
//          `<path>` segment of the fingerprint must be path-shaped, not a bare
//          `.+` — a bare `.+` lets regex backtracking absorb an operator's own
//          chained command placed between `cd <path>` and the fixed tail.
//          Covers: a custom command chained with `&&`, a `;`-separated
//          pre-step, and `$()`/backtick command substitution embedded
//          directly in the path with no secondary `&&` at all.
//      9-unit-security2. (T-495) the excluded-character class also rejects a
//          CR, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, or U+00A0
//          NBSP embedded in the path segment — closing the informational
//          (not exploitable) gap T-488's security review deliberately left
//          open, one assertion per added character.
//      9-unit-ordinary-paths. (T-495) the tightened class still matches
//          ordinary real-world paths: spaces, a tilde, brackets, and an `=`
//          inside a path segment.
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { composePostToolUseHookCommand, isManagedPostToolUseCommand, isLegacySeededValidateHookCommand } = require('./mavp-install.js');

const INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
// This checkout's own repo root — used as MAVERICKS_HOME when *executing* the
// composed hook command, so it resolves scripts/mavp-validator.js etc.
// deterministically from this checkout regardless of the machine's ~/.mavericks.
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');

const LEGACY_HOOK_CMD =
  'INPUT=$(cat); FP=$(node -e "try{const d=JSON.parse(require(\'fs\').readFileSync(0,\'utf8\'));process.stdout.write((d.tool_input&&d.tool_input.file_path)||\'\')}catch(e){}" <<< "$INPUT"); ' +
  'case "$FP" in *BACKLOG.md|*TASK_STATUS.md) ;; *) exit 0 ;; esac; ' +
  'VOUT=$(node "$MAVERICKS/mavp-validator.js" 2>&1); VCODE=$?; exit 0';
const CUSTOM_BASH_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'echo "custom operator hook — do not touch"' }],
};

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedFixture(prefix) {
  const scratch = makeScratchDir(prefix);
  fs.mkdirSync(path.join(scratch, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(scratch, '.claude'), { recursive: true });

  const seededSettings = {
    effortLevel: 'high',
    alwaysThinkingEnabled: true,
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: LEGACY_HOOK_CMD }] },
        JSON.parse(JSON.stringify(CUSTOM_BASH_ENTRY)),
      ],
    },
  };
  fs.writeFileSync(
    path.join(scratch, '.claude', 'settings.local.json'),
    JSON.stringify(seededSettings, null, 2) + '\n',
    'utf8'
  );
  return { scratch, seededSettings };
}

function readSettings(scratch) {
  return JSON.parse(fs.readFileSync(path.join(scratch, '.claude', 'settings.local.json'), 'utf8'));
}

function runUpdate(scratch, extraArgs) {
  const args = [INSTALL_SCRIPT, '--update', scratch].concat(extraArgs || []);
  return execFileSync('node', args, { encoding: 'utf8' });
}

function findEntryByMatcher(postToolUse, matcher) {
  return postToolUse.find(e => e && e.matcher === matcher);
}

const cleanupDirs = [];
function trackedScratch(prefix) {
  const r = seedFixture(prefix);
  cleanupDirs.push(r.scratch);
  return r;
}

try {
  // ============================================================
  // Assertions 1-3: fresh --update on a hand-seeded fixture
  // ============================================================
  const { scratch, seededSettings } = trackedScratch('mavp-hook-merge-');

  runUpdate(scratch);
  const merged = readSettings(scratch);

  assert.ok(Array.isArray(merged.hooks.PostToolUse), 'FAIL: hooks.PostToolUse missing after --update');
  assert.strictEqual(
    merged.hooks.PostToolUse.length,
    2,
    'FAIL: PostToolUse array length changed — legacy entry should be replaced in place, not duplicated'
  );

  const managedEntry = findEntryByMatcher(merged.hooks.PostToolUse, 'Edit|Write');
  assert.ok(managedEntry, 'FAIL: managed Edit|Write PostToolUse entry not found after --update');
  const managedCmd = managedEntry.hooks[0].command;

  const REQUIRED_TOKENS = ['mavp-validator.js', 'mavp-operator-doc-sync-check.js', 'mavp-manifest-guard.js'];
  for (const token of REQUIRED_TOKENS) {
    assert.ok(managedCmd.includes(token), `FAIL: managed command missing required token: ${token}`);
  }
  const finalExitIdx = managedCmd.lastIndexOf('; exit 0');
  assert.ok(finalExitIdx > -1, 'FAIL: managed command missing trailing "; exit 0"');
  for (const token of REQUIRED_TOKENS) {
    assert.ok(
      managedCmd.indexOf(token) < finalExitIdx,
      `FAIL: token "${token}" is not positioned before the final "exit 0"`
    );
  }
  console.log('Assertion 1 passed: managed command contains all three tokens, all before the final exit 0');

  assert.notStrictEqual(managedCmd, LEGACY_HOOK_CMD, 'FAIL: legacy command was left untouched, not replaced');
  console.log('Assertion 2 passed: legacy PostToolUse entry replaced in place (not duplicated)');

  const customEntry = findEntryByMatcher(merged.hooks.PostToolUse, 'Bash');
  assert.deepStrictEqual(
    customEntry,
    seededSettings.hooks.PostToolUse[1],
    'FAIL: operator-custom Bash PostToolUse entry was modified'
  );
  console.log('Assertion 3 passed: operator-custom Bash entry survives byte-identical');

  // SessionStart/PostCompact should have been added since absent from the seed.
  assert.ok(
    Array.isArray(merged.hooks.SessionStart) && merged.hooks.SessionStart.length === 1,
    'FAIL: SessionStart lifecycle hook not added'
  );
  assert.ok(
    Array.isArray(merged.hooks.PostCompact) && merged.hooks.PostCompact.length === 1,
    'FAIL: PostCompact lifecycle hook not added'
  );
  console.log('Bonus: SessionStart/PostCompact lifecycle hooks added since absent from the seed');

  // ============================================================
  // Assertion 4: second --update is a no-op (idempotent)
  // ============================================================
  const beforeSecond = readSettings(scratch);
  runUpdate(scratch);
  const afterSecond = readSettings(scratch);
  assert.deepStrictEqual(
    afterSecond,
    beforeSecond,
    'FAIL: a second --update changed settings.local.json (hooks merge is not idempotent)'
  );
  console.log('Assertion 4 passed: second --update leaves settings.local.json deep-equal (idempotent)');

  // ============================================================
  // Assertion 5: --no-hooks leaves hooks completely untouched
  // ============================================================
  const { scratch: scratchNoHooks, seededSettings: seededNoHooks } = trackedScratch('mavp-hook-merge-nohooks-');
  runUpdate(scratchNoHooks, ['--no-hooks']);
  const afterNoHooks = readSettings(scratchNoHooks);
  assert.deepStrictEqual(
    afterNoHooks.hooks,
    seededNoHooks.hooks,
    'FAIL: --no-hooks did not leave the hooks block untouched'
  );
  console.log('Assertion 5 passed: --no-hooks leaves hooks block completely untouched');

  // ============================================================
  // Assertion 6 (T-457): executing the composed managed command — the
  // exit-2-only stderr gate. The hook must ALWAYS exit 0, but full validator
  // output is printed to stderr ONLY when the validator itself exits 2
  // (repair required). Exit 1 (drifting) must stay silent at edit time.
  // ============================================================
  const execEnv = Object.assign({}, process.env, { MAVERICKS_HOME: FRAMEWORK_ROOT });

  // (a) BACKLOG.md edit payload, no BACKLOG.md present in the fixture — the
  // validator throws ENOENT and its own catch-block sets exitCode 1 (not the
  // "repair required" exit 2). Two independent stderr sources exist in the
  // composed command: (i) the sync-status pre-step, which always emits its
  // own "BACKLOG.md not found" diagnostic unconditionally (not gated by
  // VCODE — orthogonal to this task's scope, unchanged by T-457), and (ii)
  // the validator's own VOUT, gated by the T-457 VCODE>=2 rule. Since the
  // validator here exits 1 (not 2), its own full report must NOT appear in
  // stderr, even though sync-status's unrelated diagnostic does.
  const backlogPayload = JSON.stringify({ tool_input: { file_path: path.join(scratch, 'BACKLOG.md') } });
  const backlogRun = spawnSync('bash', ['-c', managedCmd], {
    input: backlogPayload,
    encoding: 'utf8',
    env: execEnv,
    timeout: 15000,
  });
  assert.strictEqual(backlogRun.status, 0, 'FAIL: managed hook did not exit 0 on a BACKLOG.md edit (must always exit 0)');
  assert.ok(
    !backlogRun.stderr.includes('MavP Validator Report'),
    'FAIL: managed hook printed the full validator report on stderr for a validator exit-1 condition — exit 1 must stay silent under the exit-2-only gate'
  );
  console.log('Assertion 6a passed: BACKLOG.md payload with validator exit 1 (ENOENT) produces no full-validator-report stderr, hook exits 0');

  // (b) unrelated file path payload — should exit 0 silently, no output at all.
  const unrelatedPayload = JSON.stringify({ tool_input: { file_path: path.join(scratch, 'README.md') } });
  const unrelatedRun = spawnSync('bash', ['-c', managedCmd], {
    input: unrelatedPayload,
    encoding: 'utf8',
    env: execEnv,
    timeout: 15000,
  });
  assert.strictEqual(unrelatedRun.status, 0, 'FAIL: managed hook did not exit 0 on an unrelated file path');
  assert.strictEqual(unrelatedRun.stdout, '', 'FAIL: managed hook produced stdout for an unrelated file path');
  assert.strictEqual(unrelatedRun.stderr, '', 'FAIL: managed hook produced stderr for an unrelated file path');
  console.log('Assertion 6b passed: unrelated file path payload exits 0 silently, no output');

  // Note (T-430): assertion 6a/6b above already double as the "adopter fixture
  // falls through to the existing chain unchanged" proof — `scratch` has a
  // scripts/ dir with no mavp-validator.js in it, and the command still
  // resolves via the MAVERICKS_HOME env var exactly as before self-preference
  // was added.

  // (c) T-457: a fixture whose validator run exits 1 (drifting — warning
  // severity only, e.g. an in_progress task missing its Repo: field) must
  // still produce NO stderr — silent covers exit 0 AND exit 1.
  const warnScratch = makeScratchDir('mavp-hook-exit1-');
  cleanupDirs.push(warnScratch);
  fs.writeFileSync(
    path.join(warnScratch, 'BACKLOG.md'),
    [
      '# BACKLOG',
      '',
      '## Active Wave',
      '',
      '### T-200 — Warning-only test',
      '- **Status:** in_progress',
      '- **Owner:** developer',
      '- **Depends on:** —',
      '- **Acceptance criteria:** n/a',
      '- **Verification type:** artifact',
      '- **Evidence expected:** n/a',
      '',
      '## Completed tasks',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(warnScratch, 'TASK_STATUS.md'),
    [
      '# TASK STATUS',
      '',
      '## Active tasks',
      '',
      '### T-200 — Warning-only test',
      '- **Status:** in_progress',
      '- **Owner:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** —',
      '- **Evidence:** —',
      '- **Notes:** —',
      '',
      '## Recently completed tasks',
      '',
    ].join('\n'),
    'utf8'
  );
  // Sanity: confirm this fixture really does trigger validator exit 1 (drifting),
  // not exit 0 or exit 2, before relying on it to prove the gate.
  const directWarnRun = spawnSync('node', [path.join(FRAMEWORK_ROOT, 'scripts', 'mavp-validator.js'), warnScratch], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(directWarnRun.status, 1, `FAIL: exit-1 fixture sanity check — expected validator exit 1, got ${directWarnRun.status}`);

  // MAVROOT is baked into the composed command at build time (not derived
  // from the hook payload's file_path), so a command bound to `scratch` would
  // always validate `scratch`, not warnScratch — build a fresh command whose
  // MAVROOT is warnScratch itself.
  const warnCmd = composePostToolUseHookCommand(warnScratch);
  const warnPayload = JSON.stringify({ tool_input: { file_path: path.join(warnScratch, 'BACKLOG.md') } });
  const warnRun = spawnSync('bash', ['-c', warnCmd], {
    input: warnPayload,
    encoding: 'utf8',
    env: execEnv,
    timeout: 15000,
  });
  assert.strictEqual(warnRun.status, 0, 'FAIL: managed hook did not exit 0 on a validator exit-1 (drifting) fixture');
  assert.strictEqual(
    warnRun.stderr,
    '',
    'FAIL: managed hook produced stderr for a validator exit-1 (drifting) fixture — exit 1 must stay silent'
  );
  console.log('Assertion 6c passed: validator exit-1 (drifting) fixture produces NO stderr, hook exits 0');

  // (d) T-457: a fixture whose validator run exits 2 (repair required — a
  // failure-severity finding, e.g. a duplicated T-NNN in BACKLOG.md) MUST
  // produce the full validator report on stderr.
  const failScratch = makeScratchDir('mavp-hook-exit2-');
  cleanupDirs.push(failScratch);
  fs.writeFileSync(
    path.join(failScratch, 'BACKLOG.md'),
    [
      '# BACKLOG',
      '',
      '## Active Wave',
      '',
      '### T-100 — Dup test',
      '- **Status:** planned',
      '- **Owner:** developer',
      '- **Depends on:** —',
      '- **Acceptance criteria:** n/a',
      '- **Verification type:** artifact',
      '- **Evidence expected:** n/a',
      '',
      '### T-100 — Dup test',
      '- **Status:** planned',
      '- **Owner:** developer',
      '- **Depends on:** —',
      '- **Acceptance criteria:** n/a',
      '- **Verification type:** artifact',
      '- **Evidence expected:** n/a',
      '',
      '## Completed tasks',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(failScratch, 'TASK_STATUS.md'),
    [
      '# TASK STATUS',
      '',
      '## Active tasks',
      '',
      '### T-100 — Dup test',
      '- **Status:** planned',
      '- **Owner:** developer',
      '- **Verification type:** artifact',
      '- **Last verified by:** —',
      '- **Evidence:** —',
      '- **Notes:** —',
      '',
      '## Recently completed tasks',
      '',
    ].join('\n'),
    'utf8'
  );
  // Sanity: confirm this fixture really does trigger validator exit 2 (repair
  // required), not exit 0 or exit 1, before relying on it to prove the gate.
  const directFailRun = spawnSync('node', [path.join(FRAMEWORK_ROOT, 'scripts', 'mavp-validator.js'), failScratch], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(directFailRun.status, 2, `FAIL: exit-2 fixture sanity check — expected validator exit 2, got ${directFailRun.status}`);

  // Same reasoning as warnCmd above: build a fresh command bound to failScratch.
  const failCmd = composePostToolUseHookCommand(failScratch);
  const failPayload = JSON.stringify({ tool_input: { file_path: path.join(failScratch, 'BACKLOG.md') } });
  const failRun = spawnSync('bash', ['-c', failCmd], {
    input: failPayload,
    encoding: 'utf8',
    env: execEnv,
    timeout: 15000,
  });
  assert.strictEqual(failRun.status, 0, 'FAIL: managed hook did not exit 0 on a validator exit-2 (repair required) fixture');
  assert.ok(
    failRun.stderr && failRun.stderr.includes('duplicate_task_id'),
    'FAIL: managed hook did not print full validator output on stderr for a validator exit-2 (repair required) fixture'
  );
  assert.ok(
    failRun.stderr.includes('REPAIR REQUIRED'),
    'FAIL: managed hook stderr for the exit-2 fixture does not contain the validator\'s full repair-required report'
  );
  console.log('Assertion 6d passed: validator exit-2 (repair required) fixture prints full validator output on stderr, hook exits 0');

  // (e) T-628: the file-path filter must additionally fire on PROCESS_STATE.json
  // edits (previously BACKLOG.md/TASK_STATUS.md only), so the same exit-2 gate
  // proven in 6d also fires when the edited file is PROCESS_STATE.json.
  const processStatePayload = JSON.stringify({ tool_input: { file_path: path.join(failScratch, 'PROCESS_STATE.json') } });
  const processStateRun = spawnSync('bash', ['-c', failCmd], {
    input: processStatePayload,
    encoding: 'utf8',
    env: execEnv,
    timeout: 15000,
  });
  assert.strictEqual(processStateRun.status, 0, 'FAIL: managed hook did not exit 0 on a PROCESS_STATE.json edit (must always exit 0)');
  assert.ok(
    processStateRun.stderr && processStateRun.stderr.includes('duplicate_task_id'),
    'FAIL: managed hook did not print full validator output on stderr for a PROCESS_STATE.json edit against a validator exit-2 (repair required) fixture'
  );
  console.log('Assertion 6e passed: PROCESS_STATE.json payload against a validator exit-2 fixture prints full validator output on stderr, hook exits 0 (T-628 filter extension)');

  // ============================================================
  // Assertion 7 (T-430): self-preference — a target project that IS a full
  // mavericks checkout (has its own scripts/mavp-validator.js) must resolve
  // MAVERICKS to its own scripts/ dir, even when MAVERICKS_HOME points at a
  // deliberately stale sibling installation. Uses stub validator scripts with
  // distinct markers so we can tell which one actually ran.
  // ============================================================
  // T-457: the stub validator must exit(2) — not exit(1) — so its stderr
  // marker still leaks through the hook's exit-2-only stderr gate (VCODE>=2).
  // An exit(1) stub would be silent under the new gate and this assertion
  // would no longer be able to tell which validator ran.
  function seedStubMavericksScripts(dir, marker) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'scripts', 'mavp-validator.js'),
      `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(marker)} + '\\n');\nprocess.exit(2);\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'scripts', 'mavp-operator-sync-status.js'),
      '#!/usr/bin/env node\n// no-op stub for T-430 hook-resolution test\n',
      'utf8'
    );
  }

  const selfHostScratch = makeScratchDir('mavp-hook-selfpref-');
  cleanupDirs.push(selfHostScratch);
  fs.mkdirSync(path.join(selfHostScratch, '.claude'), { recursive: true });
  seedStubMavericksScripts(selfHostScratch, 'LOCAL_VALIDATOR_RAN');

  runUpdate(selfHostScratch);
  const selfHostSettings = readSettings(selfHostScratch);
  const selfHostManagedEntry = findEntryByMatcher(selfHostSettings.hooks.PostToolUse, 'Edit|Write');
  assert.ok(selfHostManagedEntry, 'FAIL: managed Edit|Write PostToolUse entry not found for self-host fixture');
  const selfHostCmd = selfHostManagedEntry.hooks[0].command;

  const staleHome = makeScratchDir('mavp-hook-stalehome-');
  cleanupDirs.push(staleHome);
  seedStubMavericksScripts(staleHome, 'STALE_VALIDATOR_RAN');

  const selfPrefEnv = Object.assign({}, process.env, { MAVERICKS_HOME: staleHome });
  const selfPrefPayload = JSON.stringify({ tool_input: { file_path: path.join(selfHostScratch, 'BACKLOG.md') } });
  const selfPrefRun = spawnSync('bash', ['-c', selfHostCmd], {
    input: selfPrefPayload,
    encoding: 'utf8',
    env: selfPrefEnv,
    timeout: 15000,
  });
  assert.strictEqual(selfPrefRun.status, 0, 'FAIL: managed hook did not exit 0 with self-preference active (must always exit 0)');
  assert.ok(
    selfPrefRun.stderr.includes('LOCAL_VALIDATOR_RAN'),
    'FAIL: self-hosting fixture did not run its own local scripts/mavp-validator.js'
  );
  assert.ok(
    !selfPrefRun.stderr.includes('STALE_VALIDATOR_RAN'),
    'FAIL: self-hosting fixture ran the stale MAVERICKS_HOME validator instead of preferring its own local scripts/'
  );
  console.log('Assertion 7 passed: self-hosting checkout resolves MAVERICKS to its own scripts/, ignoring a deliberately stale MAVERICKS_HOME');

  // ============================================================
  // Assertion 8 (T-435): self-preference for buildTranscriptArchiveHookCommand
  // — mirrors Assertion 7, but for the transcript-archive SessionStart sweep
  // hook rather than the PostToolUse validator hook. The transcript-archive
  // hook is opt-in (--transcript-archive), so this reuses the same
  // selfHostScratch/staleHome fixtures from Assertion 7 (each already carrying
  // a scripts/mavp-validator.js with a distinct marker) and adds a stub
  // scripts/mavp-transcript-archive.js to each, with its own distinct marker,
  // so we can observe which one the composed command actually invokes.
  // ============================================================
  function seedStubTranscriptArchiveScript(dir, marker) {
    fs.writeFileSync(
      path.join(dir, 'scripts', 'mavp-transcript-archive.js'),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(marker)} + '\\n');\n`,
      'utf8'
    );
  }

  seedStubTranscriptArchiveScript(selfHostScratch, 'LOCAL_ARCHIVE_RAN');
  seedStubTranscriptArchiveScript(staleHome, 'STALE_ARCHIVE_RAN');

  runUpdate(selfHostScratch, ['--transcript-archive']);
  const selfHostSettingsWithArchive = readSettings(selfHostScratch);
  const sessionStartEntries = selfHostSettingsWithArchive.hooks.SessionStart || [];
  let transcriptArchiveCmd = null;
  for (const entry of sessionStartEntries) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && typeof h.command === 'string' && h.command.includes('mavp-transcript-archive.js')) {
        transcriptArchiveCmd = h.command;
      }
    }
  }
  assert.ok(
    transcriptArchiveCmd,
    'FAIL: transcript-archive SessionStart hook command not found after --update --transcript-archive'
  );

  const archivePrefEnv = Object.assign({}, process.env, { MAVERICKS_HOME: staleHome });
  const archivePrefRun = spawnSync('bash', ['-c', transcriptArchiveCmd], {
    encoding: 'utf8',
    env: archivePrefEnv,
    timeout: 15000,
  });
  assert.strictEqual(
    archivePrefRun.status,
    0,
    'FAIL: transcript-archive hook did not exit 0 with self-preference active (must always exit 0)'
  );
  assert.ok(
    archivePrefRun.stdout.includes('LOCAL_ARCHIVE_RAN'),
    'FAIL: self-hosting fixture did not run its own local scripts/mavp-transcript-archive.js'
  );
  assert.ok(
    !archivePrefRun.stdout.includes('STALE_ARCHIVE_RAN'),
    'FAIL: self-hosting fixture ran the stale MAVERICKS_HOME transcript-archive script instead of preferring its own local scripts/'
  );
  console.log('Assertion 8 passed: transcript-archive hook resolves MAVERICKS to its own scripts/, ignoring a deliberately stale MAVERICKS_HOME');

  // ============================================================
  // Assertions 9-11 (T-488): pre-T-304 seeded `--validate` hook migration.
  // ============================================================

  // Unit-level sanity check on the fingerprint predicate itself, before the
  // integration-level --update runs below.
  const unitFixtureDir = '/private/tmp/example-scratch-project';
  const exactLegacyCmd = `cd ${unitFixtureDir} && ./scripts/mavp-operator --validate 2>&1`;
  assert.strictEqual(
    isLegacySeededValidateHookCommand(exactLegacyCmd),
    true,
    'FAIL: isLegacySeededValidateHookCommand did not recognise the exact historical fingerprint'
  );
  assert.strictEqual(
    isManagedPostToolUseCommand(exactLegacyCmd),
    true,
    'FAIL: isManagedPostToolUseCommand did not recognise the exact historical fingerprint as managed'
  );
  const nearMissCmds = [
    `cd ${unitFixtureDir} && ./scripts/mavp-operator --validate 2>&1 | tee /tmp/hook.log`,
    `cd ${unitFixtureDir} && ./scripts/mavp-operator --validate --verbose 2>&1`,
    `cd ${unitFixtureDir} && ./scripts/mavp-operator --validate`,
    `echo pre && cd ${unitFixtureDir} && ./scripts/mavp-operator --validate 2>&1`,
    `cd ${unitFixtureDir} && ./scripts/mavp-operator --validate 2>&1; echo done`,
  ];
  for (const cmd of nearMissCmds) {
    assert.strictEqual(
      isLegacySeededValidateHookCommand(cmd),
      false,
      `FAIL: fingerprint falsely matched a near-miss custom hook: ${cmd}`
    );
  }
  console.log('Assertion 9-unit passed: fingerprint matches the exact historical shape only, rejects near-miss variants');

  // Security-review regression (T-488, round 2): the wildcarded `<path>`
  // segment must be path-shaped, NOT a bare `.+`. A bare `.+` is greedy but
  // not possessive, so JS regex backtracking can let that segment "absorb" an
  // operator's own chained pre-step placed between `cd <path>` and the fixed
  // `&& ./scripts/mavp-operator --validate 2>&1` tail — the engine just
  // retries with a shorter `.+` match until the fixed suffix literal lines up
  // later in the string. Confirmed live by the security reviewer with three
  // shapes; a fourth (command substitution with no secondary `&&` at all) is
  // added here to prove the fix holds for a different member of the same
  // "compound shell syntax hiding inside a supposedly-bare path" class, not
  // just the `&&`-chained one the reviewer happened to hand us.
  const compoundCommandCmds = [
    // (a) the reviewer's confirmed shape: a custom command chained between cd and the tail.
    `cd ${unitFixtureDir} && ./scripts/my-custom-lint.sh && ./scripts/mavp-operator --validate 2>&1`,
    // (b) a `;`-separated pre-step (no `&&` at all before the tail's own `&&`).
    `cd ${unitFixtureDir}; ./scripts/mavp-operator --validate 2>&1`,
    // (c) command substitution embedded directly in the path segment, with
    // only the ONE required `&&` present — proves the character class itself
    // (not just the `&`/`;` chained-command exclusion) is doing the work,
    // since there is no secondary `&&`/`;` here for a naive fix to catch.
    `cd ${unitFixtureDir}/$(touch /tmp/pwned) && ./scripts/mavp-operator --validate 2>&1`,
    // (d) a subshell via backticks, same reasoning as (c).
    `cd ${unitFixtureDir}/\`touch /tmp/pwned\` && ./scripts/mavp-operator --validate 2>&1`,
  ];
  for (const cmd of compoundCommandCmds) {
    assert.strictEqual(
      isLegacySeededValidateHookCommand(cmd),
      false,
      `FAIL: fingerprint falsely matched a compound-command shape (security regression): ${cmd}`
    );
  }
  console.log('Assertion 9-unit-security passed: fingerprint rejects compound-command shapes (chained command, ;-separated pre-step, $() and backtick subshells)');

  // T-495: the excluded-character class additionally excludes CR, U+2028 LINE
  // SEPARATOR, U+2029 PARAGRAPH SEPARATOR, and U+00A0 NBSP — closing the
  // informational (not exploitable) gap T-488's security review deliberately
  // left open: none of these five bytes is a bash metacharacter or default-IFS
  // whitespace, so none could ever hide a second executed command, but the
  // surrounding comment claimed the class excluded any control/separator byte
  // and it did not. One assertion per added character, each differing from the
  // genuine seed only by that character appearing inside the path segment.
  const CR = String.fromCharCode(0x0d);
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  const NBSP = String.fromCharCode(0xa0);
  const addedExclusionCmds = {
    CR: `cd ${unitFixtureDir}/sub${CR}dir && ./scripts/mavp-operator --validate 2>&1`,
    LINE_SEPARATOR: `cd ${unitFixtureDir}/sub${LINE_SEPARATOR}dir && ./scripts/mavp-operator --validate 2>&1`,
    PARAGRAPH_SEPARATOR: `cd ${unitFixtureDir}/sub${PARAGRAPH_SEPARATOR}dir && ./scripts/mavp-operator --validate 2>&1`,
    NBSP: `cd ${unitFixtureDir}/sub${NBSP}dir && ./scripts/mavp-operator --validate 2>&1`,
  };
  for (const [label, cmd] of Object.entries(addedExclusionCmds)) {
    assert.strictEqual(
      isLegacySeededValidateHookCommand(cmd),
      false,
      `FAIL: fingerprint falsely matched a path containing ${label} (T-495 regression): ${JSON.stringify(cmd)}`
    );
  }
  console.log('Assertion 9-unit-security2 passed: fingerprint rejects CR, U+2028, U+2029, and NBSP embedded in the path segment');

  // T-495: confirm the tightened class still matches ordinary real-world paths
  // (spaces, tilde, brackets, an `=` inside a segment) — a class so tight it
  // rejects real paths would silently stop migrating real legacy hooks.
  const ordinaryPaths = [
    `${unitFixtureDir}/my project with spaces`,
    `${unitFixtureDir}/~backup-project`,
    `${unitFixtureDir}/[archived]-project`,
    `${unitFixtureDir}/key=value-project`,
  ];
  for (const p of ordinaryPaths) {
    const cmd = `cd ${p} && ./scripts/mavp-operator --validate 2>&1`;
    assert.strictEqual(
      isLegacySeededValidateHookCommand(cmd),
      true,
      `FAIL: fingerprint rejected an ordinary real-world path (T-495 regression): ${JSON.stringify(p)}`
    );
  }
  console.log('Assertion 9-unit-ordinary-paths passed: fingerprint still matches ordinary paths with spaces, tilde, brackets, and an = segment');

  // --- Assertion 9: legacy fingerprint present ALONE -> replaced ---
  const legacyOnlyScratch = makeScratchDir('mavp-hook-legacy-only-');
  cleanupDirs.push(legacyOnlyScratch);
  fs.mkdirSync(path.join(legacyOnlyScratch, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(legacyOnlyScratch, '.claude'), { recursive: true });
  const legacyOnlyCmd = `cd ${legacyOnlyScratch} && ./scripts/mavp-operator --validate 2>&1`;
  const legacyOnlySettingsBefore = {
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: legacyOnlyCmd }] },
      ],
    },
  };
  fs.writeFileSync(
    path.join(legacyOnlyScratch, '.claude', 'settings.local.json'),
    JSON.stringify(legacyOnlySettingsBefore, null, 2) + '\n',
    'utf8'
  );
  console.log('Assertion 9 — before:', JSON.stringify(legacyOnlySettingsBefore.hooks.PostToolUse));
  runUpdate(legacyOnlyScratch);
  const legacyOnlyAfter = readSettings(legacyOnlyScratch);
  console.log('Assertion 9 — after:', JSON.stringify(legacyOnlyAfter.hooks.PostToolUse));
  assert.strictEqual(
    legacyOnlyAfter.hooks.PostToolUse.length,
    1,
    'FAIL: legacy-only fixture did not collapse to exactly one PostToolUse entry'
  );
  assert.strictEqual(
    legacyOnlyAfter.hooks.PostToolUse[0].matcher,
    'Edit|Write',
    'FAIL: surviving PostToolUse entry lost its Edit|Write matcher'
  );
  assert.notStrictEqual(
    legacyOnlyAfter.hooks.PostToolUse[0].hooks[0].command,
    legacyOnlyCmd,
    'FAIL: legacy-only fixture command was left untouched, not replaced'
  );
  assert.strictEqual(
    isManagedPostToolUseCommand(legacyOnlyAfter.hooks.PostToolUse[0].hooks[0].command),
    true,
    'FAIL: surviving command after legacy-only migration is not recognised as managed'
  );
  console.log('Assertion 9 passed: legacy-only fixture replaced, exactly one PostToolUse entry remains');

  // --- Assertion 10: legacy fingerprint AND current managed entry BOTH present -> collapse to one ---
  const bothScratch = makeScratchDir('mavp-hook-legacy-and-managed-');
  cleanupDirs.push(bothScratch);
  fs.mkdirSync(path.join(bothScratch, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(bothScratch, '.claude'), { recursive: true });
  const bothLegacyCmd = `cd ${bothScratch} && ./scripts/mavp-operator --validate 2>&1`;
  const bothManagedCmd = composePostToolUseHookCommand(bothScratch);
  const bothSettingsBefore = {
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: bothLegacyCmd }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: bothManagedCmd }] },
      ],
    },
  };
  fs.writeFileSync(
    path.join(bothScratch, '.claude', 'settings.local.json'),
    JSON.stringify(bothSettingsBefore, null, 2) + '\n',
    'utf8'
  );
  console.log('Assertion 10 — before:', JSON.stringify(bothSettingsBefore.hooks.PostToolUse.map(e => ({ matcher: e.matcher, cmdLen: e.hooks[0].command.length }))));
  runUpdate(bothScratch);
  const bothAfter = readSettings(bothScratch);
  console.log('Assertion 10 — after:', JSON.stringify(bothAfter.hooks.PostToolUse.map(e => ({ matcher: e.matcher, cmdLen: e.hooks[0].command.length }))));
  assert.strictEqual(
    bothAfter.hooks.PostToolUse.length,
    1,
    'FAIL: legacy+managed fixture did not collapse to exactly one PostToolUse entry'
  );
  assert.strictEqual(
    bothAfter.hooks.PostToolUse[0].hooks[0].command,
    bothManagedCmd,
    'FAIL: surviving command after collapse does not equal the composed managed command'
  );
  console.log('Assertion 10 passed: legacy+managed fixture collapses to exactly one managed PostToolUse entry');

  // --- Assertion 11: operator-authored hook mentioning --validate in a different shape -> survives byte-identical ---
  const customScratch = makeScratchDir('mavp-hook-custom-validate-');
  cleanupDirs.push(customScratch);
  fs.mkdirSync(path.join(customScratch, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(customScratch, '.claude'), { recursive: true });
  // Deliberately similar-looking to the historical fingerprint but NOT an
  // exact match: extra piping after the redirect. An operator could plausibly
  // have written this themselves — it must never be silently replaced.
  const customValidateCmd = `cd ${customScratch} && ./scripts/mavp-operator --validate 2>&1 | tee /tmp/custom-hook.log`;
  const customValidateEntry = { matcher: 'Edit|Write', hooks: [{ type: 'command', command: customValidateCmd }] };
  const customSettingsBefore = {
    hooks: { PostToolUse: [JSON.parse(JSON.stringify(customValidateEntry))] },
  };
  fs.writeFileSync(
    path.join(customScratch, '.claude', 'settings.local.json'),
    JSON.stringify(customSettingsBefore, null, 2) + '\n',
    'utf8'
  );
  console.log('Assertion 11 — before:', JSON.stringify(customSettingsBefore.hooks.PostToolUse));
  runUpdate(customScratch);
  const customAfter = readSettings(customScratch);
  console.log('Assertion 11 — after:', JSON.stringify(customAfter.hooks.PostToolUse));
  const survivingCustomEntry = customAfter.hooks.PostToolUse.find(
    e => e && e.hooks && e.hooks[0] && e.hooks[0].command === customValidateCmd
  );
  assert.ok(
    survivingCustomEntry,
    'FAIL: operator-authored near-miss --validate hook was not found untouched after --update'
  );
  assert.deepStrictEqual(
    survivingCustomEntry,
    customValidateEntry,
    'FAIL: operator-authored near-miss --validate hook was modified'
  );
  console.log('Assertion 11 passed: operator-authored hook mentioning --validate in a different shape survives byte-identical');

  console.log('\nAll T-404/T-430/T-435/T-488 hook-merge assertions passed.');
} finally {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
