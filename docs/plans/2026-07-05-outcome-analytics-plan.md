# Application Outcome Analytics And Artifact Comparison — Implementation Plan

> **Status:** Proposed. This is a planning document only; it ships no code.
> **Anchors verified against `main` @ `a488e4e9`** (`fix(reliability): discover
> fault isolation, truthful failures, honest read models`). Every path, symbol,
> table, and column cited below was confirmed against this worktree HEAD; the
> anchor appendix (§13) lists the load-bearing references.
> **Builds on (do not re-implement):**
> `docs/plans/implemented/2026-06-01-apply-review-outcome-feedback.md` and its
> `-design.md` sibling (the outcome/feedback foundation), and
> `docs/plans/implemented/2026-06-15-requirement-fit-ledger.md` (score evidence).
> **Canonical surfaces this plan extends:** `docs/architecture/read-model.md`
> (projection-backed read model + the existing outcome-conversion funnel) and
> `docs/architecture/frontend/` (view-vs-context architecture).

## 1. Goal

Turn data JobHunter **already persists** into decision-useful, auditable
analytics, and close the loop on recorded application outcomes that are currently
written but never read back into product value.

Four outcomes, delivered behind explicit phase gates:

1. **Outcome read models** — observed response / interview / offer rates broken
   down by dimensions the system can source from canonical rows (job source, fit
   band, apply mode, resume template, tailoring policy), with a hard product
   invariant: **no rate is ever shown without its sample size `n`, and no rate is
   shown at all below a minimum-`n` threshold** (counts only).
2. **An analytics UI surface** consistent with the frontend architecture: a view
   composes context components; reads flow through the Operations context's
   hooks; per-context query keys.
3. **Side-by-side artifact comparison in review** — accepted vs draft, template A
   vs template B, coverage deltas, risk labels, and (once outcome data
   accumulates) association with recorded outcomes.
4. **Close the outcome loop** — make recorded-but-unread outcome data visible as
   product value (which templates / policies are *associated* with responses,
   time-to-response, suggestion accuracy), with every displayed number traceable
   to a canonical row and never implying causation.

## 2. Current State (grounded)

### 2.1 What already exists

An outcome-conversion funnel is already computed and shipped:

- **Canonical fact rows** live in `application_outcomes`
  (`apps/api/src/application-feedback.ts:146`, and the Python/Gmail writer
  `workers/automation/src/jobhunter/infrastructure/gmail/feedback.py:265`),
  columns: `tenant_id, outcome_id, job_key, kind, source, note, occurred_at,
  recorded_at, suggestion_id, evidence_id, created_by`. Outcome `kind` enum
  (`packages/contracts/src/schemas.ts:1008`): `applied_confirmation,
  recruiter_reply, interview, assessment, rejection, offer, withdrawn, bounced,
  no_response, unknown`. Outcome `source` ∈ `{manual, email_suggestion}`
  (`schemas.ts:1022`) — this is the *recording channel*, distinct from the job's
  discovery source.
- **The funnel projection** `dashboard_projections.outcome_conversion_json` is
  built **twice, byte-identically**: TypeScript `buildOutcomeConversion`
  (`apps/api/src/projections.ts:2448`) and Python `_build_outcome_conversion`
  (`workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py:1653`).
  Shape: `{version:1, totals, bySource:[{source,…}], byBand:[{band,…}]}` with
  integer counts `{applied, reply, interview, offer, rejection}`. Denominator =
  jobs where `applied_at` is set OR `apply_status == "applied"` (dry-runs are
  excluded). Cumulative kind→stage sets are defined in both runtimes
  (`projections.ts:2397-2400`, `projection_builder.py:272-277`).
- **Rates are derived at read time** (integers stay in the projection to avoid
  cross-runtime float drift): `buildConversionSummary` /
  `conversionFunnelMetrics` / `conversionRate` in `apps/api/src/read-model.ts:3483-3530`,
  exposed as `DashboardSummary.conversion`
  (`DashboardConversionFunnel` / `DashboardConversionSummary`,
  `packages/contracts/src/schemas.ts:2125-2142`).
- **UI**: `apps/web/src/views/dashboard/ConversionPanel.tsx` renders totals /
  bySource / byBand; Operations owns `useDashboardSummaryQuery`,
  `useApplicationOutcomesQuery`, `useJobApplicationOutcomesQuery`, and the
  `outcomesKeys` factory; the Apply context owns the `<ApplicationOutcomes>`
  family (`<JobOutcomePanel>`, `<OutcomeSuggestionsPanel>`, `<ManualOutcomeForm>`,
  `<OutcomeTimeline>`).
- **Cross-runtime parity is enforced** by the fixture
  `packages/domain-types/test/fixtures/audit_projection_parity.json`
  (expected `outcome_conversion_json` at ~807-852) and the paired tests
  `apps/api/test/audit-projection-parity.test.ts` and
  `workers/automation/tests/test_audit_projection_parity.py`; focused unit tests
  live in `apps/api/test/projections.test.ts` and
  `workers/automation/tests/test_dashboard_projection.py`
  (`test_outcome_conversion_counts_by_source_and_band:400`).

### 2.2 The defects and gaps this plan addresses

