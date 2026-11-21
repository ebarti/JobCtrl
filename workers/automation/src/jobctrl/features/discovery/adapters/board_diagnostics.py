"""Translate the pinned SDK's typed board failures into safe public facts."""

from jobctrl.app.errors import AppError
from jobctrl.features.discovery.domain import BOARD_RATE_LIMIT_CODE, BOARD_RATE_LIMIT_MESSAGE


_BOARD_CREDENTIALS = {
    "indeed": ("Indeed", "JOBSTREAMING_INDEED_API_KEY"),
    "zip_recruiter": ("ZipRecruiter", "JOBSTREAMING_ZIPRECRUITER_AUTHORIZATION"),
}


def board_rate_limit_error():
    return AppError(BOARD_RATE_LIMIT_CODE, BOARD_RATE_LIMIT_MESSAGE, 502, {"diagnostic": "rate_limited"})


def board_access_error(event):
    board = event.site.value
    name, credential = _BOARD_CREDENTIALS.get(board, (board, None))
    kind = "authentication_or_configuration"
    message = "The board reported an authentication or connection configuration error. Review its access and the worker connection."
    details = {}
    if event.error_type in {"ProxyError", "InvalidProxyURL"}:
        kind = "proxy_configuration"
        message = "The worker could not connect to the board through its proxy. Check the worker’s proxy configuration."
    elif event.error_type == "SSLError" or (event.error_type == "AuthenticationConfigurationError"
            and event.message == "Custom CA files are not supported by tls-client adapters"):
        kind = "tls_configuration"
        message = "The worker could not establish a secure connection to the board. Check its TLS configuration and certificate trust."
    elif event.error_type == "AuthenticationConfigurationError" and credential:
        if event.message == f"{name} requires {credential}":
            kind = "missing_credential"
            message = f"The worker has no {name} search credential. Configure {credential} in its environment and restart the worker."
        elif event.message in {f"{name} returned HTTP 401", f"{name} returned HTTP 403"}:
            kind = "provider_access_denied"
            status = 401 if event.message.endswith("401") else 403
            details["httpStatus"] = status
            message = f"{name} denied this search (HTTP {status}). Check that the worker credential has access to the board’s search API."
        elif board == "indeed" and event.message.startswith("Indeed: "):
            # The typed SDK GraphQL failure can carry private vendor prose.
            kind = "provider_access_denied"
            message = "Indeed reported an API authentication or access error. Check the worker credential’s access to Indeed search."
    return AppError("discovery_provider_authentication_configuration", message, 502, {"diagnostic": kind, **details})
