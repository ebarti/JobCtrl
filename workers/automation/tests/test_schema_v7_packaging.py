"""Packaging contract for the self-contained exact-v7 schema."""

from __future__ import annotations

import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


_AUTOMATION_ROOT = Path(__file__).resolve().parents[1]
_SCHEMA_MEMBERS = {
    "jobctrl/infrastructure/migrations/schema_v7.sql",
    "jobctrl/infrastructure/migrations/schema_v8.sql",
}


def test_exact_v7_schema_is_bundled_in_wheel_and_sdist(tmp_path: Path) -> None:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--no-isolation",
            "--wheel",
            "--sdist",
            "--outdir",
            str(tmp_path),
        ],
        cwd=_AUTOMATION_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    wheel = next(tmp_path.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        assert _SCHEMA_MEMBERS <= set(archive.namelist())

    sdist = next(tmp_path.glob("*.tar.gz"))
    with tarfile.open(sdist) as archive:
        names = {member.name for member in archive}
        assert all(any(name.endswith(schema) for name in names) for schema in _SCHEMA_MEMBERS)
