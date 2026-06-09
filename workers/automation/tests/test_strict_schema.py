"""Unit tests for the OpenAI/Codex strict-schema adapter.

Pins the fix for the live 400 `invalid_json_schema` (additionalProperties must
be supplied and false) that the Codex leg hit with a plain Pydantic schema.
"""

from __future__ import annotations

from typing import Any

from jobhunter.domain.materials.analysis import JobAnalysis
from jobhunter.infrastructure.analysis.strict_schema import strict_json_schema


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


def test_optional_field_becomes_nullable() -> None:
    """An optional Pydantic field (requirement_ref: str | None) is made nullable
    and required, so the strict schema still accepts a null value."""
    strict = strict_json_schema(JobAnalysis.model_json_schema())
    # Find the ReasonedKeyword object def by locating a 'requirement_ref' property.
    holder = next(
        obj
        for obj in _walk_objects(strict)
        if isinstance(obj.get("properties"), dict) and "requirement_ref" in obj["properties"]
    )
    assert "requirement_ref" in holder["required"]
    ref = holder["properties"]["requirement_ref"]

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

    assert _allows_null(ref), ref


def test_strict_schema_does_not_mutate_input() -> None:
    """The transform returns a new dict and leaves the source schema untouched."""
    original = JobAnalysis.model_json_schema()
    import copy

    snapshot = copy.deepcopy(original)
    _ = strict_json_schema(original)
    assert original == snapshot


def test_idempotent() -> None:
    """Applying the transform twice yields the same result."""
    once = strict_json_schema(JobAnalysis.model_json_schema())
    twice = strict_json_schema(once)
    assert once == twice
