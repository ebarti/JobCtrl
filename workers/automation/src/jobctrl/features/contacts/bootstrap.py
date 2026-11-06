"""Explicitly compose Contacts without requiring Outreach."""

import os

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.synthetic import synthetic_boundary
from jobctrl.network import default_honest_user_agent, resolve_request_headers

from .fetcher import GatewayContactResearchFetcher
from .http import routes
from .repository import SqliteContactsStore
from .schema import SCHEMA
from .service import ContactsService


def build_feature(runtime: Runtime, *, jobs=None, discovery=None, model=None, fetcher_factory=None, **ports) -> Feature:
    runtime.database.initialize_feature("contacts", SCHEMA)
    if fetcher_factory is None:
        endpoint = os.environ.get("JOBCTRL_E2E_PROVIDER_URL")
        boundary = synthetic_boundary(runtime.workspace, endpoint)
        if boundary:
            from .synthetic_fetcher import ControlledPublicPageFetcher

            def fetcher_factory(policy):
                return ControlledPublicPageFetcher(workspace=runtime.workspace, endpoint=endpoint, policy=policy)
        else:
            def fetcher_factory(policy):
                headers = (resolve_request_headers(discovery.get_crawler_settings()) if discovery is not None
                           else {"User-Agent": default_honest_user_agent().header_value()})
                return GatewayContactResearchFetcher(policy=policy, request_headers=headers)
    service = ContactsService(SqliteContactsStore(runtime.database, runtime.events), jobs=jobs,
                              model=model if model is not None else runtime.model,
                              fetcher_factory=fetcher_factory)

    async def research(context, payload):
        return await service.research(payload, context=context)

    return Feature(name="contacts", service=service, routes=routes(service), actions={"contacts.research": research})
