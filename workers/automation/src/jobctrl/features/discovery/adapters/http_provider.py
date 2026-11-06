"""An explicit HTTP search-provider boundary for owned integration workspaces."""

from __future__ import annotations

import json
import os

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary


class ProviderPosting(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    job_key: StrictStr = Field(min_length=1, max_length=1000)
    url: StrictStr = Field(min_length=1, max_length=8192)
    title: StrictStr = Field(max_length=2000)
    company: StrictStr = Field(default="", max_length=2000)
    description: StrictStr = Field(default="", max_length=64000)
    location: StrictStr = Field(default="", max_length=4000)
    salary: StrictStr = Field(default="", max_length=4000)
    application_url: StrictStr = Field(default="", max_length=8192)
    source_id: StrictStr = Field(default="http_provider", max_length=500)
    source_native_id: StrictStr = Field(default="", max_length=1000)


class ProviderPage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    jobs: list[ProviderPosting] = Field(max_length=1000)
    cursor: StrictStr | None = Field(max_length=8000)
    complete: StrictBool


class HttpSearchProvider:
    def __init__(self, workspace, endpoint):
        owner = synthetic_boundary(workspace, endpoint)
        if owner is None:
            raise AppError("synthetic_boundary_unowned", "The external test provider requires an owned workspace.", 503)
        token = os.environ.get("JOBCTRL_DISCOVERY_PROVIDER_TOKEN", owner["token"])
        if token != owner["token"]:
            raise AppError(
                "synthetic_boundary_unowned", "The Discovery provider token does not match workspace ownership.", 503
            )
        self.endpoint, self.token = endpoint, token

    async def fetch_page(self, unit, *, cursor, run_id):
        request = {k: v for k, v in unit.items() if k not in {"unit_id", "cursor", "source_family", "source_id"}}
        async with httpx.AsyncClient(timeout=httpx.Timeout(30), follow_redirects=False, trust_env=False) as client:
            async with client.stream(
                "POST",
                self.endpoint,
                headers={"Authorization": "Bearer " + self.token, "X-JobCtrl-E2E-Token": self.token},
                json={"request": request, "cursor": cursor, "runId": run_id, "unitId": unit["unit_id"]},
            ) as response:
                if response.status_code != 200:
                    raise AppError("discovery_provider_unavailable", "The external search provider failed.", 502)
                payload = bytearray()
                async for chunk in response.aiter_bytes():
                    payload.extend(chunk)
                    if len(payload) > 2_000_000:
                        raise AppError(
                            "discovery_provider_response_too_large", "The provider response exceeds its limit.", 502
                        )
        try:
            page = ProviderPage.model_validate(json.loads(payload))
        except (ValueError, TypeError):
            raise AppError(
                "discovery_provider_invalid_response", "The provider returned an invalid search page.", 502
            ) from None
        if not page.complete and (page.cursor is None or page.cursor == cursor):
            raise AppError("discovery_provider_invalid_cursor", "The provider did not advance its search cursor.", 502)
        return page
