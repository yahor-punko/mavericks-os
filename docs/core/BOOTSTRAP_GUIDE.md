# Bootstrap guide

How to set up a new project with Mavericks.

## Step 1 — Run the installer

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" /path/to/your-project
```

This creates:
- `scripts/mavp-operator` — bash wrapper delegating to mavericks
- `scripts/mavp-operator-agent.js` — project-specific session summary
- `scripts/mavp-operator-close-session.js` — end-of-session ritual
- `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` — from templates
- `PROCESS_STATE.json` — machine-readable state

### Where the installer looks for mavericks

The generated adopter wrapper (`buildBashWrapper()` in `mavp-install.js`) resolves the mavericks install location in this order (T-736):

1. **Explicit `MAVERICKS_HOME` env var** — always wins if set, unconditionally.
2. **The install-time hint** — the framework directory the wrapper was actually generated from, baked in at install time and used only when it still probes framework-shaped (a `scripts/mavp-validator.js` file exists under it — the same project-local probe idiom the managed hook command templates already use). A wrapper installed from a non-standard framework location now follows its own source, instead of falling through to the two fixed locations below.
3. **`$HOME/.mavericks`** — the canonical default location, used if that directory exists. This is where the public installer (`install.sh`) clones mavericks.
4. **`$HOME/Documents/mavericks`** — legacy fallback, used only if none of the above resolves.

A single terminal existence check runs after this chain, covering all four branches (including the env override): if the resolved path still doesn't exist, the wrapper prints every candidate it tried plus the `MAVERICKS_HOME` remedy to stderr and exits 1 — instead of deferring to node's own module-loader stack trace under `set -euo pipefail`.

The hardened `PostToolUse`/`SessionStart` hook command templates (`buildPostToolUseHookCommand()`, `buildTranscriptArchiveHookCommand()`) still resolve independently via their own project-local-first chain (self-hosting check, then `MAVERICKS_HOME` > `~/.mavericks` > `~/Documents/mavericks`, with no install-time hint and no terminal refusal) — that gap is tracked separately as debt, not covered by this change.

**Maintainer caveat:** a wrapper generated for one project now follows the framework directory it was actually installed from, so a `~/.mavericks` directory present on the same machine no longer silently shadows a different checkout the wrapper was built against — the install-time hint (step 2) resolves before the fixed `~/.mavericks` location (step 3) ever runs. The caveat now only applies when an operator invokes framework scripts directly (not through a generated wrapper) or edits `MAVERICKS_HOME` by hand: with `MAVERICKS_HOME` unset in that direct-invocation shape, `~/.mavericks` (step 3) can still resolve ahead of a `~/Documents/mavericks` framework-developer checkout (step 4). Framework developers should set `MAVERICKS_HOME` explicitly in their shell profile to avoid running against the wrong checkout in that shape.

### Behind-upstream source guard

The resolved framework source above (wherever `mavp-install.js` itself lives — `MAVERICKS_HOME` > `~/.mavericks` > legacy) may itself be a git clone that has fallen behind its own upstream — e.g. a `~/.mavericks` checkout that was never `git pull`ed after a newer release shipped. Installing from a behind-upstream source silently syncs stale framework files and stamps a stale `mavericks_version`, which is exactly the failure mode this guard closes.

Before any file write, the installer does a best-effort `git fetch` (hard 4-second timeout — never hangs) against the source, then checks `git rev-list --count HEAD..@{upstream}`:

- **Confirmed behind (count > 0):** prints a prominent warning naming the exact commit count and the remediation command (`git -C <sourceRoot> pull`), then:
  - **Fresh install, `--update`, `--hooks-only`:** exits 1 before any file is written, unless `--stale-source-ok` is passed to proceed anyway. This behavior is identical in TTY and non-TTY sessions — it is a deterministic gate, not an interactive confirm.
  - **`--check`:** prints the same warning but always continues (read-only reporting mode).
  - **`--strip`:** skips the guard entirely — strip only removes files, it never syncs from the source.
- **Everything else — silent no-op, no warning, no exit-code change:** the source is not a git work tree, has no upstream / is on a detached HEAD, the fetch fails (offline/timeout — falls through to `rev-list` against the last-known tracking ref), or the count comes back `0` or unparseable.

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" /path/to/your-project --stale-source-ok
```

