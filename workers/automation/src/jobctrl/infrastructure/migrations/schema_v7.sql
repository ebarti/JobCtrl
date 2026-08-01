CREATE TABLE "application_email_evidence" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            evidence_id          TEXT NOT NULL,
            job_id   TEXT NOT NULL,
            provider             TEXT NOT NULL DEFAULT 'gmail',
            provider_message_id  TEXT NOT NULL,
            provider_thread_id   TEXT,
            from_address         TEXT,
            to_addresses_json    TEXT NOT NULL DEFAULT '[]',
            subject              TEXT,
            snippet              TEXT,
            received_at          TEXT,
            linked_at            TEXT NOT NULL,
            link_confidence      REAL NOT NULL DEFAULT 0,
            link_signals_json    TEXT NOT NULL DEFAULT '[]',
            body_text            TEXT,
            body_sha256          TEXT,
            body_stored_at       TEXT,
            PRIMARY KEY (tenant_id, evidence_id),
            UNIQUE (tenant_id, provider, provider_message_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "application_outcome_suggestions" (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            suggestion_id      TEXT NOT NULL,
            job_id TEXT NOT NULL,
            evidence_id        TEXT,
            suggested_kind     TEXT NOT NULL,
            confidence         REAL NOT NULL DEFAULT 0,
            rationale          TEXT NOT NULL DEFAULT '',
            status             TEXT NOT NULL DEFAULT 'pending',
            created_at         TEXT NOT NULL,
            decided_at         TEXT,
            decision           TEXT,
            decision_reason    TEXT,
            decided_outcome_id TEXT,
            PRIMARY KEY (tenant_id, suggestion_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "application_outcomes" (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            outcome_id               TEXT NOT NULL,
            job_id       TEXT NOT NULL,
            kind                     TEXT NOT NULL,
            source                   TEXT NOT NULL,
            note                     TEXT,
            occurred_at              TEXT NOT NULL,
            recorded_at              TEXT NOT NULL,
            suggestion_id            TEXT,
            evidence_id              TEXT,
            created_by               TEXT NOT NULL DEFAULT 'user',
            interview_prep_generation INTEGER,
            PRIMARY KEY (tenant_id, outcome_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "application_repeat_audit" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            audit_id             TEXT NOT NULL,
            audit_key            TEXT NOT NULL,
            target_job_id      TEXT NOT NULL,
            action               TEXT NOT NULL,
            evidence_fingerprint TEXT NOT NULL,
            evidence_json        TEXT NOT NULL,
            override_id          TEXT,
            actor                TEXT NOT NULL,
            reason               TEXT,
            occurred_at          TEXT NOT NULL,
            PRIMARY KEY (tenant_id, audit_id),
            UNIQUE (tenant_id, audit_key)
            ,
            FOREIGN KEY (tenant_id, target_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE application_repeat_override_consumptions (
          tenant_id    TEXT NOT NULL DEFAULT 'local',
          override_id  TEXT NOT NULL,
          run_id       TEXT NOT NULL,
          consumed_at  TEXT NOT NULL,
          PRIMARY KEY (tenant_id, override_id),
          UNIQUE (tenant_id, run_id)
        );
CREATE TABLE "application_repeat_overrides" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            override_id          TEXT NOT NULL,
            target_job_id      TEXT NOT NULL,
            prior_job_id       TEXT NOT NULL,
            relationship         TEXT NOT NULL,
            evidence_fingerprint TEXT NOT NULL,
            evidence_json        TEXT NOT NULL,
            reason               TEXT NOT NULL,
            confirmed_by         TEXT NOT NULL,
            confirmed_at         TEXT NOT NULL,
            PRIMARY KEY (tenant_id, override_id)
            ,
            FOREIGN KEY (tenant_id, target_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, prior_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "application_review_decisions" (
            tenant_id                   TEXT NOT NULL DEFAULT 'local',
            decision_id                 TEXT NOT NULL,
            job_id                      TEXT NOT NULL,
            decision                    TEXT NOT NULL,
            reason                      TEXT,
            decided_by                  TEXT DEFAULT 'user',
            decided_at                  TEXT NOT NULL,
            materials_generation        INTEGER,
            profile_version             INTEGER,
            application_url             TEXT,
            partial_override_run_id     TEXT,
            email_recipient             TEXT,
            email_attachment_artifact_id TEXT,
            PRIMARY KEY (tenant_id, decision_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE apply_run_projections (
            run_id                 TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            job_title              TEXT NOT NULL DEFAULT '',
            job_employer           TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT '',
            result                 TEXT,
            dry_run                INTEGER NOT NULL DEFAULT 0,
            worker_id              INTEGER,
            model                  TEXT,
            started_at             TEXT,
            finished_at            TEXT,
            duration_ms            INTEGER,
            events_json            TEXT NOT NULL DEFAULT '[]'
        );
CREATE TABLE artifact_list_projections (
            artifact_id            TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            job_title              TEXT NOT NULL DEFAULT '',
            job_employer           TEXT NOT NULL DEFAULT '',
            artifact_type          TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT '',
            local_path             TEXT NOT NULL DEFAULT '',
            size_bytes             INTEGER,
            created_at             TEXT,
            generation             INTEGER,
            metadata_json          TEXT,
            layout_boxes_json      TEXT,
            bullet_provenance_json TEXT,
            coverage_audit_json    TEXT,
            voice_pass_json        TEXT
        );
CREATE TABLE candidate_profile_achievement_evidence (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            evidence_index  INTEGER NOT NULL,
            evidence_id     TEXT NOT NULL DEFAULT '',
            source_text     TEXT NOT NULL DEFAULT '',
            scope           TEXT NOT NULL DEFAULT '',
            action          TEXT NOT NULL DEFAULT '',
            tools_json      TEXT NOT NULL DEFAULT '[]',
            metrics_json    TEXT NOT NULL DEFAULT '[]',
            outcome         TEXT NOT NULL DEFAULT '',
            seniority_signal TEXT NOT NULL DEFAULT '',
            evidence_strength TEXT NOT NULL DEFAULT 'supported',
            claim_confidence REAL NOT NULL DEFAULT 0,
            user_confirmed  INTEGER NOT NULL DEFAULT 0,
            tags_json       TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (tenant_id, profile_id, entry_id, evidence_index)
        );
CREATE TABLE candidate_profile_education_entries (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            date            TEXT NOT NULL DEFAULT '',
            degree          TEXT NOT NULL DEFAULT '',
            institution     TEXT NOT NULL DEFAULT '',
            location        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, entry_id)
        );
CREATE TABLE candidate_profile_experience_bullets (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            bullet_index    INTEGER NOT NULL,
            bullet_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
        );
CREATE TABLE candidate_profile_experience_entries (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            date_range      TEXT NOT NULL DEFAULT '',
            title           TEXT NOT NULL DEFAULT '',
            company         TEXT NOT NULL DEFAULT '',
            location        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, entry_id)
        );
CREATE TABLE candidate_profile_required_bullets (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            entry_id        TEXT NOT NULL,
            bullet_index    INTEGER NOT NULL,
            bullet_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
        );
CREATE TABLE candidate_profile_required_education_entries (
                tenant_id       TEXT NOT NULL,
                profile_id      TEXT NOT NULL,
                position_index  INTEGER NOT NULL,
                entry_id        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, profile_id, position_index)
            );
CREATE TABLE candidate_profile_required_experience_entries (
                tenant_id       TEXT NOT NULL,
                profile_id      TEXT NOT NULL,
                position_index  INTEGER NOT NULL,
                entry_id        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, profile_id, position_index)
            );
CREATE TABLE candidate_profile_required_skill_categories (
                tenant_id       TEXT NOT NULL,
                profile_id      TEXT NOT NULL,
                position_index  INTEGER NOT NULL,
                category_id        TEXT NOT NULL,
                PRIMARY KEY (tenant_id, profile_id, position_index)
            );
CREATE TABLE candidate_profile_required_skills (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            skill_index     INTEGER NOT NULL,
            skill_text      TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, category_id, skill_index)
        );
CREATE TABLE candidate_profile_resume_constraint_metrics (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            metric_index    INTEGER NOT NULL,
            metric_text     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, metric_index)
        );
CREATE TABLE candidate_profile_skill_categories (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            position_index  INTEGER NOT NULL,
            label           TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, profile_id, category_id)
        );
CREATE TABLE candidate_profile_skill_items (
            tenant_id       TEXT NOT NULL,
            profile_id      TEXT NOT NULL,
            category_id     TEXT NOT NULL,
            item_index      INTEGER NOT NULL,
            item_text       TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id, category_id, item_index)
        );
CREATE TABLE candidate_profiles (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            profile_id                        TEXT NOT NULL DEFAULT 'default',
            personal_full_name                TEXT NOT NULL DEFAULT '',
            personal_preferred_name           TEXT NOT NULL DEFAULT '',
            personal_email                    TEXT NOT NULL DEFAULT '',
            personal_phone                    TEXT NOT NULL DEFAULT '',
            personal_address                  TEXT NOT NULL DEFAULT '',
            personal_city                     TEXT NOT NULL DEFAULT '',
            personal_province_state           TEXT NOT NULL DEFAULT '',
            personal_country                  TEXT NOT NULL DEFAULT '',
            personal_postal_code              TEXT NOT NULL DEFAULT '',
            personal_linkedin_url             TEXT NOT NULL DEFAULT '',
            personal_github_url               TEXT NOT NULL DEFAULT '',
            personal_portfolio_url            TEXT NOT NULL DEFAULT '',
            personal_website_url              TEXT NOT NULL DEFAULT '',
            personal_password                 TEXT NOT NULL DEFAULT '',
            work_legally_authorized_to_work   TEXT NOT NULL DEFAULT '',
            work_require_sponsorship          TEXT NOT NULL DEFAULT '',
            work_work_permit_type             TEXT NOT NULL DEFAULT '',
            compensation_salary_expectation   TEXT NOT NULL DEFAULT '',
            compensation_salary_currency      TEXT NOT NULL DEFAULT 'USD',
            compensation_salary_range_min     TEXT NOT NULL DEFAULT '',
            compensation_salary_range_max     TEXT NOT NULL DEFAULT '',
            compensation_currency_note        TEXT NOT NULL DEFAULT '',
            experience_years_total            TEXT NOT NULL DEFAULT '',
            experience_education_level        TEXT NOT NULL DEFAULT '',
            experience_current_job_title      TEXT NOT NULL DEFAULT '',
            experience_current_company        TEXT NOT NULL DEFAULT '',
            experience_target_role            TEXT NOT NULL DEFAULT '',
            experience_target_track           TEXT NOT NULL DEFAULT '',
            experience_target_seniority_floor TEXT NOT NULL DEFAULT '',
            experience_target_functions       TEXT NOT NULL DEFAULT '',
            experience_target_specializations TEXT NOT NULL DEFAULT '',
            experience_target_locations       TEXT NOT NULL DEFAULT '',
            experience_target_work_models     TEXT NOT NULL DEFAULT '',
            availability_earliest_start_date  TEXT NOT NULL DEFAULT '',
            availability_full_time            TEXT NOT NULL DEFAULT '',
            availability_contract             TEXT NOT NULL DEFAULT '',
            eeo_gender                        TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_race_ethnicity                TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_veteran_status                TEXT NOT NULL DEFAULT 'Decline to self-identify',
            eeo_disability_status             TEXT NOT NULL DEFAULT 'Decline to self-identify',
            application_attestation_age_18_plus INTEGER DEFAULT NULL,
            application_attestation_background_check_consent INTEGER DEFAULT NULL,
            application_attestation_felony_conviction INTEGER DEFAULT NULL,
            application_attestation_previously_worked_at_employer INTEGER DEFAULT NULL,
            application_attestation_additional_json TEXT NOT NULL DEFAULT '{}',
            application_preference_how_heard TEXT NOT NULL DEFAULT '',
            resume_baseline_text              TEXT NOT NULL DEFAULT '',
            tailoring_mode                    TEXT NOT NULL DEFAULT 'balanced',
            tailoring_allow_title_reframing   INTEGER NOT NULL DEFAULT 0,
            tailoring_allow_achievement_rewriting INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_skill_reordering  INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_summary_rewrite   INTEGER NOT NULL DEFAULT 1,
            tailoring_allow_minor_inference   INTEGER NOT NULL DEFAULT 0,
            tailoring_claim_mode              TEXT NOT NULL DEFAULT 'evidence_reframing',
            tailoring_auto_approvable_claim_modes_json TEXT NOT NULL DEFAULT '["verified_only","evidence_reframing"]',
            tailoring_allow_adjacent_achievement_drafts INTEGER NOT NULL DEFAULT 0,
            writing_tone                      TEXT NOT NULL DEFAULT 'direct',
            writing_bullet_style              TEXT NOT NULL DEFAULT 'balanced',
            writing_verbosity                 TEXT NOT NULL DEFAULT 'balanced',
            writing_keyword_density           TEXT NOT NULL DEFAULT 'natural',
            writing_avoid_first_person        INTEGER NOT NULL DEFAULT 1,
            max_experience_bullets            INTEGER NOT NULL DEFAULT 4,
            custom_tailoring_prompt           TEXT NOT NULL DEFAULT '',
            revision_min_fit_score            INTEGER NOT NULL DEFAULT 8,
            revision_must_have_coverage       REAL NOT NULL DEFAULT 0.85,
            revision_max_attempts             INTEGER NOT NULL DEFAULT 1,
            resume_style_document_font_size   TEXT NOT NULL DEFAULT '11pt',
            resume_style_paper_size           TEXT NOT NULL DEFAULT 'a4paper',
            resume_style_font_family          TEXT NOT NULL DEFAULT 'sans',
            resume_style_moderncv_style       TEXT NOT NULL DEFAULT 'banking',
            resume_style_moderncv_color       TEXT NOT NULL DEFAULT 'black',
            resume_style_page_scale           REAL NOT NULL DEFAULT 0.85,
            resume_style_hints_column_width_cm REAL NOT NULL DEFAULT 3.0,
            resume_style_body_alignment       TEXT NOT NULL DEFAULT 'justified',
            resume_template_text              TEXT NOT NULL DEFAULT '',
            version                           INTEGER NOT NULL DEFAULT 1,
            updated_at                        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id)
        );
