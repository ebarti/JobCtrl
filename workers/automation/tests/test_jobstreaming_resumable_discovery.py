from __future__ import annotations

import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker
from jobstreaming import (
    AdapterCapabilities,
    AdapterRegistry,
    CursorExpiredError,
    InvalidRequestError,
    JobPost,
    JobResponse,
    Location,
    Scraper,
    SearchCheckpoint,
    Site,
)

from jobctrl.database import close_connection, init_db
from jobctrl.discovery import jobspy
from jobctrl.discovery.activities import (
    DiscoveryEnrichmentActivityInput,
    DiscoveryEnrichmentActivityOutput,
    DiscoveryPreparationFanoutInput,
    DiscoveryPreparationFanoutOutput,
    DiscoverySourceActivityInput,
    DiscoverySourceActivityOutput,
    PlanDiscoverySourcesInput,
    PlanDiscoverySourcesOutput,
)
from jobctrl.discovery.workflow import DiscoverWorkflow, DiscoverWorkflowInput
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
    SqliteDiscoverySearchUnitCheckpointStore,
    SqliteDiscoverySearchUnitRepository,
)
from jobctrl.infrastructure.discovery.jobstreaming_gateway import (
    JobStreamingGateway,
)
from jobctrl.infrastructure.temporal.finalize import (
    WorkflowOutcomeInput,
    WorkflowStartedInput,
)
from jobctrl.llm import SpendBudgetStatus


_DESCRIPTION = "Lead engineering, platform, reliability, and delivery. " * 10
_TEMPORAL_REGISTRY: AdapterRegistry | None = None


class _NoopLimiter:
    @contextmanager
    def slot(self, *_args, **_kwargs):
        yield


class _PagedIndeed(Scraper):
    capabilities = AdapterCapabilities(
        filters=frozenset({"location", "is_remote", "hours_old"})
    )
    requests: list[str] = []

    def __init__(self, **_: object) -> None:
        super().__init__(Site.INDEED)

    def scrape(self, request, context=None) -> JobResponse:
        assert context is not None
        type(self).requests.append(request.search_term)
        start = int(context.resume_state.get("next", 0))
        slug = request.search_term.casefold().replace(" ", "-")
        for index in range(start, 2):
            if not context.emit_job(
                JobPost(
                    id=f"{slug}-{index + 1}",
                    title=request.search_term,
                    company_name=f"Example {index + 1}",
                    job_url=f"https://example.test/{slug}/{index + 1}",
                    location=Location(city="Remote"),
                    description=(
                        _DESCRIPTION
                        + f" Unique organization marker {index + 1}." * 20
                    ),
                    is_remote=True,
                ),
                {"next": index + 1},
            ):
                break
        return JobResponse()


class _SuccessfulIndeed(_PagedIndeed):
    def scrape(self, request, context=None) -> JobResponse:
        assert context is not None
        type(self).requests.append(request.search_term)
        slug = request.search_term.casefold().replace(" ", "-")
        context.emit_job(
            JobPost(
                id=f"{slug}-1",
                title=request.search_term,
                company_name="Example",
                job_url=f"https://example.test/{slug}/1",
                location=Location(city="Remote"),
                description=_DESCRIPTION,
                is_remote=True,
            ),
            {"next": 1},
        )
        return JobResponse()


class _FilteredIndeed(Scraper):
    capabilities = AdapterCapabilities(
        filters=frozenset({"location", "is_remote", "hours_old"})
    )

    def __init__(self, **_: object) -> None:
        super().__init__(Site.INDEED)

    def scrape(self, request, context=None) -> JobResponse:
        del request
        assert context is not None
        if int(context.resume_state.get("next", 0)) == 0:
            context.emit_job(
                JobPost(
                    id="filtered-1",
                    title="Accountant",
                    company_name="Filtered Example",
                    job_url="https://example.test/filtered/1",
                    location=Location(city="Remote"),
                    description=_DESCRIPTION,
                    is_remote=True,
                ),
                {"next": 1},
            )
        return JobResponse()


