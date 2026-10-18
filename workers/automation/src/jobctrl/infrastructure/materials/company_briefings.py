"""Immutable briefing ledger and explicit local refresh on exact-v14 storage."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json

from jobctrl.domain.determinations import DeterminationFailure, Source, validate_citations
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.company_briefings import (
    CompanyBriefingDetermination,
    MAX_SOURCES,
    MAX_TEXT,
    PROMPT_VERSION,
    briefing_view,
    company_key,
    draft_briefing,
    public_source_url,
    validate_briefing_result,
)
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository, determination_dependencies

CONFIG = "company_briefing_config"
LINK = "company_briefing_link"
ACCEPTED = "company_briefing_accepted"
ATTEMPT = "company_briefing_attempt"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class CompanyBriefingRepository:
    def __init__(self, connection, tenant="local"):
        self.connection, self.tenant = connection, tenant

    @contextmanager
    def atomic(self):
        conn = self.connection
        if conn.in_transaction:
            raise DeterminationFailure("briefing_transaction_active")
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            conn.commit()
        except BaseException:
            conn.rollback()
            raise

    def latest(self, kind, entity):
        row = self.connection.execute(
            "SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND entity_kind=? AND entity_ref=? ORDER BY event_id DESC LIMIT 1",
            (self.tenant, kind, entity),
        ).fetchone()
        return {**json.loads(row[1]), "revision": row[0]} if row else None

    def append(self, kind, entity, data, *, job=None):
        cursor = self.connection.execute(
            "INSERT INTO job_events(tenant_id,job_id,identity_version,event_type,message,occurred_at,payload_json,entity_kind,entity_ref) VALUES(?,?,1,'CompanyBriefingRecorded','Company briefing history updated',?,?,?,?)",
            (self.tenant, job, utc_now(), json.dumps(data, ensure_ascii=False), kind, entity),
        )
        return {**data, "revision": cursor.lastrowid}

    def job(self, job_id):
        job_id = str(canonical_job_id(job_id))
        row = self.connection.execute(
            "SELECT company FROM jobs WHERE tenant_id=? AND job_id=?", (self.tenant, job_id)
        ).fetchone()
        if row is None:
            raise DeterminationFailure("briefing_job_not_found")
        return job_id, row[0]

    def configure(self, job_id, *, homepage_url, source_urls, confirm_identity):
        if confirm_identity is not True:
            raise DeterminationFailure("briefing_identity_confirmation_required")
        homepage = public_source_url(homepage_url)
        urls = [public_source_url(url) for url in source_urls]
        if not 1 <= len(urls) <= MAX_SOURCES or len(set(urls)) != len(urls):
            raise DeterminationFailure("briefing_source_limit")
        company_id = company_key(homepage)
        with self.atomic():
            job_id, employer = self.job(job_id)
            if not isinstance(employer, str) or not employer.strip() or len(employer) > 500:
                raise DeterminationFailure("briefing_identity_confirmation_required")
            previous = self.latest(CONFIG, company_id)
            if previous is None or previous["sourceUrls"] != urls:
                self.append(
                    CONFIG,
                    company_id,
                    {
                        "companyId": company_id,
                        "name": previous["name"] if previous else employer,
                        "homepageUrl": homepage,
                        "sourceUrls": urls,
                        "configuredAt": utc_now(),
                    },
                )
            self.append(
                LINK,
                job_id,
                {"companyId": company_id, "jobId": job_id, "employerName": employer, "confirmedAt": utc_now()},
                job=job_id,
            )
            self.notify(company_id)
        return self.read(job_id)

    def read(self, job_id, *, now=None):
        self.job(job_id)
        try:
            return self._read(job_id, now=now)
        except (DeterminationFailure, ValueError, KeyError, TypeError):
            return {"company": None, "accepted": None, "lastAttempt": None, "staleReasons": [], "status": "unavailable"}

    def _read(self, job_id, *, now=None):
        job_id, employer = self.job(job_id)
        link = self.latest(LINK, job_id)
        if link is None:
            return None
        company = self.latest(CONFIG, link["companyId"])
        if (
            company is None
            or company["companyId"] != link["companyId"]
            or company_key(company["homepageUrl"]) != company["companyId"]
        ):
            raise DeterminationFailure("briefing_binding_invalid")
        accepted = self.latest(ACCEPTED, link["companyId"])
        if accepted:
            envelope = SqliteDeterminationRepository(self.connection).find(self.tenant, accepted["determinationId"])
            if (
                envelope is None
                or envelope.kind != "company_briefing"
                or envelope.entity_id != company["companyId"]
                or envelope.result != accepted["result"]
                or envelope.schema_version != "1"
                or envelope.provider != accepted["provider"]
                or envelope.model != accepted["model"]
                or envelope.prompt_version != accepted["promptVersion"]
                or accepted["companyId"] != company["companyId"]
            ):
                raise DeterminationFailure("briefing_binding_invalid")
            bound_config = self.connection.execute(
                "SELECT payload_json FROM job_events WHERE tenant_id=? AND entity_kind=? AND entity_ref=? AND event_id=?",
                (self.tenant, CONFIG, company["companyId"], accepted["configurationId"]),
            ).fetchone()
            if (
                bound_config is None
                or [source["url"] for source in accepted["sources"]] != json.loads(bound_config[0])["sourceUrls"]
            ):
                raise DeterminationFailure("briefing_binding_invalid")
            result = CompanyBriefingDetermination.model_validate(accepted["result"])
            if result.identity != "confirmed" or not result.claims or not 1 <= len(accepted["sources"]) <= MAX_SOURCES:
                raise DeterminationFailure("briefing_binding_invalid")
            for source in accepted["sources"]:
                if (
                    hashlib.sha256(source["text"].encode()).hexdigest() != source["contentHash"]
                    or hashlib.sha256(source["url"].encode()).hexdigest() != source["sourceId"]
                    or len(source["text"]) > MAX_TEXT
                ):
                    raise DeterminationFailure("briefing_binding_invalid")
                public_source_url(source["url"])
                public_source_url(source["finalUrl"])
            if min(
                datetime.fromisoformat(source["observedAt"]) for source in accepted["sources"]
            ) != datetime.fromisoformat(accepted["observedAt"]):
                raise DeterminationFailure("briefing_binding_invalid")
            validate_citations(
                result, [Source(source_id=source["sourceId"], text=source["text"]) for source in accepted["sources"]]
            )
            validate_briefing_result(result)
        attempt = self.latest(ATTEMPT, company["companyId"])
        if attempt and attempt["failureCode"] == "briefing_identity_needs_review":
            rejected = SqliteDeterminationRepository(self.connection).find(self.tenant, attempt["determinationId"])
            if (
                rejected is None
                or rejected.kind != "company_briefing"
                or rejected.entity_id != company["companyId"]
                or rejected.result["identity"] != "needs_review"
                or rejected.result["identity_reason"] != attempt["identityReason"]
            ):
                raise DeterminationFailure("briefing_binding_invalid")
            validate_citations(
                CompanyBriefingDetermination.model_validate(rejected.result),
                [Source(source_id=source["sourceId"], text=source["text"]) for source in attempt["sources"]],
            )
        return briefing_view(
            company=company,
            accepted=accepted,
            attempt=attempt,
            identity_current=link["employerName"] == employer,
            now=now,
        )

    def notify(self, company_id):
        # Only recorded references reach ordinary SSE; never source bodies.
        rows = self.connection.execute(
            "SELECT e.entity_ref FROM job_events e JOIN jobs j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id "
            "WHERE e.tenant_id=? AND e.entity_kind=? AND e.event_id=(SELECT max(x.event_id) FROM job_events x WHERE x.tenant_id=e.tenant_id AND x.entity_kind=e.entity_kind AND x.entity_ref=e.entity_ref) "
            "AND json_extract(e.payload_json,'$.companyId')=?",
            (self.tenant, LINK, company_id),
        ).fetchall()
        for row in rows:
            self.connection.execute(
                "INSERT INTO job_events(tenant_id,job_id,identity_version,event_type,message,occurred_at,payload_json,entity_kind,entity_ref) VALUES(?,?,1,'JobUpdated','Company briefing updated',?,?,'company_briefing_notification',?)",
                (
                    self.tenant,
                    row[0],
                    utc_now(),
                    json.dumps({"jobId": row[0], "changedFields": {"companyBriefing": company_id}}),
                    company_id,
                ),
            )

    def summaries(self, *, now=None):
        rows = self.connection.execute(
            "SELECT e.entity_ref FROM job_events e JOIN jobs j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id "
            "WHERE e.tenant_id=? AND e.entity_kind=? AND e.event_id=(SELECT max(x.event_id) FROM job_events x WHERE x.tenant_id=e.tenant_id AND x.entity_kind=e.entity_kind AND x.entity_ref=e.entity_ref) "
            "AND NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.tenant_id=e.tenant_id AND h.job_id=e.job_id AND h.unhidden_at IS NULL) "
            "AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=e.tenant_id AND d.job_id=e.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at))) "
            "ORDER BY e.event_id DESC LIMIT 100",
            (self.tenant, LINK),
        ).fetchall()
        result, seen = [], set()
        for row in rows:
            view = self.read(row[0], now=now)
            if (
                view is None
                or view["company"] is None
                or "identity_review_required" in view["staleReasons"]
                or view["company"]["companyId"] in seen
            ):
                continue
            seen.add(view["company"]["companyId"])
            result.append(
                {
                    "companyId": view["company"]["companyId"],
                    "name": view["company"]["name"],
                    "jobId": row[0],
                    "status": view["status"],
                    "staleReasons": view["staleReasons"],
                    "observedAt": view["accepted"]["observedAt"] if view["accepted"] else None,
                    "failureCode": view["lastAttempt"]["failureCode"] if view["lastAttempt"] else None,
                }
            )
            if len(result) == 5:
                break
        return result


def refresh_briefing(
    repository, job_id, *, allow_public_fetch=False, force=False, fetcher=None, dependencies=None, clock=utc_now
):
    if repository.connection.in_transaction:
        raise DeterminationFailure("briefing_transaction_active")
    if allow_public_fetch is not True:
        raise DeterminationFailure("briefing_public_fetch_opt_in_required")
    initial = repository.read(job_id)
    if initial is not None and initial["status"] == "unavailable":
        raise DeterminationFailure("briefing_binding_invalid")
    if initial is None or "identity_review_required" in initial["staleReasons"]:
        raise DeterminationFailure("briefing_identity_confirmation_required")
    company_id = initial["company"]["companyId"]
    initial_attempt = initial["lastAttempt"]
    locks = SqliteDeterminationRepository(repository.connection)
    with locks.lock(repository.tenant, "company-briefing-refresh:" + company_id):
        view = repository.read(job_id, now=datetime.fromisoformat(clock()))
        if (
            view is None
            or view["company"] is None
            or "identity_review_required" in view["staleReasons"]
            or view["company"]["companyId"] != company_id
        ):
            raise DeterminationFailure("briefing_sources_changed")
        if view["company"]["revision"] != initial["company"]["revision"]:
            raise DeterminationFailure("briefing_sources_changed")
        if view["lastAttempt"] != initial_attempt:
            if view["lastAttempt"] and view["lastAttempt"]["failureCode"]:
                raise DeterminationFailure(view["lastAttempt"]["failureCode"])
            return view
        if view["status"] == "current" and not force:
            return view
        company, link = view["company"], repository.latest(LINK, job_id)
        started = clock()
        envelope = None
        sources = []
        try:
            if fetcher is None:
                from jobctrl.infrastructure.materials.company_briefing_fetcher import company_briefing_fetcher

                fetcher = company_briefing_fetcher(company["sourceUrls"], connection=repository.connection)
            for url in company["sourceUrls"]:
                try:
                    page = fetcher.fetch(url)
                finally:
                    # The gateway records denied/rate-limited attempts without committing.
                    # This explicit command owns that short operational transaction.
                    repository.connection.commit()
                if page.outcome != "allowed" or page.status != 200 or not page.text.strip():
                    raise DeterminationFailure("briefing_source_unavailable")
                text = page.text[:MAX_TEXT]
                sources.append(
                    {
                        "sourceId": hashlib.sha256(url.encode()).hexdigest(),
                        "url": url,
                        "finalUrl": public_source_url(page.final_url),
                        "observedAt": clock(),
                        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
                        "text": text,
                    }
                )
            deps = dependencies or determination_dependencies(
                repository.connection, tenant_id=repository.tenant, lane="enrichment"
            )
            result, envelope = draft_briefing(company=company, sources=sources, dependencies=deps)
            if result.identity != "confirmed":
                raise DeterminationFailure("briefing_identity_needs_review")
            if not result.claims:
                raise DeterminationFailure("briefing_no_supported_claims")
            with repository.atomic():
                current = repository.latest(CONFIG, company_id)
                fresh_link = repository.latest(LINK, job_id)
                _, employer = repository.job(job_id)
                if current != company or fresh_link != link or employer != link["employerName"]:
                    raise DeterminationFailure("briefing_sources_changed")
                repository.append(
                    ACCEPTED,
                    company_id,
                    {
                        "companyId": company_id,
                        "configurationId": company["revision"],
                        "observedAt": min(source["observedAt"] for source in sources),
                        "acceptedAt": clock(),
                        "promptVersion": PROMPT_VERSION,
                        "determinationId": envelope.determination_id,
                        "provider": envelope.provider,
                        "model": envelope.model,
                        "sources": sources,
                        "result": result.model_dump(),
                    },
                )
                repository.append(
                    ATTEMPT,
                    company_id,
                    {
                        "startedAt": started,
                        "finishedAt": clock(),
                        "failureCode": None,
                        "determinationId": envelope.determination_id,
                        "sources": [],
                        "identityReason": None,
                    },
                )
                repository.notify(company_id)
        except Exception as error:
            code = error.code if isinstance(error, DeterminationFailure) else "briefing_refresh_failed"
            try:
                with repository.atomic():
                    repository.append(
                        ATTEMPT,
                        company_id,
                        {
                            "startedAt": started,
                            "finishedAt": clock(),
                            "failureCode": code,
                            "determinationId": envelope.determination_id if envelope else None,
                            "sources": sources if envelope else [],
                            "identityReason": envelope.result["identity_reason"]
                            if envelope and code == "briefing_identity_needs_review"
                            else None,
                        },
                    )
                    repository.notify(company_id)
            except Exception:
                raise DeterminationFailure("briefing_failure_record_unavailable") from None
            raise DeterminationFailure(code) from None
        return repository.read(job_id, now=datetime.fromisoformat(clock()))
