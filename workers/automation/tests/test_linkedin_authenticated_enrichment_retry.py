from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.enrichment import (
    ActiveState,
    ApplicationUrl,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
    PostingSnapshotSet,
    QuarantineReason,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.identifiers import JobId, generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment.detail import (
    _MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS,
    _apply_authenticated_linkedin_apply_url,
    _authenticated_apply_url_recovery_error,
    _is_linkedin_job,
    _record_posting_snapshot_from_cascade,
    _reset_authenticated_linkedin_retry_candidates,
)
from jobctrl.enrichment import detail
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.infrastructure.enrichment.sqlite_repository import (
    SqlitePostingSnapshotSetRepository,
)
from jobctrl.infrastructure.enrichment.linkedin_apply_resolver import (
    LinkedInApplyResolution,
)
from jobctrl.state import ensure_job_stage_rows, set_stage_state

from .politeness_helpers import offline_session


@pytest.fixture(autouse=True)
def enable_authenticated_resolver_for_recovery_logic_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Recovery fixtures supply a fake resolver; capability gating has its own tests."""

    monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


class _Resolver:
    def __init__(self, application_url: str | None) -> None:
        self.application_url = application_url
        self.calls: list[str] = []

    def resolve_loaded_page(self, page: object, url: str) -> str | None:  # noqa: ARG002
        self.calls.append(url)
        return self.application_url


class _RecoveryResolver:
    """Stub resolver for the pageless apply-URL recovery path."""

    def __init__(self, resolution: LinkedInApplyResolution | Exception) -> None:
        self._resolution = resolution
        self.calls: list[str] = []
        self.closed = False

    def resolve(self, job_url: str) -> LinkedInApplyResolution:
        self.calls.append(job_url)
        if isinstance(self._resolution, Exception):
            raise self._resolution
        return self._resolution

    def close(self) -> None:
        self.closed = True


def _seed_discovered(conn: sqlite3.Connection, url: str, site: str) -> None:
    job_id = generate_job_id()
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, "Engineer", site, "2026-01-01T00:00:00+00:00"),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value, is_current,
            first_seen_at, last_seen_at, retired_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?, NULL)
        """,
        (str(LOCAL_TENANT), str(job_id), url, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _job_id(conn: sqlite3.Connection, url: str) -> JobId:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ?",
        (str(LOCAL_TENANT), url),
    ).fetchone()
    assert row is not None
    return JobId(str(row["job_id"]))


def _save_enriched(
    conn: sqlite3.Connection,
    url: str,
    *,
    application_url: str | None,
    attempts: int = 1,
    description: str = "A complete LinkedIn description",
) -> None:
    repo = SqliteEnrichmentRepository(conn)
    now = datetime.now(timezone.utc).isoformat()
    aggregate = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=_job_id(conn, url),
        updated_at=now,
    )
    for attempt_index in range(attempts):
        aggregate = aggregate.start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at=now,
        ).succeed_attempt(
            full_description=FullDescription(text=description),
            application_url=(ApplicationUrl(value=application_url) if application_url else None),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=now,
        )
        if attempt_index < attempts - 1:
            aggregate = aggregate.reset(reset_at=now)
    repo.save(aggregate)


def _save_failed(
    conn: sqlite3.Connection,
    url: str,
    *,
    retryable: bool,
    attempts: int = 1,
    error_code: str = "DETAIL_ERROR",
    error_message: str = "no data extracted",
) -> None:
    repo = SqliteEnrichmentRepository(conn)
    now = datetime.now(timezone.utc).isoformat()
    aggregate = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=_job_id(conn, url),
        updated_at=now,
    )
    for attempt_index in range(attempts):
        aggregate = aggregate.start_attempt(
            extraction_tier=ExtractionTier.LLM_ASSISTED,
            started_at=now,
        ).fail_attempt(
            error=EnrichmentError(
                code=error_code,
                message=error_message,
                retryable=retryable,
            ),
            finished_at=now,
        )
        if attempt_index < attempts - 1:
            aggregate = aggregate.reset(reset_at=now)
    repo.save(aggregate)


