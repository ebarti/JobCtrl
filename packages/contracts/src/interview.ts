import { z } from "zod";
import {
  INTERVIEW_ANSWER_FORMATS, INTERVIEW_ROLE_LENSES, INTERVIEW_STAGES, INTERVIEW_FORMATS,
  INTERVIEW_SELECTION_ERROR_CODES, INTERVIEW_STALE_REASONS,
  MAX_INTERVIEW_SELECTED_QUESTIONS, MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION, MAX_INTERVIEW_NOTE_TEXT_LENGTH,
  INTERVIEW_PREP_ITEM_KINDS, INTERVIEW_PREP_STATUSES,
} from "@jobctrl/domain-types";
export {
  INTERVIEW_ANSWER_FORMATS, INTERVIEW_ROLE_LENSES, INTERVIEW_STAGES, INTERVIEW_FORMATS,
  INTERVIEW_SELECTION_ERROR_CODES, INTERVIEW_STALE_REASONS,
  MAX_INTERVIEW_SELECTED_QUESTIONS, MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION, MAX_INTERVIEW_NOTE_TEXT_LENGTH,
} from "@jobctrl/domain-types";
export type {
  InterviewAnswerFormat, InterviewRoleLens, InterviewStage, InterviewFormat,
  InterviewSelectionErrorCode, InterviewCatalogBinding, InterviewQuestionCard,
  InterviewCatalog, InterviewCatalogSource, InterviewRubricDimension, InterviewWorkedExample,
  InterviewSelectionInput, InterviewEvidenceSelection, InterviewEvidenceExcerpt, InterviewSelectedQuestion,
  InterviewGenerationContext, InterviewFactualSupport, InterviewQuestionMetadata,
  InterviewStaleReason, InterviewQuestionNote, InterviewNoteBindings, SaveInterviewQuestionNoteRequest,
} from "@jobctrl/domain-types";

const Id = z.string().max(12).regex(/^[A-Z]+\d{2}$/);
const EvidenceId = z.string().min(1).max(200).refine((id) => id.trim().length > 0, "blank evidence ID");
const Revision = z.string().trim().min(1).max(100);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string();
export const InterviewCatalogBindingSchema = z.object({ catalogRevision: Revision, catalogDigest: Digest }).strict();
export const InterviewQuestionCardSchema = z.object({
  id: Id, title: Text, topic: Text, status: z.literal("active"), maturity: z.literal("research_draft"),
  cardRevision: Revision, cardDigest: Digest, rubricRevision: Revision, rubricDigest: Digest,
  roleLenses: z.array(z.enum(INTERVIEW_ROLE_LENSES)).min(1),
  responsibilityTags: z.array(Text).min(1), competencyTags: z.array(Text).min(1),
  answerFormats: z.array(z.enum(INTERVIEW_ANSWER_FORMATS)).min(1), defaultAnswerFormat: z.enum(INTERVIEW_ANSWER_FORMATS),
  attributionKind: z.enum(["direct_interview_guidance", "practice_extrapolation", "editorial_synthesis"]),
  sourceRef: Text, variants: Text, intent: Text, answer: Text, adaptation: Text, alternatives: Text,
  probes: Text, failures: Text, provenance: Text,
  rubric: z.array(z.object({ dimension: Text, weak: Text, strong: Text }).strict()).min(1),
  sources: z.array(Text), examples: z.array(z.object({ title: Text, body: Text }).strict()),
}).strict();
export const InterviewCatalogSchema = z.object({
  schemaVersion: z.literal("1"), catalogRevision: Revision, catalogDigest: Digest,
  maturity: z.literal("research_draft"), reviewedAt: Text, sourcePacketDigest: Digest,
  sourceFiles: z.array(z.object({ path: Text, sha256: Digest }).strict()),
  topics: z.array(z.object({ id: Text, name: Text, prefix: Text, questionIds: z.array(Id) }).strict()),
  questions: z.array(InterviewQuestionCardSchema),
  retiredQuestions: z.array(z.object({ id: Id, retiredAt: Text, reason: Text, replacementId: z.null() }).strict()),
  sources: z.array(z.object({ id: Text, title: Text, url: z.url(), authorId: Text, readingCoverage: Text,
    readingCoverageKind: z.enum(["article", "selected_passage", "overview", "official_guidance", "research_update"]),
    note: Text, questionIds: z.array(Id) }).strict()),
  authors: z.array(z.object({ id: Text, name: Text, sourceIds: z.array(Text) }).strict()),
  relationships: z.array(z.object({ fromQuestionId: Id, toQuestionId: Id, kind: z.literal("editorial_related"), reason: Text }).strict()),
  guidance: z.object({ overview: Text, sourceLedger: Text, evaluation: Text, coverage: Text, review: Text }).strict(),
}).strict();
export const InterviewCatalogQuerySchema = z.object({
  topic: z.string().trim().min(1).max(80).optional(), role: z.enum(INTERVIEW_ROLE_LENSES).optional(),
  answerFormat: z.enum(INTERVIEW_ANSWER_FORMATS).optional(), source: z.string().trim().min(1).max(20).optional(),
  search: z.string().trim().max(200).optional(), page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(121).default(121),
}).strict();
export type InterviewCatalogQuery = z.infer<typeof InterviewCatalogQuerySchema>;
export const InterviewCatalogResponseSchema = z.object({ ok: z.literal(true), catalog: InterviewCatalogSchema, page: z.number().int().min(1), pageSize: z.number().int().min(1), total: z.number().int().min(0) }).strict();
export type InterviewCatalogResponse = z.infer<typeof InterviewCatalogResponseSchema>;
export const InterviewQuestionResponseSchema = z.object({ ok: z.literal(true), catalogBinding: InterviewCatalogBindingSchema, question: InterviewQuestionCardSchema }).strict();
export type InterviewQuestionResponse = z.infer<typeof InterviewQuestionResponseSchema>;

