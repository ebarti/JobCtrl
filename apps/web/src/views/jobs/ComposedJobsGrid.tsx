import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import type { ComposedJobRow, ComposedJobsResponse, PostingSnapshot } from "../../contexts/jobs/index.js";
import { PYTHON_JOBS_SORT_FIELDS } from "../../shared/stores/saved-table-views.js";
import {
  FilterableDataGrid, isActiveDataGridFilter, type DataGridColumn, type DataGridColorRule, type DataGridColumnWidthsState,
  type DataGridDensity, type DataGridFilterState, type DataGridGroupingState, type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";
import { JobColumnFilter, clearJobColumnCriteria, hasJobColumnCriteria, jobColumnFilterSummary } from "./JobColumnFilter.js";
import type { GridCriteria } from "./jobGridState.js";

export interface ComposedJobsGridProps {
  data: ComposedJobsResponse | undefined;
  filterMetadata: Pick<ComposedJobsResponse, "capabilities" | "facets"> | undefined;
  loading: boolean;
  error: boolean;
  selected: Readonly<Record<string, PostingSnapshot>>;
  onSelectionChange: (rows: readonly PostingSnapshot[], selected: boolean) => void;
  filters: DataGridFilterState;
  onFiltersChange: (filters: DataGridFilterState) => void;
  criteria: GridCriteria;
  onCriteriaChange: (criteria: GridCriteria, filters: DataGridFilterState) => void;
  sort: DataGridSortState;
  onSortChange: (sort: DataGridSortState) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  columnOrder: readonly string[];
  hiddenColumnIds: readonly string[];
  columnWidths: DataGridColumnWidthsState;
  onColumnOrderChange: (order: readonly string[]) => void;
  onColumnWidthsChange: (widths: DataGridColumnWidthsState) => void;
  density: DataGridDensity | null;
  grouping: DataGridGroupingState | null;
  colorRules: readonly DataGridColorRule[];
  toolbarActions: (columns: Array<DataGridColumn<ComposedJobRow>>) => ReactNode;
  activeJobId?: string | null;
  emptyMessage?: string;
}
const labels: ReadonlyArray<readonly [string, string, number]> = [
  ["title", "Title", 220], ["company", "Company", 160], ["location", "Location", 150],
  ["posted_compensation", "Posted pay", 190], ["fit_score", "Person fit", 130], ["apply_status", "Apply", 130],
  ["eligibility", "Eligibility", 150],
  ["job_state", "Job state", 150], ["source", "Source", 160],
  ["compensation_min_eur", "Salary min (€ / year)", 230], ["compensation_max_eur", "Salary max (€ / year)", 230],
  ["compensation_market", "Market (€ / year)", 220], ["compensation_confidence", "Reliability", 150],
  ["compensation_warnings", "Warnings", 120],
  ["current_stage", "Stage", 130], ["current_state", "Stage state", 130], ["resume_template", "Template", 150],
  ["discovered_at", "Discovered", 150], ["scored_at", "Fit assessed", 150],
];
const savedSortable = new Set<string>(PYTHON_JOBS_SORT_FIELDS);
const euro = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function raw(row: ComposedJobRow, id: string): string {
  if (id === "posted_compensation") return row.compensation?.summary?.posted.displayRange ?? "";
  const value = row.scalars[id];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function moduleLabel(data: ComposedJobsResponse | undefined, name: "fit" | "compensation" | "preparation" | "applications" | "resumes"): string | null {
  const state = data?.modules[name];
  return state && !state.enabled ? "Feature disabled" : state && !state.available ? "Unavailable" : null;
}
function valueFor(row: ComposedJobRow, id: string, data: ComposedJobsResponse | undefined): ReactNode {
  const scalar = row.scalars[id];
  if (id === "posted_compensation") {
    const unavailable = moduleLabel(data, "compensation");
    if (unavailable) return unavailable;
    const range = row.compensation?.summary?.posted.displayRange;
    const stale = row.compensation?.audit?.posted.sourceCurrent === false;
    if (stale) return range ? `${range} · earlier posting` : "Stale posted evidence · range unknown";
    if (range) return range;
    return row.compensation?.summary?.posted.recordStatus === "unavailable" ? "Unavailable" : "Unknown";
  }
  if (id === "title") return <Link to="/jobs/$jobId" params={{ jobId: row.job.job_id }} search={(previous) => ({ ...previous, jobTab: "fit" })}>{row.job.title}</Link>;
  if (id === "fit_score") {
    const unavailable = moduleLabel(data, "fit");
    if (unavailable) return unavailable;
    return typeof scalar === "number" ? `${scalar}/10${row.fit && !row.fit.current ? row.fit.stale_reasons?.includes("contract_changed") ? " · historical" : " · stale" : ""}`
      : row.fit?.score?.score === null ? "No score · no eligible demands" : "Not assessed";
  }
  if (id === "eligibility") return moduleLabel(data, "fit") ?? row.fit?.score?.eligibility.status ?? "Unknown";
  if (id.startsWith("compensation_")) {
    const unavailable = moduleLabel(data, "compensation");
    if (unavailable) return unavailable;
    const audit = row.compensation?.audit;
    const market = id === "compensation_market" || id === "compensation_confidence";
    const recordedRange = market ? row.compensation?.summary?.market.displayRange : row.compensation?.summary?.posted.displayRange;
    const staleMarket = audit?.market.sourceCurrent === false || audit?.market.evidenceFresh === false;
    const stale = id === "compensation_warnings" ? staleMarket || audit?.posted.sourceCurrent === false
      : market ? staleMarket : audit?.posted.sourceCurrent === false;
    if (stale) return recordedRange && id !== "compensation_confidence" && id !== "compensation_warnings" ? `Stale evidence · ${recordedRange}` : "Stale evidence";
    if (id === "compensation_confidence") return scalar === "none" ? "Not assessed" : scalar == null ? "Unknown" : String(scalar);
    if (id === "compensation_warnings") return typeof scalar === "number" ? `${scalar} ${scalar === 1 ? "warning" : "warnings"}` : "Unknown";
    if (typeof scalar !== "number") return recordedRange ? `Unknown € / year · source ${recordedRange}` : "Unknown € / year";
    if (id === "compensation_market") {
      const range = row.compensation?.summary?.market.displayRange;
      return range ?? `€ ${euro.format(scalar)} / year`;
    }
    return `€ ${euro.format(scalar)} / year`;
  }
  if (id === "current_stage" || id === "current_state") {
    if (scalar != null && scalar !== "unknown") return String(scalar);
    const preparation = moduleLabel(data, "preparation");
    const applications = moduleLabel(data, "applications");
    return preparation && applications ? "Feature unavailable" : "Unknown";
  }
  if (id === "apply_status") return moduleLabel(data, "applications") ?? (scalar == null ? "Unknown" : String(scalar));
  if (id === "resume_template") return moduleLabel(data, "resumes") ?? (scalar == null ? "Unknown" : String(scalar));
  if (id === "discovered_at" || id === "scored_at") {
    const unavailable = id === "scored_at" ? moduleLabel(data, "fit") : null;
    if (unavailable) return unavailable;
    return typeof scalar === "string" && scalar
      ? `${new Date(scalar).toLocaleDateString()}${id === "scored_at" && row.fit && !row.fit.current ? " · stale" : ""}`
      : "Unknown";
  }
  if (id === "job_state") return typeof scalar === "string" ? scalar.charAt(0).toUpperCase() + scalar.slice(1) : "Unknown";
  return scalar == null || scalar === "" ? "Unknown" : String(scalar);
}

export function ComposedJobsGrid(props: ComposedJobsGridProps) {
  const navigate = useNavigate();
  const { data, filterMetadata, selected, onSelectionChange } = props;
  const columns = useMemo<Array<DataGridColumn<ComposedJobRow>>>(() => {
    const sortable = new Set(filterMetadata?.capabilities.sortable_fields ?? []);
    const filterable = new Set(filterMetadata?.capabilities.filterable_fields ?? []);
    const selection: DataGridColumn<ComposedJobRow> = {
      id: "select", label: "Select", width: 48, reorderable: false,
      header: ({ pageRows }) => <input type="checkbox" aria-label="Select all visible jobs"
        checked={pageRows.length > 0 && pageRows.every((row) => Boolean(selected[row.job.job_id]))}
        onChange={(event) => onSelectionChange(pageRows.map((row) => row.job), event.currentTarget.checked)} />,
      render: (row) => <input type="checkbox" aria-label={`Select ${row.job.title}`} checked={Boolean(selected[row.job.job_id])}
        onChange={(event) => onSelectionChange([row.job], event.currentTarget.checked)} />,
    };
    return [selection, ...labels.map(([id, label, width]): DataGridColumn<ComposedJobRow> => ({
      id, label, width, ...(id === "title" ? { rowHeader: true } : {}), ...(id === "fit_score" ? { header: "Fit" } : {}),
      sortable: sortable.has(id) && savedSortable.has(id),
      getSortValue: (row) => id === "eligibility" ? (row.fit?.score?.eligibility.status ?? "") : raw(row, id),
      ...(filterable.has(id) || isActiveDataGridFilter(props.filters[id]) ? { getFilterValue: (row: ComposedJobRow) => raw(row, id),
        filterValues: filterMetadata?.facets[id]?.values ?? [], formatFilterValue: (value: string) => value === "" ? "Unknown (no recorded value)" : value, filterValueLimit: 200 } : {}),
      ...(hasJobColumnCriteria(id) ? {
        filterDescription: "Filter this column across all saved jobs. Text and exact-value conditions apply as you edit.",
        filterSummary: jobColumnFilterSummary(id, props.criteria),
        onClearFilter: () => props.onCriteriaChange(clearJobColumnCriteria(id, props.criteria), { ...props.filters, [id]: undefined }),
        renderFilter: ({ filter, defaultContent, predicateContent }) => <JobColumnFilter key={JSON.stringify(props.criteria)} columnId={id} criteria={props.criteria} filter={filter} literalContent={defaultContent} literalPredicate={predicateContent}
          unavailable={id === "fit_score" || id === "scored_at" ? moduleLabel(data, "fit") : id === "posted_compensation" || id.startsWith("compensation_") ? moduleLabel(data, "compensation") : null}
          onApply={(next, literal) => props.onCriteriaChange(next, literal ? { ...props.filters, [id]: literal } : props.filters)}
          onClear={() => props.onCriteriaChange(clearJobColumnCriteria(id, props.criteria), { ...props.filters, [id]: undefined })}
          onClearLiteral={() => props.onFiltersChange({ ...props.filters, [id]: undefined })} />,
      } : {}),
      render: (row) => valueFor(row, id, data),
    }))];
  }, [data, filterMetadata, selected, onSelectionChange, props.criteria, props.filters, props.onCriteriaChange, props.onFiltersChange]);
  const visibility = useMemo(() => Object.fromEntries(props.hiddenColumnIds.map((id) => [id, false])), [props.hiddenColumnIds]);
  return <FilterableDataGrid<ComposedJobRow>
    title="Jobs table" data={data?.rows ?? []} columns={columns} getRowId={(row) => row.job.job_id}
    loading={props.loading} loadingMessage="Loading jobs." emptyMessage={props.error ? "Jobs could not be loaded." : props.emptyMessage ?? "No jobs match."}
    initialSort={{ columnId: "discovered_at", direction: "desc" }} sort={props.sort} onSortChange={props.onSortChange} manualSorting
    filters={props.filters} onFiltersChange={props.onFiltersChange} manualFiltering
    columnVisibility={visibility} columnOrder={props.columnOrder} onColumnOrderChange={props.onColumnOrderChange}
    columnWidths={props.columnWidths} onColumnWidthsChange={props.onColumnWidthsChange} density={props.density}
    grouping={props.grouping} colorRules={props.colorRules} toolbarActions={props.toolbarActions(columns)} showColumnFilterMenu
    mobileLayout="cards" tableClassName="jobs-data-grid-table"
    rowAriaSelected={(row) => props.activeJobId === row.job.job_id || Boolean(selected[row.job.job_id])}
    onRowActivate={(row) => void navigate({ to: "/jobs/$jobId", params: { jobId: row.job.job_id }, search: (previous) => ({ ...previous, jobTab: "fit" }) })}
    rowActivationLabel={(row) => `Open job ${row.job.title} at ${row.job.company || "unknown company"}`}
    {...(data ? { pagination: { page: props.page, pageSize: props.pageSize, totalPages: Math.max(1, Math.ceil(data.total / props.pageSize)),
      totalRows: data.total, onPageChange: props.onPageChange, onPageSizeChange: props.onPageSizeChange } } : {})}
  />;
}
