"""Unit tests for the OpenAI/Codex strict-schema adapter.

Pins the fix for the live 400 `invalid_json_schema` (additionalProperties must
be supplied and false) AND the follow-up: the strict transform must NOT invent
nullability, or Codex emits null for a non-null model field (e.g. rationale) and
the parsed payload fails `JobAnalysis.model_validate_json`, silently degrading
the Codex leg.
"""

from __future__ import annotations

from typing import Any

from jobctrl.domain.materials.analysis import JobAnalysis
from jobctrl.infrastructure.analysis.strict_schema import strict_json_schema


def _walk_objects(node: Any):
    """Yield every JSON-Schema object node (type == 'object') in the tree."""
    if isinstance(node, dict):
        if node.get("type") == "object":
            yield node
        for value in node.values():
            yield from _walk_objects(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_objects(item)


def _allows_null(schema: dict[str, Any]) -> bool:
    t = schema.get("type")
    if t == "null" or (isinstance(t, list) and "null" in t):
        return True
    for key in ("anyOf", "oneOf"):
        variants = schema.get(key)
        if isinstance(variants, list) and any(
            isinstance(v, dict) and _allows_null(v) for v in variants
        ):
            return True
    return False


def _property(schema: dict[str, Any], name: str) -> dict[str, Any]:
    holder = next(
        obj
        for obj in _walk_objects(schema)
        if isinstance(obj.get("properties"), dict) and name in obj["properties"]
    )
    return holder["properties"][name]


def test_every_object_is_strict() -> None:
    """Every object node sets additionalProperties:false and requires all props."""
    strict = strict_json_schema(JobAnalysis.model_json_schema())
    objects = list(_walk_objects(strict))
    assert objects, "expected at least one object node"
    for obj in objects:
        assert obj.get("additionalProperties") is False, obj
        props = obj.get("properties")
        if isinstance(props, dict):
            assert set(obj.get("required", [])) == set(props.keys()), obj


def test_already_nullable_field_stays_nullable_and_required() -> None:
    """requirement_ref (str | None in the model) stays nullable AND becomes required."""
    strict = strict_json_schema(JobAnalysis.model_json_schema())
    ref = _property(strict, "requirement_ref")
    assert _allows_null(ref), ref
    holder = next(
        o for o in _walk_objects(strict) if "requirement_ref" in (o.get("properties") or {})
    )
    assert "requirement_ref" in holder["required"]


def test_defaulted_nonnull_field_is_required_but_not_nullable() -> None:
    """A non-null defaulted field (rationale: str = "") must NOT be made nullable.

    This is the regression: if it were nullable, Codex could emit null and the
    parsed payload would fail JobAnalysis validation.
    """
    strict = strict_json_schema(JobAnalysis.model_json_schema())
    rationale = _property(strict, "rationale")
    assert not _allows_null(rationale), rationale
    is_orphan = _property(strict, "is_orphan")
    assert not _allows_null(is_orphan), is_orphan


def test_strict_valid_payload_round_trips_through_model() -> None:
    """A payload valid against the strict schema validates against JobAnalysis,
    including a null requirement_ref (orphan keyword)."""
    payload = {
        "role_framing": "Build payments backend.",
        "inferred_seniority": "senior",
        "ideal_candidate_narrative": "Seasoned backend engineer.",
        "requirements": [
            {
                "id": "r1",
                "text": "6+ years Python",
                "tier": "must_have",
                "weight": 0.9,
                "evidence_span": "6+ years Python",
            }
        ],
        "keywords": [
            {
                "keyword": "Python",
                "evidence_span": "6+ years Python",
                "requirement_ref": None,  # nullable field, legitimately null
                "rationale": "core language",
                "is_orphan": False,
            }
        ],
    }
    analysis = JobAnalysis.model_validate(payload)
    assert analysis.keywords[0].requirement_ref is None
    assert analysis.keywords[0].is_orphan is True  # recomputed: ref None -> orphan


def test_strict_schema_does_not_mutate_input() -> None:
    import copy

    original = JobAnalysis.model_json_schema()
    snapshot = copy.deepcopy(original)
    _ = strict_json_schema(original)
    assert original == snapshot


def test_idempotent() -> None:
    once = strict_json_schema(JobAnalysis.model_json_schema())
    twice = strict_json_schema(once)
    assert once == twice
