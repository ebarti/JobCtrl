/**
 * Shared jobs-list query semantics: filtering, sorting, and pagination over
 * `JobSummary` rows.
 *
 * Two adapters consume this module: the local API's read model (SQLite-backed
 * rows) and the demo workspace's in-memory adapter. Both previously carried
 * hand-copied twins of these functions, with agreement asserted only by
 * hand-re-encoded test expectations; a filter or sort fix now lands once.
 *
 * The `deleted` facet (applied in SQL WHERE by the read model) stays in the
 * demo's wrapper. Text ordering uses the browser merger's lowercase locale
 * comparison on every path, including searched lists.
 */

import type { JobCompensationSummary, JobListQuery, JobSummary, PaginatedResponse, Stage, StageState } from "./schemas.js";

/** Terminal-first ranking used by the current_state sort arm. */
export const STATE_RANK: Readonly<Record<StageState, number>> = {
  failed: 0,
  exhausted: 1,
  needs_verification: 2,
  blocked: 3,
  running: 4,
  queued: 5,
  pending: 6,
  stale: 7,
  canceled: 8,
  skipped: 9,
  succeeded: 10,
};

export function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined || left === "") return -1;
  if (right === null || right === undefined || right === "") return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function timestampAtOrAfter(value: string | null | undefined, since: string): boolean {
  if (!value) return false;
  const valueTime = Date.parse(value);
  const sinceTime = Date.parse(since);
  return Number.isFinite(valueTime) && Number.isFinite(sinceTime) && valueTime >= sinceTime;
}

export function timestampBefore(value: string | null | undefined, before: string): boolean {
  if (!value) return false;
  const valueTime = Date.parse(value);
  const beforeTime = Date.parse(before);
  return Number.isFinite(valueTime) && Number.isFinite(beforeTime) && valueTime < beforeTime;
}

/**
 * The filter core shared by the read model and the demo. The `deleted`
 * facet is intentionally absent: the read model resolves it in SQL, and the
 * demo's wrapper applies it before delegating here.
 */
