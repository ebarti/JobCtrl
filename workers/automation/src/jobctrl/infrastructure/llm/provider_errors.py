"""Privacy-safe, provider-neutral LLM failure envelopes.

The envelope deliberately carries only allowlisted provider metadata.  Provider
messages, SDK objects, prompts, responses, and exception text can contain user
data, so callers must never persist or export them directly.
"""

from __future__ import annotations
import re
from dataclasses import dataclass
from jobctrl.domain.ports.llm import LlmFailure


_MESSAGE_CODES = {
    "builder error": "builder_error",
    "invalid json": "invalid_json",
    "invalid structured output": "invalid_structured_output",
    "schema validation failed": "schema_validation_failed",
    "structured output validation failed": "schema_validation_failed",
}
_CODEX_RETRYABLE_CODES = frozenset({"server_overloaded", "internal_server_error"})
_CODEX_ERROR_INFO_CODES = {
    "contextWindowExceeded": "context_window_exceeded",
    "sessionBudgetExceeded": "session_budget_exceeded",
    "usageLimitExceeded": "usage_limit_exceeded",
    "serverOverloaded": "server_overloaded",
    "cyberPolicy": "cyber_policy",
    "internalServerError": "internal_server_error",
    "unauthorized": "unauthorized",
    "badRequest": "bad_request",
    "threadRollbackFailed": "thread_rollback_failed",
    "sandboxError": "sandbox_error",
    "other": "other",
}
_CODEX_ERROR_INFO_VARIANTS = {
    "httpconnectionfailedcodexerrorinfo": "http_connection_failed",
    "responsestreamconnectionfailedcodexerrorinfo": "response_stream_connection_failed",
    "responsestreamdisconnectedcodexerrorinfo": "response_stream_disconnected",
    "responsetoomanyfailedattemptscodexerrorinfo": "response_too_many_failed_attempts",
    "activeturnnotsteerablecodexerrorinfo": "active_turn_not_steerable",
}
_RETRYABLE_EXCEPTION_TYPES = frozenset({"TimeoutError", "ConnectionError", "OSError"})
_SAFE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_TRACE_ID = re.compile(r"[a-f0-9]{32}")
_SPAN_ID = re.compile(r"[a-f0-9]{16}")


def _known_message_code(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.lower().split())
    return _MESSAGE_CODES.get(normalized)


def _bounded_type_name(value: object) -> str:
    name = type(value).__name__
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name):
        return "unknown_exception"
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _safe_http_status(value: object) -> int | None:
    if isinstance(value, int) and 100 <= value <= 599:
        return value
    return None


def _safe_token(value: object, *, fallback: str = "unknown") -> str:
    return value if isinstance(value, str) and _SAFE_TOKEN.fullmatch(value) else fallback


def _codex_error_info(error_info: object) -> tuple[str | None, int | None]:
    """Extract the only safe fields from SDK ``codex_error_info``.

    The SDK models this as an enum or one of a small set of tagged objects.  We
    retain the fixed tag and bounded HTTP status, never a serialized SDK object.
    """

    root = getattr(error_info, "root", error_info)
    enum_value = getattr(root, "value", root if isinstance(root, str) else None)
    if isinstance(enum_value, str) and enum_value in _CODEX_ERROR_INFO_CODES:
        return _CODEX_ERROR_INFO_CODES[enum_value], None

    variant = _CODEX_ERROR_INFO_VARIANTS.get(type(root).__name__.lower())
    if variant is None:
        return None, None
    for attribute in (
        "http_connection_failed",
        "response_stream_connection_failed",
        "response_stream_disconnected",
        "response_too_many_failed_attempts",
    ):
        detail = getattr(root, attribute, None)
        if detail is not None:
            return variant, _safe_http_status(getattr(detail, "http_status_code", None))
    return variant, None


