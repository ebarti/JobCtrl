"""HTTP is an adapter over the explicitly composed Python application."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import ValidationError

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from jobctrl.app.actions import Application
from jobctrl.app.database import SCHEMA_VERSION
from jobctrl.app.errors import AppError, ConflictError
from jobctrl.app.security import LocalSecurity

log = logging.getLogger(__name__)


async def json_object(request: Request) -> dict:
    try:
        value = await request.json()
        json.dumps(value, allow_nan=False)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise AppError("invalid_json", "The request must contain valid JSON.") from None
    if not isinstance(value, dict):
        raise AppError("invalid_json", "The request must contain a JSON object.")
    return value


class FrontendFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except HTTPException as error:
            if error.status_code != 404 or "." in Path(path).name:
                raise
            response = await super().get_response("index.html", scope)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        )
        return response


def create_http_app(application: Application, *, static_dir: Path | None = None, port: int = 8787,
                    credential_service=None) -> Starlette:
    runtime = application.runtime

    def temporal_metadata():
        configured = os.environ.get("JOBCTRL_TEMPORAL_UI_URL", "")
        try:
            parsed = urlsplit(configured)
            valid = (parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username
                     and not parsed.password and not parsed.query and not parsed.fragment)
            parsed.port  # Reject malformed ports before exposing a link.
        except ValueError:
            valid = False
        return {"namespace": os.environ.get("JOBCTRL_TEMPORAL_NAMESPACE", "default"),
                "uiBaseUrl": configured.rstrip("/") if valid else None}

    async def health(request):
        with runtime.database.connect() as connection:
            connection.execute("SELECT 1").fetchone()
        return JSONResponse({
            "ok": True, "application": "jobctrl-python", "schemaVersion": SCHEMA_VERSION,
            "workspaceId": hashlib.sha256(str(runtime.workspace).encode()).hexdigest(),
            "databaseInstanceId": runtime.database.instance_id,
            "features": list(application.features), "worker": application.worker_status(),
            "llmSpend": runtime.model.spend(),
            "temporal": temporal_metadata(),
        })

    async def settings(request):
        if request.method in {"GET", "HEAD"}:
            return JSONResponse(runtime.settings.snapshot())
        value = await json_object(request)
        expected = value.pop("expectedRevision", None)
        if type(expected) is not int:
            raise AppError("expected_revision_required", "A saved settings revision is required.", 428)
        saved = runtime.settings.snapshot()
        if saved["revision"] != expected:
            raise ConflictError()
        proposed = {**saved, **value}
        runtime.settings._validate(proposed)
        if "defaultProvider" in value or "providerModels" in value or "codexReasoningEfforts" in value:
            from jobctrl.app.providers import ProviderService
            service = ProviderService(runtime, credentials=credential_service)
            provider = proposed.get("defaultProvider")
            choices = {(name, model) for name, model in value.get("providerModels", {}).items()
                       if saved["providerModels"].get(name) != model}
            if "defaultProvider" in value or "providerModels" in value:
                choices.add((provider, proposed["providerModels"].get(provider)))
            efforts = {model: effort for model, effort in value.get("codexReasoningEfforts", {}).items()
                       if saved["codexReasoningEfforts"].get(model) != effort}
            choices.update(("codex", model) for model in efforts)
            for selected_provider, model in choices:
                selected = await service.validate_selection(selected_provider, model, capability="structured_json")
                if selected_provider == "codex" and model in efforts:
                    supported = {row["reasoningEffort"] for row in selected.get("supportedReasoningEfforts", [])}
                    if efforts[model] not in supported:
                        raise AppError("model_effort_unsupported", "The selected reasoning effort is unavailable for this model.", 409)
        return JSONResponse(runtime.settings.update(value, expected_revision=expected))

    async def submit(request):
        receipt = await application.submit(request.path_params["action"], await json_object(request),
                                           idempotency_key=request.headers.get("idempotency-key"),
                                           request_id=request.state.request_id)
        return JSONResponse(receipt, status_code=202)

    async def runs(request):
        status = request.query_params.get("status")
        if status is not None and status not in {"pending", "queued", "running", "succeeded", "failed", "cancelled", "start_failed"}:
            raise AppError("invalid_action_status", "Choose a recorded action status.")
        action = request.query_params.get("action")
        if action is not None and len(action) > 160:
            raise AppError("invalid_action", "The action name is too long.")
        return JSONResponse(application.run_page(before=request.query_params.get("before"), limit=page_limit(request),
                                                  status=status, action=action, **date_filters(request)))

    def page_limit(request):
        value = request.query_params.get("limit", "100")
        if not value.isdecimal() or len(value) > 3 or not 1 <= int(value) <= 200:
            raise AppError("invalid_pagination", "Use a page size between 1 and 200.")
        return int(value)

    def date_filters(request):
        dates = {}
        for name in ("since", "until"):
            raw = request.query_params.get(name)
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00")) if raw else None
                if parsed is not None and parsed.tzinfo is None:
                    raise ValueError("timezone")
                dates[name] = parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if parsed else None
            except ValueError:
                raise AppError("invalid_date_filter", "Date filters require a timezone-aware ISO timestamp.") from None
        return dates

    async def event_page(request):
        cursor = request.query_params.get("before")
        if cursor is not None and (not cursor.isdecimal() or len(cursor) > 19 or int(cursor) > 2**63 - 1):
            raise AppError("invalid_event_cursor", "The event cursor must be a nonnegative event ID.")
        level = request.query_params.get("level")
        if level is not None and level not in {"debug", "info", "warn", "error"}:
            raise AppError("invalid_event_level", "Choose a recorded event level.")
        search = request.query_params.get("q", "")
        if len(search) > 500:
            raise AppError("invalid_event_query", "Keep the literal activity search within 500 characters.")
        return JSONResponse(runtime.events.page(
            before=int(cursor) if cursor else None, limit=page_limit(request),
            feature=request.query_params.get("feature"), event_type=request.query_params.get("type"),
            level=level, stage=request.query_params.get("stage"), aggregate_id=request.query_params.get("aggregateId"),
            q=search, **date_filters(request),
        ))

    async def event_detail(request):
        identifier = request.path_params["event_id"]
        if not identifier.isdecimal() or len(identifier) > 19 or not 1 <= int(identifier) <= 2**63 - 1:
            raise AppError("invalid_event_id", "Use a positive activity event ID.")
        return JSONResponse(runtime.events.get(int(identifier)))

    async def run_detail(request):
        return JSONResponse(application.action_run(request.path_params["run_id"]))

    async def run_lookup(request):
        return JSONResponse(application.run_for_idempotency_key(request.query_params.get("action"), request.headers.get("idempotency-key")))

    async def run_summary(request):
        return JSONResponse(application.run_summary())

    async def cancel(request):
        value = await json_object(request)
        if value:
            raise AppError("invalid_cancel_request", "Cancellation accepts an empty object.")
        return JSONResponse(await application.cancel(request.path_params["run_id"]))

    async def stream(request):
        cursor = request.headers.get("last-event-id", request.query_params.get("after", "0"))
        if cursor == "latest" and "last-event-id" not in request.headers:
            cursor = str(runtime.events.latest_id())
        if not cursor.isdecimal() or len(cursor) > 19:
            raise AppError("invalid_event_cursor", "The event cursor must be a nonnegative event ID.")
        after = int(cursor)
        if after > runtime.events.latest_id():
            raise AppError("event_cursor_unavailable", "The event cursor belongs to another workspace state.", 409)
        envelope = request.query_params.get("envelope") == "1"
        if getattr(request.state, "original_method", None) == "HEAD":
            return Response(media_type="text/event-stream", headers={"Cache-Control": "no-store"})

        async def frames():
            nonlocal after
            yield ": connected\n\n"
            heartbeat_at = time.monotonic()
            while not await request.is_disconnected():
                try:
                    rows = runtime.events.since(after)
                except AppError as error:
                    if error.code != "workspace_changed":
                        raise
                    yield "event: workspace_changed\ndata: {\"code\":\"workspace_changed\"}\n\n"
                    return
                for event in rows:
                    after = int(event["eventId"])
                    kind = "message" if envelope else event["type"]
                    yield f"id: {after}\nevent: {kind}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"
                if time.monotonic() - heartbeat_at >= 15:
                    yield ": heartbeat\n\n"
                    heartbeat_at = time.monotonic()
                if len(rows) < 200:
                    await asyncio.sleep(0.25)

        return StreamingResponse(frames(), media_type="text/event-stream", headers={
            "Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive",
        })

    async def missing(request):
        raise AppError("route_not_found", "The API route is not registered.", 404)

    routes = [
        Route("/v1/health", health, methods=["GET"]),
        Route("/v1/settings", settings, methods=["GET", "PATCH"]),
        Route("/v1/events/stream", stream, methods=["GET"]),
        Route("/v1/events", event_page, methods=["GET"]),
        Route("/v1/activity", event_page, methods=["GET"]),
        Route("/v1/activity/{event_id}", event_detail, methods=["GET"]),
        Route("/v1/actions/{action}", submit, methods=["POST"]),
        Route("/v1/action-runs", runs, methods=["GET"]),
        Route("/v1/action-runs/summary", run_summary, methods=["GET"]),
        Route("/v1/action-runs/by-idempotency-key", run_lookup, methods=["GET"]),
        Route("/v1/action-runs/{run_id}", run_detail, methods=["GET"]),
        Route("/v1/action-runs/{run_id}/cancel", cancel, methods=["POST"]),
    ]
    from jobctrl.app.credentials import build_credential_routes
    from jobctrl.app.providers import build_provider_routes
    routes.extend(build_credential_routes(runtime, service=credential_service))
    routes.extend(build_provider_routes(runtime, credential_service=credential_service))
    from jobctrl.runtime_http import build_runtime_routes
    routes.extend(build_runtime_routes(application, credential_service=credential_service))
    from jobctrl.app.telemetry import build_telemetry_routes
    routes.extend(build_telemetry_routes(application))
    if "jobs" in application.services:
        from jobctrl.app.job_queries import build_job_query_routes
        routes.extend(build_job_query_routes(application))
    for feature in application.features.values():
        routes.extend(feature.routes)
    if "jobs" in application.services:
        from jobctrl.extension_transport import build_extension_routes
        routes.extend(build_extension_routes(runtime, application.services["jobs"],
                                            broker=application.extension_broker, application=application))
    signatures = set()
    for route in routes:
        for method in getattr(route, "methods", ()) or ():
            signature = (method, route.path)
            if signature in signatures:
                raise RuntimeError(f"Duplicate public route: {method} {route.path}")
            signatures.add(signature)
    routes.append(Route("/v1/{path:path}", missing, methods=["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]))
    if static_dir is not None:
        static_dir = static_dir.resolve(strict=True)
        if (not (static_dir / "index.html").is_file() or static_dir == runtime.workspace
                or runtime.workspace.is_relative_to(static_dir) or static_dir.is_relative_to(runtime.workspace)):
            raise AppError("invalid_static_directory", "Frontend assets must be a built directory outside the private workspace.", 500)
        routes.append(Mount("/", app=FrontendFiles(directory=static_dir, html=True, follow_symlink=False)))

    async def app_error(request, error: AppError):
        return JSONResponse(error.payload(), status_code=error.status_code)

    async def invalid_input(request, error):
        return JSONResponse(AppError("invalid_request", "The request fields or JSON encoding are invalid.").payload(), status_code=400)

    async def unexpected(request, error):
        # Private exception messages/tracebacks must never become HTTP responses
        # or console logs. The request ID joins content-free operational evidence.
        request_id = getattr(request.state, "request_id", "unknown")
        log.error("Request failed request_id=%s error_type=%s", request_id, type(error).__name__)
        return JSONResponse({"error": {"code": "internal_error", "message": "The request could not be completed.",
                                       "details": {"requestId": request_id}}}, status_code=500)

    @asynccontextmanager
    async def lifespan(app):
        yield
        from jobctrl.app.model_providers import close_provider_runtimes
        await asyncio.to_thread(close_provider_runtimes)

    app = Starlette(routes=routes, middleware=[Middleware(LocalSecurity, workspace=runtime.workspace, port=port,
                                                         database_instance_id=runtime.database.instance_id)],
                    exception_handlers={AppError: app_error, json.JSONDecodeError: invalid_input,
                                        UnicodeDecodeError: invalid_input, ValidationError: invalid_input,
                                        Exception: unexpected}, lifespan=lifespan)
    app.state.application = application
    return app
