import { createHash } from "node:crypto";
import type { InterviewCatalog, InterviewGenerationContext, InterviewQuestionCard } from "../src/contracts.js";
import type { InterviewCatalogAsset } from "../src/interview-catalog-asset.js";

export function syntheticInterviewCatalogAsset(): InterviewCatalogAsset {
  const question = (id: string, topic: string, title: string): InterviewQuestionCard => ({
    id, title, topic, status: "active", maturity: "research_draft", cardRevision: "1", cardDigest: "a".repeat(64),
    rubricRevision: "1", rubricDigest: "b".repeat(64), roleLenses: ["staff_principal"], responsibilityTags: ["technical_strategy"],
    competencyTags: ["decision_quality"], answerFormats: ["principle"], defaultAnswerFormat: "principle",
    attributionKind: "editorial_synthesis", sourceRef: `public/${topic}.md`, variants: "", intent: "Explain the decision",
    answer: "Describe alternatives and tradeoffs", adaptation: "", alternatives: "Sound alternatives are valid",
    probes: "What changes the decision?", failures: "", provenance: "Public synthetic fixture",
    rubric: [{ dimension: "reasoning", weak: "No alternatives", strong: "Explains tradeoffs" }], sources: ["S01"], examples: [],
  });
  const content = {
    schemaVersion: "1" as const, catalogRevision: "test.1", maturity: "research_draft" as const,
    reviewedAt: "2026-10-01", sourcePacketDigest: "c".repeat(64), sourceFiles: [],
    topics: [{ id: "technical-strategy", name: "Technical strategy", prefix: "TS", questionIds: ["TS09", "TS10"] }],
    questions: [question("TS09", "technical-strategy", "Choose among sound alternatives"), question("TS10", "technical-strategy", "Explain a boundary")],
    retiredQuestions: [{ id: "C08", retiredAt: "2026-10-01", reason: "Reserved retired ID", replacementId: null }],
    sources: [{ id: "S01", title: "Synthetic editorial source", url: "https://example.test/source", authorId: "A01",
      readingCoverage: "Overview", readingCoverageKind: "overview" as const, note: "Draft guidance", questionIds: ["TS09"] }],
    authors: [{ id: "A01", name: "Synthetic author", sourceIds: ["S01"] }], relationships: [],
    guidance: { overview: "Research draft", sourceLedger: "Synthetic", evaluation: "No grading", coverage: "Bounded", review: "Draft" },
  };
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  const catalog: InterviewCatalog = { ...content, catalogDigest: createHash("sha256").update(JSON.stringify(sorted(content))).digest("hex") };
  const rawBytes = Buffer.from(JSON.stringify(catalog));
  return { data: catalog, rawBytes, rawDigest: createHash("sha256").update(rawBytes).digest("hex") };
}

export function syntheticInterviewGenerationContext(jobId: string): InterviewGenerationContext {
  const catalog = syntheticInterviewCatalogAsset().data as InterviewCatalog;
  const card = catalog.questions[0]!;
  return {
    schemaVersion: "1", catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest },
    contextDigest: "d".repeat(64), selectedQuestionIds: [card.id],
    selectedQuestions: [{ questionId: card.id, cardRevision: card.cardRevision, cardDigest: card.cardDigest,
      rubricRevision: card.rubricRevision, rubricDigest: card.rubricDigest, answerFormat: "principle",
      selectionRationale: "Explicit synthetic selection", snapshot: card, evidenceSelectionMode: "deterministic", selectedEvidenceIds: ["evidence-1"] }],
    selectionMode: "user_selected", interviewStage: "technical", interviewFormat: "video", roleLens: "staff_principal",
    roleResponsibilities: ["technical_strategy"], knownCriteria: ["decision_quality"],
    profile: { profileId: "default", version: 1, evidence: [{ evidenceId: "evidence-1", sourceRef: "resume.experience_entries[role-1].bullets[0]", excerpt: "Synthetic supported contribution", scope: "direct" }] },
    jobContext: { jobId, title: "Synthetic job", company: "Example", descriptionExcerpt: "Synthetic responsibilities",
      snapshotHash: createHash("sha256").update("Synthetic job\n\nSynthetic responsibilities").digest("hex") },
    employerAnalysis: null, fitReport: null, approvedMaterials: [],
    model: { model: "synthetic", promptVersion: "1", gateVersion: "1" },
  };
}