- **The small-sample invariant does not exist.** `conversionRate`
  (`read-model.ts:3527`) returns `null` only when `applied <= 0`. A group with
  one application and one reply renders `100%`. `ConversionPanel` shows the count
  *and* the percentage at any `n ≥ 1`. There is no minimum-`n` gating and no
  non-causal framing.
  **Status 2026-07-05: the existing-funnel half of this defect is fixed by
  PR #273** (`fix/conversion-rate-min-sample`): `MIN_CONVERSION_SAMPLE = 5`
  (owner-tunable, `apps/api/src/read-model.ts`) now gates every existing rate
  (totals, `bySource`, `byBand`), `ConversionPanel` shows an insufficient-data
  state, and the `n=1`-shows-no-rate fixture exists in both runtimes. This
  plan's Phase 1 extends that shipped invariant to the new analytics
  dimensions; it does not re-implement it.
- **Grouping is limited to `source` and score band.** Fit band, apply mode,
  resume template, and tailoring policy are not grouped, even though the inputs
  are persisted (see §4).
- **`costPerInterview` is hardwired `null`** (`read-model.ts:3523`); no per-run
  apply cost is projected anywhere (no cost column on `apply_run_projections`
  `sqlite_projection_store.py:213` or `workflow_run_projections:233`).
- **The loop is open.** `application_outcomes` is read by exactly three
  consumers — the conversion builder (reads only `job_key` + `kind`), the
  read-time rate derivation, and the per-job audit timeline
  (`read-model.ts:908` `appendApplicationOutcomeAuditEntries`). Written but never
  read for analytics: `occurred_at` + `recorded_at` (**time-to-response is
  computable but unread**), `note`, `source`, `suggestion_id`, `evidence_id`.
  `application_outcome_suggestions` has **no aggregate consumer** (classifier
  accept/correct/ignore accuracy is unread). Nothing correlates resume template
  or tailoring policy with outcomes. Separately,
  `tailoring_feedback_signals` (`apps/api/src/resume-review-drafts.ts:249`) is
  recorded from human resume edits but **not fed back into generation** — a
  parallel open loop (consumption is a non-goal here; see §11).
- **No artifact comparison surface** exists, even though multiple generations per
  job with accepted-vs-draft status and projected coverage already exist (§4.6).

### 2.3 Two divergent band vocabularies (must be resolved, see D2)

- Domain scoring: `FIT_BANDS = (excellent, strong, plausible, stretch, poor)`,
  `fit_band_for_score` (`workers/automation/src/jobhunter/domain/scoring/value_objects.py:48,130`).
  A first-class `fit_band` column exists on `job_requirement_fit_reports`
  (`workers/automation/src/jobhunter/database.py:1392`).
- Projection/funnel: `SCORE_BAND_ORDER = (perfect, strong, moderate, weak, poor,
  unscored)`, `_score_band` (`projection_builder.py:267,280`; TS mirror
  `projections.ts:2394,2417`). The existing funnel groups by **this** vocabulary.

The mission asks for grouping "by fit band." These two vocabularies must not be
silently conflated; §4.2 and decision **D2** define the resolution.

## 3. Product Invariants (binding for every phase)

1. **Read-only.** Analytics and comparison never feed scoring, ranking,
   thresholds, apply eligibility, or discovery scheduling. This preserves the
   invariant already documented for the conversion funnel
   (`docs/architecture/read-model.md:148`). A guard test asserts no analytics
   read model is imported by scoring/apply/pipeline decision code.
2. **Every displayed number is traceable to a canonical row.** For each metric
   the plan (and the shipped tooltip/inspector) names its source of truth: an
   `application_outcomes` row, a `job_list_projections` row, an accepted
   `job_materials` generation, a `job_bullet_provenance.coverage_json` bucket, a
   `job_requirement_fit_reports` row, or a decided
   `application_outcome_suggestions` row. No metric is inferred from the job
   description or from another derived metric.
3. **Small-sample honesty (central invariant).** No rate is shown without its
   `n`. Below `MIN_RATE_SAMPLE_N` (see D1) a group shows counts only — never a
   percentage. See §3.1 for exact labels.
4. **No causal language.** Copy describes *observed associations in your own
   recorded data*, never cause/effect or recommendations. See §3.1 for the exact
   allow/deny word list.
5. **Audit preservation.** Comparison and re-tailoring never hide or suppress the
   last accepted artifact until a replacement is approved (existing invariant,
   `docs/architecture/read-model.md:90-99`); coverage is computed from actual
   rendered resume text, never inferred from job keywords (existing invariant,
   `CLAUDE.md` Root-Cause discipline; `coverage_audit.py` docstring).
6. **Dual-writer parity.** Any new column on a dual-written projection table
   (`dashboard_projections`, `job_list_projections`, …) must be added to **both**
   `ensure_projection_tables` implementations (`sqlite_projection_store.py:89`,
   `projections.ts:429`), **both** builders, and the parity fixture
   (`audit_projection_parity.json` — values + `projectionParity.jsonColumns`), or
   the parity tests fail by construction.

### 3.1 Exact language and labels (define once, reuse everywhere)

A single shared constant `MIN_RATE_SAMPLE_N` (D1) governs gating in the read
model **and** the UI. Rendering rules:

