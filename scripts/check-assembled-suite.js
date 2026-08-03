#!/usr/bin/env node
// check-assembled-suite.js — runs the SHIPPED test suite in the environment it
// actually ships to (a mirror-shaped assembled tree), and records a receipt
// that scripts/mavp-publish-build.js refuses to publish without (T-587).
//
// WHY THIS FILE EXISTS — two consecutive public releases, same shape:
//   - 0.39.0 (T-570): shipped manifest tests asserted a completeness property
//     that only holds in the canonical private repo.
//   - 0.40.0 (T-575): a false-positive guard asserted >100 parsed records from
//     the repo's real BACKLOG.md / TASK_STATUS.md, but publish-manifest.json
//     ships both as one-record `reset` templates, so the mirror got
//     backlog=1 task_status=1 and reddened on all three node cells.
// In BOTH cases the private CI was green. The class: a `ship`-classified check
// runs in TWO environment classes — the canonical private repo, and the
// mirror-shaped assembled tree — and green in the first is not evidence about
// the second. Nothing mechanical looked at the second before publication; the
// mirror's own CI caught it, but only ever AFTER the push.
//
// WHY A RECEIPT, NOT A PREFLIGHT INSIDE THE PUBLISHER — the obvious design
// (have mavp-publish-build.js run this suite itself) recurses and is
// unaffordable: scripts/test-publish-build.js's e2e cases run
// mavp-publish-build.js inside CLONES of the canonical repo, so a suite-run
// preflight there would add a full ~12-minute suite per e2e case AND recurse
// (each inner assembled tree contains test-publish-build.js, which clones
// again). So the gate binds EVIDENCE, not execution: THIS script runs the
// suite and writes a receipt; mavp-publish-build.js only checks that a
// receipt exists whose recorded commit equals the current HEAD, which is O(1)
// and cannot recurse.
//
// THE RECEIPT IS AN ANTI-FORGETFULNESS DEVICE, NOT AN ANTI-ADVERSARY ONE.
// Stated plainly so no future reader mistakes it for a security boundary: the
// receipt is a plain JSON file in a git-ignored directory, so it is forgeable
// by writing a fake file — which is exactly as hard as editing the gate out of
// mavp-publish-build.js, i.e. trivial for anyone with write access to this
// repo. That is acceptable because the OBSERVED threat is omission (twice, see
// above), not malice. Every hard gate in mavp-publish-build.js that IS about
// content integrity (the secret scan, the provenance verifiers) keeps its own
// separate, non-receipt-based enforcement.
//
// TWO PROPERTIES THAT ARE DELIBERATE — do not "improve" them away:
//   1. NO SKIP FLAG. There is no --skip / --force / env override anywhere in
//      this mechanism, consistent with scripts/test-publish-overlay.js Test 34
//      pinning "no flag can relax the contract" as a design invariant. An
//      escape hatch reintroduces the fail-open shape this closes.
//   2. EXACT-HEAD BINDING. Any commit after the suite run — including a
//      `chore: close session` commit — invalidates the receipt and forces a
//      re-run. The loose alternative (binding to "the shipped content did not
//      change") was rejected as a fail-open door: it requires this script to
//      re-derive what "shipped content" means, and every such derivation is a
//      place where a real change can be classified as irrelevant. So the
//      operator sequence is: close-session -> check-assembled-suite ->
//      publish, at the occasional cost of one redundant ~12-minute re-run.
//
// WHAT IT DOES, in order:
//   1. Refuses on a dirty source repo (same reason and same check as
//      mavp-publish-build.js's own step 0 — the receipt names a COMMIT, so a
//      receipt written from a tree that matches no commit would be a claim
//      about content that was never assembled; the disk manifest the assembler
//      reads would also differ from HEAD's).
//   2. Assembles the mirror-shaped tree via scripts/mavp-publish-assemble.js
//      (which sources every byte from HEAD, never from the working disk).
//   3. `git init` + one commit inside that tree, so the inner suite runs in a
//      real git repository — several shipped tests clone their own REPO_ROOT
//      or read `git ls-files`, and would fail for the wrong reason in a
//      non-repo directory.
//   4. Runs the assembled tree's OWN scripts/run-tests.js (never this repo's),
//      streaming to a log file outside the tree.
//   5. Anti-vacuity: the inner suite's reported total must be at least the
//      number of scripts/test-*.js files present in the assembled tree — a
//      run that discovered nothing, or a subset, is a red, not a green.
//   6. Exits 0 only on an all-green summary; exits non-zero naming the failing
//      test files otherwise.
//   7. On green ONLY, writes the receipt (see RECEIPT_RELATIVE_PATH).
//
// NAMING CONSTRAINT: this file is deliberately NOT named test-*.js.
// scripts/run-tests.js discovers `test-*.js` in scripts/, so a test-prefixed
// name here would make the outer suite run this script, which runs an inner
// suite, which... — infinite recursion, ~12 minutes per level.
//
// Usage:
//   node scripts/check-assembled-suite.js [--keep]
//
//   --keep   leave the assembled tree and the inner suite log on disk (their
//            paths are printed either way) for post-mortem inspection.
//
// No external dependencies — Node built-ins only (.claude/rules/scripts.md).

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ASSEMBLE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mavp-publish-assemble.js');

