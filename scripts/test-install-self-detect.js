'use strict';
// Regression test: T-406 — installer self-install detection + --hooks-only mode.
//
// Problem this guards against: running `mavp-install.js --update <dir>` where
// <dir> IS the mavericks framework's own root used to unconditionally overwrite
// scripts/mavp-operator with the *adopter* wrapper template (downgrading the
// canonical form), and re-copy .claude/{agents,skills,rules} + the
// project-specific scripts onto themselves. This test builds a self-contained
// fixture "framework" (a copy of mavp-install.js + mavp-version.js under a tmp
// scripts/ dir, so FRAMEWORK_DIR resolves inside the fixture, never the real
// mavericks tree) and asserts:
//
//   (a) self-install --update leaves scripts/mavp-operator,
//       scripts/mavp-operator-agent.js, scripts/mavp-operator-close-session.js,
//       and .claude/{agents,skills,rules} byte-identical, while still merging
//       the managed hook into .claude/settings.local.json — including a
//       symlinked-target variant (fixture root reached via a symlink, so
//       realpath equality still holds).
//   (b) a fixture *adopter* dir (unrelated to the fixture framework root)
//       still gets its scripts/mavp-operator wrapper rewritten as before.
//   (c) a non-self target whose EXISTING wrapper is already in canonical
//       ($SCRIPT_DIR, no MAVERICKS_PROJECT_ROOT) form triggers the content-sniff
//       refusal guard: wrapper left unchanged + a warning is printed.
//   (d) `--hooks-only <dir>` changes only .claude/settings.local.json (+ the
//       .mavp-hook-ts gitignore entry) — no wrapper, agents/skills/rules, or
//       artifact files are touched.
//
// Does NOT run the installer against the real mavericks tree anywhere — every
// invocation targets a tmp-dir fixture. Plain node, no npm deps. Exit 0 = pass.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REAL_INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');
const REAL_VERSION_SCRIPT = path.join(__dirname, 'mavp-version.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a self-contained "framework" fixture: a copy of the real mavp-install.js
 * + mavp-version.js under <root>/scripts, plus fixed-content stand-ins for the
 * files the self-install guard must leave untouched. Intentionally omits
 * .claude/hooks/pre-commit and templates/*.fragment.json — installHook() and
 * readHookFragment() both degrade to a harmless no-op ('skipped' / '') when
 * their source is absent, so the fixture doesn't need them for this test's
 * assertions, and it keeps the same-path copyFileSync edge case out of scope.
 */
function buildFrameworkFixture(root) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(REAL_INSTALL_SCRIPT, path.join(scriptsDir, 'mavp-install.js'));
  fs.copyFileSync(REAL_VERSION_SCRIPT, path.join(scriptsDir, 'mavp-version.js'));

  const seed = {
    wrapper: '#!/usr/bin/env bash\necho "FIXTURE CANONICAL WRAPPER — must not change"\n',
    agent: '// FIXTURE mavp-operator-agent.js — must not change\n',
    closeSession: '// FIXTURE mavp-operator-close-session.js — must not change\n',
    agentsDoc: '# FIXTURE agents/developer.md — must not change\n',
    skillsDoc: '# FIXTURE skills/session-start.md — must not change\n',
    rulesDoc: '# FIXTURE rules/scripts.md — must not change\n',
  };

  fs.writeFileSync(path.join(scriptsDir, 'mavp-operator'), seed.wrapper, 'utf8');
  fs.chmodSync(path.join(scriptsDir, 'mavp-operator'), 0o755);
  fs.writeFileSync(path.join(scriptsDir, 'mavp-operator-agent.js'), seed.agent, 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'mavp-operator-close-session.js'), seed.closeSession, 'utf8');

  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'agents', 'developer.md'), seed.agentsDoc, 'utf8');
  fs.writeFileSync(path.join(claudeDir, 'skills', 'session-start.md'), seed.skillsDoc, 'utf8');
  fs.writeFileSync(path.join(claudeDir, 'rules', 'scripts.md'), seed.rulesDoc, 'utf8');

  return seed;
}

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

