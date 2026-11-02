"""Secret-free diagnostics contracts; no native store or PowerShell is invoked."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("native_host_diagnostics_under_test", Path(__file__).with_name("native-credentials-host.py"))
assert spec and spec.loader
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

SECRET = "synthetic-private-command-output"


class NativeHostDiagnosticsTests(unittest.TestCase):
    def setUp(self) -> None:
        host.set_phase("initial_native_read")

    def assert_private(self, output: str) -> None:
        self.assertTrue(SECRET not in output, "Sensitive input reached native QA diagnostics")

    def test_only_fixed_subphases_and_numeric_timings_are_retained(self) -> None:
        stderr = (
            f"{SECRET}\nJOBCTRL_NATIVE_QA_PHASE:compilation:12\n"
            f"JOBCTRL_NATIVE_QA_PHASE:{SECRET}:13\n"
            "JOBCTRL_NATIVE_QA_PHASE:compiled:not-a-time\n"
            "JOBCTRL_NATIVE_QA_PHASE:input_parsed:14:extra\n"
        ).encode()
        phases = host.windows_phases(stderr)
        self.assertTrue(phases == [{"phase": "compilation", "elapsedMs": 12}], "Diagnostic projection changed")
        self.assert_private(json.dumps(phases))
        with self.assertRaises(ValueError):
            host.set_phase(SECRET)

    def test_diagnostic_runner_preserves_request_timeout_and_native_result(self) -> None:
        command = ["owned-powershell", "-Command", host.native.WINDOWS_CREDENTIAL_SCRIPT]
        result = subprocess.CompletedProcess(command, 44, stdout=SECRET,
            stderr=f"JOBCTRL_NATIVE_QA_PHASE:script_started:0\nJOBCTRL_NATIVE_QA_PHASE:module_load:1\n{SECRET}")
        output = io.StringIO()
        with patch.object(host.subprocess, "run", return_value=result) as run, contextlib.redirect_stderr(output):
            observed = host.native_run(command, input=SECRET, timeout=15.0, capture_output=True, text=True)
        self.assertTrue(observed is result, "Native result identity changed")
        actual_command = run.call_args.args[0]
        self.assertEqual(actual_command[:-1], command[:-1])
        self.assertTrue(SECRET not in actual_command[-1], "Request data was placed in the PowerShell command")
        self.assertTrue(run.call_args.kwargs == {"input": SECRET, "timeout": 15.0, "capture_output": True, "text": True},
                        "Native request, timeout or capture options changed")
        self.assertEqual(host.native.WINDOWS_COMMAND_TIMEOUT_SECONDS, 15.0)
        record = json.loads(output.getvalue())
        self.assertEqual(record["phase"], "initial_native_read")
        self.assertEqual(record["windowsPhases"][-1]["phase"], "module_load")
        self.assert_private(output.getvalue())

    def test_timeout_retains_safe_partial_progress_without_serializing_command_output(self) -> None:
        timeout = subprocess.TimeoutExpired(SECRET, 15, output=SECRET,
            stderr=f"JOBCTRL_NATIVE_QA_PHASE:compilation:5\n{SECRET}".encode())
        output = io.StringIO()
        with patch.object(host.subprocess, "run", side_effect=timeout), contextlib.redirect_stderr(output):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                host.native_run(["owned-powershell", host.native.WINDOWS_CREDENTIAL_SCRIPT], input=SECRET, timeout=15.0)
        self.assertTrue(raised.exception is timeout, "The primary timeout changed")
        record = json.loads(output.getvalue())
        self.assertEqual(record["errorType"], "TimeoutExpired")
        self.assertEqual(record["windowsPhases"], [{"phase": "compilation", "elapsedMs": 5}])
        self.assert_private(output.getvalue())

    def test_primary_failure_survives_an_independent_cleanup_failure(self) -> None:
        timeout = subprocess.TimeoutExpired(SECRET, 15, stderr=SECRET)
        primary = host.native.NativeCredentialError(SECRET)
        primary.__cause__ = timeout
        store = Mock()
        store.read.side_effect = primary
        store.delete.side_effect = PermissionError(SECRET)
        with patch.object(host.native, "NativeCredentialStore", return_value=store), \
             patch.object(host.platform, "system", return_value="Windows"), \
             patch.object(sys, "argv", ["native-credentials-host.py"]), \
             patch.dict(os.environ, {"SystemRoot": "owned-system-root"}, clear=True):
            with self.assertRaises(host.NativeHostProofFailure) as raised:
                host.main()
        diagnostic = host.failure_diagnostic(raised.exception)
        self.assertEqual(diagnostic["phase"], "initial_native_read")
        self.assertEqual(diagnostic["primaryFailure"]["errorType"], "NativeCredentialError")
        self.assertEqual(diagnostic["primaryFailure"]["causeType"], "TimeoutExpired")
        self.assertEqual(diagnostic["cleanupFailures"][0]["phase"], "cleanup_native_delete")
        self.assertEqual(diagnostic["cleanupFailures"][0]["errorType"], "PermissionError")
        self.assert_private(json.dumps(diagnostic))
        store.delete.assert_called_once()

    def test_cleanup_only_failure_and_daemon_failure_both_remain_failures(self) -> None:
        store = Mock()
        store.read.return_value = SECRET
        daemon = Mock()
        daemon.terminate.side_effect = OSError(SECRET)
        cleanup = host.cleanup_owned_target(store, "GEMINI_API_KEY", daemon)
        diagnostic = host.failure_diagnostic(host.NativeHostProofFailure(None, cleanup))
        self.assertIsNone(diagnostic["primaryFailure"])
        self.assertEqual(diagnostic["status"], "failed")
        self.assertEqual([entry["phase"] for entry in cleanup], ["cleanup_native_read", "cleanup_daemon"])
        self.assert_private(json.dumps(diagnostic))

    def test_unknown_error_names_and_changed_script_boundaries_do_not_expose_inputs(self) -> None:
        self.assertTrue(host.error_type(type(SECRET, (Exception,), {})(SECRET)) == "OtherError", "Unrecognized error type was emitted")
        with self.assertRaises(RuntimeError) as raised:
            host.instrument_windows_script(SECRET)
        self.assert_private(str(raised.exception))

    def test_file_cleanup_does_not_mask_the_primary_or_native_cleanup(self) -> None:
        primary = host.failure(ValueError(SECRET))
        host.set_phase("cleanup_native_delete")
        native_cleanup = host.failure(OSError(SECRET))
        try:
            raise host.NativeHostProofFailure(primary, [native_cleanup])
        except host.NativeHostProofFailure:
            host.set_phase("cleanup_files")
            try:
                raise PermissionError(SECRET)
            except PermissionError as error:
                diagnostic = host.failure_diagnostic(error)
        self.assertEqual(diagnostic["primaryFailure"]["phase"], "initial_native_read")
        self.assertEqual([entry["phase"] for entry in diagnostic["cleanupFailures"]],
                         ["cleanup_native_delete", "cleanup_files"])
        self.assert_private(json.dumps(diagnostic))


if __name__ == "__main__":
    unittest.main()
