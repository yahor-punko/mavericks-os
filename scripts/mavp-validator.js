#!/usr/bin/env node

/**
 * mavp-validator: artifact-sync validator parser + comparison engine + report renderer.
 * (Formerly parliamentary-validator-parser-v1.js — renamed under T-329.)
 *
 * Scope:
 * - parse active-task records from BACKLOG.md and TASK_STATUS.md
 * - normalize them into a stable comparison-friendly shape
 * - compare normalized records across both artifacts
 * - render compact human-readable validator output by default
 * - print inspectable JSON when requested
 *
 * Intentional non-goals:
 * - no advanced CLI packaging yet
 * - no PROCESS_STATE / packet / repair automation checks yet
 *
 * Assumptions documented from the implementation docs:
 * - task blocks begin with headings like `### T-XXX — ...`
 * - fields are markdown bullets like `- **Status:** value`
 * - TASK_STATUS active records live under `## Active tasks`
 * - BACKLOG active records are taken from `## Current pilot wave`
 *   and filtered to non-`merged` statuses so the result reflects the
 *   live backlog task set rather than the full historical wave listing
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  computeDueRechecks,
  classifyNextAction,
  extractHeadingIds,
  MODULE_META_HEADINGS,
  REPO_META_HEADINGS,
  isBlockedByEmpty,
  isHoldEmpty,
  parseBlockedBy,
  parseRepoMap,
  getCommitHashesReachableFromHead,
  getCommitHashesReachable,
  isShallowRepository,
  // T-637: extractCommitHashesFromEvidence/buildReachableHashIndex/
  // isHashReachable moved into the shared lib so --close-session's
  // shipped-but-unbooked advisory reuses the same batched-reachability
  // implementation this file's checkCommitReachable() uses, instead of a
  // second copy. They are re-exported unchanged from this module's exports
  // below, so existing require()rs (scripts/test-commit-reachable.js) are
  // unaffected.
  extractCommitHashesFromEvidence,
  buildReachableHashIndex,
  isHashReachable,
} = require('./mavp-operator-lib');

/**
 * Resolve the effective project root for locating project-level artifacts
 * (docs/MODULES.md, docs/REPO_MAP.md, docs/ARCHITECTURE.md, docs ref checks).
 * Resolution order:
 *   1. MAVERICKS_PROJECT_ROOT env var (set by bash wrapper in project-mode)
 *   2. process.cwd() (self-mode: running directly against mavericks repo)
 */
function getProjectRoot() {
  return process.env.MAVERICKS_PROJECT_ROOT || process.cwd();
}

// Statuses that require a Repo: field (warning if absent)
const STATUSES_REQUIRING_REPO = new Set([
  'in_progress',
  'dev_done',
  'ux_review',
  'ux_needs_fix',
  'ux_passed',
  'security_review',
  'security_passed',
  'security_needs_fix',
  'ready_for_qa',
  'qa_in_progress',
  'qa_passed',
  'needs_fix',
  'merged',
  'deployed_dev',
  'deployed_prod',
]);

const ACTIVE_BACKLOG_STATUSES = new Set([
  'planned',
  'in_progress',
  'dev_done',
  'ux_review',
  'ux_needs_fix',
  'ux_passed',
  'security_review',
  'security_passed',
  'security_needs_fix',
  'ready_for_qa',
  'qa_in_progress',
  'qa_passed',
  'needs_fix',
]);

// Terminal statuses that are not considered active for backlog comparison.
// Tasks with these statuses are excluded from active-task cross-checking
// and do not require presence in ACTIVE_BACKLOG_STATUSES.
const TERMINAL_TASK_STATUSES = new Set(['merged', 'deployed_dev', 'deployed_prod']);

// T-489: number of individual commit_unreachable findings a "Recently
// completed" (archived) section may accumulate before they are collapsed
// into a single aggregate info finding. Chosen so a handful of genuine
// historical gaps still surface individually (useful when auditing a
// specific old task), while a hub-model repo carrying dozens of them
// doesn't drown real warnings elsewhere in the report. Never affects the
// Active tasks section, and never changes severity or exit code either way.
const ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD = 5;

// Statuses that should be skipped for missing_in_backlog checks but are NOT terminal —
// the task can return from these states. `deferred` tasks move to the
// "## Deferred Tasks" section in BACKLOG.md and are not present in the active
// backlog set, so the validator must not flag them as missing.
const SKIP_BACKLOG_PRESENCE_STATUSES = new Set(['deferred', 'deprecated']);

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeWhitespace(value) {
  return value ? value.replace(/\s+/g, ' ').trim() : null;
}

function getSectionContent(markdown, headingPattern, label, { optional = false } = {}) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => headingPattern.test(line));

  if (startIndex === -1) {
    if (optional) return '';
    throw new Error(`Missing expected section: ${label}`);
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function getTaskBlocks(sectionMarkdown) {
  const lines = sectionMarkdown.split(/\r?\n/);
  const headingIndexes = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+T-\d+\s+—\s+/.test(lines[i])) {
      headingIndexes.push(i);
    }
  }

  return headingIndexes.map((startIndex, index) => {
    const endIndex = index + 1 < headingIndexes.length ? headingIndexes[index + 1] : lines.length;
    return lines.slice(startIndex, endIndex).join('\n').trim();
  });
}

// getField = single-line scalar fields (Status, Type, Module, etc.);
// getFieldMultiline = block fields that may span multiple sub-bullets (Evidence, Notes).
function getField(block, fieldLabel) {
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'));
  return normalizeWhitespace(match ? match[1] : null);
}

