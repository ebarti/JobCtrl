import { InterviewCatalogSchema, type InterviewCatalogResponse, type InterviewPrep } from "@jobctrl/contracts";
import sharedCatalog from "../../../../../workers/automation/src/jobctrl/assets/interview/catalog.v1.json" with { type: "json" };

import { sampleInterviewPrep } from "./projections.js";

export const sampleInterviewCatalogResponse: InterviewCatalogResponse = {
  ok: true, catalog: InterviewCatalogSchema.parse(sharedCatalog), page: 1, pageSize: 121, total: 121,
};

export function makeQuestionPrep(questionId = "B11", jobId = "job-1"): InterviewPrep {
  const catalog = sampleInterviewCatalogResponse.catalog;
  const question = catalog.questions.find((card) => card.id === questionId);
  if (!question) throw new Error(`Missing shared catalog fixture question ${questionId}`);
  return {
    ...sampleInterviewPrep, jobId, generation: 2, generatedAt: "2026-10-01T12:00:00Z",
    generationContext: {
      schemaVersion: "1", catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest },
      contextDigest: "1".repeat(64), selectedQuestionIds: [questionId],
      selectedQuestions: [{ questionId, cardRevision: question.cardRevision, cardDigest: question.cardDigest, rubricRevision: question.rubricRevision, rubricDigest: question.rubricDigest, answerFormat: question.defaultAnswerFormat, selectionRationale: "Explore decision reasoning for platform responsibility.", snapshot: question, evidenceSelectionMode: "deterministic", selectedEvidenceIds: [] }],
      selectionMode: "user_selected", interviewStage: "unknown", interviewFormat: "unspecified", roleLens: "staff_principal",
      roleResponsibilities: ["Guide platform decisions across teams"], knownCriteria: ["Explain tradeoffs"],
      profile: { profileId: "profile-synthetic", version: 1, evidence: [] },
      jobContext: { jobId, title: "Staff Platform Engineer", company: "Acme Robotics", descriptionExcerpt: "Synthetic platform role", snapshotHash: "2".repeat(64) },
      employerAnalysis: null, fitReport: null, approvedMaterials: [], model: { model: "fixture-model", promptVersion: "1", gateVersion: "1" },
    },
    items: [{
      ...sampleInterviewPrep.items[0]!, itemId: `question-${questionId}`, kind: "question_outline", title: question.title,
      generatedText: "Explain the criteria, alternatives and tradeoffs you would use. Clarify missing experience before making personal claims.", evidenceIds: [], requirementIds: [], sourceText: [],
      questionMetadata: {
        questionId, cardRevision: question.cardRevision, cardDigest: question.cardDigest, rubricRevision: question.rubricRevision, rubricDigest: question.rubricDigest,
        answerFormat: question.defaultAnswerFormat, selectionRationale: "Explore decision reasoning for platform responsibility.", evidenceLinks: [],
        outline: [{ heading: "Decision criteria", text: "Describe plausible alternatives and observable consequences.", evidenceIds: [], factualSupport: "hypothetical" }],
        gaps: [{ id: "clarify-ownership", prompt: "What did you personally own?", reason: "No historical ownership fact is selected." }],
        probes: ["What would change your choice?"], sourceGuidanceRefs: question.sources, factualSupport: "hypothetical", userEditStatus: "generated",
      },
    }],
  };
}
