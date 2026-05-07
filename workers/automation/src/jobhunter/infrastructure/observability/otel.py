"""Bootstrap OpenTelemetry to ship spans to a Langfuse OTLP/HTTP endpoint.

Reads ``LANGFUSE_PUBLIC_KEY`` / ``LANGFUSE_SECRET_KEY`` / ``LANGFUSE_BASE_URL``
straight from ``os.environ`` so deployments can override values that
``jobhunter.config.load_env()`` already populated from ``~/.jobhunter/.env``.
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

from jobhunter import __version__ as JOBHUNTER_VERSION

log = logging.getLogger(__name__)

_initialized: bool = False
_provider: TracerProvider | None = None
_exporter: OTLPSpanExporter | None = None

_OTLP_PATH = "/api/public/otel/v1/traces"


def init_otel(*, service_name: str = "jobhunter", environment: str | None = None) -> None:
    """Configure the global OTel ``TracerProvider`` once."""
    global _initialized, _provider, _exporter

    if _initialized:
        return

    if os.environ.get("LANGFUSE_DISABLE", "").strip().lower() in ("1", "true"):
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
        "Langfuse OTel export ENABLED — every LLM prompt + completion will be "
        "shipped to %s. Set LANGFUSE_DISABLE=1 to opt out.",
        base_url,
    )

    resource = Resource(
        attributes={
            "service.name": service_name,
            "service.version": JOBHUNTER_VERSION,
            "deployment.environment": environment or os.environ.get("JOBHUNTER_ENV", "local"),
        }
    )

    auth = base64.b64encode(f"{public_key}:{secret_key}".encode("ascii")).decode("ascii")
    exporter = OTLPSpanExporter(
        endpoint=f"{base_url}{_OTLP_PATH}",
        headers={
            "Authorization": f"Basic {auth}",
            "x-langfuse-ingestion-version": "4",
        },
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

        HTTPXClientInstrumentor().instrument()
    except ImportError:
        pass


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