| Group state | Rendered |
|---|---|
| `applied == 0` | `no applications yet` (no rate, no `n`) |
| `0 < applied < MIN_RATE_SAMPLE_N` | count + `n=<applied>` + `too few to rate` — **no percentage** |
| `applied >= MIN_RATE_SAMPLE_N` | `<rate>% · n=<applied>` — rate and `n` always adjacent |

- **Persistent panel caption (required, verbatim intent):** "Descriptive
  associations from your own recorded outcomes — not causal claims. A rate
  appears only once a group has at least *N* applications; smaller groups show
  counts only. Analytics never affect scoring, ranking, or apply eligibility."
- **Denied words in headings, captions, tooltips, and column labels:** "best",
  "better", "winner", "improves", "boosts", "increases your chances",
  "recommended", "optimal", "should use". **Allowed framing:** "observed",
  "recorded", "associated with", "in your data", "so far".
- **Ordering:** default sort by `applied` (volume) descending, never by rate.
  A user may re-sort by rate, but the `n` column stays visible and
  below-threshold rows are visually de-emphasised and sorted last; the surface is
  never presented as a ranking or a recommendation.
- **Rate semantics in the read model:** the contract carries both the count and
  an explicit rate field that is `null` when `applied < MIN_RATE_SAMPLE_N` (not
  merely when `applied == 0`), so a client cannot accidentally render a
  small-sample percentage.

## 4. Dimension Catalog — source of truth per grouping (grounded)

| Dimension | Source of truth (canonical) | Status today | Work required |
|---|---|---|---|
| **Job source** | `job_list_projections.source` (`sqlite_projection_store.py:94-132`) | Grouped (`bySource`) | Reuse; add small-sample gating |
| **Score band** | `fit_score` → `_score_band` / `scoreBand` | Grouped (`byBand`) | Reuse; label precisely (D2) |
| **Fit band (canonical)** | `job_requirement_fit_reports.fit_band` (`database.py:1392`); `FIT_BANDS` | Not grouped | D2 decides vocabulary; derive/join |
| **Apply mode** | `apply_run_projections.dry_run` + `_derive_apply_status` (`projection_builder.py:2990`); MarkApplied transition; `applied_confirmation` outcome | Not grouped | Derive `apply_mode` (D4) |
| **Resume template** | `job_materials.metadata_json.resume_template.{templateId,templateVersionId,templateHash}` (`use_cases.py:1648`); artifact `metadata_json`; `artifact_list_projections.metadata_json` | Snapshotted, not grouped | Project applied generation's template; join to outcomes (Phase 4) |
| **Tailoring policy** | `job_materials.metadata_json.{tailoring_policy_id,tailoring_policy_version}` (`use_cases.py:1645`); `tailoring_policies` (`database.py:1509`) | Snapshotted, not grouped | Project + join (Phase 4) |
| **Role family** | Only `ROLE_FAMILY_MARKERS` (`workers/automation/src/jobhunter/domain/compensation/market.py:190`) and `role_title_matcher.py` — **not persisted per job as a groupable dimension** | Absent | Net-new derivation + persistence (D3, owner-gated) |
| **Cost / cost-per-interview** | No cost column on any run projection; `costPerInterview` stubbed `null` | Absent | Owner-gated; project per-run apply cost (D5) |

Time-to-response uses `application_outcomes.occurred_at` minus the job's
`applied_at` (`job_list_projections.applied_at`); classifier accuracy uses
decided `application_outcome_suggestions` rows (`status ∈ {accepted, corrected,
ignored}`, `apps/api/src/application-feedback.ts:187`).

## 5. Phase Plan (gated)

Delivery order follows the mission's gates: **read models → UI → comparison →
outcome joins.** Each phase is one or more stacked PRs. A phase is a gate: its
exit criteria (below) must be met before the next phase starts. Phases specify
objectives, contracts, invariants, and acceptance — not step-by-step edits.

The per-phase acceptance template answers: **source of truth · owning bounded
context · projection/read model · API + contract · UI surface · approving user
action · invariant proven · synthetic regression fixture · local QA path · phase
gate.**

---

### Phase 1 — Outcome analytics read model + small-sample invariant

**Objective.** Extend the small-sample invariant and non-causal framing to the
new analytics dimensions, and expand the read model to the dimensions sourced
directly from a job's own projection (source, score/fit band, apply mode).
Deliver a dedicated analytics read model + endpoint that the Phase 2 view
consumes; leave the dashboard's headline `conversion` funnel in place.

**Scope reduction (2026-07-05).** The retrofit of the existing funnel — rate
gating, `ConversionPanel` insufficient-data state, and the `n=1` regression
fixtures — shipped separately as PR #273. Phase 1 reuses its shipped constant
`MIN_CONVERSION_SAMPLE` (`apps/api/src/read-model.ts`, default `5`) as the one
shared threshold everywhere this plan says `MIN_RATE_SAMPLE_N`; D1 is now
"confirm or tune that shipped default", not "introduce the constant".

- **Source of truth.** `application_outcomes` (`job_key`, `kind`, `occurred_at`)
  × applied `job_list_projections` rows (`source`, `fit_score`, `applied_at`,
  `apply_status`). Apply mode derived per D4 from `apply_run_projections` +
  MarkApplied events + `applied_confirmation` outcomes.
- **Owning bounded context.** Operations / Read-Side (the funnel is an Operations
  concern; `docs/architecture/frontend/contexts.md:419`). Apply Automation owns
  the outcome *facts*; Operations owns the *read model* over them.
