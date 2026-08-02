from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.operations.feedback import TailoringFeedbackSignal
from jobctrl.domain.operations.learning import (
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


def _recommendation(tenant_id: TenantId):
    return derive_tailoring_recommendations(
        _signals(tenant_id),
        contradictions={},
    )[0]


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
