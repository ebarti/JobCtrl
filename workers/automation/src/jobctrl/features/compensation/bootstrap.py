"""Compose the Compensation feature with explicit public ports."""

from __future__ import annotations

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError

from .configuration import source_factory
from pydantic import ValidationError

from .http import RefreshRequest, routes
from .model import GatewayModel
from .repository import CompensationRepository
from .schema import SCHEMA
from .source_authority import OfficialDataVerifier
from .service import CompensationService


def build_feature(runtime: Runtime, **ports) -> Feature:
    jobs = ports.get("jobs")
    if jobs is None:
        raise ValueError("Compensation requires the public Jobs service")
    runtime.database.initialize_feature("compensation", SCHEMA)
    model = GatewayModel(runtime.model)
    repository = CompensationRepository(runtime.database, runtime.events, jobs, model, runtime.settings)
    configured_sources = None if "providers" in ports else (
        lambda options, run_id, preferences: source_factory(options, run_id, preferences, workspace=runtime.workspace)
    )
    service = CompensationService(repository, model, OfficialDataVerifier(), providers=ports.get("providers", ()),
                                  source_factory=configured_sources)


    async def refresh(context, payload):
        job_id = payload.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            raise AppError("invalid_job_id", "A job ID is required.")
        try:
            options = RefreshRequest.model_validate({key: value for key, value in payload.items() if key != "jobId"}).model_dump(exclude_none=True)
        except ValidationError:
            raise AppError("invalid_compensation_refresh", "Review the refresh options.") from None
        return await service.refresh(job_id, options=options, context=context)

    async def refresh_many(context, payload, *, stale_only):
        automatic = payload.get("automatic", False)
        if type(automatic) is not bool:
            raise AppError("invalid_compensation_refresh", "Review the refresh options.")
        if automatic and not service.automatic_enabled():
            return {"ok": True, "status": "skipped", "reason": "automatic_refresh_disabled", "results": []}
        try:
            payload = RefreshRequest.model_validate({key: value for key, value in payload.items() if key != "automatic"}).model_dump(exclude_none=True)
        except ValidationError:
            raise AppError("invalid_compensation_refresh", "Review the refresh options.") from None
        snapshots = jobs.list_job_snapshots()
        limit = payload.get("limit", 0)
        if limit:
            snapshots = snapshots[:limit]
        results = []
        for snapshot in snapshots:
            if automatic and not service.automatic_enabled():
                return {"ok": True, "status": "skipped", "reason": "automatic_refresh_disabled", "results": results}
            if context.cancelled():
                raise AppError("cancelled", "Compensation refresh cancelled.", 409)
            job_id = snapshot["job_id"]
            if stale_only and not service.needs_refresh(snapshot):
                continue
            context.heartbeat({"completed": len(results), "total": len(snapshots)})
            try:
                await service.refresh(job_id, options=payload, context=context, automatic=automatic)
                results.append({"jobId": job_id, "status": "succeeded"})
            except AppError as error:
                if error.code == "cancelled":
                    raise
                results.append({"jobId": job_id, "status": "failed", "code": error.code})
            except Exception:
                results.append({"jobId": job_id, "status": "failed", "code": "compensation_refresh_failed"})
        return {"ok": True, "status": "succeeded" if all(r["status"] == "succeeded" for r in results) else "partial", "results": results}

    async def refresh_all(context, payload):
        return await refresh_many(context, payload, stale_only=False)

    async def refresh_stale(context, payload):
        return await refresh_many(context, payload, stale_only=True)

    return Feature(name="compensation", service=service, routes=routes(service),
                   actions={"compensation.refresh": refresh, "compensation.refresh_all": refresh_all,
                            "compensation.refresh_stale": refresh_stale})
