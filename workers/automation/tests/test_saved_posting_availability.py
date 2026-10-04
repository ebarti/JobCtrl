"""Source-bound saved-posting observation regressions (synthetic employer data)."""
from dataclasses import replace

import pytest

from jobctrl.domain.enrichment.snapshot_services import ActiveStateVerifier
from jobctrl.domain.enrichment.value_objects import DetailPage

URL = "https://careers.example.org/jobs/role-123"


def active_page(**kwargs):
    return DetailPage(url=URL, final_url=URL, status=200, html='<main><div class="job-description">'
                      'Our historical launch applications are closed.</div><button>Apply</button></main>',
                      page_title="Synthetic role", json_ld=({"@type": "JobPosting", "url": URL,
                      "description": "Our historical launch applications are closed."},), **kwargs)


def test_historical_description_does_not_prove_current_closure():
    assert ActiveStateVerifier().verify(active_page())[0].value == "active"
    assert ActiveStateVerifier().verify(replace(active_page(), html='<div role="alert">Applications are closed</div>'))[0].value == "closed"


@pytest.mark.parametrize("status", [403, 429, 500, 502, 503])
def test_error_body_cannot_prove_active(status):
    assert ActiveStateVerifier().verify(replace(active_page(), status=status))[0].value == "unknown"


@pytest.mark.parametrize("changes", [
    {"html": '<form><input type="password"></form>'},
    {"final_url": "https://careers.example.org/jobs"},
    {"json_ld": ({"@type": "JobPosting", "url": URL, "description": "Role", "validThrough": "broken"},)},
    {"json_ld": ({"@type": "JobPosting", "url": URL, "description": "Role", "validThrough": "2999-01-01"},)},
    {"json_ld": ({"@type": "JobPosting", "url": URL + "-other", "description": "Role"},)},
])
def test_access_identity_and_date_failures_are_unknown(changes):
    assert ActiveStateVerifier().verify(replace(active_page(), **changes))[0].value == "unknown"


def test_future_deadline_cannot_mask_current_closed_banner():
    page = replace(active_page(), html='<div role="alert">Applications are closed</div>',
                   json_ld=({"@type": "JobPosting", "url": URL, "description": "Role",
                             "validThrough": "2999-01-01T00:00:00Z"},))
    assert ActiveStateVerifier().verify(page)[1] == "conflicting_signals"


def test_empty_and_unbound_pages_are_unknown():
    for page in [DetailPage(url=URL, status=200, html="error"), DetailPage(url="https://example.org", status=404)]:
        assert ActiveStateVerifier().verify(page)[0].value == "unknown"
