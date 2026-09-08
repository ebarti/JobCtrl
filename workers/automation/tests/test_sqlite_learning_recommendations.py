from __future__ import annotations

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading

import pytest

from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.materials.policy import TailoringPolicy
from jobctrl.domain.operations.feedback import TailoringFeedbackSignal
from jobctrl.domain.operations.learning import (
    LearningSourceChange,
    RecommendationEvidenceRef,
    TailoringContradictionEvidence,
    TailoringRecommendationScope,
    TailoringRuleEffect,
    derive_tailoring_recommendations,
)
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.learning.sqlite_repository import (
    LearningRecommendationConflict,
    SqliteLearningRecommendationRepository,
)
from jobctrl.infrastructure.materials import (
    LearningRecommendationReviewError,
    SqliteLearningRecommendationReviewRepository,
    SqliteTailoringPolicyRepository,
)


_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")
_JOB_A = canonical_job_id("10000000-0000-4000-8000-000000000001")
_JOB_B = canonical_job_id("10000000-0000-4000-8000-000000000002")
_JOB_C = canonical_job_id("10000000-0000-4000-8000-000000000003")


def test_append_pending_is_atomic_structured_and_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    recommendation = _recommendation(_TENANT_A)
    repository = SqliteLearningRecommendationRepository(conn)

    assert repository.append_pending(
        recommendation,
        derived_at="2026-08-01T10:01:00Z",
    )
    assert not repository.append_pending(
        recommendation,
        derived_at="2026-08-01T10:02:00Z",
    )

    row = conn.execute(
        """
        SELECT tenant_id, recommendation_id, context, policy_kind, signal_kind,
               rule_key, rule_value, status, observed_signal_count,
               observed_job_count, input_fingerprint, derived_at
        FROM learning_recommendations
        """
    ).fetchone()
    assert tuple(row) == (
        "tenant-a",
        recommendation.recommendation_id,
        "materials",
        "tailoring_rule",
        "factual_correction",
        "fact_handling",
        "require_source_match",
        "pending",
        3,
        2,
        recommendation.recommendation_id.removeprefix("learning-recommendation:"),
        "2026-08-01T10:01:00Z",
    )
    assert [
        tuple(item)
        for item in conn.execute(
            """
            SELECT signal_id, evidence_role, source_kind, source_id,
                   source_revision, recorded_at
            FROM learning_recommendation_evidence
            ORDER BY signal_id
            """
        ).fetchall()
    ] == [
        (
            f"signal-{index}",
            "supporting",
            "tailoring_feedback_signal",
            f"source-{index}",
            index,
            f"2026-08-01T10:00:0{index}Z",
        )
        for index in range(1, 4)
    ]
    assert [
        str(item[0])
        for item in conn.execute(
            "SELECT job_id FROM learning_recommendation_jobs ORDER BY job_id"
        ).fetchall()
    ] == [_JOB_A, _JOB_B]
    assert [
        tuple(item)
        for item in conn.execute(
            """
            SELECT signal_id, job_id
            FROM learning_recommendation_evidence_jobs
            ORDER BY signal_id, job_id
            """
        ).fetchall()
    ] == [
        ("signal-1", _JOB_A),
        ("signal-2", _JOB_A),
        ("signal-3", _JOB_B),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_resolved_contradiction_requires_truthful_provenance(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    contradiction_id = "contradiction-1"
    recommendation = derive_tailoring_recommendations(
        _signals(_TENANT_A),
        contradictions={
            _scope(_TENANT_A): TailoringContradictionEvidence(
                signal_ids=(contradiction_id,),
                unresolved_signal_ids=(),
            )
        },
    )[0]
    repository = SqliteLearningRecommendationRepository(conn)

    with pytest.raises(ValueError, match="must match"):
        repository.append_pending(
            recommendation,
            derived_at="2026-08-01T10:01:00Z",
        )
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 0

    contradiction = RecommendationEvidenceRef(
        tenant_id=_TENANT_A,
        signal_id=contradiction_id,
        source_kind="tailoring_feedback_signal",
        source_id="source-contradiction-1",
        source_revision=4,
        job_ids=(_JOB_B,),
        recorded_at="2026-08-01T10:00:04Z",
    )
    assert repository.append_pending(
        recommendation,
        contradicting_evidence=(contradiction,),
        derived_at="2026-08-01T10:01:00Z",
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT signal_id, evidence_role, source_id, source_revision
            FROM learning_recommendation_evidence
            ORDER BY evidence_role, signal_id
            """
        ).fetchall()
    ] == [
        ("contradiction-1", "contradicting", "source-contradiction-1", 4),
        ("signal-1", "supporting", "source-1", 1),
        ("signal-2", "supporting", "source-2", 2),
        ("signal-3", "supporting", "source-3", 3),
    ]
    assert conn.execute(
        """
        SELECT job_id
        FROM learning_recommendation_evidence_jobs
        WHERE signal_id = 'contradiction-1'
        """
    ).fetchone()[0] == _JOB_B

    with pytest.raises(LearningRecommendationConflict, match="conflicts"):
        repository.append_pending(
            recommendation,
            contradicting_evidence=(replace(contradiction, job_ids=(_JOB_C,)),),
            derived_at="2026-08-01T10:02:00Z",
        )
    with pytest.raises(ValueError, match="belong to its tenant"):
        repository.append_pending(
            recommendation,
            contradicting_evidence=(
                replace(contradiction, tenant_id=_TENANT_B),
            ),
            derived_at="2026-08-01T10:02:00Z",
        )
    close_connection(db_path)


def test_pending_append_respects_outer_rollback_and_tenant_isolation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteLearningRecommendationRepository(conn)

    conn.execute("BEGIN")
    assert repository.append_pending(
        _recommendation(_TENANT_A),
        derived_at="2026-08-01T10:01:00Z",
    )
    conn.rollback()
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 0

    assert repository.append_pending(
        _recommendation(_TENANT_A),
        derived_at="2026-08-01T10:01:00Z",
    )
    assert repository.append_pending(
        _recommendation(_TENANT_B),
        derived_at="2026-08-01T10:01:00Z",
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, COUNT(*)
            FROM learning_recommendations
            GROUP BY tenant_id
            ORDER BY tenant_id
            """
        ).fetchall()
    ] == [("tenant-a", 1), ("tenant-b", 1)]
    close_connection(db_path)


@pytest.mark.parametrize(
    ("derived_at", "source_id", "match"),
    [
        ("private prompt and mail body", "source-safe", "derived_at"),
        (
            "2026-08-01T10:01:00Z",
            "private resume text /Users/private/resume.pdf",
            "source_id",
        ),
    ],
)
def test_unstructured_private_values_are_rejected_before_writes(
    tmp_path: Path,
    derived_at: str,
    source_id: str,
    match: str,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    recommendation = derive_tailoring_recommendations(
        _signals(_TENANT_A),
        contradictions={
            _scope(_TENANT_A): TailoringContradictionEvidence(
                signal_ids=("contradiction-1",),
                unresolved_signal_ids=(),
            )
        },
    )[0]
    contradiction = RecommendationEvidenceRef(
        tenant_id=_TENANT_A,
        signal_id="contradiction-1",
        source_kind="tailoring_feedback_signal",
        source_id=source_id,
        source_revision=4,
        job_ids=(_JOB_B,),
        recorded_at="2026-08-01T10:00:04Z",
    )

    with pytest.raises(ValueError, match=match):
        SqliteLearningRecommendationRepository(conn).append_pending(
            recommendation,
            contradicting_evidence=(contradiction,),
            derived_at=derived_at,
        )
    for table in (
        "learning_recommendations",
        "learning_recommendation_evidence",
        "learning_recommendation_jobs",
    ):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    close_connection(db_path)


def test_reused_deterministic_identity_cannot_change_persisted_facts(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteLearningRecommendationRepository(conn)
    original = _recommendation(_TENANT_A)
    repository.append_pending(original, derived_at="2026-08-01T10:01:00Z")

    different_effect = TailoringRuleEffect(
        signal_kind="style_preference",
        rule_key="style_guidance",
        rule_value="preserve_user_edit_pattern",
        allowlist_version=1,
    )
    conflicting = replace(
        original,
        recommendation_id=original.recommendation_id,
        scope=TailoringRecommendationScope(
            tenant_id=_TENANT_A,
            proposed_effect=different_effect,
        ),
        proposed_effect=different_effect,
    )

    with pytest.raises(LearningRecommendationConflict, match="conflicts"):
        repository.append_pending(
            conflicting,
            derived_at="2026-08-01T10:02:00Z",
        )
    assert conn.execute(
        "SELECT rule_key FROM learning_recommendations"
    ).fetchone()[0] == "fact_handling"
    close_connection(db_path)


def test_source_correction_tombstones_and_rederives_with_replacement(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)

    original = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(),
        rederived_at="2026-08-01T11:00:00Z",
    )[0]
    _insert_tailoring_review(
        conn,
        signal_id="tailoring-1",
        revision=2,
        decision="accepted",
        reviewed_at="2026-08-01T11:30:00Z",
    )
    conn.commit()
    change = LearningSourceChange(
        tenant_id=_TENANT_A,
        previous_signal_id="tailoring-feedback:tailoring-1:1",
        source_id="tailoring-1",
        source_revision=1,
        reason_code="source_corrected",
        changed_at="2026-08-01T11:30:00Z",
    )

    rederived = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(change,),
        rederived_at="2026-08-01T11:31:00Z",
    )

    assert len(rederived) == 1
    replacement = rederived[0]
    assert replacement.recommendation_id != original.recommendation_id
    assert any(
        evidence.source_id == "tailoring-1" and evidence.source_revision == 2
        for evidence in replacement.evidence
    )
    assert tuple(
        conn.execute(
            """
            SELECT recommendation_id, affected_signal_id,
                   affected_source_revision, reason_code,
                   replacement_recommendation_id, tombstoned_at, rederived_at
            FROM learning_recommendation_tombstones
            """
        ).fetchone()
    ) == (
        original.recommendation_id,
        "tailoring-feedback:tailoring-1:1",
        1,
        "source_corrected",
        replacement.recommendation_id,
        "2026-08-01T11:30:00Z",
        "2026-08-01T11:31:00Z",
    )
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 2
    learning_dump = "\n".join(
        repr(tuple(row))
        for table in (
            "learning_recommendations",
            "learning_recommendation_evidence",
            "learning_recommendation_evidence_jobs",
            "learning_recommendation_jobs",
            "learning_recommendation_tombstones",
        )
        for row in conn.execute(f"SELECT * FROM {table}").fetchall()
    )
    for forbidden in (
        "private edit",
        "resume",
        "prompt",
        "job description",
        "private-delta",
    ):
        assert forbidden not in learning_dump

    replayed = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(change,),
        rederived_at="2026-08-01T11:32:00Z",
    )
    assert replayed == rederived
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_tombstones"
    ).fetchone()[0] == 1
    close_connection(db_path)


