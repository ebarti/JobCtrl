"""Enrichment quality gate regression.

The enrich path records a ``PostingContentSnapshot`` whose ``confidence`` and
``quarantine_reason`` describe how trustworthy the captured description is, then
promotes the ``JobEnrichment`` aggregate to ``enriched`` regardless. Scoring and
materials read ``full_description`` through a COALESCE that only gated on active
state, so a LOW-confidence / quarantined description fed tailoring as if
trustworthy.

These tests pin the recall-safe gate: a quarantined LOW-confidence job is kept
out of the expensive tailoring / cover / apply prep queues, but stays scoreable
(cheap triage) and visible with its quality signal surfaced on the read model. A
snapshot missing only its apply URL, or one admitted through a policy override,
is not gated — a recoverable missing field must never starve tailoring.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jobhunter.database import (
    count_ready_to_apply,
    ensure_posting_snapshot_tables,
    get_jobs_by_stage,
    get_stats,
    init_db,
    load_job_with_enrichment,
)
from jobhunter.domain.enrichment import (
    ActiveState,
    PostingSnapshotSet,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.materials import (
    Artifact,
    ArtifactType,
    JudgeVerdict,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobhunter.domain.scoring import (
    EligibilityAssessment,
    FitScore,
    JobScore,
    MatchedKeywords,
    ScoreBreakdown,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.enrichment.sqlite_repository import (
    SqlitePostingSnapshotSetRepository,
)
from jobhunter.infrastructure.materials import SqliteMaterialsRepository
from jobhunter.infrastructure.scoring import SqliteScoreRepository

NOW = "2026-05-13T00:00:00+00:00"
_DESCRIPTION = "Need Python and SQL. " * 20


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


def _seed_enriched_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", _DESCRIPTION, "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()


def _save_score(conn: sqlite3.Connection, url: str, fit: int = 9) -> None:
    SqliteScoreRepository(conn).save(
        JobScore.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            fit_score=FitScore.create(fit),
            breakdown=ScoreBreakdown(reasoning="ok", eligibility=EligibilityAssessment()),
            matched_keywords=MatchedKeywords.from_iterable(["python"]),
            scored_at=datetime.now(timezone.utc).isoformat(),
        )
    )


def _record_snapshot(
    conn: sqlite3.Connection,
    url: str,
    *,
    confidence: SnapshotConfidence,
    quarantine_reason: QuarantineReason,
    apply_url: str | None = "https://apply.example/x",
    active_state: ActiveState = ActiveState.ACTIVE,
) -> None:
    repo = SqlitePostingSnapshotSetRepository(conn)
    snapshot_set = PostingSnapshotSet.empty(
        tenant_id=LOCAL_TENANT, job_id=JobId(url), updated_at=NOW
    )
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id="acme",
        extraction_tier="css_selectors",
        description_hash=SnapshotDescriptionHash.from_text(_DESCRIPTION),
        apply_url=SnapshotApplyUrl(value=apply_url) if apply_url else None,
        active_state=active_state,
        confidence=confidence,
        quarantine_reason=quarantine_reason,
        captured_at=NOW,
    )
    repo.save(snapshot_set)


def _urls(rows: list[dict]) -> set[str]:
    return {row["url"] for row in rows}


def _add_approved_resume_with_pdf(conn: sqlite3.Connection, url: str) -> None:
    """Give a job an approved tailored resume + resume PDF (no cover) so it
    qualifies for the cover / apply / ready selectors."""
    SqliteMaterialsRepository(conn).save(
        MaterialsSetFactory.initial(
            tenant_id=LOCAL_TENANT,
            job_id=JobId(url),
            created_at="2024-01-01T00:00:00+00:00",
        )
        .with_resume_attempt(
            Artifact.create(
                type=ArtifactType.TAILORED_RESUME,
                path="/tmp/r.txt",
                created_at="2024-01-02T00:00:00+00:00",
                render_format=RenderFormat.TEXT,
            ),
            validation=ValidationResult.success(),
            verdict=JudgeVerdict.passed(),
            updated_at="2024-01-02T00:00:00+00:00",
        )
        .with_resume_pdf(
            Artifact.create(
                type=ArtifactType.RESUME_PDF,
                path="/tmp/r.pdf",
                created_at="2024-01-02T01:00:00+00:00",
                render_format=RenderFormat.LATEX_PDF,
            ),
            updated_at="2024-01-02T01:00:00+00:00",
        )
    )


def test_low_confidence_quarantined_job_excluded_from_tailoring_but_scored_and_visible(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/low"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
    )

    # Excluded from the expensive tailoring prep queue.
    assert url not in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))

    # Still scoreable / scored (cheap triage stays open).
    scored = {row["url"]: row for row in get_jobs_by_stage(conn=conn, stage="scored")}
    assert url in scored

    # Nothing silently disappears: the quality signal is surfaced on the list row.
    assert scored[url]["enrichment_confidence"] == "low"
    assert scored[url]["enrichment_quarantine_reason"] == "low_confidence_extraction"

    # ... and on the single-job detail read model.
    detail = load_job_with_enrichment(conn, url)
    assert detail is not None
    assert detail["enrichment_confidence"] == "low"
    assert detail["enrichment_quarantine_reason"] == "low_confidence_extraction"


def test_low_confidence_job_still_selected_for_scoring(conn: sqlite3.Connection) -> None:
    url = "https://example.com/job/low-unscored"
    _seed_enriched_job(conn, url)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
    )

    assert url in _urls(get_jobs_by_stage(conn=conn, stage="pending_score"))


def test_normal_confidence_job_flows_through_scoring_and_tailoring(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/high"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.HIGH,
        quarantine_reason=QuarantineReason.NONE,
    )

    assert url in _urls(get_jobs_by_stage(conn=conn, stage="scored"))
    assert url in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))


def test_high_confidence_snapshot_missing_apply_url_is_not_gated(
    conn: sqlite3.Connection,
) -> None:
    # instruction #3: a missing apply URL is a different, recoverable condition.
    # A MEDIUM/HIGH snapshot quarantined for review must still reach tailoring.
    url = "https://example.com/job/no-apply"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.MEDIUM,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
        apply_url=None,
    )

    assert url in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))


def test_operator_override_low_confidence_snapshot_is_not_gated(
    conn: sqlite3.Connection,
) -> None:
    # A LOW snapshot admitted through a policy filter override carries reason
    # NONE; the user's explicit override must be honoured.
    url = "https://example.com/job/override"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.NONE,
    )

    assert url in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))


def test_stats_exclude_quarantined_low_confidence_from_untailored_eligible(
    conn: sqlite3.Connection,
) -> None:
    good = "https://example.com/job/good"
    bad = "https://example.com/job/bad"
    for url in (good, bad):
        _seed_enriched_job(conn, url)
        _save_score(conn, url, fit=9)
    _record_snapshot(
        conn, good, confidence=SnapshotConfidence.HIGH, quarantine_reason=QuarantineReason.NONE
    )
    _record_snapshot(
        conn,
        bad,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
    )

    stats = get_stats(conn)
    assert stats["untailored_eligible"] == 1


def test_repository_persists_latest_confidence_and_quarantine(
    conn: sqlite3.Connection,
) -> None:
    url = "https://example.com/job/persist"
    _seed_enriched_job(conn, url)
    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
    )

    row = conn.execute(
        "SELECT latest_confidence, latest_quarantine_reason "
        "FROM posting_snapshot_sets WHERE job_url = ?",
        (url,),
    ).fetchone()
    assert row["latest_confidence"] == "low"
    assert row["latest_quarantine_reason"] == "low_confidence_extraction"


def test_migration_backfills_latest_snapshot_quality(tmp_path: Path) -> None:
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE posting_snapshot_sets (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            job_url                  TEXT NOT NULL,
            snapshot_set_json        TEXT NOT NULL,
            latest_snapshot_version  INTEGER NOT NULL DEFAULT 0,
            latest_active_state      TEXT NOT NULL DEFAULT 'unknown',
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url)
        )
        """
    )
    snapshot_json = json.dumps(
        {
            "snapshots": [
                {"confidence": "high", "quarantine_reason": "none"},
                {"confidence": "low", "quarantine_reason": "low_confidence_extraction"},
            ]
        }
    )
    conn.execute(
        "INSERT INTO posting_snapshot_sets "
        "(tenant_id, job_url, snapshot_set_json, latest_snapshot_version, latest_active_state, updated_at) "
        "VALUES ('local', 'u', ?, 2, 'active', ?)",
        (snapshot_json, NOW),
    )
    conn.commit()

    ensure_posting_snapshot_tables(conn)

    row = conn.execute(
        "SELECT latest_confidence, latest_quarantine_reason "
        "FROM posting_snapshot_sets WHERE job_url = 'u'"
    ).fetchone()
    assert row["latest_confidence"] == "low"
    assert row["latest_quarantine_reason"] == "low_confidence_extraction"
    conn.close()


