# Module Registry

Customize this file for your project. Each `## <id>` section declares a module type.
Tasks in `BACKLOG.md` may reference modules with `- **Module:** <id>`.

The `--agent` JSON output enriches active task slices with `context_docs` from the
matching module entry. The validator warns when an unknown module ID is used.

See `docs/MODULES.md` in the mavericks framework for the full field reference.

---

## exploration

- **label:** Exploration (framework task type — do not rename)
- **owner_role:** main_agent
- **verification_type:** artifact
- **output_doc:** (required — set to the path of the doc this task produces)
- **notes:** Use for internal research, analysis, simulations, and any task whose output is a docs artifact rather than shipped code. Validator warns when output_doc: is missing on exploration tasks.

---

## module-a

- **label:** Module A (rename this)
- **repos:** your-repo
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/ARCHITECTURE.md
- **default_owner:** developer
- **qa_checklist:**
  - Add QA steps specific to this module
  - Verify expected behavior in staging before promoting

---

## module-b

- **label:** Module B (rename this)
- **repos:** your-repo
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/core/QA_HANDOFF.md, docs/ARCHITECTURE.md
- **default_owner:** developer
- **qa_checklist:**
  - Add QA steps specific to this module
  - Confirm no secrets appear in output or logs

---

## module-c

- **label:** Module C (rename this)
- **repos:** your-repo
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/ARCHITECTURE.md
- **default_owner:** developer
- **qa_checklist:**
  - Add QA steps specific to this module
  - Test edge cases and error paths
