'use strict';
// Regression test: T-477 — source-behind-upstream guard in mavp-install.js.
//
// Problem this guards against: mavp-install.js resolves a framework source
// (MAVERICKS_HOME > ~/.mavericks > legacy) that is itself a git clone of the
// public mirror. If nobody ever ran `git pull` in that clone after a release
// shipped, the resolved source is BEHIND its own upstream — the installer
// then silently syncs stale framework files and stamps a stale
// mavericks_version (recurred: an adopter project stamped an old version
// after a newer one had already shipped). detectStaleSourceGuard() (T-444) cannot
// catch this — it only compares semver against a sibling install on
// self-install; this guard instead asks the source's OWN git remote whether
// it is behind, regardless of self-install.
//
// This test builds fixture "installs" the same way test-install-stale-source-
// guard.js does (a tmp scripts/ dir containing a copy of mavp-install.js and
// a hand-written mavp-version.js, so FRAMEWORK_DIR resolves inside the
// fixture, never the real mavericks tree) — but here the fixture's root
// directory is ALSO a real git working tree, built via filesystem-path git
// remotes (a tmp "upstream" repo, cloned to become the fixture source). No
// network access anywhere. Cases:
//
//   (a) source behind upstream: installer exits non-zero, prints the exact
//       `git -C <sourceRoot> pull` remediation, and the target's
//       PROCESS_STATE.json / files are left completely untouched (no file
//       write happens at all — the gate runs before any write).
//   (b) same behind-upstream source + --stale-source-ok: installer exits 0
//       and proceeds — files ARE created / PROCESS_STATE.json IS stamped.
//   (c) up-to-date clone (no divergence): installer exits 0, no
//       behind-upstream warning printed.
//   (d) non-git source (plain directory, no .git at all): installer exits 0,
//       no warning — the guard is a silent no-op.
//   (e) git repo with no upstream configured (own repo, never cloned): exits
//       0, no warning — no-op (no @{upstream} to resolve).
//   (f) clone whose remote has since become unreachable (upstream dir
//       deleted — offline-simulating) but whose LOCAL tracking ref is clean
//       (no divergence recorded before going offline): exits 0, no warning —
//       fetch fails silently, rev-list against the last-known-clean tracking
//       ref reports 0 behind.
//   (g) same unreachable-remote scenario, but the tracking ref was already
//       fetched to show behind>0 BEFORE the remote went unreachable: the gate
//       still fires (exit non-zero, warning + remediation printed) even
//       though this run's own fetch attempt fails — proving a stale/offline
//       fetch does not mask an already-known-behind state.
//
// Plain node, no npm deps. Exit 0 = pass.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REAL_INSTALL_SCRIPT = path.join(__dirname, 'mavp-install.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Build a bare-ish "upstream" repo with one commit at `root`.
 */