class _InvalidLinkedIn(Scraper):
    capabilities = AdapterCapabilities(
        filters=frozenset({"location", "is_remote", "hours_old"})
    )

    def __init__(self, **_: object) -> None:
        super().__init__(Site.LINKEDIN)

    def scrape(self, request, context=None) -> JobResponse:
        del request, context
        raise InvalidRequestError("invalid request")


class _CursorThenPosting(_SuccessfulIndeed):
    calls = 0

    def scrape(self, request, context=None) -> JobResponse:
        type(self).calls += 1
        if type(self).calls == 1:
            raise CursorExpiredError("cursor expired")
        return super().scrape(request, context=context)


class _CursorThenLinkedIn(Scraper):
    capabilities = AdapterCapabilities(
        filters=frozenset({"location", "is_remote", "hours_old"})
    )
    calls = 0

    def __init__(self, **_: object) -> None:
        super().__init__(Site.LINKEDIN)

    def scrape(self, request, context=None) -> JobResponse:
        assert context is not None
        type(self).calls += 1
        if type(self).calls == 1:
            raise CursorExpiredError("cursor expired")
        slug = request.search_term.casefold().replace(" ", "-")
        context.emit_job(
            JobPost(
                id=f"{slug}-linkedin-1",
                title=request.search_term,
                company_name="LinkedIn Example",
                job_url=f"https://example.test/{slug}/linkedin-1",
                location=Location(city="Remote"),
                description=_DESCRIPTION,
                is_remote=True,
            ),
            {"start": 1},
        )
        return JobResponse()


class _WaitingIndeed(Scraper):
    capabilities = AdapterCapabilities(
        filters=frozenset({"location", "is_remote", "hours_old"})
    )
    started = threading.Event()

    def __init__(self, **_: object) -> None:
        super().__init__(Site.INDEED)

    def scrape(self, request, context=None) -> JobResponse:
        del request
        assert context is not None
        type(self).started.set()
        context.wait(30)
        return JobResponse()


def _execution(run_id: str = "temporal-run-1") -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id=run_id,
    )


def _config(
    *,
    queries: tuple[str, ...] = ("Director of Engineering",),
    boards: tuple[str, ...] = ("indeed",),
) -> dict:
    return {
        "boards": list(boards),
        "queries": [{"query": query} for query in queries],
        "locations": [
            {"label": "remote", "location": "Remote", "remote": True}
        ],
        "defaults": {
            "results_per_site": 10,
            "hours_old": 72,
            "country_indeed": "usa",
        },
        "location": {
            "accept_patterns": ["Remote"],
            "reject_patterns": [],
            "local_accept_patterns": ["Remote"],
        },
    }


def _registry(*, linkedin: bool = False, indeed_factory=_PagedIndeed):
    registry = AdapterRegistry()
    registry.register(Site.INDEED, indeed_factory)
    if linkedin:
        registry.register(Site.LINKEDIN, _InvalidLinkedIn)
    return registry


@activity.defn(name="check_spend_budget")
async def _temporal_check_spend_budget(_payload) -> SpendBudgetStatus:
    return SpendBudgetStatus(
        day="2026-07-17",
        input_tokens=0,
        output_tokens=0,
        estimated_usd=0.0,
        daily_budget_usd=25.0,
        exceeded=False,
    )


@activity.defn(name="record_workflow_started")
async def _temporal_record_started(_payload: WorkflowStartedInput) -> None:
    return None


@activity.defn(name="record_workflow_outcome")
async def _temporal_record_outcome(_payload: WorkflowOutcomeInput) -> None:
    return None


@activity.defn(name="plan_discovery_sources")
async def _temporal_plan_sources(
    _payload: PlanDiscoverySourcesInput,
) -> PlanDiscoverySourcesOutput:
    return PlanDiscoverySourcesOutput(
        families=["jobspy"],
        progress_total=3,
        start_count=0,
    )


