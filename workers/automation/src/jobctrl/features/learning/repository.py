"""SQLite unit of work for Learning's data, receipts and committed events."""

from contextlib import contextmanager, nullcontext
import json

from jobctrl.app.errors import AppError
from jobctrl.features.learning.idempotency import request_lock


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class SqliteLearningSession:
    def __init__(self, connection, events):
        self.source_context, self.events = connection, events

    @staticmethod
    def _names(kind):
        if kind == "cohort":
            return "learning_cohorts", "cohort_id", "cohortId"
        if kind == "milestone":
            return "learning_milestones", "milestone_id", "milestoneId"
        raise ValueError("unknown learning aggregate")

    @staticmethod
    def _decode(row, field):
        value = json.loads(row[2])
        if value.get(field) != row[0] or value.get("revision") != row[1]:
            raise AppError("learning_binding_invalid", "The saved learning record provenance is invalid.", status_code=409)
        return value

    def latest(self, kind, identity):
        table, key, field = self._names(kind)
        row = self.source_context.execute(f"SELECT {key},revision,value_json FROM {table} WHERE {key}=? ORDER BY revision DESC LIMIT 1", (identity,)).fetchone()
        return self._decode(row, field) if row else None

    def list_latest(self, kind, limit):
        table, key, field = self._names(kind)
        rows = self.source_context.execute(f"SELECT {key},revision,value_json FROM {table} WHERE ({key},revision) IN (SELECT {key},MAX(revision) FROM {table} GROUP BY {key}) ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [self._decode(row, field) for row in rows]

    def history(self, milestone_id, limit):
        rows = self.source_context.execute("SELECT value_json FROM learning_milestones WHERE milestone_id=? ORDER BY revision DESC LIMIT ?", (milestone_id, limit)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def latest_attempt(self, cohort_id):
        row = self.source_context.execute("SELECT failure_code,occurred_at FROM learning_attempts WHERE cohort_id=? ORDER BY id DESC LIMIT 1", (cohort_id,)).fetchone()
        return {"cohortId": cohort_id, "failureCode": row[0], "occurredAt": row[1]} if row else None

    def operation_for_receipt(self, receipt_id):
        row = self.source_context.execute("SELECT operation_id FROM learning_requests WHERE model_receipt_id=?", (receipt_id,)).fetchone()
        return row[0] if row else None

    def request(self, identity):
        row = self.source_context.execute("SELECT * FROM learning_requests WHERE operation_id=?", (identity,)).fetchone()
        return dict(row) if row else None

    def reserve_request(self, identity, input_hash, action, cohort_id, at):
        self.source_context.execute("INSERT INTO learning_requests(operation_id,input_hash,action,state,cohort_id,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)",
                                    (identity, input_hash, action, cohort_id, at, at))

    def begin_model(self, identity, snapshot, selection, fingerprint, at):
        self.source_context.execute("UPDATE learning_requests SET state='model_pending',snapshot_json=?,selection_json=?,model_fingerprint=?,updated_at=? WHERE operation_id=? AND state='pending'",
                                    (_json(snapshot), _json(selection), fingerprint, at, identity))

    def bind_receipt(self, identity, receipt_id, fingerprint, at):
        return self.source_context.execute("UPDATE learning_requests SET model_receipt_id=?,updated_at=? WHERE operation_id=? AND state='model_pending' AND model_fingerprint=?",
                                           (receipt_id, at, identity, fingerprint)).rowcount == 1

    def finish_request(self, identity, response, at):
        return self.source_context.execute("UPDATE learning_requests SET state='complete',result_json=?,updated_at=? WHERE operation_id=? AND state IN ('pending','model_pending')",
                                           (_json(response), at, identity)).rowcount == 1

    def fail_request(self, identity, error, at):
        self.source_context.execute("UPDATE learning_requests SET state='failed',error_json=?,updated_at=? WHERE operation_id=? AND state!='complete'", (_json(error), at, identity))

    def save_cohort(self, value):
        self.source_context.execute("INSERT INTO learning_cohorts VALUES(?,?,?)", (value["cohortId"], value["revision"], _json(value)))
        self.events.append(self.source_context, "CareerLearningRecorded", {"cohortId": value["cohortId"], "revision": value["revision"]}, feature="learning", aggregate_id=value["cohortId"])

    def save_milestone(self, value):
        self.source_context.execute("INSERT INTO learning_milestones VALUES(?,?,?)", (value["milestoneId"], value["revision"], _json(value)))
        self.events.append(self.source_context, "CareerLearningRecorded", {"milestoneId": value["milestoneId"], "revision": value["revision"]}, feature="learning", aggregate_id=value["milestoneId"])

    def record_attempt(self, cohort_id, code, at, *, publish):
        self.source_context.execute("INSERT INTO learning_attempts(cohort_id,failure_code,occurred_at) VALUES(?,?,?)", (cohort_id, code, at))
        if publish:
            self.events.append(self.source_context, "CareerLearningRecorded", {"cohortId": cohort_id, "failureCode": code}, feature="learning", aggregate_id=cohort_id)


class SqliteLearningRepository:
    def __init__(self, database, events, workspace):
        self.database, self.events, self.workspace = database, events, workspace

    @contextmanager
    def read_session(self, session=None):
        if session is not None:
            with nullcontext(session) as current:
                yield current
        else:
            with self.database.connect() as connection:
                connection.execute("BEGIN")
                yield SqliteLearningSession(connection, self.events)

    @contextmanager
    def transaction(self, session=None):
        if session is not None:
            with nullcontext(session) as current:
                yield current
        else:
            with self.database.transaction() as connection:
                yield SqliteLearningSession(connection, self.events)

    def request_lock(self, identity):
        return request_lock(self.workspace, identity)
