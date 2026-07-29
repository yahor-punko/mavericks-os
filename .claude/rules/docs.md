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
- **Publish-manifest registration** — if the repo contains `scripts/publish-manifest.json`, every new git-tracked file must be classified there in the same task: ship for framework content, exclude with a one-line reason for internal material. Roles whose scope excludes `scripts/` must instead emit `MANIFEST_REGISTRATION_NEEDED: <path> -> <ship|exclude> (<reason>)` in their final report so the Main Agent registers it. Developers editing the manifest run `node scripts/check-publish-manifest.js` and quote its output in evidence. See DR-002 (`docs/core/DECISIONS.md`). **Brief authors: never forbid a developer's self-registration line and never route a developer through the token above — the token is for scope-forbidden roles only.** `.claude/hooks/pre-commit`'s blocking backstop makes developer self-registration mandatory: a worktree with an unclassified new file cannot commit at all, token or no token. See DR-007 (`docs/core/DECISIONS.md`) for the incident and the parallel-conflict merge protocol for colliding developer registrations.
- **Frozen changelog sections** — never add to or edit a `CHANGELOG.md` section whose version is already tagged on the public mirror; see `docs/PUBLIC_RELEASE_STRATEGY.md` §5 "Frozen-section rule" for the rule and the mirror-tag verification command to run first.
