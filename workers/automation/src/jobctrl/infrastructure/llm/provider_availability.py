"""Observed SDK availability for subsequent, independently bound attempts."""

from __future__ import annotations

import logging
import threading

from jobctrl.infrastructure.llm.provider_errors import ProviderCallError

_lock = threading.Lock()
_providers: set[str] = set()
_routes: set[tuple[str, str | None]] = set()
_AVAILABILITY_CODES = {
    "unauthorized", "usage_limit_exceeded", "server_overloaded", "internal_server_error",
    "transport_error", "http_connection_failed", "response_stream_connection_failed",
    "response_stream_disconnected", "response_too_many_failed_attempts", "provider_unavailable",
}
_TRANSIENT_CODES = {
    "server_overloaded", "internal_server_error", "transport_error", "http_connection_failed",
    "response_stream_connection_failed", "response_stream_disconnected", "response_too_many_failed_attempts",
}
_TRANSIENT_EXCEPTIONS = {
    "APIConnectionError", "APITimeoutError", "TimeoutError", "ConnectionError",
    "CLIConnectionError", "ServiceUnavailableError", "RateLimitError", "AntigravityConnectionError",
}
_AUTH_EXCEPTIONS = {"AuthenticationError", "PermissionDeniedError"}
_AVAILABILITY_EXCEPTIONS = {
    "APIConnectionError", "APITimeoutError", "TimeoutError", "ConnectionError",
    "CLIConnectionError", "ProcessError", "ServiceUnavailableError", "RateLimitError",
    "AntigravityConnectionError", "AntigravityExecutionError",
}


def provider_route_available(provider: str, model: str | None = None) -> bool:
    if model is None:
        from jobctrl.infrastructure.scoring.criteria_provider import read_preferred_model

        model = read_preferred_model(provider)
    with _lock:
        return provider not in _providers and (provider, model) not in _routes


def record_provider_failure(
    provider: str, model: str | None, error: Exception, *, default_model: bool = False,
) -> bool:
    """Exclude unavailable routes; leave temporary call failures to bounded retries."""
    if provider not in {"claude", "codex", "google"}:
        return False
    auth = type(error).__name__ in _AUTH_EXCEPTIONS
    unavailable = auth or type(error).__name__ in _AVAILABILITY_EXCEPTIONS
    transient = type(error).__name__ in _TRANSIENT_EXCEPTIONS
    code = "authentication_error" if auth else "transport_error"
    if isinstance(error, ProviderCallError):
        envelope = error.envelope
        auth = envelope.code == "unauthorized" or envelope.http_status in {401, 403}
        unavailable = auth or envelope.code in _AVAILABILITY_CODES or (
            envelope.http_status is not None and (envelope.http_status == 429 or envelope.http_status >= 500)
        )
        code = envelope.code
        transient = code != "usage_limit_exceeded" and (
            code in _TRANSIENT_CODES or envelope.http_status == 429
            or (envelope.http_status is not None and envelope.http_status >= 500)
        )
    else:
        status = getattr(error, "status_code", getattr(error, "code", None))
        if isinstance(status, int) and 100 <= status <= 599:
            auth = status in {401, 403}
            unavailable = auth or status == 429 or status >= 500
            code = "http_error"
            transient = status == 429 or status >= 500
    # An overload/connection error describes one request, not lasting route
    # unavailability. Caching it would turn a pinned workflow's retry into a
    # non-retryable provider_unavailable before the SDK can be called again.
    if not unavailable or (transient and not auth):
        return False
    with _lock:
        if auth:
            _providers.add(provider)
        else:
            _routes.add((provider, model))
            if default_model:
                _routes.add((provider, None))
    logging.getLogger(__name__).warning("LLM route unavailable: provider=%s code=%s", provider, code)
    return True


def reset_provider_availability() -> None:
    with _lock:
        _providers.clear()
        _routes.clear()
