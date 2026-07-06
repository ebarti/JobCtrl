"""Driving ports (use cases) for outreach drafts — outreach planner plan §4.5, §7.

Draft *generation* and *revision* run the LLM + the full truthfulness gate stack
(INV-5), so they execute on the Python worker (the gates are Python domain
services). *Approval* and *rejection* are simple lifecycle transitions — hosted
in the TS API at runtime (integration.md §6.8) but authoritative here as the
domain contract the regression tests exercise. Approval is gated on the persisted
:class:`DraftGateResults` (``OutreachDraft.approve`` raises unless the gates
passed), so a failed-gate draft can never be approved through any path.

There is NO send capability anywhere in this module (INV-1): the terminal state a
use case can produce is an ``approved`` (reviewable, copyable) draft.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from jobhunter.domain.contact.aggregate import Contact
from jobhunter.domain.contact.outreach import (
    FollowUpBasis,
    OutreachDraft,
    OutreachDraftKind,
    OutreachThread,
    suggest_follow_up,
)
from jobhunter.domain.contact.outreach_gates import (
    OUTREACH_JUDGE_MIN_SCORE,
    OUTREACH_JUDGE_RESPONSE_SCHEMA,
    DraftGateResults,
    OutreachClaimProvenance,
    build_outreach_evidence_corpus,
    build_outreach_judge_prompt,
    compute_outreach_claim_provenance,
    parse_outreach_judge_response,
    scan_outreach_draft,
    validate_outreach_draft,
)
from jobhunter.domain.contact.value_objects import ContactAttribute
from jobhunter.domain.materials.services import sanitize_text
from jobhunter.domain.materials.value_objects import ArtifactStatus, JudgeVerdict
from jobhunter.domain.ports.contact import ContactRepository, OutreachThreadRepository
from jobhunter.domain.ports.llm import LlmMessage, LlmPort
from jobhunter.domain.tenant import TenantId


class OutreachDraftInputError(ValueError):
    """Raised when a caller supplies structurally invalid outreach-draft input."""


class OutreachSendLogInputError(ValueError):
    """Raised when a caller supplies invalid send-log input (INV-1)."""


class OutreachFollowUpInputError(ValueError):
    """Raised when a caller supplies invalid follow-up scheduling input."""


OUTREACH_DRAFT_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "OutreachDraftBody",
    "type": "object",
    "additionalProperties": False,
    "required": ["body"],
    "properties": {"body": {"type": "string"}},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _contact_facts(contact: Contact) -> list[dict[str, str]]:
    """The confirmed contact record as safe {attribute_id, kind, value} rows.

    Used both to prompt/judge the draft and to compute claim -> fact provenance
    (INV-2). A contact's stored attributes ARE the confirmed record.
    """
    return [
        {"attribute_id": attribute.attribute_id, "kind": attribute.kind, "value": attribute.value}
        for attribute in contact.attributes
    ]


def _recipient_role(contact: Contact) -> str:
    title = contact.attribute("title")
    return title.value if title is not None else ""


def build_outreach_draft_prompt(
    profile: dict,
    *,
    kind: str,
    contact_facts: list[dict[str, str]],
    target_company: str,
    application_role: str,
) -> str:
    """System prompt for LLM draft generation — truthfulness is the hard rule.

    The model is told, up front, that it may reference ONLY the profile evidence
    and the confirmed contact record, and must never invent a relationship, a
    metric, or a fact about the recipient. The deterministic detector + judge are
    the real gates; this prompt just gives the generator the honest inputs.
    """
    resume = profile.get("resume", {}) if isinstance(profile, dict) else {}
    executive = ""
    if isinstance(resume, dict):
        block = resume.get("executive_profile", {})
        if isinstance(block, dict):
            executive = str(block.get("baseline_text", ""))
    facts_lines = "\n".join(
        f"- {fact.get('kind', '')}: {fact.get('value', '')}" for fact in contact_facts
    ) or "- (no confirmed contact facts)"
    return f"""You write short, truthful professional outreach messages for JobHunter.

