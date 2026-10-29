const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_PATH = path.join(ROOT, 'PROCESS_STATE.md');
const PROCESS_STATE_JSON_PATH = path.join(ROOT, 'PROCESS_STATE.json');
const TASK_STATUS_PATH = path.join(ROOT, 'TASK_STATUS.md');
const BACKLOG_PATH = path.join(ROOT, 'BACKLOG.md');

const CLAUDE_CONTEXT_WINDOW = 200000;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Print a first-line repo-identity header so a wrong-repo run (stale shell cwd,
 * or a stale MAVERICKS_PROJECT_ROOT) is obvious immediately. Reads wave and
 * initiative from <root>/PROCESS_STATE.json; degrades to a path-only line when
 * that file is absent or unparsable. Never throws.
 *
 * T-624: when `options.mutating` is true (mutating ritual commands only), the
 * identity line is ALSO written to stderr, duplicating stdout byte-for-byte,
 * so a stdout-only pipe (e.g. `tail`) cannot cut the one line that names the
 * resolved repo. Read-only reporting surfaces never pass this option and keep
 * stdout-only output, unchanged.
 *
 * @param {string} root - Absolute path to the project root being operated on.
 * @param {{mutating?: boolean}} [options] - Set mutating:true from mutating
 *   ritual scripts only.
 */
function printRepoIdentityHeader(root, options = {}) {
  const mutating = !!(options && options.mutating);
  const emit = (line) => {
    console.log(line);
    if (mutating) {
      try {
        console.error(line);
      } catch {
        // swallow - never throw from a diagnostic header
      }
    }
  };
  try {
    const processStateJsonPath = path.join(root, 'PROCESS_STATE.json');
    let state = null;
    if (fs.existsSync(processStateJsonPath)) {
      try {
        state = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
      } catch {
        state = null;
      }
    }
    if (state && (state.wave !== undefined || state.initiative !== undefined)) {
      const wave = state.wave !== undefined ? state.wave : 'unknown';
      const initiative = state.initiative !== undefined ? state.initiative : 'unknown';
      emit(`repo: ${root} | wave: ${wave} | initiative: ${initiative}`);
    } else {
      emit(`repo: ${root}`);
    }
  } catch {
    try {
      emit(`repo: ${root}`);
    } catch {
      // swallow - never throw from a diagnostic header
    }
  }
}

/**
 * T-624: literal shipped version placeholder written into
 * templates/PROCESS_STATE_TEMPLATE.json's `mavericks_version` field. A fresh
 * install (mavp-install.js, "Bootstrap PROCESS_STATE.json if missing") always
 * overwrites this with a real MAVERICKS_VERSION string at seed time — so a
 * tree whose PROCESS_STATE.json still carries this exact literal has never
 * been installed or adopted by mavp-install.js.
 */
const NEVER_PROJECT_VERSION_PLACEHOLDER = '__MAVERICKS_VERSION__';

/**
 * T-624: documented override env var. Setting it to any truthy string (e.g.
 * "1") permits a mutating ritual command to proceed against a root that would
 * otherwise be refused by guardMutatingRoot() — for the rare sanctioned case
 * (e.g. deliberately operating on a template/fixture tree by hand).
 */
const NEVER_PROJECT_ROOT_OVERRIDE_ENV = 'MAVERICKS_ALLOW_NEVER_PROJECT_ROOT';

/**
 * T-624/T-670: determine whether `root` is a "never-a-project" tree — one
 * that has never been installed/adopted, is the machine-shared
 * adopter-resolved framework-source clone ($HOME/.mavericks), or is a linked
 * (non-primary) git worktree of a real project — so mutating ritual commands
 * can refuse before writing to it.
 *
 * Four independent discriminators, any one is sufficient:
 *   (a) <root>/PROCESS_STATE.json EXISTS and its `mavericks_version` field is
 *       exactly the literal shipped placeholder (NEVER_PROJECT_VERSION_PLACEHOLDER).
 *       A MISSING or unparsable PROCESS_STATE.json never triggers (a) — only
 *       an on-disk file carrying the literal placeholder does.
 *   (b) realpath(root) === realpath(<homeDir>/.mavericks).
 *   (c) T-670: realpath(root) equals a NON-FIRST entry returned by
 *       listGitWorktrees(root), AND the first (primary) entry is not bare.
 *       `git worktree list --porcelain` always lists the primary/main
 *       worktree first — any entry after it is a linked worktree. The bare
 *       exemption matters: in a bare-repo-plus-worktrees layout every
 *       checkout is linked and there is no primary to compare against or
 *       name in a refusal message, so (c) never fires there (it would
 *       otherwise permanently block every mutating command for that
 *       adopter layout). A root that is not a git repo, or where git itself
 *       fails, degrades to listGitWorktrees() returning `[]` (never throws),
 *       so (c) silently does not fire.
 *   (d) T-743: the CALLER's own worktree top-level realpath-equals a NON-FIRST
 *       entry of listGitWorktrees() (i.e. the caller is sitting inside a
 *       linked worktree) of a repo whose first (primary) entry is not bare,
 *       AND that primary's realpath equals `resolvedRoot`. Discriminators
 *       (a)-(c) judge only the write TARGET, and a primary checkout is a
 *       perfectly valid target — it is exactly what the Main Agent
 *       legitimately writes to. The distinguishing fact for this vector is
 *       the CALLER's location: a worktree sub-agent invoking a gated operator
 *       script by absolute path into the shared primary checkout. That
 *       escaped once (a strategy note written into the primary checkout's
 *       tracked PROCESS_STATE.json), caught only by the agent's own
 *       post-edit self-verification.
 *
 *       THE CALLER SIDE MUST RESOLVE ITS OWN TOP-LEVEL, never compare `cwd`
 *       for exact equality against a worktree-list entry: `git worktree list`
 *       reports worktree ROOTS, while a sub-agent's cwd is frequently a
 *       SUBDIRECTORY of its worktree, so exact equality would ship a
 *       discriminator that passes its own happy-path test and never fires in
 *       the field. `gitWorktreeToplevel()` runs `git rev-parse
 *       --show-toplevel` from the caller's cwd, which is exact (no prefix
 *       matching, so no sibling directory sharing a name prefix can ever
 *       match) and boundary-correct for any depth of subdirectory.
 *
 *       Deliberately NOT fired for: a caller at the primary's own cwd (the
 *       primary is the FIRST entry, never a linked match); a cross-repo call
 *       (cwd inside repo X's linked worktree while the target is a separate
 *       repo Y — X's primary never realpath-equals Y); a bare-primary layout
 *       (same exemption (c) makes). Any git failure or a non-repo cwd
 *       degrades silently to not-blocked.
 *
 *       ACCEPTED FRICTION, and its one adjudicated exception. The friction
 *       case: the Main Agent inspects a worktree, its shell cwd persists, and
 *       the next mutating command targets the primary by absolute path — (d)
 *       fires on a correctly-targeted write, and recovery is one `cd` or the
 *       documented override. That acceptance stands for the 17 gated commands
 *       that are state-artifact rituals: those are Main-Agent-only by rule, a
 *       worktree sub-agent's cwd is inside a linked worktree 100% of the time
 *       by construction, so ANY worktree-cwd invocation of them targeting the
 *       primary is unauthorized per se — a structural population, not a drift
 *       event. `--integrate` is the single adjudicated EXEMPTION (T-743 round
 *       2), opted out via `options.skipCallerWorktreeCheck` at its own call
 *       site because refusing it would break a legitimate cwd-independent
 *       invocation that the worktree-integration ritual actively mandates.
 *
 *       THE EXEMPTION PREDICATE — the growth control. A gated command may
 *       pass `skipCallerWorktreeCheck` only if ALL THREE conjuncts hold:
 *         (i)   every git subprocess it spawns is explicitly cwd-pinned to
 *               ROOT (so it has no exposure to the vector (d) targets);
 *         (ii)  it writes no state artifacts; and
 *         (iii) its documented ritual mandates worktree-proximate invocation.
 *       Exactly one command satisfies this today. Membership is a call-site
 *       declaration, enumerable by `grep -n skipCallerWorktreeCheck scripts/`,
 *       and a second member requires a `docs/core/GATE_LEDGER.md` amendment.
 *       The exemption disables ONLY (d): a resolved ROOT that IS a linked
 *       worktree still refuses via (c), even for an exempt command.
 *
 * The home directory, the resolved root, and the caller's cwd are all
 * injectable via `options` so tests never need a real ~/.mavericks, a real
 * never-installed tree, or a real process-wide chdir outside a temp fixture.
 *
 * @param {string} root - Absolute path to the project root being checked.
 * @param {{homeDir?: string, cwd?: string, skipCallerWorktreeCheck?: boolean}} [options] -
 *   homeDir override for tests (defaults to os.homedir()), cwd override for
 *   tests (defaults to process.cwd()), and skipCallerWorktreeCheck to disable
 *   ONLY discriminator (d) — see the exemption predicate above; it never
 *   affects (a), (b) or (c).
 * @returns {{blocked: boolean, discriminator: ('placeholder'|'dot_mavericks'|'linked_worktree'|'caller_in_linked_worktree'|null), resolvedRoot: string, primaryWorktreePath?: string, callerWorktreePath?: string}}
 */
function checkNeverAProjectRoot(root, options = {}) {
  const homeDir = options && options.homeDir !== undefined ? options.homeDir : os.homedir();
  const callerCwd = options && options.cwd !== undefined ? options.cwd : process.cwd();
  const resolvedRoot = safeRealpath(root);

  // Discriminator (b): root resolves to $HOME/.mavericks (or injected homeDir).
  try {
    const dotMavericksPath = path.join(homeDir, '.mavericks');
    const resolvedDotMavericks = safeRealpath(dotMavericksPath);
    if (resolvedRoot === resolvedDotMavericks) {
      return { blocked: true, discriminator: 'dot_mavericks', resolvedRoot };
    }
  } catch {
    // degrade silently - never let the guard itself throw
  }

  // Discriminator (a): PROCESS_STATE.json exists and carries the literal
  // shipped placeholder. A missing file never triggers this branch.
  try {
    const processStateJsonPath = path.join(root, 'PROCESS_STATE.json');
    if (fs.existsSync(processStateJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
      if (parsed && parsed.mavericks_version === NEVER_PROJECT_VERSION_PLACEHOLDER) {
        return { blocked: true, discriminator: 'placeholder', resolvedRoot };
      }
    }
  } catch {
    // unparsable PROCESS_STATE.json never triggers (a) either
  }

  // Discriminator (c): root is a linked (non-primary) git worktree.
  // listGitWorktrees() itself never throws (degrades to [] on any git
  // failure or non-git directory) — the try/catch here is belt-and-suspenders
  // around the realpath comparisons only.
  try {
    const worktrees = listGitWorktrees(root);
    if (worktrees.length > 1) {
      const primary = worktrees[0];
      if (!primary.bare) {
        const isLinkedMatch = worktrees
          .slice(1)
          .some((wt) => safeRealpath(wt.path) === resolvedRoot);
        if (isLinkedMatch) {
          return {
            blocked: true,
            discriminator: 'linked_worktree',
            resolvedRoot,
            primaryWorktreePath: primary.path,
          };
        }
      }
    }
  } catch {
    // degrade silently - never let the guard itself throw
  }

  // Discriminator (d) — T-743: the CALLER sits inside a linked worktree and
  // is targeting that same repo's PRIMARY checkout. Evaluated last so the
  // three target-side discriminators keep reporting their own, more specific
  // diagnosis when they also apply. Every step degrades to not-blocked:
  // gitWorktreeToplevel() returns null on any git failure or non-repo cwd,
  // and listGitWorktrees() returns [] on the same.
  //
  // skipCallerWorktreeCheck opts a call site out of (d) ONLY — the three
  // target-side discriminators above have already run unconditionally by this
  // point, so an exempt command still refuses a ROOT that is itself a linked
  // worktree via (c). Admission is governed by the three-conjunct exemption
  // predicate in this function's doc comment, not by a name list.
  if (options && options.skipCallerWorktreeCheck) {
    return { blocked: false, discriminator: null, resolvedRoot };
  }

  try {
    const callerToplevel = gitWorktreeToplevel(callerCwd);
    if (callerToplevel) {
      const callerWorktrees = listGitWorktrees(callerToplevel);
      if (callerWorktrees.length > 1) {
        const primary = callerWorktrees[0];
        if (!primary.bare) {
          const resolvedCallerToplevel = safeRealpath(callerToplevel);
          const callerIsLinked = callerWorktrees
            .slice(1)
            .some((wt) => safeRealpath(wt.path) === resolvedCallerToplevel);
          if (callerIsLinked && safeRealpath(primary.path) === resolvedRoot) {
            return {
              blocked: true,
              discriminator: 'caller_in_linked_worktree',
              resolvedRoot,
              primaryWorktreePath: primary.path,
              callerWorktreePath: callerToplevel,
            };
          }
        }
      }
    }
  } catch {
    // degrade silently - never let the guard itself throw
  }

  return { blocked: false, discriminator: null, resolvedRoot };
}

/**
 * T-743: resolve the top-level directory of the git worktree containing
 * `dir`, via `git rev-parse --show-toplevel`. Returns null (never throws) on
 * any git failure, a non-repo directory, a directory that does not exist, or
 * an empty answer (e.g. inside a bare repo's git dir, which has no worktree).
 *
 * This is the caller-side resolution step discriminator (d) depends on. It
 * exists as its own function precisely because the naive alternative — using
 * `process.cwd()` directly and comparing it for equality against a
 * `git worktree list` entry — is silently wrong: worktree-list entries are
 * worktree ROOTS, and a caller's cwd is frequently a SUBDIRECTORY of its
 * worktree, so the equality check would essentially never match in the field.
 *
 * @param {string} dir - Absolute path to any directory (need not be a repo).
 * @returns {string|null} The worktree top-level path, or null.
 */
function gitWorktreeToplevel(dir) {
  try {
    const output = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = (output || '').trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * T-847: the single discriminator-text mapping shared by guardMutatingRoot()
 * (refusal message) and guardReportingWrite() (skip note / validator finding),
 * so the two surfaces can never describe the same discriminator differently.
 *
 * @param {{discriminator: string, primaryWorktreePath?: string, callerWorktreePath?: string}} check -
 *   a blocked checkNeverAProjectRoot() result.
 * @returns {string}
 */
function describeNeverProjectDiscriminator(check) {
  return check.discriminator === 'dot_mavericks'
    ? `root resolves to $HOME/.mavericks (the adopter-resolved framework-source clone)`
    : check.discriminator === 'linked_worktree'
    ? `root is a linked (non-primary) git worktree; the primary checkout is at ${check.primaryWorktreePath}`
    : check.discriminator === 'caller_in_linked_worktree'
    ? `caller is inside the linked (non-primary) git worktree at ${check.callerWorktreePath}, targeting that repo's primary checkout at ${check.primaryWorktreePath}`
    : `PROCESS_STATE.json's mavericks_version is the shipped placeholder "${NEVER_PROJECT_VERSION_PLACEHOLDER}" (never installed/adopted)`;
}

/**
 * T-847: the reporting-surface sibling of guardMutatingRoot(). Reporting
 * surfaces (--agent, --snapshot, the validator) do not refuse - they keep
 * reporting - but their incidental state writes (PROCESS_STATE.md
 * regeneration, the .mavp/permission-mode record, the validator's
 * last_task_id auto-patch) must not land in a never-a-project root, where a
 * stray write to a tracked file in the framework-source clone makes the
 * installer's dirty-source guard refuse every adopter update on the machine.
 *
 * Reuses checkNeverAProjectRoot() and the override env var. Never prints
 * and never exits; the caller decides how to surface the skip.
 *
 * @param {string} root - Absolute path to the project root being reported on.
 * @param {string} surfaceName - The surface's flag name (e.g. "--agent"), used only in `note`.
 * @param {{homeDir?: string, cwd?: string, skipCallerWorktreeCheck?: boolean, env?: Record<string,string>}} [options] -
 *   same injectables as guardMutatingRoot().
 * @returns {{skip: boolean, discriminator: (string|null), resolvedRoot: (string|undefined), overridden: boolean, discriminatorText: (string|null), note: (string|null)}}
 *   `discriminatorText` and `note` are additive conveniences (null unless skipped).
 */
function guardReportingWrite(root, surfaceName, options = {}) {
  const env = (options && options.env) || process.env;
  if (env[NEVER_PROJECT_ROOT_OVERRIDE_ENV]) {
    return { skip: false, discriminator: null, resolvedRoot: undefined, overridden: true, discriminatorText: null, note: null };
  }
  const check = checkNeverAProjectRoot(root, options);
  if (!check || !check.blocked) {
    return {
      skip: false,
      discriminator: null,
      resolvedRoot: check ? check.resolvedRoot : undefined,
      overridden: false,
      discriminatorText: null,
      note: null,
    };
  }
  const discriminatorText = describeNeverProjectDiscriminator(check);
  const note = `note: ${surfaceName} skipped its state writes - ${check.resolvedRoot} is a never-a-project root (${discriminatorText}); set ${NEVER_PROJECT_ROOT_OVERRIDE_ENV}=1 to allow them.`;
  return { skip: true, discriminator: check.discriminator, resolvedRoot: check.resolvedRoot, overridden: false, discriminatorText, note };
}

/**
 * T-624/T-670: guard entry point for every mutating ritual command. Refuses
 * BEFORE any file write when checkNeverAProjectRoot() finds a match, unless
 * the override env var (NEVER_PROJECT_ROOT_OVERRIDE_ENV) is set to a truthy
 * string. On refusal, prints the refusal message to BOTH stdout and stderr
 * (a stdout-only pipe must not be able to cut it) naming the resolved path,
 * the matched discriminator (for discriminator (c), also the primary
 * checkout path; for discriminator (d), the caller's worktree path, the
 * targeted primary path, and a one-line remedy), and the override env var.
 *
 * The override check stays FIRST, before any discriminator runs — T-743 added
 * discriminator (d) behind it without touching that ordering.
 *
 * @param {string} root - Absolute path to the project root being operated on.
 * @param {string} commandName - The mutating command's flag name (e.g. "--set-status"),
 *   used only in the refusal message.
 * @param {{homeDir?: string, cwd?: string, skipCallerWorktreeCheck?: boolean, env?: Record<string,string>}} [options] -
 *   injectable homeDir, cwd and skipCallerWorktreeCheck (all forwarded to
 *   checkNeverAProjectRoot — see its exemption predicate before passing the
 *   last one) and env (defaults to process.env) for tests.
 * @returns {{blocked: boolean, overridden?: boolean, discriminator?: string, resolvedRoot?: string}}
 */
function guardMutatingRoot(root, commandName, options = {}) {
  const env = (options && options.env) || process.env;
  const overrideValue = env[NEVER_PROJECT_ROOT_OVERRIDE_ENV];
  if (overrideValue) {
    return { blocked: false, overridden: true };
  }

  const check = checkNeverAProjectRoot(root, options);
  if (!check.blocked) {
    return { blocked: false };
  }

  const discriminatorText = describeNeverProjectDiscriminator(check);

  const messageLines = [
    `REFUSED: ${commandName} refuses to run against a never-a-project repo root.`,
    `  resolved path: ${check.resolvedRoot}`,
    `  matched discriminator: ${discriminatorText}`,
  ];
  if (check.discriminator === 'caller_in_linked_worktree') {
    messageLines.push(
      `  remedy: cd into ${check.primaryWorktreePath} and re-run ${commandName} there, or re-target the command at your own worktree.`
    );
  }
  messageLines.push(
    `  override: set ${NEVER_PROJECT_ROOT_OVERRIDE_ENV}=1 to permit this write for the rare sanctioned case.`
  );
  const message = messageLines.join('\n');

  console.log(message);
  try {
    console.error(message);
  } catch {
    // swallow - refusal must still report via stdout even if stderr fails
  }

  return { blocked: true, discriminator: check.discriminator, resolvedRoot: check.resolvedRoot };
}

/**
 * Determine the next task ID by reading PROCESS_STATE.json last_task_id
 * and also scanning BACKLOG.md + TASK_STATUS.md for the highest existing ID.
 * Takes the max of both sources to avoid duplicates.
 *
 * The heading regex is anchored to line start (`^###\s+T-(\d+)`, multiline)
 * so it only matches real `### T-NNN` headings, never a heading-shaped
 * substring sitting mid-line inside prose or a backticked inline code span
 * (T-593 — wave 72 incident: a backticked `T-900` citation quoted mid-prose
 * in a task's Problem field was matched by the old un-anchored regex and
 * burned the 592-900 ID range in one mint).
 *
 * Residual (documented, not hidden): a line-initial `### T-NNN` heading
 * shape sitting inside a FENCED CODE BLOCK still matches, because this is a
 * plain line-based scan with no fence-tracking (the same fence-blindness
 * shared by every line-based parser in this repo, including the validator's
 * block parsers — see T-593 brief for why stripping fences here was
 * rejected as a false-comfort fix). That residual is covered by the
 * mint-time tripwire below, not by the regex.
 *
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath - Absolute path to TASK_STATUS.md
 * @param {string} processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @returns {string} Next task ID in T-NNN format
 */
function getNextTaskId(backlogPath, taskStatusPath, processStateJsonPath) {
  let maxFromFiles = 0;
  const backlog = fs.existsSync(backlogPath) ? fs.readFileSync(backlogPath, 'utf8') : '';
  const taskStatus = fs.existsSync(taskStatusPath) ? fs.readFileSync(taskStatusPath, 'utf8') : '';
  const combined = backlog + '\n' + taskStatus;
  const matches = [...combined.matchAll(/^###\s+T-(\d+)/gm)];
  if (matches.length) {
    maxFromFiles = Math.max(...matches.map(m => parseInt(m[1], 10)));
  }

  let maxFromState = 0;
  try {
    if (fs.existsSync(processStateJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
      if (typeof parsed.last_task_id === 'number') {
        maxFromState = parsed.last_task_id;
      }
    }
  } catch {
    // ignore — fall back to file scan
  }

  // Mint-time tripwire (T-593): non-blocking — files-max always keeps
  // winning the max() below, including for a fresh/adopter repo with no
  // PROCESS_STATE (maxFromState stays 0 there, so this never fires). This
  // fires only when state is present (maxFromState > 0) AND the file scan
  // jumped past it — exactly the wave-72 incident signature (files said
  // 900, state said 591), and also a genuine drift signal in its legitimate
  // case (a hand-registered task without a matching last_task_id bump).
  if (maxFromState > 0 && maxFromFiles > maxFromState) {
    process.stderr.write(
      `mavp-operator: task-id mint tripwire — file scan found T-${maxFromFiles} but PROCESS_STATE.json last_task_id is ${maxFromState}. ` +
      `This can mean a heading-shaped ID jump (fenced-code-block residual, hand-registered task, or corrupted state) — verify before relying on the minted ID.\n`
    );
  }

  const max = Math.max(maxFromFiles, maxFromState);
  return `T-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Insert entry into BACKLOG.md Active Wave section.
 * Finds the ## Active Wave section, then inserts before the next ## heading
 * at the same (h2) level or at the end of the file.
 * This avoids accidentally placing the entry inside an archived wave section.
 *
 * @param {string} markdown - Content of BACKLOG.md
 * @param {string} entry - Task block to insert
 * @returns {string} Updated markdown
 */
function insertIntoActiveWave(markdown, entry) {
  const activeWaveMatch = markdown.match(/\n## Active Wave[^\n]*/);
  if (!activeWaveMatch) {
    return markdown.trimEnd() + '\n' + entry;
  }

  // Position right after the Active Wave header line
  const activeWaveStart = markdown.indexOf(activeWaveMatch[0]);
  const afterHeaderStart = activeWaveStart + activeWaveMatch[0].length;
  const restOfFile = markdown.slice(afterHeaderStart);

  // Find the next h2 heading (## ) that terminates the Active Wave section
  const nextSectionMatch = restOfFile.match(/\n(?=## )/);
  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    const insertAt = afterHeaderStart + nextSectionMatch.index;
    return markdown.slice(0, insertAt) + '\n' + entry + markdown.slice(insertAt);
  }

  // No next section — append at end of file
  return markdown.trimEnd() + '\n' + entry;
}

/**
 * Insert entry into TASK_STATUS.md Active tasks section.
 * Bounds the insertion to the END of the "## Active tasks" section itself
 * (terminated by the next "## " heading), mirroring insertIntoActiveWave's
 * approach — so intermediate sections (e.g. "## Parked — Wave N",
 * "## Deferred tasks") that sit between "## Active tasks" and
 * "## Recently completed tasks" never capture new entries (T-485).
 * Falls back to inserting before "## Recently completed tasks" when the
 * "## Active tasks" section itself is absent, then to end-of-file when
 * neither anchor exists.
 *
 * @param {string} markdown - Content of TASK_STATUS.md
 * @param {string} entry - Task block to insert
 * @returns {string} Updated markdown
 */
function insertIntoActiveTasks(markdown, entry) {
  const activeTasksMatch = markdown.match(/\n## Active tasks[^\n]*/);
  if (activeTasksMatch) {
    const activeTasksStart = markdown.indexOf(activeTasksMatch[0]);
    const afterHeaderStart = activeTasksStart + activeTasksMatch[0].length;
    const restOfFile = markdown.slice(afterHeaderStart);

    // Find the next h2 heading (## ) that terminates the Active tasks section
    const nextSectionMatch = restOfFile.match(/\n(?=## )/);
    if (nextSectionMatch && nextSectionMatch.index !== undefined) {
      const insertAt = afterHeaderStart + nextSectionMatch.index;
      return markdown.slice(0, insertAt) + '\n' + entry + markdown.slice(insertAt);
    }

    // No next section — append at end of file
    return markdown.trimEnd() + '\n' + entry;
  }

  const completedMatch = markdown.match(/\n## Recently completed tasks/);
  if (completedMatch) {
    const idx = markdown.indexOf(completedMatch[0]);
    return markdown.slice(0, idx) + entry + markdown.slice(idx);
  }
  return markdown.trimEnd() + '\n' + entry;
}

/**
 * Render a skeleton TASK_STATUS.md Active-tasks entry — the shape written by
 * --new-task. Shared so any caller that needs to create a TASK_STATUS entry
 * (interactive --new-task, or the sync-status auto-create path — T-419)
 * produces byte-identical structure instead of hand-rolling it.
 *
 * @param {string} id - Task id, e.g. "T-123"
 * @param {string} title - Task title
 * @param {string} owner - Owner role, e.g. "developer"
 * @param {string} verificationType - Verification type, e.g. "runtime"
 * @param {string} [status='planned'] - Status to seed the entry with
 * @returns {string} Rendered entry block (leading newline, trailing newline)
 */
function buildTaskStatusEntry(id, title, owner, verificationType, status = 'planned') {
  return `\n### ${id} — ${title}
- **Status:** ${status}
- **Owner role:** ${owner}
- **Verification type:** ${verificationType}
- **Last verified by:** —
- **Evidence:** —
`;
}

/**
 * The whole-line advisory printed by --new-task / --quick-task whenever a
 * task's Origin resolves to "manual" — i.e. it bypassed the mandatory
 * architect decomposition gate (see CLAUDE.md, "Before creating tasks —
 * mandatory architect gate"). Advisory only: never blocks, never adds a
 * validator finding. Shared verbatim so both commands print the identical
 * line (T-531).
 */
const ARCHITECT_GATE_ADVISORY = 'ADVISORY: Origin: manual — task registered without architect decomposition; see CLAUDE.md, "Before creating tasks — mandatory architect gate" (advisory only, not enforced).';

/**
 * Resolve a task's BACKLOG.md `- **Origin:**` field from an `--origin` CLI
 * flag value. Only the exact (case-insensitive, whitespace-trimmed) value
 * "architect" stamps `architect`; every other value — including a missing
 * or empty flag — resolves to `manual` (the default, per T-531).
 *
 * @param {string|null|undefined} originFlag - Raw --origin flag value, or null/undefined when not passed
 * @returns {'architect'|'manual'}
 */
function resolveTaskOrigin(originFlag) {
  if (typeof originFlag === 'string' && originFlag.trim().toLowerCase() === 'architect') {
    return 'architect';
  }
  return 'manual';
}

/**
 * Update last_task_id in PROCESS_STATE.json to the highest registered ID.
 * Only updates if numericId is greater than the current last_task_id.
 *
 * @param {string} processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @param {number|string} numericId - The numeric ID (or T-NNN string) to set
 * @returns {boolean} true if updated, false if skipped or failed
 */
function updateLastTaskId(processStateJsonPath, numericId) {
  try {
    if (!fs.existsSync(processStateJsonPath)) return false;
    const raw = fs.readFileSync(processStateJsonPath, 'utf8');
    const json = JSON.parse(raw);
    const id = typeof numericId === 'string'
      ? parseInt(numericId.replace('T-', ''), 10)
      : numericId;
    if (Number.isNaN(id)) return false;
    if (typeof json.last_task_id === 'number' && id <= json.last_task_id) return false;
    json.last_task_id = id;
    json.last_updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(processStateJsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeWhitespace(value) {
  return value ? value.replace(/\s+/g, ' ').trim() : '';
}

function getSection(markdown, headingLabel) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === headingLabel.trim());

  if (startIndex === -1) {
    return '';
  }

  let endIndex = lines.length;
  const currentLevel = (headingLabel.match(/^#+/) || [''])[0].length;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#+)\s+/);
    if (match && match[1].length <= currentLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join('\n').trim();
}

function getListItems(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .map((line) => normalizeWhitespace(line.replace(/^([-*]\s+|\d+\.\s+)/, '')));
}

function getSingleParagraph(section) {
  return normalizeWhitespace(section.replace(/^[-*]\s+/gm, '').replace(/\n+/g, ' '));
}

function parseProcessState(markdown) {
  return {
    initiative: getSingleParagraph(getSection(markdown, '## Current initiative')),
    stage: getSingleParagraph(getSection(markdown, '## Current loop stage')),
    blockers: getListItems(getSection(markdown, '## Current blockers')),
    openQuestions: getListItems(getSection(markdown, '## Open questions')),
    nextHandoff: getListItems(getSection(markdown, '## Next expected handoff')),
    lastMeaningfulMovement: getListItems(getSection(markdown, '## Last meaningful movement')),
    lastUpdate: getSingleParagraph(getSection(markdown, '## Last update')),
  };
}

// In-flight task statuses — a task in one of these states is actively being
// worked (as opposed to terminal statuses like merged/deferred/deprecated or
// the not-yet-started `planned`). This is the single shared source of truth
// for "what counts as active work" across operator surfaces — mavp-operator-agent.js
// (active_slices, computeNextAction's STATUS_PRIORITY key set),
// mavp-operator-dashboard.js (in-flight count), and parseTouchesConflicts()
// (below, unioned with `planned`) all import this Set rather than redefining
// their own local copy (T-525 found four divergent copies; three are now
// derived from this one — parseTouchesConflicts adds `planned` on top since
// it also needs to catch not-yet-started work).
//
// `qa_passed` is DELIBERATELY excluded: a qa_passed task is done from the
// sub-agent's perspective and is awaiting the Main-Agent merge ritual, not
// further sub-agent work — do not "complete" this set by adding it back.
//
// NOTE: any consumer that keys a priority/weight map off task status (e.g.
// computeNextAction's STATUS_PRIORITY in mavp-operator-agent.js) must give
// every status in this Set an explicit entry — an omitted status silently
// falls through to a default/lowest-priority bucket instead of erroring.
const IN_FLIGHT_STATUSES = new Set([
  'ready_for_qa', 'qa_in_progress',
  'dev_done', 'security_review', 'security_passed', 'ux_review', 'ux_passed',
  'in_progress', 'needs_fix', 'security_needs_fix', 'ux_needs_fix',
]);

// T-573: statuses that are terminal in the "this task will never be worked
// again inside this wave" sense — a task in one of these states that is still
// sitting in TASK_STATUS.md's `## Active tasks` section must be SWEPT OUT of
// it (relocated to its proper home section) rather than counted as remaining
// work that keeps the wave open. Consumed by --close-session's terminal sweep
// in both the interactive and non-interactive paths.
//
// DELIBERATELY NOT DERIVED from IN_FLIGHT_STATUSES (i.e. not "everything that
// is not in-flight") — this is a sibling explicit skip-list, and that choice is
// the whole safety property. Deriving it would fail OPEN: `planned` and
// `qa_passed` both sit outside IN_FLIGHT_STATUSES on purpose (planned work has
// not started; qa_passed awaits the Main-Agent merge ritual) yet both are
// genuinely unfinished and MUST keep the wave open, and a typo'd/unknown status
// would silently stop blocking too. As an explicit skip set, anything not
// literally listed here keeps the wave open — fail-closed.
//
// Distinct from ARCHIVABLE_TERMINAL_STATUSES (below), which is the
// terminal-COMPLETED set (merged/deployed/runtime_verified — work that was
// finished and shipped). These two sets never overlap: a swept `deferred` or
// `deprecated` task is NOT a completed task and must never be treated as one
// (in particular it must never be fed to syncBacklogMergedTasks(), whose
// BACKLOG-side archival is only correct for completed work).
const TERMINAL_SKIP_STATUSES = new Set(['deferred', 'deprecated']);

// T-573: TASK_STATUS.md heading that holds deferred task blocks swept out of
// `## Active tasks`. Note the casing: TASK_STATUS.md uses "## Deferred tasks"
// (matching its sibling "## Active tasks" / "## Recently completed tasks"),
// while BACKLOG.md's own deferral section is "## Deferred Tasks" — the two are
// separate artifacts with separate conventions; do not "normalize" one to the
// other.
const DEFERRED_TASK_STATUS_HEADING = '## Deferred tasks';

function parseTaskBlock(block) {
  const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
  const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
  const ownerMatch = block.match(/^- \*\*Owner:\*\*\s+(.+)$/m);
  const notesMatch = block.match(/^- \*\*Notes:\*\*\s+(.+)$/m);

  return {
    id: headingMatch ? headingMatch[1] : 'unknown',
    title: headingMatch ? normalizeWhitespace(headingMatch[2]) : 'Unknown task',
    status: statusMatch ? normalizeWhitespace(statusMatch[1]) : 'unknown',
    owner: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : 'unknown',
    notes: notesMatch ? normalizeWhitespace(notesMatch[1]) : '',
  };
}

/**
 * Selects the task to present as the session's current focus from
 * TASK_STATUS.md's "## Active tasks" section. Only in-flight statuses
 * (IN_FLIGHT_STATUSES, above) are eligible — a terminal entry (deferred,
 * merged, deprecated) that happens to still sit inside the Active tasks
 * section is skipped rather than reported as active. Returns null when no
 * in-flight task is found, whether because the section is empty or because
 * every entry present is terminal.
 */
function parseActiveTask(markdown) {
  const activeTasksSection = getSection(markdown, '## Active tasks');
  const blocks = activeTasksSection
    .split(/\n(?=###\s+T-\d+)/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return null;
  }

  const parsedBlocks = blocks.map(parseTaskBlock);
  return parsedBlocks.find((task) => IN_FLIGHT_STATUSES.has(task.status)) || null;
}

function inferClassification(stage, task, initiative = '') {
  const source = `${initiative} ${stage} ${task?.title || ''} ${task?.notes || ''}`.toLowerCase();

  if (source.includes('migration')) return 'migration';
  if (source.includes('lightweight')) return 'lightweight';
  if (source.includes('mavp') || source.includes('parliamentary')) return 'MavP';
  return 'normal';
}

function tryParseJson(value) {
  const trimmed = (value || '').trim();

  if (!trimmed) {
    return { ok: true, data: [] };
  }

  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch (error) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 0 && lines.every((line) => line.startsWith('{') && line.endsWith('}'))) {
      try {
        return {
          ok: true,
          data: lines.map((line) => JSON.parse(line)),
        };
      } catch {
        // fall through
      }
    }

    return {
      ok: false,
      reason: `could not parse JSON output (${error.message})`,
      raw: trimmed,
    };
  }
}

function execJson(command, args) {
  try {
    const result = cp.spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 4000,
    });

    if (result.error) {
      return { ok: false, reason: result.error.message };
    }

    if (result.status !== 0) {
      return {
        ok: false,
        reason: normalizeWhitespace(result.stderr || result.stdout || `exit ${result.status}`),
      };
    }

    const parsed = tryParseJson(result.stdout);
    if (parsed.ok) {
      return { ok: true, data: parsed.data };
    }

    return {
      ok: false,
      reason: parsed.reason,
      raw: parsed.raw,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function getSessionData() {
  return { ok: false, reason: 'claude session list not available' };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.tasks)) return value.tasks;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function clip(value, max = 120) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isBoilerplateRuntimeText(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) return true;

  return (
    normalized.length < 8 ||
    /^(ok|done|yes|no|own|none|unknown)$/i.test(normalized) ||
    normalized.includes('reply to the user in a helpful way') ||
    normalized.includes('if it succeeded, share the relevant output') ||
    normalized.includes('if it failed, explain what went wrong') ||
    normalized.includes('approval required') ||
    normalized.includes('allow-once|allow-always|deny')
  );
}

function getSessionSummary(session) {
  const candidates = [
    session.currentTask,
    session.task,
    session.summary,
    session.prompt,
    session.lastEvent,
    session.lastMessage,
    session.note,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized) continue;
    if (isBoilerplateRuntimeText(normalized)) continue;
    return clip(normalized, 100);
  }

  return '';
}

function formatIsoTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function getSessionStatusLabel(session) {
  const raw = normalizeWhitespace(
    session.status || session.state || session.phase || session.lastStatus || ''
  ).toLowerCase();
  const summary = normalizeWhitespace(
    [session.summary, session.task, session.currentTask, session.lastMessage, session.lastEvent, session.note]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  if (raw) {
    if (raw === 'done' || raw === 'completed' || raw === 'finished' || raw === 'success') return 'completed';
    if (raw === 'running' || raw === 'active' || raw === 'started' || raw === 'working') return 'running';
    if (raw.includes('wait') && raw.includes('approval')) return 'waiting_approval';
    if (raw.includes('wait') && raw.includes('subagent')) return 'waiting_subagent';
    if (raw.includes('block') || raw.includes('error') || raw.includes('failed')) return 'blocked';
    if (raw.includes('idle')) return 'idle_unexpected';
    return raw;
  }

  if (summary.includes('/approve') || summary.includes('approval required')) return 'waiting_approval';
  if (summary.includes('waiting on sub-agent') || summary.includes('waiting on subagent') || summary.includes('waiting for sub-agent') || summary.includes('waiting for subagent')) return 'waiting_subagent';
  if (summary.includes('blocked') || summary.includes('error') || summary.includes('failed')) return 'blocked';
  if (session.endedAt) return 'completed';
  if (session.key === 'agent:main:main') return 'running';
  return 'unknown';
}

function shortenSessionKey(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.startsWith('agent:main:main')) return 'main';
  const subagentMatch = normalized.match(/subagent:([a-f0-9-]+)$/i);
  if (subagentMatch) {
    return `subagent:${subagentMatch[1].slice(0, 8)}`;
  }
  return normalized;
}

function cleanupDisplayName(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalized
    .replace(/^webchat:g-agent-main-main$/, 'main')
    .replace(/^webchat:g-agent-main-subagent-([a-f0-9-]+)$/i, (_, id) => `subagent:${id.slice(0, 8)}`)
    .replace(/^g-agent-main-main$/, 'main')
    .replace(/^g-agent-main-subagent-([a-f0-9-]+)$/i, (_, id) => `subagent:${id.slice(0, 8)}`);
}

function chooseSessionLabel(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized) continue;
    if (normalized.length <= 3 && !normalized.includes(':') && normalized !== 'main') continue;
    if (/^[a-z]{1,4}$/i.test(normalized) && normalized !== 'main') continue;
    return normalized;
  }
  return 'unknown-session';
}

function getSessionLabel(session) {
  return chooseSessionLabel(
    session.label,
    cleanupDisplayName(session.displayName),
    session.sessionLabel,
    session.name,
    shortenSessionKey(session.key || session.sessionKey),
    session.id
  );
}

function getSessionRole(session) {
  const keySource = normalizeWhitespace(session.key || session.sessionKey || '').toLowerCase();
  const labelSource = normalizeWhitespace(
    [session.label, session.displayName, session.sessionLabel, session.name, session.agentId, session.kind, session.type]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  if (keySource.includes(':subagent:') || session.parentSessionKey || session.spawnedBy || labelSource.includes('subagent')) {
    return 'subagent';
  }

  if (session.key === 'agent:main:main' || keySource === 'agent:main:main' || /^agent:main:(telegram|discord|signal|whatsapp|slack|webchat):/.test(keySource)) {
    return 'main_agent';
  }

  if (labelSource.includes('human') || labelSource.includes('user')) return 'human';
  if (labelSource.includes('acp') || labelSource.includes('codex') || labelSource.includes('claude') || labelSource.includes('cursor')) return 'acp_session';
  return normalizeWhitespace(session.agentId || session.kind || session.type || 'agent');
}

function normalizeActorRecord(session) {
  return {
    actor_id: session.id || session.key || session.sessionKey || getSessionLabel(session),
    label: getSessionLabel(session),
    role: getSessionRole(session),
    status: getSessionStatusLabel(session),
    current_task: getSessionSummary(session),
    parent_actor_id: session.parentSessionKey || session.spawnedBy || '',
    updated_at: session.updatedAt || session.endedAt || session.startedAt || '',
    started_at: session.startedAt || '',
    expected_handoff: normalizeWhitespace(session.returnTo || session.handoffTarget || ''),
    raw: session,
  };
}

function getTaskWaitItems(taskList) {
  return taskList
    .map((task) => {
      const status = normalizeWhitespace(task.status || task.state || 'unknown');
      const rawLabel = normalizeWhitespace(task.label || task.name || task.id || 'unknown-task');
      const summary = getSessionSummary(task);
      const label = isBoilerplateRuntimeText(rawLabel) ? 'runtime-task' : clip(rawLabel, 60);

      if (!/wait|block|pending|running/i.test(status)) {
        return null;
      }

      return { label, status, summary };
    })
    .filter(Boolean);
}

function ageFrom(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '';
  const deltaMs = Math.max(Date.now() - timestamp, 0);
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function getSeverity(waitType, status = '') {
  const source = `${waitType} ${status}`.toLowerCase();
  if (source.includes('blocked')) return 4;
  if (source.includes('approval')) return 3;
  if (source.includes('idle')) return 3;
  if (source.includes('subagent')) return 2;
  return 1;
}

function buildRecentEvents(processState, actors) {
  const events = [];

  for (const item of processState.lastMeaningfulMovement.slice(-8).reverse()) {
    events.push({
      event_type: 'workflow_movement',
      actor_label: 'workflow',
      summary: item,
      timestamp: processState.lastUpdate || '',
    });
  }

  for (const actor of actors) {
    if (actor.status === 'completed') {
      events.push({
        event_type: 'actor_completed',
        actor_label: actor.label,
        summary: actor.current_task ? `completed — ${actor.current_task}` : 'completed',
        timestamp: actor.updated_at || '',
      });
    } else if (actor.status === 'waiting_approval' || actor.status === 'waiting_subagent' || actor.status === 'blocked') {
      events.push({
        event_type: 'actor_transition',
        actor_label: actor.label,
        summary: `${actor.status}${actor.current_task ? ` — ${actor.current_task}` : ''}`,
        timestamp: actor.updated_at || '',
      });
    }
  }

  return events
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 10);
}

function readTodayTokenUsage() {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let inputTotal = 0, outputTotal = 0, cacheReadTotal = 0;

    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(CLAUDE_PROJECTS_DIR, d.name));

    for (const projectDir of projectDirs) {
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      for (const file of jsonlFiles) {
        const filePath = path.join(projectDir, file);
        const stat = fs.statSync(filePath);
        // Skip files not modified today (fast path)
        if (new Date(stat.mtimeMs).toISOString().slice(0, 10) !== today) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.includes('"assistant"')) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant' || !entry.message?.usage) continue;
            if (!entry.timestamp || !String(entry.timestamp).startsWith(today) &&
                !new Date(entry.timestamp).toISOString().startsWith(today)) continue;
            const u = entry.message.usage;
            inputTotal += u.input_tokens || 0;
            outputTotal += u.output_tokens || 0;
            cacheReadTotal += u.cache_read_input_tokens || 0;
          } catch { /* skip */ }
        }
      }
    }

    if (inputTotal === 0 && outputTotal === 0) return null;
    return { input: inputTotal, output: outputTotal, cache_read: cacheReadTotal };
  } catch {
    return null;
  }
}

