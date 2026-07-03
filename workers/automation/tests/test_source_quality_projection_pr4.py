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
            event_type="JobEnriched",
            occurred_at="2026-05-13T00:00:12Z",
            payload={
                "job_id": "job-1",
                "full_description": "Complete posting",
                "application_url": "https://acme.example/apply/1",
            },
        ),
        EventRow(
            event_type="JobActiveStateChanged",
            occurred_at="2026-05-13T00:00:15Z",
            payload={"job_id": "job-1", "active_state": "active"},
        ),
        EventRow(
            event_type="JobSourceObserved",
            occurred_at="2026-05-13T00:00:20Z",
            payload={
                "job_id": "job-2",
                "source_observation_id": "obs-2",
                "source_id": "greenhouse:acme",
            },
        ),
        EventRow(
            event_type="EnrichmentFailed",
            occurred_at="2026-05-13T00:00:25Z",
            payload={
                "job_id": "job-2",
                "error": "TimeoutError",
                "attempt_number": 1,
            },
        ),
        EventRow(
            event_type="ContentDuplicateCandidateDetected",
            occurred_at="2026-05-13T00:00:30Z",
            payload={
                "job_id": "job-1",
                "candidate_job_id": "job-2",
                "confidence": 0.91,
            },
        ),
        EventRow(
            event_type="DiscoveryRunCompleted",
            occurred_at="2026-05-13T00:01:00Z",
            payload={
                "run_id": "run-1",
                "counts": {"total": 2, "new_jobs": 2, "observed_jobs": 2},
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
    assert run.counts["new_jobs"] == 2
    assert stats.source_id == "greenhouse:acme"
    assert stats.run_count == 1
    assert stats.new_jobs == 2
    assert stats.observed_jobs == 2
    assert stats.duplicate_jobs == 1
    assert stats.full_description_success_rate == 0.5
    assert stats.apply_url_success_rate == 0.5
    assert stats.active_verification_rate == 1
    assert stats.last_error_class == "TimeoutError"
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


def test_source_quality_quarantines_only_failed_workday_source() -> None:
    events = [
        EventRow(
            event_type="DiscoveryRunStarted",
            occurred_at=f"2026-05-13T00:0{i}:00Z",
            payload={
                "run_id": f"workday-run-{i}",
                "source_ids": [
                    "workday:acme-wd1-myworkdayjobs-com",
                    "workday:globex-wd1-myworkdayjobs-com",
                ],
                "started_at": f"2026-05-13T00:0{i}:00Z",
            },
        )
        for i in range(3)
    ]
    events.extend(
        EventRow(
            event_type="DiscoveryRunFailed",
            occurred_at=f"2026-05-13T00:0{i}:10Z",
            payload={
                "run_id": f"workday-run-{i}",
                "source_id": "workday:acme-wd1-myworkdayjobs-com",
                "error_class": "SourceUnavailableError",
                "retryable": True,
            },
        )
        for i in range(3)
    )

    result = project_source_quality(
        tenant_id=LOCAL_TENANT,
        events=events,
        updated_at="2026-05-13T00:05:00Z",
    )

    stats = {item.source_id: item for item in result.stats}
    assert stats["workday:acme-wd1-myworkdayjobs-com"].consecutive_failures == 3
    assert stats["workday:acme-wd1-myworkdayjobs-com"].recommended_state == "quarantined"
    assert stats["workday:globex-wd1-myworkdayjobs-com"].consecutive_failures == 0
    assert stats["workday:globex-wd1-myworkdayjobs-com"].recommended_state == "normal"


def test_source_quality_does_not_reset_failed_sources_on_partial_completion() -> None:
    events = [
        *[
            EventRow(
                event_type="DiscoveryRunFailed",
                occurred_at=f"2026-05-13T00:0{i}:00Z",
                payload={
                    "run_id": f"prior-{i}",
                    "source_id": "lever:acme",
                    "error_class": "TimeoutError",
                    "retryable": True,
                },
            )
            for i in range(3)
        ],
        EventRow(
            event_type="DiscoveryRunStarted",
            occurred_at="2026-05-13T00:10:00Z",
            payload={
                "run_id": "mixed-run",
                "source_ids": ["greenhouse:acme", "lever:acme"],
                "started_at": "2026-05-13T00:10:00Z",
            },
        ),
        EventRow(
            event_type="DiscoveryRunFailed",
            occurred_at="2026-05-13T00:10:20Z",
            payload={
                "run_id": "mixed-run",
                "source_id": "lever:acme",
                "error_class": "TimeoutError",
                "retryable": True,
            },
        ),
        EventRow(
            event_type="DiscoveryRunCompleted",
            occurred_at="2026-05-13T00:11:00Z",
            payload={
                "run_id": "mixed-run",
                "counts": {"total": 1, "new_jobs": 1, "observed_jobs": 1},
                "failed_source_ids": ["lever:acme"],
                "completed_at": "2026-05-13T00:11:00Z",
            },
        ),
    ]

    result = project_source_quality(
        tenant_id=LOCAL_TENANT,
        events=events,
        updated_at="2026-05-13T00:12:00Z",
    )

    stats = {item.source_id: item for item in result.stats}
    assert stats["greenhouse:acme"].run_count == 1
    assert stats["greenhouse:acme"].consecutive_failures == 0
    assert stats["lever:acme"].failed_run_count == 4
    assert stats["lever:acme"].consecutive_failures == 4
    assert stats["lever:acme"].recommended_state == "quarantined"


def test_source_quality_applies_discovery_feedback_events() -> None:
    result = project_source_quality(
        tenant_id=LOCAL_TENANT,
        events=[
            EventRow(
                event_type="DiscoveryFeedbackRecorded",
                occurred_at="2026-05-13T00:00:00Z",
                payload={
                    "feedback_id": "feedback-1",
                    "job_id": "job-1",
                    "source_id": "greenhouse:acme",
                    "kind": "bad_source",
                    "recorded_at": "2026-05-13T00:00:00Z",
                },
            )
        ],
        updated_at="2026-05-13T00:05:00Z",
    )

    [stats] = result.stats
    assert stats.source_id == "greenhouse:acme"
    assert stats.observed_jobs == 1
    assert stats.detail_failure_count == 1
    assert stats.last_error_class == "user_bad_source"
