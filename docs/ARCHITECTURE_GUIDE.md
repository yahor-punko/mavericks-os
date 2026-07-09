# Architecture Documentation Guide

This guide defines the standard mechanism for capturing and maintaining project architecture documentation in Mavericks-managed projects.

It covers two scenarios:

- **Scenario A — Existing project**: Architecture is already partially built. Documentation is added progressively without a big-bang sprint.
- **Scenario B — New project**: Nothing exists yet. Documentation is scaffolded upfront as part of `mavp-install`.

---

## 1. Architecture document overview

Every Mavericks project should maintain a single file: `docs/ARCHITECTURE.md`.

This file is the human-readable, version-controlled source of truth for how the project is built. It is not auto-generated — it is maintained by the main agent and updated incrementally alongside feature work.

**Key properties:**

- Static Markdown + Mermaid diagrams (no live generation, no build-time tooling required)
- Versioned in git alongside the project codebase
- Declared as a `context_docs` reference in `docs/MODULES.md` for relevant modules
- Updated when tasks touch infrastructure — flagged via `update_architecture: true` on those backlog tasks
- A `DRAFT` marker on individual sections signals incomplete coverage; this is normal and expected for existing projects in early documentation passes

---

## 2. Template structure

Below is the canonical template for `docs/ARCHITECTURE.md`. Copy it verbatim when bootstrapping a new project or beginning the first documentation pass on an existing project. Replace every `[placeholder]` with project-specific content. Mark any section you cannot fill in yet with `> DRAFT — to be completed in Wave N`.

```markdown
# Architecture — [Project Name]

> Last updated: YYYY-MM-DD  
> Mavericks wave: N  
> Coverage: DRAFT | PARTIAL | COMPLETE

---

## Overview

One-paragraph summary of what this project does and who uses it.

---

## Services and components

List every independently deployable unit. For each:

| Component | Type | Language / Runtime | Repo path | Description |
|---|---|---|---|---|
| `component-name` | Lambda / API / Worker / SPA / CLI / ... | Python 3.12 / Node.js 20 / ... | `lambda/handler_name/` | One-line description |

---

## Deploy contours

Environments this project has, how code reaches each one, and what differs between them.

| Contour | Branch | Trigger | URL / endpoint |
|---|---|---|---|
| dev | `develop` | push | https://dev.example.com |
| prod | `main` | push | https://example.com |

---

## Inter-service integrations

How this project's components communicate with each other and with external systems.

### Internal communication

```
ComponentA → [SQS queue: queue-name] → ComponentB
ComponentA → [DynamoDB: table-name] → ComponentC (reads)
```

### External dependencies

| Dependency | Type | Direction | Purpose |
|---|---|---|---|
| Stripe | HTTP API | outbound | Payment processing |
| Telegram Bot API | HTTP API | inbound + outbound | Bot command handling |
| AWS SES | SDK | outbound | Transactional email |

---

## Data flows

Key request paths through the system, written as numbered steps or ASCII diagrams.

### Flow: [Name of flow]

```
1. Client sends POST /api/endpoint
2. API Gateway authenticates via Lambda Authorizer
3. Router Lambda dispatches to handler
4. Handler reads from DynamoDB table-name
5. Handler writes result to SQS queue-name
6. Worker Lambda processes queue message
7. Response returned to client
```

Mermaid alternative (optional):

\```mermaid
sequenceDiagram
    Client->>API Gateway: POST /api/endpoint
    API Gateway->>Auth Lambda: validate token
    Auth Lambda-->>API Gateway: allowed
    API Gateway->>Router Lambda: dispatch
    Router Lambda->>Handler Lambda: invoke
    Handler Lambda->>DynamoDB: read
    Handler Lambda->>SQS: enqueue
\```

---

## Infrastructure components

All cloud or infrastructure resources this project provisions or depends on.

| Resource | Type | Name / ARN pattern | Purpose |
|---|---|---|---|
| `group-settings` | DynamoDB table | `group-settings` | Stores per-group configuration |
| `updates-queue` | SQS queue | `example-updates-queue` | Decouples inbound updates from processing |
| CloudFront distribution | CDN | `dxxxxxxxxxx` | Serves SPA + API routing |
| S3 bucket | Object store | `example-frontend-prod` | SPA static assets |

---

## Configuration and secrets

Environment variables, SSM parameters, or secrets manager paths this project requires. Do not write actual values here.

| Key | Source | Scope | Purpose |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | AWS Secrets Manager | prod only | Stripe API calls |
| `BOT_TOKEN` | SSM Parameter Store | all contours | Telegram bot identity |
| `DYNAMODB_TABLE_PREFIX` | Lambda env var | all contours | Table name prefix per environment |

---

## Key design decisions

Record non-obvious architectural choices so future maintainers understand why the system is built the way it is.

| Decision | Alternatives considered | Reason chosen |
|---|---|---|
| SQS between ingest and processing | Direct Lambda invoke | Decouples throughput spikes; retry semantics |
| DynamoDB over RDS | PostgreSQL | Schemaless updates; no connection pool management |

---

## Known gaps and future work

Sections documented as DRAFT, architectural debt, or planned structural changes.

- [ ] Section "Deploy contours" — complete in Wave N when CI/CD pipeline is established
- [ ] Migrate from direct Lambda→Lambda calls to SQS for async processing (tracked: T-NNN)
```

