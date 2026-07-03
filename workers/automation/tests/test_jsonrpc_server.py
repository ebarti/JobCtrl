"""JsonRpcServer dispatch + serve tests."""

from __future__ import annotations

import io
import json

from jobhunter.domain.rpc.messages import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    JsonRpcRequest,
)
from jobhunter.infrastructure.rpc.server import JsonRpcServer, invalid_params


def _request(method: str, params=None, rid: int | str | None = 1) -> JsonRpcRequest:
    return JsonRpcRequest(method=method, params=params or {}, id=rid)


# ---------------------------------------------------------------------------
# dispatch (sync)
# ---------------------------------------------------------------------------


def test_sync_method_returns_result() -> None:
    server = JsonRpcServer()
    server.register("echo", lambda params: {"echo": params}, mode="sync")

    response = server.dispatch(_request("echo", {"hello": "world"}))

    assert response is not None
    body = response.to_dict()
    assert body["jsonrpc"] == "2.0"
    assert body["id"] == 1
    assert body["result"] == {"echo": {"hello": "world"}}


def test_unknown_method_returns_method_not_found() -> None:
    server = JsonRpcServer()
    response = server.dispatch(_request("missing"))
    assert response is not None
    assert response.to_dict()["error"]["code"] == METHOD_NOT_FOUND


def test_handler_exception_is_internal_error() -> None:
    server = JsonRpcServer()

    def boom(_params):
        raise RuntimeError("kaboom")

    server.register("boom", boom)
    response = server.dispatch(_request("boom"))
    assert response is not None
    body = response.to_dict()
    assert body["error"]["code"] == INTERNAL_ERROR
    assert body["error"]["data"] == "kaboom"


def test_invalid_params_helper_surfaces_invalid_params_code() -> None:
    server = JsonRpcServer()

    def needs_x(params):
        if "x" not in params:
            raise invalid_params("x is required")
        return {"x": params["x"]}

    server.register("needs_x", needs_x)
    response = server.dispatch(_request("needs_x", {}))
    assert response is not None
    assert response.to_dict()["error"]["code"] == INVALID_PARAMS


def test_notification_returns_no_response() -> None:
    server = JsonRpcServer()
    seen = []
    server.register("notify", lambda params: seen.append(params))

    response = server.dispatch(_request("notify", {"a": 1}, rid=None))

    assert response is None
    assert seen == [{"a": 1}]


# ---------------------------------------------------------------------------
# serve() — stdin/stdout transport
# ---------------------------------------------------------------------------


def test_serve_handles_single_request_line() -> None:
    server = JsonRpcServer()
    server.register("ping", lambda _params: "pong")

    stdin = io.StringIO(json.dumps({"jsonrpc": "2.0", "method": "ping", "id": 1}) + "\n")
    stdout = io.StringIO()

    server.serve(stdin=stdin, stdout=stdout)

    out = stdout.getvalue().strip().splitlines()
    assert len(out) == 1
    body = json.loads(out[0])
    assert body == {"jsonrpc": "2.0", "id": 1, "result": "pong"}


def test_serve_skips_blank_lines() -> None:
    server = JsonRpcServer()
    server.register("ping", lambda _params: "pong")

    stdin = io.StringIO("\n\n" + json.dumps({"jsonrpc": "2.0", "method": "ping", "id": 7}) + "\n")
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout)

    out = [line for line in stdout.getvalue().splitlines() if line.strip()]
    assert len(out) == 1
    assert json.loads(out[0])["id"] == 7


def test_serve_returns_parse_error_for_invalid_json() -> None:
    server = JsonRpcServer()
    stdin = io.StringIO("not-json\n")
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout)

    body = json.loads(stdout.getvalue().strip())
    assert body["error"]["code"] == PARSE_ERROR
    assert body["id"] is None


def test_serve_returns_invalid_request_for_non_object() -> None:
    server = JsonRpcServer()
    stdin = io.StringIO("[1, 2, 3]\n")
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout)
    body = json.loads(stdout.getvalue().strip())
    assert body["error"]["code"] == INVALID_REQUEST


def test_streaming_handler_emits_progress_then_final_result() -> None:
    server = JsonRpcServer()

    def stream(_params):
        for i in range(3):
            yield {"step": i}

    server.register("stream", stream, mode="streaming")
    stdin = io.StringIO(json.dumps({"jsonrpc": "2.0", "method": "stream", "id": 9}) + "\n")
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout)

    lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    # 3 notifications + 1 final response.
    assert len(lines) == 4
    assert all(line.get("method") == "stream.progress" for line in lines[:3])
    assert lines[-1]["id"] == 9
    assert lines[-1]["result"] == {"step": 2}


def test_register_rejects_unknown_mode() -> None:
    server = JsonRpcServer()
    try:
        server.register("x", lambda _p: None, mode="weird")
    except ValueError:
        return
    raise AssertionError("expected ValueError for unknown mode")


def test_serve_handles_missing_method_gracefully() -> None:
    server = JsonRpcServer()
    stdin = io.StringIO(json.dumps({"jsonrpc": "2.0", "id": 1, "params": {}}) + "\n")
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout)
    body = json.loads(stdout.getvalue().strip())
    assert body["error"]["code"] == INVALID_REQUEST


def test_concurrent_dispatch_returns_out_of_order_responses() -> None:
    """A slow handler must not head-of-line-block a later fast one; responses
    come back out of order and are still correlated by id."""
    import threading

    server = JsonRpcServer()
    fast_ran = threading.Event()

    def slow(_params):
        # Block until the later 'fast' request has completed. If dispatch were
        # serial this would deadlock (fast never runs); the 5s guard fails loud.
        assert fast_ran.wait(timeout=5), "fast request was head-of-line-blocked"
        return {"who": "slow"}

    def fast(_params):
        fast_ran.set()
        return {"who": "fast"}

    server.register("slow", slow, mode="sync")
    server.register("fast", fast, mode="sync")

    stdin = io.StringIO(
        json.dumps({"jsonrpc": "2.0", "method": "slow", "id": 1})
        + "\n"
        + json.dumps({"jsonrpc": "2.0", "method": "fast", "id": 2})
        + "\n"
    )
    stdout = io.StringIO()
    server.serve(stdin=stdin, stdout=stdout, max_workers=4)

    lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    by_id = {line["id"]: line for line in lines}
    assert by_id[1]["result"] == {"who": "slow"}
    assert by_id[2]["result"] == {"who": "fast"}
    # Fast (id=2, submitted second) completed and was written before slow (id=1).
    assert [line["id"] for line in lines] == [2, 1]
