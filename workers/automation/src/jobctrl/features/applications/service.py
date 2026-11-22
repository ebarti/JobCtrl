"""Application orchestration over explicit atomic storage and external I/O ports."""
from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

from .domain import ApplicationFailure, Batch, MailPort, Rehearse, confirmed_receipt, timestamp
from .ports import ApplicationStore, BrowserInspection, ExecutionClaim, InspectionModel


def is_cancelled(context):
    return bool(context and context.cancelled())


class ApplicationsService:
    def __init__(self, store: ApplicationStore, *, mail: MailPort, rehearsal: BrowserInspection,
                 inspection: InspectionModel, screening, repeat, autofill, feedback):
        self.store, self.mail, self.rehearsal, self.inspection = store, mail, rehearsal, inspection
        self.screening, self.repeat, self.autofill, self.feedback = screening, repeat, autofill, feedback

    def prepare(self, job, command, tenant_id="local"):
        return self.store.prepare(job, command, tenant_id)

    def review(self, job, command, tenant_id="local"):
        return self.store.review(job, command, tenant_id)

    def control(self, job, command, tenant_id="local"):
        return self.store.control(job, command, tenant_id)

    async def rehearse(self, context, command, tenant_id="local"):
        admission = self.store.begin_rehearsal(command.jobId, command.payloadId, context.run_id, tenant_id)
        if admission.result is not None:
            return admission.result
        payload = admission.payload
        if is_cancelled(context):
            raise ApplicationFailure("application_cancelled")
        if payload["mode"] == "email":
            details = {"coverage": "full", "checks": ["exact_email_preview", "accepted_resume_bytes", "source_versions"], "blockedMutationCount": 0}
        else:
            try:
                async with asyncio.timeout(admission.timeout_seconds):
                    details = await self.rehearsal.inspect(payload["applicationUrl"])
                    details["inspection"] = await self.inspection.classify(tenant_id, payload, details, admission.source_fence)
            except TimeoutError:
                raise ApplicationFailure("application_rehearsal_timeout") from None
        if is_cancelled(context):
            raise ApplicationFailure("application_cancelled")
        evidence = {"rehearsalId": context.run_id, "runId": context.run_id, "jobId": command.jobId,
                    "payloadId": payload["payloadId"], "payloadSha256": payload["payloadSha256"],
                    "status": "completed", "coverage": details["coverage"], "checks": details.get("checks", []),
                    "blockedMutationCount": details.get("blockedMutationCount", 0),
                    "inspection": details.get("inspection"), "finishedAt": timestamp()}
        return self.store.complete_rehearsal(payload, evidence, tenant_id)

    async def execute(self, context, command, tenant_id="local"):
        claim = ExecutionClaim(context.run_id, context.cancelled, getattr(context, "automatic", False),
                               getattr(context, "min_fit_override", None))
        admission = self.store.admit_execution(claim, command, tenant_id)
        if admission.result is not None:
            return admission.result
        payload, run = admission.payload, admission.run
        if payload["mode"] == "browser":
            return {"ok": True, "run": run, "manualSubmissionRequired": True,
                    "applicationUrl": payload["applicationUrl"], "fields": payload["fields"],
                    "screeningAnswers": payload["screeningAnswers"], "resume": payload["sources"]["resume"]}
        # The adapter returned this admission only after its own commit. It pins
        # the exact approved attachment bytes; the sender never reopens a path.
        try:
            async with asyncio.timeout(admission.policy["timeoutSeconds"]):
                result = self.mail.send(recipient=payload["recipient"], subject=payload["subject"], body=payload["body"],
                                        attachment_bytes=admission.attachment, attachment_name=payload["attachmentName"])
                if inspect.isawaitable(result):
                    result = await result
            receipt = confirmed_receipt(result)
        except BaseException as error:
            self.store.retain_uncertain_submission(command.jobId, context.run_id, tenant_id)
            if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
            return {"ok": False, "runId": context.run_id, "status": "needs_verification", "failureCode": "application_send_unconfirmed"}
        return self.store.settle_confirmation(context.run_id, payload, receipt, tenant_id)

    async def batch(self, context, command, tenant_id="local"):
        if len({item.jobId for item in command.items}) != len(command.items):
            raise ApplicationFailure("application_batch_duplicate_job")
        concurrency = min(command.workers or 8, self.store.execution_policy()["concurrency"])
        semaphore = asyncio.Semaphore(concurrency)

        async def execute_item(index, item):
            async with semaphore:
                if is_cancelled(context):
                    return {"jobId": item.jobId, "ok": False, "status": "cancelled", "failureCode": "application_cancelled"}
                child = SimpleNamespace(run_id=str(uuid5(NAMESPACE_URL, f"{context.run_id}:{index}:{item.jobId}")),
                    request_id=context.request_id, cancelled=context.cancelled, heartbeat=context.heartbeat,
                    automatic=getattr(context, "automatic", False), min_fit_override=getattr(context, "min_fit_override", None))
                try:
                    result = await self.execute(child, item, tenant_id)
                    return {"jobId": item.jobId, **result}
                except Exception as error:
                    code = getattr(error, "code", None)
                    if not isinstance(code, str) or not code or len(code) > 120 or any(c not in "abcdefghijklmnopqrstuvwxyz_" for c in code):
                        raise
                    self.store.record_refusal(item.jobId, "batch.execute", code, tenant_id)
                    return {"jobId": item.jobId, "ok": False, "status": "refused", "failureCode": code}

        results = await asyncio.gather(*(execute_item(index, item) for index, item in enumerate(command.items)), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                # Drain every admitted peer before reporting an unexpected
                # failure; no child send may outlive the owning batch action.
                raise result
        return {"ok": all(result["ok"] for result in results), "results": results, "effectiveWorkers": concurrency,
                "completedCount": sum(result["ok"] for result in results), "failedCount": sum(not result["ok"] for result in results)}

    async def run_approved(self, context, command, tenant_id="local"):
        items = self.store.select_approved(command, tenant_id)
        if not items:
            return {"ok": True, "results": [], "completedCount": 0, "failedCount": 0}
        if command.dry_run:
            results = []
            for index, item in enumerate(items):
                child = SimpleNamespace(run_id=str(uuid5(NAMESPACE_URL, f"{context.run_id}:rehearsal:{index}:{item.jobId}")),
                    request_id=context.request_id, cancelled=context.cancelled, heartbeat=context.heartbeat)
                results.append({"jobId": item.jobId, **await self.rehearse(child, Rehearse(jobId=item.jobId, payloadId=item.payloadId), tenant_id)})
            return {"ok": True, "results": results, "completedCount": len(results), "failedCount": 0}
        automatic_context = SimpleNamespace(run_id=context.run_id, request_id=context.request_id,
            cancelled=context.cancelled, heartbeat=context.heartbeat, automatic=not command.url,
            min_fit_override=command.min_fit_score)
        return await self.batch(automatic_context, Batch(items=items, workers=command.workers), tenant_id)

    def read(self, job, tenant_id="local"):
        return self.store.read(job, tenant_id)

    def read_apply_review(self, tenant_id="local"):
        return self.store.read_apply_review(tenant_id)

    def summary(self, tenant_id="local", at=None):
        return self.store.summary(tenant_id, at)

    def confirmed_anchors(self, tenant_id="local"):
        return self.store.confirmed_anchors(tenant_id)

    def job_summaries(self, job_ids, connection=None, tenant_id="local"):
        return self.store.job_summaries(job_ids, connection=connection, tenant_id=tenant_id)

    def list_outcomes(self, job_id=None, tenant_id="local"):
        return self.store.list_outcomes(job_id, tenant_id)

    def record_outcome(self, job_id, payload, tenant_id="local", connection=None):
        return self.store.record_outcome(job_id, payload, tenant_id=tenant_id, connection=connection)

    def ensure_offer_milestone(self, job_id, connection=None, tenant_id="local"):
        return self.store.ensure_offer_milestone(job_id, connection=connection, tenant_id=tenant_id)

    def outreach_context(self, job_id, connection=None, tenant_id="local"):
        return self.store.outreach_context(job_id, connection=connection, tenant_id=tenant_id)

    def delete_job_data(self, job_id, connection=None, tenant_id="local"):
        return self.store.delete_job_data(job_id, connection=connection, tenant_id=tenant_id)

    def set_action_reader(self, reader):
        return self.store.set_action_reader(reader)
