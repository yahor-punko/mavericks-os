#!/usr/bin/env node

/**
 * mavp-operator-doc-sync-check.js
 *
 * Advisory script: for each recently merged task (up to 10), checks whether
 * source files touched by that task's commit have candidate documentation
 * entries in docs/. Emits advisory lines to stderr. Always exits 0.
 *
 * Stateless — no ledger files, no state written.
 *
 * Called automatically by the PostToolUse hook when TASK_STATUS.md is edited.
 * Also runnable directly:
 *   node scripts/mavp-operator-doc-sync-check.js
 *
 * Exit 0 always — non-fatal. Advisories go to stderr.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const DOCS_DIR = path.join(ROOT, 'docs');

// File path patterns to exclude from source-file detection (not interesting for doc impact)
const EXCLUDED_PATTERNS = [
  /^docs\//,
  /\.md$/i,
  /^BACKLOG\.md$/i,
  /^TASK_STATUS\.md$/i,
  /^PROCESS_STATE/i,
  /^\.claude\//,
];

/**
 * Parse all task blocks from a markdown string.
 * Each block starts with ### T-NNN.
 *
 * @param {string} markdown
 * @returns {string[]} array of raw block strings
 */
function parseAllTaskBlocks(markdown) {
  return markdown
    .split(/\n(?=###\s+T-\d+)/)
    .map((block) => block.trim())
    .filter((block) => /^###\s+T-\d+/.test(block));
}

/**
 * Run a shell command synchronously and return its stdout.
 * Returns null if the command fails or times out.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function runSync(cmd, args, cwd) {
  try {
    const result = cp.spawnSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: 8000,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    return result.stdout || '';
  } catch {
    return null;
  }
}

/**
 * Determine whether a file path should be excluded from doc-sync analysis.
 *
 * @param {string} filePath - relative path from git root
 * @returns {boolean}
 */
function isExcluded(filePath) {
  return EXCLUDED_PATTERNS.some((pat) => pat.test(filePath));
}

/**
 * Recursively list all markdown files under a directory.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Search for a basename in a list of doc files.
 * Returns the set of doc paths (relative to ROOT) that mention the basename.
 *
 * @param {string} basename
 * @param {string[]} docFiles - absolute paths
 * @returns {string[]}
 */
function findCandidateDocs(basename, docFiles) {
  const candidates = [];
  for (const docFile of docFiles) {
    let content;
    try {
      content = fs.readFileSync(docFile, 'utf8');
    } catch {
      continue;
    }
    if (content.includes(basename)) {
      candidates.push(path.relative(ROOT, docFile));
    }
  }
  return candidates;
}

function main() {
  // Read TASK_STATUS.md
  if (!fs.existsSync(TASK_STATUS_MD)) {
    process.stderr.write('doc-sync: TASK_STATUS.md not found at ' + TASK_STATUS_MD + '\n');
    process.exit(0);
  }

  let taskStatusContent;
  try {
    taskStatusContent = fs.readFileSync(TASK_STATUS_MD, 'utf8');
  } catch (e) {
    process.stderr.write('doc-sync: failed to read TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  // Parse all task blocks
  let blocks;
  try {
    blocks = parseAllTaskBlocks(taskStatusContent);
  } catch (e) {
    process.stderr.write('doc-sync: failed to parse TASK_STATUS.md — ' + e.message + '\n');
    process.exit(0);
  }

  // Select merged tasks with a parseable commit: hash
  // Skip type: docs and type: chore
  const SKIP_TYPES = new Set(['docs', 'chore']);
  const mergedTasks = [];

  for (const block of blocks) {
    // Extract task ID
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    // Check status
    const statusMatch = block.match(/[-*]\s+\*\*Status:\*\*\s+(\S+)/i);
    if (!statusMatch) continue;
    const status = statusMatch[1].trim();
    if (status !== 'merged') continue;

    // Skip type: docs or type: chore
    const typeMatch = block.match(/[-*]\s+\*\*Type:\*\*\s+(\S+)/i);
    if (typeMatch) {
      const taskType = typeMatch[1].trim().toLowerCase();
      if (SKIP_TYPES.has(taskType)) continue;
    }

    // Parse commit hash from evidence
    // Format: commit: <hash> (with optional trailing text)
    const commitMatch = block.match(/\bcommit:\s+([0-9a-f]{6,40})\b/i);
    if (!commitMatch) continue;
    const commitHash = commitMatch[1];

    mergedTasks.push({ taskId, commitHash, block });
  }

  // Cap at 10 most recently merged (last 10 in file order, which is newest-first in TASK_STATUS.md)
  const recentTasks = mergedTasks.slice(0, 10);

  if (recentTasks.length === 0) {
    // Nothing to check — silent success
    process.exit(0);
  }

  // Pre-load list of doc files once
  const docFiles = listMarkdownFiles(DOCS_DIR);

  for (const { taskId, commitHash, block: _block } of recentTasks) {
    // Get list of files changed in the commit
    const shortHash = commitHash.slice(0, 7);
    const gitOutput = runSync('git', ['show', '--name-only', '--format=', commitHash], ROOT);

    if (gitOutput === null) {
      process.stderr.write(
        'doc-sync: ' + taskId + ' commit ' + shortHash + ' not resolvable — skipping\n'
      );
      continue;
    }

    // Parse changed files (non-empty lines after the empty format header)
    const changedFiles = gitOutput
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Filter: drop excluded patterns
    const sourceFiles = changedFiles.filter((f) => !isExcluded(f));

    if (sourceFiles.length === 0) {
      // Only docs/config/state files changed — no advisory needed
      continue;
    }

    // For each source file, check for candidate docs
    // Collect all unique candidates across all source files, keyed to which file triggered them
    const advisories = [];

    for (const sourceFile of sourceFiles) {
      const basename = path.basename(sourceFile);
      const candidates = findCandidateDocs(basename, docFiles);

      if (candidates.length > 0) {
        advisories.push(
          'doc-sync: ' + taskId + ' merged (commit ' + shortHash + ') touched ' + basename +
          ' — candidate docs: ' + candidates.join(', ') + '. Review before close.'
        );
      } else {
        advisories.push(
          'doc-sync: ' + taskId + ' merged (commit ' + shortHash + ') touched ' + basename +
          ' — no obvious doc reference found. Confirm no doc impact.'
        );
      }
    }

    // Deduplicate and emit
    const seen = new Set();
    for (const line of advisories) {
      if (!seen.has(line)) {
        seen.add(line);
        process.stderr.write(line + '\n');
      }
    }
  }

  process.exit(0);
}

main();
