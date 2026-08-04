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
  // seeding — deliberately non-resolvable, never a real address. (Also
  // subsumed by RESERVED_EXAMPLE_DOMAINS/RESERVED_EXAMPLE_TLD_SUFFIXES
  // below; kept explicit here for documentation clarity.)
  'demo@example.invalid',
]);

// RFC 2606 ("Reserved Top Level DNS Names") and RFC 6761 ("Special-Use
// Domain Names") permanently reserve example.com/.net/.org and the
// .invalid/.test/.example/.localhost TLDs as non-routable documentation
// placeholders — no real or private address can ever be hosted there. Any
// local-part@ these domains is therefore safe to allow-list wholesale
// instead of requiring a one-off exact-string EMAIL_ALLOWLIST entry per new
// throwaway dummy address, which eliminates a recurring release-blocker:
// each new test fixture email (e.g. test@example.com) previously tripped
// the publish-scan email gate until manually allow-listed.
const RESERVED_EXAMPLE_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const RESERVED_EXAMPLE_TLD_SUFFIXES = ['.invalid', '.test', '.example', '.localhost'];

function isReservedExampleDomain(domain) {
  const lowerDomain = domain.toLowerCase();
  if (RESERVED_EXAMPLE_DOMAINS.has(lowerDomain)) {
    return true;
  }
  return RESERVED_EXAMPLE_TLD_SUFFIXES.some((suffix) => lowerDomain.endsWith(suffix));
}

