#!/usr/bin/env node

/**
 * mavp-install.js
 *
 * Bootstraps Mavericks framework into a new project.
 *
 * Copies only project-specific files (templates) into target/scripts/:
 *   - mavp-operator          (bash wrapper that delegates to mavericks)
 *   - mavp-operator-agent.js (project-specific agent summary)
 *   - mavp-operator-close-session.js (project-specific close-session)
 *
 * Core framework files (lib, dashboard, snapshot, validator) are NOT copied.
 * They are used directly from the local mavericks installation via the bash wrapper.
 *
 * Usage:
 *   node /path/to/mavericks/scripts/mavp-install.js <target-dir>
 *   node /path/to/mavericks/scripts/mavp-install.js <target-dir> --yes
 *   node /path/to/mavericks/scripts/mavp-install.js <target-dir> --transcript-archive
 *   node /path/to/mavericks/scripts/mavp-install.js --check <target-dir>
 *   node /path/to/mavericks/scripts/mavp-install.js --update <target-dir> [--transcript-archive]
 *   node /path/to/mavericks/scripts/mavp-install.js --hooks-only <target-dir> [--transcript-archive]
 *   node /path/to/mavericks/scripts/mavp-install.js --strip <target-dir> [--keep-artifacts]
 *
 * Modes:
 *   (default)    — copy project-specific templates if missing, show status
 *   --check      — report what would be done, exit 1 if not bootstrapped
 *   --update     — re-sync entire framework from mavericks: .claude/ + all scripts (overwrites existing)
 *                  does NOT touch artifacts (BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.*)
 *   --hooks-only — sync ONLY the managed hooks (PostToolUse validator hook, SessionStart,
 *                  PostCompact) into .claude/settings.local.json, plus the .mavp-hook-ts
 *                  gitignore entry. Touches no other file — no wrapper, no agents/skills/rules,
 *                  no project-specific script sync. This is the safe, narrow command to run
 *                  when only hooks need to be activated/refreshed in a directory — including
 *                  the canonical self-activation case described below.
 *   --strip      — remove mavericks files from the project (pre-publish cleanup).
 *                WARNING: destructive. Run before pushing to a public repo or publishing a package.
 *                Prints a deletion manifest labeling each path's git-recoverability BEFORE any
 *                prompt (tracked / tracked-with-uncommitted-changes / NOT TRACKED — IRRECOVERABLE).
 *                Two-stage confirm: plumbing (regenerable via reinstall) is [y/N]; state artifacts
 *                (BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.*, EXECUTION_LOG.md, SKILL_PROPOSALS/)
 *                require typing the word "delete" if any state path is git-irrecoverable, else [y/N].
 *                Pass --keep-artifacts to skip the state-artifacts group entirely. Requires an
 *                interactive TTY — non-interactive runs print the manifest, delete nothing, exit 1.
 *                Does not affect npm/Docker ignores — those are the safer alternative.
 *
 * --yes / -y — accepts the default answer to the fresh-install file-creation prompt without
 *              asking (works at a real TTY too). Ignored (no effect, prints a notice) in
 *              --strip mode — it never bypasses the strip refuse/confirm gates. Accepted and
 *              ignored by --update / --check, which have no prompts.
 *
 * --transcript-archive (T-422) — opt-in, default OFF. When set, merges a sentinel-identified
 *              managed SessionStart hook that sweeps this project's Claude Code session
 *              transcripts (~/.claude/projects/<cwd-slug>/*.jsonl) into
 *              <project>/.mavp/transcripts/<session-id>.jsonl on every session start — see
 *              scripts/mavp-transcript-archive.js and docs/core/BOOTSTRAP_GUIDE.md —
 *              "Transcript archive". Also adds `.mavp/transcripts/` to the target project's
 *              .gitignore (transcripts are privacy-sensitive full session content — never
 *              git-tracked). Fresh install wires the hook in at seed time; --update and
 *              --hooks-only merge it into an already-bootstrapped project via the same
 *              mergeManagedHooks() machinery used for the validator/lifecycle hooks.
 *              Installing WITHOUT this flag adds no such entry. Once added, a later --update
 *              run (with or without the flag) preserves and refreshes the existing entry —
 *              only a fresh, never-flagged install/update skips adding it in the first place.
 *              To disable: remove the managed SessionStart entry from
 *              .claude/settings.local.json by hand (identifiable by the
 *              `: mavp-transcript-archive-hook;` sentinel prefix or the
 *              `mavp-transcript-archive.js` filename in its command) — a subsequent --update
 *              without --transcript-archive will not re-add it.
 *
 * Non-TTY contract — asymmetric by design:
 *   default install — when stdin is not a TTY, the file-creation prompt is skipped and the
 *                      install proceeds as if answered Y (agent Bash sessions can bootstrap
 *                      a project without hanging or silently creating nothing).
 *   --strip          — when stdin is not a TTY, prints the manifest, deletes nothing, exits 1.
 *                       This refusal is NOT bypassable by --yes (destructive action requires
 *                       a real interactive confirmation).
 *
 * After bootstrap, the generated wrapper and hooks resolve the mavericks install location as:
 * explicit MAVERICKS_HOME env var > ~/.mavericks (canonical) > ~/Documents/mavericks (legacy).
 * Set MAVERICKS_HOME if mavericks lives somewhere else entirely.
 *
 * Self-install detection — if the resolved target directory (compared via fs.realpathSync on
 * both sides, so a symlinked home like ~/.mavericks -> ~/Documents/mavericks is still caught) IS
 * the mavericks framework's own root, --update (and a fresh install's wrapper write) skip:
 * overwriting scripts/mavp-operator, the project-specific script sync, and the .claude/
 * {agents,skills,rules} copy — those files ARE the source here, copying them onto themselves
 * would be a no-op at best and a downgrade at worst. Only the hooks/config-related steps still
 * run (mergeManagedHooks, settings backfills, the .mavp-hook-ts gitignore entry, the pre-commit
 * hook copy). `--hooks-only <dir>` is the explicit, minimal command for this case.
 *
 * Content-sniff refusal guard — separately, `--update` also refuses to overwrite an EXISTING
 * wrapper that is already in canonical self-referential form (dispatches via
 * "$SCRIPT_DIR/mavp-operator-dashboard.js" and does not export MAVERICKS_PROJECT_ROOT), even when
 * the target is NOT detected as self-install — e.g. running the installer from one mavericks
 * checkout against a different mavericks checkout's directory. A warning is printed and the
 * wrapper is left untouched instead of being downgraded to the adopter form.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, execFileSync } = require('node:child_process');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

const FRAMEWORK_DIR = path.resolve(__dirname);

// Mavericks files to exclude from npm/Docker artifacts and --strip.
// IMPORTANT: Keep this list in sync with templates/deploy-ci-paths-ignore.fragment.yml.
// Both must cover the same set of framework-owned paths.
const MAVERICKS_IGNORE_PATTERNS = [
  '# Mavericks operating model — not for distribution',
  'BACKLOG.md',
  'TASK_STATUS.md',
  'PROCESS_STATE.md',
  'PROCESS_STATE.json',
  'EXECUTION_LOG.md',
  '.claude/',
  '.mavp/',
  'SKILL_PROPOSALS/',
  'scripts/mavp-operator',
  'scripts/mavp-operator-agent.js',
  'scripts/mavp-operator-close-session.js',
];

// Project-specific files: templates, may have project customizations
// Core framework files (lib, dashboard, snapshot, validator) stay in mavericks only.
const PROJECT_FILES = [
  'mavp-operator-agent.js',
  'mavp-operator-close-session.js',
];

const BASH_FILE = 'mavp-operator';

function readUtf8(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { return null; }
}

/**
 * Write an executable file atomically: temp file → chmod → rename.
 *
 * Why: when this script is invoked THROUGH the bash wrapper it is about to
 * regenerate (e.g. `./scripts/mavp-operator --install --update .`), an
 * in-place truncate-rewrite (fs.writeFileSync directly on the destination)
 * mutates the very inode the running bash process has open and is reading
 * from. Bash's read offset into that file is invalidated mid-execution,
 * producing a spurious "syntax error" and non-zero exit even though the
 * update itself succeeded. Writing to a temp file and renaming over the
 * destination is atomic on POSIX filesystems — the running bash process
 * keeps its original inode/fd untouched; only the directory entry flips.
 *
 * The mode is set on the temp file BEFORE the rename so there is no window
 * where the destination is non-executable, and so the result is umask-proof.
 */
function writeExecutableAtomicSync(dst, content) {
  const tmp = dst + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort cleanup */ }
    throw e;
  }
}

/**
 * Content-sniff identity check for the "refusal guard" (T-406): is `content` a
 * canonical, self-referential mavericks wrapper — one that dispatches core
 * commands via `$SCRIPT_DIR/mavp-operator-dashboard.js` directly and does NOT
 * export MAVERICKS_PROJECT_ROOT? That shape only occurs in mavericks' own
 * checked-in scripts/mavp-operator (this is exactly the canonical wrapper
 * mavericks ships for itself — see scripts/mavp-operator in this repo). The
 * adopter wrapper produced by buildBashWrapper() always exports
 * MAVERICKS_PROJECT_ROOT, so the two forms are mutually exclusive by
 * construction. Used to refuse downgrading a canonical wrapper found at a
 * non-self-install target (e.g. installer run from one mavericks checkout
 * against a different mavericks checkout's directory).
 */
