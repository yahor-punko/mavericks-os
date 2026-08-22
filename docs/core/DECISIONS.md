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

---

## DR-008 — Gate lifecycle: every blocking gate records origin, preconditions, and every real fire; zero-fire gates get a review at stable promotion

**Date:** 2026-08-13

**Informed by:** the gate-accumulation audit (architect, 2026-08-06) — `git log --diff-filter=D` over `scripts/check-*`, `scripts/mavp-*guard*`, `scripts/mavp-publish-*` returns nothing, and 2,193 `CHANGELOG.md` lines contain zero "Removed" sections; "has this gate ever fired on something real" was unanswerable from any single artifact and had to be reconstructed across four files for the audit.

**Tasks:** T-643 (this record and the seed ledger)

**Problem:** Adding a blocking gate costs one review; removing one costs an incident (someone has to prove nothing depends on it). That asymmetry guarantees monotone gate growth regardless of merit, independent of whether any individual gate is still earning its keep. The audit additionally surfaced a second, compounding failure already named three times in this repo's own history (T-540, T-565, DR-005): a check that reddens on the routine direction — flagging its own component's ordinary operation as a violation — trains its operator to stop reading it. Without a place to record, at birth, what a gate assumes about its environment, that discovery keeps happening by incident instead of by design.

**What was considered:**
1. A periodic manual gate-inventory audit, run ad hoc whenever gate count "feels" too high, with no fixed cadence or recorded criteria.
2. Adding a runtime instrumentation layer that counts and logs every gate invocation and outcome automatically, then reviewing the counts.
3. The adopted design: a birth-time ledger entry per gate (origin incident, environmental preconditions, fire history) reviewed at a fixed, already-existing cadence (stable promotion), with an explicit real-fire/self-inflicted-fire distinction.

**Why rejected (1, 2):**
- **Ad hoc audits (1):** this is exactly what produced the current gap — the fire-history inventory that seeded this ledger exists only because one audit happened to reconstruct it by hand across four files, on 2026-08-06, with no guarantee the next one happens before the next round of monotone growth. An audit with no fixed trigger is a audit that doesn't happen until the pain is already large.
- **Runtime instrumentation (2):** this repo's own gates already run across several independent surfaces — pre-commit hooks, PostToolUse hooks, publish-time scripts, and canonical/mirror CI — with no shared logging substrate between them. Building and maintaining one is itself new infrastructure with its own bugs and its own maintenance cost, for a question (has this gate ever caught something real) that a human reviewer can answer more cheaply and more reliably by reading commit history and incident records at a fixed checkpoint. It would also conflate "the gate ran" with "the gate caught something real" — the audit's own finding is that this distinction is the load-bearing one, and a naive invocation counter cannot make it (see "Real fire" below).

**What was adopted instead:**

Every blocking gate records, at birth, its **origin incident** and its **environmental preconditions**, plus **every real fire**, in `docs/core/GATE_LEDGER.md`. At each stable promotion (`scripts/mavp-publish-release.js`, §3b), any blocking gate with **zero real fires since the previous stable release** gets an explicit demote/merge/retire review, with the outcome recorded in the ledger. This does not mean automatic retirement — the review can conclude "keep, no fire yet expected" — but the review itself, and its outcome, must happen and must be recorded; silent, uninspected zero-fire persistence is what this decision closes off.

Two definitions this decision pins down, because the mechanism is unenforceable without them:

- **"Real fire"** means a catch on a genuine condition arising from ordinary work. A finding produced by a review deliberately attacking the gate to test it does **not** count as a real fire, and neither does a fire caused by the gate's own bug (a false positive is not evidence the gate is earning its keep — it is evidence the gate needs a fix). The audit found this distinction load-bearing in practice: one entire gate family's every recorded finding was a review-planted attack on itself, which would have looked like a healthy fire history under a naive count.
- **"Environmental precondition"** means an invariant about the environment a gate asserts, which another component's *normal operation* may legitimately violate — e.g. "assumes a clean working tree," "assumes full git history," "assumes `main` exists," "assumes an identity is configured." Recording these at birth is what turns "this gate reddened on someone else's routine operation" from a discovery made under incident pressure into a predictable, already-documented outcome.