let failures = 0;
function check(condition, message) {
  if (!condition) {
    failures++;
    console.error('FAIL: ' + message);
  } else {
    console.log('PASS: ' + message);
  }
}

const tmpDirs = [];
function scratch(prefix) {
  const d = makeScratchDir(prefix);
  tmpDirs.push(d);
  return d;
}

try {
  // --- (a) self-install --update: direct target === framework root ---
  {
    const root = scratch('mavp-selfdetect-a-');
    const seed = buildFrameworkFixture(root);

    const out = execFileSync(
      'node',
      [path.join(root, 'scripts', 'mavp-install.js'), '--update', root],
      { encoding: 'utf8' }
    );

    check(out.includes('self-install detected'), '(a) self-install notice printed');

    const scriptsDir = path.join(root, 'scripts');
    const claudeDir = path.join(root, '.claude');
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator')) === seed.wrapper,
      '(a) scripts/mavp-operator byte-identical after self-install --update'
    );
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator-agent.js')) === seed.agent,
      '(a) scripts/mavp-operator-agent.js byte-identical after self-install --update'
    );
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator-close-session.js')) === seed.closeSession,
      '(a) scripts/mavp-operator-close-session.js byte-identical after self-install --update'
    );
    check(
      readOrNull(path.join(claudeDir, 'agents', 'developer.md')) === seed.agentsDoc,
      '(a) .claude/agents/developer.md byte-identical after self-install --update'
    );
    check(
      readOrNull(path.join(claudeDir, 'skills', 'session-start.md')) === seed.skillsDoc,
      '(a) .claude/skills/session-start.md byte-identical after self-install --update'
    );
    check(
      readOrNull(path.join(claudeDir, 'rules', 'scripts.md')) === seed.rulesDoc,
      '(a) .claude/rules/scripts.md byte-identical after self-install --update'
    );

    // Managed hook still merged into settings.local.json.
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    check(fs.existsSync(settingsPath), '(a) .claude/settings.local.json was written despite self-install skip');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const postToolUseCommands = (settings.hooks && settings.hooks.PostToolUse || [])
      .flatMap(entry => (entry.hooks || []).map(h => h.command));
    check(
      postToolUseCommands.some(cmd => typeof cmd === 'string' && cmd.startsWith(': mavp-managed-hook;')),
      '(a) managed PostToolUse validator hook was merged into settings.local.json'
    );
    check(
      Array.isArray(settings.hooks.SessionStart) && settings.hooks.SessionStart.length > 0,
      '(a) SessionStart lifecycle hook was added'
    );

    // .mavp-hook-ts gitignore entry ensured.
    const gitignore = readOrNull(path.join(root, '.gitignore')) || '';
    check(gitignore.split('\n').map(l => l.trim()).includes('.mavp-hook-ts'), '(a) .gitignore contains .mavp-hook-ts');
  }

  // --- (a2) self-install --update via a SYMLINKED target ---
  {
    const root = scratch('mavp-selfdetect-a2-');
    const seed = buildFrameworkFixture(root);
    const symlinkPath = root + '-symlink';
    fs.symlinkSync(root, symlinkPath, 'dir');
    tmpDirs.push(symlinkPath);

    const out = execFileSync(
      'node',
      [path.join(root, 'scripts', 'mavp-install.js'), '--update', symlinkPath],
      { encoding: 'utf8' }
    );

    check(out.includes('self-install detected'), '(a2 symlink) self-install notice printed via symlinked target');

    const scriptsDir = path.join(root, 'scripts');
    const claudeDir = path.join(root, '.claude');
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator')) === seed.wrapper,
      '(a2 symlink) scripts/mavp-operator byte-identical'
    );
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator-agent.js')) === seed.agent,
      '(a2 symlink) scripts/mavp-operator-agent.js byte-identical'
    );
    check(
      readOrNull(path.join(scriptsDir, 'mavp-operator-close-session.js')) === seed.closeSession,
      '(a2 symlink) scripts/mavp-operator-close-session.js byte-identical'
    );
    check(
      readOrNull(path.join(claudeDir, 'agents', 'developer.md')) === seed.agentsDoc,
      '(a2 symlink) .claude/agents/developer.md byte-identical'
    );
    check(
      readOrNull(path.join(claudeDir, 'skills', 'session-start.md')) === seed.skillsDoc,
      '(a2 symlink) .claude/skills/session-start.md byte-identical'
    );
    check(
      readOrNull(path.join(claudeDir, 'rules', 'scripts.md')) === seed.rulesDoc,
      '(a2 symlink) .claude/rules/scripts.md byte-identical'
    );

    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const postToolUseCommands = (settings.hooks && settings.hooks.PostToolUse || [])
      .flatMap(entry => (entry.hooks || []).map(h => h.command));
    check(
      postToolUseCommands.some(cmd => typeof cmd === 'string' && cmd.startsWith(': mavp-managed-hook;')),
      '(a2 symlink) managed PostToolUse validator hook was merged via symlinked target'
    );
  }

  // --- (b) adopter dir (unrelated to the framework fixture root) still gets wrapper rewritten ---
  {
    const frameworkRoot = scratch('mavp-selfdetect-fw-');
    buildFrameworkFixture(frameworkRoot);

    const adopterRoot = scratch('mavp-selfdetect-adopter-');
    const adopterScripts = path.join(adopterRoot, 'scripts');
    fs.mkdirSync(adopterScripts, { recursive: true });
    const oldAdopterWrapper = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
      'PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"',
      'MAVERICKS="${MAVERICKS_HOME:-$HOME/Documents/mavericks}/scripts"',
      'export MAVERICKS_PROJECT_ROOT="$PROJECT_ROOT"',
      'node "$MAVERICKS/mavp-operator-dashboard.js" "$@"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(adopterScripts, 'mavp-operator'), oldAdopterWrapper, 'utf8');

    execFileSync(
      'node',
      [path.join(frameworkRoot, 'scripts', 'mavp-install.js'), '--update', adopterRoot],
      { encoding: 'utf8' }
    );

    const newAdopterWrapper = readOrNull(path.join(adopterScripts, 'mavp-operator'));
    check(newAdopterWrapper !== oldAdopterWrapper, '(b) adopter wrapper content changed (rewritten)');
    check(
      typeof newAdopterWrapper === 'string' && newAdopterWrapper.includes('MAVERICKS_PROJECT_ROOT'),
      '(b) rewritten adopter wrapper still exports MAVERICKS_PROJECT_ROOT'
    );
    check(
      typeof newAdopterWrapper === 'string' && newAdopterWrapper.includes('$MAVERICKS/mavp-operator-dashboard.js'),
      '(b) rewritten adopter wrapper dispatches via $MAVERICKS'
    );
  }

  // --- (c) refusal guard: non-self target with an existing CANONICAL wrapper ---
  {
    const frameworkRoot = scratch('mavp-selfdetect-fw2-');
    buildFrameworkFixture(frameworkRoot);

    const otherCanonicalRoot = scratch('mavp-selfdetect-othercanonical-');
    const otherScripts = path.join(otherCanonicalRoot, 'scripts');
    fs.mkdirSync(otherScripts, { recursive: true });
    const canonicalWrapper = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
      'node "$SCRIPT_DIR/mavp-operator-dashboard.js" "$@"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(otherScripts, 'mavp-operator'), canonicalWrapper, 'utf8');

    // Sanity: this target must NOT be detected as self-install (different tmp root
    // than the framework fixture's own root) — otherwise the assertion below would
    // pass for the wrong reason (self-install skip vs content-sniff refusal).
    assert.notStrictEqual(
      fs.realpathSync(otherCanonicalRoot),
      fs.realpathSync(frameworkRoot),
      'test setup error: otherCanonicalRoot must differ from frameworkRoot'
    );

    const out = execFileSync(
      'node',
      [path.join(frameworkRoot, 'scripts', 'mavp-install.js'), '--update', otherCanonicalRoot],
      { encoding: 'utf8' }
    );

    check(!out.includes('self-install detected'), '(c) refusal-guard target was NOT flagged as self-install');
    check(
      /refus/i.test(out) && /downgrade/i.test(out),
      '(c) a refusal warning was printed for the canonical-form wrapper'
    );
    const afterWrapper = readOrNull(path.join(otherScripts, 'mavp-operator'));
    check(afterWrapper === canonicalWrapper, '(c) canonical wrapper left unchanged (refused, not downgraded)');
  }

  // --- (d) --hooks-only <dir> changes only settings.local.json (+ gitignore) ---
  {
    const frameworkRoot = scratch('mavp-selfdetect-fw3-');
    buildFrameworkFixture(frameworkRoot);

    const hooksOnlyRoot = scratch('mavp-selfdetect-hooksonly-');
    const hooksOnlyScripts = path.join(hooksOnlyRoot, 'scripts');
    fs.mkdirSync(hooksOnlyScripts, { recursive: true });
    const seedWrapper = '#!/usr/bin/env bash\necho "SEED WRAPPER — must not change"\n';
    fs.writeFileSync(path.join(hooksOnlyScripts, 'mavp-operator'), seedWrapper, 'utf8');
    const hooksOnlyAgentsDir = path.join(hooksOnlyRoot, '.claude', 'agents');
    fs.mkdirSync(hooksOnlyAgentsDir, { recursive: true });
    const seedAgentDoc = '# SEED agents/developer.md — must not change\n';
    fs.writeFileSync(path.join(hooksOnlyAgentsDir, 'developer.md'), seedAgentDoc, 'utf8');

    const out = execFileSync(
      'node',
      [path.join(frameworkRoot, 'scripts', 'mavp-install.js'), '--hooks-only', hooksOnlyRoot],
      { encoding: 'utf8' }
    );

    check(out.includes('Hooks-only mode'), '(d) --hooks-only banner printed');
    check(
      readOrNull(path.join(hooksOnlyScripts, 'mavp-operator')) === seedWrapper,
      '(d) --hooks-only left scripts/mavp-operator untouched'
    );
    check(
      readOrNull(path.join(hooksOnlyAgentsDir, 'developer.md')) === seedAgentDoc,
      '(d) --hooks-only left .claude/agents/developer.md untouched'
    );
    check(
      !fs.existsSync(path.join(hooksOnlyRoot, 'scripts', 'mavp-operator-agent.js')),
      '(d) --hooks-only did not create scripts/mavp-operator-agent.js'
    );
    check(
      !fs.existsSync(path.join(hooksOnlyRoot, 'BACKLOG.md')),
      '(d) --hooks-only did not create any artifact templates'
    );

    const settingsPath = path.join(hooksOnlyRoot, '.claude', 'settings.local.json');
    check(fs.existsSync(settingsPath), '(d) --hooks-only wrote .claude/settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const postToolUseCommands = (settings.hooks && settings.hooks.PostToolUse || [])
      .flatMap(entry => (entry.hooks || []).map(h => h.command));
    check(
      postToolUseCommands.some(cmd => typeof cmd === 'string' && cmd.startsWith(': mavp-managed-hook;')),
      '(d) --hooks-only merged the managed PostToolUse validator hook'
    );
    const gitignore = readOrNull(path.join(hooksOnlyRoot, '.gitignore')) || '';
    check(
      gitignore.split('\n').map(l => l.trim()).includes('.mavp-hook-ts'),
      '(d) --hooks-only ensured .mavp-hook-ts gitignore entry'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll T-406 self-install-detection / --hooks-only assertions passed.');
  }
} finally {
  for (const d of tmpDirs) {
    try {
      const stat = fs.lstatSync(d);
      if (stat.isSymbolicLink()) fs.unlinkSync(d);
      else fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
