# Doc-sync advisory

## Purpose

Source files change; documentation lags. The doc-sync advisory script surfaces this gap automatically: after each TASK_STATUS.md edit it inspects recently merged tasks, looks up which source files each commit touched, and emits a stderr advisory when a candidate documentation file is found that may need updating.

Without this, docs drift silently — contributors discover the gap only when a reader notices stale content.

## How it triggers

The script (`scripts/mavp-operator-doc-sync-check.js`) is wired into the PostToolUse hook that runs after every `Edit` or `Write` on `TASK_STATUS.md`. It fires as the last step in the hook pipeline, after the parliamentary validator.

The hook invocation is:

```
; case "$FP" in *TASK_STATUS.md) node "$MAVERICKS/mavp-operator-doc-sync-check.js" 2>&1 >&2 || true ;; esac
```

Where `$MAVERICKS` = `${MAVERICKS_SCRIPTS:-$HOME/Documents/mavericks/scripts}`.

The script can also be run manually:

```bash
node scripts/mavp-operator-doc-sync-check.js
```

It always exits 0 — it is advisory only and never blocks the workflow.

## Detection logic

1. Reads `TASK_STATUS.md` and parses every `### T-NNN` block.
2. Selects blocks where **Status** is `merged` and a parseable `commit: <hash>` is present.
3. Caps at the 10 most recent such tasks (file order, newest-first).
4. For each task, runs `git show --name-only --format= <hash>` to get the list of files changed in that commit.
5. Filters that list through the false-positive suppression rules (see below).
6. For each remaining source file, scans all `*.md` files under `docs/` for a reference to the file's basename.
7. Emits one advisory line per source file to stderr.

The script is **stateless** — it writes no ledger. It may re-emit the same advisory on subsequent TASK_STATUS.md edits.

## False-positive suppression rules

A source file is excluded from advisory analysis if it matches any of these patterns:

| Rule | Pattern | Rationale |
|---|---|---|
| 1 | No parseable `commit: <hash>` in the block | Pure SSM/config/doc tasks have no code commit to inspect |
| 2 | Task `Type:` is `docs` or `chore` | These task types are unlikely to produce doc-worthy code changes |
| 3 | All changed files match excluded path patterns | Excluded: `docs/**`, `*.md`, `BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.*`, `.claude/**` |
| 4 | Commit hash not resolvable by `git show` | Happens for cross-repo tasks where the commit lives in another repo |

When all changed files are excluded (rule 3), the script exits silently with no output.

## Advisory format

When a candidate documentation file is found:

```
doc-sync: T-179 merged (commit 19c5f9f) touched mavp-operator-lib.js — candidate docs: docs/REFACTOR_PLAN.md, docs/core/BOOTSTRAP_GUIDE.md. Review before close.
```

When no candidate documentation file is found for a source file:

```
doc-sync: T-XXX merged (commit abc1234) touched file.py — no obvious doc reference found. Confirm no doc impact.
```

Both lines go to stderr. The word "candidate" signals that the match is heuristic (basename substring search) — false matches are possible.

## Main Agent response

When the advisory fires, the Main Agent applies judgment before acting:

**Advisory names a specific candidate doc:**
- Spawn `product-docs` (for process/operator docs) or `technical-writer` (for user-facing docs) with the candidate doc as the target file.
- The sub-agent brief should include the task ID, commit hash, and the specific doc path.
- If the candidate doc is clearly unrelated (the filename just happens to appear in the doc for an unrelated reason), note this in the session log and move on.

**Advisory says "no obvious doc reference found":**
- Use judgment based on task type and the file touched.
- If the changed file is a core framework script (e.g. `mavp-operator-lib.js`, `mavp-install.js`), check whether `CLAUDE.md` or a `docs/core/` file describes its behavior.
- If the changed file is a project-specific script with no docs coverage, no action is needed.
- Repeating advisories for the same task may be ignored after the first review.

**Re-fires on subsequent edits:**
- Because the script is stateless, it re-emits advisories on every TASK_STATUS.md edit. The Main Agent should ignore repeat advisories for tasks already reviewed in the current session.

## Limitations

- **Stateless — re-fires**: the script has no memory of previous advisory runs. The same task may emit the same advisory multiple times within a session.
- **Cross-repo blind spot**: the script runs `git show` against the local repo only. For cross-repo tasks (code in `<your-repo>`, docs in mavericks), the commit hash belongs to the other repo and `git show` will fail silently (rule 4). Cross-repo doc updates require manual awareness by the Main Agent.
- **Heuristic matching**: candidate docs are found by substring-searching doc files for the source file's basename. This may produce false positives (unrelated references) or miss docs that describe the file under a different name.
- **`docs` and `chore` tasks suppressed**: these task types are skipped entirely, but some `docs` tasks may have a code side-effect or some `chore` tasks may update scripts that have doc coverage. When in doubt, inspect manually.
- **Capped at 10 tasks**: only the 10 most recent merged tasks are inspected per run. Older tasks are not revisited.
