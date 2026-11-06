"""Profile HTTP adapters; all business actions use the public service."""

from __future__ import annotations

from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from jobctrl.app.errors import AppError
from jobctrl.app.http import json_object


def routes(service):
    async def profile(request):
        return JSONResponse(service.save(await json_object(request)) if request.method == "PATCH" else service.get())

    async def wording(request):
        return JSONResponse(service.create_variant(await json_object(request)) if request.method == "POST" else service.library())

    async def decision(request):
        return JSONResponse(service.decide_variant(request.path_params["variant_id"], await json_object(request)))

    async def sources(request):
        return JSONResponse(service.add_source(await json_object(request)) if request.method == "POST" else service.list_sources())

    async def confirmation(request):
        return JSONResponse(service.confirm_source(request.path_params["source_id"], await json_object(request)))

    async def imported(request):
        return JSONResponse(await service.import_resume(await json_object(request)))

    async def targets(request):
        return JSONResponse(await service.suggest_target_roles(await json_object(request)))

    async def coaching(request):
        return JSONResponse(await service.coach_required_bullets(await json_object(request)))

    async def preview(request):
        if service.renderer is None:
            raise AppError("renderer_unavailable", "The resume renderer is unavailable.", 503)
        snapshot = service.snapshot()
        format = request.path_params["format"]
        if format not in {"html", "pdf"}:
            raise AppError("invalid_preview_format", "Choose HTML or PDF.")
        if getattr(request.state, "original_method", request.method) == "HEAD":
            return Response(b"", media_type="application/pdf" if format == "pdf" else "text/html",
                            headers={"Cache-Control": "no-store"})
        try:
            result = await service.renderer(snapshot=snapshot, format=format)
        except ValueError as error:
            if getattr(error, "code", None) == "legacy_resume_template_requires_selection":
                raise AppError(error.code, str(error), 422) from None
            raise
        return Response(result, media_type="application/pdf" if format == "pdf" else "text/html",
                        headers={"Cache-Control": "no-store"})

    async def legacy(request):
        return JSONResponse(service.legacy_evidence_review())

    async def legacy_recover(request):
        payload = await json_object(request)
        return JSONResponse(service.recover_legacy_evidence(payload.get("bundle"),
                            expected_profile_version=payload.get("expectedProfileVersion"),
                            authority_unavailable=payload.get("authorityUnavailable", False)))

    async def legacy_decide(request):
        return JSONResponse(service.decide_legacy_evidence(await json_object(request)))

    async def determination(request):
        return JSONResponse(service.determination(request.path_params["determination_id"]))

    return (
        Route("/v1/profile", profile, methods=["GET", "PATCH"]),
        Route("/v1/profile/wording", wording, methods=["GET", "POST"]),
        Route("/v1/profile/wording/{variant_id:path}/decision", decision, methods=["POST"]),
        Route("/v1/profile/sources", sources, methods=["GET", "POST"]),
        Route("/v1/profile/sources/{source_id:path}/confirmation", confirmation, methods=["POST"]),
        Route("/v1/profile/import-resume", imported, methods=["POST"]),
        Route("/v1/profile/target-role-suggestions", targets, methods=["POST"]),
        Route("/v1/profile/required-bullet-suggestions", coaching, methods=["POST"]),
        Route("/v1/profile/preview.{format}", preview, methods=["GET"]),
        Route("/v1/profile/preview/{format}", preview, methods=["GET"]),
        Route("/v1/profile/legacy-evidence", legacy, methods=["GET"]),
        Route("/v1/profile/legacy-evidence/recover", legacy_recover, methods=["POST"]),
        Route("/v1/profile/legacy-evidence/decision", legacy_decide, methods=["POST"]),
        Route("/v1/profile/determinations/{determination_id}", determination, methods=["GET"]),
    )
