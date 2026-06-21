# Phase 21: Jobs Triage UX & Warning-Only Floor - Pattern Map

**Mapped:** 2026-06-20
**Files analyzed:** 11 new/modified files
**Analogs found:** 10 / 11

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/views/jobs/columns.tsx` | component | transform | `apps/web/src/views/jobs/columns.tsx` | exact |
| `apps/web/src/views/jobs/JobsTable.tsx` | component | request-response | `apps/web/src/views/jobs/JobsTable.tsx` | exact |
| `apps/web/src/views/jobs/JobsView.tsx` | component | request-response | `apps/web/src/views/jobs/JobsView.tsx` | exact |
| `apps/web/src/views/jobs/JobDetailDrawer.tsx` | component | request-response | `apps/web/src/views/jobs/JobDetailDrawer.tsx` | exact |
| `apps/web/src/views/jobs/JobCompensationAuditSection.tsx` | component | transform | `apps/web/src/views/jobs/JobAuditTriage.tsx` | role-match |
| `apps/web/src/styles/globals.css` | config | transform | `apps/web/src/styles/globals.css` | exact |
| `apps/web/src/test/fixtures/projections.ts` | test | transform | `apps/web/src/test/fixtures/projections.ts` | exact |
| `apps/web/src/views/jobs/JobsView.test.tsx` | test | request-response | `apps/web/src/views/jobs/JobsView.test.tsx` | exact |
| `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | test | request-response | `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` | exact |
| `apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx` | test | request-response | `apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx` | exact |
| `packages/contracts/src/schemas.ts` | model | transform | `packages/contracts/src/schemas.ts` | exact if floor DTO needed |
| `apps/api/src/projections.ts` | service | batch | `apps/api/src/projections.ts` | exact if floor DTO needed |
| `apps/api/src/read-model.ts` | service | request-response | `apps/api/src/read-model.ts` | exact if floor DTO needed |
| `apps/api/src/profile-store.ts` | service | CRUD | `apps/api/src/profile-store.ts` | role-match if floor DTO needed |

## Pattern Assignments

### `apps/web/src/views/jobs/columns.tsx` (component, transform)

**Analog:** `apps/web/src/views/jobs/columns.tsx`

**Imports pattern** (lines 1-18):
```typescript
import { type ChangeEvent, type MouseEvent, useRef } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { STAGE_STATES } from "@jobhunter/contracts";

import { ApplyRunBadge } from "../../contexts/apply/components/ApplyRunBadge.js";
import { ScoreBadge } from "../../contexts/scoring/components/ScoreBadge.js";
import type { JobSummary } from "../../contexts/operations/types.js";
import type { DataGridColumn } from "../../shared/ui/filterable-data-grid.js";
import { TitleStack } from "../../shared/ui/title-stack.js";
```

**Column model pattern** (lines 172-280):
```typescript
export function jobColumns(
  options: JobColumnsOptions,
): Array<DataGridColumn<JobSummary>> {
  return [
    {
      id: "source",
      label: "Sources",
      getFilterValue: (row) =>
        row.postingSource || row.discoverySource || row.source || "-",
      render: (row) => (
        <TitleStack
          primary={row.postingSource ? `posting ${row.postingSource}` : "-"}
          secondary={
            row.discoverySource ? `discovered via ${row.discoverySource}` : null
          }
        />
      ),
    },
    {
      id: "location",
      label: "Location",
      sortable: true,
      getFilterValue: (row) => row.location || "-",
      render: (row) => <span>{row.location || "-"}</span>,
    },
  ];
}
```

**Copy for Phase 21:** Add `Posted`, `Market`, and `Warnings` entries after `Sources` and before `Location`. Do not include `sortable: true`. Avoid `getFilterValue` unless explicitly needed for non-search rendering; if present, keep compensation fields out of `SEARCH_FILTER_COLUMNS` and product route search.

**Accessibility pattern** (lines 150-167):
```tsx
<input
  type="checkbox"
  aria-label={`Select ${row.title}`}
  checked={checked}
  onChange={(event: ChangeEvent<HTMLInputElement>) => {
    updateRow(event.target.checked, shiftKeyRef.current);
    shiftKeyRef.current = false;
  }}
  onClick={(event: MouseEvent) => event.stopPropagation()}
/>
```

**Copy for Phase 21:** Table dash cells should expose accessible names with `aria-label` or visually hidden text, e.g. `aria-label="No posted salary recorded"` while rendering visual `-`.

