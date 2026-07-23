# TASK_STATUS

## Status legend

- `planned`
- `in_progress`
- `dev_done`
- `ux_review` _(optional — requires_ux: true)_
- `ux_needs_fix` _(optional)_
- `ready_for_qa`
- `qa_in_progress`
- `qa_passed`
- `needs_fix`
- `merged`
- `runtime_verified` _(optional — runtime behavior confirmed post-merge)_

## Active tasks

### T-001 — Example task
- **Status:** planned
- **Owner role:** developer
- **Verification type:** artifact
- **Last verified by:** —
- **Evidence:** — _(for `runtime`/`unit` tasks, use: `commit: <hash> — <one-line summary>`; for `artifact`-verification tasks with no code diff (exploration/audit tasks), use `artifact: <description>` as an alternative to `commit:` (e.g. `artifact: docs/AUDIT.md`) — accepted only when `Verification type` is `artifact`; for infra-only tasks with no code commit, use `infra: <verifiable-ref>` as an alternative to `commit:` (accepted refs: AWS ARN `arn:aws:ssm:...`, git commit hash, Terraform state serial `serial/N`, or SSM parameter version `@vN`); for cross-repo tasks (Repos: [a, b]), one line per repo: `commit: <hash-a> (repo-a)` and `commit: <hash-b> (repo-b)`; for tasks with `requires_config_check: true`, include `config_check: <key1> ✓, <key2> ✓` listing each config key confirmed present and correct in the target environment; optional: `branch: <name>` — e.g. `main`, `develop`, `both` — for projects with branch-based deploy contours)_
- **manual_changes:** — _(optional — list any operations performed outside version control (CLI commands, direct config edits, DB patches); if non-empty, a corresponding code/config commit codifying those changes is required before `merged`)_
- **needs_fix_rounds:** — _(optional — integer; how many `needs_fix` cycles occurred before `qa_passed`; fill when ≥ 1; omit or use `0` for first-attempt passes; primary signal for skill reflection)_
- **validator_blocked:** — _(optional — `true` if validator exit code 2 ever blocked a commit on this task; `false` or omit otherwise; skill reflection quality signal)_
- **Notes:** —
- **started_at:** — _(optional — ISO date, set when task moves to `in_progress`)_
- **completed_at:** — _(optional — ISO date, set when task moves to `merged`)_

## Recently completed tasks

