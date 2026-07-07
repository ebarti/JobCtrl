"""OutreachThread aggregate invariants (R6 Phase 3/4).

Covers the headline invariants the aggregate is responsible for:

  * INV-1 — the aggregate never sends and exposes no outbound transport. The
    ONLY way it reaches a "sent" state is a user-attested :class:`OutreachSendLog`
    over an *approved* draft; "sent" is a derived property, not a stored marker,
    and rehydrating a thread whose send log attests a non-approved draft raises
    (mirrors the ApplyRun dry-run coherence guard). Approving a draft and logging
    a send are distinct user actions.
  * INV-5 — a draft can only be approved when its persisted gates passed;
    re-drafting supersedes prior *candidate* drafts but the last *approved* draft
    stays readable until a replacement is approved; rejecting never destroys the
    last approved draft.
"""

from __future__ import annotations

import dataclasses

import pytest

from jobctrl.domain.contact.outreach import (
    OutreachDraft,
    OutreachDraftKind,
    OutreachSendLog,
    OutreachThread,
)
from jobctrl.domain.contact.outreach_gates import DraftGateResults
from jobctrl.domain.materials.value_objects import (
    ArtifactStatus,
    JudgeVerdict,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT

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


# --- INV-1: "sent" only via a user-attested send log over an approved draft ---


def test_thread_has_no_free_floating_sent_marker() -> None:
    # "sent" is DERIVED from the presence of a user-attested send log, never a
    # stored boolean that could drift from the evidence (INV-1).
    field_names = {field.name for field in dataclasses.fields(_thread())}
    assert "sent" not in field_names
    assert not any(name == "sent" or name.endswith("_sent") for name in field_names)


def test_fresh_thread_is_not_sent() -> None:
    assert _thread().is_sent is False


def test_approving_a_draft_is_not_sending() -> None:
    # Approve records a reviewable/copyable draft; it performs no outbound action
    # and does NOT mark the thread sent. Logging a send is a separate action.
    thread = _thread().add_draft(_draft("d1", 1), at="t1").approve_draft("d1", approved_at="t2")
    assert thread.approved_draft is not None
    assert thread.is_sent is False


def test_log_send_marks_thread_sent_over_approved_draft() -> None:
    thread = _thread().add_draft(_draft("d1", 1), at="t1").approve_draft("d1", approved_at="t2")
    sent = thread.log_send(
        send_log_id="s1", draft_id="d1", channel="email", sent_at="2026-07-02", logged_at="t3"
    )
    assert sent.is_sent is True
    assert sent.last_send_log is not None
    assert sent.last_send_log.draft_id == "d1"
    assert sent.last_send_log.channel == "email"


def test_log_send_requires_an_approved_draft() -> None:
    # A candidate draft cannot be send-logged: "approve draft" and "log send" are
    # distinct user actions (INV-1).
    thread = _thread().add_draft(_draft("d1", 1), at="t1")
    with pytest.raises(ValueError, match="approved draft can be send-logged"):
        thread.log_send(
            send_log_id="s1", draft_id="d1", channel="email", sent_at="x", logged_at="y"
        )


def test_cannot_rehydrate_sent_state_without_an_approved_draft() -> None:
    # Hand-building a thread whose send log attests a never-approved draft raises,
    # mirroring the ApplyRun terminal/evidence coherence guard.
    candidate = _draft("d1", 1)
    with pytest.raises(ValueError, match="never approved"):
        OutreachThread(
            tenant_id=LOCAL_TENANT,
            thread_id="thread-1",
            contact_id="contact-1",
            drafts=(candidate,),
            send_logs=(
                OutreachSendLog(
                    send_log_id="s1",
                    thread_id="thread-1",
                    draft_id="d1",
                    channel="email",
                    sent_at="x",
                    logged_at="y",
                ),
            ),
        )


def test_cannot_rehydrate_send_log_for_a_missing_draft() -> None:
    with pytest.raises(ValueError, match="not on this thread"):
        OutreachThread(
            tenant_id=LOCAL_TENANT,
            thread_id="thread-1",
            contact_id="contact-1",
            drafts=(),
            send_logs=(
                OutreachSendLog(
                    send_log_id="s1",
                    thread_id="thread-1",
                    draft_id="dX",
                    channel="email",
                    sent_at="x",
                    logged_at="y",
                ),
            ),
        )


def test_draft_has_no_send_surface() -> None:
    # The draft entity never gains a send transport/status (INV-1 stays local to
    # the user-attested send log on the thread).
    draft_status_values = {
        s.value
        for s in (
            ArtifactStatus.CANDIDATE,
            ArtifactStatus.APPROVED,
            ArtifactStatus.REJECTED,
            ArtifactStatus.SUPERSEDED,
        )
    }
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


# --- Follow-up schedule (surfaced-only; never auto-acted, never sent) --------


def test_schedule_then_complete_follow_up() -> None:
    thread = _thread().schedule_follow_up(
        due_at="2026-07-08T00:00:00+00:00", basis="application_submitted", at="t1"
    )
    assert thread.follow_up.is_scheduled
    assert thread.follow_up.due_at == "2026-07-08T00:00:00+00:00"
    assert thread.follow_up.basis == "application_submitted"
    completed = thread.complete_follow_up(at="t2")
    assert completed.follow_up.state.value == "completed"
    # Scheduling/completing a follow-up never sends anything (INV-1).
    assert completed.is_sent is False


def test_dismiss_follow_up() -> None:
    thread = _thread().schedule_follow_up(due_at="2026-07-08", basis="manual", at="t1")
    dismissed = thread.dismiss_follow_up(at="t2")
    assert dismissed.follow_up.state.value == "dismissed"


def test_complete_or_dismiss_requires_a_scheduled_follow_up() -> None:
    thread = _thread()
    with pytest.raises(ValueError, match="No scheduled follow-up"):
        thread.complete_follow_up(at="t1")
    with pytest.raises(ValueError, match="No scheduled follow-up"):
        thread.dismiss_follow_up(at="t1")


def test_scheduled_follow_up_requires_a_due_date() -> None:
    with pytest.raises(ValueError, match="due_at"):
        _thread().schedule_follow_up(due_at="", basis="manual", at="t1")
