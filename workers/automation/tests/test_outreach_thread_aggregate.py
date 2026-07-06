"""OutreachThread aggregate invariants (R6 Phase 3).

Covers the headline invariants the aggregate is responsible for:

  * INV-1 — the aggregate CANNOT represent a "sent" state and exposes no send
    transport/transition of any kind.
  * INV-5 — a draft can only be approved when its persisted gates passed;
    re-drafting supersedes prior *candidate* drafts but the last *approved* draft
    stays readable until a replacement is approved; rejecting never destroys the
    last approved draft.
"""

from __future__ import annotations

import dataclasses

import pytest

from jobhunter.domain.contact.outreach import (
    OutreachDraft,
    OutreachDraftKind,
    OutreachThread,
)
from jobhunter.domain.contact.outreach_gates import DraftGateResults
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    JudgeVerdict,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT

_JUDGE_PASS = JudgeVerdict.passed(score=0.95, criterion_scores={"evidence_support": 1.0})


def _gates(*, passed: bool) -> DraftGateResults:
    if passed:
        return DraftGateResults(
            fabrications=(), validation=ValidationResult.success(), judge=_JUDGE_PASS
        )
    return DraftGateResults(
        fabrications=(
            {
                "section": "outreach[1]",
                "kind": "numeric",
                "token": "250%",
                "control": "never_fabricate_metrics",
                "generatedText": "I increased revenue by 250%.",
            },
        ),
        validation=ValidationResult.success(),
        judge=_JUDGE_PASS,
    )


def _draft(draft_id: str, generation: int, *, passed: bool = True, status=ArtifactStatus.CANDIDATE) -> OutreachDraft:
    return OutreachDraft(
        draft_id=draft_id,
        thread_id="thread-1",
        generation=generation,
        kind=OutreachDraftKind.INTRO_REQUEST,
        status=status,
        body_text=f"Hi Dana,\n\nBody {generation}.\n\nBest,\nSam",
        gate_results=_gates(passed=passed),
        created_at="2026-07-06T00:00:00Z",
    )


def _thread() -> OutreachThread:
    return OutreachThread.create(
        tenant_id=LOCAL_TENANT,
        thread_id="thread-1",
        contact_id="contact-1",
        job_id="https://job/1",
        created_at="2026-07-06T00:00:00Z",
    )


# --- INV-1: no sent state / no send transport ------------------------------


def test_thread_cannot_represent_a_sent_state() -> None:
    thread = _thread()
    field_names = {field.name for field in dataclasses.fields(thread)}
    assert "sent" not in field_names
    assert not any("sent" in name for name in field_names)
    # No send-shaped transition anywhere on the aggregate.
    for attr in dir(thread):
        assert "send" not in attr.lower(), f"unexpected send-shaped member: {attr}"


def test_draft_status_cannot_be_sent() -> None:
    draft_status_values = {s.value for s in (
        ArtifactStatus.CANDIDATE,
        ArtifactStatus.APPROVED,
        ArtifactStatus.REJECTED,
        ArtifactStatus.SUPERSEDED,
    )}
    assert "sent" not in draft_status_values
    for attr in dir(OutreachDraft):
        assert "send" not in attr.lower(), f"unexpected send-shaped member: {attr}"


# --- INV-5: approval gated on the persisted gate outcome --------------------


def test_approve_blocked_when_gates_failed() -> None:
    thread = _thread().add_draft(_draft("d1", 1, passed=False), at="t1")
    with pytest.raises(ValueError, match="gates did not pass"):
        thread.approve_draft("d1", approved_at="t2")


def test_cannot_construct_approved_draft_over_failed_gates() -> None:
    with pytest.raises(ValueError, match="passed"):
        _draft("d1", 1, passed=False, status=ArtifactStatus.APPROVED)


def test_approve_gated_draft_succeeds() -> None:
    thread = _thread().add_draft(_draft("d1", 1, passed=True), at="t1")
    approved = thread.approve_draft("d1", approved_at="t2")
    assert approved.draft("d1").status is ArtifactStatus.APPROVED
    assert approved.approved_draft.draft_id == "d1"


# --- INV-5: re-draft supersedes candidates, keeps last approved readable ----


def test_redraft_supersedes_prior_candidate_but_not_approved() -> None:
    thread = _thread().add_draft(_draft("d1", 1), at="t1")
    # A second candidate before any approval supersedes the stale candidate.
    thread = thread.add_draft(_draft("d2", 2), at="t2")
    assert thread.draft("d1").status is ArtifactStatus.SUPERSEDED
    assert thread.draft("d2").status is ArtifactStatus.CANDIDATE

    # Approve d2, then re-draft d3: the approved d2 stays readable (INV-5).
    thread = thread.approve_draft("d2", approved_at="t3")
    thread = thread.add_draft(_draft("d3", 3), at="t4")
    assert thread.draft("d2").status is ArtifactStatus.APPROVED
    assert thread.approved_draft.draft_id == "d2"
    assert thread.draft("d3").status is ArtifactStatus.CANDIDATE

    # Only when the replacement d3 is approved does d2 become superseded.
    thread = thread.approve_draft("d3", approved_at="t5")
    assert thread.draft("d2").status is ArtifactStatus.SUPERSEDED
    assert thread.approved_draft.draft_id == "d3"


def test_reject_never_destroys_last_approved() -> None:
    thread = _thread().add_draft(_draft("d1", 1), at="t1")
    thread = thread.approve_draft("d1", approved_at="t2")
    thread = thread.add_draft(_draft("d2", 2), at="t3")
    thread = thread.reject_draft("d2", rejected_at="t4", reason="not quite")
    assert thread.draft("d2").status is ArtifactStatus.REJECTED
    # The last approved draft is untouched and still readable.
    assert thread.draft("d1").status is ArtifactStatus.APPROVED
    assert thread.approved_draft.draft_id == "d1"


def test_only_candidate_can_be_approved_or_rejected() -> None:
    thread = _thread().add_draft(_draft("d1", 1), at="t1")
    thread = thread.approve_draft("d1", approved_at="t2")
    with pytest.raises(ValueError, match="candidate"):
        thread.approve_draft("d1", approved_at="t3")
    with pytest.raises(ValueError, match="candidate"):
        thread.reject_draft("d1", rejected_at="t3")


def test_next_generation_increments() -> None:
    thread = _thread()
    assert thread.next_generation() == 1
    thread = thread.add_draft(_draft("d1", 1), at="t1")
    assert thread.next_generation() == 2