---

## 3. Scenario B — New project flow

### What changes in `mavp-install`

The installer copies `templates/ARCHITECTURE.md` into `docs/ARCHITECTURE.md` when the file does not already exist. This is identical to how `BACKLOG.md` and `MODULES.md` are bootstrapped: copy-if-missing, never overwrite.

The installer also adds `docs/ARCHITECTURE.md` to `.npmignore` and `.dockerignore` alongside other Mavericks files.

No new `--init-architecture` command is needed. The install flow already handles template copying. The bootstrap guide and new project checklist gain one item pointing to the template.

### Minimum viable architecture doc at project start

At bootstrap time, the developer fills in only:

1. **Overview** — one paragraph: what the project does and who uses it
2. **Services and components** — table of planned components (even if not yet built — mark as `PLANNED`)
3. **Deploy contours** — even if only one environment exists at first

All other sections start with `> DRAFT`. This takes 10–15 minutes and immediately becomes a shared reference that every sub-agent can read via `context_docs`.

### Bootstrap checklist addition

Append to `docs/core/NEW_PROJECT_CHECKLIST.md`:

```markdown
## Architecture documentation

- [ ] `docs/ARCHITECTURE.md` created (auto-copied by installer if missing)
- [ ] Overview section filled in
- [ ] Services and components table populated with planned components
- [ ] Deploy contours recorded (even if only one exists)
- [ ] Remaining sections marked DRAFT with wave target (e.g. `> DRAFT — Wave 2`)
```

---

## 4. Scenario A — Existing project (progressive documentation)

### First-pass approach

For an existing project, the goal is: cover 60–70% of the system in a single focused pass, then fill in the rest wave by wave. Do not attempt completeness upfront.

**Recommended first-pass scope (single exploration task):**

Create a Mavericks task of type `exploration` to produce the first version of `docs/ARCHITECTURE.md`:

```
- **Type:** exploration
- **Output doc:** docs/ARCHITECTURE.md
- **Owner role:** main_agent
- **Verification type:** artifact
- **Acceptance criteria:** docs/ARCHITECTURE.md exists with Overview, Services, Deploy contours, and Data flows sections populated; remaining sections marked DRAFT.
```

The main agent performs this task by reading `CLAUDE.md`, Terraform configs, Lambda source files, and CI config — the same files a developer would read when joining a project. No code is written. The output is the doc.

### DRAFT section marker

