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


class AuthenticationError(JobCtrlError):
    retryable = False
    code = "authentication"


class MissingInputError(JobCtrlError):
    retryable = False
    code = "missing_input"


class TransientNetworkError(JobCtrlError):
    code = "transient_network"


class BrowserTransientError(JobCtrlError):
    code = "browser_transient"


class LlmTransientError(JobCtrlError):
    code = "llm_transient"


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
    "AuthenticationError",
    "BrowserTransientError",
    "BudgetExceededError",
    "ConfigurationError",
    "JobCtrlError",
    "LlmTransientError",
    "MissingInputError",
    "SourceUnavailableError",
    "TransientNetworkError",
    "to_application_error",
]
