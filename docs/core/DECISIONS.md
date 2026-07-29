# Framework decisions

Lightweight decision records for choices about framework structure. Each record states the problem, what was considered, what was rejected and why, and what was adopted instead.

## Optional lineage fields

Each DR record may declare three optional fields so the what-to-why chain (task ↔ decision ↔ log entry) is traceable by grepping a single id:

- **`Informed by:`** — upstream inputs this decision drew on (e.g. another DR id, an exploration task's output doc, an analyst/architect brief).
- **`Supersedes:`** — the id of a prior DR this one replaces, if any.
- **`Tasks:`** — the `T-NNN` id(s) this DR governs or was produced by.
- **`Session:`** — an opaque Claude Code session id, manually copied at DR-writing time, pointing at the deliberation this record summarizes. Three rules govern it:
  1. **Id only, never content or paths.** Record the bare session id — never transcript content, and never a transcript file path (machine-specific local paths must not enter shipped docs).
  2. **The DR body is the durable provenance; the id must never be load-bearing.** The record's own Problem / What was considered / Why rejected / What was adopted sections must stand on their own as the full, self-sufficient account of the decision. The session id is a convenience pointer, not a dependency — a reader must be able to understand and trust the decision with the id unresolvable.
  3. **Durability caveat.** Claude Code deletes local session transcripts after roughly 30 days by default, so an unqualified session id is provenance that self-destructs. The id stays resolvable only in projects that opted in to the transcript archive at bootstrap (`--transcript-archive`, see `docs/core/BOOTSTRAP_GUIDE.md` — "Transcript archive"), where it resolves to `.mavp/transcripts/<session-id>.jsonl`. In projects without the archive enabled, treat the id as best-effort and likely to go stale.

These fields are metadata only — omit any that don't apply, and add no new required structure. Combined with the `EXECUTION_LOG.md` entry convention (see CLAUDE.md — "Key conventions"), grepping a DR id across this file, `EXECUTION_LOG.md`, and `BACKLOG.md`/`TASK_STATUS.md` surfaces the decision itself, every log entry that acted on it, and every task that cites it. **Graph-rendering or lineage-visualization tooling is explicitly out of scope** — the mechanism is plain grep over existing text artifacts, not a new tool.

---

## DR-001 — Research-first tasks: `exploration` type over a new lifecycle status

**Date:** 2026-05-31

**Informed by:** none (first decision record)

**Tasks:** T-214 (registered this record and the research-first convention it documents)

**Problem:** Tasks whose correct solution is unknown before investigation do not fit the standard lifecycle. The immediate workaround — setting `owner: architect` on a backlog task — is a semantic mismatch because the architect role is a pre-task decomposition step, not an active investigator.

**What was considered:** Adding a new validator-aware lifecycle status (`needs_research` or `spike`) that would sit before `in_progress` and signal that the task requires a research phase.

**Why rejected:**
- A new status adds complexity for every framework adopter, even those who never do pre-investigation work.
- The status would require validator changes, template updates, and documentation across multiple files.
- Two existing mechanisms already cover the need: the `exploration` task type (produces a doc artifact with no deliverable code) and the architect gate (pre-task decomposition and design review).
- Adding a third mechanism would overlap with both without removing either.

**What was adopted instead:** The research-first convention using `exploration` type:
1. Register the investigation as an `exploration` task (`Output doc:`, `Owner role: main_agent`, `Verification type: artifact`).
2. Main agent runs the investigation and writes the findings document.
3. Register a follow-up implementation task that references the findings.

This keeps investigation and implementation as separate, visible backlog items with proper evidence trails, and re-uses existing validator support for `exploration` tasks without adding new lifecycle states.

**Documented in:** `docs/core/TASK_LIFECYCLE.md` — "Task types / exploration" section.

---

## DR-002 — Main Agent may apply publish-manifest registration entries directly

**Date:** 2026-07-14

**Informed by:** `docs/rca/2026-07-publish-manifest-registration.md` (RC-1 and RC-3)

**Tasks:** T-398 (the fix this decision generalizes from), T-399 (this record), T-400, T-401 (follow-up codification tasks)

**Problem:** T-397 created two new git-tracked framework files without classifying them in `scripts/publish-manifest.json`, which was only caught later at publish-assembly time and required a full follow-up task (T-398) to fix. `product-docs` and `technical-writer` are scope-forbidden from editing `scripts/` and (for technical-writer) tool-unequipped to run node — so a "self-register" instruction is unexecutable for them. Something must apply the one-line manifest entry on their behalf without reintroducing the friction of spawning a whole developer task for a single classification line.

**What was considered:** Requiring a dedicated developer task for every manifest registration, mirroring the existing rule that all other `scripts/publish-manifest.json` changes go through a developer task.

**Why rejected:** A full developer-task cycle (architect gate, brief, spawn, review, merge) for a single ship/exclude line is exactly the friction that turned a same-task fix into T-398, a whole separate task. Requiring it for every future registration would recreate the same overhead on every doc-authoring task that creates a new file — disproportionate to the size of the change and a disincentive to comply promptly.

**What was adopted instead:** `scripts/publish-manifest.json` **registration entries** (adding a path to the `ship` or `exclude` list with its classification) are treated as a state-adjacent classification ledger action, the same doctrine already applied to rules-file edits under mechanism (a) in `docs/core/RCA_CODIFICATION.md`. The Main Agent may apply a registration entry directly when a scope-forbidden role emits the `MANIFEST_REGISTRATION_NEEDED: <path> -> <ship|exclude> (<reason>)` token in its final report (see `.claude/rules/docs.md` / `.claude/rules/scripts.md`, filed by T-400). All **other** changes to `scripts/publish-manifest.json` — restructuring, reclassifying existing entries, or any change beyond adding a new registration line — still require a developer task.

**Documented in:** `docs/core/RCA_CODIFICATION.md` (mechanism (a) routing example), `.claude/rules/docs.md`, `.claude/rules/scripts.md` (via T-400).

---

## DR-003 — Canonical self-install is a first-class installer mode

**Date:** 2026-07-15

**Informed by:** the T-405 canonical self-activation incident — the guide's shipped instruction to run a full `--update .` against the framework root clobbered the tracked `scripts/mavp-operator` wrapper and other framework-owned files, because the installer treated the framework's own checkout as an ordinary adopter target.

**Tasks:** T-404 (incident), T-405 (hook-activation docs that shipped the unsafe instruction), T-406 (installer self-install detection + `--hooks-only` mode), T-407 (wrapper flag parity), T-408 (this record; doc correction)

**Problem:** Running the installer against the mavericks framework's own directory is a legitimate, recurring operation (activating Claude Code hooks locally after cloning), but the installer had no way to distinguish "target is a normal adopter project" from "target IS the framework itself." Treating the two identically meant a full `--update` would overwrite the framework's own tracked wrapper, agents, and rules with a copy of themselves — a no-op at best, a downgrade at worst — while the guide's advertised "no repo diff" claim was false as shipped.

**What was considered:** Treat canonical self-install as a normal adopter case and rely on documentation alone to warn operators to use a narrower command by hand.

**Why rejected:** Documentation-only guidance does not prevent the mistake — it already existed and still shipped an incorrect full-`--update` recommendation (T-405). Nothing stopped a future run of the documented command from clobbering the wrapper again; the failure mode is mechanical and should be caught mechanically, not by relying on every future reader to notice the risk.

**What was adopted instead:** The installer detects when the resolved target directory IS the framework's own root (via `fs.realpathSync` comparison, catching symlinked homes) and degrades automatically: `--update` (and a fresh install's wrapper write) skip overwriting `scripts/mavp-operator`, the project-specific script sync, and the `.claude/{agents,skills,rules}` copy — those files are the source in this case, so only the hooks/config-related steps still run (managed hooks merge, settings backfills, the `.mavp-hook-ts` gitignore entry, the pre-commit hook copy). `--hooks-only <dir>` is shipped as the explicit, minimal command for this case and is now the documented recommendation for canonical self-activation (see `docs/core/BOOTSTRAP_GUIDE.md` — "Claude Code hooks activation"). A full `--update .` against the framework root remains safe post-fix (self-install detection skips the framework-file sync automatically) but is no longer the recommended command, since it does more work than hook activation requires.

