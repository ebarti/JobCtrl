/**
 * Operations / Read-Side domain events.
 *
 * @see docs/architecture/domain-model/tactical.md §4.8
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- Pipeline step lifecycle -----------------------------------------------

/**
 * Immutable identity for one Temporal execution of DiscoverWorkflow.
 *
 * This deliberately does not reuse a source-specific discovery run id. The
 * Python lineage value object uses the snake_case equivalents of these three
 * fields and serializes to this exact camelCase shape.
 */
export interface DiscoveryExecutionRef {
  readonly tenantId: TenantId;
  readonly workflowId: string;
  readonly temporalRunId: string;
}

/**
 * Orchestration steps that do not already have a canonical per-job stage row.
 * Keep this vocabulary stable: the Operations read model and ETA estimator
 * group historical service times by these values.
 */
export const PIPELINE_STEP_KINDS = [
  "source_planning",
  "source_family",
  "enrichment_pass",
  "preparation_fanout",
  "existing_backlog_sweep",
  "pdf_render",
] as const;
export type PipelineStepKind = (typeof PIPELINE_STEP_KINDS)[number];

export const PIPELINE_STEP_STATES = ["queued", "running", "succeeded", "failed"] as const;
export type PipelineStepState = (typeof PIPELINE_STEP_STATES)[number];

/** Allowlisted, content-free context for an orchestration step. */
export const PIPELINE_STEP_DETAIL_CODES = [
  "source_plan",
  "source_family",
  "streaming_pass",
  "terminal_reconciliation",
  "existing_backlog",
  "pdf_render",
] as const;
export type PipelineStepDetailCode = (typeof PIPELINE_STEP_DETAIL_CODES)[number];

export interface PipelineStepSafeDetail {
  readonly code: PipelineStepDetailCode;
  readonly itemCount: number | null;
}

interface PipelineStepIdentityPayload {
  readonly execution: DiscoveryExecutionRef;
  readonly stepKind: PipelineStepKind;
  /**
   * Stable, bounded scope key such as `family:workday`, `terminal`, or
   * `existing_backlog`. Raw URLs and free-form activity inputs are rejected.
   */
  readonly itemKey: string;
  /** Temporal activity attempt, starting at one. */
  readonly attempt: number;
  readonly detail: PipelineStepSafeDetail | null;
}

export interface PipelineStepQueuedPayload extends PipelineStepIdentityPayload {
  readonly queuedAt: string;
}

export interface PipelineStepStartedPayload extends PipelineStepIdentityPayload {
  readonly startedAt: string;
}

export interface PipelineStepCompletedPayload extends PipelineStepIdentityPayload {
  readonly completedAt: string;
  readonly durationMs: number | null;
}

export interface PipelineStepFailedPayload extends PipelineStepIdentityPayload {
  readonly failedAt: string;
  readonly durationMs: number | null;
  /** Bounded machine-readable code only; never an exception message. */
  readonly errorCode: string;
  readonly retryable: boolean;
}

export type PipelineStepQueued = DomainEvent<"PipelineStepQueued", PipelineStepQueuedPayload>;
export type PipelineStepStarted = DomainEvent<"PipelineStepStarted", PipelineStepStartedPayload>;
export type PipelineStepCompleted = DomainEvent<
  "PipelineStepCompleted",
  PipelineStepCompletedPayload
>;
export type PipelineStepFailed = DomainEvent<"PipelineStepFailed", PipelineStepFailedPayload>;

const SAFE_PIPELINE_ITEM_KEY = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const SAFE_PIPELINE_ERROR_CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

