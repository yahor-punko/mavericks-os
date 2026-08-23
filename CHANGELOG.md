# Changelog

All notable changes to Mavericks are documented in this file, in a format
inspired by [Keep a Changelog](https://keepachangelog.com/). For how the
framework actually works, see [README.md](README.md) and the core process
docs in [`docs/core/`](docs/core/).

## [0.47.3] — 2026-08-23

- **The T-718 CHANGELOG-omission advisory no longer fires on a release bump-and-fold commit that touches only `scripts/mavp-version.js` and `package.json` alongside `CHANGELOG.md` itself** (T-724) — a shape-based exemption, not a path exemption: it recognizes the §5 version-ritual file set specifically, so a standalone `package.json` dependency change (no `CHANGELOG.md` fold) still fires, and a ritual commit that also smuggles in another shipped file still fires too.

## [0.47.2] — 2026-08-23

Entries below carrying the inline marker **(shipped in `v0.47.1`, documented late)** — and only those — describe normative rules that were **already in force at that tag**: `v0.47.1`'s `CHANGELOG.md` section covered only T-710 and froze the moment the tag was cut (`docs/PUBLIC_RELEASE_STRATEGY.md` §5 — "Frozen-section rule"), so their notes could not be added to it afterwards. The `## [0.47.1]` section is left exactly as shipped; the marked entries are the correction record. If you are reading a marked entry under a later version heading, the rule it describes did not arrive in that version — it has been in force since `v0.47.1`. Every unmarked entry is an ordinary release note: the change it describes first ships in the version this section is published under.

### Added

- **Before booking `merged` on a task with no QA stage, the Main Agent now owes one executed check against the report's weakest unverified claim** (T-712, T-713; shipped in `v0.47.1`, documented late) — `docs/core/ORCHESTRATION_RULES.md` gains a "Booking-time claim verification (merge duty — before booking `merged` on a task with no QA stage)" section, the return-side sibling of the existing Executed-check rule that governs claims written *before* a spawn. Its premise: **a prose characterization of runtime behavior is a runtime claim.** "Fails silently", "never blocks", "exits 0", "warns and continues", "degrades to a no-op" are assertions with an executable check behind them, and being written as prose in a sub-agent's report rather than as an assertion in a test does not change what they are — a report is not evidence for its own factual claims, it is the set of claims to be checked. On a task with `artifact` or `unit` verification type, `CLAUDE.md`'s "Verification types" convention waives the QA agent pass, so whatever the Main Agent accepts is what ships. Before booking `merged` on such a task, identify the report's factual claims that have no execution behind them and run the **cheapest disconfirming** check against the **weakest** one: one grep at the named function, one run of the named command, one read of the docstring the claim characterizes — not an exhaustive re-verification. If the weakest claim survives, the report has earned the rest of its trust; if it does not, nothing else in the report is trusted until it is corrected. **Weakest, not pre-flagged:** verification attention already follows the brief's own risk annotations, so the unflagged claim is the one that arrives unverified — the failure mode is thorough verification in exactly the place already marked as risky while an unanticipated claim rides through beside it, which is why the rule says to deliberately exclude the claims the brief pre-flagged when choosing the target. This is explicitly **not** "reaching in": the orchestrator discipline forbids the Main Agent from doing the sub-agent's work, but verifying a sub-agent's claims before making them durable is a merge-gate action, and on a QA-less task it is the only gate that exists. The incident it closes (2026-08-23, T-708/T-709): an `artifact`-verified report characterized a code path as "a silent-degradation question" and that characterization merged into a living normative doc a reviewer reads as fact — while the code prints a red WARNING at the moment of the skip and its own docstring says "never a silent skip", one grep from the code the sweep had just read. DR-013 in `docs/core/DECISIONS.md` records the ruling behind the section, and its `Documented in:` line now names the section itself, completing the forward reference (T-713).
- **`--close-session` now warns when a just-completed task's evidence commit touched a ship-classified file but the task is never mentioned in `CHANGELOG.md`** (T-718) — printed once, non-blocking, before the results table in both interactive and non-interactive modes; silent when the task is already mentioned, or when git, `scripts/publish-manifest.json`, or `CHANGELOG.md` itself is unavailable. Never changes the exit code or the session-commit contract.

### Changed

- **The T-718 CHANGELOG-omission advisory no longer flags a commit that touches only `CHANGELOG.md`** (T-721) — its first live run at wave 94's close proved a self-referential false positive: a commit that writes a release note tripped the check asking whether the release note mentions it (T-716, T-719), while a genuinely undocumented ship-touching commit (T-717) still fires correctly. `CHANGELOG.md` is now exempted at the advisory's own ship-intersection check via a named constant; a commit touching `CHANGELOG.md` alongside another ship-classified file is unaffected and still fires.
- **Per-operator memory is now the *residual* codification route rather than one that fits everything, and the codification mandate governs any durable lesson — not only ones written up in an RCA** (T-711, DR-013; shipped in `v0.47.1`, documented late) — `docs/core/RCA_CODIFICATION.md` routes every root cause to exactly one of five durable mechanisms, but gave route (c), the per-operator memory-index entry, only a *fit* test. That test is unfalsifiable in practice: every lesson is rememberable, so route (c) fits every cause, and it is the one route that costs no task, no architect gate and no review — so absent a precedence rule the cheapest route silently won every tie, and on 2026-08-23 a framework-portable lesson went to memory instead of into the framework. **The deciding test is now portability:** *would this lesson be equally true for a different operator running this framework on a different machine?* **Yes → framework-level:** the cause must route to a `.claude/rules` edit proposal, a role-spec proposal via `SKILL_PROPOSALS/`, an armed recheck, or a mechanical enforcement change, and memory may then hold **at most a pointer** — an entry naming the `T-NNN` or artifact that actually carries the rule. **No → operator-scoped:** memory is the correct and only sensible home. This is a tie-break, not a ban and not a ranking of all five routes — operator-personal lessons (a language preference, this machine's git identity, this operator's permission posture) legitimately live in memory, and route (c) remains optional infrastructure: an operator whose harness provides no memory index at all loses nothing, because nothing framework-level may ever live *only* there. What the rule forbids is the one direction that hurts adopters — a lesson that would hold for any operator going only to memory, where it is invisible to adopters, invisible to the reflection loop in `docs/SKILL_OPTIMIZATION.md` (which mines task outcomes, never memory), and not greppable over the repo. The same routing table and test now govern **any** durable lesson, including one noticed mid-session with no RCA behind it: the mid-session reflex "I should write this down so I remember it next time" is itself the trigger to run the portability test — before the memory entry is written, not after — and a framework-level verdict owes a task registered through the normal architect gate, with writing it to memory not a substitute and smallness not a reason to skip the gate. Enforcement is deliberately pull-consumed — no validator check and no hook, because a memory write lands outside the repo tree where nothing observes it and portability is a semantic property no matcher could judge — with a compensating observable form: a memory entry recording a framework-portable lesson must name inline the task or artifact that carries the rule, so a pointer with no carrier named is the visible failure. `templates/RCA_TEMPLATE.md` and `CLAUDE.md`'s "RCA-to-codification" convention carry one-line pointers to the tie-break.
- **The version-bump trigger and the release-note trigger are now explicitly separate, so a doc-only wave can owe a release note while owing no version bump** (T-717) — `docs/PUBLIC_RELEASE_STRATEGY.md` §5's per-wave bullet previously said a doc-only wave needs no version bump "and therefore no changelog entry either — the two triggers stay in lockstep". They are not in lockstep, and that clause was the codified cause of a real gap: wave 93 changed five `ship`-classified files, shipping normative rules to adopters inside `v0.47.1` with no release note at all — correctly, by the rule's own text. The two triggers now read separately. A **version bump** is owed by script or capability changes, per §5's unchanged bump policy. A **release note** is owed by any wave that changes content classified `ship` in `scripts/publish-manifest.json`, *including a doc-only wave*: such a wave owes no bump, but the rules it changed reach adopters on the next mirror sync regardless of the version stamp, and a rule that arrives unannounced is a rule adopters have no reason to look for. Because every path's `ship`/`exclude` classification is already recorded in the manifest, "does this wave owe a note?" is mechanically decidable rather than a judgment call. When a bump accompanies the note, the note opens the new numbered section as before; when no bump accompanies it, it goes under `## [Unreleased]` and is folded into the next numbered section at the next bump. `CLAUDE.md`'s "Version bump" convention keeps "Doc-only waves need no bump" verbatim and gains the matching note-owed clause pointing at §5. The rule caught its own author: T-717's commit changed `CLAUDE.md` — itself `ship`-classified — and left no release note, the T-718 advisory flagged the omission at the next wave close, and this entry is that note.

## [0.47.1] — 2026-08-23

### Added

- **The worktree-hygiene advisory now names the ready-to-run dry-run prune command whenever a worktree is actually prunable** (T-710) — at a recent wave close the advisory read `... (15 prunable)` and named no next step, leaving the operator to recall `--prune-worktrees` unprompted. A new `formatWorktreePruneSuggestion()` composes a second, propose-only line after the unchanged counts line in both `--close-session` modes and `--worktree-report`: it is `null` whenever nothing is prunable (including when clean-and-integrated worktrees exist but are all held back by the mtime safety window — a stale hint would be worse than no hint), and otherwise names the exact dry-run form `./scripts/mavp-operator --prune-worktrees`, **never** `--yes`, appending a clause attributing any clean-and-integrated/prunable gap to the mtime window. `--prune-worktrees` itself never calls the new function, and the existing `UnresolvableMainRefError` stand-down line carries no suggestion text — a suggestion derived from a classification that never ran would be an unsound proposal.

## [0.47.0] — 2026-08-22

### Added

- **A skill-reflection proposal now discloses how many failure trajectories its recommendation actually rests on, and names them** (T-700) — a proposal could previously generalize from a single failing case while the metadata alongside it showed a corpus of hundreds, with nothing to tell a human reviewer the two numbers described different things. Each proposal's contrast section now states the failure-batch size it was built from and lists the trajectories in it, and prints a non-blocking warning when that count sits below three — the same threshold the optimizer's own instructions now tell it not to generalize from. The disclosure text is shared between the printed warning and the proposal body itself, so the two cannot drift apart, and nothing about this is enforced by an exit code — a small batch still produces a proposal, just a clearly labeled one.
- **The skill-reflection optimizer now discloses which of this project's own operating constraints it was never shown, and every generated proposal carries an explicit conflict-check step** (T-703) — the optimizer prompt is built from only the role spec and two scored minibatches, and had never seen `.claude/rules/*.md`, `CLAUDE.md`, or `docs/core/ORCHESTRATION_RULES.md`; on a live adopter run it proposed, in good faith, a developer-spec edit that would have re-created a measured incident already prohibited by those rules. The prompt now names the corpora it was not given and prohibits edits mandating process-level behavior (test-execution scope, git operations, push/commit rituals, task registration or status, permissions), directing any such observation into rationale text instead. The optimizer's own JSON response contract is unchanged. A matching checklist now travels inside every generated proposal file, not only in `docs/SKILL_OPTIMIZATION.md`, so an adopter reviewing a proposal in their own repo sees the same reminder.

### Changed

- **Skill-reflection's train/holdout split is now deterministic and stratified, so re-running reflection today can produce different proposals than an earlier run over the same growing trajectory log** (T-699) — the split previously behaved chronologically in effect, which meant training only ever saw the oldest era of trajectories and let recent failures quietly never reach the optimizer at all. The split is now built to guarantee failing trajectories are represented in proportion, ordered numerically rather than by insertion order, and reproducible given the same input. **If you re-run `--reflect-skill` and get a different proposal than before, this is why** — the split is now seeing failures the old logic was structurally excluding, not a change in the underlying trajectories themselves.
- **Strings that previously blocked the `next_action` volatile-facts gate now pass it** (T-694) — the gate's own remediation message was telling writers to rewrite a blocked directive into a form the matcher itself still refused, because the message and the matcher disagreed about which nouns mark a version literal as an instruction's target rather than a state claim. Both now derive from one shared list, and `promotion` has joined the accepted nouns alongside `bump`/`release`/`section`/`version` — so a directive like "run the 0.46.2 promotion" now passes where it previously blocked. This is an observable behavior change in a commit-blocking gate: a `next_action` write that failed validation before this release may pass unchanged after it.

### Fixed

- **`--reflect-skill` could crash on a live optimizer response, and reported the crash under a misleading label** (T-697) — the response handler assumed the model's first content block was always plain text and indexed into it unconditionally; a response that led with a different block type (observed in a live adopter run) crashed instead of being handled, and the resulting error was reported as if it were a transport failure rather than a response-shape problem it should have caught and named honestly.

## [0.46.2] — 2026-08-22

### Added

- **`--close-session` now prints a post-push CI-verification reminder at every push-adjacent output point** (T-689) — a push completing was previously treated as the end of the wave-closure contract, and canonical `main` sat CI-red across two consecutive pushes because nothing after the push prompted anyone to go check. This project's own recorded precedent for a prose-only human step getting silently skipped is the DR-008 gate-ledger review, itself only closed by a printed reminder (T-668) — the same remedy now applies here. The reminder appears in the interactive confirmed-push path, the `--push` auto-push path, and appended to the non-interactive git-push reminder, so all three ways a session can end with a push get the same nudge to confirm CI is green on the pushed commit before opening the next wave. Text only — the script still never executes `gh` or any other external call, preserving both the zero-external-dependency posture and the single human checkpoint the push step already relies on.

### Fixed

- **A test executing a generated adopter artifact could silently exercise a different codebase than the one actually under test** (T-690) — a spawn that inherits its environment unpinned can fall through a home-directory resolution chain to a machine-shared clone of the *published* framework rather than the checkout whose HEAD the test is meant to cover, so a broken change could pass locally and only fail — or worse, pass for the wrong reason — once it reached CI. This is exactly how canonical `main` sat CI-red across two consecutive pushes on 2026-08-21. `.claude/rules/scripts.md` now codifies a hermetic-test authoring rule: any test executing a generated adopter artifact (a wrapper script, a hook command), or any process whose framework-root resolution consults the home-directory chain, must pin the framework-root environment variable explicitly rather than inherit it. `CLAUDE.md`'s wave-closure contract is extended to match — a wave closes on the push being complete **and** CI on the pushed commit reading green, not on the push alone.

## [0.46.1] — 2026-08-21

### Fixed

- **The adopter wrapper generated by `buildBashWrapper()` (`mavp-install.js`) was silently missing dispatch entries for five flags the canonical `scripts/mavp-operator` dispatches** (T-685) — `--archive-merged`, `--park-wave`, `--unpark-wave`, `--worktree-report`, and `--prune-worktrees` previously rendered the dashboard at exit 0 in every adopter project (T-679's unrecognized-flag gate later turned that into an honest exit-1 refusal, but the flags still didn't work). All five now dispatch via `$MAVERICKS/...` with matching `--help` lines, using zero script changes — each target script already resolves its root from `MAVERICKS_PROJECT_ROOT`, which the adopter wrapper already exports. The dashboard fall-through branch and the `MAVERICKS_PROJECT_ROOT` export are structurally untouched. A new self-deriving test, `scripts/test-wrapper-flag-parity.js`, extracts the dispatched-flag token set from both wrappers and asserts set equality (modulo an explicit, currently-empty exception list), so the next canonical-only flag is caught at test time instead of in an adopter project.

## [0.46.0] — 2026-08-21

### Added

- **`mavp-publish-release.js` now hard-gates on the mirror's own CI going green at the exact edge tip being promoted** (T-680) — the ubuntu × mirror-tree verification cell (the one that historically caught the 0.39.0 and 0.40.0 defects, only after they had already reached the mirror) previously existed nowhere except at promotion time itself, and `workflow_dispatch` cannot manufacture it (it routes exclusively to the macOS-only job — see `.github/workflows/ci.yml`). `.github/workflows/ci.yml`'s `push` trigger now also fires on `edge` (inert on canonical, since no `edge` branch exists there; free on the mirror, since it only measures the working-build cadence already in place). The release script queries `GET /repos/{owner}/{repo}/actions/runs?head_sha=<sha>` via `node:https` built-ins — read-only, unauthenticated, no `gh`, no new dependency — for the step-3-resolved `origin/edge` SHA, and refuses (naming the SHA, the observed state, a recovery action, and the mirror's Actions URL) unless the latest CI-workflow run is `completed`/`success`. Fails closed on any API error. Engages only when `origin` parses as a github.com remote — the local-path fixtures this script's own test suite uses stand down with one named skip line, unconditionally (no operator flag reaches that path). No skip flag, no `--force`.

### Fixed

- **The shipped 0.45.0 T-567 entry and `docs/core/ORCHESTRATION_RULES.md` both misattributed ownership of the residual hand-typed raw-git integration vector to the T-626 accepted-boundary row in `docs/core/GATE_LEDGER.md`** (T-678) — that row actually covers a different vector: the live-execution vector into the machine-shared `~/.mavericks` framework-source clone, undetected between installs. The residual raw-git vector (a hand-typed `git cherry-pick`/`git merge` run directly against the shared main checkout instead of through `--integrate`) now has its own dedicated accepted-boundary row in `docs/core/GATE_LEDGER.md`'s "Accepted boundaries" section, anchored to T-567's 2026-08-05 scope ruling rather than to a deprecated task, with its own reopen trigger and an explicit statement of what holds the boundary today. `docs/core/ORCHESTRATION_RULES.md`'s ownership sentence now points at that new row instead of the T-626 row. The already-tagged `## [0.45.0]` section's own copy of the false clause is frozen and left as shipped — this entry is the correction record.
- **Both operator wrappers (`scripts/mavp-operator` and the adopter wrapper `mavp-install.js` generates) silently rendered the dashboard at exit 0 for ANY unrecognized flag, instead of refusing** (T-679) — an unrecognized argument previously fell through a bare `else` straight into the dashboard branch, masking typos and any flag newer than the wrapper (observed live 2026-08-21: a pre-T-567 `--integrate HEAD` call rendered the dashboard and exited 0 instead of failing, which is how the missing dispatch entry stayed invisible). Both wrappers now gate the dashboard branch on exactly zero arguments or `--watch` (the dashboard's only self-parsed flag) and refuse any other unrecognized argument at exit 1, naming it and pointing at `--help`. **Accepted consequence:** the adopter wrapper's dispatch chain has never had entries for `--worktree-report`, `--prune-worktrees`, `--park-wave`, `--unpark-wave`, or `--archive-merged` — those five flags now go from silently rendering the dashboard at exit 0 to being explicitly refused at exit 1 in the adopter wrapper. They did not work in the adopter wrapper before this change either; this is an honest failure replacing a silent one, not a regression. Adding the missing dispatch entries for those five flags is a separate, not-yet-scheduled concern.

## [0.45.0] — 2026-08-21

### Added

- **The "never-a-project" refusal guard (T-624) now also catches a linked git worktree, not just a never-installed tree or `$HOME/.mavericks`** (T-670) — every mutating operator ritual command refuses — exit 1, before any file write — when the resolved repo root is a linked (non-primary) git worktree of a real project, closing the operator-command face of the cwd-persistence class: a relative operator invocation with cwd inside a linked worktree previously silently wrote the WORKTREE's `BACKLOG.md`/`TASK_STATUS.md`, diverging from main. `checkNeverAProjectRoot()` gains a third discriminator via the existing `listGitWorktrees()` helper: it blocks when the resolved root realpath-equals a NON-FIRST entry in `git worktree list --porcelain` (which always lists the primary/main worktree first) AND that first entry is not bare. The bare exemption matters — a bare-repo-plus-worktrees layout has no primary checkout at all, so every checkout there is "linked" by this definition, and without the exemption the guard would permanently block every mutating command for that adopter layout. The refusal message names the primary checkout path alongside the existing discriminator and override-env-var text; the override env var `MAVERICKS_ALLOW_NEVER_PROJECT_ROOT` now also covers this case. The guard never auto-retargets the write to the primary checkout — it refuses and names the primary path, leaving the retarget to a human or a separate `--integrate` command. Degrade-silently is preserved: a non-git directory or a git failure leaves `listGitWorktrees()` returning `[]`, so this discriminator simply never fires rather than throwing.
- **`check-changelog-frozen.js` now also blocks a staged `CHANGELOG.md` section heading for a version the canonical version files never reached, at write time** (T-666) — a section could previously be opened and accumulate entries across waves undetected until release time, since the existing mirror-tag check (T-604) only ever compares against tags that already exist on the mirror. This is a second, independent check: a staged NEW `## [x.y.z]` heading whose version compares strictly greater than `scripts/mavp-version.js` (read from the staged blob, falling back to HEAD when unstaged) now blocks the commit, naming both versions — while a commit that stages the matching version-file bump in the same commit still passes, and an ordinary entry added under an already-existing heading never fires it. Coexists with the T-604 mirror-tag check; the two refusal messages are worded distinctly so it's clear which rule fired.
- **New `--integrate <commit|base..tip> [--task T-NNN]` operator command removes the cwd-dependent hand-typed cherry-pick class from worktree integration** (T-567) — the Main Agent previously integrated sub-agent worktree work by hand-typing `git cherry-pick`, whose correctness depended entirely on the Bash tool's persistent-but-invisible cwd; one instance ran a cherry-pick inside the agent's OWN worktree instead of main. `--integrate` resolves the project root the same way every other mutating command does, runs `guardMutatingRoot()` (T-624/T-670, all three discriminators) FIRST — refusing and naming the primary checkout on a never-a-project root or a linked worktree, never auto-retargeting — and then pins every git subprocess it spawns to that resolved root explicitly, so the actual cherry-pick lands there regardless of the caller's cwd. It refuses when a cherry-pick or merge is already in progress in the resolved root, prints one `integrated: <short-hash>` line per landed commit (single commit or a `base..tip` range), and — only when `--task T-NNN` is given and resolves to exactly one task block — prints a ready-to-run `--set-status` suggestion; `--task` is optional. On conflict it exits non-zero naming `git cherry-pick --abort`/`--continue` with no auto-abort. It writes no state artifact itself (`BACKLOG.md`/`TASK_STATUS.md`/`PROCESS_STATE.*`), keeping integration and status-booking decoupled. Dispatched from both `scripts/mavp-operator` and the installer's adopter wrapper. `docs/core/ORCHESTRATION_RULES.md` — "Worktree integration — Main Agent" now names this the required integration path; the residual hand-typed raw-git vector (a command run directly instead of through `--integrate`) is not intercepted by anything in this repo and is owned by the `docs/core/GATE_LEDGER.md` T-626 accepted-boundary row, not the deprecated T-626 task.

### Fixed

- **Frozen-section remediation guidance now names `## [Unreleased]` as the section to add entries under, instead of steering a version-blind contributor toward inventing a numbered section** (T-673) — both `check-changelog-frozen.js` blocked-commit messages (the T-604 mirror-tag refusal and the T-666 ahead-of-version-files refusal) and `docs/PUBLIC_RELEASE_STRATEGY.md` §5 now point at `## [Unreleased]`, the accumulator the guard already exempts, the release script already filters out of release bodies, and T-568 already gates against shipping unfolded. Message text and docs only — no comparison, condition, or exit code changed.
- **A CHANGELOG.md section for a version that was folded into a later release's tag but never tagged on its own could stay editable forever, letting an edit silently diverge the published changelog from notes already shipped, with no guard ever firing** (T-604) — `check-changelog-frozen.js` previously froze a section only when its exact version tag existed on the mirror; a version such as 0.41.0, published only inside 0.42.0's release body, never got its own tag and so was permanently missed. The freeze boundary is now "at or below the highest stable mirror tag," compared segment-wise and numerically — never lexicographically, which would rank "0.9.0" above "0.10.0" — while `Unreleased` and strictly-newer sections stay editable. Inert for adopters and the public mirror — this check only runs `--if-canonical`.
- **The release script could silently drop an entire wave of work from a published release's notes while every other gate reported green** (T-568) — `mavp-publish-release.js` excluded the `Unreleased` section from the release body by construction, and separately excluded any section newer than the version being tagged; either path could omit real content undetected. A live near-miss on 2026-07-29 rendered a release body at 45,866 characters where the correct one was 116,698 — a whole wave missing while assemble, scan, and both content-provenance gates stayed green. The script now refuses, before any mutation, when the edge-tip CHANGELOG has real (non-blank, non-sub-heading) content in either an `Unreleased` section or any section newer than the tagged version, naming the offending sections and the version. The emptiness check is fence-aware, so a heading-shaped line inside a fenced example counts as content.
- **The mandatory pre-release gate-ledger review (DR-008) went unmentioned at the exact moment an operator is about to run the release command, and was skipped on the first promotion after that review requirement shipped** (T-668) — `docs/PUBLIC_RELEASE_STRATEGY.md` §3b requires reviewing `docs/core/GATE_LEDGER.md` before running the printed `gh release create` command, but the release promoter's own printed next-steps never named that requirement. It now prints a non-blocking reminder naming `docs/core/GATE_LEDGER.md` and DR-008 immediately before the release command; no gate or exit code path changed.

## [0.44.2] — 2026-08-13

### Added

- **`--close-session` now warns, non-blockingly, when a completed task has zero mentions of its own id anywhere in `EXECUTION_LOG.md`** (T-629, RC-2 of `docs/rca/2026-08-operator-channel-state-artifacts.md`) — wave 76 closed fourteen tasks across roughly ten-plus spawns and produced zero per-spawn `EXECUTION_LOG.md` entries, and nothing noticed. The sweep that moves `merged`/`deployed_dev`/`deployed_prod`/`runtime_verified` tasks out of `TASK_STATUS.md`'s Active tasks now also checks each of those task ids against `EXECUTION_LOG.md`'s full text and, before the results table, prints one line naming every id with zero occurrences — silent when all ids are present. `deferred`/`deprecated` entries are never checked. This is deliberately a total-omission detector, not a precise per-spawn-entry lint: a task id mentioned anywhere (e.g. at registration) already satisfies it, even if the mandatory `tool_uses:`/`outcome:` per-spawn record is still missing — a stricter check was explicitly ruled out, since a wave can legitimately have more merged tasks than spawns (the XS fast lane) or more spawns than tasks (retries). Never blocking: the exit code and session-commit contract are unaffected either way.
- **Every mutating operator ritual command (new-task, quick-task, update-task, set-status, update-status, rename-task, rescope-task, merge-task, quick-merge, apply-decomposition, close-session, archive-merged, park-wave, unpark-wave, arm-recheck, ack-recheck, set-strategy-note, handoff) now refuses to run — exit 1, before any file write — against a "never-a-project" repo root** (T-624) — a root is refused when either (a) its `PROCESS_STATE.json` exists and its `mavericks_version` field still carries the literal shipped placeholder (`__MAVERICKS_VERSION__`, from `templates/PROCESS_STATE_TEMPLATE.json` — a tree that has never been installed/adopted by `mavp-install.js`), or (b) the root resolves to `$HOME/.mavericks`, the machine-shared adopter-resolved framework-source clone. A missing `PROCESS_STATE.json` never triggers discriminator (a). The refusal message prints to BOTH stdout and stderr, naming the resolved path, the matched discriminator, and the override env var `MAVERICKS_ALLOW_NEVER_PROJECT_ROOT` — set it to a truthy value to permit the write for the rare sanctioned case. Read-only reporting surfaces (`--agent`, `--snapshot`, `--validate`, `--emit-bundle`, the dashboard, `--check-sync`) are unaffected. `printRepoIdentityHeader()` (`scripts/mavp-operator-lib.js`) additionally duplicates its identity line to stderr for these mutating commands, so a stdout-only pipe (e.g. `tail`) can no longer cut the one line naming the repo it is about to write to — the exact vector that defeated the header on 2026-08-05.
- **`--close-session` now keeps this framework's own `PROCESS_STATE.json` `mavericks_version` field current automatically, in self-mode only** (T-660) — nothing previously refreshed `mavericks_version` after a version bump in the framework's own repo, so a lagging value printed a false update-available notice at every session start and had to be hand-synced across two consecutive waves. `--close-session` now stamps `mavericks_version` to the current framework version during its existing `PROCESS_STATE.json` write, in both interactive and non-interactive modes and on both mid-wave and wave-complete closes — but strictly gated to self-mode, detected by comparing the resolved project root against the framework installation root `scripts/mavp-version.js` lives in (realpath-compared, so a symlink hop or trailing separator can't misclassify it). In any adopter project, where `mavericks_version` instead records the last version `mavp-install.js` installed, the field is left byte-unchanged — including staying absent when it was never set.
- **`--agent`'s `permission_mode` field no longer reports declared file config as if it were confirmed runtime truth** (T-663) — three additive fields now carry its provenance: `permission_mode_source` (`hook_payload` | `persisted_runtime` | `settings_file`), `permission_mode_verified` (`true` only when the value was observed on THIS session's SessionStart hook stdin payload — reading more files can never make this true), and `permission_mode_conflict` (present only when a readable user-global `~/.claude/settings.json` `defaultMode` differs from the project-file resolution; reports both values and never picks a winner, since precedence between them is harness-owned and has been observed to diverge from what this project's docs assert). The persisted runtime-mode cache (`.mavp/permission-mode`) is now session-scoped JSON (`{mode, session_id?, written_at}`) instead of a bare string; a SessionStart hook payload that omits `permission_mode` now deletes a stale cached value instead of leaving it to serve a confidently-wrong mode later, while a manual (no-payload) invocation leaves it untouched. `--agent` and `--close-session` now share one fallback order (hook payload > persisted > settings file), closing the prior asymmetry where `--agent` skipped the persisted cache and `--close-session` skipped the live hook payload — the `--close-session` push gate's `bypassPermissions` behavior is unchanged. The session-start skill no longer renders a bare mode value: it labels the verified/declared status, surfaces the conflict line when present, and — when the best-known mode isn't `bypassPermissions` — names the exact settings-file fix to restore prompt-free operation.

### Changed

- **`next_action` version-number rule is now enforced, not just suggested — an adopter's `next_action` value can now be rejected by a check that never blocked before** (T-628) — this project's convention has always said `next_action` (a one-line field describing what happens next) must never contain a version number describing current state, like "we are at 0.42.1." Previously, writing that anyway only printed an informational note nobody was required to act on; three real slips got through exactly that way. Now a version number ASSERTING current state ("is/are/at/on/now/currently/already/still 0.44.3") makes the check fail outright — at edit time if hooks are active, otherwise on the next commit. A version number that is instead the actual TARGET of an instruction — "bump to 0.44.3," "the 0.44.3 section" — is explicitly allowed, so legitimate release instructions keep working. **If your `next_action` reads like a status report instead of an instruction, rewrite it before your next commit, or the commit will be blocked.** The same edit-time check now also watches `PROCESS_STATE.json` directly, not only the two task-tracking files it previously covered, so a version-number slip in any of the three state files surfaces immediately instead of waiting for someone to run a commit.

### Fixed

- **Closing a wave could silently carry its architect-review gate state into the freshly opened next wave, making the new wave falsely read as already past the gate it hasn't been through yet** (T-653) — `--close-session` never wrote the `wave_status` field at all, so on wave advance the ending wave's value (e.g. `architect_reviewed`) survived byte-for-byte into the new wave via the existing carry-forward of unrecognized fields. Observed live: a wave closed at `architect_reviewed` and the next wave opened still reading `architect_reviewed`, skipping the mandatory review gate for waves with three or more planned tasks. The fix resets `wave_status` to `planning` inside the same wave-advance code path that already clears the previous wave's goal and working notes — a mid-wave (not-yet-complete) close still leaves `wave_status` untouched, since the wave it describes is still open. **Docs correction alongside this fix:** `CLAUDE.md`, `docs/core/ORCHESTRATION_RULES.md`, and the project-state template previously documented a `closed` value for `wave_status`, claiming `--close-session` sets it automatically — that was never reachable, since the close and the wave-counter increment happen as one atomic write, and persisting `closed` would have mislabeled the brand-new wave instead. `closed` is retired from the documented enum; `wave_summary` is the artifact that records what a closed wave accomplished.
- Framework version bumped 0.44.1 → 0.44.2 in both `scripts/mavp-version.js` and `package.json` (T-658) — a patch bump: wave 81 corrects existing behavior and adds no new command, flag, field, or schema.

## [0.44.1] — 2026-08-13

### Fixed

- **A gate-review mechanism (DR-008) got its first real test against this project's own publish gates, and kept every one of them** (T-643, T-647) — DR-008 requires any blocking gate with zero real fires since the last stable release to get an explicit keep/demote/retire review, not sit unexamined. The review covered the publish-overlay's seven "tiers" (checks limiting how much of the shipped tree a sync can delete) plus the manifest-classification advisory, and retired none, for three reasons: a ledger claim that some tiers made others redundant had quietly gone false through ordinary growth — the floor a tier compares against only moves on deliberate re-seeding, while the real count it competes against keeps climbing on its own, so a "redundant" tier can end up the stricter, load-bearing one, and the gap widens every wave that adds a script; one tier exists purely to be lenient, forgiving file moves/renames, so removing it would make the remaining checks stricter and noisier — the opposite of what "retiring complexity" usually means; and the manifest advisory's firings are invisible by design, visible only in an agent's own transcript, so "it never fires" could not be verified either way. **The lesson: zero recorded catches is a prompt to look closer, not evidence it's safe to remove.**
- **The session-start "must read" list now catches uncommitted and even untracked work from a session that ended abnormally, not only work that was already committed** (T-644) — previously, the list of "what changed since we last formally wrapped up" was built purely by comparing git commits, so if a session crashed or was cut off before running its own close-out step, any notes or edits it had made — including its own log of what it had just done — simply vanished from the next session's reading list, because they were never committed in the first place. The fix makes the same computation also look at your working tree's uncommitted edits and any new files git doesn't yet track (skipping anything covered by `.gitignore`), and combines all of that with the usual commit history. Under the hood, the three git lookups that feed this now fail independently of one another — a problem reading one no longer wipes out results the other two already found — and a generous 32 MiB memory ceiling was set explicitly so a very large batch of new files can't silently overflow the default and quietly return nothing.
- **The end-of-session close-out no longer overwrites the wave's stated goal and working notes just because you closed a session mid-wave, and no longer erases them either** (T-648) — closing a session used to always reset two fields tracked in the project's state file: a short note describing what the current wave is working toward, and a longer scratch note holding in-progress context. Previously, the goal note would silently carry over into the *next* wave once the current one actually finished (so a new wave could start already displaying an old, unrelated goal), while the scratch note was wiped on *every* single close — including an ordinary pause partway through a wave that was still very much in progress, discarding context that wave still needed. Both fields now only reset when a wave genuinely completes and the next one opens; if you're just pausing mid-wave, both are preserved exactly as you left them. **If you or your tooling depend on the previously documented behavior — this project's own guidance said the scratch note "persists until the next close-out" — that description no longer holds; it now persists across any close that doesn't finish the wave, and clears only when the wave advances.**
- **The reminder to bump the framework's version number after a session no longer fires just because a file got reclassified between "shipped" and "not shipped" in the publish manifest** (T-649) — that reminder is driven purely by whether anything under the tooling folder (`scripts/`) changed since the version was last bumped, and one specific kind of change there — moving an entry between the shipped and excluded lists in the manifest that decides what gets published — doesn't itself change what any adopter's copy of the tooling actually does, so it shouldn't have been prompting a bump. That one file is now excluded from the check, and when the reminder does fire for a genuine reason, it now also names the specific file(s) that changed, rather than only saying "something in scripts/ changed." Note the residual: if that same manifest file's entries change what actually ships in the published file *tree* (not just how one entry is classified), that's still covered by this project's other release safeguards — it just no longer double-counts as its own version-bump trigger.
- Framework version bumped 0.44.0 → 0.44.1 in both `scripts/mavp-version.js` and `package.json` (T-650) — a patch bump: wave 80 corrects existing behavior and adds no new command, flag, field, or schema.

## [0.44.0] — 2026-08-13

### Added

- **Non-interactive `--close-session` now proposes booking for shipped-but-unbooked work** (T-637) — when a task sits at `qa_passed` and the `commit:` hash in its `TASK_STATUS.md` Evidence is already reachable from `HEAD`, the non-interactive close prints one advisory line naming the task and the exact command to book it (`./scripts/mavp-operator --set-status <id> merged`). This is propose-only by design: it never writes state itself, and it complements — never replaces — the existing "Wave N stays open" line, so wave-hold semantics are unchanged. On a shallow clone, where commit reachability cannot be answered, the advisory stands down by name and deliberately carries no `--set-status` suggestion; when git is unavailable it stays silent. The commit-reachability helpers (`extractCommitHashesFromEvidence`, `buildReachableHashIndex`, `isHashReachable`) moved from `mavp-validator.js` into the shared `mavp-operator-lib.js`, with the validator keeping re-exports so no consumer changes.

### Fixed

- **`--worktree-report` / `--prune-worktrees` now refuse an unresolvable main ref instead of silently classifying every worktree `unintegrated` with an inert prune** (T-633) — on a repo whose default branch is `master`, or with a mistyped `--main-ref`, the report previously asserted falsehoods about every worktree's integration state. A classifier that gates `git branch -D` must refuse when it cannot check.
- **The shipped test suite no longer depends on git's `init.defaultBranch`** (T-632, T-634) — every fixture `git init` call is now pinned to an explicit initial branch, plus a new static guard test that fails naming the file and line for any future unpinned fixture init.
- **`test-close-session-mode.js` teardown `ENOTEMPTY` race on Node 22** (T-636) — fixed by converging fixture cleanup on the file's shared helper, with `maxRetries`/`retryDelay`.

### Docs

- **The shipped-but-unbooked advisory is documented in `docs/core/TASK_LIFECYCLE.md` and `CLAUDE.md`** (T-638).

## [0.43.0] — 2026-08-05

### Added

- **`--worktree-report` and `--prune-worktrees`, two new operator flags for the harness-created `.claude/worktrees/agent-*` pile that accumulates without bound** (T-559) — `--worktree-report` classifies every linked git worktree, read-only, into `dirty` / `unintegrated` / `clean-and-integrated` via patch-equivalence (`git cherry` semantics), not raw reachability: this project integrates by cherry-pick, so an integrated worktree's tip is unreachable from `main` by construction, and `merge-base`/`branch --merged` would have misclassified every one of them as still-open work. `--prune-worktrees` removes only the `clean-and-integrated` class, additionally gated on a 1-hour mtime safety window so a just-spawned agent's still-clean worktree is never swept mid-flight. **State the full destructive scope plainly, since it is easy to underestimate from the name alone: a real prune does not just delete the worktree directory — it also force-deletes the branch ref via `git branch -D`.** The `-D` (force) form is necessary, not careless: `-d` refuses every one of these branches outright, because integration here is by cherry-pick and no branch is ever "merged" by git's own reachability test — the same fact that forced patch-equivalence classification in the first place. Deletion only proceeds after a successful `git worktree remove`, wrapped in try/catch. `--prune-worktrees` defaults to dry-run (prints what would be removed, touches nothing) and requires an explicit `--yes` to act; run the real (`--yes`) prune only with zero live sub-agents, since every linked worktree of a repo shares one `.git` object/ref database and this is a repository-global exclusive-resource operation. **Adopter-visible output change — not breaking:** `--close-session` (both interactive and non-interactive modes) now also prints a one-line worktree-hygiene advisory from the same classifier whenever `.claude/worktrees` is non-empty — purely informational, it never prunes anything itself, and nothing that parses `--close-session`'s existing output needs to change.
- **Bootstrap now seeds/merges VS Code exclusion settings for `.claude/worktrees`** (T-577) — a fresh install and every `--update` additively and idempotently merge three keys into the target project's `.vscode/settings.json`: `files.exclude`, `search.exclude`, and `files.watcherExclude`, each carrying a `**/.claude/worktrees` glob set to `true` (the watcher key uses the deeper `**/.claude/worktrees/**` glob, matching VS Code's own shipped convention for that surface). The merge follows the same contract as the existing managed-hooks merge: only the single managed glob sub-entry is ever added under each key, every other key and every other sub-entry already present survives byte-identical, and a pre-existing conflicting value for the managed sub-entry (anything other than `true`) is left untouched with a printed notice rather than a silent overwrite — a second run makes no further change. **Read the residual before relying on this for the problem that motivated it.** The field report behind this task was VS Code's Git extension surfacing the accumulated worktree checkouts as phantom repository state (down to an operator asking why ~10K lines of changes were queued). These three keys are *expected* to also suppress that SCM-panel symptom, not just the file-explorer/search/watcher noise — the reasoning is that VS Code's git extension is understood to reuse the same `files.exclude`-driven skip logic for its own nested-repository discovery scan — but this is **NOT verified against a live VS Code session**: driving a GUI is outside what an agent can execute, so the SCM-discovery half of this fix is documented-but-unconfirmed. If it doesn't hold in practice, the documented fallback lever is `git.autoRepositoryDetection: "openEditors"` (scope nested-repo detection to files that are actually open), added manually to your own `.vscode/settings.json` — see `docs/core/BOOTSTRAP_GUIDE.md`, "VS Code worktree exclusion". This release deliberately does **not** seed `git.openRepositoryInParentFolders`: that setting is repo-global (affects every parent-folder repo the workspace might sit inside) with legitimate-use collateral, and independently of that it is the wrong lever for this specific problem — it governs discovery of repos in PARENT folders, not the SUBFOLDER nested-repo case `.claude/worktrees/agent-*` actually is.

### Fixed

- **The worktree-hygiene regression fixture (`test-worktree-hygiene.js`, T-559) hard-depended on the host machine's `git init` default branch, which broke CI on ubuntu runners** (T-632) — both `git init` call sites in the fixture now explicitly pin `-b main` (the same pin already used by `check-assembled-suite.js`), so `classifyWorktrees(mainDir, { mainRef: 'main' })` resolves correctly regardless of the host's `init.defaultBranch` setting. Upstream git still defaults `git init` to `master`, so on any host without a `main`-default override, the fixture's repo never had a `main` ref, every worktree's patch-equivalence check fell through to `'unknown'`, and Test 1 (and, less visibly, Tests 2/3/5) asserted `'unintegrated'` where `'clean-and-integrated'` was expected. This stayed invisible in local development because Apple Git 2.50.1 patches `git init` to default to `main` even with global/system config suppressed — the CI runners run upstream git, where the fixture's dependency on the host default was exposed.
- **`classifyWorktrees()` conflated an unresolvable `mainRef` with genuine per-worktree unintegrated work, so an operator on any repo where the default `mainRef` ('main') doesn't exist got a confidently wrong report instead of an error** (T-633) — the escaped defect T-632 fixed at the fixture layer left the classifier itself unguarded: on a real `master`-default repo, `--worktree-report`'s default invocation reported a genuinely cherry-pick-integrated worktree as `unintegrated` and exited 0, and `--prune-worktrees` reported "no prunable worktrees" and also exited 0 — no error either direction, and the exact inverse of reality. `classifyWorktrees()` now verifies once, up front, that `mainRef` resolves to a commit, and throws a typed `UnresolvableMainRefError` before doing any per-worktree work when it doesn't; the pre-existing conservative fallback for an individually broken worktree (missing object, `getPatchEquivalenceStatus()` → `'unknown'` → classified `'unintegrated'`) is unchanged and now has its own dedicated test. `--worktree-report` and `--prune-worktrees` catch the typed error and exit non-zero, naming the unresolved ref and pointing at `--main-ref`, before printing any per-worktree classification; `--close-session`'s shared advisory degrades to a single line naming the unresolved ref instead of silently going quiet — close-session itself still always completes.

### Docs

- **Harness worktree placement is now documented as untrusted, with a mandatory `Base floor:` preflight** (T-621) — the developer role spec gained a start-of-run check, keyed on a brief-supplied `Base floor: <hash>`, that runs `git log --oneline HEAD..<floor>` before any edit and requires the exact output quoted in the report: empty means the worktree's base is at or after the floor (proceed), non-empty means the worktree is missing required history (stop — stale base), and `fatal: Invalid revision range` means the worktree isn't even in the target repository (stop — wrong repo). `docs/core/ORCHESTRATION_RULES.md`'s GAP C is corrected from a mechanism claim to an observation — harness-created worktree bases have been seen arbitrarily stale, sticky across separate runs, and not an ancestor of any live branch, and neither of the two candidate causes is established, so neither is written into a brief or doc as "the" mechanism. A new GAP E documents the companion fact that isolation itself is scoped to the spawning session's own repo, so a cross-repo task's worktree can land under an unrelated repo's tree with zero isolation for the actual target — this is stated as a documented scoping fact, not a defect being fixed. Both `CLAUDE.md` and `docs/AGENT_SPEC.md` gained the optional `Base floor:` brief field.
- **`docs/AGENT_SPEC.md`'s copy of the sub-agent brief template had silently drifted from `CLAUDE.md`'s — missing five fields and degraded completion-token wording — and is now both fixed and mechanically guarded against drifting again** (T-623) — `AGENT_SPEC.md`'s template gained `Adjacent docs read:`, `Read current main:`, `Model:`, `Effort:`, and `Turn budget:`, plus a "Before exiting" line that now references the completion-token marker the way `CLAUDE.md`'s already did. `scripts/test-agent-spec-sync.js` gained a parity check that parses both documents' brief-template fences, compares their field-name sets, and asserts both `Before exiting:` lines carry the completion-token marker — wording differences between the two copies are expected and not a failure; only the field-name set and the marker's presence are checked. A field added to one template and not the other will now fail the shipped test suite instead of silently drifting a second time.

## [0.42.1] — 2026-08-04

### Added

- **New mechanical guard, `scripts/test-no-unbounded-block-matchers.js`, now fails the test suite when any `scripts/mavp-operator-*.js` file contains a task-heading-anchored regex whose "match any character, non-greedy" gap isn't bounded by a lookahead or a literal end-delimiter — the exact shape behind T-606/T-607/T-608/T-609** (T-610) — the glob is the coverage mechanism, since a new operator command is only reachable through the `scripts/mavp-operator` wrapper if it is named `mavp-operator-<verb>.js`, so a future mutating script is covered by construction rather than by being added to a list. Worth knowing: the guard's own first detection pass matched only the single-backslash regex-literal spelling and passed vacuously against a real reintroduced instance, because every historical instance was actually written as a doubled-backslash template literal — a structurally different raw substring; it was caught only because an executed mutant check was mandatory, not a reasoned-about one. Patch bump to 0.42.1 (`scripts/mavp-version.js`, `package.json`) — no new capability, no schema change.

### Fixed

- **`--update-task`, `--set-status`, `--update-status`, and `--merge-task` could silently write a field into the WRONG task — including rewriting an already-merged task's commit hash on an unrelated, closed piece of work** (T-606, T-607, T-608, T-609). **If you ran any of these four commands against your own project between v0.3.0 (2026-04-09) and v0.42.0 (2026-08-04), some of your BACKLOG.md/TASK_STATUS.md fields may already be wrong today, and no validator check catches it** — see the audit recipe below. Each command located its target task by its heading, then read or wrote a field somewhere below that heading with no concept of where the task's own block actually ended. When the target block did NOT already contain the field being written (for example, a task with no `Evidence:` line yet), the write ran past the end of the target block and landed in the first LATER block in the same file that did have the field — typically an already-archived, already-closed task. The worst reproduced case: promoting an active task with no Evidence line to `merged` with a real commit hash instead wrote that hash into an ARCHIVED task's Evidence line, replacing its actual commit hash while leaving the rest of the line untouched — a closed task ends up on record as having shipped a commit it never had. Separately and independently, `--update-task`'s `owner` argument never worked against a well-formed block at all: it targeted a field name no entry builder in this codebase ever emits, so it either corrupted a foreign block (via the same over-run) or silently changed nothing — printing the identical success line either way. All four commands now resolve every read and write to the target task's own block boundary, and insert a missing field into the TARGET block instead of reaching past it. **Scope of the bug, so you can judge your own exposure precisely: it only ever fired when the target block itself lacked the field being written, and it only ever wrote into a LATER block in the same file** — never an earlier one, never across the BACKLOG.md/TASK_STATUS.md boundary. A target block that already carried the field was always safe.
- **`--quick-merge` always stamped a task `runtime` / `developer` regardless of what was actually shipped, even though the XS-lane's own attested conditions already named `Verification type: artifact` as a valid lane condition** (T-613, T-614) — the documented capability and the actual code disagreed. Measured instance in this repo: a docs-only `CHANGELOG.md` addition, written by a docs sub-agent and verified by its diff, was registered as `runtime` / `developer`; both fields were wrong. The lane now accepts two batch-wide flags — `--verification-type <artifact|runtime|unit>` and `--owner <role>` — applied to every item registered in a single run (defaults unchanged: `runtime` / `developer`, so a flagless run stays byte-identical). `visual` and `manual` verification types are mechanically REFUSED, not merely discouraged, since both require human review by definition and can never ride a lane that registers straight to `merged`; `--owner` is validated against the known implementer-role set and refuses `main_agent` (this lane always cites a sub-agent's commit). Any invalid value refuses the ENTIRE run with exit 1 before any input is collected or any file is written. A mixed batch needing different values per item should run the lane once per type/owner grouping instead of one combined run. **If you used `--quick-merge` before this release, some previously-registered tasks may carry a wrong `Owner role` or `Verification type`, and this release does not repair them** — the signal was weak by design accident: the only validator finding that could have surfaced it, `merged_missing_needs_fix_rounds`, is info-severity and fires only for merged `runtime`/`manual` tasks, so a wrong owner, or an `artifact` task that happened to carry the field, produced no signal at all. There is no tool that fixes this after the fact — hand-correct the affected `BACKLOG.md`/`TASK_STATUS.md` entries directly, the same conclusion reached for the exposure documented above. **Follow-up (T-616):** the lane now also prints one line — after flag validation succeeds and before it collects any item input — naming the resolved verification type and owner, marking each `(default)` when its flag was not supplied, and stating in words that the resolved values apply to every item in the batch whenever either flag was explicitly given. A piped caller now sees this at the top of its transcript, and an interactive caller can abort before typing a title if the resolved metadata is wrong.
- **An operator command's post-write validator spawn, or a no-argument `mavp-validator.js` invocation, could judge a different repo than the one the command had just written to** (T-616, T-617, T-618) — a state mutation could be reported "healthy" while the repo it actually mutated was in repair-required state, because the mutating command's resolved root and the spawned validator's judged root could disagree. This was reproduced live; the trigger is a divergence between the current directory and the resolved project root — for example, invoking the `mavp-operator` wrapper from a subdirectory instead of the project root, or a harness/CI setup that sets `MAVERICKS_PROJECT_ROOT` without also setting a matching working directory. In the ordinary flow — running the wrapper from the project root, with or without the env var set — writer and judge already agreed, so most adopters will never have observed this; it is not the case that every command was mis-validating. The fix is deliberately two-sided: every operator command that spawns the validator now passes its own resolved root to it explicitly as an argument — `--quick-merge`'s own spawn plus eight further spawn sites (`--apply-decomposition`, `--merge-task`, `--new-task`, `--quick-task`, `--update-task`, `--close-session`, and both spawns in `--agent`) converged onto the pattern six siblings (`--set-status`, `--update-status`, `--rename-task`, `--rescope-task`, `--park-wave`, `--archive-merged`) already used, and `.claude/hooks/pre-commit` now passes its own working directory explicitly — so writer and judge agree whether or not an env var is set; separately, `mavp-validator.js`'s own root resolution now falls back to `MAVERICKS_PROJECT_ROOT` before `process.cwd()` when no path argument is given at all, covering third-party or harness invocations that pass no path. `getProjectRoot()` (used for project-level registries — `docs/MODULES.md`, `docs/REPO_MAP.md`) was deliberately left unchanged and still resolves from the env var or the current directory rather than an explicit argument; this is a known, tracked residual, not fixed in this release.

### Docs

- **Audit recipe for adopters who ran the affected commands during the exposure window above.** This release stops the defect going forward — it does not repair any field it already corrupted before you upgraded, because the correct pre-corruption value only survives in your own project's git history, and no tool here can distinguish a legitimately-changed field from a corrupted one after the fact. To check your own `BACKLOG.md`/`TASK_STATUS.md`:
  1. Pick a commit from before your first use of any of the four commands in the window above — any earlier commit in your own repo's history works.
  2. Diff each task's `Status` and `Owner role` fields between that commit and HEAD; a change on a task you did not intentionally touch is a candidate to investigate:
     ```
     git show <pre-upgrade-commit>:BACKLOG.md | grep -E '^(### T-|- \*\*(Status|Owner role):)' > /tmp/pre.txt
     git show HEAD:BACKLOG.md | grep -E '^(### T-|- \*\*(Status|Owner role):)' > /tmp/post.txt
     diff /tmp/pre.txt /tmp/post.txt
     ```
     Repeat against `TASK_STATUS.md` the same way.
  3. Spot-check archived/merged tasks' recorded commit hashes against your real history, since a corrupted Evidence line still reads as a well-formed hash and won't look wrong on its own:
     ```
     git log --oneline -1 <the-hash-in-that-task's-Evidence-line>
     ```
     and confirm the commit message that comes back actually describes the task you're checking, not a different one.

  This is detection guidance for a historical exposure, not automated repair — nothing in this release rewrites a corrupted field back to its original value; only you, from your own history, can do that.
- **`.claude/rules/scripts.md`'s "Reserved shapes" list gained this guard's shape as a fourth entry, plus a new job-to-helper mapping** (T-610) — states which lib function is canonical for which job (single-block field access via `locateTaskBlock()`/`extractBlockField()`/`setBlockField()`/`updateTaskField()`, whole-file enumeration via `parseAllTaskBlocks()`, and the read-only compatibility wrapper `findTaskBlockById()`), because "use the lib helpers" alone was ambiguous while several block-access functions coexisted — that ambiguity is how the nine pre-guard instances got hand-written across four scripts in the first place.
- **`docs/core/ORCHESTRATION_RULES.md` gained a "Role-scope check" brief-composition duty and a Cap-hit triage addendum** (T-615) — every brief item must fall within the target role's mandate as stated in its own spec, with the concrete test that an item requiring inspection of components the slice did not touch is architect work, not QA work; Cap-hit triage now directs checking for role misrouting before narrowing scope or re-spawning a bounded role.

## [0.42.0] — 2026-08-04

### Added

- **Publish secret scanner now detects a private name leaking through a file's own PATH, not only its contents** (T-601) — a ship-classified file whose NAME embedded a private repo name previously published completely undetected, because every detection category ran only against file contents (`scanFile`) and symlink-target strings (`scanSymlinkTarget`), never against an entry's own tree-relative path string. The scanner now runs the same category set against each entry's path too, via a new additive export `scanEntryPath`; no existing export's signature changed.
- **New commit-time backstop blocks a private-name collision before it can merge, closing a detection-latency gap between merge and release** (T-600) — a colliding private identifier merged in an earlier wave previously surfaced only two waves later, as an aborted release build, because the publish gate had only ever run at release time in between. A new `scripts/mavp-private-names-guard.js`, wired into the pre-commit hook, scans staged ship-classified files' contents and paths (reusing T-601's path scanning) against an operator-local, untracked name list and blocks the commit on a finding. It is inert wherever that list is absent — every worktree, every adopter repo, and the public mirror all lack it by construction — and fails open (a guard bug prints a warning and lets the commit through) so a defect here can never block every commit in the repo.

### Docs

- **The shipped secret-string rule now states the private-name matcher's family-prefix semantics, which an author cannot discover by reading this repo** (T-599) — the name list the gate checks against is supplied to the scanner at invocation time and appears in no tracked file, and an entry ending in a hyphen matches any hyphenated identifier that begins with those letters, case-insensitive, anywhere on the line, with no actual private name needing to be present to trip it. The rule now also recommends neutral, generic synthetic-identifier segments over abbreviations lexically adjacent to this project's own naming family, and corrects the scanner's documented scope to include file paths (T-601's addition), not just contents and symlink targets.
- **Developer spec and orchestration docs gained a worktree-escape self-check and a Main-Agent-side restore backstop** (T-602) — the developer role's worktree-mechanics guidance is generalized from a git-only absolute-path prohibition to any mutating command, and now requires a mandatory post-edit self-check (an edit missing from the worktree's own `git status`/`diff` is the escape signature, with a stop-restore-redo-report response). A Main-Agent-side backstop is added alongside it: `git status --porcelain` on the shared checkout before integrating a worktree wave, restoring any unattributable modification with `git checkout HEAD -- <path>` rather than a bare `git checkout <path>` (which restores from the index, not `HEAD`). **This documents discipline and a post-hoc backstop, not a closed mechanism** — no hook exists in this repo today that intercepts a worktree sub-agent's command before it runs, so the underlying harness-level gap stays open.

