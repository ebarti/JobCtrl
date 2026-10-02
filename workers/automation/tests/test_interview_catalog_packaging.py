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
    source_root = project.parents[1]
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
    isolated = tmp_path / "isolated-python"
    environment = {key: value for key, value in os.environ.items() if key not in {"PYTHONPATH", "UV_EXCLUDE_NEWER"}}
    subprocess.run([uv, "venv", "--python", sys.executable, str(isolated)], env=environment, check=True, capture_output=True, text=True, timeout=60)
    executable = isolated / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    requirements = tmp_path / "production-requirements.txt"
    subprocess.run([uv, "--project", str(project), "export", "--locked", "--no-default-groups", "--no-dev", "--no-emit-project", "--format", "requirements-txt", "--output-file", str(requirements)], env=environment, check=True, capture_output=True, text=True, timeout=60)
    # The real installed worker includes these already-declared, locked runtime
    # dependencies. No editable source install or provider pack is involved.
    subprocess.run([uv, "pip", "sync", "--python", str(executable), str(requirements)], env=environment, check=True, capture_output=True, text=True, timeout=120)
    subprocess.run([uv, "pip", "install", "--no-deps", "--target", str(installed), str(wheel)], env=environment, check=True, capture_output=True, text=True, timeout=60)
    sandbox = tmp_path / "source-absent"
    sandbox.mkdir()
    script = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
if len(sys.argv) > 3:
    sys.path.append(sys.argv[3])
import jobctrl
from jobctrl.domain.interview.catalog import catalog_raw_digest, load_interview_catalog
catalog = load_interview_catalog()
assert Path(jobctrl.__file__).is_relative_to(Path(sys.argv[1]))
assert not Path('docs').exists()
source_root = Path(sys.argv[2]).resolve()
assert not any(Path(entry).resolve().is_relative_to(source_root) for entry in sys.path)
assert not any('/plugins/' in entry for entry in sys.path)
print(json.dumps({'rawDigest':catalog_raw_digest(),'catalogDigest':catalog['catalogDigest'],'questionCount':len(catalog['questions']),'loadedFromWheel':True}))
"""
    command = [str(executable), "-I", "-c", script, str(installed), str(source_root)]
    result = subprocess.run(command, cwd=sandbox, env=environment, check=True, capture_output=True, text=True, timeout=30)
    observed = json.loads(result.stdout)
    assert observed == {"rawDigest": expected, "catalogDigest": json.loads(raw)["catalogDigest"], "questionCount": 121, "loadedFromWheel": True}
    for leaked_source in (source_root, project / "src"):
        leaked = subprocess.run([*command, str(leaked_source)], cwd=sandbox, env=environment, capture_output=True, text=True, timeout=30)
        assert leaked.returncode != 0 and "AssertionError" in leaked.stderr
    (installed / "jobctrl/assets/interview/catalog.v1.json").unlink()
    missing = subprocess.run(command, cwd=sandbox, env=environment, capture_output=True, text=True, timeout=30)
    assert missing.returncode != 0 and "FileNotFoundError" in missing.stderr
