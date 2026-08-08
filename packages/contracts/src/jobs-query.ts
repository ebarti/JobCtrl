/**
 * Shared jobs-list query semantics: filtering, sorting, and pagination over
 * `JobSummary` rows.
 *
 * Two adapters consume this module: the local API's read model (SQLite-backed
 * rows) and the demo workspace's in-memory adapter. Both previously carried
 * hand-copied twins of these functions, with agreement asserted only by
 * hand-re-encoded test expectations; a filter or sort fix now lands once.
 *
 * The demo emulates two SQL-side effects the API gets from SQLite itself:
 * the `deleted` facet (applied in SQL WHERE by the read model) stays in the
 * demo's wrapper, and `normalizeSqlText` reproduces the read model's
 * case-insensitive ORDER BY collation for text sort fields.
 */

import type { JobCompensationSummary, JobListQuery, JobSummary, PaginatedResponse, StageState } from "./schemas.js";

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
  if (query.stage && job.currentStage !== query.stage) return false;
  if (query.state && job.currentState !== query.state) return false;
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

export function jobSourceSortValue(job: JobSummary): string {
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
   * Reproduce the read model's SQL collation for text sort fields: lowercase
   * title/company/location/current_stage, and rank current_state by the
   * lowercased substage-or-stage. The read model itself sorts already-loaded
   * rows and passes false; the demo's in-memory adapter passes true.
   */
  normalizeSqlText?: boolean;
}

export function compareJobs(
  left: JobSummary,
  right: JobSummary,
  field: string,
  direction: "asc" | "desc",
  options: CompareJobsOptions = {},
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const normalizeSqlText = options.normalizeSqlText ?? false;
  const text = (value: string): string => (normalizeSqlText ? value.toLowerCase() : value);
  const stateSubstage = (job: JobSummary): string =>
    normalizeSqlText ? text(job.currentSubstage || job.currentStage) : job.currentSubstage;
  const values: Record<string, [unknown, unknown]> = {
    discovered_at: [left.discoveredAt, right.discoveredAt],
    title: [text(left.title), text(right.title)],
    company: [text(left.company), text(right.company)],
    source: [jobSourceSortValue(left), jobSourceSortValue(right)],
    compensation_min_eur: [
      postedCompensationAmountEur(left.compensationSummary, "min"),
      postedCompensationAmountEur(right.compensationSummary, "min"),
    ],
    compensation_max_eur: [
      postedCompensationAmountEur(left.compensationSummary, "max"),
      postedCompensationAmountEur(right.compensationSummary, "max"),
    ],
    compensation_posted: [
      postedCompensationSortValue(left.compensationSummary, left.salary),
      postedCompensationSortValue(right.compensationSummary, right.salary),
    ],
    compensation_market: [
      marketCompensationSortValue(left.compensationSummary),
      marketCompensationSortValue(right.compensationSummary),
    ],
    compensation_confidence: [
      marketConfidenceSortValue(left.compensationSummary),
      marketConfidenceSortValue(right.compensationSummary),
    ],
    compensation_warnings: [
      left.compensationSummary?.warningCount ?? 0,
      right.compensationSummary?.warningCount ?? 0,
    ],
    location: [text(left.location), text(right.location)],
    fit_score: [left.fitScore ?? -1, right.fitScore ?? -1],
    current_stage: [text(left.currentStage), text(right.currentStage)],
    current_state: [
      `${STATE_RANK[left.currentState] ?? 999}:${stateSubstage(left)}`,
      `${STATE_RANK[right.currentState] ?? 999}:${stateSubstage(right)}`,
    ],
    apply_status: [left.applyStatus ?? "", right.applyStatus ?? ""],
  };
  const [leftValue, rightValue] = values[field] ?? values.discovered_at!;
  const compared = compareValues(leftValue, rightValue);
  return compared ? compared * multiplier : left.jobKey.localeCompare(right.jobKey);
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
