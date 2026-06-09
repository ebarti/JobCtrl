"""OpenAI/Codex strict JSON-Schema adaptation for structured output.

Discovered by a live smoke test: the Codex SDK's ``output_schema`` rejects a
plain Pydantic ``model_json_schema()`` with::

    400 invalid_request_error / invalid_json_schema:
    'additionalProperties' is required to be supplied and to be false.

OpenAI strict structured output requires every object node to set
``additionalProperties: false`` AND to list *every* property in ``required``.
Pydantic v2 emits neither by default. :func:`strict_json_schema` rewrites the
schema to satisfy strict mode while preserving "optional" semantics by making
non-required properties accept ``null`` (so the parsed object still validates
against the original Pydantic model, where those fields are ``X | None`` /
defaulted).

Mirrors the canonical helper in mestre (``mestre/structured_output.py::
strict_json_schema``). Pure dict manipulation — recurses into ``$defs`` and
nested objects; leaves ``$ref`` nodes untouched (the referenced def is
tightened in place).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _allows_null(schema: Mapping[str, Any]) -> bool:
    schema_type = schema.get("type")
    if schema_type == "null":
        return True
    if isinstance(schema_type, list) and "null" in schema_type:
        return True
    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and None in enum_values:
        return True
    for union_key in ("anyOf", "oneOf"):
        variants = schema.get(union_key)
        if isinstance(variants, list):
            for variant in variants:
                if isinstance(variant, Mapping) and _allows_null(variant):
                    return True
    return False


def _make_nullable(schema: Mapping[str, Any]) -> dict[str, Any]:
    nullable = dict(schema)
    if _allows_null(nullable):
        return nullable

    enum_values = nullable.get("enum")
    if isinstance(enum_values, list):
        nullable["enum"] = [*enum_values, None]

    schema_type = nullable.get("type")
    if isinstance(schema_type, str):
        nullable["type"] = [schema_type, "null"]
        return nullable
    if isinstance(schema_type, list):
        nullable["type"] = [*schema_type, "null"]
        return nullable

    for union_key in ("anyOf", "oneOf"):
        variants = nullable.get(union_key)
        if isinstance(variants, list):
            nullable[union_key] = [*variants, {"type": "null"}]
            return nullable

    return {"anyOf": [nullable, {"type": "null"}]}


def _tighten(value: Any) -> Any:
    if isinstance(value, Mapping):
        tightened = {key: _tighten(item) for key, item in value.items()}
        if tightened.get("type") == "object":
            properties = tightened.get("properties")
            if isinstance(properties, Mapping):
                original_required = {
                    item for item in tightened.get("required", []) if isinstance(item, str)
                }
                strict_properties: dict[str, Any] = {}
                for key, item in properties.items():
                    property_schema = item
                    if key not in original_required and isinstance(item, Mapping):
                        property_schema = _make_nullable(item)
                    strict_properties[key] = property_schema
                tightened["properties"] = strict_properties
                tightened["required"] = list(properties.keys())
            tightened["additionalProperties"] = False
        return tightened
    if isinstance(value, list | tuple):
        return [_tighten(item) for item in value]
    return value


def strict_json_schema(json_schema: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``json_schema`` adapted for OpenAI/Codex strict structured output.

    Every object node gets ``additionalProperties: false`` and a ``required``
    list covering all properties; properties that were optional are rewritten to
    accept ``null`` so the parsed payload still validates against the original
    (optional-field) Pydantic model.
    """
    tightened = _tighten(dict(json_schema))
    assert isinstance(tightened, dict)
    return tightened


__all__ = ["strict_json_schema"]
