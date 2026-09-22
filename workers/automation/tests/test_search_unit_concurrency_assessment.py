from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_search_unit_assessment_smoke_exercises_the_durable_path_offline(
    tmp_path: Path,
) -> None:
    output = tmp_path / "assessment-smoke.json"
    repo_root = Path(__file__).resolve().parents[3]

    completed = subprocess.run(
        [
            sys.executable,
            "workers/automation/scripts/search_unit_concurrency_assessment.py",
            "--output",
            str(output),
            "--smoke",
            "--repeats",
            "1",
        ],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )

    artifact = json.loads(output.read_text(encoding="utf-8"))
    sample = artifact["arms"]["current_policy_baseline"]["samples"][0]
    assert completed.returncode == 0
    assert artifact["mode"] == "smoke"
    assert artifact["scope"]["durable_path"] == "jobctrl.discovery.jobspy.run_discovery"
    assert artifact["scope"]["network"] == "all socket connect operations blocked"
    assert sample["database"]["unit_states"] == ["completed"]
    assert sample["database"]["job_rows"] == 1
    assert sample["database"]["receipt_rows"] == 1
    assert sample["invariants"]["all_units_checkpointed"] is True
