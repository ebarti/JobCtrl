"""ScoringPolicy domain and SQLite persistence tests."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobhunter.database import init_db
from jobhunter.domain.scoring import FitBandThreshold, ScoreBreakdown, ScoringPolicy
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.scoring import SqliteScoringPolicyRepository


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")


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
