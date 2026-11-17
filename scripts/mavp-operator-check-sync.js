#!/usr/bin/env node

/**
 * mavp-operator-check-sync.js
 *
 * Compares key mavericks files (agent specs, skills) in known bootstrapped
 * projects against the mavericks source installation.
 *
 * Framework root (T-894): the checkout this script lives in, unless
 * MAVERICKS_PROJECT_ROOT names a framework source tree (one holding
 * scripts/mavp-operator-lib.js). An adopter wrapper exports that variable as
 * the ADOPTER project root, so a root without the lib file is treated as a
 * project to check (listed first), never as the framework.
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

const { composePostToolUseHookCommand, isManagedPostToolUseCommand } = require('./mavp-install.js');
const { findClaudeMdOnDemandDuplicates, isFrameworkSourceTree, handleHelpFlag } = require('./mavp-operator-lib.js');

/**
 * Resolve the framework root --check-sync compares against (T-894).
 * `envRoot` is MAVERICKS_PROJECT_ROOT as the caller found it; it names the
 * framework only when it is a framework source tree. Otherwise it is an adopter
 * project root and the framework is the checkout this script lives in.
 * Returns { frameworkRoot, adopterRoot } with adopterRoot null when envRoot is
 * unset or is the framework itself.
 */
function resolveFrameworkRoot(envRoot, scriptRoot) {
  if (!envRoot) return { frameworkRoot: scriptRoot, adopterRoot: null };
  const resolved = path.resolve(envRoot);
  if (isFrameworkSourceTree(resolved)) return { frameworkRoot: resolved, adopterRoot: null };
  return { frameworkRoot: scriptRoot, adopterRoot: resolved === scriptRoot ? null : resolved };
}

const ROOTS = resolveFrameworkRoot(process.env.MAVERICKS_PROJECT_ROOT, path.resolve(__dirname, '..'));
const MAVERICKS_ROOT = ROOTS.frameworkRoot;

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
 * Read MAVERICKS_VERSION from a mavericks root's scripts/mavp-version.js.
 * Returns null if the file is missing, unreadable, or doesn't export the field.
 */
function readMaverticksVersion(root) {
  try {
    const versionFilePath = path.join(root, 'scripts', 'mavp-version.js');
    if (!fs.existsSync(versionFilePath)) return null;
    const resolved = require.resolve(versionFilePath);
    delete require.cache[resolved];
    const mod = require(resolved);
    return mod && typeof mod.MAVERICKS_VERSION === 'string' ? mod.MAVERICKS_VERSION : null;
  } catch {
    return null;
  }
}

/**
 * Compare a ~/.mavericks checkout's version against the canonical repo's version.
 * Pure/parameterized so it can be exercised against a fixture path in tests.
 * Returns { homeVersion, canonicalVersion, homePath } when drifted, or null when
 * versions match, the home checkout doesn't exist, or its version is unreadable.
 */
function checkHomeMavericksDrift(canonicalRoot, homeMavericksPath) {
  if (!fs.existsSync(homeMavericksPath)) return null;

  const homeVersion = readMaverticksVersion(homeMavericksPath);
  if (!homeVersion) return null;

  const canonicalVersion = readMaverticksVersion(canonicalRoot);
  if (!canonicalVersion) return null;

  if (homeVersion === canonicalVersion) return null;

  return { homeVersion, canonicalVersion, homePath: homeMavericksPath };
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

/**
 * Read and JSON-parse a project's .claude/settings.local.json.
 * Returns null when the file is missing or malformed — callers treat that as
 * "skip, no error", never as drift.
 */
function readSettingsLocal(projectPath) {
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Detect a stale/naive managed PostToolUse hook (T-441) — the source of the
 * false "blocking error" noise reported from the field. A naive/pre-hardening
 * hook lacks the file-path filter, debounce, and unconditional advisory
 * exit-0 that the current composePostToolUseHookCommand() produces.
 *
 * Identity: isManagedPostToolUseCommand() (imported from mavp-install.js) —
 * the same check --update uses to find "the mavp hook" among a project's
 * PostToolUse entries, however stale its body is.
 *
 * Returns:
 *   null                          — no settings file, malformed JSON, or no
 *                                    managed entry found. Skip silently, not
 *                                    an error.
 *   { stale: false }              — managed entry present and byte-identical
 *                                    to the freshly composed command.
 *   { stale: true, current, expected } — managed entry present but differs.
 */
function checkHookDrift(projectPath) {
  const settingsLocal = readSettingsLocal(projectPath);
  if (!settingsLocal) return null;

  const postToolUse = settingsLocal.hooks && settingsLocal.hooks.PostToolUse;
  if (!Array.isArray(postToolUse)) return null;

  let managedCommand = null;
  for (const entry of postToolUse) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && isManagedPostToolUseCommand(h.command)) {
        managedCommand = h.command;
      }
    }
  }
  if (managedCommand === null) return null;

  const expected = composePostToolUseHookCommand(projectPath);
  if (managedCommand === expected) return { stale: false };
  return { stale: true, current: managedCommand, expected };
}

