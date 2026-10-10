"""Structural model doubles exercise authority, not labeled translation evaluation."""
import json
import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.materials.locale_variants import translate, verify, source_lines
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.llm_lanes import current_llm_lane


class LocaleModel:
    provider_id, model = "synthetic", "structural-model"

    def __init__(self, verdict="pass", fault=None, findings=None, edit=None, on_call=None):
        self.verdict, self.fault, self.findings, self.edit = verdict, fault, findings or [], edit
        self.on_call = on_call
        self.calls = []

    def chat_json(self, messages, *, response_schema, **kwargs):
        assert current_llm_lane() == "tailoring"
        data = json.loads(messages[1].content)
        self.calls.append(data)
        if self.on_call:
            self.on_call()
        if self.fault is not None:
            if isinstance(self.fault, Exception):
                raise self.fault
            return self.fault
        originals = [row for row in data["sources"] if row["source_id"].startswith("source:")]
        def citation(row):
            return {"source_id": row["source_id"], "quote": row["text"], "exact_values": []}
        if response_schema["title"] == "LocaleTranslation":
            result = {"lines": [{"line_id": row["source_id"], "text": row["text"], "source": citation(row), "fact_ids": []} for row in originals], "findings": self.findings}
        else:
            by_id = {row["source_id"]: row for row in data["sources"]}
            result = {"verdict": self.verdict, "findings": self.findings, "lines": [{"line_id": row["source_id"], "verdict": self.verdict, "original": citation(row), "translated": citation(by_id["translated:" + row["source_id"]]), "reason": "Explicit structural model verdict"} for row in originals]}
        if self.edit:
            self.edit(result)
        return result


def dependencies(connection, model, preflight=lambda: None):
    return dict(llm=model, repository=SqliteDeterminationRepository(connection), tenant_id="local", provider="synthetic", model="structural-model", lane="tailoring", preflight=preflight)


@pytest.fixture
def connection():
    connection = sqlite3.connect(":memory:")
    create_exact_v14_schema(connection)
    yield connection
    connection.close()


def translation(connection, model, preflight=lambda: None):
    return translate(originals=source_lines("Synthetic Name · Historical Title · 2020\nDelivered 25%"), facts=[Source(source_id="fact", text="Delivered 25%")], protected=["Synthetic Name", "Historical Title"], context={"sourceLocale": "en", "targetLocale": "es"}, entity_id="owned", dependencies=dependencies(connection, model, preflight))


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_opposing_verdicts_control_same_canonical_input(connection, verdict):
    model = LocaleModel(verdict)
    translated, _ = translation(connection, model)
    result, envelope = verify(translation=translated, originals=source_lines("Synthetic Name · Historical Title · 2020\nDelivered 25%"), facts=[Source(source_id="fact", text="Delivered 25%")], context={"sourceLocale": "en", "targetLocale": "es"}, entity_id="owned", dependencies=dependencies(connection, model))
    assert result.verdict == verdict
    assert envelope.result["verdict"] == verdict


def test_preflight_lane_order_and_cache(connection):
    calls = []
    def preflight():
        assert current_llm_lane() == "tailoring"
        calls.append("preflight")
    model = LocaleModel(on_call=lambda: calls.append("model"))
    first = translation(connection, model, preflight)
    assert translation(connection, model, preflight) == first
    assert calls == ["preflight", "model"]


@pytest.mark.parametrize("fault,code", [({}, "schema_violation"), ({"extra": "forbidden"}, "schema_violation"), (json.JSONDecodeError("owned", "", 0), "malformed_json")])
def test_strict_model_failures(connection, fault, code):
    with pytest.raises(DeterminationFailure, match=code):
        translation(connection, LocaleModel(fault=fault))


def test_unavailable_and_budget_denial(connection):
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        translation(connection, None)
    def deny():
        raise RuntimeError("synthetic budget denial")
    model = LocaleModel()
    with pytest.raises(DeterminationFailure, match="budget_denied"):
        translation(connection, model, deny)
    assert model.calls == []


@pytest.mark.parametrize("edit,code", [
    (lambda r: r["lines"][0].update(line_id="foreign"), "foreign_or_missing_line_id"),
    (lambda r: r["lines"][0]["source"].update(source_id="foreign"), "foreign_source_id"),
    (lambda r: r["lines"][0]["source"].update(quote="fabricated"), "non_verbatim_quote"),
    (lambda r: r["lines"][0]["source"].update(exact_values=["202"]), "mismatched_value"),
    (lambda r: r["lines"][1].update(text="Delivered 30%"), "mismatched_value"),
    (lambda r: r["lines"][0].update(text="Renamed Title · 2020"), "protected_field_changed"),
    (lambda r: r["lines"][0].update(fact_ids=["foreign"]), "foreign_source_id"),
    (lambda r: r.update(findings=[{"kind": "unknown", "line_id": "source:0", "source": r["lines"][0]["source"], "detail": "Explicit finding"}]), "schema_violation"),
    (lambda r: r["lines"][0].update(extra="unexpected"), "schema_violation"),
])
def test_structural_source_and_value_fences(connection, edit, code):
    with pytest.raises(DeterminationFailure, match=code):
        translation(connection, LocaleModel(edit=edit))
