const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_PATH = path.join(ROOT, 'PROCESS_STATE.md');
const PROCESS_STATE_JSON_PATH = path.join(ROOT, 'PROCESS_STATE.json');
const TASK_STATUS_PATH = path.join(ROOT, 'TASK_STATUS.md');
const BACKLOG_PATH = path.join(ROOT, 'BACKLOG.md');

const CLAUDE_CONTEXT_WINDOW = 200000;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Determine the next task ID by reading PROCESS_STATE.json last_task_id
 * and also scanning BACKLOG.md + TASK_STATUS.md for the highest existing ID.
 * Takes the max of both sources to avoid duplicates.
 *
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath - Absolute path to TASK_STATUS.md
 * @param {string} processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @returns {string} Next task ID in T-NNN format
 */
function getNextTaskId(backlogPath, taskStatusPath, processStateJsonPath) {
  let maxFromFiles = 0;
  const backlog = fs.existsSync(backlogPath) ? fs.readFileSync(backlogPath, 'utf8') : '';
  const taskStatus = fs.existsSync(taskStatusPath) ? fs.readFileSync(taskStatusPath, 'utf8') : '';
  const combined = backlog + '\n' + taskStatus;
  const matches = [...combined.matchAll(/###\s+T-(\d+)/g)];
  if (matches.length) {
    maxFromFiles = Math.max(...matches.map(m => parseInt(m[1], 10)));
  }

  let maxFromState = 0;
  try {
    if (fs.existsSync(processStateJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
      if (typeof parsed.last_task_id === 'number') {
        maxFromState = parsed.last_task_id;
      }
    }
  } catch {
    // ignore — fall back to file scan
  }

  const max = Math.max(maxFromFiles, maxFromState);
  return `T-${String(max + 1).padStart(3, '0')}`;
}

/**
 * Insert entry into BACKLOG.md Active Wave section.
 * Finds the ## Active Wave section, then inserts before the next ## heading
 * at the same (h2) level or at the end of the file.
 * This avoids accidentally placing the entry inside an archived wave section.
 *
 * @param {string} markdown - Content of BACKLOG.md
 * @param {string} entry - Task block to insert
 * @returns {string} Updated markdown
 */
function insertIntoActiveWave(markdown, entry) {
  const activeWaveMatch = markdown.match(/\n## Active Wave[^\n]*/);
  if (!activeWaveMatch) {
    return markdown.trimEnd() + '\n' + entry;
  }

  // Position right after the Active Wave header line
  const activeWaveStart = markdown.indexOf(activeWaveMatch[0]);
  const afterHeaderStart = activeWaveStart + activeWaveMatch[0].length;
  const restOfFile = markdown.slice(afterHeaderStart);

  // Find the next h2 heading (## ) that terminates the Active Wave section
  const nextSectionMatch = restOfFile.match(/\n(?=## )/);
  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    const insertAt = afterHeaderStart + nextSectionMatch.index;
    return markdown.slice(0, insertAt) + '\n' + entry + markdown.slice(insertAt);
  }

  // No next section — append at end of file
  return markdown.trimEnd() + '\n' + entry;
}

/**
 * Insert entry into TASK_STATUS.md Active tasks section.
 * Inserts before ## Recently completed tasks if present, else appends.
 *
 * @param {string} markdown - Content of TASK_STATUS.md
 * @param {string} entry - Task block to insert
 * @returns {string} Updated markdown
 */
function insertIntoActiveTasks(markdown, entry) {
  const completedMatch = markdown.match(/\n## Recently completed tasks/);
  if (completedMatch) {
    const idx = markdown.indexOf(completedMatch[0]);
    return markdown.slice(0, idx) + entry + markdown.slice(idx);
  }
  return markdown.trimEnd() + '\n' + entry;
}

/**
 * Update last_task_id in PROCESS_STATE.json to the highest registered ID.
 * Only updates if numericId is greater than the current last_task_id.
 *
 * @param {string} processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @param {number|string} numericId - The numeric ID (or T-NNN string) to set
 * @returns {boolean} true if updated, false if skipped or failed
 */
function updateLastTaskId(processStateJsonPath, numericId) {
  try {
    if (!fs.existsSync(processStateJsonPath)) return false;
    const raw = fs.readFileSync(processStateJsonPath, 'utf8');
    const json = JSON.parse(raw);
    const id = typeof numericId === 'string'
      ? parseInt(numericId.replace('T-', ''), 10)
      : numericId;
    if (Number.isNaN(id)) return false;
    if (typeof json.last_task_id === 'number' && id <= json.last_task_id) return false;
    json.last_task_id = id;
    json.last_updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(processStateJsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeWhitespace(value) {
  return value ? value.replace(/\s+/g, ' ').trim() : '';
}

function getSection(markdown, headingLabel) {
  const lines = markdown.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === headingLabel.trim());

  if (startIndex === -1) {
    return '';
  }

  let endIndex = lines.length;
  const currentLevel = (headingLabel.match(/^#+/) || [''])[0].length;

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#+)\s+/);
    if (match && match[1].length <= currentLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join('\n').trim();
}

function getListItems(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .map((line) => normalizeWhitespace(line.replace(/^([-*]\s+|\d+\.\s+)/, '')));
}

function getSingleParagraph(section) {
  return normalizeWhitespace(section.replace(/^[-*]\s+/gm, '').replace(/\n+/g, ' '));
}

function parseProcessState(markdown) {
  return {
    initiative: getSingleParagraph(getSection(markdown, '## Current initiative')),
    stage: getSingleParagraph(getSection(markdown, '## Current loop stage')),
    blockers: getListItems(getSection(markdown, '## Current blockers')),
    openQuestions: getListItems(getSection(markdown, '## Open questions')),
    nextHandoff: getListItems(getSection(markdown, '## Next expected handoff')),
    lastMeaningfulMovement: getListItems(getSection(markdown, '## Last meaningful movement')),
    lastUpdate: getSingleParagraph(getSection(markdown, '## Last update')),
  };
}

function parseActiveTask(markdown) {
  const activeTasksSection = getSection(markdown, '## Active tasks');
  const blocks = activeTasksSection
    .split(/\n(?=###\s+T-\d+)/)
    .map((block) => block.trim())
    .filter(Boolean);

  const first = blocks[0];
  if (!first) {
    return null;
  }

  const headingMatch = first.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
  const statusMatch = first.match(/^- \*\*Status:\*\*\s+(.+)$/m);
  const ownerMatch = first.match(/^- \*\*Owner:\*\*\s+(.+)$/m);
  const notesMatch = first.match(/^- \*\*Notes:\*\*\s+(.+)$/m);

  return {
    id: headingMatch ? headingMatch[1] : 'unknown',
    title: headingMatch ? normalizeWhitespace(headingMatch[2]) : 'Unknown task',
    status: statusMatch ? normalizeWhitespace(statusMatch[1]) : 'unknown',
    owner: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : 'unknown',
    notes: notesMatch ? normalizeWhitespace(notesMatch[1]) : '',
  };
}

function inferClassification(stage, task, initiative = '') {
  const source = `${initiative} ${stage} ${task?.title || ''} ${task?.notes || ''}`.toLowerCase();

  if (source.includes('migration')) return 'migration';
  if (source.includes('lightweight')) return 'lightweight';
  if (source.includes('mavp') || source.includes('parliamentary')) return 'MavP';
  return 'normal';
}

function tryParseJson(value) {
  const trimmed = (value || '').trim();

  if (!trimmed) {
    return { ok: true, data: [] };
  }

  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch (error) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 0 && lines.every((line) => line.startsWith('{') && line.endsWith('}'))) {
      try {
        return {
          ok: true,
          data: lines.map((line) => JSON.parse(line)),
        };
      } catch {
        // fall through
      }
    }

    return {
      ok: false,
      reason: `could not parse JSON output (${error.message})`,
      raw: trimmed,
    };
  }
}

function execJson(command, args) {
  try {
    const result = cp.spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 4000,
    });

    if (result.error) {
      return { ok: false, reason: result.error.message };
    }

    if (result.status !== 0) {
      return {
        ok: false,
        reason: normalizeWhitespace(result.stderr || result.stdout || `exit ${result.status}`),
      };
    }

    const parsed = tryParseJson(result.stdout);
    if (parsed.ok) {
      return { ok: true, data: parsed.data };
    }

    return {
      ok: false,
      reason: parsed.reason,
      raw: parsed.raw,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function getSessionData() {
  return { ok: false, reason: 'claude session list not available' };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.tasks)) return value.tasks;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function clip(value, max = 120) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isBoilerplateRuntimeText(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) return true;

  return (
    normalized.length < 8 ||
    /^(ok|done|yes|no|own|none|unknown)$/i.test(normalized) ||
    normalized.includes('reply to the user in a helpful way') ||
    normalized.includes('if it succeeded, share the relevant output') ||
    normalized.includes('if it failed, explain what went wrong') ||
    normalized.includes('approval required') ||
    normalized.includes('allow-once|allow-always|deny')
  );
}

function getSessionSummary(session) {
  const candidates = [
    session.currentTask,
    session.task,
    session.summary,
    session.prompt,
    session.lastEvent,
    session.lastMessage,
    session.note,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized) continue;
    if (isBoilerplateRuntimeText(normalized)) continue;
    return clip(normalized, 100);
  }

  return '';
}

function formatIsoTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function getSessionStatusLabel(session) {
  const raw = normalizeWhitespace(
    session.status || session.state || session.phase || session.lastStatus || ''
  ).toLowerCase();
  const summary = normalizeWhitespace(
    [session.summary, session.task, session.currentTask, session.lastMessage, session.lastEvent, session.note]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  if (raw) {
    if (raw === 'done' || raw === 'completed' || raw === 'finished' || raw === 'success') return 'completed';
    if (raw === 'running' || raw === 'active' || raw === 'started' || raw === 'working') return 'running';
    if (raw.includes('wait') && raw.includes('approval')) return 'waiting_approval';
    if (raw.includes('wait') && raw.includes('subagent')) return 'waiting_subagent';
    if (raw.includes('block') || raw.includes('error') || raw.includes('failed')) return 'blocked';
    if (raw.includes('idle')) return 'idle_unexpected';
    return raw;
  }

  if (summary.includes('/approve') || summary.includes('approval required')) return 'waiting_approval';
  if (summary.includes('waiting on sub-agent') || summary.includes('waiting on subagent') || summary.includes('waiting for sub-agent') || summary.includes('waiting for subagent')) return 'waiting_subagent';
  if (summary.includes('blocked') || summary.includes('error') || summary.includes('failed')) return 'blocked';
  if (session.endedAt) return 'completed';
  if (session.key === 'agent:main:main') return 'running';
  return 'unknown';
}

function shortenSessionKey(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  if (normalized.startsWith('agent:main:main')) return 'main';
  const subagentMatch = normalized.match(/subagent:([a-f0-9-]+)$/i);
  if (subagentMatch) {
    return `subagent:${subagentMatch[1].slice(0, 8)}`;
  }
  return normalized;
}

function cleanupDisplayName(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalized
    .replace(/^webchat:g-agent-main-main$/, 'main')
    .replace(/^webchat:g-agent-main-subagent-([a-f0-9-]+)$/i, (_, id) => `subagent:${id.slice(0, 8)}`)
    .replace(/^g-agent-main-main$/, 'main')
    .replace(/^g-agent-main-subagent-([a-f0-9-]+)$/i, (_, id) => `subagent:${id.slice(0, 8)}`);
}

function chooseSessionLabel(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate);
    if (!normalized) continue;
    if (normalized.length <= 3 && !normalized.includes(':') && normalized !== 'main') continue;
    if (/^[a-z]{1,4}$/i.test(normalized) && normalized !== 'main') continue;
    return normalized;
  }
  return 'unknown-session';
}

function getSessionLabel(session) {
  return chooseSessionLabel(
    session.label,
    cleanupDisplayName(session.displayName),
    session.sessionLabel,
    session.name,
    shortenSessionKey(session.key || session.sessionKey),
    session.id
  );
}

function getSessionRole(session) {
  const keySource = normalizeWhitespace(session.key || session.sessionKey || '').toLowerCase();
  const labelSource = normalizeWhitespace(
    [session.label, session.displayName, session.sessionLabel, session.name, session.agentId, session.kind, session.type]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();

  if (keySource.includes(':subagent:') || session.parentSessionKey || session.spawnedBy || labelSource.includes('subagent')) {
    return 'subagent';
  }

  if (session.key === 'agent:main:main' || keySource === 'agent:main:main' || /^agent:main:(telegram|discord|signal|whatsapp|slack|webchat):/.test(keySource)) {
    return 'main_agent';
  }

  if (labelSource.includes('human') || labelSource.includes('user')) return 'human';
  if (labelSource.includes('acp') || labelSource.includes('codex') || labelSource.includes('claude') || labelSource.includes('cursor')) return 'acp_session';
  return normalizeWhitespace(session.agentId || session.kind || session.type || 'agent');
}

function normalizeActorRecord(session) {
  return {
    actor_id: session.id || session.key || session.sessionKey || getSessionLabel(session),
    label: getSessionLabel(session),
    role: getSessionRole(session),
    status: getSessionStatusLabel(session),
    current_task: getSessionSummary(session),
    parent_actor_id: session.parentSessionKey || session.spawnedBy || '',
    updated_at: session.updatedAt || session.endedAt || session.startedAt || '',
    started_at: session.startedAt || '',
    expected_handoff: normalizeWhitespace(session.returnTo || session.handoffTarget || ''),
    raw: session,
  };
}

function getTaskWaitItems(taskList) {
  return taskList
    .map((task) => {
      const status = normalizeWhitespace(task.status || task.state || 'unknown');
      const rawLabel = normalizeWhitespace(task.label || task.name || task.id || 'unknown-task');
      const summary = getSessionSummary(task);
      const label = isBoilerplateRuntimeText(rawLabel) ? 'runtime-task' : clip(rawLabel, 60);

      if (!/wait|block|pending|running/i.test(status)) {
        return null;
      }

      return { label, status, summary };
    })
    .filter(Boolean);
}

function ageFrom(value) {
  if (!value) return '';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '';
  const deltaMs = Math.max(Date.now() - timestamp, 0);
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function getSeverity(waitType, status = '') {
  const source = `${waitType} ${status}`.toLowerCase();
  if (source.includes('blocked')) return 4;
  if (source.includes('approval')) return 3;
  if (source.includes('idle')) return 3;
  if (source.includes('subagent')) return 2;
  return 1;
}

function buildRecentEvents(processState, actors) {
  const events = [];

  for (const item of processState.lastMeaningfulMovement.slice(-8).reverse()) {
    events.push({
      event_type: 'workflow_movement',
      actor_label: 'workflow',
      summary: item,
      timestamp: processState.lastUpdate || '',
    });
  }

  for (const actor of actors) {
    if (actor.status === 'completed') {
      events.push({
        event_type: 'actor_completed',
        actor_label: actor.label,
        summary: actor.current_task ? `completed — ${actor.current_task}` : 'completed',
        timestamp: actor.updated_at || '',
      });
    } else if (actor.status === 'waiting_approval' || actor.status === 'waiting_subagent' || actor.status === 'blocked') {
      events.push({
        event_type: 'actor_transition',
        actor_label: actor.label,
        summary: `${actor.status}${actor.current_task ? ` — ${actor.current_task}` : ''}`,
        timestamp: actor.updated_at || '',
      });
    }
  }

  return events
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 10);
}

function readTodayTokenUsage() {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let inputTotal = 0, outputTotal = 0, cacheReadTotal = 0;

    const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(CLAUDE_PROJECTS_DIR, d.name));

    for (const projectDir of projectDirs) {
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      for (const file of jsonlFiles) {
        const filePath = path.join(projectDir, file);
        const stat = fs.statSync(filePath);
        // Skip files not modified today (fast path)
        if (new Date(stat.mtimeMs).toISOString().slice(0, 10) !== today) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.includes('"assistant"')) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'assistant' || !entry.message?.usage) continue;
            if (!entry.timestamp || !String(entry.timestamp).startsWith(today) &&
                !new Date(entry.timestamp).toISOString().startsWith(today)) continue;
            const u = entry.message.usage;
            inputTotal += u.input_tokens || 0;
            outputTotal += u.output_tokens || 0;
            cacheReadTotal += u.cache_read_input_tokens || 0;
          } catch { /* skip */ }
        }
      }
    }

    if (inputTotal === 0 && outputTotal === 0) return null;
    return { input: inputTotal, output: outputTotal, cache_read: cacheReadTotal };
  } catch {
    return null;
  }
}

function readSessionTokenUsage() {
  try {
    const projectKey = ROOT.replace(/\//g, '-');
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectKey);
    if (!fs.existsSync(projectDir)) return null;

    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (!files.length) return null;

    const jsonlPath = path.join(projectDir, files[0].f);
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trimEnd().split('\n');

    // Scan from end for latest assistant message with usage
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          const contextUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          return {
            context_used: contextUsed,
            context_window: CLAUDE_CONTEXT_WINDOW,
            context_pct: Math.round((contextUsed / CLAUDE_CONTEXT_WINDOW) * 100),
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_read: u.cache_read_input_tokens || 0,
            cache_write: u.cache_creation_input_tokens || 0,
            model: entry.message.model || '',
            session_id: entry.sessionId || '',
          };
        }
      } catch { /* skip malformed lines */ }
    }
    return null;
  } catch {
    return null;
  }
}

