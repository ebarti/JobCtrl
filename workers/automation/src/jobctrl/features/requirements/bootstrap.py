"""Explicit composition; Requirements depends only on the public Jobs port."""

from __future__ import annotations

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError

from .domain import CONTRACT_VERSION, RequirementError
from .http import CorrectionRequest, RefreshRequest, RevisionRequest, raise_application_error, routes
from .model import RequirementModelAdapter
from .repository import SqliteRequirementStore
from .schema import SCHEMA
from .service import RequirementsService


def build_feature(runtime: Runtime, **ports) -> Feature:
    jobs = ports.get("jobs")
    if jobs is None:
        raise AppError("requirements_jobs_required", "Requirements requires the public Jobs service.", 500)
    runtime.database.initialize_feature("requirements", SCHEMA)
    store = SqliteRequirementStore(runtime.database, runtime.events)
    service = RequirementsService(
        store, jobs, RequirementModelAdapter(runtime.model, store, jobs),
    )

    async def refresh(context, payload):
        from pydantic import ValidationError
        try:
            job_id = payload.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                raise AppError("invalid_job_id", "Supply the job ID.")
            body = RefreshRequest.model_validate({key: value for key, value in payload.items() if key != "job_id"})
        except (ValidationError, AttributeError):
            raise AppError("invalid_request", "The requirement action fields are invalid.") from None
        try:
            return await service.refresh(job_id, **body.model_dump(), cancelled=context.cancelled,
                                         heartbeat=context.heartbeat, operation_id=context.run_id)
        except RequirementError as failure:
            raise_application_error(failure)

    async def revise(context, payload):
        from pydantic import ValidationError
        try:
            requirement_id = payload.get("requirement_id")
            if not isinstance(requirement_id, str) or not requirement_id:
                raise AppError("invalid_requirement_id", "Supply the requirement ID.")
            body = RevisionRequest.model_validate({key: value for key, value in payload.items() if key != "requirement_id"})
        except (ValidationError, AttributeError):
            raise AppError("invalid_request", "The requirement action fields are invalid.") from None
        try:
            return await service.revise_requirement(requirement_id, **{
                **body.model_dump(exclude={"proposed"}), "proposed": body.proposed,
            }, cancelled=context.cancelled, operation_id=context.run_id, heartbeat=context.heartbeat)
        except RequirementError as failure:
            raise_application_error(failure)

    async def correct_binding(context, payload):
        from pydantic import ValidationError
        try:
            job_id, occurrence_id = payload.get("job_id"), payload.get("occurrence_id")
            if not isinstance(job_id, str) or not job_id or not isinstance(occurrence_id, str) or not occurrence_id:
                raise AppError("invalid_occurrence", "Supply the job and occurrence IDs.")
            body = CorrectionRequest.model_validate({key: value for key, value in payload.items() if key not in {"job_id", "occurrence_id"}})
        except (ValidationError, AttributeError):
            raise AppError("invalid_request", "The requirement correction fields are invalid.") from None
        try:
            return await service.correct_binding(job_id, occurrence_id, **body.model_dump(),
                                                 cancelled=context.cancelled, operation_id=context.run_id)
        except RequirementError as failure:
            raise_application_error(failure)

    return Feature(
        name="requirements", service=service, routes=routes(service),
        actions={"requirements.refresh": refresh, "requirements.revise": revise, "requirements.correct_binding": correct_binding},
        action_versions={name: CONTRACT_VERSION for name in (
            "requirements.refresh", "requirements.revise", "requirements.correct_binding",
        )},
    )
