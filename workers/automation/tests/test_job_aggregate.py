"""Phase 7 / S-25: Job aggregate + discovery value object invariants.

These tests pin the constructor invariants so the aggregate and its
value objects refuse to accept invalid data. Behaviour exercised here
is pure data — no I/O, no fakes — so failures point straight at the
type definitions.
"""

from __future__ import annotations

import pytest

from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT


# ---------------------------------------------------------------------------
# PostingUrl
# ---------------------------------------------------------------------------


def test_posting_url_accepts_non_empty_string() -> None:
    assert PostingUrl(value="https://example.com/jobs/1").value == "https://example.com/jobs/1"
    assert str(PostingUrl(value="abc")) == "abc"


@pytest.mark.parametrize("value", ["", "   ", None, 123])
def test_posting_url_rejects_invalid(value: object) -> None:
    with pytest.raises(ValueError):
        PostingUrl(value=value)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------


def test_source_carries_only_the_board() -> None:
    src = Source(board="linkedin")
    assert src.board == "linkedin"


@pytest.mark.parametrize("value", ["", "   ", None])
def test_source_rejects_invalid_board(value: object) -> None:
    with pytest.raises(ValueError):
        Source(board=value)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Employer
# ---------------------------------------------------------------------------


def test_employer_default_is_unknown() -> None:
    assert Employer.unknown().is_unknown()
    assert Employer().is_unknown()


def test_employer_with_named_company() -> None:
    e = Employer(name="Acme Corp")
    assert e.name == "Acme Corp"
    assert not e.is_unknown()


@pytest.mark.parametrize("value", ["", "   ", None])
def test_employer_rejects_invalid_name(value: object) -> None:
    with pytest.raises(ValueError):
        Employer(name=value)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# SearchStrategy
# ---------------------------------------------------------------------------


def test_search_strategy_canonical_values() -> None:
    assert {s.value for s in SearchStrategy} == {
        "jobspy",
        "workday_api",
        "smart_extract",
        "manual",
    }


def test_search_strategy_from_optional_round_trips() -> None:
    assert SearchStrategy.from_optional("jobspy") is SearchStrategy.JOBSPY
    assert SearchStrategy.from_optional("WORKDAY_API") is SearchStrategy.WORKDAY_API
    assert SearchStrategy.from_optional("manual") is SearchStrategy.MANUAL


def test_search_strategy_from_optional_returns_none_for_unknown() -> None:
    assert SearchStrategy.from_optional(None) is None
    assert SearchStrategy.from_optional("") is None
    assert SearchStrategy.from_optional("json_ld") is None  # legacy free-form scraper name


# ---------------------------------------------------------------------------
# JobMetadata
# ---------------------------------------------------------------------------


def test_job_metadata_defaults_to_empty_strings() -> None:
    md = JobMetadata()
    assert md.title == ""
    assert md.salary == ""
    assert md.description == ""
    assert md.location == ""


def test_job_metadata_to_dict_round_trips() -> None:
    md = JobMetadata(
        title="Senior Engineer",
        salary="$200k",
        description="Build great things.",
        location="Remote",
    )
    assert md.to_dict() == {
        "title": "Senior Engineer",
        "salary": "$200k",
        "description": "Build great things.",
        "location": "Remote",
    }


