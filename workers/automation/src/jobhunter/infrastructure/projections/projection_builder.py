"""ProjectionBuilder — wires the in-process event bus into the SQLite read-model.

Per ddd-target.md §6.6 the Operations context maintains denormalised
projections by subscribing to domain events emitted from every other
context.  In the local-first architecture this is a synchronous,
in-process subscriber: the wildcard handler runs on every published
event and rebuilds the affected projection rows from canonical
aggregate state (jobs / job_stage_states / job_scores / job_materials /
job_enrichments / job_artifacts / jobhunter_deleted_jobs) plus the
``job_events`` row stream (which now sources ``apply_run_projections``
directly — PR 4 of the Temporal stack collapsed the bespoke
``apply_runs`` table into the workflow run history).

This is intentionally **derive-from-canonical** rather than
**derive-from-event-payload**: the projection refresh re-reads the
authoritative aggregate tables for each dirty job, which means

    1. The projection logic doesn't have to mirror every domain-event
       payload shape — it owns the join shape once.
    2. Out-of-order or partially-missed events are self-correcting on
       the next refresh.
    3. The same code path serves the ``replay_from_events`` initial
       backfill and the ``process_event`` live update.

Watermark semantics (``event_watermarks`` table from Phase 3 / S-10):
the builder reads ``last_event_id`` for the
``operations_projections`` projection name, processes every newer
``job_events`` row, and advances the watermark in the same
transaction.  On startup the projection tables may be empty AND the
watermark zero — we handle that by force-marking every existing
``jobs`` row as dirty so the initial backfill catches pre-event-history
rows.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from jobhunter.domain.events.base import DomainEvent
from jobhunter.domain.identifiers import JobId
from jobhunter.domain.operations.projections import (
    ApplyRunProjection,
    ArtifactListProjection,
    DashboardFunnelStage,
    DashboardProjection,
    JobDetailProjection,
    JobListProjection,
    StageProjection,
)
from jobhunter.domain.ports.events import EventPublisher, Subscription
from jobhunter.domain.tenant import LOCAL_TENANT, TenantId
from jobhunter.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobhunter.infrastructure.projections.sqlite_projection_store import (
    SqliteProjectionStore,
    ensure_projection_tables,
)
from jobhunter.infrastructure.projections.source_quality import (
    SOURCE_QUALITY_EVENT_TYPES,
    event_row_from_sql,
    project_source_quality,
)


@dataclass(frozen=True)
class _ProvenanceProjection:
    """The latest generation's provenance + coverage + voice read shapes per artifact.

    Each maps ``artifact_id -> serialised JSON`` so the artifact projection can
    attach the canonical Phase-2 (provenance) and Phase-3 (coverage + voice) read
    shapes directly, all loaded once from the canonical ``job_bullet_provenance``
    rows by the single projection owner.
    """

    provenance: dict[str, str]
    coverage: dict[str, str]
    voice: dict[str, str]


log = logging.getLogger(__name__)


PROJECTION_NAME = "operations_projections"
COMPENSATION_PROJECTION_VERSION = 1
POSTED_COMPENSATION_WARNING_MESSAGES = {
    "ambiguous_multiple_amounts": "Multiple compensation amounts were present and the primary range is ambiguous.",
    "bonus_component": "The source text mentions bonus compensation.",
    "broad_range": "The posted range is broad enough to reduce precision.",
    "commission_component": "The source text mentions commission compensation.",
    "equity_component": "The source text mentions equity or stock compensation.",
    "hourly_period": "The source text uses an hourly compensation period.",
    "missing_currency": "The parser could not identify an explicit currency.",
    "missing_period": "The parser could not identify an explicit compensation period.",
    "monthly_period": "The source text uses a monthly compensation period.",
    "no_amount_found": "No compensation amount could be safely extracted.",
    "one_sided_range": "The posted range is one-sided.",
    "ote_component": "The source text mentions on-target earnings.",
    "source_text_truncated": "The stored source text was truncated to the bounded salary excerpt limit.",
}
MARKET_COMPENSATION_WARNING_MESSAGES = {
    "company_role_fallback": "The estimate fell back from exact company-role evidence to adjacent company or tier evidence.",
    "location_mismatch": "Reported compensation locations did not strongly match the job location.",
    "low_sample_count": "Reported compensation sample support is low.",
    "reported_compensation_sample": "The estimate uses reported compensation rows for the job company and role.",
    "posted_salary_sample": "The estimate uses employer-posted salary text captured by JobHunter.",
    "source_conflict_with_posted_salary": "Reported compensation diverges materially from the posted salary.",
    "stale_source_snapshot": "A source snapshot is stale under the freshness policy.",
    "trimodal_tier_inferred": "The company tier was inferred from reported compensation amounts.",
}
MARKET_COMPENSATION_REASON_MESSAGES = {
    "low_sample_count": "Reported compensation sample support is below the configured confidence threshold.",
    "missing_company": "The job has no company name to match reported compensation.",
    "missing_reported_observation": "No reported compensation row matched this job's company and role.",
    "missing_role": "The job has no title/role text to match reported compensation.",
    "source_dispersion_too_high": "Reported compensation rows diverged too much to emit a precise range.",
    "stale_source_snapshot": "A required reported compensation source snapshot is stale under the freshness policy.",
    "unsupported_component": "The compensation component is outside the supported reported compensation model.",
    "unsupported_source": "Unsupported source evidence was rejected.",
    "weak_company_match": "Company match support was too weak for a range.",
    "weak_level_match": "Level/seniority support was too weak for a range.",
    "weak_location_match": "Location support was too weak for a range.",
    "weak_role_match": "Role match support was too weak for a range.",
}
MARKET_SOURCE_DEFAULTS = {
    "levels_fyi": {
        "displayName": "Levels.fyi",
        "sourceType": "reported_compensation",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Levels.fyi reported compensation data",
    },
    "glassdoor": {
        "displayName": "Glassdoor",
        "sourceType": "reported_compensation",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Glassdoor reported compensation data",
    },
    "manual_reported_compensation": {
        "displayName": "Manual reported compensation import",
        "sourceType": "reported_compensation",
        "snapshotVersion": "reported-compensation-import-v1",
        "geographyScope": "reported",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Manual reported compensation import",
    },
    "euro_top_tech": {
        "displayName": "Euro Top Tech",
        "sourceType": "reported_compensation",
        "snapshotVersion": "eurotoptech-data-public",
        "geographyScope": "Europe",
        "aggregateBucket": "reported company-role compensation",
        "attribution": "Euro Top Tech public crowdsourced compensation data",
    },
    "posted_salary_text": {
        "displayName": "Job posting salary text",
        "sourceType": "posted_salary",
        "snapshotVersion": "jobhunter-posted-compensation-v1",
        "geographyScope": "reported",
        "aggregateBucket": "employer-posted company-role compensation",
        "attribution": "Employer-posted salary text captured by JobHunter",
    },
}
MARKET_SAFE_AGGREGATE_BUCKETS = {
    "reported company-role compensation",
    "reported company adjacent-role compensation",
    "same-location role compensation fallback",
    "trimodal tier role fallback",
    "trimodal market baseline fallback",
    "employer-posted company-role compensation",
    "employer-posted same-location role compensation",
    "employer-posted trimodal tier compensation",
    "employer-posted trimodal market baseline",
}
MARKET_SAFE_GEOGRAPHY_SCOPES = {"Europe", "reported"}
MARKET_SAFE_FACTOR_NAMES = {"agreement", "company", "component", "freshness", "level", "location", "role", "sample", "trimodal_tier"}
MARKET_CONFIDENCE_BANDS = {"high", "medium", "low", "none"}
MARKET_RECORDED_STATES = {"unsupported", "source_unavailable", "insufficient_evidence", "estimated_range"}
MARKET_DEFAULT_FACTOR_REASON = "Reported compensation estimate factor recorded by the deterministic company-role estimator."
MARKET_MAX_FACTOR_REASON_LENGTH = 240
MARKET_UNSAFE_FACTOR_REASON_TERMS = (
    "/users/",
    "\\users\\",
    "file://",
    "rawproviderpayload",
    "credential",
    "secret",
    "token",
    "password",
    "api_key",
    "api key",
    "api-key",
    "private",
)

STAGE_ORDER: tuple[str, ...] = (
    "discover",
    "enrich",
    "score",
    "tailor",
    "cover",
    "apply",
)

DEFAULT_MAX_ATTEMPTS: dict[str, int] = {
    "discover": 1,
    "enrich": 3,
    "score": 3,
    "tailor": 5,
    "cover": 5,
    "apply": 3,
}


def _job_list_stage(stage: str | None, *, has_resume: bool = False) -> str:
    return "apply" if stage == "apply" or (stage == "cover" and has_resume) else "discover"

_SOURCE_BOARD_NAMES = {"greenhouse", "linkedin", "talent.com"}


class ProjectionBuilder:
    """In-process projection materialiser.

    Wire it once on worker startup with
    :func:`ProjectionBuilder.subscribe_to`.  Call
    :meth:`refresh` after the canonical write so the derived projections
    catch up.  Tests can also drive it manually via :meth:`refresh` after
    seeding data.

    The builder takes a ``conn_factory`` rather than a fixed
    :class:`sqlite3.Connection` because the in-process bus's wildcard
    subscriber (``_on_event``) fires synchronously on whatever thread
    published the event — and SQLite connections are thread-bound.
    The factory lets ``_on_event`` open a per-call connection on the
    publishing thread (see ``get_connection`` in
    :mod:`jobhunter.database`, which is itself thread-local-cached).

    For single-threaded callers (CLI bootstrap, tests) the factory can
    legitimately return the same shared connection on every call:
    ``ProjectionBuilder(conn_factory=lambda: conn)``.
    """

    def __init__(
        self,
        *,
        conn_factory: Callable[[], sqlite3.Connection],
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> None:
        self._conn_factory = conn_factory
        self._tenant_id: TenantId = tenant_id
        # Thread-local binding scope for refresh().  Each thread that
        # calls refresh() (or _on_event) gets its own conn / store /
        # watermarks rooted at the connection the factory returned on
        # that thread.  This is necessary because the wildcard
        # subscriber fires on whatever thread published the event.
        self._local = threading.local()
        # Schema setup runs once on construction.  We pull a connection
        # from the factory and intentionally do **not** close it: when
        # the factory returns a thread-local cached handle (production)
        # or a shared test handle (``lambda: conn``), closing here would
        # break subsequent callers.  The factory is the right place to
        # own connection lifetime.
        boot_conn = conn_factory()
        ensure_projection_tables(boot_conn)
        boot_conn.commit()

    # ------------------------------------------------------------ subscription

    def subscribe_to(self, publisher: EventPublisher) -> Subscription:
        """Wildcard-subscribe — refresh on every published event."""
        return publisher.subscribe(None, self._on_event)

    def _on_event(self, event: DomainEvent) -> None:
        # Open a thread-local connection via the factory so the refresh
        # runs on whichever thread published the event.  We deliberately
        # do **not** close the connection here: in production the
        # factory is :func:`jobhunter.database.get_connection` which
        # returns the thread-local cached handle that the publishing
        # caller is itself using — closing it would yank the conn out
        # from under the writer.  Tests pass ``lambda: conn`` (shared
        # handle) for the same reason.  The factory owns connection
        # lifetime; the builder must never close.
        try:
            conn = self._conn_factory()
            self._refresh(conn)
        except Exception:  # noqa: BLE001 — projection failure must not break write
            # ``log.exception`` (=== ``log.error(..., exc_info=True)``)
            # records the full traceback.  A silent swallow here is
            # what previously hid the cross-thread ProgrammingError.
            log.exception(
                "ProjectionBuilder failed to refresh after %s", event.event_type
            )

    # ----------------------------------------------------------- thread-local

    @property
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            raise RuntimeError(
                "ProjectionBuilder._conn accessed outside a refresh scope"
            )
        return conn

    @property
    def _store(self) -> SqliteProjectionStore:
        store = getattr(self._local, "store", None)
        if store is None:
            raise RuntimeError(
                "ProjectionBuilder._store accessed outside a refresh scope"
            )
        return store

    @property
    def _watermarks(self) -> SqliteEventWatermarkRepository:
        watermarks = getattr(self._local, "watermarks", None)
        if watermarks is None:
            raise RuntimeError(
                "ProjectionBuilder._watermarks accessed outside a refresh scope"
            )
        return watermarks

    @contextlib.contextmanager
    def _bind(self, conn: sqlite3.Connection):
        """Bind ``conn`` (+ derived adapters) to thread-local state.

        Restores any prior binding on exit so reentrant refreshes from
        the same thread do not clobber each other.
        """
        prev_conn = getattr(self._local, "conn", None)
        prev_store = getattr(self._local, "store", None)
        prev_watermarks = getattr(self._local, "watermarks", None)
        self._local.conn = conn
        self._local.store = SqliteProjectionStore(conn)
        self._local.watermarks = SqliteEventWatermarkRepository(conn)
        try:
            yield
        finally:
            self._local.conn = prev_conn
            self._local.store = prev_store
            self._local.watermarks = prev_watermarks

    # ----------------------------------------------------------------- refresh

    def refresh(self) -> int:
        """Process new ``job_events`` rows and rebuild affected projections.

        Returns the number of dirty jobs processed.  Idempotent: running
        twice in a row produces the same projection state.

        External callers (CLI bootstrap, tests) drive this directly; the
        connection comes from the factory and is **not** closed here —
        the bootstrap path reuses a thread-local cached connection
        (``get_connection`` in :mod:`jobhunter.database`) and tests
        commonly pass ``lambda: conn`` so the same shared handle is
        returned every call.  Only :meth:`_on_event` owns the close
        because it opens a per-event connection on whichever thread
        published the event.
        """
        conn = self._conn_factory()
        return self._refresh(conn)

    def _refresh(self, conn: sqlite3.Connection) -> int:
        """Refresh against an already-opened connection (used by ``_on_event``)."""
        with self._bind(conn):
            return self._refresh_impl()

    def _refresh_impl(self) -> int:
        watermark = self._watermarks.get(PROJECTION_NAME)
        rows = self._conn.execute(
            """
            SELECT event_id, job_url, event_type, occurred_at, payload_json
            FROM job_events
            WHERE event_id > ?
            ORDER BY event_id ASC
            """,
            (watermark,),
        ).fetchall()

        dirty_jobs: set[str] = set()
        source_quality_dirty = False
        max_event_id = watermark
        for row in rows:
            event_id = int(row["event_id"]) if not isinstance(row, tuple) else int(row[0])
            if event_id > max_event_id:
                max_event_id = event_id
            job_url = row["job_url"] if not isinstance(row, tuple) else row[1]
            if job_url:
                dirty_jobs.add(str(job_url))
            event_type = row["event_type"] if not isinstance(row, tuple) else row[2]
            if str(event_type) in SOURCE_QUALITY_EVENT_TYPES:
                source_quality_dirty = True

        # First-run backfill: if projections are empty, mark every
        # existing job as dirty so pre-event-history rows still get
        # projected.  This also covers the case where the projection
        # tables were dropped + recreated.
        if self._store.count_job_list(str(self._tenant_id)) == 0:
            try:
                jobs_rows = self._conn.execute(
                    "SELECT url FROM jobs"
                ).fetchall()
                for jrow in jobs_rows:
                    url = jrow["url"] if not isinstance(jrow, tuple) else jrow[0]
                    if url:
                        dirty_jobs.add(str(url))
            except sqlite3.OperationalError:
                # ``jobs`` table not yet created (very-fresh DB) — nothing
                # to backfill.
                pass
        dirty_jobs.update(self._stale_deleted_projection_jobs())

        # L5 (round-1 review): if there's nothing dirty AND we've already
        # synced past the latest event, skip the O(jobs × stages)
        # dashboard / apply-run rebuilds.  Exception: first-run, when
        # the dashboard row doesn't exist yet — materialise an empty
        # one so reads always return data.
        dashboard_exists = (
            self._conn.execute(
                "SELECT 1 FROM dashboard_projections WHERE tenant_id = ?",
                (str(self._tenant_id),),
            ).fetchone()
            is not None
        )
        source_quality_exists = (
            self._conn.execute(
                "SELECT 1 FROM source_quality_stats WHERE tenant_id = ? LIMIT 1",
                (str(self._tenant_id),),
            ).fetchone()
            is not None
        )
        source_quality_history = source_quality_dirty or self._has_source_quality_history()
        if (
            not dirty_jobs
            and not source_quality_dirty
            and dashboard_exists
            and (source_quality_exists or not source_quality_history)
            and max_event_id == watermark
        ):
            return 0

        # ``record_job_event`` invokes the wildcard subscriber inside the
        # caller's open transaction (e.g. ``acquire_job``'s
        # ``BEGIN IMMEDIATE`` block). Issuing our own ``commit()`` mid-
        # transaction would prematurely release the row lock and break
        # the caller's rollback path. Detect the in-transaction case and
        # let the caller flush both writes; standalone refreshes (the
        # CLI / tests) commit themselves.
        defer_commit = bool(getattr(self._conn, "in_transaction", False))

        if not dirty_jobs:
            # Watermark advanced past events with no job_url (e.g.
            # system events) OR first-run: bump the watermark + ensure
            # the dashboard row exists.
            if source_quality_dirty or (not source_quality_exists and source_quality_history):
                self._rebuild_source_quality()
            if max_event_id > watermark:
                self._watermarks.set(PROJECTION_NAME, max_event_id)
            if not dashboard_exists:
                self._rebuild_dashboard()
            if not defer_commit:
                self._conn.commit()
            return 0

        # PR 4 of the Temporal stack: rebuild ``apply_run_projections``
        # first so ``_rebuild_job`` can read the freshly derived apply
        # lifecycle status when it materialises ``job_list_projections``.
        self._rebuild_apply_runs()
        if source_quality_dirty or (not source_quality_exists and source_quality_history):
            self._rebuild_source_quality()
        for job_url in dirty_jobs:
            self._rebuild_job(job_url)
        self._rebuild_dashboard()
        if max_event_id > watermark:
            self._watermarks.set(PROJECTION_NAME, max_event_id)
        if not defer_commit:
            self._conn.commit()
        return len(dirty_jobs)

    # -------------------------------------------------------------- builders

    def _rebuild_job(self, job_url: str) -> None:
        job_row = self._conn.execute(
            "SELECT * FROM jobs WHERE url = ?", (job_url,)
        ).fetchone()
        if job_row is None:
            # Orphaned event (e.g. job deleted from upstream) — drop projection.
            self._store.delete_job_list(str(self._tenant_id), job_url)
            return

        stages = self._load_stage_projections(job_url)
        score = self._load_latest_score(job_url)
        materials = self._load_latest_materials(job_url)
        employer_analysis_json = self._load_employer_analysis(job_url)
        requirement_fit_report_json = self._load_requirement_fit_report(job_url)
        provenance_by_artifact = self._load_bullet_provenance_by_artifact(job_url)
        enrichment = self._load_enrichment(job_url)
        apply_run = self._load_latest_apply_run(job_url)
        deleted_at = self._load_deleted_at(job_url)
        artifacts = self._load_artifacts(job_url)
        artifacts = _with_synthetic_pdf_artifacts(job_url, artifacts, materials)

        title = _row_str(job_row, "title")
        site = _row_str(job_row, "site")
        application_url = (
            enrichment.get("application_url")
            or _row_nullable_str(job_row, "application_url")
        )
        employer = _row_str(job_row, "company") or _company_name(site, application_url or job_url)

        # currentStage/State: the list view exposes only product stages.
        # The full internal preparation state remains available in
        # JobDetailProjection.stages for operational diagnostics.
        current_stage = "discover"
        current_substage = "discover"
        current_state = "pending"
        current_error_code: str | None = None
        current_error_message: str | None = None
        current_next_action: str | None = None
        first_actionable = next(
            (s for s in stages if s.state not in {"succeeded", "skipped"}),
            stages[-1] if stages else None,
        )
        if first_actionable is not None:
            current_stage = _job_list_stage(first_actionable.stage)
            current_substage = first_actionable.stage
            current_state = first_actionable.state
            current_error_code = first_actionable.error_code
            current_error_message = first_actionable.error_message
            current_next_action = first_actionable.next_action

        # Score: prefer per-aggregate row, fall back to legacy column.
        fit_score = score.get("fit_score")
        if fit_score is None:
            fit_score = _row_nullable_int(job_row, "fit_score")
        score_reasoning = score.get("reasoning") or _row_str(job_row, "score_reasoning")
        score_breakdown_json = score.get("breakdown_json")
        score_keywords_json = score.get("keywords_json") or "[]"
        score_version = score.get("version")
        scored_at = score.get("scored_at")

        # Materials presence:
        tailor_path = materials.get("tailor_path") or _row_nullable_str(
            job_row, "tailored_resume_path"
        )
        cover_path = materials.get("cover_path") or _row_nullable_str(
            job_row, "cover_letter_path"
        )
        resume_pdf_path = materials.get("resume_pdf_path")
        cover_pdf_path = materials.get("cover_pdf_path")

        has_resume = bool(tailor_path)
        has_cover_letter = bool(cover_path)
        has_pdf = bool(resume_pdf_path or cover_pdf_path)
        if first_actionable is not None:
            current_stage = _job_list_stage(first_actionable.stage, has_resume=has_resume)

        # Apply state:
        ar_status = apply_run.get("status") if apply_run else None
        ar_finished = apply_run.get("finished_at") if apply_run else None
        apply_status = _derive_apply_status(
            ar_status,
            _row_nullable_str(job_row, "apply_status"),
        )
        applied_at: str | None
        if ar_status == "succeeded":
            applied_at = ar_finished
        else:
            applied_at = _row_nullable_str(job_row, "applied_at")

        # description fallbacks
        description = _row_str(job_row, "description")
        full_description = enrichment.get("full_description") or _row_str(
            job_row, "full_description"
        )
        compensation_summary, compensation_audit = self._build_compensation_projection(
            job_url,
            _row_nullable_str(job_row, "salary"),
        )

        last_updated_at = _utc_now()

        list_proj = JobListProjection(
            tenant_id=self._tenant_id,
            job_id=job_url,
            title=title or "Untitled",
            employer=employer,
            source=site or "unknown",
            strategy=_row_str(job_row, "strategy"),
            location=_row_str(job_row, "location"),
            salary=_row_str(job_row, "salary"),
            application_url=application_url,
            discovered_at=_row_nullable_str(job_row, "discovered_at"),
            description=description,
            full_description=full_description,
            fit_score=fit_score,
            compensation_summary_json=compensation_summary,
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            current_stage=current_stage,
            current_substage=current_substage,
            current_state=current_state,
            current_error_code=current_error_code,
            current_error_message=current_error_message,
            current_next_action=current_next_action,
            has_resume=has_resume,
            has_cover_letter=has_cover_letter,
            has_pdf=has_pdf,
            apply_status=apply_status,
            applied_at=applied_at,
            artifact_count=len(artifacts),
            deleted_at=deleted_at,
            last_updated_at=last_updated_at,
        )
        self._store.upsert_job_list(list_proj)

        # JobDetail
        detail_proj = JobDetailProjection(
            tenant_id=self._tenant_id,
            job_id=job_url,
            description_preview=_preview_text(
                full_description or description, 6000
            ),
            compensation_summary_json=compensation_summary,
            compensation_audit_json=compensation_audit,
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            stages=tuple(stages),
            employer_analysis_json=employer_analysis_json,
            requirement_fit_report_json=requirement_fit_report_json,
            last_updated_at=last_updated_at,
        )
        self._store.upsert_job_detail(detail_proj)

        # Artifacts (replace-set per job).
        artifact_projs = [
            ArtifactListProjection(
                artifact_id=a["artifact_id"],
                tenant_id=self._tenant_id,
                job_id=job_url,
                job_title=title or "Untitled",
                job_employer=employer,
                artifact_type=a.get("artifact_type", ""),
                status=a.get("status", "active"),
                local_path=a.get("local_path", ""),
                size_bytes=a.get("size_bytes"),
                created_at=a.get("created_at"),
                generation=a.get("generation"),
                metadata_json=a.get("metadata_json"),
                bullet_provenance_json=provenance_by_artifact.provenance.get(a["artifact_id"]),
                coverage_audit_json=provenance_by_artifact.coverage.get(a["artifact_id"]),
                voice_pass_json=provenance_by_artifact.voice.get(a["artifact_id"]),
            )
            for a in artifacts
        ]
        self._store.replace_artifacts_for_job(
            str(self._tenant_id), job_url, artifact_projs
        )

    def _build_compensation_projection(
        self,
        job_url: str,
        legacy_raw_salary: str | None,
    ) -> tuple[str, str]:
        posted = self._load_posted_compensation(job_url, legacy_raw_salary)
        market = self._load_market_compensation(job_url)
        posted_warning_count = (
            len(posted["fact"]["warnings"])
            if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
            else 0
        )
        market_warning_count = (
            len(market["estimate"]["warnings"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else 0
        )
        posted_range = (
            _posted_range_summary(posted["fact"])
            if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
            else None
        )
        market_range = (
            _market_range_summary(market["estimate"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else None
        )
        market_confidence_interval = (
            _market_confidence_interval_summary(market["estimate"])
            if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
            else None
        )
        summary = {
            "projectionVersion": COMPENSATION_PROJECTION_VERSION,
            "legacyRawSalary": (
                posted["fact"]["legacyRawSalary"]
                if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                else posted.get("legacyRawSalary")
            ),
            "warningCount": posted_warning_count + market_warning_count,
            "posted": {
                "sourceKind": "posted",
                "recordStatus": posted["recordStatus"],
                "parseState": (
                    posted["fact"]["parseState"]
                    if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                    else None
                ),
                "confidence": (
                    posted["fact"]["confidence"]
                    if posted["recordStatus"] == "recorded" and isinstance(posted.get("fact"), dict)
                    else "none"
                ),
                "warningCount": posted_warning_count,
                "range": posted_range,
                "displayRange": posted_range.get("displayRange") if posted_range else None,
            },
            "market": {
                "sourceKind": "reported_company_role_market",
                "recordStatus": market["recordStatus"],
                "estimateState": (
                    market["estimate"]["estimateState"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else "not_requested"
                ),
                "confidenceBand": (
                    market["estimate"]["confidenceBand"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else "none"
                ),
                "confidenceScore": (
                    market["estimate"]["confidenceScore"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else None
                ),
                "sourceCount": (
                    market["estimate"]["sourceCount"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else 0
                ),
                "sampleCount": (
                    market["estimate"]["sampleCount"]
                    if market["recordStatus"] == "recorded" and isinstance(market.get("estimate"), dict)
                    else None
                ),
                "warningCount": market_warning_count,
                "range": market_range,
                "displayRange": market_range.get("displayRange") if market_range else None,
                "confidenceInterval": market_confidence_interval,
                "displayConfidenceInterval": (
                    market_confidence_interval.get("displayRange") if market_confidence_interval else None
                ),
            },
        }
        audit = {
            "projectionVersion": COMPENSATION_PROJECTION_VERSION,
            "posted": posted,
            "market": market,
        }
        return json.dumps(summary), json.dumps(audit)

    def _load_posted_compensation(
        self,
        job_url: str,
        legacy_raw_salary: str | None,
    ) -> dict[str, Any]:
        try:
            row = self._conn.execute(
                """
                SELECT tenant_id, job_url, source_field, source_text,
                       legacy_raw_salary, parse_state, currency, period,
                       component, minimum_amount, maximum_amount,
                       annualized_minimum_amount, annualized_maximum_amount,
                       annualization_assumption, confidence, warnings_json,
                       parser_version, source_hash, parsed_at
                FROM job_posted_compensation_facts
                WHERE tenant_id = ? AND job_url = ?
                """,
                (str(self._tenant_id), job_url),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is None:
            return {
                "ok": True,
                "recordStatus": "not_recorded",
                "jobKey": job_url,
                "legacyRawSalary": _nullable_text(legacy_raw_salary),
            }
        fact = _posted_fact_from_row(row)
        return {"ok": True, "recordStatus": "recorded", "fact": fact}

    def _load_market_compensation(self, job_url: str) -> dict[str, Any]:
        try:
            row = self._conn.execute(
                """
                SELECT tenant_id, job_url, estimate_state, currency, period,
                       component, minimum_amount, maximum_amount,
                       confidence_interval_minimum_amount,
                       confidence_interval_maximum_amount,
                       confidence_band, confidence_score, source_count,
                       sample_count, aggregate_bucket, geography_scope,
                       occupation_code, occupation_label, seniority_label,
                       source_snapshot_json, factor_reasons_json,
                       selected_evidence_json,
                       insufficient_reasons_json, unsupported_reasons_json,
                       source_unavailable_reasons_json, warnings_json,
                       estimator_version, estimated_at, company_name,
                       normalized_company, role_title, normalized_role,
                       company_tier, match_scope
                FROM job_market_compensation_estimates
                WHERE tenant_id = ? AND job_url = ?
                """,
                (str(self._tenant_id), job_url),
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is None:
            return {"ok": True, "recordStatus": "not_requested", "jobKey": job_url}
        if not _row_str(row, "estimator_version").startswith("company-role-reported-compensation-"):
            return {"ok": True, "recordStatus": "not_requested", "jobKey": job_url}
        estimate_state = _row_str(row, "estimate_state")
        if estimate_state not in MARKET_RECORDED_STATES:
            return {"ok": True, "recordStatus": "not_requested", "jobKey": job_url}
        estimate = _market_estimate_from_row(row)
        return {"ok": True, "recordStatus": "recorded", "estimate": estimate}

    # ------------------------------------------------------------- joiners

    def _load_stage_projections(self, job_url: str) -> list[StageProjection]:
        try:
            rows = self._conn.execute(
                "SELECT * FROM job_stage_states WHERE job_url = ?",
                (job_url,),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        # ``sqlite3.Row`` (configured via ``row_factory``) is always mapping-like,
        # never a plain tuple — drop the dead isinstance branch so the dict's
        # key type narrows to ``str`` for static analyzers.
        explicit: dict[str, sqlite3.Row] = {row["stage"]: row for row in rows}
        result: list[StageProjection] = []
        for stage in STAGE_ORDER:
            row = explicit.get(stage)
            if row is None:
                result.append(
                    StageProjection(
                        stage=stage,
                        state="pending",
                        max_attempts=DEFAULT_MAX_ATTEMPTS.get(stage),
                    )
                )
                continue
            blocked_by = _json_loads(_row_nullable_str(row, "blocked_by_json"), [])
            result.append(
                StageProjection(
                    stage=stage,
                    state=_row_str(row, "state") or "pending",
                    attempt_count=_row_nullable_int(row, "attempt_count") or 0,
                    max_attempts=_row_nullable_int(row, "max_attempts")
                    or DEFAULT_MAX_ATTEMPTS.get(stage),
                    started_at=_row_nullable_str(row, "started_at"),
                    updated_at=_row_nullable_str(row, "updated_at"),
                    finished_at=_row_nullable_str(row, "finished_at"),
                    duration_ms=_row_nullable_int(row, "duration_ms"),
                    error_code=_row_nullable_str(row, "error_code"),
                    error_message=_row_nullable_str(row, "error_message"),
                    retryable=_row_nullable_int(row, "retryable") != 0,
                    blocked_by=tuple(str(item) for item in blocked_by)
                    if isinstance(blocked_by, list)
                    else (),
                    next_action=_row_nullable_str(row, "next_action"),
                )
            )
        return result

    def _load_latest_score(self, job_url: str) -> dict:
        try:
            row = self._conn.execute(
                """
                SELECT s.version, s.fit_score, s.scored_at, s.breakdown_json,
                       s.keywords_json
                FROM job_scores s
                WHERE s.job_url = ?
                ORDER BY s.version DESC
                LIMIT 1
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        breakdown = _json_loads(_row_nullable_str(row, "breakdown_json"), {})
        reasoning = ""
        legacy = False
        if isinstance(breakdown, dict):
            legacy = breakdown.get("legacy") is True
            if isinstance(breakdown.get("reasoning"), str):
                reasoning = breakdown["reasoning"]
        keywords = _normalize_keywords(_json_loads(_row_nullable_str(row, "keywords_json"), []))
        return {
            "version": _row_nullable_int(row, "version"),
            "fit_score": _row_nullable_int(row, "fit_score"),
            "scored_at": _row_nullable_str(row, "scored_at"),
            "breakdown_json": None if legacy else json.dumps(_camel_score_breakdown(breakdown)),
            "keywords_json": json.dumps([] if legacy and keywords == ["legacy"] else keywords),
            "reasoning": reasoning,
        }

    def _load_latest_materials(self, job_url: str) -> dict:
        try:
            generation_row = self._conn.execute(
                """
                SELECT MAX(generation)
                FROM job_materials_artifacts
                WHERE job_url = ?
                  AND status = 'approved'
                  AND artifact_type IN (
                    'tailored_resume',
                    'cover_letter',
                    'resume_pdf',
                    'cover_letter_pdf'
                  )
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if generation_row is None:
            return {}
        max_generation = generation_row[0]
        if max_generation is None:
            return {}
        try:
            artifact_rows = self._conn.execute(
                """
                SELECT artifact_type, path, status, created_at
                FROM job_materials_artifacts
                WHERE job_url = ? AND generation = ? AND status = 'approved'
                """,
                (job_url, int(max_generation)),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        result: dict = {"generation": int(max_generation)}
        for row in artifact_rows:
            atype = _row_str(row, "artifact_type")
            path = _row_nullable_str(row, "path")
            if not path:
                continue
            if atype == "tailored_resume":
                result["tailor_path"] = path
                result["tailored_at"] = _row_nullable_str(row, "created_at")
            elif atype == "cover_letter":
                result["cover_path"] = path
                result["cover_at"] = _row_nullable_str(row, "created_at")
            elif atype == "resume_pdf":
                result["resume_pdf_path"] = path
            elif atype == "cover_letter_pdf":
                result["cover_pdf_path"] = path
        return result

    def _load_employer_analysis(self, job_url: str) -> str | None:
        """Project the latest canonical employer analysis read shape (Phase 1).

        The single owner of the analysis read shape: it loads the latest
        ``EmployerAnalysis`` generation from canonical rows and serialises
        ``to_read_model()`` to JSON for the detail projection. Returns ``None``
        when no analysis exists yet (the common case before a job is tailored).
        """
        from jobhunter.infrastructure.materials.employer_analysis_repository import (
            SqliteEmployerAnalysisRepository,
        )

        try:
            record = SqliteEmployerAnalysisRepository(self._conn).load(
                self._tenant_id, JobId(job_url)
            )
        except sqlite3.OperationalError:
            return None
        if record is None:
            return None
        return json.dumps(record.to_read_model(), ensure_ascii=False)

    def _load_requirement_fit_report(self, job_url: str) -> str | None:
        """Project the latest canonical requirement-fit report read shape.

        The score aggregate owns the source rows. The detail projection exposes
        the latest ``RequirementFitReport.to_read_model()`` so the UI can show
        exactly which requirements produced the fit score and what tailoring
        directives were generated from them.
        """
        from jobhunter.infrastructure.scoring import SqliteRequirementFitReportRepository

        try:
            record = SqliteRequirementFitReportRepository(self._conn).load(
                self._tenant_id, JobId(job_url)
            )
        except sqlite3.OperationalError:
            return None
        if record is None:
            return None
        return json.dumps(record.to_read_model(), ensure_ascii=False)

    def _load_bullet_provenance_by_artifact(self, job_url: str) -> "_ProvenanceProjection":
        """Project the latest provenance + coverage + voice read shapes, keyed by artifact.

        The single owner of the provenance/coverage/voice read shapes (Phase 2 +
        Phase 3): it loads the latest ``BulletProvenanceSet`` generation from
        canonical rows and serialises ``to_read_model()`` (per-bullet provenance),
        ``coverage_to_read_model()`` (generation-time keyword coverage, GROUND-06),
        and ``voice_to_read_model()`` (the voice-pass audit, VOICE-02) to JSON, each
        mapped to the ``artifact_id`` it explains so the artifact projection carries
        them directly. Returns empty mappings when no provenance exists (the common
        case before tailoring, or for PDF artifacts).
        """
        from jobhunter.infrastructure.materials.bullet_provenance_repository import (
            SqliteBulletProvenanceRepository,
        )

        empty = _ProvenanceProjection(provenance={}, coverage={}, voice={})
        try:
            record = SqliteBulletProvenanceRepository(self._conn).load(
                self._tenant_id, JobId(job_url)
            )
        except sqlite3.OperationalError:
            return empty
        if record is None or record.is_empty:
            return empty
        coverage = record.coverage_to_read_model()
        voice = record.voice_to_read_model()
        return _ProvenanceProjection(
            provenance={record.artifact_id: json.dumps(record.to_read_model(), ensure_ascii=False)},
            coverage=(
                {record.artifact_id: json.dumps(coverage, ensure_ascii=False)}
                if coverage is not None
                else {}
            ),
            voice=(
                {record.artifact_id: json.dumps(voice, ensure_ascii=False)}
                if voice is not None
                else {}
            ),
        )

    def _load_enrichment(self, job_url: str) -> dict:
        try:
            row = self._conn.execute(
                """
                SELECT full_description, application_url, enriched_at,
                       current_status, extraction_tier
                FROM job_enrichments
                WHERE job_url = ?
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        return {
            "full_description": _row_nullable_str(row, "full_description"),
            "application_url": _row_nullable_str(row, "application_url"),
            "enriched_at": _row_nullable_str(row, "enriched_at"),
            "current_status": _row_nullable_str(row, "current_status"),
            "extraction_tier": _row_nullable_str(row, "extraction_tier"),
        }

    def _load_latest_apply_run(self, job_url: str) -> dict:
        # PR 4 of the Temporal stack: ``apply_run_projections`` is the
        # canonical apply lifecycle row (sourced from ``job_events`` by
        # ``_rebuild_apply_runs`` below). ``_rebuild_job`` reads it
        # back here to derive ``apply_status`` / ``applied_at`` for
        # ``job_list_projections``.
        try:
            row = self._conn.execute(
                """
                SELECT run_id, status, result, started_at, finished_at,
                       worker_id, model, dry_run, duration_ms
                FROM apply_run_projections
                WHERE job_id = ?
                ORDER BY started_at DESC, run_id DESC
                LIMIT 1
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return {}
        if row is None:
            return {}
        return {
            "run_id": _row_nullable_str(row, "run_id"),
            "status": _row_nullable_str(row, "status"),
            "result": _row_nullable_str(row, "result"),
            "started_at": _row_nullable_str(row, "started_at"),
            "finished_at": _row_nullable_str(row, "finished_at"),
            "worker_id": _row_nullable_int(row, "worker_id"),
            "model": _row_nullable_str(row, "model"),
            "dry_run": bool(_row_nullable_int(row, "dry_run") or 0),
            "duration_ms": _row_nullable_int(row, "duration_ms"),
        }

    def _load_deleted_at(self, job_url: str) -> str | None:
        try:
            row = self._conn.execute(
                """
                SELECT deleted_at FROM jobhunter_deleted_jobs
                WHERE job_url = ?
                  AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if row is None:
            return None
        return _row_nullable_str(row, "deleted_at")

    def _stale_deleted_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT p.job_id
                FROM job_list_projections p
                JOIN jobhunter_deleted_jobs d
                  ON d.job_url = p.job_id
                WHERE p.tenant_id = ?
                  AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
                  AND (p.deleted_at IS NULL OR p.deleted_at != d.deleted_at)
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_id"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_id"] if not isinstance(row, tuple) else row[0])
        }

    def _closed_projection_jobs(self) -> set[str]:
        try:
            rows = self._conn.execute(
                """
                SELECT job_url
                FROM posting_snapshot_sets
                WHERE tenant_id = ?
                  AND latest_active_state IN (
                    'closed', 'expired', 'removed', 'location_incompatible'
                  )
                """,
                (str(self._tenant_id),),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {
            str(row["job_url"] if not isinstance(row, tuple) else row[0])
            for row in rows
            if (row["job_url"] if not isinstance(row, tuple) else row[0])
        }

    def _load_artifacts(self, job_url: str) -> list[dict]:
        artifacts: list[dict] = []
        seen: set[tuple[str, str]] = set()
        try:
            for row in self._conn.execute(
                """
                SELECT artifact_id, artifact_type, status, path, created_at,
                       size_bytes, generation, metadata_json
                FROM job_materials_artifacts
                WHERE job_url = ?
                """,
                (job_url,),
            ).fetchall():
                local_path = _row_nullable_str(row, "path") or ""
                atype = _row_nullable_str(row, "artifact_type") or ""
                if not local_path:
                    continue
                key = (atype, local_path)
                if key in seen:
                    continue
                seen.add(key)
                aid = _row_nullable_str(row, "artifact_id") or f"{atype}:{local_path}"
                artifacts.append(
                    {
                        "artifact_id": aid,
                        "artifact_type": atype,
                        "status": _row_nullable_str(row, "status") or "active",
                        "local_path": local_path,
                        "created_at": _row_nullable_str(row, "created_at"),
                        "size_bytes": _row_nullable_int(row, "size_bytes"),
                        "generation": _row_nullable_int(row, "generation"),
                        "metadata_json": _row_nullable_str(row, "metadata_json"),
                    }
                )
        except sqlite3.OperationalError:
            pass
        try:
            for row in self._conn.execute(
                """
                SELECT rowid AS row_id, job_url, stage, artifact_type, status,
                       path, created_at, size_bytes
                FROM job_artifacts
                WHERE job_url = ?
                """,
                (job_url,),
            ).fetchall():
                local_path = _row_nullable_str(row, "path") or ""
                atype = _row_nullable_str(row, "artifact_type") or "artifact"
                if not local_path:
                    continue
                key = (atype, local_path)
                if key in seen:
                    continue
                seen.add(key)
                row_id = _row_nullable_str(row, "row_id") or f"{atype}:{local_path}"
                artifacts.append(
                    {
                        "artifact_id": row_id,
                        "artifact_type": atype,
                        "status": _row_nullable_str(row, "status") or "active",
                        "local_path": local_path,
                        "created_at": _row_nullable_str(row, "created_at"),
                        "size_bytes": _row_nullable_int(row, "size_bytes"),
                        "generation": None,
                    }
                )
        except sqlite3.OperationalError:
            pass
        return artifacts

    # ------------------------------------------------------------- dashboard

    def _rebuild_dashboard(self) -> None:
        rows = self._store.fetch_job_list(str(self._tenant_id))
        closed_jobs = self._closed_projection_jobs()
        # Filter out soft-deleted and closed/removed jobs from active dashboard counts.
        active_rows = [
            row
            for row in rows
            if not _row_nullable_str(row, "deleted_at")
            and _row_str(row, "job_id") not in closed_jobs
        ]

        total_jobs = len(active_rows)
        failures = sum(
            1
            for row in active_rows
            if _row_str(row, "current_state") in {"failed", "exhausted"}
        )
        blocked = sum(
            1 for row in active_rows if _row_str(row, "current_state") == "blocked"
        )
        ready = sum(
            1
            for row in active_rows
            if _row_str(row, "current_stage") == "apply"
            and _row_str(row, "current_state") == "pending"
        )
        applied = sum(
            1
            for row in active_rows
            if _row_nullable_str(row, "applied_at")
            or _row_nullable_str(row, "apply_status") == "applied"
        )
        # Mirror the TS counter (apps/api/src/projections.ts):
        # exclude dry runs whose underlying job is soft-deleted via
        # ``jobhunter_deleted_jobs`` so the user-visible value agrees
        # regardless of which writer (Python or TS) ran last.
        try:
            dry_runs = int(
                self._conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM apply_run_projections arp
                    LEFT JOIN jobhunter_deleted_jobs d
                        ON d.job_url = arp.job_id
                       AND (d.restored_at IS NULL OR julianday(d.restored_at) <= julianday(d.deleted_at))
                    LEFT JOIN posting_snapshot_sets pss
                        ON pss.tenant_id = arp.tenant_id
                       AND pss.job_url = arp.job_id
                    WHERE arp.dry_run = 1
                      AND d.job_url IS NULL
                      AND (
                        pss.latest_active_state IS NULL
                        OR pss.latest_active_state NOT IN (
                          'closed', 'expired', 'removed', 'location_incompatible'
                        )
                      )
                    """
                ).fetchone()[0]
            )
        except sqlite3.OperationalError:
            dry_runs = 0

        # Funnel per stage.
        funnel_counts: dict[str, dict[str, int]] = {
            stage: {
                "total": 0,
                "succeeded": 0,
                "running": 0,
                "pending": 0,
                "blocked": 0,
                "failed": 0,
            }
            for stage in STAGE_ORDER
        }
        # Per-stage funnel uses the per-job stage rows (not just the
        # current stage) so a funnel shows downstream stages too.  We
        # fan out by reading job_detail_projections.stages_json — those
        # were just rebuilt by ``_rebuild_job``.
        for row in active_rows:
            job_id = _row_str(row, "job_id")
            detail = self._store.fetch_job_detail(str(self._tenant_id), job_id)
            if detail is None:
                continue
            stages_json = _row_str(detail, "stages_json") or "[]"
            try:
                stages_list = json.loads(stages_json)
            except json.JSONDecodeError:
                stages_list = []
            for stage_dict in stages_list:
                stage = stage_dict.get("stage")
                state = stage_dict.get("state", "pending")
                if stage not in funnel_counts:
                    continue
                if state == "skipped":
                    continue
                funnel_counts[stage]["total"] += 1
                if state in {"failed", "exhausted"}:
                    funnel_counts[stage]["failed"] += 1
                elif state in {"running", "queued"}:
                    funnel_counts[stage]["running"] += 1
                elif state == "blocked":
                    funnel_counts[stage]["blocked"] += 1
                elif state == "succeeded":
                    funnel_counts[stage]["succeeded"] += 1
                else:
                    funnel_counts[stage]["pending"] += 1

        funnel = tuple(
            DashboardFunnelStage(
                stage=stage,
                total=counts["total"],
                succeeded=counts["succeeded"],
                running=counts["running"],
                pending=counts["pending"],
                blocked=counts["blocked"],
                failed=counts["failed"],
            )
            for stage, counts in funnel_counts.items()
        )

        # by_source — group by the projected source (board) column.
        source_counts: dict[str, int] = {}
        for row in active_rows:
            source = _row_str(row, "source") or "unknown"
            source_counts[source] = source_counts.get(source, 0) + 1
        by_source = tuple(
            sorted(source_counts.items(), key=lambda kv: kv[1], reverse=True)
        )

        # score_distribution — group by fit_score.
        score_counts: dict[int, int] = {}
        for row in active_rows:
            fit = _row_nullable_int(row, "fit_score")
            if fit is None:
                continue
            score_counts[fit] = score_counts.get(fit, 0) + 1
        score_distribution = tuple(
            sorted(score_counts.items(), key=lambda kv: kv[0], reverse=True)
        )

        dashboard = DashboardProjection(
            tenant_id=self._tenant_id,
            total_jobs=total_jobs,
            failures=failures,
            blocked=blocked,
            ready=ready,
            applied=applied,
            dry_runs=dry_runs,
            funnel=funnel,
            by_source=by_source,
            score_distribution=score_distribution,
            generated_at=_utc_now(),
        )
        self._store.upsert_dashboard(dashboard)

    def _rebuild_source_quality(self) -> None:
        placeholders = ", ".join("?" for _ in SOURCE_QUALITY_EVENT_TYPES)
        rows = self._conn.execute(
            f"""
            SELECT event_id, job_url, event_type, occurred_at, payload_json
            FROM job_events
            WHERE event_type IN ({placeholders})
            ORDER BY event_id ASC
            """,
            tuple(sorted(SOURCE_QUALITY_EVENT_TYPES)),
        ).fetchall()
        result = project_source_quality(
            tenant_id=self._tenant_id,
            events=(event_row_from_sql(row) for row in rows),
            updated_at=_utc_now(),
        )
        for run in result.runs:
            self._store.upsert_discovery_run(run)
        self._store.replace_source_quality(str(self._tenant_id), result.stats)

    def _has_source_quality_history(self) -> bool:
        placeholders = ", ".join("?" for _ in SOURCE_QUALITY_EVENT_TYPES)
        row = self._conn.execute(
            f"""
            SELECT COUNT(*)
            FROM job_events
            WHERE event_type IN ({placeholders})
            """,
            tuple(sorted(SOURCE_QUALITY_EVENT_TYPES)),
        ).fetchone()
        return bool(row and int(row[0]) > 0)

    # ----------------------------------------------------------- apply runs

    def _rebuild_apply_runs(self) -> None:
        """Materialise ``apply_run_projections`` from ``job_events``.

        PR 4 of the Temporal stack collapsed the bespoke ``apply_runs``
        table into the workflow run history. Each apply lifecycle is now
        a sequence of ``job_events`` rows keyed by ``run_id`` in the
        event payload:

          * ``ApplyRunStarted``      — opens a row.
          * ``ApplicationSubmitted`` — terminal: succeeded.
          * ``ApplicationFailed``    — terminal: failed (or another
                                       non-applied SubmissionResult kind).
          * ``DryRunCompleted``      — terminal: dry_run_complete.
          * Any other apply-stage event with a ``run_id`` — appended to
            the per-run ``events_json`` timeline.
        """
        events_by_run = self._collect_apply_events_by_run()
        if not events_by_run:
            return
        for run_id, events in events_by_run.items():
            projection = self._project_run_from_events(run_id, events)
            if projection is None:
                continue
            self._store.upsert_apply_run(projection)

    def _collect_apply_events_by_run(self) -> dict[str, list[dict]]:
        try:
            rows = self._conn.execute(
                """
                SELECT job_url, event_type, level, message, occurred_at,
                       payload_json
                FROM job_events
                WHERE stage = 'apply'
                ORDER BY event_id ASC
                """
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        out: dict[str, list[dict]] = {}
        for row in rows:
            payload = _json_loads(_row_nullable_str(row, "payload_json"), {})
            if not isinstance(payload, dict):
                continue
            run_id = payload.get("run_id")
            if not run_id:
                continue
            run_id_str = str(run_id)
            out.setdefault(run_id_str, []).append(
                {
                    "job_url": _row_nullable_str(row, "job_url"),
                    "event_type": _row_str(row, "event_type"),
                    "level": _row_nullable_str(row, "level") or "info",
                    "message": _row_nullable_str(row, "message"),
                    "occurred_at": _row_nullable_str(row, "occurred_at"),
                    "payload": payload,
                }
            )
        return out

    _TERMINAL_EVENT_STATUS: dict[str, tuple[str, str | None]] = {
        "ApplicationSubmitted": ("succeeded", "applied"),
        "DryRunCompleted": ("dry_run_complete", "dry_run_complete"),
        "ApplyManualSkip": ("manual", "manual"),
        # ``LockReleased`` is the orphan-rescue terminal: only treat it as
        # failure when no prior terminal event for the run was observed
        # (see ``_apply_lock_released_event`` below). The event itself
        # carries no result; preserving the prior result keeps captcha /
        # login_issue / expired distinct from generic 'failed'.
        "LockReleased": ("failed", "failed"),
    }

    # Event types that carry a real terminal verdict (used to gate the
    # LockReleased fallback so it doesn't clobber more-specific results).
    _AUTHORITATIVE_TERMINAL_EVENTS: frozenset[str] = frozenset(
        {"ApplicationSubmitted", "DryRunCompleted", "ApplyManualSkip", "ApplicationFailed"}
    )

    _STATUS_FROM_RESULT: dict[str, str] = {
        "applied": "succeeded",
        "failed": "failed",
        "captcha": "captcha",
        "login_issue": "login_issue",
        "expired": "expired",
        "manual": "manual",
        "dry_run_complete": "dry_run_complete",
    }

    def _project_run_from_events(
        self, run_id: str, events: list[dict]
    ) -> ApplyRunProjection | None:
        if not events:
            return None
        job_url = ""
        title = ""
        site = ""
        status = "starting"
        result: str | None = None
        started_at: str | None = None
        finished_at: str | None = None
        duration_ms: int | None = None
        worker_id: int | None = None
        model: str | None = None
        dry_run = False

        for event in events:
            payload = event["payload"]
            event_type = event["event_type"]
            if event["job_url"]:
                job_url = event["job_url"]

            if event_type == "ApplyRunStarted":
                started_at = (
                    str(payload.get("started_at"))
                    if payload.get("started_at") is not None
                    else event.get("occurred_at")
                )
                model = (
                    str(payload["model"])
                    if isinstance(payload.get("model"), str) and payload.get("model")
                    else model
                )
                worker = payload.get("worker_id")
                if isinstance(worker, (int, float)):
                    worker_id = int(worker)
                elif isinstance(worker, str) and worker.isdigit():
                    worker_id = int(worker)
                if "dry_run" in payload:
                    dry_run = bool(payload.get("dry_run"))
                status = "starting"
            elif event_type == "ApplyRunInProgress":
                if status == "starting":
                    status = "in_progress"
            elif event_type in self._TERMINAL_EVENT_STATUS:
                # LockReleased is the orphan-rescue fallback: when an
                # authoritative terminal event already fired (Submitted /
                # DryRunCompleted / ApplyManualSkip / ApplicationFailed),
                # do NOT overwrite its more-specific result. Otherwise
                # captcha / login_issue / expired runs that get rescued
                # by ``release_lock`` would surface as plain 'failed' in
                # ``apply_run_projections.result``.
                if event_type == "LockReleased" and result is not None:
                    continue
                term_status, term_result = self._TERMINAL_EVENT_STATUS[event_type]
                status = term_status
                result = (
                    str(payload.get("result"))
                    if isinstance(payload.get("result"), str)
                    else term_result
                )
                finished_at = (
                    str(payload.get("finished_at"))
                    if payload.get("finished_at") is not None
                    else event.get("occurred_at")
                )
                if "duration_ms" in payload:
                    try:
                        duration_ms = int(payload["duration_ms"])
                    except (TypeError, ValueError):
                        pass
                if event_type == "DryRunCompleted":
                    dry_run = True
            elif event_type == "ApplicationFailed":
                # Payload may carry the SubmissionResult kind explicitly.
                kind = (
                    payload.get("result", {}).get("kind")
                    if isinstance(payload.get("result"), dict)
                    else (payload.get("result") if isinstance(payload.get("result"), str) else None)
                )
                status = self._STATUS_FROM_RESULT.get(str(kind), "failed") if kind else "failed"
                result = str(kind) if kind else "failed"
                finished_at = (
                    str(payload.get("finished_at"))
                    if payload.get("finished_at") is not None
                    else event.get("occurred_at")
                )
                if "duration_ms" in payload:
                    try:
                        duration_ms = int(payload["duration_ms"])
                    except (TypeError, ValueError):
                        pass

        if not job_url:
            return None

        # Hydrate denormalised job columns from the parent ``jobs`` row
        # so the read-side widgets render real values rather than
        # "Untitled" / "Unknown company".
        try:
            meta = self._conn.execute(
                "SELECT title, site, company FROM jobs WHERE url = ? LIMIT 1",
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            meta = None
        if meta is not None:
            title = _row_str(meta, "title") or title
            site = _row_str(meta, "site") or site

        employer = _row_str(meta, "company") if meta is not None else ""
        employer = employer or _company_name(site, job_url)

        events_payload: list[dict] = []
        for event in events:
            entry = {
                "event_type": event["event_type"],
                "level": event["level"],
                "occurred_at": event["occurred_at"],
            }
            if event["message"]:
                entry["message"] = event["message"]
            if event["payload"]:
                entry["payload"] = event["payload"]
            events_payload.append(entry)

        return ApplyRunProjection(
            run_id=run_id,
            tenant_id=self._tenant_id,
            job_id=job_url,
            job_title=title or "Untitled",
            job_employer=employer,
            status=status,
            result=result,
            dry_run=dry_run,
            worker_id=worker_id,
            model=model,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            events=tuple(events_payload),
        )


# ============================================================== helpers


def _row_str(row: object, key: str) -> str:
    value = _row_get(row, key)
    return "" if value is None else str(value)


def _row_nullable_str(row: object, key: str) -> str | None:
    value = _row_get(row, key)
    if value is None or value == "":
        return None
    return str(value)


def _row_nullable_int(row: object, key: str) -> int | None:
    value = _row_get(row, key)
    if value is None or value == "":
        return None
    if not isinstance(value, (int, str, float, bytes)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _posted_fact_from_row(row: object) -> dict[str, Any]:
    warnings = _warnings(_row_str(row, "warnings_json"), POSTED_COMPENSATION_WARNING_MESSAGES)
    base: dict[str, Any] = {
        "tenantId": _row_str(row, "tenant_id"),
        "jobKey": _row_str(row, "job_url"),
        "sourceField": _row_str(row, "source_field"),
        "legacyRawSalary": _nullable_text(_row_get(row, "legacy_raw_salary")),
        "parserVersion": _row_str(row, "parser_version"),
        "sourceHash": _row_str(row, "source_hash"),
        "parsedAt": _row_str(row, "parsed_at"),
        "warnings": warnings,
    }
    parse_state = _row_str(row, "parse_state")
    if parse_state == "missing":
        return {
            **base,
            "parseState": "missing",
            "sourceText": None,
            "confidence": "none",
        }
    if parse_state == "unparseable":
        return {
            **base,
            "parseState": "unparseable",
            "sourceText": _row_str(row, "source_text"),
            "confidence": "low",
        }
    if parse_state == "ambiguous":
        confidence = "medium" if _row_str(row, "confidence") == "medium" else "low"
        return {
            **base,
            "parseState": "ambiguous",
            "sourceText": _row_str(row, "source_text"),
            "confidence": confidence,
        }
    confidence = _row_str(row, "confidence")
    return {
        **base,
        "parseState": "parsed_range",
        "sourceText": _row_str(row, "source_text"),
        "currency": _nullable_text(_row_get(row, "currency")),
        "period": _row_str(row, "period"),
        "component": _row_str(row, "component"),
        "minimumAmount": _nullable_int(_row_get(row, "minimum_amount")),
        "maximumAmount": _nullable_int(_row_get(row, "maximum_amount")),
        "annualizedMinimumAmount": _nullable_int(_row_get(row, "annualized_minimum_amount")),
        "annualizedMaximumAmount": _nullable_int(_row_get(row, "annualized_maximum_amount")),
        "annualizationAssumption": _nullable_text(_row_get(row, "annualization_assumption")),
        "confidence": confidence if confidence in {"high", "medium"} else "low",
    }


def _market_estimate_from_row(row: object) -> dict[str, Any]:
    sources = _market_sources(_row_str(row, "source_snapshot_json"))
    estimate_state = _row_str(row, "estimate_state")
    confidence_band = _confidence_band(_row_get(row, "confidence_band"))
    base: dict[str, Any] = {
        "tenantId": _row_str(row, "tenant_id"),
        "jobKey": _row_str(row, "job_url"),
        "estimateState": estimate_state,
        "confidenceBand": confidence_band,
        "confidenceScore": _number(_row_get(row, "confidence_score")),
        "sourceCount": int(_number(_row_get(row, "source_count"))),
        "sampleCount": _nullable_int(_row_get(row, "sample_count")),
        "aggregateBucket": _safe_market_aggregate_bucket(_row_get(row, "aggregate_bucket"), sources),
        "geographyScope": _safe_market_geography_scope(_row_get(row, "geography_scope")),
        "occupationCode": _nullable_text(_row_get(row, "occupation_code")),
        "occupationLabel": _nullable_text(_row_get(row, "occupation_label")),
        "seniorityLabel": _nullable_text(_row_get(row, "seniority_label")),
        "companyName": _nullable_text(_row_get(row, "company_name")),
        "normalizedCompany": _nullable_text(_row_get(row, "normalized_company")),
        "roleTitle": _nullable_text(_row_get(row, "role_title")),
        "normalizedRole": _nullable_text(_row_get(row, "normalized_role")),
        "companyTier": _company_tier(_row_get(row, "company_tier")),
        "matchScope": _market_match_scope(_row_get(row, "match_scope")),
        "sources": sources,
        "factors": _market_factors(_row_str(row, "factor_reasons_json")),
        "evidence": _market_evidence(_row_str(row, "selected_evidence_json")),
        "warnings": _warnings(_row_str(row, "warnings_json"), MARKET_COMPENSATION_WARNING_MESSAGES),
        "estimatorVersion": _row_str(row, "estimator_version"),
        "estimatedAt": _row_str(row, "estimated_at"),
    }
    if estimate_state == "unsupported":
        return {
            **base,
            "estimateState": "unsupported",
            "unsupportedReasons": _reasons(
                _row_str(row, "unsupported_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    if estimate_state == "source_unavailable":
        return {
            **base,
            "estimateState": "source_unavailable",
            "sourceUnavailableReasons": _reasons(
                _row_str(row, "source_unavailable_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    if estimate_state == "insufficient_evidence":
        return {
            **base,
            "estimateState": "insufficient_evidence",
            "insufficientReasons": _reasons(
                _row_str(row, "insufficient_reasons_json"),
                MARKET_COMPENSATION_REASON_MESSAGES,
            ),
        }
    return {
        **base,
        "estimateState": "estimated_range",
        "currency": _nullable_text(_row_get(row, "currency")) or "EUR",
        "period": _row_str(row, "period"),
        "component": _row_str(row, "component"),
        "minimumAmount": _nullable_int(_row_get(row, "minimum_amount")) or 0,
        "maximumAmount": _nullable_int(_row_get(row, "maximum_amount")) or 0,
        "confidenceInterval": {
            "minimumAmount": _nullable_int(_row_get(row, "confidence_interval_minimum_amount"))
            or _nullable_int(_row_get(row, "minimum_amount"))
            or 0,
            "maximumAmount": _nullable_int(_row_get(row, "confidence_interval_maximum_amount"))
            or _nullable_int(_row_get(row, "maximum_amount"))
            or 0,
        },
    }


def _posted_range_summary(fact: dict[str, Any]) -> dict[str, Any] | None:
    if fact.get("parseState") != "parsed_range":
        return None
    return {
        "currency": fact.get("currency"),
        "period": fact.get("period"),
        "component": fact.get("component"),
        "minimumAmount": fact.get("minimumAmount"),
        "maximumAmount": fact.get("maximumAmount"),
        "annualizedMinimumAmount": fact.get("annualizedMinimumAmount"),
        "annualizedMaximumAmount": fact.get("annualizedMaximumAmount"),
        "annualizedMinimumEur": _normalize_annualized_eur(
            fact.get("annualizedMinimumAmount"),
            fact.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            fact.get("annualizedMaximumAmount"),
            fact.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            fact.get("currency"),
            fact.get("minimumAmount"),
            fact.get("maximumAmount"),
            fact.get("period"),
        ),
    }


def _market_range_summary(estimate: dict[str, Any]) -> dict[str, Any] | None:
    if estimate.get("estimateState") != "estimated_range":
        return None
    return {
        "currency": estimate.get("currency"),
        "period": estimate.get("period"),
        "component": estimate.get("component"),
        "minimumAmount": estimate.get("minimumAmount"),
        "maximumAmount": estimate.get("maximumAmount"),
        "annualizedMinimumAmount": _annualize_compensation_amount(
            estimate.get("minimumAmount"),
            estimate.get("period"),
        ),
        "annualizedMaximumAmount": _annualize_compensation_amount(
            estimate.get("maximumAmount"),
            estimate.get("period"),
        ),
        "annualizedMinimumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(estimate.get("minimumAmount"), estimate.get("period")),
            estimate.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(estimate.get("maximumAmount"), estimate.get("period")),
            estimate.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            estimate.get("currency"),
            estimate.get("minimumAmount"),
            estimate.get("maximumAmount"),
            estimate.get("period"),
        ),
    }


def _market_confidence_interval_summary(estimate: dict[str, Any]) -> dict[str, Any] | None:
    if estimate.get("estimateState") != "estimated_range":
        return None
    interval = estimate.get("confidenceInterval")
    if not isinstance(interval, dict):
        return None
    minimum = interval.get("minimumAmount")
    maximum = interval.get("maximumAmount")
    return {
        "currency": estimate.get("currency"),
        "period": estimate.get("period"),
        "component": estimate.get("component"),
        "minimumAmount": minimum,
        "maximumAmount": maximum,
        "annualizedMinimumAmount": _annualize_compensation_amount(minimum, estimate.get("period")),
        "annualizedMaximumAmount": _annualize_compensation_amount(maximum, estimate.get("period")),
        "annualizedMinimumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(minimum, estimate.get("period")),
            estimate.get("currency"),
        ),
        "annualizedMaximumEur": _normalize_annualized_eur(
            _annualize_compensation_amount(maximum, estimate.get("period")),
            estimate.get("currency"),
        ),
        "displayRange": _format_compensation_range(
            estimate.get("currency"),
            minimum,
            maximum,
            estimate.get("period"),
        ),
    }


EUR_NORMALIZATION_RATES: dict[str, float] = {
    "EUR": 1,
    "USD": 0.92,
    "GBP": 1.17,
    "CHF": 1.06,
    "SEK": 0.09,
    "NOK": 0.087,
    "DKK": 0.134,
    "PLN": 0.235,
    "CZK": 0.041,
}


def _normalize_annualized_eur(amount: object, currency: object) -> int | None:
    annualized = _nullable_int(amount)
    if annualized is None:
        return None
    rate = EUR_NORMALIZATION_RATES.get(str(currency).upper()) if currency else None
    if rate is None:
        return None
    return round(annualized * rate)


def _annualize_compensation_amount(amount: object, period: object) -> int | None:
    value = _nullable_int(amount)
    if value is None:
        return None
    if period == "year":
        return value
    if period == "month":
        return value * 12
    if period == "hour":
        return value * 2080
    return None


def _format_compensation_range(
    currency: object,
    minimum_amount: object,
    maximum_amount: object,
    period: object,
) -> str | None:
    minimum = _nullable_int(minimum_amount)
    maximum = _nullable_int(maximum_amount)
    if minimum is None and maximum is None:
        return None
    prefix = f"{currency} " if currency else ""
    suffix = f"/{period}" if period else ""
    if minimum is not None and maximum is not None:
        return f"{prefix}{minimum}{suffix}" if minimum == maximum else f"{prefix}{minimum}-{maximum}{suffix}"
    if minimum is not None:
        return f"{prefix}{minimum}+{suffix}"
    return f"{prefix}up to {maximum}{suffix}"


def _warnings(value: str, messages: dict[str, str]) -> list[dict[str, str]]:
    return [{"code": code, "message": messages[code]} for code in _json_strings(value) if code in messages]


def _reasons(value: str, messages: dict[str, str]) -> list[dict[str, str]]:
    return [{"code": code, "message": messages[code]} for code in _json_strings(value) if code in messages]


def _market_factors(value: str) -> list[dict[str, Any]]:
    factors: list[dict[str, Any]] = []
    for item in _json_records(value):
        name = str(item.get("name") or "")
        if name not in MARKET_SAFE_FACTOR_NAMES:
            continue
        factors.append(
            {
                "name": name,
                "score": _number(item.get("score")),
                "band": _confidence_band(item.get("band")),
                "reason": _safe_market_factor_reason(item.get("reason")),
            }
        )
    return factors


def _safe_market_factor_reason(value: object) -> str:
    if not isinstance(value, str):
        return MARKET_DEFAULT_FACTOR_REASON
    text = " ".join(value.split())
    if not text:
        return MARKET_DEFAULT_FACTOR_REASON
    lowered = text.casefold()
    if any(term in lowered for term in MARKET_UNSAFE_FACTOR_REASON_TERMS):
        return MARKET_DEFAULT_FACTOR_REASON
    if len(text) > MARKET_MAX_FACTOR_REASON_LENGTH:
        return text[: MARKET_MAX_FACTOR_REASON_LENGTH - 3].rstrip() + "..."
    return text


def _market_sources(value: str) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for item in _json_records(value):
        source_id = str(item.get("source_id") or "")
        source_type = str(item.get("source_type") or "")
        defaults = MARKET_SOURCE_DEFAULTS.get(source_id)
        if defaults is None or source_type != defaults["sourceType"]:
            continue
        sources.append(
            {
                "sourceId": source_id,
                "displayName": defaults["displayName"],
                "sourceType": defaults["sourceType"],
                "releaseYear": _nullable_int(item.get("release_year")),
                "snapshotVersion": defaults["snapshotVersion"],
                "geographyScope": defaults["geographyScope"],
                "aggregateBucket": defaults["aggregateBucket"],
                "attribution": defaults["attribution"],
                "sampleCount": _nullable_int(item.get("sample_count")),
            }
        )
    return sources


def _market_evidence(value: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in _json_records(value):
        source_id = str(item.get("source_id") or "")
        defaults = MARKET_SOURCE_DEFAULTS.get(source_id)
        if defaults is None:
            continue
        minimum_amount = _nullable_int(item.get("minimum_amount"))
        maximum_amount = _nullable_int(item.get("maximum_amount"))
        if minimum_amount is None and maximum_amount is None:
            continue
        rows.append(
            {
                "sourceId": source_id,
                "displayName": defaults["displayName"],
                "companyName": _safe_market_evidence_text(item.get("company_name")) or "unknown company",
                "roleTitle": _safe_market_evidence_text(item.get("role_title")) or "unknown role",
                "location": _safe_market_evidence_text(item.get("location")),
                "levelLabel": _safe_market_evidence_text(item.get("level_label")),
                "companyTier": _company_tier(item.get("company_tier")),
                "component": _market_component(item.get("component")),
                "currency": _market_currency(item.get("currency")),
                "period": _market_period(item.get("period")),
                "minimumAmount": minimum_amount if minimum_amount is not None else maximum_amount or 0,
                "maximumAmount": maximum_amount if maximum_amount is not None else minimum_amount or 0,
                "sampleCount": _nullable_int(item.get("sample_count")),
                "releaseYear": _nullable_int(item.get("release_year")),
                "companyScore": _market_score(item.get("company_score")),
                "roleScore": _market_score(item.get("role_score")),
                "levelScore": _market_score(item.get("level_score")),
                "locationScore": _market_score(item.get("location_score")),
                "freshnessScore": _market_score(item.get("freshness_score")),
            }
        )
    return rows


def _safe_market_evidence_text(value: object) -> str | None:
    text = _nullable_text(value)
    if text is None:
        return None
    compact = " ".join(text.split())
    lowered = compact.casefold()
    if any(term in lowered for term in MARKET_UNSAFE_FACTOR_REASON_TERMS):
        return None
    return compact[:160] if compact else None


def _market_component(value: object) -> str:
    text = _nullable_text(value)
    return text if text in {"base_salary", "total_compensation"} else "total_compensation"


def _market_period(value: object) -> str:
    text = _nullable_text(value)
    return text if text in {"year", "month"} else "year"


def _market_currency(value: object) -> str:
    text = str(value or "EUR").strip().upper()
    return text if re.fullmatch(r"[A-Z]{3}", text) else "EUR"


def _market_score(value: object) -> float:
    return round(max(0.0, min(1.0, _number(value))), 2)


def _safe_market_aggregate_bucket(value: object, sources: list[dict[str, Any]]) -> str | None:
    text = _nullable_text(value)
    if text in MARKET_SAFE_AGGREGATE_BUCKETS:
        return text
    buckets = list(dict.fromkeys(str(source["aggregateBucket"]) for source in sources))
    return ", ".join(buckets) if buckets else None


def _safe_market_geography_scope(value: object) -> str | None:
    text = _nullable_text(value)
    return text if text in MARKET_SAFE_GEOGRAPHY_SCOPES else None


def _company_tier(value: object) -> str:
    text = _nullable_text(value)
    if text in {"tier_1_local", "tier_2_ambitious", "tier_3_top_of_market"}:
        return text
    return "unknown"


def _market_match_scope(value: object) -> str:
    text = _nullable_text(value)
    if text in {
        "exact_company_role",
        "same_location_role_fallback",
        "company_adjacent_role",
        "tier_role_fallback",
        "market_baseline_fallback",
    }:
        return text
    return "none"


def _json_strings(value: str) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str)]


def _json_records(value: str) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _nullable_text(value: object) -> str | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    return text if text else None


def _nullable_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _number(value: object) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def _confidence_band(value: object) -> str:
    text = str(value or "none")
    return text if text in MARKET_CONFIDENCE_BANDS else "none"


def _with_synthetic_pdf_artifacts(
    job_url: str,
    artifacts: list[dict],
    materials: dict,
) -> list[dict]:
    out = list(artifacts)
    seen = {
        (str(item.get("artifact_type") or ""), str(item.get("local_path") or ""))
        for item in out
    }
    preferred_generation = materials.get("generation")

    tailor_source = _preferred_artifact_source(
        out,
        {"tailored_resume", "tailored_resume_txt"},
        preferred_generation,
    )
    tailor_pdf_path = materials.get("resume_pdf_path")
    if (
        not tailor_pdf_path
        and tailor_source
        and tailor_source.get("artifact_type") == "tailored_resume_txt"
    ):
        tailor_pdf_path = _pdf_sibling(str(tailor_source.get("local_path") or ""))
    if tailor_pdf_path and ("tailored_resume_pdf", tailor_pdf_path) not in seen:
        out.append(
            {
                "artifact_id": f"{job_url}:tailored_resume_pdf:{tailor_pdf_path}",
                "artifact_type": "tailored_resume_pdf",
                "status": "active",
                "local_path": tailor_pdf_path,
                "created_at": tailor_source.get("created_at") if tailor_source else None,
                "size_bytes": None,
                "generation": tailor_source.get("generation") if tailor_source else None,
                "metadata_json": tailor_source.get("metadata_json") if tailor_source else None,
            }
        )

    cover_source = _preferred_artifact_source(
        out,
        {"cover_letter", "cover_letter_txt"},
        preferred_generation,
    )
    cover_pdf_path = materials.get("cover_pdf_path")
    if (
        not cover_pdf_path
        and cover_source
        and cover_source.get("artifact_type") == "cover_letter_txt"
    ):
        cover_pdf_path = _pdf_sibling(str(cover_source.get("local_path") or ""))
    if cover_pdf_path and ("cover_letter_pdf", cover_pdf_path) not in seen:
        out.append(
            {
                "artifact_id": f"{job_url}:cover_letter_pdf:{cover_pdf_path}",
                "artifact_type": "cover_letter_pdf",
                "status": "active",
                "local_path": cover_pdf_path,
                "created_at": cover_source.get("created_at") if cover_source else None,
                "size_bytes": None,
                "generation": cover_source.get("generation") if cover_source else None,
                "metadata_json": cover_source.get("metadata_json") if cover_source else None,
            }
        )
    return out


def _preferred_artifact_source(
    artifacts: list[dict],
    artifact_types: set[str],
    preferred_generation: object,
) -> dict | None:
    candidates = [
        artifact
        for artifact in artifacts
        if str(artifact.get("artifact_type") or "") in artifact_types
        and _is_default_visible_artifact(str(artifact.get("status") or ""))
    ]
    candidates.sort(
        key=lambda artifact: (
            artifact.get("generation") == preferred_generation,
            _artifact_status_rank(str(artifact.get("status") or "")),
            int(artifact.get("generation") or -1),
        ),
        reverse=True,
    )
    return candidates[0] if candidates else None


def _is_default_visible_artifact(status: str) -> bool:
    return status.lower() != "suppressed"


def _artifact_status_rank(status: str) -> int:
    match status.lower():
        case "approved" | "active":
            return 3
        case "candidate":
            return 2
        case "rejected":
            return 1
        case _:
            return 0


def _pdf_sibling(value: str) -> str | None:
    if not value:
        return None
    base = value.rsplit(".", 1)[0] if "." in value else value
    return f"{base}.pdf"


def _row_get(row: object, key: str) -> object:
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[key]  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_loads(value: str | None, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _preview_text(value: str, limit: int) -> str:
    if not value:
        return ""
    return value if len(value) <= limit else f"{value[:limit]}..."


def _camel_score_breakdown(value) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "technicalFit": _score_dimension(data.get("technical_fit", data.get("technicalFit"))),
        "experienceFit": _score_dimension(data.get("experience_fit", data.get("experienceFit"))),
        "roleFit": _score_dimension(data.get("role_fit", data.get("roleFit"))),
        "reasoning": data.get("reasoning") if isinstance(data.get("reasoning"), str) else "",
        "fitBand": _string_choice(data.get("fit_band", data.get("fitBand")), "plausible"),
        "confidence": _string_choice(data.get("confidence"), "medium"),
        "eligibility": _camel_score_eligibility(data.get("eligibility")),
        "matchedSignals": _string_list(data.get("matched_signals", data.get("matchedSignals"))),
        "missingSignals": _string_list(data.get("missing_signals", data.get("missingSignals"))),
        "transferableSignals": _string_list(
            data.get("transferable_signals", data.get("transferableSignals"))
        ),
    }


def _camel_score_eligibility(value) -> dict:
    data = value if isinstance(value, dict) else {}
    return {
        "status": _string_choice(data.get("status"), "unknown"),
        "hardBlockers": _string_list(data.get("hard_blockers", data.get("hardBlockers"))),
        "warnings": _string_list(data.get("warnings")),
    }


def _score_dimension(value) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        return 0
    if number < 0:
        return 0
    if number > 10:
        return 10
    return number


def _string_choice(value, default: str) -> str:
    candidate = str(value or "").strip()
    return candidate or default


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in value:
        text = str(raw or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _normalize_keywords(value) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    keywords: list[str] = []
    for raw in value:
        keyword = str(raw or "").strip()
        key = keyword.lower()
        if not keyword or key in seen:
            continue
        seen.add(key)
        keywords.append(keyword)
    return keywords


def _company_name(site: str, posting_url: str) -> str:
    inferred = _inferred_company_from_url(posting_url)
    if inferred:
        return inferred
    if not site or site.lower() in _SOURCE_BOARD_NAMES:
        return "Unknown company"
    return site


def _inferred_company_from_url(raw_url: str) -> str:
    if not raw_url:
        return ""
    try:
        from urllib.parse import urlparse

        parsed = urlparse(raw_url)
    except ValueError:
        return ""
    host = parsed.hostname or ""
    segments = [seg for seg in parsed.path.split("/") if seg]
    if not segments:
        return ""
    if host.endswith("greenhouse.io"):
        return _title_from_slug(segments[0])
    if host == "jobs.lever.co":
        return _title_from_slug(segments[0])
    if host == "jobs.ashbyhq.com":
        return _title_from_slug(segments[0])
    return ""


def _title_from_slug(value: str) -> str:
    known = {"gitlab": "GitLab"}
    lowered = value.lower()
    if lowered in known:
        return known[lowered]
    return " ".join(part.capitalize() for part in value.replace("_", "-").split("-") if part)


def _derive_apply_status(ar_status: str | None, legacy_status: str | None) -> str | None:
    if ar_status:
        if ar_status == "succeeded":
            return "applied"
        if ar_status in {"starting", "in_progress"}:
            return "in_progress"
        if ar_status == "dry_run_complete":
            return "dry_run"
        return ar_status
    return legacy_status


__all__ = [
    "PROJECTION_NAME",
    "ProjectionBuilder",
    "STAGE_ORDER",
]