function isAllowed(categoryName, matchText) {
  if (categoryName === 'Email address') {
    const lowerMatch = matchText.toLowerCase();
    if (EMAIL_ALLOWLIST.has(lowerMatch)) {
      return true;
    }
    const atIndex = lowerMatch.lastIndexOf('@');
    if (atIndex === -1) {
      return false;
    }
    const domain = lowerMatch.slice(atIndex + 1);
    return isReservedExampleDomain(domain);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Runtime-supplied private-repo-name detection
// ---------------------------------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A private name is only useful to the detector if it can ever match the
// word-boundary-anchored (`\b...\b`) regex buildPrivateNameRegexes builds
// for it. A name made up entirely of non-word characters (three asterisks, a
// lone dot, a bare hyphen — anything with no [A-Za-z0-9_]) can never satisfy
// a `\b` boundary against any real text, so accepting it as a "name" would
// silently disable detection for that entry while it still counts as a
// non-empty, well-formed-looking item to any caller that only checks
// list length (T-510). This is deliberately "must contain at least one word
// character", NOT "must contain no punctuation" — the latter would also
// reject this project's real trailing-hyphen prefix form (a name ending in
// `-`, used to match a family of repo names, e.g. `acme-`), which has
// exactly one non-word character but plenty of word characters before it
// and must keep working unmodified. Single source of truth for the rule —
// used by both parsePrivateNamesList (parse-time refusal, the primary
// enforcement point) and buildPrivateNameRegexes (defense in depth, in case
// a caller ever builds regexes from a list that bypassed the parser).
function isUsablePrivateName(name) {
  return /\w/.test(name);
}

// Builds one regex factory per supplied name. Names ending in `-` are
// treated as a prefix (e.g. `acme-` matches `acme-web`, `acme-locker`,
// ...); all other names are matched as a whole word. Punctuation-only names
// (see isUsablePrivateName above) are filtered out here too, even though
// parsePrivateNamesList already refuses them upstream — this keeps the two
// call sites unable to disagree by construction rather than by convention.
function buildPrivateNameRegexes(names) {
  return names
    .map((raw) => raw.trim())
    .filter(Boolean)
    .filter(isUsablePrivateName)
    .map((name) => {
      if (name.endsWith('-')) {
        const escapedPrefix = escapeRegex(name);
        return () => new RegExp(`\\b${escapedPrefix}[a-z0-9-]*\\b`, 'gi');
      }
      const escaped = escapeRegex(name);
      return () => new RegExp(`\\b${escaped}\\b`, 'gi');
    });
}

// Splits/trims/filters a raw comma-separated private-names string into an
// array of non-empty, trimmed names. This is the SINGLE SOURCE OF TRUTH for
// that parsing (T-511) — scripts/mavp-publish-build.js imports this exact
// function for its own mandatory-flag gate instead of carrying a duplicate
// copy, so the gate and the scanner's actual detection can never disagree on
// what counts as a valid name. Exported below alongside resolvePrivateNames.
// This function does NOT know about the MAVP_PRIVATE_NAMES env-var fallback
// (that policy lives only in resolvePrivateNames, which this repo's build
// script deliberately does not use — see the file header of
// mavp-publish-build.js on why the mandatory-flag gate stays argv-only).
//
// THROWS (T-510) when any entry, after trim, is non-empty but punctuation-only
// (see isUsablePrivateName above) — e.g. "good-name,***" throws rather than
// silently returning ["good-name"]. This is a deliberate fail-closed choice,
// not a silent-drop: a mixed list is exactly the case where an operator is
// least likely to notice a silently narrowed detection set (a purely
// degenerate value like "***" alone would already be caught downstream by
// the mandatory-flag empty-list gate in mavp-publish-build.js, so the only
// behavior this predicate needs to add is catching the MIXED case, and
// refusing loudly there is consistent with how that empty-list gate already
// treats degenerate input — fail closed, not quietly narrowed). Both call
// sites (the build script's mandatory-flag gate and the scanner's own
// main()) must catch this and exit non-zero with the message rather than
// let it propagate as an uncaught exception.
function parsePrivateNamesList(raw) {
  if (!raw) return [];
  const names = raw
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const unusable = names.filter((name) => !isUsablePrivateName(name));
  if (unusable.length > 0) {
    throw new Error(
      'parsePrivateNamesList: refusing punctuation-only private name(s) — ' +
        `${JSON.stringify(unusable)} — these have no word characters and can ` +
        'never match the word-boundary-anchored detection regex, so accepting ' +
        'them would silently disable detection for that entry. Remove or fix ' +
        'the invalid name(s) in the --private-names value.'
    );
  }
  return names;
}

// Resolves the private-name list: --private-names flag takes precedence
// over MAVP_PRIVATE_NAMES env var. Returns [] if neither is supplied.
function resolvePrivateNames(cliValue) {
  const raw = cliValue !== null && cliValue !== undefined ? cliValue : process.env.MAVP_PRIVATE_NAMES;
  return parsePrivateNamesList(raw);
}

// ---------------------------------------------------------------------------
// Category-set assembly — the SINGLE source of truth (T-523)
// ---------------------------------------------------------------------------

const PRIVATE_NAME_CATEGORY = 'Private repo name';

// Returns the complete detection category set for a run: every always-on
// BASE_CATEGORIES entry, plus the runtime-supplied private-repo-name category
// when at least one usable name was supplied (see isUsablePrivateName /
// buildPrivateNameRegexes above for what "usable" means — a name that can
// never match is not silently counted as active detection).
//
// This is the ONE definition of the category set, and it exists so two
// callers cannot disagree about what a finding is: main() below uses it for
// the assembled-tree scan, and scripts/mavp-publish-build.js imports it to
// scan the composed mirror commit message (T-523) — a second publication
// channel that must be gated by the IDENTICAL set, not by a lookalike copy.
// A duplicated security-relevant definition in this pipeline has already had
// to be de-duplicated once (T-511, parsePrivateNamesList) precisely because
// the copies could drift apart unnoticed.
//
// Pure by design: no logging, no process.exit, no filesystem access, so any
// caller (CLI, another script, a test) can build the set without side
// effects. The CLI-only "detection disabled" NOTE stays in main() — that is a
// reporting concern, not part of the category set.
function buildCategories(privateNames) {
  const categories = BASE_CATEGORIES.slice();
  const names = Array.isArray(privateNames) ? privateNames : [];
  const regexes = buildPrivateNameRegexes(names);
  if (regexes.length > 0) {
    categories.push({ name: PRIVATE_NAME_CATEGORY, regexes });
  }
  return categories;
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

// Both the assembler (mavp-publish-assemble.js) and the overlay deliberately
// preserve tracked symlinks as symlinks rather than copying their target's
// content, so a symlink entry in the assembled tree is itself something that
// can carry a private reference — its TARGET STRING (e.g. a relative `../`
// escape into a private sibling directory, or an absolute home-directory
// filesystem path) ships to the public tree exactly as written. Record symlink entries
// separately from regular files (`type: 'symlink'` vs `type: 'file'`) so the
// caller can scan the target string via readlinkSync (see scanSymlinkTarget
// below) instead of dereferencing the link to read what it points at.
// Dereferencing would let the scan wander outside the assembled tree
// entirely — its own hazard — which is why this walk never follows a
// symlink to recurse into or read through it, only records its presence.
function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push({ path: full, type: 'symlink' });
    } else if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push({ path: full, type: 'file' });
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

// Runs every detection category's regexes against a single string of text
// (a file line, or — for symlinks — the link's target string) and pushes
// any non-allow-listed match to `findings`. `lineNo` is `null` for a
// symlink-target scan (there is no line concept for a single target string);
// callers pass a real 1-based line number for actual file content.
function scanTextAgainstCategories(filePath, lineNo, text, findings, categories) {
  for (const category of categories) {
    for (const makeRegex of category.regexes) {
      const re = makeRegex();
      let m;
      while ((m = re.exec(text)) !== null) {
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
    scanTextAgainstCategories(filePath, i + 1, lines[i], findings, categories);
  }
}

// Scans a symlink's TARGET STRING (via readlinkSync — never dereferenced,
// never followed) through the same detection categories used for file
// content. A symlink target is just a string the publish tree ships
// verbatim, so it is subject to exactly the same private-reference/secret
// categories as any other shipped text, rather than a bespoke category of
// its own — see the file-walking comment above `walk()` for why dereferencing
// is deliberately never attempted here.
function scanSymlinkTarget(filePath, findings, categories) {
  let target;
  try {
    target = fs.readlinkSync(filePath);
  } catch {
    return; // unreadable link — skip
  }
  scanTextAgainstCategories(filePath, null, target, findings, categories);
}

// ---------------------------------------------------------------------------
// Entry-path scanning (T-601)
// ---------------------------------------------------------------------------
//
// Before T-601, every detection category ran against file CONTENTS
// (scanFile) and symlink TARGET strings (scanSymlinkTarget), but never
// against an entry's own tree-relative PATH string. A ship-classified file
// whose NAME embeds a private repo name (or any other detectable shape)
// would therefore publish completely undetected — the file's bytes could be
// perfectly clean while its path alone leaked. scanEntryPath closes that
// gap by running the same category set against the path text.
//
// `PATH_LOCATION_MARKER` is passed as the `lineNo` argument to
// scanTextAgainstCategories (which stores whatever it is given verbatim on
// `finding.line`) instead of a real line number or the `null` used for
// symlink-target findings — this keeps a path finding trivially
// distinguishable from both a content finding (numeric line) and a
// symlink-target finding (`null`), without changing
// scanTextAgainstCategories' signature or its existing callers' behavior.
//
// Two parameters instead of one (unlike scanSymlinkTarget, which derives its
// own text via readlinkSync from a single path): `identityPath` is what gets
// attributed to the finding's `file` field (kept consistent with every other
// finding shape so callers/renderers that do path.relative(root, f.file)
// keep working unmodified), while `relPath` is the actual TEXT scanned — the
// tree-relative path string, never the full filesystem path (scanning the
// full path would spuriously match "Absolute /Users/ path" on every single
// entry in a locally-assembled tree). This split also suits a commit-time
// consumer (T-600) that has no assembled tree at all: it can pass the same
// repo-relative staged-file path string for both arguments, since there is
// no separate "full disk path" concept for it to track.
const PATH_LOCATION_MARKER = 'file path';

function scanEntryPath(identityPath, relPath, findings, categories) {
  scanTextAgainstCategories(identityPath, PATH_LOCATION_MARKER, relPath, findings, categories);
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

  let privateNames;
  try {
    privateNames = resolvePrivateNames(privateNamesArg);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  // T-523: assembled by the shared buildCategories() above rather than
  // inline here, so this CLI and mavp-publish-build.js's commit-message gate
  // can never scan against different category sets.
  const categories = buildCategories(privateNames);
  if (!categories.some((c) => c.name === PRIVATE_NAME_CATEGORY)) {
    console.error('NOTE: private-repo-name detection disabled — no --private-names supplied.');
  }

  const resolvedDir = path.resolve(targetDir);
  const entries = walk(resolvedDir, []);
  const symlinkCount = entries.filter((e) => e.type === 'symlink').length;

  const findings = [];
  for (const entry of entries) {
    // T-601: every entry's tree-relative PATH string is scanned through the
    // same category set as its content/target, in addition to (not instead
    // of) that content/target scan below — a private name can leak through
    // either channel independently.
    const relPath = path.relative(resolvedDir, entry.path);
    scanEntryPath(entry.path, relPath, findings, categories);
    if (entry.type === 'symlink') {
      scanSymlinkTarget(entry.path, findings, categories);
    } else {
      scanFile(entry.path, findings, categories);
    }
  }

  if (findings.length === 0) {
    console.log(
      `OK: scanned ${entries.length} entrie(s) (${entries.length - symlinkCount} file(s), ` +
        `${symlinkCount} symlink target(s)) in ${resolvedDir} — zero findings.`
    );
    process.exit(0);
  }

  console.error(`FOUND ${findings.length} finding(s) in ${resolvedDir}:\n`);
  for (const f of findings) {
    const rel = path.relative(resolvedDir, f.file);
    const loc =
      f.line === null
        ? `${rel} (symlink target)`
        : f.line === PATH_LOCATION_MARKER
          ? `${rel} (${PATH_LOCATION_MARKER})`
          : `${rel}:${f.line}`;
    console.error(`  [${f.category}] ${loc}  ${f.match}`);
  }
  console.error(`\nFAILED: ${findings.length} finding(s) — see above.`);
  process.exit(1);
}

// Exported for the T-505 regression test (test-publish-scan-symlink.js) to
// exercise walk()/scanSymlinkTarget()/scanTextAgainstCategories() directly
// against fixture symlinks — mirrors the module.exports pattern already used
// by check-publish-manifest.js. CLI behavior is unchanged: main() still runs
// unconditionally when this file is executed directly.
//
// T-523 adds buildCategories/PRIVATE_NAME_CATEGORY: scripts/mavp-publish-
// build.js imports them (together with the already-exported
// scanTextAgainstCategories) to scan the composed mirror commit message
// through this scanner's exact category set, with no duplicated assembly and
// no temp file.
//
// T-601 adds scanEntryPath/PATH_LOCATION_MARKER — ADDITIVE exports, no
// signature change to any of the five above. scanEntryPath is designed for
// exactly two consumers: this file's own main() (assembled-tree entries) and
// T-600's commit-time backstop (scripts/mavp-private-names-guard.js) scanning
// a staged-file path list, neither of which needs an assembled tree on disk
// since scanEntryPath takes plain strings, not filesystem entries.
module.exports = {
  walk,
  scanFile,
  scanSymlinkTarget,
  scanTextAgainstCategories,
  scanEntryPath,
  PATH_LOCATION_MARKER,
  isAllowed,
  parsePrivateNamesList,
  resolvePrivateNames,
  buildCategories,
  buildPrivateNameRegexes,
  isUsablePrivateName,
  PRIVATE_NAME_CATEGORY,
};

if (require.main === module) {
  main();
}
