"""Bounded structural QA through actual runner, JobStreaming and SQLite; no models."""

from __future__ import annotations


import pytest
from jobstreaming import AdapterCapabilities, AdapterRegistry, JobPost, JobResponse, Location, Scraper, Site
from jobctrl import config, database
from jobctrl.database import close_connection, init_db
from jobctrl.discovery import jobspy
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
    SqliteDiscoverySearchUnitCheckpointStore,
    SqliteDiscoverySearchUnitRepository,
)
from jobctrl.pipeline import runner
from jobctrl.domain.errors import SourceUnavailableError
from tests.test_jobstreaming_resumable_discovery import _config, _NoopLimiter


class ManyIndeed(Scraper):
    capabilities = AdapterCapabilities(filters=frozenset({"location", "is_remote", "hours_old"}))
    requests = []
    board = Site.INDEED

    def __init__(self, **kwargs):
        super().__init__(self.board)

    def scrape(self, request, context=None):
        assert context is not None
        start = int(context.resume_state.get("next", 0))
        type(self).requests.append(
            {"board": self.board.value, "start": start, "results_wanted": request.results_wanted}
        )
        for index in range(start, min(120, request.results_wanted)):
            label = f"{self.board.value}-{index}"
            if not context.emit_job(
                JobPost(
                    id=label,
                    title=request.search_term,
                    company_name=f"Owned synthetic employer {label}",
                    job_url=f"https://example.test/owned/{label}",
                    location=Location(city="Remote"),
                    description=(
                        f"Owned synthetic position {label}. "
                        + "Lead engineering, platform, reliability, and delivery. " * 10
                    ),
                    is_remote=True,
                ),
                {"next": index + 1},
            ):
                break
        return JobResponse()


class ManyLinkedIn(ManyIndeed):
    board = Site.LINKEDIN
    requests = []


@pytest.fixture
def owned(tmp_path, monkeypatch):
    path = tmp_path / "owned.db"
    conn = init_db(path)
    monkeypatch.setattr(database, "DB_PATH", path)
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(config, "load_sites_config", lambda: {})
    monkeypatch.setattr(config, "load_employers_config", lambda: {})
    monkeypatch.setattr(jobspy, "init_db", lambda: conn)
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    registry = AdapterRegistry()
    registry.register(Site.INDEED, ManyIndeed)
    registry.register(Site.LINKEDIN, ManyLinkedIn)
    monkeypatch.setattr(
        "jobctrl.infrastructure.discovery.live_browser.live_jobstreaming_registry", lambda *a, **k: registry
    )
    ManyIndeed.requests = []
    ManyLinkedIn.requests = []
    yield conn, registry
    close_connection(path)


def seed(conn, source_id, state):
    conn.execute(
        "INSERT INTO source_registry_entries (tenant_id,source_id,kind,display_name,owner,priority,state,policy_id,created_at,updated_at) VALUES ('local',?,'broad_board','Owned synthetic board','system','lead_generator',?,'broad_board_lead_generator','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
        (source_id, state),
    )
    conn.commit()


def plan(monkeypatch, conn, execution, *, limit=20, mixed=False):
    cfg = _config(boards=("indeed", "linkedin") if mixed else ("indeed",))
    cfg["defaults"]["results_per_site"] = 100
    monkeypatch.setattr(config, "load_search_config", lambda: cfg)
    ids = ("jobspy:indeed", "jobspy:linkedin") if mixed else ("jobspy:indeed",)
    seed(conn, "jobspy:indeed", "quarantined" if mixed else "experimental")
    if mixed:
        seed(conn, "jobspy:linkedin", "experimental")
    recorded = runner.plan_discovery_source_families(
        limit=limit,
        source_ids=ids,
        discovery_execution=execution,
        use_source_result_budget=True,
    )
    states = dict(conn.execute("SELECT source_id,state FROM source_registry_entries"))
    assert states == (
        {"jobspy:indeed": "quarantined", "jobspy:linkedin": "active"} if mixed else {"jobspy:indeed": "active"}
    )
    assert recorded["use_source_result_budget"] is True
    return dict(
        limit=limit,
        source_ids=ids,
        start_count=recorded["start_count"],
        discovery_execution=execution,
        use_source_result_budget=True,
        source_result_limits=recorded["source_result_limits"],
    )