/** Compress sorted line numbers into "3-5, 9" style ranges. */
function formatLineRanges(lines) {
  const out = [];
  let start = null;
  let prev = null;
  for (const n of lines) {
    if (start === null) {
      start = n;
    } else if (n !== prev + 1) {
      out.push(start === prev ? String(start) : `${start}-${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null) out.push(start === prev ? String(start) : `${start}-${prev}`);
  return out.join(', ');
}

/**
 * Render the CLAUDE.md on-demand-duplicate advisory (T-894) as plain output
 * lines (no colour). Reads only the result of findClaudeMdOnDemandDuplicates():
 * line numbers, character counts and framework file paths. It never prints
 * project text, and the advisory is informational only: it edits nothing and
 * never changes the exit code or the in-sync summary.
 */
function renderClaudeMdDuplicateLines(result) {
  if (!result) return [];
  if (result.skipped) return [`CLAUDE.md check skipped (${result.skipped})`];
  if (result.matches.length === 0) {
    return [`CLAUDE.md: no duplicated on-demand text (${result.claude_md_chars} chars, ${result.always_loaded_chars} always loaded)`];
  }
  const lines = [
    `CLAUDE.md: ${result.claude_md_chars} chars (${result.always_loaded_chars} always loaded); ` +
    `removable now ${result.removable_now_chars} chars, after update ${result.removable_after_update_chars} chars`,
  ];
  const groups = new Map();
  for (const m of result.matches) {
    const key = `${m.home}\u0000${m.state}`;
    if (!groups.has(key)) groups.set(key, { home: m.home, state: m.state, lines: [] });
    groups.get(key).lines.push(m.line);
  }
  for (const g of groups.values()) {
    const word = g.lines.length === 1 ? 'line' : 'lines';
    lines.push(`  ${g.home} — ${g.state} — CLAUDE.md ${word} ${formatLineRanges(g.lines)}`);
  }
  lines.push(
    '  Nothing is edited here. Judge a removal with --check-archive: it counts a removed CLAUDE.md line as missing ' +
    'unless that line is archived verbatim under docs/archive/ in the same commit.'
  );
  return lines;
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

const CHECK_SYNC_USAGE = [
  'Usage: ./scripts/mavp-operator --check-sync',
  '',
  'Compares agent/skill files in known projects against the mavericks source. Read-only; takes no options.',
  '--help prints this text and exits 0 before reading or writing anything.',
];

function main() {
  // T-917: help first, before any directory scan or file read.
  if (handleHelpFlag(CHECK_SYNC_USAGE)) return;

  console.log(`\n${BOLD}MavP Check-Sync${RESET} ${DIM}comparing against ${MAVERICKS_ROOT}${RESET}\n`);

  const homeMavericksPath = path.join(os.homedir(), '.mavericks');
  const homeDrift = checkHomeMavericksDrift(MAVERICKS_ROOT, homeMavericksPath);
  if (homeDrift) {
    console.log(
      `${YELLOW}⚠ ~/.mavericks is v${homeDrift.homeVersion} but canonical is v${homeDrift.canonicalVersion}${RESET}` +
      ` ${DIM}(${homeDrift.homePath})${RESET} — run: ${BOLD}git -C ${homeDrift.homePath} pull${RESET}\n`
    );
  }

  const projects = discoverProjects();
  // An adopter-run invocation (MAVERICKS_PROJECT_ROOT names a project, not the framework): that
  // project is the one being checked, so it is listed first.
  if (ROOTS.adopterRoot) {
    const rest = projects.filter(p => path.resolve(p) !== ROOTS.adopterRoot);
    projects.length = 0;
    projects.push(ROOTS.adopterRoot, ...rest);
  }

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

    // Managed PostToolUse hook drift (T-441) — a naive/stale hook is the
    // source of the false "blocking error" noise reported from the field.
    // Skipped silently (no output) when there's no settings file or no
    // managed entry — that's not drift, just "nothing to compare".
    const hookDrift = checkHookDrift(projectPath);
    if (hookDrift && hookDrift.stale) {
      anyDrift = true;
      console.log(
        `  ${RED}✗ hook STALE${RESET} ${DIM}(managed PostToolUse hook differs from the current hardened composition)${RESET}` +
        ` — run: ${BOLD}node scripts/mavp-install.js --update ${projectPath}${RESET}`
      );
    } else if (hookDrift && !hookDrift.stale) {
      console.log(`  ${GREEN}✓ hook in sync${RESET}`);
    }

    // CLAUDE.md text already carried by an on-demand framework file (T-894). Advisory only:
    // prints counts, file paths and line numbers, never the text, and never sets anyDrift.
    for (const out of renderClaudeMdDuplicateLines(findClaudeMdOnDemandDuplicates(projectPath, { frameworkRoot: MAVERICKS_ROOT }))) {
      console.log(`  ${DIM}${out}${RESET}`);
    }
  }

  console.log('');

  if (!anyDrift) {
    console.log(`${GREEN}${BOLD}All projects in sync.${RESET}\n`);
  } else {
    console.log(`${YELLOW}Run ${BOLD}./scripts/mavp-operator --install --update <project-path>${RESET}${YELLOW} to resync a drifted project.${RESET}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveFrameworkRoot,
  renderClaudeMdDuplicateLines,
  readMaverticksVersion,
  checkHomeMavericksDrift,
  checkHookDrift,
};