@pytest.mark.parametrize(
    ("site", "url"),
    [
        ("linkedin", "https://www.linkedin.com/jobs/view/123"),
        (None, "https://linkedin.com/jobs/view/123"),
        ("LinkedIn", "https://ca.linkedin.com/jobs/apply/123"),
    ],
)
def test_linkedin_job_classifier_accepts_linkedin_job_hosts(site: str | None, url: str) -> None:
    assert _is_linkedin_job(site, url)


@pytest.mark.parametrize(
    ("site", "url"),
    [
        (
            "linkedin",
            "https://mail.google.com/mail/u/0/#inbox/linkedin.com/jobs/123",
        ),
        (None, "https://example.com/linkedin.com/jobs/123"),
        (None, "https://linkedin.com.evil.test/jobs/view/123"),
        ("linkedin", "not a url linkedin.com/jobs/123"),
    ],
)
def test_linkedin_job_classifier_rejects_non_linkedin_hosts(site: str | None, url: str) -> None:
    assert not _is_linkedin_job(site, url)


def test_authenticated_apply_url_upgrades_partial_linkedin_enrichment() -> None:
    resolver = _Resolver("https://jobs.ashbyhq.com/acme/role")
    result = _apply_authenticated_linkedin_apply_url(
        site="linkedin",
        url="https://www.linkedin.com/jobs/view/123",
        cascade_result={
            "status": "partial",
            "full_description": "Complete description",
            "application_url": None,
        },
        resolver=resolver,
        page=object(),
    )

    assert result["status"] == "ok"
    assert result["application_url"] == "https://jobs.ashbyhq.com/acme/role"
    assert result["authenticated_apply_url_method"] == "authenticated_browser"
    assert resolver.calls == ["https://www.linkedin.com/jobs/view/123"]


def test_authenticated_apply_url_does_not_run_for_non_linkedin() -> None:
    resolver = _Resolver("https://jobs.ashbyhq.com/acme/role")
    result = _apply_authenticated_linkedin_apply_url(
        site="indeed",
        url="https://example.com/jobs/123",
        cascade_result={
            "status": "partial",
            "full_description": "Complete description",
            "application_url": None,
        },
        resolver=resolver,
        page=object(),
    )

    assert result["application_url"] is None
    assert resolver.calls == []


def test_retry_candidates_reset_failed_rows_and_preserve_enriched(
    conn: sqlite3.Connection,
) -> None:
    missing_url = "https://www.linkedin.com/jobs/view/1"
    failed_url = "https://www.linkedin.com/jobs/view/2"
    has_apply_url = "https://www.linkedin.com/jobs/view/3"
    indeed_url = "https://example.com/jobs/4"
    _seed_discovered(conn, missing_url, "linkedin")
    _seed_discovered(conn, failed_url, "linkedin")
    _seed_discovered(conn, has_apply_url, "linkedin")
    _seed_discovered(conn, indeed_url, "indeed")
    _save_enriched(conn, missing_url, application_url=None)
    _save_failed(conn, failed_url, retryable=True)
    _save_enriched(conn, has_apply_url, application_url="https://apply.example/3")
    _save_enriched(conn, indeed_url, application_url=None)

    # No resolver supplied: the enriched-but-missing row must never be reset,
    # since a destructive reset would discard its canonical description.
    reset_count = _reset_authenticated_linkedin_retry_candidates(conn)

    assert reset_count == 1
    repo = SqliteEnrichmentRepository(conn)
    missing = repo.load(LOCAL_TENANT, _job_id(conn, missing_url))
    assert missing is not None
    assert missing.is_enriched
    assert missing.full_description is not None
    assert missing.full_description.text == "A complete LinkedIn description"
    assert missing.application_url is None
    assert repo.load(LOCAL_TENANT, _job_id(conn, failed_url)).is_pending  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, _job_id(conn, has_apply_url)).is_enriched  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, _job_id(conn, indeed_url)).is_enriched  # type: ignore[union-attr]


