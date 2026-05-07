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

import json
import logging
import sqlite3
from datetime import datetime, timezone

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


log = logging.getLogger(__name__)


PROJECTION_NAME = "operations_projections"

STAGE_ORDER: tuple[str, ...] = (
    "discover",
    "enrich",
    "score",
    "tailor",
    "cover",
    "pdf",
    "apply",
)

DEFAULT_MAX_ATTEMPTS: dict[str, int] = {
    "discover": 1,
    "enrich": 3,
    "score": 3,
    "tailor": 5,
    "cover": 5,
    "pdf": 3,
    "apply": 3,
}

_SOURCE_BOARD_NAMES = {"greenhouse", "linkedin", "talent.com"}


class ProjectionBuilder:
    """In-process projection materialiser.

    Wire it once on worker startup with
    :func:`ProjectionBuilder.subscribe_to`.  Call
    :meth:`refresh` after the canonical write so the derived projections
    catch up.  Tests can also drive it manually via :meth:`refresh` after
    seeding data.
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        tenant_id: TenantId = LOCAL_TENANT,
    ) -> None:
        self._conn = conn
        self._tenant_id: TenantId = tenant_id
        ensure_projection_tables(conn)
        self._store = SqliteProjectionStore(conn)
        self._watermarks = SqliteEventWatermarkRepository(conn)

    # ------------------------------------------------------------ subscription

    def subscribe_to(self, publisher: EventPublisher) -> Subscription:
        """Wildcard-subscribe — refresh on every published event."""
        return publisher.subscribe(None, self._on_event)

    def _on_event(self, event: DomainEvent) -> None:
        try:
            self.refresh()
        except Exception:  # noqa: BLE001 — projection failure must not break write
            log.exception(
                "ProjectionBuilder failed to refresh after %s", event.event_type
            )

    # ----------------------------------------------------------------- refresh

    def refresh(self) -> int:
        """Process new ``job_events`` rows and rebuild affected projections.

        Returns the number of dirty jobs processed.  Idempotent: running
        twice in a row produces the same projection state.
        """
        watermark = self._watermarks.get(PROJECTION_NAME)
        rows = self._conn.execute(
            """
            SELECT event_id, job_url, event_type, payload_json
            FROM job_events
            WHERE event_id > ?
            ORDER BY event_id ASC
            """,
            (watermark,),
        ).fetchall()

        dirty_jobs: set[str] = set()
        max_event_id = watermark
        for row in rows:
            event_id = int(row["event_id"]) if not isinstance(row, tuple) else int(row[0])
            if event_id > max_event_id:
                max_event_id = event_id
            job_url = row["job_url"] if not isinstance(row, tuple) else row[1]
            if job_url:
                dirty_jobs.add(str(job_url))

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
        if not dirty_jobs and max_event_id == watermark and dashboard_exists:
            return 0

        if not dirty_jobs:
            # Watermark advanced past events with no job_url (e.g.
            # system events) OR first-run: bump the watermark + ensure
            # the dashboard row exists.
            if max_event_id > watermark:
                self._watermarks.set(PROJECTION_NAME, max_event_id)
            if not dashboard_exists:
                self._rebuild_dashboard()
            self._conn.commit()
            return 0

        # PR 4 of the Temporal stack: rebuild ``apply_run_projections``
        # first so ``_rebuild_job`` can read the freshly derived apply
        # lifecycle status when it materialises ``job_list_projections``.
        self._rebuild_apply_runs()
        for job_url in dirty_jobs:
            self._rebuild_job(job_url)
        self._rebuild_dashboard()
        if max_event_id > watermark:
            self._watermarks.set(PROJECTION_NAME, max_event_id)
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
        employer = _company_name(site, application_url or job_url)

        # currentStage/State: first non-succeeded/non-skipped stage.
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
            current_stage = first_actionable.stage
            current_state = first_actionable.state
            current_error_code = first_actionable.error_code
            current_error_message = first_actionable.error_message
            current_next_action = first_actionable.next_action

        # Score: prefer per-aggregate row, fall back to legacy column.
        fit_score = score.get("fit_score")
        if fit_score is None:
            fit_score = _row_nullable_int(job_row, "fit_score")
        score_reasoning = score.get("reasoning") or _row_str(job_row, "score_reasoning")

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
            score_reasoning=score_reasoning,
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
            score_reasoning=score_reasoning,
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
        explicit: dict[str, sqlite3.Row] = {
            (row["stage"] if not isinstance(row, tuple) else row[1]): row
            for row in rows
        }
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
                SELECT s.fit_score, s.scored_at, s.breakdown_json
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
        if isinstance(breakdown, dict) and isinstance(breakdown.get("reasoning"), str):
            reasoning = breakdown["reasoning"]
        return {
            "fit_score": _row_nullable_int(row, "fit_score"),
            "scored_at": _row_nullable_str(row, "scored_at"),
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
                WHERE job_url = ? AND restored_at IS NULL
                """,
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if row is None:
            return None
        return _row_nullable_str(row, "deleted_at")

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
        # Filter out soft-deleted jobs.
        active_rows = [row for row in rows if not _row_nullable_str(row, "deleted_at")]

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
        try:
            dry_runs = int(
                self._conn.execute(
                    "SELECT COUNT(*) FROM apply_run_projections WHERE dry_run = 1"
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
        "LockReleased": ("failed", "failed"),
    }

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
                "SELECT title, site FROM jobs WHERE url = ? LIMIT 1",
                (job_url,),
            ).fetchone()
        except sqlite3.OperationalError:
            meta = None
        if meta is not None:
            title = _row_str(meta, "title") or title
            site = _row_str(meta, "site") or site

        employer = _company_name(site, job_url)

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
