"""Explicit page decisions for transport and workflow tests."""

import json
from jobctrl.domain.enrichment.page_interpretation import ModelPageInterpreter
from tests.test_semantic_determinations import Repository


class PageModel:
    def __init__(self, availability="active", access="clear", quality="high", page_kind="posting"):
        self.availability, self.access, self.quality, self.calls = availability, access, quality, []
        self.page_kind = page_kind

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = json.loads(messages[1].content)
        self.calls.append(data)
        source = next(source for source in data["sources"] if source["text"].strip())
        citation = {"source_id": source["source_id"], "quote": source["text"][:4000], "exact_values": []}

        def field(value):
            return {
                "value": value,
                "citations": [citation],
                "rationale": "Explicit synthetic model decision",
            }

        if response_schema["title"] == "DescriptionQuality":
            return {"confidence": self.quality, "citations": [citation], "rationale": "Explicit quality judgment"}
        return {
            "availability": field(self.availability),
            "access_state": field(self.access),
            "page_kind": field(self.page_kind),
            "apply_control": field("available"),
        }


def interpreter(model=None, repository=None):
    return ModelPageInterpreter(
        llm=model or PageModel(),
        repository=repository or Repository(),
        tenant_id="local",
        provider="synthetic",
        model="synthetic",
        lane="enrichment",
        preflight=lambda: None,
    )
