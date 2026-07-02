"""normalize_job_location parity with the TS normalizeJobLocation.

Cases mirror apps/api/test/location-normalization.test.ts so the two
implementations stay byte-identical (see location_normalization module).
"""

import pytest

from jobhunter.infrastructure.projections.location_normalization import (
    normalize_job_location,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ES (Remote)", "Spain (Remote)"),
        ("En remoto, ES (Remote)", "Spain (Remote)"),
        ("Barcelona, CT, ES (Remote)", "Barcelona, Catalonia, Spain (Remote)"),
        ("Madrid, MD, ES", "Madrid, Community of Madrid, Spain"),
        ("Work from Home - Poland", "Poland (Remote)"),
        ("Work From Home - US", "US (Remote)"),
        ("UK - Remote", "UK (Remote)"),
        ("Remote - Berlin, Germany", "Berlin, Germany (Remote)"),
        ("Berlin, Germany", "Berlin, Germany"),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_job_location_matches_ts(raw: str | None, expected: str) -> None:
    assert normalize_job_location(raw) == expected
