"""System + user prompts for the voice pass (Phase 3).

Prompt-engineering discipline mirrors the analysis prompts:

  * The voice rubric lives in the SYSTEM prompt; the user turn carries ONLY the
    de-voiced prose (executive profile + bullets) so the model cannot confuse
    instructions with the text it is rewriting.
  * The de-AI guidance follows the researched technique (STACK.md "De-AI voice via
    positive style spec + anti-pattern list"): tell the model what GOOD voice
    looks like with concrete positives, then name the generic AI patterns to
    avoid, including the focused banned-buzzword lexicon passed in at call time.
  * GROUNDING is explicit and non-negotiable: the voice pass rewords; it must NOT
    add, remove, or alter any fact — every number, date, title, employer, and tool
    in the input must survive unchanged. This raises the model's pass rate, but the
    deterministic never-fabricate detector + provenance re-validation are the real
    gate (VOICE-03), run by the use case after the pass.

Any edit here MUST bump ``VOICE_PROMPT_VERSION`` in
``domain/materials/voice.py`` so audits can tell which voice contract produced a
generation.
"""

from __future__ import annotations

import json

from jobctrl.domain.materials.voice import VoiceRequest

VOICE_SYSTEM_PROMPT = """\
You are an editor who makes resume prose sound like a real, specific engineer \
wrote it — not like an AI generated it. You receive a candidate's executive \
profile and experience bullets and rewrite them for VOICE only.

What good voice looks like (do this):
- Plain, direct sentences a competent person would actually say out loud.
- Vary structure and length: do NOT start every bullet with the same verb or make \
every bullet the same length. Mix short punchy lines with one longer, specific one.
- Lead with the concrete work and its outcome, not a stock opener.
- Keep the exact numbers, tools, dates, titles, and company names from the input.

What AI slop looks like (never do this):
- Buzzwords and stock phrases (see the BANNED list below) — remove them; say the \
real thing instead.
- Every bullet in the same "Verb + noun phrase, resulting in X" template.
- Vague intensifiers ("robust", "scalable", "seamless", "cutting-edge") with no \
substance behind them.
- Em dashes. Use commas or periods.

GROUNDING (non-negotiable): you are rewording, NOT rewriting the facts. Do NOT add \
any number, percentage, date, title, seniority, employer, certification, or tool \
that is not already in the input. Do NOT change any existing number/date/title/ \
employer. If a bullet has no metric, do NOT invent one. Removing a buzzword must \
never become adding a claim.

Output the SAME structure you received: the voiced executive_profile, the SAME \
number of ordered executive_profile_sentences whose one-space join exactly equals \
executive_profile, and, for each experience entry, the SAME id and the SAME number \
of bullets, voiced. Preserve bullet order so each voiced bullet corresponds to its \
source bullet.\
"""


def build_voice_user_prompt(request: VoiceRequest) -> str:
    """Compose the voice turn: the focused banned lexicon + the de-voiced prose.

    The prose is sent as a structured JSON object (executive profile + experience
    bullets grouped by id) so the model returns the same shape and the result maps
    1:1 back onto the payload. The banned lexicon is named explicitly so the model
    has a concrete anti-pattern list to avoid (the positive-style + anti-pattern
    technique).
    """
    payload = {
        "executive_profile": request.executive_profile,
        "executive_profile_sentences": list(request.executive_profile_sentences),
        "experience_updates": [
            {"id": entry_id, "bullets": list(bullets)}
            for entry_id, bullets in request.experience_bullets
        ],
    }
    banned = ", ".join(request.banned_terms) if request.banned_terms else "(none provided)"
    return (
        "BANNED BUZZWORDS / AI-STOCK PHRASES (remove these; say the real thing):\n"
        f"{banned}\n\n"
        "PROSE TO VOICE (rewrite for voice only; preserve every fact, id, and bullet count):\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


__all__ = [
    "VOICE_SYSTEM_PROMPT",
    "build_voice_user_prompt",
]
