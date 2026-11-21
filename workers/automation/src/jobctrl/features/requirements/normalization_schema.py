"""Additive authority extensions; published schema strings stay frozen."""

REFRESH_TRANSPORT_SCHEMA = """
CREATE TABLE requirements_refresh_transport (
    operation_id TEXT PRIMARY KEY,
    prompt_version TEXT NOT NULL
);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS requirements_aliases (
    requirement_id TEXT PRIMARY KEY,
    root_requirement_id TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements_reconciliations (
    operation_id TEXT PRIMARY KEY,
    action_fingerprint TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    captured_catalog_revision INTEGER NOT NULL,
    published_catalog_revision INTEGER NOT NULL,
    decision_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements_reconciliation_certificate (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    catalog_revision INTEGER NOT NULL,
    normalization_version TEXT NOT NULL,
    input_fingerprint TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    authority_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements_normalization_cache (
    input_fingerprint TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    accepted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requirements_normalization_intents (
    operation_id TEXT PRIMARY KEY,
    input_fingerprint TEXT NOT NULL,
    normalization_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""
