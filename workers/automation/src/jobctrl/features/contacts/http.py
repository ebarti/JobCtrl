"""The Contacts HTTP adapter; every mutation calls the canonical service."""

from __future__ import annotations

import json
from uuid import NAMESPACE_URL, uuid5

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError, ConflictError, NotFoundError

from .domain import InvalidContact, StaleContact
from .domain import new_id
from .service import ContactMissing


async def body(request) -> dict:
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
            except InvalidContact as error:
                raise AppError("invalid_contact", str(error)) from None
            except StaleContact as error:
                raise ConflictError(str(error)) from None
            except ContactMissing as error:
                raise NotFoundError(str(error)) from None
        return wrapped

    async def collection(request):
        if request.method in {"GET", "HEAD"}:
            items = service.list_contacts(employer=request.query_params.get("employer"), job_id=request.query_params.get("jobId"))
            return JSONResponse({"ok": True, "items": items})
        return JSONResponse({"ok": True, "contact": service.create(await body(request))}, status_code=201)

    async def individual(request):
        identifier = request.path_params["contact_id"]
        if request.method in {"GET", "HEAD"}:
            return JSONResponse({"ok": True, "contact": service.get_contact(identifier)})
        if request.method == "PATCH":
            return JSONResponse({"ok": True, "contact": service.update(identifier, await body(request))})
        return JSONResponse(service.delete(identifier, await body(request)))

    async def import_contacts(request):
        return JSONResponse(service.import_contacts(await body(request)))

    async def research(request):
        if request.method in {"GET", "HEAD"}:
            return JSONResponse({"ok": True, "items": service.list_research(employer=request.query_params.get("employer"), job_id=request.query_params.get("jobId"))})
        payload = await body(request)
        if set(payload) - {"employer", "jobId", "sources", "llmModel", "requestId"}:
            raise InvalidContact("The research request contains unsupported fields.")
        service.validate_research(payload)
        application = request.app.state.application
        header_identity = request.headers.get("idempotency-key")
        if header_identity is not None and (not header_identity.strip() or len(header_identity) > 180):
            raise InvalidContact("Research idempotency keys must contain 1 to 180 characters.")
        if payload.get("requestId") and header_identity and payload["requestId"] != header_identity:
            raise InvalidContact("The research request carries conflicting retry identities.")
        identity = payload.get("requestId") or header_identity
        task_id = str(uuid5(NAMESPACE_URL, f"{application.runtime.workspace}:contacts.research:{identity}")) if identity else new_id()
        submitted = {**payload, "taskId": task_id}
        receipt = await application.submit("contacts.research", submitted,
                                           idempotency_key="contacts.research:" + identity if identity else None,
                                           request_id=request.state.request_id)
        service.queue_research(submitted)
        return JSONResponse({"ok": True, "taskId": task_id, **receipt}, status_code=202)

    async def research_detail(request):
        return JSONResponse({"ok": True, "task": service.get_research(request.path_params["task_id"])})

    async def determinations(request):
        return JSONResponse(service.research_determinations(request.path_params["task_id"]))

    async def confirm(request):
        return JSONResponse(service.confirm_candidate(request.path_params["task_id"], request.path_params["candidate_id"], await body(request)))

    # Literal routes precede the contact-id route, which otherwise captures
    # "research" or "import" as a contact identity in Starlette.
    return (
        Route("/v1/contacts", endpoint(collection), methods=["GET", "POST"]),
        Route("/v1/contacts/import", endpoint(import_contacts), methods=["POST"]),
        Route("/v1/contacts/research", endpoint(research), methods=["GET", "POST"]),
        Route("/v1/contacts/research/{task_id}", endpoint(research_detail), methods=["GET"]),
        Route("/v1/contacts/research/{task_id}/determinations", endpoint(determinations), methods=["GET"]),
        Route("/v1/contacts/research/{task_id}/candidates/{candidate_id}/confirm", endpoint(confirm), methods=["POST"]),
        Route("/v1/contacts/{contact_id}", endpoint(individual), methods=["GET", "PATCH", "DELETE"]),
    )
