"""Saved scoring sources are checked before admission and provider work."""

from __future__ import annotations

import asyncio
import sqlite3
import uuid

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from jobctrl import config, database
from jobctrl.domain.errors import InvalidSavedSearchError, SavedSearchReadError
from jobctrl.domain.scoring import ScoringCriteria
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost
from jobctrl.infrastructure.scoring import SqliteScoreRepository, SqliteScoreStalenessRepository
from jobctrl.scoring import scorer
from jobctrl.scoring.activities import ScoreJobActivityInput, score_job_activity
from tests.test_score_atomic_publication import _mark_policy_change, _published_state
from tests.test_score_profile_impact import URL, _job_id, score
from tests.test_score_profile_impact import conn as conn
from tests.test_score_profile_impact import env as env
from tests.test_score_profile_impact import profile_snapshot as profile_snapshot


def _save(env, raw):
    env.conn.execute(
        "INSERT INTO discovery_settings VALUES ('local', ?, 'created', 'updated') "
        "ON CONFLICT(tenant_id) DO UPDATE SET search_config_json=excluded.search_config_json",
        (raw,),
    )
    env.conn.commit()


def _saved(env):
    return tuple(env.conn.execute("SELECT * FROM discovery_settings WHERE tenant_id='local'").fetchone())


def _stage(env):
    return tuple(env.conn.execute(
        "SELECT * FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'",
        (str(_job_id(URL)),),
    ).fetchone())


def _stale_accepted(env):
    assert score(env).ok
    _mark_policy_change(env.conn, _job_id(URL))
    assert len(SqliteScoreStalenessRepository(env.conn).reset_for_rescore(LOCAL_TENANT)) == 1
    return _published_state(env.path, str(_job_id(URL)))


def _exclusion_sources(outcome):
    return [source["text"] for source in outcome.score.trace.profile_inputs["sources"]
            if source["source_id"].startswith("target:exact_title_exclusions:")]


def test_scoring_uses_valid_exclusions_when_an_unrelated_discovery_control_is_invalid(env):
    raw = '{ "exact_title_exclusions": ["Synthetic excluded title"], "defaults": {"results_per_site": null} }'
    _save(env, raw)
    before = _saved(env)
    with pytest.raises(InvalidSavedSearchError):
        config.load_discovery_control_settings()
    outcome = score(env)
    assert outcome.ok
    assert _exclusion_sources(outcome) == ["Synthetic excluded title"]
    assert _saved(env) == before


def test_first_use_without_saved_controls_keeps_empty_exclusions(env):
    outcome = score(env)
    assert outcome.ok and _exclusion_sources(outcome) == []
    assert env.conn.execute("SELECT count(*) FROM discovery_settings").fetchone()[0] == 0


@pytest.mark.parametrize("fault", ["invalid", "unreadable"])
@pytest.mark.parametrize("stale", [False, True])
def test_cached_score_reuse_needs_no_saved_settings_or_provider(env, monkeypatch, fault, stale):
    if stale:
        accepted = _stale_accepted(env)
    else:
        assert score(env).ok
        accepted = _published_state(env.path, str(_job_id(URL)))
    raw = ('{ "exact_title_exclusions": "synthetic private value" }' if fault == "invalid"
           else '{ "exact_title_exclusions": ["Synthetic title"] }')
    _save(env, raw)
    saved, stage = _saved(env), _stage(env)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    reads = []
    read = config._read_discovery_search_config

    def watched_read(*args, **kwargs):
        reads.append(True)
        if fault == "unreadable":
            raise sqlite3.OperationalError("synthetic private value")
        return read(*args, **kwargs)

    monkeypatch.setattr(config, "_read_discovery_search_config", watched_read)
    monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active",
                        lambda *args, **kwargs: pytest.fail("cached scoring must use fresh saved evidence"))
    outcome = score(env)
    assert outcome.ok and outcome.score.version == 1
    assert reads == []
    assert _saved(env) == saved and _stage(env) == stage
    assert _published_state(env.path, str(_job_id(URL))) == accepted
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


def test_completed_same_owner_replay_does_not_read_invalid_settings(env, monkeypatch):
    options = dict(
        workflow_id="synthetic-same-owner", profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT),
        resume_text="Synthetic engineer.", criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
    )
    assert scorer.score_job_by_id(_job_id(URL), **options).ok
    accepted, stage = _published_state(env.path, str(_job_id(URL))), _stage(env)
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    monkeypatch.setattr(config, "_read_discovery_search_config",
                        lambda *args, **kwargs: pytest.fail("same-owner replay must not read settings"))
    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available",
                        lambda *args, **kwargs: pytest.fail("same-owner replay must not check availability"))
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    outcome = scorer.score_job_by_id(_job_id(URL), **options)
    assert outcome.ok and outcome.score.version == 1
    assert _stage(env) == stage and _published_state(env.path, str(_job_id(URL))) == accepted
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


