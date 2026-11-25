"""Explicit construction of recipe application and concrete adapters."""

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.preparation import PreparationService
from jobctrl.app.preparation_http import build_routes
from jobctrl.app.preparation_store import SCHEMA, PreparationStore


def build_feature(runtime: Runtime, *, profile, jobs, requirements, fit, resumes,
                  discovery=None, **_ports) -> Feature:
    runtime.database.initialize_feature("preparation", SCHEMA)
    checkpoints = PreparationStore(runtime.database, runtime.events, requirements.record_cohort_attempts)
    service = PreparationService(
        checkpoints, runtime.settings.snapshot,
        profile=profile, jobs=jobs, requirements=requirements, fit=fit,
        resumes=resumes, discovery=discovery,
    )
    def admit(run_id, payload, connection):
        service.admit(run_id, payload, runtime.settings.snapshot(connection), connection)

    return Feature("preparation", service, build_routes(service),
                   {"preparation.run": service.run, "preparation.retry": service.retry,
                    "preparation.assess_discovered": service.assess_discovered},
                   action_finalizers={"preparation.run": service.finalize, "preparation.retry": service.finalize,
                                      "preparation.assess_discovered": service.finalize_discovered},
                   action_versions={"preparation.run": "search-jobs-v1", "preparation.retry": "search-jobs-v1",
                                    "preparation.assess_discovered": "search-jobs-v1"},
                   action_admissions={"preparation.run": admit, "preparation.retry": service.admit_retry})
