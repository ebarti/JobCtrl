"""HTTP adapter for confirmed offer terms and decisions."""

from __future__ import annotations

from uuid import UUID

from pydantic import ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError


def routes(service):
    async def offer(request: Request):
        job_id = request.path_params["job_id"]
        try:
            if str(UUID(job_id)) != job_id.lower():
                raise ValueError
        except ValueError:
            raise AppError("invalid_job_id", "Invalid job ID.") from None
        if request.method in {"GET", "HEAD"}:
            return JSONResponse(service.read_offer(job_id))
        try:
            payload = await request.json()
            action = request.path_params["action"]
            if action == "terms":
                result = service.save_terms(job_id, payload)
            elif action == "decisions":
                result = service.record_decision(job_id, payload)
            else:
                raise AppError("not_found", "The requested record does not exist.", 404)
        except (ValidationError, ValueError, TypeError):
            raise AppError("invalid_offer", "Review the offer fields and confirm each source.") from None
        return JSONResponse(result)

    return (
        Route("/v1/jobs/{job_id}/offer", offer, methods=["GET"]),
        Route("/v1/jobs/{job_id}/offer/{action}", offer, methods=["POST"]),
    )
