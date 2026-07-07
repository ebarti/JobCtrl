"""Classified JobCtl errors surfaced to Temporal retry policies."""

from __future__ import annotations

from temporalio.exceptions import ApplicationError


class JobCtlError(Exception):
    """Base for classified pipeline errors."""

    retryable: bool = True
    code: str = "unknown"


class ConfigurationError(JobCtlError):
    retryable = False
    code = "configuration"


class AuthenticationError(JobCtlError):
    retryable = False
    code = "authentication"


class MissingInputError(JobCtlError):
    retryable = False
    code = "missing_input"


class TransientNetworkError(JobCtlError):
    code = "transient_network"


class BrowserTransientError(JobCtlError):
    code = "browser_transient"


class LlmTransientError(JobCtlError):
    code = "llm_transient"


class BudgetExceededError(JobCtlError):
    retryable = False
    code = "budget_exceeded"


class SourceUnavailableError(JobCtlError):
    code = "source_unavailable"


def to_application_error(exc: Exception) -> ApplicationError:
    """Convert a Python exception into Temporal's typed ApplicationError."""
    if isinstance(exc, JobCtlError):
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
    "JobCtlError",
    "LlmTransientError",
    "MissingInputError",
    "SourceUnavailableError",
    "TransientNetworkError",
    "to_application_error",
]
