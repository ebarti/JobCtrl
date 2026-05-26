/**
 * Discovery preparation work item events.
 *
 * These events describe internal preparation work for the single user-facing
 * Discover stage while keeping Scoring and Materials ownership separate.
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

export const PREPARATION_WORK_ITEM_KINDS = [
  "score_job",
  "tailor_resume",
  "suppress_tailored_artifacts",
] as const;
export type PreparationWorkItemKind = (typeof PREPARATION_WORK_ITEM_KINDS)[number];

// -- PreparationWorkItemQueued ---------------------------------------------

export interface PreparationWorkItemQueuedPayload {
  readonly workItemId: string;
  readonly jobId: string;
  readonly kind: PreparationWorkItemKind;
  readonly reason: string;
  readonly targetVersion: number | null;
  readonly sourceEventId: string;
  readonly queuedAt: string;
}

export type PreparationWorkItemQueued = DomainEvent<"PreparationWorkItemQueued", PreparationWorkItemQueuedPayload>;

export function createPreparationWorkItemQueued(
  tenantId: TenantId,
  payload: PreparationWorkItemQueuedPayload,
): PreparationWorkItemQueued {
  return createDomainEvent("PreparationWorkItemQueued", tenantId, payload);
}

// -- PreparationWorkItemStarted --------------------------------------------

export interface PreparationWorkItemStartedPayload {
  readonly workItemId: string;
  readonly jobId: string;
  readonly kind: PreparationWorkItemKind;
  readonly workerId: string;
  readonly startedAt: string;
}

export type PreparationWorkItemStarted = DomainEvent<"PreparationWorkItemStarted", PreparationWorkItemStartedPayload>;

export function createPreparationWorkItemStarted(
  tenantId: TenantId,
  payload: PreparationWorkItemStartedPayload,
): PreparationWorkItemStarted {
  return createDomainEvent("PreparationWorkItemStarted", tenantId, payload);
}

// -- PreparationWorkItemCompleted ------------------------------------------

export interface PreparationWorkItemCompletedPayload {
  readonly workItemId: string;
  readonly jobId: string;
  readonly kind: PreparationWorkItemKind;
  readonly completedAt: string;
  readonly durationMs: number;
}

export type PreparationWorkItemCompleted = DomainEvent<
  "PreparationWorkItemCompleted",
  PreparationWorkItemCompletedPayload
>;

export function createPreparationWorkItemCompleted(
  tenantId: TenantId,
  payload: PreparationWorkItemCompletedPayload,
): PreparationWorkItemCompleted {
  return createDomainEvent("PreparationWorkItemCompleted", tenantId, payload);
}

// -- PreparationWorkItemFailed ---------------------------------------------

export interface PreparationWorkItemFailedPayload {
  readonly workItemId: string;
  readonly jobId: string;
  readonly kind: PreparationWorkItemKind;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}

export type PreparationWorkItemFailed = DomainEvent<"PreparationWorkItemFailed", PreparationWorkItemFailedPayload>;

export function createPreparationWorkItemFailed(
  tenantId: TenantId,
  payload: PreparationWorkItemFailedPayload,
): PreparationWorkItemFailed {
  return createDomainEvent("PreparationWorkItemFailed", tenantId, payload);
}
