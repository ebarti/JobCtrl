"""A score must not replace an accepted assessment for a changed posting."""

from __future__ import annotations

import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost
from jobctrl.scoring import scorer as scorer_module
from .test_score_profile_impact import URL, _job_id, rows, score, update
from .test_score_profile_impact import env as env
from .test_scorer import conn as conn
from .test_scorer import profile_snapshot as profile_snapshot

_CANONICAL_BUILD = scorer_module._build_use_case


def test_posting_change_during_rescore_preserves_last_accepted_score_and_report(env):
    accepted = score(env)
    assert accepted.ok
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    assert reports_before
    update(env)
    env.model.verdict = "significant"

    def change_posting():
        other = sqlite3.connect(env.path)
        try:
            other.execute(
                "UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?",
                ("Synthetic changed posting after scoring began.", str(_job_id(URL))),
            )
            other.commit()
        finally:
            other.close()

    env.model.after_call = change_posting
    try:
        result = score(env, rescore=True)
    except (DeterminationFailure, PreparationReservationLost):
        result = None
    assert env.conn.execute("SELECT full_description FROM job_enrichments WHERE tenant_id='local' AND job_id=?", (str(_job_id(URL)),)).fetchone()[0] == "Synthetic changed posting after scoring began."
    assert result is None or not result.ok
    assert rows(env) == scores_before
    assert [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )] == reports_before


def _seed_canonical_sources(env):
    from jobctrl.domain.determinations import DeterminationEnvelope
    from jobctrl.domain.job_snapshot import build_jd_snapshot, compute_snapshot_hash
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
    from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
    from .determination_fakes import job_interpretation

    job = SqlitePreparationTargetReader(env.conn).load(LOCAL_TENANT, _job_id(URL))
    analysis = env.analyzer.execute(job=job).analysis
    SqliteEmployerAnalysisRepository(env.conn).save(analysis)
    snapshot = compute_snapshot_hash(build_jd_snapshot(job))
    interpretation = job_interpretation(analysis.canonical.requirements)
    for digit in ("1", "2"):
        ident = digit * 64
        env.repository.save(DeterminationEnvelope(
            determination_id=ident, tenant_id="local", entity_id=str(_job_id(URL)),
            kind="job_interpretation", schema_version="1", prompt_version="job-interpretation-v1",
            provider="synthetic", model="synthetic", lane="enrichment", input_fingerprint=ident,
            created_at="2026-01-01T00:00:00+00:00", result=interpretation.model_dump(mode="json"),
        ))
    env.repository.bind(
        tenant_id="local", entity_kind="job", entity_id=str(_job_id(URL)),
        entity_version=snapshot, determination_kind="job_interpretation", determination_id="1" * 64,
    )
    env.conn.commit()
    return snapshot


@pytest.mark.parametrize("changed_source", ["analysis", "interpretation", "policy"])
def test_concurrent_source_change_preserves_accepted_score_and_report(env, changed_source):
    assert score(env).ok
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    snapshot = _seed_canonical_sources(env)
    update(env)
    env.model.verdict = "significant"

    def change_source():
        other = sqlite3.connect(env.path)
        try:
            if changed_source == "analysis":
                result = other.execute(
                    "UPDATE job_employer_analysis SET requirements_json=json_set(requirements_json,'$[0].weight',0.125) "
                    "WHERE tenant_id='local' AND job_id=? AND generation=1", (str(_job_id(URL)),),
                )
            elif changed_source == "interpretation":
                result = other.execute(
                    "UPDATE semantic_entity_bindings SET determination_id=? WHERE tenant_id='local' "
                    "AND entity_kind='job' AND entity_id=? AND entity_version=? "
                    "AND determination_kind='job_interpretation'",
                    ("2" * 64, str(_job_id(URL)), snapshot),
                )
            else:
                result = other.execute(
                    "INSERT INTO scoring_policies (tenant_id,version,rubric_json,anchors_json,created_at) "
                    "SELECT tenant_id,version+1,rubric_json,anchors_json,'2026-01-02T00:00:00Z' "
                    "FROM scoring_policies WHERE tenant_id='local' AND version=1",
                )
            assert result.rowcount == 1
            other.commit()
        finally:
            other.close()

    env.model.after_call = change_source
    try:
        result = score(env, rescore=True)
    except (DeterminationFailure, PreparationReservationLost):
        result = None
    assert env.model.after_call is None
    assert result is None or not result.ok
    assert rows(env) == scores_before
    assert [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )] == reports_before


