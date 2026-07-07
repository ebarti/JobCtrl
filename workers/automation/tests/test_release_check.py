from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

_RELEASE_CHECK_PATH = Path(__file__).resolve().parents[3] / "scripts/release_check.py"
_SPEC = importlib.util.spec_from_file_location("release_check", _RELEASE_CHECK_PATH)
assert _SPEC is not None
assert _SPEC.loader is not None
release_check = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = release_check
_SPEC.loader.exec_module(release_check)


def test_public_byline_files_do_not_trigger_default_needles() -> None:
    for rel in (
        Path("package.json"),
        Path("workers/automation/pyproject.toml"),
        Path("README.md"),
    ):
        label = rel.as_posix()
        text = (release_check.ROOT / rel).read_text(encoding="utf-8")

        assert release_check.scan_name(label, rel) == []
        assert release_check.scan_text(label, text, rel) == []


def test_release_check_catches_synthetic_violation_per_class(tmp_path: Path) -> None:
    blocked_distribution = "job" + "hunter"
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          push:
            tags:
              - "v*"
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        f"""
        [project]
        name = "{blocked_distribution}"
        """,
    )
    _write(
        tmp_path / "workers/automation/src/jobctrl/apply/prompt.py",
        """
        section = f"API key: {capsolver_key}"
        defaults = ["Age 18+: Yes", "Felony: No"]
        login = f"{personal.get('password', '')}"
        """,
    )
    _write(tmp_path / "docs/private.md", "SyntheticSecret")
    _write(tmp_path / "exports/dump.sql", "syntheticsecret")
    _write(tmp_path / "config/app.toml", 'SERVICE_API_KEY = "live-secret"')
    _write(tmp_path / ".planning/notes.md", "private planning")
    _write(tmp_path / "runtime/state.sqlite", "")
    _write(tmp_path / "chrome-user-data/Default/Preferences", "{}")
    _track_all(tmp_path)

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
        strict_prompt=True,
    )
    findings = "\n".join(result.findings)

    assert "contains synthetic identity" in findings
    assert "runtime/state.sqlite: private/runtime file" in findings
    assert "browser profile artifact" in findings
    assert "non-placeholder SERVICE_API_KEY assignment" in findings
    assert ".planning/notes.md: private planning corpus" in findings
    assert "distribution name must be" in findings
    assert "CapSolver key is interpolated" in findings
    assert "hardcoded attestation defaults remain" in findings
    assert "profile password is interpolated" in findings


def test_release_check_clean_temp_tree_passes(tmp_path: Path) -> None:
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          push:
            tags:
              - "v*"
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        """
        [project]
        name = "jobctrl"
        """,
    )
    _write(tmp_path / "config/app.toml", 'SERVICE_API_KEY = "YOUR_SERVICE_API_KEY"')
    _write(tmp_path / "docs/readme.md", "Synthetic public docs.")
    _track_all(tmp_path)

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    assert result.findings == []
    assert result.warnings == []


def test_publish_tag_trigger_fails_under_wrong_distribution_name(tmp_path: Path) -> None:
    blocked_distribution = "job" + "hunter"
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          push:
            tags:
              - "v*"
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        f"""
        [project]
        name = "{blocked_distribution}"
        """,
    )
    _track_all(tmp_path)

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    assert any("distribution name must be" in finding for finding in result.findings)


def test_publish_tag_trigger_is_required_after_rename(tmp_path: Path) -> None:
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          workflow_dispatch:
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        """
        [project]
        name = "jobctrl"
        """,
    )
    _track_all(tmp_path)

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    assert any("tag publishing is disabled" in finding for finding in result.findings)


def test_old_product_name_gate_blocks_shipping_surfaces(tmp_path: Path) -> None:
    old_names = ("Job" + "Hunter", "Job" + "Ctl")
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          push:
            tags:
              - "v*"
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        """
        [project]
        name = "jobctrl"
        """,
    )
    _write(tmp_path / "README.md", "\n".join(f"Old name: {old_name}" for old_name in old_names))
    _track_all(tmp_path)

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    assert any("contains old product name" in finding for finding in result.findings)


def test_prompt_tripwires_warn_until_strict(tmp_path: Path) -> None:
    _write(
        tmp_path / "workers/automation/src/jobctrl/apply/prompt.py",
        """
        section = f"API key: {capsolver_key}"
        defaults = ["Age 18+: Yes", "Felony: No"]
        login = f"{personal.get('password', '')}"
        """,
    )

    warning_result = release_check.scan_prompt_tripwires(tmp_path, strict_prompt=False)
    strict_result = release_check.scan_prompt_tripwires(tmp_path, strict_prompt=True)

    assert warning_result.findings == []
    assert len(warning_result.warnings) == 3
    assert strict_result.warnings == []
    assert len(strict_result.findings) == 3


def test_cli_exit_code_is_nonzero_on_synthetic_violation(
    tmp_path: Path, monkeypatch
) -> None:
    _write(
        tmp_path / ".github/workflows/publish.yml",
        """
        name: Publish
        on:
          push:
            tags:
              - "v*"
        jobs: {}
        """,
    )
    _write(
        tmp_path / "workers/automation/pyproject.toml",
        """
        [project]
        name = "jobctrl"
        """,
    )
    _write(tmp_path / "leak.md", "SyntheticSecret")
    _track_all(tmp_path)

    monkeypatch.setattr(release_check, "ROOT", tmp_path)
    monkeypatch.setattr(
        release_check,
        "FORBIDDEN_TEXT",
        (release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    assert release_check.main(()) == 1


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dedent(text), encoding="utf-8")


def _dedent(text: str) -> str:
    lines = text.splitlines()
    if lines and not lines[0].strip():
        lines = lines[1:]
    if lines and not lines[-1].strip():
        lines = lines[:-1]
    indents = [len(line) - len(line.lstrip()) for line in lines if line.strip()]
    indent = min(indents, default=0)
    return "\n".join(line[indent:] for line in lines) + "\n"


def _track_all(root: Path) -> None:
    subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True, capture_output=True)
