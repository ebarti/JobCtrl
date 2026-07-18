import {
  WORKFLOW_RUN_STATUS_FILTERS,
  type WorkflowRunStatusFilter,
} from "@jobctrl/contracts";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";

export interface RunsFilterBarProps {
  status: WorkflowRunStatusFilter;
  onStatusChange: (next: WorkflowRunStatusFilter) => void;
}

function statusLabel(value: WorkflowRunStatusFilter): string {
  if (value === "all") return "all statuses";
  return value.replace(/_/g, " ");
}

export function RunsFilterBar({ status, onStatusChange }: RunsFilterBarProps) {
  const statusItems = WORKFLOW_RUN_STATUS_FILTERS.map((value) => ({
    value,
    label: statusLabel(value),
  }));
  return (
    <div className="filter-bar">
      <Field className="field">
        <FieldLabel htmlFor="workflow-run-status-filter">Status</FieldLabel>
        <Select
          items={statusItems}
          value={status}
          onValueChange={(next) => {
            if (next !== null) onStatusChange(next);
          }}
        >
          <SelectTrigger
            aria-label="Filter workflow runs by status"
            className="w-full min-w-40"
            id="workflow-run-status-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
