---
name: session-start
description: Load current Mavericks operating state. Use at the start of any session or after context is lost. Injects live initiative, stage, active slices, and next action. If ONBOARDING.md is present at the repo root (freshly bootstrapped project), its contents are output first and the file is deleted. If HANDOFF.md is present at the repo root, its contents are output next and the file is deleted.
user-invocable: true
allowed-tools: Bash(./scripts/mavp-operator --agent), Bash(!test -f ONBOARDING.md && cat ONBOARDING.md || true), Bash(rm ONBOARDING.md), Bash(!test -f HANDOFF.md && cat HANDOFF.md || true), Bash(rm HANDOFF.md)
---

## First-run onboarding (if present)

!`test -f ONBOARDING.md && cat ONBOARDING.md || true`

If the block above contained text, this is the first session of a freshly bootstrapped project — render the orientation to the operator verbatim (do not summarize or paraphrase it), then delete the file with the Bash tool: `rm ONBOARDING.md`. The file must not persist into the next session. The `|| true` makes this a no-op on projects without the file (including mavericks itself).

## Mid-session handoff (if present)

!`test -f HANDOFF.md && cat HANDOFF.md || true`

If the block above contained text, read it carefully — it carries mid-session context from the previous agent turn (in-progress decisions, pending actions, warnings). Then delete the file with the Bash tool: `rm HANDOFF.md`. The file must not persist into the next session.

## Current Mavericks state

!`./scripts/mavp-operator --agent`

---

