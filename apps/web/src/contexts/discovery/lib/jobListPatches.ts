import type { JobSummary, PaginatedResponse } from "../../operations/types.js";

function isJobsPage(value: unknown): value is PaginatedResponse<JobSummary> {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    "pagination" in value &&
    Array.isArray((value as PaginatedResponse<JobSummary>).items)
  );
}

export function patchListRemove(current: unknown, jobIds: ReadonlySet<string>): unknown {
  if (!isJobsPage(current)) {
    return current;
  }
  const removed = current.items.filter((job) => jobIds.has(job.jobKey));
  if (removed.length === 0) {
    return current;
  }
  return {
    ...current,
    items: current.items.filter((job) => !jobIds.has(job.jobKey)),
    pagination: {
      ...current.pagination,
      total: Math.max(0, current.pagination.total - removed.length),
    },
  };
}
