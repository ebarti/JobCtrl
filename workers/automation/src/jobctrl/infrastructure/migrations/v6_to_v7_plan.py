"""Declarative inventory for the stopped-runtime v6-to-v7 candidate cutover.

This module deliberately describes migration policy only.  The runner and the
individual transforms consume this inventory later; importing it must not open
or mutate SQLite.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final, Literal, Mapping


SchemaSide = Literal["source", "target"]


class TableDisposition(StrEnum):
    """How a durable table reaches the exact v7 schema."""

    DIRECT_COPY = "direct-copy"
    SCALAR_JOB_ID_REWRITE = "scalar-job-id-rewrite"
    STRUCTURED_REWRITE = "structured-rewrite"
    NEW_EMPTY = "new-empty"
    RETIRED = "retired"


class ColumnRole(StrEnum):
    """The stable semantic role of a source or target column."""

    PRESERVE = "preserve"
    LEGACY_URL_IDENTITY = "legacy-url-identity"
    UNCHANGED_SCHEMA_URL_IDENTITY = "unchanged-schema-url-identity"
    JOB_ID = "job-id"
    LOCATOR_URL = "locator-url"
    SEQUENCE_OWNED = "sequence-owned"
    DERIVED = "derived"
    STRUCTURED_REFERENCE = "structured-reference"
    RETIRED = "retired"


@dataclass(frozen=True)
class TablePlan:
    """One named durable table's v6-to-v7 policy."""

    disposition: TableDisposition
    source_exists: bool = True
    target_exists: bool = True
    source_required: bool = True
    sequence_owned: bool = False


_DIRECT_COPY: Final = frozenset(
    {
        "application_repeat_override_consumptions",
        "candidate_profile_achievement_evidence",
        "candidate_profile_education_entries",
        "candidate_profile_experience_bullets",
        "candidate_profile_experience_entries",
        "candidate_profile_required_bullets",
        "candidate_profile_required_education_entries",
        "candidate_profile_required_experience_entries",
        "candidate_profile_required_skill_categories",
        "candidate_profile_required_skills",
        "candidate_profile_resume_constraint_metrics",
        "candidate_profile_skill_categories",
        "candidate_profile_skill_items",
        "candidate_profiles",
        "contact_attributes",
        "contact_candidates",
        "dashboard_projections",
        "digest_state",
        "discovery_runs",
        "discovery_search_unit_filtered_events",
        "discovery_search_units",
        "discovery_settings",
        "event_watermarks",
        "evidence_usage_projections",
        "llm_spend",
        "outreach_drafts",
        "outreach_send_logs",
        "projection_backfills",
        "resume_template_defaults",
        "resume_template_versions",
        "resume_templates",
        "scoring_policies",
        "source_locator_candidates",
        "source_quality_stats",
        "source_registry_entries",
        "tailoring_policies",
        "workflow_run_projections",
    }
)

_SCALAR_JOB_ID_REWRITE: Final = frozenset(
    {
        "application_repeat_audit",
        "application_repeat_overrides",
        "application_review_decisions",
        "contact_research_tasks",
        "contacts",
        "discovery_execution_jobs",
        "discovery_feedback",
        "discovery_search_unit_jobs",
        "job_artifacts",
        "job_bullet_provenance",
        "job_canonical_identities",
        "job_employer_analysis",
        "job_employer_analysis_failures",
        "job_employer_analysis_sub_analyses",
        "job_enrichments",
        "job_interview_prep",
        "job_interview_prep_items",
        "job_market_compensation_estimates",
        "job_material_layout_boxes",
        "job_materials",
        "job_materials_artifacts",
        "job_posted_compensation_facts",
        "job_rejected_duplicate_links",
        "job_requirement_fit_items",
        "job_requirement_fit_reports",
        "job_resume_template_assignments",
        "job_score_staleness",
        "job_scores",
        "job_source_observations",
        "job_stage_states",
        "manual_capture_queue",
        "operational_attempt_metrics",
        "outreach_threads",
        "posting_snapshot_sets",
        "resume_template_refresh_attempts",
    }
)

