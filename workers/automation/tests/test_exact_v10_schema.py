from __future__ import annotations

import sqlite3

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V9_MANIFEST,
    EXACT_V10_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v9 import create_exact_v9_schema
from jobctrl.infrastructure.migrations.schema_v10 import (
    create_exact_v10_schema,
    create_unstamped_exact_v10_candidate,
    upgrade_exact_v9_schema_to_v10,
)


def test_fresh_upgraded_and_unstamped_v10_have_identical_exact_schema() -> None:
    with (
        sqlite3.connect(":memory:") as fresh,
        sqlite3.connect(":memory:") as upgraded,
        sqlite3.connect(":memory:") as candidate,
    ):
        create_exact_v10_schema(fresh)
        create_exact_v9_schema(upgraded)
        upgrade_exact_v9_schema_to_v10(upgraded)
        create_unstamped_exact_v10_candidate(candidate)
        assert schema_dump(fresh) == schema_dump(upgraded) == schema_dump(candidate)
        for conn in (fresh, upgraded, candidate):
            assert_exact_manifest(conn, EXACT_V10_MANIFEST)
            assert "application_url" not in {r[1] for r in conn.execute("PRAGMA table_info(jobs)")}
        assert fresh.execute("PRAGMA user_version").fetchone() == (10,)
        assert candidate.execute("PRAGMA user_version").fetchone() == (0,)
        assert fresh.execute("SELECT COUNT(*) FROM resume_templates").fetchone()[0] > 0


def test_upgrade_rejects_active_transaction_and_malformed_schema_without_changes() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v9_schema(conn)
        conn.execute("BEGIN")
        with pytest.raises(SchemaManifestError, match="active transaction"):
            upgrade_exact_v9_schema_to_v10(conn)
        conn.rollback()
        conn.execute("CREATE TABLE unexpected(value TEXT)")
        before = tuple(conn.iterdump())
        with pytest.raises(SchemaManifestError, match="exact v9 manifest"):
            upgrade_exact_v9_schema_to_v10(conn)
        assert tuple(conn.iterdump()) == before


def test_failed_schema_upgrade_rolls_back_url_transfer_and_ddl() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v9_schema(conn)
        conn.execute("INSERT INTO jobs(tenant_id,job_id,url,application_url) VALUES('local','j','p','a')")
        conn.commit()
        before = tuple(conn.iterdump())

        def fail_after_drop(sql: str) -> object:
            result = conn.execute(sql)
            if sql.startswith("ALTER TABLE jobs"):
                raise RuntimeError("synthetic failure after column removal")
            return result

        with pytest.raises(RuntimeError, match="synthetic failure"):
            upgrade_exact_v9_schema_to_v10(conn, _execute=fail_after_drop)
        assert tuple(conn.iterdump()) == before
        assert_exact_manifest(conn, EXACT_V9_MANIFEST)