### `apps/web/src/views/jobs/JobsTable.tsx` (component, request-response)

**Analog:** `apps/web/src/views/jobs/JobsTable.tsx`

**Grid composition pattern** (lines 93-128):
```tsx
return (
  <FilterableDataGrid<JobSummary>
    title="Jobs table"
    data={data?.items ?? []}
    columns={columns}
    getRowId={(row) => row.jobKey}
    loading={loading}
    tableClassName="jobs-data-grid-table"
    rowAriaSelected={(row) =>
      allMatchingSelected || Boolean(rowSelection[row.jobKey])
    }
    onRowActivate={(row) => onOpenJob(row.jobKey)}
    rowActivationLabel={(row) =>
      `Open job ${row.title} at ${row.company || "unknown company"}`
    }
    pagination={{ page, pageSize, totalPages: data?.pagination.pages ?? 1 }}
  />
);
```

**Copy for Phase 21:** Preserve the existing grid, row activation, `tableClassName`, and horizontal scroll path. Compensation cells must not stop row activation.

### `apps/web/src/views/jobs/JobsView.tsx` (component, request-response)

**Analog:** `apps/web/src/views/jobs/JobsView.tsx`

**Sort/filter boundary pattern** (lines 36-58, 138-140):
```typescript
const SORTABLE_JOB_FIELDS: ReadonlySet<JobSortField> = new Set([
  "discovered_at",
  "title",
  "company",
  "location",
  "fit_score",
  "current_stage",
  "current_state",
]);

const SEARCH_FILTER_COLUMNS = new Set([
  "current_stage",
  "current_state",
  "apply_status",
]);

function isJobSortField(value: string): value is JobSortField {
  return SORTABLE_JOB_FIELDS.has(value as JobSortField);
}
```

**Table handoff pattern** (lines 553-569):
```tsx
<JobsTable
  data={data ?? null}
  loading={isFetching}
  sorting={sorting}
  onSortingChange={handleSortingChange}
  filters={tableFilters}
  onFiltersChange={handleTableFiltersChange}
  onOpenJob={openJob}
/>
```

**Copy for Phase 21:** Do not add compensation fields to `SORTABLE_JOB_FIELDS`, route search, bulk filters, ranking, or apply readiness. Tests should assert compensation columns do not create salary sort/filter controls.

### `apps/web/src/views/jobs/JobDetailDrawer.tsx` (component, request-response)

**Analog:** `apps/web/src/views/jobs/JobDetailDrawer.tsx`

**Imports pattern** (lines 1-20):
```typescript
import { JobHunterApiError } from "@jobhunter/api-client";
import type { JobAuditEntry, StageSummary } from "@jobhunter/contracts";

import { useJobDetailQuery } from "../../contexts/operations/hooks/useJobDetailQuery.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { JobAuditTriage } from "./JobAuditTriage.js";
import { JobDescription } from "./JobDescription.js";
import { JobOverview } from "./JobOverview.js";
```

**Drawer section ordering pattern** (lines 98-113):
```tsx
{detail ? (
  <>
    <JobOverview detail={detail} />
    <div className="job-detail-drawer-content">
      <JobAuditTriage detail={detail} />
      <section className="section job-detail-description">
        <h3>Description</h3>
        <JobDescription text={detail.job.descriptionPreview} />
      </section>
      <JobActions
        jobId={detail.job.jobKey}
        currentStage={detail.job.currentSubstage}
      />
```

**Copy for Phase 21:** Insert `<JobCompensationAuditSection detail={detail} />` or equivalent immediately after `<JobAuditTriage detail={detail} />` and before `.job-detail-description`.

**Disclosure analog** (lines 42-57):
```tsx
function JobAuditHistorySection({ entries }: { readonly entries: readonly JobAuditEntry[] }) {
  return (
    <section className="section job-audit-section">
      <details className="job-audit-disclosure">
        <summary>
          <span className="job-audit-summary-title">Audit history</span>
          <span className="tag muted">{entries.length} events</span>
        </summary>
        <JobAuditHistory entries={entries} />
      </details>
    </section>
  );
}
```

**Copy for Phase 21:** Use native `details`/`summary` with `.job-audit-disclosure`, count labels, and DOM-order content for source trail and confidence factors/assumptions.

### `apps/web/src/views/jobs/JobCompensationAuditSection.tsx` (component, transform)

