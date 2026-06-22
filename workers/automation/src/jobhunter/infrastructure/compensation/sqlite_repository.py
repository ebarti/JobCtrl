"""SQLite repository for posted compensation facts."""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from jobhunter.database import ensure_posted_compensation_tables
from jobhunter.domain.compensation import PostedCompensationFact, parse_posted_compensation

COMPENSATION_SOURCE_RE = re.compile(
    r"\b(?:salary|compensation|pay range|base pay|base salary|wage|remuneration|ote)\b|on[- ]target earnings",
    re.IGNORECASE,
)
COMPENSATION_AMOUNT_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:(?:[€$£]|(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK)\b)\s*)"
    r"\d{1,3}(?:[,.]\d{3})*(?:[,.]\d+)?\s*(?:k|K)?(?![A-Za-z0-9])"
)
NON_COMPENSATION_SCALE_RE = re.compile(
    r"^(?:million|millions|billion|billions|trillion|trillions|mm|bn|b)\b",
    re.IGNORECASE,
)
PAY_PERIOD_RE = re.compile(
    r"(?:/(?:h|hr|hrs|hour|mo|mos|month)|\b(?:hour|hourly|hr|hrs|month|monthly|year|yearly|annual|annually|annum|yr|yrs)\b)",
    re.IGNORECASE,
)


