# Phase 21: Jobs Triage UX & Warning-Only Floor - Context

**Gathered:** 2026-06-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 21 renders the compensation facts already added to the canonical Jobs list/detail read models. It adds Jobs table scan columns and a Jobs drawer compensation audit section so users can inspect posted salary, company-role market estimate state, confidence, warnings, source trail, assumptions, unavailable-source reasons, and profile-floor comparison.

This phase is presentation and warning semantics only. It must not add salary-based ranking, filtering, scoring, apply readiness, hard blockers, apply dispatch changes, market-data fetching, profile preference editing, or compensation fact correction flows.

</domain>

<decisions>
## Implementation Decisions

### Jobs List Compensation Scan
- **D-01:** The Jobs table should use separate `Posted`, `Market`, and `Warnings` columns rather than one combined compensation column.
- **D-02:** When both posted and market data exist, the conceptual priority is posted salary first because it is the employer-provided claim; market estimate is comparison context.
- **D-03:** Missing or unsupported values in the table should render as compact minimal dashes visually, not long explanatory labels. The dash must still be backed by accessible labels, titles, or drawer detail so missing salary and unsupported states are not silent omissions.
- **D-04:** On mobile and narrow widths, keep the separate compensation columns and rely on the existing table horizontal scroll rather than collapsing them into one responsive summary column.
- **D-05:** Compensation table fields are display-only in v1.3. Do not add salary sorting, salary filtering, ranking changes, fit-score effects, apply-readiness changes, blockers, or dispatch gates.

### Drawer Compensation Audit Layout
- **D-06:** Add a dedicated compensation audit section immediately after `JobAuditTriage` in `JobDetailDrawer`, before description, actions, diagnostics, artifacts, and history.
- **D-07:** The drawer section should use a summary-plus-evidence structure: a top summary for posted, market, and floor comparison followed by evidence details.
- **D-08:** Source trail, confidence factors, assumptions, and detailed reasons should use progressive disclosure. The main section should stay scannable, with expanded rows/details for factor/source detail.
- **D-09:** Drawer missing states must be explicit. Explain no posted salary, insufficient evidence, unsupported market estimate states, source unavailable states, and unavailable-source reasons in the drawer even when the table uses compact dashes.

### Warning-Only Profile Floor
- **D-10:** Phase 21 must keep profile-floor comparison in scope to satisfy UI-03 and UI-04.
- **D-11:** Use only the existing numeric profile compensation minimum for floor comparison. Do not parse free-text salary expectations in this phase.
- **D-12:** If no numeric profile compensation minimum exists, show a muted `not configured` floor state in the drawer and keep the list warning count unchanged.
- **D-13:** When posted salary and market estimate both exist, show each comparison basis separately. The UI must tell the user whether the floor concern used posted salary, market estimate, both, or neither.
- **D-14:** Floor comparison can contribute to compensation warnings and the Jobs list warning count, and can appear inside the drawer compensation audit section. It must never appear as an Apply concern, missing prerequisite, hard blocker, apply-readiness state, fit-score factor, ranking input, filter input, or apply dispatch condition.

### Carry Forward From Prior Phases
- **D-15:** `JobSummary.salary` remains the raw discovery string for compatibility; structured compensation data is additive and preferred for new UI.
- **D-16:** Posted compensation facts and reported company-role market estimates remain visually and semantically separate in every surface.
- **D-17:** Levels.fyi and Glassdoor automated access remains disabled unless permitted access exists. Phase 21 must not add fetch, scrape, cache, import, credential, or provider network paths.
- **D-18:** Safe event/read-model payload boundaries from Phase 20 remain binding: no source text beyond allowed excerpts, no private preferences beyond safe comparison facts, no credentials, no local paths, and no unsafe provider payloads in UI fixtures, logs, stories, or events.

