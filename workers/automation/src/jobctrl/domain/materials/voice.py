"""Voice pass domain model — narrow de-buzzword transform (Phase 3).

The explicit voice pass (VOICE-01/02/03) runs AFTER the selected candidate is
chosen and BEFORE the final audit, so the audited + coverage text equals the
rendered/PDF text (GROUND-06 / Pitfall 4). This module is the PURE half:

  * :class:`VoiceRequest` / :class:`VoicedBullet` / :class:`VoiceResult` — the
    typed contract the :class:`~jobctrl.domain.ports.materials.VoicePort`
    adapter (a Claude Agent SDK call) emits, mirroring how ``JobAnalysis`` is the
    contract the analysis SDK adapters emit.
  * :func:`apply_voice_to_payload` — deterministically folds the voiced prose back
    onto the SELECTED tailored payload, producing the canonical post-voice payload
    that the HTML renderer and the final audit consume. Only the
    mutable PROSE is voiced (executive profile + experience bullets); skill term
    lists are left untouched (they are keyword lists, not prose, and re-voicing
    them risks dropping a grounded skill).

The voice pass may edit only prose that contains a configured buzzword. It must
preserve actor, agency, action, causality, outcome, scope, stakeholder, certainty,
register, and every number/date/title/employer. The use case then re-runs claim
binding, quality, provenance, fabrication, and the final structured judge against
the voiced text, so the prompt is not trusted; the gates are. Identity matching
of each bullet uses ``(experience_id, index)`` so the audit identity is preserved.

Pure data, no I/O, no LLM. The SDK adapter + the use-case orchestration live in
their own layers.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# Bump when the voice system prompt / contract changes so audits can tell which
# voice contract produced a given generation (mirrors ``PROMPT_VERSION``).
VOICE_PROMPT_VERSION = "voice-pass-v3-semantic-fidelity"


# ---------------------------------------------------------------------------
# Structured voice contract (the shape the Claude Agent SDK adapter emits)
# ---------------------------------------------------------------------------


class VoicedExperience(BaseModel):
    """The voiced bullets for one experience entry, keyed by its stable id."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(..., description="The experience entry id these bullets belong to.")
    bullets: list[str] = Field(
        default_factory=list,
        description="The voiced bullets, in order, one per source bullet.",
    )


class VoicePayload(BaseModel):
    """The structured voice-pass output — voiced PROSE only (VOICE-01).

    Mirrors the mutable prose of the tailored payload: the executive profile and
    each experience entry's bullets. Skills are intentionally excluded (term
    lists, not prose). This is the schema the SDK adapter constrains output to,
    exactly like ``JobAnalysis`` for the analysis legs.
    """

    model_config = ConfigDict(extra="ignore")

    executive_profile: str = Field(
        default="",
        description="The voiced executive profile — de-buzzworded, same facts.",
    )
    executive_profile_sentences: list[str] = Field(
        ...,
        min_length=1,
        description=(
            "The voiced executive profile's ordered sentences; the one-space join must equal "
            "executive_profile and the item count must match the input."
        ),
    )
    experience_updates: list[VoicedExperience] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Request / result value objects (domain-side; what the use case passes/gets)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceRequest:
    """The de-voiced prose the voice pass is asked to humanise.

    Carries the SELECTED candidate's prose plus the small banned-buzzword/stock-phrase
    lexicon the pass should avoid, so the adapter prompt can name concrete
    anti-patterns (the positive-style + anti-pattern-list technique). Bullets are
    grouped by experience id so the response maps 1:1 back onto the payload.
    """

    executive_profile: str
    experience_bullets: tuple[tuple[str, tuple[str, ...]], ...]  # (experience_id, bullets)
    executive_profile_sentences: tuple[str, ...] = ()
    banned_terms: tuple[str, ...] = ()


