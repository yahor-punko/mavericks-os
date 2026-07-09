---
paths:
  - "docs/**/*.md"
  - "templates/**/*.md"
---

# Docs and Templates Rules

- Docs are the source of truth for the operating model. Do not inline their content into CLAUDE.md — use `@path` imports instead.
- When updating a doc that is referenced from another doc (e.g. `docs/core/ORCHESTRATION_RULES.md` → `docs/AGENT_SPEC.md`), check that cross-references remain accurate.
- Templates in `templates/` are canonical starting points for new projects. Keep them minimal — do not add project-specific content.
- Role definitions live in `docs/core/ROLES.md`. The Main Agent is the orchestrator; do not introduce new top-level roles without a lightweight decision record.
