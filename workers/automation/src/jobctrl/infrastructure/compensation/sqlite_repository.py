"""SQLite repository for posted compensation facts."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import replace
from typing import Any, Callable

from jobctrl.domain.compensation import (
    PARSER_VERSION,
    PostedCompensationFact,
    parse_posted_compensation,
)
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId, canonical_job_id

COMPENSATION_SOURCE_RE = re.compile(
    r"\b(?:salary|compensation|pay range|base pay|base salary|wage|remuneration|ote)\b|on[- ]target earnings",
    re.IGNORECASE,
)
BASE_COMPENSATION_SOURCE_RE = re.compile(
    r"\b(?:salary|pay range|base pay|base salary|wage|remuneration|ote)\b|on[- ]target earnings",
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
NON_BASE_COMPENSATION_CONTEXT_RE = re.compile(
    r"\b(?:bonus|commission|equity|stock|stipend|allowance|learning budget|"
    r"training budget|wellness|home office|equipment|relocation)\b",
    re.IGNORECASE,
)
PAY_PERIOD_RE = re.compile(
    r"(?:/(?:h|hr|hrs|hour|mo|mos|month)|\b(?:hour|hourly|hr|hrs|month|monthly|year|yearly|annual|annually|annum|yr|yrs)\b)",
    re.IGNORECASE,
)
GENERIC_COMPENSATION_AMOUNT_CUE_RE = re.compile(
    r"\bcompensation(?:\s+range)?\s*(?::|-|\bis\b)?\s*$",
    re.IGNORECASE,
)
EXPLICIT_COMPONENT_AMOUNT_CUE_RE = re.compile(
    r"\b(?:(?:equity|stock)\s+compensation|bonus(?:\s+compensation)?|"
    r"commission(?:\s+compensation)?)\s*(?::|-|\bis\b)?\s*$",
    re.IGNORECASE,
)
ADDITIVE_EQUITY_AFTER_AMOUNT_RE = re.compile(
    r"^.{0,40}(?:\+|\bplus\b|\band\b).{0,24}\b(?:equity|rsu|stock options?)\b",
    re.IGNORECASE,
)
OUTDATED_POSTED_PARSER_VERSIONS = (
    "posted-compensation-v1",
    "posted-compensation-v2",
)


def _parser_version_tag(parser_version: str) -> str:
    return parser_version.removeprefix("posted-compensation-")


class SqlitePostedCompensationRepository:
    """SQLite-backed repository for canonical posted compensation facts."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save_fact(
        self,
        fact: PostedCompensationFact,
        *,
        event_idempotency_key: str | None = None,
        event_write_fence: Callable[[], None] | None = None,
    ) -> None:
        if fact.job_id is None:
            raise ValueError("JobId is required to persist a posted compensation fact")
        fact = replace(fact, job_id=canonical_job_id(str(fact.job_id)))
        self._save_fact_row(fact)
        self._conn.commit()
        if event_write_fence is not None:
            event_write_fence()
        self._record_updated_event(
            fact,
            idempotency_key=event_idempotency_key,
        )

    def reparse_outdated_facts(
        self,
        *,
        tenant_id: str = "local",
        parsed_at: str,
        batch_size: int = 100,
    ) -> int:
        """Upgrade known older parser generations with atomic dirty events.

        This is a worker-start convergence path, not a read-side repair. Each
        bounded batch commits canonical facts and their durable events
        together, so a crash either leaves a row eligible for retry or leaves
        a projection-dirty event that the normal builder can fold.
        """

        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        total = 0
        while True:
            rows = self._conn.execute(
                """
                SELECT facts.job_id, jobs.salary,
                       enrichments.full_description AS enrichment_description,
                       jobs.full_description, jobs.description,
                       facts.parser_version
                FROM job_posted_compensation_facts AS facts
                JOIN jobs
                  ON jobs.tenant_id = facts.tenant_id
                 AND jobs.job_id = facts.job_id
                LEFT JOIN job_enrichments AS enrichments
                  ON enrichments.tenant_id = jobs.tenant_id
                 AND enrichments.job_id = jobs.job_id
                 AND enrichments.current_status = 'enriched'
                WHERE facts.tenant_id = ?
                  AND facts.parser_version IN (?, ?)
                ORDER BY jobs.url
                LIMIT ?
                """,
                (tenant_id, *OUTDATED_POSTED_PARSER_VERSIONS, batch_size),
            ).fetchall()
            if not rows:
                return total

            publisher = _BufferedEventPublisher()
            savepoint = "posted_compensation_parser_upgrade"
            self._conn.execute(f"SAVEPOINT {savepoint}")
            try:
                for row in rows:
                    job_id = canonical_job_id(str(_maintenance_row_value(row, "job_id")))
                    source_parser_version = str(
                        _maintenance_row_value(row, "parser_version"),
                    )
                    source_text, source_field = _posted_source_from_values(
                        salary=_maintenance_row_value(row, "salary"),
                        enrichment_description=_maintenance_row_value(
                            row,
                            "enrichment_description",
                        ),
                        full_description=_maintenance_row_value(
                            row,
                            "full_description",
                        ),
                        description=_maintenance_row_value(row, "description"),
                    )
                    fact = parse_posted_compensation(
                        source_text,
                        tenant_id=tenant_id,
                        job_id=job_id,
                        source_field=source_field,
                        parsed_at=parsed_at,
                    )
                    if fact.parser_version != PARSER_VERSION:
                        raise RuntimeError("posted parser did not emit current version")
                    self._save_fact_row(fact)
                    self._record_updated_event(
                        fact,
                        idempotency_key=(
                            f"posted-parser-upgrade:{tenant_id}:{job_id}:"
                            f"{_parser_version_tag(source_parser_version)}:"
                            f"{_parser_version_tag(PARSER_VERSION)}"
                        ),
                        publisher=publisher,
                        commit=False,
                        suppress_missing_table=False,
                    )
            except BaseException:
                self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise
            else:
                self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                self._conn.commit()
                from jobctrl.infrastructure.events import get_default_publisher

                destination = get_default_publisher()
                for event in publisher.events:
                    destination.publish(event)
                total += len(rows)

    def _save_fact_row(self, fact: PostedCompensationFact) -> None:
        """Persist a fact without committing; callers own transaction scope."""

        self._conn.execute(
            """
            INSERT INTO job_posted_compensation_facts (
                tenant_id, job_id, source_field, source_text, legacy_raw_salary,
                parse_state, currency, period, component, minimum_amount,
                maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
                annualization_assumption, confidence, warnings_json, parser_version,
                source_hash, parsed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, job_id) DO UPDATE SET
                source_field = excluded.source_field,
                source_text = excluded.source_text,
                legacy_raw_salary = excluded.legacy_raw_salary,
                parse_state = excluded.parse_state,
                currency = excluded.currency,
                period = excluded.period,
                component = excluded.component,
                minimum_amount = excluded.minimum_amount,
                maximum_amount = excluded.maximum_amount,
                annualized_minimum_amount = excluded.annualized_minimum_amount,
                annualized_maximum_amount = excluded.annualized_maximum_amount,
                annualization_assumption = excluded.annualization_assumption,
                confidence = excluded.confidence,
                warnings_json = excluded.warnings_json,
                parser_version = excluded.parser_version,
                source_hash = excluded.source_hash,
                parsed_at = excluded.parsed_at
            """,
            _fact_values(fact),
        )

    def get_fact(self, tenant_id: str, job_id: JobId) -> PostedCompensationFact | None:
        job_id = canonical_job_id(str(job_id))
        row = self._conn.execute(
            """
            SELECT tenant_id, job_id, source_field, source_text, legacy_raw_salary,
                   parse_state, currency, period, component, minimum_amount,
                   maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
                   annualization_assumption, confidence, warnings_json, parser_version,
                   source_hash, parsed_at
            FROM job_posted_compensation_facts
            WHERE tenant_id = ? AND job_id = ?
            """,
            (tenant_id, job_id),
        ).fetchone()
        return _row_to_fact(row) if row is not None else None

    def parse_and_save_job_salary(
        self,
        job_id: JobId,
        salary: str | None,
        *,
        tenant_id: str = "local",
        source_field: str = "jobs.salary",
        parsed_at: str | None = None,
        event_idempotency_key: str | None = None,
        event_write_fence: Callable[[], None] | None = None,
    ) -> PostedCompensationFact:
        job_id = canonical_job_id(str(job_id))
        fact = parse_posted_compensation(
            salary,
            tenant_id=tenant_id,
            job_id=job_id,
            source_field=source_field,
            parsed_at=parsed_at,
        )
        self.save_fact(
            fact,
            event_idempotency_key=event_idempotency_key,
            event_write_fence=event_write_fence,
        )
        return fact

    def backfill_from_jobs(self, *, tenant_id: str = "local", parsed_at: str | None = None) -> int:
        rows = self._conn.execute(
            """
            SELECT jobs.job_id, jobs.salary,
                   enrichments.full_description AS enrichment_description,
                   jobs.full_description, jobs.description
            FROM jobs
            LEFT JOIN job_enrichments AS enrichments
              ON enrichments.tenant_id = jobs.tenant_id
             AND enrichments.job_id = jobs.job_id
             AND enrichments.current_status = 'enriched'
            WHERE jobs.tenant_id = ?
            ORDER BY jobs.url
            """,
            (tenant_id,),
        ).fetchall()
        for row in rows:
            source_text, source_field = _posted_source_from_values(
                salary=_maintenance_row_value(row, "salary"),
                enrichment_description=_maintenance_row_value(
                    row,
                    "enrichment_description",
                ),
                full_description=_maintenance_row_value(row, "full_description"),
                description=_maintenance_row_value(row, "description"),
            )
            self.parse_and_save_job_salary(
                canonical_job_id(str(_maintenance_row_value(row, "job_id"))),
                source_text,
                tenant_id=tenant_id,
                source_field=source_field,
                parsed_at=parsed_at,
            )
        self._conn.commit()
        return len(rows)

    def _record_updated_event(
        self,
        fact: PostedCompensationFact,
        *,
        idempotency_key: str | None = None,
        publisher: _BufferedEventPublisher | None = None,
        commit: bool = True,
        suppress_missing_table: bool = True,
    ) -> None:
        try:
            from jobctrl.state import record_job_event

            record_job_event(
                self._conn,
                fact.job_id,
                "enrich",
                "CompensationFactsUpdated",
                tenant_id=fact.tenant_id,
                message="Posted compensation fact updated",
                occurred_at=fact.parsed_at,
                publisher=publisher,
                payload={
                    "jobId": str(fact.job_id),
                    "changedSections": ["posted"],
                    "postedRecordStatus": "recorded",
                    "postedParseState": fact.parse_state,
                    "marketRecordStatus": None,
                    "marketEstimateState": None,
                    "updatedAt": fact.parsed_at,
                },
                idempotency_key=idempotency_key,
            )
            if commit:
                self._conn.commit()
        except sqlite3.OperationalError:
            if suppress_missing_table:
                return
            raise


