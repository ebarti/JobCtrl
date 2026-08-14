"""Follow-up scheduling derivation + default-off posture (plan §9, §16 res. 5).

Follow-ups REACT to the application lifecycle: the first suggestion is 7 calendar
days after submission, a subsequent nudge is 14 days when there is no logged
reply. Suggestions are surfaced-only, fully user-editable, and never auto-acted
or sent (INV-1). Any optional recurring reminder is default-OFF.
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

from jobctrl.config import (
    DEFAULT_OUTREACH_FOLLOW_UP_CONFIG,
    outreach_follow_up_reminders_enabled,
)
from jobctrl.database import init_db
from jobctrl.domain.contact.outreach import (
    FIRST_FOLLOW_UP_DAYS,
    SUBSEQUENT_NUDGE_DAYS,
    FollowUpBasis,
    FollowUpSchedule,
    FollowUpState,
    OutreachDraft,
    OutreachDraftKind,
    OutreachThread,
    follow_up_is_due,
    suggest_follow_up,
)
from jobctrl.domain.contact.outreach_gates import DraftGateResults
from jobctrl.domain.contact.outreach_use_cases import ScheduleFollowUpUseCase
from jobctrl.domain.materials.value_objects import (
    ArtifactStatus,
    JudgeVerdict,
    ValidationResult,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

_SUBMITTED = "2026-07-01T00:00:00+00:00"


# --- Pure derivation --------------------------------------------------------


def test_first_follow_up_is_seven_days_after_submission() -> None:
    assert FIRST_FOLLOW_UP_DAYS == 7
    suggestion = suggest_follow_up(submitted_at=_SUBMITTED)
    assert suggestion is not None
    assert suggestion.due_at == "2026-07-08T00:00:00+00:00"
    assert suggestion.basis == FollowUpBasis.APPLICATION_SUBMITTED


def test_subsequent_nudge_is_fourteen_days_when_no_reply() -> None:
    assert SUBSEQUENT_NUDGE_DAYS == 14
    first = suggest_follow_up(submitted_at=_SUBMITTED)
    assert first is not None
    nudge = suggest_follow_up(submitted_at=_SUBMITTED, last_follow_up_due_at=first.due_at)
    assert nudge is not None
    assert nudge.due_at == "2026-07-22T00:00:00+00:00"
    assert nudge.basis == FollowUpBasis.NO_REPLY_NUDGE


def test_no_suggestion_when_a_reply_is_logged() -> None:
    assert suggest_follow_up(submitted_at=_SUBMITTED, has_logged_reply=True) is None


def test_no_suggestion_without_a_submission_anchor() -> None:
    assert suggest_follow_up(submitted_at="") is None


def test_accepts_trailing_z_timezone() -> None:
    suggestion = suggest_follow_up(submitted_at="2026-07-01T00:00:00Z")
    assert suggestion is not None
    assert suggestion.due_at == "2026-07-08T00:00:00+00:00"


# --- Derived "due" read-model signal (schedule + clock) ---------------------


def test_follow_up_is_due_only_when_scheduled_and_arrived() -> None:
    scheduled = FollowUpSchedule(
        state=FollowUpState.SCHEDULED, due_at="2026-07-08T00:00:00+00:00", basis="x"
    )
    assert follow_up_is_due(scheduled, now="2026-07-09T00:00:00+00:00") is True
    assert follow_up_is_due(scheduled, now="2026-07-07T00:00:00+00:00") is False
    # A completed/none schedule is never due.
    assert follow_up_is_due(FollowUpSchedule(), now="2027-01-01T00:00:00+00:00") is False
    completed = FollowUpSchedule(
        state=FollowUpState.COMPLETED, due_at="2026-07-08T00:00:00+00:00", basis="x"
    )
    assert follow_up_is_due(completed, now="2026-07-09T00:00:00+00:00") is False


# --- Default-off automation posture -----------------------------------------


def test_recurring_reminder_is_default_off() -> None:
    assert DEFAULT_OUTREACH_FOLLOW_UP_CONFIG["reminders_enabled"] is False
    assert outreach_follow_up_reminders_enabled() is False


def test_recurring_reminder_can_be_enabled_but_never_sends() -> None:
    # The flag can be flipped on for an optional reminder, but even then follow-ups
    # are only SURFACED — there is no send path (INV-1).
    assert outreach_follow_up_reminders_enabled({"reminders_enabled": True}) is True


# --- Use-case derivation (reacts to the application lifecycle) ---------------


def _repo() -> tuple[SqliteOutreachThreadRepository, sqlite3.Connection]:
    conn = init_db(Path(tempfile.mkdtemp()) / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        (
            str(LOCAL_TENANT),
            "00000000-0000-4000-8000-000000000001",
            "https://jobs.example.test/outreach-follow-up",
        ),
    )
    return SqliteOutreachThreadRepository(conn, publisher=InProcessEventBus()), conn


def _seed_thread(repo: SqliteOutreachThreadRepository) -> None:
    gates = DraftGateResults(
        fabrications=(),
        validation=ValidationResult.success(),
        judge=JudgeVerdict.passed(score=0.95, criterion_scores={"evidence_support": 1.0}),
    )
    draft = OutreachDraft(
        draft_id="d1",
        thread_id="t1",
        generation=1,
        kind=OutreachDraftKind.INTRO_REQUEST,
        status=ArtifactStatus.APPROVED,
        body_text="Hi,\n\nBody.\n\nBest,\nSam",
        gate_results=gates,
        created_at="c",
        approved_at="ap",
    )
    repo.save(
        LOCAL_TENANT,
        OutreachThread(
            tenant_id=LOCAL_TENANT,
            thread_id="t1",
            contact_id="c1",
            job_id="00000000-0000-4000-8000-000000000001",
            drafts=(draft,),
            created_at="c",
            updated_at="c",
        ),
    )


def test_schedule_use_case_derives_default_then_nudge() -> None:
    repo, _conn = _repo()
    _seed_thread(repo)
    scheduled = ScheduleFollowUpUseCase(repository=repo, clock=lambda: "s1").execute(
        LOCAL_TENANT, thread_id="t1", submitted_at=_SUBMITTED
    )
    assert scheduled.follow_up.due_at == "2026-07-08T00:00:00+00:00"
    assert scheduled.follow_up.basis == FollowUpBasis.APPLICATION_SUBMITTED
    nudge = ScheduleFollowUpUseCase(repository=repo, clock=lambda: "s2").execute(
        LOCAL_TENANT, thread_id="t1", submitted_at=_SUBMITTED
    )
    assert nudge.follow_up.due_at == "2026-07-22T00:00:00+00:00"
    assert nudge.follow_up.basis == FollowUpBasis.NO_REPLY_NUDGE


def test_schedule_use_case_honours_user_edited_due_date() -> None:
    repo, _conn = _repo()
    _seed_thread(repo)
    scheduled = ScheduleFollowUpUseCase(repository=repo, clock=lambda: "s1").execute(
        LOCAL_TENANT, thread_id="t1", due_at="2026-08-15T09:00:00+00:00"
    )
    # A fully user-editable date overrides the derived suggestion.
    assert scheduled.follow_up.due_at == "2026-08-15T09:00:00+00:00"
    assert scheduled.follow_up.basis == FollowUpBasis.MANUAL
