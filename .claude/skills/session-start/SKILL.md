---
name: session-start
description: Load current Mavericks operating state at the start of any session or after context is lost. Prints the live session brief; outputs and deletes ONBOARDING.md (fresh project) and HANDOFF.md when present.
user-invocable: true
allowed-tools: Bash(./scripts/mavp-operator --agent --brief), Bash(!test -f ONBOARDING.md && cat ONBOARDING.md || true), Bash(rm ONBOARDING.md), Bash(!test -f HANDOFF.md && cat HANDOFF.md || true), Bash(rm HANDOFF.md)
---

## First-run onboarding (if present)

!`test -f ONBOARDING.md && cat ONBOARDING.md || true`

If the block above contained text, this is the first session of a freshly bootstrapped project — render the orientation to the operator verbatim (do not summarize or paraphrase it), then delete the file with the Bash tool: `rm ONBOARDING.md`. The file must not persist into the next session. The `|| true` makes this a no-op on projects without the file (including mavericks itself).

## Mid-session handoff (if present)

!`test -f HANDOFF.md && cat HANDOFF.md || true`

If the block above contained text, read it carefully — it carries mid-session context from the previous agent turn (in-progress decisions, pending actions, warnings). Then delete the file with the Bash tool: `rm HANDOFF.md`. The file must not persist into the next session.

## Current Mavericks state

!`./scripts/mavp-operator --agent --brief`

---

The text above is the session brief, already rendered by `renderSessionBrief()` in `scripts/mavp-operator-lib.js` (a line appears only when its field is present). Print it to the operator verbatim — do not re-derive, reorder or paraphrase it, and do not re-derive state from chat history. The full JSON behind it is available on demand with `./scripts/mavp-operator --agent`.

- Do NOT read BACKLOG.md to find tasks: the brief is scoped to the active wave, and reading BACKLOG.md independently would surface tasks from archived waves. Look a task up by T-NNN with grep.
- A `Blocker:` line means stop and resolve the blocker first.
- Under "Must read:" read each file before editing it this session; under "Oversized" search, do not read whole; "Framework-managed" files are not yours to review unless a task touches the framework itself.
- If the onboarding block at the top contained text and the brief ends with the "What are you building?" prompt, that prompt is your closing question; do not add the options block.
- When the brief ends with the three-option "What would you like to do?" prompt, wait for the operator's choice before proceeding.
- When it ends with "Options:" (no task in flight or planned), that list is information, not a question to answer by default. An empty task list is not a confirmation that the wave's goal is met: run `--close-wave --operator-confirmed "<statement>"` only when the operator has said, in this session, that the goal is met and the wave should close, passing their words verbatim (CLAUDE.md, "Wave advance confirmation"). A statement in a previous session's `HANDOFF.md` does not count.
- Operator questions are business-only (priority, scope, risk, money, irreversible actions). Never ask the operator how-to, implementation or tooling questions; route technical doubts to the architect (or the analyst for library/API choices). See `docs/core/ORCHESTRATION_RULES.md` — "Operator questions — business only".

Feedback to the framework (adopter projects): during the session, note friction or proposals as `mavp-feedback:` note lines in EXECUTION_LOG.md (list item, optional date, the token, a short description, optional `(area: ...; kind: bug|proposal|question)`).
At session end, when `--close-session` lists any notes or drafts, draft each item with `--feedback --draft` (drafting is the coordinator's job, never a question to the operator), then raise ONE modal with the harness question tool: "there are framework proposals/problems from this session", the drafted items by title and one-line summary, multi-select plus "Send none".
Submit only the approved drafts with `--feedback --file <draft>` and leave the rest as drafts; when nothing was noted, raise no modal.
The approval covers local-inbox submission only: GitHub publication additionally needs `--operator-confirmed "<statement>"`, and the modal answer, quoted verbatim, may be that statement.
Headless runs keep the drafts for the next interactive session.