def posted_compensation_source_from_job(row: Any) -> tuple[str | None, str]:
    return _posted_source_from_values(
        salary=_job_source_row_value(row, "salary"),
        enrichment_description=_job_source_row_value(
            row,
            "enrichment_description",
            optional=True,
        ),
        full_description=_job_source_row_value(row, "full_description"),
        description=_job_source_row_value(row, "description"),
    )


def _posted_source_from_values(
    *,
    salary: Any,
    enrichment_description: Any,
    full_description: Any,
    description: Any,
) -> tuple[str | None, str]:
    salary_text = _nonempty_text(salary)
    if salary_text is not None:
        return salary_text, "jobs.salary"

    for field, value in (
        ("job_enrichments.full_description", enrichment_description),
        ("jobs.full_description", full_description),
        ("jobs.description", description),
    ):
        text = _nonempty_text(value)
        if text is None:
            continue
        match = _compensation_source_match(text)
        if match is None:
            continue
        start = max(0, match.start() - 80)
        end = min(len(text), match.end() + 220)
        return text[start:end].strip(), field

    return None, "jobs.salary"


def _nonempty_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).strip())
    return text or None


def _compensation_source_match(text: str) -> re.Match[str] | None:
    keyword_match = COMPENSATION_SOURCE_RE.search(text)
    generic_candidate: re.Match[str] | None = None
    for amount_match in COMPENSATION_AMOUNT_RE.finditer(text):
        if NON_COMPENSATION_SCALE_RE.match(text[amount_match.end() :].lstrip()):
            continue
        window_start = max(0, amount_match.start() - 40)
        window_end = min(len(text), amount_match.end() + 40)
        window = text[window_start:window_end]
        if not PAY_PERIOD_RE.search(window):
            continue
        amount_start = amount_match.start() - window_start
        amount_end = amount_match.end() - window_start
        base_distance = _nearest_match_distance(
            BASE_COMPENSATION_SOURCE_RE,
            window,
            amount_start,
            amount_end,
        )
        non_base_distance = _nearest_match_distance(
            NON_BASE_COMPENSATION_CONTEXT_RE,
            window,
            amount_start,
            amount_end,
        )
        if EXPLICIT_COMPONENT_AMOUNT_CUE_RE.search(window[:amount_start]):
            return amount_match
        if base_distance is not None and (non_base_distance is None or base_distance < non_base_distance):
            return amount_match
        if _is_generic_compensation_with_additive_equity(
            window,
            amount_start,
            amount_end,
        ):
            return amount_match
        if generic_candidate is None and COMPENSATION_SOURCE_RE.search(window) and non_base_distance is None:
            generic_candidate = amount_match

    return generic_candidate or keyword_match