function readSessionTokenUsage() {
  try {
    const projectKey = ROOT.replace(/\//g, '-');
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey);
    if (!fs.existsSync(projectDir)) return null;

    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) return null;

    const jsonlPath = path.join(projectDir, files[0].f);
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trimEnd().split('\n');

    // Scan from end for latest assistant message with usage
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          const contextUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          return {
            context_used: contextUsed,
            context_window: CLAUDE_CONTEXT_WINDOW,
            context_pct: Math.round((contextUsed / CLAUDE_CONTEXT_WINDOW) * 100),
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_read: u.cache_read_input_tokens || 0,
            cache_write: u.cache_creation_input_tokens || 0,
            model: entry.message.model || '',
            session_id: entry.sessionId || '',
          };
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  } catch {
    return null;
  }
}

function relativeTime(value) {
  if (!value) return '';
  const iso = String(value).includes('T') ? value : `${value}T12:00:00Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(value);
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function parseWaveProgress(markdown) {
  const activeSection = getSection(markdown, '## Active tasks');
  const activeBlocks = activeSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);

  const completedSection = getSection(markdown, '## Recently completed tasks');
  const completedBlocks = completedSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
  const mergedCount = completedBlocks.filter(b => /\*\*Status:\*\*\s+merged/.test(b)).length;

  const total = activeBlocks.length + mergedCount;
  return { active: activeBlocks.length, merged: mergedCount, total };
}

/**
 * Parse tasks belonging to the current wave only.
 *
 * Algorithm:
 * - All task IDs from TASK_STATUS.md "## Active tasks" are always included.
 * - Task IDs from TASK_STATUS.md "## Recently completed tasks" are included
 *   only if they appear in the BACKLOG.md "## Active Wave" section.
 *
 * @param {string} taskStatusMarkdown - Content of TASK_STATUS.md
 * @param {string} backlogMarkdown    - Content of BACKLOG.md
 * @returns {Array<{id:string, title:string, status:string}>}
 */
function parseWaveTasks(taskStatusMarkdown, backlogMarkdown) {
  // Collect task IDs that belong to the active wave in BACKLOG.md
  const activeWaveIds = new Set();
  const activeWaveSection = (() => {
    const lines = (backlogMarkdown || '').split(/\r?\n/);
    const startIdx = lines.findIndex((l) => /^##\s+Active Wave/i.test(l));
    if (startIdx === -1) return '';
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
    }
    return lines.slice(startIdx + 1, endIdx).join('\n');
  })();

  for (const m of activeWaveSection.matchAll(/^###\s+(T-\d+)/gm)) {
    activeWaveIds.add(m[1]);
  }

  const result = [];

  // Always include all tasks from "## Active tasks"
  const activeSection = getSection(taskStatusMarkdown, '## Active tasks');
  const activeBlocks = activeSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
  for (const block of activeBlocks) {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    if (!headingMatch) continue;
    result.push({
      id: headingMatch[1],
      title: headingMatch[2].trim(),
      status: statusMatch ? statusMatch[1].trim() : 'unknown',
    });
  }

  // Include recently completed tasks only if they are in the active wave
  if (activeWaveIds.size > 0) {
    const completedSection = getSection(taskStatusMarkdown, '## Recently completed tasks');
    const completedBlocks = completedSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
    for (const block of completedBlocks) {
      const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
      const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
      if (!headingMatch) continue;
      const id = headingMatch[1];
      if (activeWaveIds.has(id)) {
        result.push({
          id,
          title: headingMatch[2].trim(),
          status: statusMatch ? statusMatch[1].trim() : 'unknown',
        });
      }
    }
  }

  return result;
}

function readProcessStateJson() {
  try {
    if (!fs.existsSync(PROCESS_STATE_JSON_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROCESS_STATE_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function mergeProcessState(mdState, jsonState) {
  if (!jsonState) return mdState;
  return {
    ...mdState,
    initiative: jsonState.initiative || mdState.initiative,
    stage: jsonState.stage || mdState.stage,
    blockers: jsonState.blocker ? [jsonState.blocker] : mdState.blockers,
    openQuestions: jsonState.open_questions || mdState.openQuestions,
    lastUpdate: jsonState.last_updated || mdState.lastUpdate,
    _stageOwner: jsonState.stage_owner || '',
    _nextAction: jsonState.next_action || '',
    _activeSlice: jsonState.active_slice || '',
    _wave: jsonState.wave || null,
    _waveStatus: jsonState.wave_status || 'planning',
    _waveGoal: jsonState.wave_goal || null,
    _waveStrategyNote: jsonState.wave_strategy_note || null,
    _deployContours: typeof jsonState.deploy_contours === 'number' ? jsonState.deploy_contours : 0,
  };
}

/**
 * Parse active wave tasks from BACKLOG.md and detect file-level conflicts.
 * A conflict occurs when two or more active tasks declare the same file path
 * in their `- **Touches:**` field.
 *
 * @param {string} backlogMarkdown - Raw content of BACKLOG.md
 * @returns {{ file: string, tasks: string[] }[]} Array of conflicts (entries where tasks.length >= 2)
 */
function parseTouchesConflicts(backlogMarkdown) {
  // Split on task headings (### T-NNN) to get per-task blocks
  const taskBlocks = backlogMarkdown.split(/\n(?=###\s+T-\d+\s+)/);

  // Active-status values that mean the task is in-flight — derived from the shared
  // IN_FLIGHT_STATUSES plus `planned`, since Touches-conflict detection also needs to
  // catch not-yet-started work planning to touch the same file (T-525: this used to be
  // a fifth hand-maintained literal set that silently excluded the needs-fix statuses,
  // so a task actively being re-worked after a failed review never participated in
  // conflict detection for the files it was about to edit again).
  const activeStatuses = new Set([...IN_FLIGHT_STATUSES, 'planned']);

  // Map: filePath → taskId[]
  const fileToTasks = new Map();

  for (const block of taskBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    const statusMatch = block.match(/[-*]\s+\*\*Status:\*\*\s+(\S+)/);
    if (!statusMatch) continue;
    const status = statusMatch[1].trim().replace(/[^a-z_]/gi, '');
    if (!activeStatuses.has(status)) continue;

    const touchesMatch = block.match(/[-*]\s+\*\*Touches:\*\*\s+(.+)/);
    if (!touchesMatch) continue;

    const files = touchesMatch[1]
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    for (const filePath of files) {
      if (!fileToTasks.has(filePath)) {
        fileToTasks.set(filePath, []);
      }
      fileToTasks.get(filePath).push(taskId);
    }
  }

  const conflicts = [];
  for (const [file, tasks] of fileToTasks.entries()) {
    if (tasks.length >= 2) {
      conflicts.push({ file, tasks });
    }
  }
  return conflicts;
}

function collectOperatorData() {
  const backlogContent = fs.existsSync(BACKLOG_PATH) ? readUtf8(BACKLOG_PATH) : '';
  const touchesConflicts = parseTouchesConflicts(backlogContent);

  const taskStatusContent = readUtf8(TASK_STATUS_PATH);
  const processStateJson = readProcessStateJson();
  const processState = mergeProcessState(
    parseProcessState(readUtf8(PROCESS_STATE_PATH)),
    processStateJson
  );
  const activeTask = parseActiveTask(taskStatusContent);
  const waveProgress = parseWaveProgress(taskStatusContent);
  // T-496: enrich each wave task with its parsed `Hold:` field (BACKLOG.md
  // only field, any status) so a held task reads as deliberate rather than
  // stalled in --snapshot. Additive-only — tasks with no Hold: are untouched.
  const taskHolds = parseTaskHolds(backlogContent);
  const waveTasks = parseWaveTasks(taskStatusContent, backlogContent)
    .map((t) => (taskHolds.has(t.id) ? { ...t, hold: taskHolds.get(t.id) } : t));
  const classification = inferClassification(processState.stage, activeTask, processState.initiative);

  const deployContours = processState._deployContours || 0;
  const deployPendingTasks = deployContours >= 2
    ? parseTasksWithRepo(taskStatusContent, backlogContent).filter(t => (t.status === 'merged' || t.status === 'deployed_dev') && !isDeployOptOut(t))
    : [];

  // Compute due/overdue rechecks from PROCESS_STATE.json rechecks[] registry (read-only).
  // T-767: always read the real clock, never fall back to last_updated — a
  // recheck due today must surface even when no state artifact was written
  // since it came due.
  const recheckToday = todayIso();
  const rechecks = processStateJson?.rechecks || [];
  const { due: rechecksDue, overdue: rechecksOverdue } = computeDueRechecks(rechecks, recheckToday);
  const dueRechecks = [
    ...rechecksOverdue.map(e => ({ ...e, overdue: true })),
    ...rechecksDue.map(e => ({ ...e, overdue: false })),
  ];

  const sessionsResult = getSessionData();
  const tasksResult = { ok: false, reason: 'claude task list not available' };

  const sessions = sessionsResult.ok ? toArray(sessionsResult.data) : [];
  const tasks = tasksResult.ok ? toArray(tasksResult.data) : [];
  const runtimeActors = sessions
    .map(normalizeActorRecord)
    .sort((a, b) => {
      const statusWeight = { running: 5, waiting_approval: 4, waiting_subagent: 3, blocked: 2, idle_unexpected: 1, completed: 0 };
      return (statusWeight[b.status] || -1) - (statusWeight[a.status] || -1) || String(b.updated_at).localeCompare(String(a.updated_at));
    });

  const workflowBlockers = processState.blockers.map((summary) => ({
    wait_type: 'blocker',
    actor_id: 'workflow',
    actor_label: 'workflow',
    summary,
    age: '',
    severity: getSeverity('blocker'),
    status: 'blocked',
  }));

  const waitStates = [
    ...workflowBlockers,
    ...runtimeActors
      .filter((actor) => ['waiting_approval', 'waiting_subagent', 'blocked', 'idle_unexpected'].includes(actor.status))
      .map((actor) => ({
        wait_type: actor.status.includes('approval') ? 'approval' : actor.status.includes('subagent') ? 'subagent' : actor.status.includes('idle') ? 'idle_watchdog' : 'blocker',
        actor_id: actor.actor_id,
        actor_label: actor.label,
        summary: actor.current_task || actor.status,
        age: ageFrom(actor.updated_at),
        severity: getSeverity(actor.status, actor.status),
        status: actor.status,
      })),
    ...getTaskWaitItems(tasks).map((task) => ({
      wait_type: /approval/i.test(task.status) ? 'approval' : /block/i.test(task.status) ? 'blocker' : 'subagent',
      actor_id: task.label,
      actor_label: task.label,
      summary: task.summary ? `${task.status} — ${task.summary}` : task.status,
      age: '',
      severity: getSeverity(task.status, task.status),
      status: task.status,
    })),
  ].sort((a, b) => b.severity - a.severity || String(b.age).localeCompare(String(a.age)));

  const recentEvents = buildRecentEvents(processState, runtimeActors);

  const tokenUsage = readSessionTokenUsage();
  const todayUsage = readTodayTokenUsage();
  const trajectorySummary = summarizeTrajectories({ dir: path.join(ROOT, '.mavp', 'trajectories') });

  return {
    token_usage: tokenUsage,
    today_usage: todayUsage,
    workflow_state: {
      initiative_title: processState.initiative,
      stage: processState.stage,
      active_task: activeTask ? `${activeTask.id} — ${activeTask.title}` : null,
      owner: activeTask?.owner || 'unknown',
      classification,
      next_action: processState._nextAction || '',
      wave: processState._wave,
      wave_status: processState._waveStatus,
      wave_goal: processState._waveGoal || null,
      wave_strategy_note: processState._waveStrategyNote || null,
      next_handoff: processState.nextHandoff,
      blockers: processState.blockers,
      pending_approvals: waitStates.filter((item) => item.wait_type === 'approval').length,
      last_movement: processState.lastMeaningfulMovement[processState.lastMeaningfulMovement.length - 1] || '',
      task_status: activeTask?.status || 'unknown',
      task_notes: activeTask?.notes || '',
      last_update: processState.lastUpdate || '',
      last_update_relative: relativeTime(processState.lastUpdate),
      wave_progress: waveProgress,
      wave_tasks: waveTasks,
      deploy_contours: deployContours,
      deploy_pending_tasks: deployPendingTasks,
    },
    runtime_actors: runtimeActors,
    wait_states: waitStates,
    recent_events: recentEvents,
    touches_conflicts: touchesConflicts,
    wave_tasks: waveTasks,
    trajectory_summary: trajectorySummary,
    due_rechecks: dueRechecks,
    sources: {
      sessions: sessionsResult,
      tasks: tasksResult,
    },
  };
}

function renderList(title, items, fallback = 'none') {
  const lines = [title];
  if (!items || items.length === 0) {
    lines.push(`- ${fallback}`);
    return lines.join('\n');
  }

  for (const item of items) {
    lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

function renderThinSnapshot(data) {
  const { workflow_state: workflow, runtime_actors: actors, wait_states: waits, recent_events: recentEvents, touches_conflicts: touchesConflicts, wave_tasks: waveTasks, trajectory_summary: trajectorySummary, due_rechecks: dueRechecks, sources } = data;

  const activeActors = actors
    .filter((actor) => ['running', 'waiting_approval', 'waiting_subagent', 'blocked'].includes(actor.status))
    .map((actor) => {
      const parts = [`label:${actor.label}`, `role:${actor.role}`, `status:${actor.status}`];
      if (actor.parent_actor_id) parts.push(`parent:${shortenSessionKey(actor.parent_actor_id)}`);
      if (actor.current_task) parts.push(`task:${actor.current_task}`);
      if (actor.started_at) parts.push(`started:${formatIsoTime(actor.started_at)}`);
      if (actor.updated_at) parts.push(`updated:${formatIsoTime(actor.updated_at)}`);
      return parts.join(' | ');
    });

  const historicalActors = actors
    .filter((actor) => !['running', 'waiting_approval', 'waiting_subagent', 'blocked'].includes(actor.status))
    .slice(0, 6)
    .map((actor) => {
      const parts = [`label:${actor.label}`, `role:${actor.role}`, `status:${actor.status}`];
      if (actor.current_task) parts.push(`task:${actor.current_task}`);
      if (actor.updated_at) parts.push(`updated:${formatIsoTime(actor.updated_at)}`);
      return parts.join(' | ');
    });

  const waitLines = waits.map((wait) => `${wait.actor_label} — ${wait.status}${wait.age ? ` (${wait.age})` : ''}${wait.summary ? ` — ${wait.summary}` : ''}`);

  const recentLines = recentEvents.map((event) => `${event.actor_label} — ${event.summary}`);

  const parts = [
    '# MavP Operator Snapshot',
    '',
    `Initiative: ${workflow.initiative_title || 'unknown'}`,
    `Stage: ${workflow.stage || 'unknown'}`,
    `Wave status: ${workflow.wave_status || 'unknown'}`,
    ...((() => {
      if (!waveTasks || !waveTasks.length) return [];
      const waveNum = workflow.wave ? `Wave ${workflow.wave}` : 'Wave';
      // T-581: buckets are derived from the shared exported status sets rather
      // than re-listed inline, so a future status added to one of those sets
      // stays consistent here automatically. Fail-closed: anything that is not
      // literally one of ARCHIVABLE_TERMINAL_STATUSES / IN_FLIGHT_STATUSES /
      // `qa_passed` / literal `planned` / TERMINAL_SKIP_STATUSES falls into a
      // visible `unknown` bucket naming the verbatim status — it must never be
      // silently absorbed into `planned` (the bug this task closes).
      const counts = waveTasks.reduce((acc, t) => {
        const s = t.status;
        if (ARCHIVABLE_TERMINAL_STATUSES.has(s)) acc.completed++;
        else if (IN_FLIGHT_STATUSES.has(s) || s === 'qa_passed') acc.in_progress++;
        else if (s === 'planned') acc.planned++;
        else if (TERMINAL_SKIP_STATUSES.has(s)) acc.skipped++;
        else acc.unknown.push(s);
        return acc;
      }, { completed: 0, in_progress: 0, planned: 0, skipped: 0, unknown: [] });
      const parts = [];
      if (counts.completed) parts.push(`${counts.completed} completed`);
      if (counts.in_progress) parts.push(`${counts.in_progress} in_progress`);
      if (counts.planned) parts.push(`${counts.planned} planned`);
      if (counts.skipped) parts.push(`${counts.skipped} deferred/deprecated`);
      if (counts.unknown.length) parts.push(`${counts.unknown.length} unknown (${counts.unknown.join(', ')})`);
      return [`${waveNum}: ${parts.join(', ') || 'no tasks'}`];
    })()),
    ...(workflow.wave_goal ? [`Wave goal: ${workflow.wave_goal}`] : []),
    ...(workflow.wave_strategy_note ? [`Strategy note: ${workflow.wave_strategy_note}`] : []),
    ...((() => {
      if (!trajectorySummary || !trajectorySummary.length) return [];
      const compact = trajectorySummary.map((r) => `${r.role} ${r.count} (${r.successPct}%)`).join(', ');
      return [`Trajectories: ${compact}`];
    })()),
    `Active task: ${workflow.active_task || 'none — no in-flight task'}`,
    `Task status: ${workflow.task_status || 'unknown'}`,
    `Owner: ${workflow.owner || 'unknown'}`,
    `Classification: ${workflow.classification}`,
    `Last update: ${workflow.last_update || 'unknown'}`,
    '',
    renderList('Next handoff', workflow.next_handoff, 'none visible'),
    '',
    renderList('Waits / blockers', waitLines, 'none'),
  ];

  if (touchesConflicts && touchesConflicts.length > 0) {
    parts.push('');
    parts.push(`Touches conflicts (${touchesConflicts.length}):`);
    for (const conflict of touchesConflicts) {
      parts.push(`  - ${conflict.file} → ${conflict.tasks.join(', ')}`);
    }
  }

  if (workflow.deploy_contours >= 2 && workflow.deploy_pending_tasks && workflow.deploy_pending_tasks.length > 0) {
    const deployLines = workflow.deploy_pending_tasks.map(t => `${t.id}${t.repo ? ` (${t.repo})` : ''} — ${t.title}`);
    parts.push('', renderList('Pending prod deployment', deployLines, 'none'));
  }

  // T-496 (DR-005): render each task carrying a Hold: field so it reads as
  // deliberate rather than stalled, rather than folding it silently into
  // "Waits / blockers" alongside genuinely stuck work.
  const heldTasks = (waveTasks || []).filter((t) => t.hold);
  if (heldTasks.length > 0) {
    parts.push('', `Held tasks (${heldTasks.length}):`);
    for (const t of heldTasks) {
      const { what, why, since } = t.hold;
      const whySuffix = why ? ` — ${why}` : '';
      const sinceSuffix = since ? ` (since ${since})` : '';
      parts.push(`  - ${t.id} — hold: ${what || t.hold.raw}${whySuffix}${sinceSuffix}`);
    }
  }

  if (dueRechecks && dueRechecks.length > 0) {
    const overdueCount = dueRechecks.filter(e => e.overdue).length;
    const taskRefs = dueRechecks.map(e => recheckRef(e)).join(', ');
    const overdueSuffix = overdueCount > 0 ? ` (${overdueCount} overdue)` : '';
    parts.push('', `Due rechecks: ${dueRechecks.length} due: ${taskRefs}${overdueSuffix}`);
  }

  parts.push(
    '',
    renderList('Active runtime actors', activeActors, sources.sessions.ok ? 'no visible active runtime actors' : `runtime unavailable (${sources.sessions.reason})`),
    '',
    renderList('Historical / recently finished actors', historicalActors, 'none visible'),
    '',
    renderList('Recent movement', recentLines, 'none recorded'),
  );

  if (!sources.tasks.ok) {
    parts.push('', `Tasks runtime source unavailable: ${sources.tasks.reason}`);
    if (sources.tasks.raw) {
      parts.push(`Tasks raw output preview: ${normalizeWhitespace(sources.tasks.raw).slice(0, 200)}`);
    }
  }

  if (!sources.sessions.ok) {
    parts.push('', `Sessions runtime source unavailable: ${sources.sessions.reason}`);
    if (sources.sessions.raw) {
      parts.push(`Sessions raw output preview: ${normalizeWhitespace(sources.sessions.raw).slice(0, 200)}`);
    }
  }

  return parts.join('\n');
}

/**
 * Generate PROCESS_STATE.md from PROCESS_STATE.json.
 * Reads the JSON file at jsonPath and writes a human-readable MD file to mdPath.
 * The generated file starts with an auto-generated header comment.
 *
 * @param {string} jsonPath - Absolute path to PROCESS_STATE.json
 * @param {string} mdPath   - Absolute path to PROCESS_STATE.md (will be overwritten)
 */
function generateProcessStateMd(jsonPath, mdPath) {
  let json = {};
  try {
    if (fs.existsSync(jsonPath)) {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
  } catch {
    /* if JSON is unreadable, generate from empty state */
  }

  const initiative = json.initiative || 'unknown';
  const stage = json.stage || 'unknown';
  const wave = json.wave != null ? String(json.wave) : 'unknown';
  const waveSession = json.wave_session != null ? String(json.wave_session) : null;
  const stageOwner = json.stage_owner || 'main_agent';
  const blocker = json.blocker || null;
  const nextAction = json.next_action || null;
  const lastUpdated = json.last_updated || new Date().toISOString().slice(0, 10);
  const activeSlices = Array.isArray(json.active_slices) ? json.active_slices : [];

  const lines = [
    '<!-- auto-generated — do not edit manually -->',
    '# PROCESS_STATE',
    '',
    '## Current initiative',
    initiative,
    '',
    '## Current loop stage',
    stage,
    '',
    '## Wave',
    wave,
    ...(waveSession !== null ? ['', '## Wave session', waveSession] : []),
    '',
    '## Stage owner',
    stageOwner,
    '',
    '## Active slices',
  ];

  if (activeSlices.length > 0) {
    for (const slice of activeSlices) {
      const id = typeof slice === 'string' ? slice : (slice && slice.id) || null;
      const title = slice && typeof slice === 'object' && slice.title ? ` — ${slice.title}` : '';
      if (id) lines.push(`- ${id}${title}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('');
  lines.push('## Current blockers');
  lines.push(blocker ? `- ${blocker}` : '- none');

  lines.push('');
  lines.push('## Next expected handoff');
  lines.push(nextAction ? `- ${nextAction}` : '- none');

  lines.push('');
  lines.push('## Last update');
  lines.push(lastUpdated);
  lines.push('');

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
}

/**
 * Archive the active wave heading in BACKLOG.md at wave-close time.
 *
 * Renames: `## Active Wave — Wave N` → `## Wave N — Archived`
 *
 * If more than one `## Active Wave` heading is found, prints a warning to
 * stderr listing the line numbers and returns without modifying the file —
 * the caller should inspect and repair manually.
 *
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {number|string} waveNumber - The wave number that is being closed (e.g. 9)
 * @returns {{ ok: boolean, archived: boolean, warning: string|null }}
 */
function archiveActiveWaveInBacklog(backlogPath, waveNumber) {
  const content = fs.readFileSync(backlogPath, 'utf8');
  const lines = content.split(/\r?\n/);

  // Find all lines matching ## Active Wave (case-insensitive)
  const activeWaveLineNumbers = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Active Wave/i.test(lines[i])) {
      activeWaveLineNumbers.push(i + 1); // 1-based for display
    }
  }

  if (activeWaveLineNumbers.length === 0) {
    return { ok: true, archived: false, warning: 'No ## Active Wave heading found in BACKLOG.md — nothing to archive.' };
  }

  if (activeWaveLineNumbers.length > 1) {
    const warning =
      `Multiple ## Active Wave headings detected in BACKLOG.md at line(s): ${activeWaveLineNumbers.join(', ')}.\n` +
      'Repair required: manually archive older Active Wave sections before closing the current wave.\n' +
      'Rename each stale heading from `## Active Wave — Wave N` to `## Wave N — Archived`.';
    return { ok: false, archived: false, warning };
  }

  // Exactly one Active Wave heading — rename it
  const waveN = String(waveNumber);
  let matched = false;
  const updated = lines.map((line) => {
    // Match the exact wave number or any Active Wave heading with a wave number
    if (/^##\s+Active Wave/i.test(line)) {
      // Extract the wave number from the heading if present; fall back to provided waveNumber
      const waveMatch = line.match(/Wave\s+(\d+)/i);
      const headingWaveN = waveMatch ? waveMatch[1] : waveN;
      matched = true;
      return `## Wave ${headingWaveN} — Archived`;
    }
    return line;
  });

  if (!matched) {
    return { ok: true, archived: false, warning: null };
  }

  // After renaming the old "## Active Wave" to "## Wave N — Archived", insert a fresh
  // empty "## Active Wave" heading immediately before the newly-archived heading so that
  // subsequent --new-task / --apply-decomposition calls have a valid insertion point.
  const archivedHeading = `## Wave ${String(waveNumber)} — Archived`;
  // Find the index of the archived heading in `updated`
  let archivedIdx = updated.findIndex((l) => l === archivedHeading);
  // Fall back: find any "## Wave N — Archived" line (in case heading wave number differed)
  if (archivedIdx === -1) {
    archivedIdx = updated.findIndex((l) => /^## Wave \d+ — Archived/.test(l));
  }
  if (archivedIdx !== -1) {
    // Remove any trailing blank lines immediately before the archived heading so we can
    // insert with controlled spacing: one blank line before "## Active Wave" and one after.
    let insertAt = archivedIdx;
    while (insertAt > 0 && updated[insertAt - 1].trim() === '') {
      insertAt--;
    }
    updated.splice(insertAt, 0, '## Active Wave', '');
  }

  fs.writeFileSync(backlogPath, updated.join('\n'), 'utf8');
  return { ok: true, archived: true, warning: null };
}

