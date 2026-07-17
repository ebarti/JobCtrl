from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest
from jobstreaming import CheckpointConflictError, SearchCheckpoint, build_search_request

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery import (
    AtsKind,
    CanonicalJobIdentity,
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.search_units import DiscoverySearchSpec
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.discovery.jobspy import store_jobspy_results
from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository
from jobctrl.infrastructure.discovery.sqlite_repository import SqliteJobRepository
from jobctrl.infrastructure.discovery.sqlite_search_unit_repository import (
    DiscoverySearchPlanConflict,
    SqliteDiscoverySearchUnitRepository,
    StaleDiscoverySearchUnitLease,
)


def _execution() -> DiscoveryExecutionRef:
    return DiscoveryExecutionRef(
        tenant_id="local",
        workflow_id="discover-local",
        temporal_run_id="temporal-run-1",
    )


def _spec(*, query: str = "Director of Engineering") -> DiscoverySearchSpec:
    return DiscoverySearchSpec(
        query=query,
        provider_location="Barcelona, Spain",
        target_location="Barcelona, Spain",
        sites=("indeed", "linkedin"),
        results_per_site=25,
        hours_old=72,
        remote_only=True,
        country_indeed="spain",
        linkedin_fetch_description=True,
        match_mode="recall",
        target_track="engineering_leadership",
        seniority_floor="director",
        accept_locations=("Barcelona, Spain", "Europe"),
        reject_locations=("United States",),
        local_accept_locations=("Barcelona, Spain",),
    )


@pytest.fixture
def search_db(tmp_path: Path):
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        yield conn
    finally:
        close_connection(db_path)


def test_search_spec_round_trips_with_stable_fingerprint() -> None:
    spec = _spec()

    restored = DiscoverySearchSpec.from_json(spec.to_json())

    assert restored == spec
    assert restored.fingerprint() == spec.fingerprint()
    assert "proxy" not in restored.to_payload()


def test_execution_plan_is_idempotent_but_cannot_be_rewritten(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    specs = [_spec(), _spec(query="VP Engineering")]

    first = repository.plan_units(execution, specs, created_at="2026-07-17T10:00:00+00:00")
    replay = repository.plan_units(execution, specs, created_at="2026-07-17T11:00:00+00:00")

    assert [unit.unit_id for unit in first] == [unit.unit_id for unit in replay]
    assert [unit.ordinal for unit in replay] == [0, 1]
    assert all(unit.state == "pending" for unit in replay)
    assert all(unit.created_at == "2026-07-17T10:00:00+00:00" for unit in replay)

    with pytest.raises(DiscoverySearchPlanConflict):
        repository.plan_units(execution, [_spec(query="Changed after retry")])

    assert [unit.spec for unit in repository.list_units(execution)] == specs


def test_checkpoint_save_is_compare_and_swap_and_reclaim_fences_old_owner(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec()])
    first_lease = repository.claim_next(execution, "activity-attempt-1", 1)
    assert first_lease is not None
    first_store = repository.checkpoint_store(first_lease)
    competing_store = repository.checkpoint_store(first_lease)
    request = build_search_request(
        site_name=["indeed", "linkedin"],
        search_term="Director of Engineering",
        location="Barcelona, Spain",
        results_wanted=25,
        country_indeed="spain",
    )
    initial = SearchCheckpoint.for_request(request)

    first_store.save(initial)
    loaded_once = first_store.load()
    loaded_twice = competing_store.load()
    assert loaded_once is not None and loaded_twice is not None
    first_store.save(loaded_once.model_copy(update={"revision": 1}))
    with pytest.raises(CheckpointConflictError):
        competing_store.save(loaded_twice.model_copy(update={"revision": 1}))

    second_lease = repository.claim_next(execution, "activity-attempt-2", 2)
    assert second_lease is not None
    assert second_lease.epoch == first_lease.epoch + 1
    with pytest.raises(StaleDiscoverySearchUnitLease):
        first_store.load()

    resumed = repository.checkpoint_store(second_lease).load()
    assert resumed is not None
    assert resumed.revision == 1
    unit = repository.get_unit(execution, second_lease.unit_id)
    assert unit is not None
    assert unit.recovery_count == 1
    assert unit.recovered is True
    assert unit.lease_attempt == 2

    with pytest.raises(StaleDiscoverySearchUnitLease):
        repository.claim_next(execution, "activity-attempt-1-late", 1)
    current = repository.get_unit(execution, second_lease.unit_id)
    assert current is not None
    assert current.lease_owner == "activity-attempt-2"
    assert current.lease_attempt == 2
    assert current.lease_epoch == second_lease.epoch


def test_retryable_failure_defers_cursor_reset_until_reclaimed(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec()])
    lease = repository.claim_next(execution, "attempt-1", 1)
    assert lease is not None
    checkpoint = SearchCheckpoint.for_request(
        build_search_request(
            site_name="indeed",
            search_term="Director of Engineering",
            location="Barcelona, Spain",
        )
    )
    repository.checkpoint_store(lease).save(checkpoint)

    repository.record_failure(
        lease,
        error_code="cursor_expired",
        error_type="CursorExpiredError",
        retryable=True,
        reset_checkpoint=True,
        failed_at="2026-07-17T10:05:00+00:00",
    )

    failed = repository.get_unit(execution, lease.unit_id)
    assert failed is not None
    assert failed.state == "running"
    assert failed.checkpoint_revision == 0
    assert failed.last_error_code == "cursor_expired"
    assert failed.last_error_retryable is True
    assert failed.reset_checkpoint is True
    assert failed.reset_checkpoint_after_revision == 1
    assert repository.reset_checkpoint_if_requested(lease) is False

    # JobStreaming acknowledges the persisted ErrorEvent against the current
    # revision before the next activity attempt applies the requested reset.
    repository.checkpoint_store(lease).save(checkpoint.model_copy(update={"revision": 1}))
    acknowledged = repository.get_unit(execution, lease.unit_id)
    assert acknowledged is not None
    assert acknowledged.checkpoint_revision == 1
    assert acknowledged.reset_checkpoint is True

    retry = repository.claim_next(execution, "attempt-2", 2)
    assert retry is not None
    assert retry.epoch == 2
    assert repository.reset_checkpoint_if_requested(retry) is True
    assert repository.checkpoint_store(retry).load() is None
    reset = repository.get_unit(execution, retry.unit_id)
    assert reset is not None
    assert reset.reset_checkpoint is False
    assert repository.reset_checkpoint_if_requested(retry) is False