This first install is a one-time human-run command: an agent session opened before Mavericks is installed may lack shell/edit permission entirely, since the permissive default (`bypassPermissions`) is created *by* this install and can't exist before it runs.

### Adopter boundary — never edit the resolved framework source

The framework source resolved above is shared machine-wide: every project that resolves to it runs whatever is in it. From an adopter session, treat that directory as **read-only** — not its docs, not its `.claude/` role specs or rules, not its gate ledger, not its rechecks or any other framework-side state. When adopter work suggests a framework change, accumulate the proposals as notes and route them to the framework repo's own architect gate and task lifecycle, where they get decomposed, reviewed and versioned like any other change.

The rationale that makes this stick: from the adopter's viewpoint a framework edit is both invisible and unbounded. It leaves no diff in the adopter's own git history — so the adopter's review, CI and release notes never see it — while taking effect immediately for every other project on the machine, including ones whose operator never agreed to it. A change with machine-wide blast radius and no local audit trail is exactly the change that belongs in the owning repo.

Mechanical coverage is only partial today, and knowing that is part of honouring the boundary. `guardMutatingRoot()` refuses operator ritual commands when the resolved root is the framework clone rather than a real project — e.g. `--integrate` against a `$HOME/.mavericks` root prints `REFUSED: --integrate refuses to run against a never-a-project repo root.` with `matched discriminator: root resolves to $HOME/.mavericks (the adopter-resolved framework-source clone)`. A plain editor write into that same directory is intercepted by nothing, so this boundary is prose-enforced where it matters most.

## Step 2 — Edit PROCESS_STATE.json

Set the initiative name and confirm wave 1:

```json
{
  "initiative": "Your project description",
  "stage": "execution",
  "wave": 1,
  "next_action": null,
  "blocker": null,
  "stage_owner": "main_agent",
  "last_updated": "YYYY-MM-DD"
}
```

## Step 3 — Add your first tasks

Either edit `BACKLOG.md` and `TASK_STATUS.md` manually, or use the interactive tool:

```bash
cd /path/to/your-project
./scripts/mavp-operator --new-task
```

Fill in `docs/ARCHITECTURE.md` — Overview, Services, Deploy contours (mark the rest DRAFT)

## What gets installed

The installer creates or copies (skipping files that already exist):

| What | Where | Source |
|---|---|---|
| `scripts/mavp-operator` | bash wrapper → delegates to mavericks | generated |
| `scripts/mavp-operator-agent.js` | project-specific session summary | mavericks template |
| `scripts/mavp-operator-close-session.js` | end-of-session ritual | mavericks template |
| `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md` | live state artifacts | mavericks templates |
| `PROCESS_STATE.json` | machine-readable state | default |
| `.claude/agents/*.md` | sub-agent definitions (developer, product-docs, technical-writer, qa, ux, frontend-design, …) | copied from mavericks |
| `.claude/skills/*/SKILL.md` | user-invocable skills (session-start, validate, frontend-design, …) | copied from mavericks |
| `.claude/rules/*.md` | Claude Code rules for this project | copied from mavericks |
| `docs/ARCHITECTURE.md` | architecture document template (fill in at project start) | copied from mavericks |
| `.claude/settings.local.json` | seeds `effortLevel: "high"`, `alwaysThinkingEnabled: true`, and `fallbackModel: ["opus"]` (default-ceiling reasoning + opus safety net) | generated |
| `.claude/settings.json` | shared, committed project settings — seeds `permissions.defaultMode: "bypassPermissions"` | generated |
| `.vscode/settings.json` | seeds/merges `files.exclude`, `search.exclude`, `files.watcherExclude` entries for `.claude/worktrees` (see "VS Code worktree exclusion" below) | generated/merged |

Core framework scripts (`mavp-operator-lib.js`, `mavp-operator-dashboard.js`, validator) are **not copied** — they are used directly from the mavericks installation via the bash wrapper.

