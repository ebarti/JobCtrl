"""Shared network-layer adapters.

These adapters are used by multiple bounded contexts (Discovery,
Enrichment) and live outside any single context's tree to avoid the
pre-Phase-7 cross-context import smell where Enrichment imported from
``discovery/jobspy``.
"""

from jobhunter.infrastructure.network.proxy import (
    ProxyConfig,
    parse_proxy,
)

__all__ = ["ProxyConfig", "parse_proxy"]
