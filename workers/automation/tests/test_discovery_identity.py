from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import ensure_source_observation_tables, init_db
from jobhunter.domain.discovery import (
    AtsKind,
    CanonicalJobIdentity,
    DuplicateJobLink,
    Employer,
    Job,
    JobMetadata,
    JobSourceObservation,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobhunter.domain.discovery.use_cases import DiscoverJobsUseCase, PostingAcceptance
from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.ports.discovery import ScrapedJobPosting
from jobhunter.domain.ports.events import EventHandler, Subscription
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.discovery import SqliteJobRepository


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


class RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[DomainEvent] = []

    def publish(self, event: DomainEvent) -> None:
        self.events.append(event)

    def subscribe(self, event_type: str | None, handler: EventHandler) -> Subscription:
        del event_type, handler
        return Subscription(lambda: None)


def _job(url: str = "https://boards.greenhouse.io/acme/jobs/123") -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        posting_url=PostingUrl(value=url),
        source=Source(board="greenhouse"),
        employer=Employer.unknown(),
        search_strategy=SearchStrategy.WORKDAY_API,
        metadata=JobMetadata(title="Platform Engineer", location="Remote"),
        discovered_at="2026-05-12T00:00:00Z",
    )


def _posting(
    *,
    canonical_url: str = "https://boards.greenhouse.io/acme/jobs/123",
    source_native_id: str = "123",
    source_id: str = "greenhouse:acme",
    ats_kind: AtsKind = AtsKind.GREENHOUSE,
    metadata: JobMetadata | None = None,
) -> ScrapedJobPosting:
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=canonical_url),
        source=Source(board="greenhouse"),
        metadata=metadata or JobMetadata(title="Platform Engineer", location="Remote"),
        strategy=SearchStrategy.WORKDAY_API,
        source_id=source_id,
        source_native_id=source_native_id,
        canonical_url=canonical_url,
        ats_kind=ats_kind,
    )


