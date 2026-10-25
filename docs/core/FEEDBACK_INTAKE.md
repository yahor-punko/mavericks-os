# Adopter Feedback Intake

When the framework gets in your way, you can tell the people who maintain it in a form they can act on, and you find out what became of it. A problem you report is answered with a disposition and, when it is fixed, the framework version that ships the fix. A stop-gap you wrote in your own project to dodge that problem is then flagged for removal instead of living on after the cause is gone. Nothing is sent anywhere on your behalf unless you or your operator say so, and a public post is blocked if it appears to contain private content.

This document is for the person coordinating an adopting project (usually the Main Agent, with the operator's approval at the points marked below) and, in its last part, for the framework maintainer who reads the queue.

## How the loop works

1. **Capture.** During a session, note friction or a proposal. At session end the coordinator drafts each note as a feedback item.
2. **Approve.** The operator approves which drafts are sent. Unapproved drafts stay drafts.
3. **Submit.** An approved item goes to the per-user local inbox, and, only with a separate statement from the operator, can also be posted as a public GitHub issue.
4. **Triage (framework side).** The maintainer reads the queue, runs it through the architect gate, and records a disposition on each item. Triage records an answer; it never registers a task by itself.
5. **Answer and retire.** Once a fix is released, the answer names the task and the version. If you tagged the stop-gap you wrote for that problem, `--migrate` tells you it is now retirable, and you remove it by hand. An item you posted on GitHub gets its answer through `--feedback --pull`.

The intake is a queue, not a task register. Nothing outside the Main Agent writes `BACKLOG.md` or `TASK_STATUS.md`: a feedback item reaches a backlog only after the framework's architect gate decomposes it and the Main Agent registers the result.

## Set your alias

Every item carries an alias that names your project to the maintainer. Set it once; it is stored as `feedback_alias` in `PROCESS_STATE.json`.

```
./scripts/mavp-operator --feedback --set-alias <alias>
```

The command prints `feedback: alias set to <alias>`. The grammar is: lowercase letters and digits only, 2 to 24 characters, starting with a letter. **The alias must never be a private repository or project name**, because it travels in every item and in every public issue title. The command refuses an alias that matches a name on the framework's private-name list, and every later feedback command re-checks the stored alias. Pick something neutral and unrelated to what the project is called internally.

You can also pass `--adopter <alias>` to any `--feedback` mode to use an alias for one run without storing it. With no stored alias and no `--adopter`, the commands stop with `feedback: no alias — pass --adopter <alias> or persist one with: --feedback --set-alias <alias>`.

## Write an item

Copy `templates/FEEDBACK_ITEM_TEMPLATE.md` and fill in:

- the title on the first line (`# <alias>-NNN — <title>`; leave the id placeholder as it is);
- **Kind** — `bug`, `proposal` or `question`;
- **Severity** — `blocking`, `high`, `normal` or `low`;
- **Area** — the part of the framework concerned, for example an operator command or a doc name;
- the **Observed**, **Evidence** and **Proposal** sections, each non-empty;
- optionally **Summary** (one line, shown when drafts are listed) and **Workaround** (see "Tag your workarounds" below).

Leave **Item**, **Adopter**, **Framework version**, **Submitted** and **Channel** alone: submission stamps them. Delete the framework-written fields (Disposition through Published) or leave them empty; only the framework writes them. Keep one concern per item, and never renumber. A submission that is missing a required field is refused with `feedback: refused — missing or invalid required field(s): ...` or `feedback: refused — missing or empty required section "## <name>"`, and nothing is written.

Write the Evidence section so a stranger can follow it, and describe private paths and names in words rather than quoting them.

## Submit to the local inbox, then track the answer

```
./scripts/mavp-operator --feedback --file <path>
```

The command allocates the next id for your alias (`<alias>-1`, `<alias>-2`, and so on, safe against two simultaneous submissions) and prints `feedback: <id> written to <inbox>`. It also runs a non-blocking scan of what it wrote; a finding prints `advisory: [<category>] line <n> of <id>.md may carry private content — review the item`. The item is already written when that line appears, so read it and edit the file if needed. If the file you submitted was a draft (see below), it is removed once the item is written (`feedback: draft <path> removed`).

**Where the inbox is.** The inbox is per user, not per project: the directory named by `MAVERICKS_INTAKE_DIR` when that variable is set, otherwise a `.mavericks-intake` directory in your home directory. Items are plain markdown files named `<id>.md`; drafts live in a `drafts` subdirectory. Every project you run on the machine shares one inbox, separated by alias. The local channel reaches the maintainer only if the maintainer reads that same directory (the same machine, or a shared `MAVERICKS_INTAKE_DIR`); use the GitHub channel for everyone else.

**Follow an item.**

```
./scripts/mavp-operator --feedback --status
```

prints one line per item of your alias in the form `<id> <kind>/<severity> — <title> — <disposition, or "new"> — <ships in, or —> — <retire workaround, or —>`. When an answer arrives, acknowledge it so the session-start reminder clears:

```
./scripts/mavp-operator --feedback --ack <id>
```

The command prints `feedback: <id> acknowledged <date>`. At session start, `--agent` reports `feedback_answers_unacked` (answers you have not acknowledged) and the session-start skill renders it as `Feedback answers: N — run ./scripts/mavp-operator --feedback --status`.

**Fetch the answer to an item you posted on GitHub.** An item posted with `--feedback --github` (next sections) is answered by a comment on its public issue, not in your inbox. Until you fetch that comment, `--status` shows the item as `new`, with a pointer appended to its line: `— posted as <owner/repo>#<number>; run --feedback --pull`. Fetch it with:

```
./scripts/mavp-operator --feedback --pull
```

It is read-only on GitHub: after the same `gh` check as `--github` (the GitHub CLI must be installed and authenticated, otherwise it refuses before reading anything), its only calls are one `issue view` per item of your alias that was posted to GitHub, and it never writes to GitHub. It needs no operator confirmation, and the only thing it sends is the issue reference (the repository and the issue number). It prints one line per item:

- `pulled: <id> (<owner/repo>#<number>) — <disposition> — <ships in, or —> — by <login>` — an answer was found and stored on the item; `--status` now shows the disposition, the version that ships the fix and when a workaround can go, and `--migrate` can judge your tagged workaround.
- `no answer yet: <id> (<owner/repo>#<number>)` — the issue has no comments.
- `ignored: <id> — N comment(s) not from the maintainer or not in answer form` — the issue has comments, but none is believed (see "Known limits").
- `unchanged: <id>` — the stored answer already matches the newest accepted comment.
- `updated after your acknowledgement: <id>` — the maintainer re-posted a changed answer after you had acknowledged it; run `--ack` again.

and ends with `feedback: N answer(s) pulled`. With no GitHub item to look up it prints `feedback: no GitHub items for <alias>` and calls nothing. Only the disposition, ships-in and retire-workaround values, the published date and the Answer section of an item that already exists are written; the fields you wrote and your acknowledgement are never touched, and no file is created. The newest accepted comment wins. A pulled answer reaches `--agent` and the session-start reminder exactly as a local one does. (The `pulled:`, `no answer yet:`, `ignored:`, `unchanged:` and summary lines above are copied from the command's source, `scripts/mavp-operator-feedback.js`.)

## Capture during a session, approve at the end

This is the flow the session-start skill drives; the coordinator follows it without asking the operator how.

1. **Note.** When something in the framework causes friction or you have a proposal, add a list item to `EXECUTION_LOG.md` that starts with the date (optional) and the literal token `mavp-feedback:`, then a short description, then optional hints:

   ```
   - 2026-10-25 mavp-feedback: <short description> (area: <text>; kind: bug|proposal|question)
   ```

   The token is matched only as the first text after the bullet and date. A log entry that merely discusses the convention should cite the token mid-line and in backticks, never as the first text after the bullet, or it is read as a real note.
2. **List.** At session end, `--close-session` prints a `Feedback from this session: N noted, M drafted` block when there are notes added to `EXECUTION_LOG.md` since the previous close-session commit (the whole file when no previous close commit is readable) or existing drafts. It lists each undrafted note with a ready-to-run `--feedback --draft` command; a note whose title matches an already submitted item or an existing draft is listed with that fact instead of a command. It prints nothing when there is nothing to report, and it does not run in the framework repository itself. When no alias is stored, the block also prints the `--set-alias` line to run first.
3. **Draft.** For each note, the coordinator runs `--feedback --draft "<title>" [--summary "<one line>"] [--area <text>] [--kind bug|proposal|question]`. This writes a pre-filled copy of the template to the inbox's `drafts` directory, prints `draft: <path> — fill Observed/Evidence/Proposal; submission happens only after the operator approves it`, and allocates no item id. Fill in the three sections.
   `--feedback --drafts` lists your drafts as `<path> — <title> — <summary, or first line of Observed, or —>` and `--feedback --discard <draft path>` deletes one (it refuses any path that is not one of your drafts).
4. **Approve.** The coordinator raises one approval modal listing the drafts by title and one-line summary, multi-select, with "Send none". The operator selects what goes. The session-start skill carries the exact rule.
5. **Submit.** Only the approved drafts are submitted, each with `--feedback --file <draft>`. The rest stay drafts and are listed again at the next session. A headless run keeps its drafts for the next interactive session.

The operator's approval covers local-inbox submission only. Publishing to GitHub needs its own confirmation (next section).

## Post publicly on GitHub (optional)

```
./scripts/mavp-operator --feedback --github (--file <path> | --item <id>) [--repo <owner/repo>] --operator-confirmed "<statement>"
```

`--file` submits a new item and posts it; `--item` posts an item already in your inbox (and refuses one that is already posted: `feedback: <id> is already posted as <ref>`). The repository defaults to the framework's public mirror; override it with `--repo` or the `MAVERICKS_FEEDBACK_REPO` environment variable. The GitHub CLI (`gh`) must be installed and authenticated; if it is not, the command refuses before posting.

The steps run in a fixed order, and a failure at any step posts nothing: operator confirmation, composing the issue, the blocking outbound scan, the `gh` check, the label check, the post. On success it prints `feedback: <id> posted as <owner/repo>#<number>` and records the issue reference on the item. If the post fails after `--file` created the local item, that item is removed again so you can retry cleanly. The issue title has the form `[mavp-feedback] <id>: <title>`, and the issue gets the `mavp-feedback` label when the repository has one; otherwise the command prints `label mavp-feedback not found on <owner/repo>; posting unlabelled` and posts anyway.

### What leaves the machine

Nothing leaves the machine on the local channel; the item is a file in your inbox. A GitHub post sends exactly these fields and nothing else:

- **The title**, as the issue title (`[mavp-feedback] <id>: <title>`) and the first line of the issue body.
- **Header fields:** Schema, Item, Adopter (your alias), Framework version, Kind, Severity, Area, Submitted, Channel, and Workaround (the tag, when you set one).
- **Three sections:** Observed, Evidence and Proposal — free text you wrote.

**Never sent:** the Summary field; the Issue reference; every framework-written field (Disposition, Ships in, Retire workaround, Triaged, Published, Acknowledged) and the Answer section; any other item; your `PROCESS_STATE.json`, `BACKLOG.md`, `TASK_STATUS.md`, `EXECUTION_LOG.md`, source files or memory; and your inbox path. The command reads `PROCESS_STATE.json` only for your alias and the framework version stamp, plus the item it posts and the private-name lists described below. Reading the answer back with `--feedback --pull` sends one thing: the issue reference (repository and issue number) of each item you posted, through a read-only `gh issue view`; none of your item's content leaves the machine on that step.

Two gates stand between an item and the public repository. Neither can be skipped by a flag.

1. **A blocking outbound scan.** The title and body are checked before any `gh` call. The scan uses the framework's publish-scanner categories (private repository names from the list described next, absolute home-directory paths, credential and token shapes, email addresses on non-reserved domains) plus two outbound-only categories: absolute home paths on Linux and on Windows. macOS, Linux and Windows home paths all block. A finding blocks the whole post: the command prints one `[<category>] line <n>` line per finding (the matched text is never echoed), then `BLOCKED: nothing was posted`, and exits non-zero. The scan covers the free text you wrote; it is a safety net, not a redaction tool, and it recognises only the names on its list.
2. **The operator's confirmation.** `--operator-confirmed "<statement>"` is required, and its value must be the operator's own words from the current session authorizing this post, passed verbatim — never inferred from context or a prior session, never an agent paraphrase. Without it the command prints `--feedback --github posts to a public GitHub repository and needs operator confirmation.` followed by the instruction, and exits 1.

**The private-name list.** The scan's private-name check is the union of three sources: a `.mavp/private-names` file in your project (comma-separated names), the framework's own `.mavp/private-names` file, and the `MAVP_PRIVATE_NAMES` environment variable. A name ending in a hyphen is a family prefix that matches any hyphenated identifier starting with those letters. **If you want to use the GitHub channel, list your private repository and project names in `.mavp/private-names` in your project, or in `MAVP_PRIVATE_NAMES`, before you post.** The framework's list is not shipped to you, so without your own entries the check has nothing to match. When the union is empty, the command prints a non-blocking `NOTE: private-name detection inactive — no names in <project>/.mavp/private-names, the framework's .mavp/private-names, or MAVP_PRIVATE_NAMES` and the home-path and credential checks still run.

### Known limits

These are accepted boundaries, not oversights. Plan around them.

- The scan only finds names that are on its list. A private name you did not list, a paraphrase of one, or confidential information with no recognisable shape passes. Read the item before you confirm.
- The alias check at `--set-alias` time reads the framework's list and `MAVP_PRIVATE_NAMES` only, not your project's `.mavp/private-names`, so a private name that only your project lists is not caught when you choose the alias. The outbound scan does read your project's list, so it still blocks any public post that carries it.
- Case and look-alike variants of the maintainer-side brief marker lines are not neutralised (see the next part); the untrusted-input header line and exact-marker neutralisation cover the realistic case.
- Answers arrive only when you run `--feedback --pull`. Nothing runs between sessions, so an answer posted on GitHub is invisible to `--status`, `--migrate` and the session-start reminder until you pull it.
- Only a comment by the repository owner, or by any member of the organisation when the feedback repository is organisation-owned, in the framework's answer form (a comment that opens with a `Disposition: <value>` line, as `--intake --publish-answers` writes it) is accepted; any other comment is counted as `ignored`. The default feedback repository is the framework's user-owned mirror. On an organisation-owned repository, any member (including one with read-only access) can post a comment in answer form, and an accepted `fixed-in` answer makes `--migrate` say `retire` for your tagged workaround. Keep the default user-owned mirror, or restrict the organisation's membership, if that matters to you.
- The `--migrate` posted-as hint also shows on a GitHub item answered `by-design` or `deferred`: the workaround genuinely stays open, and the hint is a pointer to the issue, not a sign that an answer is missing.

## Tag your workarounds, and retire them with `--migrate`

A workaround you wrote for a framework problem stays in your project after the problem is fixed, because the framework never edits your rules, notes or docs. The tag convention is what lets you find those later.

**The convention.** Place the literal marker `mavp-workaround:` followed by the item id on the same line as any rule, memory entry or doc line you wrote to dodge that item. In template terms: `mavp-workaround:<alias>-NNN`, where `<alias>-NNN` is the item's id. Set the item's **Workaround** field to any short non-empty text before you submit; the submission then records the exact marker for the id it allocated, in the item's Workaround field. Because the id is allocated at submission, submit first, read the id from the `written to` line or from `--status`, and then add the marker beside your workaround.

**Retire.** Run:

```
./scripts/mavp-operator --migrate
```

It is read-only: it writes no file and changes nothing in your project, your memory or your inbox. It scans the files git tracks in the repository (the whole tree when the project is not a git work tree; files over 2 MiB and binary files are skipped, and untracked files in a git repository are not scanned) plus the markdown files in the harness memory directory for your project, and prints one line per tag it finds:

- `retire: <file>:<line> — <tag> — fixed in T-NNN, released in <version> (installed <version>)` — the fix is in the version you have installed; remove the workaround by hand.
- `keep: <file>:<line> — <tag> — ships in <version, or "a future release">` — fixed, but not in your installed version yet.
- `keep: <file>:<line> — <tag> — open` — no fix recorded.
- `unknown item: <tag> (<file>:<line>)` — the tag names an id that is not in your inbox.

and ends with `workaround retirement: N to retire, M to keep`. You apply every change yourself. It needs a stored alias (`migrate: no feedback alias in PROCESS_STATE.json — set one with: --feedback --set-alias <alias>`). After an `--update` that installs a fix for one of your tagged workarounds, the update itself ends with `workaround retirement: N tagged workaround(s) now fixed in the installed version — run ./scripts/mavp-operator --migrate`.

**The harness memory directory** is best-effort and harness-owned. The path `--migrate` looks in is derived from your absolute project path under `~/.claude/projects/<cwd-slug>/memory/`; if the harness names it differently, the command finds nothing there and scans the repository only, so check your memory by hand.

**What `--migrate` can and cannot know.** It judges each tag by the disposition recorded on the item in the inbox it reads, and it never calls GitHub itself. If the maintainer triages in that same inbox, `--migrate` reports `retire` as soon as the fix is released at or below your installed version. If your item was answered through a public GitHub comment, run `--feedback --pull` first: it stores the answer on the item, and `--migrate` then judges it exactly as it judges a local one, for example `retire: CLAUDE.md:3 — mavp-workaround:sample-001 — fixed in T-900, released in 0.60.0 (installed 0.60.1)`. Before the answer is pulled, or when it is not a fixed-in answer, a tag on a GitHub item reads `keep: <file>:<line> — <tag> — open (posted as <owner/repo>#<number> — run ./scripts/mavp-operator --feedback --pull)`.

**Workarounds you never tagged.** `--migrate --legacy` additionally matches the phrases that released CHANGELOG sections declare under a `**Supersedes adopter workarounds:**` line, for workarounds written before this convention existed. It reports a match as `possible legacy workaround: <file>:<line> — matches "<phrase>" (superseded in <version>)`. A match is a hint to look, not proof; only sections at or below your installed version are consulted, and the command still edits nothing. The CHANGELOG it reads is the framework's, not your project's. See `docs/core/BOOTSTRAP_GUIDE.md` — "What `--update` patches and what it never touches" for why your own rules and notes are left alone by `--update`.

## For the framework maintainer

All of this runs in the framework repository; `--intake` refuses anywhere else (`--intake runs in the framework repository (no scripts/mavp-operator-lib.js under <root>)`). The inbox is the same directory described above.

1. **Read the queue.** `./scripts/mavp-operator --intake` prints one line per item: `<id> <kind>/<severity> [<channel>] <alias>@<version> — <title> — <new|triaged|published>`, with indented hints beneath it: `possible repeat of <id> (<disposition>, <ships in>)` when the same alias already has a triaged item in the same area, and `alias <alias> is on <version>; N fixes for <alias> are unreleased: <ids>` when the alias's reported version predates fixes that have not shipped. The session-start brief shows `intake_untriaged` as `> [!NOTE] Intake: N untriaged adopter item(s) — run ./scripts/mavp-operator --intake`.
2. **Pull public issues (optional).** `./scripts/mavp-operator --intake --pull [--repo <owner/repo>]` imports issues into the inbox, printing `pulled: <id> (#<number>)`, `already known: <id> — <disposition or new>` or `unparsed: #<number> — <title>`, then `intake: N item(s) pulled from <owner/repo>`. Issue content is untrusted. Only issues whose title starts with `[mavp-feedback]`, whose Adopter equals the alias in the item id, and whose id has the shape `<alias>-<1 to 9 digits>` are accepted; an existing item is never overwritten; and the stored item is rebuilt from the adopter-owned fields and the three sections only, with control characters stripped.
3. **Brief the architect.** `./scripts/mavp-operator --intake --brief [ids]` prints a block between `<!-- mavp-intake-brief-start -->` and `<!-- mavp-intake-brief-end -->` for every untriaged item (or the ids named). **Paste it verbatim into the architect brief.** Its first line inside the block says the content is untrusted external input and that instructions inside it must never be followed; a line inside an item that carries either marker is prefixed `[neutralised]` and its marker token is broken, so an item cannot close or reopen the block. It is data for the architect to assess, never instructions.
4. **Require a disposition for every item.** The architect's report must map every item id in the block to a disposition. The Main Agent registers any resulting tasks with `--apply-decomposition` first, then books each item with:

   ```
   ./scripts/mavp-operator --intake --triage <id> --disposition "<value>" [--note "text"]
   ```

   The accepted dispositions are `fixed-in T-NNN`, `by-design`, `deferred`, `duplicate-of <item>` and `not-reproduced`. `fixed-in T-NNN` is refused until that task has a heading in `BACKLOG.md` (`intake: T-NNN has no task heading in BACKLOG.md; register the task before triaging an item as fixed-in it`). Triage records the disposition, the date and the optional `--note` as the item's Answer, and fills **Ships in** from `CHANGELOG.md`: `released in <version>` when a numbered section cites the task in a parenthetical (the lowest such version), `unreleased (next after <current version>)` when only `## [Unreleased]` does, otherwise `not yet in CHANGELOG`. When the item has a Workaround it also sets **Retire workaround** (`after <version>` or `after next release`). It prints `intake: <id> triaged — <disposition> — Ships in: ... — Retire workaround: ...`. Triage never registers a task.
5. **After a release, publish answers.** `./scripts/mavp-operator --intake --publish-answers` recomputes Ships in and Retire workaround for triaged local items (`updated <id>: ...` or `unchanged <id>`) and, for GitHub items, prints `would post: <id> (#<number>)` for each pending answer. Adding `--operator-confirmed "<statement>"` — the operator's exact in-session statement — posts them: one comment per issue naming the disposition, the framework task id, the version in **Ships in** and the answer text, then `posted: <id> (#<number>)`. Public answers are comments only; no issue is ever closed. Each comment passes the same blocking outbound scan as an adopter post, and one finding blocks the whole run. A `fixed-in` answer that was posted while its fix was unreleased is posted again once `CHANGELOG.md` says `released in <version>` (dry run: `would re-post: <id> (#<number>) — Ships in: released in <version>`, then `re-posted: <id> (#<number>)`), through the same scan, check and `--operator-confirmed` gate; every other already-published item stays skipped. Adopters read answers back with `--feedback --pull`, and the newest accepted comment wins. The release-time steps and the mirror-side issue template and label are in `docs/PUBLIC_RELEASE_STRATEGY.md`.

## Command reference

| Command | Side | Effect |
|---|---|---|
| `--feedback --set-alias <alias>` | adopter | stores `feedback_alias` in `PROCESS_STATE.json` |
| `--feedback --file <path>` | adopter | submits an item to the local inbox; removes the file if it is a draft |
| `--feedback --status` | adopter | lists your items with disposition, ships-in and retire values |
| `--feedback --ack <id>` | adopter | stamps the answer acknowledged |
| `--feedback --pull` | adopter | reads the answer comment on each posted GitHub item back into your inbox; read-only on GitHub, needs `gh`, no confirmation |
| `--feedback --draft "<title>"` | adopter | writes a pre-filled draft; no id allocated |
| `--feedback --drafts` / `--discard <path>` | adopter | lists / deletes your drafts |
| `--feedback --github (--file <path> \| --item <id>) --operator-confirmed "<statement>"` | adopter | posts a public issue after the scan |
| `--migrate [--legacy]` | adopter | read-only retirement checklist |
| `--intake` | framework | lists the inbox with hints |
| `--intake --brief [ids]` | framework | prints the architect brief block |
| `--intake --triage <id> --disposition "<value>" [--note "text"]` | framework | records a disposition and answer |
| `--intake --publish-answers [--operator-confirmed "<statement>"]` | framework | refreshes ships-in; posts answer comments |
| `--intake --pull [--repo <owner/repo>]` | framework | imports public feedback issues |
