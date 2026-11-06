"""Controlled external acquisition in explicitly owned synthetic workspaces.

The control returns an HTTP page response, not a candidate, contact
or research result. All policy, parsing, model judgment, provenance and canonical
actions continue through their ordinary application paths.
"""

from __future__ import annotations

import json

import httpx

from jobctrl.app.synthetic import synthetic_boundary

from .fetcher import _visible_text
from .research import ResearchPageFetch
from .source_policy import ResearchSourceDecision


class ControlledPublicPageFetcher:
    def __init__(self, *, workspace, endpoint: str, policy):
        self.workspace, self.endpoint, self.policy = workspace, endpoint, policy
        synthetic_boundary(workspace, endpoint)

    def fetch(self, url: str) -> ResearchPageFetch:
        boundary = synthetic_boundary(self.workspace, self.endpoint)
        if not boundary:
            raise RuntimeError("Controlled page acquisition requires an owned synthetic workspace.")
        if self.policy.authorize(category="public_web_page", url=url) is not ResearchSourceDecision.ALLOWED:
            return ResearchPageFetch(outcome="rejected", final_url=url)
        try:
            with httpx.Client(trust_env=False, follow_redirects=False, timeout=20) as client:
                with client.stream("POST", self.endpoint, json={"operation": "contacts.page", "url": url, "method": "GET"},
                                   headers={"Authorization": "Bearer " + boundary["token"]}) as response:
                    response.raise_for_status()
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > 2_100_000:
                            return ResearchPageFetch(outcome="response_too_large", final_url=url)
                    page = json.loads(content)
            if not isinstance(page, dict) or type(page.get("status")) is not int or not isinstance(page.get("body"), str):
                return ResearchPageFetch(outcome="transport_failed", final_url=url)
            final_url = page.get("final_url", url)
            if not isinstance(final_url, str) or self.policy.authorize(category="public_web_page", url=final_url) is not ResearchSourceDecision.ALLOWED:
                return ResearchPageFetch(outcome="rejected", final_url=url)
            # Match production acquisition: no robots request/evaluation is
            # performed by the neutral gateway. Provider metadata cannot add a
            # synthetic-only access decision absent from the real fetch path.
            status = page["status"]
            if status == 429:
                return ResearchPageFetch(outcome="rate_limited", final_url=final_url, status=status)
            if status < 200 or status >= 300:
                return ResearchPageFetch(outcome="http_error", final_url=final_url, status=status)
            encoded = page["body"].encode()
            if len(encoded) > 2_000_000:
                return ResearchPageFetch(outcome="response_too_large", final_url=final_url, status=status)
            return ResearchPageFetch(outcome="allowed", text=_visible_text(encoded), final_url=final_url, status=status)
        except httpx.TimeoutException:
            return ResearchPageFetch(outcome="acquisition_timeout", final_url=url)
        except (httpx.HTTPError, ValueError, UnicodeError):
            return ResearchPageFetch(outcome="transport_failed", final_url=url)
