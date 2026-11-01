import type { WorkflowRunsListInput } from "./types.js";

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