def test_unacknowledged_cursor_reset_intent_does_not_clear_on_reclaim(
    search_db,
) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec()])
    first = repository.claim_next(execution, "attempt-1", 1)
    assert first is not None
    checkpoint = SearchCheckpoint.for_request(
        build_search_request(
            site_name="indeed",
            search_term="Director of Engineering",
            location="Barcelona, Spain",
        )
    )
    repository.checkpoint_store(first).save(checkpoint)
    repository.record_failure(
        first,
        error_code="cursor_expired",
        error_type="CursorExpiredError",
        retryable=False,
        reset_checkpoint=True,
        terminal=False,
    )

    reclaimed = repository.claim_next(execution, "attempt-2", 2)
    assert reclaimed is not None
    assert repository.reset_checkpoint_if_requested(reclaimed) is False
    still_present = repository.checkpoint_store(reclaimed).load()
    assert still_present is not None
    assert still_present.revision == 0

    repository.record_failure(
        reclaimed,
        error_code="cursor_expired",
        error_type="CursorExpiredError",
        retryable=False,
        reset_checkpoint=True,
        terminal=False,
    )
    repository.checkpoint_store(reclaimed).save(
        still_present.model_copy(update={"revision": 1})
    )
    next_attempt = repository.claim_next(execution, "attempt-3", 3)
    assert next_attempt is not None
    assert repository.reset_checkpoint_if_requested(next_attempt) is True
    assert repository.checkpoint_store(next_attempt).load() is None


