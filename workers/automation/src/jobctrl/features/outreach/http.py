"""HTTP adapters for messages. There is deliberately no send endpoint."""

from __future__ import annotations

import json

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .domain import InvalidOutreach, OutreachMissing, StaleOutreach


async def _body(request) -> dict:
    raw = await request.body()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise AppError("invalid_json", "The request body must contain a JSON object.") from None
    if not isinstance(value, dict):
        raise AppError("invalid_input", "The request body must be an object.")
    return value


def routes(service) -> tuple:
    def endpoint(handler):
        async def wrapped(request):
            try:
                return await handler(request)
            except InvalidOutreach as error:
                raise AppError("invalid_outreach", str(error)) from None
            except StaleOutreach as error:
                raise ConflictError(str(error), **error.details) from None
            except OutreachMissing as error:
                raise NotFoundError(str(error)) from None
        return wrapped

    async def thread_for_contact(request):
        return JSONResponse({"ok": True, "thread": service.thread_for_contact(request.path_params["contact_id"], request.query_params.get("jobId"))})

    async def thread_detail(request):
        return JSONResponse({"ok": True, "thread": service.get_thread(request.path_params["thread_id"])})

    async def determinations(request):
        return JSONResponse(service.determinations(request.path_params["thread_id"], request.path_params["draft_id"]))

    async def generate(request):
        return JSONResponse(await service.generate(request.path_params["contact_id"], await _body(request)))

    async def revise(request):
        return JSONResponse(await service.revise(request.path_params["thread_id"], await _body(request)))

    async def review(request):
        return JSONResponse(service.review(request.path_params["thread_id"], request.path_params["draft_id"], await _body(request),
                                           approve=request.url.path.endswith("/approve")))

    async def copy(request):
        return JSONResponse(service.copy_draft(request.path_params["thread_id"], request.path_params["draft_id"], await _body(request)))

    async def log_send(request):
        return JSONResponse(service.log_send(request.path_params["thread_id"], await _body(request)))

    async def follow_up(request):
        return JSONResponse(service.follow_up(request.path_params["thread_id"], await _body(request), action=request.path_params["action"]))

    async def due(request):
        return JSONResponse({"ok": True, "followUps": service.due_follow_ups()})

    return (
        Route("/v1/contacts/{contact_id}/outreach", endpoint(thread_for_contact), methods=["GET"]),
        Route("/v1/contacts/{contact_id}/outreach/drafts", endpoint(generate), methods=["POST"]),
        Route("/v1/outreach/follow-ups/due", endpoint(due), methods=["GET"]),
        Route("/v1/outreach/threads/{thread_id}", endpoint(thread_detail), methods=["GET"]),
        Route("/v1/outreach/threads/{thread_id}/drafts", endpoint(revise), methods=["POST"]),
        Route("/v1/outreach/threads/{thread_id}/drafts/{draft_id}/determinations", endpoint(determinations), methods=["GET"]),
        Route("/v1/outreach/threads/{thread_id}/drafts/{draft_id}/approve", endpoint(review), methods=["POST"]),
        Route("/v1/outreach/threads/{thread_id}/drafts/{draft_id}/reject", endpoint(review), methods=["POST"]),
        Route("/v1/outreach/threads/{thread_id}/drafts/{draft_id}/copy", endpoint(copy), methods=["POST"]),
        Route("/v1/outreach/threads/{thread_id}/send-logs", endpoint(log_send), methods=["POST"]),
        Route("/v1/outreach/threads/{thread_id}/follow-up/{action}", endpoint(follow_up), methods=["POST"]),
    )
