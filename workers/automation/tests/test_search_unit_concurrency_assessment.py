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
    assert artifact["schema_version"] == 2
    assert artifact["scope"]["durable_path"] == "jobctrl.discovery.jobspy.run_discovery"
    assert artifact["scope"]["network"] == "all socket connect operations blocked"
    assert sample["database"]["unit_states"] == ["completed"]
    assert sample["database"]["job_rows"] == 1
    assert sample["database"]["receipt_rows"] == 1
    assert sample["invariants"]["all_units_checkpointed"] is True
    resume = artifact["scenarios"]["store_before_ack_resume"]
    assert resume["limiter"] == "HostRateLimiter"
    assert resume["after_interruption"]["unit_states"] == ["running"]
    assert resume["after_interruption"]["checkpoint_revisions"] == [0]
    assert resume["after_interruption"]["receipt_counts"] == {
        "accepted": 1,
        "existing": 0,
        "new": 1,
    }
    assert resume["final_database"]["unit_states"] == ["completed"]
    assert resume["final_database"]["checkpoint_revisions"] == [3]
    assert resume["final_database"]["recovery_count"] == 1
    assert all(resume["invariants"].values())

    before_ack = artifact["scenarios"]["exact_limit_before_ack"]
    after_ack = artifact["scenarios"]["exact_limit_after_ack_before_skip"]
    for scenario, interrupted_revision in ((before_ack, 0), (after_ack, 1)):
        assert scenario["limiter"] == "HostRateLimiter"
        assert scenario["after_interruption"]["checkpoint_revisions"] == [
            interrupted_revision,
            None,
        ]
        assert scenario["final_database"]["unit_states"] == ["skipped", "skipped"]
        assert scenario["final_database"]["receipt_rows"] == 1
        assert scenario["final_database"]["job_rows"] == 1
        assert scenario["result"]["new"] == 1
        assert scenario["result"]["skipped_units"] == 2
        assert all(scenario["invariants"].values())

    budget = artifact["scenarios"]["tiny_budget_recovery_boundary"]
    assert budget["limiter"] == "HostRateLimiter"
    assert budget["synthetic_assumptions"]["max_search_unit_invocations_per_run"] == 2
    assert budget["adapter_calls"] == 2
    assert budget["final_database"]["durable_invocation_count"] == 3
    assert budget["final_database"]["unit_states"] == [
        "completed",
        "skipped",
        "skipped",
    ]
    assert budget["final_database"]["checkpoint_revisions"] == [3, None, None]
    assert budget["final_database"]["receipt_rows"] == 1
    assert budget["final_database"]["budget_exhausted_rows"] == [
        {
            "failure_category": "budget_exhausted",
            "is_operational_failure": False,
            "is_retryable": True,
            "is_scrape_failure": False,
            "metadata": {
                "reason": "JobStreaming per-run search-unit budget exhausted",
            },
            "outcome": "blocked",
        }
    ]
    assert all(budget["invariants"].values())
    assert artifact["provenance"]["python_executable"] == "workers/automation/.venv/bin/python"
    assert str(repo_root) not in output.read_text(encoding="utf-8")
