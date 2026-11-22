"""Canonical contact actions, shared by HTTP, CLI and durable research."""

from __future__ import annotations

import copy
from typing import Any

from . import domain
from .domain import InvalidContact, StaleContact
from .imports import issue, parse_import
from .authority import verify_record
from .ports import ContactsStore, JobsReader


class ContactMissing(LookupError):
    pass


class ContactsService:
    def __init__(self, store: ContactsStore, *, jobs: JobsReader | None = None, model=None, fetcher_factory=None):
        self.store, self.jobs, self.model, self.fetcher_factory = store, jobs, model, fetcher_factory

    def _linked_job(self, identifier: str | None, connection: Any = None):
        if identifier:
            if self.jobs is None:
                raise InvalidContact("The Jobs feature is unavailable; link this contact to an employer instead.")
            try:
                snapshot = self.jobs.get_posting_snapshot(identifier, connection=connection)
            except Exception:
                raise InvalidContact("The linked job does not exist or is unavailable.") from None
            if not snapshot:
                raise InvalidContact("The linked job does not exist.")

    def get_contact(self, contact_id: str, connection: Any = None) -> dict:
        with self.store.read(connection) as session:
            record = session.contact(contact_id)
            if record is None:
                raise ContactMissing("The contact does not exist.")
            return domain.detail(record)

    def snapshot(self, contact_id: str, connection: Any = None) -> dict:
        return self.get_contact(contact_id, connection)

    def assert_current(self, snapshot: dict, connection: Any = None) -> None:
        if self.get_contact(snapshot["contactId"], connection)["fingerprint"] != snapshot["fingerprint"]:
            raise StaleContact("The contact source changed during this action.")

    def list_contacts(self, *, employer: str | None = None, job_id: str | None = None) -> list[dict]:
        linked = domain.job_id(job_id)
        with self.store.read() as session:
            return [domain.summary(record) for record in session.contacts()
                    if (not employer or record["employer"] == employer) and (not linked or record["jobId"] == linked)]

    @staticmethod
    def _publish_contact(session, record: dict, event: str) -> None:
        session.put_contact(record)
        session.event(event, record["contactId"], {"contactId": record["contactId"], "jobId": record["jobId"], "revision": record["revision"]})

    def create(self, payload: dict) -> dict:
        record = domain.create_record(payload)
        with self.store.write() as session:
            self._linked_job(record["jobId"], session.connection)
            self._publish_contact(session, record, "ContactCreated")
            return domain.detail(record)

    def update(self, contact_id: str, payload: dict) -> dict:
        with self.store.write() as session:
            current = session.contact(contact_id)
            if current is None:
                raise ContactMissing("The contact does not exist.")
            record = domain.revise_record(current, payload)
            self._linked_job(record["jobId"], session.connection)
            self._publish_contact(session, record, "ContactUpdated")
            return domain.detail(record)

    def delete(self, contact_id: str, payload: dict | None = None) -> dict:
        payload = payload or {}
        if set(payload) - {"reason", "expectedFingerprint"}:
            raise InvalidContact("The delete request contains unsupported fields.")
        domain.text(payload.get("reason"), limit=400)
        with self.store.write() as session:
            record = session.contact(contact_id)
            if record is None:
                raise ContactMissing("The contact does not exist.")
            if payload.get("expectedFingerprint") is not None and payload["expectedFingerprint"] != domain.fingerprint(record):
                raise StaleContact("This contact changed before deletion.")
            record["deletedAt"] = record["updatedAt"] = domain.now()
            record["revision"] += 1
            self._publish_contact(session, record, "ContactDeleted")
            return {"ok": True, "contactId": contact_id, "deletedAt": record["deletedAt"]}

    def import_contacts(self, payload: dict) -> dict:
        filename, format, mode, parsed = parse_import(payload)
        # Preview and commit run the identical evaluation. The commit reserves the
        # writer before duplicate checks, including independently racing imports.
        with (self.store.write() if mode == "commit" else self.store.read()) as session:
            active = [(record, "existing", None) for record in session.contacts()]
            items, contact_ids = [], []
            for index, candidate in enumerate(parsed):
                item = {**copy.deepcopy(candidate), "index": index, "status": "ready", "duplicate": None, "importedContactId": None}
                record = None
                try:
                    record = domain.create_record({key: candidate[key] for key in ("employer", "jobId", "role", "attributes")},
                                                  source=domain.provenance(filename, source_kind="user_imported_list"))
                    self._linked_job(record["jobId"], session.connection)
                except (InvalidContact, LookupError):
                    item["issues"].append(issue("invalid_contact", "The contact has invalid facts or an unavailable employer/job link."))
                if any(entry["severity"] == "error" for entry in item["issues"]):
                    item["status"] = "invalid"
                elif record is not None:
                    ids = domain.identifiers(record)
                    matches = [(other, scope, ordinal) for other, scope, ordinal in active
                               if (bool(ids & domain.identifiers(other)) if ids else domain.normalized_record(record) == domain.normalized_record(other))]
                    if len(matches) > 1:
                        item["status"] = "invalid"
                        item["issues"].append(issue("ambiguous_duplicate", "Identifiers match several contacts; no record was merged."))
                    elif matches:
                        other, scope, ordinal = matches[0]
                        item["status"] = "duplicate"
                        item["duplicate"] = {"scope": scope, "contactId": other["contactId"] if scope == "existing" else None, "itemIndex": ordinal}
                    else:
                        active.append((record, "batch", index))
                        if mode == "commit":
                            self._publish_contact(session, record, "ContactCreated")
                            contact_ids.append(record["contactId"])
                            item["importedContactId"] = record["contactId"]
                items.append(item)
            counts = {key: sum(item["status"] == key for item in items) for key in ("ready", "duplicate", "invalid")}
            return {"ok": True, "format": format, "mode": mode, "imported": len(contact_ids),
                    "skipped": counts["duplicate"] + counts["invalid"], "contactIds": contact_ids, "items": items,
                    "summary": {"total": len(items), "ready": counts["ready"], "duplicates": counts["duplicate"], "invalid": counts["invalid"],
                                "unsupported": sum(any(entry["code"].startswith("unsupported_") for entry in item["issues"]) for item in items)}}

    def get_research(self, task_id: str, connection: Any = None) -> dict:
        with self.store.read(connection) as session:
            task = session.task(task_id)
            if task is None:
                raise ContactMissing("The research task does not exist.")
            return self._research_view(session, task)

    def _candidate_authority(self, session, candidate: dict) -> tuple[bool, str | None]:
        authority = session.model_record(candidate.get("determinationId", ""))
        verified, failure = verify_record(self.model, authority, connection=session.connection)
        if not verified:
            return False, failure
        if authority.get("accepted") is not True or authority.get("operation") != "contacts.extract":
            return False, "extraction_not_accepted"
        try:
            ordinal = candidate["modelCandidateIndex"]
            if type(ordinal) is not int or ordinal < 0:
                return False, "candidate_binding_mismatch"
            result = authority["value"]["candidates"][ordinal]
            if result["role"] != candidate["role"] or result["confidence"] != candidate["confidence"]:
                return False, "candidate_binding_mismatch"
            expected = []
            texts = {source["source_id"]: source["text"] for source in authority["sources"]}
            for field, kind in (("name", "name"), ("title", "title"), ("email", "email"), ("profileUrl", "profile_url")):
                span = result.get(field)
                if span is not None:
                    expected.append((kind, texts[span["source_id"]][span["start"]:span["end"]],
                                     {"sourceId": span["source_id"], "start": span["start"], "end": span["end"]}))
            actual = [(fact["kind"], fact["value"], fact["sourceSpan"]) for fact in candidate["attributes"]]
            if expected != actual or candidate["provenance"]["sourceRef"] != authority["context"]["sourceRef"]:
                return False, "candidate_binding_mismatch"
        except (KeyError, IndexError, TypeError):
            return False, "candidate_binding_mismatch"
        return True, None

    def _research_view(self, session, task: dict) -> dict:
        result = copy.deepcopy(task)
        accepted = []
        for attempt in result["sourceAttempts"]:
            identifier = attempt.get("determinationId")
            record = session.model_record(identifier) if identifier else None
            verified, failure = verify_record(self.model, record, connection=session.connection)
            attempt["receiptVerified"] = verified
            attempt["authorityVerified"] = verified and record.get("accepted") is True if record else False
            attempt["authorityFailure"] = failure
            if attempt["outcome"] in {"allowed", "no_candidates"}:
                accepted.append(attempt["authorityVerified"])
                if not attempt["authorityVerified"]:
                    attempt["recordedOutcome"] = attempt["outcome"]
                    attempt["outcome"] = "extraction_failed"
                    attempt["detail"] = "The recorded model authority is unavailable or unverifiable; the prior result is retained without renewed authority."
        for candidate in result["candidates"]:
            verified, failure = self._candidate_authority(session, candidate)
            candidate["authorityVerified"], candidate["authorityFailure"] = verified, failure
        result["reviewAuthorityVerified"] = bool(accepted) and all(accepted)
        return {**research_summary(result), "sourceAttempts": result["sourceAttempts"], "candidates": result["candidates"]}

    def list_research(self, *, employer: str | None = None, job_id: str | None = None) -> list[dict]:
        linked = domain.job_id(job_id)
        with self.store.read() as session:
            return [research_summary(task) for task in session.tasks()
                    if (not employer or task["employer"] == employer) and (not linked or task["jobId"] == linked)]

    def research_determinations(self, task_id: str) -> dict:
        with self.store.read() as session:
            task = session.task(task_id)
            if task is None:
                raise ContactMissing("The research task does not exist.")
            identifiers = dict.fromkeys(attempt.get("determinationId") for attempt in task["sourceAttempts"] if attempt.get("determinationId"))
            records = []
            for identifier in identifiers:
                record = session.model_record(identifier)
                if record is None:
                    records.append({"determinationId": identifier, "available": False, "verified": False, "verificationFailure": "record_unavailable"})
                else:
                    verified, failure = verify_record(self.model, record, connection=session.connection)
                    records.append({"determinationId": identifier, "available": True, "verified": verified, "verificationFailure": failure, "accepted": record.get("accepted") is True,
                                    "operation": record["operation"], "createdAt": record["createdAt"], "provenance": record["provenance"],
                                    "instructions": record.get("instructions"), "responseSchema": record.get("responseSchema"),
                                    "context": record.get("context"), "sources": record["sources"], "result": record["value"]})
            return {"ok": True, "taskId": task_id, "complete": bool(records) and all(record["available"] for record in records),
                    "authorityVerified": bool(records) and all(record.get("verified") is True for record in records), "records": records}

    def confirm_candidate(self, task_id: str, candidate_id: str, payload: dict) -> dict:
        if set(payload) - {"role", "expectedRevision"}:
            raise InvalidContact("The candidate confirmation contains unsupported fields.")
        with self.store.write() as session:
            task = session.task(task_id)
            if task is None:
                raise ContactMissing("The research task does not exist.")
            if payload.get("expectedRevision", task["revision"]) != task["revision"]:
                raise StaleContact("The research task changed before confirmation.")
            candidate = next((item for item in task["candidates"] if item["candidateId"] == candidate_id), None)
            if candidate is None:
                raise ContactMissing("The research candidate does not exist.")
            if candidate["status"] == "confirmed":
                contact = session.contact(candidate["confirmedContactId"])
                if contact:
                    return {"ok": True, "contact": domain.detail(contact), "task": research_summary(task)}
            if candidate["status"] != "needs_review":
                raise InvalidContact("The research candidate is not awaiting review.")
            authority = session.model_record(candidate.get("determinationId", ""))
            verified, _ = self._candidate_authority(session, candidate)
            if not verified:
                raise StaleContact("The research determination authority is unavailable; retry research before confirmation.")
            source_texts = {source["source_id"]: source["text"] for source in authority["sources"]}
            for fact in candidate["attributes"]:
                span = fact.get("sourceSpan", {})
                source = source_texts.get(span.get("sourceId"))
                if source is None or source[span["start"]:span["end"]] != fact["value"]:
                    raise InvalidContact("The research candidate no longer matches its recorded source span.")
            record = domain.create_record({"employer": task["employer"], "jobId": task["jobId"], "role": payload.get("role", candidate["role"]), "attributes": []})
            self._linked_job(record["jobId"], session.connection)
            record["attributes"] = copy.deepcopy(candidate["attributes"])
            for fact in record["attributes"]:
                fact["provenance"]["userConfirmed"] = True
            self._publish_contact(session, record, "ContactCreated")
            candidate.update(status="confirmed", confirmedContactId=record["contactId"], confirmedAt=domain.now())
            task["revision"] += 1
            task["updatedAt"] = domain.now()
            if not any(item["status"] == "needs_review" for item in task["candidates"]):
                task["status"], task["completedAt"] = "completed", task["updatedAt"]
            session.put_task(task)
            session.event("ContactCandidateConfirmed", task_id, {"taskId": task_id, "candidateId": candidate_id, "contactId": record["contactId"]})
            return {"ok": True, "contact": domain.detail(record), "task": research_summary(task)}

    async def research(self, payload: dict, *, context=None) -> dict:
        from .research import run_research

        return await run_research(self, payload, context=context)

    def validate_research(self, payload: dict) -> None:
        from .research import validate_request

        _, linked, _ = validate_request(payload)
        self._linked_job(linked)

    def queue_research(self, payload: dict) -> None:
        from .research import queued_task

        task = queued_task(payload, payload["taskId"])
        with self.store.write() as session:
            current = session.task(task["taskId"])
            if current:
                if current["request"] != task["request"]:
                    raise StaleContact("The research identity already belongs to different sources.")
                return  # A worker may already have started or completed this task.
            task["revision"] = 1
            session.put_task(task)
            session.event("ContactResearchTaskStarted", task["taskId"], {"taskId": task["taskId"], "jobId": task["jobId"], "status": "queued"})


def research_summary(task: dict) -> dict:
    result = {key: copy.deepcopy(value) for key, value in task.items() if key not in {"candidates", "sourceAttempts", "request"}}
    result.update(candidateCount=len(task["candidates"]), needsReviewCount=sum(item["status"] == "needs_review" for item in task["candidates"]),
                  confirmedCount=sum(item["status"] == "confirmed" for item in task["candidates"]))
    return result
