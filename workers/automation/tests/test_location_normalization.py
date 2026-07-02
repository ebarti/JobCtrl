"""normalize_job_location parity with the TS normalizeJobLocation.

Cases are loaded from the SHARED cross-runtime fixture
(packages/domain-types/test/fixtures/audit_projection_parity.json ->
``locationCases``) so this test and the TS test
(apps/api/test/location-normalization.test.ts) assert byte-identical output for
the SAME inputs. The two normalization implementations cannot drift without one
of these tests going red. See the location_normalization module docstrings for
the lockstep contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobhunter.infrastructure.projections.location_normalization import (
    normalize_job_location,
)

_REPO = Path(__file__).resolve().parents[3]
_FIXTURE_PATH = (
    _REPO / "packages" / "domain-types" / "test" / "fixtures" / "audit_projection_parity.json"
)
_LOCATION_CASES = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))["locationCases"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(case["input"], case["expected"]) for case in _LOCATION_CASES],
)
def test_normalize_job_location_matches_shared_fixture(
    raw: str | None, expected: str
) -> None:
    assert normalize_job_location(raw) == expected
