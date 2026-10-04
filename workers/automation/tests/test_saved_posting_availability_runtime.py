"""Production workflow/dispatch and preflight entry points with synthetic transport."""
from datetime import datetime, timedelta, timezone
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sqlite3
import socket
import threading
import subprocess
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from temporalio.worker import UnsandboxedWorkflowRunner, Worker
from typer.testing import CliRunner

from jobctrl import config, database
from jobctrl.domain.errors import MissingInputError
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.enrichment import availability
from jobctrl.enrichment.availability_workflow import (
    AvailabilityWorkflowInput, SavedPostingAvailabilityWorkflow, availability_workflow_spec,
    check_saved_posting_availability_activity, reconcile_saved_posting_availability,
)
from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch, current_runtime_identity
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.infrastructure.temporal.registry import ACTIVITIES, WORKFLOWS

from .availability_transports import POSTING_URL, SyntheticAvailabilityTransport
from .temporal_env import time_skipping_env
from .rpc_contract_probe import build_server

JOB = "10000000-0000-4000-8000-000000000123"


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    db_path = tmp_path / "runtime.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    conn = database.init_db(db_path)
    conn.execute("INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Synthetic role', 'synthetic', ?)",
                 (JOB, POSTING_URL, datetime.now(timezone.utc).isoformat()))
    conn.execute("INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, updated_at) VALUES ('local', ?, 'enriched', 'Accepted synthetic description', ?)",
                 (JOB, datetime.now(timezone.utc).isoformat()))
    conn.commit()
    control = tmp_path / "employer-control.json"
    control.write_text(json.dumps({"state": "active"}))
    monkeypatch.setattr(availability, "public_get", SyntheticAvailabilityTransport(control).get)
    yield SimpleNamespace(conn=conn, path=db_path, app=tmp_path, control=control, identity=current_runtime_identity())
    database.close_connection(db_path)


@pytest.mark.asyncio
async def test_real_temporal_activity_and_registered_workflow_record_current_evidence(runtime):
    assert SavedPostingAvailabilityWorkflow in WORKFLOWS
    assert check_saved_posting_availability_activity in ACTIVITIES
    async with time_skipping_env() as env:
        queue = "availability-production-fixture"
        async with Worker(env.client, task_queue=queue, workflows=[SavedPostingAvailabilityWorkflow],
                          activities=[check_saved_posting_availability_activity, record_workflow_started, record_workflow_outcome],
                          workflow_runner=UnsandboxedWorkflowRunner()):
            result = await env.client.execute_workflow(SavedPostingAvailabilityWorkflow.run,
                AvailabilityWorkflowInput("local", JOB, str(runtime.app), str(runtime.path)),
                id=f"availability-local-{JOB}", task_queue=queue)
    assert result["verdict"] == "active" and result["lastSuccessfullyVerifiedAt"]
    assert result["lineage"][0]["rawHash"]
    events = [row[0] for row in runtime.conn.execute("SELECT event_type FROM job_events")]
    assert "WorkflowStarted" in events and "WorkflowCompleted" in events and "JobAvailabilityObserved" in events
    assert not runtime.conn.in_transaction


@pytest.mark.asyncio
async def test_startup_heartbeat_admission_is_durable_bounded_and_runtime_bound(runtime, monkeypatch):
    client = SimpleNamespace(start_workflow=AsyncMock())
    assert await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert not await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert client.start_workflow.await_count == 1
    payload = client.start_workflow.call_args.args[1]
    assert payload.expected_db_path == str(runtime.path) and payload.job_id is None
    now = availability._now() + timedelta(minutes=2)
    monkeypatch.setattr(availability, "_now", lambda: now)
    assert await reconcile_saved_posting_availability(client, "owned-queue", runtime.identity)
    assert client.start_workflow.await_count == 2


def test_rpc_command_is_strict_and_uses_canonical_job_and_current_runtime(runtime):
    params = {"tenantId": "local", "jobId": JOB, "expectedAppDir": str(runtime.app), "expectedDbPath": str(runtime.path)}
    spec = availability_workflow_spec(params)
    assert spec.workflow is SavedPostingAvailabilityWorkflow and spec.args[0].job_id == JOB
    for bad in [{**params, "bypass": True}, {**params, "jobId": POSTING_URL}, {"jobId": JOB}, {**params, "expectedDbPath": "/tmp/other.db"}]:
        with pytest.raises((ValueError, RuntimeIdentityMismatch)):
            availability_workflow_spec(bad)


