import type {
  WorkflowRunsListInput,
  WorkflowRunSummary,
} from "../../contexts/operations/types.js";

export const STARTING_RUNS_INPUT = {
  page: 1,
  pageSize: 12,
  status: "starting",
  sort: "started_at",
  dir: "desc",
} as const satisfies WorkflowRunsListInput;

export const IN_PROGRESS_RUNS_INPUT = {
  page: 1,
  pageSize: 12,
  status: "in_progress",
  sort: "started_at",
  dir: "desc",
} as const satisfies WorkflowRunsListInput;

const ACTIVE_RUN_STATUSES = new Set(["starting", "in_progress"]);

export function mergeActiveRuns(
  starting: readonly WorkflowRunSummary[],
  inProgress: readonly WorkflowRunSummary[],
): WorkflowRunSummary[] {
  const byWorkflowId = new Map<string, WorkflowRunSummary>();
  for (const run of [...starting, ...inProgress]) {
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      byWorkflowId.set(run.workflowId, run);
    }
  }
  return [...byWorkflowId.values()].sort(
    (left, right) => timestampMs(right.startedAt) - timestampMs(left.startedAt),
  );
}

function timestampMs(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
