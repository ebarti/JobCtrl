from __future__ import annotations

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest

from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.materials.policy import TailoringPolicy
from jobctrl.domain.operations.feedback import TAILORING_FEEDBACK_RULE_ALLOWLIST
from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.materials import (
    SqliteTailoringPolicyRepository,
    TailoringPolicyCommandConflictError,
    TailoringPolicyRevisionError,
    TailoringPolicyStaleReviewError,
)

TENANT_A = TenantId("tenant-a")
TENANT_B = TenantId("tenant-b")
COMMAND_A = "11111111-1111-4111-8111-111111111111"
COMMAND_B = "22222222-2222-4222-8222-222222222222"
TIME = "2026-08-01T12:00:00Z"


def _policy(tenant: TenantId) -> TailoringPolicy:
    return TailoringPolicy(
        tenant_id=tenant, version=1, prompt_version="synthetic", schema_version="synthetic",
        judge_schema_version="synthetic", prompt_fingerprint="sha256:prompt",
        config_fingerprint="sha256:config", profile_policy_fingerprint="sha256:profile",
        custom_prompt_fingerprint="sha256:custom", generator_settings={"candidate_models": ["local:draft"]},
        judge_settings={"judge_model": "local:judge"}, runtime_settings={"validation_mode": "normal"},
        created_at="2026-08-01T10:00:00Z",
    )


def _seed(repo: SqliteTailoringPolicyRepository, tenant: TenantId = TENANT_A) -> tuple[TailoringPolicy, TailoringPolicy]:
    first = _policy(tenant)
    second = first.with_learned_tailoring_rule(
        rule_key="fact_handling", rule_value="require_source_match", version=2,
        created_at="2026-08-01T11:00:00Z",
    )
    repo.save(first)
    repo.save(second)
    return first, second


def _restore(repo: SqliteTailoringPolicyRepository, tenant: TenantId = TENANT_A, **changes):
    args = dict(target_version=1, expected_current_version=2, command_id=COMMAND_A,
                reason="user_requested", rolled_back_at=TIME)
    args.update(changes)
    return repo.rollback_to(tenant, **args)


def test_stale_review_preserves_intervening_write_and_fresh_review_preserves_both(tmp_path: Path):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    first, second = _seed(repo)
    # A separate session advances the policy after the review of version 2.
    with sqlite3.connect(path) as other:
        other_repo = SqliteTailoringPolicyRepository(other)
        third = replace(second, version=3, created_at="2026-08-01T11:30:00Z")
        other_repo.save(third)
    with pytest.raises(TailoringPolicyStaleReviewError):
        _restore(repo)
    assert repo.get_current(TENANT_A) == third
    assert repo.list_history(TENANT_A) == [third, second, first]
    restored = _restore(repo, expected_current_version=3, command_id=COMMAND_B)
    assert restored.policy.version == 4
    assert restored.policy.same_config_as(first)
    assert restored.policy.rollback_reason == "user_requested"
    assert [p.version for p in repo.list_history(TENANT_A)] == [4, 3, 2, 1]
    assert repo.get_version(TENANT_A, 3) == third
    close_connection(path)


def test_lost_response_restart_and_delayed_replay_leave_new_head_unchanged(tmp_path: Path):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    first, second = _seed(repo)
    committed = _restore(repo)
    assert committed.policy.version == 3 and committed.current_version == 3 and not committed.replayed
    # Discard the first response and open independent connections, as after restart.
    close_connection(path)
    with sqlite3.connect(path) as other:
        other_repo = SqliteTailoringPolicyRepository(other)
        immediate = _restore(other_repo, rolled_back_at="2026-08-01T12:01:00Z")
        assert immediate.policy == committed.policy and immediate.replayed
        fourth = replace(second, version=4, created_at="2026-08-01T13:00:00Z")
        other_repo.save(fourth)
    conn = get_connection(path)
    repo = SqliteTailoringPolicyRepository(conn)
    replay = _restore(repo, rolled_back_at="2026-08-01T14:00:00Z")
    assert replay.policy == committed.policy and replay.current_version == 4 and replay.replayed
    assert repo.get_current(TENANT_A) == fourth
    assert repo.get_version(TENANT_A, 1) == first and repo.get_version(TENANT_A, 2) == second
    assert [p.version for p in repo.list_history(TENANT_A)] == [4, 3, 2, 1]
    raw = conn.execute("SELECT rollback_reason FROM tailoring_policies WHERE tenant_id=? AND version=3", (TENANT_A,)).fetchone()[0]
    assert COMMAND_A in raw and '"expectedCurrentVersion":2' in raw and '"targetVersion":1' in raw
    close_connection(path)


