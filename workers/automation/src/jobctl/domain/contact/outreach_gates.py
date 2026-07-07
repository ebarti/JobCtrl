"""Truthfulness gate stack for outreach drafts (INV-5) — R6 Phase 3.

An outreach draft is a first-person claims document sent to a real person, so it
reuses the Materials gate stack verbatim — exactly as the cover-letter path does
(``scan_cover_letter`` already runs the resume gates over first-person prose).
The gates, in order (outreach planner plan §7):

1. **Deterministic never-fabricate detector** (:func:`scan_outreach_draft`,
   delegating to ``scan_cover_letter``): a draft may reference only facts grounded
   in the candidate profile + the confirmed contact record + the application — no
   invented metrics, dates, titles, employers, or named technologies. Runs against
   the ACTUAL draft text, never the target.
2. **Content validator** (:func:`validate_outreach_draft`): reuses ``BANNED_WORDS``
   + ``LLM_LEAK_PHRASES`` for stock-phrase / model-self-talk rejection, plus
   outreach-appropriate structural checks (greeting, sign-off, length).
3. **LLM-as-judge** (:data:`OUTREACH_JUDGE_RESPONSE_SCHEMA`,
   :func:`build_outreach_judge_prompt`, :func:`parse_outreach_judge_response`): an
   outreach-specific rubric that FAILs any unsupported claim or fabricated
   relationship. The use case supplies the ``LlmPort``.
4. **Claim -> fact provenance** (:func:`compute_outreach_claim_provenance`):
   each claim in the draft binds to the confirmed fact it rests on, computed
   against the rendered draft text (never inferred from the target).

:class:`DraftGateResults` aggregates 1-3 into the persisted, projected, and
rendered audit record; ``passed`` is the single authority the aggregate gates
approval on (INV-5).

The recipient's own facts (name, title, employer) come from the CONFIRMED contact
record, so referencing them is legitimate: the recipient's employer is passed as
the ``target_company`` exemption and the recipient's/application's role titles
ground the title arm — mirroring how a cover letter legitimately names the job it
targets. A fabricated relationship ("we worked together at X") is caught by the
judge, whose rubric fails unsupported relationship claims.

Pure data + pure functions except where an ``LlmPort`` is passed in; no I/O, no
network. Unit-tested directly.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from jobctl.domain.materials.fabrication_detector import (
    KNOWN_TECHNOLOGY_LEXICON,
    EvidenceCorpus,
    FabricationFinding,
    build_evidence_corpus,
    build_skill_vocabulary,
    employer_name_set,
    scan_cover_letter,
)
from jobctl.domain.materials.services import (
    BANNED_WORDS,
    LLM_LEAK_PHRASES,
)
from jobctl.domain.materials.value_objects import JudgeVerdict, ValidationResult

COMPUTED_AGAINST_DRAFT = "rendered_draft_text"

_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")
_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+.#-]*")
_GREETING_RE = re.compile(r"(?i)^(hi|hello|dear|hey|greetings)\b")
_WHITESPACE_RE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# Evidence corpus (gate 1 grounding source)
# ---------------------------------------------------------------------------


def build_outreach_evidence_corpus(profile: Mapping[str, Any]) -> EvidenceCorpus:
    """The candidate profile evidence a draft's first-person claims must trace to.

    Identical to the resume/cover-letter grounding corpus: the user's own
    experience, evidence, metrics, and education. The RECIPIENT's facts are NOT
    folded in here — they are handled as the ``target_company`` / role exemptions
    in :func:`scan_outreach_draft`, because the user references (not claims) them.
    """
    return build_evidence_corpus(dict(profile))


def _draft_technology_terms(draft_text: str) -> tuple[str, ...]:
    """Named-technology tokens present in the draft, for the prose skill gate.

    A draft that name-drops a tool the candidate cannot back (``Kubernetes`` in a
    k8s-free profile) is interview-fatal; scanning the draft's own tech tokens as
    the ``target_skill_terms`` lets the reused skill gate flag exactly those.
    """
    lowered = draft_text.lower()
    seen: list[str] = []
    for token in _WORD_RE.findall(lowered):
        if token in KNOWN_TECHNOLOGY_LEXICON and token not in seen:
            seen.append(token)
    return tuple(seen)


# ---------------------------------------------------------------------------
# Gate 1 — deterministic never-fabricate detector
# ---------------------------------------------------------------------------


def scan_outreach_draft(
    draft_text: str,
    corpus: EvidenceCorpus,
    *,
    profile: Mapping[str, Any],
    target_company: str = "",
    recipient_role: str = "",
    application_role: str = "",
) -> list[FabricationFinding]:
    """Run the resume grounding gates over an outreach draft (reuses the cover path).

    Delegates to ``scan_cover_letter`` — the exact deterministic guards the resume
    and cover letter use — treating the recipient's confirmed employer as the
    legitimately-named ``target_company`` and the recipient/application roles as
    the grounded title context. An empty list means every metric/date/title/
    employer/named-technology token in the draft traces to profile evidence.
    """
    combined_role = " ".join(part for part in (recipient_role, application_role) if part)
    return scan_cover_letter(
        draft_text,
        corpus,
        employers=employer_name_set(dict(profile)),
        target_company=target_company,
        job_title=combined_role,
        target_skill_terms=_draft_technology_terms(draft_text),
        allowed_skill_terms=build_skill_vocabulary(dict(profile)),
    )


def _finding_to_read_model(finding: FabricationFinding) -> dict[str, Any]:
    return {
        "section": finding.bullet_id,
        "kind": finding.kind,
        "token": finding.token,
        "control": finding.control.value,
        "generatedText": finding.generated_text,
    }


# ---------------------------------------------------------------------------
# Gate 2 — content validator (banned words / self-talk / structure)
# ---------------------------------------------------------------------------


def validate_outreach_draft(text: str, *, mode: str = "normal") -> ValidationResult:
    """Programmatic validation of an outreach draft.

    Reuses the materials ``BANNED_WORDS`` + ``LLM_LEAK_PHRASES`` lists (stock
    phrases downgrade quality; model self-talk is always fatal) and applies
    outreach-appropriate structure: a greeting, a short sign-off, and a length
    ceiling (outreach is a short relationship message, not a cover letter).
    """
    errors: list[str] = []
    warnings: list[str] = []
    text_lower = text.lower()

    if "—" in text or "–" in text:
        errors.append("Contains em dash or en dash.")

    if mode != "lenient":
        found = [w for w in BANNED_WORDS if re.search(r"\b" + re.escape(w) + r"\b", text_lower)]
        if found:
            message = f"Banned words: {', '.join(found[:5])}"
            (errors if mode == "strict" else warnings).append(message)

    found_leaks = [p for p in LLM_LEAK_PHRASES if p in text_lower]
    if found_leaks:
        errors.append(f"LLM self-talk: '{found_leaks[0]}'")

    words = len(text.split())
    if mode == "strict" and words > 200:
        errors.append(f"Too long ({words} words). Max 200 for an outreach message.")
    elif words > 250:
        warnings.append(f"Long ({words} words). Target under 200 for outreach.")

    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if len(lines) < 2:
        errors.append("Must have a greeting and a sign-off.")
    else:
        if not _GREETING_RE.match(lines[0]):
            errors.append("Must open with a greeting (e.g. 'Hi <name>,').")
        closing = lines[-1]
        if len(closing.split()) > 8 or closing.endswith(("?",)):
            errors.append("Must end with a short closing/sign-off line.")

    if errors:
        return ValidationResult.failure(tuple(errors), warnings=tuple(warnings))
    return ValidationResult.success(warnings=tuple(warnings))


# ---------------------------------------------------------------------------
# Gate 3 — LLM-as-judge
# ---------------------------------------------------------------------------

OUTREACH_JUDGE_CRITERIA: tuple[str, ...] = (
    "relevance_to_recipient",
    "evidence_support",
    "fabrication_safety",
    "relationship_accuracy",
    "tone_professionalism",
)

OUTREACH_JUDGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "OutreachDraftJudgeResult",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "verdict",
        "score",
        "criterion_scores",
        "issues",
        "unsupported_claims",
        "fabricated_relationships",
        "repair_instructions",
    ],
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "criterion_scores": {
            "type": "object",
            "additionalProperties": False,
            "required": list(OUTREACH_JUDGE_CRITERIA),
            "properties": {
                criterion: {"type": "number", "minimum": 0, "maximum": 1}
                for criterion in OUTREACH_JUDGE_CRITERIA
            },
        },
        "issues": {"type": "array", "items": {"type": "string"}},
        "unsupported_claims": {"type": "array", "items": {"type": "string"}},
        "fabricated_relationships": {"type": "array", "items": {"type": "string"}},
        "repair_instructions": {"type": "array", "items": {"type": "string"}},
    },
}

OUTREACH_JUDGE_MIN_SCORE = 0.82


def build_outreach_judge_prompt(
    profile: Mapping[str, Any],
    *,
    kind: str,
    contact_facts: Sequence[Mapping[str, str]] = (),
    target_company: str = "",
    application_role: str = "",
) -> str:
    """Build the outreach-draft judge prompt from canonical evidence.

    The judge sees the SAME canonical evidence the deterministic detector grounds
    against (profile) PLUS the confirmed contact record and application context,
    so it can fail any claim the draft makes that those sources do not support —
    especially a fabricated relationship, which the deterministic arms cannot see.
    """
    resume = profile.get("resume", {}) if isinstance(profile, Mapping) else {}
    executive = ""
    if isinstance(resume, Mapping):
        executive_block = resume.get("executive_profile", {})
        if isinstance(executive_block, Mapping):
            executive = str(executive_block.get("baseline_text", ""))
    experience = profile.get("experience") if isinstance(profile, Mapping) else None
    facts_lines = "\n".join(
        f"- {fact.get('kind', '')}: {fact.get('value', '')}" for fact in contact_facts
    ) or "- (no confirmed contact facts)"

    return f"""You are the truthfulness judge for a JobCtl outreach message.

