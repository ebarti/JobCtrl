"""Independent grounded analysis checks share bounded leaves, not publication."""
from __future__ import annotations

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.analysis import EnsembleError
from jobctrl.infrastructure.analysis.parallel_checks import ParallelAnalysisChecks
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.materials.letter_reviews import configure_letter_reviews, LetterReviewPool
from tests.test_analysis_determinations import JOB, Draft, Model, OtherDraft, connection, use_case


def file_case(tmp_path, monkeypatch, model, *, multiple=False):
    from jobctrl import database

    path = tmp_path / "owned-analysis.db"
    monkeypatch.setattr(database, "DB_PATH", path)
    conn = database.get_connection(path)
    seed = connection()
    seed.backup(conn)
    seed.close()
    deps = dict(llm=model, repository=SqliteDeterminationRepository(conn), tenant_id="local",
                provider="fake", model="synthetic", lane="enrichment", preflight=lambda: None)
    case = use_case(conn, model, multiple=multiple)
    case._analysis_checks = ParallelAnalysisChecks(path, deps)
    return conn, case


def bindings(conn):
    return [tuple(row) for row in conn.execute("SELECT * FROM semantic_entity_bindings ORDER BY 1,2,3,4,5")]


def test_grounded_checks_overlap_and_promote_only_after_both_pass(tmp_path, monkeypatch):
    configure_letter_reviews(2)
    rendezvous = threading.Barrier(2, timeout=3)
    threads, requests = {}, {}

    class ConcurrentModel(Model):
        reasoning_effort = "max"

        def chat_json(self, messages, *, response_schema, **kwargs):
            title = response_schema["title"]
            threads[title] = threading.get_ident()
            requests[title] = json.loads(messages[1].content)
            from jobctrl.llm_lanes import current_llm_lane
            assert current_llm_lane() == "enrichment"
            from jobctrl.infrastructure.llm.attempt_admission import check_model_attempt_admission
            check_model_attempt_admission()
            rendezvous.wait()
            with sqlite3.connect(self.database) as observer:
                assert observer.execute("SELECT count(*) FROM semantic_entity_bindings").fetchone()[0] == 0
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    model = ConcurrentModel()
    conn, case = file_case(tmp_path, monkeypatch, model)
    model.database = str(tmp_path / "owned-analysis.db")
    parent = threading.get_ident()
    guarded_on = []
    case._execution_guard = lambda: guarded_on.append(threading.get_ident())
    from jobctrl.infrastructure.llm.attempt_admission import model_attempt_admission
    with model_attempt_admission(case._execution_guard):
        record = case.execute(job=JOB).analysis
    assert set(threads) == {"ClaimVerification", "JobInterpretation"}
    assert len(set(threads.values())) == 2 and parent not in threads.values()
    assert set(guarded_on) == {parent}
    assert model.calls.count("ClaimVerification") == 1
    assert model.calls.count("JobInterpretation") == 1
    assert record.determination_ids["canonical"] == record.determination_ids["fake:leg"]
    assert record.canonical.inferred_seniority == "senior"
    assert record.canonical.requirements[0].coverage_scope == "resume"
    receipts = [json.loads(row[0]) for row in conn.execute("SELECT envelope_json FROM semantic_determinations")]
    assert len(receipts) == 2 and {row["reasoning_effort"] for row in receipts} == {"max"}
    assert case.execute(job=JOB).cached
    assert len(model.calls) == 2
    conn.close()


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_opposing_factual_verdicts_keep_authority_and_rejected_proposals_unbound(tmp_path, monkeypatch, verdict):
    conn, initial = file_case(tmp_path, monkeypatch, Model())
    initial.execute(job=JOB)
    accepted = initial._repository.load("local", JOB["job_id"])
    before = bindings(conn)
    model = Model(verdict=verdict)
    _, changed = file_case_for_existing(conn, monkeypatch, model)
    job = {**JOB, "full_description": "Canonical posting\nChanged source"}
    if verdict == "fail":
        with pytest.raises(EnsembleError):
            changed.execute(job=job, force=True)
        assert bindings(conn) == before
        retained = initial._repository.load(accepted.tenant_id, accepted.job_id)
        assert retained == accepted
        assert conn.execute("SELECT count(*) FROM semantic_determinations WHERE kind='job_interpretation'").fetchone()[0] == 2
    else:
        newer = changed.execute(job=job, force=True).analysis
        assert newer.generation == accepted.generation + 1
        assert newer.determination_ids["job_interpretation"] != accepted.determination_ids["job_interpretation"]
    conn.close()


