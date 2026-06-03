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
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Callable

from jobhunter.domain.events.base import DomainEvent
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


log = logging.getLogger(__name__)


PROJECTION_NAME = "operations_projections"

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


def _job_list_stage(stage: str | None) -> str:
    return "apply" if stage == "apply" else "discover"

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
        enrichment = self._load_enrichment(job_url)
        apply_run = self._load_latest_apply_run(job_url)
        deleted_at = self._load_deleted_at(job_url)
        artifacts = self._load_artifacts(job_url)

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
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            current_stage=current_stage,
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
            score_breakdown_json=score_breakdown_json,
            score_keywords_json=score_keywords_json,
            score_reasoning=score_reasoning,
            score_version=score_version,
            scored_at=scored_at,
            stages=tuple(stages),
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
            )
            for a in artifacts
        ]
        self._store.replace_artifacts_for_job(
            str(self._tenant_id), job_url, artifact_projs
        )

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
                    retryable=bool(_row_nullable_int(row, "retryable") or 1),
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
                SELECT MAX(generation) FROM job_materials WHERE job_url = ?
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
                       size_bytes, generation
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
