"""A9: the tailor generation flip commits atomically via SqliteUnitOfWork.

The tailor persist path performs a three-write "generation flip": supersede the
prior approved generation, save the new generation, then record the new
generation's provenance/coverage. Before A9 each SQLite repository committed per
call, so the flip was three separate transactions:

  * a crash between the supersede and the new-generation save could leave the job
    with NO current approved resume (prior superseded, replacement never saved);
  * a provenance write failure after the artifact committed left an approved
    generation with no provenance, breaking the audit invariant that every
    committed approved generation has its provenance.

These tests drive the REAL SQLite repositories over one connection. They assert
that with a shared :class:`SqliteUnitOfWork` a failure anywhere in the flip rolls
the WHOLE block back, and — as a control — that WITHOUT the unit of work (the
pre-A9 per-call-commit behaviour) the same failure leaves the documented bad
state. The control is what proves the unit of work is load-bearing rather than
incidental.
"""

from __future__ import annotations

from copy import deepcopy
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    JudgeVerdict,
    MaterialsSet,
    MaterialsSetFactory,
    RenderFormat,
    ValidationResult,
)
from jobctrl.domain.materials.provenance import BulletProvenance, BulletProvenanceSet
from jobctrl.domain.materials.policy import (
    TailoringPolicy,
    TailoringPolicyChangedError,
    fingerprint_profile_snapshot,
)
from jobctrl.domain.materials.value_objects import ControlRule, TransformType
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.materials import (
    SqliteBulletProvenanceRepository,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
    SqliteUnitOfWork,
)
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository

JOB_URL = "https://example.com/job/uow"
JOB_ID = JobId("00000000-0000-4000-8000-000000000044")


# ---------------------------------------------------------------------------
# Fixtures + builders
# ---------------------------------------------------------------------------


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = init_db(tmp_path / "jobctrl.db")
    connection.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (LOCAL_TENANT, JOB_ID, JOB_URL, "Senior Backend Engineer", "Acme", "Own Python services.", 9, "2024-01-01T00:00:00+00:00"),
    )
    connection.commit()
    return connection


def _artifact(artifact_type: ArtifactType, *, path: str, render_format: RenderFormat) -> Artifact:
    return Artifact.create(
        type=artifact_type,
        path=path,
        created_at="2024-01-01T00:00:00+00:00",
        render_format=render_format,
        size_bytes=128,
    )


def _approve_with_pdf(base: MaterialsSet, *, resume_path: str, pdf_path: str, updated_at: str) -> MaterialsSet:
    approved = base.with_resume_attempt(
        _artifact(ArtifactType.TAILORED_RESUME, path=resume_path, render_format=RenderFormat.TEXT),
        validation=ValidationResult.success(),
        verdict=JudgeVerdict.passed(),
        updated_at=updated_at,
    )
    return approved.with_resume_pdf(
        _artifact(ArtifactType.RESUME_PDF, path=pdf_path, render_format=RenderFormat.HTML_PDF),
        updated_at=updated_at,
    )


def _gen1_approved() -> MaterialsSet:
    base = MaterialsSet.initial(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        created_at="2024-01-01T00:00:00+00:00",
    )
    return _approve_with_pdf(
        base,
        resume_path="/tmp/uow_g1.txt",
        pdf_path="/tmp/uow_g1.pdf",
        updated_at="2024-01-02T00:00:00+00:00",
    )


def _provenance_set(generation: int, *, artifact_id: str, text: str) -> BulletProvenanceSet:
    return BulletProvenanceSet(
        tenant_id=LOCAL_TENANT,
        job_id=JOB_ID,
        generation=generation,
        artifact_id=artifact_id,
        bullets=(
            BulletProvenance(
                bullet_id="experience:acme_swe#0",
                section="experience",
                source_id="acme_swe",
                evidence_ids=("ev_latency",),
                requirement_ids=("req_latency",),
                matched_keywords=("latency",),
                transform_type=TransformType.REPHRASE,
                control=ControlRule.REPHRASE_ALLOWED,
                rationale="reworded a real profile bullet",
                generated_text=text,
            ),
        ),
    )


class _FailAfterNSaves:
    """Delegates to a real repository but raises on the Nth ``save`` call.

    Models a crash / disk error partway through the flip: earlier writes are
    already staged in the (deferred) transaction when the failure fires.
    """

    def __init__(self, inner: object, *, fail_on: int) -> None:
        self._inner = inner
        self._fail_on = fail_on
        self.calls = 0

    def save(self, arg: object) -> None:
        self.calls += 1
        if self.calls >= self._fail_on:
            raise RuntimeError("simulated crash mid-flip")
        self._inner.save(arg)

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)


