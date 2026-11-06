"""Learning-owned persistence; Profile, Jobs and Fit retain their own data."""

SCHEMA = """
CREATE TABLE learning_cohorts (
  cohort_id TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY (cohort_id, revision)
);
CREATE TABLE learning_milestones (
  milestone_id TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY (milestone_id, revision)
);
CREATE TABLE learning_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cohort_id TEXT NOT NULL,
  failure_code TEXT, occurred_at TEXT NOT NULL
);
"""

# Separate manifest keeps already-created target workspaces compatible while
# adding the durable HTTP request receipt store.
REQUEST_SCHEMA = """
CREATE TABLE learning_requests (
  operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, action TEXT NOT NULL,
  state TEXT NOT NULL, cohort_id TEXT, snapshot_json TEXT, selection_json TEXT,
  model_fingerprint TEXT, model_receipt_id TEXT UNIQUE, result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"""
