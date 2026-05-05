/**
 * Materials Generation domain events.
 *
 * @see ddd-target.md §4.5
 */

import type { TenantId } from "../tenant.js";
import { type DomainEvent, createDomainEvent } from "./base.js";

// -- ResumeApproved ---------------------------------------------------------

export interface ResumeApprovedPayload {
  readonly jobId: string;
  readonly artifactId: string;
  readonly generation: number;
  readonly approvedAt: string;
}

export type ResumeApproved = DomainEvent<"ResumeApproved", ResumeApprovedPayload>;

export function createResumeApproved(
  tenantId: TenantId,
  payload: ResumeApprovedPayload,
): ResumeApproved {
  return createDomainEvent("ResumeApproved", tenantId, payload);
}

// -- ResumeFailed -----------------------------------------------------------

export interface ResumeFailedPayload {
  readonly jobId: string;
  readonly validationErrors: readonly string[];
  readonly attemptNumber: number;
}

export type ResumeFailed = DomainEvent<"ResumeFailed", ResumeFailedPayload>;

export function createResumeFailed(
  tenantId: TenantId,
  payload: ResumeFailedPayload,
): ResumeFailed {
  return createDomainEvent("ResumeFailed", tenantId, payload);
}

// -- CoverLetterGenerated ---------------------------------------------------

export interface CoverLetterGeneratedPayload {
  readonly jobId: string;
  readonly artifactId: string;
  readonly generatedAt: string;
}

export type CoverLetterGenerated = DomainEvent<"CoverLetterGenerated", CoverLetterGeneratedPayload>;

export function createCoverLetterGenerated(
  tenantId: TenantId,
  payload: CoverLetterGeneratedPayload,
): CoverLetterGenerated {
  return createDomainEvent("CoverLetterGenerated", tenantId, payload);
}

// -- PdfRendered ------------------------------------------------------------

export interface PdfRenderedPayload {
  readonly jobId: string;
  readonly artifactType: string;
  readonly artifactId: string;
  readonly renderedAt: string;
}

export type PdfRendered = DomainEvent<"PdfRendered", PdfRenderedPayload>;

export function createPdfRendered(
  tenantId: TenantId,
  payload: PdfRenderedPayload,
): PdfRendered {
  return createDomainEvent("PdfRendered", tenantId, payload);
}

// -- MaterialsExhausted -----------------------------------------------------

export interface MaterialsExhaustedPayload {
  readonly jobId: string;
  readonly stage: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export type MaterialsExhausted = DomainEvent<"MaterialsExhausted", MaterialsExhaustedPayload>;

export function createMaterialsExhausted(
  tenantId: TenantId,
  payload: MaterialsExhaustedPayload,
): MaterialsExhausted {
  return createDomainEvent("MaterialsExhausted", tenantId, payload);
}
