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
        "digest_state",
        "discovery_runs",
        "discovery_search_unit_filtered_events",
        "discovery_search_units",
        "discovery_settings",
        "event_watermarks",
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
        "dashboard_projections",
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
        "evidence_usage_projections",
        "workflow_run_projections",
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
    # Job locators are reconstructed from the former jobs.url identity, not
    # copied from an absent v6 table.  Upgrade-history v6 alone retains this
    # retired projection; no v7 table receives its rows.
    plans["job_locators"] = TablePlan(
        TableDisposition.STRUCTURED_REWRITE,
        source_exists=False,
        source_required=False,
    )
    # Scoring keywords are derived solely from each migrated job_scores row.
    # They had no v6 relation to copy, so one dedicated owner prevents
    # duplicate or unnormalized rows from a broad scalar copy.
    plans["job_score_keywords"] = TablePlan(
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
        "application_email_evidence": {"job_key": "job_id"},
        "application_outcome_suggestions": {"job_key": "job_id"},
        "application_outcomes": {"job_key": "job_id"},
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
        "job_events": {"job_url": "job_id"},
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
        ("apply_run_projections", "events_json"),
        ("artifact_list_projections", "metadata_json"),
        ("artifact_list_projections", "layout_boxes_json"),
        ("artifact_list_projections", "bullet_provenance_json"),
        ("artifact_list_projections", "coverage_audit_json"),
        ("artifact_list_projections", "voice_pass_json"),
        ("contact_projections", "source_kinds_json"),
        ("contact_projections", "provenance_json"),
        ("contact_research_task_projections", "source_attempts_json"),
        ("contact_research_task_projections", "candidates_json"),
        ("discovery_quarantine_entries", "job_id"),
        ("discovery_quarantine_entries", "job_key"),
        ("evidence_usage_projections", "projection_id"),
        ("evidence_usage_projections", "payload_json"),
        ("job_detail_projections", "compensation_summary_json"),
        ("job_detail_projections", "compensation_audit_json"),
        ("job_detail_projections", "score_breakdown_json"),
        ("job_detail_projections", "score_keywords_json"),
        ("job_detail_projections", "score_criteria_json"),
        ("job_detail_projections", "score_trace_json"),
        ("job_detail_projections", "score_correction_json"),
        ("job_detail_projections", "stages_json"),
        ("job_detail_projections", "employer_analysis_json"),
        ("job_detail_projections", "requirement_fit_report_json"),
        ("job_detail_projections", "interview_prep_json"),
        ("job_duplicate_links", "superseded_job_or_observation_id"),
        ("job_events", "payload_json"),
        ("job_events", "entity_ref"),
        ("job_list_projections", "compensation_summary_json"),
        ("job_list_projections", "score_breakdown_json"),
        ("job_list_projections", "score_keywords_json"),
        ("job_list_projections", "score_criteria_json"),
        ("job_list_projections", "score_trace_json"),
        ("job_list_projections", "score_correction_json"),
        ("outreach_thread_projections", "drafts_json"),
        ("pipeline_step_projections", "item_key"),
        ("preparation_work_items", "idempotency_key"),
        ("workflow_run_projections", "input_summary_json"),
        ("workflow_run_projections", "events_json"),
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
        ("job_score_keywords", "job_id"),
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
        ("jobctrl_deleted_jobs", "tenant_id"),
        ("jobctrl_hidden_jobs", "tenant_id"),
        ("jobs", "tenant_id"),
    }
)


def _column_manifest(
    rows: Mapping[str, str],
) -> Mapping[str, frozenset[str]]:
    """Freeze an exact column inventory without permitting name-based roles."""
    return MappingProxyType(
        {table: frozenset(columns.split()) for table, columns in rows.items()}
    )


