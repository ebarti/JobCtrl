"""Explicit construction of recipe application and concrete adapters."""

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.preparation import PreparationService
from jobctrl.app.preparation_http import build_routes
from jobctrl.app.preparation_store import SCHEMA, PreparationStore


def build_feature(runtime: Runtime, *, profile, jobs, requirements, fit, resumes,
                  discovery=None, **_ports) -> Feature:
    runtime.database.initialize_feature("preparation", SCHEMA)
    checkpoints = PreparationStore(runtime.database, runtime.events)
    service = PreparationService(
        checkpoints, runtime.settings.snapshot,
        profile=profile, jobs=jobs, requirements=requirements, fit=fit,
        resumes=resumes, discovery=discovery,
    )
    return Feature("preparation", service, build_routes(service),
                   {"preparation.run": service.run, "preparation.retry": service.retry},
                   action_finalizers={"preparation.run": checkpoints.finalize_run, "preparation.retry": checkpoints.finalize_run})
