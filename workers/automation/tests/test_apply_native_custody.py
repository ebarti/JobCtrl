"""Negative native-custody metadata checks; positive proof uses real Go scope QA.

These fixtures never stand in for an authenticated execution or completion.
The composed native harness exercises the actual kernel and stop authority.
"""

from __future__ import annotations

from hashlib import sha256
import json
import os
import platform
import uuid

import pytest

from jobctrl.apply.native_custody import capture_native_custody, verify_native_completion, _current_coalitions
from jobctrl.apply.process_birth import CustodyUnverified, boot_identity


def _scope(app, runtime):
    instance = sha256(str(app.resolve()).encode()).hexdigest()
    scope_id = uuid.uuid4().hex
    return {"schemaVersion": 1, "id": scope_id, "instanceId": instance, "stateDir": str(app.resolve()),
            "runtimeHome": str(runtime), "bootSession": boot_identity(),
            "jobLabel": f"dev.jobctrl.exec.{instance}.{scope_id}", "domain": f"gui/{os.getuid()}",
            "rootPid": 123, "rootIdentity": "synthetic-negative-metadata-only", "coalitionIds": [11, 22]}


@pytest.mark.skipif(platform.system() == "Windows", reason="native Apply completion is not qualified on Windows")
@pytest.mark.parametrize("fault", ["wrong_scope", "wrong_digest", "extra_field", "schema_bool", "nested_schema_bool", "bad_boot", "bad_time", "linked_proof", "duplicate_field"])
def test_foreign_or_damaged_completion_is_not_authority(tmp_path, fault):
    app = tmp_path / "app"
    app.mkdir()
    runtime = tmp_path / "runtime"
    scope = _scope(app, runtime)
    binding = {"scope": scope, "receipt_sha256": "a" * 64}
    directory = runtime / "instances" / scope["instanceId"] / "completed-executions"
    directory.mkdir(mode=0o700, parents=True)
    proof = directory / f"{scope['id']}.json"
    value = {"schemaVersion": 1, "scope": json.loads(json.dumps(scope)), "receiptSha256": "a" * 64,
             "verificationBootSession": boot_identity(), "completedAt": "2026-10-27T12:00:00Z"}
    if fault == "wrong_scope":
        value["scope"]["id"] = uuid.uuid4().hex
    elif fault == "wrong_digest":
        value["receiptSha256"] = "b" * 64
    elif fault == "extra_field":
        value["ownershipVerified"] = True
    elif fault == "schema_bool":
        value["schemaVersion"] = True
    elif fault == "nested_schema_bool":
        value["scope"]["schemaVersion"] = True
    elif fault == "bad_boot":
        value["verificationBootSession"] = "not-a-kernel-boot-identity"
    elif fault == "bad_time":
        value["completedAt"] = "not-a-completion-time"
    proof.write_text(json.dumps(value))
    proof.chmod(0o600)
    foreign = tmp_path / "foreign"
    if fault == "linked_proof":
        proof.rename(foreign)
        proof.symlink_to(foreign)
    elif fault == "duplicate_field":
        proof.write_text(proof.read_text().replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1', 1))
    before = proof.read_bytes()
    with pytest.raises(CustodyUnverified):
        verify_native_completion(binding, app)
    assert proof.read_bytes() == before
    if foreign.exists():
        assert foreign.read_bytes() == before


def test_source_has_no_implicit_native_authority(tmp_path, monkeypatch):
    monkeypatch.delenv("JOBCTRL_EXECUTION_SCOPE", raising=False)
    assert capture_native_custody(tmp_path) is None
    with pytest.raises(CustodyUnverified, match="Source-only"):
        verify_native_completion(None, tmp_path)


@pytest.mark.parametrize("scope,runtime", [("../foreign", "/tmp/runtime"), ("a" * 32, "relative-runtime"), ("a" * 32, None)])
def test_environment_hint_alone_cannot_authenticate_scope(tmp_path, monkeypatch, scope, runtime):
    monkeypatch.setenv("JOBCTRL_EXECUTION_SCOPE", scope)
    if runtime is None:
        monkeypatch.delenv("JOBCTRL_RUNTIME_HOME", raising=False)
    else:
        monkeypatch.setenv("JOBCTRL_RUNTIME_HOME", runtime)
    with pytest.raises(CustodyUnverified):
        capture_native_custody(tmp_path)


@pytest.mark.skipif(platform.system() != "Darwin", reason="current native authentication uses macOS kernel coalitions")
def test_private_receipt_must_match_actual_current_kernel_coalition(tmp_path, monkeypatch):
    app = tmp_path / "app"
    app.mkdir()
    runtime = tmp_path / "runtime"
    scope = _scope(app, runtime)
    actual = _current_coalitions()
    scope["coalitionIds"] = [actual[0] + 1, actual[1]]
    directory = runtime / "instances" / scope["instanceId"] / "executions"
    directory.mkdir(mode=0o700, parents=True)
    path = directory / f"{scope['id']}.json"
    path.write_text(json.dumps(scope))
    path.chmod(0o600)
    monkeypatch.setenv("JOBCTRL_EXECUTION_SCOPE", scope["id"])
    monkeypatch.setenv("JOBCTRL_RUNTIME_HOME", str(runtime))
    with pytest.raises(CustodyUnverified, match="kernel process"):
        capture_native_custody(app)