**Analog:** `apps/web/src/views/jobs/JobAuditTriage.tsx`

**Section and metric pattern** (lines 20-44, 112-118):
```tsx
return (
  <section className="section job-audit-triage" aria-labelledby="job-audit-triage-title">
    <div className="job-audit-triage-head">
      <div>
        <span className="eyebrow">Audit triage</span>
        <h3 id="job-audit-triage-title">Why this job is here</h3>
      </div>
    </div>

    <div className="job-audit-metrics" aria-label="Ranking summary">
      <Metric label="Fit score" value={`${job.fitScore ?? "-"}/10`} />
      <Metric label="Band" value={score?.fitBand ?? "not recorded"} />
    </div>
  </section>
);

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
```

**Tag group pattern** (lines 157-180):
```tsx
function TagGroup({ label, values, tone = "info" }: {
  label: string;
  values: readonly string[] | undefined;
  tone?: "info" | "warn";
}) {
  if (!values?.length) return null;
  return (
    <div className="job-audit-tag-group">
      <span>{label}</span>
      <div>
        {values.map((value) => (
          <span className={`tag ${tone}`} key={value}>{value}</span>
        ))}
      </div>
    </div>
  );
}
```

**Tone mapping pattern** (lines 244-255):
```typescript
function factTone(fact: ApplyAuditFact): "muted" | "info" | "ok" | "warn" {
  if (fact.severity === "unknown") return "muted";
  if (fact.severity === "success") return "ok";
  if (fact.severity === "info") return "info";
  return "warn";
}
```

**Copy for Phase 21:** Keep compensation as a sibling audit section. Use `job-compensation-*` class names around reused `.job-audit-*` primitives. Floor warnings must render only here and in list warning count, never inside `Apply concerns`.

### `apps/web/src/styles/globals.css` (config, transform)

**Analog:** `apps/web/src/styles/globals.css`

**Horizontal scroll/table pattern** (lines 1939-1958, 2148-2150):
```css
.filterable-data-grid-scroll {
  width: 100%;
  overflow: auto;
}

.filterable-data-grid-table {
  width: 100%;
  min-width: 1180px;
  border-collapse: collapse;
  font-size: 12px;
}

.filterable-data-grid-table th,
.filterable-data-grid-table td {
  padding: 8px 10px;
  white-space: nowrap;
}

.jobs-data-grid-table {
  min-width: 1320px;
}
```

**Tag/status pattern** (lines 2736-2775):
```css
.tag,
.stage-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  background: var(--muted);
  padding: 2px 6px;
}

.tag.muted { color: var(--muted-foreground); }
.tag.ok { background: color-mix(in oklab, var(--success) 32%, var(--card)); }
.tag.warn { background: var(--warning-muted); color: var(--warning); }
.tag.info { background: var(--status-info-muted); color: var(--status-info); }
```

**Drawer audit pattern** (lines 2954-3013, 3682-3707):
```css
.job-audit-triage {
  display: grid;
  gap: 14px;
}

.job-audit-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.job-audit-metrics b {
  min-width: 0;
  overflow-wrap: anywhere;
}

.section {
  padding: 18px 28px;
  border-bottom: 1px solid var(--border);
}

.job-audit-disclosure > summary {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}
```

**Copy for Phase 21:** Extend `.jobs-data-grid-table` min-width. Add only narrow `.job-compensation-*` rules for scan cells, summary grid, warning-only callout, evidence rows, and wrapping. Avoid nested cards.

### `apps/web/src/test/fixtures/projections.ts` (test, transform)

**Analog:** `apps/web/src/test/fixtures/projections.ts`

**Fixture base pattern** (lines 1-17, 47-60):
```typescript
import type {
  JobDetail,
  JobSummary,
  PaginatedResponse,
} from "@jobhunter/contracts";

export const sampleJob: JobSummary = {
  jobKey: "job-1",
  title: "Staff Software Engineer",
  salary: "$220k-$260k",
  compensationSummary: null,
  discoveredAt: "2026-05-01T12:00:00Z",
};
```

**Detail fixture override pattern** (lines 504-518):
```typescript
return {
  ok: true,
  job: {
    ...job,
    descriptionPreview: "Lead the platform engineering team...",
  },
  stages,
  artifacts: overrides.artifacts ?? [],
  auditHistory: overrides.auditHistory ?? sampleJobAuditHistory,
  applyAudit: overrides.applyAudit ?? makeApplyAudit(),
  employerAnalysis: overrides.employerAnalysis ?? null,
  requirementFitReport: overrides.requirementFitReport ?? null,
  compensationAudit: overrides.compensationAudit ?? null,
};
```