function getFieldMultiline(block, fieldLabel) {
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelRe = new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.*)$`);
  const nextFieldRe = /^- \*\*[^*]+:\*\*/;   // top-level (non-indented) bold field bullet
  const lines = block.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => labelRe.test(l));
  if (startIdx === -1) return null;
  const collected = [];
  const inline = lines[startIdx].match(labelRe)[1].trim();
  if (inline) collected.push(inline);
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (nextFieldRe.test(lines[i]) || /^###\s/.test(lines[i])) break;
    const content = lines[i].replace(/^\s*-\s*/, '').trim();  // strip sub-bullet prefix
    if (content) collected.push(content);
  }
  return collected.length ? collected.join('\n') : null;
}

function parseTaskBlock({ block, source, sourceSection }) {
  const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
  if (!headingMatch) {
    throw new Error(`Failed to parse task heading in ${source}:${sourceSection}`);
  }

  const [, taskId, taskTitle] = headingMatch;
  const status = getField(block, 'Status');

  if (!status) {
    throw new Error(`Missing required Status field for ${taskId} in ${source}:${sourceSection}`);
  }

  return {
    source,
    sourceSection,
    taskId,
    taskTitle: normalizeWhitespace(taskTitle),
    status,
    verificationType: getField(block, 'Verification type'),
    owner: getField(block, 'Owner role') || getField(block, 'Owner'),
    module: getField(block, 'Module'),
    staleRisk: getField(block, 'Stale risk'),
    requiresConfigCheck: getField(block, 'Requires config check'),
    // T-412: normalize a bracket-wrapped placeholder value (e.g. from BACKLOG_TEMPLATE.md)
    // to null before any downstream comma-split — a placeholder must not be parsed as repo ids.
    repo: (() => {
      const repoRaw = getField(block, 'Repo') || getField(block, 'Repos');
      return repoRaw && /^\[.*\]$/.test(repoRaw.trim()) ? null : repoRaw;
    })(),
    taskType: getField(block, 'Type'),
    outputDoc: getField(block, 'Output doc'),
    supersededBy: getField(block, 'Superseded by'),
    blockedBy: getField(block, 'Blocked by'),
    // T-496 (DR-005): optional per-task Hold field. Parsed here (raw string)
    // so applyHoldDowngrade() can gate its scoped downgrade on presence —
    // interpretation into {what, why, since} lives in parseHold()
    // (mavp-operator-lib.js), consumed by --agent/--snapshot, not here.
    hold: getField(block, 'Hold'),
    rawBlock: block,
  };
}

function parseBacklogActiveTasks(markdown) {
  const sourceSection = 'Active Wave';
  const section = getSectionContent(markdown, /^##\s+Active Wave/mi, '## Active Wave', { optional: true });
  if (!section) return [];

  return getTaskBlocks(section)
    .map((block) => parseTaskBlock({ block, source: 'backlog', sourceSection }))
    .filter((record) => ACTIVE_BACKLOG_STATUSES.has(record.status) && !record.supersededBy);
}

/**
 * Parse all task blocks from the Active Wave section in BACKLOG.md, including
 * merged/terminal tasks. Used by checks that need to inspect merged tasks in BACKLOG.
 * Superseded tasks (those with a Superseded by: field) are excluded — they are
 * treated as terminal/absorbed and require no state validation or evidence checks.
 */
function parseBacklogAllActiveWaveTasks(markdown) {
  const sourceSection = 'Active Wave';
  const section = getSectionContent(markdown, /^##\s+Active Wave/mi, '## Active Wave', { optional: true });
  if (!section) return [];

  return getTaskBlocks(section)
    .map((block) => parseTaskBlock({ block, source: 'backlog', sourceSection }))
    .filter((record) => !record.supersededBy);
}

function parseTaskStatusActiveTasks(markdown) {
  const sourceSection = 'Active tasks';
  const section = getSectionContent(markdown, /^##\s+Active tasks\s*$/m, '## Active tasks');

  return getTaskBlocks(section)
    .map((block) => parseTaskBlock({ block, source: 'task_status', sourceSection }));
}

/**
 * Parse the "## Recently completed tasks" section of TASK_STATUS.md (T-448).
 * Optional — returns [] when the section is absent (e.g. a fresh project that
 * has never archived a task yet).
 */
function parseTaskStatusRecentlyCompletedTasks(markdown) {
  const sourceSection = 'Recently completed tasks';
  const section = getSectionContent(
    markdown,
    /^##\s+Recently completed tasks\s*$/m,
    '## Recently completed tasks',
    { optional: true }
  );
  if (!section) return [];

  return getTaskBlocks(section)
    .map((block) => parseTaskBlock({ block, source: 'task_status', sourceSection }));
}

/**
 * Whole-file, section-agnostic task-block parser (T-543). Unlike the
 * section-scoped parsers above (which only look inside one named section),
 * this walks every `##`-level heading in the document and returns a record
 * for every `### T-NNN` block found anywhere, tagged with the literal
 * section heading text it was found under (e.g. "Active Wave",
 * "Wave 70 — Archived (mid-wave)", "Active tasks", "Recently completed
 * tasks"). This is the only way to see a task that has been archived out of
 * the active sections in one artifact while a stale/disagreeing record for
 * the same ID still lives in the other artifact — exactly the shape the
 * 2026-07-26 corruption took (BACKLOG archived a task as `merged`, the
 * TASK_STATUS record for the same ID kept `planned` in a completed
 * section), and which the active-section-only comparators in
 * compareRecords() cannot see once both blocks have left their active
 * sections.
 */
function parseAllTaskBlocksBySection(markdown, source) {
  const lines = markdown.split(/\r?\n/);
  const headingIndexes = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      headingIndexes.push({ index: i, heading: normalizeWhitespace(lines[i].replace(/^##\s+/, '')) });
    }
  }

  const records = [];
  for (let s = 0; s < headingIndexes.length; s += 1) {
    const start = headingIndexes[s].index;
    const end = s + 1 < headingIndexes.length ? headingIndexes[s + 1].index : lines.length;
    const sectionMarkdown = lines.slice(start, end).join('\n');
    const sectionLabel = headingIndexes[s].heading;

    for (const block of getTaskBlocks(sectionMarkdown)) {
      records.push(parseTaskBlock({ block, source, sourceSection: sectionLabel }));
    }
  }

  return records;
}

/** Every `### T-NNN` block anywhere in BACKLOG.md, active or archived (T-543). */
function parseBacklogAllTasksAnySection(markdown) {
  return parseAllTaskBlocksBySection(markdown, 'backlog');
}

/** Every `### T-NNN` block anywhere in TASK_STATUS.md, active or archived (T-543). */
function parseTaskStatusAllTasksAnySection(markdown) {
  return parseAllTaskBlocksBySection(markdown, 'task_status');
}

function createTaskRecordIndex(records) {
  const byTaskId = new Map();

  for (const record of records) {
    if (!byTaskId.has(record.taskId)) {
      byTaskId.set(record.taskId, []);
    }

    byTaskId.get(record.taskId).push(record);
  }

  return byTaskId;
}

function getSeverityForCheck(checkName) {
  const severityByCheckName = {
    missing_in_backlog: 'failure',
    missing_in_task_status: 'failure',
    title_mismatch: 'warning',
    status_mismatch: 'failure',
    verification_type_mismatch: 'warning',
    duplicate_active_task: 'failure',
    dev_done_without_qa: 'warning',
    duplicate_task_id: 'failure',
    duplicate_task_status_entry: 'warning',
    last_task_id_auto_patched: 'info',
    merged_missing_commit_field: 'failure',
    merged_missing_commit_format: 'warning',
    stale_risk_unverified: 'warning',
    unknown_module_id: 'warning',
    unknown_repo_id: 'warning',
    missing_repo_field: 'warning',
    exploration_missing_output_doc: 'warning',
    cross_repo_missing_evidence: 'warning',
    docs_ref_not_found: 'warning',
    active_slices_mismatch: 'warning',
    config_check_missing: 'warning',
    dev_done_missing_branch: 'warning',
    architecture_doc_stale: 'warning',
    merged_missing_needs_fix_rounds: 'info',
    conflicting_needs_fix_rounds: 'warning',
    conflicting_validator_blocked: 'warning',
    overdue_recheck: 'info',
    next_action_volatile_facts: 'info',
    artifact_size_budget: 'info',
    state_in_claude_md: 'info',
    blocked_by_open: 'failure',
    blocked_by_unresolvable: 'info',
    commit_unreachable: 'warning',
    cross_section_terminal_status_disagreement: 'failure',
    non_terminal_status_in_completed_section: 'warning',
    missing_task_status_record_anywhere: 'warning',
    reverse_terminal_status_disagreement: 'failure',
    missing_backlog_record_anywhere: 'warning',
  };

  return severityByCheckName[checkName] || 'warning';
}

/**
 * Returns verification-type-aware guidance for the merged-evidence checks
 * (merged_missing_commit_field / merged_missing_commit_format): a human-readable
 * label for the task's declared verification type and the exact accepted
 * evidence field(s) for that type.
 *
 * - `artifact` verification type: accepts `artifact:` (description of the
 *   produced artifact) OR `commit:` (if a code diff exists).
 * - Every other verification type (runtime, unit, manual, or unspecified):
 *   requires `commit:`, with `infra:` as the infra-only alternative.
 */
function getAcceptedEvidenceGuidance(verificationType) {
  const typeLabel = verificationType || 'unspecified';
  const isArtifactType = verificationType && verificationType.toLowerCase() === 'artifact';

  if (isArtifactType) {
    return {
      typeLabel,
      fieldsText: 'artifact: or commit:',
      suggestedAction:
        'Add artifact: <description> naming the produced artifact (e.g. artifact: docs/AUDIT.md), or commit: <hash> if a code diff exists.',
    };
  }

  return {
    typeLabel,
    fieldsText: 'commit: (or infra: for infra-only tasks)',
    suggestedAction:
      'Add commit: <hash> to the evidence field. For infra-only tasks use: infra: <verifiable-ref> where ref is an AWS ARN, git hash, or Terraform serial (e.g. infra: arn:aws:ssm:... or infra: serial/42).',
  };
}

function createFinding({ checkName, severity, taskId, message, repairTarget, suggestedAction, details }) {
  return {
    severity: severity || getSeverityForCheck(checkName),
    taskId,
    checkName,
    message,
    repairTarget,
    suggestedAction,
    ...(details ? { details } : {}),
  };
}

function compareField({ findings, taskId, backlogRecord, taskStatusRecord, fieldName, checkName, message, repairTarget, suggestedAction }) {
  const backlogValue = backlogRecord[fieldName];
  const taskStatusValue = taskStatusRecord[fieldName];

  if (!backlogValue || !taskStatusValue || backlogValue === taskStatusValue) {
    return;
  }

  findings.push(
    createFinding({
      checkName,
      taskId,
      message,
      repairTarget,
      suggestedAction,
      details: {
        fieldName,
        backlogValue,
        taskStatusValue,
      },
    })
  );
}

function compareRecords({ backlogRecords, taskStatusRecords }) {
  const findings = [];
  const backlogIndex = createTaskRecordIndex(backlogRecords);
  const taskStatusIndex = createTaskRecordIndex(taskStatusRecords);
  const allTaskIds = new Set([...backlogIndex.keys(), ...taskStatusIndex.keys()]);

  for (const [source, index] of [
    ['backlog', backlogIndex],
    ['task_status', taskStatusIndex],
  ]) {
    for (const [taskId, records] of index.entries()) {
      if (records.length <= 1) {
        continue;
      }

      findings.push(
        createFinding({
          checkName: 'duplicate_active_task',
          taskId,
          message: `${source === 'backlog' ? 'BACKLOG.md' : 'TASK_STATUS.md'} contains duplicate active entries for ${taskId}.`,
          repairTarget: source === 'backlog' ? 'BACKLOG.md' : 'TASK_STATUS.md',
          suggestedAction: 'Remove or reconcile duplicate active task entries so the live task set is unambiguous.',
          details: {
            source,
            duplicateCount: records.length,
            records: records.map((record) => ({
              taskTitle: record.taskTitle,
              status: record.status,
              verificationType: record.verificationType,
              sourceSection: record.sourceSection,
            })),
          },
        })
      );
    }
  }

  for (const taskId of Array.from(allTaskIds).sort()) {
    const backlogMatches = backlogIndex.get(taskId) || [];
    const taskStatusMatches = taskStatusIndex.get(taskId) || [];
    const backlogRecord = backlogMatches[0] || null;
    const taskStatusRecord = taskStatusMatches[0] || null;

    if (!backlogRecord && taskStatusRecord) {
      // Terminal-status tasks (merged, deployed_dev, deployed_prod) in TASK_STATUS.md
      // active section are not expected to appear in the active backlog set — skip.
      // Deferred tasks also move out of the active backlog set — skip them too.
      if (TERMINAL_TASK_STATUSES.has(taskStatusRecord.status) || SKIP_BACKLOG_PRESENCE_STATUSES.has(taskStatusRecord.status)) {
        continue;
      }
      findings.push(
        createFinding({
          checkName: 'missing_in_backlog',
          taskId,
          message: `${taskId} appears in TASK_STATUS.md but not in the active backlog task set.`,
          repairTarget: 'BACKLOG.md',
          suggestedAction: 'Inspect the backlog active-task list and add or retire the task so both artifacts describe the same live set.',
          details: {
            taskStatusRecord,
          },
        })
      );
      continue;
    }

    if (backlogRecord && !taskStatusRecord) {
      findings.push(
        createFinding({
          checkName: 'missing_in_task_status',
          taskId,
          message: `${taskId} appears in BACKLOG.md as active but not in TASK_STATUS.md.`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Inspect TASK_STATUS.md and add or retire the task entry so the active task ledger matches the backlog.',
          details: {
            backlogRecord,
          },
        })
      );
      continue;
    }

    compareField({
      findings,
      taskId,
      backlogRecord,
      taskStatusRecord,
      fieldName: 'taskTitle',
      checkName: 'title_mismatch',
      message: `BACKLOG.md and TASK_STATUS.md disagree on the title for ${taskId}.`,
      repairTarget: 'BACKLOG.md',
      suggestedAction: `Run: ./scripts/mavp-operator --rename-task ${taskId} "canonical title" to update both artifacts atomically.`,
    });

    compareField({
      findings,
      taskId,
      backlogRecord,
      taskStatusRecord,
      fieldName: 'status',
      checkName: 'status_mismatch',
      message: `BACKLOG.md and TASK_STATUS.md disagree on the active status for ${taskId}.`,
      repairTarget: 'TASK_STATUS.md',
      suggestedAction: 'Inspect both task entries and align the live task-state record first.',
    });

    compareField({
      findings,
      taskId,
      backlogRecord,
      taskStatusRecord,
      fieldName: 'verificationType',
      checkName: 'verification_type_mismatch',
      message: `BACKLOG.md and TASK_STATUS.md disagree on the verification type for ${taskId}.`,
      repairTarget: 'BACKLOG.md',
      suggestedAction: 'Inspect both entries and align the expected verification type.',
    });
  }

  // Warn on tasks in dev_done — they need QA or promotion to ready_for_qa.
  // Exception: artifact and unit verification types have built-in verification
  // (validator run / test suite) that serves as QA — no separate QA pass required.
  for (const record of backlogRecords) {
    if (record.status === 'dev_done') {
      const skipQa = ['artifact', 'unit'].includes(record.verificationType);
      if (!skipQa) {
        const siblingQaPassed = backlogRecords.find(
          (r) => r.taskId !== record.taskId && r.status === 'qa_passed'
        );
        const suggestedAction = siblingQaPassed
          ? `Sibling task ${siblingQaPassed.taskId} is qa_passed — promote this task to qa_passed/merged, or restructure QA as a stage of this task.`
          : 'Assign a QA owner, run QA, then promote to ready_for_qa or qa_passed.';
        findings.push(
          createFinding({
            checkName: 'dev_done_without_qa',
            taskId: record.taskId,
            message: `${record.taskId} is in dev_done and has not been promoted to ready_for_qa or qa_passed.`,
            repairTarget: 'BACKLOG.md + TASK_STATUS.md',
            suggestedAction,
          })
        );
      }
    }
  }

  // Hard error: merged tasks must have commit: in their evidence block.
  // Only checks tasks in TASK_STATUS.md (active + recently completed sections) — not archived wave sections in BACKLOG.md.
  for (const record of taskStatusRecords) {
    if (TERMINAL_TASK_STATUSES.has(record.status)) {
      const evidence = getFieldMultiline(record.rawBlock, 'Evidence');
      const infraMatch = evidence && evidence.match(/infra:\s*(.+)/i);
      const hasValidInfra = infraMatch && /arn:[a-z][a-z0-9:\/\-.*]+|[a-f0-9]{7,40}|serial[\/:\-]\d+|@v\d+/i.test(infraMatch[1]);
      // artifact: is accepted for artifact-verification tasks without code diff (exploration/initiative/audit tasks)
      const isArtifactType = record.verificationType && record.verificationType.toLowerCase() === 'artifact';
      const hasArtifactField = isArtifactType && evidence && /^artifact:\s*.+/im.test(evidence);
      const hasCommitField = evidence && (evidence.includes('commit:') || hasValidInfra || hasArtifactField);
      if (!hasCommitField) {
        const guidance = getAcceptedEvidenceGuidance(record.verificationType);
        const hasMalformedCommit = evidence && /\bcommit\s+[a-f0-9]{6,40}\b/i.test(evidence);
        if (hasMalformedCommit) {
          // Format issue only — commit hash present but missing colon. Recoverable with a trivial edit.
          findings.push(
            createFinding({
              checkName: 'merged_missing_commit_format',
              taskId: record.taskId,
              message: `${record.taskId} is merged (verification_type: ${guidance.typeLabel}) but evidence uses "commit <hash>" (missing colon) — accepted field(s): ${guidance.fieldsText}`,
              repairTarget: 'TASK_STATUS.md',
              suggestedAction: `Evidence contains \`commit <hash>\` (missing colon). Change to: commit: <hash>. Accepted field(s) for verification_type: ${guidance.typeLabel} — ${guidance.fieldsText}.`,
            })
          );
        } else {
          // Evidence missing commit field entirely — requires real repair.
          findings.push(
            createFinding({
              checkName: 'merged_missing_commit_field',
              taskId: record.taskId,
              message: `${record.taskId} is merged (verification_type: ${guidance.typeLabel}) but evidence is missing the required field — accepted field(s): ${guidance.fieldsText}`,
              repairTarget: 'TASK_STATUS.md',
              suggestedAction: guidance.suggestedAction,
            })
          );
        }
      }
    }
  }

  // stale_risk check: warning if task has stale_risk:true and is in_progress or later, but evidence lacks stale_verified:true
  // This check uses backlogRecords (has stale_risk field) paired with taskStatusRecords (has evidence)
  const taskStatusIndex2 = createTaskRecordIndex(taskStatusRecords);
  for (const record of backlogRecords) {
    if (record.staleRisk && record.staleRisk.toLowerCase() === 'true') {
      if (STATUSES_REQUIRING_REPO.has(record.status)) {
        const tsMatches = taskStatusIndex2.get(record.taskId) || [];
        const tsRecord = tsMatches[0] || null;
        if (tsRecord) {
          const evidence = getFieldMultiline(tsRecord.rawBlock, 'Evidence');
          const hasStaleVerified = evidence && evidence.includes('stale_verified:');
          if (!hasStaleVerified) {
            findings.push(
              createFinding({
                checkName: 'stale_risk_unverified',
                taskId: record.taskId,
                message: `${record.taskId} has stale_risk but no stale_verified in evidence`,
                repairTarget: 'TASK_STATUS.md',
                suggestedAction: 'Add stale_verified: true to the evidence field once the stale data risk has been assessed.',
              })
            );
          }
        }
      }
    }
  }

  // repo field check: warning when a task in in_progress or later has no Repo: field in backlog
  for (const record of backlogRecords) {
    if (STATUSES_REQUIRING_REPO.has(record.status) && !record.repo) {
      findings.push(
        createFinding({
          checkName: 'missing_repo_field',
          taskId: record.taskId,
          message: `${record.taskId} is ${record.status} but has no Repo: field declared`,
          repairTarget: 'BACKLOG.md',
          suggestedAction: 'Add "- **Repo:** <repo-name>" to the task entry in BACKLOG.md.',
        })
      );
    }
  }

  const countsBySeverity = findings.reduce(
    (counts, finding) => ({
      ...counts,
      [finding.severity]: (counts[finding.severity] || 0) + 1,
    }),
    { warning: 0, failure: 0, info: 0 }
  );

  let overallCandidateState = 'healthy';
  if (countsBySeverity.failure > 0) {
    overallCandidateState = 'misleading_repair_required';
  } else if (countsBySeverity.warning > 0) {
    overallCandidateState = 'usable_but_drifting';
  }

  return {
    overallCandidateState,
    findings,
    counts: {
      findings: findings.length,
      bySeverity: countsBySeverity,
    },
  };
}

function checkLastTaskId(backlogRecords, processStatePath) {
  let lastTaskId;
  let parsedState;

  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    parsedState = JSON.parse(raw);
    if (typeof parsedState.last_task_id !== 'number') {
      return [];
    }
    lastTaskId = parsedState.last_task_id;
  } catch (_err) {
    return [];
  }

  let maxNumericId = 0;
  let maxTaskId = null;

  for (const record of backlogRecords) {
    const match = record.taskId.match(/^T-(\d+)$/);
    if (!match) continue;
    const numeric = parseInt(match[1], 10);
    if (numeric > maxNumericId) {
      maxNumericId = numeric;
      maxTaskId = record.taskId;
    }
  }

  if (maxTaskId === null || maxNumericId <= lastTaskId) {
    return [];
  }

  // Auto-patch PROCESS_STATE.json instead of blocking with a failure.
  // If the write fails, fall back to a warning so the operator is aware.
  try {
    parsedState.last_task_id = maxNumericId;
    fs.writeFileSync(processStatePath, `${JSON.stringify(parsedState, null, 2)}\n`, 'utf8');
  } catch (writeErr) {
    return [
      createFinding({
        checkName: 'last_task_id_auto_patched',
        taskId: maxTaskId,
        message: `last_task_id in PROCESS_STATE.json (${lastTaskId}) is behind highest task ID (${maxNumericId}) — auto-patch failed: ${writeErr.message}`,
        repairTarget: 'PROCESS_STATE.json',
        suggestedAction: `Manually update last_task_id to ${maxNumericId} in PROCESS_STATE.json.`,
      }),
    ];
  }

  return [
    createFinding({
      checkName: 'last_task_id_auto_patched',
      taskId: maxTaskId,
      message: `last_task_id auto-patched: ${lastTaskId} → ${maxNumericId}`,
      repairTarget: 'PROCESS_STATE.json',
      suggestedAction: 'No action required — PROCESS_STATE.json has been updated automatically.',
    }),
  ];
}

/**
 * Check: every ID in PROCESS_STATE.json active_slices must correspond to a
 * task in BACKLOG.md whose status is in the active set (in_progress, dev_done,
 * ux_review, ux_passed, security_review, security_passed, ready_for_qa,
 * qa_in_progress). Mismatch → WARNING.
 * Silently skipped when active_slices is absent or not an array.
 */
const ACTIVE_SLICES_STATUSES = new Set([
  'planned',
  'in_progress',
  'dev_done',
  'ux_review',
  'ux_passed',
  'security_review',
  'security_passed',
  'ready_for_qa',
  'qa_in_progress',
]);

function checkActiveSlices(backlogRecords, processStatePath) {
  let activeSlices;

  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.active_slices)) {
      return [];
    }
    activeSlices = parsed.active_slices.map((s) =>
      typeof s === 'string' ? s : (s && typeof s === 'object' ? s.id : null)
    ).filter(Boolean);
  } catch (_err) {
    return [];
  }

  if (activeSlices.length === 0) return [];

  // Build set of task IDs from backlog that have active statuses
  const activeBacklogIds = new Set(
    backlogRecords
      .filter((r) => ACTIVE_SLICES_STATUSES.has(r.status))
      .map((r) => r.taskId)
  );

  const findings = [];
  for (const sliceId of activeSlices) {
    if (!activeBacklogIds.has(sliceId)) {
      findings.push(
        createFinding({
          checkName: 'active_slices_mismatch',
          taskId: sliceId,
          message: `${sliceId} is listed in PROCESS_STATE.json active_slices but has no matching active task in BACKLOG.md`,
          repairTarget: 'PROCESS_STATE.json',
          suggestedAction: `Remove ${sliceId} from active_slices in PROCESS_STATE.json or ensure the task exists with an active status in BACKLOG.md.`,
        })
      );
    }
  }
  return findings;
}

function checkDuplicateTaskIds(backlogMarkdown) {
  const findings = [];
  const allHeadings = backlogMarkdown.match(/^###\s+(T-\d+)\s+—/gm) || [];
  const seen = new Map();

  for (const heading of allHeadings) {
    const match = heading.match(/T-(\d+)/);
    if (!match) continue;
    const id = `T-${match[1]}`;
    seen.set(id, (seen.get(id) || 0) + 1);
  }

  for (const [id, count] of seen.entries()) {
    if (count > 1) {
      findings.push(
        createFinding({
          checkName: 'duplicate_task_id',
          taskId: id,
          message: `${id} appears ${count} times in BACKLOG.md.`,
          repairTarget: 'BACKLOG.md',
          suggestedAction: `Remove or renumber the duplicate ${id} entry. Update last_task_id in PROCESS_STATE.json.`,
          details: { count },
        })
      );
    }
  }

  return findings;
}

/**
 * Detect duplicate `### T-NNN` task headings and duplicate `## <section>`
 * headings ANYWHERE in TASK_STATUS.md (across all sections, not just
 * `## Active tasks`). This catches drift left behind by incomplete
 * archivals — e.g. a task duplicated across Active tasks + Recently
 * completed tasks, or two `## Recently completed tasks` sections that
 * should have been merged into one.
 *
 * Distinct from `duplicate_active_task` (which only compares the Active
 * sections of BACKLOG.md/TASK_STATUS.md against each other) and
 * `checkDuplicateTaskIds` (BACKLOG.md whole-file only) — neither of those
 * checks sees a task duplicated across two non-Active TASK_STATUS.md
 * sections.
 *
 * Warning severity only, never failure — detection only, no auto-repair.
 * A failure severity here would immediately block this repo and every
 * adopter carrying historical archival debt.
 */
function checkDuplicateTaskStatusEntries(taskStatusMarkdown) {
  const findings = [];
  const lines = taskStatusMarkdown.split('\n');

  let currentSection = null;
  const taskOccurrences = new Map(); // taskId -> [{ section, lineNumber }]
  const sectionOccurrences = new Map(); // sectionName -> [lineNumber, ...]

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sectionOccurrences.has(currentSection)) {
        sectionOccurrences.set(currentSection, []);
      }
      sectionOccurrences.get(currentSection).push(lineNumber);
      return;
    }

    const taskMatch = line.match(/^###\s+(T-\d+)\s+—/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      if (!taskOccurrences.has(taskId)) {
        taskOccurrences.set(taskId, []);
      }
      taskOccurrences.get(taskId).push({ section: currentSection, lineNumber });
    }
  });

  for (const [taskId, occurrences] of taskOccurrences.entries()) {
    if (occurrences.length <= 1) continue;

    const locations = occurrences
      .map((o) => `${o.section || 'unknown section'} (line ${o.lineNumber})`)
      .join(', ');

    findings.push(
      createFinding({
        checkName: 'duplicate_task_status_entry',
        taskId,
        message: `${taskId} appears ${occurrences.length} times in TASK_STATUS.md: ${locations}.`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Remove or reconcile the duplicate ${taskId} entries in TASK_STATUS.md so only one canonical entry remains.`,
        details: {
          kind: 'task_heading',
          count: occurrences.length,
          occurrences,
        },
      })
    );
  }

  for (const [sectionName, lineNumbers] of sectionOccurrences.entries()) {
    if (lineNumbers.length <= 1) continue;

    findings.push(
      createFinding({
        checkName: 'duplicate_task_status_entry',
        taskId: null,
        message: `Section heading "## ${sectionName}" appears ${lineNumbers.length} times in TASK_STATUS.md (lines ${lineNumbers.join(', ')}).`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Merge the duplicate "## ${sectionName}" sections into one so each section heading appears exactly once.`,
        details: {
          kind: 'section_heading',
          sectionName,
          count: lineNumbers.length,
          lineNumbers,
        },
      })
    );
  }

  return findings;
}

