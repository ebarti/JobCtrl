/**
 * JobEnrichment aggregate + EnrichmentAttempt entity — TypeScript mirror.
 *
 * See docs/architecture/domain-model/tactical.md §4.2. The Python ``JobEnrichment`` aggregate
 * (``workers/automation/src/jobhunter/domain/enrichment/aggregate.py``)
 * is the source of truth; both languages must stay structurally
 * compatible.
 *
 * Wire format invariants:
 *
 *   * ``ExtractionTier`` is constrained to the three-literal union.
 *   * ``EnrichmentLifecycle`` is the four-state machine from §4.2.
 *   * ``AttemptStatus`` mirrors the per-attempt status enum.
 *   * ``JobEnrichment.attempts`` is a readonly array of attempts in
 *     monotonic order (1, 2, …).
 */
import type { TenantId } from "../tenant.js";
import type { JobId } from "../identifiers.js";

// ---------------------------------------------------------------------------
// FullDescription
// ---------------------------------------------------------------------------

export interface FullDescription {
  readonly text: string;
}

export function createFullDescription(text: string): FullDescription {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("FullDescription.text must be a non-empty string");
  }
  return { text };
}

// ---------------------------------------------------------------------------
// ApplicationUrl
// ---------------------------------------------------------------------------

export interface ApplicationUrl {
  readonly value: string;
}

export function createApplicationUrl(value: string): ApplicationUrl {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ApplicationUrl.value must be a non-empty string");
  }
  return { value };
}

// ---------------------------------------------------------------------------
// ExtractionTier
// ---------------------------------------------------------------------------

export const EXTRACTION_TIERS = ["json_ld", "css_selectors", "llm_assisted"] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];

export function isExtractionTier(value: unknown): value is ExtractionTier {
  return typeof value === "string" && (EXTRACTION_TIERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// EnrichmentLifecycle (aggregate-level state)
// ---------------------------------------------------------------------------

export const ENRICHMENT_LIFECYCLE = ["pending", "running", "enriched", "failed"] as const;
export type EnrichmentLifecycle = (typeof ENRICHMENT_LIFECYCLE)[number];

// ---------------------------------------------------------------------------
// AttemptStatus (per-attempt state)
// ---------------------------------------------------------------------------

export const ATTEMPT_STATUSES = ["running", "succeeded", "failed"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// ---------------------------------------------------------------------------
// EnrichmentError
// ---------------------------------------------------------------------------

export interface EnrichmentError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// EnrichmentAttempt (child entity)
// ---------------------------------------------------------------------------

export interface EnrichmentAttempt {
  readonly attemptNumber: number;
  readonly extractionTier: ExtractionTier;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: EnrichmentError | null;
}

// ---------------------------------------------------------------------------
// JobEnrichment aggregate root
// ---------------------------------------------------------------------------

export interface JobEnrichment {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly currentStatus: EnrichmentLifecycle;
  readonly attempts: readonly EnrichmentAttempt[];
  readonly fullDescription: FullDescription | null;
  readonly applicationUrl: ApplicationUrl | null;
  readonly enrichedAt: string | null;
  readonly extractionTier: ExtractionTier | null;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// DetailPage (port-shape value object)
// ---------------------------------------------------------------------------

export interface DetailPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly pageTitle: string;
  readonly html: string;
  readonly jsonLd: readonly unknown[];
  readonly status: number | null;
  readonly fetchedAt: string;
}