function relativeTime(value) {
  if (!value) return '';
  const iso = String(value).includes('T') ? value : `${value}T12:00:00Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(value);
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function parseWaveProgress(markdown) {
  const activeSection = getSection(markdown, '## Active tasks');
  const activeBlocks = activeSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);

  const completedSection = getSection(markdown, '## Recently completed tasks');
  const completedBlocks = completedSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
  const mergedCount = completedBlocks.filter(b => /\*\*Status:\*\*\s+merged/.test(b)).length;

  const total = activeBlocks.length + mergedCount;
  return { active: activeBlocks.length, merged: mergedCount, total };
}

/**
 * Parse tasks belonging to the current wave only.
 *
 * Algorithm:
 * - All task IDs from TASK_STATUS.md "## Active tasks" are always included.
 * - Task IDs from TASK_STATUS.md "## Recently completed tasks" are included
 *   only if they appear in the BACKLOG.md "## Active Wave" section.
 *
 * @param {string} taskStatusMarkdown - Content of TASK_STATUS.md
 * @param {string} backlogMarkdown    - Content of BACKLOG.md
 * @returns {Array<{id:string, title:string, status:string}>}
 */
function parseWaveTasks(taskStatusMarkdown, backlogMarkdown) {
  // Collect task IDs that belong to the active wave in BACKLOG.md
  const activeWaveIds = new Set();
  const activeWaveSection = (() => {
    const lines = (backlogMarkdown || '').split(/\r?\n/);
    const startIdx = lines.findIndex((l) => /^##\s+Active Wave/i.test(l));
    if (startIdx === -1) return '';
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
    }
    return lines.slice(startIdx + 1, endIdx).join('\n');
  })();

  for (const m of activeWaveSection.matchAll(/^###\s+(T-\d+)/gm)) {
    activeWaveIds.add(m[1]);
  }

  const result = [];

  // Always include all tasks from "## Active tasks"
  const activeSection = getSection(taskStatusMarkdown, '## Active tasks');
  const activeBlocks = activeSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
  for (const block of activeBlocks) {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    if (!headingMatch) continue;
    result.push({
      id: headingMatch[1],
      title: headingMatch[2].trim(),
      status: statusMatch ? statusMatch[1].trim() : 'unknown',
    });
  }

  // Include recently completed tasks only if they are in the active wave
  if (activeWaveIds.size > 0) {
    const completedSection = getSection(taskStatusMarkdown, '## Recently completed tasks');
    const completedBlocks = completedSection.split(/\n(?=###\s+T-)/).map(b => b.trim()).filter(Boolean);
    for (const block of completedBlocks) {
      const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
      const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
      if (!headingMatch) continue;
      const id = headingMatch[1];
      if (activeWaveIds.has(id)) {
        result.push({
          id,
          title: headingMatch[2].trim(),
          status: statusMatch ? statusMatch[1].trim() : 'unknown',
        });
      }
    }
  }

  return result;
}

function readProcessStateJson() {
  try {
    if (!fs.existsSync(PROCESS_STATE_JSON_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROCESS_STATE_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function mergeProcessState(mdState, jsonState) {
  if (!jsonState) return mdState;
  return {
    ...mdState,
    initiative: jsonState.initiative || mdState.initiative,
    stage: jsonState.stage || mdState.stage,
    blockers: jsonState.blocker ? [jsonState.blocker] : mdState.blockers,
    openQuestions: jsonState.open_questions || mdState.openQuestions,
    lastUpdate: jsonState.last_updated || mdState.lastUpdate,
    _stageOwner: jsonState.stage_owner || '',
    _nextAction: jsonState.next_action || '',
    _activeSlice: jsonState.active_slice || '',
    _wave: jsonState.wave || null,
    _waveStatus: jsonState.wave_status || 'planning',
    _waveGoal: jsonState.wave_goal || null,
    _waveStrategyNote: jsonState.wave_strategy_note || null,
    _deployContours: typeof jsonState.deploy_contours === 'number' ? jsonState.deploy_contours : 0,
  };
}

/**
 * Parse active wave tasks from BACKLOG.md and detect file-level conflicts.
 * A conflict occurs when two or more active tasks declare the same file path
 * in their `- **Touches:**` field.
 *
 * @param {string} backlogMarkdown - Raw content of BACKLOG.md
 * @returns {{ file: string, tasks: string[] }[]} Array of conflicts (entries where tasks.length >= 2)
 */
function parseTouchesConflicts(backlogMarkdown) {
  // Split on task headings (### T-NNN) to get per-task blocks
  const taskBlocks = backlogMarkdown.split(/\n(?=###\s+T-\d+\s+)/);

  // Active-status values that mean the task is in-flight
  const activeStatuses = new Set([
    'in_progress', 'dev_done', 'ux_review', 'ux_passed',
    'security_review', 'security_passed', 'ready_for_qa', 'qa_in_progress', 'planned',
  ]);

  // Map: filePath → taskId[]
  const fileToTasks = new Map();

  for (const block of taskBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    const statusMatch = block.match(/[-*]\s+\*\*Status:\*\*\s+(\S+)/);
    if (!statusMatch) continue;
    const status = statusMatch[1].trim().replace(/[^a-z_]/gi, '');
    if (!activeStatuses.has(status)) continue;

    const touchesMatch = block.match(/[-*]\s+\*\*Touches:\*\*\s+(.+)/);
    if (!touchesMatch) continue;

    const files = touchesMatch[1]
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    for (const filePath of files) {
      if (!fileToTasks.has(filePath)) {
        fileToTasks.set(filePath, []);
      }
      fileToTasks.get(filePath).push(taskId);
    }
  }

  const conflicts = [];
  for (const [file, tasks] of fileToTasks.entries()) {
    if (tasks.length >= 2) {
      conflicts.push({ file, tasks });
    }
  }
  return conflicts;
}

function collectOperatorData() {
  const backlogContent = fs.existsSync(BACKLOG_PATH) ? readUtf8(BACKLOG_PATH) : '';
  const touchesConflicts = parseTouchesConflicts(backlogContent);

  const taskStatusContent = readUtf8(TASK_STATUS_PATH);
  const processStateJson = readProcessStateJson();
  const processState = mergeProcessState(
    parseProcessState(readUtf8(PROCESS_STATE_PATH)),
    processStateJson
  );
  const activeTask = parseActiveTask(taskStatusContent);
  const waveProgress = parseWaveProgress(taskStatusContent);
  const waveTasks = parseWaveTasks(taskStatusContent, backlogContent);
  const classification = inferClassification(processState.stage, activeTask, processState.initiative);

  const deployContours = processState._deployContours || 0;
  const deployPendingTasks = deployContours >= 2
    ? parseTasksWithRepo(taskStatusContent, backlogContent).filter(t => t.status === 'merged' || t.status === 'deployed_dev')
    : [];

  // Compute due/overdue rechecks from PROCESS_STATE.json rechecks[] registry (read-only).
  const recheckToday = processStateJson?.last_updated || new Date().toISOString().slice(0, 10);
  const rechecks = processStateJson?.rechecks || [];
  const { due: rechecksDue, overdue: rechecksOverdue } = computeDueRechecks(rechecks, recheckToday);
  const dueRechecks = [
    ...rechecksOverdue.map(e => ({ ...e, overdue: true })),
    ...rechecksDue.map(e => ({ ...e, overdue: false })),
  ];

  const sessionsResult = getSessionData();
  const tasksResult = { ok: false, reason: 'claude task list not available' };

  const sessions = sessionsResult.ok ? toArray(sessionsResult.data) : [];
  const tasks = tasksResult.ok ? toArray(tasksResult.data) : [];
  const runtimeActors = sessions
    .map(normalizeActorRecord)
    .sort((a, b) => {
      const statusWeight = { running: 5, waiting_approval: 4, waiting_subagent: 3, blocked: 2, idle_unexpected: 1, completed: 0 };
      return (statusWeight[b.status] || -1) - (statusWeight[a.status] || -1) || String(b.updated_at).localeCompare(String(a.updated_at));
    });

  const workflowBlockers = processState.blockers.map((summary) => ({
    wait_type: 'blocker',
    actor_id: 'workflow',
    actor_label: 'workflow',
    summary,
    age: '',
    severity: getSeverity('blocker'),
    status: 'blocked',
  }));

  const waitStates = [
    ...workflowBlockers,
    ...runtimeActors
      .filter((actor) => ['waiting_approval', 'waiting_subagent', 'blocked', 'idle_unexpected'].includes(actor.status))
      .map((actor) => ({
        wait_type: actor.status.includes('approval') ? 'approval' : actor.status.includes('subagent') ? 'subagent' : actor.status.includes('idle') ? 'idle_watchdog' : 'blocker',
        actor_id: actor.actor_id,
        actor_label: actor.label,
        summary: actor.current_task || actor.status,
        age: ageFrom(actor.updated_at),
        severity: getSeverity(actor.status, actor.status),
        status: actor.status,
      })),
    ...getTaskWaitItems(tasks).map((task) => ({
      wait_type: /approval/i.test(task.status) ? 'approval' : /block/i.test(task.status) ? 'blocker' : 'subagent',
      actor_id: task.label,
      actor_label: task.label,
      summary: task.summary ? `${task.status} — ${task.summary}` : task.status,
      age: '',
      severity: getSeverity(task.status, task.status),
      status: task.status,
    })),
  ].sort((a, b) => b.severity - a.severity || String(b.age).localeCompare(String(a.age)));

  const recentEvents = buildRecentEvents(processState, runtimeActors);

  const tokenUsage = readSessionTokenUsage();
  const todayUsage = readTodayTokenUsage();
  const trajectorySummary = summarizeTrajectories({ dir: path.join(ROOT, '.mavp', 'trajectories') });

  return {
    token_usage: tokenUsage,
    today_usage: todayUsage,
    workflow_state: {
      initiative_title: processState.initiative,
      stage: processState.stage,
      active_task: activeTask ? `${activeTask.id} — ${activeTask.title}` : 'none',
      owner: activeTask?.owner || 'unknown',
      classification,
      next_action: processState._nextAction || '',
      wave: processState._wave,
      wave_status: processState._waveStatus,
      wave_goal: processState._waveGoal || null,
      wave_strategy_note: processState._waveStrategyNote || null,
      next_handoff: processState.nextHandoff,
      blockers: processState.blockers,
      pending_approvals: waitStates.filter((item) => item.wait_type === 'approval').length,
      last_movement: processState.lastMeaningfulMovement[processState.lastMeaningfulMovement.length - 1] || '',
      task_status: activeTask?.status || 'unknown',
      task_notes: activeTask?.notes || '',
      last_update: processState.lastUpdate || '',
      last_update_relative: relativeTime(processState.lastUpdate),
      wave_progress: waveProgress,
      wave_tasks: waveTasks,
      deploy_contours: deployContours,
      deploy_pending_tasks: deployPendingTasks,
    },
    runtime_actors: runtimeActors,
    wait_states: waitStates,
    recent_events: recentEvents,
    touches_conflicts: touchesConflicts,
    wave_tasks: waveTasks,
    trajectory_summary: trajectorySummary,
    due_rechecks: dueRechecks,
    sources: {
      sessions: sessionsResult,
      tasks: tasksResult,
    },
  };
}

function renderList(title, items, fallback = 'none') {
  const lines = [title];
  if (!items || items.length === 0) {
    lines.push(`- ${fallback}`);
    return lines.join('\n');
  }

  for (const item of items) {
    lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

function renderThinSnapshot(data) {
  const { workflow_state: workflow, runtime_actors: actors, wait_states: waits, recent_events: recentEvents, touches_conflicts: touchesConflicts, wave_tasks: waveTasks, trajectory_summary: trajectorySummary, due_rechecks: dueRechecks, sources } = data;

  const activeActors = actors
    .filter((actor) => ['running', 'waiting_approval', 'waiting_subagent', 'blocked'].includes(actor.status))
    .map((actor) => {
      const parts = [`label:${actor.label}`, `role:${actor.role}`, `status:${actor.status}`];
      if (actor.parent_actor_id) parts.push(`parent:${shortenSessionKey(actor.parent_actor_id)}`);
      if (actor.current_task) parts.push(`task:${actor.current_task}`);
      if (actor.started_at) parts.push(`started:${formatIsoTime(actor.started_at)}`);
      if (actor.updated_at) parts.push(`updated:${formatIsoTime(actor.updated_at)}`);
      return parts.join(' | ');
    });

  const historicalActors = actors
    .filter((actor) => !['running', 'waiting_approval', 'waiting_subagent', 'blocked'].includes(actor.status))
    .slice(0, 6)
    .map((actor) => {
      const parts = [`label:${actor.label}`, `role:${actor.role}`, `status:${actor.status}`];
      if (actor.current_task) parts.push(`task:${actor.current_task}`);
      if (actor.updated_at) parts.push(`updated:${formatIsoTime(actor.updated_at)}`);
      return parts.join(' | ');
    });

  const waitLines = waits.map((wait) => `${wait.actor_label} — ${wait.status}${wait.age ? ` (${wait.age})` : ''}${wait.summary ? ` — ${wait.summary}` : ''}`);

  const recentLines = recentEvents.map((event) => `${event.actor_label} — ${event.summary}`);

  const parts = [
    '# MavP Operator Snapshot',
    '',
    `Initiative: ${workflow.initiative_title || 'unknown'}`,
    `Stage: ${workflow.stage || 'unknown'}`,
    `Wave status: ${workflow.wave_status || 'unknown'}`,
    ...((() => {
      if (!waveTasks || !waveTasks.length) return [];
      const waveNum = workflow.wave ? `Wave ${workflow.wave}` : 'Wave';
      const counts = waveTasks.reduce((acc, t) => {
        const s = t.status;
        if (s === 'merged') acc.merged++;
        else if (s === 'in_progress' || s === 'dev_done' || s === 'ready_for_qa' || s === 'qa_in_progress' || s === 'qa_passed' || s === 'ux_review' || s === 'ux_passed' || s === 'security_review' || s === 'security_passed') acc.in_progress++;
        else acc.planned++;
        return acc;
      }, { merged: 0, in_progress: 0, planned: 0 });
      const parts = [];
      if (counts.merged) parts.push(`${counts.merged} merged`);
      if (counts.in_progress) parts.push(`${counts.in_progress} in_progress`);
      if (counts.planned) parts.push(`${counts.planned} planned`);
      return [`${waveNum}: ${parts.join(', ') || 'no tasks'}`];
    })()),
    ...(workflow.wave_goal ? [`Wave goal: ${workflow.wave_goal}`] : []),
    ...(workflow.wave_strategy_note ? [`Strategy note: ${workflow.wave_strategy_note}`] : []),
    ...((() => {
      if (!trajectorySummary || !trajectorySummary.length) return [];
      const compact = trajectorySummary.map((r) => `${r.role} ${r.count} (${r.successPct}%)`).join(', ');
      return [`Trajectories: ${compact}`];
    })()),
    `Active task: ${workflow.active_task || 'none'}`,
    `Task status: ${workflow.task_status || 'unknown'}`,
    `Owner: ${workflow.owner || 'unknown'}`,
    `Classification: ${workflow.classification}`,
    `Last update: ${workflow.last_update || 'unknown'}`,
    '',
    renderList('Next handoff', workflow.next_handoff, 'none visible'),
    '',
    renderList('Waits / blockers', waitLines, 'none'),
  ];

  if (touchesConflicts && touchesConflicts.length > 0) {
    parts.push('');
    parts.push(`Touches conflicts (${touchesConflicts.length}):`);
    for (const conflict of touchesConflicts) {
      parts.push(`  - ${conflict.file} → ${conflict.tasks.join(', ')}`);
    }
  }

  if (workflow.deploy_contours >= 2 && workflow.deploy_pending_tasks && workflow.deploy_pending_tasks.length > 0) {
    const deployLines = workflow.deploy_pending_tasks.map(t => `${t.id}${t.repo ? ` (${t.repo})` : ''} — ${t.title}`);
    parts.push('', renderList('Pending prod deployment', deployLines, 'none'));
  }

  if (dueRechecks && dueRechecks.length > 0) {
    const overdueCount = dueRechecks.filter(e => e.overdue).length;
    const taskRefs = dueRechecks.map(e => e.task || e.id).join(', ');
    const overdueSuffix = overdueCount > 0 ? ` (${overdueCount} overdue)` : '';
    parts.push('', `Due rechecks: ${dueRechecks.length} due: ${taskRefs}${overdueSuffix}`);
  }

  parts.push(
    '',
    renderList('Active runtime actors', activeActors, sources.sessions.ok ? 'no visible active runtime actors' : `runtime unavailable (${sources.sessions.reason})`),
    '',
    renderList('Historical / recently finished actors', historicalActors, 'none visible'),
    '',
    renderList('Recent movement', recentLines, 'none recorded'),
  );

  if (!sources.tasks.ok) {
    parts.push('', `Tasks runtime source unavailable: ${sources.tasks.reason}`);
    if (sources.tasks.raw) {
      parts.push(`Tasks raw output preview: ${normalizeWhitespace(sources.tasks.raw).slice(0, 200)}`);
    }
  }

  if (!sources.sessions.ok) {
    parts.push('', `Sessions runtime source unavailable: ${sources.sessions.reason}`);
    if (sources.sessions.raw) {
      parts.push(`Sessions raw output preview: ${normalizeWhitespace(sources.sessions.raw).slice(0, 200)}`);
    }
  }

  return parts.join('\n');
}

/**
 * Generate PROCESS_STATE.md from PROCESS_STATE.json.
 * Reads the JSON file at jsonPath and writes a human-readable MD file to mdPath.
 * The generated file starts with an auto-generated header comment.
 *
 * @param {string} jsonPath - Absolute path to PROCESS_STATE.json
 * @param {string} mdPath   - Absolute path to PROCESS_STATE.md (will be overwritten)
 */
function generateProcessStateMd(jsonPath, mdPath) {
  let json = {};
  try {
    if (fs.existsSync(jsonPath)) {
      json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
  } catch {
    /* if JSON is unreadable, generate from empty state */
  }

  const initiative = json.initiative || 'unknown';
  const stage = json.stage || 'unknown';
  const wave = json.wave != null ? String(json.wave) : 'unknown';
  const waveSession = json.wave_session != null ? String(json.wave_session) : null;
  const stageOwner = json.stage_owner || 'main_agent';
  const blocker = json.blocker || null;
  const nextAction = json.next_action || null;
  const lastUpdated = json.last_updated || new Date().toISOString().slice(0, 10);
  const activeSlices = Array.isArray(json.active_slices) ? json.active_slices : [];

  const lines = [
    '<!-- auto-generated — do not edit manually -->',
    '# PROCESS_STATE',
    '',
    '## Current initiative',
    initiative,
    '',
    '## Current loop stage',
    stage,
    '',
    '## Wave',
    wave,
    ...(waveSession !== null ? ['', '## Wave session', waveSession] : []),
    '',
    '## Stage owner',
    stageOwner,
    '',
    '## Active slices',
  ];

  if (activeSlices.length > 0) {
    for (const slice of activeSlices) {
      const id = typeof slice === 'string' ? slice : (slice && slice.id) || null;
      const title = slice && typeof slice === 'object' && slice.title ? ` — ${slice.title}` : '';
      if (id) lines.push(`- ${id}${title}`);
    }
  } else {
    lines.push('- none');
  }

  lines.push('');
  lines.push('## Current blockers');
  lines.push(blocker ? `- ${blocker}` : '- none');

  lines.push('');
  lines.push('## Next expected handoff');
  lines.push(nextAction ? `- ${nextAction}` : '- none');

  lines.push('');
  lines.push('## Last update');
  lines.push(lastUpdated);
  lines.push('');

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
}

/**
 * Archive the active wave heading in BACKLOG.md at wave-close time.
 *
 * Renames: `## Active Wave — Wave N` → `## Wave N — Archived`
 *
 * If more than one `## Active Wave` heading is found, prints a warning to
 * stderr listing the line numbers and returns without modifying the file —
 * the caller should inspect and repair manually.
 *
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {number|string} waveNumber - The wave number that is being closed (e.g. 9)
 * @returns {{ ok: boolean, archived: boolean, warning: string|null }}
 */
function archiveActiveWaveInBacklog(backlogPath, waveNumber) {
  const content = fs.readFileSync(backlogPath, 'utf8');
  const lines = content.split(/\r?\n/);

  // Find all lines matching ## Active Wave (case-insensitive)
  const activeWaveLineNumbers = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Active Wave/i.test(lines[i])) {
      activeWaveLineNumbers.push(i + 1); // 1-based for display
    }
  }

  if (activeWaveLineNumbers.length === 0) {
    return { ok: true, archived: false, warning: 'No ## Active Wave heading found in BACKLOG.md — nothing to archive.' };
  }

  if (activeWaveLineNumbers.length > 1) {
    const warning =
      `Multiple ## Active Wave headings detected in BACKLOG.md at line(s): ${activeWaveLineNumbers.join(', ')}.\n` +
      'Repair required: manually archive older Active Wave sections before closing the current wave.\n' +
      'Rename each stale heading from `## Active Wave — Wave N` to `## Wave N — Archived`.';
    return { ok: false, archived: false, warning };
  }

  // Exactly one Active Wave heading — rename it
  const waveN = String(waveNumber);
  let matched = false;
  const updated = lines.map((line) => {
    // Match the exact wave number or any Active Wave heading with a wave number
    if (/^##\s+Active Wave/i.test(line)) {
      // Extract the wave number from the heading if present; fall back to provided waveNumber
      const waveMatch = line.match(/Wave\s+(\d+)/i);
      const headingWaveN = waveMatch ? waveMatch[1] : waveN;
      matched = true;
      return `## Wave ${headingWaveN} — Archived`;
    }
    return line;
  });

  if (!matched) {
    return { ok: true, archived: false, warning: null };
  }

  // After renaming the old "## Active Wave" to "## Wave N — Archived", insert a fresh
  // empty "## Active Wave" heading immediately before the newly-archived heading so that
  // subsequent --new-task / --apply-decomposition calls have a valid insertion point.
  const archivedHeading = `## Wave ${String(waveNumber)} — Archived`;
  // Find the index of the archived heading in `updated`
  let archivedIdx = updated.findIndex((l) => l === archivedHeading);
  // Fall back: find any "## Wave N — Archived" line (in case heading wave number differed)
  if (archivedIdx === -1) {
    archivedIdx = updated.findIndex((l) => /^## Wave \d+ — Archived/.test(l));
  }
  if (archivedIdx !== -1) {
    // Remove any trailing blank lines immediately before the archived heading so we can
    // insert with controlled spacing: one blank line before "## Active Wave" and one after.
    let insertAt = archivedIdx;
    while (insertAt > 0 && updated[insertAt - 1].trim() === '') {
      insertAt--;
    }
    updated.splice(insertAt, 0, '## Active Wave', '');
  }

  fs.writeFileSync(backlogPath, updated.join('\n'), 'utf8');
  return { ok: true, archived: true, warning: null };
}

