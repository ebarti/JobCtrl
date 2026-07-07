from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import ensure_source_observation_tables, init_db
from jobctrl.domain.discovery import (
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
from jobctrl.domain.discovery.use_cases import DiscoverJobsUseCase, PostingAcceptance
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.job_content_identity import is_genuine_employer_identity
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.ports.events import EventHandler, Subscription
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import SqliteJobRepository
from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


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
    board: str = "greenhouse",
    metadata: JobMetadata | None = None,
) -> ScrapedJobPosting:
    return ScrapedJobPosting(
        posting_url=PostingUrl(value=canonical_url),
        source=Source(board=board),
        metadata=metadata or JobMetadata(title="Platform Engineer", location="Remote"),
        strategy=SearchStrategy.WORKDAY_API,
        source_id=source_id,
        source_native_id=source_native_id,
        canonical_url=canonical_url,
        ats_kind=ats_kind,
    )


def _seed_jobspy_job(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str,
    company: str,
    description: str,
    site: str = "linkedin",
    source_id: str = "jobspy:linkedin",
    source_native_id: str = "linkedin-1",
    discovered_at: str = "2026-05-10T00:00:00Z",
) -> None:
    """Seed a job the way JobSpy persists it: company column set, board in ``site``."""

    conn.execute(
        "INSERT INTO jobs (url, title, company, salary, description, location, site, strategy, discovered_at) "
        "VALUES (?, ?, ?, '', ?, 'Remote', ?, 'jobspy', ?)",
        (url, title, company, description, site, discovered_at),
    )
    conn.commit()
    SqliteJobRepository(conn).attach_source_observation(
        LOCAL_TENANT,
        JobId(url),
        JobSourceObservation(
            source_observation_id="obs-jobspy-1",
            source_id=source_id,
            source_native_id=source_native_id,
            observed_url=url,
            run_id="run-jobspy",
            observed_at=discovered_at,
        ),
    )


def _long_description(marker: str, tokens: int = 90) -> str:
    return " ".join(f"{marker}{index}" for index in range(tokens))


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
        "SELECT restored_at FROM jobctrl_deleted_jobs WHERE job_url = ?",
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
        "SELECT restored_at FROM jobctrl_deleted_jobs WHERE job_url = ?",
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

    compensation_repo = SqlitePostedCompensationRepository(conn)
    compensation_repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = compensation_repo.get_fact(str(LOCAL_TENANT), str(rediscovered.job_id))
    assert fact is not None
    assert fact.legacy_raw_salary == "$180,000"
    assert fact.minimum_amount == 180_000


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
    assert rejected.payload["job_id"] == "https://boards.greenhouse.io/acme/jobs/123"
    assert rejected.payload["candidate_job_id"] == "https://boards.greenhouse.io/acme/jobs/low-confidence"
    assert rejected.payload["reason"] == "confidence_below_threshold"
    assert (
        repo.list_observations(
            LOCAL_TENANT,
            JobId("https://boards.greenhouse.io/acme/jobs/123"),
        )[0].run_id
        == "run-1"
    )


def test_discover_jobs_use_case_collapses_jobspy_job_rediscovered_by_canonical_source(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    description = "Lead the platform engineering group building local-first developer tooling."
    survivor = "https://www.linkedin.com/jobs/view/1001"
    _seed_jobspy_job(
        conn,
        url=survivor,
        title="Staff Platform Engineer",
        company="Acme",
        description=description,
    )
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://acme.wd1.myworkdayjobs.com/External/job/Staff-Platform-Engineer_JR-1",
                source_native_id="JR-1",
                source_id="workday:acme",
                ats_kind=AtsKind.WORKDAY,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-workday",
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 1
    assert summary.duplicates_linked == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    observations = repo.list_observations(LOCAL_TENANT, JobId(survivor))
    assert sorted(observation.source_id for observation in observations) == [
        "jobspy:linkedin",
        "workday:acme",
    ]
    link = conn.execute(
        "SELECT surviving_job_id, reason, confidence FROM job_duplicate_links"
    ).fetchone()
    assert link["surviving_job_id"] == survivor
    assert link["reason"] == "content_fingerprint_match"
    assert link["confidence"] == 0.95
    assert [event.event_type for event in publisher.events] == [
        "JobSourceObserved",
        "DuplicateJobLinked",
    ]


def test_discover_jobs_use_case_collapses_reworded_cross_source_description(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    base_description = _long_description("resp", tokens=90)
    reworded_description = base_description + " " + _long_description("extra", tokens=5)
    survivor = "https://boards.greenhouse.io/acme/jobs/staff-eng"

    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url=survivor,
                source_native_id="gh-1",
                source_id="greenhouse:acme",
                ats_kind=AtsKind.GREENHOUSE,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=base_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-greenhouse",
    )
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.lever.co/acme/staff-platform-engineer",
                source_native_id="lever-1",
                source_id="lever:acme",
                ats_kind=AtsKind.LEVER,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=reworded_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-lever",
    )

    assert summary.new_jobs == 0
    assert summary.observed == 1
    assert summary.duplicates_linked == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    assert (
        repo.load(
            LOCAL_TENANT,
            JobId("https://jobs.lever.co/acme/staff-platform-engineer"),
        ).job_id
        == JobId(survivor)
    )
    link = conn.execute(
        "SELECT surviving_job_id, reason, confidence FROM job_duplicate_links"
    ).fetchone()
    assert link["surviving_job_id"] == survivor
    assert link["reason"] == "content_shingle_match"
    assert link["confidence"] == 0.85


