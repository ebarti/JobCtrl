"""Pure orchestration for supervised contact research (no I/O).

``ContactResearchService`` walks the user's opted-in sources, authorises each
against the :class:`ContactResearchSourcePolicy` (INV-3) **before any fetch**,
fetches allowed public pages through the injected gateway-routed
:class:`ResearchPageFetcherPort` (§5.3), and extracts candidate contacts with the
injected :class:`LlmPort` using a schema-driven ``chat_json`` call (§5.2).

The service is pure domain logic: fetch, LLM, id, and clock are all injected so
tests swap fakes without touching the network. It never promotes a candidate to
a stored fact — every candidate lands ``needs_review`` (INV-4) with provenance on
each attribute (INV-2), and every source attempt (including robots/rate-limit/
budget/rejected/manual-capture outcomes) is recorded as provenance of the search.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from jobctrl.domain.contact.research import (
    CandidateStatus,
    ContactCandidate,
    ResearchSourceAttempt,
    ResearchSourceOutcome,
)
from jobctrl.domain.contact.source_policy import (
    ContactResearchSourcePolicy,
    ResearchSourceCategory,
    ResearchSourceDecision,
)
from jobctrl.domain.contact.value_objects import (
    ContactAttribute,
    ContactFactProvenance,
    ContactRole,
)
from jobctrl.domain.ports.contact import ResearchPageFetcherPort
from jobctrl.domain.ports.llm import LlmMessage, LlmPort

# Attribute kinds an extracted candidate can carry, keyed by the LLM field name.
_CANDIDATE_ATTRIBUTE_FIELDS: tuple[tuple[str, str], ...] = (
    ("name", "name"),
    ("title", "title"),
    ("email", "email"),
    ("profileUrl", "profile_url"),
)

CANDIDATE_EXTRACTION_SCHEMA: dict = {
    "type": "object",
    "title": "ContactResearchCandidates",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "title": {"type": "string"},
                    "email": {"type": "string"},
                    "profileUrl": {"type": "string"},
                    "role": {
                        "type": "string",
                        "enum": [role.value for role in ContactRole],
                    },
                    "confidence": {"type": "number"},
                },
                "required": ["name"],
            },
        }
    },
    "required": ["candidates"],
}

_EXTRACTION_SYSTEM_PROMPT = (
    "You extract publicly-listed professional contacts (recruiter, hiring "
    "manager, referrer) from the text of one public web page. Only report a "
    "person the page explicitly names; never invent a name, title, or email. "
    "Return an empty list when the page names no relevant contact."
)


@dataclass(frozen=True)
class ResearchSourceSpec:
    """One source the user opted in to for a research run."""

    category: str
    url: str = ""
    label: str = ""


@dataclass(frozen=True)
class ResearchRunResult:
    candidates: tuple[ContactCandidate, ...] = field(default_factory=tuple)
    source_attempts: tuple[ResearchSourceAttempt, ...] = field(default_factory=tuple)


@dataclass
class ContactResearchService:
    policy: ContactResearchSourcePolicy

    def research(
        self,
        *,
        task_id: str,
        sources: tuple[ResearchSourceSpec, ...],
        fetcher: ResearchPageFetcherPort,
        llm: LlmPort,
        clock: Callable[[], str],
        new_id: Callable[[], str],
        model: str | None = None,
    ) -> ResearchRunResult:
        candidates: list[ContactCandidate] = []
        attempts: list[ResearchSourceAttempt] = []
        for spec in sources:
            decision = self.policy.authorize(category=spec.category, url=spec.url)
            source_ref = spec.url.strip() or spec.label.strip() or spec.category
            if decision is ResearchSourceDecision.REJECTED:
                attempts.append(
                    ResearchSourceAttempt(
                        source_kind=spec.category,
                        source_ref=source_ref,
                        outcome=ResearchSourceOutcome.REJECTED.value,
                        attempted_at=clock(),
                        detail="Source not permitted by the conservative allowlist (INV-3).",
                    )
                )
                continue
            if decision is ResearchSourceDecision.MANUAL_CAPTURE_REQUIRED:
                attempts.append(
                    ResearchSourceAttempt(
                        source_kind=spec.category,
                        source_ref=source_ref,
                        outcome=ResearchSourceOutcome.MANUAL_CAPTURE_REQUIRED.value,
                        attempted_at=clock(),
                        detail=self.policy.manual_capture_reason(spec.url).value,
                    )
                )
                continue
            # ALLOWED. user_entered / user_imported_list carry no network fetch in
            # this service — they are recorded directly by the CRUD/import paths.
            if spec.category != ResearchSourceCategory.PUBLIC_WEB_PAGE.value:
                continue
            self._research_public_page(
                task_id=task_id,
                spec=spec,
                source_ref=source_ref,
                fetcher=fetcher,
                llm=llm,
                clock=clock,
                new_id=new_id,
                model=model,
                candidates=candidates,
                attempts=attempts,
            )
        return ResearchRunResult(
            candidates=tuple(candidates), source_attempts=tuple(attempts)
        )

    def _research_public_page(
        self,
        *,
        task_id: str,
        spec: ResearchSourceSpec,
        source_ref: str,
        fetcher: ResearchPageFetcherPort,
        llm: LlmPort,
        clock: Callable[[], str],
        new_id: Callable[[], str],
        model: str | None,
        candidates: list[ContactCandidate],
        attempts: list[ResearchSourceAttempt],
    ) -> None:
        fetched = fetcher.fetch(spec.url)
        if fetched.outcome != ResearchSourceOutcome.ALLOWED.value:
            # Robots-denial / rate-limit / budget-exhaustion are outcomes, not errors.
            attempts.append(
                ResearchSourceAttempt(
                    source_kind=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                    source_ref=source_ref,
                    outcome=fetched.outcome,
                    attempted_at=clock(),
                )
            )
            return
        page_text = (fetched.text or "").strip()
        if not page_text:
            attempts.append(
                ResearchSourceAttempt(
                    source_kind=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                    source_ref=source_ref,
                    outcome=ResearchSourceOutcome.NO_CANDIDATES.value,
                    attempted_at=clock(),
                    detail="Fetched page produced no extractable text.",
                )
            )
            return
        extracted = self._extract_candidates(
            llm=llm, page_text=page_text, source_ref=source_ref, model=model
        )
        proposed = 0
        for item in extracted:
            candidate = self._build_candidate(
                task_id=task_id,
                item=item,
                source_ref=source_ref,
                clock=clock,
                new_id=new_id,
            )
            if candidate is not None:
                candidates.append(candidate)
                proposed += 1
        attempts.append(
            ResearchSourceAttempt(
                source_kind=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
                source_ref=source_ref,
                outcome=(
                    ResearchSourceOutcome.ALLOWED.value
                    if proposed
                    else ResearchSourceOutcome.NO_CANDIDATES.value
                ),
                attempted_at=clock(),
                detail=f"proposed:{proposed}",
            )
        )

    def _extract_candidates(
        self,
        *,
        llm: LlmPort,
        page_text: str,
        source_ref: str,
        model: str | None,
    ) -> list[dict]:
        messages = [
            LlmMessage(role="system", content=_EXTRACTION_SYSTEM_PROMPT),
            LlmMessage(
                role="user",
                content=(
                    f"Public page: {source_ref}\n\n"
                    f"Page text:\n{page_text[:12000]}\n\n"
                    "Extract the relevant contacts as JSON."
                ),
            ),
        ]
        try:
            response = llm.chat_json(
                messages,
                response_schema=CANDIDATE_EXTRACTION_SCHEMA,
                model=model,
            )
        except Exception:  # noqa: BLE001 — an extraction failure is an outcome, not a crash
            return []
        raw = response.get("candidates") if isinstance(response, dict) else None
        return [item for item in raw or [] if isinstance(item, dict)]

    def _build_candidate(
        self,
        *,
        task_id: str,
        item: dict,
        source_ref: str,
        clock: Callable[[], str],
        new_id: Callable[[], str],
    ) -> ContactCandidate | None:
        now = clock()
        confidence = _confidence(item.get("confidence"))
        provenance = ContactFactProvenance(
            source_kind=ResearchSourceCategory.PUBLIC_WEB_PAGE.value,
            source_ref=source_ref,
            capture_method="llm_assisted",
            captured_at=now,
            confidence=confidence,
            user_confirmed=False,
        )
        attributes: list[ContactAttribute] = []
        for field_name, kind in _CANDIDATE_ATTRIBUTE_FIELDS:
            value = str(item.get(field_name) or "").strip()
            if value:
                attributes.append(
                    ContactAttribute(
                        attribute_id=new_id(),
                        kind=kind,
                        value=value,
                        provenance=provenance,
                    )
                )
        if not attributes:
            return None
        return ContactCandidate(
            candidate_id=new_id(),
            task_id=task_id,
            role=_role(item.get("role")),
            attributes=tuple(attributes),
            provenance=provenance,
            confidence=confidence,
            status=CandidateStatus.NEEDS_REVIEW,
            proposed_at=now,
        )


def _confidence(value: object) -> float:
    try:
        confidence = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, confidence))


def _role(value: object) -> ContactRole:
    try:
        return ContactRole(str(value).strip().lower())
    except ValueError:
        return ContactRole.OTHER


__all__ = [
    "CANDIDATE_EXTRACTION_SCHEMA",
    "ContactResearchService",
    "ResearchRunResult",
    "ResearchSourceSpec",
]
