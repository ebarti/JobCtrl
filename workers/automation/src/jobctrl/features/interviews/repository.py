"""SQLite adapter for Interview generations, notes and determination links."""

from contextlib import contextmanager
import json


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class SqliteInterviewSession:
    def __init__(self, connection, events):
        self.source_context, self.events = connection, events

    @staticmethod
    def _prep(row):
        return (json.loads(row[0]), json.loads(row[1])) if row else None

    def next_generation(self, job_id):
        return (self.source_context.execute("SELECT MAX(generation) FROM interview_preparations WHERE job_id=?", (job_id,)).fetchone()[0] or 0) + 1

    def generation_run(self, run_id):
        row = self.source_context.execute("SELECT job_id,input_hash,selection_json FROM interview_generation_runs WHERE run_id=?", (run_id,)).fetchone()
        return {"job_id": row[0], "input_hash": row[1], "selection": json.loads(row[2])} if row else None

    def reserve_generation_run(self, run_id, job_id, input_hash, selection):
        self.source_context.execute("INSERT INTO interview_generation_runs VALUES(?,?,?,?)", (run_id, job_id, input_hash, _json(selection)))

    def preparation_for_run(self, job_id, run_id):
        row = self.source_context.execute("SELECT value_json,receipts_json FROM interview_preparations WHERE job_id=? AND origin_run_id=?", (job_id, run_id)).fetchone()
        return self._prep(row)

    def preparation(self, job_id, generation):
        row = self.source_context.execute("SELECT value_json,receipts_json FROM interview_preparations WHERE job_id=? AND generation=?", (job_id, generation)).fetchone()
        return self._prep(row)

    def preparations(self, job_id, generation, limit, offset):
        where, params = ("job_id=? AND generation=?", (job_id, generation)) if generation else ("job_id=?", (job_id,))
        total = self.source_context.execute(f"SELECT COUNT(*) FROM interview_preparations WHERE {where}", params).fetchone()[0]
        rows = self.source_context.execute(f"SELECT value_json,receipts_json FROM interview_preparations WHERE {where} ORDER BY generation DESC LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
        return total, [self._prep(row) for row in rows]

    def latest_accepted(self, job_id):
        rows = self.source_context.execute("SELECT value_json,receipts_json FROM interview_preparations WHERE job_id=? ORDER BY generation DESC", (job_id,))
        for row in rows:
            value, receipts = self._prep(row)
            if value["status"] == "accepted":
                return value, receipts
        return None

    def save_preparation(self, value, run_id, receipts):
        job_id, generation = value["jobId"], value["generation"]
        if value["status"] == "accepted":
            rows = self.source_context.execute("SELECT generation,value_json FROM interview_preparations WHERE job_id=?", (job_id,)).fetchall()
            for row in rows:
                previous = json.loads(row[1])
                if previous["status"] == "accepted":
                    previous["status"] = "superseded"
                    self.source_context.execute("UPDATE interview_preparations SET value_json=? WHERE job_id=? AND generation=?", (_json(previous), job_id, row[0]))
        self.source_context.execute("INSERT INTO interview_preparations VALUES(?,?,?,?,?)", (job_id, generation, run_id or None, _json(value), _json(receipts)))
        event = "InterviewPrepGenerated" if value["status"] == "accepted" else "InterviewPrepFailed"
        self.events.append(self.source_context, event, {"jobId": job_id, "generation": generation}, feature="interviews", aggregate_id=job_id)

    def determination(self, identity):
        row = self.source_context.execute("SELECT envelope_json,receipt_id FROM interview_determinations WHERE determination_id=?", (identity,)).fetchone()
        return (row[0], row[1]) if row else None

    def save_determination(self, determination_id, envelope_json, receipt_id):
        self.source_context.execute("INSERT INTO interview_determinations VALUES(?,?,?) ON CONFLICT(determination_id) DO NOTHING", (determination_id, envelope_json, receipt_id))

    def determination_bindings(self, receipt_ids):
        if not receipt_ids:
            return []
        placeholders = ",".join("?" for _ in receipt_ids)
        rows = self.source_context.execute(f"SELECT determination_id,receipt_id FROM interview_determinations WHERE receipt_id IN ({placeholders})", tuple(receipt_ids))
        return [{"determinationId": row[0], "receiptId": row[1]} for row in rows]

    def latest_note(self, job_id, question_id):
        row = self.source_context.execute("SELECT value_json FROM interview_notes WHERE job_id=? AND question_id=? ORDER BY revision DESC LIMIT 1", (job_id, question_id)).fetchone()
        return json.loads(row[0]) if row else None

    def notes(self, job_id, question_id, history, limit, offset):
        where, params = ("job_id=? AND question_id=?", (job_id, question_id)) if question_id else ("job_id=?", (job_id,))
        if not history:
            where += " AND revision=(SELECT MAX(n.revision) FROM interview_notes n WHERE n.job_id=interview_notes.job_id AND n.question_id=interview_notes.question_id)"
        total = self.source_context.execute(f"SELECT COUNT(*) FROM interview_notes WHERE {where}", params).fetchone()[0]
        rows = self.source_context.execute(f"SELECT value_json FROM interview_notes WHERE {where} ORDER BY question_id,revision DESC LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
        return total, [json.loads(row[0]) for row in rows]

    def save_note(self, value):
        self.source_context.execute("INSERT INTO interview_notes VALUES(?,?,?,?)", (value["jobId"], value["questionId"], value["revision"], _json(value)))
        self.events.append(self.source_context, "InterviewQuestionNoteSaved", {"jobId": value["jobId"], "questionId": value["questionId"], "revision": value["revision"]}, feature="interviews", aggregate_id=value["jobId"])

    def delete_job_data(self, job_id):
        self.source_context.execute("DELETE FROM interview_notes WHERE job_id=?", (job_id,))
        self.source_context.execute("DELETE FROM interview_preparations WHERE job_id=?", (job_id,))
        self.source_context.execute("DELETE FROM interview_generation_runs WHERE job_id=?", (job_id,))
        prefix = job_id + ":question:"
        self.source_context.execute("DELETE FROM interview_determinations WHERE json_extract(envelope_json,'$.entity_id')=? OR substr(json_extract(envelope_json,'$.entity_id'),1,length(?))=?", (job_id, prefix, prefix))
        self.events.append(self.source_context, "InterviewDataDeleted", {"jobId": job_id}, feature="interviews", aggregate_id=job_id)


class SqliteInterviewRepository:
    def __init__(self, database, events, workspace):
        self.database, self.events, self.workspace = database, events, workspace

    @contextmanager
    def read_session(self, source_context=None):
        if source_context is not None:
            yield SqliteInterviewSession(source_context, self.events)
        else:
            with self.database.connect() as connection:
                connection.execute("BEGIN")
                yield SqliteInterviewSession(connection, self.events)

    @contextmanager
    def transaction(self, source_context=None):
        if source_context is not None:
            yield SqliteInterviewSession(source_context, self.events)
        else:
            with self.database.transaction() as connection:
                yield SqliteInterviewSession(connection, self.events)