### the agent's Discretion
- Choose component names, exact microcopy, iconography, and CSS class names that match the existing Jobs drawer and table conventions.
- Choose whether progressive disclosure uses native `details`, an existing shared disclosure primitive, or a small context-owned component, provided accessibility and mobile layout are verified.
- Choose exact warning labels and ordering, provided posted, market, and floor basis remain distinguishable and no warning is promoted into apply readiness or blockers.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/ROADMAP.md` - Phase 21 goal, dependency on Phase 20, UI requirements, and success criteria.
- `.planning/REQUIREMENTS.md` - UI-01 through UI-06, QA safety boundaries, and out-of-scope compensation behavior.
- `.planning/PROJECT.md` - v1.3 product direction, auditability constraints, warning-only compensation behavior, and local-first safety boundaries.
- `.planning/STATE.md` - latest active milestone state and carried-forward v1.3 decisions.

### Prior Phase Contracts
- `.planning/phases/20-canonical-read-model-realtime-api/20-CONTEXT.md` - additive `compensationSummary` and `compensationAudit` read-model contract, SSE safety, and explicit UI handoff to Phase 21.
- `.planning/phases/19-europe-public-market-estimates/19-CONTEXT.md` - market estimate states, confidence factors, reported-source constraints, and warning semantics.
- `.planning/phases/18-posted-compensation-facts/18-CONTEXT.md` - posted compensation parse states, raw fallback, source text, warnings, and no-gating boundary.

### Frontend Architecture And QA
- `docs/frontend-target.md` - frontend bounded-context, view composer, Operations query hook, SSE invalidation, and testing conventions.
- `docs/local-reliability-qa.md` - local QA expectations and browser/product-path verification bar.
- `docs/local-ts-api.md` - local TypeScript API/web verification and SSE contract context.
- `docs/architecture.md` - TypeScript API, React app, projection-backed read model, and local-first boundaries.
- `docs/decisions.md` - ADRs for TanStack, frontend ports, view/context split, and SSE invalidation router.

### Codebase Maps
- `.planning/codebase/CONVENTIONS.md` - naming, frontend style, hook, port, and testing conventions.
- `.planning/codebase/STRUCTURE.md` - Jobs view, route, context, shared UI, contracts, and read-model file locations.
- `.planning/codebase/STACK.md` - React/Vite/TanStack/Tailwind stack, verification commands, and package boundaries.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/src/views/jobs/columns.tsx`: owns the Jobs table column model; Phase 21 should add the separate `Posted`, `Market`, and `Warnings` columns here.
- `apps/web/src/views/jobs/JobsTable.tsx`: composes `FilterableDataGrid` and already supports table horizontal scroll, row activation, sorting, filtering, and pagination.
- `apps/web/src/views/jobs/JobDetailDrawer.tsx`: owns the drawer composition; the compensation audit section should be inserted immediately after `JobAuditTriage`.
- `apps/web/src/views/jobs/JobAuditTriage.tsx`: existing audit surface for ranking/readiness/apply concerns; compensation should remain a sibling section, not be folded into apply concerns.
- `apps/web/src/shared/ui/section.tsx`, `apps/web/src/shared/ui/title-stack.tsx`, `apps/web/src/shared/ui/badge.tsx`, `apps/web/src/shared/ui/status-dot.tsx`, and tag styles in `apps/web/src/styles/globals.css`: likely primitives/style patterns for compact scan cells and drawer evidence rows.
- `apps/web/src/contexts/operations/hooks/useJobsListQuery.ts` and `apps/web/src/contexts/operations/hooks/useJobDetailQuery.ts`: existing read paths for `JobSummary.compensationSummary` and `JobDetail.compensationAudit`.

### Established Patterns
- Views compose context components and Operations hooks; feature data loading must not call `useQuery`, `apiClient`, `EventSource`, or browser APIs directly from view code.
- Context-owned reusable UI should live under `apps/web/src/contexts/<context>/components/`; view-only composition can stay under `apps/web/src/views/jobs/`.
- Table cells already use compact components like `ScoreBadge`, `StageBadge`, `ApplyRunBadge`, `TitleStack`, and `RelativeTime`; compensation scan cells should follow that dense operational style.
- Existing drawer audit sections use full-width `section` blocks and compact tags; avoid nested cards and avoid turning the drawer into a marketing layout.
- Story/test conventions are colocated: component/unit tests next to source, a11y tests as `*.a11y.test.tsx`, and Storybook stories as `*.stories.tsx`.

### Integration Points
- `packages/contracts/src/schemas.ts` defines `JobCompensationSummary`, `JobCompensationAudit`, `JobPostedCompensationSummary`, `JobMarketCompensationSummary`, and profile compensation fields.
- `apps/api/src/read-model.ts` and `apps/api/src/projections.ts` are Phase 20 read-model/projection owners; Phase 21 should consume the existing fields rather than adding React-side parsing.
- `apps/api/src/profile-store.ts` stores profile compensation minimum/maximum fields; the floor comparison should use only a numeric minimum if already exposed or add a safe read-model field through the owning API path during planning.
- `apps/web/src/styles/globals.css` already contains table, drawer, tag, warning, and source-registry styles that can be reused or extended narrowly.

</code_context>

<specifics>
## Specific Ideas

- The Jobs list should be comparison-oriented: separate `Posted`, `Market`, and `Warnings` columns let the user scan compensation evidence across rows.
- The drawer should be the explicit audit surface: it must explain states that the row intentionally keeps terse.
- The floor comparison must be visibly warning-only. It can be a compensation warning, but it must not become an Apply concern.
- Existing unpackaged sketches under `.planning/sketches/` point toward dense, inspectable, calm audit surfaces; there is no packaged sketch-findings skill yet.

</specifics>

<deferred>
## Deferred Ideas

- None - discussion stayed within phase scope.

</deferred>

---

*Phase: 21-Jobs Triage UX & Warning-Only Floor*
*Context gathered: 2026-06-20*
