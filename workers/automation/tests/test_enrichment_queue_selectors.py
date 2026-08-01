"""Phase 7 / S-26 + S-27 regression: worker queue selectors and stats
must read the canonical enrichment fields from ``job_enrichments`` (the
new write target) and not from the legacy ``jobs.full_description`` /
``jobs.application_url`` / ``jobs.detail_scraped_at`` / ``jobs.detail_error``
columns (which are left NULL on the new path).

Without these fixes (mirrors the Phase-5/6 pattern):

  * ``run_enrichment`` re-picks the same job forever — ``pending_detail``
    keeps matching because ``jobs.detail_scraped_at`` is NULL.
  * ``run_scoring`` is starved — newly-enriched jobs never appear under
    ``pending_score`` because the selector reads bare
    ``jobs.full_description``.
  * ``get_stats`` reports stale ``pending_detail`` / ``with_description``
    / ``detail_errors`` counts — dashboard funnel goes wrong.

Each test seeds a Job row, persists a ``JobEnrichment`` through the
``EnrichmentRepository.save`` path (so legacy columns stay NULL), and
asserts the selector / stat reflects the new repository state.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest

from jobctrl.database import (
    get_jobs_by_stage,
    get_stats,
    init_db,
)
from jobctrl.domain.enrichment import (
    ApplicationUrl,
    EnrichmentError,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
from jobctrl.state import utc_now


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _seed_discovered(conn: sqlite3.Connection, url: str) -> JobId:
    """Insert a discovered Job row WITHOUT any legacy enrichment columns."""
    job_id = canonical_job_id(str(uuid5(NAMESPACE_URL, f"{LOCAL_TENANT}:{url}")))
    discovered_at = "2024-01-01T00:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), url, "Engineer", "Acme", discovered_at),
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
    return job_id


def _mark_closed(conn: sqlite3.Connection, job_id: JobId, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_active_state, updated_at
        ) VALUES (?, ?, '{}', ?, ?)
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (str(LOCAL_TENANT), str(job_id), state, utc_now()),
    )
    conn.commit()


def _save_enriched(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    description: str = "Real description from repository",
    apply_url: str = "https://apply",
) -> None:
    """Save an enriched aggregate via the new repository (legacy cols stay NULL)."""
    repo = SqliteEnrichmentRepository(conn)
    agg = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        .start_attempt(
            extraction_tier=ExtractionTier.JSON_LD,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        .succeed_attempt(
            full_description=FullDescription(text=description),
            application_url=ApplicationUrl(value=apply_url),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    repo.save(agg)


def _save_failed(conn: sqlite3.Connection, job_id: JobId) -> None:
    repo = SqliteEnrichmentRepository(conn)
    agg = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT,
            job_id=job_id,
            updated_at="t0",
        )
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .fail_attempt(
            error=EnrichmentError(code="HTTP_404", message="Not found", retryable=False),
            finished_at="t1",
        )
    )
    repo.save(agg)


def _save_score(conn: sqlite3.Connection, job_id: JobId, fit_score: int) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 1, ?, '{}', '[]', ?)
        """,
        (str(LOCAL_TENANT), str(job_id), fit_score, utc_now()),
    )
    conn.commit()