def test_discover_jobs_use_case_matches_fresh_listing_against_enriched_owner(
    conn: sqlite3.Connection,
) -> None:
    """A fresh listing must still collapse onto an already-enriched owner.

    Discovery stores the board LISTING in ``jobs.description``; enrichment writes
    a much longer full text to ``job_enrichments.full_description``. Comparing an
    incoming listing only against the enriched text drops below the shingle
    threshold, so cross-source dedup silently stopped working post-enrichment.
    The match must compare the incoming listing against the stored LISTING text
    like-for-like (this test fails on the pre-fix tip, which compared against the
    enriched text alone: reworded-vs-enriched Jaccard 0.66 < 0.83 threshold).
    """
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    listing = _long_description("resp", tokens=90)
    enriched = listing + " " + _long_description("bene", tokens=40)
    second_source_listing = listing + " " + _long_description("extra", tokens=5)
    survivor = "https://boards.greenhouse.io/acme/jobs/staff-eng"

    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url=survivor,
                source_native_id="gh-1",
                source_id="greenhouse:acme",
                ats_kind=AtsKind.GREENHOUSE,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=listing,
                    location="Remote",
                ),
            )
        ],
        run_id="run-greenhouse",
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            job_url, tenant_id, current_status, full_description,
            enriched_at, updated_at
        ) VALUES (?, 'local', 'enriched', ?, ?, ?)
        """,
        (survivor, enriched, "2026-05-12T01:00:00Z", "2026-05-12T01:00:00Z"),
    )
    conn.commit()
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.lever.co/acme/staff-platform-engineer",
                source_native_id="lever-1",
                source_id="lever:acme",
                ats_kind=AtsKind.LEVER,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=second_source_listing,
                    location="Remote",
                ),
            )
        ],
        run_id="run-lever",
    )

    assert summary.new_jobs == 0
    assert summary.observed == 1
    assert summary.duplicates_linked == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    link = conn.execute(
        "SELECT surviving_job_id, reason, confidence FROM job_duplicate_links"
    ).fetchone()
    assert link["surviving_job_id"] == survivor
    assert link["reason"] == "content_shingle_match"
    assert link["confidence"] == 0.85


def test_discover_jobs_use_case_keeps_accepted_owner_when_content_duplicate_rejected(
    conn: sqlite3.Connection,
) -> None:
    """A rejected cross-source content duplicate must not delete the accepted owner.

    An employer posts the same role in two locations. The accepted "Remote - US"
    copy is already in the funnel. A distinct "Bengaluru, India" copy arrives from
    another source (different URL / source / native id), content-matches the owner
    (location is not part of the fingerprint), and is rejected by current policy
    for location_mismatch. The rejection must drop only the incoming duplicate and
    leave the accepted owner active and visible in ``list_recent`` — re-running the
    rejected duplicate must not resurface it as a same-identity re-observation and
    delete the owner on a later run.
    """

    def reject_india(posting: ScrapedJobPosting) -> PostingAcceptance:
        if "india" in (posting.metadata.location or "").casefold():
            return PostingAcceptance.reject(
                reason="current_policy_mismatch",
                rejection_reasons=("location_mismatch",),
            )
        return PostingAcceptance.accept()

    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        acceptance_policy=reject_india,
        clock=lambda: "2026-05-12T00:00:00Z",
    )

    owner_url = "https://boards.greenhouse.io/acme/jobs/remote-us"
    description = "Own the platform engineering roadmap for local-first developer tooling."
    accepted = _posting(
        canonical_url=owner_url,
        source_native_id="gh-remote",
        source_id="greenhouse:acme",
        ats_kind=AtsKind.GREENHOUSE,
        board="Acme",
        metadata=JobMetadata(
            title="Staff Platform Engineer",
            description=description,
            location="Remote - US",
        ),
    )
    india_duplicate = _posting(
        canonical_url="https://jobs.lever.co/acme/staff-platform-engineer-india",
        source_native_id="lever-india",
        source_id="lever:acme",
        ats_kind=AtsKind.LEVER,
        board="Acme",
        metadata=JobMetadata(
            title="Staff Platform Engineer",
            description=description,
            location="Bengaluru, India",
        ),
    )

    created = use_case.execute(
        tenant_id=LOCAL_TENANT, postings=[accepted], run_id="run-owner"
    )
    assert created.new_jobs == 1
    owner = repo.load(LOCAL_TENANT, JobId(owner_url))
    assert owner is not None and owner.is_deleted is False
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT, postings=[india_duplicate], run_id="run-duplicate"
    )

    assert summary.total == 1
    assert summary.new_jobs == 0
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert summary.duplicates_rejected == 0

    owner = repo.load(LOCAL_TENANT, JobId(owner_url))
    assert owner is not None
    assert owner.is_deleted is False
    assert owner.metadata.location == "Remote - US"
    assert JobId(owner_url) in [job.job_id for job in repo.list_recent(LOCAL_TENANT)]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

    # The rejected distinct posting is recorded as declined-duplicate audit
    # attributed to the OWNER (so it shows in the owner's audit history), and is
    # NOT attached as an owner observation (which would re-trigger the delete later).
    assert [event.event_type for event in publisher.events] == ["DuplicateJobLinkRejected"]
    rejected = publisher.events[-1]
    assert rejected.payload["job_id"] == owner_url
    assert rejected.payload["candidate_job_id"] == "https://jobs.lever.co/acme/staff-platform-engineer-india"
    assert "location_mismatch" in rejected.payload["reason"]
    assert [obs.source_id for obs in repo.list_observations(LOCAL_TENANT, JobId(owner_url))] == [
        "greenhouse:acme"
    ]

    # Re-running the rejected duplicate must be stable: the owner stays active and
    # visible, proving the rejection left no re-observation trail to delete it. The
    # already-recorded (owner, candidate) rejection is idempotent, so no duplicate
    # audit event is appended on the repeat observation.
    publisher.events.clear()
    resummary = use_case.execute(
        tenant_id=LOCAL_TENANT, postings=[india_duplicate], run_id="run-duplicate-2"
    )
    assert resummary.observed == 0
    owner = repo.load(LOCAL_TENANT, JobId(owner_url))
    assert owner is not None and owner.is_deleted is False
    assert JobId(owner_url) in [job.job_id for job in repo.list_recent(LOCAL_TENANT)]
    assert "JobDeleted" not in [event.event_type for event in publisher.events]
    assert "DuplicateJobLinkRejected" not in [event.event_type for event in publisher.events]


def test_discover_jobs_use_case_keeps_distinct_roles_at_same_company_separate(
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
                canonical_url="https://boards.greenhouse.io/acme/jobs/platform",
                source_native_id="gh-platform",
                source_id="greenhouse:acme",
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Platform Engineer",
                    description=_long_description("plat", tokens=90),
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.lever.co/acme/data-scientist",
                source_native_id="lever-data",
                source_id="lever:acme",
                ats_kind=AtsKind.LEVER,
                board="Acme",
                metadata=JobMetadata(
                    title="Staff Data Scientist",
                    description=_long_description("data", tokens=90),
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0


def test_discover_jobs_use_case_keeps_same_title_company_divergent_descriptions_separate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    shared_intro = _long_description("intro", tokens=12) + " "
    platform_description = shared_intro + " ".join(f"platform{index}" for index in range(90))
    payments_description = shared_intro + " ".join(f"payments{index}" for index in range(90))

    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://boards.greenhouse.io/acme/jobs/head-tech-platform",
                source_native_id="gh-platform",
                source_id="greenhouse:acme",
                board="Acme",
                metadata=JobMetadata(
                    title="Head of Technology",
                    description=platform_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.lever.co/acme/head-tech-payments",
                source_native_id="lever-payments",
                source_id="lever:acme",
                ats_kind=AtsKind.LEVER,
                board="Acme",
                metadata=JobMetadata(
                    title="Head of Technology",
                    description=payments_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0


def test_discover_jobs_use_case_prefers_native_identity_over_content_match(
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
                canonical_url="https://acme.wd1.myworkdayjobs.com/External/job/Head-of-Engineering_JR-9",
                source_native_id="JR-9",
                source_id="workday:acme",
                ats_kind=AtsKind.WORKDAY,
                board="Acme",
                metadata=JobMetadata(
                    title="Head of Engineering",
                    description="Own the engineering organization and delivery roadmap.",
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )
    publisher.events.clear()

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://acme.wd1.myworkdayjobs.com/External/job/Head-of-Engineering-alias_JR-9",
                source_native_id="JR-9",
                source_id="workday:acme",
                ats_kind=AtsKind.WORKDAY,
                board="Acme",
                metadata=JobMetadata(
                    title="Completely Different Title",
                    description="Totally unrelated description text.",
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 0
    assert summary.observed == 1
    assert summary.duplicates_linked == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    link = conn.execute("SELECT reason, confidence FROM job_duplicate_links").fetchone()
    assert link["reason"] == "canonical_url_match"
    assert link["confidence"] == 0.9


def test_is_genuine_employer_identity_rejects_sentinel_and_platform_labels() -> None:
    assert is_genuine_employer_identity("Acme") is True
    assert is_genuine_employer_identity("greenhouse:acme") is True
    for label in (
        "",
        "   ",
        "Unknown",
        "User-mediated capture",
        "Workday",
        "LinkedIn",
        "indeed",
        "zip_recruiter",
        "Glassdoor",
        "Google",
    ):
        assert is_genuine_employer_identity(label) is False, label


def test_discover_jobs_use_case_does_not_merge_distinct_employers_behind_manual_capture_board(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    boilerplate = _long_description("boiler", tokens=90)

    # Two DISTINCT employers, both captured with only the shared platform-sentinel
    # board ("User-mediated capture") and near-identical boilerplate text. The
    # employer discriminator is absent, so these MUST NOT content-merge.
    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://careers.acme.example/jobs/eng-1",
                source_native_id="manual-acme",
                source_id="manual_capture:acme",
                ats_kind=AtsKind.OTHER,
                board="User-mediated capture",
                metadata=JobMetadata(
                    title="Head of Engineering",
                    description=boilerplate + " acme alpha beta",
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://careers.globex.example/jobs/eng-9",
                source_native_id="manual-globex",
                source_id="manual_capture:globex",
                ats_kind=AtsKind.OTHER,
                board="User-mediated capture",
                metadata=JobMetadata(
                    title="Head of Engineering",
                    description=boilerplate + " globex gamma delta",
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0


def test_discover_jobs_use_case_does_not_merge_distinct_employers_behind_workday_fallback_board(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    boilerplate = _long_description("boiler", tokens=90)

    # Employer-less Workday postings fall back to the constant board "Workday".
    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://one.wd1.myworkdayjobs.com/job/Head-of-Data_JR-1",
                source_native_id="JR-1",
                source_id="workday:one",
                ats_kind=AtsKind.WORKDAY,
                board="Workday",
                metadata=JobMetadata(
                    title="Head of Data",
                    description=boilerplate + " one alpha beta",
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://two.wd1.myworkdayjobs.com/job/Head-of-Data_JR-2",
                source_native_id="JR-2",
                source_id="workday:two",
                ats_kind=AtsKind.WORKDAY,
                board="Workday",
                metadata=JobMetadata(
                    title="Head of Data",
                    description=boilerplate + " two gamma delta",
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0


def test_discover_jobs_use_case_keeps_boilerplate_heavy_distinct_roles_separate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteJobRepository(conn)
    publisher = RecordingPublisher()
    use_case = DiscoverJobsUseCase(
        repository=repo,
        publisher=publisher,
        clock=lambda: "2026-05-12T00:00:00Z",
    )
    # Same real employer + same title, heavy shared boilerplate (75 tokens) but
    # genuinely different role content (25 tokens). The 0.83 shingle threshold
    # keeps distinct roles apart even when boilerplate dominates.
    boilerplate = _long_description("boiler", tokens=75)
    platform_description = boilerplate + " " + _long_description("platform", tokens=25)
    payments_description = boilerplate + " " + _long_description("payments", tokens=25)

    use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://boards.greenhouse.io/acme/jobs/head-platform",
                source_native_id="gh-platform",
                source_id="greenhouse:acme",
                board="Acme",
                metadata=JobMetadata(
                    title="Head of Technology",
                    description=platform_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-1",
    )

    summary = use_case.execute(
        tenant_id=LOCAL_TENANT,
        postings=[
            _posting(
                canonical_url="https://jobs.lever.co/acme/head-payments",
                source_native_id="lever-payments",
                source_id="lever:acme",
                ats_kind=AtsKind.LEVER,
                board="Acme",
                metadata=JobMetadata(
                    title="Head of Technology",
                    description=payments_description,
                    location="Remote",
                ),
            )
        ],
        run_id="run-2",
    )

    assert summary.new_jobs == 1
    assert summary.observed == 0
    assert summary.duplicates_linked == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone()[0] == 0
