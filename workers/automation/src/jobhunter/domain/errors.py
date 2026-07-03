"""Classified JobHunter errors surfaced to Temporal retry policies."""

from __future__ import annotations

from temporalio.exceptions import ApplicationError


class JobHunterError(Exception):
    """Base for classified pipeline errors."""

    retryable: bool = True
    code: str = "unknown"


class ConfigurationError(JobHunterError):
    retryable = False
    code = "configuration"


class AuthenticationError(JobHunterError):
    retryable = False
    code = "authentication"


class MissingInputError(JobHunterError):
    retryable = False
    code = "missing_input"


class TransientNetworkError(JobHunterError):
    code = "transient_network"


class BrowserTransientError(JobHunterError):
    code = "browser_transient"


class LlmTransientError(JobHunterError):
    code = "llm_transient"


class BudgetExceededError(JobHunterError):
    retryable = False
    code = "budget_exceeded"


class SourceUnavailableError(JobHunterError):
    code = "source_unavailable"


def to_application_error(exc: Exception) -> ApplicationError:
    """Convert a Python exception into Temporal's typed ApplicationError."""
    if isinstance(exc, JobHunterError):
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
    "JobHunterError",
    "LlmTransientError",
    "MissingInputError",
    "SourceUnavailableError",
    "TransientNetworkError",
    "to_application_error",
]
