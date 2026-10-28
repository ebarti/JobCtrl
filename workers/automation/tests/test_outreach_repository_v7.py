"""Exact-v7 outreach persistence identity and tenant-isolation regressions."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier

import pytest

from jobctrl.database import init_db
from jobctrl.domain.contact.outreach import (
    FollowUpSchedule,
    FollowUpState,
    OutreachThread,
    OutreachPublicationConflict,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.contact.outreach_repository import (
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

from jobctrl.domain.contact.outreach_use_cases import GenerateOutreachDraftUseCase, ReviseOutreachDraftUseCase
from tests.test_outreach_draft_gates import _setup, _profile, _FakeLlm, outreach_review_ports

_JOB_ID = JobId("00000000-0000-4000-8000-000000000001")


def _repo(tmp_path: Path) -> tuple[SqliteOutreachThreadRepository, sqlite3.Connection]:
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    conn.executemany(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        [
            ("tenant-a", str(_JOB_ID), "https://jobs.example.test/tenant-a/outreach"),
            ("tenant-b", str(_JOB_ID), "https://jobs.example.test/tenant-b/outreach"),
        ],
    )
    return SqliteOutreachThreadRepository(conn, publisher=InProcessEventBus()), conn


def _thread(tenant_id: TenantId, *, scheduled: bool = False) -> OutreachThread:
    return OutreachThread(
        tenant_id=tenant_id,
        thread_id="thread-1",
        contact_id="contact-1",
        job_id=_JOB_ID,
        created_at="2026-07-31T00:00:00Z",
        updated_at="2026-07-31T00:00:00Z",
        follow_up=(
            FollowUpSchedule(
                state=FollowUpState.SCHEDULED,
                due_at="2026-08-07T00:00:00Z",
                basis="test",
            )
            if scheduled
            else FollowUpSchedule()
        ),
    )


def test_repository_uses_exact_v7_job_id_column_without_schema_repair(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(outreach_threads)")
    }
    assert "job_id" in columns
    assert "job_url" not in columns

    tenant = TenantId("tenant-a")
    repo.save(tenant, _thread(tenant))
    row = conn.execute(
        "SELECT tenant_id, thread_id, contact_id, job_id FROM outreach_threads"
    ).fetchone()
    assert tuple(row) == ("tenant-a", "thread-1", "contact-1", str(_JOB_ID))
    assert repo.load_for_contact(tenant, "contact-1", _JOB_ID) is not None


def test_outreach_job_url_is_rejected_before_any_write_or_event(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    tenant = TenantId("tenant-a")
    with pytest.raises(ValueError, match="canonical UUID"):
        OutreachThread(
            tenant_id=tenant,
            thread_id="thread-1",
            contact_id="contact-1",
            job_id="https://jobs.example/1",  # type: ignore[arg-type]
            created_at="now",
            updated_at="now",
        )
    assert conn.execute("SELECT COUNT(*) FROM outreach_threads").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load_for_contact(tenant, "contact-1", "https://jobs.example/1")  # type: ignore[arg-type]


def test_outreach_rows_and_events_are_tenant_scoped_for_same_job_id(tmp_path: Path) -> None:
    repo, conn = _repo(tmp_path)
    tenant_a = TenantId("tenant-a")
    tenant_b = TenantId("tenant-b")
    repo.save(tenant_a, _thread(tenant_a, scheduled=True))
    repo.save(tenant_b, _thread(tenant_b, scheduled=True))

    assert repo.load(tenant_a, "thread-1").tenant_id == tenant_a  # type: ignore[union-attr]
    assert repo.load(tenant_b, "thread-1").tenant_id == tenant_b  # type: ignore[union-attr]
    rows = conn.execute(
        "SELECT tenant_id, job_id FROM outreach_threads ORDER BY tenant_id"
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("tenant-a", str(_JOB_ID)),
        ("tenant-b", str(_JOB_ID)),
    ]
    events = conn.execute(
        "SELECT tenant_id, job_id FROM job_events WHERE event_type = 'FollowUpScheduled' ORDER BY tenant_id"
    ).fetchall()
    assert [tuple(row) for row in events] == [
        ("tenant-a", str(_JOB_ID)),
        ("tenant-b", str(_JOB_ID)),
    ]


# Publication interleavings use real gates and independent SQLite connections.
# Timestamps are deliberately frozen: authority comes from canonical content.
_FROZEN = "2026-10-24T00:00:00Z"


def _generated(tmp_path):
    conn, contacts, repo, contact = _setup(tmp_path)
    result = GenerateOutreachDraftUseCase(
        repository=repo, contact_repository=contacts, llm=_FakeLlm(), new_id=lambda: "base",
        clock=lambda: _FROZEN, **outreach_review_ports(conn),
    ).execute(LOCAL_TENANT, thread_id="thread-1", contact_id=str(contact.contact_id), profile=_profile())
    return conn, contacts, repo, result


def _rows(conn):
    return {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in ("outreach_threads", "outreach_drafts", "outreach_send_logs", "artifact_line_anchors", "job_events")
    }


@pytest.mark.parametrize("mutation", ["send", "approve", "reject", "draft", "schedule", "reschedule", "complete", "dismiss"])
def test_delayed_revision_preserves_every_separately_committed_fact(tmp_path, mutation):
    conn, contacts, repo, base = _generated(tmp_path)
    if mutation == "send":
        base = repo.save(LOCAL_TENANT, base.approve_draft("base", approved_at=_FROZEN))
    if mutation in ("reschedule", "complete", "dismiss"):
        base = repo.save(LOCAL_TENANT, base.schedule_follow_up(due_at="2026-11-01", basis="manual", at=_FROZEN))
    other = sqlite3.connect(tmp_path / "jobctrl.db")
    other.row_factory = sqlite3.Row
    other_repo = SqliteOutreachThreadRepository(other, publisher=InProcessEventBus())
    ports = outreach_review_ports(conn)
    verify = ports["claim_verifier"].verify
    expected = {}

    def delayed_gate(**kwargs):
        assert not conn.in_transaction  # No writer is held across the slow gate.
        current = other_repo.load(LOCAL_TENANT, "thread-1")
        if mutation == "send":
            current = current.log_send(send_log_id="send-1", draft_id="base", channel="email", sent_at=_FROZEN, logged_at=_FROZEN)
        elif mutation == "approve":
            current = current.approve_draft("base", approved_at=_FROZEN)
        elif mutation == "reject":
            current = current.reject_draft("base", rejected_at=_FROZEN, reason="Synthetic deliberate rejection")
        elif mutation == "draft":
            from jobctrl.infrastructure.contact import SqliteContactRepository
            current = ReviseOutreachDraftUseCase(
                repository=other_repo,
                contact_repository=SqliteContactRepository(other, publisher=InProcessEventBus()),
                llm=_FakeLlm(), new_id=lambda: "newer", clock=lambda: _FROZEN,
                **outreach_review_ports(other),
            ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="Newer completed candidate", profile=_profile())
        elif mutation in ("schedule", "reschedule"):
            current = current.schedule_follow_up(due_at="2026-12-01", basis="edited", at=_FROZEN)
        elif mutation == "complete":
            current = current.complete_follow_up(at=_FROZEN)
        else:
            current = current.dismiss_follow_up(at=_FROZEN)
        if mutation != "draft":
            other_repo.save(LOCAL_TENANT, current)
        expected.update(_rows(other))
        return verify(**kwargs)

    ports["claim_verifier"].verify = delayed_gate
    with pytest.raises(OutreachPublicationConflict) as stale:
        ReviseOutreachDraftUseCase(
            repository=repo, contact_repository=contacts, llm=_FakeLlm(),
            new_id=lambda: "loser", clock=lambda: _FROZEN, **ports,
        ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="My retained edit " + mutation, profile=_profile())
    assert stale.value.proposal.latest_draft.body_text == "My retained edit " + mutation
    assert stale.value.proposal.latest_draft.gate_results.passed
    assert len(stale.value.proposal.latest_draft.gate_results.determination_ids) == 2
    assert _rows(conn) == expected
    other.close()
    conn.close()
    reopened = sqlite3.connect(tmp_path / "jobctrl.db")
    assert _rows(reopened) == expected
    reopened.close()


def test_two_revision_gates_release_writers_and_publish_one_generation(tmp_path):
    conn, _, _, _ = _generated(tmp_path)
    conn.close()
    barrier = Barrier(2)

    def revise(name):
        connection = sqlite3.connect(tmp_path / "jobctrl.db", timeout=10)
        connection.row_factory = sqlite3.Row
        from jobctrl.infrastructure.contact import SqliteContactRepository
        repo = SqliteOutreachThreadRepository(connection, publisher=InProcessEventBus())
        ports = outreach_review_ports(connection)
        verify = ports["claim_verifier"].verify

        def hold(**kwargs):
            assert not connection.in_transaction
            barrier.wait(timeout=10)
            return verify(**kwargs)

        ports["claim_verifier"].verify = hold
        try:
            result = ReviseOutreachDraftUseCase(
                repository=repo, contact_repository=SqliteContactRepository(connection, publisher=InProcessEventBus()),
                llm=_FakeLlm(), new_id=lambda: name, clock=lambda: _FROZEN, **ports,
            ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="Concurrent edit " + name, profile=_profile())
            return "published", result.latest_draft.generation
        except OutreachPublicationConflict as conflict:
            return "conflict", conflict.proposal.latest_draft.generation
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(revise, ("first", "second")))
    assert sorted(results) == [("conflict", 2), ("published", 2)]
    conn = sqlite3.connect(tmp_path / "jobctrl.db")
    assert conn.execute("SELECT generation FROM outreach_drafts ORDER BY generation").fetchall() == [(1,), (2,)]
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='OutreachDraftRevised'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM artifact_line_anchors").fetchone()[0] == 2
    conn.close()


@pytest.mark.parametrize("failure", ["rows", "anchors", "events"])
def test_publication_failure_rolls_back_rows_anchors_and_durable_events(tmp_path, failure):
    conn, contacts, repo, _ = _generated(tmp_path)
    accepted = _rows(conn)
    table = {"rows": "outreach_drafts", "anchors": "artifact_line_anchors", "events": "job_events"}[failure]
    conn.execute(f"CREATE TEMP TRIGGER fail_publication BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT, 'owned injected failure'); END")
    with pytest.raises(Exception, match="owned injected failure|persistence_error"):
        ReviseOutreachDraftUseCase(
            repository=repo, contact_repository=contacts, llm=_FakeLlm(), new_id=lambda: "failed",
            clock=lambda: _FROZEN, **outreach_review_ports(conn),
        ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="Completed but unpublished " + failure, profile=_profile())
    assert _rows(conn) == accepted
    conn.close()


def test_competing_creation_and_deleted_base_conflict_without_resurrection(tmp_path):
    repo, conn = _repo(tmp_path)
    tenant = TenantId("tenant-a")
    first = _thread(tenant)
    competing = replace(first, thread_id="competing")
    repo.save(tenant, first)
    with pytest.raises(OutreachPublicationConflict):
        repo.save(tenant, competing)
    stale = repo.load(tenant, first.thread_id)
    conn.execute("DELETE FROM outreach_threads WHERE tenant_id=?", (str(tenant),))
    conn.commit()
    with pytest.raises(OutreachPublicationConflict):
        repo.save(tenant, stale)
    assert conn.execute("SELECT COUNT(*) FROM outreach_threads").fetchone()[0] == 0
    conn.close()


def test_snapshot_is_coherent_and_unrelated_tenant_thread_writes_do_not_conflict(tmp_path):
    conn, contacts, repo, _ = _generated(tmp_path)
    other = sqlite3.connect(tmp_path / "jobctrl.db")
    other.execute("PRAGMA journal_mode=WAL")
    other.row_factory = sqlite3.Row
    other_repo = SqliteOutreachThreadRepository(other, publisher=InProcessEventBus())
    original_load = repo._load_drafts
    original = repo.load(LOCAL_TENANT, "thread-1")

    def interleave(tenant, thread_id):
        current = other_repo.load(tenant, thread_id)
        other_repo.save(tenant, current.approve_draft("base", approved_at=_FROZEN))
        return original_load(tenant, thread_id)

    repo._load_drafts = interleave
    coherent = repo.load(LOCAL_TENANT, "thread-1")
    repo._load_drafts = original_load
    assert coherent == original
    assert coherent.publication_base == original.publication_base
    with pytest.raises(OutreachPublicationConflict):
        repo.save(LOCAL_TENANT, coherent)
    ports = outreach_review_ports(conn)
    verify = ports["claim_verifier"].verify

    def unrelated(**kwargs):
        other_repo.save(LOCAL_TENANT, OutreachThread.create(tenant_id=LOCAL_TENANT, thread_id="other-thread", contact_id="other-contact", created_at=_FROZEN))
        other_repo.save(TenantId("another-tenant"), OutreachThread.create(tenant_id=TenantId("another-tenant"), thread_id="thread-1", contact_id="other-contact", created_at=_FROZEN))
        return verify(**kwargs)

    ports["claim_verifier"].verify = unrelated
    saved = ReviseOutreachDraftUseCase(
        repository=repo, contact_repository=contacts, llm=_FakeLlm(), new_id=lambda: "winner",
        clock=lambda: _FROZEN, **ports,
    ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="Independent thread controls", profile=_profile())
    assert saved.latest_draft.generation == 2
    assert conn.execute("SELECT COUNT(*) FROM outreach_threads").fetchone()[0] == 3
    conn.close()
    other.close()


def test_subscriber_failure_cannot_undo_committed_publication(tmp_path):
    conn, contacts, repo, _ = _generated(tmp_path)

    class UnavailableSubscriber:
        def publish(self, event):
            # A fresh connection sees the committed event BEFORE subscribers run.
            fresh = sqlite3.connect(tmp_path / "jobctrl.db")
            assert fresh.execute("SELECT COUNT(*) FROM job_events WHERE event_type='OutreachDraftRevised'").fetchone()[0] == 1
            fresh.close()
            raise RuntimeError("Synthetic subscriber unavailable")

    repo._publisher = UnavailableSubscriber()
    result = ReviseOutreachDraftUseCase(
        repository=repo, contact_repository=contacts, llm=_FakeLlm(), new_id=lambda: "committed",
        clock=lambda: _FROZEN, **outreach_review_ports(conn),
    ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="Durable before fanout", profile=_profile())
    assert result.latest_draft.draft_id == "committed"
    assert repo.load(LOCAL_TENANT, "thread-1") == result
    conn.close()
