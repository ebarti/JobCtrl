/**
 * ApplyRun aggregate + ApplyRunEvent entity + apply value objects —
 * TypeScript mirror.
 *
 * See docs/architecture/domain-model/tactical.md §4.6. The Python ``ApplyRun`` aggregate
 * (``workers/automation/src/jobctl/domain/apply/aggregate.py``) is
 * the source of truth; both languages must stay structurally
 * compatible.
 *
 * Wire format invariants:
 *
 *   * ``ApplyRunStatus`` is the eight-state lifecycle from §4.6
 *     (the ``starting`` initial plus seven outcomes).
 *   * ``SubmissionResult`` is a discriminated union with a literal
 *     ``kind`` discriminator. Each variant carries variant-specific
 *     fields per §4.6.
 *   * ``ApplyRun.events`` is a readonly array of ``ApplyRunEvent``
 *     in monotonic order (1, 2, …).
 *   * ``BrowserWorkerConfig`` / ``ApplyPrompt`` / ``TokenUsage`` are
 *     value objects mirrored 1:1 with the Python frozen dataclasses.
 */
import type { TenantId } from "../tenant.js";
import type { JobId } from "../identifiers.js";

// ---------------------------------------------------------------------------
// ApplyRunId
// ---------------------------------------------------------------------------

export type ApplyRunId = string & { readonly __brand: "ApplyRunId" };

export function createApplyRunId(value: string): ApplyRunId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("ApplyRunId must be a non-empty string");
  }
  return value as ApplyRunId;
}

// ---------------------------------------------------------------------------
// ApplyRunStatus (lifecycle)
// ---------------------------------------------------------------------------

export const APPLY_RUN_STATUSES = [
  "starting",
  "in_progress",
  "succeeded",
  "failed",
  "captcha",
  "login_issue",
  "expired",
  "manual",
  "dry_run_complete",
] as const;
export type ApplyRunStatus = (typeof APPLY_RUN_STATUSES)[number];

export const APPLY_RUN_TERMINAL_STATUSES: readonly ApplyRunStatus[] = [
  "succeeded",
  "failed",
  "captcha",
  "login_issue",
  "expired",
  "manual",
  "dry_run_complete",
];

export function isApplyRunStatus(value: unknown): value is ApplyRunStatus {
  return (
    typeof value === "string"
    && (APPLY_RUN_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// SubmissionResult (discriminated union)
// ---------------------------------------------------------------------------

export interface AppliedResult {
  readonly kind: "applied";
  readonly appliedAt: string;
  readonly verificationConfidence: number;
}

export interface FailedResult {
  readonly kind: "failed";
  readonly error: string;
  readonly retryable: boolean;
}

export interface CaptchaResult {
  readonly kind: "captcha";
  readonly details: string;
}

export interface LoginIssueResult {
  readonly kind: "login_issue";
  readonly details: string;
}

export interface ExpiredResult {
  readonly kind: "expired";
}

export interface ManualResult {
  readonly kind: "manual";
  readonly reason: string;
}

export interface DryRunCompleteResult {
  readonly kind: "dry_run_complete";
  readonly navigatedTo: string;
}

export type SubmissionResult =
  | AppliedResult
  | FailedResult
  | CaptchaResult
  | LoginIssueResult
  | ExpiredResult
  | ManualResult
  | DryRunCompleteResult;

export const SUBMISSION_RESULT_KINDS = [
  "applied",
  "failed",
  "captcha",
  "login_issue",
  "expired",
  "manual",
  "dry_run_complete",
] as const;
export type SubmissionResultKind = (typeof SUBMISSION_RESULT_KINDS)[number];

// ---------------------------------------------------------------------------
// BrowserWorkerConfig
// ---------------------------------------------------------------------------

export interface BrowserWorkerConfig {
  readonly workerId: number;
  readonly cdpPort: number;
  readonly headless: boolean;
  readonly userDataDir: string | null;
}

// ---------------------------------------------------------------------------
// ApplyPrompt
// ---------------------------------------------------------------------------

export interface ApplyPrompt {
  readonly text: string;
  readonly mcpConfig: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// TokenUsage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly costUsd: number;
}

// ---------------------------------------------------------------------------
// ApplyRunEvent (child entity)
// ---------------------------------------------------------------------------

export const APPLY_RUN_EVENT_LEVELS = ["info", "warn", "error", "debug"] as const;
export type ApplyRunEventLevel = (typeof APPLY_RUN_EVENT_LEVELS)[number];

export interface ApplyRunEvent {
  readonly eventId: number;
  readonly eventType: string;
  readonly level: ApplyRunEventLevel;
  readonly message: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// ApplyRun aggregate root
// ---------------------------------------------------------------------------

export interface ApplyRun {
  readonly tenantId: TenantId;
  readonly runId: ApplyRunId;
  readonly jobId: JobId;
  readonly status: ApplyRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly submissionResult: SubmissionResult | null;
  readonly events: readonly ApplyRunEvent[];
  readonly tokenUsage: TokenUsage | null;
  readonly dryRun: boolean;
  readonly headless: boolean;
  readonly attempts: number;
  readonly model: string | null;
  readonly workerId: number | null;
  readonly durationMs: number | null;
}
