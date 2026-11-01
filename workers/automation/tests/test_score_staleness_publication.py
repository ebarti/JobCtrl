"""Stale score markers follow accepted replacement and source ownership."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.scoring import SqliteScoreStalenessRepository
from jobctrl.state import SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE, set_stage_state
from tests.test_score_atomic_publication import _mark_policy_change, _published_state
from tests.test_score_profile_impact import URL, _job_id, rows, score, update
from tests.test_score_profile_impact import conn as conn
from tests.test_score_profile_impact import env as env
from tests.test_score_profile_impact import profile_snapshot as profile_snapshot


def _markers(conn):
    return [tuple(row) for row in conn.execute(
        "SELECT stale_reason, old_policy_id, old_policy_version, new_policy_id, "
        "new_policy_version, resolved, resolved_by_score_version FROM job_score_staleness "
        "WHERE tenant_id='local' AND job_id=? ORDER BY stale_reason, old_policy_version, new_policy_version",
        (str(_job_id(URL)),),
    )]


def _insert_marker(conn, *, reason="scoring_policy_changed", old_id="local:scoring-policy-v1",
                   old_version=1, new_id="local:scoring-policy-v2", new_version=2):
    conn.execute(
        "INSERT INTO job_score_staleness (tenant_id, job_id, stale_reason, old_policy_id, "
        "old_policy_version, new_policy_id, new_policy_version, marked_at, resolved) "
        "VALUES ('local', ?, ?, ?, ?, ?, ?, '2026-01-02T00:00:00Z', 0)",
        (str(_job_id(URL)), reason, old_id, old_version, new_id, new_version),
    )


def test_reset_noop_and_failed_provider_keep_the_accepted_score_stale(env):
    first = score(env)
    assert first.ok and first.score.version == 1
    _mark_policy_change(env.conn, _job_id(URL))

    reset = SqliteScoreStalenessRepository(env.conn).reset_for_rescore(LOCAL_TENANT)
    assert len(reset) == 1
    assert env.conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='score'",
                            (str(_job_id(URL)),)).fetchone()[0] == "pending"
    accepted = _published_state(env.path, str(_job_id(URL)))
    before = _markers(env.conn)
    assert before[0][-2:] == (0, None)

    # Existing-score reuse is not a replacement, and must not promote this
    # score to current even though the accepted score stays readable.
    reused = score(env)
    assert reused.ok and reused.score.version == 1
    assert _markers(env.conn) == before
    assert env.conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='score'",
                            (str(_job_id(URL)),)).fetchone()[0] == "pending"

    update(env)
    env.model.score_failure = True
    failed = score(env, rescore=True)
    assert not failed.ok
    assert _markers(env.conn) == before
    observed = _published_state(env.path, str(_job_id(URL)))
    for table in ("scores", "reports", "items", "bindings", "staleness"):
        assert observed[table] == accepted[table]
    assert env.conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='score'",
                            (str(_job_id(URL)),)).fetchone()[0] in {"failed", "blocked"}


def test_only_source_matching_markers_resolve_with_atomic_publication(env):
    assert score(env).ok
    _mark_policy_change(env.conn, _job_id(URL))
    _insert_marker(env.conn, reason="unrelated_source_change")
    _insert_marker(env.conn, old_id="foreign-policy", old_version=0)
    _insert_marker(env.conn, new_id="foreign-policy", new_version=3)
    env.conn.commit()
    accepted = _published_state(env.path, str(_job_id(URL)))

    env.conn.execute("CREATE TRIGGER fail_stale_resolution BEFORE UPDATE ON job_score_staleness "
                     "WHEN NEW.resolved=1 BEGIN SELECT RAISE(ABORT, 'synthetic marker failure'); END")
    env.conn.commit()
    with pytest.raises(sqlite3.IntegrityError, match="synthetic marker failure"):
        score(env, rescore=True)
    observed = _published_state(env.path, str(_job_id(URL)))
    for table in ("scores", "reports", "items", "bindings", "staleness"):
        assert observed[table] == accepted[table]

    env.conn.execute("DROP TRIGGER fail_stale_resolution")
    env.conn.commit()
    replacement = score(env, rescore=True)
    assert replacement.ok and replacement.score.version == 2
    assert replacement.score.trace.scoring_policy_id == "local:scoring-policy-v2"
    markers = _markers(env.conn)
    assert [row[-2:] for row in markers] == [(0, None), (1, 2), (0, None), (0, None)]
    assert len(_published_state(env.path, str(_job_id(URL)))["reports"]) == 2


def test_invalidation_committed_during_inference_is_not_resolved_by_that_score(env):
    assert score(env).ok
    env.conn.execute(
        "INSERT INTO scoring_policies (tenant_id,version,rubric_json,anchors_json,created_at) "
        "SELECT tenant_id,2,rubric_json,anchors_json,'2026-01-02T00:00:00Z' "
        "FROM scoring_policies WHERE tenant_id='local' AND version=1"
    )
    env.conn.commit()
    update(env)
    set_stage_state(
        env.conn, _job_id(URL), "tailor", "blocked", tenant_id=LOCAL_TENANT,
        error_code=SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE, blocked_by=["score"],
        validate_transition=False,
    )
    env.conn.commit()

    def mark_from_independent_writer():
        other = sqlite3.connect(env.path)
        try:
            _insert_marker(other)
            other.commit()
        finally:
            other.close()

    env.model.after_call = mark_from_independent_writer
    in_flight = score(env, rescore=True)
    assert in_flight.ok and in_flight.score.version == 2
    assert env.model.after_call is None
    assert _markers(env.conn)[0][-2:] == (0, None)
    assert tuple(env.conn.execute(
        "SELECT state, error_code FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='tailor'",
        (str(_job_id(URL)),),
    ).fetchone()) == ("blocked", SCORE_ELIGIBILITY_BLOCKED_ERROR_CODE)

    update(env, "A later synthetic edit")
    env.model.fault = "foreign"
    failed_review = score(env, rescore=True)
    assert not failed_review.ok and "foreign_source_id" in failed_review.error
    assert _markers(env.conn)[0][-2:] == (0, None)
    env.model.fault = None
    preflight = env.dependencies["preflight"]

    def deny_budget():
        raise RuntimeError("synthetic budget denial")

    env.dependencies["preflight"] = deny_budget
    denied = score(env, rescore=True)
    assert not denied.ok and "budget_denied" in denied.error
    assert _markers(env.conn)[0][-2:] == (0, None)
    env.dependencies["preflight"] = preflight
    env.model.verdict = "insignificant"
    retained = score(env, rescore=True)
    assert retained.ok and retained.retained and retained.score.version == 2
    assert _markers(env.conn)[0][-2:] == (0, None)

    # A subsequent, genuinely new assessment may adopt that captured marker;
    # its source remains bound to the historical v1 accepted score.
    update(env, "Another synthetic edit")
    env.model.verdict = "significant"
    next_replacement = score(env, rescore=True)
    assert next_replacement.ok and next_replacement.score.version == 3
    assert _markers(env.conn)[0][-2:] == (1, 3)


def test_new_policy_and_invalidation_during_inference_preserve_prior_publication(env):
    assert score(env).ok
    _mark_policy_change(env.conn, _job_id(URL))
    before_scores = rows(env)
    accepted = _published_state(env.path, str(_job_id(URL)))
    update(env)

    def newer_policy_and_marker():
        other = sqlite3.connect(env.path)
        try:
            other.execute(
                "INSERT INTO scoring_policies (tenant_id,version,rubric_json,anchors_json,created_at) "
                "SELECT tenant_id,3,rubric_json,anchors_json,'2026-01-03T00:00:00Z' "
                "FROM scoring_policies WHERE tenant_id='local' AND version=2"
            )
            _insert_marker(other, new_id="local:scoring-policy-v3", new_version=3)
            other.commit()
        finally:
            other.close()

    env.model.after_call = newer_policy_and_marker
    result = score(env, rescore=True)
    assert not result.ok
    assert env.model.after_call is None
    assert rows(env) == before_scores
    assert [row[-2:] for row in _markers(env.conn)] == [(0, None), (0, None)]
    observed = _published_state(env.path, str(_job_id(URL)))
    for table in ("scores", "reports", "items", "bindings"):
        assert observed[table] == accepted[table]