Use a blockquote starting with `DRAFT` to mark incomplete sections. This is purely a human convention — the validator does not check for DRAFT markers, but operators can grep for them.

```markdown
> DRAFT — Inter-service integrations: SQS flows not yet documented. Target: Wave 5.
```

A section with a DRAFT marker is better than a missing section. It signals that coverage is known to be incomplete, names a wave target, and prevents sub-agents from guessing at undocumented behaviour.

### Coverage field

The `Coverage` field in the document header tracks overall completeness:

| Value | Meaning |
|---|---|
| `DRAFT` | Initial pass begun, most sections incomplete |
| `PARTIAL` | Core sections complete; some DRAFT sections remain |
| `COMPLETE` | All sections complete; updated within the last 3 waves |

Update `Coverage` at the start of each new pass. This is a manual field — it is not computed.

### Relating tasks to architecture updates

When a backlog task modifies infrastructure (adds a Lambda, changes a queue, adds a DynamoDB table, adds an API endpoint, changes an environment variable), it should declare:

```
- **Update architecture:** true
```

This is a soft convention — the validator emits a warning (`architecture_doc_stale`) when a task with `update_architecture: true` reaches `merged` status but the `Last updated` date in `docs/ARCHITECTURE.md` is older than the task's merge wave.

The warning is advisory (exit code 1, not 2). It does not block commits. It reminds the main agent to update the architecture doc before closing the wave.

### Wave-end convention

Before running `--close-session`, check whether any merged task in the wave had `update_architecture: true`. If so, update `docs/ARCHITECTURE.md` and update the `Last updated` date and `Mavericks wave` fields in the document header.

This keeps the doc one wave behind at most.

---

## 5. Maintenance workflow

### Ownership

The architecture doc is owned by the **main agent** — the orchestrator. Sub-agents (developer, qa, ux) do not modify it unless explicitly tasked to fill in a specific section as a scoped exploration task.

The main agent updates the doc:
- When a task with `update_architecture: true` merges
- When an `exploration` task targeting the doc completes
- At the start of a new wave if DRAFT sections can now be filled

### Validator integration

Add one new warning check to `mavp-validator.js`:

**`architecture_doc_stale`** — emitted when:
1. A task in the current wave's merged set has `update_architecture: true`, AND
2. The `Last updated` date in `docs/ARCHITECTURE.md` (parsed from the `> Last updated:` line) is earlier than the wave open date recorded in `PROCESS_STATE.json`.

Severity: `warning` (exit code 1, non-blocking).

The check is silently skipped when `docs/ARCHITECTURE.md` does not exist (to avoid noise on projects that have not yet adopted the guide).

### Module registry relationship

`docs/MODULES.md` and `docs/ARCHITECTURE.md` are complementary but serve different purposes:

| File | Purpose | Audience |
|---|---|---|
| `docs/MODULES.md` | Task-to-codebase mapping; drives `--agent` JSON enrichment | Mavericks tooling + sub-agents |
| `docs/ARCHITECTURE.md` | Human-readable system design; explains the why and how | All agents + human reviewers |

They do not replace each other. A module entry in `MODULES.md` should include `docs/ARCHITECTURE.md` as a `context_docs` reference for any module that touches infrastructure:

```
- **context_docs:** docs/core/TASK_LIFECYCLE.md, docs/ARCHITECTURE.md
```

`MODULES.md` does not expand to absorb architecture content. The architecture doc is a separate, richer document.

### No new PROCESS_STATE.json fields

The architecture mechanism does not require new PROCESS_STATE.json fields. The `update_architecture: true` task field, the `Last updated` header in the doc itself, and the wave field in PROCESS_STATE.json are sufficient for the validator check.

---

## 6. Integration with existing Mavericks primitives

### New task field: `update_architecture`

Added to `BACKLOG_TEMPLATE.md` as an optional field:

```markdown
- **Update architecture:** false
```

