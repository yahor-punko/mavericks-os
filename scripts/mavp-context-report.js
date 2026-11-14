#!/usr/bin/env node

/**
 * mavp-context-report.js (T-885)
 *
 * Read-only measurement of what a new session and each sub-agent spawn load
 * from the repository, in characters, at the working tree or at any git
 * revision. It exists so a token-spend optimisation can show a before/after
 * reduction with numbers instead of estimates.
 *
 * Usage:
 *   node scripts/mavp-context-report.js [--json] [--rev <ref>] [--root <dir>]
 *
 * What is measured (all in JavaScript string length, the same unit
 * collectAlwaysLoadedContext() uses):
 *   always_loaded_chars          CLAUDE.md + recursive @ imports + unscoped
 *                                .claude/rules files (collectAlwaysLoadedContext)
 *   agent_description_chars      name + description frontmatter values of
 *                                .claude/agents/*.md
 *   skill_description_chars      same for .claude/skills/<dir>/SKILL.md
 *   session_start_skill_body_chars  the session-start SKILL.md text after its
 *                                frontmatter block
 *   session_start_static_chars   sum of the four numbers above
 *   path_scoped_rules            rules carrying a paths: key (loaded only on
 *                                demand, so never counted above)
 *   per_role                     one row per agent spec: layer0_chars (the
 *                                always-loaded total, or 0 when the spec
 *                                frontmatter sets omitClaudeMd true),
 *                                spec_body_chars (spec text after its
 *                                frontmatter) and fixed_chars (their sum)
 *
 * Not counted (named in the output): the harness system prompt and tool
 * schemas, auto-memory, the --agent output, HANDOFF.md, and the spawn brief.
 *
 * Frontmatter values are read as plain `key: value` lines; indented
 * continuation lines are joined with a single space and one pair of
 * surrounding quotes is stripped. That covers the frontmatter shapes this
 * repository uses; it is not a YAML parser.
 *
 * --rev <ref> reads every file from that revision's git tree. The ref is
 * verified with `git rev-parse` and every git call is an argument vector,
 * never a shell string. The script writes no file and changes no git state.
 *
 * Exit codes: 0 report printed, 2 usage or git error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { collectAlwaysLoadedContext, readFileAtRevision } = require('./mavp-operator-lib.js');

const NOT_COUNTED = [
  'harness system prompt and tool schemas',
  'auto-memory (MEMORY.md and the files it indexes)',
  '--agent output (the session-start skill runs it)',
  'HANDOFF.md',
  'the spawn brief',
];

const AGENT_PATH = /^\.claude\/agents\/[^/]+\.md$/;
const SKILL_PATH = /^\.claude\/skills\/[^/]+\/SKILL\.md$/;
const SESSION_START_SKILL = '.claude/skills/session-start/SKILL.md';

class UsageError extends Error {}

function usage() {
  return [
    'Usage: node scripts/mavp-context-report.js [--json] [--rev <ref>] [--root <dir>]',
    '  --json        print one JSON object instead of the table',
    '  --rev <ref>   measure that git revision instead of the working tree',
    '  --root <dir>  project root (default: the current directory)',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { json: false, rev: null, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--rev' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${a} requires a value`);
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--rev=')) out.rev = a.slice('--rev='.length);
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length);
    else throw new UsageError(`unrecognized argument: ${a}`);
  }
  if (out.rev !== null && (out.rev === '' || out.rev.startsWith('-'))) {
    throw new UsageError(`--rev must be a revision name, got: ${out.rev}`);
  }
  return out;
}

function git(root, args) {
  try {
    return cp.execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : String(err && err.message);
    throw new UsageError(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

/** Verify a ref with git rev-parse; returns the full commit hash. */
function resolveRev(root, ref) {
  const out = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new UsageError(`--rev ${ref} did not resolve to a commit`);
  return sha;
}