// Terminal statuses considered "archivable" — same set used by
// parseActiveWaveMergedTitles / archiveMergedTasksFromActiveWave /
// parseMidWaveArchivedTasks below.
//
// T-573: `runtime_verified` belongs here — it is a post-merge status
// (merged → runtime_verified), so a task carrying it is strictly MORE
// finished than a `merged` one; leaving it out meant an optional
// runtime-verification step demoted a completed task back into "still
// blocking the wave". Deliberately NOT derived from IN_FLIGHT_STATUSES, and
// deliberately disjoint from TERMINAL_SKIP_STATUSES (deferred/deprecated) —
// this set means "completed work, archive it and count it in the wave
// summary", which is not true of a deferred task.
const ARCHIVABLE_TERMINAL_STATUSES = new Set(['merged', 'deployed_dev', 'deployed_prod', 'runtime_verified']);

/**
 * T-420: heading text for the mid-wave archive destination BACKLOG.md
 * section — distinct from the final `## Wave N — Archived` heading that
 * archiveActiveWaveInBacklog() produces at wave close, so a mid-wave
 * --archive-merged run never collides with the eventual wave-close rename.
 *
 * @param {number|string} waveNumber
 * @returns {string}
 */
function midWaveArchivedHeading(waveNumber) {
  return `## Wave ${waveNumber} — Archived (mid-wave)`;
}

/**
 * Split a slice of BACKLOG.md lines (already scoped to one section's body)
 * into a leading preamble (any lines before the first `### T-NNN` heading)
 * and an array of task blocks, each carrying its raw lines plus parsed
 * id/title/status.
 *
 * @param {string[]} sectionLines
 * @returns {{ preamble: string[], blocks: Array<{ lines: string[], id: string|null, title: string|null, status: string|null }> }}
 */
