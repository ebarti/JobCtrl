"""Voice payload application (Phase 3) — fold voiced prose back onto the payload.

Pins the deterministic ``apply_voice_to_payload`` contract: the voiced executive
profile + bullets replace the SELECTED payload's prose 1:1, skills + structure are
untouched, the input is never mutated, and a mismatched/partial voice response
leaves the original bullets intact (so per-bullet audit identity ((id, index)) is
never silently corrupted).
"""

from __future__ import annotations

from jobctrl.domain.materials.voice import (
    VoicePayload,
    VoiceResult,
    apply_voice_to_payload,
    build_voice_request,
)


def _payload() -> dict:
    return {
        "executive_profile": "Spearheaded robust solutions.",
        "experience_updates": [
            {"id": "acme", "title": "", "bullets": ["Leveraged synergy.", "Drove value."]},
        ],
        "skill_category_updates": [{"id": "lang", "items": ["Python", "Go"]}],
    }


def test_build_request_extracts_prose_grouped_by_id() -> None:
    request = build_voice_request(_payload(), banned_terms=("spearheaded",))
    assert request.executive_profile == "Spearheaded robust solutions."
    assert request.experience_bullets == (("acme", ("Leveraged synergy.", "Drove value.")),)
    assert request.banned_terms == ("spearheaded",)


def test_apply_replaces_prose_and_preserves_skills_and_structure() -> None:
    result = VoiceResult(
        executive_profile="Cut deploy time to ten minutes by rebuilding the pipeline.",
        experience_bullets=(("acme", ("Cut latency 40%.", "Owned billing end to end.")),),
    )
    voiced = apply_voice_to_payload(_payload(), result)
    assert voiced["executive_profile"].startswith("Cut deploy time")
    assert voiced["experience_updates"][0]["bullets"] == [
        "Cut latency 40%.",
        "Owned billing end to end.",
    ]
    # Skills are NOT voiced — term lists left untouched.
    assert voiced["skill_category_updates"] == [{"id": "lang", "items": ["Python", "Go"]}]
    # Title slot preserved.
    assert voiced["experience_updates"][0]["title"] == ""


def test_apply_does_not_mutate_the_input_payload() -> None:
    original = _payload()
    result = VoiceResult(
        executive_profile="Rebuilt the pipeline.",
        experience_bullets=(("acme", ("A.", "B.")),),
    )
    apply_voice_to_payload(original, result)
    assert original["executive_profile"] == "Spearheaded robust solutions."
    assert original["experience_updates"][0]["bullets"] == ["Leveraged synergy.", "Drove value."]


def test_apply_keeps_original_bullets_on_count_mismatch() -> None:
    """A voice response with a different bullet count for an entry is NOT applied —
    1:1 replacement keeps ((id, index)) bullet identity stable for the audit."""
    result = VoiceResult(
        executive_profile="",
        experience_bullets=(("acme", ("Only one bullet now.",)),),  # source has 2
    )
    voiced = apply_voice_to_payload(_payload(), result)
    assert voiced["experience_updates"][0]["bullets"] == ["Leveraged synergy.", "Drove value."]


def test_apply_skips_empty_executive_profile() -> None:
    result = VoiceResult(executive_profile="   ", experience_bullets=())
    voiced = apply_voice_to_payload(_payload(), result)
    assert voiced["executive_profile"] == "Spearheaded robust solutions."


def test_voice_result_from_payload_maps_ids() -> None:
    payload = VoicePayload(
        executive_profile="Voiced summary.",
        experience_updates=[{"id": "acme", "bullets": ["b1", "b2"]}],
    )
    result = VoiceResult.from_payload(payload)
    assert result.executive_profile == "Voiced summary."
    assert result.experience_bullets == (("acme", ("b1", "b2")),)
