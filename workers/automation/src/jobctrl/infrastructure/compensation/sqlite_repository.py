"""SQLite repository for posted compensation facts."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import replace
from typing import Any, Callable

from jobctrl.domain.compensation import (
    PostedCompensationFact,
)
from jobctrl.domain.events.base import DomainEvent
from jobctrl.domain.identifiers import JobId, canonical_job_id


def _parser_version_tag(parser_version: str) -> str:
    return parser_version.removeprefix("posted-compensation-")


class SqlitePostedCompensationRepository:
    """SQLite-backed repository for canonical posted compensation facts."""

    def __init__(self, conn: sqlite3.Connection, *, extractor=None) -> None:
        self._conn = conn
        self._extractor = extractor

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
        with self._conn:
            if event_write_fence is not None:
                event_write_fence()
            self.require_determination(fact)
            self._save_fact_row(fact)
            self._record_updated_event(
                fact,
                idempotency_key=event_idempotency_key,
                commit=False,
            )

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
        if row is None:
            return None
        fact = _row_to_fact(row)
        self.require_determination(fact)
        return fact

    def require_determination(self, fact):
        from jobctrl.domain.determinations import DeterminationFailure, parse_model_result
        from jobctrl.domain.compensation.posted import PostedPayExtraction
        from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

        repository = SqliteDeterminationRepository(self._conn)
        envelope = repository.bound(
            tenant_id=fact.tenant_id,
            entity_kind="posted_compensation",
            entity_id=str(fact.job_id),
            entity_version=fact.source_hash,
            determination_kind="posted_compensation",
        )
        if (
            envelope is None
            or envelope.entity_id != str(fact.job_id)
            or envelope.kind != "posted_compensation"
            or envelope.schema_version != "1"
            or envelope.prompt_version != "posted-compensation-v1"
            or envelope.lane != "compensation"
        ):
            raise DeterminationFailure("posted_compensation_determination_unavailable")
        result = parse_model_result(PostedPayExtraction, envelope.result)
        if any(
            getattr(fact, key) != getattr(result, key)
            for key in (
                "parse_state",
                "currency",
                "period",
                "component",
                "minimum_amount",
                "maximum_amount",
                "confidence",
            )
        ):
            raise DeterminationFailure("posted_compensation_binding_invalid")
        return envelope

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
        from jobctrl.domain.compensation.posted import ModelPostedPayExtractor, posted_fact_from_extraction
        from jobctrl.infrastructure.determinations import determination_dependencies

        extractor = self._extractor or ModelPostedPayExtractor(
            **determination_dependencies(self._conn, tenant_id=tenant_id, lane="compensation")
        )
        result, envelope = extractor.extract(salary, entity_id=str(job_id))
        fact = posted_fact_from_extraction(
            result,
            envelope,
            source_text=salary,
            tenant_id=tenant_id,
            job_id=job_id,
            source_field=source_field,
            parsed_at=parsed_at,
        )
        from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

        with self._conn:
            if event_write_fence is not None:
                event_write_fence()
            self._save_fact_row(fact)
            SqliteDeterminationRepository(self._conn).bind(
                tenant_id=tenant_id,
                entity_kind="posted_compensation",
                entity_id=str(job_id),
                entity_version=fact.source_hash,
                determination_kind="posted_compensation",
                determination_id=envelope.determination_id,
            )
            self._record_updated_event(fact, idempotency_key=event_idempotency_key, commit=False)
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
        return text, field

    return None, "jobs.salary"


def _nonempty_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value).strip())
    return text or None


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