**Copy for Phase 21:** Add builders for populated posted+market compensation, null summary, not requested market, unsupported, insufficient evidence, source unavailable, no numeric floor, posted-only floor warning, market-only floor warning, and both-basis floor warning. Keep fixture data synthetic and safe.

### `apps/web/src/views/jobs/JobsView.test.tsx` (test, request-response)

**Analog:** `apps/web/src/views/jobs/JobsView.test.tsx`

**Provider/query test pattern** (lines 367-395):
```tsx
it("moves product filters into the table header and keeps them URL-backed", async () => {
  const user = userEvent.setup();
  const discoverJob = jobWithStage("job-discover", "Discovery candidate", "discover");
  const jobs = vi.fn(async (query?: Partial<JobListQuery>) =>
    makeJobsPage(query?.stage === "discover" ? [discoverJob] : []),
  );
  const harness = buildProviderHarness({
    ports: buildTestPorts({ api: { jobs } }),
  });
  const { router, Wrapper } = buildRouter(harness);

  render(<RouterProvider router={router} />, { wrapper: Wrapper });

  await user.click(screen.getByRole("button", { name: /filter stage column/i }));
  await user.click(
    within(screen.getByLabelText("Stage values")).getByRole("checkbox", {
      name: "discover",
    }),
  );

  await waitFor(() =>
    expect(jobs).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "discover" })),
  );
  expect(router.state.location.search).toMatchObject({ stage: "discover", page: 1 });
});
```

**Boundary test pattern** (lines 475-525):
```tsx
await user.click(screen.getByRole("button", { name: /filter sources column/i }));
await user.type(screen.getByLabelText("Sources filter text"), "vonage");

await waitFor(() =>
  expect(screen.queryByText("Software Engineer (India)")).not.toBeInTheDocument(),
);
await user.keyboard("{Escape}");
expect(screen.getByRole("button", { name: /select all matching/i })).toBeDisabled();
```

**Copy for Phase 21:** Extend with assertions for three column headers, accessible dashes, warning count text, no salary filter controls, no compensation sort query, and no compensation influence on bulk/API filter bodies.

### `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` (test, request-response)

**Analog:** `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`

**Routed drawer harness pattern** (lines 39-64):
```tsx
function renderJobDetailDrawer(jobId: string) {
  const harness = buildProviderHarness();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    validateSearch: jobsSearchSchema,
    component: () => <Outlet />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => jobsRoute,
    path: "/$jobId",
    component: () => <RoutedJobDetailDrawer jobId={jobId} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute.addChildren([detailRoute])]),
    history: createMemoryHistory({
      initialEntries: [`/jobs/${encodeURIComponent(jobId)}?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50`],
    }),
  });
  return { router, ...render(<RouterProvider router={router} />, { wrapper: harness.Wrapper }) };
}
```

**Ordering assertion pattern** (lines 128-166):
```tsx
const triage = await screen.findByRole("region", { name: "Why this job is here" });
const drawer = screen.getByRole("dialog", { name: "Job details" });
expect(drawer).toHaveClass("job-detail-drawer");

const description = screen.getByText("Description").closest("section");
expect(description).toHaveClass("job-detail-description");
expect(
  triage.compareDocumentPosition(description as HTMLElement) &
    Node.DOCUMENT_POSITION_FOLLOWING,
).toBeTruthy();
```

**Copy for Phase 21:** Assert `Compensation audit` region follows `Why this job is here` and precedes `Description`; assert source trail/confidence disclosure labels and floor basis copy.

### `apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx` (test, request-response)

**Analog:** `apps/web/src/views/jobs/JobDetailDrawer.a11y.test.tsx`

**Axe pattern** (lines 32-51):
```tsx
it("has no critical axe violations when populated from MSW", async () => {
  const harness = buildProviderHarness();
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/jobs?stage=all&state=all&deleted=active&sort=discovered_at&dir=desc&page=1&pageSize=50"],
    }),
  });
  const view = render(<RouterProvider router={router} />, { wrapper: harness.Wrapper });
  await waitFor(() => expect(view.container.querySelector("[role='dialog'].drawer")).not.toBeNull());
  const results = await axe(view.container);
  expect(results).toHaveNoViolations();
});
```

