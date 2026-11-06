"""Real HTTP adapters for the shared requirement application service."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, ValidationError
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError

from .domain import ExtractedRequirement, RequirementError


class RequestValue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class RefreshRequest(RequestValue):
    expected_posting_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    expected_revision: StrictInt = Field(ge=0, le=2**63 - 1)
    force: StrictBool = False


class CorrectionRequest(RequestValue):
    expected_posting_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    expected_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    requirement_id: StrictStr = Field(min_length=1, max_length=120)
    requirement_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    reason: StrictStr = Field(min_length=1, max_length=2000)


class RevisionRequest(RequestValue):
    expected_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    job_id: StrictStr = Field(min_length=1, max_length=120)
    expected_posting_revision: StrictInt = Field(ge=1, le=2**63 - 1)
    proposed: ExtractedRequirement
    reason: StrictStr = Field(min_length=1, max_length=2000)


class RebuildRequest(RequestValue):
    expected_catalog_revision: StrictInt = Field(ge=0, le=2**63 - 1)


def raise_application_error(failure: RequirementError):
    if failure.code in {"catalog_changed", "cancelled", "retrieval_index_stale", "requirements_scan_pending"}:
        status = 409
    elif failure.code in {"model_provenance_missing"}:
        status = 503
    else:
        status = 422
    raise AppError(
        failure.code,
        ("Requirements scan progress is saved. Continue the same refresh to finish; accepted work remains available."
         if failure.code == "requirements_scan_pending" else
         "Requirements were not replaced. Review the source or retry the blocked determination."),
        status,
        details=failure.details,
    ) from None


async def parse_request(request, schema):
    try:
        return schema.model_validate(await request.json())
    except (ValidationError, ValueError, UnicodeDecodeError):
        raise AppError("invalid_request", "The requirement request fields are invalid.", 400) from None


def _pagination(request, *, default=50, maximum=200):
    try:
        limit = int(request.query_params.get("limit", str(default)))
        offset = int(request.query_params.get("offset", "0"))
    except ValueError:
        raise AppError("invalid_pagination", "Supply a valid catalog limit and offset.", 400) from None
    if not 1 <= limit <= maximum or offset < 0:
        raise AppError("invalid_pagination", "Supply a valid catalog limit and offset.", 400)
    return limit, offset


def routes(service):
    async def job_requirements(request):
        if request.method in {"GET", "HEAD"}:
            return JSONResponse(service.find_job_requirements(request.path_params["job_id"]))
        if request.method != "POST":
            raise AppError("method_not_allowed", "This requirement action requires POST.", 405)
        body = await parse_request(request, RefreshRequest)
        try:
            result = await service.refresh(request.path_params["job_id"], **body.model_dump())
        except RequirementError as failure:
            raise_application_error(failure)
        return JSONResponse(result)

    async def catalog(request):
        limit, offset = _pagination(request)
        query = request.query_params.get("q", "")
        if len(query) > 2500:
            raise AppError("invalid_query", "The literal catalog query is too long.", 400)
        try:
            return JSONResponse(service.catalog(limit=limit, offset=offset, query=query))
        except RequirementError as failure:
            raise_application_error(failure)

    async def detail(request):
        limit, offset = _pagination(request, default=100)
        revision = request.query_params.get("revision")
        if revision is not None:
            if len(revision) > 19 or not revision.isdecimal() or not 0 < int(revision) < 2**63:
                raise AppError("invalid_revision", "Supply a valid canonical revision.")
            revision = int(revision)
        return JSONResponse(service.requirement_detail(request.path_params["requirement_id"], revision=revision, limit=limit, offset=offset))

    async def index_status(request):
        return JSONResponse(service.index_status())

    async def rebuild(request):
        body = await parse_request(request, RebuildRequest)
        try:
            return JSONResponse(service.rebuild_index(**body.model_dump()))
        except RequirementError as failure:
            raise_application_error(failure)

    async def correct_binding(request):
        body = await parse_request(request, CorrectionRequest)
        try:
            result = await service.correct_binding(
                request.path_params["job_id"], request.path_params["occurrence_id"], **body.model_dump(),
            )
        except RequirementError as failure:
            raise_application_error(failure)
        return JSONResponse(result)

    async def revise(request):
        body = await parse_request(request, RevisionRequest)
        try:
            result = await service.revise_requirement(request.path_params["requirement_id"], **{
                **body.model_dump(exclude={"proposed"}), "proposed": body.proposed,
            })
        except RequirementError as failure:
            raise_application_error(failure)
        return JSONResponse(result)

    return (
        Route("/v1/jobs/{job_id}/requirements", job_requirements, methods=["GET", "POST"]),
        Route("/v1/jobs/{job_id}/requirements/{occurrence_id}/binding", correct_binding, methods=["POST"]),
        Route("/v1/requirements", catalog, methods=["GET"]),
        Route("/v1/requirements/index", index_status, methods=["GET"]),
        Route("/v1/requirements/index/rebuild", rebuild, methods=["POST"]),
        Route("/v1/requirements/{requirement_id}", detail, methods=["GET"]),
        Route("/v1/requirements/{requirement_id}/revisions", revise, methods=["POST"]),
    )
