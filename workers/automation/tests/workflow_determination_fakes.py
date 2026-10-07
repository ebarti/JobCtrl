"""Configured model ports for synthetic workflow plumbing tests.

Decisions are explicit fixture choices. No adapter guesses a verdict from words.
The semantic-authority tests own rejection and provider-failure scenarios.
"""

import json
import importlib
from tests.compensation_fakes import dependencies
from tests.page_fakes import PageModel, interpreter


def install_page_models(monkeypatch, *, model=None):
    selected = model or PageModel()

    def build(connection=None, **kwargs):
        from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

        return interpreter(selected, SqliteDeterminationRepository(connection) if connection is not None else None)

    for module_name in [
        "jobctrl.enrichment.detail",
        "jobctrl.enrichment.availability",
        "jobctrl.infrastructure.enrichment.page_interpretation",
        "jobctrl.infrastructure.discovery.production_wiring",
        "jobctrl.discovery.job_url_import_workflow",
    ]:
        module = importlib.import_module(module_name)
        if module and hasattr(module, "build_page_interpreter"):
            monkeypatch.setattr(module, "build_page_interpreter", build)
    return selected




class ImportModel:
    """Explicit page/extraction/pay choices at the URL-import entry point."""

    def __init__(self):
        self.page = PageModel()
        self.fields = None
        self.selected_posting = 0
        self.pay = None
        self.calls = []

    def chat_json(self, messages, *, response_schema, **kwargs):
        data = json.loads(messages[1].content)
        self.calls.append((response_schema["title"], data))
        title = response_schema["title"]
        if title in {"PageInterpretation", "DescriptionQuality"}:
            return self.page.chat_json(messages, response_schema=response_schema, **kwargs)
        if title == "PostingExtraction":
            sources = {row["source_id"]: row["text"] for row in data["sources"]}
            selected = str(self.selected_posting)
            values = self.fields or {
                name: sources.get(f"posting:{selected}:{name}", "")
                for name in ["title", "employer", "description", "location", "salary"]
            }
            values = {**values, "application_url": values.get("application_url", sources["page_url"])}
            result = {}
            for name, value in values.items():
                source = next((key for key, text in sources.items() if value and value in text), None)
                result[name] = {
                    "value": value,
                    "citations": [] if source is None else [{"source_id": source, "quote": value, "exact_values": []}],
                    "rationale": "Explicit extraction decision",
                }
            return result
        if title == "PostedPayExtraction":
            source = data["sources"][0]
            if self.pay is not None:
                return {
                    **self.pay,
                    "citations": [
                        {"source_id": source["source_id"], "quote": source["text"][:4000], "exact_values": []}
                    ],
                    "rationale": "Explicit pay interpretation",
                }
            # These tests seed a single structured EUR base-salary observation.
            # Numeric presence binds that explicitly chosen decision mechanically.
            from jobctrl.domain.exact_values import numeric_literals

            amounts = {number for _, number in numeric_literals(source["text"])}
            lower = 100000 if 100000 in amounts else None
            upper = 125000 if 125000 in amounts else None
            return {
                "parse_state": "parsed_range" if lower or upper else "missing",
                "currency": "EUR" if lower or upper else None,
                "period": "year" if lower or upper else "unknown",
                "component": "base_salary" if lower or upper else "unknown",
                "minimum_amount": lower,
                "maximum_amount": upper,
                "confidence": "high" if lower or upper else "none",
                "warnings": [],
                "citations": [{"source_id": source["source_id"], "quote": source["text"][:4000], "exact_values": []}]
                if source["text"]
                else [],
                "rationale": "Explicit pay interpretation",
            }
        raise AssertionError("Unexpected model request: " + title)


def install_import_models(monkeypatch):
    import jobctrl.infrastructure.determinations as infrastructure

    model = ImportModel()
    monkeypatch.setattr(
        infrastructure,
        "determination_dependencies",
        lambda conn, **kw: dependencies(conn, model, kw["lane"], tenant_id=kw["tenant_id"]),
    )
    return model
