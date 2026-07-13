"""Bootstrap OpenTelemetry to ship spans to a Langfuse OTLP/HTTP endpoint.

Reads ``LANGFUSE_PUBLIC_KEY`` / ``LANGFUSE_SECRET_KEY`` / ``LANGFUSE_BASE_URL``
straight from ``os.environ`` so deployments can override values that
``jobctrl.config.load_env()`` already populated from ``~/.jobctrl/.env``.
If any credential is missing, init logs a warning and returns without
configuring — every command continues to run, only export is off.
"""

from __future__ import annotations

import base64
import logging
import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from jobctrl import __version__ as JOBCTRL_VERSION

log = logging.getLogger(__name__)

_initialized: bool = False
_provider: TracerProvider | None = None
_exporter: OTLPSpanExporter | None = None

_OTLP_PATH = "/api/public/otel/v1/traces"
_DISABLE_TRUTHY = frozenset({"1", "true", "yes"})
_DEFAULT_EXPORT_TIMEOUT_SECONDS = 5.0


def langfuse_disabled() -> bool:
    """Single source of truth for the LANGFUSE_DISABLE opt-out flag."""
    return os.environ.get("LANGFUSE_DISABLE", "").strip().lower() in _DISABLE_TRUTHY


def init_otel(*, service_name: str = "jobctrl", environment: str | None = None) -> None:
    """Configure the global OTel ``TracerProvider`` once."""
    global _initialized, _provider, _exporter

    if _initialized:
        return

    if langfuse_disabled():
        log.info("Langfuse export disabled via LANGFUSE_DISABLE.")
        _initialized = True
        return

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
    base_url = os.environ.get("LANGFUSE_BASE_URL", "").strip().rstrip("/")
    if not (public_key and secret_key and base_url):
        log.warning(
            "Langfuse OTel export disabled: set LANGFUSE_PUBLIC_KEY, "
            "LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL to enable."
        )
        _initialized = True
        return

    log.warning(
        "Langfuse OTel export ENABLED — metadata-only LLM, workflow, and JSON-RPC "
        "spans will be sent to %s; model inputs and outputs are excluded. "
        "Set LANGFUSE_DISABLE=1 to opt out.",
        base_url,
    )

    resource = Resource(
        attributes={
            "service.name": service_name,
            "service.version": JOBCTRL_VERSION,
            "deployment.environment": environment or os.environ.get("JOBCTRL_ENV", "local"),
        }
    )

    auth = base64.b64encode(f"{public_key}:{secret_key}".encode("ascii")).decode("ascii")
    exporter = OTLPSpanExporter(
        endpoint=f"{base_url}{_OTLP_PATH}",
        headers={
            "Authorization": f"Basic {auth}",
            "x-langfuse-ingestion-version": "4",
        },
        timeout=_export_timeout_seconds(),
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    _provider = provider
    _exporter = exporter
    _initialized = True

    # Auto-instrument httpx so the LLMClient's outbound requests get spans
    # without any per-call wiring. Optional — ImportError means the user
    # didn't install the extra package, which is fine.
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument(request_hook=_scrub_url_credentials)
    except ImportError:
        pass


def _scrub_url_credentials(span, request) -> None:  # type: ignore[no-untyped-def]
    """Replace ``http.url`` if it carries a ``?key=`` credential.

    Belt-and-suspenders: every JobCtrl call path should be passing the API
    key as a header (e.g. ``x-goog-api-key``), but if any future caller
    accidentally puts ``?key=...`` back in the URL it would otherwise be
    captured into the ``http.url`` span attribute and shipped to Langfuse.
    The hook strips that single query param while preserving everything else.
    """
    try:
        url = str(request.url)
    except Exception:  # noqa: BLE001 — defensive: never break the request path
        return
    if "key=" not in url.lower():
        return
    from urllib.parse import urlencode, urlparse, urlunparse, parse_qsl

    parsed = urlparse(url)
    if not parsed.query:
        return
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    scrubbed = [(k, "REDACTED" if k.lower() == "key" else v) for k, v in pairs]
    if scrubbed == pairs:
        return
    cleaned = urlunparse(parsed._replace(query=urlencode(scrubbed)))
    span.set_attribute("http.url", cleaned)
    span.set_attribute("url.full", cleaned)


def shutdown_otel() -> None:
    """Flush + shut down the active provider so tests / CLI exits don't leak threads."""
    global _initialized, _provider, _exporter

    if _provider is not None:
        try:
            _provider.shutdown()
        except Exception:  # noqa: BLE001 — shutdown is best-effort
            log.exception("OTel provider shutdown failed")

    _provider = None
    _exporter = None
    _initialized = False


def is_otel_enabled() -> bool:
    """True iff ``init_otel()`` configured a real provider."""
    return _provider is not None


def _export_timeout_seconds() -> float:
    raw = os.environ.get("LANGFUSE_OTEL_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return _DEFAULT_EXPORT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        log.warning("Invalid LANGFUSE_OTEL_TIMEOUT_SECONDS=%r; using %.1fs.", raw, _DEFAULT_EXPORT_TIMEOUT_SECONDS)
        return _DEFAULT_EXPORT_TIMEOUT_SECONDS
    if value <= 0:
        log.warning("LANGFUSE_OTEL_TIMEOUT_SECONDS must be positive; using %.1fs.", _DEFAULT_EXPORT_TIMEOUT_SECONDS)
        return _DEFAULT_EXPORT_TIMEOUT_SECONDS
    return value
