# Module Registry — Schema Reference

This file defines the **format** for module declarations used in Mavericks-managed projects.

**This file belongs to the project, not the framework.** Each project that adopts Mavericks
should maintain its own `docs/MODULES.md` with its own module types.

When you bootstrap a new project with `node scripts/mavp-install.js <target-dir>`, a starter
template is copied to `docs/MODULES.md` in the target project. Rename and fill in the entries
for your project's actual modules.

---

## What modules are used for

Tasks in `BACKLOG.md` may declare `- **Module:** <id>` to associate a task with a module.

The `--agent` JSON output will include `module` and `context_docs` fields for each task that
has a matching module declared in this file.

The validator will warn when a task declares a `Module:` field whose ID is not listed in
`docs/MODULES.md`. If `docs/MODULES.md` is absent, the module check is silently skipped.

---

## Required fields per entry

Each module entry must be a `## <id>` section with these fields:

| Field | Type | Description |
|---|---|---|
| `label` | string | Human-readable display name |
| `repos` | comma-separated | Repos that contain this module's code |
| `context_docs` | comma-separated | Docs an agent should read when working on this module |
| `default_owner` | string | Default sub-agent role for tasks in this module |
| `qa_checklist` | list | QA steps specific to this module |

---

## Example entry (generic placeholder — replace with your own)

    ## my-module

    - **label:** My Module
    - **repos:** my-repo
    - **context_docs:** docs/core/TASK_LIFECYCLE.md
    - **default_owner:** developer
    - **qa_checklist:**
      - Describe one QA step specific to this module
      - Describe another QA step

---

> Projects declare their own module types here. The mavericks framework does not define
> any module types — it only defines the format above.

---

## Task types (framework-level)

The `exploration` task type is a framework-level convention — not a module ID, but a
**task type** declared with `- **Type:** exploration` in the task entry.

Use `exploration` for:
- Internal data research producing a docs artifact (no deliverable code)
- Analysis, simulations, architectural assessments
- Research tasks whose output is an analytical document, not shipped code

Required fields when `- **Type:** exploration` is declared:
- `- **Output doc:** <path>` — path to the document that will be created or updated
- `- **Owner role:** main_agent` — exploration tasks are owned by the main agent
- `- **Verification type:** artifact` — output is a doc artifact, not running code