@dataclass
class ProviderFailureEnvelope:
    """Bounded metadata that can safely cross audit and telemetry boundaries."""

    provider: str
    model: str
    operation: str
    category: str
    error_type: str
    code: str
    retryable: bool
    message_code: str | None = None
    additional_detail_code: str | None = None
    additional_details_present: bool = False
    codex_error_code: str | None = None
    http_status: int | None = None
    trace_id: str | None = None
    span_id: str | None = None
    post_terminal_failure: bool = False

    def __post_init__(self) -> None:
        # Provider/model values are configuration-derived but still cross an
        # audit boundary. Reject paths, URLs, exception text, and other
        # arbitrary strings rather than merely truncating them.
        self.provider = _safe_token(self.provider)
        self.model = _safe_token(self.model)
        self.operation = _safe_token(self.operation)
        self.category = _safe_token(self.category)
        self.error_type = _safe_token(self.error_type)
        self.code = _safe_token(self.code)
        self.message_code = _safe_token(self.message_code) if self.message_code is not None else None
        self.additional_detail_code = (
            _safe_token(self.additional_detail_code) if self.additional_detail_code is not None else None
        )
        self.codex_error_code = _safe_token(self.codex_error_code) if self.codex_error_code is not None else None
        self.http_status = _safe_http_status(self.http_status)

    def attach_trace(self, *, trace_id: str | None, span_id: str | None) -> None:
        if trace_id and _TRACE_ID.fullmatch(trace_id):
            self.trace_id = trace_id
        if span_id and _SPAN_ID.fullmatch(span_id):
            self.span_id = span_id

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "provider": self.provider,
            "model": self.model,
            "operation": self.operation,
            "category": self.category,
            "error_type": self.error_type,
            "code": self.code,
            "retryable": self.retryable,
            "additional_details_present": self.additional_details_present,
        }
        for key, value in (
            ("message_code", self.message_code),
            ("additional_detail_code", self.additional_detail_code),
            ("codex_error_code", self.codex_error_code),
            ("http_status", self.http_status),
            ("trace_id", self.trace_id),
            ("span_id", self.span_id),
        ):
            if value is not None:
                result[key] = value
        if self.post_terminal_failure:
            result["post_terminal_failure"] = True
        return result

    def telemetry_attributes(self) -> dict[str, str | bool | int]:
        attributes: dict[str, str | bool | int] = {
            "jobctrl.llm.failure.provider": self.provider,
            "jobctrl.llm.failure.model": self.model,
            "jobctrl.llm.failure.operation": self.operation,
            "jobctrl.llm.failure.category": self.category,
            "jobctrl.llm.failure.type": self.error_type,
            "jobctrl.llm.failure.code": self.code,
            "jobctrl.llm.failure.retryable": self.retryable,
            "jobctrl.llm.failure.additional_details_present": self.additional_details_present,
        }
        if self.message_code is not None:
            attributes["jobctrl.llm.failure.message_code"] = self.message_code
        if self.additional_detail_code is not None:
            attributes["jobctrl.llm.failure.additional_detail_code"] = self.additional_detail_code
        if self.codex_error_code is not None:
            attributes["jobctrl.llm.failure.provider_code"] = self.codex_error_code
        if self.http_status is not None:
            attributes["jobctrl.llm.failure.http_status"] = self.http_status
        if self.post_terminal_failure:
            attributes["jobctrl.llm.failure.post_terminal_failure"] = True
        return attributes


class ProviderCallError(LlmFailure):
    """Application-owned error that never embeds a provider message in ``str``."""

    def __init__(self, envelope: ProviderFailureEnvelope) -> None:
        self.envelope = envelope
        super().__init__(envelope.code, retryable=envelope.retryable)
        self.args = (
            f"LLM provider call failed: {envelope.provider}/{envelope.operation} {envelope.category}:{envelope.code}",
        )

    def attach_trace(self, *, trace_id: str | None, span_id: str | None) -> None:
        self.envelope.attach_trace(trace_id=trace_id, span_id=span_id)


def codex_turn_error(*, model: str, operation: str, error: object | None) -> ProviderCallError:
    """Convert a failed Codex ``Turn`` into the safe application envelope."""

    message_code = _known_message_code(getattr(error, "message", None))
    additional_details = getattr(error, "additional_details", None)
    additional_detail_code = _known_message_code(additional_details)
    codex_code, http_status = _codex_error_info(getattr(error, "codex_error_info", None))
    code = message_code or additional_detail_code or codex_code or "turn_failed"
    retryable = bool(
        http_status == 429 or (http_status is not None and http_status >= 500) or codex_code in _CODEX_RETRYABLE_CODES
    )
    return ProviderCallError(
        ProviderFailureEnvelope(
            provider="openai",
            model=model,
            operation=operation,
            category="provider_turn",
            error_type="codex_turn_error",
            code=code,
            retryable=retryable,
            message_code=message_code,
            additional_detail_code=additional_detail_code,
            additional_details_present=additional_details is not None,
            codex_error_code=codex_code,
            http_status=http_status,
        )
    )