function extractTaskBlocksFromLines(sectionLines) {
  const blockStartIdxs = [];
  for (let i = 0; i < sectionLines.length; i++) {
    if (/^###\s+T-\d+/.test(sectionLines[i])) blockStartIdxs.push(i);
  }

  const preamble = blockStartIdxs.length ? sectionLines.slice(0, blockStartIdxs[0]) : sectionLines.slice();

  const blocks = [];
  for (let k = 0; k < blockStartIdxs.length; k++) {
    const s = blockStartIdxs[k];
    const e = blockStartIdxs[k + 1] !== undefined ? blockStartIdxs[k + 1] : sectionLines.length;
    const blockLines = sectionLines.slice(s, e);
    const text = blockLines.join('\n');
    const idMatch = text.match(/^###\s+(T-\d+)/);
    const titleMatch = text.match(/^###\s+T-\d+\s+—\s+(.+)$/m);
    const statusMatch = text.match(/^-\s+\*\*Status:\*\*\s+(.+)$/m);
    blocks.push({
      lines: blockLines,
      id: idMatch ? idMatch[1] : null,
      title: titleMatch ? titleMatch[1].trim() : null,
      status: statusMatch ? statusMatch[1].trim() : null,
    });
  }

  return { preamble, blocks };
}

/**
 * T-361: parse the `## Active Wave` section of BACKLOG.md and return the
 * titles of tasks whose Status has reached a merged/deployed terminal state.
 *
 * Scoping the scan to the Active Wave section (rather than TASK_STATUS.md's
 * ever-growing `## Recently completed tasks` section, which accumulates every
 * wave back to Wave 1) is what makes the resulting wave_summary describe only
 * the wave being closed instead of concatenating every prior wave's titles.
 * Must run before `archiveActiveWaveInBacklog` renames the heading away.
 *
 * T-420: when `waveNumber` is provided, the result additionally includes
 * titles from that wave's mid-wave archive section (`## Wave <waveNumber> —
 * Archived (mid-wave)`, written by `--archive-merged`) — so tasks archived
 * out of the Active Wave section mid-wave are not lost from the wave_summary
 * once the wave finally closes. Omitting `waveNumber` preserves the exact
 * pre-T-420 behavior (Active Wave section only).
 *
 * @param {string} backlogMarkdown - full contents of BACKLOG.md
 * @param {number|string} [waveNumber] - current open wave number; when given, also unions
 *   titles from that wave's mid-wave archive section
 * @returns {string[]} titles of merged/deployed tasks in the Active Wave section (and,
 *   when waveNumber given, its mid-wave archive section), in document order
 */
function parseActiveWaveMergedTitles(backlogMarkdown, waveNumber) {
  const lines = backlogMarkdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active Wave/i.test(l));

  let titles = [];
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break; }
    }

    const section = lines.slice(start + 1, end).join('\n');
    const blocks = section
      .split(/\n(?=###\s+T-\d+)/)
      .map((b) => b.trim())
      .filter((b) => /^###\s+T-\d+/.test(b));

    for (const block of blocks) {
      const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
      const statusMatch = block.match(/^-\s+\*\*Status:\*\*\s+(.+)$/m);
      if (headingMatch && statusMatch && ARCHIVABLE_TERMINAL_STATUSES.has(statusMatch[1].trim())) {
        titles.push(headingMatch[2]?.trim() || headingMatch[1]);
      }
    }
  }

  if (waveNumber === undefined || waveNumber === null) return titles;

  const archivedTitles = parseMidWaveArchivedTasks(backlogMarkdown, waveNumber)
    .filter((t) => t.status && ARCHIVABLE_TERMINAL_STATUSES.has(t.status))
    .map((t) => t.title);

  return [...archivedTitles, ...titles];
}

/**
 * T-420: parse the mid-wave archive section (`## Wave <waveNumber> —
 * Archived (mid-wave)`) written by `--archive-merged`, returning the task
 * blocks found there. Returns `[]` when the heading does not exist (the
 * common case — most waves never run --archive-merged).
 *
 * @param {string} backlogMarkdown - full contents of BACKLOG.md
 * @param {number|string} waveNumber
 * @returns {Array<{ id: string, title: string, status: string|null }>}
 */
function parseMidWaveArchivedTasks(backlogMarkdown, waveNumber) {
  const lines = backlogMarkdown.split(/\r?\n/);
  const heading = midWaveArchivedHeading(waveNumber);
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx === -1) return [];

  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const { blocks } = extractTaskBlocksFromLines(lines.slice(idx + 1, end));
  return blocks
    .filter((b) => b.id)
    .map((b) => ({ id: b.id, title: b.title || b.id, status: b.status }));
}

/**
 * T-420: move `merged`/`deployed_dev`/`deployed_prod` task blocks out of
 * BACKLOG.md's `## Active Wave` section into that wave's mid-wave archive
 * section (`## Wave <waveNumber> — Archived (mid-wave)`, created on demand,
 * appended to on repeat runs), leaving all other (in-flight) task blocks
 * untouched in place under `## Active Wave`.
 *
 * Mirrors archiveActiveWaveInBacklog()'s "exactly one Active Wave heading"
 * precondition and warning shape, but — unlike that function — does NOT
 * rename the Active Wave heading and does NOT require the wave to be
 * complete; it is designed to run mid-wave, any number of times.
 *
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {number|string} waveNumber - the currently open wave number
 * @returns {{ ok: boolean, archivedIds: string[], archivedTitles: string[], remainingIds: string[], warning: string|null }}
 */
function archiveMergedTasksFromActiveWave(backlogPath, waveNumber) {
  const content = fs.readFileSync(backlogPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const activeWaveLineIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Active Wave/i.test(lines[i])) activeWaveLineIdxs.push(i);
  }

  if (activeWaveLineIdxs.length === 0) {
    return {
      ok: true,
      archivedIds: [],
      archivedTitles: [],
      remainingIds: [],
      warning: 'No ## Active Wave heading found in BACKLOG.md — nothing to archive.',
    };
  }

  if (activeWaveLineIdxs.length > 1) {
    const warning =
      `Multiple ## Active Wave headings detected in BACKLOG.md at line(s): ${activeWaveLineIdxs.map((i) => i + 1).join(', ')}.\n` +
      'Repair required: manually archive older Active Wave sections before running --archive-merged.';
    return { ok: false, archivedIds: [], archivedTitles: [], remainingIds: [], warning };
  }

  const activeWaveIdx = activeWaveLineIdxs[0];
  let sectionEnd = lines.length;
  for (let i = activeWaveIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { sectionEnd = i; break; }
  }

  const sectionLines = lines.slice(activeWaveIdx + 1, sectionEnd);
  const { preamble, blocks } = extractTaskBlocksFromLines(sectionLines);

  const archivedBlocks = blocks.filter((b) => b.status && ARCHIVABLE_TERMINAL_STATUSES.has(b.status));
  const remainingBlocks = blocks.filter((b) => !(b.status && ARCHIVABLE_TERMINAL_STATUSES.has(b.status)));

  if (archivedBlocks.length === 0) {
    return {
      ok: true,
      archivedIds: [],
      archivedTitles: [],
      remainingIds: blocks.map((b) => b.id).filter(Boolean),
      warning: null,
    };
  }

  const newSectionLines = [...preamble, ...remainingBlocks.flatMap((b) => b.lines)];

  let updated = [
    ...lines.slice(0, activeWaveIdx + 1),
    ...newSectionLines,
    ...lines.slice(sectionEnd),
  ];

  // Position right after the (now shrunk) Active Wave section in `updated`.
  const newSectionEnd = activeWaveIdx + 1 + newSectionLines.length;

  const heading = midWaveArchivedHeading(waveNumber);
  const existingHeadingIdx = updated.findIndex((l) => l.trim() === heading);
  const archivedLines = archivedBlocks.flatMap((b) => b.lines);

  if (existingHeadingIdx !== -1) {
    // Append to the existing mid-wave archive section (a prior --archive-merged
    // run already created it for this wave).
    let archEnd = updated.length;
    for (let i = existingHeadingIdx + 1; i < updated.length; i++) {
      if (/^##\s+/.test(updated[i])) { archEnd = i; break; }
    }
    let insertAt = archEnd;
    while (insertAt > existingHeadingIdx + 1 && updated[insertAt - 1].trim() === '') insertAt--;
    updated = [
      ...updated.slice(0, insertAt),
      '',
      ...archivedLines,
      ...updated.slice(insertAt),
    ];
  } else {
    // Create a fresh mid-wave archive section right after the Active Wave section.
    updated = [
      ...updated.slice(0, newSectionEnd),
      heading,
      '',
      ...archivedLines,
      '',
      ...updated.slice(newSectionEnd),
    ];
  }

  fs.writeFileSync(backlogPath, updated.join('\n'), 'utf8');

  return {
    ok: true,
    archivedIds: archivedBlocks.map((b) => b.id).filter(Boolean),
    archivedTitles: archivedBlocks.map((b) => b.title).filter(Boolean),
    remainingIds: remainingBlocks.map((b) => b.id).filter(Boolean),
    warning: null,
  };
}

/**
 * T-440: heading text for a wave's parked BACKLOG.md section — created by
 * --park-wave, consumed (and removed) by --unpark-wave.
 *
 * @param {number|string} waveNumber
 * @returns {string}
 */
function parkedBacklogHeading(waveNumber) {
  return `## Wave ${waveNumber} — Parked`;
}

/**
 * T-440: heading text for a wave's parked TASK_STATUS.md section — created
 * by --park-wave, consumed (and removed) by --unpark-wave.
 *
 * @param {number|string} waveNumber
 * @returns {string}
 */
function parkedTaskStatusHeading(waveNumber) {
  return `## Parked tasks (Wave ${waveNumber})`;
}

/**
 * T-440: generic mover — cut ALL task blocks out of a named "active" section
 * (identified by `activeHeadingRegex`, e.g. BACKLOG's `## Active Wave` or
 * TASK_STATUS's `## Active tasks`) and place them, verbatim and in document
 * order, into a freshly created section titled `parkedHeading` immediately
 * following it. The active section's non-block preamble (any lines before
 * the first `### T-NNN` heading — typically blank lines) is left in place
 * untouched, which is what makes moveParkedBlocksToActiveSection() below able
 * to restore the original bytes exactly: the preamble never moves, only the
 * contiguous block content is cut out and later reinserted at the same spot.
 *
 * Requires exactly one match for `activeHeadingRegex` in `content` — zero or
 * multiple matches is reported via `error` (mirrors
 * archiveMergedTasksFromActiveWave()'s single-heading precondition).
 *
 * @param {string} content - full file content
 * @param {RegExp} activeHeadingRegex - matches the active section's heading line, e.g. /^##\s+Active Wave/i
 * @param {string} parkedHeading - exact heading line to create, e.g. "## Wave 5 — Parked"
 * @returns {{ ok: boolean, updated: string|null, taskIds: string[], error: string|null }}
 */
function moveActiveBlocksToParkedSection(content, activeHeadingRegex, parkedHeading) {
  const lines = content.split(/\r?\n/);

  const activeIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (activeHeadingRegex.test(lines[i])) activeIdxs.push(i);
  }

  if (activeIdxs.length === 0) {
    return { ok: false, updated: null, taskIds: [], error: `No heading matching ${activeHeadingRegex} found.` };
  }
  if (activeIdxs.length > 1) {
    return {
      ok: false,
      updated: null,
      taskIds: [],
      error: `Multiple headings matching ${activeHeadingRegex} found at line(s): ${activeIdxs.map((i) => i + 1).join(', ')}.`,
    };
  }

  const activeIdx = activeIdxs[0];
  let sectionEnd = lines.length;
  for (let i = activeIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { sectionEnd = i; break; }
  }

  const sectionLines = lines.slice(activeIdx + 1, sectionEnd);
  const { preamble, blocks } = extractTaskBlocksFromLines(sectionLines);

  if (blocks.length === 0) {
    return { ok: true, updated: content, taskIds: [], error: null };
  }

  const blocksChunk = blocks.flatMap((b) => b.lines);
  const taskIds = blocks.map((b) => b.id).filter(Boolean);

  // T-768: a non-task "### " sub-heading sitting inside the preamble (e.g. a
  // wave-goal heading like "### Wave 12 — old goal") must travel WITH the
  // blocks it introduces, not stay behind under the (now near-empty) active
  // section — otherwise a later --unpark-wave reinserts the blocks under a
  // *different* wave's heading instead of restoring a coherent grouping.
  // Only the trailing run starting at the LAST such heading moves; anything
  // before it stays in place, and preamble with no such heading at all
  // behaves exactly as before this change.
  let lastHeadingIdx = -1;
  for (let i = 0; i < preamble.length; i++) {
    if (/^###\s+/.test(preamble[i]) && !/^###\s+T-\d+/.test(preamble[i])) lastHeadingIdx = i;
  }
  const keepPreamble = lastHeadingIdx === -1 ? preamble : preamble.slice(0, lastHeadingIdx);
  const movingPreamble = lastHeadingIdx === -1 ? [] : preamble.slice(lastHeadingIdx);

  // Shrink the active section down to its (surviving) preamble only — that
  // surviving preamble is left byte-for-byte untouched at its original
  // offset relative to the heading, so a later unpark can restore it exactly.
  const updated = [
    ...lines.slice(0, activeIdx + 1),
    ...keepPreamble,
    parkedHeading,
    '',
    ...movingPreamble,
    ...blocksChunk,
    ...lines.slice(sectionEnd),
  ];

  return { ok: true, updated: updated.join('\n'), taskIds, error: null };
}

/**
 * T-440: inverse of moveActiveBlocksToParkedSection() — find the section
 * titled exactly `parkedHeadingExact`, remove it entirely, and reinsert its
 * block content immediately after the (currently preamble-only) active
 * section identified by `activeHeadingRegex`, restoring the original file
 * byte-for-byte (assuming no other edits touched either section between the
 * park and unpark calls).
 *
 * @param {string} content - full file content
 * @param {RegExp} activeHeadingRegex - matches the active section's heading line, e.g. /^##\s+Active Wave/i
 * @param {string} parkedHeadingExact - exact heading line to find and remove, e.g. "## Wave 5 — Parked"
 * @returns {{ ok: boolean, updated: string|null, taskIds: string[], error: string|null }}
 */
function moveParkedBlocksToActiveSection(content, activeHeadingRegex, parkedHeadingExact) {
  const lines = content.split(/\r?\n/);

  const parkedIdx = lines.findIndex((l) => l.trim() === parkedHeadingExact.trim());
  if (parkedIdx === -1) {
    return { ok: false, updated: null, taskIds: [], error: `No "${parkedHeadingExact}" section found.` };
  }

  let parkedEnd = lines.length;
  for (let i = parkedIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { parkedEnd = i; break; }
  }

  let bodyLines = lines.slice(parkedIdx + 1, parkedEnd);
  if (bodyLines[0] === '') {
    bodyLines = bodyLines.slice(1);
  } else {
    return {
      ok: false,
      updated: null,
      taskIds: [],
      error: `Malformed "${parkedHeadingExact}" section — expected a blank line immediately after the heading.`,
    };
  }

  const taskIds = [];
  for (const line of bodyLines) {
    const m = line.match(/^###\s+(T-\d+)/);
    if (m) taskIds.push(m[1]);
  }

  if (taskIds.length === 0) {
    return { ok: false, updated: null, taskIds: [], error: `"${parkedHeadingExact}" section contains no task blocks to restore.` };
  }

  const activeIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (activeHeadingRegex.test(lines[i])) activeIdxs.push(i);
  }
  if (activeIdxs.length === 0) {
    return { ok: false, updated: null, taskIds: [], error: `No heading matching ${activeHeadingRegex} found to restore into.` };
  }
  if (activeIdxs.length > 1) {
    return {
      ok: false,
      updated: null,
      taskIds: [],
      error: `Multiple headings matching ${activeHeadingRegex} found at line(s): ${activeIdxs.map((i) => i + 1).join(', ')}.`,
    };
  }

  const activeIdx = activeIdxs[0];
  let activeSectionEnd = lines.length;
  for (let i = activeIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { activeSectionEnd = i; break; }
  }

  if (activeSectionEnd > parkedIdx) {
    return {
      ok: false,
      updated: null,
      taskIds: [],
      error: 'Active section and parked section overlap unexpectedly — cannot safely restore.',
    };
  }

  const updated = [
    ...lines.slice(0, activeSectionEnd),
    ...bodyLines,
    ...lines.slice(activeSectionEnd, parkedIdx),
    ...lines.slice(parkedEnd),
  ];

  return { ok: true, updated: updated.join('\n'), taskIds, error: null };
}

function escapeRegExpLiteral(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * T-542: returns true only when `line` is a `### ` heading whose LEADING
 * task ID equals `taskId` exactly — never when `taskId` merely appears
 * somewhere inside the heading text (e.g. a title that *mentions* another
 * task's ID, such as "### T-541 — ... T-540 residuals ..." matching a
 * lookup for "T-540"). Accepts both the usual "### T-NNN — Title" shape
 * and a heading with no " — " separator at all (a heading whose leading ID
 * has trailing characters glued on, e.g. "### T-540x", is NOT matched —
 * the ID must be followed by either " —" or end-of-line/trailing whitespace).
 *
 * T-573: relocated here from mavp-operator-close-session.js so the block
 * movers in this file share ONE matcher with close-session's
 * moveTaskToCompleted() instead of carrying a second, drift-prone copy —
 * close-session re-exports it unchanged, and
 * scripts/test-task-heading-anchor.js still exercises it through that export.
 */
function isTaskHeadingFor(line, taskId) {
  if (!/^###\s+/.test(line)) return false;
  const re = new RegExp('^###\\s+' + escapeRegExpLiteral(taskId) + '(\\s+—|\\s*$)');
  return re.test(line);
}

/** Extracts the leading "T-NNN" id from a "### ..." heading line, or null. */
function headingLeadingTaskId(line) {
  const m = line.match(/^###\s+(T-\d+)/);
  return m ? m[1] : null;
}

/**
 * T-573: locate the `## <heading>` section named by `heading`, creating it on
 * demand when absent. Placement of a newly created section mirrors
 * archiveActiveWaveInBacklog()'s splice-a-heading-in approach: it goes
 * immediately BEFORE the first heading matching `beforeHeadingRegex` (default:
 * TASK_STATUS.md's `## Recently completed tasks`), which is the canonical slot
 * for the intermediate sections insertIntoActiveTasks() already knows about
 * (see its T-485 comment); when that anchor is absent the section is appended
 * at end of file.
 *
 * @param {string[]} lines - file content, already split into lines
 * @param {string} heading - exact heading line to find or create, e.g. "## Deferred tasks"
 * @param {RegExp} [beforeHeadingRegex] - anchor the created section is inserted before
 * @returns {{ lines: string[], headingIdx: number, created: boolean }}
 */
function ensureSectionHeading(lines, heading, beforeHeadingRegex = /^##\s+Recently completed tasks/) {
  const existingIdx = lines.findIndex((l) => l.trim() === heading.trim());
  if (existingIdx !== -1) return { lines, headingIdx: existingIdx, created: false };

  const anchorIdx = lines.findIndex((l) => beforeHeadingRegex.test(l));
  if (anchorIdx !== -1) {
    // Rewind past any blank lines directly above the anchor so the new section
    // is separated from the previous one by exactly one blank line.
    let insertAt = anchorIdx;
    while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
    const updated = [...lines.slice(0, insertAt), '', heading, '', ...lines.slice(anchorIdx)];
    return { lines: updated, headingIdx: insertAt + 1, created: true };
  }

  const updated = [...lines];
  while (updated.length > 0 && updated[updated.length - 1].trim() === '') updated.pop();
  updated.push('', heading, '');
  return { lines: updated, headingIdx: updated.length - 2, created: true };
}

/**
 * T-573: move the `### T-NNN` block for `taskId` out of whichever section it
 * currently sits in and into the section titled `destHeading`, creating that
 * destination section on demand (see ensureSectionHeading above). The block's
 * lines are relocated BYTE-FOR-BYTE — every field line (Evidence, Notes,
 * Superseded by, …) survives verbatim; nothing in the block is rewritten.
 *
 * Generalizes close-session's moveTaskToCompleted() (which hard-codes
 * "## Recently completed tasks" and no-ops when that section is missing) so
 * the same relocation works for a section a project may not have yet — the
 * `## Deferred tasks` case. Shares isTaskHeadingFor()'s anchored matcher and
 * its belt-and-braces identity re-check, so a heading that merely MENTIONS
 * another task's id can never be moved by mistake (T-542).
 *
 * @param {string} markdown - full file content
 * @param {string} taskId - e.g. "T-559"
 * @param {string} destHeading - exact destination heading, e.g. "## Deferred tasks"
 * @param {RegExp} [beforeHeadingRegex] - where a created section is inserted (see ensureSectionHeading)
 * @returns {{ ok: boolean, updated: string, created: boolean, error: string|null }}
 */
function moveTaskBlockToSection(markdown, taskId, destHeading, beforeHeadingRegex) {
  const lines = markdown.split(/\r?\n/);

  let taskStart = -1;
  let taskEnd = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (taskStart === -1) {
      if (isTaskHeadingFor(lines[i], taskId)) taskStart = i;
    } else if (/^###\s+/.test(lines[i]) || /^##\s+/.test(lines[i])) {
      taskEnd = i;
      break;
    }
  }

  if (taskStart === -1) {
    return { ok: false, updated: markdown, created: false, error: `No "### ${taskId}" block found.` };
  }

  // Belt-and-braces identity invariant on top of the anchored matcher above
  // (same guard moveTaskToCompleted() carries).
  if (headingLeadingTaskId(lines[taskStart]) !== taskId) {
    return { ok: false, updated: markdown, created: false, error: `Block at the matched heading is not headed by ${taskId}.` };
  }

  const taskBlock = lines.slice(taskStart, taskEnd);
  const remaining = [...lines.slice(0, taskStart), ...lines.slice(taskEnd)];

  const { lines: withSection, headingIdx, created } = ensureSectionHeading(remaining, destHeading, beforeHeadingRegex);

  const updated = [
    ...withSection.slice(0, headingIdx + 1),
    '',
    ...taskBlock,
    ...withSection.slice(headingIdx + 1),
  ];

  return { ok: true, updated: updated.join('\n'), created, error: null };
}

/**
 * Atomically rename a task heading in both BACKLOG.md and TASK_STATUS.md.
 *
 * Finds lines matching `### T-NNN — <any title>` and replaces the title
 * portion with newTitle. Works regardless of task status (planned, merged,
 * archived wave, etc.) to keep all occurrences consistent.
 *
 * @param {string} taskId   - Task ID in T-NNN format (e.g. "T-167")
 * @param {string} newTitle - New canonical title string
 * @param {string} backlogPath      - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath   - Absolute path to TASK_STATUS.md
 * @returns {{ ok: boolean, error?: string, backlogChanged: boolean, taskStatusChanged: boolean }}
 */
function renameTask(taskId, newTitle, backlogPath, taskStatusPath) {
  if (!taskId || !/^T-\d+$/.test(taskId)) {
    return { ok: false, error: `Invalid task ID format: "${taskId}". Expected T-NNN.`, backlogChanged: false, taskStatusChanged: false };
  }
  if (!newTitle || !newTitle.trim()) {
    return { ok: false, error: 'New title must not be empty.', backlogChanged: false, taskStatusChanged: false };
  }

  const escapedId = taskId.replace('-', '\\-');
  const headingPattern = new RegExp(`^(###\\s+${escapedId}\\s+—\\s+)(.+)$`, 'gm');

  let backlogChanged = false;
  let taskStatusChanged = false;
  let foundInBacklog = false;
  let foundInTaskStatus = false;

  // Process BACKLOG.md
  if (!fs.existsSync(backlogPath)) {
    return { ok: false, error: `BACKLOG.md not found at ${backlogPath}`, backlogChanged: false, taskStatusChanged: false };
  }
  const backlogContent = fs.readFileSync(backlogPath, 'utf8');
  foundInBacklog = headingPattern.test(backlogContent);
  headingPattern.lastIndex = 0; // reset after test()

  // Process TASK_STATUS.md
  if (!fs.existsSync(taskStatusPath)) {
    return { ok: false, error: `TASK_STATUS.md not found at ${taskStatusPath}`, backlogChanged: false, taskStatusChanged: false };
  }
  const taskStatusContent = fs.readFileSync(taskStatusPath, 'utf8');
  foundInTaskStatus = headingPattern.test(taskStatusContent);
  headingPattern.lastIndex = 0;

  if (!foundInBacklog && !foundInTaskStatus) {
    return { ok: false, error: `${taskId} not found in BACKLOG.md or TASK_STATUS.md.`, backlogChanged: false, taskStatusChanged: false };
  }

  const trimmedTitle = newTitle.trim();

  if (foundInBacklog) {
    const updated = backlogContent.replace(headingPattern, `$1${trimmedTitle}`);
    if (updated !== backlogContent) {
      fs.writeFileSync(backlogPath, updated, 'utf8');
      backlogChanged = true;
    }
  }

  if (foundInTaskStatus) {
    const updated = taskStatusContent.replace(headingPattern, `$1${trimmedTitle}`);
    if (updated !== taskStatusContent) {
      fs.writeFileSync(taskStatusPath, updated, 'utf8');
      taskStatusChanged = true;
    }
  }

  return { ok: true, backlogChanged, taskStatusChanged };
}

/**
 * Parse all task blocks from a TASK_STATUS.md or BACKLOG.md string.
 * Splits on `### T-NNN` headings and returns an array of raw block strings.
 *
 * @param {string} markdown - Raw file content
 * @returns {string[]} Array of raw task block strings (each starts with ### T-NNN)
 */
function parseAllTaskBlocks(markdown) {
  return markdown
    .split(/\n(?=###\s+T-\d+)/)
    .map((block) => block.trim())
    .filter((block) => /^###\s+T-\d+/.test(block));
}

/**
 * Extract trajectory records for a given role from TASK_STATUS.md and BACKLOG.md.
 *
 * Reads all merged tasks where the Owner role matches the given role, and emits
 * one trajectory record per matching task using evidence text heuristics.
 *
 * @param {string} role - Role name to filter by (e.g. "developer")
 * @param {object} [options]
 * @param {string} [options.taskStatusPath] - Override path to TASK_STATUS.md
 * @param {string} [options.backlogPath] - Override path to BACKLOG.md
 * @param {string} [options.executionLogPath] - Override path to EXECUTION_LOG.md (reserved for future use)
 * @returns {Array<{taskId:string,role:string,status:string,needsFixCount:number,validatorExitCode:number,qaOutcome:string,evidenceFlags:string[],toolUses:(number|undefined)}>}
 */
function extractTrajectories(role, options = {}) {
  const taskStatusPath = options.taskStatusPath || TASK_STATUS_PATH;
  const backlogPath = options.backlogPath || BACKLOG_PATH;

  const taskStatusContent = fs.existsSync(taskStatusPath) ? readUtf8(taskStatusPath) : '';
  const backlogContent = fs.existsSync(backlogPath) ? readUtf8(backlogPath) : '';

  // Build a map of taskId -> backlog metadata (verification_type, owner role)
  const backlogBlocks = parseAllTaskBlocks(backlogContent);
  const backlogMeta = new Map();
  for (const block of backlogBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];
    const verTypeMatch = block.match(/[-*]\s+\*\*Verification type:\*\*\s+(.+)/i);
    const ownerMatch = block.match(/[-*]\s+\*\*Owner role:\*\*\s+(.+)/i);
    backlogMeta.set(taskId, {
      verificationType: verTypeMatch ? normalizeWhitespace(verTypeMatch[1]) : '',
      ownerRole: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : '',
    });
  }

  // Parse all task blocks from TASK_STATUS.md
  const statusBlocks = parseAllTaskBlocks(taskStatusContent);
  const trajectories = [];

  for (const block of statusBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    // Check status is a terminal-success state
    const DONE = new Set(['merged', 'deployed_dev', 'deployed_prod']);
    const statusMatch = block.match(/[-*]\s+\*\*Status:\*\*\s+(\S+)/i);
    if (!statusMatch) continue;
    const status = normalizeWhitespace(statusMatch[1]);
    if (!DONE.has(status)) continue;

    // Check owner role -- try both "Owner role:" and "Owner:" fields
    const ownerRoleMatch = block.match(/[-*]\s+\*\*Owner role:\*\*\s+(.+)/i);
    const ownerFallbackMatch = block.match(/[-*]\s+\*\*Owner:\*\*\s+(.+)/i);
    const ownerRole = normalizeWhitespace(
      (ownerRoleMatch && ownerRoleMatch[1]) || (ownerFallbackMatch && ownerFallbackMatch[1]) || ''
    );

    // Fall back to backlog metadata if not in TASK_STATUS block
    const meta = backlogMeta.get(taskId) || {};
    const effectiveOwnerRole = ownerRole || meta.ownerRole || '';
    if (effectiveOwnerRole !== role) continue;

    // Extract evidence block (everything after "**Evidence:**" on that line)
    const evidenceLineMatch = block.match(/[-*]\s+\*\*Evidence:\*\*\s+([\s\S]*?)(?=\n[-*]\s+\*\*|\n###|\s*$)/i);
    const evidenceText = evidenceLineMatch ? evidenceLineMatch[1] : '';
    const evidenceLower = evidenceText.toLowerCase();

    // Determine verification_type (from TASK_STATUS block or backlog)
    const verTypeBlockMatch = block.match(/[-*]\s+\*\*Verification type:\*\*\s+(.+)/i);
    const verificationType = verTypeBlockMatch
      ? normalizeWhitespace(verTypeBlockMatch[1])
      : meta.verificationType || '';

    // --- needsFixCount: explicit field overrides heuristic ---
    const explicitFixRoundsMatch = evidenceText.match(/needs_fix_rounds:\s*(\d+)/i);
    let needsFixCount;
    if (explicitFixRoundsMatch) {
      // explicit field overrides heuristic
      needsFixCount = parseInt(explicitFixRoundsMatch[1], 10);
    } else {
      // Fall back to keyword heuristic. Negative lookahead excludes matches that are
      // part of the literal field-name token `needs_fix_rounds` (a documentation
      // mention of the field, e.g. "record needs_fix_rounds: N" is not a fix-round
      // occurrence) while still counting genuine prose keyword mentions such as
      // "entered needs_fix twice".
      const needsFixMatches = evidenceLower.match(/needs[_\s]fix(?!_rounds)/g) || [];
      needsFixCount = needsFixMatches.length;
    }

    // --- validatorExitCode: explicit field overrides heuristic ---
    const explicitValidatorBlockedMatch = evidenceText.match(/validator_blocked:\s*(true|false)/i);
    let validatorExitCode;
    if (explicitValidatorBlockedMatch) {
      // explicit field overrides heuristic
      validatorExitCode = explicitValidatorBlockedMatch[1].toLowerCase() === 'true' ? 2 : 0;
    } else {
      // Fall back to keyword heuristic
      validatorExitCode = /exit code 2|validator exit 2/.test(evidenceLower) ? 2 : 0;
    }

    // --- qaOutcome heuristic ---
    let qaOutcome;
    if (verificationType === 'artifact') {
      qaOutcome = 'skipped';
    } else if (/qa_passed|passed/.test(evidenceLower)) {
      qaOutcome = 'passed';
    } else if (/failed|qa_failed/.test(evidenceLower)) {
      qaOutcome = 'failed';
    } else {
      qaOutcome = 'skipped';
    }

    // Apply needsFixCount adjustment: subtract 1 if outcome is passed and there were needs_fix mentions
    // (the last needs_fix loop resolves into a pass). Skip when explicit field was used — the
    // author-supplied value is already the final count and needs no heuristic correction.
    if (!explicitFixRoundsMatch && qaOutcome === 'passed' && needsFixCount > 0) {
      needsFixCount = Math.max(0, needsFixCount - 1);
    }

    // --- evidenceFlags heuristic ---
    const evidenceFlags = [];
    if (/outside scope/.test(evidenceLower)) evidenceFlags.push('scope_deviation');
    if (/skipped commit/.test(evidenceLower)) evidenceFlags.push('skipped_commit');
    if (/missing commit/.test(evidenceLower)) evidenceFlags.push('missing_commit');
    if (/error/.test(evidenceText)) evidenceFlags.push('evidence_error');

    // --- toolUses: optional explicit field, additive (no fallback heuristic) ---
    // Recorded by the Main Agent at task completion as `tool_uses: <N>` in the
    // evidence block (value sourced from the task-completion notification's
    // tool_uses count). Absent on older/other records — omitted, not defaulted.
    const toolUsesMatch = evidenceText.match(/tool_uses:\s*(\d+)/i);

    const record = {
      taskId,
      role,
      status,
      needsFixCount,
      validatorExitCode,
      qaOutcome,
      evidenceFlags,
    };
    if (toolUsesMatch) {
      record.toolUses = parseInt(toolUsesMatch[1], 10);
    }

    trajectories.push(record);
  }

  return trajectories;
}

/**
 * Write trajectory records to `.mavp/trajectories/<role>.jsonl`.
 * Creates the output directory if it does not exist. Overwrites existing file
 * (rewrite-not-append is intentional — each run produces a canonical snapshot).
 *
 * Deduplication: records with a `taskId` field are collapsed to one record per
 * taskId using last-wins semantics. Records missing `taskId` are preserved
 * as-is to avoid silent data loss.
 *
 * @param {string} role - Role name (used as filename stem)
 * @param {Array} trajectories - Array of trajectory objects from extractTrajectories()
 * @param {object} [options]
 * @param {string} [options.outputDir] - Override default .mavp/trajectories/ directory
 */
function writeTrajectories(role, trajectories, options = {}) {
  const outputDir = options.outputDir || path.join(ROOT, '.mavp', 'trajectories');
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${role}.jsonl`);

  // Deduplicate: last-wins per taskId; records without taskId pass through unchanged.
  const seenIds = new Map();
  const noIdRecords = [];
  for (const t of trajectories) {
    if (t.taskId !== undefined && t.taskId !== null) {
      seenIds.set(t.taskId, t);
    } else {
      noIdRecords.push(t);
    }
  }
  const deduped = [...seenIds.values(), ...noIdRecords];

  // Rewrite (not append) — produces a canonical snapshot on every run.
  const lines = deduped.map((t) => JSON.stringify(t)).join('\n');
  fs.writeFileSync(filePath, lines ? lines + '\n' : '', 'utf8');
}

/**
 * Returns a score in [0.0, 1.0] for a trajectory record.
 * Higher = better agent performance on this task.
 *
 * Formula:
 *   base:
 *     qaOutcome === "passed"  → 1.0
 *     qaOutcome === "skipped" → 0.8  (artifact/runtime tasks that skip QA agent)
 *     qaOutcome === "failed"  → 0.0
 *
 *   penalties (applied after base):
 *     − 0.1 × max(0, needsFixCount − 1)
 *     − 0.2 if validatorExitCode === 2
 *     − 0.1 × evidenceFlags.length
 *
 *   result = clamp(base − penalties, 0.0, 1.0)
 */
function scoreTrajectory(trajectory) {
  const { qaOutcome, needsFixCount, validatorExitCode, evidenceFlags } = trajectory;

  let base;
  if (qaOutcome === 'passed') {
    base = 1.0;
  } else if (qaOutcome === 'skipped') {
    base = 0.8;
  } else {
    base = 0.0;
  }

  const penaltyNeedsFix = 0.1 * Math.max(0, needsFixCount - 1);
  const penaltyValidator = validatorExitCode === 2 ? 0.2 : 0;
  const penaltyFlags = 0.1 * (evidenceFlags ? evidenceFlags.length : 0);

  const raw = base - penaltyNeedsFix - penaltyValidator - penaltyFlags;
  const score = Math.round(raw * 1e10) / 1e10;
  return Math.max(0, Math.min(1, score));
}

/**
 * Splits scored trajectories into deterministic train/holdout partitions for
 * the skill reflection loop (T-699).
 *
 * Replaces the prior taskId-localeCompare-prefix-slice split, which had three
 * measured defects on a real adopter corpus of 304 trajectories: (1) it was
 * chronological (taskId assignment order is sequential), so holdout silently
 * accumulated only the newest era of trajectories — both of the corpus's
 * most recent failures landed there, structurally unreachable to the
 * optimizer, while training contained only one failure out of three total;
 * (2) `trainCount = floor(n * 0.7)` grows with corpus size, so a task near
 * the boundary migrates holdout -> train whenever the corpus grows,
 * contradicting the "stability" the prior comment claimed but never
 * delivered; (3) lexicographic string comparison stops being chronological
 * at four-digit ids (e.g. a four-digit id can sort ahead of a three-digit id
 * beginning with a higher digit), silently scrambling the split once any
 * adopter reaches that range.
 *
 * Rules (all deterministic — no RNG, no clock, no run-order dependence):
 *   - Parse the numeric portion of `taskId` (e.g. "T-123" -> 123). An id
 *     that can't be parsed goes to train deterministically.
 *   - Any trajectory scoring below 0.7 goes to train UNCONDITIONALLY — a
 *     failure is the scarce contrast signal the failure minibatch exists to
 *     consume (three in three hundred on the measured corpus), and
 *     withholding ~30% of them in a holdout that no v1 code path reads is
 *     pure loss with no offsetting benefit.
 *   - A trajectory scoring >= 0.7 goes to holdout iff `numericId % 10` is 7,
 *     8, or 9; otherwise it goes to train. Modulo on the numeric id — never
 *     on score order, never randomized — is what makes the split BOTH
 *     reproducible across repeated runs on the same input AND stable per
 *     task as the corpus grows: a task's bucket is a pure function of its
 *     own id, so it never migrates when new trajectories are appended,
 *     unlike the floor(n * 0.7) prefix slice it replaces.
 *
 * A task's score changing between runs (e.g. because evidence was enriched
 * with a previously-missing `needs_fix_rounds:` or `validator_blocked:`
 * field) can legitimately move it from success to failure and therefore from
 * holdout to train. That is desired, not a defect: a newly recognized
 * failure must reach the optimizer regardless of which modulo bucket its id
 * falls in. The holdout set is unused by v1 (reserved for the v2 spec in
 * docs/SKILL_OPTIMIZATION.md §12.1) so its size floating near, rather than
 * exactly at, 30% is accepted.
 *
 * @param {Array<{taskId: string, score: number}>} scored
 * @returns {{trainSet: Array, holdoutSet: Array}}
 */
function splitTrajectoriesForReflect(scored) {
  const trainSet = [];
  const holdoutSet = [];

  for (const t of scored) {
    const match = typeof t.taskId === 'string' ? t.taskId.match(/(\d+)/) : null;
    const numericId = match ? parseInt(match[1], 10) : NaN;

    if (t.score < 0.7 || Number.isNaN(numericId)) {
      trainSet.push(t);
      continue;
    }

    if (numericId % 10 >= 7) {
      holdoutSet.push(t);
    } else {
      trainSet.push(t);
    }
  }

  return { trainSet, holdoutSet };
}

/**
 * Parses an Anthropic Messages API response from the skill-optimizer call.
 *
 * Selects text content by block `type` — never indexes block zero, since a
 * pinned model may return a non-text block (e.g. `thinking`) first. Joins
 * ALL `type === 'text'` blocks (a response can legitimately split its text
 * across more than one block), rather than taking only the first.
 *
 * Distinguishes response-shape failures (no text content, or text content
 * that isn't valid/extractable JSON) from transport failures — the caller
 * is responsible for keeping its `API call failed:` prefix scoped to the
 * network call itself, not this parsing step.
 *
 * Takes a PLAIN object and imports nothing from `@anthropic-ai/sdk`, so it
 * is testable offline with fixture objects.
 *
 * @param {{content?: Array<{type?: string, text?: string}>, stop_reason?: string}} response
 * @returns {{result: object|null, error: string|null}} exactly one of the two is non-null
 */
function parseOptimizerResponse(response) {
  const content = Array.isArray(response && response.content) ? response.content : [];
  const stopReason = response && response.stop_reason !== undefined && response.stop_reason !== null
    ? response.stop_reason
    : 'unknown';

  const textBlocks = content.filter(
    (block) => block && block.type === 'text' && typeof block.text === 'string'
  );

  if (textBlocks.length === 0) {
    const blockTypes = content.length > 0 ? content.map((b) => (b && b.type) || 'unknown').join(', ') : 'none';
    return {
      result: null,
      error: `Optimizer response contained no text content block (block types present: ${blockTypes}; stop_reason: ${stopReason})`,
    };
  }

  const rawJson = textBlocks.map((b) => b.text).join('');

  try {
    return { result: JSON.parse(rawJson), error: null };
  } catch (parseErr) {
    // Try to extract JSON from the response if it has surrounding text
    const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return { result: JSON.parse(jsonMatch[0]), error: null };
      } catch {
        // fall through to the error below
      }
    }
    return {
      result: null,
      error: `JSON parse failed: ${parseErr.message}. Raw text (first 200 chars): ${rawJson.slice(0, 200)}. stop_reason: ${stopReason}`,
    };
  }
}

/**
 * Contrast floor for the failure minibatch, anchored to
 * docs/SKILL_OPTIMIZATION.md §12.2's v2 contrast requirement ("≥ 3 with
 * qaOutcome != passed"). A failure batch below this floor is not blocked —
 * see the architect ruling in T-700 — but is disclosed to the human
 * reviewer so a proposal generalizing from one or two trajectories cannot
 * pass as a large-N result. The empty-batch guard (failureBatch.length ===
 * 0) is a separate, pre-existing gate in mavp-skill-reflect.js and is
 * unaffected by this constant.
 */
const FAILURE_CONTRAST_FLOOR = 3;

/**
 * Builds the failure-batch contrast disclosure surfaced in a skill-reflect
 * proposal: how many trajectories informed the success/failure minibatches,
 * which task IDs make up the failure batch, and — only when the failure
 * batch sits below FAILURE_CONTRAST_FLOOR — a low-contrast warning string
 * (for both the proposal body and stdout) and an optimizer-prompt caveat
 * string. Disclosure never blocks: the caller always writes the proposal
 * and always exits 0 regardless of what this function returns.
 *
 * Takes PLAIN arrays of trajectory-like objects (each needs only a
 * `taskId` field) and returns PLAIN data — no file I/O, no network — same
 * offline-testable shape as parseOptimizerResponse and
 * splitTrajectoriesForReflect above.
 *
 * @param {Array<{taskId?: string}>} successBatch
 * @param {Array<{taskId?: string}>} failureBatch
 * @returns {{
 *   successCount: number,
 *   failureCount: number,
 *   failureIds: string[],
 *   lowContrast: boolean,
 *   metadataLines: string[],
 *   warning: string|null,
 *   promptCaveat: string|null
 * }}
 */
function renderFailureContrastDisclosure(successBatch, failureBatch) {
  const successList = Array.isArray(successBatch) ? successBatch : [];
  const failureList = Array.isArray(failureBatch) ? failureBatch : [];

  const successCount = successList.length;
  const failureIds = failureList.map((t) => (t && t.taskId !== undefined ? String(t.taskId) : 'unknown'));
  const failureCount = failureIds.length;
  const lowContrast = failureCount > 0 && failureCount < FAILURE_CONTRAST_FLOOR;

  const idsText = failureCount > 0 ? failureIds.join(', ') : 'none';

  const metadataLines = [
    `- Success batch size: ${successCount}`,
    `- Failure batch size: ${failureCount} (${idsText})`,
  ];

  let warning = null;
  let promptCaveat = null;

  if (lowContrast) {
    const noun = failureCount === 1 ? 'trajectory' : 'trajectories';
    warning =
      `**Low-contrast warning:** this proposal's failure batch has only ${failureCount} ${noun} ` +
      `(${idsText}) — below the contrast floor of ${FAILURE_CONTRAST_FLOOR} (docs/SKILL_OPTIMIZATION.md ` +
      `§12.2). Treat the rationale below as generalized from very few cases, not a stable pattern.`;

    promptCaveat =
      `Caution: the failure batch you were given contains only ${failureCount} ${noun} ` +
      `(${idsText}) — below the ${FAILURE_CONTRAST_FLOOR}-trajectory contrast floor. Do not generalize ` +
      `a failure pattern from so few cases. Prefer proposing no edits over weakly supported ones.`;
  }

  return { successCount, failureCount, failureIds, lowContrast, metadataLines, warning, promptCaveat };
}

/**
 * Discloses to the optimizer model exactly which project-operating-
 * constraints corpora it was NOT given, and prohibits it from proposing
 * edits that mandate process-level behavior (T-703).
 *
 * Added after a live adopter run where the optimizer, in good faith,
 * proposed a developer-spec edit instructing "run the full existing test
 * suite" — a categorical violation of docs/core/ORCHESTRATION_RULES.md's
 * "Test-execution scope (worktree developers)" that the optimizer had
 * simply never been shown, because the prompt is built from only the
 * stripped role spec and the two scored minibatches. The architect
 * rejected injecting the constraints corpus itself: it is over a thousand
 * lines, a curated partial digest would be a second unsynced copy of
 * normative text, and it creates false confidence twice (the model treats
 * the digest as exhaustive, the reviewer over-trusts an edit that
 * "passed" it). This is the honest inverse — disclose the blind spot and
 * narrow the model's edit scope accordingly, claiming nothing false.
 */
const OPTIMIZER_CONSTRAINTS_DISCLOSURE = [
  '## What you were not shown',
  '',
  "You were NOT given this project's own operating rules (its `.claude/rules/*.md` files and its `CLAUDE.md`), and you were NOT given the framework's `docs/core/ORCHESTRATION_RULES.md`. You cannot know what those documents require, and the trajectories below are not a substitute for them.",
  '',
  'Because of this, do not propose any edit that mandates PROCESS-level behavior — anything governing test-execution scope, git operations, push/commit rituals, task registration or status transitions, or permissions. If a failure trajectory looks like it stems from a process rule, name the pattern in your rationale text only; do not encode it as an edit operation. A process-shaped edit proposed without seeing the process rules risks re-mandating exactly the behavior those rules already prohibit.',
].join('\n');

/**
 * Builds the full optimizer prompt sent as the user message to the
 * skill-reflect optimizer model. Pure helper — no SDK dependency, no
 * network, no file I/O — so it is unit-testable offline like
 * parseOptimizerResponse and splitTrajectoriesForReflect above.
 *
 * Deliberately preserves the JSON response-format block byte-for-byte
 * from the pre-T-703 inline version in mavp-skill-reflect.js: this task
 * changes only what the model is told about its own blind spots, never
 * the response contract parseOptimizerResponse() parses.
 *
 * @param {{
 *   role: string,
 *   strippedSpec: string,
 *   successBatch: Array<object>,
 *   failureBatch: Array<object>,
 *   promptCaveat?: string|null
 * }} options
 * @returns {string}
 */
function buildOptimizerPrompt({ role, strippedSpec, successBatch, failureBatch, promptCaveat }) {
  const successList = Array.isArray(successBatch) ? successBatch : [];
  const failureList = Array.isArray(failureBatch) ? failureBatch : [];

  return [
    `You are optimizing the skill document for the "${role}" agent role in the Mavericks framework.`,
    '',
    OPTIMIZER_CONSTRAINTS_DISCLOSURE,
    '',
    `## Current skill document (editable portions only — protected sections replaced with placeholders)`,
    strippedSpec,
    '',
    `## Successful trajectories (score ≥ 0.7) — ${successList.length} examples`,
    JSON.stringify(successList, null, 2),
    '',
    `## Failure trajectories (score < 0.7) — ${failureList.length} examples`,
    JSON.stringify(failureList, null, 2),
    '',
    ...(promptCaveat ? [promptCaveat, ''] : []),
    '## Instructions',
    'Propose at most 2 edit operations (add, delete, or replace) that would improve agent performance based on patterns in the failure trajectories while preserving what works in the successes.',
    '',
    'Respond with ONLY a JSON object in this exact format:',
    '{',
    '  "rationale": "one sentence explaining the key failure pattern observed",',
    '  "edits": [',
    '    {',
    '      "op": "add" | "delete" | "replace",',
    '      "targetSection": "section heading or \'end of file\'",',
    '      "rationale": "one sentence",',
    '      "before": "exact text to replace or delete (empty string for add)",',
    '      "after": "new text (empty string for delete)"',
    '    }',
    '  ]',
    '}',
  ].join('\n');
}

/**
 * Renders the conflict-check checklist block included verbatim in every
 * generated skill-reflect proposal (T-703). This is the human-facing half
 * of the same disclosure buildOptimizerPrompt() gives the model: an
 * adopter reviewing a proposal in their own repo will not have this
 * framework's docs/SKILL_OPTIMIZATION.md open, so the procedure has to
 * travel with the artifact itself. Both surfaces are built from this one
 * helper so their text cannot drift apart.
 *
 * Phrased corpus-agnostically so it reads correctly both in this repo and
 * in an adopter's: "this project's" rules/CLAUDE.md are whichever repo the
 * proposal was generated in (the installer syncs `.claude/rules` into
 * every adopter project, so both files genuinely exist there too), and
 * "the framework's" orchestration rules is always this document by name,
 * regardless of which repo is reading it. Nothing here reads or resolves
 * those files at run time — it only names where a human should look.
 *
 * Pure — returns plain text lines, no file I/O.
 *
 * @returns {string[]}
 */
function renderConflictCheckChecklist() {
  return [
    '## Conflict check',
    '',
    "The optimizer that generated this proposal was not shown this project's own operating rules (`.claude/rules/*.md`, `CLAUDE.md`) or the framework's `docs/core/ORCHESTRATION_RULES.md`, and cannot self-check a proposed edit against them. Before deciding below, check each proposed edit against all three:",
    '',
    "- [ ] Checked against this project's `.claude/rules/*.md`",
    "- [ ] Checked against this project's `CLAUDE.md`",
    "- [ ] Checked against the framework's `docs/core/ORCHESTRATION_RULES.md`",
    '',
  ];
}

/**
 * Summarize trajectory records from .mavp/trajectories/*.jsonl per role.
 *
 * @param {{ dir: string }} options - dir is the absolute path to the trajectories directory
 * @returns {Array<{role:string, count:number, successCount:number, successPct:number, blockedCount:number, needsFixCount:number}>}
 */
function summarizeTrajectories({ dir }) {
  if (!fs.existsSync(dir)) return [];

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const roleMap = {};

  for (const file of files) {
    const role = file.slice(0, -6); // strip .jsonl
    const filePath = path.join(dir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!roleMap[role]) {
        roleMap[role] = { role, count: 0, successCount: 0, blockedCount: 0, needsFixCount: 0 };
      }

      const entry = roleMap[role];
      entry.count++;

      const score = scoreTrajectory(record);
      if (score >= 0.7) entry.successCount++;

      if (record.validatorExitCode === 2 || record.validator_blocked === true) entry.blockedCount++;
      if (record.needsFixCount > 0) entry.needsFixCount++;
    }
  }

  return Object.values(roleMap).map((entry) => ({
    ...entry,
    successPct: entry.count > 0 ? Math.round((entry.successCount / entry.count) * 100) : 0,
  }));
}

/**
 * Parse all tasks from TASK_STATUS.md and BACKLOG.md into a minimal shape for
 * deploy-pending detection.  Reads from the "Active tasks" section in
 * TASK_STATUS.md; enriches repo from BACKLOG.md when not already present in
 * the TASK_STATUS block.
 *
 * @param {string} taskStatusMarkdown - Content of TASK_STATUS.md
 * @param {string} backlogMarkdown    - Content of BACKLOG.md
 * @returns {Array<{id:string,title:string,status:string,repo:string|null,deploy:'none'|null}>}
 */
function parseTasksWithRepo(taskStatusMarkdown, backlogMarkdown) {
  const lines = taskStatusMarkdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active tasks/.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).map((b) => b.trim()).filter(Boolean);

  // Build repo map (and the BACKLOG-only `Deploy:` opt-out map, T-815) from BACKLOG.md
  const backlogRepoMap = {};
  const backlogDeployMap = {};
  if (backlogMarkdown) {
    const bblocks = backlogMarkdown.split(/\n(?=###\s+T-)/).filter(Boolean);
    for (const block of bblocks) {
      const idMatch = block.match(/^###\s+(T-\d+)/m);
      if (!idMatch) continue;
      const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
      if (repoMatch) backlogRepoMap[idMatch[1]] = repoMatch[1].trim();
      const deployMatch = block.match(/^- \*\*Deploy:\*\*\s+(.+)$/m);
      const deployValue = deployMatch ? normalizeDeployField(deployMatch[1]) : null;
      if (deployValue) backlogDeployMap[idMatch[1]] = deployValue;
    }
  }

  return blocks.map((block) => {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
    const id = headingMatch ? headingMatch[1] : null;
    if (!id) return null;
    const repo = repoMatch
      ? repoMatch[1].trim()
      : (backlogRepoMap[id] || null);
    return {
      id,
      title: headingMatch ? headingMatch[2].trim() : 'unknown',
      status: statusMatch ? statusMatch[1].trim() : 'unknown',
      repo,
      deploy: backlogDeployMap[id] || null,
    };
  }).filter(Boolean);
}

/**
 * T-815: normalize the raw value of a BACKLOG-only `- **Deploy:**` field.
 * Returns the string 'none' when the trimmed value equals "none"
 * (case-insensitive); every other value (including empty) returns null —
 * other values are reserved and deliberately ignored. Reporting-only: this
 * never gates a status transition and the validator does not read it.
 *
 * @param {string|null|undefined} raw
 * @returns {'none'|null}
 */
function normalizeDeployField(raw) {
  if (typeof raw !== 'string') return null;
  return raw.trim().toLowerCase() === 'none' ? 'none' : null;
}

/** True when a parsed task or backlog-meta entry carries `Deploy: none`. */
function isDeployOptOut(entry) {
  return !!entry && entry.deploy === 'none';
}

/**
 * Build the full deploy queue for --agent output.  Mirrors the inline logic
 * previously in mavp-operator-agent.js so it can be shared without behaviour change.
 *
 * When deployContours <= 1 the queue is always empty.  Otherwise returns all
 * tasks with status 'merged' or a deployed status, enriched with deploy_pending
 * and prod_prerequisites fields.
 *
 * @param {Array<{id:string,title:string,status:string}>} activeTasks
 *   All tasks from the TASK_STATUS.md Active tasks section.
 * @param {Object<string,{prodPrerequisites:string[]}>} backlogMeta
 *   Per-task metadata from BACKLOG.md (prodPrerequisites list).
 * @param {number} deployContours
 *   Value of deploy_contours from PROCESS_STATE.json (default 2).
 * @returns {Array<{id:string,title:string,status:string,deploy_pending?:boolean,prod_prerequisites?:string[]}>}
 */
function buildDeployQueue(activeTasks, backlogMeta, deployContours) {
  const deployedStatuses = new Set(['deployed_dev', 'deployed_prod']);
  if (deployContours <= 1) return [];
  return activeTasks
    .filter((t) => t.status === 'merged' || deployedStatuses.has(t.status))
    .filter((t) => !isDeployOptOut(backlogMeta[t.id]))
    .map((t) => {
      const bm = backlogMeta[t.id] || {};
      const prodPrerequisites = bm.prodPrerequisites || [];
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        ...(t.status === 'merged' ? { deploy_pending: true } : {}),
        ...(prodPrerequisites.length > 0 ? { prod_prerequisites: prodPrerequisites } : {}),
      };
    });
}

/**
 * Return tasks that are deploy_pending (status === 'merged', deploy_contours > 1)
 * for a given repo name.  Matches repo by exact string or comma-separated list
 * entry.  Returns an empty array when deployContours <= 1 (no deploy pipeline)
 * or when repoName is absent / a placeholder.
 *
 * @param {Array<{id:string,title:string,status:string,repo:string|null}>} tasks
 * @param {string|null} repoName     - Repo name entered by the user (e.g. "example-service")
 * @param {number} deployContours    - Value of deploy_contours from PROCESS_STATE.json (default 2)
 * @returns {Array<{id:string,title:string,status:string,repo:string|null}>}
 */
function getDeployPendingForRepo(tasks, repoName, deployContours) {
  if (deployContours <= 1) return [];
  if (!repoName || repoName === 'TBD' || repoName === '—') return [];
  const name = repoName.trim();
  return tasks.filter((t) => {
    if (t.status !== 'merged') return false;
    if (isDeployOptOut(t)) return false;
    if (!t.repo) return false;
    const repos = t.repo.split(',').map((r) => r.trim());
    return repos.includes(name);
  });
}

/*
 * scoreTrajectory examples:
 *   { qaOutcome:'passed',  needsFixCount:0, validatorExitCode:0, evidenceFlags:[] }   → 1.0
 *   { qaOutcome:'passed',  needsFixCount:2, validatorExitCode:0, evidenceFlags:[] }   → 0.9
 *   { qaOutcome:'skipped', needsFixCount:0, validatorExitCode:0, evidenceFlags:[] }   → 0.8
 *   { qaOutcome:'skipped', needsFixCount:0, validatorExitCode:2, evidenceFlags:['scope_deviation'] } → 0.5
 *   { qaOutcome:'failed',  needsFixCount:0, validatorExitCode:2, evidenceFlags:[] }   → 0.0
 */

/**
 * Return today's date as a YYYY-MM-DD string, read from the real clock.
 * Shared helper so every recheck-due-date computation reads the clock
 * consistently (T-767) instead of some sites falling back to a stale
 * PROCESS_STATE.json `last_updated` value that may be days or weeks old.
 *
 * @returns {string} Current date as YYYY-MM-DD
 */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compute due and overdue recheck entries relative to a given date.
 *
 * Each entry in the rechecks[] registry (from PROCESS_STATE.json) has the shape:
 *   {
 *     id:        string    — e.g. "RC-1"
 *     task:      string    — e.g. "T-123" (reference to the completed task)
 *     title:     string    — self-contained title (survives task archival)
 *     due:       string    — YYYY-MM-DD absolute due date
 *     interval?: string    — optional repeat interval, e.g. "8w" (used by --ack-recheck --rearm)
 *     armed_at:  string    — YYYY-MM-DD when the recheck was registered
 *     note?:     string    — optional free-text note
 *   }
 *
 * Return shape:
 *   {
 *     due:     RecheckEntry[]  — entries where due === today (due today, not yet overdue)
 *     overdue: RecheckEntry[]  — entries where due < today (past due date)
 *   }
 *
 * Rules:
 *   - Future entries (due > today) are excluded from both arrays.
 *   - Entries with a missing or malformed `due` field are silently skipped (no throw).
 *   - An undefined / null / non-array `rechecks` argument yields { due: [], overdue: [] }.
 *
 * @param {Array|undefined|null} rechecks - Array of recheck entry objects from PROCESS_STATE.json
 * @param {string} today - Current date as YYYY-MM-DD string (passed explicitly for testability)
 * @returns {{ due: Array, overdue: Array }}
 */
function computeDueRechecks(rechecks, today) {
  const result = { due: [], overdue: [] };

  if (!Array.isArray(rechecks) || !rechecks.length) return result;
  if (!today || typeof today !== 'string') return result;

  for (const entry of rechecks) {
    // Tolerate non-object entries silently
    if (!entry || typeof entry !== 'object') continue;

    const due = entry.due;

    // Validate: must be a non-empty YYYY-MM-DD string
    if (!due || typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;

    // String comparison works correctly for YYYY-MM-DD
    if (due < today) {
      result.overdue.push(entry);
    } else if (due === today) {
      result.due.push(entry);
    }
    // due > today → future, excluded
  }

  return result;
}

/**
 * Look up a task title from BACKLOG.md or TASK_STATUS.md.
 * Scans for a heading matching "### T-NNN — <title>" and returns the title portion.
 * Returns null if the task is not found in either file.
 *
 * @param {string} taskId - Task ID in T-NNN format
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath - Absolute path to TASK_STATUS.md
 * @returns {string|null}
 */
function lookupTaskTitle(taskId, backlogPath, taskStatusPath) {
  const pattern = new RegExp(`^###\\s+${taskId}\\s+—\\s+(.+)$`, 'm');
  for (const filePath of [backlogPath, taskStatusPath]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(pattern);
      if (match) return match[1].trim();
    } catch {
      // ignore read errors — fall through to next file
    }
  }
  return null;
}

/**
 * Parse an interval string like "8w", "2d", "4weeks", "30days" into a number of days.
 * Supported units: d / day / days, w / week / weeks.
 * Returns null for unrecognised formats.
 *
 * @param {string} interval - Interval string, e.g. "8w"
 * @returns {number|null} Number of days, or null if unrecognised
 */
function parseIntervalDays(interval) {
  if (!interval || typeof interval !== 'string') return null;
  const m = interval.trim().match(/^(\d+)\s*(d|day|days|w|week|weeks)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'd' || unit === 'day' || unit === 'days') return n;
  // weeks
  return n * 7;
}

/**
 * Add days to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Uses UTC arithmetic to avoid DST shifts.
 *
 * @param {string} dateStr - YYYY-MM-DD base date
 * @param {number} days - Number of days to add
 * @returns {string} YYYY-MM-DD result
 */
function addDays(dateStr, days) {
  const ms = Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10),
  );
  const result = new Date(ms + days * 86400000);
  return result.toISOString().slice(0, 10);
}

/**
 * Validate an explicit due-date value (YYYY-MM-DD, a real calendar date,
 * not before today). Returns an error message string, or null when valid.
 * Shared by --park-wave --until (T-769) and --ack-recheck --rearm --due
 * (T-771) — a single source of truth for "is this an acceptable due date",
 * checked before any file write (compute-then-write contract).
 *
 * @param {string} dateStr - Candidate date, e.g. "2026-10-01"
 * @param {string} todayStr - Today's date, YYYY-MM-DD
 * @param {string} [flagName] - Flag name to cite in the error message
 *   (defaults to "--until" so existing --park-wave callers see unchanged
 *   text; pass "--due" for --ack-recheck --rearm)
 * @param {string} [pastLabel] - Trailing clause naming what the date is for,
 *   used only in the "before today" message (defaults to the --park-wave
 *   phrasing so existing callers see unchanged text)
 * @returns {string|null}
 */
function validateUntil(dateStr, todayStr, flagName = '--until', pastLabel = 'a parked-wave reminder must be due today or later') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `Invalid ${flagName} value "${dateStr}". Expected YYYY-MM-DD.`;
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
    return `Invalid ${flagName} value "${dateStr}". Not a real calendar date.`;
  }
  if (dateStr < todayStr) {
    return `Invalid ${flagName} value "${dateStr}". It is before today (${todayStr}) — ${pastLabel}.`;
  }
  return null;
}

/**
 * Human-facing reference for a recheck entry (T-769), shared by every
 * surface that names a recheck (snapshot "Due rechecks:" line, dashboard
 * Due Rechecks panel, validator overdue_recheck finding):
 *   - task entries  → the task id, e.g. "T-123"
 *   - wave entries  → "Wave N" (armed by --park-wave --until)
 *   - otherwise     → the recheck id, e.g. "RC-4"
 *
 * @param {object} entry - A rechecks[] entry from PROCESS_STATE.json
 * @returns {string}
 */
function recheckRef(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.task) return String(entry.task);
  if (entry.wave !== undefined && entry.wave !== null && entry.wave !== '') return `Wave ${entry.wave}`;
  return entry.id ? String(entry.id) : '';
}

/**
 * Validate a recheck request and append the new entry to an in-memory
 * PROCESS_STATE object (no file I/O). Shared by armRecheck() (which wraps it
 * in a read + write) and --park-wave --until (T-769), which must fold the
 * recheck into the same single PROCESS_STATE.json write that appends
 * parked_waves.
 *
 * Exactly one of `taskId` or `wave` must be given:
 *   - taskId → task entry; title looked up from BACKLOG.md / TASK_STATUS.md
 *     (falls back to the task id).
 *   - wave   → wave entry; stored as a number under `wave` with NO `task`
 *     key; an explicit non-empty `title` is required.
 *
 * @param {object} state - Parsed PROCESS_STATE.json object (mutated in place)
 * @param {object} opts  - Same options as armRecheck() minus processStateJsonPath
 * @returns {{ id: string, entry: object }}
 * @throws {Error} On both/neither taskId+wave, missing wave title, bad due/interval
 */
function appendRecheckEntry(state, opts) {
  const { taskId, wave, title: explicitTitle, due, interval, note, today, backlogPath, taskStatusPath } = opts;

  const hasTask = taskId !== undefined && taskId !== null && taskId !== '';
  const hasWave = wave !== undefined && wave !== null && wave !== '';
  if (hasTask && hasWave) {
    throw new Error('armRecheck: pass exactly one of taskId or wave, not both.');
  }
  if (!hasTask && !hasWave) {
    throw new Error('armRecheck: exactly one of taskId or wave is required.');
  }
  if (hasWave) {
    if (!/^\d+$/.test(String(wave))) {
      throw new Error(`armRecheck: invalid wave "${wave}". Expected an integer.`);
    }
    if (!explicitTitle || typeof explicitTitle !== 'string' || !explicitTitle.trim()) {
      throw new Error('armRecheck: an explicit title is required for a wave recheck.');
    }
  }

  // Validate due date format
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new Error(`Invalid --due value: "${due}". Expected YYYY-MM-DD.`);
  }

  // Validate interval if provided
  if (interval !== undefined && interval !== null && interval !== '') {
    if (parseIntervalDays(interval) === null) {
      throw new Error(`Invalid --interval value: "${interval}". Expected e.g. "8w", "2d", "4weeks".`);
    }
  }

  if (!Array.isArray(state.rechecks)) {
    state.rechecks = [];
  }

  // Generate next RC-N id
  let maxN = 0;
  for (const existing of state.rechecks) {
    if (existing && typeof existing.id === 'string') {
      const m = existing.id.match(/^RC-(\d+)$/);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
  }
  const newId = `RC-${maxN + 1}`;

  let entry;
  if (hasWave) {
    entry = {
      id: newId,
      wave: Number(wave),
      title: explicitTitle,
      due,
      armed_at: today,
    };
  } else {
    // Look up task title
    const foundTitle = lookupTaskTitle(taskId, backlogPath, taskStatusPath);
    entry = {
      id: newId,
      task: taskId,
      title: foundTitle || taskId,
      due,
      armed_at: today,
    };
  }
  if (interval) entry.interval = interval;
  if (note) entry.note = note;

  state.rechecks.push(entry);
  return { id: newId, entry };
}

/**
 * Arm a new recheck entry and persist it to PROCESS_STATE.json.
 *
 * Generates the next RC-N id by scanning the existing rechecks[] array.
 * Task entries: looks up the task title from BACKLOG.md / TASK_STATUS.md for
 * a self-contained entry, falling back to the task id as title if not found.
 * Wave entries (T-769): `wave` + explicit `title`, no `task` key.
 * Exactly one of taskId / wave is required (see appendRecheckEntry()).
 *
 * @param {object} opts
 * @param {string} [opts.taskId]     - Task ID, e.g. "T-123" (exclusive with wave)
 * @param {number|string} [opts.wave] - Wave number (exclusive with taskId)
 * @param {string} [opts.title]      - Explicit title (required with wave)
 * @param {string} opts.due          - Due date, YYYY-MM-DD
 * @param {string} [opts.interval]   - Repeat interval, e.g. "8w"
 * @param {string} [opts.note]       - Optional free-text note
 * @param {string} opts.today        - Today's date, YYYY-MM-DD (for armed_at)
 * @param {string} opts.processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @param {string} opts.backlogPath          - Absolute path to BACKLOG.md
 * @param {string} opts.taskStatusPath       - Absolute path to TASK_STATUS.md
 * @returns {{ id: string, entry: object }} The new RC-N id and the full entry object
 * @throws {Error} If PROCESS_STATE.json cannot be read/written, due is invalid,
 *                 or taskId/wave are both or neither given
 */
function armRecheck(opts) {
  const { today, processStateJsonPath } = opts;

  // Validate the request shape before touching the file, so a bad call
  // never reports a misleading read error.
  appendRecheckEntry({ rechecks: [] }, opts);

  // Read existing state
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read PROCESS_STATE.json: ${err.message}`);
  }

  const { id: newId, entry } = appendRecheckEntry(state, opts);
  state.last_updated = today;

  try {
    fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
  }

  return { id: newId, entry };
}

/**
 * Acknowledge (and optionally re-arm) a recheck entry in PROCESS_STATE.json.
 *
 * Without --rearm: removes the entry from rechecks[].
 * With --rearm:
 *   - opts.due given (T-771): sets due = that explicit date (format-validated
 *     via validateUntil(), must not be before today) and armed_at = today.
 *     No interval is required — this is what lets an interval-less entry
 *     (e.g. a wave recheck armed via --park-wave --until, which never carries
 *     an interval) be rearmed to an explicit date. The entry's `wave`/`task`
 *     and `title` fields are left untouched.
 *   - opts.due absent: unchanged pre-T-771 behavior — sets due = today +
 *     interval (in days); throws when the entry has no interval.
 *
 * @param {object} opts
 * @param {string} opts.recheckId    - Recheck ID, e.g. "RC-1"
 * @param {boolean} opts.rearm       - If true, reschedule instead of removing
 * @param {string} [opts.due]        - Explicit YYYY-MM-DD due date (T-771);
 *                                     only meaningful together with rearm
 * @param {string} opts.today        - Today's date, YYYY-MM-DD
 * @param {string} opts.processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @returns {{ removed: boolean, rearmed: boolean, newDue?: string, entry: object }}
 * @throws {Error} If the recheck ID is not found, if --rearm is given without
 *   --due and the entry has no interval, or if --due fails validation
 */
function ackRecheck(opts) {
  const { recheckId, rearm, due, today, processStateJsonPath } = opts;

  // Validate recheckId format
  if (!recheckId || !/^RC-\d+$/.test(recheckId)) {
    throw new Error(`Invalid recheck ID: "${recheckId}". Expected format RC-N (e.g. RC-1).`);
  }

  // Read existing state
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read PROCESS_STATE.json: ${err.message}`);
  }

  if (!Array.isArray(state.rechecks)) {
    throw new Error(`No rechecks[] array in PROCESS_STATE.json. "${recheckId}" not found.`);
  }

  const idx = state.rechecks.findIndex((e) => e && e.id === recheckId);
  if (idx === -1) {
    throw new Error(`Recheck "${recheckId}" not found in rechecks[].`);
  }

  const entry = state.rechecks[idx];

  if (rearm) {
    let newDue;
    if (due) {
      // T-771: explicit due date — validated before any write, no interval
      // required. Reuses the same rules as --park-wave --until.
      const dueError = validateUntil(due, today, '--due', 'a recheck must be due today or later');
      if (dueError) {
        throw new Error(dueError);
      }
      newDue = due;
    } else {
      // Pre-T-771 path: due = today + interval. Validate interval exists
      // and is parseable.
      if (!entry.interval) {
        throw new Error(
          `Cannot --rearm "${recheckId}": entry has no interval. ` +
            `Set an interval when arming (--interval 8w) to enable rearming.`
        );
      }
      const days = parseIntervalDays(entry.interval);
      if (days === null) {
        throw new Error(
          `Cannot --rearm "${recheckId}": interval "${entry.interval}" could not be parsed. ` +
            `Expected e.g. "8w", "2d".`
        );
      }
      newDue = addDays(today, days);
    }
    entry.due = newDue;
    entry.armed_at = today;
    state.last_updated = today;

    try {
      fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
    }

    return { removed: false, rearmed: true, newDue, entry };
  }

  // Remove the entry
  state.rechecks.splice(idx, 1);
  state.last_updated = today;

  try {
    fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
  }

  return { removed: true, rearmed: false, entry };
}