## [0.41.0] — 2026-08-03

### Added

- **Shipped test suite now surfaces gated stand-downs instead of hiding them inside suppressed output** (T-588) — a passing test's stdout/stderr is normally suppressed by `run-tests.js` (most of the ~76 test files are chatty and a clean run doesn't need to see it). Any line a test tags with a new `[SKIP]` token (used for a documented, canonical-repo-only check standing down on a mirror/adopter checkout) is now printed anyway, indented under that test's `PASS` line, and the run finishes with a new summary line: `Stand-downs: N (files)` naming every file that stood one down, right after the existing `Summary: X passed, Y failed (of Z total)` line. **Adopter-visible output change — not breaking:** `run-tests.js`'s exit-code contract is unchanged, and the existing `Summary:` line's text and position are byte-identical; the only difference is one additional line of output plus, on some runs, extra indented `[SKIP]` lines above it. Nothing that parses only the exit code or only the `Summary:` line needs to change.

### Fixed

- **`--sync-status` skeleton creation no longer corrupts a task whose TASK_STATUS entry lives outside "## Active tasks"** (T-578) — skeleton creation used to key off the `## Active tasks`-only id set the rest of the sync logic uses, so a task with an entry sitting in another section (e.g. "## Deferred tasks") was treated as missing, got a duplicate heading created, and then had its real (stale) block clobbered by the status sync pass. It now scans the whole file for an existing heading first, skips creating a duplicate when the task is found elsewhere, and prints a stderr advisory naming the affected task, the section its real entry lives in, and pointing at `--rescope-task` as the fix.
- **`--rescope-task --status deferred` now normalizes a stranded entry from ANY section, and `--status deprecated` no longer reactivates a rejected task** (T-576) — deferral previously only relocated an entry that was already inside "## Active tasks"; it now achieves full symmetry with the activation path and moves a stranded entry regardless of which section it currently sits in. Separately, marking a task `deprecated` no longer moves its BACKLOG block back into the live Active Wave — a rejected task stays out of the wave it was rejected from.
- **Wave-line status counters in `--snapshot` no longer collapse unrecognized or terminal-skip statuses into `planned`** (T-581) — the snapshot's wave summary line used to bucket every status via a catch-all `else` that silently reported `needs_fix`, `deferred`, `deprecated`, and `runtime_verified` tasks as `planned`, undercounting real progress and hiding stalled/skipped work. Buckets are now derived from the same exported status sets the rest of the operator tooling uses, plus a new visible `unknown` bucket that names any status that still doesn't match. **Adopter-visible output change — not breaking:** the wave-line label for finished work changed from `merged` to `completed`, and two new buckets can now appear (`deferred/deprecated`, `unknown (...)`) — this is human-read snapshot text, not a schema; `--agent`'s JSON output is untouched.
- **`--close-session`'s auto-generated `wave_summary` no longer grows unbounded with wave size** (T-584) — `buildAutoSummary` used to join every merged task's title into one sentence, producing a 5,612-character `wave_summary` at a real wave-70 close instead of the documented "one sentence". Output is now bounded to a constant-size count-plus-highlights form regardless of task count: the total, up to the first three (length-clipped) titles, and a `+K more.` tail beyond three — capped at roughly 300 characters for any title count.
- **`getNextTaskId()`'s heading scan is now anchored to line start, closing an ID-jump defect that can burn a large ID range in one mint** (T-593) — the heading regex previously matched a heading-shaped substring anywhere in `BACKLOG.md`/`TASK_STATUS.md`, including inside a backticked inline citation sitting mid-prose (the wave-72 incident: a mid-sentence citation of another task's heading was matched and burned a 300-ID range in one mint). The regex is now anchored to line start, so it only matches a real heading. A new, non-blocking stderr tripwire also fires at mint time, but only when PROCESS_STATE's `last_task_id` is nonzero AND the file scan's discovered maximum exceeds it — naming both values so an operator can verify before relying on the minted ID.
- **`run-tests.js`'s skip-line scan is now anchored to line-initial-after-optional-whitespace** (T-596) — the scan previously matched any line that merely mentioned the `[SKIP]` token anywhere in it, so a passing test's own prose describing the mechanism could be mistaken for a genuine stand-down emission (T-588 tripped on exactly this against its own PASS-line descriptions). The scan now uses `trimStart()` plus a `startsWith()` check rather than a strict column-zero prefix — required because one of the five shipped emitters (`test-validator-cross-section-status.js`) indents the token with leading spaces. All five shipped emitters still surface correctly under the new scan, and only mid-line prose mentions stop matching. **Not a breaking change:** the pre-fix matcher shipped as part of this same unreleased 0.41.0 window (T-588), so adopters only ever receive the anchored behavior described here.