**Documented in:** `docs/core/BOOTSTRAP_GUIDE.md` ("Claude Code hooks activation" — narrow activation and canonical self-activation step), `scripts/mavp-install.js` header comment ("Self-install detection").

---

## DR-004 — Decision-record `Session:` field as durable-synthesis-plus-pointer, not a bare link

**Date:** 2026-07-19

**Tasks:** T-417, T-422

**Problem:** Decision records capture the outcome of a deliberation (problem / considered / rejected / adopted), but not the deliberation itself — the back-and-forth reasoning that produced it. Adding a pointer from a DR back to the Claude Code session it was written in would let a future reader recover that context. But Claude Code session transcripts are ordinary local `.jsonl` files and are deleted after roughly 30 days by default (`cleanupPeriodDays`), so any provenance mechanism built on session ids has to reckon with that expiry rather than assume the pointer stays valid.

**What was considered:**
1. A bare `Session:` field holding only a chat/session link, with no other change to the DR format or the framework.
2. Auto-stamping the current session id onto a DR via operator tooling at write time, rather than a manually-copied field.
3. Relying entirely on the existing `EXECUTION_LOG.md` and `HANDOFF.md` artifacts for deliberation context instead of adding any session pointer to DRs.
4. Making transcript backup mandatory (on-by-default) so every session's full transcript is always preserved outside Claude's local storage.

