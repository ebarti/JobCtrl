import { createHash } from "node:crypto";
import {
  InterviewCatalogSchema,
  type GenerateInterviewPrepRequest,
  type InterviewCatalog,
  type InterviewCatalogQuery,
  type InterviewCatalogResponse,
  type InterviewQuestionResponse,
} from "./contracts.js";
import { InterviewCatalogAssetError, loadInterviewCatalogAsset, type InterviewCatalogAsset } from "./interview-catalog-asset.js";

export type InterviewCatalogReader = () => InterviewCatalog;

export class InterviewSelectionInputError extends Error {
  constructor(readonly code: "unknown_question" | "retired_question" | "catalog_mismatch", readonly questionId?: string) {
    super(code === "catalog_mismatch" ? "The interview catalog has changed. Review the selection before generating." : `Interview question ${questionId} is ${code === "retired_question" ? "retired" : "unknown"}.`);
  }
}

export function createInterviewCatalogReader(
  loadAsset: () => InterviewCatalogAsset = loadInterviewCatalogAsset,
): InterviewCatalogReader {
  let snapshot: InterviewCatalog | undefined;
  return () => {
    if (!snapshot) {
      try {
        const catalog = InterviewCatalogSchema.parse(loadAsset().data);
        const { catalogDigest, ...content } = catalog;
        const digest = createHash("sha256").update(JSON.stringify(sortJsonKeys(content))).digest("hex");
        if (digest !== catalogDigest) throw new InterviewCatalogAssetError();
        snapshot = catalog;
      } catch {
        throw new InterviewCatalogAssetError();
      }
    }
    // Consumers receive a snapshot: filtered results cannot change the authority.
    return structuredClone(snapshot);
  };
}

export function listInterviewCatalog(catalog: InterviewCatalog, query: InterviewCatalogQuery): InterviewCatalogResponse {
  const sourceQuestions = query.source === undefined ? null
    : new Set(catalog.sources.find((source) => source.id === query.source)?.questionIds ?? []);
  const search = query.search?.toLowerCase();
  const questions = catalog.questions.filter((question) =>
    (!query.topic || question.topic === query.topic)
    && (!query.role || question.roleLenses.includes(query.role))
    && (!query.answerFormat || question.answerFormats.includes(query.answerFormat))
    && (!sourceQuestions || sourceQuestions.has(question.id))
    && (!search || [question.id, question.title, question.variants, question.intent,
      ...question.responsibilityTags, ...question.competencyTags].join(" ").toLowerCase().includes(search)),
  );
  const offset = (query.page - 1) * query.pageSize;
  return { ok: true, catalog: { ...catalog, questions: questions.slice(offset, offset + query.pageSize) },
    page: query.page, pageSize: query.pageSize, total: questions.length };
}

export function getInterviewQuestion(catalog: InterviewCatalog, questionId: string): InterviewQuestionResponse {
  if (catalog.retiredQuestions.some((question) => question.id === questionId)) {
    throw new InterviewSelectionInputError("retired_question", questionId);
  }
  const question = catalog.questions.find((question) => question.id === questionId);
  if (!question) throw new InterviewSelectionInputError("unknown_question", questionId);
  return { ok: true, catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, question };
}

/** Semantic validation precedes worker dispatch and any provider spend. */
export function validateInterviewGenerationSelection(catalog: InterviewCatalog, request: GenerateInterviewPrepRequest): void {
  if (request.catalogBinding && (request.catalogBinding.catalogRevision !== catalog.catalogRevision
    || request.catalogBinding.catalogDigest !== catalog.catalogDigest)) {
    throw new InterviewSelectionInputError("catalog_mismatch");
  }
  for (const questionId of request.selectedQuestionIds ?? []) getInterviewQuestion(catalog, questionId);
  for (const selection of request.evidenceSelections ?? []) getInterviewQuestion(catalog, selection.questionId);
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortJsonKeys(item)]));
}
