"""Shared JSON-RPC fixture against the actual Python parser and registered server."""

from __future__ import annotations

import json

import pytest

from tests.rpc_contract_probe import FIXTURE, build_server, run_probe


def test_shared_cases_execute_through_default_server() -> None:
    fixture = json.loads(FIXTURE.read_text())
    observations = run_probe()["observations"]
    assert set(observations) == {case["name"] for case in fixture["cases"]}
    for case in fixture["cases"]:
        observed = observations[case["name"]]
        assert observed["pythonParsed"] is case["pythonParsed"], case["name"]
        assert len(observed["responses"]) == 1, case["name"]
        response = observed["responses"][0]
        assert response["jsonrpc"] == "2.0", case["name"]
        if case["responseCode"] is None:
            assert "error" not in response and "result" in response, case["name"]
        else:
            assert "result" not in response, case["name"]
            assert response["error"]["code"] == case["responseCode"], case["name"]
    assert observations["falsy_params"]["normalizedParams"] == {}
    assert observations["wrong_version"]["responses"][0]["id"] == 7
    assert observations["boolean_id"]["responses"][0]["id"] is True


def test_default_registration_inventory_and_guard_mutation() -> None:
    server = build_server()
    inventory = {method: spec.mode for method, spec in server._handlers.items()}
    assert len(inventory) == 29
    assert inventory["provider_models"] == "sync"
    assert inventory["run_stage"] == "workflow"

    def assert_inventory(candidate: dict[str, str]) -> None:
        assert candidate == inventory

    del server._handlers["run_stage"]
    with pytest.raises(AssertionError):
        assert_inventory({method: spec.mode for method, spec in server._handlers.items()})
