# Architect Output Format

This document specifies the structured output format the architect sub-agent must use when returning a task decomposition block. The `--apply-decomposition` command reads this format to automatically register tasks in `BACKLOG.md` and `TASK_STATUS.md`.

## When to include a decomposition block

Include a decomposition block in every architect response that results in a concrete set of implementation tasks. Omit it only when the output is a pure exploratory analysis with no actionable next steps (e.g., a feasibility study that concludes "do not build").

## Decomposition block format

The block is wrapped in HTML comment delimiters so it remains invisible in rendered markdown but is machine-readable:

```
<!-- mavp-decomposition-start -->
title: Task title here
owner_role: developer
depends_on: —
verification_type: runtime
problem: One-sentence problem description.
acceptance_criteria: What done looks like.
evidence_expected: commit: <hash> branch: <name>
---
title: Another task
owner_role: product-docs
depends_on: —
verification_type: artifact
problem: One-sentence problem description.
acceptance_criteria: What done looks like.
evidence_expected: validator healthy, diff shows new file
<!-- mavp-decomposition-end -->
```

Rules:
- Each field is `key: value` on a single line. No indentation. No markdown bullets.
- Tasks are separated by a line containing only `---`.
- The block may appear anywhere in the markdown response — beginning, middle, or end.
- Do not include `id:` or `status:` fields — `--apply-decomposition` assigns those automatically.
- `repo:` is optional (see the Optional fields table below) — omit it when the task has no known repo yet, or when a batch-level `--repo` default is being supplied via the CLI.
- Use an em-dash (`—`) for `depends_on:` when there are no dependencies.

## Field reference

### Required fields

| Field | Description |
|---|---|
| `title:` | Short imperative title (matches BACKLOG.md task title convention). |
| `owner_role:` | Who implements: `developer`, `product-docs`, `technical-writer`, `qa`, `ux`, `security-reviewer`, `frontend-design`, `ui-designer`, `analyst`, `exa-researcher`, `main_agent` (exploration tasks only). No `infra` role exists — do not emit it. |
| `depends_on:` | Em-dash (`—`) if none; otherwise the T-NNN ID of the blocking task. Written verbatim into BACKLOG.md — `--apply-decomposition` does not resolve task titles to IDs. |
| `verification_type:` | One of: `artifact`, `runtime`, `visual`, `manual`. Matches the BACKLOG.md convention. |
| `problem:` | One sentence: what pain or gap this task addresses. |
| `acceptance_criteria:` | One sentence: what "done" looks like from the outside. **For `verification_type: runtime` tasks, this MUST include a behavioral assertion** — a known input and the expected observable output that input must produce. "Script runs without error" or "exit code 0" alone is a structural check and is not sufficient. Concrete example: "given known-spam message X, the model output classifies it `spam`; given known-ham message Y, the model output classifies it `ham`" — not "the script executes and returns an output tensor." Anti-pattern this rule prevents: a degenerate ONNX spam-classification model reached production because its acceptance check asserted only correct tensor shape (`[1,128]` in → `[1,2]` out); the model had collapsed to a constant output and never separated spam from ham. Structure-only checks (shape, exit code, "no exception thrown") cannot catch this class of defect. |

### Optional fields

| Field | Description |
|---|---|
| `evidence_expected:` | Hint for QA: what evidence the task should produce (e.g., `commit: <hash> branch: <name>` or `validator healthy`). |
| `requires_ux:` | `true` if the task needs a UX review stage. Omit or set `false` otherwise. |
| `requires_security_review:` | `true` if the task needs a security review stage. Omit or set `false` otherwise. |
| `touches:` | Comma-separated list of file paths the task is expected to modify. |
| `type:` | Task category, matching BACKLOG.md's existing `- **Type:**` convention (values in use: `feature`, `debt`, `bug`, `improvement`, `docs`, `initiative`, `exploration`). Defaults to `feature` when omitted. Use `type: debt` for a follow-up task that pays down a workaround — see the architect's Workaround rule in `.claude/agents/architect.md`. |
| `repo:` | Repo name this task touches — a single name (e.g. `repo: repo-a`) or comma-separated names for a cross-repo task (e.g. `repo: repo-a, repo-b`). `--apply-decomposition` writes a single repo as `- **Repo:** <name>` and multiple repos as `- **Repos:** a, b` into BACKLOG.md, matching the cross-repo evidence convention in `CLAUDE.md`. Per-task `repo:` overrides the batch `--repo <name>` CLI default when both are present. Omit entirely to leave the task with no Repo field. |

> **Note:** since T-302, `--apply-decomposition`'s field parser recognises `type:` as part of its allowlist and emits it as `- **Type:** <value>` into the registered BACKLOG.md entry automatically. No manual annotation is required.

## What NOT to include

- `id:` — assigned automatically by `--apply-decomposition` based on `last_task_id` in `PROCESS_STATE.json`.
- `status:` — always `planned` on registration; set by the Main Agent.
- Markdown headers, bullets, or any formatting inside the block — plain `key: value` lines only.

## What `--apply-decomposition` does

The `--apply-decomposition [FILE] [--repo <name>]` operator command parses this block and:
1. Assigns sequential T-NNN IDs continuing from `last_task_id`.
2. Appends entries to `BACKLOG.md` with status `planned`, writing a `- **Repo:**`/`- **Repos:**` line when a task's `repo:` field or the batch `--repo <name>` CLI default resolves to a value (per-task `repo:` wins when both are present).
3. Appends stub entries to `TASK_STATUS.md`.
4. Increments `last_task_id` in `PROCESS_STATE.json`.
5. Runs the validator to confirm artifact sync.