def _next_generation_approved(materials_repo: SqliteMaterialsRepository) -> tuple[MaterialsSet, MaterialsSet]:
    """Return ``(superseded_gen1, approved_gen2)`` from the persisted gen 1."""
    superseded, fresh = MaterialsSetFactory.next_generation(
        materials_repo.load(LOCAL_TENANT, JOB_ID),
        created_at="2024-01-03T00:00:00+00:00",
    )
    gen2 = _approve_with_pdf(
        fresh,
        resume_path="/tmp/uow_g2.txt",
        pdf_path="/tmp/uow_g2.pdf",
        updated_at="2024-01-03T00:00:00+00:00",
    )
    return superseded, gen2


# ---------------------------------------------------------------------------
# With the unit of work: the flip is atomic
# ---------------------------------------------------------------------------


def test_flip_rolls_back_when_new_generation_save_fails(conn: sqlite3.Connection) -> None:
    """A crash between the supersede and the new-generation save must leave the
    prior approved generation current (rollback), not ``None``."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    materials.save(_gen1_approved())

    superseded, gen2 = _next_generation_approved(materials)
    failing = _FailAfterNSaves(materials, fail_on=2)  # supersede stages, gen-2 save raises

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        with uow:
            failing.save(superseded)
            failing.save(gen2)

    current = materials.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current is not None
    assert current.generation == 1
    assert current.is_resume_approved
    assert current.tailored_resume is not None
    assert current.tailored_resume.status is ArtifactStatus.APPROVED
    # The rolled-back generation 2 left no row behind.
    assert materials.load(LOCAL_TENANT, JOB_ID, generation=2) is None


def test_flip_rolls_back_when_provenance_save_fails(conn: sqlite3.Connection) -> None:
    """A provenance write failure must roll the WHOLE flip back: the prior
    generation stays current with its provenance, and the new generation leaves
    neither an artifact row nor orphaned provenance behind."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    provenance = SqliteBulletProvenanceRepository(conn, unit_of_work=uow)

    materials.save(_gen1_approved())
    gen1_artifact_id = (
        materials.load(LOCAL_TENANT, JOB_ID).tailored_resume.artifact_id  # type: ignore[union-attr]
    )
    provenance.save(_provenance_set(1, artifact_id=gen1_artifact_id, text="Gen 1 grounded bullet."))

    superseded, gen2 = _next_generation_approved(materials)
    gen2_artifact_id = gen2.tailored_resume.artifact_id  # type: ignore[union-attr]
    failing_provenance = _FailAfterNSaves(provenance, fail_on=1)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        with uow:
            materials.save(superseded)
            materials.save(gen2)
            failing_provenance.save(
                _provenance_set(2, artifact_id=gen2_artifact_id, text="Gen 2 grounded bullet.")
            )

    # Preservation invariant: generation 1 is still the current approved resume.
    current = materials.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current is not None
    assert current.generation == 1
    assert current.is_resume_approved
    # Generation 1 provenance survived; generation 2 orphaned nothing.
    assert provenance.load(LOCAL_TENANT, JOB_ID, generation=1) is not None
    assert provenance.load(LOCAL_TENANT, JOB_ID, generation=2) is None
    assert materials.load(LOCAL_TENANT, JOB_ID, generation=2) is None