def units_meta(repo, execution):
    return [
        {
            "board": u.spec.sites[0],
            "state": u.state,
            "new": u.new_jobs,
            "accepted": u.accepted_jobs,
            "request_fingerprint": u.request_fingerprint,
            "checkpoint_revision": u.checkpoint_revision,
            "recovery_count": u.recovery_count,
        }
        for u in repo.list_units(execution)
    ]


@pytest.mark.parametrize("limit,interrupted_at", [(20, 12), (20, 20), (100, 60)])
def test_real_runner_retry_keeps_absolute_limit_and_checkpoint(owned, monkeypatch, limit, interrupted_at):
    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "discover-owned-limits", "owned-retry")
    kwargs = plan(monkeypatch, conn, execution, limit=limit)
    repo = SqliteDiscoverySearchUnitRepository(conn)
    before_registry = [tuple(r) for r in conn.execute("SELECT * FROM source_registry_entries")]
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    faulted = False

    def interrupt(store, checkpoint):
        nonlocal faulted
        if not faulted and repo.execution_counts(execution)["new"] == interrupted_at:
            faulted = True
            raise RuntimeError("owned worker loss after canonical ingestion")
        return original_save(store, checkpoint)

    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", interrupt)
    with pytest.raises(SourceUnavailableError, match="owned worker loss"):
        runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    assert faulted and repo.execution_counts(execution)["new"] == interrupted_at
    first = units_meta(repo, execution)
    requests_before = list(ManyIndeed.requests)
    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", original_save)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=2, activity_owner_token="owned-2")
    counts = repo.execution_counts(execution)
    assert counts == {"new": limit, "existing": 0, "accepted": limit}
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == limit
    assert result["status"] == "ok" and result["result"]["new"] == limit
    assert (
        conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DiscoveryNewJobAdmitted'").fetchone()[0]
        == limit
    )
    assert [u["request_fingerprint"] for u in first] == [u["request_fingerprint"] for u in units_meta(repo, execution)]
    assert all(u.state in {"completed", "skipped"} for u in repo.list_units(execution))
    assert before_registry == [tuple(r) for r in conn.execute("SELECT * FROM source_registry_entries")]
    if interrupted_at == limit:
        assert ManyIndeed.requests == requests_before


def test_quarantine_cap_does_not_consume_the_healthy_source_allowance(owned, monkeypatch):
    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "discover-owned-limits", "owned-quarantine")
    kwargs = plan(monkeypatch, conn, execution, mixed=True)
    repo = SqliteDiscoverySearchUnitRepository(conn)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    assert result["status"] == "ok" and result["result"]["new"] == 20
    assert {u.spec.sites[0]: u.new_jobs for u in repo.list_units(execution)} == {"indeed": 5, "linkedin": 15}
    assert len(ManyIndeed.requests) == len(ManyLinkedIn.requests) == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 20


def test_disabled_source_on_retry_keeps_its_frozen_units_without_new_acquisition(owned, monkeypatch):
    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "discover-owned-limits", "owned-disabled-retry")
    kwargs = plan(monkeypatch, conn, execution, mixed=True)
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    repo = SqliteDiscoverySearchUnitRepository(conn)

    def interrupt(store, checkpoint):
        if repo.execution_counts(execution)["new"] == 3:
            raise RuntimeError("owned worker interrupted")
        return original_save(store, checkpoint)

    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", interrupt)
    with pytest.raises(SourceUnavailableError, match="owned worker interrupted"):
        runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    first = units_meta(repo, execution)
    prior_requests = list(ManyIndeed.requests)
    conn.execute("UPDATE source_registry_entries SET state='disabled' WHERE source_id='jobspy:indeed'")
    conn.commit()
    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", original_save)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=2, activity_owner_token="owned-2")
    assert result["status"] == "ok" and result["result"]["new"] == 20
    assert ManyIndeed.requests == prior_requests
    assert {u.spec.sites[0]: u.new_jobs for u in repo.list_units(execution)} == {"indeed": 3, "linkedin": 17}
    assert [u["request_fingerprint"] for u in first] == [u["request_fingerprint"] for u in units_meta(repo, execution)]


