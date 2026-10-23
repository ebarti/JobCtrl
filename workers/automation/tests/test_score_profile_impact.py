"""Profile refresh follows cited model authority, preserving accepted scores."""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl import config
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.profile.search_targets import snapshot_target_sources
from jobctrl.domain.scoring import ScoringCriteria
from jobctrl.domain.scoring.profile_impact import profile_inputs, review_profile_impact
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.infrastructure.scoring import SqliteScoreRepository
from jobctrl.llm_lanes import current_llm_lane
from jobctrl.scoring import scorer
from jobctrl.state import ensure_job_stage_rows
from .determination_fakes import job_interpretation
from .test_scorer import (_AnalyzeUseCase, _ScriptedLlm, _job_id, _seed_pending_job,
                          conn as conn, profile_snapshot as profile_snapshot)

URL = "https://example.test/profile-impact"
GOOD = dict(score=8, technical_fit=8, experience_fit=8, role_fit=8,
            keywords=["Python"], reasoning="Explicit synthetic model assessment.")


class Model(_ScriptedLlm):
    provider_id = "synthetic"
    model = "synthetic-model"
    reasoning_effort = "max"

    def __init__(self):
        super().__init__(*([GOOD] * 20))
        self.verdict = "insignificant"
        self.fault = None
        self.review_calls = []
        self.after_call = None
        self.after_review = None
        self.score_failure = False
        self.order = []

    def chat_json(self, messages, **kwargs):
        self.order.append(("model", current_llm_lane()))
        if kwargs["response_schema"]["title"] != "ProfileImpactDecision":
            if self.score_failure:
                raise RuntimeError("Synthetic scoring provider failure")
            result = super().chat_json(messages, **kwargs)
            if self.after_call:
                callback, self.after_call = self.after_call, None
                callback()
            return result
        data = json.loads(messages[1].content)
        self.review_calls.append(data)
        source = next(row for row in data["sources"] if row["source_id"].startswith("after:"))
        result = {**data["context"]["binding"], "verdict": self.verdict,
                  "rationale": "Explicit synthetic significance verdict.",
                  "citations": [{"source_id": source["source_id"], "quote": source["text"], "exact_values": []}]}
        if isinstance(self.fault, Exception):
            raise self.fault
        if self.fault == "malformed_json":
            raise json.JSONDecodeError("synthetic", "", 0)
        if self.fault == "extra":
            result["extra"] = "forbidden"
        if self.fault == "enum":
            result["verdict"] = "maybe"
        if self.fault == "foreign":
            result["citations"][0]["source_id"] = "foreign"
        if self.fault == "quote":
            result["citations"][0]["quote"] = "Not supplied"
        if self.fault == "value":
            result["citations"][0]["exact_values"] = ["999"]
        if self.fault == "binding":
            result["score_version"] += 1
        if self.fault == "no_profile":
            result["citations"] = [{"source_id": "posting", "quote": data["sources"][0]["text"]}]
        if self.after_review:
            callback, self.after_review = self.after_review, None
            callback()
        return result


@pytest.fixture
def env(conn, monkeypatch, profile_snapshot):
    _seed_pending_job(conn, URL)
    ensure_job_stage_rows(conn, _job_id(URL), tenant_id=LOCAL_TENANT)
    conn.commit()
    path = Path(conn.execute("PRAGMA database_list").fetchone()[2])
    model = Model()
    profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setattr(scorer, "get_connection", lambda: conn)
    monkeypatch.setattr(scorer, "get_profile_repository", lambda: profiles)
    analyzer = _AnalyzeUseCase()
    repository = SqliteDeterminationRepository(conn)
    dependencies = dict(llm=model, repository=repository, tenant_id="local", provider="synthetic",
                        model=model.model, lane="scoring", preflight=lambda: model.order.append(("preflight", current_llm_lane())))
    monkeypatch.setattr(scorer, "build_analyze_use_case", lambda **kwargs: analyzer)
    original_build = scorer._build_use_case

    def build(**kwargs):
        kwargs["determination_dependencies"] = dependencies
        kwargs["job_interpretation_reader"] = lambda job: job_interpretation(
            analyzer.execute(job=job).analysis.canonical.requirements)
        return original_build(**kwargs)
    monkeypatch.setattr(scorer, "_build_use_case", build)
    value = SimpleNamespace(conn=conn, path=path, model=model, profiles=profiles,
                            analyzer=analyzer, repository=repository, dependencies=dependencies)
    yield value


def score(env, *, rescore=False, snapshot=None):
    return scorer.score_job_by_id(_job_id(URL), tenant_id=LOCAL_TENANT,
        rescore=rescore, profile_snapshot=snapshot, resume_text="Synthetic Python engineer.",
        criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer)


