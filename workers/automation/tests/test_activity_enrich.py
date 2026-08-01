"""Happy-path test for ``enrich_activity`` against an in-process worker."""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import UnsandboxedWorkflowRunner, Worker

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.enrichment import activities as enrichment_activities_mod
from jobctrl.enrichment.activities import (
    EnrichActivityInput,
    EnrichActivityOutput,
    enrich_activity,
)
from .politeness_helpers import offline_gateway


@workflow.defn(name="EnrichHarness")
class _EnrichHarness:
    @workflow.run
    async def run(self, payload: EnrichActivityInput) -> EnrichActivityOutput:
        return await workflow.execute_activity(
            enrich_activity,
            payload,
            start_to_close_timeout=timedelta(minutes=5),
        )


@pytest.mark.asyncio
async def test_enrich_activity_invokes_observed_enrich_core():
    queue = f"enrich-{uuid.uuid4()}"

    with patch(
        "jobctrl.pipeline.runner._run_stage_observed",
        return_value=({"status": "ok"}, 0.2, "ok"),
    ) as observed_mock:
        async with await WorkflowEnvironment.start_time_skipping() as env:
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[_EnrichHarness],
                activities=[enrich_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                output: EnrichActivityOutput = await env.client.execute_workflow(
                    _EnrichHarness.run,
                    EnrichActivityInput(tenant_id="local", limit=5, workers=2),
                    id=f"enrich-wf-{uuid.uuid4()}",
                    task_queue=queue,
                )

    observed_mock.assert_called_once()
    args, kwargs = observed_mock.call_args
    assert args[0] == "enrich"
    assert args[2]["workers"] == 2
    assert args[2]["limit"] == 5
    assert kwargs["mode"] == "workflow"
    assert output.status == "ok"
    assert output.elapsed == pytest.approx(0.2)


def test_selected_enrichment_uses_only_the_requested_v7_job_id_at_fetch_boundary(
    tmp_path,
    monkeypatch,
) -> None:
    from jobctrl.enrichment import detail

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId("60000000-0000-4000-8000-000000000001")
    unrelated_job_id = JobId("60000000-0000-4000-8000-000000000002")
    local_url = "https://local.example/jobs/one"
    unrelated_url = "https://local.example/jobs/two"
    for current_job_id, url in ((job_id, local_url), (unrelated_job_id, unrelated_url)):
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url, title, site) VALUES ('local', ?, ?, 'Test job', 'RemoteOK')",
            (current_job_id, url),
        )
        conn.execute(
            """
            INSERT INTO job_locators (
                tenant_id, job_id, locator_kind, locator_value, is_current,
                first_seen_at, last_seen_at, retired_at
            ) VALUES (?, ?, 'posting_url', ?, 1, '2026-07-31T10:00:00+00:00',
                      '2026-07-31T10:00:00+00:00', NULL)
            """,
            ("local", current_job_id, url),
        )
    conn.commit()

    class _FakeBrowser:
        def new_context(self, **_kwargs):
            return self

        def new_page(self):
            return object()

        def close(self) -> None:
            return None

    class _FakePlaywright:
        class chromium:  # noqa: N801 - mirrors Playwright's public attribute
            @staticmethod
            def launch(**_kwargs):
                return _FakeBrowser()

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

    fetched_urls: list[str] = []

    def fake_scrape_detail_page(_page, url, *, session):
        fetched_urls.append(url)
        return {
            "status": "ok",
            "tier_used": 1,
            "full_description": "Build reliable systems with Python and TypeScript. " * 8,
            "application_url": "https://apply.example/jobs/one",
            "elapsed": 0.1,
            "active_state": "active",
            "verification_method": "fixture",
            "http_status": 200,
        }

    monkeypatch.setattr("jobctrl.database.get_connection", lambda: conn)
    monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
    monkeypatch.setattr(detail, "PolitenessGateway", lambda: offline_gateway())
    monkeypatch.setattr(detail, "scrape_detail_page", fake_scrape_detail_page)

    result = enrichment_activities_mod._run_selected_enrichment(
        EnrichActivityInput(tenant_id="local", job_ids=(job_id,))
    )

    assert fetched_urls == [local_url]
    assert result["stages"][0]["selected"] == 1
    assert conn.execute(
        "SELECT current_status FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?",
        (job_id,),
    ).fetchone()[0] == "enriched"
    assert conn.execute(
        "SELECT COUNT(*) FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?",
        (unrelated_job_id,),
    ).fetchone()[0] == 0

    missing_job_id = JobId("60000000-0000-4000-8000-000000000003")
    missing_result = enrichment_activities_mod._run_selected_enrichment(
        EnrichActivityInput(tenant_id="local", job_ids=(missing_job_id,))
    )

    assert missing_result["stages"][0]["processed"] == 0
    assert fetched_urls == [local_url]
    assert conn.execute(
        "SELECT COUNT(*) FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?",
        (unrelated_job_id,),
    ).fetchone()[0] == 0
    close_connection(db_path)


def test_scrape_site_batch_rejects_legacy_url_targets(tmp_path) -> None:
    from jobctrl.enrichment import detail

    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        with pytest.raises(ValueError, match="canonical UUID"):
            detail.scrape_site_batch(
                conn,
                "RemoteOK",
                [(JobId("https://example.test/jobs/legacy"), "Legacy target")],
            )
    finally:
        close_connection(db_path)
