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

    def __init__(self, *, availability="active", page_kind="posting", access_state="clear"):
        if availability not in {"active", "closed"}:
            raise ValueError("Unsupported explicit smoke availability")
        self.availability = availability
        self.page_kind = page_kind
        self.access_state = access_state
        self.calls = 0
        self.schemas = []

    def chat_json(self, messages, *, response_schema, **_kwargs):
        title = response_schema["title"]
        if title not in {"PageInterpretation", "PostingSelectionExtraction", "DescriptionQuality"}:
            raise RuntimeError("Unexpected distribution smoke model schema: " + title)
        self.calls += 1
        self.schemas.append(title)
        data = json.loads(messages[1].content)
        rationale = "Explicit synthetic model choice for distribution plumbing verification"
        if title == "PostingSelectionExtraction":
            sources = {row["source_id"]: row["text"] for row in data["sources"]}
            if sources.get("page_url") != "https://offline.fixture.invalid/jobs/distribution-smoke":
                raise RuntimeError("Unexpected distribution smoke posting URL")

            def selected_field(source_id):
                value = sources.get(source_id, "")
                return {"value": value, "rationale": rationale, "citations": [
                    {"source_id": source_id, "quote": value, "exact_values": []}
                ] if value else []}

            lines = next(row["lines"] for row in data["context"]["line_inventory"]
                         if row["source_id"] == "posting:0:description")
            if not lines or not sources.get("posting:0:title"):
                raise RuntimeError("Distribution smoke posting sources are incomplete")
            return {
                "title": selected_field("posting:0:title"),
                "employer": selected_field("posting:0:employer"),
                "location": selected_field("posting:0:location"),
                "salary": selected_field("posting:0:salary"),
                "application_url": selected_field("page_url"),
                "description": {"source_id": "posting:0:description", "first_line_id": lines[0]["line_id"],
                                "last_line_id": lines[-1]["line_id"], "rationale": rationale},
                "source_origins": [],
            }
        source_id = "rendered_page" if title == "PageInterpretation" else "description"
        source = next(row for row in data["sources"] if row["source_id"] == source_id)
        citation = {"source_id": source_id, "quote": source["text"][:4000], "exact_values": []}
        if title == "DescriptionQuality":
            return {"confidence": "high", "citations": [citation], "rationale": rationale}

        def field(value):
            return {"value": value, "citations": [citation], "rationale": rationale}

        return {
            "availability": field("unknown" if self.access_state in {"login_required", "challenge"} else self.availability),
            "page_kind": field(self.page_kind),
            "access_state": field(self.access_state),
            "apply_control": field("available"),
        }


def install_smoke_model(model=None):
    infrastructure = importlib.import_module("jobctrl.infrastructure.determinations")
    original = infrastructure.determination_dependencies
    selected = model or DistributionSmokePageModel()

    def dependencies(connection, **kwargs):
        return original(connection, **kwargs, adapter=selected)

    # Bind only the page and manual-capture selection ports used by the smoke.
    page = importlib.import_module("jobctrl.infrastructure.enrichment.page_interpretation")
    page.determination_dependencies = dependencies
    discovery = importlib.import_module("jobctrl.infrastructure.discovery.production_wiring")
    extractor = importlib.import_module("jobctrl.domain.enrichment.page_interpretation").ModelPagePostingExtractor

    def posting_extractor(connection, tenant_id):
        return extractor(**dependencies(connection, tenant_id=str(tenant_id), lane="enrichment"))

    discovery.build_manual_capture_posting_extractor = posting_extractor


if __name__ == "__main__":
    install_smoke_model()
    sys.argv = ["jobctrl", "worker"]
    runpy.run_module("jobctrl", run_name="__main__")