@activity.defn(name="discovery_source_family")
async def _temporal_resumable_source(
    payload: DiscoverySourceActivityInput,
) -> DiscoverySourceActivityOutput:
    assert payload.discovery_execution is not None
    assert _TEMPORAL_REGISTRY is not None
    info = activity.info()
    activity.heartbeat("JobStreaming unit running")
    result = await asyncio.to_thread(
        jobspy.run_discovery,
        cfg=_config(),
        discovery_execution=payload.discovery_execution,
        activity_attempt=info.attempt,
        activity_owner_token=f"{info.activity_run_id}:{info.attempt}",
        adapter_registry=_TEMPORAL_REGISTRY,
    )
    return DiscoverySourceActivityOutput(
        family=payload.family,
        status="ok",
        result=result,
        source_ids=["jobspy:indeed"],
    )


@activity.defn(name="discovery_enrichment")
async def _temporal_enrichment(
    _payload: DiscoveryEnrichmentActivityInput,
) -> DiscoveryEnrichmentActivityOutput:
    return DiscoveryEnrichmentActivityOutput(status="ok", passes=1, pending=0)


@activity.defn(name="discovery_preparation_fanout")
async def _temporal_fanout(
    _payload: DiscoveryPreparationFanoutInput,
) -> DiscoveryPreparationFanoutOutput:
    return DiscoveryPreparationFanoutOutput(started=0, queued=0, targets=0)


def _temporal_activities():
    return [
        _temporal_check_spend_budget,
        _temporal_record_started,
        _temporal_record_outcome,
        _temporal_plan_sources,
        _temporal_resumable_source,
        _temporal_enrichment,
        _temporal_fanout,
    ]


@pytest.fixture
def discovery_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    monkeypatch.setattr(jobspy, "init_db", lambda: conn)
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    try:
        yield conn, db_path
    finally:
        close_connection(db_path)


def test_store_before_ack_replay_resumes_without_duplicate_counts_or_events(
    discovery_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution()
    _PagedIndeed.requests = []
    progress: list[dict] = []
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    interrupted = False

    def interrupt_first_job_ack(self, checkpoint) -> None:
        nonlocal interrupted
        if checkpoint.revision == 1 and not interrupted:
            interrupted = True
            raise RuntimeError("simulated worker loss after durable store")
        original_save(self, checkpoint)

    monkeypatch.setattr(
        SqliteDiscoverySearchUnitCheckpointStore,
        "save",
        interrupt_first_job_ack,
    )

    with pytest.raises(RuntimeError, match="simulated worker loss"):
        jobspy.run_discovery(
            cfg=_config(),
            run_id="discovery:jobstreaming:first",
            progress_callback=progress.append,
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="activity-attempt-1",
            adapter_registry=_registry(),
        )

    repository = SqliteDiscoverySearchUnitRepository(conn)
    interrupted_unit = repository.list_units(execution)[0]
    assert interrupted_unit.state == "running"
    assert interrupted_unit.checkpoint_revision == 0
    assert interrupted_unit.accepted_jobs == 1
    assert interrupted_unit.new_jobs == 1
    first_job_id = conn.execute(
        "SELECT job_id FROM jobs WHERE url = ?",
        ("https://example.test/director-of-engineering/1",),
    ).fetchone()["job_id"]
    first_job_event_count = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE job_id = ?",
        (first_job_id,),
    ).fetchone()[0]

    result = jobspy.run_discovery(
        cfg=_config(),
        run_id="discovery:jobstreaming:retry",
        progress_callback=progress.append,
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="activity-attempt-2",
        adapter_registry=_registry(),
    )

    unit = repository.list_units(execution)[0]
    assert result["new"] == 2
    assert result["existing"] == 0
    assert result["raw_total"] == 2
    assert result["recovered_units"] == 1
    assert unit.state == "completed"
    assert unit.recovery_count == 1
    assert unit.accepted_jobs == 2
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    event_counts = conn.execute(
        """
        SELECT COUNT(*), COUNT(DISTINCT idempotency_key)
          FROM job_events
         WHERE idempotency_key LIKE 'jobstreaming:%'
        """
    ).fetchone()
    assert event_counts[0] == event_counts[1]
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE job_id = ?",
        (first_job_id,),
    ).fetchone()[0] == first_job_event_count
    assert any(
        snapshot["message"] == "Resuming interrupted JobStreaming search unit"
        for snapshot in progress
    )