/**
 * Resolve the path to docs/MODULES.md for the current context.
 * Resolution order:
 *   1. MAVERICKS_PROJECT_ROOT env var (set by bash wrapper in project-mode)
 *   2. process.cwd() (self-mode: running directly against mavericks repo)
 * Returns null if neither location has the file.
 */
function resolveModulesPath() {
  const p = path.join(getProjectRoot(), 'docs', 'MODULES.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse known module IDs from docs/MODULES.md.
 * Reads from MAVERICKS_PROJECT_ROOT/docs/MODULES.md when in project context,
 * falling back to <cwd>/docs/MODULES.md.
 * Returns a Set of module IDs (e.g. 'module-a', 'module-b', ...).
 * Returns empty set if the file doesn't exist — module validation is skipped gracefully.
 *
 * Delegates heading extraction + meta-heading skip-set to mavp-operator-lib.js's
 * extractHeadingIds()/MODULE_META_HEADINGS (T-461) — the single shared source
 * also consumed by parseModuleRegistry() in that same file, so the skip-set is
 * defined in exactly one place instead of once per consumer.
 */
function parseKnownModuleIds(modulesPath) {
  try {
    const resolvedPath = modulesPath || resolveModulesPath();
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return new Set();
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return extractHeadingIds(content, MODULE_META_HEADINGS);
  } catch {
    return new Set();
  }
}

/**
 * Warn when a task declares a Module: field with an ID not present in docs/MODULES.md.
 * Skips all checks when the module registry is empty (file not found).
 */
function checkModuleIds(backlogRecords, modulesPath) {
  const knownIds = parseKnownModuleIds(modulesPath);
  // Skip entirely when no module registry exists — not an error condition
  if (knownIds.size === 0) return [];

  const findings = [];
  for (const record of backlogRecords) {
    if (record.module) {
      const moduleId = record.module.trim();
      if (!knownIds.has(moduleId)) {
        findings.push(
          createFinding({
            checkName: 'unknown_module_id',
            taskId: record.taskId,
            message: `${record.taskId} declares Module: ${moduleId} which is not in docs/MODULES.md`,
            repairTarget: 'BACKLOG.md or docs/MODULES.md',
            suggestedAction: `Either add "${moduleId}" module to docs/MODULES.md or correct the Module: field in BACKLOG.md.`,
            details: { moduleId, knownIds: [...knownIds] },
          })
        );
      }
    }
  }
  return findings;
}

/**
 * Resolve the path to docs/REPO_MAP.md for the current context.
 * Resolution order mirrors resolveModulesPath():
 *   1. MAVERICKS_PROJECT_ROOT env var (set by bash wrapper in project-mode)
 *   2. process.cwd() (self-mode: running directly against mavericks repo)
 * Returns null if neither location has the file.
 */
function resolveRepoMapPath() {
  const p = path.join(getProjectRoot(), 'docs', 'REPO_MAP.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse known repo IDs from docs/REPO_MAP.md.
 * Reads from MAVERICKS_PROJECT_ROOT/docs/REPO_MAP.md when in project context,
 * falling back to <cwd>/docs/REPO_MAP.md.
 * Returns a Set of repo IDs (e.g. 'repo-a', 'repo-b', ...).
 * Returns empty set if the file doesn't exist (or declares no real entries) —
 * repo-id validation is skipped gracefully, matching parseKnownModuleIds().
 *
 * Delegates heading extraction + meta-heading skip-set to mavp-operator-lib.js's
 * extractHeadingIds()/REPO_META_HEADINGS (T-461) — the single shared source
 * also consumed by parseRepoMap() in that same file, so the skip-set is
 * defined in exactly one place instead of once per consumer.
 */
function parseKnownRepoIds(repoMapPath) {
  try {
    const resolvedPath = repoMapPath || resolveRepoMapPath();
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return new Set();
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return extractHeadingIds(content, REPO_META_HEADINGS);
  } catch {
    return new Set();
  }
}

/**
 * Warn when a task declares a Repo:/Repos: field with an ID not present in
 * docs/REPO_MAP.md. Skips all checks when the repo map is empty (file not
 * found, or present with no real entries) — not an error condition.
 */
function checkRepoIds(backlogRecords, repoMapPath) {
  const knownIds = parseKnownRepoIds(repoMapPath);
  // Skip entirely when no repo map exists — not an error condition
  if (knownIds.size === 0) return [];

  const findings = [];
  for (const record of backlogRecords) {
    if (record.repo) {
      // record.repo combines Repo: (single) and Repos: (comma-separated) fields
      const repoNames = record.repo.split(',').map((r) => r.trim()).filter(Boolean);
      for (const repoName of repoNames) {
        if (!knownIds.has(repoName)) {
          findings.push(
            createFinding({
              checkName: 'unknown_repo_id',
              taskId: record.taskId,
              message: `${record.taskId} declares Repo: ${repoName} which is not in docs/REPO_MAP.md`,
              repairTarget: 'BACKLOG.md or docs/REPO_MAP.md',
              suggestedAction: `Either add "${repoName}" to docs/REPO_MAP.md or correct the Repo: field in BACKLOG.md.`,
              details: { repoName, knownIds: [...knownIds] },
            })
          );
        }
      }
    }
  }
  return findings;
}

/**
 * exploration_output_doc: exploration tasks must have output_doc: field declared.
 * Warns when a backlog task has Type: exploration but no Output doc: field.
 */
function checkExplorationOutputDoc(backlogRecords) {
  const findings = [];
  for (const record of backlogRecords) {
    if (record.taskType && record.taskType.trim().toLowerCase() === 'exploration') {
      if (!record.outputDoc) {
        findings.push(
          createFinding({
            checkName: 'exploration_missing_output_doc',
            taskId: record.taskId,
            message: `${record.taskId} is type exploration but has no Output doc: field`,
            repairTarget: 'BACKLOG.md',
            suggestedAction: 'Add "- **Output doc:** <path>" to the task entry in BACKLOG.md.',
          })
        );
      }
    }
  }
  return findings;
}

/**
 * cross_repo_evidence: cross-repo evidence check.
 * When a merged task has Repos: with 2+ repos, verify that each repo name has
 * at least one evidence line containing both "commit:" and the repo name (case-insensitive).
 * Only applies to multi-repo tasks (Repos: field, not single Repo:).
 */
function checkCrossRepoEvidence(backlogRecords, taskStatusRecords) {
  const findings = [];
  const taskStatusIndex = createTaskRecordIndex(taskStatusRecords);

  for (const record of backlogRecords) {
    if (!TERMINAL_TASK_STATUSES.has(record.status)) continue;

    // Only apply to tasks that have Repos: (multi-repo) — parse the raw block
    const reposField = getField(record.rawBlock, 'Repos');
    if (!reposField) continue;

    // Parse comma-separated repo names
    const repoNames = reposField.split(',').map(r => r.trim()).filter(Boolean);
    if (repoNames.length < 2) continue;

    // Get the evidence from TASK_STATUS.md for this task
    const tsMatches = taskStatusIndex.get(record.taskId) || [];
    const tsRecord = tsMatches[0] || null;
    if (!tsRecord) continue;

    const evidence = getFieldMultiline(tsRecord.rawBlock, 'Evidence');
    if (!evidence) {
      // Missing evidence entirely — already caught by merged_missing_commit_field
      continue;
    }

    for (const repoName of repoNames) {
      const lowerEvidence = evidence.toLowerCase();
      const lowerRepo = repoName.toLowerCase();
      // Check if there is a substring match of "commit:" AND repoName in the evidence
      const hasCommitForRepo = lowerEvidence.includes('commit:') && lowerEvidence.includes(lowerRepo);
      if (!hasCommitForRepo) {
        findings.push(
          createFinding({
            checkName: 'cross_repo_missing_evidence',
            taskId: record.taskId,
            message: `${record.taskId} is merged with repos: [${repoNames.join(', ')}] but evidence has no commit: for repo "${repoName}"`,
            repairTarget: 'TASK_STATUS.md',
            suggestedAction: `Add a line with both "commit:" and "${repoName}" to the evidence block (e.g., "commit: <hash> (${repoName})").`,
          })
        );
      }
    }
  }
  return findings;
}

/**
 * config_check: config_check evidence check.
 * When a task has requires_config_check: true and is qa_passed or merged,
 * warn if TASK_STATUS.md evidence does not contain a config_check: line.
 */
function checkConfigCheck(backlogRecords, taskStatusRecords) {
  const findings = [];
  const taskStatusIndex = createTaskRecordIndex(taskStatusRecords);
  const CONFIG_CHECK_STATUSES = new Set(['qa_passed', ...TERMINAL_TASK_STATUSES]);

  for (const record of backlogRecords) {
    if (!record.requiresConfigCheck || record.requiresConfigCheck.toLowerCase() !== 'true') continue;
    if (!CONFIG_CHECK_STATUSES.has(record.status)) continue;

    const tsMatches = taskStatusIndex.get(record.taskId) || [];
    const tsRecord = tsMatches[0] || null;
    if (!tsRecord) continue;

    const evidence = getFieldMultiline(tsRecord.rawBlock, 'Evidence');
    const hasConfigCheck = evidence && evidence.toLowerCase().includes('config_check:');
    if (!hasConfigCheck) {
      findings.push(
        createFinding({
          checkName: 'config_check_missing',
          taskId: record.taskId,
          message: `${record.taskId} has requires_config_check: true but evidence has no config_check: block`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Add "config_check: <key1> ✓, <key2> ✓" to the evidence field listing each config key confirmed present and correct in the target environment.',
        })
      );
    }
  }
  return findings;
}

/**
 * dev_done_branch: dev_done branch field check.
 * When a task is dev_done AND its evidence block in TASK_STATUS.md contains
 * a commit: line but has no branch: line, emit a warning.
 * Projects with branch-based deploy contours should populate branch: in dev_done evidence.
 */
function checkDevDoneBranch(taskStatusRecords) {
  const findings = [];

  for (const record of taskStatusRecords) {
    if (record.status !== 'dev_done') continue;

    const evidence = getFieldMultiline(record.rawBlock, 'Evidence');
    if (!evidence) continue;

    const hasCommit = evidence.includes('commit:');
    if (!hasCommit) continue;

    const hasBranch = evidence.includes('branch:');
    if (!hasBranch) {
      findings.push(
        createFinding({
          checkName: 'dev_done_missing_branch',
          taskId: record.taskId,
          message: `${record.taskId} is dev_done with commit evidence but no branch: field`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Add "branch: <name>" (e.g. main, develop, both) to the evidence field for this task.',
        })
      );
    }
  }
  return findings;
}

/**
 * docs_refs: docs ref validator.
 * For merged tasks, scan Notes and Evidence fields in TASK_STATUS.md for
 * patterns matching docs/[A-Z_]+.md. Warn if the file does not exist.
 * AC and Proposed solution fields are NOT scanned.
 */
function checkDocsRefs(taskStatusRecords) {
  const projectRoot = getProjectRoot();
  const findings = [];
  const DOCS_REF_PATTERN = /docs\/[A-Z_]+\.md/g;

  for (const record of taskStatusRecords) {
    if (!TERMINAL_TASK_STATUSES.has(record.status)) continue;

    const fieldsToScan = ['Evidence', 'Notes'];
    for (const fieldLabel of fieldsToScan) {
      const fieldValue = getFieldMultiline(record.rawBlock, fieldLabel);
      if (!fieldValue) continue;

      const matches = fieldValue.match(DOCS_REF_PATTERN) || [];
      const seen = new Set();
      for (const match of matches) {
        if (seen.has(match)) continue;
        seen.add(match);
        const fullPath = path.join(projectRoot, match);
        if (!fs.existsSync(fullPath)) {
          findings.push(
            createFinding({
              checkName: 'docs_ref_not_found',
              taskId: record.taskId,
              message: `${record.taskId} references ${match} in ${fieldLabel} but the file does not exist`,
              repairTarget: 'TASK_STATUS.md',
              suggestedAction: `Create ${match} or update the reference to an existing file.`,
              details: { referencedPath: match, resolvedPath: fullPath, field: fieldLabel },
            })
          );
        }
      }
    }
  }
  return findings;
}

/**
 * architecture_doc_stale: architecture doc staleness check.
 * When at least one merged task in the Active Wave declares
 * `- **Update architecture:** true`, AND docs/ARCHITECTURE.md exists,
 * AND its `> Last updated: YYYY-MM-DD` date is earlier than
 * PROCESS_STATE.json `last_updated`, emit a warning.
 * Silently skipped when docs/ARCHITECTURE.md is absent.
 */
function checkArchitectureDocStale(backlogAllWaveRecords, processStatePath) {
  // Resolve the path to docs/ARCHITECTURE.md (project-aware)
  const projectRoot = getProjectRoot();
  const archDocPath = path.join(projectRoot, 'docs', 'ARCHITECTURE.md');

  // Silent skip when the file doesn't exist
  if (!fs.existsSync(archDocPath)) return [];

  // Check if any merged task in the Active Wave has Update architecture: true
  const hasMergedArchTask = backlogAllWaveRecords.some((record) => {
    if (record.status !== 'merged') return false;
    const updateArch = getField(record.rawBlock, 'Update architecture');
    return updateArch && updateArch.trim().toLowerCase() === 'true';
  });

  if (!hasMergedArchTask) return [];

  // Read PROCESS_STATE.json to get last_updated
  let processStateLastUpdated;
  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    processStateLastUpdated = parsed.last_updated;
  } catch (_err) {
    return [];
  }

  if (!processStateLastUpdated) return [];

  // Parse > Last updated: YYYY-MM-DD from docs/ARCHITECTURE.md
  let archDocLastUpdated;
  try {
    const archContent = fs.readFileSync(archDocPath, 'utf8');
    const match = archContent.match(/>\s*Last updated:\s*(\d{4}-\d{2}-\d{2})/i);
    if (!match) return [];
    archDocLastUpdated = match[1];
  } catch (_err) {
    return [];
  }

  // Compare as ISO date strings (YYYY-MM-DD lexicographic comparison is correct)
  if (archDocLastUpdated >= processStateLastUpdated) return [];

  return [
    createFinding({
      checkName: 'architecture_doc_stale',
      taskId: null,
      message: `docs/ARCHITECTURE.md Last updated (${archDocLastUpdated}) is older than PROCESS_STATE.json last_updated (${processStateLastUpdated}) — a merged task declares Update architecture: true`,
      repairTarget: 'docs/ARCHITECTURE.md',
      suggestedAction: 'Update docs/ARCHITECTURE.md and set its "Last updated:" date to reflect the architectural changes introduced in the current wave.',
    }),
  ];
}

/**
 * merged_needs_fix_rounds: merged runtime/manual tasks missing needs_fix_rounds in evidence.
 * Advisory only (info severity, exits 0) — this field feeds the skill-reflection
 * loop. Teams not using skill reflection may safely omit it.
 * Applies when: status === 'merged' AND verificationType is 'runtime' or 'manual'
 * AND evidence does not contain 'needs_fix_rounds:'.
 */
function checkMergedNeedsFixRounds(taskStatusRecords) {
  const findings = [];
  const TARGET_VERIFICATION_TYPES = new Set(['runtime', 'manual']);

  for (const record of taskStatusRecords) {
    if (record.status !== 'merged') continue;
    if (!record.verificationType) continue;
    if (!TARGET_VERIFICATION_TYPES.has(record.verificationType.toLowerCase())) continue;

    const evidence = getFieldMultiline(record.rawBlock, 'Evidence');
    const hasNeedsFixRounds = evidence && evidence.includes('needs_fix_rounds:');
    if (!hasNeedsFixRounds) {
      findings.push(
        createFinding({
          checkName: 'merged_missing_needs_fix_rounds',
          taskId: record.taskId,
          message: `${record.taskId} is merged with verification_type: ${record.verificationType} but evidence has no needs_fix_rounds: field`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Add needs_fix_rounds: N to the evidence field (for skill-reflection signal; safe to omit if not using skill reflection).',
        })
      );
    }
  }
  return findings;
}

/**
 * conflicting_needs_fix_rounds / conflicting_validator_blocked (T-558):
 * warning-severity checks that fire when a single task's Evidence field
 * carries 2+ digit-valued `needs_fix_rounds:` matches (respectively 2+
 * true/false-valued `validator_blocked:` matches) whose parsed values are
 * NOT all equal.
 *
 * Root cause: appendNeedsFixRoundsIfMissing (mavp-operator-set-status.js)
 * only ever inserts `needs_fix_rounds: 0` when the field is absent and never
 * updates it in place, so every fix-round increment is a hand edit that
 * appends a second occurrence further down the Evidence block, while
 * extractTrajectories (mavp-operator-lib.js) reads the FIRST match only. Two
 * corruptions were realized on the live artifact: T-288's leading value
 * disagreed with its own prose-recorded fix round, and T-186 had no
 * canonical validator_blocked field but described the field as subject
 * matter, so first-match read `true` for a task the validator never
 * blocked.
 *
 * DISTINCT-VALUES predicate, not occurrence-count: an agreeing repetition
 * (e.g. `needs_fix_rounds: 0` twice) is legitimate and produces no finding —
 * 28 such records exist on the live artifact. A digitless field-name
 * mention ("needs_fix_rounds: N" as documentation prose) never matches the
 * digit-anchored regex below, so it contributes no occurrence and produces
 * no finding either.
 *
 * Runs over EVERY section the evidence parser reads (active, recently
 * completed, archived) — callers pass ctx.taskStatusAllTasksAnySection,
 * matching extractTrajectories' whole-file read scope, since all of the
 * realized corruptions lived in archived/recently-completed sections that
 * the active-only record set never sees.
 *
 * commit: and branch: are explicitly EXCLUDED from this pattern: per-repo
 * cross-repo evidence legitimately repeats `commit:`, and
 * mergeCommitEvidence (mavp-operator-lib.js:3390) replaces the first
 * commit/branch token in place rather than appending, so they do not share
 * this risk.
 */
function checkConflictingEvidenceField({ records, regex, parseValue, checkName, fieldLabel }) {
  const findings = [];

  for (const record of records) {
    const evidence = getFieldMultiline(record.rawBlock, 'Evidence');
    if (!evidence) continue;

    const matches = [...evidence.matchAll(regex)];
    if (matches.length < 2) continue;

    const values = matches.map((m) => parseValue(m[1]));
    const distinct = [...new Set(values)];
    if (distinct.length <= 1) continue;

    findings.push(
      createFinding({
        checkName,
        taskId: record.taskId,
        message: `${record.taskId} has conflicting ${fieldLabel}: values in Evidence (document order: ${values.join(', ')}) — these must agree`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Collapse the repeated ${fieldLabel}: field to a single authoritative value. The literal ${fieldLabel}: key with a value is machine-owned (read by extractTrajectories/skill-reflect); any scoped, per-stage, or historical count must be written in words in prose, never as a second ${fieldLabel}: line.`,
      })
    );
  }

  return findings;
}

function checkConflictingNeedsFixRounds(taskStatusAllTasksAnySection) {
  return checkConflictingEvidenceField({
    records: taskStatusAllTasksAnySection,
    regex: /needs_fix_rounds:\s*(\d+)/gi,
    parseValue: (raw) => parseInt(raw, 10),
    checkName: 'conflicting_needs_fix_rounds',
    fieldLabel: 'needs_fix_rounds',
  });
}

function checkConflictingValidatorBlocked(taskStatusAllTasksAnySection) {
  return checkConflictingEvidenceField({
    records: taskStatusAllTasksAnySection,
    regex: /validator_blocked:\s*(true|false)/gi,
    parseValue: (raw) => raw.toLowerCase(),
    checkName: 'conflicting_validator_blocked',
    fieldLabel: 'validator_blocked',
  });
}

/**
 * A record is treated as terminal-by-other-means (T-543) — excluded from
 * both new checks below — when it carries a real `Superseded by:` value or
 * a `deprecated` status, mirroring the existing skip rules documented for
 * `Superseded by:` and `deprecated` in CLAUDE.md ("Key conventions").
 */
function isSkippedByExistingRules(record) {
  return Boolean(record.supersededBy) || record.status === 'deprecated';
}

/**
 * Failure-severity (T-543): a BACKLOG task in ANY section (active or
 * archived) whose status is terminal (merged/deployed_dev/deployed_prod)
 * must not have a TASK_STATUS record — in ANY section — that still carries
 * a non-terminal status. compareRecords()'s status_mismatch check only ever
 * looks at the active sections of both artifacts, so once both blocks have
 * been archived out of their active sections (the exact 2026-07-26
 * corruption shape: BACKLOG archived a task as `merged`, TASK_STATUS kept
 * `planned` in a completed section) that disagreement goes invisible. This
 * check parses whole-file, section-agnostic record sets for both artifacts
 * so the comparison survives archival on either side.
 */
function checkCrossSectionTerminalStatusDisagreement(allBacklogRecords, allTaskStatusRecords) {
  const findings = [];
  const taskStatusIndex = createTaskRecordIndex(allTaskStatusRecords);

  for (const backlogRecord of allBacklogRecords) {
    if (!TERMINAL_TASK_STATUSES.has(backlogRecord.status)) continue;
    if (isSkippedByExistingRules(backlogRecord)) continue;

    const matches = taskStatusIndex.get(backlogRecord.taskId) || [];
    for (const taskStatusRecord of matches) {
      if (isSkippedByExistingRules(taskStatusRecord)) continue;
      if (TERMINAL_TASK_STATUSES.has(taskStatusRecord.status)) continue;

      findings.push(
        createFinding({
          checkName: 'cross_section_terminal_status_disagreement',
          taskId: backlogRecord.taskId,
          message: `${backlogRecord.taskId} is ${backlogRecord.status} in BACKLOG.md (section: ${backlogRecord.sourceSection}) but TASK_STATUS.md (section: ${taskStatusRecord.sourceSection}) still records status ${taskStatusRecord.status} — the artifacts disagree on whether this task is real.`,
          repairTarget: 'BACKLOG.md + TASK_STATUS.md',
          suggestedAction: `Determine which record is correct: if the task was never actually done, revert BACKLOG.md's ${backlogRecord.taskId} status and un-archive it; if it was done, update TASK_STATUS.md's ${backlogRecord.taskId} status to match and add the required commit:/infra:/artifact: evidence.`,
          details: {
            backlogSection: backlogRecord.sourceSection,
            backlogStatus: backlogRecord.status,
            taskStatusSection: taskStatusRecord.sourceSection,
            taskStatusStatus: taskStatusRecord.status,
          },
        })
      );
    }
  }

  return findings;
}

/**
 * Warning-severity (T-543): a task block sitting inside one of
 * TASK_STATUS.md's completed/archived sections (currently "Recently
 * completed tasks"; any future non-"Active tasks" section is treated the
 * same way) whose status is non-terminal is a placement-hygiene defect —
 * the task was moved to a completed section without actually completing.
 * This is the second half of the corruption's signature: the TASK_STATUS
 * side of the 2026-07-26 incident (`planned` sitting under
 * "## Recently completed tasks") would fire this on its own even before
 * cross-referencing BACKLOG.md at all. Kept at warning (not failure) so the
 * blast radius on adopter repos stays smaller — this flags placement
 * hygiene, not a proven cross-artifact contradiction.
 */
function checkNonTerminalStatusInCompletedSection(allTaskStatusRecords) {
  const findings = [];
  // Scope to sections that are genuinely "this task is done" archives — NOT
  // "## Parked tasks (Wave N)" (--park-wave's holding area for tasks that
  // are deliberately still non-terminal and will resume; see
  // mavp-operator-park-wave.js) and not "## Active tasks" itself. Matching
  // only these two shapes keeps the check aligned with its stated signature
  // (the corruption's "Recently completed tasks" shape) instead of firing
  // on every legitimate non-active section a project might have.
  const COMPLETED_SECTION_PATTERN = /recently completed|archived/i;
  const PARKED_SECTION_PATTERN = /parked/i;

  for (const record of allTaskStatusRecords) {
    if (!COMPLETED_SECTION_PATTERN.test(record.sourceSection)) continue;
    if (PARKED_SECTION_PATTERN.test(record.sourceSection)) continue;
    if (TERMINAL_TASK_STATUSES.has(record.status)) continue;
    if (isSkippedByExistingRules(record)) continue;

    findings.push(
      createFinding({
        checkName: 'non_terminal_status_in_completed_section',
        taskId: record.taskId,
        message: `${record.taskId} sits in TASK_STATUS.md's "${record.sourceSection}" section with non-terminal status ${record.status} — a completed/archived section should only ever hold terminal-status tasks.`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Move ${record.taskId} back to "## Active tasks" if it is still in flight, or correct its status field if it was archived in error.`,
      })
    );
  }

  return findings;
}

/**
 * Warning-severity (T-547) — complement to
 * checkCrossSectionTerminalStatusDisagreement(): that check requires a
 * TASK_STATUS record to disagree with, so it cannot see a task that has NO
 * TASK_STATUS record anywhere. A terminal-status (merged/deployed_dev/
 * deployed_prod) BACKLOG task in ANY section with zero matching TASK_STATUS
 * records in ANY section is exactly the shape a buggy archival move-helper
 * leaves when it DROPS a block instead of moving it — the same T-542/T-544
 * incident family, one step further along: there is nothing left to
 * disagree with, only an absence. Kept at warning (not failure): post-repair
 * this is a genuine anomaly worth surfacing, but absence alone is not proof
 * of fabrication.
 *
 * NOTE: if TASK_STATUS.md's history is ever trimmed by moving completed
 * records into a separate archive file, this check will need to read that
 * file too — otherwise it will start firing on every legitimately-trimmed
 * task rather than only on genuinely dropped ones. Revisit this check at
 * that point.
 */
function checkMissingTaskStatusRecordAnywhere(allBacklogRecords, allTaskStatusRecords) {
  const findings = [];
  const taskStatusIndex = createTaskRecordIndex(allTaskStatusRecords);

  for (const backlogRecord of allBacklogRecords) {
    if (!TERMINAL_TASK_STATUSES.has(backlogRecord.status)) continue;
    if (isSkippedByExistingRules(backlogRecord)) continue;

    const matches = taskStatusIndex.get(backlogRecord.taskId) || [];
    if (matches.length > 0) continue;

    findings.push(
      createFinding({
        checkName: 'missing_task_status_record_anywhere',
        taskId: backlogRecord.taskId,
        message: `${backlogRecord.taskId} is ${backlogRecord.status} in BACKLOG.md (section: ${backlogRecord.sourceSection}) but has no TASK_STATUS.md record in any section — the archival move may have dropped the block instead of moving it.`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Add a TASK_STATUS.md record for ${backlogRecord.taskId} (a minimal retroactive record is acceptable for pre-existing archived history) so both artifacts' task sets agree.`,
        details: {
          backlogSection: backlogRecord.sourceSection,
          backlogStatus: backlogRecord.status,
        },
      })
    );
  }

  return findings;
}

/**
 * Failure-severity (T-575) — the REVERSE direction of
 * checkCrossSectionTerminalStatusDisagreement(). That check is gated on the
 * BACKLOG side being terminal, so the mirror-image shape raised zero findings:
 * a TASK_STATUS record claiming terminal status (merged/deployed_dev/
 * deployed_prod) while the same-ID BACKLOG record — in ANY section — still
 * reads something non-terminal (`deferred`, `planned`, `qa_passed`, ...).
 * That is an artifact claiming a task shipped while the plan of record says it
 * did not, which is the same class of contradiction as the forward direction
 * and carries the same failure severity.
 *
 * Note this is NOT a section-visibility gap: parseAllTaskBlocksBySection()
 * already parses `## Deferred Tasks` and every other `##` section on both
 * sides. The gap was purely directional. compareRecords()'s active-vs-active
 * `status_mismatch` cannot cover it either, because parseBacklogActiveTasks()
 * keeps only ACTIVE_BACKLOG_STATUSES — a STATUS filter, not a section filter,
 * so a `deferred` BACKLOG block is invisible to it even when it sits in
 * `## Active Wave`.
 *
 * Deliberately a separate check rather than a widening of the forward one:
 * severity is assigned per check name (getSeverityForCheck()), the forward
 * check ships with documented one-direction semantics adopters rely on, and
 * the repair guidance genuinely differs by direction — here the BACKLOG side
 * is the one that is behind.
 */
function checkReverseTerminalStatusDisagreement(allBacklogRecords, allTaskStatusRecords) {
  const findings = [];
  const backlogIndex = createTaskRecordIndex(allBacklogRecords);

  for (const taskStatusRecord of allTaskStatusRecords) {
    if (!TERMINAL_TASK_STATUSES.has(taskStatusRecord.status)) continue;
    if (isSkippedByExistingRules(taskStatusRecord)) continue;

    const matches = backlogIndex.get(taskStatusRecord.taskId) || [];
    for (const backlogRecord of matches) {
      if (isSkippedByExistingRules(backlogRecord)) continue;
      if (TERMINAL_TASK_STATUSES.has(backlogRecord.status)) continue;

      findings.push(
        createFinding({
          checkName: 'reverse_terminal_status_disagreement',
          taskId: taskStatusRecord.taskId,
          message: `${taskStatusRecord.taskId} is ${taskStatusRecord.status} in TASK_STATUS.md (section: ${taskStatusRecord.sourceSection}) but BACKLOG.md (section: ${backlogRecord.sourceSection}) still records status ${backlogRecord.status} — the artifacts disagree on whether this task shipped.`,
          repairTarget: 'BACKLOG.md + TASK_STATUS.md',
          suggestedAction: `Determine which record is correct: if ${taskStatusRecord.taskId} really was ${taskStatusRecord.status}, bring BACKLOG.md's block into line with \`--rescope-task ${taskStatusRecord.taskId} --status ${taskStatusRecord.status}\` (or \`--update-status ${taskStatusRecord.taskId} ${taskStatusRecord.status}\` if the block is already in the right section); if it was not, revert TASK_STATUS.md's ${taskStatusRecord.taskId} status to match BACKLOG.md.`,
          details: {
            backlogSection: backlogRecord.sourceSection,
            backlogStatus: backlogRecord.status,
            taskStatusSection: taskStatusRecord.sourceSection,
            taskStatusStatus: taskStatusRecord.status,
          },
        })
      );
    }
  }

  return findings;
}

/**
 * Warning-severity (T-575) — reverse-direction sibling of
 * checkMissingTaskStatusRecordAnywhere(), and the worse variant of the gap
 * checkReverseTerminalStatusDisagreement() above closes: a TASK_STATUS record
 * claiming terminal status for a task BACKLOG never registered ANYWHERE.
 * Nothing else catches it — `missing_in_backlog` deliberately exempts
 * terminal-status TASK_STATUS records (see SKIP_BACKLOG_PRESENCE_STATUSES and
 * the TERMINAL_TASK_STATUSES exemption in compareRecords()), because merged
 * tasks legitimately archive out of BACKLOG's Active Wave — so a fabricated
 * `merged` record with no plan of record behind it is fully silent.
 *
 * Warning, not failure: a project that trims old waves out of BACKLOG.md
 * entirely would mass-trip this, and absence alone is not proof of
 * fabrication — the same reasoning that keeps the forward-direction
 * missing_task_status_record_anywhere at warning.
 *
 * NOTE (carried over from checkMissingTaskStatusRecordAnywhere(), applies
 * symmetrically here): if BACKLOG.md's history is ever trimmed by moving
 * archived waves into a separate file, this check will need to read that file
 * too — otherwise it will start firing on every legitimately-trimmed task
 * rather than only on genuinely unregistered ones. Revisit at that point.
 */
function checkMissingBacklogRecordAnywhere(allBacklogRecords, allTaskStatusRecords) {
  const findings = [];
  const backlogIndex = createTaskRecordIndex(allBacklogRecords);

  for (const taskStatusRecord of allTaskStatusRecords) {
    if (!TERMINAL_TASK_STATUSES.has(taskStatusRecord.status)) continue;
    if (isSkippedByExistingRules(taskStatusRecord)) continue;

    const matches = backlogIndex.get(taskStatusRecord.taskId) || [];
    if (matches.length > 0) continue;

    findings.push(
      createFinding({
        checkName: 'missing_backlog_record_anywhere',
        taskId: taskStatusRecord.taskId,
        message: `${taskStatusRecord.taskId} is ${taskStatusRecord.status} in TASK_STATUS.md (section: ${taskStatusRecord.sourceSection}) but has no BACKLOG.md record in any section — a task cannot have shipped without ever being registered in the plan of record.`,
        repairTarget: 'BACKLOG.md',
        suggestedAction: `Add a BACKLOG.md record for ${taskStatusRecord.taskId} (a minimal retroactive block is acceptable for pre-existing archived history) so both artifacts' task sets agree — or, if the TASK_STATUS record was fabricated, remove it.`,
        details: {
          taskStatusSection: taskStatusRecord.sourceSection,
          taskStatusStatus: taskStatusRecord.status,
        },
      })
    );
  }

  return findings;
}

/**
 * Extract `commit:` entries from an evidence block, each carrying its
 * optional parenthesized cross-repo annotation (T-489) — the documented
 * "Cross-repo evidence format" convention: `commit: <hash> (repo-a)`.
 * extractCommitHashesFromEvidence() above intentionally keeps returning bare
 * hash strings (unchanged, still used wherever only the hash matters); this
 * sibling function is for callers that need to know WHICH repo the evidence
 * claims the hash belongs to, so they can skip a local reachability check
 * for hashes that legitimately live in another repo's history.
 *
 * Each returned entry is `{ hash, repoAnnotation }` where `repoAnnotation` is
 * the trimmed text inside the parentheses, or `null` when the evidence line
 * has no annotation. Hashes are validated against the same
 * /^[0-9a-f]{7,40}$/ pattern as extractCommitHashesFromEvidence().
 */
function extractCommitEntriesFromEvidence(evidence) {
  if (!evidence) return [];
  const HASH_PATTERN = /^[0-9a-f]{7,40}$/;
  const ENTRY_PATTERN = /commit:\s*([0-9a-f]{7,40})\b(?:\s*\(([^)]*)\))?/gi;
  const entries = [];
  let match;
  while ((match = ENTRY_PATTERN.exec(evidence)) !== null) {
    const hash = match[1];
    if (!HASH_PATTERN.test(hash)) continue;
    const repoAnnotation = match[2] ? match[2].trim() : null;
    entries.push({ hash, repoAnnotation: repoAnnotation || null });
  }
  return entries;
}

/**
 * Resolve the repo id (from docs/REPO_MAP.md) that corresponds to `root`
 * itself — i.e. the entry whose `path:` field resolves to the same directory
 * being validated. Returns null when no entry matches (including when the
 * repo map is absent/empty) — the caller treats null as "cannot determine
 * cross-repo skip, check every task".
 */
function resolveSelfRepoId(root, repoMap) {
  const normalizedRoot = path.resolve(root);
  for (const [id, entry] of Object.entries(repoMap || {})) {
    if (entry && entry.path && path.resolve(entry.path) === normalizedRoot) {
      return id;
    }
  }
  return null;
}

/**
 * commit_reachable (T-448, two-tiered by T-455): commit_unreachable check. Flags a
 * merged/terminal task's evidence `commit:` hash that cannot be found in the
 * current repo's local git history — the cherry-pick footgun where a
 * worktree-local hash is pasted into evidence but the corresponding commit
 * never actually landed anywhere reachable (a mere existence check like
 * `git cat-file -e` is insufficient: worktrees share the object database, so
 * it would pass even for a hash that never reached any local ref).
 *
 * Two-tier reachability (T-455): workflows that intentionally hold a merged
 * task's commit on a local feature branch pre-push are normal, not a defect
 * — only a hash reachable from NO local ref at all is the real footgun.
 *   - Reachable from HEAD: no finding.
 *   - NOT reachable from HEAD but reachable from some local branch
 *     (`git rev-list --branches`): info-severity finding noting the commit is
 *     held on a local branch, not on HEAD. Never affects the exit code.
 *   - Reachable from NO local ref at all: the original T-448 behavior —
 *     warning severity for Active tasks section (exit 1 at worst, never 2),
 *     info severity for Recently completed tasks section (historical debt
 *     must never flip the exit code).
 *
 * - Tasks whose Repo:/Repos: field names a repo other than the current one
 *   (resolved via docs/REPO_MAP.md's path: matching `root`) are skipped —
 *   their evidence hashes live in a different repo's git history.
 * - Hub-aware per-hash annotation skip (T-489): the documented "Cross-repo
 *   evidence format" convention (CLAUDE.md) lets a single hub-tracked task
 *   carry `commit: <hash> (repo-a)` — a per-hash annotation independent of
 *   any record-level Repo:/Repos: field (which archived, pre-convention
 *   entries frequently lack). When a hash's annotation resolves (case-
 *   insensitively) to a KNOWN docs/REPO_MAP.md id other than the self repo,
 *   that hash is skipped entirely — its history legitimately lives
 *   elsewhere and can never be locally reachable. An annotation that names
 *   the self repo, or that does not match any known repo-map id, is NOT
 *   silently trusted as "elsewhere" — it falls through to the normal local
 *   check below (conservative default: verify locally unless proven
 *   otherwise). This only widens the existing record-level Repo: skip; it
 *   never narrows it.
 * - Archived-section noise aggregation (T-489): the "Recently completed"
 *   section accumulates historical evidence over the life of a repo, and a
 *   large number of individually-reported info findings there drowns real
 *   warnings elsewhere in the report. When the number of unreachable
 *   findings collected for that section exceeds
 *   ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD, they are collapsed into a
 *   single info finding naming the count (with the affected task IDs listed
 *   in the message) instead of one finding per hash. Below the threshold,
 *   findings are still reported individually — the aggregate exists purely
 *   to cap noise, not to hide the check. Severity/exit-code behavior is
 *   unchanged either way: archived-section findings are always info, never
 *   affecting the exit code. The Active tasks section is never aggregated.
 * - Reachability is computed with exactly two batched `git rev-list` calls
 *   (via getCommitHashesReachableFromHead() for HEAD and
 *   getCommitHashesReachable(root, '--branches') for local branches) —
 *   never a subprocess per hash.
 * - Degrades silently (returns [], never throws) when git is unavailable. If
 *   only the `--branches` call fails while HEAD succeeds, the branch tier is
 *   skipped and the check falls back to the original HEAD-only behavior for
 *   the "no local ref" tier.
 * - T-565 — the "no local ref" tier is UNSOUND in a shallow clone (e.g.
 *   actions/checkout@v7's default fetch-depth: 1): `git rev-list` only
 *   enumerates the fetched window, so "not reachable from any local ref" is
 *   indistinguishable from "lives in history that was deliberately never
 *   fetched". Shallowness invalidates only this NEGATIVE tier — a hash found
 *   reachable from HEAD or from `--branches` stays a sound positive result
 *   regardless of clone depth. When `isShallowRepository(root)` is true,
 *   every individual "no local ref" finding is suppressed and its task id
 *   collected instead; the collected ids are collapsed into exactly ONE
 *   info-severity stand-down finding after both sections are scanned (never
 *   zero-to-many individual warnings, and never silent skip with no signal
 *   at all). In a full (non-shallow) clone this branch never triggers and
 *   behavior is byte-identical to pre-T-565. The stand-down message states
 *   the true total count in full but caps the enumerated task ids at
 *   ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD (reusing this file's existing
 *   convention for collapsing a long finding list rather than inventing a
 *   second one), appending "(+N more)" for the remainder — a CI shallow
 *   clone of a repo's full history can indeterminate hundreds of tasks at
 *   once, and enumerating all of them would recreate the "operator stops
 *   reading" failure mode this task exists to close.
 *
 * @param {object} options
 * @param {Array} options.activeRecords - TASK_STATUS.md "## Active tasks" records.
 * @param {Array} options.recentlyCompletedRecords - TASK_STATUS.md "## Recently completed tasks" records.
 * @param {string} options.root - Absolute path to the git working tree being validated.
 * @param {Object} [options.repoMap] - Pre-parsed repo map (test injection); defaults to parseRepoMap(root).
 * @returns {Array} findings
 */
function checkCommitReachable({ activeRecords, recentlyCompletedRecords, root, repoMap }) {
  const reachableFromHeadHashes = getCommitHashesReachableFromHead(root);
  if (reachableFromHeadHashes === null) return []; // git unavailable — degrade silently

  const reachableFromHeadIndex = buildReachableHashIndex(reachableFromHeadHashes);

  const reachableFromBranchesHashes = getCommitHashesReachable(root, '--branches');
  const reachableFromBranchesIndex =
    reachableFromBranchesHashes === null ? null : buildReachableHashIndex(reachableFromBranchesHashes);

  // T-565: a shallow clone makes the "no local ref" tier unsound — see the
  // doc comment above. Detected once per call; only the negative-result
  // branch of buildHashFinding below consults it.
  const isShallow = isShallowRepository(root);
  const shallowIndeterminateTaskIds = [];

  const resolvedRepoMap = repoMap || parseRepoMap(root);
  const selfRepoId = resolveSelfRepoId(root, resolvedRepoMap);
  // Case-insensitive id lookup for annotation resolution (repo-map ids are
  // written as-is in docs/REPO_MAP.md headings; evidence annotations may not
  // match case exactly).
  const repoMapIdByLowerId = new Map(Object.keys(resolvedRepoMap || {}).map((id) => [id.toLowerCase(), id]));

  const findings = [];

  // Returns the finding for a single unreachable/branch-held hash, or null
  // when the hash is reachable from HEAD (no finding).
  const buildHashFinding = (record, noRefSeverity, hash) => {
    if (isHashReachable(hash, reachableFromHeadIndex)) return null; // reachable from HEAD — no finding

    if (reachableFromBranchesIndex !== null && isHashReachable(hash, reachableFromBranchesIndex)) {
      // Held on a local branch, not on HEAD — the normal pre-push state.
      return createFinding({
        checkName: 'commit_unreachable',
        severity: 'info',
        taskId: record.taskId,
        message: `${record.taskId} is ${record.status} with evidence commit: ${hash} — held on a local branch, not on HEAD (not yet merged/pushed to the checked-out branch)`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: `Normal pre-push state — merge/push the branch holding commit ${hash} to HEAD when ready. No action required otherwise.`,
      });
    }

    // Reachable from no local ref at all — the original T-448 footgun.
    if (isShallow) {
      // T-565: unsound in a shallow clone — suppress the individual finding
      // and stand it down collectively after both sections are scanned.
      shallowIndeterminateTaskIds.push(record.taskId);
      return null;
    }

    return createFinding({
      checkName: 'commit_unreachable',
      severity: noRefSeverity,
      taskId: record.taskId,
      message: `${record.taskId} is ${record.status} with evidence commit: ${hash} but that hash is not reachable from any local ref`,
      repairTarget: 'TASK_STATUS.md',
      suggestedAction: `Verify commit ${hash} actually landed on a local branch (e.g. cherry-pick/merge the sub-agent's worktree commit), then update the evidence hash if it changed.`,
    });
  };

  const scanSection = (records, noRefSeverity, { aggregate = false } = {}) => {
    const collected = [];

    for (const record of records || []) {
      if (!TERMINAL_TASK_STATUSES.has(record.status)) continue;

      if (selfRepoId && record.repo) {
        const repoIds = record.repo.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
        if (repoIds.length > 0 && !repoIds.includes(selfRepoId.toLowerCase())) continue; // cross-repo — skip
      }

      const evidence = getFieldMultiline(record.rawBlock, 'Evidence');
      const entries = extractCommitEntriesFromEvidence(evidence);
      for (const { hash, repoAnnotation } of entries) {
        if (repoAnnotation) {
          const resolvedId = repoMapIdByLowerId.get(repoAnnotation.toLowerCase());
          if (resolvedId && (!selfRepoId || resolvedId.toLowerCase() !== selfRepoId.toLowerCase())) {
            continue; // annotation names a KNOWN other repo — its history lives there, skip
          }
          // Annotation names the self repo, or matches no known repo-map id
          // at all — fall through to the normal local check below.
        }

        const finding = buildHashFinding(record, noRefSeverity, hash);
        if (finding) collected.push(finding);
      }
    }

    if (aggregate && collected.length > ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD) {
      const taskIds = collected.map((f) => f.taskId).join(', ');
      findings.push(
        createFinding({
          checkName: 'commit_unreachable',
          severity: 'info',
          taskId: 'AGGREGATE',
          message: `${collected.length} archived-section commit_unreachable findings collapsed into this single advisory (evidence hashes unreachable from HEAD, or held only on local branches) — info severity, never affects the exit code. Affected tasks: ${taskIds}`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Historical archived-section evidence gaps; inspect individual task evidence only if auditing old worktree integrations.',
        })
      );
    } else {
      findings.push(...collected);
    }
  };

  scanSection(activeRecords, 'warning');
  scanSection(recentlyCompletedRecords, 'info', { aggregate: true });

  // T-565: emit the single shallow-clone stand-down finding ONLY when at
  // least one hash was actually indeterminate — an adopter's shallow clone
  // with no merged-task evidence gaps gets no line at all, since nothing
  // stood down. A shallow clone of a long-lived repo's FULL history (exactly
  // what CI does) can indeterminate hundreds of tasks at once; enumerating
  // every id turns the advisory into an unreadable wall — the very "operator
  // stops reading" failure mode this task exists to close, just via a
  // different mechanism than the original noisy warning. Reuse the same cap
  // this file already uses for exactly this shape of problem
  // (ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD, which collapses archived-
  // section unreachable findings above the threshold) rather than inventing
  // a second magic number: name up to that many task ids, then summarize the
  // remainder as "(+N more)". The true total count is always stated in full
  // — that number is genuinely useful (it tells the operator how much of
  // history is out of window) — only the id enumeration is capped.
  if (isShallow && shallowIndeterminateTaskIds.length > 0) {
    const uniqueTaskIds = [...new Set(shallowIndeterminateTaskIds)];
    const shownTaskIds = uniqueTaskIds.slice(0, ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD);
    const remainingCount = uniqueTaskIds.length - shownTaskIds.length;
    const taskIdsSummary = remainingCount > 0 ? `${shownTaskIds.join(', ')} (+${remainingCount} more)` : shownTaskIds.join(', ');
    findings.push(
      createFinding({
        checkName: 'commit_unreachable',
        severity: 'info',
        taskId: 'AGGREGATE',
        message: `Shallow git clone detected (git rev-parse --is-shallow-repository) — ${shallowIndeterminateTaskIds.length} evidence commit hash(es) not found in the fetched history stood down rather than reported unreachable, since a shallow clone's fetched window carries no information about history it deliberately never fetched. Affected tasks: ${taskIdsSummary}`,
        repairTarget: 'TASK_STATUS.md',
        suggestedAction: 'Informational only — a shallow clone (e.g. CI checkout with fetch-depth: 1) cannot distinguish a genuinely unreachable hash from one that simply lives outside the fetched window. Re-run in a full clone for a sound reachability read; no action required from this signal alone.',
      })
    );
  }

  return findings;
}

/**
 * overdue_rechecks: overdue recheck advisory.
 * Reads rechecks[] from PROCESS_STATE.json and computes which entries are
 * overdue (due date is strictly before today). Emits one info-severity finding
 * per overdue entry describing the RC id, task ref, title, and due date.
 * Advisory only (info severity, exits 0) — an overdue recheck is not an
 * artifact inconsistency and must NEVER cause exit 2 or even exit 1.
 */
function checkOverdueRechecks(processStatePath) {
  let rechecks;
  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    rechecks = parsed.rechecks;
  } catch (_err) {
    return [];
  }

  if (!Array.isArray(rechecks) || rechecks.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { overdue } = computeDueRechecks(rechecks, today);

  return overdue.map((entry) => {
    const rcId = entry.id || '(no id)';
    const taskRef = entry.task || '(no task ref)';
    const title = entry.title || '(no title)';
    const dueDate = entry.due;
    return createFinding({
      checkName: 'overdue_recheck',
      taskId: taskRef,
      message: `Recheck ${rcId} for ${taskRef} ("${title}") was due ${dueDate} and is overdue`,
      repairTarget: 'PROCESS_STATE.json',
      suggestedAction: `Review ${taskRef} and either act on the recheck or remove/update the entry in PROCESS_STATE.json rechecks[].`,
    });
  });
}

/**
 * next_action_volatile_facts: next_action volatile-facts advisory.
 * Reads next_action from PROCESS_STATE.json and classifies it with
 * classifyNextAction() from mavp-operator-lib.js. When the classifier finds
 * volatile facts (framework versions, unpushed-commit counts) embedded in the
 * string, emits one info-severity finding naming the matched facts and
 * advising to keep next_action a clean routing directive (move narrative
 * detail to HANDOFF.md instead).
 * Advisory only (info severity, exits 0) — mirrors the overdue_recheck
 * precedent: PROCESS_STATE.json is informational, so this check must NEVER
 * cause exit 1 or exit 2.
 */
function checkNextActionVolatileFacts(processStatePath) {
  let nextAction;
  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    nextAction = parsed.next_action;
  } catch (_err) {
    return [];
  }

  const { volatile_facts } = classifyNextAction(nextAction);
  if (volatile_facts.length === 0) return [];

  const factsList = volatile_facts.join(', ');
  return [
    createFinding({
      checkName: 'next_action_volatile_facts',
      taskId: '(process_state.next_action)',
      message: `PROCESS_STATE.json next_action embeds volatile fact(s) (${factsList}) that will go stale`,
      repairTarget: 'PROCESS_STATE.json',
      suggestedAction: 'Keep next_action a clean routing directive (e.g. "T-NNN -> role -> short goal"); move narrative detail or point-in-time facts (versions, commit counts) to HANDOFF.md instead.',
    }),
  ];
}

/**
 * Default line budgets for artifact_size_budget. Overridable per-field via an
 * `artifact_budgets` object in PROCESS_STATE.json (any subset of keys; missing
 * keys fall back to these defaults).
 */
const DEFAULT_ARTIFACT_BUDGETS = {
  claude_md_max_lines: 400,
  handoff_md_max_lines: 300,
  backlog_active_wave_max_lines: 200,
  task_status_active_tasks_max_lines: 150,
};

/**
 * T-442: per-task line allowances used to scale the two Active-section budgets
 * (backlog_active_wave_max_lines, task_status_active_tasks_max_lines) by how
 * many tasks are actually in flight, so a legitimately large wave (many tasks,
 * not bloated per-task content) doesn't permanently trip the advisory.
 *
 * BACKLOG_ACTIVE_WAVE_PER_TASK_LINES = 15: a full BACKLOG.md task block
 * (heading + title + Status/Owner/Verification type/Definition of done/etc.
 * field bullets + blank lines) runs roughly 12-18 lines in practice; 15
 * strikes the middle and is high enough that 24 tasks * 15 = 360 lines clears
 * a 340-line section, while 3 tasks * 15 = 45 stays far under the 200-line
 * static floor (so a 340-line, 3-task section still trips on the static
 * default).
 *
 * TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES = 10: TASK_STATUS.md entries are
 * shorter than their BACKLOG counterparts (status + evidence only, no
 * definition-of-done prose), so a lower per-task allowance is realistic;
 * combined with the 150-line static floor this still scales sensibly for
 * large waves (e.g. 20 tasks * 10 = 200 > 150).
 */
const BACKLOG_ACTIVE_WAVE_PER_TASK_LINES = 15;
const TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES = 10;

function resolveArtifactBudgetOverrides(processStatePath) {
  try {
    const raw = fs.readFileSync(processStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.artifact_budgets && typeof parsed.artifact_budgets === 'object') {
      return parsed.artifact_budgets;
    }
  } catch (_err) {
    // PROCESS_STATE.json missing/unreadable — no overrides.
  }
  return {};
}

function resolveArtifactBudgets(processStatePath) {
  const overrides = resolveArtifactBudgetOverrides(processStatePath);
  return { ...DEFAULT_ARTIFACT_BUDGETS, ...overrides };
}

/**
 * Resolve one of the two Active-section budgets: an explicit override always
 * wins; otherwise the budget is max(static default, per-task allowance *
 * active task count).
 */
function resolveScaledSectionBudget({ overrides, overrideKey, staticDefault, perTaskAllowance, activeTaskCount }) {
  if (Object.prototype.hasOwnProperty.call(overrides, overrideKey)) {
    return overrides[overrideKey];
  }
  return Math.max(staticDefault, perTaskAllowance * activeTaskCount);
}

function countLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

/**
 * artifact_size_budget (info severity, NEVER blocks — exit 0 always
 * for this check on its own).
 * Fires when:
 *   - CLAUDE.md whole-file line count exceeds claude_md_max_lines, or
 *   - HANDOFF.md whole-file line count exceeds handoff_md_max_lines, or
 *   - the BACKLOG.md `## Active Wave` section exceeds its (scaled) budget, or
 *   - the TASK_STATUS.md `## Active tasks` section exceeds its (scaled) budget.
 * Archived wave sections are never counted: getSectionContent() stops at the
 * next top-level `## ` heading, so anything archived outside the current
 * Active Wave / Active tasks section is excluded by construction.
 * T-442: the two Active-section budgets scale with how many tasks are actually
 * in the section — each resolves to max(static default, per-task allowance *
 * active task count) via resolveScaledSectionBudget(), so a wave with many
 * legitimate tasks doesn't permanently trip the advisory just for having more
 * tasks. An explicit `artifact_budgets` override in PROCESS_STATE.json always
 * takes precedence over the computed value for that field. claude_md_max_lines
 * and handoff_md_max_lines remain flat static budgets (whole-file, not scaled
 * by task count) and are overridable the same way via `artifact_budgets`.
 * HANDOFF.md and CLAUDE.md are optional files — silently skipped if absent.
 */
function checkArtifactSizeBudget({ backlogMarkdown, taskStatusMarkdown, backlogPath, processStatePath }) {
  const budgets = resolveArtifactBudgets(processStatePath);
  const overrides = resolveArtifactBudgetOverrides(processStatePath);
  const repoRoot = path.dirname(backlogPath);
  const findings = [];

  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const lineCount = countLines(readUtf8(claudeMdPath));
    if (lineCount > budgets.claude_md_max_lines) {
      findings.push(
        createFinding({
          checkName: 'artifact_size_budget',
          taskId: null,
          message: `CLAUDE.md is ${lineCount} lines, exceeding the budget of ${budgets.claude_md_max_lines}`,
          repairTarget: 'CLAUDE.md',
          suggestedAction: 'Trim CLAUDE.md toward the line budget, or raise claude_md_max_lines in PROCESS_STATE.json artifact_budgets if the growth is intentional.',
        })
      );
    }
  }

  const handoffMdPath = path.join(repoRoot, 'HANDOFF.md');
  if (fs.existsSync(handoffMdPath)) {
    const lineCount = countLines(readUtf8(handoffMdPath));
    if (lineCount > budgets.handoff_md_max_lines) {
      findings.push(
        createFinding({
          checkName: 'artifact_size_budget',
          taskId: null,
          message: `HANDOFF.md is ${lineCount} lines, exceeding the budget of ${budgets.handoff_md_max_lines}`,
          repairTarget: 'HANDOFF.md',
          suggestedAction: 'Trim HANDOFF.md toward the line budget, or raise handoff_md_max_lines in PROCESS_STATE.json artifact_budgets if the growth is intentional.',
        })
      );
    }
  }

  const backlogActiveWaveSection = getSectionContent(backlogMarkdown, /^##\s+Active Wave/mi, '## Active Wave', { optional: true });
  if (backlogActiveWaveSection) {
    const lineCount = countLines(backlogActiveWaveSection);
    const activeTaskCount = getTaskBlocks(backlogActiveWaveSection).length;
    const backlogActiveWaveBudget = resolveScaledSectionBudget({
      overrides,
      overrideKey: 'backlog_active_wave_max_lines',
      staticDefault: DEFAULT_ARTIFACT_BUDGETS.backlog_active_wave_max_lines,
      perTaskAllowance: BACKLOG_ACTIVE_WAVE_PER_TASK_LINES,
      activeTaskCount,
    });
    if (lineCount > backlogActiveWaveBudget) {
      findings.push(
        createFinding({
          checkName: 'artifact_size_budget',
          taskId: null,
          message: `BACKLOG.md Active Wave section is ${lineCount} lines, exceeding the budget of ${backlogActiveWaveBudget}`,
          repairTarget: 'BACKLOG.md',
          suggestedAction: 'Archive merged/completed tasks out of the Active Wave section, or raise backlog_active_wave_max_lines in PROCESS_STATE.json artifact_budgets.',
        })
      );
    }
  }

  const taskStatusActiveSection = getSectionContent(taskStatusMarkdown, /^##\s+Active tasks\s*$/m, '## Active tasks', { optional: true });
  if (taskStatusActiveSection) {
    const lineCount = countLines(taskStatusActiveSection);
    const activeTaskCount = getTaskBlocks(taskStatusActiveSection).length;
    const taskStatusActiveBudget = resolveScaledSectionBudget({
      overrides,
      overrideKey: 'task_status_active_tasks_max_lines',
      staticDefault: DEFAULT_ARTIFACT_BUDGETS.task_status_active_tasks_max_lines,
      perTaskAllowance: TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES,
      activeTaskCount,
    });
    if (lineCount > taskStatusActiveBudget) {
      findings.push(
        createFinding({
          checkName: 'artifact_size_budget',
          taskId: null,
          message: `TASK_STATUS.md Active tasks section is ${lineCount} lines, exceeding the budget of ${taskStatusActiveBudget}`,
          repairTarget: 'TASK_STATUS.md',
          suggestedAction: 'Archive completed tasks out of the Active tasks section, or raise task_status_active_tasks_max_lines in PROCESS_STATE.json artifact_budgets.',
        })
      );
    }
  }

  return findings;
}

/**
 * state_in_claude_md (info severity, NEVER blocks).
 * Fires when CLAUDE.md contains task-state-shaped lines: `### T-NNN` headings
 * or `- **Status:**` fields. CLAUDE.md is process/convention guidance, not a
 * task-state ledger — live task state belongs only in BACKLOG.md /
 * TASK_STATUS.md. Silently skipped when CLAUDE.md does not exist.
 */
function checkStateInClaudeMd(backlogPath) {
  const repoRoot = path.dirname(backlogPath);
  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return [];

  const content = readUtf8(claudeMdPath);
  const lines = content.split(/\r?\n/);
  const matchedLines = [];

  lines.forEach((line, idx) => {
    if (/^###\s+T-\d+\b/.test(line) || /^-\s+\*\*Status:\*\*/.test(line)) {
      matchedLines.push({ lineNumber: idx + 1, text: line.trim() });
    }
  });

  if (matchedLines.length === 0) return [];

  return [
    createFinding({
      checkName: 'state_in_claude_md',
      taskId: null,
      message: `CLAUDE.md contains ${matchedLines.length} task-state-shaped line(s) (### T-NNN headings or - **Status:** fields) — task state belongs only in BACKLOG.md / TASK_STATUS.md`,
      repairTarget: 'CLAUDE.md',
      suggestedAction: 'Move task-state content out of CLAUDE.md into BACKLOG.md / TASK_STATUS.md; CLAUDE.md should contain process guidance only.',
      details: { matchedLines: matchedLines.slice(0, 5) },
    }),
  ];
}

/**
 * Resolve the root used to locate docs/REPO_MAP.md for the blocked-by check.
 * Thin delegate to getProjectRoot() so parseRepoMap() (mavp-operator-lib.js)
 * looks in the same place the rest of the validator does.
 */
function getBlockedByRepoMapRoot() {
  return getProjectRoot();
}

/**
 * Read a task's Status field directly out of a sibling repo's BACKLOG.md or
 * TASK_STATUS.md, without throwing. Returns null when the file is absent, the
 * task heading isn't found, or the Status field is missing. Reuses
 * getTaskBlocks()/getField() so heading/field parsing stays identical to the
 * rest of the validator.
 *
 * @param {string} filePath - Absolute path to a BACKLOG.md or TASK_STATUS.md
 * @param {string} taskId - e.g. "T-100"
 * @returns {string|null}
 */
function findTaskStatusInFile(filePath, taskId) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const blocks = getTaskBlocks(content);
    const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^###\\s+${escaped}\\b`);
    const block = blocks.find((b) => re.test(b));
    if (!block) return null;
    return getField(block, 'Status');
  } catch (_err) {
    return null;
  }
}