Set to `true` on any task that:
- Adds, removes, or changes a Lambda, service, or worker component
- Adds, modifies, or removes a queue, database table, or external integration
- Changes an API endpoint path or authentication mechanism
- Adds or removes a deploy environment (contour)
- Adds, removes, or renames a required configuration key or secret

### New template: `templates/ARCHITECTURE.md`

The file copied by `mavp-install` into `docs/ARCHITECTURE.md`. Contains all sections from Section 2 above, with `[placeholder]` values and all non-essential sections pre-marked as `> DRAFT`.

### Updated `BACKLOG_TEMPLATE.md`

Add `- **Update architecture:** false` to the task template, positioned after `- **Stale risk:**`.

### Updated `docs/core/NEW_PROJECT_CHECKLIST.md`

Add architecture documentation checklist block (see Section 3 above).

### Updated `docs/core/BOOTSTRAP_GUIDE.md`

Add one sentence under "What gets installed":

> `docs/ARCHITECTURE.md` — architecture document template (fill in at project start)

And add to the "Next steps" block:

> `4. Fill in `docs/ARCHITECTURE.md` — Overview, Services, Deploy contours (mark the rest DRAFT)`

### Validator warning: `architecture_doc_stale`

Described in Section 5. Implementation touches `mavp-validator.js`. The check reads the `> Last updated:` line from `docs/ARCHITECTURE.md` using a simple regex — no Markdown parser required.

---

## 7. Implementation task decomposition

Tasks start from T-151. Each is independently deliverable. The dependency graph is linear for the validator task (which depends on the template existing first), and parallel for doc updates.

### T-151 — Add `docs/ARCHITECTURE.md` template to mavericks

- **Owner:** product-docs
- **Verification type:** artifact
- **Files to modify:** `templates/ARCHITECTURE.md` (new file)
- **Acceptance criteria:** `templates/ARCHITECTURE.md` exists and contains all sections from the template in Section 2 of this guide, with appropriate `[placeholder]` values and DRAFT markers on non-essential sections.
- **Evidence expected:** validator healthy, diff shows new file

### T-152 — Wire architecture template into `mavp-install`

- **Owner:** developer
- **Depends on:** T-151
- **Verification type:** runtime
- **Files to modify:** `scripts/mavp-install.js`
- **Acceptance criteria:** Running `node scripts/mavp-install.js <fresh-dir>` copies `templates/ARCHITECTURE.md` to `docs/ARCHITECTURE.md` in the target project (skip if already exists). The install summary line reads: `✓ docs/ARCHITECTURE.md (from template)`.
- **Evidence expected:** commit: `<hash>` branch: main, installer output shows the new line when run against a clean directory

### T-153 — Add `update_architecture` field to BACKLOG_TEMPLATE.md

- **Owner:** product-docs
- **Depends on:** —
- **Verification type:** artifact
- **Files to modify:** `templates/BACKLOG_TEMPLATE.md`
- **Acceptance criteria:** The task template in `BACKLOG_TEMPLATE.md` includes `- **Update architecture:** false` positioned after `- **Stale risk:**`.
- **Evidence expected:** validator healthy, diff shows the new line

### T-154 — Add `architecture_doc_stale` validator check

- **Owner:** developer
- **Depends on:** T-151
- **Verification type:** runtime
- **Files to modify:** `scripts/mavp-validator.js`
- **Acceptance criteria:** When a merged task has `Update architecture: true` and `docs/ARCHITECTURE.md`'s `Last updated:` date is older than the PROCESS_STATE.json `last_updated` date, the validator emits a `architecture_doc_stale` warning (exit code 1). When `docs/ARCHITECTURE.md` does not exist, the check is silently skipped. Existing validator tests continue to pass.
- **Evidence expected:** commit: `<hash>` branch: main, manual test: validator warns on a task with `update_architecture: true` and a stale doc date

### T-155 — Update `docs/core/NEW_PROJECT_CHECKLIST.md` with architecture step