- **Projection / read model.** Extend the canonical outcome computation
  (`buildOutcomeConversion` + `_build_outcome_conversion`) so the materialised
  integer counts include the new dimension breakdowns; keep counts integer-only
  for parity. Add `byApplyMode` (and, per D2, a precisely-labelled band
  breakdown). If the dimension needs a per-job attribute not already on
  `job_list_projections` (apply mode), project it as a denormalised column on
  `job_list_projections` (dual DDL + both builders + fixture per Invariant 6).
- **API + contract.** New `GET /v1/analytics/outcomes` in `apps/api/src/server.ts`
  (sibling of `/v1/dashboard/summary:287`), returning an `OutcomeAnalyticsSummary`
  contract in `packages/contracts/src/schemas.ts`. Each group carries integer
  counts, an `n` (= `applied`), and a rate field that is `null` when
  `n < MIN_RATE_SAMPLE_N`. Rate derivation lives beside `conversionFunnelMetrics`
  in `read-model.ts` and reuses one shared `MIN_RATE_SAMPLE_N` constant.
- **UI surface.** None in this phase beyond retrofitting the small-sample rule
  into the existing `ConversionPanel.tsx` (so the shipped dashboard stops showing
  100%-off-`n=1`). The full analytics view is Phase 2.
- **Approving user action.** None (read-only). Outcome recording remains
  user-gated (`POST /v1/jobs/:jobKey/outcomes`, suggestion decisions).
- **Invariant proven.** Small-sample gating (Invariant 3); non-causal contract
  shape (rate `null` below threshold); read-only (Invariant 1) guard test.