def update(env, name="Edited synthetic name"):
    data = env.profiles.load(LOCAL_TENANT).to_dict()
    data["personal"]["full_name"] = name
    return env.profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, data))


def rows(env):
    return [tuple(row) for row in env.conn.execute("SELECT * FROM job_scores ORDER BY version")]


@pytest.mark.parametrize("verdict, expected_versions", [("insignificant", 1), ("significant", 2)])
def test_opposing_model_verdicts_control_refresh_for_identical_inputs(env, verdict, expected_versions):
    first = score(env)
    assert first.ok, first.error
    baseline = rows(env)
    original = first.score.trace.profile_inputs
    assert original["profile_version"] == first.score.trace.profile_snapshot_version == 1
    update(env)
    env.model.verdict = verdict
    result = score(env, rescore=True)
    assert result.ok, result.error
    assert result.score.version == expected_versions
    assert len(env.model.review_calls) == 1
    assert result.retained == (verdict == "insignificant")
    assert env.model.calls == expected_versions
    binding = env.repository.bound(tenant_id="local", entity_kind="score_profile_review",
        entity_id=str(_job_id(URL)), entity_version="1:default:2", determination_kind="score_profile_impact")
    assert binding.result["verdict"] == verdict
    assert binding.reasoning_effort == "max"
    if verdict == "insignificant":
        assert rows(env) == baseline
        assert result.score.scored_at == first.score.scored_at
        assert result.score.trace.profile_snapshot_version == 1
        assert env.conn.execute("SELECT attempt_count FROM job_stage_states WHERE stage='score'").fetchone()[0] == 1


def test_unchanged_review_inputs_reuse_receipt_without_new_model_calls(env):
    assert score(env).ok
    update(env)
    assert score(env, rescore=True).retained
    calls = (env.model.calls, len(env.model.review_calls))
    assert score(env, rescore=True).retained
    assert (env.model.calls, len(env.model.review_calls)) == calls
    update(env, "Another synthetic revision")
    assert score(env, rescore=True).retained
    assert len(env.model.review_calls) == 2
    assert env.model.review_calls[-1]["context"]["binding"]["scored_profile_version"] == 1
    assert env.model.review_calls[-1]["context"]["binding"]["reviewed_profile_version"] == 3


@pytest.mark.parametrize("fault, code", [
    ("extra", "schema_violation"), ("enum", "schema_violation"),
    ("foreign", "foreign_source_id"), ("quote", "non_verbatim_quote"),
    ("value", "mismatched_value"), ("binding", "field_binding_invalid"),
    ("no_profile", "missing_evidence_citation"), ("malformed_json", "malformed_json"),
    (RuntimeError("synthetic provider failure"), "provider_error"),
])
def test_failed_significance_checks_preserve_accepted_score(env, fault, code):
    assert score(env).ok
    baseline = rows(env)
    update(env)
    env.model.fault = fault
    result = score(env, rescore=True)
    assert not result.ok and result.error == f"semantic_determination:{code}"
    assert rows(env) == baseline
    assert env.model.calls == 1
    assert env.repository.bound(tenant_id="local", entity_kind="score_profile_review",
        entity_id=str(_job_id(URL)), entity_version="1:default:2", determination_kind="score_profile_impact") is None


@pytest.mark.parametrize("failure", ["provider_unavailable", "budget_denied"])
def test_preflight_failures_never_imply_insignificant(env, failure):
    assert score(env).ok
    previous = SqliteScoreRepository(env.conn).load(LOCAL_TENANT, _job_id(URL))
    snapshot = update(env)
    job = SqlitePreparationTargetReader(env.conn).load(LOCAL_TENANT, _job_id(URL))
    current = profile_inputs(snapshot, ScoringCriteria(), snapshot_target_sources(snapshot, ScoringCriteria()), job)
    dependencies = dict(env.dependencies)
    if failure == "provider_unavailable":
        dependencies["llm"] = None
    else:
        dependencies["preflight"] = lambda: (_ for _ in ()).throw(RuntimeError("budget"))
    with pytest.raises(DeterminationFailure, match=failure):
        review_profile_impact(score=previous, current=current, job=job, dependencies=dependencies)
    assert not env.model.review_calls
    assert env.model.calls == 1


def test_missing_historical_baseline_remains_unknown_without_replacement(env):
    assert score(env).ok
    env.conn.execute("UPDATE job_scores SET trace_json=json_remove(trace_json, '$.profile_inputs')")
    env.conn.commit()
    baseline = rows(env)
    update(env)
    result = score(env, rescore=True)
    assert not result.ok and result.error == "semantic_determination:score_profile_baseline_unavailable"
    assert rows(env) == baseline and not env.model.review_calls


def test_automatic_existing_score_reuse_does_not_run_impact_check(env):
    assert score(env).ok
    update(env)
    assert score(env).ok
    assert not env.model.review_calls and env.model.calls == 1