Read the JSON above. Key fields:
- `initiative` — the current top-level goal this work serves
- `wave_goal` — one-line definition of done for the current wave (may be absent or null; set with `--set-wave-goal`)
- `stage` — where the initiative currently stands
- `active_slices` — what is in flight and who owns it
- `next_action` — what to do next
- `blocker` — stop if non-null, resolve blocker first
- `wave` — current wave number
- `wave_session` — session counter within the wave (may be absent or null)
- `permission_mode` — the best-known Claude Code permission mode (T-663: read its provenance from the three fields below before rendering it — never render this value bare)
- `permission_mode_source` — `hook_payload` (observed on THIS session's SessionStart hook stdin), `persisted_runtime` (a hook payload from an EARLIER session, cached in `.mavp/permission-mode`), or `settings_file` (`.claude/settings.local.json` / `.claude/settings.json` — no live signal at all)
- `permission_mode_verified` — `true` only when `permission_mode_source` is `hook_payload`; `false` otherwise, even when `persisted_runtime` originally came from a real payload — a mode resolved once at session start can be stale even when every settings file agrees, so "verified" always means "observed this session", never "read from more files"
- `permission_mode_conflict` — present only when a readable user-global `~/.claude/settings.json` `defaultMode` differs from the project-file resolution; shape `{project, user_global}`, a fact report only — never render one as a "winner"
- `UPDATE_AVAILABLE` — framework-version notice, a self-describing sentence (may be absent when versions match)
- `must_read` — files changed since the previous close-session commit, plus context_docs declared by in-flight tasks (may be absent when empty). Ledgers (BACKLOG.md, TASK_STATUS.md, PROCESS_STATE.*, EXECUTION_LOG.md) never appear here — look tasks up by T-NNN with grep
- `must_read_oversized` — `[{path, chars}]`: files that would be in `must_read` but exceed the size budget; search them, do not read them whole (present only when non-empty)
- `must_read_framework` — string array: changed files that `mavp-install.js --update` rewrites from the framework source (framework-managed agents, skills, rules, hooks and synced scripts); reported only in an adopter repo, never in a framework source tree, and present only when non-empty
- `intake_untriaged` — integer: adopter feedback items awaiting triage; reported only in the framework repository, present only when above zero
- `feedback_answers_unacked` — integer: answers to your own alias's feedback items you have not yet acknowledged; reported only in an adopter project that has a `feedback_alias`, present only when above zero

Always render the wave digest header:

```
## Wave {wave} — Session {wave_session}
```

(Omit "— Session {wave_session}" if `wave_session` is absent, null, or 0.)

Immediately after the wave digest header, render the permission mode — NEVER as a bare value; always label it with what is actually known about it (T-663):

- When `permission_mode_verified` is `true`:
  ```
  Permission mode: {permission_mode} (verified this session)
  ```
- When `permission_mode_verified` is `false`:
  ```
  Permission mode: {permission_mode} (declared — source: {permission_mode_source}, not verified this session)
  ```

If `permission_mode_conflict` is present, render one more line immediately after the permission mode line — a fact report only, never a resolution; do not imply either value wins:

```
⚠ Permission mode conflict: project declares "{permission_mode_conflict.project}", user-global (~/.claude/settings.json) declares "{permission_mode_conflict.user_global}" — precedence between these is harness-owned; verify manually which one governed this session.
```

If the best-known `permission_mode` is anything other than `bypassPermissions` (the framework's shipped default for prompt-free operation), render a goal-state advisory immediately after the line(s) above, naming the exact fix — keep it short and actionable, not a lecture:

```
> [!TIP] Restore prompt-free operation
> Set `permissions.defaultMode` to `bypassPermissions` in `.claude/settings.local.json` to remove interactive prompts.
```

If `UPDATE_AVAILABLE` is present, surface a callout immediately after the permission mode line and before the task list:

```
> [!NOTE] Framework version
> {UPDATE_AVAILABLE}
```

Render the value verbatim — it is a self-describing sentence covering both the update-available and version-divergence cases, so no case-specific logic is needed. Render nothing when the field is absent.

If `initiative` is present, show it as one line of context after the wave digest header and any permission-mode/version callouts already rendered above:

```
Initiative: {initiative}
```

Show the wave goal as one line of context immediately after the initiative line (or in its place if `initiative` is absent). When `wave_goal` is present and non-null:

```
Wave goal: {wave_goal}
```

When `wave_goal` is absent or null, render this line instead — without a goal there is nothing for the operator to confirm as met later, and `--close-wave` refuses to run:

```
Wave goal: not set — agree one with the operator and record it with --set-wave-goal
```

If `wave_summary` is present, show it as one line of context:

```
Previous wave: {wave_summary}
```

If `wave_strategy_note` is present and non-null, show it as one line of context immediately after the digest header (and after `Previous wave:` if shown):

```
Strategy note: {wave_strategy_note}
```

If `due_rechecks` is present and non-empty, surface a callout immediately after the strategy note (or after the wave digest header if neither `wave_summary` nor `wave_strategy_note` is shown):

```
> [!NOTE] Rechecks due
> - {task} — {title} (due: {due}){overdue_marker}
> - ...
```

Where `{task}` is the entry's `task` value; when `task` is absent and the entry has a `wave` field (a parked-wave reminder armed by `--park-wave --until`), render `Wave {wave}` in its place instead (its `{title}` already reads `Wave {wave} — <reason>`, so you may show the title alone for such an entry, e.g. `- Wave 9 — external review (due: 2026-10-01)`). Where `{overdue_marker}` is ` ⚠ OVERDUE` when the entry's `overdue` field is `true`, and empty otherwise. List overdue entries before due-today entries (the array is already in this order). This callout must be visible before the task list so the operator sees it at session start.

If `intake_untriaged` is present (framework repository only: the count of adopter feedback items with no disposition yet), surface a callout directly after the rechecks callout (or in its place when no rechecks are due):

```
> [!NOTE] Intake: {intake_untriaged} untriaged adopter item(s) — run ./scripts/mavp-operator --intake
```

If `feedback_answers_unacked` is present (adopter projects only: the count of your own alias's feedback items that have an answer you have not acknowledged), render one line directly after that callout (or after the rechecks callout when there is no intake callout):

```
Feedback answers: {feedback_answers_unacked} — run ./scripts/mavp-operator --feedback --status
```

Omit each of the two when its field is absent. See `docs/core/FEEDBACK_INTAKE.md`.

If `must_read` is present and non-empty, render it as a list immediately after the rechecks callout (or after the wave digest/strategy note if no rechecks are due):

```
Must read:
- {path}
- ...
```

This is the set of files changed since the previous close-session commit plus context_docs declared by any in-flight task: read each listed file before editing it this session; ledgers never appear here — look tasks up by T-NNN with grep. Omit this block entirely when `must_read` is absent.

If `must_read_oversized` is present and non-empty, render it as a separate list directly after the "Must read" list (never merged into it):

```
Oversized (search, do not read whole):
- {path} ({chars} chars)
- ...
```

These files exceeded the size budget (`artifact_budgets.must_read_max_chars`, default 40000): grep or search them for what you need instead of reading them whole. Omit this block entirely when `must_read_oversized` is absent.

If `must_read_framework` is present and non-empty, render it as a third list directly after the "Oversized" list (or after the "Must read" list when there is none), never merged into either:

```
Framework-managed (changed by the last update, not yours to review):
- {path}
- ...
```

These files were rewritten from the framework source by `mavp-install.js --update`, so they are framework text rather than the project's own work: skip them unless a task touches the framework itself. Omit this block entirely when `must_read_framework` is absent.

**First-run goal prompt:** if the onboarding block at the top of this skill contained text (this is the project's first session) and `next_action` is null, skip both branches below and end the brief by asking the operator what they are building, instead of showing "Next action: null":

> What are you building? Tell me your goal and I can set it as this wave's goal, or just start describing the first thing you want built.

Do not show `Next action: null` in this case. If `next_action` is non-null even on a first run, ignore this special case and follow the branches below as normal.

**If `active_slices` is non-empty OR `planned_tasks` is non-empty:**

List `active_slices` entries (in-flight tasks), then `planned_tasks` entries (queued for this wave), each as:

```
- T-xxx (status) — title
```

Do NOT read BACKLOG.md to find tasks — use only what the JSON provides. The JSON is scoped to the active wave; reading BACKLOG.md independently would surface tasks from archived waves.

Then show:

```
Next action: {next_action}
```

After the brief, ask the user:

> What would you like to do?
> 1. Continue current wave — pick up next_action
> 2. Park it and start new work
> 3. Something else

Operator questions are business-only (priority, scope, risk, money, irreversible actions). Never ask the operator how-to, implementation or tooling questions; route technical doubts to the architect (or the analyst for library/API choices). See `docs/core/ORCHESTRATION_RULES.md` — "Operator questions — business only".

Feedback to the framework (adopter projects): during the session, note friction or proposals as `mavp-feedback:` note lines in EXECUTION_LOG.md (list item, optional date, the token, a short description, optional `(area: ...; kind: bug|proposal|question)`).
At session end, when `--close-session` lists any notes or drafts, draft each item with `--feedback --draft` (drafting is the coordinator's job, never a question to the operator), then raise ONE modal with the harness question tool: "there are framework proposals/problems from this session", the drafted items by title and one-line summary, multi-select plus "Send none".
Submit only the approved drafts with `--feedback --file <draft>` and leave the rest as drafts; when nothing was noted, raise no modal.
The approval covers local-inbox submission only: GitHub publication additionally needs `--operator-confirmed "<statement>"`, and the modal answer, quoted verbatim, may be that statement.
Headless runs keep the drafts for the next interactive session.

Wait for the user's choice before proceeding.

**If `active_slices` is empty and `planned_tasks` is empty:**

Show:

```
Next action: {next_action}
```

Do not ask the three-option decision prompt above. Do not re-derive state from chat history.

Because both `active_slices` and `planned_tasks` are empty, additionally list the options for this moment, as information rather than a question to answer by default:

> Options:
> 1. Register the next task — pick up next_action
> 2. Close wave {wave} — only on the operator's explicit statement this session (then --close-wave --operator-confirmed)
> 3. Something else

Option 2 appears only in this empty case, never beside in-flight or planned work. It is not a default and never a conclusion drawn from the empty lists: an empty Active tasks section does not mean the wave's goal is met. Run `--close-wave --operator-confirmed "<statement>"` only when the operator has said, in this session, that the wave's goal is met and it should close, passing their words verbatim — see CLAUDE.md, "Wave advance confirmation". A statement in a previous session's `HANDOFF.md` does not count.