**Reasoning defaults** — on a fresh install, `.claude/settings.local.json` is seeded with `effortLevel: "high"` and `alwaysThinkingEnabled: true`. This is a **default ceiling for ordinary work, not a floor for everything** — the Main Agent still varies effort per-invocation via `opts.effort`: mechanical slices (boilerplate, well-understood single-file edits, doc-only formatting) drop to `medium`, while heavy or exceptional slices (complex refactors, novel logic, high blast radius) escalate to `xhigh` or `max`. Valid values for the seeded session default are `low`, `medium`, `high`, and `xhigh`. On `--update`, each key is backfilled only if absent — an existing value (e.g. a project that deliberately set `effortLevel: "medium"`) is preserved and never overwritten. To override the seeded default, set your preferred value in `.claude/settings.local.json` before or after running the installer. For the full per-role/per-slice effort-selection policy, see `docs/AGENT_SPEC.md` — "Effort selection".

**Fallback model safety chain** — on a fresh install, `.claude/settings.local.json` is also seeded with `fallbackModel: ["opus"]`. This is a session-level safety net: if the primary session model becomes unavailable, the session falls back to Opus rather than silently degrading to a weaker model. On `--update`, the key is backfilled only if absent, with one fingerprint exception: if the existing chain deep-equals the exact old framework-seeded default `["claude-opus-4-8"]` — a single-element array with that one pinned id — the installer's own historical fingerprint — it is migrated to the alias form `["opus"]` and the migration is announced on stdout (e.g. `fallbackModel migrated: old seeded default claude-opus-4-8 → opus`). Every other chain (a different id, a longer or reordered chain, or an already-current `["opus"]`) is operator-owned and is preserved byte-identical — never overwritten. This setting is independent of, and not a substitute for, the architect model spawn policy (Fable 5 primary, Opus fallback) described in `docs/AGENT_SPEC.md` — that policy governs which model the architect sub-agent is spawned with, while `fallbackModel` governs what the session itself falls back to if its configured model is unavailable. The seeded value is the unversioned `opus` alias rather than a pinned generation id, so it resolves to the latest Opus generation with no future edit required as new generations ship. Note the extended-context caveat: an alias resolves to the standard-context variant, so a session running an extended-context (`[1m]`) model does not retain the extended window when it falls back via this chain.

**Shared permission-mode default** — on a fresh install, the installer creates a committed `.claude/settings.json` with `permissions.defaultMode: "bypassPermissions"`. This is the intended shipped default — a **requested** one, not a guaranteed-honored one: a project-wide setting (checked into version control, unlike `settings.local.json` which is personal and gitignored) so every contributor starts with the same fully-autonomous baseline instead of hitting a per-tool approval prompt during agent-driven work. Claude Code's settings precedence, as documented at time of writing, is: managed settings > CLI flags > `.claude/settings.local.json` (personal) > `.claude/settings.json` (shared) > `~/.claude/settings.json` (user-global) — under this order, a personal `settings.local.json` should always win over the shared default. **This order is a sourced claim, not a verified guarantee**: a 2026-08 observation found a user-global `dontAsk` deciding sessions for roughly three weeks over the committed `bypassPermissions`, with no local override present — the layer this order ranks weakest won. Nothing in this repo's artifacts explains why; the cause is harness-owned and left unresolved on purpose (see DR-010 in `docs/core/DECISIONS.md`). Do not assume this precedence order holds — verify instead via the session-start brief's `permission_mode` field (`./scripts/mavp-operator --agent`), which reports the mode alongside `permission_mode_source` (`hook_payload` | `persisted_runtime` | `settings_file`) and `permission_mode_verified` (`true` only when a same-session harness channel confirmed it; otherwise the framework is reporting a *declared* setting, not a confirmed one). **Factual note on what `bypassPermissions` means**: unlike `acceptEdits` (which only auto-accepts file edits), `bypassPermissions` suppresses the interactive approval prompt for *every* tool call — file edits, Bash commands (including destructive ones), and network access all proceed without a prompt. The single remaining human checkpoint under this mode is the mandatory pre-push results review enforced by `--close-session` (see the **Mandatory pre-push review** convention in the root `CLAUDE.md`) — there is no other approval gate between an agent's actions and their effect. To opt out, set your own `permissions.defaultMode` (e.g. `"default"`, `"plan"`, `"acceptEdits"`, or `"dontAsk"`) in your own `.claude/settings.local.json`; it overrides the committed value without touching the shared file, since `settings.local.json` should win in the precedence order above — confirm it actually did via the `permission_mode` field rather than assuming the order held. On `--update`, `permissions.defaultMode` is migrated as follows: if an existing `.claude/settings.json` has no `defaultMode` key, it is backfilled with `bypassPermissions`; if the existing value is the legacy `acceptEdits` default, it is migrated to `bypassPermissions` (the installer prints a console line noting the migration); any other value a project has deliberately set (`plan`, `default`, `dontAsk`, or an already-current `bypassPermissions`) is left untouched as the project's opt-out and is never overwritten. Existing projects that predate this feature pick it up automatically the next time `--update` is run. **Untracked in the canonical repo (T-529)** — the canonical mavericks repo itself no longer commits its own `.claude/settings.json` (it is gitignored, still present on disk); if a fresh pull ever leaves it missing, reseed it by copying `templates/SETTINGS_TEMPLATE.json` into place or by re-running the installer with `--update`, which backfills the file via the same `permissions.defaultMode` logic described above.