def test_enriched_missing_apply_url_preserves_description_on_failed_recovery(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/failrecover"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    resolver = _RecoveryResolver(LinkedInApplyResolution(None, "external_url_missing"))

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        resolver_factory=lambda: resolver,
        session=offline_session(conn, site="linkedin"),
    )

    assert reset_count == 0
    assert resolver.calls == [url]
    assert resolver.closed is True
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.is_enriched
    assert aggregate.full_description is not None
    assert aggregate.full_description.text == "A complete LinkedIn description"
    assert aggregate.application_url is None
    # A bounding attempt is recorded so a never-resolving row cannot be
    # re-driven through the authenticated browser forever.
    assert aggregate.attempt_count == 2
    assert aggregate.last_attempt is not None
    assert aggregate.last_attempt.error is not None
    assert aggregate.last_attempt.error.code == "APPLY_URL_EXTERNAL_TARGET_MISSING"


@pytest.mark.parametrize(
    ("method", "expected_code", "retryable"),
    [
        ("linkedin_onsite_apply", "APPLY_URL_LINKEDIN_ONSITE", False),
        ("apply_button_missing", "APPLY_URL_CONTROL_MISSING", True),
        ("external_url_missing", "APPLY_URL_EXTERNAL_TARGET_MISSING", True),
        ("navigation_error", "APPLY_URL_NAVIGATION_FAILED", True),
        ("unsafe_url", "APPLY_URL_UNSAFE_TARGET", False),
    ],
)
def test_apply_url_recovery_outcomes_are_explicit(
    method: str,
    expected_code: str,
    retryable: bool,
) -> None:
    error = _authenticated_apply_url_recovery_error(
        method=method,
        raw_error="resolver detail",
    )

    assert error.code == expected_code
    assert error.message
    assert error.retryable is retryable


