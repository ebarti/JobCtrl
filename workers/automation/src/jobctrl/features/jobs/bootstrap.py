"""Explicit Jobs composition and transport adapter."""

from __future__ import annotations

import os

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.http import json_object
from jobctrl.app.contracts import Feature
from jobctrl.app.errors import AppError
from jobctrl.features.jobs.adapters.acquisition import SourceBoundPostingAcquirer
from jobctrl.features.jobs.adapters.role_analysis import SourceBoundRoleAnalysis
from jobctrl.features.jobs.repository import SqliteJobsRepository
from jobctrl.features.jobs.schema import SCHEMA
from jobctrl.features.jobs.service import JobsService


def build_feature(runtime, **ports):
    runtime.database.initialize_feature("jobs", SCHEMA)
    repository = SqliteJobsRepository(runtime.database, runtime.events)
    fetcher = ports.get("posting_fetcher")
    if os.environ.get("JOBCTRL_POSTING_PROVIDER_ENDPOINT"):
        from jobctrl.features.jobs.adapters.http_posting import HttpPostingFetcher

        fetcher = HttpPostingFetcher(runtime.workspace, os.environ["JOBCTRL_POSTING_PROVIDER_ENDPOINT"])
    service = JobsService(
        repository, SourceBoundPostingAcquirer(runtime.model, fetcher=fetcher), SourceBoundRoleAnalysis(runtime.model)
    )

    async def index(request):
        if request.method == "POST":
            return JSONResponse(service.capture(await json_object(request)), status_code=201)
        filters = dict(request.query_params)
        for key in ("include_deleted", "include_hidden"):
            if key in filters:
                filters[key] = filters[key].lower() == "true"
        if filters.get("deleted") == "deleted":
            filters["status"] = "deleted"
        return JSONResponse(service.list_jobs(filters))

    async def capture(request):
        body = await json_object(request)
        return JSONResponse(
            service.capture(body, expected_revision=body.get("expectedRevision"), receipt_key=body.get("captureId")),
            status_code=201,
        )

    async def import_url(request):
        return JSONResponse(await service.capture_external(await json_object(request)), status_code=201)

    async def detail(request):
        job_id = request.path_params["job_id"]
        if request.method == "PATCH":
            return JSONResponse(service.update(job_id, await json_object(request)))
        if request.method == "DELETE":
            return JSONResponse(service.set_visibility([job_id], "delete"))
        return JSONResponse(service.get_job(job_id))

    async def history(request):
        return JSONResponse(service.history(request.path_params["job_id"]))

    async def refresh(request):
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        return JSONResponse(
            await service.refresh(
                request.path_params["job_id"],
                expected_revision=body.get("expectedRevision"),
                receipt_key=body.get("operationId"),
            )
        )

    async def analysis(request):
        if request.method != "POST":
            return JSONResponse(service.get_analysis(request.path_params["job_id"]))
        body = await json_object(request)
        return JSONResponse(
            await service.analyze(
                request.path_params["job_id"],
                expected_revision=body.get("expectedRevision"),
                models=body.get("models"),
                force=body.get("force") is True,
                operation_id=body.get("operationId"),
            )
        )

    async def availability(request):
        if request.method != "POST":
            return JSONResponse(service.get_availability(request.path_params["job_id"]))
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        return JSONResponse(
            await service.check_availability(
                request.path_params["job_id"],
                expected_revision=body.get("expectedRevision"),
                receipt_key=body.get("operationId"),
            )
        )

    async def visibility(request):
        action = request.url.path.rsplit("/", 1)[-1]
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        return JSONResponse(
            service.set_visibility(
                [request.path_params["job_id"]],
                action,
                expected_revision=body.get("expectedRevision"),
                expected_state_revision=body.get("expectedStateRevision"),
                selection_id=body.get("selectionId"),
            )
        )

    async def delete_selection(request):
        body = await json_object(request)
        ids = body.get("jobIds", body.get("jobKeys"))
        return JSONResponse(service.create_delete_selection(ids, body.get("query") or body.get("filters")))

    async def bulk(request):
        body = await json_object(request)
        ids = body.get("jobIds", body.get("jobKeys", []))
        if not isinstance(ids, list) or len(ids) > 1000 or not all(isinstance(i, str) for i in ids):
            raise AppError("invalid_job_selection", "Select at most 1,000 saved jobs.")
        selected_action = request.url.path.rsplit("/", 1)[-1].removeprefix("bulk-")
        action = {"delete-permanent": "permanent-delete"}.get(selected_action, selected_action)
        return JSONResponse(
            service.set_visibility(
                ids,
                action,
                selection_id=body.get("selectionId"),
                expected_revisions=body.get("expectedRevisions"),
                expected_state_revisions=body.get("expectedStateRevisions"),
            )
        )

    async def quarantine(request):
        return JSONResponse({"entries": repository.list_quarantine()})

    async def quarantine_decision(request):
        body = await json_object(request)
        return JSONResponse(repository.decide_quarantine(request.path_params["quarantine_id"], body.get("decision")))

    async def capture_action(context, payload):
        return await service.capture_external(payload, cancelled=context.cancelled)

    async def refresh_action(context, payload):
        job_id = payload.get("job_id") or payload.get("jobId") or payload.get("jobKey")
        if not job_id:
            raise AppError("job_id_required", "Select a saved job to refresh.")
        receipt_key = payload.get("operationId") or context.run_id
        expected = payload.get("expectedRevision")
        if expected is None:
            accepted = service.read_capture_receipt(receipt_key)
            if accepted is not None:
                if accepted["job_id"] != job_id:
                    raise AppError("capture_replay_mismatch", "The operation belongs to another saved job.", 409)
                return accepted
            expected = service.get_job(job_id)["revision"]
        return await service.refresh(
            job_id, expected_revision=expected, receipt_key=receipt_key, cancelled=context.cancelled
        )

    async def analyze_action(context, payload):
        return await service.analyze(
            payload.get("job_id") or payload.get("jobId"),
            expected_revision=payload.get("expectedRevision"),
            models=payload.get("models"),
            force=payload.get("force") is True,
            cancelled=context.cancelled,
            operation_id=payload.get("operationId") or context.run_id,
        )

    async def availability_action(context, payload):
        return await service.check_availability(
            payload.get("job_id") or payload.get("jobId"),
            expected_revision=payload.get("expectedRevision"),
            receipt_key=payload.get("operationId") or context.run_id,
            cancelled=context.cancelled,
        )

    routes = (
        Route("/v1/jobs", index, methods=["GET", "POST"]),
        Route("/v1/jobs/reviewable-list", index, methods=["GET"]),
        Route("/v1/jobs/capture", capture, methods=["POST"]),
        Route("/v1/jobs/import-url", import_url, methods=["POST"]),
        Route("/v1/jobs/permanent-delete-selection", delete_selection, methods=["POST"]),
        *(
            Route("/v1/jobs/bulk-" + action, bulk, methods=["POST"])
            for action in ("delete", "restore", "hide", "unhide", "delete-permanent")
        ),
        Route("/v1/jobs/quarantine", quarantine, methods=["GET"]),
        Route("/v1/jobs/quarantine/{quarantine_id}/decision", quarantine_decision, methods=["POST"]),
        Route("/v1/jobs/{job_id}/snapshots", history, methods=["GET"]),
        Route("/v1/jobs/{job_id}/refresh", refresh, methods=["POST"]),
        Route("/v1/jobs/{job_id}/analysis", analysis, methods=["GET", "POST"]),
        Route("/v1/jobs/{job_id}/availability", availability, methods=["GET", "POST"]),
        Route("/v1/jobs/{job_id}/actions/check-availability", availability, methods=["POST"]),
        *(
            Route("/v1/jobs/{job_id}/" + action, visibility, methods=["POST"])
            for action in ("hide", "unhide", "delete", "restore", "permanent-delete")
        ),
        Route("/v1/jobs/{job_id}", detail, methods=["GET", "PATCH", "DELETE"]),
    )
    return Feature(
        name="jobs",
        service=service,
        routes=routes,
        actions={
            "jobs.capture_url": capture_action,
            "jobs.refresh": refresh_action,
            "jobs.analyze": analyze_action,
            "jobs.check_availability": availability_action,
        },
    )
