"""Feature-owned HTTP adapters; business actions are shared with durable dispatch."""

from __future__ import annotations

from functools import wraps

from pydantic import ValidationError
from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError

from .autofill import FormSnapshot
from .domain import ApplicationFailure, Prepare, Review, Stop
from .screening import ScreeningCommand
from .repeat import RepeatOverride


def public_error(function):
    @wraps(function)
    async def guarded(request):
        try:
            return await function(request)
        except ValidationError:
            raise AppError("invalid_application_command", "The application command is invalid.") from None
        except ApplicationFailure as error:
            raise AppError(error.code, "The application action was refused; inspect current inputs and recorded history.",
                           409 if error.conflict else 400) from None
        except (ValueError, TypeError):
            raise AppError("invalid_application_command", "The application command is invalid.") from None
    return guarded


def routes(service, screening, autofill, feedback):
    @public_error
    async def read(request):
        return JSONResponse(service.read(request.path_params["job_id"]))

    @public_error
    async def prepare(request):
        return JSONResponse(service.prepare(request.path_params["job_id"], Prepare.model_validate(await request.json())), status_code=201)

    @public_error
    async def review(request):
        return JSONResponse(service.review(request.path_params["job_id"], Review.model_validate(await request.json())))

    @public_error
    async def control(request):
        return JSONResponse(service.control(request.path_params["job_id"], Stop.model_validate(await request.json())))

    @public_error
    async def queue(request):
        return JSONResponse(service.read_apply_review())

    @public_error
    async def summary(request):
        return JSONResponse(service.summary(at=request.query_params.get("at")))

    @public_error
    async def screening_read(request):
        return JSONResponse(screening.read("local", request.path_params["job_id"]))

    @public_error
    async def screening_command(request):
        command = ScreeningCommand.model_validate(await request.json())
        return JSONResponse(await screening.execute("local", request.path_params["job_id"], command))

    @public_error
    async def autofill_profile(request):
        return JSONResponse(autofill.profile())

    @public_error
    async def autofill_mapping(request):
        return JSONResponse(await autofill.map(FormSnapshot.model_validate(await request.json())))

    @public_error
    async def outcomes(request):
        return JSONResponse(feedback.list_outcomes(job_id=request.path_params.get("job_id")))

    @public_error
    async def outcome_record(request):
        return JSONResponse(feedback.record_outcome(request.path_params["job_id"], await request.json()), status_code=201)

    @public_error
    async def suggestion_decision(request):
        return JSONResponse(feedback.decide_suggestion(request.path_params["suggestion_id"], await request.json()))

    @public_error
    async def suggestion_audit(request):
        return JSONResponse(feedback.suggestion_audit(request.path_params["suggestion_id"]))

    @public_error
    async def evidence(request):
        return JSONResponse(feedback.list_evidence(request.path_params["job_id"]))

    @public_error
    async def scan(request):
        result = await feedback.scan(await request.json())
        return JSONResponse(result, status_code=feedback.scan_status(result))

    @public_error
    async def analytics(request):
        return JSONResponse(feedback.analytics())

    @public_error
    async def audit(request):
        application = service.read(request.path_params["job_id"])["application"]
        # Audit is allow-listed metadata. Exact private payloads/notes remain in
        # the dedicated local review and outcome reads.
        return JSONResponse({"ok": True, "jobId": application["jobId"], "status": application["status"],
                             "stopped": application["stopped"], "intent": application["intent"],
                             "receipt": application["receipt"], "runs": application["runs"],
                             "decisions": [{k: d.get(k) for k in ("decisionId", "decision", "decidedAt", "payloadId", "rehearsalId")} for d in application["decisions"]]})

    @public_error
    async def repeat_read(request):
        return JSONResponse(service.repeat.read(request.path_params["job_id"]))

    @public_error
    async def repeat_override(request):
        return JSONResponse(service.repeat.override(request.path_params["job_id"], RepeatOverride.model_validate(await request.json())))

    return (
        Route("/v1/jobs/{job_id}/application", read, methods=["GET"]),
        Route("/v1/jobs/{job_id}/application/preparation", prepare, methods=["POST"]),
        Route("/v1/jobs/{job_id}/application/control", control, methods=["POST"]),
        Route("/v1/jobs/{job_id}/apply-review", review, methods=["POST"]),
        Route("/v1/jobs/{job_id}/apply-audit", audit, methods=["GET"]),
        Route("/v1/jobs/{job_id}/repeat-application", repeat_read, methods=["GET"]),
        Route("/v1/jobs/{job_id}/repeat-application/override", repeat_override, methods=["POST"]),
        Route("/v1/apply/review", queue, methods=["GET"]),
        Route("/v1/applications/summary", summary, methods=["GET"]),
        Route("/v1/jobs/{job_id}/screening-answers", screening_read, methods=["GET"]),
        Route("/v1/jobs/{job_id}/screening-answers", screening_command, methods=["POST"]),
        Route("/v1/extension/autofill/profile", autofill_profile, methods=["GET"]),
        Route("/v1/extension/autofill/mapping", autofill_mapping, methods=["POST"]),
        Route("/v1/outcomes", outcomes, methods=["GET"]),
        Route("/v1/jobs/{job_id}/outcomes", outcomes, methods=["GET"]),
        Route("/v1/jobs/{job_id}/outcomes", outcome_record, methods=["POST"]),
        Route("/v1/jobs/{job_id}/application-email-evidence", evidence, methods=["GET"]),
        Route("/v1/outcomes/suggestions/{suggestion_id}/decision", suggestion_decision, methods=["POST"]),
        Route("/v1/outcomes/suggestions/{suggestion_id}/audit", suggestion_audit, methods=["GET"]),
        Route("/v1/outcomes/gmail/scan", scan, methods=["POST"]),
        Route("/v1/analytics/outcomes", analytics, methods=["GET"]),
    )
