"""SQLite adapter for repeat checks and one-use submission consent."""

import json
from contextlib import contextmanager

from .repository import encode


class _RepeatSession:
    def __init__(self, connection, repository, sources, feedback):
        self._connection, self._repository, self._sources, self._feedback = connection, repository, sources, feedback

    def job_snapshot(self, job):
        return self._sources.job_snapshot(job, self._connection)

    def confirmed_applications(self, tenant):
        return self._feedback.confirmed_applications(connection=self._connection, tenant_id=tenant)

    def check(self, tenant, job, evidence_hash):
        row = self._connection.execute(
            "SELECT check_json FROM applications_repeat_checks WHERE tenant_id=? AND job_id=? AND evidence_sha256=? ORDER BY recorded_at DESC,check_id DESC LIMIT 1",
            (tenant, job, evidence_hash),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def determination(self, tenant, identifier):
        return self._repository.get_determination(self._connection, tenant, identifier)

    def override(self, tenant, job, check_id, evidence_hash):
        row = self._connection.execute(
            "SELECT override_id,created_at,used_by_run_id,used_at FROM applications_repeat_overrides WHERE tenant_id=? AND job_id=? AND check_id=? AND evidence_sha256=?",
            (tenant, job, check_id, evidence_hash),
        ).fetchone()
        return {"overrideId": row[0], "createdAt": row[1], "usedByRunId": row[2], "usedAt": row[3]} if row else None

    def repeated(self, tenant, key, request):
        return self._repository.repeated(self._connection, tenant, key, request)

    def has_intent(self, tenant, job):
        return self._repository.intent(self._connection, tenant, job) is not None

    def append_check(self, tenant, job, evidence_hash, check):
        self._connection.execute("INSERT INTO applications_repeat_checks VALUES(?,?,?,?,?,?)", (
            tenant, check["checkId"], job, evidence_hash, encode(check), check["recordedAt"],
        ))

    def append_override(self, tenant, job, check_id, evidence_hash, identifier, reason, created_at):
        self._connection.execute("INSERT INTO applications_repeat_overrides VALUES(?,?,?,?,?,?,?,?,?)", (
            tenant, identifier, job, check_id, evidence_hash, reason, created_at, None, None,
        ))

    def consume_override(self, tenant, identifier, run_id, used_at):
        return self._connection.execute(
            "UPDATE applications_repeat_overrides SET used_by_run_id=?,used_at=? WHERE tenant_id=? AND override_id=? AND used_by_run_id IS NULL",
            (run_id, used_at, tenant, identifier),
        ).rowcount == 1

    def save_receipt(self, tenant, key, request, response):
        self._repository.receipt(self._connection, tenant, key, request, response)

    def emit(self, tenant, job, **references):
        self._repository.event(self._connection, "ApplicationsUpdated", job, **references)


class SqliteRepeatStore:
    def __init__(self, repository, sources, feedback):
        self._repository, self._sources, self._feedback = repository, sources, feedback
        self._reader = self._guard = None

    def _session(self, connection):
        return _RepeatSession(connection, self._repository, self._sources, self._feedback)

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

    def set_handlers(self, reader, guard):
        if self._reader is not None or self._guard is not None:
            raise RuntimeError("Repeat handlers are already configured")
        self._reader, self._guard = reader, guard

    def read_result(self, connection, tenant, job):
        if self._reader is None:
            raise RuntimeError("Repeat reader is not configured")
        with self._repository.read(connection) as current:
            return self._reader(self._session(current), tenant, job)

    def guard(self, connection, tenant, job, run_id=None):
        if self._guard is None:
            raise RuntimeError("Repeat guard is not configured")
        with self._repository.read(connection) as current:
            return self._guard(self._session(current), tenant, job, run_id)
