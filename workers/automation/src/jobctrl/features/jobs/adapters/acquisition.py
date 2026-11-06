"""Real bounded page acquisition and source-bound model extraction."""

from __future__ import annotations

import asyncio
import hashlib
import json

from bs4 import BeautifulSoup
from pydantic import ValidationError

from jobctrl.app.errors import AppError
from jobctrl.semantic import Citation, DeterminationFailure, Source, validate_citations
from jobctrl.features.jobs.domain.capture import DetailPage
from jobctrl.features.jobs.domain.analysis import RefreshIdentity
from jobctrl.features.jobs.domain.page_interpretation import (
    DescriptionQuality,
    PageInterpretation,
    PostingExtraction,
    PostingField,
    PostingSelectionExtraction,
)
from jobctrl.features.jobs.domain.postings import normalize_url, posting_url, utc_now
from jobctrl.features.jobs.adapters.page_fetcher import PlaywrightDetailPageFetcher
from jobctrl.features.jobs.adapters.posting_sources import posting_page_sources, rendered_page_text


class SourceBoundPostingAcquirer:
    def __init__(self, model, fetcher=None):
        self.model = model
        self._fetcher_supplied = fetcher is not None
        self._crawler_settings = None
        if fetcher is None:
            fetcher = PlaywrightDetailPageFetcher(raise_on_unavailable=True)
        self.fetcher = fetcher

    def bind_crawler_settings(self, provider):
        self._crawler_settings = provider

    def _request_fetcher(self, session=None):
        if self._fetcher_supplied:
            return self.fetcher
        if session is None and self._crawler_settings is not None:
            from jobctrl.network import (
                PolitenessGateway,
                PolitenessSession,
                PolitenessSourceContext,
                RunBudgetCounter,
                resolve_request_headers,
            )
            from jobctrl.network.policy import ENRICHMENT_CRAWL_POLICY

            session = PolitenessSession(
                PolitenessGateway(request_headers=resolve_request_headers(self._crawler_settings())),
                policy=ENRICHMENT_CRAWL_POLICY,
                budget=RunBudgetCounter(1000),
                context=PolitenessSourceContext(stage="jobs", adapter="posting_page"),
            )
        return (
            self.fetcher if session is None else PlaywrightDetailPageFetcher(session=session, raise_on_unavailable=True)
        )

    async def source_page(self, url, *, session=None, captured=None, cancelled=None):
        url = posting_url(url)
        if captured is not None:
            content = captured.get("body_html") or captured.get("body_text") or ""
            page = DetailPage(
                url=url,
                final_url=posting_url(captured.get("final_url") or url),
                html=content,
                status_html=content,
                page_title=captured.get("title") or "",
                status=captured.get("status_code"),
                fetched_at=utc_now(),
                status_evidence_complete=captured.get("evidence_complete") is True,
                status_visibility_verified=captured.get("visibility_verified") is True,
            )
        else:
            fetcher = self._request_fetcher(session)
            page = await asyncio.to_thread(fetcher.fetch, url)
        if cancelled and cancelled():
            raise AppError("action_cancelled", "Source acquisition was cancelled.", 409)
        sources, origins = posting_page_sources(page, entity_id=url)
        return {
            "url": url,
            "final_url": page.final_url or url,
            "observed_at": page.fetched_at,
            "sources": [source.model_dump() for source in sources],
            "source_urls": origins,
            "status_code": page.status,
            "evidence_complete": page.status_evidence_complete,
            "visibility_verified": page.status_visibility_verified,
            "raw_html_hash": page.raw_html_hash,
        }

    async def _determine(self, *, operation, schema, instructions, sources, context, prompt_version):
        response = await self.model.determine(
            operation=operation,
            instructions=instructions,
            sources=[s.model_dump() for s in sources],
            response_schema=schema.model_json_schema(),
            context=context,
            prompt_version=prompt_version,
            lane="enrichment",
        )
        try:
            value = schema.model_validate(response.value)
            validate_citations(value, sources)
        except (ValidationError, DeterminationFailure) as error:
            raise AppError(
                getattr(error, "code", "model_schema_invalid"),
                "The model response is not valid for the captured sources.",
                409,
            ) from None
        return value, response.provenance

    async def acquire(self, payload, *, cancelled=None):
        url = posting_url(payload.get("url") or payload.get("postingUrl") or "")
        captured = payload.get("html") or payload.get("bodyHtml") or payload.get("text") or payload.get("bodyText")
        if captured:
            if not isinstance(captured, str) or len(captured.encode()) > 6_000_000:
                raise AppError("capture_too_large", "The capture exceeds the document size limit.")
            declared = payload.get("jsonLd") or payload.get("json_ld") or []
            if not isinstance(declared, (list, tuple)):
                raise AppError("invalid_capture", "Structured capture data must be a list.")
            if not declared:
                soup = BeautifulSoup(captured, "html.parser")
                for script in soup.select('script[type="application/ld+json"]'):
                    try:
                        declared.append(json.loads(script.get_text()))
                    except json.JSONDecodeError:
                        continue
            final_url = posting_url(payload.get("finalUrl") or payload.get("final_url") or url)
            page = DetailPage(
                url=url,
                final_url=final_url,
                page_title=payload.get("title") or "",
                html=captured,
                status_html=captured,
                json_ld=tuple(declared),
                fetched_at=payload.get("capturedAt") or utc_now(),
                status=payload.get("statusCode"),
                status_evidence_complete=payload.get("evidenceComplete") is True,
                status_visibility_verified=payload.get("visibilityVerified") is True,
                raw_html_hash=hashlib.sha256(captured.encode()).hexdigest(),
            )
        else:
            page = await asyncio.to_thread(self._request_fetcher().fetch, url)
        if cancelled and cancelled():
            raise AppError("action_cancelled", "Capture was cancelled.", 409)
        if not page.html and not page.json_ld:
            raise AppError("posting_unavailable", "No readable posting was captured.", 409)
        sources, origins = posting_page_sources(page, entity_id=url)
        sources = [Source(source_id=s.source_id, text=s.text[:64000]) for s in sources]
        metadata = {
            "url": url,
            "final_url": page.final_url,
            "status": page.status,
            "evidence_complete": page.status_evidence_complete,
            "visibility_verified": page.status_visibility_verified,
            "incomplete_reason": page.status_evidence_reason,
        }
        interpretation_sources = [
            Source(source_id="rendered_page", text=rendered_page_text(page)[:64000]),
            Source(source_id="page_metadata", text=json.dumps(metadata, ensure_ascii=False)),
            *[s for s in sources if s.source_id != "rendered_page"],
        ]
        interpretation, interpretation_receipt = await self._determine(
            operation="page_interpretation",
            schema=PageInterpretation,
            sources=interpretation_sources,
            context={},
            prompt_version="page-interpretation-v1",
            instructions="Determine what this captured page currently says. Distinguish a job's current closed/expired status from historical description prose, references to other jobs and hidden controls. Classify an individual posting versus a listing, login or access challenge, and whether its application control is usable. Cite verbatim spans for each judgment; use unknown where current evidence is absent or inconsistent. Do not infer availability from body presence or HTTP success.",
        )
        if interpretation.page_kind.value != "posting" or interpretation.access_state.value in {
            "login_required",
            "challenge",
        }:
            raise AppError(
                "manual_capture_required",
                "The captured page does not establish an accessible individual posting.",
                409,
                {
                    "captureEvidence": {
                        "sources": [source.model_dump() for source in sources],
                        "sourceUrls": origins,
                        "pageMetadata": metadata,
                        "pageInterpretation": interpretation.model_dump(),
                        "provenance": interpretation_receipt,
                    }
                },
            )
        inventory, line_ranges = [], {}
        for source_index, source in enumerate(sources):
            offset, lines, ranges = 0, [], {}
            for line_index, text in enumerate(source.text.splitlines(keepends=True)):
                ident = f"line:{source_index}:{line_index}"
                ranges[ident] = (offset, offset + len(text))
                lines.append({"line_id": ident, "text": text})
                offset += len(text)
            line_ranges[source.source_id] = ranges
            inventory.append({"source_id": source.source_id, "lines": lines})
        selected, extraction_receipt = await self._determine(
            operation="posting_extraction",
            schema=PostingSelectionExtraction,
            sources=sources,
            context={"line_inventory": inventory, "source_urls": origins},
            prompt_version="posting-extraction-v4-source-selection",
            instructions="Extract the one current job posting from the captured sources. For description select source_id and first_line_id/last_line_id of one contiguous complete substantive posting span from line_inventory; return value=null,citations=[] and source_origins=[]. Code copies the exact range. Prefer the complete declared structured description when present. All nonempty title, employer, location, salary and application_url values must be copied verbatim with source citations. Leave absent fields empty. Never guess employer from URL or heading punctuation. Relative application links must refer to a captured link or page URL. Exclude unrelated jobs/navigation. Do not invent or rewrite description text.",
        )
        span = selected.description
        ranges = line_ranges.get(span.source_id, {})
        first, last = ranges.get(span.first_line_id), ranges.get(span.last_line_id)
        if first is None or last is None or first[0] > last[0]:
            raise AppError("invalid_source_selection", "The model selected an invalid source range.", 409)
        original = next(s.text for s in sources if s.source_id == span.source_id)
        description = original[first[0] : last[1]].strip()
        if not description or span.value is not None or span.citations or selected.source_origins:
            raise AppError(
                "invalid_source_selection", "The posting extraction violated source selection authority.", 409
            )
        for field_name in ("title", "employer", "location", "salary", "application_url"):
            field = getattr(selected, field_name)
            if field.value and not any(field.value in citation.quote for citation in field.citations):
                raise AppError("invalid_source_binding", "An extracted field is not copied from its cited source.", 409)
        if not selected.title.value:
            raise AppError("incomplete_posting_extraction", "The capture does not establish a job title.", 409)
        extraction = PostingExtraction(
            **selected.model_dump(exclude={"description", "source_origins"}),
            description=PostingField(
                value=description,
                citations=[Citation(source_id=span.source_id, quote=description[:4000])],
                rationale=span.rationale,
            ),
        )
        quality, quality_receipt = await self._determine(
            operation="description_quality",
            schema=DescriptionQuality,
            sources=[Source(source_id="description", text=description)],
            context={"postingUrl": url},
            prompt_version="description-quality-v1",
            instructions="Judge whether this extracted text is a sufficiently complete description of one specific job, rather than navigation, a list of openings, a login page or fragments. Cite exact source spans and explain confidence. Do not grade by length, extraction tier or application URL presence.",
        )
        active_state = interpretation.availability.value
        if not page.status_evidence_complete or not page.status_visibility_verified:
            active_state = "unknown"
        return {
            "url": url,
            "canonical_url": page.final_url or url,
            "source_id": payload.get("source_id") or payload.get("sourceId") or "manual_url",
            "source_native_id": payload.get("source_native_id") or "",
            "title": extraction.title.value,
            "company": extraction.employer.value,
            "description": description,
            "location": extraction.location.value,
            "salary": extraction.salary.value,
            "application_url": extraction.application_url.value,
            "active_state": active_state,
            "observed_at": page.fetched_at or utc_now(),
            "quarantine": quality.confidence == "low",
            "provenance": {
                "authority": "source_bound_model",
                "sourceKind": "captured_page",
                "extractionTier": "llm_assisted",
                "sourceUrls": origins,
                "sources": [s.model_dump() for s in sources],
                "rawHtmlHash": page.raw_html_hash,
                "pageInterpretation": interpretation.model_dump(),
                "extraction": extraction.model_dump(),
                "descriptionSelection": span.model_dump(),
                "quality": quality.model_dump(),
                "determinations": [interpretation_receipt, extraction_receipt, quality_receipt],
                "captureProvenance": payload.get("provenance") or {},
            },
        }

    async def availability(self, posting, *, cancelled=None):
        page = await asyncio.to_thread(self._request_fetcher().fetch, posting["url"])
        if cancelled and cancelled():
            raise AppError("action_cancelled", "Posting verification was cancelled.", 409)
        aliases = {normalize_url(url) for url in (posting["url"], posting.get("canonical_url")) if url}
        retained = normalize_url(page.final_url or page.url) in aliases
        metadata = {
            "requested_url": posting["url"],
            "observed_url": page.final_url or page.url,
            "http_status": page.status,
            "posting_identity_retained": retained,
            "evidence_complete": page.status_evidence_complete,
            "visibility_verified": page.status_visibility_verified,
            "incomplete_reason": page.status_evidence_reason,
        }
        sources, _ = posting_page_sources(page, entity_id=posting["url"])
        sources = [Source(source_id=s.source_id, text=s.text[:64000]) for s in sources]
        sources.append(Source(source_id="current_response_metadata", text=json.dumps(metadata, ensure_ascii=False)))
        result, receipt = await self._determine(
            operation="posting_availability",
            schema=PageInterpretation,
            sources=sources,
            context={
                "savedPostingIdentity": {
                    key: posting.get(key) for key in ("job_id", "title", "company", "url", "canonical_url")
                }
            },
            prompt_version="posting-availability-v1",
            instructions="Determine the current availability of this exact saved posting from newly captured response evidence only. Prior job identity is supplied only to check which posting was requested; it cannot prove active/closed status. Missing listings, generic redirects, access walls, rate limits, request failures, body presence or HTTP success alone cannot establish active or closed status. Cite verbatim current captured evidence for page kind/access/apply control and availability. Use unknown when posting identity is lost, evidence is incomplete or current signals conflict; never match by title-token overlap.",
        )
        state = result.availability.value
        if (
            not retained
            or not page.status_evidence_complete
            or not page.status_visibility_verified
            or result.access_state.value in {"login_required", "challenge"}
        ):
            state = "unknown"
        if state == "active" and (result.page_kind.value != "posting" or result.access_state.value != "clear"):
            state = "unknown"
        observed_at = page.fetched_at or utc_now()
        return {
            **posting,
            "active_state": state,
            "observed_at": observed_at,
            "provenance": {
                **posting.get("provenance", {}),
                "availability": {
                    "observedAt": observed_at,
                    "metadata": metadata,
                    "value": result.model_dump(),
                    "provenance": receipt,
                    "sources": [s.model_dump() for s in sources],
                },
            },
        }

    async def verify_refresh_identity(self, previous, candidate):
        aliases = {normalize_url(url) for url in (previous["url"], previous.get("canonical_url")) if url}
        observed = normalize_url(candidate.get("canonical_url") or candidate["url"])
        if observed in aliases:
            return candidate
        if all(
            previous.get(key) and previous[key] == candidate.get(key) for key in ("title", "company", "description")
        ):
            candidate["provenance"]["refreshIdentity"] = {
                "method": "exact_full_content",
                "previousSourceHash": previous["source_hash"],
            }
            return candidate
        sources = [
            Source(
                source_id="previous_posting_identity",
                text=json.dumps(
                    {
                        key: previous.get(key)
                        for key in ("job_id", "title", "company", "url", "canonical_url", "source_native_id")
                    },
                    ensure_ascii=False,
                ),
            ),
            Source(source_id="previous_posting_description", text=previous["description"]),
            Source(
                source_id="current_posting_identity",
                text=json.dumps(
                    {
                        key: candidate.get(key)
                        for key in ("title", "company", "url", "canonical_url", "source_native_id")
                    },
                    ensure_ascii=False,
                ),
            ),
            *[Source.model_validate(source) for source in candidate.get("provenance", {}).get("sources", [])],
        ]
        result, receipt = await self._determine(
            operation="jobs.refresh_identity",
            schema=RefreshIdentity,
            sources=sources,
            context={"previousRevision": previous["revision"], "previousSourceHash": previous["source_hash"]},
            prompt_version="posting-refresh-identity-v1",
            instructions=(
                "Determine whether the newly captured redirect destination is the exact same saved posting. "
                "Cite both previous and current captured identity evidence. Equal role/employer names or overlapping prose alone "
                "cannot prove identity. Require an explicit stable posting identifier, an established canonical locator or clear "
                "source evidence binding the redirect to that posting. Different specific posting IDs establish different_posting; "
                "lost identity, generic redirects or insufficient evidence require unknown. Never guess or create a new equivalence "
                "from title tokens. The previous description is historical and cannot establish current availability."
            ),
        )
        cited = {citation.source_id for citation in result.citations}
        if not cited.intersection(
            {"previous_posting_identity", "previous_posting_description"}
        ) or not cited.intersection(
            {source.source_id for source in sources if not source.source_id.startswith("previous_posting_")}
        ):
            raise AppError(
                "refresh_identity_binding_invalid", "The refresh identity is not bound to both source versions.", 409
            )
        if result.verdict != "same_posting":
            raise AppError(
                "posting_refresh_identity_unverified",
                "The redirect did not establish the same saved posting; the accepted source is retained.",
                409,
                {"verdict": result.verdict, "receiptId": receipt.get("receipt_id")},
            )
        candidate["provenance"]["refreshIdentity"] = {"value": result.model_dump(), "provenance": receipt}
        return candidate
