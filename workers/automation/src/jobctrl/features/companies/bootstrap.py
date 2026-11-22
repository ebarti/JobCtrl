"""Explicit optional Companies composition and read/action adapters."""

from __future__ import annotations

from datetime import datetime, timezone
from functools import partial
import os

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.contracts import Feature
from jobctrl.app.errors import AppError
from jobctrl.features.companies.acquisition import PublicPageAcquirer
from jobctrl.features.companies.fetcher import company_briefing_fetcher, synthetic_company_briefing_fetcher
from jobctrl.features.companies.locking import CompanyRefreshLocks
from jobctrl.features.companies.repository import SqliteCompanyHistory
from jobctrl.features.companies.schema import SCHEMA
from jobctrl.features.companies.service import CompaniesService


class _LifecycleService(CompaniesService):
    """Adapts Jobs' deletion transaction to the application-owned lifecycle port."""

    def __init__(self, history, *args, **kwargs):
        super().__init__(history, *args, **kwargs)
        self._deletion_history = history

    def delete_job_data(self, job_id, connection=None):
        with self._deletion_history.deletion(connection) as unit:
            self.remove_job_links(job_id, unit)


def build_feature(runtime, *, jobs=None, discovery=None, **ports):
    if jobs is None:
        raise RuntimeError("Companies requires the public Jobs service")
    runtime.database.initialize_feature("companies", SCHEMA)
    options = {"fetcher_factory": ports["company_fetcher_factory"]} if "company_fetcher_factory" in ports else {}
    if "JOBCTRL_E2E_COMPANY_PAGE_URL" in os.environ:
        from jobctrl.app.synthetic import synthetic_boundary

        endpoint = os.environ["JOBCTRL_E2E_COMPANY_PAGE_URL"]
        if not endpoint or synthetic_boundary(runtime.workspace, endpoint) is None:
            raise AppError("synthetic_boundary_unowned", "Synthetic providers require an owned E2E workspace.", 503)
        options["fetcher_factory"] = partial(synthetic_company_briefing_fetcher, workspace=runtime.workspace, endpoint=endpoint)
    history = SqliteCompanyHistory(runtime.database, jobs, runtime.model, runtime.events)
    pages = PublicPageAcquirer(discovery=discovery, fetcher_factory=options.get("fetcher_factory", company_briefing_fetcher))
    service = _LifecycleService(history, runtime.model, pages, CompanyRefreshLocks(runtime.workspace),
                               clock=lambda: datetime.now(timezone.utc).isoformat())

    async def show(request):
        return JSONResponse(service.read(request.path_params["job_id"]))

    async def refresh(context, payload):
        job_id = payload.get("job_id") or payload.get("jobId")
        if not isinstance(job_id, str) or not job_id:
            raise AppError("invalid_job_id", "A saved job ID is required.")
        return await service.refresh(job_id, allow_public_fetch=payload.get("allow_public_fetch") is True,
                                     force=payload.get("force") is True, cancelled=context.cancelled)

    return Feature(name="companies", service=service,
                   routes=(Route("/v1/jobs/{job_id}/company-briefing", show, methods=["GET"]),),
                   actions={"companies.refresh": refresh})