def test_v4_search_unit_table_migrates_reset_ack_revision(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "v4-jobctrl.db"
    conn = init_db(db_path)
    conn.execute(
        """
        ALTER TABLE discovery_search_units
        DROP COLUMN reset_checkpoint_after_revision
        """
    )
    conn.execute("PRAGMA user_version = 4")
    conn.commit()
    close_connection(db_path)

    migrated = init_db(db_path)
    try:
        columns = {
            str(row[1])
            for row in migrated.execute(
                "PRAGMA table_info(discovery_search_units)"
            ).fetchall()
        }
        assert "reset_checkpoint_after_revision" in columns
        assert migrated.execute("PRAGMA user_version").fetchone()[0] == 5
    finally:
        close_connection(db_path)


def test_execution_attempt_watermark_fences_old_owner_from_pending_unit(
    search_db,
) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(
        execution,
        [_spec(), _spec(query="VP Engineering"), _spec(query="CTO")],
    )
    first = repository.claim_next(execution, "attempt-1", 1)
    assert first is not None
    repository.mark_completed(first)
    second = repository.claim_next(execution, "attempt-2", 2)
    assert second is not None
    repository.mark_completed(second)

    with pytest.raises(StaleDiscoverySearchUnitLease):
        repository.claim_next(execution, "attempt-1-late", 1)

    third = repository.claim_next(execution, "attempt-2", 2)
    assert third is not None
    assert third.attempt == 2
    assert [unit.state for unit in repository.list_units(execution)] == [
        "completed",
        "completed",
        "running",
    ]


def test_terminal_failure_and_cancel_are_not_reclaimed(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec(), _spec(query="VP Engineering")])
    failed_lease = repository.claim_next(execution, "attempt-1", 1)
    assert failed_lease is not None
    repository.record_failure(
        failed_lease,
        error_code="invalid_request",
        error_type="InvalidRequestError",
        retryable=False,
        reset_checkpoint=False,
    )
    canceled_lease = repository.claim_next(execution, "attempt-1", 1)
    assert canceled_lease is not None
    repository.mark_canceled(canceled_lease)

    assert repository.claim_next(execution, "attempt-2", 2) is None
    assert [unit.state for unit in repository.list_units(execution)] == [
        "failed",
        "canceled",
    ]