function isCanonicalSelfReferentialWrapperContent(content) {
  if (typeof content !== 'string') return false;
  return content.includes('$SCRIPT_DIR/mavp-operator-dashboard.js') && !content.includes('MAVERICKS_PROJECT_ROOT');
}

function buildBashWrapper(mavericksDirHint) {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

MAVERICKS="\${MAVERICKS_HOME:-$( [ -d "$HOME/.mavericks" ] && printf %s "$HOME/.mavericks" || printf %s "$HOME/Documents/mavericks" )}/scripts"

export MAVERICKS_PROJECT_ROOT="$PROJECT_ROOT"
export MAVERICKS_SCRIPTS="$MAVERICKS"

if [[ "\${1-}" == "--help" ]]; then
  echo "Usage: ./scripts/mavp-operator [flag]"
  echo ""
  echo "Flags:"
  echo "  --agent          Print session context summary for the Main Agent"
  echo "  --watch          Dashboard watch mode (r = refresh, s = snapshot, q = quit)"
  echo "  --snapshot       Print a text snapshot of current project state"
  echo "  --emit-bundle    Print a task's context prefetch bundle to stdout (read-only)"
  echo "                   Usage: --emit-bundle T-NNN"
  echo "  --handoff        Write HANDOFF.md context file for cross-session continuity"
  echo "  --close-session  Run end-of-session ritual (summarise, bump wave, commit)"
  echo "  --set-strategy-note  Set wave strategy context note (persists until --close-session)"
  echo "  --new-task       Interactively create and register a new task"
  echo "  --quick-task     Quickly register a task skeleton (title + problem only)"
  echo "  --apply-decomposition [FILE]  Parse architect decomposition block and register tasks"
  echo "  --quick-merge    Fast-track an XS change directly to merged (title + commit hash)"
  echo "  --update-task    Interactively update an existing task"
  echo "  --merge-task     Promote a qa_passed task to merged with evidence"
  echo "  --update-status  Atomically set task status in BACKLOG.md + TASK_STATUS.md"
  echo "  --set-status     Batch-update status for one or more tasks (comma-separated IDs)"
  echo "  --rename-task    Atomically rename a task title in BACKLOG.md and TASK_STATUS.md"
  echo "  --rescope-task   Atomically re-scope or un-defer a task"
  echo "  --sync-status    Sync TASK_STATUS.md Status lines from BACKLOG.md Active Wave"
  echo "  --arm-recheck    Register a time-based recheck entry in PROCESS_STATE.json"
  echo "  --ack-recheck    Acknowledge (or --rearm) a recheck entry"
  echo "  --reflect-skill <role>   Run skill reflection loop for a role (SkillOpt)"
  echo "  --validate       Run the MavP validator (artifact sync check)"
  echo "  --check-sync     Compare agent/skill files in known projects against mavericks source"
  echo "  --install        Bootstrap Mavericks into a target project directory"
  echo "  --strip          Remove all Mavericks files from a project (pre-publish)"
  echo "  --demo           Run a narrated walkthrough of the operator loop against a throwaway fixture"
  echo "                   Usage: --demo [--phase dashboard|lifecycle|drift|all] [--step] [--keep] [--no-color] [--reveal <ms>]"
  echo "  --version        Print the installed Mavericks framework version"
  echo "  --help           Show this help message and exit"
  echo ""
  echo "(no flag)          Open the operator dashboard"
  exit 0
elif [[ "\${1-}" == "--snapshot" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-snapshot.js" "$@"
elif [[ "\${1-}" == "--emit-bundle" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-emit-bundle.js" "$@"
elif [[ "\${1-}" == "--handoff" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-handoff.js" "$@"
elif [[ "\${1-}" == "--agent" ]]; then
  shift
  node "$SCRIPT_DIR/mavp-operator-agent.js" "$@"
elif [[ "\${1-}" == "--close-session" ]]; then
  shift
  node "$SCRIPT_DIR/mavp-operator-close-session.js" "$@"
elif [[ "\${1-}" == "--set-strategy-note" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-set-strategy-note.js" "$@"
elif [[ "\${1-}" == "--new-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-new-task.js" "$@"
elif [[ "\${1-}" == "--quick-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-quick-task.js" "$@"
elif [[ "\${1-}" == "--apply-decomposition" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-apply-decomposition.js" "$@"
elif [[ "\${1-}" == "--quick-merge" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-quick-merge.js" "$@"
elif [[ "\${1-}" == "--update-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-update-task.js" "$@"
elif [[ "\${1-}" == "--merge-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-merge-task.js" "$@"
elif [[ "\${1-}" == "--update-status" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-update-status.js" "$@"
elif [[ "\${1-}" == "--set-status" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-set-status.js" "$@"
elif [[ "\${1-}" == "--rename-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-rename-task.js" "$@"
elif [[ "\${1-}" == "--rescope-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-rescope-task.js" "$@"
elif [[ "\${1-}" == "--sync-status" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-sync-status.js" "$@"
elif [[ "\${1-}" == "--reflect-skill" ]]; then
  ROLE="\$2"
  shift 2
  node "$MAVERICKS/mavp-skill-reflect.js" "\$ROLE"
elif [[ "\${1-}" == "--arm-recheck" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-arm-recheck.js" "$@"
elif [[ "\${1-}" == "--ack-recheck" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-ack-recheck.js" "$@"
elif [[ "\${1-}" == "--validate" ]]; then
  shift
  node "$MAVERICKS/mavp-validator.js" "$PROJECT_ROOT" "$@"
elif [[ "\${1-}" == "--check-sync" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-check-sync.js" "$@"
elif [[ "\${1-}" == "--install" ]]; then
  shift
  node "$MAVERICKS/mavp-install.js" "$@"
elif [[ "\${1-}" == "--strip" ]]; then
  shift
  node "$MAVERICKS/mavp-install.js" --strip "$PROJECT_ROOT" "$@"
elif [[ "\${1-}" == "--version" ]]; then
  node -e "const {MAVERICKS_VERSION}=require('$MAVERICKS/mavp-version.js');console.log('mavericks v'+MAVERICKS_VERSION);"
elif [[ "\${1-}" == "--demo" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-demo.js" "$@"
else
  node "$MAVERICKS/mavp-operator-dashboard.js" "$@"
fi
`;
}

/**
 * Build the hardened PostToolUse validator hook command for a freshly bootstrapped
 * project's .claude/settings.local.json.
 *
 * Ported from mavericks' own .claude/settings.local.json hook. Three protections
 * over the naive "validate on every Edit/Write" hook:
 *   1. File-path filter — only fires on BACKLOG.md / TASK_STATUS.md edits.
 *      File-path extraction reads the hook payload from stdin with `node -e`
 *      (NOT python3 — downstream environments may lack it; node is already a
 *      hard dependency of this framework).
 *   2. Debounce — a gitignored timestamp file (.mavp-hook-ts) ensures that only
 *      the last edit in a rapid burst (e.g. two mirror edits in one turn) runs
 *      the validator; earlier invocations exit 0 silently once superseded.
 *   3. Auto-sync — BACKLOG.md edits run mavp-operator-sync-status.js BEFORE
 *      validating, so mirrored status edits do not trip a transient mismatch.
 * The hook always exits 0: validator output is advisory only, surfaced via
 * stderr, never blocking the tool call.
 *
 * MAVERICKS_PROJECT_ROOT is exported before invoking framework scripts:
 * mavp-operator-sync-status.js resolves its target root from that env var
 * (falling back to `__dirname/..`, i.e. the mavericks framework checkout
 * itself, NOT process.cwd()). Without this export the sync step would
 * silently operate on the mavericks framework's own BACKLOG.md instead of
 * the bootstrapped project's — since here the scripts are referenced
 * out-of-tree (direct-reference model), unlike mavericks-on-itself where
 * framework and target happen to be the same repo.
 */
function buildPostToolUseHookCommand(targetDir) {
  return `INPUT=$(cat); FP=$(node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write((d.tool_input&&d.tool_input.file_path)||'')}catch(e){}" <<< "$INPUT"); case "$FP" in *BACKLOG.md|*TASK_STATUS.md) ;; *) exit 0 ;; esac; MAVERICKS="\${MAVERICKS_HOME:-$( [ -d "$HOME/.mavericks" ] && printf %s "$HOME/.mavericks" || printf %s "$HOME/Documents/mavericks" )}/scripts"; MAVROOT="${targetDir}"; export MAVERICKS_PROJECT_ROOT="$MAVROOT"; TS=$(node -e "process.stdout.write(String(Date.now()))"); echo "$TS" > "$MAVROOT/.mavp-hook-ts"; sleep 1.5; CURRENT_TS=$(cat "$MAVROOT/.mavp-hook-ts" 2>/dev/null); if [ "$CURRENT_TS" != "$TS" ]; then exit 0; fi; rm -f "$MAVROOT/.mavp-hook-ts"; cd "$MAVROOT"; case "$FP" in *BACKLOG.md) node "$MAVERICKS/mavp-operator-sync-status.js" 1>&2 ;; esac; VOUT=$(node "$MAVERICKS/mavp-validator.js" 2>&1); VCODE=$?; [ $VCODE -ne 0 ] && printf '%s\\n' "$VOUT" >&2 || true; exit 0`;
}

// Sentinel-prefixed identity token for the opt-in transcript-archive SessionStart
// hook (T-422) — same pattern as MANAGED_HOOK_SENTINEL below: `:` is bash's
// true no-op builtin, so this is inert at runtime but lets isManagedTranscriptArchiveCommand()
// always recognise "this is the mavericks-managed transcript-archive hook" even if the
// composed command body changes shape. Also matched on the sweep script's own filename
// so a hand-written or pre-sentinel entry is still recognised.
const TRANSCRIPT_ARCHIVE_HOOK_SENTINEL = ': mavp-transcript-archive-hook;';
const TRANSCRIPT_ARCHIVE_IDENTITY_TOKEN = 'mavp-transcript-archive.js';

/**
 * Build the managed SessionStart command that sweeps this project's Claude
 * Code transcripts into .mavp/transcripts/ (T-422). Resolves the mavericks
 * scripts dir the same way every other managed/lifecycle hook command does
 * (MAVERICKS_HOME env var > ~/.mavericks > ~/Documents/mavericks), `cd`s into
 * the target project (mavp-transcript-archive.js derives both the source
 * transcript dir and the destination archive dir from its own cwd), and
 * always exits 0 — the sweep script itself never exits non-zero, but the
 * trailing `; exit 0` also guards against a `cd` failure (e.g. the project
 * directory having been moved/deleted since bootstrap).
 */
function buildTranscriptArchiveHookCommand(targetDir) {
  return `${TRANSCRIPT_ARCHIVE_HOOK_SENTINEL} MAVERICKS="\${MAVERICKS_HOME:-$( [ -d "$HOME/.mavericks" ] && printf %s "$HOME/.mavericks" || printf %s "$HOME/Documents/mavericks" )}/scripts"; cd "${targetDir}" && node "$MAVERICKS/mavp-transcript-archive.js"; exit 0`;
}

/**
 * Identity check: "is this SessionStart hook entry the mavericks-managed
 * transcript-archive sweep hook?" Matches on either the sweep script's
 * filename or the explicit sentinel prefix — mirrors isManagedPostToolUseCommand().
 */
function isManagedTranscriptArchiveCommand(command) {
  if (typeof command !== 'string') return false;
  return command.includes(TRANSCRIPT_ARCHIVE_IDENTITY_TOKEN) || command.startsWith(TRANSCRIPT_ARCHIVE_HOOK_SENTINEL);
}

// Legacy pre-T-329 validator filename — still checked as a hook-identity signal
// so already-bootstrapped projects on the old name get upgraded by --update.
const OLD_VALIDATOR = 'parliamentary-validator-parser-v1.js';
const NEW_VALIDATOR = 'mavp-validator.js';
// Debounce timestamp filename used by the hardened PostToolUse hook (also a
// hook-identity signal — see isManagedPostToolUseCommand()).
const HOOK_DEBOUNCE_TOKEN = '.mavp-hook-ts';
// Leading no-op prefix embedded in every command composePostToolUseHookCommand()
// produces. `:` is bash's true no-op builtin — it ignores its argument and always
// exits 0 — so this is inert at runtime, but its literal text lets future --update
// runs recognise "this is the mavericks-managed hook" even if the composed body
// changes shape entirely (new fragments, reordered steps, etc.).
const MANAGED_HOOK_SENTINEL = ': mavp-managed-hook;';
// Identity substring for the SessionStart/PostCompact lifecycle hooks — present
// in both commands the installer writes for those two hook events.
const LIFECYCLE_HOOK_IDENTITY_TOKEN = 'mavp-operator --agent';

/**
 * Read the `fragment` string out of a shipped hook fragment template
 * (templates/doc-sync-hook.fragment.json, templates/manifest-guard-hook.fragment.json).
 * These fragment files are the single source of truth for the add-on command
 * text — this is the only place that reads them; the strings are never
 * duplicated inline elsewhere. Returns '' if the template is missing (public
 * mirror / adopter repo without it) or malformed — callers compose safely
 * with an empty string in that case (no-op, not a crash).
 */
function readHookFragment(fragmentFileName) {
  const fragmentPath = path.join(FRAMEWORK_DIR, '..', 'templates', fragmentFileName);
  const raw = readUtf8(fragmentPath);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.fragment === 'string' ? parsed.fragment : '';
  } catch {
    return '';
  }
}

/**
 * Compose the full managed PostToolUse command for a target project: the
 * hardened validator base (buildPostToolUseHookCommand) with the doc-sync and
 * manifest-guard fragments (read live from templates/ at install/update time —
 * see readHookFragment) inserted before the trailing `exit 0`, and the whole
 * thing prefixed with MANAGED_HOOK_SENTINEL so a future --update can always
 * recognise and replace this exact managed entry (see isManagedPostToolUseCommand).
 */
function composePostToolUseHookCommand(targetDir) {
  const base = buildPostToolUseHookCommand(targetDir);
  const TRAILING = '; exit 0';
  const baseBody = base.endsWith(TRAILING) ? base.slice(0, -TRAILING.length) : base;
  const docSyncFragment = readHookFragment('doc-sync-hook.fragment.json');
  const manifestGuardFragment = readHookFragment('manifest-guard-hook.fragment.json');
  return `${MANAGED_HOOK_SENTINEL} ${baseBody}${docSyncFragment}${manifestGuardFragment}${TRAILING}`;
}

/**
 * Identity check: "is this PostToolUse hook entry the mavericks-managed
 * validator hook?" Matches on ANY of: the current validator filename, the
 * legacy pre-T-329 filename (upgrade path), the debounce token, or the
 * explicit sentinel emitted by composePostToolUseHookCommand. A single match
 * is sufficient — the command only needs to be recognisable as "the mavp
 * hook", not contain every token.
 */
function isManagedPostToolUseCommand(command) {
  if (typeof command !== 'string') return false;
  return (
    command.includes(NEW_VALIDATOR) ||
    command.includes(OLD_VALIDATOR) ||
    command.includes(HOOK_DEBOUNCE_TOKEN) ||
    command.startsWith(MANAGED_HOOK_SENTINEL)
  );
}

/**
 * Idempotent hooks merge for `--update` (T-404). Reads (or seeds) the target
 * project's .claude/settings.local.json and:
 *   (a) replaces the command of the managed PostToolUse Edit|Write entry
 *       (identity: isManagedPostToolUseCommand) with the freshly composed one;
 *   (b) appends a managed entry when none is found;
 *   (c) adds SessionStart/PostCompact lifecycle hooks only if absent
 *       (identity: command contains "mavp-operator --agent");
 *   (d) never touches any entry that doesn't match an identity check —
 *       operator-authored hooks (e.g. a custom Bash-matcher entry) survive
 *       byte-identical, in original order;
 *   (e) ensures `.mavp-hook-ts` is gitignored;
 *   (f) prints one console line per change made, and a visible warning
 *       (never a silent skip) when settings.local.json exists but is
 *       malformed JSON;
 *   (g) opt-in only (T-422): when `opts.transcriptArchive` is true, also
 *       merges the sentinel-identified transcript-archive SessionStart hook
 *       (identity: isManagedTranscriptArchiveCommand) — appended only if
 *       absent AND the flag is set; if the entry is already present from a
 *       prior run, its command is refreshed on every call regardless of the
 *       flag (an already-opted-in project is never silently opted back out),
 *       and `.mavp/transcripts/` is ensured in .gitignore whenever the entry
 *       exists or is being newly added.
 * Returns the number of individual hook changes made (0 if none, or skipped
 * due to malformed JSON).
 */
function mergeManagedHooks(targetDir, opts = {}) {
  const settingsLocalPath = path.join(targetDir, '.claude', 'settings.local.json');
  let settingsLocal = {};
  if (fs.existsSync(settingsLocalPath)) {
    const raw = fs.readFileSync(settingsLocalPath, 'utf8');
    try {
      settingsLocal = JSON.parse(raw);
    } catch (e) {
      console.log(`  ${RED}${BOLD}WARNING:${RESET} ${RED}.claude/settings.local.json is malformed JSON — hooks merge skipped (${e.message})${RESET}`);
      return 0;
    }
  }
  if (!settingsLocal || typeof settingsLocal !== 'object' || Array.isArray(settingsLocal)) {
    console.log(`  ${RED}${BOLD}WARNING:${RESET} ${RED}.claude/settings.local.json is not a JSON object — hooks merge skipped${RESET}`);
    return 0;
  }

  let changeCount = 0;
  if (!settingsLocal.hooks || typeof settingsLocal.hooks !== 'object' || Array.isArray(settingsLocal.hooks)) {
    settingsLocal.hooks = {};
  }

  // --- PostToolUse: replace the managed entry's command, or append if absent ---
  if (!Array.isArray(settingsLocal.hooks.PostToolUse)) settingsLocal.hooks.PostToolUse = [];
  const newCommand = composePostToolUseHookCommand(targetDir);
  let foundManaged = false;
  for (const entry of settingsLocal.hooks.PostToolUse) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && isManagedPostToolUseCommand(h.command)) {
        foundManaged = true;
        if (h.command !== newCommand) {
          h.command = newCommand;
          changeCount++;
          console.log(`  ${YELLOW}updated${RESET}  .claude/settings.local.json ${DIM}(hooks.PostToolUse managed validator hook command refreshed)${RESET}`);
        }
      }
    }
  }
  if (!foundManaged) {
    settingsLocal.hooks.PostToolUse.push({
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: newCommand }],
    });
    changeCount++;
    console.log(`  ${GREEN}new${RESET}     .claude/settings.local.json ${DIM}(hooks.PostToolUse managed validator hook appended)${RESET}`);
  }

  // --- SessionStart / PostCompact: add only if absent ---
  const ensureLifecycleHook = (hookName, command) => {
    if (!Array.isArray(settingsLocal.hooks[hookName])) settingsLocal.hooks[hookName] = [];
    const present = settingsLocal.hooks[hookName].some(
      entry => entry && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(LIFECYCLE_HOOK_IDENTITY_TOKEN))
    );
    if (!present) {
      settingsLocal.hooks[hookName].push({ hooks: [{ type: 'command', command }] });
      changeCount++;
      console.log(`  ${GREEN}new${RESET}     .claude/settings.local.json ${DIM}(hooks.${hookName} added)${RESET}`);
    }
  };
  ensureLifecycleHook('SessionStart', `cd ${targetDir} && ./scripts/mavp-operator --agent`);
  ensureLifecycleHook('PostCompact', `cd ${targetDir} && echo '=== STATE RESTORED AFTER COMPACTION ===' && ./scripts/mavp-operator --agent`);

  // --- SessionStart: opt-in transcript-archive sweep hook (T-422) ---
  // Unlike the lifecycle hooks above (always added if absent), this entry is
  // ONLY appended when opts.transcriptArchive is true — installing without
  // --transcript-archive must add no such entry. Once present, though, its
  // command is refreshed on every call regardless of the flag (an
  // already-opted-in project is never silently opted back out by a plain
  // `--update`).
  if (!Array.isArray(settingsLocal.hooks.SessionStart)) settingsLocal.hooks.SessionStart = [];
  const newTranscriptArchiveCommand = buildTranscriptArchiveHookCommand(targetDir);
  let foundTranscriptArchive = false;
  for (const entry of settingsLocal.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && isManagedTranscriptArchiveCommand(h.command)) {
        foundTranscriptArchive = true;
        if (h.command !== newTranscriptArchiveCommand) {
          h.command = newTranscriptArchiveCommand;
          changeCount++;
          console.log(`  ${YELLOW}updated${RESET}  .claude/settings.local.json ${DIM}(hooks.SessionStart transcript-archive hook command refreshed)${RESET}`);
        }
      }
    }
  }
  if (!foundTranscriptArchive && opts.transcriptArchive) {
    settingsLocal.hooks.SessionStart.push({ hooks: [{ type: 'command', command: newTranscriptArchiveCommand }] });
    changeCount++;
    console.log(`  ${GREEN}new${RESET}     .claude/settings.local.json ${DIM}(hooks.SessionStart transcript-archive sweep hook appended — --transcript-archive)${RESET}`);
  }
  if (foundTranscriptArchive || opts.transcriptArchive) {
    const transcriptGitignoreResult = ensureGitignoreEntry(targetDir, '.mavp/transcripts/');
    if (transcriptGitignoreResult !== 'exists') {
      console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(.mavp/transcripts/ archive dir ${transcriptGitignoreResult})${RESET}`);
    }
  }

  if (changeCount > 0) {
    const claudeDirForHooks = path.dirname(settingsLocalPath);
    if (!fs.existsSync(claudeDirForHooks)) fs.mkdirSync(claudeDirForHooks, { recursive: true });
    fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2) + '\n', 'utf8');
  }

  const gitignoreResult = ensureHookDebounceGitignoreEntry(targetDir);
  if (gitignoreResult !== 'exists') {
    console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(.mavp-hook-ts debounce file ${gitignoreResult})${RESET}`);
  }

  return changeCount;
}

/**
 * Ensure a single entry is present in the target project's .gitignore. Idempotent.
 * Returns 'created' | 'added' | 'exists'.
 */
function ensureGitignoreEntry(targetDir, entry) {
  const gitignorePath = path.join(targetDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : null;
  if (existing !== null && existing.split('\n').map(l => l.trim()).includes(entry)) {
    return 'exists';
  }
  const base = existing || '';
  const sep = base.length && !base.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, base + sep + entry + '\n', 'utf8');
  return existing === null ? 'created' : 'added';
}

/**
 * Ensure the debounce timestamp file used by the hardened PostToolUse hook
 * (.mavp-hook-ts) is gitignored in the target project. Idempotent.
 * Returns 'created' | 'added' | 'exists'.
 */
function ensureHookDebounceGitignoreEntry(targetDir) {
  return ensureGitignoreEntry(targetDir, '.mavp-hook-ts');
}

/**
 * Ensure the seeded ONBOARDING.md (consumed and deleted by session-start on
 * first use) is gitignored in the target project — keeps consume-and-delete
 * from dirtying the tree and prevents the seeded copy from ever being
 * committed. Idempotent.
 * Returns 'created' | 'added' | 'exists'.
 */
function ensureOnboardingGitignoreEntry(targetDir) {
  return ensureGitignoreEntry(targetDir, 'ONBOARDING.md');
}

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Append mavericks ignore patterns to an ignore file (npmignore / dockerignore).
 * Adds a clearly marked block; skips if block already present.
 */
function appendIgnorePatterns(filePath, label) {
  const marker = '# Mavericks operating model — not for distribution';
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (existing.includes(marker)) return 'exists';
  const block = '\n' + MAVERICKS_IGNORE_PATTERNS.join('\n') + '\n';
  fs.writeFileSync(filePath, existing + block, 'utf8');
  return 'added';
}

/**
 * Emit the deploy-ci paths-ignore fragment into templates/ of the target project.
 * Idempotent — skips if the file already exists.
 * Returns 'added', 'exists', or 'skipped' (if source template not found in framework).
 */
function emitDeployCiFragment(targetDir) {
  const FRAGMENT_NAME = 'deploy-ci-paths-ignore.fragment.yml';
  const srcPath = path.join(FRAMEWORK_DIR, '..', 'templates', FRAGMENT_NAME);
  if (!fs.existsSync(srcPath)) return 'skipped';

  const templatesDir = path.join(targetDir, 'templates');
  const dstPath = path.join(templatesDir, FRAGMENT_NAME);

  // Idempotent: do not clobber an existing file
  if (fs.existsSync(dstPath)) return 'exists';

  if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
  return 'added';
}

/**
 * Copy the pre-commit hook to .claude/hooks/ and configure git core.hooksPath.
 * Returns 'installed', 'updated', or 'skipped' (if source hook not found).
 */
function installHook(targetDir) {
  const HOOK_SOURCE = path.join(FRAMEWORK_DIR, '..', '.claude', 'hooks', 'pre-commit');
  if (!fs.existsSync(HOOK_SOURCE)) return 'skipped';

  const hooksDir = path.join(targetDir, '.claude', 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookDst = path.join(hooksDir, 'pre-commit');
  const existed = fs.existsSync(hookDst);
  fs.copyFileSync(HOOK_SOURCE, hookDst);
  fs.chmodSync(hookDst, 0o755);

  try {
    execSync('git config core.hooksPath .claude/hooks/', { cwd: targetDir, stdio: 'ignore' });
  } catch {
    // not a git repo or git not available — hook is still copied, user can configure manually
  }

  return existed ? 'updated' : 'installed';
}

/**
 * Determine whether targetDir is inside a git working tree.
 * Degrades safely: any failure (not a repo, git not installed) returns false.
 */
function isGitWorkTree(targetDir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a path's git-recoverability for the --strip deletion manifest.
 * Returns { label, irrecoverable }.
 *
 * irrecoverable=true means: deleting this path loses data that git cannot restore
 * (untracked/ignored content, or a directory containing untracked files, or a path
 * we could not verify — fail toward the louder warning, never crash).
 *
 * irrecoverable=false (but still may warn) means: the path is fully tracked; even
 * with local uncommitted changes, `git checkout`/history can restore committed content.
 */
function classifyPath(targetDir, rel, gitAvailable) {
  if (!gitAvailable) {
    return { label: 'NOT TRACKED — IRRECOVERABLE', irrecoverable: true };
  }
  try {
    const lsOut = execFileSync('git', ['ls-files', '--', rel], { cwd: targetDir, encoding: 'utf8' }).trim();
    const trackedFiles = lsOut ? lsOut.split('\n').filter(Boolean) : [];
    if (trackedFiles.length === 0) {
      return { label: 'NOT TRACKED — IRRECOVERABLE', irrecoverable: true };
    }
    // --ignored is needed so ignored files nested inside an otherwise-tracked
    // directory (e.g. .claude/settings.local.json under a global gitignore rule)
    // are still surfaced as untracked-equivalent — fail toward the louder warning.
    const statusOut = execFileSync('git', ['status', '--porcelain', '--ignored', '--', rel], { cwd: targetDir, encoding: 'utf8' });
    const statusLines = statusOut.split('\n').filter(Boolean);
    const untrackedLines = statusLines.filter(l => l.startsWith('??') || l.startsWith('!!'));
    const modifiedLines = statusLines.filter(l => !l.startsWith('??') && !l.startsWith('!!'));

    let label = 'tracked';
    let irrecoverable = false;
    if (modifiedLines.length > 0) {
      label = 'tracked, uncommitted changes (will be lost)';
    }
    if (untrackedLines.length > 0) {
      label += ', contains untracked files';
      irrecoverable = true;
    }
    return { label, irrecoverable };
  } catch {
    return { label: 'cannot verify — irrecoverable', irrecoverable: true };
  }
}

/**
 * Remove a single path, symlink-safe: uses lstatSync so a symlinked path is
 * unlinked as a link, never recursed into via its target.
 */
function removeStripPath(targetDir, rel) {
  const fullPath = path.join(targetDir, rel);
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(fullPath);
  } else if (stat.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(fullPath);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const updateOnly = args.includes('--update');
  const stripMode = args.includes('--strip');
  const hooksOnlyMode = args.includes('--hooks-only');
  const yesFlag = args.includes('--yes') || args.includes('-y');
  const noHooksFlag = args.includes('--no-hooks');
  const transcriptArchiveFlag = args.includes('--transcript-archive');
  const targetArg = args.find(a => !a.startsWith('-'));
  const targetDir = targetArg ? path.resolve(targetArg) : process.cwd();
  const targetScripts = path.join(targetDir, 'scripts');

  console.log(`\n${BOLD}Mavericks Bootstrap${RESET} ${DIM}v${MAVERICKS_VERSION}${RESET}`);
  console.log(`${DIM}Framework: ${FRAMEWORK_DIR}${RESET}`);
  console.log(`${DIM}Target:    ${targetScripts}${RESET}\n`);
  console.log(`${DIM}Core framework scripts (dashboard, lib, snapshot, validator) are used directly`);
  console.log(`from mavericks — not copied. Resolved as ~/.mavericks (canonical), falling back to`);
  console.log(`~/Documents/mavericks (legacy) — set MAVERICKS_HOME to override.${RESET}\n`);

  if (!fs.existsSync(targetDir)) {
    console.error(`${RED}Target directory not found: ${targetDir}${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Self-install detection (T-406): is targetDir actually the mavericks framework's
  // own root (FRAMEWORK_DIR's parent)? Compared via fs.realpathSync on BOTH sides so
  // a symlinked home (e.g. ~/.mavericks -> ~/Documents/mavericks) is still caught.
  // Degrades to false (never throws) on any realpath failure.
  let selfInstall = false;
  try {
    selfInstall = fs.realpathSync(targetDir) === fs.realpathSync(path.join(FRAMEWORK_DIR, '..'));
  } catch {
    selfInstall = false;
  }
  if (selfInstall) {
    console.log(`${CYAN}self-install detected: framework files are the source here; syncing config/hooks only${RESET}\n`);
  }

  // --hooks-only (T-406): sync ONLY the managed hooks (+ their .mavp-hook-ts gitignore
  // step) into .claude/settings.local.json. Touches no other file — the safe, narrow
  // command for activating/refreshing hooks, and the canonical command for the
  // self-install case above.
  if (hooksOnlyMode) {
    console.log(`${BOLD}Hooks-only mode${RESET} — syncing managed hooks only\n`);
    const hookChanges = mergeManagedHooks(targetDir, { transcriptArchive: transcriptArchiveFlag });
    console.log(`\n${GREEN}✓ Hooks-only sync complete.${RESET} ${hookChanges} change(s) made to .claude/settings.local.json.\n`);
    return;
  }

  // Check project-specific files
  const results = PROJECT_FILES.map(file => {
    const dst = readUtf8(path.join(targetScripts, file));
    const exists = dst !== null;
    return { file, exists, isNew: !exists };
  });

  const bashDst = readUtf8(path.join(targetScripts, BASH_FILE));
  const bashExists = bashDst !== null;

  // Print status
  const bashLabel = bashExists ? `${DIM}exists${RESET}` : `${GREEN}NEW${RESET}`;
  console.log(`  ${bashLabel}  ${BASH_FILE} ${DIM}(bash wrapper)${RESET}`);
  for (const r of results) {
    const label = r.exists ? `${DIM}exists${RESET}` : `${GREEN}NEW${RESET}`;
    console.log(`  ${label}  ${r.file} ${DIM}(project-specific)${RESET}`);
  }
  console.log('');

  const newFiles = results.filter(r => r.isNew);
  const needsBash = !bashExists;
  const nothingToDo = newFiles.length === 0 && !needsBash;

  if (updateOnly) {
    // --update: re-sync entire framework from mavericks, overwriting existing files
    console.log(`${BOLD}Update mode${RESET} — re-syncing framework (scripts + .claude/) from mavericks\n`);
    const CLAUDE_SOURCE = path.join(FRAMEWORK_DIR, '..', '.claude');
    const CLAUDE_TARGET = path.join(targetDir, '.claude');
    const CLAUDE_DIRS = ['agents', 'skills', 'rules'];
    let updatedCount = 0;

    // Self-install (T-406): .claude/{agents,skills,rules} ARE the source here —
    // copying them onto themselves is a misleading no-op at best. Skip entirely.
    if (selfInstall) {
      console.log(`  ${DIM}skipped${RESET}  .claude/{${CLAUDE_DIRS.join(',')}} ${DIM}(self-install — framework files are the source)${RESET}`);
    } else {
      for (const dir of CLAUDE_DIRS) {
        const srcDir = path.join(CLAUDE_SOURCE, dir);
        if (!fs.existsSync(srcDir)) continue;
        const dstDir = path.join(CLAUDE_TARGET, dir);

        function updateDirRecursive(src, dst, relBase) {
          if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
          for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (entry.name === '.DS_Store') continue;
            const srcPath = path.join(src, entry.name);
            const dstPath = path.join(dst, entry.name);
            const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
            const isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory());
            if (isDir) {
              updateDirRecursive(srcPath, dstPath, relPath);
            } else {
              const existed = fs.existsSync(dstPath);
              fs.copyFileSync(srcPath, dstPath);
              const label = existed ? `${YELLOW}updated${RESET}` : `${GREEN}new${RESET}   `;
              console.log(`  ${label}  .claude/${dir}/${relPath}`);
              updatedCount++;
            }
          }
        }

        updateDirRecursive(srcDir, dstDir, '');
      }
    }

    // Re-sync .claude/hooks/
    const hookResult = installHook(targetDir);
    if (hookResult === 'updated') {
      console.log(`  ${YELLOW}updated${RESET}  .claude/hooks/pre-commit`);
      updatedCount++;
    } else if (hookResult === 'installed') {
      console.log(`  ${GREEN}new${RESET}     .claude/hooks/pre-commit`);
      updatedCount++;
    }

    // Sync project-specific scripts from mavericks (agent, close-session).
    // mavp-operator-lib.js and mavp-version.js are NOT synced — projects resolve
    // them at runtime from the mavericks install via MAVERICKS_SCRIPTS (direct-reference model).
    const SYNC_SCRIPTS = [
      'mavp-operator-agent.js',
      'mavp-operator-close-session.js',
    ];
    // Self-install (T-406): these ARE the framework source files — skip the copy.
    if (selfInstall) {
      console.log(`  ${DIM}skipped${RESET}  scripts/{${SYNC_SCRIPTS.join(',')}} ${DIM}(self-install — framework files are the source)${RESET}`);
    } else {
      for (const scriptFile of SYNC_SCRIPTS) {
        const srcScript = path.join(FRAMEWORK_DIR, scriptFile);
        const dstScript = path.join(targetDir, 'scripts', scriptFile);
        if (!fs.existsSync(srcScript)) continue;
        if (!fs.existsSync(path.dirname(dstScript))) continue;
        const existed = fs.existsSync(dstScript);
        fs.copyFileSync(srcScript, dstScript);
        const label = existed ? `${YELLOW}updated${RESET}` : `${GREEN}new${RESET}   `;
        const versionSuffix = scriptFile === 'mavp-version.js' ? ` ${DIM}(→ ${MAVERICKS_VERSION})${RESET}` : '';
        console.log(`  ${label}  scripts/${scriptFile}${versionSuffix}`);
        updatedCount++;
      }
    }

    // Re-sync the generated bash wrapper (scripts/mavp-operator) from the current
    // (flag-parity) buildBashWrapper() output — overwrites the existing wrapper,
    // same "overwrites existing" contract used for agent.js/close-session.js above.
    // This is what brings restored flags + correct validator routing (mavp-validator.js
    // with "$PROJECT_ROOT") to already-bootstrapped projects, which fresh-install-only
    // wiring never reached.
    //
    // Self-install (T-406): scripts/mavp-operator IS the canonical wrapper here — skip
    // the rewrite entirely (it would downgrade the canonical form to the adopter form).
    //
    // Content-sniff refusal guard (T-406, non-self targets): if an EXISTING wrapper is
    // already in canonical self-referential form (dispatches via
    // "$SCRIPT_DIR/mavp-operator-dashboard.js", no MAVERICKS_PROJECT_ROOT export), refuse
    // to overwrite it — this catches the installer being run from one mavericks checkout
    // against a *different* mavericks checkout's directory (not self-install by realpath,
    // but still a canonical wrapper that must not be downgraded).
    if (selfInstall) {
      console.log(`  ${DIM}skipped${RESET}  scripts/${BASH_FILE} ${DIM}(self-install — this IS the canonical wrapper)${RESET}`);
    } else {
      const wrapperDst = path.join(targetDir, 'scripts', BASH_FILE);
      if (fs.existsSync(path.dirname(wrapperDst))) {
        const existedWrapper = fs.existsSync(wrapperDst);
        const existingWrapperContent = existedWrapper ? readUtf8(wrapperDst) : null;
        if (existedWrapper && isCanonicalSelfReferentialWrapperContent(existingWrapperContent)) {
          console.log(`  ${RED}${BOLD}WARNING:${RESET} ${RED}scripts/${BASH_FILE} is in canonical self-referential form (dispatches via $SCRIPT_DIR, no MAVERICKS_PROJECT_ROOT export) — refusing to downgrade it to the adopter form. If this directory is really meant to be an adopter project, remove the existing wrapper first.${RESET}`);
        } else {
          writeExecutableAtomicSync(wrapperDst, buildBashWrapper(FRAMEWORK_DIR));
          const label = existedWrapper ? `${YELLOW}updated${RESET}` : `${GREEN}new${RESET}   `;
          console.log(`  ${label}  scripts/${BASH_FILE} ${DIM}(bash wrapper)${RESET}`);
          updatedCount++;
        }
      }
    }

    // Update mavericks_version in target project's PROCESS_STATE.json if it exists
    const psJsonPath = path.join(targetDir, 'PROCESS_STATE.json');
    if (fs.existsSync(psJsonPath)) {
      try {
        const psRaw = fs.readFileSync(psJsonPath, 'utf8');
        const ps = JSON.parse(psRaw);
        ps.mavericks_version = MAVERICKS_VERSION;
        fs.writeFileSync(psJsonPath, JSON.stringify(ps, null, 2) + '\n', 'utf8');
        console.log(`  ${GREEN}updated${RESET}  PROCESS_STATE.json ${DIM}(mavericks_version → ${MAVERICKS_VERSION})${RESET}`);
      } catch {
        // malformed JSON — skip silently
      }
    }

    // Backfill reasoning settings in .claude/settings.local.json (idempotent — add only if absent)
    const settingsLocalPath = path.join(targetDir, '.claude', 'settings.local.json');
    try {
      const REASONING_DEFAULTS = { effortLevel: 'high', alwaysThinkingEnabled: true };
      let settingsLocal = {};
      if (fs.existsSync(settingsLocalPath)) {
        settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      }
      let settingsChanged = false;
      for (const [key, value] of Object.entries(REASONING_DEFAULTS)) {
        if (!(key in settingsLocal)) {
          settingsLocal[key] = value;
          settingsChanged = true;
        }
      }
      if (settingsChanged) {
        fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2) + '\n', 'utf8');
        console.log(`  ${GREEN}updated${RESET}  .claude/settings.local.json ${DIM}(reasoning defaults backfilled)${RESET}`);
        updatedCount++;
      }
    } catch {
      // malformed or missing settings.local.json — skip silently
    }

    // Backfill fallbackModel opus safety chain in .claude/settings.local.json
    // (idempotent — add only if absent, never overwrite an existing chain)
    try {
      let settingsLocal = {};
      if (fs.existsSync(settingsLocalPath)) {
        settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
      }
      if (!('fallbackModel' in settingsLocal)) {
        settingsLocal.fallbackModel = ['claude-opus-4-8'];
        fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2) + '\n', 'utf8');
        console.log(`  ${GREEN}updated${RESET}  .claude/settings.local.json ${DIM}(fallbackModel opus safety chain backfilled)${RESET}`);
        updatedCount++;
      }
    } catch {
      // malformed or missing settings.local.json — skip silently
    }

    // Merge managed hooks into settings.local.json (T-404) — idempotent: replaces
    // the managed PostToolUse validator hook command (composed fresh from
    // buildPostToolUseHookCommand + the doc-sync/manifest-guard fragments, so this
    // single step also upgrades pre-T-329 validator-name references and picks up
    // fragment additions), appends it if absent, adds SessionStart/PostCompact only
    // if absent, and never touches any other hook entry (operator-authored hooks
    // survive byte-identical). Skipped entirely with --no-hooks.
    if (noHooksFlag) {
      console.log(`  ${DIM}--no-hooks — skipping hooks merge into .claude/settings.local.json${RESET}`);
    } else {
      const hookChanges = mergeManagedHooks(targetDir, { transcriptArchive: transcriptArchiveFlag });
      updatedCount += hookChanges;
    }

    // Backfill/migrate permissions.defaultMode into shared .claude/settings.json.
    // Three-way logic (T-319):
    //   (a) key absent               → seed 'bypassPermissions'
    //   (b) key === 'acceptEdits'    → migrate to 'bypassPermissions' (that was the
    //                                  T-315 framework-seeded default, not a deliberate
    //                                  user choice) and print a console migration line
    //   (c) key === anything else    → leave untouched (deliberate per-project opt-out)
    const sharedSettingsPathUpdate = path.join(targetDir, '.claude', 'settings.json');
    try {
      let sharedSettings = {};
      if (fs.existsSync(sharedSettingsPathUpdate)) {
        sharedSettings = JSON.parse(fs.readFileSync(sharedSettingsPathUpdate, 'utf8'));
      }
      if (!sharedSettings.permissions || typeof sharedSettings.permissions !== 'object') {
        sharedSettings.permissions = {};
      }
      if (!('defaultMode' in sharedSettings.permissions)) {
        sharedSettings.permissions.defaultMode = 'bypassPermissions';
        const claudeDirShared = path.join(targetDir, '.claude');
        if (!fs.existsSync(claudeDirShared)) fs.mkdirSync(claudeDirShared, { recursive: true });
        fs.writeFileSync(sharedSettingsPathUpdate, JSON.stringify(sharedSettings, null, 2) + '\n', 'utf8');
        console.log(`  ${GREEN}updated${RESET}  .claude/settings.json ${DIM}(permissions.defaultMode backfilled → bypassPermissions)${RESET}`);
        updatedCount++;
      } else if (sharedSettings.permissions.defaultMode === 'acceptEdits') {
        sharedSettings.permissions.defaultMode = 'bypassPermissions';
        const claudeDirShared = path.join(targetDir, '.claude');
        if (!fs.existsSync(claudeDirShared)) fs.mkdirSync(claudeDirShared, { recursive: true });
        fs.writeFileSync(sharedSettingsPathUpdate, JSON.stringify(sharedSettings, null, 2) + '\n', 'utf8');
        console.log(`  ${GREEN}updated${RESET}  .claude/settings.json ${DIM}(permissions.defaultMode migrated: acceptEdits → bypassPermissions)${RESET}`);
        updatedCount++;
      }
      // else: defaultMode is some other deliberate value (e.g. 'plan', 'default',
      // 'dontAsk', already 'bypassPermissions') — leave untouched, this is the opt-out.
    } catch {
      // malformed settings.json — skip silently
    }

    // Emit deploy-ci fragment (idempotent — skip if already present)
    const fragResultUpdate = emitDeployCiFragment(targetDir);
    if (fragResultUpdate === 'added') {
      console.log(`  ${GREEN}new${RESET}     templates/deploy-ci-paths-ignore.fragment.yml ${DIM}(deploy CI skip fragment)${RESET}`);
      updatedCount++;
    }

    console.log(`\n${GREEN}✓ Update complete.${RESET} ${updatedCount} file(s) synced from mavericks.`);
    console.log(`${DIM}Artifacts (BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.*) were not touched.${RESET}\n`);
    return;
  }

  if (stripMode) {
    // --strip: manifest-first, git-recoverability-aware, two-stage confirm removal
    const keepArtifacts = args.includes('--keep-artifacts');
    console.log(`${BOLD}${RED}Strip mode${RESET} — removing mavericks files from ${targetDir}\n`);
    console.log(`${YELLOW}WARNING: This is destructive. Ensure changes are committed before stripping.${RESET}\n`);
    if (yesFlag) {
      console.log(`${DIM}note: --yes has no effect in strip mode${RESET}\n`);
    }

    // Plumbing: regenerable by re-running the installer.
    const PLUMBING_PATHS = [
      path.join('scripts', 'mavp-operator'),
      path.join('scripts', 'mavp-operator-agent.js'),
      path.join('scripts', 'mavp-operator-close-session.js'),
      '.claude',
      '.mavp',
      '.mavp-hook-ts',
      'ONBOARDING.md',
    ];
    // State artifacts: irreplaceable project state.
    const STATE_PATHS = [
      'BACKLOG.md', 'TASK_STATUS.md', 'PROCESS_STATE.md',
      'PROCESS_STATE.json', 'EXECUTION_LOG.md', 'SKILL_PROPOSALS',
    ];

    const plumbingExisting = PLUMBING_PATHS.filter(rel => fs.existsSync(path.join(targetDir, rel)));
    const stateExisting = STATE_PATHS.filter(rel => fs.existsSync(path.join(targetDir, rel)));

    if (plumbingExisting.length === 0 && stateExisting.length === 0) {
      console.log(`${DIM}Nothing to remove.${RESET}\n`);
      return;
    }

    const gitAvailable = isGitWorkTree(targetDir);
    if (!gitAvailable) {
      console.log(`${RED}${BOLD}WARNING: ${targetDir} is NOT a git repository.${RESET}`);
      console.log(`${RED}${BOLD}ALL deletions listed below are irrecoverable.${RESET}\n`);
    }

    function printManifestGroup(heading, list) {
      console.log(`${BOLD}${heading}${RESET}`);
      const info = {};
      for (const rel of list) {
        const c = classifyPath(targetDir, rel, gitAvailable);
        info[rel] = c;
        const tagColor = c.irrecoverable ? RED : (c.label === 'tracked' ? GREEN : YELLOW);
        console.log(`  ${rel}  ${DIM}—${RESET} ${tagColor}${c.label}${RESET}`);
      }
      console.log('');
      return info;
    }

    const plumbingInfo = plumbingExisting.length
      ? printManifestGroup('Plumbing (regenerable via reinstall):', plumbingExisting)
      : {};

    const showStateGroup = !keepArtifacts && stateExisting.length > 0;
    const stateInfo = showStateGroup
      ? printManifestGroup('State artifacts (irreplaceable project data):', stateExisting)
      : {};

    // Non-interactive: print manifest, delete nothing, exit 1. No --force bypass in v1.
    if (!process.stdin.isTTY) {
      console.log(`${YELLOW}Non-interactive session detected (stdin is not a TTY).${RESET}`);
      console.log(`${YELLOW}Nothing has been deleted. Re-run this command interactively to confirm removal.${RESET}\n`);
      process.exitCode = 1;
      return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let plumbingConfirmed = false;
    if (plumbingExisting.length > 0) {
      const answer = await prompt(rl, `Remove plumbing files/dirs listed above? [y/N]: `);
      plumbingConfirmed = answer.trim().toLowerCase() === 'y';
    }

    let stateConfirmed = false;
    if (showStateGroup) {
      const anyIrrecoverable = stateExisting.some(rel => stateInfo[rel].irrecoverable);
      if (anyIrrecoverable) {
        const answer = await prompt(
          rl,
          `${RED}Some state artifacts are NOT TRACKED — IRRECOVERABLE.${RESET} Type "delete" to confirm removing state artifacts listed above: `
        );
        stateConfirmed = answer.trim().toLowerCase() === 'delete';
      } else {
        const answer = await prompt(rl, `Remove state artifacts listed above? [y/N]: `);
        stateConfirmed = answer.trim().toLowerCase() === 'y';
      }
    }

    rl.close();

    let removedCount = 0;

    if (plumbingConfirmed) {
      for (const rel of plumbingExisting) {
        removeStripPath(targetDir, rel);
        console.log(`  ${RED}removed${RESET}  ${rel}`);
        removedCount++;
      }
    } else if (plumbingExisting.length > 0) {
      console.log(`${DIM}Plumbing group: cancelled, nothing removed.${RESET}`);
    }

    if (stateConfirmed) {
      for (const rel of stateExisting) {
        removeStripPath(targetDir, rel);
        console.log(`  ${RED}removed${RESET}  ${rel}`);
        removedCount++;
      }
    } else if (showStateGroup) {
      console.log(`${DIM}State artifacts group: cancelled, nothing removed. Files left on disk.${RESET}`);
    } else if (keepArtifacts && stateExisting.length > 0) {
      console.log(`${DIM}--keep-artifacts: state artifacts left on disk untouched.${RESET}`);
    }

    console.log(`\n${GREEN}✓ Strip complete.${RESET} ${removedCount} item(s) removed.`);
    if (!stateConfirmed && stateExisting.length > 0) {
      console.log(`${DIM}State artifacts preserved on disk: ${stateExisting.join(', ')}${RESET}`);
    }
    console.log(`${DIM}Re-run installer to restore mavericks if needed.${RESET}\n`);
    return;
  }

  if (nothingToDo) {
    console.log(`${GREEN}✓ Project already bootstrapped.${RESET}`);
    console.log(`${DIM}Project-specific files exist. Edit them to add project-specific logic.${RESET}`);
    console.log(`${DIM}To sync updated agents/skills/rules: run with --update${RESET}\n`);
    return;
  }

  if (checkOnly) {
    console.log(`${YELLOW}Project not fully bootstrapped. Run without --check to initialize.${RESET}\n`);
    process.exitCode = 1;
    return;
  }

  const filesToCreate = [...(needsBash ? [BASH_FILE] : []), ...newFiles.map(r => r.file)];

  if (!process.stdin.isTTY) {
    console.log(`${DIM}Non-interactive session — creating ${filesToCreate.length} file(s) in ${targetScripts} (install is additive; only missing files are created).${RESET}`);
  } else if (yesFlag) {
    console.log(`${DIM}--yes — creating ${filesToCreate.length} file(s) in ${targetScripts} (install is additive; only missing files are created).${RESET}`);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt(rl, `Create ${filesToCreate.length} file(s) in ${targetScripts}? [Y/n]: `);
    rl.close();

    const normalizedAnswer = answer.trim().toLowerCase();
    if (normalizedAnswer === 'n' || normalizedAnswer === 'no') {
      console.log(`${DIM}Cancelled.${RESET}\n`);
      return;
    }
  }

  if (!fs.existsSync(targetScripts)) {
    fs.mkdirSync(targetScripts, { recursive: true });
  }

  // Write bash wrapper (skipped on self-install — T-406: the canonical wrapper here
  // IS the framework source, not a copy target; needsBash should normally be false
  // for the framework's own checkout anyway, but guard defensively).
  if (needsBash && selfInstall) {
    console.log(`  ${DIM}skipped${RESET}  ${BASH_FILE} ${DIM}(self-install — this IS the canonical wrapper)${RESET}`);
  } else if (needsBash) {
    const destPath = path.join(targetScripts, BASH_FILE);
    writeExecutableAtomicSync(destPath, buildBashWrapper(FRAMEWORK_DIR));
    console.log(`  ${GREEN}✓${RESET} ${BASH_FILE}`);
  }

  // Copy project-specific templates
  for (const r of newFiles) {
    const srcPath = path.join(FRAMEWORK_DIR, r.file);
    const dstPath = path.join(targetScripts, r.file);
    const src = readUtf8(srcPath);
    if (!src) {
      console.log(`  ${YELLOW}⚠ ${r.file} — template not found in framework, skipping${RESET}`);
      continue;
    }
    // NOTE: The regex patch below is superseded by the source fix in mavp-operator-agent.js
    // (line 24 now uses MAVERICKS_SCRIPTS || homedir fallback directly, so no post-copy
    // rewrite is needed). Kept here as a no-op to preserve the surrounding structure.
    const patched = src; // was: src.replace(/const VALIDATOR = path\.join\(__dirname.*?\);/s, `...`)
    fs.writeFileSync(dstPath, patched, 'utf8');
    console.log(`  ${GREEN}✓${RESET} ${r.file}`);
  }

  // Bootstrap project root artifacts from templates (only if missing)
  const TEMPLATES_DIR = path.join(FRAMEWORK_DIR, '..', 'templates');
  const ARTIFACT_TEMPLATES = [
    { template: 'BACKLOG_TEMPLATE.md', target: 'BACKLOG.md' },
    { template: 'TASK_STATUS_TEMPLATE.md', target: 'TASK_STATUS.md' },
    { template: 'PROCESS_STATE_TEMPLATE.md', target: 'PROCESS_STATE.md' },
    // MODULES.md goes in docs/ — project declares its own module types
    { template: 'MODULES.md', target: path.join('docs', 'MODULES.md') },
    // REPO_MAP.md goes in docs/ — project declares its own repo entries
    { template: 'REPO_MAP_TEMPLATE.md', target: path.join('docs', 'REPO_MAP.md') },
    // ARCHITECTURE.md goes in docs/ — project fills in its own architecture details
    { template: 'ARCHITECTURE.md', target: path.join('docs', 'ARCHITECTURE.md') },
  ];

  let artifactsCreated = 0;
  for (const { template, target } of ARTIFACT_TEMPLATES) {
    const targetPath = path.join(targetDir, target);
    if (fs.existsSync(targetPath)) continue;
    const srcPath = path.join(TEMPLATES_DIR, template);
    const src = readUtf8(srcPath);
    if (!src) continue;
    // Ensure parent directory exists (e.g. docs/)
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(targetPath, src, 'utf8');
    console.log(`  ${GREEN}✓${RESET} ${target} ${DIM}(from template)${RESET}`);
    artifactsCreated++;
  }

  // Seed ONBOARDING.md (one-time orientation, consumed and deleted by
  // session-start on first use) — only on fresh bootstrap, only if missing.
  // Gitignored so consume-and-delete never dirties the tree and the seeded
  // copy is never committed.
  const onboardingTargetPath = path.join(targetDir, 'ONBOARDING.md');
  if (!fs.existsSync(onboardingTargetPath)) {
    const onboardingSrcPath = path.join(TEMPLATES_DIR, 'ONBOARDING_TEMPLATE.md');
    const onboardingSrc = readUtf8(onboardingSrcPath);
    if (onboardingSrc) {
      fs.writeFileSync(onboardingTargetPath, onboardingSrc, 'utf8');
      console.log(`  ${GREEN}✓${RESET} ONBOARDING.md ${DIM}(from template)${RESET}`);
      artifactsCreated++;
      const onboardingGitignoreResult = ensureOnboardingGitignoreEntry(targetDir);
      if (onboardingGitignoreResult !== 'exists') {
        console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(ONBOARDING.md ${onboardingGitignoreResult})${RESET}`);
      }
    }
  }

  // Bootstrap PROCESS_STATE.json if missing
  const jsonPath = path.join(targetDir, 'PROCESS_STATE.json');
  if (!fs.existsSync(jsonPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const psTemplatePath = path.join(TEMPLATES_DIR, 'PROCESS_STATE_TEMPLATE.json');
    const psTemplateRaw = readUtf8(psTemplatePath);
    let psContent;
    if (psTemplateRaw) {
      const ps = JSON.parse(psTemplateRaw);
      ps.mavericks_version = MAVERICKS_VERSION;
      ps.last_updated = today;
      psContent = JSON.stringify(ps, null, 2) + '\n';
    } else {
      // Fallback if template file is missing
      psContent = JSON.stringify({
        initiative: 'New project',
        stage: 'execution',
        stage_owner: 'main_agent',
        wave: 1,
        wave_session: 1,
        wave_status: 'planning',
        wave_goal: null,
        wave_summary: null,
        parked_waves: [],
        active_slices: [],
        blocker: null,
        next_action: null,
        last_task_id: 0,
        last_updated: today,
        mavericks_version: MAVERICKS_VERSION,
      }, null, 2) + '\n';
    }
    fs.writeFileSync(jsonPath, psContent, 'utf8');
    console.log(`  ${GREEN}✓${RESET} PROCESS_STATE.json ${DIM}(from template)${RESET}`);
    artifactsCreated++;
  }

  // Bootstrap .claude/settings.json (shared, committed) if missing.
  // Machine-independent policy (e.g. permissions.defaultMode) belongs here, NOT in
  // settings.local.json — that file is personal/gitignored and holds machine-specific
  // hooks with absolute paths. A user's settings.local.json still wins as a personal
  // override per Claude Code's settings precedence, so this is a safe framework default.
  const sharedSettingsPath = path.join(targetDir, '.claude', 'settings.json');
  if (!fs.existsSync(sharedSettingsPath)) {
    const claudeDirShared = path.join(targetDir, '.claude');
    if (!fs.existsSync(claudeDirShared)) fs.mkdirSync(claudeDirShared, { recursive: true });
    const sharedSettings = { permissions: { defaultMode: 'bypassPermissions' } };
    fs.writeFileSync(sharedSettingsPath, JSON.stringify(sharedSettings, null, 2) + '\n', 'utf8');
    console.log(`  ${GREEN}✓${RESET} .claude/settings.json ${DIM}(shared default: permissions.defaultMode = bypassPermissions)${RESET}`);
    artifactsCreated++;
  }

  // Bootstrap .claude/settings.local.json if missing
  const settingsPath = path.join(targetDir, '.claude', 'settings.local.json');
  if (!fs.existsSync(settingsPath)) {
    const claudeDir = path.join(targetDir, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
    const settings = {
      effortLevel: 'high',
      alwaysThinkingEnabled: true,
      fallbackModel: ['claude-opus-4-8'],
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: `cd ${targetDir} && ./scripts/mavp-operator --agent`,
          }],
        }],
        PostCompact: [{
          hooks: [{
            type: 'command',
            command: `cd ${targetDir} && echo '=== STATE RESTORED AFTER COMPACTION ===' && ./scripts/mavp-operator --agent`,
          }],
        }],
        PostToolUse: [{
          matcher: 'Edit|Write',
          hooks: [{
            type: 'command',
            command: composePostToolUseHookCommand(targetDir),
          }],
        }],
      },
    };
    // --transcript-archive (T-422, opt-in, default off): wire the transcript-archive
    // sweep hook in at seed time. Fresh install has no existing hooks to merge, so
    // this is added directly rather than via mergeManagedHooks().
    if (transcriptArchiveFlag) {
      settings.hooks.SessionStart.push({
        hooks: [{ type: 'command', command: buildTranscriptArchiveHookCommand(targetDir) }],
      });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`  ${GREEN}✓${RESET} .claude/settings.local.json ${DIM}(hooks: SessionStart, PostCompact, PostToolUse [hardened: file-filter + debounce + auto-sync]; fallbackModel: opus)${RESET}`);
    artifactsCreated++;

    const gitignoreResult = ensureHookDebounceGitignoreEntry(targetDir);
    if (gitignoreResult !== 'exists') {
      console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(.mavp-hook-ts debounce file ${gitignoreResult})${RESET}`);
    }

    if (transcriptArchiveFlag) {
      console.log(`  ${GREEN}✓${RESET} .claude/settings.local.json ${DIM}(hooks.SessionStart: transcript-archive sweep hook — --transcript-archive)${RESET}`);
      const transcriptGitignoreResult = ensureGitignoreEntry(targetDir, '.mavp/transcripts/');
      if (transcriptGitignoreResult !== 'exists') {
        console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(.mavp/transcripts/ archive dir ${transcriptGitignoreResult})${RESET}`);
      }
    }
  }

  // Append mavericks patterns to .npmignore and .dockerignore
  for (const ignoreFile of ['.npmignore', '.dockerignore']) {
    const ignorePath = path.join(targetDir, ignoreFile);
    const result = appendIgnorePatterns(ignorePath, ignoreFile);
    if (result === 'added') {
      console.log(`  ${GREEN}✓${RESET} ${ignoreFile} ${DIM}(mavericks patterns appended)${RESET}`);
      artifactsCreated++;
    }
  }

  // Emit deploy-ci fragment (idempotent — skip if already present)
  const fragResult = emitDeployCiFragment(targetDir);
  if (fragResult === 'added') {
    console.log(`  ${GREEN}✓${RESET} templates/deploy-ci-paths-ignore.fragment.yml ${DIM}(deploy CI skip fragment)${RESET}`);
    artifactsCreated++;
  }

  // Bootstrap .claude/ agents, skills, and rules (only if missing)
  const CLAUDE_SOURCE = path.join(FRAMEWORK_DIR, '..', '.claude');
  const CLAUDE_TARGET = path.join(targetDir, '.claude');
  const CLAUDE_DIRS = ['agents', 'skills', 'rules'];

  for (const dir of CLAUDE_DIRS) {
    const srcDir = path.join(CLAUDE_SOURCE, dir);
    if (!fs.existsSync(srcDir)) continue;

    const dstDir = path.join(CLAUDE_TARGET, dir);

    function copyDirRecursive(src, dst, relBase) {
      if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name === '.DS_Store') continue;
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
        const isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory());
        if (isDir) {
          copyDirRecursive(srcPath, dstPath, relPath);
        } else {
          if (!fs.existsSync(dstPath)) {
            fs.copyFileSync(srcPath, dstPath);
            console.log(`  ${GREEN}✓${RESET} .claude/${dir}/${relPath} ${DIM}(from mavericks)${RESET}`);
          }
        }
      }
    }

    copyDirRecursive(srcDir, dstDir, '');
  }

  // Install pre-commit hook into .claude/hooks/ and configure git
  const hookResult = installHook(targetDir);
  if (hookResult === 'installed') {
    console.log(`  ${GREEN}✓${RESET} .claude/hooks/pre-commit ${DIM}(pre-commit hook)${RESET}`);
    console.log(`  ${GREEN}✓${RESET} git config core.hooksPath .claude/hooks/`);
  }

  console.log(`\n${GREEN}✓ Mavericks is installed in this project.${RESET}\n`);
  console.log(`Open this folder with your agent (Claude Code) and tell it what you want`);
  console.log(`to build — it drives the rest from here.\n`);
  if (fs.existsSync(path.join(targetDir, 'ONBOARDING.md'))) {
    console.log(`New here? There's a short ONBOARDING.md at the project root — your agent`);
    console.log(`walks you through it on your first session, then it removes itself.\n`);
  }
}

main().catch(err => {
  console.error(`${RED}install failed: ${err.message}${RESET}`);
  process.exitCode = 1;
});