def test_snapshot_captured_event_records_confidence_and_quarantine(
    conn: sqlite3.Connection,
) -> None:
    from jobhunter.enrichment.detail import _record_posting_snapshot_from_cascade

    url = "https://example.com/job/event"
    _seed_enriched_job(conn, url)
    cascade_result = {
        "full_description": "short",
        "application_url": None,
        "tier_used": 3,
        "active_state": "active",
        "verification_method": "default_body_present",
    }
    _record_posting_snapshot_from_cascade(
        conn,
        url=url,
        source_id="acme",
        title="Engineer",
        cascade_result=cascade_result,
        captured_at=NOW,
    )

    row = conn.execute(
        "SELECT payload_json FROM job_events "
        "WHERE event_type = 'PostingContentSnapshotCaptured' "
        "ORDER BY event_id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    payload = json.loads(row["payload_json"])
    assert payload["confidence"] == "low"
    assert payload["quarantine_reason"] == "low_confidence_extraction"
    assert payload["quarantined"] is True


def test_no_snapshot_backlog_job_is_never_gated_from_any_selector(
    conn: sqlite3.Connection,
) -> None:
    """Recall guard: a job with NO ``posting_snapshot_sets`` row (the entire
    pre-feature backlog, ``latest_confidence IS NULL``) must pass every gated
    selector. The ``latest_confidence IS NULL`` disjunct + LEFT JOIN is what
    keeps that backlog alive; a NULL-unsafe predicate (e.g. bare
    ``latest_confidence != 'low'``, where SQL ``NULL != 'low'`` is not true)
    would silently starve all of it. This test must fail if that safety is
    dropped.
    """
    # Enriched + scored, no materials, no snapshot -> tailoring + stat.
    untailored = "https://example.com/backlog/untailored"
    _seed_enriched_job(conn, untailored)
    _save_score(conn, untailored, fit=9)

    # Enriched + scored + approved resume/PDF + apply URL, no snapshot ->
    # cover / apply / ready selectors.
    tailored = "https://example.com/backlog/tailored"
    _seed_enriched_job(conn, tailored)
    _save_score(conn, tailored, fit=9)
    conn.execute(
        "UPDATE jobs SET application_url = 'https://apply.example/backlog' WHERE url = ?",
        (tailored,),
    )
    conn.commit()
    _add_approved_resume_with_pdf(conn, tailored)

    # No snapshot rows exist for either job.
    assert (
        conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    )

    assert untailored in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))
    assert tailored in _urls(get_jobs_by_stage(conn=conn, stage="pending_cover", min_score=7))
    assert tailored in _urls(get_jobs_by_stage(conn=conn, stage="pending_apply", min_score=7))

    stats = get_stats(conn)
    assert stats["untailored_eligible"] >= 1
    assert stats["ready_to_apply"] >= 1
    assert count_ready_to_apply(conn, min_score=7) >= 1

    # The read model reports NULL confidence for the backlog job, not a gate.
    detail = load_job_with_enrichment(conn, untailored)
    assert detail is not None
    assert detail["enrichment_confidence"] is None
    assert detail["enrichment_quarantine_reason"] is None


