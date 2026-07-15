# Repo Map

Customize this file for your project. Each `## <id>` section declares a repo entry.
Tasks in `BACKLOG.md` may reference repos with `- **Repo:** <id>` (or `- **Repos:** <id-a>, <id-b>`
for cross-repo tasks).

The validator warns when a task declares a `Repo:`/`Repos:` value that is not a known ID here.

See `docs/REPO_MAP.md` in the mavericks framework for the full field reference.

---

## repo-a

- **label:** Repo A (rename this)
- **path:** /path/to/repo-a
- **domain:** (fill in — e.g. repo-a.example.com, or leave blank if none)
- **deploy_path:** (fill in — e.g. /var/www/repo-a, or leave blank if none)
- **downstream:** repo-b
- **docs:** repo-a/CLAUDE.md, docs/ARCHITECTURE.md

---

## repo-b

- **label:** Repo B (rename this)
- **path:** /path/to/repo-b
- **domain:** (fill in, or leave blank if none)
- **deploy_path:** (fill in, or leave blank if none)
- **downstream:** (fill in, or leave blank if none)
- **docs:** repo-b/CLAUDE.md
