'use strict';
// Regression test: T-394 — context prefetch bundle at task registration.
//
// Covers:
//   1. buildContextBundle() on a fixture task with a Module: field whose
//      registry entry declares context_docs — the generated bundle contains
//      those context_docs (the acceptance-criteria assertion).
//   2. buildContextBundle() includes the Touches list, the repo-map entry,
//      and the Depends on reference.
//   3. buildContextBundle() returns null for an unknown task ID.
//   4. buildContextBundle() degrades gracefully (no throw, sections omitted)
//      when docs/MODULES.md and docs/REPO_MAP.md are both absent.
//   5. writeContextBundle() writes the bundle to .mavp/context/T-NNN.md and
//      returns {ok: true, path}.
//   6. writeContextBundle() returns {ok: false} (never throws) for an
//      unknown task ID.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { buildContextBundle, writeContextBundle, resolveContextBundlePath, truncateTaskBlockAtLevel2Heading } = require('./mavp-operator-lib.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't394-context-bundle-'));

const MODULES_FIXTURE = `# Module Registry — Schema Reference

## test-module

- **label:** Test Module
- **repos:** test-repo
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/AGENT_SPEC.md
- **default_owner:** developer
- **qa_checklist:**
  - Check the thing
`;

const REPO_MAP_FIXTURE = `# Repo Map — Schema Reference

## test-repo

- **label:** Test Repo
- **path:** /home/dev/projects/test-repo
- **domain:** test.example.com
- **deploy_path:** /var/www/test-repo
- **downstream:** other-repo
- **docs:** docs/ARCHITECTURE.md
`;

const BACKLOG_FIXTURE = `# Backlog

## Active Wave

### T-900 — Fixture task with module and repo
- **Status:** in_progress
- **Owner role:** developer
- **Module:** test-module
- **Repo:** test-repo
- **Depends on:** T-800
- **Touches:** src/a.js, src/b.js
- **Verification type:** unit

**Problem:** Fixture problem statement.

**Acceptance criteria:** Fixture acceptance criteria.
`;

const TASK_STATUS_FIXTURE = `# Task Status

## Active tasks

### T-900 — Fixture task with module and repo
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** unit
- **Evidence:** —
`;

/**
 * Build a fixture project root with docs/MODULES.md, docs/REPO_MAP.md,
 * BACKLOG.md, and TASK_STATUS.md. Any of the doc files may be omitted by
 * passing includeModules/includeRepoMap: false.
 */
function makeFixtureRoot(name, { includeModules = true, includeRepoMap = true } = {}) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  if (includeModules) {
    fs.writeFileSync(path.join(root, 'docs', 'MODULES.md'), MODULES_FIXTURE, 'utf8');
  }
  if (includeRepoMap) {
    fs.writeFileSync(path.join(root, 'docs', 'REPO_MAP.md'), REPO_MAP_FIXTURE, 'utf8');
  }
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), BACKLOG_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), TASK_STATUS_FIXTURE, 'utf8');
  return root;
}

// ---------------------------------------------------------------------------
// Test 1: bundle contains the module's context_docs (the acceptance
// criterion: "given a fixture task with module M the generated bundle
// contains M's context_docs").
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('full-fixture');
  const bundle = buildContextBundle('T-900', { root });

  assert.ok(bundle, 'Test 1 FAIL: buildContextBundle() returned null/empty for a task that exists');
  assert.ok(
    bundle.includes('docs/core/TASK_LIFECYCLE.md') && bundle.includes('docs/AGENT_SPEC.md'),
    `Test 1 FAIL: bundle should contain test-module's context_docs, got:\n${bundle}`
  );
  assert.ok(bundle.includes('Module: test-module'), 'Test 1 FAIL: bundle should name the module');
  console.log("Test 1 passed: buildContextBundle() includes the task's module context_docs");

  // -------------------------------------------------------------------------
  // Test 2: bundle also contains the task block, Touches list, repo-map
  // entry, and Depends on reference.
  // -------------------------------------------------------------------------
  assert.ok(bundle.includes('### T-900 — Fixture task with module and repo'), 'Test 2 FAIL: bundle missing task heading');
  assert.ok(bundle.includes('src/a.js') && bundle.includes('src/b.js'), 'Test 2 FAIL: bundle missing Touches entries');
  assert.ok(bundle.includes('### test-repo') && bundle.includes('Test Repo'), 'Test 2 FAIL: bundle missing repo-map entry');
  assert.ok(bundle.includes('**Depends on:** T-800'), 'Test 2 FAIL: bundle missing Depends on reference');
  console.log('Test 2 passed: buildContextBundle() includes task block, Touches, repo-map entry, and Depends on');
}

