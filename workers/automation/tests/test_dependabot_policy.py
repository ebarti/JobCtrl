"""Keep automated version selection consistent with reviewed UV boundaries."""

from pathlib import Path
import tomllib

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
VERSION_UPDATE_TYPES = {
    "version-update:semver-major",
    "version-update:semver-minor",
    "version-update:semver-patch",
}


def test_reviewed_uv_cutoffs_exclude_routine_updates_without_security_ranges() -> None:
    manifest = tomllib.loads(
        (REPOSITORY_ROOT / "workers/automation/pyproject.toml").read_text()
    )
    cutoffs = manifest["tool"]["uv"]["exclude-newer-package"]
    policy = yaml.safe_load((REPOSITORY_ROOT / ".github/dependabot.yml").read_text())
    worker_updates = [
        update
        for update in policy["updates"]
        if update["package-ecosystem"] == "uv"
        and update.get("directory") == "/workers/automation"
    ]
    assert len(worker_updates) == 1
    ignores = worker_updates[0].get("ignore", [])
    assert len(ignores) == len(cutoffs)
    assert {rule["dependency-name"] for rule in ignores} == set(cutoffs)
    for rule in ignores:
        # Dependabot applies explicit version ranges to security updates too.
        # Type-only exclusions leave those security attempts eligible.
        assert set(rule) == {"dependency-name", "update-types"}
        assert len(rule["update-types"]) == len(VERSION_UPDATE_TYPES)
        assert set(rule["update-types"]) == VERSION_UPDATE_TYPES