def test_reenrichment_to_high_self_heals_a_quarantined_job_into_tailoring(
    conn: sqlite3.Connection,
) -> None:
    """The latest snapshot is authoritative: a job quarantined LOW (gated out)
    that is later re-enriched to a HIGH / non-quarantined snapshot returns to
    the tailoring queue automatically, and the read model reflects the heal."""
    url = "https://example.com/job/self-heal"
    _seed_enriched_job(conn, url)
    _save_score(conn, url, fit=9)

    _record_snapshot(
        conn,
        url,
        confidence=SnapshotConfidence.LOW,
        quarantine_reason=QuarantineReason.LOW_CONFIDENCE_EXTRACTION,
    )
    assert url not in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))

    # Re-enrich: append a fresh confident snapshot to the same aggregate.
    repo = SqlitePostingSnapshotSetRepository(conn)
    snapshot_set = repo.load(LOCAL_TENANT, JobId(url))
    assert snapshot_set is not None
    snapshot_set, _ = snapshot_set.record_snapshot(
        source_id="acme",
        extraction_tier="json_ld",
        description_hash=SnapshotDescriptionHash.from_text(_DESCRIPTION),
        apply_url=SnapshotApplyUrl(value="https://apply.example/x"),
        active_state=ActiveState.ACTIVE,
        confidence=SnapshotConfidence.HIGH,
        quarantine_reason=QuarantineReason.NONE,
        captured_at="2026-05-13T01:00:00+00:00",
    )
    repo.save(snapshot_set)

    assert url in _urls(get_jobs_by_stage(conn=conn, stage="pending_tailor", min_score=7))

    detail = load_job_with_enrichment(conn, url)
    assert detail is not None
    assert detail["enrichment_confidence"] == "high"
    assert detail["enrichment_quarantine_reason"] == "none"
