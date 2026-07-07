import { WORKFLOW_RUN_STATUS_FILTERS, type WorkflowRunStatusFilter } from "@jobctrl/contracts";
import type { ChangeEvent } from "react";

export interface RunsFilterBarProps {
  status: WorkflowRunStatusFilter;
  onStatusChange: (next: WorkflowRunStatusFilter) => void;
}

function statusLabel(value: WorkflowRunStatusFilter): string {
  if (value === "all") return "all statuses";
  return value.replace(/_/g, " ");
}

export function RunsFilterBar({ status, onStatusChange }: RunsFilterBarProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as WorkflowRunStatusFilter;
    onStatusChange(next);
  };
  return (
    <div className="filter-bar">
      <label className="field">
        <span>Status</span>
        <select
          aria-label="Filter workflow runs by status"
          className="select"
          value={status}
          onChange={handleChange}
        >
          {WORKFLOW_RUN_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {statusLabel(value)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
