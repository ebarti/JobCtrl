"""Exact-v7 proof for the canonical per-job tailoring execution path."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.testing import ActivityEnvironment
from temporalio.exceptions import ApplicationError

from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    EmployerAnalysis,
    JobAnalysis,
    ReasonedKeyword,
    compute_snapshot_hash,
)
from jobctrl.domain.materials.quality import ArtifactBudgetViolation
from jobctrl.domain.materials.use_cases import (
    ArtifactBudgetInfeasibleError,
    TailoringPrerequisiteError,
)
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.materials import activities as activities_module
from jobctrl.materials.activities import TailorJobActivityInput
from jobctrl.scoring import tailor as tailor_module

_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_ID = canonical_job_id("30000000-0000-4000-8000-000000000001")


@pytest.fixture()
def batch_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Real activity/selector/state with a separate connection per worker."""
    from jobctrl import config, database
    from jobctrl.pipeline import runner

    db_path = tmp_path / "batch.db"
    database.init_db(db_path)
    database.close_connection()
    local = threading.local()
    connections = []

    def connect():
        if not hasattr(local, "connection"):
            local.connection = sqlite3.connect(db_path, check_same_thread=False)
            local.connection.row_factory = sqlite3.Row
            connections.append(local.connection)
        return local.connection

    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    for module in (database, runner, tailor_module):
        monkeypatch.setattr(module, "get_connection", connect)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    snapshot = _snapshot(_TENANT_A)
    snapshots = []

    def load_snapshot(tenant_id):
        snapshots.append(tenant_id)
        return snapshot

    monkeypatch.setattr(
        "jobctrl.infrastructure.profile.get_profile_repository",
        lambda: SimpleNamespace(load_snapshot=load_snapshot),
    )
    yield SimpleNamespace(
        connect=connect, snapshots=snapshots, snapshot=snapshot,
        app_dir=str(tmp_path), db_path=str(db_path),
    )
    for connection in connections:
        connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("selected", [False, True])
async def test_tailor_activity_routes_share_canonical_tenant_state(batch_runtime, monkeypatch, selected):
    conn = batch_runtime.connect()
    job_ids = tuple(canonical_job_id(f"30000000-0000-4000-8000-{i:012d}") for i in range(1, 4))
    for job_id in job_ids:
        _seed_job(conn, tenant_id=_TENANT_A, job_id=job_id, url=f"https://example.test/{job_id}")
    _seed_job(conn, tenant_id=_TENANT_B, url="https://example.test/other-tenant", fit_score=10)
    calls = []

    def generate(job, _legacy_text, snapshot, validation_mode, **kwargs):
        calls.append((job, snapshot, validation_mode, kwargs))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "_tailor_one_job", generate)
    output = await ActivityEnvironment().run(
        activities_module.tailor_activity,
        activities_module.TailorActivityInput(
            tenant_id=str(_TENANT_A), expected_app_dir=batch_runtime.app_dir,
            expected_db_path=batch_runtime.db_path, workers=2, limit=2,
            job_ids=job_ids if selected else (), validation_mode="lenient",
            tailor_models=("codex:fixture",), tailor_judge_model="codex:judge",
            tailor_judge_min_score=0.91, workflow_id="batch-owner",
        ),
    )
    assert output.status == "ok"
    assert output.stages[0]["approved"] == 2
    assert len(calls) == 2
    for job, snapshot, mode, kwargs in calls:
        assert job["tenant_id"] == str(_TENANT_A)
        assert snapshot is batch_runtime.snapshot
        assert mode == "lenient"
        assert kwargs["llm_policy"].candidate_models == ("codex:fixture",)
        assert kwargs["llm_policy"].judge_model == "codex:judge"
        assert kwargs["llm_policy"].judge_min_score == 0.91
        assert kwargs["audit_execution_id"] == "batch-owner"
        assert callable(kwargs["commit_guard"])
    if not selected:
        assert batch_runtime.snapshots == [_TENANT_A]
        assert calls[0][3]["llm_policy"] is calls[1][3]["llm_policy"]
    states = conn.execute(
        "SELECT state, attempt_count FROM job_stage_states WHERE tenant_id = ? AND stage = 'tailor'",
        (str(_TENANT_A),),
    ).fetchall()
    assert sorted(tuple(row) for row in states) == [("pending", 0), ("succeeded", 1), ("succeeded", 1)]
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND stage = 'tailor' AND event_type = 'StageStarted'",
        (str(_TENANT_B),),
    ).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_unscoped_tailor_activity_cancellation_stops_dispatch_and_preserves_successor(batch_runtime, monkeypatch):
    conn = batch_runtime.connect()
    job_ids = tuple(canonical_job_id(f"30000000-0000-4000-8000-{i:012d}") for i in range(1, 6))
    for job_id in job_ids:
        _seed_job(conn, tenant_id=_TENANT_A, job_id=job_id, url=f"https://example.test/{job_id}")
    started = asyncio.Event()
    loop = asyncio.get_running_loop()
    release = threading.Event()
    finished = threading.Event()
    all_returned = threading.Event()
    lock = threading.Lock()
    dispatched = []
    rejected = []
    returned = []
    canonical_tailor = tailor_module.tailor_job_by_id

    def run_job(job_id, **kwargs):
        try:
            return canonical_tailor(job_id, **kwargs)
        finally:
            with lock:
                returned.append(job_id)
                if len(returned) == 2:
                    all_returned.set()

    def generate(job, *_args, **kwargs):
        with lock:
            dispatched.append(job["job_id"])
            if len(dispatched) == 2:
                loop.call_soon_threadsafe(started.set)
        assert release.wait(5), "fixture release missing"
        try:
            kwargs["commit_guard"]()
        except RuntimeError:
            with lock:
                rejected.append(job["job_id"])
                if len(rejected) == 2:
                    finished.set()
            raise
        raise AssertionError("canceled generation passed persistence fence")

    monkeypatch.setattr(tailor_module, "_tailor_one_job", generate)
    monkeypatch.setattr(tailor_module, "tailor_job_by_id", run_job)
    task = asyncio.create_task(ActivityEnvironment().run(
        activities_module.tailor_activity,
        activities_module.TailorActivityInput(
            tenant_id=str(_TENANT_A), expected_app_dir=batch_runtime.app_dir,
            expected_db_path=batch_runtime.db_path, workers=2, workflow_id="old-owner",
        ),
    ))
    try:
        await asyncio.wait_for(started.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        successor = dispatched[0]
        conn.execute(
            "UPDATE job_stage_states SET state = 'running', metadata_json = ? WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (json.dumps({"activityOwner": "successor"}), str(_TENANT_A), successor),
        )
        conn.commit()
    finally:
        release.set()
        await asyncio.to_thread(finished.wait, 5)
        await asyncio.to_thread(all_returned.wait, 5)
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert len(dispatched) == len(rejected) == len(returned) == 2
    assert conn.execute("SELECT COUNT(*) FROM job_materials").fetchone()[0] == 0
    assert conn.execute(
        "SELECT metadata_json FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), successor),
    ).fetchone()[0] == json.dumps({"activityOwner": "successor"})
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND stage = 'tailor' AND event_type = 'StageStarted'",
        (str(_TENANT_A),),
    ).fetchone()[0] == 2
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND stage = 'tailor' AND event_type IN ('StageCompleted', 'StageFailed')",
        (str(_TENANT_A),),
    ).fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("selected", [False, True])
