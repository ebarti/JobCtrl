"""Reviewable messages, explicit attestations and surfaced reminders."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from uuid import UUID, uuid4

KINDS = frozenset({"intro_request", "follow_up", "offer_negotiation", "offer_clarification", "offer_acceptance", "offer_decline"})
CHANNELS = frozenset({"email", "personal_email", "work_email", "linkedin_message", "phone_call", "other"})


class InvalidOutreach(ValueError):
    pass


class OutreachMissing(LookupError):
    pass


class StaleOutreach(ValueError):
    def __init__(self, message: str, **details):
        super().__init__(message)
        self.details = details


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid4())


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def timestamp(value: object) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 40:
        raise InvalidOutreach("A valid date and time are required.")
    try:
        if len(value) == 10 and date.fromisoformat(value).isoformat() == value:
            return value
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise InvalidOutreach("A valid date and time are required.") from None
    if parsed.tzinfo is None:
        raise InvalidOutreach("Dates and times must include a time zone.")
    return value


def is_due(value: str, instant: datetime) -> bool:
    timestamp(value)
    if len(value) == 10:
        return date.fromisoformat(value) <= instant.date()
    return datetime.fromisoformat(value.replace("Z", "+00:00")) <= instant


def _add_days(value: str, days: int) -> str:
    timestamp(value)
    if len(value) == 10:
        return (date.fromisoformat(value) + timedelta(days=days)).isoformat()
    return (datetime.fromisoformat(value.replace("Z", "+00:00")) + timedelta(days=days)).isoformat()


def uuid(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidOutreach("The action requires a canonical request UUID.")
    try:
        parsed = str(UUID(value))
    except ValueError:
        raise InvalidOutreach("The action requires a canonical request UUID.") from None
    if value != parsed:
        raise InvalidOutreach("The action requires a canonical request UUID.")
    return parsed


def new_thread(contact_id: str, job_id: str | None) -> dict:
    created = now()
    return {"threadId": new_id(), "contactId": contact_id, "jobId": job_id, "revision": 1,
            "createdAt": created, "updatedAt": created, "drafts": [], "sendLogs": [], "followUp": None}


def check_base(thread: dict, expected: object) -> None:
    if expected != fingerprint(thread):
        raise StaleOutreach("This thread changed. Review the current thread before retrying.",
                            threadId=thread["threadId"], currentFingerprint=fingerprint(thread))


def bump(thread: dict) -> None:
    thread["revision"] += 1
    thread["updatedAt"] = now()


def find_draft(thread: dict, draft_id: str) -> dict:
    result = next((draft for draft in thread["drafts"] if draft["draftId"] == draft_id), None)
    if result is None:
        raise OutreachMissing("The outreach draft does not exist.")
    return result


def detail(thread: dict, *, source_checker=None) -> dict:
    result = copy.deepcopy(thread)
    result["fingerprint"] = fingerprint(thread)
    approved = next((draft for draft in thread["drafts"] if draft["status"] == "approved"), None)
    drafts = result["drafts"]
    result.update(draftCount=len(drafts), latestGeneration=max((draft["generation"] for draft in drafts), default=0),
                  hasApprovedDraft=approved is not None, approvedDraftId=approved["draftId"] if approved else None,
                  latestStatus=drafts[-1]["status"] if drafts else None, isSent=bool(thread["sendLogs"]))
    for draft in drafts:
        if source_checker:
            draft["sourcesCurrent"] = source_checker(draft)
            if draft["kind"].startswith("offer_"):
                draft["offerSourcesCurrent"] = draft["sourcesCurrent"]
        draft.pop("sourceBinding", None)
    return result


def suggested_follow_up(thread: dict, *, submitted_at: str | None = None, has_reply: bool = False) -> tuple[str, str] | None:
    if has_reply or not submitted_at:
        return None
    previous_due = (thread.get("followUp") or {}).get("dueAt")
    if previous_due:
        return _add_days(previous_due, 14), "no_reply_nudge"
    return _add_days(submitted_at, 7), "application_submitted"
