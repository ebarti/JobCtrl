"""Fit-owned canonical records; no foreign feature tables are queried."""

SCHEMA = """
CREATE TABLE fit_assessments (
    assessment_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    requirement_revision TEXT NOT NULL,
    fact_semantics_version TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    determination_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('model', 'manual', 'revalidated')),
    sources_json TEXT NOT NULL,
    assessment_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX fit_assessment_lookup ON fit_assessments
    (profile_id, requirement_id, requirement_revision, source_fingerprint);
CREATE TABLE fit_coverage_relations (
    relation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    requirement_revision TEXT NOT NULL,
    assessment_id TEXT NOT NULL REFERENCES fit_assessments(assessment_id),
    achievement_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    variant_revision TEXT NOT NULL,
    determination_id TEXT NOT NULL,
    relation_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX fit_coverage_lookup ON fit_coverage_relations
    (profile_id, requirement_id, requirement_revision, assessment_id, variant_id, variant_revision);
CREATE TABLE fit_wording_requests (
    origin_key TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    requirement_revision TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX fit_wording_request_lookup ON fit_wording_requests
    (profile_id, requirement_id, requirement_revision);
CREATE TABLE fit_score_versions (
    job_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    profile_id TEXT NOT NULL,
    fact_semantics_version TEXT NOT NULL,
    requirements_revision TEXT NOT NULL,
    score_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, revision)
);
CREATE INDEX fit_score_profile ON fit_score_versions(profile_id, job_id, revision);
CREATE TABLE fit_correction_anchors (
    correction_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    score_revision INTEGER NOT NULL,
    original_score INTEGER NOT NULL,
    corrected_score INTEGER NOT NULL,
    anchor_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id, score_revision) REFERENCES fit_score_versions(job_id, revision)
);
CREATE TABLE fit_operation_receipts (
    operation_id TEXT PRIMARY KEY,
    input_fingerprint TEXT NOT NULL,
    job_id TEXT NOT NULL,
    score_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

REFRESH_SCHEMA = """
CREATE TABLE fit_refresh_operations (
    operation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX fit_refresh_active_profile ON fit_refresh_operations(profile_id) WHERE status='running';
CREATE TABLE fit_wording_group_decisions (
    group_key TEXT PRIMARY KEY,
    decision_json TEXT NOT NULL
);
"""
