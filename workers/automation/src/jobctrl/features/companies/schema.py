"""Company-owned append-only history. Jobs and model receipts stay with their owners."""

SCHEMA = """
CREATE TABLE companies_configurations (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX companies_configurations_latest ON companies_configurations(company_id, revision DESC);
CREATE TABLE companies_links (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, company_id TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX companies_links_latest ON companies_links(job_id, revision DESC);
CREATE TABLE companies_accepted (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX companies_accepted_latest ON companies_accepted(company_id, revision DESC);
CREATE TABLE companies_attempts (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX companies_attempts_latest ON companies_attempts(company_id, revision DESC);
CREATE TABLE companies_determinations (
  fingerprint TEXT PRIMARY KEY, company_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  configuration_id INTEGER NOT NULL, sources_json TEXT NOT NULL, result_json TEXT NOT NULL
);
"""
