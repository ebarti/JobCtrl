"""Voice pass domain model — de-buzzword / vary-structure transform (Phase 3).

The explicit voice pass (VOICE-01/02/03) runs AFTER the selected candidate is
chosen and BEFORE the final audit, so the audited + coverage text equals the
rendered/PDF text (GROUND-06 / Pitfall 4). This module is the PURE half:

  * :class:`VoiceRequest` / :class:`VoicedBullet` / :class:`VoiceResult` — the
    typed contract the :class:`~jobhunter.domain.ports.materials.VoicePort`
    adapter (a Claude Agent SDK call) emits, mirroring how ``JobAnalysis`` is the
    contract the analysis SDK adapters emit.
  * :func:`apply_voice_to_payload` — deterministically folds the voiced prose back
    onto the SELECTED tailored payload, producing the canonical post-voice payload
    that BOTH renderers (LaTeX + HTML) and the final audit consume. Only the
    mutable PROSE is voiced (executive profile + experience bullets); skill term
    lists are left untouched (they are keyword lists, not prose, and re-voicing
    them risks dropping a grounded skill).

The voice pass NEVER invents facts: the adapter is instructed to preserve every
number/date/title/employer, and — crucially — the deterministic never-fabricate
detector + provenance builder are RE-RUN against the voiced text by the use case
(VOICE-03), so the prompt is not trusted; the gate is. Identity matching of which
bullet maps to which is by ``(experience_id, index)`` so a voiced bullet replaces
exactly its source line and the audit's bullet identity is preserved.

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
VOICE_PROMPT_VERSION = "voice-pass-v1"


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
    banned_terms: tuple[str, ...] = ()


@dataclass(frozen=True)
class VoiceResult:
    """The voiced prose returned by the voice pass (the SDK adapter output)."""

    executive_profile: str
    experience_bullets: tuple[tuple[str, tuple[str, ...]], ...]  # (experience_id, bullets)

    @classmethod
    def from_payload(cls, payload: VoicePayload) -> VoiceResult:
        return cls(
            executive_profile=payload.executive_profile or "",
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
        experience_bullets=tuple(experience_bullets),
        banned_terms=banned_terms,
    )


def apply_voice_to_payload(tailored_payload: dict, result: VoiceResult) -> dict:
    """Fold the voiced prose back onto the SELECTED payload (deterministic).

    Produces a NEW payload (a deep copy — the input is never mutated) whose
    executive profile and experience bullets are the voiced versions, and whose
    skills + structure are unchanged. The voiced executive profile is applied only
    when non-empty; an experience entry's bullets are replaced ONLY when the voice
    result supplies a matching id with a bullet count equal to the source's — a
    mismatched/partial voice response leaves that entry's original bullets intact
    so the audit's per-bullet identity is never silently corrupted.
    """
    voiced = copy.deepcopy(tailored_payload)

    if result.executive_profile.strip():
        voiced["executive_profile"] = result.executive_profile

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

    return voiced


@dataclass(frozen=True)
class VoicePassRecord:
    """Audit record of one voice pass — what it changed, by which proxy (VOICE-02).

    Persisted/surfaced so the voice edit is inspectable (not a hidden prompt
    tweak): whether the pass ran, the model that produced it, the prompt version,
    and the deterministic proxy delta (buzzword density / structural variety) that
    justified accepting the voiced payload. ``accepted`` records whether the voiced
    payload was kept (the proxies improved AND grounding re-validated) or rolled
    back to the pre-voice candidate.
    """

    ran: bool
    accepted: bool
    model: str = ""
    prompt_version: str = VOICE_PROMPT_VERSION
    proxy_delta: dict[str, Any] = field(default_factory=dict)
    reason: str = ""

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
]