**Scope limit, stated plainly:** this decision introduces **no runtime check, no hook, and no validator change**. It is a documentation and review-cadence decision only — the ledger is a human-maintained record, reviewed at an existing checkpoint (stable promotion) that already requires human attention. No mechanical enforcement is proposed by this record; if one is ever wanted, it is a separate task with its own review.

**Documented in:** `docs/core/DECISIONS.md` (this record); `docs/core/GATE_LEDGER.md` (the ledger itself, seeded from the 2026-08-06 audit inventory); `docs/PUBLIC_RELEASE_STRATEGY.md` §3b, "Gate-ledger review (DR-008)" (the stable-promotion checkpoint where the zero-fire review happens, shipped by T-646).

## DR-009 — Info severity is not an acceptable terminal tier for a rule the operator channel can violate silently

**Date:** 2026-08-14

**Informed by:** `docs/rca/2026-08-operator-channel-state-artifacts.md` — RC-1 ("A detection-only enforcement tier does not stop an operator write, demonstrated three times") and RC-4 ("Truncating a command's output makes the artifact unfit to verify from, in either direction").

**Tasks:** T-628 (this record and the escalation it governs)

**Problem:** RC-1 documents three identical writes of a banned `next_action` shape — `T-610`, `T-619`, and `T-631` — landing after `classifyNextAction()` shipped, after the validator's `next_action_volatile_facts` finding was live, and after `--agent` surfaced it. All three commits happened anyway, because the finding was info severity: printed, never blocking. The third instance is decisive — it was committed *while registering the very task whose purpose is escalating this finding to blocking*, with the architect's ruling already in hand. RC-4 independently shows the same shape one layer down: a truncated command output (`tail -N`, a cut identity line) leaves an artifact that cannot be verified from in either direction — not "the check didn't run," but "no one can now tell whether it did." Both root causes share one property: the operator is the actor the rule constrains, the operator is also the one deciding whether to heed an advisory, and an advisory has no mechanism to stop a write the operator has already decided to make.

**What was considered:**
1. Leave `next_action_volatile_facts` (and comparable operator-channel rules) at info severity indefinitely, relying on the operator to read and heed the advisory each time.
2. Escalate every existing info-severity operator-channel advisory to blocking in one sweep, regardless of whether its matcher is precise enough to survive the escalation.
3. The adopted ruling: info severity is never an acceptable *terminal* tier for a rule that governs the operator's own writes to a state artifact the operator itself controls — such a rule must eventually reach a blocking tier (validator exit 2, or an equivalent hard stop) — but escalation is only sound once the underlying matcher is proven not to reject legitimate output, per RC-1's own finding that naively escalating the unnarrowed `next_action` matcher would have rejected all three historical strings' legitimate replacements too.

**Why rejected (1, 2):**
- **Indefinite info severity (1):** this is the status quo RC-1 measures directly — three demonstrated failures, the last one committed with the ruling already in hand. An advisory that the same actor can read, understand, and override in the same breath is not an enforcement tier; it is a comment. Continuing to rely on it after a third documented failure has no remaining justification.
- **Sweep escalation without matcher review (2):** RC-1's own finding is that the `next_action` matcher as shipped would flag a version literal regardless of whether it names the *target* of an action ("bump to 0.43.0") or asserts *current state* ("we are at 0.43.0") — only the latter is the actual violation. Escalating severity before narrowing the matcher would make the artifact worse while claiming to protect it, rejecting legitimate routing directives alongside the real violations. A blanket sweep across every operator-channel advisory would repeat this mistake at scale, wherever a matcher hasn't yet been proven precise.

**What was adopted instead:**

Info severity is a valid *interim* tier for an operator-channel rule — useful while a matcher is still being sharpened, as `next_action_volatile_facts` was between its introduction and RC-1's finding — but it is never an acceptable *terminal* tier once the rule and its matcher are settled. The escalation path is: (a) prove the matcher does not reject legitimate output (narrow it to the specific violating shape, not the broad one), then (b) raise the finding to blocking severity so the write itself fails rather than merely being logged. T-628 ships both halves together for `next_action_volatile_facts` — narrowing `classifyNextAction()` to volatile-fact *position* and escalating `next_action_volatile_facts` from `info` to `failure` in `scripts/mavp-validator.js` — precisely so the blocking tier never exists on top of the wrong boundary. This ruling is general: it applies to any future rule constraining what the operator channel writes into `BACKLOG.md`, `TASK_STATUS.md`, or `PROCESS_STATE.json`, not only this one instance.

