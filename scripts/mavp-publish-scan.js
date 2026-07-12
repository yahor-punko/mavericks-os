#!/usr/bin/env node
// mavp-publish-scan.js — pre-publish secret and private-reference re-scan gate (T-277).
//
// Runs against an already-ASSEMBLED publish tree (the output directory produced
// by scripts/mavp-publish-assemble.js — T-332), not against the source repo.
// Recursively scans every file in that tree and reports any line matching a
// secret/private-reference pattern, with file path + line number + category.
//
// Exit 0  = zero findings (clean).
// Exit 1  = one or more findings (printed to stdout before exit).
//
// No external dependencies — uses only Node's `fs` and `path`.
//
// Usage:
//   node scripts/mavp-publish-scan.js <assembled-dir> [--private-names name1,name2,...]
//
// Private-repo-name detection is RUNTIME-SUPPLIED, not hardcoded. This
// scanner ships as public source, so it must never contain the owner's
// private project/repo names as literals — that would both (a) leak those
// names into the public repo via the scanner's own source, and (b) be
// useless to any other adopter whose private names differ.
//
//   --private-names name1,name2,...   comma-separated list, checked first
//   MAVP_PRIVATE_NAMES=name1,name2,...  env var fallback if the flag is absent
//
// If neither is supplied, the "Private repo name" category is simply
// inactive for that run (a note is printed) — every other category (secret
// token shapes, /Users/ paths, emails) remains always-on and unaffected.
//
// A supplied name ending in `-` (e.g. `acme-`) is treated as a prefix and
// matches any following identifier characters (e.g. `acme-web`); any other
// supplied name is matched as a whole word (case-insensitive).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Detection categories (always-on)
// ---------------------------------------------------------------------------
//
// Each category has a name and one or more regexes. A line is flagged once
// per category per match. Regexes are re-created per line (via a factory) so
// global-flag `lastIndex` state never leaks across lines/files.
//
// Deliberately contains NO owner-specific private names — only generic
// secret-token shapes, path patterns, and email syntax that are safe to ship
// as public source.

const BASE_CATEGORIES = [
  {
    name: 'EXA token',
    regexes: [
      // literal exa_-prefixed key shape
      () => /\bexa_[A-Za-z0-9]{16,}\b/g,
      // EXA_API_KEY assigned an actual value (not a $VAR ref or <placeholder>)
      () => /\bEXA_API_KEY\b\s*[=:]\s*["']?([A-Za-z0-9_\-]{16,})["']?/g,
    ],
  },
  {
    name: 'SaaS live/test secret-key token',
    regexes: [
      // Subscription/SaaS-platform secret-key shape: <visibility>_<env>_<token>
      // (e.g. public_live_xxx, secret_test_xxx). Shape-based only — no
      // vendor/company name is hardcoded here by design (see file header).
      () => /\b(?:public|secret)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    ],
  },
  {
    name: 'Figma personal token',
    regexes: [() => /\bfigd_[A-Za-z0-9_-]{20,}\b/g],
  },
  {
    name: 'AWS access key',
    regexes: [() => /\bAKIA[0-9A-Z]{16}\b/g],
  },
  {
    name: 'PEM private key header',
    regexes: [() => /-----BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE KEY-----/g],
  },
  {
    name: 'Generic high-entropy secret assignment',
    regexes: [
      // key/token/secret/api-key/access-key = <20+ char real-looking value>.
      // Character class deliberately excludes `$` and `<` so env-var refs
      // (`$EXA_API_KEY`) and doc placeholders (`<EXA_API_KEY>`) never match —
      // this is a detection-precision measure, not a private-content allow-list.
      () =>
        /\b(?:api[_-]?key|apikey|access[_-]?key|secret|token)\b\s*[=:]\s*["']?([A-Za-z0-9_\-/+]{20,})["']?/gi,
    ],
  },
  {
    name: 'Absolute /Users/ path',
    regexes: [() => /\/Users\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g],
  },
  {
    name: 'Email address',
    regexes: [() => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  },
];

// ---------------------------------------------------------------------------
// Allow-list — built EMPIRICALLY by running the scanner's email regex against
// a freshly assembled clean tree (see T-277 dev evidence) and reviewing every
// match. Each entry below is an intentional, deliberately public identifier
// that is expected to ship. Nothing else is allow-listed for any category —
// token shapes and /Users/ paths are never allow-listed (per T-277 brief:
// they should never legitimately appear in the ship set).
const EMAIL_ALLOWLIST = new Set([
  // Maintainer's public OSS contact address, intentionally published in
  // SECURITY.md (security contact) and CODE_OF_CONDUCT.md (enforcement
  // contact) so external reporters/contributors can reach a real human.
  'yahorpunko@gmail.com',
  // RFC-2606/6761 reserved (.invalid) dummy address used as the throwaway
  // git-commit author in mavp-operator-demo.js's session-phase fixture
  // seeding — deliberately non-resolvable, never a real address.
  'demo@example.invalid',
]);

function isAllowed(categoryName, matchText) {
  if (categoryName === 'Email address') {
    return EMAIL_ALLOWLIST.has(matchText.toLowerCase());
  }
  return false;
}

// ---------------------------------------------------------------------------
// Runtime-supplied private-repo-name detection
// ---------------------------------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds one regex factory per supplied name. Names ending in `-` are
// treated as a prefix (e.g. `acme-` matches `acme-web`, `acme-locker`,
// ...); all other names are matched as a whole word.
function buildPrivateNameRegexes(names) {
  return names
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.endsWith('-')) {
        const escapedPrefix = escapeRegex(name);
        return () => new RegExp(`\\b${escapedPrefix}[a-z0-9-]*\\b`, 'gi');
      }
      const escaped = escapeRegex(name);
      return () => new RegExp(`\\b${escaped}\\b`, 'gi');
    });
}

