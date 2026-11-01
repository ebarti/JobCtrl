"""Voice generation prompts; accepted rewrites need claim and quality determinations.

Any change bumps VOICE_PROMPT_VERSION in domain/materials/voice.py.
"""

from __future__ import annotations

import json

from jobctrl.domain.materials.voice import VoiceRequest

VOICE_SYSTEM_PROMPT = """Edit the supplied resume prose for professional clarity and natural voice.
Make the smallest useful changes while preserving the actor, action, outcome, scope,
stakeholder, agency, causality, certainty and register of every claim. Preserve all
facts, numbers, tools, dates, titles and employers. Return unchanged prose when an
edit would not improve it. Invent no facts. Follow the supplied strict schema.
Preserve every ID, ordered summary sentence and experience bullet position and count.
The one-space join of executive_profile_sentences must equal executive_profile.
Final claim verification and a separate artifact-quality determination govern acceptance."""


def build_voice_user_prompt(request: VoiceRequest) -> str:
    """Supply only the selected prose and stable structural identifiers."""
    payload = {
        "executive_profile": request.executive_profile,
        "executive_profile_sentences": list(request.executive_profile_sentences),
        "experience_updates": [
            {"id": entry_id, "bullets": list(bullets)} for entry_id, bullets in request.experience_bullets
        ],
    }
    return (
        "PROSE TO VOICE (rewrite for voice only; preserve every fact, id, and bullet count):\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


__all__ = [
    "VOICE_SYSTEM_PROMPT",
    "build_voice_user_prompt",
]
