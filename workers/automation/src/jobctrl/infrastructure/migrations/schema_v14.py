"""Exact native cutover from redundant approval bindings to saved settings."""

from __future__ import annotations

import sqlite3
from importlib.resources import files
from jobctrl.domain.discovery.triage import Listing
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V13_MANIFEST,
    EXACT_V14_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v13 import create_exact_v13_schema


def _extend(conn):
    # Validate the frozen v13 capture format before withdrawing its judgments.
    # Raw postings and canonical jobs/materials remain available for recovery.
    for row in conn.execute("SELECT listing_json FROM posting_triage"):
        try:
            Listing.model_validate_json(row[0])
        except ValueError:
            raise SchemaManifestError("invalid exact-v13 intake capture") from None
    pending = ""
    for line in files("jobctrl.infrastructure.migrations").joinpath("schema_v14.sql").read_text().splitlines():
        pending += line + "\n"
        if sqlite3.complete_statement(pending):
            conn.execute(pending.strip())
            pending = ""
    if pending.strip():
        raise SchemaManifestError("incomplete exact-v14 schema")
    conn.execute("PRAGMA user_version = 14")
    assert_exact_manifest(conn, EXACT_V14_MANIFEST)


def create_exact_v14_schema(conn):
    if schema_dump(conn):
        raise SchemaManifestError("exact-v14 creation requires an empty schema")
    conn.execute("SAVEPOINT exact_v14_create")
    try:
        create_exact_v13_schema(conn)
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v14_create")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v14_create")
        conn.execute("RELEASE SAVEPOINT exact_v14_create")
        raise


def upgrade_exact_v13_schema_to_v14(conn):
    if conn.in_transaction or int(conn.execute("PRAGMA user_version").fetchone()[0]) != 13:
        raise SchemaManifestError("stopped exact-v13 source required")
    assert_exact_manifest(conn, EXACT_V13_MANIFEST)
    conn.execute("SAVEPOINT exact_v14_upgrade")
    try:
        _extend(conn)
        conn.execute("RELEASE SAVEPOINT exact_v14_upgrade")
    except BaseException:
        conn.execute("ROLLBACK TO SAVEPOINT exact_v14_upgrade")
        conn.execute("RELEASE SAVEPOINT exact_v14_upgrade")
        raise