**Copy for Phase 21:** Extend fixture/MSW state to include compensation disclosures, warning tags, and dash/missing states.

### `packages/contracts/src/schemas.ts` (model, transform, if floor DTO needed)

**Analog:** `packages/contracts/src/schemas.ts`

**Current compensation contract** (lines 1249-1293):
```typescript
export interface JobCompensationSummary {
  projectionVersion: number;
  legacyRawSalary: string | null;
  warningCount: number;
  posted: JobPostedCompensationSummary;
  market: JobMarketCompensationSummary;
}

export interface JobCompensationAudit {
  projectionVersion: number;
  posted: PostedCompensationFactResponse;
  market: MarketCompensationEstimateResponse;
}
```

**Job read model placement** (lines 1295-1308, 1630-1633):
```typescript
export interface JobSummary {
  salary: string;
  compensationSummary: JobCompensationSummary | null;
}

export interface JobDetail {
  // Projection-backed compensation facts from canonical posted-fact and
  // reported company-role estimate rows.
  compensationAudit: JobCompensationAudit | null;
}
```

**Copy for Phase 21:** If floor comparison must affect list warning count, add a small safe DTO under compensation types, e.g. `floorComparison`, with only numeric floor, currency/period, basis, warning state, and safe labels. Do not expose free-text salary expectations.

### `apps/api/src/projections.ts` (service, batch, if floor DTO needed)

**Analog:** `apps/api/src/projections.ts`

**Projection wiring pattern** (lines 1620, 1646-1708, 1732-1762):
```typescript
const compensationProjection = buildCompensationProjection(db, jobUrl);

db.prepare(
  `INSERT INTO job_list_projections (... compensation_summary_json, ...)
   VALUES (...)
   ON CONFLICT(tenant_id, job_id) DO UPDATE SET
     compensation_summary_json = excluded.compensation_summary_json`
).run(..., compensationProjection.summaryJson, ...);

db.prepare(
  `INSERT INTO job_detail_projections (... compensation_summary_json,
     compensation_audit_json, ...)
   VALUES (...)
   ON CONFLICT(tenant_id, job_id) DO UPDATE SET
     compensation_summary_json = excluded.compensation_summary_json,
     compensation_audit_json = excluded.compensation_audit_json`
).run(..., compensationProjection.summaryJson, compensationProjection.auditJson, ...);
```

**Compensation summary/audit builder pattern** (lines 1828-1888):
```typescript
function buildCompensationProjection(db: SqliteDatabase, jobUrl: string): CompensationProjectionPair {
  const posted = getPostedCompensationFact(db, jobUrl) ?? ({ ok: true, recordStatus: "not_recorded", jobKey: jobUrl, legacyRawSalary: null } as const);
  const market = getMarketCompensationEstimate(db, jobUrl) ?? ({ ok: true, recordStatus: "not_requested", jobKey: jobUrl } as const);
  const summary = buildCompensationSummary(posted, market);
  return {
    summaryJson: JSON.stringify(summary),
    auditJson: JSON.stringify({
      projectionVersion: COMPENSATION_PROJECTION_VERSION,
      posted,
      market,
    }),
  };
}

function buildCompensationSummary(posted, market): Record<string, unknown> {
  const postedWarnings = posted.recordStatus === "recorded" ? posted.fact.warnings.length : 0;
  const marketWarnings = market.recordStatus === "recorded" ? market.estimate.warnings.length : 0;
  return {
    projectionVersion: COMPENSATION_PROJECTION_VERSION,
    warningCount: postedWarnings + marketWarnings,
    posted: { warningCount: postedWarnings },
    market: { warningCount: marketWarnings },
  };
}
```

**Copy for Phase 21:** Add floor comparison here only if needed, because list warning count is projection-owned. The builder should read only numeric profile minimum, compute warning-only state, and include that in `warningCount` without touching sorting, scoring, apply audit, or dispatch paths.

### `apps/api/src/read-model.ts` (service, request-response, if floor DTO needed)

**Analog:** `apps/api/src/read-model.ts`

**Deserialize-only pattern** (lines 706-721):
```typescript
function parseCompensationSummary(value: string | null): JobCompensationSummary | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as JobCompensationSummary;
  } catch {
    return null;
  }
}

function parseCompensationAudit(value: string | null): JobCompensationAudit | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as JobCompensationAudit;
  } catch {
    return null;
  }
}
```

