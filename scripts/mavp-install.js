#!/usr/bin/env node
// MAVERICKS_VERSION: 0.2.0

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
 *   node /path/to/mavericks/scripts/mavp-install.js --check <target-dir>
 *   node /path/to/mavericks/scripts/mavp-install.js --update <target-dir>
 *   node /path/to/mavericks/scripts/mavp-install.js --strip <target-dir> [--keep-artifacts]
 *
 * Modes:
 *   (default)  — copy project-specific templates if missing, show status
 *   --check    — report what would be done, exit 1 if not bootstrapped
 *   --update   — re-sync entire framework from mavericks: .claude/ + all scripts (overwrites existing)
 *                does NOT touch artifacts (BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.*)
 *   --strip    — remove mavericks files from the project (pre-publish cleanup).
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
 * Non-TTY contract — asymmetric by design:
 *   default install — when stdin is not a TTY, the file-creation prompt is skipped and the
 *                      install proceeds as if answered Y (agent Bash sessions can bootstrap
 *                      a project without hanging or silently creating nothing).
 *   --strip          — when stdin is not a TTY, prints the manifest, deletes nothing, exits 1.
 *                       This refusal is NOT bypassable by --yes (destructive action requires
 *                       a real interactive confirmation).
 *
 * After bootstrap, set MAVERICKS_HOME env var if mavericks is not at ~/Documents/mavericks.
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