// Resolves the private-name list: --private-names flag takes precedence
// over MAVP_PRIVATE_NAMES env var. Returns [] if neither is supplied.
function resolvePrivateNames(cliValue) {
  const raw = cliValue !== null && cliValue !== undefined ? cliValue : process.env.MAVP_PRIVATE_NAMES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  let privateNames = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--private-names') {
      privateNames = argv[i + 1] || '';
      i++;
    } else if (arg.startsWith('--private-names=')) {
      privateNames = arg.slice('--private-names='.length);
    } else {
      positional.push(arg);
    }
  }

  return { targetDir: positional[0], privateNames };
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// Heuristic binary-file detection: read the first chunk and check for a NUL
// byte. Binary files (images, etc.) are skipped — they cannot contain the
// text patterns we look for and may not decode cleanly as UTF-8.
function isBinary(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true; // unreadable -> treat as skip-worthy
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function scanFile(filePath, findings, categories) {
  if (isBinary(filePath)) return;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // unreadable as text — skip
  }

  const lines = content.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    for (const category of categories) {
      for (const makeRegex of category.regexes) {
        const re = makeRegex();
        let m;
        while ((m = re.exec(line)) !== null) {
          const matchText = m[0];
          if (isAllowed(category.name, matchText)) continue;
          findings.push({
            file: filePath,
            line: lineNo,
            category: category.name,
            match: redact(matchText),
          });
          if (m[0].length === 0) re.lastIndex++; // guard against zero-width match loops
        }
      }
    }
  }
}

// Redact long matches in reported output so the gate's own console output
// does not become a secondary leak vector; short/structural matches
// (paths, repo names, emails) are shown in full since they are not secrets.
function redact(text) {
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)} (len ${text.length})`;
}

function printUsage() {
  console.error(
    'Usage: node scripts/mavp-publish-scan.js <assembled-dir> [--private-names name1,name2,...]\n' +
      '\n' +
      '  <assembled-dir>       directory produced by mavp-publish-assemble.js\n' +
      '  --private-names LIST  comma-separated private repo/project names to\n' +
      '                        detect (e.g. "acme-,foobar,widgetco"). A name\n' +
      '                        ending in "-" matches as a prefix. Falls back\n' +
      '                        to the MAVP_PRIVATE_NAMES env var if omitted.\n' +
      '                        If neither is supplied, private-repo-name\n' +
      '                        detection is disabled for the run.'
  );
}

function main() {
  const { targetDir, privateNames: privateNamesArg } = parseArgs(process.argv.slice(2));

  if (!targetDir) {
    printUsage();
    process.exit(1);
  }

  let stat;
  try {
    stat = fs.statSync(targetDir);
  } catch {
    console.error(`ERROR: path does not exist: ${targetDir}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`ERROR: not a directory: ${targetDir}`);
    process.exit(1);
  }

  const privateNames = resolvePrivateNames(privateNamesArg);
  const categories = BASE_CATEGORIES.slice();
  if (privateNames.length > 0) {
    categories.push({
      name: 'Private repo name',
      regexes: buildPrivateNameRegexes(privateNames),
    });
  } else {
    console.error('NOTE: private-repo-name detection disabled — no --private-names supplied.');
  }

  const resolvedDir = path.resolve(targetDir);
  const files = walk(resolvedDir, []);

  const findings = [];
  for (const file of files) {
    scanFile(file, findings, categories);
  }

  if (findings.length === 0) {
    console.log(`OK: scanned ${files.length} file(s) in ${resolvedDir} — zero findings.`);
    process.exit(0);
  }

  console.error(`FOUND ${findings.length} finding(s) in ${resolvedDir}:\n`);
  for (const f of findings) {
    const rel = path.relative(resolvedDir, f.file);
    console.error(`  [${f.category}] ${rel}:${f.line}  ${f.match}`);
  }
  console.error(`\nFAILED: ${findings.length} finding(s) — see above.`);
  process.exit(1);
}

main();
