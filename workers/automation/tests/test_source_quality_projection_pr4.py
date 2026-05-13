from __future__ import annotations

from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.projections.source_quality import EventRow, project_source_quality


def test_source_quality_aggregates_run_and_downstream_events() -> None:
    events = [
        EventRow(
            event_type="DiscoveryRunStarted",
            occurred_at="2026-05-13T00:00:00Z",
            payload={
                "run_id": "run-1",
                "source_ids": ["greenhouse:acme"],
                "started_at": "2026-05-13T00:00:00Z",
            },
        ),
        EventRow(
            event_type="JobSourceObserved",
            occurred_at="2026-05-13T00:00:05Z",
            payload={
                "job_id": "job-1",
                "source_observation_id": "obs-1",
                "source_id": "greenhouse:acme",
            },
        ),
        EventRow(
            event_type="PostingContentSnapshotCaptured",
            occurred_at="2026-05-13T00:00:10Z",
            payload={"job_id": "job-1", "source_id": "greenhouse:acme"},
        ),
        EventRow(
            event_type="JobActiveStateChanged",
            occurred_at="2026-05-13T00:00:15Z",
            payload={"job_id": "job-1", "active_state": "active"},
        ),
        EventRow(
            event_type="DiscoveryRunCompleted",
            occurred_at="2026-05-13T00:01:00Z",
            payload={
                "run_id": "run-1",
                "counts": {"total": 1, "new_jobs": 1, "observed_jobs": 1},
                "completed_at": "2026-05-13T00:01:00Z",
            },
        ),
    ]

    result = project_source_quality(
        tenant_id=LOCAL_TENANT,
        events=events,
        updated_at="2026-05-13T00:02:00Z",
    )

    [run] = result.runs
    [stats] = result.stats
    assert run.status == "completed"
    assert run.counts["new_jobs"] == 1
    assert stats.source_id == "greenhouse:acme"
    assert stats.run_count == 1
    assert stats.new_jobs == 1
    assert stats.observed_jobs == 2
    assert stats.full_description_success_rate == 1
    assert stats.active_verification_rate == 1
    assert stats.recommended_state == "normal"


def test_source_quality_marks_sources_quarantined_after_repeated_failures() -> None:
    events = [
        EventRow(
            event_type="DiscoveryRunFailed",
            occurred_at=f"2026-05-13T00:0{i}:00Z",
            payload={
                "run_id": f"run-{i}",
                "source_id": "jobspy:linkedin",
                "error_class": "TimeoutError",
                "retryable": True,
            },
        )
        for i in range(3)
    ]

    result = project_source_quality(
        tenant_id=LOCAL_TENANT,
        events=events,
        updated_at="2026-05-13T00:05:00Z",
    )

    [stats] = result.stats
    assert stats.failed_run_count == 3
    assert stats.consecutive_failures == 3
    assert stats.recommended_state == "quarantined"
