"""Actual ATS/public-page adapters with source policy and bounded acquisition."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

from jobctrl.app.errors import AppError
from jobctrl.semantic import Source
from jobctrl.network.policy import ATS_API_POLICY, ENRICHMENT_CRAWL_POLICY
from jobctrl.semantic.identifiers import TenantId
from jobctrl.network import PolitenessGateway, PolitenessSession, PolitenessSourceContext, RunBudgetCounter
from jobctrl.network.http_client import GatewayHttpClient
from jobctrl.network import resolve_request_headers
from jobctrl.features.discovery.adapters.ats import (
    AshbyBoardAdapter,
    GreenhouseBoardAdapter,
    LeverBoardAdapter,
    WorkdayBoardAdapter,
    WorkdayEmployer,
)
from jobctrl.features.discovery.domain import now


def configured_session(source, settings, *, policy=ATS_API_POLICY):
    headers = resolve_request_headers(
        {
            "crawl_user_agent": {
                "product": settings["crawlUserAgentProduct"],
                "contact": settings["crawlUserAgentContact"],
                "use_browser_headers": settings["useBrowserHeaders"],
            }
        }
    )
    return PolitenessSession(
        PolitenessGateway(request_headers=headers),
        policy=policy,
        budget=RunBudgetCounter(policy.max_requests_per_run),
        context=PolitenessSourceContext(source_id=source["sourceId"], stage="discovery", adapter="registered_source"),
    )


async def acquire_registered_source(
    source, *, settings, context, jobs, model, browser_port=None, session=None, capture_required=None
):
    config = source.get("adapterConfig") or {}
    kind = config.get("atsKind") or config.get("ats_kind") or source["sourceId"].split(":", 1)[0]
    token = (
        config.get("board")
        or config.get("board_token")
        or config.get("board_name")
        or config.get("site")
        or source["sourceId"].split(":", 1)[-1]
    )
    company = config.get("company") or source.get("employerName")
    if source.get("kind") == "ats_api" and kind in {"greenhouse", "lever", "ashby", "workday"}:
        if not isinstance(token, str) or not token or not all(c.isalnum() or c in "_-" for c in token):
            raise AppError("invalid_ats_board", "The ATS board coordinate is invalid.")
        session = session or configured_session(source, settings)
        client, acquired = GatewayHttpClient(session), []
        loop = asyncio.get_running_loop()

        def fetch(url, **options):
            if context.cancelled():
                raise AppError("action_cancelled", "Discovery was cancelled.", 409)
            if config.get("useLiveBrowser"):
                if browser_port is None:
                    raise AppError("discovery_browser_unavailable", "Connect the configured discovery browser.", 409)
                with session.guard(url) as decision:
                    if not decision.allowed:
                        raise AppError("source_budget_exhausted", "The source request budget is exhausted.", 409)
                    response = asyncio.run_coroutine_threadsafe(
                        browser_port.fetch_public(
                            {
                                "mode": "http_request",
                                "url": url,
                                "method": options.get("method", "GET"),
                                "body": json.dumps(options["json_body"])
                                if options.get("json_body") is not None
                                else None,
                                "headers": {**decision.request_headers, "Content-Type": "application/json"},
                            },
                            context,
                            source["sourceId"],
                        ),
                        loop,
                    ).result(timeout=75)
                if response.get("status_code") != 200:
                    raise AppError("ats_source_unavailable", "The ATS source did not return usable public data.", 502)
                payload = json.loads(response.get("body_text") or "")
            else:
                payload = client.fetch_json(url, **options)
            if payload is None:
                raise AppError("source_acquisition_deferred", "The source was deferred by request policy.", 409)
            acquired.append({"url": url, "body": payload, "observedAt": now()})
            return payload

        if kind == "greenhouse":
            adapter = GreenhouseBoardAdapter(
                source_id=source["sourceId"], board_token=token, company=company, http=fetch
            )
        elif kind == "lever":
            if source["sourceId"].startswith("lever:eu:"):
                raise AppError(
                    "regional_lever_adapter_unsupported", "This regional Lever source remains review-only.", 409
                )
            adapter = LeverBoardAdapter(source_id=source["sourceId"], site=token, company=company, http=fetch)
        elif kind == "ashby":
            adapter = AshbyBoardAdapter(source_id=source["sourceId"], board_name=token, company=company, http=fetch)
        else:
            required = ("base_url", "tenant", "site_id")
            if not all(config.get(key) for key in required):
                raise AppError(
                    "workday_requires_configured_employer", "Configure the Workday employer and site first.", 409
                )
            employer = WorkdayEmployer(
                employer_key=source["sourceId"],
                name=company or source.get("displayName", ""),
                base_url=jobs.validate_posting_url(config["base_url"]),
                tenant=config["tenant"],
                site_id=config["site_id"],
            )
            adapter = WorkdayBoardAdapter(
                source_id=source["sourceId"],
                employer=employer,
                http=fetch,
                max_pages=min(500, int(config.get("maxPages", 25))),
            )

        def scrape():
            if kind != "workday":
                return list(adapter.scrape(tenant_id=TenantId("local"), query="", location=""))
            values = []
            for authored in settings.get("queries") or []:
                query = authored if isinstance(authored, str) else authored["query"]
                for row in settings.get("locations") or []:
                    location = row if isinstance(row, str) else row.get("location", "")
                    values.extend(adapter.scrape(tenant_id=TenantId("local"), query=query, location=location))
            return values

        values = await asyncio.to_thread(scrape)
        return [
            {
                "url": item.posting_url.value,
                "canonical_url": item.canonical_url,
                "title": item.metadata.title,
                "company": item.employer.name or "",
                "description": item.metadata.description,
                "full_description": item.metadata.description,
                "location": item.metadata.location,
                "salary": item.metadata.salary,
                "source_id": source["sourceId"],
                "source_native_id": item.source_native_id,
                "provenance": {
                    "authority": "provider",
                    "sourceKind": "canonical_ats_api",
                    "sourceRevision": source["revision"],
                    "publicResponses": acquired,
                },
            }
            for item in values
        ]
    seed = source.get("seedUrl") or config.get("seed_url") or config.get("url")
    if not seed:
        raise AppError("source_seed_missing", "This source needs an explicit public seed URL.")
    query = next((q if isinstance(q, str) else q.get("query", "") for q in settings.get("queries", []) if q), "")
    location = next(
        (row if isinstance(row, str) else row.get("location", "") for row in settings.get("locations", []) if row), ""
    )
    seed = jobs.validate_posting_url(
        seed.replace("{query}", quote(query, safe=""))
        .replace("{query_encoded}", quote(query, safe=""))
        .replace("{location_encoded}", quote(location, safe=""))
        .replace("{location}", quote(location, safe=""))
    )
    if config.get("useLiveBrowser"):
        if browser_port is None:
            raise AppError("discovery_browser_unavailable", "Connect the configured discovery browser.", 409)
        captured = await browser_port.fetch_public({"mode": "rendered_page", "url": seed}, context, source["sourceId"])
        page = await jobs.acquire_source_page(seed, captured=captured, cancelled=context.cancelled)
    else:
        page = await jobs.acquire_source_page(
            seed,
            session=session or configured_session(source, settings, policy=ENRICHMENT_CRAWL_POLICY),
            cancelled=context.cancelled,
        )
    sources, origins = [Source.model_validate(source) for source in page["sources"]], page["source_urls"]
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["postingUrls"],
        "properties": {
            "postingUrls": {
                "type": "array",
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["url", "source_id", "quote"],
                    "properties": {
                        "url": {"type": "string"},
                        "source_id": {"type": "string"},
                        "quote": {"type": "string"},
                    },
                },
            }
        },
    }
    result = await model.determine(
        operation="discovery_listing",
        instructions="Identify links to individual job postings actually present in these public captured sources. Return only exact captured public links to specific postings or the current page when itself an individual posting. Do not invent URLs, expand queries, infer employer identity or claim any role fits. Cite the exact source URL for each selected link.",
        sources=[s.model_dump() for s in sources],
        response_schema=schema,
        context={"sourceUrls": origins},
        prompt_version="1",
        lane="enrichment",
    )
    by_id = {s.source_id: s.text for s in sources}
    permitted = {seed, page["final_url"], *[s.text for s in sources if s.source_id.endswith(":url")]}
    postings = []
    for selected in result.value["postingUrls"]:
        if (
            selected["source_id"] not in by_id
            or not selected["quote"]
            or selected["quote"] not in by_id[selected["source_id"]]
            or selected["url"] not in permitted
        ):
            raise AppError(
                "invalid_discovery_listing_binding", "The discovered link is not bound to a captured source.", 409
            )
        if context.cancelled():
            raise AppError("action_cancelled", "Discovery was cancelled.", 409)
        try:
            posting = await jobs.acquire_posting(
                {"url": jobs.validate_posting_url(selected["url"]), "source_id": source["sourceId"]},
                cancelled=context.cancelled,
            )
        except AppError as error:
            jobs.record_capture_attempt(url=selected["url"], failure_code=error.code)
            if capture_required is not None and error.code in {
                "manual_capture_required",
                "posting_unavailable",
                "posting_refresh_identity_unverified",
            }:
                evidence = (error.details or {}).get("captureEvidence") or {}
                access = (evidence.get("pageInterpretation") or {}).get("access_state", {}).get("value")
                reason = (
                    "login_required"
                    if access == "login_required"
                    else "captcha"
                    if access == "challenge"
                    else "ambiguous_career_system"
                )
                capture_required(
                    selected["url"],
                    source_id=source["sourceId"],
                    reason=reason,
                    retry_context={"captureEvidence": evidence},
                )
            continue
        posting["provenance"]["discoveryListing"] = result.provenance
        postings.append(posting)
    return postings
