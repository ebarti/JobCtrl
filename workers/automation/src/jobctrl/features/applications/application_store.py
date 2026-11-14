"""Applications SQLite adapter: semantic atomic commands and committed source guards.

The application layer receives immutable admissions, never a connection or
transaction facade. All final authority and intent writes share one writer lock.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from .domain import ApplicationFailure, automatic_source_allowed, copied, confirmed_receipt, digest, timestamp
from .ports import RehearsalAdmission, SubmissionAdmission


class SqliteApplicationStore:
    def __init__(self, repository, sources, *, screening, repeat, inspection, feedback, validate_mail, fit=None):
        self.repository, self.sources = repository, sources
        self.screening, self.repeat, self.inspection, self.feedback, self.fit = screening, repeat, inspection, feedback, fit
        self.validate_mail = validate_mail
        self._action_reader = None

    def set_action_reader(self, reader):
        """Composition injects the orchestration owner's public read query."""
        self._action_reader = reader

    def _assert_revision(self, state, expected):
        if state["version"] != expected:
            raise ApplicationFailure("application_revision_conflict", conflict=True)

    def _confirmed(self, job, tenant, conn):
        return self.feedback.confirmed_for_job(job, connection=conn, tenant_id=tenant)

    def _eligible(self, conn, job, minimum=None):
        fit = getattr(self, "fit", None)
        if fit is None:
            raise ApplicationFailure("application_fit_unavailable")
        snapshot = fit.get_job_fit(job, connection=conn, include_coverage=False)
        score = snapshot.get("score")
        if not snapshot.get("current") or not score:
            raise ApplicationFailure("application_fit_stale", conflict=True)
        if score.get("score") is None:
            raise ApplicationFailure("application_fit_unavailable")
        if minimum is not None and score["score"] < minimum:
            raise ApplicationFailure("application_below_minimum_fit")
        return score["score"]

    def _analytics_context(self, conn, job, sources):
        context = {"source": sources["job"]["sourceId"], "profileRevision": sources["profile"]["revision"],
                   "postingRevision": sources["job"]["revision"], "postingHash": sources["job"]["sourceHash"],
                   "resumeId": sources["resume"]["resumeId"], "resumeRevisionId": sources["resume"]["revisionId"],
                   "resumeAcceptanceId": sources["resume"]["acceptanceId"]}
        fit = getattr(self, "fit", None)
        snapshot = fit.get_job_fit(job, connection=conn, include_coverage=False) if fit is not None else None
        if snapshot and snapshot.get("current") and snapshot.get("score") and snapshot["score"].get("score") is not None:
            score = snapshot["score"]
            value = score["score"]
            band = "perfect" if value >= 9 else "strong" if value >= 7 else "moderate" if value >= 5 else "weak" if value >= 3 else "poor"
            context.update(fitScore=value, fitRevision=score["revision"], fitBand=score["fit_band"],
                           scoreBand=band, fitPolicyVersion=score.get("policy_version"))
        accepted = self.sources.resumes.accepted_snapshot(job, connection=conn)
        template = accepted.get("template") if accepted else None
        if template:
            metadata = template.get("metadata") or {}
            values = {"templateId": metadata.get("templateId", template.get("template_id")),
                      "templateVersion": metadata.get("templateVersionId", template.get("version")),
                      "templateName": metadata.get("templateName", template.get("display_name"))}
            context.update({key: value for key, value in values.items() if value is not None})
        if accepted:
            context.update({key: accepted[field] for key, field in (
                ("compositionMode", "composition_mode"), ("compositionPolicy", "composition_policy"))
                if accepted.get(field) is not None})
        return context

    def _source_fence(self, conn, tenant, payload):
        state = self.repository.state(conn, tenant, payload["jobId"])
        if payload.get("claimEpoch", 0) != state.get("claimEpoch", 0):
            raise ApplicationFailure("application_request_predates_stop", conflict=True)
        self.sources.assert_current(payload["jobId"], payload["sources"], tenant, conn)
        if self.screening.accepted_payload(conn, tenant, payload["jobId"]) != payload["screeningAnswers"]:
            raise ApplicationFailure("application_screening_changed", conflict=True)

    def _rehearsal_fence(self, conn, tenant, payload, decision):
        evidence_id = decision.get("rehearsalId")
        evidence = self.repository.rehearsal(conn, tenant, evidence_id) if evidence_id else None
        if (not evidence or evidence["jobId"] != payload["jobId"] or evidence["payloadId"] != payload["payloadId"]
                or evidence["payloadSha256"] != payload["payloadSha256"] or evidence["status"] != "completed"):
            raise ApplicationFailure("application_rehearsal_required")
        if payload["mode"] == "email":
            if evidence["coverage"] != "full":
                raise ApplicationFailure("application_rehearsal_required")
        else:
            self.inspection.assert_record(conn, tenant, payload, evidence.get("inspection"))
            if evidence["coverage"] != "partial" or decision.get("partialOverrideRunId") != evidence["rehearsalId"]:
                raise ApplicationFailure("application_partial_rehearsal_confirmation_required")
            if evidence["inspection"]["status"] not in {"ready", "manual"}:
                raise ApplicationFailure("application_rehearsal_requires_resolution")

    def prepare(self, job, command, tenant_id="local"):
        tenant, repo = tenant_id, self.repository
        request = {"action": "prepare", "jobId": job, **command.model_dump()}
        with repo.atomic() as conn:
            repeated = repo.repeated(conn, tenant, command.idempotencyKey, request)
            if repeated is not None:
                return repeated
            state = repo.state(conn, tenant, job)
            self._assert_revision(state, command.expectedVersion)
            if repo.intent(conn, tenant, job):
                raise ApplicationFailure("application_submit_intent_exists", conflict=True)
            if self._confirmed(job, tenant, conn):
                raise ApplicationFailure("application_already_confirmed", conflict=True)
            if state["stopped"]:
                raise ApplicationFailure("application_stopped")
            if state.get("runId"):
                run = repo.run(conn, tenant, state["runId"])
                if run and run["status"] in {"running", "sending"}:
                    raise ApplicationFailure("application_run_active", conflict=True)
            binding, fields = self.sources.capture(job, tenant, conn)
            attachment = self.sources.pinned_attachment(job, binding, tenant, conn)
            if binding["job"]["activeState"] in {"closed", "expired", "removed", "location_incompatible"}:
                raise ApplicationFailure("application_posting_closed")
            if command.mode == "email":
                if not command.recipient or not command.subject or not command.body:
                    raise ApplicationFailure("application_email_preview_required")
                self.validate_mail(recipient=command.recipient, subject=command.subject, body=command.body,
                                   attachment_bytes=attachment, attachment_name="resume.pdf")
            elif any(value is not None for value in (command.recipient, command.subject, command.body)):
                raise ApplicationFailure("application_browser_email_fields_forbidden")
            payload = {"payloadId": uuid4().hex, "jobId": job, "mode": command.mode, "sources": binding,
                       "claimEpoch": state.get("claimEpoch", 0),
                       "applicationUrl": binding["job"]["applicationUrl"], "fields": fields,
                       "screeningAnswers": self.screening.accepted_payload(conn, tenant, job),
                       "analyticsContext": self._analytics_context(conn, job, binding),
                       "attachmentName": "resume.pdf", "recipient": command.recipient,
                       "subject": command.subject, "body": command.body, "createdAt": timestamp()}
            payload["payloadSha256"] = digest(payload)
            repo.add_payload(conn, tenant, payload)
            state.update(payloadId=payload["payloadId"], latestDecision=None, runId=None, status="awaiting_rehearsal")
            state = repo.save_state(conn, tenant, state, state["version"])
            response = {"ok": True, "application": self._view(conn, tenant, state)}
            repo.receipt(conn, tenant, command.idempotencyKey, request, response)
            repo.event(conn, "ApplicationsUpdated", job, version=state["version"], payloadId=payload["payloadId"], state=state["status"])
            return copied(response)

    def review(self, job, command, tenant_id="local"):
        repo, tenant = self.repository, tenant_id
        request = {"action": "review", "jobId": job, **command.model_dump()}
        with repo.atomic() as conn:
            repeated = repo.repeated(conn, tenant, command.idempotencyKey, request)
            if repeated is not None:
                return repeated
            state = repo.state(conn, tenant, job)
            self._assert_revision(state, command.expectedVersion)
            payload = repo.payload(conn, tenant, state["payloadId"]) if state["payloadId"] else None
            if command.decision == "approve_dry_run":
                if state["stopped"] or not payload:
                    raise ApplicationFailure("application_stopped")
                if (command.payloadId, command.payloadSha256) != (payload["payloadId"], payload["payloadSha256"]):
                    raise ApplicationFailure("application_review_payload_changed", conflict=True)
                self._source_fence(conn, tenant, payload)
            if command.decision == "approve_submit":
                if state["stopped"]:
                    raise ApplicationFailure("application_stopped")
                if repo.intent(conn, tenant, job) or self._confirmed(job, tenant, conn):
                    raise ApplicationFailure("application_repeat_blocked", conflict=True)
                if not payload or (command.payloadId, command.payloadSha256) != (payload["payloadId"], payload["payloadSha256"]):
                    raise ApplicationFailure("application_review_payload_changed", conflict=True)
                self._source_fence(conn, tenant, payload)
                self.repeat.guard(conn, tenant, job)
                self._eligible(conn, job)
                self.sources.pinned_attachment(job, payload["sources"], tenant, conn)
                evidence_id = command.rehearsalId or command.partialOverrideRunId
                evidence = repo.rehearsal(conn, tenant, evidence_id) if evidence_id else None
                if (not evidence or evidence["payloadId"] != payload["payloadId"]
                        or evidence["payloadSha256"] != payload["payloadSha256"]
                        or evidence["status"] != "completed"):
                    raise ApplicationFailure("application_rehearsal_required")
                if evidence["coverage"] != "full" and command.partialOverrideRunId != evidence["rehearsalId"]:
                    raise ApplicationFailure("application_partial_rehearsal_confirmation_required")
                if payload["mode"] == "browser":
                    self.inspection.assert_record(conn, tenant, payload, evidence.get("inspection"))
                    if evidence["coverage"] != "partial" or command.partialOverrideRunId != evidence["rehearsalId"]:
                        raise ApplicationFailure("application_partial_rehearsal_confirmation_required")
                    if evidence["inspection"]["status"] not in {"ready", "manual"}:
                        raise ApplicationFailure("application_rehearsal_requires_resolution")
            decision = {"decisionId": uuid4().hex, "jobId": job, "jobKey": job, "decision": command.decision,
                        "reason": command.reason, "decidedBy": "user", "decidedAt": timestamp(),
                        "payloadId": payload["payloadId"] if payload else None,
                        "payloadSha256": payload["payloadSha256"] if payload else None,
                        "sourcesSha256": digest(payload["sources"]) if payload else None,
                        "rehearsalId": command.rehearsalId or command.partialOverrideRunId,
                        "partialOverrideRunId": command.partialOverrideRunId}
            repo.decision(conn, tenant, decision)
            state["latestDecision"] = decision
            if not repo.intent(conn, tenant, job) and not state["stopped"]:
                state["status"] = {"approve_submit": "approved", "approve_dry_run": "approved_dry_run", "defer": "deferred", "decline": "declined", "reset": "awaiting_approval"}[command.decision]
            state = repo.save_state(conn, tenant, state, state["version"])
            response = {"ok": True, "decision": decision, "application": self._view(conn, tenant, state)}
            repo.receipt(conn, tenant, command.idempotencyKey, request, response)
            repo.event(conn, "ApplicationsUpdated", job, version=state["version"], decisionId=decision["decisionId"], decision=decision["decision"])
            return copied(response)

    def _park_unknown(self, conn, tenant, job, intent):
        if not intent:
            raise ApplicationFailure("application_intent_missing")
        if self.repository.submit_receipt(conn, tenant, intent["intent_id"]):
            return
        state = self.repository.state(conn, tenant, job)
        run = self.repository.run(conn, tenant, intent["run_id"])
        if run is None or run["payloadSha256"] != intent["payload_sha256"]:
            raise ApplicationFailure("application_run_owner_changed", conflict=True)
        run.update(status="needs_verification", finishedAt=timestamp())
        self.repository.save_run(conn, tenant, run)
        if state["runId"] == run["runId"] and not state["stopped"]:
            state["status"] = "needs_verification"
            state = self.repository.save_state(conn, tenant, state, state["version"])
        self.repository.event(conn, "ApplicationsUpdated", job, runId=run["runId"], intentId=intent["intent_id"], state="needs_verification")

    def _reconcile(self, conn, tenant, job, intent):
        saved = self.repository.submit_receipt(conn, tenant, intent["intent_id"])
        if not saved:
            self._park_unknown(conn, tenant, job, intent)
            return {"ok": False, "runId": intent["run_id"], "status": "needs_verification", "failureCode": "application_submit_intent_exists"}
        receipt = confirmed_receipt(json.loads(saved["receipt_json"]))
        if saved["run_id"] != intent["run_id"] or saved["payload_sha256"] != intent["payload_sha256"]:
            raise ApplicationFailure("application_receipt_binding_invalid")
        run = self.repository.run(conn, tenant, intent["run_id"])
        if not run or (run["jobId"], run["payloadSha256"], run["approvalId"]) != (job, intent["payload_sha256"], intent["approval_id"]):
            raise ApplicationFailure("application_run_owner_changed", conflict=True)
        outcome = self.feedback.record_confirmed_submission(job, intent_id=intent["intent_id"],
            occurred_at=saved["recorded_at"], tenant_id=tenant, connection=conn)
        if run["status"] != "applied":
            run.update(status="applied", receipt=receipt, finishedAt=saved["recorded_at"])
            self.repository.save_run(conn, tenant, run)
            state = self.repository.state(conn, tenant, job)
            if state["runId"] == run["runId"] and not state["stopped"]:
                state["status"] = "applied"
                state = self.repository.save_state(conn, tenant, state, state["version"])
            self.repository.event(conn, "ApplicationSubmitted", job, runId=run["runId"], intentId=intent["intent_id"],
                                  payloadId=intent["payload_id"], receiptPresent=True)
        return {"ok": True, "run": copied(run), "outcome": outcome.get("outcome", outcome)}

    def control(self, job, command, tenant_id="local"):
        tenant, repo = tenant_id, self.repository
        request = {"action": "control", "jobId": job, **command.model_dump()}
        with repo.atomic() as conn:
            repeated = repo.repeated(conn, tenant, command.idempotencyKey, request)
            if repeated is not None:
                return repeated
            state = repo.state(conn, tenant, job)
            self._assert_revision(state, command.expectedVersion)
            intent = repo.intent(conn, tenant, job)
            if command.action == "reset":
                if intent or self._confirmed(job, tenant, conn) or state["status"] == "needs_verification":
                    raise ApplicationFailure("application_reset_unsafe", conflict=True)
                active = repo.run(conn, tenant, state["runId"]) if state["runId"] else None
                if active and active["status"] in {"running", "sending"}:
                    raise ApplicationFailure("application_run_active", conflict=True)
                state.update(stopped=False, status="awaiting_approval" if state["payloadId"] else "unprepared", latestDecision=None)
                if command.resetAttempts or state.get("attemptCount", 0) >= 3:
                    state["attemptCount"] = 0
                # A reset revokes previous approval. Old queued requests cannot
                # gain authority when the local stop is released.
                decision = {"decisionId": uuid4().hex, "jobId": job, "decision": "reset", "payloadId": state["payloadId"], "decidedAt": timestamp()}
                repo.decision(conn, tenant, decision)
            elif command.action == "mark_failed":
                if intent or self._confirmed(job, tenant, conn) or state["stopped"]:
                    raise ApplicationFailure("application_manual_failure_unsafe", conflict=True)
                active = repo.run(conn, tenant, state["runId"]) if state["runId"] else None
                if active and active["status"] in {"running", "sending"}:
                    raise ApplicationFailure("application_run_active", conflict=True)
                state["status"] = "failed"
            else:
                state.update(stopped=True, status="skipped" if command.action == "skip" else "cancelled",
                             claimEpoch=state.get("claimEpoch", 0) + 1)
            state = repo.save_state(conn, tenant, state, state["version"])
            response = {"ok": True, "application": self._view(conn, tenant, state)}
            repo.receipt(conn, tenant, command.idempotencyKey, request, response)
            repo.event(conn, "ApplicationsUpdated", job, version=state["version"], state=state["status"], stopped=state["stopped"])
            return copied(response)

    def _view(self, conn, tenant, state):
        view = copied(state)
        repo = self.repository
        view.update(payload=repo.payload(conn, tenant, state["payloadId"]) if state["payloadId"] else None,
                    decisions=repo.decisions(conn, tenant, state["jobId"]), rehearsals=repo.rehearsals(conn, tenant, state["jobId"]),
                    runs=repo.runs(conn, tenant, state["jobId"]))
        for rehearsal in view["rehearsals"]:
            if rehearsal.get("inspection"):
                observed_payload = repo.payload(conn, tenant, rehearsal["payloadId"])
                self.inspection.assert_record(conn, tenant, observed_payload, rehearsal["inspection"])
        intent = repo.intent(conn, tenant, state["jobId"])
        view["intent"] = ({"intentId": intent["intent_id"], "runId": intent["run_id"], "payloadId": intent["payload_id"],
                           "payloadSha256": intent["payload_sha256"], "createdAt": intent["created_at"]} if intent else None)
        receipt = repo.submit_receipt(conn, tenant, intent["intent_id"]) if intent else None
        view["receipt"] = ({"runId": receipt["run_id"], "recordedAt": receipt["recorded_at"], "confirmed": True} if receipt else None)
        posting = self.sources.job_snapshot(state["jobId"], conn)
        view["job"] = {"jobId": state["jobId"], "title": posting.get("title"), "employer": posting.get("company"),
                       "source": posting.get("source_id"), "applicationUrl": posting.get("application_url"),
                       "postingUrl": posting.get("url"), "activeState": posting.get("active_state")}
        view["approvalCurrent"] = False
        view["approvalBlockReason"] = None
        if view["payload"]:
            try:
                self._source_fence(conn, tenant, view["payload"])
                self.sources.pinned_attachment(state["jobId"], view["payload"]["sources"], tenant, conn)
                latest = repo.latest_decision(conn, tenant, state["jobId"])
                view["approvalCurrent"] = bool(latest and latest["decision"] == "approve_submit"
                    and latest["payloadId"] == view["payload"]["payloadId"]
                    and latest["payloadSha256"] == view["payload"]["payloadSha256"])
                if view["approvalCurrent"]:
                    self._rehearsal_fence(conn, tenant, view["payload"], latest)
                    self._eligible(conn, state["jobId"])
            except Exception as error:
                # This is explanatory read state only. No source, approval or
                # accepted artifact is replaced when its validation fails.
                view["approvalBlockReason"] = getattr(error, "code", "application_source_unavailable")
                view["approvalCurrent"] = False
        confirmed = self._confirmed(state["jobId"], tenant, conn)
        view["confirmedApplication"] = bool(confirmed)
        view["canExecute"] = bool(view["approvalCurrent"] and not view["stopped"] and not intent and not confirmed)
        return view

    def read(self, job, tenant_id="local"):
        self.sources.job_snapshot(job)
        with self.repository.read() as conn:
            return {"ok": True, "application": self._view(conn, tenant_id, self.repository.state(conn, tenant_id, job))}

    def read_apply_review(self, tenant_id="local"):
        with self.repository.read() as conn:
            states = {state["jobId"]: state for state in self.repository.states(conn, tenant_id)}
            public_jobs = self.sources.jobs.list_job_snapshots(connection=conn)
            return {"ok": True, "items": [self._view(conn, tenant_id, states.get(job["job_id"], self.repository.state(conn, tenant_id, job["job_id"])))
                                           for job in public_jobs]}

    def confirmed_anchors(self, tenant_id="local"):
        with self.repository.read() as conn:
            anchors = []
            for row in conn.execute(
                "SELECT i.job_id,r.recorded_at,i.run_id FROM applications_submit_intents i JOIN applications_submit_receipts r ON r.tenant_id=i.tenant_id AND r.intent_id=i.intent_id WHERE i.tenant_id=?", (tenant_id,)):
                run = self.repository.run(conn, tenant_id, row[2])
                context = run.get("analyticsContext", {}) if run else {}
                anchors.append({"jobId": row[0], "occurredAt": row[1], "applyMode": "email", **context})
            return anchors

    def job_summaries(self, job_ids, connection=None, tenant_id="local"):
        if (not isinstance(job_ids, (list, tuple)) or len(job_ids) > 1000
                or any(not isinstance(job, str) or not job for job in job_ids)):
            raise ApplicationFailure("application_job_query_invalid")
        result = {}
        with self.repository.read(connection) as conn:
            for job in dict.fromkeys(job_ids):
                state = self.repository.state(conn, tenant_id, job)
                facts = self._confirmed(job, tenant_id, conn)
                applied_at = min(facts, key=lambda fact: datetime.fromisoformat(fact["occurredAt"].replace("Z", "+00:00")))["occurredAt"] if facts else None
                intent = self.repository.intent(conn, tenant_id, job)
                receipt = self.repository.submit_receipt(conn, tenant_id, intent["intent_id"]) if intent else None
                run = self.repository.run(conn, tenant_id, intent["run_id"] if intent else state["runId"]) if (intent or state["runId"]) else None
                needs_verification = bool(intent and not receipt and run and run["status"] == "needs_verification")
                status = "applied" if facts else "needs_verification" if needs_verification else state["status"] if state["version"] else None
                payload = self.repository.payload(conn, tenant_id, state["payloadId"]) if state["payloadId"] else None
                sources = payload["sources"] if payload else None
                instants = [value for value in (state.get("updatedAt"), run.get("updatedAt") if run else None,
                            *(fact["recordedAt"] for fact in facts)) if value]
                updated_at = max(instants, key=lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))) if instants else None
                result[job] = {"job_id": job, "apply_status": status, "applied_at": applied_at,
                    "stage": "apply" if state["version"] or run or facts else None,
                    "state": status, "updated_at": updated_at,
                    "application_revision": state["version"] or None, "payload_id": state["payloadId"],
                    "decision_id": state["latestDecision"]["decisionId"] if state["latestDecision"] else None,
                    "run_id": state["runId"], "local_status": state["status"] if state["version"] else None,
                    "local_stopped": state["stopped"] if state["version"] else None,
                    "submission_confirmed": bool(facts), "needs_verification": needs_verification,
                    "sources": ({"profileRevision": sources["profile"]["revision"],
                        "postingRevision": sources["job"]["revision"], "postingHash": sources["job"]["sourceHash"],
                        "resumeId": sources["resume"]["resumeId"], "acceptanceId": sources["resume"]["acceptanceId"]} if sources else None)}
        return result

    def summary(self, tenant_id="local", at=None):
        with self.repository.read() as conn:
            states = self.repository.states(conn, tenant_id)
            for state in states:
                state["intent"] = self.repository.intent(conn, tenant_id, state["jobId"])
                state["receipt"] = self.repository.submit_receipt(conn, tenant_id, state["intent"]["intent_id"]) if state["intent"] else None
                state["intentRun"] = self.repository.run(conn, tenant_id, state["intent"]["run_id"]) if state["intent"] else None
                payload = self.repository.payload(conn, tenant_id, state["payloadId"]) if state["payloadId"] else None
                state["payloadCurrent"] = bool(payload and payload.get("claimEpoch", 0) == state.get("claimEpoch", 0))
        outcomes = self.feedback.list_outcomes(tenant_id=tenant_id)["outcomes"]
        now = datetime.fromisoformat(at.replace("Z", "+00:00")) if isinstance(at, str) else at or datetime.now(UTC)
        if now.tzinfo is None:
            raise ApplicationFailure("application_summary_time_invalid")
        def instant(value):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
            return parsed.replace(microsecond=(parsed.microsecond // 1000) * 1000)
        cutoff = instant((now - timedelta(days=7)).isoformat())
        available = {job["job_id"] for job in self.sources.jobs.list_job_snapshots(include_inactive=True, include_hidden=True)}
        events = [(outcome["jobId"], instant(outcome["occurredAt"]), instant(outcome["recordedAt"]), outcome["kind"])
                  for outcome in outcomes if outcome["jobId"] in available]
        follow_ups = {}
        stop_kinds = {"recruiter_reply", "interview", "assessment", "offer", "rejection", "withdrawn", "bounced"}
        for job, occurred_at, _recorded_at, kind in sorted(events):
            current = follow_ups.setdefault(job, {"appliedAt": None, "lastActivityAt": None, "stopped": False})
            if current["lastActivityAt"] is None or occurred_at > current["lastActivityAt"]:
                current["lastActivityAt"] = occurred_at
            if kind == "applied_confirmation":
                if current["appliedAt"] is None or occurred_at > current["appliedAt"]:
                    current.update(appliedAt=occurred_at, stopped=False)
            elif current["appliedAt"] is not None and occurred_at > current["appliedAt"] and kind in stop_kinds:
                current["stopped"] = True
        due = sorted(job for job, item in follow_ups.items() if item["appliedAt"] and not item["stopped"]
                     and item["lastActivityAt"] and item["lastActivityAt"] <= cutoff)
        def count(*values):
            return sum(state["status"] in values for state in states)
        action_runs = self._action_reader(limit=1000) if self._action_reader is not None else None
        execution_runs = [run for run in action_runs or [] if run["action"] in {"applications.execute", "applications.batch"}]
        complete = action_runs is not None and len(action_runs) < 1000
        queued = sum(run["status"] in {"pending", "queued"} for run in execution_runs) if complete else None
        active_ids = {run["runId"] for run in execution_runs if run["status"] == "running"}
        active_ids |= {state["runId"] for state in states if state["status"] in {"running", "sending"} and state["runId"]}
        pending = sum(state["status"] in {"awaiting_approval", "awaiting_rehearsal"} and state["payloadCurrent"]
                      and (not state["latestDecision"] or state["latestDecision"]["decision"] == "reset") for state in states)
        return {"pendingApprovalCount": pending,
                "queuedCount": queued, "runningCount": len(active_ids), "queueCountComplete": complete,
                "needsVerificationCount": sum(bool(state["intent"] and not state["receipt"] and (
                    not state["intentRun"] or state["intentRun"]["status"] == "needs_verification")) for state in states),
                "failedCount": count("failed"), "appliedCount": sum(bool(item["appliedAt"]) for item in follow_ups.values()), "followUpsDueCount": len(due),
                "followUpJobIds": due, "jobs": [{k: state.get(k) for k in ("jobId", "status", "payloadId", "latestDecision", "updatedAt")} for state in states]}

    def list_outcomes(self, job_id=None, tenant_id="local"):
        return self.feedback.list_outcomes(job_id=job_id, tenant_id=tenant_id)

    def record_outcome(self, job_id, payload, tenant_id="local", connection=None):
        return self.feedback.record_outcome(job_id, payload, tenant_id=tenant_id, connection=connection)

    def ensure_offer_milestone(self, job_id, connection=None, tenant_id="local"):
        return self.feedback.ensure_offer_milestone(job_id, connection=connection, tenant_id=tenant_id)

    def outreach_context(self, job_id, connection=None, tenant_id="local"):
        confirmed = self.feedback.confirmed_for_job(job_id, connection=connection, tenant_id=tenant_id)
        return {"submitted_at": min((item["occurredAt"] for item in confirmed), default=None)}

    def delete_job_data(self, job_id, connection=None, tenant_id="local"):
        """Join an authorized Jobs deletion; unresolved external authority survives."""
        with self.repository.atomic(connection) as conn:
            if self.repository.intent(conn, tenant_id, job_id):
                # Permanent deletion is not proof that a provider did not send.
                # Preserve the original identity and audit until the operator
                # uses a separate deliberate data-transition procedure.
                raise ApplicationFailure("application_submission_history_protected", conflict=True)
            runs = self.repository.runs(conn, tenant_id, job_id)
            if any(run["status"] in {"running", "sending"} for run in runs):
                raise ApplicationFailure("application_run_active", conflict=True)
            self.feedback.delete_job_data(job_id, connection=conn, tenant_id=tenant_id)
            for table in ("applications_state", "applications_payloads", "applications_decisions", "applications_runs",
                          "applications_rehearsals", "applications_screening", "applications_failures",
                          "applications_repeat_overrides", "applications_repeat_checks"):
                conn.execute(f"DELETE FROM {table} WHERE tenant_id=? AND job_id=?", (tenant_id, job_id))
            conn.execute("DELETE FROM applications_action_receipts WHERE tenant_id=? AND (json_extract(response_json,'$.application.jobId')=? OR json_extract(response_json,'$.jobId')=?)",
                         (tenant_id, job_id, job_id))
            self.repository.event(conn, "ApplicationsUpdated", job_id, deleted=True)

    def admit_execution(self, claim, command, tenant_id="local"):
        repo, tenant, job = self.repository, tenant_id, command.jobId
        # This transaction is the sole external-effect admission boundary.
        with repo.atomic() as conn:
            prior = repo.run(conn, tenant, claim.run_id)
            if prior and (prior["jobId"], prior["payloadId"], prior["approvalId"]) != (job, command.payloadId, command.approvalId):
                raise ApplicationFailure("application_run_identity_conflict", conflict=True)
            intent = repo.intent(conn, tenant, job)
            if intent:
                return SubmissionAdmission(result=self._reconcile(conn, tenant, job, intent))
            if prior:
                return SubmissionAdmission(result={"ok": True, "run": prior})
            state = repo.state(conn, tenant, job)
            if state["stopped"] or claim.cancelled():
                raise ApplicationFailure("application_stopped")
            if self._confirmed(job, tenant, conn):
                raise ApplicationFailure("application_already_confirmed", conflict=True)
            payload = repo.payload(conn, tenant, command.payloadId)
            decision = repo.latest_decision(conn, tenant, job)
            if (state["payloadId"] != command.payloadId or payload["jobId"] != job or not decision
                    or decision["decisionId"] != command.approvalId or decision["decision"] != "approve_submit"
                    or decision["payloadId"] != command.payloadId or decision["payloadSha256"] != payload["payloadSha256"]
                    or decision["sourcesSha256"] != digest(payload["sources"])):
                raise ApplicationFailure("application_approval_changed", conflict=True)
            self._source_fence(conn, tenant, payload)
            automatic = claim.automatic
            policy = repo.execution_policy(conn)
            if automatic:
                if state["status"] != "approved" or state.get("attemptCount", 0) >= 3:
                    raise ApplicationFailure("application_automatic_claim_stale", conflict=True)
                if not automatic_source_allowed(self.sources.job_snapshot(job, conn)):
                    raise ApplicationFailure("application_automatic_source_blocked")
            minimum = (claim.min_fit_override or policy["minFitScore"]) if automatic else None
            self._eligible(conn, job, minimum)
            self._rehearsal_fence(conn, tenant, payload, decision)
            attachment = self.sources.pinned_attachment(job, payload["sources"], tenant, conn)
            self.repeat.guard(conn, tenant, job, claim.run_id)
            if payload["mode"] == "email" and repo.active_send_count(conn, tenant) >= policy["concurrency"]:
                raise ApplicationFailure("application_concurrency_limit", conflict=True)
            run = {"runId": claim.run_id, "jobId": job, "payloadId": command.payloadId,
                   "payloadSha256": payload["payloadSha256"], "approvalId": command.approvalId,
                   "mode": payload["mode"], "startedAt": timestamp(), "executionPolicy": policy,
                   "analyticsContext": self._analytics_context(conn, job, payload["sources"]),
                   "status": "manual_required" if payload["mode"] == "browser" else "sending"}
            state["attemptCount"] = state.get("attemptCount", 0) + 1
            run["attempt"] = state["attemptCount"]
            repo.save_run(conn, tenant, run, new=True)
            state.update(runId=claim.run_id, status=run["status"])
            if payload["mode"] == "email":
                self.validate_mail(recipient=payload["recipient"], subject=payload["subject"], body=payload["body"],
                                   attachment_bytes=attachment, attachment_name=payload["attachmentName"])
                intent_value = {"intentId": uuid4().hex, "jobId": job, "runId": claim.run_id,
                    "payloadId": payload["payloadId"], "payloadSha256": payload["payloadSha256"],
                    "approvalId": decision["decisionId"], "attachmentSha256": payload["sources"]["resume"]["pdf"]["sha256"],
                    "createdAt": timestamp()}
                repo.add_intent(conn, tenant, intent_value)
                # Source files are outside SQLite. Recheck after intent insert
                # while rollback is still possible, and send the first pinned
                # approved byte copy rather than reopening a mutable path.
                if self.sources.pinned_attachment(job, payload["sources"], tenant, conn) != attachment:
                    raise ApplicationFailure("application_attachment_changed", conflict=True)
                repo.event(conn, "ApplicationSubmitIntentRecorded", job, runId=claim.run_id,
                           intentId=intent_value["intentId"], payloadId=payload["payloadId"], payloadSha256=payload["payloadSha256"])
            state = repo.save_state(conn, tenant, state, state["version"])
            repo.event(conn, "ApplicationsUpdated", job, version=state["version"], runId=claim.run_id, state=run["status"])
        return SubmissionAdmission(payload=payload, run=run, policy=policy, attachment=attachment)

    def begin_rehearsal(self, job, payload_id, rehearsal_id, tenant_id="local"):
        repo = self.repository
        with repo.read() as conn:
            prior = repo.rehearsal(conn, tenant_id, rehearsal_id)
            if prior:
                if prior["jobId"] != job or prior["payloadId"] != payload_id:
                    raise ApplicationFailure("application_rehearsal_identity_conflict", conflict=True)
                return RehearsalAdmission(result={"ok": True, "rehearsal": prior})
            state, payload = repo.state(conn, tenant_id, job), repo.payload(conn, tenant_id, payload_id)
            if state["payloadId"] != payload_id or state["stopped"]:
                raise ApplicationFailure("application_rehearsal_stale", conflict=True)
            self._source_fence(conn, tenant_id, payload)
        def fence(connection=None):
            with repo.read(connection) as conn:
                current = repo.state(conn, tenant_id, job)
                if current["stopped"] or current["payloadId"] != payload_id:
                    raise ApplicationFailure("application_rehearsal_stale", conflict=True)
                self._source_fence(conn, tenant_id, payload)
        return RehearsalAdmission(payload=payload, source_fence=fence,
                                  timeout_seconds=repo.execution_policy()["timeoutSeconds"])

    def complete_rehearsal(self, payload, evidence, tenant_id="local"):
        repo, job = self.repository, payload["jobId"]
        with repo.atomic() as conn:
            prior = repo.rehearsal(conn, tenant_id, evidence["rehearsalId"])
            if prior:
                if prior["jobId"] != job or prior["payloadId"] != payload["payloadId"]:
                    raise ApplicationFailure("application_rehearsal_identity_conflict", conflict=True)
                return {"ok": True, "rehearsal": prior}
            state = repo.state(conn, tenant_id, job)
            if state["stopped"] or state["payloadId"] != payload["payloadId"]:
                raise ApplicationFailure("application_rehearsal_stale", conflict=True)
            self._source_fence(conn, tenant_id, payload)
            self.sources.pinned_attachment(job, payload["sources"], tenant_id, conn)
            repo.add_rehearsal(conn, tenant_id, evidence)
            state["status"] = "awaiting_approval"
            state = repo.save_state(conn, tenant_id, state, state["version"])
            repo.event(conn, "ApplicationsUpdated", job, version=state["version"], rehearsalId=evidence["rehearsalId"])
        return {"ok": True, "rehearsal": evidence}

    def retain_uncertain_submission(self, job, run_id, tenant_id="local"):
        with self.repository.atomic() as conn:
            intent = self.repository.intent(conn, tenant_id, job)
            if not intent or intent["run_id"] != run_id:
                raise ApplicationFailure("application_run_owner_changed", conflict=True)
            self._park_unknown(conn, tenant_id, job, intent)

    def settle_confirmation(self, run_id, payload, receipt, tenant_id="local"):
        with self.repository.atomic() as conn:
            intent = self.repository.intent(conn, tenant_id, payload["jobId"])
            if not intent or intent["run_id"] != run_id or intent["payload_sha256"] != payload["payloadSha256"]:
                raise ApplicationFailure("application_receipt_binding_invalid", conflict=True)
            self.repository.add_submit_receipt(conn, tenant_id, intent, confirmed_receipt(receipt))
            return self._reconcile(conn, tenant_id, payload["jobId"], intent)

    def execution_policy(self):
        return self.repository.execution_policy()

    def record_refusal(self, job, operation, code, tenant_id="local"):
        self.repository.failure(tenant_id, job, operation, code)

    def select_approved(self, command, tenant_id="local"):
        from .domain import Execute
        items, ready = [], []
        minimum = command.min_fit_score or self.repository.execution_policy()["minFitScore"]
        with self.repository.read() as conn:
            for state in self.repository.states(conn, tenant_id):
                if state["stopped"] or not state["payloadId"] or self.repository.intent(conn, tenant_id, state["jobId"]):
                    continue
                if not command.dry_run and not command.url and (state["status"] != "approved" or state.get("attemptCount", 0) >= 3):
                    continue
                if command.dry_run and (not state["latestDecision"] or state["latestDecision"]["decision"] not in {"approve_dry_run", "approve_submit"}):
                    continue
                try:
                    view = self._view(conn, tenant_id, state)
                    if not command.dry_run:
                        self.repeat.guard(conn, tenant_id, state["jobId"])
                    posting = self.sources.job_snapshot(state["jobId"], conn)
                    if command.url and command.url not in {posting.get("url"), posting.get("application_url")}:
                        continue
                    if not command.url and not automatic_source_allowed(posting):
                        continue
                    score = self._eligible(conn, state["jobId"], None if command.url else minimum)
                except Exception as error:
                    if not isinstance(error, ApplicationFailure) and not hasattr(error, "code"):
                        raise
                    continue
                if command.dry_run or view["canExecute"]:
                    ready.append((-score, posting.get("url") or "", state))
            for _, _, state in sorted(ready, key=lambda item: (item[0], item[1], item[2]["jobId"]))[:command.limit]:
                items.append(Execute(jobId=state["jobId"], payloadId=state["payloadId"],
                    approvalId=state["latestDecision"]["decisionId"] if state["latestDecision"] else "rehearsal-only"))
        return items
