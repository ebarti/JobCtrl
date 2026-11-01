"""Controlled-clock reproduction of model time spending browser acquisition budget."""
from datetime import timedelta
from types import SimpleNamespace
import threading

import pytest

from jobctrl.enrichment import availability
from jobctrl.domain.enrichment.value_objects import DetailPage
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from tests.page_fakes import PageModel, interpreter
from tests.politeness_helpers import VirtualClock, no_sleep_limiter
from tests.test_saved_posting_availability import saved_job as _saved_job, JOB_ID, NOW, URL

saved_job = _saved_job


def setup_case(conn, monkeypatch, *, model_seconds=130, network_seconds=5, cancel=None, after_first=None):
    clock = VirtualClock()
    monkeypatch.setattr(availability, "time", SimpleNamespace(monotonic=clock.now, sleep=clock.sleep))
    monkeypatch.setattr(availability, "_now", lambda: NOW + timedelta(seconds=clock.now()))
    monkeypatch.setattr("jobctrl.infrastructure.network.rate_limiter._SHARED_RATE_LIMITER", no_sleep_limiter(clock))

    class SlowModel(PageModel):
        def chat_json(self, messages, **kwargs):
            self.availability = "unknown" if not self.calls else "active"
            if not self.calls:
                clock.sleep(model_seconds)
                if after_first:
                    after_first()
            return super().chat_json(messages, **kwargs)

    model = SlowModel()
    monkeypatch.setattr(availability, "build_page_interpreter", lambda connection=None, **_: interpreter(model, SqliteDeterminationRepository(conn)))

    def fetch(url):
        clock.sleep(network_seconds)
        return availability.Response(url, url, 200, b"<main>Owned source</main>")

    browser_remaining = []

    def browser(url, *, fetcher, deadline, **_):
        browser_remaining.append(deadline - clock.now())
        if deadline - clock.now() <= availability.BROWSER_CLEANUP_GRACE_SECONDS:
            raise availability.DeferredCheck("acquisition_deadline", browser_phase="launch")
        fetcher(url, "browser_resource")
        return DetailPage(url=url, final_url=url, status=200, html="<main>Owned rendered source</main>")

    monkeypatch.setattr(availability, "anonymous_browser", browser)
    claim, _ = availability.claim_job(conn, JOB_ID, now=NOW)
    return availability.Acquisition(conn, claim, transport=fetch, cancel_event=cancel), model, clock, browser_remaining


@pytest.mark.parametrize("model_seconds", [118, 130])
def test_model_time_does_not_exhaust_remaining_network_budget(saved_job, monkeypatch, model_seconds):
    acquisition, model, clock, remaining = setup_case(saved_job, monkeypatch, model_seconds=model_seconds)
    assert acquisition.acquire()[0] == "active", acquisition.lineage
    assert remaining == [115]
    assert len(model.calls) == 2
    assert saved_job.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 2
    value = availability.complete_check(saved_job, acquisition.claim, verdict="active", reason="model_determination", method="anonymous_browser", lineage=acquisition.lineage)
    assert value["verdict"] == "active"
    assert clock.now() == model_seconds + 10


def test_model_pause_does_not_extend_the_original_job_lease(saved_job, monkeypatch):
    acquisition, model, _, remaining = setup_case(saved_job, monkeypatch, model_seconds=301)
    with pytest.raises(availability.DeferredCheck, match="stale_lease"):
        acquisition.acquire()
    assert remaining == []
    assert len(model.calls) == 1
    assert not availability._latest(saved_job, "local", "posting_availability", JOB_ID)


def test_cancel_during_model_review_does_not_start_browser(saved_job, monkeypatch):
    cancel = threading.Event()
    acquisition, model, _, remaining = setup_case(saved_job, monkeypatch, cancel=cancel, after_first=cancel.set)
    with pytest.raises(availability.DeferredCheck, match="check_canceled"):
        acquisition.acquire()
    assert remaining == []
    assert len(model.calls) == 1


def test_model_pause_does_not_reset_cumulative_transport_budget(saved_job, monkeypatch):
    acquisition, model, _, remaining = setup_case(
        saved_job, monkeypatch, model_seconds=10, network_seconds=61,
    )
    with pytest.raises(availability.DeferredCheck, match="acquisition_deadline"):
        acquisition.acquire()
    assert remaining == [59]
    assert len(model.calls) == 1
    assert [step["method"] for step in acquisition.lineage][:2] == ["public_http", "browser_resource"]
    assert not availability._latest(saved_job, "local", "availability_lease", "host:careers.example.org").get("owner")


@pytest.mark.parametrize("replacement", ["owner", "url", "deleted"])
def test_model_pause_rechecks_ownership_and_candidate_before_browser(saved_job, monkeypatch, replacement):
    def replace_candidate():
        if replacement == "owner":
            lease = availability._latest(saved_job, "local", "availability_lease", f"job:{JOB_ID}")
            availability._event(saved_job, "local", "availability_lease", f"job:{JOB_ID}", {**lease, "owner": "successor"})
        elif replacement == "url":
            saved_job.execute("UPDATE jobs SET url=? WHERE job_id=?", (URL + "-replacement", JOB_ID))
        else:
            saved_job.execute(
                "INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at) VALUES ('local',?,?)",
                (JOB_ID, NOW.isoformat()),
            )
        saved_job.commit()

    acquisition, model, _, remaining = setup_case(saved_job, monkeypatch, after_first=replace_candidate)
    with pytest.raises(availability.DeferredCheck, match="stale_lease" if replacement == "owner" else "candidate_changed"):
        acquisition.acquire()
    assert remaining == []
    assert len(model.calls) == 1
    assert not availability._latest(saved_job, "local", "posting_availability", JOB_ID)
