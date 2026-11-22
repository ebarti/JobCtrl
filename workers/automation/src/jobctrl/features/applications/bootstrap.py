"""Explicit Applications composition, with no legacy runtime entry point."""

from pydantic import ValidationError

from jobctrl.app.contracts import Feature, Runtime
from jobctrl.app.errors import AppError

from .autofill import AutofillService
from .application_store import SqliteApplicationStore
from .browser import BrowserRehearsal
from .domain import ApplicationFailure, ApprovedBatch, Batch, Execute, Prepare, Rehearse
from .feedback import FeedbackService
from .feedback_repository import SqliteFeedbackRepository
from .http import routes
from .inspection import ApplicationInspection
from .mail import MailAdapter
from .repository import ApplicationRepository
from .repeat import RepeatApplicationService
from .repeat_store import SqliteRepeatStore
from .schema import SCHEMA
from .screening import ScreeningCommand, ScreeningService
from .screening_store import SqliteScreeningStore
from .semantic import ApplicationModel
from .service import ApplicationsService
from .sources import ApplicationSources


def build_feature(runtime: Runtime, *, profile, jobs, resumes, fit=None) -> Feature:
    runtime.database.initialize_feature("applications", SCHEMA)
    repository = ApplicationRepository(runtime)
    sources = ApplicationSources(profile=profile, jobs=jobs, resumes=resumes)
    model = ApplicationModel(runtime.model, repository)
    mail = MailAdapter(runtime)
    feedback = FeedbackService(SqliteFeedbackRepository(runtime), jobs=jobs, profile=profile, mail=mail, model=runtime.model)
    screening = ScreeningService(SqliteScreeningStore(repository, sources), model)
    autofill = AutofillService(repository, sources, model)
    inspection = ApplicationInspection(repository, sources, model)
    repeat = RepeatApplicationService(SqliteRepeatStore(repository, sources, feedback), model)
    store = SqliteApplicationStore(repository, sources, screening=screening.store, repeat=repeat.store,
                                   inspection=inspection, feedback=feedback, validate_mail=mail.validate_payload, fit=fit)
    service = ApplicationsService(store, mail=mail, rehearsal=BrowserRehearsal(runtime), inspection=inspection,
                                  feedback=feedback, screening=screening, repeat=repeat, autofill=autofill)
    feedback.set_confirmed_anchors(service.confirmed_anchors)

    def action(function, schema):
        async def dispatch(context, payload):
            try:
                return await function(context, schema.model_validate(payload))
            except ValidationError:
                raise AppError("invalid_application_command", "The application command is invalid.") from None
            except ApplicationFailure as error:
                raise AppError(error.code, "The application action was refused; inspect its recorded history.",
                               409 if error.conflict else 400) from None
        return dispatch

    async def scan(context, payload):
        return await feedback.scan(payload, cancelled=context.cancelled, heartbeat=context.heartbeat)

    async def prepare(context, payload):
        value = dict(payload)
        job = value.pop("jobId", None)
        if not isinstance(job, str) or not job:
            raise AppError("invalid_application_command", "A job ID is required.")
        try:
            return service.prepare(job, Prepare.model_validate(value))
        except ValidationError:
            raise AppError("invalid_application_command", "The application command is invalid.") from None
        except ApplicationFailure as error:
            raise AppError(error.code, "The application action was refused; inspect its recorded history.",
                           409 if error.conflict else 400) from None

    async def screening_action(context, payload):
        if set(payload) != {"jobId", "command"} or not isinstance(payload["jobId"], str):
            raise AppError("invalid_application_command", "A job and screening command are required.")
        try:
            return await screening.execute("local", payload["jobId"], ScreeningCommand.model_validate(payload["command"]))
        except ValidationError:
            raise AppError("invalid_application_command", "The screening command is invalid.") from None
        except ApplicationFailure as error:
            raise AppError(error.code, "The screening command was refused; previous accepted answers remain available.",
                           409 if error.conflict else 400) from None

    async def repeat_check(context, payload):
        if set(payload) != {"jobId"} or not isinstance(payload["jobId"], str):
            raise AppError("invalid_application_command", "A job ID is required.")
        try:
            return await service.repeat.check(payload["jobId"])
        except ApplicationFailure as error:
            raise AppError(error.code, "The repeat-application assessment was refused.", 409) from None

    return Feature(name="applications", service=service, routes=routes(service, screening, autofill, feedback),
                   actions={"applications.execute": action(service.execute, Execute),
                            "applications.batch": action(service.batch, Batch),
                            "applications.run_approved": action(service.run_approved, ApprovedBatch),
                            "applications.rehearse": action(service.rehearse, Rehearse),
                            "applications.prepare": prepare,
                            "applications.repeat_check": repeat_check,
                            "applications.screening": screening_action,
                            "applications.gmail_scan": scan})
