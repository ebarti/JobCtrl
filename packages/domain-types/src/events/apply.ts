/**
 * Apply Automation domain events.
 *
 * @see ddd-target.md §4.6
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- ApplicationSubmitted ---------------------------------------------------

export interface ApplicationSubmittedPayload {
  readonly jobId: string;
  readonly runId: string;
  readonly appliedAt: string;
  readonly verificationConfidence: number;
}

export type ApplicationSubmitted = DomainEvent<"ApplicationSubmitted", ApplicationSubmittedPayload>;

export function createApplicationSubmitted(
  tenantId: TenantId,
  payload: ApplicationSubmittedPayload,
): ApplicationSubmitted {
  return createDomainEvent("ApplicationSubmitted", tenantId, payload);
}

// -- ApplicationFailed ------------------------------------------------------

export interface ApplicationFailedPayload {
  readonly jobId: string;
  readonly runId: string;
  readonly result: Record<string, unknown>;
  readonly attemptNumber: number;
}

export type ApplicationFailed = DomainEvent<"ApplicationFailed", ApplicationFailedPayload>;

export function createApplicationFailed(
  tenantId: TenantId,
  payload: ApplicationFailedPayload,
): ApplicationFailed {
  return createDomainEvent("ApplicationFailed", tenantId, payload);
}

// -- ApplyRunStarted --------------------------------------------------------

export interface ApplyRunStartedPayload {
  readonly jobId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly model: string;
  readonly dryRun: boolean;
  readonly startedAt: string;
}

export type ApplyRunStarted = DomainEvent<"ApplyRunStarted", ApplyRunStartedPayload>;

export function createApplyRunStarted(
  tenantId: TenantId,
  payload: ApplyRunStartedPayload,
): ApplyRunStarted {
  return createDomainEvent("ApplyRunStarted", tenantId, payload);
}

// -- ApplyRunEventRecorded --------------------------------------------------

export interface ApplyRunEventRecordedPayload {
  readonly runId: string;
  readonly event: Record<string, unknown>;
}

export type ApplyRunEventRecorded = DomainEvent<"ApplyRunEventRecorded", ApplyRunEventRecordedPayload>;

export function createApplyRunEventRecorded(
  tenantId: TenantId,
  payload: ApplyRunEventRecordedPayload,
): ApplyRunEventRecorded {
  return createDomainEvent("ApplyRunEventRecorded", tenantId, payload);
}
