"""Apply Automation bounded context — domain layer.

See ddd-target.md §4.6 (ApplyRun aggregate, ApplyRunEvent entity,
SubmissionResult discriminated union, BrowserWorkerConfig, ApplyPrompt,
TokenUsage) and §8.3 (apply submission saga / process manager).

Public API barrel: aggregate root, child entity, value objects, domain
services, ports re-exports, use cases, and the apply process manager.
Adapters live under ``jobhunter.infrastructure.apply``.
"""

from jobhunter.domain.apply.aggregate import (
    ApplyRun,
    ApplyRunStatus,
)
from jobhunter.domain.apply.entities import ApplyRunEvent
from jobhunter.domain.apply.value_objects import (
    Applied,
    ApplyPrompt,
    ApplyRunId,
    BrowserWorkerConfig,
    Captcha,
    DryRunComplete,
    EmailOnlyApplication,
    Expired,
    Failed,
    LoginIssue,
    Manual,
    SubmissionResult,
    TokenUsage,
    new_apply_run_id,
)

__all__ = [
    "Applied",
    "ApplyPrompt",
    "ApplyRun",
    "ApplyRunEvent",
    "ApplyRunId",
    "ApplyRunStatus",
    "BrowserWorkerConfig",
    "Captcha",
    "DryRunComplete",
    "EmailOnlyApplication",
    "Expired",
    "Failed",
    "LoginIssue",
    "Manual",
    "SubmissionResult",
    "TokenUsage",
    "new_apply_run_id",
]
