from __future__ import annotations

import sqlite3

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V10_MANIFEST,
    EXACT_V11_MANIFEST,
    SchemaManifestError,
    assert_exact_manifest,
    schema_dump,
)
from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema
from jobctrl.infrastructure.migrations.schema_v11 import (
    create_exact_v11_schema,
    upgrade_exact_v10_schema_to_v11,
)


def test_fresh_and_upgraded_v11_have_identical_frozen_schema() -> None:
    with sqlite3.connect(":memory:") as fresh, sqlite3.connect(":memory:") as upgraded:
        create_exact_v11_schema(fresh)
        create_exact_v10_schema(upgraded)
        upgraded.execute(
            "INSERT INTO llm_spend(day,input_tokens,output_tokens,estimated_usd) "
            "VALUES('2026-09-21',11,7,1.25)"
        )
        upgraded.commit()
        upgrade_exact_v10_schema_to_v11(upgraded)

        assert schema_dump(fresh) == schema_dump(upgraded)
        assert_exact_manifest(fresh, EXACT_V11_MANIFEST)
        assert_exact_manifest(upgraded, EXACT_V11_MANIFEST)
        assert upgraded.execute("SELECT * FROM llm_spend").fetchone() == (
            "2026-09-21",
            "legacy",
            11,
            7,
            1.25,
        )
        with pytest.raises(SchemaManifestError, match="exact v10 manifest"):
            assert_exact_manifest(upgraded, EXACT_V10_MANIFEST)


def test_failed_v10_to_v11_schema_upgrade_rolls_back_data_and_ddl() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v10_schema(conn)
        conn.execute(
            "INSERT INTO llm_spend(day,input_tokens,output_tokens,estimated_usd) "
            "VALUES('2026-09-21',11,7,1.25)"
        )
        conn.commit()
        before = tuple(conn.iterdump())

        def fail_after_create(sql: str) -> object:
            result = conn.execute(sql)
            if sql.startswith("CREATE TABLE llm_spend"):
                raise RuntimeError("synthetic failure")
            return result

        with pytest.raises(RuntimeError, match="synthetic failure"):
            upgrade_exact_v10_schema_to_v11(conn, _execute=fail_after_create)

        assert tuple(conn.iterdump()) == before
        assert_exact_manifest(conn, EXACT_V10_MANIFEST)


def test_v11_runtime_lane_constraint_rejects_unknown_lane() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v11_schema(conn)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO llm_spend(day,lane,input_tokens) VALUES('2026-09-21','unknown',1)"
            )
