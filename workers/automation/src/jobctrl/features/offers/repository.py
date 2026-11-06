"""SQLite adapter for Offers' immutable ledger and atomic participants."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager, nullcontext
from typing import Iterator

from jobctrl.app.database import Database

from .ports import OfferApplicationsPort, OfferEventsPort, OfferJobsPort


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class SqliteOfferTransaction:
    def __init__(self, connection: sqlite3.Connection, jobs: OfferJobsPort,
                 applications: OfferApplicationsPort | None, events: OfferEventsPort):
        self.connection = connection
        self.jobs = jobs
        self.applications = applications
        self.events = events

    def read_offer(self, job_id: str) -> dict:
        self.jobs.get_posting_snapshot(job_id, connection=self.connection)
        terms = [json.loads(row[0]) for row in self.connection.execute(
            "SELECT payload_json FROM offer_terms WHERE job_id=? ORDER BY sequence", (job_id,)
        )]
        decisions = [json.loads(row[0]) for row in self.connection.execute(
            "SELECT payload_json FROM offer_decisions WHERE job_id=? ORDER BY sequence", (job_id,)
        )]
        return {"ok": True, "jobId": job_id, "termsHistory": terms, "decisions": decisions,
                "currentTerms": terms[-1] if terms else None,
                "currentDecision": decisions[-1] if decisions else None}

    def append_terms(self, job_id: str, revision: dict) -> None:
        self.connection.execute(
            "INSERT INTO offer_terms(job_id,revision_id,payload_json) VALUES(?,?,?)",
            (job_id, revision["revisionId"], _json(revision)),
        )

    def append_decision(self, job_id: str, decision: dict) -> None:
        self.connection.execute(
            "INSERT INTO offer_decisions(job_id,decision_id,terms_revision_id,payload_json) VALUES(?,?,?,?)",
            (job_id, decision["decisionId"], decision["termsRevisionId"], _json(decision)),
        )

    def ensure_offer_milestone(self, job_id: str) -> None:
        if self.applications is not None:
            self.applications.ensure_offer_milestone(job_id, connection=self.connection)

    def publish_change(self, job_id: str, revision_id: str, decision_id: str | None) -> None:
        self.events.append(self.connection, "OfferRecordChanged",
                           {"revisionId": revision_id, "decisionId": decision_id},
                           feature="offers", aggregate_id=job_id)


class SqliteOfferRepository:
    def __init__(self, database: Database, jobs: OfferJobsPort,
                 applications: OfferApplicationsPort | None, events: OfferEventsPort):
        self.database = database
        self.jobs = jobs
        self.applications = applications
        self.events = events

    def _unit(self, connection: sqlite3.Connection) -> SqliteOfferTransaction:
        return SqliteOfferTransaction(connection, self.jobs, self.applications, self.events)

    def read_offer(self, job_id: str, connection: sqlite3.Connection | None = None) -> dict:
        with nullcontext(connection) if connection is not None else self.database.connect() as conn:
            return self._unit(conn).read_offer(job_id)

    @contextmanager
    def transaction(self) -> Iterator[SqliteOfferTransaction]:
        with self.database.transaction() as conn:
            yield self._unit(conn)

    def delete_job_data(self, job_id: str, connection: sqlite3.Connection | None = None) -> None:
        if connection is None or not connection.in_transaction:
            raise RuntimeError("Permanent deletion requires the canonical transaction")
        connection.execute("DELETE FROM offer_decisions WHERE job_id=?", (job_id,))
        connection.execute("DELETE FROM offer_terms WHERE job_id=?", (job_id,))
