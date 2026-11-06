import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import type { ComposedJobRow, ComposedJobsResponse, PostingSnapshot } from "../../contexts/jobs/index.js";
import { PYTHON_JOBS_SORT_FIELDS } from "../../shared/stores/saved-table-views.js";
import {
  FilterableDataGrid, type DataGridColumn, type DataGridColorRule, type DataGridColumnWidthsState,
  type DataGridDensity, type DataGridFilterState, type DataGridGroupingState, type DataGridSortState,
} from "../../shared/ui/filterable-data-grid.js";

export interface ComposedJobsGridProps {
  data: ComposedJobsResponse | undefined;
  filterMetadata: Pick<ComposedJobsResponse, "capabilities" | "facets"> | undefined;
  loading: boolean;
  error: boolean;
  selected: Readonly<Record<string, PostingSnapshot>>;
  onSelectionChange: (rows: readonly PostingSnapshot[], selected: boolean) => void;
  filters: DataGridFilterState;
  onFiltersChange: (filters: DataGridFilterState) => void;
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
}
const labels: ReadonlyArray<readonly [string, string, number]> = [
  ["fit_score", "Person fit", 110], ["eligibility", "Eligibility", 120], ["title", "Title", 230], ["company", "Company", 150],
  ["job_state", "Job state", 120], ["source", "Source", 160],
  ["compensation_min_eur", "Salary min (€ / year)", 170], ["compensation_max_eur", "Salary max (€ / year)", 170],
  ["compensation_market", "Market (€ / year)", 180], ["compensation_confidence", "Reliability", 130],
  ["compensation_warnings", "Warnings", 120], ["location", "Location", 150],
  ["current_stage", "Stage", 130], ["current_state", "Stage state", 130], ["resume_template", "Template", 150],
  ["discovered_at", "Discovered", 150], ["scored_at", "Fit assessed", 150], ["apply_status", "Apply", 130],
];
const savedSortable = new Set<string>(PYTHON_JOBS_SORT_FIELDS);
const euro = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function raw(row: ComposedJobRow, id: string): string {
  const value = row.scalars[id];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function moduleLabel(data: ComposedJobsResponse | undefined, name: "fit" | "compensation" | "preparation" | "applications" | "resumes"): string | null {
  const state = data?.modules[name];
  return state && !state.enabled ? "Feature disabled" : state && !state.available ? "Unavailable" : null;
}
function valueFor(row: ComposedJobRow, id: string, data: ComposedJobsResponse | undefined): ReactNode {
  const scalar = row.scalars[id];
  if (id === "title") return <Link to="/jobs/$jobId" params={{ jobId: row.job.job_id }} search={(previous) => previous}>{row.job.title}</Link>;
  if (id === "fit_score") {
    const unavailable = moduleLabel(data, "fit");
    if (unavailable) return unavailable;
    return typeof scalar === "number" ? `${scalar}/10${row.fit && !row.fit.current ? " · stale" : ""}` : "Not assessed";
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
      id, label, width, ...(id === "title" ? { rowHeader: true } : {}),
      sortable: sortable.has(id) && savedSortable.has(id),
      getSortValue: (row) => id === "eligibility" ? (row.fit?.score?.eligibility.status ?? "") : raw(row, id),
      ...(filterable.has(id) ? { getFilterValue: (row: ComposedJobRow) => raw(row, id),
        filterValues: filterMetadata?.facets[id]?.values ?? [], formatFilterValue: (value: string) => value === "" ? "Unknown (no recorded value)" : value, filterValueLimit: 200 } : {}),
      render: (row) => valueFor(row, id, data),
    }))];
  }, [data, filterMetadata, selected, onSelectionChange]);
  const visibility = useMemo(() => Object.fromEntries(props.hiddenColumnIds.map((id) => [id, false])), [props.hiddenColumnIds]);
  return <FilterableDataGrid<ComposedJobRow>
    title="Jobs table" data={data?.rows ?? []} columns={columns} getRowId={(row) => row.job.job_id}
    loading={props.loading} loadingMessage="Loading jobs." emptyMessage={props.error ? "Jobs could not be loaded." : "No jobs match."}
    initialSort={{ columnId: "discovered_at", direction: "desc" }} sort={props.sort} onSortChange={props.onSortChange} manualSorting
    filters={props.filters} onFiltersChange={props.onFiltersChange} manualFiltering
    columnVisibility={visibility} columnOrder={props.columnOrder} onColumnOrderChange={props.onColumnOrderChange}
    columnWidths={props.columnWidths} onColumnWidthsChange={props.onColumnWidthsChange} density={props.density}
    grouping={props.grouping} colorRules={props.colorRules} toolbarActions={props.toolbarActions(columns)}
    mobileLayout="cards" tableClassName="jobs-data-grid-table"
    rowAriaSelected={(row) => Boolean(selected[row.job.job_id])}
    onRowActivate={(row) => void navigate({ to: "/jobs/$jobId", params: { jobId: row.job.job_id }, search: (previous) => previous })}
    rowActivationLabel={(row) => `Open job ${row.job.title} at ${row.job.company || "unknown company"}`}
    {...(data ? { pagination: { page: props.page, pageSize: props.pageSize, totalPages: Math.max(1, Math.ceil(data.total / props.pageSize)),
      totalRows: data.total, onPageChange: props.onPageChange, onPageSizeChange: props.onPageSizeChange } } : {})}
  />;
}