def test_owned_cached_score_reuse_keeps_its_reservation_fence_with_invalid_settings(env, monkeypatch):
    assert score(env).ok
    accepted = _published_state(env.path, str(_job_id(URL)))
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    env.conn.execute(
        "UPDATE job_stage_states SET state='queued', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
        ('{"automaticPreparation":{"workflowId":"synthetic-reservation"}}', str(_job_id(URL))),
    )
    env.conn.commit()
    monkeypatch.setattr(config, "_read_discovery_search_config",
                        lambda *args, **kwargs: pytest.fail("cached scoring must not read settings"))
    monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active",
                        lambda *args, **kwargs: pytest.fail("cached scoring must use fresh saved evidence"))
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    outcome = scorer.score_job_by_id(
        _job_id(URL), workflow_id="synthetic-owned-attempt", enforce_workflow_ownership=True,
        recovery_workflow_id="synthetic-reservation", profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT),
        resume_text="Synthetic engineer.", criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
    )
    assert outcome.ok and outcome.score.version == 1
    row = env.conn.execute("SELECT state, json_extract(metadata_json, '$.activityOwner') FROM job_stage_states "
                           "WHERE tenant_id='local' AND job_id=? AND stage='score'", (str(_job_id(URL)),)).fetchone()
    assert tuple(row) == ("succeeded", "synthetic-owned-attempt")
    observed = _published_state(env.path, str(_job_id(URL)))
    for key in ("scores", "reports", "items", "bindings", "staleness"):
        assert observed[key] == accepted[key]
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


@pytest.mark.parametrize("reserved", [False, True])
def test_deleted_cache_cannot_become_unvalidated_score_work(env, monkeypatch, reserved):
    assert score(env).ok
    accepted = _published_state(env.path, str(_job_id(URL)))
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    if reserved:
        env.conn.execute(
            "UPDATE job_stage_states SET state='queued', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
            ('{"automaticPreparation":{"workflowId":"synthetic-reservation"}}', str(_job_id(URL))),
        )
        env.conn.commit()
    stage = _stage(env)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    reads, availability_calls = [], []
    read = config._read_discovery_search_config

    def watched_read(*args, **kwargs):
        reads.append(True)
        return read(*args, **kwargs)

    def remove_cache(*args, **kwargs):
        availability_calls.append(True)
        with sqlite3.connect(env.path) as other:
            other.execute("DELETE FROM job_scores WHERE tenant_id='local' AND job_id=?", (str(_job_id(URL)),))

    monkeypatch.setattr(config, "_read_discovery_search_config", watched_read)
    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", remove_cache)
    options = dict(
        profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT), resume_text="Synthetic engineer.",
        criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
    )
    if reserved:
        options.update(workflow_id="synthetic-owned-attempt", enforce_workflow_ownership=True,
                       recovery_workflow_id="synthetic-reservation")
    outcome = scorer.score_job_by_id(_job_id(URL), **options)
    assert not outcome.ok and "retry" in outcome.error.lower()
    assert _stage(env) == stage and reads == [] and availability_calls == [True]
    observed = _published_state(env.path, str(_job_id(URL)))
    for key in ("reports", "items", "bindings", "staleness", "events"):
        assert observed[key] == accepted[key]
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls

    # The next attempt has no cached score and therefore must preflight
    # before it checks availability or starts any scoring work.
    with pytest.raises(InvalidSavedSearchError):
        scorer.score_job_by_id(_job_id(URL), **options)
    assert len(reads) == 1 and availability_calls == [True] and _stage(env) == stage
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


