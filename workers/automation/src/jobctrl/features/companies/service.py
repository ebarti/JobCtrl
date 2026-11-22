"""Explicit company links and source-bound, reusable public briefings."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime
import hashlib
from urllib.parse import urlsplit

from pydantic import ValidationError

from jobctrl.app.errors import AppError, NotFoundError
from jobctrl.features.companies.domain import (
    INSTRUCTIONS, MAX_SOURCES, MAX_TEXT, PROMPT_VERSION, CompanyBriefingDetermination,
    briefing_view, company_key, failure, public_source_url, validate_result,
)
from jobctrl.features.companies.ports import CompanyHistory, CompanyUnitOfWork, Model, PublicPages, RefreshLocks


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _validate_company(company, company_id):
    urls = company["sourceUrls"]
    name = company["name"]
    if (company["companyId"] != company_id or company_key(company["homepageUrl"]) != company_id
            or public_source_url(company["homepageUrl"]) != company["homepageUrl"]
            or not isinstance(name, str) or not name.strip() or len(name) > 500
            or not isinstance(urls, list) or not 1 <= len(urls) <= MAX_SOURCES
            or any(public_source_url(url) != url for url in urls) or len(set(urls)) != len(urls)
            or datetime.fromisoformat(company["configuredAt"]).tzinfo is None):
        raise failure("briefing_binding_invalid")


class CompaniesService:
    def __init__(self, history: CompanyHistory, model: Model, pages: PublicPages,
                 locks: RefreshLocks, clock: Callable[[], str]):
        self.history, self.model, self.pages, self.locks, self.clock = history, model, pages, locks, clock

    def configure(self, job_id, *, homepage_url, source_urls, confirm_identity):
        if confirm_identity is not True:
            raise failure("briefing_identity_confirmation_required")
        homepage = public_source_url(homepage_url)
        if not isinstance(source_urls, list):
            raise failure("briefing_source_limit")
        urls = [public_source_url(url) for url in source_urls]
        if not 1 <= len(urls) <= MAX_SOURCES or len(set(urls)) != len(urls):
            raise failure("briefing_source_limit")
        company_id = company_key(homepage)
        with self.history.write() as unit:
            posting = unit.posting(job_id)
            employer = posting.get("company")
            if not isinstance(employer, str) or not employer.strip() or len(employer) > 500:
                raise failure("briefing_identity_confirmation_required")
            previous = unit.configuration(company_id)
            if previous is None or previous["sourceUrls"] != urls:
                unit.record_configuration(company_id, {
                    "companyId": company_id, "name": previous["name"] if previous else employer,
                    "homepageUrl": homepage, "sourceUrls": urls, "configuredAt": self.clock(),
                })
            unit.record_link(job_id, company_id, {
                "companyId": company_id, "jobId": job_id, "employerName": employer, "confirmedAt": self.clock(),
            })
            unit.notify_linked_jobs(company_id)
        return self.read(job_id)

    @staticmethod
    def _model_args(company, sources):
        return {
            "operation": "companies.briefing",
            "instructions": INSTRUCTIONS,
            "sources": [{"source_id": s["sourceId"], "text": s["text"]} for s in sources],
            "response_schema": CompanyBriefingDetermination.model_json_schema(),
            "context": {
                "company": {key: company[key] for key in ("companyId", "name", "homepageUrl")},
                "publicSources": [{key: s[key] for key in ("sourceId", "url", "finalUrl", "contentHash")} for s in sources],
            },
            "prompt_version": PROMPT_VERSION, "lane": "enrichment",
        }

    def _verify(self, unit, company_id, configuration_id, sources, result, determination_id, *, observed_at=None):
        determination = unit.determination(company_id, determination_id)
        if determination is None:
            raise failure("briefing_binding_invalid")
        receipt_id = determination["receipt_id"]
        company = unit.configuration(company_id, configuration_id)
        if company is None:
            raise failure("briefing_binding_invalid")
        _validate_company(company, company_id)
        if not 1 <= len(sources) <= MAX_SOURCES or [s["url"] for s in sources] != company["sourceUrls"]:
            raise failure("briefing_binding_invalid")
        hosts = {urlsplit(url).netloc for url in company["sourceUrls"]}
        for source in sources:
            final_url = public_source_url(source["finalUrl"])
            if (
                public_source_url(source["url"]) != source["url"]
                or final_url != source["finalUrl"] or urlsplit(final_url).netloc not in hosts
                or source["sourceId"] != _sha(source["url"]) or source["contentHash"] != _sha(source["text"])
                or not source["text"].strip() or len(source["text"]) > MAX_TEXT
            ):
                raise failure("briefing_binding_invalid")
            observed = datetime.fromisoformat(source["observedAt"])
            if observed.tzinfo is None:
                raise failure("briefing_binding_invalid")
        if observed_at is not None and min(datetime.fromisoformat(s["observedAt"]) for s in sources) != datetime.fromisoformat(observed_at):
            raise failure("briefing_binding_invalid")
        parsed = CompanyBriefingDetermination.model_validate(result)
        validate_result(parsed, sources)
        receipt = unit.receipt(receipt_id)
        if not receipt or receipt.get("status") != "succeeded" or receipt.get("operation") != "companies.briefing":
            raise failure("briefing_binding_invalid")
        selection = {key: receipt[key] for key in ("provider", "model")}
        expected = self.model.fingerprint(**self._model_args(company, sources), selection=selection)
        if (
            receipt.get("receipt_id") != receipt_id or receipt.get("input_fingerprint") != expected
            or determination_id != expected
            or receipt.get("lane") != "enrichment" or receipt.get("prompt_version") != PROMPT_VERSION
            or CompanyBriefingDetermination.model_validate(receipt["value"]).model_dump() != parsed.model_dump()
        ):
            raise failure("briefing_binding_invalid")
        return parsed, receipt

    def _read(self, unit, posting, *, now=None):
        job_id = posting["job_id"]
        link = unit.link(job_id)
        if link is None:
            return None
        company = unit.configuration(link["companyId"])
        if (company is None or link["jobId"] != job_id or not isinstance(link["employerName"], str)
                or not link["employerName"].strip() or len(link["employerName"]) > 500
                or datetime.fromisoformat(link["confirmedAt"]).tzinfo is None):
            raise failure("briefing_binding_invalid")
        _validate_company(company, link["companyId"])
        accepted = unit.accepted(company["companyId"])
        if accepted:
            parsed, receipt = self._verify(unit, company["companyId"], accepted["configurationId"], accepted["sources"],
                                           accepted["result"], accepted["determinationId"], observed_at=accepted["observedAt"])
            if (
                parsed.identity != "confirmed" or not parsed.claims or accepted["companyId"] != company["companyId"]
                or any(accepted[k] != receipt[v] for k, v in (("provider", "provider"), ("model", "model"), ("promptVersion", "prompt_version")))
            ):
                raise failure("briefing_binding_invalid")
        attempt = unit.attempt(company["companyId"])
        if attempt and attempt["failureCode"] == "briefing_identity_needs_review":
            determination = unit.determination(company["companyId"], attempt["determinationId"])
            if not determination:
                raise failure("briefing_binding_invalid")
            result, _ = self._verify(unit, company["companyId"], attempt["configurationId"], attempt["sources"],
                                     determination["result"], attempt["determinationId"])
            if result.identity != "needs_review" or result.identity_reason != attempt["identityReason"]:
                raise failure("briefing_binding_invalid")
        if attempt:
            # Internal source/receipt linkage is not part of the existing strict public DTO.
            attempt.pop("configurationId", None)
            attempt.pop("receiptId", None)
        return briefing_view(company=company, accepted=accepted, attempt=attempt,
                             identity_current=link["employerName"] == posting.get("company"),
                             now=now or datetime.fromisoformat(self.clock()))

    def read(self, job_id, *, now=None):
        with self.history.read() as unit:
            posting = unit.posting(job_id)
            try:
                return self._read(unit, posting, now=now)
            except (AppError, ValueError, KeyError, TypeError, ValidationError):
                return {"company": None, "accepted": None, "lastAttempt": None, "staleReasons": [], "status": "unavailable"}

    def summaries(self, *, now=None):
        with self.history.read() as unit:
            job_ids = unit.recent_linked_jobs(100)
        result, seen = [], set()
        for job_id in job_ids:
            try:
                with self.history.read() as unit:
                    posting = unit.posting(job_id)
                    if posting.get("hidden") or posting.get("deleted"):
                        continue
                    try:
                        view = self._read(unit, posting, now=now)
                    except (AppError, ValueError, KeyError, TypeError, ValidationError):
                        view = {"company": None, "accepted": None, "lastAttempt": None, "staleReasons": [], "status": "unavailable"}
            except NotFoundError:
                continue
            if not view or not view["company"] or "identity_review_required" in view["staleReasons"]:
                continue
            company = view["company"]
            if company["companyId"] in seen:
                continue
            seen.add(company["companyId"])
            result.append({"companyId": company["companyId"], "name": company["name"], "jobId": job_id,
                           "status": view["status"], "staleReasons": view["staleReasons"],
                           "observedAt": view["accepted"]["observedAt"] if view["accepted"] else None,
                           "failureCode": view["lastAttempt"]["failureCode"] if view["lastAttempt"] else None})
            if len(result) == 5:
                break
        return result

    def digest_summary(self, *, now=None):
        return {"companyBriefings": self.summaries(now=now)}

    def remove_job_links(self, job_id: str, unit: CompanyUnitOfWork):
        """Remove only the explicitly deleted job's links in its owner's unit of work."""
        unit.delete_job_links(job_id)

    async def _wait(self, awaitable, cancelled):
        task = asyncio.ensure_future(awaitable)
        try:
            while not task.done():
                if cancelled():
                    task.cancel()
                    raise failure("briefing_cancelled", 409)
                await asyncio.wait({task}, timeout=0.05)
            return await task
        except asyncio.CancelledError:
            task.cancel()
            raise

    async def refresh(self, job_id, *, allow_public_fetch=False, force=False, cancelled=lambda: False):
        if allow_public_fetch is not True:
            raise failure("briefing_public_fetch_opt_in_required")
        initial = self.read(job_id)
        if initial is not None and initial["status"] == "unavailable":
            raise failure("briefing_binding_invalid", 409)
        if initial is None or "identity_review_required" in initial["staleReasons"]:
            raise failure("briefing_identity_confirmation_required", 409)
        company_id = initial["company"]["companyId"]
        async with self.locks.hold(company_id, cancelled=cancelled):
            view = self.read(job_id, now=datetime.fromisoformat(self.clock()))
            if (not view or not view["company"] or "identity_review_required" in view["staleReasons"]
                    or view["company"]["companyId"] != company_id or view["company"]["revision"] != initial["company"]["revision"]):
                raise failure("briefing_sources_changed", 409)
            if view["lastAttempt"] != initial["lastAttempt"]:
                if view["lastAttempt"] and view["lastAttempt"]["failureCode"]:
                    raise failure(view["lastAttempt"]["failureCode"], 409)
                return view
            if view["status"] == "current" and not force:
                return view
            with self.history.read() as unit:
                posting = unit.posting(job_id)
                link = unit.link(job_id)
            company, started = view["company"], self.clock()
            if (not link or link["companyId"] != company_id or posting.get("company") != link["employerName"]):
                raise failure("briefing_sources_changed", 409)
            sources, receipt_id, parsed, fingerprint = [], None, None, None
            try:
                async for url, page in self.pages.pages(company["sourceUrls"], cancelled=cancelled):
                    if len(sources) >= len(company["sourceUrls"]) or url != company["sourceUrls"][len(sources)]:
                        raise failure("briefing_source_unavailable", 409)
                    if page.outcome != "allowed" or page.status != 200 or not page.text.strip():
                        raise failure("briefing_source_unavailable", 409)
                    final_url = public_source_url(page.final_url)
                    if urlsplit(final_url).netloc not in {urlsplit(source).netloc for source in company["sourceUrls"]}:
                        raise failure("briefing_source_unavailable", 409)
                    text = page.text[:MAX_TEXT]
                    sources.append({"sourceId": _sha(url), "url": url, "finalUrl": final_url,
                                    "observedAt": self.clock(), "contentHash": _sha(text), "text": text})
                if len(sources) != len(company["sourceUrls"]):
                    raise failure("briefing_source_unavailable", 409)
                args = self._model_args(company, sources)
                selection = self.model.selection()
                fingerprint = self.model.fingerprint(**args, selection=selection)
                with self.history.read() as unit:
                    cached = unit.determination(company_id, fingerprint)
                    if cached:
                        parsed, receipt = self._verify(unit, company_id, cached["configuration_id"],
                                                       cached["sources"], cached["result"], fingerprint)
                        receipt_id = receipt["receipt_id"]
                        validate_result(parsed, sources)
                if parsed is None:
                    outcome = await self._wait(self.model.determine(**args), cancelled)
                    receipt_id = outcome.provenance["receipt_id"]
                    parsed = CompanyBriefingDetermination.model_validate(outcome.value)
                    validate_result(parsed, sources)
                    # The selected settings might have changed between fingerprint and determine.
                    fingerprint = outcome.provenance["input_fingerprint"]
                if cancelled():
                    raise failure("briefing_cancelled", 409)
                with self.history.write() as unit:
                    current = unit.configuration(company_id)
                    current_link = unit.link(job_id)
                    current_posting = unit.assert_posting_current(job_id, posting["revision"], posting.get("source_hash"))
                    if current != company or current_link != link or current_posting.get("company") != link["employerName"]:
                        raise failure("briefing_sources_changed", 409)
                    unit.record_determination(fingerprint, company_id, receipt_id, company["revision"], sources, parsed.model_dump())
                    _, receipt = self._verify(unit, company_id, company["revision"], sources, parsed.model_dump(), fingerprint)
                    if parsed.identity != "confirmed":
                        raise failure("briefing_identity_needs_review", 409)
                    if not parsed.claims:
                        raise failure("briefing_no_supported_claims", 409)
                    unit.record_accepted(company_id, {
                        "companyId": company_id, "configurationId": company["revision"],
                        "observedAt": min(s["observedAt"] for s in sources), "acceptedAt": self.clock(),
                        "promptVersion": receipt["prompt_version"], "determinationId": fingerprint,
                        "provider": receipt["provider"], "model": receipt["model"], "sources": sources, "result": parsed.model_dump(),
                    })
                    unit.record_attempt(company_id, {
                        "startedAt": started, "finishedAt": self.clock(), "failureCode": None,
                        "determinationId": fingerprint, "sources": [], "identityReason": None,
                    })
                    unit.notify_linked_jobs(company_id)
            except (Exception, asyncio.CancelledError) as error:
                code = ("briefing_cancelled" if isinstance(error, asyncio.CancelledError)
                        else error.code if isinstance(error, AppError) else "briefing_refresh_failed")
                if receipt_id is None and isinstance(error, AppError) and error.details:
                    receipt_id = error.details.get("receiptId")
                try:
                    with self.history.write() as unit:
                        determination_id = None
                        if code in {"briefing_identity_needs_review", "briefing_no_supported_claims"} and parsed is not None:
                            unit.record_determination(fingerprint, company_id, receipt_id, company["revision"], sources, parsed.model_dump())
                            self._verify(unit, company_id, company["revision"], sources, parsed.model_dump(), fingerprint)
                            determination_id = fingerprint
                        unit.record_attempt(company_id, {
                            "startedAt": started, "finishedAt": self.clock(), "failureCode": code,
                            "determinationId": determination_id, "receiptId": receipt_id, "sources": sources if receipt_id else [],
                            "configurationId": company["revision"],
                            "identityReason": parsed.identity_reason if parsed is not None and code == "briefing_identity_needs_review" else None,
                        })
                        unit.notify_linked_jobs(company_id)
                except Exception:
                    raise failure("briefing_failure_record_unavailable", 500) from None
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise failure(code, 409) from None
            return self.read(job_id, now=datetime.fromisoformat(self.clock()))
