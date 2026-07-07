"""Domain identity types.

JobId is a system-generated stable identifier for a job,
replacing URL-as-primary-key from the legacy schema.
"""

from __future__ import annotations

import uuid
from typing import NewType

JobId = NewType("JobId", str)


def generate_job_id() -> JobId:
    """Generate a new random JobId using uuid4."""
    return JobId(str(uuid.uuid4()))


ContactId = NewType("ContactId", str)


def generate_contact_id() -> ContactId:
    """Generate a new random ContactId using uuid4."""
    return ContactId(str(uuid.uuid4()))
