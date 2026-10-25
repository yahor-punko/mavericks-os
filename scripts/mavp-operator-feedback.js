'use strict';
// T-828 — adopter-side `--feedback` command (local channel).
//
//   --feedback --file <path> [--adopter <alias>]   submit an item to the inbox
//   --feedback --set-alias <alias>                 persist feedback_alias
//   --feedback --status [--adopter <alias>]        list this alias's items
//   --feedback --ack <id> [--adopter <alias>]      stamp Acknowledged = today
//   --feedback --github (--file <path> | --item <id>) [--repo <owner/repo>] [--adopter <alias>]
//       --operator-confirmed "<statement>"         post the item as a public GitHub issue (T-830)
//   --feedback --pull [--adopter <alias>]          read the maintainer's answer comment back from GitHub (T-835):
//                                                  for each github item of the alias, `gh issue view` (read-only;
//                                                  after the same gh preflight as --github, never a gh write, no
//                                                  --operator-confirmed). Only OWNER/MEMBER, non-minimized
//                                                  comments in the strict answer grammar count; the newest wins.
//                                                  Writes only Disposition, Ships in, Retire workaround,
//                                                  Published and the ## Answer section of an existing item —
//                                                  adopter-owned fields and Acknowledged are never touched.
//   --feedback --draft "<title>" [--summary "<one line>"] [--area <text>] [--kind bug|proposal|question]
//                                                  write a pre-filled draft to <inbox>/drafts/ (T-833)
//   --feedback --drafts                            list this alias's drafts
//   --feedback --discard <draft path>              delete one draft (only under <inbox>/drafts/)
//   (--file <draft path> submits a draft and removes it once submitted)
//
// Items land in the per-user intake queue (resolveIntakeDir()), never in a
// BACKLOG.md: registration stays Main-Agent-only after the architect gate.
// Item format: templates/FEEDBACK_ITEM_TEMPLATE.md.

const fs = require('fs');
const path = require('path');
const {
  printRepoIdentityHeader,
  guardMutatingRoot,
  parseFeedbackItem,
  renderFeedbackItem,
  setFeedbackField,
  resolveIntakeDir,
  resolveFeedbackDraftsDir,
  listFeedbackDrafts,
  formatFeedbackDraftLine,
  FEEDBACK_DRAFT_FILE_PATTERN,
  listIntakeItems,
  allocateFeedbackItemId,
  FEEDBACK_ALIAS_PATTERN,
  FEEDBACK_ADOPTER_FIELDS,
  FEEDBACK_GITHUB_LABEL,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  composeFeedbackIssueTitle,
  formatOutboundFindings,
  ghPreflightRefusal,
  clearFeedbackField,
  parseFeedbackIssueRef,
  pickFeedbackAnswerComment,
  sanitizeFeedbackAnswerText,
  sanitizeForTerminal,
  writeAnswerSection,
  outboundPrivateNamesNote,
  parseIssueNumberFromGhOutput,
  requireOperatorConfirmation,
  resolveFeedbackRepo,
  runGh,
  scanOutboundText,
  withOutboundBodyFile,
} = require('./mavp-operator-lib.js');
const { buildCategories, resolvePrivateNames, scanTextAgainstCategories } = require('./mavp-publish-scan.js');
const { readNamesFileRaw } = require('./mavp-private-names-guard.js');
const { MAVERICKS_VERSION } = require('./mavp-version.js');

const ROOT = process.env.MAVERICKS_PROJECT_ROOT || path.resolve(__dirname, '..');
const PROCESS_STATE_JSON = path.join(ROOT, 'PROCESS_STATE.json');
const REQUIRED_SECTIONS = ['Observed', 'Evidence', 'Proposal'];
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'FEEDBACK_ITEM_TEMPLATE.md');