/**
 * T-361: parse the `## Active Wave` section of BACKLOG.md and return the
 * titles of tasks whose Status has reached a merged/deployed terminal state.
 *
 * Scoping the scan to the Active Wave section (rather than TASK_STATUS.md's
 * ever-growing `## Recently completed tasks` section, which accumulates every
 * wave back to Wave 1) is what makes the resulting wave_summary describe only
 * the wave being closed instead of concatenating every prior wave's titles.
 * Must run before `archiveActiveWaveInBacklog` renames the heading away.
 *
 * @param {string} backlogMarkdown - full contents of BACKLOG.md
 * @returns {string[]} titles of merged/deployed tasks in the Active Wave section, in document order
 */
function parseActiveWaveMergedTitles(backlogMarkdown) {
  const lines = backlogMarkdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active Wave/i.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section
    .split(/\n(?=###\s+T-\d+)/)
    .map((b) => b.trim())
    .filter((b) => /^###\s+T-\d+/.test(b));

  const terminalStatuses = new Set(['merged', 'deployed_dev', 'deployed_prod']);
  const titles = [];
  for (const block of blocks) {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^-\s+\*\*Status:\*\*\s+(.+)$/m);
    if (headingMatch && statusMatch && terminalStatuses.has(statusMatch[1].trim())) {
      titles.push(headingMatch[2]?.trim() || headingMatch[1]);
    }
  }
  return titles;
}

/**
 * Atomically rename a task heading in both BACKLOG.md and TASK_STATUS.md.
 *
 * Finds lines matching `### T-NNN — <any title>` and replaces the title
 * portion with newTitle. Works regardless of task status (planned, merged,
 * archived wave, etc.) to keep all occurrences consistent.
 *
 * @param {string} taskId   - Task ID in T-NNN format (e.g. "T-167")
 * @param {string} newTitle - New canonical title string
 * @param {string} backlogPath      - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath   - Absolute path to TASK_STATUS.md
 * @returns {{ ok: boolean, error?: string, backlogChanged: boolean, taskStatusChanged: boolean }}
 */
function renameTask(taskId, newTitle, backlogPath, taskStatusPath) {
  if (!taskId || !/^T-\d+$/.test(taskId)) {
    return { ok: false, error: `Invalid task ID format: "${taskId}". Expected T-NNN.`, backlogChanged: false, taskStatusChanged: false };
  }
  if (!newTitle || !newTitle.trim()) {
    return { ok: false, error: 'New title must not be empty.', backlogChanged: false, taskStatusChanged: false };
  }

  const escapedId = taskId.replace('-', '\\-');
  const headingPattern = new RegExp(`^(###\\s+${escapedId}\\s+—\\s+)(.+)$`, 'gm');

  let backlogChanged = false;
  let taskStatusChanged = false;
  let foundInBacklog = false;
  let foundInTaskStatus = false;

  // Process BACKLOG.md
  if (!fs.existsSync(backlogPath)) {
    return { ok: false, error: `BACKLOG.md not found at ${backlogPath}`, backlogChanged: false, taskStatusChanged: false };
  }
  const backlogContent = fs.readFileSync(backlogPath, 'utf8');
  foundInBacklog = headingPattern.test(backlogContent);
  headingPattern.lastIndex = 0; // reset after test()

  // Process TASK_STATUS.md
  if (!fs.existsSync(taskStatusPath)) {
    return { ok: false, error: `TASK_STATUS.md not found at ${taskStatusPath}`, backlogChanged: false, taskStatusChanged: false };
  }
  const taskStatusContent = fs.readFileSync(taskStatusPath, 'utf8');
  foundInTaskStatus = headingPattern.test(taskStatusContent);
  headingPattern.lastIndex = 0;

  if (!foundInBacklog && !foundInTaskStatus) {
    return { ok: false, error: `${taskId} not found in BACKLOG.md or TASK_STATUS.md.`, backlogChanged: false, taskStatusChanged: false };
  }

  const trimmedTitle = newTitle.trim();

  if (foundInBacklog) {
    const updated = backlogContent.replace(headingPattern, `$1${trimmedTitle}`);
    if (updated !== backlogContent) {
      fs.writeFileSync(backlogPath, updated, 'utf8');
      backlogChanged = true;
    }
  }

  if (foundInTaskStatus) {
    const updated = taskStatusContent.replace(headingPattern, `$1${trimmedTitle}`);
    if (updated !== taskStatusContent) {
      fs.writeFileSync(taskStatusPath, updated, 'utf8');
      taskStatusChanged = true;
    }
  }

  return { ok: true, backlogChanged, taskStatusChanged };
}

/**
 * Parse all task blocks from a TASK_STATUS.md or BACKLOG.md string.
 * Splits on `### T-NNN` headings and returns an array of raw block strings.
 *
 * @param {string} markdown - Raw file content
 * @returns {string[]} Array of raw task block strings (each starts with ### T-NNN)
 */
function parseAllTaskBlocks(markdown) {
  return markdown
    .split(/\n(?=###\s+T-\d+)/)
    .map((block) => block.trim())
    .filter((block) => /^###\s+T-\d+/.test(block));
}

/**
 * Extract trajectory records for a given role from TASK_STATUS.md and BACKLOG.md.
 *
 * Reads all merged tasks where the Owner role matches the given role, and emits
 * one trajectory record per matching task using evidence text heuristics.
 *
 * @param {string} role - Role name to filter by (e.g. "developer")
 * @param {object} [options]
 * @param {string} [options.taskStatusPath] - Override path to TASK_STATUS.md
 * @param {string} [options.backlogPath] - Override path to BACKLOG.md
 * @param {string} [options.executionLogPath] - Override path to EXECUTION_LOG.md (reserved for future use)
 * @returns {Array<{taskId:string,role:string,status:string,needsFixCount:number,validatorExitCode:number,qaOutcome:string,evidenceFlags:string[],toolUses:(number|undefined)}>}
 */
function extractTrajectories(role, options = {}) {
  const taskStatusPath = options.taskStatusPath || TASK_STATUS_PATH;
  const backlogPath = options.backlogPath || BACKLOG_PATH;

  const taskStatusContent = fs.existsSync(taskStatusPath) ? readUtf8(taskStatusPath) : '';
  const backlogContent = fs.existsSync(backlogPath) ? readUtf8(backlogPath) : '';

  // Build a map of taskId -> backlog metadata (verification_type, owner role)
  const backlogBlocks = parseAllTaskBlocks(backlogContent);
  const backlogMeta = new Map();
  for (const block of backlogBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];
    const verTypeMatch = block.match(/[-*]\s+\*\*Verification type:\*\*\s+(.+)/i);
    const ownerMatch = block.match(/[-*]\s+\*\*Owner role:\*\*\s+(.+)/i);
    backlogMeta.set(taskId, {
      verificationType: verTypeMatch ? normalizeWhitespace(verTypeMatch[1]) : '',
      ownerRole: ownerMatch ? normalizeWhitespace(ownerMatch[1]) : '',
    });
  }

  // Parse all task blocks from TASK_STATUS.md
  const statusBlocks = parseAllTaskBlocks(taskStatusContent);
  const trajectories = [];

  for (const block of statusBlocks) {
    const idMatch = block.match(/^###\s+(T-\d+)\s+/);
    if (!idMatch) continue;
    const taskId = idMatch[1];

    // Check status is a terminal-success state
    const DONE = new Set(['merged', 'deployed_dev', 'deployed_prod']);
    const statusMatch = block.match(/[-*]\s+\*\*Status:\*\*\s+(\S+)/i);
    if (!statusMatch) continue;
    const status = normalizeWhitespace(statusMatch[1]);
    if (!DONE.has(status)) continue;

    // Check owner role -- try both "Owner role:" and "Owner:" fields
    const ownerRoleMatch = block.match(/[-*]\s+\*\*Owner role:\*\*\s+(.+)/i);
    const ownerFallbackMatch = block.match(/[-*]\s+\*\*Owner:\*\*\s+(.+)/i);
    const ownerRole = normalizeWhitespace(
      (ownerRoleMatch && ownerRoleMatch[1]) || (ownerFallbackMatch && ownerFallbackMatch[1]) || ''
    );

    // Fall back to backlog metadata if not in TASK_STATUS block
    const meta = backlogMeta.get(taskId) || {};
    const effectiveOwnerRole = ownerRole || meta.ownerRole || '';
    if (effectiveOwnerRole !== role) continue;

    // Extract evidence block (everything after "**Evidence:**" on that line)
    const evidenceLineMatch = block.match(/[-*]\s+\*\*Evidence:\*\*\s+([\s\S]*?)(?=\n[-*]\s+\*\*|\n###|\s*$)/i);
    const evidenceText = evidenceLineMatch ? evidenceLineMatch[1] : '';
    const evidenceLower = evidenceText.toLowerCase();

    // Determine verification_type (from TASK_STATUS block or backlog)
    const verTypeBlockMatch = block.match(/[-*]\s+\*\*Verification type:\*\*\s+(.+)/i);
    const verificationType = verTypeBlockMatch
      ? normalizeWhitespace(verTypeBlockMatch[1])
      : meta.verificationType || '';

    // --- needsFixCount: explicit field overrides heuristic ---
    const explicitFixRoundsMatch = evidenceText.match(/needs_fix_rounds:\s*(\d+)/i);
    let needsFixCount;
    if (explicitFixRoundsMatch) {
      // explicit field overrides heuristic
      needsFixCount = parseInt(explicitFixRoundsMatch[1], 10);
    } else {
      // Fall back to keyword heuristic
      const needsFixMatches = evidenceLower.match(/needs[_\s]fix/g) || [];
      needsFixCount = needsFixMatches.length;
    }

    // --- validatorExitCode: explicit field overrides heuristic ---
    const explicitValidatorBlockedMatch = evidenceText.match(/validator_blocked:\s*(true|false)/i);
    let validatorExitCode;
    if (explicitValidatorBlockedMatch) {
      // explicit field overrides heuristic
      validatorExitCode = explicitValidatorBlockedMatch[1].toLowerCase() === 'true' ? 2 : 0;
    } else {
      // Fall back to keyword heuristic
      validatorExitCode = /exit code 2|validator exit 2/.test(evidenceLower) ? 2 : 0;
    }

    // --- qaOutcome heuristic ---
    let qaOutcome;
    if (verificationType === 'artifact') {
      qaOutcome = 'skipped';
    } else if (/qa_passed|passed/.test(evidenceLower)) {
      qaOutcome = 'passed';
    } else if (/failed|qa_failed/.test(evidenceLower)) {
      qaOutcome = 'failed';
    } else {
      qaOutcome = 'skipped';
    }

    // Apply needsFixCount adjustment: subtract 1 if outcome is passed and there were needs_fix mentions
    // (the last needs_fix loop resolves into a pass). Skip when explicit field was used — the
    // author-supplied value is already the final count and needs no heuristic correction.
    if (!explicitFixRoundsMatch && qaOutcome === 'passed' && needsFixCount > 0) {
      needsFixCount = Math.max(0, needsFixCount - 1);
    }

    // --- evidenceFlags heuristic ---
    const evidenceFlags = [];
    if (/outside scope/.test(evidenceLower)) evidenceFlags.push('scope_deviation');
    if (/skipped commit/.test(evidenceLower)) evidenceFlags.push('skipped_commit');
    if (/missing commit/.test(evidenceLower)) evidenceFlags.push('missing_commit');
    if (/error/.test(evidenceText)) evidenceFlags.push('evidence_error');

    // --- toolUses: optional explicit field, additive (no fallback heuristic) ---
    // Recorded by the Main Agent at task completion as `tool_uses: <N>` in the
    // evidence block (value sourced from the task-completion notification's
    // tool_uses count). Absent on older/other records — omitted, not defaulted.
    const toolUsesMatch = evidenceText.match(/tool_uses:\s*(\d+)/i);

    const record = {
      taskId,
      role,
      status,
      needsFixCount,
      validatorExitCode,
      qaOutcome,
      evidenceFlags,
    };
    if (toolUsesMatch) {
      record.toolUses = parseInt(toolUsesMatch[1], 10);
    }

    trajectories.push(record);
  }

  return trajectories;
}

/**
 * Write trajectory records to `.mavp/trajectories/<role>.jsonl`.
 * Creates the output directory if it does not exist. Overwrites existing file
 * (rewrite-not-append is intentional — each run produces a canonical snapshot).
 *
 * Deduplication: records with a `taskId` field are collapsed to one record per
 * taskId using last-wins semantics. Records missing `taskId` are preserved
 * as-is to avoid silent data loss.
 *
 * @param {string} role - Role name (used as filename stem)
 * @param {Array} trajectories - Array of trajectory objects from extractTrajectories()
 * @param {object} [options]
 * @param {string} [options.outputDir] - Override default .mavp/trajectories/ directory
 */
function writeTrajectories(role, trajectories, options = {}) {
  const outputDir = options.outputDir || path.join(ROOT, '.mavp', 'trajectories');
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${role}.jsonl`);

  // Deduplicate: last-wins per taskId; records without taskId pass through unchanged.
  const seenIds = new Map();
  const noIdRecords = [];
  for (const t of trajectories) {
    if (t.taskId !== undefined && t.taskId !== null) {
      seenIds.set(t.taskId, t);
    } else {
      noIdRecords.push(t);
    }
  }
  const deduped = [...seenIds.values(), ...noIdRecords];

  // Rewrite (not append) — produces a canonical snapshot on every run.
  const lines = deduped.map((t) => JSON.stringify(t)).join('\n');
  fs.writeFileSync(filePath, lines ? lines + '\n' : '', 'utf8');
}

/**
 * Returns a score in [0.0, 1.0] for a trajectory record.
 * Higher = better agent performance on this task.
 *
 * Formula:
 *   base:
 *     qaOutcome === "passed"  → 1.0
 *     qaOutcome === "skipped" → 0.8  (artifact/runtime tasks that skip QA agent)
 *     qaOutcome === "failed"  → 0.0
 *
 *   penalties (applied after base):
 *     − 0.1 × max(0, needsFixCount − 1)
 *     − 0.2 if validatorExitCode === 2
 *     − 0.1 × evidenceFlags.length
 *
 *   result = clamp(base − penalties, 0.0, 1.0)
 */
function scoreTrajectory(trajectory) {
  const { qaOutcome, needsFixCount, validatorExitCode, evidenceFlags } = trajectory;

  let base;
  if (qaOutcome === 'passed') {
    base = 1.0;
  } else if (qaOutcome === 'skipped') {
    base = 0.8;
  } else {
    base = 0.0;
  }

  const penaltyNeedsFix = 0.1 * Math.max(0, needsFixCount - 1);
  const penaltyValidator = validatorExitCode === 2 ? 0.2 : 0;
  const penaltyFlags = 0.1 * (evidenceFlags ? evidenceFlags.length : 0);

  const raw = base - penaltyNeedsFix - penaltyValidator - penaltyFlags;
  const score = Math.round(raw * 1e10) / 1e10;
  return Math.max(0, Math.min(1, score));
}

/**
 * Summarize trajectory records from .mavp/trajectories/*.jsonl per role.
 *
 * @param {{ dir: string }} options - dir is the absolute path to the trajectories directory
 * @returns {Array<{role:string, count:number, successCount:number, successPct:number, blockedCount:number, needsFixCount:number}>}
 */
function summarizeTrajectories({ dir }) {
  if (!fs.existsSync(dir)) return [];

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const roleMap = {};

  for (const file of files) {
    const role = file.slice(0, -6); // strip .jsonl
    const filePath = path.join(dir, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!roleMap[role]) {
        roleMap[role] = { role, count: 0, successCount: 0, blockedCount: 0, needsFixCount: 0 };
      }

      const entry = roleMap[role];
      entry.count++;

      const score = scoreTrajectory(record);
      if (score >= 0.7) entry.successCount++;

      if (record.validatorExitCode === 2 || record.validator_blocked === true) entry.blockedCount++;
      if (record.needsFixCount > 0) entry.needsFixCount++;
    }
  }

  return Object.values(roleMap).map((entry) => ({
    ...entry,
    successPct: entry.count > 0 ? Math.round((entry.successCount / entry.count) * 100) : 0,
  }));
}

/**
 * Parse all tasks from TASK_STATUS.md and BACKLOG.md into a minimal shape for
 * deploy-pending detection.  Reads from the "Active tasks" section in
 * TASK_STATUS.md; enriches repo from BACKLOG.md when not already present in
 * the TASK_STATUS block.
 *
 * @param {string} taskStatusMarkdown - Content of TASK_STATUS.md
 * @param {string} backlogMarkdown    - Content of BACKLOG.md
 * @returns {Array<{id:string,title:string,status:string,repo:string|null}>}
 */
function parseTasksWithRepo(taskStatusMarkdown, backlogMarkdown) {
  const lines = taskStatusMarkdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Active tasks/.test(l));
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }

  const section = lines.slice(start + 1, end).join('\n');
  const blocks = section.split(/\n(?=###\s+T-)/).map((b) => b.trim()).filter(Boolean);

  // Build repo map from BACKLOG.md
  const backlogRepoMap = {};
  if (backlogMarkdown) {
    const bblocks = backlogMarkdown.split(/\n(?=###\s+T-)/).filter(Boolean);
    for (const block of bblocks) {
      const idMatch = block.match(/^###\s+(T-\d+)/m);
      if (!idMatch) continue;
      const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
      if (repoMatch) backlogRepoMap[idMatch[1]] = repoMatch[1].trim();
    }
  }

  return blocks.map((block) => {
    const headingMatch = block.match(/^###\s+(T-\d+)\s+—\s+(.+)$/m);
    const statusMatch = block.match(/^- \*\*Status:\*\*\s+(.+)$/m);
    const repoMatch = block.match(/^- \*\*Repos?:\*\*\s+(.+)$/m);
    const id = headingMatch ? headingMatch[1] : null;
    if (!id) return null;
    const repo = repoMatch
      ? repoMatch[1].trim()
      : (backlogRepoMap[id] || null);
    return {
      id,
      title: headingMatch ? headingMatch[2].trim() : 'unknown',
      status: statusMatch ? statusMatch[1].trim() : 'unknown',
      repo,
    };
  }).filter(Boolean);
}

/**
 * Build the full deploy queue for --agent output.  Mirrors the inline logic
 * previously in mavp-operator-agent.js so it can be shared without behaviour change.
 *
 * When deployContours <= 1 the queue is always empty.  Otherwise returns all
 * tasks with status 'merged' or a deployed status, enriched with deploy_pending
 * and prod_prerequisites fields.
 *
 * @param {Array<{id:string,title:string,status:string}>} activeTasks
 *   All tasks from the TASK_STATUS.md Active tasks section.
 * @param {Object<string,{prodPrerequisites:string[]}>} backlogMeta
 *   Per-task metadata from BACKLOG.md (prodPrerequisites list).
 * @param {number} deployContours
 *   Value of deploy_contours from PROCESS_STATE.json (default 2).
 * @returns {Array<{id:string,title:string,status:string,deploy_pending?:boolean,prod_prerequisites?:string[]}>}
 */
function buildDeployQueue(activeTasks, backlogMeta, deployContours) {
  const deployedStatuses = new Set(['deployed_dev', 'deployed_prod']);
  if (deployContours <= 1) return [];
  return activeTasks
    .filter((t) => t.status === 'merged' || deployedStatuses.has(t.status))
    .map((t) => {
      const bm = backlogMeta[t.id] || {};
      const prodPrerequisites = bm.prodPrerequisites || [];
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        ...(t.status === 'merged' ? { deploy_pending: true } : {}),
        ...(prodPrerequisites.length > 0 ? { prod_prerequisites: prodPrerequisites } : {}),
      };
    });
}

/**
 * Return tasks that are deploy_pending (status === 'merged', deploy_contours > 1)
 * for a given repo name.  Matches repo by exact string or comma-separated list
 * entry.  Returns an empty array when deployContours <= 1 (no deploy pipeline)
 * or when repoName is absent / a placeholder.
 *
 * @param {Array<{id:string,title:string,status:string,repo:string|null}>} tasks
 * @param {string|null} repoName     - Repo name entered by the user (e.g. "example-service")
 * @param {number} deployContours    - Value of deploy_contours from PROCESS_STATE.json (default 2)
 * @returns {Array<{id:string,title:string,status:string,repo:string|null}>}
 */
function getDeployPendingForRepo(tasks, repoName, deployContours) {
  if (deployContours <= 1) return [];
  if (!repoName || repoName === 'TBD' || repoName === '—') return [];
  const name = repoName.trim();
  return tasks.filter((t) => {
    if (t.status !== 'merged') return false;
    if (!t.repo) return false;
    const repos = t.repo.split(',').map((r) => r.trim());
    return repos.includes(name);
  });
}

/*
 * scoreTrajectory examples:
 *   { qaOutcome:'passed',  needsFixCount:0, validatorExitCode:0, evidenceFlags:[] }   → 1.0
 *   { qaOutcome:'passed',  needsFixCount:2, validatorExitCode:0, evidenceFlags:[] }   → 0.9
 *   { qaOutcome:'skipped', needsFixCount:0, validatorExitCode:0, evidenceFlags:[] }   → 0.8
 *   { qaOutcome:'skipped', needsFixCount:0, validatorExitCode:2, evidenceFlags:['scope_deviation'] } → 0.5
 *   { qaOutcome:'failed',  needsFixCount:0, validatorExitCode:2, evidenceFlags:[] }   → 0.0
 */

/**
 * Compute due and overdue recheck entries relative to a given date.
 *
 * Each entry in the rechecks[] registry (from PROCESS_STATE.json) has the shape:
 *   {
 *     id:        string    — e.g. "RC-1"
 *     task:      string    — e.g. "T-123" (reference to the completed task)
 *     title:     string    — self-contained title (survives task archival)
 *     due:       string    — YYYY-MM-DD absolute due date
 *     interval?: string    — optional repeat interval, e.g. "8w" (used by --ack-recheck --rearm)
 *     armed_at:  string    — YYYY-MM-DD when the recheck was registered
 *     note?:     string    — optional free-text note
 *   }
 *
 * Return shape:
 *   {
 *     due:     RecheckEntry[]  — entries where due === today (due today, not yet overdue)
 *     overdue: RecheckEntry[]  — entries where due < today (past due date)
 *   }
 *
 * Rules:
 *   - Future entries (due > today) are excluded from both arrays.
 *   - Entries with a missing or malformed `due` field are silently skipped (no throw).
 *   - An undefined / null / non-array `rechecks` argument yields { due: [], overdue: [] }.
 *
 * @param {Array|undefined|null} rechecks - Array of recheck entry objects from PROCESS_STATE.json
 * @param {string} today - Current date as YYYY-MM-DD string (passed explicitly for testability)
 * @returns {{ due: Array, overdue: Array }}
 */
function computeDueRechecks(rechecks, today) {
  const result = { due: [], overdue: [] };

  if (!Array.isArray(rechecks) || !rechecks.length) return result;
  if (!today || typeof today !== 'string') return result;

  for (const entry of rechecks) {
    // Tolerate non-object entries silently
    if (!entry || typeof entry !== 'object') continue;

    const due = entry.due;

    // Validate: must be a non-empty YYYY-MM-DD string
    if (!due || typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;

    // String comparison works correctly for YYYY-MM-DD
    if (due < today) {
      result.overdue.push(entry);
    } else if (due === today) {
      result.due.push(entry);
    }
    // due > today → future, excluded
  }

  return result;
}

/**
 * Look up a task title from BACKLOG.md or TASK_STATUS.md.
 * Scans for a heading matching "### T-NNN — <title>" and returns the title portion.
 * Returns null if the task is not found in either file.
 *
 * @param {string} taskId - Task ID in T-NNN format
 * @param {string} backlogPath - Absolute path to BACKLOG.md
 * @param {string} taskStatusPath - Absolute path to TASK_STATUS.md
 * @returns {string|null}
 */
function lookupTaskTitle(taskId, backlogPath, taskStatusPath) {
  const pattern = new RegExp(`^###\\s+${taskId}\\s+—\\s+(.+)$`, 'm');
  for (const filePath of [backlogPath, taskStatusPath]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(pattern);
      if (match) return match[1].trim();
    } catch {
      // ignore read errors — fall through to next file
    }
  }
  return null;
}

/**
 * Parse an interval string like "8w", "2d", "4weeks", "30days" into a number of days.
 * Supported units: d / day / days, w / week / weeks.
 * Returns null for unrecognised formats.
 *
 * @param {string} interval - Interval string, e.g. "8w"
 * @returns {number|null} Number of days, or null if unrecognised
 */
function parseIntervalDays(interval) {
  if (!interval || typeof interval !== 'string') return null;
  const m = interval.trim().match(/^(\d+)\s*(d|day|days|w|week|weeks)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'd' || unit === 'day' || unit === 'days') return n;
  // weeks
  return n * 7;
}

/**
 * Add days to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Uses UTC arithmetic to avoid DST shifts.
 *
 * @param {string} dateStr - YYYY-MM-DD base date
 * @param {number} days - Number of days to add
 * @returns {string} YYYY-MM-DD result
 */
function addDays(dateStr, days) {
  const ms = Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10),
  );
  const result = new Date(ms + days * 86400000);
  return result.toISOString().slice(0, 10);
}

/**
 * Arm a new recheck entry and persist it to PROCESS_STATE.json.
 *
 * Generates the next RC-N id by scanning the existing rechecks[] array.
 * Looks up the task title from BACKLOG.md / TASK_STATUS.md for a self-contained entry.
 * Falls back to the task id as title if not found.
 *
 * @param {object} opts
 * @param {string} opts.taskId       - Task ID, e.g. "T-123"
 * @param {string} opts.due          - Due date, YYYY-MM-DD
 * @param {string} [opts.interval]   - Repeat interval, e.g. "8w"
 * @param {string} [opts.note]       - Optional free-text note
 * @param {string} opts.today        - Today's date, YYYY-MM-DD (for armed_at)
 * @param {string} opts.processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @param {string} opts.backlogPath          - Absolute path to BACKLOG.md
 * @param {string} opts.taskStatusPath       - Absolute path to TASK_STATUS.md
 * @returns {{ id: string, entry: object }} The new RC-N id and the full entry object
 * @throws {Error} If PROCESS_STATE.json cannot be read/written, or due is invalid
 */
function armRecheck(opts) {
  const { taskId, due, interval, note, today, processStateJsonPath, backlogPath, taskStatusPath } = opts;

  // Validate due date format
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new Error(`Invalid --due value: "${due}". Expected YYYY-MM-DD.`);
  }

  // Validate interval if provided
  if (interval !== undefined && interval !== null && interval !== '') {
    if (parseIntervalDays(interval) === null) {
      throw new Error(`Invalid --interval value: "${interval}". Expected e.g. "8w", "2d", "4weeks".`);
    }
  }

  // Read existing state
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read PROCESS_STATE.json: ${err.message}`);
  }

  if (!Array.isArray(state.rechecks)) {
    state.rechecks = [];
  }

  // Generate next RC-N id
  let maxN = 0;
  for (const entry of state.rechecks) {
    if (entry && typeof entry.id === 'string') {
      const m = entry.id.match(/^RC-(\d+)$/);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
  }
  const newId = `RC-${maxN + 1}`;

  // Look up task title
  const foundTitle = lookupTaskTitle(taskId, backlogPath, taskStatusPath);
  const title = foundTitle || taskId;

  // Build entry
  const entry = {
    id: newId,
    task: taskId,
    title,
    due,
    armed_at: today,
  };
  if (interval) entry.interval = interval;
  if (note) entry.note = note;

  // Append and write
  state.rechecks.push(entry);
  state.last_updated = today;

  try {
    fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
  }

  return { id: newId, entry };
}

/**
 * Acknowledge (and optionally re-arm) a recheck entry in PROCESS_STATE.json.
 *
 * Without --rearm: removes the entry from rechecks[].
 * With --rearm: instead of removing, sets due = today + interval (in days).
 *   If --rearm is given but the entry has no interval, throws a clear error.
 *
 * @param {object} opts
 * @param {string} opts.recheckId    - Recheck ID, e.g. "RC-1"
 * @param {boolean} opts.rearm       - If true, reschedule instead of removing
 * @param {string} opts.today        - Today's date, YYYY-MM-DD
 * @param {string} opts.processStateJsonPath - Absolute path to PROCESS_STATE.json
 * @returns {{ removed: boolean, rearmed: boolean, newDue?: string, entry: object }}
 * @throws {Error} If the recheck ID is not found, or --rearm without interval
 */
function ackRecheck(opts) {
  const { recheckId, rearm, today, processStateJsonPath } = opts;

  // Validate recheckId format
  if (!recheckId || !/^RC-\d+$/.test(recheckId)) {
    throw new Error(`Invalid recheck ID: "${recheckId}". Expected format RC-N (e.g. RC-1).`);
  }

  // Read existing state
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(processStateJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read PROCESS_STATE.json: ${err.message}`);
  }

  if (!Array.isArray(state.rechecks)) {
    throw new Error(`No rechecks[] array in PROCESS_STATE.json. "${recheckId}" not found.`);
  }

  const idx = state.rechecks.findIndex((e) => e && e.id === recheckId);
  if (idx === -1) {
    throw new Error(`Recheck "${recheckId}" not found in rechecks[].`);
  }

  const entry = state.rechecks[idx];

  if (rearm) {
    // Validate interval exists and is parseable
    if (!entry.interval) {
      throw new Error(
        `Cannot --rearm "${recheckId}": entry has no interval. ` +
          `Set an interval when arming (--interval 8w) to enable rearming.`
      );
    }
    const days = parseIntervalDays(entry.interval);
    if (days === null) {
      throw new Error(
        `Cannot --rearm "${recheckId}": interval "${entry.interval}" could not be parsed. ` +
          `Expected e.g. "8w", "2d".`
      );
    }
    const newDue = addDays(today, days);
    entry.due = newDue;
    entry.armed_at = today;
    state.last_updated = today;

    try {
      fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (err) {
      throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
    }

    return { removed: false, rearmed: true, newDue, entry };
  }

  // Remove the entry
  state.rechecks.splice(idx, 1);
  state.last_updated = today;

  try {
    fs.writeFileSync(processStateJsonPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`Cannot write PROCESS_STATE.json: ${err.message}`);
  }

  return { removed: true, rearmed: false, entry };
}

/**
 * Resolve the configured Claude Code permission mode for a project root.
 * Read-only — performs no writes.
 *
 * Resolution order mirrors Claude Code's own settings precedence:
 *   1. <root>/.claude/settings.local.json — permissions.defaultMode
 *   2. <root>/.claude/settings.json       — permissions.defaultMode
 *   3. "default" — when neither file exists, is malformed, or sets no mode
 *
 * @param {string} root - Absolute path to the project root.
 * @returns {string} The resolved permission mode (e.g. "acceptEdits", "plan", "default").
 */
function readPermissionMode(root) {
  const candidates = [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(content);
      const mode = parsed && parsed.permissions && parsed.permissions.defaultMode;
      if (typeof mode === 'string' && mode.length > 0) {
        return mode;
      }
    } catch (err) {
      // Missing file or malformed JSON — treat as absent, try next candidate.
    }
  }
  return 'default';
}

/**
 * Read the persisted runtime permission_mode written by the SessionStart hook
 * (see mavp-operator-agent.js — readStdinPermissionModeOverride / persistence).
 * Read-only — performs no writes.
 *
 * @param {string} root - Absolute path to the project root.
 * @returns {string|null} The trimmed persisted mode, or null when the state
 *   file is absent, empty, or unreadable.
 */
function readPersistedPermissionMode(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.mavp', 'permission-mode'), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Classify a next_action string as a routing directive vs. freeform prose that
 * may have copied volatile facts (framework version, unpushed-commit counts) with
 * no invalidation trigger. This is a SHAPE check only — it does not fact-check
 * prose against any external source (git, mavp-version.js, etc).
 *
 * - directive: true when the (trimmed) string begins with a `T-\d+` routing
 *   directive, or when the value is empty/null. false otherwise (freeform prose).
 * - volatile_facts: substrings matched by conservative patterns only — semver
 *   (`v1.2.3`/`1.2.3`) and commit-count phrases (`14 commits`, `14 unpushed commits`,
 *   `ahead 14`). Deduplicated. Empty array when nothing matches.
 *
 * @param {string|null|undefined} str - The next_action value to classify.
 * @returns {{ directive: boolean, volatile_facts: string[] }}
 */
function classifyNextAction(str) {
  const trimmed = typeof str === 'string' ? str.trim() : '';
  if (trimmed.length === 0) {
    return { directive: true, volatile_facts: [] };
  }

  const directive = /^T-\d+/.test(trimmed);

  const patterns = [
    /\bv?\d+\.\d+\.\d+\b/g,
    /\b\d+\s+(?:unpushed\s+)?commits?\b/gi,
    /\bahead\s+\d+\b/gi,
  ];

  const seen = new Set();
  const volatile_facts = [];
  for (const pattern of patterns) {
    const matches = trimmed.match(pattern) || [];
    for (const match of matches) {
      if (!seen.has(match)) {
        seen.add(match);
        volatile_facts.push(match);
      }
    }
  }

  return { directive, volatile_facts };
}

/**
 * Resolve the path to docs/REPO_MAP.md for the current context.
 * Mirrors resolveModulesPath() in mavp-validator.js — respects
 * MAVERICKS_PROJECT_ROOT (via the ROOT constant above) when running against a
 * bootstrapped project, falling back to the mavericks repo root in self-mode.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string|null} Absolute path to docs/REPO_MAP.md, or null if absent.
 */
function resolveRepoMapPath(root) {
  const base = root || ROOT;
  const p = path.join(base, 'docs', 'REPO_MAP.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse the repo-map registry from docs/REPO_MAP.md.
 * Same project-owns-instance pattern as parseModuleRegistry() (mavp-operator-agent.js)
 * for docs/MODULES.md — the framework only defines the schema (see docs/REPO_MAP.md);
 * each project maintains its own registry instance.
 *
 * Returns an empty object when the file is absent — never throws.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {Object<string, {label: string, path: string|null, domain: string|null,
 *   deploy_path: string|null, downstream: string[], docs: string[]}>}
 */
function parseRepoMap(root) {
  try {
    const repoMapPath = resolveRepoMapPath(root);
    if (!repoMapPath) return {};
    const content = fs.readFileSync(repoMapPath, 'utf8');
    const registry = {};
    // Split on ## <id> headings (skip meta headings used in the schema spec)
    const sections = content.split(/^(?=##\s+\S)/m).filter(Boolean);
    const META_HEADINGS = new Set(['What', 'Required', 'Example', 'How']);
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(\S+)/);
      if (!headingMatch) continue;
      const id = headingMatch[1].trim();
      if (META_HEADINGS.has(id)) continue;

      const labelMatch = section.match(/^- \*\*label:\*\*\s+(.+)$/m);
      const pathMatch = section.match(/^- \*\*path:\*\*\s+(.+)$/m);
      const domainMatch = section.match(/^- \*\*domain:\*\*\s+(.+)$/m);
      const deployPathMatch = section.match(/^- \*\*deploy_path:\*\*\s+(.+)$/m);
      const downstreamMatch = section.match(/^- \*\*downstream:\*\*\s+(.+)$/m);
      const docsMatch = section.match(/^- \*\*docs:\*\*\s+(.+)$/m);

      const downstream = downstreamMatch
        ? downstreamMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const docs = docsMatch
        ? docsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      registry[id] = {
        label: labelMatch ? labelMatch[1].trim() : id,
        path: pathMatch ? pathMatch[1].trim() : null,
        domain: domainMatch ? domainMatch[1].trim() : null,
        deploy_path: deployPathMatch ? deployPathMatch[1].trim() : null,
        downstream,
        docs,
      };
    }
    return registry;
  } catch {
    return {};
  }
}

/**
 * Parse a `- **Blocked by:** <repo>/T-NNN[, <repo>/T-MMM ...]` field value into
 * structured {repo, taskId} pairs (T-393 — cross-repo Blocked by relation).
 *
 * Distinct from `Depends on:` parsing (same-repo `T-NNN` tokens, parsed inline
 * in `computeNextAction()` in mavp-operator-agent.js) — that behavior is a
 * separate field and is untouched by this function. `Blocked by:` always
 * requires a `<repo>/` prefix; a bare `T-NNN` token here is silently dropped,
 * matching the existing `Depends on:` precedent of dropping unparsable tokens.
 *
 * @param {string|null} raw - Raw field value, e.g. "repo-a/T-100, repo-b/T-200"
 * @returns {Array<{repo: string, taskId: string}>}
 */
function parseBlockedBy(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return [];
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const m = token.match(/^([^\/\s]+)\/(T-\d+)$/);
      return m ? { repo: m[1], taskId: m[2] } : null;
    })
    .filter(Boolean);
}

/**
 * Resolve the path to docs/MODULES.md for the current context.
 * Mirrors resolveRepoMapPath() — used only by buildContextBundle() below.
 * The canonical module-registry resolution consumed by --agent output lives
 * in mavp-operator-agent.js / mavp-validator.js's resolveModulesPath(); this
 * is a root-parameterized sibling so the context-bundle builder (T-394) can
 * work against an arbitrary root (used by tests and cross-project runs).
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string|null} Absolute path to docs/MODULES.md, or null if absent.
 */
function resolveModuleRegistryPath(root) {
  const base = root || ROOT;
  const p = path.join(base, 'docs', 'MODULES.md');
  return fs.existsSync(p) ? p : null;
}

/**
 * Parse the module registry from docs/MODULES.md, parameterized by root.
 * Mirrors parseModuleRegistry() in mavp-operator-agent.js (same field set:
 * label, repos, context_docs, default_owner, qa_checklist). Returns {}
 * (never throws) when the file is absent — module enrichment degrades
 * gracefully.
 *
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {Object<string, {label:string, repos:string[], context_docs:string[],
 *   default_owner:string, qa_checklist:string[]}>}
 */
function parseModuleRegistry(root) {
  try {
    const modulesPath = resolveModuleRegistryPath(root);
    if (!modulesPath) return {};
    const content = fs.readFileSync(modulesPath, 'utf8');
    const registry = {};
    const sections = content.split(/^(?=##\s+\S)/m).filter(Boolean);
    const META_HEADINGS = new Set(['How', 'Module', 'What', 'Required', 'Example']);
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(\S+)/);
      if (!headingMatch) continue;
      const id = headingMatch[1].trim();
      if (META_HEADINGS.has(id)) continue;

      const labelMatch = section.match(/^- \*\*label:\*\*\s+(.+)$/m);
      const reposMatch = section.match(/^- \*\*repos:\*\*\s+(.+)$/m);
      const contextDocsMatch = section.match(/^- \*\*context_docs:\*\*\s+(.+)$/m);
      const ownerMatch = section.match(/^- \*\*default_owner:\*\*\s+(.+)$/m);

      const contextDocs = contextDocsMatch
        ? contextDocsMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const repos = reposMatch
        ? reposMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
        : [];

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
 * Locate the raw ### T-NNN task block for a given ID inside a BACKLOG.md or
 * TASK_STATUS.md markdown string, using parseAllTaskBlocks(). Returns null
 * when not found.
 *
 * @param {string} markdown - Raw file content (may be '')
 * @param {string} taskId - e.g. "T-394"
 * @returns {string|null}
 */
function findTaskBlockById(markdown, taskId) {
  const blocks = parseAllTaskBlocks(markdown || '');
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^###\\s+${escaped}\\b`);
  return blocks.find((b) => re.test(b)) || null;
}

/**
 * Read a single-line `- **Field:** value` bullet from a raw task block.
 * Returns null when the block is absent or the field is not present.
 * Placeholder values ("—" / "-") are also treated as absent.
 *
 * @param {string|null} block
 * @param {string} fieldName
 * @returns {string|null}
 */
function extractBlockField(block, fieldName) {
  if (!block) return null;
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'm'));
  if (!m) return null;
  const value = m[1].trim();
  if (!value || value === '—' || value === '-') return null;
  return value;
}

/**
 * Resolve the path to a task's context prefetch bundle (.mavp/context/T-NNN.md).
 * The bundle itself is gitignored — regenerated at registration/update time.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {string} [root] - Optional root override (used by tests). Defaults to ROOT.
 * @returns {string} Absolute path (the file may not exist yet).
 */
function resolveContextBundlePath(taskId, root) {
  const base = root || ROOT;
  return path.join(base, '.mavp', 'context', `${taskId}.md`);
}

/**
 * Truncate a raw ### T-NNN task block at the first level-2 (`## `) heading.
 *
 * parseAllTaskBlocks() / findTaskBlockById() only split on `### T-NNN`
 * boundaries, so a task block that happens to be the last one under a
 * `## Wave NN` section runs straight through into the NEXT level-2 heading
 * (e.g. `## Wave NN — Archived`) before hitting another `###` block. Level-2
 * headings never legitimately occur inside a task block's own content, so
 * cutting there is always safe. This is applied only to the copy embedded in
 * the context bundle (T-402) — it does not alter parseAllTaskBlocks() or
 * findTaskBlockById() themselves, which have other consumers.
 *
 * @param {string|null} block - Raw task block starting with `### T-NNN`
 * @returns {string|null}
 */
function truncateTaskBlockAtLevel2Heading(block) {
  if (!block) return block;
  const lines = block.split('\n');
  // Start at 1 -- line 0 is the block's own `### T-NNN` heading line.
  for (let i = 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  return block;
}

/**
 * Build the markdown content of a task's context prefetch bundle: the raw
 * task block, its module's context_docs (from docs/MODULES.md), its Touches
 * list, the repo-map entry (or entries) for its Repo/Repos field, and its
 * Depends on / Blocked by references. Written to .mavp/context/T-NNN.md at
 * task registration/update time (T-394) so agent spawns don't have to
 * reconstruct this context by hand.
 *
 * Degrades gracefully: an absent repo map, absent module registry, or an
 * unknown module/repo id simply omits the corresponding section — this
 * function never throws.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {object} [options]
 * @param {string} [options.root] - Root override (defaults to ROOT)
 * @param {string} [options.backlogPath] - Override path to BACKLOG.md
 * @param {string} [options.taskStatusPath] - Override path to TASK_STATUS.md
 * @returns {string|null} The bundle markdown, or null when the task ID is not
 *   found in either BACKLOG.md or TASK_STATUS.md.
 */
function buildContextBundle(taskId, options = {}) {
  const root = options.root || ROOT;
  const backlogPath = options.backlogPath || path.join(root, 'BACKLOG.md');
  const taskStatusPath = options.taskStatusPath || path.join(root, 'TASK_STATUS.md');

  const backlogContent = fs.existsSync(backlogPath) ? readUtf8(backlogPath) : '';
  const taskStatusContent = fs.existsSync(taskStatusPath) ? readUtf8(taskStatusPath) : '';

  const backlogBlock = findTaskBlockById(backlogContent, taskId);
  const statusBlock = findTaskBlockById(taskStatusContent, taskId);
  const taskBlock = backlogBlock || statusBlock;
  if (!taskBlock) return null;

  const moduleId = extractBlockField(backlogBlock, 'Module') || extractBlockField(statusBlock, 'Module');
  const repoField = extractBlockField(backlogBlock, 'Repo')
    || extractBlockField(backlogBlock, 'Repos')
    || extractBlockField(statusBlock, 'Repo')
    || extractBlockField(statusBlock, 'Repos');
  const touchesField = extractBlockField(backlogBlock, 'Touches');
  const dependsOn = extractBlockField(backlogBlock, 'Depends on');
  const blockedBy = extractBlockField(backlogBlock, 'Blocked by');

  const sections = [];
  sections.push(`# Context Bundle — ${taskId}`);
  sections.push('');
  sections.push(
    'Auto-generated by mavp-operator at task registration/update (T-394). ' +
    'Regenerate via `--update-task` / `--rescope-task`, or by re-running registration. ' +
    'Do not hand-edit — it will be overwritten.'
  );
  sections.push('');
  sections.push('## Task block');
  sections.push('');
  sections.push(truncateTaskBlockAtLevel2Heading(taskBlock.trim()));
  sections.push('');

  if (moduleId) {
    const registry = parseModuleRegistry(root);
    const entry = registry[moduleId];
    if (entry && entry.context_docs.length > 0) {
      sections.push('## Module context docs');
      sections.push('');
      sections.push(`Module: ${moduleId}`);
      sections.push('');
      for (const doc of entry.context_docs) sections.push(`- ${doc}`);
      sections.push('');
    }
  }

  if (touchesField) {
    const files = touchesField.split(',').map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) {
      sections.push('## Touches');
      sections.push('');
      for (const f of files) sections.push(`- ${f}`);
      sections.push('');
    }
  }

  if (repoField) {
    const repoIds = repoField.split(',').map((s) => s.trim()).filter(Boolean);
    const repoMap = parseRepoMap(root);
    const matched = repoIds.filter((id) => repoMap[id]);
    if (matched.length > 0) {
      sections.push('## Repo map entry');
      sections.push('');
      for (const id of matched) {
        const entry = repoMap[id];
        sections.push(`### ${id}`);
        sections.push('');
        sections.push(`- **label:** ${entry.label}`);
        if (entry.path) sections.push(`- **path:** ${entry.path}`);
        if (entry.domain) sections.push(`- **domain:** ${entry.domain}`);
        if (entry.deploy_path) sections.push(`- **deploy_path:** ${entry.deploy_path}`);
        if (entry.downstream.length > 0) sections.push(`- **downstream:** ${entry.downstream.join(', ')}`);
        if (entry.docs.length > 0) sections.push(`- **docs:** ${entry.docs.join(', ')}`);
        sections.push('');
      }
    }
  }

  if (dependsOn || blockedBy) {
    sections.push('## Dependencies');
    sections.push('');
    if (dependsOn) sections.push(`- **Depends on:** ${dependsOn}`);
    if (blockedBy) sections.push(`- **Blocked by:** ${blockedBy}`);
    sections.push('');
  }

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Write a task's context prefetch bundle to .mavp/context/T-NNN.md.
 * Best-effort: catches and reports failures instead of throwing, so
 * registration/update flows never break because of a bundle-write problem.
 *
 * @param {string} taskId - e.g. "T-394"
 * @param {object} [options] - Same options as buildContextBundle().
 * @returns {{ok: boolean, path: (string|null), reason: (string|null)}}
 */
function writeContextBundle(taskId, options = {}) {
  try {
    const root = options.root || ROOT;
    const bundle = buildContextBundle(taskId, options);
    if (bundle == null) {
      return { ok: false, path: null, reason: 'task_not_found' };
    }
    const bundlePath = resolveContextBundlePath(taskId, root);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, bundle, 'utf8');
    return { ok: true, path: bundlePath, reason: null };
  } catch (err) {
    return { ok: false, path: null, reason: err.message };
  }
}

/**
 * Find the most recent commit (walking back from HEAD, inclusive) whose
 * subject line matches the `--close-session` commit marker
 * (`chore: close session YYYY-MM-DD`, written by
 * mavp-operator-close-session.js). Used as the reference point for "what
 * changed this session" (T-391 must-read set).
 *
 * Degrades silently (returns null, never throws) when: `root` is not a git
 * repository, git is not installed, or no commit in history matches the
 * marker pattern (e.g. a brand-new project that has never closed a session).
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string|null} The commit hash, or null.
 */
function findPreviousCloseSessionCommit(root) {
  try {
    const output = cp.execSync('git log --format=%H%x1f%s -n 500', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      const sepIdx = line.indexOf('\x1f');
      if (sepIdx === -1) continue;
      const hash = line.slice(0, sepIdx);
      const subject = line.slice(sepIdx + 1);
      if (/^chore: close session /.test(subject)) return hash;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List files changed (committed) since the previous `--close-session` commit
 * (see findPreviousCloseSessionCommit()), relative to `root`. Part of the
 * T-391 must-read set.
 *
 * Degrades silently (returns [], never throws) when git is unavailable, the
 * marker commit can't be found, or the diff itself fails for any reason.
 *
 * @param {string} root - Absolute path to the git working tree.
 * @returns {string[]} Relative file paths, possibly empty.
 */
function getFilesChangedSincePreviousCloseSession(root) {
  try {
    const commit = findPreviousCloseSessionCommit(root);
    if (!commit) return [];
    const output = cp.execSync(`git diff --name-only ${commit} HEAD`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Compute the T-391 must-read set: files changed since the previous
 * close-session commit (via git), unioned with the context_docs already
 * resolved onto each in-flight active slice (see mavp-operator-agent.js,
 * which attaches `context_docs` per module registry lookup before calling
 * this). Deduplicated; order is changed-files first, then context_docs, each
 * in first-seen order.
 *
 * Never throws. Returns [] when both sources are empty (caller omits the
 * `must_read` field entirely in that case — additive-only, see CLAUDE.md).
 *
 * @param {string} root - Absolute path to the git working tree.
 * @param {Array<{context_docs?: string[]}>} activeSlices - Active slices,
 *   already enriched with `context_docs` where applicable.
 * @returns {string[]}
 */
function computeMustRead(root, activeSlices) {
  const changedFiles = getFilesChangedSincePreviousCloseSession(root);
  const contextDocs = [];
  for (const slice of activeSlices || []) {
    if (Array.isArray(slice.context_docs)) contextDocs.push(...slice.context_docs);
  }
  return Array.from(new Set([...changedFiles, ...contextDocs]));
}

module.exports = {
  ROOT,
  ackRecheck,
  addDays,
  archiveActiveWaveInBacklog,
  armRecheck,
  buildContextBundle,
  buildDeployQueue,
  classifyNextAction,
  clip,
  collectOperatorData,
  computeDueRechecks,
  computeMustRead,
  extractTrajectories,
  findPreviousCloseSessionCommit,
  formatIsoTime,
  generateProcessStateMd,
  getDeployPendingForRepo,
  getFilesChangedSincePreviousCloseSession,
  getNextTaskId,
  insertIntoActiveTasks,
  insertIntoActiveWave,
  lookupTaskTitle,
  normalizeWhitespace,
  parseActiveWaveMergedTitles,
  parseAllTaskBlocks,
  parseBlockedBy,
  parseIntervalDays,
  parseModuleRegistry,
  parseRepoMap,
  parseTasksWithRepo,
  parseTouchesConflicts,
  parseWaveTasks,
  readPermissionMode,
  readPersistedPermissionMode,
  relativeTime,
  renameTask,
  renderThinSnapshot,
  readUtf8,
  resolveContextBundlePath,
  resolveModuleRegistryPath,
  resolveRepoMapPath,
  scoreTrajectory,
  shortenSessionKey,
  summarizeTrajectories,
  truncateTaskBlockAtLevel2Heading,
  updateLastTaskId,
  writeContextBundle,
  writeTrajectories,
  writeUtf8,
};
