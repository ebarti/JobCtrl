"""Jobs owns posting identity, immutable observations and capture receipts."""

SCHEMA = """
CREATE TABLE jobs_jobs (
    job_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    hidden_at TEXT,
    deleted_at TEXT,
    state_revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE jobs_postings (
    job_id TEXT NOT NULL REFERENCES jobs_jobs(job_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(job_id,revision)
);
CREATE TABLE jobs_identity_keys (
    identity_key TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs_jobs(job_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
CREATE INDEX jobs_identity_owner ON jobs_identity_keys(job_id);
CREATE TABLE jobs_observations (
    observation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs_jobs(job_id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    source_native_id TEXT NOT NULL,
    observed_url TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    run_id TEXT,
    receipt_key TEXT UNIQUE,
    provenance_json TEXT NOT NULL,
    posting_revision INTEGER NOT NULL,
    receipt_fingerprint TEXT
);
CREATE INDEX jobs_observation_owner ON jobs_observations(job_id,observed_at);
CREATE TABLE jobs_capture_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT,
    url TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    state TEXT NOT NULL,
    failure_code TEXT,
    data_json TEXT NOT NULL
);
CREATE TABLE jobs_quarantine (
    quarantine_id TEXT PRIMARY KEY,
    job_id TEXT,
    expected_revision INTEGER,
    reason TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    data_json TEXT NOT NULL
);
CREATE TABLE jobs_delete_selections (
    selection_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    selection_json TEXT NOT NULL
);
CREATE TABLE jobs_analysis (
    job_id TEXT NOT NULL REFERENCES jobs_jobs(job_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    posting_revision INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(job_id,revision)
);
CREATE TABLE jobs_operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""
