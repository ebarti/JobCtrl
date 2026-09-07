"""Public fetch diagnostics exclude raw URLs and remote exception text."""

from __future__ import annotations

from datetime import datetime
import json
import re
from typing import Any

from jobctrl.infrastructure.network.fetch_failures import PublicFetchFailureKind

_STATUSES = {"waiting", "retry_ready", "checks_exhausted", "stopped"}


def _timestamp(value: object) -> str | None:
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d"
        r"(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value,
    ):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if parsed.tzinfo is not None else None


def fetch_failure_from_stage_metadata(value: str | None) -> dict[str, Any] | None:
    try:
        metadata = json.loads(value or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(metadata, dict) or not isinstance(failure := metadata.get("fetchFailure"), dict):
        return None
    try:
        kind = PublicFetchFailureKind(failure.get("kind"))
    except (TypeError, ValueError):
        return None
    recovery = metadata.get("fetchRecovery")
    if not isinstance(recovery, dict):
        recovery = {}
    status, count = recovery.get("status"), recovery.get("checkCount")
    has_recovery = isinstance(status, str) and status in _STATUSES and type(count) is int and 1 <= count <= 5
    host = failure.get("requestHost")
    return {
        "kind": kind.value,
        "requestHost": host if isinstance(host, str) and re.fullmatch(r"[A-Za-z0-9.:\[\]-]{1,253}", host) else None,
        "observedAt": _timestamp(failure.get("observedAt")),
        "recoveryStatus": status if has_recovery else None,
        "checkCount": count if has_recovery else 0,
        "checkedAt": _timestamp(recovery.get("checkedAt")) if has_recovery else None,
        "nextCheckAt": _timestamp(recovery.get("nextCheckAt")) if has_recovery else None,
        "retryEligibleAt": _timestamp(recovery.get("retryEligibleAt")) if has_recovery else None,
    }
