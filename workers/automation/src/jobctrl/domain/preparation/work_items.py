"""Preparation work-item vocabulary.

``PreparationWorkItemKind`` and ``make_preparation_idempotency_key`` are the
identity vocabulary of the per-job ``JobPreparationWorkflow`` fan-out: the
deterministic ``prep-{idempotency_key}`` workflow ids are derived here, so N
fan-out invocations converge on exactly one workflow per job.
"""

from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Any

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import TenantId


class PreparationWorkItemKind(str, Enum):
    SCORE_JOB = "score_job"
    TAILOR_RESUME = "tailor_resume"
    SUPPRESS_TAILORED_ARTIFACTS = "suppress_tailored_artifacts"


def make_preparation_idempotency_key(
    *,
    tenant_id: TenantId,
    job_id: JobId,
    kind: PreparationWorkItemKind,
    target_version: int,
    source_event_id: str = "",
) -> str:
    payload: dict[str, Any] = {
        "tenant_id": str(tenant_id),
        "job_id": str(job_id),
        "kind": PreparationWorkItemKind(kind).value,
        "target_version": int(target_version),
        "source_event_id": str(source_event_id or ""),
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"preparation:{digest}"


__all__ = [
    "PreparationWorkItemKind",
    "make_preparation_idempotency_key",
]
