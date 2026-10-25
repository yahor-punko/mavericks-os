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

The `qa_checklist` list ends at the next top-level `- **<field>:**` line or `##` heading, so a field written after it (such as `doc_limits`) is never read as a checklist item. Items are normally indented under the field; an unindented `- item` directly after the field line is also accepted.

### Optional fields per entry

| Field | Type | Description |
|---|---|---|
| `doc_limits` | comma-separated | Per-document character-limit exceptions for named `context_docs`, each written as `<path> max_chars: <N> (<owner>)` |

`doc_limits` lets one oversized context document carry its own character limit
instead of the project-wide per-document budget (`imported_doc_max_chars`, 40000 by
default) that the validator's `context_size_budget` advisory applies. Every exception
names its owner in the trailing parentheses, so a limit raised "just for now" always
has someone accountable for removing it again. The owner is any single
whitespace-free token: a task id (`T-NNN`), a decision record (`DR-NNN`), or a short
owner handle such as `docs-owner`. The owner names who removes the exception; it does
not have to be a task, so an exception that belongs to a standing decision or a
person or role can say so. The parsed entry exposes the token as `owner`.

The field sits on its own line, so the comma-split of `context_docs` is unaffected:
`context_docs` still lists plain paths, and `doc_limits` repeats only the paths that
need an exception. Entries that do not match the `<path> max_chars: <N> (<owner>)`
shape (for example an owner written as two words) are ignored.

The limits are a ratchet, not a free setting. The `doc_limit_ratchet` advisory
(info severity, never blocks) fires when an exception is raised above the value
recorded for the same path in the last commit's `docs/MODULES.md`, and when an
exception is smaller than the document's current size. To raise a limit, trim the
document instead.

---

## Example entry (generic placeholder — replace with your own)

    ## my-module

    - **label:** My Module
    - **repos:** my-repo
    - **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/ARCHITECTURE.md
    - **doc_limits:** docs/ARCHITECTURE.md max_chars: 60000 (T-123)
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
