/**
 * Interview Preparation types — generated, stored prep for before interviews.
 *
 * These pure DTOs mirror the Python ``domain/interview/value_objects.py`` read
 * model and intentionally contain no live, in-session, transcript, microphone,
 * websocket, or real-time assistance state.
 */

import type { InterviewGenerationContext, InterviewQuestionMetadata, InterviewStaleReason } from "./catalog.js";
export * from "./catalog.js";

export const INTERVIEW_PREP_ITEM_KINDS = [
  "theme",
  "star_draft",
  "gap_drill",
  "company_note",
  "question_outline",
] as const;
export type InterviewPrepItemKind = (typeof INTERVIEW_PREP_ITEM_KINDS)[number];

export const INTERVIEW_PREP_STATUSES = ["accepted", "failed", "superseded"] as const;
export type InterviewPrepStatus = (typeof INTERVIEW_PREP_STATUSES)[number];

export interface InterviewPrepGateAudit {
  status: "passed" | "failed";
  fabricationFindings: string[];
  groundingFindings: string[];
  judgeVerdict: string | null;
  warnings: string[];
}

export interface InterviewPrepItem {
  itemId: string;
  kind: InterviewPrepItemKind;
  title: string;
  generatedText: string;
  evidenceIds: string[];
  requirementIds: string[];
  sourceText: string[];
  transformType: string;
  control: string;
  groundingAudit: string[];
  warnings: string[];
  position: number;
  questionMetadata?: InterviewQuestionMetadata | null | undefined;
}

export interface InterviewPrep {
  jobId: string;
  generation: number;
  status: InterviewPrepStatus;
  generatedAt: string;
  model: string | null;
  gateAudit: InterviewPrepGateAudit;
  items: InterviewPrepItem[];
  generationContext?: InterviewGenerationContext | null | undefined;
  staleReasons?: InterviewStaleReason[] | undefined;
}
