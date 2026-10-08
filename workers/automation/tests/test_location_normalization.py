"""Display preserves canonical source text without interpreting geography."""

from jobctrl.infrastructure.projections.location_normalization import normalize_job_location


def test_source_location_is_preserved_without_interpretation():
    assert normalize_job_location("  Owned source location  ") == "Owned source location"
    assert normalize_job_location(None) == ""