// Receipt location, relative to a repo root. Git-ignored (see .gitignore) —
// which is load-bearing twice over, not cosmetic: (a) a tracked receipt would
// be shipped content that changes on every suite run, and (b) an UNTRACKED,
// UNIGNORED file makes `git status --porcelain` non-empty, so both this
// script's own dirty-repo refusal and mavp-publish-build.js's would then fire
// on the very artifact the mechanism just produced.
const RECEIPT_RELATIVE_PATH = path.join('.mavp', 'assembled-suite-receipt.json');

// Bumped only if the receipt's shape changes incompatibly. mavp-publish-build.js
// accepts a receipt only at this exact version, so an older-format receipt left
// on disk reads as "no current receipt" (fail closed) rather than being
// misinterpreted field-by-field.
const RECEIPT_SCHEMA = 1;

// The exact command an operator must run when the gate refuses. Referenced by
// mavp-publish-build.js's refusal message so the two can never drift apart.
const CHECK_COMMAND = 'node scripts/check-assembled-suite.js';

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Receipt read/write — the shared contract between this script and
// mavp-publish-build.js's preflight. Both sides use THESE functions; neither
// re-implements the path or the shape.
// ---------------------------------------------------------------------------

function receiptPathFor(repoRoot) {
  return path.join(repoRoot, RECEIPT_RELATIVE_PATH);
}

/**
 * Reads and shape-validates the receipt at `repoRoot`.
 * Never throws: every failure mode (absent, unreadable, unparseable, wrong
 * schema, missing/malformed fields, non-green summary) returns
 * `{ ok: false, reason }`. Fail-closed is the caller's job, but this function
 * makes it the only reachable option by never returning a partial success.
 */
function readReceipt(repoRoot) {
  const receiptPath = receiptPathFor(repoRoot);
  let raw;
  try {
    raw = fs.readFileSync(receiptPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `no readable receipt at ${receiptPath} (${err.code || err.message})`, receiptPath };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `receipt at ${receiptPath} is not valid JSON (${err.message})`, receiptPath };
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reason: `receipt at ${receiptPath} is not a JSON object`, receiptPath };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) {
    return {
      ok: false,
      reason: `receipt at ${receiptPath} has schema ${JSON.stringify(receipt.schema)}, expected ${RECEIPT_SCHEMA}`,
      receiptPath,
    };
  }
  if (typeof receipt.commit !== 'string' || !/^[0-9a-f]{40}$/.test(receipt.commit)) {
    return {
      ok: false,
      reason: `receipt at ${receiptPath} has no full 40-hex commit field (got ${JSON.stringify(receipt.commit)})`,
      receiptPath,
    };
  }
  const suite = receipt.suite;
  if (!suite || typeof suite !== 'object') {
    return { ok: false, reason: `receipt at ${receiptPath} has no suite summary object`, receiptPath };
  }
  const { total, passed, failed } = suite;
  if (!Number.isInteger(total) || !Number.isInteger(passed) || !Number.isInteger(failed)) {
    return {
      ok: false,
      reason: `receipt at ${receiptPath} has a non-integer suite total/passed/failed (${JSON.stringify(suite)})`,
      receiptPath,
    };
  }
  // A receipt is only ever WRITTEN on green, but a hand-written or truncated
  // one can say anything — so the consumer re-derives greenness from the
  // recorded numbers instead of trusting the file's existence.
  if (total <= 0 || failed !== 0 || passed !== total) {
    return {
      ok: false,
      reason: `receipt at ${receiptPath} does not record an all-green suite (${JSON.stringify(suite)})`,
      receiptPath,
    };
  }
  return { ok: true, receipt, receiptPath };
}

