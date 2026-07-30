"""Copy v6 duplicate-link audit rows with proven stable identities."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from jobctrl.domain.discovery.identity import normalize_observed_url
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
    build_job_id_map,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)

_COLUMNS = (
    "tenant_id",
    "duplicate_link_id",
    "surviving_job_id",
    "superseded_job_or_observation_id",
    "reason",
    "confidence",
    "linked_at",
)
_EVENT_LINK_ID_FIELDS = ("duplicate_link_id", "duplicateLinkId")
_EVENT_SURVIVOR_FIELDS = (
    "surviving_job_id",
    "survivingJobId",
    "surviving_job_url",
    "survivingJobUrl",
    "surviving_job_key",
    "survivingJobKey",
)
_EVENT_SUPERSEDED_FIELDS = (
    "superseded_job_or_observation_id",
    "supersededJobOrObservationId",
)


class CandidateDuplicateLinkCopyError(RuntimeError):
    """Raised when a duplicate-link reference cannot be proven in v7."""


class DuplicateLinkResolutionError(RuntimeError):
    """Raised when one legacy duplicate-link identity is ambiguous or invalid."""


@dataclass(frozen=True)
class ResolvedDuplicateLink:
    """The v7 identities of one accepted duplicate-link audit row."""

    surviving_job_id: str
    superseded_job_or_observation_id: str


@dataclass(frozen=True)
class CandidateDuplicateLinkCopyResult:
    """Verified duplicate-link copy result for the migration coordinator."""

    copied_links: int


class DuplicateLinkIdentityResolver:
    """Resolve legacy duplicate links without inventing durable identities."""

    def __init__(
        self,
        source: sqlite3.Connection,
        candidate: sqlite3.Connection,
        *,
        job_ids: JobIdMap,
    ) -> None:
        self._source = source
        self._candidate = candidate
        self._job_ids = job_ids

    def resolve_link(
        self,
        *,
        tenant_id: object,
        surviving_job_locator: object,
        superseded_reference: object,
    ) -> ResolvedDuplicateLink:
        """Resolve a v6 link to the only admissible v7 reference shape."""
        tenant = _tenant_id(tenant_id)
        survivor = self._resolve_survivor(tenant, surviving_job_locator)
        reference = _required_text(
            superseded_reference,
            "duplicate_superseded_reference_invalid",
        )

        direct_observations = self._source.execute(
            """
            SELECT source_observation_id, job_url
              FROM job_source_observations
             WHERE tenant_id = ? AND source_observation_id = ?
            """,
            (tenant, reference),
        ).fetchall()
        if len(direct_observations) > 1:
            raise DuplicateLinkResolutionError(
                "duplicate_superseded_reference_multiple"
            )
        if direct_observations:
            observation_id, observation_owner = direct_observations[0]
            self._require_observation_owner(
                tenant=tenant,
                observation_id=observation_id,
                observation_owner_locator=observation_owner,
                survivor_job_id=survivor,
            )
            return ResolvedDuplicateLink(
                surviving_job_id=survivor,
                superseded_job_or_observation_id=str(observation_id),
            )

        normalized_reference = normalize_observed_url(reference)
        observation_rows = self._source.execute(
            """
            SELECT source_observation_id, job_url
              FROM job_source_observations
             WHERE tenant_id = ? AND normalized_observed_url = ?
            """,
            (tenant, normalized_reference),
        ).fetchall()
        if len(observation_rows) > 1:
            raise DuplicateLinkResolutionError(
                "duplicate_superseded_reference_multiple"
            )

        observation_id: str | None = None
        if observation_rows:
            raw_observation_id, observation_owner = observation_rows[0]
            self._require_observation_owner(
                tenant=tenant,
                observation_id=raw_observation_id,
                observation_owner_locator=observation_owner,
                survivor_job_id=survivor,
            )
            observation_id = str(raw_observation_id)

        aggregate_id = self._job_ids.by_locator.get((tenant, reference))
        if aggregate_id == survivor:
            raise DuplicateLinkResolutionError("duplicate_superseded_reference_self")
        if observation_id is not None and aggregate_id is not None:
            raise DuplicateLinkResolutionError(
                "duplicate_superseded_reference_ambiguous"
            )
        if observation_id is not None:
            return ResolvedDuplicateLink(
                surviving_job_id=survivor,
                superseded_job_or_observation_id=observation_id,
            )
        if aggregate_id is not None:
            return ResolvedDuplicateLink(
                surviving_job_id=survivor,
                superseded_job_or_observation_id=aggregate_id,
            )
        raise DuplicateLinkResolutionError("duplicate_superseded_reference_missing")

    def rewrite_duplicate_linked_event_payload(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Upcast a ``DuplicateJobLinked`` payload only when it matches its row."""
        duplicate_link_id = _event_value(
            payload,
            _EVENT_LINK_ID_FIELDS,
            "duplicate_link_event_identity_invalid",
        )
        surviving_locator = _event_value(
            payload,
            _EVENT_SURVIVOR_FIELDS,
            "duplicate_link_event_identity_invalid",
        )
        superseded_reference = _event_value(
            payload,
            _EVENT_SUPERSEDED_FIELDS,
            "duplicate_link_event_identity_invalid",
        )
        source_rows = self._source.execute(
            """
            SELECT surviving_job_id, superseded_job_or_observation_id
              FROM job_duplicate_links
             WHERE tenant_id = ? AND duplicate_link_id = ?
            """,
            ("local", duplicate_link_id),
        ).fetchall()
        if len(source_rows) != 1:
            raise DuplicateLinkResolutionError("duplicate_link_event_link_missing")
        source_survivor, source_superseded = source_rows[0]
        if (
            str(source_survivor) != surviving_locator
            or str(source_superseded) != superseded_reference
        ):
            raise DuplicateLinkResolutionError("duplicate_link_event_table_conflict")

        resolved = self.resolve_link(
            tenant_id="local",
            surviving_job_locator=source_survivor,
            superseded_reference=source_superseded,
        )
        candidate_rows = self._candidate.execute(
            """
            SELECT surviving_job_id, superseded_job_or_observation_id
              FROM job_duplicate_links
             WHERE tenant_id = ? AND duplicate_link_id = ?
            """,
            ("local", duplicate_link_id),
        ).fetchall()
        if len(candidate_rows) != 1:
            raise DuplicateLinkResolutionError("duplicate_link_event_candidate_missing")
        if tuple(str(value) for value in candidate_rows[0]) != (
            resolved.surviving_job_id,
            resolved.superseded_job_or_observation_id,
        ):
            raise DuplicateLinkResolutionError("duplicate_link_event_table_conflict")

        rewritten = dict(payload)
        for field in _EVENT_SUPERSEDED_FIELDS:
            if field in rewritten:
                rewritten[field] = resolved.superseded_job_or_observation_id
        return rewritten

    def _resolve_survivor(self, tenant_id: str, locator: object) -> str:
        try:
            resolved = self._job_ids.resolve(tenant_id=tenant_id, locator=locator)
        except CandidateCopyError as error:
            raise DuplicateLinkResolutionError(
                "duplicate_surviving_job_identity_unresolved"
            ) from error
        if resolved is None:
            raise DuplicateLinkResolutionError(
                "duplicate_surviving_job_identity_invalid"
            )
        return resolved

    def _require_observation_owner(
        self,
        *,
        tenant: str,
        observation_id: object,
        observation_owner_locator: object,
        survivor_job_id: str,
    ) -> None:
        try:
            observation_owner = self._job_ids.resolve(
                tenant_id=tenant,
                locator=observation_owner_locator,
            )
        except CandidateCopyError as error:
            raise DuplicateLinkResolutionError(
                "duplicate_superseded_observation_owner_unresolved"
            ) from error
        if observation_owner != survivor_job_id:
            raise DuplicateLinkResolutionError(
                "duplicate_superseded_reference_owner_mismatch"
            )
        candidate_rows = self._candidate.execute(
            """
            SELECT job_id
              FROM job_source_observations
             WHERE tenant_id = ? AND source_observation_id = ?
            """,
            (tenant, str(observation_id)),
        ).fetchall()
        if len(candidate_rows) != 1:
            raise DuplicateLinkResolutionError(
                "candidate_duplicate_observation_missing"
            )
        if str(candidate_rows[0][0]) != survivor_job_id:
            raise DuplicateLinkResolutionError(
                "candidate_duplicate_observation_owner_mismatch"
            )


