import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SavedTableView } from "@jobctrl/contracts";
import { z } from "zod";

import { useJobActions, useJobBulkActions, useComposedJobs, useJobGridSelectionStore, type JobGridQuery, type PostingSnapshot } from "../../contexts/jobs/index.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { useEventStreamStatus } from "../../shared/providers/EventStreamProvider.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { DEFAULT_JOBS_HIDDEN_COLUMN_IDS, DEFAULT_SAVED_TABLE_VIEW_ID, JOBS_TABLE_COLUMN_IDS, JOBS_TABLE_ID,
  usePythonJobsTableViewsStore, type SavedTablePresentation, type SavedTableViewSnapshot } from "../../shared/stores/saved-table-views.js";
import { SavedTableViewsControl } from "../../shared/ui/saved-table-views-control.js";
import { isActiveDataGridFilter, type DataGridFilterState, type DataGridSortState } from "../../shared/ui/filterable-data-grid.js";
import { AdvancedJobFilters } from "./AdvancedJobFilters.js";
import { ComposedJobsGrid } from "./ComposedJobsGrid.js";
import { criteriaFromQuery, defaultCriteria, restoreView, savedFilters, type GridCriteria } from "./jobGridState.js";

const captureSchema = z.object({ url: z.string().url(), title: z.string().trim().min(1), company: z.string(), description: z.string().trim().min(1), location: z.string() });
const urlSchema = z.string().url();
const unavailableFieldsSchema = z.object({ error: z.object({ code: z.literal("query_feature_unavailable"), details: z.object({ fields: z.array(z.string()) }).passthrough() }).passthrough() }).passthrough();
const EMPTY_SELECTION: Readonly<Record<string, PostingSnapshot>> = {};
const EMPTY_FILTERS: DataGridFilterState = {};
const DEFAULT_PRESENTATION: SavedTablePresentation = { columns: { order: [...JOBS_TABLE_COLUMN_IDS], hidden: [...DEFAULT_JOBS_HIDDEN_COLUMN_IDS], widths: {} }, density: null, grouping: null, colorRules: [] };
function initialSavedView() {
  const state = usePythonJobsTableViewsStore.getState();
  const id = state.activeViewIdByTable[JOBS_TABLE_ID] ?? DEFAULT_SAVED_TABLE_VIEW_ID;
  return restoreView(state.views.find((view) => view.tableId === JOBS_TABLE_ID && view.id === id));
}
function gridQuery(criteria: GridCriteria, filters: DataGridFilterState, sort: DataGridSortState, offset: number, limit: number, revision: string | null): JobGridQuery {
  const active = Object.fromEntries(Object.entries(filters).filter(([, value]) => isActiveDataGridFilter(value)));
  return { q: criteria.q, job_state: criteria.jobState, fit_state: criteria.fitState, sort: sort.columnId, direction: sort.direction, offset, limit,
    posted_known: criteria.postedKnown, market_known: criteria.marketKnown,
    ...(criteria.compensationConfidence ? { compensation_confidence: criteria.compensationConfidence } : {}), compensation_warnings: criteria.compensationWarnings,
    ...(criteria.minFitScore !== undefined ? { min_fit_score: criteria.minFitScore } : {}), ...(criteria.maxFitScore !== undefined ? { max_fit_score: criteria.maxFitScore } : {}),
    ...(criteria.discoveredSince ? { discovered_since: criteria.discoveredSince } : {}), ...(criteria.scoredSince ? { scored_since: criteria.scoredSince } : {}),
    ...(criteria.postedMinEur !== undefined ? { posted_min_eur: criteria.postedMinEur } : {}), ...(criteria.postedMaxEur !== undefined ? { posted_max_eur: criteria.postedMaxEur } : {}),
    ...(criteria.marketMinEur !== undefined ? { market_min_eur: criteria.marketMinEur } : {}), ...(criteria.marketMaxEur !== undefined ? { market_max_eur: criteria.marketMaxEur } : {}),
    ...(offset > 0 && revision ? { query_revision: revision } : {}),
    ...(Object.keys(active).length ? { column_filters: active } : {}) };
}

