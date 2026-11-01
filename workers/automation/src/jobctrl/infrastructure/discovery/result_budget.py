"""Execution-scoped result budgets, backed by atomic canonical-insert receipts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import sqlite3
import threading

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
    canonical_job_id: str
    source_observation_id: str
    source_run_id: str
    decoder_version: int = 2
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
        frozen_source_limits: dict[str, int] | None = None,
        cancel_event: threading.Event | None = None,
    ):
        # An explicit zero is exhausted. Unbounded user requests do not create
        # a budget object; never reinterpret an exhausted allowance as unbounded.
        if type(limit) is not int or limit < 0 or type(start_count) is not int or start_count < 0:
            raise ValueError("explicit result budget requires a nonnegative limit and recorded starting count")
        if any(not key or type(cap) is not int or cap < 0 for key, cap in source_limits.items()):
            raise ValueError("source result budgets must be nonnegative integers")
        self.conn, self.execution, self.limit, self.start_count = conn, execution, limit, start_count
        self.source_limits = dict(source_limits)
        self.frozen_source_limits = dict(source_limits if frozen_source_limits is None else frozen_source_limits)
        if self.source_limits.keys() != self.frozen_source_limits.keys() or any(
            type(cap) is not int or cap < self.source_limits[source] for source, cap in self.frozen_source_limits.items()
        ):
            raise ValueError("effective discovery budgets must not exceed the frozen plan")
        self.cancel_event = cancel_event

    def _recorded_admissions(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT job_id,entity_kind,entity_ref,payload_json FROM job_events WHERE tenant_id=? "
            "AND event_type='DiscoveryNewJobAdmitted' "
            "AND json_extract(payload_json,'$.discovery_workflow_id')=? "
            "AND json_extract(payload_json,'$.discovery_run_id')=?",
            (self.execution.tenant_id, self.execution.workflow_id, self.execution.temporal_run_id),
        ).fetchall()
        receipts = []
        for job_id, kind, ref, raw in rows:
            payload = json.loads(raw)
            source = payload.get("source_id")
            if (
                job_id is not None or kind != "discovery_admission"
                or type(payload.get("decoder_version")) is not int or payload["decoder_version"] != 2
                or payload.get("evidence_kind") != "canonical_insert" or source not in self.source_limits
                or payload.get("canonical_job_id") != str(canonical_job_id(str(ref)))
                or not isinstance(payload.get("source_observation_id"), str) or not payload["source_observation_id"]
                or not isinstance(payload.get("source_run_id"), str) or not payload["source_run_id"]
            ):
                raise ValueError("invalid recorded discovery admission receipt")
            receipts.append(payload)
        all_ids = [receipt["canonical_job_id"] for receipt in receipts]
        if len(all_ids) != len(set(all_ids)):
            raise ValueError("a canonical job has conflicting discovery admission receipts")
        return receipts

    def counts(self) -> dict[str, int]:
        counts = dict.fromkeys(self.source_limits, 0)
        for receipt in self._recorded_admissions():
            counts[receipt["source_id"]] += 1
        return counts

    def admitted_job_for_observation(self, source_id: str, observation_id: str) -> str | None:
        matches = [receipt["canonical_job_id"] for receipt in self._recorded_admissions()
                   if receipt["source_id"] == source_id and receipt["source_observation_id"] == observation_id]
        if len(matches) > 1:
            raise ValueError("a source observation has conflicting discovery admission receipts")
        return matches[0] if matches else None

    def source_exhausted(self, source_id: str) -> bool:
        if source_id not in self.source_limits:
            raise ValueError("source is outside the frozen result budget")
        return self.counts()[source_id] >= self.source_limits[source_id]

    def run_exhausted(self) -> bool:
        return self.remaining() == 0

    def remaining(self, source_ids: tuple[str, ...] | None = None) -> int:
        """Forecast fetch capacity; only record_insert authorizes a new write."""
        counts = self.counts()
        selected = tuple(self.source_limits) if source_ids is None else tuple(dict.fromkeys(source_ids))
        if any(source not in self.source_limits for source in selected):
            raise ValueError("source is outside the frozen result budget")
        return min(
            max(self.limit - sum(counts.values()), 0),
            sum(max(self.source_limits[source] - counts[source], 0) for source in selected),
        )

    def fence_write(self) -> None:
        """Keep every budgeted mutation bound to its frozen authority and cancellation."""
        from jobctrl.domain.errors import TransientNetworkError
        from jobctrl.infrastructure.discovery.execution_result_plan import check_result_plan

        if self.cancel_event is not None and self.cancel_event.is_set():
            raise TransientNetworkError("Discovery canceled before canonical admission")
        check_result_plan(
            self.conn, self.execution, limit=self.limit, source_limits=self.frozen_source_limits, bounded=True,
        )

    def record_insert(self, job_id: str, source_id: str, *, observation_id: str, source_run_id: str) -> None:
        """Called after INSERT, under its writer transaction, before publication."""
        if not self.conn.in_transaction:
            raise RuntimeError("discovery budget requires the canonical insert transaction")
        self.fence_write()
        counts = self.counts()
        if source_id not in self.source_limits:
            raise ValueError("source is outside the frozen result budget")
        if (
            sum(counts.values()) >= self.limit
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
            None,
            "discover",
            "DiscoveryNewJobAdmitted",
            tenant_id=TenantId(self.execution.tenant_id),
            payload=asdict(
                DiscoveryNewJobAdmittedPayload(
                    self.execution.workflow_id,
                    self.execution.temporal_run_id,
                    source_id,
                    str(job_id), observation_id, source_run_id,
                )
            ),
            idempotency_key=receipt_key,
            entity_kind="discovery_admission", entity_ref=str(job_id),
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
                str(job_id), observation_id, source_run_id,
            )
        )
        if (
            row is None
            or tuple(row[:4]) != (self.execution.tenant_id, None, "discover", "DiscoveryNewJobAdmitted")
            or any(payload.get(key) != value for key, value in expected.items())
            or self.counts()[source_id] != counts[source_id] + 1
        ):
            raise RuntimeError("canonical discovery admission receipt was not persisted exactly once")