// Statuses gated by the cross-repo Blocked by check, mapped to the severity
// used when their blocker is not merged.
//
// Per DR-005 (docs/core/DECISIONS.md): `merged` stays FAILURE — shipping
// ahead of an unmet dependency is the actual violation this gate exists to
// prevent. `qa_passed` is WARNING, not FAILURE — a qa_passed task with an
// unmerged blocker is precisely the state this gate exists to hold a task
// in (the owner finished their side and is correctly waiting on someone
// else's); failing that state at FAILURE severity punishes correct
// behavior, and doing so is what burned the validator's exit-2 bit in the
// field (a real adopter session latched permanently at "repair required"
// over a deliberately-held, not broken, dependency chain). `ready_for_qa`
// keeps its pre-existing WARNING tier, unchanged. Any other status is not
// gated.
const BLOCKED_BY_GATE_STATUSES = {
  merged: 'failure',
  qa_passed: 'warning',
  ready_for_qa: 'warning',
};

/**
 * Hub-model local fallback (T-456): when a `<repo>/T-NNN` Blocked by
 * reference can't be resolved against the target repo's own artifacts
 * (repo id/path unresolvable, or the task isn't found there), some
 * organizations track ALL cross-repo tasks in a single hub backlog instead
 * of per-repo backlogs. In that model the blocker actually lives in the
 * VALIDATING repo's own backlog records, under the referenced repo's task
 * namespace.
 *
 * This looks up ref.taskId in the validating repo's already-parsed record
 * set (the same `records` passed into checkBlockedBy — no re-parsing) and
 * accepts the match ONLY when that local task's own Repo/Repos field
 * includes the referenced repo id. This precision guard prevents an
 * unrelated same-numbered local task from being mistaken for a foreign
 * repo's task (hub-namespace vs. foreign-repo-namespace collision).
 *
 * @param {Array} records - The validating repo's own backlog records (same
 *   array passed to checkBlockedBy).
 * @param {{repo: string, taskId: string}} ref - The parsed Blocked by
 *   reference being resolved.
 * @returns {string|null} The local hub-tracked task's Status, or null when
 *   no repo-matching local task is found.
 */
