'use strict';
// Regression test: T-422/T-423 — opt-in session-transcript archive sweep +
// bounded retention pruning.
//
// scripts/mavp-transcript-archive.js sweeps every *.jsonl transcript from a
// (derived-from-cwd, env-overridable) source dir into a destination archive
// dir, copying a file when the archived copy is absent or the source is
// newer (by mtime), and never deleting an archive-only file during the copy
// phase. T-423 adds an opt-in MAVP_TRANSCRIPT_RETENTION_DAYS env var that
// prunes archived (destDir-only) files older than N days; default (unset)
// is unlimited — nothing is ever deleted.
//
// This test seeds a fixture source dir with two transcripts:
//   - A.jsonl — not yet archived (no A.jsonl in the dest dir)
//   - B.jsonl — already archived, with identical mtime/content in both dirs
// and asserts:
//   1. one sweep run copies exactly A.jsonl (stdout shows exactly one
//      "archived" line, naming A.jsonl) and skips B.jsonl (no output for it)
//   2. the sweep always exits 0
//   3. a second identical run copies nothing (stdout is empty — idempotent)
//   4. a transcript present only in the archive (no matching source file) is
//      never deleted by any sweep run
//   5. (T-423) with MAVP_TRANSCRIPT_RETENTION_DAYS=N and an archive
//      containing one file older than N days and one newer, a sweep run
//      deletes only the older file (quoted before/after listing)
//   6. (T-423) with retention unset (default), nothing is ever deleted, even
//      when an archived file is very old
//
// Plain node, no npm deps.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'mavp-transcript-archive.js');

function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runSweep(sourceDir, destDir, retentionDays) {
  const env = Object.assign({}, process.env, {
    MAVP_TRANSCRIPT_SOURCE_DIR: sourceDir,
    MAVP_TRANSCRIPT_DEST_DIR: destDir,
  });
  if (retentionDays === undefined) {
    delete env.MAVP_TRANSCRIPT_RETENTION_DAYS;
  } else {
    env.MAVP_TRANSCRIPT_RETENTION_DAYS = String(retentionDays);
  }
  return execFileSync('node', [SCRIPT], { encoding: 'utf8', env });
}

const cleanupDirs = [];