async def test_tailor_activity_keeps_aggregate_and_partial_failure_adapters(batch_runtime, monkeypatch, selected):
    job_ids = (_JOB_ID, canonical_job_id("30000000-0000-4000-8000-000000000002"))
    for job_id in job_ids:
        _seed_job(batch_runtime.connect(), tenant_id=_TENANT_A, job_id=job_id, url=f"https://example.test/{job_id}")

    def generate(job, *_args, **_kwargs):
        if job["job_id"] == str(_JOB_ID):
            return _fake_approved_result(job)
        raise RuntimeError("synthetic generation failure")

    monkeypatch.setattr(tailor_module, "_tailor_one_job", generate)
    invocation = ActivityEnvironment().run(
        activities_module.tailor_activity,
        activities_module.TailorActivityInput(
            tenant_id=str(_TENANT_A), expected_app_dir=batch_runtime.app_dir,
            expected_db_path=batch_runtime.db_path, workers=2,
            job_ids=job_ids if selected else (), workflow_id="mixed-owner",
        ),
    )
    if selected:
        output = await invocation
        assert output.status == "partial"
        assert output.errors == {}
        assert output.stages[0]["approvedJobIds"] == [_JOB_ID]
        assert output.stages[0]["failed"] == 1
    else:
        with pytest.raises(ApplicationError, match="tailoring error"):
            await invocation
    states = batch_runtime.connect().execute(
        "SELECT state, attempt_count FROM job_stage_states WHERE tenant_id = ? AND stage = 'tailor' ORDER BY job_id",
        (str(_TENANT_A),),
    ).fetchall()
    assert [tuple(row) for row in states] == [("succeeded", 1), ("failed", 1)]


