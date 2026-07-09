---
paths:
  - "scripts/**/*.js"
  - "scripts/mavp-operator"
---

# Scripts Rules

- Reporting surfaces are read-only operator tools — they report state, they do not modify it. This applies to: dashboard, `--snapshot`, `--agent`/`--watch`, and the validator. The mutating ritual scripts (close-session, new-task, quick-task, update-task, set-status, rename-task, apply-decomposition, merge-task) are explicitly exempt — they intentionally write artifacts as their primary purpose.
- `mavp-operator-lib.js` is shared logic; changes here affect all operator surfaces. Test snapshot and dashboard after any change.
- `mavp-validator.js` parses `## Active Wave` section in BACKLOG.md. If the section heading changes, update the regex in `parseBacklogActiveTasks()`.
- `mavp-operator-agent.js` is the Main Agent's session entry point — keep its JSON output schema stable. Any new fields are additive only.
- Do not add interactive prompts or side effects (file writes) to reporting surfaces (dashboard, snapshot, agent, validator). The mutating ritual scripts listed above are exempt: they may prompt users (close-session interactive mode) and write artifacts by design.
- Node.js only — no external npm dependencies for core operator tooling (dashboard, `--snapshot`, `--agent`/`--watch`, the validator, and all mutating ritual scripts). These must run with zero npm installs. The one exception is `@anthropic-ai/sdk`, declared in `optionalDependencies` in `package.json` and consumed only by `mavp-skill-reflect.js` (`--reflect-skill`) — it is `require()`d lazily inside that script's `main()` function, guarded by try/catch, never at module load. No other script may import it, directly or transitively. `npm install --omit=optional` (or a machine with no `node_modules` at all) must still leave every core command working; only `--reflect-skill` degrades, with a clear "install the optional dependency" error.