const USAGE =
  'Usage: --feedback --file <path> [--adopter <alias>] | --set-alias <alias> | --status [--adopter <alias>] | --ack <id> [--adopter <alias>] | --pull [--adopter <alias>] | ' +
  '--github (--file <path> | --item <id>) [--repo <owner/repo>] [--adopter <alias>] --operator-confirmed "<statement>" | ' +
  '--draft "<title>" [--summary "<one line>"] [--area <text>] [--kind bug|proposal|question] [--adopter <alias>] | --drafts [--adopter <alias>] | --discard <draft path> [--adopter <alias>]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    file: null, adopter: null, setAlias: null, status: false, ack: null,
    github: false, item: null, repo: null, operatorConfirmed: false,
    draft: null, summary: null, area: null, kind: null, drafts: false, discard: null, pull: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (name, allowDashes) => {
      const v = argv[i + 1];
      if (v === undefined || (!allowDashes && v.startsWith('--'))) fail(`feedback: ${name} requires a value\n${USAGE}`);
      i++;
      return v;
    };
    if (arg === '--file') opts.file = takeValue('--file');
    else if (arg === '--adopter') opts.adopter = takeValue('--adopter');
    else if (arg === '--set-alias') opts.setAlias = takeValue('--set-alias');
    else if (arg === '--ack') opts.ack = takeValue('--ack');
    else if (arg === '--status') opts.status = true;
    else if (arg === '--github') opts.github = true;
    else if (arg === '--item') opts.item = takeValue('--item');
    else if (arg === '--repo') opts.repo = takeValue('--repo');
    else if (arg === '--draft') opts.draft = takeValue('--draft');
    else if (arg === '--summary') opts.summary = takeValue('--summary');
    else if (arg === '--area') opts.area = takeValue('--area');
    else if (arg === '--kind') opts.kind = takeValue('--kind');
    else if (arg === '--drafts') opts.drafts = true;
    else if (arg === '--pull') opts.pull = true;
    else if (arg === '--discard') opts.discard = takeValue('--discard');
    else if (arg === '--operator-confirmed') {
      // The value is read by requireOperatorConfirmation(); consume it here so it is not misparsed.
      opts.operatorConfirmed = true;
      if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) i++;
    } else fail(`feedback: unrecognized argument ${arg}\n${USAGE}`);
  }
  if (opts.github) {
    if (opts.setAlias !== null || opts.ack !== null || opts.status || opts.draft !== null || opts.drafts || opts.discard !== null || opts.pull) {
      fail(`feedback: --github only combines with --file or --item\n${USAGE}`);
    }
    if ((opts.file === null) === (opts.item === null)) {
      fail(`feedback: --github needs exactly one of --file or --item\n${USAGE}`);
    }
    return opts;
  }
  if (opts.item !== null || opts.repo !== null || opts.operatorConfirmed) {
    fail(`feedback: --item, --repo and --operator-confirmed are only valid with --github\n${USAGE}`);
  }
  const modes = [opts.file, opts.setAlias, opts.ack, opts.draft, opts.discard].filter((v) => v !== null).length +
    (opts.status ? 1 : 0) + (opts.drafts ? 1 : 0) + (opts.pull ? 1 : 0);
  if (modes !== 1) fail(`feedback: exactly one of --file, --set-alias, --status, --ack, --pull, --draft, --drafts, --discard is required\n${USAGE}`);
  if (opts.draft === null && (opts.summary !== null || opts.area !== null || opts.kind !== null)) {
    fail(`feedback: --summary, --area and --kind are only valid with --draft\n${USAGE}`);
  }
  if (opts.kind !== null && !FEEDBACK_KINDS.includes(opts.kind)) {
    fail(`feedback: --kind must be one of ${FEEDBACK_KINDS.join('|')}\n${USAGE}`);
  }
  return opts;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
  } catch {
    return null;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Returns the reason an alias is unusable, or null when it is acceptable.
function aliasRefusal(alias) {
  if (!FEEDBACK_ALIAS_PATTERN.test(alias)) {
    return `alias "${alias}" does not match ${FEEDBACK_ALIAS_PATTERN} (lowercase letters and digits, 2-24 characters, starting with a letter)`;
  }
  let categories;
  try {
    categories = buildCategories(resolvePrivateNames(readNamesFileRaw()));
  } catch (err) {
    return `could not load the private-name list: ${err.message}`;
  }
  for (const category of categories) {
    for (const makeRegex of category.regexes) {
      if (makeRegex().test(alias)) {
        return `alias "${alias}" matches the "${category.name}" category and cannot be used`;
      }
    }
  }
  return null;
}

function resolveAlias(opts) {
  const state = readState();
  const alias = opts.adopter || (state && typeof state.feedback_alias === 'string' ? state.feedback_alias : null);
  if (!alias) {
    fail('feedback: no alias — pass --adopter <alias> or persist one with: --feedback --set-alias <alias>');
  }
  const refusal = aliasRefusal(alias);
  if (refusal) fail(`feedback: refused — ${refusal}`);
  return alias;
}

function isUnfilled(value) {
  const v = (value || '').trim();
  return !v || (v.startsWith('<') && v.endsWith('>'));
}

function stripComments(text) {
  return String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function frameworkVersion(state) {
  if (state && typeof state.mavericks_version === 'string' && state.mavericks_version.trim()) {
    return state.mavericks_version.trim();
  }
  return `${MAVERICKS_VERSION} (resolved)`;
}

// Read and validate the item file named by --file; returns everything needed to write it to the inbox.
function loadSubmission(opts) {
  const alias = resolveAlias(opts);
  const filePath = path.resolve(opts.file);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`feedback: cannot read ${opts.file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = parseFeedbackItem(raw);
  } catch (err) {
    fail(`feedback: refused — ${err.message}`);
  }

  const problems = [];
  if (isUnfilled(parsed.title)) problems.push('title line (expected "# <alias>-NNN — <title>")');
  const kind = (parsed.fields.Kind || '').trim();
  const severity = (parsed.fields.Severity || '').trim();
  const area = (parsed.fields.Area || '').trim();
  if (!FEEDBACK_KINDS.includes(kind)) problems.push(`Kind (one of ${FEEDBACK_KINDS.join('|')})`);
  if (!FEEDBACK_SEVERITIES.includes(severity)) problems.push(`Severity (one of ${FEEDBACK_SEVERITIES.join('|')})`);
  if (isUnfilled(area)) problems.push('Area');
  if (problems.length > 0) fail(`feedback: refused — missing or invalid required field(s): ${problems.join('; ')}`);
  for (const name of REQUIRED_SECTIONS) {
    if (!stripComments(parsed.sections[name])) {
      fail(`feedback: refused — missing or empty required section "## ${name}"`);
    }
  }

  const state = readState();
  const submittedFields = {
    Adopter: alias,
    'Framework version': frameworkVersion(state),
    Kind: kind,
    Severity: severity,
    Area: area,
    Submitted: todayIso(),
  };
  const summary = (parsed.fields.Summary || '').trim();
  if (!isUnfilled(summary)) submittedFields.Summary = summary;
  const wantsWorkaround = !isUnfilled(parsed.fields.Workaround);
  const sections = {};
  for (const name of REQUIRED_SECTIONS) sections[name] = stripComments(parsed.sections[name]);
  return { alias, parsed, submittedFields, wantsWorkaround, sections };
}

// Allocate the next id in the inbox and write the item with the given channel.
function writeSubmission(sub, channel) {
  const { alias, parsed, submittedFields, wantsWorkaround, sections } = sub;
  const inbox = resolveIntakeDir();
  let rendered = '';
  let allocation;
  try {
    allocation = allocateFeedbackItemId(inbox, alias, (id) => {
      const fields = Object.assign({ Item: id }, submittedFields, { Channel: channel });
      if (wantsWorkaround) fields.Workaround = `mavp-workaround:${id}`;
      rendered = renderFeedbackItem({ id, title: parsed.title, fields, sections });
      return rendered;
    });
  } catch (err) {
    fail(`feedback: could not write to ${inbox}: ${err.message}`);
  }
  return { allocation, rendered, inbox };
}

function submit(opts) {
  const { allocation, rendered, inbox } = writeSubmission(loadSubmission(opts), 'local');

  // Non-blocking advisory: the item is already written; findings only warn.
  let categories = [];
  try {
    categories = buildCategories(resolvePrivateNames(readNamesFileRaw()));
  } catch {
    categories = buildCategories([]);
  }
  const findings = [];
  rendered.split('\n').forEach((line, idx) => {
    scanTextAgainstCategories(allocation.path, idx + 1, line, findings, categories);
  });
  for (const f of findings) {
    console.log(`advisory: [${f.category}] line ${f.line} of ${allocation.id}.md may carry private content — review the item`);
  }
  console.log(`feedback: ${allocation.id} written to ${inbox}`);
  removeSubmittedDraft(opts.file);
}

// A draft is consumed by its own submission: `--file <path under <inbox>/drafts/>` removes it
// once the item is written (or posted). Any other path is left untouched.
function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// True when `filePath` is a draft-named file directly inside <inbox>/drafts/ (symlinks resolved, so
// neither a traversal nor a link can point a draft operation at a file elsewhere).
function isUnderDrafts(filePath) {
  const target = path.resolve(filePath);
  return realOrResolved(path.dirname(target)) === realOrResolved(resolveFeedbackDraftsDir(resolveIntakeDir())) &&
    FEEDBACK_DRAFT_FILE_PATTERN.test(path.basename(target));
}

function removeSubmittedDraft(filePath) {
  if (!isUnderDrafts(filePath)) return;
  try {
    fs.unlinkSync(path.resolve(filePath));
    console.log(`feedback: draft ${path.resolve(filePath)} removed`);
  } catch { /* already gone */ }
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// Write a pre-filled copy of the item template to <inbox>/drafts/<alias>-draft-<n>.md.
// No Item id is allocated: the draft only becomes an item when --file submits it.
function draft(opts) {
  const alias = resolveAlias(opts);
  const title = oneLine(opts.draft);
  if (!title) fail('feedback: --draft needs a non-empty title');
  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch (err) {
    fail(`feedback: cannot read the item template ${TEMPLATE_PATH}: ${err.message}`);
  }
  const dir = resolveFeedbackDraftsDir(resolveIntakeDir());
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fail(`feedback: could not create ${dir}: ${err.message}`);
  }
  const fill = (text, n) => {
    const lines = text.split('\n');
    const out = [];
    let headingDone = false;
    for (const line of lines) {
      if (!headingDone && /^#\s/.test(line)) {
        out.push(`# ${alias}-draft-${n} — ${title}`);
        headingDone = true;
      } else if (/^- \*\*Item:\*\*/.test(line)) out.push('- **Item:**');
      else if (/^- \*\*Kind:\*\*/.test(line) && opts.kind !== null) out.push(`- **Kind:** ${opts.kind}`);
      else if (/^- \*\*Area:\*\*/.test(line) && opts.area !== null) out.push(`- **Area:** ${oneLine(opts.area)}`);
      else if (/^- \*\*Summary:\*\*/.test(line)) out.push(opts.summary !== null ? `- **Summary:** ${oneLine(opts.summary)}` : '- **Summary:**');
      else out.push(line);
    }
    // Observed / Evidence / Proposal start as empty sections: drop the guidance comments there.
    return out.join('\n').replace(/(## (?:Observed|Evidence|Proposal)\n)\n<!--[\s\S]*?-->\n/g, '$1');
  };
  for (let attempt = 0; attempt < 1000; attempt++) {
    let highest = 0;
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(FEEDBACK_DRAFT_FILE_PATTERN);
      if (m && m[1] === alias) highest = Math.max(highest, Number(m[2]));
    }
    const target = path.join(dir, `${alias}-draft-${highest + 1}.md`);
    let fd;
    try {
      fd = fs.openSync(target, 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      fail(`feedback: could not write ${target}: ${err.message}`);
    }
    fs.writeSync(fd, fill(template, highest + 1));
    fs.closeSync(fd);
    console.log(`draft: ${target} — fill Observed/Evidence/Proposal; submission happens only after the operator approves it`);
    return;
  }
  fail(`feedback: could not allocate a draft number for alias ${alias}`);
}

function drafts(opts) {
  const alias = resolveAlias(opts);
  const mine = listFeedbackDrafts(resolveIntakeDir(), alias);
  if (mine.length === 0) {
    console.log(`feedback: no drafts for ${alias} in ${resolveFeedbackDraftsDir(resolveIntakeDir())}`);
    return;
  }
  for (const entry of mine) console.log(formatFeedbackDraftLine(entry));
}

// Deletes one draft and nothing else: the path must resolve (symlinks included) to
// <inbox>/drafts/<alias>-draft-<n>.md for the resolved alias.
function discard(opts) {
  const alias = resolveAlias(opts);
  const draftsDir = path.resolve(resolveFeedbackDraftsDir(resolveIntakeDir()));
  const target = path.resolve(opts.discard);
  const nameOk = path.basename(target).match(FEEDBACK_DRAFT_FILE_PATTERN);
  if (!isUnderDrafts(target) || !nameOk || nameOk[1] !== alias) {
    fail(`feedback: refused — ${opts.discard} is not a draft of ${alias} under ${draftsDir}`);
  }
  try {
    fs.unlinkSync(target);
  } catch (err) {
    fail(`feedback: cannot discard ${opts.discard}: ${err.message}`);
  }
  console.log(`feedback: discarded ${target}`);
}

function setAlias(opts) {
  const refusal = aliasRefusal(opts.setAlias);
  if (refusal) fail(`feedback: refused — ${refusal}`);
  const rootGuard = guardMutatingRoot(ROOT, '--feedback --set-alias');
  if (rootGuard.blocked) process.exit(1);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(PROCESS_STATE_JSON, 'utf8'));
  } catch { /* start fresh */ }
  const updated = Object.assign({}, current, { feedback_alias: opts.setAlias });
  fs.writeFileSync(PROCESS_STATE_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`feedback: alias set to ${opts.setAlias}`);
}

