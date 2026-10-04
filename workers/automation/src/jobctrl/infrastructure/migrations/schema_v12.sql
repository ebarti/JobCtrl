-- Exact v12: generation-bound interview provenance and independent user notes.
ALTER TABLE job_interview_prep ADD COLUMN generation_context_json TEXT
    CHECK (generation_context_json IS NULL OR
        (json_valid(generation_context_json) AND json_type(generation_context_json) = 'object'));
ALTER TABLE job_interview_prep_items ADD COLUMN question_metadata_json TEXT
    CHECK (question_metadata_json IS NULL OR
        (json_valid(question_metadata_json) AND json_type(question_metadata_json) = 'object'));
CREATE TABLE job_interview_notes (
    tenant_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    question_id TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 100),
    revision INTEGER NOT NULL CHECK (revision > 0),
    note_text TEXT NOT NULL CHECK (length(note_text) <= 20000),
    factual_support TEXT NOT NULL DEFAULT 'unverified_user_statement'
        CHECK (factual_support IN ('supported', 'unverified_user_statement', 'needs_clarification', 'hypothetical')),
    edit_status TEXT NOT NULL DEFAULT 'user_edited' CHECK (edit_status = 'user_edited'),
    source_generation INTEGER,
    bindings_json TEXT CHECK (bindings_json IS NULL OR
        (json_valid(bindings_json) AND json_type(bindings_json) = 'object')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, job_id, question_id),
    FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
);
CREATE TABLE job_interview_note_revisions (
    tenant_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    question_id TEXT NOT NULL CHECK (length(question_id) BETWEEN 1 AND 100),
    revision INTEGER NOT NULL CHECK (revision > 0),
    note_text TEXT NOT NULL CHECK (length(note_text) <= 20000),
    factual_support TEXT NOT NULL DEFAULT 'unverified_user_statement'
        CHECK (factual_support IN ('supported', 'unverified_user_statement', 'needs_clarification', 'hypothetical')),
    edit_status TEXT NOT NULL DEFAULT 'user_edited' CHECK (edit_status = 'user_edited'),
    source_generation INTEGER,
    bindings_json TEXT CHECK (bindings_json IS NULL OR
        (json_valid(bindings_json) AND json_type(bindings_json) = 'object')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, job_id, question_id, revision),
    FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
);
