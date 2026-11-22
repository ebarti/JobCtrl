"""Applications owns every table below; foreign feature identities are references."""

SCHEMA = """
CREATE TABLE applications_state (
 tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, version INTEGER NOT NULL,
 state_json TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,job_id)
);
CREATE TABLE applications_payloads (
 tenant_id TEXT NOT NULL, payload_id TEXT NOT NULL, job_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,payload_id)
);
CREATE TABLE applications_decisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 tenant_id TEXT NOT NULL, decision_id TEXT NOT NULL, job_id TEXT NOT NULL,
 payload_id TEXT, decision TEXT NOT NULL, decision_json TEXT NOT NULL,
 UNIQUE(tenant_id,decision_id)
);
CREATE INDEX applications_decisions_job ON applications_decisions(tenant_id,job_id,sequence DESC);
CREATE TABLE applications_runs (
 tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL,
 payload_id TEXT NOT NULL, approval_id TEXT NOT NULL, status TEXT NOT NULL,
 run_json TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,run_id)
);
CREATE TABLE applications_rehearsals (
 tenant_id TEXT NOT NULL, rehearsal_id TEXT NOT NULL, job_id TEXT NOT NULL,
 payload_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL, rehearsal_json TEXT NOT NULL,
 PRIMARY KEY(tenant_id,rehearsal_id)
);
CREATE TABLE applications_submit_intents (
 tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, job_id TEXT NOT NULL,
 run_id TEXT NOT NULL, payload_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
 approval_id TEXT NOT NULL, attachment_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,intent_id), UNIQUE(tenant_id,job_id), UNIQUE(tenant_id,run_id)
);
CREATE TABLE applications_submit_receipts (
 tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, run_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,intent_id),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES applications_submit_intents(tenant_id,intent_id)
);
CREATE TABLE applications_action_receipts (
 tenant_id TEXT NOT NULL, action_key TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 response_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,action_key)
);
CREATE TABLE applications_screening (
 tenant_id TEXT NOT NULL, question_id TEXT NOT NULL, revision INTEGER NOT NULL,
 job_id TEXT NOT NULL, state_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,question_id,revision)
);
CREATE INDEX applications_screening_job ON applications_screening(tenant_id,job_id,question_id,revision DESC);
CREATE TABLE applications_screening_library (
 tenant_id TEXT NOT NULL, library_id TEXT NOT NULL, entry_json TEXT NOT NULL,
 PRIMARY KEY(tenant_id,library_id)
);
CREATE TABLE applications_determinations (
 tenant_id TEXT NOT NULL, determination_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 operation TEXT NOT NULL, binding_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
 provenance_json TEXT NOT NULL, sources_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,determination_id)
);
CREATE TABLE applications_failures (
 failure_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
 job_id TEXT, question_id TEXT, operation TEXT NOT NULL, failure_code TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE TABLE applications_repeat_checks (
 tenant_id TEXT NOT NULL, check_id TEXT NOT NULL, job_id TEXT NOT NULL,
 evidence_sha256 TEXT NOT NULL, check_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,check_id)
);
CREATE INDEX applications_repeat_checks_job ON applications_repeat_checks(tenant_id,job_id,recorded_at DESC);
CREATE TABLE applications_repeat_overrides (
 tenant_id TEXT NOT NULL, override_id TEXT NOT NULL, job_id TEXT NOT NULL,
 check_id TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, reason TEXT NOT NULL,
 created_at TEXT NOT NULL, used_by_run_id TEXT, used_at TEXT,
 PRIMARY KEY(tenant_id,override_id), UNIQUE(tenant_id,job_id,check_id)
);
"""
