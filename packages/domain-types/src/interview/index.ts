/**
 * Interview Preparation types — generated, stored prep for before interviews.
 *
 * These pure DTOs mirror the Python ``domain/interview/value_objects.py`` read
 * model and intentionally contain no live, in-session, transcript, microphone,
 * websocket, or real-time assistance state.
 */

export const INTERVIEW_PREP_ITEM_KINDS = [
  "theme",
  "star_draft",
  "gap_drill",
  "company_note",
] as const;
export type InterviewPrepItemKind = (typeof INTERVIEW_PREP_ITEM_KINDS)[number];

export const INTERVIEW_PREP_STATUSES = ["accepted", "failed", "superseded"] as const;
export type InterviewPrepStatus = (typeof INTERVIEW_PREP_STATUSES)[number];

export interface InterviewPrepGateAudit {
  readonly status: "passed" | "failed";
  readonly fabricationFindings: readonly string[];
  readonly groundingFindings: readonly string[];
  readonly judgeVerdict: string | null;
  readonly warnings: readonly string[];
}

export interface InterviewPrepItem {
  readonly itemId: string;
  readonly kind: InterviewPrepItemKind;
  readonly title: string;
  readonly generatedText: string;
  readonly evidenceIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly sourceText: readonly string[];
  readonly transformType: string;
  readonly control: string;
  readonly groundingAudit: readonly string[];
  readonly warnings: readonly string[];
  readonly position: number;
}

export interface InterviewPrep {
  readonly jobKey: string;
  readonly generation: number;
  readonly status: InterviewPrepStatus;
  readonly generatedAt: string;
  readonly model: string | null;
  readonly gateAudit: InterviewPrepGateAudit;
  readonly items: readonly InterviewPrepItem[];
}
