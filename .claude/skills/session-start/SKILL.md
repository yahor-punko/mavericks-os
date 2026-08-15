---
name: session-start
description: Load current Mavericks operating state. Use at the start of any session or after context is lost. Injects live initiative, stage, active slices, and next action. If ONBOARDING.md is present at the repo root (freshly bootstrapped project), its contents are output first and the file is deleted. If HANDOFF.md is present at the repo root, its contents are output next and the file is deleted.
user-invocable: true
allowed-tools: Bash(./scripts/mavp-operator --agent), Bash(!test -f ONBOARDING.md && cat ONBOARDING.md || true), Bash(rm ONBOARDING.md), Bash(!test -f HANDOFF.md && cat HANDOFF.md || true), Bash(rm HANDOFF.md)
---

## First-run onboarding (if present)

!`test -f ONBOARDING.md && cat ONBOARDING.md || true`

If the block above contained text, this is the first session of a freshly bootstrapped project — present the orientation to the operator, then delete the file with the Bash tool: `rm ONBOARDING.md`. The file must not persist into the next session. The `|| true` makes this a no-op on projects without the file (including mavericks itself).

## Mid-session handoff (if present)

!`test -f HANDOFF.md && cat HANDOFF.md || true`

If the block above contained text, read it carefully — it carries mid-session context from the previous agent turn (in-progress decisions, pending actions, warnings). Then delete the file with the Bash tool: `rm HANDOFF.md`. The file must not persist into the next session.

## Current Mavericks state

!`./scripts/mavp-operator --agent`

---

Read the JSON above. Key fields:
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
- `must_read` — files changed since the previous close-session commit, plus context_docs declared by in-flight tasks (may be absent when empty)

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

Where `{overdue_marker}` is ` ⚠ OVERDUE` when the entry's `overdue` field is `true`, and empty otherwise. List overdue entries before due-today entries (the array is already in this order). This callout must be visible before the task list so the operator sees it at session start.

If `must_read` is present and non-empty, render it as a list immediately after the rechecks callout (or after the wave digest/strategy note if no rechecks are due):

```
Must read:
- {path}
- ...
```

This is the set of files changed since the previous close-session commit plus context_docs declared by any in-flight task — read them before making changes this session. Omit this block entirely when `must_read` is absent.

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

Wait for the user's choice before proceeding.

**If `active_slices` is empty and `planned_tasks` is empty:**

Show:

```
Next action: {next_action}
```

Do not ask the decision prompt. Do not re-derive state from chat history.