try {
  // ============================================================
  // Fixture setup
  // ============================================================
  const sourceDir = makeScratchDir('mavp-ta-source-');
  const destDir = makeScratchDir('mavp-ta-dest-');
  cleanupDirs.push(sourceDir, destDir);

  const aPath = path.join(sourceDir, 'A.jsonl');
  const bSrcPath = path.join(sourceDir, 'B.jsonl');
  const bDestPath = path.join(destDir, 'B.jsonl');

  fs.writeFileSync(aPath, '{"session":"A"}\n', 'utf8');
  fs.writeFileSync(bSrcPath, '{"session":"B"}\n', 'utf8');
  fs.writeFileSync(bDestPath, '{"session":"B"}\n', 'utf8');

  // B is "already archived": give source and dest copies the exact same
  // mtime (fractional-second precision, matching what the sweep itself
  // writes after a copy) so the sweep recognizes it as unchanged.
  const bMtimeSeconds = 1704067200.123456; // 2024-01-01T00:00:00.123456Z
  fs.utimesSync(bSrcPath, bMtimeSeconds, bMtimeSeconds);
  fs.utimesSync(bDestPath, bMtimeSeconds, bMtimeSeconds);

  // ============================================================
  // Assertion 1 + 2: first sweep copies A, skips B, exits 0
  // ============================================================
  const firstRunStdout = runSweep(sourceDir, destDir);
  const firstRunLines = firstRunStdout.split('\n').filter(l => l.trim().length > 0);

  assert.strictEqual(
    firstRunLines.length,
    1,
    `FAIL: expected exactly one "archived" line, got ${firstRunLines.length}: ${JSON.stringify(firstRunLines)}`
  );
  assert.ok(
    firstRunLines[0].includes('archived A.jsonl'),
    `FAIL: expected the one copy line to name A.jsonl, got: ${firstRunLines[0]}`
  );
  assert.ok(
    !firstRunStdout.includes('B.jsonl'),
    'FAIL: B.jsonl (already archived) should not appear in sweep output'
  );
  assert.ok(fs.existsSync(path.join(destDir, 'A.jsonl')), 'FAIL: A.jsonl was not copied into the archive');
  console.log(`Assertion 1 passed — quoted run output:\n${firstRunStdout.trimEnd()}`);
  console.log('Assertion 2 passed: sweep exited 0 (execFileSync would have thrown otherwise)');

  // ============================================================
  // Assertion 3: second identical run is idempotent — copies nothing
  // ============================================================
  const secondRunStdout = runSweep(sourceDir, destDir);
  assert.strictEqual(
    secondRunStdout.trim(),
    '',
    `FAIL: second identical sweep run should copy nothing (idempotent), got: ${JSON.stringify(secondRunStdout)}`
  );
  console.log('Assertion 3 passed — second identical run output: "" (nothing copied, idempotent)');

  // ============================================================
  // Assertion 4: an archive-only transcript (no matching source) survives
  // ============================================================
  const orphanPath = path.join(destDir, 'C-orphan.jsonl');
  fs.writeFileSync(orphanPath, '{"session":"C-orphan, source already cleaned up"}\n', 'utf8');
  assert.ok(fs.existsSync(orphanPath), 'sanity: orphan file was created');

  runSweep(sourceDir, destDir);
  assert.ok(
    fs.existsSync(orphanPath),
    'FAIL: an archive-only transcript (no matching source file) was deleted by the sweep — v1 must never prune'
  );
  console.log('Assertion 4 passed: archive-only transcript (no matching source) was not deleted by the sweep');

  // ============================================================
  // Assertion 5 (T-423): retention=N days deletes only the older file
  // ============================================================
  const retentionSourceDir = makeScratchDir('mavp-ta-ret-source-');
  const retentionDestDir = makeScratchDir('mavp-ta-ret-dest-');
  cleanupDirs.push(retentionSourceDir, retentionDestDir);

  const oldPath = path.join(retentionDestDir, 'OLD.jsonl');
  const newPath = path.join(retentionDestDir, 'NEW.jsonl');
  fs.writeFileSync(oldPath, '{"session":"OLD"}\n', 'utf8');
  fs.writeFileSync(newPath, '{"session":"NEW"}\n', 'utf8');

  const nowSeconds = Date.now() / 1000;
  const oldMtimeSeconds = nowSeconds - 40 * 24 * 60 * 60; // 40 days old
  const newMtimeSeconds = nowSeconds - 2 * 24 * 60 * 60; // 2 days old
  fs.utimesSync(oldPath, oldMtimeSeconds, oldMtimeSeconds);
  fs.utimesSync(newPath, newMtimeSeconds, newMtimeSeconds);

  const retentionBeforeListing = fs.readdirSync(retentionDestDir).sort();
  assert.deepStrictEqual(
    retentionBeforeListing,
    ['NEW.jsonl', 'OLD.jsonl'],
    `FAIL: retention fixture setup unexpected, got: ${JSON.stringify(retentionBeforeListing)}`
  );

  const retentionRunStdout = runSweep(retentionSourceDir, retentionDestDir, 30);
  const retentionAfterListing = fs.readdirSync(retentionDestDir).sort();

  console.log(
    `Assertion 5 — retention=30d run — before: ${JSON.stringify(retentionBeforeListing)} -> after: ${JSON.stringify(retentionAfterListing)}\n` +
    `  quoted run output:\n${retentionRunStdout.trimEnd()}`
  );

  assert.deepStrictEqual(
    retentionAfterListing,
    ['NEW.jsonl'],
    `FAIL: retention=30d sweep should delete only OLD.jsonl (40d old) and keep NEW.jsonl (2d old), got: ${JSON.stringify(retentionAfterListing)}`
  );
  assert.ok(
    retentionRunStdout.includes('pruned OLD.jsonl'),
    `FAIL: expected stdout to report pruning OLD.jsonl, got: ${JSON.stringify(retentionRunStdout)}`
  );
  assert.ok(
    !retentionRunStdout.includes('NEW.jsonl'),
    `FAIL: NEW.jsonl (within retention) should not appear in prune output, got: ${JSON.stringify(retentionRunStdout)}`
  );
  console.log('Assertion 5 passed: retention=30d sweep deleted only the older-than-retention file, kept the newer one');

  // ============================================================
  // Assertion 6 (T-423): retention unset (default) never deletes anything,
  // even a very old archived file
  // ============================================================
  const noRetentionSourceDir = makeScratchDir('mavp-ta-noret-source-');
  const noRetentionDestDir = makeScratchDir('mavp-ta-noret-dest-');
  cleanupDirs.push(noRetentionSourceDir, noRetentionDestDir);

  const veryOldPath = path.join(noRetentionDestDir, 'VERY-OLD.jsonl');
  fs.writeFileSync(veryOldPath, '{"session":"VERY-OLD"}\n', 'utf8');
  const veryOldMtimeSeconds = nowSeconds - 400 * 24 * 60 * 60; // 400 days old
  fs.utimesSync(veryOldPath, veryOldMtimeSeconds, veryOldMtimeSeconds);

  const noRetentionBeforeListing = fs.readdirSync(noRetentionDestDir).sort();
  const noRetentionRunStdout = runSweep(noRetentionSourceDir, noRetentionDestDir); // no retentionDays arg -> env unset
  const noRetentionAfterListing = fs.readdirSync(noRetentionDestDir).sort();

  console.log(
    `Assertion 6 — retention unset (default) run — before: ${JSON.stringify(noRetentionBeforeListing)} -> after: ${JSON.stringify(noRetentionAfterListing)}\n` +
    `  quoted run output: ${JSON.stringify(noRetentionRunStdout)}`
  );

  assert.deepStrictEqual(
    noRetentionAfterListing,
    noRetentionBeforeListing,
    `FAIL: with retention unset, nothing should ever be deleted, got before: ${JSON.stringify(noRetentionBeforeListing)}, after: ${JSON.stringify(noRetentionAfterListing)}`
  );
  assert.ok(fs.existsSync(veryOldPath), 'FAIL: a 400-day-old archived file was deleted despite retention being unset (default must be unlimited)');
  console.log('Assertion 6 passed: retention unset (default) deleted nothing, even a 400-day-old archived file');

  console.log('\nAll T-422/T-423 transcript-archive sweep + retention assertions passed.');
} finally {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
