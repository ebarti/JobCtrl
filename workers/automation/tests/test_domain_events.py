"""Unit tests for domain events: construction, required fields, tenantId."""

from __future__ import annotations

from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.domain.events.base import create_domain_event
from jobhunter.domain.events.discovery import (
    JobDiscoveredPayload,
    create_job_discovered,
    JobUpdatedPayload,
    create_job_updated,
    JobDeletedPayload,
    create_job_deleted,
    JobRestoredPayload,
    create_job_restored,
    SourceLocationCandidateDiscoveredPayload,
    create_source_location_candidate_discovered,
    SourceLocationCandidatePromotedPayload,
    create_source_location_candidate_promoted,
    SourceRegistryEntryCreatedPayload,
    create_source_registry_entry_created,
    SourceRegistryEntryUpdatedPayload,
    create_source_registry_entry_updated,
    SourceStateChangedPayload,
    create_source_state_changed,
    DiscoveryRunStartedPayload,
    create_discovery_run_started,
    DiscoveryRunCountsPayload,
    DiscoveryRunCompletedPayload,
    create_discovery_run_completed,
    DiscoveryRunFailedPayload,
    create_discovery_run_failed,
    DiscoveryFeedbackRecordedPayload,
    create_discovery_feedback_recorded,
)
from jobhunter.domain.events.enrichment import (
    JobEnrichedPayload,
    create_job_enriched,
    EnrichmentFailedPayload,
    create_enrichment_failed,
)
from jobhunter.domain.events.scoring import (
    JobScoredPayload,
    create_job_scored,
    ScoreCorrectedPayload,
    create_score_corrected,
)
from jobhunter.domain.events.materials import (
    ResumeApprovedPayload,
    create_resume_approved,
    ResumeFailedPayload,
    create_resume_failed,
    CoverLetterGeneratedPayload,
    create_cover_letter_generated,
    PdfRenderedPayload,
    create_pdf_rendered,
    MaterialsExhaustedPayload,
    create_materials_exhausted,
)
from jobhunter.domain.events.interview import (
    InterviewPrepFailedPayload,
    InterviewPrepGeneratedPayload,
    create_interview_prep_failed,
    create_interview_prep_generated,
)
from jobhunter.domain.events.apply import (
    ApplicationSubmittedPayload,
    create_application_submitted,
    ApplicationFailedPayload,
    create_application_failed,
    ApplyRunStartedPayload,
    create_apply_run_started,
    ApplyRunEventRecordedPayload,
    create_apply_run_event_recorded,
)
from jobhunter.domain.events.orchestration import (
    StageStartedPayload,
    create_stage_started,
    StageCompletedPayload,
    create_stage_completed,
    StageFailedPayload,
    create_stage_failed,
    StageExhaustedPayload,
    create_stage_exhausted,
    StageResetPayload,
    create_stage_reset,
    StageBlockedPayload,
    create_stage_blocked,
    StageSkippedPayload,
    create_stage_skipped,
)
from jobhunter.domain.events.profile import (
    ProfileUpdatedPayload,
    create_profile_updated,
    ProfileImportedPayload,
    create_profile_imported,
)


class TestDomainEventBase:
    def test_create_domain_event_sets_envelope(self) -> None:
        event = create_domain_event("TestEvent", LOCAL_TENANT, {"foo": "bar"})
        assert event.event_type == "TestEvent"
        assert event.tenant_id == "local"
        assert event.occurred_at  # non-empty
        assert event.payload == {"foo": "bar"}

    def test_frozen(self) -> None:
        event = create_domain_event("X", LOCAL_TENANT)
        try:
            event.event_type = "Y"  # type: ignore[misc]
            assert False, "Should have raised"
        except AttributeError:
            pass

    def test_custom_occurred_at(self) -> None:
        ts = "2025-01-01T12:00:00Z"
        event = create_domain_event("X", LOCAL_TENANT, occurred_at=ts)
        assert event.occurred_at == ts


