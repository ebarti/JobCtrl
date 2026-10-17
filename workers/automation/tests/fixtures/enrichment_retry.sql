-- Shared structural input for CLI, API/RPC, transaction and worker pickup QA.
INSERT INTO jobs (tenant_id, job_id, url, title, discovered_at) VALUES
('local', '00000000-0000-4000-8000-000000001008', 'https://example.test/retry', 'Synthetic retry job', '2026-01-01T00:00:00Z'),
('local', '00000000-0000-4000-8000-000000001009', 'https://example.test/peer', 'Synthetic peer', '2026-01-01T00:00:00Z');
INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description,
 application_url, enriched_at, extraction_tier, attempts_json, updated_at) VALUES
('local', '00000000-0000-4000-8000-000000001008', 'enriched', 'Accepted synthetic description',
 'https://example.test/apply', '2026-01-01T00:01:00Z', 'json_ld',
 '[{"attempt_number":1,"extraction_tier":"json_ld","status":"succeeded","started_at":"2026-01-01T00:00:00Z","finished_at":"2026-01-01T00:01:00Z","error":null}]',
 '2026-01-01T00:01:00Z');
INSERT INTO job_stage_states (tenant_id, job_id, stage, state, attempt_count, max_attempts,
 started_at, finished_at, duration_ms, updated_at, error_code, error_message, retryable,
 blocked_by_json, next_action, metadata_json, version) VALUES
('local', '00000000-0000-4000-8000-000000001008', 'enrich', 'failed', 2, 5,
 '2026-01-01T00:02:00Z', '2026-01-01T00:03:00Z', 60000, '2026-01-01T00:03:00Z',
 'ENRICH_FAILED', 'Synthetic failed refresh', 0, '["discover"]', 'retry',
 '{"workflowId":"old-workflow","temporalRunId":"old-run","activityOwner":"old-owner","leaseEpoch":1}', 7),
('local', '00000000-0000-4000-8000-000000001009', 'score', 'failed', 1, 3,
 NULL, NULL, NULL, '2026-01-01T00:03:00Z', 'SCORE_FAILED', 'Synthetic score failure', 1, '[]', NULL, NULL, 2);
INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at)
VALUES ('local', '00000000-0000-4000-8000-000000001008', 1, 'resume_approved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO job_materials_artifacts (tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format, created_at)
VALUES ('local', '00000000-0000-4000-8000-000000001008', 1, 'tailored_resume', 'synthetic-accepted', 'approved', 'synthetic-accepted.txt', 'text', '2026-01-01T00:00:00Z');
INSERT INTO job_scores (tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at)
VALUES ('local', '00000000-0000-4000-8000-000000001008', 1, 8, '[]', '[]', '2026-01-01T00:00:00Z');
INSERT INTO application_review_decisions (tenant_id, decision_id, job_id, decision, decided_at, materials_generation, profile_version, application_url)
VALUES ('local', 'synthetic-approval', '00000000-0000-4000-8000-000000001008', 'approve_submit', '2026-01-01T00:00:00Z', 1, 1, 'https://example.test/apply');