@pytest.mark.parametrize("successor", [False, True])
def test_cache_loss_after_owned_claim_cannot_overwrite_a_successor(env, monkeypatch, successor):
    assert score(env).ok
    accepted = _published_state(env.path, str(_job_id(URL)))
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    env.conn.execute(
        "UPDATE job_stage_states SET state='queued', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
        ('{"automaticPreparation":{"workflowId":"synthetic-reservation"}}', str(_job_id(URL))),
    )
    env.conn.commit()
    repository = SqliteScoreRepository(env.conn)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    monkeypatch.setattr(config, "_read_discovery_search_config",
                        lambda *args, **kwargs: pytest.fail("cache reuse must not read settings"))

    def lose_cache_after_claim(*args, **kwargs):
        with sqlite3.connect(env.path) as other:
            if successor:
                other.execute(
                    "UPDATE job_stage_states SET state='running', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
                    ('{"activityOwner":"synthetic-successor"}', str(_job_id(URL))),
                )
            else:
                other.execute("DELETE FROM job_scores WHERE tenant_id='local' AND job_id=?", (str(_job_id(URL)),))
        return None

    monkeypatch.setattr(repository, "load", lose_cache_after_claim)
    options = dict(
        repository=repository, workflow_id="synthetic-owned-attempt", enforce_workflow_ownership=True,
        recovery_workflow_id="synthetic-reservation", profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT),
        resume_text="Synthetic engineer.", criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
    )
    if successor:
        with pytest.raises(PreparationReservationLost):
            scorer.score_job_by_id(_job_id(URL), **options)
    else:
        outcome = scorer.score_job_by_id(_job_id(URL), **options)
        assert not outcome.ok and "retry" in outcome.error.lower()
    row = env.conn.execute("SELECT state, json_extract(metadata_json, '$.activityOwner') FROM job_stage_states "
                           "WHERE tenant_id='local' AND job_id=? AND stage='score'", (str(_job_id(URL)),)).fetchone()
    assert tuple(row) == (("running", "synthetic-successor") if successor else ("failed", "synthetic-owned-attempt"))
    observed = _published_state(env.path, str(_job_id(URL)))
    for key in ("reports", "items", "bindings", "staleness"):
        assert observed[key] == accepted[key]
    if successor:
        assert observed["scores"] == accepted["scores"]
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


@pytest.mark.parametrize("entry", ["direct", "selected"])
def test_cached_score_completion_reports_owner_loss_after_successor_handoff(env, monkeypatch, entry):
    accepted = _stale_accepted(env)
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    saved = _saved(env)
    env.conn.execute(
        "UPDATE job_stage_states SET state='queued', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
        ('{"automaticPreparation":{"workflowId":"synthetic-reservation"}}', str(_job_id(URL))),
    )
    env.conn.commit()
    repository = SqliteScoreRepository(env.conn)
    load = repository.load
    successor_states, successor_events = [], []
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    monkeypatch.setattr(config, "_read_discovery_search_config",
                        lambda *args, **kwargs: pytest.fail("cache reuse must not read settings"))

    def load_then_handoff(*args, **kwargs):
        result = load(*args, **kwargs)
        assert result is not None and result.version == 1
        with sqlite3.connect(env.path) as other:
            other.execute(
                "UPDATE job_stage_states SET state='running', metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
                ('{"activityOwner":"synthetic-successor"}', str(_job_id(URL))),
            )
        successor_states.append(_stage(env))
        successor_events.append(_published_state(env.path, str(_job_id(URL)))["events"])
        return result

    monkeypatch.setattr(repository, "load", load_then_handoff)
    options = dict(
        repository=repository, profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT),
        resume_text="Synthetic engineer.", criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
    )
    if entry == "direct":
        with pytest.raises(PreparationReservationLost):
            scorer.score_job_by_id(
                _job_id(URL), workflow_id="synthetic-owned-attempt", enforce_workflow_ownership=True,
                recovery_workflow_id="synthetic-reservation", **options,
            )
    else:
        from jobctrl.scoring.activities import ScoreActivityInput, _run_selected_scores

        original_score = scorer.score_job_by_id
        monkeypatch.setattr(scorer, "score_job_by_id", lambda job_id, **kwargs: original_score(job_id, **options, **kwargs))
        monkeypatch.setattr("jobctrl.pipeline.automatic_preparation.automatic_recovery_job_ids",
                            lambda payload, stage: payload.job_ids)
        outcome = _run_selected_scores(ScoreActivityInput(
            tenant_id="local", job_ids=(_job_id(URL),), workflow_id="synthetic-owned-attempt",
            recovery_workflow_id="synthetic-reservation",
        ))
        assert outcome["stages"][0]["scored"] == 0 and outcome["stages"][0]["skipped"] == 1
        assert outcome["stages"][0]["skippedJobIds"] == [str(_job_id(URL))]
    assert len(successor_states) == 1 and _stage(env) == successor_states[0]
    observed = _published_state(env.path, str(_job_id(URL)))
    for key in ("scores", "reports", "items", "bindings", "staleness"):
        assert observed[key] == accepted[key]
    assert observed["events"] == successor_events[0]
    assert _saved(env) == saved
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