def file_case_for_existing(conn, monkeypatch, model):
    from jobctrl import database

    path = Path(conn.execute("PRAGMA database_list").fetchone()[2]).resolve()
    monkeypatch.setattr(database, "DB_PATH", path)
    deps = dict(llm=model, repository=SqliteDeterminationRepository(conn), tenant_id="local",
                provider="fake", model="synthetic", lane="enrichment", preflight=lambda: None)
    case = use_case(conn, model)
    case._analysis_checks = ParallelAnalysisChecks(path, deps)
    return conn, case


@pytest.mark.parametrize("protected", [False, True])
def test_interpretation_verdicts_remain_model_authored(tmp_path, monkeypatch, protected):
    conn, case = file_case(tmp_path, monkeypatch, Model(protected=protected))
    record = case.execute(job=JOB).analysis
    assert bool(record.eeo_screen_hits) is protected
    assert record.canonical.requirements[0].evidence_span == "Canonical posting"
    conn.close()


@pytest.mark.parametrize("multiple,partial_failure", [(False, False), (True, False), (True, True)])
def test_only_accepted_canonical_gets_interpretation_for_multiple_legs(tmp_path, monkeypatch, multiple, partial_failure):
    model = Model()
    conn, case = file_case(tmp_path, monkeypatch, model, multiple=multiple)
    pair_requests = []
    real_review = case._analysis_checks.review

    def tracked(**kwargs):
        pair_requests.append(kwargs)
        return real_review(**kwargs)

    case._analysis_checks.review = tracked
    if partial_failure:
        class Failed(OtherDraft):
            async def draft(self, *args, **kwargs):
                raise RuntimeError("Owned unavailable leg")
        case._adapters = (Draft(), Failed())
    result = case.execute(job=JOB).analysis
    assert len(pair_requests) == 1
    assert model.calls.count("JobInterpretation") == 1
    assert result.legs_attempted == (2 if multiple else 1)
    assert bool(result.failures) is partial_failure
    conn.close()


def test_changed_requirements_cannot_reuse_prior_interpretation(tmp_path, monkeypatch):
    model = Model()
    conn, case = file_case(tmp_path, monkeypatch, model)
    first = case.execute(job=JOB).analysis

    class Changed(Draft):
        async def draft(self, *args):
            result = await super().draft(*args)
            result.requirements[0].id = "changed-requirement"
            return result

    case._adapters = (Changed(),)
    second = case.execute(job=JOB, force=True).analysis
    assert second.determination_ids["job_interpretation"] != first.determination_ids["job_interpretation"]
    assert model.calls.count("JobInterpretation") == 2
    assert second.canonical.requirements[0].id == "changed-requirement"
    conn.close()


def test_failed_aggregate_transaction_keeps_previous_bindings_and_generation(tmp_path, monkeypatch):
    conn, case = file_case(tmp_path, monkeypatch, Model())
    case.execute(job=JOB)
    accepted = case._repository.load("local", JOB["job_id"])
    before = bindings(conn)
    real_save = case._repository._save_rows

    def failed_save(*args):
        real_save(*args)
        raise RuntimeError("Owned persistence failure")

    monkeypatch.setattr(case._repository, "_save_rows", failed_save)
    with pytest.raises(RuntimeError, match="Owned persistence failure"):
        case.execute(job={**JOB, "full_description": "Canonical posting\nNew source"}, force=True)
    assert bindings(conn) == before
    assert case._repository.load(accepted.tenant_id, accepted.job_id) == accepted
    assert conn.execute("SELECT count(*) FROM job_employer_analysis").fetchone()[0] == 1
    conn.close()


def test_parent_cancellation_drains_checks_without_binding_proposal(tmp_path, monkeypatch):
    configure_letter_reviews(2)
    rendezvous = threading.Barrier(2, timeout=3)
    canceled = threading.Event()
    settled = []

    class CancelModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            rendezvous.wait()
            canceled.set()
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            settled.append(response_schema["title"])
            return result

    conn, case = file_case(tmp_path, monkeypatch, CancelModel())
    parent = threading.get_ident()

    def guard():
        assert threading.get_ident() == parent
        if canceled.is_set():
            raise DeterminationFailure("owner_canceled")

    case._execution_guard = guard
    with pytest.raises(EnsembleError):
        case.execute(job=JOB)
    assert sorted(settled) == ["ClaimVerification", "JobInterpretation"]
    assert bindings(conn) == []
    assert conn.execute("SELECT count(*) FROM job_employer_analysis").fetchone()[0] == 0
    conn.close()


def test_terminal_interpretation_failure_preserves_accepted_analysis(tmp_path, monkeypatch):
    conn, case = file_case(tmp_path, monkeypatch, Model())
    case.execute(job=JOB)
    accepted = case._repository.load("local", JOB["job_id"])
    before = bindings(conn)
    model = Model(fault="JobInterpretation")
    _, failed = file_case_for_existing(conn, monkeypatch, model)
    with pytest.raises(EnsembleError):
        failed.execute(job={**JOB, "full_description": "Canonical posting\nChanged"}, force=True)
    assert model.calls.count("JobInterpretation") == 1
    assert bindings(conn) == before
    assert case._repository.load(accepted.tenant_id, accepted.job_id) == accepted
    conn.close()


