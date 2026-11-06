"""User-supplied manual and licensed JSON/CSV compensation feeds.

Feed locations, tokens and fetchers are passed by the host. No environment,
settings or application storage is read here. The only network path is an
injected policy-routed fetcher.
"""

from __future__ import annotations

import csv
import json
import math
import re
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from jobctrl.features.compensation.core.ports import Classification, Observation
from jobctrl.features.compensation.providers.common import (
    ProviderLoad,
    levels_company_reference,
    row_source,
    safe_source_url,
)

TextFeedFetcher = Callable[[str, str | None], str | None]

_SOURCE_IDS = {
    "levels": "levels_fyi",
    "levels_fyi": "levels_fyi",
    "levels_fyi_reported_compensation": "levels_fyi",
    "glassdoor": "glassdoor",
    "glassdoor_reported_compensation": "glassdoor",
    "manual": "manual_reported_compensation",
    "manual_reported_compensation": "manual_reported_compensation",
    "eurotoptech": "euro_top_tech",
    "euro_top_tech": "euro_top_tech",
    "euro_top_tech_reported_compensation": "euro_top_tech",
    "posted_salary_text": "posted_salary_text",
    "posted_salary": "posted_salary_text",
    "job_posting_salary_text": "posted_salary_text",
}
_LICENSED_MODES = {
    "levels_fyi": {"licensed_api", "licensed_data_feed", "enterprise_mcp"},
    "glassdoor": {"partner_api", "written_permission"},
}


def _pick(data: Mapping[str, Any], *keys: str) -> Any:
    return next((data[key] for key in keys if data.get(key) not in (None, "")), None)


def _source_id(value: Any) -> str | None:
    return _SOURCE_IDS.get(str(value or "").strip().casefold().replace("-", "_").replace(".", "_"))