def _is_generic_compensation_with_additive_equity(
    window: str,
    amount_start: int,
    amount_end: int,
) -> bool:
    prefix = window[:amount_start]
    cue = GENERIC_COMPENSATION_AMOUNT_CUE_RE.search(prefix)
    if cue is None:
        return False
    cue_context = prefix[max(0, cue.start() - 32) : cue.start()]
    if NON_BASE_COMPENSATION_CONTEXT_RE.search(cue_context):
        return False
    return bool(ADDITIVE_EQUITY_AFTER_AMOUNT_RE.search(window[amount_end:]))


def _nearest_match_distance(
    pattern: re.Pattern[str],
    text: str,
    anchor_start: int,
    anchor_end: int,
) -> int | None:
    distances: list[int] = []
    for match in pattern.finditer(text):
        if match.end() <= anchor_start:
            distances.append(anchor_start - match.end())
        elif match.start() >= anchor_end:
            distances.append(match.start() - anchor_end)
        else:
            distances.append(0)
    return min(distances) if distances else None


def _job_source_row_value(
    row: Any,
    key: str,
    *,
    optional: bool = False,
) -> Any:
    if isinstance(row, sqlite3.Row):
        if optional and key not in row.keys():
            return None
        return row[key]
    keys = (
        ("job_id", "salary", "enrichment_description", "full_description", "description")
        if len(row) == 5
        else ("job_id", "salary", "full_description", "description")
    )
    if optional and key not in keys:
        return None
    return row[keys.index(key)]


