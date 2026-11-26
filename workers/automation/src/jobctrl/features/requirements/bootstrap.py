"""Explicit composition; Requirements depends only on the public Jobs port."""

from __future__ import annotations

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError
from jobctrl.app.model_capacity import wait_for_model_capacity

from .domain import CONTRACT_VERSION, RequirementError
from .http import ConsolidateRequest, CorrectionRequest, OccurrenceCorrectionsRequest, RefreshRequest, RevisionRequest, raise_application_error, routes
from .model import RequirementModelAdapter
from .repository import PostgresRequirementStore
from .schema import ATTEMPT_REFUSAL_SCHEMA, SCHEMA
from .normalization_schema import REFRESH_TRANSPORT_SCHEMA, SCHEMA as NORMALIZATION_SCHEMA
from .cohort_storage import SCHEMA as COHORT_SCHEMA
from .normalization_domain import NORMALIZATION_PROMPT_VERSION, NORMALIZATION_VERSION
from .service import RequirementsService


def build_feature(runtime: Runtime, **ports) -> Feature:
    jobs = ports.get("jobs")
    if jobs is None:
        raise AppError("requirements_jobs_required", "Requirements requires the public Jobs service.", 500)
    runtime.database.initialize_feature("requirements", SCHEMA)
    runtime.database.initialize_feature("requirements_attempt_refusals_v1", ATTEMPT_REFUSAL_SCHEMA)
    runtime.database.initialize_feature("requirements_normalization_v1", NORMALIZATION_SCHEMA)
    runtime.database.initialize_feature("requirements_refresh_transport_v1", REFRESH_TRANSPORT_SCHEMA)
    runtime.database.initialize_feature("requirements_initial_cohort_v1", COHORT_SCHEMA)
    store = PostgresRequirementStore(runtime.database, runtime.events)
    service = RequirementsService(
        store, jobs, RequirementModelAdapter(runtime.model, store, jobs),
    )

    def admitted_manual_prompt(context):
        return service.admitted_catalog_prompt(context.run_id) or NORMALIZATION_PROMPT_VERSION

    def admit_manual(run_id, payload, connection):
        service.admit_manual_catalog_prompt(run_id, connection)

    def consolidation_request(payload):
        from pydantic import ValidationError
        try:
            body = ConsolidateRequest.model_validate(payload)
        except (ValidationError, AttributeError):
            raise AppError("invalid_request", "The catalog consolidation fields are invalid.") from None
        if body.operation_id is not None:
            raise AppError("invalid_request", "Durable consolidation uses the action run identity.")
        return body

    def admit_consolidation(run_id, payload, connection):
        body = consolidation_request(payload)
        try:
            current_revision = store.catalog_revision(connection)
        except RequirementError as failure:
            raise_application_error(failure)
        if body.expected_catalog_revision != current_revision:
            raise AppError(
                "requirements_consolidation_catalog_changed",
                "The skills catalog changed before this request started. Review the current catalog and try again.",
                409, {"currentCatalogRevision": current_revision},
            )
        admit_manual(run_id, payload, connection)

    async def consolidate(context, payload):
        body = consolidation_request(payload)
        try:
            return await service.consolidate_catalog(expected_catalog_revision=body.expected_catalog_revision,
                operation_id=context.run_id, cancelled=context.cancelled, heartbeat=context.heartbeat,
                catalog_prompt_version=admitted_manual_prompt(context))
        except RequirementError as failure:
            raise_application_error(failure)

    def admit_refresh(run_id, payload, connection):
        store.admit_catalog_prompt(run_id, service.refresh_catalog_prompt_version, connection)

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
            with wait_for_model_capacity(context.cancelled):
                return await service.refresh(job_id, **body.model_dump(), cancelled=context.cancelled,
                                             heartbeat=context.heartbeat, operation_id=context.run_id,
                                             catalog_prompt_version=service.admitted_catalog_prompt(context.run_id))
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
            }, cancelled=context.cancelled, operation_id=context.run_id, heartbeat=context.heartbeat,
               catalog_prompt_version=admitted_manual_prompt(context))
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
                                                 cancelled=context.cancelled, operation_id=context.run_id,
                                                 catalog_prompt_version=admitted_manual_prompt(context))
        except RequirementError as failure:
            raise_application_error(failure)

    async def correct_occurrences(context, payload):
        from pydantic import ValidationError
        try:
            job_id = payload.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                raise AppError("invalid_job_id", "Supply the job ID.")
            body = OccurrenceCorrectionsRequest.model_validate({key: value for key, value in payload.items() if key != "job_id"})
        except (ValidationError, AttributeError):
            raise AppError("invalid_request", "The occurrence correction fields are invalid.") from None
        try:
            return await service.correct_occurrences(job_id, **body.model_dump(), cancelled=context.cancelled,
                                                     operation_id=context.run_id, heartbeat=context.heartbeat,
                                                     catalog_prompt_version=admitted_manual_prompt(context))
        except RequirementError as failure:
            raise_application_error(failure)

    return Feature(
        name="requirements", service=service, routes=routes(service),
        actions={"requirements.consolidate": consolidate, "requirements.refresh": refresh, "requirements.revise": revise, "requirements.correct_binding": correct_binding,
                 "requirements.correct_occurrences": correct_occurrences},
        action_scopes={"requirements.consolidate": lambda _payload: "workspace"},
        action_admissions={"requirements.refresh": admit_refresh, "requirements.consolidate": admit_consolidation,
                           "requirements.revise": admit_manual, "requirements.correct_binding": admit_manual,
                           "requirements.correct_occurrences": admit_manual},
        action_versions={name: CONTRACT_VERSION + ":" + NORMALIZATION_VERSION + ":" + NORMALIZATION_PROMPT_VERSION for name in (
            "requirements.consolidate",
            "requirements.refresh", "requirements.revise", "requirements.correct_binding",
            "requirements.correct_occurrences",
        )},
    )