- **Owner:** product-docs
- **Depends on:** T-151
- **Verification type:** artifact
- **Files to modify:** `docs/core/NEW_PROJECT_CHECKLIST.md`
- **Acceptance criteria:** Checklist includes an "Architecture documentation" section with the five items listed in Section 3 of this guide.
- **Evidence expected:** validator healthy, diff shows new section

### T-156 — Update `docs/core/BOOTSTRAP_GUIDE.md` to reference architecture template

- **Owner:** product-docs
- **Depends on:** T-151
- **Verification type:** artifact
- **Files to modify:** `docs/core/BOOTSTRAP_GUIDE.md`
- **Acceptance criteria:** "What gets installed" table includes `docs/ARCHITECTURE.md`. "Next steps" block includes step 4 pointing to the architecture doc.
- **Evidence expected:** validator healthy, diff shows two additions

### T-157 — Update MODULES.md template to reference `docs/ARCHITECTURE.md` in `context_docs`

- **Owner:** product-docs
- **Depends on:** T-151
- **Verification type:** artifact
- **Files to modify:** `templates/MODULES.md`
- **Acceptance criteria:** The example module entries in `templates/MODULES.md` include `docs/ARCHITECTURE.md` as a `context_docs` reference alongside `docs/core/TASK_LIFECYCLE.md`.
- **Evidence expected:** validator healthy, diff shows updated context_docs lines

### Dependency graph

```
T-151 (template)
  ├── T-152 (installer)
  ├── T-154 (validator check)
  ├── T-155 (checklist)
  ├── T-156 (bootstrap guide)
  └── T-157 (modules template)

T-153 (backlog template) — independent
```

Critical path: T-151 → T-154 (validator is the most complex deliverable and depends on the template existing for its skip-if-absent behaviour to be testable)

Secondary path: T-151 → T-152 (installer must reference a template that exists)

T-153, T-155, T-156, T-157 can be parallelised after T-151 merges.

---

## 8. Design decisions and trade-offs

### Single file vs. per-service docs

**Decision:** Single `docs/ARCHITECTURE.md` per project.

**Trade-off:** For very large projects (10+ services), a single file may become unwieldy. The alternative — per-service files like `docs/architecture/lambda-handler.md` — increases maintenance surface and makes cross-service data flows harder to read.

**Rationale:** The template uses tables and Mermaid diagrams that scale reasonably to 10–15 services. A single file is easier for a sub-agent to load as context and easier for a human to review. If a project genuinely outgrows this, the `context_docs` field in MODULES.md can point to per-service supplement files without changing the core mechanism.

### Mermaid vs. ASCII-only diagrams

**Decision:** Mermaid is recommended but not required.

**Rationale:** Mermaid renders in GitHub, GitLab, and most Markdown viewers. For simple flows, ASCII is faster to write and easier to edit in plain text. The template provides both options where applicable. Sub-agents generating updates for the first time should default to ASCII; Mermaid can be added in a dedicated polish pass.

### Validator warning vs. hard block

**Decision:** `architecture_doc_stale` is a warning (exit code 1), not a failure (exit code 2).

**Rationale:** An outdated architecture doc does not break the project. Blocking commits for a doc that is 1–2 waves behind would be disruptive. The warning surfaces the staleness without blocking delivery. Teams that want stricter enforcement can override the severity in their project's validator config if that feature is added later.

### `update_architecture` is opt-in per task

**Decision:** The field defaults to `false`. Tasks declare `true` explicitly when they touch infrastructure.

**Trade-off:** Relies on the main agent noticing that a task modifies infrastructure. An automated approach (e.g., scanning modified files) would be more reliable but would require the validator to understand which file paths correspond to infrastructure — too project-specific for a generic framework check.

**Rationale:** The main agent creates and reviews every backlog task. Adding `update_architecture: true` is a simple discipline check at task-creation time, similar to how `requires_ux` and `stale_risk` are currently handled.