def provider_exception_error(
    *,
    provider: str,
    model: str,
    operation: str,
    error: BaseException,
) -> ProviderCallError:
    """Classify an SDK-boundary exception without retaining its text."""

    type_name = _bounded_type_name(error)
    retryable = type(error).__name__ in _RETRYABLE_EXCEPTION_TYPES
    return ProviderCallError(
        ProviderFailureEnvelope(
            provider=provider,
            model=model,
            operation=operation,
            category="provider_transport" if retryable else "provider_exception",
            error_type=type_name,
            code="transport_error" if retryable else "sdk_exception",
            retryable=retryable,
        )
    )


def raise_on_claude_failure(messages: list, *, model: str, operation: str) -> None:
    """Reject a failed native or kit result after accounting and before parsing."""
    post_terminal_failure = getattr(messages, "post_terminal_failure", False) is True
    for message in messages:
        if type(message).__name__ != "ResultMessage":
            continue
        subtype = getattr(message, "subtype", None)
        known = {
            "error_during_execution": ("provider_turn", "provider_unavailable", True),
            "error_max_turns": ("provider_turn", "claude_max_turns", False),
            "error_max_structured_output_retries": ("provider_response", "schema_validation_failed", False),
            "error_max_budget_usd": ("budget", "budget_denied", False),
        }
        details = known.get(subtype) if isinstance(subtype, str) else None
        if details is None and not getattr(message, "is_error", False):
            continue
        # The pinned SDK defines this field only for an error-bearing
        # "success" subtype; do not turn budget/schema failures into outages.
        status = (
            _safe_http_status(getattr(message, "api_error_status", None))
            if subtype == "success" and getattr(message, "is_error", False) else None
        )
        category, code, retryable = details or (
            "provider_turn", "claude_result_failed", status == 429 or (status is not None and status >= 500),
        )
        raise ProviderCallError(ProviderFailureEnvelope(
            provider="claude", model=model, operation=operation, category=category,
            error_type="claude_result_error", code=code, retryable=retryable,
            additional_detail_code=subtype if details is not None else None, http_status=status,
            post_terminal_failure=post_terminal_failure,
        ))

    # The kit also rejects assistant errors and invalid structured responses.
    # Retain only the SDK's fixed error tags, never the kit's free-form text.
    for message in messages:
        if type(message).__name__ != "AssistantMessage":
            continue
        native_error = getattr(message, "error", None)
        if not native_error:
            continue
        known_assistant_errors = {
            "authentication_failed", "billing_error", "rate_limit", "invalid_request", "server_error", "unknown",
        }
        tag = native_error if isinstance(native_error, str) and native_error in known_assistant_errors else None
        status = 429 if tag == "rate_limit" else 503 if tag == "server_error" else None
        raise ProviderCallError(ProviderFailureEnvelope(
            provider="claude", model=model, operation=operation, category="provider_turn",
            error_type="claude_assistant_error", code="unauthorized" if tag == "authentication_failed" else "claude_assistant_failed",
            retryable=status is not None, additional_detail_code=tag, http_status=status,
            post_terminal_failure=post_terminal_failure,
        ))

    if getattr(messages, "kit_succeeded", True) is False:
        structured = getattr(messages, "kit_structured", False)
        raise ProviderCallError(ProviderFailureEnvelope(
            provider="claude", model=model, operation=operation,
            category="provider_response" if structured else "provider_turn", error_type="claude_kit_error",
            code="schema_validation_failed" if structured else "claude_result_failed", retryable=False,
            post_terminal_failure=post_terminal_failure,
        ))

    if post_terminal_failure:
        raise ProviderCallError(ProviderFailureEnvelope(
            provider="claude", model=model, operation=operation, category="provider_cleanup",
            error_type="claude_post_terminal_failure", code="claude_post_terminal_failure", retryable=True,
            post_terminal_failure=True,
        ))


def codex_protocol_error(*, model: str, operation: str, code: str, retryable: bool) -> ProviderCallError:
    """Create an allowlisted error for an incomplete or malformed SDK lifecycle."""

    return ProviderCallError(
        ProviderFailureEnvelope(
            provider="openai",
            model=model,
            operation=operation,
            category="provider_protocol",
            error_type="codex_turn_protocol",
            code=code,
            retryable=retryable,
        )
    )


__all__ = [
    "ProviderCallError",
    "ProviderFailureEnvelope",
    "codex_protocol_error",
    "codex_turn_error",
    "provider_exception_error",
]
