"""Privacy-safe, process-local telemetry for executing pipeline activities.

The inventory deliberately observes Temporal execution metadata only. It never
reads activity arguments, so job URLs, descriptions, profiles, prompts,
provider output, artifact paths, payloads, and secrets cannot enter a worker
heartbeat through this boundary.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Final, Literal

from temporalio import activity
from temporalio.worker import (
    ActivityInboundInterceptor,
    ExecuteActivityInput,
    Interceptor,
)

MAX_ACTIVE_ACTIVITY_DETAILS: Final = 20

# This is the complete bounded-cardinality allowlist for work represented by
# the pipeline operations surface. Internal finalizers, budget checks, apply,
# profile imports, and other registered activities are intentionally absent.
OPERATIONAL_ACTIVITY_KINDS: Final[Mapping[str, str]] = MappingProxyType(
    {
        "plan_discovery_sources": "discovery-plan",
        "discovery_source_family": "discovery-source-family",
        "discovery_enrichment": "discovery-enrichment",
        "discovery_preparation_fanout": "discovery-preparation-fanout",
        "enrich": "enrichment",
        "score": "scoring-batch",
        "score_job": "job-scoring",
        "tailor": "tailoring-batch",
        "tailor_job": "job-tailoring",
        "cover": "cover-letter-batch",
        "cover_letter": "job-cover-letter",
        "render_pdf": "job-pdf-render",
        "derive_preparation_targets": "preparation-targets",
    }
)


@dataclass(frozen=True)
class OperationalActivityRef:
    """An allowlisted kind plus an opaque, non-reversible local reference."""

    kind: str
    opaque_id: str

    def to_json_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "opaqueId": self.opaque_id}


@dataclass(frozen=True)
class ActiveActivityDetail:
    activity_type: str
    operational_ref: OperationalActivityRef
    workflow_ref: str | None
    execution_ref: str | None
    attempt: int
    started_at: datetime

    def to_json_dict(self) -> dict[str, Any]:
        return {
            "activityType": self.activity_type,
            "operationalRef": self.operational_ref.to_json_dict(),
            "workflowRef": self.workflow_ref,
            "executionRef": self.execution_ref,
            "attempt": self.attempt,
            "startedAt": _utc_isoformat(self.started_at),
        }


@dataclass(frozen=True)
class ActivityDurationMetric:
    completed_count: int
    total_duration_ms: int
    max_duration_ms: int

    def to_json_dict(self) -> dict[str, int]:
        return {
            "completedCount": self.completed_count,
            "totalDurationMs": self.total_duration_ms,
            "maxDurationMs": self.max_duration_ms,
        }


@dataclass(frozen=True)
class ActivityInventorySnapshot:
    """One process snapshot.

    ``active_activity_count`` is exact shared-slot occupancy across every
    Temporal activity. ``active_details_total`` and ``counts_by_type`` cover
    only activities on the operational display allowlist.
    """

    active_activity_count: int
    counts_by_type: Mapping[str, int]
    active_details: tuple[ActiveActivityDetail, ...]
    active_details_total: int
    active_details_truncated: bool
    durations_by_type: Mapping[str, ActivityDurationMetric]

    @classmethod
    def empty(cls) -> ActivityInventorySnapshot:
        return cls(
            active_activity_count=0,
            counts_by_type={},
            active_details=(),
            active_details_total=0,
            active_details_truncated=False,
            durations_by_type={},
        )

    def counts_json_dict(self) -> dict[str, int]:
        return dict(sorted(self.counts_by_type.items()))

    def details_json_list(self) -> list[dict[str, Any]]:
        return [detail.to_json_dict() for detail in self.active_details]

    def durations_json_dict(self) -> dict[str, dict[str, int]]:
        return {
            activity_type: metric.to_json_dict()
            for activity_type, metric in sorted(self.durations_by_type.items())
        }


@dataclass(frozen=True)
class _ActiveEntry:
    detail: ActiveActivityDetail | None
    started_monotonic: float


@dataclass
class _MutableDurationMetric:
    completed_count: int = 0
    total_duration_ms: int = 0
    max_duration_ms: int = 0


class ActiveActivityInventory:
    """Concurrency-safe slot inventory with an allowlisted display subset."""

    def __init__(
        self,
        *,
        max_details: int = MAX_ACTIVE_ACTIVITY_DETAILS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_details = max(0, int(max_details))
        self._monotonic = monotonic
        self._lock = threading.RLock()
        self._active: dict[str, _ActiveEntry] = {}
        self._durations: dict[str, _MutableDurationMetric] = {}

    def start(
        self,
        *,
        activity_type: str,
        activity_id: str,
        workflow_id: str | None,
        workflow_run_id: str | None,
        attempt: int,
        started_at: datetime,
    ) -> str:
        """Register one attempt, returning an opaque process-local token.

        Every activity occupies a slot in the exact process total. For an
        allowlisted activity only, workflow/run identifiers are retained when
        they match app-owned, projection-resolvable ID grammars and all other
        identifiers are reduced to an opaque hash. No metadata from an
        unallowlisted activity is retained.
        """

        operational_kind = OPERATIONAL_ACTIVITY_KINDS.get(activity_type)
        token = uuid.uuid4().hex
        detail: ActiveActivityDetail | None = None
        if operational_kind is not None:
            normalized_started_at = _as_utc(started_at)
            workflow_ref = _safe_workflow_ref(workflow_id)
            execution_ref = _safe_temporal_run_ref(workflow_run_id)
            operational_ref = OperationalActivityRef(
                kind=operational_kind,
                opaque_id=_opaque_ref(
                    "op",
                    workflow_id,
                    workflow_run_id,
                    activity_id,
                    activity_type,
                ),
            )
            detail = ActiveActivityDetail(
                activity_type=activity_type,
                operational_ref=operational_ref,
                workflow_ref=workflow_ref,
                execution_ref=execution_ref,
                attempt=max(1, int(attempt)),
                started_at=normalized_started_at,
            )
        entry = _ActiveEntry(
            detail=detail,
            started_monotonic=self._monotonic(),
        )
        with self._lock:
            self._active[token] = entry
        return token

    def finish(self, token: str | None) -> None:
        """Remove one attempt and fold its safe duration metric exactly once."""

        if token is None:
            return
        finished_monotonic = self._monotonic()
        with self._lock:
            entry = self._active.pop(token, None)
            if entry is None:
                return
            if entry.detail is None:
                return
            duration_ms = max(
                0,
                int(round((finished_monotonic - entry.started_monotonic) * 1_000)),
            )
            metric = self._durations.setdefault(
                entry.detail.activity_type,
                _MutableDurationMetric(),
            )
            metric.completed_count += 1
            metric.total_duration_ms += duration_ms
            metric.max_duration_ms = max(metric.max_duration_ms, duration_ms)

    def snapshot(self) -> ActivityInventorySnapshot:
        """Return exact slot occupancy plus a bounded allowlisted detail view."""

        with self._lock:
            entries = tuple(self._active.values())
            durations = {
                activity_type: ActivityDurationMetric(
                    completed_count=metric.completed_count,
                    total_duration_ms=metric.total_duration_ms,
                    max_duration_ms=metric.max_duration_ms,
                )
                for activity_type, metric in self._durations.items()
            }

        allowlisted_details = tuple(
            entry.detail for entry in entries if entry.detail is not None
        )
        counts = Counter(detail.activity_type for detail in allowlisted_details)
        ordered = sorted(
            allowlisted_details,
            key=lambda detail: (
                detail.started_at,
                detail.operational_ref.opaque_id,
            ),
        )
        details = tuple(ordered[: self._max_details])
        active_total = len(entries)
        active_details_total = len(allowlisted_details)
        return ActivityInventorySnapshot(
            active_activity_count=active_total,
            counts_by_type=dict(sorted(counts.items())),
            active_details=details,
            active_details_total=active_details_total,
            active_details_truncated=active_details_total > len(details),
            durations_by_type=durations,
        )


class ActivityRuntimeTelemetryInterceptor(Interceptor):
    """Temporal worker interceptor that brackets every activity attempt."""

    def __init__(self, inventory: ActiveActivityInventory) -> None:
        self._inventory = inventory

    def intercept_activity(
        self,
        next: ActivityInboundInterceptor,
    ) -> ActivityInboundInterceptor:
        return _ActivityRuntimeTelemetryInboundInterceptor(next, self._inventory)


class _ActivityRuntimeTelemetryInboundInterceptor(ActivityInboundInterceptor):
    def __init__(
        self,
        next: ActivityInboundInterceptor,
        inventory: ActiveActivityInventory,
    ) -> None:
        super().__init__(next)
        self._inventory = inventory

    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        token: str | None = None
        try:
            info = activity.info()
            token = self._inventory.start(
                activity_type=info.activity_type,
                activity_id=info.activity_id,
                workflow_id=info.workflow_id,
                workflow_run_id=info.workflow_run_id,
                attempt=info.attempt,
                started_at=info.started_time,
            )
        except Exception:
            # Runtime telemetry must never change activity execution behavior.
            token = None

        try:
            return await self.next.execute_activity(input)
        finally:
            try:
                self._inventory.finish(token)
            except Exception:
                # Terminal cleanup is best effort for the same reason as start.
                pass


def _opaque_ref(prefix: Literal["op"], *parts: str | None) -> str:
    digest = hashlib.sha256()
    for part in parts:
        encoded = (part or "").encode("utf-8", errors="replace")
        digest.update(len(encoded).to_bytes(8, byteorder="big"))
        digest.update(encoded)
    return f"{prefix}_{digest.hexdigest()[:24]}"


_SAFE_WORKFLOW_REF_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"^discover-local$"),
    re.compile(r"^prep-preparation:[a-f0-9]{64}$"),
    re.compile(r"^run-[a-f0-9]{32}$"),
)
_SAFE_TEMPORAL_RUN_REF = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _safe_workflow_ref(value: str | None) -> str | None:
    if value is None:
        return None
    return value if any(pattern.fullmatch(value) for pattern in _SAFE_WORKFLOW_REF_PATTERNS) else None


def _safe_temporal_run_ref(value: str | None) -> str | None:
    if value is None:
        return None
    return value if _SAFE_TEMPORAL_RUN_REF.fullmatch(value) else None


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _utc_isoformat(value: datetime) -> str:
    return _as_utc(value).isoformat()


__all__ = [
    "ActivityInventorySnapshot",
    "ActivityRuntimeTelemetryInterceptor",
    "ActiveActivityDetail",
    "ActiveActivityInventory",
    "MAX_ACTIVE_ACTIVITY_DETAILS",
    "OPERATIONAL_ACTIVITY_KINDS",
    "OperationalActivityRef",
]
