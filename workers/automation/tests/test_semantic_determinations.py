"""Model authority and mechanical contracts; no semantic labels or replay corpus."""

from __future__ import annotations

import json
from threading import RLock
from typing import Literal

import pytest
from pydantic import Field

from jobctrl.domain.determinations import (
    Citation,
    DeterminationEnvelope,
    DeterminationFailure,
    DeterminationModel,
    Source,
    determine,
)
from jobctrl.llm_lanes import current_llm_lane


class Decision(DeterminationModel):
    verdict: Literal["accept", "reject"]
    citations: list[Citation] = Field(min_length=1)


class Repository:
    def __init__(self) -> None:
        self._lock = RLock()
        self.rows: dict[tuple[str, str], DeterminationEnvelope] = {}
        self.bindings = {}

    def lock(self, *args):
        return self._lock

    def record_state(self, **kwargs):
        pass

    def find(self, tenant_id: str, determination_id: str) -> DeterminationEnvelope | None:
        return self.rows.get((tenant_id, determination_id))

    def bind(self, *, tenant_id, entity_kind, entity_id, entity_version, determination_kind, determination_id):
        assert (tenant_id, determination_id) in self.rows
        self.bindings[(tenant_id, entity_kind, entity_id, entity_version, determination_kind)] = determination_id

    def save(self, envelope: DeterminationEnvelope) -> None:
        self.rows[(envelope.tenant_id, envelope.determination_id)] = envelope


class Model:
    def __init__(self, output: object) -> None:
        self.output = output
        self.calls: list[object] = []

    def chat_json(self, messages, **kwargs):
        assert current_llm_lane() == "interview"
        self.calls.append((messages, kwargs))
        if isinstance(self.output, Exception):
            raise self.output
        return self.output


def response(verdict: str = "accept") -> dict:
    return {
        "verdict": verdict,
        "citations": [{"source_id": "canonical:1", "quote": "value 10%", "exact_values": ["10%"]}],
    }


def call(adapter, repository, preflight=lambda: None, **overrides):
    arguments = dict(
        kind="test",
        schema=Decision,
        schema_version="1",
        prompt_version="1",
        instruction="Determine the result.",
        sources=[Source(source_id="canonical:1", text="value 10%")],
        context={"entity_version": 1},
        tenant_id="synthetic",
        entity_id="synthetic:1",
        provider="fake",
        model="fake",
        lane="interview",
        llm=adapter,
        repository=repository,
        preflight=preflight,
    )
    arguments.update(overrides)
    return determine(**arguments)


def test_same_sources_bind_opposite_valid_model_decisions() -> None:
    for verdict in ("accept", "reject"):
        model = Model(response(verdict))
        result, envelope = call(model, Repository())
        assert result.verdict == verdict
        assert envelope.result["verdict"] == verdict
        assert len(model.calls) == 1


def test_canonical_prompt_lane_preflight_and_persisted_cache() -> None:
    repository = Repository()
    model = Model(response())
    preflight_calls = []

    def preflight():
        assert current_llm_lane() == "interview"
        assert model.calls == []
        preflight_calls.append(True)

    result, envelope = call(model, repository, preflight)
    assert json.loads(model.calls[0][0][1].content) == {
        "sources": [{"source_id": "canonical:1", "text": "value 10%"}],
        "context": {"entity_version": 1},
    }
    assert call(model, repository, preflight) == (result, envelope)
    assert len(model.calls) == len(preflight_calls) == 1
    assert repository.find("different-tenant", envelope.determination_id) is None


@pytest.mark.parametrize("change", ["entity_id", "prompt_version", "schema_version", "model", "provider"])
def test_versions_identity_and_provider_changes_do_not_reuse_a_result(change: str) -> None:
    repository = Repository()
    model = Model(response())
    first = call(model, repository)[1]
    second = call(model, repository, **{change: "different"})[1]
    assert first.determination_id != second.determination_id
    assert len(model.calls) == 2


@pytest.mark.parametrize(
    "output,code",
    [
        (json.JSONDecodeError("invalid", "", 0), "malformed_json"),
        (RuntimeError("private provider text"), "provider_error"),
        ({**response(), "extra": "private"}, "schema_violation"),
        ({**response(), "verdict": "foreign-enum"}, "schema_violation"),
        ({**response(), "citations": [{"source_id": "foreign", "quote": "value 10%"}]}, "foreign_source_id"),
        (
            {**response(), "citations": [{"source_id": "canonical:1", "quote": "private invented quote"}]},
            "non_verbatim_quote",
        ),
        (
            {**response(), "citations": [{"source_id": "canonical:1", "quote": "value 10%", "exact_values": ["11%"]}]},
            "mismatched_value",
        ),
        (
            {**response(), "citations": [{"source_id": "canonical:1", "quote": "value 10%", "exact_values": ["1"]}]},
            "mismatched_value",
        ),
    ],
)
def test_distinct_invalid_results_have_no_fallback_or_accepted_state_change(output, code: str) -> None:
    repository = Repository()
    accepted = call(Model(response()), repository)[1]
    before = dict(repository.rows)
    with pytest.raises(DeterminationFailure) as error:
        call(Model(output), repository, entity_id="synthetic:2")
    assert error.value.code == code
    assert "private" not in str(error.value)
    assert repository.rows == before
    assert repository.find("synthetic", accepted.determination_id) == accepted


def test_unavailable_and_budget_denial_are_distinct_and_do_not_call() -> None:
    repository = Repository()
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        call(None, repository)
    model = Model(response())

    def denied():
        raise RuntimeError("private budget context")

    with pytest.raises(DeterminationFailure, match="budget_denied"):
        call(model, repository, denied)
    assert model.calls == []
    assert repository.rows == {}


def test_concurrent_identical_requests_make_one_paid_call():
    from concurrent.futures import ThreadPoolExecutor

    repository, model = Repository(), Model(response())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: call(model, repository), range(2)))
    assert results[0] == results[1]
    assert len(model.calls) == 1
