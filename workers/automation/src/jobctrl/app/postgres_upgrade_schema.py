"""Source-generation admission and schema-only setup for the one-way import."""

from importlib import import_module

# Import declarations only. Constructing the application would seed data,
# recover unfinished artifacts and open credential adapters before verification.
FEATURE_SCHEMAS = (
    ("profile", "features.profile.schema", "SCHEMA"),
    ("jobs", "features.jobs.schema", "SCHEMA"),
    ("jobs_recover_discovery_details_v1", "features.jobs.schema", "RECOVER_DISCOVERY_DETAILS"),
    ("jobs_url_imports_v1", "features.jobs.url_imports", "SCHEMA"),
    ("requirements", "features.requirements.schema", "SCHEMA"),
    ("requirements_attempt_refusals_v1", "features.requirements.schema", "ATTEMPT_REFUSAL_SCHEMA"),
    ("requirements_normalization_v1", "features.requirements.normalization_schema", "SCHEMA"),
    ("requirements_refresh_transport_v1", "features.requirements.normalization_schema", "REFRESH_TRANSPORT_SCHEMA"),
    ("requirements_initial_cohort_v1", "features.requirements.cohort_storage", "SCHEMA"),
    ("fit", "features.fit.schema", "SCHEMA"),
    ("fit_refresh", "features.fit.schema", "REFRESH_SCHEMA"),
    ("fit_associations", "features.fit.association_storage", "SCHEMA"),
    ("fit_current_wordings", "features.fit.current_wording_storage", "SCHEMA"),
    ("fit_initial_cohort_v1", "features.fit.cohort_storage", "SCHEMA"),
    ("resumes", "features.resumes.schema", "SCHEMA"),
    ("discovery", "features.discovery.schema", "SCHEMA"),
    ("companies", "features.companies.schema", "SCHEMA"),
    ("contacts", "features.contacts.schema", "SCHEMA"),
    ("applications", "features.applications.schema", "SCHEMA"),
    ("application_feedback", "features.applications.feedback_schema", "SCHEMA"),
    ("interviews", "features.interviews.schema", "SCHEMA"),
    ("interviews_runs", "features.interviews.schema", "RUN_SCHEMA"),
    ("learning", "features.learning.schema", "SCHEMA"),
    ("learning_requests", "features.learning.schema", "REQUEST_SCHEMA"),
    ("compensation", "features.compensation.schema", "SCHEMA"),
    ("offers", "features.offers.schema", "SCHEMA"),
    ("outreach", "features.outreach.schema", "SCHEMA"),
    ("digest", "features.digest.schema", "SCHEMA"),
    ("preparation", "app.preparation_store", "SCHEMA"),
    ("worker_identity", "app.worker_identity", "SCHEMA"),
    ("runtime_schedules", "app.scheduling", "SCHEMA"),
    ("extension", "extension_transport", "SCHEMA"),
)


TARGET_ONLY_SCHEMAS = (
    ("model_operation_receipts_v1", "app.model_custody", "SCHEMA"),
    ("shared_model_work_v1", "app.model_shared_work", "SCHEMA"),
    ("contacts_research_execution_v1", "features.contacts.schema", "RESEARCH_EXECUTION_SCHEMA"),
    ("companies_refresh_execution_v1", "features.companies.schema", "REFRESH_EXECUTION_SCHEMA"),
)


def initialize_target(database):
    from jobctrl.app.errors import AppError
    for name, module, symbol in (*FEATURE_SCHEMAS, *TARGET_ONLY_SCHEMAS):
        try:
            database.initialize_feature(name, getattr(import_module("jobctrl." + module), symbol))
        except AppError as error:
            if error.code == "feature_schema_mismatch":
                raise AppError(f"staged_feature_schema_changed:{name}",
                               "Rehearse the changed candidate against a fresh staged database.", 409) from None
            raise