/** Resolves `repoRoot`'s current HEAD as a full 40-hex sha, or null. */
function headCommitOf(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Writes a receipt for `repoRoot` bound to an explicit `commit`.
 * Callers: this script's own green path, and — via writeReceiptForHead() —
 * scripts/test-publish-build.js's e2e fixtures, which need to satisfy the
 * publish preflight without running an inner suite (that would recurse; see
 * this file's header).
 */
function writeReceipt(repoRoot, { commit, suite, assembledTestFiles, assembledFileCount, summaryLine, note }) {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    commit,
    generated_at: new Date().toISOString(),
    suite,
    summary_line: summaryLine || null,
    assembled_test_files: Number.isInteger(assembledTestFiles) ? assembledTestFiles : null,
    assembled_file_count: Number.isInteger(assembledFileCount) ? assembledFileCount : null,
    note: note || null,
  };
  const receiptPath = receiptPathFor(repoRoot);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { receipt, receiptPath };
}

/**
 * Test-fixture convenience: writes a receipt bound to `repoRoot`'s CURRENT
 * HEAD, with a synthetic all-green summary and an explicit `note` recording
 * that no suite was run. Throws if HEAD cannot be resolved — a fixture that
 * silently wrote a receipt for a bogus commit would make the gate it is
 * supposed to satisfy pass for the wrong reason.
 *
 * This is NOT a bypass of the gate for real publishes: it writes into the
 * caller-supplied repo root (a throwaway clone in the tests), and the real
 * repo's receipt still only ever comes from a real green run below.
 */
function writeReceiptForHead(repoRoot, options) {
  const commit = headCommitOf(repoRoot);
  if (!commit) {
    throw new Error(`writeReceiptForHead: could not resolve HEAD in ${repoRoot}`);
  }
  const opts = options || {};
  const total = Number.isInteger(opts.total) ? opts.total : 1;
  return writeReceipt(repoRoot, {
    commit,
    suite: { total, passed: total, failed: 0 },
    summaryLine: `Summary: ${total} passed, 0 failed (of ${total} total)`,
    assembledTestFiles: total,
    assembledFileCount: null,
    note:
      opts.note ||
      'fixture-written receipt (no suite was run) — satisfies the publish preflight without recursing',
  });
}

// ---------------------------------------------------------------------------
// Inner-suite summary parsing (pure — exported for direct unit coverage)
// ---------------------------------------------------------------------------

// scripts/run-tests.js prints exactly:
//   Summary: <passed> passed, <failed> failed (of <total> total)
// and, when anything failed, a following line:
//   Failed: a.js, b.js
const SUMMARY_RE = /^Summary: (\d+) passed, (\d+) failed \(of (\d+) total\)$/m;
const FAILED_LIST_RE = /^Failed: (.+)$/m;

/**
 * Parses an inner run-tests.js run's combined output.
 * Returns `{ ok: false, reason }` when no summary line is present at all —
 * which is itself a red (a crashed or truncated runner), never a pass.
 */
function parseSuiteSummary(output) {
  const match = SUMMARY_RE.exec(String(output));
  if (!match) {
    return { ok: false, reason: 'no "Summary: N passed, M failed (of T total)" line found in the inner suite output' };
  }
  const passed = Number(match[1]);
  const failed = Number(match[2]);
  const total = Number(match[3]);
  const failedMatch = FAILED_LIST_RE.exec(String(output));
  const failedFiles = failedMatch
    ? failedMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    ok: true,
    passed,
    failed,
    total,
    failedFiles,
    summaryLine: match[0],
    green: total > 0 && failed === 0 && passed === total,
  };
}