def _save_approved_resume_with_pdf(conn: sqlite3.Connection, job_id: JobId) -> None:
    created_at = utc_now()
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (str(LOCAL_TENANT), str(job_id), created_at, created_at),
    )
    for artifact_type in ("tailored_resume", "resume_pdf"):
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, 'approved', ?, 'text', ?)
            """,
            (
                str(LOCAL_TENANT),
                str(job_id),
                artifact_type,
                f"{job_id}:{artifact_type}",
                f"/tmp/{job_id}-{artifact_type}",
                created_at,
            ),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Queue selectors
# ---------------------------------------------------------------------------


def test_pending_detail_excludes_jobs_with_enrichment_row(conn: sqlite3.Connection) -> None:
    """A job whose enrichment landed in job_enrichments should NOT be
    re-picked by ``pending_detail``. Without the new join the selector
    would loop forever because ``jobs.detail_scraped_at`` is NULL."""
    enriched_job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _seed_discovered(conn, "https://example.com/jobs/2")
    _save_enriched(conn, enriched_job_id)

    rows = get_jobs_by_stage(conn, "pending_detail")
    urls = {row["url"] for row in rows}
    assert urls == {"https://example.com/jobs/2"}


def test_closed_postings_are_excluded_from_enrichment_queues(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jobctrl import pipeline
    from jobctrl.pipeline import runner as pipeline_runner

    pending_url = "https://example.com/jobs/closed-pending-detail"
    enriched_url = "https://example.com/jobs/closed-enriched"
    pending_job_id = _seed_discovered(conn, pending_url)
    enriched_job_id = _seed_discovered(conn, enriched_url)
    _save_enriched(conn, enriched_job_id)
    _mark_closed(conn, pending_job_id)
    _mark_closed(conn, enriched_job_id)
    monkeypatch.setattr(pipeline_runner, "get_connection", lambda: conn)

    assert {row["url"] for row in get_jobs_by_stage(conn, "pending_detail")} == set()
    assert {row["url"] for row in get_jobs_by_stage(conn, "enriched")} == set()
    assert {row["url"] for row in get_jobs_by_stage(conn, "pending_score")} == set()
    assert pipeline._count_pending("enrich") == 0
    assert pipeline._count_pending("score") == 0


def test_pending_score_includes_jobs_enriched_via_repository(conn: sqlite3.Connection) -> None:
    """``pending_score`` must read through ``_EFFECTIVE_FULL_DESCRIPTION``
    so newly-enriched jobs appear immediately."""
    job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _save_enriched(conn, job_id)
    rows = get_jobs_by_stage(conn, "pending_score")
    assert len(rows) == 1
    assert rows[0]["url"] == "https://example.com/jobs/1"


def test_enriched_selector_returns_jobs_enriched_via_repository(conn: sqlite3.Connection) -> None:
    enriched_job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _seed_discovered(conn, "https://example.com/jobs/2")
    _save_enriched(conn, enriched_job_id)
    rows = get_jobs_by_stage(conn, "enriched")
    assert {row["url"] for row in rows} == {"https://example.com/jobs/1"}


def test_jobs_by_stage_promotes_je_columns_into_legacy_slots(
    conn: sqlite3.Connection,
) -> None:
    """Legacy consumers reading ``row["full_description"]`` /
    ``row["application_url"]`` / ``row["detail_scraped_at"]`` should
    see the canonical values from ``job_enrichments``."""
    job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _save_enriched(
        conn,
        job_id,
        description="From repository write",
        apply_url="https://example.com/apply",
    )
    rows = get_jobs_by_stage(conn, "enriched")
    assert len(rows) == 1
    assert rows[0]["full_description"] == "From repository write"
    assert rows[0]["application_url"] == "https://example.com/apply"
    assert rows[0]["detail_scraped_at"] is not None


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


def test_stats_pending_detail_reads_through_enrichment_join(conn: sqlite3.Connection) -> None:
    enriched_job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _seed_discovered(conn, "https://example.com/jobs/2")
    _save_enriched(conn, enriched_job_id)
    stats = get_stats(conn)
    assert stats["pending_detail"] == 1  # only jobs/2
    assert stats["with_description"] == 1


def test_stats_detail_errors_reads_failed_status(conn: sqlite3.Connection) -> None:
    job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _save_failed(conn, job_id)
    stats = get_stats(conn)
    assert stats["detail_errors"] >= 1


def test_pending_apply_reads_through_application_url_join(conn: sqlite3.Connection) -> None:
    """The ``pending_apply`` selector requires application_url; the new
    enrichment join must surface it from ``job_enrichments``."""
    job_id = _seed_discovered(conn, "https://example.com/jobs/1")
    _save_enriched(conn, job_id)
    _save_score(conn, job_id, 8)
    _save_approved_resume_with_pdf(conn, job_id)
    rows = get_jobs_by_stage(conn, "pending_apply")
    assert len(rows) == 1
    assert rows[0]["application_url"] == "https://apply"


# ---------------------------------------------------------------------------
# Round-1 review B1 regression — reset_job_stage("enrich") must reset the
# JobEnrichment aggregate, otherwise retry-enrich is a silent no-op.
# ---------------------------------------------------------------------------


def test_reset_job_stage_enrich_clears_job_enrichments_aggregate(
    conn: sqlite3.Connection,
) -> None:
    """After ``reset_job_stage(stage='enrich')`` the queue selector
    must re-pick the job. Pre-fix, ``current_status`` stays
    ``'enriched'`` and ``_ENRICHMENT_PENDING`` permanently excludes the
    row."""
    from jobctrl.state import reset_job_stage

    url = "https://example.com/jobs/RESET"
    job_id = _seed_discovered(conn, url)
    _save_enriched(conn, job_id)

    # Sanity check: the row IS enriched after the save.
    repo = SqliteEnrichmentRepository(conn)
    loaded = repo.load(LOCAL_TENANT, job_id)
    assert loaded is not None and loaded.is_enriched

    # The reset call clears the aggregate (B1 fix).
    reset_job_stage(conn, url, "enrich", reset_attempts=True)

    # Aggregate is now pending — terminal-state fields cleared.
    after_reset = repo.load(LOCAL_TENANT, job_id)
    assert after_reset is not None
    assert after_reset.is_pending
    assert after_reset.full_description is None
    assert after_reset.application_url is None
    assert after_reset.enriched_at is None
    assert after_reset.extraction_tier is None

    # And the queue selector re-picks the row.
    pending = get_jobs_by_stage(conn, "pending_detail")
    assert {row["url"] for row in pending} == {url}


def test_reset_job_stage_enrich_is_noop_when_no_aggregate_exists(
    conn: sqlite3.Connection,
) -> None:
    """Reset for a job whose enrichment row was never written must not
    crash — the next pipeline run creates the row when it starts the
    first attempt."""
    from jobctrl.state import reset_job_stage

    url = "https://example.com/jobs/NO_AGG"
    _seed_discovered(conn, url)
    # No save — the row in ``job_enrichments`` does not exist.
    reset_job_stage(conn, url, "enrich", reset_attempts=True)
    # Queue selector still reports the job as pending (it always was).
    pending = get_jobs_by_stage(conn, "pending_detail")
    assert {row["url"] for row in pending} == {url}


# ---------------------------------------------------------------------------
# Round-1 review B3 + B4 regression — pipeline._PENDING_SQL must see new
# enrichment writes (otherwise the worker reports infinite enrich work
# and zero score/tailor/cover work).
# ---------------------------------------------------------------------------


def test_pending_sql_enrich_excludes_new_path_enriched_jobs(
    conn: sqlite3.Connection, monkeypatch
) -> None:
    """``pipeline._PENDING_SQL['enrich']`` must read through
    ``_ENRICHMENT_JOIN`` so jobs enriched via the repository drop out
    of the count."""
    from jobctrl.pipeline import _PENDING_SQL

    enriched_job_id = _seed_discovered(conn, "https://example.com/jobs/A")
    _seed_discovered(conn, "https://example.com/jobs/B")
    _save_enriched(conn, enriched_job_id)

    pending_count = conn.execute(_PENDING_SQL["enrich"]).fetchone()[0]
    assert pending_count == 1  # only B is pending


def test_pending_detail_excludes_legacy_stage_succeeded_without_aggregate(
    conn: sqlite3.Connection,
) -> None:
    """Live local DBs may have canonical succeeded stage rows before a
    ``job_enrichments`` aggregate exists. Those rows must not be
    re-enriched unless the stage is reset to pending."""
    from jobctrl.pipeline import _PENDING_SQL
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    legacy_url = "https://example.com/jobs/LEGACY"
    pending_url = "https://example.com/jobs/PENDING"
    legacy_job_id = _seed_discovered(conn, legacy_url)
    _seed_discovered(conn, pending_url)
    conn.execute(
        """
        UPDATE jobs
        SET full_description = ?, detail_scraped_at = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            "Legacy description",
            "2024-01-02T00:00:00+00:00",
            str(LOCAL_TENANT),
            str(legacy_job_id),
        ),
    )
    ensure_job_stage_rows(conn, legacy_job_id)
    set_stage_state(
        conn,
        legacy_job_id,
        "enrich",
        "succeeded",
        finished_at="2024-01-02T00:00:00+00:00",
        validate_transition=False,
    )
    conn.commit()

    rows = get_jobs_by_stage(conn, "pending_detail")
    assert {row["url"] for row in rows} == {pending_url}
    assert conn.execute(_PENDING_SQL["enrich"]).fetchone()[0] == 1


