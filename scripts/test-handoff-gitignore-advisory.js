#!/usr/bin/env node
/**
 * test-handoff-gitignore-advisory.js (T-809)
 *
 * Asserts handoffGitAdvisory(root) from mavp-operator-handoff.js across its
 * branches, using scratch repositories under os.tmpdir():
 *   - tracked HANDOFF.md              -> string naming `git rm --cached HANDOFF.md`
 *   - untracked and not ignored       -> string naming .gitignore
 *   - untracked with an ignore line   -> null
 *   - not a repository                -> null
 *   - tracked AND ignore line present -> still the tracked advisory (tracked-ness wins)
 * Never writes HANDOFF.md into the real repo: the helper is imported, main() is
 * guarded by require.main === module.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REAL_HANDOFF = path.join(__dirname, '..', 'HANDOFF.md');
const handoffExistedBefore = fs.existsSync(REAL_HANDOFF);
const { handoffGitAdvisory } = require('./mavp-operator-handoff');

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

const tmpDirs = [];
function scratchRepo(init) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-handoff-adv-'));
  tmpDirs.push(dir);
  if (init) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  }
  return dir;
}
function gitIn(dir, args) {
  execFileSync('git', args, { cwd: dir });
}

try {
  // tracked
  {
    const dir = scratchRepo(true);
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'x\n');
    gitIn(dir, ['add', 'HANDOFF.md']);
    const msg = handoffGitAdvisory(dir);
    check(typeof msg === 'string' && msg.includes('git rm --cached HANDOFF.md'), 'tracked -> advisory naming git rm --cached HANDOFF.md');
    check(typeof msg === 'string' && msg.split('git rm --cached HANDOFF.md').length === 2, 'tracked -> names the rm command exactly once');
    check(typeof msg === 'string' && /single-use/.test(msg) && /read from disk at the next session start/.test(msg), 'tracked -> states single-use and read-from-disk');
    check(typeof msg === 'string' && !msg.includes(dir) && !msg.includes('/Users/'), 'tracked -> no absolute path in advisory');
  }

  // tracked while ALSO matching an ignore line: tracked check must win
  {
    const dir = scratchRepo(true);
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'x\n');
    gitIn(dir, ['add', 'HANDOFF.md']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'HANDOFF.md\n');
    const msg = handoffGitAdvisory(dir);
    check(typeof msg === 'string' && msg.includes('git rm --cached HANDOFF.md'), 'tracked + ignore line -> still the tracked advisory');
  }

  // untracked, not ignored
  {
    const dir = scratchRepo(true);
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'x\n');
    const msg = handoffGitAdvisory(dir);
    check(typeof msg === 'string' && msg.includes('.gitignore'), 'untracked and not ignored -> advisory naming .gitignore');
    check(typeof msg === 'string' && !msg.includes('git rm --cached'), 'untracked and not ignored -> does not suggest git rm --cached');
  }

  // untracked, ignored
  {
    const dir = scratchRepo(true);
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'x\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'HANDOFF.md\n');
    check(handoffGitAdvisory(dir) === null, 'untracked with HANDOFF.md ignore line -> null');
  }

  // not a git repo
  {
    const dir = scratchRepo(false);
    fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'x\n');
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
    try {
      check(handoffGitAdvisory(dir) === null, 'not a git repo -> null');
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    }
  }

  // importing the helper did not write a HANDOFF.md into the real repo
  check(fs.existsSync(REAL_HANDOFF) === handoffExistedBefore, 'importing the helper did not create or remove HANDOFF.md in the repo');
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll handoff gitignore advisory checks passed');
