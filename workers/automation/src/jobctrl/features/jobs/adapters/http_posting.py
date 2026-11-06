"""Controlled external posting-page protocol in an authenticated owned workspace."""

import json

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.features.jobs.domain.capture import DetailPage
from jobctrl.features.jobs.domain.postings import posting_url, utc_now


class PostingPage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    finalUrl: StrictStr
    title: StrictStr = ""
    html: StrictStr = Field(max_length=2_000_000)
    jsonLd: list = Field(default_factory=list, max_length=100)
    statusCode: StrictInt | None = None
    evidenceComplete: StrictBool = False
    visibilityVerified: StrictBool = False


class HttpPostingFetcher:
    def __init__(self, workspace, endpoint):
        owner = synthetic_boundary(workspace, endpoint)
        if owner is None:
            raise AppError("synthetic_boundary_unowned", "The posting provider requires an owned workspace.", 503)
        self.endpoint, self.token = endpoint, owner["token"]

    def fetch(self, url):
        with httpx.Client(timeout=30, trust_env=False, follow_redirects=False) as client:
            with client.stream(
                "POST", self.endpoint, json={"url": posting_url(url)}, headers={"Authorization": "Bearer " + self.token}
            ) as response:
                if response.status_code != 200:
                    raise AppError("posting_provider_unavailable", "The posting page provider is unavailable.", 502)
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > 2_100_000:
                        raise AppError(
                            "posting_provider_response_too_large",
                            "The posting provider response exceeds its limit.",
                            502,
                        )
        try:
            page = PostingPage.model_validate(json.loads(content))
        except (ValueError, TypeError):
            raise AppError(
                "posting_provider_invalid_response", "The posting provider returned invalid captured-page data.", 502
            ) from None
        return DetailPage(
            url=url,
            final_url=posting_url(page.finalUrl),
            page_title=page.title,
            html=page.html,
            status_html=page.html,
            json_ld=tuple(page.jsonLd),
            status=page.statusCode,
            fetched_at=utc_now(),
            status_evidence_complete=page.evidenceComplete,
            status_visibility_verified=page.visibilityVerified,
        )
