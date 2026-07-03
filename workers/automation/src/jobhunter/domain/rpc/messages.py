"""JSON-RPC 2.0 frozen dataclasses + spec error codes.

The TS side mirrors these in ``packages/contracts/src/rpc.ts``.

The protocol is the local subprocess transport per §6.5: the TS API forks
``jobhunter rpc``, writes newline-delimited JSON-RPC requests to stdin, and
reads newline-delimited responses from stdout.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — import only for type hints
    from temporalio.common import (
        RetryPolicy,
        WorkflowIDConflictPolicy,
        WorkflowIDReusePolicy,
    )

# JSON-RPC 2.0 reserved error codes (https://www.jsonrpc.org/specification).
PARSE_ERROR: int = -32700
INVALID_REQUEST: int = -32600
METHOD_NOT_FOUND: int = -32601
INVALID_PARAMS: int = -32602
INTERNAL_ERROR: int = -32603


@dataclass(frozen=True)
class JsonRpcRequest:
    """A JSON-RPC 2.0 request envelope.

    ``id`` is ``None`` for notifications (no response expected).  Otherwise
    it is the value the caller passed (string, number, or null in JSON).
    """

    method: str
    params: dict[str, Any] = field(default_factory=dict)
    id: str | int | None = None
    jsonrpc: str = "2.0"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "JsonRpcRequest":
        method = data.get("method")
        if not isinstance(method, str) or not method:
            raise ValueError("JSON-RPC request requires non-empty 'method' string")
        params = data.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("JSON-RPC params must be an object")
        rid = data.get("id", None)
        if rid is not None and not isinstance(rid, (str, int)):
            raise ValueError("JSON-RPC id must be a string, number, or null")
        return cls(method=method, params=params, id=rid)


@dataclass(frozen=True)
class JsonRpcError:
    """A JSON-RPC 2.0 error object."""

    code: int
    message: str
    data: Any = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


@dataclass(frozen=True)
class JsonRpcResponse:
    """A JSON-RPC 2.0 response envelope.

    Exactly one of ``result`` or ``error`` must be populated.
    """

    id: str | int | None
    result: Any = None
    error: JsonRpcError | None = None
    jsonrpc: str = "2.0"

    def __post_init__(self) -> None:
        if self.error is None and self.result is None:
            raise ValueError("JSON-RPC response requires one of 'result' or 'error'")
        if self.error is not None and self.result is not None:
            raise ValueError("JSON-RPC response cannot have both 'result' and 'error'")

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error is not None:
            body["error"] = self.error.to_dict()
        else:
            body["result"] = self.result
        return body

    @classmethod
    def success(cls, request_id: str | int | None, result: Any) -> "JsonRpcResponse":
        # Treat None as JSON-null — wrap so __post_init__ accepts it.
        return cls(id=request_id, result=result if result is not None else {})

    @classmethod
    def failure(cls, request_id: str | int | None, error: JsonRpcError) -> "JsonRpcResponse":
        return cls(id=request_id, error=error)


@dataclass(frozen=True)
class WorkflowStartSpec:
    """Return value of a ``workflow``-mode JSON-RPC handler.

    The handler converts JSON-RPC params into the workflow input shape and
    hands the spec to the server, which starts the workflow via the injected
    ``WorkflowStarter``.

    ``workflow_id`` — when a handler sets a deterministic id (e.g.
    ``apply-{jobKey}``), the conflict/reuse policies give real no-overlap: a
    double-start returns the already-running handle instead of a duplicate
    execution. ``None`` leaves the starter to generate a unique ``run-{uuid}``.
    """

    workflow: type
    args: tuple[Any, ...]
    workflow_id: str | None = None
    retry_policy: "RetryPolicy | None" = None
    id_conflict_policy: "WorkflowIDConflictPolicy | None" = None
    id_reuse_policy: "WorkflowIDReusePolicy | None" = None
