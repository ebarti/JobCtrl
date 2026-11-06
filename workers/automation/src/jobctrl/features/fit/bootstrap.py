"""Explicit dependency composition; no optional legacy writer or SQL bridge."""

from jobctrl.app.contracts import Feature, Runtime

from .http import AssessInput, CorrectInput, CoverageInput, routes
from .schema import SCHEMA
from .service import FitService
from .storage import FitStore


def build_feature(runtime: Runtime, **ports) -> Feature:
    profile = ports["profile"]
    requirements = ports["requirements"]
    runtime.database.initialize_feature("fit", SCHEMA)
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

    return Feature(name="fit", service=service, routes=routes(service), actions={
        "fit.assess": assess, "fit.correct": correct, "fit.refresh_coverage": refresh_coverage,
    })