@pytest.mark.asyncio
@pytest.mark.parametrize("workers", [1, 2])
@pytest.mark.parametrize("failure", ["before_claim", "successor_fence"])
async def test_unscoped_tailor_activity_finishes_siblings_before_escalating_escaped_error(
    batch_runtime, monkeypatch, caplog, workers, failure,
):
    conn = batch_runtime.connect()
    job_ids = tuple(canonical_job_id(f"30000000-0000-4000-8000-{i:012d}") for i in range(1, 6))
    for job_id in job_ids:
        _seed_job(
            conn, tenant_id=_TENANT_A, job_id=job_id,
            url=f"https://example.test/{job_id}",
            fit_score=10 if job_id == _JOB_ID else 8,
        )
    attempted = []
    generated = []
    load_target = tailor_module.SqlitePreparationTargetReader.load

    def load(self, tenant_id, job_id):
        attempted.append(job_id)
        if job_id == _JOB_ID and failure == "before_claim":
            raise sqlite3.OperationalError("synthetic target read failure")
        return load_target(self, tenant_id, job_id)

    def generate(job, *_args, **kwargs):
        generated.append(job["job_id"])
        if job["job_id"] == str(_JOB_ID):
            current = batch_runtime.connect()
            current.execute(
                "UPDATE job_stage_states SET metadata_json = ? "
                "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
                (json.dumps({"activityOwner": "successor"}), str(_TENANT_A), str(_JOB_ID)),
            )
            current.commit()
            kwargs["commit_guard"]()
            raise AssertionError("stale owner passed persistence fence")
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module.SqlitePreparationTargetReader, "load", load)
    monkeypatch.setattr(tailor_module, "_tailor_one_job", generate)
    with pytest.raises(ApplicationError) as raised:
        await ActivityEnvironment().run(
            activities_module.tailor_activity,
            activities_module.TailorActivityInput(
                tenant_id=str(_TENANT_A), expected_app_dir=batch_runtime.app_dir,
                expected_db_path=batch_runtime.db_path, workers=workers,
                workflow_id="cohort-owner",
            ),
        )

    # Assert durable sibling completion before checking the aggregate error:
    # a fail-fast executor leaves the undispatched cohort pending here.
    assert set(attempted) == set(job_ids)
    assert set(generated) == {
        str(job_id) for job_id in job_ids
        if failure == "successor_fence" or job_id != _JOB_ID
    }
    states = conn.execute(
        "SELECT job_id, state, attempt_count, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND stage = 'tailor' ORDER BY job_id",
        (str(_TENANT_A),),
    ).fetchall()
    assert [(row["state"], row["attempt_count"]) for row in states[1:]] == [("succeeded", 1)] * 4
    terminal_ids = conn.execute(
        "SELECT job_id FROM job_events WHERE tenant_id = ? AND stage = 'tailor' "
        "AND event_type IN ('StageCompleted', 'StageFailed', 'StageExhausted')",
        (str(_TENANT_A),),
    ).fetchall()
    assert sorted(row[0] for row in terminal_ids) == sorted(str(job_id) for job_id in job_ids[1:])
    assert states[0]["attempt_count"] == 0
    if failure == "successor_fence":
        assert states[0]["state"] == "running"
        assert json.loads(states[0]["metadata_json"]) == {"activityOwner": "successor"}
    else:
        assert states[0]["state"] == "pending"
    assert "1 tailoring error(s), 0 failed quality gate(s)" in str(raised.value)
    escaped_errors = [
        record.getMessage() for record in caplog.records
        if record.name == tailor_module.__name__ and record.levelname == "ERROR"
    ]
    cause = (
        "synthetic target read failure" if failure == "before_claim"
        else "tailor activity no longer owns artifact persistence"
    )
    assert escaped_errors == [f"Tailoring failed for job {_JOB_ID}: {cause}"]


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_after_commit", [False, True])
async def test_unscoped_tailor_reuses_commit_before_crash_or_cancellation(batch_runtime, monkeypatch, cancel_after_commit):
    from jobctrl.infrastructure.preparation_recovery import CancelPreparationStateInput, cancel_preparation_state_rows

    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.test/committed-tailor")
    artifact = Path(batch_runtime.app_dir) / "accepted.txt"
    artifact.write_text("Synthetic accepted resume")
    calls = []
    token = []
    canonical_tailor = tailor_module.tailor_job_by_id

    def run_job(job_id, **kwargs):
        token.append(kwargs["cancel_event"])
        return canonical_tailor(job_id, **kwargs)

    def commit_then_fail(job, *_args, **kwargs):
        calls.append(job["job_id"])
        kwargs["commit_guard"]()
        current = batch_runtime.connect()
        current.execute(
            "INSERT INTO job_materials (tenant_id, job_id, generation, status, created_at, updated_at) VALUES (?, ?, 1, 'resume_approved', '2026-09-06', '2026-09-06')",
            (str(_TENANT_A), str(_JOB_ID)),
        )
        current.execute(
            "INSERT INTO job_materials_artifacts (tenant_id, job_id, generation, artifact_type, artifact_id, status, path, render_format, metadata_json, created_at) VALUES (?, ?, 1, 'tailored_resume', 'synthetic-resume', 'approved', ?, 'text', '{}', '2026-09-06')",
            (str(_TENANT_A), str(_JOB_ID), str(artifact)),
        )
        current.commit()
        if cancel_after_commit:
            token[0].set()
        raise RuntimeError("synthetic crash after accepted commit")

    monkeypatch.setattr(tailor_module, "_tailor_one_job", commit_then_fail)
    monkeypatch.setattr(tailor_module, "tailor_job_by_id", run_job)
    payload = activities_module.TailorActivityInput(
        tenant_id=str(_TENANT_A), expected_app_dir=batch_runtime.app_dir,
        expected_db_path=batch_runtime.db_path, workflow_id="committed-owner",
    )
    if cancel_after_commit:
        with pytest.raises(ApplicationError, match="canceled"):
            await ActivityEnvironment().run(activities_module.tailor_activity, payload)
        result = cancel_preparation_state_rows(conn, CancelPreparationStateInput(
            tenant_id=str(_TENANT_A), workflow_id="committed-owner", stage="tailor", job_ids=(str(_JOB_ID),),
        ))
        assert result.restored == 1
    else:
        output = await ActivityEnvironment().run(activities_module.tailor_activity, payload)
        assert output.stages[0]["approved"] == 1
    await ActivityEnvironment().run(activities_module.tailor_activity, payload)
    assert calls == [str(_JOB_ID)]
    assert artifact.read_text() == "Synthetic accepted resume"
    assert conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == "succeeded"


@pytest.fixture()
def conn() -> sqlite3.Connection:
    candidate = sqlite3.connect(":memory:")
    candidate.row_factory = sqlite3.Row
    candidate.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(candidate)
    return candidate


