'use strict';
// T-831 — read-only `--migrate`: find `mavp-workaround:<alias>-NNN` tags in the
// repo tree and the harness memory directory and say which workarounds are now
// retirable because the framework fix is installed.
//
//   --migrate            tagged workarounds: one line per hit, then a summary
//   --migrate --legacy   also match phrases CHANGELOG sections declare as
//                        "Supersedes adopter workarounds" (installed versions only)
//
// A tagged workaround whose item was posted to GitHub and has no fixed-in answer yet is reported
// as `open (posted as <slug>#N — run ./scripts/mavp-operator --feedback --pull)` (T-835): the answer
// reaches this command only after `--feedback --pull` has stored it on the local item.
//
// This command never writes a file. Item format: templates/FEEDBACK_ITEM_TEMPLATE.md.
//
// Installed version: a framework checkout (it has scripts/mavp-operator-lib.js
// at its root) reports scripts/mavp-version.js; an adopter root reports the
// mavericks_version the installer stamped into PROCESS_STATE.json, falling back
// to the running framework's version when no valid stamp exists.
//
// Test hooks (environment): HOME / USERPROFILE move the harness memory lookup
// (os.homedir()); MAVERICKS_MIGRATE_CHANGELOG replaces the CHANGELOG path that
// --legacy reads (default: CHANGELOG.md at the framework root).

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  WORKAROUND_TAG_PATTERN,
  classifyFeedbackItem,
  parseChangelogSupersedes,
  resolveHarnessMemoryDir,
  resolveIntakeDir,
  listIntakeItems,
  semverCompare,
} = require('./mavp-operator-lib.js');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const USAGE = 'Usage: --migrate [--legacy]';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'PROCESS_STATE.json'), 'utf8'));
  } catch {
    return null;
  }
}

function resolveInstalledVersion(root, state) {
  if (fs.existsSync(path.join(root, 'scripts', 'mavp-operator-lib.js'))) return MAVERICKS_VERSION;
  const stamp = state && typeof state.mavericks_version === 'string' ? state.mavericks_version.trim() : '';
  return /^\d+\.\d+\.\d+$/.test(stamp) ? stamp : MAVERICKS_VERSION;
}

function listRepoFiles(root) {
  const git = cp.spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean).map((rel) => ({ abs: path.join(root, rel), rel }));
  // Not a git work tree: walk it, skipping VCS and dependency directories.
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (d.name === '.git' || d.name === 'node_modules') continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.isFile()) out.push({ abs, rel: path.relative(root, abs) });
    }
  };
  walk(root);
  return out;
}

function listMarkdownUnder(dir) {
  const out = [];
  const walk = (current) => {
    let names;
    try {
      names = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const abs = path.join(current, d.name);
      if (d.isDirectory()) walk(abs);
      else if (d.isFile() && d.name.endsWith('.md')) out.push({ abs, rel: abs });
    }
  };
  walk(dir);
  return out;
}

// Text of a scannable file, or null (missing, directory, oversized, binary).
function readScannable(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(abs, 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

function main(argv) {
  let legacy = false;
  for (const arg of argv) {
    if (arg === '--legacy') legacy = true;
    else fail(`migrate: unrecognized argument ${arg}\n${USAGE}`);
  }

  const state = readState(ROOT);
  const alias = state && typeof state.feedback_alias === 'string' ? state.feedback_alias.trim() : '';
  if (!alias) {
    fail('migrate: no feedback alias in PROCESS_STATE.json — set one with: --feedback --set-alias <alias>');
  }
  const installed = resolveInstalledVersion(ROOT, state);
  // Per-tag classification does not require the item to record a Workaround field.
  const classified = new Map(
    listIntakeItems(resolveIntakeDir())
      .filter((e) => e.alias === alias)
      .map((e) => classifyFeedbackItem(e, installed))
      .filter(Boolean)
      .map((c) => [c.tag, c])
  );

  let changelogPath = null;
  let legacyPhrases = [];
  if (legacy) {
    changelogPath = process.env.MAVERICKS_MIGRATE_CHANGELOG
      ? path.resolve(process.env.MAVERICKS_MIGRATE_CHANGELOG)
      : path.join(FRAMEWORK_ROOT, 'CHANGELOG.md');
    let text = '';
    try {
      text = fs.readFileSync(changelogPath, 'utf8');
    } catch {
      console.log(`migrate: no CHANGELOG at ${changelogPath} — --legacy has nothing to match`);
    }
    for (const section of parseChangelogSupersedes(text)) {
      if (section.version === 'Unreleased' || semverCompare(section.version, installed) > 0) continue;
      for (const phrase of section.phrases) legacyPhrases.push({ phrase, version: section.version });
    }
  }

  const files = listRepoFiles(ROOT);
  const memoryDir = resolveHarnessMemoryDir(ROOT);
  if (memoryDir) files.push(...listMarkdownUnder(memoryDir));

  const tagScan = new RegExp(WORKAROUND_TAG_PATTERN.source, 'g');
  let retire = 0;
  let keep = 0;
  for (const file of files) {
    if (changelogPath && path.resolve(file.abs) === changelogPath) continue;
    const text = readScannable(file.abs);
    if (text === null) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const where = `${file.rel}:${i + 1}`;
      for (const m of line.matchAll(tagScan)) {
        const c = classified.get(m[0]);
        if (!c) {
          console.log(`unknown item: ${m[0]} (${where})`);
        } else if (c.status === 'retire') {
          retire++;
          console.log(`retire: ${where} — ${m[0]} — fixed in ${c.fixedIn}, released in ${c.shipsIn} (installed ${installed})`);
        } else if (c.status === 'keep-pending') {
          keep++;
          console.log(`keep: ${where} — ${m[0]} — ships in ${c.shipsIn || 'a future release'}`);
        } else {
          keep++;
          // T-835: a posted GitHub item with no fixed answer yet says where the answer comes from.
          const hint = c.issue ? ` (posted as ${c.issue} — run ./scripts/mavp-operator --feedback --pull)` : '';
          console.log(`keep: ${where} — ${m[0]} — open${hint}`);
        }
      }
      for (const { phrase, version } of legacyPhrases) {
        if (line.includes(phrase)) {
          console.log(`possible legacy workaround: ${where} — matches "${phrase}" (superseded in ${version})`);
        }
      }
    }
  }
  console.log(`workaround retirement: ${retire} to retire, ${keep} to keep`);
}

main(process.argv.slice(2));