// ---------------------------------------------------------------------------
// Test 3: buildContextBundle() returns null for an unknown task ID.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('unknown-task-fixture');
  const bundle = buildContextBundle('T-999', { root });
  assert.strictEqual(bundle, null, 'Test 3 FAIL: expected null for an unknown task ID');
  console.log('Test 3 passed: buildContextBundle() returns null for an unknown task ID');
}

// ---------------------------------------------------------------------------
// Test 4: degrades gracefully (no throw, sections omitted) when
// docs/MODULES.md and docs/REPO_MAP.md are both absent.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('no-registries-fixture', { includeModules: false, includeRepoMap: false });

  let bundle;
  assert.doesNotThrow(() => {
    bundle = buildContextBundle('T-900', { root });
  }, 'Test 4 FAIL: buildContextBundle() must not throw when MODULES.md/REPO_MAP.md are absent');

  assert.ok(bundle, 'Test 4 FAIL: bundle should still be produced from the task block alone');
  assert.ok(!bundle.includes('## Module context docs'), 'Test 4 FAIL: Module context docs section should be omitted');
  assert.ok(!bundle.includes('## Repo map entry'), 'Test 4 FAIL: Repo map entry section should be omitted');
  // The parts that don't depend on either registry must still be present.
  assert.ok(bundle.includes('## Touches'), 'Test 4 FAIL: Touches section should still be present');
  assert.ok(bundle.includes('**Depends on:** T-800'), 'Test 4 FAIL: Dependencies section should still be present');
  console.log('Test 4 passed: buildContextBundle() degrades gracefully with no repo map or module registry');
}

// ---------------------------------------------------------------------------
// Test 5: writeContextBundle() writes the bundle file and returns
// {ok: true, path}.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('write-fixture');
  const result = writeContextBundle('T-900', { root });

  assert.strictEqual(result.ok, true, `Test 5 FAIL: expected ok:true, got: ${JSON.stringify(result)}`);
  const expectedPath = resolveContextBundlePath('T-900', root);
  assert.strictEqual(result.path, expectedPath, 'Test 5 FAIL: path mismatch');
  assert.ok(fs.existsSync(expectedPath), 'Test 5 FAIL: bundle file was not written to disk');

  const written = fs.readFileSync(expectedPath, 'utf8');
  assert.ok(written.includes('docs/core/TASK_LIFECYCLE.md'), 'Test 5 FAIL: written bundle missing context_docs');
  console.log('Test 5 passed: writeContextBundle() writes .mavp/context/T-900.md with the expected content');
}

// ---------------------------------------------------------------------------
// Test 6: writeContextBundle() returns {ok: false} (never throws) for an
// unknown task ID.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('write-unknown-fixture');
  let result;
  assert.doesNotThrow(() => {
    result = writeContextBundle('T-999', { root });
  }, 'Test 6 FAIL: writeContextBundle() must not throw for an unknown task ID');
  assert.strictEqual(result.ok, false, 'Test 6 FAIL: expected ok:false for an unknown task ID');
  console.log('Test 6 passed: writeContextBundle() returns ok:false (no throw) for an unknown task ID');
}