@pytest.mark.parametrize(
    "kwargs",
    [
        {"title": 123},
        {"salary": None},
        {"description": ["bullet"]},
        {"location": object()},
    ],
)
def test_job_metadata_rejects_non_string_fields(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        JobMetadata(**kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Job aggregate construction + invariants
# ---------------------------------------------------------------------------


def _make_job(**overrides) -> Job:
    base = dict(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/jobs/1"),
        posting_url=PostingUrl(value="https://example.com/jobs/1"),
        source=Source(board="greenhouse"),
        employer=Employer(name="Acme Corp"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Engineer"),
        discovered_at="2026-05-01T00:00:00+00:00",
    )
    base.update(overrides)
    return Job.discover(**base)


def test_job_discover_creates_undeleted_aggregate() -> None:
    job = _make_job()
    assert job.is_deleted is False
    assert job.deleted_at is None
    assert job.delete_reason is None
    assert job.posting_url.value == "https://example.com/jobs/1"
    assert job.source.board == "greenhouse"
    assert job.employer.name == "Acme Corp"


def test_job_rejects_empty_discovered_at() -> None:
    with pytest.raises(ValueError):
        Job.discover(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            posting_url=PostingUrl(value="u"),
            source=Source(board="b"),
            employer=Employer(name="e"),
            search_strategy=SearchStrategy.MANUAL,
            metadata=JobMetadata(),
            discovered_at="",
        )


def test_job_rejects_wrong_value_object_types() -> None:
    with pytest.raises(ValueError):
        Job(
            tenant_id=LOCAL_TENANT,
            job_id=JobId("u"),
            posting_url="not-a-vo",  # type: ignore[arg-type]
            source=Source(board="b"),
            employer=Employer(name="e"),
            search_strategy=SearchStrategy.MANUAL,
            metadata=JobMetadata(),
            discovered_at="2026-05-01T00:00:00+00:00",
        )


# ---------------------------------------------------------------------------
# Lifecycle transitions
# ---------------------------------------------------------------------------


def test_job_with_metadata_returns_new_instance() -> None:
    original = _make_job()
    updated = original.with_metadata(JobMetadata(title="Staff Engineer", salary="$250k"))
    assert original.metadata.title == "Engineer"
    assert updated.metadata.title == "Staff Engineer"
    assert updated.metadata.salary == "$250k"
    # Identity preserved
    assert updated.job_id == original.job_id
    assert updated.discovered_at == original.discovered_at


def test_job_with_employer_upgrades_unknown() -> None:
    job = _make_job(employer=Employer.unknown())
    assert job.employer.is_unknown()
    upgraded = job.with_employer(Employer(name="Acme Corp"))
    assert upgraded.employer.name == "Acme Corp"
    assert not upgraded.employer.is_unknown()


def test_job_soft_delete_sets_tombstone_fields() -> None:
    job = _make_job()
    deleted = job.soft_delete(reason="not interested", deleted_at="2026-05-02T00:00:00+00:00")
    assert deleted.is_deleted is True
    assert deleted.deleted_at == "2026-05-02T00:00:00+00:00"
    assert deleted.delete_reason == "not interested"
    # Original unchanged
    assert job.is_deleted is False


def test_job_soft_delete_idempotent_overwrite() -> None:
    """Re-deleting overwrites timestamp/reason (matches API ON CONFLICT semantics)."""
    job = _make_job()
    first = job.soft_delete(reason="reason1", deleted_at="2026-05-02T00:00:00+00:00")
    second = first.soft_delete(reason="reason2", deleted_at="2026-05-03T00:00:00+00:00")
    assert second.deleted_at == "2026-05-03T00:00:00+00:00"
    assert second.delete_reason == "reason2"


def test_job_soft_delete_requires_timestamp() -> None:
    job = _make_job()
    with pytest.raises(ValueError):
        job.soft_delete(reason="x", deleted_at="")


def test_job_restore_clears_tombstone() -> None:
    deleted = _make_job().soft_delete(reason="x", deleted_at="2026-05-02T00:00:00+00:00")
    restored = deleted.restore()
    assert restored.is_deleted is False
    assert restored.deleted_at is None
    assert restored.delete_reason is None


def test_job_restore_is_noop_on_undeleted_job() -> None:
    job = _make_job()
    assert job.restore() == job


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def test_job_to_dict_serialises_all_fields() -> None:
    job = _make_job().soft_delete(reason="r", deleted_at="2026-05-02T00:00:00+00:00")
    d = job.to_dict()
    assert d["tenant_id"] == "local"
    assert d["posting_url"] == "https://example.com/jobs/1"
    assert d["source"] == "greenhouse"
    assert d["employer"] == "Acme Corp"
    assert d["search_strategy"] == "jobspy"
    assert d["metadata"]["title"] == "Engineer"
    assert d["deleted_at"] == "2026-05-02T00:00:00+00:00"
    assert d["delete_reason"] == "r"
