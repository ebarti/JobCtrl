"""Voice payload application (Phase 3) — fold voiced prose back onto the payload.

Pins the deterministic ``apply_voice_to_payload`` contract: the voiced executive
profile + bullets replace the SELECTED payload's prose 1:1, skills + structure are
untouched, the input is never mutated, and a mismatched/partial voice response
leaves the original bullets intact (so per-bullet audit identity ((id, index)) is
never silently corrupted).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from jobctrl.domain.materials.voice import (
    VoicePassRecord,
    VoicePayload,
    VoiceResult,
    apply_voice_to_payload,
    build_voice_request,
    summary_voice_rejection_reason,
)


def _payload() -> dict:
    return {
        "executive_profile": "Spearheaded robust solutions.",
        "executive_profile_sentences": ["Spearheaded robust solutions."],
        "experience_updates": [
            {"id": "acme", "title": "", "bullets": ["Leveraged synergy.", "Drove value."]},
        ],
        "skill_category_updates": [{"id": "lang", "items": ["Python", "Go"]}],
    }


def test_build_request_extracts_prose_grouped_by_id() -> None:
    request = build_voice_request(_payload(), banned_terms=("spearheaded",))
    assert request.executive_profile == "Spearheaded robust solutions."
    assert request.executive_profile_sentences == ("Spearheaded robust solutions.",)
    assert request.experience_bullets == (("acme", ("Leveraged synergy.", "Drove value.")),)
    assert request.banned_terms == ("spearheaded",)


def test_apply_replaces_prose_and_preserves_skills_and_structure() -> None:
    result = VoiceResult(
        executive_profile="Cut deploy time to ten minutes by rebuilding the pipeline.",
        executive_profile_sentences=(
            "Cut deploy time to ten minutes by rebuilding the pipeline.",
        ),
        experience_bullets=(("acme", ("Cut latency 40%.", "Owned billing end to end.")),),
    )
    voiced = apply_voice_to_payload(_payload(), result)
    assert voiced["executive_profile"].startswith("Cut deploy time")
    assert voiced["executive_profile_sentences"] == [
        "Cut deploy time to ten minutes by rebuilding the pipeline."
    ]
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
        executive_profile_sentences=("Rebuilt the pipeline.",),
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


def test_apply_keeps_original_summary_when_sentence_contract_does_not_reconstruct() -> None:
    result = VoiceResult(
        executive_profile="Rebuilt the pipeline. Cut deploy time.",
        executive_profile_sentences=("Rebuilt the pipeline.",),
        experience_bullets=(),
    )

    voiced = apply_voice_to_payload(_payload(), result)

    assert voiced["executive_profile"] == "Spearheaded robust solutions."
    assert voiced["executive_profile_sentences"] == ["Spearheaded robust solutions."]
    assert (
        summary_voice_rejection_reason(_payload(), result)
        == "voiced_summary_sentence_join_mismatch"
    )


def test_apply_keeps_original_summary_when_voiced_profile_has_outer_whitespace() -> None:
    result = VoiceResult(
        executive_profile=" Rebuilt the pipeline. ",
        executive_profile_sentences=("Rebuilt the pipeline.",),
        experience_bullets=(),
    )

    voiced = apply_voice_to_payload(_payload(), result)

    assert voiced["executive_profile"] == "Spearheaded robust solutions."
    assert voiced["executive_profile_sentences"] == ["Spearheaded robust solutions."]
    assert (
        summary_voice_rejection_reason(_payload(), result)
        == "voiced_summary_sentence_join_mismatch"
    )


@pytest.mark.parametrize(
    ("result", "expected_reason"),
    [
        (
            VoiceResult(
                executive_profile="Rebuilt the pipeline.",
                experience_bullets=(),
                executive_profile_sentences=("Rebuilt the pipeline.",),
            ),
            "",
        ),
        (
            VoiceResult(
                executive_profile="",
                experience_bullets=(),
                executive_profile_sentences=(),
            ),
            "voiced_summary_missing",
        ),
        (
            VoiceResult(
                executive_profile="Rebuilt the pipeline.",
                experience_bullets=(),
                executive_profile_sentences=(" Rebuilt the pipeline.",),
            ),
            "voiced_summary_sentence_outer_whitespace",
        ),
        (
            VoiceResult(
                executive_profile="Rebuilt the pipeline.",
                experience_bullets=(),
                executive_profile_sentences=(),
            ),
            "voiced_summary_sentence_count_mismatch",
        ),
        (
            VoiceResult(
                executive_profile="Rebuilt the pipeline. Cut deploy time.",
                experience_bullets=(),
                executive_profile_sentences=("Rebuilt the pipeline.",),
            ),
            "voiced_summary_sentence_join_mismatch",
        ),
    ],
)
def test_summary_voice_rejection_reason_labels_every_identity_gate_branch(
    result: VoiceResult, expected_reason: str
) -> None:
    """The gate that keeps the last accepted summary is never silent: each branch
    yields an inspectable reason, and "" means the voiced summary is adopted."""
    assert summary_voice_rejection_reason(_payload(), result) == expected_reason

    voiced = apply_voice_to_payload(_payload(), result)
    if expected_reason:
        assert voiced["executive_profile"] == "Spearheaded robust solutions."
    else:
        assert voiced["executive_profile"] == "Rebuilt the pipeline."


def test_voice_payload_schema_requires_summary_sentences() -> None:
    """The SDK output_format uses this schema verbatim: a voice model may not omit
    the sentence array, or summary voicing would be silently disabled forever."""
    schema = VoicePayload.model_json_schema()

    assert "executive_profile_sentences" in schema["required"]
    assert schema["properties"]["executive_profile_sentences"]["minItems"] == 1
    with pytest.raises(ValidationError):
        VoicePayload.model_validate({"executive_profile": "x", "experience_updates": []})
    with pytest.raises(ValidationError):
        VoicePayload.model_validate(
            {"executive_profile": "x", "executive_profile_sentences": []}
        )


def test_voice_pass_record_round_trips_summary_rejection_reason() -> None:
    record = VoicePassRecord(
        ran=True,
        accepted=True,
        summary_rejection_reason="voiced_summary_sentence_count_mismatch",
    )

    data = record.to_dict()
    assert data["summary_rejection_reason"] == "voiced_summary_sentence_count_mismatch"
    rehydrated = VoicePassRecord.from_dict(data)
    assert rehydrated is not None
    assert rehydrated.summary_rejection_reason == "voiced_summary_sentence_count_mismatch"
    # Older persisted records without the key rehydrate to the empty label.
    legacy = VoicePassRecord.from_dict({"ran": True, "accepted": True})
    assert legacy is not None
    assert legacy.summary_rejection_reason == ""


def test_voice_result_from_payload_maps_ids() -> None:
    payload = VoicePayload(
        executive_profile="Voiced summary.",
        executive_profile_sentences=["Voiced summary."],
        experience_updates=[{"id": "acme", "bullets": ["b1", "b2"]}],
    )
    result = VoiceResult.from_payload(payload)
    assert result.executive_profile == "Voiced summary."
    assert result.executive_profile_sentences == ("Voiced summary.",)
    assert result.experience_bullets == (("acme", ("b1", "b2")),)
