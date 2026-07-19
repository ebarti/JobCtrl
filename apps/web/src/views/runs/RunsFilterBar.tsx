import {
  WORKFLOW_RUN_STATUS_FILTERS,
  type WorkflowRunStatusFilter,
} from "@jobctrl/contracts";
import { useEffect, useState } from "react";

import { useIsMobile } from "../../shared/hooks/use-mobile.js";
import { Button } from "../../shared/ui/button.js";
import { Field, FieldLabel } from "../../shared/ui/field.js";
import { Input } from "../../shared/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";

export interface RunFilterValues {
  status: WorkflowRunStatusFilter;
  workflowType: string;
  startedSince: string;
  startedBefore: string;
}

export interface RunsFilterBarProps extends RunFilterValues {
  summary: string;
  onChange: (next: Partial<RunFilterValues>) => void;
}

function statusLabel(value: WorkflowRunStatusFilter): string {
  const label = value === "all" ? "All statuses" : value.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function startOfUtcDay(value: string): string {
  return value ? `${value}T00:00:00.000Z` : "";
}

export function startOfNextUtcDay(value: string): string {
  if (!value) return "";
  const timestamp = Date.parse(startOfUtcDay(value));
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + 86_400_000).toISOString();
}

function inclusiveDateValue(value: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString().slice(0, 10);
}

function exclusiveDateValue(value: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp - 1).toISOString().slice(0, 10);
}

export function RunsFilterBar({
  status,
  workflowType,
  startedSince,
  startedBefore,
  summary,
  onChange,
}: RunsFilterBarProps) {
  const isMobile = useIsMobile();
  const statusItems = WORKFLOW_RUN_STATUS_FILTERS.map((value) => ({
    value,
    label: statusLabel(value),
  }));
  const [workflowTypeInput, setWorkflowTypeInput] = useState(workflowType);
  const [startedDate, setStartedDate] = useState(
    inclusiveDateValue(startedSince),
  );
  const [throughDate, setThroughDate] = useState(
    exclusiveDateValue(startedBefore),
  );

  useEffect(() => setWorkflowTypeInput(workflowType), [workflowType]);
  useEffect(
    () => setStartedDate(inclusiveDateValue(startedSince)),
    [startedSince],
  );
  useEffect(
    () => setThroughDate(exclusiveDateValue(startedBefore)),
    [startedBefore],
  );

  const hasFilters = Boolean(
    status !== "all" || workflowType || startedSince || startedBefore,
  );

  return (
    <details
      className="runs-filter-disclosure"
      open={!isMobile || hasFilters ? true : undefined}
    >
      <summary data-typography="control">
        Filter workflow runs{hasFilters ? " (active)" : ""}
      </summary>
      <form
        className="runs-filter-bar"
        aria-label="Workflow run filters"
        onSubmit={(event) => {
          event.preventDefault();
          onChange({
            workflowType: workflowTypeInput.trim(),
            startedSince: startOfUtcDay(startedDate),
            startedBefore: startOfNextUtcDay(throughDate),
          });
        }}
      >
        <Field className="runs-filter-field runs-filter-field--status">
          <FieldLabel htmlFor="workflow-run-status-filter">Status</FieldLabel>
          <Select
            items={statusItems}
            value={status}
            onValueChange={(next) => {
              if (next !== null) onChange({ status: next });
            }}
          >
            <SelectTrigger
              aria-label="Filter workflow runs by status"
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
        <Field className="runs-filter-field runs-filter-field--workflow">
          <FieldLabel htmlFor="workflow-run-type-filter">
            Workflow type
          </FieldLabel>
          <Input
            id="workflow-run-type-filter"
            placeholder="JobPipelineWorkflow"
            value={workflowTypeInput}
            onChange={(event) => setWorkflowTypeInput(event.target.value)}
          />
        </Field>
        <Field className="runs-filter-field runs-filter-field--date">
          <FieldLabel htmlFor="workflow-run-started-since">
            Started from
          </FieldLabel>
          <Input
            id="workflow-run-started-since"
            type="date"
            value={startedDate}
            onChange={(event) => setStartedDate(event.target.value)}
          />
        </Field>
        <Field className="runs-filter-field runs-filter-field--date">
          <FieldLabel htmlFor="workflow-run-started-through">
            Started through
          </FieldLabel>
          <Input
            id="workflow-run-started-through"
            type="date"
            value={throughDate}
            onChange={(event) => setThroughDate(event.target.value)}
          />
        </Field>
        <div className="runs-filter-actions">
          <Button size="sm" type="submit">
            Apply filters
          </Button>
          {hasFilters ? (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                setWorkflowTypeInput("");
                setStartedDate("");
                setThroughDate("");
                onChange({
                  status: "all",
                  workflowType: "",
                  startedSince: "",
                  startedBefore: "",
                });
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <span
          className="runs-filter-summary"
          data-typography="metadata"
          role="status"
        >
          {summary}
        </span>
      </form>
    </details>
  );
}
