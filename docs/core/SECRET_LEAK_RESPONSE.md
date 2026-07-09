# Secret-leak response runbook

## Purpose

Public exposure of the Mavericks repo is irreversible — once a clone, fork, or search-engine cache exists, it cannot be recalled. This runbook is the pre-agreed, ordered response for "a secret was discovered in the public repo after publish" (post-`T-278`). It exists so the response is executed from a checklist under pressure, not improvised.

This runbook must exist and be reviewed before `T-278` (clean-cutover publish) runs. It blocks `T-278`.

## Who to contact

- **Repo owner** — sole authority to take the repo private, delete it, or authorize re-publish; reach the owner via the security reporting channel documented in [SECURITY.md](../../SECURITY.md). All steps below are owner-executed or owner-approved.
- **Credential provider(s) for the exposed secret** — rotate at the source. Known token classes in this project: EXA API key (EXA dashboard), third-party SaaS secret token (its dashboard), Figma token (Figma account settings), GitHub itself if a GitHub token/PAT is the leaked credential. If the leaked secret belongs to a provider not listed here, the owner identifies the correct provider dashboard before proceeding to Step 2 — do not skip rotation because the provider isn't on this list.
- **GitHub** (repo hosting) — target of the containment action in Step 1 (private/delete) and of the eventual clean re-publish in Step 4.

## Why order matters: contain before rotate

Containment (Step 1) comes before rotation (Step 2) because an attacker who already has the secret can continue using it for as long as it stays live, regardless of whether the repo is still public. Containment stops *new* readers from finding the secret; it does nothing about a credential someone has already copied. Rotation is what actually neutralizes the leak — invalidating the old credential value so a copy of it is worthless. Doing rotation first while the repo is still public risks a new secret being committed into the same exposed state before the old one is even revoked; doing containment first buys the time to rotate calmly, then verify, then decide whether/how to re-publish.

## Important: git history rewriting is not a fix

Rewriting git history on an **already-cloned public repo** (`git filter-repo`, `BFG`, force-push over history, etc.) does **not** reliably remove an exposed secret. The moment a repo is public, forks, clones, CI caches, and third-party mirrors (e.g. search-engine and package-index caches) may already hold the old history with the secret in it, and rewriting the canonical remote's history has no effect on those copies. History rewriting is not a substitute for any step below — in particular it does **not** replace credential rotation (Step 2). It has no role in this runbook other than as a discredited option.

## Response sequence (numbered, do in order)

### Step 1 — Contain: take the repo private, or delete it

Decide which within minutes of discovery — do not delay containment to investigate scope first.

- **Take the repo private** when: the repo has legitimate external users/stars/forks you want to preserve access continuity for once cleaned, or you intend to re-publish the same repo (not a fresh one) after remediation.
- **Delete the repo** when: exposure is severe (e.g. a production credential with broad blast radius), or you plan to re-publish via a fresh clean-cutover repo anyway (this project's `T-278` model produces a fresh public repo from an assembled tree each time, so deletion is the natural default for Mavericks specifically — private-canonical + fresh public re-publish, rather than reusing the exposed public repo).

Either action is taken on GitHub by the repo owner. This step does not require investigating the secret's blast radius first — that happens in parallel with or after Step 2.

### Step 2 — Rotate the exposed credential(s)

For every secret identified as exposed (not just the first one found — check the full commit history of the public repo up to the point of containment):

1. Identify the credential's provider and dashboard (see "Who to contact" above).
2. Revoke/rotate the exposed value at the provider, issuing a new value.
3. Update the new value everywhere it is consumed (local `.env`/`settings.local.json`-equivalent files, CI secrets, deployed environments) — the private canonical repo's untracked config, never a tracked file.
4. Record the rotation (owner-confirmed) before proceeding to Step 3. Do not proceed to Step 3 on the assumption rotation "will be done later" — an unrotated credential is still live and exploitable regardless of repo visibility.

This step is mandatory even if Step 1 fully removed public access — see "Important: git history rewriting is not a fix" above for why revocation, not access removal, is the actual mitigation.

### Step 3 — Re-run the T-277 scanner

Before any re-publish is considered:

1. Re-run the committed pre-publish secret and private-reference scanner (built by `T-277`) against the current assembled publish tree.
2. The scan must return a clean (zero-hit) result. If it flags anything — the original secret pattern, a new one, or a private reference — treat it as a new incident and restart from Step 1 for that finding.
3. Do not rely on memory or a manual grep in place of the scanner — the scanner is the authoritative, repeatable check for this project.

### Step 4 — Re-publish clean

Only after Steps 1–3 are complete and the scan in Step 3 is green:

1. Follow the standard clean-cutover publish procedure (`T-278`): run the copy-forward assembler against the current private `main`, re-verify the `T-277` scan is green on the freshly assembled tree, then `git init` a fresh public repo and push a single initial commit from the assembled tree.
2. A human (the repo owner) reviews and personally pushes — this is never automated, consistent with the standing `T-278` publish gate.
3. Confirm post-publish that the new public repo does not contain the rotated (now-dead) credential value or any other flagged content — a final owner spot-check, independent of the automated scan.

## Quick-reference checklist

- [ ] 1. Repo made private OR deleted (owner decision, executed immediately on discovery)
- [ ] 2. Every exposed credential identified and rotated at its provider; new values updated in private config only
- [ ] 3. `T-277` scanner re-run against the assembled tree; result is clean
- [ ] 4. Clean re-publish executed via the `T-278` procedure; owner performs the push personally
- [ ] 5. Post-publish spot-check confirms no trace of the rotated credential in the new public history
