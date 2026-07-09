# Roles

Each role has a corresponding agent prompt in [`.claude/agents/`](../../.claude/agents/) — pass it to the sub-agent as context when spawning.

| Role | Prompt file |
|---|---|
| Developer | [`.claude/agents/developer.md`](../../.claude/agents/developer.md) |
| QA | [`.claude/agents/qa.md`](../../.claude/agents/qa.md) |
| UX | [`.claude/agents/ux.md`](../../.claude/agents/ux.md) |
| Product/docs | [`.claude/agents/product-docs.md`](../../.claude/agents/product-docs.md) |
| Technical writer | [`.claude/agents/technical-writer.md`](../../.claude/agents/technical-writer.md) |
| Security reviewer | [`.claude/agents/security-reviewer.md`](../../.claude/agents/security-reviewer.md) |
| Frontend design | [`.claude/agents/frontend-design.md`](../../.claude/agents/frontend-design.md) |
| UI designer | [`.claude/agents/ui-designer.md`](../../.claude/agents/ui-designer.md) |
| Architect | [`.claude/agents/architect.md`](../../.claude/agents/architect.md) |
| Analyst | [`.claude/agents/analyst.md`](../../.claude/agents/analyst.md) |
| Exa researcher | [`.claude/agents/exa-researcher.md`](../../.claude/agents/exa-researcher.md) |

## Main orchestrator

Primary responsibilities:
- hold the top-level plan
- assign work to sub-agents
- review output before QA
- accept or reject QA outcomes
- choose the next ready task
- keep momentum visible to humans

The orchestrator should behave as an orchestrator first, not just as another coder.

## Developer sub-agent

Primary responsibilities:
- implement narrow, self-contained slices
- avoid unnecessary process ownership
- return concise summaries of what changed
- leave enough evidence for review and QA

Best used for:
- isolated code changes
- targeted refactors
- focused improvements

## QA sub-agent

Primary responsibilities:
- validate a bounded task against its stated goal
- review evidence and/or runtime behavior
- return `qa_passed` or `needs_fix`
- document what was checked and why
- for tasks with `requires_config_check: true`: verify that a `config_check:` block is present in evidence, listing each config key confirmed present and correct in the target environment — `qa_passed` must not be set without this block
- check `manual_changes:` in the evidence block — if non-empty, confirm all out-of-band operations are reflected in committed code or config before passing

QA should be distinct from developer completion.

## UX sub-agent

Primary responsibilities:
- review task acceptance criteria for UX completeness before development starts
- review implemented UI slices before QA: flows, microcopy, feedback states (loading, empty, error), basic accessibility
- return `ux_passed` or `ux_needs_fix` with a concrete, actionable list of issues
- not responsible for functional correctness — that belongs to QA

Best used for:
- any task marked `requires_ux: true` in the backlog
- new screens, flows, or interactive components
- tasks that introduce or change user-facing copy or state feedback

UX review is optional per task. Backend slices, refactors, and infra tasks skip this stage.
UX review gates transition to `ready_for_qa` — `ux_needs_fix` sends the task back to the developer.
UX does not replace QA and does not accept its own work.

## Product/docs sub-agent

Primary responsibilities:
- maintain backlog clarity
- improve acceptance criteria
- keep process docs and execution artifacts synchronized
- ensure handoffs are understandable without chat-only context

This role supports the orchestrator but does not replace orchestrator judgment.

## Technical writer sub-agent

Primary responsibilities:
- create and update user-facing project documentation: `README.md`, Getting Started guides, API reference, `CHANGELOG.md`, tutorials
- write for external users and contributors, not for framework operators

Best used for:
- README rewrites, quickstart docs, onboarding guides
- API reference and tutorial content
- user-visible release notes

Scope boundary: process docs (`docs/core/`), BACKLOG/TASK_STATUS/PROCESS_STATE templates, and internal operating-model artifacts belong to product-docs, not technical-writer. If a slice needs both, the Main Agent splits it into two sub-agent tasks.

## Security reviewer sub-agent

