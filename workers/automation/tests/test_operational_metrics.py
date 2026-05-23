from __future__ import annotations

from pathlib import Path

from jobhunter.database import close_connection, init_db
from jobhunter.domain.discovery.source_registry import SourceKind, SourcePriority, SourceState
from jobhunter.operational_metrics import (
    FailureClassification,
    classify_failure,
    record_operational_attempt_metric,
)
from jobhunter.pipeline import runner


def test_failure_classification_separates_harness_runtime_and_scrape_failures() -> None:
    assert classify_failure(
        stage="discover",
        adapter="jobspy",
        error_class="TypeError",
        error_message="test_discover_jobspy.<locals>.<lambda>() got an unexpected keyword argument 'run_id'",
    ) == FailureClassification("test_harness", False, False, False)

    assert classify_failure(
        stage="discover",
        adapter="jobspy",
        error_class="TimeoutError",
        error_message="Browser fetch timed out",
    ) == FailureClassification("timeout", True, True, True)

    assert classify_failure(
        stage="discover",
        error_class="aborted_for_code_reload",
        error_message="aborted_for_code_reload",
    ) == FailureClassification("code_reload", False, False, False)

    assert classify_failure(
        stage="apply",
        error_class="manual_abort_apply",
        error_message="manual_abort_user",
    ) == FailureClassification("manual_abort", False, False, False)

    assert classify_failure(
        stage="score",
        error_class="RuntimeError",
        error_message="No live process found during verification cleanup",
    ) == FailureClassification("process_cleanup_runtime", True, False, True)

    assert classify_failure(stage="score", error_class="", error_message="") == FailureClassification(
        "unknown",
        True,
        False,
        True,
    )


def test_record_operational_attempt_metric_is_append_only_and_structured(tmp_path: Path) -> None:
    db_path = tmp_path / "jobhunter.db"
    conn = init_db(db_path)
    try:
        record_operational_attempt_metric(
            conn,
            stage="discover",
            attempt_kind="discovery_source",
            outcome="failed",
            source_id="jobspy:linkedin",
            source_kind="broad_board",
            source_priority="lead_generator",
            source_role="lead_generator",
            adapter="jobspy",
            run_id="run-jobspy-timeout",
            counts={"observed_jobs": 3},
            error_class="TimeoutError",
            error_message="Fetch timed out",
        )
        record_operational_attempt_metric(
            conn,
            stage="score",
            attempt_kind="pipeline_stage",
            outcome="succeeded",
            duration_ms=42,
            counts={"total": 1},
        )
        conn.commit()

        rows = conn.execute(
            """
            SELECT stage, source_id, attempt_kind, outcome, failure_category,
                   is_operational_failure, is_scrape_failure, is_retryable,
                   observed_count, total_count, error_class
            FROM operational_attempt_metrics
            ORDER BY metric_id
            """
        ).fetchall()
        assert [row["stage"] for row in rows] == ["discover", "score"]
        assert rows[0]["source_id"] == "jobspy:linkedin"
        assert rows[0]["attempt_kind"] == "discovery_source"
        assert rows[0]["outcome"] == "failed"
        assert rows[0]["failure_category"] == "timeout"
        assert rows[0]["is_operational_failure"] == 1
        assert rows[0]["is_scrape_failure"] == 1
        assert rows[0]["is_retryable"] == 1
        assert rows[0]["observed_count"] == 3
        assert rows[0]["error_class"] == "TimeoutError"
        assert rows[1]["outcome"] == "succeeded"
        assert rows[1]["total_count"] == 1
        assert rows[1]["failure_category"] is None
    finally:
        close_connection(db_path)


def test_discovery_source_attempts_model_board_and_canonical_source_roles(monkeypatch) -> None:
    calls: list[dict[str, object]] = []
    sources = (
        runner.ScheduledSource(
            source_id="jobspy:linkedin",
            display_name="LinkedIn",
            source_kind=SourceKind.BROAD_BOARD,
            priority=SourcePriority.LEAD_GENERATOR,
            configured_state=SourceState.EXPERIMENTAL,
            crawl_budget=10,
            decision="run",
            reason="primary board",
            recommended_state="normal",
            adapter_config={},
        ),
        runner.ScheduledSource(
            source_id="workday:acme",
            display_name="Acme",
            source_kind=SourceKind.ATS_API,
            priority=SourcePriority.CANONICAL,
            configured_state=SourceState.ACTIVE,
            crawl_budget=10,
            decision="run",
            reason="root ats",
            recommended_state="trusted",
            adapter_config={},
        ),
    )

    monkeypatch.setattr(runner, "_record_operational_attempt", lambda **kwargs: calls.append(kwargs))

    runner._record_discovery_source_attempts(
        "jobspy",
        sources,
        "partial_failed",
        run_id="run-partial",
        failed_source_ids=["jobspy:linkedin"],
        error_class="TimeoutError",
        error_message="Board timed out",
    )

    assert calls == [
        {
            "stage": "discover",
            "attempt_kind": "discovery_source",
            "outcome": "failed",
            "source_id": "jobspy:linkedin",
            "source_kind": "broad_board",
            "source_priority": "lead_generator",
            "source_role": "lead_generator",
            "adapter": "jobspy",
            "run_id": "run-partial",
            "duration_ms": None,
            "counts": None,
            "error_class": "TimeoutError",
            "error_message": "Board timed out",
            "metadata": {"decision": "run", "reason": "primary board"},
        },
        {
            "stage": "discover",
            "attempt_kind": "discovery_source",
            "outcome": "succeeded",
            "source_id": "workday:acme",
            "source_kind": "ats_api",
            "source_priority": "canonical",
            "source_role": "canonical_source",
            "adapter": "jobspy",
            "run_id": "run-partial",
            "duration_ms": None,
            "counts": None,
            "error_class": None,
            "error_message": None,
            "metadata": {"decision": "run", "reason": "root ats"},
        },
    ]
