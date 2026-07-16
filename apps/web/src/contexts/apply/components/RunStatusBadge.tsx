import type { JSX } from "react";

import type { WorkflowRunStatus } from "@jobctrl/contracts";
import { IconBan, IconClock, type TablerIcon } from "@tabler/icons-react";

import { assertNever } from "../../../shared/lib/exhaustive.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import type { ApplyRunTone } from "../lib/apply-run-tone.js";

export interface RunStatusBadgeProps {
  status: WorkflowRunStatus;
}

/**
 * Badge for the wider workflow-run state set (PR 5 of the Temporal stack).
 *
 * Reuses the same semantic tone vocabulary as `ApplyRunBadge`. Apply uses a
 * narrower `ApplyRunStatus`; Temporal-driven workflow runs add
 * `canceled` / `terminated` / `timed_out` lifecycle terminals.
 */
export function RunStatusBadge({ status }: RunStatusBadgeProps): JSX.Element {
  const tone: ApplyRunTone = workflowRunStatusTone(status);
  return (
    <StatusBadge icon={workflowRunStatusIcon(status)} tone={tone}>
      {statusLabel(status)}
    </StatusBadge>
  );
}

function workflowRunStatusIcon(
  status: WorkflowRunStatus,
): TablerIcon | undefined {
  if (status === "starting" || status === "in_progress") return IconClock;
  if (status === "canceled" || status === "terminated") return IconBan;
  return undefined;
}

function workflowRunStatusTone(status: WorkflowRunStatus): ApplyRunTone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "starting":
    case "in_progress":
      return "info";
    case "captcha":
    case "login_issue":
    case "manual":
      return "warn";
    case "failed":
    case "expired":
    case "terminated":
    case "timed_out":
      return "danger";
    case "canceled":
    case "dry_run_complete":
      return "muted";
    default:
      return assertNever(status);
  }
}

function statusLabel(status: WorkflowRunStatus): string {
  switch (status) {
    case "in_progress":
      return "in progress";
    case "dry_run_complete":
      return "dry-run complete";
    case "login_issue":
      return "login issue";
    case "timed_out":
      return "timed out";
    default:
      return status;
  }
}
