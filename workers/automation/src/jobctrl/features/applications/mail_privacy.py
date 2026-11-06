"""Keep Gmail request details out of transport logs and HTTP telemetry."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

import httpx
from opentelemetry import trace
from opentelemetry.instrumentation.utils import suppress_http_instrumentation
from opentelemetry.trace import Status, StatusCode

_private_gmail_request: ContextVar[bool] = ContextVar("private_gmail_request", default=False)
_HTTP_LOGGERS = ("httpx", "httpcore.connection", "httpcore.proxy", "httpcore.http11", "httpcore.http2", "httpcore.socks")


class _PrivateGmailLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not _private_gmail_request.get():
            return True
        if record.name != "httpx":
            # httpcore debug records can contain transport details and exceptions.
            return False
        args = record.args
        if isinstance(args, tuple) and len(args) > 3 and type(args[3]) is int:
            record.msg, record.args = "Gmail HTTP request completed with status %d", (args[3],)
        else:
            record.msg, record.args = "Gmail HTTP transport diagnostic withheld", ()
        record.exc_info = record.exc_text = record.stack_info = None
        return True


_LOG_FILTER = _PrivateGmailLogFilter()


@contextmanager
def private_gmail_operation(name: str) -> Iterator[trace.Span]:
    """Emit a content-free operation span while shielding Gmail HTTP details."""
    for logger_name in _HTTP_LOGGERS:
        logging.getLogger(logger_name).addFilter(_LOG_FILTER)
    token = _private_gmail_request.set(True)
    try:
        with trace.get_tracer("jobctrl.gmail").start_as_current_span(
            name, record_exception=False, set_status_on_exception=False
        ) as span:
            span.set_attribute("http.request.method", "GET")
            span.set_attribute("server.address", "gmail.googleapis.com")
            try:
                with suppress_http_instrumentation():
                    yield span
            except httpx.HTTPStatusError as exc:
                span.set_attribute("http.response.status_code", exc.response.status_code)
                span.set_attribute("error.type", "HTTPStatusError")
                span.set_status(Status(StatusCode.ERROR, "Gmail request failed"))
                request = httpx.Request(exc.request.method, "https://gmail.googleapis.com/")
                response = httpx.Response(exc.response.status_code, headers=exc.response.headers, request=request)
                raise httpx.HTTPStatusError(
                    f"Gmail request failed with HTTP {response.status_code}.", request=request, response=response
                ) from None
            except httpx.RequestError as exc:
                span.set_attribute("error.type", type(exc).__name__)
                span.set_status(Status(StatusCode.ERROR, "Gmail request failed"))
                request = httpx.Request("GET", "https://gmail.googleapis.com/")
                raise type(exc)("Gmail request could not reach the provider.", request=request) from None
            except Exception as exc:
                span.set_attribute("error.type", type(exc).__name__)
                span.set_status(Status(StatusCode.ERROR, "Gmail request failed"))
                raise
            else:
                span.set_status(Status(StatusCode.OK))
    finally:
        _private_gmail_request.reset(token)