def test_source_deletion_tombstones_without_inventing_a_replacement(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)
    original = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(),
        rederived_at="2026-08-01T11:00:00Z",
    )[0]
    _insert_tailoring_review(
        conn,
        signal_id="tailoring-1",
        revision=2,
        decision="rejected",
        reviewed_at="2026-08-01T11:30:00Z",
    )
    conn.commit()

    assert repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(
            LearningSourceChange(
                tenant_id=_TENANT_A,
                previous_signal_id="tailoring-feedback:tailoring-1:1",
                source_id="tailoring-1",
                source_revision=1,
                reason_code="source_deleted",
                changed_at="2026-08-01T11:30:00Z",
            ),
        ),
        rederived_at="2026-08-01T11:31:00Z",
    ) == ()
    assert tuple(
        conn.execute(
            """
            SELECT recommendation_id, reason_code,
                   replacement_recommendation_id
            FROM learning_recommendation_tombstones
            """
        ).fetchone()
    ) == (original.recommendation_id, "source_deleted", None)
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 1
    close_connection(db_path)


def test_review_ledger_automatically_rederives_corrections_and_rejections(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)

    original = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=None,
        rederived_at="2026-08-01T11:00:00Z",
    )[0]
    _insert_tailoring_review(
        conn,
        signal_id="tailoring-1",
        revision=2,
        decision="accepted",
        reviewed_at="2026-08-01T11:30:00Z",
    )
    conn.commit()

    replacement = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=None,
        rederived_at="2026-08-01T11:31:00Z",
    )[0]
    assert replacement.recommendation_id != original.recommendation_id
    assert tuple(
        conn.execute(
            """
            SELECT reason_code, affected_signal_id,
                   replacement_recommendation_id, tombstoned_at
            FROM learning_recommendation_tombstones
            WHERE recommendation_id = ?
            """,
            (original.recommendation_id,),
        ).fetchone()
    ) == (
        "source_corrected",
        "tailoring-feedback:tailoring-1:1",
        replacement.recommendation_id,
        "2026-08-01T11:30:00Z",
    )

    _insert_tailoring_review(
        conn,
        signal_id="tailoring-2",
        revision=2,
        decision="rejected",
        reviewed_at="2026-08-01T12:00:00Z",
    )
    conn.commit()
    assert (
        repository.rederive_tailoring(
            _TENANT_A,
            source_changes=None,
            rederived_at="2026-08-01T12:01:00Z",
        )
        == ()
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT recommendation_id, reason_code, tombstoned_at
            FROM learning_recommendation_tombstones
            WHERE affected_signal_id = 'tailoring-feedback:tailoring-2:1'
            ORDER BY recommendation_id
            """
        ).fetchall()
    ] == [
        (original.recommendation_id, "source_deleted", "2026-08-01T12:00:00Z"),
        (replacement.recommendation_id, "source_deleted", "2026-08-01T12:00:00Z"),
    ]
    close_connection(db_path)


def test_explicit_contradiction_ledger_blocks_until_one_side_is_resolved(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.execute(
        """
        INSERT INTO resume_review_drafts (
            tenant_id, draft_id, job_id, base_generation, renderer_format,
            state, latest_revision_number, created_at, updated_at
        ) VALUES (
            'tenant-a', 'draft-4', ?, 1, 'text', 'active', 0, ?, ?
        )
        """,
        (_JOB_B, "2026-08-01T10:00:00Z", "2026-08-01T10:00:00Z"),
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signals (
            tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
            signal_kind, status, summary, created_at, reviewed_at
        ) VALUES (
            'tenant-a', 'tailoring-4', ?, 'draft-4', 'edit_delta',
            'private-delta-4', 'factual_correction', 'accepted',
            'private contradiction rationale', ?, ?
        )
        """,
        (_JOB_B, "2026-08-01T10:00:00Z", "2026-08-01T10:00:04Z"),
    )
    _insert_tailoring_review(
        conn,
        signal_id="tailoring-4",
        revision=1,
        decision="accepted",
        reviewed_at="2026-08-01T10:00:04Z",
    )
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_contradictions (
            tenant_id, contradiction_id, signal_id, signal_revision,
            signal_job_id, contradicting_signal_id,
            contradicting_signal_revision, contradicting_signal_job_id,
            recorded_at
        ) VALUES (
            'tenant-a', 'contradiction-1-4', 'tailoring-1', 1, ?,
            'tailoring-4', 1, ?, '2026-08-01T10:05:00Z'
        )
        """,
        (_JOB_A, _JOB_B),
    )
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)

    assert (
        repository.rederive_tailoring(
            _TENANT_A,
            source_changes=None,
            rederived_at="2026-08-01T11:00:00Z",
        )
        == ()
    )
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 0

    _insert_tailoring_review(
        conn,
        signal_id="tailoring-4",
        revision=2,
        decision="rejected",
        reviewed_at="2026-08-01T11:30:00Z",
    )
    conn.commit()
    recommendation = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=None,
        rederived_at="2026-08-01T11:31:00Z",
    )[0]
    assert recommendation.contradicting_signal_ids == (
        "tailoring-feedback:tailoring-4:1",
    )
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT signal_id, evidence_role, source_id, source_revision
            FROM learning_recommendation_evidence
            WHERE recommendation_id = ?
            ORDER BY evidence_role, signal_id
            """,
            (recommendation.recommendation_id,),
        ).fetchall()
    ][0] == (
        "tailoring-feedback:tailoring-4:1",
        "contradicting",
        "tailoring-4",
        1,
    )
    learning_dump = "\n".join(
        repr(tuple(row))
        for row in conn.execute(
            "SELECT * FROM learning_recommendation_evidence"
        ).fetchall()
    )
    assert "private contradiction rationale" not in learning_dump
    assert "private-delta-4" not in learning_dump
    replayed = repository.rederive_tailoring(
        _TENANT_A,
        source_changes=None,
        rederived_at="2026-08-01T11:32:00Z",
    )
    assert replayed == (recommendation,)
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_tombstones"
    ).fetchone()[0] == 0
    close_connection(db_path)


