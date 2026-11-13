"""Manual Jobs application service, independent of optional Discovery/Companies."""

from __future__ import annotations

import uuid
from typing import Protocol

from jobctrl.app.errors import AppError
from jobctrl.semantic import DeterminationFailure
from jobctrl.features.jobs.domain.postings import digest, posting_url


class PostingRepository(Protocol):
    def register_deletion_port(self, callback): ...
    def register_post_commit_deletion_port(self, callback, feature=None): ...
    def snapshot(self, job_id, *, connection=None, include_deleted=False): ...
    def snapshots(self, job_ids, *, connection=None, include_deleted=False): ...
    def capture(self, data, **options): ...
    def resolve_url(self, url, *, connection=None): ...
    def resolve_posting(self, data, *, connection=None): ...
    def capture_receipt(self, receipt_key, *, expected_fingerprint=None, connection=None): ...
    def assert_current(self, job_id, revision, source_hash=None, *, connection=None): ...
    def list(self, filters=None, *, connection=None, ids_only=False): ...
    def history(self, job_id): ...
    def record_attempt(self, **data): ...
    def quarantine(self, data, **options): ...
    def list_quarantine(self): ...
    def decide_quarantine(self, quarantine_id, decision): ...
    def availability(self, job_id, *, connection=None): ...
    def set_visibility(self, job_ids, action, **options): ...
    def create_delete_selection(self, job_ids=None, filters=None): ...
    def analysis(self, job_id, *, connection=None): ...
    def analysis_operation(self, operation_id, input_fingerprint, *, connection=None): ...
    def bind_analysis_operation(self, operation_id, input_fingerprint, posting, analysis): ...
    def save_analysis(self, posting, result, *, cancelled=None): ...


class PostingAcquirer(Protocol):
    def bind_crawler_settings(self, provider): ...
    async def acquire(self, payload: dict, *, cancelled=None) -> dict: ...
    async def source_page(self, url, *, session=None, captured=None, cancelled=None): ...
    async def availability(self, posting, *, cancelled=None): ...
    async def verify_refresh_identity(self, previous, candidate): ...


