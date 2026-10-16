"""Explicit model port for the credential-free extracted-payload smoke only.

The builder passes this bootstrap to the packaged Python with ``-c``. It is
never installed in the payload or selected by a product configuration flag.
All application imports, validation, spend checks and persistence remain real.
"""

import importlib
import json
import runpy
import sys


class DistributionSmokePageModel:
    provider_id = "distribution-smoke"
    model = "explicit-page-fixture"

    def __init__(self, *, availability="active"):
        if availability not in {"active", "closed"}:
            raise ValueError("Unsupported explicit smoke availability")
        self.availability = availability
        self.calls = 0

    def chat_json(self, messages, *, response_schema, **_kwargs):
        title = response_schema["title"]
        if title not in {"PageInterpretation", "DescriptionQuality"}:
            raise RuntimeError("Unexpected distribution smoke model schema: " + title)
        self.calls += 1
        data = json.loads(messages[1].content)
        source_id = "rendered_page" if title == "PageInterpretation" else "description"
        source = next(row for row in data["sources"] if row["source_id"] == source_id)
        citation = {"source_id": source_id, "quote": source["text"][:4000], "exact_values": []}
        rationale = "Explicit synthetic model choice for distribution plumbing verification"
        if title == "DescriptionQuality":
            return {"confidence": "high", "citations": [citation], "rationale": rationale}

        def field(value):
            return {"value": value, "citations": [citation], "rationale": rationale}

        return {
            "availability": field(self.availability),
            "page_kind": field("posting"),
            "access_state": field("clear"),
            "apply_control": field("available"),
        }


def install_smoke_model(model=None):
    infrastructure = importlib.import_module("jobctrl.infrastructure.determinations")
    original = infrastructure.determination_dependencies
    selected = model or DistributionSmokePageModel()

    def dependencies(connection, **kwargs):
        return original(connection, **kwargs, adapter=selected)

    infrastructure.determination_dependencies = dependencies
    # Also handle the page module if another worker import already loaded it.
    page = importlib.import_module("jobctrl.infrastructure.enrichment.page_interpretation")
    page.determination_dependencies = dependencies


if __name__ == "__main__":
    install_smoke_model()
    sys.argv = ["jobctrl", "worker"]
    runpy.run_module("jobctrl", run_name="__main__")