function normalizePipelineStepIdentity(
  tenantId: TenantId,
  payload: PipelineStepIdentityPayload,
): PipelineStepIdentityPayload {
  if (payload.execution.tenantId !== tenantId) {
    throw new Error("pipeline step execution tenant must match the event tenant");
  }
  if (!payload.execution.workflowId.trim() || !payload.execution.temporalRunId.trim()) {
    throw new Error("pipeline step execution ids must be non-empty");
  }
  if (!(PIPELINE_STEP_KINDS as readonly string[]).includes(payload.stepKind)) {
    throw new Error(`unknown pipeline step kind: ${String(payload.stepKind)}`);
  }
  if (!SAFE_PIPELINE_ITEM_KEY.test(payload.itemKey)) {
    throw new Error("pipeline step itemKey must be a bounded safe scope key");
  }
  if (!Number.isSafeInteger(payload.attempt) || payload.attempt < 1) {
    throw new Error("pipeline step attempt must be a positive safe integer");
  }
  let detail: PipelineStepSafeDetail | null = null;
  if (payload.detail !== null) {
    if (!(PIPELINE_STEP_DETAIL_CODES as readonly string[]).includes(payload.detail.code)) {
      throw new Error(`unknown pipeline step detail code: ${String(payload.detail.code)}`);
    }
    if (
      payload.detail.itemCount !== null &&
      (!Number.isSafeInteger(payload.detail.itemCount) || payload.detail.itemCount < 0)
    ) {
      throw new Error("pipeline step detail itemCount must be a non-negative safe integer");
    }
    detail = { code: payload.detail.code, itemCount: payload.detail.itemCount };
  }
  return {
    execution: {
      tenantId: payload.execution.tenantId,
      workflowId: payload.execution.workflowId,
      temporalRunId: payload.execution.temporalRunId,
    },
    stepKind: payload.stepKind,
    itemKey: payload.itemKey,
    attempt: payload.attempt,
    detail,
  };
}

function requirePipelineTimestamp(value: string, field: string): string {
  if (!value.trim()) {
    throw new Error(`${field} must be non-empty`);
  }
  return value;
}

function normalizePipelineDuration(value: number | null): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("pipeline step durationMs must be a non-negative safe integer or null");
  }
  return value;
}

export function createPipelineStepQueued(
  tenantId: TenantId,
  payload: PipelineStepQueuedPayload,
): PipelineStepQueued {
  return createDomainEvent("PipelineStepQueued", tenantId, {
    ...normalizePipelineStepIdentity(tenantId, payload),
    queuedAt: requirePipelineTimestamp(payload.queuedAt, "queuedAt"),
  });
}

export function createPipelineStepStarted(
  tenantId: TenantId,
  payload: PipelineStepStartedPayload,
): PipelineStepStarted {
  return createDomainEvent("PipelineStepStarted", tenantId, {
    ...normalizePipelineStepIdentity(tenantId, payload),
    startedAt: requirePipelineTimestamp(payload.startedAt, "startedAt"),
  });
}

export function createPipelineStepCompleted(
  tenantId: TenantId,
  payload: PipelineStepCompletedPayload,
): PipelineStepCompleted {
  return createDomainEvent("PipelineStepCompleted", tenantId, {
    ...normalizePipelineStepIdentity(tenantId, payload),
    completedAt: requirePipelineTimestamp(payload.completedAt, "completedAt"),
    durationMs: normalizePipelineDuration(payload.durationMs),
  });
}

export function createPipelineStepFailed(
  tenantId: TenantId,
  payload: PipelineStepFailedPayload,
): PipelineStepFailed {
  if (!SAFE_PIPELINE_ERROR_CODE.test(payload.errorCode)) {
    throw new Error("pipeline step errorCode must be a bounded safe code");
  }
  return createDomainEvent("PipelineStepFailed", tenantId, {
    ...normalizePipelineStepIdentity(tenantId, payload),
    failedAt: requirePipelineTimestamp(payload.failedAt, "failedAt"),
    durationMs: normalizePipelineDuration(payload.durationMs),
    errorCode: payload.errorCode,
    retryable: payload.retryable,
  });
}

// -- DigestReviewed ---------------------------------------------------------

export interface DigestReviewedPayload {
  readonly acknowledgedAt: string;
  readonly reviewedAt: string;
  readonly previousAcknowledgedAt: string | null;
}

export type DigestReviewed = DomainEvent<"DigestReviewed", DigestReviewedPayload>;

export function createDigestReviewed(
  tenantId: TenantId,
  payload: DigestReviewedPayload,
): DigestReviewed {
  return createDomainEvent("DigestReviewed", tenantId, payload);
}
