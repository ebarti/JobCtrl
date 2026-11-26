"""Translate the pinned SDK's typed board failures into safe public facts."""

from jobctrl.app.errors import AppError
from jobctrl.features.discovery.domain import BOARD_RATE_LIMIT_CODE, BOARD_RATE_LIMIT_MESSAGE


_BOARD_CREDENTIALS = {
    "indeed": ("Indeed", "JOBSTREAMING_INDEED_API_KEY"),
    "zip_recruiter": ("ZipRecruiter", "JOBSTREAMING_ZIPRECRUITER_AUTHORIZATION"),
}


def board_rate_limit_error():
    return AppError(BOARD_RATE_LIMIT_CODE, BOARD_RATE_LIMIT_MESSAGE, 502, {"diagnostic": "rate_limited"})


def board_search_error(event):
    message = "The source could not complete its search."
    if event.site.value == "lennysjobs" and event.error_type == "AdapterFailureError":
        public_messages = {
            "Lenny's Jobs returned results for a different query": "Lenny’s Jobs returned results for a different role. Check that the connection forwards your search text.",
            "Lenny's Jobs did not confirm the selected filters": "Lenny’s Jobs returned a page that did not match the selected filters. Check that the connection forwards the category and location.",
            "Lenny's Jobs needs a more specific location": "Several locations could match this search on Lenny’s Jobs. Enter the city and country in your search preferences.",
            "Lenny's Jobs returned invalid location suggestions": "Lenny’s Jobs returned unreadable location suggestions. Check the configured search connection.",
            "Lenny's Jobs returned invalid listing or pagination metadata": "Lenny’s Jobs returned an unexpected results page. Check that the connection forwards the requested page number.",
            "Lenny's Jobs returned an unreadable search response": "Lenny’s Jobs returned an unreadable search response. Check the configured search connection.",
        }
        message = public_messages.get(event.message, message)
    return AppError("discovery_provider_" + event.code.value, message, 502)


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
    elif board == "lennysjobs" and event.error_type == "AuthenticationConfigurationError" and event.message in {"Lenny's Jobs returned HTTP 401", "Lenny's Jobs returned HTTP 403"}:
        kind = "provider_access_denied"
        status = 401 if event.message.endswith("401") else 403
        details["httpStatus"] = status
        message = f"Lenny’s Jobs denied this search (HTTP {status}). Check access on the configured search connection."
    elif board == "lennysjobs" and event.error_type == "AuthenticationConfigurationError" and event.message == "Lenny's Jobs requires JOBSTREAMING_LENNYSJOBS_LISTINGS_URL":
        kind = "missing_connection"
        message = "Connect Lenny’s Jobs by setting JOBSTREAMING_LENNYSJOBS_LISTINGS_URL in the worker environment, then restart the worker."
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
