"""Canonical HTTP(S) destination identities for Apply authorization."""

from __future__ import annotations

from ipaddress import ip_address
from urllib.parse import SplitResult, urlsplit


def _parsed_http_url(value: str) -> tuple[SplitResult, str, str, int | None]:
    raw = str(value or "").strip()
    if not raw or "\\" in raw or any(ord(character) < 0x20 or character.isspace() for character in raw):
        raise ValueError("approved application URL must be an unambiguous HTTP(S) URL")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("approved application URL must be an unambiguous HTTP(S) URL") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("approved application URL must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("approved application URL must not contain user information")

    raw_host = parsed.hostname.rstrip(".")
    if not raw_host or "%" in raw_host:
        raise ValueError("approved application URL must contain a hostname")
    try:
        normalized_host = str(ip_address(raw_host))
    except ValueError:
        try:
            normalized_host = raw_host.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError) as exc:
            raise ValueError("approved application URL contains an invalid hostname") from exc
        if (
            not normalized_host
            or len(normalized_host) > 253
            or any(
                not label
                or len(label) > 63
                or label.startswith("-")
                or label.endswith("-")
                or any(not (character.isascii() and (character.isalnum() or character == "-")) for character in label)
                for label in normalized_host.split(".")
            )
        ):
            raise ValueError("approved application URL contains an invalid hostname")
    return parsed, scheme, normalized_host, port


def canonical_http_origin(value: str) -> str:
    """Return the exact scheme/host/effective-port authorization identity."""

    _parsed, scheme, host, port = _parsed_http_url(value)
    rendered_host = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    port_suffix = "" if port is None or port == default_port else f":{port}"
    return f"{scheme}://{rendered_host}{port_suffix}"


__all__ = ["canonical_http_origin"]
