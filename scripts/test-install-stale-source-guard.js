'use strict';
// Regression test: T-444 — stale-source guard for self-install version re-stamp.
//
// Problem this guards against: running `mavp-install.js --update <dir>` as a
// self-install (target === the framework's own root) from a LOCAL source that
// is OLDER than an available sibling install (MAVERICKS_HOME / ~/.mavericks /
// ~/Documents/mavericks) silently re-stamps the target's PROCESS_STATE.json
// mavericks_version with the older local value — the adopter-project incident
// (re-stamped an older version while a sibling install was newer).
//
// This test builds two self-contained fixture "installs" (a copy of
// mavp-install.js + a hand-written mavp-version.js under a tmp scripts/ dir,
// so FRAMEWORK_DIR resolves inside the fixture, never the real mavericks
// tree): a "local" one that IS the self-install target, and a "sibling" one
// pointed to via MAVERICKS_HOME (set explicitly on every invocation so the
// real ~/.mavericks never leaks into assertions). It asserts:
//
//   (a) local older than sibling (0.1.0 vs 9.9.9): self-install --update
//       leaves PROCESS_STATE.json's mavericks_version unchanged (still the
//       pre-existing value, NOT re-stamped to the older local version), and
//       stdout contains both version strings plus the exact re-run command
//       ("node scripts/mavp-install.js <target> --update").
//   (b) equal versions (5.0.0 vs 5.0.0): no warning printed, and
//       mavericks_version IS re-stamped as before (byte-identical to
//       pre-T-444 behavior).
//   (c) no sibling resolves (MAVERICKS_HOME unset, HOME pointed at an empty
//       scratch dir with no .mavericks / Documents/mavericks): guard
//       degrades silently — no warning, no throw, exit 0, and
//       mavericks_version IS re-stamped as before.
//   (d) local NEWER than "sibling" (9.9.9 vs 0.1.0): no warning, stamp
//       proceeds — the guard only fires on local < sibling, never the
//       reverse.
//
// Does NOT run the installer against the real mavericks tree anywhere — every
// invocation targets a tmp-dir fixture, and MAVERICKS_HOME/HOME are pinned
// per-invocation. Plain node, no npm deps. Exit 0 = pass.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REAL_INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a self-contained fixture "install" root: <root>/scripts/mavp-install.js
 * (copy of the real script) + <root>/scripts/mavp-version.js (hand-written,
 * NOT copied — so its version is fully controlled by the test).
 */
function buildFixtureInstall(root, version) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(REAL_INSTALL_SCRIPT, path.join(scriptsDir, 'mavp-install.js'));
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${version}' };\n`,
    'utf8'
  );
}

function writeProcessState(root, version) {
  fs.writeFileSync(
    path.join(root, 'PROCESS_STATE.json'),
    JSON.stringify({ mavericks_version: version }, null, 2) + '\n',
    'utf8'
  );
}

function readProcessStateVersion(root) {
  const raw = fs.readFileSync(path.join(root, 'PROCESS_STATE.json'), 'utf8');
  return JSON.parse(raw).mavericks_version;
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
  // --- (a) local older than sibling: warning printed, re-stamp skipped ---
  {
    const local = scratch('mavp-staleguard-a-local-');
    buildFixtureInstall(local, '0.1.0');
    writeProcessState(local, '0.1.0');

    const sibling = scratch('mavp-staleguard-a-sibling-');
    buildFixtureInstall(sibling, '9.9.9');

    const out = execFileSync(
      'node',
      [path.join(local, 'scripts', 'mavp-install.js'), '--update', local],
      { encoding: 'utf8', env: { ...process.env, MAVERICKS_HOME: sibling } }
    );

    check(out.includes('WARNING'), '(a) stale-source WARNING printed');
    check(out.includes('0.1.0'), '(a) warning names the local (older) version');
    check(out.includes('9.9.9'), '(a) warning names the sibling (newer) version');
    check(out.includes(sibling), '(a) warning names the sibling path');
    check(
      out.includes(`node scripts/mavp-install.js ${local} --update`),
      '(a) warning includes the exact re-run command'
    );
    check(
      out.includes('skipped') && out.includes('PROCESS_STATE.json version stamp'),
      '(a) skipped-stamp line printed'
    );
    check(
      readProcessStateVersion(local) === '0.1.0',
      '(a) PROCESS_STATE.json mavericks_version left unchanged (not re-stamped to stale local value)'
    );
  }

  // --- (b) equal versions: no warning, stamp proceeds as before ---
  {
    const local = scratch('mavp-staleguard-b-local-');
    buildFixtureInstall(local, '5.0.0');
    writeProcessState(local, '4.0.0');

    const sibling = scratch('mavp-staleguard-b-sibling-');
    buildFixtureInstall(sibling, '5.0.0');

    const out = execFileSync(
      'node',
      [path.join(local, 'scripts', 'mavp-install.js'), '--update', local],
      { encoding: 'utf8', env: { ...process.env, MAVERICKS_HOME: sibling } }
    );

    check(!out.includes('WARNING'), '(b) equal versions — no stale-source warning printed');
    check(
      readProcessStateVersion(local) === '5.0.0',
      '(b) equal versions — mavericks_version IS re-stamped to local version'
    );
  }

  // --- (c) no sibling resolves: guard degrades silently, stamp proceeds ---
  {
    const local = scratch('mavp-staleguard-c-local-');
    buildFixtureInstall(local, '0.1.0');
    writeProcessState(local, '0.1.0');

    // Point HOME at an empty scratch dir (no .mavericks / Documents/mavericks
    // inside it) and unset MAVERICKS_HOME so no sibling can resolve.
    const fakeHome = scratch('mavp-staleguard-c-fakehome-');
    const env = { ...process.env, HOME: fakeHome };
    delete env.MAVERICKS_HOME;

    const out = execFileSync(
      'node',
      [path.join(local, 'scripts', 'mavp-install.js'), '--update', local],
      { encoding: 'utf8', env }
    );

    check(!out.includes('WARNING'), '(c) no sibling resolves — no stale-source warning printed');
    check(
      readProcessStateVersion(local) === '0.1.0',
      '(c) no sibling resolves — mavericks_version IS re-stamped (guard degraded silently)'
    );
  }

  // --- (d) local NEWER than sibling: no warning, stamp proceeds ---
  {
    const local = scratch('mavp-staleguard-d-local-');
    buildFixtureInstall(local, '9.9.9');
    writeProcessState(local, '0.1.0');

    const sibling = scratch('mavp-staleguard-d-sibling-');
    buildFixtureInstall(sibling, '0.1.0');

    const out = execFileSync(
      'node',
      [path.join(local, 'scripts', 'mavp-install.js'), '--update', local],
      { encoding: 'utf8', env: { ...process.env, MAVERICKS_HOME: sibling } }
    );

    check(!out.includes('WARNING'), '(d) local newer than sibling — no stale-source warning printed');
    check(
      readProcessStateVersion(local) === '9.9.9',
      '(d) local newer than sibling — mavericks_version IS re-stamped to local (newer) version'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll T-444 stale-source-guard assertions passed.');
  }
} finally {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
