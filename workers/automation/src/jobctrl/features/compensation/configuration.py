"""Map explicit host feed configuration into neutral provider adapters."""

from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary

from .providers.factory import build_sources


def _refs(prefix: str, *, discover_defaults: bool = False) -> tuple[str, ...]:
    if os.environ.get("JOBCTRL_SYNTHETIC_BOUNDARIES") == "1":
        return ()
    values = []
    for suffix in ("OBSERVATIONS_PATH", "OBSERVATIONS_JSON", "DATA_FEED_PATH", "OBSERVATIONS_URL", "DATA_FEED_URL"):
        values.extend(part.strip() for part in re.split(r"[,;]", os.environ.get(f"{prefix}_{suffix}", "")) if part.strip())
    if not values and discover_defaults and os.environ.get("JOBCTRL_SYNTHETIC_BOUNDARIES") != "1":
        directory = Path.home() / ".jobctrl" / "compensation"
        names = ("levels_fyi.json", "levels_fyi.csv", "levels-fyi.json", "levels-fyi.csv") if prefix == "JOBCTRL_LEVELS_FYI" else ("glassdoor.json", "glassdoor.csv")
        values.extend(str(directory / name) for name in names if (directory / name).is_file())
    return tuple(dict.fromkeys(values))


def _token(prefix: str) -> str | None:
    if os.environ.get("JOBCTRL_SYNTHETIC_BOUNDARIES") == "1":
        return None
    return next((value for suffix in ("API_TOKEN", "API_KEY", "TOKEN") if (value := os.environ.get(f"{prefix}_{suffix}"))), None)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AppError("synthetic_redirect_forbidden", "The controlled provider cannot redirect.", 502)


class _BoundedResponse:
    def __init__(self, response):
        self.response = response
        self.headers = response.headers

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.response.close()

    def read(self):
        value = self.response.read(2 * 1024 * 1024 + 1)
        if len(value) > 2 * 1024 * 1024:
            raise AppError("synthetic_response_too_large", "The controlled provider response exceeds its limit.", 502)
        return value


class _SyntheticExternalOpener:
    """Marker-gated loopback transport for controlled external sources in owned QA."""
    def __init__(self, workspace: Path, url: str):
        identity = synthetic_boundary(workspace, url)
        if identity is None:
            raise AppError("synthetic_boundary_unowned", "The controlled provider requires an owned workspace.", 503)
        self.url, self.token = url, identity["token"]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def open(self, request, timeout):
        target = urlsplit(request.full_url)
        if (request.get_method() != "GET" or target.scheme != "https" or target.username or target.password
                or target.hostname not in {"ec.europa.eu", "www.ecb.europa.eu", "www.eurotoptech.com", "www.levels.fyi"}):
            raise AppError("synthetic_target_forbidden", "The controlled provider target is not permitted.", 403)
        body = json.dumps({"url": request.full_url}, separators=(",", ":")).encode()
        translated = urllib.request.Request(self.url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
        })
        return _BoundedResponse(self.opener.open(translated, timeout=timeout))


def source_factory(options: dict, run_id: str, preferences: dict, *, workspace: Path):
    manual = options.get("observationsJsonPath")
    levels = preferences.get("levels_fyi", {})
    glassdoor = preferences.get("glassdoor", {})
    levels_permitted = levels.get("enabled") is True and levels.get("accessMode") in {"licensed_api", "licensed_data_feed", "enterprise_mcp"} and levels.get("europeCoverageConfirmed") is True
    glassdoor_permitted = glassdoor.get("enabled") is True and glassdoor.get("accessMode") in {"partner_api", "written_permission"}
    synthetic_url = os.environ.get("JOBCTRL_E2E_COMPENSATION_URL")
    opener = _SyntheticExternalOpener(workspace, synthetic_url) if synthetic_url else None
    return build_sources(
        levels_refs=_refs("JOBCTRL_LEVELS_FYI", discover_defaults=levels_permitted),
        glassdoor_refs=_refs("JOBCTRL_GLASSDOOR", discover_defaults=glassdoor_permitted),
        levels_token=_token("JOBCTRL_LEVELS_FYI"), glassdoor_token=_token("JOBCTRL_GLASSDOOR"),
        manual_refs=(manual,) if manual else (), include_euro_top_tech=options.get("includeEuroTopTech", True),
        euro_top_tech_max_pages=options.get("euroTopTechMaxPages", 10), run_id=run_id, opener=opener,
    )
