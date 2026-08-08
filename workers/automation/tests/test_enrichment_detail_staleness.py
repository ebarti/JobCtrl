from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.enrichment import EnrichmentError, ExtractionTier, JobEnrichment
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import detail
from jobctrl.enrichment.detail import (
    _detail_failure_retryable,
    _record_posting_snapshot_from_cascade,
    _record_posting_snapshot_failure_from_cascade,
    _reset_authenticated_linkedin_retry_candidates,
    _source_id_for_enriched_job,
    scrape_detail_page,
)
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.infrastructure.network import PublicUrlDecision

from .politeness_helpers import offline_gateway, offline_session


class _FakeResponse:
    status = 200


class _FakePage:
    url = "https://example.com/jobs/closed"

    def goto(self, *_args, **_kwargs):
        return _FakeResponse()

    def wait_for_load_state(self, *_args, **_kwargs) -> None:
        return None

    def title(self) -> str:
        return "Closed engineering role"


def _long_description() -> str:
    return "Build reliable distributed systems with Python, TypeScript, and Postgres. " * 8


class _FakeBrowser:
    def new_context(self, **_kwargs):
        return self

    def new_page(self):
        return object()

    def close(self) -> None:
        return None


class _FakeChromium:
    def launch(self, **_kwargs):
        return _FakeBrowser()


class _FakePlaywright:
    chromium = _FakeChromium()

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


class _OfflineLlmPort:
    """LlmPort stub for the Tier-3 extractor.

    Staleness detection wins at Tier 1 (JSON-LD) or Tier 2 (CSS), so the
    Tier-3 LLM extractor is only constructed by the cascade, never invoked.
    The stub keeps that construction from resolving a real provider (which
    needs API keys and network) and raises if the cascade ever falls through
    to the LLM tier, so a regression can't quietly reroute staleness detection
    through the model.
    """

    def chat(self, *_args, **_kwargs) -> str:
        raise AssertionError("LLM tier must not run during staleness detection")

    def chat_json(self, *_args, **_kwargs) -> dict:
        raise AssertionError("LLM tier must not run during staleness detection")

    def ask(self, *_args, **_kwargs) -> str:
        raise AssertionError("LLM tier must not run during staleness detection")