def test_source_change_validation_rolls_back_before_audit_mutation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)
    repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(),
        rederived_at="2026-08-01T11:00:00Z",
    )

    with pytest.raises(ValueError, match="no current accepted revision"):
        repository.rederive_tailoring(
            _TENANT_A,
            source_changes=(
                LearningSourceChange(
                    tenant_id=_TENANT_A,
                    previous_signal_id="tailoring-feedback:tailoring-1:1",
                    source_id="tailoring-1",
                    source_revision=1,
                    reason_code="source_deleted",
                    changed_at="2026-08-01T11:30:00Z",
                ),
            ),
            rederived_at="2026-08-01T11:31:00Z",
        )
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_tombstones"
    ).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM learning_recommendations").fetchone()[0] == 1
    close_connection(db_path)


def test_multiple_source_changes_each_append_a_tombstone(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _seed_tailoring_sources(conn)
    conn.commit()
    repository = SqliteLearningRecommendationRepository(conn)
    repository.rederive_tailoring(
        _TENANT_A,
        source_changes=(),
        rederived_at="2026-08-01T11:00:00Z",
    )
    for signal_id in ("tailoring-1", "tailoring-2"):
        _insert_tailoring_review(
            conn,
            signal_id=signal_id,
            revision=2,
            decision="rejected",
            reviewed_at="2026-08-01T11:30:00Z",
        )
    conn.commit()

    changes = tuple(
        LearningSourceChange(
            tenant_id=_TENANT_A,
            previous_signal_id=f"tailoring-feedback:{signal_id}:1",
            source_id=signal_id,
            source_revision=1,
            reason_code="source_deleted",
            changed_at="2026-08-01T11:30:00Z",
        )
        for signal_id in ("tailoring-1", "tailoring-2")
    )
    assert repository.rederive_tailoring(
        _TENANT_A,
        source_changes=changes,
        rederived_at="2026-08-01T11:31:00Z",
    ) == ()
    assert [
        str(row[0])
        for row in conn.execute(
            """
            SELECT affected_signal_id
            FROM learning_recommendation_tombstones
            ORDER BY affected_signal_id
            """
        ).fetchall()
    ] == [
        "tailoring-feedback:tailoring-1:1",
        "tailoring-feedback:tailoring-2:1",
    ]
    close_connection(db_path)


def test_review_rejection_is_terminal_and_replays_same_decision(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    recommendation = _recommendation(_TENANT_A)
    SqliteLearningRecommendationRepository(conn).append_pending(
        recommendation,
        derived_at="2026-08-01T10:01:00Z",
    )
    policy_repository = SqliteTailoringPolicyRepository(conn)
    original_policy = _tailoring_policy(_TENANT_A)
    policy_repository.save(original_policy)
    reviewer = SqliteLearningRecommendationReviewRepository(conn)

    rejected = reviewer.review(
        _TENANT_A,
        recommendation_id=recommendation.recommendation_id,
        decision="rejected",
        reviewed_at="2026-08-01T11:00:00Z",
    )
    rejected_replay = reviewer.review(
        _TENANT_A,
        recommendation_id=recommendation.recommendation_id,
        decision="rejected",
        reviewed_at="2026-08-01T11:01:00Z",
    )

    assert rejected == rejected_replay
    assert rejected.revision == 1
    assert rejected.policy_version is None
    assert policy_repository.get_current(_TENANT_A) == original_policy

    with pytest.raises(
        LearningRecommendationReviewError,
        match="terminal",
    ):
        reviewer.review(
            _TENANT_A,
            recommendation_id=recommendation.recommendation_id,
            decision="accepted",
            reviewed_at="2026-08-01T11:02:00Z",
        )
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_reviews"
    ).fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0] == 1
    close_connection(db_path)