function buildBashWrapper(mavericksDirHint) {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

MAVERICKS="\${MAVERICKS_HOME:-$HOME/Documents/mavericks}/scripts"

export MAVERICKS_PROJECT_ROOT="$PROJECT_ROOT"
export MAVERICKS_SCRIPTS="$MAVERICKS"

if [[ "\${1-}" == "--help" ]]; then
  echo "Usage: ./scripts/mavp-operator [flag]"
  echo ""
  echo "Flags:"
  echo "  --agent          Print session context summary for the Main Agent"
  echo "  --watch          Dashboard watch mode (r = refresh, s = snapshot, q = quit)"
  echo "  --snapshot       Print a text snapshot of current project state"
  echo "  --handoff        Write HANDOFF.md context file for cross-session continuity"
  echo "  --close-session  Run end-of-session ritual (summarise, bump wave, commit)"
  echo "  --set-strategy-note  Set wave strategy context note (persists until --close-session)"
  echo "  --new-task       Interactively create and register a new task"
  echo "  --quick-task     Quickly register a task skeleton (title + problem only)"
  echo "  --apply-decomposition [FILE]  Parse architect decomposition block and register tasks"
  echo "  --ingest-decomposition        Ingest an architect decomposition block"
  echo "  --absorb-task    Mark a task as superseded/absorbed by another task"
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
  echo "  --version        Print the installed Mavericks framework version"
  echo "  --help           Show this help message and exit"
  echo ""
  echo "(no flag)          Open the operator dashboard"
  exit 0
elif [[ "\${1-}" == "--snapshot" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-snapshot.js" "$@"
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
elif [[ "\${1-}" == "--ingest-decomposition" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-ingest-decomposition.js" "$@"
elif [[ "\${1-}" == "--absorb-task" ]]; then
  shift
  node "$MAVERICKS/mavp-operator-absorb-task.js" "$@"
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
  return `INPUT=$(cat); FP=$(node -e "try{const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write((d.tool_input&&d.tool_input.file_path)||'')}catch(e){}" <<< "$INPUT"); case "$FP" in *BACKLOG.md|*TASK_STATUS.md) ;; *) exit 0 ;; esac; MAVERICKS="\${MAVERICKS_HOME:-$HOME/Documents/mavericks}/scripts"; MAVROOT="${targetDir}"; export MAVERICKS_PROJECT_ROOT="$MAVROOT"; TS=$(node -e "process.stdout.write(String(Date.now()))"); echo "$TS" > "$MAVROOT/.mavp-hook-ts"; sleep 1.5; CURRENT_TS=$(cat "$MAVROOT/.mavp-hook-ts" 2>/dev/null); if [ "$CURRENT_TS" != "$TS" ]; then exit 0; fi; rm -f "$MAVROOT/.mavp-hook-ts"; cd "$MAVROOT"; case "$FP" in *BACKLOG.md) node "$MAVERICKS/mavp-operator-sync-status.js" 1>&2 ;; esac; VOUT=$(node "$MAVERICKS/mavp-validator.js" 2>&1); VCODE=$?; [ $VCODE -ne 0 ] && printf '%s\\n' "$VOUT" >&2 || true; exit 0`;
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
  const yesFlag = args.includes('--yes') || args.includes('-y');
  const targetArg = args.find(a => !a.startsWith('-'));
  const targetDir = targetArg ? path.resolve(targetArg) : process.cwd();
  const targetScripts = path.join(targetDir, 'scripts');

  console.log(`\n${BOLD}Mavericks Bootstrap${RESET} ${DIM}v${MAVERICKS_VERSION}${RESET}`);
  console.log(`${DIM}Framework: ${FRAMEWORK_DIR}${RESET}`);
  console.log(`${DIM}Target:    ${targetScripts}${RESET}\n`);
  console.log(`${DIM}Core framework scripts (dashboard, lib, snapshot, validator) are used directly`);
  console.log(`from mavericks — not copied. Set MAVERICKS_HOME if mavericks is not at ~/Documents/mavericks.${RESET}\n`);

  if (!fs.existsSync(targetDir)) {
    console.error(`${RED}Target directory not found: ${targetDir}${RESET}`);
    process.exitCode = 1;
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

    // Re-sync the generated bash wrapper (scripts/mavp-operator) from the current
    // (flag-parity) buildBashWrapper() output — overwrites the existing wrapper,
    // same "overwrites existing" contract used for agent.js/close-session.js above.
    // This is what brings restored flags + correct validator routing (mavp-validator.js
    // with "$PROJECT_ROOT") to already-bootstrapped projects, which fresh-install-only
    // wiring never reached.
    {
      const wrapperDst = path.join(targetDir, 'scripts', BASH_FILE);
      if (fs.existsSync(path.dirname(wrapperDst))) {
        const existedWrapper = fs.existsSync(wrapperDst);
        fs.writeFileSync(wrapperDst, buildBashWrapper(FRAMEWORK_DIR), 'utf8');
        fs.chmodSync(wrapperDst, 0o755);
        const label = existedWrapper ? `${YELLOW}updated${RESET}` : `${GREEN}new${RESET}   `;
        console.log(`  ${label}  scripts/${BASH_FILE} ${DIM}(bash wrapper)${RESET}`);
        updatedCount++;
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

    // Refresh the mavp PostToolUse validator hook command in settings.local.json.
    // The hook is written only at fresh-install time (buildPostToolUseHookCommand),
    // so already-bootstrapped projects still reference the pre-T-329 validator name
    // (parliamentary-validator-parser-v1.js) in their PostToolUse hook command.
    //
    // Surgical rewrite: parse the JSON, walk ONLY hooks.PostToolUse[].hooks[].command
    // strings, and replace the stale validator filename token with mavp-validator.js.
    // Every other key (permissions, effortLevel, fallbackModel, alwaysThinkingEnabled,
    // any non-mavp hooks) is preserved untouched. The inert stale permission allow-list
    // entries (permissions.allow) are deliberately NOT rewritten — they are out of scope
    // (T-336) and scoping the replacement to PostToolUse commands leaves them intact.
    try {
      if (fs.existsSync(settingsLocalPath)) {
        const settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'));
        const OLD_VALIDATOR = 'parliamentary-validator-parser-v1.js';
        const NEW_VALIDATOR = 'mavp-validator.js';
        let hookChanged = false;
        const postToolUse = settingsLocal.hooks && settingsLocal.hooks.PostToolUse;
        if (Array.isArray(postToolUse)) {
          for (const entry of postToolUse) {
            if (!entry || !Array.isArray(entry.hooks)) continue;
            for (const h of entry.hooks) {
              if (h && typeof h.command === 'string' && h.command.includes(OLD_VALIDATOR)) {
                h.command = h.command.split(OLD_VALIDATOR).join(NEW_VALIDATOR);
                hookChanged = true;
              }
            }
          }
        }
        if (hookChanged) {
          fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2) + '\n', 'utf8');
          console.log(`  ${YELLOW}updated${RESET}  .claude/settings.local.json ${DIM}(PostToolUse validator hook → mavp-validator.js)${RESET}`);
          updatedCount++;
        }
      }
    } catch {
      // malformed or missing settings.local.json — skip silently
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

  // Write bash wrapper
  if (needsBash) {
    const destPath = path.join(targetScripts, BASH_FILE);
    fs.writeFileSync(destPath, buildBashWrapper(FRAMEWORK_DIR), 'utf8');
    fs.chmodSync(destPath, 0o755);
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
            command: buildPostToolUseHookCommand(targetDir),
          }],
        }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`  ${GREEN}✓${RESET} .claude/settings.local.json ${DIM}(hooks: SessionStart, PostCompact, PostToolUse [hardened: file-filter + debounce + auto-sync]; fallbackModel: opus)${RESET}`);
    artifactsCreated++;

    const gitignoreResult = ensureHookDebounceGitignoreEntry(targetDir);
    if (gitignoreResult !== 'exists') {
      console.log(`  ${GREEN}✓${RESET} .gitignore ${DIM}(.mavp-hook-ts debounce file ${gitignoreResult})${RESET}`);
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
