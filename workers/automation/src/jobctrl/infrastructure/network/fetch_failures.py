"""Typed fetch failures keep destination safety separate from retry policy."""

from __future__ import annotations

import errno
from enum import StrEnum
import socket
import ssl
import urllib.error


class PublicFetchFailureKind(StrEnum):
    INVALID_URL = "invalid_url"
    NON_PUBLIC_LITERAL = "non_public_literal"
    DNS_NON_PUBLIC = "dns_non_public"
    DNS_FAILURE = "dns_failure"
    UNSAFE_DESTINATION = "unsafe_destination"
    TIMEOUT = "timeout"
    CONNECTION = "connection"
    TLS = "tls"
    RESPONSE_LIMIT = "response_limit"
    FETCH_ERROR = "fetch_error"

    @property
    def destination_denied(self) -> bool:
        return self in {
            self.INVALID_URL, self.NON_PUBLIC_LITERAL, self.DNS_NON_PUBLIC, self.UNSAFE_DESTINATION,
        }

    @property
    def retryable(self) -> bool:
        return self in {self.DNS_FAILURE, self.TIMEOUT, self.CONNECTION}

    @property
    def priority(self) -> int:
        # A later timeout must not replace evidence of an unsafe request.
        if self in {self.INVALID_URL, self.NON_PUBLIC_LITERAL, self.UNSAFE_DESTINATION}:
            return 4
        if self is self.DNS_NON_PUBLIC:
            return 3
        return 1 if self.retryable else 2


class PublicResponseLimitError(ValueError):
    failure_kind = PublicFetchFailureKind.RESPONSE_LIMIT


def classify_public_fetch_failure(exc: BaseException) -> PublicFetchFailureKind:
    """Use exception types/errno, never arbitrary remote error text, for retries."""
    current = exc
    for _ in range(8):
        kind = getattr(current, "failure_kind", None)
        if isinstance(kind, PublicFetchFailureKind):
            return kind
        if isinstance(current, urllib.error.URLError) and isinstance(current.reason, BaseException):
            current = current.reason
            continue
        if isinstance(current, ssl.SSLError):
            return PublicFetchFailureKind.TLS
        if isinstance(current, socket.gaierror):
            return PublicFetchFailureKind.DNS_FAILURE
        if isinstance(current, TimeoutError) or (
            isinstance(current, OSError) and current.errno == errno.ETIMEDOUT
        ):
            return PublicFetchFailureKind.TIMEOUT
        if isinstance(current, ConnectionError) or (
            isinstance(current, OSError)
            and current.errno in {
                errno.ECONNRESET, errno.ECONNABORTED, errno.ECONNREFUSED,
                errno.ENETDOWN, errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EPIPE,
            }
        ):
            return PublicFetchFailureKind.CONNECTION
        break
    return PublicFetchFailureKind.FETCH_ERROR
