/**
 * Interview Preparation domain events.
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

export interface InterviewPrepGeneratedPayload {
  readonly jobId: string;
  readonly generation: number;
  readonly itemCount: number;
  readonly generatedAt: string;
}

export type InterviewPrepGenerated = DomainEvent<
  "InterviewPrepGenerated",
  InterviewPrepGeneratedPayload
>;

export function createInterviewPrepGenerated(
  tenantId: TenantId,
  payload: InterviewPrepGeneratedPayload,
): InterviewPrepGenerated {
  return createDomainEvent("InterviewPrepGenerated", tenantId, payload);
}

export interface InterviewPrepFailedPayload {
  readonly jobId: string;
  readonly generation: number;
  readonly failedAt: string;
  readonly reasonCount: number;
}

export type InterviewPrepFailed = DomainEvent<"InterviewPrepFailed", InterviewPrepFailedPayload>;

export function createInterviewPrepFailed(
  tenantId: TenantId,
  payload: InterviewPrepFailedPayload,
): InterviewPrepFailed {
  return createDomainEvent("InterviewPrepFailed", tenantId, payload);
}

/** Notification only: never carry note text, profile excerpts, or generated prose. */
export interface InterviewQuestionNoteSavedPayload {
  readonly jobId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly sourceGeneration: number | null;
  readonly updatedAt: string;
}
export type InterviewQuestionNoteSaved = DomainEvent<"InterviewQuestionNoteSaved", InterviewQuestionNoteSavedPayload>;
export function createInterviewQuestionNoteSaved(tenantId: TenantId, payload: InterviewQuestionNoteSavedPayload): InterviewQuestionNoteSaved {
  return createDomainEvent("InterviewQuestionNoteSaved", tenantId, payload);
}
