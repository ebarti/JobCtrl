import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "@jobctrl/contracts";

import { assertNever } from "../../shared/lib/exhaustive.js";
import type { StatusDotState } from "../../shared/ui/status-tokens.js";

const WORKFLOW_RUN_STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_RUN_STATUSES);

function normalizeApplyRunStatus(status: string): WorkflowRunStatus {
  if (WORKFLOW_RUN_STATUS_SET.has(status)) {
    return status as WorkflowRunStatus;
  }
  if (status === "finished") {
    return "succeeded";
  }
  return "in_progress";
}

export function applyRunDotState(status: string): StatusDotState {
  const normalized = normalizeApplyRunStatus(status);
  switch (normalized) {
    case "starting":
    case "in_progress":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "expired":
    case "terminated":
    case "timed_out":
      return "failed";
    case "captcha":
    case "login_issue":
    case "manual":
      return "blocked";
    case "dry_run_complete":
      return "skipped";
    case "canceled":
      return "canceled";
    default:
      return assertNever(normalized);
  }
}
