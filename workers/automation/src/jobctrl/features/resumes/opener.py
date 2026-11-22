"""Explicit native open request for a verified, registered owned PDF."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys

from .domain import ResumeError


class ArtifactOpener:
    def __init__(self, executable=None):
        self.executable = executable

    def open(self, path: str):
        executable = self.executable
        if executable is None:
            executable = "/usr/bin/open" if sys.platform == "darwin" else (
                shutil.which("xdg-open") if sys.platform.startswith("linux") else None)
        if not executable or not Path(executable).is_file() or not os.access(executable, os.X_OK):
            raise ResumeError("resume_artifact_open_unavailable", "A supported native artifact opener is unavailable.")
        try:
            subprocess.run([executable, path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            raise ResumeError("resume_artifact_open_failed", "The native open request was not acknowledged.") from None