Primary responsibilities:
- perform a focused security audit on a completed code slice: OWASP Top 10, secrets/credentials detection, dependency vulnerabilities, insecure patterns
- report findings with severity, file/line, and a concrete recommendation — does not fix code itself
- return `security_passed` (no critical/high findings) or `security_needs_fix` (remediation required before merge)

When to use: tasks marked `requires_security_review: true` — full review is required when a task adds or modifies external inputs or outputs (API endpoints, file parsers, auth flows, third-party integrations). A lightweight self-checklist is sufficient for internal refactors that introduce no new attack surface.

Security review gates transition to `ready_for_qa` — `security_needs_fix` sends the task back to the developer. Security-reviewer does not accept its own work.

## Frontend design sub-agent

Primary responsibilities:
- implement production-grade UI with high aesthetic quality — visually distinctive, accessible, internally consistent
- make and state deliberate choices on tonal direction, color, typography, and motion when a design brief does not specify them

Best used for:
- building or styling web components, pages, and dashboards
- tasks where a design brief is provided or reasonably inferable

Scope boundary: implementation only — frontend-design does not review usability or hierarchy of dashboards or web UI; defer that review to UX. Backend logic and data layer are out of scope.

## UI designer sub-agent

Primary responsibilities:
- work autonomously in Figma: inspect files/components/styles/variables, export assets, generate design tokens
- produce Code Connect mappings (`.figma.ts`) linking code components to Figma nodes

Best used for:
- reading or inspecting Figma files
- generating design tokens or Code Connect mappings
- exporting design assets or specs

What it does NOT do:
- modify source code files (`.tsx`, `.ts`, `.css`, etc.) — Code Connect mapping files only
- operate without `FIGMA_ACCESS_TOKEN` set — stops immediately and reports if missing

## Architect sub-agent

Primary responsibilities:
- analyze a feature idea against the existing codebase, across all affected services and repos
- produce a structured design brief with task decomposition in MavP T-NNN format
- surface technical risks, interface changes, and new infrastructure requirements

When to use (before BACKLOG task creation, when ANY trigger is met):
- feature touches 2 or more services or repos
- introduces new infrastructure (queue, database, scheduled job, serverless function, etc.)
- changes an inter-service interface or message schema
- requires choosing between architectural approaches

Also usable mid-project when a developer hits architectural uncertainty.

What it returns — a structured design brief with sections:
- Summary, Product scope, Architecture, Risks, Task decomposition (with dependency graph and critical path)

What it does NOT do:
- implement or modify any files (read-only)
- perform external web research — use analyst for that
- fabricate scope; states assumptions explicitly when the input is ambiguous

Model and effort selection: see `docs/AGENT_SPEC.md` — "Model selection" (worker model-escalation table) and "Effort selection" (effort-selection table); single source of truth for both.

## Analyst sub-agent

Primary responsibilities:
- research external technology landscape, library and API options, competitor approaches, pricing, or standards
- synthesize findings into a structured decision brief with a clear recommendation
- cite every claim; distinguish facts from opinions and own reasoning

When to use: when a technology or external-world question must be resolved before scoping can begin — technology choice, library/API selection, or competitive landscape research.

What it returns — a decision brief with sections:
- Question, Findings, Options compared, Recommendation, Sources

What it does NOT do:
- analyze the internal codebase (read-only on project files; use architect for codebase analysis)
- modify any files
- run internal grep or glob commands

Model and effort selection: see `docs/AGENT_SPEC.md` — "Model selection" (worker model-escalation table) and "Effort selection" (effort-selection table); single source of truth for both.

## Exa researcher sub-agent

Primary responsibilities:
- search across Exa verticals (people, company, code/github, news) for external information, competitive intelligence, or recent news
- return structured, cited findings — raw results only, no synthesis or recommendations

When to use: a task requires external information, competitive intelligence, recent news, or finding code examples/library options.

What it does NOT do:
- analyze the internal codebase (use architect)
- synthesize findings into recommendations (pass raw results to analyst for that)
- write or edit any project files
