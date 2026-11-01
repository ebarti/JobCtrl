"""Exercise the release-only model port through actual capture persistence."""

import importlib.util
import json
from dataclasses import replace
from pathlib import Path
import uuid

import pytest
from temporalio.exceptions import ApplicationError

from jobctrl import config
from jobctrl.database import init_db
from jobctrl.discovery.manual_capture_workflow import (
    ManualCaptureImportWorkflowInput,
    execute_manual_capture_import,
)

@pytest.fixture
def smoke_model(monkeypatch, tmp_path):
    import jobctrl.database as database
    import jobctrl.infrastructure.discovery.production_wiring as discovery
    import jobctrl.infrastructure.enrichment.page_interpretation as page

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(tmp_path / "config.json"))
    # Restore both release-only bindings between synthetic tests.
    monkeypatch.setattr(page, "determination_dependencies", page.determination_dependencies)
    monkeypatch.setattr(discovery, "build_manual_capture_posting_extractor", discovery.build_manual_capture_posting_extractor)
    script = Path(__file__).resolve().parents[3] / "scripts" / "distribution-smoke-model.py"
    spec = importlib.util.spec_from_file_location("distribution_smoke_model", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    conn = init_db(db_path)
    url = "https://offline.fixture.invalid/jobs/distribution-smoke"
    html = '<html><script type="application/ld+json">' + json.dumps({
        "@type": "JobPosting", "title": "Synthetic release fixture", "url": url,
        "description": "A synthetic description for capture plumbing verification.",
    }) + "</script><body>Identical synthetic source for explicit opposing model choices.</body></html>"
    conn.execute(
        "INSERT INTO manual_capture_queue (tenant_id,item_id,originating_url,source_id,reason,"
        "retry_context_json,required_at,status) VALUES ('local','capture',?,'manual:smoke',"
        "'login_required','{}','2026-10-16T00:00:00Z','pending')", (url,),
    )
    conn.commit()
    payload = ManualCaptureImportWorkflowInput(
        tenant_id="local", item_id="capture", capture_mode="saved_html", content_text=html,
        captured_url=url, future_manual_action_required=False,
    )
    try:
        yield module, conn, payload
    finally:
        conn.close()


@pytest.mark.parametrize("availability", ["active", "closed"])
def test_release_model_drives_persisted_capture_and_replay(smoke_model, availability):
    import jobctrl.infrastructure.determinations as infrastructure

    module, conn, payload = smoke_model
    model = module.DistributionSmokePageModel(availability=availability)
    original = infrastructure.determination_dependencies
    module.install_smoke_model(model)
    assert infrastructure.determination_dependencies is original
    first = execute_manual_capture_import(payload, conn=conn)
    assert first.status == "succeeded"
    records = conn.execute(
        "SELECT kind,provider,model,lane,envelope_json FROM semantic_determinations ORDER BY kind"
    ).fetchall()
    assert {row["kind"] for row in records} == {"page_interpretation", "posting_extraction", "description_quality"}
    for row in records:
        assert (row["provider"], row["model"], row["lane"]) == (
            "distribution-smoke", "explicit-page-fixture", "enrichment",
        )
    page = next(json.loads(row["envelope_json"]) for row in records if row["kind"] == "page_interpretation")
    assert page["result"]["availability"]["value"] == availability
    selection = next(json.loads(row["envelope_json"]) for row in records if row["kind"] == "posting_extraction")
    assert selection["result"]["title"]["value"] == "Synthetic release fixture"
    assert selection["result"]["description"]["source_id"] == "posting:0:description"
    assert selection["result"]["description"]["citations"][0]["quote"] == "A synthetic description for capture plumbing verification."
    assert all(origin["url"] == payload.captured_url for origin in selection["result"]["source_origins"])
    quality = next(json.loads(row["envelope_json"]) for row in records if row["kind"] == "description_quality")
    snapshot = json.loads(conn.execute("SELECT snapshot_set_json FROM posting_snapshot_sets").fetchone()[0])["snapshots"][0]
    assert f"posting_extraction_determination:{selection['determination_id']}" in snapshot["evidence"]
    assert f"page_interpretation_determination:{page['determination_id']}" in snapshot["evidence"]
    assert f"description_quality_determination:{quality['determination_id']}" in snapshot["evidence"]
    assert snapshot["active_state"] == availability
    enrichment = conn.execute("SELECT full_description FROM job_enrichments").fetchone()
    if availability == "active":
        assert enrichment[0] == "A synthetic description for capture plumbing verification."
    else:
        assert enrichment is None
    assert execute_manual_capture_import(payload, conn=conn) == first
    assert model.calls == 3
    assert model.schemas == ["PageInterpretation", "PostingSelectionExtraction", "DescriptionQuality"]


@pytest.mark.parametrize("denied_call", [1, 2, 3])
def test_release_model_retains_spend_preflight_and_pending_capture(smoke_model, monkeypatch, denied_call):
    import jobctrl.llm as llm

    module, conn, payload = smoke_model
    model = module.DistributionSmokePageModel()
    module.install_smoke_model(model)

    calls = []
    def deny(*, lane):
        assert lane == "enrichment"
        calls.append(lane)
        if len(calls) == denied_call:
            raise RuntimeError("Synthetic budget denial")

    monkeypatch.setattr(llm, "enforce_spend_budget", deny)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(payload, conn=conn)
    assert exc.value.type == "semantic_determination_budget_denied"
    assert model.calls == denied_call - 1
    assert conn.execute("SELECT status FROM manual_capture_queue").fetchone()[0] == "pending"
    context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue").fetchone()[0])
    assert context["manual_capture_draft"]["content"] == payload.content_text
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == denied_call - 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    monkeypatch.setattr(llm, "enforce_spend_budget", lambda *, lane: calls.append(lane))
    assert execute_manual_capture_import(payload, conn=conn).status == "succeeded"
    assert model.calls == 3
    assert all(lane == "enrichment" for lane in calls)


@pytest.mark.parametrize(("kind", "access"), [("listing", "clear"), ("posting", "login_required")])
def test_release_model_respects_rejected_page_decision(smoke_model, kind, access):
    module, conn, payload = smoke_model
    model = module.DistributionSmokePageModel(page_kind=kind, access_state=access)
    module.install_smoke_model(model)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(payload, conn=conn)
    assert exc.value.type == "manual_capture_extraction_failed"
    assert model.schemas == ["PageInterpretation"]
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue").fetchone()[0])
    assert context["manual_capture_draft"]["content"] == payload.content_text


def test_release_model_invalid_selection_cannot_fall_back(smoke_model):
    module, conn, payload = smoke_model
    class InvalidSelection(module.DistributionSmokePageModel):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            if response_schema["title"] == "PostingSelectionExtraction":
                result["description"]["first_line_id"] = "foreign-line"
            return result
    model = InvalidSelection()
    module.install_smoke_model(model)
    with pytest.raises(ApplicationError) as exc:
        execute_manual_capture_import(payload, conn=conn)
    assert exc.value.type == "semantic_determination_field_binding_invalid"
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    context = json.loads(conn.execute("SELECT retry_context_json FROM manual_capture_queue").fetchone()[0])
    assert context["manual_capture_draft"]["content"] == payload.content_text
    assert model.schemas.count("PostingSelectionExtraction") == 3
    module.install_smoke_model(module.DistributionSmokePageModel())
    assert execute_manual_capture_import(payload, conn=conn).status == "succeeded"


@pytest.mark.asyncio
async def test_release_model_through_real_temporal_workflow(smoke_model):
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
    from jobctrl.discovery.manual_capture_workflow import ManualCaptureImportWorkflow, manual_capture_import_activity
    from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
    from tests.temporal_env import time_skipping_env

    module, conn, payload = smoke_model
    model = module.DistributionSmokePageModel()
    module.install_smoke_model(model)
    # Match the structured fixture submitted by scripts/distribution-build.mjs.
    description = ("Build local-first job search infrastructure with Python, TypeScript, observability, "
                   "reliable workflow automation, product strategy, and privacy-preserving systems. ") * 6
    posting = {"@context": "https://schema.org", "@type": "JobPosting", "title": "Distribution Smoke Engineer",
               "description": description, "directApply": True, "url": payload.captured_url,
               "validThrough": "2999-01-01T00:00:00+00:00",
               "hiringOrganization": {"@type": "Organization", "name": "Offline Fixture"},
               "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress",
                               "addressLocality": "Barcelona", "addressCountry": "Spain"}}}
    html = ('<!doctype html><html><head><script type="application/ld+json">' + json.dumps(posting)
            + '</script></head><body><h1>Distribution Smoke Engineer</h1><p>' + description + '</p></body></html>')
    payload = replace(payload, content_text=html, expected_app_dir=str(config.APP_DIR), expected_db_path=str(config.DB_PATH))
    task_queue = f"distribution-smoke-{uuid.uuid4()}"
    async with time_skipping_env() as env:
        async with Worker(env.client, task_queue=task_queue, workflows=[ManualCaptureImportWorkflow],
                          activities=[manual_capture_import_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await env.client.start_workflow(ManualCaptureImportWorkflow.run, payload,
                                                     id=f"distribution-smoke-{uuid.uuid4()}", task_queue=task_queue)
            result = await handle.result()
            history = await handle.fetch_history()
        await Replayer(workflows=[ManualCaptureImportWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
    assert result.status == "succeeded"
    assert tuple(conn.execute("SELECT status,error_code FROM workflow_run_projections WHERE workflow_id=?", (handle.id,)).fetchone()) == ("succeeded", None)
    assert conn.execute("SELECT status FROM manual_capture_queue").fetchone()[0] == "imported"
    assert conn.execute("SELECT COUNT(*) FROM posting_snapshot_sets").fetchone()[0] == 1
    selected = json.loads(conn.execute("SELECT envelope_json FROM semantic_determinations WHERE kind='posting_extraction'").fetchone()[0])
    assert selected["result"]["title"]["value"] == "Distribution Smoke Engineer"
    assert selected["result"]["employer"]["value"] == "Offline Fixture"
    assert selected["result"]["location"]["value"] == "Barcelona, Spain"
    assert selected["result"]["description"]["value"] == description.strip()
    assert model.schemas == ["PageInterpretation", "PostingSelectionExtraction", "DescriptionQuality"]


def test_release_model_refuses_unrelated_calls(smoke_model):
    module, _, _ = smoke_model
    with pytest.raises(RuntimeError, match="Unexpected distribution smoke model schema"):
        module.DistributionSmokePageModel().chat_json([], response_schema={"title": "ClaimVerification"})
