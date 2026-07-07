"""JSON-RPC 2.0 stdin/stdout server (local subprocess transport, ddd-target.md §6.5).

Three dispatch modes are supported:

* ``sync``      — handler returns a result; it ships back as ``result``.
* ``workflow``  — handler returns a :class:`WorkflowStartSpec`; the server
  starts the workflow via the injected :data:`WorkflowStarter` and returns
  ``{"runId", "workflowId", "firstExecutionRunId"}``.
* ``streaming`` — handler is a generator that yields zero or more
  intermediate JSON-RPC notifications, optionally followed by a final
  response value.

Handlers are registered via :meth:`JsonRpcServer.register`.  Unknown methods
return ``METHOD_NOT_FOUND``; handler exceptions return ``INTERNAL_ERROR``
with the error string in ``data``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Iterable, TextIO

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

from jobctl.domain.rpc.messages import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    WorkflowStartSpec,
)
from jobctl.infrastructure.rpc.workflow_starter import WorkflowStarter
from jobctl.workflow_specs import workflow_result_to_dict

logger = logging.getLogger(__name__)


HandlerFn = Callable[[dict[str, Any]], Any]


@dataclass(frozen=True)
class HandlerSpec:
    """Registered handler + its dispatch mode."""

    fn: HandlerFn
    mode: str  # "sync" | "workflow" | "streaming"


# Bound on concurrent handler dispatch. Enough that a slow/hung handler can't
# head-of-line-block cancel or other fast calls, small enough to keep SQLite
# write contention (each thread opens its own thread-local connection) in check.
_DEFAULT_MAX_WORKERS = 8


class _LockedWriter:
    """Serialises newline-delimited envelope writes to a shared stream.

    With concurrent dispatch, multiple worker threads write responses and
    streaming notifications to the same stdout. Each envelope is one line,
    written atomically under a lock so lines never interleave. The TS adapter
    correlates responses by ``id``, so out-of-order lines are fine.
    """

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def write_envelope(self, body: dict[str, Any]) -> None:
        line = json.dumps(body) + "\n"
        with self._lock:
            self._stream.write(line)
            self._stream.flush()


class JsonRpcServer:
    """Stdin/stdout JSON-RPC dispatcher.

    Each request line is a single JSON-RPC envelope.  Each response line is
    a single JSON-RPC envelope (no batching support — ``§6.5`` doesn't
    require it).  Streaming handlers emit notifications as additional
    newline-delimited envelopes.
    """

    def __init__(self, *, workflow_starter: WorkflowStarter | None = None) -> None:
        self._handlers: dict[str, HandlerSpec] = {}
        self._workflow_starter = workflow_starter

    # ------------------------------------------------------------------ register

    def register(self, method: str, fn: HandlerFn, *, mode: str = "sync") -> None:
        if mode not in ("sync", "workflow", "streaming"):
            raise ValueError(f"unknown dispatch mode: {mode}")
        self._handlers[method] = HandlerSpec(fn=fn, mode=mode)

    # ------------------------------------------------------------------ dispatch

    def dispatch(self, request: JsonRpcRequest) -> JsonRpcResponse | None:
        """Dispatch a single parsed request to its handler.

        Returns the response, or ``None`` for notifications.  Streaming
        handlers should be driven via :meth:`serve` instead of this entry
        point.
        """
        tracer = trace.get_tracer("jobctl.rpc")
        with tracer.start_as_current_span(f"rpc.{request.method}") as span:
            span.set_attribute("rpc.method", request.method)
            span.set_attribute("rpc.id", "" if request.id is None else str(request.id))
            span.set_attribute("langfuse.trace.name", request.method)
            span.set_attribute("langfuse.observation.type", "span")

            spec = self._handlers.get(request.method)
            if spec is None:
                span.set_status(Status(StatusCode.ERROR, "method not found"))
                return JsonRpcResponse.failure(
                    request.id,
                    JsonRpcError(METHOD_NOT_FOUND, f"Method not found: {request.method}"),
                )

            if spec.mode == "workflow":
                return self._dispatch_workflow(request, spec)

            # sync — streaming is handled separately in serve()
            try:
                result = spec.fn(request.params)
            except _RpcParamError as exc:
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                return JsonRpcResponse.failure(
                    request.id,
                    JsonRpcError(INVALID_PARAMS, str(exc)),
                )
            except Exception as exc:  # noqa: BLE001 — surface as INTERNAL_ERROR
                logger.exception("Handler %s raised", request.method)
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                span.record_exception(exc)
                return JsonRpcResponse.failure(
                    request.id,
                    JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc)),
                )
            if request.id is None:
                # Notification — no response.
                return None
            return JsonRpcResponse.success(request.id, result)

    # ------------------------------------------------------------------ workflow

    def _dispatch_workflow(
        self,
        request: JsonRpcRequest,
        spec: HandlerSpec,
    ) -> JsonRpcResponse | None:
        # The dispatch() caller already opened the rpc.<method> span; we mark
        # ERROR status on it from each early-return failure branch so the
        # exported trace tells the truth about failed workflow dispatches.
        span = trace.get_current_span()

        if self._workflow_starter is None:
            logger.error("Workflow handler %s invoked without a workflow_starter", request.method)
            span.set_status(Status(StatusCode.ERROR, "workflow_starter not configured"))
            return JsonRpcResponse.failure(
                request.id,
                JsonRpcError(
                    INTERNAL_ERROR,
                    "Internal error",
                    data="workflow_starter is not configured",
                ),
            )

        try:
            start_spec = spec.fn(request.params)
        except _RpcParamError as exc:
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            return JsonRpcResponse.failure(
                request.id,
                JsonRpcError(INVALID_PARAMS, str(exc)),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Workflow handler %s raised while building spec", request.method)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            return JsonRpcResponse.failure(
                request.id,
                JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc)),
            )

        if not isinstance(start_spec, WorkflowStartSpec):
            msg = f"Workflow handler {request.method} did not return a WorkflowStartSpec"
            span.set_status(Status(StatusCode.ERROR, msg))
            return JsonRpcResponse.failure(
                request.id,
                JsonRpcError(INTERNAL_ERROR, msg),
            )

        try:
            handle = asyncio.run(self._workflow_starter(start_spec))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Workflow start failed for %s", request.method)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            span.record_exception(exc)
            return JsonRpcResponse.failure(
                request.id,
                JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc)),
            )

        result = {
            "runId": handle.id,
            "workflowId": handle.id,
            "firstExecutionRunId": handle.first_execution_run_id,
        }
        if bool((request.params or {}).get("awaitResult")):
            try:
                result["result"] = workflow_result_to_dict(asyncio.run(handle.result()))
            except Exception as exc:  # noqa: BLE001
                logger.exception("Workflow result wait failed for %s", request.method)
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                span.record_exception(exc)
                return JsonRpcResponse.failure(
                    request.id,
                    JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc)),
                )
        if request.id is None:
            return None
        return JsonRpcResponse.success(request.id, result)

    # ------------------------------------------------------------------ serve

    def serve(
        self,
        stdin: TextIO | None = None,
        stdout: TextIO | None = None,
        *,
        max_workers: int = _DEFAULT_MAX_WORKERS,
    ) -> None:
        """Read one request per line from *stdin*, write one response per line.

        Each line is dispatched on a bounded ``ThreadPoolExecutor`` so a slow or
        hung handler cannot head-of-line-block later calls (notably ``cancel``).
        Responses may therefore come back out of order; the TS adapter matches
        them by ``id``. All writes go through a lock so envelopes never
        interleave. On EOF the executor drains in-flight work before returning.
        """
        stream_in: TextIO = stdin if stdin is not None else sys.stdin
        stream_out: TextIO = stdout if stdout is not None else sys.stdout
        writer = _LockedWriter(stream_out)

        with ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="jsonrpc"
        ) as executor:
            for line in stream_in:
                line = line.strip()
                if not line:
                    continue
                executor.submit(self._process_line, line, writer)

    # ------------------------------------------------------------------ helpers

    def _process_line(self, line: str, writer: _LockedWriter) -> None:
        try:
            response = self._handle_line(line, writer)
            if response is not None:
                writer.write_envelope(response.to_dict())
        except Exception:  # noqa: BLE001 — a dispatch crash must not kill the worker thread pool
            logger.exception("Unhandled error dispatching JSON-RPC line")

    def _handle_line(self, line: str, writer: _LockedWriter) -> JsonRpcResponse | None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            return JsonRpcResponse.failure(None, JsonRpcError(PARSE_ERROR, "Parse error", data=str(exc)))

        if not isinstance(payload, dict):
            return JsonRpcResponse.failure(None, JsonRpcError(INVALID_REQUEST, "Invalid Request — must be an object"))

        try:
            request = JsonRpcRequest.from_dict(payload)
        except ValueError as exc:
            return JsonRpcResponse.failure(payload.get("id"), JsonRpcError(INVALID_REQUEST, str(exc)))

        spec = self._handlers.get(request.method)
        if spec is not None and spec.mode == "streaming":
            return self._dispatch_streaming(request, spec, writer)

        return self.dispatch(request)

    def _dispatch_streaming(
        self,
        request: JsonRpcRequest,
        spec: HandlerSpec,
        writer: _LockedWriter,
    ) -> JsonRpcResponse | None:
        tracer = trace.get_tracer("jobctl.rpc")
        with tracer.start_as_current_span(f"rpc.{request.method}") as span:
            span.set_attribute("rpc.method", request.method)
            span.set_attribute("rpc.id", "" if request.id is None else str(request.id))
            span.set_attribute("langfuse.trace.name", request.method)
            span.set_attribute("langfuse.observation.type", "span")

            try:
                stream = spec.fn(request.params)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Streaming handler %s failed to start", request.method)
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                span.record_exception(exc)
                return JsonRpcResponse.failure(
                    request.id, JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc))
                )
            if not isinstance(stream, Iterable):
                msg = f"Streaming handler {request.method} did not return iterable"
                span.set_status(Status(StatusCode.ERROR, msg))
                return JsonRpcResponse.failure(
                    request.id, JsonRpcError(INTERNAL_ERROR, msg)
                )

            final: Any = None
            try:
                for item in stream:
                    # Each yielded item is sent as a JSON-RPC notification.
                    writer.write_envelope(
                        {
                            "jsonrpc": "2.0",
                            "method": f"{request.method}.progress",
                            "params": item,
                        }
                    )
                    final = item
            except Exception as exc:  # noqa: BLE001
                logger.exception("Streaming handler %s raised mid-stream", request.method)
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                span.record_exception(exc)
                return JsonRpcResponse.failure(
                    request.id, JsonRpcError(INTERNAL_ERROR, "Internal error", data=str(exc))
                )
            if request.id is None:
                return None
            return JsonRpcResponse.success(request.id, final)


class _RpcParamError(ValueError):
    """Raise inside a handler to surface ``INVALID_PARAMS``."""


def invalid_params(message: str) -> _RpcParamError:
    """Helper for handlers to signal a parameter validation failure."""
    return _RpcParamError(message)