# The preflight admits only these immutable v6 table shapes and the exact-v7
# schema constructor creates only the matching target shapes.  Keeping this
# inventory here means a newly admitted column cannot silently acquire the
# generic ``PRESERVE`` role: it must be declared with its semantic role first.
_DECLARED_COLUMNS: Final[Mapping[str, frozenset[str]]] = _column_manifest(
    {
        "application_email_evidence": "tenant_id evidence_id job_key job_id provider provider_message_id provider_thread_id from_address to_addresses_json subject snippet received_at linked_at link_confidence link_signals_json body_text body_sha256 body_stored_at",
        "application_outcome_suggestions": "tenant_id suggestion_id job_key job_id evidence_id suggested_kind confidence rationale status created_at decided_at decision decision_reason decided_outcome_id",
        "application_outcomes": "tenant_id outcome_id job_key job_id kind source note occurred_at recorded_at suggestion_id evidence_id created_by interview_prep_generation",
        "application_repeat_audit": "tenant_id audit_id audit_key target_job_key target_job_id action evidence_fingerprint evidence_json override_id actor reason occurred_at",
        "application_repeat_override_consumptions": "tenant_id override_id run_id consumed_at",
        "application_repeat_overrides": "tenant_id override_id target_job_key target_job_id prior_job_key prior_job_id relationship evidence_fingerprint evidence_json reason confirmed_by confirmed_at",
        "application_review_decisions": "tenant_id decision_id job_key job_id decision reason decided_by decided_at materials_generation profile_version application_url partial_override_run_id email_recipient email_attachment_artifact_id",
        "apply_run_projections": "run_id tenant_id job_id job_title job_employer status result dry_run worker_id model started_at finished_at duration_ms events_json",
        "artifact_list_projections": "artifact_id tenant_id job_id job_title job_employer artifact_type status local_path size_bytes created_at generation metadata_json layout_boxes_json bullet_provenance_json coverage_audit_json voice_pass_json",
        "candidate_profile_achievement_evidence": "tenant_id profile_id entry_id evidence_index evidence_id source_text scope action tools_json metrics_json outcome seniority_signal evidence_strength claim_confidence user_confirmed tags_json",
        "candidate_profile_education_entries": "tenant_id profile_id entry_id position_index date degree institution location",
        "candidate_profile_experience_bullets": "tenant_id profile_id entry_id bullet_index bullet_text",
        "candidate_profile_experience_entries": "tenant_id profile_id entry_id position_index date_range title company location",
        "candidate_profile_required_bullets": "tenant_id profile_id entry_id bullet_index bullet_text",
        "candidate_profile_required_education_entries": "tenant_id profile_id position_index entry_id",
        "candidate_profile_required_experience_entries": "tenant_id profile_id position_index entry_id",
        "candidate_profile_required_skill_categories": "tenant_id profile_id position_index category_id",
        "candidate_profile_required_skills": "tenant_id profile_id category_id skill_index skill_text",
        "candidate_profile_resume_constraint_metrics": "tenant_id profile_id metric_index metric_text",
        "candidate_profile_skill_categories": "tenant_id profile_id category_id position_index label",
        "candidate_profile_skill_items": "tenant_id profile_id category_id item_index item_text",
        "candidate_profiles": "tenant_id profile_id personal_full_name personal_preferred_name personal_email personal_phone personal_address personal_city personal_province_state personal_country personal_postal_code personal_linkedin_url personal_github_url personal_portfolio_url personal_website_url personal_password work_legally_authorized_to_work work_require_sponsorship work_work_permit_type compensation_salary_expectation compensation_salary_currency compensation_salary_range_min compensation_salary_range_max compensation_currency_note experience_years_total experience_education_level experience_current_job_title experience_current_company experience_target_role experience_target_track experience_target_seniority_floor experience_target_functions experience_target_specializations experience_target_locations experience_target_work_models availability_earliest_start_date availability_full_time availability_contract eeo_gender eeo_race_ethnicity eeo_veteran_status eeo_disability_status application_attestation_age_18_plus application_attestation_background_check_consent application_attestation_felony_conviction application_attestation_previously_worked_at_employer application_attestation_additional_json application_preference_how_heard resume_baseline_text tailoring_mode tailoring_allow_title_reframing tailoring_allow_achievement_rewriting tailoring_allow_skill_reordering tailoring_allow_summary_rewrite tailoring_allow_minor_inference tailoring_claim_mode tailoring_auto_approvable_claim_modes_json tailoring_allow_adjacent_achievement_drafts writing_tone writing_bullet_style writing_verbosity writing_keyword_density writing_avoid_first_person max_experience_bullets custom_tailoring_prompt revision_min_fit_score revision_must_have_coverage revision_max_attempts resume_style_document_font_size resume_style_paper_size resume_style_font_family resume_style_moderncv_style resume_style_moderncv_color resume_style_page_scale resume_style_hints_column_width_cm resume_style_body_alignment resume_template_text version updated_at",
        "contact_attributes": "tenant_id attribute_id contact_id attribute_kind value_json source_kind source_ref capture_method confidence user_confirmed recorded_at",
        "contact_candidates": "tenant_id candidate_id task_id role attributes_json source_kind source_ref capture_method confidence status proposed_at confirmed_contact_id confirmed_at",
        "contact_projections": "tenant_id contact_id employer job_id role attribute_count confirmed_count source_kinds_json provenance_json created_at updated_at last_updated_at",
        "contact_research_task_projections": "tenant_id task_id employer job_id status candidate_count needs_review_count confirmed_count source_attempts_json candidates_json started_at updated_at needs_review_at completed_at failed_at error_class last_updated_at",
        "contact_research_tasks": "tenant_id task_id employer job_url job_id status source_attempts_json started_at updated_at needs_review_at completed_at failed_at error_class",
        "contacts": "tenant_id contact_id employer job_url job_id role created_at updated_at deleted_at",
        "dashboard_projections": "tenant_id total_jobs failures blocked ready applied dry_runs funnel_json by_source_json score_distribution_json outcome_conversion_json generated_at",
        "digest_state": "tenant_id last_acknowledged_at updated_at",
        "discovery_execution_jobs": "tenant_id discover_workflow_id discover_run_id job_url job_id cohort_kind source_family source_run_id preparation_workflow_id work_plan_state required_steps_json work_plan_reason linked_at",
        "discovery_execution_recoveries": "tenant_id discover_workflow_id discover_run_id state mode decoder_version history_event_id expected_membership_count persisted_membership_count expected_step_count persisted_step_count key_digest last_error_code updated_at",
        "discovery_feedback": "tenant_id feedback_id job_key job_id source_id kind note recorded_at",
        "discovery_quarantine_entries": "tenant_id job_id job_key title company source_id posting_url reason confidence snapshot_version captured_at notice_text status decision_reason decided_at",
        "discovery_run_projections": "run_id tenant_id source_ids_json profile_snapshot_id status counts_json error_classes_json started_at completed_at failed_at failed_source_id retryable",
        "discovery_runs": "tenant_id run_id source_ids_json profile_snapshot_id status counts_json progress_json error_classes_json started_at updated_at completed_at failed_at workflow_id",
        "discovery_search_unit_filtered_events": "tenant_id discover_workflow_id discover_run_id unit_id provider_event_key_hash filtered_at",
        "discovery_search_unit_jobs": "tenant_id discover_workflow_id discover_run_id unit_id job_url job_id was_new accepted_at",
        "discovery_search_units": "tenant_id discover_workflow_id discover_run_id unit_id ordinal request_json request_fingerprint state lease_owner lease_attempt lease_epoch recovery_count checkpoint_json checkpoint_revision last_error_code last_error_type last_error_retryable reset_checkpoint reset_checkpoint_after_revision created_at updated_at completed_at",
        "discovery_settings": "tenant_id search_config_json created_at updated_at",
        "due_follow_up_projections": "tenant_id thread_id contact_id job_id due_at basis state created_at updated_at last_updated_at",
        "event_watermarks": "projection_name last_event_id updated_at",
        "evidence_usage_projections": "tenant_id projection_kind projection_id evidence_id skill_id requirement_id title payload_json last_updated_at",
        "job_artifacts": "artifact_id job_url tenant_id job_id stage artifact_type status path created_at size_bytes metadata_json",
        "job_bullet_provenance": "job_url tenant_id job_id generation bullet_id artifact_id section source_id evidence_ids_json requirement_ids_json matched_keywords_json transform_type control rationale generated_text position created_at coverage_json voice_json",
        "job_canonical_identities": "tenant_id job_url job_id canonical_url ats_kind source_native_id confidence resolved_at",
        "job_detail_projections": "tenant_id job_id description_preview compensation_summary_json compensation_audit_json score_breakdown_json score_keywords_json score_reasoning score_version scored_at score_criteria_json score_trace_json score_correction_json stages_json employer_analysis_json requirement_fit_report_json interview_prep_json last_updated_at",
        "job_duplicate_links": "tenant_id duplicate_link_id surviving_job_id superseded_job_or_observation_id reason confidence linked_at",
        "job_employer_analysis": "job_url tenant_id job_id generation snapshot_hash prompt_version sdk_set_version cache_key role_framing inferred_seniority ideal_candidate_narrative requirements_json keywords_json agreement_json eeo_screen_json legs_attempted legs_succeeded created_at",
        "job_employer_analysis_failures": "job_url tenant_id job_id generation model_id error raw_output",
        "job_employer_analysis_sub_analyses": "job_url tenant_id job_id generation model_id analysis_json",
        "job_enrichments": "job_url tenant_id job_id current_status full_description application_url enriched_at extraction_tier attempts_json updated_at",
        "job_events": "event_id job_url tenant_id job_id identity_version stage event_type level message occurred_at payload_json entity_kind entity_ref idempotency_key",
        "job_interview_prep": "job_url tenant_id job_id generation status model generated_at gate_status fabrication_findings_json grounding_findings_json judge_verdict warnings_json failure_reason origin_run_id",
        "job_interview_prep_items": "job_url tenant_id job_id generation item_id kind title generated_text evidence_ids_json requirement_ids_json source_text_json transform_type control grounding_audit_json warnings_json position",
        "job_list_projections": "tenant_id job_id title employer source strategy location salary application_url discovered_at description full_description fit_score fit_band compensation_summary_json score_breakdown_json score_keywords_json score_reasoning score_version scored_at score_criteria_json score_trace_json score_correction_json current_stage current_substage current_state current_error_code current_error_message current_next_action has_resume has_cover_letter has_pdf apply_status applied_at apply_mode resume_template_id resume_template_name tailoring_policy_version artifact_count deleted_at last_updated_at",
        "job_locators": "tenant_id job_id locator_kind locator_value is_current first_seen_at last_seen_at retired_at",
        "job_market_compensation_estimates": "tenant_id job_url job_id estimate_state currency period component minimum_amount maximum_amount confidence_interval_minimum_amount confidence_interval_maximum_amount confidence_band confidence_score source_count sample_count aggregate_bucket geography_scope occupation_code occupation_label seniority_label source_snapshot_json factor_reasons_json selected_evidence_json insufficient_reasons_json unsupported_reasons_json source_unavailable_reasons_json warnings_json estimator_version estimated_at company_name normalized_company role_title normalized_role company_tier match_scope",
        "job_material_layout_boxes": "job_url tenant_id job_id generation artifact_id box_index semantic_id page_number line_number text_excerpt left_pct top_pct width_pct height_pct audit_target_json created_at",
        "job_materials": "job_url tenant_id job_id generation status created_at updated_at last_validation_json last_verdict_json metadata_json",
        "job_materials_artifacts": "job_url tenant_id job_id generation artifact_type artifact_id status path render_format size_bytes metadata_json created_at superseded_at",
        "job_posted_compensation_facts": "tenant_id job_url job_id source_field source_text legacy_raw_salary parse_state currency period component minimum_amount maximum_amount annualized_minimum_amount annualized_maximum_amount annualization_assumption confidence warnings_json parser_version source_hash parsed_at",
        "job_rejected_duplicate_links": "tenant_id owner_job_url owner_job_id candidate_url reason rejected_at",
        "job_requirement_fit_items": "job_url tenant_id job_id score_version requirement_id requirement_text tier weight job_evidence_span fit_json contribution_json tailoring_json artifact_coverage_json position",
        "job_requirement_fit_reports": "job_url tenant_id job_id score_version employer_analysis_generation profile_snapshot_version scoring_policy_version formula_version resolved_fit_score fit_band confidence summary_json created_at",
        "job_resume_template_assignments": "tenant_id job_url job_id template_id version_id updated_at",
        "job_score_keywords": "tenant_id job_id score_version normalized_keyword display_keyword position",
        "job_score_staleness": "tenant_id job_url job_id stale_reason old_policy_id old_policy_version new_policy_id new_policy_version marked_at resolved resolved_at resolved_by_score_version",
        "job_scores": "job_url tenant_id job_id version fit_score breakdown_json keywords_json scored_at correction_json criteria_json trace_json",
        "job_source_observations": "tenant_id source_observation_id job_url job_id source_id source_native_id observed_url normalized_observed_url run_id observed_at",
        "job_stage_states": "job_url tenant_id job_id stage state attempt_count max_attempts started_at updated_at finished_at duration_ms error_code error_message retryable blocked_by_json next_action metadata_json version",
        "jobctrl_deleted_jobs": "job_url tenant_id job_id deleted_at reason restored_at",
        "jobctrl_hidden_jobs": "job_url tenant_id job_id hidden_at reason unhidden_at",
        "jobs": "url title company salary description location site strategy discovered_at full_description application_url detail_scraped_at detail_error fit_score score_reasoning scored_at tailored_resume_path tailored_at tailor_attempts cover_letter_path cover_letter_at cover_attempts applied_at apply_status apply_error apply_attempts agent_id last_attempted_at apply_duration_ms apply_task_id verification_confidence tenant_id job_id",
        "llm_spend": "day input_tokens output_tokens estimated_usd",
        "manual_capture_queue": "tenant_id item_id originating_url source_id reason retry_context_json required_at status imported_at dismissed_at capture_mode captured_url content_sha256 content_length note future_manual_action_required job_key job_id",
        "operational_attempt_metrics": "metric_id tenant_id occurred_at stage source_id source_kind source_priority source_role adapter attempt_kind outcome failure_category is_operational_failure is_scrape_failure is_retryable run_id job_url job_id duration_ms total_count new_count existing_count observed_count duplicate_count error_class error_message metadata_json",
        "outreach_drafts": "tenant_id draft_id thread_id generation kind status body_text gate_results_json provenance_json created_at approved_at rejected_at reason",
        "outreach_send_logs": "tenant_id send_log_id thread_id draft_id channel sent_at logged_at",
        "outreach_thread_projections": "tenant_id thread_id contact_id job_id draft_count latest_generation has_approved_draft approved_draft_id latest_status drafts_json created_at updated_at last_updated_at",
        "outreach_threads": "tenant_id thread_id contact_id job_url job_id created_at updated_at follow_up_due_at follow_up_basis follow_up_state",
        "pipeline_step_projections": "tenant_id discover_workflow_id discover_run_id step_kind item_key state attempt queued_at started_at finished_at duration_ms error_code retryable detail_code detail_count last_event_id last_updated_at",
        "posting_snapshot_sets": "tenant_id job_url job_id snapshot_set_json latest_snapshot_version latest_active_state latest_confidence latest_quarantine_reason updated_at",
        "preparation_work_items": "item_id tenant_id job_id kind target_version source_event_id state idempotency_key attempts last_error created_at updated_at available_at",
        "projection_backfills": "name completed_at",
        "resume_review_comment_replies": "tenant_id reply_id thread_id draft_revision_id author decision body created_at",
        "resume_review_comment_threads": "tenant_id thread_id draft_id job_key job_id base_artifact_id semantic_id line_anchor_json source_pin_id risk_label comment_body lifecycle_state anchor_resolved created_at updated_at",
        "resume_review_draft_revisions": "tenant_id revision_id draft_id job_key job_id revision_number plate_document_json edited_text created_at",
        "resume_review_drafts": "tenant_id draft_id job_key job_id base_generation base_resume_text_artifact_id base_resume_pdf_artifact_id renderer_format state current_revision_id latest_revision_number created_at updated_at",
        "resume_review_edit_deltas": "tenant_id delta_id revision_id draft_id job_key job_id kind section semantic_id line_anchor_json before_text after_text created_at",
        "resume_template_defaults": "tenant_id profile_id template_id version_id updated_at",
        "resume_template_refresh_attempts": "tenant_id attempt_id job_url job_id status from_generation to_generation template_id template_version_id template_hash error_message metadata_json created_at completed_at",
        "resume_template_versions": "tenant_id version_id template_id version_number display_name status theme_json layout_json content_hash created_at",
        "resume_templates": "tenant_id template_id display_name status built_in created_at updated_at",
        "role_match_feedback_suggestions": "tenant_id suggestion_id status rule_kind title_pattern title_display reason_code reason sample_count source_ids_json evidence_json created_at updated_at decided_at decision_reason",
        "scoring_policies": "tenant_id version rubric_json anchors_json created_at created_from_event_id",
        "source_locator_candidates": "tenant_id candidate_id candidate_url source_kind confidence detected_ats_kind employer_domain_matched manual_action_reason discovered_at",
        "source_quality_stats": "tenant_id source_id window_start window_end run_count failed_run_count consecutive_failures observed_jobs new_jobs existing_jobs duplicate_jobs active_jobs stale_jobs detail_success_count detail_failure_count active_verification_rate duplicate_rate full_description_success_rate apply_url_success_rate last_run_id last_error_class recommended_state updated_at",
        "source_registry_entries": "tenant_id source_id kind display_name owner priority state policy_id seed_url created_at updated_at",
        "tailoring_feedback_signals": "tenant_id signal_id job_key job_id draft_id draft_revision_id source_kind source_id signal_kind status summary section semantic_id created_at reviewed_at",
        "tailoring_policies": "tenant_id version prompt_version schema_version judge_schema_version prompt_fingerprint config_fingerprint profile_policy_fingerprint custom_prompt_fingerprint generator_settings_json judge_settings_json runtime_settings_json rollback_of_version rollback_reason created_at created_from_event_id",
        "worker_runtime_heartbeats": "worker_id component pid hostname app_dir db_path task_queue started_at last_seen_at max_concurrent_activities activity_executor_max_workers active_activity_count active_activity_counts_json active_activity_details_json active_activity_details_total active_activity_details_truncated activity_duration_summary_json task_queue_observation_json heartbeat_schema_version",
        "workflow_run_projections": "workflow_id tenant_id workflow_type status input_summary_json error_code error_message retryable started_at finished_at duration_ms temporal_run_id events_json",
    }
)

