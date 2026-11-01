"""Preparation reuses observed uncertainty; Apply keeps its stronger gate."""

from datetime import timedelta

import pytest

from jobctrl.domain.errors import MissingInputError, SourceUnavailableError
from jobctrl.enrichment import availability
from .test_saved_posting_availability import JOB_ID, NOW, URL, saved_job as _saved_job

saved_job = _saved_job


def observe(conn, verdict="unknown", at=NOW):
    claim, _ = availability.claim_job(conn, JOB_ID, now=at)
    assert claim is not None
    return availability.complete_check(
        conn, claim, verdict=verdict, reason="synthetic observation",
        method="fixture", lineage=[], now=at,
    )


def test_recent_unknown_preparation_does_not_wait_or_mutate_retry_evidence(saved_job, monkeypatch):
    before = observe(saved_job)
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(minutes=45))
    monkeypatch.setattr(
        availability, "check_availability", lambda *_a, **_kw: pytest.fail("repeated foreground acquisition")
    )
    events_before = saved_job.execute("SELECT COUNT(*) FROM job_events").fetchone()[0]
    availability.require_preparation_available(JOB_ID, conn=saved_job, expected_posting_url=URL)
    after = availability.read_availability(saved_job, JOB_ID)
    assert after["verdict"] == "unknown"
    for field in ("lastAttemptedAt", "lastSuccessfullyVerifiedAt", "lastSuccessfulState", "nextDueAt", "consecutiveFailures"):
        assert after[field] == before[field]
    assert not availability.fresh_active(saved_job, JOB_ID, max_age=timedelta(hours=6))
    assert JOB_ID in availability.due_jobs(saved_job)
    assert saved_job.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == events_before


@pytest.mark.parametrize("age", [timedelta(0), timedelta(hours=6)])
def test_preparation_window_includes_its_boundaries(saved_job, monkeypatch, age):
    observe(saved_job)
    monkeypatch.setattr(availability, "_now", lambda: NOW + age)
    monkeypatch.setattr(
        availability, "check_availability", lambda *_a, **_kw: pytest.fail("fresh observation was reacquired")
    )
    availability.require_preparation_available(JOB_ID, conn=saved_job, expected_posting_url=URL)


@pytest.mark.parametrize("observed_at", [None, "invalid", "2026-10-04T00:00:00", (NOW + timedelta(hours=1)).isoformat(), (NOW - timedelta(hours=7)).isoformat()])
def test_missing_invalid_future_or_old_attempts_use_the_existing_refresh(saved_job, monkeypatch, observed_at):
    value = observe(saved_job)
    availability._event(
        saved_job, "local", "posting_availability", JOB_ID,
        {**value, "lastAttemptedAt": observed_at}, now=NOW,
    )
    saved_job.commit()
    monkeypatch.setattr(availability, "_now", lambda: NOW)
    refreshed = []
    monkeypatch.setattr(availability, "check_availability", lambda *a, **kw: refreshed.append((a, kw)))
    availability.require_preparation_available(JOB_ID, conn=saved_job, expected_posting_url=URL)
    assert len(refreshed) == 1
    assert refreshed[0][1]["explicit"] is False


def test_old_uncertain_observation_is_refreshed_and_stays_uncertain(saved_job, monkeypatch):
    observe(saved_job)
    later = NOW + timedelta(hours=6, seconds=1)
    monkeypatch.setattr(availability, "_now", lambda: later)
    acquisitions = []

    def acquire(_self):
        acquisitions.append(True)
        return "unknown", "synthetic timeout", "fixture"

    monkeypatch.setattr(availability.Acquisition, "acquire", acquire)
    availability.require_preparation_available(JOB_ID, conn=saved_job, expected_posting_url=URL)
    value = availability.read_availability(saved_job, JOB_ID)
    assert acquisitions == [True]
    assert value["lastAttemptedAt"] == later.isoformat()
    assert value["verdict"] == "unknown" and value["lastSuccessfullyVerifiedAt"] is None


def test_apply_freshness_still_acquires_a_recent_unknown_observation(saved_job, monkeypatch):
    observe(saved_job)
    later = NOW + timedelta(minutes=16)
    monkeypatch.setattr(availability, "_now", lambda: later)
    acquisitions = []

    def acquire(_self):
        acquisitions.append(True)
        return "active", "synthetic current evidence", "fixture"

    monkeypatch.setattr(availability.Acquisition, "acquire", acquire)
    availability.require_fresh_active(
        JOB_ID, conn=saved_job, expected_posting_url=URL, max_age=timedelta(minutes=15),
    )
    assert acquisitions == [True]
    assert availability.read_availability(saved_job, JOB_ID)["lastSuccessfullyVerifiedAt"] == later.isoformat()


@pytest.mark.parametrize("unavailable", ["closed", "expired", "removed", "location_incompatible"])
def test_recent_uncertainty_never_reopens_confirmed_unavailability(saved_job, monkeypatch, unavailable):
    observe(saved_job, unavailable)
    observe(saved_job, "unknown", NOW + timedelta(minutes=2))
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(minutes=45))
    monkeypatch.setattr(availability.Acquisition, "acquire", lambda _self: ("unknown", "synthetic timeout", "fixture"))
    with pytest.raises(SourceUnavailableError):
        availability.require_preparation_available(JOB_ID, conn=saved_job, expected_posting_url=URL)
    assert availability.read_availability(saved_job, JOB_ID)["lastSuccessfulState"] == unavailable


@pytest.mark.parametrize("change", ["url", "deleted", "tenant"])
def test_changed_deleted_or_foreign_candidate_cannot_use_the_cache(saved_job, monkeypatch, change):
    observe(saved_job)
    if change == "url":
        saved_job.execute("UPDATE jobs SET url=? WHERE job_id=?", (URL + "-replacement", JOB_ID))
    elif change == "deleted":
        saved_job.execute(
            "INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at) VALUES ('local',?,?)",
            (JOB_ID, NOW.isoformat()),
        )
    saved_job.commit()
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(minutes=45))
    monkeypatch.setattr(
        availability, "check_availability", lambda *_a, **_kw: pytest.fail("changed candidate acquired evidence")
    )
    with pytest.raises(MissingInputError):
        availability.require_preparation_available(
            JOB_ID, conn=saved_job, expected_posting_url=URL,
            tenant_id="foreign" if change == "tenant" else "local",
        )
