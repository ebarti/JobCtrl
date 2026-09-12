"""Canonical application target and preserved alias resolution on exact v10."""

from __future__ import annotations

import sqlite3

from jobctrl.infrastructure.job_locators import resolve_job_locator
from jobctrl.infrastructure.migrations.schema_v10 import create_exact_v10_schema


def test_resolver_prefers_posting_and_rejects_shared_application_aliases() -> None:
    with sqlite3.connect(":memory:") as conn:
        create_exact_v10_schema(conn)
        for tenant, job, posting in [
            ("local", "one", "https://post/one"),
            ("local", "two", "https://post/two"),
            ("other", "one", "https://post/one"),
        ]:
            conn.execute("INSERT INTO jobs(tenant_id,job_id,url) VALUES(?,?,?)", (tenant, job, posting))
            conn.execute(
                "INSERT INTO job_enrichments(tenant_id,job_id,current_status,application_url,updated_at) VALUES(?,?,'pending',?,'now')",
                (tenant, job, f"https://{tenant}/canonical/{job}"),
            )
            conn.execute(
                "INSERT INTO job_application_locators VALUES(?,?,?)", (tenant, job, f"https://{tenant}/old/{job}")
            )
            conn.execute("INSERT INTO job_application_locators VALUES(?,?,'https://shared/apply')", (tenant, job))
        assert resolve_job_locator(conn, "local", "https://local/canonical/one") == ("one", "https://post/one")
        assert resolve_job_locator(conn, "local", "https://local/old/one") == ("one", "https://post/one")
        assert resolve_job_locator(conn, "other", "https://shared/apply") == ("one", "https://post/one")
        assert resolve_job_locator(conn, "local", "https://shared/apply") is None
        assert resolve_job_locator(conn, "local", "https://other/canonical/one") is None
        assert resolve_job_locator(conn, "missing", "one") is None
        conn.execute("INSERT INTO job_application_locators VALUES('local','two','https://post/one')")
        assert resolve_job_locator(conn, "local", "https://post/one") == ("one", "https://post/one")
