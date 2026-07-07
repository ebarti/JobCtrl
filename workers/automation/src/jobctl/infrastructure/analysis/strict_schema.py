"""OpenAI/Codex strict JSON-Schema adaptation for structured output.

Discovered by a live smoke test: the Codex SDK's ``output_schema`` rejects a
plain Pydantic ``model_json_schema()`` with::

    400 invalid_request_error / invalid_json_schema:
    'additionalProperties' is required to be supplied and to be false.

OpenAI strict structured output requires every object node to set
``additionalProperties: false`` AND to list *every* property in ``required``
(strict mode has no notion of an absent optional property). :func:`strict_json_schema`
rewrites the schema to satisfy that.

**Nullability is preserved, never invented.** A field is left exactly as the
Pydantic model declared it: a genuinely-optional field (e.g. ``requirement_ref:
str | None``) already carries ``null`` in its schema and stays nullable; a
field with a non-null default (e.g. ``rationale: str = ""``) keeps its concrete
type. This matters because the model the *parsed* payload is validated against
(``JobAnalysis``) only accepts ``null`` for the truly-nullable fields — forcing
every optional to be nullable (as a naive transform does) makes the model emit
``null`` for, say, ``rationale``, which then fails ``model_validate_json`` and
silently degrades the Codex leg. So we make every property *required* (present)
without changing its type.

Mirrors the intent of mestre's ``strict_json_schema`` but does NOT apply its
``_make_nullable`` step, because mestre's models declare optionals as ``X |
None`` whereas these declare non-null defaults.

Pure dict manipulation — recurses into ``$defs`` and nested objects; leaves
``$ref`` nodes untouched (the referenced def is tightened in place).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _tighten(value: Any) -> Any:
    if isinstance(value, Mapping):
        tightened = {key: _tighten(item) for key, item in value.items()}
        if tightened.get("type") == "object":
            properties = tightened.get("properties")
            if isinstance(properties, Mapping):
                # Strict mode: every property must be present. Keep each
                # property's declared type as-is (do NOT inject null) so the
                # parsed payload still round-trips through the Pydantic model.
                tightened["required"] = list(properties.keys())
            tightened["additionalProperties"] = False
        return tightened
    if isinstance(value, list | tuple):
        return [_tighten(item) for item in value]
    return value


def strict_json_schema(json_schema: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``json_schema`` adapted for OpenAI/Codex strict structured output.

    Every object node gets ``additionalProperties: false`` and a ``required``
    list covering all of its properties. Property types are preserved exactly,
    so already-nullable fields stay nullable and non-null fields stay non-null
    (the parsed payload validates against the original Pydantic model).
    """
    tightened = _tighten(dict(json_schema))
    assert isinstance(tightened, dict)
    return tightened


__all__ = ["strict_json_schema"]
