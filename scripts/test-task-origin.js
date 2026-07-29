'use strict';
// Regression test: T-531 — stamp task Origin at registration and print an
// architect-gate advisory on bypass paths.
//
// Covers the acceptance criteria verbatim:
//   1. --apply-decomposition stamps Origin: architect on every task it
//      registers, and never prints the architect-gate advisory (this path
//      IS the gate).
//   2. --new-task / --quick-task stamp Origin: manual by default and print
//      exactly one whole-line advisory naming the architect gate.
//   3. --new-task --origin architect / --quick-task --origin architect
//      stamp Origin: architect instead, and the advisory is ABSENT.
//   4. The advisory is asserted as a WHOLE LINE (exact match against one
//      line of stderr), never a substring.
//   5. scripts/mavp-operator-sync-status.js stays unperturbed: it never
//      mirrors Origin into TASK_STATUS.md, on both the status-sync path and
//      the skeleton-create path.
//   6. Non-TTY contracts are unchanged: --new-task still requires --title,
//      --quick-task still requires all three of --title/--problem/--repo.
//   7. The validator stays healthy on the fixture after registration.
//
// Absence assertions (--apply-decomposition, and --new-task/--quick-task
// with --origin architect) are load-bearing, not decorative — they are what
// stops the advisory becoming a permanent nag. See the mutation-check notes
// inline for how each assertion is designed to fail under a specific
// mutation (removing the advisory print / flipping the default origin).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const {
  resolveTaskOrigin,
  ARCHITECT_GATE_ADVISORY,
} = require('./mavp-operator-lib.js');

const {
  buildBacklogEntry: buildDecompositionBacklogEntry,
  applyDecompositionFromString,
} = require('./mavp-operator-apply-decomposition.js');

const SCRIPTS_DIR = __dirname;
const NEW_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-new-task.js');
const QUICK_TASK_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-quick-task.js');
const SYNC_STATUS_PATH = path.join(SCRIPTS_DIR, 'mavp-operator-sync-status.js');
const VALIDATOR_PATH = path.join(SCRIPTS_DIR, 'mavp-validator.js');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't531-task-origin-'));

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }

function makeFixtureRoot(name) {
  const root = path.join(TMP_DIR, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# Backlog\n\n## Active Wave\n\n', 'utf8');
  fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), '# Task Status\n\n## Active tasks\n\n', 'utf8');
  fs.writeFileSync(path.join(root, 'PROCESS_STATE.json'), JSON.stringify({
    initiative: 'fixture',
    stage: 'execution',
    wave: 1,
    wave_status: 'execution',
    active_slices: [],
    next_action: 'noop',
    blocker: null,
    stage_owner: 'main_agent',
    last_task_id: 900,
    last_updated: '2026-01-01',
  }, null, 2) + '\n', 'utf8');
  return root;
}

// Whole-line helper: returns true iff `line` appears as an EXACT element of
// `text` split on newlines — never a substring match (T-531 requirement).
function hasWholeLine(text, line) {
  return text.split('\n').includes(line);
}

function runCli(scriptPath, cwd, args, input) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd,
    env: { ...process.env, MAVERICKS_PROJECT_ROOT: cwd, MAVERICKS_SCRIPTS: SCRIPTS_DIR },
    input: input != null ? input : undefined,
    encoding: 'utf8',
  });
}