**Scope limit, stated plainly:** this decision does not mandate blocking severity for every validator finding — most findings concern sub-agent output, which already carries `needs_fix_rounds:`/`validator_blocked:` evidence and passes through a human/QA review gate before merge, so info/warning tiers remain appropriate there. This ruling is scoped specifically to rules that govern **the operator's own direct writes to state artifacts**, where no downstream review gate exists to catch a silently-ignored advisory before it lands.

**Documented in:** `docs/core/DECISIONS.md` (this record); `docs/rca/2026-08-operator-channel-state-artifacts.md` (RC-1, RC-4, and the RC-1 routing section that names this record's carrier); `scripts/mavp-validator.js` and `scripts/mavp-operator-lib.js` (the shipped `next_action_volatile_facts` narrowing + escalation this ruling governs, T-628).

## DR-010 — Permission posture is declare, detect, report — never resolve, probe, or write beyond the framework's own project files

**Date:** 2026-08-15

**Informed by:** the 2026-08 three-week `dontAsk` divergence incident (a user-global `~/.claude/settings.json` `defaultMode` decided sessions while the committed project file declared `bypassPermissions` — the layer both `SECURITY.md` and `docs/core/BOOTSTRAP_GUIDE.md` ranked weakest won, with no local override in play); DR-009 (a signal the operator relies on must not be able to be confidently wrong).

**Tasks:** T-663 (permission-posture reporting — effective-vs-declared split with provenance; shipped the `permission_mode` / `permission_mode_source` / `permission_mode_verified` fields this record governs), T-664 (this record and the docs it corrects)

**Problem:** SECURITY.md and docs/core/BOOTSTRAP_GUIDE.md asserted a Claude Code settings-precedence order as established fact, and CLAUDE.md's session-start note called the reported `permission_mode` the "active" mode. Neither claim survived observation: for roughly three weeks a user-global `dontAsk` decided sessions over the committed project `bypassPermissions`, with no local override present — the precedence order's own weakest-ranked layer won. The framework cannot explain why: a harness precedence change, a harness rule refusing `bypassPermissions` from a committed repo-controlled file, and residual session state all fit the evidence equally, and none is verifiable from this repo's artifacts.

**What was considered:**
1. Retire the `permission_mode` field and its advisory entirely, since it was demonstrably wrong for three weeks and cannot be trusted.
2. Re-implement precedence resolution in framework code so `--agent` computes and asserts a definitive winning mode itself, replacing reliance on Claude Code's documented order.
3. The adopted ruling: keep the field, but restrict its contract to declare, detect, report — never resolve a winner, never probe for one, never write beyond the framework's own project files — and always label a declared value as declared, never active.

**Why rejected (1, 2):**
- **Retire the field (1):** fails the operator's own requirement for prompt-free operation. Session start is the only pre-work point at which a silently-degraded session can be caught before any tool call executes, and the failure mode this field exists to catch is exactly the one where retiring it would hurt most: under a genuinely denying mode, even the instrument that would ask the question is itself denied by that same mode, so the field's absence is felt precisely when it is most needed. Removing a cheap, already-shipped detection signal because one reading of it was wrong trades a false claim for a missing one — not an improvement, and the same shape DR-009 already rejected: an advisory being imperfect is not grounds for having no advisory at all.
- **Re-implement precedence to name a winner (2):** a winner the framework computed and asserted could itself be confidently wrong, for the same unverifiable, harness-owned reasons the current divergence is unverifiable — recreating the exact DR-009 violation (a signal the operator relies on being confidently wrong) one level up, only now wearing the authority of "the framework says so" instead of "Claude Code's docs say so." Computing a resolution the framework cannot verify against reality is not more honest than reporting a declared value as declared; it is the same defect with a different narrator.

**What was adopted instead:**

Permission posture is declare, detect, report — never resolve, probe, or write beyond the framework's own project files. Concretely: (a) `~/.claude/settings.json` (user-global) is never written by any framework script — the framework reads its own project-controlled files (`.claude/settings.json`, `.claude/settings.local.json`) and, where the harness provides one, a same-session hook payload, but does not inspect, infer, or modify anything outside those; (b) effective (actually-in-force) mode is asserted only from a same-session harness channel — `permission_mode_verified: true` requires a live hook payload observed in the current session, and is `false` on any harness whose payload doesn't carry the field, which is a designed-for outcome, not a defect to be worked around; (c) every declared value — one read from a settings file rather than confirmed by a harness payload — is always labeled `declared`, never `active`, in both the field semantics and any doc describing them; (d) the settings-precedence order itself is documented as a sourced, harness-owned claim ("as documented at time of writing," with the known 2026-08 counter-observation named alongside it), not an asserted guarantee — a reader is pointed at the session-start `permission_mode` line to verify, not asked to trust the order.

**Scope limit, stated plainly:** this ruling does not resolve, or attempt to resolve, why the 2026-08 divergence happened — that question is left open and harness-owned on purpose, per the mechanism-agnostic requirement carried into `SECURITY.md` and `docs/core/BOOTSTRAP_GUIDE.md`'s rewritten passages. It also does not add any new probing behavior (e.g. shelling out to inspect `~/.claude/settings.json`'s live value) — the framework's read surface stays exactly what it was before this incident; only the *labeling* of what that surface can and cannot claim changes.

