# Launch-Readiness Artifacts Plan

> **Status:** Proposed (plan only; no implementation in this PR).
> **Authored:** 2026-07-05.
> **Anchors verified against main @ a488e4e9.**
> **Audience:** implementing agents at high reasoning effort. This document
> specifies objectives, invariants, acceptance criteria, and verification —
> not final copy. Where a decision needs the owner, it is flagged in §9.

## 0. Purpose and relationship to existing plans

This plan defines the **launch-readiness artifacts** JobHunter needs before it
is presented to the public: an accurate README, a synthetic demo-asset set, the
docs-site launch pages, a claim-freeze ledger, and a publish-mechanics
checklist. It is **artifacts only**.

It is complementary to, and must not duplicate or override,
`docs/plans/2026-07-03-oss-release-remediation-spec.md` (the OSS release
remediation spec). That spec owns the *capability* and *privacy* remediation
(apply-safety W1.*, privacy scanner W0.*, spend system, naming/governance
W2.*) and the authoritative **release gate** in its §5. This plan owns the
*presentation* artifacts and a *publish-mechanics artifact checklist* that
feeds that gate. Concretely:

- Where a demo asset would assert a capability that the OSS spec is still
  landing (e.g. approval binding, dry-run blocked-channel evidence, per-lane
  spend ceilings), this plan marks a **capability precondition** and defers
  the asset until that capability has merged to `main`. Assets never
  front-run shipped behavior (see §4 truthfulness invariant).
- The actual repository visibility flip, docs-deploy enablement, and first
  release tag remain **owner-only** actions governed by OSS spec §5; this plan
  produces the *checklist and verifications* for them, it does not execute
  them.

