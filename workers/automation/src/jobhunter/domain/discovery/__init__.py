"""Job Discovery bounded context — domain layer.

See ddd-target.md §4.1 (Job aggregate, value objects, lifecycle).

Public API barrel: aggregate root, value objects, and the ports owned by
the Discovery context. Adapters live under
``jobhunter.infrastructure.discovery``.
"""

from jobhunter.domain.discovery.aggregate import Job
from jobhunter.domain.discovery.value_objects import (
    Employer,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)

__all__ = [
    "Job",
    "Employer",
    "JobMetadata",
    "PostingUrl",
    "SearchStrategy",
    "Source",
]