CREATE TABLE contact_attributes (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attribute_id        TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            attribute_kind      TEXT NOT NULL,
            value_json          TEXT,
            source_kind         TEXT NOT NULL,
            source_ref          TEXT NOT NULL,
            capture_method      TEXT NOT NULL,
            confidence          REAL NOT NULL DEFAULT 0,
            user_confirmed      INTEGER NOT NULL DEFAULT 0,
            recorded_at         TEXT NOT NULL,
            PRIMARY KEY (tenant_id, attribute_id)
        );
CREATE TABLE contact_candidates (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            candidate_id        TEXT NOT NULL,
            task_id             TEXT NOT NULL,
            role                TEXT NOT NULL DEFAULT 'other',
            attributes_json     TEXT,
            source_kind         TEXT NOT NULL,
            source_ref          TEXT NOT NULL,
            capture_method      TEXT NOT NULL,
            confidence          REAL NOT NULL DEFAULT 0,
            status              TEXT NOT NULL DEFAULT 'needs_review',
            proposed_at         TEXT NOT NULL,
            confirmed_contact_id TEXT,
            confirmed_at        TEXT,
            PRIMARY KEY (tenant_id, candidate_id)
        );
CREATE TABLE contact_projections (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            contact_id         TEXT NOT NULL,
            employer           TEXT,
            job_id             TEXT,
            role               TEXT NOT NULL DEFAULT 'other',
            attribute_count    INTEGER NOT NULL DEFAULT 0,
            confirmed_count    INTEGER NOT NULL DEFAULT 0,
            source_kinds_json  TEXT NOT NULL DEFAULT '[]',
            provenance_json    TEXT NOT NULL DEFAULT '[]',
            created_at         TEXT,
            updated_at         TEXT,
            last_updated_at    TEXT,
            PRIMARY KEY (tenant_id, contact_id)
        );
CREATE TABLE contact_research_task_projections (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            task_id              TEXT NOT NULL,
            employer             TEXT,
            job_id               TEXT,
            status               TEXT NOT NULL DEFAULT 'queued',
            candidate_count      INTEGER NOT NULL DEFAULT 0,
            needs_review_count   INTEGER NOT NULL DEFAULT 0,
            confirmed_count      INTEGER NOT NULL DEFAULT 0,
            source_attempts_json TEXT NOT NULL DEFAULT '[]',
            candidates_json      TEXT NOT NULL DEFAULT '[]',
            started_at           TEXT,
            updated_at           TEXT,
            needs_review_at      TEXT,
            completed_at         TEXT,
            failed_at            TEXT,
            error_class          TEXT,
            last_updated_at      TEXT,
            PRIMARY KEY (tenant_id, task_id)
        );
CREATE TABLE "contact_research_tasks" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            task_id              TEXT NOT NULL,
            employer             TEXT,
            job_id   TEXT,
            status               TEXT NOT NULL DEFAULT 'queued',
            source_attempts_json TEXT NOT NULL DEFAULT '[]',
            started_at           TEXT,
            updated_at           TEXT NOT NULL,
            needs_review_at      TEXT,
            completed_at         TEXT,
            failed_at            TEXT,
            error_class          TEXT,
            PRIMARY KEY (tenant_id, task_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT
        );
CREATE TABLE "contacts" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            contact_id          TEXT NOT NULL,
            employer            TEXT,
            job_id  TEXT,
            role                TEXT NOT NULL DEFAULT 'other',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            deleted_at          TEXT,
            PRIMARY KEY (tenant_id, contact_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT
        );
CREATE TABLE dashboard_projections (
            tenant_id              TEXT PRIMARY KEY,
            total_jobs             INTEGER NOT NULL DEFAULT 0,
            failures               INTEGER NOT NULL DEFAULT 0,
            blocked                INTEGER NOT NULL DEFAULT 0,
            ready                  INTEGER NOT NULL DEFAULT 0,
            applied                INTEGER NOT NULL DEFAULT 0,
            dry_runs               INTEGER NOT NULL DEFAULT 0,
            funnel_json            TEXT NOT NULL DEFAULT '[]',
            by_source_json         TEXT NOT NULL DEFAULT '[]',
            score_distribution_json TEXT NOT NULL DEFAULT '[]',
            outcome_conversion_json TEXT NOT NULL DEFAULT '{}',
            generated_at           TEXT NOT NULL DEFAULT ''
        );
CREATE TABLE digest_state (
            tenant_id              TEXT PRIMARY KEY DEFAULT 'local',
            last_acknowledged_at   TEXT,
            updated_at             TEXT NOT NULL
        );
CREATE TABLE "discovery_execution_jobs" (
            tenant_id                TEXT NOT NULL,
            discover_workflow_id     TEXT NOT NULL,
            discover_run_id          TEXT NOT NULL,
            job_id                   TEXT NOT NULL,
            cohort_kind              TEXT NOT NULL
                CHECK (cohort_kind IN (
                    'observed_this_run', 'existing_backlog'
                )),
            source_family            TEXT,
            source_run_id            TEXT,
            preparation_workflow_id  TEXT,
            work_plan_state          TEXT NOT NULL DEFAULT 'pending'
                CHECK (work_plan_state IN (
                    'pending', 'planned', 'not_eligible', 'failed'
                )),
            required_steps_json      TEXT,
            work_plan_reason         TEXT,
            linked_at                TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, job_id
            ),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE discovery_execution_recoveries (
            tenant_id                   TEXT NOT NULL,
            discover_workflow_id        TEXT NOT NULL,
            discover_run_id             TEXT NOT NULL,
            state                       TEXT NOT NULL
                CHECK (state IN ('recovering', 'ready', 'retrying', 'incomplete')),
            mode                        TEXT NOT NULL
                CHECK (mode IN ('native', 'reconstructed')),
            decoder_version             INTEGER NOT NULL,
            history_event_id            INTEGER NOT NULL,
            expected_membership_count   INTEGER NOT NULL,
            persisted_membership_count  INTEGER NOT NULL,
            expected_step_count         INTEGER NOT NULL,
            persisted_step_count        INTEGER NOT NULL,
            key_digest                  TEXT NOT NULL,
            last_error_code             TEXT,
            updated_at                  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, discover_workflow_id, discover_run_id)
        );
