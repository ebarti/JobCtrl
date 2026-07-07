"""robots.txt adapter for the crawl-politeness gateway (R10 P1).

Implements :class:`RobotsPort`: fetch a host's ``robots.txt`` (politely — short
timeout, honest UA, cached per host with a TTL), parse it with the stdlib
``urllib.robotparser``, and evaluate ``can_fetch`` for a URL. No new dependency.

Unreachable-robots semantics (owner decision D6), aligned with RFC 9309:

* ``4xx`` (including 404) → *unavailable* → **allow** (no restrictions).
* ``2xx`` → parse and evaluate the directives.
* ``5xx`` / timeout → *unreachable* → **fail-closed** (:attr:`RobotsVerdict.UNKNOWN`,
  which the gateway treats as disallowed) cached with a short TTL so the next run
  re-checks; a warning is logged.
* DNS failure / connection refused → *definitive network absence* of the robots
  endpoint → **fail-open with warning** (allow); if the host is genuinely down the
  subsequent content fetch fails harmlessly.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from jobctl.domain.ports.politeness import RobotsPort, RobotsVerdict

log = logging.getLogger(__name__)

DEFAULT_ROBOTS_TTL_SECONDS = 3600.0
"""D5: cache a parsed ``robots.txt`` for one hour."""

UNREACHABLE_ROBOTS_TTL_SECONDS = 300.0
"""D6: short TTL for fail-closed (5xx/timeout) results so they re-check soon."""

ROBOTS_FETCH_TIMEOUT_SECONDS = 5.0
"""Short timeout — the robots fetch itself must be polite."""


@dataclass
class _RobotsEntry:
    """A cached robots decision for one host key."""

    parser: RobotFileParser | None
    verdict_override: RobotsVerdict | None
    expires_at: float


class RobotsCache(RobotsPort):
    """Per-host cached ``robots.txt`` evaluator (thread-safe)."""

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_ROBOTS_TTL_SECONDS,
        unreachable_ttl_seconds: float = UNREACHABLE_ROBOTS_TTL_SECONDS,
        timeout_seconds: float = ROBOTS_FETCH_TIMEOUT_SECONDS,
        opener: urllib.request.OpenerDirector | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl_seconds
        self._unreachable_ttl = unreachable_ttl_seconds
        self._timeout = timeout_seconds
        self._opener = opener or urllib.request.build_opener()
        self._clock = clock
        self._lock = threading.Lock()
        self._cache: dict[str, _RobotsEntry] = {}

    def evaluate(self, url: str, user_agent: str) -> RobotsVerdict:
        host_key = self._host_key(url)
        if host_key is None:
            return RobotsVerdict.UNKNOWN
        entry = self._entry_for(host_key, user_agent)
        if entry.verdict_override is not None:
            return entry.verdict_override
        assert entry.parser is not None  # override is None => parser present
        return RobotsVerdict.ALLOW if entry.parser.can_fetch(user_agent, url) else RobotsVerdict.DISALLOW

    def _entry_for(self, host_key: str, user_agent: str) -> _RobotsEntry:
        now = self._clock()
        with self._lock:
            cached = self._cache.get(host_key)
            if cached is not None and cached.expires_at > now:
                return cached
        entry = self._fetch(host_key, user_agent)
        with self._lock:
            self._cache[host_key] = entry
        return entry

    def _fetch(self, host_key: str, user_agent: str) -> _RobotsEntry:
        robots_url = f"{host_key}/robots.txt"
        request = urllib.request.Request(robots_url, headers={"User-Agent": user_agent})
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
            return self._allow_from(body)
        except urllib.error.HTTPError as exc:
            if exc.code and exc.code >= 500:
                log.warning("robots.txt %s for %s: server error, disallowing until retry", exc.code, host_key)
                return self._unreachable()
            # 4xx (incl. 404): robots unavailable => no restrictions.
            return self._allow_all()
        except (TimeoutError, socket.timeout):
            log.warning("robots.txt timeout for %s: disallowing until retry", host_key)
            return self._unreachable()
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, (TimeoutError, socket.timeout)):
                log.warning("robots.txt timeout for %s: disallowing until retry", host_key)
                return self._unreachable()
            # DNS failure / connection refused: definitive absence => allow, warn.
            log.warning("robots.txt unreachable for %s (%s): treating as absent (allow)", host_key, reason)
            return self._allow_all()
        except Exception as exc:  # noqa: BLE001 - never let a robots quirk become a silent allow
            log.warning("robots.txt fetch failed for %s (%s): disallowing until retry", host_key, exc)
            return self._unreachable()

    def _allow_from(self, body: str) -> _RobotsEntry:
        parser = RobotFileParser()
        parser.parse(body.splitlines())
        parser.modified()
        return _RobotsEntry(parser=parser, verdict_override=None, expires_at=self._clock() + self._ttl)

    def _allow_all(self) -> _RobotsEntry:
        parser = RobotFileParser()
        parser.parse([])
        parser.modified()
        return _RobotsEntry(parser=parser, verdict_override=None, expires_at=self._clock() + self._ttl)

    def _unreachable(self) -> _RobotsEntry:
        return _RobotsEntry(
            parser=None,
            verdict_override=RobotsVerdict.UNKNOWN,
            expires_at=self._clock() + self._unreachable_ttl,
        )

    @staticmethod
    def _host_key(url: str) -> str | None:
        parts = urlsplit(url)
        if not parts.scheme or not parts.netloc:
            return None
        return f"{parts.scheme}://{parts.netloc}"