def test_linkedin_onsite_apply_is_audited_and_not_retried(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/4448147529"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    job_id = _job_id(conn, url)
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn,
        job_id,
        "enrich",
        "succeeded",
        tenant_id=LOCAL_TENANT,
        validate_transition=False,
    )
    conn.commit()
    resolver = _RecoveryResolver(LinkedInApplyResolution(None, "linkedin_onsite_apply"))

    for _ in range(2):
        _reset_authenticated_linkedin_retry_candidates(
            conn,
            job_ids=(job_id,),
            resolver_factory=lambda: resolver,
            session=offline_session(conn, site="linkedin"),
        )

    assert resolver.calls == [url]
    aggregate = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, job_id)
    assert aggregate is not None
    assert aggregate.is_enriched
    assert aggregate.last_attempt is not None
    assert aggregate.last_attempt.error is not None
    assert aggregate.last_attempt.error.code == "APPLY_URL_LINKEDIN_ONSITE"
    assert aggregate.last_attempt.error.retryable is False
    stage = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert stage is not None
    assert stage["state"] == "succeeded"
    metadata = json.loads(stage["metadata_json"])
    assert metadata["applyUrlOutcomeCode"] == "APPLY_URL_LINKEDIN_ONSITE"
    assert "no external application URL exists" in metadata["applyUrlOutcomeMessage"]
    events = conn.execute(
        "SELECT message, payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageProgress'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchall()
    assert len(events) == 1
    assert "no external application URL exists" in events[0]["message"]
    assert json.loads(events[0]["payload_json"])["applyUrlOutcomeCode"] == ("APPLY_URL_LINKEDIN_ONSITE")


def test_enriched_missing_apply_url_preserves_description_when_resolver_raises(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/raise"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    resolver = _RecoveryResolver(RuntimeError("login wall"))

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        resolver_factory=lambda: resolver,
        session=offline_session(conn, site="linkedin"),
    )

    assert reset_count == 0
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.is_enriched
    assert aggregate.full_description is not None
    assert aggregate.full_description.text == "A complete LinkedIn description"
    assert aggregate.application_url is None


def test_enriched_missing_apply_url_backfills_on_successful_recovery(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/backfill"
    apply_target = "https://jobs.ashbyhq.com/acme/role"
    _seed_discovered(conn, url, "linkedin")
    description = " ".join(["Senior platform engineering responsibilities"] * 20)
    _save_enriched(conn, url, application_url=None, description=description)
    job_id = _job_id(conn, url)
    _record_posting_snapshot_from_cascade(
        conn,
        job_id=job_id,
        url=url,
        source_id="jobspy:linkedin",
        title="Engineer",
        cascade_result={
            "full_description": description,
            "application_url": None,
            "active_state": ActiveState.ACTIVE.value,
            "verification_method": "enrichment_success",
            "tier_used": 3,
        },
        captured_at="2026-01-01T00:00:00+00:00",
    )
    before = conn.execute(
        "SELECT latest_confidence, latest_quarantine_reason "
        "FROM posting_snapshot_sets WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert before is not None
    assert before["latest_confidence"] == SnapshotConfidence.MEDIUM.value
    assert before["latest_quarantine_reason"] == QuarantineReason.NONE.value
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "blocked",
        tenant_id=LOCAL_TENANT,
        error_code="ENRICHMENT_QUARANTINED",
        retryable=True,
        blocked_by=["enrich"],
        validate_transition=False,
    )
    conn.commit()
    resolver = _RecoveryResolver(LinkedInApplyResolution(apply_target, "click"))

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        resolver_factory=lambda: resolver,
        session=offline_session(conn, site="linkedin"),
    )

    assert reset_count == 0
    assert resolver.calls == [url]
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, job_id)
    assert aggregate is not None
    assert aggregate.is_enriched
    assert aggregate.full_description is not None
    assert aggregate.full_description.text == description
    assert aggregate.application_url is not None
    assert aggregate.application_url.value == apply_target
    after = conn.execute(
        "SELECT latest_snapshot_version, latest_confidence, latest_quarantine_reason, "
        "snapshot_set_json FROM posting_snapshot_sets WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert after is not None
    assert after["latest_snapshot_version"] == 2
    assert after["latest_confidence"] == SnapshotConfidence.MEDIUM.value
    assert after["latest_quarantine_reason"] == QuarantineReason.NONE.value
    assert "apply_url_recovered:authenticated_browser" in after["snapshot_set_json"]
    tailor_state = conn.execute(
        "SELECT state, error_code FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert tailor_state is not None
    assert dict(tailor_state) == {"state": "pending", "error_code": None}


def test_legacy_missing_apply_url_snapshot_is_reclassified_without_browser_retry(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://www.linkedin.com/jobs/view/legacy-content-trust"
    description = " ".join(["Senior platform engineering responsibilities with Python and distributed systems"] * 20)
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None, description=description)
    job_id = _job_id(conn, url)
    snapshot_set = PostingSnapshotSet.empty(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        updated_at="2026-01-01T00:00:00+00:00",
    )
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id="jobspy:linkedin",
        extraction_tier=ExtractionTier.LLM_ASSISTED.value,
        description_hash=SnapshotDescriptionHash.from_text(description),
        apply_url=None,
        active_state=ActiveState.ACTIVE,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
        captured_at="2026-01-01T00:00:00+00:00",
    )
    SqlitePostingSnapshotSetRepository(conn).save(snapshot_set)
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn,
        job_id,
        "enrich",
        "succeeded",
        tenant_id=LOCAL_TENANT,
        validate_transition=False,
    )
    set_stage_state(
        conn,
        job_id,
        "tailor",
        "blocked",
        tenant_id=LOCAL_TENANT,
        error_code="ENRICHMENT_QUARANTINED",
        error_message="Tailoring is waiting for a trustworthy posting snapshot.",
        retryable=True,
        blocked_by=["enrich"],
        validate_transition=False,
    )
    conn.commit()
    monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: False)

    def unexpected_resolver() -> object:
        raise AssertionError("content-trust repair must not require browser navigation")

    for _ in range(2):
        _reset_authenticated_linkedin_retry_candidates(
            conn,
            job_ids=(job_id,),
            resolver_factory=unexpected_resolver,
        )

    repaired = SqlitePostingSnapshotSetRepository(conn).load(LOCAL_TENANT, job_id)
    assert repaired is not None
    assert repaired.latest_snapshot is not None
    assert repaired.latest_snapshot.snapshot_version == 2
    assert repaired.latest_snapshot.confidence is SnapshotConfidence.MEDIUM
    assert repaired.latest_snapshot.quarantine_reason is QuarantineReason.NONE
    assert "content_trust_reclassified:apply_url_independent" in (repaired.latest_snapshot.evidence)
    tailor_state = conn.execute(
        "SELECT state, error_code, error_message FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert tailor_state is not None
    assert dict(tailor_state) == {
        "state": "pending",
        "error_code": None,
        "error_message": None,
    }
    events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND event_type = 'PostingContentSnapshotCaptured' "
        "AND json_extract(payload_json, '$.reason') = 'missing_apply_url_content_trust_recovery'",
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert events is not None
    assert events[0] == 1


def test_enriched_missing_apply_url_recovery_is_bounded_across_runs(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/bounded"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    resolver = _RecoveryResolver(LinkedInApplyResolution(None, "external_url_missing"))

    # Drive many enrichment runs against a row whose resolver never resolves.
    for _ in range(5):
        _reset_authenticated_linkedin_retry_candidates(
            conn,
            resolver_factory=lambda: resolver,
            session=offline_session(conn, site="linkedin"),
        )

    # The authenticated browser is driven only until its own recovery bound is
    # reached, never forever. The initial extraction attempt is independent.
    assert len(resolver.calls) == _MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.attempt_count == _MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS + 1
    # Description preserved intact across every run.
    assert aggregate.is_enriched
    assert aggregate.full_description is not None
    assert aggregate.full_description.text == "A complete LinkedIn description"
    assert aggregate.application_url is None


def test_ordinary_attempts_do_not_consume_authenticated_recovery_budget(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/ordinary-attempts"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(
        conn,
        url,
        application_url=None,
        attempts=_MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS,
    )
    resolver = _RecoveryResolver(LinkedInApplyResolution(None, "external_url_missing"))

    _reset_authenticated_linkedin_retry_candidates(
        conn,
        resolver_factory=lambda: resolver,
        session=offline_session(conn, site="linkedin"),
    )

    assert resolver.calls == [url]
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.attempt_count == _MAX_AUTHENTICATED_LINKEDIN_RETRY_ATTEMPTS + 1
    assert aggregate.application_url is None


def test_failed_row_still_reset_for_authenticated_retry(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/failedreset"
    _seed_discovered(conn, url, "linkedin")
    _save_failed(conn, url, retryable=True)
    resolver = _RecoveryResolver(LinkedInApplyResolution("https://apply.example/x", "click"))

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        resolver_factory=lambda: resolver,
        session=offline_session(conn, site="linkedin"),
    )

    assert reset_count == 1
    # Non-enriched rows never touch the apply-URL resolver.
    assert resolver.calls == []
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.is_pending


def test_legacy_public_write_guard_failure_is_reset_despite_nonretryable_flag(
    conn: sqlite3.Connection,
) -> None:
    url = "https://www.linkedin.com/jobs/view/legacy-public-write"
    _seed_discovered(conn, url, "linkedin")
    _save_failed(
        conn,
        url,
        retryable=False,
        error_code="DETAIL_UNSAFE_URL",
        error_message="Unsupported public route method: POST",
    )

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        job_ids=(_job_id(conn, url),),
    )

    assert reset_count == 1
    aggregate = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.is_pending


def test_failed_retry_reset_is_scoped_to_explicit_job_ids(
    conn: sqlite3.Connection,
) -> None:
    selected_url = "https://www.linkedin.com/jobs/view/selected"
    other_url = "https://www.linkedin.com/jobs/view/other"
    _seed_discovered(conn, selected_url, "linkedin")
    _seed_discovered(conn, other_url, "linkedin")
    _save_failed(conn, selected_url, retryable=True)
    _save_failed(conn, other_url, retryable=True)

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn,
        job_ids=(_job_id(conn, selected_url),),
    )

    assert reset_count == 1
    repo = SqliteEnrichmentRepository(conn)
    assert repo.load(LOCAL_TENANT, _job_id(conn, selected_url)).is_pending  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, _job_id(conn, other_url)).is_failed  # type: ignore[union-attr]