CREATE TABLE "discovery_feedback" (
            tenant_id         TEXT NOT NULL DEFAULT 'local',
            feedback_id       TEXT NOT NULL,
            job_id TEXT NOT NULL,
            source_id         TEXT,
            kind              TEXT NOT NULL,
            note              TEXT,
            recorded_at       TEXT NOT NULL,
            PRIMARY KEY (tenant_id, feedback_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "discovery_quarantine_entries" (
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            title            TEXT NOT NULL DEFAULT '',
            company          TEXT NOT NULL DEFAULT '',
            source_id        TEXT NOT NULL,
            posting_url      TEXT,
            reason           TEXT NOT NULL,
            confidence       REAL,
            snapshot_version INTEGER,
            captured_at      TEXT,
            notice_text      TEXT,
            status           TEXT NOT NULL DEFAULT 'pending',
            decision_reason  TEXT,
            decided_at       TEXT,
            PRIMARY KEY (tenant_id, job_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE discovery_runs (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            run_id                 TEXT NOT NULL,
            source_ids_json        TEXT NOT NULL DEFAULT '[]',
            profile_snapshot_id    TEXT,
            status                 TEXT NOT NULL,
            counts_json            TEXT NOT NULL DEFAULT '{}',
            progress_json          TEXT NOT NULL DEFAULT '{}',
            error_classes_json     TEXT NOT NULL DEFAULT '[]',
            started_at             TEXT NOT NULL,
            updated_at             TEXT,
            completed_at           TEXT,
            failed_at              TEXT,
            workflow_id            TEXT,
            PRIMARY KEY (tenant_id, run_id)
        );
CREATE TABLE discovery_search_unit_filtered_events (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            provider_event_key_hash TEXT NOT NULL
                CHECK (length(provider_event_key_hash) = 64),
            filtered_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, provider_event_key_hash
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE
        ) WITHOUT ROWID
        ;
CREATE TABLE "discovery_search_unit_jobs" (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            job_id                 TEXT NOT NULL,
            was_new                INTEGER NOT NULL CHECK (was_new IN (0, 1)),
            accepted_at            TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id,
                unit_id, job_id
            ),
            FOREIGN KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) REFERENCES discovery_search_units(
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE discovery_search_units (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            unit_id                TEXT NOT NULL,
            ordinal                INTEGER NOT NULL CHECK (ordinal >= 0),
            request_json           TEXT NOT NULL,
            request_fingerprint    TEXT NOT NULL,
            state                  TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'completed', 'skipped', 'failed', 'canceled')),
            lease_owner            TEXT,
            lease_attempt          INTEGER NOT NULL DEFAULT 0 CHECK (lease_attempt >= 0),
            lease_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
            recovery_count         INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
            checkpoint_json        TEXT,
            checkpoint_revision    INTEGER CHECK (checkpoint_revision >= 0),
            last_error_code        TEXT,
            last_error_type        TEXT,
            last_error_retryable   INTEGER,
            reset_checkpoint       INTEGER NOT NULL DEFAULT 0 CHECK (reset_checkpoint IN (0, 1)),
            reset_checkpoint_after_revision INTEGER CHECK (reset_checkpoint_after_revision >= 0),
            created_at             TEXT NOT NULL,
            updated_at             TEXT NOT NULL,
            completed_at           TEXT,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, unit_id
            ),
            UNIQUE (
                tenant_id, discover_workflow_id, discover_run_id, ordinal
            ),
            CHECK (
                (checkpoint_json IS NULL AND checkpoint_revision IS NULL)
                OR (checkpoint_json IS NOT NULL AND checkpoint_revision IS NOT NULL)
            )
        );
CREATE TABLE discovery_settings (
            tenant_id          TEXT PRIMARY KEY,
            search_config_json TEXT NOT NULL,
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL
        );
CREATE TABLE due_follow_up_projections (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            thread_id           TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            job_id              TEXT,
            due_at              TEXT,
            basis               TEXT,
            state               TEXT NOT NULL DEFAULT 'scheduled',
            created_at          TEXT,
            updated_at          TEXT,
            last_updated_at     TEXT,
            PRIMARY KEY (tenant_id, thread_id)
        );
CREATE TABLE event_watermarks (
            projection_name     TEXT PRIMARY KEY,
            last_event_id       INTEGER NOT NULL DEFAULT 0,
            updated_at          TEXT NOT NULL
        );
CREATE TABLE evidence_usage_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            projection_kind        TEXT NOT NULL CHECK(projection_kind IN ('entry', 'gap')),
            projection_id          TEXT NOT NULL,
            evidence_id            TEXT,
            skill_id               TEXT,
            requirement_id         TEXT,
            title                  TEXT NOT NULL DEFAULT '',
            payload_json           TEXT NOT NULL,
            last_updated_at        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, projection_kind, projection_id)
        );
CREATE TABLE "job_artifacts" (
            artifact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            job_id              TEXT NOT NULL,
            stage               TEXT NOT NULL,
            artifact_type       TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            path                TEXT NOT NULL,
            created_at          TEXT NOT NULL,
            size_bytes          INTEGER,
            metadata_json       TEXT,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_bullet_provenance" (
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            job_id                  TEXT NOT NULL,
            generation              INTEGER NOT NULL CHECK(generation > 0),
            bullet_id               TEXT NOT NULL,
            artifact_id             TEXT NOT NULL,
            section                 TEXT NOT NULL,
            source_id               TEXT,
            evidence_ids_json       TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json    TEXT NOT NULL DEFAULT '[]',
            matched_keywords_json   TEXT NOT NULL DEFAULT '[]',
            transform_type          TEXT NOT NULL,
            control                 TEXT NOT NULL,
            rationale               TEXT NOT NULL DEFAULT '',
            generated_text          TEXT NOT NULL,
            position                INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL,
            coverage_json           TEXT,
            voice_json              TEXT,
            PRIMARY KEY (
                tenant_id, job_id, generation, bullet_id
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_materials"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_canonical_identities" (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            canonical_url      TEXT NOT NULL,
            ats_kind           TEXT NOT NULL,
            source_native_id   TEXT NOT NULL,
            confidence         REAL NOT NULL,
            resolved_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE job_detail_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            description_preview    TEXT NOT NULL DEFAULT '',
            compensation_summary_json TEXT,
            compensation_audit_json TEXT,
            score_breakdown_json   TEXT,
            score_keywords_json    TEXT NOT NULL DEFAULT '[]',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            score_version          INTEGER,
            scored_at              TEXT,
            score_criteria_json    TEXT,
            score_trace_json       TEXT,
            score_correction_json  TEXT,
            stages_json            TEXT NOT NULL DEFAULT '[]',
            employer_analysis_json TEXT,
            requirement_fit_report_json TEXT,
            interview_prep_json    TEXT,
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        );
CREATE TABLE "job_duplicate_links" (
            tenant_id                              TEXT NOT NULL DEFAULT 'local',
            duplicate_link_id                      TEXT NOT NULL,
            surviving_job_id                       TEXT NOT NULL,
            superseded_job_or_observation_id       TEXT NOT NULL,
            reason                                 TEXT NOT NULL,
            confidence                             REAL NOT NULL,
            linked_at                              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, duplicate_link_id),
            FOREIGN KEY (tenant_id, surviving_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_employer_analysis" (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_id                    TEXT NOT NULL,
            generation                INTEGER NOT NULL CHECK(generation > 0),
            snapshot_hash             TEXT NOT NULL,
            prompt_version            TEXT NOT NULL,
            sdk_set_version           TEXT NOT NULL,
            cache_key                 TEXT NOT NULL,
            role_framing              TEXT NOT NULL DEFAULT '',
            inferred_seniority        TEXT NOT NULL DEFAULT '',
            ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
            requirements_json         TEXT NOT NULL DEFAULT '[]',
            keywords_json             TEXT NOT NULL DEFAULT '[]',
            agreement_json            TEXT NOT NULL DEFAULT '{}',
            eeo_screen_json           TEXT NOT NULL DEFAULT '[]',
            legs_attempted            INTEGER NOT NULL,
            legs_succeeded            INTEGER NOT NULL,
            created_at                TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, generation),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_employer_analysis_failures" (
            tenant_id  TEXT NOT NULL DEFAULT 'local',
            job_id     TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation > 0),
            model_id   TEXT NOT NULL,
            error      TEXT NOT NULL,
            raw_output TEXT,
            PRIMARY KEY (tenant_id, job_id, generation, model_id),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_employer_analysis"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_employer_analysis_sub_analyses" (
            tenant_id    TEXT NOT NULL DEFAULT 'local',
            job_id       TEXT NOT NULL,
            generation   INTEGER NOT NULL CHECK(generation > 0),
            model_id     TEXT NOT NULL,
            analysis_json TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, generation, model_id),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_employer_analysis"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_enrichments" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            job_id              TEXT NOT NULL,
            current_status      TEXT NOT NULL,
            full_description    TEXT,
            application_url     TEXT,
            enriched_at         TEXT,
            extraction_tier     TEXT,
            attempts_json       TEXT NOT NULL DEFAULT '[]',
            updated_at          TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_events" (
            event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id        TEXT NOT NULL,
            job_id           TEXT,
            identity_version INTEGER NOT NULL,
            stage            TEXT,
            event_type       TEXT NOT NULL,
            level            TEXT NOT NULL DEFAULT 'info',
            message          TEXT,
            occurred_at      TEXT NOT NULL,
            payload_json     TEXT,
            entity_kind      TEXT,
            entity_ref       TEXT,
            idempotency_key  TEXT,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_interview_prep" (
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            job_id         TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            status                     TEXT NOT NULL,
            model                      TEXT,
            generated_at               TEXT NOT NULL,
            gate_status                TEXT NOT NULL,
            fabrication_findings_json  TEXT NOT NULL DEFAULT '[]',
            grounding_findings_json    TEXT NOT NULL DEFAULT '[]',
            judge_verdict              TEXT,
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            failure_reason             TEXT NOT NULL DEFAULT '',
            origin_run_id              TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, job_id, generation)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_interview_prep_items" (
            tenant_id                  TEXT NOT NULL DEFAULT 'local',
            job_id         TEXT NOT NULL,
            generation                 INTEGER NOT NULL,
            item_id                    TEXT NOT NULL,
            kind                       TEXT NOT NULL,
            title                      TEXT NOT NULL,
            generated_text             TEXT NOT NULL,
            evidence_ids_json          TEXT NOT NULL DEFAULT '[]',
            requirement_ids_json       TEXT NOT NULL DEFAULT '[]',
            source_text_json           TEXT NOT NULL DEFAULT '[]',
            transform_type             TEXT NOT NULL DEFAULT 'grounded_prep',
            control                    TEXT NOT NULL DEFAULT 'never_fabricate',
            grounding_audit_json       TEXT NOT NULL DEFAULT '[]',
            warnings_json              TEXT NOT NULL DEFAULT '[]',
            position                   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant_id, job_id, generation, item_id)
            ,
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_interview_prep"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE job_list_projections (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            title                  TEXT NOT NULL DEFAULT '',
            employer               TEXT NOT NULL DEFAULT '',
            source                 TEXT NOT NULL DEFAULT '',
            strategy               TEXT NOT NULL DEFAULT '',
            location               TEXT NOT NULL DEFAULT '',
            salary                 TEXT NOT NULL DEFAULT '',
            application_url        TEXT,
            discovered_at          TEXT,
            description            TEXT NOT NULL DEFAULT '',
            full_description       TEXT NOT NULL DEFAULT '',
            fit_score              INTEGER,
            fit_band               TEXT,
            compensation_summary_json TEXT,
            score_breakdown_json   TEXT,
            score_keywords_json    TEXT NOT NULL DEFAULT '[]',
            score_reasoning        TEXT NOT NULL DEFAULT '',
            score_version          INTEGER,
            scored_at              TEXT,
            score_criteria_json    TEXT,
            score_trace_json       TEXT,
            score_correction_json  TEXT,
            current_stage          TEXT NOT NULL DEFAULT 'discover',
            current_substage       TEXT NOT NULL DEFAULT 'discover',
            current_state          TEXT NOT NULL DEFAULT 'pending',
            current_error_code     TEXT,
            current_error_message  TEXT,
            current_next_action    TEXT,
            has_resume             INTEGER NOT NULL DEFAULT 0,
            has_cover_letter       INTEGER NOT NULL DEFAULT 0,
            has_pdf                INTEGER NOT NULL DEFAULT 0,
            apply_status           TEXT,
            applied_at             TEXT,
            apply_mode             TEXT,
            resume_template_id     TEXT,
            resume_template_name   TEXT,
            tailoring_policy_version INTEGER,
            artifact_count         INTEGER NOT NULL DEFAULT 0,
            deleted_at             TEXT,
            last_updated_at        TEXT,
            PRIMARY KEY (tenant_id, job_id)
        );