export function filterJob(job: JobSummary, query: JobListQuery, normalizedQuery: string): boolean {
  const stages = effectiveJobStages(query);
  if (stages.length && !stages.includes(job.currentStage)) return false;
  // API summaries present persisted exhaustion as a retryable failed state.
  // Keep the legacy exhausted selector distinct, while failed includes both
  // kinds of failure just as the SQL filter does.
  const state = job.currentState === "failed" && job.failureReason === "attempt_budget_exhausted"
    ? "exhausted" : job.currentState;
  if (query.state && state !== query.state && !(query.state === "failed" && state === "exhausted")) return false;
  if (
    query.applyStatus === "applied"
    && !job.appliedAt
    && job.applyStatus?.toLowerCase() !== "applied"
  ) {
    return false;
  }
  if (
    query.source &&
    ![job.source, job.discoverySource, job.postingSource, job.postingSourceUrl ?? ""].some((source) =>
      source.toLowerCase().includes(query.source.toLowerCase()),
    )
  ) {
    return false;
  }
  if (query.company && !job.company.toLowerCase().includes(query.company.toLowerCase())) return false;
  if (query.minFitScore !== undefined && (job.fitScore ?? -1) < query.minFitScore) return false;
  if (query.maxFitScore !== undefined && (job.fitScore ?? 999) > query.maxFitScore) return false;
  if (query.discoveredSince && query.scoredSince) {
    const discoveredMatches = timestampAtOrAfter(job.discoveredAt, query.discoveredSince);
    const scoredMatches = timestampAtOrAfter(job.scoredAt, query.scoredSince);
    if (!discoveredMatches && !scoredMatches) return false;
  } else {
    if (query.discoveredSince && !timestampAtOrAfter(job.discoveredAt, query.discoveredSince)) return false;
    if (query.scoredSince && !timestampAtOrAfter(job.scoredAt, query.scoredSince)) return false;
  }
  if (!normalizedQuery) return true;
  return [
    job.title,
    job.company,
    job.url,
    job.location,
    job.source,
    job.discoverySource,
    job.postingSource,
    job.postingSourceUrl ?? "",
    job.strategy,
    job.currentStage,
    job.currentSubstage,
    job.currentState,
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

/** An explicit empty array clears the scalar stage restriction. */
export function effectiveJobStages(query: Pick<JobListQuery, "stage" | "stages">): Stage[] {
  return query.stages !== undefined ? Array.from(new Set(query.stages)) : query.stage ? [query.stage] : [];
}

export function jobSourceSortValue(job: Pick<JobSummary, "postingSource" | "discoverySource" | "source">): string {
  return (job.postingSource || job.discoverySource || job.source || "").toLowerCase();
}

export function postedCompensationSortValue(
  summary: JobCompensationSummary | null,
  fallbackSalary: string,
): number {
  const amount = postedCompensationAmountEur(summary, "min");
  if (amount !== null) return amount;
  if (summary?.posted.displayRange || summary?.legacyRawSalary || fallbackSalary) return -1;
  if (summary?.posted.parseState === "ambiguous") return -2;
  if (summary?.posted.parseState === "unparseable") return -3;
  if (summary?.posted.parseState === "missing") return -4;
  return Number.NEGATIVE_INFINITY;
}

export function postedCompensationAmountEur(
  summary: JobCompensationSummary | null,
  bound: "min" | "max",
): number | null {
  return compensationRangeAmountEur(summary?.posted.range, bound);
}

export function marketCompensationSortValue(summary: JobCompensationSummary | null): number {
  const amount = compensationRangeAmountEur(summary?.market.range ?? null, "min");
  if (amount !== null) return amount;
  switch (summary?.market.estimateState) {
    case "estimated_range":
      return -1;
    case "insufficient_evidence":
      return -2;
    case "source_unavailable":
      return -3;
    case "unsupported":
      return -4;
    case "not_requested":
    default:
      return Number.NEGATIVE_INFINITY;
  }
}

export function marketConfidenceSortValue(summary: JobCompensationSummary | null): number {
  const market = summary?.market;
  if (!market || market.recordStatus === "not_requested") return Number.NEGATIVE_INFINITY;
  if (Number.isFinite(market.confidenceScore)) return Number(market.confidenceScore);
  switch (market.confidenceBand) {
    case "high":
      return 0.9;
    case "medium":
      return 0.62;
    case "low":
      return 0.3;
    case "none":
      return 0;
  }
}

export function compensationRangeAmountEur(
  range: JobCompensationSummary["posted"]["range"] | null | undefined,
  bound: "min" | "max",
): number | null {
  const normalized = bound === "min" ? range?.annualizedMinimumEur : range?.annualizedMaximumEur;
  if (Number.isFinite(normalized)) return Number(normalized);
  if (range?.currency?.toUpperCase() !== "EUR") return null;
  const annualized = bound === "min" ? range.annualizedMinimumAmount : range.annualizedMaximumAmount;
  if (Number.isFinite(annualized)) return Number(annualized);
  if (range.period !== "year") return null;
  const source = bound === "min" ? range.minimumAmount : range.maximumAmount;
  return Number.isFinite(source) ? Number(source) : null;
}

export interface CompareJobsOptions {
  /**
   * @deprecated Text normalization now applies on every query path. Retained
   * for callers compiled against the earlier adapter contract.
   */
  normalizeSqlText?: boolean;
}

/** Scalar summary contract used by the rebuildable SQLite query index. */
export type JobQueryScalars = Pick<JobSummary,
  "jobKey" | "title" | "company" | "url" | "location" | "source" |
  "discoverySource" | "postingSource" | "postingSourceUrl" | "strategy" |
  "currentStage" | "currentSubstage" | "currentState" | "failureReason" |
  "salary" | "compensationSummary" | "fitScore" | "discoveredAt" | "scoredAt" |
  "applyStatus" | "appliedAt">;

export function jobSortValue(job: JobQueryScalars, field: string): unknown {
  const text = (value: string): string => value.toLowerCase();
  switch (field) {
    case "title": return text(job.title);
    case "company": return text(job.company);
    case "source": return jobSourceSortValue(job);
    case "location": return text(job.location);
    case "fit_score": return job.fitScore ?? -1;
    case "current_stage": return text(job.currentStage);
    case "current_state": return `${STATE_RANK[job.currentState] ?? 999}:${text(job.currentSubstage || job.currentStage)}`;
    case "apply_status": return job.applyStatus ?? "";
    case "compensation_min_eur": return postedCompensationAmountEur(job.compensationSummary, "min");
    case "compensation_max_eur": return postedCompensationAmountEur(job.compensationSummary, "max");
    case "compensation_posted": return postedCompensationSortValue(job.compensationSummary, job.salary);
    case "compensation_market": return marketCompensationSortValue(job.compensationSummary);
    case "compensation_confidence": return marketConfidenceSortValue(job.compensationSummary);
    case "compensation_warnings": return job.compensationSummary?.warningCount ?? 0;
    default: return job.discoveredAt;
  }
}

export function compareJobs(
  left: JobSummary,
  right: JobSummary,
  field: string,
  direction: "asc" | "desc",
  _options: CompareJobsOptions = {},
): number {
  const compared = compareValues(jobSortValue(left, field), jobSortValue(right, field));
  return compared ? compared * (direction === "asc" ? 1 : -1) : left.jobKey.localeCompare(right.jobKey);
}

export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  filter: Record<string, unknown>,
): PaginatedResponse<T> {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * pageSize;
  return {
    ok: true,
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page: safePage,
      pageSize,
      total,
      pages,
    },
    sort: { field: sortField, dir: sortDir },
    filter,
  };
}
