"""Structural model seams; verdicts, not language labels, own semantic outcomes."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.locale_variants import source_lines, translate_document
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from tests.test_artifact_determinations import Model, connection


class LocaleModel(Model):
    def __init__(self, *, terms="pass", fault=None, concerns=None, mutate=None, **kwargs):
        super().__init__(**kwargs)
        self.terms, self.locale_fault, self.concerns, self.mutate = terms, fault, concerns or [], mutate

    def chat_json(self, messages, *, response_schema, **kwargs):
        title = response_schema["title"]
        if title not in {"LocaleTranslation", "LocaleTerminologyReview"}:
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
        from jobctrl.llm_lanes import current_llm_lane

        self.calls.append((title, current_llm_lane(), messages))
        if self.locale_fault:
            raise self.locale_fault
        data = json.loads(messages[1].content)
        lines = data["context"]["lines"]
        if title == "LocaleTerminologyReview":
            return {
                "verdict": self.terms,
                "concerns": self.concerns,
                "rationale": "Independent structural test decision",
            }
        result = {
            "supported": True,
            "lines": [
                {
                    "line_id": row["line_id"],
                    "text": row["text"],
                    "source": {"source_id": row["line_id"], "quote": row["text"], "exact_values": []},
                }
                for row in lines
            ],
            "concerns": [],
            "rationale": "Structural translation double",
        }
        if self.mutate:
            self.mutate(result)
        return result


def dependencies(conn, model, preflight=lambda: None):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id="local",
        provider="fake",
        model="structural",
        lane="tailoring",
        preflight=preflight,
    )


def binding():
    profile = {"personal": {"full_name": "Synthetic Person"}, "resume": {"title": "Historical title"}}
    return dict(
        variant_id="owned-variant",
        kind="resume",
        text="Synthetic Person\nHistorical title\nCanonical value 42",
        profile_json=json.dumps(profile),
        source_locale="en",
        target_locale="es",
    ), profile


@pytest.mark.parametrize("owner", ["terms", "verdict", "quality"])
def test_opposing_valid_decisions_for_identical_sources_own_acceptance(owner):
    outputs = []
    for verdict in ("pass", "fail"):
        bound, profile = binding()
        model = LocaleModel(**{owner: verdict})
        result = translate_document(
            binding=bound, profile=profile, dependencies=dependencies(connection(), model), fence=lambda: None
        )
        outputs.append(result["gate_passed"])
        assert len(result["determinations"]) == 4
        assert all(call[1] == "tailoring" for call in model.calls)
    assert outputs == [True, False]


@pytest.mark.parametrize(
    "fault,code",
    [(RuntimeError("provider"), "provider_error"), (json.JSONDecodeError("invalid", "", 0), "malformed_json")],
)
def test_provider_and_json_failure_have_no_fallback(fault, code):
    bound, profile = binding()
    with pytest.raises(DeterminationFailure, match=code):
        translate_document(
            binding=bound,
            profile=profile,
            dependencies=dependencies(connection(), LocaleModel(fault=fault)),
            fence=lambda: None,
        )


def test_spend_preflight_and_cache_reuse():
    bound, profile = binding()
    conn, model, calls = connection(), LocaleModel(), []
    deps = dependencies(conn, model, lambda: calls.append(True))
    first = translate_document(binding=bound, profile=profile, dependencies=deps, fence=lambda: None)
    assert len(calls) == len(model.calls) == 4
    second = translate_document(binding=bound, profile=profile, dependencies=deps, fence=lambda: None)
    assert first == second
    assert len(calls) == len(model.calls) == 4
    with pytest.raises(DeterminationFailure, match="provider_unavailable"):
        translate_document(
            binding={**bound, "variant_id": "unavailable"},
            profile=profile,
            dependencies=dependencies(conn, None),
            fence=lambda: None,
        )


def test_budget_denied_before_model():
    def deny():
        raise RuntimeError("denied")

    bound, profile = binding()
    model = LocaleModel()
    with pytest.raises(DeterminationFailure, match="budget_denied"):
        translate_document(
            binding=bound, profile=profile, dependencies=dependencies(connection(), model, deny), fence=lambda: None
        )
    assert model.calls == []


@pytest.mark.parametrize(
    "mutation,code",
    [
        (lambda result: result["lines"].pop(), "foreign_or_missing_line_id"),
        (lambda result: result["lines"].append(deepcopy(result["lines"][0])), "foreign_or_missing_line_id"),
        (lambda result: result["lines"][0]["source"].update(source_id="foreign"), "foreign_source_id"),
        (lambda result: result["lines"][0]["source"].update(quote="fabricated"), "non_verbatim_quote"),
        (lambda result: result["lines"][1].update(text="Changed title"), "protected_value_changed"),
        (lambda result: result["lines"][2].update(text="Canonical value 43"), "protected_value_changed"),
        (lambda result: result["lines"][2].update(text="Canonical value 42 and 43"), "mismatched_value"),
        (lambda result: result.update(extra=True), "schema_violation"),
    ],
)
def test_structural_translation_boundaries(mutation, code):
    bound, profile = binding()
    with pytest.raises(DeterminationFailure, match=code):
        translate_document(
            binding=bound,
            profile=profile,
            dependencies=dependencies(connection(), LocaleModel(mutate=mutation)),
            fence=lambda: None,
        )


def test_unsupported_locale_is_explicit_refusal():
    def refuse(result):
        result.update(
            supported=False,
            lines=[],
            concerns=[
                {
                    "kind": "unsupported_locale",
                    "source": result["lines"][0]["source"],
                    "explanation": "Model explicitly refuses selected locale",
                }
            ],
        )

    bound, profile = binding()
    model = LocaleModel(mutate=refuse)
    result = translate_document(
        binding=bound, profile=profile, dependencies=dependencies(connection(), model), fence=lambda: None
    )
    assert result["status"] == "refused" and not result["gate_passed"]
    assert len(model.calls) == 1


def test_supported_translation_cannot_silently_carry_an_unsupported_locale():
    def contradictory(result):
        result["concerns"] = [
            {
                "kind": "unsupported_locale",
                "source": result["lines"][0]["source"],
                "explanation": "Explicit contradictory structural refusal",
            }
        ]

    bound, profile = binding()
    with pytest.raises(DeterminationFailure, match="invalid_locale_refusal"):
        translate_document(
            binding=bound,
            profile=profile,
            dependencies=dependencies(connection(), LocaleModel(mutate=contradictory)),
            fence=lambda: None,
        )


@pytest.mark.parametrize("kind", ["missing_term", "ambiguous_credential"])
def test_preserved_ambiguity_is_visible_without_asserted_equivalence(kind):
    bound, profile = binding()
    concerns = [
        {
            "kind": kind,
            "source": {"source_id": "source:1", "quote": "Historical title", "exact_values": []},
            "explanation": "Original wording retained; no equivalence asserted",
        }
    ]
    result = translate_document(
        binding=bound,
        profile=profile,
        dependencies=dependencies(connection(), LocaleModel(concerns=concerns)),
        fence=lambda: None,
    )
    assert result["concerns"] == concerns and result["gate_passed"]
    assert result["lines"][1]["text"] == "Historical title"


def test_unicode_and_blank_line_inventory_is_literal():
    assert source_lines("Éloï Synthetic\n\nLiteral 42\n", {}) == [
        {"line_id": "source:0", "text": "Éloï Synthetic", "protected": []},
        {"line_id": "source:2", "text": "Literal 42", "protected": ["42"]},
    ]
