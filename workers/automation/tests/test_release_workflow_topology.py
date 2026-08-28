from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
RELEASE_WORKFLOW = REPOSITORY_ROOT / ".github/workflows/release-distribution.yml"


def _needs(job: dict[str, object]) -> set[str]:
    value = job.get("needs", [])
    if isinstance(value, str):
        return {value}
    assert isinstance(value, list)
    return set(value)


def test_release_workflow_has_one_deployment_after_one_signing_approval() -> None:
    jobs = yaml.safe_load(RELEASE_WORKFLOW.read_text())["jobs"]
    expected_environment_jobs = {
        "resolve",
        "sign",
        "publish-immutable",
        "publish-homebrew",
        "promote-channel-pointer",
        "publish-github-release",
        "publish-pypi",
    }
    environment_jobs = {
        job_name: job
        for job_name, job in jobs.items()
        if "environment" in job
    }
    assert set(environment_jobs) == expected_environment_jobs

    deployments: list[tuple[str, str]] = []
    for job_name, job in environment_jobs.items():
        environment = job["environment"]
        if isinstance(environment, str):
            environment_name = environment
            creates_deployment = True
        else:
            environment_name = environment["name"]
            creates_deployment = environment.get("deployment", True)
        if creates_deployment:
            deployments.append((job_name, environment_name))
        elif job_name != "sign":
            assert environment["deployment"] is False

    assert deployments == [("sign", "release-signing")]

    def ancestors(job_name: str) -> set[str]:
        pending = list(_needs(jobs[job_name]))
        found: set[str] = set()
        while pending:
            dependency = pending.pop()
            if dependency in found:
                continue
            found.add(dependency)
            pending.extend(_needs(jobs[dependency]))
        return found

    for job_name in expected_environment_jobs - {"resolve", "sign"}:
        assert "sign" in ancestors(job_name), job_name
