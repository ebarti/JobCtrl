"""Resumes owns these aggregates; no sibling tables appear here."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS resumes_documents (
    resume_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resumes_documents_job ON resumes_documents(job_id, updated_at);
CREATE TABLE IF NOT EXISTS resumes_templates (
    template_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resumes_template_preferences (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL,
    state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resumes_operation_receipts (
    operation_id TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resumes_artifact_retirements (
    artifact_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    artifact_json TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    claim_name TEXT,
    owner_pid INTEGER,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resumes_retirements_job_status ON resumes_artifact_retirements(job_id,status);
"""
