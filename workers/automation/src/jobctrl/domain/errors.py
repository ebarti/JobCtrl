"""Classified JobCtrl errors surfaced to Temporal retry policies."""

from __future__ import annotations

from temporalio.exceptions import ApplicationError


class JobCtrlError(Exception):
    """Base for classified pipeline errors."""

    retryable: bool = True
    code: str = "unknown"


class ConfigurationError(JobCtrlError):
    retryable = False
    code = "configuration"


class SavedSearchSettingsError(ConfigurationError):
    code = "invalid_saved_work_model"

    def __init__(self) -> None:
        super().__init__("Saved work-model selections are invalid. Update Target search and retry Discovery.")


class SavedSearchReadError(JobCtrlError):
    """A transient read failure must not be interpreted as first-use absence."""

    code = "saved_search_unavailable"

    def __init__(self, component: str) -> None:
        super().__init__(
            f"{component} could not be read. Check workspace access and retry. "
            "If damaged, preserve the workspace and restore a verified backup."
        )


class InvalidSavedSearchError(ConfigurationError):
    """Persisted search inputs exist but cannot be interpreted safely."""

    code = "invalid_saved_search"

    def __init__(self, component: str) -> None:
        super().__init__(
            f"{component} are invalid. Preserve the workspace and restore a verified backup, "
            "then retry."
        )


class MissingInputError(JobCtrlError):
    retryable = False
    code = "missing_input"


class ApplyStoppedLocally(MissingInputError):
    """The exact Apply owner observed the user's local stop before intent."""

    code = "apply_stopped_locally"


class TransientNetworkError(JobCtrlError):
    code = "transient_network"


class EnrichmentCanceledError(TransientNetworkError):
    """A cooperative enrichment stop, distinct from a failed acquisition."""

    code = "enrichment_canceled"


class LlmTransientError(JobCtrlError):
    code = "llm_transient"


MATERIAL_REJECTION_STATUSES = frozenset({
    "failed_judge", "failed_validation", "failed_adversarial_review",
    "failed_fabrication_gate", "failed_quality_gate", "exhausted_retries", "review_required",
})


class MaterialRejectedError(JobCtrlError):
    """A recorded material decision exhausted or stopped bounded correction."""

    retryable = False
    code = "material_rejected"


class AttemptBudgetExhaustedError(JobCtrlError):
    """A durable stage used every configured execution attempt."""

    retryable = False
    code = "attempt_budget_exhausted"


class BudgetExceededError(JobCtrlError):
    retryable = False
    code = "budget_exceeded"


class SourceUnavailableError(JobCtrlError):
    code = "source_unavailable"


def to_application_error(exc: Exception) -> ApplicationError:
    """Convert a Python exception into Temporal's typed ApplicationError."""
    if isinstance(exc, JobCtrlError):
        return ApplicationError(
            str(exc),
            type=exc.code,
            non_retryable=not exc.retryable,
        )
    return ApplicationError(str(exc), type="unclassified")


__all__ = [
    "ApplyStoppedLocally",
    "AttemptBudgetExhaustedError",
    "BudgetExceededError",
    "ConfigurationError",
    "EnrichmentCanceledError",
    "JobCtrlError",
    "InvalidSavedSearchError",
    "LlmTransientError",
    "MATERIAL_REJECTION_STATUSES",
    "MaterialRejectedError",
    "MissingInputError",
    "SavedSearchSettingsError",
    "SavedSearchReadError",
    "SourceUnavailableError",
    "TransientNetworkError",
    "to_application_error",
]