This plan aligns with the `ROADMAP.md` "Now" item ("Tighten public
documentation … Keep screenshot and QA fixtures synthetic so public docs can be
refreshed without exposing real job-search data") and the plan ledger in
`docs/plans/README.md`.

## 1. Goals

1. **README rewrite** — outcome-first above-the-fold; current-facts-only
   claims with an explicit Current vs Roadmap boundary; a "what leaves your
   machine" section consistent with `docs/user/data-and-safety.md`. Define the
   claim-review *process*, not the final copy.
2. **Demo assets from synthetic data only** — each a reproducible,
   QA-fixture-backed flow, with its fixture/data source, exact product path,
   and what it must visibly prove.
3. **Docs-site launch pages** — hero (`docs/index.md`) and product-tour
   (`docs/user/screenshots.md`) currency verification, plus the
   *infrastructure* for an "alternatives comparison" page (layout, maintenance
   cadence, facts-verified-before-publish rule). This plan never names any
   external product.
4. **Claim-freeze process** — every public claim labeled Current / Beta /
   Roadmap with an owner and a verification pointer (where in code/tests the
   claim is proven). Define the ledger format and where it lives.
5. **Publish-mechanics checklist** — repository visibility flip, docs-site
   deploy verification, repository-rename redirect verification, release
   tagging — each with an explicit verification step and rollback note.

All artifacts obey the repository's synthetic-data-only rule: no real profile
data, resumes, PDFs, logs, browser profiles, or databases (`README.md` "Local
Data And Safety"; `docs/user/data-and-safety.md`; `scripts/release_check.py`).

## 2. Non-goals (explicit)

- **Marketing tactics, channel strategy, launch-day sequencing, announcement
  or post copy, social content, SEO, analytics, growth, or pricing.** These are
  out of scope by definition of this workstream.
- **Naming or alluding to any external product or company** anywhere in the
  plan or the artifacts it defines. The alternatives-comparison work here is
  *infrastructure and rules only*.
- **Re-implementing or modifying any capability** — apply-safety, the privacy
  scanner, the spend system, discovery, scoring, tailoring, or the API. Those
  belong to `docs/plans/2026-07-03-oss-release-remediation-spec.md` and the
  architecture docs. This plan produces artifacts about behavior that already
  exists (or is explicitly deferred until it exists).
- **Executing** the repository flip, Cloudflare deploy enablement, PyPI
  rename, or release tag. Those are owner-only per OSS spec §5.
- **Changing docs-site architecture or frozen URLs** (`docs/.vitepress/config.ts`
  `SIDEBAR` URLs are frozen; only labels/order may change). Screenshot-harness
  changes are additive only (new fixtures/surfaces), never contract-breaking.
- **Producing any asset from a real `~/.jobhunter` workspace.**

## 3. Gates and execution order

Two hard gates order the work. They exist so that no asset can assert an
unfrozen or untrue claim, and no publish step can run before the artifacts it
publishes are ready.

```
Phase A  ── Claim-freeze ledger + claim-review process  (§5, §6 process)
             │
   ┌─────────┴─── GATE G1: claims frozen ───────────────┐
   ▼                                                     ▼
Phase B  ── README rewrite (§6)                          Docs-site launch
            Demo assets (§7)                             pages + alternatives
                                                         infrastructure (§8)
             │
   ┌─────────┴─── GATE G2: launch artifacts complete ───┐
   ▼
Phase C  ── Publish-mechanics checklist (§9)  ── feeds OSS spec §5 release gate
```

- **GATE G1 (claims frozen before assets).** No Phase B/§8 artifact may be
  produced until the claim-freeze ledger (§5) is populated, reviewed, and
  frozen at a recorded `main` sha. Every Current claim in the ledger has a
  resolving verification pointer at freeze time.
- **GATE G2 (assets before publish mechanics).** No Phase C publish step is
  marked ready until the README (§6), the in-scope demo assets (§7), and the
  docs-site launch pages (§8) are complete and pass their verification (§10).

Each phase is a separate reviewable PR (stacked where dependent), per repo PR
conventions. This plan document is its own PR and changes nothing else.

## 4. Cross-cutting invariants

Every section below must uphold these:

- **Truthfulness / no front-running.** An artifact may only assert a claim
  that is **Current** in the frozen ledger. A capability that is Roadmap or is
  still being landed by the OSS spec gets a Roadmap label or is deferred — never
  a demo asset or an above-the-fold README claim.
- **Synthetic-only.** Every fixture, screenshot, recording, and example uses
  synthetic data generated by the repo's seed path (`apps/api/test/qa-seed.ts`
  / `pnpm qa:seed`) or an equally synthetic extension. `scripts/release_check.py`
  must pass with zero findings on any tracked artifact.
- **Auditability discipline** (`CLAUDE.md` "Root-Cause And Auditability
  Discipline"). For any asset that proves an evidence/rationale/gate invariant
  (§7 assets 4, 5, 6, 7), the asset must reproduce the state from canonical
  fixture data and *visibly prove the invariant*. Cosmetic masking or a shallow
  snapshot that does not exercise the invariant is a failure.
- **Public-history-safe.** All artifact text uses neutral product language.
  Never write an external product/company name, and never reference a document
  that does not exist in the tracked repo.
- **In-repo links only.** Prefer backticked paths. Any markdown link in an
  artifact must resolve under the docs link-integrity gate (`pnpm docs:build`
  + `scripts/check-docs-site-links.mjs`).

## 5. Claim-freeze ledger (Goal 4) — Phase A

**Objective.** A single, tracked source of truth for every public claim
JobHunter makes, each labeled and provably backed, that can be *frozen* before
assets are built.

**Ledger location and publication.** Propose `docs/claims-ledger.md`,
**repository-only** (not published on the docs site). Register it in
`docs/.vitepress/config.ts` alongside the other repo-only docs: add to
`UNPUBLISHED_FILES` and to the `srcExclude` list (mirroring how
`docs/backlog.md` and `docs/README.md` are handled). Rationale: it is a
launch-governance artifact, not user documentation, and no listed doc in
`CLAUDE.md` owns "public claim provenance," so a new doc is justified under the
"avoid new docs unless nothing owns it" rule. (Final location is an owner
decision — §11.1.)

**Ledger format (one row per claim).** Columns:

| Column | Meaning |
| --- | --- |
| `Claim ID` | Stable, never-reused handle (e.g. `CL-001`), citable by PRs/QA. |
| `Claim (neutral)` | The public assertion, in neutral language. No external names. |
| `Surfaces` | Where it appears: `README`, `docs/index.md`, `docs/user/screenshots.md`, a demo asset id, etc. |
| `Status` | `Current` \| `Beta` \| `Roadmap`. |
| `Owner` | The person accountable for the claim staying true. |
| `Verification pointer` | Where the claim is proven: a `docs/requirements.md` BR/TR id, a test path, a source path, or a passing command. Must resolve. |
| `Last verified` | Date + `main` sha at last verification. |

**Invariants.**

- Every claim on every public surface maps to exactly one ledger row.
- Every `Current` row has a verification pointer that resolves *at freeze
  time* — preferentially reusing the existing requirement handles in
  `docs/requirements.md` (e.g. spend ceiling → `BR-050`; at-most-once apply →
  `BR-054`; failed-refresh preservation → `BR-041`/`TR-032`/`BR-052`;
  scoring-is-triage-only → `BR-022`; Temporal durability → `TR-008`). New
  claims with no existing handle get a test/source pointer.
- `Beta` means shipped but with known rough edges the claim must qualify;
  `Roadmap` means not shipped — Roadmap claims may only appear in clearly
  labeled Roadmap sections (they never gate a demo asset). The Current/Beta
  boundary threshold is an owner decision (§11.6).
- **Freeze:** the ledger is reviewed and the freeze recorded as a dated `main`
  sha line at the top of `docs/claims-ledger.md`. GATE G1 is satisfied only
  when the freeze line exists and every `Current` pointer resolved in that
  review.

**Claim-review process (also serves Goal 1's process requirement).**

1. Enumerate candidate claims from the current public surfaces (`README.md`,
   `docs/index.md` hero `features`, `docs/user/screenshots.md` captions).
2. For each, assign Status + owner + verification pointer; resolve every
   `Current` pointer.
3. Reconcile against `ROADMAP.md` so nothing labeled `Current` is actually a
   "Now/Next/Later" roadmap item.
4. Record the freeze sha. Re-run the review (refresh `Last verified`) whenever
   a surface changes or on the maintenance cadence (§8.3).

**Acceptance criteria.**

- `docs/claims-ledger.md` exists, is repo-only (excluded from the built site;
  `pnpm docs:build` does not publish it), and carries a freeze sha line.
- Every current public-surface claim has a ledger row; every `Current` row's
  verification pointer resolves.
- A reviewer can trace any hero/README/tour claim to its ledger row in one hop.

## 6. README rewrite (Goal 1) — Phase B (gated on G1)

**Objective.** Rewrite `README.md` so a first-time reader learns the *outcome*
first, sees only current-true claims, has an unambiguous Current vs Roadmap
boundary, and can see what leaves their machine — consistent with
`docs/user/data-and-safety.md`. This section defines objectives and the review
process; it does **not** prescribe final copy.

**Objectives and invariants.**

- **Outcome-first above the fold.** The opening leads with what the user
  achieves (find, judge, tailor, and apply to jobs safely and locally), not
  with the runtime component list. The current `README.md` "Current System"
  three-component breakdown and the `apps/*`/`workers/*` detail move below the
  outcome framing; nothing is deleted, only re-ordered and re-led.
- **Current-facts-only claims.** Every asserted capability above the
  Current/Roadmap boundary is a `Current` ledger row (§5). Anything not yet
  shipped is stated only under a labeled Roadmap section that points to
  `ROADMAP.md`. Reconcile the hero-level promises (e.g. the durable-pipeline,
  supervised-apply, and privacy claims currently in `docs/index.md`
  `features`) against their ledger status before repeating them in `README.md`.
- **Explicit Current vs Roadmap boundary.** A clearly labeled section divides
  shipped behavior from roadmap. Roadmap content does not appear in the
  outcome-first opening.
- **"What leaves your machine" section.** A short, scannable section that
  states the local-first default and enumerates the deliberate egress paths
  (LLM calls, job-board fetches, Gmail read-only, maps autocomplete, CAPTCHA
  solving, Langfuse telemetry). It must be **consistent with**
  `docs/user/data-and-safety.md` "Privacy Quick Answer" and "External
  Services" and link to it; it must not introduce a claim absent from that
  page. Keep the existing safety/back-up guidance.
- **No capability regressions in text.** Preserve every currently documented
  capability and safety note (auto-apply approval gate, dry-run guard, backup/
  restore); this is a re-lead and claim-audit, not a capability removal.

**Claim-review process for the README.**

- Produce a README claim-audit table (working artifact, may live in the PR
  description or a scratch file — not necessarily shipped): each README claim →
  ledger `Claim ID` → Status → verification pointer.
- The PR is not mergeable while any above-the-boundary claim lacks a `Current`
  ledger row with a resolving pointer, or while the egress section diverges
  from `docs/user/data-and-safety.md`.

**Acceptance criteria.**

- Above-the-fold content is outcome-led; component/runtime detail retained
  lower down.
- Current vs Roadmap boundary present and correct against `ROADMAP.md`.
- "What leaves your machine" section present and consistent with
  `docs/user/data-and-safety.md` (no contradictions; links resolve).
- Every README claim maps to a frozen ledger row; no `Current` claim without a
  resolving pointer.
- `pnpm docs:build` passes (README links that escape the published set are
  rewritten to GitHub URLs by `docs/.vitepress/config.ts`; new/edited links
  must still resolve). `scripts/release_check.py` passes.

## 7. Demo assets from synthetic data (Goal 2) — Phase B (gated on G1)

**Objective.** A reproducible, QA-fixture-backed demo-asset set that a reader
can regenerate deterministically, each proving one product invariant from
synthetic data only.

**Current baseline (verified).** `pnpm docs:screenshots` runs
`apps/web/e2e/tests/docs-screenshots.spec.ts`, seeding a disposable workspace
from `apps/api/test/qa-seed.ts` and writing eight PNGs to
`docs/assets/screenshots/` (`dashboard`, `jobs`, `apply-review`, `profile`,
`discovery`, `pipelines`, `runs`, `job-detail`), copying the hero
`dashboard.png` to `docs/public/assets/screenshots/`. That harness captures
**static seed state only** and is single-shot. The seed already contains rich
audit fixtures: a scored job with requirement-fit items (`r1` covered, `r2`
`missing_from_resume`), bullet provenance, an approved materials generation, a
dry-run apply run projection (`qa-run-1`, `dry_run=1`, succeeded) with
`WorkflowStarted`/`WorkflowCompleted` lifecycle events, a worker heartbeat, and
change annotations carrying a `draft_requires_confirmation` claim label with
`review_required: true` and a `review_blocked` revision decision.

**Asset classification.** Because some required assets prove *dynamic* or
*failure-lifecycle* behavior that a static screenshot cannot honestly show,
classify each asset:

- **(A) Static, already covered** — verify currency only against the current
  screenshot set / seed.
- **(B) Static, new seed state** — extend `apps/api/test/qa-seed.ts` fixtures
  and add a capture surface to `apps/web/e2e/tests/docs-screenshots.spec.ts`
  (additive; keep the existing surfaces green). New seed state that surfaces in
  the API must keep the strip-tested privacy pattern: the seed intentionally
  embeds tripwire secrets (e.g. `RAW PROMPT SECRET`) to prove the API strips
  them — new fixtures must never let such values reach an asset.
- **(C) Dynamic / lifecycle** — a driven, reproducible flow (a scripted e2e
  artifact or a synthetic screen recording) with its own synthetic fixtures,
  possibly requiring a live worker + Temporal. This plan **defines** the flow
  and its preconditions; it does **not** execute it (docs-only, nothing
  spendful). Class (C) assets must never be faked with a staged static image.

**Asset table.** For each asset: fixture/data source, exact product path, what
it must visibly prove, class, and any capability precondition (OSS-spec item
that must have merged first).

| # | Asset | Fixture / data source | Exact product path | Must visibly prove | Class | Capability precondition |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | First run to dashboard | A synthetic **empty/initialized** workspace (new seed variant, or `jobhunter init` on a disposable dir) — distinct from the populated seed | `jobhunter init` → `jobhunter doctor` output, then web `/dashboard` in its empty/onboarding state | The onboarding path exists and a fresh install lands on a coherent, empty dashboard (not an error) | B | none |
| 2 | Resume / profile import | Synthetic resume input + the profile-import wizard store (`apps/web/src/contexts/profile/stores/profile-import-store.ts`) | Profile import flow → `/profile` populated | Import ingests a synthetic resume into the canonical profile that scoring/tailoring build on | B/C | none |
| 3 | Discovery → scored jobs w/ requirement fit + provenance | `qa-seed.ts` scored job (`fit_score` 9), `job_requirement_fit_items` (`r1` covered / `r2` transferable-missing), `job_bullet_provenance` | `/discovery` → `/jobs` (sorted by fit) → `/jobs/<url>` detail drawer | A discovery run yields scored jobs whose fit is explained per-requirement with provenance back to evidence | A (+B for the discovery→jobs sequence) | none |
| 4 | Apply-review audit surfaces | `qa-seed.ts` approved materials generation, requirement evidence, `change_annotations` (comments), approval controls | `/apply-review` and its evidence / comments / approval-control sub-surfaces | Evidence, line comments, and explicit approval controls are inspectable before anything is submitted | A (+B for sub-surface captures) | none |
| 5 | Artifact replacement preserves last accepted on failure | New seed state: an approved generation **plus** a later **failed** refresh that does not supersede the approved artifact | `/apply-review` (or artifact view) before/after a failed re-tailor | A failed refresh never destroys the last accepted artifact; the accepted material stays visible and openable (`BR-041`, `BR-052`, `TR-032`) | B | none (behavior shipped) |
| 6 | Tailoring gate rejects an unsupported claim | `qa-seed.ts` change annotation with an unsupported/needs-confirmation claim label + `review_blocked` decision; extend to a clearly *fabricated* claim per `docs/architecture/tailoring.md` fabrication gates | `/apply-review` zoomed on the blocked claim + its blocker/repair reason | The gate blocks the unsupported claim and surfaces the blocker and repair instruction — proven from canonical fixture data | B | none (behavior shipped) |
| 7 | Dry-run apply completes without submission + live-approval gate | `qa-seed.ts` dry-run run (`qa-run-1`), approval card (`applyApprovalRequired` default true), and dry-run blocked-channel evidence (`apply_dryrun_blocked`) | `/apply-review` approval card + `/runs` dry-run run + blocked-channel evidence | A dry run finishes, nothing was submitted, and live submit is gated behind an explicit fresh approval (`BR-054`) | B (approval + run) / C (live blocked-channel evidence) | Approval-binding + blocked-channel evidence: OSS spec **W1.1 / W1.2** for the evidence asset |
| 8 | Spend-ceiling stop + health surface | New seed state: `llm_spend` at/over `dailyBudgetUsd`; a workflow stopped with the budget error | `GET /v1/health` + web health surface showing over-budget; a run stopped by the ceiling | A daily spend ceiling stops spending work and the over-budget state is visible (`BR-050`) | B (health surface) / C (the stop lifecycle) | Spend system + per-lane visibility: OSS spec **P5 / W2.4** |
| 9 | Reliability demo — kill worker mid-run, restart, resume | Synthetic discovery run against a stub/fake source (no real crawl/LLM); Temporal history persisted at `.dev/temporal/temporal.db` | Start a synthetic run → kill the worker **by captured PID** → restart worker → `/runs` + Temporal UI show the same run resuming | Durable Temporal execution resumes an in-flight run from workflow history after a worker crash (`TR-008`) | C | none (durability shipped) — but requires a live worker + Temporal to record |

**Reproducibility requirements (all assets).**

- Every asset has a named, deterministic regeneration path. Class (A)/(B)
  assets extend the existing `pnpm docs:screenshots` harness (fixed viewport,
  synthetic DB, seeded heartbeat, no external providers) per
  `docs/local-development.md` "Documentation Screenshots." Class (C) assets get
  a documented scripted flow with explicit synthetic fixtures and, for asset 9,
  an explicit **kill-by-captured-PID** step (never a broad process kill — see
  `docs/local-development.md` `scripts/dev` and repo worker-safety practice).
- Class (B) state fixtures that assert an invariant (assets 5, 6) get a
  regression test proving the invariant from the fixture, so the asset cannot
  silently drift from the behavior it depicts.
- No asset regenerates from a real workspace; the refresh checklist in
  `docs/local-development.md` (review every PNG for private data / path leaks;
  refresh the hero copy; finish with `git diff --check`) applies to every new
  asset.
- Assets with an unmet capability precondition (7 evidence, 8) are **deferred**
  with a one-line note until their OSS-spec item merges; the launch set ships
  without them rather than faking them (§11.4 records which assets are in the
  initial launch set).

**Acceptance criteria.**

- Each in-scope asset is regenerable by a single documented command/flow from
  synthetic data, is correctly classified, and visibly proves its stated
  invariant.
- New capture surfaces added to `apps/web/e2e/tests/docs-screenshots.spec.ts`
  keep all existing surfaces green; `pnpm docs:screenshots` runs clean.
- Assets 5 and 6 have backing regression tests; `pnpm qa:test` / `pnpm api:test`
  / web tests pass for any touched seed/fixture.
- `scripts/release_check.py` reports zero findings on all tracked assets.
- Deferred assets are listed with their blocking OSS-spec item; none is faked.

## 8. Docs-site launch pages (Goal 3) — Phase B (gated on G1)

The docs site is VitePress over `docs/` (`docs/.vitepress/config.ts`), built by
`pnpm docs:build` (dead-link gate + `scripts/check-docs-site-links.mjs` href
gate) with a browser runtime gate `pnpm docs:check:runtime`
(`scripts/check-docs-site-runtime.mjs`: zero 404s, mermaid hydration, exactly
one `aria-current`, Product Tour screenshots load pixels). CI runs the build
gate via `.github/workflows/docs-site.yml`.

### 8.1 Hero + product-tour currency verification

**Objective.** The hero (`docs/index.md`) and the Product Tour
(`docs/user/screenshots.md`) assert only frozen `Current` claims and show
current screenshots.

**Invariants.**

- Every hero `features[].title/details` and every tour caption maps to a
  frozen ledger `Current` (or clearly-labeled Beta) claim. Reconcile forward
  claims (e.g. "no application is ever submitted twice," "durable workflow …
  daily LLM spend ceiling") against `BR-054` / `BR-050` ledger rows before they
  ship on the hero.
- Every image referenced by the hero and the tour exists in
  `docs/assets/screenshots/` (and the hero copy in
  `docs/public/assets/screenshots/dashboard.png` is refreshed) and was
  regenerated by the synthetic harness in the same change if seed/UI changed.
- Sidebar URLs stay frozen (`docs/.vitepress/config.ts` `SIDEBAR`); only labels
  and order may change.

**Acceptance criteria.**

- `pnpm docs:build` passes (no dead/unresolvable links, href gate clean).
- `pnpm docs:check:runtime` passes (screenshots load pixels; mermaid hydrates;
  single `aria-current`).
- No hero/tour claim lacks a frozen ledger row.

### 8.2 Alternatives-comparison page — infrastructure only

**Objective.** Land the *infrastructure* for an alternatives-comparison page so
the owner can later populate it safely. **This plan names no external product**
and publishes no comparative row.

**Deliverables (scaffold + rules, not content).**

- **Page layout.** A criteria-by-approach matrix: rows are neutral *capability
  categories* (e.g. local-first data ownership, supervised apply gates, audited
  materials, explainable scoring, durable orchestration, spend control) drawn
  from frozen `Current` ledger rows; columns are the JobHunter column plus
  placeholder "alternative approach" columns the owner fills privately at
  publish time. The JobHunter column cells cite ledger `Claim ID`s. The page
  lives in the published docs set with a frozen sidebar slot added to
  `docs/.vitepress/config.ts` `SIDEBAR` (label/placement is an owner decision,
  §11.3).
- **Maintenance cadence.** A stated re-verification interval (e.g. every
  release or every N months — owner sets the interval, §11.3) recorded on the
  page and in the claim-review process (§5), so comparative rows do not rot.
- **Facts-verified-before-publish rule.** No comparative cell about an external
  approach publishes without a recorded verification date and a dated source;
  JobHunter-side cells must cite a frozen `Current` ledger row. Unverified rows
  stay unpublished (draft/commented) rather than shipping speculative claims.
  The rule is written into the page's own maintainer note and enforced at
  review.

**Invariants.**

- The scaffold contains **no external product/company name** and no
  comparative claim; it is structure + rules + placeholders only.
- The page builds clean under `pnpm docs:build` and `pnpm docs:check:runtime`
  with placeholder content.
- Actual competitor identification and row population is owner-owned,
  facts-verified, and performed outside this plan (§11.3).

**Acceptance criteria.**

- Scaffold page + sidebar slot present; builds and passes both docs gates.
- Cadence and facts-verified rule documented on the page.
- Zero external names; `scripts/release_check.py` clean.

## 9. Publish-mechanics checklist (Goal 5) — Phase C (gated on G2)

**Objective.** A concrete, verifiable checklist for the mechanical publish
steps, each with a verification and a rollback note. This is the *artifact*;
the owner executes the owner-only steps per OSS spec §5.

| Step | Action | Verification | Rollback note |
| --- | --- | --- | --- |
| 9.1 Repo visibility flip | Owner flips `github.com/ebarti/JobHunter` to public (owner-only, OSS spec §5) | `release-check` (`.github/workflows/release-check.yml`) green on `main` for every commit since W0.4; `python3 scripts/release_check.py` zero findings locally; OSS spec §5 final manual QA complete | Flip back to private. **Note honestly:** anything fetched while public cannot be recalled and git history remains reachable — the real mitigation is the pre-flip privacy gate, not rollback (OSS spec §1 records this acceptance). |
| 9.2 Docs-site deploy | Set repo variable `DOCS_DEPLOY_ENABLED=true` and the two Cloudflare secrets so the `deploy` job in `.github/workflows/docs-site.yml` runs from `main` | On next `main` push, the deploy job runs (not skipped), the site serves, and `pnpm docs:build` + `pnpm docs:check:runtime` are green on the built artifact | Unset `DOCS_DEPLOY_ENABLED` → the deploy job skips cleanly and the workflow stays green; redeploy the previous `docs-site-dist` artifact if a bad build shipped. |
| 9.3 Repo-rename redirect | **Conditional** — OSS spec §1 locks the GitHub repo name as `JobHunter`; only if the owner decides to rename (§11.2) | After a rename, GitHub auto-redirects old URLs: verify old `github.com/ebarti/JobHunter` links resolve; update the absolute `REPO_URL` in `docs/.vitepress/config.ts` and any absolute repo links/badges; re-run `pnpm docs:build` | Rename back (GitHub reserves the prior name); revert the `REPO_URL`/link edits. If not renaming, mark this step **N/A**. |
| 9.4 Release tagging | Restore the tag trigger in `.github/workflows/publish.yml` (currently `workflow_dispatch` only) after the PyPI rename, then tag the first release | OSS spec **W2.1** merged (name chosen, `pyproject.toml` updated); `publish.yml` tag trigger gated on the release-check workflow passing; build produces the renamed sdist/wheel | Delete the tag; if a bad artifact published to PyPI, yank it. Keep the trigger `workflow_dispatch`-only until W2.1 is confirmed. |

**Invariants.**

- The checklist does not execute owner-only steps; it prepares and verifies
  them and cross-references OSS spec §5 as the authoritative gate.
- Steps with a precondition (9.3 rename decision, 9.4 W2.1) are explicitly
  conditional and never marked done while the precondition is unmet.

**Acceptance criteria.**

- Every step has a concrete verification and a rollback note.
- The checklist references OSS spec §5 and does not duplicate its capability/
  privacy gates.
- Owner-only and conditional steps are flagged.

## 10. Verification (exact commands)

Run the commands for every surface a change touches; the docs and privacy gates
always. All commands are from the `CLAUDE.md` matrix plus the docs gates.

| Surface | Command | Required result |
| --- | --- | --- |
| Docs link/build gate | `pnpm docs:build` | Builds; dead-link + href gates pass |
| Docs runtime gate | `pnpm docs:check:runtime` | Zero 404s; mermaid hydrates; single `aria-current`; tour images load |
| Synthetic screenshots | `pnpm docs:screenshots` | Regenerates PNGs from synthetic seed; harness green |
| Privacy gate (always) | `python3 scripts/release_check.py` | **Zero findings** |
| Cross-stack typecheck/lint | `pnpm check` | Zero errors (if code/fixtures touched) |
| Cross-stack tests | `pnpm test` | All pass (if code/fixtures touched) |
| API QA harness | `pnpm qa:test` | All pass (if `qa-seed.ts`/API touched) |
| API tests | `pnpm api:test` | All pass (if API/seed touched) |
| Web unit/hook/component | `pnpm --filter @jobhunter/web test` | All pass (if web touched) |
| Web e2e (screenshots spec) | `pnpm --filter @jobhunter/web e2e -- tests/docs-screenshots.spec.ts` | Green (equivalent to `docs:screenshots`) |
| Hygiene | `git diff --check` | Clean |

Notes:
- Mermaid renders client-side; if any diagram is added/edited, also eyeball it
  in `pnpm docs:dev` before merge (build-pass does not catch a bad diagram).
- `pnpm docs:preview` snapshots the dist file list at startup; restart it after
  any rebuild or hashed assets 404.
- This plan-only PR requires only `pnpm docs:build` (+ `scripts/release_check.py`
  and `git diff --check`) since it adds a single markdown file and no links that
  escape the published set improperly.

## 11. Open owner decisions

1. **Claims-ledger location/publication** — proposed `docs/claims-ledger.md`,
   repo-only (registered in `UNPUBLISHED_FILES` + `srcExclude`). Confirm the
   path and repo-only status.
2. **GitHub repo rename** — OSS spec §1 locks the repo name as `JobHunter`.
   Confirm whether any rename happens at all; step 9.3 is conditional on this.
3. **Alternatives-comparison** — which neutral capability categories are the
   rows, which external approaches are the columns (owner-supplied, kept
   private until facts-verified), the maintenance-cadence interval, and the
   sidebar label/placement.
4. **Demo-asset launch set** — which assets ship in the initial launch vs are
   deferred until their capability merges: asset 7's live blocked-channel
   evidence (OSS spec W1.1/W1.2) and asset 8's spend-ceiling stop (OSS spec
   P5/W2.4). Confirm the initial set.
5. **Reliability-demo format** — asset 9 as a scripted e2e artifact vs a
   synthetic screen recording vs a documented walkthrough, and where the
   artifact lives (must be synthetic and privacy-safe; recordings are binary).
6. **Current vs Beta threshold** — the bar that makes a shipped-but-rough
   capability `Beta` rather than `Current` in the ledger.
7. **Sign-off owners** — who owns the claim-freeze sign-off and each Phase C
   publish step.

## 12. Risks and mitigations

- **Claim drift / assets built before freeze.** → GATE G1; `Last verified`
  sha per ledger row; re-review on the maintenance cadence.
- **Overclaiming unshipped capabilities.** → per-asset capability precondition;
  defer (don't fake) assets 7-evidence and 8 until their OSS-spec item merges;
  Roadmap items never appear above the README boundary or on the hero.
- **Faking dynamic behavior with static images** (assets 8, 9). → class (C)
  requires a driven flow; staged static fakes are a review failure.
- **Privacy leak in a new fixture/asset.** → synthetic-only; `release_check.py`;
  manual PNG review; keep the seed's strip-tested tripwire pattern so
  API-stripped secrets never reach an asset.
- **Alternatives page staleness or unverifiable comparison.** → facts-verified-
  before-publish rule + cadence + neutral placeholders; no external name in the
  scaffold; unverified rows stay unpublished.
- **Public-history exposure at the visibility flip.** → the pre-flip privacy
  gate is the real control (rollback cannot recall fetched data); OSS spec §5
  records the owner's acceptance.
- **Docs deploy hashed-asset 404 after rebuild** (known gotcha). → restart
  preview; `pnpm docs:check:runtime` in CI/verification.
- **Repo-rename breakage** of absolute `REPO_URL` links and the hero image
  path. → step 9.3 verification + `pnpm docs:build`.

## 13. Definition of Done

- **Phase A / G1:** `docs/claims-ledger.md` exists, repo-only, frozen at a
  recorded `main` sha; every public-surface claim has a row; every `Current`
  row's verification pointer resolves.
- **Phase B — README (§6):** outcome-first opening; Current vs Roadmap boundary
  correct against `ROADMAP.md`; "what leaves your machine" section consistent
  with `docs/user/data-and-safety.md`; every claim maps to a frozen ledger row.
- **Phase B — demo assets (§7):** each in-scope asset is regenerable by one
  documented command/flow from synthetic data, correctly classified, and
  visibly proves its invariant; assets 5 and 6 have regression tests; deferred
  assets are listed with their blocking OSS-spec item and none is faked;
  `pnpm docs:screenshots` and `scripts/release_check.py` clean.
- **Phase B — docs pages (§8):** hero + tour currency verified; alternatives
  scaffold + cadence + facts-verified rule + sidebar slot landed with **no
  external name**; `pnpm docs:build` and `pnpm docs:check:runtime` green.
- **Phase C / G2 (§9):** publish-mechanics checklist complete with per-step
  verification + rollback; owner-only and conditional steps flagged;
  cross-referenced to OSS spec §5.
- **Global:** all applicable §10 commands pass; `scripts/release_check.py`
  zero findings; no external product/company named anywhere; every markdown
  link resolves in-repo; this plan's PR adds exactly one new file and changes
  no code or behavior.
