"""Domain identity types.

JobId is a system-generated stable identifier for a job,
replacing URL-as-primary-key from the legacy schema.
"""

from __future__ import annotations

import uuid
from typing import NewType

JobId = NewType("JobId", str)


def canonical_job_id(value: str) -> JobId:
    """Return ``value`` as a JobId only when it is a canonical UUID."""
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError("JobId must be a canonical UUID") from exc
    if str(parsed) != value:
        raise ValueError("JobId must be a canonical UUID")
    return JobId(value)


def generate_job_id() -> JobId:
    """Generate a new random JobId using uuid4."""
    return JobId(str(uuid.uuid4()))


ContactId = NewType("ContactId", str)


def generate_contact_id() -> ContactId:
    """Generate a new random ContactId using uuid4."""
    return ContactId(str(uuid.uuid4()))
