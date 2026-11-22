SCHEMA = """
CREATE TABLE outreach_records (
    thread_id TEXT PRIMARY KEY,
    target_key TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE outreach_action_receipts (
    request_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE outreach_model_records (
    determination_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE outreach_proposal_receipts (
    request_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    publication_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""
