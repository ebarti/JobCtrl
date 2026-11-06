"""Existing paced, bounded and public-destination-guarded feed transport.

Create a fresh client per source and refresh; pass its methods to adapters.
Source access declarations are checked by adapters before any request.
"""

from __future__ import annotations

from typing import Any

from jobctrl.network import (
    GatewayHttpClient,
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    default_honest_user_agent,
)
from jobctrl.network.policy import SourcePolicy, SourcePolicyMethod

COMPENSATION_FEED_POLICY = SourcePolicy(
    policy_id="compensation_feed",
    allowed_methods=(SourcePolicyMethod.FEED, SourcePolicyMethod.STATIC_PAGE),
    max_requests_per_run=100,
)


def compensation_feed_client(
    source_id: str, *, gateway: PolitenessGateway | None = None, run_id: str | None = None, opener: Any | None = None
) -> GatewayHttpClient:
    # Passing an explicit identity avoids the legacy gateway's implicit global
    # configuration read. Hosts may inject a gateway with their chosen identity.
    active = gateway if gateway is not None else PolitenessGateway(user_agent=default_honest_user_agent())
    session = PolitenessSession(
        active,
        policy=COMPENSATION_FEED_POLICY,
        budget=active.new_run_budget(COMPENSATION_FEED_POLICY.max_requests_per_run),
        context=PolitenessSourceContext(
            stage="compensation",
            source_id=source_id,
            source_role="compensation_feed",
            adapter="compensation_feed",
            run_id=run_id,
        ),
    )
    return GatewayHttpClient(session, opener=opener)


def licensed_text_fetcher(client: GatewayHttpClient):
    def fetch(url: str, token: str | None) -> str | None:
        return client.fetch_text(url, extra_headers={"Authorization": f"Bearer {token}"} if token else None)

    return fetch


def levels_public_text_fetcher(client: GatewayHttpClient):
    def fetch(url: str) -> str | None:
        return client.fetch_text(url, extra_headers={"Accept-Encoding": "gzip"})

    return fetch
