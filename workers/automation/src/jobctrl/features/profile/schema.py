"""Profile-owned target schema; unrelated state never enters this feature."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile_documents (
    profile_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK(revision > 0),
    fact_revision INTEGER NOT NULL CHECK(fact_revision > 0),
    wording_revision INTEGER NOT NULL CHECK(wording_revision > 0),
    document_json TEXT NOT NULL,
    style_json TEXT NOT NULL,
    template_text TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_versions (
    profile_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY(profile_id, revision)
);
CREATE TABLE IF NOT EXISTS profile_sources (
    profile_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL,
    content_json TEXT NOT NULL, confirmation TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(profile_id, source_id)
);
CREATE TABLE IF NOT EXISTS profile_source_versions (
    profile_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(profile_id, source_id, revision)
);
CREATE TABLE IF NOT EXISTS profile_achievements (
    profile_id TEXT NOT NULL, achievement_id TEXT NOT NULL, role_id TEXT NOT NULL,
    position INTEGER NOT NULL, baseline_variant_id TEXT NOT NULL, source_refs_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(profile_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS profile_variants (
    profile_id TEXT NOT NULL, variant_id TEXT NOT NULL, revision INTEGER NOT NULL,
    achievement_id TEXT NOT NULL, text TEXT NOT NULL, source_refs_json TEXT NOT NULL,
    status TEXT NOT NULL, approval_id TEXT, origin_key TEXT, provenance_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(profile_id, variant_id)
);
CREATE TABLE IF NOT EXISTS profile_decisions (
    decision_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL, subject_revision INTEGER NOT NULL, decision TEXT NOT NULL,
    exact_content_json TEXT NOT NULL, authority TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_authoring_requests (
    profile_id TEXT NOT NULL, origin_key TEXT NOT NULL, proposal_id TEXT NOT NULL UNIQUE,
    brief_json TEXT NOT NULL, status TEXT NOT NULL, variant_id TEXT, failure_code TEXT,
    PRIMARY KEY(profile_id, origin_key)
);
CREATE TABLE IF NOT EXISTS profile_determinations (
    determination_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
    kind TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_import_drafts (
    attempt_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, base_revision INTEGER,
    source_id TEXT NOT NULL, draft_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_transfer_provenance (
    profile_id TEXT PRIMARY KEY, bundle_json TEXT NOT NULL
);
"""