/**
 * Resolve the configured Claude Code permission mode for a project root.
 * Read-only — performs no writes.
 *
 * Resolution order mirrors Claude Code's own settings precedence:
 *   1. <root>/.claude/settings.local.json — permissions.defaultMode
 *   2. <root>/.claude/settings.json       — permissions.defaultMode
 *   3. "default" — when neither file exists, is malformed, or sets no mode
 *
 * @param {string} root - Absolute path to the project root.
 * @returns {string} The resolved permission mode (e.g. "acceptEdits", "plan", "default").
 */
function readPermissionMode(root) {
  const candidates = [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(content);
      const mode = parsed && parsed.permissions && parsed.permissions.defaultMode;
      if (typeof mode === 'string' && mode.length > 0) {
        return mode;
      }
    } catch (err) {
      // Missing file or malformed JSON — treat as absent, try next candidate.
    }
  }
  return 'default';
}

/**
 * Read the persisted runtime permission_mode written by the SessionStart hook
 * (see mavp-operator-agent.js — persistRuntimePermissionMode). Read-only —
 * performs no writes.
 *
 * Shape (T-663): the state file is session-scoped JSON
 * `{mode, session_id?, written_at}`, not a bare string. A legacy bare-string
 * file (written before T-663) is still accepted for one release's worth of
 * backward compatibility — it degrades to the trimmed raw text when JSON
 * parsing fails.
 *
 * @param {string} root - Absolute path to the project root.
 * @returns {string|null} The persisted mode, or null when the state file is
 *   absent, empty, unreadable, or has no usable `mode`.
 */
function readPersistedPermissionMode(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.mavp', 'permission-mode'), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      const mode = parsed && parsed.mode;
      return typeof mode === 'string' && mode.length > 0 ? mode : null;
    } catch {
      // Legacy bare-string format (pre T-663) — accept the trimmed text as-is.
      return trimmed;
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the effective permission mode using ONE shared fallback order,
 * used by both --agent and --close-session (T-663 closes the prior
 * asymmetry where --agent skipped the persisted file and --close-session
 * skipped the hook payload):
 *
 *   1. hookPayloadMode  — a permission_mode observed on THIS session's
 *      SessionStart hook stdin payload (only --agent can ever supply this;
 *      --close-session never reads stdin, so it always omits this option).
 *   2. persisted runtime — .mavp/permission-mode written by an earlier
 *      session's hook payload (readPersistedPermissionMode).
 *   3. settings file — readPermissionMode(root) (.claude/settings.local.json
 *      / .claude/settings.json precedence, defaulting to "default").
 *
 * Read-only — performs no writes.
 *
 * @param {string} root - Absolute path to the project root.
 * @param {{hookPayloadMode?: string|null}} [opts]
 * @returns {{mode: string, source: 'hook_payload'|'persisted_runtime'|'settings_file'}}
 */
function resolvePermissionMode(root, opts = {}) {
  const hookPayloadMode = opts && opts.hookPayloadMode;
  if (typeof hookPayloadMode === 'string' && hookPayloadMode.length > 0) {
    return { mode: hookPayloadMode, source: 'hook_payload' };
  }
  const persisted = readPersistedPermissionMode(root);
  if (persisted) {
    return { mode: persisted, source: 'persisted_runtime' };
  }
  return { mode: readPermissionMode(root), source: 'settings_file' };
}

/**
 * Read ONLY `permissions.defaultMode` from a user-global Claude Code settings
 * file. Read-only — performs no writes. Never echoes any other key from the
 * file (it holds approval history and is large) — degrades silently
 * (returns null) when the file is absent, unreadable, or malformed.
 *
 * @param {string} userGlobalPath - Absolute path to the user-global settings.json.
 * @returns {string|null} The declared defaultMode, or null when absent/unset/unreadable.
 */
function readUserGlobalPermissionMode(userGlobalPath) {
  try {
    const content = fs.readFileSync(userGlobalPath, 'utf8');
    const parsed = JSON.parse(content);
    const mode = parsed && parsed.permissions && parsed.permissions.defaultMode;
    return typeof mode === 'string' && mode.length > 0 ? mode : null;
  } catch {
    return null;
  }
}

/**
 * Detect (never resolve) a divergence between the project-file permission
 * mode resolution and a readable user-global ~/.claude/settings.json
 * defaultMode. This is a FACT REPORT only: it reports both values and never
 * claims a winner — precedence between the two is harness-owned and has
 * been observed to diverge from what this project's own docs assert, so a
 * winner computed here could itself be confidently wrong.
 *
 * Degrades silently (returns null) when the user-global file is unreadable,
 * malformed, or unset, or when its value matches the project resolution.
 *
 * The user-global path defaults to `~/.claude/settings.json` but is
 * injectable via the `userGlobalPath` argument (unit tests) or the
 * MAVERICKS_USER_GLOBAL_SETTINGS_PATH env var (integration tests that spawn
 * mavp-operator-agent.js as a subprocess) — neither test path needs a real
 * `~/.claude/settings.json` to exist.
 *
 * @param {string} root - Absolute path to the project root.
 * @param {string} [userGlobalPath] - Override path to the user-global settings file.
 * @returns {{project: string, user_global: string}|null}
 */
function detectPermissionModeConflict(root, userGlobalPath) {
  const resolvedUserGlobalPath = userGlobalPath
    || process.env.MAVERICKS_USER_GLOBAL_SETTINGS_PATH
    || path.join(os.homedir(), '.claude', 'settings.json');
  const userGlobalMode = readUserGlobalPermissionMode(resolvedUserGlobalPath);
  if (!userGlobalMode) return null;
  const projectMode = readPermissionMode(root);
  if (userGlobalMode === projectMode) return null;
  return { project: projectMode, user_global: userGlobalMode };
}

/**
 * T-694: the enumerated noun list an ACTION_TARGET_FOLLOWER match accepts
 * immediately after a version literal (see classifyNextAction() below).
 * Single source of truth — mavp-validator.js's next_action_volatile_facts
 * suggestedAction text derives its noun enumeration from this same array so
 * the printed remediation advice and the matcher it describes can never
 * drift apart again (the T-694 incident this closes: the message taught an
 * open rule while the matcher enforced a closed list one noun short of the
 * fact the live directive needed).
 */
const ACTION_TARGET_FOLLOWER_NOUNS = ['bump', 'release', 'section', 'version', 'promotion'];

/**
 * Classify a next_action string as a routing directive vs. freeform prose that
 * may have copied volatile facts (framework version, unpushed-commit counts) with
 * no invalidation trigger. This is a SHAPE check only — it does not fact-check
 * prose against any external source (git, mavp-version.js, etc).
 *
 * - directive: true when the (trimmed) string begins with a `T-\d+` routing
 *   directive, or when the value is empty/null. false otherwise (freeform prose).
 * - volatile_facts: substrings matched by conservative patterns only — semver
 *   (`v1.2.3`/`1.2.3`) and commit-count phrases (`14 commits`, `14 unpushed commits`,
 *   `ahead 14`). Deduplicated. Empty array when nothing matches.
 *
 * T-628 (RC-1, docs/rca/2026-08-operator-channel-state-artifacts.md): semver
 * matching is POSITION-sensitive, not a plain substring scan. A version literal
 * that names the ACTION-TARGET of a mutation directive ("bump to 0.43.0",
 * "amend the 0.42.1 section", "0.42.1 bump") is exactly the fact the next
 * developer/writer needs to complete the directive — it is not a stale claim
 * about current state, so it must NOT be flagged. A version literal that
 * ASSERTS current state ("the repo is at 0.42.1", "currently on v1.2.3") has no
 * invalidation trigger once written and must still be flagged. The boundary
 * inspects the immediate left/right context around each literal — it is not a
 * list of the specific historical strings that motivated it:
 *   - preceded by a state-assertion word (is/are/at/on/now/currently/already/
 *     still) -> state assertion, always flagged. Checked FIRST, so it wins
 *     over the action-target check below for any input that could match both.
 *   - otherwise preceded by "to" (the "<verb> to X" construction, e.g. "bump
 *     to X") or IMMEDIATELY followed (no gap tolerance) by one of the
 *     ACTION_TARGET_FOLLOWER_NOUNS (bump/release/section/version/promotion,
 *     e.g. "X bump"/"the X section") -> action-target position, not flagged.
 *   - otherwise (no cue on either side) -> flagged, preserving the prior
 *     conservative default for ambiguous/bare version literals.
 *
 * T-694 (measured divergence, 2026-08-22): `promotion` was added to
 * ACTION_TARGET_FOLLOWER_NOUNS after a live directive ("Run the 0.46.2
 * promotion on the mirror") was refused and its own message-prescribed
 * rewrite ("Promote the 0.46.2 release to stable on the mirror") was the
 * only rewrite that actually passed — the message taught an open rule
 * ("lead with the target noun") while the matcher enumerated a closed list
 * that didn't include the noun the directive needed. The follower-noun list
 * is now a single module-scope constant (ACTION_TARGET_FOLLOWER_NOUNS) and
 * `mavp-validator.js`'s suggestedAction text derives its noun enumeration
 * from this same constant, so the two can no longer drift apart. Three
 * refusal shapes remain DELIBERATE boundaries, not gaps to close:
 *   - `tag` is deliberately excluded from the noun list ("HEAD is at the
 *     0.46.2 tag" must keep flagging as a state assertion).
 *   - no gap tolerance: the noun must be the immediate next token, not
 *     merely present nearby ("the 0.46.2 stable promotion" still flags —
 *     adjacency is what separates a target-naming literal from one merely
 *     floating inside a state claim).
 *   - no verb-object grammar: "Promote 0.46.2 to stable" still flags,
 *     because the bare literal here has neither an ACTION_TARGET_PRECEDER
 *     ("to" immediately before it) nor an ACTION_TARGET_FOLLOWER_NOUNS match
 *     immediately after it — "to" appears later in the sentence governing
 *     "stable", not immediately preceding the literal itself.
 * Commit-count and ahead-N patterns are NOT position-sensitive — they are
 * always a claim about current repo state, never a directive's target, so
 * they are matched exactly as before this change.
 *
 * KNOWN BOUNDARY CASE, documented rather than "fixed" (widening the matcher
 * to cover it would trade a false positive for a false negative on the
 * state-assertion form, which this task's re-scope explicitly rejects):
 * "cut the release at 0.45.0" still FLAGS, because "at" is a
 * STATE_ASSERTION_PRECEDER and that check runs first, even though the
 * literal here is actually the directive's target. The state-assertion-wins
 * ordering is deliberate and correct for the genuine state-assertion case
 * ("confirm the repo is at 0.45.0") and is not narrowed further just to
 * admit this one phrasing. The COMPLIANT REWRITE is to lead with the target
 * noun instead of "at": "cut the 0.45.0 release" classifies clean, because
 * the ACTION_TARGET_FOLLOWER ("release") matches before any state-assertion
 * preceder is in play. The validator finding's suggestedAction names this
 * rewrite directly so a blocked operator has the fix in front of them.
 *
 * @param {string|null|undefined} str - The next_action value to classify.
 * @returns {{ directive: boolean, volatile_facts: string[] }}
 */
function classifyNextAction(str) {
  const trimmed = typeof str === 'string' ? str.trim() : '';
  if (trimmed.length === 0) {
    return { directive: true, volatile_facts: [] };
  }

  const directive = /^T-\d+/.test(trimmed);

  const seen = new Set();
  const volatile_facts = [];

  // Semver — position-sensitive (see the doc comment above for the boundary).
  const STATE_ASSERTION_PRECEDER = /\b(?:is|are|at|on|now|currently|already|still)\s*$/i;
  const ACTION_TARGET_PRECEDER = /\bto\s*$/i;
  const ACTION_TARGET_FOLLOWER = new RegExp(`^\\s*(?:${ACTION_TARGET_FOLLOWER_NOUNS.join('|')})\\b`, 'i');
  const versionPattern = /\bv?\d+\.\d+\.\d+\b/g;
  let m;
  while ((m = versionPattern.exec(trimmed)) !== null) {
    const before = trimmed.slice(0, m.index);
    const after = trimmed.slice(m.index + m[0].length);
    const isStateAssertion = STATE_ASSERTION_PRECEDER.test(before);
    const isActionTarget = !isStateAssertion &&
      (ACTION_TARGET_PRECEDER.test(before) || ACTION_TARGET_FOLLOWER.test(after));
    if (isActionTarget) continue;
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      volatile_facts.push(m[0]);
    }
  }

  // Commit-count / ahead-N — unchanged, not position-sensitive.
  const otherPatterns = [
    /\b\d+\s+(?:unpushed\s+)?commits?\b/gi,
    /\bahead\s+\d+\b/gi,
  ];
  for (const pattern of otherPatterns) {
    const matches = trimmed.match(pattern) || [];
    for (const match of matches) {
      if (!seen.has(match)) {
        seen.add(match);
        volatile_facts.push(match);
      }
    }
  }

  return { directive, volatile_facts };
}

/**
 * Resolve the path to docs/REPO_MAP.md for the current context.
 * Mirrors resolveModulesPath() in mavp-validator.js — respects
 * MAVERICKS_PROJECT_ROOT (via the ROOT constant above) when running against a
 * bootstrapped project, falling back to the mavericks repo root in self-mode.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string|null} Absolute path to docs/REPO_MAP.md, or null if absent.
 */
function resolveRepoMapPath(root) {
  const base = root || ROOT;
  const p = path.join(base, 'docs', 'REPO_MAP.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Shared meta-heading skip-sets for the `## <id>` registry docs (docs/MODULES.md,
 * docs/REPO_MAP.md). Each schema doc's own explanatory sections (What/Required/
 * Example/How[/Module]) render as `## <heading>` too, so every parser that walks
 * these files needs to skip them to avoid treating prose headings as real ids.
 *
 * Single source of truth (T-461) — consumed by both the full-registry parsers
 * below (parseModuleRegistry/parseRepoMap) and mavp-validator.js's ID-only
 * parsers (parseKnownModuleIds/parseKnownRepoIds), so there is exactly one
 * skip-set per registry instead of one copy per consumer.
 */
const MODULE_META_HEADINGS = new Set(['How', 'Module', 'What', 'Required', 'Example']);
const REPO_META_HEADINGS = new Set(['What', 'Required', 'Example', 'How']);

/**
 * Extract `## <id>` heading ids from markdown content, filtering out a given
 * meta-heading skip-set. Single shared extraction (T-461) for both the
 * ID-only registry readers (mavp-validator.js's parseKnownModuleIds/
 * parseKnownRepoIds) and as the id source for the full-registry parsers below.
 *
 * @param {string} content - Raw markdown file content.
 * @param {Set<string>} metaHeadings - Heading ids to exclude (schema prose sections).
 * @returns {Set<string>} Ids in first-seen order, meta headings removed.
 */