def copy_duplicate_links(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateDuplicateLinkCopyResult:
    """Copy v6 duplicate links after source observations have stable Job owners."""
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_candidate_job_ids(source, candidate, job_ids)
    _assert_columns(source, "source")
    _assert_columns(candidate, "candidate")
    if _row_count(candidate, "job_duplicate_links"):
        raise CandidateDuplicateLinkCopyError(
            "candidate job_duplicate_links must be empty"
        )
    _assert_observations_ready(source, candidate)

    source_rows = tuple(
        tuple(row)
        for row in source.execute(
            f"SELECT {', '.join(_quote(column) for column in _COLUMNS)} "
            "FROM job_duplicate_links ORDER BY tenant_id, duplicate_link_id"
        ).fetchall()
    )
    resolver = DuplicateLinkIdentityResolver(source, candidate, job_ids=job_ids)
    target_rows: list[tuple[object, ...]] = []
    for row in source_rows:
        values = dict(zip(_COLUMNS, row, strict=True))
        try:
            resolved = resolver.resolve_link(
                tenant_id=values["tenant_id"],
                surviving_job_locator=values["surviving_job_id"],
                superseded_reference=values["superseded_job_or_observation_id"],
            )
        except DuplicateLinkResolutionError as error:
            raise CandidateDuplicateLinkCopyError(str(error)) from error
        target_rows.append(
            (
                _tenant_id(values["tenant_id"]),
                values["duplicate_link_id"],
                resolved.surviving_job_id,
                resolved.superseded_job_or_observation_id,
                values["reason"],
                values["confidence"],
                values["linked_at"],
            )
        )

    candidate.execute("SAVEPOINT v6_duplicate_links_candidate_copy")
    try:
        if target_rows:
            placeholders = ", ".join("?" for _ in _COLUMNS)
            candidate.executemany(
                f"INSERT INTO job_duplicate_links ({', '.join(_quote(column) for column in _COLUMNS)}) "
                f"VALUES ({placeholders})",
                target_rows,
            )
        _verify_candidate(source, candidate, source_rows, tuple(target_rows))
        candidate.execute("RELEASE SAVEPOINT v6_duplicate_links_candidate_copy")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_duplicate_links_candidate_copy")
        candidate.execute("RELEASE SAVEPOINT v6_duplicate_links_candidate_copy")
        raise
    return CandidateDuplicateLinkCopyResult(copied_links=len(target_rows))


def _assert_candidate_job_ids(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        persisted = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateDuplicateLinkCopyError(
            "candidate JobIdMap is not hydrated"
        ) from error
    if dict(persisted.by_locator) != dict(job_ids.by_locator):
        raise CandidateDuplicateLinkCopyError(
            "candidate JobIdMap does not match root copy"
        )


def _assert_columns(conn: sqlite3.Connection, label: str) -> None:
    columns = tuple(
        str(row[1]) for row in conn.execute("PRAGMA table_info(job_duplicate_links)")
    )
    if columns != _COLUMNS:
        raise CandidateDuplicateLinkCopyError(
            f"{label} job_duplicate_links columns do not match admitted v6/exact v7"
        )


def _assert_observations_ready(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> None:
    if _row_count(source, "job_source_observations") != _row_count(
        candidate, "job_source_observations"
    ):
        raise CandidateDuplicateLinkCopyError(
            "candidate duplicate links require copied source observations"
        )


def _verify_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    expected_source_rows: tuple[tuple[object, ...], ...],
    expected_target_rows: tuple[tuple[object, ...], ...],
) -> None:
    candidate_rows = tuple(
        tuple(row)
        for row in candidate.execute(
            f"SELECT {', '.join(_quote(column) for column in _COLUMNS)} "
            "FROM job_duplicate_links ORDER BY tenant_id, duplicate_link_id"
        ).fetchall()
    )
    if candidate_rows != expected_target_rows:
        raise CandidateDuplicateLinkCopyError(
            "candidate duplicate-link copy changed rows or ordering"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateDuplicateLinkCopyError(
            "candidate duplicate-link copy left a foreign-key violation"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    source_rows_after = tuple(
        tuple(row)
        for row in source.execute(
            f"SELECT {', '.join(_quote(column) for column in _COLUMNS)} "
            "FROM job_duplicate_links ORDER BY tenant_id, duplicate_link_id"
        ).fetchall()
    )
    if source_rows_after != expected_source_rows:
        raise CandidateDuplicateLinkCopyError(
            "candidate duplicate-link copy mutated the v6 source"
        )


def _event_value(
    payload: dict[str, Any],
    fields: tuple[str, ...],
    error: str,
) -> str:
    values = [payload[field] for field in fields if field in payload]
    if not values or any(not isinstance(value, str) or not value.strip() for value in values):
        raise DuplicateLinkResolutionError(error)
    text = str(values[0])
    if any(str(value) != text for value in values[1:]):
        raise DuplicateLinkResolutionError("duplicate_link_event_table_conflict")
    return text


def _required_text(value: object, error: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DuplicateLinkResolutionError(error)
    return value


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_quote(table)}").fetchone()[0])


def _tenant_id(value: object) -> str:
    return str(value or "").strip() or "local"


def _quote(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


__all__ = [
    "CandidateDuplicateLinkCopyError",
    "CandidateDuplicateLinkCopyResult",
    "DuplicateLinkIdentityResolver",
    "DuplicateLinkResolutionError",
    "ResolvedDuplicateLink",
    "copy_duplicate_links",
]