Return ONLY JSON matching the provided schema. Do not include markdown.

The user is sending a {kind} to a real person. Decide whether the draft is safe
to send: every claim it makes must be supported by the canonical evidence below,
and it must not invent a relationship, a shared employer, a metric, a title, or
any fact about the recipient that the confirmed contact record does not state.

PASS only when ALL of these hold:
- Every first-person claim about the user's experience is supported by the
  canonical profile evidence.
- Every fact stated about the RECIPIENT (name, title, employer) matches the
  confirmed contact record; nothing about the recipient is invented.
- The draft does NOT claim a relationship, prior contact, referral, or shared
  history that the evidence does not support (a fabricated relationship is an
  automatic FAIL — list it in fabricated_relationships).
- No invented or inflated metrics, dates, titles, employers, or skills.
- The tone is professional and appropriate for a cold/warm professional message.

FAIL for any unsupported claim, fabricated relationship, or invented recipient
fact. Repair instructions should tell the generator what to remove or ground.

CANONICAL EXECUTIVE PROFILE (the user):
{executive}

CANONICAL EXPERIENCE (the user):
{json.dumps(experience, indent=2, ensure_ascii=False, default=str)}

CONFIRMED CONTACT RECORD (the recipient — the ONLY facts the draft may state about them):
{facts_lines}