function status(opts) {
  const alias = resolveAlias(opts);
  const inbox = resolveIntakeDir();
  const mine = listIntakeItems(inbox).filter((e) => e.alias === alias);
  if (mine.length === 0) {
    console.log(`feedback: no items for ${alias} in ${inbox}`);
    return;
  }
  for (const e of mine) {
    if (!e.item) {
      console.log(`${e.id} unreadable — ${e.error}`);
      continue;
    }
    const f = e.item.fields;
    const or = (v, fallback) => (v && v.trim() ? v.trim() : fallback);
    let line = `${e.id} ${or(f.Kind, '?')}/${or(f.Severity, '?')} — ${e.item.title || ''} — ${or(f.Disposition, 'new')} — ${or(f['Ships in'], '—')} — ${or(f['Retire workaround'], '—')}`;
    // T-835: a posted GitHub item still waiting for an answer points at the way to read it back.
    if (or(f.Channel, '') === 'github' && !or(f.Disposition, '')) {
      const ref = parseFeedbackIssueRef(f.Issue);
      if (ref) line += ` — posted as ${ref.slug}#${ref.number}; run --feedback --pull`;
    }
    console.log(line);
  }
}

// T-835 — read the maintainer's answer back from GitHub. Read-only on GitHub: the only gh calls
// are `auth status` (the same preflight as --github) and one `issue view` per posted item.
// The trust decision lives in pickFeedbackAnswerComment() (lib): OWNER/MEMBER, not minimized,
// strict answer grammar, newest wins. Only Disposition, Ships in, Retire workaround, Published and
// the `## Answer` section of an item that already exists are written; adopter-owned fields and
// Acknowledged are never touched, and no file is ever created.
function pull(opts) {
  const alias = resolveAlias(opts);
  const inbox = resolveIntakeDir();
  const eligible = [];
  for (const e of listIntakeItems(inbox)) {
    if (e.alias !== alias || !e.item) continue;
    if ((e.item.fields.Channel || '').trim() !== 'github') continue;
    const ref = parseFeedbackIssueRef(e.item.fields.Issue);
    if (ref) eligible.push({ entry: e, ref });
  }
  if (eligible.length === 0) {
    console.log(`feedback: no GitHub items for ${alias}`);
    return;
  }
  const refusal = ghPreflightRefusal();
  if (refusal) fail(`feedback: refused — ${refusal}`);

  const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
  let pulled = 0;
  for (const { entry, ref } of eligible) {
    const where = `${ref.slug}#${ref.number}`;
    let comments;
    try {
      const view = JSON.parse(runGh(['issue', 'view', String(ref.number), '--repo', ref.slug, '--json', 'comments']));
      comments = view && Array.isArray(view.comments) ? view.comments : null;
    } catch (err) {
      console.error(`feedback: gh issue view failed for ${entry.id}: ${sanitizeForTerminal(String(err.stderr || err.message), 200)}`);
      process.exitCode = 1;
      continue;
    }
    if (comments === null) {
      console.error(`feedback: gh issue view returned an unexpected shape for ${entry.id}`);
      process.exitCode = 1;
      continue;
    }
    const picked = pickFeedbackAnswerComment(comments);
    if (picked.total === 0) {
      console.log(`no answer yet: ${entry.id} (${where})`);
      continue;
    }
    if (!picked.accepted) {
      console.log(`ignored: ${entry.id} — ${picked.ignored} comment(s) not from the maintainer or not in answer form`);
      continue;
    }
    const { parsed, date, login } = picked.accepted;
    const answerText = sanitizeFeedbackAnswerText(parsed.text);
    const f = entry.item.fields;
    const storedAnswer = clean(entry.item.sections.Answer);
    const same =
      clean(f.Disposition) === parsed.disposition &&
      clean(f['Ships in']) === (parsed.shipsIn || '') &&
      clean(f['Retire workaround']) === (parsed.retire || '') &&
      clean(f.Published) === date &&
      storedAnswer === answerText;
    if (same) {
      console.log(`unchanged: ${entry.id}`);
      continue;
    }
    let text = fs.readFileSync(entry.path, 'utf8');
    text = setFeedbackField(text, 'Disposition', parsed.disposition);
    text = parsed.shipsIn ? setFeedbackField(text, 'Ships in', parsed.shipsIn) : clearFeedbackField(text, 'Ships in');
    text = parsed.retire ? setFeedbackField(text, 'Retire workaround', parsed.retire) : clearFeedbackField(text, 'Retire workaround');
    text = setFeedbackField(text, 'Published', date);
    if (answerText || storedAnswer) text = writeAnswerSection(text, answerText);
    fs.writeFileSync(entry.path, text, 'utf8');
    pulled++;
    const by = sanitizeForTerminal(login, 40) || '—';
    console.log(`pulled: ${entry.id} (${where}) — ${parsed.disposition} — ${parsed.shipsIn || '—'} — by ${by}`);
    const acknowledged = clean(f.Acknowledged);
    if (acknowledged && date > acknowledged.slice(0, 10)) {
      console.log(`updated after your acknowledgement: ${entry.id}`);
    }
  }
  console.log(`feedback: ${pulled} answer(s) pulled`);
}

