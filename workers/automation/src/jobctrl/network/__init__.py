"""Neutral public-acquisition I/O with explicit identity and no global storage."""

from .http_client import GatewayHttpClient, build_opener, parse_retry_after
from .identity import resolve_honest_user_agent, resolve_request_headers
from .politeness import PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter
from .ports import default_honest_user_agent
from .proxy import ProxyConfig, parse_proxy
from .public_http import (
    NoRedirectHandler,
    PublicDestinationHTTPHandler,
    PublicDestinationHTTPSHandler,
    PublicDestinationRedirectHandler,
    UnsafePublicDestinationError,
    build_public_http_opener,
    create_public_connection,
    resolve_public_addrinfos,
)
from .rate_limiter import HostRateLimiter, get_shared_rate_limiter
from .url_safety import PublicHttpUrlRouteGuard, PublicUrlDecision, RouteFulfillment, validate_public_http_url

__all__ = [
    "GatewayHttpClient", "build_opener", "parse_retry_after", "resolve_honest_user_agent", "resolve_request_headers",
    "PolitenessGateway", "PolitenessSession", "PolitenessSourceContext", "RunBudgetCounter", "default_honest_user_agent",
    "ProxyConfig", "parse_proxy", "NoRedirectHandler", "PublicDestinationHTTPHandler", "PublicDestinationHTTPSHandler",
    "PublicDestinationRedirectHandler", "UnsafePublicDestinationError", "build_public_http_opener", "create_public_connection",
    "resolve_public_addrinfos", "HostRateLimiter", "get_shared_rate_limiter", "PublicHttpUrlRouteGuard", "PublicUrlDecision",
    "RouteFulfillment", "validate_public_http_url",
]
