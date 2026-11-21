"""Explicit Discovery feature composition, controls and durable public actions."""

from __future__ import annotations

from uuid import uuid4

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.http import json_object
from jobctrl.app.contracts import ActionContext, Feature
from jobctrl.features.discovery.domain import now
from jobctrl.features.discovery.repository import DiscoveryRepository
from jobctrl.features.discovery.schema import SCHEMA
from jobctrl.features.discovery.service import DiscoveryService
from jobctrl.features.discovery.adapters.execution import DiscoveryExecutionAdapter
from jobctrl.features.discovery.adapters.jobstreaming import supported_boards


def build_feature(runtime, *, jobs, profile=None):
    runtime.database.initialize_feature("discovery", SCHEMA)
    repository = DiscoveryRepository(runtime.database, runtime.events, runtime.settings, boards=supported_boards())
    repository.seed_boards()
    execution = DiscoveryExecutionAdapter(repository, jobs=jobs, workspace=runtime.workspace)
    service = DiscoveryService(
        repository,
        jobs=jobs,
        model=runtime.model,
        profile=profile,
        execution=execution,
    )
    execution.bind_admission(service._admit)

    async def settings(request):
        return JSONResponse(
            service.save_settings(await json_object(request)) if request.method == "PATCH" else service.get_settings()
        )

    async def targets(request):
        if request.method != "POST":
            return JSONResponse(service.targets.read())
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        return JSONResponse(
            await service.targets.refresh(
                force=body.get("force", True),
                operation_id=body.get("operationId") or request.headers.get("idempotency-key"),
                expected_profile_revision=body.get("expectedProfileVersion"),
            )
        )

    async def sources(request):
        return JSONResponse(service.list_sources())

    async def state(request):
        return JSONResponse(service.patch_source_state(request.path_params["source_id"], await json_object(request)))

    async def preview(request):
        return JSONResponse(service.preview_source(request.path_params["source_id"]))

    async def captures(request):
        return JSONResponse(repository.captures())

    async def capture_action(request):
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        action, item_id = request.url.path.rsplit("/", 1)[-1], request.path_params["item_id"]
        if action == "import":
            return JSONResponse(await service.import_capture(item_id, body))
        result = repository.transition_capture(
            item_id, action, lifecycle_id=body.get("expectedLifecycleId") or body.get("lifecycleId")
        )
        if action == "prepare":
            result.update({"captureMode": "current_page", "originatingUrl": result["originatingUrl"]})
        return JSONResponse(result)

    async def quarantine(request):
        entries = []
        for row in jobs.list_quarantine():
            posting = row["posting"]
            entries.append(
                {
                    "jobId": row["job_id"] or row["quarantine_id"],
                    "jobKey": row["quarantine_id"],
                    "quarantineId": row["quarantine_id"],
                    "title": posting.get("title", ""),
                    "company": posting.get("company", ""),
                    "sourceId": posting.get("source_id", ""),
                    "postingUrl": posting.get("url"),
                    "reason": row["reason"],
                    "confidence": None,
                    "snapshotVersion": row["expected_revision"],
                    "capturedAt": row["created_at"],
                    "noticeText": None,
                }
            )
        return JSONResponse({"ok": True, "entries": entries})

    async def quarantine_decision(request):
        body = await json_object(request)
        result = jobs.decide_quarantine(request.path_params["quarantine_id"], body.get("decision"))
        return JSONResponse({**result, "jobKey": request.path_params["quarantine_id"], "recordedAt": now()})

    async def feedback(request):
        return JSONResponse(service.record_feedback(await json_object(request)))

    async def feedback_proposals(request):
        return JSONResponse(repository.feedback_proposals())

    async def feedback_refresh(request):
        body = await json_object(request) if request.headers.get("content-length", "0") != "0" else {}
        return JSONResponse(
            await service.generate_feedback_proposals(
                operation_id=body.get("operationId") or request.headers.get("idempotency-key"), request=body
            )
        )

    async def feedback_decision(request):
        body = await json_object(request)
        return JSONResponse(
            repository.decide_feedback(
                request.path_params["suggestion_id"], body.get("decision"), reason=body.get("reason")
            )
        )

    async def runs(request):
        return JSONResponse(repository.runs())

    async def cancel(request):
        return JSONResponse(repository.cancel(request.path_params["run_id"]))

    async def role_target_review(request):
        read_only = request.method in {"GET", "HEAD"}
        body = {} if read_only else await json_object(request)
        return JSONResponse(await service.review_role_target(
            request.path_params["run_id"], request.path_params["job_id"],
            expected_revision=body.get("expectedPostingRevision"), read_only=read_only,
        ))

    async def search(request):
        body = await json_object(request)
        return JSONResponse(await service.search(ActionContext(run_id=str(uuid4()), request_id=str(uuid4())), body, durable=False))

    async def search_action(context, payload):
        return {**await service.search(context, payload), "preparationAvailable": False}

    async def targets_action(context, payload):
        return await service.targets.refresh(
            force=payload.get("force", True),
            operation_id=context.run_id,
            expected_profile_revision=payload.get("expectedProfileVersion"),
        )

    async def feedback_action(context, payload):
        return await service.generate_feedback_proposals(operation_id=context.run_id, request=payload)

    routes = (
        Route("/v1/discovery/settings", settings, methods=["GET", "PATCH"]),
        Route("/v1/discovery/target-search", targets, methods=["GET", "POST"]),
        Route("/v1/discovery/sources", sources, methods=["GET"]),
        Route("/v1/discovery/sources/{source_id}/state", state, methods=["PATCH"]),
        Route("/v1/discovery/sources/{source_id}/preview", preview, methods=["GET", "POST"]),
        Route("/v1/discovery/manual-capture", captures, methods=["GET"]),
        *(
            Route("/v1/discovery/manual-capture/{item_id}/" + action, capture_action, methods=["POST"])
            for action in ("prepare", "import", "supersede", "dismiss")
        ),
        Route("/v1/discovery/quarantine", quarantine, methods=["GET"]),
        Route("/v1/discovery/quarantine/{quarantine_id}/decision", quarantine_decision, methods=["POST"]),
        Route("/v1/discovery/feedback", feedback, methods=["POST"]),
        Route("/v1/discovery/role-match-feedback", feedback_proposals, methods=["GET"]),
        Route("/v1/discovery/role-match-feedback/refresh", feedback_refresh, methods=["POST"]),
        Route("/v1/discovery/role-match-feedback/{suggestion_id}/decision", feedback_decision, methods=["POST"]),
        Route("/v1/discovery/runs", runs, methods=["GET"]),
        Route("/v1/discovery/runs/{run_id}/cancel", cancel, methods=["POST"]),
        Route("/v1/discovery/runs/{run_id}/jobs/{job_id}/role-target", role_target_review, methods=["GET", "POST"]),
        Route("/v1/discovery/search", search, methods=["POST"]),
    )
    return Feature(
        "discovery",
        service,
        routes,
        {
            "discovery.search": search_action,
            "discovery.refresh_targets": targets_action,
            "discovery.refresh_feedback": feedback_action,
        },
        # Admission is atomic before planning or acquisition starts. Separate
        # tabs, schedules and clients share one active search per workspace.
        action_scopes={"discovery.search": lambda _payload: "workspace"},
    )
