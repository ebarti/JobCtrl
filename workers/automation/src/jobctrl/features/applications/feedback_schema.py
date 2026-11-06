"""Private mail evidence and reviewed outcomes, owned only by Applications."""

SCHEMA = """
CREATE TABLE application_feedback_evidence (
 tenant_id TEXT NOT NULL, evidence_id TEXT NOT NULL, job_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider='gmail'), provider_message_id TEXT NOT NULL,
 provider_thread_id TEXT, headers_json TEXT NOT NULL, message_text TEXT NOT NULL,
 received_at TEXT NOT NULL, linked_at TEXT NOT NULL, body_sha256 TEXT NOT NULL,
 link_confidence REAL NOT NULL, link_receipt_id TEXT NOT NULL,
 link_provenance_json TEXT NOT NULL, link_value_json TEXT NOT NULL,
 link_sources_json TEXT NOT NULL, posting_revision INTEGER NOT NULL,
 posting_hash TEXT NOT NULL, anchor_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,evidence_id), UNIQUE(tenant_id,provider,provider_message_id)
);
CREATE INDEX application_feedback_evidence_job ON application_feedback_evidence(tenant_id,job_id,received_at);
CREATE TABLE application_feedback_suggestions (
 tenant_id TEXT NOT NULL, suggestion_id TEXT NOT NULL, job_id TEXT NOT NULL,
 evidence_id TEXT NOT NULL, suggested_kind TEXT NOT NULL,
 confidence REAL NOT NULL, rationale TEXT NOT NULL,
 outcome_receipt_id TEXT NOT NULL, outcome_provenance_json TEXT NOT NULL,
 outcome_value_json TEXT NOT NULL, outcome_sources_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','corrected','ignored')),
 version INTEGER NOT NULL, created_at TEXT NOT NULL, decided_at TEXT,
 decision TEXT, decision_reason TEXT, decided_outcome_id TEXT,
 decision_request_json TEXT, decision_hash TEXT, decision_fact_hash TEXT,
 PRIMARY KEY(tenant_id,suggestion_id), UNIQUE(tenant_id,evidence_id),
 FOREIGN KEY(tenant_id,evidence_id) REFERENCES application_feedback_evidence(tenant_id,evidence_id)
);
CREATE INDEX application_feedback_suggestions_job ON application_feedback_suggestions(tenant_id,job_id,created_at);
CREATE TABLE application_feedback_outcomes (
 tenant_id TEXT NOT NULL, outcome_id TEXT NOT NULL, job_id TEXT NOT NULL,
 kind TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('manual','email_suggestion')),
 note TEXT, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
 suggestion_id TEXT, evidence_id TEXT, interview_prep_generation INTEGER,
 created_by TEXT NOT NULL, owned_intent_id TEXT,
 PRIMARY KEY(tenant_id,outcome_id), UNIQUE(tenant_id,suggestion_id), UNIQUE(tenant_id,owned_intent_id)
);
CREATE INDEX application_feedback_outcomes_job ON application_feedback_outcomes(tenant_id,job_id,occurred_at);
CREATE TABLE application_feedback_receipts (
 tenant_id TEXT NOT NULL, operation TEXT NOT NULL, job_id TEXT NOT NULL,
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 outcome_id TEXT NOT NULL, fact_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,operation,job_id,request_id),
 FOREIGN KEY(tenant_id,outcome_id) REFERENCES application_feedback_outcomes(tenant_id,outcome_id)
);
"""