/** Source of file text: { read(rel), list(regex) } over the working tree or one revision. */
function makeSource(root, sha) {
  if (sha === null) {
    return {
      read(rel) {
        try {
          return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
        } catch {
          return null;
        }
      },
      list(re) {
        const found = [];
        const walk = (dir, relDir) => {
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const rel = relDir ? `${relDir}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), rel);
            else if (e.isFile() && re.test(rel)) found.push(rel);
          }
        };
        // Only the three directories the report reads: .claude also holds
        // worktree checkouts, which must never be walked.
        for (const d of ['rules', 'agents', 'skills']) walk(path.join(root, '.claude', d), `.claude/${d}`);
        return found.sort();
      },
    };
  }
  const paths = new Set(
    git(root, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-z', '--name-only', sha])
      .split('\0')
      .filter(Boolean)
  );
  const cache = new Map();
  return {
    read(rel) {
      if (!paths.has(rel)) return null;
      if (!cache.has(rel)) cache.set(rel, readFileAtRevision(root, sha, rel));
      return cache.get(rel);
    },
    list(re) {
      return [...paths].filter((p) => re.test(p)).sort();
    },
    paths,
  };
}

function stripQuotes(v) {
  const m = v.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : v;
}

/** Split a spec file into { fields, body }; no frontmatter means all body. */
function splitFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fields: {}, body: String(text) };
  const fields = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      key = kv[1];
      fields[key] = /^[>|][+-]?$/.test(kv[2].trim()) ? '' : kv[2].trim();
    } else if (key !== null && /^\s+\S/.test(line)) {
      fields[key] = fields[key] ? `${fields[key]} ${line.trim()}` : line.trim();
    }
  }
  for (const k of Object.keys(fields)) fields[k] = stripQuotes(fields[k]);
  return { fields, body: String(text).slice(m[0].length) };
}

function nameAndDescriptionChars(fields) {
  return (fields.name || '').length + (fields.description || '').length;
}

function computeReport(root, sha) {
  const absRoot = path.resolve(root);
  const src = makeSource(absRoot, sha);
  const toRel = (abs) => path.relative(absRoot, abs).split(path.sep).join('/');

  const ctx = collectAlwaysLoadedContext(absRoot, {
    readFile: (abs) => {
      const rel = toRel(abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return src.read(rel);
    },
    listMarkdown: (absDir) => {
      const prefix = `${toRel(absDir)}/`;
      return src.list(/\.md$/i).filter((p) => p.startsWith(prefix)).map((p) => path.join(absRoot, ...p.split('/')));
    },
  });
  const alwaysLoaded = ctx.total_chars;

  const agents = src.list(AGENT_PATH).map((rel) => {
    const { fields, body } = splitFrontmatter(src.read(rel));
    return {
      role: fields.name || path.posix.basename(rel, '.md'),
      descriptionChars: nameAndDescriptionChars(fields),
      bodyChars: body.length,
      omit: /^true$/i.test(fields.omitClaudeMd || ''),
    };
  });
  const skills = src.list(SKILL_PATH).map((rel) => splitFrontmatter(src.read(rel)).fields);

  const agentDescriptionChars = agents.reduce((s, a) => s + a.descriptionChars, 0);
  const skillDescriptionChars = skills.reduce((s, f) => s + nameAndDescriptionChars(f), 0);
  const sessionText = src.read(SESSION_START_SKILL);
  const sessionBodyChars = typeof sessionText === 'string' ? splitFrontmatter(sessionText).body.length : 0;

  return {
    rev: sha,
    always_loaded_chars: alwaysLoaded,
    agent_description_chars: agentDescriptionChars,
    skill_description_chars: skillDescriptionChars,
    session_start_skill_body_chars: sessionBodyChars,
    session_start_static_chars:
      alwaysLoaded + agentDescriptionChars + skillDescriptionChars + sessionBodyChars,
    path_scoped_rules: ctx.path_scoped_rules.map((r) => ({ path: r.path, chars: r.chars })),
    per_role: agents.map((a) => {
      const layer0 = a.omit ? 0 : alwaysLoaded;
      return {
        role: a.role,
        layer0_chars: layer0,
        spec_body_chars: a.bodyChars,
        fixed_chars: layer0 + a.bodyChars,
      };
    }),
    not_counted: NOT_COUNTED.slice(),
  };
}

function renderTable(report, label) {
  const lines = [`Context report (${label})`, ''];
  const rows = [
    ['always_loaded_chars', report.always_loaded_chars],
    ['agent_description_chars', report.agent_description_chars],
    ['skill_description_chars', report.skill_description_chars],
    ['session_start_skill_body_chars', report.session_start_skill_body_chars],
    ['session_start_static_chars', report.session_start_static_chars],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) lines.push(`${k.padEnd(w)}  ${String(v).padStart(8)}`);
  lines.push('', 'Per role (fixed load of one spawn):');
  const rw = Math.max(4, ...report.per_role.map((r) => r.role.length));
  lines.push(`${'role'.padEnd(rw)}  ${'layer0'.padStart(8)}  ${'spec_body'.padStart(9)}  ${'fixed'.padStart(8)}`);
  for (const r of report.per_role) {
    lines.push(
      `${r.role.padEnd(rw)}  ${String(r.layer0_chars).padStart(8)}  ${String(r.spec_body_chars).padStart(9)}  ${String(r.fixed_chars).padStart(8)}`
    );
  }
  lines.push('', 'Path-scoped rules (loaded on demand, not in always_loaded_chars):');
  if (report.path_scoped_rules.length === 0) lines.push('  none');
  for (const r of report.path_scoped_rules) lines.push(`  ${r.path}  ${r.chars}`);
  lines.push('', `Not counted: ${report.not_counted.join('; ')}.`);
  return lines.join('\n');
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const root = path.resolve(args.root || process.cwd());
  try {
    const sha = args.rev === null ? null : resolveRev(root, args.rev);
    const report = computeReport(root, sha);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${renderTable(report, sha === null ? 'working tree' : `rev ${args.rev} = ${sha.slice(0, 12)}`)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { computeReport, splitFrontmatter, parseArgs };
