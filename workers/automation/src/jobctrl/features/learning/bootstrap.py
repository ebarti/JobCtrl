"""Explicit Learning feature composition and HTTP adapter."""

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.contracts import Feature
from jobctrl.app.http import json_object
from jobctrl.features.learning.schema import REQUEST_SCHEMA, SCHEMA
from jobctrl.features.learning.repository import SqliteLearningRepository
from jobctrl.features.learning.service import LearningService


def build_feature(runtime, *, profile, jobs, **_ports):
    runtime.database.initialize_feature("learning", SCHEMA)
    runtime.database.initialize_feature("learning_requests", REQUEST_SCHEMA)
    service = LearningService(SqliteLearningRepository(runtime.database, runtime.events, runtime.workspace),
                              model=runtime.model, profile=profile, jobs=jobs)

    async def read(_request):
        return JSONResponse(await service.execute())

    async def write(request):
        return JSONResponse(await service.execute(await json_object(request), idempotency_key=request.headers.get("idempotency-key")))

    async def status(request):
        return JSONResponse(service.request_status(request.headers.get("idempotency-key")))

    return Feature(name="learning", service=service, routes=(Route("/v1/evidence-map/learning/request-status", status, methods=["GET"]),
                   Route("/v1/evidence-map/learning", read, methods=["GET"]),
                   Route("/v1/evidence-map/learning", write, methods=["POST"])))
