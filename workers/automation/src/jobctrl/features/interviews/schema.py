"""Interview-owned versioned artifacts and determination bindings."""

SCHEMA = """
CREATE TABLE interview_preparations (
  job_id TEXT NOT NULL, generation INTEGER NOT NULL, origin_run_id TEXT,
  value_json TEXT NOT NULL, receipts_json TEXT NOT NULL,
  PRIMARY KEY(job_id, generation), UNIQUE(origin_run_id)
);
CREATE TABLE interview_notes (
  job_id TEXT NOT NULL, question_id TEXT NOT NULL, revision INTEGER NOT NULL,
  value_json TEXT NOT NULL, PRIMARY KEY(job_id, question_id, revision)
);
CREATE TABLE interview_determinations (
  determination_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, receipt_id TEXT NOT NULL
);
"""

RUN_SCHEMA = """
CREATE TABLE interview_generation_runs (
  run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  selection_json TEXT NOT NULL
);
"""