def test_filtered_count_survives_loss_after_acknowledgement(
    discovery_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-filtered")
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    interrupted = False

    def interrupt_after_filtered_ack(self, checkpoint) -> None:
        nonlocal interrupted
        if checkpoint.revision == 2 and not interrupted:
            interrupted = True
            raise RuntimeError("simulated worker loss after filtered acknowledgement")
        original_save(self, checkpoint)

    monkeypatch.setattr(
        SqliteDiscoverySearchUnitCheckpointStore,
        "save",
        interrupt_after_filtered_ack,
    )

    with pytest.raises(
        RuntimeError,
        match="simulated worker loss after filtered acknowledgement",
    ):
        jobspy.run_discovery(
            cfg=_config(),
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="filtered-attempt-1",
            adapter_registry=_registry(indeed_factory=_FilteredIndeed),
        )

    repository = SqliteDiscoverySearchUnitRepository(conn)
    interrupted_unit = repository.list_units(execution)[0]
    assert interrupted_unit.state == "running"
    assert interrupted_unit.checkpoint_revision == 1
    assert repository.execution_filtered_count(execution) == 1

    result = jobspy.run_discovery(
        cfg=_config(),
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="filtered-attempt-2",
        adapter_registry=_registry(indeed_factory=_FilteredIndeed),
    )

    recovered = repository.list_units(execution)[0]
    assert result["new"] == 0
    assert result["filtered"] == 1
    assert result["raw_total"] == 1
    assert recovered.state == "completed"
    assert recovered.recovery_count == 1
    assert repository.execution_filtered_count(execution) == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_durable_new_job_limit_survives_an_unacknowledged_replay(
    discovery_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-limit")
    _SuccessfulIndeed.requests = []
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    interrupted = False

    def interrupt_first_job_ack(self, checkpoint) -> None:
        nonlocal interrupted
        if checkpoint.revision == 1 and not interrupted:
            interrupted = True
            raise RuntimeError("simulated worker loss")
        original_save(self, checkpoint)

    monkeypatch.setattr(
        SqliteDiscoverySearchUnitCheckpointStore,
        "save",
        interrupt_first_job_ack,
    )
    cfg = _config(
        queries=("Director of Engineering", "VP Engineering"),
    )

    with pytest.raises(RuntimeError, match="simulated worker loss"):
        jobspy.run_discovery(
            cfg=cfg,
            limit=1,
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="limit-attempt-1",
            adapter_registry=_registry(indeed_factory=_SuccessfulIndeed),
        )

    result = jobspy.run_discovery(
        cfg=cfg,
        limit=1,
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="limit-attempt-2",
        adapter_registry=_registry(indeed_factory=_SuccessfulIndeed),
    )

    units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
    assert result["new"] == 1
    assert result["existing"] == 0
    assert result["skipped_units"] == 2
    assert [unit.state for unit in units] == ["skipped", "skipped"]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert _SuccessfulIndeed.requests == [
        "Director of Engineering",
        "Director of Engineering",
    ]


def test_durable_limit_survives_loss_after_provider_ack_before_unit_skip(
    discovery_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-limit-after-ack")
    _PagedIndeed.requests = []
    original_mark_skipped = SqliteDiscoverySearchUnitRepository.mark_skipped
    interrupted = False

    def interrupt_first_skip(self, lease, **kwargs) -> None:
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise RuntimeError("simulated worker loss after provider ack")
        original_mark_skipped(self, lease, **kwargs)

    monkeypatch.setattr(
        SqliteDiscoverySearchUnitRepository,
        "mark_skipped",
        interrupt_first_skip,
    )

    with pytest.raises(RuntimeError, match="simulated worker loss after provider ack"):
        jobspy.run_discovery(
            cfg=_config(),
            limit=1,
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="post-ack-attempt-1",
            adapter_registry=_registry(),
        )

    repository = SqliteDiscoverySearchUnitRepository(conn)
    interrupted_unit = repository.list_units(execution)[0]
    assert interrupted_unit.state == "running"
    assert interrupted_unit.checkpoint_revision == 1
    assert interrupted_unit.new_jobs == 1

    result = jobspy.run_discovery(
        cfg=_config(),
        limit=1,
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="post-ack-attempt-2",
        adapter_registry=_registry(),
    )

    unit = repository.list_units(execution)[0]
    assert result["new"] == 1
    assert result["raw_total"] == 1
    assert unit.state == "skipped"
    assert unit.recovery_count == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


def test_cursor_reset_is_applied_only_after_error_ack_and_retry(
    discovery_db,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-cursor")
    _CursorThenPosting.calls = 0
    _CursorThenPosting.requests = []

    with pytest.raises(jobspy.DiscoveryResumeRequired):
        jobspy.run_discovery(
            cfg=_config(),
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="cursor-attempt-1",
            adapter_registry=_registry(indeed_factory=_CursorThenPosting),
        )

    repository = SqliteDiscoverySearchUnitRepository(conn)
    failed = repository.list_units(execution)[0]
    assert failed.state == "running"
    assert failed.reset_checkpoint is True
    assert failed.checkpoint_revision == 2

    result = jobspy.run_discovery(
        cfg=_config(),
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="cursor-attempt-2",
        adapter_registry=_registry(indeed_factory=_CursorThenPosting),
    )

    recovered = repository.list_units(execution)[0]
    assert result["new"] == 1
    assert recovered.state == "completed"
    assert recovered.reset_checkpoint is False
    assert recovered.reset_checkpoint_after_revision is None
    assert recovered.last_error_code is None
    assert recovered.recovery_count == 1
    assert result["failed_source_ids"] == []


def test_recoverable_board_failure_is_retried_after_healthy_partial_output(
    discovery_db,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-mixed-cursor")
    _SuccessfulIndeed.requests = []
    _CursorThenLinkedIn.calls = 0
    registry = AdapterRegistry()
    registry.register(Site.INDEED, _SuccessfulIndeed)
    registry.register(Site.LINKEDIN, _CursorThenLinkedIn)

    with pytest.raises(jobspy.DiscoveryResumeRequired):
        jobspy.run_discovery(
            cfg=_config(boards=("indeed", "linkedin")),
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="mixed-cursor-attempt-1",
            adapter_registry=registry,
        )

    result = jobspy.run_discovery(
        cfg=_config(boards=("indeed", "linkedin")),
        discovery_execution=execution,
        activity_attempt=2,
        activity_owner_token="mixed-cursor-attempt-2",
        adapter_registry=registry,
    )

    indeed_unit, linkedin_unit = SqliteDiscoverySearchUnitRepository(conn).list_units(
        execution
    )
    assert result["new"] == 2
    assert result["failed_source_ids"] == []
    assert indeed_unit.state == "completed"
    assert indeed_unit.recovery_count == 0
    assert linkedin_unit.state == "completed"
    assert linkedin_unit.recovery_count == 1
    assert linkedin_unit.last_error_code is None
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2


def test_incompatible_cursor_schema_fails_explicitly_without_resetting(
    discovery_db,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-cursor-schema")
    specs = jobspy._durable_search_specs(  # noqa: SLF001
        _config(),
        tiers=None,
        locations=None,
        sites=["indeed"],
        results_per_site=10,
        hours_old=72,
    )
    repository = SqliteDiscoverySearchUnitRepository(conn)
    repository.plan_units(execution, specs)
    seed_lease = repository.claim_next(execution, "schema-attempt-1", 1)
    assert seed_lease is not None
    provider_spec = jobspy._jobstreaming_spec(specs[0])  # noqa: SLF001
    checkpoint = SearchCheckpoint.for_request(
        JobStreamingGateway.build_request(provider_spec)
    )
    repository.checkpoint_store(seed_lease).save(checkpoint)
    incompatible_registry = AdapterRegistry()
    incompatible_registry.register(
        Site.INDEED,
        _SuccessfulIndeed,
        cursor_schema_version=2,
    )

    with pytest.raises(RuntimeError, match="JobStreaming failed for all"):
        jobspy.run_discovery(
            cfg=_config(),
            discovery_execution=execution,
            activity_attempt=2,
            activity_owner_token="schema-attempt-2",
            adapter_registry=incompatible_registry,
        )

    unit = repository.list_units(execution)[0]
    assert unit.state == "failed"
    assert unit.last_error_code == "indeed:checkpoint_incompatible"
    assert unit.last_error_type == "CheckpointCompatibilityError"
    assert unit.reset_checkpoint is False
    assert unit.checkpoint_revision == 0


def test_durable_plan_preserves_target_location_and_splits_glassdoor_request(
    discovery_db,
) -> None:
    _conn, _db_path = discovery_db
    cfg = _config(boards=("indeed", "linkedin", "glassdoor"))
    cfg["locations"] = [
        {
            "label": "barcelona",
            "location": "Barcelona, Catalonia, Spain",
            "remote": False,
        }
    ]
    cfg["glassdoor_location_map"] = {
        "Barcelona, Catalonia, Spain": "Barcelona",
    }

    specs = jobspy._durable_search_specs(  # noqa: SLF001
        cfg,
        tiers=None,
        locations=None,
        sites=["indeed", "linkedin", "glassdoor"],
        results_per_site=10,
        hours_old=72,
    )

    assert [spec.sites for spec in specs] == [
        ("indeed",),
        ("linkedin",),
        ("glassdoor",),
    ]
    assert [spec.provider_location for spec in specs] == [
        "Barcelona, Catalonia, Spain",
        "Barcelona, Catalonia, Spain",
        "Barcelona",
    ]
    assert all(
        spec.target_location == "Barcelona, Catalonia, Spain" for spec in specs
    )


def test_partial_board_success_is_retained_with_typed_failure_evidence(
    discovery_db,
) -> None:
    conn, _db_path = discovery_db
    execution = _execution("temporal-run-partial")
    _SuccessfulIndeed.requests = []

    result = jobspy.run_discovery(
        cfg=_config(boards=("indeed", "linkedin")),
        discovery_execution=execution,
        activity_attempt=1,
        activity_owner_token="partial-attempt-1",
        adapter_registry=_registry(
            linkedin=True,
            indeed_factory=_SuccessfulIndeed,
        ),
    )

    indeed_unit, linkedin_unit = SqliteDiscoverySearchUnitRepository(conn).list_units(
        execution
    )
    assert result["new"] == 1
    assert result["errors"] == 1
    assert result["failed_source_ids"] == ["jobspy:linkedin"]
    assert indeed_unit.state == "completed"
    assert linkedin_unit.state == "failed"
    assert linkedin_unit.last_error_code == "linkedin:invalid_request"
    assert linkedin_unit.last_error_type == "InvalidRequestError"


def test_cancellation_interrupts_provider_wait_and_terminalizes_all_units(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    init_db(db_path)
    close_connection(db_path)
    monkeypatch.setattr(jobspy, "init_db", lambda: init_db(db_path))
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    execution = _execution("temporal-run-cancel")
    cancel_event = threading.Event()
    _WaitingIndeed.started = threading.Event()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            jobspy.run_discovery,
            cfg=_config(
                queries=("Director of Engineering", "VP Engineering"),
            ),
            cancel_event=cancel_event,
            discovery_execution=execution,
            activity_attempt=1,
            activity_owner_token="cancel-attempt-1",
            adapter_registry=_registry(indeed_factory=_WaitingIndeed),
        )
        assert _WaitingIndeed.started.wait(timeout=5)
        cancel_event.set()
        with pytest.raises(jobspy.DiscoveryCancelled):
            future.result(timeout=2)

    conn = init_db(db_path)
    try:
        units = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)
        assert [unit.state for unit in units] == ["canceled", "canceled"]
    finally:
        close_connection(db_path)


@pytest.mark.asyncio
async def test_temporal_worker_loss_after_store_before_ack_reclaims_and_completes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest,
) -> None:
    """Kill the worker in the commit/ack gap and resume on a fresh worker."""

    db_path = tmp_path / "jobctrl.db"
    init_db(db_path)
    close_connection(db_path)
    monkeypatch.setattr(jobspy, "init_db", lambda: init_db(db_path))
    monkeypatch.setattr(jobspy, "get_shared_rate_limiter", _NoopLimiter)
    monkeypatch.setattr(
        "jobctrl.discovery.workflow._DEFAULT_HEARTBEAT_TIMEOUT",
        timedelta(seconds=2),
    )
    original_save = SqliteDiscoverySearchUnitCheckpointStore.save
    store_completed = threading.Event()
    release_lost_worker = threading.Event()

    def release_fixture() -> None:
        global _TEMPORAL_REGISTRY
        release_lost_worker.set()
        _TEMPORAL_REGISTRY = None

    request.addfinalizer(release_fixture)

    def block_first_attempt_ack(self, checkpoint) -> None:
        if self._lease.attempt == 1 and checkpoint.revision == 1:  # noqa: SLF001
            store_completed.set()
            if not release_lost_worker.wait(timeout=120):
                raise TimeoutError("lost worker fixture was not released")
        original_save(self, checkpoint)

    monkeypatch.setattr(
        SqliteDiscoverySearchUnitCheckpointStore,
        "save",
        block_first_attempt_ack,
    )
    _PagedIndeed.requests = []
    global _TEMPORAL_REGISTRY
    _TEMPORAL_REGISTRY = _registry()
    queue = f"jobstreaming-resume-{uuid.uuid4()}"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        first_worker = Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_temporal_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
            graceful_shutdown_timeout=timedelta(0),
            max_cached_workflows=0,
        )
        first_worker_run = asyncio.create_task(first_worker.run())
        handle = await env.client.start_workflow(
            DiscoverWorkflow.run,
            DiscoverWorkflowInput(tenant_id="local"),
            id=f"discover-jobstreaming-resume-{uuid.uuid4()}",
            task_queue=queue,
        )

        assert await asyncio.to_thread(store_completed.wait, 30)
        committed = init_db(db_path)
        try:
            assert (
                committed.execute(
                    "SELECT COUNT(*) FROM discovery_search_unit_jobs"
                ).fetchone()[0]
                == 1
            )
        finally:
            close_connection(db_path)

        first_worker_run.cancel()
        await asyncio.gather(first_worker_run, return_exceptions=True)

        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[DiscoverWorkflow],
            activities=_temporal_activities(),
            workflow_runner=UnsandboxedWorkflowRunner(),
            max_cached_workflows=0,
        ):
            result = await asyncio.wait_for(handle.result(), timeout=120)

        workflow_run_id = handle.first_execution_run_id
        assert workflow_run_id is not None
        release_lost_worker.set()
        await asyncio.sleep(0)

    conn = init_db(db_path)
    try:
        workflow_id = handle.id
        execution = DiscoveryExecutionRef(
            tenant_id="local",
            workflow_id=workflow_id,
            temporal_run_id=workflow_run_id,
        )
        unit = SqliteDiscoverySearchUnitRepository(conn).list_units(execution)[0]
        assert result.families_completed == ["jobspy"]
        assert result.families_failed == []
        assert unit.state == "completed"
        assert unit.recovery_count == 1
        assert unit.accepted_jobs == 2
        assert unit.new_jobs == 2
        assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    finally:
        close_connection(db_path)
        _TEMPORAL_REGISTRY = None
