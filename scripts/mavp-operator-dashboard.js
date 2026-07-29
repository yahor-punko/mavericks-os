#!/usr/bin/env node

const readline = require('node:readline');
const { collectOperatorData, clip, formatIsoTime, IN_FLIGHT_STATUSES, normalizeWhitespace, relativeTime, renderThinSnapshot, shortenSessionKey } = require('./mavp-operator-lib');

const MAX_WAVE_TASKS = 10;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

function colorForStatus(status) {
  switch (status) {
    case 'running': return GREEN;
    case 'waiting_approval': return YELLOW;
    case 'waiting_subagent': return CYAN;
    case 'blocked': return RED;
    case 'completed': return GRAY;
    case 'idle_unexpected': return MAGENTA;
    default: return BLUE;
  }
}

function badge(text, color) {
  return `${color}[${text}]${RESET}`;
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function wrapText(text, width) {
  const normalized = normalizeWhitespace(text) || '—';
  if (width <= 4) return [normalized.slice(0, width)];

  const words = normalized.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
    } else if (!current) {
      lines.push(word.slice(0, width - 1) + '…');
    } else {
      lines.push(current);
      current = word.length > width ? `${word.slice(0, width - 1)}…` : word;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : ['—'];
}

function padVisibleRight(value, width) {
  const raw = String(value);
  const deficit = Math.max(width - visibleLength(raw), 0);
  return raw + ' '.repeat(deficit);
}

function fitLine(text, width) {
  const plain = normalizeWhitespace(text) || '—';
  return plain.length <= width ? plain : `${plain.slice(0, Math.max(width - 1, 1))}…`;
}

function makePanel(title, lines, width, color = CYAN) {
  const innerWidth = Math.max(width - 2, 20);
  const top = `┌${'─'.repeat(innerWidth)}┐`;
  const titleLine = `│${padVisibleRight(`${BOLD}${color}${fitLine(title, innerWidth)}${RESET}`, innerWidth)}│`;
  const body = [];

  if (!lines.length) lines = ['—'];

  for (const line of lines) {
    const wrapped = wrapText(line, innerWidth);
    for (const segment of wrapped) {
      body.push(`│${padVisibleRight(segment, innerWidth)}│`);
    }
  }

  const bottom = `└${'─'.repeat(innerWidth)}┘`;
  return [top, titleLine, ...body, bottom];
}

function equalize(left, right) {
  const max = Math.max(left.length, right.length);
  const leftWidth = visibleLength(left[0] || '');
  const rightWidth = visibleLength(right[0] || '');
  while (left.length < max) left.splice(left.length - 1, 0, `│${' '.repeat(Math.max(leftWidth - 2, 0))}│`);
  while (right.length < max) right.splice(right.length - 1, 0, `│${' '.repeat(Math.max(rightWidth - 2, 0))}│`);
  return [left, right];
}

function renderColumns(left, right, gap = '  ') {
  const [a, b] = equalize([...left], [...right]);
  return a.map((line, index) => `${line}${gap}${b[index]}`);
}

function renderCurrentState(workflow, waits) {
  const interventionWaits = waits.filter((wait) => (wait.severity || 0) >= 3);
  const healthyWaits = waits.filter((wait) => (wait.severity || 0) < 3);
  const interventionExists = interventionWaits.length > 0;

  const lines = [
    `${badge(workflow.classification, BLUE)} ${workflow.initiative_title || 'unknown initiative'}`,
  ];

  if (interventionExists) {
    const headline = interventionWaits[0];
    lines.push(`${badge('ACTION NEEDED', RED)} ${interventionWaits.length} intervention item${interventionWaits.length === 1 ? '' : 's'} visible`);
    lines.push(`Priority: ${headline.actor_label} — ${clip(headline.summary || headline.status || headline.wait_type, 72)}`);
  } else if (healthyWaits.length) {
    lines.push(`${badge('MONITORING', CYAN)} ${healthyWaits.length} healthy wait${healthyWaits.length === 1 ? '' : 's'} visible`);
  } else {
    lines.push(`${badge('CLEAR', GREEN)} no intervention-needed items visible`);
  }

  const waveNum = workflow.wave ? `W${workflow.wave} ` : '';
  const waveTasks = workflow.wave_tasks || [];
  const waveTasksMergedCount = waveTasks.filter((t) => t.status === 'merged').length;
  const waveStr = waveTasks.length > 0
    ? `${waveNum}${waveTasksMergedCount}/${waveTasks.length} merged`
    : (waveNum || '—');
  lines.push(`Stage: ${workflow.stage || 'unknown'}  |  Wave: ${waveStr}  |  Wave status: ${workflow.wave_status || 'unknown'}`);
  if (workflow.wave_goal) {
    const goalText = workflow.wave_goal.length > 60 ? `${workflow.wave_goal.slice(0, 59)}…` : workflow.wave_goal;
    lines.push(`Wave goal: ${goalText}`);
  }
  if (workflow.wave_strategy_note) {
    const stratText = workflow.wave_strategy_note.length > 60 ? `${workflow.wave_strategy_note.slice(0, 59)}…` : workflow.wave_strategy_note;
    lines.push(`Strategy: ${stratText}`);
  }
  // IN_FLIGHT_STATUSES is imported from mavp-operator-lib.js — the single shared source
  // of truth for "what counts as active work" across operator surfaces (see T-525).
  const inFlightCount = waveTasks.filter((t) => IN_FLIGHT_STATUSES.has(t.status)).length;
  if (inFlightCount > 0) {
    lines.push(`In-flight: ${inFlightCount} task${inFlightCount === 1 ? '' : 's'}`);
  }
  lines.push(`Owner: ${workflow.owner || 'unknown'}  |  Task status: ${workflow.task_status || 'unknown'}`);
  if (workflow.next_action) {
    lines.push(`Next action: ${clip(workflow.next_action, 72)}`);
  } else {
    lines.push(`Next handoff: ${workflow.next_handoff[0] || 'none visible'}`);
  }
  lines.push(`Blockers: ${workflow.blockers.length ? workflow.blockers.join(' | ') : 'none'}`);
  lines.push(`Pending approvals: ${workflow.pending_approvals}`);

  return lines;
}

function buildActorTree(actors, { interventionExists = false } = {}) {
  const actionableStatuses = new Set(['running', 'waiting_approval', 'waiting_subagent', 'blocked', 'idle_unexpected']);
  const visibleActors = interventionExists
    ? actors.filter((actor) => actionableStatuses.has(actor.status))
    : actors.filter((actor) => actor.status !== 'completed');
  const hiddenActors = actors.filter((actor) => !visibleActors.includes(actor));

  const byParent = new Map();
  const byId = new Map();
  for (const actor of visibleActors) {
    byId.set(actor.actor_id, actor);
    const parent = actor.parent_actor_id || '__root__';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(actor);
  }

  for (const list of byParent.values()) {
    list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  const visited = new Set();
  const lines = [];

  function walk(parentId, depth) {
    const children = byParent.get(parentId) || [];
    for (const actor of children) {
      visited.add(actor.actor_id);
      const indent = depth ? `${'  '.repeat(depth)}↳ ` : '';
      const status = badge(actor.status, colorForStatus(actor.status));
      const task = actor.current_task ? ` — ${clip(actor.current_task, 60)}` : '';
      const parentHint = depth === 0 && actor.parent_actor_id && !byId.has(actor.parent_actor_id)
        ? ` ${DIM}(parent:${shortenSessionKey(actor.parent_actor_id)})${RESET}`
        : '';
      const updated = actor.updated_at ? ` ${DIM}${formatIsoTime(actor.updated_at)}${RESET}` : '';
      lines.push(`${indent}${status} ${actor.label} · ${actor.role}${task}${parentHint}${updated}`);
      walk(actor.actor_id, depth + 1);
    }
  }

  walk('__root__', 0);

  for (const actor of visibleActors) {
    if (!visited.has(actor.actor_id)) {
      const status = badge(actor.status, colorForStatus(actor.status));
      const task = actor.current_task ? ` — ${clip(actor.current_task, 60)}` : '';
      const updated = actor.updated_at ? ` ${DIM}${formatIsoTime(actor.updated_at)}${RESET}` : '';
      lines.push(`${status} ${actor.label} · ${actor.role}${task}${updated}`);
    }
  }

  if (!lines.length) {
    lines.push('Runtime monitoring not available in this environment');
  }

  const completedCount = hiddenActors.filter((actor) => actor.status === 'completed').length;
  const hiddenCount = hiddenActors.length;
  if (hiddenCount) {
    const reason = interventionExists ? 'completed / non-actionable actors collapsed during intervention' : 'completed actors collapsed by default';
    lines.push(`${DIM}${hiddenCount} actor${hiddenCount === 1 ? '' : 's'} hidden (${reason}${completedCount && completedCount !== hiddenCount ? `; ${completedCount} completed` : ''})${RESET}`);
  }

  return lines;
}

function renderWaits(waits) {
  if (!waits.length) return ['No waits or blockers visible'];

  const interventionWaits = waits.filter((wait) => (wait.severity || 0) >= 3);
  const healthyWaits = waits.filter((wait) => (wait.severity || 0) < 3);
  const lines = [];

  if (interventionWaits.length) {
    lines.push(`${badge('INTERVENTION', RED)} ${interventionWaits.length} item${interventionWaits.length === 1 ? '' : 's'} need operator attention`);
  } else if (healthyWaits.length) {
    lines.push(`${badge('HEALTHY WAITS', CYAN)} ${healthyWaits.length} item${healthyWaits.length === 1 ? '' : 's'} being tracked`);
  }

  for (const wait of waits.slice(0, 8)) {
    const sev = wait.severity >= 4 ? badge('sev4', RED) : wait.severity === 3 ? badge('sev3', YELLOW) : badge('sev2', CYAN);
    const status = badge(wait.status || wait.wait_type, colorForStatus(wait.status));
    const age = wait.age ? ` (${wait.age})` : '';
    const emphasis = wait.severity >= 3 ? BOLD : DIM;
    const tone = wait.severity >= 3 ? WHITE : GRAY;
    lines.push(`${emphasis}${tone}${sev} ${status} ${wait.actor_label}${age} — ${clip(wait.summary || wait.wait_type, 72)}${RESET}`);
  }

  return lines;
}

function renderRecent(recentEvents, { interventionExists = false } = {}) {
  if (!recentEvents.length) return ['No movement data available'];
  const lines = [];

  if (interventionExists) {
    lines.push(`${DIM}Context only — intervention items above should be scanned first${RESET}`);
  }

  return [
    ...lines,
    ...recentEvents.slice(0, 8).map((event) => {
      const ts = event.timestamp ? `${DIM}${formatIsoTime(event.timestamp)}${RESET} ` : '';
      const body = `${ts}${event.actor_label} — ${clip(event.summary, 78)}`;
      return interventionExists ? `${DIM}${body}${RESET}` : body;
    }),
  ];
}

function statusBadgeForTask(status) {
  if (status === 'merged') return `${GREEN}✓${RESET}`;
  if (status === 'planned') return `${DIM}○${RESET}`;
  return `${CYAN}●${RESET}`;
}

function renderTrajectories(trajectorySummary) {
  if (!trajectorySummary || !trajectorySummary.length) {
    return [`${DIM}No trajectory data found in .mavp/trajectories/${RESET}`];
  }

  const lines = [];
  for (const r of trajectorySummary) {
    const pct = r.successPct;
    const color = pct >= 80 ? GREEN : pct >= 50 ? YELLOW : RED;
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const fixes = r.needsFixCount > 0 ? ` ${DIM}tasks_fixed:${r.needsFixCount}${RESET}` : '';
    const blocked = r.blockedCount > 0 ? ` ${DIM}blocked:${r.blockedCount}${RESET}` : '';
    lines.push(`${r.role.padEnd(14)} ${color}${pct}% ${bar}${RESET}  ${DIM}n=${r.count} ok=${r.successCount}${RESET}${fixes}${blocked}`);
  }
  return lines;
}

function renderWaveTasks(waveTasks, waveNum) {
  if (!waveTasks || !waveTasks.length) return ['No tasks in current wave'];

  const title = `Wave ${waveNum || '?'} — ${waveTasks.length} task${waveTasks.length === 1 ? '' : 's'}`;
  const lines = [title];

  const displayed = waveTasks.slice(0, MAX_WAVE_TASKS);
  const overflow = waveTasks.length - displayed.length;

  for (const task of displayed) {
    const badge = statusBadgeForTask(task.status);
    const titleTrunc = task.title.length > 45 ? `${task.title.slice(0, 44)}…` : task.title;
    const statusLabel = task.status.length > 12 ? task.status.slice(0, 12) : task.status;
    lines.push(`${badge} ${task.id}  ${titleTrunc.padEnd(46)}${DIM}${statusLabel}${RESET}`);
  }

  if (overflow > 0) {
    lines.push(`${DIM}+${overflow} more${RESET}`);
  }

  lines.push(`${DIM}${GREEN}✓${RESET}${DIM} merged  ${CYAN}●${RESET}${DIM} active  ○ planned${RESET}`);

  return lines;
}

function renderContextBar(tokenUsage) {
  if (!tokenUsage) return `${DIM}ctx: —${RESET}`;
  const { context_used, context_window, context_pct } = tokenUsage;
  const filled = Math.max(0, Math.min(10, Math.round(context_pct / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const color = context_pct >= 80 ? RED : context_pct >= 60 ? YELLOW : GREEN;
  const used = context_used >= 1000 ? `${Math.round(context_used / 1000)}K` : String(context_used);
  const total = `${Math.round(context_window / 1000)}K`;
  return `${color}ctx ${used}/${total} ${context_pct}% ${bar}${RESET}`;
}

function renderCommandsRef() {
  return [
    `${DIM}Commands: --new-task  --update-task  --set-status  --close-session  --handoff${RESET}`,
    `${DIM}          --snapshot  --watch  --agent  --quick-task  --apply-decomposition  --help${RESET}`,
  ].join('\n');
}

function renderFooter(data) {
  const freshness = data.workflow_state.last_update_relative || data.workflow_state.last_update || 'unknown';
  const sessionsState = data.sources.sessions.ok ? 'sessions:ok' : 'sessions:—';
  const tasksState = data.sources.tasks.ok ? 'tasks:ok' : 'tasks:—';
  return `${DIM}r refresh • s snapshot • q quit • updated ${freshness} • ${sessionsState} • ${tasksState}${RESET}`;
}

function renderDashboard() {
  const data = collectOperatorData();
  const width = Math.max(process.stdout.columns || 120, 80);
  const leftWidth = Math.max(Math.floor((width - 2) * 0.52), 42);
  const rightWidth = Math.max(width - leftWidth - 2, 34);
  const interventionExists = data.wait_states.some((wait) => (wait.severity || 0) >= 3);
  const waitTitle = interventionExists
    ? `Waits & Blockers — ACTION NEEDED (${data.wait_states.filter((wait) => (wait.severity || 0) >= 3).length})`
    : 'Waits & Blockers';
  const recentTitle = interventionExists ? 'Recent Movement — secondary context' : 'Recent Movement';

  const currentPanel = makePanel('Current State', renderCurrentState(data.workflow_state, data.wait_states), leftWidth, CYAN);
  const actorsPanel = makePanel('Runtime Actors', buildActorTree(data.runtime_actors, { interventionExists }), leftWidth, GREEN);
  const waitsPanel = makePanel(waitTitle, renderWaits(data.wait_states), rightWidth, interventionExists ? RED : YELLOW);
  const recentPanel = makePanel(recentTitle, renderRecent(data.recent_events, { interventionExists }), rightWidth, interventionExists ? GRAY : MAGENTA);

  const top = renderColumns(currentPanel, waitsPanel);
  const bottom = renderColumns(actorsPanel, recentPanel);

  const waveNum = data.workflow_state && data.workflow_state.wave;
  const waveTasksPanel = makePanel(`Wave ${waveNum || '?'} Tasks`, renderWaveTasks(data.wave_tasks, waveNum), width, BLUE);
  const trajPanel = data.trajectory_summary && data.trajectory_summary.length
    ? makePanel('Agent Trajectories', renderTrajectories(data.trajectory_summary), width, MAGENTA)
    : null;

  const todayStr = (() => {
    const t = data.today_usage;
    if (!t) return '';
    const fmt = n => n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
    return `  ${DIM}today ↑${fmt(t.input)} ↓${fmt(t.output)}${RESET}`;
  })();

  const deploySection = (() => {
    const wf = data.workflow_state;
    if (wf.deploy_contours < 2 || !wf.deploy_pending_tasks || wf.deploy_pending_tasks.length === 0) return [];
    const deployLines = wf.deploy_pending_tasks.map(t => `${t.id}${t.repo ? ` (${t.repo})` : ''} — ${t.title}`);
    return ['', ...makePanel('Pending prod deployment', deployLines, width, BLUE)];
  })();

  const recheckSection = (() => {
    const entries = data.due_rechecks;
    if (!entries || entries.length === 0) return [];
    const overdueCount = entries.filter(e => e.overdue).length;
    const recheckLines = entries.map(e => {
      const ref = e.task || e.id;
      const label = e.title ? `${ref} — ${e.title}` : ref;
      const overdueMark = e.overdue ? ` ${RED}[overdue]${RESET}` : '';
      return `${label}  ${DIM}due:${e.due}${RESET}${overdueMark}`;
    });
    const title = overdueCount > 0
      ? `Due Rechecks (${entries.length} due, ${overdueCount} overdue)`
      : `Due Rechecks (${entries.length} due)`;
    return ['', ...makePanel(title, recheckLines, width, YELLOW)];
  })();

  return [
    `${BOLD}MavP Operator Dashboard${RESET}  ${renderContextBar(data.token_usage)}${todayStr}`,
    ...top,
    '',
    ...bottom,
    '',
    ...waveTasksPanel,
    ...(trajPanel ? ['', ...trajPanel] : []),
    ...deploySection,
    ...recheckSection,
    '',
    renderCommandsRef(),
    renderFooter(data),
  ].join('\n');
}

function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(renderDashboard());
  process.stdout.write('\n');
}

function main() {
  const watch = process.argv.includes('--watch');

  if (!watch || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderDashboard());
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  const redraw = () => {
    try {
      draw();
    } catch (error) {
      process.stdout.write(`\nDashboard render failed: ${error.message}\n`);
    }
  };

  redraw();
  const interval = setInterval(redraw, 10000);
  process.stdout.on('resize', redraw);

  process.stdin.on('keypress', (_str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      clearInterval(interval);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      process.exit(0);
    }

    if (key.name === 'r') {
      redraw();
    }

    if (key.name === 's') {
      process.stdout.write('\x1b[2J\x1b[H');
      try {
        process.stdout.write(renderThinSnapshot(collectOperatorData()));
        process.stdout.write('\n\nPress any key to return to dashboard…\n');
      } catch (error) {
        process.stdout.write(`\nSnapshot failed: ${error.message}\n`);
      }
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = { renderContextBar, renderTrajectories };