def test_review_fails_closed_without_current_policy_or_for_tombstone(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    recommendation = _recommendation(_TENANT_A)
    SqliteLearningRecommendationRepository(conn).append_pending(
        recommendation,
        derived_at="2026-08-01T10:01:00Z",
    )
    reviewer = SqliteLearningRecommendationReviewRepository(conn)

    with pytest.raises(
        LearningRecommendationReviewError,
        match="initialized tailoring policy",
    ):
        reviewer.review(
            _TENANT_A,
            recommendation_id=recommendation.recommendation_id,
            decision="accepted",
            reviewed_at="2026-08-01T11:00:00Z",
        )
    with pytest.raises(
        LearningRecommendationReviewError,
        match="does not exist for tenant",
    ):
        reviewer.review(
            _TENANT_B,
            recommendation_id=recommendation.recommendation_id,
            decision="accepted",
            reviewed_at="2026-08-01T11:00:00Z",
        )
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_reviews"
    ).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0] == 0

    SqliteTailoringPolicyRepository(conn).save(_tailoring_policy(_TENANT_A))
    evidence = recommendation.evidence[0]
    conn.execute(
        """
        INSERT INTO learning_recommendation_tombstones (
            tenant_id, tombstone_id, recommendation_id, affected_signal_id,
            affected_source_revision, reason_code, derivation_version,
            tombstoned_at, rederived_at, replacement_recommendation_id
        ) VALUES (?, ?, ?, ?, ?, 'source_deleted', 1, ?, ?, NULL)
        """,
        (
            str(_TENANT_A),
            "tombstone-review-fixture",
            recommendation.recommendation_id,
            evidence.signal_id,
            evidence.source_revision,
            "2026-08-01T11:01:00Z",
            "2026-08-01T11:01:00Z",
        ),
    )
    conn.commit()

    with pytest.raises(LearningRecommendationReviewError, match="tombstoned"):
        reviewer.review(
            _TENANT_A,
            recommendation_id=recommendation.recommendation_id,
            decision="accepted",
            reviewed_at="2026-08-01T11:02:00Z",
        )
    assert conn.execute(
        "SELECT COUNT(*) FROM learning_recommendation_reviews"
    ).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0] == 1
    close_connection(db_path)