def test_registered_rpc_server_and_cli_dispatch_the_strict_saved_job_command(runtime, monkeypatch):
    from jobctrl import cli
    specs = []
    server = build_server(started_specs=specs)
    params = {"tenantId": "local", "jobId": JOB, "expectedAppDir": str(runtime.app), "expectedDbPath": str(runtime.path)}
    output = io.StringIO()
    server.serve(stdin=io.StringIO(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "check_posting_availability", "params": params}) + "\n"), stdout=output)
    assert json.loads(output.getvalue())["result"]["workflowId"] == "synthetic-workflow"
    assert specs[0].args[0].job_id == JOB
    captured = []
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(cli, "_run_workflow_spec_from_cli", lambda spec, **kw: captured.append(spec) or {"verdict": "active"})
    result = CliRunner().invoke(cli.app, ["check-availability", JOB])
    assert result.exit_code == 0, result.exception
    assert captured[0].args[0].expected_db_path == str(runtime.path)
    assert '"verdict": "active"' in result.stdout


def test_unknown_preflight_stops_real_scoring_before_provider_and_keeps_stage_attempts(runtime, monkeypatch):
    from jobctrl.scoring import scorer
    runtime.control.write_text(json.dumps({"state": "unknown"}))
    monkeypatch.setattr(scorer, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(scorer, "_ensure_employer_analysis_for_job", lambda **kw: pytest.fail("unknown posting spent provider work"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    with pytest.raises(MissingInputError, match="Check availability"):
        scorer.score_job_by_id(JOB, tenant_id=LOCAL_TENANT, profile_snapshot=SimpleNamespace(), resume_text="Synthetic", require_employer_analysis=False)
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert availability.read_availability(runtime.conn, JOB)["verdict"] == "unknown"


def test_unknown_preflight_stops_apply_before_attempt_or_provider(runtime, monkeypatch):
    from jobctrl.apply import launcher
    runtime.control.write_text(json.dumps({"state": "unknown"}))
    monkeypatch.setattr(launcher, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(launcher, "_build_use_case", lambda: pytest.fail("unknown posting launched application"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    assert launcher.run_job({"job_id": JOB, "url": POSTING_URL}, 1, tenant_id=LOCAL_TENANT, dry_run=True) == ("blocked", 0)
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert not runtime.conn.execute("SELECT 1 FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmissionIntentRecorded')").fetchone()


@pytest.mark.parametrize("stage", ["score", "tailor", "cover"])
def test_canonical_posting_change_after_real_preflight_stops_costly_preparation_and_attempt(runtime, monkeypatch, stage):
    from jobctrl.scoring import scorer, tailor, cover_letter
    from jobctrl.domain.identifiers import JobId
    from .test_apply_regressions import _insert_ready_job
    url = POSTING_URL + "-race"
    job_id = _insert_ready_job(runtime.conn, url=url)
    runtime.conn.execute("UPDATE job_materials SET status = 'resume_approved' WHERE job_id = ?", (job_id,))
    runtime.conn.commit()
    real_guard = availability.require_fresh_active
    def race(*args, **kwargs):
        real_guard(*args, **kwargs)
        with sqlite3.connect(runtime.path) as peer:
            peer.execute("UPDATE jobs SET url = ? WHERE tenant_id = 'local' AND job_id = ?", (url + "-replacement", job_id))
    monkeypatch.setattr(availability, "require_fresh_active", race)
    for module in (scorer, tailor, cover_letter):
        monkeypatch.setattr(module, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(tailor, "_tailor_one_job", lambda *_a, **_k: pytest.fail("changed posting dispatched tailoring"))
    monkeypatch.setattr(cover_letter, "_build_use_case", lambda *_a, **_k: pytest.fail("changed posting dispatched cover"))
    monkeypatch.setattr(scorer, "_build_use_case", lambda *_a, **_k: pytest.fail("changed posting dispatched scoring"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    with pytest.raises(MissingInputError, match="candidate changed"):
        if stage == "tailor":
            tailor.tailor_job_by_id(JobId(job_id), tenant_id=LOCAL_TENANT, retailor=True, snapshot=SimpleNamespace())
        elif stage == "cover":
            cover_letter.cover_letter_by_id(JobId(job_id), tenant_id=LOCAL_TENANT, snapshot=SimpleNamespace())
        else:
            scorer.score_job_by_id(JobId(job_id), tenant_id=LOCAL_TENANT, profile_snapshot=SimpleNamespace(), resume_text="Synthetic", require_employer_analysis=False)
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert not runtime.conn.in_transaction


def test_reviewed_submit_guard_cannot_use_replacement_posting_evidence_for_original_intent(runtime, monkeypatch):
    from jobctrl.apply import launcher
    from .availability_fixture import seed_fresh_availability
    monkeypatch.setattr(launcher, "get_connection", lambda: runtime.conn)
    replacement = POSTING_URL + "-replacement"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (replacement, JOB))
    seed_fresh_availability(runtime.conn, JOB)
    runtime.conn.commit()
    with pytest.raises(MissingInputError):
        with launcher._authorize_posting_before_submit("local", JOB, POSTING_URL, "original-run"):
            pytest.fail("replacement posting authorized original submit intent")
    assert not runtime.conn.execute("SELECT 1 FROM job_events WHERE event_type = 'ApplySubmitIntended'").fetchone()


def test_batch_scoring_fences_posting_changes_before_stage_attempt_or_provider(runtime, monkeypatch):
    from jobctrl.scoring import scorer
    from jobctrl.domain.scoring.value_objects import ScoringCriteria
    from jobctrl.domain.profile.aggregate import Profile
    from jobctrl.domain.profile.snapshot import ProfileSnapshot
    real_guard = availability.require_fresh_active
    def race(job_id, **kwargs):
        real_guard(job_id, **kwargs)
        with sqlite3.connect(runtime.path) as peer:
            peer.execute("UPDATE jobs SET url = ? WHERE tenant_id = 'local' AND job_id = ?", (POSTING_URL + "-replacement", job_id))
    monkeypatch.setattr(availability, "require_fresh_active", race)
    monkeypatch.setattr(scorer, "get_connection", lambda: runtime.conn)
    monkeypatch.setattr(scorer, "_build_use_case", lambda **_: SimpleNamespace(execute=lambda **_: pytest.fail("changed posting executed scoring")))
    monkeypatch.setattr(scorer, "_ensure_employer_analysis_for_job", lambda **_: pytest.fail("changed posting spent analysis work"))
    before = runtime.conn.execute("SELECT * FROM job_stage_states").fetchall()
    snapshot = ProfileSnapshot.from_profile(Profile.from_dict(LOCAL_TENANT, {"personal": {"full_name": "Synthetic Tester"}, "resume": {"executive_profile": {"baseline_text": "Synthetic engineer"}, "experience_entries": [{"id": "synthetic-role", "title": "Engineer", "company": "Synthetic Employer"}], "education_entries": [], "skill_categories": []}}))
    result = scorer.run_scoring(profile_snapshot=snapshot, resume_text="Synthetic", criteria=ScoringCriteria(),
                                rescore=True, require_employer_analysis=False)
    assert result["scored"] == 0
    assert runtime.conn.execute("SELECT * FROM job_stage_states").fetchall() == before
    assert not runtime.conn.in_transaction


def test_real_chromium_hidden_css_status_requires_visibility_and_retains_fallback_lineage(runtime, monkeypatch):
    public_url = "https://93.184.216.34/jobs/role-123"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (public_url, JOB))
    runtime.conn.commit()
    html = ('<html><head><style>.status-template{display:none}</style><script type="application/ld+json">'
            + json.dumps({"@type": "JobPosting", "url": public_url, "description": "Synthetic accepted role"})
            + '</script></head><body><aside class="status-template">Applications are closed</aside>'
              '<main><div class="job-description">Synthetic accepted role</div></main></body></html>')
    value = availability.check_availability(JOB, conn=runtime.conn,
        transport=lambda url: availability.Response(url, url, 200, html.encode()))
    assert value["verdict"] == "active", value
    assert value["method"] == "anonymous_browser"
    assert [step["method"] for step in value["lineage"]] == ["public_http", "browser_resource", "anonymous_browser"]
    assert all(step["rawHash"] for step in value["lineage"])


def test_reviewed_submit_fences_original_posting_and_run_until_intent_persistence(runtime, monkeypatch):
    from jobctrl.apply import launcher
    from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state
    from .availability_fixture import seed_fresh_availability
    monkeypatch.setattr(launcher, "get_connection", lambda: runtime.conn)
    ensure_job_stage_rows(runtime.conn, JOB)
    set_stage_state(runtime.conn, JOB, "apply", "running", validate_transition=False)
    record_job_event(runtime.conn, JOB, "apply", "ApplyRunStarted", payload={"run_id": "owned-run"})
    seed_fresh_availability(runtime.conn, JOB)
    runtime.conn.commit()
    with launcher._authorize_posting_before_submit("local", JOB, POSTING_URL, "owned-run"):
        assert runtime.conn.in_transaction
        with sqlite3.connect(runtime.path, timeout=0) as peer:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                peer.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (POSTING_URL + "-replacement", JOB))
        record_job_event(runtime.conn, JOB, "apply", "ApplySubmitIntended", payload={"run_id": "owned-run"})
    assert not runtime.conn.in_transaction
    assert runtime.conn.execute("SELECT 1 FROM job_events WHERE event_type = 'ApplySubmitIntended'").fetchone()
    with sqlite3.connect(runtime.path, timeout=0) as peer:
        peer.execute("UPDATE jobs SET title = 'Synthetic after intent' WHERE job_id = ?", (JOB,))


def test_real_chromium_renderer_hang_is_cancelled_before_lease_expiry_and_successor_admitted(runtime, monkeypatch):
    public_url = "https://93.184.216.34/jobs/hanging-renderer"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (public_url, JOB))
    runtime.conn.commit()
    html = b"""<html><head><title>Synthetic hanging role</title><script>
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => { while (true) {} }, 0));
        </script></head><body><main>Synthetic unresolved posting</main></body></html>"""
    groups = set()
    real_stop = availability._stop_browser_process
    def stop(process, known_groups=None):
        inventory = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid="], capture_output=True, text=True, check=True, timeout=1)
        rows = [tuple(map(int, line.split())) for line in inventory.stdout.splitlines() if line.strip()]
        owned = {process.pid}
        while True:
            descendants = {pid for pid, parent, _group in rows if parent in owned}
            if descendants <= owned:
                break
            owned.update(descendants)
        groups.update(group for pid, _parent, group in rows if pid in owned)
        real_stop(process, known_groups)
    monkeypatch.setattr(availability, "_stop_browser_process", stop)
    monkeypatch.setattr(availability, "ACQUISITION_TIMEOUT_SECONDS", 8)
    started = time.monotonic()
    before = runtime.conn.execute("SELECT full_description FROM job_enrichments WHERE job_id = ?", (JOB,)).fetchone()[0]
    value = availability.check_availability(JOB, conn=runtime.conn,
        transport=lambda url: availability.Response(url, url, 200, html))
    assert value["verdict"] == "unknown" and value["reason"] == "acquisition_deadline", value
    assert time.monotonic() - started < 10 < availability.LEASE_TTL.total_seconds()
    assert not value["checkInProgress"] and value["lastSuccessfullyVerifiedAt"] is None
    assert [step["method"] for step in value["lineage"]] == ["public_http", "browser_resource", "anonymous_browser"]
    assert all(step["rawHash"] for step in value["lineage"][:2])
    assert value["lineage"][-1]["error"] == "acquisition_deadline"
    assert value["lineage"][-1]["signals"] == [{"kind": "browser_phase", "value": "capture"}]
    assert runtime.conn.execute("SELECT full_description FROM job_enrichments WHERE job_id = ?", (JOB,)).fetchone()[0] == before
    assert len(groups) >= 2, "fixture did not launch the owned driver and Chromium groups"
    inventory = subprocess.run(["ps", "-axo", "pgid=,stat="], capture_output=True, text=True, check=True, timeout=1)
    assert not [row for row in inventory.stdout.splitlines() if row.strip() and int(row.split()[0]) in groups and not row.split()[1].startswith("Z")]
    successor_id = "20000000-0000-4000-8000-000000000123"
    runtime.conn.execute("INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Synthetic successor', 'synthetic', ?)",
                         (successor_id, public_url + "-successor", datetime.now(timezone.utc).isoformat()))
    runtime.conn.commit()
    claim, reason = availability.claim_job(runtime.conn, successor_id)
    assert claim and reason == "claimed"
    host_state = availability._latest(runtime.conn, "local", "availability_lease", "host:93.184.216.34")
    assert not host_state.get("owner")
    expires_at = availability._instant(host_state["expiresAt"])
    assert expires_at is not None and expires_at <= availability._now()
    assert not runtime.conn.in_transaction
    previous_next_start = availability._instant(host_state["nextStartAt"])
    assert previous_next_start is not None
    # Released ownership retains the required spacing from the last host start.
    availability.Acquisition(runtime.conn, claim)._pace(public_url)
    host = availability.reserve_request(runtime.conn, claim, public_url)
    successor_next_start = availability._instant(availability._latest(
        runtime.conn, "local", "availability_lease", "host:93.184.216.34")["nextStartAt"])
    assert successor_next_start is not None
    assert successor_next_start - timedelta(seconds=2) >= previous_next_start
    availability.release_host(runtime.conn, claim, host)
    availability.complete_check(runtime.conn, claim, verdict="unknown", reason="synthetic_successor", method="fixture", lineage=[])


@pytest.fixture
def native_sinks():
    hits = []
    class Sink(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            if self.path == "/service-worker.js":
                self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            if self.path == "/service-worker.js":
                self.wfile.write(b"fetch('/worker-owned-sink'); self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));")
        def log_message(self, *_):
            pass
    http = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    thread = threading.Thread(target=http.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
    thread.start()
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))
    udp.settimeout(.05)
    try:
        yield SimpleNamespace(hits=hits, http=f"http://127.0.0.1:{http.server_port}", udp=udp, udp_port=udp.getsockname()[1])
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=1)
        udp.close()


def test_real_context_guard_blocks_native_service_worker_prototype_without_unowned_requests(native_sinks, monkeypatch):
    from jobctrl.infrastructure.network import url_safety
    # Own loopback gives Chromium a secure service-worker origin. Only the
    # deterministic main document is admitted; every other URL uses real policy.
    main_url = native_sinks.http + "/jobs/service-worker-prototype"
    validate = url_safety.validate_public_http_url
    monkeypatch.setattr(url_safety, "validate_public_http_url",
                        lambda url, **kwargs: url_safety.PublicUrlDecision(True) if url == main_url else validate(url, **kwargs))
    metadata = json.dumps({"@type": "JobPosting", "url": main_url, "description": "Current synthetic role"})
    html = ("<html><head><title>Synthetic guarded role</title></head><body><main>Current synthetic role</main><script>"
            "const ld = document.createElement('script'); ld.type = 'application/ld+json'; "
            f"ld.textContent = JSON.stringify({metadata}); document.head.appendChild(ld); "
            "try {ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/service-worker.js').catch(() => {});} catch (_) {}"
            "const until = performance.now() + 1500; while (performance.now() < until) {}"
            "</script></body></html>").encode()
    calls = []
    def fetch(url, method):
        calls.append((url, method))
        assert url == main_url, "service-worker URL reached the guarded transport"
        return availability.Response(url, url, 200, html)
    rendered = availability._anonymous_browser_in_process(main_url, fetcher=fetch, deadline=time.monotonic() + 20)
    assert native_sinks.hits == []
    assert not rendered.status_evidence_complete
    assert rendered.status_evidence_reason == "unsupported_browser_channel"
    assert calls == [(main_url, "browser_resource")]


@pytest.mark.parametrize("channel", ["popup", "service_worker", "worker", "shared_worker", "websocket", "webtransport", "webrtc"])
def test_real_context_guard_blocks_private_popup_and_unowned_native_channels_before_outbound(runtime, native_sinks, channel):
    public_url = "https://93.184.216.34/jobs/context-guard"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (public_url, JOB))
    runtime.conn.commit()
    target = native_sinks.http + "/" + channel
    scripts = {
        "popup": f"window.open({json.dumps(target)})",
        "service_worker": "navigator.serviceWorker.register('/service-worker.js')",
        "worker": "new Worker('/worker.js')",
        "shared_worker": "new SharedWorker('/shared-worker.js')",
        "websocket": f"new WebSocket({json.dumps(target.replace('http:', 'ws:'))})",
        "webtransport": f"new WebTransport({json.dumps(target.replace('http:', 'https:'))})",
        "webrtc": f"const peer = new RTCPeerConnection({{iceServers: [{{urls: 'stun:127.0.0.1:{native_sinks.udp_port}'}}]}}); peer.createDataChannel('probe'); peer.createOffer().then(value => peer.setLocalDescription(value))",
    }
    metadata = json.dumps({"@type": "JobPosting", "url": public_url, "description": "Current synthetic role"})
    html = ("<html><head><title>Synthetic guarded role</title></head><body><main>Current synthetic role</main><script>"
            "const ld = document.createElement('script'); ld.type = 'application/ld+json'; "
            f"ld.textContent = JSON.stringify({metadata}); document.head.appendChild(ld); "
            f"try {{ {scripts[channel]}; }} catch (_) {{}}"
            "</script></body></html>").encode()
    calls = []
    def fetch(url):
        calls.append(url)
        assert url == public_url, "unsupported destination escaped the guarded acquisition"
        return availability.Response(url, url, 200, html)
    value = availability.check_availability(JOB, conn=runtime.conn, transport=fetch)
    assert value["verdict"] == "unknown", value
    assert (value["reason"].startswith("browser_guard:") if channel == "popup"
            else value["reason"] == "unsupported_browser_channel"), value
    assert calls == [public_url, public_url]
    assert native_sinks.hits == []
    with pytest.raises(socket.timeout):
        native_sinks.udp.recvfrom(1024)
    assert not value["checkInProgress"] and not runtime.conn.in_transaction
    assert value["lastSuccessfullyVerifiedAt"] is None
    assert value["lineage"][-1]["method"] == "anonymous_browser" and value["lineage"][-1]["rawHash"]


@pytest.mark.parametrize("secondary", ["popup", "popup_worker", "iframe_worker"])
def test_real_context_guard_routes_first_public_popup_through_actual_host_ledger_and_ipc(runtime, secondary):
    public_url = "https://93.184.216.34/jobs/public-popup"
    popup_url = "https://1.1.1.1/synthetic-popup"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (public_url, JOB))
    runtime.conn.commit()
    metadata = json.dumps({"@type": "JobPosting", "url": public_url, "description": "Current synthetic role"})
    launch = (f"const frame = document.createElement('iframe'); frame.src = {json.dumps(popup_url)}; document.body.appendChild(frame)"
              if secondary == "iframe_worker" else f"window.open({json.dumps(popup_url)})")
    html = ("<html><head><title>Synthetic guarded role</title></head><body><main>Current synthetic role</main><script>"
            "const ld = document.createElement('script'); ld.type = 'application/ld+json'; "
            f"ld.textContent = JSON.stringify({metadata}); document.head.appendChild(ld); {launch};"
            "</script></body></html>").encode()
    calls = []
    def fetch(url):
        calls.append(url)
        assert url in {public_url, popup_url}
        secondary_body = b"<html><body>Synthetic secondary page</body></html>"
        if secondary.endswith("worker"):
            secondary_body = b"<html><body><script>try {new Worker('/secondary-worker.js')} catch (_) {}</script></body></html>"
        return availability.Response(url, url, 200, html if url == public_url else secondary_body)
    value = availability.check_availability(JOB, conn=runtime.conn, transport=fetch)
    assert value["verdict"] == ("active" if secondary == "popup" else "unknown"), value
    if secondary.endswith("worker"):
        assert value["reason"] == "unsupported_browser_channel", value
    assert calls == [public_url, public_url, popup_url]
    host = availability._latest(runtime.conn, "local", "availability_lease", "host:1.1.1.1")
    assert host["nextStartAt"] and host["expiresAt"] and not host.get("owner")
    outbound = runtime.conn.execute("SELECT payload_json FROM job_events WHERE entity_kind = 'availability_request'").fetchall()
    assert sum(json.loads(row[0])["host"] == "1.1.1.1" for row in outbound) == 1
    assert any(step["sourceUrl"] == popup_url and step["method"] == "browser_resource" and step["rawHash"] for step in value["lineage"])


def test_real_context_guard_keeps_failed_status_resource_uncertain_with_its_hash(runtime):
    public_url = "https://93.184.216.34/jobs/resource-failure"
    module_url = "https://1.1.1.1/synthetic-status.js"
    runtime.conn.execute("UPDATE jobs SET url = ? WHERE job_id = ?", (public_url, JOB))
    runtime.conn.commit()
    metadata = json.dumps({"@type": "JobPosting", "url": public_url, "description": "Current synthetic role"})
    html = ("<html><head><title>Synthetic guarded role</title></head><body><main>Current synthetic role</main><script>"
            "const ld = document.createElement('script'); ld.type = 'application/ld+json'; "
            f"ld.textContent = JSON.stringify({metadata}); document.head.appendChild(ld);"
            f"</script><script src='{module_url}'></script></body></html>").encode()
    def fetch(url):
        assert url in {public_url, module_url}
        return availability.Response(url, url, 200 if url == public_url else 503,
                                     html if url == public_url else b"Synthetic status endpoint failure")
    value = availability.check_availability(JOB, conn=runtime.conn, transport=fetch)
    assert value["verdict"] == "unknown" and value["reason"] == "browser_guard: browser_resource_http_503", value
    assert any(step["sourceUrl"] == module_url and step["status"] == 503 and step["rawHash"] for step in value["lineage"])
    assert not value["checkInProgress"]