### Docs

- Corrected `docs/PUBLIC_RELEASE_STRATEGY.md` §5's false claim that the private canonical repo carries no version tags (T-569) — it can and does; those tags are inert for the release process since tagging only ever acts on a separate mirror clone.
- `CLAUDE.md` now documents the pre-commit hook as installed via `core.hooksPath`, not a `.git/hooks` symlink (T-590).
- `docs/core/TASK_LIFECYCLE.md` gained a wave-close sweep subsection covering both terminal status sets, their destinations, and the fail-closed rule (T-591).
- `docs/core/ORCHESTRATION_RULES.md` gained a normative test-execution-scope rule (T-594): worktree developer sub-agents run targeted `--filter` test runs, with the full suite reserved as a single Main-Agent integration step on main.

## [0.40.1] — 2026-08-03

### Fixed

- **Shipped T-575 real-artifact test layer no longer asserts a canonical-only
  property outside the canonical repo** (T-585) — the public mirror's CI went
  RED on all three node cells immediately after the 0.40.0 release: T-575's
  false-positive guard in `scripts/test-validator-cross-section-status.js`
  demanded more than 100 records from the repo's own `BACKLOG.md` /
  `TASK_STATUS.md`, but the publish manifest ships both as one-record `reset`
  templates, so the mirror's real artifacts measured `backlog=1
  task_status=1` and the assertion failed loudly on every run. The affected
  test layer is now gated on the shared `isCanonicalRepo()` detector (the same
  heuristic `check-publish-manifest.js --if-canonical` already uses), with
  the vacuity guard itself kept hard inside the gate rather than weakened.
  **If you pulled 0.40.0, this test-only defect can fail your own suite too:**
  any repo whose `BACKLOG.md` / `TASK_STATUS.md` are still template-shaped
  (freshly bootstrapped, or not yet past 100 real task records) will see the
  same false-positive red run until you upgrade to 0.40.1 — no validator or
  operator behavior shipped in 0.40.0 was wrong, only the test's assumption
  that every consumer's artifacts look like the canonical repo's history.

## [0.40.0] — 2026-08-02

### Fixed

- **`--close-session` no longer stalls a wave whose real work is already merged** (T-573) — terminal entries (`deferred`, `deprecated`) left inside `TASK_STATUS.md`'s "## Active tasks" section were being counted as remaining work, so a wave could sit open indefinitely even after every actual deliverable had merged. `--close-session` now sweeps `deferred` entries into a "## Deferred tasks" section and `deprecated` entries into "## Recently completed tasks" before computing wave completion, so only genuinely unfinished statuses hold a wave open. A structural guard shipped alongside it: the close-session merge-mirror now refuses to promote a task to `merged` in BACKLOG.md if that task's own BACKLOG block currently reads `deferred` or `deprecated`, closing the write-side half of the same disagreement.
- **`--rescope-task --status deferred` now relocates the TASK_STATUS block instead of editing its status in place** (T-574) — deferring a task previously left its entry sitting inside "## Active tasks" with just a `Status: deferred` line rewritten, which is exactly the shape T-573 had to sweep up after the fact. The deferral path now moves the block into a "## Deferred tasks" section (created on demand) byte-for-byte, so hand-written Evidence/Notes survive verbatim and stale entries stop accumulating at the source rather than being cleaned up downstream.

### Added

- **Validator: two new checks close a direction-gated blind spot in status verification** (T-575) — `reverse_terminal_status_disagreement` (failure severity) fires when a TASK_STATUS.md record claims `merged` but the same task's BACKLOG.md block says something else, and `missing_backlog_record_anywhere` (warning severity) fires when a TASK_STATUS record claims `merged` and there is no BACKLOG record for that task at all. Previously the validator only checked agreement in the BACKLOG-to-TASK_STATUS direction, so a TASK_STATUS record claiming `merged` while BACKLOG said `deferred` (or said nothing) raised zero findings. **Adopters upgrading to 0.40.0 may see new findings surface against existing artifacts** — this is a new failure-severity check and it can block a commit via the pre-commit hook. Measured against the canonical repo's own history (574 BACKLOG records, 562 TASK_STATUS records), it raised zero findings, so it is not expected to be noisy in ordinary use — but that is a measurement on one repo's history, not a guarantee, and a project with hand-edited or out-of-band artifact history is exactly the population most likely to trip it for the first time.
- **New "Executed-check rule" in `docs/core/ORCHESTRATION_RULES.md`, plus a matching `.claude/rules/backlog.md` bullet** (T-571) — codifies a brief-composition duty: before a named verification command or acceptance criterion is written into a durable artifact (a BACKLOG task, a role spec, an RCA codification), whoever writes it must actually run it once rather than assume it works. Closes a pattern where criteria defects reached shipped tasks because a check was described but never executed.
- **The same executed-check duty added to the developer, QA, and architect role specs** (T-582) — each sub-agent role now carries an explicit instruction not to assert a component's behavior from reading it alone: run the check (or a test able to fail against the bug it targets) and quote the real output, or label the claim `UNEXECUTED — verify before relying`. The architect's version accounts for its restricted toolset (no general Bash) with read-then-cite-and-label instead of execute-then-write.

## [0.39.1] — 2026-07-29

### Fixed

- **Shipped manifest tests no longer assert a canonical-only property outside
  the canonical repo** (T-570) — the public mirror's CI (run 30453337655, all
  three ubuntu cells) was RED on `test-publish-build.js` and
  `test-publish-manifest-strict-shape.js` immediately after the 0.39.0
  release, even though the private repo's own run was green: a mirror-shaped
  repo trips three distinct classes against `check-publish-manifest.js`'s
  completeness claim — UNCLASSIFIED (the two `.github/ISSUE_TEMPLATE/*.md`
  files that exist only in the mirror), STALE (all 18 `exclude` keys, which
  are by construction never tracked outside the canonical repo), and PRESERVE
  entries shadowing git-tracked paths (the same two template files) — because
  the completeness rule is written from the canonical repo's perspective and
  the mirror is not that repo. `runPreflightCompletenessCheck()` in
  `scripts/mavp-publish-assemble.js` now invokes the checker with
  `--if-canonical` (T-401), which stands the whole claim down with a loud
  SKIP line outside the canonical repo; canonical-repo behavior is
  byte-identical (flagged vs. unflagged output diffed empty, both exit 0).
  This alone fixes every clone-based e2e test in `test-publish-build.js`,
  which all pass through the same assembler preflight. The PINNED CONTROL in
  `scripts/test-publish-manifest-strict-shape.js` (asserting the checker and
  assembler both exit 0 on this repo's own real manifest) is now gated on the
  exported `isCanonicalRepo()` for BOTH consumer halves, plus a directly
  computed tracked-exclude ratio that distinguishes three states rather than
  a binary: all 18 exclude keys tracked → enforce unchanged; none tracked →
  a loud `SKIPPED` line naming the ratio (e.g. `0/18`); some-but-not-all
  tracked → FAIL loudly, naming the state as canonical-with-stale-manifest —
  closing a blind spot `--if-canonical`'s binary heuristic shares (deleting
  one tracked exclude-keyed file would otherwise read as non-canonical and
  silently disarm pre-commit and manifest-guard together). Follows the
  existing loud-skip precedent already used by `test-publish-overlay.js`
  Tests 4/35/39 rather than inventing a new gate shape. Verified with a
  hand-built non-canonical harness (assemble to a temp dir, `git init`, add
  the two `.github/ISSUE_TEMPLATE/*.md` files, commit) reproducing the
  mirror's exact pre-fix failure text and going green post-fix, plus a
  mixed-state fixture (one exclude-keyed path added and committed) confirmed
  to fail loudly as designed. Not a regression — both touched test files were
  new in the 0.39.0 window.

## [0.39.0] — 2026-07-29

### Added

- **Validator `commit_unreachable` now detects a shallow git clone and stands
  down rather than reporting unsound warnings** (T-565) — every CI run was
  annotating `validator drift (exit 1)` for evidence commit hashes that ARE on
  main but simply weren't fetched by `actions/checkout@v7`'s default
  fetch-depth-1 clone (measured on run 30445260691: 3 spurious
  `commit_unreachable` warnings for hashes confirmed present locally and by
  the Quick Start proxy step in the same job). The check was UNSOUND there,
  not merely noisy: `git rev-list` in a depth-1 clone enumerates one commit,
  so "not reachable from any local ref" is indistinguishable from "lives in
  history deliberately never fetched." A new `isShallowRepository(root)`
  helper (`scripts/mavp-operator-lib.js`) classifies shallow ONLY on an exact
  `"true"` match from `git rev-parse --is-shallow-repository`; any other
  output or a thrown error falls through to non-shallow (containment for
  git < 2.15). `checkCommitReachable()` now suppresses the individual
  "no local ref" warning in a shallow clone and collapses every indeterminate
  hash into exactly ONE info-severity stand-down finding naming the affected
  tasks — emitted only when at least one hash was actually indeterminate, so
  a clean shallow clone gets no line at all. Positive reachability (HEAD or
  `--branches`) is untouched regardless of clone depth — only the negative
  "no local ref" tier was unsound. Full (non-shallow) clone behavior is
  unchanged. Verified via a real `git clone --depth 1 file://<src>` fixture
  (plain-path clones silently ignore `--depth`, so the file:// protocol is
  load-bearing) asserting `git rev-parse --is-shallow-repository` prints
  exactly `true`, plus direct-unit, full-stack, and zero-indeterminate-hash
  coverage in `scripts/test-commit-reachable.js`.

- **Shipped test suite is now git-identity-hermetic by construction** (T-562)
  — `scripts/run-tests.js`'s `runOne()` now spawns every `scripts/test-*.js`
  child with a baked-in env that nulls `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
  and injects `user.useConfigOnly=true` via `GIT_CONFIG_COUNT`/`KEY_0`/
  `VALUE_0`, forcing git to refuse any commit identity it would otherwise
  derive from ambient machine/OS state instead of silently synthesizing one
  (the platform difference — macOS synthesizes an identity from the OS user
  when config is silent, bare ubuntu CI runners don't — is what turned one
  identity-less commit site into a real CI outage). This moves enforcement
  into the runner rather than `.github/workflows/ci.yml`, so it covers local
  runs, CI, and adopter machines alike with no workflow-file change; CI
  inherits it for free because CI already runs `npm test`. Verified via the
  stricter probe (`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly
  GIT_CONFIG_VALUE_0=true node scripts/run-tests.js`), which passes the full
  75-file suite with 0 failures — every commit-touching test file already
  sets explicit local `user.name`/`user.email` via its init helper — and via
  a mutant kill (temporarily stripping that pinning from one file reddens
  plain `npm test` even with ambient machine identity present, confirming
  the runner env is now the actual enforcement mechanism). Residual bypass
  channels (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars, direct single-file
  invocation, a per-test env that overrides `GIT_CONFIG_COUNT`) are recorded
  in a `run-tests.js` comment.

- **CI matrix cut and support-policy change: Node 18 dropped, macOS moved off
  the per-push matrix** (T-563) — the Actions quota was exceeded twice this
  month; the prior 6-cell matrix (ubuntu + macOS x Node 18/20/22) billed
  macOS minutes at a 10x multiplier for a signal that had not failed all
  month, and every push/PR (including state-only close-session commits) ran
  the full matrix. `.github/workflows/ci.yml` now runs `ubuntu-latest` x
  Node `[20, 22, 24]` on push/pull_request; macOS is reduced to a single
  `test-macos` job (`macos-latest` x Node 24) gated to a weekly schedule plus
  `workflow_dispatch`, in the same workflow file. `paths-ignore` on both
  triggers skips the state artifacts (`BACKLOG.md`, `TASK_STATUS.md`,
  `PROCESS_STATE.md`, `PROCESS_STATE.json`, `EXECUTION_LOG.md`,
  `HANDOFF.md`, `SKILL_PROPOSALS/**`) — deliberately not `docs/**` or `*.md`
  wildcards, since a doc-only commit can add a new file the publish-manifest
  tests genuinely exercise. A `concurrency` group with
  `cancel-in-progress: true` cancels a superseded run instead of billing
  both. `actions/checkout` and `actions/setup-node` are bumped to `@v7`,
  clearing the Node 20 deprecation warning every cell emitted. Node 18 is
  dropped as a stated support policy (EOL since 2025-04-30): `package.json`
  now declares `engines: {"node": ">=20"}`, and the README's Node support
  statement is updated in both places it appears (the badge and the
  Requirements list).

- **`extractTrajectories`'s keyword fallback no longer miscounts the literal
  `needs_fix_rounds` field name as a fix-round occurrence** (T-560) — the
  fallback's `/needs[_\s]fix/g` matched the `needs_fix` prefix of the field
  name itself, so a task whose evidence only documents the field (e.g.
  "record `needs_fix_rounds: N`") with no digit-valued occurrence — so the
  explicit digit-anchored parse never fires — had its field-name mentions
  double-counted as fix rounds. T-189's evidence contains exactly this shape
  (two digitless mentions, no digit-valued field) and measured `needsFixCount`
  2 before this fix, 0 after; it was deliberately left un-rewritten in the
  archive per the T-540 lesson (fix the reader, not the record) after T-186's
  identical shape was corrected by hand during T-558's precondition repair.
  The fix adds a negative lookahead (`(?!_rounds)`) so the literal token is
  excluded while genuine prose mentions ("entered `needs_fix` twice") still
  count; the explicit digit-valued first-match parse is unchanged. New
  `scripts/test-trajectory-keyword-fallback.js` covers both mutant-killers:
  a digitless-mentions-only fixture (must yield 0, not 2) and a
  genuine-prose fixture (must still yield 2, guarding against an
  over-broad exclusion).

- **Two new validator checks catch a disagreeing repeated evidence field
  within a single task: `conflicting_needs_fix_rounds` and
  `conflicting_validator_blocked`** (T-558) — `appendNeedsFixRoundsIfMissing`
  (`mavp-operator-set-status.js`) only ever inserts `needs_fix_rounds: 0`
  when the field is absent and never updates it in place, so every fix-round
  increment is a hand edit that appends a second occurrence further down the
  Evidence block, while `extractTrajectories` (`mavp-operator-lib.js`) reads
  the FIRST match only. Two corruptions were realized on the live artifact
  and repaired ahead of this task landing: T-288's leading value disagreed
  with its own prose-recorded fix round, and T-186 carried no canonical
  `validator_blocked` field but described the field as subject matter, so
  first-match read `true` for a task the validator never blocked. Both new
  checks (warning severity, explicitly declared) fire on a DISTINCT-VALUES
  predicate, not occurrence-count — an agreeing repeat (28 such records
  exist on the live artifact, e.g. `needs_fix_rounds: 0` twice) produces no
  finding, and a digitless field-name mention (`needs_fix_rounds: N` as
  documentation prose) never matches the digit-anchored regex, so it
  contributes no finding either. Both run over `taskStatusAllTasksAnySection`
  — every section the evidence parser reads (active, recently completed,
  archived), matching `extractTrajectories`' whole-file read scope, since
  every realized corruption lived outside the active-only record set.
  `commit:`/`branch:` are explicitly excluded: per-repo cross-repo evidence
  legitimately repeats `commit:`, and `mergeCommitEvidence`
  (`mavp-operator-lib.js:3390`) replaces the first commit/branch token in
  place rather than appending. New `scripts/test-conflicting-evidence-fields.js`
  covers five mutant-killers: distinct-values fire, agreeing-repeat
  suppression, digitless-mention suppression, single-occurrence suppression
  (including the multiline sub-bullet shape protected by
  `test-evidence-multiline.js`), and archived-section coverage.
  `extractTrajectories`'s first-match parse and the `--set-status`
  auto-insert contract are unchanged by design — changing either would mask
  the corruption this check exists to surface.

- **`mavp-manifest-guard.js` now discriminates a missing manifest from a
  corrupt one, and reuses the checker's shape predicate instead of a
  guard-local one** (T-556) — the guard's single catch block around
  `loadManifest()` used to swallow both "no manifest at all" (the
  legitimate adopter/public-mirror silence case) and "manifest present but
  broken" identically, so a corrupt `scripts/publish-manifest.json` in the
  canonical repo silently disabled every creation-time advisory until
  someone noticed. Separately, a present-but-malformed `exclude` bucket (an
  array, a string) defaulted to `{}`, which made the canonical-repo
  heuristic true vacuously AND dropped those entries from the classified
  set, producing false per-file advisories computed off garbage. The guard
  now discriminates on `err.code === 'ENOENT'` (stays fully silent, exactly
  as before) versus any other load failure or a shape-contract failure
  (imports `validateManifestBucketsShape` from `check-publish-manifest.js`
  rather than re-implementing it, keeping the advisory surface's stand-down
  set identical to the pre-commit backstop's refusal set) — WARN AND STAND
  DOWN: exactly one `MANIFEST GUARD:` stderr advisory naming the manifest,
  the defect, and the checker, then exit 0 without the per-file advisory.
  Refusal (non-zero exit) is inexpressible here — the composed PostToolUse
  hook fragment forces exit 0 regardless — so this is the only honest
  behaviour the hook contract can express. `scripts/test-manifest-guard.js`
  gains four named mutant-kill tests: (e1) truncated JSON exits 0 with the
  malformed-manifest advisory present and the per-file advisory absent;
  (e2) `exclude` as an array exits 0 naming the shape reason; (e3) no
  manifest at all still exits 0 with stdout AND stderr both empty; (e4) a
  coherence pin feeding the same malformed manifest to both the guard (exit
  0 + advisory) and the checker (exit 1), asserting they agree on the same
  manifest.

- **Turn-budget doctrine follow-ups: product-docs cap recalibration,
  cap-hit signature threshold, recon-preloading first-spawn rescope**
  (T-557) — a censored cap-hit during T-521 (product-docs, 42 tool_uses
  against a cap of 40) drove a third `docs/TURN_BUDGET.md` recalibration
  and exposed two doctrine gaps at once. First, the cap itself:
  `ceil(42 × 1.5) = 63`, and 63 is the first headroom-formula output whose
  NEAREST multiple of 10 (60) sits below the formula's own output — every
  prior worked example happened to round to the nearest multiple as well
  as upward, so `round_to_10` is now generalised to
  ceiling-to-the-next-multiple-of-10; `product-docs.md` and
  `technical-writer.md` (aligned by the existing doc-authoring-class
  precedent, still with zero independent observations) both move from
  `maxTurns: 40` to `maxTurns: 70`, mirrored in `docs/AGENT_SPEC.md`'s
  per-role table. Second, the cap-hit signature: T-521's overshoot was
  cap+2, which a strict reading of the old wording ("at or within one of
  the cap") does not cleanly cover — `docs/core/ORCHESTRATION_RULES.md`'s
  "Cap-hit triage" step 2 and `docs/TURN_BUDGET.md`'s signature text are
  now a total, disjoint threshold rule (`tool_uses >= cap` is a cap-hit at
  any overshoot; `tool_uses < cap` is an infra failure, with a
  transcript-tail check recommended before an identical retry when the
  count sits close to but below the cap, since a spawn can burn turns on
  tool-less text turns). Third, "Recon-preloading" is rescoped from
  retry-only to also cover first spawns whenever the Main Agent already
  holds the recon at brief-composition time, citing four recon-preloaded
  spawns (9 and 13 tool_uses on retries; 16 and 22 on first spawns, newly
  recorded in `docs/TURN_BUDGET.md`) — with an explicit carve-out that
  independent-discovery roles (security-reviewer full reviews, qa) may
  still deliberately self-recon, since independence of discovery is the
  point of those reviews. `scripts/test-agent-spec-sync.js` continues to
  assert frontmatter and the `docs/AGENT_SPEC.md` table agree; no file
  under `scripts/` changed.

- **End-to-end killers for the five overlay composition rules that were
  previously bound only by a unit test** (T-527) — `findDirectoryViolations()`
  (T-507) has always been unit-tested directly (Test 12), but never driven
  through the real CLI, so a defect in `main()`'s own wiring of these rules
  (the wrong variable read, a dropped call, a mis-ordered check) could ship
  even while the unit test stayed green. `scripts/test-publish-overlay.js`
  gains Tests 54-58, each an end-to-end fixture built specifically to
  isolate ONE rule as the sole possible refusing tier (padded so every other
  guard — whole-clone ratio, the other per-directory tiers, the move-credit
  cap — provably stays silent): the per-directory `>=` boundary at an
  exact-half single-bucket reproduction (54, 52 of 104 deleted); the
  multi-directory aggregate ceiling at a two-bucket 49-of-193 aggregate (55);
  a small-directory aggregate drop across two individually-exempt
  directories (56); the whole-clone `>=`-with-floor boundary at an exact-half
  10-file clone (57) — this one had NO killer at any level, unit or e2e,
  before this task; and the tier-1 full-wipe rule's immunity to move credit
  on a basename-preserving, related-destination relocation (58) — Test 13's
  existing laundering fixture renames its files, so it cannot discriminate
  a mutant that reads the move-adjusted deleted count instead of the raw
  one. Per the brief's own discipline, each of the five named mutants was
  applied live to `mavp-publish-overlay.js`, run once, reverted immediately,
  and never committed; the case-5 mutant turned out to already be caught at
  unit level by TWO existing tests (22 and 27), not zero — a correction to
  the developer brief's "survives the entire suite" framing, recorded in
  the T-527 evidence rather than left standing. A header comment in the
  test file now codifies
  the INVERTED obligation this task closes: this five-case sweep is a
  one-time closure audit, not a standing re-run requirement — every future
  refusal tier must land with its own end-to-end killer in the same task
  that adds the rule.
- **Content-provenance gate for the publish pipeline** (T-534) — every
  existing publish guard (the size floor, the secret scanner, the overlay's
  deletion-ratio tiers) is PATH-shaped: it reacts to files appearing,
  disappearing, or moving. None of them react to a file's CONTENT being
  replaced in place while the path set stays untouched — that produces zero
  deletion candidates, an unchanged file count, and (barring a coincidental
  secret-shaped replacement) zero scan findings, leaving the assembled
  tree's window between the scan gate and the push, plus any assembler
  defect, entirely unverified. New standalone `scripts/mavp-publish-verify-
  provenance.js` closes that blind spot: it resolves ship/reset buckets
  through `scripts/publish-manifest.json` and asserts every `ship` path's
  assembled bytes equal the private repo's own HEAD blob for that path, and
  every `reset` destination's assembled bytes equal the HEAD blob of its
  MAPPED `templates/` starter — never a naive per-path HEAD lookup for a
  reset destination (a reset key such as `.claude/settings.json` may be
  UNTRACKED at HEAD since T-529) and never a live on-disk read. Fails
  CLOSED (never silently passes) when git is unusable or a blob can't be
  read. Wired into `mavp-publish-build.js` as a new Step 6.5/7 hard gate,
  called immediately before the push step (step 7) against the same
  assembled tree the scan gate (step 2) already scanned, and running
  unconditionally regardless of whether the run's own commit step found
  anything new to commit. End-to-end tests against a real local bare
  mirror (never a real remote) prove: a one-byte tamper planted in the
  assembled tree after the scan gate aborts the build naming the tampered
  path, with the mirror's refs byte-identical before and after (nothing
  pushed); the same tamper preserves the path set exactly and the refusal
  names a content mismatch, not a missing/extra path; and a clean run
  pushes a tree matching HEAD blobs one-to-one for every ship path and
  starter blobs for every reset destination. No new npm dependency
  (Node built-ins only); the new files are self-registered `ship` in
  `scripts/publish-manifest.json`.
- **T-534 round 2 — manifest shape contract, committed-tree certification,
  and CRLF transform prevention** — security review round 1 returned one
  HIGH and one MEDIUM. HIGH: the verifier used to default `ship` to `[]` and
  `reset` to `{}` on any absent/mistyped manifest bucket, so a malformed
  manifest reported `ok:true` having verified ZERO paths; a new
  `validateManifestShape()` now refuses on any malformed shape (empty/absent
  `ship`, absent/non-object `reset`, any path containing `..` or a leading
  `/`) before a single path is compared, while deliberately tolerating an
  explicitly-present empty `reset: {}` and unknown top-level keys (the
  false-refusal boundary). The default manifest source is now
  `git show HEAD:scripts/publish-manifest.json`, never disk, unless
  `--manifest` is given as an explicit override. A new completeness sweep
  asserts the assembled tree's recursive file set equals `ship` UNION
  `reset` destinations exactly, catching a path added to the tree after the
  scan gate — a class no other guard reacts to. MEDIUM: the gate previously
  certified only the temp ASSEMBLED tree, never the tree actually committed
  onto the mirror clone's local `edge` and pushed — nothing pinned or
  checked the clone's own `git add`/`commit` behaviour, so a future
  operator machine's `core.autocrlf=true` could transcode shipped text at
  commit time while the certificate stayed GREEN. New
  `verifyCommittedTreeProvenance()` closes this structurally: a new Step
  6.6/7 hard gate certifies the clone's own committed tree — content
  (git-blob-to-git-blob) AND git-tree MODE (catching an exec-bit flip a
  blob-only comparison would miss) — against the same HEAD/starter blobs;
  `stepCommit()`'s `git add -A` call site gains a paired `-c
  core.autocrlf=false -c core.safecrlf=false` prevention pin, and a
  permanent CRLF canary fixture (`scripts/publish-crlf-canary.txt`) makes
  every future publish live-exercise this exact transform class end to end.
  A refusal from step 6.5 or 6.6 now undoes THIS run's own commit (`git
  reset --soft HEAD~1`) before aborting when the run created it, so a
  tamper-detected tree can never strand on local `edge` for a later run's
  ahead-range push to transmit — never touching a previously certified tip.
  All mutants (defaulting-fallback restoration, completeness-sweep
  deletion, mode-check deletion, a clone-side self-compare, and both the
  add-site-pin drop and the step 6.6 deletion) were run live against a real
  local bare mirror and reverted before landing. No new npm dependency; new
  files self-registered `ship` in `scripts/publish-manifest.json`.
- **T-534 round 4 — mode binding (replacing a rejected `core.fileMode=true`
  fix) and a git-attributes prevention pin** — security review round 2
  returned two findings, both false-refusal/prevention gaps rather than
  missed detections, both on `stepCommit()`'s `git add -A` call site. HIGH:
  the mirror clone persists across publishes and carries whatever mode a
  previous publish committed; with `core.fileMode=false` in the clone (the
  ordinary setting on network-mounted or Windows-backed checkouts) `git add
  -A` ignores the working tree's executable bit entirely — verified live, on
  BOTH a mode-only flip AND a brand-new executable file — so an honest
  `chmod +x` in the private repo is never restaged, and step 6.6 refuses
  against the stale committed mode. The reviewer's proposed
  `-c core.fileMode=true` was REJECTED (the architect ruled a different
  shape): `git clone` probes the filesystem and writes `core.fileMode`
  itself, so forcing `true` overrides that determination and stages whatever
  uniform bit a FAT/exFAT/network mount reports on every path, and it still
  routes mode truth through disk observation of the clone — the exact class
  step 6.6's own doctrine (git-to-git only) exists to avoid. Instead, a new
  mode-binding pass (`bindStagedFileModesToHeadOrAbort()`) runs after
  `git add -A` and before `hasStagedChanges()`/`git write-tree` (both
  orderings load-bearing: a mode-only publish stages no content diff, and
  the trailer's tree sha must cover the bound modes) and binds the clone
  INDEX's mode for every manifest ship path and non-gitignored-in-clone
  reset destination via `git update-index --chmod=+x|-x` — zero filesystem
  reads, sourcing the expected mode git-to-git from the private repo's own
  HEAD (ship) or the mapped `templates/` starter's HEAD (reset). Symlink
  (120000) paths are skipped with a named residual; any unexpected or
  unreadable HEAD mode, or any `update-index` failure, aborts fail-closed
  before commit. No `core.fileMode` pin is added in either direction — once
  binding exists such a pin has no observable effect on any path step 6.6
  certifies, which would make it an unkillable-mutant rule. MEDIUM: the
  existing `-c core.autocrlf=false -c core.safecrlf=false` pin neutralizes
  only the CONFIG layer; attribute-driven `text`/`eol` normalization is a
  separate mechanism that outranks `core.autocrlf` and ignores those flags —
  verified live on both an in-tree `.gitattributes` and an untracked,
  never-committed `$GIT_DIR/info/attributes` (the vector that matters more,
  since it is invisible to every shipped-file check). Since attribute
  SOURCES have a strict precedence order and `$GIT_DIR/info/attributes` is
  the HIGHEST, the publish clone (a pipeline-owned resource) now OWNS that
  file: before `git add -A`, `pinCloneGitAttributesOrAbort()` overwrites it
  — resolved via `git rev-parse --absolute-git-dir`, never a hardcoded
  `.git/` — with exactly `* -text -eol -filter -ident`, read-back-verified,
  aborting before add on any write or read-back failure; `-filter`
  additionally closes clean filters, a live byte-rewrite channel of the same
  class. Also: `isValidRelPath()` now rejects a bare `.` path segment
  alongside the existing `..`-segment and leading-`/` rules. Ten mutants (the
  mode-binding call deletion, a disk-observation implementation, a +x/-x
  flag swap, moving the binding pass after the early return, removing its
  fail-closed arm, removing the gitignored-reset skip, removing the
  attributes-pin call, a missing `-text`, a missing `-filter`, and writing
  the wrong — in-tree — attributes file) were run live and reverted before
  landing. No new npm dependency; no new files.
- **T-534 round 5 — the gitignored-reset skip re-keyed on presence
  (correct by construction, not by accident), and a corrected `-ident`
  classification** — security review round 3 returned one HIGH (ruled down
  to hardening, with a live refutation) and one confirmed finding. Finding
  A's reported chain (a shipped `.gitignore` line makes `check-ignore`
  report a tracked reset destination ignored, so both the mode binder and
  step 6.6 skip it) has both stated premises TRUE but an unstated third
  premise FALSE and load-bearing: `git check-ignore` NEVER reports a
  tracked path as ignored — verified live, a tracked file matching an
  ignore pattern exits 1 with no rule reported while the same `git add -A`
  still stages its modification. So the reported hole is not real (a
  tracked destination was always fully verified even before this round),
  but the protection was INCIDENTALLY correct — resting on check-ignore's
  undocumented, unpinned index-awareness — and both call-site comments
  asserted the opposite, false claim ("a gitignored reset destination never
  reaches the clone's committed tree via `git add -A` at all") when the
  mirror's committed tree contains such a path today (all six reset
  destinations, including `.claude/settings.json`, are tracked at the
  mirror's `origin/main`). A future refactor swapping `check-ignore` for
  `--no-index` or a hand-rolled pattern match would have reopened the hole
  with nothing turning red. Both skip sites are now re-keyed on explicit
  presence, checked FIRST and fail-closed on a git error: the mode binder
  (`mavp-publish-build.js`) skips only when a reset destination is BOTH
  absent from the post-`git add -A` index (new `isPathInIndex()`) AND
  ignore-matched; step 6.6 (`verifyCommittedTreeProvenance()`) skips only
  when BOTH absent from the committed tree at `ref` (new
  `isPathInCommittedTree()`) AND ignore-matched — present-in-index /
  present-in-tree destinations are now verified/bound unconditionally,
  regardless of any ignore match. Both new predicates live in
  `mavp-publish-verify-provenance.js`, the established shared home; the
  two skip DECISIONS stay inline at their own call sites (the substrates
  and failure channels differ). The reviewer's proposed alternative fix —
  requiring an ignore-matched destination to be untracked, aborting
  otherwise — was REJECTED outright: ignored-and-tracked is the intended
  steady state for `.claude/settings.json` from the next publish forward,
  and that fix would brick every future publish. A new unit regression
  (a clone whose ref tracks a reset destination with bytes divergent from
  its starter, plus a working-tree `.gitignore` matching it, via an index/
  ref divergence constructed with `git rm --cached`) fails naming the path,
  doubling as the reviewer's requested live reproduction; a control with
  matching bytes and mode passes. Finding B (confirmed): the existing
  comment mischaracterized BOTH `-eol` and `-ident` as "subsumed riders" —
  `-eol` genuinely is, but `-ident` is an INDEPENDENT clean-direction
  rewrite channel (a pre-expanded `$Id: <hex> $` marker is silently
  collapsed at `git add -A` when the pin omits `-ident`, verified live);
  production already includes `-ident`, so nothing was exploitable, but it
  now gets its own dedicated test. One doc line added to
  `docs/PUBLIC_RELEASE_STRATEGY.md` naming the attributes pin's own
  refusal (unwritable `$GIT_DIR/info`). No new npm dependency; no new
  files.
- **Validator: warning for a terminal BACKLOG task with no TASK_STATUS
  record anywhere** (T-547) — complements T-543's
  `cross_section_terminal_status_disagreement` check, which requires a
  TASK_STATUS record to disagree with and so cannot see a task with NO
  TASK_STATUS record at all — exactly the shape a buggy archival
  move-helper leaves when it drops a block instead of moving it (same
  T-542/T-544 incident family). The new `missing_task_status_record_anywhere`
  check (warning severity) reuses `parseAllTaskBlocksBySection` and fires
  when a BACKLOG task terminal (merged/deployed_dev/deployed_prod) in any
  section has zero matching TASK_STATUS records in any section; it skips
  `Superseded by:`/`deprecated` records via the existing
  `isSkippedByExistingRules()` helper and requires no evidence fields of
  archived records — this check is about record EXISTENCE only. Four
  legacy tasks (T-005, T-006, T-007, T-034) with no TASK_STATUS record were
  repaired with minimal retroactive entries before this check shipped, so
  record-existence is now a universal invariant and the check measures at
  zero findings on the live repo. The check's own comment notes it must be
  revisited if TASK_STATUS history is ever trimmed into a separate archive
  file.
- **Validator: cross-section terminal-status disagreement + non-terminal
  blocks in completed sections** (T-543) — closes a detection gap the
  2026-07-26 corruption exposed: a task fabricated `merged` in an archived
  `BACKLOG.md` section while its `TASK_STATUS.md` record still said `planned`
  in a completed section validated Healthy at exit 0, because the existing
  `status_mismatch`/`merged_missing_commit_field` checks only ever compare
  the ACTIVE sections of both artifacts. Two new whole-file,
  section-agnostic checks: `cross_section_terminal_status_disagreement`
  (failure) fires when a BACKLOG task terminal
  (merged/deployed_dev/deployed_prod) in any section has a TASK_STATUS
  record anywhere still carrying a non-terminal status;
  `non_terminal_status_in_completed_section` (warning) fires on a
  TASK_STATUS block sitting in a "Recently completed"/archived-shaped
  section with a non-terminal status (explicitly excludes `--park-wave`'s
  "Parked tasks (Wave N)" sections, a legitimate non-terminal holding
  state). Both skip `Superseded by:`/`deprecated` records per existing
  convention and are measured at zero new findings against the live repo.
- **Publish shape contract succession gate — round 4, COHERENT + hardened
  introduction** (T-541 round 4) — a fourth security review found round 3's
  totality claim refuted by two CRITICALs, both reproduced end to end at
  exit 0 on the real CLI. Finding 1: the delta partition has THREE parts
  (changed, added, removed) and the design covered two — a key **deleted**
  from `derivation.observed_direct_file_counts_at_seeding` (rather than
  edited) lands in the removed bucket, is examined by neither REAL nor
  REACHABLE, and the floor for that directory keeps enforcing a number
  nothing on the assembled side any longer claims to have measured; the
  re-seed certificate even printed "every re-seeded observed count verified"
  about a directory neither rule had touched. A new rule, **COHERENT**,
  closes this structurally rather than teaching REAL/REACHABLE one more
  case: whenever the assembled derivation is full, every key declared in
  `min_direct_files` must have a matching key in the observed map, checked
  first and unconditionally, independent of the clone's own anchor state.
  Retiring a directory wholly (both its floor and its observation, together)
  still passes loudly via the pre-existing removal and weakening lines,
  since neither side declares the key at all — only a floor with no
  matching observation now refuses. Finding 2: the record-introduction path
  never validated the incoming `seeded_on`, so a manufactured, non-canonical
  date became the clone's new anchor and was then treated as lenient legacy
  history by round 3's DATED clause on every later publish — repeatable via
  a stand-down (delete the ledger) -> genesis -> re-introduce cycle, since
  genesis was unconditionally silent. GENESIS (no clone ledger at all) and
  the pre-existing partial-anchor introduction case are now unified into one
  RECORD-INTRODUCTION event, format- and COHERENT-checked before printing
  its loud INTRODUCED line — genesis no longer trusts whatever the incoming
  record says on shape or coherence, though (see the CORRECTED note below)
  its observed counts are recorded as claimed. **The round-3 DATED
  legacy-leniency branch is deleted, not narrowed**: a non-canonical
  *published* `seeded_on` now REFUSES outright (previously it skipped only
  the strict-advance comparison, loudly). An operator hitting this refusal
  on genuinely pre-round-4 history has a self-serve two-publish repair that
  needs no mirror surgery: **stand down** (delete
  `scripts/publish-shape-contract.json` from the assembled tree entirely —
  a loud, non-refusing event) and then **re-introduce** it (loud, format-
  and COHERENT-checked). This deletion is safe by an inductive invariant:
  the only write paths through the gate from here on are introduction,
  byte-identical, re-seed and stand-down, and introduction always
  format-validates, so every full anchor the gate itself admits from here
  on is canonical-dated and coherent — and this repo's own published
  `seeded_on` is already canonical, so the deletion protects nobody here
  today. Two smaller closures: ADDED keys additionally gain REACHABLE when
  the clone's previously published floor map already declares a floor for
  that exact key (dead code against any anchor the gate itself has admitted
  since this round, live only against a legacy pre-round-4 anchor that
  itself already violates COHERENT); and the re-seed certificate line is
  now **generated** from the exact arrays Rules 2/3 iterated (changed-key
  and added-key counts and names, removed-key count/names with the floor
  each stood down with) rather than narrated as prose that could claim more
  than the code actually checked. The delta-partition truth table (Test 48)
  is now generated from its own membership-vector definition — one key per
  realizable cell of `{(1,1,=), (1,1,≠), (1,0), (0,1)}` — rather than a
  hand-picked case list, so a fifth part cannot exist ungenerated. Round 3's
  mutant kills and every honest-flow green (byte-identical silent,
  floor-only lowering loud non-refusing, partial re-seed green, drain-to-floor
  green) are retained.
- **Publish shape contract succession gate — round 4 CORRECTED: REAL removed
  from record introduction** (T-541 round 4 corrected) — round 4 as shipped
  above (and originally logged in this same entry) additionally required
  RECORD-INTRODUCTION's observed counts to equal the assembled tree's own
  live direct count (REAL, over every key). That reversed round 3's
  deliberate dormancy for introduction, and the reversal was an error: it
  refused the single most common introduction case there is — an honest
  mirror catching up to a canonical side that kept growing since the record
  was first seeded (observed 108, live 114 — reproduced end to end on the
  real repo at exit 1, `scripts/test-publish-build.js` Test 8 `--dry-run`).
  REAL's semantics is "this recorded count was observed AT THIS PUBLISH",
  true exactly once — for the changed/added delta of a DATED re-seed, where
  the operator attests a fresh observation of the tree being re-seeded from
  right now. Introduction instead propagates a HISTORICAL record into a
  mirror whose own ledger predates it, so comparing it to the CURRENT live
  tree is a category error, not a security check; REAL at introduction also
  bound no adversary, since a same-commit forger controlling both the
  assembled tree and the ledger simply sets observed equal to their own
  evacuated tree's live counts — all false-refusal cost, no adversarial
  benefit. RECORD-INTRODUCTION's observed counts are now recorded AS
  CLAIMED, NOT verified against the live tree (trust-on-first-use) —
  format- and COHERENT-checked, nothing more. Everything else round 4
  shipped is unchanged: COHERENT, the DATED legacy-leniency deletion,
  conditional REACHABLE for added keys against legacy anchors, the
  generated re-seed certificate, and the programmatic partition-enumeration
  test. The module header now states the durable invariant this correction
  establishes: a refusal may compare a recorded value to the live tree only
  where the record itself asserts observation-at-this-publish — round 3's
  original all-keys Rule 2 and round 4's introduction REAL were the same
  defect, in different branches, with the same two numbers.
- **Committed publish shape contract** (T-533) — `scripts/publish-shape-contract.json`
  declares, per functional directory of the assembled publish tree (including
  the root pseudo-directory), the minimum number of files that must appear
  DIRECTLY in it, and `scripts/mavp-publish-overlay.js` refuses before any
  write when the assembled end state falls below any declared floor. This is
  the first composition tier in that file that is NOT a per-run delta guard,
  added because security review proved the delta family cannot be patched into
  composition-safety: credited relocation is count-preserving, so the
  move-credit budget renews in full on every publish (four consecutive
  overlays each relocating 47 of a 194-file baseline into
  `<top-segment>/attic/` all pass, reaching the same drained end state as a
  single refused run), and the budgets' denominator is inflatable by unguarded
  additions (a 600-file padding publish lifts the baseline so the identical
  147-file relocation measures 18.5% instead of 75.8%, collapsing four runs
  into two). Both are structural properties of measuring a run's delta, and
  both are dead against a floor on the end state: four runs of 47 and one run
  of 147 hit the same check on the same tree, and an absolute floor never
  reads the baseline at all. Direct-child semantics (non-recursive) are
  load-bearing — `scripts/attic/x` does not count towards `scripts/` — which
  is precisely why draining a directory into a subdirectory of itself is
  caught even though every relocation is legitimately credited. The ledger is
  read from the assembled tree (so an absent ledger is skipped silently and
  adopter trees are unaffected) but a present-but-malformed one fails closed.
  There is no runtime override and no flag: `--allow-mass-delete` does not
  suppress a contract refusal, and the single sanctioned relaxation is an edit
  to the committed ledger — which IS the operator-review moment the tier
  exists to create. Supersedes T-526: the reviewer's 51-of-104 `scripts/`
  pure-deletion reproduction (49.0% per-directory, one bucket touched, 26.3%
  of the whole clone — under every per-run tier) is now refused by the
  contract, and that subsumption is enforced by a test rather than assumed.
  Floors are seeded at 0.6 of the observed ship set with the derivation, the
  rounding rule and the accepted residual recorded in the ledger itself.

- **Publish shape contract hardening** (T-540) — closes the three residuals
  T-533's security review left open in `scripts/mavp-publish-overlay.js` and
  `scripts/publish-shape-contract.json`.
  (1) The loader's fail-closed promise had three holes, all reproduced at exit
  0 with no output and no contract enforced: an empty `min_direct_files`
  object, an explicit floor of `0`, and a duplicate key whose last value is
  `0`. `loadShapeContract()` now refuses a floor below **1** (it previously
  refused only below 0 — a floor of 0 is satisfied by an empty directory, so it
  enforced nothing) and refuses an empty declared set outright. That is not a
  new policy but the ledger's own: its derivation already clamps every floor up
  to a minimum of 1 precisely because a zero floor is a no-op entry. The
  duplicate-key shape is closed by the same threshold with no duplicate-key
  detection added — a surviving duplicate must now carry a real floor, and a
  duplicate line is a visible added line in the ledger diff anyway.
  (2) Three floors are raised, because the 0.6 fraction collapses on small
  buckets: `floor(3 x 0.6) = 1` left a 3-file directory free to lose 2 of its
  3 files, i.e. a line already drawn for free by the pre-existing full-wipe
  rule — and in this project every small directory is its own enforcement
  machinery. Reviewed end-to-end against the real ship set, dropping 2 of 3
  rules files plus 5 of 11 agent specs plus 2 of 3 top-level `.claude` files
  removed **nine enforcement files in one publish at exit 0 with no output**.
  The seeding rule is now the complete
  `max(floor(observed x 0.6), observed <= 4 ? observed - 1 : 0,
  isLocationSemantic(dir) ? observed : 0)` clamped to at least 1, which moves
  exactly three integers (the top-level `.claude` bucket 1→2, `.claude/rules`
  1→3, `.claude/agents` 6→11) and leaves every other floor untouched. The
  complete algorithm — not just its output — is codified in the ledger's
  derivation block, so the armed re-seeding recheck reproduces all three terms
  instead of regressing to a flat fraction. Cost, stated in the ledger: a small
  non-enforcement directory may still shrink by one file and passes at
  equality, while removing any file from a location-semantic enforcement
  directory now requires the one-line ledger edit — which is the sanctioned
  review moment. `.claude/agents` sits at `count == floor == 11`, so the
  equality boundary is exercised by the real ship set on every release.
  (3) A run that loads and passes the contract now prints exactly one
  operator-visible line naming the ledger path and the number of floors
  enforced; a ledger-less run still prints nothing. A release log previously
  read identically whether every floor was enforced or the tier had stood down.
  No change to the base fraction elsewhere, to any other floor, or to any of
  the four-round-reviewed delta tiers.

- **Publish shape contract hardening, round 2** (T-541) — closes four
  confirmed residuals of T-540's own security review in
  `scripts/mavp-publish-overlay.js` and `scripts/publish-shape-contract.json`.
  (1) T-540's below-1 rule only closed a duplicate `min_direct_files` key
  whose LAST value was `0`; a duplicate whose last value was a REAL, nonzero
  floor the tree already satisfied restored the full nine-file enforcement
  evacuation at exit 0 while defeating every other observation channel at once
  (the diff read as an ordinary addition, the parsed key count showed no
  anomaly, and the enforcement signal counted keys rather than strength). The
  premise that "a surviving duplicate must now carry a nonzero floor" is
  disproven and removed: `loadShapeContract()` now slices the raw text of the
  flat `min_direct_files` object (marker to its own matching brace — never the
  whole file, since the derivation block's observed-counts object legitimately
  repeats every key a second time) and refuses whenever quoted-key-colon
  occurrences exceed the parsed key count, naming the repeated key, regardless
  of whether the repeated values differ or are equal.
  (2) The nine-file-removal test's own control asserted the untouched real
  ship set's enforcement-directory count at EQUALITY to its floor and
  hardcoded the expected remaining counts as literals — both of which gate
  ordinary ADDITIONS as well as removals (a twelfth agent spec would have
  reddened the suite). The control now asserts count-at-least-floor, and
  expected remaining counts are derived from live directory counts minus the
  fixed drop while the floor half still comes from the recorded floors map; a
  growth guard per attacked directory protects the reproduction itself from
  being silently diluted by future growth.
  (3) The enforcement signal's count term alone is compensation-defeatable — a
  SUM would be too, for the identical reason (lowering one floor while
  raising another by the same amount leaves the line byte-identical). The
  signal now also carries a digest (12 hex of sha256 over sorted `dir=floor`
  pairs), so two ledgers with the same key count but different floor values
  print different lines.
  (4) The complete seeding algorithm codified in the ledger's derivation block
  was previously verified only textually (regex phrases and floor-value
  literals). A new test (Test 41) recomputes the whole `floor_rule` over the
  RECORDED observed counts — never the live tree, since floors are minimums
  and growth must not redden the suite — using the overlay's own exported
  `isLocationSemantic()` predicate and the ledger's recorded fraction, and
  deep-equals the result against the committed floor map for all 18 keys.

- **Publish shape contract succession gate — round 2 follow-up** (T-541 round
  2) — a second security review found criterion 4 above unclosable AS
  SPECIFIED: Test 41 reads BOTH `derivation.observed_direct_file_counts_at_seeding`
  and `min_direct_files` from the SAME editable ledger it validates, so a
  coherent one-shot forgery of both together (e.g. `docs/assets` observed
  edited from the true 9 down to 3, floor edited from 5 down to
  `floor_rule(3, 0.6)` = 2) passes Test 41 by construction — reproduced end to
  end on the real assemble -> overlay pipeline, draining a directory three
  files below its true committed floor at exit 0 while the ordinary floor
  check (3 >= 2) also passes cleanly. No in-file predicate can ever close
  this: the seeding rule is codified IN the file, so a forger has every input
  the test has. Three alternatives were considered and rejected: recomputing
  from LIVE counts has no discriminator (both the attack and ordinary growth
  record below live); in-file append-only-ness is defeated by one coherent
  rewrite of the whole chain; and strict recorded-equals-live checked on
  every run reddens on ordinary growth, the identical defect criterion 2
  above just fixed. The fix needs an anchor the same commit cannot rewrite:
  the destination CLONE already holds the PREVIOUSLY PUBLISHED ledger — a
  one-step history no attacker commit can retroactively edit. A new
  succession gate (`checkShapeContractSuccession()` in
  `mavp-publish-overlay.js`, read-only planning phase, before any write)
  compares the clone's copy against the one about to be published and, on
  any publish where the seeding record itself changed, enforces three rules:
  DATED (`seeded_on` must strictly advance past the previously published
  date — a record that changed without its date advancing is a falsified
  historical observation), REAL (every re-seeded observed count must equal
  the assembled tree's own actual direct count AT THIS PUBLISH — the one
  moment recorded and live must coincide by definition, which is exactly why
  ordinary growth stays dormant and green), and REACHABLE (every re-seeded
  observed count must be >= the previously published FLOOR for that
  directory, not its previously published observed count, so legitimate
  shrinkage toward a floor followed by an honest re-seed at that floor still
  passes). A publish where the record is untouched never reaches any of the
  three; any floor that moved down or was dropped still prints a loud,
  NON-refusing weakening line naming the directory and both values, since
  `how_to_relax`'s own sanctioned relaxation (lower a floor, leave the record
  alone) must never be blocked by this gate. Test 41 is honestly rescoped in
  the same commit — its code, and Test 40's precomputed digests, are
  unchanged — from "the recompute invariant" to a DRIFT invariant against a
  sloppy re-seed (arithmetic mistake, stale fraction, a forgotten key): it
  cannot catch a coherent forgery, only the new succession gate (Test 42, six
  behavioral cases) can. `shapeContractDigest()` gains a scope comment (no
  code change): its digest covers the parsed floor map only, deliberately not
  the derivation block, because derivation-change visibility is the
  succession gate's job. The ledger's `how_to_relax`, `derivation.maintenance`
  and a new `succession_gate` field are rewritten to name all three rules as
  the re-seed protocol, and state the guarantee actually delivered — per-step
  MONOTONICITY plus MANDATORY VISIBILITY, never "forgery is impossible" —
  alongside three residuals deliberately left open, all closed by diff review
  at the same trust level as deleting the ledger outright: an N-step loud
  ratchet (re-seed 9->5, drain, re-seed 5->3, drain, each step dated and
  reviewable but nothing stops a reviewer rubber-stamping every step);
  remove-then-readd (dropping a floor prints a loud removal line, but
  re-declaring it afresh at the drained count is a brand-new key with no
  prior published floor to compare against); and out-of-band tampering with
  the clone mirror itself (an unparseable previously-published copy refuses,
  naming the mirror, but its own provenance beyond that is unverifiable by
  this gate). The armed re-seeding recheck (due 2026-09-27) must now satisfy
  both Test 41's drift invariant and the succession gate's three rules.

- **Publish shape contract succession gate — round 3, total decision function**
  (T-541 round 3) — a third security review found the round-2 gate's
  ACTIVATION condition lenient: it returned dormant (`return null`) whenever
  the ATTACKER-EDITABLE assembled ledger's derivation was missing or
  partial, before any of the three rules ever ran. Reproduced end to end:
  the round-1 coherent forgery (observed 9->3, floor 5->2 on one directory)
  PLUS deleting `derivation.seeded_on` published at exit 0 with no output at
  all, even though the clone held a full previously-published anchor to
  refuse it against. `checkShapeContractSuccession()` is now fail-closed and
  TOTAL over the assembled side whenever the clone anchor is full: exactly
  three accepted states — the record byte-identical to what the clone last
  published (silent), a valid dated delta-verified re-seed (loud), or the
  ledger deleted from the assembled tree entirely (loud stand-down, the
  sanctioned relaxation made visible rather than silent as round 2 left it)
  — and everything else (absent or partial assembled derivation) refuses
  before any write, naming the three green paths. A second finding: rules 2
  (REAL) and 3 (REACHABLE) iterated every recorded key rather than the
  DELTA, so the ledger's own sanctioned partial re-seed was refused blaming
  an untouched directory whose recorded count had simply drifted from
  ordinary repo growth (measured live: re-seeding `docs/assets` alone,
  refused citing `scripts` recorded below its already-grown live count).
  `computeObservedDelta()` now scopes both rules to the directories whose
  recorded observed count actually changed; a brand-new key gets REAL but
  not REACHABLE (no previously published floor to reach for a key that
  didn't exist before — a documented residual), and a removed key prints a
  loud, non-refusing line instead of participating in either rule. None of
  this reopens the ordinary end-state floor check, which reads live counts,
  never recorded ones, on every publish regardless of the gate's own state.
  Two smaller findings, from the architect: `recordChanged` ignored a bare
  `derivation.seeded_on` rewrite entirely (it compared only the observed
  maps), so a forward bump was silently dormant and a backdate was
  unexamined — `recordChanged` now covers a bare bump too (a forward bump
  with an otherwise-identical record is a valid, loud, empty-delta re-seed;
  a backdate, or an unchanged date with a changed record, refuses via
  DATED). And the clone-with-a-partial-anchor case (e.g. a legacy
  floors-only ledger) receiving a full derivation for the first time used to
  stay silently dormant with no anchor to compare against — it now prints a
  loud, non-refusing RECORD-INTRODUCED line, since a first-time honest
  completion of the ledger should never look identical to nothing having
  happened. DATED's canonical `YYYY-MM-DD` format is now validated, but only
  on the about-to-be-published date and only when DATED is actually
  evaluated (never on a dormant publish); a non-canonical PUBLISHED date
  (pre-round-3 history the clone mirror's own past cannot be edited to fix)
  is never refused on its shape — only the strict-advance comparison is
  skipped for that one publish, loudly, so an honest canonical successor
  re-seed is never wedged forever by a malformed lexicographic predecessor
  (a canonical `"2026-07-27"` sorts lexicographically BELOW a malformed
  `"2026-7-4"`). A new truth-table test (Test 43) enumerates all sixteen
  cells of {no clone file, unparseable clone, partial anchor, full anchor} x
  {no assembled ledger, floors-only, partial derivation, full derivation}
  and pins the verdict for each — the durable guard against this class of
  defect reopening, since a future lenient branch now reddens a specific
  named cell rather than waiting for a review to notice. `enforced_by`,
  `succession_gate`, and `maintenance` in the ledger are rewritten to state
  the three-accepted-states guarantee, the delta scope, and the DATED format
  rule; a fourth residual (genesis / record-introduction) joins the
  pre-existing three (loud ratchet, remove-then-readd, mirror provenance).

- **`--max-move-credit-ratio` flag** for `scripts/mavp-publish-overlay.js`
  (T-532): the whole-run move-credit cap (T-507 round 3, mechanism 2) gets
  its own per-tier stand-down flag, following the exact precedent of
  `--max-delete-ratio`/`--max-dir-delete-ratio` — both flag forms, validated
  0-1 by the existing `parseRatioFlag`, defaulting to the unchanged
  `MOVE_CREDIT_MAX_RATIO` (0.25) constant, and named verbatim in the cap's
  refusal message and its `--allow-mass-delete` suppression NOTE line.
  `MOVE_CREDIT_MIN_COUNT` (the 5-move absolute floor) is deliberately left a
  fixed constant, not flag-governed. Closes a real operational gap the cap's
  own design left open: a legitimate restructure that trips ONLY this tier
  (e.g. splitting a large flat directory into related subdirectories, 49 of
  a 194-file baseline credited as moved — 25.3%, just over the 25.0%
  default) previously had no way through except `--allow-mass-delete`, which
  drops every tier at once, including the full-wipe rule this file's design
  states must never be laundered — pushing an operator toward the blunt
  override for a cap-only refusal is exactly the cries-wolf failure mode
  move credit exists to prevent. Tier independence is proven by a dedicated
  test: `--max-move-credit-ratio 1` stands the cap down and nothing else — a
  fully-wiped small bucket in the same run still refuses via the full-wipe
  rule.

- **`--max-move-credit-ratio` threaded through `scripts/mavp-publish-build.js`**
  (T-536): the one-command publish orchestrator forwards this T-532 overlay
  flag to the overlay step exactly like the three older overlay override
  flags (`--allow-mass-delete`, `--max-delete-ratio`, `--max-dir-delete-ratio`)
  — parsed in both `--flag v` and `--flag=v` forms, forwarded via
  `buildOverlayOverrideArgs()` (now additively exported) when set, nothing
  forwarded when unset. Before this, an operator hitting a cap-only refusal
  through the orchestrator could only unblock it with `--allow-mass-delete`,
  which drops every tier including the full-wipe rule that must never be
  laundered — the exact cries-wolf failure T-532 closed at the overlay level,
  reintroduced one level up. `EDGE_PUSH_ARGS` and `stepPush`'s logged line
  (T-524) are unchanged.

- **Shared concurrency lock for the publish scripts** (T-506) —
  `scripts/mavp-publish-lock.js` (new, Node built-ins only) is now required by
  both `mavp-publish-build.js` and `mavp-publish-release.js` before either
  touches the shared mirror clone directory, closing a real gap: nothing
  before this task stopped two concurrent invocations — on the same clone, by
  the same or different scripts — from interleaving their `clone`/`checkout`/
  `commit`/`push` operations. The lock is a SIBLING directory
  (`<clone-dir>.lock`, derived via `path.resolve()` of the clone-dir argv, so
  a relative and an absolute invocation of the same clone correctly contend)
  acquired with a single non-recursive `fs.mkdirSync` — `{ recursive: true }`
  is forbidden for the acquire, since it would succeed silently against an
  already-locked directory. `mavp-publish-build.js` acquires it right after
  the scan gate passes and immediately before `stepCloneOrPull` (its first
  clone-directed git operation), held through `stepPush` (including
  `--dry-run` runs, which still write into the clone); `mavp-publish-release.js`
  — which had NO exit handler at all before this task, so a crash mid-run
  would have stranded the lock forever — acquires it immediately before its
  preflight fetch, held through the tag push, and gets a new
  `process.on('exit', ...)` handler for the release. Both scripts also gained
  `SIGINT`/`SIGTERM` handlers routing through `process.exit()` so an operator
  interrupt releases the lock too; only an unblockable `SIGKILL` can still
  strand it, and the next run's dead-pid detection recovers automatically from
  that. On contention the recorded holder's pid is liveness-probed: alive
  refuses non-zero naming the holder's pid/age/argv; dead announces a
  stale-lock takeover, removes it, and retries once; anything undecidable
  (corrupt/unreadable metadata, an `EPERM` probing the pid, or a recorded
  hostname that differs from the current host) fails closed, naming the lock
  path and a manual-removal instruction. There is no wall-clock-based
  auto-steal anywhere — a slow but legitimate publish is never stolen out from
  under itself. Neither script's own gate sequence is reordered, and
  `EDGE_PUSH_ARGS`/`stepPush`'s logged command line (T-524) stay byte-unchanged.

- **Publish lock round 2: CAS-guarded takeover, guarded release, canonicalized
  path** (T-506) — security review found a CRITICAL and a HIGH in round 1's
  lock. The dead-pid takeover was a TOCTOU: an unconditional
  `rmSync`+`mkdirSync` on a liveness decision cached before the mutation ran
  let a slow contender delete a lock a faster contender had already correctly
  taken over, reproduced live in 1 of 5 trials with two real OS processes,
  both ending up believing they held the lock exclusively. It is now a
  compare-and-swap: a per-acquisition random token is written into the lock
  metadata, the dead-pid branch exclusively creates a takeover guard file
  inside the stale instance first (`wx`; `EEXIST` fails closed naming the
  guard, `ENOENT` falls through to the ordinary single `mkdirSync` retry), and
  only removes the instance after a guard-protected re-read confirms the
  token (or, for a tokenless pre-fix lock, pid+start) still matches the
  snapshot decided dead — a mismatch aborts with ordinary contention, removing
  only its own guard file. `releaseLock()` is now guarded the same way: it
  removes the lock only when the metadata still names the releasing run's own
  token; a gone directory is a silent no-op, a foreign token or unreadable
  metadata is a refuse-to-remove no-op. Both publish scripts' exit handlers
  were still doing an inline, unconditional `fs.rmSync` on the lock path —
  fixing the module alone would have fixed nothing at the one destruction
  site that actually runs — so both now call the guarded `release()` closure
  instead. Separately, `resolveLockPath()` now canonicalizes: it walks to the
  nearest existing ancestor of the clone-dir path, `realpathSync()`s it, and
  re-appends the non-existing tail, closing the one shape that is genuinely
  vulnerable — the clone-dir argv's own last path component (not merely an
  ancestor of it) being a symlink, where appending `.lock` produces a sibling
  name next to the symlink rather than something reached through it, so two
  spellings differing only in that last component resolve to two physically
  distinct lock directories and never contend under the old uncanonicalized
  `path.resolve()`. An ancestor-only symlink (e.g. macOS's own `/tmp` ->
  `/private/tmp`) was never the vulnerability: the kernel resolves ancestor
  symlink components transparently during the `mkdirSync` syscall itself, so
  two such spellings already collided via EEXIST under the old code, both
  when the clone dir already exists and when it does not yet. A legacy-path
  liveness check additionally covers a lock a pre-fix run left at the old
  uncanonicalized spelling of the same clone-dir argv. **One-time
  upgrade note: do not run a publish across the deploy of this fix** — a
  pre-fix run's lock under a *different* path spelling than a post-fix
  invocation's own argv is invisible to the legacy-path check (it only
  recomputes the legacy path for its own argv spelling); the common
  same-spelling case is fully covered. No wall-clock auto-steal is introduced
  anywhere, and `EDGE_PUSH_ARGS`/`stepPush`'s logged line (T-524) remain
  byte-unchanged.
- **One-command working-build publisher** (`scripts/mavp-publish-build.js`,
  T-501, implementing DR-006's release-train cadence): chains the manual
  six-step publish ritual (`docs/PUBLIC_RELEASE_STRATEGY.md` §2) into a
  single command — assemble → secret-scan → clone-or-pull the mirror →
  checkout `edge` (creating it from the mirror's `main` tip on first run) →
  overlay → commit (neutral identity) → push `edge`. The secret scan is a
  hard abort-before-push gate: any finding, or any earlier step failing,
  aborts before the mirror is even contacted. Supports `--dry-run` (every
  step except the final push) and takes private project names via
  `--private-names`/argv only, never hardcoded. Never tags, never touches
  the mirror's `main`, never creates a GitHub Release — that is
  `scripts/mavp-publish-release.js` (T-502).
- **Stable-release promoter script** (`scripts/mavp-publish-release.js`,
  T-502, implementing DR-006's release-train cadence): fast-forward-promotes
  the mirror's `main` branch to the current `edge` tip, tags
  `v<MAVERICKS_VERSION>` (read from the edge tip, not the local repo),
  derives a multi-section release body from every `CHANGELOG.md` section
  newer than the previous stable tag, and PRINTS (never executes) the exact
  `gh release create` command plus the closing `~/.mavericks` (or
  `MAVERICKS_HOME`) pull step — preserving the human checkpoint. Refuses
  loudly, before any mutation, on: a non-fast-forward promotion (`main` not
  an ancestor of `edge`), an already-existing tag, a dirty or wrong-origin
  clone, a missing `edge`/`main` branch, no CHANGELOG.md section newer than
  the previous stable tag, or a non-numeric `MAVERICKS_VERSION`. Never
  assembles, scans, or publishes a working build itself — that is
  `scripts/mavp-publish-build.js` (T-501); this script only promotes and
  tags an existing `edge` tip.
- **Non-interactive task creation flags** for `--quick-task`
  (`--title`/`--problem`/`--repo`) and `--new-task` (`--title` plus optional
  `--owner`/`--repo`/`--depends-on`/`--requires-ux`/`--criteria`/
  `--verification-type`), plus a hard non-TTY guard: when stdin is not a TTY
  and a required flag is missing, both scripts now refuse before any
  read/write with an explicit error naming the missing flag(s), instead of
  silently registering a task with defaulted/blank fields (or, for
  `--new-task`, silently exiting 0 having written nothing). (T-490)
- **`Hold:` field** (DR-005, T-496): an optional per-task
  `- **Hold:** <what> — <why> (<since>)` field marks a task as deliberately
  held rather than stalled. Parsed by `parseHold()`/`isHoldEmpty()`
  (`mavp-operator-lib.js`), surfaced per active slice in `--agent` output and
  as a "Held tasks" section in `--snapshot`. Grants a scoped downgrade —
  ONLY the `blocked_by_open` advisory (`HOLD_DOWNGRADABLE_CHECKS`, a
  whitelist, not a blacklist of protected checks) and never a FAILURE-severity
  finding, so `merged` × unmerged-blocker stays FAILURE/exit 2 even with a
  `Hold:` present. Structurally cannot downgrade
  `merged_missing_commit_field`, evidence-completeness, mirror/sync-status,
  duplicate-entry detection, `config_check`, or `stale_verified`. Absence of
  `Hold:` is never a finding.

### Changed

- **Publish commit messages are pinned to UTF-8, and the read-back now fails
  closed on ANY difference** (T-539) — two paired changes to
  `scripts/mavp-publish-build.js` that must ship together.

  *The encoding pins.* `buildCommitConfigPins()` additionally pins
  `i18n.commitEncoding=utf-8` on the commit invocation, and a new
  `MESSAGE_READ_CONFIG_PINS` (`-c i18n.logOutputEncoding=utf-8`) is applied to
  every message read that feeds a gate or the read-back comparison: the default
  `--summary`'s HEAD-subject read, the provenance gate's and the range scan's
  per-commit body reads (kept byte-identical to each other), and the read-back
  itself. A legacy `i18n.commitEncoding` is an ordinary operator setting, not
  an attack, and without the pin it made `git` stamp an `encoding <that value>`
  header onto the published commit — echoing operator config into the public
  object and MISLABELLING the message bytes (git does not transcode a `-m`
  value; it only declares an encoding, so every later reader asking for a
  different output encoding re-interprets those bytes). On the read side the
  same config silently turned every message this script scanned or compared
  into non-UTF-8 bytes that Node then decoded as UTF-8. An ASCII message
  round-trips through the mislabel unchanged, so the commit-object header — not
  a string comparison — is what a test has to assert on.

  *The read-back tightening.* `assertCommittedMessageMatchesScanned()` now
  refuses on ANY difference between the composed and recorded message, where it
  previously refused only when the RECORDED text itself tripped the secret scan
  and otherwise WARNED and published. That fail-open shipped a string the run's
  own "Commit-message scan GREEN" certificate never covered, on an exit-0 run
  whose final line still read as success. With the commit invocation pinned
  (hooks-free `core.hooksPath`, `commit.cleanup=verbatim`,
  `i18n.commitEncoding=utf-8`), the read pinned to
  `i18n.logOutputEncoding=utf-8`, `-c` outranking the environment config forms,
  and trailing newlines normalized on both sides, there is no enumerable benign
  cause left for a difference — so a difference now means an unidentified
  rewriting mechanism is live inside the publish pipeline, which is precisely
  when this script must not write to the mirror. The re-scan is kept as
  DIAGNOSTICS only (the abort states whether the recorded text also trips the
  scan) and both branches undo the commit through the existing
  `git reset --soft HEAD~1` machinery and abort non-zero. The mismatch path now
  scans the RAW read-back bytes rather than the normalized string.

  The two halves are deliberately one change: the tightening alone would
  hard-refuse legitimate publishes for the benign encoding reason above, and
  the pins alone would leave the fail-open in place. `EDGE_PUSH_ARGS` and the
  push step's logged command line are byte-unchanged.

- **Close-session version-bump advisory is release-aware** (T-530): before
  `--close-session` advises bumping `scripts/mavp-version.js`, it now checks
  whether the current version is already tagged on the public mirror
  (resolved via `MAVERICKS_HOME`, read exclusively through
  `check-changelog-frozen.js`'s exported `resolveMirrorHome()`/`isGitRepo()`/
  `getMirrorTags()` — never a re-implemented mirror-directed `git` call, per
  T-517's GIT_DIR-precedence lesson). A tagged current version keeps today's
  bump advisory unchanged; an untagged (still-unreleased, still-accumulating)
  current version now prints an informational line instead, with no bump
  advice — bumping it would have orphaned the accumulating release. An
  unresolvable mirror degrades to the pre-T-530 advisory behavior unchanged.

- **`.claude/settings.json` is untracked in the canonical repo** (T-529): the
  Claude Code permission layer continuously appends every approved Bash
  command string to this file's `permissions.allow` array verbatim, so its
  live content is an append-only log of arbitrary operator commands that can
  carry private project names and absolute home paths. It is now removed
  from the git index and added to `.gitignore`; it stays on disk for Claude
  Code and permission-mode resolution to read, it is simply never committed
  again. `scripts/check-publish-manifest.js`'s reset-bucket invariant moves
  accordingly: a reset-bucket key (like this one) may now legitimately be
  untracked, and what the checker instead requires tracked is that key's
  mapped starter (`templates/SETTINGS_TEMPLATE.json`), since the starter —
  not the live file — is what the assembler actually ships. A non-reset
  untracked path is unaffected and still fails as a plain stale entry.

  **One-time migration note for anyone pulling across this change on an
  existing clone of the canonical repo** — the collaborator path was
  verified empirically with a bare remote and two clones, and it splits into
  two distinct cases with two different required actions:
  - **Clean local copy** (no uncommitted edits to the file): `git pull`
    succeeds, but git also deletes the file from the working tree as part
    of applying the untracking — the clone ends up with no settings file on
    disk.
  - **Dirty local copy** (uncommitted edits present — the realistic case,
    since the permission layer appends to this file continuously): `git
    pull` aborts with a local-changes-would-be-overwritten error (exit 1)
    before it applies anything. The operator must stash or discard the
    local changes first; once the pull succeeds afterward, the file is gone
    from disk exactly as in the clean-copy case.

  Recovery is the same after either path: stash or discard any local
  changes, pull, then reseed the file — either copy
  `templates/SETTINGS_TEMPLATE.json` into place at `.claude/settings.json`,
  or run the installer with `--update`, whose `permissions.defaultMode`
  backfill path (the T-319 logic) re-creates the file when it is missing
  and seeds `bypassPermissions` — both are verified behavior, not inferred.

  The public mirror is unaffected by any of this: the publish manifest
  keeps the reset-bucket mapping for this path, and the assembler sources
  every reset destination from its mapped starter read out of a HEAD tree
  extraction, never from the live working-tree file — so adopters cloning
  the mirror see a tracked, sanitized `.claude/settings.json` exactly as
  before, with no deletion event.
- **De-pinned the main-agent/session `fallbackModel` seed to the `opus`
  alias**: both `mavp-install.js` seed sites (fresh install and the
  `--update` only-if-absent backfill) now write `fallbackModel: ["opus"]`
  instead of the version-pinned `claude-opus-4-8`, so the orchestrator's
  safety-net chain tracks the latest Opus generation with no future edit.
  De-versioned the accompanying "Opus 4.8" prose in `README.md`,
  `CLAUDE.md`, `docs/AGENT_SPEC.md`, `docs/core/BOOTSTRAP_GUIDE.md`, and
  `docs/core/ORCHESTRATION_RULES.md` to say "Opus" / "latest Opus" instead
  (the three architect-frontmatter full-id sites are a deliberate,
  separately-tracked exception — see T-483). Migration note: existing
  adopters whose `fallbackModel` chain is still the old seeded default are
  migrated forward to the alias form on their next `--update` — see T-484
  below; any other, operator-customised chain continues to be preserved
  byte-identical since `--update` only backfills a missing key and never
  overwrites an existing one. (T-482)

- **De-pinned the last version-pinned model id from the sub-agent layer**:
  `.claude/agents/architect.md` frontmatter now declares `model: opus`
  instead of the version-pinned `claude-opus-4-8`, closing the exception
  T-482 left open — every `.claude/agents/*.md` frontmatter `model:` value
  is now an unversioned alias (`sonnet` for all ten workers, `opus` for
  architect). `docs/AGENT_SPEC.md` updated in lockstep: the architect
  frontmatter-default sentence and the "Why aliases, not full-ids"
  rationale no longer carry the architect full-id exception — the
  alias-only rule is now unconditional. `scripts/mavp-skill-reflect.js`'s
  optimizer model (a direct Anthropic Messages API call, not an Agent-tool
  spawn, so a full id is required — the Messages API does not accept
  aliases) moved from `claude-opus-4-8` to the current Opus generation
  full id `claude-opus-5`, with an inline comment recording the API
  constraint. (T-483)

- **Migrated adopter `fallbackModel` chains equal to the old seeded
  default** on `mavp-install.js --update`: the `--update` fallback-model
  step now checks, alongside its existing only-if-absent backfill, whether
  an existing chain deep-equals the exact old framework-seeded default
  `["claude-opus-4-8"]` — the installer's own historical fingerprint — and
  if so rewrites it to `["opus"]`, printing an `updated` console line so
  the rewrite is never silent. Any other chain (a different id, a longer
  or reordered chain, or an already-current `["opus"]`) is left byte-
  identical. Closes the migration gap T-482 left open.
  `docs/core/BOOTSTRAP_GUIDE.md`'s "Fallback model safety chain" paragraph
  now documents the fingerprint exception precisely.
  `test-install-wrapper-hook-resync.js` gained coverage for both the
  migration case and the non-migration (multi-element chain containing
  the old id) case. (T-484)

- **`blocked_by_open` gate-tier correction (DR-005)**: a `qa_passed` task
  with an unmerged `Blocked by:` dependency now fires at WARNING severity
  (exit 1 at worst) instead of FAILURE — that state is the gate correctly
  holding a task that finished its side and is waiting on someone else's,
  not a violation. `merged` with an unmerged blocker stays FAILURE (exit
  2) — shipping ahead of an unmet dependency remains the real violation.
  `ready_for_qa` keeps its existing WARNING tier, unchanged. Fixes a field
  report where a deliberately-held dependency chain permanently latched
  the validator at "repair required." (T-487)

- **Broadened the shipped secret-string rule to every ship file, not only
  test fixtures** (`.claude/rules/scripts.md`, T-509): three tasks in one
  wave shipped source where a human read the file and saw nothing wrong,
  yet the assemble+scan gate found a violation — a code comment
  describing the scanner's own detection categories tripped that category
  (T-505); a comment explaining the absolute-path discipline contained the
  matched token, because the scanner matches file text statically, with no
  concept of prose-about-the-rule versus a violation of it (T-502); and a
  private-name test argument sat as a plain literal in a ship-classified
  test file, which would have made that assertion pass for the wrong
  reason (T-513). The rule now names comments, doc prose, and test data as
  in scope alongside fixtures, restates the remedy (describe the pattern,
  never write the literal shape; build a needed token at runtime via
  concatenation so no contiguous literal exists in the file text), and
  states plainly that reading/grepping a file is not the verification
  step — running the assemble+scan gate is. The existing fixture-specific
  guidance is preserved unchanged.

### Fixed

- **The commit-message gate now covers the ahead-range push and the commit
  object itself, not just the string one run composes** (T-523, security
  review round 2 — two HIGH findings, both reproduced end to end against a
  bare mirror). (H1) The gate was per-commit AT CREATION TIME while
  `stepPush()` publishes a RANGE (T-514). Because the provenance trailer
  binds to the commit's TREE, a message-only `git commit --amend` left the
  tree byte-identical and the trailer valid; the next run then found nothing
  staged, so `stepCommit()` returned early, the creation-time gate was never
  invoked at all, and the reworded — never scanned — message was pushed at
  exit 0 with no warning. Not an adversarial route: the script's own
  `--dry-run` flow invites the operator to inspect the local commits, and
  `git commit --amend` pre-fills the existing message including the trailer.
  `stepPush()` now re-scans the FULL message of every commit in the range,
  after the provenance check and before the push invocation, using the same
  `--private-names` list `main()` already threads into `stepCommit()` — so
  the same gate also covers hand-crafted trailers and commits stranded on a
  local `edge` by a version of this script predating the message gate. An
  unreadable message or an unenumerable range refuses the push (fail
  closed). (H2) The string that was SCANNED was not necessarily the string
  the commit object RECORDS: `git` rewrites messages through
  `prepare-commit-msg`, which runs even with `-m`, and `core.hooksPath` from
  the operator's global config applies to the mirror clone — an ordinary
  "append derived metadata to every commit" hook made a run log
  `Commit-message scan GREEN (3 line(s) scanned...)` and then publish a
  five-line message carrying private text. `--no-verify` does NOT close this
  (it skips `pre-commit`/`commit-msg`, not `prepare-commit-msg`). Fixed in
  both halves: the commit invocation is now pinned
  (`core.hooksPath` at a guaranteed-empty directory, `commit.gpgSign=false`
  so a globally configured signing key cannot embed the operator's key UID
  in the public commit object, `commit.cleanup=verbatim` so git's own
  normalization cannot make composition and artifact differ), and the
  message the commit actually records is read back (`git log -1
  --format=%B`) and compared against the scanned string — on any difference
  the recorded text is re-scanned and, on findings, the commit is undone
  (`git reset --soft HEAD~1`, history only: the overlay's staged content
  survives) and the run aborts, so the run's certificate covers the artifact
  rather than the input. Also: the neutral public identity is now pinned
  against the environment — `-c user.name`/`-c user.email` LOSE to
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so the guarantee in
  `docs/PUBLIC_RELEASE_STRATEGY.md` §2 step 5 silently failed wherever those
  six variables are exported; the commit spawn now passes an explicit
  environment that overrides the four NAME/EMAIL variables and deletes the
  two DATE ones. And the message-gate abort no longer prescribes a
  corrective re-run that immediately fails: it states that the clone holds
  the overlay's writes and must be cleaned (or a fresh clone dir used)
  first, instead of leaving an operator to reach for a hard reset inside the
  publish clone. Six new cases in `test-publish-build.js`, each with the
  reviewer's own reproduction and mirror-level ground truth: the
  amend-then-republish sequence; the `prepare-commit-msg` hook fixture with
  a load-bearing proof that it fires when unpinned, under `--no-verify`, and
  through the `GIT_CONFIG_COUNT` environment form of `core.hooksPath`; a
  `git` wrapper on PATH (a rewriting vector no `git -c` pin can reach) that
  exercises the read-back closure; a CLI-level two-line `--summary` whose
  SECOND line carries the planted value — the case a call-site subject-only
  narrowing survived through round 1; the identity scrub under all six
  exported variables; and the `commit.cleanup=verbatim` pin.

- **`computeNextAction()`'s `STATUS_PRIORITY` can no longer silently drift
  out of agreement with `IN_FLIGHT_STATUSES`, and its unknown-in-flight
  fallback is now fail-safe** (T-528): `STATUS_PRIORITY`
  (`scripts/mavp-operator-agent.js`) was a function-local map consulted
  with a `?? 99` default at its in-flight candidate call site. Any status
  present in `IN_FLIGHT_STATUSES` (`scripts/mavp-operator-lib.js`) but
  absent from `STATUS_PRIORITY` therefore ranked at 99 — BELOW `planned`'s
  4 — so `next_action` could route to fresh work while an active task sat
  unaddressed. T-525 added the two entries missing at the time but left
  the hazard open. `STATUS_PRIORITY` is now module-scope and additively
  exported so `scripts/test-status-priority-agreement.js` can assert every
  `IN_FLIGHT_STATUSES` member plus `planned` has an explicit entry,
  catching drift the moment it is introduced; the in-flight candidate call
  site's fallback changes from `99` to `3` (the active-development tier) —
  a candidate reaching that lookup has, by construction, already passed
  the `IN_FLIGHT_STATUSES` filter, so an unrecognised status there is
  still active work, never absent work.

- **Origin field + architect-gate advisory at task registration** (T-531):
  `--apply-decomposition` now stamps `- **Origin:** architect` on every
  BACKLOG task it registers — that path IS the mandatory architect
  decomposition gate. `--new-task` and `--quick-task` stamp
  `- **Origin:** manual` by default and print a whole-line advisory naming
  the architect gate whenever origin resolves to manual; both commands
  accept `--origin architect` to attest the task was actually
  architect-decomposed despite bypassing `--apply-decomposition`, which
  stamps `architect` instead and suppresses the advisory. This is an
  advisory signal by design, not enforcement — absence of `Origin:` on
  pre-existing tasks is never a finding, and no validator check was added;
  the field exists to give `scripts/mavp-skill-reflect.js` and future
  counting surfaces a grep-able trail of gate bypasses. `Origin:` is
  BACKLOG-only and is never mirrored into `TASK_STATUS.md`.
- **`test-operator-demo.js`'s Test 9 no longer flakes against a non-quiescent
  repo**: it compared the ENTIRE repo's `git status --porcelain` output
  before/after the whole test run, so any unrelated change landing during
  that window — a sub-agent committing in a worktree, a cherry-pick
  completing in main, a stray hand-edit — read as a failure even though the
  demo (which only ever writes under `os.tmpdir()`) had done nothing wrong.
  The comparison is now scoped to what the demo could plausibly be
  responsible for: the repo-root state artifacts its child tools mutate
  (`BACKLOG.md`, `TASK_STATUS.md`, `PROCESS_STATE.md`, `PROCESS_STATE.json`,
  `HANDOFF.md`, `EXECUTION_LOG.md`) and any `mavp-demo-*` fixture directory
  that escaped `os.tmpdir()` into the repo tree — it still fails on either of
  those, just not on unrelated repo churn. (T-508)
- **`test-operator-demo.js`'s Test 9 now detects a demo write to an
  already-dirty protected artifact**: the scoped check above still compared
  git porcelain STATUS LINES, not content — a tracked file's porcelain line
  is identical (` M BACKLOG.md`) no matter how many times, or how much, its
  content changes, so a further demo-attributable write to a protected
  artifact that was already dirty before the run (the common mid-session
  case, since `BACKLOG.md`/`TASK_STATUS.md` are edited constantly) left the
  before/after lines byte-identical and slipped through undetected. The six
  protected-artifact paths are now compared by content (a sha256 of each
  file's bytes, with an absent file hashing to `null`), so an already-dirty
  file written again, a newly created protected artifact, or a deleted one
  are all correctly detected; the escaped `mavp-demo-*` fixture-directory
  check is unchanged (still path-based — a directory has no single content
  to hash), and unrelated repo churn still cannot fail the assertion.
  (T-515)
- **`test-operator-demo.js`'s Tests 2/5/13 no longer flake against a
  concurrent invocation of the same suite**: they each diffed a before/after
  `os.tmpdir()` listing filtered to the `mavp-demo-` prefix, but
  `os.tmpdir()` is machine-global — shared between the main checkout and
  every worktree — and every worktree developer sub-agent runs this same
  suite as its own definition-of-done check, so a sibling invocation's own
  demo fixture appearing mid-window read as a leftover fixture and failed
  the assertion. The suite now `mkdtemp`s a private per-run root inside the
  real `os.tmpdir()` (prefixed `mavp-testroot-`, deliberately not
  `mavp-demo-`, so it can't itself become an intruder) and injects it into
  every spawned demo child as `TMPDIR`/`TEMP`/`TMP`, so the child's own
  `os.tmpdir()` — and therefore `buildFixture()`/`assertUnderTmpDir()` inside
  `mavp-operator-demo.js`, unmodified — resolves there instead of to the
  machine-global tmpdir; the suite's own fixture listing now reads from that
  private root instead. The private root is removed at suite end including
  on a failing run. Adopters running parallel CI jobs that share a temp
  directory hit the identical collision. (T-519)
- **`commit_unreachable` is now hub-aware and caps archived-section noise**:
  `extractCommitEntriesFromEvidence()` keeps the parenthesized cross-repo
  annotation from the documented `commit: <hash> (repo-a)` evidence format
  (previously discarded during extraction), and `checkCommitReachable()`
  now skips the local reachability check per-hash when that annotation
  resolves to a known `docs/REPO_MAP.md` id other than the self repo — even
  when the record itself has no `Repo:` field (the common case for
  archived, pre-convention entries). An annotation naming the self repo, or
  matching no known repo-map id, still falls through to the normal local
  check (a genuine footgun still fires — an unrecognized annotation is
  never silently trusted as "elsewhere"). Separately, "Recently completed"
  section unreachable findings above `ARCHIVED_UNREACHABLE_AGGREGATE_THRESHOLD`
  (5) now collapse into a single aggregate info finding naming the count,
  instead of one line per hash — real warnings no longer get drowned by
  historical archive debt. Severity and exit-code behavior are unchanged
  (archived stays info, active stays warning; the aggregate is still info).
  (T-489)
- **`--update` now migrates the pre-T-304 seeded `--validate` PostToolUse
  hook** (commit `ca43986`, superseded by `53adbb5`): adopters bootstrapped
  before T-304 carried a bare `cd <project> && ./scripts/mavp-operator
  --validate 2>&1` hook — no file-path filter, no debounce, exit code
  propagated verbatim, stderr folded into stdout — which reported a failed
  hook with "No stderr output" on every single edit in a repo latched at
  validator exit 2. `isManagedPostToolUseCommand` now recognizes this exact
  historical fingerprint (a fully-anchored regex wildcarding only the `cd
  <path>` segment, so no operator-authored hook that merely mentions
  `--validate` in a different shape can collide) and `--update` replaces it
  with the current hardened managed command; if both the legacy seed and a
  current managed entry are present as separate `PostToolUse` array
  entries, they collapse into a single surviving managed entry instead of
  running side by side. Security review round 2 found the wildcarded `<path>`
  segment was a bare `.+`, which let regex backtracking absorb an operator's
  own chained command placed between `cd <path>` and the fixed tail (e.g.
  `cd X && npm test && ./scripts/mavp-operator --validate 2>&1` falsely
  matched and would have had `npm test` silently destroyed on the next
  `--update`) — the segment is now a path-shaped character class that
  excludes every shell metacharacter that can start a new statement or
  substitution (`&`, `|`, `;`, backtick, `$`, `(`, `)`, `<`, `>`, quotes,
  newline), closing the whole class of compound-command false positives, not
  just the one shape found in review. (T-488)
- **Legacy-hook fingerprint's excluded-character class now also excludes CR,
  U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR, and U+00A0 NBSP**:
  T-488's security review confirmed these four bytes were not exploitable
  (none is a bash metacharacter or default-IFS whitespace, so none can hide
  a second executed command) but left an informational note that the
  surrounding comment claimed the class excluded any control/separator byte
  when it did not. `LEGACY_SEEDED_VALIDATE_HOOK_RE`'s excluded-character
  class and its comment now match; ordinary paths (spaces, tilde, brackets,
  an `=` segment) and the genuine historical seed still match. (T-495)
- **`--snapshot` now names only in-flight tasks as the Active task**:
  `parseActiveTask()` in `mavp-operator-lib.js` previously picked the first
  block in TASK_STATUS.md's "## Active tasks" section unconditionally,
  regardless of status — so a terminal task (`deferred`/`merged`/
  `deprecated`) sitting at the top of that section could be presented as
  the session's current focus. It now selects the first block whose
  status is in the shared `IN_FLIGHT_STATUSES` set (the same set
  `computeNextAction()` in `mavp-operator-agent.js` already used —
  `mavp-operator-agent.js` now imports it from `mavp-operator-lib.js`
  instead of redefining it locally), skipping terminal entries; when no
  in-flight task exists the panel reports "none — no in-flight task"
  instead of naming a terminal one. (T-493)
- **`blocked_by_unresolvable` no longer fires for the standard `Blocked by:`
  no-blockers placeholder**: `checkBlockedBy()` in `mavp-validator.js`
  previously tested the raw field for truthiness before parsing, so the
  em-dash (`—`) or plain-hyphen (`-`) placeholder already accepted by
  `parseBlockedBy()` as "no blockers" fell through to
  `blocked_by_unresolvable` once a task reached a gated status
  (`ready_for_qa`, `qa_passed`, `merged`). Both functions now route the
  emptiness decision through a new shared `isBlockedByEmpty()` helper in
  `mavp-operator-lib.js`, so they cannot disagree on what counts as empty.
  A genuinely non-empty, unparsable value still produces
  `blocked_by_unresolvable` unchanged. `.claude/rules/backlog.md` now
  documents the omit-or-placeholder convention. (T-492)
- **Pre-commit blocked-commit message and `docs/core/BOOTSTRAP_GUIDE.md` now
  print the adopter-correct validator command**: `.claude/hooks/pre-commit`
  (copied verbatim into every adopter project by `mavp-install.js`'s
  `installHook()`) told a blocked committer to run `node
  scripts/mavp-validator.js` — a script that only exists in this
  self-hosting mavericks checkout, not in direct-reference adopter repos,
  so the single most-run remediation command failed for every adopter who
  ever hit a blocked commit. Both the hook's `COMMIT BLOCKED` message and
  the two matching `BOOTSTRAP_GUIDE.md` sites (Step 4 verify-setup block
  and the pre-commit exit-code table) now print `./scripts/mavp-operator
  --validate`, which resolves correctly in both self-hosting and adopter
  repos. Mavericks' own `CLAUDE.md` operational-commands block is
  unchanged — the direct `node scripts/mavp-validator.js` form is still
  correct there. (T-491)
- **Closes the same defect class T-491 opened, in the remaining
  installer-copied sites**: `.claude/agents/developer.md`, `qa.md`, and
  `product-docs.md` (all copied verbatim into every adopter project by
  `mavp-install.js`) still instructed and, in `product-docs.md`'s and
  `developer.md`'s/`qa.md`'s Bash tool allowlists, still pre-authorized the
  self-hosting-only `node scripts/mavp-validator.js` form. All three specs'
  prose and allowlist entries now use `./scripts/mavp-operator --validate`.
  Two further genuinely adopter-facing sites are fixed to match:
  `docs/RETROACTIVE_TASK_PATTERN.md`'s post-registration checklist and
  `docs/SKILL_OPTIMIZATION.md`'s human-review-gate step (both shipped docs
  describing a workflow adopters run in their own repo via the
  `--reflect-skill` / retroactive-task mechanisms). `docs/SKILLS_AUDIT.md`
  is left unchanged — it is an excluded-from-publish, point-in-time
  internal audit memo of mavericks' own agent specs, not adopter-facing.
  (T-494)
- **`insertIntoActiveTasks` now bounds itself to the `## Active tasks`
  section, killing a silent duplicate-skeleton bug**: the helper anchored
  on the following `## Recently completed tasks` landmark instead of
  bounding its own `## Active tasks` section, so in any TASK_STATUS.md with
  an intermediate section between the two (`## Parked — Wave N`, `##
  Deferred tasks`) new entries landed inside that intermediate section
  instead of Active tasks. Because the sync hook's own section-bounded
  reader (`parseTaskStatusActiveIds`) correctly scoped to `## Active
  tasks`, it still saw the task as missing — so every subsequent BACKLOG
  edit created another skeleton entry, and the misplacement
  self-multiplied on its own. Now bounded to the end of `## Active tasks`
  (next `## ` heading), mirroring `insertIntoActiveWave`'s existing
  approach, falling back to before `## Recently completed tasks` then EOF
  when that section is absent. The fix covers all six commands that share
  the helper: `--quick-task`, `--new-task`, `--apply-decomposition`,
  `--quick-merge`, `--rescope-task`, and the sync-status hook — not just
  the hook. (T-485)
- **Deletion-ratio guard in `mavp-publish-overlay.js`**: a security review of
  the new working-build publisher found a chain where an ordinary manifest
  edit (emptying `ship`, or reclassifying tracked paths to `exclude`) can
  produce an empty assembled tree that the overlay then applies against a
  populated public-mirror clone as a mass deletion, with every gate along
  the way reporting success. The overlay now computes, before any copy or
  delete, what fraction of the clone's non-preserved tracked files the
  planned deletion would remove, and refuses (non-zero exit, zero writes)
  when that exceeds a threshold — configurable via `--max-delete-ratio`,
  default 50% — unless the operator passes `--allow-mass-delete`. A
  zero-file (or fully-preserved) clone is treated as vacuously safe rather
  than a division error, so the very first working-build publish (a fresh
  `edge` branch bootstrapped from a bare `main`) is unaffected. Defence in
  depth behind the primary non-empty-assembled-tree assertion landing in
  `mavp-publish-build.js` (T-501) — either fix alone closes the chain; both
  together is the safer posture. (T-504)
- **Per-directory composition guard in `mavp-publish-overlay.js`**: the
  T-504 whole-clone ratio has a blind spot — a manifest edit that drops one
  or more entire subdirectories from the ship set while the overall file
  COUNT stays inflated by other, unrelated tracked paths can clear that
  ratio even though real structural content silently vanished. The overlay
  now additionally checks every directory at any depth (root-level files as
  a pseudo-directory) that holds at least `MIN_DIR_SIZE` (default 5)
  non-preserved baseline files — from the mirror's own fetched `edge` tree,
  no new persisted state — and refuses if that directory's own deletion
  ratio meets or exceeds `DIR_MAX_DELETE_RATIO` (default 0.5), independent
  of the whole-clone ratio. `--allow-mass-delete` overrides all of the
  guards below (and now reports exactly what it suppressed, rather than
  overriding silently); a new `--max-dir-delete-ratio` flag overrides the
  per-directory threshold alone. `mavp-publish-build.js` now passes
  `--allow-mass-delete`, `--max-delete-ratio`, and `--max-dir-delete-ratio`
  through to the overlay step, closing the escape-hatch gap T-504's own
  evidence recorded (a legitimate mass-deletion release previously had no
  path through the orchestrator). The empty-clone bootstrap case (first-ever
  publish) is a documented residual — it skips vacuously since no directory
  reaches `MIN_DIR_SIZE`.

  A security review (round 1) found the `MIN_DIR_SIZE` floor alone exempted
  11 of this project's own 18 real ship-set directories entirely — including
  `.claude/hooks/`, `.claude/rules/`, and `.github/workflows/`, each a
  single-digit file count — so a one-line manifest edit dropping any one of
  them was completely silent, and the per-directory ratio's strict `>`
  let an exact half-deletion pass. Both are closed: every directory,
  regardless of size, that is COMPLETELY emptied is now always a violation;
  every sub-`MIN_DIR_SIZE` directory is additionally folded into one
  aggregate bucket that is itself ratio-checked, so touching many small,
  individually-exempt directories at once is no longer invisible; and the
  ratio comparisons are `>=`, not `>`. The review also demonstrated that
  per-directory ratio-capping alone cannot meaningfully lower the aggregate
  volume ceiling below the whole-clone ratio — several directories, each
  individually within its own budget, previously summed to a 35-50% silent
  deletion. A new check closes this: once more than one directory bucket is
  simultaneously touched, the combined deletion across all of them is held
  to half of `DIR_MAX_DELETE_RATIO`. Move/rename awareness (a deletion
  candidate whose byte-identical content reappears at a different path in
  the assembled tree) keeps all of the above from firing on an ordinary
  reorg — the common, legitimate case this guard must not cry wolf on.
  Correction to this entry's own earlier wording: the guard's contribution
  is now closing these specific, real gaps and providing SHAPE protection
  (no directory, and no aggregate of small or simultaneously-touched
  directories, can be silently drained past its ratio) — it was never, and
  still is not, a meaningfully lower overall volume bound than the T-504
  whole-clone ratio already provides on its own.

  Move credit is the one mechanism that can suppress this guard's deletion
  counts, so it is now constrained on four independent axes, and the
  operator-visible consequence is four distinct checks (not all of them
  refusals in their own right — see the correction below). Two were
  already shipped but went unmentioned in the wording above, and both are
  corrected here too: **a relocation out of `.github/`, `.claude/hooks/`,
  `.claude/rules/` or `.claude/agents/` earns no move credit** (those paths
  only function from where they are, so relocating one is functional
  disablement while the bytes still ship, and credit would launder that as
  an ordinary rename) — the mechanism withholds credit, it does not refuse
  on its own; whether the run is actually refused still depends on whether
  the resulting, uncredited count trips a tier. The true, narrower
  consequence worth keeping: the SMALLEST real buckets under these four
  prefixes (this project's own `.claude/hooks/` and `.github/workflows/`
  are each a lone file today) are single-file, so an uncredited relocation
  of that one file is always a 1-of-1 full wipe — `rawDeleted === total`,
  which the full-wipe rule (never suppressible by move credit) catches at
  any size — and in practice always refuses. A larger bucket under one of
  these same prefixes (`.claude/agents/`, well above `MIN_DIR_SIZE`, is not
  size-exempt at all) behaves like any other uncredited relocation instead:
  refused only when the resulting count actually trips a tier, exactly as
  below. Likewise **a rename performed while moving a file earns no move
  credit** (move credit requires the basename to be preserved) — a plain
  no-credit case with no always-refuses consequence of its own: whether it
  is refused depends, same as an unrelated-tree relocation, on whether the
  resulting uncredited count trips the whole-clone ratio, a per-directory
  ratio, or the full-wipe rule. Two more land now, after a further security review (round 3)
  showed the guard was narrowed but not closed: leaving exactly one file per
  directory bucket, preserving every basename, staying off those four
  prefixes and re-adding every dropped file's bytes under one unrelated
  directory drained ~85% of the ship set with every guard reporting zero
  loss, the secret scan green (identical bytes) and the size floor green
  (identical count). So: **a move is credited only towards a RELATED
  destination** — one sharing the source's non-empty first path segment,
  which covers moving up, down or sideways within one top-level tree.
  Correction to this entry's earlier wording: a relocation into an unrelated
  tree, or a root-level file (licence, readme, package manifest, installer)
  relocated into any subdirectory, earns no credit — it is NOT, on its own,
  a refusal. The mechanism only withholds credit; whether the run is
  actually refused still depends on whether the resulting, uncredited counts
  go on to trip the whole-clone ratio, a per-directory ratio, or the
  full-wipe rule. An uncredited relocation that is otherwise small enough to
  clear every other tier still passes (e.g. relocating 1 of 12 files from
  one directory into an unrelated tree is uncredited and still passes, at
  8.3%); and **a single run may not credit 25% or more of the baseline as
  moved** — this cap is the one condition among the four where credit denial
  and refusal genuinely coincide, since it fires on the credited-move total
  itself — however legitimately each individual credit was earned, since an
  attacker can otherwise stay "related" by relocating every file into an
  attic directory inside its own top-level segment. The cap has
  an absolute floor of 5 credited moves so small legitimate reorgs are not
  ratio-noise victims, and it is deliberately whole-run rather than
  per-bucket: a real reorg can legitimately move 4 of one directory's 7
  files (57%), so no per-bucket move ceiling at or below 50% is viable.
  Both new refusals are suppressible by `--allow-mass-delete` like their
  siblings, and — like them — are computed unconditionally, so the
  suppression NOTE still reports them. A related fix: re-applying the
  move-adjustment to its own output no longer overwrites the raw,
  pre-credit deletion counts, which would have quietly reverted the
  full-wipe rule's immunity to move credit. (T-507; the relatedness-check
  wording above was corrected by T-532, see below)
- **Hardened publish assemble path containment and scanner symlink
  handling**, closing two gaps a security review of T-501 surfaced (in
  files T-501 did not touch): (1) `mavp-publish-assemble.js` resolved
  every `ship`/`reset` manifest entry with a bare `path.join()` and never
  confirmed the result stayed inside its parent — a new `resolveContained()`
  helper now asserts containment via `path.relative()` for both the
  extraction-side source and the output-side destination of every entry,
  refusing (non-zero, no write) on any `".."`-segment escape. (2)
  `mavp-publish-scan.js`'s `walk()` unconditionally skipped every symlink
  (`if (entry.isSymbolicLink()) continue;`), so a ship-classified tracked
  symlink whose target string embedded a private path (an absolute
  home-directory path, or a private repo name) reached the public tree
  completely ungated; `walk()` now records symlinks separately and scans
  their target string (via `readlinkSync`, never dereferenced) through the
  same detection categories used for file content. Both scripts gained
  `module.exports` (guarded by `require.main === module`, mirroring
  `check-publish-manifest.js`'s existing pattern) so the new regression
  tests — `test-publish-assemble-containment.js` and
  `test-publish-scan-symlink.js` — can exercise the primitives directly;
  CLI behavior is unchanged. This matters more now than under the prior
  per-release cadence: DR-006's `edge`-branch working-build publisher
  makes the assemble + secret-scan chain the only barrier between the
  private tree and the public one, several times a day. (T-505)
- **`--agent` no longer latches `PROCESS_STATE_WARNING` by substring-scanning
  `PROCESS_STATE.json`**: the blocker resolution previously set `blocker:
  'PROCESS_STATE_WARNING'` whenever ANY string field in
  `PROCESS_STATE.json` — including narrative prose like `wave_goal`,
  `wave_summary`, or the wave strategy note — contained the literal phrase
  "REPAIR REQUIRED", so a field merely describing the problem could
  false-positive the latch and halt session-start even with a healthy
  validator. `--agent` already runs the validator itself via
  `runValidatorCheck()`; the blocker is now derived from that live result
  instead — `PROCESS_STATE_WARNING` fires iff the validator run returns its
  exit-2 REPAIR REQUIRED condition, otherwise `json.blocker || null` is used
  (the `PROCESS_STATE.md` blockers-list fallback and the `'none'`/`''`
  normalization to `null` are unchanged). Intended consequence: a genuinely
  repair-required repo now halts via `blocker` even when no warning string
  was ever recorded in `PROCESS_STATE.json`. Regression coverage added in
  `scripts/test-agent-blocker-latch.js`. (T-512)
- **`.claude/settings.json` no longer ships verbatim**: the Claude Code
  permission layer appends every approved Bash command string to this
  file's `permissions.allow` array as a session runs, so the live,
  on-disk copy is effectively an append-only log of arbitrary operator
  commands and can accumulate private project names, absolute home-
  directory paths, and scratchpad paths — this actually happened mid-wave
  and briefly tripped the publish scan gate with 6 findings before being
  scrubbed. `scripts/publish-manifest.json` now routes
  `.claude/settings.json` through the `reset` bucket instead of `ship`,
  sourced from a new sanitized starter, `templates/SETTINGS_TEMPLATE.json`
  (`permissions.defaultMode` only, no `allow`/`deny` entries) — so a fresh
  adopter checkout still gets a working settings file, but the assembled
  public tree can never carry whatever has accumulated on disk in this
  repo. A new adversarial regression test,
  `scripts/test-settings-json-reset.js`, plants a settings.json polluted
  with a private-name-shaped `allow` entry and an absolute path and proves
  the assembled tree produces zero `mavp-publish-scan.js` findings — and
  fails if the manifest classification is ever reverted to `ship`. (T-516)
- **`check-changelog-frozen.js` no longer resolves the PRIVATE canonical
  repo's tags inside a git hook**: every mirror-directed git call (`-C
  <mirror> fetch --tags`, `-C <mirror> tag -l`, `-C <mirror> rev-parse
  --is-inside-work-tree`) trusted `-C` to select the target repo, but
  `GIT_DIR` — which git sets in the environment of every process it
  invokes, including hooks — takes precedence over `-C`. Inside the guard's
  only production context (`.claude/hooks/pre-commit`), this meant the tag
  lookup silently read the private repo's own tags instead of the mirror
  clone's whenever `GIT_DIR` was ambient, wrongly freezing sections tagged
  only privately and, more dangerously, failing to freeze a section already
  tagged on the mirror but absent locally. A new `mirrorGitEnv()` helper
  strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/
  `GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_COMMON_DIR`/
  `GIT_PREFIX` from the child environment of every mirror-directed call, and
  the file's header comment — which wrongly asserted the private repo
  "carries no tags at all" — is corrected. The sibling audit found no other
  guard with the same exposure: `mavp-publish-release.js`'s matching
  `resolveMirrorHome()` only feeds a printed (never executed) suggestion,
  and `mavp-install.js`'s `-C`-based guards run from CI/manual invocations,
  never from a git hook. New regression coverage in
  `scripts/test-check-changelog-frozen.js` proves both directions with
  `GIT_DIR` set the way a hook sets it. (T-517)
- **Unified the private-names parser between the publish build orchestrator
  and the scan gate**: `mavp-publish-build.js`'s mandatory `--private-names`
  flag check and `mavp-publish-scan.js`'s own detection previously carried
  two independent copies of the split/trim/filter logic that decides what
  counts as a valid private name. `parsePrivateNamesList()` now lives once,
  in `mavp-publish-scan.js` (exported alongside the existing
  `resolvePrivateNames()`, which now delegates to it), and
  `mavp-publish-build.js` imports it instead of carrying a duplicate —
  requiring the scanner module has no side effect, since T-505 already
  guarded its `main()` behind a `require.main` check. Behavior is unchanged
  (the mandatory-vs-optional policy difference between the two scripts is
  untouched); a new `scripts/test-publish-shared-parser.js` asserts a single
  definition exists and both call sites agree on every input, including the
  degenerate comma/whitespace forms. (T-511)
- **`parsePrivateNamesList()` now refuses a punctuation-only private-name
  entry instead of silently accepting it**: a name made up entirely of
  non-word characters (three asterisks, a lone dot, a bare hyphen) satisfied
  the mandatory-flag count gate as a well-formed, non-empty list item, but
  could never match the scanner's word-boundary-anchored (`\b...\b`)
  detection regex — so the gate accepted it and detection for that name was
  a silent no-op, with the run still exiting 0/GREEN. The shared parser
  (T-511 made it the single call site for both scripts) now throws when any
  parsed entry contains no word character, and both call sites catch the
  throw and exit non-zero with an explanatory message — a mixed list (one
  valid name plus one punctuation-only entry) now refuses the whole
  invocation rather than silently narrowing what gets scanned for.
  `buildPrivateNameRegexes()` applies the identical predicate
  (`isUsablePrivateName`, newly exported) as defense in depth. Ordinary names
  — letters, digits, hyphens, and this project's real trailing-hyphen prefix
  form (a name ending in `-`, matching a family of repos) — are unaffected.
  `scripts/test-publish-shared-parser.js` gained coverage for the parse-time
  refusal (isolated and mixed), the regex builder's independent agreement,
  and an end-to-end CLI run proving the mixed case never reaches a clean
  exit. (T-510)
- **`mavp-publish-release.js`'s changelog fence parser no longer treats a
  4-or-more-space-indented line as a code-fence delimiter**: CommonMark
  caps a fence delimiter's leading indentation at three spaces, but
  `FENCE_RE` previously accepted any amount of leading whitespace
  (`\s*`), so a pair of deeply-indented fence-looking lines could bracket
  a real `## [x.y.z]` version heading and silently merge that section's
  content upward into the section above it. Tightened to `{0,3}` literal
  spaces (a leading tab is excluded too, matching CommonMark's tab-stop-4
  equivalence). This is a correctness fix, not a confidentiality one: the
  security reviewer's differential fuzz measured this class at 8888 of
  47106 fuzzed documents, all bounded to already-public content in this
  project's newest-first house style. (T-518)
- **`mavp-publish-build.js` no longer strands a working build after a
  `--dry-run`**: `stepPush()` used to gate on whether THIS run's own commit
  step produced a new commit, so a `--dry-run`'s local `edge` commit could
  never be pushed by a later real run against unchanged source — two exit-0
  `Done.` runs with nothing ever published, and no `edge` ref ever appearing
  on the mirror. It now pushes whenever local `edge` is ahead of
  `origin/edge` (or `origin/edge` does not exist yet), regardless of which
  run produced the commit. Every commit the script makes is now stamped
  with a scan-provenance marker (added only after the scan gate has already
  passed in that run) that binds to the exact tree the commit carries (a
  `git write-tree` sha captured right before committing), and before
  pushing, every commit in the ahead range is checked for that marker with
  its tree re-verified against the commit's own `%T` — a commit made by
  hand directly in the clone, or one whose tree was changed after the fact
  via `git commit --amend --no-edit` (which preserves the marker text while
  swapping in unscanned content), refuses the push rather than publishing
  an unverified history. When the run exits without pushing ahead-of-remote
  work, it now warns loudly instead of printing a bare `Done.`; a refusal
  the script itself makes (as opposed to the caller's own `--dry-run`)
  additionally exits non-zero. (T-514)
- **`mavp-publish-release.js`'s `pushMain`/`pushTag` now push with
  `--no-follow-tags` and explicit refspecs**: both previously pushed with
  branch/tag shorthand (`git push origin main`, `git push origin
  <tagName>`), so under `push.followTags=true` (a common global git
  setting) `pushMain`'s push would carry along every annotated tag
  reachable from `main` and missing on the remote — including a stray
  local tag created after the earlier `fetch --tags` step, which would
  reach the mirror completely bypassing the already-exists gate (that gate
  only ever checks `v<version>`). Both pushes now use `--no-follow-tags`
  with an explicit `refs/heads/main:refs/heads/main` /
  `refs/tags/<tag>:refs/tags/<tag>` refspec, removing the DWIM ambiguity
  too. The release tag itself is unaffected — `createTag()` creates it as
  a lightweight tag, so it still travels via the explicit refspec, not via
  tag-following; `--no-follow-tags` only suppresses auto-following OTHER
  annotated tags. The two-push structure and the `mainPushed`/tag-cleanup
  abort machinery (security review round 2, M2) are unchanged — this is
  the same finding class as T-520, in the one script that legitimately
  tags. `scripts/test-publish-release.js` gained a new fixture (Test 21):
  a stray local annotated tag reachable from `main` and missing on the
  mirror, promoted against a local bare mirror with `push.followTags=true`
  set on the clone, asserts the mirror's tag list afterward is exactly
  `v<version>` with the stray tag absent. (T-522)
- **`mavp-publish-build.js`'s `edge` push no longer carries local tags to the
  mirror**: it pushed with `git push -u origin edge`, and `push.followTags`
  (a clone- or machine-level git config, not something this script
  controlled) applies even when a refspec is given on the command line, so
  a clone with that setting turned on and an annotated tag reachable from
  `edge`'s history delivered the tag to the mirror alongside `edge` — a
  channel neither the header's "never tags" invariant nor the secret-scan
  gate covers, since the scanner only ever reads assembled tree files. The
  push is now `git push --no-follow-tags --recurse-submodules=no origin
  refs/heads/edge:refs/heads/edge`: `--no-follow-tags` is the only flag that
  closes `push.followTags`; the fully-qualified refspec makes
  `push.default`/`remote.origin.push`/ref-DWIM inert and makes a
  `remote.origin.mirror=true` clone fail loudly (git refuses combining
  mirror mode with an explicit refspec) instead of silently force-mirroring
  every local ref; `--recurse-submodules=no` pins the last config-driven
  transmit vector; the vestigial `-u`/`--set-upstream` is dropped, since
  nothing in the script reads an upstream. `url.*.pushInsteadOf` (which can
  rewrite the destination URL itself) is an accepted residual outside this
  fix's class. (T-520)
- **`mavp-publish-build.js`'s own tests no longer duplicate its `edge` push
  argv as a hardcoded copy**: T-520's `--no-follow-tags`/fully-qualified
  refspec/`--recurse-submodules=no` fix landed with two tests (`test-publish-
  build.js` Tests 11b/11c) that issued their OWN literal copy of the push
  command instead of observing what `stepPush()` actually runs — a security
  review confirmed both mutants (dropping the fully-qualified refspec,
  dropping `--recurse-submodules=no`) survived, since the tests were
  exercising git directly, not the script. The argv is now a single exported
  constant, `EDGE_PUSH_ARGS`; `stepPush()` spreads it into one `pushArgs`
  array that is both logged (`Running: git ...`) and passed to the actual
  `git push` invocation, so the two can never independently drift. Tests
  observe the script's argv two ways: a `deepStrictEqual` of `EDGE_PUSH_ARGS`
  required from the CLONE fixture the suite already executes (the committed
  copy under test, never the working tree — `git clone` reads committed
  objects, not uncommitted edits) against the expected literal list, and a
  whole-line match of the real run's logged command against that same
  expected list, closing both constant-drift and call-site-drift (e.g. an
  inline argument silently added on top of the spread). Test 11b is
  unchanged — its duplicated PRE-fix command is the deliberate load-bearing
  proof that Test 11a's fixture genuinely exercises the vulnerability class;
  Test 11c now sources its probe argv from the exported constant instead of
  its own hardcoded copy. (T-524)
- **The mirror commit message is no longer an unscanned publication channel**
  in `mavp-publish-build.js`: step 2 scanned the assembled tree, but the
  commit message published alongside it was never scanned by anything. It is
  composed from either the private repo's own HEAD subject line (the default)
  or an operator-supplied `--summary`, so both inputs fed the same published
  field and making `--summary` mandatory would not have closed the channel.
  The FULL composed message — subject, blank separator, and the T-514
  provenance trailer — now goes through the identical category set as the
  tree, including the private-name category built from the run's mandatory
  `--private-names`, and the run aborts loudly with guidance to pass a clean
  `--summary` on any finding. The gate is the statement immediately before the
  `git commit` invocation with nothing in between, so an abort provably
  precedes the commit: nothing is stranded on local `edge` for a later run's
  ahead-range push to pick up, and nothing reaches the mirror. Only the
  already-redacted findings are printed, never the offending message text.
  Implemented on the scanner's existing text-level entry point
  (`scanTextAgainstCategories`, T-505) plus a new exported
  `buildCategories(privateNames)` in `mavp-publish-scan.js` that is now the
  SINGLE definition of the category set, consumed by both the scanner's own
  `main()` and this gate — no duplicated category assembly (the T-511 lesson)
  and no temp file. Commit author identity is deliberately excluded, with the
  rationale recorded in a code comment: it is not derived from private
  content, and this project's own default is a deliberately-published OSS
  contact address the scanner's email category matches and its allow-list
  then has to except. Four new tests in `test-publish-build.js`: a planted
  private name in the source HEAD subject with no `--summary` aborts with the
  tree scan GREEN, the mirror's refs unchanged and local `edge` 0 commits
  ahead; the same fixture with a clean explicit `--summary` publishes and the
  message read back from the mirror carries that summary plus a trailer whose
  stamped tree equals the published commit's own `%T`; a private name in an
  explicit `--summary` aborts too, proving the channel is closed regardless
  of input source; and a unit-level pin that the real provenance trailer
  never trips a category, alongside one that a value on the trailer line IS
  found (so a subject-only scan cannot pass). The release path
  (`mavp-publish-release.js`) was audited and has no equivalent channel: the
  tag is lightweight, the release title is the tag name `v<version>` read
  from the already-scanned `scripts/mavp-version.js`, the body is derived
  from the already-scanned `CHANGELOG.md`, and the `gh release create`
  command is printed, never executed. (T-523)

## [0.38.2] — 2026-07-25

### Added

- **Behind-upstream source guard** in `mavp-install.js`: when the resolved
  framework source (`MAVERICKS_HOME` > `~/.mavericks` > legacy) is a git
  clone that is behind its own upstream, install / `--update` /
  `--hooks-only` now abort (exit 1, before any file write) with the exact
  remediation (`git -C <sourceRoot> pull`) instead of silently syncing a
  stale framework and stamping a stale `mavericks_version`. Uses a
  best-effort `git fetch` (4s timeout) then `rev-list --count
  HEAD..@{upstream}`; `--stale-source-ok` overrides, `--check` warns but
  continues, `--strip` skips. Silent no-op when the source is non-git, has
  no upstream, or the network is unavailable with a clean tracking ref.
  Complements the existing (T-444) stale-source guard — orthogonal
  mechanism. (T-477)

### Changed

- Release runbook (`docs/PUBLIC_RELEASE_STRATEGY.md`) now ends with an
  explicit `git -C ~/.mavericks pull` step so the adopter-facing source
  clone matches each freshly published release; `docs/core/BOOTSTRAP_GUIDE.md`
  documents the new gate and `--stale-source-ok` override. (T-478)

## [0.38.1] — 2026-07-24

### Fixed

- CI: `test-close-session-mode.js` Case 19 was environment-fragile — the
  git fixture relied on the ambient `init.defaultBranch`, so it passed
  locally (default `main`) but failed on CI runners defaulting to
  `master`. Fixtures now force `init.defaultBranch=main` explicitly. No
  production-code change (the `resolveRemoteTrackingRef()` behavior it
  exercises was already correct). (T-476)

### Changed

- Agent-spec consistency polish: read-only `git diff`/`git show` added to
  `security-reviewer`; a standard Escalation section added to
  `exa-researcher`; `technical-writer`'s floating protected bullet merged
  into Rules and its BACKLOG/TASK_STATUS guard given a protected block;
  `developer`'s description reworded to match the mandatory architect
  gate. (T-473)
- `architect` spec gains a Budget-awareness clause (converge and emit the
  decomposition block under budget pressure with a coverage note rather
  than dying silently), applied from a human-approved SKILL_PROPOSALS
  entry. (T-474)
- Worktree integration rule codified framework-wide in
  `docs/core/ORCHESTRATION_RULES.md`: record the on-branch hash produced
  by cherry-pick/merge as `commit:` evidence, never the sub-agent's
  worktree hash (they differ; using the worktree hash trips the validator's
  `commit_unreachable` check). (T-475)

## [0.38.0] — 2026-07-24

### Changed

- Validator internals consolidated (behavior-preserving; output byte-identical):
  a single `getProjectRoot()` helper replaces five copies of the
  `MAVERICKS_PROJECT_ROOT`-or-cwd idiom; `parseArtifacts()` reuses the
  existing `mergeFindings()` instead of a hand-rolled inline duplicate;
  and module/repo registry ID-extraction is deduplicated onto a single
  shared `extractHeadingIds()` + `META_HEADINGS` source in
  `mavp-operator-lib.js` (was four independently-maintained skip-sets).
  (T-460, T-461)
- Validator checks are now driven by a declarative `CHECKS` registry in
  `parseArtifacts()` instead of accreted per-feature `mergeFindings`
  call-sites and a drifted "Check N" comment scheme; each future check is
  a one-entry addition. Execution order and output are unchanged. (T-462)

### Fixed

- Agent-spec hardening from a full architect review of the 11 role specs
  (`docs/AGENT_SPEC_REVIEW.md`): the `developer` git allowlist no longer
  permits a pre-push bypass (`Bash(git -C *)` removed, `git diff`/`git log`
  wildcarded, `git merge --ff-only main` added, PreToolUse hook now blocks
  plain `git push`); `frontend-design` can commit its own work
  (git add/commit/status + npm run, commit-before-exit rule,
  BACKLOG/TASK_STATUS guard, Escalation section); the `qa` output contract
  enumerates all four legal outcomes and drops the "no partial results"
  convergence trap, plus read-only git for commit-evidence checks; and the
  architect-gate policy is reconciled across `ORCHESTRATION_RULES.md` and
  `ROLES.md` to match CLAUDE.md's mandatory-for-all-tasks language.
  (T-464, T-465, T-466, T-467, T-468)

### Added

- `.claude/rules/` added to `product-docs`' writable scope so
  RCA-codification rules-edit routings are executable. (T-469)
- `scripts/test-agent-spec-sync.js` — a mechanical guard asserting every
  `.claude/agents/*.md` frontmatter `model`/`maxTurns` matches
  `docs/AGENT_SPEC.md`, closing the drift class T-459 exposed. (T-470)

## [0.37.0] — 2026-07-24

### Changed

- Close-session deploy column now reflects actual deploy/push state
  instead of collapsing every status into "deployed". Respects
  `deploy_contours`: with contours 0/1 a merged task whose evidence
  commit is not reachable from the remote-tracking ref renders as
  "held / not pushed"; with contours ≥2, `deployed_dev` / `deployed_prod`
  render distinct labels and `merged` renders "not deployed" (fixes the
  fallthrough that previously showed deployed tasks as "not merged").
  Degrades to a status-only label when no remote is configured. (T-454)
- Validator `commit_unreachable` (Check 9) is now two-tier: a merged
  task's evidence hash held on a local branch but not on HEAD emits an
  info-severity "held on a local branch" finding that never affects the
  exit code (the normal state for pre-push / feature-branch workflows),
  while a hash reachable from no local ref preserves the original
  warning/info severities — killing the mass-warning noise floor without
  losing the pasted-worktree-hash footgun catch. (T-455)
- Validator `Blocked by:` resolution (Check 12) gains a hub-backlog
  fallback: when `<repo>/T-NNN` is not found in the target repo, the
  validating repo's own backlog is consulted before emitting
  `blocked_by_unresolvable`, accepted only when the local task's
  `Repo:`/`Repos:` field includes the referenced repo id. Makes the
  gate work for hub-model projects that track cross-repo tasks in one
  backlog; a no-op for single-repo projects. (T-456)
- PostToolUse validator hook stderr policy: full validator output now
  surfaces only on exit 2 (repair required); exit 1 (drifting) stays
  silent at edit time, keeping the "silent means no repair required"
  convention coherent and preventing persistent advisory warnings from
  acting as a de-facto per-edit block. The hook still always exits 0.
  (T-457)
- `security-reviewer` agent re-contracted to converge: one repo per
  invocation (multi-repo briefs report a blocker), a budget-awareness
  rule requiring a report with an explicit Coverage section instead of
  "no partial results", `maxTurns` raised 15 → 25, and an opus-escalation
  note for trust-boundary reviews. A new "Cross-repo security reviews"
  rule in `ORCHESTRATION_RULES.md` decomposes cross-repo reviews into
  per-repo spawns synthesized by the Main Agent. (T-458, T-459)

## [0.36.0] — 2026-07-24

### Added

- Self-install stale-source guard — `mavp-install.js` warns and skips the
  `PROCESS_STATE` version re-stamp when a self-install would stamp a
  version older than an available `~/.mavericks` / `MAVERICKS_HOME`
  source.
- `--set-status` / `--merge-task` evidence flags — `--commit <hash|HEAD>`
  and `--branch <name>` write commit evidence atomically, appending to
  (never clobbering) existing evidence; `HEAD` auto-resolves; a hash
  unreachable from the branch warns without blocking.
- Validator `commit_unreachable` advisory — flags merged-task evidence
  `commit:` hashes not reachable from HEAD, warning severity for Active
  tasks, info severity for Recently-completed.
- Repo-identity header — every mutating ritual command now prints
  `repo: <path> | wave: N | initiative: <...>` as its first line, so a
  wrong-repo run is obvious immediately.
- XS fast lane — `--quick-merge` now enforces XS thresholds (≤2 files,
  ≤10 changed lines, no new tracked files, no sensitive paths;
  binary/unresolvable commits refused) against the cited commit and
  supports batch registration; documented in
  `docs/core/ORCHESTRATION_RULES.md` as the sole sanctioned exception to
  the architect gate.

### Fixed

- `--close-session` wave-complete parity — interactive and
  non-interactive close now reach the same wave-complete decision; both
  announce "Wave N complete — archiving + incrementing" or name the
  tasks keeping the wave open; already-merged tasks auto-archive without
  a re-prompt.

### Changed

- Documented the session-close vs wave-close model in
  `docs/core/TASK_LIFECYCLE.md`.
- Hardened the developer role spec to require explicit per-criterion
  expected-vs-actual MATCH/MISMATCH evidence and a self-check
  distinguishing "passed a check" from "demonstrated the required
  behavior" — from a skill-reflection over real adopter trajectories.

## [0.35.0] — 2026-07-23

### Added

- `--park-wave [N] --reason "..."` and `--unpark-wave <N>` operator commands
  — relocate a wave's task blocks out of (and back into) the Active
  sections of BOTH `BACKLOG.md` and `TASK_STATUS.md`, so parked-wave tasks
  no longer bloat session-start, size budgets, or next-action routing.
  Round-trip restore is byte-identical.
- `--apply-decomposition` now supports multi-repo epics — an optional
  per-task `repo:` field in the decomposition block (rendered as
  `- **Repo:**` / `- **Repos:**`) and a `--repo <name>` batch default;
  `TASK_STATUS` stubs are now built from the shared library builder.
- Validator `duplicate_task_status_entry` check (warning severity) —
  detects a task duplicated across `TASK_STATUS.md` sections and
  duplicate section headings, catching incomplete-archival fallout that
  previous Active-only checks missed.
- `--check-sync` now reports a stale/naive managed `PostToolUse` hook in
  known projects and names `mavp-install.js --update <dir>` as the fix.
- Auto-sync (sync-status) now mirrors a renamed `BACKLOG.md` task heading
  title into `TASK_STATUS.md` (emitting "sync-status: retitled T-NNN"),
  clearing the persistent `title_mismatch` warning that status-only sync
  could never fix.
- `--check-sync` now warns when a `~/.mavericks` checkout's version lags
  the canonical repo, naming both versions and the path.

### Changed

- `artifact_size_budget` Active-section budgets now scale with active
  task count (`max(static default, per-task allowance × count)`), so a
  legitimate large epic wave no longer permanently trips the advisory;
  explicit `artifact_budgets` overrides still win. (info-severity, never
  blocking.)
- Templates (`BACKLOG_TEMPLATE.md`, `TASK_STATUS_TEMPLATE.md`)
  standardized to `- **Owner role:**` to match tooling/validator canon.

### Fixed

- `--close-session` mid-wave merge archival is now symmetric — merged
  tasks are archived out of BOTH `BACKLOG.md` (status set to merged +
  block moved out of Active Wave) and `TASK_STATUS.md`, eliminating the
  `missing_in_task_status` exit-2 and the sync-status
  skeleton-duplication loop. The validator now runs BEFORE
  `PROCESS_STATE` mutations, so an aborted (exit-2) close no longer
  leaves half-mutated state or double-bumps `wave_session` on re-run.
- Hooks now prefer a project's own `scripts/` (when
  `scripts/mavp-validator.js` is present) over the
  `MAVERICKS_HOME` > `~/.mavericks` > legacy resolution chain — a
  self-hosting mavericks checkout no longer runs its quality gates
  against a stale `~/.mavericks` mirror; adopter/direct-reference
  projects (no local validator) are unaffected.
- `--close-session` now creates the session commit on validator exit 0
  or 1 (warnings), skipping only on exit 2 (repair required) with an
  explicit "session commit SKIPPED" message — previously a
  warnings-only validator run silently skipped the commit.

## [0.33.0] — 2026-07-19

### Added

- `--archive-merged` operator command — archive merged task blocks out of
  `BACKLOG.md`'s Active Wave and `TASK_STATUS.md`'s Active tasks mid-wave,
  without waiting for the end-of-session close-out.
- Opt-in session-transcript archive — a `--transcript-archive` installer
  flag (works with fresh install, `--update`, and `--hooks-only`) activates
  a managed `SessionStart` hook that sweeps Claude Code session transcripts
  into a gitignored `.mavp/transcripts/<session-id>.jsonl` before Claude
  Code's ~30-day cleanup removes them. Off by default, local-disk only.
- Retention pruning for the transcript archive — set the
  `MAVP_TRANSCRIPT_RETENTION_DAYS` environment variable to bound the
  archive's growth; the default remains unlimited.
- Decision records gain an optional `Session:` lineage field — an opaque
  Claude Code session id pointing at the deliberation behind a record. The
  record body stays self-sufficient; the pointer is explicitly never
  load-bearing.

### Changed

- The status-sync hook now auto-creates a missing `TASK_STATUS.md` entry
  for any new `BACKLOG.md` Active Wave task, completing the
  BACKLOG→TASK_STATUS mirror automatically (deprecated and superseded
  tasks are skipped).
- Task registration in the state artifacts is documented as a
  Main-Agent-only responsibility, never delegated to sub-agent briefs.

### Fixed

- The status-sync PostToolUse hook is silent on no-ops — it only emits
  output for real errors and actual mutations, restoring the
  "silent means success" hook contract and eliminating alarm fatigue from
  routine no-op runs.

## [0.32.2] — 2026-07-15

### Added

- Cross-repo `Blocked by: <repo>/T-NNN` merge gate — the validator resolves
  the referenced repo through the repo-map registry and blocks (or warns on)
  a merge until the blocker task reaches `merged`, as a cross-repo
  complement to the existing same-repo `Depends on:` field.
- Repo-map registry (`docs/REPO_MAP.md`) — per-project registry of repo id,
  label, path, domain, and deploy metadata, used to resolve cross-repo
  references.
- RCA-to-codification (`docs/core/RCA_CODIFICATION.md`) — every root-cause
  analysis now routes each root cause to exactly one durable fix mechanism
  (rule edit, role-spec proposal, memory entry, armed recheck, or
  mechanical enforcement change), tracked by a follow-up task.
- Decision records (`docs/core/DECISIONS.md`) gain greppable lineage fields
  (`Informed by:` / `Supersedes:` / `Tasks:`) for tracing a decision through
  the tasks and log entries that acted on it.
- Publish-manifest creation-time guard plus a blocking commit-time backstop,
  so new files are classified (ship/exclude) at creation and enforced again
  before commit.
- Session start now renders an `UPDATE_AVAILABLE` notice when a newer
  framework version has been published.

### Changed

- README documents the cross-repo `Blocked by` merge gate and the new
  core-docs entries introduced above.

## [0.29.1 and earlier] — Baseline

A one-time inventory of the capabilities already established before this
changelog began:

- **Task lifecycle and state artifacts** — `BACKLOG.md`, `TASK_STATUS.md`,
  and `PROCESS_STATE.json`/`PROCESS_STATE.md` track every task through a
  defined lifecycle, enforced by a validator gate. See
  [`docs/core/TASK_LIFECYCLE.md`](docs/core/TASK_LIFECYCLE.md).
- **Operator CLI** — `scripts/mavp-operator` provides the dashboard,
  session-start briefs, task registration/status commands, wave close-out,
  and framework install/update/strip operations.
- **Sub-agent role specs** — per-role behavior definitions in
  [`.claude/agents/`](.claude/agents/), with the operating-model rules for
  how roles hand off work in [`docs/core/ROLES.md`](docs/core/ROLES.md).
- **Bootstrap and direct-reference model** — new projects are seeded via
  `mavp-install.js`, and bootstrapped projects reference this installation
  directly rather than vendoring core scripts. See
  [`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md).
- **Claude Code hooks** — `SessionStart`, `PostCompact`, and `PostToolUse`
  hooks activated by the installer, covering validator checks and
  doc-sync advisories. See
  [`docs/core/BOOTSTRAP_GUIDE.md`](docs/core/BOOTSTRAP_GUIDE.md) —
  "Claude Code hooks activation".
- **Skill-reflection loop** — mines past task outcomes and proposes bounded
  edits to role specs for human review. See
  [`docs/SKILL_OPTIMIZATION.md`](docs/SKILL_OPTIMIZATION.md).

Tags v0.23.3–v0.29.1 predate this changelog and are not individually
annotated.