def test_concurrent_accepts_serialize_and_preserve_both_rules(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    setup_conn = init_db(db_path)
    recommendations = (
        _recommendation(_TENANT_A),
        _recommendation_for_effect(
            _TENANT_A,
            signal_kind="style_preference",
            rule_key="style_guidance",
            rule_value="preserve_user_edit_pattern",
        ),
    )
    recommendation_repository = SqliteLearningRecommendationRepository(setup_conn)
    for recommendation in recommendations:
        recommendation_repository.append_pending(
            recommendation,
            derived_at="2026-08-01T10:01:00Z",
        )
    SqliteTailoringPolicyRepository(setup_conn).save(_tailoring_policy(_TENANT_A))
    close_connection(db_path)
    start = threading.Event()

    def accept(recommendation_id: str):
        conn = get_connection(db_path)
        try:
            start.wait(timeout=5)
            return SqliteLearningRecommendationReviewRepository(conn).review(
                _TENANT_A,
                recommendation_id=recommendation_id,
                decision="accepted",
                reviewed_at="2026-08-01T11:00:00Z",
            )
        finally:
            close_connection(db_path)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(accept, recommendation.recommendation_id)
            for recommendation in recommendations
        ]
        start.set()
        reviews = [future.result(timeout=10) for future in futures]

    assert sorted(review.policy_version for review in reviews) == [2, 3]
    check_conn = get_connection(db_path)
    try:
        current = SqliteTailoringPolicyRepository(check_conn).get_current(_TENANT_A)
        assert current is not None
        assert current.learned_tailoring_rules.to_dict() == {
            "fact_handling": "require_source_match",
            "style_guidance": "preserve_user_edit_pattern",
        }
        assert check_conn.execute(
            "SELECT COUNT(*) FROM learning_recommendation_reviews"
        ).fetchone()[0] == 2
        assert check_conn.execute(
            "SELECT COUNT(*) FROM tailoring_policies"
        ).fetchone()[0] == 3
    finally:
        close_connection(db_path)


