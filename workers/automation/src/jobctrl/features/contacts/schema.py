SCHEMA = """
CREATE TABLE contacts_records (
    contact_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    employer TEXT,
    job_id TEXT,
    deleted_at TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
);
CREATE INDEX contacts_records_job ON contacts_records(job_id, deleted_at);
CREATE INDEX contacts_records_employer ON contacts_records(employer, deleted_at);
CREATE TABLE contacts_research (
    task_id TEXT PRIMARY KEY,
    revision BIGINT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE contacts_model_records (
    determination_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

RESEARCH_EXECUTION_SCHEMA = """
CREATE TABLE contacts_research_runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES contacts_research(task_id)
);
CREATE TABLE contacts_research_pages (
    run_id TEXT NOT NULL REFERENCES contacts_research_runs(run_id), source_index INTEGER NOT NULL,
    page_json TEXT NOT NULL, PRIMARY KEY(run_id,source_index)
);
"""