@pytest.mark.parametrize("same_command", [False, True])
def test_independent_sessions_race_against_one_review(tmp_path: Path, same_command: bool):
    path = tmp_path / "synthetic.db"
    repo = SqliteTailoringPolicyRepository(init_db(path))
    _seed(repo)
    close_connection(path)
    start = threading.Barrier(2)

    def submit(command_id):
        with sqlite3.connect(path, timeout=10) as conn:
            start.wait(timeout=5)
            try:
                return _restore(SqliteTailoringPolicyRepository(conn), command_id=command_id)
            except TailoringPolicyStaleReviewError:
                return "stale"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, [COMMAND_A, COMMAND_A if same_command else COMMAND_B]))
    accepted = [r for r in results if r != "stale"]
    assert len(accepted) == (2 if same_command else 1)
    assert all(r.policy.version == 3 for r in accepted)
    if same_command:
        assert sorted(r.replayed for r in accepted) == [False, True]
        assert accepted[0].policy == accepted[1].policy
    else:
        assert results.count("stale") == 1
    with sqlite3.connect(path) as conn:
        repo = SqliteTailoringPolicyRepository(conn)
        assert [p.version for p in repo.list_history(TENANT_A)] == [3, 2, 1]
        if not same_command:
            next_restore = _restore(repo, command_id="33333333-3333-4333-8333-333333333333", expected_current_version=3)
            assert next_restore.policy.version == 4
            assert [p.version for p in repo.list_history(TENANT_A)] == [4, 3, 2, 1]


