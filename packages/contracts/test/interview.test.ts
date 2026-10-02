import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { InterviewCatalog, InterviewGenerationContext, InterviewQuestionMetadata, InterviewQuestionNote } from "@jobctrl/domain-types";
import {
  GenerateInterviewPrepRequestSchema, InterviewCatalogSchema, InterviewGenerationContextSchema,
  InterviewQuestionCardSchema, InterviewEvidenceSelectionSchema, InterviewSelectedQuestionSchema,
  InterviewQuestionMetadataSchema, InterviewQuestionNoteSchema, SaveInterviewQuestionNoteRequestSchema,
  InterviewPrepSchema, InterviewPrepHistoryQuerySchema, InterviewNotesQuerySchema,
  InterviewPrepHistoryResponseSchema, InterviewNotesResponseSchema,
} from "../src/interview.js";

const raw = readFileSync(new URL("../../../workers/automation/src/jobctrl/assets/interview/catalog.v1.json", import.meta.url));
const catalog = InterviewCatalogSchema.parse(JSON.parse(raw.toString("utf8")));
const digest = "a".repeat(64);

describe("interview wire vocabulary", () => {
  it("validates the one tracked Python/TS catalog and keeps its draft guidance", () => {
    expectTypeOf(catalog).toEqualTypeOf<InterviewCatalog>();
    expect(catalog.questions).toHaveLength(121);
    expect(catalog.retiredQuestions.map((card) => card.id)).toEqual(["C08"]);
    for (const id of ["B11", "TS09"]) {
      expect(catalog.questions.find((card) => card.id === id)?.defaultAnswerFormat).toBe("principle");
    }
    expect(catalog.questions.find((card) => card.id === "C07")?.answer).toContain("Persist in seeking the range");
    expect(catalog.guidance.sourceLedger).toContain("full book not read");
    expect(createHash("sha256").update(raw).digest("hex")).toBe("20fab11dab969ecd619f1c98fe1ae6e6b46392019f6d48322952de5d832d121f");
  });

  it("keeps old requests readable and bounds ordered selection and target data", () => {
    expect(GenerateInterviewPrepRequestSchema.parse({})).toEqual({});
    expect(GenerateInterviewPrepRequestSchema.parse({ selectedQuestionIds: ["TS09", "B11"], interviewStage: "unknown", roleLens: "unknown" }).selectedQuestionIds).toEqual(["TS09", "B11"]);
    for (const input of [
      { selectedQuestionIds: [] }, { selectedQuestionIds: ["C01", "C01"] },
      { selectedQuestionIds: Array.from({ length: 17 }, (_, index) => `B${String(index + 1).padStart(2, "0")}`) },
      { selectedQuestionIds: ["../../private"] }, { roleResponsibilities: Array(21).fill("delivery") },
      { knownCriteria: ["x".repeat(1001)] }, { profileFacts: "unsupported caller field" },
    ]) expect(GenerateInterviewPrepRequestSchema.safeParse(input).success).toBe(false);
  });

  it("version-fences explicit evidence choices and preserves an explicit empty choice", () => {
    const request = { selectedQuestionIds: ["B11", "TS09"], evidenceProfileVersion: 3,
      evidenceSelections: [{ questionId: "B11", evidenceIds: [] }, { questionId: "TS09", evidenceIds: ["fact-b", "fact-a"] }] };
    expect(GenerateInterviewPrepRequestSchema.parse(request).evidenceSelections).toEqual(request.evidenceSelections);
    expect(GenerateInterviewPrepRequestSchema.parse({ selectedQuestionIds: ["B11"] }).evidenceSelections).toBeUndefined();
    const { evidenceProfileVersion: _version, ...unfenced } = request;
    for (const input of [unfenced, { ...request, evidenceProfileVersion: 0 },
      { ...request, evidenceSelections: [{ questionId: "B11", evidenceIds: ["fact-a", "fact-a"] }] },
      { ...request, evidenceSelections: [{ questionId: "B11", evidenceIds: [] }, { questionId: "B11", evidenceIds: [] }] },
      { ...request, evidenceSelections: [{ questionId: "C01", evidenceIds: [] }] },
      { ...request, evidenceSelections: [{ questionId: "B11", evidenceIds: Array.from({ length: 9 }, (_, i) => `fact-${i}`) }] },
      { ...request, evidenceSelections: Array.from({ length: 17 }, (_, i) => ({ questionId: `B${String(i + 1).padStart(2, "0")}`, evidenceIds: [] })) },
    ]) expect(GenerateInterviewPrepRequestSchema.safeParse(input).success).toBe(false);
  });

  it("bounds question IDs independently from canonical evidence IDs", () => {
    const oversized = "A".repeat(200_000) + "01";
    const boundary = "A".repeat(10) + "01";
    expect(GenerateInterviewPrepRequestSchema.safeParse({ selectedQuestionIds: [boundary] }).success).toBe(true);
    expect(GenerateInterviewPrepRequestSchema.safeParse({ selectedQuestionIds: [oversized] }).success).toBe(false);
    expect(GenerateInterviewPrepRequestSchema.safeParse({ evidenceProfileVersion: 1, evidenceSelections: [{ questionId: oversized, evidenceIds: [] }] }).success).toBe(false);
    const card = catalog.questions[0]!;
    expect(InterviewQuestionCardSchema.safeParse({ ...card, id: oversized }).success).toBe(false);
    expect(SaveInterviewQuestionNoteRequestSchema.safeParse({ questionId: oversized, expectedRevision: 0, noteText: "" }).success).toBe(false);
    expect(InterviewNotesQuerySchema.safeParse({ questionId: oversized }).success).toBe(false);
    const evidenceId = "profile/accepted-fact:" + "a".repeat(178);
    expect(evidenceId).toHaveLength(200);
    expect(InterviewEvidenceSelectionSchema.safeParse({ questionId: "C01", evidenceIds: [evidenceId] }).success).toBe(true);
    expect(InterviewEvidenceSelectionSchema.safeParse({ questionId: "C01", evidenceIds: [evidenceId + "a"] }).success).toBe(false);
    const selected = { questionId: card.id, cardRevision: card.cardRevision, cardDigest: card.cardDigest,
      rubricRevision: card.rubricRevision, rubricDigest: card.rubricDigest, answerFormat: card.defaultAnswerFormat,
      selectionRationale: "Synthetic selection", snapshot: card, evidenceSelectionMode: "user_selected", selectedEvidenceIds: [evidenceId] };
    expect(InterviewSelectedQuestionSchema.safeParse(selected).success).toBe(true);
    expect(InterviewSelectedQuestionSchema.safeParse({ ...selected, selectedEvidenceIds: [evidenceId + "a"] }).success).toBe(false);
  });

  it("retains inspectable generation-time inputs and structured evidence without changing legacy prep", () => {
    const card = catalog.questions.find((question) => question.id === "B11")!;
    const evidence = { evidenceId: "evidence-1", sourceRef: "profile/experience/role-1/achievement-1", excerpt: "Synthetic verified contribution", scope: "transferable" as const };
    const context = InterviewGenerationContextSchema.parse({
      schemaVersion: "1", catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, contextDigest: digest,
      selectedQuestionIds: [card.id], selectedQuestions: [{ questionId: card.id, cardRevision: card.cardRevision, cardDigest: card.cardDigest, rubricRevision: card.rubricRevision, rubricDigest: card.rubricDigest, answerFormat: "principle", selectionRationale: "Decision criteria for this loop", snapshot: card, evidenceSelectionMode: "deterministic", selectedEvidenceIds: [evidence.evidenceId] }],
      selectionMode: "user_selected", interviewStage: "technical", interviewFormat: "video", roleLens: "staff_principal",
      roleResponsibilities: ["technical decision quality"], knownCriteria: ["Explain alternatives"],
      profile: { profileId: "synthetic-profile", version: 2, evidence: [evidence] },
      jobContext: { jobId: "synthetic-job", title: "Synthetic engineer", company: "Synthetic company", descriptionExcerpt: "Own technical decisions", snapshotHash: digest },
      employerAnalysis: { generation: 3, snapshotHash: digest, snapshot: { roleFraming: "Technical leadership", inferredSeniority: "staff", requirements: [{ requirementId: "r-1", requirementText: "Compare alternatives", sourceExcerpt: "Own technical decisions" }] } },
      fitReport: null, approvedMaterials: [{ materialId: "approved-resume", generation: 2, sha256: digest }],
      model: { model: "synthetic-model", promptVersion: "1", gateVersion: "1" },
    });
    expectTypeOf(context).toEqualTypeOf<InterviewGenerationContext>();
    const metadata = InterviewQuestionMetadataSchema.parse({ questionId: card.id, cardRevision: card.cardRevision, cardDigest: card.cardDigest, rubricRevision: card.rubricRevision, rubricDigest: card.rubricDigest, answerFormat: "principle", selectionRationale: "Decision criteria", evidenceLinks: [evidence], outline: [{ heading: "Criteria", text: "Describe a defensible criterion", evidenceIds: [], factualSupport: "hypothetical" }], gaps: [{ id: "g-1", prompt: "When did you use it?", reason: "No direct episode selected" }], probes: ["Where does the criterion fail?"], sourceGuidanceRefs: card.sources, factualSupport: "hypothetical", userEditStatus: "generated" });
    expectTypeOf(metadata).toEqualTypeOf<InterviewQuestionMetadata>();
    const legacy = InterviewPrepSchema.parse({ jobId: "job-1", generation: 1, status: "accepted", generatedAt: "2026-10-01T00:00:00Z", model: null, gateAudit: { status: "passed", fabricationFindings: [], groundingFindings: [], judgeVerdict: null, warnings: [] }, items: [] });
    expect(legacy.generationContext).toBeUndefined();
    expect(InterviewGenerationContextSchema.safeParse({ ...context, jobContext: { ...context.jobContext, descriptionExcerpt: "x".repeat(12001) } }).success).toBe(false);
  });

  it("keeps user notes unverified, independent and protected by compare-and-swap", () => {
    const request = { questionId: "B11", expectedRevision: 0, noteText: "A synthetic recollection", factualSupport: "unverified_user_statement" };
    expect(SaveInterviewQuestionNoteRequestSchema.safeParse(request).success).toBe(true);
    for (const input of [{ ...request, factualSupport: "supported" }, { ...request, expectedRevision: -1 }, { ...request, noteText: "x".repeat(20001) }, { ...request, gateAudit: { status: "passed" } }]) {
      expect(SaveInterviewQuestionNoteRequestSchema.safeParse(input).success).toBe(false);
    }
    const note = InterviewQuestionNoteSchema.parse({ jobId: "synthetic-job", questionId: "B11", revision: 1, noteText: request.noteText, factualSupport: "unverified_user_statement", editStatus: "user_edited", sourceGeneration: null, bindings: null, updatedAt: "2026-10-01T00:00:00Z" });
    expectTypeOf(note).toEqualTypeOf<InterviewQuestionNote>();
  });

  it("bounds history and note reads and distinguishes false from true history flags", () => {
    expect(InterviewPrepHistoryQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(InterviewNotesQuerySchema.parse({ history: "false" }).history).toBe(false);
    expect(InterviewNotesQuerySchema.safeParse({ history: "true" }).success).toBe(false);
    expect(InterviewNotesQuerySchema.parse({ questionId: "B11", history: "true" }).history).toBe(true);
    expect(InterviewPrepHistoryQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(InterviewNotesResponseSchema.safeParse({ ok: true, jobId: "job-1", notes: Array(101).fill({}), page: 1, pageSize: 100, total: 101 }).success).toBe(false);
    expect(InterviewPrepHistoryResponseSchema.safeParse({ ok: true, jobId: "job-1", generations: Array(101).fill({}), page: 1, pageSize: 100, total: 101 }).success).toBe(false);
  });
});
