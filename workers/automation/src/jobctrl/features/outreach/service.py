"""The sole canonical writer for reviewed message and attestation lifecycles."""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timezone

from . import domain
from .composer import compose
from .authority import verify_record
from .domain import InvalidOutreach, OutreachMissing, StaleOutreach
from .ports import ContactsReader, JobsReader, MessageModel, OffersReader, OutreachStore, ProfileReader


def _snapshot(value) -> dict:
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, dict):
        return copy.deepcopy(value)
    raise InvalidOutreach("The public source snapshot is unavailable.")


class OutreachService:
    def __init__(self, store: OutreachStore, *, contacts: ContactsReader, profile: ProfileReader,
                 jobs: JobsReader | None = None, offers: OffersReader | None = None, model: MessageModel | None = None,
                 applications=None, compensation=None):
        self.store, self.contacts, self.profile = store, contacts, profile
        self.jobs, self.offers, self.model, self.applications = jobs, offers, model, applications
        self.compensation = compensation

    def _source_bundle(self, contact_id: str, job_id: str | None, kind: str, *, offer_revision_id=None, connection=None) -> dict:
        contact = self.contacts.snapshot(contact_id, connection=connection)
        profile = _snapshot(self.profile.snapshot(connection=connection))
        sources, authorities = [], {"profile": [], "contact": [], "job": [], "offer": []}
        link_source_id = "contact-record:" + contact_id
        sources.append({"source_id": link_source_id,
                        "text": json.dumps({"employer": contact["employer"], "jobId": contact["jobId"], "role": contact["role"]}, sort_keys=True),
                        "revision": contact["revision"]})
        authorities["contact"].append(link_source_id)
        for source in profile.get("evidence_sources", []):
            if source.get("confirmation") not in {"confirmed", "authored"}:
                continue
            identifier, value = source.get("source_id"), source.get("text")
            if not isinstance(identifier, str) or not isinstance(value, str):
                raise InvalidOutreach("A profile source snapshot is malformed.")
            sources.append({"source_id": identifier, "text": value, "revision": source["revision"], "confirmation": source["confirmation"]})
            authorities["profile"].append(identifier)
        for fact in contact["attributes"]:
            if fact["provenance"]["userConfirmed"] is not True:
                continue
            identifier = "contact:" + fact["attributeId"]
            sources.append({"source_id": identifier, "text": fact["value"], "revision": contact["revision"], "kind": fact["kind"]})
            authorities["contact"].append(identifier)
        posting = None
        if job_id:
            if self.jobs is None:
                raise InvalidOutreach("The Jobs feature is required for a job-linked message.")
            posting = _snapshot(self.jobs.get_posting_snapshot(job_id, connection=connection))
            if not posting:
                raise InvalidOutreach("The linked job is unavailable.")
            identifier = "job:" + job_id
            sources.append({"source_id": identifier, "text": json.dumps(posting, ensure_ascii=False, sort_keys=True), "revision": posting["revision"]})
            authorities["job"].append(identifier)
        offer, benchmarks = None, []
        if kind.startswith("offer_"):
            if self.offers is None or job_id is None:
                raise InvalidOutreach("Offer messages require a linked job and the Offers feature.")
            offer = self.offers.current_terms(job_id, offer_revision_id, connection=connection)
            if kind in {"offer_acceptance", "offer_decline"}:
                read_offer = getattr(self.offers, "read_offer", None)
                if read_offer is None:
                    raise InvalidOutreach("Offer decision authority is unavailable.")
                decision = read_offer(job_id, connection=connection).get("currentDecision")
                expected = "accepted" if kind == "offer_acceptance" else "declined"
                if not decision or decision.get("decision") != expected or decision.get("termsRevisionId") != offer["binding"]["termsRevisionId"]:
                    raise InvalidOutreach("This message requires the matching user-attested decision on these exact offer terms.")
            for source in offer["sources"]:
                sources.append(copy.deepcopy(source))
                authorities["offer"].append(source["source_id"])
            if self.compensation is not None:
                benchmarks = self.compensation.outreach_sources(job_id, connection=connection)
                for source in benchmarks:
                    sources.append(copy.deepcopy(source))
                    authorities["offer"].append(source["source_id"])
        elif offer_revision_id is not None:
            raise InvalidOutreach("An offer revision applies only to an offer message.")
        binding = {"contact": contact, "profileFingerprint": profile["fingerprint"],
                   "profileId": profile.get("profile_id", "default"), "job": posting, "offer": offer, "compensation": benchmarks}
        return {"sources": sources, "authorities": authorities, "offer_context": offer,
                "writing_style": profile.get("style", profile.get("document", {}).get("writing_style", {})),
                "binding": binding, "receipt_binding": self._receipt_binding(binding)}

    @staticmethod
    def _receipt_binding(binding: dict) -> dict:
        posting, offer = binding.get("job"), binding.get("offer")
        return {"contactId": binding["contact"]["contactId"], "contactFingerprint": binding["contact"]["fingerprint"],
                "profileId": binding["profileId"], "profileFingerprint": binding["profileFingerprint"],
                "jobId": posting["job_id"] if posting else None, "jobRevision": posting["revision"] if posting else None,
                "jobSourceHash": posting.get("source_hash") if posting else None, "offerFingerprint": offer["fingerprint"] if offer else None,
                "compensationFingerprint": domain.fingerprint(binding.get("compensation", []))}

    def _assert_sources(self, binding: dict, connection=None) -> None:
        try:
            self._check_sources(binding, connection)
        except StaleOutreach:
            raise
        except Exception:
            raise StaleOutreach("A source changed or is unavailable. Review the current facts and verify a new message revision.") from None

    def _check_sources(self, binding: dict, connection=None) -> None:
        self.contacts.assert_current(binding["contact"], connection=connection)
        current_profile = _snapshot(self.profile.snapshot(binding.get("profileId", "default"), connection=connection))
        if current_profile["fingerprint"] != binding["profileFingerprint"]:
            raise StaleOutreach("The profile changed after message verification. Verify a new revision.")
        posting = binding.get("job")
        if posting:
            if self.jobs is None:
                raise StaleOutreach("The message's Jobs source is unavailable.")
            self.jobs.assert_posting_current(posting["job_id"], posting["revision"], posting.get("source_hash"), connection=connection)
        if binding.get("offer"):
            if self.offers is None:
                raise StaleOutreach("The message's Offers source is unavailable.")
            self.offers.assert_terms_current(binding["offer"], connection=connection)
            if self.compensation is not None:
                current = self.compensation.outreach_sources(binding["offer"]["binding"]["jobId"], connection=connection)
                if domain.fingerprint(current) != domain.fingerprint(binding.get("compensation", [])):
                    raise StaleOutreach("Recorded compensation evidence changed after message verification.")
            elif binding.get("compensation"):
                raise StaleOutreach("The message's Compensation source is unavailable.")

    def _detail(self, thread: dict, connection=None) -> dict:
        def current(draft):
            try:
                self._assert_sources(draft["sourceBinding"], connection)
                return True
            except Exception:
                # A read may report uncertain source currency, never grant authority
                # using unavailable/malformed source data. Final actions revalidate.
                return False
        result = domain.detail(thread, source_checker=current)
        with self.store.read(connection) as session:
            for draft, original in zip(result["drafts"], thread["drafts"], strict=True):
                verified, failure = self._review_verification(session, original)
                draft["reviewAuthorityVerified"], draft["reviewAuthorityFailure"] = verified, failure
        return result

    def _review_verification(self, session, draft: dict) -> tuple[bool, str | None]:
        try:
            return self._verify_review_binding(session, draft)
        except (KeyError, TypeError, ValueError):
            return False, "record_invalid"

    def _verify_review_binding(self, session, draft: dict) -> tuple[bool, str | None]:
        gates = draft["gateResults"]
        if gates.get("computedAgainst") != "rendered_draft":
            return False, "draft_binding_mismatch"
        anchors = gates.get("lineAnchors", [])
        if "\n\n".join(line["text"] for line in anchors) != draft["bodyText"]:
            return False, "draft_binding_mismatch"
        records = [session.model_record(identifier) for identifier in gates.get("determinationIds", [])]
        operations = {record["operation"]: record for record in records if record is not None}
        if any(record is None for record in records) or not {"outreach.claims", "outreach.quality"} <= set(operations):
            return False, "record_unavailable"
        binding = self._receipt_binding(draft["sourceBinding"])
        for record in records:
            verified, failure = verify_record(self.model, record, connection=session.connection)
            if not verified:
                return False, failure
            if record.get("context", {}).get("source_binding") != binding:
                return False, "source_binding_mismatch"
        for operation in ("outreach.claims", "outreach.quality"):
            record = operations[operation]
            reviewed_lines = {source["source_id"]: source["text"] for source in record["sources"]}
            if any(reviewed_lines.get("draft:" + line["line_id"]) != line["text"] for line in anchors):
                return False, "draft_binding_mismatch"
        return True, None

    def _assert_review_authority(self, session, draft: dict) -> None:
        verified, failure = self._review_verification(session, draft)
        if not verified:
            raise StaleOutreach("The persisted model review authority could not be verified; verify a new revision.", authorityFailure=failure)
        if draft["gateResults"].get("passed") is not True:
            raise InvalidOutreach("This draft did not pass its persisted claim and quality gates.")
        records = [session.model_record(identifier) for identifier in draft["gateResults"]["determinationIds"]]
        if any(record["value"].get("verdict") != "pass" for record in records if record["operation"] in {"outreach.claims", "outreach.quality"}):
            raise InvalidOutreach("The recorded model review did not pass.")

    def get_thread(self, thread_id: str, connection=None) -> dict:
        with self.store.read(connection) as session:
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            return self._detail(thread, session.connection)

    def thread_for_contact(self, contact_id: str, job_id: str | None = None) -> dict | None:
        if job_id is not None:
            domain.uuid(job_id)
        with self.store.read() as session:
            self.contacts.snapshot(contact_id, connection=session.connection)
            thread = session.for_contact(contact_id, job_id)
            return self._detail(thread, session.connection) if thread else None

    def determinations(self, thread_id: str, draft_id: str) -> dict:
        with self.store.read() as session:
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            draft = domain.find_draft(thread, draft_id)
            records = []
            for identifier in draft["gateResults"].get("determinationIds", []):
                record = session.model_record(identifier)
                if record is None:
                    records.append({"determinationId": identifier, "available": False, "verified": False, "verificationFailure": "record_unavailable"})
                else:
                    verified, failure = verify_record(self.model, record, connection=session.connection)
                    records.append({"determinationId": identifier, "available": True, "verified": verified, "verificationFailure": failure, "operation": record["operation"],
                                    "createdAt": record["createdAt"], "provenance": record["provenance"],
                                    "instructions": record.get("instructions"), "responseSchema": record.get("responseSchema"),
                                    "context": record.get("context"), "sources": record["sources"], "result": record["value"]})
            return {"ok": True, "threadId": thread_id, "draftId": draft_id,
                    "complete": bool(records) and all(record["available"] for record in records),
                    "authorityVerified": self._review_verification(session, draft)[0], "records": records}

    async def generate(self, contact_id: str, payload: dict, *, context=None) -> dict:
        return await self._propose(payload, contact_id=contact_id, context=context)

    async def revise(self, thread_id: str, payload: dict, *, context=None) -> dict:
        return await self._propose(payload, thread_id=thread_id, context=context)

    async def _propose(self, payload: dict, *, contact_id: str | None = None, thread_id: str | None = None, context=None) -> dict:
        request_id = context.run_id if context else None
        request_hash = domain.fingerprint({"action": "revise" if thread_id else "generate", "contactId": contact_id,
                                           "threadId": thread_id, "payload": payload})
        if request_id:
            with self.store.read() as session:
                replay = self._publication_replay(session, request_id, request_hash)
                if replay is not None:
                    return replay
        allowed = {"expectedFingerprint", "kind", "offerRevisionId", "applicationRole", "llmModel"}
        if thread_id:
            allowed.update({"editedBodyText", "sourceDraftId"})
        else:
            allowed.add("jobId")
        if set(payload) - allowed:
            raise InvalidOutreach("The draft request contains unsupported fields.")
        kind = payload.get("kind")
        if kind is not None and (not isinstance(kind, str) or kind not in domain.KINDS):
            raise InvalidOutreach("The outreach message kind is unsupported.")
        if payload.get("offerRevisionId") is not None:
            domain.uuid(payload["offerRevisionId"])
        application_role = payload.get("applicationRole")
        if application_role is not None and (not isinstance(application_role, str) or len(application_role) > 200):
            raise InvalidOutreach("The application role must be at most 200 characters.")
        if payload.get("llmModel") is not None and (not isinstance(payload["llmModel"], str) or not 1 <= len(payload["llmModel"]) <= 120):
            raise InvalidOutreach("The selected model is invalid.")
        edited_body = payload.get("editedBodyText") if thread_id else None
        if thread_id and (not isinstance(edited_body, str) or not 1 <= len(edited_body.strip()) <= 8000):
            raise InvalidOutreach("The revised message must contain 1 to 8000 characters.")
        linked_job = payload.get("jobId")
        if linked_job is not None:
            domain.uuid(linked_job)
        with self.store.read() as session:
            thread = session.thread(thread_id) if thread_id else session.for_contact(contact_id, linked_job)
            if thread_id and thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            if thread:
                if thread_id or "expectedFingerprint" in payload:
                    domain.check_base(thread, payload.get("expectedFingerprint"))
                contact_id, linked_job = thread["contactId"], thread["jobId"]
                base = domain.fingerprint(thread)
                proposed_thread_id = thread["threadId"]
            else:
                if payload.get("expectedFingerprint") is not None:
                    raise StaleOutreach("The expected outreach thread no longer exists.")
                base, proposed_thread_id = None, domain.new_id()
            if thread_id and payload.get("sourceDraftId") is not None:
                original = domain.find_draft(thread, payload["sourceDraftId"])
            else:
                original = thread["drafts"][-1] if thread_id and thread and thread["drafts"] else None
            kind = kind or (original["kind"] if original else "intro_request")
            offer_revision = payload.get("offerRevisionId")
            if offer_revision is None and original and original["kind"].startswith("offer_") and kind.startswith("offer_"):
                offer_revision = original["sourceBinding"]["offer"]["binding"]["termsRevisionId"]
            bundle = self._source_bundle(contact_id, linked_job, kind, offer_revision_id=offer_revision, connection=session.connection)
        proposal = await compose(model=self.model, store=self.store, source_bundle=bundle, kind=kind, edited_body=edited_body,
                                 application_role=application_role, selected_model=payload.get("llmModel"), context=context)
        if context and context.cancelled():
            raise asyncio.CancelledError()
        conflict = {"outcome": "conflict", "threadId": proposed_thread_id, "unpublishedDraft": proposal}
        with self.store.write() as session:
            if request_id:
                replay = self._publication_replay(session, request_id, request_hash)
                if replay is not None:
                    return replay
            current = session.thread(proposed_thread_id) if base else session.for_contact(contact_id, linked_job)
            if (base is None and current is not None) or (base is not None and (current is None or domain.fingerprint(current) != base)):
                if current:
                    conflict["threadId"] = current["threadId"]
                    conflict["currentFingerprint"] = domain.fingerprint(current)
                raise StaleOutreach("The thread changed while verification was running. Review your unpublished proposal against the current thread.", **conflict)
            try:
                self._assert_sources(bundle["binding"], session.connection)
            except Exception:
                raise StaleOutreach("The message sources changed during verification. Your completed proposal remains unpublished.", **conflict) from None
            if context and context.cancelled():
                raise asyncio.CancelledError()
            current = current or domain.new_thread(contact_id, linked_job)
            if base is None:
                current["threadId"] = proposed_thread_id
            generation = max((draft["generation"] for draft in current["drafts"]), default=0) + 1
            for draft in current["drafts"]:
                if draft["status"] == "candidate":
                    draft["status"] = "superseded"
            new_draft = {**copy.deepcopy(proposal), "draftId": domain.new_id(), "threadId": current["threadId"],
                         "generation": generation, "status": "candidate", "sourceBinding": bundle["binding"],
                         "createdAt": domain.now(), "approvedAt": None, "rejectedAt": None, "reason": ""}
            verified, failure = self._review_verification(session, new_draft)
            if not verified:
                raise StaleOutreach("The completed model receipt could not be verified; the proposal remains unpublished.",
                                    **conflict, authorityFailure=failure)
            current["drafts"].append(new_draft)
            domain.bump(current)
            session.put(current)
            session.event("OutreachDraftRevised" if edited_body is not None else "OutreachDraftGenerated", current["threadId"],
                          {"threadId": current["threadId"], "contactId": contact_id, "jobId": linked_job,
                           "draftId": new_draft["draftId"], "generation": generation})
            publication = {"threadId": current["threadId"], "draftId": new_draft["draftId"], "generation": generation}
            if request_id:
                session.put_publication_receipt(request_id, request_hash, publication)
            return {"ok": True, "thread": self._detail(current, session.connection),
                    "publication": publication}

    def _publication_replay(self, session, request_id: str, request_hash: str) -> dict | None:
        receipt = session.publication_receipt(request_id)
        if receipt is None:
            return None
        if receipt["payloadHash"] != request_hash:
            raise StaleOutreach("This durable draft action identity belongs to different input.")
        publication = receipt["publication"]
        current = session.thread(publication["threadId"])
        if current is None or not any(draft["draftId"] == publication["draftId"] and draft["generation"] == publication["generation"]
                                      for draft in current["drafts"]):
            raise StaleOutreach("The accepted draft publication receipt cannot be verified.")
        return {"ok": True, "thread": self._detail(current, session.connection), "publication": publication}

    def review(self, thread_id: str, draft_id: str, payload: dict, *, approve: bool) -> dict:
        if set(payload) - {"expectedFingerprint", "reason"}:
            raise InvalidOutreach("The review request contains unsupported fields.")
        reason = payload.get("reason", "")
        if not isinstance(reason, str) or len(reason) > 500:
            raise InvalidOutreach("The review reason must be at most 500 characters.")
        with self.store.write() as session:
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            domain.check_base(thread, payload.get("expectedFingerprint"))
            draft = domain.find_draft(thread, draft_id)
            if draft["status"] != "candidate":
                raise InvalidOutreach("This draft is not awaiting review.")
            if approve:
                self._assert_sources(draft["sourceBinding"], session.connection)
                self._assert_review_authority(session, draft)
                for previous in thread["drafts"]:
                    if previous["status"] == "approved":
                        previous["status"] = "superseded"
                draft.update(status="approved", approvedAt=domain.now())
            else:
                draft.update(status="rejected", rejectedAt=domain.now(), reason=reason.strip())
            domain.bump(thread)
            session.put(thread)
            session.event("OutreachDraftApproved" if approve else "OutreachDraftRejected", thread_id,
                          {"threadId": thread_id, "draftId": draft_id, "generation": draft["generation"]})
            return {"ok": True, "thread": self._detail(thread, session.connection)}

    def copy_draft(self, thread_id: str, draft_id: str, payload: dict) -> dict:
        if set(payload) != {"expectedFingerprint"}:
            raise InvalidOutreach("Copy requires the exact reviewed thread version.")
        with self.store.write() as session:
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            domain.check_base(thread, payload["expectedFingerprint"])
            draft = domain.find_draft(thread, draft_id)
            if draft["status"] != "approved" or draft["gateResults"].get("passed") is not True:
                raise InvalidOutreach("Only a currently approved draft can be copied.")
            self._assert_sources(draft["sourceBinding"], session.connection)
            self._assert_review_authority(session, draft)
            return {"ok": True, "draftId": draft_id, "bodyText": draft["bodyText"]}

    def log_send(self, thread_id: str, payload: dict) -> dict:
        if set(payload) != {"requestId", "draftId", "channel", "sentAt"}:
            raise InvalidOutreach("A send attestation requires its exact request identity, draft, channel and time.")
        request_id = domain.uuid(payload["requestId"])
        if not isinstance(payload["channel"], str) or payload["channel"] not in domain.CHANNELS:
            raise InvalidOutreach("Choose a supported channel label.")
        domain.timestamp(payload["sentAt"])
        payload_hash = domain.fingerprint({"action": "outreach.send-log", "threadId": thread_id, "payload": payload})
        with self.store.write() as session:
            receipt = session.receipt(request_id)
            if receipt:
                if receipt["payloadHash"] != payload_hash:
                    raise StaleOutreach("This request identity already records a different send attestation.")
                # Replay precedes current-source/review checks. An acknowledgement
                # retry reads the original fact and never restores older thread state.
                return {"ok": True, "sendLog": receipt["sendLog"]}
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            draft = domain.find_draft(thread, payload["draftId"])
            if draft["status"] != "approved":
                raise InvalidOutreach("A fresh send attestation requires the currently approved draft.")
            self._assert_sources(draft["sourceBinding"], session.connection)
            self._assert_review_authority(session, draft)
            send_log = {"sendLogId": domain.new_id(), "threadId": thread_id, "draftId": draft["draftId"],
                        "channel": payload["channel"], "sentAt": payload["sentAt"], "loggedAt": domain.now()}
            thread["sendLogs"].append(send_log)
            domain.bump(thread)
            session.put(thread)
            session.put_receipt(request_id, payload_hash, send_log)
            session.event("OutreachSendLogged", thread_id, {"threadId": thread_id, "draftId": draft["draftId"], "sendLogId": send_log["sendLogId"]})
            return {"ok": True, "sendLog": copy.deepcopy(send_log)}

    def follow_up(self, thread_id: str, payload: dict, *, action: str) -> dict:
        if set(payload) - {"expectedFingerprint", "dueAt", "basis", "hasLoggedReply"}:
            raise InvalidOutreach("The follow-up request contains unsupported fields.")
        if action not in {"schedule", "complete", "dismiss"}:
            raise InvalidOutreach("The follow-up action is unsupported.")
        with self.store.write() as session:
            thread = session.thread(thread_id)
            if thread is None:
                raise OutreachMissing("The outreach thread does not exist.")
            domain.check_base(thread, payload.get("expectedFingerprint"))
            if action == "schedule":
                if "hasLoggedReply" in payload and not isinstance(payload["hasLoggedReply"], bool):
                    raise InvalidOutreach("Reply status must be an explicit boolean.")
                submitted_at = None
                if self.applications is not None and thread["jobId"]:
                    reader = getattr(self.applications, "outreach_context", None)
                    if reader:
                        submitted_at = reader(thread["jobId"], connection=session.connection).get("submitted_at")
                if payload.get("dueAt"):
                    due, basis = domain.timestamp(payload["dueAt"]), "manual"
                else:
                    suggestion = domain.suggested_follow_up(thread, submitted_at=submitted_at, has_reply=payload.get("hasLoggedReply", False))
                    if suggestion is None:
                        raise InvalidOutreach("Record an application submission first, or provide an explicit due date; no automatic suggestion is available after a reply.")
                    due, basis = suggestion
                basis = payload.get("basis", basis)
                if not isinstance(basis, str) or basis not in {"application_submitted", "no_reply_nudge", "manual"}:
                    raise InvalidOutreach("The follow-up basis is unsupported.")
                thread["followUp"] = {"state": "scheduled", "dueAt": due, "basis": basis}
            else:
                if not thread["followUp"] or thread["followUp"]["state"] != "scheduled":
                    raise InvalidOutreach("Only a scheduled reminder can be completed or dismissed.")
                thread["followUp"]["state"] = "completed" if action == "complete" else "dismissed"
            domain.bump(thread)
            session.put(thread)
            event = {"schedule": "FollowUpScheduled", "complete": "FollowUpCompleted", "dismiss": "FollowUpDismissed"}[action]
            session.event(event, thread_id, {"threadId": thread_id, "state": thread["followUp"]["state"]})
            return {"ok": True, "thread": self._detail(thread, session.connection)}

    def due_follow_ups(self) -> list[dict]:
        instant = datetime.now(timezone.utc)
        with self.store.read() as session:
            results = []
            for thread in session.threads():
                reminder = thread["followUp"]
                if reminder and reminder["state"] == "scheduled" and domain.is_due(reminder["dueAt"], instant):
                    results.append({"threadId": thread["threadId"], "contactId": thread["contactId"], "jobId": thread["jobId"],
                                    **copy.deepcopy(reminder), "isDue": True})
            return sorted(results, key=lambda row: (row["dueAt"], row["threadId"]))
