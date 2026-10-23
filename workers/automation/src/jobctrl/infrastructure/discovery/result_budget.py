"""Execution-scoped result budgets, backed by atomic canonical-insert receipts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import sqlite3

from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import TenantId


class DiscoveryResultLimitReached(Exception):
    """A caller's literal new-job allowance is exhausted; no job was committed."""


@dataclass(frozen=True)
class DiscoveryNewJobAdmittedPayload:
    discovery_workflow_id: str
    discovery_run_id: str
    source_id: str
    decoder_version: int = 1
    evidence_kind: str = "canonical_insert"


class DiscoveryResultBudget:
    def __init__(
        self,
        conn: sqlite3.Connection,
        execution: DiscoveryExecutionRef,
        *,
        limit: int,
        start_count: int,
        source_limits: dict[str, int],
    ):
        if type(limit) is not int or limit <= 0 or type(start_count) is not int or start_count < 0:
            raise ValueError("explicit result budget requires a positive limit and recorded starting count")
        if any(not key or type(cap) is not int or cap < 0 for key, cap in source_limits.items()):
            raise ValueError("source result budgets must be nonnegative integers")
        self.conn, self.execution, self.limit, self.start_count = conn, execution, limit, start_count
        self.source_limits = dict(source_limits)

    def counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT job_id,payload_json FROM job_events WHERE tenant_id=? "
            "AND event_type='DiscoveryNewJobAdmitted' "
            "AND json_extract(payload_json,'$.discovery_workflow_id')=? "
            "AND json_extract(payload_json,'$.discovery_run_id')=?",
            (self.execution.tenant_id, self.execution.workflow_id, self.execution.temporal_run_id),
        ).fetchall()
        jobs = {key: set() for key in self.source_limits}
        for job_id, raw in rows:
            payload = json.loads(raw)
            source = payload.get("source_id")
            if (
                type(payload.get("decoder_version")) is not int
                or payload["decoder_version"] != 1
                or payload.get("evidence_kind") != "canonical_insert"
                or source not in jobs
                or payload.get("jobId") != str(canonical_job_id(str(job_id)))
            ):
                raise ValueError("invalid recorded discovery admission receipt")
            jobs[source].add(job_id)
        all_ids = [job_id for ids in jobs.values() for job_id in ids]
        if len(all_ids) != len(set(all_ids)):
            raise ValueError("a canonical job has conflicting discovery admission receipts")
        return {source: len(ids) for source, ids in jobs.items()}

    def source_exhausted(self, source_id: str) -> bool:
        if source_id not in self.source_limits:
            raise ValueError("source is outside the frozen result budget")
        return self.counts()[source_id] >= self.source_limits[source_id]

    def run_exhausted(self) -> bool:
        total = self.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        counts = self.counts()
        return (
            total - self.start_count >= self.limit
            or sum(counts.values()) >= self.limit
            or all(counts[key] >= cap for key, cap in self.source_limits.items())
        )

    def record_insert(self, job_id: str, source_id: str) -> None:
        """Called after INSERT, under its writer transaction, before publication."""
        if not self.conn.in_transaction:
            raise RuntimeError("discovery budget requires the canonical insert transaction")
        total = self.conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        counts = self.counts()
        if source_id not in self.source_limits:
            raise ValueError("source is outside the frozen result budget")
        if (
            total - self.start_count > self.limit
            or sum(counts.values()) >= self.limit
            or counts[source_id] >= self.source_limits[source_id]
        ):
            raise DiscoveryResultLimitReached("Discovery result budget reached")
        from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
        from jobctrl.state import record_job_event

        key = hashlib.sha256(
            json.dumps(
                [
                    self.execution.tenant_id,
                    self.execution.workflow_id,
                    self.execution.temporal_run_id,
                    str(job_id),
                    source_id,
                ],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        receipt_key = "discovery-result-budget:" + key
        record_job_event(
            self.conn,
            canonical_job_id(str(job_id)),
            "discover",
            "DiscoveryNewJobAdmitted",
            tenant_id=TenantId(self.execution.tenant_id),
            payload=asdict(
                DiscoveryNewJobAdmittedPayload(
                    self.execution.workflow_id,
                    self.execution.temporal_run_id,
                    source_id,
                )
            ),
            idempotency_key=receipt_key,
            # This audit receipt is part of the pending insert. Ordinary
            # JobDiscovered publication follows the successful commit.
            publisher=InProcessEventBus(),
        )
        row = self.conn.execute(
            "SELECT tenant_id,job_id,stage,event_type,payload_json FROM job_events WHERE idempotency_key=?",
            (receipt_key,),
        ).fetchone()
        payload = json.loads(row[4]) if row is not None else {}
        expected = asdict(
            DiscoveryNewJobAdmittedPayload(
                self.execution.workflow_id,
                self.execution.temporal_run_id,
                source_id,
            )
        )
        if (
            row is None
            or tuple(row[:4]) != (self.execution.tenant_id, str(job_id), "discover", "DiscoveryNewJobAdmitted")
            or any(payload.get(key) != value for key, value in expected.items())
            or payload.get("jobId") != str(job_id)
            or self.counts()[source_id] != counts[source_id] + 1
        ):
            raise RuntimeError("canonical discovery admission receipt was not persisted exactly once")
