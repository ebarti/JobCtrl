-- Forward-only upgrade from the originally deployed 0001 schema. Rebuild the
-- aggregate table so every row has an exact, enforceable expiry timestamp.
ALTER TABLE daily_operational_counters RENAME TO daily_operational_counters_v1;

CREATE TABLE daily_operational_counters (
  day_utc TEXT NOT NULL,
  release TEXT NOT NULL,
  consent_contract_version TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('consent_choice', 'initialization_result')),
  consent_choice TEXT NOT NULL CHECK (consent_choice IN ('granted', 'denied')),
  initialization_result TEXT NOT NULL CHECK (initialization_result IN ('not_applicable', 'success', 'failure')),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('not_applicable', 'persistent', 'memory')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TEXT NOT NULL,
  CHECK (metric = 'consent_choice' OR consent_choice = 'granted'),
  PRIMARY KEY (day_utc, release, consent_contract_version, metric, consent_choice, initialization_result, storage_mode)
);

INSERT INTO daily_operational_counters (
  day_utc, release, consent_contract_version, metric, consent_choice,
  initialization_result, storage_mode, count, expires_at
)
SELECT
  day_utc, release, consent_contract_version, metric, consent_choice,
  initialization_result, storage_mode, count,
  strftime('%Y-%m-%dT%H:%M:%fZ', day_utc || 'T00:00:00Z', '+90 days', '-2 hours')
FROM daily_operational_counters_v1
WHERE metric = 'consent_choice' OR consent_choice = 'granted';

DROP TABLE daily_operational_counters_v1;

CREATE INDEX daily_operational_counters_expiry_idx
  ON daily_operational_counters (expires_at);

ALTER TABLE consented_product_events ADD COLUMN timing_metric TEXT;
ALTER TABLE consented_product_events ADD COLUMN metric_bucket TEXT;

CREATE INDEX consented_product_events_session_idx
  ON consented_product_events (session_hash);

-- Active consent is the authoritative fence for every pseudonymous telemetry
-- write. Multiple browser sessions may remain active for one visitor.
CREATE TABLE active_demo_identities (
  visitor_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (visitor_hash, session_hash)
);

CREATE INDEX active_demo_identities_visitor_idx
  ON active_demo_identities (visitor_hash);
CREATE INDEX active_demo_identities_expiry_idx
  ON active_demo_identities (expires_at);

-- Preserve already-consented event pairs during upgrade. Existing eventless
-- session-rate rows cannot be safely mapped to an active visitor/session pair,
-- so discard that short-lived abuse state rather than carrying unfenced state.
INSERT OR IGNORE INTO active_demo_identities (visitor_hash, session_hash, expires_at)
SELECT visitor_hash, session_hash, MAX(expires_at)
FROM consented_product_events
GROUP BY visitor_hash, session_hash;

DELETE FROM telemetry_rate_windows;

-- D1 is the authoritative cross-location aggregate telemetry budget. This
-- table has no visitor/session key and is never available to product reports.
CREATE TABLE telemetry_global_rate_windows (
  window_utc TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TEXT NOT NULL
);

CREATE INDEX telemetry_global_rate_windows_expiry_idx
  ON telemetry_global_rate_windows (expires_at);