function ack(opts) {
  const alias = resolveAlias(opts);
  if (!opts.ack.startsWith(`${alias}-`)) {
    fail(`feedback: ${opts.ack} does not belong to alias ${alias}`);
  }
  const entry = listIntakeItems(resolveIntakeDir()).find((e) => e.id === opts.ack);
  if (!entry) fail(`feedback: no item ${opts.ack} in ${resolveIntakeDir()}`);
  const date = todayIso();
  const updated = setFeedbackField(fs.readFileSync(entry.path, 'utf8'), 'Acknowledged', date);
  fs.writeFileSync(entry.path, updated, 'utf8');
  console.log(`feedback: ${entry.id} acknowledged ${date}`);
}

// T-830 — post an item as a public GitHub issue. Order is fixed: operator
// confirmation, compose, blocking outbound scan, gh preflight, label check, create, stamp.
// The only gh calls are made after the scan has returned no findings.
function postGithub(opts, argv) {
  requireOperatorConfirmation(argv, '--feedback --github');
  let slug;
  try {
    slug = resolveFeedbackRepo(opts.repo);
  } catch (err) {
    fail(`feedback: ${err.message}`);
  }

  let createdPath = null; // set only when this run created the local item; removed again unless the post succeeds
  const bail = (message) => {
    if (createdPath) {
      try {
        fs.unlinkSync(createdPath);
      } catch { /* already gone */ }
    }
    fail(message);
  };

  let itemPath;
  let raw;
  if (opts.file !== null) {
    const written = writeSubmission(loadSubmission(opts), 'github');
    itemPath = written.allocation.path;
    createdPath = itemPath;
    raw = written.rendered;
  } else {
    const alias = resolveAlias(opts);
    if (!opts.item.startsWith(`${alias}-`)) fail(`feedback: ${opts.item} does not belong to alias ${alias}`);
    const entry = listIntakeItems(resolveIntakeDir()).find((e) => e.id === opts.item);
    if (!entry) fail(`feedback: no item ${opts.item} in ${resolveIntakeDir()}`);
    if (!entry.item) fail(`feedback: ${entry.id} is unreadable — ${entry.error}`);
    if ((entry.item.fields.Issue || '').trim()) fail(`feedback: ${entry.id} is already posted as ${entry.item.fields.Issue.trim()}`);
    itemPath = entry.path;
    raw = fs.readFileSync(entry.path, 'utf8');
  }

  const parsed = parseFeedbackItem(raw);
  const id = parsed.id;
  const fields = {};
  for (const name of FEEDBACK_ADOPTER_FIELDS) {
    if (name !== 'Issue' && parsed.fields[name] !== undefined) fields[name] = parsed.fields[name];
  }
  fields.Channel = 'github';
  const sections = Object.assign({}, parsed.sections);
  delete sections.Answer; // framework-owned: never part of the outbound issue
  const title = composeFeedbackIssueTitle(id, parsed.title);
  const body = renderFeedbackItem({ id, title: parsed.title, fields, sections });

  let findings;
  try {
    const note = outboundPrivateNamesNote(ROOT);
    if (note) console.log(note);
    findings = scanOutboundText(title, body, ROOT);
  } catch (err) {
    bail(`feedback: could not run the outbound scan (${err.message})\nBLOCKED: nothing was posted`);
  }
  if (findings.length > 0) {
    for (const line of formatOutboundFindings(findings)) console.error(line);
    bail('BLOCKED: nothing was posted');
  }

  const refusal = ghPreflightRefusal();
  if (refusal) bail(`feedback: refused — ${refusal}\nBLOCKED: nothing was posted`);

  let hasLabel = false;
  try {
    const labels = JSON.parse(runGh(['label', 'list', '--repo', slug, '--search', FEEDBACK_GITHUB_LABEL, '--json', 'name', '--limit', '100']));
    hasLabel = Array.isArray(labels) && labels.some((l) => l && l.name === FEEDBACK_GITHUB_LABEL);
  } catch { /* treated as absent */ }
  const args = ['issue', 'create', '--repo', slug, '--title', title];
  if (hasLabel) args.push('--label', FEEDBACK_GITHUB_LABEL);
  else console.log(`label ${FEEDBACK_GITHUB_LABEL} not found on ${slug}; posting unlabelled`);

  let output;
  try {
    output = withOutboundBodyFile(body, (file) => runGh([...args, '--body-file', file]));
  } catch (err) {
    bail(`feedback: gh issue create failed: ${String(err.stderr || err.message).trim()}\nBLOCKED: nothing was posted`);
  }
  const number = parseIssueNumberFromGhOutput(output);
  if (number === null) {
    createdPath = null; // the issue may exist; keep the local item
    fail(`feedback: gh issue create succeeded but no issue number could be read from its output; the item ${id} is kept locally — record the Issue field by hand:\n${String(output).trim()}`);
  }
  createdPath = null;
  let text = fs.readFileSync(itemPath, 'utf8');
  text = setFeedbackField(text, 'Channel', 'github');
  text = setFeedbackField(text, 'Issue', `${slug}#${number}`);
  fs.writeFileSync(itemPath, text, 'utf8');
  console.log(`feedback: ${id} posted as ${slug}#${number}`);
  if (opts.file !== null) removeSubmittedDraft(opts.file);
}

const argvRest = process.argv.slice(2);
const opts = parseArgs(argvRest);
printRepoIdentityHeader(ROOT, { mutating: !opts.status && !opts.drafts });
if (opts.github) postGithub(opts, argvRest);
else if (opts.file !== null) submit(opts);
else if (opts.draft !== null) draft(opts);
else if (opts.drafts) drafts(opts);
else if (opts.discard !== null) discard(opts);
else if (opts.setAlias !== null) setAlias(opts);
else if (opts.status) status(opts);
else if (opts.pull) pull(opts);
else ack(opts);
