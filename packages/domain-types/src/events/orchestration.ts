/**
 * Pipeline Orchestration domain events.
 *
 * @see ddd-target.md §4.7
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- StageStarted -----------------------------------------------------------

export interface StageStartedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly attemptNumber: number;
  readonly startedAt: string;
}

export type StageStarted = DomainEvent<"StageStarted", StageStartedPayload>;

export function createStageStarted(
  tenantId: TenantId,
  payload: StageStartedPayload,
): StageStarted {
  return createDomainEvent("StageStarted", tenantId, payload);
}

// -- StageCompleted ---------------------------------------------------------

export interface StageCompletedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export type StageCompleted = DomainEvent<"StageCompleted", StageCompletedPayload>;

export function createStageCompleted(
  tenantId: TenantId,
  payload: StageCompletedPayload,
): StageCompleted {
  return createDomainEvent("StageCompleted", tenantId, payload);
}

// -- StageFailed ------------------------------------------------------------

export interface StageFailedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly attemptNumber: number;
}

export type StageFailed = DomainEvent<"StageFailed", StageFailedPayload>;

export function createStageFailed(
  tenantId: TenantId,
  payload: StageFailedPayload,
): StageFailed {
  return createDomainEvent("StageFailed", tenantId, payload);
}

// -- StageExhausted ---------------------------------------------------------

export interface StageExhaustedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export type StageExhausted = DomainEvent<"StageExhausted", StageExhaustedPayload>;

export function createStageExhausted(
  tenantId: TenantId,
  payload: StageExhaustedPayload,
): StageExhausted {
  return createDomainEvent("StageExhausted", tenantId, payload);
}

// -- StageReset -------------------------------------------------------------

export interface StageResetPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly resetAttempts: boolean;
  readonly resetAt: string;
}

export type StageReset = DomainEvent<"StageReset", StageResetPayload>;

export function createStageReset(
  tenantId: TenantId,
  payload: StageResetPayload,
): StageReset {
  return createDomainEvent("StageReset", tenantId, payload);
}

// -- StageBlocked -----------------------------------------------------------

export interface StageBlockedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly blockedBy: readonly string[];
}

export type StageBlocked = DomainEvent<"StageBlocked", StageBlockedPayload>;

export function createStageBlocked(
  tenantId: TenantId,
  payload: StageBlockedPayload,
): StageBlocked {
  return createDomainEvent("StageBlocked", tenantId, payload);
}

// -- StageSkipped -----------------------------------------------------------

export interface StageSkippedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly reason: string;
}

export type StageSkipped = DomainEvent<"StageSkipped", StageSkippedPayload>;

export function createStageSkipped(
  tenantId: TenantId,
  payload: StageSkippedPayload,
): StageSkipped {
  return createDomainEvent("StageSkipped", tenantId, payload);
}

// -- StageCanceled ----------------------------------------------------------

export interface StageCanceledPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly canceledAt: string;
  readonly reason?: string;
}

export type StageCanceled = DomainEvent<"StageCanceled", StageCanceledPayload>;

export function createStageCanceled(
  tenantId: TenantId,
  payload: StageCanceledPayload,
): StageCanceled {
  return createDomainEvent("StageCanceled", tenantId, payload);
}