**Documented in:** `docs/core/DECISIONS.md` (this record); `SECURITY.md` ("How to opt out" — precedence demoted to a sourced claim); `docs/core/BOOTSTRAP_GUIDE.md` ("Shared permission-mode default" — same demotion in its own voice); `CLAUDE.md` (session-start note documents declared/verified semantics and field names; VSCode Agent permissions convention rescoped to a conditional diagnostic).

## DR-011 — Dated is not released: a CHANGELOG section accumulates until its exact version is tagged, never on a bump-ahead schedule

**Date:** 2026-08-15

**Informed by:** T-628 (the concrete instance this ruling adjudicates); DR-009 (a rule the operator channel can silently violate must not stay advisory-only — the same shape recurs here one layer down, in what content a release-time gate can see at all).

**Tasks:** T-662 (this record and the fold it governs), T-568, T-666

**Problem:** T-628 merged into a freshly opened `## [0.44.3]` CHANGELOG section while `scripts/mavp-version.js` and `package.json` both still read `0.44.2` — an unreleased version bump was never made, so no code in the tree actually became "0.44.3." `mavp-publish-release.js` derives the tag it cuts from the edge tip's `mavp-version.js`, and `extractReleaseSections`' numeric upper bound silently *excludes* any section whose version compares greater than the version being tagged. Concretely: a release run against that shape would have tagged `v0.44.2`, and T-628 — an adopter-visible change that turns a previously advisory check into one that blocks commits — would have shipped inside that tag's tree with zero mention in its own release notes, every gate green. The section header looked tidy and forward-dated; the actual risk was live and unnoticed.

**What was considered:**
1. Leave the `## [0.44.3]` section in place and treat it as the normal home for new entries until the next deliberate version bump — i.e. let a CHANGELOG heading run ahead of the version files it's supposed to describe.
2. Bump `scripts/mavp-version.js` and `package.json` to `0.44.3` immediately, so the heading and the version files agree.
3. The adopted ruling: fold the `0.44.3` section's body back into `0.44.2` — the section that matches the version files' actual current value — and let `0.44.2` keep accumulating until a deliberate bump opens the next section.

**Why rejected (1, 2):**
- **Leave the ahead-of-version heading in place (1):** this is the status quo that produced the defect. `extractReleaseSections`' numeric exclusion means any section dated or numbered ahead of the tree's real current version is invisible to a release cut today — not merely untidy, armed. The gap between "a section exists" and "a section's version is what actually gets tagged" is exactly the gap T-628 fell into.
- **Bump now to match the heading (2):** this manufactures a second consecutive never-tagged version. Under this project's own frozen-section rule, an untagged section stays editable forever, including inside whatever later tag's body eventually absorbs it — the same open residual already on record for a prior premature-bump instance (T-604). It also contradicts the framework's own close-session advisory, which recommends no bump while the current version remains unreleased, and it breaks with repo precedent: two prior tasks were folded into a still-unreleased `0.38.2` section rather than triggering a bump (`EXECUTION_LOG.md:285`).

**What was adopted instead:**

Dated is not released. A CHANGELOG section is released if and only if its exact version tag exists on the public mirror — verified with a real `git fetch --tags` against the mirror clone, never a stale local read. `scripts/mavp-version.js` and `package.json` are the sole authority for what the tree's current version actually is. An unreleased current version's section accumulates every merged task's entries — however many arrive — until the version is deliberately bumped as its own act. A new version section may open only with, or strictly after, that deliberate bump; a section heading must never run ahead of the version files it describes. T-628's body (the `### Changed` sub-heading and its bullet) is relocated into `0.44.2`'s existing body, placed between `### Added` and `### Fixed` per Keep-a-Changelog category order, and the `0.44.3` heading is deleted.

