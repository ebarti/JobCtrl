"""Explicit Outreach composition over public immutable owner snapshots."""

from jobctrl.app.contracts import Feature, Runtime

from .http import routes
from .repository import SqliteOutreachStore
from .schema import SCHEMA
from .service import OutreachService


def build_feature(runtime: Runtime, *, contacts, profile, jobs=None, offers=None, compensation=None, applications=None, model=None, **ports) -> Feature:
    runtime.database.initialize_feature("outreach", SCHEMA)
    service = OutreachService(SqliteOutreachStore(runtime.database, runtime.events), contacts=contacts, profile=profile,
                             jobs=jobs, offers=offers, compensation=compensation, applications=applications,
                             model=model if model is not None else runtime.model)

    async def generate(context, payload):
        request = dict(payload)
        identifier = request.pop("contactId")
        return await service.generate(identifier, request, context=context)

    async def revise(context, payload):
        request = dict(payload)
        identifier = request.pop("threadId")
        return await service.revise(identifier, request, context=context)

    return Feature(name="outreach", service=service, routes=routes(service),
                   actions={"outreach.generate": generate, "outreach.revise": revise})
