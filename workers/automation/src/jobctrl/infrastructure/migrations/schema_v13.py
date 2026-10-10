"""Exact schema for semantic provenance. Earlier schema constructors stay frozen."""

from __future__ import annotations

import re
import sqlite3
from importlib.resources import files

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V12_MANIFEST,
    EXACT_V13_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema


def _statements() -> tuple[str, ...]:
    result: list[str] = []
    pending = ""
    for line in files("jobctrl.infrastructure.migrations").joinpath("schema_v13.sql").read_text().splitlines():
        pending += line + "\n"
        if sqlite3.complete_statement(pending):
            result.append(pending.strip())
            pending = ""
    if pending.strip():
        raise SchemaManifestError("incomplete exact-v13 schema")
    return tuple(result)


def _invalidate_derived_confirmation(conn: sqlite3.Connection) -> None:
    # Recognize the exact system-written legacy record shape. This identifies
    # provenance, not prose meaning. Preserve independent user evidence rows.
    rows = conn.execute(
        "SELECT tenant_id, profile_id, entry_id, evidence_index, evidence_id, source_text, action, outcome, tools_json, tags_json, evidence_strength, claim_confidence, user_confirmed FROM candidate_profile_achievement_evidence"
    ).fetchall()
    for row in rows:
        (
            tenant,
            profile,
            entry,
            index,
            evidence_id,
            source,
            action,
            outcome,
            tools,
            tags,
            strength,
            confidence,
            confirmed,
        ) = row
        entry_key = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(entry).strip()).strip("_") or "experience"
        prefix = entry_key + "_bullet_"
        suffix = evidence_id[len(prefix) :] if evidence_id.startswith(prefix) else ""
        if (
            suffix.isdigit()
            and int(suffix) > 0
            and source
            and source == action == outcome
            and tools == tags == "[]"
            and strength == "supported"
            and confidence == 0.8
            and confirmed == 1
        ):
            conn.execute(
                "UPDATE candidate_profile_achievement_evidence SET evidence_strength = 'draft', claim_confidence = 0, user_confirmed = 0 WHERE tenant_id = ? AND profile_id = ? AND entry_id = ? AND evidence_index = ?",
                (tenant, profile, entry, index),
            )


def _extend(conn: sqlite3.Connection) -> None:
    _invalidate_derived_confirmation(conn)
    for statement in _statements():
        conn.execute(statement)
    conn.execute("PRAGMA user_version = 13")
    assert_exact_manifest(conn, EXACT_V13_MANIFEST)


def create_exact_v13_schema(conn: sqlite3.Connection) -> None:
    if schema_dump(conn):
        raise SchemaManifestError("exact-v13 creation requires an empty schema")
    conn.execute("SAVEPOINT exact_v13_create")
    try:
        create_exact_v12_schema(conn)
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v13_create")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v13_create")
        conn.execute("RELEASE SAVEPOINT exact_v13_create")
        raise


def upgrade_exact_v12_schema_to_v13(conn: sqlite3.Connection) -> None:
    if conn.in_transaction or int(conn.execute("PRAGMA user_version").fetchone()[0]) != 12:
        raise SchemaManifestError("stopped exact-v12 source required")
    assert_exact_manifest(conn, EXACT_V12_MANIFEST)
    conn.execute("SAVEPOINT exact_v13_upgrade")
    try:
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v13_upgrade")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v13_upgrade")
        conn.execute("RELEASE SAVEPOINT exact_v13_upgrade")
        raise
