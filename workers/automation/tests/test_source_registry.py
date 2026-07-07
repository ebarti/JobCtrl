"""Tests for source locator policy and generated source registry entries."""

from __future__ import annotations

import logging
import sqlite3

import pytest

from jobctl import config
from jobctl.domain.discovery.source_registry import (
    ATS_API_POLICY,
    WORKDAY_API_POLICY,
    LocatorPolicy,
    ManualActionReason,
    ManualActionRequired,
    ManualInterventionPolicy,
    RobotsPolicy,
    SourceDiscoveryEvidence,
    SourceKind,
    SourceLocationCandidate,
    SourcePriority,
    SourcePolicy,
    SourcePolicyMethod,
    SourceState,
    validate_locator_candidate,
)
from jobctl.domain.tenant import LOCAL_TENANT


def test_source_policy_rejects_third_party_control_bypass() -> None:
    with pytest.raises(ValueError, match="third_party_control_bypass"):
        SourcePolicy(
            policy_id="unsafe",
            allowed_methods=(SourcePolicyMethod.RENDERED_DETAIL,),
            third_party_control_bypass=True,
        )


def test_source_policy_defaults_are_conservative_and_fail_closed() -> None:
    policy = SourcePolicy(
        policy_id="defaults",
        allowed_methods=(SourcePolicyMethod.RENDERED_LISTING,),
    )
    # Page-rendering sources honor robots by default (fail-closed).
    assert policy.robots_policy is RobotsPolicy.HONOR
    assert policy.min_request_interval_seconds > 0
    assert policy.max_concurrent_requests_per_host >= 1
    assert policy.max_requests_per_run > 0
    # max_pages_per_run keeps its result-volume meaning, distinct from the
    # new outbound-request budget.
    assert policy.max_pages_per_run == 100
    assert policy.max_requests_per_run != policy.max_pages_per_run


def test_documented_api_policies_are_robots_exempt() -> None:
    # Documented public JSON APIs rely on the documented-API contract (D2).
    assert WORKDAY_API_POLICY.robots_policy is RobotsPolicy.EXEMPT_DOCUMENTED_API
    assert ATS_API_POLICY.robots_policy is RobotsPolicy.EXEMPT_DOCUMENTED_API
    # Their request budget must not throttle documented pagination.
    assert WORKDAY_API_POLICY.max_requests_per_run >= WORKDAY_API_POLICY.max_pages_per_run
    assert ATS_API_POLICY.max_requests_per_run >= ATS_API_POLICY.max_pages_per_run


def test_source_policy_rejects_non_positive_politeness_bounds() -> None:
    with pytest.raises(ValueError, match="min_request_interval_seconds"):
        SourcePolicy(
            policy_id="bad-interval",
            allowed_methods=(SourcePolicyMethod.RENDERED_DETAIL,),
            min_request_interval_seconds=-1.0,
        )
    with pytest.raises(ValueError, match="max_concurrent_requests_per_host"):
        SourcePolicy(
            policy_id="bad-concurrency",
            allowed_methods=(SourcePolicyMethod.RENDERED_DETAIL,),
            max_concurrent_requests_per_host=0,
        )
    with pytest.raises(ValueError, match="max_requests_per_run"):
        SourcePolicy(
            policy_id="bad-budget",
            allowed_methods=(SourcePolicyMethod.RENDERED_DETAIL,),
            max_requests_per_run=0,
        )


