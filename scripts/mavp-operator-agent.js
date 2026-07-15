#!/usr/bin/env node

/**
 * mavp-operator-agent.js
 *
 * Compact JSON summary for the Main Agent to read at session start.
 * Outputs a single JSON object with current stage, active slice, status, and blockers.
 * Computes next_action dynamically from active tasks + dependency graph.
 * Runs the MavP validator silently and appends WARNING if artifacts are drifting.
 *
 * Usage: ./scripts/mavp-operator --agent
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

/**
 * Resolve the mavericks installation's scripts/ directory, so project-copied
 * scripts (this file) can require the shared lib without a local copy.
 * Resolution order:
 *   (a) MAVERICKS_SCRIPTS env var, if set and it contains mavp-operator-lib.js
 *       (normal bootstrapped-project path — the bash wrapper exports this)
 *   (b) __dirname, if it contains mavp-operator-lib.js
 *       (the mavericks repo itself, and legacy projects with a local lib copy)
 *   (c) ~/Documents/mavericks/scripts (matches the existing VALIDATOR fallback)
 */
function resolveMavericksScriptsDir() {
  const candidates = [];
  if (process.env.MAVERICKS_SCRIPTS) candidates.push(process.env.MAVERICKS_SCRIPTS);
  candidates.push(__dirname);
  candidates.push(path.join(os.homedir(), 'Documents', 'mavericks', 'scripts'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'mavp-operator-lib.js'))) return dir;
  }
  throw new Error(
    `Cannot locate mavp-operator-lib.js (checked: ${candidates.join(', ')}). ` +
      `Set MAVERICKS_HOME to your mavericks installation's root directory.`
  );
}

const MAVERICKS_SCRIPTS_DIR = resolveMavericksScriptsDir();
const { buildDeployQueue, classifyNextAction, computeDueRechecks, computeMustRead, generateProcessStateMd, getDeployPendingForRepo, parseBlockedBy, parseTasksWithRepo, readPermissionMode, resolveContextBundlePath } = require(path.join(MAVERICKS_SCRIPTS_DIR, 'mavp-operator-lib'));

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const PROCESS_STATE_MD = path.join(ROOT, 'PROCESS_STATE.md');
const TASK_STATUS_MD = path.join(ROOT, 'TASK_STATUS.md');
const BACKLOG_MD = path.join(ROOT, 'BACKLOG.md');
const VALIDATOR = path.join(MAVERICKS_SCRIPTS_DIR, 'mavp-validator.js');
const { resolveModulesPath } = require(VALIDATOR);
const MAVERICKS_VERSION_FILE = path.join(MAVERICKS_SCRIPTS_DIR, 'mavp-version.js');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeWhitespace(value) {
  return value ? value.replace(/\s+/g, ' ').trim() : '';
}

function readProcessStateJson() {
  try {
    if (!fs.existsSync(PROCESS_STATE_JSON)) return null;
    return JSON.parse(readUtf8(PROCESS_STATE_JSON));
  } catch {
    return null;
  }
}

function parseProcessStateMd(markdown) {
  const lines = markdown.split(/\r?\n/);

  function getSection(heading) {
    const start = lines.findIndex((l) => l.trim() === heading.trim());
    if (start === -1) return '';
    let end = lines.length;
    const level = (heading.match(/^#+/) || [''])[0].length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^(#+)\s+/);
      if (m && m[1].length <= level) { end = i; break; }
    }
    return lines.slice(start + 1, end).join('\n').trim();
  }

  function listItems(section) {
    return section.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*]/.test(l)).map((l) => normalizeWhitespace(l.replace(/^[-*]\s+/, '')));
  }

  return {
    initiative: normalizeWhitespace(getSection('## Current initiative')),
    stage: normalizeWhitespace(getSection('## Current loop stage')),
    blockers: listItems(getSection('## Current blockers')),
    nextHandoff: listItems(getSection('## Next expected handoff')),
    lastUpdate: normalizeWhitespace(getSection('## Last update')),
  };
}