def _recommendation(tenant_id: TenantId):
    return derive_tailoring_recommendations(
        _signals(tenant_id),
        contradictions={},
    )[0]


def _recommendation_for_effect(
    tenant_id: TenantId,
    *,
    signal_kind: str,
    rule_key: str,
    rule_value: str,
):
    scope = TailoringRecommendationScope(
        tenant_id=tenant_id,
        proposed_effect=TailoringRuleEffect(
            signal_kind=signal_kind,
            rule_key=rule_key,
            rule_value=rule_value,
            allowlist_version=1,
        ),
    )
    signals = tuple(
        TailoringFeedbackSignal(
            signal_id=f"{signal_kind}-signal-{index}",
            tenant_id=tenant_id,
            job_id=job_id,
            source_id=f"{signal_kind}-source-{index}",
            source_revision=index,
            recorded_at=f"2026-08-01T10:00:0{index}Z",
            signal_kind=signal_kind,
            rule_key=rule_key,
            rule_value=rule_value,
            allowlist_version=1,
        )
        for index, job_id in enumerate((_JOB_A, _JOB_A, _JOB_B), start=1)
    )
    return derive_tailoring_recommendations(
        signals,
        contradictions={
            scope: TailoringContradictionEvidence(
                signal_ids=(),
                unresolved_signal_ids=(),
            )
        },
    )[0]