class JobsService:
    def __init__(self, repository: PostingRepository, acquirer: PostingAcquirer, role_analysis=None):
        self.repository, self.acquirer = repository, acquirer
        self.fit = None
        self.role_analysis = role_analysis

    def bind_fit(self, fit):
        self.fit = fit

    def bind_crawler_settings(self, provider):
        self.acquirer.bind_crawler_settings(provider)

    def select_job_ids(self, filters=None, connection=None):
        return self.repository.list(filters, connection=connection, ids_only=True)

    def get_job_snapshots(self, job_ids, connection=None, *, include_deleted=False):
        return self.repository.snapshots(job_ids, connection=connection, include_deleted=include_deleted)

    def revision_stamps(self, job_ids, connection=None):
        return {
            job_id: {key: snapshot[key] for key in ("revision", "state_revision", "source_hash")}
            for job_id, snapshot in self.get_job_snapshots(job_ids, connection=connection, include_deleted=True).items()
        }

    def register_deletion_port(self, callback):
        self.repository.register_deletion_port(callback)

    def register_post_commit_deletion_port(self, callback, feature=None):
        self.repository.register_post_commit_deletion_port(callback, feature)

    async def acquire_posting(self, payload, *, cancelled=None):
        try:
            return await self.acquirer.acquire(payload, cancelled=cancelled)
        except DeterminationFailure as error:
            raise AppError(error.code, "The posting determination is not bound to its captured sources.", 409) from None

    async def acquire_source_page(self, url, *, session=None, captured=None, cancelled=None):
        try:
            return await self.acquirer.source_page(url, session=session, captured=captured, cancelled=cancelled)
        except DeterminationFailure as error:
            raise AppError(error.code, "The captured page exceeds or violates its source contract.", 409) from None

    def validate_posting_url(self, value):
        try:
            return posting_url(value)
        except (TypeError, ValueError):
            raise AppError("invalid_posting_url", "Supply a public HTTP(S) posting URL.") from None

    def record_capture_attempt(self, **data):
        return self.repository.record_attempt(**data)

    def quarantine_posting(self, data, *, job_id=None, expected_revision=None, reason="low_confidence_extraction"):
        return self.repository.quarantine(data, job_id=job_id, expected_revision=expected_revision, reason=reason)

    def list_quarantine(self):
        return self.repository.list_quarantine()

    def decide_quarantine(self, quarantine_id, decision):
        return self.repository.decide_quarantine(quarantine_id, decision)

    def get_posting_snapshot(self, job_id: str, connection=None, *, include_deleted=False) -> dict:
        return self.repository.snapshot(job_id, connection=connection, include_deleted=include_deleted)

    def get_job(self, job_id: str, connection=None) -> dict:
        return self.get_posting_snapshot(job_id, connection=connection)

    def application_admissibility(self, job_id, connection=None):
        snapshot = self.get_posting_snapshot(job_id, connection=connection)
        return {
            key: snapshot[key]
            for key in ("job_id", "revision", "source_hash", "quarantined", "active_state", "needs_enrichment")
        }

    def snapshot(self, job_id: str, connection=None) -> dict:
        return self.get_posting_snapshot(job_id, connection=connection)

    def assert_posting_current(self, job_id: str, revision: int, source_hash=None, connection=None) -> dict:
        return self.repository.assert_current(job_id, revision, source_hash, connection=connection)

    def list_jobs(self, filters=None, connection=None) -> dict:
        filters = filters or {}
        score_sort = filters.get("sort") in {"fit_score", "fitScore", "score"}
        score_filter = any(
            filters.get(key) is not None for key in ("minFitScore", "maxFitScore", "min_fit_score", "max_fit_score")
        )
        if not score_sort and not score_filter:
            return self.repository.list(filters, connection=connection)
        if self.fit is None:
            raise AppError("fit_unavailable", "Fit filters require the Fit feature.", 409)
        rows, offset = [], 0
        while True:
            page = self.repository.list(
                {**filters, "sort": "created_at", "limit": 1000, "offset": offset}, connection=connection
            )
            rows.extend(page["jobs"])
            offset += len(page["jobs"])
            if offset >= page["total"] or not page["jobs"]:
                break
        summaries = self.fit.summary_for_jobs([row["job_id"] for row in rows], connection=connection)
        for row in rows:
            summary = summaries.get(row["job_id"], {})
            row["fit"] = summary
            row["fit_score"] = (
                summary.get("score", {}).get("score") if summary.get("current") and summary.get("score") else None
            )
        lower, upper = (
            filters.get("minFitScore", filters.get("min_fit_score")),
            filters.get("maxFitScore", filters.get("max_fit_score")),
        )
        if lower is not None:
            rows = [row for row in rows if row["fit_score"] is not None and row["fit_score"] >= float(lower)]
        if upper is not None:
            rows = [row for row in rows if row["fit_score"] is not None and row["fit_score"] <= float(upper)]
        if score_sort:
            descending = str(filters.get("direction") or "desc").lower() != "asc"
            rows.sort(
                key=lambda row: (
                    row["fit_score"] is None,
                    -(row["fit_score"] or 0) if descending else row["fit_score"] or 0,
                    row["job_id"],
                )
            )
        limit, offset = max(1, min(1000, int(filters.get("limit") or 100))), max(0, int(filters.get("offset") or 0))
        return {"jobs": rows[offset : offset + limit], "total": len(rows), "limit": limit, "offset": offset}

    def digest_summary(self, since=None) -> dict:
        snapshots = self.list_job_snapshots(since)
        return {"jobs": snapshots, "new_jobs": len(snapshots), "total": self.list_jobs({"limit": 1})["total"]}

    def resolve_url(self, url: str, connection=None) -> dict | None:
        return self.repository.resolve_url(url, connection=connection)

    def resolve_posting(self, data: dict, connection=None) -> dict | None:
        return self.repository.resolve_posting(data, connection=connection)

    def read_capture_receipt(self, receipt_key: str, expected_fingerprint=None) -> dict | None:
        return self.repository.capture_receipt(receipt_key, expected_fingerprint=expected_fingerprint)

    def list_job_snapshots(
        self, since=None, *, include_inactive=False, include_hidden=False, include_deleted=False, connection=None
    ):
        jobs, offset = [], 0
        while True:
            page = self.list_jobs(
                {
                    "since": since,
                    "include_hidden": include_hidden,
                    "include_deleted": include_deleted,
                    "limit": 1000,
                    "offset": offset,
                },
                connection=connection,
            )
            jobs.extend(
                job
                for job in page["jobs"]
                if include_inactive
                or job["active_state"] not in {"closed", "expired", "removed", "location_incompatible"}
            )
            offset += len(page["jobs"])
            if offset >= page["total"] or not page["jobs"]:
                return jobs

    def capture(
        self,
        data: dict,
        *,
        expected_revision=None,
        receipt_key=None,
        receipt_fingerprint=None,
        job_id=None,
        guard=None,
        on_accepted=None,
        connection=None,
        allow_deleted_observation=False,
    ) -> dict:
        # Authored fields are an explicit user source. This path does not invent
        # availability, employer identity, quality or semantic equivalence.
        if not isinstance(data, dict):
            raise AppError("invalid_posting", "The posting must be a JSON object.")
        payload = dict(data)
        payload.setdefault("source_id", "manual")
        payload.setdefault("active_state", "unknown")
        payload.setdefault("provenance", {"authority": "user_authored", "sourceKind": "manual_capture"})
        try:
            result = self.repository.capture(
                payload,
                expected_revision=expected_revision,
                receipt_key=receipt_key,
                job_id=job_id,
                receipt_fingerprint=receipt_fingerprint,
                guard=guard,
                on_accepted=on_accepted,
                connection=connection,
            )
            if result.get("deleted") and not allow_deleted_observation:
                raise AppError("job_deleted", "Restore the saved job before capturing or refreshing this locator.", 409)
            return result
        except ValueError:
            raise AppError("invalid_posting", "The posting fields are invalid.") from None

    def ingest(self, data: dict, *, receipt_key=None, guard=None, connection=None) -> dict:
        """Public Discovery adapter port; all canonical writes still belong here."""
        return self.capture(
            data, receipt_key=receipt_key, guard=guard, connection=connection, allow_deleted_observation=True
        )

    async def capture_external(
        self, payload: dict, *, cancelled=None, guard=None, receipt_fingerprint=None, on_accepted=None
    ) -> dict:
        if not isinstance(payload, dict):
            raise AppError("invalid_posting", "The capture must be a JSON object.")
        receipt_key = payload.get("receipt_key") or payload.get("receiptKey") or payload.get("captureId")
        receipt_fingerprint = receipt_fingerprint or digest(payload)
        if receipt_key:
            accepted = self.read_capture_receipt(receipt_key, expected_fingerprint=receipt_fingerprint)
            if accepted is not None:
                return accepted
        try:
            url = posting_url(payload.get("url") or payload.get("postingUrl") or "")
        except (ValueError, TypeError):
            raise AppError("invalid_posting_url", "Supply a public HTTP(S) posting URL.") from None
        existing = self.resolve_url(url) if url else None
        if existing is not None and existing.get("deleted"):
            raise AppError("job_deleted", "Restore the saved job before capturing or refreshing this locator.", 409)
        expected = payload.get("expectedRevision", payload.get("expected_revision"))
        if existing and expected is None:
            expected = existing["revision"]
        try:
            posting = await self.acquire_posting(payload, cancelled=cancelled)
            if existing is not None:
                posting = await self.acquirer.verify_refresh_identity(existing, posting)
            if cancelled and cancelled():
                raise AppError("action_cancelled", "Capture was cancelled.", 409)
            if posting.pop("quarantine", False):
                quarantine_id = self.repository.quarantine(
                    posting,
                    job_id=existing["job_id"] if existing else None,
                    expected_revision=expected,
                    reason="low_confidence_extraction",
                )
                raise AppError(
                    "posting_quarantined",
                    "The extracted posting needs explicit review.",
                    409,
                    {"quarantineId": quarantine_id},
                )
            result = self.capture(
                posting,
                job_id=existing["job_id"] if existing else None,
                expected_revision=expected,
                receipt_key=receipt_key,
                receipt_fingerprint=receipt_fingerprint,
                guard=guard,
                on_accepted=on_accepted,
            )
            self.repository.record_attempt(job_id=result["job_id"], url=url, state="accepted")
            return result
        except Exception as error:
            self.repository.record_attempt(
                job_id=existing["job_id"] if existing else None,
                url=url,
                failure_code=getattr(error, "code", "capture_failed"),
                data={"captureEvidence": (getattr(error, "details", None) or {}).get("captureEvidence")},
            )
            raise

    async def refresh(
        self, job_id: str, *, expected_revision=None, receipt_key=None, cancelled=None, guard=None
    ) -> dict:
        receipt_fingerprint = digest({"operation": "refresh", "job_id": job_id, "expected_revision": expected_revision})
        if receipt_key:
            if expected_revision is None:
                raise AppError(
                    "expected_revision_required", "A restart-safe refresh needs its original posting revision."
                )
            accepted = self.read_capture_receipt(receipt_key, expected_fingerprint=receipt_fingerprint)
            if accepted is not None:
                return accepted
        current = self.get_job(job_id)
        if expected_revision is not None:
            self.assert_posting_current(job_id, expected_revision)
        return await self.capture_external(
            {
                "url": current["url"],
                "source_id": current["source_id"],
                "source_native_id": current.get("source_native_id") or "",
                "expectedRevision": current["revision"],
                "receipt_key": receipt_key,
            },
            cancelled=cancelled,
            guard=guard,
            receipt_fingerprint=receipt_fingerprint,
        )

    async def check_availability(self, job_id, *, expected_revision=None, receipt_key=None, cancelled=None):
        fingerprint = digest({"operation": "availability", "job_id": job_id, "expected_revision": expected_revision})
        if receipt_key:
            accepted = self.read_capture_receipt(receipt_key, expected_fingerprint=fingerprint)
            if accepted:
                return {**accepted, "availability": accepted.get("capture_provenance", {}).get("availability")}
        current = self.get_job(job_id)
        if expected_revision is not None:
            self.assert_posting_current(job_id, expected_revision)
        try:
            captured = await self.acquirer.availability(current, cancelled=cancelled)
            accepted = self.capture(
                captured,
                job_id=job_id,
                expected_revision=current["revision"],
                receipt_key=receipt_key,
                receipt_fingerprint=fingerprint,
            )
            return {**accepted, "availability": accepted["capture_provenance"]["availability"]}
        except Exception as error:
            self.record_capture_attempt(
                job_id=job_id,
                url=current["url"],
                failure_code=getattr(error, "code", "availability_check_failed"),
                data={"operation": "availability"},
            )
            raise

    def get_availability(self, job_id, connection=None):
        return self.repository.availability(job_id, connection=connection)

    def update(self, job_id, changes):
        expected = changes.get("expectedRevision", changes.get("expected_revision"))
        if expected is None:
            raise AppError("expected_revision_required", "Supply the saved posting revision.")
        current = self.assert_posting_current(job_id, expected)
        allowed = {
            "title",
            "company",
            "description",
            "text",
            "location",
            "salary",
            "application_url",
            "applicationUrl",
            "url",
        }
        edited = {k: v for k, v in changes.items() if k in allowed}
        if "applicationUrl" in edited:
            edited["application_url"] = edited.pop("applicationUrl")
        if "text" in edited:
            edited["description"] = edited.pop("text")
        if "description" in edited:
            edited["full_description"] = edited["enriched_description"] = edited["description"]
        payload = {
            **current,
            **edited,
            "provenance": {"authority": "user_authored", "previousRevision": current["revision"]},
        }
        # Do not retain a conflicting hash/clock from the snapshot being edited.
        payload.pop("observed_at", None)
        return self.capture(payload, job_id=job_id, expected_revision=expected)

    def history(self, job_id):
        return self.repository.history(job_id)

    def set_visibility(self, job_ids, action, **options):
        return self.repository.set_visibility(job_ids, action, **options)

    def create_delete_selection(self, job_ids=None, filters=None):
        if job_ids is not None and (
            not isinstance(job_ids, list)
            or len(job_ids) > 1000
            or not all(isinstance(job_id, str) for job_id in job_ids)
        ):
            raise AppError("invalid_job_selection", "Select at most 1,000 saved Jobs.")
        if filters is not None and not isinstance(filters, dict):
            raise AppError("invalid_job_query", "The saved-job selection filters must be an object.")
        return self.repository.create_delete_selection(job_ids, filters)

    def get_analysis(self, job_id, connection=None):
        return self.repository.analysis(job_id, connection=connection)

    async def analyze(
        self, job_id, *, expected_revision=None, models=None, force=False, cancelled=None, operation_id=None
    ):
        operation_fingerprint = digest(
            {"job_id": job_id, "expected_revision": expected_revision, "models": models, "force": force}
        )
        if operation_id:
            accepted = self.repository.analysis_operation(operation_id, operation_fingerprint)
            if accepted:
                return accepted
        posting = self.get_job(job_id)
        if expected_revision is not None:
            self.assert_posting_current(job_id, expected_revision)
        previous = self.get_analysis(job_id)
        request_fingerprint = self.role_analysis.request_fingerprint(posting, models=models)
        if previous["current"] and not force and previous["accepted"].get("request_fingerprint") == request_fingerprint:
            return (
                self.repository.bind_analysis_operation(operation_id, operation_fingerprint, posting, previous)
                if operation_id
                else previous
            )
        if not posting["description"]:
            raise AppError("posting_description_missing", "Capture the complete posting before role analysis.", 409)
        try:
            result = await self.role_analysis.analyze(
                posting, models=models, cancelled=cancelled,
                refresh_identity=(operation_id or str(uuid.uuid4())) if force else None,
            )
            result.update(operation_id=operation_id, operation_fingerprint=operation_fingerprint)
            return self.repository.save_analysis(posting, result, cancelled=cancelled)
        except Exception as error:
            self.record_capture_attempt(
                job_id=job_id,
                url=posting["url"],
                failure_code=getattr(error, "code", "role_analysis_failed"),
                data={"operation": "role_analysis"},
            )
            raise
