---
name: validate
description: Run the parliamentary validator to check artifact sync between BACKLOG.md and TASK_STATUS.md. Use after any backlog changes or to confirm healthy state before starting new work.
user-invocable: true
allowed-tools: Bash(./scripts/mavp-operator --validate*)
---

## Validator report

!`./scripts/mavp-operator --validate`

---

Exit codes: `0` = healthy, `1` = drifting (warnings), `2` = repair required (failures).

If failures exist, repair the artifact listed in `Repair target` before proceeding.
If warnings exist, clean them up before the next wave closes.
If healthy, continue safely.
