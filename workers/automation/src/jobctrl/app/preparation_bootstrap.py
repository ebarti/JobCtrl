"""Explicit construction of recipe application and concrete adapters."""

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.preparation import PreparationService
from jobctrl.app.preparation_http import build_routes
from jobctrl.app.preparation_store import SCHEMA, PreparationStore


def build_feature(runtime: Runtime, *, profile, jobs, requirements, fit, resumes,
                  discovery=None, **_ports) -> Feature:
    runtime.database.initialize_feature("preparation", SCHEMA)
    service = PreparationService(
        PreparationStore(runtime.database, runtime.events), runtime.settings.snapshot,
        profile=profile, jobs=jobs, requirements=requirements, fit=fit,
        resumes=resumes, discovery=discovery,
    )
    return Feature("preparation", service, build_routes(service),
                   {"preparation.run": service.run, "preparation.retry": service.retry})