APPLICATION CONTEXT:
- target company: {target_company or "(none)"}
- role in scope: {application_role or "(none)"}

criterion_scores dimensions: {", ".join(OUTREACH_JUDGE_CRITERIA)}."""


def _as_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text and text.lower() != "none" else []
    if isinstance(value, (list, tuple)):
        items: list[str] = []
        for item in value:
            text = str(item).strip()
            if text and text.lower() != "none":
                items.append(text)
        return items
    return []


def parse_outreach_judge_response(
    response: Mapping[str, Any],
    *,
    min_score: float = OUTREACH_JUDGE_MIN_SCORE,
) -> JudgeVerdict:
    """Parse a structured judge response into a :class:`JudgeVerdict`.

    Mirrors the tailoring judge parser: PASS requires an explicit PASS verdict, a
    score at/above the floor, AND no blockers (unsupported claims or fabricated
    relationships). Any of those failing yields a non-approved verdict whose
    ``issues`` carry the blockers for the audit trail.
    """
    if not isinstance(response, Mapping):
        return JudgeVerdict.failed(notes="judge error: response was not an object")
    verdict = str(response.get("verdict") or "FAIL").strip().upper()
    try:
        score = float(response.get("score") or 0.0)
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(1.0, score))
    issues = _as_string_list(response.get("issues"))
    unsupported = _as_string_list(response.get("unsupported_claims"))
    fabricated = _as_string_list(response.get("fabricated_relationships"))
    repairs = _as_string_list(response.get("repair_instructions"))
    blockers = unsupported + fabricated
    try:
        criterion_scores = {
            str(key): float(value)
            for key, value in dict(response.get("criterion_scores") or {}).items()
        }
    except (TypeError, ValueError):
        return JudgeVerdict.failed(notes="judge error: invalid criterion_scores")
    if not criterion_scores:
        return JudgeVerdict.failed(notes="judge error: missing criterion_scores")
    approved = verdict == "PASS" and score >= min_score and not blockers
    notes_payload = {
        "verdict": verdict,
        "score": score,
        "issues": issues,
        "unsupported_claims": unsupported,
        "fabricated_relationships": fabricated,
        "repair_instructions": repairs,
        "criterion_scores": criterion_scores,
    }
    return JudgeVerdict(
        approved=approved,
        score=score,
        notes=json.dumps(notes_payload, ensure_ascii=False, sort_keys=True),
        criterion_scores=criterion_scores,
        issues=tuple(dict.fromkeys(issues + blockers)),
    )


# ---------------------------------------------------------------------------
# Gate 4 — claim -> fact provenance (INV-2), computed against rendered text
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OutreachClaimProvenance:
    """One claim in a draft bound to the confirmed fact(s) it rests on (INV-2).

    ``generated_text`` is the actual claim text (the anchor coverage/grounding is
    computed against — never the target). ``contact_fact_ids`` are the confirmed
    contact attribute ids the claim references; ``profile_grounded`` records
    whether the claim's non-recipient content traces to the profile evidence
    corpus. Both are computed against the rendered draft text.
    """

    claim_id: str
    section: str
    generated_text: str
    contact_fact_ids: tuple[str, ...] = field(default_factory=tuple)
    profile_grounded: bool = False
    rationale: str = ""

    def to_read_model(self) -> dict[str, Any]:
        return {
            "claimId": self.claim_id,
            "section": self.section,
            "generatedText": self.generated_text,
            "contactFactIds": list(self.contact_fact_ids),
            "profileGrounded": self.profile_grounded,
            "rationale": self.rationale,
        }

    @classmethod
    def from_read_model(cls, data: Mapping[str, Any]) -> "OutreachClaimProvenance":
        return cls(
            claim_id=str(data.get("claimId") or data.get("claim_id") or ""),
            section=str(data.get("section") or ""),
            generated_text=str(data.get("generatedText") or data.get("generated_text") or ""),
            contact_fact_ids=tuple(
                str(item)
                for item in (data.get("contactFactIds") or data.get("contact_fact_ids") or ())
            ),
            profile_grounded=bool(data.get("profileGrounded") or data.get("profile_grounded")),
            rationale=str(data.get("rationale") or ""),
        )


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip().lower()


def _contains_value(value: str, normalized_text: str) -> bool:
    normalized_value = _normalize(value)
    if not normalized_value:
        return False
    if re.fullmatch(r"[a-z0-9 ]+", normalized_value):
        return re.search(r"\b" + re.escape(normalized_value) + r"\b", normalized_text) is not None
    return normalized_value in normalized_text


def compute_outreach_claim_provenance(
    draft_text: str,
    corpus: EvidenceCorpus,
    *,
    contact_facts: Sequence[Mapping[str, str]] = (),
    new_id: Any,
) -> tuple[OutreachClaimProvenance, ...]:
    """Bind each claim (paragraph) in the draft to its supporting facts (INV-2).

    For each non-empty paragraph, records the confirmed contact attribute ids
    whose value appears in it and whether its remaining content is grounded in the
    profile evidence corpus. Computed strictly against the rendered ``draft_text``.
    """
    paragraphs = [
        paragraph.strip()
        for paragraph in _PARAGRAPH_SPLIT_RE.split(draft_text)
        if paragraph.strip()
    ] or ([draft_text.strip()] if draft_text.strip() else [])
    claims: list[OutreachClaimProvenance] = []
    for index, paragraph in enumerate(paragraphs):
        normalized = _normalize(paragraph)
        fact_ids: list[str] = []
        for fact in contact_facts:
            attribute_id = str(fact.get("attribute_id") or fact.get("attributeId") or "")
            value = str(fact.get("value") or "")
            if attribute_id and value and _contains_value(value, normalized):
                fact_ids.append(attribute_id)
        profile_grounded = any(
            corpus.contains_term_variant(word)
            for word in _WORD_RE.findall(normalized)
            if len(word) > 3
        )
        if fact_ids and profile_grounded:
            rationale = "References the confirmed contact and profile-grounded experience."
        elif fact_ids:
            rationale = "References the confirmed contact record."
        elif profile_grounded:
            rationale = "Grounded in the candidate's profile evidence."
        else:
            rationale = "Salutation / sign-off / non-claim text."
        claims.append(
            OutreachClaimProvenance(
                claim_id=str(new_id()),
                section=f"outreach[{index}]",
                generated_text=paragraph,
                contact_fact_ids=tuple(fact_ids),
                profile_grounded=profile_grounded,
                rationale=rationale,
            )
        )
    return tuple(claims)


# ---------------------------------------------------------------------------
# Aggregated gate results (persisted, projected, rendered)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DraftGateResults:
    """The persisted outcome of the truthfulness gate stack for one draft.

    ``passed`` is the single authority draft approval is gated on (INV-5): a draft
    passes only when the deterministic detector found NO fabrications, the content
    validator passed, and the judge approved. Serialised to
    ``outreach_drafts.gate_results_json`` and surfaced (labelled by lifecycle) in
    the review UI per the CLAUDE.md root-cause/auditability discipline.
    """

    fabrications: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    validation: ValidationResult = field(default_factory=ValidationResult.success)
    judge: JudgeVerdict | None = None
    computed_against: str = COMPUTED_AGAINST_DRAFT

    @property
    def passed(self) -> bool:
        return (
            not self.fabrications
            and self.validation.passed
            and self.judge is not None
            and self.judge.approved
        )

    @classmethod
    def from_gates(
        cls,
        *,
        fabrications: Iterable[FabricationFinding],
        validation: ValidationResult,
        judge: JudgeVerdict | None,
    ) -> "DraftGateResults":
        return cls(
            fabrications=tuple(_finding_to_read_model(finding) for finding in fabrications),
            validation=validation,
            judge=judge,
        )

    def to_read_model(self) -> dict[str, Any]:
        judge = self.judge
        judge_shape: dict[str, Any] | None = None
        if judge is not None:
            judge_shape = {
                "approved": judge.approved,
                "score": judge.score,
                "criterionScores": dict(judge.criterion_scores),
                "issues": list(judge.issues),
                "notes": judge.notes,
            }
        return {
            "passed": self.passed,
            "computedAgainst": self.computed_against,
            "fabrications": [dict(finding) for finding in self.fabrications],
            "validation": {
                "passed": self.validation.passed,
                "errors": list(self.validation.errors),
                "warnings": list(self.validation.warnings),
            },
            "judge": judge_shape,
        }

    @classmethod
    def from_read_model(cls, data: Mapping[str, Any] | None) -> "DraftGateResults":
        if not data:
            return cls()
        validation = ValidationResult.from_dict(data.get("validation"))
        judge_data = data.get("judge")
        judge: JudgeVerdict | None = None
        if isinstance(judge_data, Mapping):
            judge = JudgeVerdict(
                approved=bool(judge_data.get("approved")),
                score=float(judge_data.get("score") or 0.0),
                notes=str(judge_data.get("notes") or ""),
                criterion_scores={
                    str(key): float(value)
                    for key, value in dict(
                        judge_data.get("criterionScores")
                        or judge_data.get("criterion_scores")
                        or {}
                    ).items()
                },
                issues=tuple(str(item) for item in (judge_data.get("issues") or ())),
            )
        fabrications = tuple(
            dict(finding)
            for finding in (data.get("fabrications") or ())
            if isinstance(finding, Mapping)
        )
        return cls(
            fabrications=fabrications,
            validation=validation,
            judge=judge,
            computed_against=str(data.get("computedAgainst") or COMPUTED_AGAINST_DRAFT),
        )


__all__ = [
    "COMPUTED_AGAINST_DRAFT",
    "OUTREACH_JUDGE_CRITERIA",
    "OUTREACH_JUDGE_MIN_SCORE",
    "OUTREACH_JUDGE_RESPONSE_SCHEMA",
    "DraftGateResults",
    "OutreachClaimProvenance",
    "build_outreach_evidence_corpus",
    "build_outreach_judge_prompt",
    "compute_outreach_claim_provenance",
    "parse_outreach_judge_response",
    "scan_outreach_draft",
    "validate_outreach_draft",
]