**Scope limit, stated plainly:** this ruling governs CHANGELOG section-opening discipline only — it does not change the frozen-section rule (`docs/PUBLIC_RELEASE_STRATEGY.md` §5), which still governs sections whose version *is* already tagged, and it does not itself add a mechanical gate. T-568 and T-666 are the paired follow-ups that close this class mechanically — at release time (refusing a non-empty future-versioned section before any tag mutation) and at write time respectively — neither of which this record substitutes for.

**Documented in:** `docs/core/DECISIONS.md` (this record); `CHANGELOG.md` (the folded `0.44.2` section this ruling produced); `docs/PUBLIC_RELEASE_STRATEGY.md` §5 (the adjacent frozen-section rule); `EXECUTION_LOG.md:285` (the `0.38.2` fold precedent cited above).

## DR-012 — The ubuntu × mirror-tree verification cell gets a `push`-event trigger on every working build, and a mechanical gate blocks promotion when it isn't green

**Date:** 2026-08-21

**Informed by:** the 0.39.0 and 0.40.0 incidents (`docs/PUBLIC_RELEASE_STRATEGY.md` §3a) — the mirror's own CI caught both, but only ever after the push to mirror `main`; the 2026-08-21 `cfe574b` near-miss (`EXECUTION_LOG.md:857-858`, `:892`, `:895`) — a failing test would have reached `edge` and gone red on the mirror had SSH to GitHub not happened to be down that session, reproducing the same failure mode by accident rather than by any gate catching it; DR-008 (`docs/core/GATE_LEDGER.md`'s gate-lifecycle discipline, which this decision's new gate is registered under) and DR-009 (a rule the operator can silently miss must not stay advisory-only — the same shape recurs here for a promotion-time human step).

**Tasks:** T-680 (the gate, `scripts/mavp-publish-release.js`'s `checkMirrorCiGate`/`evaluateMirrorCiGate`; the `edge` trigger, `.github/workflows/ci.yml`), T-681 (this record and the docs it governs)

**Problem:** Four verification cells exist for this project's shipped code — local suite × canonical tree, canonical CI × canonical tree, the assembled-suite receipt × mirror tree, and CI × mirror tree — and `docs/PUBLIC_RELEASE_STRATEGY.md:79` documents why none of the first three subsumes the fourth: each certifies a different axis (tree shape, or OS/toolchain), never both at once. The fourth cell, ubuntu × mirror-tree, existed only as whatever the next push to mirror `main` happened to reveal — `workflow_dispatch` cannot manufacture a push-event run of it, because it routes exclusively to the macOS-only job (`.github/workflows/ci.yml:110` gates on `schedule`/`workflow_dispatch`; the ubuntu matrix job at `:68` gates on `push`/`pull_request` only, and the two are mutually exclusive by design, T-563's cost policy). That gap is exactly what let 0.39.0 and 0.40.0 ship broken with every other gate green, caught only after the fact. The gap survived one more near-miss on 2026-08-21: `cfe574b` carried a failing test into the canonical remote while the full suite was still running; the mirror publish that would have carried it on to `edge` could not run only because SSH was unreachable all session, not because any gate stopped it.

**What was considered:**
1. **Promotion-time-only checking** — query the mirror's CI for the `edge` tip at promotion time, but rely on the existing `workflow_dispatch` trigger (or a manually-triggered run) to produce something to check, rather than adding a new `push` trigger.
2. **An `edge` push trigger with no mechanical promotion gate** — add `edge` to `ci.yml`'s `push.branches` so a run exists, but rely on a documented pre-promotion step (read the mirror's CI status, decide by hand) rather than a hard gate in `mavp-publish-release.js`.
3. **No change** — leave the fourth cell exactly as it was, on the theory that the receipt gate (0.5) and the other three cells already cover the risk well enough in practice.
4. **The adopted design:** both halves together — an `edge` push trigger (`add783b`) so the mirror's own ubuntu matrix runs on every working build, *and* a mechanical hard gate in the stable-promotion script (`3c0a683`, hardened `d3f35df`) that refuses to promote unless the exact `edge`-tip SHA has a completed, successful run of that trigger on the mirror.

