import {
  InterviewNotesQuerySchema,
  InterviewNotesResponseSchema,
  InterviewQuestionNoteSchema,
  SaveInterviewQuestionNoteRequestSchema,
  type InterviewNotesQuery,
  type InterviewNotesResponse,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import type { z } from "zod";

type InterviewQuestionNote = z.output<typeof InterviewQuestionNoteSchema>;
type SaveInterviewQuestionNoteRequest = z.input<typeof SaveInterviewQuestionNoteRequestSchema>;

interface NoteRow {
  job_id: string;
  question_id: string;
  revision: number;
  note_text: string;
  factual_support: string;
  edit_status: string;
  source_generation: number | null;
  bindings_json: string | null;
  updated_at: string;
}

export class InterviewNoteRevisionConflictError extends Error {
  constructor(readonly currentNote: InterviewQuestionNote | null) {
    super("This interview note has a newer saved revision. Your edits have not been overwritten.");
  }
}

export class InterviewNoteSourceError extends Error {
  constructor() { super("The source preparation generation does not belong to this job."); }
}

function noteFromRow(row: NoteRow): InterviewQuestionNote {
  return InterviewQuestionNoteSchema.parse({
    jobId: row.job_id, questionId: row.question_id, revision: row.revision,
    noteText: row.note_text, factualSupport: row.factual_support, editStatus: row.edit_status,
    sourceGeneration: row.source_generation,
    bindings: row.bindings_json === null ? null : JSON.parse(row.bindings_json),
    updatedAt: row.updated_at,
  });
}

export function readInterviewNote(db: SqliteDatabase, tenantId: string, jobId: string, questionId: string): InterviewQuestionNote | null {
  const row = db.prepare("SELECT * FROM job_interview_notes WHERE tenant_id = ? AND job_id = ? AND question_id = ?")
    .get(tenantId, jobId, questionId) as NoteRow | undefined;
  return row ? noteFromRow(row) : null;
}

export function listInterviewNotes(db: SqliteDatabase, tenantId: string, jobId: string, input: InterviewNotesQuery): InterviewNotesResponse {
  const query = InterviewNotesQuerySchema.parse(input);
  return db.transaction(() => {
    // The table is selected only from this allowlist, never from request text.
    const table = query.history ? "job_interview_note_revisions" : "job_interview_notes";
    const predicate = `tenant_id = ? AND job_id = ?${query.questionId ? " AND question_id = ?" : ""}`;
    const params = [tenantId, jobId, ...(query.questionId ? [query.questionId] : [])];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${predicate} ORDER BY question_id ASC, revision DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as NoteRow[];
    return InterviewNotesResponseSchema.parse({ ok: true, jobId, notes: rows.map(noteFromRow),
      page: query.page, pageSize: query.pageSize, total });
  })();
}

/** Compare-and-swap, revision archive and safe event are one transaction. */
export function saveInterviewNote(db: SqliteDatabase, tenantId: string, jobId: string, input: SaveInterviewQuestionNoteRequest): InterviewQuestionNote {
  const request = SaveInterviewQuestionNoteRequestSchema.parse(input);
  return db.transaction(() => {
    const current = readInterviewNote(db, tenantId, jobId, request.questionId);
    if ((current?.revision ?? 0) !== request.expectedRevision) throw new InterviewNoteRevisionConflictError(current);
    const sourceGeneration = request.sourceGeneration === undefined ? (current?.sourceGeneration ?? null) : request.sourceGeneration;
    if (sourceGeneration != null && !db.prepare(
      "SELECT 1 FROM job_interview_prep WHERE tenant_id = ? AND job_id = ? AND generation = ?",
    ).get(tenantId, jobId, sourceGeneration)) throw new InterviewNoteSourceError();
    const revision = request.expectedRevision + 1;
    const updatedAt = new Date().toISOString();
    const bindings = request.bindings === undefined ? (current?.bindings ?? null) : request.bindings;
    const bindingsJson = bindings === null ? null : JSON.stringify(bindings);
    const support = request.factualSupport ?? "unverified_user_statement";
    if (current) {
      const result = db.prepare(`UPDATE job_interview_notes SET revision = ?, note_text = ?, factual_support = ?,
        edit_status = 'user_edited', source_generation = ?, bindings_json = ?, updated_at = ?
        WHERE tenant_id = ? AND job_id = ? AND question_id = ? AND revision = ?`)
        .run(revision, request.noteText, support, sourceGeneration, bindingsJson, updatedAt,
          tenantId, jobId, request.questionId, request.expectedRevision);
      if (result.changes !== 1) throw new InterviewNoteRevisionConflictError(readInterviewNote(db, tenantId, jobId, request.questionId));
    } else {
      db.prepare(`INSERT INTO job_interview_notes (tenant_id, job_id, question_id, revision, note_text,
        factual_support, edit_status, source_generation, bindings_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'user_edited', ?, ?, ?)`)
        .run(tenantId, jobId, request.questionId, revision, request.noteText, support, sourceGeneration, bindingsJson, updatedAt);
    }
    db.prepare(`INSERT INTO job_interview_note_revisions (tenant_id, job_id, question_id, revision, note_text,
      factual_support, edit_status, source_generation, bindings_json, updated_at)
      SELECT tenant_id, job_id, question_id, revision, note_text, factual_support, edit_status,
      source_generation, bindings_json, updated_at FROM job_interview_notes
      WHERE tenant_id = ? AND job_id = ? AND question_id = ?`)
      .run(tenantId, jobId, request.questionId);
    db.prepare(`INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES (?, ?, 1, 'tailor', 'InterviewQuestionNoteSaved', 'info', 'Interview question note saved', ?, ?)`)
      .run(tenantId, jobId, updatedAt, JSON.stringify({ jobId, questionId: request.questionId, revision, sourceGeneration, updatedAt }));
    return readInterviewNote(db, tenantId, jobId, request.questionId)!;
  }).immediate();
}
