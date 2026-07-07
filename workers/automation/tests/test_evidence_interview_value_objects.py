from __future__ import annotations

import pytest

from jobctrl.domain.interview import (
    INTERVIEW_PREP_STATUSES,
    InterviewPrep,
    InterviewPrepGateAudit,
    InterviewPrepItem,
)
from jobctrl.domain.operations import (
    EvidenceFreshness,
    EvidenceGap,
    EvidenceMapEntry,
    EvidenceReusableStory,
    EvidenceUsageRef,
)


def test_evidence_map_entry_round_trips_to_camel_case_read_model() -> None:
    resume_usage = EvidenceUsageRef(
        kind="resume_bullet",
        job_key="job-1",
        job_title="Staff Engineer",
        employer="Acme",
        artifact_id="artifact-1",
        bullet_id="experience-0",
        generation=2,
        generated_text_preview="Led the platform migration.",
        occurred_at="2026-07-05T12:00:00Z",
    )
    requirement_usage = EvidenceUsageRef(
        kind="requirement_fit",
        job_key="job-2",
        score_version=3,
        requirement_id="req-1",
        requirement_text="Own distributed systems migrations",
        requirement_fit_kind="matched",
        artifact_coverage_state="covered",
    )
    gap = EvidenceGap(
        gap_id="gap-req-2",
        kind="missing_requirement",
        requirement_id="req-2",
        requirement_text="Kubernetes administration",
        reason="No profile evidence covers the requirement.",
        job_refs=(requirement_usage,),
    )
    entry = EvidenceMapEntry(
        entry_id="evidence-1",
        kind="achievement_evidence",
        evidence_id="evidence-1",
        title="Platform migration",
        story=EvidenceReusableStory(
            scope="Legacy platform",
            action="Led migration",
            outcome="Reduced incidents",
            metrics=("30%",),
        ),
        skills=("Python", "Postgres"),
        tags=("migration",),
        freshness=EvidenceFreshness(
            evidence_date_range="2024-2025",
            evidence_strength="verified",
            user_confirmed=True,
            claim_confidence=0.91,
            last_used_at="2026-07-05T12:00:00Z",
        ),
        resume_usages=(resume_usage,),
        requirement_usages=(requirement_usage,),
        gaps=(gap,),
    )

    read_model = entry.to_read_model()

    assert read_model["entryId"] == "evidence-1"
    assert read_model["freshness"]["userConfirmed"] is True
    assert read_model["resumeUsages"][0]["artifactId"] == "artifact-1"
    assert read_model["requirementUsages"][0]["requirementId"] == "req-1"
    assert read_model["gaps"][0]["jobRefs"][0]["jobKey"] == "job-2"
    assert EvidenceMapEntry.from_dict(read_model).to_read_model() == read_model


def test_interview_prep_round_trips_and_requires_grounded_star_evidence() -> None:
    prep = InterviewPrep(
        job_key="job-1",
        generation=1,
        status="accepted",
        generated_at="2026-07-05T12:00:00Z",
        model="test-model",
        gate_audit=InterviewPrepGateAudit(
            status="passed",
            fabrication_findings=(),
            grounding_findings=("star-1 grounded to evidence-1",),
            judge_verdict="pass",
        ),
        items=(
            InterviewPrepItem(
                item_id="star-1",
                kind="star_draft",
                title="Platform migration story",
                generated_text="Situation: legacy platform. Action: led migration. Result: fewer incidents.",
                evidence_ids=("evidence-1",),
                requirement_ids=("req-1",),
                source_text=("Led migration and reduced incidents.",),
                position=0,
            ),
        ),
    )

    read_model = prep.to_read_model()

    assert read_model["jobKey"] == "job-1"
    assert read_model["gateAudit"]["status"] == "passed"
    assert read_model["items"][0]["kind"] == "star_draft"
    assert read_model["items"][0]["evidenceIds"] == ["evidence-1"]
    assert InterviewPrep.from_dict(read_model).to_read_model() == read_model

    with pytest.raises(ValueError, match="star_draft"):
        InterviewPrepItem(
            item_id="star-2",
            kind="star_draft",
            title="Ungrounded story",
            generated_text="I led a platform migration.",
            evidence_ids=(),
            requirement_ids=("req-1",),
        )


def test_interview_prep_has_no_live_assistance_status() -> None:
    assert "live" not in INTERVIEW_PREP_STATUSES
    assert "in_session" not in INTERVIEW_PREP_STATUSES

    with pytest.raises(ValueError, match="unknown interview prep status"):
        InterviewPrep(
            job_key="job-1",
            generation=1,
            status="live",  # type: ignore[arg-type]
            generated_at="2026-07-05T12:00:00Z",
            gate_audit=InterviewPrepGateAudit(status="failed"),
            items=(),
        )
