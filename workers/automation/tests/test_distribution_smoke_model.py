"""Exercise the release-only model port through actual capture persistence."""

import importlib.util
import json
from pathlib import Path

import pytest

from jobctrl import config
from jobctrl.database import init_db
from jobctrl.discovery.manual_capture_workflow import (
    ManualCaptureImportWorkflowInput,
    execute_manual_capture_import,
)
from jobctrl.domain.determinations import DeterminationFailure


@pytest.fixture
def smoke_model(monkeypatch, tmp_path):
    import jobctrl.database as database
    import jobctrl.infrastructure.enrichment.page_interpretation as page

    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(tmp_path / "config.json"))
    # Register restoration for the release bootstrap's page-only binding.
    monkeypatch.setattr(page, "determination_dependencies", page.determination_dependencies)
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
    assert {row["kind"] for row in records} == {"page_interpretation", "description_quality"}
    for row in records:
        assert (row["provider"], row["model"], row["lane"]) == (
            "distribution-smoke", "explicit-page-fixture", "enrichment",
        )
    page = next(json.loads(row["envelope_json"]) for row in records if row["kind"] == "page_interpretation")
    assert page["result"]["availability"]["value"] == availability
    assert execute_manual_capture_import(payload, conn=conn) == first
    assert model.calls == 2


def test_release_model_retains_spend_preflight_and_pending_capture(smoke_model, monkeypatch):
    import jobctrl.llm as llm

    module, conn, payload = smoke_model
    model = module.DistributionSmokePageModel()
    module.install_smoke_model(model)

    def deny(*, lane):
        assert lane == "enrichment"
        raise RuntimeError("Synthetic budget denial")

    monkeypatch.setattr(llm, "enforce_spend_budget", deny)
    with pytest.raises(DeterminationFailure, match="budget_denied"):
        execute_manual_capture_import(payload, conn=conn)
    assert model.calls == 0
    assert conn.execute("SELECT status FROM manual_capture_queue").fetchone()[0] == "pending"
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0


def test_release_model_refuses_unrelated_calls(smoke_model):
    module, _, _ = smoke_model
    with pytest.raises(RuntimeError, match="Unexpected distribution smoke model schema"):
        module.DistributionSmokePageModel().chat_json([], response_schema={"title": "ClaimVerification"})
