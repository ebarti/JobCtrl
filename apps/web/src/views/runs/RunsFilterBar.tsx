import { WORKFLOW_RUN_STATUS_FILTERS, type WorkflowRunStatusFilter } from "@jobctrl/contracts";

import { SelectField } from "../../shared/ui/select-field.js";
import { ToolRow } from "../../shared/ui/tool-row.js";

export interface RunsFilterBarProps {
  status: WorkflowRunStatusFilter;
  onStatusChange: (next: WorkflowRunStatusFilter) => void;
}

function statusLabel(value: WorkflowRunStatusFilter): string {
  if (value === "all") return "all statuses";
  return value.replace(/_/g, " ");
}

export function RunsFilterBar({ status, onStatusChange }: RunsFilterBarProps) {
  return (
    <ToolRow
      className="data-surface__tools"
      primary={
        <SelectField
          className="tool-row__field"
          label="Status"
          value={status}
          onValueChange={(value) => onStatusChange(value as WorkflowRunStatusFilter)}
          options={WORKFLOW_RUN_STATUS_FILTERS.map((value) => ({
            value,
            label: statusLabel(value),
          }))}
        />
      }
    />
  );
}
