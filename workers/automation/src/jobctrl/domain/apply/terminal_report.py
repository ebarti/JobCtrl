"""The inspection agent owns terminal meaning and retryability."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Literal
from pydantic import Field, StrictBool, StrictStr
from jobctrl.domain.determinations import (
    Citation,
    DeterminationEnvelope,
    DeterminationFailure,
    DeterminationModel,
    Source,
    parse_model_result,
    validate_citations,
)
from jobctrl.domain.apply.value_objects import (
    Captcha,
    DryRunComplete,
    EmailOnlyApplication,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    SubmissionResult,
)

PROMPT_VERSION = "apply-terminal-report-v1"


class ApplyTerminalReport(DeterminationModel):
    status: Literal[
        "applied", "dry_run_complete", "expired", "captcha", "login_issue", "manual", "email_only", "failed"
    ]
    retryable: StrictBool
    reason: StrictStr = Field(min_length=1, max_length=500)
    recipient_email: StrictStr | None
    citations: list[Citation] = Field(min_length=1, max_length=20)
    rationale: StrictStr = Field(min_length=1, max_length=1000)


def parse_terminal_report(output: str, observations: str) -> ApplyTerminalReport:
    try:
        raw = json.loads(output)
    except (json.JSONDecodeError, TypeError):
        raise DeterminationFailure("malformed_json") from None
    result = parse_model_result(ApplyTerminalReport, raw)
    validate_citations(result, [Source(source_id="browser_observations", text=observations)])
    if result.status != "failed" and result.retryable:
        raise DeterminationFailure("schema_violation")
    if result.status == "email_only":
        email = result.recipient_email
        if not email or not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", email):
            raise DeterminationFailure("schema_violation")
        if not any(email in citation.quote for citation in result.citations):
            raise DeterminationFailure("mismatched_value")
    elif result.recipient_email is not None:
        raise DeterminationFailure("schema_violation")
    return result


def submission_from_report(result: ApplyTerminalReport, *, dry_run: bool) -> SubmissionResult:
    if result.status == "applied":
        return Failed(error="untrusted_applied_result", retryable=False)
    if result.status == "dry_run_complete":
        if not dry_run:
            return Failed(error="unexpected_dry_run_result", retryable=False)
        return DryRunComplete(navigated_to="", coverage="partial", blocked_channels=("semantic_review_unverified",))
    if result.status == "expired":
        return Expired()
    if result.status == "captcha":
        return Captcha(details=result.reason)
    if result.status == "login_issue":
        return LoginIssue(details=result.reason)
    if result.status == "manual":
        return Manual(reason=result.reason)
    if result.status == "email_only":
        return EmailOnlyApplication(recipient_email=result.recipient_email or "")
    return Failed(error=result.reason, retryable=result.retryable)


def report_envelope(*, report, tenant_id, run_id, model, input_fingerprint):
    identity = {
        "kind": "apply_terminal_report",
        "tenant_id": str(tenant_id),
        "entity_id": str(run_id),
        "provider": "claude",
        "model": model,
        "schema_version": "1",
        "prompt_version": PROMPT_VERSION,
        "input_fingerprint": input_fingerprint,
    }
    determination_id = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return DeterminationEnvelope(
        determination_id=determination_id,
        tenant_id=str(tenant_id),
        entity_id=str(run_id),
        kind="apply_terminal_report",
        schema_version="1",
        prompt_version=PROMPT_VERSION,
        provider="claude",
        model=model,
        lane="apply",
        input_fingerprint=determination_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        result=report.model_dump(),
    )
