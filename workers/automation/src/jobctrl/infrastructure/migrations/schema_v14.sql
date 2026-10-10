-- Saved settings own search; no second semantic approval is required.
DROP INDEX posting_triage_pending;
ALTER TABLE posting_triage RENAME TO posting_triage_v13;
CREATE TABLE posting_triage (
    tenant_id TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    snapshot_fingerprint TEXT NOT NULL,
    target_fingerprint TEXT NOT NULL,
    source_id TEXT NOT NULL,
    listing_json TEXT NOT NULL CHECK (json_valid(listing_json) AND json_type(listing_json) = 'object'),
    posting_json TEXT CHECK (posting_json IS NULL OR (json_valid(posting_json) AND json_type(posting_json) = 'object')),
    consumed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending_triage','literal_excluded','superseded','admit','reject','uncertain')),
    reason_code TEXT,
    failure_code TEXT,
    last_attempt_at TEXT,
    determination_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, listing_id, snapshot_fingerprint, target_fingerprint),
    FOREIGN KEY (tenant_id, determination_id) REFERENCES semantic_determinations(tenant_id, determination_id),
    CHECK ((status IN ('pending_triage','literal_excluded','superseded') AND determination_id IS NULL) OR (status IN ('admit','reject','uncertain') AND determination_id IS NOT NULL))
);
INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,posting_json,consumed_at,status,reason_code,failure_code,last_attempt_at,determination_id,created_at)
SELECT tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,
       json_object('listing',json(listing_json),'target_sources',json('[]'),'profile_version',NULL),
       posting_json,consumed_at,'superseded','search_settings_authority_updated',NULL,last_attempt_at,NULL,created_at
FROM posting_triage_v13;
DROP TABLE posting_triage_v13;
CREATE INDEX posting_triage_pending ON posting_triage(tenant_id, status, created_at);
