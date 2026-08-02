"""Phase 1: SqliteEmployerAnalysisRepository round-trip + cache + versioning.

Runs against a tmp SQLite database via ``init_db`` so the canonical
``job_employer_analysis`` schema is exercised end-to-end. Proves:

  * full round-trip (canonical + sub-analyses + failures + agreement);
  * the snapshot+version cache short-circuit (D-11/D-12);
  * generation versioning / supersede-not-destroy (D-13).
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials.analysis import (
    AnalysisAgreement,
    AnalysisFailure,
    EeoScreenHit,
    EmployerAnalysis,
    JobAnalysis,
    JobAnalysisDraft,
    compute_snapshot_hash,
)
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository

JOB_ID = JobId("00000000-0000-4000-8000-000000000031")
JOB_URL = "https://example.com/jobs/staff-be"
OTHER_TENANT = TenantId("other")
JD = "Staff Backend Engineer. Requires 8+ years in Go. Kafka is a plus."


@pytest.fixture()
def conn(tmp_path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    connection = init_db(db_path)
    connection.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(JOB_ID),
            JOB_URL,
            "Staff Backend Engineer",
            "example",
        ),
    )
    connection.commit()
    yield connection
    close_connection()


def _analysis() -> JobAnalysis:
    return JobAnalysis(
        role_framing="Own the payments platform.",
        inferred_seniority="staff",
        ideal_candidate_narrative="A distributed-systems owner.",
        requirements=[
            {
                "id": "r1",
                "text": "8+ years in Go",
                "tier": "must_have",
                "weight": 0.95,
                "evidence_span": "8+ years in Go",
            }
        ],
        keywords=[{"keyword": "Go", "evidence_span": "8+ years in Go", "requirement_ref": "r1"}],
    )


def _record(
    generation: int,
    *,
    job_id: JobId = JOB_ID,
    tenant_id: TenantId = LOCAL_TENANT,
) -> EmployerAnalysis:
    return EmployerAnalysis.build(
        tenant_id=tenant_id,
        job_id=job_id,
        generation=generation,
        snapshot_hash=compute_snapshot_hash(JD),
        canonical=_analysis(),
        sub_analyses=(JobAnalysisDraft(model_id="claude-opus-4-8", **_analysis().model_dump()),),
        failures=(AnalysisFailure(model_id="gpt-5.4", error="timeout", raw_output="{}"),),
        agreement=AnalysisAgreement(score=0.9, flagged_keywords=("kafka",)),
        legs_attempted=2,
    )


def test_round_trip_preserves_canonical_subanalyses_failures(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    repo.save(_record(generation=1))

    loaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert loaded is not None
    assert loaded.generation == 1
    assert loaded.canonical.requirements[0].tier == "must_have"
    assert loaded.canonical.requirements[0].weight == 0.95
    assert loaded.canonical.keywords[0].is_orphan is False  # ref resolves
    assert loaded.legs_succeeded == 1
    assert loaded.ensemble_completeness == "1/2"
    assert loaded.is_degraded is True
    assert loaded.failures[0].model_id == "gpt-5.4"
    assert loaded.agreement.flagged_keywords == ("kafka",)


def test_cache_hit_by_snapshot_and_version(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    record = _record(generation=1)
    repo.save(record)

    hit = repo.get_by_cache_key(LOCAL_TENANT, JOB_ID, record.cache_key)
    assert hit is not None
    assert hit.generation == 1

    miss = repo.get_by_cache_key(LOCAL_TENANT, JOB_ID, "different-snapshot:p:s")
    assert miss is None


def test_next_generation_is_monotonic(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    assert repo.next_generation(LOCAL_TENANT, JOB_ID) == 1
    repo.save(_record(generation=1))
    assert repo.next_generation(LOCAL_TENANT, JOB_ID) == 2


def test_new_generation_supersedes_but_does_not_destroy_prior(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    repo.save(_record(generation=1))
    repo.save(_record(generation=2))

    # load() returns the latest...
    latest = repo.load(LOCAL_TENANT, JOB_ID)
    assert latest is not None and latest.generation == 2
    # ...but the prior generation remains as audit history (D-13).
    prior = repo.load(LOCAL_TENANT, JOB_ID, generation=1)
    assert prior is not None and prior.generation == 1


def test_round_trip_preserves_eeo_screen_hits(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    record = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(JD),
        canonical=_analysis(),
        sub_analyses=(JobAnalysisDraft(model_id="claude-opus-4-8", **_analysis().model_dump()),),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
        eeo_screen_hits=(
            EeoScreenHit(
                kind="requirement",
                ref_id="r9",
                category="age",
                matched_text="recent grad",
            ),
        ),
    )
    repo.save(record)

    loaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert loaded is not None
    assert loaded.eeo_screen_hits == record.eeo_screen_hits


def test_resave_same_generation_overwrites_children(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    repo.save(_record(generation=1))
    # Re-save the same generation with no failures -> child rows replaced.
    no_failures = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=1,
        snapshot_hash=compute_snapshot_hash(JD),
        canonical=_analysis(),
        sub_analyses=(JobAnalysisDraft(model_id="claude-opus-4-8", **_analysis().model_dump()),),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=1,
    )
    repo.save(no_failures)
    loaded = repo.load(LOCAL_TENANT, JOB_ID)
    assert loaded is not None
    assert loaded.failures == ()
    assert loaded.ensemble_completeness == "1/1"


def test_failed_child_replacement_preserves_complete_prior_aggregate(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)
    prior = _record(generation=1)
    repo.save(prior)
    draft = JobAnalysisDraft(
        model_id="duplicate-model",
        **_analysis().model_dump(),
    )
    invalid_replacement = EmployerAnalysis.build(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=1,
        snapshot_hash="replacement-snapshot",
        canonical=_analysis().model_copy(update={"role_framing": "Replacement framing."}),
        sub_analyses=(draft, draft),
        failures=(),
        agreement=AnalysisAgreement(score=1.0),
        legs_attempted=2,
    )

    with pytest.raises(sqlite3.IntegrityError):
        repo.save(invalid_replacement)

    assert conn.in_transaction is False
    conn.commit()
    preserved = repo.load(LOCAL_TENANT, JOB_ID)
    assert preserved is not None
    assert preserved.snapshot_hash == prior.snapshot_hash
    assert preserved.canonical.role_framing == prior.canonical.role_framing
    assert preserved.failures == prior.failures
    assert preserved.sub_analyses == prior.sub_analyses


def test_repository_requires_canonical_job_id(conn: sqlite3.Connection) -> None:
    repo = SqliteEmployerAnalysisRepository(conn)

    with pytest.raises(ValueError, match="canonical UUID"):
        repo.load(LOCAL_TENANT, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.get_by_cache_key(LOCAL_TENANT, JobId(JOB_URL), "cache-key")
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.next_generation(LOCAL_TENANT, JobId(JOB_URL))
    with pytest.raises(ValueError, match="canonical UUID"):
        repo.save(_record(generation=1, job_id=JobId(JOB_URL)))


def test_repository_does_not_create_runtime_schema() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        SqliteEmployerAnalysisRepository(connection)

        tables = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        assert tables == []
    finally:
        connection.close()


def test_same_job_id_is_isolated_by_tenant(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, site)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            str(OTHER_TENANT),
            str(JOB_ID),
            JOB_URL,
            "Staff Backend Engineer",
            "example",
        ),
    )
    conn.commit()
    repo = SqliteEmployerAnalysisRepository(conn)

    repo.save(_record(generation=1))
    repo.save(_record(generation=1, tenant_id=OTHER_TENANT))

    local = repo.load(LOCAL_TENANT, JOB_ID)
    other = repo.load(OTHER_TENANT, JOB_ID)
    assert local is not None and local.tenant_id == LOCAL_TENANT
    assert other is not None and other.tenant_id == OTHER_TENANT
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_employer_analysis WHERE job_id = ? AND generation = 1",
            (str(JOB_ID),),
        ).fetchone()[0]
        == 2
    )
