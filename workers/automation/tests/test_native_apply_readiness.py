"""Publication contract for the controlled native Apply test fixture."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
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