def test_flip_commits_once_on_success(conn: sqlite3.Connection) -> None:
    """The happy path is unchanged: a clean flip commits the supersede, the new
    generation, and its provenance together."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    provenance = SqliteBulletProvenanceRepository(conn, unit_of_work=uow)

    materials.save(_gen1_approved())
    superseded, gen2 = _next_generation_approved(materials)
    gen2_artifact_id = gen2.tailored_resume.artifact_id  # type: ignore[union-attr]

    with uow:
        materials.save(superseded)
        materials.save(gen2)
        provenance.save(
            _provenance_set(2, artifact_id=gen2_artifact_id, text="Gen 2 grounded bullet.")
        )

    current = materials.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current is not None and current.generation == 2 and current.is_resume_approved
    assert provenance.load(LOCAL_TENANT, JOB_ID, generation=2) is not None
    # Generation 1 was superseded, so it is no longer the current approved resume,
    # but its row is retained as audit history.
    assert materials.load(LOCAL_TENANT, JOB_ID, generation=1) is not None


def test_flip_holds_one_explicit_transaction_and_locks_out_competitors(
    conn: sqlite3.Connection, tmp_path: Path
) -> None:
    """The unit of work makes the flip's transaction explicit and enforced.

    ``__enter__`` opens a ``BEGIN IMMEDIATE``, so the shared connection stays in a
    single transaction across every staged write (not merely by convention that no
    other statement commits), and the write lock is held for the whole block: a
    competing writer on a second connection cannot open its own transaction into
    the flip window. This proves the atomicity no longer rests on the unenforced
    assumption the reviewer flagged."""
    uow = SqliteUnitOfWork(conn)
    materials = SqliteMaterialsRepository(conn, unit_of_work=uow)
    provenance = SqliteBulletProvenanceRepository(conn, unit_of_work=uow)

    materials.save(_gen1_approved())
    superseded, gen2 = _next_generation_approved(materials)
    gen2_artifact_id = gen2.tailored_resume.artifact_id  # type: ignore[union-attr]

    # A second connection to the SAME database file, set to fail fast instead of
    # waiting the production busy_timeout, standing in for a concurrent worker.
    competitor = sqlite3.connect(str(tmp_path / "jobctrl.db"), timeout=0.2)
    try:
        assert conn.in_transaction is False  # eager gen-1 save already committed
        with uow:
            materials.save(superseded)
            assert conn.in_transaction is True  # BEGIN IMMEDIATE opened the block
            materials.save(gen2)
            provenance.save(
                _provenance_set(2, artifact_id=gen2_artifact_id, text="Gen 2 grounded bullet.")
            )
            assert conn.in_transaction is True  # still one open transaction
            # The flip holds SQLite's write lock, so a second writer is refused.
            with pytest.raises(sqlite3.OperationalError, match="lock"):
                competitor.execute("BEGIN IMMEDIATE")
        assert conn.in_transaction is False  # commit released the write lock
    finally:
        competitor.close()

    current = materials.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current is not None and current.generation == 2 and current.is_resume_approved
    assert provenance.load(LOCAL_TENANT, JOB_ID, generation=2) is not None


def test_profile_update_during_generation_rejects_stale_artifact_commit(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    """A profile save after generation starts must win before artifact commit."""

    profile_data = {
        "personal": {"full_name": "Jordan Candidate", "email": "j@example.com"},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Built APIs."],
                }
            ],
            "education_entries": [],
            "skill_categories": [
                {"id": "skills", "label": "Skills", "items": ["Python"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["role_1"],
                "required_skill_category_ids": ["skills"],
                "writing_style": {"tone": "direct"},
            },
        },
        "resume_constraints": {"real_metrics": []},
    }
    bus = InProcessEventBus()
    profile_repository = SqliteProfileRepository(conn, publisher=bus)
    profile_repository.save(
        LOCAL_TENANT,
        Profile.from_dict(LOCAL_TENANT, profile_data),
    )
    db_path = tmp_path / "jobctrl.db"
    generation_loaded = threading.Event()
    allow_persist = threading.Event()

    def generate_from_loaded_snapshot() -> str:
        worker_conn = sqlite3.connect(db_path, timeout=5)
        worker_conn.row_factory = sqlite3.Row
        worker_uow = SqliteUnitOfWork(worker_conn)
        worker_profiles = SqliteProfileRepository(
            worker_conn,
            publisher=InProcessEventBus(),
        )
        snapshot = worker_profiles.load_snapshot(LOCAL_TENANT)
        policy_repository = SqliteTailoringPolicyRepository(
            worker_conn,
            unit_of_work=worker_uow,
        )
        policy = policy_repository.resolve_current(
            TailoringPolicy.from_runtime(
                tenant_id=LOCAL_TENANT,
                version=1,
                prompt_version="tailor.v2.quality-gated",
                schema_version="tailored-resume.v1",
                judge_schema_version="tailor-judge.v1",
                prompt_text="stable global control prompt",
                profile_policy={},
                custom_prompt="",
                generator_settings={"candidate_models": ["local:draft"]},
                judge_settings={"judge_model": "local:judge"},
                runtime_settings={
                    "validation_mode": "normal",
                    "profile_snapshot_fingerprint": fingerprint_profile_snapshot(
                        snapshot
                    ),
                },
                created_at="2026-08-06T00:00:00+00:00",
            )
        )
        generation_loaded.set()
        assert allow_persist.wait(timeout=5)
        try:
            with worker_uow:
                policy_repository.assert_generation_current(policy, snapshot)
                SqliteMaterialsRepository(
                    worker_conn,
                    unit_of_work=worker_uow,
                ).save(_gen1_approved())
        except TailoringPolicyChangedError as exc:
            return str(exc)
        finally:
            worker_conn.close()
        return "committed"

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(generate_from_loaded_snapshot)
        assert generation_loaded.wait(timeout=5)
        changed_profile = deepcopy(profile_data)
        changed_profile["resume"]["tailoring_rules"] = {
            **profile_data["resume"]["tailoring_rules"],
            "writing_style": {"tone": "technical"},
        }
        profile_repository.save(
            LOCAL_TENANT,
            Profile.from_dict(LOCAL_TENANT, changed_profile),
        )
        allow_persist.set()
        result = future.result(timeout=10)

    assert result == "tailoring-relevant profile data changed before artifact persistence"
    assert conn.execute(
        "SELECT COUNT(*) FROM job_materials WHERE tenant_id = ? AND job_id = ?",
        (str(LOCAL_TENANT), str(JOB_ID)),
    ).fetchone()[0] == 0


def test_compensation_only_profile_update_does_not_reject_tailoring_commit(
    conn: sqlite3.Connection,
) -> None:
    """An application-only edit must not invalidate generated Materials."""

    profile_data = {
        "personal": {"full_name": "Jordan Candidate", "email": "j@example.com"},
        "compensation": {"salary_expectation": "100000"},
        "experience": {"years_of_experience_total": 8},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Built APIs."],
                }
            ],
            "education_entries": [],
            "skill_categories": [
                {"id": "skills", "label": "Skills", "items": ["Python"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["role_1"],
                "required_skill_category_ids": ["skills"],
            },
        },
        "resume_constraints": {"real_metrics": []},
    }
    profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    profiles.save(
        LOCAL_TENANT,
        Profile.from_dict(LOCAL_TENANT, profile_data),
    )
    generation_snapshot = profiles.load_snapshot(LOCAL_TENANT)
    uow = SqliteUnitOfWork(conn)
    policies = SqliteTailoringPolicyRepository(conn, unit_of_work=uow)
    policy = policies.resolve_current(
        TailoringPolicy.from_runtime(
            tenant_id=LOCAL_TENANT,
            version=1,
            prompt_version="tailor.v2.quality-gated",
            schema_version="tailored-resume.v1",
            judge_schema_version="tailor-judge.v1",
            prompt_text="stable global control prompt",
            profile_policy={},
            custom_prompt="",
            generator_settings={"candidate_models": ["local:draft"]},
            judge_settings={"judge_model": "local:judge"},
            runtime_settings={
                "validation_mode": "normal",
                "profile_snapshot_fingerprint": fingerprint_profile_snapshot(
                    generation_snapshot
                ),
            },
            created_at="2026-08-06T00:00:00+00:00",
        )
    )

    compensation_update = deepcopy(profile_data)
    compensation_update["compensation"] = {"salary_expectation": "125000"}
    profiles.save(
        LOCAL_TENANT,
        Profile.from_dict(LOCAL_TENANT, compensation_update),
    )
    updated_snapshot = profiles.load_snapshot(LOCAL_TENANT)
    assert updated_snapshot.version == generation_snapshot.version + 1
    assert fingerprint_profile_snapshot(updated_snapshot) == fingerprint_profile_snapshot(
        generation_snapshot
    )

    with uow:
        policies.assert_generation_current(policy, generation_snapshot)
        assert conn.in_transaction is True
        SqliteMaterialsRepository(conn, unit_of_work=uow).save(_gen1_approved())

    committed = SqliteMaterialsRepository(conn).load_current_approved(
        LOCAL_TENANT,
        JOB_ID,
    )
    assert committed is not None
    assert committed.generation == 1


def test_profile_comparison_holds_write_lock_through_artifact_commit(
    conn: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    """A profile writer cannot enter after the fence and before artifact save."""

    profile_data = {
        "personal": {"full_name": "Jordan Candidate", "email": "j@example.com"},
        "resume": {
            "executive_profile": {"baseline_text": "Backend engineer."},
            "experience_entries": [
                {
                    "id": "role_1",
                    "title": "Engineer",
                    "company": "Acme",
                    "date_range": "2022 -- Present",
                    "location": "Remote",
                    "bullets": ["Built APIs."],
                }
            ],
            "education_entries": [],
            "skill_categories": [
                {"id": "skills", "label": "Skills", "items": ["Python"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["role_1"],
                "required_skill_category_ids": ["skills"],
                "writing_style": {"tone": "direct"},
            },
        },
        "resume_constraints": {"real_metrics": []},
    }
    profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile_data))
    generation_snapshot = profiles.load_snapshot(LOCAL_TENANT)
    uow = SqliteUnitOfWork(conn)
    policies = SqliteTailoringPolicyRepository(conn, unit_of_work=uow)
    policy = policies.resolve_current(
        TailoringPolicy.from_runtime(
            tenant_id=LOCAL_TENANT,
            version=1,
            prompt_version="tailor.v2.quality-gated",
            schema_version="tailored-resume.v1",
            judge_schema_version="tailor-judge.v1",
            prompt_text="stable global control prompt",
            profile_policy={},
            custom_prompt="",
            generator_settings={"candidate_models": ["local:draft"]},
            judge_settings={"judge_model": "local:judge"},
            runtime_settings={
                "validation_mode": "normal",
                "profile_snapshot_fingerprint": fingerprint_profile_snapshot(
                    generation_snapshot
                ),
            },
            created_at="2026-08-06T00:00:00+00:00",
        )
    )
    changed_profile = deepcopy(profile_data)
    changed_profile["resume"]["tailoring_rules"]["writing_style"] = {
        "tone": "technical"
    }

    competitor = sqlite3.connect(tmp_path / "jobctrl.db", timeout=0.2)
    competitor.row_factory = sqlite3.Row
    competitor_profiles = SqliteProfileRepository(
        competitor,
        publisher=InProcessEventBus(),
    )
    try:
        with uow:
            policies.assert_generation_current(policy, generation_snapshot)
            assert conn.in_transaction is True
            with pytest.raises(sqlite3.OperationalError, match="lock"):
                competitor_profiles.save(
                    LOCAL_TENANT,
                    Profile.from_dict(LOCAL_TENANT, changed_profile),
                )
            assert conn.in_transaction is True
            SqliteMaterialsRepository(conn, unit_of_work=uow).save(_gen1_approved())

        competitor_profiles.save(
            LOCAL_TENANT,
            Profile.from_dict(LOCAL_TENANT, changed_profile),
        )
    finally:
        competitor.close()

    committed = SqliteMaterialsRepository(conn).load_current_approved(
        LOCAL_TENANT,
        JOB_ID,
    )
    assert committed is not None
    assert committed.generation == 1
    assert profiles.load_snapshot(LOCAL_TENANT).version == (
        generation_snapshot.version + 1
    )


# ---------------------------------------------------------------------------
# Control: without the unit of work the flip is NOT atomic (pre-A9 behaviour)
# ---------------------------------------------------------------------------


def test_without_unit_of_work_new_generation_failure_loses_current_resume(
    conn: sqlite3.Connection,
) -> None:
    """Documents the bug the unit of work fixes: with per-call commits, a crash
    between the supersede and the new-generation save commits the supersede on its
    own, leaving the job with NO current approved resume."""
    materials = SqliteMaterialsRepository(conn)  # no unit of work -> eager commits
    materials.save(_gen1_approved())

    superseded, gen2 = _next_generation_approved(materials)
    failing = _FailAfterNSaves(materials, fail_on=2)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        failing.save(superseded)  # commits immediately
        failing.save(gen2)  # never runs

    assert materials.load_current_approved(LOCAL_TENANT, JOB_ID) is None


def test_without_unit_of_work_provenance_failure_orphans_approved_generation(
    conn: sqlite3.Connection,
) -> None:
    """Documents the audit-invariant bug: with per-call commits, generation 2's
    artifact commits before the provenance write fails, leaving an approved
    generation with no provenance."""
    materials = SqliteMaterialsRepository(conn)
    provenance = SqliteBulletProvenanceRepository(conn)

    materials.save(_gen1_approved())
    superseded, gen2 = _next_generation_approved(materials)
    failing_provenance = _FailAfterNSaves(provenance, fail_on=1)

    with pytest.raises(RuntimeError, match="simulated crash mid-flip"):
        materials.save(superseded)  # commits
        materials.save(gen2)  # commits
        failing_provenance.save(_provenance_set(2, artifact_id="art-gen2", text="orphan"))

    current = materials.load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current is not None and current.generation == 2
    assert provenance.load(LOCAL_TENANT, JOB_ID, generation=2) is None