function resolveHubLocalBlocker(records, ref) {
  const localMatch = records.find((r) => r.taskId === ref.taskId);
  if (!localMatch) return null;

  const localRepoIds = (localMatch.repo || '')
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  if (!localRepoIds.includes(ref.repo.toLowerCase())) return null;

  return localMatch.status || null;
}

/**
 * blocked_by: cross-repo Blocked by relation with validator merge gate (T-393).
 *
 * Tasks may declare `- **Blocked by:** <repo>/T-NNN[, <repo>/T-MMM ...]`.
 * For every backlog task currently `merged`, `qa_passed`, or `ready_for_qa`
 * with a `Blocked by:` field, each `<repo>/T-NNN` reference is resolved via
 * the repo map (`docs/REPO_MAP.md`'s `path` field, through parseRepoMap()),
 * then that repo's BACKLOG.md/TASK_STATUS.md is read to find the blocker
 * task's Status:
 *   - `blocked_by_open` at FAILURE severity when the blocked task is `merged`
 *     and the blocker is not `merged` (DR-005: shipping ahead of an unmet
 *     dependency is the violation this gate exists to prevent);
 *   - `blocked_by_open` at WARNING severity when the blocked task is
 *     `qa_passed` or `ready_for_qa` and the blocker is not `merged` (DR-005:
 *     a qa_passed task correctly waiting on its blocker is not a violation —
 *     it is the gate holding a task in the state it exists to hold it in);
 *   - `blocked_by_unresolvable` at INFO severity when the `Blocked by:` value
 *     can't be parsed, the repo id/path can't be resolved, or the blocker
 *     task can't be found in either of the resolved repo's artifact files.
 *
 * Hub-backlog fallback (T-456): before emitting blocked_by_unresolvable for
 * either "repo id/path unresolvable" or "blocker task not found in the
 * target repo", resolveHubLocalBlocker() is tried against the validating
 * repo's OWN records — this supports organizations that track all
 * cross-repo tasks in a single hub backlog rather than per-repo backlogs.
 * The fallback is accepted only when the local task's own Repo/Repos field
 * includes the referenced repo id (see resolveHubLocalBlocker() for the
 * precision-guard rationale). When accepted, gate semantics (blocked_by_open
 * severity by blocked-task status) are unchanged — they just apply against
 * the hub-local blocker's status instead of the target repo's. This is a
 * no-op for non-hub projects: when the target repo resolves normally,
 * the fallback is never consulted.
 *
 * Entirely separate from `Depends on:` (same-repo, parsed inline in
 * mavp-operator-agent.js's computeNextAction()) — that parsing and behavior
 * is untouched. Tasks with no `Blocked by:` field (the mavericks-repo default)
 * produce no findings — this check is a silent no-op for them.
 *
 * No-blockers placeholder (T-492): a `Blocked by:` value of the standard
 * em-dash (`—`) or plain hyphen (`-`) — the same "no blockers" convention
 * parseBlockedBy() already accepts — is treated identically to an absent
 * field: zero findings, never `blocked_by_unresolvable`. Both this function
 * and parseBlockedBy() route through the shared isBlockedByEmpty() helper so
 * they cannot disagree on what counts as empty. A genuinely non-empty value
 * that still fails to parse as `<repo>/T-NNN` continues to produce
 * `blocked_by_unresolvable` as before.
 *
 * @param {Array} records - Backlog records (parseBacklogAllActiveWaveTasks()
 *   output, so merged tasks are included).
 * @param {object} [options]
 * @param {object} [options.repoMap] - Pre-parsed repo-map registry (test
 *   injection); when absent, resolved via parseRepoMap(repoMapRoot).
 * @param {string} [options.repoMapRoot] - Root passed to parseRepoMap() when
 *   options.repoMap is not supplied (test injection); defaults to
 *   getBlockedByRepoMapRoot().
 * @returns {Array} findings
 */