**Why rejected (1, 2, 3):**
- **Promotion-time-only checking (1):** mechanically unavailable, not merely a weaker option. `workflow_dispatch` reaches only the macOS-only job (`.github/workflows/ci.yml:110`); the ubuntu Node 20/22/24 matrix job that is the actual ubuntu × mirror-tree cell gates on `push`/`pull_request` only (`:68`) and never runs on a dispatched invocation. Querying the mirror's CI at promotion time with no `push` trigger on `edge` would either find nothing to check (the `no_run` outcome this gate already has to handle for the pre-first-activation case) or find only macOS evidence — the exact axis the 0.43.0 incident (`docs/PUBLIC_RELEASE_STRATEGY.md` §3a) already proved insufficient on its own.
- **`edge` trigger with no mechanical gate (2):** prose gates are demonstrably missable in this exact ritual. `docs/PUBLIC_RELEASE_STRATEGY.md` §3b's DR-008 gate-ledger review is a documented, printed pre-promotion step, and it was skipped on the very first promotion after it shipped — the 0.44.2 promotion (`EXECUTION_LOG.md:800`, `:805`; recorded post-hoc and reconstructed a week later by T-667). A trigger with no mechanical enforcement behind it would ask an operator to remember to check a webpage before every promotion, at the exact moment history shows that class of step gets skipped.
- **No change (3):** refuted directly by the `cfe574b` near-miss. The receipt gate and the other three cells were all exactly as green at that moment as they were during 0.39.0 and 0.40.0's own shipping — the only thing that prevented a third occurrence of the identical failure mode was an unrelated network outage, not any property of the existing gates. A risk whose only mitigation is an accident of infrastructure availability is not mitigated.

**What was adopted instead:**

`edge` is added to `.github/workflows/ci.yml`'s `push.branches` (`add783b`) so every `mavp-publish-build.js` push to the mirror triggers the ubuntu Node 20/22/24 matrix against the mirror-shaped tree — inert on the canonical (private) repo, where no `edge` branch exists, and costing no new CI minutes on the mirror beyond what the working-build cadence already generates. `scripts/mavp-publish-release.js` then hard-gates stable promotion (§3b's new step 6b) on that exact `edge`-tip SHA having a `completed`/`success` run of it, queried read-only via the GitHub Actions REST API (`checkMirrorCiGate`/`fetchMirrorCiRuns`/`evaluateMirrorCiGate`, `3c0a683`). The gate fails closed on every non-pass outcome — red, in-progress, queued, no run found, or an API/network error — and stands down with no network call at all only when the clone's remote does not parse as a github.com remote (`parseGithubRemote`), which is a property of the remote's own shape, never an operator-reachable flag. Two low-severity hardening fixes closed a security review before merge (`d3f35df`): the gate re-verifies the selected run's own `head_sha` locally rather than trusting the API's `?head_sha=` query filter, and caps the response body at 1MB. The gate is registered in `docs/core/GATE_LEDGER.md` per DR-008, citing both 0.39.0/0.40.0 and the `cfe574b` near-miss as origin incidents.

**Scope limit, stated plainly:** this decision does not add a gate to `mavp-publish-build.js` (the §3a working-build ritual) itself — the new hard gate sits only at stable promotion (§3b), which is where a red mirror-tree result actually matters to an adopter-visible tag. A working build with red mirror CI can still land on `edge`; it simply cannot be promoted to a tagged `main` release until that CI goes green. This mirrors the existing division of responsibility between the two scripts (`mavp-publish-release.js`'s own file header) and is a deliberate choice, not an oversight — see `EXECUTION_LOG.md:895` for the architect's parallel and separate refusal to add an analogous gate to the *canonical*-CI axis of `mavp-publish-build.js`, on the grounds that a second network gate deserves its own cost/benefit ruling rather than riding in on this one.

**Documented in:** `docs/core/DECISIONS.md` (this record); `docs/core/GATE_LEDGER.md` (the gate's birth row, T-680); `docs/PUBLIC_RELEASE_STRATEGY.md` §3a (the `edge`-trigger note) and §3b (the new step 6b); `.github/workflows/ci.yml` (the `edge` branch trigger); `scripts/mavp-publish-release.js` (the gate itself, T-680).
