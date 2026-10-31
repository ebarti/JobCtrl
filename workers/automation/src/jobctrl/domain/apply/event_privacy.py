"""Broad Apply notifications contain references, never agent text or email previews.

The canonical ledger and determination store retain source-bound review data.
Historical ambiguity reasons are parsed only as an exact producer error-code
format; no content or semantic classification participates in redaction.
"""

from typing import Any


_PRIVATE_CARRIERS = frozenset({"AgentResult", "AssistantText", "ToolUse", "ApplyTerminalDetermination"})
_REFERENCES = (
    "tenantId", "jobId", "job_id", "run_id", "runId", "event_id", "eventId",
    "stage", "level", "apply_status", "determination_id", "attempt_number", "attemptNumber",
)
_AMBIGUOUS = "email_send_outcome_ambiguous"
AMBIGUOUS_APPLY_MESSAGE = "Apply reached submit intent; verify the employer site or confirmation email before retrying."


def public_apply_error_message(error_code: str | None, message: str | None) -> str | None:
    return AMBIGUOUS_APPLY_MESSAGE if error_code == "APPLY_NEEDS_VERIFICATION" else message


def _email_failure(payload: dict[str, Any]) -> bool:
    result = payload.get("result")
    values = [payload.get("reason"), payload.get("error")]
    if isinstance(result, dict):
        values.extend((result.get("reason"), result.get("error")))
    return any(isinstance(value, str) and (value == _AMBIGUOUS or value.startswith(_AMBIGUOUS + ":")) for value in values)


def private_apply_event(event_type: str, payload: dict[str, Any]) -> bool:
    return (
        event_type.startswith("EmailApplication") or event_type in _PRIVATE_CARRIERS
        or (event_type == "ApplicationFailed" and _email_failure(payload))
    )


def email_event_references(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if event_type == "ApplyRunEventRecorded":
        event = payload.get("event")
        if isinstance(event, dict):
            nested_type = str(event.get("event_type", event.get("eventType", "")))
            nested_payload = event.get("payload")
            if private_apply_event(nested_type, nested_payload if isinstance(nested_payload, dict) else event):
                return {
                    **{key: payload[key] for key in _REFERENCES if key in payload},
                    "event": {key: event[key] for key in (
                        "event_id", "eventId", "event_type", "eventType", "occurred_at", "occurredAt", "level",
                    ) if key in event},
                }
    if not private_apply_event(event_type, payload):
        return payload
    safe = {key: payload[key] for key in _REFERENCES if key in payload}
    if event_type == "ApplicationFailed":
        safe["reason"] = _AMBIGUOUS
        result = payload.get("result")
        if isinstance(result, dict):
            safe["result"] = {"kind": "failed", "error": _AMBIGUOUS, "retryable": False}
        elif result in ("failed", "needs_verification"):
            safe["result"] = result
    return safe