def _seed_job(
    conn: sqlite3.Connection,
    *,
    tenant_id: TenantId,
    job_id: JobId = _JOB_ID,
    url: str,
    fit_score: int = 8,
    eligibility_status: str = "eligible",
    hard_blockers: list[str] | None = None,
) -> None:
    now = "2026-07-31T12:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, description, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            url,
            "Platform Engineer",
            "Acme",
            "Build reliable backend systems.",
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description,
            application_url, enriched_at, extraction_tier, attempts_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            "enriched",
            "Build reliable backend systems with Python.",
            url,
            now,
            "full",
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 1, ?, ?, '[]', ?, NULL, '{}', '{}')
        """,
        (
            str(tenant_id),
            str(job_id),
            fit_score,
            json.dumps(
                {
                    "technical_fit": fit_score,
                    "experience_fit": fit_score,
                    "role_fit": fit_score,
                    "reasoning": "seeded exact-v7 score",
                    "fit_band": "excellent",
                    "confidence": "high",
                    "eligibility": {
                        "status": eligibility_status,
                        "hard_blockers": hard_blockers or [],
                        "warnings": [],
                    },
                }
            ),
            now,
        ),
    )
    tailor_module.ensure_job_stage_rows(
        conn,
        job_id,
        tenant_id=tenant_id,
        discovered_at=now,
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'succeeded'
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (str(tenant_id), str(job_id)),
    )
    conn.commit()


def _fake_approved_result(job: dict) -> dict:
    return {
        "url": job["url"],
        "title": job["title"],
        "site": job.get("site"),
        "status": "approved",
        "attempts": 1,
        "path": "/tmp/tailored.txt",
        "pdf_path": "/tmp/tailored.pdf",
        "materials": SimpleNamespace(generation=1),
    }


def _snapshot(tenant_id: TenantId) -> ProfileSnapshot:
    return ProfileSnapshot.from_profile(
        Profile.from_dict(
            tenant_id,
            {
                "personal": {"full_name": "Candidate"},
                "resume": {
                    "executive_profile": {
                        "baseline_text": "Python platform engineer."
                    },
                    "experience_entries": [
                        {
                            "id": "platform",
                            "title": "Platform Engineer",
                            "company": "Previous Co",
                            "bullets": ["Built Python platform services."],
                        }
                    ],
                    "education_entries": [],
                    "skill_categories": [
                        {"id": "skills", "label": "Skills", "items": ["Python"]}
                    ],
                },
            },
        )
    )


class _FakeAnalyzeUseCase:
    def execute(self, *, job: dict, tenant_id: TenantId, force: bool = False):
        _ = force
        analysis = JobAnalysis(
            role_framing="Platform engineering.",
            inferred_seniority="senior",
            ideal_candidate_narrative="A Python platform engineer.",
            requirements=[],
            keywords=[ReasonedKeyword(keyword="Python", evidence_span="Python")],
        )
        return SimpleNamespace(
            analysis=EmployerAnalysis.build(
                tenant_id=tenant_id,
                job_id=canonical_job_id(str(job["job_id"])),
                generation=1,
                snapshot_hash=compute_snapshot_hash(
                    str(job.get("full_description") or "")
                ),
                canonical=analysis,
                sub_analyses=(),
                failures=(),
                agreement=AnalysisAgreement(score=1.0),
                legs_attempted=2,
            )
        )


class _CancelingTailorLlm:
    model = "test-model"

    def __init__(self, cancel_event: threading.Event) -> None:
        self._cancel_event = cancel_event
        self.calls = 0

    def chat(self, *_args, **_kwargs) -> str:
        self.calls += 1
        self._cancel_event.set()
        return "{}"


def test_tailor_default_runner_fences_cancellation_before_material_or_terminal_write(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The production runner and default shared UOW retain the cancel fence."""

    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/canceled-tailor")
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (?, ?, 1, 1, 1, 1, 'requirement-fit-v1', 8, 'strong',
                  'high', '{}', '2026-07-31T12:00:00+00:00')
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    cancel_event = threading.Event()
    llm = _CancelingTailorLlm(cancel_event)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "get_llm_adapter", lambda: llm)
    monkeypatch.setattr(
        tailor_module,
        "_build_analyze_use_case",
        lambda **_kwargs: _FakeAnalyzeUseCase(),
    )
    monkeypatch.setattr(tailor_module, "_build_voice_port", lambda: None)

    with pytest.raises(RuntimeError, match="tailor activity canceled before persistence"):
        tailor_module.tailor_job_by_id(
            _JOB_ID,
            tenant_id=_TENANT_A,
            snapshot=_snapshot(_TENANT_A),
            tailor_models=("codex:test-model",),
            llm_model=None,
            pdf_renderer=object(),
            workflow_id="workflow-run-canceled",
            cancel_event=cancel_event,
        )

    assert llm.calls == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM job_materials WHERE tenant_id = ? AND job_id = ?",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == 0
    state = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "running"
    assert json.loads(state["metadata_json"])["activityOwner"] == (
        "workflow-run-canceled"
    )
    terminal_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' AND event_type IN ('StageCompleted', 'StageFailed')",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    assert terminal_events == 0