function buildUpstreamRepo(root) {
  git(['init', '--quiet'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  fs.writeFileSync(path.join(root, 'f.txt'), 'one\n', 'utf8');
  git(['add', 'f.txt'], root);
  git(['commit', '--quiet', '-m', 'one'], root);
}

/**
 * Advance an upstream repo by one commit.
 */
function advanceUpstreamRepo(root) {
  fs.appendFileSync(path.join(root, 'f.txt'), 'two\n', 'utf8');
  git(['commit', '--quiet', '-am', 'two'], root);
}

/**
 * Clone `upstreamRoot` into a fresh scratch dir and drop the fixture
 * installer + version file into <clone>/scripts/ (so FRAMEWORK_DIR resolves
 * inside the clone when the installer runs from there). Returns the clone root.
 */
function cloneAsFixtureSource(upstreamRoot, version) {
  const parent = scratch('mavp-behindguard-clone-parent-');
  const cloneRoot = path.join(parent, 'clonefixture');
  execFileSync('git', ['clone', '--quiet', upstreamRoot, cloneRoot], { encoding: 'utf8', stdio: 'pipe' });
  git(['config', 'user.email', 'test@example.com'], cloneRoot);
  git(['config', 'user.name', 'test'], cloneRoot);
  const scriptsDir = path.join(cloneRoot, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(REAL_INSTALL_SCRIPT, path.join(scriptsDir, 'mavp-install.js'));
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${version}' };\n`,
    'utf8'
  );
  return cloneRoot;
}

/**
 * Build a fixture install root that is NOT any kind of special git setup —
 * mirrors test-install-stale-source-guard.js's buildFixtureInstall. Used for
 * the non-git-source case (d).
 */
function buildPlainFixtureInstall(root, version) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(REAL_INSTALL_SCRIPT, path.join(scriptsDir, 'mavp-install.js'));
  fs.writeFileSync(
    path.join(scriptsDir, 'mavp-version.js'),
    `module.exports = { MAVERICKS_VERSION: '${version}' };\n`,
    'utf8'
  );
}

/**
 * Build a fixture install root that IS its own git repo (one commit) but has
 * no remote/upstream configured at all. Used for case (e).
 */
function buildNoUpstreamFixtureInstall(root, version) {
  buildPlainFixtureInstall(root, version);
  git(['init', '--quiet'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['add', '-A'], root);
  git(['commit', '--quiet', '-m', 'init'], root);
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

/**
 * Run the fixture installer (node <cloneRoot>/scripts/mavp-install.js <target> ...extraArgs).
 * Returns { code, stdout } — code is 0 on success, or the child's exit code
 * (via the thrown error's .status) on non-zero exit. Never throws.
 */
function runInstaller(installRoot, targetDir, extraArgs) {
  const scriptPath = path.join(installRoot, 'scripts', 'mavp-install.js');
  try {
    const stdout = execFileSync('node', [scriptPath, targetDir, ...(extraArgs || [])], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

try {
  // --- (a) behind upstream: exit non-zero, remediation printed, target untouched ---
  {
    const upstream = scratch('mavp-behindguard-a-upstream-');
    buildUpstreamRepo(upstream);
    const cloneRoot = cloneAsFixtureSource(upstream, '1.2.3');
    advanceUpstreamRepo(upstream);

    const target = scratch('mavp-behindguard-a-target-');
    writeProcessState(target, '0.9.0');

    const { code, stdout } = runInstaller(cloneRoot, target, ['--yes']);

    // Node resolves __dirname (and thus FRAMEWORK_DIR) via the realpath of the
    // script path — on macOS /tmp and /var are symlinks into /private, so the
    // printed source path may be the realpath'd form even though we invoked
    // the installer with the unresolved cloneRoot. Compare against the
    // realpath to stay robust across platforms/symlink setups.
    const cloneRootReal = fs.realpathSync(cloneRoot);

    check(code !== 0, '(a) behind-upstream source: installer exits non-zero');
    check(stdout.includes('WARNING'), '(a) WARNING printed');
    check(stdout.includes('behind'), '(a) warning names "behind"');
    check(stdout.includes(`git -C ${cloneRootReal} pull`), '(a) exact pull remediation printed');
    check(
      readProcessStateVersion(target) === '0.9.0',
      '(a) target PROCESS_STATE.json mavericks_version left untouched'
    );
    check(
      !fs.existsSync(path.join(target, 'scripts')),
      '(a) target scripts/ dir was never created (no file write occurred)'
    );
  }

  // --- (b) same behind-upstream source + --stale-source-ok: exit 0, stamps ---
  {
    const upstream = scratch('mavp-behindguard-b-upstream-');
    buildUpstreamRepo(upstream);
    const cloneRoot = cloneAsFixtureSource(upstream, '1.2.3');
    advanceUpstreamRepo(upstream);

    const target = scratch('mavp-behindguard-b-target-');

    const { code, stdout } = runInstaller(cloneRoot, target, ['--yes', '--stale-source-ok']);

    check(code === 0, '(b) --stale-source-ok: installer exits 0');
    check(stdout.includes('WARNING'), '(b) warning still printed (informational, not blocking)');
    check(stdout.includes('--stale-source-ok'), '(b) override notice printed');
    check(
      fs.existsSync(path.join(target, 'PROCESS_STATE.json')) &&
      readProcessStateVersion(target) === '1.2.3',
      '(b) --stale-source-ok: PROCESS_STATE.json created and stamped with source version'
    );
    check(
      fs.existsSync(path.join(target, 'scripts', 'mavp-operator')),
      '(b) --stale-source-ok: install proceeded (scripts/mavp-operator created)'
    );
  }

  // --- (c) up-to-date clone: no warning ---
  {
    const upstream = scratch('mavp-behindguard-c-upstream-');
    buildUpstreamRepo(upstream);
    const cloneRoot = cloneAsFixtureSource(upstream, '1.0.0');
    // No advance — clone stays exactly in sync with upstream.

    const target = scratch('mavp-behindguard-c-target-');
    const { code, stdout } = runInstaller(cloneRoot, target, ['--yes']);

    check(code === 0, '(c) up-to-date source: installer exits 0');
    check(!stdout.includes('behind its upstream'), '(c) up-to-date source: no behind-upstream warning printed');
  }

  // --- (d) non-git source: silent proceed ---
  {
    const install = scratch('mavp-behindguard-d-install-');
    buildPlainFixtureInstall(install, '1.0.0');

    const target = scratch('mavp-behindguard-d-target-');
    const { code, stdout } = runInstaller(install, target, ['--yes']);

    check(code === 0, '(d) non-git source: installer exits 0');
    check(!stdout.includes('behind its upstream'), '(d) non-git source: no behind-upstream warning printed');
  }

  // --- (e) git repo, no upstream/detached: silent proceed ---
  {
    const install = scratch('mavp-behindguard-e-install-');
    buildNoUpstreamFixtureInstall(install, '1.0.0');

    const target = scratch('mavp-behindguard-e-target-');
    const { code, stdout } = runInstaller(install, target, ['--yes']);

    check(code === 0, '(e) no-upstream git repo: installer exits 0');
    check(!stdout.includes('behind its upstream'), '(e) no-upstream git repo: no behind-upstream warning printed');
  }

  // --- (f) unreachable remote, clean tracking ref: silent proceed (offline) ---
  {
    const upstream = scratch('mavp-behindguard-f-upstream-');
    buildUpstreamRepo(upstream);
    const cloneRoot = cloneAsFixtureSource(upstream, '1.0.0');
    // Tracking ref is clean (no divergence) at clone time. Simulate the
    // upstream remote becoming unreachable (e.g. offline / deleted mirror).
    fs.rmSync(upstream, { recursive: true, force: true });

    const target = scratch('mavp-behindguard-f-target-');
    const { code, stdout } = runInstaller(cloneRoot, target, ['--yes']);

    check(code === 0, '(f) unreachable remote, clean tracking ref: installer exits 0');
    check(!stdout.includes('behind its upstream'), '(f) unreachable remote, clean tracking ref: no warning printed (offline-safe)');
  }

  // --- (g) unreachable remote, but tracking ref already behind>0: gate still fires ---
  {
    const upstream = scratch('mavp-behindguard-g-upstream-');
    buildUpstreamRepo(upstream);
    const cloneRoot = cloneAsFixtureSource(upstream, '1.0.0');
    advanceUpstreamRepo(upstream);
    // Fetch once now, while upstream is still reachable, so the local
    // tracking ref (refs/remotes/origin/main) already records behind=1.
    git(['fetch', '--quiet'], cloneRoot);
    // Now simulate the remote going unreachable — this run's own fetch
    // attempt inside the installer will fail, but the previously-fetched
    // tracking ref must still gate.
    fs.rmSync(upstream, { recursive: true, force: true });

    const cloneRootReal = fs.realpathSync(cloneRoot);
    const target = scratch('mavp-behindguard-g-target-');
    writeProcessState(target, '0.5.0');

    const { code, stdout } = runInstaller(cloneRoot, target, ['--yes']);

    check(code !== 0, '(g) unreachable remote but already-known-behind tracking ref: installer exits non-zero');
    check(stdout.includes('WARNING'), '(g) WARNING printed even though this run\'s fetch failed');
    check(stdout.includes(`git -C ${cloneRootReal} pull`), '(g) exact pull remediation printed');
    check(
      readProcessStateVersion(target) === '0.5.0',
      '(g) target PROCESS_STATE.json mavericks_version left untouched'
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll T-477 behind-upstream-guard assertions passed.');
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