function checkBlockedBy(records, options = {}) {
  const findings = [];
  const repoMap = options.repoMap || parseRepoMap(options.repoMapRoot || getBlockedByRepoMapRoot());

  for (const record of records) {
    const gateSeverity = BLOCKED_BY_GATE_STATUSES[record.status];
    if (!gateSeverity) continue;

    const blockedByRaw = record.blockedBy;
    // T-492: route the emptiness decision through the same isBlockedByEmpty()
    // helper parseBlockedBy() uses internally, rather than re-testing raw
    // truthiness here. An absent field AND the conventional "no blockers"
    // em-dash/hyphen placeholder are both accepted as empty — only a
    // genuinely non-empty, unparsable value below reaches
    // blocked_by_unresolvable.
    if (isBlockedByEmpty(blockedByRaw)) continue;

    const refs = parseBlockedBy(blockedByRaw);
    if (refs.length === 0) {
      findings.push(
        createFinding({
          checkName: 'blocked_by_unresolvable',
          taskId: record.taskId,
          message: `${record.taskId} declares Blocked by: "${blockedByRaw}" but it could not be parsed as <repo>/T-NNN`,
          repairTarget: 'BACKLOG.md',
          suggestedAction: 'Use the format "- **Blocked by:** <repo>/T-NNN" (comma-separated for multiple references).',
        })
      );
      continue;
    }

    for (const ref of refs) {
      const entry = repoMap[ref.repo];
      const targetPathValid = Boolean(entry && entry.path && fs.existsSync(entry.path));

      let blockerStatus = targetPathValid
        ? findTaskStatusInFile(path.join(entry.path, 'TASK_STATUS.md'), ref.taskId) ||
          findTaskStatusInFile(path.join(entry.path, 'BACKLOG.md'), ref.taskId)
        : null;

      if (!blockerStatus) {
        // T-456 hub-backlog fallback — tried before either unresolvable
        // branch below, for both "repo id/path unresolvable" and "task not
        // found in a resolvable target repo".
        blockerStatus = resolveHubLocalBlocker(records, ref);
      }

      if (!blockerStatus) {
        if (!targetPathValid) {
          findings.push(
            createFinding({
              checkName: 'blocked_by_unresolvable',
              taskId: record.taskId,
              message: `${record.taskId} declares Blocked by: ${ref.repo}/${ref.taskId} but repo "${ref.repo}" has no resolvable path in docs/REPO_MAP.md`,
              repairTarget: 'docs/REPO_MAP.md',
              suggestedAction: `Add a "${ref.repo}" entry with a valid "path:" to docs/REPO_MAP.md, or correct the Blocked by: field in BACKLOG.md.`,
            })
          );
        } else {
          findings.push(
            createFinding({
              checkName: 'blocked_by_unresolvable',
              taskId: record.taskId,
              message: `${record.taskId} declares Blocked by: ${ref.repo}/${ref.taskId} but ${ref.taskId} could not be found in ${ref.repo}'s BACKLOG.md/TASK_STATUS.md`,
              repairTarget: 'BACKLOG.md',
              suggestedAction: `Verify ${ref.taskId} exists in ${ref.repo} and that docs/REPO_MAP.md "path:" for "${ref.repo}" points at the correct working copy.`,
            })
          );
        }
        continue;
      }

      if (blockerStatus !== 'merged') {
        findings.push(
          createFinding({
            checkName: 'blocked_by_open',
            severity: gateSeverity,
            taskId: record.taskId,
            message: `${record.taskId} is ${record.status} but its blocker ${ref.repo}/${ref.taskId} is not merged (status: ${blockerStatus})`,
            repairTarget: 'BACKLOG.md',
            suggestedAction: `Wait for ${ref.repo}/${ref.taskId} to reach merged before ${record.taskId} can stay ${record.status}, or remove the Blocked by: relation if it no longer applies.`,
          })
        );
      }
    }
  }

  return findings;
}

