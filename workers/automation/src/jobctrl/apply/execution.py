"""Execute a bundled Apply launcher inside its own existing native scope.

Only the fixed native Apply command runs this module. The parent reads the
private result after the controller exits and its exact completion is verified;
a JSON result or a terminated root is never cleanup authority by itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

from jobctrl import config
from jobctrl.apply.batch_outcome import ApplyBatchCleanupIncomplete, ApplyBatchCounts, ApplyBatchWorkersCrashed
from jobctrl.apply.native_custody import capture_native_custody, matches_active_native_receipt, verify_native_completion
from jobctrl.apply.ownership import ApplyLauncherBusy, ApplyLauncherCleanupIncomplete, ApplyLauncherRun
from jobctrl.apply.process_birth import ApplyCustodyJournal, CustodyUnverified, _directory, _id, _read, _write

logger = logging.getLogger(__name__)

# Reserved by the native private Apply controller only for an authenticated
# helper's process-inspection denial. Other private command failures use 1.
_NATIVE_INSPECTION_DENIED_EXIT = 211


_OPTION_TYPES = {
    "limit": int, "target_job_id": (str, type(None)), "tenant_id": (str, type(None)),
    "min_score": int, "headless": bool, "model": str, "dry_run": bool,
    "continuous": bool, "poll_interval": int, "workers": int,
    "approval_required": bool, "workflow_id": (str, type(None)),
    "standing_refusal_poll": bool,
    "dispatch_frontier": (int, type(None)),
}


def _options(value: object) -> dict:
    required = set(_OPTION_TYPES) - {'dispatch_frontier', 'standing_refusal_poll'}
    if not isinstance(value, dict) or not required <= set(value) <= set(_OPTION_TYPES):
        raise ValueError("Apply execution options do not match the fixed request schema")
    value = {'dispatch_frontier': None, 'standing_refusal_poll': False, **value}
    for key, expected in _OPTION_TYPES.items():
        types = expected if isinstance(expected, tuple) else (expected,)
        if type(value[key]) not in types:
            raise ValueError(f"Apply execution option {key} has an invalid type")
    if value["workers"] < 1 or value["limit"] < 0 or value["poll_interval"] < 0:
        raise ValueError("Apply execution capacity must be positive or explicitly continuous")
    if value['dispatch_frontier'] is not None and value['dispatch_frontier'] < 0:
        raise ValueError('Apply dispatch frontier must be nonnegative')
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
class _MetricState:
    admitted: bool = False
    verified_binding: dict | None = None


def _publish_scoped_metric(identity: str, options: dict, state: _MetricState, started: float,
                           output: tuple[int, int] | None, error: BaseException | None) -> None:
    """Publish a child metric only after native custody and its result are verified."""
    from jobctrl.apply.launcher import _record_apply_batch_metric

    try:
        metric = None
        directory = _invocation_dir(identity)
        _directory(directory)
        path = directory / "terminal-metric.json"
        has_sidecar = path.exists() or path.is_symlink()
        value = None
        if has_sidecar:
            try:
                value = _read(path)
            except (CustodyUnverified, OSError, ValueError, TypeError):
                logger.warning("Deferred Apply metric is unavailable or invalid", exc_info=True)
        legacy = not has_sidecar or (value is not None and type(value.get("schema")) is int
                                    and value == {"schema": 1, "request_id": identity, "state": "requested"})
        # A verified older child already published its own terminal metric.
        # Retain that behavior without emitting a duplicate.
        if state.verified_binding is not None and legacy:
            return
        if state.verified_binding is None and error is not None and legacy:
            from jobctrl.database import get_connection
            try:
                legacy_terminal = get_connection().execute(
                    "SELECT 1 FROM operational_attempt_metrics WHERE stage='apply' AND attempt_kind='apply_batch' "
                    "AND run_id=? AND outcome != 'started' LIMIT 1", (f"apply:{identity}",),
                ).fetchone()
            except sqlite3.OperationalError as exc:
                if "no such table" not in str(exc):
                    raise
                legacy_terminal = None
            if legacy_terminal is not None:
                return
        if state.verified_binding is not None and value is not None and not legacy:
            try:
                common = {"schema", "request_id", "native_custody", "state"}
                if (type(value.get("schema")) is not int or value["schema"] != 1
                        or value.get("request_id") != identity or value.get("native_custody") != state.verified_binding):
                    raise ValueError("Deferred Apply metric does not match its verified invocation")
                if value.get("state") == "pending" and set(value) == common:
                    value = None
                elif (set(value) != common | {"outcome", "duration_ms", "counts", "error_class"}
                        or value.get("state") != "complete" or value["outcome"] not in {"succeeded", "dry_run", "failed"}
                        or type(value["duration_ms"]) is not int or value["duration_ms"] < 0
                        or (value["error_class"] is not None and (
                            not isinstance(value["error_class"], str)
                            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", value["error_class"])
                        ))):
                    raise ValueError("Invalid deferred Apply metric")
                if value is not None:
                    counts = ApplyBatchCounts.from_dict(value["counts"])
                    if ((value["outcome"] == "succeeded" and (options["dry_run"] or counts.failed or value["error_class"] is not None))
                            or (value["outcome"] == "dry_run" and (not options["dry_run"] or value["error_class"] is not None))
                            or (value["outcome"] == "failed" and not counts.failed and value["error_class"] is None)):
                        raise ValueError("Deferred Apply metric has inconsistent outcome")
                    if error is None:
                        if output != (counts.applied, counts.failed) or counts.worker_crashes:
                            raise ValueError("Deferred Apply metric does not match the verified result")
                    elif isinstance(error, (ApplyBatchWorkersCrashed, ApplyBatchCleanupIncomplete)):
                        if counts != error.counts or value["outcome"] != "failed":
                            raise ValueError("Deferred Apply metric does not match the verified failure")
                    else:
                        value = None
                    if value is not None:
                        metric = value, counts
            except (CustodyUnverified, OSError, ValueError, TypeError, KeyError):
                logger.warning("Deferred Apply metric is unavailable or invalid", exc_info=True)

        # Old children have no sidecar and already record their own metric.
        # Their existing result remains readable after native completion.
        if error is None and metric is None:
            return
        if error is not None and metric is None:
            counts = None
            outcome = "failed"
            error_class = "ApplyLauncherCleanupIncomplete" if isinstance(error, ApplyLauncherCleanupIncomplete) else type(error).__name__
            duration_ms = int((time.monotonic() - started) * 1000)
        else:
            value, counts = metric
            outcome = value["outcome"]
            error_class = value["error_class"]
            duration_ms = value["duration_ms"]

        workers = options["workers"]
        if options["target_job_id"] is not None:
            workers = 1
        elif not options["continuous"] and options["limit"] > 0:
            workers = min(workers, options["limit"])
        _record_apply_batch_metric(
            outcome=outcome, run_id=f"apply:{identity}", tenant_id=options["tenant_id"],
            job_id=options["target_job_id"], dry_run=options["dry_run"], workers=workers, model=options["model"],
            duration_ms=duration_ms, total_applied=counts.applied if counts else None,
            total_failed=counts.failed if counts else None, worker_crashes=counts.worker_crashes if counts else None,
            counts_known=counts is not None, error_class=error_class, error_message=error_class,
        )
    except Exception:
        # Metrics are best effort and cannot grant cleanup or retry authority.
        logger.exception("Could not publish the deferred Apply metric")


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
        state = _MetricState()
        started = time.monotonic()
        try:
            output = self._run_scoped(options, state)
        except BaseException as exc:
            if state.admitted:
                _publish_scoped_metric(self.identity, options, state, started, None, exc)
            raise
        else:
            if state.admitted:
                _publish_scoped_metric(self.identity, options, state, started, output, None)
            return output

    def _run_scoped(self, options: dict, metric_state: _MetricState) -> tuple[int, int]:
        command = _native_command()
        config.APP_DIR.mkdir(parents=True, exist_ok=True)
        directory = _invocation_dir(self.identity)
        directory.mkdir(mode=0o700)
        _write(directory / "terminal-metric.json", {
            "schema": 1, "request_id": self.identity, "state": "requested",
        })
        request = {"schema": 1, "request_id": self.identity, "launcher_id": self.identity, "options": options}
        with (directory / "launcher.log").open("xb") as log:
            os.chmod(directory / "launcher.log", 0o600)
            with self._guard:
                if self._stopped.is_set():
                    raise InterruptedError("Apply execution was cancelled before admission")
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                self._process, self._launched_pid = process, process.pid
                metric_state.admitted = True
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
        value = None
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
            if result is not None and result.get("native_custody") == binding:
                metric_state.verified_binding = binding
        except (CustodyUnverified, OSError, ValueError) as exc:
            if (process.returncode == _NATIVE_INSPECTION_DENIED_EXIT and value is not None
                    and matches_active_native_receipt(value["native_custody"], config.APP_DIR)):
                raise ApplyLauncherCleanupIncomplete(
                    "The system denied a process inspection during Apply cleanup; native custody is retained."
                ) from exc
            raise ApplyLauncherCleanupIncomplete("Apply native execution cleanup remains unverified; its custody is retained") from exc
        finally:
            with self._guard:
                self._process = None
        if (result is None or set(result) != {"schema", "request_id", "launcher_id", "native_custody", "output", "error"}
                or type(result["schema"]) is not int or result["schema"] != 1
                or result["request_id"] != self.identity or result["launcher_id"] != self.identity):
            raise RuntimeError("Apply scoped worker exited without its exact result")
        error = result["error"]
        if isinstance(error, dict):
            # Interpret failure details only after the exact native completion
            # above has authenticated this invocation and its cleanup.
            if set(error) != {"code", "counts"} or result["output"] is not None or process.returncode == 0:
                raise ValueError("Apply scoped worker returned malformed failure details")
            counts = ApplyBatchCounts.from_dict(error["counts"])
            if error["code"] == "apply_worker_crashed":
                raise ApplyBatchWorkersCrashed(counts)
            if error["code"] == "apply_launcher_cleanup_incomplete":
                raise ApplyBatchCleanupIncomplete("Apply owned cleanup remains unresolved", counts)
            raise ValueError("Apply scoped worker returned an unknown failure code")
        if process.returncode != 0 and error == "ApplyLauncherCleanupIncomplete":
            raise ApplyLauncherCleanupIncomplete("Apply scoped worker cleanup remains unresolved")
        if process.returncode != 0 and error == "ApplyLauncherBusy":
            raise ApplyLauncherBusy("Apply scoped worker could not acquire its launcher")
        if process.returncode != 0 or error is not None:
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
    metric_path = directory / "terminal-metric.json"
    defer_metric = metric_path.exists() or metric_path.is_symlink()
    if defer_metric:
        metric_request = _read(metric_path)
        if (type(metric_request.get("schema")) is not int
                or metric_request != {"schema": 1, "request_id": request["request_id"], "state": "requested"}):
            raise CustodyUnverified("Invalid deferred Apply metric request")
        _write(metric_path, {
            "schema": 1, "request_id": request["request_id"], "native_custody": binding, "state": "pending",
        })

    def defer_terminal_metric(metric: dict) -> None:
        # This private handoff contains no job content. It is not interpreted
        # until the parent verifies the exact native completion and binding.
        try:
            _write(metric_path, {
                "schema": 1, "request_id": request["request_id"], "native_custody": binding, "state": "complete",
                "outcome": metric["outcome"], "duration_ms": metric["duration_ms"],
                "counts": {"applied": metric["total_applied"], "failed": metric["total_failed"],
                           "worker_crashes": metric["worker_crashes"]},
                "error_class": metric["error_class"],
            })
        except Exception:
            logger.exception("Could not defer the Apply terminal metric")

    prior_handlers = {kind: signal.getsignal(kind) for kind in (signal.SIGINT, signal.SIGTERM)}
    for kind in prior_handlers:
        signal.signal(kind, lambda _signal, _frame: run.cancel())
    try:
        from jobctrl.apply.launcher import main as run_launcher
        result["output"] = list(run_launcher(**options, install_signal_handlers=False, launcher_run=run,
                                             _terminal_metric_sink=defer_terminal_metric if defer_metric else None))
    except (ApplyBatchWorkersCrashed, ApplyBatchCleanupIncomplete) as exc:
        code = "apply_worker_crashed" if isinstance(exc, ApplyBatchWorkersCrashed) else "apply_launcher_cleanup_incomplete"
        result["error"] = {"code": code, "counts": exc.counts.to_dict()}
        raise
    except BaseException as exc:
        result["error"] = type(exc).__name__
        raise
    finally:
        for kind, handler in prior_handlers.items():
            signal.signal(kind, handler)
        _write(directory / "result.json", result)


if __name__ == "__main__":
    main()
