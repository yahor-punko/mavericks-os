# Operator commands — full contract per flag

This is the on-demand reference for `./scripts/mavp-operator` and the two node entry points. `CLAUDE.md` keeps only a compact flag-purpose index in its "Operational commands" section; the full contract of each command lives here, one level-3 heading per command.

- **Pull one section** — grep for its heading and read just that block, for example `grep -n -A 12 '^### --close-wave' docs/core/OPERATOR_COMMANDS.md`, then read from the printed line number to the next `### ` heading. Do not load the whole file.
- **Short list** — `./scripts/mavp-operator --help` prints every flag with a one-line description and its usage line.
- **History** — the previous one-line-per-flag form is archived verbatim in `docs/archive/CLAUDE/2026-11-14-operational-commands.md`.

Validator exit codes: `0` = healthy, `1` = drifting, `2` = repair required.

### ./scripts/mavp-operator

```bash
./scripts/mavp-operator
```

- Operator dashboard.
- See `docs/core/OPERATOR_DASHBOARD.md` for the panel reference.

### --agent

```bash
./scripts/mavp-operator --agent [--brief]
```

- Prints the session context as one JSON object (stage, wave, permission mode and its provenance, active and planned tasks, `next_action`, `blocker`, the must-read set and the additive counters) for the Main Agent; additive fields only, so the schema stays stable.
- `--brief` (T-888) runs the same collection with the same side effects (the `PROCESS_STATE.md` regeneration and the `.mavp/permission-mode` record, skipped in a never-a-project root) and prints the operator-facing session brief text instead of JSON, rendered by `renderSessionBrief()` in `scripts/mavp-operator-lib.js`: each line appears only when its field is present, and the first-run goal prompt appears when `ONBOARDING.md` is still present and `next_action` is null. The `session-start` skill embeds this invocation; run `--agent` without `--brief` when you need the full JSON.
- Both the canonical wrapper and the installer-generated adopter wrapper pass `--brief` through to `mavp-operator-agent.js`, and `--help` on either lists it.

### --watch

```bash
./scripts/mavp-operator --watch
```

- Dashboard watch mode (r/s/q).

### --snapshot

```bash
./scripts/mavp-operator --snapshot
```

- Text snapshot for context.

### --close-session

```bash
./scripts/mavp-operator --close-session
```

- End-of-session ritual. Auto-detects mode.
- Interactive (TTY): runs per-task prompts, a wave-goal prompt (only when no goal is set) and a git-push prompt.
- Non-interactive (agent/headless): prints a git-push reminder instead of prompting. When every task is merged it reads `` All tasks merged — run `git push` to publish this session ``.
- It NEVER advances the wave counter (only `--close-wave` does).
- It prints exactly one announcement line in both modes:
  - once Active tasks is empty: `Wave N — all tasks merged; wave stays open until the operator confirms the goal is met and --close-wave runs (goal: <goal, or "not set">)`
  - otherwise: `Wave N stays open — T-NNN still <status>, ...`
- In BOTH modes it first sweeps terminal entries out of TASK_STATUS.md's Active tasks section and reports from what remains.
  - Completed work (merged/deployed_dev/deployed_prod/runtime_verified) moves to "## Recently completed tasks" and is mirrored+archived in BACKLOG.md.
  - `deferred` moves to a "## Deferred tasks" section (created on demand) and `deprecated` to "## Recently completed tasks"; both are TASK_STATUS-only relocations that never touch the task's BACKLOG block.
  - The deferred/deprecated skip set is explicit, so `planned`, `qa_passed`, in-flight and unrecognized statuses all still hold the wave open.
- A structural guard aborts the close (before any BACKLOG.md write, leaving it untouched) if the merge-mirror is ever handed a non-completed record or asked to promote a task whose BACKLOG block currently reads `deferred`/`deprecated`.
  - Adjudicate that BACKLOG/TASK_STATUS disagreement by hand, then re-run.
