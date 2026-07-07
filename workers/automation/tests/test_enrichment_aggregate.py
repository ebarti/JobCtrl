"""Phase 7 / S-26: JobEnrichment aggregate + EnrichmentAttempt entity.

Pin the aggregate's invariants — single Running attempt, attempt
number monotonicity, terminal-state coherence — and the basic
lifecycle transitions.
"""

from __future__ import annotations

import pytest

from jobctrl.domain.enrichment import (
    ApplicationUrl,
    AttemptStatus,
    EnrichmentAttempt,
    EnrichmentError,
    EnrichmentLifecycle,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# FullDescription / ApplicationUrl
# ---------------------------------------------------------------------------


def test_full_description_requires_non_empty_text() -> None:
    assert FullDescription(text="hi").text == "hi"
    with pytest.raises(ValueError):
        FullDescription(text="")
    with pytest.raises(ValueError):
        FullDescription(text="   ")


def test_application_url_requires_non_empty_value() -> None:
    assert ApplicationUrl(value="https://x").value == "https://x"
    with pytest.raises(ValueError):
        ApplicationUrl(value="")


# ---------------------------------------------------------------------------
# ExtractionTier
# ---------------------------------------------------------------------------


def test_extraction_tier_values() -> None:
    assert {t.value for t in ExtractionTier} == {
        "json_ld",
        "css_selectors",
        "llm_assisted",
    }


def test_extraction_tier_from_optional_round_trips() -> None:
    assert ExtractionTier.from_optional("json_ld") is ExtractionTier.JSON_LD
    assert ExtractionTier.from_optional("LLM_ASSISTED") is ExtractionTier.LLM_ASSISTED
    assert ExtractionTier.from_optional(None) is None
    assert ExtractionTier.from_optional("nope") is None


# ---------------------------------------------------------------------------
# EnrichmentError
# ---------------------------------------------------------------------------


def test_enrichment_error_round_trips() -> None:
    err = EnrichmentError(code="HTTP_404", message="Not Found", retryable=False)
    assert err.to_dict() == {
        "code": "HTTP_404",
        "message": "Not Found",
        "retryable": False,
    }


def test_enrichment_error_rejects_empty_code() -> None:
    with pytest.raises(ValueError):
        EnrichmentError(code="", message="msg")


# ---------------------------------------------------------------------------
# EnrichmentAttempt
# ---------------------------------------------------------------------------


def test_attempt_running_requires_no_finished_at() -> None:
    EnrichmentAttempt(
        attempt_number=1,
        extraction_tier=ExtractionTier.JSON_LD,
        status=AttemptStatus.RUNNING,
        started_at="2026-05-01T00:00:00+00:00",
    )
    with pytest.raises(ValueError):
        EnrichmentAttempt(
            attempt_number=1,
            extraction_tier=ExtractionTier.JSON_LD,
            status=AttemptStatus.RUNNING,
            started_at="2026-05-01T00:00:00+00:00",
            finished_at="2026-05-01T00:00:01+00:00",
        )


def test_attempt_failed_requires_error() -> None:
    with pytest.raises(ValueError):
        EnrichmentAttempt(
            attempt_number=1,
            extraction_tier=ExtractionTier.CSS_SELECTORS,
            status=AttemptStatus.FAILED,
            started_at="2026-05-01T00:00:00+00:00",
            finished_at="2026-05-01T00:00:01+00:00",
        )


def test_attempt_succeeded_rejects_error() -> None:
    err = EnrichmentError(code="x", message="x", retryable=True)
    with pytest.raises(ValueError):
        EnrichmentAttempt(
            attempt_number=1,
            extraction_tier=ExtractionTier.JSON_LD,
            status=AttemptStatus.SUCCEEDED,
            started_at="2026-05-01T00:00:00+00:00",
            finished_at="2026-05-01T00:00:01+00:00",
            error=err,
        )


def test_attempt_round_trips_via_dict() -> None:
    err = EnrichmentError(code="HTTP_500", message="oops", retryable=True)
    a = EnrichmentAttempt(
        attempt_number=2,
        extraction_tier=ExtractionTier.LLM_ASSISTED,
        status=AttemptStatus.FAILED,
        started_at="2026-05-01T00:00:00+00:00",
        finished_at="2026-05-01T00:00:30+00:00",
        error=err,
    )
    rebuilt = EnrichmentAttempt.from_dict(a.to_dict())
    assert rebuilt == a


# ---------------------------------------------------------------------------
# JobEnrichment aggregate
# ---------------------------------------------------------------------------


def _empty() -> JobEnrichment:
    return JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/1"),
        updated_at="2026-05-01T00:00:00+00:00",
    )


