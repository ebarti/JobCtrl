"""References for broad email events; canonical Apply Review keeps the preview."""

from typing import Any


def email_event_references(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if event_type == "ApplyRunEventRecorded":
        event = payload.get("event")
        if isinstance(event, dict) and str(event.get("event_type", "")).startswith("EmailApplication"):
            return {"run_id": payload.get("run_id"), "event": {
                key: event[key] for key in ("event_id", "event_type", "occurred_at", "level") if key in event
            }}
    if not event_type.startswith("EmailApplication"):
        return payload
    return {key: payload[key] for key in (
        "tenantId", "jobId", "run_id", "event_id", "stage", "level", "apply_status", "reason",
    ) if key in payload}
