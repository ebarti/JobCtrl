"""PR3 Enrichment event creators mirror the TypeScript event set."""

from __future__ import annotations

from jobctrl.domain.events import (
    ContentDuplicateCandidateDetectedPayload,
    JobActiveStateChangedPayload,
    PostingContentSnapshotCapturedPayload,
    PostingContentSnapshotFailedPayload,
    create_content_duplicate_candidate_detected,
    create_job_active_state_changed,
    create_posting_content_snapshot_captured,
    create_posting_content_snapshot_failed,
)
from jobctrl.domain.tenant import LOCAL_TENANT


NOW = "2026-05-13T00:00:00+00:00"


def test_pr3_python_event_names_match_typescript_union_names() -> None:
    events = [
        create_posting_content_snapshot_captured(
            LOCAL_TENANT,
            PostingContentSnapshotCapturedPayload(
                job_id="j1",
                snapshot_version=1,
                snapshot_ref="j1:1",
                source_id="greenhouse:acme",
                extraction_tier="json_ld",
                captured_at=NOW,
            ),
        ),
        create_posting_content_snapshot_failed(
            LOCAL_TENANT,
            PostingContentSnapshotFailedPayload(
                job_id="j1",
                source_id="greenhouse:acme",
                error_class="FETCH_ERROR",
                retryable=True,
                failed_at=NOW,
            ),
        ),
        create_job_active_state_changed(
            LOCAL_TENANT,
            JobActiveStateChangedPayload(
                job_id="j1",
                active_state="active",
                previous_state="unknown",
                verification_method="json_ld_valid_through",
                verified_at=NOW,
            ),
        ),
        create_content_duplicate_candidate_detected(
            LOCAL_TENANT,
            ContentDuplicateCandidateDetectedPayload(
                job_id="j1",
                candidate_job_id="j2",
                evidence=[
                    {
                        "kind": "description_hash_match",
                        "matched_value": "hash-1",
                        "confidence": 1.0,
                    }
                ],
                confidence=1.0,
                detected_at=NOW,
            ),
        ),
    ]

    assert [event.event_type for event in events] == [
        "PostingContentSnapshotCaptured",
        "PostingContentSnapshotFailed",
        "JobActiveStateChanged",
        "ContentDuplicateCandidateDetected",
    ]
    assert all(str(event.tenant_id) == "local" for event in events)
    assert events[0].payload["snapshot_ref"] == "j1:1"
    assert events[2].payload["verification_method"] == "json_ld_valid_through"
    assert events[3].payload["candidate_job_id"] == "j2"