**Why rejected:**
1. A bare link decays in ~30 days under Claude Code's default cleanup, so the field would silently become dead provenance in almost every project that didn't separately think to preserve transcripts — the DR would look complete but point at nothing.
2. Reliable auto-stamping requires identifying "the current session" programmatically; the only available signal is filesystem mtime-latest transcript, which is unreliable under parallel sessions (e.g. concurrent worktree agents writing to the same project's transcript directory) and unstable across resume/compaction (a resumed or compacted session can change its file's mtime ordering relative to siblings). A manually-copied id sidesteps this entirely and costs one copy-paste at DR-writing time.
3. `EXECUTION_LOG.md` and `HANDOFF.md` record actions taken and state handed off, not the deliberation that led to a decision — they answer "what happened" and "what's next," not "why did we choose this over the alternatives," which is exactly what a DR's own body already exists to capture. They are complementary, not substitutes for a session pointer.
4. A full transcript is the raw conversation, not just the deliberation that ended up in the DR, and is privacy-sensitive (it can contain anything discussed in-session, not just decision-relevant content). Making backup mandatory and on-by-default would retain that content in every project without an explicit choice to do so, and would also need to be git-tracked or otherwise shipped somewhere to be durable — which conflicts with keeping raw transcripts local-only and gitignored.

**What was adopted instead:** A hybrid design, split across two tasks:
- **T-417 (this record):** the DR body itself is the durable, self-sufficient provenance — Problem / What was considered / Why rejected / What was adopted must stand alone. The optional `Session:` field is a manually-copied, best-effort pointer only, explicitly never load-bearing (see the three rules under "Optional lineage fields" above).
- **T-422 (already merged):** an opt-in, off-by-default `--transcript-archive` installer flag that activates a `SessionStart` hook (`scripts/mavp-transcript-archive.js`) sweeping the current project's transcripts out of Claude's local storage into `.mavp/transcripts/<session-id>.jsonl` before the ~30-day cleanup can remove them. The destination is gitignored — opt-in and local-disk-only, addressing the privacy concern raised against option 4 while still giving projects that want it a path to keep the `Session:` pointer resolvable past the default cleanup window.

Together: the id is cheap to attach and never required for the DR to be understood, while the archive is an independent, deliberately opt-in mechanism for projects that want the pointer to actually resolve later.

**Documented in:** `docs/core/DECISIONS.md` — "Optional lineage fields" (`Session:` field and its three rules), `docs/core/BOOTSTRAP_GUIDE.md` — "Transcript archive".