def test_late_cancel_from_stale_attempt_cannot_cancel_new_owner(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(execution, [_spec(), _spec(query="VP Engineering")])
    stale = repository.claim_next(execution, "attempt-1", 1)
    assert stale is not None
    current = repository.claim_next(execution, "attempt-2", 2)
    assert current is not None

    with pytest.raises(StaleDiscoverySearchUnitLease):
        repository.mark_execution_canceled(stale)

    units = repository.list_units(execution)
    assert [unit.state for unit in units] == ["running", "pending"]
    assert units[0].lease_owner == "attempt-2"


def test_result_limit_marks_only_unclaimed_units_skipped(search_db) -> None:
    repository = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    repository.plan_units(
        execution,
        [_spec(), _spec(query="VP Engineering"), _spec(query="CTO")],
    )
    active_lease = repository.claim_next(execution, "attempt-1", 1)
    assert active_lease is not None

    skipped = repository.mark_pending_skipped(
        execution,
        skipped_at="2026-07-17T10:05:00+00:00",
    )

    assert skipped == 2
    assert [unit.state for unit in repository.list_units(execution)] == [
        "running",
        "skipped",
        "skipped",
    ]
    assert repository.claim_next(execution, "attempt-2", 2) is not None


def test_job_write_and_new_receipt_share_the_fenced_repository_path(search_db) -> None:
    search_units = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    search_units.plan_units(execution, [_spec()])
    first_lease = search_units.claim_next(execution, "attempt-1", 1)
    assert first_lease is not None
    jobs = SqliteJobRepository(
        search_db,
        discovery_execution=execution,
        source_family="jobspy",
        search_unit_lease=first_lease,
    )
    discovered_at = "2026-07-17T10:00:00+00:00"
    job = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.test/jobs/1"),
        posting_url=PostingUrl(value="https://example.test/jobs/1"),
        source=Source(board="indeed"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(
            title="Director of Engineering",
            description="Lead the engineering organization.",
            location="Barcelona, Spain",
        ),
        discovered_at=discovered_at,
    )

    jobs.save(job)
    jobs.save(job)

    unit = search_units.get_unit(execution, first_lease.unit_id)
    assert unit is not None
    assert unit.accepted_jobs == 1
    assert unit.new_jobs == 1
    assert unit.existing_jobs == 0
    assert search_units.execution_counts(execution) == {
        "accepted": 1,
        "new": 1,
        "existing": 0,
    }

    second_lease = search_units.claim_next(execution, "attempt-2", 2)
    assert second_lease is not None
    stale_jobs = SqliteJobRepository(
        search_db,
        discovery_execution=execution,
        source_family="jobspy",
        search_unit_lease=first_lease,
    )
    stale_job = Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.test/jobs/stale"),
        posting_url=PostingUrl(value="https://example.test/jobs/stale"),
        source=Source(board="indeed"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(
            title="Stale attempt",
            description="This write must be fenced.",
            location="Remote",
        ),
        discovered_at=discovered_at,
    )

    with pytest.raises(StaleDiscoverySearchUnitLease):
        stale_jobs.save(stale_job)
    with pytest.raises(StaleDiscoverySearchUnitLease):
        stale_jobs.set_canonical_identity(
            LOCAL_TENANT,
            job.job_id,
            CanonicalJobIdentity(
                canonical_url=job.posting_url.value,
                ats_kind=AtsKind.OTHER,
                source_native_id="stale-native-id",
                confidence=1.0,
            ),
        )
    assert (
        search_db.execute("SELECT 1 FROM jobs WHERE url = ?", ("https://example.test/jobs/stale",)).fetchone() is None
    )


def test_jobspy_storage_records_new_receipt_once_across_replay(search_db) -> None:
    search_units = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    search_units.plan_units(execution, [_spec()])
    lease = search_units.claim_next(execution, "attempt-1", 1)
    assert lease is not None
    frame = pd.DataFrame(
        [
            {
                "id": "indeed-1",
                "job_url": "https://example.test/jobs/jobstreaming-1",
                "job_url_direct": "https://boards.greenhouse.io/example/jobs/12345",
                "title": "Director of Engineering",
                "company": "Example",
                "description": "Lead engineering, platform, security, and delivery. " * 8,
                "location": "Barcelona, Spain",
                "site": "indeed",
                "is_remote": True,
            }
        ]
    )
    search_cfg = {
        "queries": [{"query": "Director of Engineering"}],
        "locations": [{"location": "Barcelona, Spain", "remote": True}],
        "location_accept": ["Barcelona, Spain", "Spain", "Europe"],
        "location": {
            "accept_patterns": ["Barcelona, Spain", "Spain", "Europe"],
            "reject_patterns": [],
        },
    }

    first = store_jobspy_results(
        search_db,
        frame,
        "Director of Engineering",
        run_id="discovery:jobspy:first",
        search_cfg=search_cfg,
        discovery_execution=execution,
        search_unit_lease=lease,
    )
    first_events = {
        str(row[0]): int(row[1])
        for row in search_db.execute(
            """
            SELECT event_type, COUNT(*)
              FROM job_events
             WHERE job_url = ?
             GROUP BY event_type
            """,
            ("https://example.test/jobs/jobstreaming-1",),
        ).fetchall()
    }
    replay = store_jobspy_results(
        search_db,
        frame,
        "Director of Engineering",
        run_id="discovery:jobspy:retry",
        search_cfg=search_cfg,
        discovery_execution=execution,
        search_unit_lease=lease,
    )

    assert first == (1, 0)
    assert replay == (0, 1)
    replay_events = {
        str(row[0]): int(row[1])
        for row in search_db.execute(
            """
            SELECT event_type, COUNT(*)
              FROM job_events
             WHERE job_url = ?
             GROUP BY event_type
            """,
            ("https://example.test/jobs/jobstreaming-1",),
        ).fetchall()
    }
    assert replay_events == first_events
    assert first_events["JobMetadataUpdated"] == 1
    assert search_db.execute(
        """
        SELECT COUNT(*)
          FROM job_events
         WHERE job_url = ?
           AND idempotency_key LIKE 'jobstreaming:%'
        """,
        ("https://example.test/jobs/jobstreaming-1",),
    ).fetchone()[0] == sum(first_events.values())
    assert search_units.execution_counts(execution) == {
        "accepted": 1,
        "new": 1,
        "existing": 0,
    }


def test_mid_event_supersession_is_fenced_and_retry_repairs_audit_rows(
    search_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    search_units = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    search_units.plan_units(execution, [_spec()])
    first_lease = search_units.claim_next(execution, "attempt-1", 1)
    assert first_lease is not None
    frame = pd.DataFrame(
        [
            {
                "id": "indeed-mid-event",
                "job_url": "https://example.test/jobs/mid-event",
                "title": "Director of Engineering",
                "company": "Example",
                "description": "Lead engineering, platform, security, and delivery. " * 8,
                "location": "Barcelona, Spain",
                "site": "indeed",
                "is_remote": True,
            }
        ]
    )
    search_cfg = {
        "queries": [{"query": "Director of Engineering"}],
        "locations": [{"location": "Barcelona, Spain", "remote": True}],
        "location_accept": ["Barcelona, Spain", "Spain", "Europe"],
        "location": {
            "accept_patterns": ["Barcelona, Spain", "Spain", "Europe"],
            "reject_patterns": [],
        },
    }
    original_set_identity = SqliteJobRepository.set_canonical_identity
    reclaimed: list = []

    def reclaim_before_identity(self, tenant_id, job_id, identity):
        if not reclaimed:
            next_lease = search_units.claim_next(execution, "attempt-2", 2)
            assert next_lease is not None
            reclaimed.append(next_lease)
        return original_set_identity(self, tenant_id, job_id, identity)

    monkeypatch.setattr(
        SqliteJobRepository,
        "set_canonical_identity",
        reclaim_before_identity,
    )

    with pytest.raises(StaleDiscoverySearchUnitLease):
        store_jobspy_results(
            search_db,
            frame,
            "Director of Engineering",
            run_id="discovery:jobspy:interrupted",
            search_cfg=search_cfg,
            discovery_execution=execution,
            search_unit_lease=first_lease,
        )

    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM jobs WHERE url = ?",
            ("https://example.test/jobs/mid-event",),
        ).fetchone()[0]
        == 1
    )
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_canonical_identities WHERE job_url = ?",
            ("https://example.test/jobs/mid-event",),
        ).fetchone()[0]
        == 0
    )
    assert reclaimed

    resumed = store_jobspy_results(
        search_db,
        frame,
        "Director of Engineering",
        run_id="discovery:jobspy:resumed",
        search_cfg=search_cfg,
        discovery_execution=execution,
        search_unit_lease=reclaimed[0],
    )

    assert resumed == (0, 1)
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_canonical_identities WHERE job_url = ?",
            ("https://example.test/jobs/mid-event",),
        ).fetchone()[0]
        == 1
    )
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_source_observations WHERE job_url = ?",
            ("https://example.test/jobs/mid-event",),
        ).fetchone()[0]
        == 1
    )
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ?",
            ("https://example.test/jobs/mid-event",),
        ).fetchone()[0]
        == 4
    )
    assert search_units.execution_counts(execution) == {
        "accepted": 1,
        "new": 1,
        "existing": 0,
    }


