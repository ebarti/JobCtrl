"""JSON-RPC 2.0 domain types — request/response envelopes shared by TS and Python.

See ddd-target.md §6.5 (JSON-RPC 2.0 protocol).
"""

from jobctrl.domain.rpc.messages import (
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    PARSE_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    INVALID_PARAMS,
    INTERNAL_ERROR,
)

__all__ = [
    "JsonRpcError",
    "JsonRpcRequest",
    "JsonRpcResponse",
    "PARSE_ERROR",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "INVALID_PARAMS",
    "INTERNAL_ERROR",
]
