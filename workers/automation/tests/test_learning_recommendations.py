from __future__ import annotations

from dataclasses import asdict
import json

import pytest

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.operations.feedback import (
    ScoreCorrectionFeedbackSignal,
    TailoringFeedbackSignal,
)
from jobctrl.domain.operations.learning import (
    TAILORING_RECOMMENDATION_DERIVATION_VERSION,
    TailoringContradictionEvidence,
    TailoringRecommendationScope,
    TailoringRuleEffect,
    derive_tailoring_recommendations,
)
from jobctrl.domain.tenant import TenantId


_TENANT = TenantId("tenant-a")
_JOB_A = canonical_job_id("10000000-0000-4000-8000-000000000001")
_JOB_B = canonical_job_id("10000000-0000-4000-8000-000000000002")
_PRIVATE_SENTINELS = (
    "private edit text",
    "private generated resume",
    "private job description",
    "private prompt",
    "private mail body",
    "/Users/private/resume.pdf",
)


def test_three_compatible_signals_across_two_jobs_derive_one_pending_proposal() -> None:
    signals = (
        _signal("signal-3", _JOB_B, 3),
        _signal("signal-1", _JOB_A, 1),
        _signal("signal-2", _JOB_A, 2),
    )

    recommendations = derive_tailoring_recommendations(signals, contradictions={})

    assert len(recommendations) == 1
    recommendation = recommendations[0]
    assert recommendation.status == "pending"
    assert recommendation.derivation_version == TAILORING_RECOMMENDATION_DERIVATION_VERSION
    assert recommendation.evaluation_fixture_version == 1
    assert recommendation.supporting_signal_ids == ("signal-1", "signal-2", "signal-3")
    assert recommendation.contradicting_signal_ids == ()
    assert recommendation.job_ids == (_JOB_A, _JOB_B)
    assert recommendation.observed_signal_count == 3
    assert recommendation.observed_job_count == 2
    assert recommendation.minimum_signal_count == 3
    assert recommendation.minimum_job_count == 2
    assert recommendation.confidence_limit == "sample_gated_no_population_inference"
    assert recommendation.proposed_effect == _scope().proposed_effect
    assert [evidence.source_id for evidence in recommendation.evidence] == [
        "source-signal-1",
        "source-signal-2",
        "source-signal-3",
    ]


@pytest.mark.parametrize(
    "signal_specs",
    [
        (("signal-1", _JOB_A, 1), ("signal-2", _JOB_B, 2)),
        (
            ("signal-1", _JOB_A, 1),
            ("signal-2", _JOB_A, 2),
            ("signal-3", _JOB_A, 3),
        ),
    ],
    ids=("insufficient-signals", "single-job-concentration"),
)
def test_thresholds_fail_closed(
    signal_specs: tuple[tuple[str, str, int], ...],
) -> None:
    signals = tuple(_signal(*spec) for spec in signal_specs)
    assert derive_tailoring_recommendations(signals, contradictions={}) == ()


def test_duplicate_inputs_are_deduplicated_and_order_independent() -> None:
    signal_1 = _signal("signal-1", _JOB_A, 1)
    signal_2 = _signal("signal-2", _JOB_A, 2)
    signal_3 = _signal("signal-3", _JOB_B, 3)

    forward = derive_tailoring_recommendations(
        (signal_1, signal_2, signal_3), contradictions={}
    )
    reordered = derive_tailoring_recommendations(
        (signal_3, signal_1, signal_2, signal_1, signal_3),
        contradictions={},
    )

    assert reordered == forward
    assert reordered[0].observed_signal_count == 3


def test_canonical_subject_correction_changes_the_derivation_identity() -> None:
    original = derive_tailoring_recommendations(
        (
            _signal("signal-1", _JOB_A, 1),
            _signal("signal-2", _JOB_A, 2),
            _signal("signal-3", _JOB_B, 3),
        ),
        contradictions={},
    )[0]
    corrected = derive_tailoring_recommendations(
        (
            _signal("signal-1", _JOB_B, 1),
            _signal("signal-2", _JOB_A, 2),
            _signal("signal-3", _JOB_B, 3),
        ),
        contradictions={},
    )[0]

    assert corrected.supporting_signal_ids == original.supporting_signal_ids
    assert corrected.recommendation_id != original.recommendation_id