export const InterviewEvidenceSelectionSchema = z.object({
  questionId: Id,
  evidenceIds: z.array(EvidenceId).max(MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate evidence IDs"),
}).strict();
/** Reused by worker-RPC schemas so derivation from .shape keeps the version fence. */
export function refineInterviewEvidenceSelection(
  request: { evidenceSelections?: { questionId: string; evidenceIds: string[] }[] | undefined; evidenceProfileVersion?: number | undefined; selectedQuestionIds?: string[] | undefined },
  context: z.RefinementCtx,
): void {
  if (request.evidenceSelections === undefined) return;
  if (request.evidenceProfileVersion === undefined) {
    context.addIssue({ code: "custom", path: ["evidenceProfileVersion"], message: "evidenceProfileVersion is required for explicit evidence selection" });
  }
  const seen = new Set<string>();
  for (const [index, selection] of request.evidenceSelections.entries()) {
    if (seen.has(selection.questionId)) context.addIssue({ code: "custom", path: ["evidenceSelections", index, "questionId"], message: "duplicate question evidence selection" });
    seen.add(selection.questionId);
    if (request.selectedQuestionIds && !request.selectedQuestionIds.includes(selection.questionId)) {
      context.addIssue({ code: "custom", path: ["evidenceSelections", index, "questionId"], message: "evidence question is outside selectedQuestionIds" });
    }
  }
}
export const GenerateInterviewPrepRequestSchema = z.object({
  llmModel: z.string().trim().min(1).max(120).optional(),
  selectedQuestionIds: z.array(Id).min(1).max(MAX_INTERVIEW_SELECTED_QUESTIONS).refine((ids) => new Set(ids).size === ids.length, "duplicate_question").optional(),
  catalogBinding: InterviewCatalogBindingSchema.optional(),
  evidenceSelections: z.array(InterviewEvidenceSelectionSchema).max(MAX_INTERVIEW_SELECTED_QUESTIONS).optional(),
  evidenceProfileVersion: z.number().int().min(1).optional(),
  interviewStage: z.enum(INTERVIEW_STAGES).optional(), interviewFormat: z.enum(INTERVIEW_FORMATS).optional(),
  roleLens: z.enum(INTERVIEW_ROLE_LENSES).optional(),
  roleResponsibilities: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  knownCriteria: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  selectionRationale: z.string().trim().max(2000).optional(),
}).strict().superRefine(refineInterviewEvidenceSelection);
export type GenerateInterviewPrepRequest = z.infer<typeof GenerateInterviewPrepRequestSchema>;
export const InterviewEvidenceExcerptSchema = z.object({ evidenceId: EvidenceId, sourceRef: Text, excerpt: Text, scope: z.enum(["direct", "transferable"]) }).strict();
export const InterviewSelectedQuestionSchema = z.object({ questionId: Id, cardRevision: Revision, cardDigest: Digest,
  rubricRevision: Revision, rubricDigest: Digest, answerFormat: z.enum(INTERVIEW_ANSWER_FORMATS),
  selectionRationale: Text, snapshot: InterviewQuestionCardSchema, evidenceSelectionMode: z.enum(["user_selected", "model", "deterministic"]),
  selectedEvidenceIds: z.array(EvidenceId).max(MAX_INTERVIEW_EVIDENCE_IDS_PER_QUESTION), }).strict();
export const InterviewGenerationContextSchema = z.object({
  schemaVersion: z.enum(["1", "2"]), catalogBinding: InterviewCatalogBindingSchema, contextDigest: Digest,
  selectedQuestionIds: z.array(Id).min(1).max(MAX_INTERVIEW_SELECTED_QUESTIONS),
  selectedQuestions: z.array(InterviewSelectedQuestionSchema).min(1).max(MAX_INTERVIEW_SELECTED_QUESTIONS),
  selectionMode: z.enum(["user_selected", "model", "deterministic"]), interviewStage: z.enum(INTERVIEW_STAGES),
  interviewFormat: z.enum(INTERVIEW_FORMATS), roleLens: z.enum(INTERVIEW_ROLE_LENSES),
  roleResponsibilities: z.array(Text), knownCriteria: z.array(Text),
  profile: z.object({ profileId: Text, version: z.number().int().min(1), evidence: z.array(InterviewEvidenceExcerptSchema) }).strict(),
  jobContext: z.object({ jobId: Text, title: z.string().max(500), company: z.string().max(500),
    descriptionExcerpt: z.string().max(12000), snapshotHash: Digest }).strict(),
  employerAnalysis: z.object({ generation: z.number().int().min(1), snapshotHash: Digest,
    snapshot: z.object({ roleFraming: z.string().max(4000), inferredSeniority: z.string().max(500),
      requirements: z.array(z.object({ requirementId: Text, requirementText: z.string().max(3000), sourceExcerpt: z.string().max(3000) }).strict()).max(20),
    }).strict(),
  }).strict().nullable(),
  fitReport: z.object({ generation: z.number().int().min(1), employerAnalysisGeneration: z.number().int().min(1),
    profileSnapshotVersion: z.number().int().min(1), status: z.enum(["current", "stale_excluded"]) }).strict().nullable(),
  approvedMaterials: z.array(z.object({ materialId: Text, generation: z.number().int().min(1), sha256: Digest }).strict()),
  model: z.object({ model: Text, promptVersion: Revision, gateVersion: Revision }).strict(),
  determinations: z.object({ plan: Digest, claimVerification: z.array(Digest), quality: Digest.optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.schemaVersion === "2" && (!value.determinations || value.selectionMode === "deterministic" || value.selectedQuestions.some((item) => item.evidenceSelectionMode === "deterministic"))) {
    context.addIssue({ code: "custom", message: "Version 2 requires model determination bindings" });
  }
});
const FactualSupport = z.enum(["accepted_profile_fact", "hypothetical", "new_user_statement", "needs_clarification"]);
export const InterviewQuestionMetadataSchema = z.object({
  questionId: Id, cardRevision: Revision, cardDigest: Digest, rubricRevision: Revision, rubricDigest: Digest,
  answerFormat: z.enum(INTERVIEW_ANSWER_FORMATS), selectionRationale: Text,
  evidenceLinks: z.array(InterviewEvidenceExcerptSchema),
  outline: z.array(z.object({ heading: Text, text: Text, evidenceIds: z.array(EvidenceId), factualSupport: FactualSupport }).strict()),
  gaps: z.array(z.object({ id: Text, prompt: Text, reason: Text }).strict()), probes: z.array(Text), sourceGuidanceRefs: z.array(Text),
  factualSupport: FactualSupport, userEditStatus: z.enum(["generated", "user_edited"]),
  lineAnchors: z.array(z.object({ lineId: Text, text: Text, evidenceIds: z.array(EvidenceId), requirementIds: z.array(Text),
    transformType: z.enum(["evidence_reframed", "hypothetical", "clarification", "advice"]), reason: Text }).strict()).optional(),
}).strict();
export const InterviewNoteBindingsSchema = z.object({ catalogBinding: InterviewCatalogBindingSchema.nullable().optional(),
  cardRevision: Revision.nullable().optional(), cardDigest: Digest.nullable().optional(), contextDigest: Digest.nullable().optional() }).strict();
export const InterviewQuestionNoteSchema = z.object({
  jobId: Text, questionId: Id, revision: z.number().int().min(1), noteText: z.string().max(MAX_INTERVIEW_NOTE_TEXT_LENGTH),
  factualSupport: z.enum(["supported", "unverified_user_statement", "needs_clarification", "hypothetical"]),
  editStatus: z.literal("user_edited"), sourceGeneration: z.number().int().min(1).nullable(),
  bindings: InterviewNoteBindingsSchema.nullable(), updatedAt: Text,
}).strict();
export const SaveInterviewQuestionNoteRequestSchema = z.object({
  questionId: Id, expectedRevision: z.number().int().min(0), noteText: z.string().max(MAX_INTERVIEW_NOTE_TEXT_LENGTH),
  factualSupport: z.enum(["unverified_user_statement", "needs_clarification", "hypothetical"]).optional(),
  sourceGeneration: z.number().int().min(1).nullable().optional(), bindings: InterviewNoteBindingsSchema.nullable().optional(),
}).strict();
const QueryBoolean = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean());
export const InterviewNotesQuerySchema = z.object({ questionId: Id.optional(), history: QueryBoolean.optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine((value) => !value.history || Boolean(value.questionId), "note history requires questionId");
export type InterviewNotesQuery = z.infer<typeof InterviewNotesQuerySchema>;
export const InterviewPrepHistoryQuerySchema = z.object({ generation: z.coerce.number().int().min(1).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type InterviewPrepHistoryQuery = z.infer<typeof InterviewPrepHistoryQuerySchema>;
export const InterviewNotesResponseSchema = z.object({ ok: z.literal(true), jobId: Text, notes: z.array(InterviewQuestionNoteSchema).max(100), page: z.number().int().min(1), pageSize: z.number().int().min(1), total: z.number().int().min(0) }).strict();
export type InterviewNotesResponse = z.infer<typeof InterviewNotesResponseSchema>;
export const SaveInterviewQuestionNoteResponseSchema = z.object({ ok: z.literal(true), note: InterviewQuestionNoteSchema }).strict();
export type SaveInterviewQuestionNoteResponse = z.infer<typeof SaveInterviewQuestionNoteResponseSchema>;
export const InterviewPrepItemSchema = z.object({
  itemId: Text, kind: z.enum(INTERVIEW_PREP_ITEM_KINDS), title: Text, generatedText: Text,
  evidenceIds: z.array(Text), requirementIds: z.array(Text), sourceText: z.array(Text), transformType: Text,
  control: Text, groundingAudit: z.array(Text), warnings: z.array(Text), position: z.number().int().min(0),
  questionMetadata: InterviewQuestionMetadataSchema.nullable().optional(),
}).strict();
export const InterviewPrepSchema = z.object({ jobId: Text, generation: z.number().int().min(1), status: z.enum(INTERVIEW_PREP_STATUSES),
  generatedAt: Text, model: Text.nullable(),
  gateAudit: z.object({ status: z.enum(["passed", "failed"]), fabricationFindings: z.array(Text), groundingFindings: z.array(Text), judgeVerdict: Text.nullable(), warnings: z.array(Text) }).strict(),
  items: z.array(InterviewPrepItemSchema), generationContext: InterviewGenerationContextSchema.nullable().optional(),
  staleReasons: z.array(z.enum(INTERVIEW_STALE_REASONS)).optional(),
}).strict();
export const InterviewPrepHistoryResponseSchema = z.object({ ok: z.literal(true), jobId: Text, generations: z.array(InterviewPrepSchema).max(100), page: z.number().int().min(1), pageSize: z.number().int().min(1), total: z.number().int().min(0) }).strict();
export type InterviewPrepHistoryResponse = z.infer<typeof InterviewPrepHistoryResponseSchema>;
