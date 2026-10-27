"""Execute a bundled Apply launcher inside its own existing native scope.

Only the fixed native Apply command runs this module. The parent reads the
private result after the controller exits and its exact completion is verified;
a JSON result or a terminated root is never cleanup authority by itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import uuid

from jobctrl import config
from jobctrl.apply.native_custody import capture_native_custody, verify_native_completion
from jobctrl.apply.ownership import ApplyLauncherCleanupIncomplete, ApplyLauncherRun
from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified, _directory, _id, _read, _write


_OPTION_TYPES = {
    "limit": int, "target_job_id": (str, type(None)), "tenant_id": (str, type(None)),
    "min_score": int, "headless": bool, "model": str, "dry_run": bool,
    "continuous": bool, "poll_interval": int, "workers": int,
    "approval_required": bool, "workflow_id": (str, type(None)),
}


def _options(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != set(_OPTION_TYPES):
        raise ValueError("Apply execution options do not match the fixed request schema")
    for key, expected in _OPTION_TYPES.items():
        types = expected if isinstance(expected, tuple) else (expected,)
        if type(value[key]) not in types:
            raise ValueError(f"Apply execution option {key} has an invalid type")
    if value["workers"] < 1 or value["limit"] < 0 or value["poll_interval"] < 0:
        raise ValueError("Apply execution capacity must be positive or explicitly continuous")
    return value


def _invocation_dir(request_id: str) -> Path:
    if not _id(request_id):
        raise ValueError("Invalid Apply execution request identity")
    root = config.APP_DIR.resolve(strict=True) / "apply-invocations"
    root.mkdir(mode=0o700, exist_ok=True)
    _directory(root)
    return root / request_id


def _native_command() -> list[str]:
    runtime = os.environ.get("JOBCTRL_RUNTIME_HOME")
    if not runtime or not os.path.isabs(runtime) or os.path.abspath(runtime) != runtime:
        raise CustodyUnverified("Bundled Apply requires its normalized native runtime home")
    executable = Path(runtime) / "bin" / "jobctrl"
    if not executable.is_file():
        raise CustodyUnverified("Bundled Apply native execution controller is unavailable")
    return [str(executable), "__apply-execution"]


@dataclass
class ScopedApplyExecution:
    identity: str = field(default_factory=lambda: uuid.uuid4().hex)
    _guard: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _stopped: threading.Event = field(default_factory=threading.Event, repr=False)
    _process: subprocess.Popen | None = field(default=None, init=False, repr=False)
    _launched_pid: int | None = field(default=None, init=False, repr=False)

    def cancel(self) -> None:
        """Signal only the unreaped original native controller, without joining."""
        self._stopped.set()
        with self._guard:
            process = self._process
            if process is None:
                return
            # communicate()/wait() cannot reap and release this PID while its
            # original controller receives the native graceful-cancel signal.
            with process._waitpid_lock:
                if process.returncode is None and process.pid == self._launched_pid:
                    try:
                        os.kill(self._launched_pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass

    def run(self, options: dict) -> tuple[int, int]:
        options = _options(options)
        command = _native_command()
        config.APP_DIR.mkdir(parents=True, exist_ok=True)
        directory = _invocation_dir(self.identity)
        directory.mkdir(mode=0o700)
        request = {"schema": 1, "request_id": self.identity, "launcher_id": self.identity, "options": options}
        with (directory / "launcher.log").open("xb") as log:
            os.chmod(directory / "launcher.log", 0o600)
            with self._guard:
                if self._stopped.is_set():
                    raise InterruptedError("Apply execution was cancelled before admission")
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                self._process, self._launched_pid = process, process.pid
            try:
                pending_input = json.dumps(request).encode("utf-8")
                while True:
                    try:
                        # Bounded waits release Popen's reaping lock between
                        # polls so cancellation can pin and signal the exact
                        # unreaped controller instead of waiting for its exit.
                        process.communicate(pending_input, timeout=.2)
                        break
                    except subprocess.TimeoutExpired:
                        pending_input = None
            finally:
                if process.stdin is not None:
                    process.stdin.close()
        result_path = directory / "result.json"
        result = _read(result_path) if result_path.exists() or result_path.is_symlink() else None
        # Abrupt child death may precede result publication. Its already-bound
        # journal is still sufficient to select the exact native completion.
        binding = result.get("native_custody") if result is not None else None
        journal = ApplyCustodyJournal(config.APP_DIR, self.identity)
        if journal.directory.exists():
            value = journal.load()
            if value is not None:
                binding = value["native_custody"]
        try:
            if result is not None or binding is not None:
                verify_native_completion(binding, config.APP_DIR.resolve(strict=True))
            elif process.returncode == 0:
                raise CustodyUnverified("Apply controller returned no authenticated completion result")
            from jobctrl.apply.launcher import recover_apply_custody
            if journal.path.exists():
                recover_apply_custody(self.identity)
        except (CustodyUnverified, OSError, ValueError) as exc:
            raise ApplyLauncherCleanupIncomplete("Apply native execution cleanup remains unverified; its custody is retained") from exc
        finally:
            with self._guard:
                self._process = None
        if (result is None or set(result) != {"schema", "request_id", "launcher_id", "native_custody", "output", "error"}
                or type(result["schema"]) is not int or result["schema"] != 1
                or result["request_id"] != self.identity or result["launcher_id"] != self.identity):
            raise RuntimeError("Apply scoped worker exited without its exact result")
        if process.returncode != 0 or result["error"] is not None:
            raise RuntimeError("Apply scoped worker failed; inspect its retained launcher log")
        output = result["output"]
        if not isinstance(output, list) or len(output) != 2 or any(type(value) is not int or value < 0 for value in output):
            raise ValueError("Apply scoped worker returned malformed outcome counts")
        return tuple(output)


def main() -> None:
    request = json.loads(sys.stdin.buffer.read(1_000_001))
    if (not isinstance(request, dict) or set(request) != {"schema", "request_id", "launcher_id", "options"}
            or type(request["schema"]) is not int or request["schema"] != 1
            or not _id(request["request_id"]) or request["launcher_id"] != request["request_id"]):
        raise ValueError("Invalid native Apply execution request")
    options = _options(request["options"])
    directory = _invocation_dir(request["request_id"])
    _directory(directory)
    binding = capture_native_custody(config.APP_DIR)
    if (binding is None or binding["scope"].get("purpose") != "apply"
            or os.environ.get("JOBCTRL_APPLY_EXECUTION_SCOPE") != binding["scope"]["id"]):
        raise CustodyUnverified("Apply scoped worker requires its dedicated authenticated native execution")
    result = {"schema": 1, "request_id": request["request_id"], "launcher_id": request["launcher_id"],
              "native_custody": binding, "output": None, "error": None}
    run = ApplyLauncherRun(identity=request["launcher_id"])
    prior_handlers = {kind: signal.getsignal(kind) for kind in (signal.SIGINT, signal.SIGTERM)}
    for kind in prior_handlers:
        signal.signal(kind, lambda _signal, _frame: run.cancel())
    try:
        from jobctrl.apply.launcher import main as run_launcher
        result["output"] = list(run_launcher(**options, install_signal_handlers=False, launcher_run=run))
    except BaseException as exc:
        result["error"] = type(exc).__name__
        raise
    finally:
        for kind, handler in prior_handlers.items():
            signal.signal(kind, handler)
        _write(directory / "result.json", result)


if __name__ == "__main__":
    main()
