"""No-auto-send enforcement suite for outreach (INV-1, plan §8.3).

The headline product invariant: JobHunter NEVER sends. The four enforcement
layers from §8.3, patterned on the apply-safety suite:

  a. Aggregate invariant — a thread reaches "sent" only via a user-attested send
     log over an approved draft (``test_outreach_thread_aggregate.py``).
  b. No-send-transport grep guard — no transport symbol exists in the
     contact/outreach code on either runtime
     (``test_outreach_no_send_transport.py``).
  c. Adapter-never-called — running the full outreach lifecycle opens NO outbound
     transport (this file: ``test_no_transport_is_invoked_on_any_outreach_path``,
     the analog of the apply ``assert posts == []`` guard).
  d. Gate — "approve draft" and "log send" are distinct user actions: approving
     performs no outbound action and does not mark the thread sent; logging a send
     is a separate explicit action (this file, at the use-case + event level, the
     analog of the apply approval-gate test).
"""

from __future__ import annotations

import smtplib
import socket
import sqlite3
import tempfile
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.domain.contact.outreach import (
    OutreachDraft,
    OutreachDraftKind,
    OutreachThread,
)
from jobhunter.domain.contact.outreach_gates import DraftGateResults
from jobhunter.domain.contact.outreach_use_cases import (
    ApproveOutreachDraftUseCase,
    CompleteFollowUpUseCase,
    LogOutreachSendUseCase,
    ScheduleFollowUpUseCase,
)
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    JudgeVerdict,
    ValidationResult,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobhunter.infrastructure.events.in_process_bus import InProcessEventBus

_PASS_GATES = DraftGateResults(
    fabrications=(),
    validation=ValidationResult.success(),
    judge=JudgeVerdict.passed(score=0.95, criterion_scores={"evidence_support": 1.0}),
)


def _repo() -> tuple[SqliteOutreachThreadRepository, sqlite3.Connection]:
    conn = init_db(Path(tempfile.mkdtemp()) / "jobhunter.db")
    conn.row_factory = sqlite3.Row
    return SqliteOutreachThreadRepository(conn, publisher=InProcessEventBus()), conn


def _candidate_draft(draft_id: str = "d1") -> OutreachDraft:
    return OutreachDraft(
        draft_id=draft_id,
        thread_id="t1",
        generation=1,
        kind=OutreachDraftKind.INTRO_REQUEST,
        status=ArtifactStatus.CANDIDATE,
        body_text="Hi Dana,\n\nShort honest note.\n\nBest,\nSam",
        gate_results=_PASS_GATES,
        created_at="2026-07-06T00:00:00Z",
    )


def _seed_candidate_thread(
    repo: SqliteOutreachThreadRepository, *, draft_id: str = "d1"
) -> None:
    repo.save(
        LOCAL_TENANT,
        OutreachThread(
            tenant_id=LOCAL_TENANT,
            thread_id="t1",
            contact_id="c1",
            job_id="https://job/1",
            drafts=(_candidate_draft(draft_id),),
            created_at="2026-07-06T00:00:00Z",
            updated_at="2026-07-06T00:00:00Z",
        ),
    )


def _event_types(conn: sqlite3.Connection) -> list[str]:
    return [
        str(row["event_type"])
        for row in conn.execute("SELECT event_type FROM job_events ORDER BY rowid").fetchall()
    ]


# --- Layer (c): adapter-never-called ---------------------------------------


def test_no_transport_is_invoked_on_any_outreach_path(monkeypatch) -> None:
    """The full approve -> log-send -> follow-up lifecycle opens NO transport.

    Records every socket connection and mail-client construction while the
    outreach use cases run and asserts both stayed empty — the analog of the
    apply dry-run guard's ``assert posts == []``. Nothing is ever sent (INV-1).
    """
    connects: list[object] = []
    smtp_uses: list[object] = []
    monkeypatch.setattr(
        socket.socket, "connect", lambda self, address: connects.append(address)
    )

    def _smtp_guard(*args: object, **kwargs: object) -> object:
        smtp_uses.append(args)
        raise AssertionError("outreach must never construct an SMTP client (INV-1)")

    monkeypatch.setattr(smtplib, "SMTP", _smtp_guard)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _smtp_guard)

    repo, conn = _repo()
    _seed_candidate_thread(repo)
    ApproveOutreachDraftUseCase(repository=repo, clock=lambda: "t2").execute(
        LOCAL_TENANT, thread_id="t1", draft_id="d1"
    )
    LogOutreachSendUseCase(repository=repo, clock=lambda: "t3", new_id=lambda: "s1").execute(
        LOCAL_TENANT, thread_id="t1", draft_id="d1", channel="email", sent_at="2026-07-07"
    )
    ScheduleFollowUpUseCase(repository=repo, clock=lambda: "t4").execute(
        LOCAL_TENANT, thread_id="t1", submitted_at="2026-07-01T00:00:00+00:00"
    )
    CompleteFollowUpUseCase(repository=repo, clock=lambda: "t5").execute(
        LOCAL_TENANT, thread_id="t1"
    )

    assert connects == []
    assert smtp_uses == []


# --- Layer (d): approve and log-send are distinct user actions --------------


def test_approving_a_draft_records_a_fact_and_does_not_send() -> None:
    repo, conn = _repo()
    _seed_candidate_thread(repo)
    thread = ApproveOutreachDraftUseCase(repository=repo, clock=lambda: "t2").execute(
        LOCAL_TENANT, thread_id="t1", draft_id="d1"
    )
    # Approval records a reviewable/copyable draft. It performs NO outbound action:
    # the thread is not "sent", carries no send log, and emits no send event.
    assert thread.is_sent is False
    assert thread.send_logs == ()
    assert "OutreachSendLogged" not in _event_types(conn)


def test_logging_a_send_is_a_separate_explicit_action() -> None:
    repo, conn = _repo()
    _seed_candidate_thread(repo)
    ApproveOutreachDraftUseCase(repository=repo, clock=lambda: "t2").execute(
        LOCAL_TENANT, thread_id="t1", draft_id="d1"
    )
    thread = LogOutreachSendUseCase(
        repository=repo, clock=lambda: "t3", new_id=lambda: "s1"
    ).execute(
        LOCAL_TENANT, thread_id="t1", draft_id="d1", channel="email", sent_at="2026-07-07"
    )
    assert thread.is_sent is True
    assert _event_types(conn).count("OutreachSendLogged") == 1


def test_logging_a_send_before_approval_is_refused_and_stays_unsent() -> None:
    repo, conn = _repo()
    _seed_candidate_thread(repo)
    # The domain refuses to send-log a non-approved draft (INV-1). No send log is
    # written and the thread stays "not sent".
    with pytest.raises(ValueError, match="approved draft"):
        LogOutreachSendUseCase(
            repository=repo, clock=lambda: "t3", new_id=lambda: "s1"
        ).execute(
            LOCAL_TENANT, thread_id="t1", draft_id="d1", channel="email", sent_at="2026-07-07"
        )
    reloaded = repo.load(LOCAL_TENANT, "t1")
    assert reloaded is not None
    assert reloaded.is_sent is False
    assert "OutreachSendLogged" not in _event_types(conn)