@pytest.fixture
def offline_llm_tier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Swap the LlmPort the detail cascade resolves so Tier-3 construction stays
    offline-deterministic (no keys, no network)."""
    monkeypatch.setattr(detail, "validate_public_http_url", lambda _url: PublicUrlDecision(True))
    monkeypatch.setattr(detail, "get_llm_adapter", lambda: _OfflineLlmPort())


@pytest.mark.usefixtures("offline_llm_tier")
def test_scrape_detail_page_reports_expired_json_ld_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        detail,
        "_collect_json_ld",
        lambda _page: [
            {
                "@type": "JobPosting",
                "description": _long_description(),
                "directApply": True,
                "url": "https://example.com/jobs/closed/apply",
                "validThrough": "2000-01-01T00:00:00+00:00",
            }
        ],
    )
    monkeypatch.setattr(detail, "_collect_main_content", lambda _page: "<main>Expired role</main>")

    result = scrape_detail_page(_FakePage(), "https://example.com/jobs/closed", session=offline_session())

    assert result["status"] == "inactive"
    assert result["active_state"] == "expired"
    assert result["verification_method"] == "json_ld_valid_through"
    assert result["full_description"]


@pytest.mark.usefixtures("offline_llm_tier")
def test_scrape_detail_page_reports_closed_marker_as_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(detail, "_collect_json_ld", lambda _page: [])
    monkeypatch.setattr(
        detail,
        "_collect_main_content",
        lambda _page: (
            "<main><p>This position is no longer accepting applications.</p>"
            f"<div id='job-description'>{_long_description()}</div></main>"
        ),
    )

    result = scrape_detail_page(_FakePage(), "https://example.com/jobs/closed", session=offline_session())

    assert result["status"] == "inactive"
    assert result["active_state"] == "closed"
    assert result["verification_method"] == "closed_marker"
    assert result["full_description"]


def test_verified_no_data_extracted_detail_failure_stays_retryable() -> None:
    assert (
        _detail_failure_retryable(
            {
                "status": "error",
                "error": "no data extracted",
                "active_state": "active",
                "verification_method": "default_body_present",
            }
        )
        is True
    )


def test_page_load_detail_failure_stays_retryable() -> None:
    assert _detail_failure_retryable({"status": "error", "error": "timeout"}) is True


def test_verified_inactive_detail_failure_is_not_retryable() -> None:
    assert (
        _detail_failure_retryable(
            {
                "status": "inactive",
                "error": "posting removed",
                "active_state": "removed",
                "verification_method": "http_status",
            }
        )
        is False
    )


def test_source_lookup_only_falls_back_for_missing_exact_v7_observation() -> None:
    conn = sqlite3.connect(":memory:")
    job_id = canonical_job_id("d06861be-e8d5-46dd-aa30-2d78dc12c96a")
    try:
        conn.execute(
            """
            CREATE TABLE job_source_observations (
                tenant_id TEXT NOT NULL,
                job_id TEXT NOT NULL,
                source_id TEXT,
                observed_at TEXT,
                source_observation_id TEXT
            )
            """
        )
        assert _source_id_for_enriched_job(conn, job_id, fallback="enrichment") == "enrichment"

        conn.execute("DROP TABLE job_source_observations")
        conn.execute("CREATE TABLE job_source_observations (tenant_id TEXT NOT NULL, source_id TEXT)")
        with pytest.raises(sqlite3.OperationalError, match="no such column: job_id"):
            _source_id_for_enriched_job(conn, job_id, fallback="enrichment")
    finally:
        conn.close()


def test_authenticated_linkedin_retry_resets_only_exact_v7_aggregate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_id = canonical_job_id("d7ac9089-caf0-4eb9-82fb-f56b168e9707")
    job_url = "https://www.linkedin.com/jobs/view/4375576106"
    try:
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, site, discovered_at,
                detail_error, detail_scraped_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(LOCAL_TENANT),
                str(job_id),
                job_url,
                "Director of Engineering",
                "linkedin",
                "2026-06-04T15:55:20+00:00",
                "legacy error must remain untouched",
                "2026-06-04T16:00:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_locators (
                tenant_id, job_id, locator_kind, locator_value,
                is_current, first_seen_at, last_seen_at
            ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
            """,
            (
                str(LOCAL_TENANT),
                str(job_id),
                job_url,
                "2026-06-04T15:55:20+00:00",
                "2026-06-04T15:55:20+00:00",
            ),
        )
        failed = (
            JobEnrichment.empty(
                tenant_id=LOCAL_TENANT,
                job_id=job_id,
                updated_at="2026-06-04T16:00:00+00:00",
            )
            .start_attempt(
                extraction_tier=ExtractionTier.CSS_SELECTORS,
                started_at="2026-06-04T16:00:00+00:00",
            )
            .fail_attempt(
                error=EnrichmentError(
                    code="DETAIL_ERROR",
                    message="login wall",
                    retryable=True,
                ),
                finished_at="2026-06-04T16:00:01+00:00",
            )
        )
        repo = SqliteEnrichmentRepository(conn)
        repo.save(failed)

        monkeypatch.setattr(detail, "linkedin_apply_resolver_enabled", lambda: True)

        reset_count = _reset_authenticated_linkedin_retry_candidates(
            conn,
            session=offline_session(conn, site="linkedin"),
        )

        assert reset_count == 1
        reset = repo.load(LOCAL_TENANT, job_id)
        assert reset is not None and reset.is_pending
        assert reset.attempt_count == 1
        legacy_row = conn.execute(
            "SELECT detail_error, detail_scraped_at FROM jobs WHERE tenant_id = ? AND job_id = ?",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert tuple(legacy_row) == (
            "legacy error must remain untouched",
            "2026-06-04T16:00:00+00:00",
        )
        stage = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        assert stage is not None and stage["state"] == "pending"
        event = conn.execute(
            "SELECT job_id, payload_json FROM job_events WHERE tenant_id = ? AND event_type = 'StageReset'",
            (str(LOCAL_TENANT),),
        ).fetchone()
        assert event is not None and event["job_id"] == str(job_id)
        payload = json.loads(event["payload_json"])
        assert payload["jobId"] == str(job_id)
        assert "jobUrl" not in payload
    finally:
        close_connection(db_path)


def test_scrape_site_batch_resolves_url_once_before_exact_v7_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_id = canonical_job_id("790fd73f-2fbe-44d7-b9a4-163040e69d89")
    job_url = "https://www.linkedin.com/jobs/view/4375576106"
    try:
        _seed_current_job(conn, job_id=job_id, url=job_url, title="Director")
        fetched_urls: list[str] = []

        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: (
                fetched_urls.append(_url)
                or {
                    "status": "ok",
                    "tier_used": 1,
                    "full_description": _long_description(),
                    "application_url": f"{job_url}/apply",
                    "elapsed": 1.0,
                    "active_state": "active",
                    "verification_method": "json_ld",
                }
            ),
        )

        stats = detail.scrape_site_batch(
            conn,
            "linkedin",
            [(job_id, "Director")],
            tenant_id=LOCAL_TENANT,
            gateway=offline_gateway(),
        )

        aggregate = SqliteEnrichmentRepository(conn).load(LOCAL_TENANT, job_id)
        snapshot = conn.execute(
            """
            SELECT job_id FROM posting_snapshot_sets
            WHERE tenant_id = ? AND job_id = ?
            """,
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        stage = conn.execute(
            """
            SELECT job_id, state FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'
            """,
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
        event = conn.execute(
            """
            SELECT job_id, payload_json FROM job_events
            WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageCompleted'
            ORDER BY event_id DESC LIMIT 1
            """,
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()

        assert stats == {
            "processed": 1,
            "ok": 1,
            "partial": 0,
            "error": 0,
            "blocked": 0,
            "tiers": {1: 1, 2: 0, 3: 0},
        }
        assert aggregate is not None and aggregate.is_enriched
        assert aggregate.job_id == job_id
        assert fetched_urls == [job_url]
        assert snapshot is not None and snapshot["job_id"] == str(job_id)
        assert stage is not None and stage["job_id"] == str(job_id)
        assert stage["state"] == "succeeded"
        assert event is not None and event["job_id"] == str(job_id)
        assert json.loads(event["payload_json"])["jobId"] == str(job_id)
    finally:
        close_connection(db_path)


def test_scrape_site_batch_uses_discovery_description_when_detail_extracts_no_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    tenant_id = "local"
    job_id = JobId("60000000-0000-4000-8000-000000000011")
    job_url = "https://www.linkedin.com/jobs/view/4375576106"
    description = _long_description()
    try:
        conn.execute(
            """
            INSERT INTO jobs (
                tenant_id, job_id, url, title, description, full_description,
                location, site, strategy, discovered_at, application_url, company
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                str(job_id),
                job_url,
                "Director of Engineering",
                description,
                description,
                "Barcelona, Catalonia, Spain",
                "linkedin",
                "jobspy",
                "2026-06-04T15:55:20+00:00",
                None,
                "Checkatrade",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_locators (
                tenant_id, job_id, locator_kind, locator_value, is_current,
                first_seen_at, last_seen_at, retired_at
            ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?, NULL)
            """,
            (
                tenant_id,
                str(job_id),
                job_url,
                "2026-06-04T15:55:20+00:00",
                "2026-06-04T15:55:20+00:00",
            ),
        )
        conn.commit()

        # Force the anonymous browser path so the gate uses the injected offline
        # gateway (deterministic, no authenticated-session shared limiter).
        monkeypatch.setenv("JOBCTRL_LINKEDIN_APPLY_RESOLVER", "0")
        monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
        monkeypatch.setattr(
            detail,
            "scrape_detail_page",
            lambda _page, _url, session=None: {
                "status": "error",
                "tier_used": 3,
                "full_description": None,
                "application_url": None,
                "error": "no data extracted",
                "elapsed": 12.0,
                "active_state": "active",
                "verification_method": "default_body_present",
                "http_status": 200,
            },
        )

        stats = detail.scrape_site_batch(
            conn,
            "linkedin",
            [(job_id, "Director")],
            tenant_id=tenant_id,
            gateway=offline_gateway(),
        )

        assert stats["processed"] == 1
        assert stats["partial"] == 1
        assert stats["error"] == 0

        enrichment = conn.execute(
            """
            SELECT current_status, full_description, attempts_json
            FROM job_enrichments
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, str(job_id)),
        ).fetchone()
        assert enrichment["current_status"] == "enriched"
        assert enrichment["full_description"] == description.strip()
        attempts = json.loads(enrichment["attempts_json"])
        assert attempts[-1]["status"] == "succeeded"

        stage = conn.execute(
            """
            SELECT state, metadata_json
            FROM job_stage_states
            WHERE tenant_id = ? AND job_id = ? AND stage = 'enrich'
            """,
            (tenant_id, str(job_id)),
        ).fetchone()
        assert stage["state"] == "succeeded"
        assert json.loads(stage["metadata_json"]) == {
            "fallbackSource": "discovery",
            "detailStatus": "error",
            "detailError": "no data extracted",
        }

        event = conn.execute(
            """
            SELECT payload_json
            FROM job_events
            WHERE tenant_id = ? AND job_id = ? AND event_type = 'StageCompleted'
            ORDER BY event_id DESC
            LIMIT 1
            """,
            (tenant_id, str(job_id)),
        ).fetchone()
        payload = json.loads(event["payload_json"])
        assert payload["fallbackSource"] == "discovery"
        assert payload["detailError"] == "no data extracted"
    finally:
        close_connection(db_path)


def test_selected_enrichment_filters_retry_to_requested_job(monkeypatch: pytest.MonkeyPatch) -> None:
    from jobctrl.enrichment.activities import EnrichActivityInput, _run_selected_enrichment

    calls: list[dict[str, object]] = []

    monkeypatch.setattr(
        detail,
        "_run_detail_scraper",
        lambda *args, **kwargs: (
            calls.append(kwargs)
            or {
                "processed": 1,
                "ok": 1,
                "partial": 0,
                "error": 0,
                "tiers": {1: 1},
            }
        ),
    )
    monkeypatch.setattr("jobctrl.database.get_connection", lambda: object())
    monkeypatch.setattr(
        "jobctrl.enrichment.activities._selected_enriched_job_ids",
        lambda _conn, *, tenant_id, job_ids: job_ids,
    )

    result = _run_selected_enrichment(
        EnrichActivityInput(
            tenant_id="local",
            job_ids=(
                JobId("60000000-0000-4000-8000-000000000010"),
                JobId("60000000-0000-4000-8000-000000000010"),
            ),
            limit=1,
        )
    )

    assert result["status"] == "ok"
    assert result["stages"][0]["enrichedJobIds"] == ["60000000-0000-4000-8000-000000000010"]
    assert calls == [
        {
            "max_per_site": 1,
            "workers": 1,
            "tenant_id": "local",
            "job_ids": (JobId("60000000-0000-4000-8000-000000000010"),),
        }
    ]


def _seed_current_job(conn, *, job_id, url: str, title: str = "Closed engineering role") -> None:
    discovered_at = "2026-05-29T10:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
        VALUES (?, ?, ?, ?, 'Example', 'example', ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, title, discovered_at),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, discovered_at, discovered_at),
    )
    conn.commit()


def test_inactive_cascade_snapshot_uses_current_job_id_and_keeps_url_as_locator(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_id = canonical_job_id("43c31e55-7ac4-4e5f-afbe-7612180ef829")
    url = "https://example.com/jobs/closed"
    try:
        _seed_current_job(conn, job_id=job_id, url=url)
        _record_posting_snapshot_from_cascade(
            conn,
            job_id=job_id,
            url=url,
            source_id="jobspy",
            title="Closed engineering role",
            cascade_result={
                "status": "inactive",
                "tier_used": 1,
                "full_description": _long_description(),
                "application_url": None,
                "active_state": "closed",
                "verification_method": "closed_marker",
            },
            captured_at="2026-05-29T12:00:00+00:00",
        )

        snapshot_set = conn.execute(
            """
            SELECT job_id, latest_active_state
            FROM posting_snapshot_sets
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (str(job_id),),
        ).fetchone()
        event = conn.execute(
            """
            SELECT job_id, payload_json, entity_ref
            FROM job_events
            WHERE event_type = 'PostingContentSnapshotCaptured'
            ORDER BY event_id DESC
            LIMIT 1
            """
        ).fetchone()

        quarantine = conn.execute(
            """
            SELECT job_id, posting_url
            FROM discovery_quarantine_entries
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (str(job_id),),
        ).fetchone()

        assert snapshot_set["job_id"] == str(job_id)
        assert snapshot_set["latest_active_state"] == "closed"
        assert event["job_id"] == str(job_id)
        payload = json.loads(event["payload_json"])
        assert payload["jobId"] == str(job_id)
        assert payload["snapshotRef"] == f"{job_id}:1"
        assert event["entity_ref"] == f"{job_id}:1"
        assert quarantine is not None
        assert quarantine["job_id"] == str(job_id)
        assert quarantine["posting_url"] == url
        assert "job_url" not in {row["name"] for row in conn.execute("PRAGMA table_info(posting_snapshot_sets)")}
        assert "job_key" not in {row["name"] for row in conn.execute("PRAGMA table_info(discovery_quarantine_entries)")}
    finally:
        close_connection(db_path)


def test_snapshot_failure_uses_current_job_id_for_state_and_events(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    job_id = canonical_job_id("9796a7ae-a520-4d7d-af21-c5474743e580")
    url = "https://example.com/jobs/removed"
    try:
        _seed_current_job(conn, job_id=job_id, url=url)
        _record_posting_snapshot_failure_from_cascade(
            conn,
            job_id=job_id,
            url=url,
            source_id="jobspy",
            cascade_result={
                "status": "inactive",
                "error": "posting removed",
                "tier_used": 1,
                "active_state": "removed",
                "verification_method": "http_status",
                "http_status": 404,
            },
            failed_at="2026-05-29T12:00:00+00:00",
        )

        snapshot_set = conn.execute(
            """
            SELECT job_id, latest_active_state
            FROM posting_snapshot_sets
            WHERE tenant_id = 'local' AND job_id = ?
            """,
            (str(job_id),),
        ).fetchone()
        event = conn.execute(
            """
            SELECT job_id, payload_json
            FROM job_events
            WHERE event_type = 'PostingContentSnapshotFailed'
            ORDER BY event_id DESC
            LIMIT 1
            """
        ).fetchone()

        assert snapshot_set is not None
        assert snapshot_set["job_id"] == str(job_id)
        assert snapshot_set["latest_active_state"] == "removed"
        assert event is not None
        assert event["job_id"] == str(job_id)
        assert json.loads(event["payload_json"])["jobId"] == str(job_id)
    finally:
        close_connection(db_path)
