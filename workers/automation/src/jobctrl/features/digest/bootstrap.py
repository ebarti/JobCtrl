"""Explicit Digest feature composition and public HTTP routes."""

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.contracts import Feature
from jobctrl.app.errors import AppError
from jobctrl.app.http import json_object
from jobctrl.features.digest.schema import SCHEMA
from jobctrl.features.digest.repository import SqliteDigestRepository
from jobctrl.features.digest.service import DigestService


def build_feature(runtime, *, jobs, fit=None, discovery=None, applications=None, resumes=None, companies=None, **_ports):
    runtime.database.initialize_feature("digest", SCHEMA)
    service = DigestService(SqliteDigestRepository(runtime.database, runtime.events), model=runtime.model,
                            settings=runtime.settings, jobs=jobs, fit=fit, discovery=discovery,
                            applications=applications, resumes=resumes, companies=companies)

    async def read(request):
        values = request.query_params.getlist("minFitScore")
        if len(values) > 1 or values and values[0] not in {str(value) for value in range(11)}:
            raise AppError("invalid_min_fit_score", "The minimum fit score must be an integer from 0 to 10.")
        return JSONResponse(service.build(min_fit_score=int(values[0]) if values else None))

    async def acknowledge(request):
        body = await json_object(request) if await request.body() else {}
        if not isinstance(body, dict) or set(body) - {"acknowledgedAt"}:
            raise AppError("invalid_digest_acknowledgement", "The digest acknowledgement is invalid.")
        return JSONResponse(service.acknowledge(body.get("acknowledgedAt")))

    return Feature(name="digest", service=service, routes=(Route("/v1/digest", read, methods=["GET"]),
                   Route("/v1/digest/acknowledge", acknowledge, methods=["POST"])))