class SqlitePostedCompensationRepository:
    """SQLite-backed repository for canonical posted compensation facts."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_posted_compensation_tables(conn)

    def save_fact(self, fact: PostedCompensationFact) -> None:
        self._conn.execute(
            """
            INSERT INTO job_posted_compensation_facts (
                tenant_id, job_url, source_field, source_text, legacy_raw_salary,
                parse_state, currency, period, component, minimum_amount,
                maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
                annualization_assumption, confidence, warnings_json, parser_version,
                source_hash, parsed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_url) DO UPDATE SET
                source_field                 = excluded.source_field,
                source_text                  = excluded.source_text,
                legacy_raw_salary            = excluded.legacy_raw_salary,
                parse_state                  = excluded.parse_state,
                currency                     = excluded.currency,
                period                       = excluded.period,
                component                    = excluded.component,
                minimum_amount               = excluded.minimum_amount,
                maximum_amount               = excluded.maximum_amount,
                annualized_minimum_amount    = excluded.annualized_minimum_amount,
                annualized_maximum_amount    = excluded.annualized_maximum_amount,
                annualization_assumption     = excluded.annualization_assumption,
                confidence                   = excluded.confidence,
                warnings_json                = excluded.warnings_json,
                parser_version               = excluded.parser_version,
                source_hash                  = excluded.source_hash,
                parsed_at                    = excluded.parsed_at
            """,
            (
                fact.tenant_id,
                fact.job_url,
                fact.source_field,
                fact.source_text,
                fact.legacy_raw_salary,
                fact.parse_state,
                fact.currency,
                fact.period,
                fact.component,
                fact.minimum_amount,
                fact.maximum_amount,
                fact.annualized_minimum_amount,
                fact.annualized_maximum_amount,
                fact.annualization_assumption,
                fact.confidence,
                json.dumps(list(fact.warnings), sort_keys=True),
                fact.parser_version,
                fact.source_hash,
                fact.parsed_at,
            ),
        )
        self._conn.commit()
        self._record_updated_event(fact)

    def get_fact(self, tenant_id: str, job_url: str) -> PostedCompensationFact | None:
        row = self._conn.execute(
            """
            SELECT tenant_id, job_url, source_field, source_text, legacy_raw_salary,
                   parse_state, currency, period, component, minimum_amount,
                   maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
                   annualization_assumption, confidence, warnings_json, parser_version,
                   source_hash, parsed_at
            FROM job_posted_compensation_facts
            WHERE tenant_id = ? AND job_url = ?
            """,
            (tenant_id, job_url),
        ).fetchone()
        return _row_to_fact(row) if row is not None else None

    def parse_and_save_job_salary(
        self,
        job_url: str,
        salary: str | None,
        *,
        tenant_id: str = "local",
        source_field: str = "jobs.salary",
        parsed_at: str | None = None,
    ) -> PostedCompensationFact:
        fact = parse_posted_compensation(
            salary,
            tenant_id=tenant_id,
            job_url=job_url,
            source_field=source_field,
            parsed_at=parsed_at,
        )
        self.save_fact(fact)
        return fact

    def backfill_from_legacy_jobs(self, *, tenant_id: str = "local", parsed_at: str | None = None) -> int:
        rows = self._conn.execute(
            "SELECT url, salary, full_description, description FROM jobs ORDER BY url"
        ).fetchall()
        for row in rows:
            source_text, source_field = posted_compensation_source_from_job(row)
            self.parse_and_save_job_salary(
                _row_value(row, "url"),
                source_text,
                tenant_id=tenant_id,
                source_field=source_field,
                parsed_at=parsed_at,
            )
        self._conn.commit()
        return len(rows)

    def _record_updated_event(self, fact: PostedCompensationFact) -> None:
        try:
            from jobhunter.state import record_job_event

            record_job_event(
                self._conn,
                fact.job_url,
                "enrich",
                "CompensationFactsUpdated",
                message="Posted compensation fact updated",
                occurred_at=fact.parsed_at,
                payload={
                    "jobId": fact.job_url,
                    "changedSections": ["posted"],
                    "postedRecordStatus": "recorded",
                    "postedParseState": fact.parse_state,
                    "marketRecordStatus": None,
                    "marketEstimateState": None,
                    "updatedAt": fact.parsed_at,
                },
            )
            self._conn.commit()
        except sqlite3.OperationalError:
            return


def posted_compensation_source_from_job(row: Any) -> tuple[str | None, str]:
    salary = _nonempty_text(_row_value(row, "salary"))
    if salary is not None:
        return salary, "jobs.salary"

    for field in ("full_description", "description"):
        text = _nonempty_text(_row_value(row, field))
        if text is None:
            continue
        match = _compensation_source_match(text)
        if match is None:
            continue
        start = max(0, match.start() - 80)
        end = min(len(text), match.end() + 220)
        return text[start:end].strip(), f"jobs.{field}"

    return None, "jobs.salary"


def _nonempty_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).strip())
    return text or None


def _compensation_source_match(text: str) -> re.Match[str] | None:
    keyword_match = COMPENSATION_SOURCE_RE.search(text)
    if keyword_match is not None:
        return keyword_match

    for amount_match in COMPENSATION_AMOUNT_RE.finditer(text):
        if NON_COMPENSATION_SCALE_RE.match(text[amount_match.end() :].lstrip()):
            continue
        window_start = max(0, amount_match.start() - 40)
        window_end = min(len(text), amount_match.end() + 40)
        if PAY_PERIOD_RE.search(text[window_start:window_end]):
            return amount_match

    return None


def _row_to_fact(row: sqlite3.Row | tuple[Any, ...]) -> PostedCompensationFact:
    warnings = json.loads(_row_value(row, "warnings_json") or "[]")
    if not isinstance(warnings, list):
        warnings = []
    return PostedCompensationFact(
        tenant_id=str(_row_value(row, "tenant_id")),
        job_url=str(_row_value(row, "job_url")),
        source_field=str(_row_value(row, "source_field")),
        source_text=_nullable_str(_row_value(row, "source_text")),
        legacy_raw_salary=_nullable_str(_row_value(row, "legacy_raw_salary")),
        parse_state=_row_value(row, "parse_state"),  # type: ignore[arg-type]
        currency=_nullable_str(_row_value(row, "currency")),
        period=_row_value(row, "period"),  # type: ignore[arg-type]
        component=_row_value(row, "component"),  # type: ignore[arg-type]
        minimum_amount=_nullable_int(_row_value(row, "minimum_amount")),
        maximum_amount=_nullable_int(_row_value(row, "maximum_amount")),
        annualized_minimum_amount=_nullable_int(_row_value(row, "annualized_minimum_amount")),
        annualized_maximum_amount=_nullable_int(_row_value(row, "annualized_maximum_amount")),
        annualization_assumption=_nullable_str(_row_value(row, "annualization_assumption")),
        confidence=_row_value(row, "confidence"),  # type: ignore[arg-type]
        warnings=tuple(str(warning) for warning in warnings),  # type: ignore[arg-type]
        parser_version=str(_row_value(row, "parser_version")),
        source_hash=str(_row_value(row, "source_hash")),
        parsed_at=str(_row_value(row, "parsed_at")),
    )


def _row_value(row: sqlite3.Row | tuple[Any, ...], key: str) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key]
    keys = (
        "tenant_id",
        "job_url",
        "source_field",
        "source_text",
        "legacy_raw_salary",
        "parse_state",
        "currency",
        "period",
        "component",
        "minimum_amount",
        "maximum_amount",
        "annualized_minimum_amount",
        "annualized_maximum_amount",
        "annualization_assumption",
        "confidence",
        "warnings_json",
        "parser_version",
        "source_hash",
        "parsed_at",
    )
    return row[keys.index(key)]


def _nullable_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _nullable_int(value: Any) -> int | None:
    return None if value is None else int(value)