def test_exact_cohort_scraper_requeues_failed_linkedin_job(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://www.linkedin.com/jobs/view/exact-cohort"
    _seed_discovered(conn, url, "linkedin")
    _save_failed(conn, url, retryable=True)
    job_id = _job_id(conn, url)
    batches: list[list[tuple[JobId, str]]] = []

    def fake_scrape_site_batch(
        _conn: sqlite3.Connection,
        _site: str,
        jobs: list[tuple[JobId, str]],
        **_kwargs: object,
    ) -> dict:
        batches.append(jobs)
        return {
            "processed": len(jobs),
            "ok": len(jobs),
            "partial": 0,
            "error": 0,
            "tiers": {},
        }

    monkeypatch.setattr(detail, "scrape_site_batch", fake_scrape_site_batch)

    result = detail._run_detail_scraper(
        conn,
        job_ids=(job_id,),
        reset_linkedin_candidates=True,
        recovery_key="discover-local:run-current",
    )

    assert batches == [[(job_id, "Engineer")]]
    assert result["ok"] == 1


def test_retry_candidates_skip_nonretryable_and_exhausted_rows(
    conn: sqlite3.Connection,
) -> None:
    nonretryable_url = "https://www.linkedin.com/jobs/view/nonretryable"
    exhausted_url = "https://www.linkedin.com/jobs/view/exhausted"
    _seed_discovered(conn, nonretryable_url, "linkedin")
    _seed_discovered(conn, exhausted_url, "linkedin")
    _save_failed(conn, nonretryable_url, retryable=False)
    _save_enriched(conn, exhausted_url, application_url=None, attempts=3)

    reset_count = _reset_authenticated_linkedin_retry_candidates(conn)

    assert reset_count == 0
    repo = SqliteEnrichmentRepository(conn)
    assert repo.load(LOCAL_TENANT, _job_id(conn, nonretryable_url)).is_failed  # type: ignore[union-attr]
    assert repo.load(LOCAL_TENANT, _job_id(conn, exhausted_url)).is_enriched  # type: ignore[union-attr]


def test_recovery_pass_navigation_consumes_run_budget(
    conn: sqlite3.Connection,
) -> None:
    """#314 Medium: the authenticated recovery goto is rate + budget gated.

    The owner-authenticated recovery pass is robots-off (D1/D3), but the per-run
    request budget still bounds it — so a single ``resolve()`` navigation
    consumes exactly one budget unit, matching the batch path's gated goto.
    """
    url = "https://www.linkedin.com/jobs/view/gated"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    resolver = _RecoveryResolver(LinkedInApplyResolution("https://apply.example/x", "click"))
    session = offline_session(conn, budget=5, site="linkedin")

    _reset_authenticated_linkedin_retry_candidates(conn, resolver_factory=lambda: resolver, session=session)

    # The navigation happened AND went through the gate: exactly one budget unit
    # was consumed for the single authenticated goto.
    assert resolver.calls == [url]
    assert session.budget.remaining() == 4


def test_recovery_pass_defers_when_run_budget_exhausted(
    conn: sqlite3.Connection,
) -> None:
    """#314 Medium: an exhausted run budget defers the recovery goto (no bypass).

    When the shared run budget is drained, the gate blocks the authenticated
    navigation: ``resolve()`` is never called, no retry attempt is burned, the
    enriched description is preserved, and the deferral is recorded as a
    first-class ``budget_exhausted`` outcome (never a scrape failure).
    """
    url = "https://www.linkedin.com/jobs/view/nobudget"
    _seed_discovered(conn, url, "linkedin")
    _save_enriched(conn, url, application_url=None)
    resolver = _RecoveryResolver(LinkedInApplyResolution("https://apply.example/x", "click"))
    session = offline_session(conn, budget=1, site="linkedin")
    assert session.budget.try_consume(1) is True  # drain to zero

    reset_count = _reset_authenticated_linkedin_retry_candidates(
        conn, resolver_factory=lambda: resolver, session=session
    )

    # The gate blocked the navigation: no ungated authenticated goto happened …
    assert resolver.calls == []
    assert reset_count == 0
    repo = SqliteEnrichmentRepository(conn)
    aggregate = repo.load(LOCAL_TENANT, _job_id(conn, url))
    assert aggregate is not None
    assert aggregate.is_enriched
    assert aggregate.application_url is None
    # … and the deferral did not burn a retry attempt (the goto never ran).
    assert aggregate.attempt_count == 1
    # The deferral is a first-class budget-exhausted outcome, not a scrape error.
    row = conn.execute(
        "SELECT failure_category, is_scrape_failure FROM operational_attempt_metrics "
        "WHERE stage = 'enrich' AND source_id = 'linkedin' AND outcome = 'blocked' "
        "ORDER BY metric_id DESC LIMIT 1",
    ).fetchone()
    assert row is not None
    assert row[0] == "budget_exhausted"
    assert row[1] == 0
