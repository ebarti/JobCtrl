"""Shared proxy parsing helper.

Moved out of ``jobctrl.discovery.jobspy`` (Phase 7 / S-27) so the
Enrichment context's Playwright fetcher can use it without importing
from a sibling bounded context — that cross-context import was Briefing
#12's pain point and is the explicit target of this refactor.

The function accepts the legacy ``host:port[:user:pass]`` format and
returns a typed ``ProxyConfig`` value object that exposes both the
JobSpy and Playwright wire shapes. JobSpy callers continue to use the
``jobspy`` field (a single ``user:pass@host:port`` string); Playwright
callers use the ``playwright`` mapping (a dict with ``server`` /
``username`` / ``password`` keys).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ProxyConfig:
    """Parsed proxy configuration.

    Both adapter shapes are computed up front so callers don't need to
    know the legacy serialisation rules — they pick whichever field
    their adapter expects.
    """

    host: str
    port: str
    user: str | None
    password: str | None
    jobspy: str
    playwright: dict[str, Any] = field(default_factory=dict)


def parse_proxy(proxy_str: str) -> ProxyConfig:
    """Parse a ``host:port[:user:pass]`` string into a ``ProxyConfig``.

    Mirrors the legacy ``jobctrl.discovery.jobspy.parse_proxy``
    behaviour exactly:

      * 4 components ⇒ user/password authentication
      * 2 components ⇒ anonymous proxy

    Anything else is rejected with a ``ValueError`` so the caller
    surfaces the typo rather than silently dropping the proxy.
    """
    parts = proxy_str.split(":")
    if len(parts) == 4:
        host, port, user, passwd = parts
        return ProxyConfig(
            host=host,
            port=port,
            user=user,
            password=passwd,
            jobspy=f"{user}:{passwd}@{host}:{port}",
            playwright={
                "server": f"http://{host}:{port}",
                "username": user,
                "password": passwd,
            },
        )
    if len(parts) == 2:
        host, port = parts
        return ProxyConfig(
            host=host,
            port=port,
            user=None,
            password=None,
            jobspy=f"{host}:{port}",
            playwright={"server": f"http://{host}:{port}"},
        )
    raise ValueError(
        f"Proxy format not recognized: {proxy_str}. "
        "Expected: host:port:user:pass or host:port"
    )