def _money(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("invalid amount")
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 0 or int(value) != value:
            raise ValueError("amount must be a non-negative whole number")
        return int(value)
    # Accept whole numbers and explicit thousands grouping, not ambiguous
    # decimals or abbreviated values such as "120k".
    match = re.fullmatch(
        r"\s*(?:(?:[A-Za-z]{3}|[$€£¥])\s*)?(\d{1,3}(?:[,._ ]\d{3})+|\d+)\s*(?:[A-Za-z]{3})?\s*",
        str(value),
    )
    if not match:
        raise ValueError("invalid amount")
    return int(re.sub(r"[^0-9]", "", match.group(1)))


def _integer(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ValueError("invalid integer")
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or int(value) != value:
            raise ValueError("invalid integer")
        result = int(value)
    elif isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        result = int(value.strip())
    else:
        raise ValueError("invalid integer")
    if result < 0:
        raise ValueError("invalid integer")
    return result


def _text(value: Any) -> str | None:
    if value is None:
        return None
    return str(value).strip() or None


def _observation(data: Mapping[str, Any], *, default_source: str | None, licensed: bool) -> Observation:
    source_id = _source_id(_pick(data, "source_id", "sourceId", "source") or default_source)
    company = _text(_pick(data, "company_name", "companyName", "company"))
    role = _text(_pick(data, "role_title", "roleTitle", "title", "role"))
    if source_id is None or source_id == "posted_salary_text" or not company or not role:
        raise ValueError("invalid market source or identity")
    minimum = _money(
        _pick(
            data,
            "minimum_amount",
            "minimumAmount",
            "min",
            "total_compensation_min",
            "totalCompensationMin",
            "base_salary_min",
            "baseSalaryMin",
        )
    )
    maximum = _money(
        _pick(
            data,
            "maximum_amount",
            "maximumAmount",
            "max",
            "total_compensation_max",
            "totalCompensationMax",
            "base_salary_max",
            "baseSalaryMax",
        )
    )
    if minimum is None and maximum is None:
        minimum = maximum = _money(
            _pick(data, "amount", "total_compensation", "totalCompensation", "base_salary", "baseSalary")
        )
    if minimum is None and maximum is None:
        raise ValueError("missing amount")
    currency = (_text(data.get("currency")) or "").upper()
    period = (_text(data.get("period")) or "").casefold()
    component = (_text(data.get("component")) or "").casefold()
    if not re.fullmatch(r"[A-Z]{3}", currency) or period not in {"year", "month", "week", "day", "hour"}:
        raise ValueError("missing or invalid currency/period")
    if component not in {"base_salary", "total_compensation"}:
        raise ValueError("missing or invalid component")
    sample_count = _integer(_pick(data, "sample_count", "sampleCount", "samples"))
    release_year = _integer(_pick(data, "release_year", "releaseYear", "reported_year", "reportedYear"))
    snapshot = _text(_pick(data, "snapshot_version", "snapshotVersion")) or "reported-compensation-import-v1"
    location = _text(_pick(data, "location", "geo", "geography"))
    level = _text(_pick(data, "level_label", "levelLabel", "level", "seniority"))
    company_tier = _text(_pick(data, "company_tier", "companyTier", "tier"))
    source_url = safe_source_url(
        _pick(
            data,
            "source_url",
            "sourceUrl",
            "url",
            "record_url",
            "recordUrl",
            "profile_url",
            "profileUrl",
            "evidence_url",
            "evidenceUrl",
        )
    )
    company_reference = levels_company_reference(source_url) if source_id == "levels_fyi" else None
    attribution = _text(data.get("attribution")) or f"Reported compensation source: {source_id}"
    provenance = (
        "licensed"
        if licensed or source_id in {"levels_fyi", "glassdoor"}
        else ("public" if source_id == "euro_top_tech" else "manual")
    )
    # The model sees precisely the selected source row, including tier supplied
    # by the source. No tier, occupation, location or seniority is inferred.
    source_row = {
        "source_id": source_id,
        "company_name": company,
        "company_reference": company_reference,
        "role_title": role,
        "location": location,
        "level_label": level,
        "company_tier": company_tier,
        "currency": currency,
        "period": period,
        "component": component,
        "minimum": minimum,
        "maximum": maximum,
        "sample_count": sample_count,
        "release_year": release_year,
        "source_url": source_url,
        # Preserve the exact supplied pay tokens beside mechanical parsing.
        # Other feed fields may contain unrelated or credential-bearing data.
        "raw_pay_fields": {
            key: data[key]
            for key in (
                "minimum_amount",
                "minimumAmount",
                "min",
                "maximum_amount",
                "maximumAmount",
                "max",
                "total_compensation_min",
                "totalCompensationMin",
                "total_compensation_max",
                "totalCompensationMax",
                "base_salary_min",
                "baseSalaryMin",
                "base_salary_max",
                "baseSalaryMax",
                "amount",
                "total_compensation",
                "totalCompensation",
                "base_salary",
                "baseSalary",
                "currency",
                "period",
                "component",
            )
            if key in data
        },
    }
    return Observation(
        source=row_source(
            source_id,
            source_row,
            snapshot=snapshot,
            as_of=str(release_year) if release_year is not None else None,
            url=source_url,
            attribution=attribution,
        ),
        provider=source_id,
        provenance=provenance,
        company=company,
        company_reference=company_reference,
        role=role,
        location=location,
        level=level,
        component=component,
        currency=currency,
        period=period,
        minimum=minimum,
        maximum=maximum,
        sample_count=sample_count,
        release_year=release_year,
        attribution=attribution,
    )


def parse_reported_compensation_payload(
    text: str,
    *,
    default_source: str | None = None,
    licensed: bool = False,
) -> ProviderLoad:
    """Parse supported import formats and retain structural rejection counts."""
    if not text.strip():
        raise ValueError("reported compensation feed is empty")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        reader = csv.DictReader(text.splitlines(), strict=True)
        fields = set(reader.fieldnames or ())
        if not fields.intersection({"company_name", "companyName", "company"}) or not fields.intersection(
            {"role_title", "roleTitle", "title", "role"}
        ):
            raise ValueError("reported compensation CSV has no supported identity columns")
        items: Any = list(reader)
    else:
        items = raw.get("observations", raw) if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ValueError("reported compensation JSON must contain an observations list")
    observations: list[Observation] = []
    rejected = 0
    for item in items:
        try:
            if not isinstance(item, dict):
                raise ValueError("invalid row")
            observations.append(_observation(item, default_source=default_source, licensed=licensed))
        except (ValueError, TypeError, OverflowError):
            rejected += 1
    return ProviderLoad(
        tuple(observations),
        ("reported_compensation_invalid_observation",) if rejected else (),
        diagnostics=(("rejected", rejected),),
    )


class ImportedProvider:
    """Explicit import or licensed feed; no implicit home-directory discovery.

    ``provider=None`` is an explicitly requested manual import; source IDs are
    read from its rows. A licensed source uses only matching rows and requires
    its enabled/access/coverage declaration before any file or network read.
    """

    def __init__(
        self,
        refs: tuple[str | Path, ...],
        fetch_text: TextFeedFetcher,
        *,
        provider: str | None = None,
        token: str | None = None,
    ):
        if provider is not None and provider not in _LICENSED_MODES:
            raise ValueError("unsupported licensed provider")
        self._refs = tuple(refs)
        self._fetch_text = fetch_text
        self._provider = provider
        self._token = token

    def load(self, target: Classification, policy: dict) -> ProviderLoad:
        del target
        if self._provider:
            if (
                policy.get("enabled") is not True
                or policy.get("access_mode") not in _LICENSED_MODES[self._provider]
                or (self._provider == "levels_fyi" and policy.get("europe_coverage_confirmed") is not True)
            ):
                return ProviderLoad()
            if not self._refs:
                return ProviderLoad(errors=(f"{self._provider}_feed_unconfigured",))
        observations: list[Observation] = []
        errors: list[str] = []
        rejected = 0
        for ref in self._refs:
            try:
                value = str(ref)
                if urlsplit(value).scheme in {"http", "https"}:
                    body = self._fetch_text(value, self._token if self._provider else None)
                    if body is None:
                        raise ValueError("feed unavailable")
                    bodies = (body,)
                else:
                    path = Path(value).expanduser()
                    paths = (
                        sorted(child for child in path.iterdir() if child.suffix.casefold() in {".csv", ".json"})
                        if path.is_dir()
                        else (path,)
                    )
                    bodies = (child.read_text(encoding="utf-8") for child in paths)
                for body in bodies:
                    receipt = parse_reported_compensation_payload(
                        body, default_source=self._provider, licensed=self._provider is not None
                    )
                    observations.extend(
                        row for row in receipt.observations if not self._provider or row.provider == self._provider
                    )
                    errors.extend(receipt.errors)
                    rejected += dict(receipt.diagnostics).get("rejected", 0)
            except (OSError, ValueError, TypeError, UnicodeError):
                errors.append(f"{self._provider or 'manual'}_feed_unavailable")
            except Exception:  # noqa: BLE001 - isolate external feed failures without exposing exception text
                errors.append(f"{self._provider or 'manual'}_feed_unavailable")
        return ProviderLoad(tuple(observations), tuple(dict.fromkeys(errors)), diagnostics=(("rejected", rejected),))

    def observations(self, target: Classification, policy: dict) -> tuple[Observation, ...]:
        return self.load(target, policy).require_complete()