def test_superseded_analysis_before_inference_does_not_publish(env, monkeypatch):
    from dataclasses import replace

    from jobctrl.domain.scoring import ScoringCriteria
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
    from jobctrl.infrastructure.preparation import SqlitePreparationTargetReader
    from jobctrl.scoring import scorer

    assert score(env).ok
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    _seed_canonical_sources(env)
    job = SqlitePreparationTargetReader(env.conn).load(LOCAL_TENANT, _job_id(URL))
    old_analysis = env.analyzer.execute(job=job).analysis
    SqliteEmployerAnalysisRepository(env.conn).save(replace(old_analysis, generation=2))
    env.conn.commit()
    update(env)
    env.model.verdict = "significant"
    from jobctrl.infrastructure.enrichment.interpretation import read_job_interpretation

    build = scorer._build_use_case

    def canonical_build(**kwargs):
        use_case = build(**kwargs)
        use_case._repository.require_canonical_inputs = True
        use_case._job_interpretation_reader = lambda job: read_job_interpretation(
            env.conn, job, tenant_id="local"
        )[0]
        return use_case

    monkeypatch.setattr(scorer, "_build_use_case", canonical_build)
    try:
        result = scorer.score_job_by_id(
            _job_id(URL), tenant_id=LOCAL_TENANT, rescore=True,
            resume_text="Synthetic Python engineer.", criteria=ScoringCriteria(),
            llm_port=env.model, employer_analysis=old_analysis,
        )
    except (DeterminationFailure, PreparationReservationLost):
        result = None
    assert result is None or not result.ok
    assert rows(env) == scores_before
    assert [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )] == reports_before


def test_default_canonical_reader_fences_analysis_change_during_selected_scoring(env, monkeypatch):
    _seed_canonical_sources(env)
    monkeypatch.setattr(scorer_module, "_build_use_case", _CANONICAL_BUILD)
    accepted = score(env)
    assert accepted.ok, accepted.error
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    assert reports_before
    update(env)
    env.model.verdict = "significant"

    def change_analysis():
        other = sqlite3.connect(env.path)
        try:
            changed = other.execute(
                "UPDATE job_employer_analysis SET requirements_json=json_set(requirements_json,'$[0].weight',0.125) "
                "WHERE tenant_id='local' AND job_id=? AND generation=1", (str(_job_id(URL)),),
            )
            assert changed.rowcount == 1
            other.commit()
        finally:
            other.close()

    env.model.after_call = change_analysis
    try:
        result = score(env, rescore=True)
    except (DeterminationFailure, PreparationReservationLost):
        result = None
    assert env.model.after_call is None
    assert result is None or not result.ok
    assert rows(env) == scores_before
    assert [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )] == reports_before


