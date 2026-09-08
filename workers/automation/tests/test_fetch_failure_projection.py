"""Shared privacy and validation examples for both projection writers."""

import json
from pathlib import Path

import pytest

from jobctrl.infrastructure.projections.fetch_failure import fetch_failure_from_stage_metadata

_CASES = json.loads((Path(__file__).resolve().parents[3] / "packages/domain-types/test/fixtures/public_fetch_failure.json").read_text())


@pytest.mark.parametrize("case", _CASES, ids=lambda case: case["name"])
def test_public_fetch_failure_projection(case):
    result = fetch_failure_from_stage_metadata(json.dumps(case["metadata"]))
    assert result == case["expected"]
    assert "must-not-project" not in json.dumps(result)


@pytest.mark.parametrize("value", [None, "{", "null", "[]"])
def test_malformed_metadata(value):
    assert fetch_failure_from_stage_metadata(value) is None