function extractHeadingIds(content, metaHeadings) {
  const ids = new Set();
  const matches = content.match(/^##\s+(\S+)/gm) || [];
  for (const match of matches) {
    const m = match.match(/^##\s+(\S+)/);
    if (m) ids.add(m[1].trim());
  }
  if (metaHeadings) {
    for (const meta of metaHeadings) ids.delete(meta);
  }
  return ids;
}

/**
 * Parse the repo-map registry from docs/REPO_MAP.md.
 * Same project-owns-instance pattern as parseModuleRegistry() (mavp-operator-agent.js)
 * for docs/MODULES.md — the framework only defines the schema (see docs/REPO_MAP.md);
 * each project maintains its own registry instance.
 *
 * Returns an empty object when the file is absent — never throws.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {Object<string, {label: string, path: string|null, domain: string|null,
 *   deploy_path: string|null, downstream: string[], docs: string[]}>}
 */
function parseRepoMap(root) {
  try {
    const repoMapPath = resolveRepoMapPath(root);
    if (!repoMapPath) return {};
    const content = fs.readFileSync(repoMapPath, 'utf8');
    const registry = {};
    // Split on ## <id> headings (skip meta headings used in the schema spec)
    const sections = content.split(/^(?=##\s+\S)/m).filter(Boolean);
    const META_HEADINGS = REPO_META_HEADINGS;
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(\S+)/);
      if (!headingMatch) continue;
      const id = headingMatch[1].trim();
      if (META_HEADINGS.has(id)) continue;

      const labelMatch = section.match(/^- \*\*label:\*\*\s+(.+)$/m);
      const pathMatch = section.match(/^- \*\*path:\*\*\s+(.+)$/m);
      const domainMatch = section.match(/^- \*\*domain:\*\*\s+(.+)$/m);
      const deployPathMatch = section.match(/^- \*\*deploy_path:\*\*\s+(.+)$/m);
      const downstreamMatch = section.match(/^- \*\*downstream:\*\*\s+(.+)$/m);
      const docsMatch = section.match(/^- \*\*docs:\*\*\s+(.+)$/m);

      const downstream = downstreamMatch
        ? downstreamMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const docs = docsMatch
        ? docsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      registry[id] = {
        label: labelMatch ? labelMatch[1].trim() : id,
        path: pathMatch ? pathMatch[1].trim() : null,
        domain: domainMatch ? domainMatch[1].trim() : null,
        deploy_path: deployPathMatch ? deployPathMatch[1].trim() : null,
        downstream,
        docs,
      };
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * True when a `Blocked by:` raw field value is the conventional "no blockers"
 * case: absent, blank, or the standard em-dash/hyphen placeholder (T-492).
 * This is the single source of truth for "no blockers" — both parseBlockedBy()
 * (parsing) and checkBlockedBy() in mavp-validator.js (validation) call this
 * instead of re-testing the placeholder strings themselves, so the two
 * functions cannot drift out of agreement on what counts as empty.
 *
 * @param {string|null} raw - Raw field value.
 * @returns {boolean}
 */
function isBlockedByEmpty(raw) {
  if (!raw) return true;
  const trimmed = raw.trim();
  return !trimmed || trimmed === '—' || trimmed === '-';
}

/**
 * Parse a `- **Blocked by:** <repo>/T-NNN[, <repo>/T-MMM ...]` field value into
 * structured {repo, taskId} pairs (T-393 — cross-repo Blocked by relation).
 *
 * Distinct from `Depends on:` parsing (same-repo `T-NNN` tokens, parsed inline
 * in `computeNextAction()` in mavp-operator-agent.js) — that behavior is a
 * separate field and is untouched by this function. `Blocked by:` always
 * requires a `<repo>/` prefix; a bare `T-NNN` token here is silently dropped,
 * matching the existing `Depends on:` precedent of dropping unparsable tokens.
 *
 * @param {string|null} raw - Raw field value, e.g. "repo-a/T-100, repo-b/T-200"
 * @returns {Array<{repo: string, taskId: string}>}
 */
function parseBlockedBy(raw) {
  if (isBlockedByEmpty(raw)) return [];
  const trimmed = raw.trim();
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const m = token.match(/^([^\/\s]+)\/(T-\d+)$/);
      return m ? { repo: m[1], taskId: m[2] } : null;
    })
    .filter(Boolean);
}

/**
 * True when a `Hold:` raw field value is the conventional "no hold" case:
 * absent, blank, or the standard em-dash/hyphen placeholder — the same
 * emptiness convention isBlockedByEmpty() applies to `Blocked by:` (T-492).
 * Single source of truth for "no hold": parseHold() (parsing) and the
 * validator's applyHoldDowngrade() (scoped downgrade gate, T-496) both call
 * this instead of re-testing the placeholder strings themselves.
 *
 * @param {string|null} raw - Raw field value.
 * @returns {boolean}
 */
function isHoldEmpty(raw) {
  if (!raw) return true;
  const trimmed = raw.trim();
  return !trimmed || trimmed === '—' || trimmed === '-';
}

/**
 * Parse a `- **Hold:** <what> — <why> (<since>)` field value (DR-005) into a
 * structured `{ what, why, since, raw }` shape, e.g.
 * `- **Hold:** prod — waiting on a coordinated deploy window (2026-07-24)`.
 *
 * Deliberately tolerant, not a validation gate: DR-005 makes `Hold:` optional
 * and forbids treating its absence as a finding; this parser extends the same
 * spirit to a malformed-but-present value. A value missing the ` — ` why
 * separator or the trailing `(since)` parenthetical still parses — `what`
 * falls back to the whole trimmed string, `why`/`since` are `null` — rather
 * than being rejected or surfaced as a finding. The field is meant to lower
 * ceremony for recording a deliberate wait, not add a new way to fail.
 *
 * @param {string|null} raw - Raw field value.
 * @returns {{what: string|null, why: string|null, since: string|null, raw: string}|null}
 *   `null` when the field is empty per isHoldEmpty().
 */
function parseHold(raw) {
  if (isHoldEmpty(raw)) return null;
  const trimmed = raw.trim();

  let rest = trimmed;
  let since = null;
  const withDate = trimmed.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (withDate) {
    rest = withDate[1].trim();
    since = withDate[2].trim();
  }

  const emDashSplit = rest.split(/\s+—\s+/);
  const what = (emDashSplit[0] || rest).trim() || null;
  const why = emDashSplit.length > 1 ? emDashSplit.slice(1).join(' — ').trim() : null;

  return { what, why, since, raw: trimmed };
}

/**
 * Parse every task's `- **Hold:** ...` field out of BACKLOG.md, regardless of
 * status or section (T-496). Used to enrich the `--snapshot` wave-tasks view
 * so a held task reads as deliberate rather than stalled, at any lifecycle
 * position (including a merged task deliberately held pending prod deploy).
 *
 * @param {string} backlogMarkdown - Raw content of BACKLOG.md
 * @returns {Map<string, {what:string|null, why:string|null, since:string|null, raw:string}>}
 */
function parseTaskHolds(backlogMarkdown) {
  const taskBlocks = (backlogMarkdown || '').split(/\n(?=###\s+T-\d+\s+)/);
  const holds = new Map();

  for (const block of taskBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    const holdMatch = block.match(/^- \*\*Hold:\*\*\s+(.+)$/m);
    if (!holdMatch) continue;

    const parsed = parseHold(holdMatch[1]);
    if (parsed) holds.set(taskId, parsed);
  }

  return holds;
}

/**
 * Resolve the path to docs/MODULES.md for the current context.
 * Mirrors resolveRepoMapPath() — used only by buildContextBundle() below.
 * The canonical module-registry resolution consumed by --agent output lives
 * in mavp-operator-agent.js / mavp-validator.js's resolveModulesPath(); this
 * is a root-parameterized sibling so the context-bundle builder (T-394) can
 * work against an arbitrary root (used by tests and cross-project runs).
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string|null} Absolute path to docs/MODULES.md, or null if absent.
 */
function resolveModuleRegistryPath(root) {
  const base = root || ROOT;
  const p = path.join(base, 'docs', 'MODULES.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse the optional `doc_limits` module field (T-791): a comma-separated list
 * of `<path> max_chars: <N> (<owner>)` entries, kept on its own field line so the
 * comma-split of `context_docs` is untouched. The owner is any single
 * whitespace-free token in the trailing parentheses (`T-NNN`, `DR-NNN`, or a
 * short handle such as `docs-owner`; T-805) and names who removes the
 * exception. Entries that do not match the grammar are skipped (never thrown on).
 *
 * @param {string} raw - The text after `- **doc_limits:**`.
 * @returns {Object<string, {max_chars:number, task:string, owner:string}>} `task`
 *   mirrors `owner` for backward compatibility.
 */
function parseDocLimits(raw) {
  const limits = {};
  for (const part of String(raw || '').split(',')) {
    const m = part.trim().match(/^`?([^\s`]+)`?\s+max_chars:\s*(\d+)\s*\(([^\s()]+)\)$/);
    // `owner` is the parenthesised token verbatim; `task` mirrors it so every
    // existing consumer (the validator's messages) keeps working unchanged.
    if (m) limits[m[1]] = { max_chars: Number(m[2]), task: m[3], owner: m[3] };
  }
  return limits;
}

/**
 * Parse module-registry markdown text (T-791). The text-level helper holding
 * the parsing body, so a caller that already holds the content (for example
 * the docs/MODULES.md text of an earlier revision) can parse it without a
 * filesystem root. Returns {} (never throws) on malformed input.
 *
 * @param {string} content - Raw docs/MODULES.md text.
 * @returns {Object<string, {label:string, repos:string[], context_docs:string[],
 *   default_owner:string, qa_checklist:string[],
 *   doc_limits:Object<string,{max_chars:number, task:string, owner:string}>}>}
 */
function parseModuleRegistryFromText(content) {
  try {
    const registry = {};
    const sections = String(content).split(/^(?=##\s+\S)/m).filter(Boolean);
    const META_HEADINGS = MODULE_META_HEADINGS;
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(\S+)/);
      if (!headingMatch) continue;
      const id = headingMatch[1].trim();
      if (META_HEADINGS.has(id)) continue;

      const labelMatch = section.match(/^- \*\*label:\*\*\s+(.+)$/m);
      const reposMatch = section.match(/^- \*\*repos:\*\*\s+(.+)$/m);
      const contextDocsMatch = section.match(/^- \*\*context_docs:\*\*\s+(.+)$/m);
      const ownerMatch = section.match(/^- \*\*default_owner:\*\*\s+(.+)$/m);
      const docLimitsMatch = section.match(/^- \*\*doc_limits:\*\*\s+(.+)$/m);

      const contextDocs = contextDocsMatch
        ? contextDocsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const repos = reposMatch
        ? reposMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const qaLines = [];
      let inQa = false;
      for (const line of section.split(/\r?\n/)) {
        if (/^- \*\*qa_checklist:\*\*/.test(line)) { inQa = true; continue; }
        if (inQa) {
          // T-805: the terminator runs BEFORE the item branch — a top-level
          // `- **<field>:**` line or a `##` heading ends the list, so a
          // following `- **doc_limits:** ...` is never swallowed as an item.
          // Items may be indented (the documented form) or unindented.
          if (/^##/.test(line) || /^- \*\*/.test(line)) {
            inQa = false;
          } else if (/^\s*-\s+/.test(line)) {
            qaLines.push(line.replace(/^\s*-\s+/, '').trim());
          }
        }
      }

      registry[id] = {
        label: labelMatch ? labelMatch[1].trim() : id,
        repos,
        context_docs: contextDocs,
        default_owner: ownerMatch ? ownerMatch[1].trim() : 'developer',
        qa_checklist: qaLines,
        doc_limits: docLimitsMatch ? parseDocLimits(docLimitsMatch[1]) : {},
      };
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * Parse the module registry from docs/MODULES.md, parameterized by root.
 * The single module-registry parser (T-791 removed the duplicate in
 * mavp-operator-agent.js): reads docs/MODULES.md and delegates to
 * parseModuleRegistryFromText(). Returns {} (never throws) when the file is
 * absent — module enrichment degrades gracefully.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {Object<string, {label:string, repos:string[], context_docs:string[],
 *   default_owner:string, qa_checklist:string[],
 *   doc_limits:Object<string,{max_chars:number, task:string, owner:string}>}>}
 */
function parseModuleRegistry(root) {
  try {
    const modulesPath = resolveModuleRegistryPath(root);
    if (!modulesPath) return {};
    return parseModuleRegistryFromText(fs.readFileSync(modulesPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Locate a single `### T-NNN — <title>` heading block anywhere in a markdown
 * document (T-606 — promoted from mavp-operator-rescope-task.js's local
 * `findTaskBlock`, renamed to avoid near-collision with findTaskBlockById).
 * This is the ONE canonical block-boundary definition for single-block
 * lookup/mutation: block boundaries run from the heading line up to (but not
 * including) the next `### T-...` or `## ...` heading, or end of file —
 * unlike parseAllTaskBlocks(), which only stops at the next `### T-NNN` and
 * so can run a block past an intervening `## ` section boundary (see that
 * function's own docblock). Do not build a new mutation path on
 * parseAllTaskBlocks() — use this instead.
 *
 * Returns { count, startIndex, endIndex, rawBlock } — count is the number of
 * heading matches found (0 = missing, 1 = found, >1 = duplicate; only when
 * count === 1 are startIndex/endIndex/rawBlock present).
 *
 * @param {string} markdown - Raw file content
 * @param {string} taskId - e.g. "T-394"
 * @returns {{count: number, startIndex: number=, endIndex: number=, rawBlock: string=}}
 */
function locateTaskBlock(markdown, taskId) {
  const escaped = taskId.replace('-', '\\-');
  const headingRe = new RegExp(`^###\\s+${escaped}\\s+—.*$`, 'gm');
  const matches = [...markdown.matchAll(headingRe)];

  if (matches.length !== 1) {
    return { count: matches.length };
  }

  const heading = matches[0];
  const startIndex = heading.index;
  const searchStart = startIndex + heading[0].length;
  const rest = markdown.slice(searchStart);
  const boundaryMatch = rest.match(/\n(?=###\s+T-\d+\s+—|##\s+[^#])/);
  const endIndex = boundaryMatch ? searchStart + boundaryMatch.index + 1 : markdown.length;

  return {
    count: 1,
    startIndex,
    endIndex,
    rawBlock: markdown.slice(startIndex, endIndex),
  };
}

/**
 * Locate the raw ### T-NNN task block for a given ID inside a BACKLOG.md or
 * TASK_STATUS.md markdown string. Returns null when not found OR when the
 * heading is duplicated (T-606 — thin wrapper over locateTaskBlock(), the
 * one canonical boundary; a duplicate heading is no longer silently resolved
 * to "whichever one matches first").
 *
 * @param {string} markdown - Raw file content (may be '')
 * @param {string} taskId - e.g. "T-394"
 * @returns {string|null}
 */
function findTaskBlockById(markdown, taskId) {
  const loc = locateTaskBlock(markdown || '', taskId);
  return loc.count === 1 ? loc.rawBlock : null;
}

/**
 * Read a single-line `- **Field:** value` bullet from a raw task block.
 * Returns null when the block is absent or the field is not present.
 * Placeholder values ("—" / "-") are also treated as absent.
 *
 * @param {string|null} block
 * @param {string} fieldName
 * @returns {string|null}
 */
function extractBlockField(block, fieldName) {
  if (!block) return null;
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'));
  if (!m) return null;
  const value = m[1].trim();
  if (!value || value === '—' || value === '-') return null;
  return value;
}

/**
 * Update (or insert) a `- **Field:** value` bullet within a task block
 * (T-606 — promoted from mavp-operator-rescope-task.js's local
 * `setBlockField`, the canonical insert-if-missing within-block write).
 * Inserts right after the heading line when the field does not yet exist.
 * Deliberately does NOT normalize placeholder values on write — a write over
 * `- **Evidence:** —` replaces the placeholder line, it does not skip it.
 *
 * @param {string} block - Raw task block starting with `### T-NNN`
 * @param {string} fieldName - e.g. "Status", "Owner role"
 * @param {string} value
 * @returns {string} The updated block
 */
function setBlockField(block, fieldName, value) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRe = new RegExp(`^(- \\*\\*${escaped}:\\*\\*)\\s*.*$`, 'm');
  if (fieldRe.test(block)) {
    return block.replace(fieldRe, `$1 ${value}`);
  }
  const lines = block.split('\n');
  lines.splice(1, 0, `- **${fieldName}:** ${value}`);
  return lines.join('\n');
}

/**
 * Detect a TOP-LEVEL (non-indented) `- **<fieldLabel> (...):**` bullet in a
 * raw task block — an ANNOTATED variant of the canonical `- **<fieldLabel>:**`
 * field key (T-745), e.g. `- **Evidence (2026-09-20, QA):** commit: abc1234`.
 *
 * extractBlockField()/setBlockField() above (and getFieldMultiline() in
 * mavp-validator.js) match the exact label `- **<fieldLabel>:**` only — an
 * annotated top-level key is invisible to every one of those exact-match
 * readers, and setBlockField() INSERTS a brand-new canonical field next to
 * it rather than recognizing the annotated one as "the field", silently
 * forking a second field on write.
 *
 * Distinct from the SANCTIONED way to carry a dated/annotated note: an
 * INDENTED sub-bullet under the canonical field (`- **Evidence:** ...`
 * followed by `  - **Evidence (2026-09-20, QA):** ...`). getFieldMultiline()
 * already reads that shape correctly (inline value plus every following
 * sub-bullet, at any indentation depth, until the next top-level bullet) —
 * this function only matches the TOP-LEVEL, non-indented form (anchored on
 * `^- ` with no leading whitespace), which acts as its own field boundary
 * and is therefore invisible to every reader above, not the sanctioned
 * sub-bullet form.
 *
 * @param {string|null} block - Raw task block text
 * @param {string} fieldLabel - e.g. "Evidence" or "Notes"
 * @returns {{key: string, canonicalExists: boolean}|null}
 *   `key` is the exact annotated label text as written, verbatim (e.g.
 *   "Evidence (2026-09-20, QA)") — quotable as-is in a diagnostic message.
 *   `canonicalExists` is true when a top-level `- **<fieldLabel>:**` bullet
 *   ALSO exists elsewhere in the same block. Returns null when no top-level
 *   annotated variant is found.
 */
function findAnnotatedFieldVariant(block, fieldLabel) {
  if (!block) return null;
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const annotatedRe = new RegExp(`^- \\*\\*(${escaped}\\s*\\([^)]*\\))\\s*:\\*\\*`, 'm');
  const m = block.match(annotatedRe);
  if (!m) return null;
  const canonicalRe = new RegExp(`^- \\*\\*${escaped}:\\*\\*`, 'm');
  return { key: m[1], canonicalExists: canonicalRe.test(block) };
}

/**
 * Read a single `- **Field:** value` bullet from within a specific task's
 * block in a BACKLOG.md/TASK_STATUS.md-shaped markdown document, bounded by
 * locateTaskBlock()'s boundary — so this can never read a value from a
 * later block when the target block itself lacks the field (T-606, the read
 * counterpart to updateTaskField()).
 *
 * @param {string} markdown
 * @param {string} taskId - e.g. "T-394"
 * @param {string} fieldName - e.g. "Status", "Owner role"
 * @returns {{ok: boolean, value: (string|null), reason: (string|null)}}
 *   reason is 'task_not_found' or 'duplicate_heading' when ok is false.
 */
function readTaskField(markdown, taskId, fieldName) {
  const loc = locateTaskBlock(markdown, taskId);
  if (loc.count === 0) return { ok: false, value: null, reason: 'task_not_found' };
  if (loc.count > 1) return { ok: false, value: null, reason: 'duplicate_heading' };
  return { ok: true, value: extractBlockField(loc.rawBlock, fieldName), reason: null };
}

/**
 * Update (insert-if-missing) a single `- **Field:** value` bullet within a
 * specific task's block in a BACKLOG.md/TASK_STATUS.md-shaped markdown
 * document (T-606 — the composer T-607/T-608/T-609's migrations consume).
 * Refuses to write — and returns the input markdown unchanged — when the
 * task is missing or its heading is duplicated, instead of silently writing
 * into whatever later block happens to carry the field (the defect this
 * task exists to close).
 *
 * @param {string} markdown
 * @param {string} taskId - e.g. "T-394"
 * @param {string} fieldName - e.g. "Status", "Owner role"
 * @param {string} value
 * @returns {{ok: boolean, updated: string, reason: (string|null)}}
 *   reason is 'task_not_found' or 'duplicate_heading' when ok is false; on
 *   failure `updated` echoes the input markdown unchanged.
 */
function updateTaskField(markdown, taskId, fieldName, value) {
  const loc = locateTaskBlock(markdown, taskId);
  if (loc.count === 0) return { ok: false, updated: markdown, reason: 'task_not_found' };
  if (loc.count > 1) return { ok: false, updated: markdown, reason: 'duplicate_heading' };
  const updatedBlock = setBlockField(loc.rawBlock, fieldName, value);
  const updated = markdown.slice(0, loc.startIndex) + updatedBlock + markdown.slice(loc.endIndex);
  return { ok: true, updated, reason: null };
}

/**
 * T-748: prune stale IDs out of PROCESS_STATE.json's `active_slices` against
 * BACKLOG.md's current task statuses, using the validator's OWN
 * ACTIVE_SLICES_STATUSES set (mavp-validator.js) as the single source of
 * truth for what counts as "still active". The stale set is deliberately the
 * COMPLEMENT of that set, derived at call time — never a second hand-written
 * list — so an id is kept only when its BACKLOG.md task block resolves to a
 * status inside ACTIVE_SLICES_STATUSES; every other case (qa_passed, merged,
 * deferred, deprecated, deployed_dev/deployed_prod, an unresolvable/missing
 * block, or a duplicate heading) is pruned. This is exactly the set
 * checkActiveSlices() itself would flag as `active_slices_mismatch`, so a
 * caller that runs this immediately before the validator sees no warning for
 * any id it just pruned.
 *
 * Reads/writes PROCESS_STATE.json directly at `processStateJsonPath` — this
 * is the canonical replacement for --close-session's former local
 * `filterStaleSlices`/`syncActiveSlicesPreValidator` pair (whose stale set
 * was hand-maintained as only {qa_passed, merged}) and for
 * --archive-merged's missing prune step. A no-op (no read, no write) when
 * the file is absent, unparsable, or `active_slices` is empty/not an array.
 *
 * The require() of mavp-validator.js is deliberately LAZY (inside the
 * function body, not at this module's top) — mavp-validator.js requires
 * THIS module at its own top-level, so a top-level require() here would
 * hand validator.js a partially-populated exports object mid-load the first
 * time either module is loaded first. By call time both modules are always
 * already fully loaded.
 *
 * @param {string} processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @param {string} backlogMdPath - Absolute path to BACKLOG.md
 * @returns {{activeSlices: Array, changed: boolean}} The resulting
 *   (already-written-if-changed) active_slices array and whether it differs
 *   from what was read.
 */
function pruneStaleActiveSlices(processStateJsonPath, backlogMdPath) {
  let current;
  try {
    if (!fs.existsSync(processStateJsonPath)) return { activeSlices: [], changed: false };
    current = JSON.parse(readUtf8(processStateJsonPath));
  } catch {
    return { activeSlices: [], changed: false };
  }

  const activeSlices = Array.isArray(current.active_slices) ? current.active_slices : [];
  if (activeSlices.length === 0) return { activeSlices, changed: false };

  const backlogMarkdown = fs.existsSync(backlogMdPath) ? readUtf8(backlogMdPath) : '';
  // eslint-disable-next-line global-require
  const { ACTIVE_SLICES_STATUSES } = require('./mavp-validator.js');

  const filtered = activeSlices.filter((entry) => {
    const id = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.id : null);
    if (!id) return false;
    const block = findTaskBlockById(backlogMarkdown, id);
    const status = extractBlockField(block, 'Status');
    return ACTIVE_SLICES_STATUSES.has(status);
  });

  const changed = filtered.length !== activeSlices.length;
  if (changed) {
    current.active_slices = filtered;
    fs.writeFileSync(processStateJsonPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  }
  return { activeSlices: filtered, changed };
}

/**
 * Resolve the path to a task's context prefetch bundle (.mavp/context/T-NNN.md).
 * The bundle itself is gitignored — regenerated at registration/update time.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string} Absolute path (the file may not exist yet).
 */
function resolveContextBundlePath(taskId, root) {
  const base = root || ROOT;
  return path.join(base, '.mavp', 'context', `${taskId}.md`);
}

/**
 * Truncate a raw ### T-NNN task block at the first level-2 (`## `) heading.
 *
 * parseAllTaskBlocks() / findTaskBlockById() only split on `### T-NNN`
 * boundaries, so a task block that happens to be the last one under a
 * `## Wave NN` section runs straight through into the NEXT level-2 heading
 * (e.g. `## Wave NN — Archived`) before hitting another `###` block. Level-2
 * headings never legitimately occur inside a task block's own content, so
 * cutting there is always safe. This is applied only to the copy embedded in
 * the context bundle (T-402) — it does not alter parseAllTaskBlocks() or
 * findTaskBlockById() themselves, which have other consumers.
 *
 * @param {string|null} block - Raw task block starting with `### T-NNN`
 * @returns {string|null}
 */
function truncateTaskBlockAtLevel2Heading(block) {
  if (!block) return block;
  const lines = block.split('\n');
  // Start at 1 -- line 0 is the block's own `### T-NNN` heading line.
  for (let i = 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  return block;
}

/**
 * Build the markdown content of a task's context prefetch bundle: the raw
 * task block, its module's context_docs (from docs/MODULES.md), its Touches
 * list, the repo-map entry (or entries) for its Repo/Repos field, and its
 * Depends on / Blocked by references. Written to .mavp/context/T-NNN.md at
 * task registration/update time (T-394) so agent spawns don't have to
 * reconstruct this context by hand.
 *
 * Degrades gracefully: an absent repo map, absent module registry, or an
 * unknown module/repo id simply omits the corresponding section — this
 * function never throws.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {object} [options]
 * @param {string} [options.root] - Root override (defaults to ROOT)
 * @param {string} [options.backlogPath] - Override path to BACKLOG.md
 * @param {string} [options.taskStatusPath] - Override path to TASK_STATUS.md
 * @returns {string|null} The bundle markdown, or null when the task ID is not
 *   found in either BACKLOG.md or TASK_STATUS.md.
 */
function buildContextBundle(taskId, options = {}) {
  const root = options.root || ROOT;
  const backlogPath = options.backlogPath || path.join(root, 'BACKLOG.md');
  const taskStatusPath = options.taskStatusPath || path.join(root, 'TASK_STATUS.md');

  const backlogContent = fs.existsSync(backlogPath) ? readUtf8(backlogPath) : '';
  const taskStatusContent = fs.existsSync(taskStatusPath) ? readUtf8(taskStatusPath) : '';

  const backlogBlock = findTaskBlockById(backlogContent, taskId);
  const statusBlock = findTaskBlockById(taskStatusContent, taskId);
  const taskBlock = backlogBlock || statusBlock;
  if (!taskBlock) return null;

  const moduleId = extractBlockField(backlogBlock, 'Module') || extractBlockField(statusBlock, 'Module');
  const repoField = extractBlockField(backlogBlock, 'Repo')
    || extractBlockField(backlogBlock, 'Repos')
    || extractBlockField(statusBlock, 'Repo')
    || extractBlockField(statusBlock, 'Repos');
  const touchesField = extractBlockField(backlogBlock, 'Touches');
  const dependsOn = extractBlockField(backlogBlock, 'Depends on');
  const blockedBy = extractBlockField(backlogBlock, 'Blocked by');

  const sections = [];
  sections.push(`# Context Bundle — ${taskId}`);
  sections.push('');
  sections.push(
    'Auto-generated by mavp-operator at task registration/update (T-394). ' +
    'Regenerate via `--update-task` / `--rescope-task`, or by re-running registration. ' +
    'Do not hand-edit — it will be overwritten.'
  );
  sections.push('');
  sections.push('## Task block');
  sections.push('');
  sections.push(truncateTaskBlockAtLevel2Heading(taskBlock.trim()));
  sections.push('');

  if (moduleId) {
    const registry = parseModuleRegistry(root);
    const entry = registry[moduleId];
    if (entry && entry.context_docs.length > 0) {
      sections.push('## Module context docs');
      sections.push('');
      sections.push(`Module: ${moduleId}`);
      sections.push('');
      for (const doc of entry.context_docs) sections.push(`- ${doc}`);
      sections.push('');
    }
  }

  if (touchesField) {
    const files = touchesField.split(',').map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) {
      sections.push('## Touches');
      sections.push('');
      for (const f of files) sections.push(`- ${f}`);
      sections.push('');
    }
  }

  if (repoField) {
    const repoIds = repoField.split(',').map((s) => s.trim()).filter(Boolean);
    const repoMap = parseRepoMap(root);
    const matched = repoIds.filter((id) => repoMap[id]);
    if (matched.length > 0) {
      sections.push('## Repo map entry');
      sections.push('');
      for (const id of matched) {
        const entry = repoMap[id];
        sections.push(`### ${id}`);
        sections.push('');
        sections.push(`- **label:** ${entry.label}`);
        if (entry.path) sections.push(`- **path:** ${entry.path}`);
        if (entry.domain) sections.push(`- **domain:** ${entry.domain}`);
        if (entry.deploy_path) sections.push(`- **deploy_path:** ${entry.deploy_path}`);
        if (entry.downstream.length > 0) sections.push(`- **downstream:** ${entry.downstream.join(', ')}`);
        if (entry.docs.length > 0) sections.push(`- **docs:** ${entry.docs.join(', ')}`);
        sections.push('');
      }
    }
  }

  if (dependsOn || blockedBy) {
    sections.push('## Dependencies');
    sections.push('');
    if (dependsOn) sections.push(`- **Depends on:** ${dependsOn}`);
    if (blockedBy) sections.push(`- **Blocked by:** ${blockedBy}`);
    sections.push('');
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Write a task's context prefetch bundle to .mavp/context/T-NNN.md.
 * Best-effort: catches and reports failures instead of throwing, so
 * registration/update flows never break because of a bundle-write problem.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {object} [options] - Same options as buildContextBundle().
 * @returns {{ok: boolean, path: (string|null), reason: (string|null)}}
 */
function writeContextBundle(taskId, options = {}) {
  try {
    const root = options.root || ROOT;
    const bundle = buildContextBundle(taskId, options);
    if (bundle == null) {
      return { ok: false, path: null, reason: 'task_not_found' };
    }
    const bundlePath = resolveContextBundlePath(taskId, root);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, bundle, 'utf8');
    return { ok: true, path: bundlePath, reason: null };
  } catch (err) {
    return { ok: false, path: null, reason: err.message };
  }
}

/**
 * Find the most recent commit (walking back from HEAD, inclusive) whose
 * subject line matches the `--close-session` commit marker
 * (`chore: close session YYYY-MM-DD`, written by
 * mavp-operator-close-session.js). Used as the reference point for "what
 * changed this session" (T-391 must-read set).
 *
 * Degrades silently (returns null, never throws) when: `root` is not a git
 * repository, git is not installed, or no commit in history matches the
 * marker pattern (e.g. a brand-new project that has never closed a session).
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string|null} The commit hash, or null.
 */
function findPreviousCloseSessionCommit(root) {
  try {
    const output = cp.execSync('git log --format=%H%x1f%s -n 500', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      const sepIdx = line.indexOf('\x1f');
      if (sepIdx === -1) continue;
      const hash = line.slice(0, sepIdx);
      const subject = line.slice(sepIdx + 1);
      if (/^chore: close session /.test(subject)) return hash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List files changed since the previous `--close-session` commit (see
 * findPreviousCloseSessionCommit()), relative to `root`. Part of the T-391
 * must-read set, extended by T-644 to also cover the current working tree —
 * not just committed history — so an abruptly-dead session's uncommitted
 * tracked edits and untracked files still surface next session:
 *   1. committed changes: `git diff --name-only <commit> HEAD`
 *   2. uncommitted tracked edits (staged + unstaged): `git diff --name-only HEAD`
 *   3. untracked files, respecting .gitignore: `git ls-files --others --exclude-standard`
 * Results are deduplicated. Order is not guaranteed to be stable across the
 * three sources beyond first-seen-wins de-duplication.
 *
 * T-644 fix round 1: each of the three calls is guarded independently so a
 * throw in one (e.g. call 3 exceeding `maxBuffer` on a very large untracked
 * file list) never discards another call's already-successful result — a
 * shared try/catch around all three previously zeroed the whole set on any
 * single failure. An explicit, generous `maxBuffer` is also set on all three
 * calls to push that failure mode further out (default Node maxBuffer is
 * 1 MiB; the git commands here can legitimately exceed it on a large repo
 * or a large untracked-file list, which is exactly the abruptly-dead-session
 * scenario this function exists to cover).
 *
 * Degrades silently (returns [], never throws) when git is unavailable, the
 * marker commit can't be found, or any of the three git calls fails for any
 * reason — a failing call now simply contributes nothing, rather than
 * discarding the other calls' results.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string[]} Relative file paths, possibly empty.
 */
function getFilesChangedSincePreviousCloseSession(root) {
  const commit = findPreviousCloseSessionCommit(root);
  if (!commit) return [];

  const execOpts = {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024, // 32 MiB — generous headroom over Node's 1 MiB default
  };

  const all = [];

  try {
    const committedOutput = cp.execSync(`git diff --name-only ${commit} HEAD`, execOpts);
    all.push(...committedOutput.split('\n'));
  } catch {
    // Degrade silently — this source contributes nothing, others are unaffected.
  }

  try {
    const workingTreeOutput = cp.execSync('git diff --name-only HEAD', execOpts);
    all.push(...workingTreeOutput.split('\n'));
  } catch {
    // Degrade silently — this source contributes nothing, others are unaffected.
  }

  try {
    const untrackedOutput = cp.execSync('git ls-files --others --exclude-standard', execOpts);
    all.push(...untrackedOutput.split('\n'));
  } catch {
    // Degrade silently — this source contributes nothing, others are unaffected.
  }

  const cleaned = all.map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(cleaned));
}

/**
 * Compute the T-391 must-read set: files changed since the previous
 * close-session commit (via git), unioned with the context_docs already
 * resolved onto each in-flight active slice (see mavp-operator-agent.js,
 * which attaches `context_docs` per module registry lookup before calling
 * this). Deduplicated; order is changed-files first, then context_docs, each
 * in first-seen order.
 *
 * Never throws. Returns [] when both sources are empty (caller omits the
 * `must_read` field entirely in that case — additive-only, see CLAUDE.md).
 *
 * @param {string} root - Absolute path to the git working tree.
 * @param {Array<{context_docs?: string[]}>} activeSlices - Active slices,
 *   already enriched with `context_docs` where applicable.
 * @returns {string[]}
 */
function computeMustRead(root, activeSlices) {
  const changedFiles = getFilesChangedSincePreviousCloseSession(root);
  const contextDocs = [];
  for (const slice of activeSlices || []) {
    if (Array.isArray(slice.context_docs)) contextDocs.push(...slice.context_docs);
  }
  return Array.from(new Set([...changedFiles, ...contextDocs]))
    .filter((p) => !MUST_READ_EXCLUDED_PATHS.includes(p))
    .filter((p) => !MUST_READ_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

/**
 * T-781 — repo-root-relative paths that never appear in `must_read`, by
 * construction. These are the append-only ledgers and live-state files: they
 * are far too large to read whole and are looked up by task id instead.
 * Matched as exact root-relative paths (not basenames), so a nested file that
 * merely shares a name is unaffected.
 */
const MUST_READ_EXCLUDED_PATHS = Object.freeze([
  'BACKLOG.md',
  'TASK_STATUS.md',
  'PROCESS_STATE.json',
  'PROCESS_STATE.md',
  'EXECUTION_LOG.md',
]);

/**
 * T-805 — repo-root-relative path PREFIXES that never appear in `must_read`
 * (nor in `must_read_oversized` / `must_read_framework`, which are derived from
 * computeMustRead's output). Archived documents are history, not reading. A
 * plain `startsWith` on the root-relative path, so `docs/archived-notes.md` and
 * a nested `sub/docs/archive/y.md` are unaffected.
 */
const MUST_READ_EXCLUDED_PREFIXES = Object.freeze([
  'docs/archive/',
]);

/**
 * T-799 — the installer's write set, defined ONCE here and required by
 * scripts/mavp-install.js (which previously kept local copies). These are the
 * files `mavp-install.js --update` rewrites from the framework source, so an
 * adopter's copy of them is framework text, not adopter-owned text.
 */
const HOOK_NAMES = Object.freeze(['pre-commit', 'pre-push']);
const CLAUDE_DIRS = Object.freeze(['agents', 'skills', 'rules']);
const SYNC_SCRIPTS = Object.freeze([
  'mavp-operator-agent.js',
  'mavp-operator-close-session.js',
]);
const PROJECT_FILES = SYNC_SCRIPTS;
const BASH_FILE = 'mavp-operator';
/** Marker file: present in a framework source tree, never copied to an adopter. */
const FRAMEWORK_MARKER_PATH = 'scripts/mavp-operator-lib.js';

function normalizeInstallerRel(rel) {
  return String(rel == null ? '' : rel).trim().split('\\').join('/').replace(/^(\.\/)+/, '');
}

/**
 * T-799 — true iff the root's own tree contains scripts/mavp-operator-lib.js,
 * which adopters never receive (they resolve the lib from the framework
 * install at runtime). `opts.exists(rel)` lets a caller judge a git revision's
 * path set instead of the working directory. Never throws.
 *
 * @param {string} root
 * @param {{exists?: function(string): boolean}} [opts]
 * @returns {boolean}
 */
function isFrameworkSourceTree(root, opts) {
  try {
    if (opts && typeof opts.exists === 'function') return Boolean(opts.exists(FRAMEWORK_MARKER_PATH));
    return fs.statSync(path.join(root, ...FRAMEWORK_MARKER_PATH.split('/'))).isFile();
  } catch (_err) {
    return false;
  }
}

/**
 * T-799 — true when `rel` (root-relative, posix) is a file `mavp-install.js
 * --update` rewrites. `.claude/{agents,skills,rules}/**` count only when a
 * same-relative-path FILE exists in the framework source tree
 * (`opts.frameworkRoot`, default: the checkout this lib lives in), so an
 * adopter-created file with no framework counterpart is never managed; a
 * `project-*` rule is the adopter's own rule home (T-788) and is never
 * managed. Also true for the two git hooks and the wrapper plus the two
 * synced scripts. False for everything else (.claude/settings.json,
 * .claude/hooks/pre-commit.local, template-seeded docs, ...). Never throws.
 *
 * @param {string} rel
 * @param {{frameworkRoot?: string}} [opts]
 * @returns {boolean}
 */
function isInstallerManagedPath(rel, opts) {
  const p = normalizeInstallerRel(rel);
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return false;
  const parts = p.split('/');
  if (parts[0] === '.claude' && parts.length >= 3 && CLAUDE_DIRS.includes(parts[1])) {
    if (parts[1] === 'rules' && parts[2].startsWith('project-')) return false;
    const frameworkRoot = (opts && opts.frameworkRoot) || path.resolve(__dirname, '..');
    try {
      return fs.statSync(path.join(frameworkRoot, ...parts)).isFile();
    } catch (_err) {
      return false;
    }
  }
  if (parts[0] === '.claude' && parts.length === 3 && parts[1] === 'hooks') return HOOK_NAMES.includes(parts[2]);
  if (parts[0] === 'scripts' && parts.length === 2) return parts[1] === BASH_FILE || SYNC_SCRIPTS.includes(parts[1]);
  return false;
}

/**
 * T-799 — split a must-read path list into adopter-owned `kept` and
 * installer-managed `framework` paths. A framework source tree (the canon)
 * is returned unchanged: everything is `kept`. Paths named in `opts.protect`
 * (e.g. an in-flight task's context_docs) always stay `kept`. Never throws.
 *
 * @param {string} root
 * @param {string[]} paths
 * @param {{frameworkRoot?: string, protect?: string[]}} [opts]
 * @returns {{kept: string[], framework: string[]}}
 */
function partitionInstallerManaged(root, paths, opts) {
  const list = Array.isArray(paths) ? paths : [];
  if (isFrameworkSourceTree(root)) return { kept: list.slice(), framework: [] };
  const protect = new Set((opts && opts.protect) || []);
  const kept = [];
  const framework = [];
  for (const p of list) {
    if (!protect.has(p) && isInstallerManagedPath(p, opts)) framework.push(p);
    else kept.push(p);
  }
  return { kept, framework };
}

/** T-781 — default `artifact_budgets.must_read_max_chars`. */
const MUST_READ_DEFAULT_MAX_CHARS = 40000;

/**
 * T-781 — split a must-read path list into files to read whole and oversized
 * files whose UTF-8-decoded string length exceeds `maxChars`. Paths that
 * cannot be read (absent on disk, directories, errors) pass through to
 * `mustRead` unchanged; relative order of `mustRead` is preserved. Never throws.
 *
 * @param {string} root - Absolute path to the project root.
 * @param {string[]} paths - Root-relative paths (output of computeMustRead).
 * @param {number} [maxChars] - Budget; non-positive/non-finite falls back to the default.
 * @returns {{mustRead: string[], oversized: Array<{path: string, chars: number}>}}
 */
function splitMustReadOversized(root, paths, maxChars) {
  const budget = (typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0)
    ? maxChars
    : MUST_READ_DEFAULT_MAX_CHARS;
  const mustRead = [];
  const oversized = [];
  for (const p of paths || []) {
    let chars = null;
    try {
      chars = fs.readFileSync(path.join(root, p), 'utf8').length;
    } catch (_err) {
      chars = null; // absent/unreadable — pass through unchanged
    }
    if (chars !== null && chars > budget) oversized.push({ path: p, chars });
    else mustRead.push(p);
  }
  return { mustRead, oversized };
}

/**
 * T-446 — shared commit-hash validation/resolution for evidence-writing
 * commands (--set-status --commit, --merge-task).
 *
 * Accepts either the literal string "HEAD" (resolved to the current repo's
 * short hash via `git rev-parse --short HEAD`) or a hex string matching
 * /^[0-9a-f]{7,40}$/. Any other input is rejected WITHOUT invoking git.
 *
 * For a format-valid, non-HEAD hash, best-effort checks reachability from
 * the given branch via `git merge-base --is-ancestor <hash> <branch>`. This
 * check never blocks the write — an unreachable/unknown hash surfaces only
 * as a non-fatal `warning` string naming both the hash and the branch. When
 * git itself is unavailable (ENOENT) or the root is not inside a git work
 * tree, the function degrades silently: no warning, no throw.
 *
 * @param {string} root - Absolute path used as the git command's cwd.
 * @param {string} rawHash - Raw --commit value ("HEAD", a hex hash, or garbage).
 * @param {string} branchName - Branch name to check reachability against.
 * @returns {{ok: boolean, hash: string|null, warning: string|null, error: string|null}}
 */
function isValidHashFormat(hash) {
  return /^[0-9a-f]{7,40}$/.test(String(hash || ''));
}

function isInsideGitRepo(root) {
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    return false;
  }
}

function resolveCommitHash(root, rawHash, branchName) {
  if (!rawHash) {
    return { ok: true, hash: null, warning: null, error: null };
  }

  if (rawHash === 'HEAD') {
    try {
      const out = cp
        .execSync('git rev-parse --short HEAD', {
          cwd: root,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        .trim();
      if (!out) throw new Error('empty HEAD resolution');
      return { ok: true, hash: out, warning: null, error: null };
    } catch (err) {
      return {
        ok: false,
        hash: null,
        warning: null,
        error: 'Could not resolve --commit HEAD (git unavailable or not inside a repository).',
      };
    }
  }

  if (!isValidHashFormat(rawHash)) {
    return {
      ok: false,
      hash: null,
      warning: null,
      error: `Invalid commit hash "${rawHash}" — expected "HEAD" or 7-40 lowercase hex characters (e.g. abc1234).`,
    };
  }

  // Format is valid. Best-effort reachability check — never blocks the write.
  let warning = null;
  const branch = branchName || 'main';
  try {
    cp.execSync(`git merge-base --is-ancestor ${rawHash} ${branch}`, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // git binary not found at all — degrade silently.
    } else if (isInsideGitRepo(root)) {
      warning = `commit ${rawHash} does not appear reachable from branch "${branch}"`;
    }
    // else: not inside a git work tree — degrade silently.
  }

  return { ok: true, hash: rawHash, warning, error: null };
}

/**
 * T-446 — merge a resolved "commit: <hash> branch: <branch>" pair into an
 * existing Evidence field string without deleting prior text (e.g. QA notes).
 * If the evidence already contains a `commit: ... [branch: ...]` token, that
 * token is replaced in place (no duplication). Otherwise the new pair is
 * appended to the end of the existing text, verbatim-preserving it.
 *
 * @param {string} existingEvidence - Current Evidence field text (may be empty or "—").
 * @param {string} hash - Resolved commit hash to write.
 * @param {string} branch - Branch name to write.
 * @returns {string}
 */
function mergeCommitEvidence(existingEvidence, hash, branch) {
  const replacement = `commit: ${hash} branch: ${branch}`;
  const trimmed = (existingEvidence || '').trim();
  const placeholder = trimmed === '—' || trimmed === '-' ? '' : trimmed;
  const commitBranchRe = /commit:\s*\S+(?:\s+branch:\s*\S+)?/;
  if (commitBranchRe.test(placeholder)) {
    return placeholder.replace(commitBranchRe, replacement);
  }
  if (!placeholder) return replacement;
  return `${placeholder} ${replacement}`;
}

/**
 * Detect whether `root` is a shallow git clone (e.g. actions/checkout@v7's
 * default fetch-depth: 1) via `git rev-parse --is-shallow-repository` (git >=
 * 2.15, 2017). Used by the validator's commit_unreachable check (T-565): in a
 * shallow clone, `git rev-list` only enumerates the fetched window, so a hash
 * NOT found there is indistinguishable from "reachable, but its history was
 * deliberately never fetched" — a NEGATIVE reachability result is unsound
 * there, not merely noisy. A POSITIVE result (hash found within the fetched
 * window) stays sound regardless of shallowness and is untouched by this
 * helper — only negative results need the caller to special-case shallowness.
 *
 * Classifies as shallow ONLY when the command's trimmed stdout is exactly
 * `"true"` — any other output (e.g. "false", empty, garbage), a non-zero
 * exit (git unavailable, not a git repo, git predating 2.15), or a thrown
 * error all fall through to `false` (non-shallow / existing behavior). This
 * exact-match containment is deliberate: failing closed to "false" means an
 * unrecognized/older git never gets misread as shallow, which would silently
 * suppress a genuine commit_unreachable finding.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {boolean} true only on an exact "true" match; false otherwise.
 */
function isShallowRepository(root) {
  try {
    const output = cp.execSync('git rev-parse --is-shallow-repository', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Return the full list of commit hashes reachable from an arbitrary `revspec`
 * (e.g. `HEAD`, `origin/main`, `@{upstream}`) in `root`, via a single batched
 * `git rev-list <revspec>` call. Generalized from the HEAD-only helper below
 * (T-448) so T-454/T-455 can reuse the same batched-call pattern to test
 * reachability from a remote-tracking ref or a local branch, not just HEAD.
 *
 * Degrades silently (returns null, never throws) when `root` is not a git
 * repository, git is not installed, `revspec` does not resolve (e.g. no
 * upstream configured), or the repo has no commits yet — mirrors the pattern
 * used by findPreviousCloseSessionCommit() above.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @param {string} revspec - A git revspec (e.g. 'HEAD', 'origin/main', '@{upstream}').
 * @returns {string[]|null} Full hashes reachable from revspec, or null when git/revspec is unavailable.
 */
function getCommitHashesReachable(root, revspec) {
  try {
    const output = cp.execSync(`git rev-list ${revspec}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Return the full list of commit hashes reachable from HEAD in `root`, via a
 * single batched `git rev-list HEAD` call (T-448). Used by the validator's
 * commit_unreachable check to detect merged-task evidence commit: hashes that
 * were never actually integrated onto HEAD — e.g. a worktree-local hash pasted
 * into evidence before the cherry-pick landed. A mere existence check (like
 * `git cat-file -e <hash>`) is insufficient here: worktrees share the object
 * database, so it would pass even for a hash that never reached HEAD.
 * This is the HEAD tier of the validator's two-tier reachability model
 * (T-455): a hash unreachable from HEAD but reachable from some local branch
 * (via getCommitHashesReachable(root, '--branches')) is treated as a lesser,
 * info-severity condition rather than the full footgun — only a hash
 * reachable from no local ref at all is the real defect this pairing catches.
 *
 * Thin wrapper over getCommitHashesReachable(root, 'HEAD') — kept as its own
 * named export so existing callers (validator, tests) are unaffected.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string[]|null} Full hashes reachable from HEAD, or null when git/HEAD is unavailable.
 */
function getCommitHashesReachableFromHead(root) {
  return getCommitHashesReachable(root, 'HEAD');
}

/**
 * Read a repo-relative file as recorded at a git revision (T-791), for
 * example docs/MODULES.md at HEAD. Uses an argument-array call (no shell), and
 * degrades silently: returns null, never throws, when `root` is not a git
 * repository, git is unavailable, the revision does not resolve, or the file
 * does not exist at that revision.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @param {string} rev - A git revision (e.g. 'HEAD').
 * @param {string} relPath - Repo-relative, forward-slash path.
 * @returns {string|null} File text at that revision, or null when unavailable.
 */
function readFileAtRevision(root, rev, relPath) {
  try {
    return cp.execFileSync('git', ['show', `${rev}:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Extract candidate `commit:` hashes from an evidence block (T-448). Cross-repo
 * evidence may carry multiple `commit:` lines (one per repo), so this returns
 * an array. Each match is re-validated against the anchored hex pattern before
 * being returned — defensive, since the extraction regex already constrains
 * the character class but a literal validation step is required per T-448's
 * acceptance criteria ("hashes are validated against /^[0-9a-f]{7,40}$/ before
 * any git invocation").
 *
 * T-637: promoted here from mavp-validator.js (where it lived since T-448) so
 * the validator's commit_unreachable check and --close-session's
 * shipped-but-unbooked advisory share ONE implementation of the
 * extract-then-batch-reachability pattern instead of two copies that can
 * drift. The validator imports it from this lib and re-exports it unchanged,
 * so every existing caller (including scripts/test-commit-reachable.js) is
 * unaffected.
 *
 * @param {string|null} evidence - Raw evidence text (may be null/empty).
 * @returns {string[]} Zero or more validated hex hashes.
 */
function extractCommitHashesFromEvidence(evidence) {
  if (!evidence) return [];
  const HASH_PATTERN = /^[0-9a-f]{7,40}$/;
  const matches = evidence.match(/commit:\s*[0-9a-f]{7,40}\b/gi) || [];
  return matches
    .map((m) => m.replace(/^commit:\s*/i, '').trim())
    .filter((hash) => HASH_PATTERN.test(hash));
}

/**
 * Build a lookup index from a flat list of full commit hashes, bucketed by
 * their first 7 characters (git's default short-hash length). Lets
 * isHashReachable() prefix-match a short evidence hash against only the
 * handful of candidates sharing its prefix, instead of scanning every
 * reachable hash for every evidence hash. Pairs with a SINGLE batched
 * getCommitHashesReachable() call — never a subprocess per hash.
 *
 * T-637: promoted here from mavp-validator.js alongside
 * extractCommitHashesFromEvidence() above (see its note).
 *
 * @param {string[]} hashes - Full hashes (e.g. from getCommitHashesReachable).
 * @returns {Map<string, string[]>} prefix bucket -> full hashes
 */
function buildReachableHashIndex(hashes) {
  const index = new Map();
  for (const hash of hashes) {
    const key = hash.slice(0, 7);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(hash);
  }
  return index;
}

/**
 * True when `hash` (7-40 hex chars) is a prefix of some hash in the index
 * built by buildReachableHashIndex() — i.e. reachable from whatever revspec
 * that index was built from.
 *
 * @param {string} hash
 * @param {Map<string, string[]>} reachableIndex
 * @returns {boolean}
 */
function isHashReachable(hash, reachableIndex) {
  const candidates = reachableIndex.get(hash.slice(0, 7));
  if (!candidates) return false;
  return candidates.some((full) => full.startsWith(hash));
}

/**
 * Default mtime safety threshold (ms) for worktree prune eligibility (T-559).
 * A worktree whose directory was touched more recently than this is never
 * prunable, regardless of classification — this exists specifically to
 * protect a just-spawned, still-clean agent worktree: `git worktree add`
 * checks out files at creation time, so a brand-new worktree that hasn't
 * been edited yet is trivially "clean-and-integrated" (no dirty changes, no
 * commits ahead of main yet) even though a live agent is about to start
 * working in it. One hour is chosen because it comfortably outlasts the
 * setup window between worktree creation and a sub-agent's first commit
 * (typically seconds to minutes) while still letting a truly abandoned
 * worktree (hours to days idle) become prunable on the next run. Overridable
 * per-call via `options.mtimeThresholdMs` in classifyWorktrees() — no env
 * var, since every caller already goes through that function.
 */
const WORKTREE_PRUNE_MTIME_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolve a filesystem path to its canonical real path, tolerating a path
 * that doesn't exist (falls back to path.resolve) so callers never throw
 * comparing a live worktree path against one that has already been removed.
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * T-660: is `projectRoot` the framework's OWN installation (self-mode), as
 * opposed to an adopter project that merely resolves the framework's shared
 * scripts/ directory via MAVERICKS_SCRIPTS? `mavp-version.js` (like
 * `mavp-operator-lib.js`) is never synced into an adopter project — it is
 * always resolved from `mavericksScriptsDir`, the directory a caller already
 * had to resolve to require this very library (see
 * resolveMavericksScriptsDir() in mavp-operator-close-session.js /
 * mavp-operator-agent.js) — so "self-mode" reduces to one comparison: does
 * the project root the caller is operating on realpath-equal the parent of
 * that scripts directory (i.e. the framework checkout mavp-version.js lives
 * under)?
 *
 * Deliberately realpath-, not string-, equal: the two paths can differ by a
 * symlink hop (e.g. macOS's /tmp -> /private/tmp) or a trailing separator
 * and still name the same tree — a string comparison would misclassify that
 * case as adopter-mode and silently skip the self-mode stamp.
 *
 * @param {string} projectRoot - the resolved project root under test (e.g.
 *   `ROOT` in mavp-operator-close-session.js).
 * @param {string} mavericksScriptsDir - the resolved scripts/ directory that
 *   mavp-version.js lives in (e.g. `MAVERICKS_SCRIPTS_DIR`).
 * @returns {boolean}
 */
function isSelfHostedRoot(projectRoot, mavericksScriptsDir) {
  return safeRealpath(projectRoot) === safeRealpath(path.dirname(mavericksScriptsDir));
}

/**
 * Parse `git worktree list --porcelain` into structured entries. Each block
 * is separated by a blank line; fields are `worktree <path>`, `HEAD <hash>`,
 * `branch refs/heads/<name>` (or the bare tokens `detached`/`bare`/`locked`/
 * `prunable`). Degrades to `[]` (never throws) when `root` is not a git
 * repository or git is unavailable.
 *
 * @param {string} root - Absolute path to any worktree of the repo (worktree
 *   list is shared across all linked worktrees of the same repo).
 * @returns {Array<{path:string, head:string|null, branch:string|null, detached:boolean, bare:boolean, locked:boolean, prunable:boolean}>}
 */
function listGitWorktrees(root) {
  try {
    const output = cp.execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const blocks = output.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    return blocks
      .map((block) => {
        const lines = block.split('\n');
        const entry = {
          path: null,
          head: null,
          branch: null,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
        };
        for (const line of lines) {
          if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
          else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim();
          else if (line.startsWith('branch ')) {
            entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
          } else if (line === 'detached') entry.detached = true;
          else if (line === 'bare') entry.bare = true;
          else if (line.startsWith('locked')) entry.locked = true;
          else if (line.startsWith('prunable')) entry.prunable = true;
        }
        return entry;
      })
      .filter((e) => e.path);
  } catch {
    return [];
  }
}

/**
 * True when `worktreePath` has uncommitted changes (working tree or index),
 * false when clean, null when the check cannot be performed (missing
 * directory, broken worktree, git failure) — callers must treat null
 * conservatively (never as "clean").
 */
function isWorktreeDirty(worktreePath) {
  try {
    const output = cp.execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Classify a ref's commits-ahead-of-mainRef by PATCH equivalence (`git
 * cherry`), not raw reachability. `git cherry <mainRef> <ref>` compares by
 * patch id: a line prefixed `-` means an equivalent patch is already
 * reachable from mainRef (e.g. the origin of a cherry-picked commit); a line
 * prefixed `+` means no equivalent exists yet. Raw reachability
 * (`merge-base --is-ancestor`, `branch --merged`) is unusable here because
 * this project integrates by cherry-pick — every worktree tip is unreachable
 * from mainRef by construction even when its work is fully, correctly
 * integrated.
 *
 * @returns {'integrated'|'unintegrated'|'unknown'} 'integrated' when there are
 *   no commits ahead of mainRef at all, or every commit ahead has a patch
 *   equivalent already in mainRef; 'unintegrated' when at least one commit
 *   ahead has no patch equivalent; 'unknown' when the check itself fails
 *   (missing ref, git failure) — callers must treat 'unknown' conservatively
 *   (never as "integrated").
 */
function getPatchEquivalenceStatus(root, mainRef, ref) {
  try {
    const output = cp.execFileSync('git', ['cherry', mainRef, ref], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return 'integrated';
    return lines.some((l) => l.startsWith('+')) ? 'unintegrated' : 'integrated';
  } catch {
    return 'unknown';
  }
}

/**
 * fs.statSync(path).mtimeMs, degrading to null (never throws) when the
 * directory can't be stat'd (e.g. already removed).
 */
function getWorktreeDirectoryMtimeMs(worktreePath) {
  try {
    return fs.statSync(worktreePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Typed signal for "mainRef does not resolve to a commit in this repo" (T-633)
 * — a caller-level precondition failure, distinct from the per-worktree
 * `getPatchEquivalenceStatus` → 'unknown' fallback (a single broken worktree,
 * preserved as-is). Thrown by classifyWorktrees() BEFORE any per-worktree
 * work happens, so a caller can never mistake "I could not check at all" for
 * a normal (even if empty) classified result — see the doc comment on
 * classifyWorktrees() for the full rationale. Callers distinguish it from
 * any other thrown error via `instanceof UnresolvableMainRefError` (or the
 * `code === 'UNRESOLVABLE_MAIN_REF'` property, for callers that can't import
 * the class directly); `.mainRef` carries the offending ref string.
 */
class UnresolvableMainRefError extends Error {
  constructor(mainRef) {
    super(`mainRef '${mainRef}' does not resolve to a commit in this repo`);
    this.name = 'UnresolvableMainRefError';
    this.code = 'UNRESOLVABLE_MAIN_REF';
    this.mainRef = mainRef;
  }
}

/**
 * True when `ref` resolves to a commit in `root`'s repo (via `git rev-parse
 * --verify --quiet <ref>^{commit}`), false otherwise. Never throws — a
 * resolution failure (bad ref, not a git repo) is exactly what `false`
 * means.
 */
function refResolvesToCommit(root, ref) {
  try {
    cp.execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify every linked (non-primary) worktree of `root`'s repo into exactly
 * one of three classes (T-559):
 *   - 'dirty' — uncommitted changes present (working tree or index).
 *   - 'unintegrated' — clean, but at least one commit ahead of mainRef has no
 *     patch-equivalent commit reachable from mainRef (see
 *     getPatchEquivalenceStatus doc comment for why this must be
 *     patch-equivalence, not raw reachability). Also the conservative
 *     fallback when a single worktree's own dirty/patch status can't be
 *     determined (broken worktree, missing object) — that per-entry fallback
 *     is intentionally preserved and must never be confused with the
 *     caller-level precondition failure below.
 *   - 'clean-and-integrated' — clean, and every commit ahead of mainRef (if
 *     any) is patch-equivalent to a commit already in mainRef.
 *
 * `prunable` is additionally gated on the mtime safety condition: a
 * clean-and-integrated worktree whose directory mtime is within
 * `mtimeThresholdMs` of `now` is never prunable, protecting a just-spawned
 * live agent's still-clean worktree (see WORKTREE_PRUNE_MTIME_THRESHOLD_MS).
 *
 * The primary/main worktree (the one at `root` itself, or any `bare` entry)
 * is always excluded from the result.
 *
 * T-633: `mainRef` is verified ONCE up front, before any per-worktree work,
 * via `refResolvesToCommit()`. An unresolvable `mainRef` (e.g. the default
 * `'main'` on a repo whose default branch is actually `master`) throws
 * `UnresolvableMainRefError` rather than silently falling every worktree
 * through to 'unintegrated' — a caller-level precondition failure poisons
 * every entry identically and must never be confused with the honest,
 * per-worktree 'unknown' fallback preserved above.
 *
 * @param {string} root - Absolute path to the repo (any worktree of it).
 * @param {object} [options]
 * @param {string} [options.mainRef='main'] - Ref to compare patch equivalence against.
 * @param {number} [options.now=Date.now()] - Reference "now" timestamp (ms), for deterministic tests.
 * @param {number} [options.mtimeThresholdMs=WORKTREE_PRUNE_MTIME_THRESHOLD_MS] - mtime safety threshold (ms).
 * @returns {Array<{path:string, branch:string|null, head:string|null, classification:string, dirty:boolean|null, patchStatus:string, mtimeMs:number|null, ageMs:number|null, recentMtime:boolean, prunable:boolean}>}
 * @throws {UnresolvableMainRefError} when `mainRef` does not resolve to a commit.
 */
function classifyWorktrees(root, options = {}) {
  const mainRef = options.mainRef || 'main';
  const now = options.now != null ? options.now : Date.now();
  const mtimeThresholdMs =
    options.mtimeThresholdMs != null ? options.mtimeThresholdMs : WORKTREE_PRUNE_MTIME_THRESHOLD_MS;

  if (!refResolvesToCommit(root, mainRef)) {
    throw new UnresolvableMainRefError(mainRef);
  }

  const worktrees = listGitWorktrees(root);
  if (worktrees.length === 0) return [];

  const rootReal = safeRealpath(root);
  const linked = worktrees.filter((wt) => !wt.bare && safeRealpath(wt.path) !== rootReal);

  return linked.map((wt) => {
    const ref = wt.branch || wt.head;
    const dirty = isWorktreeDirty(wt.path);
    const patchStatus = ref ? getPatchEquivalenceStatus(root, mainRef, ref) : 'unknown';

    let classification;
    if (dirty === true) {
      classification = 'dirty';
    } else if (dirty === null || patchStatus === 'unintegrated' || patchStatus === 'unknown') {
      classification = 'unintegrated';
    } else {
      classification = 'clean-and-integrated';
    }

    const mtimeMs = getWorktreeDirectoryMtimeMs(wt.path);
    const ageMs = mtimeMs != null ? now - mtimeMs : null;
    // Unknown mtime (directory unreadable) is treated as "recent" — the safe
    // default is to withhold pruning, not to assume it's safely stale.
    const recentMtime = ageMs != null ? ageMs < mtimeThresholdMs : true;

    const prunable = classification === 'clean-and-integrated' && !recentMtime;

    return {
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      classification,
      dirty,
      patchStatus,
      mtimeMs,
      ageMs,
      recentMtime,
      prunable,
    };
  });
}

/**
 * Roll a classifyWorktrees() result up into total + per-class counts. Shared
 * by the `--worktree-report` flag and the `--close-session` one-line
 * advisory so there is exactly one summarization implementation (T-559).
 */
function summarizeWorktreeClassification(entries) {
  const counts = { dirty: 0, unintegrated: 0, 'clean-and-integrated': 0 };
  for (const e of entries) {
    if (Object.prototype.hasOwnProperty.call(counts, e.classification)) counts[e.classification] += 1;
  }
  return { total: entries.length, counts };
}

/**
 * Render the one-line worktree-hygiene advisory string consumed by
 * `--close-session` (both interactive and non-interactive modes). Also
 * reused verbatim as the summary line at the top of `--worktree-report`'s
 * fuller per-worktree output, so the two surfaces never drift apart.
 */
function formatWorktreeHygieneAdvisory(entries) {
  const { total, counts } = summarizeWorktreeClassification(entries);
  const prunableCount = entries.filter((e) => e.prunable).length;
  return (
    `Worktree hygiene: ${total} agent worktree(s) — ${counts.dirty} dirty, ` +
    `${counts.unintegrated} unintegrated, ${counts['clean-and-integrated']} clean-and-integrated ` +
    `(${prunableCount} prunable)`
  );
}

/**
 * Render a one-line, propose-only suggestion naming the ready-to-run
 * DRY-RUN prune command, composed AFTER (never instead of) the unchanged
 * `formatWorktreeHygieneAdvisory()` counts line (T-710). Returns `null` when
 * no entry is prunable — including the "clean-and-integrated exist but are
 * all held back by the mtime safety window" case, where routing the
 * operator to a command that would immediately answer "nothing prunable"
 * is exactly the advisory chatter DR-005/DR-008 warn against.
 *
 * The rendered command is always the dry-run form
 * `./scripts/mavp-operator --prune-worktrees` and must NEVER contain
 * `--yes` — actually deleting a worktree is irreversible and acts on a
 * repository-global shared resource (see the T-559 header on
 * `mavp-operator-prune-worktrees.js`), so this function only ever proposes
 * the safe, read-only preview step; the operator still runs `--yes`
 * themselves, by hand, once they've confirmed zero live sub-agents.
 *
 * When `clean-and-integrated` outnumbers `prunable`, an extra clause
 * attributes the gap to the mtime safety window so the discrepancy reads
 * as intentional rather than a bug.
 *
 * @param {Array<{classification:string, prunable:boolean}>} entries - classifyWorktrees() output.
 * @returns {string|null}
 */
function formatWorktreePruneSuggestion(entries) {
  const { counts } = summarizeWorktreeClassification(entries);
  const prunableCount = entries.filter((e) => e.prunable).length;
  if (prunableCount === 0) return null;

  const cleanCount = counts['clean-and-integrated'];
  const heldBack = cleanCount - prunableCount;
  const heldBackClause =
    heldBack > 0
      ? ` (${heldBack} more clean-and-integrated held back by the mtime safety window)`
      : '';

  return (
    `Suggested: run './scripts/mavp-operator --prune-worktrees' (dry-run) to preview ` +
    `${prunableCount} removable worktree(s)${heldBackClause}; re-run with --yes only once ` +
    `zero sub-agents are live.`
  );
}

// ---------------------------------------------------------------------------
// T-782: always-loaded context collector (CLAUDE.md + recursive @ imports +
// unscoped .claude/rules files), measured in characters.
//
// Import grammar follows the harness memory doc ("Import additional files"):
// an @path token resolves relative to the IMPORTING file's directory, ~/ is
// expanded, code spans and fenced blocks are skipped, the path ends at the
// first unescaped space, quoted paths are ignored, and recursion is capped at
// four hops. Two documented, deliberate narrowings: (1) an @ only starts an
// import at the beginning of a line or after whitespace / an opening bracket,
// so email-like tokens (word@host) never count; (2) trailing sentence
// punctuation is trimmed from the path. Tokens that still look like imports
// but name no file (e.g. a scoped package name in prose) are recorded as
// missing with chars 0 — they never inflate the total.
// ---------------------------------------------------------------------------

const ALWAYS_LOADED_MAX_HOPS = 4;

/** Blank out fenced blocks and inline code spans so @ inside them is ignored. */
function stripCodeForImportScan(text) {
  const kept = [];
  let fence = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/(`+)[\s\S]*?\1/g, ' ');
}

/** Extract raw @path tokens (unescaped, trailing punctuation trimmed). */
function extractImportTokens(text) {
  const scan = stripCodeForImportScan(text);
  const tokens = [];
  const re = /(^|[\s(\[])@((?:\\ |[^\s])+)/gm;
  let m;
  while ((m = re.exec(scan)) !== null) {
    let raw = m[2];
    if (/^["'“‘]/.test(raw)) continue; // quoted paths are ignored
    raw = raw.replace(/[.,;:!?)\]]+$/, '').replace(/\\ /g, ' ');
    if (raw) tokens.push(raw);
  }
  return tokens;
}

/** True when a rule file's frontmatter carries a parseable paths: key. */
function ruleHasPathsFrontmatter(text) {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  const lines = fm[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^paths:/.test(l));
  if (idx === -1) return false;
  if (lines[idx].replace(/^paths:/, '').trim()) return true;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^\s+-\s+\S/.test(lines[i])) return true;
    if (/^\S/.test(lines[i])) break;
  }
  return false;
}

function defaultReadFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function defaultListMarkdown(absDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(absDir);
  return out;
}

/**
 * Measure the always-loaded context of a project root in characters.
 *
 * @param {string} root
 * @param {{readFile?: (absPath:string)=>(string|null), listMarkdown?: (absDir:string)=>string[], maxHops?: number}} [opts]
 *   readFile returns the file text or null/undefined when absent (injectable so
 *   a later task can read from a git tree); listMarkdown enumerates .md files
 *   under a directory (defaults to a recursive fs walk).
 * @returns {{files: Array<{path:string, chars:number, kind:string, missing?:true}>,
 *   path_scoped_rules: Array<{path:string, chars:number}>, external: string[], total_chars: number}}
 */
function collectAlwaysLoadedContext(root, opts = {}) {
  const readFile = opts.readFile || defaultReadFile;
  const listMarkdown = opts.listMarkdown || defaultListMarkdown;
  const maxHops = opts.maxHops === undefined ? ALWAYS_LOADED_MAX_HOPS : opts.maxHops;
  const absRoot = path.resolve(root);
  const rel = (abs) => path.relative(absRoot, abs).split(path.sep).join('/');
  const isInside = (abs) => abs === absRoot || abs.startsWith(absRoot + path.sep);

  const files = [];
  const pathScoped = [];
  const external = [];
  const seen = new Set();

  const claudeAbs = path.join(absRoot, 'CLAUDE.md');
  const claudeText = readFile(claudeAbs);
  if (typeof claudeText === 'string') {
    seen.add(claudeAbs);
    files.push({ path: 'CLAUDE.md', chars: claudeText.length, kind: 'claude_md' });
    // Breadth-first so a file reachable by several routes is judged at its
    // shallowest hop depth.
    let frontier = [{ abs: claudeAbs, text: claudeText }];
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
      const next = [];
      for (const { abs, text } of frontier) {
        for (const token of extractImportTokens(text)) {
          let target;
          if (token === '~' || token.startsWith('~/')) target = path.join(os.homedir(), token.slice(1));
          else if (path.isAbsolute(token)) target = path.normalize(token);
          else target = path.resolve(path.dirname(abs), token);
          if (!isInside(target)) {
            if (!external.includes(target)) external.push(target);
            continue;
          }
          if (seen.has(target)) continue;
          seen.add(target);
          const body = readFile(target);
          if (typeof body !== 'string') {
            files.push({ path: rel(target), chars: 0, kind: 'import', missing: true });
            continue;
          }
          files.push({ path: rel(target), chars: body.length, kind: 'import' });
          next.push({ abs: target, text: body });
        }
      }
      frontier = next;
    }
  }

  for (const ruleAbs of listMarkdown(path.join(absRoot, '.claude', 'rules'))) {
    if (seen.has(ruleAbs)) continue;
    const body = readFile(ruleAbs);
    if (typeof body !== 'string') continue;
    seen.add(ruleAbs);
    if (ruleHasPathsFrontmatter(body)) {
      pathScoped.push({ path: rel(ruleAbs), chars: body.length });
    } else {
      files.push({ path: rel(ruleAbs), chars: body.length, kind: 'rule' });
    }
  }

  return {
    files,
    path_scoped_rules: pathScoped,
    external,
    total_chars: files.reduce((sum, f) => sum + f.chars, 0),
  };
}

// ---------------------------------------------------------------------------
// Adopter feedback items (T-828) — schema, parser/renderer, intake resolver.
// templates/FEEDBACK_ITEM_TEMPLATE.md is the single source of the item format;
// the constants below mirror its field and section names.
// ---------------------------------------------------------------------------

const FEEDBACK_SCHEMA_VERSION = 1;
const FEEDBACK_ALIAS_PATTERN = /^[a-z][a-z0-9]{1,23}$/;
const FEEDBACK_KINDS = ['bug', 'proposal', 'question'];
const FEEDBACK_SEVERITIES = ['blocking', 'high', 'normal', 'low'];
const FEEDBACK_CHANNELS = ['local', 'github'];
// Canonical bold-field order; renderFeedbackItem() writes in this order.
const FEEDBACK_FIELD_ORDER = [
  'Schema', 'Item', 'Adopter', 'Framework version', 'Kind', 'Severity', 'Area', 'Summary',
  'Submitted', 'Channel', 'Issue', 'Workaround', 'Disposition', 'Ships in',
  'Retire workaround', 'Triaged', 'Published', 'Acknowledged',
];
// Always rendered even when empty; every other field is omitted when empty.
const FEEDBACK_ALWAYS_RENDERED_FIELDS = [
  'Schema', 'Item', 'Adopter', 'Framework version', 'Kind', 'Severity', 'Area',
  'Submitted', 'Channel',
];
const FEEDBACK_SECTION_ORDER = ['Observed', 'Evidence', 'Proposal', 'Answer'];
const FEEDBACK_ITEM_FILE_PATTERN = /^([a-z][a-z0-9]{1,23})-(\d{1,9})\.md$/;

// Linear-time heading and body trimming for feedback items (T-840). Item text can come from an
// outside party (a pulled GitHub issue body), so none of this may use a lazy group followed by a
// trailing-whitespace anchor: that shape retries the anchor at every position inside a long run of
// whitespace and is quadratic. `trimEnd()` strips exactly the characters `\s` matches.
const NOT_DOT_CHAR = /[\r\n\u2028\u2029]/; // the characters a bare `.` does not match

/**
 * Decide whether `line` is a markdown heading of `level` (1 for `# `, 2 for `## `) and return its
 * name, or null. Matches exactly what the former pattern (hashes, whitespace, a lazy name, then
 * trailing whitespace to the end of the line) did: the name runs from the first non-whitespace
 * character to the last one and may not contain a line terminator (a lone carriage return inside
 * the name is not a heading). A line that is only the hashes followed by whitespace is a heading
 * when that whitespace runs to two or more characters and one of those after the first is not a
 * line terminator — the old pattern read one such character as the name; the returned name is that
 * character, never a known section. One space, or a space and a carriage return, is not a heading.
 *
 * @param {string} line
 * @param {number} level
 * @returns {string|null}
 */
function matchMarkdownHeading(line, level) {
  if (!line.startsWith('#'.repeat(level)) || !/\s/.test(line.charAt(level))) return null;
  const tail = line.slice(level);
  const first = tail.search(/\S/);
  if (first === -1) {
    for (let i = tail.length - 1; i >= 1; i--) if (!NOT_DOT_CHAR.test(tail[i])) return tail[i];
    return null;
  }
  const name = tail.slice(first).trimEnd();
  return NOT_DOT_CHAR.test(name) ? null : name;
}

// Split a title heading's text on its first whitespace-flanked em dash into [id, title], or null.
// Same match as the former lazy-name pattern for text produced by matchMarkdownHeading, without its
// quadratic retries over a long whitespace run.
function splitFeedbackTitle(text) {
  const ws = (c) => c !== undefined && /\s/.test(c);
  let idx = text.indexOf('—', 2);
  while (idx !== -1) {
    if (ws(text[idx - 1]) && ws(text[idx + 1])) {
      let nameEnd = idx - 1;
      while (nameEnd > 1 && ws(text[nameEnd - 1])) nameEnd--;
      const rest = text.slice(idx + 1);
      const restStart = rest.search(/\S/);
      if (restStart === -1) return null;
      return [text.slice(0, nameEnd), rest.slice(restStart)];
    }
    idx = text.indexOf('—', idx + 1);
  }
  return null;
}

// Strip leading newlines and all trailing whitespace; identical to the former global replace of
// leading newlines or trailing whitespace with nothing.
function trimFeedbackBody(text) {
  let i = 0;
  while (text.charCodeAt(i) === 10) i++;
  return text.slice(i).trimEnd();
}

/**
 * Parse a feedback item document. Bold-field idiom (`- **Name:** value`) in the
 * header region (before the first `## ` heading outside a code fence); fields
 * not in FEEDBACK_FIELD_ORDER are ignored; sections are the `## Name` headings
 * in FEEDBACK_SECTION_ORDER (headings inside fenced code blocks do not split).
 * Throws when Schema is missing/non-numeric or above FEEDBACK_SCHEMA_VERSION.
 *
 * @param {string} markdown
 * @returns {{title: string|null, id: string|null, fields: Object<string,string>, sections: Object<string,string>}}
 */
function parseFeedbackItem(markdown) {
  const lines = String(markdown || '').split('\n');
  let title = null;
  let titleId = null;
  const fields = {};
  const sections = {};
  let currentSection = null;
  let seenSection = false;
  let sectionLines = [];
  let inFence = false;
  const flush = () => {
    if (currentSection !== null) sections[currentSection] = trimFeedbackBody(sectionLines.join('\n'));
    sectionLines = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h2 = matchMarkdownHeading(line, 2);
      if (h2 !== null) {
        flush();
        seenSection = true;
        currentSection = FEEDBACK_SECTION_ORDER.includes(h2) ? h2 : null;
        continue;
      }
    }
    if (seenSection) {
      if (currentSection !== null) sectionLines.push(line);
      continue;
    }
    if (title === null && !inFence) {
      const h1 = matchMarkdownHeading(line, 1);
      if (h1 !== null) {
        const parts = splitFeedbackTitle(h1);
        if (parts) {
          titleId = parts[0].trim();
          title = parts[1].trim();
        } else {
          title = h1.trim();
        }
        continue;
      }
    }
    const f = line.match(/^\s*-\s+\*\*([^*:]+):\*\*[ \t]*(.*)$/);
    if (f) {
      const name = f[1].trim();
      if (FEEDBACK_FIELD_ORDER.includes(name) && !(name in fields)) fields[name] = f[2].trim();
    }
  }
  flush();
  const schemaRaw = fields.Schema;
  if (schemaRaw === undefined || !/^\d+$/.test(schemaRaw)) {
    throw new Error(`feedback item has no numeric Schema field (this build reads schema version ${FEEDBACK_SCHEMA_VERSION})`);
  }
  if (Number(schemaRaw) > FEEDBACK_SCHEMA_VERSION) {
    throw new Error(
      `feedback item uses schema version ${schemaRaw}, newer than the supported version ${FEEDBACK_SCHEMA_VERSION}; update the framework to read it`
    );
  }
  return { title, id: fields.Item || titleId, fields, sections };
}

/**
 * Render a feedback item to markdown. Inverse of parseFeedbackItem for known
 * fields. `item.id` (or fields.Item) heads the title line.
 *
 * @param {{title: string, id?: string, fields?: Object<string,string>, sections?: Object<string,string>}} item
 * @returns {string}
 */
function renderFeedbackItem(item) {
  const fields = Object.assign({}, item.fields || {});
  const id = item.id || fields.Item || '';
  if (!fields.Item && id) fields.Item = id;
  if (!fields.Schema) fields.Schema = String(FEEDBACK_SCHEMA_VERSION);
  const out = [`# ${id} — ${item.title || ''}`, ''];
  for (const name of FEEDBACK_FIELD_ORDER) {
    const value = fields[name] === undefined || fields[name] === null ? '' : String(fields[name]).trim();
    if (!value && !FEEDBACK_ALWAYS_RENDERED_FIELDS.includes(name)) continue;
    out.push(value ? `- **${name}:** ${value}` : `- **${name}:**`);
  }
  const sections = item.sections || {};
  for (const name of FEEDBACK_SECTION_ORDER) {
    const body = sections[name] === undefined || sections[name] === null ? '' : trimFeedbackBody(String(sections[name]));
    if (!body && name === 'Answer') continue;
    out.push('', `## ${name}`, '', body);
  }
  return out.join('\n').trimEnd() + '\n';
}

/**
 * Set (replace or insert) one known bold field in raw feedback markdown while
 * leaving every other byte untouched. An insert goes after the last header
 * bullet that precedes the field in FEEDBACK_FIELD_ORDER.
 */
function setFeedbackField(markdown, fieldName, value) {
  const lines = String(markdown).split('\n');
  const bullet = `- **${fieldName}:** ${value}`;
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRe = new RegExp(`^\\s*-\\s+\\*\\*${escaped}:\\*\\*`);
  const firstH2 = lines.findIndex((l) => /^##\s/.test(l));
  const headerEnd = firstH2 === -1 ? lines.length : firstH2;
  for (let i = 0; i < headerEnd; i++) {
    if (fieldRe.test(lines[i])) {
      lines[i] = bullet;
      return lines.join('\n');
    }
  }
  const rank = FEEDBACK_FIELD_ORDER.indexOf(fieldName);
  let insertAt = -1;
  for (let i = 0; i < headerEnd; i++) {
    const m = lines[i].match(/^\s*-\s+\*\*([^*:]+):\*\*/);
    if (!m) continue;
    const r = FEEDBACK_FIELD_ORDER.indexOf(m[1].trim());
    if (r !== -1 && r < rank) insertAt = i + 1;
  }
  if (insertAt === -1) insertAt = headerEnd;
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Workaround retirement (T-831) — tag convention, CHANGELOG supersedes phrases,
// harness memory directory resolver, retirability classifier. Read-only helpers
// behind `--migrate` (scripts/mavp-operator-migrate.js) and the post-`--update`
// advisory in scripts/mavp-install.js.
// ---------------------------------------------------------------------------

// The literal tag an adopter places beside a stop-gap: `mavp-workaround:<alias>-NNN`
// (the same shape `--feedback --file` records in an item's Workaround field).
// Capture group 1 is the item id. Not global: build a `g` copy to scan a line.
const WORKAROUND_TAG_PATTERN = /mavp-workaround:([a-z][a-z0-9]{1,23}-\d+)/;

/**
 * Read the `**Supersedes adopter workarounds:**` lines out of CHANGELOG text.
 * Phrases are the backticked spans following the marker on that line; each belongs
 * to the nearest preceding `## [x.y.z]` or `## [Unreleased]` heading (reported as
 * version "Unreleased"). Sections with no such line are omitted.
 *
 * @param {string} changelogText
 * @returns {Array<{version: string, phrases: string[]}>}
 */
function parseChangelogSupersedes(changelogText) {
  const out = [];
  let current = null;
  for (const line of String(changelogText || '').split('\n')) {
    const heading = line.match(/^##\s+\[([^\]]+)\]/);
    if (heading) {
      const label = heading[1].trim();
      if (/^unreleased$/i.test(label)) current = 'Unreleased';
      else if (/^\d+\.\d+\.\d+$/.test(label)) current = label;
      else current = null;
      continue;
    }
    if (current === null) continue;
    const marker = line.indexOf('**Supersedes adopter workarounds:**');
    if (marker === -1) continue;
    const phrases = [];
    for (const m of line.slice(marker).matchAll(/`([^`]+)`/g)) {
      const phrase = m[1].trim();
      if (phrase) phrases.push(phrase);
    }
    if (phrases.length === 0) continue;
    const existing = out.find((s) => s.version === current);
    if (existing) existing.phrases.push(...phrases);
    else out.push({ version: current, phrases });
  }
  return out;
}

/**
 * The harness's per-project memory directory: <home>/.claude/projects/<slug>/memory,
 * where <slug> is the absolute project root with every path separator replaced
 * by a hyphen. Returns null when that directory does not exist. `options.home`
 * overrides the home directory (test hook); otherwise os.homedir() is used.
 *
 * @param {string} projectRoot
 * @param {{home?: string}} [options]
 * @returns {string|null}
 */
function resolveHarnessMemoryDir(projectRoot, options = {}) {
  const home = options.home || os.homedir();
  const slug = path.resolve(String(projectRoot)).replace(/[\\/]/g, '-');
  const dir = path.join(home, '.claude', 'projects', slug, 'memory');
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Classify one listIntakeItems() entry (`{id, item}`) by whether its fix is installed
 * at `installedVersion`, regardless of whether the item records a Workaround.
 * Returns null for an unreadable entry (`item` null). Status:
 *   retire        Disposition is `fixed-in T-NNN` and Ships in is `released in V`
 *                 with V semver-less-or-equal to installedVersion
 *   keep-pending  fixed, but not released yet or released after installedVersion
 *   keep-open     any other disposition (or none)
 * `shipsIn` is the released version, `unreleased`, or null when unknown.
 * `--migrate` uses this per tag it finds; the aggregate below filters on Workaround.
 */
function classifyFeedbackItem(entry, installedVersion) {
  if (!entry || !entry.item) return null;
  const fields = entry.item.fields || {};
  const fixed = String(fields.Disposition || '').trim().match(/^fixed-in (T-\d+)\b/);
  let status = 'keep-open';
  let shipsIn = null;
  if (fixed) {
    const ships = String(fields['Ships in'] || '').trim();
    const released = ships.match(/^released in (\d+\.\d+\.\d+)/);
    if (released) {
      shipsIn = released[1];
      status = semverCompare(released[1], String(installedVersion)) <= 0 ? 'retire' : 'keep-pending';
    } else {
      shipsIn = /^unreleased/i.test(ships) ? 'unreleased' : null;
      status = 'keep-pending';
    }
  }
  return {
    id: entry.id,
    tag: `mavp-workaround:${entry.id}`,
    status,
    fixedIn: fixed ? fixed[1] : null,
    shipsIn,
    // Additive (T-835): the GitHub issue a posted item tracks as `<slug>#N`, or null.
    issue: (() => {
      if (String(fields.Channel || '').trim() !== 'github') return null;
      const ref = parseFeedbackIssueRef(fields.Issue);
      return ref ? `${ref.slug}#${ref.number}` : null;
    })(),
  };
}

/**
 * Classify the TAGGED items among `items` (listIntakeItems() entries) by whether
 * the workaround they track is retirable at `installedVersion`. An item is tagged
 * when its Workaround field is non-empty; items without one and unreadable
 * entries are omitted from the result. Status values are those of
 * classifyFeedbackItem(): `retire`, `keep-pending`, `keep-open`.
 *
 * @returns {Array<{id: string, tag: string, status: 'retire'|'keep-pending'|'keep-open', fixedIn: string|null, shipsIn: string|null}>}
 */
function computeRetirableWorkarounds(items, installedVersion) {
  const results = [];
  for (const entry of items || []) {
    if (!entry || !entry.item) continue;
    if (!String((entry.item.fields || {}).Workaround || '').trim()) continue;
    results.push(classifyFeedbackItem(entry, installedVersion));
  }
  return results;
}

/** Per-user feedback inbox: MAVERICKS_INTAKE_DIR when set, else <home>/.mavericks-intake. */
function resolveIntakeDir() {
  const override = process.env.MAVERICKS_INTAKE_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.mavericks-intake');
}

/**
 * List the feedback items in an intake directory, sorted by alias then number.
 * Returns [] when the directory does not exist. Each entry:
 * {id, alias, number, file, path, item, error} — `item` is the parsed item or
 * null with `error` set when the file cannot be parsed (e.g. newer schema).
 */
function listIntakeItems(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const file of names) {
    const m = file.match(FEEDBACK_ITEM_FILE_PATTERN);
    if (!m) continue;
    const full = path.join(dir, file);
    let item = null;
    let error = null;
    try {
      item = parseFeedbackItem(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      error = err.message;
    }
    entries.push({ id: `${m[1]}-${m[2]}`, alias: m[1], number: Number(m[2]), file, path: full, item, error });
  }
  entries.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : a.number - b.number));
  return entries;
}

/**
 * Allocate the next `<alias>-NNN` id in `dir` (highest existing N for the alias
 * plus one, zero-padded to 3 digits) and create its file with an exclusive-create
 * open (flag `wx`), re-scanning and retrying on collision so two concurrent
 * allocations never share an id. `render` (optional) is called with the id and
 * its result is written into the reserved file; without it an empty file
 * reserves the id.
 *
 * @returns {{id: string, path: string}}
 */
function allocateFeedbackItemId(dir, alias, render) {
  if (!FEEDBACK_ALIAS_PATTERN.test(String(alias))) {
    throw new Error(`invalid feedback alias "${alias}" (must match ${FEEDBACK_ALIAS_PATTERN})`);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 1000; attempt++) {
    let highest = 0;
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(FEEDBACK_ITEM_FILE_PATTERN);
      if (m && m[1] === alias) highest = Math.max(highest, Number(m[2]));
    }
    const id = `${alias}-${String(highest + 1).padStart(3, '0')}`;
    const target = path.join(dir, `${id}.md`);
    let fd;
    try {
      fd = fs.openSync(target, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      if (typeof render === 'function') fs.writeSync(fd, render(id));
    } catch (err) {
      fs.closeSync(fd);
      fs.unlinkSync(target);
      throw err;
    }
    fs.closeSync(fd);
    return { id, path: target };
  }
  throw new Error(`could not allocate a feedback id for alias ${alias} after 1000 attempts`);
}

// ---------------------------------------------------------------------------
// Session-end feedback capture (T-833) — note lines, drafts.
// A note is an EXECUTION_LOG.md list-item line whose text, after the bullet and
// an optional YYYY-MM-DD date, begins with the literal token `mavp-feedback:`
// followed by a short description and optional parenthesised hints
// `(area: <text>; kind: bug|proposal|question)`. The pattern is anchored to that
// line-initial position, so a mid-line mention never matches. Drafts live in
// `<inbox>/drafts/<alias>-draft-<n>.md` and are not items: no id is allocated
// until `--feedback --file <draft>` submits one.
// ---------------------------------------------------------------------------

// Not global, one line at a time. Group 1 = optional date, group 2 = description + hints.
const FEEDBACK_NOTE_PATTERN = /^[ \t]*[-*+][ \t]+(?:(\d{4}-\d{2}-\d{2})[ \t]*[:–—-]?[ \t]*)?mavp-feedback:[ \t]*(\S.*?)[ \t]*$/;
const FEEDBACK_DRAFT_FILE_PATTERN = /^([a-z][a-z0-9]{1,23})-draft-(\d{1,9})\.md$/;

/**
 * Parse the feedback note lines out of a text (an EXECUTION_LOG.md body or the
 * added lines of its diff). `line` is the 1-based line number within `text`.
 * A trailing parenthetical is read as hints only when every `;`-separated part
 * is `area: <text>` or `kind: <text>`; `kind` must be one of FEEDBACK_KINDS
 * (anything else yields null). Notes with an empty title are dropped.
 *
 * @param {string} text
 * @returns {Array<{line: number, title: string, area: string|null, kind: string|null}>}
 */
function parseFeedbackNotes(text) {
  const notes = [];
  String(text || '').split(/\r?\n/).forEach((raw, idx) => {
    const m = raw.match(FEEDBACK_NOTE_PATTERN);
    if (!m) return;
    let title = m[2];
    let area = null;
    let kind = null;
    const hint = title.match(/\(([^()]*)\)\s*$/);
    if (hint) {
      const parts = hint[1].split(';').map((p) => p.trim()).filter(Boolean);
      const parsed = parts.map((p) => p.match(/^(area|kind)\s*:\s*(\S.*)$/i));
      if (parts.length > 0 && parsed.every(Boolean)) {
        for (const pm of parsed) {
          const key = pm[1].toLowerCase();
          const value = pm[2].trim();
          if (key === 'area') area = value;
          else kind = FEEDBACK_KINDS.includes(value.toLowerCase()) ? value.toLowerCase() : null;
        }
        title = title.slice(0, hint.index).trim();
      }
    }
    title = title.replace(/\s+/g, ' ').trim();
    if (!title) return;
    notes.push({ line: idx + 1, title, area, kind });
  });
  return notes;
}

/** `<inbox>/drafts` — where `--feedback --draft` writes. */
function resolveFeedbackDraftsDir(inbox) {
  return path.join(inbox || resolveIntakeDir(), 'drafts');
}

function feedbackValueOrEmpty(value) {
  const v = String(value || '').trim();
  return v.startsWith('<') && v.endsWith('>') ? '' : v;
}

/**
 * List one alias's drafts, sorted by draft number. Each entry:
 * {id, alias, number, file, path, title, summary, observed, error} — `summary` is
 * the optional Summary field ('' when absent or an unfilled placeholder),
 * `observed` the first non-empty line of the Observed section outside HTML
 * comments. An unparseable draft is still listed (title '', `error` set).
 */
function listFeedbackDrafts(inbox, alias) {
  const dir = resolveFeedbackDraftsDir(inbox);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const file of names) {
    const m = file.match(FEEDBACK_DRAFT_FILE_PATTERN);
    if (!m || m[1] !== alias) continue;
    const full = path.join(dir, file);
    const entry = { id: `${m[1]}-draft-${m[2]}`, alias: m[1], number: Number(m[2]), file, path: full, title: '', summary: '', observed: '', error: null };
    try {
      const parsed = parseFeedbackItem(fs.readFileSync(full, 'utf8'));
      entry.title = feedbackValueOrEmpty(parsed.title);
      entry.summary = feedbackValueOrEmpty(parsed.fields.Summary);
      const body = String(parsed.sections.Observed || '').replace(/<!--[\s\S]*?-->/g, '');
      entry.observed = (body.split('\n').map((l) => l.trim()).find(Boolean)) || '';
    } catch (err) {
      entry.error = err.message;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.number - b.number);
  return entries;
}

/** `<path> — <title> — <summary, or the first non-empty line of Observed, or —>` */
function formatFeedbackDraftLine(entry) {
  return `${entry.path} — ${entry.title || '—'} — ${entry.summary || entry.observed || '—'}`;
}

/**
 * Compare two semver strings (e.g. "0.4.0" vs "0.3.6").
 * Returns 1 if a > b, -1 if a < b, 0 if equal. (Lifted from the --agent script, T-829.)
 */
function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Where does the fix for a task ship, according to CHANGELOG.md text? (T-829)
 * An entry "cites" a task when a parenthetical group on one of its lines lists
 * the id as a whole comma-separated token, e.g. `(T-900)` or `(T-900, T-901)`.
 * Returns:
 *   `released in x.y.z`  - a numbered `## [x.y.z]` section cites it (the lowest such version
 *                          when several do)
 *   `unreleased (next after <currentVersion>)` - only `## [Unreleased]` cites it
 *   `not yet in CHANGELOG` - no section cites it
 */
function computeShipsIn(changelogText, taskId, currentVersion) {
  let section = null; // {kind: 'unreleased'} | {kind: 'released', version} | null
  let unreleased = false;
  let released = null;
  for (const line of String(changelogText || '').split('\n')) {
    const heading = line.match(/^##\s+\[([^\]]+)\]/);
    if (heading) {
      const label = heading[1].trim();
      if (/^unreleased$/i.test(label)) section = { kind: 'unreleased' };
      else if (/^\d+\.\d+\.\d+$/.test(label)) section = { kind: 'released', version: label };
      else section = null;
      continue;
    }
    if (!section) continue;
    let cites = false;
    for (const group of line.matchAll(/\(([^()]*)\)/g)) {
      if (group[1].split(',').some((token) => token.trim() === taskId)) {
        cites = true;
        break;
      }
    }
    if (!cites) continue;
    if (section.kind === 'unreleased') unreleased = true;
    else if (released === null || semverCompare(section.version, released) < 0) released = section.version;
  }
  if (released !== null) return `released in ${released}`;
  if (unreleased) return `unreleased (next after ${currentVersion})`;
  return 'not yet in CHANGELOG';
}

/** Count parsed intake items with no Disposition (the framework-side triage queue). */
function countIntakeUntriaged(dir) {
  return listIntakeItems(dir).filter((e) => e.item && !(e.item.fields.Disposition || '').trim()).length;
}

/** Count an alias's items that have a Disposition but no Acknowledged stamp (adopter side). */
function countUnackedFeedbackAnswers(dir, alias) {
  return listIntakeItems(dir).filter(
    (e) =>
      e.item &&
      e.alias === alias &&
      (e.item.fields.Disposition || '').trim() &&
      !(e.item.fields.Acknowledged || '').trim()
  ).length;
}

// ---------------------------------------------------------------------------
// GitHub channel for feedback items (T-830) — outbound scan, operator
// confirmation, and the single gh transport. Every gh call in the framework's
// feedback/intake commands goes through runGh().
// ---------------------------------------------------------------------------

// The public mirror's slug, the same one the README CI badge links to.
const MAVERICKS_FEEDBACK_REPO_DEFAULT = 'yahor-punko/mavericks-os';
const FEEDBACK_GITHUB_LABEL = 'mavp-feedback';
const FEEDBACK_ISSUE_TITLE_PREFIX = `[${FEEDBACK_GITHUB_LABEL}]`;
const FEEDBACK_REPO_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// Digits are bounded (1-9) so a hostile id can never build a filename past the OS limit.
const FEEDBACK_ITEM_ID_PATTERN = /^([a-z][a-z0-9]{1,23})-\d{1,9}$/;
// Fields an adopter owns; everything else (Disposition, Ships in, ...) is framework-owned.
const FEEDBACK_ADOPTER_FIELDS = [
  'Schema', 'Item', 'Adopter', 'Framework version', 'Kind', 'Severity', 'Area',
  'Submitted', 'Channel', 'Issue', 'Workaround',
];

// ---------------------------------------------------------------------------
// Return path for GitHub-channel answers (T-835) — the disposition grammar shared
// by the framework's triage and the adopter's `--feedback --pull`, the strict
// answer-comment grammar, the trust rule, and the answer-section writer.
// ---------------------------------------------------------------------------

// Disposition grammar (moved here from mavp-operator-intake.js; intake imports it).
const FEEDBACK_DISPOSITION_FIXED_PATTERN = /^fixed-in (T-\d+)$/;
const FEEDBACK_DISPOSITION_DUPLICATE_PATTERN = /^duplicate-of ([a-z][a-z0-9]{1,23}-\d+)$/;
const FEEDBACK_DISPOSITION_PLAIN_VALUES = ['by-design', 'deferred', 'not-reproduced'];
const FEEDBACK_DISPOSITION_GRAMMAR = [
  'fixed-in T-NNN',
  'by-design',
  'deferred',
  'duplicate-of <item>',
  'not-reproduced',
];
// GitHub author associations whose comments `--feedback --pull` believes. Everything else
// (CONTRIBUTOR, COLLABORATOR, FIRST_TIME_CONTRIBUTOR, NONE, ...) is ignored.
const FEEDBACK_ANSWER_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER'];
const FEEDBACK_ANSWER_MAX_CHARS = 10000;
// Upper bound on a raw answer-comment body, applied before any regex runs (GitHub caps a comment
// at 65536 characters; a longer body is cut, never rejected).
const FEEDBACK_ANSWER_COMMENT_MAX_CHARS = 65536;
const FEEDBACK_ANSWER_TRUNCATION_MARKER = '[truncated]';
// Characters removed from answer text: C0 controls except tab and newline, DEL and C1 controls,
// zero-width and directional marks, line/paragraph separators, bidi isolates, the byte-order mark,
// the soft hyphen, the combining grapheme joiner, the Arabic letter mark, the Mongolian vowel
// separator, the word joiner and the Unicode tag block (U+E0000-U+E007F, invisible tag characters).
// Built from code points so no invisible character sits in this file's text; the `u` flag makes
// the astral tag range a code-point range and leaves every other astral character untouched.
const FEEDBACK_ANSWER_STRIP_PATTERN = new RegExp(
  '[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' +
    [
      [0xad, 0xad],
      [0x34f, 0x34f],
      [0x61c, 0x61c],
      [0x180e, 0x180e],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2060, 0x2060],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
      [0xe0000, 0xe007f],
    ]
      .map(([a, b]) => String.fromCodePoint(a) + (a === b ? '' : '-' + String.fromCodePoint(b)))
      .join('') +
    ']',
  'gu'
);

/**
 * Remove trailing spaces and tabs only, in one linear pass. Deliberately not trimEnd(): that would
 * also accept a trailing no-break space or byte-order mark on a header line, widening the reviewed
 * header grammar.
 */
function stripTrailingSpacesAndTabs(line) {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) end--;
  return end === line.length ? line : line.slice(0, end);
}

/** True when `value` is exactly one of the triage disposition values. */
function isValidFeedbackDisposition(value) {
  const v = String(value);
  return (
    FEEDBACK_DISPOSITION_FIXED_PATTERN.test(v) ||
    FEEDBACK_DISPOSITION_DUPLICATE_PATTERN.test(v) ||
    FEEDBACK_DISPOSITION_PLAIN_VALUES.includes(v)
  );
}

const FEEDBACK_ANSWER_SHIPS_IN_PATTERN =
  /^(?:released in \d+\.\d+\.\d+|unreleased \(next after [0-9A-Za-z][0-9A-Za-z.+-]{0,31}\)|not yet in CHANGELOG)$/;
const FEEDBACK_ANSWER_RETIRE_PATTERN = /^(?:after \d+\.\d+\.\d+|after next release)$/;

/**
 * Strict parser for the maintainer's answer comment (the format composeAnswerComment writes).
 * Header lines, in this order: `Disposition: <v>` (required, v exactly a triage value),
 * `Framework task: T-NNN` (optional; only with a fixed-in disposition and equal to its id),
 * `Ships in: <one of computeShipsIn's three shapes>` (optional),
 * `Retire workaround: after x.y.z|after next release` (optional); then an optional blank line
 * and free text. Any other header line rejects the whole comment (returns null). The returned
 * `text` is the raw free text — run it through sanitizeFeedbackAnswerText() before storing.
 *
 * @returns {{disposition: string, frameworkTask: string|null, shipsIn: string|null, retire: string|null, text: string}|null}
 */
function parseFeedbackAnswerComment(body) {
  if (typeof body !== 'string') return null;
  const lines = body.slice(0, FEEDBACK_ANSWER_COMMENT_MAX_CHARS).replace(/\r\n?/g, '\n').split('\n');
  const first = stripTrailingSpacesAndTabs(lines[0]).match(/^Disposition: (.+)$/);
  if (!first || !isValidFeedbackDisposition(first[1])) return null;
  const disposition = first[1];
  const fixed = disposition.match(FEEDBACK_DISPOSITION_FIXED_PATTERN);
  const result = { disposition, frameworkTask: null, shipsIn: null, retire: null, text: '' };
  const headerKeys = ['Framework task', 'Ships in', 'Retire workaround'];
  let rank = -1;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = stripTrailingSpacesAndTabs(lines[i]);
    if (line === '') break;
    const m = line.match(/^(Framework task|Ships in|Retire workaround): (.+)$/);
    if (!m) return null;
    const r = headerKeys.indexOf(m[1]);
    if (r <= rank) return null; // out of order or repeated
    rank = r;
    if (m[1] === 'Framework task') {
      if (!fixed || m[2] !== fixed[1]) return null;
      result.frameworkTask = m[2];
    } else if (m[1] === 'Ships in') {
      if (!FEEDBACK_ANSWER_SHIPS_IN_PATTERN.test(m[2])) return null;
      result.shipsIn = m[2];
    } else {
      if (!FEEDBACK_ANSWER_RETIRE_PATTERN.test(m[2])) return null;
      result.retire = m[2];
    }
  }
  result.text = lines.slice(i + 1).join('\n').replace(/^\n+/, '').trimEnd();
  return result;
}

/**
 * Make untrusted answer text safe to store in an item's `## Answer` section: control and
 * bidi characters are removed (newline and tab kept), every line that starts — after optional
 * whitespace — with `#`, three backticks or three tildes is prefixed `> ` (so it can neither
 * open a section nor toggle a code fence in parseFeedbackItem), and the result is capped at
 * FEEDBACK_ANSWER_MAX_CHARS with a `[truncated]` marker line.
 */
function sanitizeFeedbackAnswerText(text) {
  let flat = String(text === undefined || text === null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(FEEDBACK_ANSWER_STRIP_PATTERN, '');
  flat = flat
    .split('\n')
    .map((line) => (/^\s*(#|```|~~~)/.test(line) ? `> ${line}` : line))
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd();
  if (flat.length > FEEDBACK_ANSWER_MAX_CHARS) {
    flat = `${flat.slice(0, FEEDBACK_ANSWER_MAX_CHARS).trimEnd()}\n${FEEDBACK_ANSWER_TRUNCATION_MARKER}`;
  }
  return flat;
}

/**
 * The trust decision for GitHub issue comments (the `comments` array of
 * `gh issue view --json comments`). A comment is accepted only when its authorAssociation is in
 * FEEDBACK_ANSWER_TRUSTED_ASSOCIATIONS, it is not minimized, it has a usable createdAt, and its
 * body parses under parseFeedbackAnswerComment(). The newest accepted comment by createdAt wins
 * (a tie goes to the later array position).
 *
 * @returns {{total: number, ignored: number, accepted: null|{login: string, createdAt: string, date: string, parsed: object}}}
 */
function pickFeedbackAnswerComment(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let best = null;
  let bestTime = -Infinity;
  let accepted = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (!FEEDBACK_ANSWER_TRUSTED_ASSOCIATIONS.includes(c.authorAssociation)) continue;
    if (c.isMinimized !== false) continue; // fail closed: an absent or null state is not 'visible'
    if (typeof c.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c.createdAt)) continue;
    const time = Date.parse(c.createdAt);
    if (Number.isNaN(time)) continue;
    const parsed = parseFeedbackAnswerComment(c.body);
    if (!parsed) continue;
    accepted++;
    if (time >= bestTime) {
      bestTime = time;
      const login = c.author && typeof c.author.login === 'string' ? c.author.login : '';
      best = { login, createdAt: c.createdAt, date: c.createdAt.slice(0, 10), parsed };
    }
  }
  return { total: list.length, ignored: list.length - accepted, accepted: best };
}

/** Replace (or append) the `## Answer` section of raw item text; every other byte is kept. */
function writeAnswerSection(text, note) {
  const lines = text.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    if (start === -1) {
      if (/^##\s+Answer\s*$/.test(lines[i])) start = i;
    } else if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = String(note).replace(/^\n+/, '').trimEnd();
  if (start === -1) return `${text.trimEnd()}\n\n## Answer\n\n${body}\n`;
  lines.splice(start, end - start, '## Answer', '', body, '');
  return lines.join('\n');
}

/** Blank a header bullet that carries a value, leaving the bare bullet the template uses. */
function clearFeedbackField(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*-\\s+\\*\\*${escaped}:\\*\\*)[ \\t]*\\S.*$`, 'm');
  const firstH2 = text.search(/^##\s/m);
  const head = firstH2 === -1 ? text : text.slice(0, firstH2);
  const rest = firstH2 === -1 ? '' : text.slice(firstH2);
  return head.replace(re, '$1') + rest;
}

/**
 * Resolve the GitHub slug feedback goes to: explicit `--repo` value, else the
 * MAVERICKS_FEEDBACK_REPO env var, else MAVERICKS_FEEDBACK_REPO_DEFAULT. Throws
 * when the chosen value is not a plain owner/repo slug.
 */
function resolveFeedbackRepo(explicit) {
  const raw = [explicit, process.env.MAVERICKS_FEEDBACK_REPO, MAVERICKS_FEEDBACK_REPO_DEFAULT].find(
    (v) => typeof v === 'string' && v.trim() !== ''
  );
  const slug = raw.trim();
  if (!FEEDBACK_REPO_SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid GitHub repository "${slug}" (expected owner/repo)`);
  }
  return slug;
}

// Outbound-only categories, additional to the publish scanner's set (that scanner's own
// categories are deliberately unchanged): absolute home paths of other operating systems.
// Built from parts so no contiguous home-path literal sits in this file.
const OUTBOUND_EXTRA_CATEGORIES = [
  {
    name: 'Absolute /home/ path',
    regexes: [() => new RegExp('(?<![A-Za-z0-9_.-])/' + 'home/[A-Za-z0-9._-]+(?![A-Za-z0-9._-])', 'g')],
  },
  {
    name: 'Absolute Windows user path',
    regexes: [() => new RegExp('(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]+' + 'Users[\\\\/]+[^\\\\/\\s"\'`<>|]+', 'gi')],
  },
];

/** The project root the feedback/intake commands operate on (the adopter's project, or the framework repo itself). */
function outboundProjectRoot(projectRoot) {
  return projectRoot || process.env.MAVERICKS_PROJECT_ROOT || ROOT;
}

/**
 * The private-name list the outbound scan checks: the union of the project's
 * `<root>/.mavp/private-names`, the framework install's `.mavp/private-names` and the
 * MAVP_PRIVATE_NAMES environment variable. Throws when any source holds an unusable
 * entry (callers fail closed). Returns `{names, projectFile}`; `projectFile` is the
 * path the project list was looked up at.
 */
function resolveOutboundPrivateNames(projectRoot) {
  const { parsePrivateNamesList } = require('./mavp-publish-scan.js');
  const { readNamesFileRaw } = require('./mavp-private-names-guard.js');
  const projectFile = path.join(outboundProjectRoot(projectRoot), '.mavp', 'private-names');
  let projectRaw = null;
  try {
    projectRaw = fs.readFileSync(projectFile, 'utf8').trim();
  } catch { /* absent: not an error */ }
  const names = [];
  const seen = new Set();
  for (const raw of [projectRaw, readNamesFileRaw(), process.env.MAVP_PRIVATE_NAMES]) {
    for (const name of parsePrivateNamesList(raw)) {
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
  }
  return { names, projectFile };
}

/** The one-line notice printed when no private-name source holds a name, else null. */
function outboundPrivateNamesNote(projectRoot) {
  const { names, projectFile } = resolveOutboundPrivateNames(projectRoot);
  if (names.length > 0) return null;
  return `NOTE: private-name detection inactive — no names in ${projectFile}, the framework's .mavp/private-names, or MAVP_PRIVATE_NAMES`;
}

/**
 * Scan text that is about to leave the machine, through the publish scanner's
 * exact category set (base categories plus the runtime private-name list, here the
 * union from resolveOutboundPrivateNames) and the outbound-only home-path categories.
 * Returns findings `{category, line, part}` with part 'title' or 'body' and
 * 1-based line numbers within that part; the matched text is never returned.
 * Throws when the category set cannot be built, so callers fail closed.
 */
function scanOutboundText(title, body, projectRoot) {
  const { buildCategories, scanTextAgainstCategories } = require('./mavp-publish-scan.js');
  const categories = buildCategories(resolveOutboundPrivateNames(projectRoot).names).concat(OUTBOUND_EXTRA_CATEGORIES);
  const findings = [];
  const scanPart = (part, text) => {
    const raw = [];
    String(text === undefined || text === null ? '' : text)
      .split(/\r\n|\r|\n/)
      .forEach((line, idx) => scanTextAgainstCategories(part, idx + 1, line, raw, categories));
    for (const f of raw) findings.push({ category: f.category, line: f.line, part });
  };
  scanPart('title', title);
  scanPart('body', body);
  return findings;
}

/** Printable form of scanOutboundText findings: `[<category>] line <n>` per finding. */
function formatOutboundFindings(findings) {
  return findings.map((f) => `[${f.category}] line ${f.line}${f.part === 'title' ? ' (title)' : ''}`);
}

/**
 * Mirror of the --close-wave agent-path rule: `--operator-confirmed "<statement>"`
 * with a non-empty value, else exit 1. Returns the statement. A value that looks
 * like another flag reads as empty.
 */
function requireOperatorConfirmation(argv, commandName) {
  const list = Array.isArray(argv) ? argv : [];
  const i = list.indexOf('--operator-confirmed');
  const next = i === -1 ? undefined : list[i + 1];
  const statement = next !== undefined && !String(next).startsWith('--') ? String(next).trim() : '';
  if (statement === '') {
    console.error(
      `${commandName} posts to a public GitHub repository and needs operator confirmation. ` +
        'Pass --operator-confirmed "<the operator\'s exact statement from this session>" — the value must be the operator\'s ' +
        'exact in-session statement authorizing this post, never inferred from context, a prior session, or an agent paraphrase.'
    );
    process.exit(1);
  }
  return statement;
}

/** Run `gh` with an argument vector and no shell. Returns stdout; throws on a non-zero exit or a missing gh. */
function runGh(args) {
  return cp.execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Returns a refusal string when gh is missing or unauthenticated, else null. */
function ghPreflightRefusal() {
  try {
    runGh(['auth', 'status']);
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'the GitHub CLI (gh) is not installed or not on PATH';
    return 'the GitHub CLI (gh) is not authenticated — run `gh auth login` first';
  }
}

/** Write text to a private temp file (0600 inside a 0700 dir), run fn(file), always remove it. */
function withOutboundBodyFile(text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavp-feedback-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Issue number from `gh issue create` output (the issue URL), or null. */
function parseIssueNumberFromGhOutput(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\/issues\/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Issue title for a feedback item: `[mavp-feedback] <id>: <title>` on one line. */
function composeFeedbackIssueTitle(id, title) {
  return `${FEEDBACK_ISSUE_TITLE_PREFIX} ${id}: ${String(title || '').replace(/\s+/g, ' ').trim()}`;
}

/** Parse an item's Issue field (`<slug>#N`); null when absent or malformed. */
function parseFeedbackIssueRef(value) {
  const m = String(value || '').trim().match(/^(\S+)#(\d+)$/);
  if (!m || !FEEDBACK_REPO_SLUG_PATTERN.test(m[1])) return null;
  return { slug: m[1], number: Number(m[2]) };
}

/** One-line, control-character-free, length-capped form of untrusted text for terminal output. */
function sanitizeForTerminal(text, max) {
  const limit = max || 120;
  const flat = String(text === undefined || text === null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

module.exports = {
  ROOT,
  computeShipsIn,
  countIntakeUntriaged,
  countUnackedFeedbackAnswers,
  FEEDBACK_ADOPTER_FIELDS,
  FEEDBACK_ANSWER_COMMENT_MAX_CHARS,
  FEEDBACK_ANSWER_MAX_CHARS,
  FEEDBACK_ANSWER_TRUSTED_ASSOCIATIONS,
  FEEDBACK_DISPOSITION_DUPLICATE_PATTERN,
  FEEDBACK_DISPOSITION_FIXED_PATTERN,
  FEEDBACK_DISPOSITION_GRAMMAR,
  FEEDBACK_DISPOSITION_PLAIN_VALUES,
  clearFeedbackField,
  isValidFeedbackDisposition,
  parseFeedbackAnswerComment,
  pickFeedbackAnswerComment,
  sanitizeFeedbackAnswerText,
  writeAnswerSection,
  FEEDBACK_GITHUB_LABEL,
  FEEDBACK_ISSUE_TITLE_PREFIX,
  FEEDBACK_ITEM_ID_PATTERN,
  FEEDBACK_REPO_SLUG_PATTERN,
  MAVERICKS_FEEDBACK_REPO_DEFAULT,
  composeFeedbackIssueTitle,
  formatOutboundFindings,
  ghPreflightRefusal,
  parseFeedbackIssueRef,
  parseIssueNumberFromGhOutput,
  requireOperatorConfirmation,
  resolveFeedbackRepo,
  runGh,
  sanitizeForTerminal,
  scanOutboundText,
  outboundPrivateNamesNote,
  resolveOutboundPrivateNames,
  withOutboundBodyFile,
  semverCompare,
  FEEDBACK_ALIAS_PATTERN,
  FEEDBACK_NOTE_PATTERN,
  FEEDBACK_DRAFT_FILE_PATTERN,
  parseFeedbackNotes,
  resolveFeedbackDraftsDir,
  listFeedbackDrafts,
  formatFeedbackDraftLine,
  FEEDBACK_CHANNELS,
  FEEDBACK_FIELD_ORDER,
  FEEDBACK_KINDS,
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_SECTION_ORDER,
  FEEDBACK_SEVERITIES,
  allocateFeedbackItemId,
  listIntakeItems,
  matchMarkdownHeading,
  parseFeedbackItem,
  renderFeedbackItem,
  resolveIntakeDir,
  setFeedbackField,
  WORKAROUND_TAG_PATTERN,
  classifyFeedbackItem,
  computeRetirableWorkarounds,
  parseChangelogSupersedes,
  resolveHarnessMemoryDir,
  ackRecheck,
  appendRecheckEntry,
  addDays,
  archiveActiveWaveInBacklog,
  ARCHIVABLE_TERMINAL_STATUSES,
  archiveMergedTasksFromActiveWave,
  ARCHITECT_GATE_ADVISORY,
  armRecheck,
  buildContextBundle,
  buildDeployQueue,
  buildOptimizerPrompt,
  buildReachableHashIndex,
  buildTaskStatusEntry,
  checkNeverAProjectRoot,
  classifyNextAction,
  ACTION_TARGET_FOLLOWER_NOUNS,
  classifyWorktrees,
  clip,
  collectAlwaysLoadedContext,
  collectOperatorData,
  computeDueRechecks,
  computeMustRead,
  MUST_READ_EXCLUDED_PATHS,
  MUST_READ_EXCLUDED_PREFIXES,
  MUST_READ_DEFAULT_MAX_CHARS,
  HOOK_NAMES,
  CLAUDE_DIRS,
  SYNC_SCRIPTS,
  PROJECT_FILES,
  BASH_FILE,
  FRAMEWORK_MARKER_PATH,
  isFrameworkSourceTree,
  isInstallerManagedPath,
  partitionInstallerManaged,
  splitMustReadOversized,
  DEFERRED_TASK_STATUS_HEADING,
  detectPermissionModeConflict,
  guardMutatingRoot,
  guardReportingWrite,
  describeNeverProjectDiscriminator,
  NEVER_PROJECT_ROOT_OVERRIDE_ENV,
  NEVER_PROJECT_VERSION_PLACEHOLDER,
  ensureSectionHeading,
  extractBlockField,
  extractCommitHashesFromEvidence,
  extractHeadingIds,
  extractTrajectories,
  FAILURE_CONTRAST_FLOOR,
  findAnnotatedFieldVariant,
  findPreviousCloseSessionCommit,
  findTaskBlockById,
  formatIsoTime,
  formatWorktreeHygieneAdvisory,
  formatWorktreePruneSuggestion,
  generateProcessStateMd,
  getCommitHashesReachable,
  getCommitHashesReachableFromHead,
  readFileAtRevision,
  getDeployPendingForRepo,
  getFilesChangedSincePreviousCloseSession,
  getNextTaskId,
  getPatchEquivalenceStatus,
  getWorktreeDirectoryMtimeMs,
  headingLeadingTaskId,
  IN_FLIGHT_STATUSES,
  insertIntoActiveTasks,
  insertIntoActiveWave,
  isBlockedByEmpty,
  isHashReachable,
  isHoldEmpty,
  isInsideGitRepo,
  isSelfHostedRoot,
  isShallowRepository,
  isTaskHeadingFor,
  isValidHashFormat,
  isWorktreeDirty,
  gitWorktreeToplevel,
  listGitWorktrees,
  locateTaskBlock,
  lookupTaskTitle,
  mergeCommitEvidence,
  MODULE_META_HEADINGS,
  moveActiveBlocksToParkedSection,
  moveParkedBlocksToActiveSection,
  moveTaskBlockToSection,
  normalizeWhitespace,
  parkedBacklogHeading,
  parkedTaskStatusHeading,
  parseActiveWaveMergedTitles,
  parseAllTaskBlocks,
  parseBlockedBy,
  parseHold,
  parseIntervalDays,
  parseMidWaveArchivedTasks,
  parseModuleRegistry,
  parseModuleRegistryFromText,
  parseOptimizerResponse,
  parseRepoMap,
  parseTaskHolds,
  parseTasksWithRepo,
  normalizeDeployField,
  isDeployOptOut,
  parseTouchesConflicts,
  parseWaveTasks,
  printRepoIdentityHeader,
  pruneStaleActiveSlices,
  readPermissionMode,
  readPersistedPermissionMode,
  readUserGlobalPermissionMode,
  readTaskField,
  relativeTime,
  renameTask,
  renderConflictCheckChecklist,
  renderFailureContrastDisclosure,
  renderThinSnapshot,
  readUtf8,
  REPO_META_HEADINGS,
  resolveCommitHash,
  resolveContextBundlePath,
  resolveModuleRegistryPath,
  resolvePermissionMode,
  resolveRepoMapPath,
  resolveTaskOrigin,
  safeRealpath,
  scoreTrajectory,
  setBlockField,
  shortenSessionKey,
  splitTrajectoriesForReflect,
  summarizeTrajectories,
  summarizeWorktreeClassification,
  TERMINAL_SKIP_STATUSES,
  todayIso,
  recheckRef,
  truncateTaskBlockAtLevel2Heading,
  UnresolvableMainRefError,
  updateLastTaskId,
  updateTaskField,
  validateUntil,
  WORKTREE_PRUNE_MTIME_THRESHOLD_MS,
  writeContextBundle,
  writeTrajectories,
  writeUtf8,
};
