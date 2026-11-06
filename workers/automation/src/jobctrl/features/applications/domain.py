"""Application value objects; no transport, persistence or worker dependencies."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def copied(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


class ApplicationFailure(Exception):
    """An allow-listed code, never a private provider message or document."""

    def __init__(self, code: str, *, conflict: bool = False):
        self.code, self.conflict = code, conflict
        super().__init__(code)


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class Prepare(Command):
    expectedVersion: StrictInt = Field(ge=0)
    idempotencyKey: StrictStr = Field(min_length=1, max_length=160)
    mode: Literal["browser", "email"]
    recipient: StrictStr | None = Field(default=None, min_length=1, max_length=320)
    subject: StrictStr | None = Field(default=None, min_length=1, max_length=998)
    body: StrictStr | None = Field(default=None, min_length=1, max_length=32000)

    @field_validator("recipient", "subject")
    @classmethod
    def no_header_injection(cls, value):
        if value is not None and ("\r" in value or "\n" in value or "\x00" in value):
            raise ValueError("invalid_email_header")
        return value


class Review(Command):
    expectedVersion: StrictInt = Field(ge=1)
    idempotencyKey: StrictStr = Field(min_length=1, max_length=160)
    decision: Literal["approve_submit", "approve_dry_run", "defer", "decline", "reset"]
    payloadId: StrictStr | None = None
    payloadSha256: StrictStr | None = None
    rehearsalId: StrictStr | None = None
    partialOverrideRunId: StrictStr | None = None
    reason: StrictStr | None = Field(default=None, max_length=4000)


class Stop(Command):
    expectedVersion: StrictInt = Field(ge=0)
    idempotencyKey: StrictStr = Field(min_length=1, max_length=160)
    action: Literal["skip", "cancel", "reset", "mark_failed"] = "skip"
    resetAttempts: bool = False


class Execute(Command):
    jobId: StrictStr = Field(min_length=1, max_length=240)
    payloadId: StrictStr = Field(min_length=1, max_length=240)
    approvalId: StrictStr = Field(min_length=1, max_length=240)


class Rehearse(Command):
    jobId: StrictStr = Field(min_length=1, max_length=240)
    payloadId: StrictStr = Field(min_length=1, max_length=240)


class Batch(Command):
    items: list[Execute] = Field(min_length=1, max_length=100)
    workers: StrictInt | None = Field(default=None, ge=1, le=8)


class ApprovedBatch(Command):
    limit: StrictInt = Field(default=25, ge=1, le=100)
    workers: StrictInt | None = Field(default=None, ge=1, le=8)
    min_fit_score: StrictInt | None = Field(default=None, ge=1, le=10)
    url: StrictStr | None = Field(default=None, min_length=1, max_length=4000)
    dry_run: bool = False


class MailPort(Protocol):
    async def send(self, *, recipient: str, subject: str, body: str, attachment_bytes: bytes,
                   attachment_name: str) -> dict[str, str]: ...


class ModelPort(Protocol):
    async def determine(self, *, operation: str, instructions: str, sources: list[dict],
                        response_schema: dict, context: dict | None = None,
                        prompt_version: str = "1", lane: str = "interactive", model: str | None = None,
                        require_accounting: bool = False): ...


# Literal Profile field paths are an I/O allow-list, never a meaning classifier.
AUTOFILL_PATHS = (
    ("personal.full_name", "Full name"), ("personal.preferred_name", "Preferred name"),
    ("personal.email", "Email"), ("personal.phone", "Phone"), ("personal.address", "Address"),
    ("personal.city", "City"), ("personal.province_state", "State / province"),
    ("personal.country", "Country"), ("personal.postal_code", "Postal code"),
    ("personal.linkedin_url", "LinkedIn URL"), ("personal.github_url", "GitHub URL"),
    ("personal.portfolio_url", "Portfolio URL"), ("personal.website_url", "Website URL"),
    ("work_authorization.legally_authorized_to_work", "Legally authorized to work"),
    ("work_authorization.require_sponsorship", "Requires sponsorship"),
    ("work_authorization.work_permit_type", "Work permit type"),
    ("compensation.salary_expectation", "Salary expectation"), ("compensation.salary_currency", "Currency"),
    ("compensation.salary_range_min", "Salary range minimum"),
    ("compensation.salary_range_max", "Salary range maximum"),
    ("availability.earliest_start_date", "Earliest start date"),
    ("availability.available_for_full_time", "Full time"),
    ("availability.available_for_contract", "Contract"),
    ("eeo_voluntary.gender", "Voluntary EEO gender"),
    ("eeo_voluntary.race_ethnicity", "Voluntary EEO race / ethnicity"),
    ("eeo_voluntary.veteran_status", "Voluntary EEO veteran status"),
    ("eeo_voluntary.disability_status", "Voluntary EEO disability status"),
    ("application_attestations.age_18_plus", "Age 18 or older"),
    ("application_attestations.background_check_consent", "Background check consent"),
    ("application_attestations.felony_conviction", "Felony conviction"),
    ("application_attestations.previously_worked_at_employer", "Previously worked at employer"),
    ("application_preferences.how_heard", "How heard about opening"),
)


def autofill_fields(document: dict) -> list[dict]:
    fields = []
    for path, label in AUTOFILL_PATHS:
        value: Any = document
        for segment in path.split("."):
            value = value.get(segment) if isinstance(value, dict) else None
        if value is None or value == "" or isinstance(value, (dict, list)):
            continue
        text = str(value).lower() if isinstance(value, bool) else str(value)
        fields.append({"path": path, "label": label, "value": text,
                       "source": {"kind": "profile", "path": path, "label": label}})
    return fields


def require_destination(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme == "mailto":
        return value
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        raise ApplicationFailure("application_destination_invalid")
    return value


def automatic_source_allowed(posting: dict) -> bool:
    """Retained literal distribution exclusions, not semantic classification."""
    blocked_sources = {"glassdoor", "google", "accenture", "AccentureCareers", "Workopolis"}
    fragments = ("glassdoor", "google.com/about/careers", "google.jobs", "accenture", "workopolis.com/out")
    return not (posting.get("quarantined") or posting.get("source_id") in blocked_sources
                or any(fragment in (posting.get("url") or "").lower() for fragment in fragments))


def confirmed_receipt(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"].strip():
        raise ApplicationFailure("application_receipt_invalid")
    result = {"id": value["id"]}
    if "threadId" in value:
        if not isinstance(value["threadId"], str) or not value["threadId"].strip():
            raise ApplicationFailure("application_receipt_invalid")
        result["threadId"] = value["threadId"]
    return result
