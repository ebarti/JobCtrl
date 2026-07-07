"""ScoringPolicy domain and SQLite persistence tests."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.scoring import (
    CorrectionSignal,
    FitBandThreshold,
    FitScore,
    ScoreBreakdown,
    ScoringPolicy,
)
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.scoring import SqliteScoringPolicyRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def test_default_policy_resolves_score_from_weighted_dimensions() -> None:
    policy = ScoringPolicy.default(LOCAL_TENANT)
    breakdown = ScoreBreakdown(
        technical_fit=8,
        experience_fit=6,
        role_fit=4,
        confidence="low",
        reasoning="Dimension evidence is deterministic.",
    )

    resolved = policy.resolve(breakdown)

    assert resolved.fit_score.value == 6
    assert resolved.fit_band == "plausible"
    assert resolved.policy_id == "local:scoring-policy-v1"
    assert resolved.raw_weighted_score == pytest.approx(6.4)
    assert resolved.calibration_adjustment == 0.0
    assert resolved.anchor_ids == ()
    assert resolved.dimension_values() == {
        "technical_fit": 8,
        "experience_fit": 6,
        "role_fit": 4,
    }
    assert resolved.fit_band_thresholds[0].to_dict() == {
        "band": "excellent",
        "minimum_score": 9,
    }
    assert resolved.resolution_reason == "weighted_dimensions+low_confidence_traced"
    assert resolved.evidence_summary == {
        "confidence": "low",
        "eligibility_status": "unknown",
        "hard_blocker_count": 0,
        "warning_count": 0,
        "matched_signal_count": 0,
        "missing_signal_count": 0,
        "transferable_signal_count": 0,
    }


def test_policy_correction_signal_creates_next_version_anchor() -> None:
    policy = ScoringPolicy.default(LOCAL_TENANT, created_at="2024-01-01T00:00:00+00:00")
    signal = CorrectionSignal(
        tenant_id=LOCAL_TENANT,
        job_id="https://example.com/job/anchor",
        original_score=FitScore.create(5),
        corrected_score=FitScore.create(8),
        rationale="Manual review found stronger platform evidence.",
        corrected_at="2024-01-02T00:00:00+00:00",
        source_policy_id=policy.policy_id,
        source_policy_version=policy.version,
        score_dimensions=(
            {"name": "technical_fit", "value": 5, "weight": 0.45},
            {"name": "experience_fit", "value": 5, "weight": 0.3},
            {"name": "role_fit", "value": 5, "weight": 0.25},
        ),
        evidence_summary={"confidence": "medium", "missing_signal_count": 1},
    )

    updated = policy.with_correction_signal(signal)
    serialized_signal = signal.to_dict()
    serialized_signal_json = json.dumps(serialized_signal)
    resolved = updated.resolve(
        ScoreBreakdown(
            technical_fit=7,
            experience_fit=7,
            role_fit=7,
            reasoning="Later score.",
        )
    )

    assert updated.version == 2
    assert serialized_signal["job_ref_hash"].startswith("sha256:")
    assert serialized_signal["correction_delta"] == 3
    assert serialized_signal["correction_direction"] == "increased"
    assert "https://example.com/job/anchor" not in serialized_signal_json
    assert "Manual review found stronger platform evidence." not in serialized_signal_json
    assert "job_id" not in serialized_signal
    assert "rationale" not in serialized_signal
    assert updated.dimensions == policy.dimensions
    assert updated.fit_band_thresholds == policy.fit_band_thresholds
    assert len(updated.anchors) == 1
    anchor = updated.anchors[0]
    assert anchor.anchor_id == signal.anchor_id
    assert anchor.original_fit_score == FitScore.create(5)
    assert anchor.corrected_fit_score == FitScore.create(8)
    assert anchor.job_id == ""
    assert anchor.rationale == ""
    assert anchor.job_ref_hash.startswith("sha256:")
    assert anchor.correction_delta == 3
    assert anchor.correction_direction == "increased"
    assert anchor.source_policy_version == 1
    assert anchor.dimension_scores[0]["name"] == "technical_fit"
    serialized_anchor = updated.to_anchors_list()[0]
    serialized_anchor_json = json.dumps(serialized_anchor)
    assert "https://example.com/job/anchor" not in serialized_anchor_json
    assert "Manual review found stronger platform evidence." not in serialized_anchor_json
    assert "job_id" not in serialized_anchor
    assert "rationale" not in serialized_anchor
    assert resolved.fit_score.value == 7
    assert resolved.anchor_ids == (anchor.anchor_id,)


def test_policy_owned_fit_band_thresholds_are_deterministic() -> None:
    policy = ScoringPolicy(
        tenant_id=LOCAL_TENANT,
        fit_band_thresholds=(
            FitBandThreshold("poor", 1),
            FitBandThreshold("excellent", 10),
            FitBandThreshold("strong", 8),
            FitBandThreshold("plausible", 6),
            FitBandThreshold("stretch", 3),
        ),
    )

    assert policy.fit_band_for_score(10) == "excellent"
    assert policy.fit_band_for_score(8) == "strong"
    assert policy.fit_band_for_score(6) == "plausible"
    assert policy.fit_band_for_score(3) == "stretch"
    assert policy.fit_band_for_score(1) == "poor"


def test_policy_rejects_inverted_fit_band_threshold_order() -> None:
    with pytest.raises(ValueError, match="fit band thresholds must follow"):
        ScoringPolicy(
            tenant_id=LOCAL_TENANT,
            fit_band_thresholds=(
                FitBandThreshold("excellent", 7),
                FitBandThreshold("strong", 9),
                FitBandThreshold("plausible", 5),
                FitBandThreshold("stretch", 3),
                FitBandThreshold("poor", 1),
            ),
        )


def test_sqlite_policy_repository_seeds_default_policy(conn: sqlite3.Connection) -> None:
    repo = SqliteScoringPolicyRepository(conn)

    policy = repo.get_current(LOCAL_TENANT)

    assert policy.version == 1
    assert policy.rubric_version == "default-scoring-rubric-v1"
    assert policy.created_at
    row = conn.execute(
        """
        SELECT tenant_id, version, rubric_json, anchors_json, created_at,
               created_from_event_id
        FROM scoring_policies
        WHERE tenant_id = ?
        """,
        (str(LOCAL_TENANT),),
    ).fetchone()
    assert row is not None
    assert row["tenant_id"] == str(LOCAL_TENANT)
    assert row["version"] == 1
    assert json.loads(row["rubric_json"])["rubric_version"] == "default-scoring-rubric-v1"
    assert json.loads(row["rubric_json"])["fit_band_thresholds"] == [
        {"band": "excellent", "minimum_score": 9},
        {"band": "strong", "minimum_score": 7},
        {"band": "plausible", "minimum_score": 5},
        {"band": "stretch", "minimum_score": 3},
        {"band": "poor", "minimum_score": 1},
    ]
    assert json.loads(row["anchors_json"]) == []
    assert row["created_at"]
    assert row["created_from_event_id"] is None


def test_sqlite_policy_repository_returns_highest_policy_version(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteScoringPolicyRepository(conn)
    repo.save(ScoringPolicy.default(LOCAL_TENANT, created_at="2024-01-01T00:00:00+00:00"))
    repo.save(
        ScoringPolicy(
            tenant_id=LOCAL_TENANT,
            version=2,
            rubric_version="rubric-v2",
            created_at="2024-01-02T00:00:00+00:00",
            created_from_event_id=42,
        )
    )

    policy = repo.get_current(LOCAL_TENANT)

    assert policy.version == 2
    assert policy.rubric_version == "rubric-v2"
    assert policy.created_from_event_id == 42
    assert policy.fit_band_thresholds[-1].band == "poor"


def test_sqlite_policy_repository_persists_correction_signal_anchor(
    conn: sqlite3.Connection,
) -> None:
    repo = SqliteScoringPolicyRepository(conn)
    current = repo.get_current(LOCAL_TENANT)
    signal = CorrectionSignal(
        tenant_id=LOCAL_TENANT,
        job_id="https://example.com/job/sqlite-anchor",
        original_score=FitScore.create(4),
        corrected_score=FitScore.create(7),
        rationale="Correction should become calibration evidence.",
        corrected_at="2024-01-03T00:00:00+00:00",
        source_policy_id=current.policy_id,
        source_policy_version=current.version,
        score_dimensions=({"name": "technical_fit", "value": 4},),
        evidence_summary={"confidence": "low"},
    )

    saved = repo.save_correction_signal(signal)
    loaded = repo.get_current(LOCAL_TENANT)
    anchors_json = conn.execute(
        """
        SELECT anchors_json
        FROM scoring_policies
        WHERE tenant_id = ? AND version = 2
        """,
        (str(LOCAL_TENANT),),
    ).fetchone()["anchors_json"]

    assert saved.version == 2
    assert loaded.version == 2
    assert loaded.anchors[0].anchor_id == signal.anchor_id
    assert loaded.anchors[0].corrected_fit_score == FitScore.create(7)
    assert loaded.anchors[0].job_ref_hash.startswith("sha256:")
    assert "https://example.com/job/sqlite-anchor" not in anchors_json
    assert "Correction should become calibration evidence." not in anchors_json
    assert loaded.resolve(ScoreBreakdown(reasoning="next")).anchor_ids == (
        signal.anchor_id,
    )


def test_sqlite_policy_repository_loads_pr2_anchor_rows(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        INSERT INTO scoring_policies (
            tenant_id, version, rubric_json, anchors_json, created_at,
            created_from_event_id
        ) VALUES (?, 7, ?, ?, ?, NULL)
        """,
        (
            str(LOCAL_TENANT),
            json.dumps(ScoringPolicy.default(LOCAL_TENANT).to_rubric_dict()),
            json.dumps(
                [
                    {
                        "anchor_id": "legacy-anchor",
                        "job_id": "https://example.com/job/legacy",
                        "fit_score": 6,
                        "rationale": "Existing PR2 anchor shape.",
                        "dimensions": ["technical_fit"],
                        "created_at": "2024-01-04T00:00:00+00:00",
                    }
                ]
            ),
            "2024-01-04T00:00:00+00:00",
        ),
    )

    policy = SqliteScoringPolicyRepository(conn).get_current(LOCAL_TENANT)

    assert policy.version == 7
    assert policy.anchors[0].anchor_id == "legacy-anchor"
    assert policy.anchors[0].fit_score == FitScore.create(6)
    assert policy.anchors[0].corrected_fit_score == FitScore.create(6)
    serialized_anchor = policy.to_anchors_list()[0]
    serialized_anchor_json = json.dumps(serialized_anchor)
    assert serialized_anchor["job_ref_hash"].startswith("sha256:")
    assert "https://example.com/job/legacy" not in serialized_anchor_json
    assert "Existing PR2 anchor shape." not in serialized_anchor_json