def test_leaf_connections_close_and_wrong_database_refuses_before_model(tmp_path, monkeypatch):
    from jobctrl import database
    from jobctrl.infrastructure.analysis import parallel_checks

    model = Model()
    conn, case = file_case(tmp_path, monkeypatch, model)
    tracked = []
    real_get = parallel_checks.get_connection

    def capture(path):
        current = real_get(path)
        tracked.append(current)
        return current

    monkeypatch.setattr(parallel_checks, "get_connection", capture)
    case.execute(job=JOB)
    assert len(tracked) == 2
    for current in tracked:
        with pytest.raises(sqlite3.ProgrammingError):
            current.execute("SELECT 1")
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "other.db")
    count = len(model.calls)
    with pytest.raises(EnsembleError):
        case.execute(job=JOB, force=True)
    assert len(model.calls) == count
    conn.close()


def test_analysis_and_material_pairs_share_one_leaf_capacity():
    pool = LetterReviewPool(2)
    release, saturated = threading.Event(), threading.Event()
    lock = threading.Lock()
    running = maximum = 0

    def leaf(stop):
        nonlocal running, maximum
        with lock:
            running += 1
            maximum = max(maximum, running)
            if running == 2:
                saturated.set()
        try:
            assert release.wait(3)
            return "Owned"
        finally:
            with lock:
                running -= 1

    with ThreadPoolExecutor(3) as parents:
        results = [parents.submit(pool.run_pair, leaf, leaf), parents.submit(pool.review, leaf, leaf, None),
                   parents.submit(pool.run_pair, leaf, leaf)]
        try:
            assert saturated.wait(2)
            assert maximum == 2
        finally:
            release.set()
        assert results[0].result(timeout=3) == ("Owned", "Owned")
        assert results[1].result(timeout=3).claims == "Owned"
        assert results[2].result(timeout=3) == ("Owned", "Owned")
    pool.close()


def test_production_factory_selects_thread_owned_checks_only_for_file_database(tmp_path, monkeypatch):
    from jobctrl.infrastructure import llm, setup_probes
    from jobctrl.scoring.employer_analysis import build_analyze_use_case
    from tests.test_employer_analysis_leg_config import _FakeLlm

    monkeypatch.setattr(setup_probes, "ready_llm_providers", lambda: ("codex",))
    monkeypatch.setattr(llm, "LlmAdapter", _FakeLlm)
    for path in (":memory:", str(tmp_path / "file.db")):
        conn = sqlite3.connect(path)
        case = build_analyze_use_case(conn=conn, event_stage="score")
        assert isinstance(case._analysis_checks, ParallelAnalysisChecks) is (path != ":memory:")
        conn.close()


@pytest.mark.parametrize("fault,code,calls", [
    ("provider_unavailable", "provider_unavailable", 1),
    ("foreign_requirement", "foreign_or_missing_requirement_id", 3),
    ("non_verbatim_quote", "non_verbatim_quote", 3),
    ("unknown_scope", "schema_violation", 3),
])
def test_interpretation_structural_failures_keep_their_own_budget(tmp_path, monkeypatch, fault, code, calls):
    configure_letter_reviews(1)

    class FaultModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            result = super().chat_json(messages, response_schema=response_schema, **kwargs)
            if response_schema["title"] == "JobInterpretation":
                if fault == "provider_unavailable":
                    raise DeterminationFailure(fault)
                if fault == "foreign_requirement":
                    result["requirements"][0]["requirement_id"] = "foreign"
                elif fault == "non_verbatim_quote":
                    result["requirements"][0]["citations"][0]["quote"] = "Not supplied"
                else:
                    result["requirements"][0]["scope"] = "foreign"
            return result

    model = FaultModel()
    conn, case = file_case(tmp_path, monkeypatch, model)
    with pytest.raises(EnsembleError) as error:
        case.execute(job=JOB)
    assert error.value.determination_failure.code == code
    assert model.calls.count("JobInterpretation") == calls
    assert len(case._adapters[0].calls) == 1
    assert bindings(conn) == []
    conn.close()


def test_denied_preflight_never_calls_model_or_binds_proposal(tmp_path, monkeypatch):
    model = Model()
    conn, case = file_case(tmp_path, monkeypatch, model)

    def deny():
        raise DeterminationFailure("budget_denied")

    case._analysis_checks._dependencies["preflight"] = deny
    with pytest.raises(EnsembleError) as error:
        case.execute(job=JOB)
    assert error.value.determination_failure.code == "budget_denied"
    assert model.calls == [] and bindings(conn) == []
    conn.close()
