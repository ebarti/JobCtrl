"""Learning recommendation JSON-RPC trigger contracts."""

from __future__ import annotations

from pathlib import Path

from jobctrl.database import close_connection, init_db
from jobctrl.domain.materials.policy import TailoringPolicy
from jobctrl.domain.rpc.messages import INVALID_PARAMS, JsonRpcRequest
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials import SqliteTailoringPolicyRepository
from jobctrl.infrastructure.rpc import handlers as handlers_mod
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer


async def _stub_starter(_spec):  # pragma: no cover - sync handler only
    raise AssertionError("workflow starter must not be called")


async def _stub_canceler(_run_id: str) -> None:  # pragma: no cover - not called
    return None


def test_review_trigger_derives_once_and_replays_idempotently(
    tmp_path: Path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_recommendation_sources(conn)
    monkeypatch.setattr(handlers_mod, "get_connection", lambda: conn)
    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=_stub_canceler)

    first = server.dispatch(
        JsonRpcRequest(
            method="rederive_learning_recommendations",
            params={"tenantId": "local"},
            id=1,
        )
    )
    replay = server.dispatch(
        JsonRpcRequest(
            method="rederive_learning_recommendations",
            params={"tenantId": "local"},
            id=2,
        )
    )

    assert first is not None
    assert replay is not None
    first_result = first.to_dict()["result"]
    replay_result = replay.to_dict()["result"]
    assert first_result["status"] == "succeeded"
    assert first_result["recommendationCount"] == 1
    assert replay_result["recommendationIds"] == first_result["recommendationIds"]
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_evidence"
    ).fetchone()[0] == 3
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_jobs"
    ).fetchone()[0] == 2
    learning_dump = "\n".join(
        repr(tuple(row))
        for table in (
            "learning_recommendations",
            "learning_recommendation_evidence",
            "learning_recommendation_evidence_jobs",
            "learning_recommendation_jobs",
        )
        for row in conn.execute(f"SELECT * FROM {table}").fetchall()
    )
    assert "private source text" not in learning_dump
    assert "private-delta" not in learning_dump
    close_connection(db_path)


def test_explicit_review_accepts_atomically_and_replays(
    tmp_path: Path,
    monkeypatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_recommendation_sources(conn)
    monkeypatch.setattr(handlers_mod, "get_connection", lambda: conn)
    server = JsonRpcServer(workflow_starter=_stub_starter)
    register_default_handlers(server, canceler=_stub_canceler)
    derived = server.dispatch(
        JsonRpcRequest(
            method="rederive_learning_recommendations",
            params={"tenantId": "local"},
            id=1,
        )
    )
    assert derived is not None
    recommendation_id = derived.to_dict()["result"]["recommendationIds"][0]
    policy_repository = SqliteTailoringPolicyRepository(conn)
    policy_repository.save(_tailoring_policy())
    runtime_expectations: list[dict[str, str | None]] = []
    monkeypatch.setattr(
        handlers_mod,
        "assert_expected_runtime",
        lambda **kwargs: runtime_expectations.append(kwargs),
    )
    params = {
        "tenantId": "local",
        "recommendationId": recommendation_id,
        "decision": "accepted",
        "expectedAppDir": "/tmp/jobctrl",
        "expectedDbPath": "/tmp/jobctrl/jobctrl.db",
    }

    first = server.dispatch(
        JsonRpcRequest(
            method="review_learning_recommendation",
            params=params,
            id=2,
        )
    )
    replay = server.dispatch(
        JsonRpcRequest(
            method="review_learning_recommendation",
            params=params,
            id=3,
        )
    )

    assert first is not None
    assert replay is not None
    first_result = first.to_dict()["result"]
    replay_result = replay.to_dict()["result"]
    assert first_result["decision"] == "accepted"
    assert first_result["policyVersion"] == 2
    assert replay_result["reviewId"] == first_result["reviewId"]
    assert replay_result["policyVersion"] == first_result["policyVersion"]
    assert runtime_expectations == [
        {
            "expected_app_dir": "/tmp/jobctrl",
            "expected_db_path": "/tmp/jobctrl/jobctrl.db",
        },
        {
            "expected_app_dir": "/tmp/jobctrl",
            "expected_db_path": "/tmp/jobctrl/jobctrl.db",
        },
    ]
    current = policy_repository.get_current(LOCAL_TENANT)
    assert current is not None
    assert current.learned_tailoring_rules.to_dict() == {
        "fact_handling": "require_source_match"
    }
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_reviews"
    ).fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0] == 2

    rejected = server.dispatch(
        JsonRpcRequest(
            method="review_learning_recommendation",
            params={**params, "decision": "rejected"},
            id=4,
        )
    )
    assert rejected is not None
    assert rejected.to_dict()["error"]["code"] == INVALID_PARAMS
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_reviews"
    ).fetchone()[0] == 1
    close_connection(db_path)


def _seed_recommendation_sources(conn) -> None:
    job_ids = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    )
    for index, job_id in enumerate(job_ids, start=1):
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url) VALUES ('local', ?, ?)",
            (job_id, f"https://jobs.example/{index}"),
        )
    for index, job_id in enumerate((job_ids[0], job_ids[0], job_ids[1]), start=1):
        signal_id = f"signal-{index}"
        conn.execute(
            """
            INSERT INTO resume_review_drafts (
                tenant_id, draft_id, job_id, base_generation, renderer_format,
                state, latest_revision_number, created_at, updated_at
            ) VALUES ('local', ?, ?, 1, 'text', 'active', 0, ?, ?)
            """,
            (
                f"draft-{index}",
                job_id,
                "2026-08-01T10:00:00Z",
                "2026-08-01T10:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signals (
                tenant_id, signal_id, job_id, draft_id, source_kind,
                source_id, signal_kind, status, summary, created_at,
                reviewed_at
            ) VALUES (
                'local', ?, ?, ?, 'edit_delta', ?, 'factual_correction',
                'accepted', 'private source text', ?, ?
            )
            """,
            (
                signal_id,
                job_id,
                f"draft-{index}",
                f"private-delta-{index}",
                "2026-08-01T10:00:00Z",
                f"2026-08-01T10:00:0{index}Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signal_reviews (
                tenant_id, review_id, signal_id, revision, decision,
                signal_kind, rule_key, rule_value, allowlist_version,
                reviewed_at
            ) VALUES (
                'local', ?, ?, 1, 'accepted', 'factual_correction',
                'fact_handling', 'require_source_match', 1, ?
            )
            """,
            (f"review-{index}", signal_id, f"2026-08-01T10:00:0{index}Z"),
        )
    conn.commit()


def _tailoring_policy() -> TailoringPolicy:
    return TailoringPolicy(
        tenant_id=LOCAL_TENANT,
        version=1,
        prompt_version="tailor.v2.quality-gated",
        schema_version="tailored-resume.v1",
        judge_schema_version="tailor-judge.v1",
        prompt_fingerprint="sha256:prompt",
        config_fingerprint="sha256:config",
        profile_policy_fingerprint="sha256:profile",
        custom_prompt_fingerprint="sha256:custom",
        generator_settings={"candidate_models": ["local:draft"]},
        judge_settings={"judge_model": "local:judge", "min_score": 0.82},
        runtime_settings={"validation_mode": "normal"},
        created_at="2026-08-01T10:00:00Z",
    )