def test_source_observation_backfill_seeds_legacy_jobs(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    repo.save(_job())

    ensure_source_observation_tables(conn)

    row = conn.execute(
        """
        SELECT source_observation_id, job_url, source_id, source_native_id,
               observed_url, normalized_observed_url, run_id, observed_at
        FROM job_source_observations
        WHERE job_url = ?
        """,
        ("https://boards.greenhouse.io/acme/jobs/123",),
    ).fetchone()
    assert row is not None
    assert row["source_observation_id"] == "backfill:https://boards.greenhouse.io/acme/jobs/123"
    assert row["source_id"] == "greenhouse"
    assert row["source_native_id"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert row["observed_url"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert row["normalized_observed_url"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert row["run_id"] == "backfill"
    assert row["observed_at"] == "2026-05-12T00:00:00Z"


def test_load_by_url_resolves_observation_url_to_canonical_job(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _job()
    repo.save(job)
    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-1",
            source_id="linkedin",
            source_native_id="linkedin-123",
            observed_url="https://linkedin.example/jobs/123?utm_source=feed",
            run_id="run-1",
            observed_at="2026-05-12T00:00:00Z",
        ),
    )

    found = repo.load_by_url(
        LOCAL_TENANT,
        PostingUrl(value="https://linkedin.example/jobs/123?utm_campaign=ignored"),
    )

    assert found is not None
    assert found.job_id == job.job_id


def test_attach_source_observation_replaces_repeated_native_identity(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    job = _job()
    repo.save(job)

    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-1",
            source_id="greenhouse:acme",
            source_native_id="123",
            observed_url="https://boards.greenhouse.io/acme/jobs/123",
            run_id="run-1",
            observed_at="2026-05-12T00:00:00Z",
        ),
    )
    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-2",
            source_id="greenhouse:acme",
            source_native_id="123",
            observed_url="https://boards.greenhouse.io/acme/jobs/123?gh_src=tracking",
            run_id="run-2",
            observed_at="2026-05-13T00:00:00Z",
        ),
    )

    rows = conn.execute(
        """
        SELECT source_observation_id, source_id, source_native_id, run_id, observed_at
        FROM job_source_observations
        WHERE tenant_id = 'local'
        """
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["source_observation_id"] == "obs-2"
    assert rows[0]["source_id"] == "greenhouse:acme"
    assert rows[0]["source_native_id"] == "123"
    assert rows[0]["run_id"] == "run-2"
    assert rows[0]["observed_at"] == "2026-05-13T00:00:00Z"


def test_attach_source_observation_replaces_normalized_url_conflict(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    job = _job()
    repo.save(job)

    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-1",
            source_id="broad-board",
            source_native_id="board-123",
            observed_url="https://boards.greenhouse.io/acme/jobs/123?utm_source=board",
            run_id="run-1",
            observed_at="2026-05-12T00:00:00Z",
        ),
    )
    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-2",
            source_id="greenhouse:acme",
            source_native_id="123",
            observed_url="https://boards.greenhouse.io/acme/jobs/123?gh_src=tracking",
            run_id="run-2",
            observed_at="2026-05-13T00:00:00Z",
        ),
    )

    rows = conn.execute(
        """
        SELECT source_observation_id, source_id, source_native_id,
               normalized_observed_url, run_id
        FROM job_source_observations
        WHERE tenant_id = 'local'
        """
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["source_observation_id"] == "obs-2"
    assert rows[0]["source_id"] == "greenhouse:acme"
    assert rows[0]["source_native_id"] == "123"
    assert rows[0]["normalized_observed_url"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert rows[0]["run_id"] == "run-2"


def test_find_canonical_owner_resolves_native_identity_then_canonical_and_observation(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    job = _job()
    repo.save(job)
    repo.set_canonical_identity(
        LOCAL_TENANT,
        job.job_id,
        CanonicalJobIdentity(
            canonical_url="https://boards.greenhouse.io/acme/jobs/123",
            ats_kind=AtsKind.GREENHOUSE,
            source_native_id="123",
            confidence=0.9,
        ),
    )
    repo.attach_source_observation(
        LOCAL_TENANT,
        job.job_id,
        JobSourceObservation(
            source_observation_id="obs-1",
            source_id="greenhouse:acme",
            source_native_id="123",
            observed_url="https://boards.greenhouse.io/acme/jobs/123?gh_src=tracking",
            run_id="run-1",
            observed_at="2026-05-12T00:00:00Z",
        ),
    )

    assert (
        repo.find_canonical_owner(
            LOCAL_TENANT,
            source_id="greenhouse:acme",
            source_native_id="123",
            canonical_url="",
        )
        == job.job_id
    )
    assert (
        repo.find_canonical_owner(
            LOCAL_TENANT,
            source_id="ashby:acme",
            source_native_id="different",
            canonical_url="https://boards.greenhouse.io/acme/jobs/123",
        )
        == job.job_id
    )
    assert (
        repo.find_canonical_owner(
            LOCAL_TENANT,
            source_id="ashby:acme",
            source_native_id="different",
            canonical_url="https://boards.greenhouse.io/acme/jobs/123?gh_jid=123",
        )
        == job.job_id
    )


def test_duplicate_links_are_persisted(conn: sqlite3.Connection) -> None:
    repo = SqliteJobRepository(conn)
    job = _job()
    repo.save(job)

    repo.record_duplicate_link(
        LOCAL_TENANT,
        DuplicateJobLink(
            duplicate_link_id="dup-1",
            surviving_job_id=str(job.job_id),
            superseded_job_or_observation_id="obs-2",
            reason="canonical_url_match",
            confidence=0.91,
            linked_at="2026-05-12T00:00:00Z",
        ),
    )

    row = conn.execute(
        """
        SELECT surviving_job_id, superseded_job_or_observation_id, reason, confidence, linked_at
        FROM job_duplicate_links
        WHERE tenant_id = 'local' AND duplicate_link_id = 'dup-1'
        """
    ).fetchone()
    assert row is not None
    assert row["surviving_job_id"] == str(job.job_id)
    assert row["superseded_job_or_observation_id"] == "obs-2"
    assert row["reason"] == "canonical_url_match"
    assert row["confidence"] == 0.91
    assert row["linked_at"] == "2026-05-12T00:00:00Z"


def test_discover_jobs_use_case_creates_job_identity_and_first_observation(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    current_time = "2026-05-12T00:00:00Z"
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: current_time,
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[_posting()],
        run_id="run-1",
    )

    job_id = JobId("https://boards.greenhouse.io/acme/jobs/123")
    assert summary.total == 1
    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert repo.load(LOCAL_TENANT, job_id) is not None
    identity = repo.load_canonical_identity(LOCAL_TENANT, job_id)
    assert identity is not None
    assert identity.ats_kind is AtsKind.GREENHOUSE
    observations = repo.list_observations(LOCAL_TENANT, job_id)
    assert len(observations) == 1
    assert observations[0].source_id == "greenhouse:acme"
    assert [event.event_type for event in publisher.events] == [
        "JobDiscovered",
        "CanonicalJobIdentityResolved",
        "JobSourceObserved",
    ]
    assert publisher.events[-1].payload["run_id"] == "run-1"


def test_discover_jobs_use_case_observes_existing_job_and_links_duplicate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    current_time = "2026-05-12T00:00:00Z"
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: current_time,
    )
    use_case.execute(tenant_id=LOCAL_TENANT, postings=[_posting()], run_id="run-1")
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://boards.greenhouse.io/acme/jobs/duplicate-123",
                source_native_id="123",
            )
        ],
        run_id="run-2",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 1
    assert summary.duplicates_linked == 1
    assert summary.duplicates_rejected == 0
    assert [event.event_type for event in publisher.events] == [
        "JobSourceObserved",
        "DuplicateJobLinked",
    ]
    duplicate = publisher.events[-1]
    assert duplicate.payload["surviving_job_id"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert duplicate.payload["reason"] == "canonical_url_match"
    duplicate_row = conn.execute("SELECT reason FROM job_duplicate_links").fetchone()
    assert duplicate_row is not None
    assert duplicate_row["reason"] == "canonical_url_match"


def test_discover_jobs_use_case_resurfaces_soft_deleted_existing_job(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    current_time = "2026-05-12T00:00:00Z"
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: current_time,
    )
    use_case.execute(tenant_id=LOCAL_TENANT, postings=[_posting()], run_id="run-1")
    repo.soft_delete(
        LOCAL_TENANT,
        JobId("https://boards.greenhouse.io/acme/jobs/123"),
        reason="not relevant right now",
        deleted_at="2026-05-13T00:00:00Z",
    )
    publisher.events.clear()
    current_time = "2026-05-14T00:00:00Z"

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                metadata=JobMetadata(
                    title="Platform Engineering Manager",
                    description="Lead platform engineering teams in Spain.",
                    location="Barcelona, Spain",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 1
    resurfaced = repo.load(LOCAL_TENANT, JobId("https://boards.greenhouse.io/acme/jobs/123"))
    assert resurfaced is not None
    assert resurfaced.is_deleted is False
    assert resurfaced.metadata.title == "Platform Engineering Manager"
    assert resurfaced.metadata.description == "Lead platform engineering teams in Spain."
    assert resurfaced.metadata.location == "Barcelona, Spain"
    tombstone = conn.execute(
        "SELECT restored_at FROM jobhunter_deleted_jobs WHERE job_url = ?",
        ("https://boards.greenhouse.io/acme/jobs/123",),
    ).fetchone()
    assert tombstone is not None
    assert tombstone["restored_at"] == "2026-05-14T00:00:00Z"
    assert [event.event_type for event in publisher.events] == [
        "JobRestored",
        "JobSourceObserved",
    ]


def test_discover_jobs_use_case_rejects_new_policy_mismatches_without_creating_job(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        acceptance_policy=lambda _posting: PostingAcceptance.reject(
            reason="current_policy_mismatch",
            rejection_reasons=("location_mismatch",),
        ),
        clock=lambda: "2026-05-12T00:00:00Z",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.ashbyhq.com/acai/india",
                source_native_id="india",
                source_id="ashby:acai",
                ats_kind=AtsKind.ASHBY,
                metadata=JobMetadata(
                    title="Senior Software Engineer (India)",
                    description="Build distributed systems.",
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 0
    assert summary.duplicates_rejected == 0
    assert repo.load(LOCAL_TENANT, JobId("https://jobs.ashbyhq.com/acai/india")) is None
    assert publisher.events == []


def test_discover_jobs_use_case_soft_deletes_active_job_rejected_by_current_policy(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    use_case.execute(tenant_id=LOCAL_TENANT, postings=[_posting()], run_id="run-1")
    publisher.events.clear()
    policy_use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        acceptance_policy=lambda _posting: PostingAcceptance.reject(
            reason="current_policy_mismatch",
            rejection_reasons=("location_mismatch",),
        ),
        clock=lambda: "2026-05-15T00:00:00Z",
    )

    summary = policy_use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                metadata=JobMetadata(
                    title="Senior Software Engineer (India)",
                    description="Build distributed systems.",
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 0
    assert summary.duplicates_rejected == 0
    job = repo.load(LOCAL_TENANT, JobId("https://boards.greenhouse.io/acme/jobs/123"))
    assert job is not None
    assert job.is_deleted is True
    assert "location_mismatch" in (job.delete_reason or "")
    assert job.metadata.title == "Platform Engineer"
    observations = repo.list_observations(
        LOCAL_TENANT,
        JobId("https://boards.greenhouse.io/acme/jobs/123"),
    )
    assert [observation.run_id for observation in observations] == ["run-2"]
    assert [event.event_type for event in publisher.events] == [
        "JobDeleted",
        "JobSourceObserved",
    ]


def test_discover_jobs_use_case_keeps_policy_rejected_deleted_job_hidden(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    job_id = JobId("https://boards.greenhouse.io/acme/jobs/123")
    use_case.execute(tenant_id=LOCAL_TENANT, postings=[_posting()], run_id="run-1")
    repo.soft_delete(
        LOCAL_TENANT,
        job_id,
        reason="discovery hygiene rejected ashby:acai: location_mismatch",
        deleted_at="2026-05-13T00:00:00Z",
    )
    publisher.events.clear()
    policy_use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        acceptance_policy=lambda _posting: PostingAcceptance.reject(
            reason="current_policy_mismatch",
            rejection_reasons=("location_mismatch",),
        ),
        clock=lambda: "2026-05-15T00:00:00Z",
    )

    summary = policy_use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                metadata=JobMetadata(
                    title="Senior Software Engineer (India)",
                    description="Build distributed systems.",
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 0
    assert summary.duplicates_rejected == 0
    hidden = repo.load(LOCAL_TENANT, job_id)
    assert hidden is not None
    assert hidden.is_deleted is True
    assert hidden.metadata.title == "Platform Engineer"
    tombstone = conn.execute(
        "SELECT restored_at FROM jobhunter_deleted_jobs WHERE job_url = ?",
        (str(job_id),),
    ).fetchone()
    assert tombstone is not None
    assert tombstone["restored_at"] is None
    observations = repo.list_observations(LOCAL_TENANT, job_id)
    assert [observation.run_id for observation in observations] == ["run-2"]
    assert [event.event_type for event in publisher.events] == ["JobSourceObserved"]


def test_discover_jobs_use_case_preserves_existing_salary_when_rediscovery_is_blank(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                metadata=JobMetadata(
                    title="Director of Engineering",
                    salary="$180,000",
                    description="Lead engineering teams.",
                    location="Barcelona, Spain",
                )
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                metadata=JobMetadata(
                    title="Director of Engineering",
                    salary="",
                    description="Lead engineering teams in Spain.",
                    location="Barcelona, Spain",
                )
            )
        ],
        run_id="run-2",
    )

    assert summary.observed == 1
    rediscovered = repo.load(LOCAL_TENANT, JobId("https://boards.greenhouse.io/acme/jobs/123"))
    assert rediscovered is not None
    assert rediscovered.metadata.salary == "$180,000"
    assert rediscovered.metadata.description == "Lead engineering teams in Spain."


def test_discover_jobs_use_case_rejects_low_confidence_duplicate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()

    def resolver(posting: ScrapedJobPosting) -> CanonicalJobIdentity:
        confidence = 0.9
        if posting.canonical_url.endswith("low-confidence"):
            confidence = 0.6
        return CanonicalJobIdentity(
            canonical_url=posting.canonical_url,
            ats_kind=posting.ats_kind,
            source_native_id=posting.source_native_id,
            confidence=confidence,
        )

    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        resolver=resolver,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    use_case.execute(tenant_id=LOCAL_TENANT, postings=[_posting()], run_id="run-1")
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://boards.greenhouse.io/acme/jobs/low-confidence",
                source_native_id="123",
            )
        ],
        run_id="run-2",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert summary.duplicates_rejected == 1
    assert [event.event_type for event in publisher.events] == ["DuplicateJobLinkRejected"]
    rejected = publisher.events[0]
    assert rejected.payload["candidate_ids"][0] == "https://boards.greenhouse.io/acme/jobs/123"
    assert rejected.payload["reason"] == "confidence_below_threshold"
    assert (
        repo.list_observations(
            LOCAL_TENANT,
            JobId("https://boards.greenhouse.io/acme/jobs/123"),
        )[0].run_id
        == "run-1"
    )