@dataclass(frozen=True)
class VoiceResult:
    """The voiced prose returned by the voice pass (the SDK adapter output)."""

    executive_profile: str
    experience_bullets: tuple[tuple[str, tuple[str, ...]], ...]  # (experience_id, bullets)
    executive_profile_sentences: tuple[str, ...] = ()

    @classmethod
    def from_payload(cls, payload: VoicePayload) -> VoiceResult:
        return cls(
            executive_profile=payload.executive_profile or "",
            executive_profile_sentences=tuple(
                str(sentence) for sentence in payload.executive_profile_sentences
            ),
            experience_bullets=tuple(
                (entry.id, tuple(str(bullet) for bullet in entry.bullets))
                for entry in payload.experience_updates
                if entry.id
            ),
        )


def build_voice_request(
    tailored_payload: dict,
    *,
    banned_terms: tuple[str, ...] = (),
) -> VoiceRequest:
    """Extract the voice-pass request from the SELECTED tailored payload.

    Only the mutable prose is extracted: the executive profile and each
    experience entry's bullets, grouped by id so the result maps back exactly.
    """
    experience_bullets: list[tuple[str, tuple[str, ...]]] = []
    for update in tailored_payload.get("experience_updates") or []:
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "")
        if not entry_id:
            continue
        bullets = tuple(
            str(bullet) for bullet in (update.get("bullets") or []) if str(bullet).strip()
        )
        if bullets:
            experience_bullets.append((entry_id, bullets))
    return VoiceRequest(
        executive_profile=str(tailored_payload.get("executive_profile") or ""),
        executive_profile_sentences=tuple(
            str(sentence)
            for sentence in tailored_payload.get("executive_profile_sentences") or ()
            if str(sentence).strip()
        ),
        experience_bullets=tuple(experience_bullets),
        banned_terms=banned_terms,
    )


def summary_voice_rejection_reason(tailored_payload: dict, result: VoiceResult) -> str:
    """Why the voiced summary cannot replace the source summary, or "" when it can.

    This is the sentence-identity gate ``apply_voice_to_payload`` applies before
    adopting the voiced executive profile. A non-empty reason means the original
    (last accepted) summary is preserved and only bullets may be voiced — callers
    must record that reason on the voice audit trail so the drop is inspectable
    rather than silent.
    """
    source_summary_sentences = tuple(
        str(sentence)
        for sentence in tailored_payload.get("executive_profile_sentences") or ()
        if str(sentence).strip()
    )
    voiced_summary_sentences = tuple(
        str(sentence) for sentence in result.executive_profile_sentences
    )
    if not result.executive_profile:
        return "voiced_summary_missing"
    if not all(
        sentence and sentence == sentence.strip() for sentence in voiced_summary_sentences
    ):
        return "voiced_summary_sentence_outer_whitespace"
    if len(voiced_summary_sentences) != len(source_summary_sentences):
        return "voiced_summary_sentence_count_mismatch"
    if " ".join(voiced_summary_sentences) != result.executive_profile:
        return "voiced_summary_sentence_join_mismatch"
    return ""


def apply_voice_to_payload(tailored_payload: dict, result: VoiceResult) -> dict:
    """Fold the voiced prose back onto the SELECTED payload (deterministic).

    Produces a NEW payload (a deep copy — the input is never mutated) whose
    executive profile and experience bullets are the voiced versions, and whose
    skills + structure are unchanged. The voiced executive profile is applied only
    when it passes the sentence-identity gate (``summary_voice_rejection_reason``);
    an experience entry's bullets are replaced ONLY when the voice result supplies
    a matching id with a bullet count equal to the source's — a mismatched/partial
    voice response leaves that entry's original bullets intact so the audit's
    per-bullet identity is never silently corrupted.
    """
    voiced = copy.deepcopy(tailored_payload)

    if not summary_voice_rejection_reason(tailored_payload, result):
        voiced["executive_profile"] = result.executive_profile
        voiced["executive_profile_sentences"] = [
            str(sentence) for sentence in result.executive_profile_sentences
        ]

    voiced_by_id = {entry_id: bullets for entry_id, bullets in result.experience_bullets}
    for update in voiced.get("experience_updates") or []:
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "")
        replacement = voiced_by_id.get(entry_id)
        if replacement is None:
            continue
        source_bullets = [
            str(bullet) for bullet in (update.get("bullets") or []) if str(bullet).strip()
        ]
        # Replace 1:1 only — equal count keeps bullet identity ((id, index)) stable.
        if len(replacement) == len(source_bullets) and all(b.strip() for b in replacement):
            update["bullets"] = list(replacement)

    _rebind_generated_claim_mapping_text(tailored_payload, voiced)

    return voiced