/** Counts `scripts/test-*.js` files directly inside an assembled tree. */
function countAssembledTestFiles(assembledDir) {
  const scriptsDir = path.join(assembledDir, 'scripts');
  let entries;
  try {
    entries = fs.readdirSync(scriptsDir);
  } catch {
    return 0;
  }
  return entries.filter((name) => name.startsWith('test-') && name.endsWith('.js')).length;
}

function countFilesRecursive(dir) {
  let count = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        walk(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return count;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

let tempRootForCleanup = null;
let keepTempRoot = false;
process.on('exit', () => {
  if (tempRootForCleanup && !keepTempRoot) {
    fs.rmSync(tempRootForCleanup, { recursive: true, force: true });
  }
});

function gitInTree(cwd, args) {
  // Identity pinned on the command line so this works on a machine (or CI
  // runner) with no global git identity at all — `-c` counts as configuration
  // even under user.useConfigOnly=true, which scripts/run-tests.js sets for
  // every child it spawns.
  return execFileSync(
    'git',
    ['-c', 'user.name=Assembled Suite Check', '-c', 'user.email=assembled-suite@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function assertCleanSourceRepo() {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch (err) {
    fail(`could not read git status of the source repo at ${REPO_ROOT}: ${err.message}`);
    return;
  }
  if (status.trim().length > 0) {
    console.error('\nDirty source repo (uncommitted or untracked changes):');
    console.error(status);
    fail(
      'the receipt this script writes names a COMMIT, so it must be produced from a tree that matches ' +
        'one — commit or stash first. (mavp-publish-build.js refuses on a dirty source repo for the same ' +
        'reason, so a receipt earned here would be unusable there anyway.)'
    );
  }
}

function main() {
  keepTempRoot = process.argv.slice(2).includes('--keep');

  log('=== check-assembled-suite: running the SHIPPED suite in a mirror-shaped assembled tree ===');
  log(`Source repo: ${REPO_ROOT}`);

  assertCleanSourceRepo();

  const head = headCommitOf(REPO_ROOT);
  if (!head) {
    fail(
      `could not resolve HEAD in ${REPO_ROOT} (not a git repository, or git unavailable) — a receipt with ` +
        'no commit to bind to would be worthless, so nothing is written.'
    );
    return;
  }
  log(`Source HEAD: ${head}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-assembled-suite-'));
  tempRootForCleanup = tempRoot;
  const assembledDir = path.join(tempRoot, 'tree');
  // The log lives OUTSIDE the assembled tree on purpose: writing it inside
  // would add a file the assembler never produced, which several shipped
  // tests (and the assembler's own completeness contract) would see.
  const logPath = path.join(tempRoot, 'inner-suite.log');

  log('\n=== Step 1/5: assemble the mirror-shaped tree ===');
  const assembleResult = spawnSync(process.execPath, [ASSEMBLE_SCRIPT, assembledDir], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (assembleResult.error || assembleResult.status !== 0) {
    fail(`assemble step failed (${assembleResult.error ? assembleResult.error.message : `exit ${assembleResult.status}`}).`);
  }

  const assembledFileCount = countFilesRecursive(assembledDir);
  const assembledTestFiles = countAssembledTestFiles(assembledDir);
  log(`\nAssembled tree: ${assembledFileCount} file(s), ${assembledTestFiles} scripts/test-*.js file(s).`);
  if (assembledTestFiles === 0) {
    fail(
      'the assembled tree contains ZERO scripts/test-*.js files — there is no suite to run there, so a ' +
        'green result would certify nothing. Refusing to write a receipt.'
    );
  }

  log('\n=== Step 2/5: make the assembled tree a real git repo (one commit) ===');
  // Several shipped tests clone their own REPO_ROOT or shell out to
  // `git ls-files` against it; in a plain directory they fail for reasons that
  // have nothing to do with the mirror. The mirror IS a git repo, so this is
  // the shape that reproduces it.
  try {
    gitInTree(assembledDir, ['init', '-q', '-b', 'main']);
    gitInTree(assembledDir, ['add', '-A']);
    gitInTree(assembledDir, ['commit', '-q', '-m', 'assembled tree under test']);
  } catch (err) {
    fail(`could not initialise a git repo in the assembled tree: ${err.stderr || err.message}`);
  }
  const innerHead = headCommitOf(assembledDir);
  log(`Assembled tree committed at ${innerHead}.`);

  log('\n=== Step 3/5: run the ASSEMBLED tree\'s own scripts/run-tests.js ===');
  const innerRunTests = path.join(assembledDir, 'scripts', 'run-tests.js');
  if (!fs.existsSync(innerRunTests)) {
    fail(`the assembled tree has no scripts/run-tests.js at ${innerRunTests} — nothing to run.`);
  }
  log(`This takes several minutes. Live output: tail -f ${logPath}`);
  const logFd = fs.openSync(logPath, 'w');
  let innerResult;
  try {
    innerResult = spawnSync(process.execPath, [innerRunTests], {
      cwd: assembledDir,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  const innerOutput = fs.readFileSync(logPath, 'utf8');
  log('\n--- inner suite output ---');
  log(innerOutput.trimEnd());
  log('--- end inner suite output ---');
  if (innerResult.error) {
    fail(`could not run the assembled tree's run-tests.js: ${innerResult.error.message}`);
  }

  log('\n=== Step 4/5: parse the summary + anti-vacuity assertions ===');
  const parsed = parseSuiteSummary(innerOutput);
  if (!parsed.ok) {
    fail(
      `${parsed.reason} (runner exit ${innerResult.status}). The full inner output is above and at ` +
        `${logPath}. A run whose summary cannot be read is a RED, never a pass.`
    );
    return;
  }
  log(`Inner summary: ${parsed.summaryLine} (runner exit ${innerResult.status})`);

  // Anti-vacuity: a green summary over a subset (or over nothing) is the exact
  // fail-open shape this whole mechanism exists to remove, so the count the
  // runner reports is checked against the test files actually present in the
  // tree — not merely trusted.
  if (parsed.total < assembledTestFiles) {
    fail(
      `ANTI-VACUITY: the inner suite reported ${parsed.total} test file(s) but the assembled tree contains ` +
        `${assembledTestFiles} scripts/test-*.js file(s) — the run did not cover the shipped suite ` +
        '(a filter, a discovery regression, or a truncated run). Refusing to write a receipt.'
    );
  }
  log(`Anti-vacuity OK: reported total ${parsed.total} >= ${assembledTestFiles} assembled test file(s).`);

  if (!parsed.green || innerResult.status !== 0) {
    console.error('\nThe SHIPPED suite is NOT green in the assembled (mirror-shaped) tree.');
    if (parsed.failedFiles.length > 0) {
      console.error(`Failing test file(s) (${parsed.failedFiles.length}):`);
      for (const file of parsed.failedFiles) {
        console.error(`  - ${file}`);
      }
    }
    console.error(`\nAssembled tree kept for inspection: ${assembledDir}`);
    console.error(`Inner suite log: ${logPath}`);
    keepTempRoot = true; // never delete the evidence of a red run
    fail(
      `${parsed.summaryLine} — this is exactly what the public mirror's CI would report after a push. ` +
        'Fix the failing test(s) so they hold in BOTH environment classes (canonical repo AND ' +
        'mirror-shaped assembled tree), then re-run this script. No receipt was written.'
    );
    return;
  }

  log('\n=== Step 5/5: write the receipt ===');
  const { receipt, receiptPath } = writeReceipt(REPO_ROOT, {
    commit: head,
    suite: { total: parsed.total, passed: parsed.passed, failed: parsed.failed },
    summaryLine: parsed.summaryLine,
    assembledTestFiles,
    assembledFileCount,
    note: 'green run of the shipped suite inside a mirror-shaped assembled tree',
  });
  log(`Receipt written: ${receiptPath}`);
  log(JSON.stringify(receipt, null, 2));
  log(
    `\nGREEN. ${parsed.summaryLine} in the assembled tree at commit ${head}. ` +
      'mavp-publish-build.js will accept this receipt until the next commit.'
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  RECEIPT_RELATIVE_PATH,
  RECEIPT_SCHEMA,
  CHECK_COMMAND,
  receiptPathFor,
  readReceipt,
  writeReceipt,
  writeReceiptForHead,
  headCommitOf,
  parseSuiteSummary,
  countAssembledTestFiles,
};
