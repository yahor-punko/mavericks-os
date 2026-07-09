---
name: session-start
description: Load current Mavericks operating state. Use at the start of any session or after context is lost. Injects live initiative, stage, active slices, and next action. If HANDOFF.md is present at the repo root, its contents are output first and the file is deleted.
user-invocable: true
allowed-tools: Bash(./scripts/mavp-operator --agent), Bash(!test -f HANDOFF.md && cat HANDOFF.md || true), Bash(rm HANDOFF.md)
---

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
- `permission_mode` — the configured Claude Code permission mode

Always render the wave digest header:

```
## Wave {wave} — Session {wave_session}
```

(Omit "— Session {wave_session}" if `wave_session` is absent, null, or 0.)

Immediately after the wave digest header, render the permission mode:

```
Permission mode: {permission_mode}
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

Where `{overdue_marker}` is ` ⚠ OVERDUE` when the entry's `overdue` field is `true`, and empty otherwise. List overdue entries before due-today entries (the array is already in this order). This callout must be visible before the task list so the operator sees it at session start.

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
