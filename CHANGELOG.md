# Changelog

All notable changes to Mavericks are documented in this file, in a format
inspired by [Keep a Changelog](https://keepachangelog.com/). For how the
framework actually works, see [README.md](README.md) and the core process
docs in [`docs/core/`](docs/core/).

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
