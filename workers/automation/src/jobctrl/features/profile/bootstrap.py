"""Explicit Profile composition, without Fit or Requirements dependencies."""

from jobctrl.app.contracts import Feature, Runtime
from .http import routes
from .repository import ProfileRepository
from .schema import SCHEMA
from .service import ProfileService
from .pdf_import import ResumeImportAdapter


def build_feature(runtime: Runtime, **ports) -> Feature:
    runtime.database.initialize_feature("profile", SCHEMA)
    service = ProfileService(ProfileRepository(runtime), model=ports.get("model", runtime.model), renderer=ports.get("renderer"))
    service.imports = ResumeImportAdapter(service)

    async def author(context, payload):
        if context.cancelled():
            from jobctrl.app.errors import AppError
            raise AppError("action_cancelled", "Profile authoring was cancelled.", 409)
        context.heartbeat({"stage": "profile_authoring"})
        return await service.request_authoring(payload, cancelled=context.cancelled,
            expected_approved_variants=payload.get("expected_approved_variants"),
            retry_of_proposal_id=payload.get("retry_of_proposal_id"))

    async def coach(context, payload):
        context.heartbeat({"stage": "profile_coaching"})
        return await service.coach_required_bullets(payload)

    async def imported(context, payload):
        context.heartbeat({"stage": "profile_import"})
        return await service.import_resume(payload, operation_id=context.run_id, cancelled=context.cancelled)

    return Feature(name="profile", service=service, routes=routes(service), actions={
        "profile.author_wording": author, "profile.coach_required_bullets": coach, "profile.import_resume": imported,
    })
