from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading

import pytest

from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.materials.policy import TailoringPolicy
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials import (
    SqliteTailoringPolicyRepository,
    TailoringPolicyRevisionError,
)


_TENANT_A = TenantId("tenant-a")
_TENANT_B = TenantId("tenant-b")


def test_history_and_rollback_are_append_only_and_tenant_scoped(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteTailoringPolicyRepository(conn)
    original = _policy(_TENANT_A)
    learned = original.with_learned_tailoring_rule(
        rule_key="fact_handling",
        rule_value="require_source_match",
        version=2,
        created_at="2026-08-01T11:00:00Z",
    )
    repository.save(original)
    repository.save(learned)
    repository.save(_policy(_TENANT_B))

    assert [policy.version for policy in repository.list_history(_TENANT_A)] == [2, 1]
    assert [policy.version for policy in repository.list_history(_TENANT_B)] == [1]
    assert repository.get_version(_TENANT_A, 2) == learned
    assert repository.get_version(_TENANT_B, 2) is None

    rollback = repository.rollback_to(
        _TENANT_A,
        target_version=1,
        reason="user_requested",
        rolled_back_at="2026-08-01T12:00:00Z",
    )

    assert rollback.version == 3
    assert rollback.rollback_of_version == 1
    assert rollback.rollback_reason == "user_requested"
    assert rollback.created_at == "2026-08-01T12:00:00Z"
    assert rollback.learned_tailoring_rules.rules == ()
    assert repository.get_current(_TENANT_A) == rollback
    assert repository.get_version(_TENANT_A, 2) == learned
    assert [policy.version for policy in repository.list_history(_TENANT_A)] == [3, 2, 1]
    close_connection(db_path)


def test_rollback_validation_and_replay_do_not_duplicate_history(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    repository = SqliteTailoringPolicyRepository(conn)

    with pytest.raises(TailoringPolicyRevisionError, match="not initialized"):
        repository.rollback_to(
            _TENANT_A,
            target_version=1,
            reason="user_requested",
            rolled_back_at="2026-08-01T12:00:00Z",
        )

    original = _policy(_TENANT_A)
    repository.save(original)
    with pytest.raises(TailoringPolicyRevisionError, match="must precede"):
        repository.rollback_to(
            _TENANT_A,
            target_version=1,
            reason="user_requested",
            rolled_back_at="2026-08-01T12:00:00Z",
        )

    repository.save(
        original.with_learned_tailoring_rule(
            rule_key="fact_handling",
            rule_value="require_source_match",
            version=2,
            created_at="2026-08-01T11:00:00Z",
        )
    )
    with pytest.raises(TailoringPolicyRevisionError, match="does not exist"):
        repository.rollback_to(
            _TENANT_A,
            target_version=99,
            reason="user_requested",
            rolled_back_at="2026-08-01T12:00:00Z",
        )

    first = repository.rollback_to(
        _TENANT_A,
        target_version=1,
        reason="user_requested",
        rolled_back_at="2026-08-01T12:00:00Z",
    )
    replay = repository.rollback_to(
        _TENANT_A,
        target_version=1,
        reason="user_requested",
        rolled_back_at="2026-08-01T12:01:00Z",
    )

    assert replay == first
    assert [policy.version for policy in repository.list_history(_TENANT_A)] == [3, 2, 1]
    close_connection(db_path)


def test_concurrent_rollback_replay_returns_one_appended_revision(tmp_path: Path) -> None:
    db_path = tmp_path / "jobctrl.db"
    setup_conn = init_db(db_path)
    repository = SqliteTailoringPolicyRepository(setup_conn)
    original = _policy(_TENANT_A)
    repository.save(original)
    repository.save(
        original.with_learned_tailoring_rule(
            rule_key="fact_handling",
            rule_value="require_source_match",
            version=2,
            created_at="2026-08-01T11:00:00Z",
        )
    )
    close_connection(db_path)
    start = threading.Event()

    def rollback():
        conn = get_connection(db_path)
        try:
            start.wait(timeout=5)
            return SqliteTailoringPolicyRepository(conn).rollback_to(
                _TENANT_A,
                target_version=1,
                reason="user_requested",
                rolled_back_at="2026-08-01T12:00:00Z",
            )
        finally:
            close_connection(db_path)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(rollback) for _ in range(2)]
        start.set()
        rollbacks = [future.result(timeout=10) for future in futures]

    assert [policy.version for policy in rollbacks] == [3, 3]
    check_conn = get_connection(db_path)
    try:
        assert [
            policy.version
            for policy in SqliteTailoringPolicyRepository(check_conn).list_history(_TENANT_A)
        ] == [3, 2, 1]
    finally:
        close_connection(db_path)


def _policy(tenant_id: TenantId) -> TailoringPolicy:
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