def _rebind_generated_claim_mapping_text(source: dict, voiced: dict) -> None:
    """Keep claim mappings byte-bound to the prose that actually ships."""

    replacements: dict[str, tuple[str, str]] = {}
    source_sentences = [
        str(item) for item in source.get("executive_profile_sentences") or ()
    ]
    voiced_sentences = [
        str(item) for item in voiced.get("executive_profile_sentences") or ()
    ]
    if len(source_sentences) == len(voiced_sentences):
        for index, (before, after) in enumerate(zip(source_sentences, voiced_sentences, strict=True)):
            replacements[f"executive_profile.sentence[{index}]"] = (before, after)
        if len(source_sentences) == 1:
            pair = (
                str(source.get("executive_profile") or ""),
                str(voiced.get("executive_profile") or ""),
            )
            for location in ("executive_profile", "summary", "resume.executive_profile"):
                replacements[location] = pair

    voiced_updates = {
        str(update.get("id") or ""): update
        for update in voiced.get("experience_updates") or ()
        if isinstance(update, dict) and str(update.get("id") or "")
    }
    for update_index, update in enumerate(source.get("experience_updates") or ()):
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "")
        voiced_update = voiced_updates.get(entry_id)
        if voiced_update is None:
            continue
        before_bullets = [str(item) for item in update.get("bullets") or ()]
        after_bullets = [str(item) for item in voiced_update.get("bullets") or ()]
        if len(before_bullets) != len(after_bullets):
            continue
        for bullet_index, (before, after) in enumerate(
            zip(before_bullets, after_bullets, strict=True)
        ):
            pair = (before, after)
            for location in (
                f"experience.{entry_id}.bullets[{bullet_index}]",
                f"experience_updates.{entry_id}.bullets[{bullet_index}]",
                f"experience_updates[{update_index}].bullets[{bullet_index}]",
            ):
                replacements[location] = pair

    mappings = voiced.get("generated_claim_mappings")
    if not isinstance(mappings, list):
        return
    for mapping in mappings:
        if not isinstance(mapping, dict):
            continue
        location = _canonical_voice_claim_location(str(mapping.get("location") or ""))
        replacement = replacements.get(location)
        if replacement is None:
            continue
        before, after = replacement
        if str(mapping.get("text") or "") == before:
            mapping["text"] = after


def _canonical_voice_claim_location(location: str) -> str:
    import re

    normalized = str(location or "").strip()
    sentence_match = re.fullmatch(
        r"(?:(?:profile\.)?(?:executive_profile|summary))(?:\.sentences?)?\[(\d+)\]",
        normalized,
    )
    if sentence_match:
        return f"executive_profile.sentence[{sentence_match.group(1)}]"
    return re.sub(r"\.bullet\[(\d+)\]$", r".bullets[\1]", normalized)


