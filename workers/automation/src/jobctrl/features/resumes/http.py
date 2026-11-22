"""HTTP adapters for the same public Resumes application actions used by workers."""

from __future__ import annotations

from functools import wraps
import inspect

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from jobctrl.app.errors import AppError

from . import locales
from .domain import ResumeError


def boundary(handler):
    @wraps(handler)
    async def guarded(request):
        try:
            return await handler(request)
        except ResumeError as exc:
            status = 404 if exc.code.endswith("not_found") else 409 if (
                "conflict" in exc.code or "changed" in exc.code
            ) else 422
            raise AppError(exc.code, str(exc), status, details=exc.details) from None
        except (KeyError, TypeError, ValueError):
            raise AppError("invalid_resume_request", "The resume request is structurally invalid.", 422) from None
    return guarded


async def payload(request):
    value = await request.json()
    if not isinstance(value, dict):
        raise ResumeError("invalid_resume_request")
    return value


def routes(service):
    @boundary
    async def index(request):
        if request.method == "POST":
            result = await run_in_threadpool(service.compose, **await payload(request))
            return JSONResponse({"ok": True, "resume": result}, status_code=201)
        return JSONResponse({"ok": True, "resumes": await run_in_threadpool(
            service.list, request.query_params.get("jobId", request.query_params.get("job_id")))})

    @boundary
    async def detail(request):
        return JSONResponse({"ok": True, "resume": await run_in_threadpool(service.get, request.path_params["resume_id"])})

    def mutation(method):
        @boundary
        async def endpoint(request):
            kwargs = await payload(request)
            if inspect.iscoroutinefunction(method):
                result = await method(request.path_params["resume_id"], **kwargs)
            else:
                result = await run_in_threadpool(method, request.path_params["resume_id"], **kwargs)
            return JSONResponse({"ok": True, "resume": result})
        return endpoint

    @boundary
    async def export(request):
        data, content_type, extension = await run_in_threadpool(
            service.export, request.path_params["resume_id"], format=request.query_params.get("format", "pdf"),
            accepted=request.query_params.get("accepted", "false") == "true",
            revision_id=request.query_params.get("revision_id"),
            artifact_id=request.query_params.get("artifact_id"),
        )
        return Response(data, media_type=content_type, headers={"Cache-Control": "no-store",
                        "Content-Disposition": f'inline; filename="resume{extension}"'})

    @boundary
    async def locale_list(request):
        state = await run_in_threadpool(service.get, request.path_params["resume_id"])
        return JSONResponse({"ok": True, "locales": state["locales"], "supportedLocales": list(locales.SUPPORTED_LOCALES)})

    @boundary
    async def open_artifact(request):
        if await payload(request):
            raise ResumeError("artifact_open_accepts_only_registered_ids")
        return JSONResponse(await run_in_threadpool(service.open_artifact, request.path_params["resume_id"],
                                                    request.path_params["artifact_id"]))

    @boundary
    async def locale_generate(request):
        result = await locales.generate(service, request.path_params["resume_id"], **await payload(request))
        return JSONResponse({"ok": True, "resume": result})

    @boundary
    async def locale_review(request):
        result = await locales.review(service, request.path_params["resume_id"], request.path_params["locale_id"],
                                      **await payload(request))
        return JSONResponse({"ok": True, "resume": result})

    @boundary
    async def locale_accept(request):
        result = await run_in_threadpool(locales.accept, service, request.path_params["resume_id"],
                                         request.path_params["locale_id"], **await payload(request))
        return JSONResponse({"ok": True, "resume": result})

    @boundary
    async def locale_export(request):
        data, content_type, extension = await run_in_threadpool(
            locales.export, service, request.path_params["resume_id"], request.path_params["locale_id"],
            format=request.query_params.get("format", "pdf"))
        return Response(data, media_type=content_type, headers={"Cache-Control": "no-store",
                        "Content-Disposition": f'attachment; filename="resume-locale{extension}"'})

    @boundary
    async def templates(request):
        if request.method == "POST":
            return JSONResponse(await run_in_threadpool(service.templates.save, await payload(request)))
        return JSONResponse(await run_in_threadpool(service.templates.list))

    @boundary
    async def template_detail(request):
        return JSONResponse(await run_in_threadpool(service.templates.detail, request.path_params["template_id"]))

    @boundary
    async def template_default(request):
        return JSONResponse(await run_in_threadpool(service.templates.select_default, await payload(request)))

    @boundary
    async def retire(request):
        value = await payload(request)
        if set(value) != {"job_ids"}:
            raise ResumeError("invalid_retirement_selection")
        return JSONResponse(await run_in_threadpool(service.cleanup_retired_artifacts, value["job_ids"]))

    return (
        Route("/v1/resumes", index, methods=["GET", "POST"]),
        Route("/v1/resume-templates", templates, methods=["GET", "POST"]),
        Route("/v1/resume-templates/default", template_default, methods=["POST", "PATCH"]),
        Route("/v1/resume-templates/{template_id:path}", template_detail, methods=["GET"]),
        Route("/v1/resume-artifact-retirements/cleanup", retire, methods=["POST"]),
        Route("/v1/resumes/{resume_id}", detail, methods=["GET"]),
        Route("/v1/resumes/{resume_id}/edit", mutation(service.edit), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/approve-edits", mutation(service.approve_edits), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/review", mutation(service.review), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/render", mutation(service.render), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/accept", mutation(service.accept), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/comments", mutation(service.comment), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/template", mutation(service.assign_template), methods=["POST"]),
        Route("/v1/resumes/{resume_id}/export", export, methods=["GET"]),
        Route("/v1/resumes/{resume_id}/artifacts/{artifact_id}/open", open_artifact, methods=["POST"]),
        Route("/v1/resumes/{resume_id}/locales", locale_list, methods=["GET"]),
        Route("/v1/resumes/{resume_id}/locales/generate", locale_generate, methods=["POST"]),
        Route("/v1/resumes/{resume_id}/locales/{locale_id}/review", locale_review, methods=["POST"]),
        Route("/v1/resumes/{resume_id}/locales/{locale_id}/accept", locale_accept, methods=["POST"]),
        Route("/v1/resumes/{resume_id}/locales/{locale_id}/export", locale_export, methods=["GET"]),
    )