_SOURCE_ONLY_COLUMNS: Final[Mapping[str, frozenset[str]]] = _column_manifest(
    {
        "application_email_evidence": "job_key",
        "application_outcome_suggestions": "job_key",
        "application_outcomes": "job_key",
        "application_repeat_audit": "target_job_key",
        "application_repeat_overrides": "target_job_key prior_job_key",
        "application_review_decisions": "job_key",
        "contact_research_tasks": "job_url",
        "contacts": "job_url",
        "discovery_execution_jobs": "job_url",
        "discovery_feedback": "job_key",
        "discovery_quarantine_entries": "job_key",
        "discovery_run_projections": "run_id tenant_id source_ids_json profile_snapshot_id status counts_json error_classes_json started_at completed_at failed_at failed_source_id retryable",
        "discovery_search_unit_jobs": "job_url",
        "job_artifacts": "job_url",
        "job_bullet_provenance": "job_url",
        "job_canonical_identities": "job_url",
        "job_employer_analysis": "job_url",
        "job_employer_analysis_failures": "job_url",
        "job_employer_analysis_sub_analyses": "job_url",
        "job_enrichments": "job_url",
        "job_events": "job_url",
        "job_interview_prep": "job_url",
        "job_interview_prep_items": "job_url",
        "job_market_compensation_estimates": "job_url",
        "job_material_layout_boxes": "job_url",
        "job_materials": "job_url",
        "job_materials_artifacts": "job_url",
        "job_posted_compensation_facts": "job_url",
        "job_rejected_duplicate_links": "owner_job_url",
        "job_requirement_fit_items": "job_url",
        "job_requirement_fit_reports": "job_url",
        "job_resume_template_assignments": "job_url",
        "job_score_staleness": "job_url",
        "job_scores": "job_url",
        "job_source_observations": "job_url",
        "job_stage_states": "job_url",
        "jobctrl_deleted_jobs": "job_url",
        "jobctrl_hidden_jobs": "job_url",
        "manual_capture_queue": "job_key",
        "operational_attempt_metrics": "job_url",
        "outreach_threads": "job_url",
        "posting_snapshot_sets": "job_url",
        "resume_review_comment_threads": "job_key",
        "resume_review_draft_revisions": "job_key",
        "resume_review_drafts": "job_key",
        "resume_review_edit_deltas": "job_key",
        "resume_template_refresh_attempts": "job_url",
        "tailoring_feedback_signals": "job_key",
    }
)

