"""Shared network-layer adapters.

These adapters are used by multiple bounded contexts (Discovery,
Enrichment) and live outside any single context's tree to avoid the
pre-Phase-7 cross-context import smell where Enrichment imported from
``discovery/jobspy``.

The crawl-politeness gateway (R10) is the sanctioned single choke point every
outbound fetch routes through: robots.txt compliance, per-host rate limiting +
concurrency, per-run request budgets, and honest-UA stamping.
"""

from jobhunter.infrastructure.network.http_client import (
    GatewayHttpClient,
    build_opener,
    parse_retry_after,
)
from jobhunter.infrastructure.network.politeness import (
    POLITENESS_ATTEMPT_KIND,
    POLITENESS_BLOCKED_OUTCOME,
    PolitenessGateway,
    PolitenessSession,
    PolitenessSourceContext,
    RunBudgetCounter,
    record_politeness_outcome,
    resolve_honest_user_agent,
)
from jobhunter.infrastructure.network.proxy import (
    ProxyConfig,
    parse_proxy,
)
from jobhunter.infrastructure.network.rate_limiter import (
    HostRateLimiter,
    get_shared_rate_limiter,
)
from jobhunter.infrastructure.network.robots import RobotsCache

__all__ = [
    "ProxyConfig",
    "parse_proxy",
    "PolitenessGateway",
    "PolitenessSession",
    "PolitenessSourceContext",
    "RunBudgetCounter",
    "record_politeness_outcome",
    "resolve_honest_user_agent",
    "POLITENESS_ATTEMPT_KIND",
    "POLITENESS_BLOCKED_OUTCOME",
    "HostRateLimiter",
    "get_shared_rate_limiter",
    "RobotsCache",
    "GatewayHttpClient",
    "build_opener",
    "parse_retry_after",
]
