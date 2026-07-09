# New project checklist

## Bootstrap

- [ ] Run `node ~/Documents/mavericks/scripts/mavp-install.js /path/to/project`
- [ ] Confirm `scripts/mavp-operator`, `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md`, `PROCESS_STATE.json` were created
- [ ] Edit `PROCESS_STATE.json` — set initiative name, confirm `wave: 1`
- [ ] Run `./scripts/mavp-operator --version` — confirms mavericks connection works

## First tasks

- [ ] Add at least one task via `./scripts/mavp-operator --new-task` or manually
- [ ] Every task in `BACKLOG.md` has a matching entry in `TASK_STATUS.md`
- [ ] Run `./scripts/mavp-operator --agent` — shows correct initiative and tasks
- [ ] Validator reports healthy (shown in `--agent` output)

## Roles

- [ ] Orchestrator identified (Claude Code itself — the Main Agent; no separate agent prompt file, see `docs/core/ROLES.md` — "Main orchestrator")
- [ ] Developer sub-agent prompt ready (`.claude/agents/developer.md`)
- [ ] QA sub-agent prompt ready (`.claude/agents/qa.md`)
- [ ] UX sub-agent prompt ready if UI work expected (`.claude/agents/ux.md`)
- [ ] Architect sub-agent available (`.claude/agents/architect.md`) — spawn before creating tasks when a feature touches 2+ services or repos, introduces new infrastructure (queue, database, scheduled job, serverless function, etc.), changes an inter-service interface, or requires choosing between architectural approaches. Returns a design brief and task decomposition; does not produce BACKLOG tasks directly.
- [ ] Analyst sub-agent available (`.claude/agents/analyst.md`) — spawn before creating tasks when a technology choice, library/API selection, or external landscape research must be resolved before scoping can begin. Returns a decision brief; does not produce BACKLOG tasks directly.

## First cycle

- [ ] One task completed end-to-end: `planned` → `in_progress` → `dev_done` → `qa_passed` → `merged`
- [ ] Artifacts updated at each transition
- [ ] `--close-session` run at end of session
- [ ] `PROCESS_STATE.json` reflects current state after close-session

## Architecture documentation

- [ ] `docs/ARCHITECTURE.md` created (auto-copied by installer if missing)
- [ ] Overview section filled in
- [ ] Services and components table populated with planned components
- [ ] Deploy contours recorded (even if only one exists)
- [ ] Remaining sections marked DRAFT with wave target (e.g. `> DRAFT — Wave 2`)