@pytest.mark.parametrize("fault", ["invalid_exclusions", "invalid_member", "invalid_json", "invalid_object", "unreadable"])
def test_required_settings_refuse_before_score_attempt_and_can_retry(env, monkeypatch, fault):
    accepted = _stale_accepted(env)
    raw = {
        "invalid_exclusions": '{ "exact_title_exclusions": "synthetic private value" }',
        "invalid_member": '{ "exact_title_exclusions": ["Synthetic title", null] }',
        "invalid_json": '{ "synthetic private value": ',
        "invalid_object": 'null',
        "unreadable": '{ "exact_title_exclusions": ["Synthetic excluded title"] }',
    }[fault]
    _save(env, raw)
    saved, stage = _saved(env), _stage(env)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    availability_calls = []
    monkeypatch.setattr(
        "jobctrl.enrichment.availability.require_preparation_available",
        lambda *args, **kwargs: availability_calls.append(True),
    )
    expected_error = SavedSearchReadError if fault == "unreadable" else InvalidSavedSearchError
    with monkeypatch.context() as failure:
        if fault == "unreadable":
            def fail_read(*args, **kwargs):
                raise sqlite3.OperationalError("synthetic private value")
            failure.setattr(config, "_read_discovery_search_config", fail_read)
        for _ in range(2):
            with pytest.raises(expected_error) as raised:
                score(env, rescore=True)
            assert "restore a verified backup" in str(raised.value)
            assert "synthetic private value" not in str(raised.value)
            assert _saved(env) == saved
            assert _stage(env) == stage
            assert _published_state(env.path, str(_job_id(URL))) == accepted
            assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls
            assert availability_calls == []

    _save(env, '{ "exact_title_exclusions": ["Synthetic excluded title"] }')
    replacement = score(env, rescore=True)
    assert replacement.ok and replacement.score.version == 2
    assert _exclusion_sources(replacement) == ["Synthetic excluded title"]
    assert env.conn.execute("SELECT resolved FROM job_score_staleness").fetchone()[0] == 1


def test_scoring_carries_the_admitted_exclusions_through_an_independent_update(env):
    _save(env, '{ "exact_title_exclusions": ["Synthetic original title"] }')
    analyze = env.analyzer.execute
    changed = []

    def change_after_admission(**kwargs):
        result = analyze(**kwargs)
        if not changed:
            with sqlite3.connect(env.path) as other:
                other.execute(
                    "UPDATE discovery_settings SET search_config_json=? WHERE tenant_id='local'",
                    ('{ "exact_title_exclusions": ["Synthetic newer title"] }',),
                )
            changed.append(True)
        return result

    env.analyzer.execute = change_after_admission
    outcome = score(env)
    assert outcome.ok and changed == [True]
    assert _exclusion_sources(outcome) == ["Synthetic original title"]
    assert "Synthetic newer title" in _saved(env)[1]


@pytest.mark.parametrize("reserved", [False, True])
def test_successor_ownership_takes_precedence_over_unreadable_scoring_inputs(env, reserved):
    accepted = _stale_accepted(env)
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    state = "queued" if reserved else "running"
    metadata = ('{"automaticPreparation":{"workflowId":"synthetic-successor"}}'
                if reserved else '{"activityOwner":"synthetic-successor"}')
    env.conn.execute("UPDATE job_stage_states SET state=?, metadata_json=? WHERE tenant_id='local' AND job_id=? AND stage='score'",
                     (state, metadata, str(_job_id(URL))))
    env.conn.commit()
    stage = _stage(env)
    with pytest.raises(PreparationReservationLost):
        scorer.score_job_by_id(
            _job_id(URL), rescore=True, workflow_id="synthetic-old-owner", profile_snapshot=env.profiles.load_snapshot(LOCAL_TENANT),
            resume_text="Synthetic engineer.", criteria=ScoringCriteria(), llm_port=env.model, analyze_use_case=env.analyzer,
            **({"enforce_workflow_ownership": True, "recovery_workflow_id": "synthetic-old-reservation"} if reserved else {}),
        )
    assert _stage(env) == stage
    assert _published_state(env.path, str(_job_id(URL))) == accepted


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["invalid", "unreadable"])
async def test_temporal_score_activity_reports_required_input_without_claiming_the_stage(env, monkeypatch, fault):
    accepted = _stale_accepted(env)
    _save(env, ('{ "exact_title_exclusions": "synthetic private value" }' if fault == "invalid"
                else '{ "exact_title_exclusions": ["Synthetic title"] }'))
    saved, stage = _saved(env), _stage(env)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    snapshot = env.profiles.load_snapshot(LOCAL_TENANT)
    original_score = scorer.score_job_by_id
    monkeypatch.setattr(database, "DB_PATH", env.path)
    monkeypatch.setattr(scorer, "get_connection", lambda: database.get_connection(env.path))

    def score_with_synthetic_inputs(job_id, **kwargs):
        return original_score(
            job_id, profile_snapshot=snapshot, resume_text="Synthetic engineer.", criteria=ScoringCriteria(),
            llm_port=env.model, analyze_use_case=env.analyzer, **kwargs,
        )

    monkeypatch.setattr(scorer, "score_job_by_id", score_with_synthetic_inputs)
    if fault == "unreadable":
        def fail_read(*args, **kwargs):
            raise sqlite3.OperationalError("synthetic private value")
        monkeypatch.setattr(config, "_read_discovery_search_config", fail_read)
    with pytest.raises(ApplicationError) as raised:
        await ActivityEnvironment().run(
            score_job_activity, ScoreJobActivityInput(tenant_id="local", job_id=_job_id(URL), rescore=True),
        )
    assert raised.value.type == ("invalid_saved_search" if fault == "invalid" else "saved_search_unavailable")
    assert raised.value.non_retryable is (fault == "invalid")
    assert "synthetic private value" not in str(raised.value)
    assert _saved(env) == saved and _stage(env) == stage
    assert _published_state(env.path, str(_job_id(URL))) == accepted
    assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls


