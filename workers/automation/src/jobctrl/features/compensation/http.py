"""Public compensation reads, source preferences and durable refresh submission."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, ValidationError, field_validator
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    observationsJsonPath: StrictStr | None = Field(default=None, min_length=1, max_length=4000)
    includeEuroTopTech: StrictBool | None = None
    euroTopTechMaxPages: int | None = Field(default=None, ge=1, le=100)
    limit: int | None = Field(default=None, ge=0)

    @field_validator("observationsJsonPath")
    @classmethod
    def local_path(cls, value: str | None) -> str | None:
        if value is not None:
            value = value.strip()
            if not value or "://" in value:
                raise ValueError("an explicit local observation path is required")
        return value


def routes(service):
    async def sources(request: Request):
        if request.method in {"GET", "HEAD"}:
            return JSONResponse(service.sources())
        try:
            return JSONResponse(service.update_policy(await request.json()))
        except (ValidationError, ValueError, TypeError):
            raise AppError("invalid_compensation_source_settings", "Review the source permission settings.") from None

    async def evidence(request: Request):
        job_id = request.path_params["job_id"]
        kind = request.path_params.get("kind")
        if kind == "posted":
            return JSONResponse(service.posted(job_id))
        if kind == "market":
            return JSONResponse(service.market(job_id))
        if kind is not None:
            raise AppError("not_found", "The requested record does not exist.", 404)
        return JSONResponse(service.combined(job_id))

    async def refresh(request: Request):
        try:
            body = RefreshRequest.model_validate(await request.json())
        except (ValidationError, ValueError, TypeError):
            raise AppError("invalid_compensation_refresh", "Review the refresh options.") from None
        payload = body.model_dump(exclude_none=True)
        job_id = request.path_params.get("job_id")
        if job_id:
            service.assert_job_exists(job_id)
            payload["jobId"] = job_id
        result = await request.app.state.application.submit(
            "compensation.refresh" if job_id else "compensation.refresh_all", payload,
            idempotency_key=request.headers.get("idempotency-key"), request_id=request.state.request_id)
        return JSONResponse(result, status_code=202)

    return (
        Route("/v1/compensation/sources", sources, methods=["GET", "PATCH"]),
        Route("/v1/jobs/{job_id}/compensation", evidence, methods=["GET"]),
        Route("/v1/jobs/{job_id}/compensation/{kind}", evidence, methods=["GET"]),
        Route("/v1/jobs/{job_id}/actions/refresh-compensation", refresh, methods=["POST"]),
        Route("/v1/jobs/actions/refresh-compensation", refresh, methods=["POST"]),
    )