---

## 9. Large project layout

### When to switch to federated layout

A single `docs/ARCHITECTURE.md` works well for most projects. Switch to a federated layout when either condition is true:

- `docs/ARCHITECTURE.md` exceeds **~150 lines**, OR
- any single service/module section exceeds **~50 lines**

This applies regardless of repo count — a single large monorepo or a legacy codebase with many modules follows the same rule.

Beyond these thresholds the file becomes difficult to navigate, and loading the entire document into agent context on every cross-repo task wastes token budget with sections irrelevant to the current work.

### Federated directory structure

```
docs/
  ARCHITECTURE.md              ← system overview: service catalog, integration map, data flows (~100 lines)
  architecture/
    <service-name>.md          ← per-service detail: env vars, queues, tables, metrics
```

`docs/ARCHITECTURE.md` becomes a **lightweight index**: it retains the service catalog table, inter-service integration map, data flows, and key design decisions — all the cross-cutting context every agent needs. It should stay around 100 lines.

Each `docs/architecture/<service-name>.md` file holds the detail that is only relevant when working on that specific service: environment variables, queue/topic names, table schemas, CloudWatch metric names, key dependencies, and deploy notes.

### How agents use the federated layout

1. Every agent reads `docs/ARCHITECTURE.md` first to get system context.
2. Before working on a specific service, the agent reads `docs/architecture/<target-service>.md` for that service only.
3. Agents do not load all per-service files at once — only the file for the service they are modifying.

Declare per-service files in `docs/MODULES.md` as additional `context_docs` entries on the relevant module so that `--agent` JSON surfaces them automatically.

### Splitting an existing monolithic ARCHITECTURE.md

1. For each service, create `docs/architecture/<service-name>.md` and move the per-service detail sections (env vars, queues, tables, metrics) into it.
2. In `docs/ARCHITECTURE.md`, replace each moved section with a one-line entry in the service catalog table and a link to the per-service file:

   ```markdown
   | `payment-processor` | Lambda | Python 3.12 | `lambda/payment_processor/` | Stripe charge handler — see [docs/architecture/payment-processor.md](architecture/payment-processor.md) |
   ```

3. Keep in `docs/ARCHITECTURE.md`: Overview, Services and components table (one line per service), Inter-service integrations map, Data flows (high-level), Key design decisions.
4. Update the `Last updated` date and `Coverage` field in the `docs/ARCHITECTURE.md` header.
5. Add each new `docs/architecture/<service-name>.md` as a `context_docs` reference in `docs/MODULES.md` for the corresponding module.

### Per-service file template

When creating a `docs/architecture/<service-name>.md` file, use this structure as a starting point:

```markdown
# [Service Name] — Architecture Detail

> Last updated: YYYY-MM-DD
> Mavericks wave: N

## Service identity

| Field | Value |
|---|---|
| Name | `service-name` |
| Repo | `repo-name` or `lambda/handler_name/` |
| Runtime | Python 3.12 / Node.js 20 / ... |
| Type | Lambda / API / Worker / SPA / CLI / ... |

## Environment variables

| Key | Source | Scope | Purpose |
|---|---|---|---|
| `ENV_VAR_NAME` | Lambda env var / SSM / Secrets Manager | all / prod only | [purpose] |

## Queues and topics

| Name | Type | Direction | Paired service |
|---|---|---|---|
| `queue-name` | SQS | inbound | [producer service] |

## Tables

| Name | Type | Access pattern |
|---|---|---|
| `table-name` | DynamoDB | read by key: `pk` |

## CloudWatch metrics and alarms

| Metric / Alarm | Namespace | Purpose |
|---|---|---|
| `ErrorCount` | `[project]/[service]` | Alerts on Lambda errors |

## Key dependencies

List external services, shared libraries, or other internal services this service directly calls.

- [DependencyName] — [why it is needed]

## Known gaps

- [ ] [anything not yet documented]
```