/**
 * DR-005 — load-bearing scope limit on what a `Hold:` field may downgrade.
 *
 * This is a WHITELIST, not a blacklist: only the check names listed here can
 * ever be touched by applyHoldDowngrade(). A blacklist of "protected" checks
 * rots — the next check someone adds is silently downgradable by default,
 * which is exactly how a scoped exception turns into a general mute. With a
 * whitelist, a brand-new check (merged_missing_commit_field's future sibling,
 * a new mirror check, anything) is protected by construction: it simply isn't
 * in this Set, so applyHoldDowngrade() never sees it as a candidate.
 *
 * Per DR-005 ("Scope limit on what a Hold: may downgrade — load-bearing
 * constraint"), a Hold: may downgrade ONLY deploy- and blocker-adjacent
 * advisories on the SAME task. Today that is exactly `blocked_by_open` — the
 * `qa_passed`/`ready_for_qa` WARNING tier BLOCKED_BY_GATE_STATUSES already
 * assigns it (T-487). It must NEVER reach merged_missing_commit_field, any
 * evidence-completeness check, mirror/sync-status checks, duplicate-entry
 * detection, config_check, or stale_verified — none of those checks are
 * listed here, so none of them are reachable through this mechanism no
 * matter how the rest of applyHoldDowngrade() is edited later.
 *
 * A comparable future deploy-pending check may be added to this Set, but
 * only as an explicit, reviewed addition — never by loosening the gate logic
 * in applyHoldDowngrade() itself.
 */
const HOLD_DOWNGRADABLE_CHECKS = new Set(['blocked_by_open']);

/**
 * Apply the DR-005 scoped `Hold:` downgrade to an already-computed findings
 * array, mutating matching findings' severity in place.
 *
 * A finding is downgraded only when ALL of the following hold:
 *   1. `finding.checkName` is in HOLD_DOWNGRADABLE_CHECKS (the whitelist
 *      above) — never a blacklist test, so an unlisted check is unreachable
 *      no matter what `finding.taskId`/severity it carries.
 *   2. `finding.taskId` has a non-empty `Hold:` field in `holdRecords` (per
 *      isHoldEmpty() — the same "no hold" convention isBlockedByEmpty() uses
 *      for `Blocked by:`).
 *   3. `finding.severity` is NOT already `'failure'`. This is the strict
 *      reading of the `merged` × unmerged-blocker interaction: DR-005's gate
 *      correction (T-487) already keeps that cell at FAILURE because shipping
 *      ahead of an unmet dependency is the actual violation the gate exists
 *      to prevent — a `Hold:` explains a wait, it is not permission to ship
 *      ahead of a dependency, so this function refuses to touch a failure
 *      no matter which check produced it. Only `warning` is ever stepped down
 *      (to `info`); `info` findings have nowhere lower to go.
 *
 * Marks each downgraded finding with `holdDowngraded: true` so the change is
 * traceable in `--json` output and tests, rather than silently invisible.
 *
 * @param {Array} findings - Findings array (mutated in place).
 * @param {Array} holdRecords - Records with `.taskId` and `.hold` (raw string,
 *   e.g. backlogAllWaveRecords) used to build the taskId -> hold map.
 * @returns {number} Count of findings actually downgraded.
 */
function applyHoldDowngrade(findings, holdRecords) {
  const holdMap = new Map();
  for (const record of holdRecords || []) {
    if (record && record.taskId && !isHoldEmpty(record.hold)) {
      holdMap.set(record.taskId, record.hold);
    }
  }

  let downgradedCount = 0;
  for (const finding of findings) {
    if (!HOLD_DOWNGRADABLE_CHECKS.has(finding.checkName)) continue;
    if (!holdMap.has(finding.taskId)) continue;
    if (finding.severity === 'failure' || finding.severity === 'info') continue;

    finding.severity = 'info';
    finding.holdDowngraded = true;
    downgradedCount += 1;
  }

  return downgradedCount;
}

/**
 * Recompute `comparison.counts.bySeverity`/`counts.findings`/
 * `overallCandidateState` from scratch against the current
 * `comparison.findings` array. Called once, after applyHoldDowngrade() may
 * have mutated finding severities in place — the incremental math
 * mergeFindings() does per-check-batch cannot be trusted once a finding's
 * severity changes after it was already counted. Safe to call unconditionally
 * (including when no Hold: exists anywhere): it always recomputes purely from
 * the current findings array, so it reproduces mergeFindings()'s own
 * aggregation exactly when nothing was downgraded.
 *
 * @param {object} comparison - The comparison object built by compareRecords()
 *   / mutated by mergeFindings() (has `.findings`, `.counts`,
 *   `.overallCandidateState`).
 */
function recomputeComparisonAggregates(comparison) {
  const bySeverity = { failure: 0, warning: 0, info: 0 };
  for (const finding of comparison.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  }
  comparison.counts.bySeverity = bySeverity;
  comparison.counts.findings = comparison.findings.length;
  comparison.overallCandidateState = bySeverity.failure > 0
    ? 'misleading_repair_required'
    : bySeverity.warning > 0
      ? 'usable_but_drifting'
      : 'healthy';
}

function mergeFindings(comparison, extraFindings) {
  if (extraFindings.length === 0) return;
  comparison.findings.push(...extraFindings);
  comparison.counts.findings += extraFindings.length;
  const failureCount = extraFindings.filter((f) => f.severity === 'failure').length;
  const warningCount = extraFindings.filter((f) => f.severity === 'warning').length;
  const infoCount = extraFindings.filter((f) => f.severity === 'info').length;
  comparison.counts.bySeverity.failure = (comparison.counts.bySeverity.failure || 0) + failureCount;
  comparison.counts.bySeverity.warning = (comparison.counts.bySeverity.warning || 0) + warningCount;
  comparison.counts.bySeverity.info = (comparison.counts.bySeverity.info || 0) + infoCount;
  // Info-only findings do not affect overall state
  if (failureCount > 0 && comparison.overallCandidateState !== 'misleading_repair_required') {
    comparison.overallCandidateState = 'misleading_repair_required';
  } else if (warningCount > 0 && comparison.overallCandidateState === 'healthy') {
    comparison.overallCandidateState = 'usable_but_drifting';
  }
}

/**
 * Declarative registry of per-feature validator checks (T-462). Each entry is
 * a `{ name, run(ctx) }` pair: `name` is the check's identity for readers of
 * this file (the emitted `checkName` on findings is still set inside each
 * check function itself — this registry name is a docblock/registry label,
 * not a rename of any finding's checkName); `run(ctx)` calls the check
 * function with whatever slice of the shared context it needs and returns its
 * findings array (possibly empty).
 *
 * parseArtifacts() builds `ctx` once, then iterates CHECKS in this exact
 * order, merging each result via mergeFindings(). The array order below IS
 * the validator's finding order (findings render in the order they were
 * merged) — this is the same order the former hand-wired mergeFindings()
 * call-sites ran in, preserved exactly. Do not reorder entries without
 * re-verifying byte-identical output against the golden fixtures.
 *
 * Adding a future check is now a single entry here (plus the check function
 * itself) instead of editing parseArtifacts() boilerplate.
 */
const CHECKS = [
  // Duplicate ### T-NNN headings within BACKLOG.md's Active Wave — always failure-severity.
  { name: 'duplicate_task_ids', run: (ctx) => checkDuplicateTaskIds(ctx.backlogMarkdown) },
  // Whole-file TASK_STATUS.md duplicate detection: duplicate ### T-NNN headings
  // or duplicate ## <section> headings anywhere in the file, across all
  // sections (not just Active tasks) — catches incomplete archival fallout
  // that duplicate_active_task/checkDuplicateTaskIds miss.
  { name: 'duplicate_task_status_entries', run: (ctx) => checkDuplicateTaskStatusEntries(ctx.taskStatusMarkdown) },
  // Use all wave records (including merged) so drift is detected even when no active tasks remain.
  { name: 'last_task_id', run: (ctx) => checkLastTaskId(ctx.backlogAllWaveRecords, ctx.processStatePath) },
  // active_slices sync: every ID in PROCESS_STATE.json active_slices must match an active task in BACKLOG.
  { name: 'active_slices', run: (ctx) => checkActiveSlices(ctx.backlogRecords, ctx.processStatePath) },
  // Module check: resolve project-level MODULES.md (respects MAVERICKS_PROJECT_ROOT).
  { name: 'module_ids', run: (ctx) => checkModuleIds(ctx.backlogRecords, null) },
  // Repo map check: resolve project-level REPO_MAP.md (respects MAVERICKS_PROJECT_ROOT).
  { name: 'repo_ids', run: (ctx) => checkRepoIds(ctx.backlogRecords, null) },
  // Exploration task must declare output_doc (check all wave tasks, including planned).
  { name: 'exploration_output_doc', run: (ctx) => checkExplorationOutputDoc(ctx.backlogAllWaveRecords) },
  // Cross-repo evidence: merged tasks with Repos: [a, b] need per-repo commit evidence.
  { name: 'cross_repo_evidence', run: (ctx) => checkCrossRepoEvidence(ctx.backlogAllWaveRecords, ctx.taskStatusRecords) },
  // Config check: qa_passed/merged tasks with requires_config_check: true need config_check: in evidence.
  { name: 'config_check', run: (ctx) => checkConfigCheck(ctx.backlogAllWaveRecords, ctx.taskStatusRecords) },
  // Docs ref validator: warn on docs/[A-Z_]+.md refs in Evidence/Notes of merged tasks.
  { name: 'docs_refs', run: (ctx) => checkDocsRefs(ctx.taskStatusRecords) },
  // dev_done branch check: warn when dev_done evidence has commit: but no branch:.
  { name: 'dev_done_branch', run: (ctx) => checkDevDoneBranch(ctx.taskStatusRecords) },
  // Architecture doc stale check: warn when a merged task declares Update architecture: true
  // but docs/ARCHITECTURE.md Last updated: is older than PROCESS_STATE.json last_updated.
  { name: 'architecture_doc_stale', run: (ctx) => checkArchitectureDocStale(ctx.backlogAllWaveRecords, ctx.processStatePath) },
  // needs_fix_rounds advisory: info-level nudge for merged runtime/manual tasks missing the field.
  { name: 'merged_needs_fix_rounds', run: (ctx) => checkMergedNeedsFixRounds(ctx.taskStatusRecords) },
  // conflicting needs_fix_rounds / validator_blocked (T-558): warning-level
  // distinct-values check over every TASK_STATUS.md section (active, recently
  // completed, archived) — a second, disagreeing occurrence in a task's
  // Evidence field means skill-reflection's first-match parse can read a
  // stale/wrong value. Uses taskStatusAllTasksAnySection (whole-file,
  // section-agnostic), matching extractTrajectories' read scope, NOT the
  // active-only taskStatusRecords — every realized corruption on the live
  // artifact lived in an archived/recently-completed section.
  { name: 'conflicting_needs_fix_rounds', run: (ctx) => checkConflictingNeedsFixRounds(ctx.taskStatusAllTasksAnySection) },
  { name: 'conflicting_validator_blocked', run: (ctx) => checkConflictingValidatorBlocked(ctx.taskStatusAllTasksAnySection) },
  // overdue recheck advisory: info-level nudge for rechecks past their due date.
  { name: 'overdue_rechecks', run: (ctx) => checkOverdueRechecks(ctx.processStatePath) },
  // next_action volatile-facts advisory: info-level nudge when next_action embeds
  // point-in-time facts (versions, commit counts) instead of a clean routing directive.
  { name: 'next_action_volatile_facts', run: (ctx) => checkNextActionVolatileFacts(ctx.processStatePath) },
  // artifact size budget advisory: info-level nudge when CLAUDE.md/HANDOFF.md or the
  // BACKLOG.md Active Wave / TASK_STATUS.md Active tasks sections exceed line budgets.
  {
    name: 'artifact_size_budget',
    run: (ctx) =>
      checkArtifactSizeBudget({
        backlogMarkdown: ctx.backlogMarkdown,
        taskStatusMarkdown: ctx.taskStatusMarkdown,
        backlogPath: ctx.backlogPath,
        processStatePath: ctx.processStatePath,
      }),
  },
  // state-in-CLAUDE.md advisory: info-level nudge when CLAUDE.md contains
  // task-state-shaped lines (### T-NNN headings or - **Status:** fields).
  { name: 'state_in_claude_md', run: (ctx) => checkStateInClaudeMd(ctx.backlogPath) },
  // Cross-repo Blocked by gate: failure/warning when a merged/qa_passed/
  // ready_for_qa task's Blocked by: reference resolves to a non-merged
  // blocker task in another repo; info when the reference is unresolvable.
  { name: 'blocked_by', run: (ctx) => checkBlockedBy(ctx.backlogAllWaveRecords) },
  // commit_unreachable advisory (T-448): warning for Active tasks / info for
  // Recently completed tasks when a merged evidence commit: hash is not
  // reachable from HEAD (worktree cherry-pick footgun). Degrades silently
  // when git is unavailable.
  {
    name: 'commit_reachable',
    run: (ctx) =>
      checkCommitReachable({
        activeRecords: ctx.taskStatusRecords,
        recentlyCompletedRecords: ctx.taskStatusRecentlyCompletedRecords,
        root: ctx.root,
      }),
  },
  // cross-section terminal-status disagreement (T-543, failure): a BACKLOG
  // task terminal (merged/deployed_dev/deployed_prod) in ANY section whose
  // TASK_STATUS record in ANY section still carries a non-terminal status —
  // catches the 2026-07-26 corruption shape once both blocks have been
  // archived out of their active sections.
  {
    name: 'cross_section_terminal_status_disagreement',
    run: (ctx) =>
      checkCrossSectionTerminalStatusDisagreement(ctx.backlogAllTasksAnySection, ctx.taskStatusAllTasksAnySection),
  },
  // non-terminal status inside a TASK_STATUS completed/archived section
  // (T-543, warning): placement hygiene — a task moved to "Recently
  // completed tasks" (or any future non-"Active tasks" section) without an
  // actual terminal status.
  {
    name: 'non_terminal_status_in_completed_section',
    run: (ctx) => checkNonTerminalStatusInCompletedSection(ctx.taskStatusAllTasksAnySection),
  },
  // missing TASK_STATUS record anywhere (T-547, warning): complement to the
  // disagreement check above — fires when a terminal-status BACKLOG task in
  // ANY section has NO matching TASK_STATUS record in ANY section at all
  // (nothing to disagree with, because the block was dropped rather than
  // moved).
  {
    name: 'missing_task_status_record_anywhere',
    run: (ctx) => checkMissingTaskStatusRecordAnywhere(ctx.backlogAllTasksAnySection, ctx.taskStatusAllTasksAnySection),
  },
  // reverse-direction terminal-status disagreement (T-575, failure): the
  // mirror image of cross_section_terminal_status_disagreement above — a
  // TASK_STATUS record terminal in ANY section whose BACKLOG record in ANY
  // section is still non-terminal (e.g. TASK_STATUS `merged` vs BACKLOG
  // `deferred`). The forward check is gated on the BACKLOG side being
  // terminal, so this shape previously raised zero findings.
  {
    name: 'reverse_terminal_status_disagreement',
    run: (ctx) =>
      checkReverseTerminalStatusDisagreement(ctx.backlogAllTasksAnySection, ctx.taskStatusAllTasksAnySection),
  },
  // missing BACKLOG record anywhere (T-575, warning): reverse-direction
  // sibling of missing_task_status_record_anywhere — fires when a
  // terminal-status TASK_STATUS record in ANY section has NO matching BACKLOG
  // record in ANY section, i.e. a task claiming to have shipped that the plan
  // of record never registered. `missing_in_backlog` cannot see this: it
  // deliberately exempts terminal-status TASK_STATUS records.
  {
    name: 'missing_backlog_record_anywhere',
    run: (ctx) => checkMissingBacklogRecordAnywhere(ctx.backlogAllTasksAnySection, ctx.taskStatusAllTasksAnySection),
  },
];