CREATE TABLE job_locators (
            tenant_id      TEXT NOT NULL,
            job_id         TEXT NOT NULL,
            locator_kind   TEXT NOT NULL CHECK (locator_kind = 'posting_url'),
            locator_value  TEXT NOT NULL,
            is_current     INTEGER NOT NULL CHECK (is_current IN (0, 1)),
            first_seen_at  TEXT NOT NULL,
            last_seen_at   TEXT NOT NULL,
            retired_at     TEXT,
            PRIMARY KEY (tenant_id, job_id, locator_kind, locator_value),
            UNIQUE (tenant_id, locator_kind, locator_value),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_market_compensation_estimates" (
            tenant_id                          TEXT NOT NULL DEFAULT 'local',
            job_id                             TEXT NOT NULL,
            estimate_state                     TEXT NOT NULL CHECK (
                estimate_state IN (
                    'unsupported',
                    'source_unavailable',
                    'insufficient_evidence',
                    'estimated_range'
                )
            ),
            currency                           TEXT,
            period                             TEXT NOT NULL DEFAULT 'year'
                CHECK (period IN ('year', 'month')),
            component                          TEXT NOT NULL
                DEFAULT 'total_compensation'
                CHECK (
                    component IN (
                        'base_salary',
                        'total_compensation'
                    )
                ),
            minimum_amount                     INTEGER,
            maximum_amount                     INTEGER,
            confidence_interval_minimum_amount INTEGER,
            confidence_interval_maximum_amount INTEGER,
            confidence_band                    TEXT NOT NULL DEFAULT 'none'
                CHECK (
                    confidence_band IN (
                        'none',
                        'low',
                        'medium',
                        'high'
                    )
                ),
            confidence_score                   REAL NOT NULL DEFAULT 0,
            source_count                       INTEGER NOT NULL DEFAULT 0,
            sample_count                       INTEGER,
            aggregate_bucket                   TEXT,
            geography_scope                    TEXT,
            occupation_code                    TEXT,
            occupation_label                   TEXT,
            seniority_label                    TEXT,
            source_snapshot_json               TEXT NOT NULL DEFAULT '[]',
            factor_reasons_json                TEXT NOT NULL DEFAULT '[]',
            selected_evidence_json             TEXT NOT NULL DEFAULT '[]',
            insufficient_reasons_json          TEXT NOT NULL DEFAULT '[]',
            unsupported_reasons_json           TEXT NOT NULL DEFAULT '[]',
            source_unavailable_reasons_json    TEXT NOT NULL DEFAULT '[]',
            warnings_json                      TEXT NOT NULL DEFAULT '[]',
            estimator_version                  TEXT NOT NULL,
            estimated_at                       TEXT NOT NULL,
            company_name                       TEXT,
            normalized_company                 TEXT,
            role_title                         TEXT,
            normalized_role                    TEXT,
            company_tier                       TEXT NOT NULL DEFAULT 'unknown'
                CHECK (
                    company_tier IN (
                        'tier_1_local',
                        'tier_2_ambitious',
                        'tier_3_top_of_market',
                        'unknown'
                    )
                ),
            match_scope                        TEXT NOT NULL DEFAULT 'none'
                CHECK (
                    match_scope IN (
                        'exact_company_role',
                        'same_location_role_fallback',
                        'company_adjacent_role',
                        'tier_role_fallback',
                        'market_baseline_fallback',
                        'none'
                    )
                ),
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_material_layout_boxes" (
            tenant_id         TEXT NOT NULL DEFAULT 'local',
            job_id            TEXT NOT NULL,
            generation        INTEGER NOT NULL CHECK(generation > 0),
            artifact_id       TEXT NOT NULL,
            box_index         INTEGER NOT NULL,
            semantic_id       TEXT NOT NULL,
            page_number       INTEGER NOT NULL,
            line_number       INTEGER,
            text_excerpt      TEXT NOT NULL,
            left_pct          REAL NOT NULL,
            top_pct           REAL NOT NULL,
            width_pct         REAL NOT NULL,
            height_pct        REAL NOT NULL,
            audit_target_json TEXT NOT NULL DEFAULT '{}',
            created_at        TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, job_id, generation, artifact_id, box_index
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_materials"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_materials" (
            tenant_id            TEXT NOT NULL DEFAULT 'local',
            job_id               TEXT NOT NULL,
            generation           INTEGER NOT NULL CHECK(generation > 0),
            status               TEXT NOT NULL,
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            last_validation_json TEXT,
            last_verdict_json    TEXT,
            metadata_json        TEXT,
            PRIMARY KEY (tenant_id, job_id, generation),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_materials_artifacts" (
            tenant_id      TEXT NOT NULL DEFAULT 'local',
            job_id         TEXT NOT NULL,
            generation     INTEGER NOT NULL CHECK(generation > 0),
            artifact_type  TEXT NOT NULL,
            artifact_id    TEXT NOT NULL,
            status         TEXT NOT NULL,
            path           TEXT NOT NULL,
            render_format  TEXT NOT NULL,
            size_bytes     INTEGER,
            metadata_json  TEXT,
            created_at     TEXT NOT NULL,
            superseded_at  TEXT,
            PRIMARY KEY (
                tenant_id, job_id, generation, artifact_type
            ),
            FOREIGN KEY (tenant_id, job_id, generation)
                REFERENCES "job_materials"(
                    tenant_id, job_id, generation
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_posted_compensation_facts" (
            tenant_id                    TEXT NOT NULL DEFAULT 'local',
            job_id                       TEXT NOT NULL,
            source_field                 TEXT NOT NULL DEFAULT 'jobs.salary',
            source_text                  TEXT,
            legacy_raw_salary            TEXT,
            parse_state                  TEXT NOT NULL,
            currency                     TEXT,
            period                       TEXT NOT NULL DEFAULT 'unknown',
            component                    TEXT NOT NULL DEFAULT 'unknown',
            minimum_amount               INTEGER,
            maximum_amount               INTEGER,
            annualized_minimum_amount    INTEGER,
            annualized_maximum_amount    INTEGER,
            annualization_assumption     TEXT,
            confidence                   TEXT NOT NULL DEFAULT 'none',
            warnings_json                TEXT NOT NULL DEFAULT '[]',
            parser_version               TEXT NOT NULL,
            source_hash                  TEXT NOT NULL,
            parsed_at                    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_rejected_duplicate_links" (
            tenant_id       TEXT NOT NULL DEFAULT 'local',
            owner_job_id    TEXT NOT NULL,
            candidate_url   TEXT NOT NULL,
            reason          TEXT NOT NULL,
            rejected_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, owner_job_id, candidate_url),
            FOREIGN KEY (tenant_id, owner_job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_requirement_fit_items" (
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            job_id                 TEXT NOT NULL,
            score_version          INTEGER NOT NULL,
            requirement_id         TEXT NOT NULL,
            requirement_text       TEXT NOT NULL,
            tier                   TEXT NOT NULL CHECK(
                tier IN ('must_have', 'nice_to_have')
            ),
            weight                 REAL NOT NULL CHECK(
                weight >= 0 AND weight <= 1
            ),
            job_evidence_span       TEXT NOT NULL,
            fit_json                TEXT NOT NULL,
            contribution_json       TEXT NOT NULL,
            tailoring_json          TEXT NOT NULL,
            artifact_coverage_json  TEXT,
            position                INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (
                tenant_id, job_id, score_version, requirement_id
            ),
            FOREIGN KEY (tenant_id, job_id, score_version)
                REFERENCES "job_requirement_fit_reports"(
                    tenant_id, job_id, score_version
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_requirement_fit_reports" (
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            job_id                        TEXT NOT NULL,
            score_version                 INTEGER NOT NULL,
            employer_analysis_generation  INTEGER NOT NULL,
            profile_snapshot_version      INTEGER NOT NULL,
            scoring_policy_version        INTEGER NOT NULL,
            formula_version               TEXT NOT NULL,
            resolved_fit_score            INTEGER CHECK(
                resolved_fit_score IS NULL
                OR resolved_fit_score BETWEEN 1 AND 10
            ),
            fit_band                      TEXT NOT NULL,
            confidence                    TEXT NOT NULL,
            summary_json                  TEXT NOT NULL DEFAULT '{}',
            created_at                    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id, score_version),
            FOREIGN KEY (tenant_id, job_id, score_version)
                REFERENCES "job_scores"(
                    tenant_id, job_id, version
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_resume_template_assignments" (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            job_id      TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_score_keywords" (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            score_version      INTEGER NOT NULL CHECK(score_version > 0),
            normalized_keyword TEXT NOT NULL
                CHECK(length(trim(normalized_keyword)) > 0),
            display_keyword    TEXT NOT NULL
                CHECK(length(trim(display_keyword)) > 0),
            position           INTEGER NOT NULL CHECK(position >= 0),
            PRIMARY KEY (
                tenant_id, job_id, score_version, normalized_keyword
            ),
            UNIQUE (tenant_id, job_id, score_version, position),
            FOREIGN KEY (tenant_id, job_id, score_version)
                REFERENCES "job_scores"(
                    tenant_id, job_id, version
                ) ON DELETE CASCADE
        );
CREATE TABLE "job_score_staleness" (
            tenant_id                 TEXT NOT NULL DEFAULT 'local',
            job_id                   TEXT NOT NULL,
            stale_reason              TEXT NOT NULL,
            old_policy_id             TEXT NOT NULL DEFAULT '',
            old_policy_version        INTEGER NOT NULL,
            new_policy_id             TEXT NOT NULL DEFAULT '',
            new_policy_version        INTEGER NOT NULL,
            marked_at                 TEXT NOT NULL,
            resolved                  INTEGER NOT NULL DEFAULT 0
                CHECK(resolved IN (0, 1)),
            resolved_at               TEXT,
            resolved_by_score_version INTEGER,
            PRIMARY KEY (
                tenant_id, job_id, stale_reason,
                old_policy_version, new_policy_version
            ),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_scores" (
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            version          INTEGER NOT NULL CHECK(version > 0),
            fit_score        INTEGER NOT NULL CHECK(fit_score BETWEEN 1 AND 10),
            breakdown_json   TEXT NOT NULL,
            keywords_json    TEXT NOT NULL,
            scored_at        TEXT NOT NULL,
            correction_json  TEXT,
            criteria_json    TEXT NOT NULL DEFAULT '{}',
            trace_json       TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (tenant_id, job_id, version),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_source_observations" (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            source_observation_id    TEXT NOT NULL,
            job_id                   TEXT NOT NULL,
            source_id                TEXT NOT NULL,
            source_native_id         TEXT NOT NULL,
            observed_url             TEXT NOT NULL,
            normalized_observed_url  TEXT NOT NULL,
            run_id                   TEXT NOT NULL DEFAULT '',
            observed_at              TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_observation_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "job_stage_states" (
            tenant_id          TEXT NOT NULL DEFAULT 'local',
            job_id             TEXT NOT NULL,
            stage              TEXT NOT NULL,
            state              TEXT NOT NULL DEFAULT 'pending',
            attempt_count      INTEGER DEFAULT 0,
            max_attempts       INTEGER,
            started_at         TEXT,
            updated_at         TEXT NOT NULL,
            finished_at        TEXT,
            duration_ms        INTEGER,
            error_code         TEXT,
            error_message      TEXT,
            retryable          INTEGER DEFAULT 1,
            blocked_by_json    TEXT,
            next_action        TEXT,
            metadata_json      TEXT,
            version            INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant_id, job_id, stage),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "jobctrl_deleted_jobs" (
                tenant_id   TEXT NOT NULL DEFAULT 'local',
                job_id      TEXT NOT NULL,
                deleted_at  TEXT NOT NULL,
                reason      TEXT,
                restored_at TEXT,
                PRIMARY KEY (tenant_id, job_id),
                FOREIGN KEY (tenant_id, job_id)
                    REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
            );
CREATE TABLE "jobctrl_hidden_jobs" (
                tenant_id   TEXT NOT NULL DEFAULT 'local',
                job_id      TEXT NOT NULL,
                hidden_at   TEXT NOT NULL,
                reason      TEXT,
                unhidden_at TEXT,
                PRIMARY KEY (tenant_id, job_id),
                FOREIGN KEY (tenant_id, job_id)
                    REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
            );
CREATE TABLE "jobs" ("url" TEXT NOT NULL, "title" TEXT, "company" TEXT, "salary" TEXT, "description" TEXT, "location" TEXT, "site" TEXT, "strategy" TEXT, "discovered_at" TEXT, "full_description" TEXT, "application_url" TEXT, "detail_scraped_at" TEXT, "detail_error" TEXT, "fit_score" INTEGER, "score_reasoning" TEXT, "scored_at" TEXT, "tailored_resume_path" TEXT, "tailored_at" TEXT, "tailor_attempts" INTEGER DEFAULT 0, "cover_letter_path" TEXT, "cover_letter_at" TEXT, "cover_attempts" INTEGER DEFAULT 0, "applied_at" TEXT, "apply_status" TEXT, "apply_error" TEXT, "apply_attempts" INTEGER DEFAULT 0, "agent_id" TEXT, "last_attempted_at" TEXT, "apply_duration_ms" INTEGER, "apply_task_id" TEXT, "verification_confidence" TEXT, "tenant_id" TEXT NOT NULL, "job_id" TEXT NOT NULL, PRIMARY KEY (tenant_id, job_id), UNIQUE (tenant_id, url));
CREATE TABLE llm_spend (
            day           TEXT PRIMARY KEY,
            input_tokens  INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_usd REAL NOT NULL DEFAULT 0
        );
CREATE TABLE "manual_capture_queue" (
            tenant_id                     TEXT NOT NULL DEFAULT 'local',
            item_id                       TEXT NOT NULL,
            originating_url               TEXT NOT NULL,
            source_id                     TEXT,
            reason                        TEXT NOT NULL,
            retry_context_json            TEXT NOT NULL DEFAULT '{}',
            required_at                   TEXT NOT NULL,
            status                        TEXT NOT NULL DEFAULT 'pending',
            imported_at                   TEXT,
            dismissed_at                  TEXT,
            capture_mode                  TEXT,
            captured_url                  TEXT,
            content_sha256                TEXT,
            content_length                INTEGER,
            note                          TEXT,
            future_manual_action_required INTEGER NOT NULL DEFAULT 0,
            job_id            TEXT,
            PRIMARY KEY (tenant_id, item_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "operational_attempt_metrics" (
            metric_id               INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id               TEXT NOT NULL DEFAULT 'local',
            occurred_at             TEXT NOT NULL,
            stage                   TEXT NOT NULL,
            source_id               TEXT,
            source_kind             TEXT,
            source_priority         TEXT,
            source_role             TEXT,
            adapter                 TEXT,
            attempt_kind            TEXT NOT NULL,
            outcome                 TEXT NOT NULL,
            failure_category        TEXT,
            is_operational_failure  INTEGER NOT NULL DEFAULT 0,
            is_scrape_failure       INTEGER NOT NULL DEFAULT 0,
            is_retryable            INTEGER NOT NULL DEFAULT 1,
            run_id                  TEXT,
            job_id                  TEXT,
            duration_ms             INTEGER,
            total_count             INTEGER,
            new_count               INTEGER,
            existing_count          INTEGER,
            observed_count          INTEGER,
            duplicate_count         INTEGER,
            error_class             TEXT,
            error_message           TEXT,
            metadata_json           TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT
        );
CREATE TABLE outreach_drafts (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            draft_id            TEXT NOT NULL,
            thread_id           TEXT NOT NULL,
            generation          INTEGER NOT NULL DEFAULT 1,
            kind                TEXT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'candidate',
            body_text           TEXT,
            gate_results_json   TEXT,
            provenance_json     TEXT,
            created_at          TEXT NOT NULL,
            approved_at         TEXT,
            rejected_at         TEXT,
            reason              TEXT,
            PRIMARY KEY (tenant_id, draft_id)
        );
CREATE TABLE outreach_send_logs (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            send_log_id         TEXT NOT NULL,
            thread_id           TEXT NOT NULL,
            draft_id            TEXT NOT NULL,
            channel             TEXT NOT NULL,
            sent_at             TEXT NOT NULL,
            logged_at           TEXT NOT NULL,
            PRIMARY KEY (tenant_id, send_log_id)
        );
CREATE TABLE outreach_thread_projections (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            thread_id           TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            job_id              TEXT,
            draft_count         INTEGER NOT NULL DEFAULT 0,
            latest_generation   INTEGER NOT NULL DEFAULT 0,
            has_approved_draft  INTEGER NOT NULL DEFAULT 0,
            approved_draft_id   TEXT,
            latest_status       TEXT,
            drafts_json         TEXT NOT NULL DEFAULT '[]',
            created_at          TEXT,
            updated_at          TEXT,
            last_updated_at     TEXT,
            PRIMARY KEY (tenant_id, thread_id)
        );
CREATE TABLE "outreach_threads" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            thread_id           TEXT NOT NULL,
            contact_id          TEXT NOT NULL,
            job_id  TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL,
            follow_up_due_at    TEXT,
            follow_up_basis     TEXT,
            follow_up_state     TEXT NOT NULL DEFAULT 'none',
            PRIMARY KEY (tenant_id, thread_id)
            ,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE RESTRICT
        );
CREATE TABLE pipeline_step_projections (
            tenant_id              TEXT NOT NULL,
            discover_workflow_id   TEXT NOT NULL,
            discover_run_id        TEXT NOT NULL,
            step_kind              TEXT NOT NULL CHECK (step_kind IN (
                'source_planning', 'source_family', 'enrichment_pass',
                'preparation_fanout', 'existing_backlog_sweep', 'pdf_render'
            )),
            item_key               TEXT NOT NULL,
            state                  TEXT NOT NULL CHECK (state IN (
                'queued', 'running', 'succeeded', 'failed'
            )),
            attempt                INTEGER NOT NULL CHECK (attempt >= 1),
            queued_at              TEXT,
            started_at             TEXT,
            finished_at            TEXT,
            duration_ms            INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
            error_code             TEXT,
            retryable              INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
            detail_code            TEXT,
            detail_count           INTEGER CHECK (detail_count IS NULL OR detail_count >= 0),
            last_event_id          INTEGER NOT NULL,
            last_updated_at        TEXT NOT NULL,
            PRIMARY KEY (
                tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key
            )
        );
CREATE TABLE "posting_snapshot_sets" (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            job_id                   TEXT NOT NULL,
            snapshot_set_json        TEXT NOT NULL,
            latest_snapshot_version  INTEGER NOT NULL DEFAULT 0,
            latest_active_state      TEXT NOT NULL DEFAULT 'unknown',
            latest_confidence        TEXT,
            latest_quarantine_reason TEXT,
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE "preparation_work_items" (
            item_id          TEXT NOT NULL PRIMARY KEY,
            tenant_id        TEXT NOT NULL DEFAULT 'local',
            job_id           TEXT NOT NULL,
            kind             TEXT NOT NULL,
            target_version   INTEGER NOT NULL,
            source_event_id  TEXT NOT NULL DEFAULT '',
            state            TEXT NOT NULL,
            idempotency_key  TEXT NOT NULL,
            attempts         INTEGER NOT NULL DEFAULT 0,
            last_error       TEXT NOT NULL DEFAULT '',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            available_at     TEXT NOT NULL,
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE projection_backfills (
            name         TEXT PRIMARY KEY,
            completed_at TEXT NOT NULL
        );
CREATE TABLE resume_template_defaults (
            tenant_id   TEXT NOT NULL DEFAULT 'local',
            profile_id  TEXT NOT NULL DEFAULT 'default',
            template_id TEXT NOT NULL,
            version_id  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (tenant_id, profile_id)
        );
CREATE TABLE "resume_template_refresh_attempts" (
            tenant_id           TEXT NOT NULL DEFAULT 'local',
            attempt_id          TEXT NOT NULL,
            job_id              TEXT NOT NULL,
            status              TEXT NOT NULL,
            from_generation     INTEGER,
            to_generation       INTEGER,
            template_id         TEXT,
            template_version_id TEXT,
            template_hash       TEXT,
            error_message       TEXT,
            metadata_json       TEXT NOT NULL DEFAULT '{}',
            created_at          TEXT NOT NULL,
            completed_at        TEXT,
            PRIMARY KEY (tenant_id, attempt_id),
            FOREIGN KEY (tenant_id, job_id)
                REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
        );
CREATE TABLE resume_template_versions (
            tenant_id      TEXT NOT NULL DEFAULT 'local',
            version_id     TEXT NOT NULL,
            template_id    TEXT NOT NULL,
            version_number INTEGER NOT NULL,
            display_name   TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'active',
            theme_json     TEXT NOT NULL,
            layout_json    TEXT NOT NULL DEFAULT '{}',
            content_hash   TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            PRIMARY KEY (tenant_id, version_id),
            UNIQUE (tenant_id, template_id, version_number)
        );
CREATE TABLE resume_templates (
            tenant_id    TEXT NOT NULL DEFAULT 'local',
            template_id  TEXT NOT NULL,
            display_name TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            built_in     INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (tenant_id, template_id)
        );
CREATE TABLE scoring_policies (
            tenant_id              TEXT NOT NULL,
            version                INTEGER NOT NULL,
            rubric_json            TEXT NOT NULL,
            anchors_json           TEXT NOT NULL DEFAULT '[]',
            created_at             TEXT NOT NULL,
            created_from_event_id  INTEGER,
            PRIMARY KEY (tenant_id, version)
        );
CREATE TABLE source_locator_candidates (
            tenant_id                TEXT NOT NULL DEFAULT 'local',
            candidate_id             TEXT NOT NULL,
            candidate_url            TEXT NOT NULL,
            source_kind              TEXT NOT NULL,
            confidence               REAL NOT NULL DEFAULT 0,
            detected_ats_kind        TEXT,
            employer_domain_matched  INTEGER NOT NULL DEFAULT 0,
            manual_action_reason     TEXT,
            discovered_at            TEXT NOT NULL,
            PRIMARY KEY (tenant_id, candidate_id)
        );
CREATE TABLE source_quality_stats (
            tenant_id                         TEXT NOT NULL DEFAULT 'local',
            source_id                         TEXT NOT NULL,
            window_start                      TEXT NOT NULL,
            window_end                        TEXT NOT NULL,
            run_count                         INTEGER NOT NULL DEFAULT 0,
            failed_run_count                  INTEGER NOT NULL DEFAULT 0,
            consecutive_failures              INTEGER NOT NULL DEFAULT 0,
            observed_jobs                     INTEGER NOT NULL DEFAULT 0,
            new_jobs                          INTEGER NOT NULL DEFAULT 0,
            existing_jobs                     INTEGER NOT NULL DEFAULT 0,
            duplicate_jobs                    INTEGER NOT NULL DEFAULT 0,
            active_jobs                       INTEGER NOT NULL DEFAULT 0,
            stale_jobs                        INTEGER NOT NULL DEFAULT 0,
            detail_success_count              INTEGER NOT NULL DEFAULT 0,
            detail_failure_count              INTEGER NOT NULL DEFAULT 0,
            active_verification_rate          REAL,
            duplicate_rate                    REAL,
            full_description_success_rate     REAL,
            apply_url_success_rate            REAL,
            last_run_id                       TEXT,
            last_error_class                  TEXT,
            recommended_state                 TEXT NOT NULL DEFAULT 'normal',
            updated_at                        TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (tenant_id, source_id, window_start, window_end)
        );
CREATE TABLE source_registry_entries (
            tenant_id     TEXT NOT NULL DEFAULT 'local',
            source_id     TEXT NOT NULL,
            kind          TEXT NOT NULL,
            display_name  TEXT NOT NULL,
            owner         TEXT NOT NULL DEFAULT 'user',
            priority      TEXT NOT NULL DEFAULT 'standard',
            state         TEXT NOT NULL DEFAULT 'experimental',
            policy_id     TEXT NOT NULL,
            seed_url      TEXT,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, source_id)
        );
CREATE TABLE tailoring_policies (
            tenant_id                   TEXT NOT NULL,
            version                     INTEGER NOT NULL,
            prompt_version              TEXT NOT NULL,
            schema_version              TEXT NOT NULL,
            judge_schema_version        TEXT NOT NULL,
            prompt_fingerprint          TEXT NOT NULL,
            config_fingerprint          TEXT NOT NULL,
            profile_policy_fingerprint  TEXT NOT NULL,
            custom_prompt_fingerprint   TEXT NOT NULL,
            generator_settings_json     TEXT NOT NULL DEFAULT '{}',
            judge_settings_json         TEXT NOT NULL DEFAULT '{}',
            runtime_settings_json       TEXT NOT NULL DEFAULT '{}',
            rollback_of_version         INTEGER,
            rollback_reason             TEXT NOT NULL DEFAULT '',
            created_at                  TEXT NOT NULL,
            created_from_event_id       INTEGER,
            PRIMARY KEY (tenant_id, version)
        );
CREATE TABLE workflow_run_projections (
            workflow_id            TEXT PRIMARY KEY,
            tenant_id              TEXT NOT NULL DEFAULT 'local',
            workflow_type          TEXT NOT NULL DEFAULT '',
            status                 TEXT NOT NULL DEFAULT 'in_progress',
            input_summary_json     TEXT NOT NULL DEFAULT '{}',
            error_code             TEXT,
            error_message          TEXT,
            retryable              INTEGER NOT NULL DEFAULT 0,
            started_at             TEXT,
            finished_at            TEXT,
            duration_ms            INTEGER,
            temporal_run_id        TEXT,
            events_json            TEXT NOT NULL DEFAULT '[]'
        );
CREATE TABLE worker_runtime_heartbeats (
              worker_id TEXT PRIMARY KEY,
              component TEXT NOT NULL,
              pid INTEGER NOT NULL,
              hostname TEXT NOT NULL,
              app_dir TEXT NOT NULL,
              db_path TEXT NOT NULL,
              task_queue TEXT NOT NULL,
              started_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              max_concurrent_activities INTEGER,
              activity_executor_max_workers INTEGER,
              active_activity_count INTEGER NOT NULL DEFAULT 0,
              active_activity_counts_json TEXT NOT NULL DEFAULT '{}',
              active_activity_details_json TEXT NOT NULL DEFAULT '[]',
              active_activity_details_total INTEGER NOT NULL DEFAULT 0,
              active_activity_details_truncated INTEGER NOT NULL DEFAULT 0,
              activity_duration_summary_json TEXT NOT NULL DEFAULT '{}',
              task_queue_observation_json TEXT,
              heartbeat_schema_version INTEGER NOT NULL DEFAULT 2
            );
CREATE TABLE role_match_feedback_suggestions (
      tenant_id       TEXT NOT NULL DEFAULT 'local',
      suggestion_id   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      rule_kind       TEXT NOT NULL,
      title_pattern   TEXT NOT NULL,
      title_display   TEXT NOT NULL,
      reason_code     TEXT NOT NULL,
      reason          TEXT NOT NULL,
      sample_count    INTEGER NOT NULL DEFAULT 0,
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_json   TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      decided_at      TEXT,
      decision_reason TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    );
CREATE TABLE resume_review_drafts (
      tenant_id                    TEXT NOT NULL DEFAULT 'local',
      draft_id                     TEXT NOT NULL,
      job_id                       TEXT NOT NULL,
      base_generation              INTEGER NOT NULL,
      base_resume_text_artifact_id TEXT,
      base_resume_pdf_artifact_id  TEXT,
      renderer_format              TEXT NOT NULL DEFAULT 'unknown',
      state                        TEXT NOT NULL DEFAULT 'active',
      current_revision_id          TEXT,
      latest_revision_number       INTEGER NOT NULL DEFAULT 0,
      created_at                   TEXT NOT NULL,
      updated_at                   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, draft_id),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
CREATE TABLE resume_review_draft_revisions (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      revision_id         TEXT NOT NULL,
      draft_id            TEXT NOT NULL,
      job_id              TEXT NOT NULL,
      revision_number     INTEGER NOT NULL,
      plate_document_json TEXT,
      edited_text         TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      PRIMARY KEY (tenant_id, revision_id),
      UNIQUE (tenant_id, draft_id, revision_number),
      FOREIGN KEY (tenant_id, draft_id)
        REFERENCES resume_review_drafts(tenant_id, draft_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
CREATE TABLE resume_review_edit_deltas (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      delta_id         TEXT NOT NULL,
      revision_id      TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_id           TEXT NOT NULL,
      kind             TEXT NOT NULL,
      section          TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      before_text      TEXT NOT NULL DEFAULT '',
      after_text       TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, delta_id),
      FOREIGN KEY (tenant_id, revision_id)
        REFERENCES resume_review_draft_revisions(tenant_id, revision_id)
        ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, draft_id)
        REFERENCES resume_review_drafts(tenant_id, draft_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
CREATE TABLE resume_review_comment_threads (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      thread_id        TEXT NOT NULL,
      draft_id         TEXT NOT NULL,
      job_id           TEXT NOT NULL,
      base_artifact_id TEXT,
      semantic_id      TEXT,
      line_anchor_json TEXT,
      source_pin_id    TEXT,
      risk_label       TEXT,
      comment_body     TEXT NOT NULL DEFAULT '',
      lifecycle_state  TEXT NOT NULL DEFAULT 'open',
      anchor_resolved  INTEGER NOT NULL DEFAULT 1,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, draft_id)
        REFERENCES resume_review_drafts(tenant_id, draft_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
CREATE TABLE resume_review_comment_replies (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      reply_id          TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      draft_revision_id TEXT,
      author            TEXT NOT NULL DEFAULT 'user',
      decision          TEXT NOT NULL,
      body              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (tenant_id, reply_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES resume_review_comment_threads(tenant_id, thread_id)
        ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, draft_revision_id)
        REFERENCES resume_review_draft_revisions(tenant_id, revision_id)
        ON DELETE CASCADE
    );
CREATE TABLE tailoring_feedback_signal_reviews (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      review_id        TEXT NOT NULL,
      signal_id        TEXT NOT NULL,
      revision         INTEGER NOT NULL CHECK(revision > 0),
      decision         TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
      signal_kind      TEXT NOT NULL CHECK(signal_kind IN (
        'style_preference',
        'factual_correction',
        'claim_policy_correction',
        'keyword_strategy',
        'provenance_dispute'
      )),
      rule_key         TEXT,
      rule_value       TEXT,
      allowlist_version INTEGER NOT NULL CHECK(allowlist_version > 0),
      reviewed_at      TEXT NOT NULL,
      PRIMARY KEY (tenant_id, review_id),
      UNIQUE (tenant_id, signal_id, revision),
      CHECK (
        (decision = 'accepted'
          AND rule_key IS NOT NULL
          AND length(rule_key) BETWEEN 1 AND 80
          AND rule_key NOT GLOB '*[^a-z0-9_]*'
          AND rule_value IS NOT NULL
          AND length(rule_value) BETWEEN 1 AND 160
          AND rule_value NOT GLOB '*[^a-z0-9_]*')
        OR
        (decision = 'rejected' AND rule_key IS NULL AND rule_value IS NULL)
      )
    );
CREATE TRIGGER validate_tailoring_feedback_signal_review_source
BEFORE INSERT ON tailoring_feedback_signal_reviews
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM tailoring_feedback_signals
    WHERE tenant_id = NEW.tenant_id
      AND signal_id = NEW.signal_id
      AND signal_kind = NEW.signal_kind
  ) THEN RAISE(ABORT, 'tailoring feedback review source mismatch') END;
END;
CREATE TRIGGER prevent_tailoring_feedback_signal_review_update
BEFORE UPDATE ON tailoring_feedback_signal_reviews
BEGIN
  SELECT RAISE(ABORT, 'tailoring feedback reviews are append-only');
END;
CREATE TRIGGER prevent_tailoring_feedback_signal_review_delete
BEFORE DELETE ON tailoring_feedback_signal_reviews
BEGIN
  SELECT RAISE(ABORT, 'tailoring feedback reviews are append-only');
END;
CREATE TABLE tailoring_feedback_signals (
      tenant_id         TEXT NOT NULL DEFAULT 'local',
      signal_id         TEXT NOT NULL,
      job_id            TEXT NOT NULL,
      draft_id          TEXT NOT NULL,
      draft_revision_id TEXT,
      source_kind       TEXT NOT NULL,
      source_id         TEXT NOT NULL,
      signal_kind       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'candidate',
      summary           TEXT NOT NULL DEFAULT '',
      section           TEXT,
      semantic_id       TEXT,
      created_at        TEXT NOT NULL,
      reviewed_at       TEXT,
      PRIMARY KEY (tenant_id, signal_id),
      FOREIGN KEY (tenant_id, draft_id)
        REFERENCES resume_review_drafts(tenant_id, draft_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, draft_revision_id)
        REFERENCES resume_review_draft_revisions(tenant_id, revision_id)
        ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
CREATE INDEX idx_application_email_evidence_job
            ON application_email_evidence(
                tenant_id,
                job_id,
                received_at DESC
            )
            ;
CREATE INDEX idx_application_outcome_suggestions_job
            ON application_outcome_suggestions(
                tenant_id,
                job_id,
                status,
                created_at DESC
            )
            ;
CREATE INDEX idx_application_outcome_suggestions_status
            ON application_outcome_suggestions(
                tenant_id,
                status,
                created_at DESC
            )
            ;
CREATE INDEX idx_application_outcomes_job
            ON application_outcomes(
                tenant_id,
                job_id,
                occurred_at DESC,
                recorded_at DESC
            )
            ;
CREATE INDEX idx_application_repeat_audit_target
            ON application_repeat_audit(
                tenant_id,
                target_job_id,
                occurred_at DESC
            )
            ;
CREATE INDEX idx_application_repeat_overrides_prior
            ON application_repeat_overrides(
                tenant_id,
                prior_job_id,
                confirmed_at DESC
            )
            ;
CREATE INDEX idx_application_repeat_overrides_target
            ON application_repeat_overrides(
                tenant_id,
                target_job_id,
                confirmed_at DESC
            )
            ;
CREATE INDEX idx_application_review_decisions_job
        ON application_review_decisions(
            tenant_id,
            job_id,
            decided_at DESC
        )
        ;
CREATE INDEX idx_artifact_list_projections_job
        ON artifact_list_projections(tenant_id, job_id)
        ;
CREATE INDEX idx_candidate_profile_education_order
        ON candidate_profile_education_entries(tenant_id, profile_id, position_index)
        ;
CREATE INDEX idx_candidate_profile_experience_order
        ON candidate_profile_experience_entries(tenant_id, profile_id, position_index)
        ;
CREATE INDEX idx_candidate_profile_skill_order
        ON candidate_profile_skill_categories(tenant_id, profile_id, position_index)
        ;
CREATE INDEX idx_contact_attributes_contact
        ON contact_attributes(tenant_id, contact_id)
    ;
CREATE INDEX idx_contact_candidates_task
        ON contact_candidates(tenant_id, task_id, status)
    ;
CREATE INDEX idx_contact_projections_lookup
        ON contact_projections(tenant_id, employer, job_id)
        ;
CREATE INDEX idx_contact_research_task_projections_lookup
        ON contact_research_task_projections(tenant_id, employer, job_id)
        ;
CREATE INDEX idx_contact_research_tasks_lookup
            ON contact_research_tasks(tenant_id, employer, job_id)
            ;
CREATE INDEX idx_contacts_lookup
            ON contacts(tenant_id, employer, job_id)
            ;
CREATE INDEX idx_discovery_execution_jobs_cohort
        ON discovery_execution_jobs(
            tenant_id, discover_workflow_id, discover_run_id, cohort_kind
        )
        ;
CREATE INDEX idx_discovery_execution_jobs_job
        ON discovery_execution_jobs(tenant_id, job_id, linked_at)
        ;
CREATE INDEX idx_discovery_execution_jobs_plan
        ON discovery_execution_jobs(
            tenant_id, discover_workflow_id, discover_run_id, work_plan_state
        )
        ;
CREATE INDEX idx_discovery_feedback_job
        ON discovery_feedback(tenant_id, job_id, recorded_at)
        ;
CREATE INDEX idx_discovery_quarantine_status
        ON discovery_quarantine_entries(
            tenant_id,
            status,
            captured_at
        )
        ;
CREATE INDEX idx_discovery_runs_started
        ON discovery_runs(tenant_id, started_at DESC)
        ;
CREATE INDEX idx_discovery_runs_status
        ON discovery_runs(tenant_id, status, started_at DESC)
        ;
CREATE INDEX idx_discovery_search_unit_jobs_execution
        ON discovery_search_unit_jobs(
            tenant_id, discover_workflow_id, discover_run_id, was_new
        )
        ;
CREATE INDEX idx_discovery_search_units_state
        ON discovery_search_units(
            tenant_id, discover_workflow_id, discover_run_id, state, ordinal
        )
        ;
CREATE INDEX idx_due_follow_up_projections_due
        ON due_follow_up_projections(tenant_id, due_at)
        ;
CREATE INDEX idx_evidence_usage_projection_evidence
        ON evidence_usage_projections(tenant_id, evidence_id)
        ;
CREATE INDEX idx_evidence_usage_projection_skill
        ON evidence_usage_projections(tenant_id, skill_id)
        ;
CREATE INDEX idx_job_artifacts_job_stage
        ON job_artifacts(tenant_id, job_id, stage, status)
        ;
CREATE UNIQUE INDEX idx_job_artifacts_registry_key
        ON job_artifacts(
            tenant_id, job_id, stage, artifact_type, path
        )
        ;
CREATE INDEX idx_job_bullet_provenance_artifact
        ON job_bullet_provenance(tenant_id, artifact_id)
        ;
CREATE INDEX idx_job_bullet_provenance_tenant_job_gen
        ON job_bullet_provenance(tenant_id, job_id, generation DESC)
        ;
CREATE INDEX idx_job_canonical_identities_canonical_url
        ON job_canonical_identities(tenant_id, canonical_url)
        ;
CREATE INDEX idx_job_duplicate_links_surviving
        ON job_duplicate_links(tenant_id, surviving_job_id)
        ;
CREATE INDEX idx_job_employer_analysis_cache_key
        ON job_employer_analysis(tenant_id, job_id, cache_key)
        ;
CREATE INDEX idx_job_employer_analysis_tenant_job_gen
        ON job_employer_analysis(tenant_id, job_id, generation DESC)
        ;
CREATE INDEX idx_job_enrichments_enriched_at
        ON job_enrichments(enriched_at DESC)
        ;
CREATE INDEX idx_job_enrichments_tenant_status
        ON job_enrichments(tenant_id, current_status, updated_at DESC)
        ;
CREATE INDEX idx_job_events_entity
        ON job_events(
            tenant_id,
            entity_kind,
            entity_ref,
            occurred_at DESC,
            event_id DESC
        )
        ;
CREATE UNIQUE INDEX idx_job_events_idempotency_key
        ON job_events(idempotency_key)
        WHERE idempotency_key IS NOT NULL
        ;
CREATE INDEX idx_job_events_job_time
        ON job_events(
            tenant_id,
            job_id,
            occurred_at DESC,
            event_id DESC
        )
        ;
CREATE INDEX idx_job_events_stage_time
        ON job_events(
            tenant_id,
            stage,
            occurred_at DESC,
            event_id DESC
        )
        ;
CREATE INDEX idx_job_events_tenant_eid
        ON job_events(tenant_id, event_id)
        ;
CREATE INDEX idx_job_interview_prep_items_tenant_kind
        ON job_interview_prep_items(tenant_id, kind, position)
        ;
CREATE INDEX idx_job_interview_prep_origin_run
        ON job_interview_prep(
            tenant_id, job_id, origin_run_id
        )
        ;
CREATE INDEX idx_job_interview_prep_tenant_job_gen
        ON job_interview_prep(
            tenant_id, job_id, generation DESC
        )
        ;
CREATE INDEX idx_job_interview_prep_tenant_status
        ON job_interview_prep(tenant_id, status, generated_at DESC)
        ;
CREATE INDEX idx_job_list_projections_stage_state
        ON job_list_projections(tenant_id, current_stage, current_state)
        ;
CREATE UNIQUE INDEX idx_job_locators_current ON job_locators(tenant_id, job_id, locator_kind) WHERE is_current = 1;
CREATE INDEX idx_job_market_compensation_company_role
        ON job_market_compensation_estimates (
            tenant_id,
            normalized_company,
            normalized_role
        )
        ;
CREATE INDEX idx_job_market_compensation_state
        ON job_market_compensation_estimates (tenant_id, estimate_state)
        ;
CREATE INDEX idx_job_material_layout_boxes_artifact
        ON job_material_layout_boxes(
            tenant_id, artifact_id, page_number, box_index
        )
        ;
CREATE INDEX idx_job_materials_artifacts_status
        ON job_materials_artifacts(
            artifact_type, status, created_at DESC
        )
        ;
CREATE INDEX idx_job_materials_tenant_job_gen
        ON job_materials(tenant_id, job_id, generation DESC)
        ;
CREATE INDEX idx_job_posted_compensation_parse_state
        ON job_posted_compensation_facts (tenant_id, parse_state)
        ;
CREATE INDEX idx_job_resume_template_assignments_template
        ON job_resume_template_assignments(
            tenant_id, template_id, version_id
        )
        ;
CREATE INDEX idx_job_score_keywords_tenant_normalized
        ON job_score_keywords(
            tenant_id, normalized_keyword, job_id, score_version
        )
        ;
CREATE INDEX idx_job_score_staleness_job
        ON job_score_staleness(tenant_id, job_id, resolved)
        ;
CREATE INDEX idx_job_score_staleness_unresolved
        ON job_score_staleness(tenant_id, resolved, marked_at DESC)
        ;
CREATE INDEX idx_job_scores_job_version
        ON job_scores(tenant_id, job_id, version DESC)
        ;
CREATE INDEX idx_job_scores_tenant_score
        ON job_scores(tenant_id, fit_score DESC, scored_at DESC)
        ;
CREATE INDEX idx_job_source_observations_job
        ON job_source_observations(tenant_id, job_id)
        ;
CREATE UNIQUE INDEX idx_job_source_observations_native
        ON job_source_observations(tenant_id, source_id, source_native_id)
        ;
CREATE UNIQUE INDEX idx_job_source_observations_normalized_url
        ON job_source_observations(tenant_id, normalized_observed_url)
        ;
CREATE INDEX idx_job_stage_states_job
        ON job_stage_states(tenant_id, job_id, stage)
        ;
CREATE INDEX idx_job_stage_states_stage_state
        ON job_stage_states(stage, state, updated_at DESC)
        ;
CREATE UNIQUE INDEX idx_jobs_tenant_job_id ON jobs(tenant_id, job_id);
CREATE UNIQUE INDEX idx_jobs_tenant_url ON jobs(tenant_id, url);
CREATE INDEX idx_manual_capture_queue_job
        ON manual_capture_queue(tenant_id, job_id, status)
        ;
CREATE INDEX idx_operational_attempt_metrics_source_time ON operational_attempt_metrics(tenant_id, source_id, occurred_at DESC, metric_id DESC);
CREATE INDEX idx_operational_attempt_metrics_stage_time ON operational_attempt_metrics(tenant_id, stage, occurred_at DESC, metric_id DESC);
CREATE INDEX idx_outreach_drafts_thread
        ON outreach_drafts(tenant_id, thread_id, generation DESC)
    ;
CREATE INDEX idx_outreach_send_logs_thread
        ON outreach_send_logs(tenant_id, thread_id)
    ;
CREATE INDEX idx_outreach_thread_projections_lookup
        ON outreach_thread_projections(tenant_id, contact_id, job_id)
        ;
CREATE INDEX idx_outreach_threads_contact
        ON outreach_threads(tenant_id, contact_id, job_id)
        ;
CREATE INDEX idx_pipeline_step_projections_execution
        ON pipeline_step_projections(
            tenant_id, discover_workflow_id, discover_run_id, step_kind, state
        )
        ;
CREATE INDEX idx_pipeline_step_projections_updated
        ON pipeline_step_projections(tenant_id, last_updated_at DESC, last_event_id DESC)
        ;
CREATE INDEX idx_posting_snapshot_sets_updated
        ON posting_snapshot_sets(tenant_id, updated_at DESC)
        ;
CREATE INDEX idx_preparation_work_items_claim
        ON preparation_work_items(tenant_id, state, kind, available_at)
        ;
CREATE UNIQUE INDEX idx_preparation_work_items_idempotency
        ON preparation_work_items(tenant_id, idempotency_key)
        ;
CREATE INDEX idx_preparation_work_items_job_target
        ON preparation_work_items(tenant_id, job_id, kind, target_version)
        ;
CREATE INDEX idx_requirement_fit_items_requirement
        ON job_requirement_fit_items(tenant_id, requirement_id)
        ;
CREATE INDEX idx_requirement_fit_reports_tenant_job
        ON job_requirement_fit_reports(
            tenant_id, job_id, score_version DESC
        )
        ;
CREATE INDEX idx_resume_review_comment_replies_thread
      ON resume_review_comment_replies(tenant_id, thread_id, created_at ASC);
CREATE INDEX idx_resume_review_comment_threads_draft
      ON resume_review_comment_threads(tenant_id, draft_id, updated_at DESC);
CREATE INDEX idx_resume_review_drafts_job
      ON resume_review_drafts(tenant_id, job_id, state, updated_at DESC);
CREATE INDEX idx_resume_review_edit_deltas_revision
      ON resume_review_edit_deltas(tenant_id, revision_id);
CREATE INDEX idx_resume_review_revisions_draft
      ON resume_review_draft_revisions(tenant_id, draft_id, revision_number DESC);
CREATE INDEX idx_resume_template_refresh_attempts_job
        ON resume_template_refresh_attempts(
            tenant_id, job_id, created_at DESC
        )
        ;
CREATE INDEX idx_resume_template_versions_template
        ON resume_template_versions(tenant_id, template_id, version_number DESC)
        ;
CREATE INDEX idx_scoring_policies_current
        ON scoring_policies(tenant_id, version DESC)
        ;
CREATE INDEX idx_tailoring_policies_current
        ON tailoring_policies(tenant_id, version DESC)
        ;
CREATE INDEX idx_tailoring_feedback_signals_draft
      ON tailoring_feedback_signals(tenant_id, draft_id, created_at DESC);
CREATE INDEX idx_tailoring_feedback_signals_job
      ON tailoring_feedback_signals(tenant_id, job_id, created_at DESC);
CREATE INDEX idx_tailoring_feedback_signal_reviews_signal
      ON tailoring_feedback_signal_reviews(tenant_id, signal_id, revision DESC);
CREATE INDEX idx_tailoring_feedback_signal_reviews_decision
      ON tailoring_feedback_signal_reviews(tenant_id, decision, reviewed_at DESC);
CREATE INDEX idx_workflow_run_projections_tenant_started
        ON workflow_run_projections(tenant_id, started_at DESC, workflow_id DESC)
        ;
