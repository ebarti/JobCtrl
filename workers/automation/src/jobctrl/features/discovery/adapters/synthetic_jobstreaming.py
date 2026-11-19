"""Owned loopback transports for real pinned-SDK integration journeys.

Only transport addresses/authentication are configured. SDK request construction,
parsing, events, limits, cancellation and checkpoint implementation remain real.
"""

import os

from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary


def controlled_registry(workspace):
    endpoint = os.environ.get("JOBCTRL_JOBSTREAMING_PROVIDER_ENDPOINT")
    if not endpoint:
        return None
    owner = synthetic_boundary(workspace, endpoint)
    if owner is None:
        raise AppError("synthetic_boundary_unowned", "The SDK transport requires an owned synthetic workspace.", 503)
    from jobstreaming import AdapterRegistry
    from jobstreaming.indeed import Indeed
    from jobstreaming.ziprecruiter import ZipRecruiter

    access = os.environ.get("JOBCTRL_E2E_BOARD_ACCESS")

    def indeed(**kwargs):
        adapter = Indeed(api_key=owner["token"], **kwargs)
        adapter.api_url = endpoint + "/indeed"
        if access == "jobstreaming-indeed-missing":
            adapter.api_key = None
        if access == "jobstreaming-tls-failure":
            # Negotiate TLS with the same owned plaintext listener. Requests
            # raises a real SSL error before any HTTP data can be exchanged.
            adapter.api_url = "https://" + adapter.api_url.removeprefix("http://")
        adapter.session.headers.update({"Authorization": "Bearer " + owner["token"]})
        adapter.session.max_redirects = 0
        return adapter

    def zip_recruiter(**kwargs):
        authorized = access == "jobstreaming-indeed-missing"
        adapter = ZipRecruiter(authorization="Bearer " + owner["token"] if authorized else None, **kwargs)
        # Normally leave this board unconfigured to exercise the SDK refusal.
        # All SDK origins are still confined even if its request order changes.
        if not authorized:
            adapter.authorization = None
        adapter.base_url = endpoint + "/ziprecruiter"
        adapter.api_url = endpoint + "/ziprecruiter"
        return adapter

    registry = AdapterRegistry()
    registry.register("indeed", indeed)
    registry.register("zip_recruiter", zip_recruiter)
    return registry
