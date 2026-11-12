"""Feature-owned HTTP adapters; no domain action is implemented in routes."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, ValidationError
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError
from .associations import AssociationState, CreateAssociation, ReviseAssociation
from .current_wording import CurrentWordingInput, CurrentWordingState


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class AssessInput(Input):
    expected_revision: StrictInt = Field(ge=0)
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    force: StrictBool = False
    prepare_wording: StrictBool = True
    prepare_coverage: StrictBool = True


class RefreshLimits(Input):
    max_model_calls: StrictInt = Field(default=40, ge=1, le=200)
    max_requirements: StrictInt = Field(default=100, ge=0, le=500)
    max_wording_proposals: StrictInt = Field(default=20, ge=0, le=100)
    max_duration_seconds: StrictInt = Field(default=600, ge=1, le=3600)


class RefreshInput(Input):
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    job_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    expected_input_fingerprint: StrictStr = Field(min_length=64, max_length=64)
    retry_wording_proposal_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    prepare_wording: StrictBool = True
    limits: RefreshLimits = Field(default_factory=RefreshLimits)


class CorrectInput(Input):
    expected_revision: StrictInt = Field(ge=1)
    score: StrictInt = Field(ge=1, le=10)
    rationale: StrictStr = Field(min_length=1, max_length=4000)


class CoverageInput(Input):
    profile_id: StrictStr = Field(default="default", min_length=1, max_length=120)
    prepare_wording: StrictBool = True


class SummaryInput(Input):
    job_ids: list[StrictStr] = Field(max_length=1000)


class EvidenceInput(Input):
    source_id: StrictStr = Field(min_length=1)
    revision: StrictInt | StrictStr
    quote: StrictStr = Field(min_length=1, max_length=6000)


class RequirementCorrectionInput(Input):
    expected_assessment_id: StrictStr = Field(min_length=1)
    expected_fact_semantics_version: StrictInt = Field(ge=1)
    requirement_revision: StrictInt = Field(ge=1)
    kind: StrictStr
    strength: StrictStr | None
    confidence: StrictStr
    rationale: StrictStr = Field(min_length=1, max_length=4000)
    evidence_refs: list[EvidenceInput] = Field(max_length=80)
    achievement_ids: list[StrictStr] = Field(max_length=200)
    eligibility: StrictStr = "unknown"
    blocker_category: StrictStr | None = None
    warning_category: StrictStr | None = None
    profile_id: StrictStr = "default"


async def body(request, schema):
    try:
        return schema.model_validate(await request.json())
    except (ValueError, TypeError, ValidationError):
        raise AppError("fit_invalid_request", "The Fit request has missing or invalid fields.", 422) from None


def routes(service) -> tuple:
    async def set_current_wording(request):
        payload = await body(request, CurrentWordingInput)
        return JSONResponse(service.set_current_wording(payload.model_dump()))

    async def current_wording_state(request):
        payload = await body(request, CurrentWordingState)
        return JSONResponse(service.set_current_wording_state(request.path_params["assignment_id"], payload.model_dump()))

    async def current_wording_history(request):
        limit, offset = history_pagination(request)
        return JSONResponse(service.current_wording_history(request.path_params["assignment_id"],
            request.query_params.get("profile_id", "default"), limit=limit, offset=offset))

    async def requirement_library(request):
        return JSONResponse(service.requirement_library(request.query_params.get("profile_id", "default")))

    async def create_association(request):
        payload = await body(request, CreateAssociation)
        return JSONResponse(service.create_association(payload.model_dump()))

    async def association_state(request):
        payload = await body(request, AssociationState)
        return JSONResponse(service.set_association_state(request.path_params["association_id"], payload.model_dump()))

    async def revise_association(request):
        payload = await body(request, ReviseAssociation)
        return JSONResponse(service.revise_association(request.path_params["association_id"], payload.model_dump()))

    async def association_history(request):
        limit, offset = history_pagination(request)
        return JSONResponse(service.association_history(request.path_params["association_id"],
            request.query_params.get("profile_id", "default"), limit=limit, offset=offset))

    def history_pagination(request):
        try:
            limit, offset = int(request.query_params.get("limit", "50")), int(request.query_params.get("offset", "0"))
        except ValueError:
            raise AppError("fit_invalid_pagination", "Supply a valid history limit and offset.") from None
        if not 1 <= limit <= 200 or offset < 0:
            raise AppError("fit_invalid_pagination", "Supply a valid history limit and offset.")
        return limit, offset

    async def get_fit(request):
        return JSONResponse(service.get_job_fit(request.path_params["job_id"],
                                                 profile_id=request.query_params.get("profile_id", "default")))

    async def assess(request):
        payload = await body(request, AssessInput)
        return JSONResponse(await service.assess_job(request.path_params["job_id"], **payload.model_dump()))

    async def correct(request):
        payload = await body(request, CorrectInput)
        return JSONResponse(service.correct_score(request.path_params["job_id"], **payload.model_dump()))

    async def history(request):
        return JSONResponse(service.history(request.path_params["job_id"]))

    async def coverage(request):
        value = service.get_job_fit(request.path_params["job_id"],
                                     profile_id=request.query_params.get("profile_id", "default"))
        return JSONResponse({"job_id": value["job_id"], "coverage": value["coverage"]})

    async def prepare_coverage(request):
        payload = await body(request, CoverageInput)
        return JSONResponse(await service.refresh_coverage(request.path_params["job_id"], **payload.model_dump()))

    async def correct_requirement(request):
        payload = await body(request, RequirementCorrectionInput)
        return JSONResponse(service.correct_requirement(request.path_params["requirement_id"], **payload.model_dump()))

    async def evidence_map(request):
        return JSONResponse(service.evidence_map(request.query_params.get("profile_id", "default")))

    async def keywords(request):
        return JSONResponse(service.keywords())

    async def summaries(request):
        payload = await body(request, SummaryInput)
        return JSONResponse({"summaries": service.summary_for_jobs(payload.job_ids)})

    async def policy(request):
        return JSONResponse({"formula_version": "requirement-fit-v2-scoped",
                             "correction_anchors": service.store.anchors()})

    async def refresh_pending(request):
        return JSONResponse(service.refresh_pending(request.query_params.get("profile_id", "default")))

    async def refresh_operation(request):
        allow_pending = request.query_params.get("allow_pending", "false")
        if allow_pending not in {"true", "false"}:
            raise AppError("fit_invalid_request", "allow_pending must be true or false.", 422)
        return JSONResponse(service.refresh_operation(request.path_params["operation_id"], allow_pending=allow_pending == "true"))

    return (
        Route("/v1/fit/current-wordings", set_current_wording, methods=["POST"]),
        Route("/v1/fit/current-wordings/{assignment_id}/state", current_wording_state, methods=["POST"]),
        Route("/v1/fit/current-wordings/{assignment_id}/history", current_wording_history, methods=["GET"]),
        Route("/v1/fit/requirement-library", requirement_library, methods=["GET"]),
        Route("/v1/fit/associations", create_association, methods=["POST"]),
        Route("/v1/fit/associations/{association_id}/state", association_state, methods=["POST"]),
        Route("/v1/fit/associations/{association_id}/revisions", revise_association, methods=["POST"]),
        Route("/v1/fit/associations/{association_id}/history", association_history, methods=["GET"]),
        Route("/v1/fit/refresh/pending", refresh_pending, methods=["GET"]),
        Route("/v1/fit/refresh/operations/{operation_id}", refresh_operation, methods=["GET"]),
        Route("/v1/jobs/{job_id}/fit", get_fit, methods=["GET"]),
        Route("/v1/jobs/{job_id}/fit/assess", assess, methods=["POST"]),
        Route("/v1/jobs/{job_id}/fit/correct", correct, methods=["POST"]),
        Route("/v1/jobs/{job_id}/fit/history", history, methods=["GET"]),
        Route("/v1/jobs/{job_id}/fit/coverage", coverage, methods=["GET"]),
        Route("/v1/jobs/{job_id}/fit/coverage/refresh", prepare_coverage, methods=["POST"]),
        Route("/v1/fit/requirements/{requirement_id}/correct", correct_requirement, methods=["POST"]),
        Route("/v1/fit/evidence-map", evidence_map, methods=["GET"]),
        Route("/v1/fit/summaries", summaries, methods=["POST"]),
        Route("/v1/scoring/keywords", keywords, methods=["GET"]),
        Route("/v1/scoring/policy", policy, methods=["GET"]),
    )
