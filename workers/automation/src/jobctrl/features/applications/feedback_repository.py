"""SQLite adapter for Applications' private feedback/outcome store contract."""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
import json

from jobctrl.app.errors import ConflictError

from .feedback_schema import SCHEMA


def _record(row):
    if row is None:
        return None
    return {key[:-5] if key.endswith("_json") else key:
            json.loads(value) if key.endswith("_json") and value is not None else value for key, value in dict(row).items()}


def _values(data, columns):
    return [json.dumps(data[column[:-5]], ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
            if column.endswith("_json") and data[column[:-5]] is not None else data[column[:-5] if column.endswith("_json") else column]
            for column in columns]


class SqliteFeedbackRepository:
    def __init__(self, runtime):
        self.database, self.events = runtime.database, runtime.events
        self.database.initialize_feature("application_feedback", SCHEMA)

    @contextmanager
    def read(self, connection=None):
        if connection is not None:
            yield connection
            return
        with self.database.connect() as conn:
            conn.execute("BEGIN")
            yield conn

    def transaction(self, connection=None):
        return nullcontext(connection) if connection is not None else self.database.transaction()

    def outcome_anchors(self, tenant_id, kinds, connection=None):
        with self.read(connection) as conn:
            return [dict(row) for row in conn.execute(
                "SELECT job_id,occurred_at anchor_at,kind,source,created_by FROM application_feedback_outcomes "
                "WHERE tenant_id=? AND kind IN (" + ",".join("?" for _ in kinds) + ") ORDER BY recorded_at,outcome_id",
                (tenant_id, *sorted(kinds)))]

    def known_message(self, message_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return conn.execute("SELECT 1 FROM application_feedback_evidence WHERE tenant_id=? AND provider='gmail' AND provider_message_id=?",
                                (tenant_id, message_id)).fetchone() is not None

    def store_message(self, evidence, suggestion, connection):
        columns = ("tenant_id", "evidence_id", "job_id", "provider", "provider_message_id", "provider_thread_id", "headers_json", "message_text",
                   "received_at", "linked_at", "body_sha256", "link_confidence", "link_receipt_id", "link_provenance_json", "link_value_json",
                   "link_sources_json", "posting_revision", "posting_hash", "anchor_at")
        connection.execute("INSERT INTO application_feedback_evidence VALUES(" + ",".join("?" for _ in columns) + ")", _values(evidence, columns))
        columns = ("tenant_id", "suggestion_id", "job_id", "evidence_id", "suggested_kind", "confidence", "rationale", "outcome_receipt_id",
                   "outcome_provenance_json", "outcome_value_json", "outcome_sources_json", "status", "version", "created_at", "decided_at",
                   "decision", "decision_reason", "decided_outcome_id", "decision_request_json", "decision_hash", "decision_fact_hash")
        connection.execute("INSERT INTO application_feedback_suggestions VALUES(" + ",".join("?" for _ in columns) + ")", _values(suggestion, columns))

    def outcome(self, outcome_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return _record(conn.execute("SELECT * FROM application_feedback_outcomes WHERE tenant_id=? AND outcome_id=?", (tenant_id, outcome_id)).fetchone())

    def outcomes(self, tenant_id, job_id=None, *, connection=None):
        with self.read(connection) as conn:
            return [_record(row) for row in conn.execute("SELECT * FROM application_feedback_outcomes WHERE tenant_id=?" +
                (" AND job_id=?" if job_id is not None else "") + " ORDER BY occurred_at DESC,recorded_at DESC,outcome_id",
                (tenant_id, job_id) if job_id is not None else (tenant_id,))]

    def suggestions(self, tenant_id, job_id=None, *, connection=None):
        with self.read(connection) as conn:
            return [_record(row) for row in conn.execute("SELECT * FROM application_feedback_suggestions WHERE tenant_id=?" +
                (" AND job_id=?" if job_id is not None else "") + " ORDER BY created_at DESC,suggestion_id",
                (tenant_id, job_id) if job_id is not None else (tenant_id,))]

    def suggestion(self, suggestion_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return _record(conn.execute("SELECT * FROM application_feedback_suggestions WHERE tenant_id=? AND suggestion_id=?", (tenant_id, suggestion_id)).fetchone())

    def evidence(self, evidence_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return _record(conn.execute("SELECT * FROM application_feedback_evidence WHERE tenant_id=? AND evidence_id=?", (tenant_id, evidence_id)).fetchone())

    def evidence_for_job(self, job_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return [_record(row) for row in conn.execute("SELECT * FROM application_feedback_evidence WHERE tenant_id=? AND job_id=? ORDER BY received_at DESC", (tenant_id, job_id))]

    def delete_job_data(self, job_id, tenant_id, connection=None):
        with self.transaction(connection) as conn:
            for table in ("application_feedback_receipts", "application_feedback_outcomes", "application_feedback_suggestions", "application_feedback_evidence"):
                conn.execute("DELETE FROM " + table + " WHERE tenant_id=? AND job_id=?", (tenant_id, job_id))

    def store_outcome(self, value, connection):
        columns = ("tenant_id", "outcome_id", "job_id", "kind", "source", "note", "occurred_at", "recorded_at", "suggestion_id",
                   "evidence_id", "interview_prep_generation", "created_by", "owned_intent_id")
        connection.execute("INSERT INTO application_feedback_outcomes VALUES(" + ",".join("?" for _ in columns) + ")", _values(value, columns))

    def action_receipt(self, operation, job_id, request_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return _record(conn.execute("SELECT * FROM application_feedback_receipts WHERE tenant_id=? AND operation=? AND job_id=? AND request_id=?",
                                       (tenant_id, operation, job_id, request_id)).fetchone())

    def store_receipt(self, value, connection):
        columns = ("tenant_id", "operation", "job_id", "request_id", "request_hash", "outcome_id", "fact_hash", "created_at")
        connection.execute("INSERT INTO application_feedback_receipts VALUES(?,?,?,?,?,?,?,?)", _values(value, columns))

    def confirmed_outcomes(self, tenant_id, job_id=None, *, connection=None):
        with self.read(connection) as conn:
            return [_record(row) for row in conn.execute("SELECT * FROM application_feedback_outcomes WHERE tenant_id=? AND kind='applied_confirmation'" +
                (" AND job_id=?" if job_id is not None else "") + " ORDER BY occurred_at,outcome_id", (tenant_id, job_id) if job_id is not None else (tenant_id,))]

    def decide_suggestion(self, suggestion_id, tenant_id, expected_version, changes, connection):
        columns = ("status", "decided_at", "decision", "decision_reason", "decided_outcome_id", "decision_request_json", "decision_hash")
        changed = connection.execute("UPDATE application_feedback_suggestions SET version=version+1," + ",".join(column + "=?" for column in columns) +
            " WHERE tenant_id=? AND suggestion_id=? AND status='pending' AND version=?", (*_values(changes, columns), tenant_id, suggestion_id, expected_version)).rowcount
        if changed != 1:
            raise ConflictError("The outcome suggestion changed before its decision was saved.")
        return self.suggestion(suggestion_id, tenant_id, connection)

    def store_decision_fingerprint(self, suggestion_id, tenant_id, fingerprint, connection):
        connection.execute("UPDATE application_feedback_suggestions SET decision_fact_hash=? WHERE tenant_id=? AND suggestion_id=?", (fingerprint, tenant_id, suggestion_id))

    def first_offer(self, job_id, tenant_id, connection=None):
        with self.read(connection) as conn:
            return _record(conn.execute("SELECT * FROM application_feedback_outcomes WHERE tenant_id=? AND job_id=? AND kind='offer' ORDER BY occurred_at,outcome_id LIMIT 1",
                                       (tenant_id, job_id)).fetchone())

    def suggestion_counts(self, tenant_id, connection=None):
        with self.read(connection) as conn:
            return dict(conn.execute("SELECT status,COUNT(*) FROM application_feedback_suggestions WHERE tenant_id=? AND status!='pending' GROUP BY status", (tenant_id,)))

    def append_event(self, connection, event_type, payload, job_id):
        self.events.append(connection, event_type, payload, feature="applications", aggregate_id=job_id)
