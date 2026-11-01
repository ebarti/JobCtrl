"""Review-only recovery of legacy originals from native stopped paired backups."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
from pathlib import Path

from jobctrl.infrastructure.migrations.schema_manifest import assert_exact_manifest
from jobctrl.infrastructure.migrations import schema_manifest
from jobctrl.infrastructure.profile.legacy_evidence import (
    LegacyEvidenceReviewError, evidence_rows, record_legacy_inventory,
)


def _private_file(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise LegacyEvidenceReviewError("legacy_evidence_backup_not_private")
        return source.read()


def read_paired_originals(directory: Path) -> tuple[list[dict], str]:
    """Validate native pair metadata and both immutable SQLite files before reads."""
    if directory.is_symlink() or not directory.is_dir():
        raise LegacyEvidenceReviewError("legacy_evidence_paired_backup_required")
    raw = _private_file(directory / "pair.json")
    manifest = json.loads(raw)
    entries = manifest.get("files", [])
    if (manifest.get("schemaVersion") != 1 or manifest.get("id") != directory.name
            or len(entries) != 2 or {item.get("name") for item in entries} != {"jobctrl.db", "temporal.db"}):
        raise LegacyEvidenceReviewError("legacy_evidence_paired_backup_required")
    for item in entries:
        path = directory / item["name"]
        content = _private_file(path)
        if (hashlib.sha256(content).hexdigest() != item.get("sha256") or len(content) != item.get("sizeBytes")
                or any(Path(f"{path}{suffix}").exists() for suffix in ("-wal", "-shm", "-journal"))):
            raise LegacyEvidenceReviewError("legacy_evidence_backup_changed")
        with sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro&immutable=1", uri=True) as conn:
            if conn.execute("PRAGMA user_version").fetchone()[0] != item.get("sqliteUserVersion"):
                raise LegacyEvidenceReviewError("legacy_evidence_backup_changed")
            if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise LegacyEvidenceReviewError("legacy_evidence_backup_changed")
    app = directory / "jobctrl.db"
    with sqlite3.connect(f"{app.resolve().as_uri()}?mode=ro&immutable=1", uri=True) as conn:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version not in range(6, 13):
            raise LegacyEvidenceReviewError("legacy_evidence_pre_v13_backup_required")
        if version == 6:
            from jobctrl.infrastructure.migrations.v6_to_v7_preflight import assert_v6_migration_preflight
            assert_v6_migration_preflight(conn)
        else:
            assert_exact_manifest(conn, getattr(schema_manifest, f"EXACT_V{version}_MANIFEST"))
        rows = evidence_rows(conn)
    return rows, hashlib.sha256(raw).hexdigest()


def inventory_recovery(conn: sqlite3.Connection, directory: Path) -> None:
    """Record originals as uncertain; never restore a field or confirm any row."""
    if conn.in_transaction:
        raise LegacyEvidenceReviewError("legacy_evidence_stopped_runtime_required")
    originals, pair_digest = read_paired_originals(directory)
    conn.execute("BEGIN IMMEDIATE")
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version not in (13, 14, 15):
            raise LegacyEvidenceReviewError("legacy_evidence_current_schema_required")
        assert_exact_manifest(conn, getattr(schema_manifest, f"EXACT_V{version}_MANIFEST"))
        # Retain the backup locator/digest as provenance, never as author authority.
        for original in originals:
            original["_paired_backup_manifest_sha256"] = pair_digest
        record_legacy_inventory(conn, originals)
        # Revalidate backup bytes before committing the provenance import.
        _, final_digest = read_paired_originals(directory)
        if final_digest != pair_digest:
            raise LegacyEvidenceReviewError("legacy_evidence_backup_changed")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