When new agents or skills are added to mavericks, re-run the installer in an existing project to pull them in (only missing files are added, existing files are never overwritten).

**Non-interactive installs and `--yes`** — a fresh install normally asks `Create N file(s)...? [Y/n]` at a real interactive TTY. Two ways to skip that prompt: **no TTY** (run from an agent's Bash tool, piped, or in CI) — the installer detects this automatically, auto-proceeds as if answered `Y`, and prints a one-line `Non-interactive session — creating N file(s)...` notice instead of hanging; or **`--yes` / `-y`** — accepts the default answer even at a real TTY, for scripted or runbook installs. This is safe because a fresh install is additive: it only creates files that don't already exist. `--strip` is the opposite — it is destructive, so it does **not** get this treatment: at a non-TTY it prints the deletion manifest, deletes nothing, and exits 1, and `--yes` has no effect on it (strip always requires a real interactive confirmation — see `scripts/mavp-install.js`'s header comment for the full two-stage confirm flow, and the `--strip` line in the root `CLAUDE.md`).

## Step 4 — Verify setup

```bash
./scripts/mavp-operator --version     # should show the installed mavericks version
./scripts/mavp-operator --agent       # should show initiative + tasks
./scripts/mavp-operator --validate    # should be healthy
```

## Step 5 — Run the first cycle

1. Spawn a developer sub-agent with `.claude/agents/developer.md` as context + the task details
2. Review the output
3. Spawn a QA sub-agent with `.claude/agents/qa.md` as context if verification required
4. Accept → `merged`, or reject → `needs_fix`
5. Update artifacts, run `--close-session` at end of session

**Cross-repo slices** — when a developer agent must write to a target project (not mavericks itself), include `work_dir: [absolute path to target repo]` in the sub-agent brief. Without it, worktree isolation creates the worktree inside the mavericks installation.

## Step 6 — Scale

After one healthy cycle, parallelize narrow independent slices. Keep approval-sensitive and runtime-heavy work with the orchestrator.

## Pre-commit hook

The installer automatically sets up a git pre-commit hook that runs the validator before every commit.

**What it does:**

| Validator exit code | Meaning | Commit behaviour |
|---|---|---|
| `0` — healthy | Artifacts in sync | Silent — commit proceeds |
| `1` — drifting | Minor drift detected | Warning printed, commit proceeds |
| `2` — repair required | Artifacts out of sync | **Commit blocked** with message: `COMMIT BLOCKED: artifact repair required. Run: ./scripts/mavp-operator --validate` |

**How it works:**

The hook lives at `.claude/hooks/pre-commit`. The installer runs:

```bash
git config core.hooksPath .claude/hooks/
```

This points git to the `.claude/hooks/` directory for all hooks in this repo.

**How to disable it** (temporarily or permanently):

```bash
git config --unset core.hooksPath
```

To re-enable:

```bash
git config core.hooksPath .claude/hooks/
```

**Keeping the hook up to date:**

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project
```

This re-copies `.claude/hooks/pre-commit` from the mavericks source along with agents, skills, and rules.

## Close-session commit contract

`--close-session` (`scripts/mavp-operator-close-session.js`, both interactive and non-interactive modes) creates a session commit — `chore: close session <date>` — as part of every close-session run, gated only by the validator's exit code:

| Validator exit code | Meaning | Session commit behaviour |
|---|---|---|
| `0` — healthy | Artifacts in sync | Commit proceeds |
| `1` — drifting | Minor drift / warnings only | Commit still proceeds |
| `2` — repair required | Artifacts out of sync | **Commit skipped** — prints `session commit SKIPPED — validator exit 2 (repair required); commit manually after repair` |

This mirrors the pre-commit hook's own gate (only exit 2 blocks), so the two mechanisms never disagree about what counts as "safe to commit."

**Staging scope.** The commit stages tracked files only, via `git add -u` — it never runs `git add -A` or `git add .`. Any newly-created untracked file is left out of the session commit; if you created new files this session, stage and commit them yourself (or verify they were staged by an earlier, more targeted `git add` during the task itself). This is deliberate: `--close-session` is an end-of-session ritual over already-tracked state artifacts and code, not a catch-all for stray untracked files.

If the commit is skipped (exit 2), fix the reported artifact drift, re-run `--close-session` (or commit manually), then proceed to the wave-close push once the session commit exists.

## Claude Code hooks activation

Separate from the git pre-commit hook above, mavericks manages three Claude Code hooks in `.claude/settings.local.json`: `SessionStart`, `PostCompact`, and `PostToolUse` (the hardened validator hook, composed with the doc-sync and manifest-guard fragments).

**Stderr policy (T-457).** The `PostToolUse` validator hook always exits 0 — it never blocks the Edit/Write tool call. Full validator output is printed to stderr ONLY when the validator itself exits 2 (repair required); when the validator exits 1 (drifting), the hook stays silent at edit time — that advisory is already surfaced by `--agent`, `--snapshot`, `--close-session`, and the pre-commit hook, so it does not need per-edit stderr noise. Silence at edit time therefore means "no repair required" (validator exit 0 or 1), not merely "healthy."

**Default-on activation.** Both a fresh install and `--update` activate all three hooks automatically — no manual JSON editing or template copying required:
- **Fresh install** seeds `.claude/settings.local.json` from scratch with all three hooks already wired in (see "What gets installed" above).
- **`--update`** merges hooks into an existing `.claude/settings.local.json` idempotently (`mergeManagedHooks()` in `scripts/mavp-install.js`): it replaces the command of the installer-managed `PostToolUse` entry with the freshly composed one — picking up new fragments (e.g. doc-sync, manifest-guard) and any validator-filename migrations — appends that entry if none is found, and adds `SessionStart`/`PostCompact` only if they are absent.

**Managed-entry identity and ownership.** The installer recognizes "its" `PostToolUse` entry by matching the command against known identity signals (current/legacy validator filename, the debounce token, or an explicit sentinel prefix every composed command carries). Any hook entry that does **not** match — for example, a custom Bash-matcher entry an operator wrote by hand — is left byte-identical, in its original position, on every `--update`. **Rule of thumb: never hand-edit the installer-managed `PostToolUse` entry** — its `command` is overwritten on the next `--update`. If you need additional behavior, add it as a **separate** `PostToolUse` hook entry; the installer only ever touches the one entry it recognizes as its own.

**Legacy `--validate` seed migration (T-488).** Projects bootstrapped before T-304 (commit `ca43986`) carry a naive PostToolUse hook the installer itself seeded at the time: a bare `cd <project> && ./scripts/mavp-operator --validate 2>&1`, with no file-path filter (fires on every Edit/Write of any file), no debounce, and no exit-code normalization — the validator's own exit code becomes the hook's exit code, and `2>&1` folds stderr into stdout. On a repo latched at validator exit 2, that combination reports a failed hook with "No stderr output" on literally every single edit. `isManagedPostToolUseCommand` now recognizes this exact historical fingerprint (matched by a fully-anchored regex that wildcards only the `cd <path>` segment — every other byte must match exactly) and `--update`/`--hooks-only` replace it with the current hardened managed command, same as any other managed-entry refresh. If a project happens to carry BOTH the legacy seed and a current managed entry as two separate `PostToolUse` array entries, `--update` collapses them into the single surviving managed entry rather than leaving both. The managed-entry ownership rule above is unchanged by this migration: an operator-authored hook that merely mentions `--validate` in a different shape (extra flags, different redirect, extra piping/commands) does not match the fingerprint and survives byte-identical. **The wildcarded `<path>` segment is restricted to a path-shaped character class, not a bare `.+`** — a security review round found that an open-ended `.+` let regex backtracking absorb an operator's own chained command placed between `cd <path>` and the fixed tail (e.g. `cd X && npm test && ./scripts/mavp-operator --validate 2>&1` falsely matched and would have had that `npm test` step silently destroyed on the next `--update`). The class excludes every shell metacharacter that can start a new statement or substitution — `&`, `|`, `;`, backtick, `$`, `(`, `)`, `<`, `>`, quotes, and newline — so a genuine chained command, a `;`-separated pre-step, or a `$()`/backtick subshell anywhere in the string breaks the match instead of being silently absorbed.

**Opt-out: `--no-hooks`.** Pass `--no-hooks` to `--update` to skip the hooks merge for that run — everything else `--update` does still runs:

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project --no-hooks
```

**Narrow activation: `--hooks-only`.** Pass `--hooks-only <target-dir>` to sync ONLY the managed hooks (`PostToolUse` validator hook, `SessionStart`, `PostCompact`) into `.claude/settings.local.json`, plus the `.mavp-hook-ts` gitignore entry — no wrapper, no `.claude/{agents,skills,rules}` copy, no project-specific script sync:

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --hooks-only /path/to/your-project
```

Use this when a project already has its wrapper/agents/rules in place and only the hooks need activating or refreshing — this is the recommended command for the canonical self-activation case below.

**Canonical self-activation step.** `.claude/settings.local.json` is personal and gitignored, so it is never populated by cloning mavericks itself. To activate hooks locally on a mavericks checkout, run the installer's `--hooks-only` mode against the framework root:

```bash
cd "$HOME/.mavericks"   # or wherever your mavericks checkout lives
node scripts/mavp-install.js --hooks-only .
```

This is the recommended, narrowest command: it touches only `.claude/settings.local.json` (gitignored) and the `.mavp-hook-ts` gitignore entry, producing **no repo diff**, and turns on the hardened validator hook plus the doc-sync and manifest-guard fragments locally. Run it once after cloning, and again any time you want to pick up new fragment additions.

Running the broader `node scripts/mavp-install.js --update .` against the framework root is **also safe** (self-install detection makes `--update` skip the wrapper/`.claude/{agents,skills,rules}` sync when the target IS the mavericks framework's own root — see the installer's header comment and DR-003 in `docs/core/DECISIONS.md`), but it does more work than needed for hook activation alone; `--hooks-only` is the recommended command.

## VS Code worktree exclusion

Field report 2026-08-02: the harness creates a `.claude/worktrees/agent-*` checkout per background sub-agent and never removes it. Left unexcluded, these accumulate (71 at the time of the report, well over 100 since) and VS Code's file explorer, search index, and file watcher all surface the pile — the operator has repeatedly misdiagnosed real repository state as a result, down to asking why ~10K lines of changes were queued.

**Default-on, additive, idempotent.** Both a fresh install and `--update` merge three keys into the target project's `.vscode/settings.json` (`mergeVscodeWorktreeExclusions()` in `scripts/mavp-install.js`, following the same merge contract as `mergeManagedHooks()` above): `files.exclude`, `search.exclude`, and `files.watcherExclude`, each carrying a `.claude/worktrees` glob set to `true`. Only the single managed glob sub-entry is ever added under each key — any other key, and any other sub-entry already present under a managed key, survives byte-identical. A pre-existing conflicting value for the managed glob sub-entry (anything other than `true`) is left untouched, with a printed notice rather than a silent overwrite. A second run makes no further change.

**What is and isn't covered.** `files.exclude`/`search.exclude` hide `.claude/worktrees` from the file explorer and search results; `files.watcherExclude` stops VS Code from deep-watching its contents for changes. Based on documented VS Code configuration semantics — not confirmed against a live VS Code session, since driving a GUI is outside what an agent can execute — the git extension's own nested-repository auto-detection scan is understood to reuse the same `files.exclude`-driven skip logic, so these three keys are expected to also address the SCM phantom-diff symptom from the field report, not just the explorer/search/watcher noise. If that assumption doesn't hold in practice, the fallback lever is `git.autoRepositoryDetection: "openEditors"` (scope nested-repo detection to open-editor files only) — not `git.openRepositoryInParentFolders` (see below), which governs the opposite direction (parent-folder discovery) and would not have addressed a subfolder case like `.claude/worktrees` regardless of the collateral concern.

**Deliberately not seeded: `git.openRepositoryInParentFolders`.** This setting is repo-global (affects every parent-folder repo the workspace might sit inside, not just this one) with legitimate-use collateral, and — independently of that — it is the wrong lever for this specific problem: it governs whether VS Code opens a repo found in a PARENT folder of the workspace, not whether it opens nested repos found in a SUBFOLDER, which is what `.claude/worktrees/agent-*` checkouts are. If you want to suppress it project-wide anyway, add it manually to your own `.vscode/settings.json`:

```json
{
  "git.openRepositoryInParentFolders": "never"
}
```

## Transcript archive

A DR's optional `Session:` field (see `docs/core/DECISIONS.md` — "Optional lineage fields") records the Claude Code session id a decision was deliberated in, so the deliberation can later be traced back to its full transcript. But Claude Code stores that transcript as a plain `.jsonl` file at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (`<cwd-slug>` is the project's absolute path with every `/` replaced by `-`) and deletes it after `cleanupPeriodDays` — 30 days by default — so an unqualified session id is provenance that self-destructs almost exactly when someone goes looking for it.

**`--transcript-archive` — opt-in, off by default.** Pass this flag to a fresh install, `--update`, or `--hooks-only` to activate a managed `SessionStart` hook that sweeps every transcript for the current project out of Claude's local storage into `<project>/.mavp/transcripts/<session-id>.jsonl` (`scripts/mavp-transcript-archive.js`) on every session start:

```bash
node scripts/mavp-install.js /path/to/your-project --transcript-archive        # fresh install
node scripts/mavp-install.js --update /path/to/your-project --transcript-archive     # existing project
node scripts/mavp-install.js --hooks-only /path/to/your-project --transcript-archive # narrow activation
```

Installing without the flag adds no such hook. Once activated, the entry is preserved and its command refreshed by every later `--update` — with or without the flag — so a project that opted in is never silently opted back out by a plain sync.

**Privacy — opt-in, gitignored, local-disk only.** A session transcript is the full raw conversation, not just the deliberation that ended up in the DR. The installer adds `.mavp/transcripts/` to the target project's `.gitignore` the moment this hook is activated, so archived transcripts are never git-tracked and never pushed anywhere. This is why the mechanism is opt-in rather than default-on: enabling it is a deliberate choice to retain that content locally for provenance purposes.

**Crash coverage.** Because the sweep runs on every `SessionStart` (not just at the end of a session), it also picks up transcripts from prior sessions that crashed, were force-quit, or were left open across a compaction — anything still sitting in Claude's storage gets archived before the ~30-day cleanup can remove it, not just the session that happens to be ending cleanly.

**Retention — opt-in, default unlimited.** By default the archive still grows unbounded — each sweep only ever adds files, it never deletes an archived transcript, even one whose source has since been cleaned up by Claude Code. Set the `MAVP_TRANSCRIPT_RETENTION_DAYS` environment variable to a positive number of days to bound it: every sweep run then also deletes any archived `.jsonl` file whose mtime is older than that many days.

```bash
export MAVP_TRANSCRIPT_RETENTION_DAYS=90   # prune archived transcripts older than 90 days
```

Leaving the variable unset (or setting it to `0`, a negative number, or a non-numeric value) keeps the default unlimited behavior — nothing is ever deleted. Pruning only ever touches archived copies under `<project>/.mavp/transcripts/`; it never touches the live source transcripts in Claude's own storage directory (`~/.claude/projects/<cwd-slug>/`).

**Disabling.** Remove the managed `SessionStart` entry from `.claude/settings.local.json` by hand — it's identifiable by the `: mavp-transcript-archive-hook;` sentinel prefix or by the `mavp-transcript-archive.js` filename in its command. A later `--update` run without `--transcript-archive` will not re-add it.

**Don't want the hook at all? Use Claude Code's own setting instead.** If you'd rather not add any mavericks-managed hook, Claude Code's `cleanupPeriodDays` user setting controls how long it keeps local transcripts before deleting them — raising it (or disabling cleanup) extends the natural window a `Session:` id stays resolvable, with no extra moving parts, at the cost of transcripts piling up in Claude's own storage location rather than the project.

## Deploy CI: skipping framework-only commits

When the framework is synced into an adopting project, the commit touches only framework-owned artifacts — no deployable application code. If your CI pipeline deploys on branch push, these framework-sync commits will trigger the full pipeline (e.g. terraform plan/apply) unnecessarily.

### What the installer provides

On both fresh bootstrap and `--update`, the installer emits a ready-to-use fragment at:

```
templates/deploy-ci-paths-ignore.fragment.yml
```

This file contains a `paths-ignore` list covering every framework-owned path:

```yaml
paths-ignore:
  - 'BACKLOG.md'
  - 'TASK_STATUS.md'
  - 'PROCESS_STATE.md'
  - 'PROCESS_STATE.json'
  - 'EXECUTION_LOG.md'
  - '.claude/**'
  - '.mavp/**'
  - 'SKILL_PROPOSALS/**'
  - 'scripts/mavp-operator'
  - 'scripts/mavp-operator-agent.js'
  - 'scripts/mavp-operator-close-session.js'
```

### How to wire it in

Open your deploy workflow (e.g. `.github/workflows/deploy.yml`) and add the `paths-ignore` block to the relevant `push:` or `pull_request:` trigger:

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - 'BACKLOG.md'
      - 'TASK_STATUS.md'
      - 'PROCESS_STATE.md'
      - 'PROCESS_STATE.json'
      - 'EXECUTION_LOG.md'
      - '.claude/**'
      - '.mavp/**'
      - 'SKILL_PROPOSALS/**'
      - 'scripts/mavp-operator'
      - 'scripts/mavp-operator-agent.js'
      - 'scripts/mavp-operator-close-session.js'
```

> **Important:** Do not add `paths-ignore` to jobs triggered by `workflow_dispatch` or `schedule` — those triggers ignore path filters entirely. Apply only to `push` and `pull_request` triggers.

The installer never edits your workflow file automatically — this is intentional to avoid clobbering custom CI configurations.

### Two-commit verification

After wiring in the `paths-ignore` block, verify it works correctly with two commits:

1. **Framework-only commit** — make a change to any path in the `paths-ignore` list (e.g. update `BACKLOG.md`). Push and confirm that the deploy CI workflow is **skipped** (GitHub shows "skipped" rather than "queued" or "running").

2. **Deployable-code commit** — make a change to a path NOT in the list (e.g. `src/index.ts` or `terraform/main.tf`). Push and confirm the deploy CI workflow **runs normally**.

To check coverage locally before pushing:

```bash
# Simulate a framework-only change set
git diff --name-only HEAD~1 HEAD

# All changed paths should match patterns in the fragment.
# If any changed path is NOT in the list, CI will still run — which is correct.
```

### Keeping the fragment up to date

If new framework-owned paths are added in a future mavericks release, re-run the installer with `--update`:

```bash
node "$HOME/.mavericks/scripts/mavp-install.js" --update /path/to/your-project
```

This emits a fresh fragment only if one does not already exist. To pull in path additions to an existing file, compare your wired `paths-ignore` list against the latest `templates/deploy-ci-paths-ignore.fragment.yml` manually.

> **v1 scope:** This fragment covers GitHub Actions only. GitLab CI / CircleCI support is tracked separately.

## Common failure modes

| Symptom | Cause |
|---|---|
| Sub-agent output is vague or oversized | Task slice was too wide |
| `qa_passed` with no evidence | QA not actually checked |
| Artifacts out of sync | Forgot to mirror BACKLOG ↔ TASK_STATUS |
| New session can't resume | PROCESS_STATE.json not updated at session end (`--close-session` regenerates PROCESS_STATE.md automatically) |
| Wave never closes | `--close-session` not run, no git push |