function parseActiveTaskStatus(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active tasks/.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    const ownerMatch = block.match(/^- \*\*Owner[^:]*:\*\*\s+(.+)$/m);
    const moduleMatch = block.match(/^- \*\*Module:\*\*\s+(.+)$/m);
    const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
    return {
      id: headingMatch ? headingMatch[1] : 'unknown',
      title: headingMatch ? normalizeWhitespace(headingMatch[2]) : 'unknown',
      status: statusMatch ? normalizeWhitespace(statusMatch[1]) : 'unknown',
      owner: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : 'unknown',
      module: moduleMatch ? normalizeWhitespace(moduleMatch[1]) : null,
      repo: repoMatch ? normalizeWhitespace(repoMatch[1]) : null,
    };
  });
}

/**
 * Parse all task statuses from BACKLOG.md (entire file, not just Active Wave).
 * Returns a map of taskId → status string.
 * Used to detect stale next_action references.
 */
function parseBacklogTaskStatuses(backlogMarkdown) {
  const statusMap = {};
  const blocks = backlogMarkdown.split(/\n(?=###\s+T-)/).filter(Boolean);
  for (const block of blocks) {
    const idMatch = block.match(/^###\s+(T-\d+)/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    if (idMatch && statusMatch) {
      statusMap[idMatch[1]] = normalizeWhitespace(statusMatch[1]);
    }
  }
  return statusMap;
}

/**
 * Parse planned tasks from the ## Active Wave section of BACKLOG.md.
 * Returns tasks with status 'planned' — used to populate planned_tasks in agent output.
 * Scoped to Active Wave only so the session-start skill never shows stale/archived tasks.
 */
function parsePlannedTasksFromActiveWave(backlogMarkdown) {
  const lines = backlogMarkdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^##\s+Active Wave\s*$/.test(l.trim()));
  if (startIdx === -1) return [];
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  const section = lines.slice(startIdx + 1, endIdx).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).filter(Boolean);
  const result = [];
  for (const block of blocks) {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    if (!headingMatch || !statusMatch) continue;
    const status = normalizeWhitespace(statusMatch[1]);
    if (status !== 'planned') continue;
    const ownerMatch = block.match(/^- \*\*Owner[^:]*:\*\*\s+(.+)$/m);
    result.push({
      id: headingMatch[1],
      title: normalizeWhitespace(headingMatch[2]),
      status,
      owner: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : 'unknown',
    });
  }
  return result;
}

/**
 * Parse module, repo, prod_prerequisites, and blocked_by metadata from
 * BACKLOG.md for active task IDs.
 * Returns a map of taskId → { module, repo, prodPrerequisites, blockedByRaw }
 * from the backlog blocks.
 */
function parseBacklogTaskMeta(backlogMarkdown) {
  const blocks = backlogMarkdown.split(/\n(?=###\s+T-)/).filter(Boolean);
  const meta = {};
  for (const block of blocks) {
    const idMatch = block.match(/^###\s+(T-\d+)/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    const moduleMatch = block.match(/^- \*\*Module:\*\*\s+(.+)$/m);
    const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
    const prodPrereqMatch = block.match(/^- \*\*Prod prerequisites:\*\*\s+(.+)$/m);
    const blockedByMatch = block.match(/^- \*\*Blocked by:\*\*\s+(.+)$/m);
    const prodPrerequisites = prodPrereqMatch
      ? prodPrereqMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : [];
    meta[id] = {
      module: moduleMatch ? normalizeWhitespace(moduleMatch[1]) : null,
      repo: repoMatch ? normalizeWhitespace(repoMatch[1]) : null,
      prodPrerequisites,
      blockedByRaw: blockedByMatch ? normalizeWhitespace(blockedByMatch[1]) : null,
    };
  }
  return meta;
}

/**
 * Parse module registry from docs/MODULES.md.
 * Reads from MAVERICKS_PROJECT_ROOT/docs/MODULES.md when in project context,
 * falling back to <framework-root>/docs/MODULES.md (self-mode).
 * Returns empty map if file not found — module enrichment is skipped gracefully.
 */
function parseModuleRegistry() {
  try {
    const modulesPath = resolveModulesPath();
    if (!modulesPath) return {};
    const content = fs.readFileSync(modulesPath, 'utf8');
    const registry = {};
    // Split on ## <id> headings (skip ## How to use and similar meta sections)
    const sections = content.split(/^(?=##\s+\S)/m).filter(Boolean);
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(\S+)/);
      if (!headingMatch) continue;
      const id = headingMatch[1].trim();
      // Skip non-module sections (meta headings used in the schema spec and template)
      const META_HEADINGS = new Set(['How', 'Module', 'What', 'Required', 'Example']);
      if (META_HEADINGS.has(id)) continue;

      const labelMatch = section.match(/^- \*\*label:\*\*\s+(.+)$/m);
      const reposMatch = section.match(/^- \*\*repos:\*\*\s+(.+)$/m);
      const contextDocsMatch = section.match(/^- \*\*context_docs:\*\*\s+(.+)$/m);
      const ownerMatch = section.match(/^- \*\*default_owner:\*\*\s+(.+)$/m);

      const contextDocs = contextDocsMatch
        ? contextDocsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];

      const repos = reposMatch
        ? reposMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];

      // Collect qa_checklist items
      const qaLines = [];
      let inQa = false;
      for (const line of section.split(/\r?\n/)) {
        if (/^- \*\*qa_checklist:\*\*/.test(line)) { inQa = true; continue; }
        if (inQa) {
          if (/^-\s+/.test(line)) {
            qaLines.push(line.replace(/^-\s+/, '').trim());
          } else if (/^##/.test(line) || (/^- \*\*/.test(line) && !line.startsWith('  '))) {
            inQa = false;
          }
        }
      }

      registry[id] = {
        label: labelMatch ? labelMatch[1].trim() : id,
        repos,
        context_docs: contextDocs,
        default_owner: ownerMatch ? ownerMatch[1].trim() : 'developer',
        qa_checklist: qaLines,
      };
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * Compute next_action dynamically from active tasks + dependency graph in BACKLOG.
 *
 * Priority order (high to low):
 *   1. ready_for_qa, qa_in_progress — needs QA immediately
 *   2. dev_done, security_review, security_passed, ux_review, ux_passed — awaiting next review stage
 *   3. in_progress, needs_fix — active development
 *   4. planned — not started
 *
 * In-flight tasks (priority 1–3) always take precedence over planned tasks,
 * regardless of which repo they belong to.
 *
 * @param {Array} activeTasks - In-flight tasks from TASK_STATUS.md active section
 * @param {Array} plannedTasks - Planned tasks from BACKLOG.md Active Wave section
 * @param {string|null} staticFallback - Fallback string from PROCESS_STATE.json
 * @returns {string|null}
 */
function computeNextAction(activeTasks, plannedTasks, staticFallback) {
  // Status priority: lower number = higher priority
  const STATUS_PRIORITY = {
    ready_for_qa: 1,
    qa_in_progress: 1,
    dev_done: 2,
    security_review: 2,
    security_passed: 2,
    ux_review: 2,
    ux_passed: 2,
    in_progress: 3,
    needs_fix: 3,
    planned: 4,
  };

  const mergedIds = new Set(
    activeTasks.filter(t => t.status === 'merged').map(t => t.id)
  );

  let backlogDeps = {};
  try {
    const backlog = readUtf8(BACKLOG_MD);
    const blocks = backlog.split(/\n(?=###\s+T-)/).filter(Boolean);
    for (const block of blocks) {
      const idMatch = block.match(/^###\s+(T-\d+)/m);
      const depMatch = block.match(/^- \*\*Depends on:\*\*\s+(.+)$/m);
      if (idMatch && depMatch) {
        const raw = depMatch[1].trim();
        const deps = raw === '—' ? [] : raw.split(/[,\s]+/).filter(d => /^T-\d+$/.test(d));
        backlogDeps[idMatch[1]] = deps;
      }
    }
  } catch { /* backlog optional */ }

  // Build a combined candidate list: in-flight tasks from TASK_STATUS + planned from BACKLOG.
  // In-flight tasks don't need dependency checks (they are already started or awaiting action).
  const IN_FLIGHT_STATUSES = new Set([
    'ready_for_qa', 'qa_in_progress',
    'dev_done', 'security_review', 'security_passed', 'ux_review', 'ux_passed',
    'in_progress', 'needs_fix',
  ]);
  const PLANNED_STATUSES = new Set(['planned']);

  // Collect in-flight candidates (no dependency gate — they are already in motion)
  const inFlightCandidates = activeTasks
    .filter(t => IN_FLIGHT_STATUSES.has(t.status))
    .map(t => ({ task: t, priority: STATUS_PRIORITY[t.status] ?? 99 }));

  // Collect planned candidates with dependency gate
  const plannedCandidates = (plannedTasks || [])
    .filter(t => PLANNED_STATUSES.has(t.status))
    .filter(t => {
      const deps = backlogDeps[t.id] || [];
      return deps.every(dep => mergedIds.has(dep));
    })
    .map(t => ({ task: t, priority: STATUS_PRIORITY[t.status] ?? 99 }));

  // Also check activeTasks for any planned entries (legacy path — some projects may store
  // planned tasks in TASK_STATUS active section)
  const plannedFromActive = activeTasks
    .filter(t => PLANNED_STATUSES.has(t.status))
    .filter(t => {
      const deps = backlogDeps[t.id] || [];
      return deps.every(dep => mergedIds.has(dep));
    })
    .map(t => ({ task: t, priority: STATUS_PRIORITY[t.status] ?? 99 }));

  // Merge and deduplicate by task id, then sort by priority (ascending = higher priority first)
  const seen = new Set();
  const allCandidates = [...inFlightCandidates, ...plannedCandidates, ...plannedFromActive]
    .filter(c => {
      if (seen.has(c.task.id)) return false;
      seen.add(c.task.id);
      return true;
    })
    .sort((a, b) => a.priority - b.priority);

  if (allCandidates.length > 0) {
    const { task } = allCandidates[0];
    return `${task.id} → ${task.owner} → ${task.title}`;
  }

  return staticFallback || null;
}

const PARLIAMENTARY_STAGES = new Set([
  'signal_intake', 'research', 'head_interpretation', 'packet_ready',
  'main_agent_decision', 'slice_conversion', 'qa_review',
  'merged_complete', 'deferred', 'rejected', 'abandoned',
]);

function detectGovernance(stage) {
  if (PARLIAMENTARY_STAGES.has(stage)) return true;
  const govDir = path.join(ROOT, 'docs', 'governance');
  try {
    if (!fs.existsSync(govDir)) return false;
    const files = fs.readdirSync(govDir);
    return files.some(f => f.startsWith('PARLIAMENTARY_DECISION_PACKET') && !f.endsWith('TEMPLATE.md'));
  } catch { return false; }
}

/**
 * Compare two semver strings (e.g. "0.4.0" vs "0.3.6").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Compare stored mavericks_version in PROCESS_STATE.json against current framework version.
 * Returns update notice string or null if up to date.
 */
function checkFrameworkVersion(json) {
  try {
    const { MAVERICKS_VERSION } = require(MAVERICKS_VERSION_FILE);
    const stored = json?.mavericks_version;
    if (!stored) return null;
    const cmp = semverCompare(stored, MAVERICKS_VERSION);
    if (cmp === 0) return null;
    if (cmp < 0) {
      return `Framework updated: project uses v${stored}, current is v${MAVERICKS_VERSION}. Run: ./scripts/mavp-operator --install --update .`;
    }
    // stored > MAVERICKS_VERSION: project is ahead
    return `Version divergence: project uses v${stored}, framework is v${MAVERICKS_VERSION}. This project may have local framework customizations.`;
  } catch {
    return null;
  }
}

/**
 * Run validator silently. Returns { warning, warningDetail } where:
 *   warning — string or null (existing behaviour preserved)
 *   warningDetail — structured object or null (new; only on exit 1)
 *
 * On exit 0: both are null.
 * On exit 1 (drifting): warning is the existing string; warningDetail is parsed from --json run.
 * On exit 2 (repair required): warning is set; warningDetail is null.
 * On any parse / exec failure: falls back gracefully — never crashes.
 */
function runValidatorCheck() {
  try {
    execSync(`node "${VALIDATOR}"`, { stdio: 'pipe' });
    return { warning: null, warningDetail: null };
  } catch (err) {
    const code = err.status;

    if (code === 1) {
      const warning = 'DRIFTING — BACKLOG and TASK_STATUS are out of sync. Run --close-session.';
      let warningDetail = null;
      try {
        const jsonOutput = execSync(`node "${VALIDATOR}" --json`, { stdio: 'pipe' }).toString();
        const parsed = JSON.parse(jsonOutput);
        const comparison = parsed.comparison || {};
        const findings = comparison.findings || [];
        const counts = comparison.counts || {};
        const bySeverity = counts.bySeverity || {};
        const divergences = findings
          .filter(f => f.severity === 'failure' || f.severity === 'warning')
          .map(f => ({
            task: f.taskId || null,
            check: f.checkName || null,
            fix: f.suggestedAction || null,
          }));
        warningDetail = {
          state: 'DRIFTING',
          failures: bySeverity.failure || 0,
          warnings: bySeverity.warning || 0,
          divergences,
          next_action: 'Run ./scripts/mavp-operator to see details, or --close-session.',
        };
      } catch {
        // Parse or exec failed — warningDetail stays null
        warningDetail = null;
      }
      return { warning, warningDetail };
    }

    if (code === 2) {
      return { warning: 'REPAIR REQUIRED — critical artifact mismatch. Run --close-session immediately.', warningDetail: null };
    }

    return { warning: `Validator error (exit ${code}): ${err.message}`, warningDetail: null };
  }
}

/**
 * Attempt to read a SessionStart hook stdin payload for a runtime
 * permission_mode override, without ever blocking.
 *
 * When Claude Code invokes this script as a SessionStart hook, it pipes a
 * JSON payload on stdin that includes the live `permission_mode` (which can
 * differ from the settings-file default, e.g. after `claude --permission-mode
 * plan`). When invoked another way (e.g. the session-start skill's `!`
 * command path), no payload is piped: stdin is either an interactive TTY or
 * an already-closed/empty pipe. This function must never block waiting on
 * stdin in either of those cases.
 *
 * @returns {string|null} The runtime permission_mode from the hook payload,
 *   or null when no usable payload is present — caller should fall back to
 *   readPermissionMode(root).
 */
function readStdinPermissionModeOverride() {
  // An interactive TTY has no piped payload — reading from it would block
  // waiting on keyboard input, so skip the read entirely in that case.
  if (process.stdin.isTTY) return null;
  try {
    // With no piped input, fd 0 is an already-closed/empty pipe and this
    // returns immediately with an empty string — it does not block.
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return null;
    const payload = JSON.parse(raw);
    const mode = payload && payload.permission_mode;
    return typeof mode === 'string' && mode.length > 0 ? mode : null;
  } catch {
    // No payload, empty stdin, or malformed JSON — fall back silently.
    return null;
  }
}

/**
 * Persist a runtime permission_mode override (from the SessionStart hook
 * stdin payload) to a gitignored state file so other tools invoked later in
 * the session (e.g. --close-session) can honor a live override even when
 * the settings files on disk say otherwise.
 *
 * Best-effort and silent: any failure (unwritable filesystem, missing
 * permissions, etc.) is swallowed so this never breaks the --agent path.
 *
 * @param {string} root - Absolute path to the project root.
 * @param {string} mode - The runtime permission_mode to persist.
 */
function persistRuntimePermissionMode(root, mode) {
  try {
    const dir = path.join(root, '.mavp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'permission-mode'), `${mode}\n`, 'utf8');
  } catch {
    // Best-effort only — never break the --agent path on a write failure.
  }
}

function main() {
  generateProcessStateMd(PROCESS_STATE_JSON, PROCESS_STATE_MD);

  const json = readProcessStateJson();
  const md = parseProcessStateMd(readUtf8(PROCESS_STATE_MD));
  const activeTasks = parseActiveTaskStatus(readUtf8(TASK_STATUS_MD));
  const inFlightStatuses = new Set(['in_progress', 'dev_done', 'ux_review', 'ux_passed', 'security_review', 'security_passed', 'ready_for_qa', 'qa_in_progress']);
  const deployedStatuses = new Set(['deployed_dev', 'deployed_prod']);

  // Load module registry and backlog metadata for enriching active_slices output.
  // Registry is read from project-level docs/MODULES.md (respects MAVERICKS_PROJECT_ROOT).
  const moduleRegistry = parseModuleRegistry();
  let backlogMeta = {};
  let plannedTasks = [];
  let backlogTaskStatuses = {};
  try {
    const backlogContent = readUtf8(BACKLOG_MD);
    backlogMeta = parseBacklogTaskMeta(backlogContent);
    plannedTasks = parsePlannedTasksFromActiveWave(backlogContent);
    backlogTaskStatuses = parseBacklogTaskStatuses(backlogContent);
  } catch { /* backlog optional */ }

  const stage = json?.stage || md.stage || 'unknown';
  const initiative = json?.initiative || md.initiative || 'unknown';

  // Resolve blocker from PROCESS_STATE.json (preferred) or PROCESS_STATE.md blockers list.
  // Rule: if any string field in the JSON contains "REPAIR REQUIRED", surface it as
  // PROCESS_STATE_WARNING so session-start skill halts before creating new tasks.
  // This check takes priority — even if json.blocker itself contains "REPAIR REQUIRED",
  // normalise to the canonical sentinel value.
  let blocker;
  if (json) {
    const hasRepairRequired = Object.values(json).some(
      (v) => typeof v === 'string' && v.includes('REPAIR REQUIRED')
    );
    if (hasRepairRequired) {
      blocker = 'PROCESS_STATE_WARNING';
    } else {
      blocker = json.blocker || null;
    }
  } else {
    blocker = null;
  }
  // Fall back to PROCESS_STATE.md blockers list when JSON has no blocker.
  if (!blocker && md.blockers.length > 0) blocker = md.blockers[0];
  // Normalise legacy "none" string to null so downstream checks treat it as absent.
  if (blocker === 'none' || blocker === '') blocker = null;

  const staticNextAction = json?.next_action || (md.nextHandoff.length > 0 ? md.nextHandoff[0] : null);
  const lastUpdated = json?.last_updated || md.lastUpdate || 'unknown';
  const stageOwner = json?.stage_owner || 'main_agent';

  // Detect stale next_action: if the task ID referenced in the static next_action
  // (from PROCESS_STATE.json) has a terminal status (merged, deprecated, deferred) in
  // BACKLOG.md, recompute without the static fallback so we get a fresh answer from
  // active/planned tasks — same behaviour as when next_action is empty.
  const STALE_STATUSES = new Set(['merged', 'deprecated', 'deferred']);
  let next_action_stale = false;
  const staticTaskIdMatch = staticNextAction ? staticNextAction.match(/^(T-\d+)/) : null;
  if (staticTaskIdMatch) {
    const staticTaskId = staticTaskIdMatch[1];
    const staticTaskStatus = backlogTaskStatuses[staticTaskId];
    if (staticTaskStatus && STALE_STATUSES.has(staticTaskStatus)) {
      next_action_stale = true;
    }
  }

  let next_action = computeNextAction(activeTasks, plannedTasks, next_action_stale ? null : staticNextAction);

  // Additive-only: classify the static next_action's SHAPE (directive vs. freeform
  // prose) so a copied volatile fact (framework version, unpushed-commit count) with
  // no invalidation trigger is surfaced even though it can't be caught by the
  // leading-T-NNN staleness check above (staticTaskIdMatch is null for prose).
  // Never overrides next_action_stale or computeNextAction — see T-350.
  const nextActionClassification = classifyNextAction(staticNextAction);
  const next_action_unverified = Boolean(staticNextAction) && !staticTaskIdMatch;
  const next_action_volatile_facts = nextActionClassification.volatile_facts;

  const { warning: validatorWarning, warningDetail: validatorWarningDetail } = runValidatorCheck();
  const updateNotice = checkFrameworkVersion(json);
  const wave = json?.wave || null;
  const wave_session = json?.wave_session != null ? json.wave_session : null;
  const wave_goal = json?.wave_goal != null ? json.wave_goal : null;
  const governance = detectGovernance(stage);

  // deploy_contours controls deploy pipeline visibility:
  //   0 — no separate deploy step; merged = fully deployed; deploy_queue is always empty
  //   1 — single contour, auto-deploy-on-merge; merged = already deployed; no pending state
  //   2 — dev + prod contours (default when field is absent); merged tasks are deploy_pending
  const deployContours = json?.deploy_contours != null ? json.deploy_contours : 2;

  // Tasks that are merged but not yet deployed to any environment.
  // When deploy_contours <= 1, skip deploy queue entirely:
  //   0 — no deploy pipeline; merged is the final state.
  //   1 — single contour with auto-deploy-on-merge; merged = already deployed; no pending state.
  const deployQueue = buildDeployQueue(activeTasks, backlogMeta, deployContours);

  // When any tasks are in the deploy queue, surface the count directly in next_action
  // so operators see it at session start rather than needing to scan the full JSON.
  // Suppressed when deploy_contours <= 1 (no separate deploy step or auto-deploy-on-merge).
  if (deployQueue.length > 0) {
    const prereqCount = deployQueue.filter(t => t.prod_prerequisites && t.prod_prerequisites.length > 0).length;
    const prereqSuffix = prereqCount > 0 ? ` (${prereqCount} with prod prerequisites)` : '';
    next_action = `⚠ ${deployQueue.length} task(s) awaiting prod deploy${prereqSuffix} — promote before new work, or: ${next_action}`;
  }

  // Compute due/overdue rechecks from PROCESS_STATE.json rechecks[] registry.
  // today is determined from last_updated (same source used for lastUpdated display),
  // falling back to the current date. Entries with due <= today are surfaced.
  const recheckToday = json?.last_updated || new Date().toISOString().slice(0, 10);
  const rechecks = json?.rechecks || [];
  const { due: rechecksDue, overdue: rechecksOverdue } = computeDueRechecks(rechecks, recheckToday);
  // Combine: overdue entries first (more urgent), then due-today entries.
  // Each emitted entry carries: id, task, title, due, and an overdue boolean flag.
  const dueRechecks = [
    ...rechecksOverdue.map(e => ({ ...e, overdue: true })),
    ...rechecksDue.map(e => ({ ...e, overdue: false })),
  ];

  // Warn when a significant number of tasks are awaiting prod promotion.
  const DEPLOY_WARNING_THRESHOLD = 5;
  const deployedDevCount = deployQueue.filter(t => t.status === 'deployed_dev').length;
  const deployWarning = deployedDevCount >= DEPLOY_WARNING_THRESHOLD
    ? `${deployedDevCount} tasks awaiting prod promotion`
    : null;

  // Enrich active_slices with module, context_docs, repo from backlog + module registry
  const activeSlices = activeTasks
    .filter(t => inFlightStatuses.has(t.status))
    .map(t => {
      // Prefer module/repo from TASK_STATUS, fall back to BACKLOG
      const bm = backlogMeta[t.id] || {};
      const moduleId = t.module || bm.module || null;
      const repo = t.repo || bm.repo || null;
      const contextDocs = moduleId && moduleRegistry[moduleId]
        ? moduleRegistry[moduleId].context_docs
        : [];
      // Additive-only: surface the task's context prefetch bundle (T-394) when
      // it exists on disk. Absent files are silently omitted — never created here.
      const contextBundlePath = resolveContextBundlePath(t.id, ROOT);
      const contextBundleExists = fs.existsSync(contextBundlePath);
      // Additive-only: surface the parsed cross-repo Blocked by: refs (T-393)
      // when the task declares them. Absent field is silently omitted.
      const blockedBy = bm.blockedByRaw ? parseBlockedBy(bm.blockedByRaw) : [];
      return {
        ...t,
        ...(moduleId ? { module: moduleId } : {}),
        ...(contextDocs.length > 0 ? { context_docs: contextDocs } : {}),
        ...(repo ? { repo } : {}),
        ...(contextBundleExists ? { context_bundle: path.relative(ROOT, contextBundlePath) } : {}),
        ...(blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      };
    });

  // Additive-only: T-391 must-read set — files changed since the previous
  // --close-session commit (via git) unioned with the context_docs already
  // resolved onto activeSlices above. Degrades silently (empty array) when
  // git is unavailable or ROOT isn't a git repo; field is omitted entirely
  // below when the combined set is empty.
  const mustRead = computeMustRead(ROOT, activeSlices);

  const stdinPermissionMode = readStdinPermissionModeOverride();
  if (stdinPermissionMode) persistRuntimePermissionMode(ROOT, stdinPermissionMode);
  const permissionMode = stdinPermissionMode || readPermissionMode(ROOT);

  const output = {
    initiative,
    stage,
    stage_owner: stageOwner,
    permission_mode: permissionMode,
    ...(wave ? { wave } : {}),
    ...(wave_session != null ? { wave_session } : {}),
    ...(wave_goal != null ? { wave_goal } : {}),
    ...(governance ? { governance: true } : {}),
    active_slices: activeSlices,
    ...(plannedTasks.length > 0 ? { planned_tasks: plannedTasks } : {}),
    ...(deployContours === 0 ? { deploy_queue: [] } : deployQueue.length > 0 ? { deploy_queue: deployQueue } : {}),
    ...(deployWarning ? { deploy_warning: deployWarning } : {}),
    blocker,
    next_action,
    ...(next_action_stale ? { next_action_stale: true } : {}),
    ...(next_action_unverified ? { next_action_unverified: true } : {}),
    ...(next_action_volatile_facts.length > 0 ? { next_action_volatile_facts } : {}),
    last_updated: lastUpdated,
    ...(validatorWarning ? { WARNING: validatorWarning } : {}),
    ...(validatorWarningDetail ? { WARNING_DETAIL: validatorWarningDetail } : {}),
    ...(updateNotice ? { UPDATE_AVAILABLE: updateNotice } : {}),
    ...(dueRechecks.length > 0 ? { due_rechecks: dueRechecks } : {}),
    ...(mustRead.length > 0 ? { must_read: mustRead } : {}),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent summary failed: ${error.message}\n`);
  process.exitCode = 1;
}