def test_compensation_event_rechecks_fence_after_fact_commit(search_db) -> None:
    job_url = "https://example.test/jobs/compensation-fence"
    search_db.execute(
        """
        INSERT INTO jobs (url, title, salary, description, location, site, strategy)
        VALUES (?, 'Director of Engineering', 'EUR 150000/year',
                'Lead engineering.', 'Barcelona, Spain', 'indeed', 'jobspy')
        """,
        (job_url,),
    )
    search_db.commit()
    search_units = SqliteDiscoverySearchUnitRepository(search_db)
    execution = _execution()
    search_units.plan_units(execution, [_spec()])
    first_lease = search_units.claim_next(execution, "attempt-1", 1)
    assert first_lease is not None
    compensation = SqlitePostedCompensationRepository(search_db)
    reclaimed: list = []

    def supersede_before_event() -> None:
        next_lease = search_units.claim_next(execution, "attempt-2", 2)
        assert next_lease is not None
        reclaimed.append(next_lease)
        search_units.fence_write(first_lease)

    with pytest.raises(StaleDiscoverySearchUnitLease):
        compensation.parse_and_save_job_salary(
            job_url,
            "EUR 150000/year",
            parsed_at="2026-07-17T10:00:00+00:00",
            event_idempotency_key="jobstreaming:test:CompensationFactsUpdated",
            event_write_fence=supersede_before_event,
        )

    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_posted_compensation_facts WHERE job_url = ?",
            (job_url,),
        ).fetchone()[0]
        == 1
    )
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ?",
            (job_url,),
        ).fetchone()[0]
        == 0
    )
    assert reclaimed

    compensation.parse_and_save_job_salary(
        job_url,
        "EUR 150000/year",
        parsed_at="2026-07-17T10:01:00+00:00",
        event_idempotency_key="jobstreaming:test:CompensationFactsUpdated",
        event_write_fence=lambda: search_units.fence_write(reclaimed[0]),
    )
    assert (
        search_db.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ?",
            (job_url,),
        ).fetchone()[0]
        == 1
    )
