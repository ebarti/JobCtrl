"""Bind a PDF extraction to its server-issued import attempt at the parser boundary."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from typing import Any

from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

_STYLE_VALUES = {
    "paper_size": {"a4paper", "letterpaper"},
    "document_font_size": {"10pt", "11pt", "12pt"},
    "font_family": {"sans", "roman"},
}


def record_import_attempt(
    connection: sqlite3.Connection, tenant_id: str, attempt_id: str, pdf_bytes: bytes, draft: dict[str, Any]
) -> None:
    """Persist only source identity and observed format, never PDF bytes.

    An activity retry may repeat exactly the same attempt. A different parse,
    including one with the same text determination, cannot replace its binding.
    """
    try:
        identifier = uuid.UUID(attempt_id)
    except (ValueError, TypeError, AttributeError):
        raise ValueError("invalid import attempt") from None
    if identifier.version != 4 or str(identifier) != attempt_id:
        raise ValueError("invalid import attempt")
    source, style = draft.get("source"), draft.get("style")
    if not isinstance(source, dict) or not isinstance(style, dict):
        raise ValueError("invalid import source")
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    observed, determination_id = source.get("inferredStyle"), source.get("determinationId")
    if source.get("pdfSha256") != digest or not isinstance(observed, dict) or not isinstance(determination_id, str):
        raise ValueError("invalid import source")
    if any(key not in _STYLE_VALUES or not isinstance(value, str) or value not in _STYLE_VALUES[key] or style.get(key) != value
           for key, value in observed.items()):
        raise ValueError("invalid observed style")
    pages, warnings = source.get("pages"), source.get("warnings")
    if not isinstance(pages, int) or isinstance(pages, bool) or pages < 1 or not isinstance(warnings, list) or any(
        not isinstance(warning, str) for warning in warnings
    ):
        raise ValueError("invalid import diagnostics")
    warning_hash = hashlib.sha256()
    for warning in warnings:
        encoded = warning.encode("utf-8")
        warning_hash.update(len(encoded).to_bytes(8, "big"))
        warning_hash.update(encoded)
    envelope = SqliteDeterminationRepository(connection).find(tenant_id, determination_id)
    if not envelope or envelope.kind != "resume_extraction" or envelope.entity_id != "resume-import" or envelope.lane != "profile":
        raise ValueError("invalid import determination")
    # entity_version is a compact source-version record. The existing table's
    # tenant/id key and FK scope it to one attempt and its determination.
    version = json.dumps({"version": 1, "pdfSha256": digest, "inferredStyle": observed,
                          "pages": pages, "warningsSha256": warning_hash.hexdigest()}, sort_keys=True, separators=(",", ":"))
    connection.execute("SAVEPOINT resume_import_attempt")
    try:
        rows = connection.execute(
            "SELECT entity_version, determination_kind, determination_id FROM semantic_entity_bindings "
            "WHERE tenant_id=? AND entity_kind=? AND entity_id=?",
            (tenant_id, "resume_import_attempt", attempt_id),
        ).fetchall()
        expected = (version, "resume_extraction", determination_id)
        if rows:
            if len(rows) != 1 or tuple(rows[0]) != expected:
                raise ValueError("import attempt already bound to another source")
        else:
            connection.execute(
                "INSERT INTO semantic_entity_bindings VALUES (?,?,?,?,?,?)",
                (tenant_id, "resume_import_attempt", attempt_id, *expected),
            )
    except BaseException:
        connection.execute("ROLLBACK TO resume_import_attempt")
        raise
    finally:
        connection.execute("RELEASE resume_import_attempt")
