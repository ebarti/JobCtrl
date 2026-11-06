"""Owned public-page acquisition adapter; no feature policy decisions live here."""

from __future__ import annotations

import asyncio
import threading

from jobctrl.features.companies.domain import failure
from jobctrl.features.companies.fetcher import company_briefing_fetcher


class PublicPageAcquirer:
    def __init__(self, *, discovery=None, fetcher_factory=company_briefing_fetcher):
        self._discovery, self._fetcher_factory = discovery, fetcher_factory

    async def pages(self, urls, *, cancelled):
        cancel_event = threading.Event()
        try:
            options = {"cancel_event": cancel_event}
            if self._discovery is not None:
                from jobctrl.network import resolve_request_headers

                settings = self._discovery.get_settings()["settings"]
                options["request_headers"] = resolve_request_headers({"crawl_user_agent": {
                    "product": settings["crawlUserAgentProduct"], "contact": settings["crawlUserAgentContact"],
                    "use_browser_headers": settings["useBrowserHeaders"],
                }})
            fetcher = self._fetcher_factory(urls, **options)
            for url in urls:
                task = asyncio.create_task(asyncio.to_thread(fetcher.fetch, url))
                try:
                    while not task.done():
                        if cancelled():
                            cancel_event.set()
                            task.cancel()
                            raise failure("briefing_cancelled", 409)
                        await asyncio.wait({task}, timeout=0.05)
                    yield url, await task
                except asyncio.CancelledError:
                    cancel_event.set()
                    task.cancel()
                    raise
        finally:
            cancel_event.set()