def test_profile_edit_during_first_score_preserves_frozen_sources(env):
    original = env.profiles.load_snapshot(LOCAL_TENANT)
    env.model.after_call = lambda: update(env)
    result = score(env, snapshot=original)
    assert result.ok, result.error
    assert result.score.trace.profile_snapshot_version == 1
    assert result.score.trace.profile_inputs["profile_version"] == 1
    assert env.profiles.load_snapshot(LOCAL_TENANT).version == 2
    assert len(rows(env)) == 1 and not env.model.review_calls


def test_original_profile_targets_are_independent_of_later_saves(env):
    data = env.profiles.load(LOCAL_TENANT).to_dict()
    data["experience"]["target_role"] = "Original literal target"
    before = env.profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, data))
    data["experience"]["target_role"] = "New literal target"
    env.profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, data))
    result = score(env, snapshot=before)
    assert result.ok, result.error
    targets = {source["text"] for source in result.score.trace.profile_inputs["sources"] if source["source_id"].startswith("target:roles:")}
    assert targets == {"Original literal target"}


def test_old_review_cannot_retain_a_newer_score_version(env):
    first = score(env).score
    after = update(env)
    use_case = scorer._build_use_case(tenant_id=LOCAL_TENANT, llm_port=env.model)
    job = SqlitePreparationTargetReader(env.conn).load(LOCAL_TENANT, _job_id(URL))
    parsed = use_case.compute(job=job, profile_snapshot=after, criteria=ScoringCriteria(), previous_score=first)
    assert parsed.retained_score_version == 1
    SqliteScoreRepository(env.conn).save(replace(first, version=2))
    with pytest.raises(DeterminationFailure, match="score_profile_binding_invalid"):
        use_case.persist_outcome(job=job, parse=parsed)
    assert len(rows(env)) == 2


def test_significant_check_and_failed_replacement_keep_old_score_and_review(env):
    assert score(env).ok
    before = rows(env)
    update(env)
    env.model.verdict = "significant"
    env.model.score_failure = True
    result = score(env, rescore=True)
    assert not result.ok and rows(env) == before
    assert env.repository.bound(tenant_id="local", entity_kind="score_profile_review", entity_id=str(_job_id(URL)),
        entity_version="1:default:2", determination_kind="score_profile_impact").result["verdict"] == "significant"


def test_concurrent_identical_impact_checks_make_one_model_call(env):
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.database import close_thread_connections
    from jobctrl.infrastructure.determinations import ThreadLocalDeterminationRepository

    previous = score(env).score
    current_snapshot = update(env)
    job = SqlitePreparationTargetReader(env.conn).load(LOCAL_TENANT, _job_id(URL))
    current = profile_inputs(current_snapshot, ScoringCriteria(), snapshot_target_sources(current_snapshot, ScoringCriteria()), job)
    dependencies = {**env.dependencies, "repository": ThreadLocalDeterminationRepository(env.path)}
    def check(_):
        try:
            return review_profile_impact(score=previous, current=current, job=job, dependencies=dependencies)[1].determination_id
        finally:
            close_thread_connections()
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(check, range(4)))
    assert len(set(ids)) == 1 and len(env.model.review_calls) == 1
    assert env.model.order[-2:] == [("preflight", "scoring"), ("model", "scoring")]


@pytest.mark.parametrize("state", ["canceled", "successor"])
def test_late_profile_review_cannot_publish_after_ownership_loss(env, state):
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost

    assert score(env).ok
    baseline = rows(env)
    update(env)
    def revoke():
        env.conn.execute("UPDATE job_stage_states SET state=?,metadata_json=? WHERE job_id=? AND stage='score'",
            ("running" if state == "successor" else state, json.dumps({"activityOwner": "successor"}), str(_job_id(URL))))
        env.conn.commit()
    env.model.after_review = revoke
    with pytest.raises(PreparationReservationLost):
        scorer.score_job_by_id(_job_id(URL), rescore=True, workflow_id="profile-review-owner",
            criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer)
    assert rows(env) == baseline
    assert env.repository.bound(tenant_id="local", entity_kind="score_profile_review", entity_id=str(_job_id(URL)),
        entity_version="1:default:2", determination_kind="score_profile_impact") is None
    assert env.conn.execute("SELECT state FROM job_stage_states WHERE stage='score'").fetchone()[0] == ("running" if state == "successor" else state)