def _tailoring_policy(tenant_id: TenantId) -> TailoringPolicy:
    return TailoringPolicy(
        tenant_id=tenant_id,
        version=1,
        prompt_version="tailor.v2.quality-gated",
        schema_version="tailored-resume.v1",
        judge_schema_version="tailor-judge.v1",
        prompt_fingerprint="sha256:prompt",
        config_fingerprint="sha256:config",
        profile_policy_fingerprint="sha256:profile",
        custom_prompt_fingerprint="sha256:custom",
        generator_settings={"candidate_models": ["local:draft"]},
        judge_settings={"judge_model": "local:judge", "min_score": 0.82},
        runtime_settings={"validation_mode": "normal"},
        created_at="2026-08-01T10:00:00Z",
    )


def _signals(tenant_id: TenantId) -> tuple[TailoringFeedbackSignal, ...]:
    return (
        _signal("signal-1", _JOB_A, 1, tenant_id),
        _signal("signal-2", _JOB_A, 2, tenant_id),
        _signal("signal-3", _JOB_B, 3, tenant_id),
    )


def _scope(tenant_id: TenantId) -> TailoringRecommendationScope:
    return TailoringRecommendationScope(
        tenant_id=tenant_id,
        proposed_effect=TailoringRuleEffect(
            signal_kind="factual_correction",
            rule_key="fact_handling",
            rule_value="require_source_match",
            allowlist_version=1,
        ),
    )


