"""Controlled external posting-page protocol in an authenticated owned workspace."""

import asyncio

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, model_validator

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.network.async_routes import await_owned
from jobctrl.features.jobs.domain.capture import DetailPage, navigation_observer, report_navigation
from jobctrl.features.jobs.domain.postings import posting_url, utc_now
from jobctrl.features.jobs.adapters.page_fetcher import DetailPageFetchBlocked, DetailPageFetchUnavailable


class CapturedNavigation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    requestedAt: AwareDatetime
    receivedAt: AwareDatetime
    retryAfter: StrictStr | None = None


class PostingPage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    finalUrl: StrictStr
    title: StrictStr = ""
    html: StrictStr = Field(max_length=2_000_000)
    jsonLd: list = Field(default_factory=list, max_length=100)
    statusCode: StrictInt | None = None
    navigation: CapturedNavigation | None = None
    evidenceComplete: StrictBool = False
    visibilityVerified: StrictBool = False

    @model_validator(mode="after")
    def validate_navigation(self):
        if self.navigation and (self.statusCode is None or not 100 <= self.statusCode <= 599
                                or self.navigation.receivedAt < self.navigation.requestedAt):
            raise ValueError("Invalid target navigation response.")
        return self


class HttpPostingFetcher:
    def __init__(self, workspace, endpoint):
        owner = synthetic_boundary(workspace, endpoint)
        if owner is None:
            raise AppError("synthetic_boundary_unowned", "The posting provider requires an owned workspace.", 503)
        self.endpoint, self.token = endpoint, owner["token"]

    def fetch(self, url):
        return asyncio.run(self.fetch_async(url))

    async def fetch_async(self, url):
        return await await_owned(self._capture(url), cancel_on_stop=True)

    async def _capture(self, url):
        async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False) as client:
            async with client.stream(
                "POST", self.endpoint, json={"url": posting_url(url)}, headers={"Authorization": "Bearer " + self.token}
            ) as response:
                # These statuses describe the page provider's transport outcome,
                # not the target posting's availability or captured HTTP status.
                if response.status_code == 429:
                    raise DetailPageFetchBlocked("rate_limited")
                if response.status_code == 503:
                    raise DetailPageFetchUnavailable()
                if response.status_code != 200:
                    raise AppError("posting_provider_unavailable", "The posting page provider is unavailable.", 502)
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 2_100_000:
                        raise AppError(
                            "posting_provider_response_too_large",
                            "The posting provider response exceeds its limit.",
                            502,
                        )
        try:
            page = PostingPage.model_validate_json(bytes(content))
        except (ValueError, TypeError):
            raise AppError(
                "posting_provider_invalid_response", "The posting provider returned invalid captured-page data.", 502
            ) from None
        final_url = posting_url(page.finalUrl)
        if page.navigation:
            report_navigation(navigation_observer.get(), final_url, page.statusCode, page.navigation.requestedAt,
                              page.navigation.receivedAt, page.navigation.retryAfter)
        if page.statusCode == 429:
            raise DetailPageFetchBlocked("rate_limited")
        return DetailPage(
            url=url,
            final_url=final_url,
            page_title=page.title,
            html=page.html,
            status_html=page.html,
            json_ld=tuple(page.jsonLd),
            status=page.statusCode,
            fetched_at=utc_now(),
            status_evidence_complete=page.evidenceComplete,
            status_visibility_verified=page.visibilityVerified,
        )
