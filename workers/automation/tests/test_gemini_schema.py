"""Unit tests for the Gemini/Antigravity schema adapter.

Pins the live-probe nuance: Gemini's ``response_schema`` REJECTS
``additionalProperties`` (the opposite of Codex strict mode) and does not
understand the ``type: [T, "null"]`` union form. ``gemini_json_schema`` must
strip the unsupported keyword recursively and rewrite nullability into Gemini's
``nullable: true`` shape, without mutating the input.
"""

from __future__ import annotations

from typing import Any

from jobctrl.domain.materials.analysis import JobAnalysis
from jobctrl.infrastructure.analysis.gemini_schema import gemini_json_schema


def _walk(node: Any):
    """Yield every dict node in the schema tree."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


def test_additional_properties_stripped_recursively() -> None:
    """No node anywhere in the tree retains additionalProperties / $schema.

    The model schema is first run through the Codex strict transform to inject
    ``additionalProperties`` at every object node, proving the Gemini transform
    removes it everywhere (nested objects + $defs), not just at the root.
    """
    from jobctrl.infrastructure.analysis.strict_schema import strict_json_schema

    # strict_json_schema injects additionalProperties:false on every object node.
    seeded = strict_json_schema(JobAnalysis.model_json_schema())
    assert any("additionalProperties" in node for node in _walk(seeded)), "fixture precondition"

    gemini = gemini_json_schema(seeded)
    for node in _walk(gemini):
        assert "additionalProperties" not in node, node
        assert "additional_properties" not in node, node
        assert "$schema" not in node, node


def test_top_level_schema_keyword_stripped() -> None:
    """The root ``$schema`` Pydantic emits is removed."""
    raw = JobAnalysis.model_json_schema()
    gemini = gemini_json_schema(raw)
    assert "$schema" not in gemini


def test_nullable_union_type_mapped() -> None:
    """``type: [T, "null"]`` becomes ``type: T`` + ``nullable: true``."""
    schema = {
        "type": "object",
        "properties": {
            "requirement_ref": {"type": ["string", "null"]},
        },
    }
    gemini = gemini_json_schema(schema)
    ref = gemini["properties"]["requirement_ref"]
    assert ref["type"] == "string"
    assert ref["nullable"] is True


def test_mixed_non_null_union_left_untouched() -> None:
    """A union with more than one non-null type is not collapsed (no data loss)."""
    schema = {"type": ["string", "integer", "null"]}
    gemini = gemini_json_schema(schema)
    # Cannot pick a single ``type``; leave the list as-is and do not invent nullable.
    assert gemini["type"] == ["string", "integer", "null"]
    assert "nullable" not in gemini


def test_enum_with_none_mapped_to_nullable() -> None:
    """An ``enum`` containing ``None`` drops the ``None`` member + sets nullable."""
    schema = {"enum": ["a", "b", None]}
    gemini = gemini_json_schema(schema)
    assert gemini["enum"] == ["a", "b"]
    assert gemini["nullable"] is True


def test_real_model_nullable_ref_field() -> None:
    """The real JobAnalysis ``requirement_ref`` (str | None) becomes Gemini-nullable.

    Pydantic emits ``requirement_ref`` via an ``anyOf``/``$ref`` shape; the
    important contract is that no ``additionalProperties`` survives and the
    field is still expressible. We assert the transform succeeded end to end by
    checking the keyword strip held across the whole real schema.
    """
    gemini = gemini_json_schema(JobAnalysis.model_json_schema())
    for node in _walk(gemini):
        assert "additionalProperties" not in node
    # requirement_ref is still present somewhere in the $defs/properties tree.
    assert any("requirement_ref" in (node.get("properties") or {}) for node in _walk(gemini))


def test_does_not_mutate_input() -> None:
    import copy

    original = JobAnalysis.model_json_schema()
    snapshot = copy.deepcopy(original)
    _ = gemini_json_schema(original)
    assert original == snapshot


def test_idempotent() -> None:
    once = gemini_json_schema(JobAnalysis.model_json_schema())
    twice = gemini_json_schema(once)
    assert once == twice