def test_policy_change_after_previous_score_selection_cannot_retain_old_score(env, monkeypatch):
    """A new policy between selection and capture must not certify the old score."""
    accepted = score(env)
    assert accepted.ok, accepted.error
    assert accepted.score.trace.scoring_policy_version == 1
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    update(env)
    env.model.verdict = "insignificant"
    original_capture = scorer_module._OwnedScoreRepository.capture_scoring_inputs
    changed = False

    def capture_after_policy_update(repository, job):
        nonlocal changed
        if not changed:
            # score_job_by_id has already compared the previous score with policy 1;
            # commit policy 2 on an independent writer immediately before capture.
            other = sqlite3.connect(env.path)
            try:
                inserted = other.execute(
                    "INSERT INTO scoring_policies (tenant_id,version,rubric_json,anchors_json,created_at) "
                    "SELECT tenant_id,version+1,rubric_json,anchors_json,'2026-01-02T00:00:00Z' "
                    "FROM scoring_policies WHERE tenant_id='local' AND version=1"
                )
                assert inserted.rowcount == 1
                other.commit()
                changed = True
            finally:
                other.close()
        return original_capture(repository, job)

    monkeypatch.setattr(scorer_module._OwnedScoreRepository, "capture_scoring_inputs", capture_after_policy_update)
    try:
        result = score(env, rescore=True)
    except (DeterminationFailure, PreparationReservationLost):
        result = None

    assert changed
    assert env.conn.execute("SELECT max(version) FROM scoring_policies WHERE tenant_id='local'").fetchone()[0] == 2
    if result is not None and result.ok:
        assert not result.retained
        assert result.score.version > accepted.score.version
        assert result.score.trace.scoring_policy_version == 2
    else:
        assert rows(env) == scores_before
        assert [tuple(row) for row in env.conn.execute(
            "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
            (str(_job_id(URL)),),
        )] == reports_before
        assert env.repository.bound(tenant_id="local", entity_kind="score_profile_review",
            entity_id=str(_job_id(URL)), entity_version="1:default:2", determination_kind="score_profile_impact") is None


@pytest.mark.parametrize("successor", [False, True])
def test_selected_score_source_change_terminalizes_only_still_owned_stage(env, monkeypatch, successor):
    """A stale input fails its own run but cannot overwrite a successor owner."""
    import json

    from jobctrl.domain.scoring import ScoringCriteria
    from jobctrl.scoring.activities import ScoreActivityInput, _run_selected_scores

    assert score(env).ok
    scores_before = rows(env)
    reports_before = [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )]
    update(env)
    env.model.verdict = "significant"
    original_score_job = scorer_module.score_job_by_id

    # Exercise the real selected-score boundary and writer; only the provider
    # and analysis input are synthetic, as in the existing scorer fixture.
    def score_with_synthetic_ports(job_id, **kwargs):
        return original_score_job(
            job_id, **kwargs, criteria=ScoringCriteria(), llm_port=env.model,
            analyze_use_case=env.analyzer, resume_text="Synthetic Python engineer.",
        )

    monkeypatch.setattr(scorer_module, "score_job_by_id", score_with_synthetic_ports)

    def change_posting():
        other = sqlite3.connect(env.path)
        try:
            other.execute(
                "UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?",
                ("Synthetic changed posting after scoring began.", str(_job_id(URL))),
            )
            if successor:
                other.execute(
                    "UPDATE job_stage_states SET state='running',metadata_json=? "
                    "WHERE tenant_id='local' AND job_id=? AND stage='score'",
                    (json.dumps({"activityOwner": "synthetic-successor"}), str(_job_id(URL))),
                )
            other.commit()
        finally:
            other.close()

    env.model.after_call = change_posting
    result = _run_selected_scores(ScoreActivityInput(
        tenant_id="local", job_ids=(_job_id(URL),), rescore=True, workflow_id="synthetic-original",
    ))
    assert env.model.after_call is None
    assert rows(env) == scores_before
    assert [tuple(row) for row in env.conn.execute(
        "SELECT * FROM job_requirement_fit_reports WHERE tenant_id='local' AND job_id=? ORDER BY score_version",
        (str(_job_id(URL)),),
    )] == reports_before
    stage = env.conn.execute(
        "SELECT state, retryable, metadata_json FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'",
        (str(_job_id(URL)),),
    ).fetchone()
    if successor:
        assert stage[0] == "running"
        assert json.loads(stage[2])["activityOwner"] == "synthetic-successor"
        assert result["stages"][0]["skipped"] == 1
    else:
        assert stage[0] == "failed" and stage[1] == 1
        assert result["status"] == "failed"
        assert str(_job_id(URL)) in result["errors"]
        assert result["stages"][0]["skipped"] == 0