def test_empty_aggregate_starts_pending() -> None:
    agg = _empty()
    assert agg.is_pending
    assert agg.attempt_count == 0
    assert agg.full_description is None


def test_start_attempt_transitions_to_running() -> None:
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.JSON_LD,
        started_at="2026-05-01T00:01:00+00:00",
    )
    assert agg.is_running
    assert agg.attempt_count == 1
    assert agg.last_attempt is not None and agg.last_attempt.running


def test_start_attempt_rejects_concurrent_running() -> None:
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.JSON_LD,
        started_at="2026-05-01T00:01:00+00:00",
    )
    with pytest.raises(ValueError, match="Running attempt"):
        agg.start_attempt(
            extraction_tier=ExtractionTier.CSS_SELECTORS,
            started_at="2026-05-01T00:02:00+00:00",
        )


def test_succeed_attempt_marks_aggregate_enriched() -> None:
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.JSON_LD,
        started_at="2026-05-01T00:01:00+00:00",
    )
    agg = agg.succeed_attempt(
        full_description=FullDescription(text="The job description"),
        application_url=ApplicationUrl(value="https://example.com/apply"),
        extraction_tier=ExtractionTier.JSON_LD,
        finished_at="2026-05-01T00:01:30+00:00",
    )
    assert agg.is_enriched
    assert agg.full_description is not None
    assert agg.application_url is not None
    assert agg.extraction_tier is ExtractionTier.JSON_LD
    assert agg.enriched_at == "2026-05-01T00:01:30+00:00"
    assert agg.last_attempt is not None and agg.last_attempt.succeeded


def test_succeed_attempt_overrides_recorded_tier() -> None:
    """If cascade started at JSON-LD but Tier 3 succeeded, the recorded
    tier is the actual winner."""
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.JSON_LD,
        started_at="t0",
    )
    agg = agg.succeed_attempt(
        full_description=FullDescription(text="desc"),
        application_url=None,
        extraction_tier=ExtractionTier.LLM_ASSISTED,
        finished_at="t1",
    )
    assert agg.extraction_tier is ExtractionTier.LLM_ASSISTED
    assert agg.last_attempt is not None
    assert agg.last_attempt.extraction_tier is ExtractionTier.LLM_ASSISTED


def test_fail_attempt_marks_aggregate_failed() -> None:
    err = EnrichmentError(code="HTTP_404", message="Not Found", retryable=False)
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="t0"
    )
    agg = agg.fail_attempt(error=err, finished_at="t1")
    assert agg.is_failed
    assert agg.last_attempt is not None
    assert agg.last_attempt.failed
    assert agg.last_attempt.error == err


def test_succeed_without_running_attempt_raises() -> None:
    with pytest.raises(ValueError):
        _empty().succeed_attempt(
            full_description=FullDescription(text="x"),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )


def test_fail_without_running_attempt_raises() -> None:
    with pytest.raises(ValueError):
        _empty().fail_attempt(
            error=EnrichmentError(code="x", message="x"),
            finished_at="t1",
        )


def test_start_attempt_rejected_after_enriched() -> None:
    agg = (
        _empty()
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="desc"),
            application_url=None,
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    with pytest.raises(ValueError, match="already enriched"):
        agg.start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t2")


def test_reset_clears_terminal_state_but_preserves_history() -> None:
    err = EnrichmentError(code="HTTP_404", message="Not Found", retryable=False)
    agg = _empty().start_attempt(
        extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="t0"
    )
    agg = agg.fail_attempt(error=err, finished_at="t1")
    reset = agg.reset(reset_at="t2")
    assert reset.is_pending
    assert reset.full_description is None
    assert reset.attempt_count == 1  # history preserved


def _enriched_without_apply_url() -> JobEnrichment:
    return _empty().start_attempt(
        extraction_tier=ExtractionTier.JSON_LD, started_at="t0"
    ).succeed_attempt(
        full_description=FullDescription(text="The canonical description"),
        application_url=None,
        extraction_tier=ExtractionTier.JSON_LD,
        finished_at="t1",
    )


