/**
 * Apply Automation domain events.
 *
 * @see docs/architecture/domain-model/tactical.md §4.6
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

// -- ApplySubmitIntended ----------------------------------------------------

export interface ApplySubmitIntendedPayload {
  readonly tenantId: string;
  readonly jobKey: string;
  readonly runId: string;
  readonly materialVersion: string;
  readonly intendedAt: string;
}

export type ApplySubmitIntended = DomainEvent<"ApplySubmitIntended", ApplySubmitIntendedPayload>;

export function createApplySubmitIntended(
  tenantId: TenantId,
  payload: ApplySubmitIntendedPayload,
): ApplySubmitIntended {
  return createDomainEvent("ApplySubmitIntended", tenantId, payload);
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

// -- EmailApplicationCandidateRecorded --------------------------------------

export interface EmailApplicationCandidateRecordedPayload {
  readonly runId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly attachmentArtifactId: string;
  readonly attachmentName: string;
}

export type EmailApplicationCandidateRecorded = DomainEvent<
  "EmailApplicationCandidateRecorded",
  EmailApplicationCandidateRecordedPayload
>;

export function createEmailApplicationCandidateRecorded(
  tenantId: TenantId,
  payload: EmailApplicationCandidateRecordedPayload,
): EmailApplicationCandidateRecorded {
  return createDomainEvent("EmailApplicationCandidateRecorded", tenantId, payload);
}

// -- ApplicationEmailFeedbackIngested ---------------------------------------

export interface ApplicationEmailFeedbackIngestedPayload {
  readonly jobId: string;
  readonly evidenceId: string;
  readonly suggestionId: string;
  readonly provider: "gmail";
  readonly suggestedKind: string;
  readonly classificationConfidence: number;
  readonly linkConfidence: number;
  readonly linkSignals: readonly string[];
}

export type ApplicationEmailFeedbackIngested = DomainEvent<
  "ApplicationEmailFeedbackIngested",
  ApplicationEmailFeedbackIngestedPayload
>;

export function createApplicationEmailFeedbackIngested(
  tenantId: TenantId,
  payload: ApplicationEmailFeedbackIngestedPayload,
): ApplicationEmailFeedbackIngested {
  return createDomainEvent("ApplicationEmailFeedbackIngested", tenantId, payload);
}

// -- ApplyReviewDecisionRecorded -------------------------------------------

export type ApplyReviewDecisionValue =
  | "approve_submit"
  | "approve_dry_run"
  | "defer"
  | "decline"
  | "reset";

export interface ApplyReviewDecisionRecordedPayload {
  readonly jobKey: string;
  readonly decisionId: string;
  readonly decision: ApplyReviewDecisionValue;
  readonly reasonPresent: boolean;
  readonly materialsGeneration: number | null;
  readonly profileVersion: number | null;
  readonly applicationUrl: string | null;
  readonly partialOverrideRunId: string | null;
  readonly emailRecipient: string | null;
  readonly emailAttachmentArtifactId: string | null;
}

export type ApplyReviewDecisionRecorded = DomainEvent<
  "ApplyReviewDecisionRecorded",
  ApplyReviewDecisionRecordedPayload
>;

export function createApplyReviewDecisionRecorded(
  tenantId: TenantId,
  payload: ApplyReviewDecisionRecordedPayload,
): ApplyReviewDecisionRecorded {
  return createDomainEvent("ApplyReviewDecisionRecorded", tenantId, payload);
}

// -- ApplicationOutcomeRecorded --------------------------------------------

export type ApplicationOutcomeKindValue =
  | "applied_confirmation"
  | "recruiter_reply"
  | "interview"
  | "assessment"
  | "rejection"
  | "offer"
  | "withdrawn"
  | "bounced"
  | "no_response"
  | "unknown";

export type ApplicationOutcomeSourceValue = "manual" | "email_suggestion";

export interface ApplicationOutcomeRecordedPayload {
  readonly jobKey: string;
  readonly outcomeId: string;
  readonly kind: ApplicationOutcomeKindValue;
  readonly source: ApplicationOutcomeSourceValue;
  readonly occurredAt: string;
  readonly suggestionId: string | null;
  readonly evidenceId: string | null;
  readonly interviewPrepGeneration: number | null;
  readonly notePresent: boolean;
}

export type ApplicationOutcomeRecorded = DomainEvent<
  "ApplicationOutcomeRecorded",
  ApplicationOutcomeRecordedPayload
>;

export function createApplicationOutcomeRecorded(
  tenantId: TenantId,
  payload: ApplicationOutcomeRecordedPayload,
): ApplicationOutcomeRecorded {
  return createDomainEvent("ApplicationOutcomeRecorded", tenantId, payload);
}

// -- OutcomeSuggestionDecided ----------------------------------------------

export type OutcomeSuggestionDecisionValue = "accept" | "correct" | "ignore";

export interface OutcomeSuggestionDecidedPayload {
  readonly jobKey: string;
  readonly suggestionId: string;
  readonly evidenceId: string | null;
  readonly decision: OutcomeSuggestionDecisionValue;
  readonly outcomeId: string | null;
  readonly outcomeKind: ApplicationOutcomeKindValue | null;
  readonly notePresent: boolean;
  readonly reasonPresent: boolean;
}

export type OutcomeSuggestionDecided = DomainEvent<
  "OutcomeSuggestionDecided",
  OutcomeSuggestionDecidedPayload
>;

export function createOutcomeSuggestionDecided(
  tenantId: TenantId,
  payload: OutcomeSuggestionDecidedPayload,
): OutcomeSuggestionDecided {
  return createDomainEvent("OutcomeSuggestionDecided", tenantId, payload);
}
