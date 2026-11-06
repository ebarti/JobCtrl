"""Private append-only offer ledger; events contain references only."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS offer_terms (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    revision_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS offer_terms_job ON offer_terms(job_id, sequence);
CREATE TABLE IF NOT EXISTS offer_decisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    decision_id TEXT NOT NULL UNIQUE,
    terms_revision_id TEXT NOT NULL REFERENCES offer_terms(revision_id),
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS offer_decisions_job ON offer_decisions(job_id, sequence);
"""