// ---------------------------------------------------------------------------
// Test 7 (T-402 regression): buildContextBundle() must not leak a trailing
// level-2 (`## `) section heading into the task block. Reproduces the T-401
// leak shape: a `### T-NNN` block that is the LAST task under its `##` wave
// section, immediately followed by a `## Wave NN — Archived` heading (with
// no further `###` boundary before it) — parseAllTaskBlocks() only splits on
// `### T-` headings, so without truncation the block would run straight
// through into the archived-wave heading text.
// ---------------------------------------------------------------------------
{
  const LEAK_BACKLOG_FIXTURE = `# Backlog

## Active Wave

### T-901 — Fixture task immediately followed by an archived wave heading
- **Status:** merged
- **Owner role:** developer
- **Repo:** test-repo
- **Touches:** src/leak.js
- **Verification type:** unit

**Problem:** Fixture problem statement.

**Acceptance criteria:** Fixture acceptance criteria.

## Wave 55 — Archived

Some archived-wave prose that must NOT leak into T-901's context bundle.
`;

  const root = path.join(TMP_DIR, 'heading-leak-fixture');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), LEAK_BACKLOG_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# Task Status\n', 'utf8');

  const bundle = buildContextBundle('T-901', { root });
  assert.ok(bundle, 'Test 7 FAIL: buildContextBundle() returned null for the leak fixture');
  assert.ok(
    bundle.includes('### T-901 — Fixture task immediately followed by an archived wave heading'),
    'Test 7 FAIL: bundle should still contain the ### T-901 heading'
  );
  assert.ok(
    !/^##\s+Wave/m.test(bundle),
    `Test 7 FAIL: bundle must not contain a leaked "## Wave" heading, got:\n${bundle}`
  );
  assert.ok(
    !bundle.includes('archived-wave prose'),
    'Test 7 FAIL: bundle must not contain prose from the archived-wave section'
  );
  console.log('Test 7 passed: buildContextBundle() truncates the task block at the first level-2 (##) heading');

  // Direct unit coverage of the helper itself.
  const rawBlock = '### T-1 — Title\n- **Status:** merged\n## Wave 2 — Archived\nleaked text';
  const truncated = truncateTaskBlockAtLevel2Heading(rawBlock);
  assert.strictEqual(
    truncated,
    '### T-1 — Title\n- **Status:** merged',
    `Test 7b FAIL: truncateTaskBlockAtLevel2Heading() did not cut at the ## heading, got:\n${truncated}`
  );
  assert.strictEqual(
    truncateTaskBlockAtLevel2Heading(null),
    null,
    'Test 7b FAIL: truncateTaskBlockAtLevel2Heading(null) should return null'
  );
  console.log('Test 7b passed: truncateTaskBlockAtLevel2Heading() cuts at the first ## heading, passes through when absent');
}

// ---------------------------------------------------------------------------
// Test 8 (T-402): --emit-bundle builds the bundle in-memory via
// buildContextBundle() and performs NO file writes — .mavp/context/ must not
// be created (and any pre-existing bundle file's mtime must be untouched),
// preserving the read-only reporting-surface rule (.claude/rules/scripts.md).
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot('emit-bundle-fixture');
  const emitBundleScript = path.join(__dirname, 'mavp-operator-emit-bundle.js');

  // 8a. Known task ID: stdout matches buildContextBundle() in-memory, exit 0,
  // and no .mavp/context/ directory is created.
  const expected = buildContextBundle('T-900', { root });
  const result = spawnSync(process.execPath, [emitBundleScript, 'T-900'], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, `Test 8a FAIL: expected exit 0, got ${result.status}. stderr:\n${result.stderr}`);
  assert.strictEqual(result.stdout, expected, 'Test 8a FAIL: --emit-bundle stdout should match buildContextBundle() output exactly');
  const contextDir = path.join(root, '.mavp', 'context');
  assert.ok(!fs.existsSync(contextDir), 'Test 8a FAIL: --emit-bundle must not create .mavp/context/ (no file writes allowed)');
  console.log('Test 8a passed: --emit-bundle prints buildContextBundle() output in-memory and writes no file');

  // 8b. Unknown task ID: non-zero exit, clear message on stderr, still no file writes.
  const badResult = spawnSync(process.execPath, [emitBundleScript, 'T-999999'], {
    cwd: root,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
    encoding: 'utf8',
  });
  assert.notStrictEqual(badResult.status, 0, 'Test 8b FAIL: unknown task ID should exit non-zero');
  assert.ok(
    /not found/i.test(badResult.stderr) && badResult.stderr.includes('T-999999'),
    `Test 8b FAIL: stderr should clearly name the unknown task ID, got:\n${badResult.stderr}`
  );
  assert.ok(!fs.existsSync(contextDir), 'Test 8b FAIL: --emit-bundle must not create .mavp/context/ even on failure');
  console.log('Test 8b passed: --emit-bundle T-999999 (unknown ID) exits non-zero with a clear stderr message and no file writes');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log('\nAll T-394/T-402 assertions passed.');
