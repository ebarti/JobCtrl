"""Tests for source locator policy and generated source registry entries."""

from __future__ import annotations

import logging

import pytest

from jobhunter import config
from jobhunter.domain.discovery.source_registry import (
    LocatorPolicy,
    ManualActionReason,
    ManualActionRequired,
    SourceDiscoveryEvidence,
    SourceKind,
    SourceLocationCandidate,
    SourcePolicy,
    SourcePolicyMethod,
    SourceState,
    validate_locator_candidate,
)
from jobhunter.domain.tenant import LOCAL_TENANT


def test_source_policy_rejects_third_party_control_bypass() -> None:
    with pytest.raises(ValueError, match="third_party_control_bypass"):
        SourcePolicy(
            policy_id="unsafe",
            allowed_methods=(SourcePolicyMethod.RENDERED_DETAIL,),
            third_party_control_bypass=True,
        )


def test_locator_candidate_decision_thresholds_and_manual_boundary() -> None:
    evidence = SourceDiscoveryEvidence(
        matched_url="https://example.com/careers",
        page_title="Careers",
        employer_domain_matched=True,
        validation_fetch_status=200,
    )
    base = dict(
        tenant_id=LOCAL_TENANT,
        candidate_id="candidate-1",
        candidate_url="https://example.com/careers",
        source_kind=SourceKind.EMPLOYER_CAREERS_PAGE,
        evidence=evidence,
        discovered_at="2026-05-12T00:00:00Z",
    )

    assert (
        validate_locator_candidate(SourceLocationCandidate(confidence=0.5, **base))
        == "manual_action_required"
    )
    assert validate_locator_candidate(SourceLocationCandidate(confidence=0.9, **base)) == "promote"
    assert validate_locator_candidate(SourceLocationCandidate(confidence=0.1, **base)) == "reject"
    assert (
        validate_locator_candidate(
            SourceLocationCandidate(
                confidence=0.9,
                **{
                    **base,
                    "evidence": SourceDiscoveryEvidence(
                        matched_url="https://example.com/careers",
                        employer_domain_matched=False,
                        validation_fetch_status=200,
                    ),
                },
            )
        )
        == "manual_action_required"
    )
    assert (
        validate_locator_candidate(
            SourceLocationCandidate(
                confidence=0.9,
                **{
                    **base,
                    "evidence": SourceDiscoveryEvidence(
                        matched_url="https://example.com/careers",
                        employer_domain_matched=False,
                        validation_fetch_status=200,
                    ),
                },
            ),
            LocatorPolicy(allow_autonomous_broad_discovery=True),
        )
        == "promote"
    )
    assert (
        validate_locator_candidate(
            SourceLocationCandidate(
                confidence=0.9,
                **{
                    **base,
                    "evidence": SourceDiscoveryEvidence(
                        matched_url="https://jobs.example.com/careers",
                        employer_domain_matched=False,
                        validation_fetch_status=200,
                    ),
                    "candidate_url": "https://jobs.example.com/careers",
                },
            ),
            LocatorPolicy(domain_allowlist=("example.com",)),
        )
        == "promote"
    )

    blocked = SourceLocationCandidate(
        confidence=0.95,
        manual_action_required=ManualActionRequired(
            originating_url="https://example.com/jobs/1",
            source_id=None,
            reason=ManualActionReason.LOGIN_REQUIRED,
            retry_context={"source": "locator"},
            required_at="2026-05-12T00:00:00Z",
        ),
        **base,
    )
    assert validate_locator_candidate(blocked) == "manual_action_required"


def test_resolve_jobspy_boards_prefers_boards_and_warns_for_legacy_sites(caplog) -> None:
    assert config.resolve_jobspy_boards({"boards": ["linkedin"]}) == ["linkedin"]

    with caplog.at_level(logging.WARNING):
        assert config.resolve_jobspy_boards({"sites": ["indeed"]}) == ["indeed"]
    assert "sites' is deprecated" in caplog.text

    with caplog.at_level(logging.WARNING):
        assert config.resolve_jobspy_boards(
            {"boards": ["linkedin"], "sites": ["indeed"]}
        ) == ["linkedin"]
    assert "using 'boards'" in caplog.text


def test_load_source_registry_generates_entries_from_packaged_yaml_shapes() -> None:
    registry = config.load_source_registry(
        search_cfg={"boards": ["linkedin", "indeed"]},
        sites_cfg={
            "base_urls": {"RemoteOK": None},
            "sites": [
                {
                    "name": "RemoteOK",
                    "url": "https://remoteok.com/remote-dev-jobs",
                    "type": "static",
                }
            ],
        },
        employers_cfg={
            "employers": {
                "acme": {
                    "name": "Acme",
                    "tenant": "acme",
                    "site_id": "External",
                    "base_url": "https://acme.wd3.myworkdayjobs.com",
                }
            }
        },
    )

    by_id = {entry.source_id: entry for entry in registry}
    smart = by_id["smart_extract:remoteok"]
    assert smart.kind is SourceKind.SMART_EXTRACT
    assert smart.state is SourceState.EXPERIMENTAL
    assert smart.policy.policy_id == "smart_extract_experimental"

    workday = by_id["workday:acme"]
    assert workday.kind is SourceKind.ATS_API
    assert workday.adapter_config["tenant"] == "acme"

    assert by_id["jobspy:linkedin"].kind is SourceKind.BROAD_BOARD
    assert by_id["jobspy:indeed"].adapter_config["board"] == "indeed"
