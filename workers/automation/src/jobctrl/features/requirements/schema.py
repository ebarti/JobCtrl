"""Requirement-owned canonical history, index and acceptance state."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS requirements_catalog (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL,
    indexed_revision INTEGER NOT NULL
);
INSERT INTO requirements_catalog VALUES (1, 0, 0) ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS requirements_meanings (
    requirement_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    meaning_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(requirement_id, revision)
);
CREATE TABLE IF NOT EXISTS requirements_heads (
    requirement_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    FOREIGN KEY(requirement_id, revision) REFERENCES requirements_meanings(requirement_id, revision)
);
CREATE TABLE IF NOT EXISTS requirements_retrieval (
    requirement_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    document TEXT NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('pg_catalog.simple'::regconfig, document)) STORED,
    PRIMARY KEY(requirement_id, revision)
);
CREATE INDEX IF NOT EXISTS requirements_retrieval_search ON requirements_retrieval USING GIN(search_vector);
CREATE TABLE IF NOT EXISTS requirements_snapshots (
    job_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    posting_revision INTEGER NOT NULL,
    posting_hash TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL,
    extraction_determination_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(job_id, revision)
);
CREATE TABLE IF NOT EXISTS requirements_accepted (
    job_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    FOREIGN KEY(job_id, revision) REFERENCES requirements_snapshots(job_id, revision)
);
CREATE TABLE IF NOT EXISTS requirements_occurrences (
    occurrence_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    snapshot_revision INTEGER NOT NULL,
    requirement_id TEXT NOT NULL,
    requirement_revision INTEGER NOT NULL,
    occurrence_json TEXT NOT NULL,
    FOREIGN KEY(job_id, snapshot_revision) REFERENCES requirements_snapshots(job_id, revision),
    FOREIGN KEY(requirement_id, requirement_revision) REFERENCES requirements_meanings(requirement_id, revision)
);
CREATE INDEX IF NOT EXISTS requirements_occurrence_meaning
    ON requirements_occurrences(requirement_id, requirement_revision);
CREATE TABLE IF NOT EXISTS requirements_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    posting_revision INTEGER NOT NULL,
    expected_revision INTEGER NOT NULL,
    input_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','accepted','blocked','cancelled')),
    failure_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS requirements_attempt_job
    ON requirements_attempts(job_id, started_at);
CREATE TABLE IF NOT EXISTS requirements_revision_actions (
    action_id TEXT PRIMARY KEY,
    input_fingerprint TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    FOREIGN KEY(requirement_id, revision) REFERENCES requirements_meanings(requirement_id, revision)
);
CREATE TABLE IF NOT EXISTS requirements_model_cache (
    input_fingerprint TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    job_id TEXT NOT NULL,
    posting_revision INTEGER NOT NULL,
    posting_hash TEXT NOT NULL,
    catalog_revision INTEGER,
    result_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    accepted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requirements_model_cache_job ON requirements_model_cache(job_id);
"""

# Separate registration preserves the byte identity of historical feature schemas.
ATTEMPT_REFUSAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS requirements_attempt_refusals (
    attempt_id TEXT NOT NULL REFERENCES requirements_attempts(attempt_id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL,
    details_json TEXT NOT NULL,
    PRIMARY KEY(attempt_id, completed_at)
);
"""