function runValidator(cwd) {
  return spawnSync('node', [VALIDATOR_PATH, cwd], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Test 1 (unit): resolveTaskOrigin() — only exact "architect" (any case,
// trimmed) resolves to architect; everything else, including null/undefined
// and unrelated strings, resolves to manual.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(resolveTaskOrigin('architect'), 'architect', 'Test 1a FAIL: "architect" should resolve to architect');
  assert.strictEqual(resolveTaskOrigin('Architect'), 'architect', 'Test 1b FAIL: case-insensitive match expected');
  assert.strictEqual(resolveTaskOrigin('  architect  '), 'architect', 'Test 1c FAIL: whitespace should be trimmed');
  assert.strictEqual(resolveTaskOrigin(null), 'manual', 'Test 1d FAIL: null should default to manual');
  assert.strictEqual(resolveTaskOrigin(undefined), 'manual', 'Test 1e FAIL: undefined should default to manual');
  assert.strictEqual(resolveTaskOrigin(''), 'manual', 'Test 1f FAIL: empty string should default to manual');
  assert.strictEqual(resolveTaskOrigin('manual'), 'manual', 'Test 1g FAIL: explicit "manual" should stay manual');
  assert.strictEqual(resolveTaskOrigin('archite'), 'manual', 'Test 1h FAIL: a near-miss value must NOT resolve to architect');
  console.log('Test 1 passed: resolveTaskOrigin() resolves only exact (case/whitespace-insensitive) "architect" to architect, everything else to manual');
}

// ---------------------------------------------------------------------------
// Test 2 (acceptance criterion 1): --apply-decomposition stamps
// Origin: architect on every task, unconditionally, and never prints the
// architect-gate advisory.
//
// Mutation-check design: if the "- **Origin:** architect" push in
// buildBacklogEntry() were removed, this test's assert.ok on the whole line
// fails — this is the "stamp test" the brief names.
// ---------------------------------------------------------------------------
{
  const task = { title: 'Decomposition task', owner_role: 'developer', verification_type: 'runtime' };
  const entry = buildDecompositionBacklogEntry('T-950', task);
  assert.ok(
    hasWholeLine(entry, '- **Origin:** architect'),
    `Test 2a FAIL: apply-decomposition entry should contain the whole line "- **Origin:** architect", got:\n${entry}`
  );
  console.log('Test 2a passed: buildBacklogEntry() (apply-decomposition) stamps the whole line "- **Origin:** architect"');

  // End-to-end via applyDecompositionFromString() — capture console output
  // in-process (this function is called directly, not spawned) to prove the
  // advisory line is ABSENT from the real registration path.
  const root = makeFixtureRoot('apply-decomposition-e2e');
  const prevRoot = process.env.MAVERICKS_PROJECT_ROOT;
  const prevScripts = process.env.MAVERICKS_SCRIPTS;
  process.env.MAVERICKS_PROJECT_ROOT = root;
  process.env.MAVERICKS_SCRIPTS = SCRIPTS_DIR;

  delete require.cache[require.resolve('./mavp-operator-apply-decomposition.js')];
  const fresh = require('./mavp-operator-apply-decomposition.js');

  const captured = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a) => { captured.push(a.join(' ')); };
  console.error = (...a) => { captured.push(a.join(' ')); };
  console.warn = (...a) => { captured.push(a.join(' ')); };

  const input = `<!-- mavp-decomposition-start -->
title: Architect-routed fixture task
owner_role: developer
depends_on: —
verification_type: runtime
problem: Fixture problem.
acceptance_criteria: Fixture criteria.
<!-- mavp-decomposition-end -->`;

  return fresh.applyDecompositionFromString(input).then(() => {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;

    if (prevRoot === undefined) delete process.env.MAVERICKS_PROJECT_ROOT;
    else process.env.MAVERICKS_PROJECT_ROOT = prevRoot;
    if (prevScripts === undefined) delete process.env.MAVERICKS_SCRIPTS;
    else process.env.MAVERICKS_SCRIPTS = prevScripts;

    const capturedText = captured.join('\n');
    assert.ok(
      !hasWholeLine(capturedText, ARCHITECT_GATE_ADVISORY),
      `Test 2b FAIL: apply-decomposition must NEVER print the architect-gate advisory, but found it in captured output:\n${capturedText}`
    );
    console.log('Test 2b passed: applyDecompositionFromString() never prints the architect-gate advisory (whole-line absence)');

    const backlogOut = readUtf8(path.join(root, 'BACKLOG.md'));
    assert.ok(
      hasWholeLine(backlogOut, '- **Origin:** architect'),
      `Test 2c FAIL: registered BACKLOG.md entry should contain the whole line "- **Origin:** architect", got:\n${backlogOut}`
    );
    console.log('Test 2c passed: end-to-end apply-decomposition registration stamps "- **Origin:** architect" in BACKLOG.md');

    // applyDecompositionFromString()'s own internal validator call never
    // passes an explicit cwd (it inherits this test process's cwd), so it
    // does not actually validate the fixture. Run the validator against the
    // fixture root directly here to confirm the acceptance criterion
    // ("validator stays healthy on the fixture after registration").
    const validatorRes = runValidator(root);
    assert.strictEqual(
      validatorRes.status, 0,
      `Test 2d FAIL: validator should exit 0 (healthy) on the apply-decomposition fixture, got ${validatorRes.status}. stdout:\n${validatorRes.stdout}`
    );
    console.log('Test 2d passed: validator exits 0 (healthy) on the apply-decomposition fixture after registration');

    runRemainingTests();
  });
}

function runRemainingTests() {
  // -------------------------------------------------------------------------
  // Test 3 (acceptance criterion 2, --new-task manual path): default
  // registration (no --origin flag) stamps Origin: manual and prints the
  // architect-gate advisory as a WHOLE stderr line.
  //
  // Mutation-check design (named "the manual-path test" in the brief): if
  // the `console.error(ARCHITECT_GATE_ADVISORY)` call in
  // mavp-operator-new-task.js is removed, the hasWholeLine() assertion below
  // fails because the advisory never appears in stderr at all.
  // -------------------------------------------------------------------------
  const rootNewTask = makeFixtureRoot('new-task-e2e');
  {
    const res = runCli(NEW_TASK_PATH, rootNewTask, ['--title', 'New task default origin', '--repo', 'fixture-repo']);
    assert.strictEqual(res.status, 0, `Test 3 FAIL: --new-task should exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(
      hasWholeLine(res.stderr, ARCHITECT_GATE_ADVISORY),
      `Test 3 FAIL: --new-task default path should print the architect-gate advisory as a whole stderr line, got stderr:\n${res.stderr}`
    );
    const backlogOut = readUtf8(path.join(rootNewTask, 'BACKLOG.md'));
    const taskBlock = backlogOut.split('### T-901')[1] || '';
    assert.ok(
      hasWholeLine(taskBlock, '- **Origin:** manual'),
      `Test 3 FAIL: T-901 should be stamped "- **Origin:** manual", got block:\n${taskBlock}`
    );
    console.log('Test 3 passed: --new-task (no --origin) stamps Origin: manual and prints the architect-gate advisory as a whole stderr line');
  }

  // -------------------------------------------------------------------------
  // Test 4 (acceptance criterion 3, --new-task attested path — ABSENCE,
  // load-bearing): --origin architect stamps Origin: architect and the
  // advisory is ABSENT (whole-line, not substring).
  // -------------------------------------------------------------------------
  {
    const res = runCli(NEW_TASK_PATH, rootNewTask, ['--title', 'New task attested origin', '--repo', 'fixture-repo', '--origin', 'architect']);
    assert.strictEqual(res.status, 0, `Test 4 FAIL: --new-task --origin architect should exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(
      !hasWholeLine(res.stderr, ARCHITECT_GATE_ADVISORY),
      `Test 4 FAIL: --new-task --origin architect must NOT print the architect-gate advisory, got stderr:\n${res.stderr}`
    );
    const backlogOut = readUtf8(path.join(rootNewTask, 'BACKLOG.md'));
    const taskBlock = backlogOut.split('### T-902')[1] || '';
    assert.ok(
      hasWholeLine(taskBlock, '- **Origin:** architect'),
      `Test 4 FAIL: T-902 should be stamped "- **Origin:** architect", got block:\n${taskBlock}`
    );
    console.log('Test 4 passed: --new-task --origin architect stamps Origin: architect and the advisory is ABSENT (whole-line)');
  }

  // -------------------------------------------------------------------------
  // Test 5 (acceptance criterion 2, --quick-task manual path).
  // -------------------------------------------------------------------------
  const rootQuickTask = makeFixtureRoot('quick-task-e2e');
  {
    const res = runCli(QUICK_TASK_PATH, rootQuickTask, ['--title', 'Quick task default origin', '--problem', 'a fixture problem', '--repo', 'fixture-repo']);
    assert.strictEqual(res.status, 0, `Test 5 FAIL: --quick-task should exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(
      hasWholeLine(res.stderr, ARCHITECT_GATE_ADVISORY),
      `Test 5 FAIL: --quick-task default path should print the architect-gate advisory as a whole stderr line, got stderr:\n${res.stderr}`
    );
    const backlogOut = readUtf8(path.join(rootQuickTask, 'BACKLOG.md'));
    const taskBlock = backlogOut.split('### T-901')[1] || '';
    assert.ok(
      hasWholeLine(taskBlock, '- **Origin:** manual'),
      `Test 5 FAIL: T-901 should be stamped "- **Origin:** manual", got block:\n${taskBlock}`
    );
    console.log('Test 5 passed: --quick-task (no --origin) stamps Origin: manual and prints the architect-gate advisory as a whole stderr line');
  }

  // -------------------------------------------------------------------------
  // Test 6 (acceptance criterion 3, --quick-task attested path — ABSENCE,
  // load-bearing).
  // -------------------------------------------------------------------------
  {
    const res = runCli(QUICK_TASK_PATH, rootQuickTask, ['--title', 'Quick task attested origin', '--problem', 'a fixture problem', '--repo', 'fixture-repo', '--origin', 'architect']);
    assert.strictEqual(res.status, 0, `Test 6 FAIL: --quick-task --origin architect should exit 0, got ${res.status}. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(
      !hasWholeLine(res.stderr, ARCHITECT_GATE_ADVISORY),
      `Test 6 FAIL: --quick-task --origin architect must NOT print the architect-gate advisory, got stderr:\n${res.stderr}`
    );
    const backlogOut = readUtf8(path.join(rootQuickTask, 'BACKLOG.md'));
    const taskBlock = backlogOut.split('### T-902')[1] || '';
    assert.ok(
      hasWholeLine(taskBlock, '- **Origin:** architect'),
      `Test 6 FAIL: T-902 should be stamped "- **Origin:** architect", got block:\n${taskBlock}`
    );
    console.log('Test 6 passed: --quick-task --origin architect stamps Origin: architect and the advisory is ABSENT (whole-line)');
  }

  // -------------------------------------------------------------------------
  // Test 7: validator stays healthy on both fixtures after registration.
  // -------------------------------------------------------------------------
  {
    const resNew = runValidator(rootNewTask);
    assert.strictEqual(resNew.status, 0, `Test 7a FAIL: validator should exit 0 (healthy) on the --new-task fixture, got ${resNew.status}. stdout:\n${resNew.stdout}`);
    const resQuick = runValidator(rootQuickTask);
    assert.strictEqual(resQuick.status, 0, `Test 7b FAIL: validator should exit 0 (healthy) on the --quick-task fixture, got ${resQuick.status}. stdout:\n${resQuick.stdout}`);
    console.log('Test 7 passed: validator exits 0 (healthy) on both fixtures after registration');
  }

  // -------------------------------------------------------------------------
  // Test 8 (constraint check): scripts/mavp-operator-sync-status.js stays
  // unperturbed by the new Origin field — it must never mirror Origin into
  // TASK_STATUS.md, on both the status-sync path (existing entry) and the
  // skeleton-create path (new entry).
  // -------------------------------------------------------------------------
  {
    const root = makeFixtureRoot('sync-status-unperturbed');
    // Task A: already has a TASK_STATUS entry; BACKLOG changes its status —
    // sync-status should mirror ONLY the Status line, never add an Origin
    // line to TASK_STATUS.md even though BACKLOG carries one.
    fs.writeFileSync(path.join(root, 'BACKLOG.md'), `# Backlog

## Active Wave

### T-900 — Task with existing TASK_STATUS entry
- **Status:** in_progress
- **Owner role:** developer
- **Verification type:** runtime
- **Origin:** manual

### T-901 — Task needing a skeleton TASK_STATUS entry
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Origin:** architect
`, 'utf8');
    fs.writeFileSync(path.join(root, 'TASK_STATUS.md'), `# Task Status

## Active tasks

### T-900 — Task with existing TASK_STATUS entry
- **Status:** planned
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** —
- **Evidence:** —
`, 'utf8');

    const res = spawnSync('node', [SYNC_STATUS_PATH], {
      env: { ...process.env, MAVERICKS_PROJECT_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.strictEqual(res.status, 0, `Test 8 FAIL: sync-status should always exit 0, got ${res.status}. stderr:\n${res.stderr}`);
    assert.ok(res.stderr.includes('sync-status: synced T-900: in_progress -> in_progress') === false, 'sanity: no-op guard not the concern here');

    const taskStatusOut = readUtf8(path.join(root, 'TASK_STATUS.md'));
    assert.ok(!taskStatusOut.includes('**Origin'), `Test 8 FAIL: TASK_STATUS.md must never contain an Origin field (BACKLOG-only, per T-531), got:\n${taskStatusOut}`);
    assert.ok(taskStatusOut.includes('- **Status:** in_progress'), `Test 8 FAIL: T-900's Status should be synced to in_progress, got:\n${taskStatusOut}`);

    const t901Block = taskStatusOut.split('### T-901')[1] || '';
    assert.ok(t901Block, 'Test 8 FAIL: T-901 should have gotten an auto-created skeleton TASK_STATUS entry');
    assert.ok(!t901Block.includes('**Origin'), `Test 8 FAIL: the auto-created T-901 skeleton must not carry an Origin line, got:\n${t901Block}`);
    assert.ok(t901Block.includes('- **Status:** planned'), `Test 8 FAIL: the auto-created T-901 skeleton should carry BACKLOG\'s status, got:\n${t901Block}`);

    console.log('Test 8 passed: sync-status never mirrors Origin into TASK_STATUS.md, on both the status-sync path and the skeleton-create path');
  }

  // -------------------------------------------------------------------------
  // Test 9 (constraint check): non-TTY contracts are unchanged.
  //   9a. --new-task refuses and writes nothing when --title is missing on
  //       non-TTY stdin (spawnSync's child stdin is never a TTY).
  //   9b. --quick-task refuses and writes nothing when any of
  //       --title/--problem/--repo is missing on non-TTY stdin.
  //   Neither guard is affected by adding --origin as an always-optional flag.
  // -------------------------------------------------------------------------
  {
    const root = makeFixtureRoot('non-tty-contracts');
    const backlogBefore = readUtf8(path.join(root, 'BACKLOG.md'));
    const taskStatusBefore = readUtf8(path.join(root, 'TASK_STATUS.md'));

    // 9a. --new-task with no --title at all (non-TTY stdin) -> refuse, exit 1.
    const resA = runCli(NEW_TASK_PATH, root, ['--repo', 'fixture-repo'], '');
    assert.notStrictEqual(resA.status, 0, `Test 9a FAIL: --new-task without --title on non-TTY stdin should refuse (non-zero exit), got ${resA.status}`);
    assert.ok(resA.stderr.includes('--title is missing'), `Test 9a FAIL: expected the missing-title refusal message, got stderr:\n${resA.stderr}`);

    // 9b. --quick-task missing --repo (title + problem supplied) -> refuse, exit 1.
    const resB = runCli(QUICK_TASK_PATH, root, ['--title', 'x', '--problem', 'y'], '');
    assert.notStrictEqual(resB.status, 0, `Test 9b FAIL: --quick-task missing --repo on non-TTY stdin should refuse (non-zero exit), got ${resB.status}`);
    assert.ok(resB.stderr.includes('--repo'), `Test 9b FAIL: expected the missing-flag refusal message to name --repo, got stderr:\n${resB.stderr}`);

    // Neither refusal should have written anything.
    const backlogAfter = readUtf8(path.join(root, 'BACKLOG.md'));
    const taskStatusAfter = readUtf8(path.join(root, 'TASK_STATUS.md'));
    assert.strictEqual(backlogAfter, backlogBefore, 'Test 9 FAIL: BACKLOG.md must be unchanged after a refused non-TTY invocation');
    assert.strictEqual(taskStatusAfter, taskStatusBefore, 'Test 9 FAIL: TASK_STATUS.md must be unchanged after a refused non-TTY invocation');

    console.log('Test 9 passed: --new-task still requires --title and --quick-task still requires all three of --title/--problem/--repo on non-TTY stdin, and --origin does not loosen either guard');
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nAll T-531 assertions passed.');
}
