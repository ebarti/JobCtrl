"""Cross-runtime pin for the apply approval-gate refusal vocabulary."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobctrl.apply import launcher
from jobctrl.domain.apply.value_objects import APPROVAL_GATE_REFUSAL_REASONS

_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/domain-types/test/fixtures/apply_approval_gate_reasons.json"
)


def _fixture() -> dict[str, list[str]]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def test_refusal_reasons_match_shared_fixture() -> None:
    fixture = _fixture()
    assert APPROVAL_GATE_REFUSAL_REASONS == frozenset(fixture["launcherRefusalReasons"])
    assert APPROVAL_GATE_REFUSAL_REASONS <= frozenset(fixture["reasons"])


@pytest.mark.parametrize(
    ("scenario", "expected"),
    [
        ("awaiting_approval", "awaiting_approval"),
        ("stale_materials", "approval_stale_materials"),
        ("stale_profile", "approval_stale_profile"),
        ("stale_url", "approval_stale_url"),
        ("stale_email_candidate", "approval_stale_email_candidate"),
        ("awaiting_dry_run", "awaiting_dry_run"),
        ("invalid_override", "override_evidence_invalid"),
        ("full_evidence", None),
        ("partial_override_evidence", None),
    ],
)
def test_refusal_reason_branches_emit_only_shared_contract_values(
    monkeypatch: pytest.MonkeyPatch,
    scenario: str,
    expected: str | None,
) -> None:
    decision: dict[str, object] | None = {
        "decision": "approve_submit",
        "materials_generation": 1,
        "profile_version": 2,
        "application_url": "https://example.test/apply",
    }
    materials_generation: object = 1
    profile_version = 2
    application_url = "https://example.test/apply"
    email_candidate: dict[str, object] | None = None
    accepted_coverages: set[str] = set()

    if scenario == "awaiting_approval":
        decision = None
    elif scenario == "stale_materials":
        materials_generation = "invalid"
    elif scenario == "stale_profile":
        profile_version = 3
    elif scenario == "stale_url":
        application_url = "https://example.test/other"
    elif scenario == "stale_email_candidate":
        email_candidate = {
            "recipient": "jobs@example.test",
            "attachment_artifact_id": "artifact-1",
        }
    elif scenario == "invalid_override":
        assert decision is not None
        decision["partial_override_run_id"] = "dry-run-1"
    elif scenario == "full_evidence":
        accepted_coverages.add("full")
    elif scenario == "partial_override_evidence":
        assert decision is not None
        decision["partial_override_run_id"] = "dry-run-1"
        accepted_coverages.add("partial")

    monkeypatch.setattr(
        launcher,
        "_latest_apply_review_decision",
        lambda *_args, **_kwargs: decision,
    )
    monkeypatch.setattr(
        launcher,
        "_latest_email_application_candidate",
        lambda *_args, **_kwargs: email_candidate,
    )
    monkeypatch.setattr(
        launcher,
        "_dry_run_evidence_exists",
        lambda *_args, coverage, **_kwargs: coverage in accepted_coverages,
    )

    reason = launcher._approval_refusal_reason(
        object(),
        tenant_id="local",
        job_id="job-1",
        materials_generation=materials_generation,
        profile_version=profile_version,
        application_url=application_url,
    )

    assert reason == expected
    assert reason is None or reason in APPROVAL_GATE_REFUSAL_REASONS


def test_refusal_reason_boundary_rejects_values_outside_shared_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        launcher,
        "_approval_refusal_reason_unchecked",
        lambda *_args, **_kwargs: "unshared_reason",
    )

    with pytest.raises(RuntimeError, match="unsupported refusal reason"):
        launcher._approval_refusal_reason(
            object(),
            tenant_id="local",
            job_id="job-1",
            materials_generation=1,
            profile_version=1,
            application_url="https://example.test/apply",
        )
