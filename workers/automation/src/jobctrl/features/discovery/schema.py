"""Discovery owns search configuration, provider cursors and admission receipts."""

SCHEMA = """
CREATE TABLE discovery_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE discovery_target_plans (plan_id TEXT PRIMARY KEY,profile_revision INTEGER NOT NULL,profile_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE discovery_sources (source_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE discovery_candidates (candidate_id TEXT PRIMARY KEY,coordinate TEXT NOT NULL UNIQUE,decision TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE discovery_candidate_evidence (evidence_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES discovery_candidates(candidate_id),data_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE discovery_captures (item_id TEXT PRIMARY KEY,lifecycle_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE discovery_feedback (feedback_id TEXT PRIMARY KEY,job_id TEXT,kind TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE discovery_feedback_proposals (suggestion_id TEXT PRIMARY KEY,state TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT);
CREATE TABLE discovery_operations (operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,input_fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE discovery_runs (run_id TEXT PRIMARY KEY,status TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,owner_token TEXT,epoch INTEGER NOT NULL DEFAULT 0,lease_until REAL NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,new_jobs INTEGER NOT NULL DEFAULT 0,observed_jobs INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result_json TEXT,failure_code TEXT);
CREATE TABLE discovery_units (run_id TEXT NOT NULL REFERENCES discovery_runs(run_id),unit_id TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL,result_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,unit_id));
CREATE TABLE discovery_intake_receipts (receipt_key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES discovery_runs(run_id),unit_id TEXT NOT NULL,job_id TEXT,outcome TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX discovery_receipt_run ON discovery_intake_receipts(run_id,unit_id);
CREATE TABLE discovery_source_runs (run_id TEXT NOT NULL,source_id TEXT NOT NULL,status TEXT NOT NULL,new_jobs INTEGER NOT NULL,observed_jobs INTEGER NOT NULL,error_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,source_id));
"""
