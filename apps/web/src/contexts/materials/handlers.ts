import type {
  CoverLetterGenerated,
  MaterialsExhausted,
  PdfRendered,
  ResumeApproved,
  ResumeFailed,
} from "@jobhunter/domain-types";

import type { InvalidationItem } from "../operations/invalidation-router.js";

export const resumeApprovedHandler = (
  _event: ResumeApproved,
): readonly InvalidationItem[] => [];
export const resumeFailedHandler = (_event: ResumeFailed): readonly InvalidationItem[] => [];
export const coverLetterGeneratedHandler = (
  _event: CoverLetterGenerated,
): readonly InvalidationItem[] => [];
export const pdfRenderedHandler = (_event: PdfRendered): readonly InvalidationItem[] => [];
export const materialsExhaustedHandler = (
  _event: MaterialsExhausted,
): readonly InvalidationItem[] => [];
