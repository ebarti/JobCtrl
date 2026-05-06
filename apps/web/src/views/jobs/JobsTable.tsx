import type { JobSortField, JobSummary, PaginatedResponse } from "@jobhunter/contracts";

import { stateTone } from "../../contexts/pipeline/lib/state-tone.js";
import { scoreTier } from "../../contexts/scoring/lib/score-tier.js";
import { formatCompanySource } from "../../shared/lib/formatters.js";
import { Empty } from "../../shared/ui/empty.js";

export type JobSortColumn = Extract<
  JobSortField,
  | "discovered_at"
  | "title"
  | "company"
  | "location"
  | "fit_score"
  | "current_stage"
  | "current_state"
>;

const COLUMNS: ReadonlyArray<{ readonly field: JobSortColumn; readonly label: string }> = [
  { field: "fit_score", label: "Fit score" },
  { field: "title", label: "Title" },
  { field: "company", label: "Company" },
  { field: "location", label: "Location" },
  { field: "current_stage", label: "Stage" },
  { field: "current_state", label: "State" },
  { field: "discovered_at", label: "Discovered" },
];

export type Direction = "asc" | "desc";

export interface JobsTableProps {
  data: PaginatedResponse<JobSummary> | null;
  loading: boolean;
  sort: JobSortField;
  dir: Direction;
  selectedJobs: ReadonlySet<string>;
  allMatchingSelected: boolean;
  onChangeSort: (field: JobSortColumn) => void;
  onToggleSelection: (jobKey: string, selected: boolean) => void;
  onOpenJob: (jobKey: string) => void;
}

export function JobsTable({
  data,
  loading,
  sort,
  dir,
  selectedJobs,
  allMatchingSelected,
  onChangeSort,
  onToggleSelection,
  onOpenJob,
}: JobsTableProps) {
  return (
    <div className="table">
      <div className="data-row job job-header" role="row">
        <span aria-hidden="true" />
        {COLUMNS.map((column) => (
          <button
            key={column.field}
            type="button"
            aria-sort={
              sort === column.field ? (dir === "asc" ? "ascending" : "descending") : "none"
            }
            className={sort === column.field ? "sort-head active" : "sort-head"}
            onClick={() => onChangeSort(column.field)}
          >
            {column.label}
            {sort === column.field ? (
              <span aria-hidden="true">{dir === "asc" ? " ↑" : " ↓"}</span>
            ) : null}
          </button>
        ))}
      </div>
      {loading && !data ? <Empty title="Loading jobs." /> : null}
      {data?.items.map((job) => (
        <div
          key={job.jobKey}
          role="button"
          tabIndex={0}
          className="data-row job"
          onClick={() => onOpenJob(job.jobKey)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenJob(job.jobKey);
            }
          }}
        >
          <span className="row-check">
            <input
              aria-label={`Select ${job.title}`}
              type="checkbox"
              checked={allMatchingSelected || selectedJobs.has(job.jobKey)}
              onChange={(event) => onToggleSelection(job.jobKey, event.target.checked)}
              onClick={(event) => event.stopPropagation()}
            />
          </span>
          <span className={`fit ${scoreTier(job.fitScore)}`}>{job.fitScore ?? "-"}</span>
          <span className="title-stack">
            <b>{job.title}</b>
          </span>
          <span className="muted-cell">{formatCompanySource(job.company, job.source)}</span>
          <span>{job.location || "-"}</span>
          <span className="stage-pill">{job.currentStage}</span>
          <span className={`tag ${stateTone(job.currentState)}`}>{job.currentState}</span>
          <span className="mono">
            {job.discoveredAt ? new Date(job.discoveredAt).toLocaleDateString() : "-"}
          </span>
        </div>
      ))}
      {data && data.items.length === 0 ? <Empty title="No jobs match." /> : null}
    </div>
  );
}
