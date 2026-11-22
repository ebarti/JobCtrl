"""Feature-owned accepted compensation artifacts and source preferences."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS compensation_posted (
    job_id TEXT PRIMARY KEY,
    posting_revision INTEGER NOT NULL,
    posting_hash TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compensation_market (
    job_id TEXT PRIMARY KEY,
    posting_revision INTEGER NOT NULL,
    posting_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compensation_policy_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO compensation_policy_revision(singleton,revision) VALUES(1,0);
CREATE TABLE IF NOT EXISTS compensation_source_preferences (
    source_id TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compensation_benchmark_inputs (
    fact_ref TEXT NOT NULL,
    occupation TEXT NOT NULL,
    seniority TEXT NOT NULL,
    component TEXT NOT NULL,
    geography_scope TEXT NOT NULL,
    country TEXT NOT NULL,
    company_reference TEXT,
    fact_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    fresh_until TEXT NOT NULL,
    PRIMARY KEY(fact_ref,fetched_at)
);
CREATE INDEX IF NOT EXISTS compensation_benchmark_inputs_slice ON compensation_benchmark_inputs(occupation,seniority,component,fresh_until);
CREATE TABLE IF NOT EXISTS compensation_rate_snapshots (
    snapshot_ref TEXT NOT NULL,
    source_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    fresh_until TEXT NOT NULL,
    PRIMARY KEY(snapshot_ref,fetched_at)
);
CREATE INDEX IF NOT EXISTS compensation_rate_snapshots_fresh ON compensation_rate_snapshots(fresh_until);
CREATE TABLE IF NOT EXISTS compensation_price_snapshots (
    snapshot_ref TEXT NOT NULL,
    reference_year INTEGER NOT NULL,
    source_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    fresh_until TEXT NOT NULL,
    PRIMARY KEY(snapshot_ref,fetched_at)
);
CREATE INDEX IF NOT EXISTS compensation_price_snapshots_year ON compensation_price_snapshots(reference_year,fresh_until);
CREATE TABLE IF NOT EXISTS compensation_refresh_completions (
    operation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compensation_source_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compensation_source_receipts_job ON compensation_source_receipts(job_id, sequence);
CREATE TABLE IF NOT EXISTS compensation_refresh_status (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    lease_expires_at TEXT,
    failure_code TEXT,
    updated_at TEXT NOT NULL
);
"""