_STRUCTURED_REWRITE: Final = frozenset(
    {
        "apply_run_projections",
        "artifact_list_projections",
        "contact_projections",
        "contact_research_task_projections",
        "discovery_quarantine_entries",
        "due_follow_up_projections",
        "job_detail_projections",
        "job_duplicate_links",
        "job_events",
        "job_list_projections",
        "jobs",
        "outreach_thread_projections",
        "pipeline_step_projections",
        "preparation_work_items",
    }
)

_OPTIONAL_DIRECT_COPY: Final = frozenset(
    {
        "discovery_execution_recoveries",
        "resume_review_comment_replies",
        "role_match_feedback_suggestions",
        "worker_runtime_heartbeats",
    }
)

_OPTIONAL_SCALAR_JOB_ID_REWRITE: Final = frozenset(
    {
        "jobctrl_deleted_jobs",
        "jobctrl_hidden_jobs",
        "resume_review_comment_threads",
        "resume_review_draft_revisions",
        "resume_review_drafts",
        "resume_review_edit_deltas",
        "tailoring_feedback_signals",
    }
)

_NEW_EMPTY: Final = frozenset(
    {
        "application_email_evidence",
        "application_outcome_suggestions",
        "application_outcomes",
    }
)

_SEQUENCE_OWNED: Final = frozenset(
    {"job_artifacts", "job_events", "operational_attempt_metrics"}
)


def _table_plans() -> dict[str, TablePlan]:
    plans = {
        table: TablePlan(TableDisposition.DIRECT_COPY)
        for table in _DIRECT_COPY
    }
    plans.update(
        {
            table: TablePlan(
                TableDisposition.SCALAR_JOB_ID_REWRITE,
                sequence_owned=table in _SEQUENCE_OWNED,
            )
            for table in _SCALAR_JOB_ID_REWRITE
        }
    )
    plans.update(
        {
            table: TablePlan(
                TableDisposition.STRUCTURED_REWRITE,
                sequence_owned=table in _SEQUENCE_OWNED,
            )
            for table in _STRUCTURED_REWRITE
        }
    )
    plans.update(
        {
            table: TablePlan(TableDisposition.DIRECT_COPY, source_required=False)
            for table in _OPTIONAL_DIRECT_COPY
        }
    )
    plans.update(
        {
            table: TablePlan(
                TableDisposition.SCALAR_JOB_ID_REWRITE,
                source_required=False,
            )
            for table in _OPTIONAL_SCALAR_JOB_ID_REWRITE
        }
    )
    plans.update(
        {
            table: TablePlan(
                TableDisposition.NEW_EMPTY,
                source_exists=False,
                source_required=False,
            )
            for table in _NEW_EMPTY
        }
    )
    # Job locators are reconstructed from the former jobs.url identity, not
    # copied from an absent v6 table.  Upgrade-history v6 alone retains this
    # retired projection; no v7 table receives its rows.
    plans["job_locators"] = TablePlan(
        TableDisposition.STRUCTURED_REWRITE,
        source_exists=False,
        source_required=False,
    )
    plans["discovery_run_projections"] = TablePlan(
        TableDisposition.RETIRED,
        target_exists=False,
        source_required=False,
    )
    return plans


TABLE_PLANS: Final[Mapping[str, TablePlan]] = MappingProxyType(_table_plans())

# Old values in these columns denote the v6 URL primary key even when the
# column itself was already named ``job_id``.  A plain column-name comparison
# must not turn those values into a direct copy.
_UNCHANGED_SCHEMA_URL_IDENTITIES: Final = {
    ("apply_run_projections", "job_id"),
    ("artifact_list_projections", "job_id"),
    ("contact_projections", "job_id"),
    ("contact_research_task_projections", "job_id"),
    ("due_follow_up_projections", "job_id"),
    ("job_detail_projections", "job_id"),
    ("job_list_projections", "job_id"),
    ("outreach_thread_projections", "job_id"),
    ("preparation_work_items", "job_id"),
    ("job_duplicate_links", "surviving_job_id"),
}

