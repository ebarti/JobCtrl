"""Model-owned selection with mechanically exact posting text; no semantic grading."""

import copy
import json

import pytest

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.enrichment.page_interpretation import ModelPagePostingExtractor
from tests.test_semantic_determinations import Repository


class SelectionModel:
    def __init__(self, last_line=2, invalid=None):
        self.last_line = last_line
        self.invalid = invalid
        self.calls = []
        self.responses = []

    def chat_json(self, messages, **kwargs):
        data = json.loads(messages[1].content)
        self.calls.append(data)
        sources = {source["source_id"]: source["text"] for source in data["sources"]}

        def field(value, source="title"):
            return {
                "value": value,
                "citations": [{"source_id": source, "quote": value, "exact_values": []}] if value else [],
                "rationale": "Explicit synthetic field selection",
            }

        lines = next(row["lines"] for row in data["context"]["line_inventory"] if row["source_id"] == "description")
        selection = {
            "source_id": "description",
            "first_line_id": lines[0]["line_id"],
            "last_line_id": lines[self.last_line]["line_id"],
            "rationale": "Explicit synthetic source range",
        }
        if self.invalid == "foreign":
            selection["source_id"] = "foreign"
        elif self.invalid == "reversed":
            selection["first_line_id"], selection["last_line_id"] = selection["last_line_id"], selection["first_line_id"]
        elif self.invalid == "cross_source":
            selection["last_line_id"] = data["context"]["line_inventory"][0]["lines"][0]["line_id"]
        elif self.invalid == "unknown_line":
            selection["first_line_id"] = "unrecorded-line"
        result = {
            "title": field(sources["title"]), "employer": field(""),
            "description": selection, "location": field(""), "salary": field(""),
            "application_url": field(""),
        }
        if self.invalid == "short_field_quote":
            result["title"]["citations"][0]["quote"] = "Unrecorded title"
        if self.invalid == "foreign_origins":
            result["source_origins"] = [{"source_id": "description", "url": "https://foreign.example/"}]
        self.responses.append(copy.deepcopy(result))
        return result


def extract(model, *, repository=None, description="Role overview.\r\nBuild systems.\r\nLead engineers.\r\nAdditional context."):
    repository = repository or Repository()
    extractor = ModelPagePostingExtractor(
        llm=model, repository=repository, tenant_id="synthetic",
        provider="synthetic", model="synthetic", lane="enrichment", preflight=lambda: None,
    )
    return extractor.extract(entity_id="synthetic:posting", sources=[
        Source(source_id="title", text="Platform lead"),
        Source(source_id="description", text=description),
    ])


def test_model_range_controls_exact_description_and_preserves_line_endings():
    first, receipt = extract(SelectionModel(last_line=1))
    second, _ = extract(SelectionModel(last_line=2))

    assert first.description.value == "Role overview.\r\nBuild systems."
    assert second.description.value == "Role overview.\r\nBuild systems.\r\nLead engineers."
    assert first.description.citations[0].quote == first.description.value
    assert receipt.schema_version == "4"
    assert {key: receipt.result["description"][key] for key in ["source_id", "first_line_id", "last_line_id", "rationale"]} == {
        "source_id": "description", "first_line_id": "line:1:0", "last_line_id": "line:1:1",
        "rationale": "Explicit synthetic source range",
    }


def test_long_description_is_copied_without_retyping_or_expanding_citation_limits():
    description = "First line.\n" + "A" * 6000 + "\nFinal line."
    model = SelectionModel(last_line=2)
    result, receipt = extract(model, description=description)

    assert result.description.value == description
    assert len(result.description.citations[0].quote) == 4000
    assert result.description.citations[0].quote == description[:4000]
    assert "value" not in model.responses[0]["description"]
    assert receipt.result["description"]["value"] == description
    assert receipt.result["description"]["citations"][0]["quote"] == description[:4000]


@pytest.mark.parametrize("invalid", ["foreign", "reversed", "cross_source", "unknown_line", "short_field_quote", "foreign_origins"])
def test_invalid_selection_or_quote_cannot_replace_prior_accepted_receipt(invalid):
    repository = Repository()
    extract(SelectionModel(), repository=repository)
    accepted = copy.deepcopy(repository.rows)
    model = SelectionModel(invalid=invalid)

    with pytest.raises(DeterminationFailure) as error:
        extract(model, repository=repository, description="Changed overview.\nBuild systems.\nLead engineers.")

    assert error.value.code == ("non_verbatim_quote" if invalid == "short_field_quote" else "field_binding_invalid")
    assert len(model.calls) == 3
    assert repository.rows == accepted


def test_unchanged_source_selection_reuses_its_recorded_receipt():
    model, repository = SelectionModel(), Repository()
    result, receipt = extract(model, repository=repository)
    again, cached = extract(model, repository=repository)
    assert len(model.calls) == 1
    assert result == again
    assert receipt.determination_id == cached.determination_id


def test_incomplete_declared_source_origins_fail_before_model_work():
    model = SelectionModel()
    extractor = ModelPagePostingExtractor(
        llm=model, repository=Repository(), tenant_id="synthetic", provider="synthetic", model="synthetic",
        lane="enrichment", preflight=lambda: None,
    )
    with pytest.raises(DeterminationFailure, match="source_binding_invalid"):
        extractor.extract(
            entity_id="synthetic:posting", sources=[Source(source_id="description", text="Canonical text")],
            source_urls={},
        )
    assert model.calls == []
