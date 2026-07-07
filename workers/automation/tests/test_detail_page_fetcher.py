"""Phase 7 / S-26: ``DetailPageFetcherPort`` contract.

The port-level test exercises a fake fetcher that returns a known
``DetailPage`` value object — proving the use cases bind to the
abstract contract rather than the concrete Playwright adapter.

The Playwright adapter itself is not tested here (it requires a live
browser); the abstract port + use case wiring is what the test
verifies.
"""

from __future__ import annotations

from jobctl.domain.enrichment import DetailPage
from jobctl.domain.ports.enrichment import DetailPageFetcherPort


class FakeFetcher(DetailPageFetcherPort):
    """In-memory ``DetailPageFetcherPort`` returning canned pages."""

    def __init__(self, page: DetailPage) -> None:
        self._page = page
        self.calls: list[str] = []

    def fetch(self, url: str) -> DetailPage:
        self.calls.append(url)
        return self._page


def test_fake_fetcher_returns_canned_detail_page() -> None:
    canned = DetailPage(
        url="https://x",
        final_url="https://x/final",
        page_title="Title",
        html="<p>x</p>",
        json_ld=({"@type": "JobPosting", "description": "x"},),
        status=200,
        fetched_at="2026-05-01T00:00:00+00:00",
    )
    fetcher = FakeFetcher(canned)
    out = fetcher.fetch("https://x")
    assert out is canned
    assert fetcher.calls == ["https://x"]


def test_fetcher_respects_port_signature() -> None:
    """Check that the FakeFetcher fulfils the DetailPageFetcherPort
    structural protocol without runtime errors."""
    fetcher: DetailPageFetcherPort = FakeFetcher(
        DetailPage(url="https://x", html="<p>x</p>")
    )
    page = fetcher.fetch("https://x")
    assert isinstance(page, DetailPage)
