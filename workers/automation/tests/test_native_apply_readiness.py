"""Publication contract for the controlled native Apply test fixture."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Event
import time
import unittest
from unittest.mock import patch

from tests.helpers import apply_execution_ports


class NativeApplyReadinessTests(unittest.TestCase):
    def test_readers_see_only_absent_or_complete_marker_during_write(self):
        evidence = {"job_id": "synthetic", "scope_id": "new-scope", "port": 1234}
        for prior in (None, {"job_id": "synthetic", "scope_id": "prior-scope", "port": 1233}):
            with self.subTest(prior=prior), TemporaryDirectory() as directory:
                marker = Path(directory) / "ready-synthetic.json"
                if prior is not None:
                    marker.write_text(json.dumps(prior))
                writing, proceed = Event(), Event()

                def delayed_dump(value, stream):
                    encoded = json.dumps(value)
                    stream.write(encoded[:1])
                    stream.flush()
                    writing.set()
                    if not proceed.wait(5):
                        raise TimeoutError("publication probe was not released")
                    stream.write(encoded[1:])

                with patch.object(apply_execution_ports.json, "dump", delayed_dump):
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(apply_execution_ports._publish_ready, marker, evidence)
                        try:
                            self.assertTrue(writing.wait(5))
                            if prior is None:
                                self.assertFalse(marker.exists())
                            else:
                                self.assertEqual(json.loads(marker.read_text()), prior)
                        finally:
                            proceed.set()
                        future.result(timeout=5)
                self.assertEqual(json.loads(marker.read_text()), evidence)
                self.assertEqual(list(Path(directory).iterdir()), [marker])

    def test_failed_publication_preserves_prior_marker_and_cleans_temporary_file(self):
        with TemporaryDirectory() as directory:
            marker = Path(directory) / "ready-synthetic.json"
            marker.write_text('{"scope_id":"prior-scope"}')
            with patch.object(Path, "replace", side_effect=OSError("controlled publish failure")):
                with self.assertRaisesRegex(OSError, "controlled publish failure"):
                    apply_execution_ports._publish_ready(marker, {"scope_id": "new-scope"})
            self.assertEqual(json.loads(marker.read_text()), {"scope_id": "prior-scope"})
            self.assertEqual(list(Path(directory).iterdir()), [marker])

    @unittest.skipIf(os.name == "nt", "POSIX owned-session fixture")
    def test_custody_writer_has_stable_progress_after_its_owned_exit(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            harness = Path(__file__).parent / "helpers" / "apply_custody_native.py"
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", str(harness), "writer", str(root), str(root), str(root)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={"HOME": str(root), "PATH": "/usr/bin:/bin", "TMPDIR": str(root)},
            )
            try:
                ready, ticks = root / "writer-ready.json", root / "writer-ticks"
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    self.assertIsNone(process.poll(), "synthetic writer exited before readiness")
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "synthetic writer did not become ready")
                identity = json.loads(ready.read_text())
                self.assertEqual(identity, {"pid": process.pid, "sid": process.pid})
                initial = int(ticks.read_text())
                while int(ticks.read_text()) == initial and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertGreater(int(ticks.read_text()), initial)
                process.kill()
                process.wait(timeout=5)
                after = ticks.read_text()
                self.assertTrue(after)
                time.sleep(0.05)
                self.assertEqual(ticks.read_text(), after)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
