/** Public editorial guidance. Personal facts and saved notes never belong here. */
export const INTERVIEW_ANSWER_FORMATS = ["historical", "situational", "principle", "negotiation", "narrative", "preference"] as const;
export type InterviewAnswerFormat = (typeof INTERVIEW_ANSWER_FORMATS)[number];
export const INTERVIEW_ROLE_LENSES = ["ic", "senior_ic", "staff_principal", "first_time_manager", "engineering_manager", "director", "executive", "unknown"] as const;
export type InterviewRoleLens = (typeof INTERVIEW_ROLE_LENSES)[number];
export const INTERVIEW_STAGES = ["recruiter", "behavioral", "management", "technical", "executive", "mixed", "unknown"] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];
export const INTERVIEW_FORMATS = ["phone", "video", "onsite", "written", "unspecified"] as const;
export type InterviewFormat = (typeof INTERVIEW_FORMATS)[number];
export const INTERVIEW_SELECTION_ERROR_CODES = ["unknown_question", "retired_question", "duplicate_question", "selection_over_budget", "catalog_mismatch", "invalid_selection"] as const;
export type InterviewSelectionErrorCode = (typeof INTERVIEW_SELECTION_ERROR_CODES)[number];
export const MAX_INTERVIEW_SELECTED_QUESTIONS = 16;
export const MAX_INTERVIEW_NOTE_TEXT_LENGTH = 20_000;

export interface InterviewCatalogBinding {
  catalogRevision: string;
  /** SHA-256 of canonical JSON excluding catalogDigest; raw bytes have a separate digest. */
  catalogDigest: string;
}
export interface InterviewRubricDimension { dimension: string; weak: string; strong: string }
export interface InterviewWorkedExample { title: string; body: string }
export interface InterviewQuestionCard {
  id: string;
  title: string;
  topic: string;
  status: "active";
  maturity: "research_draft";
  cardRevision: string;
  cardDigest: string;
  rubricRevision: string;
  rubricDigest: string;
  roleLenses: InterviewRoleLens[];
  responsibilityTags: string[];
  competencyTags: string[];
  answerFormats: InterviewAnswerFormat[];
  defaultAnswerFormat: InterviewAnswerFormat;
  attributionKind: "direct_interview_guidance" | "practice_extrapolation" | "editorial_synthesis";
  sourceRef: string;
  variants: string;
  intent: string;
  answer: string;
  adaptation: string;
  alternatives: string;
  probes: string;
  failures: string;
  provenance: string;
  rubric: InterviewRubricDimension[];
  sources: string[];
  examples: InterviewWorkedExample[];
}
export interface InterviewCatalogSource {
  id: string; title: string; url: string; authorId: string;
  readingCoverage: string;
  readingCoverageKind: "article" | "selected_passage" | "overview" | "official_guidance" | "research_update";
  note: string; questionIds: string[];
}
export interface InterviewCatalog {
  schemaVersion: "1";
  catalogRevision: string;
  catalogDigest: string;
  maturity: "research_draft";
  reviewedAt: string;
  sourcePacketDigest: string;
  sourceFiles: { path: string; sha256: string }[];
  topics: { id: string; name: string; prefix: string; questionIds: string[] }[];
  questions: InterviewQuestionCard[];
  retiredQuestions: { id: string; retiredAt: string; reason: string; replacementId: null }[];
  sources: InterviewCatalogSource[];
  authors: { id: string; name: string; sourceIds: string[] }[];
  relationships: { fromQuestionId: string; toQuestionId: string; kind: "editorial_related"; reason: string }[];
  guidance: { overview: string; sourceLedger: string; evaluation: string; coverage: string; review: string };
}
export interface InterviewSelectionInput {
  selectedQuestionIds?: string[];
  catalogBinding?: InterviewCatalogBinding;
  interviewStage?: InterviewStage;
  interviewFormat?: InterviewFormat;
  roleLens?: InterviewRoleLens;
  roleResponsibilities?: string[];
  knownCriteria?: string[];
  selectionRationale?: string;
}
export interface InterviewEvidenceExcerpt {
  evidenceId: string; sourceRef: string; excerpt: string;
  scope: "direct" | "transferable";
}
export interface InterviewSelectedQuestion {
  questionId: string; cardRevision: string; cardDigest: string;
  rubricRevision: string; rubricDigest: string; answerFormat: InterviewAnswerFormat;
  selectionRationale: string; snapshot: InterviewQuestionCard;
}
/** Generation-time inputs remain available after current profile/job/catalog changes. */
export interface InterviewGenerationContext {
  schemaVersion: "1";
  catalogBinding: InterviewCatalogBinding;
  contextDigest: string;
  selectedQuestionIds: string[];
  selectedQuestions: InterviewSelectedQuestion[];
  selectionMode: "user_selected" | "deterministic";
  interviewStage: InterviewStage;
  interviewFormat: InterviewFormat;
  roleLens: InterviewRoleLens;
  roleResponsibilities: string[];
  knownCriteria: string[];
  profile: { profileId: string; version: number; evidence: InterviewEvidenceExcerpt[] };
  jobContext: { jobId: string; title: string; company: string; descriptionExcerpt: string; snapshotHash: string };
  employerAnalysis: { generation: number; snapshotHash: string; snapshot: {
    roleFraming: string; inferredSeniority: string;
    requirements: { requirementId: string; requirementText: string; sourceExcerpt: string }[];
  } } | null;
  fitReport: { generation: number; employerAnalysisGeneration: number; profileSnapshotVersion: number; status: "current" | "stale_excluded" } | null;
  approvedMaterials: { materialId: string; generation: number; sha256: string }[];
  model: { model: string; promptVersion: string; gateVersion: string };
}
export type InterviewFactualSupport = "accepted_profile_fact" | "hypothetical" | "new_user_statement" | "needs_clarification";
export interface InterviewQuestionMetadata {
  questionId: string; cardRevision: string; cardDigest: string;
  rubricRevision: string; rubricDigest: string; answerFormat: InterviewAnswerFormat;
  selectionRationale: string;
  evidenceLinks: InterviewEvidenceExcerpt[];
  outline: { heading: string; text: string; evidenceIds: string[]; factualSupport: InterviewFactualSupport }[];
  gaps: { id: string; prompt: string; reason: string }[];
  probes: string[];
  sourceGuidanceRefs: string[];
  factualSupport: InterviewFactualSupport;
  userEditStatus: "generated" | "user_edited";
}
export const INTERVIEW_STALE_REASONS = ["catalog_changed", "profile_changed", "job_changed", "employer_analysis_changed", "approved_materials_changed", "legacy_unbound"] as const;
export type InterviewStaleReason = (typeof INTERVIEW_STALE_REASONS)[number];
/** Notes are independent of prep/item replacement and never inherit a generation audit. */
export interface InterviewNoteBindings {
  catalogBinding?: InterviewCatalogBinding | null;
  cardRevision?: string | null; cardDigest?: string | null; contextDigest?: string | null;
}
export interface InterviewQuestionNote {
  jobId: string; questionId: string; revision: number; noteText: string;
  factualSupport: "supported" | "unverified_user_statement" | "needs_clarification" | "hypothetical";
  editStatus: "user_edited"; sourceGeneration: number | null;
  bindings: InterviewNoteBindings | null; updatedAt: string;
}
export interface SaveInterviewQuestionNoteRequest {
  questionId: string; expectedRevision: number; noteText: string;
  factualSupport?: "unverified_user_statement" | "needs_clarification" | "hypothetical";
  sourceGeneration?: number | null; bindings?: InterviewNoteBindings | null;
}
