"""Focused contracts for v6 duplicate-link identity migration."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.domain.discovery.identity import normalize_observed_url
from jobctrl.infrastructure.migrations import v6_to_v7_duplicate_links as duplicate_links
from jobctrl.infrastructure.migrations.schema_v7 import (
    create_unstamped_exact_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import copy_direct_and_scalar_tables
from jobctrl.infrastructure.migrations.v6_to_v7_duplicate_links import (
    CandidateDuplicateLinkCopyError,
    copy_duplicate_links,
)
from jobctrl.infrastructure.migrations.v6_to_v7_events import (
    CandidateEventCopyError,
    copy_job_events,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_OWNER_URL = "https://jobs.example/shipped-v6"
_OWNER_ID = "00000000-0000-4000-8000-000000000001"
_PRIOR_URL = "https://jobs.example/prior"
_PRIOR_ID = "00000000-0000-4000-8000-000000000002"
_OBSERVED_URL = "https://careers.example/platform-engineer?utm_source=board"
_NOW = "2026-07-30T10:00:00+00:00"


def _connections(tmp_path: Path) -> tuple[sqlite3.Connection, sqlite3.Connection, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate = sqlite3.connect(tmp_path / "candidate.db")
    candidate.execute("PRAGMA foreign_keys = ON")
    create_unstamped_exact_v7_candidate(candidate)
    return source, candidate, source_path


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _prepare_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: tuple[str, ...] = (_OWNER_ID,),
):
    root = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(*job_ids),
        migration_at=_NOW,
    )
    copy_direct_and_scalar_tables(source, candidate)
    return root.job_ids


def _insert_job(conn: sqlite3.Connection, url: str) -> None:
    conn.execute(
        "INSERT INTO jobs (url, title, discovered_at) VALUES (?, ?, ?)",
        (url, "Legacy duplicate", _NOW),
    )


def _insert_observation(
    conn: sqlite3.Connection,
    *,
    observation_id: str,
    job_url: str = _OWNER_URL,
    observed_url: str = _OBSERVED_URL,
    source_native_id: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_source_observations (
            tenant_id, source_observation_id, job_url, source_id,
            source_native_id, observed_url, normalized_observed_url, run_id,
            observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            observation_id,
            job_url,
            "legacy-test",
            source_native_id or observed_url,
            observed_url,
            normalize_observed_url(observed_url),
            "legacy-run",
            _NOW,
        ),
    )


def _insert_link(
    conn: sqlite3.Connection,
    *,
    duplicate_link_id: str = "dup:legacy",
    surviving_url: str = _OWNER_URL,
    superseded_reference: str = _OBSERVED_URL,
) -> None:
    conn.execute(
        """
        INSERT INTO job_duplicate_links (
            tenant_id, duplicate_link_id, surviving_job_id,
            superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "local",
            duplicate_link_id,
            surviving_url,
            superseded_reference,
            "content_fingerprint_match",
            0.95,
            _NOW,
        ),
    )