def test_archived_capture_counts_once_across_provider_retry(owned, monkeypatch):
    from tests.test_captured_posting_recovery import capture

    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "discover-owned-limits", "owned-capture-retry")
    kwargs = plan(monkeypatch, conn, execution)
    capture(conn, "archived", source="jobspy:indeed")
    repo = SqliteDiscoverySearchUnitRepository(conn)
    save = SqliteDiscoverySearchUnitCheckpointStore.save
    faulted = False

    def interrupt(store, checkpoint):
        nonlocal faulted
        if not faulted and repo.execution_counts(execution)["new"] == 12:
            faulted = True
            raise RuntimeError("owned interruption after recovered capture")
        return save(store, checkpoint)

    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", interrupt)
    with pytest.raises(SourceUnavailableError, match="owned interruption"):
        runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", save)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=2, activity_owner_token="owned-2")
    assert result["result"]["new"] == result["result"]["total"] == 20
    assert repo.execution_counts(execution)["new"] == 19
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 20
    assert (
        conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='DiscoveryNewJobAdmitted'").fetchone()[0] == 20
    )
    assert conn.execute("SELECT consumed_at FROM posting_triage WHERE listing_id='archived'").fetchone()[0] is not None


def test_loss_after_canonical_commit_keeps_member_and_repairs_intake(owned, monkeypatch):
    from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository

    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "owned-commit-gap", "owned-commit-gap-run")
    kwargs = plan(monkeypatch, conn, execution, limit=1)
    original = SqliteJobRepository.claim_new_job

    def interrupt(repo, *args):
        original(repo, *args)
        assert not conn.in_transaction
        assert conn.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 1
        raise RuntimeError("owned loss after complete canonical commit")

    monkeypatch.setattr(SqliteJobRepository, "claim_new_job", interrupt)
    with pytest.raises(SourceUnavailableError, match="owned loss after complete canonical commit"):
        runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    monkeypatch.setattr(SqliteJobRepository, "claim_new_job", original)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=2, activity_owner_token="owned-2")
    repo = SqliteDiscoverySearchUnitRepository(conn)
    assert result["status"] == "ok" and result["result"]["new"] == 1
    assert repo.execution_counts(execution) == {"accepted": 1, "new": 1, "existing": 0}
    assert conn.execute("SELECT COUNT(*) FROM discovery_execution_jobs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM discovery_intake_events WHERE processed=0").fetchone()[0] == 0
    assert len(ManyIndeed.requests) == 1


def test_disabling_only_board_closes_frozen_units_without_acquisition(owned, monkeypatch):
    conn, registry = owned
    execution = DiscoveryExecutionRef("local", "owned-all-disabled", "owned-disabled-run")
    kwargs = plan(monkeypatch, conn, execution)
    repo = SqliteDiscoverySearchUnitRepository(conn)
    save = SqliteDiscoverySearchUnitCheckpointStore.save

    def interrupt(store, checkpoint):
        if repo.execution_counts(execution)["new"] == 3:
            raise RuntimeError("owned interruption before disable")
        return save(store, checkpoint)

    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", interrupt)
    with pytest.raises(SourceUnavailableError, match="owned interruption before disable"):
        runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=1, activity_owner_token="owned-1")
    monkeypatch.setattr(SqliteDiscoverySearchUnitCheckpointStore, "save", save)
    conn.execute("UPDATE source_registry_entries SET state='disabled'")
    conn.commit()
    requests = list(ManyIndeed.requests)
    result = runner.run_discovery_source_family("jobspy", **kwargs, activity_attempt=2, activity_owner_token="owned-2")
    assert result["status"] == "skipped_disabled"
    assert ManyIndeed.requests == requests
    assert all(unit.state == "skipped" for unit in repo.list_units(execution))
    assert repo.execution_counts(execution)["new"] == 3
