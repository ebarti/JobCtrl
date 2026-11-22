"""Lossless permission references; qualification policy and sources are unchanged."""

from copy import deepcopy

from jobctrl.app.errors import AppError

from .serialization import encoded
from .sources import fingerprint

CONTEXT_TRANSPORT_VERSION = "fit-permission-scopes-v1"
TRANSPORT_INSTRUCTIONS = """
Permission-list transport: resolve each requirement.permission_scope_id in context.permission_scopes.
That scope's permitted_evidence_ids is exactly the permitted Profile evidence ID list for that row.
Scopes share identical ordered lists only; they do not select relevance, broaden categories or alter
Education alternatives/evidence routes. Cite the original supplied evidence IDs, never a scope ID.
All factual sources and every requirement field remain supplied. Apply all preceding rules unchanged.
"""


def _invalid():
    return AppError("fit_context_transport_invalid", "The qualification context transport cannot be verified.", 422)


def expand_context(context, sources):
    """Verify the wire binding and restore the exact canonical input context."""
    try:
        wire = deepcopy(context)
        binding = wire.pop("context_transport_binding")
        if wire["context_transport_version"] != CONTEXT_TRANSPORT_VERSION or binding["version"] != CONTEXT_TRANSPORT_VERSION:
            raise _invalid()
        if (fingerprint(wire) != binding["encoded_context_fingerprint"]
                or fingerprint(sources) != binding["source_inventory_fingerprint"]):
            raise _invalid()
        wire.pop("context_transport_version")
        scopes = wire.pop("permission_scopes")
        if fingerprint(scopes) != binding["permission_scopes_fingerprint"]:
            raise _invalid()
        by_id = {scope["scope_id"]: scope["permitted_evidence_ids"] for scope in scopes}
        if len(by_id) != len(scopes):
            raise _invalid()
        used = set()
        for row in wire["requirements"]:
            if "permitted_evidence_ids" in row:
                raise _invalid()
            scope_id = row.pop("permission_scope_id")
            used.add(scope_id)
            row["permitted_evidence_ids"] = deepcopy(by_id[scope_id])
        if used != set(by_id) or fingerprint(wire) != binding["expanded_context_fingerprint"]:
            raise _invalid()
        return wire
    except (KeyError, TypeError, ValueError):
        raise _invalid() from None


def encode_context(context, sources):
    """Deduplicate equal ordered lists without mutating or filtering any input."""
    wire = deepcopy(context)
    if any(key in wire for key in ("context_transport_version", "context_transport_binding", "permission_scopes")):
        raise _invalid()
    scope_ids, scopes = {}, []
    for row in wire["requirements"]:
        if "permission_scope_id" in row:
            raise _invalid()
        ids = row.pop("permitted_evidence_ids")
        key = tuple(ids)
        if key not in scope_ids:
            scope_ids[key] = "evidence-scope:" + str(len(scopes))
            scopes.append({"scope_id": scope_ids[key], "permitted_evidence_ids": ids})
        row["permission_scope_id"] = scope_ids[key]
    wire.update(context_transport_version=CONTEXT_TRANSPORT_VERSION, permission_scopes=scopes)
    binding = {"version": CONTEXT_TRANSPORT_VERSION,
               "expanded_context_fingerprint": fingerprint(context), "encoded_context_fingerprint": fingerprint(wire),
               "permission_scopes_fingerprint": fingerprint(scopes), "source_inventory_fingerprint": fingerprint(sources),
               "requirement_count": len(context["requirements"]), "scope_count": len(scopes),
               "expanded_context_bytes": len(encoded(context).encode()), "encoded_context_bytes": len(encoded(wire).encode())}
    wire["context_transport_binding"] = binding
    if encoded(expand_context(wire, sources)) != encoded(context):
        raise _invalid()
    return wire, binding