- It creates the session commit (`chore: close session <date>`) whenever the validator exits 0 (healthy) or 1 (drifting).
  - It stages tracked changes only via `git add -u` (new untracked files are never included).
  - It skips the commit ONLY on validator exit 2 (repair required), printing an explicit "session commit SKIPPED — validator exit 2 ..." line.
  - See docs/core/BOOTSTRAP_GUIDE.md — "Close-session commit contract" for the full behavior.
- In non-interactive mode only, it also prints a propose-only shipped-but-unbooked advisory.
  - It names any `qa_passed` task whose evidence commit is already reachable from HEAD (never `dev_done`/`ready_for_qa`, which would route around QA).
  - It suggests `--set-status <id> merged` without ever writing state itself.
  - It stands down by name (not silently) on a shallow clone.
  - See docs/core/TASK_LIFECYCLE.md "Wave-completion announcements (T-445)".
- Use --interactive to force interactive mode.
- Use --push to auto-push after the session commit on a non-interactive all-tasks-merged close (interactive mode unaffected — it already prompts).
- It prints an `Advisories this close` recap (every advisory or warning that fired this close, or `none`) immediately before `Session closed.` on both paths.
- It prints RENAME_SESSION: at the end; in CLI: `/rename <value>`; in VSCode: hover session in sidebar → rename.

### --handoff

```bash
./scripts/mavp-operator --handoff [--notes "..."]
```

- Capture mid-session context to HANDOFF.md for next session.

### --new-task

```bash
./scripts/mavp-operator --new-task [--title "..." [--owner <role>] [--repo <name>] [--depends-on <T-NNN>] [--requires-ux <y/n>] [--criteria "..."] [--verification-type <type>]]
```

- Interactive task creation.
- Non-TTY stdin requires --title (other flags fall back to prompt defaults) — refuses and writes nothing if missing.

### --quick-task

```bash
./scripts/mavp-operator --quick-task [--title "..." --problem "..." --repo "..."]
```

- Quick task skeleton (title + problem only).
- Non-TTY stdin requires all three flags — refuses and writes nothing if any is missing.

### --update-task

```bash
./scripts/mavp-operator --update-task
```

- Interactive task status update.

### --set-status

```bash
./scripts/mavp-operator --set-status T-xxx,T-yyy status [--from <current_status>] [--commit <hash|HEAD>] [--branch <name>] [--needs-fix-rounds <N>]
```