def voice_scope_violations(
    source_payload: dict,
    voiced_payload: dict,
    *,
    banned_terms: tuple[str, ...],
) -> tuple[str, ...]:
    """Reject edits to already-clean claims.

    The voice pass exists only to remove a named banned phrase. Structural
    variation or synonym preference is not authority to alter a clean claim.
    """

    def has_banned_term(text: str) -> bool:
        lowered = str(text or "").casefold()
        return any(str(term or "").casefold() in lowered for term in banned_terms if term)

    violations: list[str] = []
    source_sentences = [str(item) for item in source_payload.get("executive_profile_sentences") or ()]
    voiced_sentences = [str(item) for item in voiced_payload.get("executive_profile_sentences") or ()]
    if len(source_sentences) == len(voiced_sentences):
        for index, (before, after) in enumerate(zip(source_sentences, voiced_sentences, strict=True)):
            if before != after and not has_banned_term(before):
                violations.append(
                    f"executive_profile.sentence[{index}] changed without a banned phrase in the source"
                )

    voiced_by_id = {
        str(update.get("id") or ""): update
        for update in voiced_payload.get("experience_updates") or ()
        if isinstance(update, dict)
    }
    for update in source_payload.get("experience_updates") or ():
        if not isinstance(update, dict):
            continue
        entry_id = str(update.get("id") or "")
        voiced_update = voiced_by_id.get(entry_id)
        if voiced_update is None:
            continue
        before_bullets = [str(item) for item in update.get("bullets") or ()]
        after_bullets = [str(item) for item in voiced_update.get("bullets") or ()]
        if len(before_bullets) != len(after_bullets):
            continue
        for index, (before, after) in enumerate(zip(before_bullets, after_bullets, strict=True)):
            if before != after and not has_banned_term(before):
                violations.append(
                    f"experience.{entry_id}.bullets[{index}] changed without a banned phrase in the source"
                )
    return tuple(violations)


@dataclass(frozen=True)
class VoicePassRecord:
    """Audit record of one narrow voice pass and its final gates (VOICE-02).

    Persisted/surfaced so the voice edit is inspectable (not a hidden prompt
    tweak): whether the pass ran, the model that produced it, the prompt version,
    and the deterministic proxy delta. Only reduced buzzword density can justify
    the edit; structural variety is diagnostic. ``accepted`` records whether the
    voiced payload also passed scope, claim, grounding, quality, fabrication, and
    final judge gates or rolled back to the pre-voice candidate.
    ``summary_rejection_reason`` labels the
    post-generation sentence-identity gate: when non-empty, the voiced summary was
    dropped for that reason and the last accepted summary shipped, even though
    voiced bullets may still have been adopted (``accepted`` alone reflects the
    bullet proxies, not the summary).
    """

    ran: bool
    accepted: bool
    model: str = ""
    prompt_version: str = VOICE_PROMPT_VERSION
    proxy_delta: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    summary_rejection_reason: str = ""
    scope_violations: tuple[str, ...] = ()
    final_judge: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def skipped(cls, reason: str) -> VoicePassRecord:
        return cls(ran=False, accepted=False, reason=reason)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ran": self.ran,
            "accepted": self.accepted,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "proxy_delta": dict(self.proxy_delta),
            "reason": self.reason,
            "summary_rejection_reason": self.summary_rejection_reason,
            "scope_violations": list(self.scope_violations),
            "final_judge": dict(self.final_judge),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> VoicePassRecord | None:
        """Rehydrate a persisted voice-pass audit record (or None when absent)."""
        if not data:
            return None
        proxy_delta = data.get("proxy_delta")
        return cls(
            ran=bool(data.get("ran", False)),
            accepted=bool(data.get("accepted", False)),
            model=str(data.get("model") or ""),
            prompt_version=str(data.get("prompt_version") or VOICE_PROMPT_VERSION),
            proxy_delta=dict(proxy_delta) if isinstance(proxy_delta, dict) else {},
            reason=str(data.get("reason") or ""),
            summary_rejection_reason=str(data.get("summary_rejection_reason") or ""),
            scope_violations=tuple(
                str(value) for value in data.get("scope_violations") or () if str(value)
            ),
            final_judge=(
                dict(data.get("final_judge"))
                if isinstance(data.get("final_judge"), dict)
                else {}
            ),
        )


__all__ = [
    "VOICE_PROMPT_VERSION",
    "VoicePayload",
    "VoicePassRecord",
    "VoiceRequest",
    "VoiceResult",
    "VoicedExperience",
    "apply_voice_to_payload",
    "build_voice_request",
    "summary_voice_rejection_reason",
    "voice_scope_violations",
]