class TestDiscoveryEvents:
    def test_job_discovered(self) -> None:
        event = create_job_discovered(
            LOCAL_TENANT,
            JobDiscoveredPayload(
                job_id="j1",
                posting_url="https://example.com/job",
                source="linkedin",
                employer="Acme",
                discovered_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "JobDiscovered"
        assert event.tenant_id == "local"
        assert event.payload["job_id"] == "j1"

    def test_job_updated(self) -> None:
        event = create_job_updated(
            LOCAL_TENANT,
            JobUpdatedPayload(job_id="j1", changed_fields={"title": "New Title"}),
        )
        assert event.event_type == "JobUpdated"

    def test_job_deleted(self) -> None:
        event = create_job_deleted(
            LOCAL_TENANT,
            JobDeletedPayload(job_id="j1", reason="not interested", deleted_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "JobDeleted"

    def test_job_restored(self) -> None:
        event = create_job_restored(
            LOCAL_TENANT,
            JobRestoredPayload(job_id="j1", restored_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "JobRestored"

    def test_source_location_candidate_discovered(self) -> None:
        event = create_source_location_candidate_discovered(
            LOCAL_TENANT,
            SourceLocationCandidateDiscoveredPayload(
                candidate_id="candidate-1",
                candidate_url="https://example.com/careers",
                source_kind="employer_careers_page",
                confidence=0.82,
                evidence_ref="evidence:candidate-1",
                discovered_at="2026-05-12T00:00:00Z",
            ),
        )
        assert event.event_type == "SourceLocationCandidateDiscovered"
        assert event.payload["source_kind"] == "employer_careers_page"

    def test_source_registry_events(self) -> None:
        created = create_source_registry_entry_created(
            LOCAL_TENANT,
            SourceRegistryEntryCreatedPayload(
                source_id="smart_extract:remoteok",
                kind="smart_extract",
                policy_id="smart_extract_experimental",
                state="experimental",
                created_at="2026-05-12T00:00:00Z",
            ),
        )
        updated = create_source_registry_entry_updated(
            LOCAL_TENANT,
            SourceRegistryEntryUpdatedPayload(
                source_id="smart_extract:remoteok",
                changed_fields=("state",),
                updated_at="2026-05-12T00:00:00Z",
            ),
        )
        changed = create_source_state_changed(
            LOCAL_TENANT,
            SourceStateChangedPayload(
                source_id="smart_extract:remoteok",
                from_state="experimental",
                to_state="active",
                reason="validated",
                changed_at="2026-05-12T00:00:00Z",
            ),
        )
        promoted = create_source_location_candidate_promoted(
            LOCAL_TENANT,
            SourceLocationCandidatePromotedPayload(
                candidate_id="candidate-1",
                source_id="smart_extract:remoteok",
                promoted_at="2026-05-12T00:00:00Z",
            ),
        )
        assert created.event_type == "SourceRegistryEntryCreated"
        assert updated.event_type == "SourceRegistryEntryUpdated"
        assert changed.event_type == "SourceStateChanged"
        assert promoted.event_type == "SourceLocationCandidatePromoted"

    def test_discovery_run_events(self) -> None:
        started = create_discovery_run_started(
            LOCAL_TENANT,
            DiscoveryRunStartedPayload(
                run_id="run-1",
                source_ids=("greenhouse:acme",),
                profile_snapshot_id="profile:1",
                started_at="2026-05-13T00:00:00Z",
            ),
        )
        completed = create_discovery_run_completed(
            LOCAL_TENANT,
            DiscoveryRunCompletedPayload(
                run_id="run-1",
                counts=DiscoveryRunCountsPayload(total=2, new_jobs=1, existing_jobs=1),
                error_classes=(),
                completed_at="2026-05-13T00:01:00Z",
            ),
        )
        failed = create_discovery_run_failed(
            LOCAL_TENANT,
            DiscoveryRunFailedPayload(
                run_id="run-2",
                source_id="greenhouse:acme",
                error_class="TimeoutError",
                retryable=True,
                failed_at="2026-05-13T00:02:00Z",
            ),
        )
        assert started.event_type == "DiscoveryRunStarted"
        assert completed.payload["counts"]["new_jobs"] == 1
        assert failed.payload["error_class"] == "TimeoutError"

    def test_discovery_feedback_recorded(self) -> None:
        event = create_discovery_feedback_recorded(
            LOCAL_TENANT,
            DiscoveryFeedbackRecordedPayload(
                feedback_id="feedback-1",
                job_id="job-1",
                source_id="greenhouse:acme",
                kind="bad_source",
                recorded_at="2026-05-13T00:03:00Z",
            ),
        )
        assert event.event_type == "DiscoveryFeedbackRecorded"
        assert event.payload["kind"] == "bad_source"


class TestEnrichmentEvents:
    def test_job_enriched(self) -> None:
        event = create_job_enriched(
            LOCAL_TENANT,
            JobEnrichedPayload(
                job_id="j1",
                full_description="Full desc",
                application_url="https://apply.example.com",
                extraction_tier="json_ld",
                enriched_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "JobEnriched"
        assert event.tenant_id == "local"

    def test_enrichment_failed(self) -> None:
        event = create_enrichment_failed(
            LOCAL_TENANT,
            EnrichmentFailedPayload(job_id="j1", error="timeout", attempt_number=2),
        )
        assert event.event_type == "EnrichmentFailed"


class TestScoringEvents:
    def test_job_scored(self) -> None:
        event = create_job_scored(
            LOCAL_TENANT,
            JobScoredPayload(
                job_id="j1",
                fit_score=8,
                breakdown={"technical_fit": 9},
                keywords=("python", "react"),
                version=1,
                scored_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "JobScored"
        assert event.payload["fit_score"] == 8

    def test_score_corrected(self) -> None:
        event = create_score_corrected(
            LOCAL_TENANT,
            ScoreCorrectedPayload(
                job_id="j1",
                original_score=5,
                corrected_score=8,
                reason="underrated",
                corrected_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "ScoreCorrected"


class TestMaterialsEvents:
    def test_resume_approved(self) -> None:
        event = create_resume_approved(
            LOCAL_TENANT,
            ResumeApprovedPayload(job_id="j1", artifact_id="a1", generation=1, approved_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "ResumeApproved"
        assert event.tenant_id == "local"

    def test_resume_failed(self) -> None:
        event = create_resume_failed(
            LOCAL_TENANT,
            ResumeFailedPayload(job_id="j1", validation_errors=("banned word",), attempt_number=1),
        )
        assert event.event_type == "ResumeFailed"

    def test_cover_letter_generated(self) -> None:
        event = create_cover_letter_generated(
            LOCAL_TENANT,
            CoverLetterGeneratedPayload(job_id="j1", artifact_id="a2", generated_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "CoverLetterGenerated"

    def test_pdf_rendered(self) -> None:
        event = create_pdf_rendered(
            LOCAL_TENANT,
            PdfRenderedPayload(
                job_id="j1", artifact_type="resume_pdf", artifact_id="a3", rendered_at="2025-01-01T00:00:00Z"
            ),
        )
        assert event.event_type == "PdfRendered"

    def test_materials_exhausted(self) -> None:
        event = create_materials_exhausted(
            LOCAL_TENANT,
            MaterialsExhaustedPayload(job_id="j1", stage="tailor", attempt_count=3, max_attempts=3),
        )
        assert event.event_type == "MaterialsExhausted"


class TestInterviewEvents:
    def test_interview_prep_generated(self) -> None:
        event = create_interview_prep_generated(
            LOCAL_TENANT,
            InterviewPrepGeneratedPayload(
                job_id="https://example.test/job/1",
                generation=1,
                item_count=3,
                generated_at="2026-07-05T12:00:00Z",
            ),
        )
        assert event.event_type == "InterviewPrepGenerated"
        assert event.tenant_id == "local"
        assert event.payload["generation"] == 1
        assert event.payload["item_count"] == 3

    def test_interview_prep_failed(self) -> None:
        event = create_interview_prep_failed(
            LOCAL_TENANT,
            InterviewPrepFailedPayload(
                job_id="https://example.test/job/1",
                generation=2,
                failed_at="2026-07-05T12:10:00Z",
                reason_count=1,
            ),
        )
        assert event.event_type == "InterviewPrepFailed"
        assert event.tenant_id == "local"
        assert event.payload["generation"] == 2
        assert event.payload["reason_count"] == 1


class TestApplyEvents:
    def test_application_submitted(self) -> None:
        event = create_application_submitted(
            LOCAL_TENANT,
            ApplicationSubmittedPayload(
                job_id="j1",
                run_id="r1",
                applied_at="2025-01-01T00:00:00Z",
                verification_confidence=0.95,
            ),
        )
        assert event.event_type == "ApplicationSubmitted"
        assert event.tenant_id == "local"

    def test_application_failed(self) -> None:
        event = create_application_failed(
            LOCAL_TENANT,
            ApplicationFailedPayload(job_id="j1", run_id="r1", result={"error": "timeout"}, attempt_number=1),
        )
        assert event.event_type == "ApplicationFailed"

    def test_apply_run_started(self) -> None:
        event = create_apply_run_started(
            LOCAL_TENANT,
            ApplyRunStartedPayload(
                job_id="j1",
                run_id="r1",
                worker_id="w1",
                model="haiku",
                dry_run=False,
                started_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "ApplyRunStarted"

    def test_apply_run_event_recorded(self) -> None:
        event = create_apply_run_event_recorded(
            LOCAL_TENANT,
            ApplyRunEventRecordedPayload(run_id="r1", event={"type": "page_loaded"}),
        )
        assert event.event_type == "ApplyRunEventRecorded"


class TestOrchestrationEvents:
    def test_stage_started(self) -> None:
        event = create_stage_started(
            LOCAL_TENANT,
            StageStartedPayload(job_id="j1", stage="enrich", attempt_number=1, started_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "StageStarted"
        assert event.tenant_id == "local"

    def test_stage_completed(self) -> None:
        event = create_stage_completed(
            LOCAL_TENANT,
            StageCompletedPayload(
                job_id="j1", stage="score", finished_at="2025-01-01T00:00:00Z", duration_ms=5000
            ),
        )
        assert event.event_type == "StageCompleted"

    def test_stage_failed(self) -> None:
        event = create_stage_failed(
            LOCAL_TENANT,
            StageFailedPayload(
                job_id="j1",
                stage="enrich",
                error_code="TIMEOUT",
                error_message="timed out",
                retryable=True,
                attempt_number=1,
            ),
        )
        assert event.event_type == "StageFailed"

    def test_stage_exhausted(self) -> None:
        event = create_stage_exhausted(
            LOCAL_TENANT,
            StageExhaustedPayload(job_id="j1", stage="tailor", attempt_count=3, max_attempts=3),
        )
        assert event.event_type == "StageExhausted"

    def test_stage_reset(self) -> None:
        event = create_stage_reset(
            LOCAL_TENANT,
            StageResetPayload(
                job_id="j1", stage="score", reset_attempts=True, reset_at="2025-01-01T00:00:00Z"
            ),
        )
        assert event.event_type == "StageReset"

    def test_stage_blocked(self) -> None:
        event = create_stage_blocked(
            LOCAL_TENANT,
            StageBlockedPayload(job_id="j1", stage="score", blocked_by=("enrich",)),
        )
        assert event.event_type == "StageBlocked"

    def test_stage_skipped(self) -> None:
        event = create_stage_skipped(
            LOCAL_TENANT,
            StageSkippedPayload(job_id="j1", stage="apply", reason="below threshold"),
        )
        assert event.event_type == "StageSkipped"


class TestProfileEvents:
    def test_profile_updated(self) -> None:
        event = create_profile_updated(
            LOCAL_TENANT,
            ProfileUpdatedPayload(changed_sections=("experience", "skills"), updated_at="2025-01-01T00:00:00Z"),
        )
        assert event.event_type == "ProfileUpdated"
        assert event.tenant_id == "local"

    def test_profile_imported(self) -> None:
        event = create_profile_imported(
            LOCAL_TENANT,
            ProfileImportedPayload(
                source="resume.pdf",
                imported_sections=("experience", "education"),
                imported_at="2025-01-01T00:00:00Z",
            ),
        )
        assert event.event_type == "ProfileImported"


class TestAllEventsCarryTenantId:
    """Verify every event factory produces events with tenant_id set."""

    def test_all_events_have_tenant_id(self) -> None:
        events = [
            create_job_discovered(
                LOCAL_TENANT,
                JobDiscoveredPayload(
                    job_id="j", posting_url="u", source="s", employer="e", discovered_at="t"
                ),
            ),
            create_source_registry_entry_created(
                LOCAL_TENANT,
                SourceRegistryEntryCreatedPayload(
                    source_id="source-1",
                    kind="smart_extract",
                    policy_id="smart_extract_experimental",
                    state="experimental",
                    created_at="t",
                ),
            ),
            create_job_enriched(
                LOCAL_TENANT,
                JobEnrichedPayload(
                    job_id="j", full_description="d", application_url="u", extraction_tier="t", enriched_at="t"
                ),
            ),
            create_job_scored(
                LOCAL_TENANT,
                JobScoredPayload(job_id="j", fit_score=5, scored_at="t"),
            ),
            create_resume_approved(
                LOCAL_TENANT,
                ResumeApprovedPayload(job_id="j", artifact_id="a", generation=1, approved_at="t"),
            ),
            create_application_submitted(
                LOCAL_TENANT,
                ApplicationSubmittedPayload(job_id="j", run_id="r", applied_at="t", verification_confidence=0.9),
            ),
            create_stage_started(
                LOCAL_TENANT,
                StageStartedPayload(job_id="j", stage="enrich", attempt_number=1, started_at="t"),
            ),
            create_profile_updated(
                LOCAL_TENANT,
                ProfileUpdatedPayload(changed_sections=(), updated_at="t"),
            ),
        ]
        for event in events:
            assert event.tenant_id == "local", f"{event.event_type} missing tenant_id"