- Batch status update across BACKLOG + TASK_STATUS.
- Optional --from guard: only transitions tasks whose current status equals <current_status>, skips others with a warning.
- Optional --commit merges "commit: <hash> branch: <name>" into each updated task's TASK_STATUS.md Evidence field.
  - Append, not clobber (prior evidence text, e.g. QA notes, is preserved).
  - Accepts a hex hash (7-40 chars) or the literal HEAD (auto-resolved to the current repo's short hash).
  - Non-hex/non-HEAD input is rejected before any git call.
  - A format-valid hash not reachable from --branch (default main) prints a non-blocking warning but the write still proceeds.
  - The validator runs once at the end — no transient state warnings.
- Optional --needs-fix-rounds <N> (N must match /^\d+$/, invalid or missing value exits 1 before any file is read or written).
  - Writes the TRUE needs_fix_rounds count into each updated task's Evidence field on any target status.
  - It replaces an existing digit value in place (never appending a second `needs_fix_rounds:` token, which would trip the validator's conflicting_needs_fix_rounds check) or inserts when absent.
  - When omitted, behavior is unchanged: needs_fix_rounds: 0 is still auto-stamped only on a merged transition, only when the field is absent.
- Explicit `--commit`/`--needs-fix-rounds` writes persist on a task already at the target status (summary line `Evidence updated, status unchanged (N): ...`).
- A `--from`-skipped task receives no evidence write.
- The auto-stamp still requires a genuine status transition (T-779).

### --rename-task

```bash
./scripts/mavp-operator --rename-task T-xxx "New title"
```

- Atomically rename task title in BACKLOG + TASK_STATUS.

### --rescope-task

```bash
./scripts/mavp-operator --rescope-task T-NNN [--status <s>] [--owner <role>] [--title "..."]
```

- Atomically re-scope or un-defer a task.
- Moves its block between BACKLOG.md's Deferred Tasks <-> Active Wave sections (creating Deferred Tasks on demand if absent).
- Applies status/owner/title changes.
- Keeps TASK_STATUS.md's sectioning symmetric in BOTH directions.
  - Ensures a matching Active tasks entry when activating (relocating an existing entry back out of whatever section holds it, or creating one when the task had none).
  - On `--status deferred` relocates an existing Active tasks entry OUT into the same "## Deferred tasks" section the close-session terminal-status sweep uses (created on demand), so a deferred task never lingers in Active tasks.
- Both relocations move the block byte-for-byte — hand-edited Evidence/Notes survive verbatim, no skeleton regeneration, exactly one heading per task.
- Preserves the task ID, fails fast on duplicate/missing ID.
- Validator runs once at the end.

### --update-status

```bash
./scripts/mavp-operator --update-status T-NNN <status>
```

- Atomically set a single task's status in BACKLOG + TASK_STATUS (single-task predecessor of --set-status).

### --merge-task

```bash
./scripts/mavp-operator --merge-task
```

- Promote a qa_passed task to merged with evidence.

### --quick-merge

```bash
./scripts/mavp-operator --quick-merge [--verification-type <artifact|runtime|unit>] [--owner <role>]
```

- Fast-track an XS change directly to merged (title + commit hash).
- Use only for <=2 files, <=10 lines diff, no risk.
- See docs/core/ORCHESTRATION_RULES.md "XS fast lane (quick-merge)" for the enforced thresholds and attested conditions.
- Both flags are batch-wide (apply to every item in one run — run the lane once per grouping for a mixed batch).
- Default unchanged to runtime/developer.
- Refuses the entire run with exit 1 on an invalid value before anything is collected or written.
- Visual/manual verification types are mechanically refused (human review required).
- --owner validates against docs/ARCHITECT_OUTPUT.md's owner_role enumeration minus main_agent (the lane always cites a sub-agent's commit, never the Main Agent's own).

### --sync-status

```bash
./scripts/mavp-operator --sync-status
```

- Sync TASK_STATUS.md Status lines from BACKLOG.md Active Wave.

### --integrate

```bash
./scripts/mavp-operator --integrate <commit|base..tip> [--task T-NNN]
```

- Cherry-pick a commit or range into the resolved project root.
  - The git operation itself is pinned to that root regardless of the caller's cwd (removes the hand-typed, cwd-dependent cherry-pick class).
  - See docs/core/ORCHESTRATION_RULES.md "Worktree integration — Main Agent".
- Runs guardMutatingRoot() FIRST (T-624/T-670 — refuses and NAMES the primary checkout on a never-a-project root or a linked worktree, never auto-retargets).
- Refuses when a cherry-pick or merge is already in progress in the resolved root.
- Prints one `integrated: <short-hash>` line per landed commit.
- When `--task T-NNN` is given and resolves to exactly one task block, it also prints a ready-to-run `--set-status` suggestion — `--task` is optional.
- On conflict exits non-zero naming `git cherry-pick --abort`/`--continue` with no auto-abort.
- Writes NO state artifacts itself, so integration and status-booking stay decoupled.

### --archive-merged

```bash
./scripts/mavp-operator --archive-merged
```

- Mid-wave archival: moves merged/deployed task blocks out of BACKLOG.md's Active Wave (and their TASK_STATUS.md Active tasks counterparts) into the same archive destinations --close-session uses, without closing the wave.
- Leaves in-flight tasks untouched.
- --close-session still surfaces these titles in its results table, and --close-wave in wave_summary, once the wave finally closes.
- Validator runs once at the end.

### --park-wave

```bash
./scripts/mavp-operator --park-wave [N] --reason "text" [--until YYYY-MM-DD]
```

- Move ALL of wave N's (default: current wave) task blocks out of BACKLOG.md's Active Wave / TASK_STATUS.md's Active tasks into "## Wave N — Parked" / "## Parked tasks (Wave N)" sections.
  - It carries the wave's trailing non-task sub-heading along with its blocks, so --unpark-wave restores it under its own heading.
- Appends "Wave N — <reason>" to parked_waves.
- --agent then reports 0 active slices for that wave.
- --until additionally arms a wave-keyed rechecks[] entry due on that date (today or later, validated before any write) so the park resurfaces as a due recheck.
- Validator runs once at the end.

### --unpark-wave

```bash
./scripts/mavp-operator --unpark-wave <N>
```

- Inverse of --park-wave: restores wave N's blocks (and its trailing sub-heading) to Active Wave / Active tasks byte-for-byte and removes its parked_waves entry.
- Also auto-acks any --until recheck armed for that wave, printing "acked RC-N (parked-wave reminder)".
- Validator runs once at the end.

### --set-strategy-note

```bash
./scripts/mavp-operator --set-strategy-note "text"
```

- Set wave strategy context note in PROCESS_STATE.json.
- Persists across every --close-session run, cleared only when --close-wave advances the wave.
- Empty string clears.

### --set-wave-goal

```bash
./scripts/mavp-operator --set-wave-goal "text"
```

- Set the wave goal (PROCESS_STATE.json wave_goal) non-interactively.
- The sanctioned setter, since a non-interactive --close-session never prompts for one.
- Empty string clears it.
- A missing argument prints usage and exits 1 before anything is read or written.
- Only wave_goal and last_updated change, PROCESS_STATE.md is regenerated, validator runs once at the end.

### --close-wave

```bash
./scripts/mavp-operator --close-wave [--interactive] [--operator-confirmed "<the operator's exact statement>"] [--next-goal "text"]
```

- The ONLY command that advances the wave counter (--close-session never does).
- Needs the operator's confirmation that the wave's goal is met, by one of two paths chosen by the same mode rule as --close-session.
  - Terminal path (TTY or --interactive): prints the wave goal, summary, suite receipt and git ahead/behind, then the operator must TYPE the wave number (anything else aborts with nothing written), then is asked for the next wave's goal and a `git push` [Y/n].
  - Agent path (otherwise): requires `--operator-confirmed` with a non-empty value, optional `--next-goal`, no prompts and no push.
- Four refusals, all exit 1 with PROCESS_STATE.json, BACKLOG.md and TASK_STATUS.md untouched, both paths except where noted:
  - (a) agent path without `--operator-confirmed` or with an empty value — `--close-wave needs operator confirmation.` followed by the terminal instruction and the agent instruction (full text in docs/core/TASK_LIFECYCLE.md);
  - (b) any entry left in TASK_STATUS.md's Active tasks section — sweep it with --close-session first;
  - (c) `wave_goal` is null and the wave is not in `parked_waves` — record one with --set-wave-goal first;
  - (d) validator exit 2.
- On success it archives the Active Wave heading, increments `wave`, resets `wave_session` to 1, clears `wave_goal` and the strategy note, resets `wave_status` to `planning`, writes `wave_summary`.
- It commits (`git add -u`, tracked files only) as `chore: close wave N` with the trailers `Operator-Confirmed: <the statement, or "typed at terminal">` and `Wave-Goal: <the goal, or "parked — <reason>">`.
- It then prints the ready-to-paste EXECUTION_LOG line `wave close: W<N> → W<N+1> — goal: "..." — operator-confirmed: "..." — close commit <hash>` (a bare hash — never the `commit:` key form, which the validator would read as evidence).
- On the agent path it also prints a `git push` reminder.
- It never pushes on its own (see the **Wave advance confirmation** convention in CLAUDE.md).

### --validate

```bash
./scripts/mavp-operator --validate
```

- Run the validator via the operator wrapper (equivalent to node scripts/mavp-validator.js "$(pwd)").

### --check-archive

```bash
./scripts/mavp-operator --check-archive (--range A..B | --staged)
```

- Read-only nothing-lost check for the archive-not-delete convention (.claude/rules/docs.md).
- Every non-empty trimmed line a commit removes from a layer-0/1 doc (perimeter at the parent: CLAUDE.md, its @ imports, .claude/rules/, module context_docs) must either:
  - reappear verbatim in a perimeter doc or in a docs/archive/ file that same commit added or modified (the archive copy may be blockquoted — leading `>` markers, nested too, are ignored on the archive side only; the text after them must be verbatim and a source line that is itself a blockquote keeps its marker), or
  - be amended in place (an added perimeter line keeps >=80% of its words in order, or all but one, or a same-file rewrite of a line whose key — its bold item lead or first table cell — occurs once at the parent and once at the child, counted in `keyed-amendments`; archive copies never count).
- In adopter trees (no `scripts/mavp-operator-lib.js`) installer-managed, framework-managed files are skipped from the perimeter and named on one summary line.
- --range walks first-parent commits, --staged judges the index (for a project's pre-commit.local).
- Prints a summary (commits scanned, perimeter files, removed lines, found-in-working, found-in-archive, amended-in-place, missing).
- Exit 0 nothing missing, 1 missing lines named, 2 usage or git error or a shallow clone in --range mode.

### --check-sync

```bash
./scripts/mavp-operator --check-sync
```

- Compare agent/skill files in known projects against mavericks source.

### --worktree-report

```bash
./scripts/mavp-operator --worktree-report [--main-ref <ref>] [--mtime-threshold <ms>] [--json]
```

- Read-only: classify every linked agent git worktree into dirty / unintegrated / clean-and-integrated via PATCH-EQUIVALENCE (`git cherry`), never raw reachability.
  - This project integrates by cherry-pick, so a worktree tip is unreachable from main by construction even once fully integrated.
- Shared classifyWorktrees()/formatWorktreeHygieneAdvisory() in mavp-operator-lib.js also feeds the --close-session advisory and --prune-worktrees, so all three surfaces agree.
- When at least one worktree is genuinely prunable, both this report and the --close-session advisory (both modes) append a second, propose-only line naming the ready-to-run DRY-RUN prune command (`formatWorktreePruneSuggestion()` — never suggests `--yes`), so the operator no longer has to recall `--prune-worktrees` unprompted.

### --prune-worktrees

```bash
./scripts/mavp-operator --prune-worktrees [--yes] [--main-ref <ref>] [--mtime-threshold <ms>]
```

- Remove ONLY clean-and-integrated worktrees (same classification as --worktree-report).
- Additionally gated on an mtime safety window (default 1h) so a just-spawned live agent's still-clean worktree is never removed.
- Defaults to dry-run (prints what would be removed) — pass --yes to actually delete the worktree + its branch.
- Run the real (--yes) prune only with zero live sub-agents, since this is a repository-global exclusive-resource operation.

### --install

```bash
./scripts/mavp-operator --install <target-dir> [--yes]
```

- Bootstrap Mavericks into a target project (operator wrapper for node scripts/mavp-install.js).
- Non-TTY runs (e.g. agent Bash) auto-proceed creating missing files without prompting; `--yes`/`-y` does the same at a real TTY.
- `--strip` is unaffected and always refuses non-interactively since it's destructive.

### --strip

```bash
./scripts/mavp-operator --strip <target-dir> [--keep-artifacts]
```

- Remove Mavericks files from a project (pre-publish cleanup).
- Prints a git-recoverability manifest before any prompt, then two-stage confirm.
  - Plumbing [y/N].
  - State artifacts (BACKLOG/TASK_STATUS/PROCESS_STATE/EXECUTION_LOG/SKILL_PROPOSALS) require typing "delete" if any state path is git-irrecoverable.
- --keep-artifacts skips the state group.
- Requires an interactive TTY.

### --apply-decomposition

```bash
./scripts/mavp-operator --apply-decomposition [FILE]
```

- Apply architect decomposition block to BACKLOG + TASK_STATUS.

### --arm-recheck

```bash
./scripts/mavp-operator --arm-recheck T-NNN --due YYYY-MM-DD [--interval 8w] [--note "..."]
```

- Register a time-based post-merge recheck for task T-NNN.
- Auto-assigns next RC-N id.
- Copies task title for self-containment.

### --ack-recheck

```bash
./scripts/mavp-operator --ack-recheck RC-N [--rearm] [--due YYYY-MM-DD]
```

- Acknowledge and remove a recheck.
- --rearm reschedules instead.
  - Without --due: sets due = today + interval, requires interval on the entry.
  - With --due YYYY-MM-DD, today or later: sets due to that explicit date, no interval required — the way to extend a --park-wave --until park past its original date.
- --due is only valid together with --rearm.

### --feedback

```bash
./scripts/mavp-operator --feedback --file <path> | --set-alias <alias> | --status | --ack <id> | --pull | --github (--file <path> | --item <id>) [--repo <owner/repo>] --operator-confirmed "<statement>" | --draft "title" [--summary "..."] [--area <text>] [--kind bug|proposal|question] | --drafts | --discard <draft path>
```

- Adopter side of the feedback loop (docs/core/FEEDBACK_INTAKE.md).
- Files a structured item from templates/FEEDBACK_ITEM_TEMPLATE.md into the per-user inbox (MAVERICKS_INTAKE_DIR, else a `.mavericks-intake` directory in the home directory).
- `--set-alias` persists `feedback_alias` in PROCESS_STATE.json (the only state write — an alias must never be a private repo name).
- `--github` posts the item as a public issue only after a blocking outbound scan finds nothing and `--operator-confirmed` carries the operator's exact in-session statement.
- `--draft`/`--drafts`/`--discard` manage the pre-approval drafts and `--file <draft>` submits one and removes it.
- `--pull` reads the maintainer's answer comment back from GitHub for each posted item.
  - Read-only on GitHub, needs `gh`, no `--operator-confirmed`, sends only the issue reference.
  - Only comments by the repository owner or an organisation member in the answer form count.
  - It stores the answer on the existing item, so `--status` and `--migrate` see it.
- Never writes BACKLOG.md or TASK_STATUS.md.

### --intake

```bash
./scripts/mavp-operator --intake [--brief [ids] | --triage <id> --disposition "<value>" [--note "text"] | --publish-answers [--operator-confirmed "<statement>"] | --pull [--repo <owner/repo>]]
```

- Framework repo only: lists the adopter inbox with repeat and version-lag hints.
- `--brief` prints the untrusted-input architect brief block to paste verbatim into the architect brief.
- `--triage` records a disposition (`fixed-in T-NNN`, `by-design`, `deferred`, `duplicate-of <item>`, `not-reproduced`) on the item and registers no task.
- `--publish-answers` refreshes Ships in / Retire workaround and, with `--operator-confirmed`, comments (never closes) on the public issues.
- `--pull` imports `[mavp-feedback]` issues.

### --migrate

```bash
./scripts/mavp-operator --migrate [--legacy]
```

- Read-only, writes nothing.
- Lists the `mavp-workaround:<alias>-NNN` tags in the repo and the harness memory directory as `retire:` / `keep:` lines plus a one-line summary.
- `--legacy` also lists lines matching phrases that released CHANGELOG sections declare under `**Supersedes adopter workarounds:**`.
- A tag on an item posted to GitHub with no fixed answer yet reads `open (posted as <owner/repo>#N — run ./scripts/mavp-operator --feedback --pull)`.
- The adopter applies every change by hand.

### --version

```bash
./scripts/mavp-operator --version
```

- Framework version.

### --help

```bash
./scripts/mavp-operator --help
```

- Show all flags.

### node scripts/mavp-install.js <dir>

```bash
node scripts/mavp-install.js <dir>
```

- Bootstrap a new project.
- --check to preview.
- --update to re-sync, which also seeds any missing project-owned artifact from its template without overwriting, skipped on self-install.
- Both also activate/refresh Claude Code hooks by default — --no-hooks to skip.
- --hooks-only activates/refreshes hooks only, no framework-file sync — the safe narrow command for the canonical self-install case.

### node scripts/mavp-validator.js

```bash
node scripts/mavp-validator.js
```

- Validate artifact sync.

### node --check scripts/<file>.js

```bash
node --check scripts/<file>.js
```

- Syntax-check a script without running it.
