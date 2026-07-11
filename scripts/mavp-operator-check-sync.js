#!/usr/bin/env node
// MAVERICKS_VERSION: 0.2.1

/**
 * mavp-operator-check-sync.js
 *
 * Compares key mavericks files (agent specs, skills) in known bootstrapped
 * projects against the mavericks source installation.
 *
 * Project discovery order:
 *   1. MAVERICKS_PROJECTS env var — colon-separated absolute paths
 *   2. A projects list file at $MAVERICKS_PROJECT_ROOT/PROJECTS (one path per line)
 *   3. Scan ~/Documents and ~/projects for directories containing
 *      scripts/mavp-operator wrapper files
 *
 * Usage: ./scripts/mavp-operator --check-sync
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const MAVERICKS_ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');

// Files to compare between mavericks source and each project
// Paths are relative to the project/mavericks root
const SYNC_TARGETS = [
  { src: '.claude/agents', ext: '.md', label: 'agents' },
  { src: '.claude/skills', ext: null, label: 'skills', optional: true },
];

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function fileHash(filePath) {
  try {
    return md5(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

/**
 * Walk a directory and return relative paths of all files (recursively).
 * Returns [] if the directory does not exist.
 */
function walkDir(dirPath, ext) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) return results;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    // Skip dotfiles/OS junk (e.g. .DS_Store, Thumbs.db) — never part of the synced set.
    // These live on disk but are not git-tracked, so they would surface as false-positive drift.
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(fullPath).isDirectory());
    if (isDir) {
      const sub = walkDir(fullPath, ext);
      for (const s of sub) {
        results.push(path.join(entry.name, s));
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!ext || entry.name.endsWith(ext)) {
        results.push(entry.name);
      }
    }
  }
  return results;
}

/**
 * Compare a single sync target (e.g. .claude/agents) between mavericks source
 * and a project directory.
 * Returns array of { file, reason } for drifted files.
 */
function compareSyncTarget(target, mavRoot, projectRoot) {
  const srcDir = path.join(mavRoot, target.src);
  const dstDir = path.join(projectRoot, target.src);

  if (!fs.existsSync(srcDir)) return [];

  const srcFiles = walkDir(srcDir, target.ext);
  if (srcFiles.length === 0) return [];

  const drifted = [];

  for (const relFile of srcFiles) {
    const srcPath = path.join(srcDir, relFile);
    const dstPath = path.join(dstDir, relFile);

    if (!fs.existsSync(dstPath)) {
      drifted.push({ file: path.join(target.src, relFile), reason: 'missing in project' });
      continue;
    }

    const srcHash = fileHash(srcPath);
    const dstHash = fileHash(dstPath);
    if (srcHash && dstHash && srcHash !== dstHash) {
      drifted.push({ file: path.join(target.src, relFile), reason: 'content differs' });
    }
  }

  return drifted;
}

/**
 * Determine if a directory looks like a bootstrapped mavericks project.
 * Heuristic: contains scripts/mavp-operator (the bash wrapper).
 */
function isBootstrappedProject(dir) {
  try {
    const wrapperPath = path.join(dir, 'scripts', 'mavp-operator');
    if (!fs.existsSync(wrapperPath)) return false;
    const content = fs.readFileSync(wrapperPath, 'utf8');
    return content.includes('MAVERICKS_PROJECT_ROOT') || content.includes('mavp-operator');
  } catch {
    return false;
  }
}

/**
 * Scan a search root (e.g. ~/Documents) for bootstrapped projects.
 * Checks immediate subdirectories only (depth 1).
 */
function scanForProjects(searchRoot) {
  const found = [];
  if (!fs.existsSync(searchRoot)) return found;

  try {
    const entries = fs.readdirSync(searchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join(searchRoot, entry.name);
      // Skip the mavericks installation itself
      if (candidatePath === MAVERICKS_ROOT) continue;
      if (isBootstrappedProject(candidatePath)) {
        found.push(candidatePath);
      }
    }
  } catch {
    // Permission denied or other error — skip
  }

  return found;
}

/**
 * Discover project paths to check.
 * Returns an array of absolute path strings (deduplicated).
 */
function discoverProjects() {
  // 1. MAVERICKS_PROJECTS env var
  if (process.env.MAVERICKS_PROJECTS) {
    const paths = process.env.MAVERICKS_PROJECTS.split(':')
      .map(p => p.trim())
      .filter(Boolean);
    if (paths.length > 0) return [...new Set(paths)];
  }

  // 2. Projects list file
  const projectsListPath = path.join(MAVERICKS_ROOT, 'PROJECTS');
  if (fs.existsSync(projectsListPath)) {
    try {
      const paths = fs.readFileSync(projectsListPath, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      if (paths.length > 0) return [...new Set(paths)];
    } catch {
      // Fall through to scanning
    }
  }

  // 3. Scan common locations
  const scanRoots = [
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'dev'),
    path.join(os.homedir(), 'workspace'),
  ];

  const found = [];
  for (const scanRoot of scanRoots) {
    for (const p of scanForProjects(scanRoot)) {
      found.push(p);
    }
  }

  return [...new Set(found)];
}

function checkProject(projectPath) {
  const drifted = [];
  for (const target of SYNC_TARGETS) {
    const srcDir = path.join(MAVERICKS_ROOT, target.src);
    if (!fs.existsSync(srcDir) && target.optional) continue;
    const results = compareSyncTarget(target, MAVERICKS_ROOT, projectPath);
    drifted.push(...results);
  }
  return drifted;
}

function main() {
  console.log(`\n${BOLD}MavP Check-Sync${RESET} ${DIM}comparing against ${MAVERICKS_ROOT}${RESET}\n`);

  const projects = discoverProjects();

  if (projects.length === 0) {
    console.log(`${YELLOW}No bootstrapped projects found.${RESET}`);
    console.log(`${DIM}Set MAVERICKS_PROJECTS=<path1>:<path2> to specify projects explicitly,`);
    console.log(`or create ${MAVERICKS_ROOT}/PROJECTS with one path per line.${RESET}\n`);
    return;
  }

  console.log(`${DIM}Checking ${projects.length} project(s)...${RESET}\n`);

  let anyDrift = false;

  for (const projectPath of projects) {
    const label = path.relative(os.homedir(), projectPath) || projectPath;
    const drifted = checkProject(projectPath);

    if (drifted.length === 0) {
      console.log(`${GREEN}✓ ${BOLD}${label}${RESET}${GREEN} — all in sync${RESET}`);
    } else {
      anyDrift = true;
      console.log(`${RED}✗ ${BOLD}${label}${RESET}${RED} — ${drifted.length} file(s) drifted:${RESET}`);
      for (const item of drifted) {
        console.log(`  ${YELLOW}${item.file}${RESET} ${DIM}(${item.reason})${RESET}`);
      }
    }
  }

  console.log('');

  if (!anyDrift) {
    console.log(`${GREEN}${BOLD}All projects in sync.${RESET}\n`);
  } else {
    console.log(`${YELLOW}Run ${BOLD}./scripts/mavp-operator --install --update <project-path>${RESET}${YELLOW} to resync a drifted project.${RESET}\n`);
  }
}

main();
