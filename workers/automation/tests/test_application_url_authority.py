"""Shared TS/Python URL authority fixture through the actual private migration."""

from __future__ import annotations

import json
import sqlite3

import pytest
from pathlib import Path

from jobctrl.infrastructure.job_locators import resolve_job_locator
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V10_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.schema_v9 import create_exact_v9_schema
from jobctrl.infrastructure.migrations.v9_to_v10_execute import execute_v9_to_v10_candidate
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

_FIXTURE = Path(__file__).resolve().parents[3] / "packages/domain-types/test/fixtures/application_url_authority.json"


@pytest.mark.parametrize("populated_projection", [False, True])
def test_migrated_python_projection_matches_shared_canonical_url_fixture(
    tmp_path: Path, populated_projection: bool
) -> None:
    cases = json.loads(_FIXTURE.read_text())["cases"]
    source, candidate = tmp_path / "source-v9.db", tmp_path / "candidate-v10.db"
    with sqlite3.connect(source) as conn:
        create_exact_v9_schema(conn)
        for tenant in ("local", "other"):
            for case in cases:
                conn.execute(
                    "INSERT INTO jobs(tenant_id,job_id,url,application_url,title,discovered_at) VALUES(?,?,?,?,?,'2026-08-01T00:00:00Z')",
                    (tenant, case["jobId"], f"https://jobs.example.test/{case['name']}", case["legacy"], case["name"]),
                )
                if populated_projection:
                    conn.execute(
                        "INSERT INTO job_list_projections(tenant_id,job_id,application_url) VALUES(?,?,?)",
                        (tenant, case["jobId"], (case["enrichment"] or {}).get("applicationUrl")),
                    )
                if case["enrichment"] is not None:
                    conn.execute(
                        "INSERT INTO job_enrichments(tenant_id,job_id,current_status,application_url,updated_at) VALUES(?,?,?,?,'2026-08-01T00:00:00Z')",
                        (tenant, case["jobId"], case["enrichment"]["status"], case["enrichment"]["applicationUrl"]),
                    )
    before = source.read_bytes()
    receipt = execute_v9_to_v10_candidate(source, candidate)
    assert receipt.source_data_digest == receipt.candidate_data_digest and source.read_bytes() == before
    with sqlite3.connect(candidate) as conn:
        conn.row_factory = sqlite3.Row
        assert_exact_manifest(conn, EXACT_V10_MANIFEST)
        other_before = [
            tuple(row)
            for row in conn.execute("SELECT * FROM job_list_projections WHERE tenant_id='other' ORDER BY job_id")
        ]
        builder = ProjectionBuilder(conn_factory=lambda: conn)
        builder.refresh()
        assert conn.execute("SELECT COUNT(*) FROM job_list_projections WHERE tenant_id='other'").fetchone()[0] == (
            len(cases) if populated_projection else 0
        )
        for case in cases:
            row = conn.execute(
                "SELECT application_url FROM job_list_projections WHERE tenant_id='local' AND job_id=?",
                (case["jobId"],),
            ).fetchone()
            assert row["application_url"] == case["expected"], case["name"]
            for value in [case["legacy"], (case["enrichment"] or {}).get("applicationUrl")]:
                if value:
                    for tenant in ("local", "other"):
                        assert resolve_job_locator(conn, tenant, value)[0] == case["jobId"]
        conflict = cases[1]
        conn.execute(
            "UPDATE job_enrichments SET application_url=NULL WHERE tenant_id='local' AND job_id=?", (conflict["jobId"],)
        )
        assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
        conn.commit()
        builder.refresh()
        assert (
            conn.execute(
                "SELECT application_url FROM job_list_projections WHERE tenant_id='local' AND job_id=?",
                (conflict["jobId"],),
            ).fetchone()[0]
            is None
        )
        assert resolve_job_locator(conn, "local", conflict["legacy"])[0] == conflict["jobId"]
        assert [
            tuple(row)
            for row in conn.execute("SELECT * FROM job_list_projections WHERE tenant_id='other' ORDER BY job_id")
        ] == other_before
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        settled_changes = conn.total_changes
        assert builder.refresh() == 0
        assert conn.total_changes == settled_changes