def test_profile_save_during_posting_analysis_does_not_reread_new_targets(env):
    before = env.profiles.load_snapshot(LOCAL_TENANT)
    original = env.analyzer.execute
    changed = False
    def analyze(**kwargs):
        nonlocal changed
        result = original(**kwargs)
        if not changed:
            changed = True
            update(env)
        return result
    env.analyzer.execute = analyze
    result = score(env, snapshot=before)
    assert result.ok, result.error
    assert result.score.trace.profile_snapshot_version == before.version
    assert env.profiles.load_snapshot(LOCAL_TENANT).version == before.version + 1


def test_bulk_explicit_selector_includes_changed_profile_on_current_policy(env):
    from jobctrl.pipeline.current_policy_selectors import scoring_current_policy_job_ids
    assert score(env).ok
    update(env)
    assert scoring_current_policy_job_ids(env.conn, tenant_id="local", job_ids=(_job_id(URL),)) == (_job_id(URL),)


@pytest.mark.asyncio
@pytest.mark.parametrize("verdict", ["insignificant", "significant", "provider_failure"])
async def test_real_temporal_explicit_profile_refresh_and_replay(env, monkeypatch, verdict):
    import asyncio
    import uuid
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
    from jobctrl import database
    from jobctrl.infrastructure.determinations import ThreadLocalDeterminationRepository
    from jobctrl.infrastructure.temporal.finalize import record_workflow_started, record_workflow_outcome
    from jobctrl.infrastructure.preparation_recovery import recover_preparation_state_activity
    from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
    from jobctrl.scoring.activities import score_activity
    from .temporal_env import time_skipping_env
    from .test_workflow_job_preparation import _check_spend_budget

    assert score(env).ok
    before = rows(env)
    update(env)
    env.model.verdict = "significant" if verdict == "significant" else "insignificant"
    if verdict == "provider_failure":
        env.model.fault = RuntimeError("Synthetic provider failure")
    monkeypatch.setattr(database, "DB_PATH", env.path)
    monkeypatch.setattr(scorer, "get_connection", lambda: database.get_connection(env.path))
    monkeypatch.setattr(scorer, "get_profile_repository", lambda: SqliteProfileRepository(database.get_connection(env.path), publisher=InProcessEventBus()))
    env.dependencies["repository"] = ThreadLocalDeterminationRepository(env.path)
    wid, queue = "profile-refresh-" + uuid.uuid4().hex, "profile-refresh-" + uuid.uuid4().hex
    async with time_skipping_env() as temporal:
        async with Worker(temporal.client, task_queue=queue, workflows=[JobPipelineWorkflow],
                activities=[score_activity, _check_spend_budget, record_workflow_started,
                            record_workflow_outcome, recover_preparation_state_activity],
                workflow_runner=UnsandboxedWorkflowRunner()):
            handle = await temporal.client.start_workflow(JobPipelineWorkflow.run,
                JobPipelineWorkflowInput(tenant_id="local", stages=["score"], rescore=True,
                    job_ids=(_job_id(URL),), workers=1), id=wid, task_queue=queue)
            result = await asyncio.wait_for(handle.result(), timeout=25)
            history = await handle.fetch_history()
        calls = len(env.model.review_calls), env.model.calls
        await Replayer(workflows=[JobPipelineWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)
        assert (len(env.model.review_calls), env.model.calls) == calls
    if verdict == "provider_failure":
        assert result.stages_failed == ["score"] and rows(env) == before
    else:
        assert result.stages_completed == ["score"] and not result.stages_failed
        assert len(rows(env)) == (2 if verdict == "significant" else 1)
        assert len(env.model.review_calls) == 1
        assert not any(e.HasField("activity_task_failed_event_attributes") for e in history.events)
        if verdict == "insignificant":
            assert rows(env) == before


def test_review_binding_uses_the_score_writer_when_model_repo_has_another_connection(env):
    import sqlite3
    assert score(env).ok
    before = rows(env)
    update(env)
    other = sqlite3.connect(env.path)
    other.row_factory = sqlite3.Row
    assert other is not env.conn
    other.execute("PRAGMA busy_timeout=100")
    env.dependencies["repository"] = SqliteDeterminationRepository(other)
    try:
        result = score(env, rescore=True)
        assert result.ok and result.retained
        assert rows(env) == before
        assert env.repository.bound(tenant_id="local", entity_kind="score_profile_review", entity_id=str(_job_id(URL)),
            entity_version="1:default:2", determination_kind="score_profile_impact") is not None
    finally:
        other.close()


@pytest.mark.parametrize("field", ["prompt_version", "schema_version", "model"])
def test_independent_scoring_contract_changes_still_require_new_assessment(env, field):
    assert score(env).ok
    env.conn.execute("UPDATE job_scores SET trace_json=json_set(trace_json, ?, 'older-contract')", ("$." + field,))
    env.conn.commit()
    update(env)
    result = score(env, rescore=True)
    assert result.ok and result.score.version == 2 and not result.retained
    assert len(env.model.review_calls) == 1 and env.model.calls == 2
