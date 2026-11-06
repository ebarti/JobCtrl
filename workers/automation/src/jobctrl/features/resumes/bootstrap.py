"""Explicit Resumes adapter construction; no alternate legacy business writer."""

from __future__ import annotations

from asyncio import to_thread
import os

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError
from jobctrl.app.synthetic import synthetic_boundary

from . import locales
from .domain import ResumeError
from .http import routes
from .renderer import ResumeRenderer
from .repository import SqliteResumeRepository
from .schema import SCHEMA
from .service import ResumesService
from .templates import Templates
from .opener import ArtifactOpener


def build_feature(runtime: Runtime, **ports) -> Feature:
    for name in ("profile", "fit", "requirements"):
        if ports.get(name) is None:
            raise RuntimeError(f"Resumes requires the public {name} service.")
    runtime.database.initialize_feature("resumes", SCHEMA)
    repository = SqliteResumeRepository(runtime)
    renderer = ports.get("renderer") or ResumeRenderer(
        runtime.workspace, browser_executable=os.environ.get("JOBCTRL_CHROMIUM_EXECUTABLE"),
        file_intent=repository.record_file_intent, file_abandon=repository.abandon_file_intent)
    opener_executable = os.environ.get("JOBCTRL_ARTIFACT_OPEN_EXECUTABLE")
    if opener_executable and synthetic_boundary(runtime.workspace) is None:
        raise AppError("artifact_open_override_unowned", "The external test opener requires an owned synthetic workspace.", 503)
    service = ResumesService(repository=repository, profile=ports["profile"], fit=ports["fit"],
                             requirements=ports["requirements"], model=ports.get("model", runtime.model),
                             settings=runtime.settings, jobs=ports.get("jobs"),
                             renderer=renderer, templates=Templates(repository, renderer),
                             artifact_opener=ports.get("artifact_opener") or ArtifactOpener(
                                 opener_executable))
    service.recover_orphaned_files()

    def action(method, *, asynchronous=False):
        async def execute(context, payload):
            if context.cancelled():
                raise AppError("action_cancelled", "The resume action was cancelled.", 409)
            context.heartbeat({"feature": "resumes"})
            try:
                payload = dict(payload)
                if method.__name__ in {"compose", "render", "review"}:
                    payload.setdefault("operation_id", context.run_id)
                    if method.__name__ != "review":
                        payload["cancelled"] = context.cancelled
                result = await method(**payload) if asynchronous else await to_thread(method, **payload)
                return {"ok": True, "resume": result}
            except ResumeError as exc:
                raise AppError(exc.code, str(exc), 409 if "conflict" in exc.code else 422) from None
        return execute

    async def locale_generate(**payload):
        return await locales.generate(service, **payload)

    async def locale_review(**payload):
        return await locales.review(service, **payload)

    return Feature(name="resumes", service=service, routes=routes(service), actions={
        "resumes.compose": action(service.compose), "resumes.render": action(service.render),
        "resumes.review": action(service.review, asynchronous=True),
        "resumes.locale_generate": action(locale_generate, asynchronous=True),
        "resumes.locale_review": action(locale_review, asynchronous=True),
    })
