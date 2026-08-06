/**
 * Workflow lifecycle domain events (Temporal loop closure — P0).
 *
 * Mirror of `workers/automation/src/jobctrl/domain/events/workflow.py`.
 * Every Temporal workflow durably records a `WorkflowStarted` marker plus
 * exactly one terminal event; together they drive `workflow_run_projections`
 * and the Workflow Runs UI without a trigger-coupled reaper.
 *
 * @see docs/plans/2026-07-03-temporal-native-rearchitecture.md (P0)
 * @see docs/architecture/domain-model/tactical.md §4.7
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

/**
 * The subset of the 12-state `WORKFLOW_RUN_STATUSES` contract that a
 * lifecycle event can carry. Kept as a local union so `@jobctrl/domain-types`
 * stays free of a `@jobctrl/contracts` dependency.
 */
export type WorkflowLifecycleStatus =
  | "in_progress"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out"
  | "terminated";

// -- WorkflowStarted --------------------------------------------------------

export interface WorkflowStartedPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  readonly inputSummary: Record<string, unknown>;
  readonly startedAt: string | null;
  readonly temporalRunId: string | null;
  /**
   * Present only when the reconciler has rediscovered this exact Temporal run
   * after a transient `reconciled_not_found` projection.
   */
  readonly recoveredFromMissingHistory?: boolean;
}

export type WorkflowStarted = DomainEvent<"WorkflowStarted", WorkflowStartedPayload>;

export function createWorkflowStarted(
  tenantId: TenantId,
  payload: WorkflowStartedPayload,
): WorkflowStarted {
  return createDomainEvent("WorkflowStarted", tenantId, payload);
}

// -- WorkflowCancellationRequested -----------------------------------------

export interface WorkflowCancellationRequestedPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly requestedBy: string;
  readonly source: string;
  readonly evidenceKind:
    | "request_intent"
    | "temporal_history"
    | "recovered_temporal_history";
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly temporalRunId: string | null;
  readonly message: string;
}

export type WorkflowCancellationRequested = DomainEvent<
  "WorkflowCancellationRequested",
  WorkflowCancellationRequestedPayload
>;

export function createWorkflowCancellationRequested(
  tenantId: TenantId,
  payload: WorkflowCancellationRequestedPayload,
): WorkflowCancellationRequested {
  return createDomainEvent("WorkflowCancellationRequested", tenantId, payload);
}

// -- WorkflowCompleted ------------------------------------------------------

export interface WorkflowCompletedPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly temporalRunId: string | null;
}

export type WorkflowCompleted = DomainEvent<"WorkflowCompleted", WorkflowCompletedPayload>;

export function createWorkflowCompleted(
  tenantId: TenantId,
  payload: WorkflowCompletedPayload,
): WorkflowCompleted {
  return createDomainEvent("WorkflowCompleted", tenantId, payload);
}

// -- WorkflowFailed ---------------------------------------------------------

export interface WorkflowFailedPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly temporalRunId: string | null;
}

export type WorkflowFailed = DomainEvent<"WorkflowFailed", WorkflowFailedPayload>;

export function createWorkflowFailed(
  tenantId: TenantId,
  payload: WorkflowFailedPayload,
): WorkflowFailed {
  return createDomainEvent("WorkflowFailed", tenantId, payload);
}

// -- WorkflowCanceled -------------------------------------------------------

export interface WorkflowCanceledPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  // Empty on the normal cancel path; the describe-based reconciler fills these
  // with its own provenance when it terminalizes a CANCELED execution.
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly temporalRunId: string | null;
}

export type WorkflowCanceled = DomainEvent<"WorkflowCanceled", WorkflowCanceledPayload>;

export function createWorkflowCanceled(
  tenantId: TenantId,
  payload: WorkflowCanceledPayload,
): WorkflowCanceled {
  return createDomainEvent("WorkflowCanceled", tenantId, payload);
}

// -- WorkflowTimedOut -------------------------------------------------------

export interface WorkflowTimedOutPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly temporalRunId: string | null;
}

export type WorkflowTimedOut = DomainEvent<"WorkflowTimedOut", WorkflowTimedOutPayload>;

export function createWorkflowTimedOut(
  tenantId: TenantId,
  payload: WorkflowTimedOutPayload,
): WorkflowTimedOut {
  return createDomainEvent("WorkflowTimedOut", tenantId, payload);
}

// -- WorkflowTerminated -----------------------------------------------------

export interface WorkflowTerminatedPayload {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly status: WorkflowLifecycleStatus;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly temporalRunId: string | null;
}

export type WorkflowTerminated = DomainEvent<"WorkflowTerminated", WorkflowTerminatedPayload>;

export function createWorkflowTerminated(
  tenantId: TenantId,
  payload: WorkflowTerminatedPayload,
): WorkflowTerminated {
  return createDomainEvent("WorkflowTerminated", tenantId, payload);
}
