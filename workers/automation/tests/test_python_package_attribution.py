from __future__ import annotations

import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path


_WORKER_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _WORKER_ROOT.parents[1]


def test_python_distributions_include_verbatim_root_license_and_notice(tmp_path: Path) -> None:
    with (_WORKER_ROOT / "pyproject.toml").open("rb") as stream:
        version = tomllib.load(stream)["project"]["version"]
    license_bytes = (_REPO_ROOT / "LICENSE").read_bytes()
    notice_bytes = (_REPO_ROOT / "NOTICE").read_bytes()

    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--no-isolation",
            "--outdir",
            str(tmp_path),
            ".",
        ],
        cwd=_WORKER_ROOT,
        check=True,
    )

    wheel = tmp_path / f"jobctrl-{version}-py3-none-any.whl"
    source_distribution = tmp_path / f"jobctrl-{version}.tar.gz"
    with zipfile.ZipFile(wheel) as archive:
        assert archive.read(f"jobctrl-{version}.dist-info/licenses/LICENSE") == license_bytes
        assert archive.read(f"jobctrl-{version}.dist-info/licenses/NOTICE") == notice_bytes
    with tarfile.open(source_distribution) as archive:
        license_member = archive.getmember(f"jobctrl-{version}/LICENSE")
        notice_member = archive.getmember(f"jobctrl-{version}/NOTICE")
        assert archive.extractfile(license_member).read() == license_bytes
        assert archive.extractfile(notice_member).read() == notice_bytes