def test_tailor_job_by_id_is_tenant_scoped_and_writes_canonical_state(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/a")
    _seed_job(conn, tenant_id=_TENANT_B, url="https://example.com/b")
    conn.execute(
        """
        UPDATE job_stage_states
           SET state = 'running', attempt_count = 2,
               metadata_json = '{"activityOwner":"cover-run-2"}'
         WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    calls: list[tuple[str, str]] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append((str(job["tenant_id"]), str(job["url"])))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [(str(_TENANT_A), "https://example.com/a")]
    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "succeeded"
    cover_state = conn.execute(
        """
        SELECT state, attempt_count, metadata_json
          FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(cover_state) == (
        "running",
        2,
        '{"activityOwner":"cover-run-2"}',
    )
    assert conn.execute(
        """
        SELECT COUNT(*) FROM job_events
         WHERE tenant_id = ? AND job_id = ?
           AND stage = 'cover' AND event_type = 'StageReset'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == 0
    other_tenant_state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_B), str(_JOB_ID)),
    ).fetchone()
    assert other_tenant_state["state"] == "pending"
    event = conn.execute(
        """
        SELECT tenant_id, job_id, event_type FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        ORDER BY event_id DESC LIMIT 1
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert dict(event) == {
        "tenant_id": str(_TENANT_A),
        "job_id": str(_JOB_ID),
        "event_type": "StageCompleted",
    }


def test_tailor_job_by_id_resets_tailor_owned_cover_block_exactly_once(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/recovered-tailor")
    tailor_module.set_stage_state(
        conn,
        _JOB_ID,
        "tailor",
        "failed",
        tenant_id=_TENANT_A,
        attempt_count=1,
        error_code="FAILED_VALIDATION",
        validate_transition=False,
    )
    conn.commit()
    assert conn.execute(
        "SELECT state FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == "blocked"

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda job, *_args, **_kwargs: _fake_approved_result(job),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    cover_state = conn.execute(
        "SELECT state, error_code FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'cover'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(cover_state) == ("pending", None)
    reset_events = conn.execute(
        """
        SELECT payload_json FROM job_events
         WHERE tenant_id = ? AND job_id = ?
           AND stage = 'cover' AND event_type = 'StageReset'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert len(reset_events) == 1
    assert json.loads(reset_events[0]["payload_json"])["reason"] == "upstream_completed"


def test_tailor_job_by_id_terminalizes_unhandled_item_exception(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/exception")
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider failed")),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        workflow_id="workflow-run-owned",
    )

    assert result["status"] == "error"
    state = conn.execute(
        "SELECT state, error_code, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "failed"
    assert state["error_code"] == "ERROR"
    event = conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' ORDER BY event_id DESC LIMIT 1",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageFailed"


def test_tailor_job_by_id_blocks_stale_requirement_fit_without_consuming_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/stale-fit")
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            TailoringPrerequisiteError(
                reason="requirement_fit_generation_mismatch",
                job_id=str(_JOB_ID),
                analysis_generation=2,
                report_generation=1,
            )
        ),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        workflow_id="workflow-run-stale-fit",
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "requirement_fit_generation_mismatch"
    state = conn.execute(
        "SELECT state, attempt_count, error_code, retryable, blocked_by_json, next_action "
        "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "blocked",
        0,
        "REQUIREMENT_FIT_STALE",
        1,
        '["score"]',
        "Rescore this job, then run Tailor again.",
    )
    event = conn.execute(
        "SELECT event_type, payload_json FROM job_events "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor' "
        "ORDER BY event_id DESC LIMIT 1",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageBlocked"
    assert json.loads(event["payload_json"])["errorCode"] == "REQUIREMENT_FIT_STALE"


def test_tailor_job_by_id_blocks_infeasible_artifact_budget_without_consuming_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/infeasible-budget")
    error = ArtifactBudgetInfeasibleError(
        (
            ArtifactBudgetViolation(
                experience_entry_id="role_1",
                role="Acme — Principal Engineer",
                required_achievement_count=5,
                ceiling=4,
            ),
        )
    )
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        workflow_id="workflow-run-infeasible-budget",
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "artifact_budget_infeasible"
    state = conn.execute(
        "SELECT state, attempt_count, error_code, retryable, blocked_by_json, "
        "next_action, metadata_json FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state)[:5] == (
        "blocked",
        0,
        "ARTIFACT_BUDGET_INFEASIBLE",
        0,
        None,
    )
    assert "Reduce the required achievements" in state["next_action"]
    assert json.loads(state["metadata_json"])["violations"] == [
        {
            "experience_entry_id": "role_1",
            "role": "Acme — Principal Engineer",
            "required_achievement_count": 5,
            "ceiling": 4,
        }
    ]


def test_tailor_job_replay_closes_running_state_from_committed_approved_resume(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/replayed-tailor")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'running'
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    approved = SimpleNamespace(is_resume_approved=True, generation=3)
    repository = SimpleNamespace(load_current_approved=lambda *_args: approved)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "SqliteMaterialsRepository", lambda _conn: repository)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "already_done"
    assert result["materials"] is approved
    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert state["state"] == "succeeded"


def test_retailor_job_replay_reuses_generation_committed_by_same_activity_owner(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/replayed-retailor")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'running', metadata_json = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (
            json.dumps({
                "activityOwner": "workflow-run-owned",
                "retailor": True,
                "priorApprovedGeneration": 2,
            }),
            str(_TENANT_A),
            str(_JOB_ID),
        ),
    )
    conn.commit()
    approved = SimpleNamespace(is_resume_approved=True, generation=3)
    repository = SimpleNamespace(load_current_approved=lambda *_args: approved)
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "SqliteMaterialsRepository", lambda _conn: repository)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
        retailor=True,
        workflow_id="workflow-run-owned",
    )

    assert result["status"] == "already_done"
    assert result["materials"] is approved
    assert conn.execute(
        "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()["state"] == "succeeded"


def test_tailor_job_by_id_enforces_score_boundary_before_generation(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/low-fit", fit_score=6)
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    skipped = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        min_score=7,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert skipped["reason"] == "score_below_threshold"
    skipped_rows = conn.execute(
        """
        SELECT stage, state, error_code, error_message, retryable
          FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ?
           AND stage IN ('tailor', 'cover', 'apply')
         ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["state"] for row in skipped_rows} == {"skipped"}
    assert {row["error_code"] for row in skipped_rows} == {"MIN_SCORE"}
    assert all("6/10" in row["error_message"] for row in skipped_rows)
    assert {row["retryable"] for row in skipped_rows} == {0}

    approved = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        min_score=7,
        allow_low_fit_override=True,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert approved["status"] == "approved"
    assert calls == [str(_JOB_ID)]
    restored_rows = conn.execute(
        """
        SELECT stage, state, error_code
          FROM job_stage_states
         WHERE tenant_id = ? AND job_id = ?
           AND stage IN ('tailor', 'cover', 'apply')
         ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["stage"]: row["state"] for row in restored_rows} == {
        "apply": "pending",
        "cover": "pending",
        "tailor": "succeeded",
    }
    assert {row["error_code"] for row in restored_rows} == {None}


def test_tailor_job_by_id_skips_blocked_scores_without_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(
        conn,
        tenant_id=_TENANT_A,
        url="https://example.com/blocked",
        eligibility_status="blocked",
        hard_blockers=["Sponsorship is required."],
    )

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("blocked job reached generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["reason"] == "score_eligibility_blocked"
    rows = conn.execute(
        """
        SELECT stage, state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage IN ('tailor', 'cover', 'apply')
        ORDER BY stage
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchall()
    assert {row["stage"]: row["state"] for row in rows} == {
        "apply": "blocked",
        "cover": "blocked",
        "tailor": "blocked",
    }


def test_tailor_job_by_id_generates_for_historical_salary_only_block(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(
        conn,
        tenant_id=_TENANT_A,
        url="https://example.com/salary-advisory",
        fit_score=9,
        eligibility_status="blocked",
        hard_blockers=["Base salary is below the preferred compensation range."],
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'blocked', error_code = 'SCORE_ELIGIBILITY_BLOCKED',
            error_message = 'Score eligibility blocks tailoring: salary below range',
            retryable = 0, blocked_by_json = '["score"]'
        WHERE tenant_id = ? AND job_id = ? AND stage IN ('tailor', 'cover', 'apply')
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]


@pytest.mark.parametrize(
    ("score_state", "seed_staleness"),
    [
        ("stale", False),
        ("succeeded", True),
    ],
)
def test_tailor_job_by_id_rejects_stale_score_state_before_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    score_state: str,
    seed_staleness: bool,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/stale-score")
    tailor_module.ensure_job_stage_rows(
        conn,
        _JOB_ID,
        tenant_id=_TENANT_A,
        discovered_at="2026-07-31T12:00:00+00:00",
    )
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?
        WHERE tenant_id = ? AND job_id = ? AND stage = 'score'
        """,
        (score_state, str(_TENANT_A), str(_JOB_ID)),
    )
    if seed_staleness:
        conn.execute(
            """
            INSERT INTO job_score_staleness (
                tenant_id, job_id, stale_reason,
                old_policy_version, new_policy_version, marked_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(_TENANT_A),
                str(_JOB_ID),
                "policy_changed",
                1,
                2,
                "2026-07-31T12:00:01+00:00",
            ),
        )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("stale score reached generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["reason"] == "not_eligible"


@pytest.mark.parametrize(
    ("active_state", "confidence", "quarantine_reason"),
    [
        ("closed", "high", None),
        ("active", "low", "contradictory_snapshot"),
    ],
)
def test_tailor_job_by_id_rejects_inactive_or_quarantined_postings(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    active_state: str,
    confidence: str,
    quarantine_reason: str | None,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/quarantined")
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, ?, ?, ?, ?)
        """,
        (
            str(_TENANT_A),
            str(_JOB_ID),
            active_state,
            confidence,
            quarantine_reason,
            "2026-07-31T12:00:01+00:00",
        ),
    )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail(
            "inactive or quarantined posting reached generation"
        ),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    if confidence == "low":
        assert result["reason"] == "enrichment_quarantined"
        state = conn.execute(
            "SELECT state, error_code, retryable, blocked_by_json "
            "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(_TENANT_A), str(_JOB_ID)),
        ).fetchone()
        assert state is not None
        assert dict(state) == {
            "state": "blocked",
            "error_code": "ENRICHMENT_QUARANTINED",
            "retryable": 1,
            "blocked_by_json": '["enrich"]',
        }
    else:
        assert result["reason"] == "not_eligible"


def test_tailor_job_by_id_allows_explicit_low_confidence_override_state(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/override")
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, latest_confidence,
            latest_quarantine_reason, updated_at
        ) VALUES (?, ?, '{}', 1, 'active', 'low', 'none', ?)
        """,
        (
            str(_TENANT_A),
            str(_JOB_ID),
            "2026-07-31T12:00:01+00:00",
        ),
    )
    conn.commit()
    calls: list[str] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]


@pytest.mark.parametrize("retry_state", ["running", "failed"])
def test_tailor_job_by_id_allows_temporal_retry_to_reenter_generation(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    retry_state: str,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/retry")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = ?, attempt_count = 1
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (retry_state, str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    calls: list[str] = []
    running_attempt_counts: list[int] = []

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        calls.append(str(job["job_id"]))
        running_attempt_counts.append(
            int(
                conn.execute(
                    "SELECT attempt_count FROM job_stage_states "
                    "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
                    (str(_TENANT_A), str(_JOB_ID)),
                ).fetchone()[0]
            )
        )
        return _fake_approved_result(job)

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "approved"
    assert calls == [str(_JOB_ID)]
    assert running_attempt_counts == [1]
    state = conn.execute(
        """
        SELECT state, attempt_count
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == ("succeeded", 2)


def test_tailor_job_by_id_keeps_inner_retry_exhaustion_outer_retryable(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/inner-retries")

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        return {
            "url": job["url"],
            "status": "exhausted_retries",
            "attempts": 4,
            "error": "No parseable candidate",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "exhausted_retries"
    state = conn.execute(
        """
        SELECT state, attempt_count, retryable, next_action
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "failed",
        1,
        1,
        "jobctrl retry tailor https://example.com/inner-retries",
    )
    event_payload = json.loads(
        conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor' "
            "AND event_type = 'StageFailed' ORDER BY event_id DESC LIMIT 1",
            (str(_TENANT_A), str(_JOB_ID)),
        ).fetchone()[0]
    )
    assert {
        key: event_payload[key]
        for key in (
            "attempts",
            "generationAttempts",
            "generationStatus",
            "retryable",
        )
    } == {
        "attempts": 1,
        "generationAttempts": 4,
        "generationStatus": "exhausted_retries",
        "retryable": True,
    }


def test_tailor_job_by_id_persists_profile_change_as_actionable_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/profile-changed")

    def stale_profile(*_args, **_kwargs) -> dict:
        raise RuntimeError("tailoring policy advanced before artifact persistence")

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", stale_profile)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "error"
    state = conn.execute(
        "SELECT state, error_code, error_message, retryable FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "failed",
        "TAILOR_INPUTS_CHANGED",
        "The profile or tailoring policy changed while Tailor was running.",
        1,
    )
    event_payload = json.loads(
        conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor' "
            "AND event_type = 'StageFailed' ORDER BY event_id DESC LIMIT 1",
            (str(_TENANT_A), str(_JOB_ID)),
        ).fetchone()[0]
    )
    assert event_payload["failureReason"] == "tailoring_inputs_changed"


def test_tailor_job_by_id_marks_fifth_durable_failure_exhausted(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/outer-retries")
    conn.execute(
        """
        UPDATE job_stage_states
        SET state = 'failed', attempt_count = 4
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()

    def fake_tailor(job: dict, *_args, **_kwargs) -> dict:
        return {
            "url": job["url"],
            "status": "failed_validation",
            "attempts": 4,
            "error": "Candidate did not pass validation",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result["status"] == "exhausted"
    assert result["inner_status"] == "failed_validation"
    assert result["reason"] == "durable_attempt_budget_exhausted"
    state = conn.execute(
        """
        SELECT state, attempt_count, retryable, next_action
        FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'
        """,
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "exhausted",
        5,
        0,
        "jobctrl retry tailor https://example.com/outer-retries --reset-attempts",
    )


def test_tailor_job_by_id_does_not_reenter_generation_after_exhaustion(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/already-exhausted")
    conn.execute(
        "UPDATE job_stage_states SET state = 'exhausted', attempt_count = 5, retryable = 0 "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    )
    conn.commit()
    prior_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("exhausted job re-entered generation"),
    )

    result = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert result == {
        "url": "https://example.com/already-exhausted",
        "job_id": str(_JOB_ID),
        "status": "exhausted",
        "reason": "durable_attempt_budget_exhausted",
        "error": "Tailor durable attempt budget exhausted.",
    }
    state = conn.execute(
        "SELECT state, attempt_count, retryable FROM job_stage_states "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == ("exhausted", 5, 0)
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0] == prior_events


def test_legacy_tailor_batch_counts_all_failures_and_exhausts_durable_budget(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/legacy-batch-exhaustion"
    job_id = _JOB_ID
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=job_id, url=url)
    job = {
        "tenant_id": str(LOCAL_TENANT),
        "job_id": str(job_id),
        "url": url,
        "title": "Platform Engineer",
        "site": None,
        "discovered_at": "2026-07-31T12:00:00+00:00",
    }

    def fake_tailor(candidate: dict, *_args, **_kwargs) -> dict:
        return {
            "url": candidate["url"],
            "title": candidate["title"],
            "site": candidate.get("site"),
            "status": "exhausted_retries",
            "attempts": 4,
            "error": "No parseable candidate",
        }

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "get_jobs_by_stage", lambda **_kwargs: [job])
    monkeypatch.setattr(
        tailor_module.db_module,
        "effective_tailoring_min_score",
        lambda score: score,
    )
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", fake_tailor)

    first = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )
    assert first["failed"] == 1
    assert first["errors"] == 0
    assert first["exhausted"] == 0
    assert tuple(
        conn.execute(
            "SELECT state, attempt_count, retryable FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
    ) == ("failed", 1, 1)

    conn.execute(
        "UPDATE job_stage_states SET state = 'failed', attempt_count = 4, retryable = 1 "
        "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()
    fifth = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )
    assert fifth["failed"] == 1
    assert fifth["errors"] == 0
    assert fifth["exhausted"] == 1
    assert tuple(
        conn.execute(
            "SELECT state, attempt_count, retryable FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
            (str(LOCAL_TENANT), str(job_id)),
        ).fetchone()
    ) == ("exhausted", 5, 0)


def test_legacy_tailor_batch_blocks_stale_fit_without_consuming_retry(
    conn: sqlite3.Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://example.com/legacy-batch-stale-fit"
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=_JOB_ID, url=url)
    job = {
        "tenant_id": str(LOCAL_TENANT),
        "job_id": str(_JOB_ID),
        "url": url,
        "title": "Platform Engineer",
        "site": None,
        "discovered_at": "2026-07-31T12:00:00+00:00",
    }

    def stale_fit(*_args, **_kwargs) -> dict:
        raise TailoringPrerequisiteError(
            reason="requirement_fit_generation_mismatch",
            job_id=str(_JOB_ID),
            analysis_generation=2,
            report_generation=1,
        )

    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor_module, "get_jobs_by_stage", lambda **_kwargs: [job])
    monkeypatch.setattr(
        tailor_module.db_module,
        "effective_tailoring_min_score",
        lambda score: score,
    )
    monkeypatch.setattr(tailor_module, "TAILORED_DIR", tmp_path / "tailored")
    monkeypatch.setattr(tailor_module, "_build_pdf_renderer", lambda: object())
    monkeypatch.setattr(tailor_module, "_tailor_one_job", stale_fit)

    result = tailor_module.run_tailoring(
        snapshot=SimpleNamespace(),
        tenant_id=LOCAL_TENANT,
        llm_model=None,
    )

    assert result["blocked"] == 1
    assert result["failed"] == 0
    assert result["errors"] == 0
    assert result["exhausted"] == 0
    state = conn.execute(
        "SELECT state, attempt_count, error_code, retryable, blocked_by_json "
        "FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'tailor'",
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert tuple(state) == (
        "blocked",
        0,
        "REQUIREMENT_FIT_STALE",
        1,
        '["score"]',
    )
    event = conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id = ? AND job_id = ? "
        "AND stage = 'tailor' ORDER BY event_id DESC LIMIT 1",
        (str(LOCAL_TENANT), str(_JOB_ID)),
    ).fetchone()
    assert event["event_type"] == "StageBlocked"


def test_tailor_job_by_id_rejects_deleted_and_url_shaped_targets_before_generation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_job(conn, tenant_id=_TENANT_A, url="https://example.com/deleted")
    conn.execute(
        """
        INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at)
        VALUES (?, ?, ?, ?, NULL)
        """,
        (str(_TENANT_A), str(_JOB_ID), "2026-07-31T12:00:01+00:00", "test"),
    )
    conn.commit()
    monkeypatch.setattr(tailor_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        tailor_module,
        "_tailor_one_job",
        lambda *_args, **_kwargs: pytest.fail("rejected job reached generation"),
    )

    deleted = tailor_module.tailor_job_by_id(
        _JOB_ID,
        tenant_id=_TENANT_A,
        snapshot=SimpleNamespace(),
        llm_model=None,
    )

    assert deleted == {
        "job_id": str(_JOB_ID),
        "status": "skipped",
        "reason": "not_found",
    }
    assert conn.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    monkeypatch.setattr(
        tailor_module,
        "get_connection",
        lambda: pytest.fail("URL-shaped JobId must fail before opening storage"),
    )
    with pytest.raises(ValueError, match="JobId must be a canonical UUID"):
        tailor_module.tailor_job_by_id(
            JobId("https://example.com/legacy"),
            tenant_id=_TENANT_A,
        )


def test_tailor_job_activity_wires_canonical_job_id_to_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_tailor_job_by_id(job_id: JobId, **kwargs: object) -> dict[str, object]:
        captured["job_id"] = job_id
        captured.update(kwargs)
        return {"status": "approved"}

    monkeypatch.setattr(tailor_module, "tailor_job_by_id", fake_tailor_job_by_id)
    payload = TailorJobActivityInput(
        tenant_id=str(_TENANT_A),
        job_id=_JOB_ID,
        min_score=8,
        retailor=True,
    )

    assert activities_module._tailor_one_job(payload) == {"status": "approved"}
    assert captured["job_id"] == _JOB_ID
    assert captured["tenant_id"] == _TENANT_A
    assert captured["min_score"] == 8
    assert captured["retailor"] is True


def test_tailor_one_job_passes_canonical_id_to_materials_use_case() -> None:
    captured: dict[str, object] = {}

    class FakeUseCase:
        def execute(self, **kwargs: object) -> SimpleNamespace:
            captured.update(kwargs)
            return SimpleNamespace(
                text_path="/tmp/tailored.txt",
                pdf_path="/tmp/tailored.pdf",
                status="approved",
                attempts=1,
                materials=SimpleNamespace(generation=1),
                error=None,
            )

    result = tailor_module._tailor_one_job(
        {
            "job_id": str(_JOB_ID),
            "url": "https://example.com/materials",
            "title": "Platform Engineer",
        },
        "",
        SimpleNamespace(),
        "normal",
        use_case=FakeUseCase(),
        audit_execution_id="temporal-run-owned",
    )

    assert result["status"] == "approved"
    assert captured["job_id"] == _JOB_ID
    assert captured["audit_execution_id"] == "temporal-run-owned"
