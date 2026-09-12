"""Exact current-schema anchor lookup and tenant isolation regressions."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.infrastructure.gmail.feedback import _apply_run_anchors, _job_anchors, _outcome_anchors
from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema


@pytest.mark.parametrize("reader", [_job_anchors, _outcome_anchors, _apply_run_anchors])
def test_anchor_uses_canonical_enrichment_and_exact_tenant_job_identity(reader) -> None:
    with sqlite3.connect(":memory:") as conn:
        conn.row_factory = sqlite3.Row
        create_exact_v10_schema(conn)
        for tenant in ("local", "other"):
            conn.execute(
                "INSERT INTO jobs(tenant_id,job_id,url,title,company,applied_at) VALUES(?, 'same-job', 'https://post/shared', ?, ?, '2026-09-01T10:00:00+00:00')",
                (tenant, f"{tenant} title", f"{tenant} company"),
            )
            conn.execute(
                "INSERT INTO job_enrichments(tenant_id,job_id,current_status,application_url,updated_at) VALUES(?, 'same-job', 'pending', ?, '2026-09-01T09:00:00+00:00')",
                (tenant, f"https://{tenant}.canonical/apply"),
            )
            conn.execute(
                "INSERT INTO job_application_locators VALUES(?, 'same-job', ?)",
                (tenant, f"https://{tenant}.historical/alias"),
            )
            conn.execute(
                "INSERT INTO application_outcomes(tenant_id,outcome_id,job_id,kind,source,occurred_at,recorded_at) VALUES(?, ?, 'same-job', 'applied_confirmation', 'user', '2026-09-01T10:00:00+00:00', '2026-09-01T10:00:00+00:00')",
                (tenant, f"{tenant}-outcome"),
            )
            conn.execute(
                "INSERT INTO apply_run_projections(run_id,tenant_id,job_id,status,finished_at) VALUES(?, ?, 'same-job', 'succeeded', '2026-09-01T10:00:00+00:00')",
                (f"{tenant}-run", tenant),
            )
        anchors = reader(conn)
        assert len(anchors) == 1
        assert anchors[0].job_key == "same-job"
        assert anchors[0].title == "local title"
        assert anchors[0].company == "local company"
        assert anchors[0].application_url == "https://local.canonical/apply"
        conn.execute("DELETE FROM job_enrichments WHERE tenant_id='local'")
        assert reader(conn)[0].application_url == ""
