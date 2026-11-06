"""SQLite adapter for compensation-owned state and transaction-bound ports."""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import json
from typing import Iterator

from jobctrl.app.errors import AppError, ConflictError

from .ports import RecordKind


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CompensationSession:
    """A semantic unit of work backed by one private SQLite connection."""

    def __init__(self, connection, *, events, jobs, model, settings, writable: bool):
        self._connection = connection
        self._events = events
        self._jobs = jobs
        self._model = model
        self._settings = settings
        self._writable = writable

    def _require_transaction(self) -> None:
        if not self._writable or not self._connection.in_transaction:
            raise RuntimeError("Compensation mutations require the canonical transaction")

    def posting(self, job_id: str, *, include_deleted: bool = False) -> dict:
        if include_deleted:
            return self._jobs.get_posting_snapshot(job_id, connection=self._connection, include_deleted=True)
        return self._jobs.get_posting_snapshot(job_id, connection=self._connection)

    def assert_posting_current(self, snapshot: dict) -> None:
        self._jobs.assert_posting_current(snapshot["job_id"], snapshot["revision"],
                                          source_hash=snapshot["source_hash"], connection=self._connection)

    def policy_snapshot(self) -> tuple[dict, int]:
        preferences = {row[0]: json.loads(row[1]) for row in self._connection.execute(
            "SELECT source_id,value_json FROM compensation_source_preferences"
        )}
        revision = self._connection.execute(
            "SELECT revision FROM compensation_policy_revision WHERE singleton=1"
        ).fetchone()[0]
        return preferences, revision

    def set_policy(self, source_id: str, value: dict, expected_revision: int) -> int:
        self._require_transaction()
        revision = self._connection.execute(
            "SELECT revision FROM compensation_policy_revision WHERE singleton=1"
        ).fetchone()[0]
        if revision != expected_revision:
            raise ConflictError("Compensation sources changed. Reload before saving.", current_revision=revision)
        changed = self._connection.execute(
            "UPDATE compensation_policy_revision SET revision=revision+1 WHERE singleton=1 AND revision=?",
            (expected_revision,),
        ).rowcount
        if changed != 1:
            raise ConflictError("Compensation sources changed. Reload before saving.")
        self._connection.execute(
            "INSERT INTO compensation_source_preferences(source_id,value_json) VALUES(?,?) "
            "ON CONFLICT(source_id) DO UPDATE SET value_json=excluded.value_json",
            (source_id, _json(value)),
        )
        return revision + 1

    def record(self, kind: RecordKind, job_id: str) -> dict | None:
        tables = {"posted": "compensation_posted", "market": "compensation_market"}
        if kind not in tables:
            raise ValueError("invalid compensation record kind")
        row = self._connection.execute(
            f"SELECT record_json,posting_revision,posting_hash FROM {tables[kind]} WHERE job_id=?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        return {"record": json.loads(row[0]), "posting_revision": row[1], "posting_hash": row[2]}

    def completion(self, operation_id: str) -> dict | None:
        row = self._connection.execute(
            "SELECT input_hash,result_json FROM compensation_refresh_completions WHERE operation_id=?",
            (operation_id,),
        ).fetchone()
        return {"input_hash": row[0], "result": json.loads(row[1])} if row else None

    def refresh_state(self, job_id: str) -> dict | None:
        row = self._connection.execute(
            "SELECT status,attempt_id,lease_expires_at,failure_code,updated_at "
            "FROM compensation_refresh_status WHERE job_id=?", (job_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def claim(self, job_id: str, attempt: str, now: str, expiry: str) -> None:
        self._require_transaction()
        self.posting(job_id)
        prior = self.refresh_state(job_id)
        if prior and prior["status"] == "running" and prior["lease_expires_at"] and prior["lease_expires_at"] > now:
            raise AppError("compensation_refresh_deferred", "Another compensation refresh is still running.", 409)
        self._connection.execute(
            "INSERT INTO compensation_refresh_status(job_id,status,attempt_id,lease_expires_at,failure_code,updated_at) "
            "VALUES(?, 'running', ?, ?, NULL, ?) ON CONFLICT(job_id) DO UPDATE SET "
            "status='running',attempt_id=excluded.attempt_id,lease_expires_at=excluded.lease_expires_at,"
            "failure_code=NULL,updated_at=excluded.updated_at", (job_id, attempt, expiry, now)
        )

    def renew(self, job_id: str, attempt: str, now: str, expiry: str) -> None:
        self._require_transaction()
        changed = self._connection.execute(
            "UPDATE compensation_refresh_status SET lease_expires_at=?,updated_at=? "
            "WHERE job_id=? AND attempt_id=? AND status='running' AND lease_expires_at>?",
            (expiry, now, job_id, attempt, now),
        ).rowcount
        if not changed:
            raise ConflictError("Compensation refresh ownership expired or changed.")

    def require_owner(self, job_id: str, attempt: str, now: str) -> None:
        owner = self.refresh_state(job_id)
        if (not owner or owner["attempt_id"] != attempt or owner["status"] != "running"
                or not owner["lease_expires_at"] or owner["lease_expires_at"] <= now):
            raise ConflictError("Compensation refresh ownership expired or changed.")

    def save_record(self, kind: RecordKind, snapshot: dict, record: dict, attempt: str) -> None:
        self._require_transaction()
        self.require_owner(snapshot["job_id"], attempt, _now())
        self.assert_posting_current(snapshot)
        if kind == "posted":
            self._connection.execute(
                "INSERT INTO compensation_posted(job_id,posting_revision,posting_hash,source_hash,record_json,updated_at) "
                "VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET "
                "posting_revision=excluded.posting_revision,posting_hash=excluded.posting_hash,"
                "source_hash=excluded.source_hash,record_json=excluded.record_json,updated_at=excluded.updated_at",
                (snapshot["job_id"], snapshot["revision"], snapshot["source_hash"],
                 record["fact"]["judgment"]["determination"]["source_hash"], _json(record), record["updatedAt"]),
            )
        elif kind == "market":
            self._connection.execute(
                "INSERT INTO compensation_market(job_id,posting_revision,posting_hash,record_json,updated_at) "
                "VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET "
                "posting_revision=excluded.posting_revision,posting_hash=excluded.posting_hash,"
                "record_json=excluded.record_json,updated_at=excluded.updated_at",
                (snapshot["job_id"], snapshot["revision"], snapshot["source_hash"], _json(record), record["updatedAt"]),
            )
        else:
            raise ValueError("invalid compensation record kind")
        self.append_event("CompensationEvidenceChanged", {"jobId": snapshot["job_id"], "kind": kind}, snapshot["job_id"])

    def record_source_receipt(self, job_id: str, attempt: str, source_id: str, receipt: dict, now: str) -> None:
        self._require_transaction()
        self.require_owner(job_id, attempt, now)
        self._connection.execute(
            "INSERT INTO compensation_source_receipts(job_id,attempt_id,source_id,receipt_json,recorded_at) "
            "VALUES(?,?,?,?,?)", (job_id, attempt, source_id, _json(receipt), now)
        )

    def set_refresh_result(self, job_id: str, attempt: str, status: str, code: str | None, now: str) -> bool:
        self._require_transaction()
        if status not in {"succeeded", "failed", "cancelled"}:
            raise ValueError("invalid compensation refresh result")
        changed = self._connection.execute(
            "UPDATE compensation_refresh_status SET status=?,failure_code=?,updated_at=? "
            "WHERE job_id=? AND attempt_id=?", (status, code, now, job_id, attempt)
        ).rowcount
        return bool(changed)

    def save_completion(self, operation_id: str, job_id: str, input_hash: str, outcome: dict) -> None:
        self._require_transaction()
        self._connection.execute(
            "INSERT INTO compensation_refresh_completions(operation_id,job_id,input_hash,result_json) VALUES(?,?,?,?)",
            (operation_id, job_id, input_hash, _json(outcome)),
        )

    def source_receipts(self, job_id: str, attempt: str) -> list[dict]:
        return [{"sourceId": row[0], **json.loads(row[1])} for row in self._connection.execute(
            "SELECT source_id,receipt_json FROM compensation_source_receipts "
            "WHERE job_id=? AND attempt_id=? ORDER BY sequence", (job_id, attempt)
        )]

    @staticmethod
    def _benchmark_identity(fact: dict) -> tuple:
        observation = fact["observation"]
        classification = observation["classification"]
        countries = classification["countries"]
        if not isinstance(countries, (list, tuple)) or len(countries) != 1:
            raise ValueError("invalid compensation benchmark geography")
        identity = (fact["reference"], classification["occupation"], classification["seniority"],
                    observation["component"], classification["geography_scope"], countries[0])
        if any(not isinstance(value, str) or not value for value in identity):
            raise ValueError("invalid compensation benchmark identity")
        company = observation["company_reference"]
        if company is not None and not isinstance(company, str):
            raise ValueError("invalid compensation company identity")
        return (*identity, company)

    @classmethod
    def _benchmark_row(cls, row) -> dict:
        fact = json.loads(row[7])
        if cls._benchmark_identity(fact) != tuple(row[:7]):
            raise ValueError("compensation benchmark identity mismatch")
        return {"fact": fact, "fetched_at": row[8], "fresh_until": row[9]}

    def fresh_benchmark_inputs(self, occupation: str, seniority: str, component: str, now: str) -> list[dict]:
        rows = self._connection.execute(
            "SELECT b.fact_ref,b.occupation,b.seniority,b.component,b.geography_scope,b.country,b.company_reference,"
            "b.fact_json,b.fetched_at,b.fresh_until FROM compensation_benchmark_inputs b "
            "WHERE b.occupation=? AND b.seniority=? AND b.component=? AND b.fresh_until>? "
            "AND b.fetched_at=(SELECT MAX(other.fetched_at) FROM compensation_benchmark_inputs other "
            "WHERE other.fact_ref=b.fact_ref AND other.fetched_at<=?) ORDER BY b.fact_ref",
            (occupation, seniority, component, now, now),
        )
        return [self._benchmark_row(row) for row in rows]

    def benchmark_acquisition(self, fact_ref: str, fetched_at: str) -> dict | None:
        row = self._connection.execute(
            "SELECT fact_ref,occupation,seniority,component,geography_scope,country,company_reference,"
            "fact_json,fetched_at,fresh_until FROM compensation_benchmark_inputs WHERE fact_ref=? AND fetched_at=?",
            (fact_ref, fetched_at),
        ).fetchone()
        return self._benchmark_row(row) if row is not None else None

    def save_benchmark_input(self, fact: dict, fetched_at: str, fresh_until: str) -> None:
        self._require_transaction()
        if fresh_until <= fetched_at:
            raise ValueError("invalid compensation benchmark freshness")
        identity = self._benchmark_identity(fact)
        encoded = _json(fact)
        prior = self._connection.execute(
            "SELECT fact_json,fresh_until FROM compensation_benchmark_inputs WHERE fact_ref=? AND fetched_at=?",
            (identity[0], fetched_at),
        ).fetchone()
        if prior is not None:
            if prior[0] != encoded or prior[1] != fresh_until:
                raise ConflictError("A compensation benchmark acquisition has different source data or freshness.")
            return
        self._connection.execute(
            "INSERT INTO compensation_benchmark_inputs(fact_ref,occupation,seniority,component,geography_scope,"
            "country,company_reference,fact_json,fetched_at,fresh_until) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (*identity, encoded, fetched_at, fresh_until),
        )

    @staticmethod
    def _price_row(row) -> dict:
        source = json.loads(row[2])
        if not isinstance(source, dict) or source.get("reference") != row[0]:
            raise ValueError("compensation price snapshot identity mismatch")
        return {"source": source, "reference_year": row[1], "fetched_at": row[3], "fresh_until": row[4]}

    def fresh_price_snapshots(self, reference_year: int, now: str) -> list[dict]:
        rows = self._connection.execute(
            "SELECT p.snapshot_ref,p.reference_year,p.source_json,p.fetched_at,p.fresh_until "
            "FROM compensation_price_snapshots p WHERE p.reference_year=? AND p.fresh_until>? "
            "AND p.fetched_at=(SELECT MAX(other.fetched_at) FROM compensation_price_snapshots other "
            "WHERE other.snapshot_ref=p.snapshot_ref AND other.fetched_at<=?) ORDER BY p.snapshot_ref",
            (reference_year, now, now),
        )
        return [self._price_row(row) for row in rows]

    def price_acquisition(self, snapshot_ref: str, fetched_at: str) -> dict | None:
        row = self._connection.execute(
            "SELECT snapshot_ref,reference_year,source_json,fetched_at,fresh_until "
            "FROM compensation_price_snapshots WHERE snapshot_ref=? AND fetched_at=?",
            (snapshot_ref, fetched_at),
        ).fetchone()
        return self._price_row(row) if row is not None else None

    def save_price_snapshot(self, source: dict, year: int, fetched_at: str, fresh_until: str) -> None:
        self._require_transaction()
        if fresh_until <= fetched_at or not isinstance(source.get("reference"), str) or not source["reference"]:
            raise ValueError("invalid compensation price snapshot")
        reference, encoded = source["reference"], _json(source)
        prior = self._connection.execute(
            "SELECT reference_year,source_json,fresh_until FROM compensation_price_snapshots "
            "WHERE snapshot_ref=? AND fetched_at=?", (reference, fetched_at)
        ).fetchone()
        if prior is not None:
            if prior[0] != year or prior[1] != encoded or prior[2] != fresh_until:
                raise ConflictError("A compensation price acquisition has different source data or freshness.")
            return
        self._connection.execute(
            "INSERT INTO compensation_price_snapshots(snapshot_ref,reference_year,source_json,fetched_at,fresh_until) "
            "VALUES(?,?,?,?,?)", (reference, year, encoded, fetched_at, fresh_until)
        )

    @staticmethod
    def _rate_row(row) -> dict:
        source = json.loads(row[1])
        if not isinstance(source, dict) or source.get("reference") != row[0]:
            raise ValueError("compensation rate snapshot identity mismatch")
        return {"source": source, "fetched_at": row[2], "fresh_until": row[3]}

    def fresh_rate_snapshots(self, now: str) -> list[dict]:
        rows = self._connection.execute(
            "SELECT r.snapshot_ref,r.source_json,r.fetched_at,r.fresh_until FROM compensation_rate_snapshots r "
            "WHERE r.fresh_until>? AND r.fetched_at=(SELECT MAX(other.fetched_at) "
            "FROM compensation_rate_snapshots other WHERE other.snapshot_ref=r.snapshot_ref "
            "AND other.fetched_at<=?) ORDER BY r.snapshot_ref", (now, now)
        )
        return [self._rate_row(row) for row in rows]

    def rate_acquisition(self, snapshot_ref: str, fetched_at: str) -> dict | None:
        row = self._connection.execute(
            "SELECT snapshot_ref,source_json,fetched_at,fresh_until FROM compensation_rate_snapshots "
            "WHERE snapshot_ref=? AND fetched_at=?", (snapshot_ref, fetched_at)
        ).fetchone()
        return self._rate_row(row) if row is not None else None

    def save_rate_snapshot(self, source: dict, fetched_at: str, fresh_until: str) -> None:
        self._require_transaction()
        if fresh_until <= fetched_at or not isinstance(source.get("reference"), str) or not source["reference"]:
            raise ValueError("invalid compensation rate snapshot")
        reference, encoded = source["reference"], _json(source)
        prior = self._connection.execute(
            "SELECT source_json,fresh_until FROM compensation_rate_snapshots WHERE snapshot_ref=? AND fetched_at=?",
            (reference, fetched_at),
        ).fetchone()
        if prior is not None:
            if prior[0] != encoded or prior[1] != fresh_until:
                raise ConflictError("A compensation rate acquisition has different source data or freshness.")
            return
        self._connection.execute(
            "INSERT INTO compensation_rate_snapshots(snapshot_ref,source_json,fetched_at,fresh_until) VALUES(?,?,?,?)",
            (reference, encoded, fetched_at, fresh_until)
        )

    def append_event(self, event_type: str, payload: dict, aggregate_id: str) -> None:
        self._require_transaction()
        self._events.append(self._connection, event_type, payload, feature="compensation", aggregate_id=aggregate_id)

    def verified_model_result(self, source, receipt_id: str, kind: str):
        if kind not in {"posted", "classification", "company_identity"}:
            raise ValueError("invalid compensation determination kind")
        return self._model.verified_result(source, receipt_id, kind=kind, connection=self._connection)

    def settings_snapshot(self) -> dict:
        return self._settings.snapshot(self._connection) if self._settings else {}

    def automatic_enabled(self) -> bool:
        return self.settings_snapshot().get("compensationAutomationEnabled", True)

    def delete_job(self, job_id: str) -> None:
        self._require_transaction()
        for table in ("compensation_posted", "compensation_market", "compensation_source_receipts",
                      "compensation_refresh_status", "compensation_refresh_completions"):
            self._connection.execute(f"DELETE FROM {table} WHERE job_id=?", (job_id,))


class CompensationRepository:
    def __init__(self, database, events, jobs, model, settings=None):
        self._database, self._events, self._jobs = database, events, jobs
        self._model, self._settings = model, settings

    def _session(self, connection, *, writable: bool) -> CompensationSession:
        return CompensationSession(connection, events=self._events, jobs=self._jobs,
                                   model=self._model, settings=self._settings, writable=writable)

    @contextmanager
    def read(self, connection=None) -> Iterator[CompensationSession]:
        if connection is not None:
            with nullcontext(connection) as current:
                yield self._session(current, writable=False)
        else:
            with self._database.connect() as current:
                current.execute("BEGIN")
                try:
                    yield self._session(current, writable=False)
                finally:
                    current.rollback()

    @contextmanager
    def write(self, connection=None) -> Iterator[CompensationSession]:
        if connection is not None:
            if not connection.in_transaction:
                raise RuntimeError("Compensation mutations require the canonical transaction")
            with nullcontext(connection) as current:
                yield self._session(current, writable=True)
        else:
            with self._database.transaction() as current:
                yield self._session(current, writable=True)