_TARGET_ONLY_COLUMNS: Final[Mapping[str, frozenset[str]]] = _column_manifest(
    {
        "application_email_evidence": "job_id",
        "application_outcome_suggestions": "job_id",
        "application_outcomes": "job_id",
        "application_repeat_audit": "target_job_id",
        "application_repeat_overrides": "target_job_id prior_job_id",
        "application_review_decisions": "job_id",
        "contact_research_tasks": "job_id",
        "contacts": "job_id",
        "discovery_execution_jobs": "job_id",
        "discovery_feedback": "job_id",
        "discovery_search_unit_jobs": "job_id",
        "job_artifacts": "tenant_id job_id",
        "job_bullet_provenance": "job_id",
        "job_canonical_identities": "job_id",
        "job_employer_analysis": "job_id",
        "job_employer_analysis_failures": "job_id",
        "job_employer_analysis_sub_analyses": "job_id",
        "job_enrichments": "job_id",
        "job_events": "tenant_id job_id identity_version",
        "job_interview_prep": "job_id",
        "job_interview_prep_items": "job_id",
        "job_locators": "tenant_id job_id locator_kind locator_value is_current first_seen_at last_seen_at retired_at",
        "job_market_compensation_estimates": "job_id",
        "job_material_layout_boxes": "job_id",
        "job_materials": "job_id",
        "job_materials_artifacts": "tenant_id job_id",
        "job_posted_compensation_facts": "job_id",
        "job_rejected_duplicate_links": "owner_job_id",
        "job_requirement_fit_items": "job_id",
        "job_requirement_fit_reports": "job_id",
        "job_resume_template_assignments": "job_id",
        "job_score_keywords": "job_id",
        "job_score_staleness": "job_id",
        "job_scores": "job_id",
        "job_source_observations": "job_id",
        "job_stage_states": "tenant_id job_id",
        "jobctrl_deleted_jobs": "tenant_id job_id",
        "jobctrl_hidden_jobs": "tenant_id job_id",
        "jobs": "tenant_id job_id",
        "manual_capture_queue": "job_id",
        "operational_attempt_metrics": "job_id",
        "outreach_threads": "job_id",
        "posting_snapshot_sets": "job_id",
        "resume_review_comment_threads": "job_id",
        "resume_review_draft_revisions": "job_id",
        "resume_review_drafts": "job_id",
        "resume_review_edit_deltas": "job_id",
        "resume_template_refresh_attempts": "job_id",
        "tailoring_feedback_signals": "job_id",
    }
)


def table_plan(table: str) -> TablePlan | None:
    """Return the declared plan, or ``None`` for an unadmitted table."""
    return TABLE_PLANS.get(table)


def _is_declared_column(table: str, column: str, side: SchemaSide) -> bool:
    columns = _DECLARED_COLUMNS.get(table)
    if columns is None or column not in columns:
        return False
    if side == "source":
        return column not in _TARGET_ONLY_COLUMNS.get(table, frozenset())
    return column not in _SOURCE_ONLY_COLUMNS.get(table, frozenset())


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
    if not _is_declared_column(table, column, side):
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
