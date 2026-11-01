"""Bounded independent reviews through the production letter construction path."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from jobctrl.scoring import cover_letter
from tests.test_artifact_determinations import Model, connection, seed_resume, cover_request


def file_case(tmp_path, monkeypatch, model):
    from jobctrl import database

    monkeypatch.setattr(database, "DB_PATH", tmp_path / "owned.db")
    conn = database.get_connection(tmp_path / "owned.db")
    source = connection()
    source.backup(conn)
    source.close()
    seed_resume(conn, tmp_path)
    monkeypatch.setattr(cover_letter, "get_connection", lambda: conn)
    return conn, cover_letter._build_use_case(llm_port=model)


def test_production_letter_reviews_overlap_on_the_same_frozen_draft(tmp_path, monkeypatch):
    rendezvous = threading.Barrier(2, timeout=2)
    threads = {}

    class ConcurrentModel(Model):
        reasoning_effort = "max"

        def chat_json(self, messages, *, response_schema, **kwargs):
            title = response_schema["title"]
            if title in {"ClaimVerification", "ArtifactQuality"}:
                threads[title] = threading.get_ident()
                rendezvous.wait()
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, case = file_case(tmp_path, monkeypatch, ConcurrentModel())
    parent_thread = threading.get_ident()
    guarded_on = []
    outcome = case.execute(**cover_request(tmp_path), commit_guard=lambda: guarded_on.append(threading.get_ident()))
    assert outcome.status == "ok"
    assert len(set(threads.values())) == 2
    assert parent_thread not in threads.values()
    assert set(guarded_on) == {parent_thread}
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 2
    conn.close()


def test_repeat_pair_reuses_exact_sequential_determination_ids_and_closes_connections(tmp_path, monkeypatch):
    from jobctrl.domain.materials.artifact_quality import ModelArtifactQualityJudge
    from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
    from jobctrl.domain.ports.claim_verification import ArtifactLine
    from jobctrl.domain.determinations import Source
    from jobctrl.infrastructure import determinations
    from jobctrl.infrastructure.materials import letter_reviews

    model = Model()
    conn, _ = file_case(tmp_path, monkeypatch, model)
    deps = determinations.determination_dependencies(conn, tenant_id="local", lane="tailoring", adapter=model)
    line = ArtifactLine(line_id="body:1", text="Owned text", allowed_evidence_ids=["source:1"], allowed_requirement_ids=[])
    evidence = [Source(source_id="source:1", text="Owned source")]
    claims = dict(artifact_kind="cover_letter", entity_id="owned", lines=[line], evidence=evidence, requirements=[], rubric={})
    quality = dict(artifact_kind="cover_letter", entity_id="owned", lines=[line], sources=evidence, rubric={})
    sequential = (
        ModelClaimVerifier(**deps).verify(**claims)[1].determination_id,
        ModelArtifactQualityJudge(**deps).judge(**quality)[1].determination_id,
    )
    connections = []
    real_get = letter_reviews.get_connection

    def tracked_get(path):
        current = real_get(path)
        connections.append(current)
        return current

    monkeypatch.setattr(letter_reviews, "get_connection", tracked_get)
    runner = letter_reviews.ParallelLetterReviews(tmp_path / "owned.db", deps)
    for _ in range(2):
        result = runner.review(claim_request=claims, quality_request=quality)
        assert (result.claims[1].determination_id, result.quality[1].determination_id) == sequential
    assert len(model.calls) == 2  # Cache hits require no new model/spend admission.
    assert len(connections) == 4
    for current in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            current.execute("SELECT 1")
    conn.close()


@pytest.mark.parametrize("capacity", [1, 4])
def test_review_pool_bounds_running_and_outstanding_pairs_without_deadlock(capacity):
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.infrastructure.materials.letter_reviews import LetterReviewPool

    release = threading.Event()
    saturated = threading.Event()
    lock = threading.Lock()
    running = maximum = 0
    pool = LetterReviewPool(capacity)

    def leaf(stop):
        nonlocal running, maximum
        stop.check()
        with lock:
            running += 1
            maximum = max(maximum, running)
            if running == capacity:
                saturated.set()
        try:
            assert release.wait(3)
            return "owned"
        finally:
            with lock:
                running -= 1

    with ThreadPoolExecutor(max_workers=capacity + 2) as parents:
        requests = [parents.submit(pool.review, leaf, leaf, None) for _ in range(capacity + 2)]
        try:
            assert saturated.wait(2)
            with pool._lock:
                assert len(pool._groups) <= capacity
            assert maximum == capacity
        finally:
            release.set()
        assert all(request.result(timeout=3).claims == "owned" for request in requests)
    pool.close()
    assert not pool._groups


def test_canceled_parent_waiting_for_pair_admission_never_submits_work():
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import LetterReviewPool

    pool = LetterReviewPool(1)
    held, release, canceled = threading.Event(), threading.Event(), threading.Event()
    called = []

    def hold(stop):
        held.set()
        assert release.wait(3)
        return "admitted"

    def guard():
        if canceled.is_set():
            raise DeterminationFailure("owner_canceled")

    with ThreadPoolExecutor(2) as parents:
        first = parents.submit(pool.review, hold, hold, None)
        assert held.wait(2)
        second = parents.submit(pool.review, lambda stop: called.append(1), lambda stop: called.append(2), guard)
        canceled.set()
        try:
            with pytest.raises(DeterminationFailure, match="owner_canceled"):
                second.result(timeout=1)
            assert called == []
        finally:
            release.set()
        first.result(timeout=3)
    pool.close()


def test_first_terminal_fault_is_retained_and_queued_sibling_is_not_called():
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import LetterReviewPool

    pool = LetterReviewPool(1)
    calls = []
    original = DeterminationFailure("provider_unavailable")

    def fail(stop):
        stop.abort(original)
        raise original

    with pytest.raises(DeterminationFailure) as error:
        pool.review(fail, lambda stop: (stop.check(), calls.append(1)), None)
    assert error.value is original
    assert calls == []
    pool.close()


def test_terminal_failure_stops_sibling_before_blocked_state_write(tmp_path, monkeypatch):
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
    from jobctrl.infrastructure.materials.letter_reviews import _ReviewStop
    from tests.test_artifact_determinations import ports

    conn, _ = file_case(tmp_path, monkeypatch, Model())
    stop = _ReviewStop()
    observed = []
    original = SqliteDeterminationRepository.record_state

    def record(self, **kwargs):
        if kwargs["state"] == "blocked":
            with pytest.raises(DeterminationFailure, match="review_canceled"):
                stop.check()
            observed.append(kwargs["failure_code"])
        return original(self, **kwargs)

    monkeypatch.setattr(SqliteDeterminationRepository, "record_state", record)
    from jobctrl.domain.ports.claim_verification import ArtifactLine
    from jobctrl.domain.determinations import Source
    verifier, _ = ports(conn, Model(fault=DeterminationFailure("provider_unavailable")))
    verifier._on_terminal_failure = stop.abort
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        verifier.verify(artifact_kind="cover_letter", entity_id="owned", lines=[ArtifactLine(line_id="a", text="Owned", allowed_evidence_ids=["s"], allowed_requirement_ids=[])], evidence=[Source(source_id="s", text="Owned")], requirements=[], rubric={})
    assert observed == ["provider_unavailable"]
    conn.close()


def test_stop_guard_precedes_common_provider_attempt_and_spend(monkeypatch):
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.llm.attempt_admission import model_attempt_admission
    from jobctrl.infrastructure.observability.llm_spans import llm_generation_span
    from jobctrl.infrastructure.materials.letter_reviews import _ReviewStop
    import jobctrl.llm as spending

    stop = _ReviewStop()
    stop.abort(DeterminationFailure("owner_canceled"))
    calls = []
    monkeypatch.setattr(spending, "enforce_spend_budget", lambda lane: calls.append(lane))
    with model_attempt_admission(stop.check), pytest.raises(DeterminationFailure, match="review_canceled"):
        with llm_generation_span(model="owned", messages=[], params={}):
            calls.append("dispatch")
    assert calls == []


@pytest.mark.parametrize("quality", ["pass", "fail"])
def test_parallel_model_verdict_controls_acceptance_and_preserves_prior_artifact(tmp_path, monkeypatch, quality):
    conn, initial = file_case(tmp_path, monkeypatch, Model())
    accepted = initial.execute(**cover_request(tmp_path))
    assert accepted.status == "ok"
    prior = accepted.materials.cover_letter
    data = Path(prior.path).read_bytes()
    changed = cover_letter._build_use_case(llm_port=Model(quality=quality, draft_text="Different owned draft"))
    changed._max_retries = 0
    outcome = changed.execute(**cover_request(tmp_path))
    if quality == "pass":
        assert outcome.status == "ok"
        assert outcome.materials.cover_letter.artifact_id != prior.artifact_id
    else:
        assert outcome.status == "failed_validation"
        assert outcome.materials.cover_letter.artifact_id == prior.artifact_id
        assert Path(prior.path).read_bytes() == data
    conn.close()


def test_parent_cancellation_drains_admitted_peer_before_return(tmp_path, monkeypatch):
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import configure_letter_reviews

    configure_letter_reviews(2)
    both = threading.Barrier(2, timeout=2)
    canceled = threading.Event()
    finished = []

    class CancelModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            title = response_schema["title"]
            if title != "GeneratedProseDraft":
                both.wait()
                canceled.set()
                finished.append(title)
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, case = file_case(tmp_path, monkeypatch, CancelModel())
    parent = threading.get_ident()

    def guard():
        assert threading.get_ident() == parent
        if canceled.is_set():
            raise DeterminationFailure("owner_canceled")

    with pytest.raises(DeterminationFailure, match="owner_canceled"):
        case.execute(**cover_request(tmp_path), commit_guard=guard)
    assert sorted(finished) == ["ArtifactQuality", "ClaimVerification"]
    assert conn.execute("SELECT count(*) FROM job_materials_artifacts WHERE artifact_type='cover_letter'").fetchone()[0] == 0
    conn.close()


def test_wrong_runtime_database_refuses_before_model_spend(tmp_path, monkeypatch):
    from jobctrl import database
    from jobctrl.domain.determinations import DeterminationFailure

    model = Model()
    conn, case = file_case(tmp_path, monkeypatch, model)
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "different.db")
    with pytest.raises(DeterminationFailure, match="review_database_mismatch"):
        case._letter_reviews.review(claim_request={}, quality_request={})
    assert model.calls == []
    conn.close()


@pytest.mark.parametrize("fault,expected_calls", [("provider_unavailable", 1), ("foreign_source_id", 3), ("non_verbatim_quote", 3), ("mismatched_value", 3)])
def test_parallel_leaf_retains_typed_failure_and_bounded_repairs(tmp_path, monkeypatch, fault, expected_calls):
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import configure_letter_reviews

    configure_letter_reviews(1)
    review_calls = []

    class FaultModel(Model):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] == "ClaimVerification":
                review_calls.append(1)
                if fault == "provider_unavailable":
                    raise DeterminationFailure(fault)
                output = super().chat_json(messages, response_schema=response_schema, **kwargs)
                cite = output["lines"][0]["source_evidence"][0]
                if fault == "foreign_source_id":
                    cite["source_id"] = "foreign"
                elif fault == "non_verbatim_quote":
                    cite["quote"] = "Unsupplied span"
                else:
                    cite["exact_values"] = ["999"]
                return output
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    conn, case = file_case(tmp_path, monkeypatch, FaultModel())
    with pytest.raises(DeterminationFailure, match=fault):
        case.execute(**cover_request(tmp_path))
    assert len(review_calls) == expected_calls
    assert conn.execute("SELECT count(*) FROM job_materials_artifacts WHERE artifact_type='cover_letter'").fetchone()[0] == 0
    assert not any(row[0] == "ArtifactQuality" for row in case._llm.calls)
    conn.close()


def test_cancel_after_submission_cancels_queued_peer_and_drains_admitted_call():
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import LetterReviewPool

    pool = LetterReviewPool(1)
    entered, canceled, observed, release = (threading.Event() for _ in range(4))
    peer_calls = []

    def held(stop):
        entered.set()
        assert release.wait(3)
        return "settled"

    def peer(stop):
        stop.check()
        peer_calls.append(1)

    def guard():
        if canceled.is_set():
            observed.set()
            raise DeterminationFailure("owner_canceled")

    with ThreadPoolExecutor(1) as parent:
        pending = parent.submit(pool.review, held, peer, guard)
        assert entered.wait(2)
        canceled.set()
        try:
            assert observed.wait(2)
            assert not pending.done()  # Accounting/cleanup is still owned.
            assert peer_calls == []
        finally:
            release.set()
        with pytest.raises(DeterminationFailure, match="owner_canceled"):
            pending.result(timeout=2)
    assert peer_calls == []
    pool.close()


def test_request_snapshot_cannot_be_changed_by_the_owner_guard(tmp_path, monkeypatch):
    from jobctrl.domain.determinations import Source
    from jobctrl.domain.ports.claim_verification import ArtifactLine
    from jobctrl.infrastructure.determinations import determination_dependencies
    from jobctrl.infrastructure.materials.letter_reviews import ParallelLetterReviews

    model = Model()
    conn, _ = file_case(tmp_path, monkeypatch, model)
    deps = determination_dependencies(conn, tenant_id="local", lane="tailoring", adapter=model)
    line = ArtifactLine(line_id="body:1", text="Frozen text", allowed_evidence_ids=["s"], allowed_requirement_ids=[])
    sources = [Source(source_id="s", text="Frozen evidence")]
    claims = dict(artifact_kind="cover_letter", entity_id="owned", lines=[line], evidence=sources, requirements=[], rubric={})
    quality = dict(artifact_kind="cover_letter", entity_id="owned", lines=[line], sources=sources, rubric={})

    def mutate_originals():
        line.text = "Changed after snapshot"
        sources[0].text = "Changed evidence"

    results = ParallelLetterReviews(tmp_path / "owned.db", deps).review(claim_request=claims, quality_request=quality, execution_guard=mutate_originals)
    assert results.claims[0].verdict == "pass"
    import json
    for _, lane, messages in model.calls:
        assert lane == "tailoring"
        payload = json.loads(messages[1].content)
        assert any(row["text"] == "Frozen text" for row in payload["sources"])
        assert any(row["text"] == "Frozen evidence" for row in payload["sources"])
        assert not any(row["text"].startswith("Changed") for row in payload["sources"])
    conn.close()


def test_shutdown_drains_queued_canceled_futures_without_stranding_coordinator():
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import LetterReviewPool

    pool = LetterReviewPool(1)
    entered, release = threading.Event(), threading.Event()
    peer_calls = []

    def held(stop):
        entered.set()
        assert release.wait(3)
        return "settled"

    with ThreadPoolExecutor(2) as parents:
        pending = parents.submit(pool.review, held, lambda stop: peer_calls.append(1), None)
        assert entered.wait(2)
        closing = parents.submit(pool.close)
        try:
            with pool._lock:
                assert pool._lock.wait_for(lambda: pool._closed, timeout=2)
            with pytest.raises(DeterminationFailure, match="review_canceled"):
                pool.review(held, held, None)
        finally:
            release.set()
        closing.result(timeout=2)
        with pytest.raises(DeterminationFailure, match="review_canceled"):
            pending.result(timeout=2)
    assert peer_calls == []
    assert not pool._groups


def test_global_shutdown_tombstone_prevents_overlapping_pool_generations():
    from concurrent.futures import ThreadPoolExecutor
    from jobctrl.domain.determinations import DeterminationFailure
    from jobctrl.infrastructure.materials.letter_reviews import configure_letter_reviews, close_letter_reviews, _letter_review_pool

    pool = configure_letter_reviews(1)
    entered, release, closing = (threading.Event() for _ in range(3))

    def held(stop):
        entered.set()
        assert release.wait(3)
        return "settled"

    with ThreadPoolExecutor(2) as parents:
        pending = parents.submit(pool.review, held, lambda stop: stop.check(), None)
        assert entered.wait(2)
        original_close = pool.close

        def close():
            closing.set()
            original_close()

        pool.close = close
        finished = parents.submit(close_letter_reviews)
        assert closing.wait(2)
        try:
            with pool._lock:
                assert pool._lock.wait_for(lambda: pool._closed, timeout=2)
            assert _letter_review_pool() is pool
            with pytest.raises(DeterminationFailure, match="review_canceled"):
                configure_letter_reviews(1)
            with pytest.raises(DeterminationFailure, match="review_canceled"):
                _letter_review_pool().review(held, held, None)
        finally:
            release.set()
        finished.result(timeout=2)
        with pytest.raises(DeterminationFailure, match="review_canceled"):
            pending.result(timeout=2)
    # Lazy dispatch stays closed; only explicit new-owner configuration reopens.
    assert _letter_review_pool() is pool
    replacement = configure_letter_reviews(1)
    assert replacement is not pool and pool._drained
    close_letter_reviews()