def _signal(
    signal_id: str,
    job_id: JobId,
    revision: int,
    tenant_id: TenantId,
) -> TailoringFeedbackSignal:
    return TailoringFeedbackSignal(
        signal_id=signal_id,
        tenant_id=tenant_id,
        job_id=job_id,
        source_id=f"source-{revision}",
        source_revision=revision,
        recorded_at=f"2026-08-01T10:00:0{revision}Z",
        signal_kind="factual_correction",
        rule_key="fact_handling",
        rule_value="require_source_match",
        allowlist_version=1,
    )


def _seed_tailoring_sources(conn) -> None:
    for index, job_id in enumerate((_JOB_A, _JOB_B), start=1):
        conn.execute(
            "INSERT INTO jobs (tenant_id, job_id, url) VALUES (?, ?, ?)",
            ("tenant-a", job_id, f"https://jobs.example.test/{index}"),
        )
    for index, job_id in enumerate((_JOB_A, _JOB_A, _JOB_B), start=1):
        signal_id = f"tailoring-{index}"
        draft_id = f"draft-{index}"
        conn.execute(
            """
            INSERT INTO resume_review_drafts (
                tenant_id, draft_id, job_id, base_generation, renderer_format,
                state, latest_revision_number, created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'text', 'active', 0, ?, ?)
            """,
            (
                "tenant-a",
                draft_id,
                job_id,
                "2026-08-01T10:00:00Z",
                "2026-08-01T10:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO tailoring_feedback_signals (
                tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
                signal_kind, status, summary, created_at, reviewed_at
            ) VALUES (
                'tenant-a', ?, ?, ?, 'edit_delta', ?,
                'factual_correction', 'accepted', ?, ?, ?
            )
            """,
            (
                signal_id,
                job_id,
                draft_id,
                f"private-delta-{index}",
                "private edit, resume, prompt, and job description",
                "2026-08-01T10:00:00Z",
                "2026-08-01T10:00:00Z",
            ),
        )
        _insert_tailoring_review(
            conn,
            signal_id=signal_id,
            revision=1,
            decision="accepted",
            reviewed_at=f"2026-08-01T10:00:0{index}Z",
        )


def _insert_tailoring_review(
    conn,
    *,
    signal_id: str,
    revision: int,
    decision: str,
    reviewed_at: str,
) -> None:
    accepted = decision == "accepted"
    conn.execute(
        """
        INSERT INTO tailoring_feedback_signal_reviews (
            tenant_id, review_id, signal_id, revision, decision, signal_kind,
            rule_key, rule_value, allowlist_version, reviewed_at
        ) VALUES (
            'tenant-a', ?, ?, ?, ?, 'factual_correction', ?, ?, 1, ?
        )
        """,
        (
            f"review-{signal_id}-{revision}",
            signal_id,
            revision,
            decision,
            "fact_handling" if accepted else None,
            "require_source_match" if accepted else None,
            reviewed_at,
        ),
    )