function CaptureJob() {
  const { capture, importUrl } = useJobActions();
  const { featureFlags } = usePorts();
  const importAvailability = getApiCapabilityAvailability(featureFlags, "importJobUrl");
  const [validation, setValidation] = useState("");
  const form = useForm({ defaultValues: { url: "", title: "", company: "", description: "", location: "" }, onSubmit: async ({ value }) => {
    const parsed = captureSchema.safeParse(value);
    if (!parsed.success) { setValidation("Enter a valid URL, title and posting description."); return; }
    setValidation("");
    try { await capture.mutateAsync(parsed.data); form.reset(); } catch { /* Retain entered content for correction or retry. */ }
  } });
  const urlForm = useForm({ defaultValues: { url: "" }, onSubmit: async ({ value }) => {
    if (!importAvailability.available) return;
    const parsed = urlSchema.safeParse(value.url);
    if (!parsed.success) { setValidation("Enter a valid posting URL."); return; }
    setValidation("");
    try { await importUrl.mutateAsync(parsed.data); urlForm.reset(); } catch { /* Retain URL for retry. */ }
  } });
  return <section className="card" aria-label="Add a job">
    <h2>Add a job</h2>
    <details><summary>Import posting URL</summary><form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void urlForm.handleSubmit(); }}>
      <urlForm.Field name="url">{(field) => <label>Posting URL<input type="url" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</urlForm.Field>
      <Button type="submit" disabled={!importAvailability.available || importUrl.isPending}>Import job</Button>
      {!importAvailability.available ? <p>{importAvailability.reason}</p> : null}
    </form></details>
    <details><summary>Manual capture</summary><form onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit(); }}>
      <form.Field name="url">{(field) => <label>Posting URL<input type="url" value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="title">{(field) => <label>Job title<input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="company">{(field) => <label>Company<input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="location">{(field) => <label>Location<input value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <form.Field name="description">{(field) => <label>Posting description<textarea value={field.state.value} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.currentTarget.value)} /></label>}</form.Field>
      <Button type="submit" disabled={capture.isPending}>Save job</Button>
    </form></details>
    {validation ? <p role="alert">{validation}</p> : null}
    {capture.error || importUrl.error ? <p role="alert">{(capture.error ?? importUrl.error)?.message}</p> : null}
    {capture.data || importUrl.data ? <p role="status">Job captured. <Link to="/jobs/$jobId" params={{ jobId: (capture.data ?? importUrl.data)!.job_id }} search={(previous) => previous}>Open job</Link></p> : null}
  </section>;
}

export function JobsView({ optionalBulkActions, optionalGlobalActions, navigation = null, onNavigationChange }: {
  optionalBulkActions?: (selectedJobIds: readonly string[]) => ReactNode;
  optionalGlobalActions?: ReactNode;
  navigation?: JobGridQuery | null;
  onNavigationChange?: (next: JobGridQuery) => string | null;
} = {}) {
  const [initial] = useState(initialSavedView);
  const [fallback] = useState(() => gridQuery(initial.criteria, initial.filters, initial.sort, 0, initial.pageSize, null));
  const [unrouted, setUnrouted] = useState(fallback);
  const [navigationError, setNavigationError] = useState("");
  const queryInput = navigation ?? unrouted;
  const criteria = useMemo(() => criteriaFromQuery(queryInput), [queryInput]);
  const filters = queryInput.column_filters ?? EMPTY_FILTERS;
  const sort: DataGridSortState = { columnId: queryInput.sort, direction: queryInput.direction };
  const pageSize = queryInput.limit; const offset = queryInput.offset;
  const [draft, setDraft] = useState(criteria.q);
  const [confirmation, setConfirmation] = useState("");
  const [previewScope, setPreviewScope] = useState<string | null>(null);
  const [filtersVersion, setFiltersVersion] = useState(0);
  const { session } = usePorts();
  const tenant = useTenantId();
  const streamStatus = useEventStreamStatus();
  const selection = useJobGridSelectionStore((state) => state.current);
  const updateSelection = useJobGridSelectionStore((state) => state.update);
  const clearStoredSelection = useJobGridSelectionStore((state) => state.clear);
  const selectionScope = JSON.stringify({ criteria, filters, sort, pageSize });
  const selected = streamStatus !== "workspace_changed" && selection?.session === session && selection.tenant === tenant && selection.scope === selectionScope ? selection.rows : EMPTY_SELECTION;
  const presentation = usePythonJobsTableViewsStore((state) => state.presentationByTable[JOBS_TABLE_ID]) ?? DEFAULT_PRESENTATION;
  const setPresentation = usePythonJobsTableViewsStore((state) => state.setTablePresentation);
  const jobs = useComposedJobs(queryInput);
  const currentJobs = jobs.isPlaceholderData ? undefined : jobs.data;
  const filterMetadata = streamStatus === "workspace_changed" ? undefined : jobs.data;
  const { bulk, previewDelete, permanentDelete } = useJobBulkActions();
  useEffect(() => { if (!navigation && onNavigationChange) { const error = onNavigationChange(fallback); if (error) setNavigationError(error); } }, [navigation, onNavigationChange, fallback]);
  useEffect(() => { setDraft(criteria.q); }, [criteria.q]);
  useEffect(() => { if (streamStatus === "workspace_changed") clearStoredSelection(session, tenant); }, [streamStatus, clearStoredSelection, session, tenant]);
  const selectedRows = Object.values(selected); const selectedIds = selectedRows.map((job) => job.job_id);
  const selectionFingerprint = JSON.stringify(selectedRows.map((job) => [job.job_id, job.revision, job.state_revision]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  const preview = previewScope === selectionFingerprint ? previewDelete.data : undefined;
  const clearSelection = () => { clearStoredSelection(session, tenant); previewDelete.reset(); setPreviewScope(null); setConfirmation(""); };
  const pending = bulk.isPending || previewDelete.isPending || permanentDelete.isPending;
  const onBulk = (action: "hide" | "unhide" | "delete" | "restore") => {
    const submittedSelection = selection;
    bulk.mutate({ action, selected: selectedRows }, { onSuccess: () => { if (useJobGridSelectionStore.getState().current === submittedSelection) clearSelection(); } });
  };
  const changeQuery = (next: JobGridQuery, clear = true) => {
    const error = onNavigationChange?.(next) ?? null;
    if (error) { setNavigationError(error); return false; }
    setNavigationError("");
    if (!onNavigationChange) setUnrouted(next);
    if (clear) clearSelection();
    return true;
  };
  const updateCriteria = (next: GridCriteria) => changeQuery(gridQuery(next, filters, sort, 0, pageSize, null));
  const applyView = (view: SavedTableView) => {
    const next = restoreView(view);
    if (changeQuery(gridQuery(next.criteria, next.filters, next.sort, 0, next.pageSize, null))) setFiltersVersion((version) => version + 1);
  };
  const snapshot: SavedTableViewSnapshot = { ...presentation, sort, urlFilters: savedFilters(criteria, pageSize), gridFilters: filters };
  const hasLimitedFacets = Object.values(currentJobs?.facets ?? {}).some((facet) => !facet.complete);
  const errorBody = jobs.error && "responseBody" in jobs.error ? jobs.error.responseBody : undefined;
  const unavailableFields = unavailableFieldsSchema.safeParse(errorBody);
  const unavailable = currentJobs ? (["fit", "preparation", "compensation", "applications", "resumes"] as const)
    .flatMap((name) => { const state = currentJobs.modules[name]; return state && (!state.enabled || !state.available) ? [{ name, state }] : []; }) : [];
  return <div className="route-page">
    <PageHead eyebrow="Search" title="Jobs" subtitle="Captured postings and their saved source snapshots" />
    <CaptureJob />
    <section className="card" aria-label="Captured jobs">
      {optionalGlobalActions ? <div className="toolbar" aria-label="Job maintenance">{optionalGlobalActions}</div> : null}
      <form onSubmit={(event) => { event.preventDefault(); updateCriteria({ ...criteria, q: draft }); }}>
        <label>Search jobs<input value={draft} onChange={(event) => setDraft(event.currentTarget.value)} /></label>
        <Button type="submit" variant="outline">Search</Button>
      </form>
      <AdvancedJobFilters key={`${filtersVersion}:${JSON.stringify({ ...criteria, q: "" })}`} criteria={criteria} onApply={updateCriteria} />
      <Button type="button" variant="outline" onClick={() => { if (changeQuery(gridQuery(defaultCriteria, {}, { columnId: "discovered_at", direction: "desc" }, 0, pageSize, null))) setFiltersVersion((version) => version + 1); }}>Clear all filters</Button>
      {navigationError ? <p role="alert">{navigationError}</p> : null}
      {jobs.isPlaceholderData ? <p role="status">Updating jobs. Filter options reflect the previous results until loading finishes.</p> : null}
      {unavailable.length ? <p role="status">Unavailable features: {unavailable.map(({ name, state }) => `${name} (${state.enabled ? "unavailable" : "disabled"})`).join(", ")}. Their saved criteria remain in effect and can be cleared.</p> : null}
      {hasLimitedFacets ? <p>Some filter value lists are limited; use the text predicate to search the full result set.</p> : null}
      {presentation.grouping ? <p>Groups organize the current page; sorting and filtering apply to all matching jobs.</p> : null}
      {selectedRows.length ? <div className="toolbar" aria-label="Selected jobs actions">
        <span>{selectedRows.length} selected</span>
        <Button type="button" variant="outline" disabled={pending || selectedRows.some((job) => job.deleted || job.hidden)} onClick={() => onBulk("hide")}>Hide selected</Button>
        <Button type="button" variant="outline" disabled={pending || selectedRows.some((job) => job.deleted || !job.hidden)} onClick={() => onBulk("unhide")}>Unhide selected</Button>
        <Button type="button" variant="outline" disabled={pending || selectedRows.some((job) => job.deleted)} onClick={() => onBulk("delete")}>Move selected to deleted</Button>
        <Button type="button" variant="outline" disabled={pending || selectedRows.some((job) => !job.deleted)} onClick={() => onBulk("restore")}>Restore selected</Button>
        <Button type="button" variant="outline" disabled={pending || selectedRows.some((job) => !job.deleted)} onClick={() => { setConfirmation(""); setPreviewScope(selectionFingerprint); previewDelete.mutate(selectedIds); }}>Review permanent deletion</Button>
        {optionalBulkActions?.(selectedIds)}
        <Button type="button" variant="ghost" disabled={pending} onClick={clearSelection}>Clear selection</Button>
      </div> : null}
      {bulk.error || previewDelete.error || permanentDelete.error ? <p role="alert">{(bulk.error ?? previewDelete.error ?? permanentDelete.error)?.message} The saved job selection remains available.</p> : null}
      {preview ? <section aria-label="Review permanent deletion"><h2>Review permanent deletion</h2>
        <p>This permanently removes {preview.count} selected job(s) and their job-owned records. The selection expires at {preview.expiresAt}.</p>
        <p>{preview.retentionNotice}</p>
        <ul>{preview.jobs.map((job) => <li key={job.job_id}>{job.title}{job.company ? ` · ${job.company}` : ""} ({job.job_id})</li>)}</ul>
        <label>Type DELETE to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} /></label>
        <Button type="button" disabled={pending || confirmation !== "DELETE"} onClick={() => { const submittedSelection = selection; permanentDelete.mutate({ selectionId: preview.selectionId, jobIds: preview.jobIds }, { onSuccess: () => { if (useJobGridSelectionStore.getState().current === submittedSelection) clearSelection(); } }); }}>Permanently delete reviewed jobs</Button>
      </section> : null}
      {jobs.error ? <div role="alert">{jobs.error.message}{unavailableFields.success ? ` Unavailable criteria: ${unavailableFields.data.error.details.fields.join(", ")}.` : ""}{currentJobs ? " Showing the previously loaded page." : ""}{" "}<Button type="button" variant="outline" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}>Retry loading jobs</Button>{offset > 0 ? <Button type="button" variant="outline" onClick={() => { changeQuery(gridQuery(criteria, filters, sort, 0, pageSize, null), false); }}>Reload from first page</Button> : null}</div> : null}
      <ComposedJobsGrid data={currentJobs} filterMetadata={filterMetadata} loading={jobs.isPending || jobs.isFetching} error={Boolean(jobs.error)} selected={selected}
        onSelectionChange={(rows, checked) => { updateSelection(session, tenant, selectionScope, rows, checked); previewDelete.reset(); setPreviewScope(null); setConfirmation(""); }}
        filters={filters} onFiltersChange={(next) => { changeQuery(gridQuery(criteria, next, sort, 0, pageSize, null)); }}
        sort={sort} onSortChange={(next) => { changeQuery(gridQuery(criteria, filters, next, 0, pageSize, null)); }}
        page={Math.floor(offset / pageSize) + 1} pageSize={pageSize} onPageChange={(page) => {
          const revision = page === 1 ? null : currentJobs?.query_revision ?? queryInput.query_revision ?? null;
          if (page > 1 && !revision) { setNavigationError("Reload the first page before continuing."); return; }
          changeQuery(gridQuery(criteria, filters, sort, (page - 1) * pageSize, pageSize, revision), false);
        }}
        onPageSizeChange={(size) => { changeQuery(gridQuery(criteria, filters, sort, 0, size, null)); }}
        columnOrder={presentation.columns.order} hiddenColumnIds={presentation.columns.hidden} columnWidths={presentation.columns.widths}
        onColumnOrderChange={(order) => setPresentation(JOBS_TABLE_ID, { ...presentation, columns: { ...presentation.columns, order: [...order] } })}
        onColumnWidthsChange={(widths) => setPresentation(JOBS_TABLE_ID, { ...presentation, columns: { ...presentation.columns, widths } })}
        density={presentation.density} grouping={presentation.grouping} colorRules={presentation.colorRules}
        toolbarActions={(columns) => <SavedTableViewsControl tableId={JOBS_TABLE_ID} useViewsStore={usePythonJobsTableViewsStore} columnOptions={columns.map((column) => ({ id: column.id, label: column.label, ...(column.id === "select" ? { locked: true } : {}) }))} snapshot={snapshot} onApplyView={applyView} onPresentationChange={(next) => setPresentation(JOBS_TABLE_ID, next)} />}
      />
    </section>
  </div>;
}