Write a {kind} the user can send to the recipient below. Return ONLY JSON
matching the provided schema (a single "body" string).

HARD RULES (a violation makes the draft unusable):
- Reference ONLY facts present in the user's profile evidence or the confirmed
  contact record below. Invent nothing.
- Never claim a relationship, prior contact, referral, or shared history that is
  not stated in the evidence.
- Never invent or inflate a metric, date, title, employer, or skill.
- State only facts about the recipient that the confirmed contact record gives.
- Open with a brief greeting and end with a short sign-off. Keep it under ~150
  words. Professional, specific, and human — no stock phrases, no filler.

THE USER (executive profile):
{executive}

CONFIRMED CONTACT RECORD (the recipient):
{facts_lines}

APPLICATION CONTEXT:
- target company: {target_company or "(none)"}
- role in scope: {application_role or "(none)"}"""


@dataclass
class _OutreachDraftComposer:
    """Shared drafting core: LLM body generation + the full gate stack.

    Injected ``llm`` / ``clock`` / ``new_id`` keep the composer pure for tests.
    Both :class:`GenerateOutreachDraftUseCase` and
    :class:`ReviseOutreachDraftUseCase` build their draft through this so the gate
    stack is byte-identical whether the body was LLM-authored or user-edited.
    """

    llm: LlmPort
    clock: Callable[[], str] = _now
    new_id: Callable[[], str] = None  # type: ignore[assignment]
    judge_min_score: float = OUTREACH_JUDGE_MIN_SCORE

    def generate_body(
        self,
        *,
        profile: dict,
        contact: Contact,
        target_company: str,
        application_role: str,
        kind: OutreachDraftKind,
        model: str | None,
    ) -> str:
        prompt = build_outreach_draft_prompt(
            profile,
            kind=kind.value,
            contact_facts=_contact_facts(contact),
            target_company=target_company,
            application_role=application_role,
        )
        messages = [
            LlmMessage(role="system", content=prompt),
            LlmMessage(role="user", content="Write the outreach message and return the JSON."),
        ]
        response = self.llm.chat_json(
            messages,
            response_schema=OUTREACH_DRAFT_RESPONSE_SCHEMA,
            model=model,
            temperature=0.4,
        )
        body = str(response.get("body") or "").strip() if isinstance(response, dict) else ""
        if not body:
            raise OutreachDraftInputError("draft generation returned an empty body")
        return sanitize_text(body)

    def gate(
        self,
        *,
        body_text: str,
        profile: dict,
        contact: Contact,
        target_company: str,
        application_role: str,
        kind: OutreachDraftKind,
        model: str | None,
    ) -> tuple[DraftGateResults, tuple[OutreachClaimProvenance, ...]]:
        corpus = build_outreach_evidence_corpus(profile)
        contact_facts = _contact_facts(contact)
        fabrications = scan_outreach_draft(
            body_text,
            corpus,
            profile=profile,
            target_company=target_company,
            recipient_role=_recipient_role(contact),
            application_role=application_role,
        )
        validation = validate_outreach_draft(body_text)
        judge = self._run_judge(
            profile=profile,
            kind=kind,
            contact_facts=contact_facts,
            target_company=target_company,
            application_role=application_role,
            body_text=body_text,
            model=model,
        )
        provenance = compute_outreach_claim_provenance(
            body_text,
            corpus,
            contact_facts=contact_facts,
            new_id=self.new_id,
        )
        results = DraftGateResults.from_gates(
            fabrications=fabrications, validation=validation, judge=judge
        )
        return results, provenance

    def _run_judge(
        self,
        *,
        profile: dict,
        kind: OutreachDraftKind,
        contact_facts: list[dict[str, str]],
        target_company: str,
        application_role: str,
        body_text: str,
        model: str | None,
    ) -> JudgeVerdict:
        prompt = build_outreach_judge_prompt(
            profile,
            kind=kind.value,
            contact_facts=contact_facts,
            target_company=target_company,
            application_role=application_role,
        )
        messages = [
            LlmMessage(role="system", content=prompt),
            LlmMessage(
                role="user",
                content=f"OUTREACH DRAFT:\n{body_text}\n\nJudge this draft and return the JSON:",
            ),
        ]
        try:
            response = self.llm.chat_json(
                messages,
                response_schema=OUTREACH_JUDGE_RESPONSE_SCHEMA,
                model=model,
                temperature=0.0,
            )
        except Exception as exc:  # noqa: BLE001 — a judge failure is a FAIL verdict, not a crash
            return JudgeVerdict.failed(notes=f"judge error: {exc}")
        return parse_outreach_judge_response(response, min_score=self.judge_min_score)


@dataclass
class GenerateOutreachDraftUseCase:
    """Generate a fresh LLM-authored draft generation, gated (INV-5)."""

    repository: OutreachThreadRepository
    contact_repository: ContactRepository
    llm: LlmPort
    clock: Callable[[], str] = _now
    new_id: Callable[[], str] = None  # type: ignore[assignment]
    judge_min_score: float = OUTREACH_JUDGE_MIN_SCORE

    def execute(
        self,
        tenant_id: TenantId,
        *,
        thread_id: str,
        contact_id: str,
        job_id: str | None = None,
        kind: OutreachDraftKind = OutreachDraftKind.INTRO_REQUEST,
        profile: dict,
        application_role: str = "",
        model: str | None = None,
    ) -> OutreachThread:
        contact = self.contact_repository.load(tenant_id, contact_id)  # type: ignore[arg-type]
        if contact is None:
            raise OutreachDraftInputError(f"Contact {contact_id!r} not found")
        target_company = contact.link.employer or ""
        composer = _OutreachDraftComposer(
            llm=self.llm,
            clock=self.clock,
            new_id=self.new_id,
            judge_min_score=self.judge_min_score,
        )
        body_text = composer.generate_body(
            profile=profile,
            contact=contact,
            target_company=target_company,
            application_role=application_role,
            kind=kind,
            model=model,
        )
        return _persist_new_draft(
            repository=self.repository,
            composer=composer,
            tenant_id=tenant_id,
            thread_id=thread_id,
            contact=contact,
            job_id=job_id,
            kind=kind,
            body_text=body_text,
            profile=profile,
            target_company=target_company,
            application_role=application_role,
            model=model,
            clock=self.clock,
            new_id=self.new_id,
        )


@dataclass
class ReviseOutreachDraftUseCase:
    """Accept a user-edited body as a NEW generation and RE-RUN the gates (INV-5).

    Mirrors Apply Review resume edits: the edit is a validated replacement
    generation, never an in-place mutation of the prior draft. The prior approved
    draft (if any) stays readable until this revision is itself approved.
    """

    repository: OutreachThreadRepository
    contact_repository: ContactRepository
    llm: LlmPort
    clock: Callable[[], str] = _now
    new_id: Callable[[], str] = None  # type: ignore[assignment]
    judge_min_score: float = OUTREACH_JUDGE_MIN_SCORE

    def execute(
        self,
        tenant_id: TenantId,
        *,
        thread_id: str,
        edited_body_text: str,
        profile: dict,
        application_role: str = "",
        kind: OutreachDraftKind | None = None,
        model: str | None = None,
    ) -> OutreachThread:
        edited_body_text = (edited_body_text or "").strip()
        if not edited_body_text:
            raise OutreachDraftInputError("edited_body_text must be non-empty")
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachDraftInputError(f"Outreach thread {thread_id!r} not found")
        contact = self.contact_repository.load(tenant_id, thread.contact_id)  # type: ignore[arg-type]
        if contact is None:
            raise OutreachDraftInputError(f"Contact {thread.contact_id!r} not found")
        resolved_kind = kind or (
            thread.latest_draft.kind if thread.latest_draft else OutreachDraftKind.INTRO_REQUEST
        )
        target_company = contact.link.employer or ""
        composer = _OutreachDraftComposer(
            llm=self.llm,
            clock=self.clock,
            new_id=self.new_id,
            judge_min_score=self.judge_min_score,
        )
        return _persist_new_draft(
            repository=self.repository,
            composer=composer,
            tenant_id=tenant_id,
            thread_id=thread_id,
            contact=contact,
            job_id=thread.job_id,
            kind=resolved_kind,
            body_text=sanitize_text(edited_body_text),
            profile=profile,
            target_company=target_company,
            application_role=application_role,
            model=model,
            clock=self.clock,
            new_id=self.new_id,
            existing_thread=thread,
        )


@dataclass
class ApproveOutreachDraftUseCase:
    """Approve a candidate draft — only when its persisted gates passed (INV-5)."""

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now

    def execute(self, tenant_id: TenantId, *, thread_id: str, draft_id: str) -> OutreachThread:
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachDraftInputError(f"Outreach thread {thread_id!r} not found")
        thread = thread.approve_draft(draft_id, approved_at=self.clock())
        return self.repository.save(tenant_id, thread)


@dataclass
class RejectOutreachDraftUseCase:
    """Reject a candidate draft. Never destroys the last approved draft (INV-5)."""

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now

    def execute(
        self, tenant_id: TenantId, *, thread_id: str, draft_id: str, reason: str = ""
    ) -> OutreachThread:
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachDraftInputError(f"Outreach thread {thread_id!r} not found")
        thread = thread.reject_draft(draft_id, rejected_at=self.clock(), reason=reason)
        return self.repository.save(tenant_id, thread)


@dataclass
class LogOutreachSendUseCase:
    """Record a user-attested send of an approved draft (INV-1).

    JobHunter never sends: this use case writes the ``OutreachSendLog`` fact the
    user asserts ("I sent this on <date> via <channel>"). It refuses any draft
    that is not currently approved — "approve draft" and "log send" are distinct
    user actions — so a thread can only reach "sent" over a draft the user
    actually approved. There is no transport of any kind here.
    """

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now
    new_id: Callable[[], str] = None  # type: ignore[assignment]

    def execute(
        self,
        tenant_id: TenantId,
        *,
        thread_id: str,
        draft_id: str,
        channel: str,
        sent_at: str,
    ) -> OutreachThread:
        channel = (channel or "").strip()
        sent_at = (sent_at or "").strip()
        if not channel:
            raise OutreachSendLogInputError("channel must be a non-empty label")
        if not sent_at:
            raise OutreachSendLogInputError("sent_at must be a non-empty date")
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachSendLogInputError(f"Outreach thread {thread_id!r} not found")
        thread = thread.log_send(
            send_log_id=str(self.new_id()),
            draft_id=draft_id,
            channel=channel,
            sent_at=sent_at,
            logged_at=self.clock(),
        )
        return self.repository.save(tenant_id, thread)


@dataclass
class ScheduleFollowUpUseCase:
    """Schedule (or reset) the suggested next follow-up for a thread (plan §9).

    When ``due_at`` is omitted the date is DERIVED from the application lifecycle
    (:func:`suggest_follow_up`): 7 days after submission for the first follow-up,
    14 days for a subsequent nudge with no logged reply. The date is a suggestion
    the user can edit; it is surfaced as a due follow-up and never auto-acted or
    sent (INV-1).
    """

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now

    def execute(
        self,
        tenant_id: TenantId,
        *,
        thread_id: str,
        due_at: str | None = None,
        basis: str = "",
        submitted_at: str | None = None,
        has_logged_reply: bool = False,
    ) -> OutreachThread:
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachFollowUpInputError(f"Outreach thread {thread_id!r} not found")
        resolved_due = (due_at or "").strip()
        resolved_basis = basis
        if not resolved_due:
            suggestion = suggest_follow_up(
                submitted_at=submitted_at or "",
                last_follow_up_due_at=thread.follow_up.due_at,
                has_logged_reply=has_logged_reply,
            )
            if suggestion is None:
                raise OutreachFollowUpInputError(
                    "cannot suggest a follow-up date: provide an explicit due_at, or a "
                    "submission date with no logged reply"
                )
            resolved_due = suggestion.due_at
            resolved_basis = resolved_basis or suggestion.basis
        thread = thread.schedule_follow_up(
            due_at=resolved_due,
            basis=resolved_basis or FollowUpBasis.MANUAL,
            at=self.clock(),
        )
        return self.repository.save(tenant_id, thread)


@dataclass
class CompleteFollowUpUseCase:
    """Mark a thread's scheduled follow-up completed (an explicit user action)."""

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now

    def execute(self, tenant_id: TenantId, *, thread_id: str) -> OutreachThread:
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachFollowUpInputError(f"Outreach thread {thread_id!r} not found")
        thread = thread.complete_follow_up(at=self.clock())
        return self.repository.save(tenant_id, thread)