def test_tenants_invalid_fields_and_conflicting_payloads_do_not_leak_or_mutate(tmp_path: Path):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    _seed(repo, TENANT_A)
    _seed(repo, TENANT_B)
    # Same numeric versions and command ID are independent per tenant.
    a = _restore(repo, TENANT_A)
    b = _restore(repo, TENANT_B)
    assert a.policy.tenant_id == TENANT_A and b.policy.tenant_id == TENANT_B
    assert a.policy.version == b.policy.version == 3
    for changes in ({"expected_current_version": 1}, {"target_version": 2}):
        with pytest.raises(TailoringPolicyCommandConflictError):
            _restore(repo, **changes)
    for changes in ({"target_version": True}, {"expected_current_version": 0},
                    {"expected_current_version": "2"}, {"command_id": ""},
                    {"command_id": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"},
                    {"reason": "other"}):
        with pytest.raises(TailoringPolicyRevisionError):
            _restore(repo, command_id=COMMAND_B, **changes) if "command_id" not in changes else _restore(repo, **changes)
    # Version 4 exists only in B; A must see the same refusal as a missing target.
    fourth_b = replace(b.policy, version=4, created_at="2026-08-02T12:00:00Z")
    repo.save(fourth_b)
    for foreign_or_missing in (4, 99):
        with pytest.raises(TailoringPolicyRevisionError, match="does not exist"):
            _restore(repo, target_version=foreign_or_missing, expected_current_version=3, command_id=COMMAND_B)
    assert [p.version for p in repo.list_history(TENANT_A)] == [3, 2, 1]
    assert [p.version for p in repo.list_history(TENANT_B)] == [4, 3, 2, 1]
    close_connection(path)


@pytest.mark.parametrize("settings", ["not-json", "[]", '{"learned_tailoring_rules":{"fact_handling":"unsupported"}}'])
def test_invalid_historical_configuration_is_not_replaced_by_reader_fallback(tmp_path: Path, settings: str):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    _seed(repo)
    conn.execute("UPDATE tailoring_policies SET runtime_settings_json=? WHERE tenant_id=? AND version=1", (settings, TENANT_A))
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")]
    with pytest.raises(TailoringPolicyRevisionError, match="configuration is invalid"):
        _restore(repo)
    assert [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")] == before
    close_connection(path)


@pytest.mark.parametrize("column", ["generator_settings_json", "judge_settings_json", "runtime_settings_json"])
@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e9999"])
def test_restore_rejects_nonfinite_values_in_all_historical_settings(tmp_path: Path, column: str, number: str):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    _seed(repo)
    conn.execute(
        f"UPDATE tailoring_policies SET {column}=? WHERE tenant_id=? AND version=1",
        (f'{{"nested":[{{"value":{number}}}]}}', TENANT_A),
    )
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")]
    with pytest.raises(TailoringPolicyRevisionError, match="configuration is invalid"):
        _restore(repo)
    assert [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")] == before
    assert repo.get_current(TENANT_A).version == 2
    close_connection(path)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("fact_handling", " require_source_match "),
        (" fact_handling", "require_source_match"),
        ("fact_handling ", "require_source_match"),
        ("fact_handling", "require_source_match\n"),
    ],
)
def test_restore_rejects_noncanonical_learned_rules_without_mutating_history(tmp_path: Path, key: str, value: str):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    _seed(repo)
    settings = json.dumps({"learned_tailoring_rules": {key: value}})
    conn.execute("UPDATE tailoring_policies SET runtime_settings_json=? WHERE tenant_id=? AND version=1", (settings, TENANT_A))
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")]
    with pytest.raises(TailoringPolicyRevisionError, match="configuration is invalid"):
        _restore(repo)
    assert [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")] == before
    assert repo.get_current(TENANT_A).version == 2
    close_connection(path)


def test_restore_preserves_valid_nested_settings_and_exact_allowlisted_rules(tmp_path: Path):
    path = tmp_path / "synthetic.db"
    conn = init_db(path)
    repo = SqliteTailoringPolicyRepository(conn)
    rules = dict(TAILORING_FEEDBACK_RULE_ALLOWLIST.values())
    first = replace(
        _policy(TENANT_A),
        generator_settings={"thresholds": [0.25, {"enabled": True, "label": "NaN"}]},
        judge_settings={"nested": {"minimum": -3.5, "optional": None}},
        runtime_settings={"learned_tailoring_rules": rules, "limits": [0, 1e-300]},
    )
    second = replace(first, version=2, runtime_settings={"validation_mode": "normal"})
    repo.save(first)
    repo.save(second)
    before = [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")]
    restored = _restore(repo)
    assert restored.policy.version == 3
    assert restored.policy.generator_settings == first.generator_settings
    assert restored.policy.judge_settings == first.judge_settings
    assert restored.policy.runtime_settings == first.runtime_settings
    assert restored.policy.learned_tailoring_rules.to_dict() == rules
    rows = [tuple(row) for row in conn.execute("SELECT * FROM tailoring_policies ORDER BY version")]
    assert rows[:2] == before
    close_connection(path)


class FailCommit(sqlite3.Connection):
    fail = False

    def commit(self):
        if self.fail:
            raise sqlite3.OperationalError("injected commit failure")
        return super().commit()


@pytest.mark.parametrize("advance_before_retry", [False, True])
def test_commit_failure_rolls_back_revision_and_receipt_then_allows_retry(tmp_path: Path, advance_before_retry: bool):
    path = tmp_path / "synthetic.db"
    repo = SqliteTailoringPolicyRepository(init_db(path))
    _seed(repo)
    close_connection(path)
    conn = sqlite3.connect(path, factory=FailCommit)
    conn.fail = True
    with pytest.raises(sqlite3.OperationalError, match="injected"):
        _restore(SqliteTailoringPolicyRepository(conn))
    conn.close()
    with sqlite3.connect(path) as observer:
        repo = SqliteTailoringPolicyRepository(observer)
        assert [p.version for p in repo.list_history(TENANT_A)] == [2, 1]
        if advance_before_retry:
            second = repo.get_current(TENANT_A)
            repo.save(replace(second, version=3, created_at="2026-08-01T12:30:00Z"))
            with pytest.raises(TailoringPolicyStaleReviewError):
                _restore(repo)
            assert repo.get_current(TENANT_A).created_at == "2026-08-01T12:30:00Z"
        else:
            assert _restore(repo).policy.version == 3
        assert [p.version for p in repo.list_history(TENANT_A)] == [3, 2, 1]
