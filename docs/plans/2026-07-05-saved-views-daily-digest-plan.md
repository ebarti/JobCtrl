# Saved Table Views + Daily Local Digest Implementation Plan

> **Status:** Proposed (not implemented). Two operator-productivity features
> planned together because both are read-side, local-first, and both compose
> the existing Jobs table / dashboard surfaces.

> **Anchors verified against main @ `a488e4e9`.** Every path, symbol, table,
> route, and line number cited below was checked against this worktree's HEAD.

> **For implementers:** You are a capable agent at high reasoning effort. This
> plan specifies objectives, invariants, contracts, and acceptance gates — not
> step-by-step edits. Choose the smallest changeset that satisfies every gate
> and respects the architecture in `docs/architecture/frontend/` and
> `docs/decisions.md`. Do not silently broaden scope; if the correct fix
> exceeds the scope here, stop and raise it.

## Goal

Two features, one plan:

1. **Saved table views** — persist named, reusable view configurations
   (visible columns, column order, column widths, density, sort, filters,
   grouping, color rules) for high-density operational tables, delivered first
   on the Jobs table, with a quick view switcher in the table toolbar. Honors
   the existing backlog entries under `docs/backlog.md` "UI Quality" ("Add
   saved table views for high-density operational tables, starting with
   Discovery source registry and Jobs" and "Add configurable jobs-table
   columns").

2. **Daily local digest** — a once-a-day, locally-computed operator summary
   (new matches, blocked/degraded sources, review-needed materials, stale
   scores, pending apply approvals, follow-ups due, budget usage) delivered
   **local-only** via a dashboard panel and a `jobhunter digest` CLI command,
   with each item deep-linking into the relevant view.

### Product invariants (both features)

- **One source of truth per fact** (`docs/architecture/frontend/index.md` §"One
  source of truth per fact"; `state-and-ports.md` §5.1). A datum never lives in
  two state layers simultaneously.
- **Local-first, no-strangler** (`docs/decisions.md` 2026-05-01; user memory:
  no compatibility shims). Both features are additive to existing engines and
  read models; do not rip out the URL-backed Jobs filter/sort state.
- **Auditable, canonical sourcing** (`CLAUDE.md` "Root-Cause And Auditability
  Discipline"). Every digest number is computed from a canonical read model
  cited in this plan; nothing is faked, inferred from the wrong source, or
  suppressed. Where a datum has no honest source today, this plan defines the
  read model to add rather than fabricating the value.

## Scope and non-goals

**In scope**

- Saved views on the **Jobs table** (`apps/web/src/views/jobs/`) via additive
  capability in the shared table engine
  `apps/web/src/shared/ui/filterable-data-grid.tsx`, designed so the Discovery
  source registry table is the next adopter with no engine rework.
- A daily digest **contract**, its **read model(s)**, a **dashboard panel**, and
  a **`jobhunter digest` CLI command**, plus a **digest watermark** ("seen"
  state).

**Non-goals (explicit)**

- **No external digest delivery of any kind** — no email, push, webhook, SMS,
  desktop notification, or third-party integration. Delivery is a local
  dashboard panel and/or local terminal output only. This is a hard invariant,
  not a phase-1 cut.
- **No new enabled-by-default schedule.** The digest is on-demand. Scheduled
  computation, if ever added, must follow the default-off Temporal Schedule
  posture (`docs/decisions.md` 2026-07-03 "DiscoverWorkflow And Default-Off
  Temporal Schedules"; `workers/automation/src/jobhunter/config.py:67`,
  `scheduling_enabled=False`) and is an owner decision below, not part of this
  scope.
- **No server-side / cross-device sync of saved views** in this scope (owner
  decision below). Saved views persist per local browser profile.
- **No new user-scheduled reminder system** (create/snooze/edit reminders with
  arbitrary due dates). "Follow-ups due" is a defined derived read over
  existing outcome data; a first-class reminder aggregate is an owner decision.
- No changes to auto-apply, browser submission, or any spendful behavior.

## Grounding: how the Jobs table and dashboard work today

### Jobs table state (verified)

The Jobs table splits its state across two layers today, and this split is the
starting point the saved-views feature must respect.

- **URL layer** — `apps/web/src/routes/-jobs.search.ts` (`jobsSearchSchema`)
  owns `q`, `stage`, `state`, `applyStatus`, `deleted`, `sort`, `dir`, `page`,
  `pageSize`, `minFitScore`, `maxFitScore`. The route
  `apps/web/src/routes/jobs.tsx` prefetches from these via
  `jobsKeys.list(tenantId, input)`. This matches the canonical decision matrix
  in `state-and-ports.md` §5.1 (filters/sort/page are URL state:
  "Bookmarkable; survives refresh; copy-paste shareable").
- **Component layer** — `apps/web/src/views/jobs/JobsView.tsx:175-179` holds
  `rowSelection`, `allMatchingSelected`, `localTableFilters`
  (`DataGridFilterState` not represented in the URL), and `visiblePageKeys` in
  `useState`. `JobsView` maps the URL-backed `stage`/`state`/`applyStatus` and
  the local grid filters into one `tableFilters` object
  (`JobsView.tsx:181-192`) fed to the grid.
- **Deep-link precedent** — `apps/web/src/views/dashboard/KpiGrid.tsx`
  (`kpiSearchFor` / `kpiHrefFor`) builds `/jobs?…` URLs; this is the exact
  pattern digest deep-links reuse.

### Shared table engine capabilities and gaps (verified)

`apps/web/src/shared/ui/filterable-data-grid.tsx` (`FilterableDataGrid`,
`DataGridColumn<TData>` at lines 45-62) is the Jobs table engine (Jobs uses it
via `apps/web/src/views/jobs/JobsTable.tsx`; the shadcn `data-table.tsx`
wrapper over `@tanstack/react-table` is unused).

| Dimension | Today | Gap for saved views |
|---|---|---|
| Sort | Controlled (`sort`/`onSortChange`, `manualSorting`) | none — reuse |
| Filters (text `contains`/`does_not_contain` + distinct-value multi-select) | Controlled (`filters`/`onFiltersChange`), `DataGridTextFilter` lines 34-38 | none — reuse; matches backlog "contains / does not contain + multi-select" ask |
| Column widths | Tracked in `columnWidths` `useState` (line 374), resizable, **ephemeral** (reset on remount) | must be capturable/restorable by a view |
| Toolbar slot | `toolbarActions` prop (line 112, rendered line 682) | view switcher mounts here |
| Column **visibility** | none | **add** |
| Column **order** | fixed by `columns` array order | **add** |
| Per-table **density** | none (density is global, see below) | **add** as per-table override |
| **Grouping** | none | **add** |
| **Color rules** | `rowClassName` + per-column `className` exist, no rule engine | **add** rule → semantic-token mapping |

Density today is a **global** client preference: `useUiPreferencesStore`
(`apps/web/src/shared/stores/ui-preferences.ts`, `jh:ui-preferences`,
Zustand+`persist` v1) drives `--jh-row-height` on `.app-shell`
(compact/regular/comfy = 32/40/48px; `patterns.md` §4.10;
`DensityProvider.tsx` is a pass-through). Saved-view density is therefore a
**table-scoped override** layered on top of the global default — additive, not
a replacement.

The migration-safe persisted-store precedent is
`apps/web/src/contexts/pipeline/stores/stage-trigger-store.ts`: Zustand+`persist`
with `version`, `partialize`, `merge` (per-field validation + defaulting), and a
memory-storage fallback for SSR/tests. Saved views reuse this exact pattern.

### Dashboard + read-model surfaces (verified)

- `DashboardSummary` is a plain TS interface at
  `packages/contracts/src/schemas.ts:2144-2182`; `totals` (jobs, jobsToday,
  failures, blocked, ready, applied, appliedToday, dryRuns) at 2147-2156;
  `sourceHealth` (`SourceHealthSummary`, 2196) with `recommendedState` /
  `consecutiveFailures`; `preparation.outdatedScoreCount` (~2187). Served by
  `GET /v1/dashboard/summary` (`apps/api/src/server.ts:287` →
  `buildDashboardSummary`, `apps/api/src/read-model.ts:351`), which reads the
  `dashboard_projections` row and computes `jobsToday`/`appliedToday` live.
- `apps/web/src/views/dashboard/DashboardView.tsx` composes cards
  (`KpiGrid`, `ConversionPanel`, `Funnel`, `SourceHealthCard`, `ApplyRunsCard`,
  outcome suggestions) from `useDashboardSummaryQuery` — the digest panel is a
  new sibling card here.
- The event-sourced **watermark** precedent is `event_watermarks`
  (`apps/api/src/projections.ts:431`, `last_event_id`); the SSE stream already
  supports resume via `?since=<lastEventId>` / `Last-Event-ID`
  (`apps/api/src/event-stream.ts:207`; documented in `docs/local-ts-api.md`
  §"Server-Sent Events"). These are the models for a digest watermark.

### Digest data-source map (verified)

| # | Datum | Verdict | Canonical source (cite) |
|---|---|---|---|
| 1 | New matches since last digest | **PARTIAL** | `job_list_projections` via `listJobs` (`read-model.ts:604`, `GET /v1/jobs` `server.ts:540`); fields `discovered_at`, `fit_score`, `scored_at`. `jobsToday` is local-calendar-day only (`read-model.ts:394-418`). `JobListQuerySchema` (`schemas.ts:1575`) has **no** `since`/`discoveredSince`/`scoredSince`. → needs a "since watermark" read. |
| 2 | Blocked / degraded sources | **EXISTS** | `listSourceHealth` (`read-model.ts:3549`, table `source_quality_stats`; `recommendedState`/`consecutiveFailures`); quarantine `listQuarantine` (`discovery-controls.ts:728`, `GET /v1/discovery/quarantine` `server.ts:387`). |
| 3 | Review-needed materials | **PARTIAL** | Apply-review queue `listApplyReviewQueue` (`application-feedback.ts:210`, `GET /v1/apply/review-queue` `server.ts:626`) carries `materials.ready` + `review.state`. Resume-review drafts (`resume_review_drafts`, `resume-review-drafts.ts:172`) are **per-job only**, no aggregate. |
| 4 | Stale scores | **EXISTS** | `job_score_staleness` (`write-model.ts:857`); per-job `scoreStaleness.isStale` (`read-model.ts:2097`, `schemas.ts:1999`); aggregate `preparation.outdatedScoreCount` (`read-model.ts:446`). |
| 5 | Pending apply approvals | **EXISTS (queue), no count** | `listApplyReviewQueue` items with `review.state === "pending"` (`schemas.ts:701`); binding gate in `application_review_decisions` (`application-feedback.ts:357`). |
| 6 | Follow-ups due | **MISSING** | Only `application_outcomes` / `application_outcome_suggestions` (`application-feedback.ts:146/187/405`, `GET /v1/outcomes` `server.ts:774`). No `due`/`reminder`/`snooze` concept anywhere. → define a derived read (below). |
| 7 | Budget usage | **EXISTS** | `readLlmSpendHealth` (`worker-health.ts:148`; shape `LlmSpendHealthSnapshot` 36-46) on `GET /v1/health` (`server.ts:275-283`); Python `read_spend_budget_status` (`workers/automation/src/jobhunter/llm.py:124`). Per-day already. |

No user-facing "digest" / "since last seen" concept exists today (only the
internal `event_watermarks` projection cursor and SSE resume).

---

## Feature 1 — Saved table views

### Objectives

- Let the operator save the current Jobs table configuration as a **named
  view**, switch between views from the toolbar, and rename/delete them.
- Persist per view: visible columns, column order, column widths, density
  override, sort, filters (both URL-mapped and grid-local), grouping, color
  rules.
- Keep the URL the single runtime source of truth for the **active** filter and
  sort; a saved view is a **template** the user applies, not a second live copy.
- Ship a non-deletable built-in **Default** view equal to today's Jobs defaults.

### State-layer decision (the core architectural choice)

Grounded in `state-and-ports.md` §5.1 (URL vs client vs server matrix) and
`patterns.md` §4.9-§4.10 (Zustand+`persist` for mutable, cross-cutting,
persisted UI preference state):

| Concern | Layer | Justification |
|---|---|---|
| **Active** filters, sort, page, `q`, deleted-tab (the runtime-applied dimensions) | **URL** (unchanged) | Already URL per §5.1; ripping them out would break bookmarkability, the `KpiGrid` deep-links, SSE-survival, and the route loader's cache-key derivation. No-strangler: leave as-is. |
| **Presentation** dimensions of the active table (column visibility/order/widths, density override, grouping, color rules) | **Persisted client store** (Zustand+`persist` via `StoragePort`/`localStorage`) | Not shareable, not domain data; identical class to theme/density/stage-trigger config already in the client layer (§4.9). |
| **Saved view library** (the named view definitions) + **active-view-id per table** | **Persisted client store** (Zustand+`persist`) | Local-first single-user product; UI preference, not a domain aggregate. The `StoragePort` seam (`state-and-ports.md` §6.1: `LocalStorageAdapter` → `IndexedDbAdapter` → future server) means choosing client-persist now does not foreclose server persistence later. |

**Why not server-side now.** Server persistence would require a new
bounded-context aggregate, projection table, API routes, and migrations — the
architecture reserves server persistence for domain data (profile, settings,
credentials) and names cross-device sync as a hosted concern. Adding it now
violates "smallest changeset" and the local-first posture. The promotion path
is a named owner decision below (it maps to the hosted "share a jobs filter
view" fitness function in `docs/backlog.md` / `integration.md` §9.1).

**Two-layer-fact safety.** A saved view records a *template* of intended
filters/sort. At runtime the active filter/sort lives **only** in the URL.
Applying a view = `navigate({ search })` (writes URL) **plus** setting the
presentation store; it does not create a live duplicate. Editing filters after
applying does not mutate the saved view unless the user explicitly re-saves.
This preserves "one source of truth per fact."

### View schema contract (draft — finalize in `packages/contracts`)

```ts
interface SavedTableView {
  id: string;                    // uuid; "default" reserved for the built-in
  tableId: TableId;              // "jobs" (first); "discovery-sources" next
  name: string;
  builtIn: boolean;              // Default view: non-deletable, non-renamable
  columns: {
    order: string[];             // DataGridColumn.id in display order
    hidden: string[];            // hidden column ids
    widths: Record<string, number>; // px; optional per column
  };
  density: "compact" | "regular" | "comfy" | null; // null = inherit global
  sort: { columnId: string; direction: "asc" | "desc" };
  urlFilters: Partial<JobsSearch>;      // template for URL-mapped dimensions
  gridFilters: DataGridFilterState;     // template for grid-local filters
  grouping: { columnId: string } | null;
  colorRules: Array<{
    columnId: string;
    predicate: { op: "eq" | "neq" | "gte" | "lte" | "contains"; value: string | number };
    tone: "success" | "warning" | "danger" | "info"; // semantic tokens only
  }>;
  schemaVersion: number;
}
```

Persisted store shape:
`{ version, views: SavedTableView[], activeViewIdByTable: Record<TableId, string> }`.

**Defaults.** On first load and after any destructive migration, the store
guarantees exactly one `builtIn` `Default` view per known `tableId`, equal to
today's Jobs defaults (columns as declared in `apps/web/src/views/jobs/columns.tsx`,
sort `discovered_at` desc, no hidden columns, global density, no grouping, no
color rules). Default is the active view when no other is selected.

**Rename / delete.** User views can be renamed and deleted; `Default` cannot.
Deleting the active view falls back to `Default`.

**Migration-safety (required).** Follow the `stage-trigger-store.ts` pattern:
`persist` `version` + `merge` that (a) validates and defaults every field, (b)
**drops unknown `columnId`s** from `order`/`hidden`/`widths`/`colorRules`/`grouping`
so a renamed/removed column cannot corrupt a view, (c) **tolerates newly added
columns** (a column absent from a saved view's `order` appears per a documented
default-visibility rule), (d) always reconstructs the `Default` view, and (e)
uses a memory-storage fallback so SSR/tests never touch `localStorage`. A view
schema bump increments `schemaVersion` and `persist` `version` together.

### Table engine changes (additive, shared)

Extend `FilterableDataGrid` with controlled/uncontrolled props for:
`columnVisibility`, `columnOrder`, `columnWidths` (already tracked — expose
get/set), `density`, `grouping`, and `colorRules` (predicate → semantic tone
applied through the existing `rowClassName`/cell `className` seam, using
`tokens.css` semantic tokens only — no raw colors, per the Token Foundation QA
gate in `docs/local-reliability-qa.md`). The existing controlled
`sort`/`onSortChange` and `filters`/`onFiltersChange` contracts are unchanged.
All new props are optional so current call sites keep working (no-strangler).
Column ids remain the contract between views and the engine.

### UI surface and placement (view-vs-context compliance)

Saved table views are a **shared, cross-table** UI concern, not a backend
bounded context — the eight `contexts/` folders mirror the backend 1:1 and
there is no "saved views" backend context (`structure.md` folder principle 2;
`docs/decisions.md` 2026-05-06 View-vs-Context Dichotomy). Therefore:

- The **store** lives in `apps/web/src/shared/stores/` (precedent:
  `ui-preferences.ts`), keyed by `tableId` so Jobs and later Discovery reuse it.
- The **view switcher** + **save/rename/delete** controls live in
  `apps/web/src/shared/` (a small table-views control), mounted in the engine's
  `toolbarActions` slot.
- `JobsView` (the composer) wires the store to the table: it applies a view by
  `navigate({ search })` for `urlFilters` (allowed — views coordinate via the
  URL) and by passing presentation props to `JobsTable`. Views never own
  queries/mutations/stores (`structure.md` folder principle 3) — reading a
  shared store and navigating is composer work, consistent with `KpiGrid`.

### Acceptance template (Feature 1)

- **Source of truth:** saved-view definitions + active-view-id → persisted
  client store (`shared/stores`); active filters/sort → URL (unchanged).
- **Owning context:** shared frontend concern (no backend context); Jobs is the
  first adopting view.
- **Projection / read model:** none new (client-only); no API/DB change in this
  scope.
- **UI surface:** Jobs table toolbar view switcher + save/rename/delete;
  restored columns/order/widths/density/sort/filters/grouping/color on load.
- **Approving user action:** save-as / rename / delete are explicit user
  actions; applying a view is explicit (no silent mutation of saved views).
- **Regression fixture proving the invariant:** a persisted-store migration
  fixture that rehydrates a prior-`version` payload containing an unknown
  column id and a missing field, and asserts the unknown column is dropped, the
  missing field defaulted, and `Default` reconstructed (proves migration-safety).
- **Local QA path:** `docs/local-reliability-qa.md` new "Saved Views Smoke"
  gate — create a view, hide/reorder columns, set density + a filter, switch
  away and back, reload, confirm restoration; delete falls back to Default.

### Acceptance criteria (gates)

1. Create/apply/switch/rename/delete works on Jobs; `Default` is
   non-deletable/non-renamable and always present.
2. A saved view restores columns (visibility/order/widths), density, sort,
   URL-mapped filters (via navigation), grid-local filters, grouping, and color
   rules after reload.
3. Applying a view never mutates a stored view; editing then re-saving does.
4. Persisted schema is versioned and migration-safe (unknown columns dropped,
   new columns tolerated, Default reconstructed) — proven by fixture.
5. URL remains authoritative for active filters/sort; `KpiGrid` deep-links and
   the route loader are unaffected.
6. Engine changes are additive; existing Jobs/other call sites unchanged; color
   rules use semantic tokens only (Token Foundation gate passes).
7. Backlog entries for saved views and configurable columns are updated to
   point at this delivery.

---

## Feature 2 — Daily local digest

### Objectives

- Produce a once-a-day, locally-computed summary of the seven datums, readable
  as (a) a dashboard panel and (b) a `jobhunter digest` CLI command.
- Track a **watermark** so "new since last digest" is meaningful, advanced only
  by an explicit acknowledge.
- Deep-link every item into the relevant in-app view.
- Compute every number from a canonical read model; where none exists, add one
  honestly (datums 1 and 6).

### Invariants

- **Local-only delivery** (dashboard panel + CLI stdout). No external channel.
- **On-demand** computation; no enabled-by-default schedule.
- **Canonical sourcing**; "follow-ups due" carries an explicit, documented
  definition (below) and is labeled as derived.
- **TS/Python parity**: the dashboard panel (TS read model) and the CLI (Python
  read layer) MUST produce identical numbers for the same local SQLite state.

### Digest contract (draft — finalize in `packages/contracts`)

```ts
interface DailyDigest {
  generatedAt: string;
  since: string | null;                 // watermark (last acknowledged); null = first run
  newMatches: { count: number; highFitCount: number };   // discovered/scored since `since`
  blockedSources: { count: number; sources: Array<{ sourceId: string; recommendedState: string; consecutiveFailures: number }> };
  reviewNeededMaterials: { count: number };
  staleScores: { count: number };       // = preparation.outdatedScoreCount
  pendingApprovals: { count: number };  // apply-review items, review.state === "pending"
  followUpsDue: { count: number };      // derived; see definition
  budget: { status: "ok" | "over_budget"; estimatedUsd: number; dailyBudgetUsd: number; remainingUsd: number | null; unlimited: boolean };
  deepLinks: Record<keyof Omit<DailyDigest,"generatedAt"|"since"|"deepLinks">, string>; // in-app URLs
}
```

### Per-datum implementation notes

1. **New matches** — add a "since watermark" read. Preferred: additive
   `discoveredSince` / `scoredSince` filters on the jobs read model
   (`read-model.ts` `listJobs`; `JobListQuerySchema` `schemas.ts:1575`) reused
   by the digest, so the digest and any future "new jobs" view share one code
   path. `highFitCount` counts rows with `fit_score` ≥ the configured
   readiness/min-score threshold since `since`.
2. **Blocked / degraded sources** — read `listSourceHealth`
   (`recommendedState` ∈ quarantined/disabled, or `consecutiveFailures` above a
   documented threshold) plus pending `listQuarantine`. No new model.
3. **Review-needed materials** — count apply-review-queue items where materials
   exist but are not accepted / a resume-review draft thread is open. Scope this
   to the existing `listApplyReviewQueue` signal; a global drafts aggregate over
   `resume_review_drafts` is an owner decision (below).
4. **Stale scores** — `preparation.outdatedScoreCount` (already computed).
5. **Pending apply approvals** — count `listApplyReviewQueue` items with
   `review.state === "pending"`. Disambiguate from datum 3 in the contract:
   datum 5 = approval gate pending; datum 3 = materials not review-ready.
6. **Follow-ups due (derived — define explicitly).** No due-date model exists.
   Define "due" deterministically over `application_outcomes`: an application
   with an `applied_confirmation` outcome, **no** subsequent
   `recruiter_reply`/`interview`/`assessment`/`offer`/`rejection`/`withdrawn`
   outcome, and whose last activity is older than a documented threshold (e.g.
   N days). Surface it **labeled as a derived heuristic**, not a user-set
   reminder. A first-class reminder aggregate (user due dates + snooze) is an
   owner decision, out of scope here.
7. **Budget usage** — `readLlmSpendHealth` (TS) / `read_spend_budget_status`
   (Python). No new model.

### Watermark / "seen" state

- Persist a small **`digest_state`** row in local SQLite (owned by the
  Operations read-side, alongside `event_watermarks`
  `apps/api/src/projections.ts:431`) holding `last_acknowledged_at` (and/or
  `last_seen_event_id`). Local SQLite — not a client store — because the
  dashboard panel and the CLI must agree on "since last digest"
  (`docs/architecture/storage.md`: local SQLite is the local source of truth).
- **Seen advances only on an explicit acknowledge**, never on passive panel
  load. Acknowledge = a "Mark digest reviewed" action in the panel and a
  `jobhunter digest --acknowledge` flag (default: print without acknowledging).
- **Recommended (architecturally consistent) acknowledge path:** emit a
  `DigestReviewed` domain event so the watermark updates through the standard
  event → projection path and the SSE invalidation router refreshes the digest
  across surfaces (`docs/decisions.md` 2026-05-06 "In-Process EventPublisher +
  Read-Model Projections" and "SSE Realtime + Invalidation Router"). This adds
  one entry to the parity-tested `DOMAIN_EVENT_TYPES`
  (`packages/domain-types/src/events/index.ts:404`) and a handler in the
  invalidation router. **Lighter alternative:** a direct `digest_state` write +
  query invalidation (no new event). Flagged as an owner decision.

### Timing and scheduling posture

On-demand only. The panel computes on view; the CLI computes on invocation
(bootstrapping projections first, as `status` does via `_bootstrap()`
`workers/automation/src/jobhunter/cli.py:64`). Do **not** add a Temporal
Schedule in this scope. If a scheduled daily digest is later wanted, mirror the
default-off discovery schedule reconciled at worker startup
(`cli.py:1378` `_reconcile_discovery_schedule`) behind a new off-by-default
settings flag — owner decision.

### Deep-linking

Reuse the `KpiGrid` URL-builder pattern (`views/dashboard/KpiGrid.tsx`):

| Datum | Deep-link target |
|---|---|
| New matches | `/jobs?sort=discovered_at&dir=desc` (precise "since" filtering once `discoveredSince` lands) |
| Blocked sources | `/discovery` and/or `/jobs?state=blocked` (existing KPI target) |
| Review-needed materials | `/apply-review` |
| Stale scores | `/jobs` (optional additive `stale` search param — owner decision) |
| Pending approvals | `/apply-review` |
| Follow-ups due | `/jobs?applyStatus=applied` |
| Budget usage | `/settings` (where `dailyBudgetUsd` is configured) |

### UI surface + CLI

- **Dashboard panel** — a new `apps/web/src/views/dashboard/DigestPanel.tsx`
  sibling card in `DashboardView.tsx`, composing a new Operations read hook
  `useDigestQuery` (read hooks live in `contexts/operations/`; add
  `digestKeys` and re-export through `contexts/operations/queryKeys.ts`) and the
  deep-link buttons. The acknowledge control is a context-owned mutation hook if
  the event path is chosen.
- **CLI** — a new read-only `jobhunter digest` Typer subcommand
  (`workers/automation/src/jobhunter/cli.py`, registered like `status`
  `cli.py:1137`), reusing the local read layer (`get_stats`,
  `read_spend_budget_status`, source-quality + stale-score queries,
  apply-review reads) and printing a `rich` summary. It reads local SQLite
  directly (the CLI has no read-side RPC and the API may be down).

### TS/Python parity requirement

Because the panel (TS `read-model.ts`) and CLI (Python) each read the same
SQLite projections independently, they can drift (cf. the triplicated
`llmSpend` contract). Mitigations, all required:

- The digest response shape is defined **once** in `packages/contracts`.
- A **parity fixture/test** seeds one SQLite state and asserts the TS
  `buildDigest` and the Python digest composition produce identical counts —
  mirroring `apps/api/test/audit-projection-parity.test.ts` and
  `scripts/check-domain-type-parity.py`.

### Acceptance template (Feature 2)

- **Source of truth:** per the data-source map — existing read models for
  datums 2/4/5/7; additive `discoveredSince`/`scoredSince` for datum 1; a
  defined derived read for datum 6; `digest_state` for the watermark.
- **Owning context:** Operations read-side (cross-context aggregation, like the
  dashboard summary); frontend `contexts/operations/` owns `useDigestQuery` +
  `digestKeys`.
- **Projection / read model:** new `GET /v1/digest` (TS `read-model.ts`
  `buildDigest`) + Python digest composition + `digest_state` table; additive
  jobs-list `since` filters.
- **UI surface:** dashboard `DigestPanel` + `jobhunter digest` CLI, with
  deep-links.
- **Approving user action:** explicit acknowledge (panel button /
  `--acknowledge`) advances the watermark; passive reads do not.
- **Regression fixture proving the invariant:** a seeded-projection fixture
  where two jobs precede and three follow the watermark, one score is stale,
  one apply item is `pending`, one applied job is past the follow-up threshold
  with no reply, and spend exceeds budget — asserting `newMatches.count == 3`,
  `staleScores.count == 1`, `pendingApprovals.count == 1`,
  `followUpsDue.count == 1`, `budget.status == "over_budget"`; then acknowledge
  and assert `newMatches.count == 0`. Plus the TS/Python parity fixture.
- **Local QA path:** `docs/local-reliability-qa.md` new "Digest Panel Smoke"
  (panel renders counts, deep-links navigate, acknowledge advances "since") and
  a CLI note (`jobhunter digest` prints the same numbers; `--acknowledge`
  advances the watermark).

### Acceptance criteria (gates)

1. Digest computes all seven datums from the cited canonical sources; no datum
   is faked or sourced from the wrong model.
2. "Follow-ups due" uses the documented derived definition and is labeled
   derived.
3. Watermark advances only on explicit acknowledge; "new since" resets
   accordingly; proven by fixture.
4. Delivery is local-only (panel + CLI); no external-delivery code path exists.
5. No enabled-by-default schedule is added.
6. TS panel and Python CLI produce identical numbers on identical SQLite state;
   proven by the parity test.
7. Every digest item deep-links to a resolvable in-app URL.

---

## Contracts, data, and doc changes summary

- **`packages/contracts/src/schemas.ts`** — add `SavedTableView` (+ `TableId`)
  and `DailyDigest` shapes; additive `discoveredSince`/`scoredSince` on
  `JobListQuerySchema` (`schemas.ts:1575`).
- **`packages/domain-types/src/events/index.ts`** — add `DigestReviewed` to
  `DOMAIN_EVENT_TYPES` (line 404) only if the event acknowledge path is chosen
  (then update the invalidation router + `every-event-has-handler.test.ts`).
- **`apps/api`** — `buildDigest` in `read-model.ts`; routes `GET /v1/digest`
  and the acknowledge write; `digest_state` table (near
  `event_watermarks`, `projections.ts:431`); additive jobs-list `since` filter.
- **`apps/web`** — engine extensions in `shared/ui/filterable-data-grid.tsx`;
  `shared/stores` saved-views store + shared switcher control;
  `contexts/operations` `useDigestQuery` + `digestKeys`; dashboard
  `DigestPanel`; Jobs view wiring.
- **`workers/automation`** — `jobhunter digest` subcommand + Python digest read
  composition + `digest_state` read/write. (No `pyproject.toml` change unless a
  new dependency is introduced; none is anticipated.)

### Documentation to update on delivery (per `CLAUDE.md` Documentation Requirements)

| Surface | Doc |
|---|---|
| `jobhunter digest` command, local-only + no-external-delivery safety note | `README.md` (CLI Reference; Local Data And Safety) |
| `GET /v1/digest` + acknowledge contract, jobs-list `since` params | `docs/local-ts-api.md` |
| Saved-views state layer + digest local-only realtime/read-model behavior | `docs/architecture/frontend/state-and-ports.md` (§5.1 rows), `structure.md` (new shared store/control), `patterns.md` (density interaction), `testing.md` (new tests); `docs/decisions.md` (one ADR: saved-views state-layer choice + digest local-only) |
| New QA gates + regression rows | `docs/local-reliability-qa.md` |
| Mark saved-views + configurable-columns backlog entries delivered; note digest | `docs/backlog.md` |

---

## Verification

Run the CLAUDE.md matrix, narrowed to the touched surfaces:

```bash
# TypeScript API
pnpm api:check
pnpm api:test                              # incl. buildDigest + TS/Python parity fixture

# Web typecheck / build
pnpm web:check
pnpm web:build

# Web unit / hook / component (saved-views store, migration fixture, DigestPanel, useDigestQuery)
pnpm --filter @jobhunter/web test
pnpm --filter @jobhunter/web test-d        # SavedTableView / DailyDigest type-level tests

# Web e2e (saved-views survive-reload; digest panel smoke + deep-links)
pnpm --filter @jobhunter/web e2e

# Storybook a11y (DigestPanel + view switcher stories; zero critical/serious)
pnpm web:storybook:test

# Python (digest command + parity + since-read helpers)
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .

# Full gate
pnpm test
```

### Required regression fixtures / tests

- Saved-views persisted-store **migration fixture** (unknown column dropped,
  missing field defaulted, `Default` reconstructed).
- Saved-views store + switcher **hook/component tests** (create → apply →
  switch → rename → delete; apply does not mutate stored view).
- Saved-views **e2e**: a view survives reload and restores
  columns/order/density/sort/filters.
- Digest **read-model fixture** proving each datum's count from canonical
  sources and watermark reset on acknowledge.
- Digest **TS/Python parity fixture** (identical numbers on identical SQLite).
- If `DigestReviewed` is added: update `every-event-has-handler.test.ts` and the
  invalidation-router unit test (`testing.md` §10.2).

### Definition of Done

- All acceptance gates (Feature 1 #1-7, Feature 2 #1-7) met.
- All commands above pass; no NEW web e2e failures beyond the documented
  known-failing baseline in `docs/backlog.md`.
- `pr-reviewer` returns `Gate: PASS`; `qa` returns `Gate: PASS`.
- Docs in the table above updated; backlog entries reconciled.
- No external-delivery code path and no enabled-by-default schedule exist.

## Risks

- **Grouping + color rules add real complexity to a custom (non-`react-table`)
  grid.** Mitigation: they are the lowest-priority dimensions; a phase split is
  acceptable (see Phasing) as long as the persisted schema reserves their shape
  so no second migration is needed.
- **Per-table density vs global density confusion.** Mitigation: density
  override is explicitly additive; `null` inherits the global `useDensity()`.
- **TS/Python digest drift.** Mitigation: single contract + mandatory parity
  test (precedent: `audit-projection-parity.test.ts`).
- **Local-day vs UTC-day inconsistency** (`jobsToday` uses local calendar day;
  `llmSpend` uses UTC day). Mitigation: the watermark is timestamp-based, not
  day-bucket-based; document the chosen day boundary once and apply it
  consistently across TS and Python.
- **"Follow-ups due" over-promising.** Mitigation: labeled derived; richer
  reminder model deferred to an owner decision.

## Open owner decisions

1. **Saved-views persistence tier** — client-only (this plan) vs server-side
   for cross-device/shareable views (promotion via `StoragePort`/a new
   aggregate). Ties to the hosted "share a jobs filter view" fitness function.
2. **Digest acknowledge mechanism** — `DigestReviewed` domain event
   (architecturally consistent, realtime, +1 parity-tested event) vs direct
   `digest_state` write + invalidation (lighter).
3. **Review-needed materials scope** — apply-review-queue signal only (this
   plan) vs a new global aggregate over `resume_review_drafts`.
4. **Follow-ups-due model** — derived heuristic (this plan) vs a first-class
   user reminder aggregate with due dates + snooze.
5. **Follow-up threshold + day boundary** — the N-days value for "follow-ups
   due" and the canonical day boundary (local vs UTC) for the digest.
6. **Scheduled digest** — keep on-demand only (this plan) vs an opt-in,
   default-off Temporal schedule mirroring discovery.
7. **Optional additive Jobs search params** — `stale=only` and/or
   `discoveredSince` as first-class URL filters to make digest deep-links exact.

## Phasing (suggested, non-binding)

- **P1 — Saved views core:** engine visibility/order/widths/density + store +
  switcher + Default + migration-safety + Jobs wiring + tests/docs.
- **P2 — Saved views grouping + color rules** (schema reserved in P1).
- **P3 — Digest read model + contract + watermark + parity** (TS + Python).
- **P4 — Digest dashboard panel + deep-links + acknowledge.**
- **P5 — `jobhunter digest` CLI + QA gates + docs.**

Each phase is independently shippable behind its own gates; P2 is optional if
the owner defers grouping/color rules.

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