@dataclass
class DismissFollowUpUseCase:
    """Dismiss a thread's scheduled follow-up (an explicit user action)."""

    repository: OutreachThreadRepository
    clock: Callable[[], str] = _now

    def execute(self, tenant_id: TenantId, *, thread_id: str) -> OutreachThread:
        thread = self.repository.load(tenant_id, thread_id)
        if thread is None:
            raise OutreachFollowUpInputError(f"Outreach thread {thread_id!r} not found")
        thread = thread.dismiss_follow_up(at=self.clock())
        return self.repository.save(tenant_id, thread)


def _persist_new_draft(
    *,
    repository: OutreachThreadRepository,
    composer: _OutreachDraftComposer,
    tenant_id: TenantId,
    thread_id: str,
    contact: Contact,
    job_id: str | None,
    kind: OutreachDraftKind,
    body_text: str,
    profile: dict,
    target_company: str,
    application_role: str,
    model: str | None,
    clock: Callable[[], str],
    new_id: Callable[[], str],
    existing_thread: OutreachThread | None = None,
) -> OutreachThread:
    gate_results, provenance = composer.gate(
        body_text=body_text,
        profile=profile,
        contact=contact,
        target_company=target_company,
        application_role=application_role,
        kind=kind,
        model=model,
    )
    now = clock()
    thread = existing_thread
    if thread is None:
        thread = repository.load(tenant_id, thread_id) or OutreachThread.create(
            tenant_id=tenant_id,
            thread_id=thread_id,
            contact_id=str(contact.contact_id),
            job_id=job_id,
            created_at=now,
        )
    draft = OutreachDraft(
        draft_id=str(new_id()),
        thread_id=thread_id,
        generation=thread.next_generation(),
        kind=kind,
        status=ArtifactStatus.CANDIDATE,
        body_text=body_text,
        gate_results=gate_results,
        provenance=provenance,
        created_at=now,
    )
    thread = thread.add_draft(draft, at=now)
    return repository.save(tenant_id, thread)


__all__ = [
    "OUTREACH_DRAFT_RESPONSE_SCHEMA",
    "ApproveOutreachDraftUseCase",
    "CompleteFollowUpUseCase",
    "DismissFollowUpUseCase",
    "GenerateOutreachDraftUseCase",
    "LogOutreachSendUseCase",
    "OutreachDraftInputError",
    "OutreachFollowUpInputError",
    "OutreachSendLogInputError",
    "RejectOutreachDraftUseCase",
    "ReviseOutreachDraftUseCase",
    "ScheduleFollowUpUseCase",
    "build_outreach_draft_prompt",
]


# Suppress unused-import warnings for symbols re-exported for callers/tests.
_ = (ContactAttribute, json, field)