def _row_to_fact(row: sqlite3.Row | tuple[Any, ...]) -> PostedCompensationFact:
    warnings = json.loads(_row_value(row, "warnings_json") or "[]")
    if not isinstance(warnings, list):
        warnings = []
    return PostedCompensationFact(
        tenant_id=str(_row_value(row, "tenant_id")),
        job_id=canonical_job_id(str(_row_value(row, "job_id"))),
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
        "job_id",
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


def _maintenance_row_value(row: sqlite3.Row | tuple[Any, ...], key: str) -> Any:
    if isinstance(row, sqlite3.Row):
        return row[key]
    maintenance_keys = (
        "job_id",
        "salary",
        "enrichment_description",
        "full_description",
        "description",
        "parser_version",
    )
    return row[maintenance_keys.index(key)]


class _BufferedEventPublisher:
    def __init__(self) -> None:
        self.events: list[DomainEvent] = []

    def publish(self, event: DomainEvent) -> None:
        self.events.append(event)

    def subscribe(self, _event_type: str | None, _handler: Any) -> Any:
        raise RuntimeError("buffered event publisher does not accept subscriptions")


def _fact_values(fact: PostedCompensationFact) -> tuple[Any, ...]:
    return (
        fact.tenant_id,
        fact.job_id,
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
    )


def _nullable_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _nullable_int(value: Any) -> int | None:
    return None if value is None else int(value)