_LEGACY_TO_JOB_ID: Final[Mapping[str, Mapping[str, str]]] = MappingProxyType(
    {
        "application_repeat_audit": {"target_job_key": "target_job_id"},
        "application_repeat_overrides": {
            "target_job_key": "target_job_id",
            "prior_job_key": "prior_job_id",
        },
        "application_review_decisions": {"job_key": "job_id"},
        "contact_research_tasks": {"job_url": "job_id"},
        "contacts": {"job_url": "job_id"},
        "discovery_execution_jobs": {"job_url": "job_id"},
        "discovery_feedback": {"job_key": "job_id"},
        "discovery_search_unit_jobs": {"job_url": "job_id"},
        "job_artifacts": {"job_url": "job_id"},
        "job_bullet_provenance": {"job_url": "job_id"},
        "job_canonical_identities": {"job_url": "job_id"},
        "job_employer_analysis": {"job_url": "job_id"},
        "job_employer_analysis_failures": {"job_url": "job_id"},
        "job_employer_analysis_sub_analyses": {"job_url": "job_id"},
        "job_enrichments": {"job_url": "job_id"},
        "job_interview_prep": {"job_url": "job_id"},
        "job_interview_prep_items": {"job_url": "job_id"},
        "job_market_compensation_estimates": {"job_url": "job_id"},
        "job_material_layout_boxes": {"job_url": "job_id"},
        "job_materials": {"job_url": "job_id"},
        "job_materials_artifacts": {"job_url": "job_id"},
        "job_posted_compensation_facts": {"job_url": "job_id"},
        "job_rejected_duplicate_links": {"owner_job_url": "owner_job_id"},
        "job_requirement_fit_items": {"job_url": "job_id"},
        "job_requirement_fit_reports": {"job_url": "job_id"},
        "job_resume_template_assignments": {"job_url": "job_id"},
        "job_score_staleness": {"job_url": "job_id"},
        "job_scores": {"job_url": "job_id"},
        "job_source_observations": {"job_url": "job_id"},
        "job_stage_states": {"job_url": "job_id"},
        "manual_capture_queue": {"job_key": "job_id"},
        "operational_attempt_metrics": {"job_url": "job_id"},
        "outreach_threads": {"job_url": "job_id"},
        "posting_snapshot_sets": {"job_url": "job_id"},
        "resume_template_refresh_attempts": {"job_url": "job_id"},
        "jobctrl_deleted_jobs": {"job_url": "job_id"},
        "jobctrl_hidden_jobs": {"job_url": "job_id"},
        "resume_review_comment_threads": {"job_key": "job_id"},
        "resume_review_draft_revisions": {"job_key": "job_id"},
        "resume_review_drafts": {"job_key": "job_id"},
        "resume_review_edit_deltas": {"job_key": "job_id"},
        "tailoring_feedback_signals": {"job_key": "job_id"},
    }
)

_LOCATOR_URL_COLUMNS: Final = frozenset(
    {
        ("application_review_decisions", "application_url"),
        ("candidate_profiles", "personal_github_url"),
        ("candidate_profiles", "personal_linkedin_url"),
        ("candidate_profiles", "personal_portfolio_url"),
        ("candidate_profiles", "personal_website_url"),
        ("discovery_quarantine_entries", "posting_url"),
        ("job_canonical_identities", "canonical_url"),
        ("job_enrichments", "application_url"),
        ("job_list_projections", "application_url"),
        ("job_locators", "locator_value"),
        ("job_rejected_duplicate_links", "candidate_url"),
        ("job_source_observations", "normalized_observed_url"),
        ("job_source_observations", "observed_url"),
        ("jobs", "application_url"),
        ("manual_capture_queue", "captured_url"),
        ("manual_capture_queue", "originating_url"),
        ("source_locator_candidates", "candidate_url"),
        ("source_registry_entries", "seed_url"),
    }
)

_STRUCTURED_REFERENCES: Final = frozenset(
    {
        ("discovery_quarantine_entries", "job_id"),
        ("job_duplicate_links", "superseded_job_or_observation_id"),
        ("pipeline_step_projections", "item_key"),
    }
)

