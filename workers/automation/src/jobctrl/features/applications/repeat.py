"""Separate confirmed facts from model-assessed repeat risk and one-use consent."""

from __future__ import annotations

from typing import Literal
from uuid import uuid4

from pydantic import Field, StrictStr

from .domain import ApplicationFailure, Command, copied, digest, timestamp
from .repeat_ports import RepeatSession, RepeatStore
from .semantic import Citation, validate_citations
from .serialization import encode


class RepeatJudgment(Command):
    status: Literal["clear", "same_employer_equivalent_role", "uncertain"]
    matchedJobIds: list[StrictStr] = Field(max_length=50)
    citations: list[Citation] = Field(min_length=1, max_length=100)
    rationale: StrictStr = Field(min_length=1, max_length=2000)


class RepeatOverride(Command):
    idempotencyKey: StrictStr = Field(min_length=1, max_length=160)
    expectedCheckId: StrictStr = Field(min_length=1, max_length=240)
    evidenceSha256: StrictStr = Field(min_length=64, max_length=64)
    reason: StrictStr = Field(min_length=1, max_length=4000)


class RepeatApplicationService:
    def __init__(self, store: RepeatStore, model):
        self.store, self.model = store, model
        self.store.set_handlers(self._read, self._guard)

    def _evidence(self, session: RepeatSession, job, tenant="local"):
        current = session.job_snapshot(job)
        # Confirmed facts alone form this ledger. Suggestions, dry runs and
        # other outcome kinds never manufacture a prior application.
        prior = session.confirmed_applications(tenant)
        records = []
        by_job = {}
        for fact in prior:
            by_job.setdefault(fact["jobId"], []).append(fact)
        for prior_job, facts in sorted(by_job.items()):
            posting = session.job_snapshot(prior_job)
            records.append({"jobId": prior_job, "posting": self._posting(posting),
                            "outcomes": [{k: fact.get(k) for k in ("outcomeId", "jobId", "kind", "occurredAt", "recordedAt", "submissionIntentId")} for fact in facts]})
        evidence = {"current": self._posting(current), "confirmedApplications": records}
        return copied(evidence), digest(evidence)

    @staticmethod
    def _posting(value):
        return {k: value.get(k) for k in ("job_id", "revision", "source_hash", "source_id", "company", "title", "url", "application_url", "description", "text")}

    def read(self, job, tenant_id="local"):
        with self.store.read() as session:
            return self._read(session, tenant_id, job)

    def _read(self, session: RepeatSession, tenant_id, job):
        evidence, fingerprint = self._evidence(session, job, tenant_id)
        if any(item["jobId"] == job for item in evidence["confirmedApplications"]):
            return {"ok": True, "jobId": job, "status": "same_opening", "evidenceSha256": fingerprint,
                    "checkId": None, "matchedApplications": [job], "override": None, "blockReason": "application_already_confirmed"}
        if not evidence["confirmedApplications"]:
            return {"ok": True, "jobId": job, "status": "clear", "evidenceSha256": fingerprint,
                    "checkId": None, "matchedApplications": [], "override": None, "blockReason": None}
        value = session.check(tenant_id, job, fingerprint)
        if value is None:
            return {"ok": True, "jobId": job, "status": "check_required", "evidenceSha256": fingerprint,
                    "checkId": None, "matchedApplications": [], "override": None, "blockReason": "application_repeat_check_required"}
        ids = value.get("determinationIds", [])
        batches = [evidence["confirmedApplications"][offset:offset + 50] for offset in range(0, len(evidence["confirmedApplications"]), 50)]
        if len(ids) != len(batches) or len(set(ids)) != len(ids):
            raise ApplicationFailure("application_repeat_authority_missing")
        judgments = []
        for index, (ident, batch) in enumerate(zip(ids, batches)):
            record = session.determination(tenant_id, ident)
            expected_sources = [{"source_id": "current", "text": encode(evidence["current"])}]
            expected_sources.extend({"source_id": "application:" + item["jobId"], "text": encode(item)} for item in batch)
            if (record["entityId"] != job or record["operation"] != "applications.repeat_check"
                    or record["bindingSha256"] != digest({"evidenceSha256": fingerprint, "batch": index, "batchCount": len(batches)})
                    or record["sources"] != expected_sources):
                raise ApplicationFailure("application_repeat_authority_invalid")
            judged = RepeatJudgment.model_validate(record["result"])
            validate_citations(judged.citations, record["sources"], {"current", *("application:" + item for item in judged.matchedJobIds)})
            judgments.append(judged)
        status = "uncertain" if any(item.status == "uncertain" for item in judgments) else "same_employer_equivalent_role" if any(item.status == "same_employer_equivalent_role" for item in judgments) else "clear"
        matches = sorted({ident for judgment in judgments for ident in judgment.matchedJobIds})
        if value["status"] != status or value["matchedApplications"] != matches:
            raise ApplicationFailure("application_repeat_authority_invalid")
        override = session.override(tenant_id, job, value["checkId"], fingerprint)
        value["override"] = override
        value["ok"] = True
        value["blockReason"] = None if value["status"] == "clear" or (override and not override["usedByRunId"]) else "application_repeat_risk_requires_review"
        return value

    async def check(self, job, tenant_id="local"):
        with self.model.budget_scope():
            return await self._check(job, tenant_id)

    async def _check(self, job, tenant_id="local"):
        with self.store.read() as session:
            evidence, fingerprint = self._evidence(session, job, tenant_id)
        if not evidence["confirmedApplications"] or any(item["jobId"] == job for item in evidence["confirmedApplications"]):
            return self.read(job, tenant_id)
        batches = [evidence["confirmedApplications"][offset:offset + 50] for offset in range(0, len(evidence["confirmedApplications"]), 50)]
        decisions, ids = [], []
        for index, batch in enumerate(batches):
            sources = [{"source_id": "current", "text": encode(evidence["current"])}]
            sources.extend({"source_id": "application:" + item["jobId"], "text": encode(item)} for item in batch)
            allowed = {item["jobId"] for item in batch}

            def fence(session: RepeatSession):
                _, current_hash = self._evidence(session, job, tenant_id)
                if current_hash != fingerprint:
                    raise ApplicationFailure("application_repeat_evidence_changed", conflict=True)

            def validate(result):
                if len(set(result.matchedJobIds)) != len(result.matchedJobIds) or set(result.matchedJobIds) - allowed:
                    raise ApplicationFailure("application_repeat_foreign_history")
                if (result.status == "same_employer_equivalent_role") != bool(result.matchedJobIds):
                    raise ApplicationFailure("application_repeat_invalid_verdict")
                cited = {citation.source_id for citation in result.citations}
                if "current" not in cited or not {"application:" + ident for ident in result.matchedJobIds} <= cited:
                    raise ApplicationFailure("application_repeat_missing_citation")

            decision, ident = await self.model.determine(tenant=tenant_id, entity=job,
                operation="applications.repeat_check", schema=RepeatJudgment, sources=sources,
                binding={"evidenceSha256": fingerprint, "batch": index, "batchCount": len(batches)},
                instructions="Assess repeat-application risk using only these exact current and confirmed prior application sources. Return same_employer_equivalent_role only if a prior application is to the same employer and a role with equivalent scope/responsibilities despite a different canonical opening. Return clear only if the supplied prior records do not establish that risk; uncertainty remains uncertain. Never treat title overlap or domain/name spelling as semantic proof, and do not invent an application fact. Cite the current posting and every matched prior application using verbatim spans. MatchedJobIds must be empty for clear or uncertain. This result grants no submission authority.",
                required={"current"}, validate=validate, source_fence=self.store.model_fence(fence))
            decisions.append(decision)
            ids.append(ident)
        status = "uncertain" if any(item.status == "uncertain" for item in decisions) else "same_employer_equivalent_role" if any(item.status == "same_employer_equivalent_role" for item in decisions) else "clear"
        check = {"checkId": uuid4().hex, "jobId": job, "status": status, "evidenceSha256": fingerprint,
                 "matchedApplications": sorted({ident for decision in decisions for ident in decision.matchedJobIds}),
                 "determinationIds": ids, "recordedAt": timestamp()}
        with self.store.write() as session:
            _, current_hash = self._evidence(session, job, tenant_id)
            if current_hash != fingerprint:
                raise ApplicationFailure("application_repeat_evidence_changed", conflict=True)
            session.append_check(tenant_id, job, fingerprint, check)
            session.emit(tenant_id, job, repeatCheckId=check["checkId"], repeatRisk=status)
        return self.read(job, tenant_id)

    def override(self, job, command, tenant_id="local"):
        key, request = "repeat-override:" + command.idempotencyKey, {"jobId": job, **command.model_dump()}
        with self.store.write() as session:
            repeated = session.repeated(tenant_id, key, request)
            if repeated is not None:
                return repeated
            current = self._read(session, tenant_id, job)
            if (current["status"] != "same_employer_equivalent_role" or current["checkId"] != command.expectedCheckId
                    or current["evidenceSha256"] != command.evidenceSha256 or not command.reason.strip()):
                raise ApplicationFailure("application_repeat_override_stale", conflict=True)
            if current["override"]:
                raise ApplicationFailure("application_repeat_override_exists", conflict=True)
            if session.has_intent(tenant_id, job):
                raise ApplicationFailure("application_submit_intent_exists", conflict=True)
            ident, created_at = uuid4().hex, timestamp()
            session.append_override(tenant_id, job, current["checkId"], command.evidenceSha256, ident, command.reason, created_at)
            response = self._read(session, tenant_id, job)
            session.save_receipt(tenant_id, key, request, response)
            session.emit(tenant_id, job, repeatOverrideId=ident)
            return response

    def _guard(self, session: RepeatSession, tenant, job, run_id=None):
        status = self._read(session, tenant, job)
        if status["status"] == "clear":
            return
        override = status.get("override")
        if status["status"] != "same_employer_equivalent_role" or not override or override["usedByRunId"] not in {None, run_id}:
            raise ApplicationFailure(status["blockReason"] or "application_repeat_blocked", conflict=True)
        if run_id and not override["usedByRunId"]:
            if not session.consume_override(tenant, override["overrideId"], run_id, timestamp()):
                raise ApplicationFailure("application_repeat_override_used", conflict=True)