---

## DR-005 — Deliberately-held tasks: gate-tier correction plus an additive `Hold:` field, not a new lifecycle status

**Date:** 2026-07-25

**Informed by:** `EXECUTION_LOG.md` — "2026-07-25 — Adopter field report (framework 0.38.2) → T-485..T-493" (the adopter's field report and the architect's read-only triage against both the adopter repo and this repo's validator)

**Tasks:** T-486 (this record), T-487 (implementation of the gate-tier correction and any `Hold:` field surfacing)

**Problem:** A real adopter session (hub-model, multi-repo, framework 0.38.2) ended in a state the lifecycle cannot express: code `qa_passed`, deployed to a dev contour, with prod deliberately postponed — not blocked, not forgotten, held on purpose. The operator had no field for this and fell back to encoding it as prose in `Notes`. Worse, the validator penalized the honest encoding: five tasks in that deliberately-held chain produced `blocked_by_open` FAILUREs, latching the validator at exit 2 indefinitely. The architect's triage traced this specifically to the `qa_passed` × open-blocker cell of `BLOCKED_BY_GATE_STATUSES` (`mavp-validator.js:1790-1794`) — distinct from, and previously conflated with, a separate archived-section `commit_unreachable` INFO flood that cannot itself set exit 2. Observed field consequences: the "repair required" bit stopped meaning anything, the pre-commit hook became an obstacle routinely bypassed with `--no-verify`, and every other signal in the session (hook output, the archived-finding flood, a stale `next_action`) got learned-ignored along with it. A permanently-red gate is worse than no gate.

**What was considered:**
1. Correct the `blocked_by_open` gate tier for `qa_passed` — downgrade `qa_passed` × unmerged-blocker from FAILURE to WARNING, leaving `merged` × unmerged-blocker at FAILURE.
2. Add an explicit, optional `Hold:` field to a task, naming what is held, why, and since when.
3. Add a new lifecycle status, `dev_live`, sitting between `qa_passed`/`merged` and a full prod deploy.
4. Extend the existing `deploy_contours` concept to carry per-task exceptions.

**Why rejected (3, 4):**
- **`dev_live` (3):** it would touch every valid-status list, the close-session sweep, active-task counters, sync-status mirroring, and adopter muscle memory — a wide mechanical footprint for one convention. It would also hard-code one specific deploy topology ("dev from a branch, prod on merge") into a framework that already parameterizes deploy shape through `deploy_contours`, and it is the wrong shape for the observed reality: holds are not confined to one status or one topology — the same adopter session had a deliberately-held `deferred` branch as well. A status can only describe *where* a task is; a field can describe *why* it is waiting there, at any status. This mirrors DR-001 ("Research-first tasks: `exploration` type over a new lifecycle status"), which chose a `Type:` field over a new status for the identical structural reason — prefer an additive field over a new lifecycle state when the distinction is orthogonal to position in the lifecycle, not a replacement for it.
- **Extending `deploy_contours` (4):** contours describe a project's deploy topology, which is a project-level constant set once at bootstrap. A hold is a per-task, time-bounded exception. Overloading the topology field with per-task exceptions would make the common case (a project with no holds at all) pay a modeling cost for the rare one.

**What was adopted instead (1, 2):**

- **Accepted (1):** `qa_passed` with an unmerged `Blocked by:` dependency becomes a WARNING-severity finding, not a FAILURE. Rationale: `qa_passed` while your blocker is still unmerged is precisely the state the `Blocked by:` gate exists to hold a task in — the task owner finished their side and is correctly waiting on someone else's. Failing that state at FAILURE severity punishes correct behavior, and that punishment is what burned the exit-2 bit in the field report. `merged` with an unmerged blocker stays FAILURE — that is the actual violation the gate exists to prevent (shipping ahead of an unmet dependency). `ready_for_qa` keeps its existing WARNING tier unchanged.
- **Accepted (2):** an optional, per-task `Hold:` field naming what is held, why, and since when, e.g. `- **Hold:** prod — waiting on a coordinated deploy window (2026-07-24)`. Once implemented, it is intended to be surfaced by `--agent` and `--snapshot` so a held task reads as deliberate rather than stalled.

**Scope limit on what a `Hold:` may downgrade — load-bearing constraint:** a `Hold:` may downgrade only deploy- and blocker-adjacent advisories on that same task (the `blocked_by_open` tier addressed above, and any comparable deploy-pending signal). It must **never** downgrade or silence: `merged_missing_commit_field`, any evidence-completeness check, mirror/sync-status checks, duplicate-entry detection, `config_check`, or `stale_verified`. A hold explains a *wait*; it is not an amnesty for missing evidence. The field-report session is itself the argument for this limit: the evidence-before-merged discipline forced the operator to write out the evidence for one acceptance criterion, and in doing so they caught that their own proof was confounded — it did not actually establish what they were about to claim — preventing a false "confirmed" from being recorded; a hold able to mute evidence checks would have removed the very step that caught the bad proof.

**Cost of the accepted option, stated plainly:**
- It adds one more optional convention for adopters to learn and for the validator to parse.
- A `Hold:` that is never cleared becomes silent debt in the same way a stale `next_action` did in the field report; the existing recheck mechanism (`--arm-recheck` / `--ack-recheck`) is the intended companion for a hold that has a known revisit date, so a hold with a target date should generally be paired with an armed recheck rather than left to be noticed by chance.
- The downgrade scope above must be enforced in the validator's implementation, not merely documented here, or it will erode over time into a general-purpose mute for whatever finding is inconvenient that day.

**Status of this record:** this DR is the decision, not the shipped behavior. The `qa_passed` × unmerged-blocker gate-tier correction and any `Hold:` field parsing or surfacing are T-487's implementation scope and are not yet implemented as of this record.

**Documented in:** `docs/core/DECISIONS.md` (this record); `CLAUDE.md` and `docs/core/TASK_LIFECYCLE.md` are to be updated by T-487 once the gate-tier correction and any `Hold:` field are actually shipped.

---

## DR-006 — Release-train cadence: `edge` working builds plus tagged stable releases, numeric-only version stamps

**Date:** 2026-07-25

**Informed by:** `EXECUTION_LOG.md` — the T-497 release-bookkeeping failure this session (a released `v0.38.2` mirror section was edited locally after publication because release state was read from `PROCESS_STATE` narrative fields rather than from the mirror itself, see T-497/T-498/T-499); the architect's cadence review of the locked Model A sync cadence against the operator's stated need for several working builds per day.

**Tasks:** T-500 (this record), T-501 (working-build publisher — implementation), T-502 (stable promoter — implementation), T-503 (runbook rewrite — implementation), T-497 (the corrective bookkeeping that exposed the release-state-tracking gap motivating this review)

**Problem:** The locked Model A sync cadence (`docs/PUBLIC_RELEASE_STRATEGY.md:5`, `:42` — "do not auto-sync every commit," sync **per release tag**) makes publishing and releasing the same act: there is no way to make a working build publicly available without also cutting a GitHub Release for it. The operator ships several waves a day and wants working builds available continuously, with a Release reserved for verified stable milestones — a distinction the current cadence has no vocabulary for. The gap is not hypothetical: this session's T-497 incident showed that when release state is inferred from narrative fields instead of read from the mirror itself, a released version's own CHANGELOG section can be edited after the fact, exactly the kind of bookkeeping confusion a cadence with a clearer "is this stable or not" answer is meant to prevent.

**What was considered:**
1. Give the public mirror a long-lived `edge` branch that receives every working-build publish (each passing the full assemble + secret-scan gate), with `main` promoted to the `edge` tip only at a verified stable milestone (tag `v<version>` + GitHub Release).
2. Mark working-build versions with a pre-release suffix in `MAVERICKS_VERSION` (e.g. `0.39.0-rc.1`) so a stamped version self-declares "not yet stable."
3. Let stable-tier adopters pin to a release tag (`v<version>`) instead of tracking a branch, on the reasoning that a tag is a more precise, immutable reference than a moving branch tip.
4. Cut a GitHub Release, marked `--prerelease`, for every working-build publish rather than reserving Releases for stable milestones only.

**Why rejected (2, 3, 4):**
- **Pre-release suffixes (2):** verified as unsafe by inspection of the two comparators that would have to read them. `semverCompare` (`scripts/mavp-operator-agent.js:394-399`) splits a version on `.` and coerces each part with `Number(...) || 0`; for `0.39.0-rc.1`, the third part is `Number("0-rc")` → `NaN` → coerced to `0`, and the loop only compares indices 0–2, so a stamped `0.39.0-rc.1` compares **exactly equal** to the final `0.39.0` — a project stamped with an rc would never see the update notice for the actual stable release. Independently, `compareSemver` (`scripts/mavp-install.js:913-931`) treats any non-numeric part as unparseable and returns `null`; that `null` propagates into `detectStaleSourceGuard` (`:979-980`, `cmp === null` → return `null`), silently disabling the stale-source guard rather than erroring. Both failures are silent — no crash, no warning — which is worse than an unsupported feature: a suffix would look like it works right up until the moment it quietly stops protecting anything. The decision is to make suffixes unnecessary rather than to fix the comparators: every working build already gets a unique, honest `x.y.z` from the existing per-wave version-bump convention (CLAUDE.md — "Version bump"), so there is nothing a suffix would add that the numeric stamp doesn't already provide.
- **Tag-pinning for stable adopters (3):** the T-477 behind-upstream guard (`detectBehindUpstreamGuard`, `scripts/mavp-install.js:1026-1041`) resolves the *current branch's* configured upstream via `git rev-parse --abbrev-ref @{upstream}` and treats any failure — including a detached `HEAD`, which is what checking out a tag produces — as a silent no-op (`:1029-1030`, `:1039-1041`: caught and returns `null`, no error surfaced). Pinning stable adopters to a tag would put every one of them in the exact state this guard cannot see, disabling the mechanism that protects them from syncing a stale framework. A branch (`main`) always has a resolvable upstream; a checked-out tag does not.
- **Per-build prerelease Releases (4):** the operator's ask was for builds that are simply *working* and continuously available, not for a Release object per build. A GitHub Release, even `--prerelease`-flagged, still appears in the repo's Releases list — publishing one per working build (several times a day) would recreate the noise the operator is trying to get away from and would erode the meaning of "this is a Release" for the stable milestones that actually deserve the label.

**What was adopted instead (1):**
- **A release train.** The public mirror gains a long-lived `edge` branch that receives every working-build publish, each passing the full assemble + secret-scan gate (the same gate the current model already requires, unchanged). `main` fast-forwards to the `edge` tip only at a verified stable milestone, where it gets a tag `v<version>` and a GitHub Release. Intermediate builds get no tag and no Release — "which versions are stable" is answered by `git tag`, not by inference.
- **Version stamps stay purely numeric; pre-release suffixes are forbidden in `MAVERICKS_VERSION`.** This is the load-bearing, counter-intuitive part of the record (see the comparator evidence above) — it must be enforced as a convention, not "improved" later by reintroducing suffixes, without first fixing both comparators.
- **Adopters choose their tier by branch, not by tag.** Stable is the default and is byte-identical to today's adopter-facing behavior: the resolved framework clone stays on `main`, so it moves only at stable releases and the update notice fires once per release. Bleeding edge is opt-in: track `origin/edge` instead of `main`.
- **Release body = the concatenation of all CHANGELOG sections since the previous stable tag.** A stable release now covers several intermediate working-build versions, so a single-section release body (today's rule, `docs/PUBLIC_RELEASE_STRATEGY.md` §5) would silently drop the intermediate ones. This amends §5's derived-copy rule; §5 itself is rewritten by T-503, not by this record.

**Consequences, stated plainly, not buried:**
- Working builds reach the public tree the same day they merge. This makes the secret-scan gate the **only** barrier between private `main` and the public tree for every one of those builds, several times a day — it must be embedded in tooling (T-501) rather than left as a checklist step a human can skip under time pressure.
- `edge`-tier adopters will hit behind-upstream aborts (T-477's guard) far more often than `main`-tier adopters, since `edge` moves multiple times a day. This is the accepted price of choosing that tier, not a defect to fix.
- `main` must remain an ancestor of `edge` at all times: promotion is fast-forward-only, and **neither branch may ever be force-pushed** — a force-push to either breaks `git pull` for every adopter clone tracking it.
- The private canonical repo stays tag-free, as today. A second tag namespace on the private repo (alongside the mirror's) would drift from the mirror's tags and answer "is this stable" two different ways from two different places.

**Implementation is out of scope for this record.** The `edge` branch, the working-build publisher, and the stable promoter do not exist yet — they are T-501 (one-command working-build publisher) and T-502 (stable-release promoter script). The runbook itself (`docs/PUBLIC_RELEASE_STRATEGY.md` §3 and §5) is rewritten by T-503 once T-500–T-502 land; until then, §3 and §5 still describe the superseded per-tag-only cadence and should be read as amended by this record, not yet as rewritten text.

**Documented in:** `docs/core/DECISIONS.md` (this record). `docs/PUBLIC_RELEASE_STRATEGY.md` §3 and §5 are rewritten by T-503; `scripts/mavp-publish-build.js` (T-501) and `scripts/mavp-publish-release.js` (T-502) are the implementation.

---

## DR-007 — Developer briefs must never forbid manifest self-registration; the token is scope-forbidden roles only

**Date:** 2026-07-26

**Informed by:** three occurrences within a single wave 70 parallel dispatch batch (T-528, T-530, T-531) where a sub-agent brief generalized DR-002's routing to developer tasks, and the sub-agent reports from that batch.

**Tasks:** T-528, T-530, T-531 (the three occurrences this record resolves), T-535 (this record and the doctrine fix)

**Problem:** Sub-agent briefs told developers not to edit `scripts/publish-manifest.json` directly and to emit the `MANIFEST_REGISTRATION_NEEDED: <path> -> <ship|exclude> (<reason>)` token instead, so the Main Agent would apply the entry at integration — reasoning from DR-002's stated rationale (avoiding N-way conflicts when several tasks touching the manifest run in parallel). But `.claude/hooks/pre-commit` runs `node scripts/check-publish-manifest.js --if-canonical` as a blocking commit-time backstop, and the checker fails closed on any staged new file that is not yet classified. A developer who creates any new tracked file under that brief instruction cannot produce a commit at all — there is no token-deferred path to a commit, because the backstop blocks before the Main Agent ever gets to apply anything. Skipping hooks with `--no-verify` is forbidden without explicit human consent, so there was no compliant path under the instruction as given. This surfaced three times in one parallel dispatch batch, each a distinct shape of the same contradiction: **T-528**, dispatched under the unfixed instruction, hit `COMMIT BLOCKED: unclassified file(s)` from the pre-commit backstop and could produce no commit at all under its brief; having ruled out skipping hooks, its developer registered the single `ship` line itself, explicitly reported the deviation, and flagged the conflict risk against the other parallel tasks touching the same manifest — the sanctioned deviation, and the report that surfaced the contradiction in the first place. **T-530** avoided the block entirely by creating no new file — its own evidence states plainly: "the brief forbade editing the publish manifest while the pre-commit backstop blocks any commit containing an unregistered new file. That contradiction is real... this task's workaround (no new file, so nothing to register) is legitimate but it is a workaround." **T-531** also created a new test file and self-registered it, reporting that its registration and a sibling parallel task's landed with no conflict between them — but by the time T-531 ran, the Main Agent had already corrected the brief mid-flight on the strength of T-528's report, so T-531's self-registration was compliant with a corrected brief, not an independent deviation; it is the evidence that the fix works once briefs stop forbidding the line.

**Which part of DR-002 stands, and which reading of it was wrong:** DR-002 itself is not superseded and its own text never mentioned developers — it holds, unchanged, that the Main Agent may apply a publish-manifest **registration entry** directly on behalf of a role whose scope forbids `scripts/` (`product-docs`, `technical-writer`), triggered by that role emitting the `MANIFEST_REGISTRATION_NEEDED` token in its final report. That mechanism exists because those roles are tool-unequipped or scope-forbidden from running `node` against `scripts/` at all — the token is not optional routing for them, it is the only path available. The error was never in DR-002's own text; it was in later brief composition that generalized DR-002's parallel-conflict *rationale* into an instruction for developers, a role that already has a working, audited, self-registration path (`.claude/rules/scripts.md`'s pre-existing rule: developers editing the manifest run the checker and quote its output) and full `scripts/` tool access. Applying a rule designed for tool-unequipped roles to a role that needs no such accommodation reopened exactly the contradiction this record closes.

**What was considered and rejected:**
1. **An additive-only exemption in `check-publish-manifest.js` or the pre-commit backstop** (e.g. permit an unclassified new file through as a warning rather than a blocking failure) — rejected because it reopens the exact hole the checker was built to close (see T-397/T-398, the incident DR-002 itself generalized from: an unclassified new framework file shipped unnoticed until publish-assembly time). The checker's fail-closed behavior and the backstop's blocking behavior are both explicitly reaffirmed unchanged by this record — no exemption is added, additive or otherwise.
2. **Route developer registrations through the Main-Agent-applies-at-integration pattern, the same as scope-forbidden roles** — rejected because it leaves the developer's own worktree uncommittable in the interim: the pre-commit backstop runs in the worktree at commit time, before any integration step exists for the Main Agent to apply anything into. The token pattern only works for roles that never touch `scripts/` and whose commits therefore never trip the backstop in the first place; a developer's commits always run through it.
3. **Skip the pre-commit hook (`--no-verify`) for manifest-blocked developer commits** — rejected outright: skipping hooks without explicit human consent is forbidden (see CLAUDE.md's Git Safety Protocol), and the block being inconvenient is not consent.

**What was adopted instead:**
- The `MANIFEST_REGISTRATION_NEEDED` token remains exclusively for roles whose scope forbids `scripts/` (`product-docs`, `technical-writer` today; any future role with the same scope restriction). It is never a routing option for developers.
- Developers always self-register new tracked files in `scripts/publish-manifest.json` in the same commit that creates them, running `node scripts/check-publish-manifest.js` and quoting its output in evidence — this was already the rule in `.claude/rules/scripts.md`; this record makes explicit that no brief may override it, since the pre-commit backstop makes self-registration mandatory rather than a style preference.
- The pre-commit backstop and the checker's fail-closed behavior are unchanged and reaffirmed: no exemption, additive or otherwise, is introduced by this record.
- **Parallel-conflict protocol, preserving DR-002's original constraint where it actually bites:** DR-002's underlying concern — several tasks touching `scripts/publish-manifest.json` at once — is real and is not reintroduced by removing the token from developer briefs; it is handled as a merge-time protocol instead of a brief-time prohibition. When a `publish-manifest.json` cherry-pick conflict arises between two developer tasks' additive registration entries, the Main Agent unions both entries (both blocks classify as `ship` or `exclude` for their respective, disjoint paths — a union is always well-formed for additive entries) and re-runs `node scripts/check-publish-manifest.js`, quoting its output before booking `dev_done` on either task. This is the same class of resolution this repo already uses for parallel-task `CHANGELOG.md` collisions (keep both entries rather than choosing one).

**Anti-instruction, for whoever writes a developer brief:** a developer brief must never forbid the manifest self-registration line when the task creates a new tracked file, and must never route a developer's registration through the `MANIFEST_REGISTRATION_NEEDED` token — that token names a completely different constraint (a role that cannot touch `scripts/` at all), not a parallel-dispatch precaution. See `CLAUDE.md`'s "Publish-manifest registration" convention and `.claude/rules/docs.md` / `.claude/rules/scripts.md` for the codified instruction.

**Documented in:** `docs/core/DECISIONS.md` (this record); `CLAUDE.md`'s "Publish-manifest registration" convention; `.claude/rules/docs.md`; `.claude/rules/scripts.md`.
