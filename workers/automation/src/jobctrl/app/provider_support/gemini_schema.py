"""Gemini/Antigravity JSON-Schema adaptation for structured output.

Gemini's ``response_schema`` accepts an OpenAPI-like schema *subset* and does
the **opposite** of Codex strict mode: it REJECTS JSON Schema's
``additionalProperties`` keyword (a live probe returns a schema error when it is
present), and it does not understand the ``type: [T, "null"]`` union form or an
``enum`` that contains ``null``. :func:`gemini_json_schema` rewrites a plain
Pydantic ``model_json_schema()`` into the shape Gemini accepts:

  * strip ``$schema`` / ``additionalProperties`` / ``additional_properties``
    everywhere (recursively, including ``$defs`` and nested objects);
  * map ``type: [T, "null"]`` -> ``type: T`` + ``nullable: true`` (only when a
    single non-null type remains; mixed-type unions are left untouched);
  * map an ``enum`` containing ``None`` -> drop the ``None`` member +
    ``nullable: true``.

This mirrors mestre's ``structured_output.py::gemini_json_schema`` (the
authoritative working reference) and is the Gemini sibling of the Codex
``strict_schema.py`` adapter. Pure dict manipulation — no I/O, no SDK import;
``$ref`` nodes are left untouched (the referenced ``$defs`` entry is sanitised
in place).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# Keywords Gemini's response_schema rejects outright (the opposite of Codex,
# which *requires* additionalProperties). Stripped at every node.
_UNSUPPORTED_KEYS = frozenset({"$schema", "additionalProperties", "additional_properties"})


def _sanitize(value: Any) -> Any:
    if isinstance(value, Mapping):
        sanitized: dict[str, Any] = {
            key: _sanitize(item) for key, item in value.items() if key not in _UNSUPPORTED_KEYS
        }
        # type: [T, "null"] -> type: T + nullable: true (single non-null type only).
        schema_type = sanitized.get("type")
        if isinstance(schema_type, list) and "null" in schema_type:
            non_null_types = [item for item in schema_type if item != "null"]
            if len(non_null_types) == 1:
                sanitized["type"] = non_null_types[0]
                sanitized["nullable"] = True
        # enum containing None -> drop None + nullable: true.
        enum_values = sanitized.get("enum")
        if isinstance(enum_values, list) and None in enum_values:
            sanitized["enum"] = [item for item in enum_values if item is not None]
            sanitized["nullable"] = True
        return sanitized
    if isinstance(value, list | tuple):
        return [_sanitize(item) for item in value]
    return value


def gemini_json_schema(json_schema: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``json_schema`` adapted for Gemini/Antigravity ``response_schema``.

    Strips the unsupported ``additionalProperties`` / ``$schema`` keywords
    recursively and rewrites nullable-by-union (``[T, "null"]``) and
    nullable-by-enum (``enum`` with ``None``) into Gemini's ``nullable: true``
    form. The input is not mutated.
    """
    sanitized = _sanitize(dict(json_schema))
    assert isinstance(sanitized, dict)
    return sanitized


__all__ = ["gemini_json_schema"]