_TARGET_JOB_ID_COLUMNS: Final = frozenset(
    {
        ("application_email_evidence", "job_id"),
        ("application_outcome_suggestions", "job_id"),
        ("application_outcomes", "job_id"),
        ("discovery_quarantine_entries", "job_id"),
        ("job_duplicate_links", "surviving_job_id"),
        ("job_events", "job_id"),
        ("job_locators", "job_id"),
        ("jobs", "job_id"),
    }
)

_DERIVED_TARGET_COLUMNS: Final = frozenset(
    {
        ("job_artifacts", "tenant_id"),
        ("job_events", "identity_version"),
        ("job_events", "tenant_id"),
        ("job_materials_artifacts", "tenant_id"),
        ("job_stage_states", "tenant_id"),
        ("jobs", "tenant_id"),
    }
)


def table_plan(table: str) -> TablePlan | None:
    """Return the declared plan, or ``None`` for an unadmitted table."""
    return TABLE_PLANS.get(table)


def classify_column(
    table: str,
    column: str,
    side: SchemaSide,
) -> ColumnRole | None:
    """Return the explicit role for one admitted table column.

    ``PRESERVE`` is itself a classification: it means copy the scalar value
    unchanged after the table's declared transformation has established its
    target row shape.
    """
    plan = table_plan(table)
    if plan is None or (side == "source" and not plan.source_exists):
        return None
    if side == "target" and not plan.target_exists:
        return None
    if (table, column) in _SEQUENCE_COLUMNS:
        return ColumnRole.SEQUENCE_OWNED
    if side == "source" and (table, column) == ("jobs", "url"):
        return ColumnRole.LEGACY_URL_IDENTITY
    if side == "target" and (table, column) == ("jobs", "url"):
        return ColumnRole.LOCATOR_URL
    if side == "source" and (table, column) in _UNCHANGED_SCHEMA_URL_IDENTITIES:
        return ColumnRole.UNCHANGED_SCHEMA_URL_IDENTITY
    rewrite = _LEGACY_TO_JOB_ID.get(table, {})
    if side == "source" and column in rewrite:
        return ColumnRole.LEGACY_URL_IDENTITY
    if side == "target" and column in rewrite.values():
        return ColumnRole.JOB_ID
    if side == "target" and (table, column) in _UNCHANGED_SCHEMA_URL_IDENTITIES:
        return ColumnRole.JOB_ID
    if side == "target" and (table, column) in _TARGET_JOB_ID_COLUMNS:
        return ColumnRole.JOB_ID
    if side == "source" and (table, column) in _STRUCTURED_REFERENCES:
        return ColumnRole.STRUCTURED_REFERENCE
    if side == "target" and (table, column) in _STRUCTURED_REFERENCES:
        return ColumnRole.STRUCTURED_REFERENCE
    if side == "target" and (table, column) in _DERIVED_TARGET_COLUMNS:
        return ColumnRole.DERIVED
    if (table, column) in _LOCATOR_URL_COLUMNS:
        return ColumnRole.LOCATOR_URL
    if plan.disposition is TableDisposition.NEW_EMPTY:
        return ColumnRole.DERIVED
    if plan.disposition is TableDisposition.RETIRED:
        return ColumnRole.RETIRED
    return ColumnRole.PRESERVE


_SEQUENCE_COLUMNS: Final = frozenset(
    {
        ("job_artifacts", "artifact_id"),
        ("job_events", "event_id"),
        ("operational_attempt_metrics", "metric_id"),
    }
)


def required_source_tables() -> frozenset[str]:
    """Return the exact tables required by the fresh shipped-v6 fixture."""
    return frozenset(
        name for name, plan in TABLE_PLANS.items() if plan.source_required
    )


def target_tables() -> frozenset[str]:
    """Return all durable target tables required by the exact v7 schema."""
    return frozenset(
        name for name, plan in TABLE_PLANS.items() if plan.target_exists
    )


__all__ = [
    "ColumnRole",
    "SchemaSide",
    "TABLE_PLANS",
    "TableDisposition",
    "TablePlan",
    "classify_column",
    "required_source_tables",
    "table_plan",
    "target_tables",
]
