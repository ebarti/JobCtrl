"""One Jobs-grid read composition over the owners' bounded public bulk ports.

This module owns no feature tables. It evaluates literal user filters and
arithmetic over recorded scalar values, then sorts globally before pagination.
All owner reads share one SQLite snapshot. Full posting/audit DTOs are hydrated
only for the selected page; the global scan retains scalars and revision refs.
"""

from __future__ import annotations

import hashlib
import json
import math
import unicodedata
from datetime import datetime, timezone
from functools import cmp_to_key
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError

BATCH_SIZE = 200
FACET_LIMIT = 200
FIELDS = (
    "title", "company", "location", "source", "job_state", "fit_score", "current_stage", "current_state",
    "discovered_at", "scored_at", "compensation_min_eur", "compensation_max_eur", "compensation_posted",
    "compensation_market", "compensation_confidence", "compensation_warnings", "apply_status", "resume_template",
)
FIELD_OWNER = {
    **dict.fromkeys(("fit_score", "scored_at"), "fit"),
    **dict.fromkeys(("current_stage", "current_state"), ("preparation", "applications")),
    **dict.fromkeys((field for field in FIELDS if field.startswith("compensation_")), "compensation"),
    "apply_status": "applications", "resume_template": "resumes",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def literal(value) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold()


def instant(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return math.floor(result.timestamp() * 1000)


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def choices(value):
    return tuple(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))


class Value(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class ColumnFilter(Value):
    operator: Literal["contains", "does_not_contain"] = "contains"
    text: str = Field(default="", max_length=1000)
    selectedValues: list[str] = Field(default_factory=list, max_length=200)


class JobListQuery(Value):
    q: str = Field(default="", max_length=1000)
    job_state: str = Field(default="active", max_length=100)
    source: str = Field(default="", max_length=1000)
    company: str = Field(default="", max_length=1000)
    min_fit_score: int | None = Field(default=None, ge=1, le=10)
    max_fit_score: int | None = Field(default=None, ge=1, le=10)
    fit_state: Literal["all", "current", "stale", "unassessed"] = "all"
    normalized_score_keyword: str = Field(default="", max_length=500)
    stage: str = Field(default="", max_length=500)
    state: str = Field(default="", max_length=500)
    apply_status: str = Field(default="", max_length=500)
    resume_template: str = Field(default="", max_length=500)
    discovered_since: str | None = None
    scored_since: str | None = None
    posted_min_eur: float | None = Field(default=None, ge=0)
    posted_max_eur: float | None = Field(default=None, ge=0)
    market_min_eur: float | None = Field(default=None, ge=0)
    market_max_eur: float | None = Field(default=None, ge=0)
    posted_known: Literal["all", "known", "unknown"] = "all"
    market_known: Literal["all", "known", "unknown"] = "all"
    compensation_confidence: str = Field(default="", max_length=100)
    compensation_warnings: Literal["all", "present", "none"] = "all"
    column_filters: dict[str, ColumnFilter] = Field(default_factory=dict)
    sort: str = "discovered_at"
    direction: Literal["asc", "desc"] = "desc"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=200)
    query_revision: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def validate_query(self):
        if self.sort not in FIELDS or set(self.column_filters) - set(FIELDS):
            raise ValueError("unknown_grid_field")
        if not choices(self.job_state) or set(choices(self.job_state)) - {"active", "closed", "hidden", "deleted", "all"}:
            raise ValueError("unknown_job_state")
        if (self.min_fit_score is not None and self.max_fit_score is not None
                and self.min_fit_score > self.max_fit_score):
            raise ValueError("inverted_score_range")
        for value in (self.discovered_since, self.scored_since):
            if value is not None and instant(value) is None:
                raise ValueError("invalid_timestamp")
        if set(choices(self.compensation_confidence)) - {"none", "low", "medium", "high"}:
            raise ValueError("unknown_confidence")
        for value in (self.posted_min_eur, self.posted_max_eur, self.market_min_eur, self.market_max_eur):
            if value is not None and not math.isfinite(value):
                raise ValueError("invalid_compensation_amount")
        return self

    @classmethod
    def from_params(cls, params):
        values = dict(params)
        aliases = {"deleted": "job_state", "status": "job_state", "jobStates": "job_state", "dir": "direction",
                   "minFitScore": "min_fit_score", "maxFitScore": "max_fit_score", "discoveredSince": "discovered_since",
                   "scoredSince": "scored_since", "normalizedScoreKeyword": "normalized_score_keyword",
                   "applyStatus": "apply_status", "stages": "stage"}
        for old, new in aliases.items():
            if old in values:
                if new in values and values[new] != values[old]:
                    raise AppError("invalid_job_query", "The Jobs query contains conflicting field aliases.", 422)
                values[new] = values.pop(old)
        if "page" in values or "pageSize" in values or "page_size" in values:
            page = int(values.pop("page", 1))
            size = int(values.pop("pageSize", values.pop("page_size", 50)))
            if page < 1:
                raise ValueError("invalid_page")
            values.setdefault("offset", (page - 1) * size)
            values.setdefault("limit", size)
        for field in ("offset", "limit", "min_fit_score", "max_fit_score"):
            if field in values:
                values[field] = int(values[field])
        for field in ("posted_min_eur", "posted_max_eur", "market_min_eur", "market_max_eur"):
            if field in values:
                values[field] = float(values[field])
        if "column_filters" in values:
            values["column_filters"] = json.loads(values["column_filters"])
        for field in ("stage", "state", "apply_status", "resume_template"):
            if values.get(field) == "all":
                values[field] = ""
        return cls.model_validate(values)


class JobQueryRow(Value):
    job: dict[str, Any]
    fit: dict[str, Any] | None
    preparation: dict[str, Any] | None
    compensation: dict[str, Any] | None
    application: dict[str, Any] | None
    resume: dict[str, Any] | None
    scalars: dict[str, str | int | float | None]
    revisions: dict[str, Any]


class JobQueryResult(Value):
    rows: list[JobQueryRow]
    total: int
    offset: int
    limit: int
    query_revision: str
    modules: dict[str, dict[str, bool]]
    capabilities: dict[str, list[str]]
    facets: dict[str, dict[str, Any]]


class JobQueries:
    def __init__(self, application):
        self.application = application
        self.database = application.runtime.database
        self.jobs = application.services["jobs"]
        self.owners = {name: application.services.get(name) for name in (
            "fit", "preparation", "compensation", "applications", "resumes",
        )}

    def _modules(self):
        return {name: {"enabled": owner is not None, "available": owner is not None and callable(getattr(
            owner, "query_summaries" if name == "fit" else "job_summaries", None))}
            for name, owner in self.owners.items()}

    @staticmethod
    def _field_available(field, modules):
        owners = FIELD_OWNER.get(field)
        if owners is None:
            return True
        if isinstance(owners, str):
            owners = (owners,)
        return any(modules[owner]["available"] for owner in owners)

    @staticmethod
    def _required(query):
        fields = {query.sort, *[key for key, value in query.column_filters.items()
                                if value.text.strip() or value.selectedValues]}
        if any(value is not None for value in (query.min_fit_score, query.max_fit_score)) or query.fit_state != "all" or query.normalized_score_keyword:
            fields.add("fit_score")
        if query.scored_since is not None:
            fields.add("scored_at")
        if query.stage:
            fields.add("current_stage")
        if query.state:
            fields.add("current_state")
        if query.apply_status:
            fields.add("apply_status")
        if query.resume_template:
            fields.add("resume_template")
        if (any(value is not None for value in (query.posted_min_eur, query.posted_max_eur, query.market_min_eur,
                                               query.market_max_eur)) or query.posted_known != "all"
                or query.market_known != "all" or query.compensation_confidence or query.compensation_warnings != "all"):
            fields.add("compensation_min_eur")
        return fields

    def _bulk(self, ids, connection, *, postings=None):
        values = {}
        for name, owner in self.owners.items():
            method = getattr(owner, "query_summaries" if name == "fit" else "job_summaries", None)
            values[name] = (method(ids, connection=connection, postings=postings) if name == "fit"
                            else method(ids, connection=connection)) if method is not None else {}
        return values

    @staticmethod
    def _revisions(job, data, ident):
        result = {"jobs": {key: job[key] for key in ("revision", "state_revision", "source_hash")}}
        for name, values in data.items():
            value = values.get(ident)
            reference = {"fingerprint": digest(value)}
            if name == "fit":
                score = (value or {}).get("score") or {}
                reference.update(score_revision=score.get("revision"), source_binding=score.get("source_binding"))
            elif name == "preparation":
                reference.update({key: (value or {}).get(key) for key in ("run_id", "stage", "updated_at")})
            elif name == "compensation":
                audit = (value or {}).get("audit") or {}
                receipt = (audit.get("posted") or {}).get("determination") or {}
                estimate = (audit.get("market") or {}).get("estimate") or {}
                reference.update(posted_receipt_id=receipt.get("receipt_id"), market_estimated_at=estimate.get("estimatedAt"))
            elif name == "applications":
                reference.update({key: (value or {}).get(key) for key in ("application_revision", "payload_id", "run_id")})
            elif name == "resumes":
                reference.update({key: (value or {}).get(key) for key in ("revision_id", "accepted_revision_id", "acceptance_id")})
            result[name] = reference
        return result

    @staticmethod
    def _scalars(job, fit, prep, compensation, application, resume):
        state = "hidden" if job["hidden"] else "deleted" if job["deleted"] else (
            "closed" if job.get("active_state") in {"closed", "expired", "removed", "location_incompatible"} else "active")
        score = (fit or {}).get("score") or {}
        score_available = not {"contract_changed", "unsupported_posting_language"}.intersection(
            (fit or {}).get("stale_reasons", []))
        summary = (compensation or {}).get("summary") or {}
        audit = (compensation or {}).get("audit") or {}
        posted, market = summary.get("posted") or {}, summary.get("market") or {}
        p_current = (audit.get("posted") or {}).get("sourceCurrent") is True and posted.get("recordStatus") == "recorded"
        market_audit = audit.get("market") or {}
        m_current = (market_audit.get("sourceCurrent") is True and market_audit.get("evidenceFresh") is True
                     and market.get("recordStatus") == "recorded")
        p_range = (posted.get("range") or {}) if p_current else {}
        m_range = (market.get("range") or {}) if m_current else {}
        p_min = number(p_range.get("annualizedMinimumAmount")) if p_range.get("currency") == "EUR" else None
        p_max = number(p_range.get("annualizedMaximumAmount")) if p_range.get("currency") == "EUR" else None
        m_min = number(m_range.get("minimumAmount")) if m_range.get("currency") == "EUR" and m_range.get("period") == "year" else None
        m_max = number(m_range.get("maximumAmount")) if m_range.get("currency") == "EUR" and m_range.get("period") == "year" else None
        template = (resume or {}).get("template") or {}
        effective = ((resume or {}).get("resume_template") or {}).get("effective") or {}
        warning_counts = [part.get("warningCount") for part, current in ((posted, p_current), (market, m_current)) if current]
        warnings = sum(value for value in warning_counts if type(value) is int) if warning_counts else None
        status = prep or {}
        if (application or {}).get("stage") is not None and (
            instant((application or {}).get("updated_at")) is not None and (
                instant(status.get("updated_at")) is None
                or instant(application["updated_at"]) >= instant(status["updated_at"]))
        ):
            status = application
        scalars = {"title": job.get("title") or None, "company": job.get("company") or None,
                   "location": job.get("location") or None, "source": job.get("source_id") or None,
                   "job_state": state, "fit_score": score.get("score") if score_available else None,
                   "current_stage": status.get("stage"), "current_state": status.get("state"),
                   "discovered_at": job.get("created_at"), "scored_at": score.get("created_at"),
                   "compensation_min_eur": p_min, "compensation_max_eur": p_max, "compensation_posted": p_min,
                   "compensation_market": m_min, "compensation_confidence": market.get("confidenceBand") if m_current else None,
                   "compensation_warnings": warnings, "apply_status": (application or {}).get("apply_status"),
                   "resume_template": template.get("name") or template.get("templateName")
                   or template.get("template_name") or effective.get("templateName")}
        extras = {"market_min": m_min, "market_max": m_max,
                  "confidence_score": number(market.get("confidenceScore")) if m_current else None,
                  "fit_recorded": bool(score),
                  "fit_current": (fit or {}).get("current", False),
                  "keywords": (fit or {}).get("normalized_keywords", []),
                  "url": job.get("url", "")}
        return scalars, extras

    @staticmethod
    def _matches(query, row, *, columns=True):
        values, extra = row["scalars"], row["extra"]
        states = choices(query.job_state)
        if "all" not in states and values["job_state"] not in states:
            return False
        search = " ".join(str(value) for value in (
            *[values[field] for field in ("title", "company", "location", "source", "current_stage", "current_state")],
            extra["url"],
        ) if value is not None)
        if query.q and literal(query.q) not in literal(search):
            return False
        for field in ("source", "company"):
            if getattr(query, field) and literal(getattr(query, field)) not in literal(values[field]):
                return False
        for field, selected in (("current_stage", query.stage), ("current_state", query.state),
                                ("apply_status", query.apply_status), ("resume_template", query.resume_template)):
            if selected and values[field] not in choices(selected):
                return False
        score = values["fit_score"]
        if query.min_fit_score is not None and (score is None or score < query.min_fit_score):
            return False
        if query.max_fit_score is not None and (score is None or score > query.max_fit_score):
            return False
        if query.fit_state == "unassessed" and extra["fit_recorded"]:
            return False
        if query.fit_state == "current" and not extra["fit_current"]:
            return False
        if query.fit_state == "stale" and (not extra["fit_recorded"] or extra["fit_current"]):
            return False
        if query.normalized_score_keyword and query.normalized_score_keyword not in extra["keywords"]:
            return False
        dates = [(values["discovered_at"], query.discovered_since), (values["scored_at"], query.scored_since)]
        if any(cutoff is not None for _, cutoff in dates) and not any(
            cutoff is not None and instant(value) is not None and instant(value) >= instant(cutoff) for value, cutoff in dates
        ):
            return False
        for value, minimum, maximum in ((values["compensation_min_eur"], query.posted_min_eur, None),
                                        (values["compensation_max_eur"], None, query.posted_max_eur),
                                        (extra["market_min"], query.market_min_eur, None),
                                        (extra["market_max"], None, query.market_max_eur)):
            if minimum is not None and (value is None or value < minimum) or maximum is not None and (value is None or value > maximum):
                return False
        for known, low, high in ((query.posted_known, values["compensation_min_eur"], values["compensation_max_eur"]),
                                  (query.market_known, extra["market_min"], extra["market_max"])):
            present = low is not None or high is not None
            if known == "known" and not present or known == "unknown" and present:
                return False
        if query.compensation_confidence and values["compensation_confidence"] not in choices(query.compensation_confidence):
            return False
        warnings = values["compensation_warnings"]
        if query.compensation_warnings == "present" and (warnings is None or warnings <= 0):
            return False
        if query.compensation_warnings == "none" and warnings != 0:
            return False
        if columns:
            for field, filter_ in query.column_filters.items():
                text = "" if values[field] is None else str(values[field])
                if filter_.selectedValues and text not in filter_.selectedValues:
                    return False
                if filter_.text.strip():
                    contains = literal(filter_.text.strip()) in literal(text)
                    if contains != (filter_.operator == "contains"):
                        return False
        return True

    @staticmethod
    def _compare(query, left, right):
        def value(row):
            raw = row["scalars"][query.sort]
            if query.sort in {"discovered_at", "scored_at"}:
                return instant(raw)
            if query.sort == "compensation_confidence":
                return row["extra"]["confidence_score"] if row["extra"]["confidence_score"] is not None else (
                    {"none": 0, "low": 1, "medium": 2, "high": 3}.get(raw))
            return literal(raw) if isinstance(raw, str) else raw
        a, b = value(left), value(right)
        if a is None or b is None:
            comparison = 0 if a is b else 1 if a is None else -1
        else:
            comparison = ((a > b) - (a < b)) * (1 if query.direction == "asc" else -1)
        return comparison or ((left["job_id"] > right["job_id"]) - (left["job_id"] < right["job_id"]))

    def query(self, query: JobListQuery) -> dict:
        modules = self._modules()
        unavailable = sorted(field for field in self._required(query) if not self._field_available(field, modules))
        if unavailable:
            raise AppError("query_feature_unavailable", "Selected Jobs criteria require an unavailable feature.", 409,
                           {"fields": unavailable, "modules": modules})
        candidates = []
        with self.database.connect() as connection:
            connection.execute("BEGIN")
            offset = 0
            while True:
                selection = self.jobs.select_job_ids({"status": "all", "include_hidden": True,
                    "include_deleted": True, "sort": "created_at", "direction": "asc", "offset": offset,
                    "limit": BATCH_SIZE}, connection=connection)
                ids = selection["job_ids"]
                jobs = self.jobs.get_job_snapshots(ids, connection=connection, include_deleted=True)
                data = self._bulk(ids, connection, postings=jobs)
                for ident in ids:
                    job = jobs[ident]
                    scalars, extra = self._scalars(job, *[data[name].get(ident) for name in self.owners])
                    revisions = self._revisions(job, data, ident)
                    candidates.append({"job_id": ident, "scalars": scalars, "extra": extra, "revisions": revisions})
                offset += len(ids)
                if offset >= selection["total"] or not ids:
                    break
            identity = query.model_dump(exclude={"offset", "limit", "query_revision"})
            revision = digest({"query": identity, "modules": modules,
                               "rows": sorted(candidates, key=lambda row: row["job_id"])})
            if query.query_revision is not None and query.query_revision != revision:
                raise ConflictError("The Jobs query sources changed. Refresh the list before continuing.",
                                    query_revision=revision)
            base = [row for row in candidates if self._matches(query, row, columns=False)]
            facets = {}
            for field in FIELDS:
                values = sorted({"" if row["scalars"][field] is None else str(row["scalars"][field]) for row in base})
                facets[field] = {"values": values[:FACET_LIMIT], "complete": len(values) <= FACET_LIMIT}
            matches = sorted((row for row in base if self._matches(query, row)), key=cmp_to_key(
                lambda left, right: self._compare(query, left, right)))
            selected = matches[query.offset:query.offset + query.limit]
            ids = [row["job_id"] for row in selected]
            jobs = self.jobs.get_job_snapshots(ids, connection=connection, include_deleted=True)
            data = self._bulk(ids, connection, postings=jobs)
            rows = [JobQueryRow(job=jobs[row["job_id"]], fit=data["fit"].get(row["job_id"]),
                preparation=data["preparation"].get(row["job_id"]), compensation=data["compensation"].get(row["job_id"]),
                application=data["applications"].get(row["job_id"]), resume=data["resumes"].get(row["job_id"]),
                scalars=row["scalars"], revisions=row["revisions"]) for row in selected]
            available = [field for field in FIELDS if self._field_available(field, modules)]
            return JobQueryResult(rows=rows, total=len(matches), offset=query.offset, limit=query.limit,
                query_revision=revision, modules=modules,
                capabilities={"sortable_fields": available, "filterable_fields": available}, facets=facets).model_dump()


def build_job_query_routes(application) -> tuple[Route, ...]:
    if "jobs" not in application.services:
        return ()
    queries = JobQueries(application)

    async def listing(request):
        try:
            query = JobListQuery.from_params(request.query_params)
        except (ValidationError, ValueError, TypeError):
            raise AppError("invalid_job_query", "The Jobs query contains invalid filters, sorting or pagination.", 422) from None
        return JSONResponse(queries.query(query))

    return (Route("/v1/jobs/query", listing, methods=["GET"]),)
