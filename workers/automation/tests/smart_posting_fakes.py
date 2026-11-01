"""Explicit transport and model ports for Smart Extract plumbing checks."""

import json

from jobctrl.domain.enrichment.value_objects import DetailPage
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
from jobctrl.infrastructure.network.url_safety import PublicUrlDecision
from tests.workflow_determination_fakes import ImportModel


class PostingModel(ImportModel):
    def __init__(self, *, location="match", role="specific_role", quality="high"):
        super().__init__()
        self.location, self.role, self.quality = location, role, quality

    def chat_json(self, messages, *, response_schema, **kwargs):
        if response_schema["title"] != "PostingQualification":
            return super().chat_json(messages, response_schema=response_schema, **kwargs)
        data = json.loads(messages[1].content)
        self.calls.append((response_schema["title"], data))
        sources = {s["source_id"]: s["text"] for s in data["sources"]}

        def cite(ident):
            return {"source_id": ident, "quote": sources[ident][:4000], "exact_values": []}

        return {
            "role_title": {
                "value": self.role,
                "citations": [cite("posting:title")],
                "rationale": "Explicit synthetic role decision",
            },
            "description_quality": {
                "confidence": self.quality,
                "citations": [cite("posting:description")],
                "rationale": "Explicit synthetic description decision",
            },
            "location_match": {
                "value": self.location,
                "citations": [cite("saved_locations"), cite("posting:description")],
                "rationale": "Explicit synthetic location decision",
            },
        }


def model_dependencies(conn, model, preflight=lambda: None, tenant_id="local"):
    return dict(
        llm=model,
        repository=SqliteDeterminationRepository(conn),
        tenant_id=tenant_id,
        provider="synthetic",
        model="synthetic-posting",
        lane="discovery",
        preflight=preflight,
    )


def posting_page(url, fields=None):
    fields = fields or {}
    posting = {
        "@type": "JobPosting",
        "url": url,
        "title": fields.get("title") or "Platform Director",
        "hiringOrganization": {"name": fields.get("company") or "Synthetic Labs"},
        "description": fields.get("description") or "Lead the platform team and delivery.",
        "jobLocation": {"address": {"addressLocality": fields.get("location") or "Synthetic place"}},
    }
    return DetailPage(
        url=url,
        final_url=url,
        status=200,
        page_title=posting["title"],
        html="<main>Explicit synthetic posting</main>",
        json_ld=(posting,),
        fetched_at="2026-10-21T12:00:00+00:00",
    )


class PageFetcher:
    def __init__(self, page):
        self.page, self.calls = page, []

    def fetch(self, url):
        self.calls.append(url)
        return self.page


def allow_url(_url):
    return PublicUrlDecision(allowed=True)


def install_smart_posting_models(monkeypatch):
    """Older plumbing tests own synthetic detail pages, never public network calls."""
    from jobctrl.discovery import smartextract

    class SyntheticIntake(SmartPostingIntake):
        def __init__(self, conn, **kwargs):
            self.model = PostingModel()
            kwargs.pop("fetcher", None)
            super().__init__(
                conn,
                **kwargs,
                dependencies=model_dependencies(conn, self.model, tenant_id=str(kwargs.get("tenant_id", "local"))),
                url_validator=allow_url,
            )

        def prepare(self, url, card):
            self.fetcher = PageFetcher(posting_page(url, card))
            return super().prepare(url, card)

    monkeypatch.setattr(smartextract, "SmartPostingIntake", SyntheticIntake)
