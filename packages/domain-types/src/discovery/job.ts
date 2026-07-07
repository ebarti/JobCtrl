/**
 * Job aggregate + discovery value objects — TypeScript mirror.
 *
 * See docs/architecture/domain-model/tactical.md §4.1. The Python ``Job`` aggregate
 * (``workers/automation/src/jobctrl/domain/discovery/aggregate.py``) is
 * the source of truth; both languages must stay structurally compatible.
 *
 * Wire format invariants enforced here at the type level:
 *
 *   * ``PostingUrl`` carries a non-empty string token.
 *   * ``Source`` separates the job board from the hiring company —
 *     ``Employer`` is its own value object per §4.1.
 *   * ``SearchStrategy`` is constrained to the four canonical literals.
 *   * ``JobMetadata`` carries discovery-time metadata only; the full
 *     description lives on the Enrichment context.
 */
import type { TenantId } from "../tenant.js";
import type { JobId } from "../identifiers.js";

// ---------------------------------------------------------------------------
// PostingUrl
// ---------------------------------------------------------------------------

export interface PostingUrl {
  readonly value: string;
}

/** Validating constructor — throws when ``value`` is empty/non-string. */
export function createPostingUrl(value: string): PostingUrl {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("PostingUrl.value must be a non-empty string");
  }
  return { value };
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * The platform where the posting was discovered. The hiring company is
 * a separate value object (``Employer``) per §4.1.
 */
export interface Source {
  readonly board: string;
}

export function createSource(board: string): Source {
  if (typeof board !== "string" || board.trim().length === 0) {
    throw new Error("Source.board must be a non-empty string");
  }
  return { board };
}

// ---------------------------------------------------------------------------
// Employer
// ---------------------------------------------------------------------------

export const UNKNOWN_EMPLOYER = "Unknown";

export interface Employer {
  readonly name: string;
}

export function createEmployer(name: string = UNKNOWN_EMPLOYER): Employer {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Employer.name must be a non-empty string");
  }
  return { name };
}

export function isUnknownEmployer(employer: Employer): boolean {
  return employer.name === UNKNOWN_EMPLOYER;
}

// ---------------------------------------------------------------------------
// SearchStrategy
// ---------------------------------------------------------------------------

export const SEARCH_STRATEGIES = [
  "jobspy",
  "workday_api",
  "smart_extract",
  "manual",
] as const;
export type SearchStrategy = (typeof SEARCH_STRATEGIES)[number];

export function isSearchStrategy(value: unknown): value is SearchStrategy {
  return typeof value === "string" && (SEARCH_STRATEGIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// JobMetadata
// ---------------------------------------------------------------------------

export interface JobMetadata {
  readonly title: string;
  readonly salary: string;
  readonly description: string;
  readonly location: string;
}

// ---------------------------------------------------------------------------
// Job aggregate root
// ---------------------------------------------------------------------------

export interface Job {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly postingUrl: PostingUrl;
  readonly source: Source;
  readonly employer: Employer;
  readonly searchStrategy: SearchStrategy;
  readonly metadata: JobMetadata;
  readonly discoveredAt: string;
  readonly deletedAt: string | null;
  readonly deleteReason: string | null;
}