**Job detail/list placement** (lines 648-650, 1879-1882):
```typescript
employerAnalysis: parseEmployerAnalysis(detailRow?.employer_analysis_json ?? null),
requirementFitReport: parseRequirementFitReport(detailRow?.requirement_fit_report_json ?? null),
compensationAudit: parseCompensationAudit(detailRow?.compensation_audit_json ?? null),

salary: row.salary ?? "",
compensationSummary: parseCompensationSummary(row.compensation_summary_json),
```

**Copy for Phase 21:** Keep read model as JSON deserializer. Do not compute floor comparison at GET time.

### `apps/api/src/profile-store.ts` (service, CRUD, if floor DTO needed)

**Analog:** `apps/api/src/profile-store.ts`

**Existing compensation field mapping** (lines 637-642, 857-861):
```typescript
compensation: {
  salary_expectation: stringColumn(row.compensation_salary_expectation),
  salary_currency: stringColumn(row.compensation_salary_currency, "USD"),
  salary_range_min: stringColumn(row.compensation_salary_range_min),
  salary_range_max: stringColumn(row.compensation_salary_range_max),
  currency_conversion_note: stringColumn(row.compensation_currency_note),
},

text(compensation.salary_expectation),
text(compensation.salary_currency, "USD"),
text(compensation.salary_range_min),
text(compensation.salary_range_max),
text(compensation.currency_conversion_note),
```

**Copy for Phase 21:** Use only `compensation.salary_range_min` after numeric parsing in an owning API/projection helper. Ignore `salary_expectation` and other free text for this phase.

## Shared Patterns

### Table Boundaries

**Source:** `apps/web/src/views/jobs/columns.tsx`, `apps/web/src/views/jobs/JobsView.tsx`

**Apply to:** `columns.tsx`, `JobsView.test.tsx`

Use `DataGridColumn<JobSummary>` renderers for scan cells. Leave compensation columns display-only: no `sortable: true`, no salary route search fields, no server sort field, no salary filters, and no rank/apply effects.

### Drawer Audit Composition

**Source:** `apps/web/src/views/jobs/JobDetailDrawer.tsx`, `apps/web/src/views/jobs/JobAuditTriage.tsx`

**Apply to:** `JobDetailDrawer.tsx`, `JobCompensationAuditSection.tsx`, `JobDetailDrawer.test.tsx`

Use sibling `.section` blocks. Compensation audit goes after `JobAuditTriage`, before description. Use `.job-audit-metrics`, `.job-audit-tag-group`, `.tag`, and native `details.job-audit-disclosure`.

### CSS Namespacing and Horizontal Scroll

**Source:** `apps/web/src/styles/globals.css`

**Apply to:** table scan cells, drawer audit section

Extend `.jobs-data-grid-table { min-width: 1320px; }` upward for the three added columns. Add narrow `.job-compensation-*` classes. Preserve `.filterable-data-grid-scroll { overflow: auto; }` and do not collapse columns on mobile.

### Projection-Owned Floor Comparison

**Source:** `packages/contracts/src/schemas.ts`, `apps/api/src/projections.ts`, `apps/api/src/read-model.ts`, `apps/api/src/profile-store.ts`

**Apply to:** backend contract/projection only if list warning count needs floor contribution

The list warning count is currently `postedWarnings + marketWarnings` in `buildCompensationSummary`. If floor warnings are included, compute and persist them in the projection summary/audit JSON; read model should only parse JSON. Use only numeric `salary_range_min`; do not parse `salary_expectation`.

### Test Fixtures

**Source:** `apps/web/src/test/fixtures/projections.ts`

**Apply to:** Jobs view/drawer tests and a11y tests

Add safe synthetic builders rather than inline large literals in tests. Keep generated local paths, credentials, raw benchmark pages, private profile text, and provider payloads out of fixtures.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/views/jobs/JobCompensationAuditSection.tsx` | component | transform | No existing compensation audit component exists; closest pattern is `JobAuditTriage` plus `JobAuditHistorySection` disclosure. |

## Metadata

**Analog search scope:** `apps/web/src/views/jobs`, `apps/web/src/shared/ui`, `apps/web/src/styles/globals.css`, `apps/web/src/test/fixtures`, `packages/contracts/src`, `apps/api/src`
**Files scanned:** 26 targeted files plus phase inputs
**Pattern extraction date:** 2026-06-20
