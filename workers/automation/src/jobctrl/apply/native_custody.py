"""Bind Apply crash custody to the existing authenticated native execution.

The native launcher owns containment and cleanup. Python can only authenticate
its current execution receipt and consume the exact historical completion
attestation; environment hints, PID disappearance and session zero are not that
attestation. No function here signals a process or fabricates completion.
"""

from __future__ import annotations

import ctypes
from datetime import datetime, timedelta
from hashlib import sha256
import os
from pathlib import Path
import platform
import uuid

from jobctrl.apply.process_birth import (
    CustodyUnverified, _directory, _id, _read, boot_identity, validate_native_binding,
)


def _current_coalitions() -> list[int]:
    if platform.system() != "Darwin":
        raise CustodyUnverified("Native Apply execution custody is unavailable on this platform")
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    values = (ctypes.c_uint64 * 5)()
    size = library.proc_pidinfo(os.getpid(), 20, 0, ctypes.byref(values), ctypes.sizeof(values))
    if size != ctypes.sizeof(values) or not values[0] or not values[1]:
        raise CustodyUnverified("Cannot authenticate current native Apply coalition identity")
    return [values[0], values[1]]


def capture_native_custody(app_dir: Path) -> dict | None:
    scope_id = os.environ.get("JOBCTRL_EXECUTION_SCOPE")
    if not scope_id:
        return None
    runtime_home = os.environ.get("JOBCTRL_RUNTIME_HOME")
    if not _id(scope_id) or not runtime_home or not os.path.isabs(runtime_home) or os.path.abspath(runtime_home) != runtime_home:
        raise CustodyUnverified("Native Apply custody requires a normalized authenticated runtime home")
    app_dir = app_dir.resolve(strict=True)
    instance_id = sha256(str(app_dir).encode("utf-8")).hexdigest()
    directory = Path(runtime_home) / "instances" / instance_id / "executions"
    _directory(directory)
    scope, original_bytes = _read(directory / f"{scope_id}.json", with_bytes=True)
    binding = {"scope": scope, "receipt_sha256": sha256(original_bytes).hexdigest()}
    validate_native_binding(binding, app_dir)
    if scope["id"] != scope_id or scope["runtimeHome"] != runtime_home:
        raise CustodyUnverified("Native Apply scope does not match its authenticated context")
    if scope["bootSession"] != boot_identity() or scope["coalitionIds"] != _current_coalitions():
        raise CustodyUnverified("Native Apply scope does not match this kernel process")
    return binding


def verify_native_completion(binding: dict | None, app_dir: Path) -> None:
    if binding is None:
        raise CustodyUnverified(
            "Source-only Apply ownership remains unverified after a hard crash; "
            "session exit cannot certify escaped descendants without native completion authority."
        )
    validate_native_binding(binding, app_dir)
    scope = binding["scope"]
    directory = Path(scope["runtimeHome"]) / "instances" / scope["instanceId"] / "completed-executions"
    try:
        _directory(directory)
        completion = _read(directory / f"{scope['id']}.json")
    except OSError as exc:
        raise CustodyUnverified("The original native execution has no verified completion attestation; its owning native instance must complete ordinary stop before recovery.") from exc
    if (
        set(completion) != {"schemaVersion", "scope", "receiptSha256", "verificationBootSession", "completedAt"}
        or type(completion["schemaVersion"]) is not int or completion["schemaVersion"] != 1
        or completion["scope"] != scope or completion["receiptSha256"] != binding["receipt_sha256"]
        or not isinstance(completion["completedAt"], str)
    ):
        raise CustodyUnverified("Native completion does not match the exact prior Apply execution receipt")
    validate_native_binding({"scope": completion["scope"], "receipt_sha256": completion["receiptSha256"]}, app_dir)
    try:
        boot = completion["verificationBootSession"]
        if str(uuid.UUID(boot)) != boot:
            raise ValueError("noncanonical verification boot")
        completed = datetime.fromisoformat(completion["completedAt"].replace("Z", "+00:00"))
        if completed.tzinfo is None or completed.utcoffset() != timedelta(0):
            raise ValueError("completion time must be UTC")
    except (ValueError, TypeError, AttributeError) as exc:
        raise CustodyUnverified("Native completion metadata is malformed") from exc