@pytest.mark.asyncio
async def test_real_temporal_workflow_preserves_score_and_retries_after_settings_recovery(env, monkeypatch):
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

    from jobctrl.infrastructure.determinations import ThreadLocalDeterminationRepository
    from jobctrl.infrastructure.preparation_recovery import recover_preparation_state_activity
    from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
    from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
    from tests.temporal_env import time_skipping_env
    from tests.test_workflow_job_preparation import _check_spend_budget

    accepted = _stale_accepted(env)
    _save(env, '{ "exact_title_exclusions": "synthetic private value" }')
    saved, stage = _saved(env), _stage(env)
    analyzer_calls, model_calls = len(env.analyzer.calls), env.model.calls
    snapshot = env.profiles.load_snapshot(LOCAL_TENANT)
    original_score = scorer.score_job_by_id
    monkeypatch.setattr(database, "DB_PATH", env.path)
    monkeypatch.setattr(scorer, "get_connection", lambda: database.get_connection(env.path))
    env.dependencies["repository"] = ThreadLocalDeterminationRepository(env.path)

    def score_with_synthetic_inputs(job_id, **kwargs):
        return original_score(
            job_id, profile_snapshot=snapshot, resume_text="Synthetic engineer.", criteria=ScoringCriteria(),
            llm_port=env.model, analyze_use_case=env.analyzer, **kwargs,
        )

    monkeypatch.setattr(scorer, "score_job_by_id", score_with_synthetic_inputs)
    queue = "score-saved-input-" + uuid.uuid4().hex
    async with time_skipping_env() as temporal:
        async with Worker(
            temporal.client, task_queue=queue, workflows=[JobPreparationWorkflow],
            activities=[_check_spend_budget, record_workflow_started, record_workflow_outcome,
                        recover_preparation_state_activity, score_job_activity],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            async def run(suffix):
                handle = await temporal.client.start_workflow(
                    JobPreparationWorkflow.run,
                    JobPreparationInput(tenant_id="local", job_id=_job_id(URL), steps=["score"],
                                        target_version="1", idempotency_key=queue + suffix, rescore=True),
                    id=queue + suffix, task_queue=queue,
                )
                return await asyncio.wait_for(handle.result(), timeout=30), await handle.fetch_history()

            failed, failed_history = await run("-invalid")
            assert failed.steps_failed == ["score"] and failed.error_code == "invalid_saved_search"
            assert _saved(env) == saved and _stage(env) == stage
            observed = _published_state(env.path, str(_job_id(URL)))
            for key in ("scores", "reports", "items", "bindings", "staleness"):
                assert observed[key] == accepted[key]
            assert len(env.analyzer.calls) == analyzer_calls and env.model.calls == model_calls
            _save(env, '{ "exact_title_exclusions": ["Synthetic restored title"] }')
            retried, retry_history = await run("-restored")
            assert retried.steps_completed == ["score"] and not retried.steps_failed
            assert env.conn.execute("SELECT max(version) FROM job_scores").fetchone()[0] == 2
            assert env.conn.execute("SELECT resolved FROM job_score_staleness").fetchone()[0] == 1
        calls = len(env.analyzer.calls), env.model.calls
        replayer = Replayer(workflows=[JobPreparationWorkflow], workflow_runner=UnsandboxedWorkflowRunner())
        await replayer.replay_workflow(failed_history)
        await replayer.replay_workflow(retry_history)
        assert (len(env.analyzer.calls), env.model.calls) == calls
