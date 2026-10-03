import { InterviewNotesQuerySchema, SaveInterviewQuestionNoteRequestSchema, type InterviewQuestionNote } from "@jobctrl/contracts";
import { http, HttpResponse } from "msw";

import { sampleInterviewCatalogResponse } from "../fixtures/interviews.js";
import { sampleInterviewPrep } from "../fixtures/projections.js";

const notes = new Map<string, InterviewQuestionNote[]>();
export function resetInterviewMocks() { notes.clear(); }

export const interviewHandlers = [
  http.get("*/v1/interviews/catalog", () => HttpResponse.json(sampleInterviewCatalogResponse)),
  http.get("*/v1/interviews/questions/:questionId", ({ params }) => {
    const catalog = sampleInterviewCatalogResponse.catalog;
    if (catalog.retiredQuestions.some((question) => question.id === params["questionId"])) return HttpResponse.json({ ok: false, error: "retired_question" }, { status: 410 });
    const question = catalog.questions.find((card) => card.id === params["questionId"]);
    return question ? HttpResponse.json({ ok: true, catalogBinding: { catalogRevision: catalog.catalogRevision, catalogDigest: catalog.catalogDigest }, question }) : HttpResponse.json({ ok: false, error: "unknown_question" }, { status: 404 });
  }),
  http.get("*/v1/jobs/:jobKey/interview-prep/history", ({ params }) => HttpResponse.json({ ok: true, jobId: String(params["jobKey"]), generations: [{ ...sampleInterviewPrep, jobId: String(params["jobKey"]) }], page: 1, pageSize: 20, total: 1 })),
  http.get("*/v1/jobs/:jobKey/interview-notes", ({ params, request }) => {
    const url = new URL(request.url);
    const query = InterviewNotesQuerySchema.parse(Object.fromEntries(url.searchParams));
    const jobId = String(params["jobKey"]);
    const all = [...notes.values()].filter((rows) => rows[0]?.jobId === jobId && (!query.questionId || rows[0]?.questionId === query.questionId));
    const rows = all.flatMap((revisions) => query.history ? [...revisions].reverse() : revisions.slice(-1));
    return HttpResponse.json({ ok: true, jobId, notes: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), page: query.page, pageSize: query.pageSize, total: rows.length });
  }),
  http.post("*/v1/jobs/:jobKey/interview-notes", async ({ params, request }) => {
    const body = SaveInterviewQuestionNoteRequestSchema.safeParse(await request.json());
    if (!body.success) return HttpResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    const jobId = String(params["jobKey"]);
    const key = JSON.stringify([jobId, body.data.questionId]);
    const revisions = notes.get(key) ?? [];
    const currentNote = revisions.at(-1) ?? null;
    if ((currentNote?.revision ?? 0) !== body.data.expectedRevision) return HttpResponse.json({ ok: false, error: "interview_note_revision_conflict", currentNote }, { status: 409 });
    const note: InterviewQuestionNote = { jobId, questionId: body.data.questionId, revision: body.data.expectedRevision + 1, noteText: body.data.noteText, factualSupport: body.data.factualSupport ?? "unverified_user_statement", editStatus: "user_edited", sourceGeneration: body.data.sourceGeneration === undefined ? currentNote?.sourceGeneration ?? null : body.data.sourceGeneration, bindings: body.data.bindings === undefined ? currentNote?.bindings ?? null : body.data.bindings, updatedAt: "2026-10-01T12:00:00Z" };
    notes.set(key, [...revisions, note]);
    return HttpResponse.json({ ok: true, note });
  }),
];
