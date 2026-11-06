"""Explicit Interviews feature composition and public HTTP routes."""

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.contracts import Feature
from jobctrl.app.http import json_object
from jobctrl.features.interviews.schema import RUN_SCHEMA, SCHEMA
from jobctrl.features.interviews.repository import SqliteInterviewRepository
from jobctrl.features.interviews.service import InterviewService


def build_feature(runtime, *, profile, jobs, requirements=None, fit=None, resumes=None, **_ports):
    runtime.database.initialize_feature("interviews", SCHEMA)
    runtime.database.initialize_feature("interviews_runs", RUN_SCHEMA)
    service = InterviewService(SqliteInterviewRepository(runtime.database, runtime.events, runtime.workspace),
                               model=runtime.model, profile=profile, jobs=jobs, requirements=requirements, fit=fit, resumes=resumes)

    async def catalog(request):
        return JSONResponse(service.catalog(dict(request.query_params)))

    async def question(request):
        return JSONResponse(service.question(request.path_params["questionId"]))

    async def history(request):
        return JSONResponse(service.history(request.path_params["jobId"], dict(request.query_params)))

    async def latest(request):
        return JSONResponse(service.latest(request.path_params["jobId"]))

    async def provenance(request):
        return JSONResponse(service.provenance(request.path_params["jobId"], request.path_params["generation"]))

    async def notes(request):
        return JSONResponse(service.notes(request.path_params["jobId"], dict(request.query_params)))

    async def save_note(request):
        return JSONResponse(service.save_note(request.path_params["jobId"], await json_object(request)))

    async def submit(request):
        body = await json_object(request) if await request.body() else {}
        payload = service.validate_generation(request.path_params["jobId"], body)
        receipt = await request.app.state.application.submit("interviews.generate", payload,
                    idempotency_key=request.headers.get("idempotency-key"), request_id=request.state.request_id)
        return JSONResponse(receipt, status_code=202)

    routes = (Route("/v1/interviews/catalog", catalog, methods=["GET"]),
              Route("/v1/interviews/questions/{questionId}", question, methods=["GET"]),
              Route("/v1/jobs/{jobId}/interview-prep", latest, methods=["GET"]),
              Route("/v1/jobs/{jobId}/interview-prep/history", history, methods=["GET"]),
              Route("/v1/jobs/{jobId}/interview-prep/{generation:int}/provenance", provenance, methods=["GET"]),
              Route("/v1/jobs/{jobId}/interview-notes", notes, methods=["GET"]),
              Route("/v1/jobs/{jobId}/interview-notes", save_note, methods=["POST"]),
              Route("/v1/jobs/{jobId}/actions/generate-interview-prep", submit, methods=["POST"]))
    return Feature(name="interviews", service=service, routes=routes, actions={"interviews.generate": service.generate})
