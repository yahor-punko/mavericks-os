# Retroactive Task Pattern

## What this document covers

Mavericks follows an artifact-first rule: a task must exist in BACKLOG.md and TASK_STATUS.md before any implementation work begins. This document describes the single permitted exception — the **hotfix-first** scenario — and provides a standardised template for registering work retroactively.

---

## When retroactive registration is allowed

Retroactive task registration is **only permitted for emergency hotfixes**: situations where production-critical code was shipped before a task could be formally created because the incident required an immediate fix.

Criteria that must all be true:

1. The fix was shipped in direct response to an active incident (error, crash, data corruption, blocker that stopped other agents).
2. There was no reasonable opportunity to register the task first (e.g., the fix was applied within the same session that discovered the incident, under time pressure).
3. The fix is a targeted patch, not a feature or refactor.
4. The retroactive task is registered **before the session ends** — never left undone until the next wave.

All other scenarios — new features, planned refactors, documentation updates, ergonomics improvements — must follow the normal flow and register the task first.

---

## Template for retroactive task registration

Use this template when adding a hotfix task to BACKLOG.md. Set status directly to `merged` because the work is already complete. Add matching entry to TASK_STATUS.md.

### BACKLOG.md entry

```markdown
### T-NNN — [Short description of the fix]
- **Status:** merged
- **Priority:** high
- **Owner role:** developer
- **Depends on:** —
- **Source:** Hotfix — [one-line incident description, date]
- **Acceptance criteria:**
  - [What the fix does — past tense]
  - [How it was verified]
- **Verification type:** runtime
- **Evidence expected:** git commit [hash] — [commit message]
```

### TASK_STATUS.md entry

```markdown
### T-NNN — [Short description of the fix]
- **Status:** merged
- **Owner role:** developer
- **Verification type:** runtime
- **Last verified by:** main_agent
- **Evidence:** git commit [hash] — [commit message]; [brief description of what was tested]
- **Notes:** Hotfix applied [date]. Retroactive registration per RETROACTIVE_TASK_PATTERN.md.
```

---

## After registering a retroactive task

1. Update `last_task_id` in `PROCESS_STATE.json` if the new T-NNN is higher than the current value.
2. Run `./scripts/mavp-operator --validate` — confirm it exits 0.
3. Commit the retroactive task registration with a message that includes both the fix commit hash and the word "retroactive".

---

## Worked example — T-074 (2026-04-24)

**Incident:** During the example-project pilot session on 2026-04-24, running `./scripts/mavp-operator --install --update` in example-project crashed with `EISDIR`. The root cause was that `.claude/skills/frontend-design` existed as a symlink in the mavericks source but as a plain directory in the target repo. The install script called `fs.copyFileSync` on what it expected to be a file, hitting the symlink and crashing.

**Fix applied:** Before any task was registered, the developer patched `scripts/mavp-install.js` — both `updateDirRecursive` and `copyDirRecursive` were updated to treat symlinks-to-directories the same as plain directories (added `|| (entry.isSymbolicLink() && fs.statSync(srcPath).isDirectory())` to the directory check). The fix was committed and `--install --update` re-run successfully: 17 files synced including `frontend-design/SKILL.md`.

**Retroactive BACKLOG.md entry actually used:**

```markdown
### T-074 — Fix mavp-install.js symlink-to-directory handling in --update mode
- **Status:** merged
- **Priority:** high
- **Owner role:** developer
- **Depends on:** —
- **Source:** Incident 2026-04-24 — `./scripts/mavp-operator --install --update` crashed with `EISDIR` in example-project when `.claude/skills/frontend-design` was a symlink in mavericks but a plain directory in the target repo
- **Acceptance criteria:**
  - Both `updateDirRecursive` (--update mode) and `copyDirRecursive` (install mode) in `scripts/mavp-install.js` treat symlinks-to-directories the same as plain directories (recurse into them rather than calling `copyFileSync`)
  - `./scripts/mavp-operator --install --update` completes without error when source contains symlinks to directories
- **Verification type:** runtime
- **Evidence expected:** `--install --update` run exits 0 and lists synced files including those under `frontend-design/`
```

**What `last_task_id` drift looked like:** At the time T-074 was created, `PROCESS_STATE.json` still showed `"last_task_id": 73`. A subsequent `--new-task` call (without the fix from T-075) would have assigned T-074 again — a duplicate ID collision. T-075 implements auto-increment to prevent this.

---

## Why this exception exists

Strictly forbidding retroactive registration would create a perverse incentive: agents would delay emergency fixes to open a task first, making outages longer. The hotfix-first exception acknowledges this reality while containing the exception: it is time-bounded (same session), scope-bounded (emergency only), and requires immediate cleanup (retroactive registration before session close).