def test_robots_disallowed_is_a_reason_and_default_trigger() -> None:
    assert ManualActionReason.ROBOTS_DISALLOWED.value == "robots_disallowed"
    assert ManualActionReason.ROBOTS_DISALLOWED in ManualInterventionPolicy().triggers


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
        == "promote"
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
        == "promote"
    )
    assert (
        validate_locator_candidate(
            SourceLocationCandidate(
                confidence=0.9,
                **{
                    **base,
                    "candidate_url": "https://jobs.lever.co/acme",
                    "evidence": SourceDiscoveryEvidence(
                        matched_url="https://jobs.lever.co/acme",
                        detected_ats_kind="lever",
                        employer_domain_matched=False,
                        validation_fetch_status=200,
                    ),
                },
            )
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


def test_load_source_registry_generates_entries_from_packaged_yaml_shapes(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctl.db")

    registry = config.load_source_registry(
        search_cfg={"boards": ["linkedin", "indeed"]},
        sites_cfg={
            "sources": [
                {
                    "id": "greenhouse:acme",
                    "kind": "ats_api",
                    "display_name": "Acme Greenhouse",
                    "priority": "canonical",
                    "seed_url": "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
                    "board_token": "acme",
                    "ats_kind": "greenhouse",
                }
            ],
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
    assert workday.adapter_config["employer_key"] == "acme"
    assert workday.adapter_config["tenant"] == "acme"

    greenhouse = by_id["greenhouse:acme"]
    assert greenhouse.kind is SourceKind.ATS_API
    assert greenhouse.policy.policy_id == "ats_api_canonical"
    assert greenhouse.adapter_config["board_token"] == "acme"

    assert by_id["jobspy:linkedin"].kind is SourceKind.BROAD_BOARD
    assert by_id["jobspy:indeed"].adapter_config["board"] == "indeed"


def test_load_source_registry_applies_local_product_control_overrides(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobctl.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE source_registry_entries (
          tenant_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          owner TEXT NOT NULL,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          seed_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, source_id)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO source_registry_entries (
          tenant_id, source_id, kind, display_name, owner, priority,
          state, policy_id, seed_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            "smart_extract:remoteok",
            "smart_extract",
            "RemoteOK Override",
            "user",
            "fallback",
            "quarantined",
            "local:smart_extract:remoteok",
            "https://remoteok.example/jobs",
            "2026-05-13T00:00:00Z",
            "2026-05-13T00:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO source_registry_entries (
          tenant_id, source_id, kind, display_name, owner, priority,
          state, policy_id, seed_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            "custom-careers",
            "employer_careers_page",
            "Custom Careers",
            "user",
            "standard",
            "experimental",
            "local:custom-careers",
            "https://example.com/careers",
            "2026-05-13T00:00:00Z",
            "2026-05-13T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    registry = config.load_source_registry(
        search_cfg={"boards": []},
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
        employers_cfg={"employers": {}},
    )

    by_id = {entry.source_id: entry for entry in registry}
    assert by_id["smart_extract:remoteok"].state is SourceState.QUARANTINED
    assert by_id["smart_extract:remoteok"].adapter_config["url"] == "https://remoteok.example/jobs"
    assert by_id["custom-careers"].kind is SourceKind.EMPLOYER_CAREERS_PAGE
    assert by_id["custom-careers"].adapter_config["url"] == "https://example.com/careers"


def test_load_source_registry_coalesces_known_workday_host_aliases(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobctl.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE source_registry_entries (
          tenant_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          owner TEXT NOT NULL,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          seed_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, source_id)
        )
        """
    )
    now = "2026-05-13T00:00:00Z"
    conn.executemany(
        """
        INSERT INTO source_registry_entries (
          tenant_id, source_id, kind, display_name, owner, priority,
          state, policy_id, seed_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                str(LOCAL_TENANT),
                "workday:acme-wd3-myworkdayjobs-com",
                "ats_api",
                "acme.wd3.myworkdayjobs.com",
                "user",
                SourcePriority.CANONICAL.value,
                SourceState.ACTIVE.value,
                "workday_api_canonical",
                "https://acme.wd3.myworkdayjobs.com",
                now,
                now,
            ),
            (
                str(LOCAL_TENANT),
                "workday:unknown-wd3-myworkdayjobs-com",
                "ats_api",
                "unknown.wd3.myworkdayjobs.com",
                "user",
                SourcePriority.CANONICAL.value,
                SourceState.ACTIVE.value,
                "workday_api_canonical",
                "https://unknown.wd3.myworkdayjobs.com",
                now,
                now,
            ),
        ],
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    registry = config.load_source_registry(
        search_cfg={"boards": []},
        sites_cfg={"sites": []},
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
    assert "workday:acme" in by_id
    assert "workday:acme-wd3-myworkdayjobs-com" not in by_id
    assert "workday:unknown-wd3-myworkdayjobs-com" in by_id


def test_system_source_registry_rows_keep_packaged_seed_url_updates(tmp_path, monkeypatch) -> None:
    db_path = tmp_path / "jobctl.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE source_registry_entries (
          tenant_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          owner TEXT NOT NULL,
          priority TEXT NOT NULL,
          state TEXT NOT NULL,
          policy_id TEXT NOT NULL,
          seed_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, source_id)
        )
        """
    )
    conn.execute(
        """
        INSERT INTO source_registry_entries (
          tenant_id, source_id, kind, display_name, owner, priority,
          state, policy_id, seed_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            "smart_extract:wellfound",
            "smart_extract",
            "Wellfound",
            "system",
            "fallback",
            "active",
            "smart_extract_experimental",
            "https://wellfound.com/role/l/software-engineer/canada",
            "2026-05-13T00:00:00Z",
            "2026-05-13T00:00:00Z",
        ),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "DB_PATH", db_path)

    registry = config.load_source_registry(
        search_cfg={"target_region": "europe", "boards": []},
        sites_cfg={
            "sites": [
                {
                    "name": "Wellfound",
                    "url": "https://wellfound.com/location/spain",
                    "type": "static",
                }
            ],
        },
        employers_cfg={"employers": {}},
    )

    by_id = {entry.source_id: entry for entry in registry}
    assert by_id["smart_extract:wellfound"].state is SourceState.ACTIVE
    assert by_id["smart_extract:wellfound"].adapter_config["url"] == "https://wellfound.com/location/spain"
