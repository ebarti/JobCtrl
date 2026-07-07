"""Phase 8 (S-28): ApplyRun aggregate construction + lifecycle invariants.

See ddd-target.md §4.6.
"""

import pytest

from jobctl.domain.apply import (
    Applied,
    ApplyRun,
    ApplyRunEvent,
    ApplyRunStatus,
    Captcha,
    DryRunComplete,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    TokenUsage,
    new_apply_run_id,
)
from jobctl.domain.identifiers import JobId
from jobctl.domain.tenant import LOCAL_TENANT


def _start(*, dry_run: bool = False, headless: bool = False) -> ApplyRun:
    return ApplyRun.start(
        tenant_id=LOCAL_TENANT,
        run_id=new_apply_run_id(),
        job_id=JobId("https://example.com/job"),
        started_at="t0",
        worker_id=1,
        model="sonnet",
        dry_run=dry_run,
        headless=headless,
        attempts=1,
    )


def test_start_creates_starting_aggregate():
    run = _start()
    assert run.status == ApplyRunStatus.STARTING
    assert run.is_starting
    assert not run.is_terminal
    assert run.events == ()
    assert run.submission_result is None


def test_record_event_appends_monotonic_event_ids():
    run = _start()
    run = run.record_event(event_type="A", occurred_at="t1")
    run = run.record_event(event_type="B", occurred_at="t2")
    assert [e.event_id for e in run.events] == [1, 2]
    assert isinstance(run.events[0], ApplyRunEvent)


def test_transition_to_in_progress_requires_starting_state():
    run = _start().transition_to_in_progress(worker_id=2)
    assert run.is_in_progress
    with pytest.raises(ValueError, match="must be in starting"):
        run.transition_to_in_progress()


def test_complete_with_applied_transitions_to_succeeded():
    run = _start().transition_to_in_progress()
    completed = run.complete(
        result=Applied(applied_at="t9", verification_confidence=0.85),
        finished_at="t9",
        token_usage=TokenUsage(input=10, output=20, cost_usd=0.05),
        duration_ms=1500,
    )
    assert completed.is_succeeded
    assert completed.is_terminal
    assert completed.token_usage is not None
    assert completed.duration_ms == 1500


def test_dry_run_with_applied_result_is_rejected():
    """§4.6 invariant: dry runs MUST never end with Applied."""
    run = _start(dry_run=True).transition_to_in_progress()
    with pytest.raises(ValueError, match="dry runs must never mark"):
        run.complete(
            result=Applied(applied_at="t9", verification_confidence=1.0),
            finished_at="t9",
        )


def test_non_dry_run_with_dry_run_complete_is_rejected():
    run = _start(dry_run=False).transition_to_in_progress()
    with pytest.raises(ValueError, match="dry_run is False"):
        run.complete(
            result=DryRunComplete(navigated_to="x"),
            finished_at="t9",
        )


def test_complete_after_terminal_state_raises():
    run = _start().transition_to_in_progress().complete(
        result=Failed(error="boom", retryable=True),
        finished_at="t9",
    )
    with pytest.raises(ValueError, match="already in terminal"):
        run.complete(result=Expired(), finished_at="t10")


@pytest.mark.parametrize(
    "result,expected_status",
    [
        (Applied(applied_at="t", verification_confidence=1.0), ApplyRunStatus.SUCCEEDED),
        (Failed(error="x", retryable=True), ApplyRunStatus.FAILED),
        (Captcha(details="x"), ApplyRunStatus.CAPTCHA),
        (LoginIssue(details="x"), ApplyRunStatus.LOGIN_ISSUE),
        (Expired(), ApplyRunStatus.EXPIRED),
        (Manual(reason="x"), ApplyRunStatus.MANUAL),
    ],
)
def test_each_submission_variant_maps_to_correct_terminal_status(result, expected_status):
    run = _start().transition_to_in_progress().complete(result=result, finished_at="t9")
    assert run.status == expected_status


def test_submission_variant_status_mismatch_is_rejected():
    """If a caller hand-builds a terminal aggregate with a mismatched
    status / submission_result pair, __post_init__ raises."""
    with pytest.raises(ValueError, match="does not match submission_result kind"):
        ApplyRun(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            status=ApplyRunStatus.SUCCEEDED,
            started_at="t0",
            finished_at="t9",
            submission_result=Failed(error="x", retryable=True),
        )


def test_event_numbering_must_be_monotonic():
    with pytest.raises(ValueError, match="numbered 1..N"):
        ApplyRun(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            started_at="t0",
            events=(
                ApplyRunEvent(event_id=2, event_type="X", occurred_at="t1"),
            ),
        )


def test_terminal_state_requires_finished_at():
    with pytest.raises(ValueError, match="finished_at must be set"):
        ApplyRun(
            tenant_id=LOCAL_TENANT,
            run_id=new_apply_run_id(),
            job_id=JobId("https://example.com/job"),
            status=ApplyRunStatus.FAILED,
            started_at="t0",
            finished_at=None,
            submission_result=Failed(error="x", retryable=True),
        )


def test_to_dict_round_trips_basic_shape():
    run = (
        _start()
        .transition_to_in_progress()
        .record_event(event_type="X", occurred_at="t1", payload={"k": 1})
        .complete(
            result=Applied(applied_at="t9", verification_confidence=0.9),
            finished_at="t9",
            token_usage=TokenUsage(input=1, output=2, cost_usd=0.01),
        )
    )
    d = run.to_dict()
    assert d["status"] == "succeeded"
    assert d["submission_result"]["kind"] == "applied"
    assert d["submission_result"]["verification_confidence"] == 0.9
    assert d["events"][0]["event_id"] == 1
    assert d["token_usage"]["input"] == 1
