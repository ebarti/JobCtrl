"""SQLite adapter for reviewed screening transactions and source snapshots."""

import json
from contextlib import contextmanager

from .domain import ApplicationFailure
from .repository import encode


class _ScreeningSession:
    def __init__(self, connection, repository, sources):
        self._connection, self._repository, self._sources = connection, repository, sources

    def current(self, tenant, question):
        row = self._connection.execute(
            "SELECT state_json FROM applications_screening WHERE tenant_id=? AND question_id=? ORDER BY revision DESC LIMIT 1",
            (tenant, question),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def states(self, tenant, job):
        result = {}
        for row in self._connection.execute(
            "SELECT question_id,state_json FROM applications_screening WHERE tenant_id=? AND job_id=? ORDER BY revision", (tenant, job)
        ):
            result[row[0]] = json.loads(row[1])
        return list(result.values())

    def history(self, tenant, job):
        return [json.loads(row[0]) for row in self._connection.execute(
            "SELECT state_json FROM applications_screening WHERE tenant_id=? AND job_id=? ORDER BY recorded_at,revision", (tenant, job)
        )]

    def library(self, tenant):
        return [json.loads(row[0]) for row in self._connection.execute(
            "SELECT entry_json FROM applications_screening_library WHERE tenant_id=? ORDER BY rowid", (tenant,)
        )]

    def library_entry(self, tenant, library_id):
        row = self._connection.execute(
            "SELECT entry_json FROM applications_screening_library WHERE tenant_id=? AND library_id=?", (tenant, library_id)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def origin(self, tenant, question, revision):
        row = self._connection.execute(
            "SELECT state_json FROM applications_screening WHERE tenant_id=? AND question_id=? AND revision=?",
            (tenant, question, revision),
        ).fetchone()
        exists = self._connection.execute(
            "SELECT 1 FROM applications_screening WHERE tenant_id=? AND question_id=? LIMIT 1", (tenant, question)
        ).fetchone()
        return (json.loads(row[0]) if row else None, bool(exists))

    def failures(self, tenant, job):
        return [{"questionId": row[0], "action": row[1], "code": row[2], "recordedAt": row[3]} for row in self._connection.execute(
            "SELECT question_id,operation,failure_code,recorded_at FROM applications_failures WHERE tenant_id=? AND job_id=? ORDER BY failure_id",
            (tenant, job),
        )]

    def determination(self, tenant, identifier):
        return self._repository.get_determination(self._connection, tenant, identifier)

    def source_snapshot(self, tenant, job, fact_ids, sensitive_ids):
        return self._sources.screening_sources(tenant, job, fact_ids, sensitive_ids, self._connection)

    def repeated(self, tenant, key, request):
        return self._repository.repeated(self._connection, tenant, key, request)

    def append_state(self, tenant, job, state, expected_revision):
        latest = self.current(tenant, state["questionId"])
        if (latest["revision"] if latest else 0) != expected_revision:
            raise ApplicationFailure("screening_revision_conflict", conflict=True)
        self._connection.execute("INSERT INTO applications_screening VALUES(?,?,?,?,?,?)", (
            tenant, state["questionId"], state["revision"], job, encode(state), state["recordedAt"],
        ))

    def append_library(self, tenant, entry):
        self._connection.execute("INSERT INTO applications_screening_library VALUES(?,?,?)", (tenant, entry["libraryId"], encode(entry)))

    def save_receipt(self, tenant, key, request, response):
        self._repository.receipt(self._connection, tenant, key, request, response)

    def emit(self, tenant, job, **references):
        self._repository.event(self._connection, "ScreeningAnswerUpdated", job, **references)


class SqliteScreeningStore:
    def __init__(self, repository, sources):
        self._repository, self._sources = repository, sources
        self._payload_reader = None

    def _session(self, connection):
        return _ScreeningSession(connection, self._repository, self._sources)

    @contextmanager
    def read(self):
        with self._repository.read() as connection:
            yield self._session(connection)

    @contextmanager
    def write(self):
        with self._repository.atomic() as connection:
            yield self._session(connection)

    def model_fence(self, check):
        def fence(connection=None):
            with self._repository.read(connection) as current:
                check(self._session(current))
        return fence

    def set_payload_reader(self, reader):
        if self._payload_reader is not None:
            raise RuntimeError("Screening payload reader is already configured")
        self._payload_reader = reader

    def accepted_payload(self, connection, tenant, job):
        if self._payload_reader is None:
            raise RuntimeError("Screening payload reader is not configured")
        with self._repository.read(connection) as current:
            return self._payload_reader(self._session(current), tenant, job)

    def record_failure(self, tenant, job, operation, code, question):
        self._repository.failure(tenant, job, operation, code, question)