def _insert_duplicate_linked_event(
    conn: sqlite3.Connection,
    *,
    duplicate_link_id: str,
    surviving_url: str = _OWNER_URL,
    superseded_reference: str = _OBSERVED_URL,
) -> None:
    conn.execute(
        """
        INSERT INTO job_events (
            event_id, job_url, stage, event_type, level, message, occurred_at,
            payload_json, entity_kind, entity_ref, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            1,
            surviving_url,
            "discover",
            "DuplicateJobLinked",
            "info",
            "legacy duplicate",
            _NOW,
            json.dumps(
                {
                    "duplicate_link_id": duplicate_link_id,
                    "surviving_job_id": surviving_url,
                    "superseded_job_or_observation_id": superseded_reference,
                    "reason": "content_fingerprint_match",
                    "confidence": 0.95,
                },
                separators=(",", ":"),
            ),
            "job",
            surviving_url,
            "duplicate-event",
        ),
    )


def test_jobspy_url_reference_resolves_to_the_actual_replaced_observation_id(
    tmp_path: Path,
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        jobspy_observation_id = "jobspy:6be241de5c381a3983880d15"
        _insert_observation(
            source,
            observation_id=jobspy_observation_id,
            source_native_id=normalize_observed_url(_OBSERVED_URL),
        )
        _insert_link(source, duplicate_link_id="content:legacy")
        source.commit()
        source_bytes = source_path.read_bytes()

        job_ids = _prepare_candidate(source, candidate)
        copied = copy_duplicate_links(source, candidate, job_ids=job_ids)

        assert copied.copied_links == 1
        assert candidate.execute(
            """
            SELECT surviving_job_id, superseded_job_or_observation_id
              FROM job_duplicate_links
            """
        ).fetchone() == (_OWNER_ID, jobspy_observation_id)
        assert source_path.read_bytes() == source_bytes
        candidate.close()
        candidate = sqlite3.connect(tmp_path / "candidate.db")
        candidate.execute("PRAGMA foreign_keys = ON")
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert candidate.execute(
            "SELECT superseded_job_or_observation_id FROM job_duplicate_links"
        ).fetchone() == (jobspy_observation_id,)
    finally:
        source.close()
        candidate.close()


def test_smartextract_url_reference_and_event_share_the_observation_resolution(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        observation_id = "obs:8ef58c4f3cfb4adca20d4712b10caef7"
        _insert_observation(source, observation_id=observation_id)
        _insert_link(source, duplicate_link_id="dup:smart")
        _insert_duplicate_linked_event(source, duplicate_link_id="dup:smart")
        source.commit()

        job_ids = _prepare_candidate(source, candidate)
        copy_duplicate_links(source, candidate, job_ids=job_ids)
        copy_job_events(source, candidate, job_ids=job_ids)

        payload = json.loads(
            str(candidate.execute("SELECT payload_json FROM job_events").fetchone()[0])
        )
        assert payload["surviving_job_id"] == _OWNER_ID
        assert payload["superseded_job_or_observation_id"] == observation_id
        assert candidate.execute(
            """
            SELECT surviving_job_id, superseded_job_or_observation_id
              FROM job_duplicate_links WHERE duplicate_link_id = 'dup:smart'
            """
        ).fetchone() == (_OWNER_ID, observation_id)
    finally:
        source.close()
        candidate.close()


def test_existing_observation_id_is_preserved_only_for_the_surviving_owner(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        observation_id = "obs:already-canonical"
        _insert_observation(source, observation_id=observation_id)
        _insert_link(source, superseded_reference=observation_id)
        source.commit()

        job_ids = _prepare_candidate(source, candidate)
        copy_duplicate_links(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT superseded_job_or_observation_id FROM job_duplicate_links"
        ).fetchone() == (observation_id,)
    finally:
        source.close()
        candidate.close()


def test_real_two_aggregate_collapse_resolves_the_second_job_to_its_job_id(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        _insert_job(source, _PRIOR_URL)
        _insert_link(source, superseded_reference=_PRIOR_URL)
        source.commit()

        job_ids = _prepare_candidate(source, candidate, job_ids=(_OWNER_ID, _PRIOR_ID))
        copy_duplicate_links(source, candidate, job_ids=job_ids)

        assert candidate.execute(
            "SELECT surviving_job_id, superseded_job_or_observation_id FROM job_duplicate_links"
        ).fetchone() == (_OWNER_ID, _PRIOR_ID)
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    ("setup", "expected_error"),
    (
        ("missing", "duplicate_superseded_reference_missing"),
        ("self", "duplicate_superseded_reference_self"),
        ("owner_mismatch", "duplicate_superseded_reference_owner_mismatch"),
        ("ambiguous", "duplicate_superseded_reference_ambiguous"),
    ),
)
def test_duplicate_link_copy_fails_closed_for_unproven_or_ambiguous_references(
    tmp_path: Path,
    setup: str,
    expected_error: str,
) -> None:
    source, candidate, _ = _connections(tmp_path)
    try:
        job_ids = (_OWNER_ID,)
        superseded_reference = _OBSERVED_URL
        if setup == "self":
            superseded_reference = _OWNER_URL
        elif setup == "owner_mismatch":
            _insert_job(source, _PRIOR_URL)
            _insert_observation(
                source,
                observation_id="obs:other-owner",
                job_url=_PRIOR_URL,
            )
            job_ids = (_OWNER_ID, _PRIOR_ID)
        elif setup == "ambiguous":
            _insert_job(source, _PRIOR_URL)
            _insert_observation(
                source,
                observation_id="obs:owner-but-root-exists",
                observed_url=_PRIOR_URL,
            )
            superseded_reference = _PRIOR_URL
            job_ids = (_OWNER_ID, _PRIOR_ID)
        _insert_link(source, superseded_reference=superseded_reference)
        source.commit()

        resolved_job_ids = _prepare_candidate(source, candidate, job_ids=job_ids)
        with pytest.raises(CandidateDuplicateLinkCopyError, match=expected_error):
            copy_duplicate_links(source, candidate, job_ids=resolved_job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_duplicate_link_copy_rolls_back_and_retries_without_mutating_v6_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        _insert_observation(source, observation_id="obs:retry")
        _insert_link(source)
        source.commit()
        source_bytes = source_path.read_bytes()
        job_ids = _prepare_candidate(source, candidate)
        original_verify = duplicate_links._verify_candidate
        monkeypatch.setattr(
            duplicate_links,
            "_verify_candidate",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("candidate fault")),
        )

        with pytest.raises(RuntimeError, match="candidate fault"):
            copy_duplicate_links(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_duplicate_links").fetchone() == (0,)
        assert source_path.read_bytes() == source_bytes
        monkeypatch.setattr(duplicate_links, "_verify_candidate", original_verify)

        copied = copy_duplicate_links(source, candidate, job_ids=job_ids)
        assert copied.copied_links == 1
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_duplicate_linked_event_rejects_a_payload_that_disagrees_with_its_row(
    tmp_path: Path,
) -> None:
    source, candidate, source_path = _connections(tmp_path)
    try:
        observation_id = "obs:event-consistency"
        _insert_observation(source, observation_id=observation_id)
        _insert_link(source, duplicate_link_id="dup:event")
        _insert_duplicate_linked_event(
            source,
            duplicate_link_id="dup:event",
            superseded_reference="https://different.example/role",
        )
        source.commit()
        source_bytes = source_path.read_bytes()

        job_ids = _prepare_candidate(source, candidate)
        copy_duplicate_links(source, candidate, job_ids=job_ids)
        with pytest.raises(CandidateEventCopyError, match="duplicate_link_event_table_conflict"):
            copy_job_events(source, candidate, job_ids=job_ids)

        assert candidate.execute("SELECT COUNT(*) FROM job_events").fetchone() == (0,)
        assert source_path.read_bytes() == source_bytes
    finally:
        source.close()
        candidate.close()