function parseArtifacts({ backlogPath, taskStatusPath }) {
  const backlogMarkdown = readUtf8(backlogPath);
  const taskStatusMarkdown = readUtf8(taskStatusPath);

  const backlogRecords = parseBacklogActiveTasks(backlogMarkdown);
  // All wave records include merged tasks — needed for cross-repo + exploration checks
  const backlogAllWaveRecords = parseBacklogAllActiveWaveTasks(backlogMarkdown);
  const taskStatusRecords = parseTaskStatusActiveTasks(taskStatusMarkdown);
  const taskStatusRecentlyCompletedRecords = parseTaskStatusRecentlyCompletedTasks(taskStatusMarkdown);
  const comparison = compareRecords({ backlogRecords, taskStatusRecords });

  // Whole-file, section-agnostic record sets (T-543) — see
  // parseAllTaskBlocksBySection() docblock for why these are needed
  // alongside the section-scoped sets above.
  const backlogAllTasksAnySection = parseBacklogAllTasksAnySection(backlogMarkdown);
  const taskStatusAllTasksAnySection = parseTaskStatusAllTasksAnySection(taskStatusMarkdown);

  const processStatePath = path.join(path.dirname(backlogPath), 'PROCESS_STATE.json');

  const ctx = {
    backlogPath,
    taskStatusPath,
    processStatePath,
    backlogMarkdown,
    taskStatusMarkdown,
    backlogRecords,
    backlogAllWaveRecords,
    taskStatusRecords,
    taskStatusRecentlyCompletedRecords,
    backlogAllTasksAnySection,
    taskStatusAllTasksAnySection,
    root: path.dirname(backlogPath),
  };

  for (const check of CHECKS) {
    mergeFindings(comparison, check.run(ctx));
  }

  // T-496 (DR-005): apply the scoped Hold: downgrade, then recompute the
  // aggregate counts/state from scratch — must run after every check has
  // contributed its findings, since the whitelist can only ever touch
  // blocked_by_open (see HOLD_DOWNGRADABLE_CHECKS docblock).
  applyHoldDowngrade(comparison.findings, backlogAllWaveRecords);
  recomputeComparisonAggregates(comparison);

  return {
    inputs: {
      backlogPath,
      taskStatusPath,
    },
    records: {
      backlog: backlogRecords,
      taskStatus: taskStatusRecords,
      all: [...backlogRecords, ...taskStatusRecords],
    },
    counts: {
      backlog: backlogRecords.length,
      taskStatus: taskStatusRecords.length,
      all: backlogRecords.length + taskStatusRecords.length,
    },
    comparison,
  };
}

function getOverallResultLabel(overallCandidateState) {
  const labels = {
    healthy: 'Healthy',
    usable_but_drifting: 'Usable but drifting',
    misleading_repair_required: 'Misleading / repair required',
  };

  return labels[overallCandidateState] || overallCandidateState;
}

function getOperatorTakeaway(overallCandidateState) {
  const takeaways = {
    healthy: 'Continue safely.',
    usable_but_drifting: 'Some warnings found — review but not blocking. Clean up before they accumulate into drift.',
    misleading_repair_required: 'REPAIR REQUIRED — critical artifact mismatch. Resolve failures before continuing.',
  };

  return takeaways[overallCandidateState] || 'Inspect findings and repair the active artifact set.';
}

function groupFindingsBySeverity(findings) {
  return findings.reduce(
    (groups, finding) => {
      groups[finding.severity] = groups[finding.severity] || [];
      groups[finding.severity].push(finding);
      return groups;
    },
    { failure: [], warning: [], info: [] }
  );
}

function renderFindingLines(finding) {
  return [
    `- [${finding.taskId}] ${finding.checkName}`,
    `  - Issue: ${finding.message}`,
    `  - Repair target: ${finding.repairTarget}`,
    `  - Next action: ${finding.suggestedAction}`,
  ];
}

function renderValidatorReport(parsed) {
  const { comparison, counts } = parsed;
  const grouped = groupFindingsBySeverity(comparison.findings);
  const lines = [
    '# MavP Validator Report',
    '',
    `- Overall result: ${getOverallResultLabel(comparison.overallCandidateState)}`,
    `- Failures: ${comparison.counts.bySeverity.failure || 0}`,
    `- Warnings: ${comparison.counts.bySeverity.warning || 0}`,
    `- Backlog active records: ${counts.backlog}`,
    `- Task status active records: ${counts.taskStatus}`,
  ];

  if (grouped.failure.length > 0) {
    lines.push('', '## Failures');
    for (const finding of grouped.failure) {
      lines.push(...renderFindingLines(finding));
    }
  }

  if (grouped.warning.length > 0) {
    lines.push('', '## Warnings');
    for (const finding of grouped.warning) {
      lines.push(...renderFindingLines(finding));
    }
  }

  if (grouped.info.length > 0) {
    lines.push('', '## Findings');
    for (const finding of grouped.info) {
      lines.push(`- [${finding.taskId}] ${finding.checkName}: ${finding.message}`);
    }
  }

  const nonInfoFindings = comparison.findings.filter((f) => f.severity !== 'info');
  if (nonInfoFindings.length === 0) {
    if (grouped.info.length === 0) {
      lines.push('', '## Findings', '- No mismatches detected.');
    }
    const mergedAwaiting = counts.taskStatus - counts.backlog;
    if (mergedAwaiting > 0) {
      lines.push(`- ${mergedAwaiting} task(s) merged and awaiting archive — count discrepancy expected (archive on wave close).`);
    }
  }

  lines.push('', '## Operator takeaway', getOperatorTakeaway(comparison.overallCandidateState));
  return `${lines.join('\n')}\n`;
}

function getExitCode(overallCandidateState) {
  if (overallCandidateState === 'misleading_repair_required') {
    return 2;
  }

  if (overallCandidateState === 'usable_but_drifting') {
    return 1;
  }

  return 0;
}

function main() {
  // Resolution order (deliberately mirrors getProjectRoot()'s precedence,
  // extended with the explicit-argument tier): explicit path argument
  // (argv[2]) wins when present, else MAVERICKS_PROJECT_ROOT, else
  // process.cwd(). getProjectRoot() itself is NOT changed — see the comment
  // on that function; it is require()-consumed by mavp-operator-agent.js,
  // so reading process.argv there would resolve against the *requiring*
  // process's argv, not this script's.
  const repoRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : (process.env.MAVERICKS_PROJECT_ROOT || process.cwd());
  const backlogPath = path.join(repoRoot, 'BACKLOG.md');
  const taskStatusPath = path.join(repoRoot, 'TASK_STATUS.md');
  const parsed = parseArtifacts({ backlogPath, taskStatusPath });
  const asJson = process.argv.includes('--json');

  if (asJson) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  } else {
    process.stdout.write(renderValidatorReport(parsed));
  }

  process.exitCode = getExitCode(parsed.comparison.overallCandidateState);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Validator failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ACTIVE_BACKLOG_STATUSES,
  ACTIVE_SLICES_STATUSES,
  TERMINAL_TASK_STATUSES,
  STATUSES_REQUIRING_REPO,
  compareField,
  compareRecords,
  checkDuplicateTaskIds,
  checkDuplicateTaskStatusEntries,
  checkLastTaskId,
  checkActiveSlices,
  checkModuleIds,
  checkRepoIds,
  checkExplorationOutputDoc,
  checkCrossRepoEvidence,
  checkConfigCheck,
  checkDevDoneBranch,
  checkDocsRefs,
  checkArchitectureDocStale,
  parseKnownModuleIds,
  parseKnownRepoIds,
  resolveModulesPath,
  resolveRepoMapPath,
  mergeFindings,
  DEV_DONE_WITHOUT_QA_CHECK: 'dev_done_without_qa',
  DUPLICATE_TASK_STATUS_ENTRY_CHECK: 'duplicate_task_status_entry',
  MERGED_MISSING_COMMIT_FIELD_CHECK: 'merged_missing_commit_field',
  MERGED_MISSING_COMMIT_FORMAT_CHECK: 'merged_missing_commit_format',
  STALE_RISK_UNVERIFIED_CHECK: 'stale_risk_unverified',
  UNKNOWN_MODULE_ID_CHECK: 'unknown_module_id',
  UNKNOWN_REPO_ID_CHECK: 'unknown_repo_id',
  MISSING_REPO_FIELD_CHECK: 'missing_repo_field',
  EXPLORATION_MISSING_OUTPUT_DOC_CHECK: 'exploration_missing_output_doc',
  CROSS_REPO_MISSING_EVIDENCE_CHECK: 'cross_repo_missing_evidence',
  CONFIG_CHECK_MISSING_CHECK: 'config_check_missing',
  DEV_DONE_MISSING_BRANCH_CHECK: 'dev_done_missing_branch',
  DOCS_REF_NOT_FOUND_CHECK: 'docs_ref_not_found',
  LAST_TASK_ID_AUTO_PATCHED_CHECK: 'last_task_id_auto_patched',
  ARCHITECTURE_DOC_STALE_CHECK: 'architecture_doc_stale',
  MERGED_MISSING_NEEDS_FIX_ROUNDS_CHECK: 'merged_missing_needs_fix_rounds',
  CONFLICTING_NEEDS_FIX_ROUNDS_CHECK: 'conflicting_needs_fix_rounds',
  CONFLICTING_VALIDATOR_BLOCKED_CHECK: 'conflicting_validator_blocked',
  OVERDUE_RECHECK_CHECK: 'overdue_recheck',
  NEXT_ACTION_VOLATILE_FACTS_CHECK: 'next_action_volatile_facts',
  ARTIFACT_SIZE_BUDGET_CHECK: 'artifact_size_budget',
  STATE_IN_CLAUDE_MD_CHECK: 'state_in_claude_md',
  BLOCKED_BY_OPEN_CHECK: 'blocked_by_open',
  BLOCKED_BY_UNRESOLVABLE_CHECK: 'blocked_by_unresolvable',
  COMMIT_UNREACHABLE_CHECK: 'commit_unreachable',
  DEFAULT_ARTIFACT_BUDGETS,
  BACKLOG_ACTIVE_WAVE_PER_TASK_LINES,
  TASK_STATUS_ACTIVE_TASKS_PER_TASK_LINES,
  checkMergedNeedsFixRounds,
  checkConflictingNeedsFixRounds,
  checkConflictingValidatorBlocked,
  checkOverdueRechecks,
  checkNextActionVolatileFacts,
  checkArtifactSizeBudget,
  checkStateInClaudeMd,
  checkBlockedBy,
  HOLD_DOWNGRADABLE_CHECKS,
  applyHoldDowngrade,
  recomputeComparisonAggregates,
  checkCommitReachable,
  extractCommitHashesFromEvidence,
  extractCommitEntriesFromEvidence,
  ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD,
  buildReachableHashIndex,
  isHashReachable,
  resolveSelfRepoId,
  findTaskStatusInFile,
  getBlockedByRepoMapRoot,
  resolveArtifactBudgets,
  createFinding,
  createTaskRecordIndex,
  getAcceptedEvidenceGuidance,
  getExitCode,
  getField,
  getFieldMultiline,
  getOperatorTakeaway,
  getOverallResultLabel,
  getSectionContent,
  getSeverityForCheck,
  getTaskBlocks,
  groupFindingsBySeverity,
  parseTaskBlock,
  parseBacklogActiveTasks,
  parseBacklogAllActiveWaveTasks,
  parseTaskStatusActiveTasks,
  parseTaskStatusRecentlyCompletedTasks,
  parseArtifacts,
  renderFindingLines,
  renderValidatorReport,
  CROSS_SECTION_TERMINAL_STATUS_DISAGREEMENT_CHECK: 'cross_section_terminal_status_disagreement',
  NON_TERMINAL_STATUS_IN_COMPLETED_SECTION_CHECK: 'non_terminal_status_in_completed_section',
  MISSING_TASK_STATUS_RECORD_ANYWHERE_CHECK: 'missing_task_status_record_anywhere',
  parseAllTaskBlocksBySection,
  parseBacklogAllTasksAnySection,
  parseTaskStatusAllTasksAnySection,
  isSkippedByExistingRules,
  checkCrossSectionTerminalStatusDisagreement,
  checkNonTerminalStatusInCompletedSection,
  checkMissingTaskStatusRecordAnywhere,
  checkReverseTerminalStatusDisagreement,
  checkMissingBacklogRecordAnywhere,
};
