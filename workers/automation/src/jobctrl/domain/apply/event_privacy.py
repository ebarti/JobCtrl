"""References for Apply events that can carry private email or agent output."""

from typing import Any


def _private_carrier(event_type: str) -> bool:
    return event_type.startswith("EmailApplication") or event_type == "AgentResult"


def email_event_references(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if event_type == "ApplyRunEventRecorded":
        event = payload.get("event")
        if isinstance(event, dict) and _private_carrier(str(event.get("event_type", event.get("eventType", "")))):
            return {"run_id": payload.get("run_id"), "event": {
                key: event[key] for key in ("event_id", "event_type", "occurred_at", "level") if key in event
            }}
    if not _private_carrier(event_type):
        return payload
    return {key: payload[key] for key in (
        "tenantId", "jobId", "run_id", "event_id", "stage", "level", "apply_status", "reason",
    ) if key in payload}
