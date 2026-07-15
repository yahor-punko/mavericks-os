# Repo Map — Schema Reference

This file defines the **format** for repo declarations used in Mavericks-managed projects.

**This file belongs to the project, not the framework.** Each project that adopts Mavericks
should maintain its own `docs/REPO_MAP.md` with its own repo entries. This mirrors the
`docs/MODULES.md` project-owns-instance pattern exactly: the framework only defines the
schema below — it does not ship any repo entries of its own.

When you bootstrap a new project with `node scripts/mavp-install.js <target-dir>`, a starter
template (`templates/REPO_MAP_TEMPLATE.md`) is copied to `docs/REPO_MAP.md` in the target
project. Rename and fill in the entries for your project's actual repos.

---

## What the repo map is used for

Tasks in `BACKLOG.md` may declare `- **Repo:** <id>` (or `- **Repos:** <id-a>, <id-b>` for
cross-repo tasks). The repo map lets a task's `Repo:` value resolve to a local filesystem
path, a domain, a deploy path, and any downstream repos/services that depend on it.

The validator will warn (`unknown_repo_id`) when a task declares a `Repo:` field whose ID is
not listed in `docs/REPO_MAP.md`. If `docs/REPO_MAP.md` is absent, the repo-id check is
silently skipped — this is not an error condition, it just means the project has not opted in.

Tasks may also declare `- **Blocked by:** <repo>/T-NNN` (comma-separated for multiple). The
validator's cross-repo blocked-by check resolves `<repo>` through this same registry — using
the entry's `path` field to locate the blocker repo's working copy and read its
`BACKLOG.md`/`TASK_STATUS.md` — then gates a `merged`/`qa_passed`/`ready_for_qa` task on the
blocker task's status. See the **`Blocked by:` field** convention in `CLAUDE.md`.

---

## Required fields per entry

Each repo entry must be a `## <id>` section with these fields:

| Field | Type | Description |
|---|---|---|
| `label` | string | Human-readable display name |
| `path` | string | Local filesystem path to the repo's working copy |
| `domain` | string | Primary domain/hostname the repo serves (if any) |
| `deploy_path` | string | Deploy target path/location for this repo |
| `downstream` | comma-separated | IDs of repos/services that depend on this one |
| `docs` | comma-separated | Docs relevant to this repo (e.g. its own CLAUDE.md, architecture doc) |

---

## Example entry (generic placeholder — replace with your own)

    ## my-repo

    - **label:** My Repo
    - **path:** /path/to/my-repo
    - **domain:** my-repo.example.com
    - **deploy_path:** /var/www/my-repo
    - **downstream:** my-other-repo
    - **docs:** my-repo/CLAUDE.md, docs/ARCHITECTURE.md

---

> Projects declare their own repo entries here. The mavericks framework does not define
> any repo entries — it only defines the format above.
