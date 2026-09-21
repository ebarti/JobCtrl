import {
  JobListQuerySchema,
  filterJob as sharedFilterJob,
  type JobListQuery,
  type JobSummary,
} from "@jobctrl/contracts";

const CLOSED_ACTIVE_STATES = new Set([
  "closed",
  "expired",
  "removed",
  "location_incompatible",
]);

export function filterDemoJob(
  job: JobSummary,
  query: JobListQuery,
  normalizedQuery: string,
): boolean {
  const closed = CLOSED_ACTIVE_STATES.has(job.activeState);
  if (query.jobStates) {
    const jobState = job.hiddenAt
      ? "hidden"
      : job.deletedAt
        ? "deleted"
        : "active";
    if (!query.jobStates.includes(jobState)) return false;
    if (jobState === "active" && closed) return false;
    return sharedFilterJob(job, query, normalizedQuery);
  }
  if (query.deleted === "active" && (job.deletedAt || job.hiddenAt || closed))
    return false;
  if (query.deleted === "closed" && (job.deletedAt || job.hiddenAt || !closed))
    return false;
  if (query.deleted === "deleted" && (!job.deletedAt || job.hiddenAt))
    return false;
  if (query.deleted === "hidden" && !job.hiddenAt) return false;
  return sharedFilterJob(job, query, normalizedQuery);
}

export function matchingDemoJobKeys(
  jobs: readonly JobSummary[],
  filter: unknown,
): string[] {
  const query = JobListQuerySchema.parse(filter);
  const normalizedQuery = query.q.toLowerCase();
  return jobs
    .filter((job) => filterDemoJob(job, query, normalizedQuery))
    .map((job) => job.jobKey);
}
