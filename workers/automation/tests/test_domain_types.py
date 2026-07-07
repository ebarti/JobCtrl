"""Unit tests for domain types: TenantId, Stage, StageState, JobId."""

from __future__ import annotations

from jobctrl.domain.tenant import TenantId, LOCAL_TENANT
from jobctrl.domain.identifiers import JobId, generate_job_id
from jobctrl.domain.pipeline_types import (
    Stage,
    STAGES,
    STAGE_STATE_KINDS,
    Pending,
    Queued,
    Running,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
    Exhausted,
    Stale,
    Canceled,
    serialize_stage,
    deserialize_stage,
    serialize_stage_state,
    deserialize_stage_state_kind,
)
from jobctrl.state import STAGE_ORDER

import pytest


# ---------------------------------------------------------------------------
# TenantId
# ---------------------------------------------------------------------------


class TestTenantId:
    def test_local_tenant_value(self) -> None:
        assert LOCAL_TENANT == "local"

    def test_tenant_id_is_str(self) -> None:
        tid = TenantId("tenant-abc")
        assert isinstance(tid, str)
        assert tid == "tenant-abc"

    def test_local_tenant_type(self) -> None:
        # NewType is erased at runtime, but the constant should be a str
        assert isinstance(LOCAL_TENANT, str)


# ---------------------------------------------------------------------------
# JobId
# ---------------------------------------------------------------------------


class TestJobId:
    def test_job_id_is_str(self) -> None:
        jid = JobId("job-123")
        assert isinstance(jid, str)
        assert jid == "job-123"

    def test_generate_job_id_returns_uuid(self) -> None:
        jid = generate_job_id()
        assert isinstance(jid, str)
        assert len(jid) == 36  # UUID format


# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------


class TestStage:
    def test_stage_count(self) -> None:
        assert len(STAGES) == 6

    def test_stage_names(self) -> None:
        names = [s.value for s in STAGES]
        assert names == ["Discover", "Enrich", "Score", "Tailor", "Cover", "Apply"]

    def test_stage_completeness_against_legacy(self) -> None:
        """Domain Stage enum covers all stages in legacy STAGE_ORDER."""
        domain_stages = {serialize_stage(s) for s in Stage}
        legacy_stages = set(STAGE_ORDER)
        assert domain_stages == legacy_stages

    def test_serialize_stage(self) -> None:
        assert serialize_stage(Stage.Discover) == "discover"
        assert serialize_stage(Stage.Apply) == "apply"

    def test_deserialize_stage(self) -> None:
        assert deserialize_stage("discover") == Stage.Discover
        assert deserialize_stage("apply") == Stage.Apply

    def test_stage_roundtrip(self) -> None:
        for stage in Stage:
            assert deserialize_stage(serialize_stage(stage)) == stage

    def test_deserialize_invalid(self) -> None:
        with pytest.raises(ValueError, match="Invalid serialized stage"):
            deserialize_stage("invalid")


# ---------------------------------------------------------------------------
# StageState
# ---------------------------------------------------------------------------


class TestStageState:
    def test_kind_count(self) -> None:
        assert len(STAGE_STATE_KINDS) == 11

    def test_kind_names(self) -> None:
        assert STAGE_STATE_KINDS == (
            "Pending",
            "Queued",
            "Running",
            "Succeeded",
            "Failed",
            "Blocked",
            "Skipped",
            "Exhausted",
            "NeedsVerification",
            "Stale",
            "Canceled",
        )

    def test_pending_construction(self) -> None:
        s = Pending(attempt_count=0, max_attempts=3)
        assert s.kind == "Pending"
        assert s.attempt_count == 0

    def test_queued_construction(self) -> None:
        s = Queued(queued_at="2025-01-01T00:00:00Z")
        assert s.kind == "Queued"

    def test_running_construction(self) -> None:
        s = Running(attempt_count=1, started_at="2025-01-01T00:00:00Z")
        assert s.kind == "Running"

    def test_succeeded_construction(self) -> None:
        s = Succeeded(attempt_count=1, finished_at="2025-01-01T00:00:00Z", duration_ms=1000)
        assert s.kind == "Succeeded"

    def test_failed_construction(self) -> None:
        s = Failed(attempt_count=1, max_attempts=3, error_code="ERR", error_message="boom", retryable=True)
        assert s.kind == "Failed"

    def test_blocked_construction(self) -> None:
        s = Blocked(blocked_by=(Stage.Discover,), error_code="UPSTREAM", error_message="upstream not done")
        assert s.kind == "Blocked"

    def test_skipped_construction(self) -> None:
        s = Skipped(reason="below threshold")
        assert s.kind == "Skipped"

    def test_exhausted_construction(self) -> None:
        s = Exhausted(attempt_count=3, max_attempts=3, error_code="MAX", error_message="max attempts")
        assert s.kind == "Exhausted"

    def test_stale_construction(self) -> None:
        s = Stale(reason="upstream re-ran")
        assert s.kind == "Stale"

    def test_canceled_construction(self) -> None:
        s = Canceled(canceled_at="2025-01-01T00:00:00Z")
        assert s.kind == "Canceled"

    def test_frozen(self) -> None:
        s = Pending(attempt_count=0, max_attempts=3)
        with pytest.raises(AttributeError):
            s.attempt_count = 1  # type: ignore[misc]

    def test_serialize_stage_state(self) -> None:
        s = Pending(attempt_count=0, max_attempts=3)
        assert serialize_stage_state(s) == "pending"

    def test_deserialize_stage_state_kind(self) -> None:
        assert deserialize_stage_state_kind("pending") == "Pending"
        assert deserialize_stage_state_kind("canceled") == "Canceled"

    def test_deserialize_stage_state_kind_invalid(self) -> None:
        with pytest.raises(ValueError, match="Invalid serialized stage state"):
            deserialize_stage_state_kind("nope")
