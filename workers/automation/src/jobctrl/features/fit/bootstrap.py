"""Explicit dependency composition; no optional legacy writer or SQL bridge."""

from pydantic import ValidationError

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError

from .http import AssessInput, CorrectInput, CoverageInput, RefreshInput, routes
from .schema import REFRESH_SCHEMA, SCHEMA
from .service import FitService
from .storage import FitStore
from .association_storage import SCHEMA as ASSOCIATION_SCHEMA
from .current_wording_storage import SCHEMA as CURRENT_WORDING_SCHEMA
from .contract import CONTRACT_VERSION


def build_feature(runtime: Runtime, **ports) -> Feature:
    profile = ports["profile"]
    requirements = ports["requirements"]
    runtime.database.initialize_feature("fit", SCHEMA)
    runtime.database.initialize_feature("fit_refresh", REFRESH_SCHEMA)
    runtime.database.initialize_feature("fit_associations", ASSOCIATION_SCHEMA)
    runtime.database.initialize_feature("fit_current_wordings", CURRENT_WORDING_SCHEMA)
    store = FitStore(runtime.database, runtime.events, profile, requirements, runtime.settings)
    service = FitService(store=store, model=runtime.model,
                         profile=profile, requirements=requirements, settings=runtime.settings)

    async def assess(context, payload):
        values = dict(payload)
        job_id = values.pop("job_id")
        arguments = AssessInput.model_validate(values).model_dump()
        context.heartbeat({"jobId": job_id, "phase": "qualification"})
        result = await service.assess_job(job_id, **arguments, cancelled=context.cancelled, operation_id=context.run_id)
        context.heartbeat({"jobId": job_id, "revision": result["score"]["revision"], "phase": "complete"})
        return result

    async def correct(context, payload):
        values = dict(payload)
        job_id = values.pop("job_id")
        arguments = CorrectInput.model_validate(values).model_dump()
        if context.cancelled():
            service._check_cancelled(context.cancelled)
        return service.correct_score(job_id, **arguments, operation_id=context.run_id)

    async def refresh_coverage(context, payload):
        values = dict(payload)
        job_id = values.pop("job_id")
        arguments = CoverageInput.model_validate(values).model_dump()
        return await service.refresh_coverage(job_id, **arguments, cancelled=context.cancelled)

    async def refresh(context, payload):
        arguments = RefreshInput.model_validate(payload).model_dump()
        return await service.refresh(operation_id=context.run_id, **arguments,
                                     cancelled=context.cancelled, heartbeat=context.heartbeat)

    def refresh_scope(payload):
        try:
            return RefreshInput.model_validate(payload).profile_id
        except (ValueError, TypeError, ValidationError):
            raise AppError("fit_invalid_request", "The Fit request has missing or invalid fields.", 422) from None

    def finalize_refresh(run_id, status, error_code, connection):
        service.interrupt_refresh(run_id, status, error_code, connection=connection)

    return Feature(name="fit", service=service, routes=routes(service), actions={
        "fit.assess": assess, "fit.correct": correct, "fit.refresh_coverage": refresh_coverage, "fit.refresh": refresh,
    }, action_scopes={"fit.refresh": refresh_scope}, action_finalizers={"fit.refresh": finalize_refresh},
        action_versions={key: CONTRACT_VERSION for key in ("fit.assess", "fit.correct", "fit.refresh_coverage", "fit.refresh")})