- **Synthetic regression fixtures.**
  - **Small-sample fixture (required):** applied jobs where one source/band group
    has `applied = 1, reply = 1` and another has `applied >= MIN_RATE_SAMPLE_N`.
    Assert the small group's rate field is `null` and the UI renders `too few to
    rate` (never `100%`), while the large group renders a numeric rate with its
    `n`. Add to both `apps/api/test/` and `apps/web/src/.../ConversionPanel` tests.
  - **Parity extension:** update `audit_projection_parity.json` with the new
    breakdown columns/keys; both `audit-projection-parity` tests stay green.
  - **Apply-mode fixture:** a live-applied job, a manually-marked job, and a
    dry-run job → assert the dry-run is excluded from the denominator and the
    other two land in the correct `byApplyMode` buckets.
- **Local QA path.** `pnpm api:test` + Python pytest for parity/derivation;
  load the dashboard and confirm a single-application source shows a count with
  `too few to rate`, not a percentage.
- **Phase gate.** Parity green in both runtimes; small-sample fixture proves
  count-only below threshold; `/v1/analytics/outcomes` returns gated rates;
  `ConversionPanel` no longer renders sub-threshold percentages; read-only guard
  test green.

---

### Phase 2 — Analytics UI surface

**Objective.** A dedicated analytics view that presents the Phase 1 read model
per the frontend architecture, with the small-sample and non-causal rules
rendered exactly per §3.1.

- **Source of truth.** The Phase 1 `OutcomeAnalyticsSummary` (never re-computed
  client-side; rates arrive already gated).
- **Owning bounded context.** Operations owns the read hook; a new **view**
  composes it. Views are not contexts (`docs/architecture/frontend/contexts.md:478`).
- **Projection / read model.** Consumed via a new Operations hook
  `useOutcomeAnalyticsQuery` (`apps/web/src/contexts/operations/hooks/`), keyed by
  a new `analyticsKeys` factory (`contexts/operations/analyticsKeys.ts`,
  re-exported through `contexts/operations/queryKeys.ts` per
  `docs/architecture/frontend/patterns.md` §4.1). Shape:
  `["tenant", tenantId, "analytics", "outcomes", filters] as const`.
- **API + contract.** No new endpoint; reuses Phase 1.
- **UI surface.** New `apps/web/src/views/analytics/` (a ninth view sibling of the
  existing eight): `AnalyticsView.tsx`, `OutcomeRateTable.tsx` (uses the shared
  `FilterableDataGrid`, `docs/architecture/frontend/patterns.md:331`),
  `DimensionBreakdownPanel.tsx`, and `SmallSampleNotice.tsx` (renders the §3.1
  caption). New route `routes/analytics.tsx` with a Zod search schema for the
  selected dimension/filters (URL state, not `useState`). Dimension badges reuse
  context-owned components where they exist (`<ScoreBadge>` from `scoring/`,
  `<ApplyRunBadge>` from `apply/`). SSE freshness: register invalidation handlers
  so `ApplicationSubmitted`, `ApplicationFailed`,
  `ApplicationEmailFeedbackIngested`, and MarkApplied events invalidate
  `analyticsKeys` (`docs/architecture/frontend/realtime.md`, invalidation router).
- **Approving user action.** None (read-only view).
- **Invariant proven.** §3.1 rendering (count-only below threshold; `n` always
  adjacent; caption present); denied-word lint/test on view copy; a11y bar (zero
  critical/serious axe) on the new table/panels.
- **Synthetic regression fixtures.** Hook test for `useOutcomeAnalyticsQuery`
  (success + error) with MSW; component test that a below-threshold row shows
  `too few to rate` and no `%`; Storybook stories (loading / populated / empty /
  small-sample) with the a11y addon; a copy test asserting no denied words appear
  in rendered headings/captions.
- **Local QA path.** `pnpm --filter @jobhunter/web test`, `test-d`, `build`,
  `web:storybook:test`; an e2e smoke (`apps/web/e2e/tests/analytics.spec.ts`):
  navigate to `/analytics`, confirm a small group shows counts without a
  percentage and the non-causal caption is present.
- **Phase gate.** View renders gated rates + caption; hook/component/story/a11y
  tests green; invalidation router updates analytics on outcome events;
  denied-word test green.

---

### Phase 3 — Side-by-side artifact comparison in review

**Objective.** Let the user compare two resume artifacts/generations
side-by-side — accepted vs current draft, or template A vs template B — with
coverage deltas, risk labels, and validator/judge deltas, computed from canonical
coverage rows (no re-inference). Outcomes are **not** joined yet (Phase 4).

- **Source of truth.** `job_materials` / `job_materials_artifacts` generations
  (`database.py:1623,1640`); accepted = `ArtifactStatus` `approved`, draft =
  `candidate` (`value_objects.py:51`); coverage from
  `artifact_list_projections.coverage_audit_json` (projected from
  `job_bullet_provenance.coverage_json`, computed against rendered voiced text by
  `compute_keyword_coverage`, `coverage_audit.py:165`); risk labels from
  `resume_review_comment_threads.risk_label` (`resume-review-drafts.ts:215`);
  validator/judge from `job_materials.last_validation_json` / `last_verdict_json`;
  template identity from artifact `metadata_json.resume_template`; coverage basis
  label `grounded_shipped_text_v1` vs `judge_claimed_legacy`
  (`docs/architecture/tailoring.md`).
- **Owning bounded context.** Materials Generation owns the comparison components
  and the pure coverage-delta selector; Operations owns the artifact read hooks
  (`useArtifactDetailQuery` already exists). Composed by the Apply Review and
  Artifacts **views**.
- **Projection / read model.** Prefer a **pure selector** over already-projected
  data: `contexts/materials/selectors/compareCoverage.ts` computes the delta
  (keywords newly covered, coverage lost, still missing) as set differences over
  the two `coverageAudit` payloads (`BulletCoverageAudit`,
  `packages/contracts/src/schemas.ts:2399`). Only if two generations' coverage
  cannot both be read from existing projections/detail endpoints does a thin read
  endpoint get added; default is selector-over-existing-reads.
- **API + contract.** Reuse artifact detail reads; a `CoverageDelta` /
  `ArtifactComparison` type in contracts describes the selector output. No new
  write endpoints.
- **UI surface.** `contexts/materials/components/ArtifactComparison.tsx` +
  delta chips (`+covered`, `−lost`, `missing`), risk-label diff, judge/validation
  verdict diff. Composed in `views/apply-review/` (accepted vs current draft,
  beside the existing Plate editor + grounding-risk panel) and in
  `views/artifacts/` (pick two generations / templates). Reuses the Materials
  tailoring inspector primitives (`<TailoringExplanationSection>`,
  `<BulletProvenanceList>`, `<ArtifactGroundingRiskPanel>`).
- **Approving user action.** The existing apply-review `approve_submit` decision
  (`POST /v1/jobs/:jobKey/apply-review/decision`,
  `recordApplyReviewDecision`, `application-feedback.ts:357`) — comparison
  *informs* it and adds no new approval. Comparison must never suppress the last
  accepted artifact until a replacement is approved (Invariant 5).
- **Invariant proven.** Coverage delta computed from actual rendered-text
  coverage buckets, never from job keywords; missing list preserved and labelled;
  when one side has no recorded coverage, the surface shows `coverage not
  recorded` rather than implying zero coverage.
- **Synthetic regression fixtures.** Two generations (approved gen N + candidate
  gen N+1) with known covered/declared/missing sets → assert the delta equals the
  exact set differences; a fixture where the draft has no `coverage_audit_json` →
  asserts `coverage not recorded` (not `0%`); a template-A-vs-B fixture across two
  accepted generations with different `templateId`. Selector unit tests +
  component test + Storybook per state.
- **Local QA path.** `pnpm --filter @jobhunter/web test` + `web:storybook:test`;
  e2e in apply-review: open comparison, verify deltas and risk labels; confirm the
  currently-accepted artifact stays visible while a draft is compared.
- **Phase gate.** Comparison renders accurate coverage deltas + risk/verdict
  diffs from canonical rows; accepted artifact never suppressed; fixtures +
  a11y green.

---

### Phase 4 — Close the outcome loop (materials/template/policy ↔ outcomes)

**Objective.** Make the recorded-but-unread outcome data visible: associate
resume template and tailoring policy with recorded outcomes, surface
time-to-response and classifier-suggestion accuracy, and connect artifact
comparison to observed outcomes — all descriptive, gated, and traceable.

- **Source of truth.** Applied `job_list_projections` rows × their outcomes
  (`application_outcomes.kind`) × the **accepted generation's** template + policy
  (`job_materials.metadata_json.resume_template.templateId` /
  `tailoring_policy_version` for the job's `load_current_approved` generation,
  `sqlite_repository.py:128`). Time-to-response = `application_outcomes.occurred_at`
  − `applied_at`. Suggestion accuracy = decided `application_outcome_suggestions`
  rows.
- **Owning bounded context.** Operations owns the extended read model and the
  join; Apply and Materials own the facts. No context imports another's
  hooks/stores (`docs/architecture/frontend/index.md:261`).
- **Projection / read model.** Project the applied job's accepted-generation
  `template_id` and `tailoring_policy_version` onto a groupable surface
  (denormalised columns on `job_list_projections`, dual DDL + both builders +
  fixture per Invariant 6), then extend the outcome computation with `byTemplate`
  and `byPolicy` breakdowns and a time-to-response aggregate (median + count,
  gated by `MIN_RATE_SAMPLE_N`). Add a suggestion-accuracy aggregate over decided
  suggestions. Keep everything integer/duration-count in the projection; derive
  rates and medians at read time.
- **API + contract.** Extend `OutcomeAnalyticsSummary` with `byTemplate`,
  `byPolicy`, `timeToResponse`, and `suggestionAccuracy`; optionally surface an
  applied job's accepted template/policy in its detail read so the comparison view
  can annotate "this template's observed response association (n=…)".
- **UI surface.** Analytics view (Phase 2) gains "By resume template" and "By
  tailoring policy" panels and a time-to-response panel, all under the §3.1 rules.
  The Phase 3 comparison may show a template's observed response association only
  when `n >= MIN_RATE_SAMPLE_N`, phrased as association, never recommendation.
- **Approving user action.** None (read-only). Outcome and suggestion decisions
  remain user-gated.
- **Invariant proven.** Read-only (never feeds scoring/apply eligibility);
  small-sample gating on template/policy/time-to-response; non-causal copy; every
  number traceable (template from the accepted generation metadata, response from
  `application_outcomes`, timing from `occurred_at`/`applied_at`).
- **Synthetic regression fixtures.** Applied jobs split across two templates with
  differing outcomes → `byTemplate` counts correct and rates gated; a policy-split
  fixture; a time-to-response fixture (assert median + count, gated); a
  suggestion-accuracy fixture (accepted/corrected/ignored → precision numerator
  and denominator correct); parity fixture updated for the new projected columns.
- **Local QA path.** Full `pnpm test` + Python pytest + web suites; e2e:
  record outcomes across templates in a seeded DB, confirm the analytics view
  shows gated per-template associations and the comparison view annotates observed
  association only above threshold.
- **Phase gate.** Loop demonstrably closed for template/policy/time-to-response/
  suggestion-accuracy (each visible, gated, traceable); parity green; read-only
  guard green; docs updated (§8).

## 6. What "closing the loop" means here (explicit)

Recorded-but-unread today → made visible by this plan:

- **Template ↔ response, policy ↔ response** → Phase 4 `byTemplate` / `byPolicy`.
- **`occurred_at` / `recorded_at`** → Phase 4 time-to-response.
- **`application_outcome_suggestions` decisions** → Phase 4 suggestion accuracy.
- **Artifact coverage vs outcome** → Phase 3 comparison + Phase 4 association.

Explicitly **left open** (non-goal, §11): feeding `tailoring_feedback_signals`
back into generation, and any automated action taken on an association (the
read-only invariant forbids it).

## 7. Verification Commands (CLAUDE.md matrix)

Run the touched-surface subset per phase; run the full set before declaring any
phase done.

- Cross-stack typecheck + lint: `pnpm check`
- Cross-stack tests: `pnpm test` (API Vitest + web build + Python pytest)
- API tests (parity, projections, read model, new endpoint):
  `pnpm api:test`
- Web unit/hook/component (new hooks, view, comparison, small-sample):
  `pnpm --filter @jobhunter/web test`
- Web type-level: `pnpm --filter @jobhunter/web test-d`
- Web build: `pnpm --filter @jobhunter/web build`
- Storybook + a11y: `pnpm web:storybook:test`
- Web e2e (analytics + comparison smoke): `pnpm --filter @jobhunter/web e2e`
- Python tests (outcome conversion + parity + new derivation):
  `uv --project workers/automation run --extra dev pytest -q`
- Python lint: `uv --project workers/automation run --extra dev ruff check .`
- Docs dead-link gate (after doc updates): `pnpm docs:build`

## 8. Documentation Updates Required

Per `CLAUDE.md` doc table — update only the owning documents, narrowly:

- `docs/architecture/read-model.md` — new analytics read model, dimension list,
  small-sample invariant, dual-writer note, `costPerInterview` status.
- `docs/local-ts-api.md` — `GET /v1/analytics/outcomes` and any detail-read
  additions.
- `docs/architecture/frontend/` — the new `views/analytics/` composer, the
  `useOutcomeAnalyticsQuery` hook, `analyticsKeys`, and comparison components
  (`contexts.md`, `patterns.md`, `structure.md`, `testing.md`).
- `docs/local-reliability-qa.md` — regression-matrix entries for the small-sample
  rule and artifact comparison; the manually-verified product paths.
- `docs/architecture/tailoring.md` / `docs/architecture/materials.md` — cite the
  comparison surface's coverage-basis source (no contract change expected).
- `README.md` (+ `docs/user/` as needed) — user-facing analytics view and
  artifact comparison, framed descriptively.
- `docs/decisions.md` — an ADR recording: analytics is read-only + small-sample
  invariant + the band-vocabulary decision (D2) + apply-mode derivation (D4).

## 9. Definition of Done

- All four goals delivered behind the four phase gates; each phase's fixtures
  (including the **small-sample fixture** and the **coverage-delta fixture**)
  green.
- Every displayed metric traceable to a canonical row (Invariant 2), proven by
  tests; a read-only guard test proves analytics does not feed
  scoring/ranking/apply eligibility (Invariant 1).
- Cross-runtime parity green (`audit-projection-parity` in both runtimes) after
  each projection change.
- No sub-threshold percentage renders anywhere; `n` always adjacent to any rate;
  the non-causal caption present; denied-word test green.
- Full verification matrix (§7) green for touched surfaces; docs (§8) updated and
  `pnpm docs:build` passes.
- `pr-reviewer` returns `Gate: PASS` and `qa` returns `Gate: PASS` (no open
  Blocker/High findings) per `CLAUDE.md`.

## 10. Non-Goals

- Feeding `tailoring_feedback_signals` back into resume generation (separate
  initiative; consumption is out of scope — visibility of recorded counts only).
- Any automated action, recommendation, or scoring/ranking/apply-eligibility
  effect derived from analytics (forbidden by Invariant 1).
- Cost-per-interview and cost-based analytics unless D5 is approved (no per-run
  cost is projected today; `costPerInterview` stays `null`).
- Role-family grouping unless D3 is approved (no per-job role family is persisted
  today).
- Hosted/multi-tenant analytics, external export, or a warehouse. Everything
  stays local-first and tenant-first-keyed per existing conventions.
- Changing the outcome classifier or the Gmail scan (`feedback.py`); this plan
  only reads its outputs.

## 11. Risks And Mitigations

- **Dual-writer drift.** New projected columns can diverge between runtimes.
  *Mitigation:* Invariant 6 — every projection change updates both builders + the
  parity fixture; CI parity tests fail otherwise.
- **Small-sample misuse.** A single reply reads as a "100% template."
  *Mitigation:* Invariant 3 gating in the read-model contract (rate `null` below
  threshold) so the client cannot render it; small-sample fixture is required.
- **Causal misreading.** Users infer a template "causes" interviews.
  *Mitigation:* §3.1 denied-word list + persistent caption + volume-default
  ordering + a copy test.
- **Band-vocabulary confusion.** Two band vocabularies (§2.3) mislabel groups.
  *Mitigation:* D2 resolves and the ADR records the choice; labels are explicit.
- **Template/policy attribution ambiguity.** The accepted generation may change
  after apply. *Mitigation:* attribute to the accepted generation at apply time;
  document the attribution rule; keep re-tailors as audit history.
- **Sensitive data leakage.** Analytics must not surface raw email bodies, notes,
  or paths. *Mitigation:* read only counts + safe identifiers; reuse the existing
  safe-summary boundary (`docs/architecture/read-model.md:113-117`); a test
  asserts no `note`/`body_text` reaches the analytics response.
- **Low data volume (single user).** Most breakdowns start below threshold.
  *Mitigation:* counts-only rendering is the designed default, not a failure
  state; empty/small states are first-class in UI + stories.

## 12. Open Owner Decisions

- **D1 — `MIN_RATE_SAMPLE_N` value.** Recommend default **5** (single-user apply
  volume is low; a rate off `n<5` is noise). Precedent: source-quality gates rates
  at `sample >= 10` (`source_quality.py:433`), but that is higher-volume
  discovery data. One shared constant governs read model + UI. *Owner: confirm 5
  vs 10 (or per-dimension).*
- **D2 — Band vocabulary.** Recommend keeping the existing parity-guarded
  `SCORE_BAND_ORDER` for the outcome breakdown but **labelling it "score band"**,
  and (optionally) adding a separate canonical "fit band" breakdown from
  `job_requirement_fit_reports.fit_band`. *Owner: one vocabulary or both, and the
  visible label.*
  **Decision 2026-07-05:** expose **both** vocabularies as separate analytics
  dimensions. Keep the existing parity-guarded `SCORE_BAND_ORDER` breakdown under
  a `scoreBand` / "score band" label, and add a separate canonical
  `fitBand` / "fit band" breakdown sourced from
  `job_requirement_fit_reports.fit_band`. Do not merge, rename, or coerce one
  vocabulary into the other.
- **D3 — Role family.** Net-new: no per-job role family is persisted. Recommend
  **defer** (non-goal for v1); if wanted, derive from title via the existing
  `role_title_matcher` / `ROLE_FAMILY_MARKERS` and persist a `role_family` on the
  job projection, accepting classification-accuracy risk. *Owner: defer vs build.*
- **D4 — Apply-mode definition.** Recommend `apply_mode ∈ {automated_live,
  manual_marked, external_confirmed}` (from non-dry-run apply run success /
  MarkApplied / `applied_confirmation` outcome without an apply run), dry-runs
  excluded. *Owner: confirm the buckets and the precedence when multiple apply.*
  **Decision 2026-07-05:** use
  `apply_mode ∈ {automated_live, manual_marked, external_confirmed}`. Exclude
  dry-runs. When multiple apply signals exist for one job, classify by precedence:
  non-dry-run apply run success as `automated_live`, then MarkApplied as
  `manual_marked`, then an `applied_confirmation` outcome without an apply run as
  `external_confirmed`.
- **D5 — Cost analytics.** No per-run apply cost is projected. Recommend **v1
  non-goal** (`costPerInterview` stays `null`); if wanted, add a cost column to
  `apply_run_projections` fed from apply run token/cost telemetry, then aggregate.
  *Owner: defer vs build.*
- **D6 — Endpoint shape.** Recommend a dedicated `GET /v1/analytics/outcomes`
  (keeps the dashboard summary payload bounded and gives the analytics view its
  own query key) over extending `DashboardSummary.conversion`. *Owner: confirm.*
  **Decision 2026-07-05:** use the dedicated
  `GET /v1/analytics/outcomes` endpoint with its own Operations query key. Do not
  extend `DashboardSummary.conversion` with the full analytics payload.

## 13. Anchor Appendix (verified against `main` @ `a488e4e9`)

**Backend — outcomes & conversion**
- `apps/api/src/application-feedback.ts` — `application_outcomes:146`,
  `application_outcome_suggestions:187`, `recordApplyReviewDecision:357`,
  `listApplicationOutcomes:405`, `recordManualApplicationOutcome:433`,
  `decideOutcomeSuggestion:452`.
- `apps/api/src/projections.ts` — `SCORE_BAND_ORDER:2394`, `scoreBand:2417`,
  outcome-kind sets `:2397-2400`, `buildOutcomeConversion:2448`,
  `rebuildDashboardProjection:2497`, `ensureProjectionTables:429`.
- `apps/api/src/read-model.ts` — `buildDashboardSummary:351`,
  `buildConversionSummary:3483`, `conversionFunnelMetrics:3506`,
  `conversionRate:3527` (no min-`n` gate), `costPerInterview` null `:3523`,
  outcome audit entries `:908`.
- `packages/contracts/src/schemas.ts` — `DashboardConversionFunnel:2125`,
  `DashboardConversionSummary:2138`, outcome kinds `:1008`, sources `:1022`,
  `BulletCoverageAudit:2399`.
- Python: `projection_builder.py` — `_build_outcome_conversion:1653`,
  `_load_outcome_kinds_by_job:1710`, `_score_band:280`, kind sets `:272-277`,
  `_derive_apply_status:2990`; `sqlite_projection_store.py` — projection DDL
  (`dashboard_projections:143`, `apply_run_projections:213`,
  `workflow_run_projections:233`, `source_quality_stats:258`,
  `operational_attempt_metrics:288`); `feedback.py` — `application_outcomes:265`,
  `classify_outcome:330`, `LINK_THRESHOLD` `:22`.
- Parity: `packages/domain-types/test/fixtures/audit_projection_parity.json`;
  `apps/api/test/audit-projection-parity.test.ts`;
  `workers/automation/tests/test_audit_projection_parity.py`;
  `workers/automation/tests/test_dashboard_projection.py:400`.

**Backend — materials, coverage, scoring**
- `workers/automation/src/jobhunter/database.py` — `job_materials:1623`,
  `job_materials_artifacts:1640`, resume-template tables `:1724`,
  `job_bullet_provenance` (+`coverage_json`) `:2095,2140`,
  `job_requirement_fit_reports.fit_band:1392`, `tailoring_policies:1509`.
- `.../domain/materials/aggregate.py` `MaterialsSet:78`, `next_generation:494`;
  `.../value_objects.py` `ArtifactStatus:51`, `ArtifactType:38`;
  `.../coverage_audit.py` `compute_keyword_coverage:165`;
  `.../use_cases.py` template/policy/coverage metadata `:1581-1652`;
  `.../infrastructure/materials/sqlite_repository.py`
  `load_current_approved:128`, `resolve_effective_resume_template:163`.
- `.../domain/scoring/value_objects.py` `FIT_BANDS:48`, `fit_band_for_score:130`.
- `apps/api/src/resume-review-drafts.ts` `tailoring_feedback_signals:249`,
  `resume_review_comment_threads.risk_label:215`.

**Frontend**
- Views dir `apps/web/src/views/` (8 today); contexts `apps/web/src/contexts/`
  (8 today); Operations read hooks `contexts/operations/hooks/`
  (`useDashboardSummaryQuery`, `useApplicationOutcomesQuery`,
  `useArtifactDetailQuery`, …); query-key registry `contexts/operations/queryKeys.ts`;
  `views/dashboard/ConversionPanel.tsx`; Apply `contexts/apply/components/ApplicationOutcomes.tsx`.
- Conventions: `docs/architecture/frontend/contexts.md`, `patterns.md`,
  `realtime.md`, `testing.md`, `structure.md`.

## Delivery Model: Stacked PRs On This Plan

Implement this plan as a series of stacked PRs that begin on this plan's
branch:

- The first implementation PR uses this plan PR's branch as its base; each
  subsequent PR stacks on the previous one. One reviewable concern per PR;
  Conventional Commit titles.
- As a parent merges, retarget the next PR to `main` before merging it
  (retarget-before-merge; never merge a PR whose base branch is already
  merged and deleted).
- If this plan PR has already merged to `main`, start the stack from `main`
  instead — the instruction is "stack on the plan", not "recreate it".
- Each PR states which plan phase it delivers and runs that phase's
  verification commands from this plan before requesting review.
- Do not begin implementation while this plan's stated gates or
  dependencies are unmet.
