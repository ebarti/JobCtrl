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
