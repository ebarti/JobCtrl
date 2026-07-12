-- Operational aggregates intentionally have no visitor, session, request, or event identifier.
CREATE TABLE IF NOT EXISTS daily_operational_counters (
  day_utc TEXT NOT NULL,
  release TEXT NOT NULL,
  consent_contract_version TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('consent_choice', 'initialization_result')),
  consent_choice TEXT NOT NULL CHECK (consent_choice IN ('granted', 'denied')),
  initialization_result TEXT NOT NULL CHECK (initialization_result IN ('not_applicable', 'success', 'failure')),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('not_applicable', 'persistent', 'memory')),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day_utc, release, consent_contract_version, metric, consent_choice, initialization_result, storage_mode)
);

-- This isolated table is deliberately unavailable to reporting queries. It stores only a
-- SHA-256 retry-operation digest and expiry; it has no foreign keys or identifier columns.
CREATE TABLE IF NOT EXISTS operational_retry_digests (
  operation_digest TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operational_retry_digests_expiry_idx
  ON operational_retry_digests (expires_at);

-- Consented events retain only hashed random first-party cookie values and closed dimensions.
CREATE TABLE IF NOT EXISTS consented_product_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  release TEXT NOT NULL,
  consent_contract_version TEXT NOT NULL,
  event_name TEXT NOT NULL,
  route_name TEXT,
  feature_name TEXT,
  action_name TEXT,
  scenario_name TEXT,
  result_code TEXT,
  error_code TEXT,
  duration_bucket TEXT,
  viewport_bucket TEXT,
  tour_step TEXT,
  referrer_class TEXT
);

CREATE INDEX IF NOT EXISTS consented_product_events_expiry_idx
  ON consented_product_events (expires_at);
CREATE INDEX IF NOT EXISTS consented_product_events_visitor_idx
  ON consented_product_events (visitor_hash);

-- Short-lived, non-reporting telemetry rate state. It contains only a cookie digest and a
-- UTC minute window, is never joined to event data, and is deleted on each retention run.
CREATE TABLE IF NOT EXISTS telemetry_rate_windows (
  session_hash TEXT NOT NULL,
  window_utc TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (session_hash, window_utc)
);

CREATE INDEX IF NOT EXISTS telemetry_rate_windows_expiry_idx
  ON telemetry_rate_windows (expires_at);

CREATE TABLE IF NOT EXISTS operational_rate_windows (
  endpoint TEXT NOT NULL CHECK (endpoint IN ('consent', 'health')),
  window_utc TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, window_utc)
);

CREATE INDEX IF NOT EXISTS operational_rate_windows_expiry_idx
  ON operational_rate_windows (expires_at);