def test_tenants_never_share_thresholds_or_recommendation_identity() -> None:
    tenant_b = TenantId("tenant-b")
    tenant_a_signals = (
        _signal("signal-1", _JOB_A, 1),
        _signal("signal-2", _JOB_B, 2),
    )
    tenant_b_signals = (
        _signal("signal-1", _JOB_A, 1, tenant_id=tenant_b),
        _signal("signal-2", _JOB_A, 2, tenant_id=tenant_b),
        _signal("signal-3", _JOB_B, 3, tenant_id=tenant_b),
    )

    assert (
        derive_tailoring_recommendations(
            (*tenant_a_signals, tenant_b_signals[0]), contradictions={}
        )
        == ()
    )

    recommendations = derive_tailoring_recommendations(
        (*tenant_a_signals, _signal("signal-3", _JOB_A, 3), *tenant_b_signals),
        contradictions={},
    )
    by_tenant = {
        recommendation.scope.tenant_id: recommendation
        for recommendation in recommendations
    }
    assert set(by_tenant) == {_TENANT, tenant_b}
    assert by_tenant[_TENANT].recommendation_id != by_tenant[tenant_b].recommendation_id


def test_conflicting_duplicate_signal_identity_is_rejected() -> None:
    with pytest.raises(ValueError, match="conflicting accepted facts"):
        derive_tailoring_recommendations(
            (
                _signal("signal-1", _JOB_A, 1),
                _signal("signal-1", _JOB_B, 1),
            ),
            contradictions={},
        )


def test_unresolved_contradiction_blocks_derivation_but_resolved_history_is_recorded() -> None:
    signals = (
        _signal("signal-1", _JOB_A, 1),
        _signal("signal-2", _JOB_A, 2),
        _signal("signal-3", _JOB_B, 3),
    )
    unresolved = {
        _scope(): TailoringContradictionEvidence(
            signal_ids=("contradiction-2", "contradiction-1"),
            unresolved_signal_ids=("contradiction-1",),
        )
    }

    assert (
        derive_tailoring_recommendations(
            signals,
            contradictions=unresolved,
        )
        == ()
    )

    resolved = derive_tailoring_recommendations(
        signals,
        contradictions={
            _scope(): TailoringContradictionEvidence(
                signal_ids=("contradiction-2", "contradiction-1"),
                unresolved_signal_ids=(),
            )
        },
    )
    assert resolved[0].contradicting_signal_ids == (
        "contradiction-1",
        "contradiction-2",
    )


def test_unregistered_derivation_version_is_rejected_until_its_fixture_exists() -> None:
    with pytest.raises(ValueError, match="no passing evaluation fixture"):
        derive_tailoring_recommendations(
            (
                _signal("signal-1", _JOB_A, 1),
                _signal("signal-2", _JOB_A, 2),
                _signal("signal-3", _JOB_B, 3),
            ),
            contradictions={},
            derivation_version=TAILORING_RECOMMENDATION_DERIVATION_VERSION + 1,
        )


def test_recommendation_contains_no_private_source_content() -> None:
    recommendation = derive_tailoring_recommendations(
        (
            _signal("signal-1", _JOB_A, 1),
            _signal("signal-2", _JOB_A, 2),
            _signal("signal-3", _JOB_B, 3),
        ),
        contradictions={},
    )[0]
    serialized = json.dumps(asdict(recommendation), sort_keys=True)

    for sentinel in _PRIVATE_SENTINELS:
        assert sentinel not in serialized
    assert "summary" not in serialized
    assert "application_outcome" not in serialized
    assert "raw" not in serialized


def test_empty_or_non_tailoring_input_cannot_create_a_recommendation() -> None:
    assert derive_tailoring_recommendations((), contradictions={}) == ()
    score_correction = ScoreCorrectionFeedbackSignal(
        signal_id="score-correction",
        tenant_id=_TENANT,
        job_id=_JOB_A,
        source_id="score-source",
        source_revision=2,
        recorded_at="2026-08-01T10:00:00Z",
        original_fit_score=4,
        corrected_fit_score=8,
    )
    assert derive_tailoring_recommendations(
        (score_correction,), contradictions={}
    ) == ()


def _scope() -> TailoringRecommendationScope:
    return TailoringRecommendationScope(
        tenant_id=_TENANT,
        proposed_effect=TailoringRuleEffect(
            signal_kind="factual_correction",
            rule_key="fact_handling",
            rule_value="require_source_match",
            allowlist_version=1,
        ),
    )


def _signal(
    signal_id: str,
    job_id: str,
    revision: int,
    *,
    tenant_id: TenantId = _TENANT,
) -> TailoringFeedbackSignal:
    return TailoringFeedbackSignal(
        signal_id=signal_id,
        tenant_id=tenant_id,
        job_id=canonical_job_id(job_id),
        source_id=f"source-{signal_id}",
        source_revision=revision,
        recorded_at=f"2026-08-01T10:00:0{revision}Z",
        signal_kind="factual_correction",
        rule_key="fact_handling",
        rule_value="require_source_match",
        allowlist_version=1,
    )
