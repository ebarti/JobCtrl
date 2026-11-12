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

    def indeed(**kwargs):
        adapter = Indeed(api_key=owner["token"], **kwargs)
        adapter.api_url = endpoint + "/indeed"
        adapter.session.headers.update({"Authorization": "Bearer " + owner["token"]})
        adapter.session.max_redirects = 0
        return adapter

    def zip_recruiter(**kwargs):
        adapter = ZipRecruiter(**kwargs)
        # Deliberately absent authentication exercises the real SDK refusal.
        # All SDK origins are still confined even if its request order changes.
        adapter.authorization = None
        adapter.base_url = endpoint + "/ziprecruiter"
        adapter.api_url = endpoint + "/ziprecruiter"
        return adapter

    registry = AdapterRegistry()
    registry.register("indeed", indeed)
    registry.register("zip_recruiter", zip_recruiter)
    return registry
