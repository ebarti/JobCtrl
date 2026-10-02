"""Build actual wheel/sdist and load the resource from an isolated wheel install."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


def test_wheel_sdist_and_source_absent_install_have_identical_raw_catalog(tmp_path):
    project = Path(__file__).resolve().parents[1]
    raw = (project / "src/jobctrl/assets/interview/catalog.v1.json").read_bytes()
    expected = hashlib.sha256(raw).hexdigest()
    artifacts = tmp_path / "artifacts"
    subprocess.run([sys.executable, "-m", "build", "--no-isolation", "--outdir", str(artifacts), str(project)], check=True, capture_output=True, text=True, timeout=120)
    wheel = next(artifacts.glob("*.whl"))
    sdist = next(artifacts.glob("*.tar.gz"))
    with zipfile.ZipFile(wheel) as archive:
        assert archive.read("jobctrl/assets/interview/catalog.v1.json") == raw
        assert not any("docs/research" in name or "prototype" in name for name in archive.namelist())
    with tarfile.open(sdist) as archive:
        member = next(member for member in archive.getmembers() if member.name.endswith("/src/jobctrl/assets/interview/catalog.v1.json"))
        assert archive.extractfile(member).read() == raw
    installed = tmp_path / "worker/site-packages"
    uv = shutil.which("uv")
    assert uv is not None
    subprocess.run([uv, "pip", "install", "--no-deps", "--target", str(installed), str(wheel)], check=True, capture_output=True, text=True, timeout=60)
    sandbox = tmp_path / "source-absent"
    sandbox.mkdir()
    script = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import jobctrl
from jobctrl.domain.interview.catalog import catalog_raw_digest, load_interview_catalog
catalog = load_interview_catalog()
assert Path(jobctrl.__file__).is_relative_to(Path(sys.argv[1]))
assert not Path('docs').exists()
print(json.dumps({'rawDigest':catalog_raw_digest(),'catalogDigest':catalog['catalogDigest'],'questionCount':len(catalog['questions']),'loadedFromWheel':True}))
"""
    result = subprocess.run([sys.executable, "-I", "-c", script, str(installed)], cwd=sandbox, env={key: value for key, value in os.environ.items() if key != "PYTHONPATH"}, check=True, capture_output=True, text=True, timeout=30)
    observed = json.loads(result.stdout)
    assert observed == {"rawDigest": expected, "catalogDigest": json.loads(raw)["catalogDigest"], "questionCount": 121, "loadedFromWheel": True}
    (installed / "jobctrl/assets/interview/catalog.v1.json").unlink()
    missing = subprocess.run([sys.executable, "-I", "-c", script, str(installed)], cwd=sandbox, capture_output=True, text=True, timeout=30)
    assert missing.returncode != 0 and "FileNotFoundError" in missing.stderr