def test_record_apply_url_recovery_attaches_url_and_preserves_description() -> None:
    agg = _enriched_without_apply_url()
    recovered = agg.record_apply_url_recovery(
        application_url=ApplicationUrl(value="https://apply.example/role"),
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        started_at="t2",
        finished_at="t3",
    )
    assert recovered.is_enriched
    assert recovered.application_url is not None
    assert recovered.application_url.value == "https://apply.example/role"
    assert recovered.full_description is not None
    assert recovered.full_description.text == "The canonical description"
    assert recovered.enriched_at == "t1"
    assert recovered.extraction_tier is ExtractionTier.JSON_LD  # top-level tier preserved
    assert recovered.attempt_count == agg.attempt_count + 1
    assert recovered.last_attempt is not None and recovered.last_attempt.succeeded
    assert recovered.updated_at == "t3"


def test_record_apply_url_recovery_missing_url_bounds_without_failing_row() -> None:
    agg = _enriched_without_apply_url()
    recovered = agg.record_apply_url_recovery(
        application_url=None,
        extraction_tier=ExtractionTier.CSS_SELECTORS,
        started_at="t2",
        finished_at="t3",
    )
    # Enriched status + description are intact; only a bounding attempt is added.
    assert recovered.is_enriched
    assert recovered.application_url is None
    assert recovered.full_description is not None
    assert recovered.full_description.text == "The canonical description"
    assert recovered.attempt_count == agg.attempt_count + 1
    assert recovered.last_attempt is not None
    assert recovered.last_attempt.failed
    assert recovered.last_attempt.error is not None
    assert recovered.last_attempt.error.code == "APPLY_URL_UNRESOLVED"


def test_record_apply_url_recovery_requires_enriched_aggregate() -> None:
    with pytest.raises(ValueError, match="requires an enriched aggregate"):
        _empty().record_apply_url_recovery(
            application_url=ApplicationUrl(value="https://apply.example/role"),
            extraction_tier=ExtractionTier.CSS_SELECTORS,
            started_at="t0",
            finished_at="t1",
        )


def test_attempt_numbers_must_be_monotonic() -> None:
    err = EnrichmentError(code="x", message="x", retryable=True)
    bad_attempt = EnrichmentAttempt(
        attempt_number=2,  # should be 1
        extraction_tier=ExtractionTier.JSON_LD,
        status=AttemptStatus.FAILED,
        started_at="t0",
        finished_at="t1",
        error=err,
    )
    with pytest.raises(ValueError, match="numbered 1..N"):
        JobEnrichment(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            current_status=EnrichmentLifecycle.FAILED,
            attempts=(bad_attempt,),
        )


def test_at_most_one_running_invariant_enforced() -> None:
    a1 = EnrichmentAttempt(
        attempt_number=1,
        extraction_tier=ExtractionTier.JSON_LD,
        status=AttemptStatus.RUNNING,
        started_at="t0",
    )
    a2 = EnrichmentAttempt(
        attempt_number=2,
        extraction_tier=ExtractionTier.JSON_LD,
        status=AttemptStatus.RUNNING,
        started_at="t1",
    )
    with pytest.raises(ValueError, match="AT MOST one Running"):
        JobEnrichment(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            current_status=EnrichmentLifecycle.RUNNING,
            attempts=(a1, a2),
        )


def test_terminal_state_requires_full_description_when_enriched() -> None:
    a1 = EnrichmentAttempt(
        attempt_number=1,
        extraction_tier=ExtractionTier.JSON_LD,
        status=AttemptStatus.SUCCEEDED,
        started_at="t0",
        finished_at="t1",
    )
    with pytest.raises(ValueError, match="full_description"):
        JobEnrichment(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            current_status=EnrichmentLifecycle.ENRICHED,
            attempts=(a1,),
            full_description=None,
            enriched_at="t1",
            extraction_tier=ExtractionTier.JSON_LD,
        )


def test_aggregate_to_dict_serialises_full_state() -> None:
    agg = (
        _empty()
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="The desc"),
            application_url=ApplicationUrl(value="https://apply"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    d = agg.to_dict()
    assert d["current_status"] == "enriched"
    assert d["full_description"] == "The desc"
    assert d["application_url"] == "https://apply"
    assert d["extraction_tier"] == "json_ld"
    assert len(d["attempts"]) == 1
    assert d["attempts"][0]["status"] == "succeeded"
