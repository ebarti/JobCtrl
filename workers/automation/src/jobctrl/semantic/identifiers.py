"""Stable canonical job and local tenant identity values."""

from __future__ import annotations

import uuid
from typing import NewType

JobId = NewType("JobId", str)
TenantId = NewType("TenantId", str)
LOCAL_TENANT: TenantId = TenantId("local")


def canonical_job_id(value: str) -> JobId:
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("JobId must be a canonical UUID") from exc
    if str(parsed) != value:
        raise ValueError("JobId must be a canonical UUID")
    return JobId(value)
