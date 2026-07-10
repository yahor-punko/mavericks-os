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
const { computeDueRechecks } = require('./mavp-operator-lib');

// Statuses that require a Repo: field (warning if absent)
const STATUSES_REQUIRING_REPO = new Set([
  'in_progress',
  'dev_done',
  'ux_review',
  'ux_needs_fix',
  'ux_passed',
  'security_review',
  'security_passed',
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
  'ready_for_qa',
  'qa_in_progress',
  'qa_passed',
  'needs_fix',
]);

// Terminal statuses that are not considered active for backlog comparison.
// Tasks with these statuses are excluded from active-task cross-checking
// and do not require presence in ACTIVE_BACKLOG_STATUSES.
const TERMINAL_TASK_STATUSES = new Set(['merged', 'deployed_dev', 'deployed_prod']);

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

function getField(block, fieldLabel) {
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'));
  return normalizeWhitespace(match ? match[1] : null);
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
    repo: getField(block, 'Repo') || getField(block, 'Repos'),
    taskType: getField(block, 'Type'),
    outputDoc: getField(block, 'Output doc'),
    supersededBy: getField(block, 'Superseded by'),
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
    last_task_id_auto_patched: 'info',
    merged_without_commit_hash: 'warning',
    merged_missing_commit_field: 'failure',
    merged_missing_commit_format: 'warning',
    stale_risk_unverified: 'warning',
    unknown_module_id: 'warning',
    missing_repo_field: 'warning',
    exploration_missing_output_doc: 'warning',
    cross_repo_missing_evidence: 'warning',
    docs_ref_not_found: 'warning',
    active_slices_mismatch: 'warning',
    config_check_missing: 'warning',
    dev_done_missing_branch: 'warning',
    architecture_doc_stale: 'warning',
    merged_missing_needs_fix_rounds: 'info',
    overdue_recheck: 'info',
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

function createFinding({ checkName, taskId, message, repairTarget, suggestedAction, details }) {
  return {
    severity: getSeverityForCheck(checkName),
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
      const evidence = getField(record.rawBlock, 'Evidence');
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
          const evidence = getField(tsRecord.rawBlock, 'Evidence');
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
 * Resolve the path to docs/MODULES.md for the current context.
 * Resolution order:
 *   1. MAVERICKS_PROJECT_ROOT env var (set by bash wrapper in project-mode)
 *   2. process.cwd() (self-mode: running directly against mavericks repo)
 * Returns null if neither location has the file.
 */
function resolveModulesPath() {
  const projectRoot = process.env.MAVERICKS_PROJECT_ROOT;
  if (projectRoot) {
    const p = path.join(projectRoot, 'docs', 'MODULES.md');
    if (fs.existsSync(p)) return p;
    // env var set but no MODULES.md in project — graceful skip
    return null;
  }
  const cwdPath = path.join(process.cwd(), 'docs', 'MODULES.md');
  if (fs.existsSync(cwdPath)) return cwdPath;
  return null;
}

/**
 * Parse known module IDs from docs/MODULES.md.
 * Reads from MAVERICKS_PROJECT_ROOT/docs/MODULES.md when in project context,
 * falling back to <cwd>/docs/MODULES.md.
 * Returns a Set of module IDs (e.g. 'module-a', 'module-b', ...).
 * Returns empty set if the file doesn't exist — module validation is skipped gracefully.
 */
function parseKnownModuleIds(modulesPath) {
  try {
    const resolvedPath = modulesPath || resolveModulesPath();
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return new Set();
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const ids = new Set();
    // Match ## <id> headings — these are the module IDs
    const matches = content.match(/^##\s+(\S+)/gm) || [];
    for (const match of matches) {
      const m = match.match(/^##\s+(\S+)/);
      if (m) ids.add(m[1].trim());
    }
    // Remove meta-sections that are not module IDs
    ids.delete('How');
    ids.delete('Module');
    ids.delete('What');
    ids.delete('Required');
    ids.delete('Example');
    return ids;
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
 * Check 1: exploration tasks must have output_doc: field declared.
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
 * Check 2: cross-repo evidence check.
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

    const evidence = getField(tsRecord.rawBlock, 'Evidence');
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
 * Check 3: config_check evidence check.
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

    const evidence = getField(tsRecord.rawBlock, 'Evidence');
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
 * Check 4: dev_done branch field check.
 * When a task is dev_done AND its evidence block in TASK_STATUS.md contains
 * a commit: line but has no branch: line, emit a warning.
 * Projects with branch-based deploy contours should populate branch: in dev_done evidence.
 */
function checkDevDoneBranch(taskStatusRecords) {
  const findings = [];

  for (const record of taskStatusRecords) {
    if (record.status !== 'dev_done') continue;

    const evidence = getField(record.rawBlock, 'Evidence');
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
 * Check 5: docs ref validator.
 * For merged tasks, scan Notes and Evidence fields in TASK_STATUS.md for
 * patterns matching docs/[A-Z_]+.md. Warn if the file does not exist.
 * AC and Proposed solution fields are NOT scanned.
 */
function checkDocsRefs(taskStatusRecords) {
  const projectRoot = process.env.MAVERICKS_PROJECT_ROOT || process.cwd();
  const findings = [];
  const DOCS_REF_PATTERN = /docs\/[A-Z_]+\.md/g;

  for (const record of taskStatusRecords) {
    if (!TERMINAL_TASK_STATUSES.has(record.status)) continue;

    const fieldsToScan = ['Evidence', 'Notes'];
    for (const fieldLabel of fieldsToScan) {
      const fieldValue = getField(record.rawBlock, fieldLabel);
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
 * Check 6: architecture_doc_stale.
 * When at least one merged task in the Active Wave declares
 * `- **Update architecture:** true`, AND docs/ARCHITECTURE.md exists,
 * AND its `> Last updated: YYYY-MM-DD` date is earlier than
 * PROCESS_STATE.json `last_updated`, emit a warning.
 * Silently skipped when docs/ARCHITECTURE.md is absent.
 */
function checkArchitectureDocStale(backlogAllWaveRecords, processStatePath) {
  // Resolve the path to docs/ARCHITECTURE.md (project-aware)
  const projectRoot = process.env.MAVERICKS_PROJECT_ROOT || process.cwd();
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
 * Check 7: merged runtime/manual tasks missing needs_fix_rounds in evidence.
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

    const evidence = getField(record.rawBlock, 'Evidence');
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
 * Check 8: overdue recheck advisory.
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

function parseArtifacts({ backlogPath, taskStatusPath }) {
  const backlogMarkdown = readUtf8(backlogPath);
  const taskStatusMarkdown = readUtf8(taskStatusPath);

  const backlogRecords = parseBacklogActiveTasks(backlogMarkdown);
  // All wave records include merged tasks — needed for cross-repo + exploration checks
  const backlogAllWaveRecords = parseBacklogAllActiveWaveTasks(backlogMarkdown);
  const taskStatusRecords = parseTaskStatusActiveTasks(taskStatusMarkdown);
  const comparison = compareRecords({ backlogRecords, taskStatusRecords });
  const duplicateFindings = checkDuplicateTaskIds(backlogMarkdown);

  // Merge duplicate findings into comparison
  if (duplicateFindings.length > 0) {
    comparison.findings.push(...duplicateFindings);
    comparison.counts.findings += duplicateFindings.length;
    const failureCount = duplicateFindings.filter(f => f.severity === 'failure').length;
    comparison.counts.bySeverity.failure = (comparison.counts.bySeverity.failure || 0) + failureCount;
    if (failureCount > 0 && comparison.overallCandidateState !== 'misleading_repair_required') {
      comparison.overallCandidateState = 'misleading_repair_required';
    }
  }

  const processStatePath = path.join(path.dirname(backlogPath), 'PROCESS_STATE.json');
  // Use all wave records (including merged) so drift is detected even when no active tasks remain
  mergeFindings(comparison, checkLastTaskId(backlogAllWaveRecords, processStatePath));

  // active_slices sync: every ID in PROCESS_STATE.json active_slices must match an active task in BACKLOG
  mergeFindings(comparison, checkActiveSlices(backlogRecords, processStatePath));

  // Module check: resolve project-level MODULES.md (respects MAVERICKS_PROJECT_ROOT)
  mergeFindings(comparison, checkModuleIds(backlogRecords, null));

  // Exploration task must declare output_doc (check all wave tasks, including planned)
  mergeFindings(comparison, checkExplorationOutputDoc(backlogAllWaveRecords));

  // Cross-repo evidence: merged tasks with Repos: [a, b] need per-repo commit evidence
  mergeFindings(comparison, checkCrossRepoEvidence(backlogAllWaveRecords, taskStatusRecords));

  // Config check: qa_passed/merged tasks with requires_config_check: true need config_check: in evidence
  mergeFindings(comparison, checkConfigCheck(backlogAllWaveRecords, taskStatusRecords));

  // Docs ref validator: warn on docs/[A-Z_]+.md refs in Evidence/Notes of merged tasks
  mergeFindings(comparison, checkDocsRefs(taskStatusRecords));

  // dev_done branch check: warn when dev_done evidence has commit: but no branch:
  mergeFindings(comparison, checkDevDoneBranch(taskStatusRecords));

  // Architecture doc stale check: warn when a merged task declares Update architecture: true
  // but docs/ARCHITECTURE.md Last updated: is older than PROCESS_STATE.json last_updated
  mergeFindings(comparison, checkArchitectureDocStale(backlogAllWaveRecords, processStatePath));

  // needs_fix_rounds advisory: info-level nudge for merged runtime/manual tasks missing the field
  mergeFindings(comparison, checkMergedNeedsFixRounds(taskStatusRecords));

  // overdue recheck advisory: info-level nudge for rechecks past their due date
  mergeFindings(comparison, checkOverdueRechecks(processStatePath));

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
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
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
  checkLastTaskId,
  checkActiveSlices,
  checkModuleIds,
  checkExplorationOutputDoc,
  checkCrossRepoEvidence,
  checkConfigCheck,
  checkDevDoneBranch,
  checkDocsRefs,
  checkArchitectureDocStale,
  parseKnownModuleIds,
  resolveModulesPath,
  mergeFindings,
  DEV_DONE_WITHOUT_QA_CHECK: 'dev_done_without_qa',
  MERGED_WITHOUT_COMMIT_HASH_CHECK: 'merged_without_commit_hash',
  MERGED_MISSING_COMMIT_FIELD_CHECK: 'merged_missing_commit_field',
  MERGED_MISSING_COMMIT_FORMAT_CHECK: 'merged_missing_commit_format',
  STALE_RISK_UNVERIFIED_CHECK: 'stale_risk_unverified',
  UNKNOWN_MODULE_ID_CHECK: 'unknown_module_id',
  MISSING_REPO_FIELD_CHECK: 'missing_repo_field',
  EXPLORATION_MISSING_OUTPUT_DOC_CHECK: 'exploration_missing_output_doc',
  CROSS_REPO_MISSING_EVIDENCE_CHECK: 'cross_repo_missing_evidence',
  CONFIG_CHECK_MISSING_CHECK: 'config_check_missing',
  DEV_DONE_MISSING_BRANCH_CHECK: 'dev_done_missing_branch',
  DOCS_REF_NOT_FOUND_CHECK: 'docs_ref_not_found',
  LAST_TASK_ID_AUTO_PATCHED_CHECK: 'last_task_id_auto_patched',
  ARCHITECTURE_DOC_STALE_CHECK: 'architecture_doc_stale',
  MERGED_MISSING_NEEDS_FIX_ROUNDS_CHECK: 'merged_missing_needs_fix_rounds',
  OVERDUE_RECHECK_CHECK: 'overdue_recheck',
  checkMergedNeedsFixRounds,
  checkOverdueRechecks,
  createFinding,
  createTaskRecordIndex,
  getAcceptedEvidenceGuidance,
  getExitCode,
  getField,
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
  parseArtifacts,
  renderFindingLines,
  renderValidatorReport,
};
