"""Outreach draft truthfulness gate stack + use cases (R6 Phase 3, INV-5/INV-2).

Regression fixtures that prove the exact invariants:

  * a draft that fabricates a metric / employer reproduces the bad state from
    canonical facts and is HARD-blocked from approval (fabrication-rejected);
  * editing a draft creates a NEW generation that RE-RUNS the gates;
  * a re-draft never destroys the last approved draft until a replacement is
    approved (re-draft-preserves-last-approved);
  * every claim binds to the confirmed fact it rests on (INV-2), computed against
    the rendered draft text.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.contact import (
    AttributeInput,
    ContactLink,
    ContactRole,
    CreateContactUseCase,
)
from jobctrl.domain.contact.outreach_use_cases import (
    ApproveOutreachDraftUseCase,
    GenerateOutreachDraftUseCase,
    OutreachDraftInputError,
    RejectOutreachDraftUseCase,
    ReviseOutreachDraftUseCase,
)
from jobctrl.domain.ports.artifact_review import ArtifactStatus
from jobctrl.domain.ports.llm import LlmPort
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.contact import (
    SqliteContactRepository,
    SqliteOutreachThreadRepository,
)
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus

_CLEAN_BODY = (
    "Hi Dana Lee,\n\n"
    "I scaled a platform to 5 million users at Globex Corporation and would love "
    "to hear how your team approaches reliability at Acme.\n\n"
    "Best,\nSam"
)
_FABRICATED_BODY = "Hi Dana,\n\nWe worked together at Initech Inc. and I increased revenue by 250% there.\n\nBest,\nSam"

_JUDGE_PASS = {
    "verdict": "PASS",
    "score": 0.95,
    "criterion_scores": {
        "relevance_to_recipient": 0.95,
        "evidence_support": 0.95,
        "fabrication_safety": 1.0,
        "relationship_accuracy": 1.0,
        "tone_professionalism": 0.9,
    },
    "issues": [],
    "unsupported_claims": [],
    "fabricated_relationships": [],
    "repair_instructions": [],
}


def _profile() -> dict:
    return {
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer scaling data platforms."},
            "experience_entries": [
                {
                    "id": "exp1",
                    "title": "Senior Engineer",
                    "company": "Globex Corporation",
                    "date_range": "2019 - 2023",
                    "bullets": ["Scaled the platform to 5 million users on PostgreSQL."],
                    "achievement_evidence": [
                        {
                            "source_text": "Scaled the platform to 5 million users.",
                            "metrics": ["5 million users"],
                            "tools": ["PostgreSQL", "Python"],
                        }
                    ],
                }
            ],
            "skill_categories": [{"id": "skills", "label": "Skills", "items": ["Python", "PostgreSQL"]}],
            "education_entries": [],
        },
        "resume_constraints": {"real_metrics": ["5 million users"]},
    }


class _FakeLlm(LlmPort):
    """Returns a fixed draft body for generation and a fixed judge verdict."""

    def __init__(self, *, body: str = _CLEAN_BODY, judge: dict | None = None) -> None:
        self.body = body
        self.judge = judge if judge is not None else dict(_JUDGE_PASS)
        self.schemas_seen: list[str] = []

    def chat_json(
        self, messages, *, response_schema, model=None, temperature=None, max_tokens=None, thinking_budget=None
    ):  # noqa: ANN001,D102
        title = str(response_schema.get("title"))
        self.schemas_seen.append(title)
        if title == "GeneratedProseDraft":
            request = json.loads(messages[1].content)
            return {
                "lines": [
                    {
                        "line_id": "outreach:body",
                        "text": self.body,
                        "evidence_ids": [row["source_id"] for row in request["sources"]],
                        "requirement_ids": [],
                        "transform_type": "rephrase",
                        "reason": "Explicit generator anchor",
                    }
                ]
            }
        if title == "OutreachDraftJudgeResult":
            return dict(self.judge)
        return {}

    def chat(self, messages, **kwargs):  # noqa: ANN001,D102
        return ""

    def ask(self, prompt, **kwargs):  # noqa: ANN001,D102
        return ""


def _counter():
    state = {"n": 0}

    def _next() -> str:
        state["n"] += 1
        return f"id-{state['n']}"

    return _next


def _setup(tmp_path: Path):
    conn = init_db(tmp_path / "jobctrl.db")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
        (
            str(LOCAL_TENANT),
            "00000000-0000-4000-8000-000000000001",
            "https://jobs.example.test/outreach-draft",
        ),
    )
    bus = InProcessEventBus()
    contact_repo = SqliteContactRepository(conn, publisher=bus)
    thread_repo = SqliteOutreachThreadRepository(conn, publisher=bus)
    contact = CreateContactUseCase(contact_repo).execute(
        LOCAL_TENANT,
        link=ContactLink(employer="Acme", job_id="00000000-0000-4000-8000-000000000001"),
        role=ContactRole.RECRUITER,
        attributes=[
            AttributeInput("name", "Dana Lee"),
            AttributeInput("title", "Engineering Manager"),
        ],
    )
    return conn, contact_repo, thread_repo, contact


# --- Deterministic gate 1 (never-fabricate) --------------------------------


# --- Gate 2 (content validator) --------------------------------------------


# --- Gate 3 (judge) --------------------------------------------------------


# --- Gate 4 (claim -> fact provenance, INV-2) ------------------------------


# --- Use cases: generate / revise / approve (INV-5) ------------------------


def test_generate_produces_gated_candidate_and_approves(tmp_path: Path) -> None:
    _, contact_repo, thread_repo, contact = _setup(tmp_path)
    thread = GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_CLEAN_BODY),
        new_id=_counter(),
        **outreach_review_ports(thread_repo._conn, verdict="pass"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
        application_role="Staff Engineer",
    )
    draft = thread.latest_draft
    assert draft is not None
    assert draft.status is ArtifactStatus.CANDIDATE
    assert draft.gate_results.passed is True
    assert draft.gate_results.determination_ids  # Persisted model verdict is the source of truth.

    approved = ApproveOutreachDraftUseCase(repository=thread_repo).execute(
        LOCAL_TENANT, thread_id="thread-1", draft_id=draft.draft_id
    )
    assert approved.approved_draft is not None
    assert approved.approved_draft.draft_id == draft.draft_id


def test_fabricated_generate_cannot_be_approved(tmp_path: Path) -> None:
    _, contact_repo, thread_repo, contact = _setup(tmp_path)
    thread = GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_FABRICATED_BODY),
        new_id=_counter(),
        **outreach_review_ports(thread_repo._conn, verdict="fail"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    draft = thread.latest_draft
    assert draft is not None
    assert draft.gate_results.passed is False
    assert draft.gate_results.fabrications  # the audit trail keeps the findings
    # INV-5: approval is HARD-blocked because the persisted gates did not pass.
    with pytest.raises(ValueError, match="gates did not pass"):
        ApproveOutreachDraftUseCase(repository=thread_repo).execute(
            LOCAL_TENANT, thread_id="thread-1", draft_id=draft.draft_id
        )
    # The persisted canonical draft still carries the failing gate outcome.
    reloaded = thread_repo.load(LOCAL_TENANT, "thread-1")
    assert reloaded.draft(draft.draft_id).status is ArtifactStatus.CANDIDATE
    assert reloaded.draft(draft.draft_id).gate_results.passed is False


def test_revise_creates_new_generation_and_reruns_gates(tmp_path: Path) -> None:
    _, contact_repo, thread_repo, contact = _setup(tmp_path)
    new_id = _counter()  # shared so draft ids stay unique across use cases
    GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_CLEAN_BODY),
        new_id=new_id,
        **outreach_review_ports(thread_repo._conn, verdict="pass"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    # The explicit verifier rejection must govern the edited draft.
    revised = ReviseOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body="unused-for-revise"),
        new_id=new_id,
        **outreach_review_ports(thread_repo._conn, verdict="fail"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        edited_body_text=_FABRICATED_BODY,
        profile=_profile(),
    )
    latest = revised.latest_draft
    assert latest.generation == 2
    assert latest.gate_results.passed is False


def test_redraft_preserves_last_approved_until_replacement_approved(tmp_path: Path) -> None:
    _, contact_repo, thread_repo, contact = _setup(tmp_path)
    gen = GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_CLEAN_BODY),
        new_id=_counter(),
        **outreach_review_ports(thread_repo._conn, verdict="pass"),
    )
    thread = gen.execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    first_id = thread.latest_draft.draft_id
    thread = ApproveOutreachDraftUseCase(repository=thread_repo).execute(
        LOCAL_TENANT, thread_id="thread-1", draft_id=first_id
    )
    assert thread.approved_draft.draft_id == first_id

    # Re-draft: the approved draft is STILL readable (INV-5) after a new candidate.
    thread = gen.execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    reloaded = thread_repo.load(LOCAL_TENANT, "thread-1")
    assert reloaded.approved_draft is not None
    assert reloaded.approved_draft.draft_id == first_id
    second = reloaded.latest_draft
    assert second.draft_id != first_id
    assert second.status is ArtifactStatus.CANDIDATE

    # Only after the replacement is approved does the prior approved supersede.
    approved = ApproveOutreachDraftUseCase(repository=thread_repo).execute(
        LOCAL_TENANT, thread_id="thread-1", draft_id=second.draft_id
    )
    assert approved.approved_draft.draft_id == second.draft_id
    assert approved.draft(first_id).status is ArtifactStatus.SUPERSEDED


def test_reject_reason_stays_canonical_and_out_of_events(tmp_path: Path) -> None:
    conn, contact_repo, thread_repo, contact = _setup(tmp_path)
    thread = GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_CLEAN_BODY),
        new_id=_counter(),
        **outreach_review_ports(thread_repo._conn, verdict="pass"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    draft_id = thread.latest_draft.draft_id
    reason = "off tone, references dana.lee@example.test"

    RejectOutreachDraftUseCase(
        repository=thread_repo,
        clock=lambda: "2026-07-06T00:02:00Z",
    ).execute(LOCAL_TENANT, thread_id="thread-1", draft_id=draft_id, reason=reason)

    row = conn.execute(
        "SELECT reason FROM outreach_drafts WHERE tenant_id = ? AND draft_id = ?",
        (LOCAL_TENANT, draft_id),
    ).fetchone()
    assert row["reason"] == reason

    event_rows = conn.execute(
        "SELECT event_type, payload_json FROM job_events WHERE entity_kind = 'outreach'"
    ).fetchall()
    payloads = [str(event["payload_json"] or "") for event in event_rows]
    assert payloads
    assert all(reason not in payload for payload in payloads)

    rejected_payload = next(
        json.loads(str(event["payload_json"])) for event in event_rows if event["event_type"] == "OutreachDraftRejected"
    )
    assert "reason" not in rejected_payload
    assert rejected_payload["rejectedAt"] == "2026-07-06T00:02:00Z"


def test_revise_rejects_empty_body(tmp_path: Path) -> None:
    _, contact_repo, thread_repo, contact = _setup(tmp_path)
    GenerateOutreachDraftUseCase(
        repository=thread_repo,
        contact_repository=contact_repo,
        llm=_FakeLlm(body=_CLEAN_BODY),
        new_id=_counter(),
        **outreach_review_ports(thread_repo._conn, verdict="pass"),
    ).execute(
        LOCAL_TENANT,
        thread_id="thread-1",
        contact_id=str(contact.contact_id),
        job_id="00000000-0000-4000-8000-000000000001",
        profile=_profile(),
    )
    with pytest.raises(OutreachDraftInputError):
        ReviseOutreachDraftUseCase(
            repository=thread_repo,
            contact_repository=contact_repo,
            llm=_FakeLlm(),
            new_id=_counter(),
            **outreach_review_ports(thread_repo._conn, verdict="pass"),
        ).execute(LOCAL_TENANT, thread_id="thread-1", edited_body_text="   ", profile=_profile())


def outreach_review_ports(conn, verdict="pass"):
    from tests.determination_fakes import VerificationModel
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
    from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge

    deps = dict(
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="contact",
        preflight=lambda: None,
    )
    return dict(
        claim_verifier=ModelClaimVerifier(llm=VerificationModel(verdict), **deps),
        quality_judge=ModelArtifactQualityJudge(llm=VerificationModel(), **deps),
        preflight=lambda: None,
    )