def test_run_detail_scraper_skips_legacy_stage_succeeded_without_aggregate(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from jobctrl.enrichment import detail
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    legacy_url = "https://example.com/jobs/LEGACY-RUNNER"
    pending_url = "https://example.com/jobs/PENDING-RUNNER"
    legacy_job_id = _seed_discovered(conn, legacy_url)
    pending_job_id = _seed_discovered(conn, pending_url)
    conn.execute(
        """
        UPDATE jobs
        SET full_description = ?, detail_scraped_at = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            "Legacy description",
            "2024-01-02T00:00:00+00:00",
            str(LOCAL_TENANT),
            str(legacy_job_id),
        ),
    )
    ensure_job_stage_rows(conn, legacy_job_id)
    set_stage_state(
        conn,
        legacy_job_id,
        "enrich",
        "succeeded",
        finished_at="2024-01-02T00:00:00+00:00",
        validate_transition=False,
    )
    conn.commit()

    batches: list[list[tuple[str, str]]] = []

    def fake_scrape_site_batch(
        _conn: sqlite3.Connection | None,
        _site: str,
        jobs: list[tuple[str, str]],
        *,
        max_jobs: int | None = None,
        on_job_enriched=None,
        **_politeness: object,
    ) -> dict:
        batches.append(jobs[: max_jobs or None])
        return {"processed": len(jobs), "ok": 0, "partial": 0, "error": 0, "tiers": {}}

    monkeypatch.setattr(detail, "scrape_site_batch", fake_scrape_site_batch)

    detail._run_detail_scraper(conn, max_per_site=1, workers=1)

    assert batches == [[(str(pending_job_id), "Engineer")]]


def test_pending_sql_score_includes_new_path_enriched_jobs(
    conn: sqlite3.Connection,
) -> None:
    """``pipeline._PENDING_SQL['score']`` must read through
    ``_EFFECTIVE_FULL_DESCRIPTION`` so newly-enriched jobs surface as
    scorable. Pre-fix the bare ``full_description`` column is NULL on
    the new path and the count stays at 0 forever."""
    from jobctrl.pipeline import _PENDING_SQL

    job_id = _seed_discovered(conn, "https://example.com/jobs/A")
    _save_enriched(conn, job_id)

    pending_score = conn.execute(_PENDING_SQL["score"]).fetchone()[0]
    assert pending_score == 1


def test_pending_sql_tailor_sees_new_path_enriched_scored_jobs(
    conn: sqlite3.Connection,
) -> None:
    """The ``tailor`` predicate also reads
    ``_EFFECTIVE_FULL_DESCRIPTION`` — a job enriched via the repository
    AND scored via the canonical aggregate should surface for tailoring."""
    from jobctrl.pipeline import _PENDING_SQL

    job_id = _seed_discovered(conn, "https://example.com/jobs/A")
    _save_enriched(conn, job_id)
    # Score through the canonical aggregate so this test isolates the
    # enrichment join; score-join behavior is covered separately.
    _save_score(conn, job_id, 9)

    pending_tailor = conn.execute(_PENDING_SQL["tailor"], (7,)).fetchone()[0]
    assert pending_tailor == 1
