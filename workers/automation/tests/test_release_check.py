from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
import tarfile
import zipfile
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
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        """
        name: Publish
        on:
          release:
            types: [published]
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
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        """
        name: Publish
        on:
          release:
            types: [published]
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
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
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


def test_published_release_trigger_is_required_after_rename(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
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

    assert any("workflow trigger set must be exactly" in finding for finding in result.findings)


def test_unpublished_release_activity_does_not_satisfy_publish_gate(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        "on:\n  release:\n    types: [unpublished]\n",
    )

    assert release_check._publish_has_release_trigger(tmp_path) is False


def test_release_trigger_rejects_extra_activity_types(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        "on:\n  release:\n    types: [published, edited]\n",
    )

    assert release_check._publish_has_release_trigger(tmp_path) is False


def test_tag_push_publish_trigger_is_rejected(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        """
        name: Publish
        on:
          release:
            types: [published]
          push:
            tags: ["v*"]
        jobs: {}
        """,
    )
    _write_version_surfaces(tmp_path, "2.0.0")
    _track_all(tmp_path)

    result = release_check.scan_tree(tmp_path, needles=())

    assert any("workflow trigger set must be exactly" in finding for finding in result.findings)


def test_any_non_release_trigger_is_rejected(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        "on:\n  release:\n    types: [published]\n  push:\n    branches: [main]\n",
    )
    _write_version_surfaces(tmp_path, "2.0.0")
    _track_all(tmp_path)

    result = release_check.scan_tree(tmp_path, needles=())

    assert any("found ['push', 'release']" in finding for finding in result.findings)


def test_legacy_publish_workflow_path_must_stay_absent(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        """
        name: Release
        on:
          release:
            types: [published]
        jobs: {}
        """,
    )
    _write(
        tmp_path / release_check.LEGACY_PUBLISH_WORKFLOW_PATH,
        "on:\n  push:\n    tags: [\"v*\"]\n",
    )
    _write_version_surfaces(tmp_path, "2.0.0")
    _track_all(tmp_path)

    result = release_check.scan_tree(tmp_path, needles=())

    assert any("legacy workflow path must stay absent" in finding for finding in result.findings)


def test_unrestricted_manual_publish_trigger_is_rejected(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
        """
        name: Publish
        on:
            workflow_dispatch:
            release:
                types: [published]
        jobs: {}
        """,
    )
    _write_version_surfaces(tmp_path, "2.0.0")
    _track_all(tmp_path)

    result = release_check.scan_tree(tmp_path, needles=())

    assert any("workflow trigger set must be exactly" in finding for finding in result.findings)


def test_release_versions_must_match_across_shipped_manifests(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")
    _write(
        tmp_path / "workers/automation/uv.lock",
        '[[package]]\nname = "jobctrl"\nversion = "1.9.0"\n',
    )
    _write(tmp_path / "package.json", '{"name":"jobctrl","version":"0.3.0"}\n')

    findings = release_check._version_parity_findings(tmp_path)

    assert findings == [
        "workers/automation/uv.lock: version '1.9.0' does not match "
        "workers/automation/pyproject.toml '2.0.0'",
        "package.json: version '0.3.0' does not match "
        "workers/automation/pyproject.toml '2.0.0'"
    ]


def test_release_tag_must_match_project_version(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")

    assert release_check._version_parity_findings(tmp_path, release_tag="v2.0.0") == []
    assert release_check._version_parity_findings(tmp_path, release_tag="v1.3") == [
        "release tag 'v1.3' does not match project version v2.0.0"
    ]


def test_public_release_version_requires_three_numeric_segments(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0")

    assert release_check._version_parity_findings(tmp_path, release_tag="v2.0") == [
        "workers/automation/pyproject.toml: public release version '2.0' "
        "must use MAJOR.MINOR.PATCH"
    ]


def test_missing_workspace_manifest_version_is_release_blocking(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")
    _write(tmp_path / "package.json", '{"name":"jobctrl"}\n')

    assert "package.json: missing valid release version" in release_check._version_parity_findings(
        tmp_path
    )


def test_built_distribution_metadata_must_match_project_version(tmp_path: Path) -> None:
    wheel = tmp_path / "workers/automation/dist/jobctrl-0.3.0-py3-none-any.whl"
    wheel.parent.mkdir(parents=True)
    with zipfile.ZipFile(wheel, "w") as bundle:
        bundle.writestr("jobctrl-0.3.0.dist-info/METADATA", "Name: jobctrl\nVersion: 0.3.0\n")

    sdist = tmp_path / "workers/automation/dist/jobctrl-2.0.0.tar.gz"
    payload = b"Name: jobctrl\nVersion: 2.0.0\n"
    with tarfile.open(sdist, "w:gz") as bundle:
        info = tarfile.TarInfo("jobctrl-2.0.0/PKG-INFO")
        info.size = len(payload)
        bundle.addfile(info, io.BytesIO(payload))

    wheel_findings = release_check._distribution_version_findings(
        tmp_path, wheel, "2.0.0"
    )
    sdist_findings = release_check._distribution_version_findings(
        tmp_path, sdist, "2.0.0"
    )

    assert wheel_findings == [
        "workers/automation/dist/jobctrl-0.3.0-py3-none-any.whl!"
        "jobctrl-0.3.0.dist-info/METADATA: distribution version '0.3.0' does not match "
        "workers/automation/pyproject.toml '2.0.0'"
    ]
    assert sdist_findings == []


def test_homebrew_formula_requires_tap_sync_workflow(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_PATH,
        'class Jobctrl < Formula\n  depends_on "corepack"\nend\n',
    )

    findings = release_check._homebrew_sync_findings(tmp_path)

    assert findings == [
        ".github/workflows/sync-homebrew-tap.yml: canonical Homebrew formula has no tap synchronization workflow"
    ]


def test_homebrew_tap_sync_workflow_must_cover_main_and_releases(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_PATH,
        'class Jobctrl < Formula\n  depends_on "corepack"\nend\n',
    )
    _write(
        tmp_path / release_check.HOMEBREW_SYNC_WORKFLOW_PATH,
        """
        on:
          push:
            branches: ["main"]
          release:
            types: [published]
        jobs:
          sync:
            steps:
              - run: python3 scripts/release_check.py --strict-prompt
              - uses: actions/checkout@v4
                with:
                  repository: ebarti/homebrew-tap
                  ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}
              - run: install packaging/homebrew/Formula/jobctrl.rb homebrew-tap/Formula/jobctrl.rb
              - run: git status --short --untracked-files=all -- Formula/jobctrl.rb
        """,
    )

    assert release_check._homebrew_sync_findings(tmp_path) == []


def test_homebrew_tap_sync_workflow_must_detect_an_untracked_formula(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_PATH,
        'class Jobctrl < Formula\n  depends_on "corepack"\nend\n',
    )
    _write(
        tmp_path / release_check.HOMEBREW_SYNC_WORKFLOW_PATH,
        """
        on:
          push:
            branches: ["main"]
          release:
            types: [published]
        jobs:
          sync:
            steps:
              - run: python3 scripts/release_check.py --strict-prompt
              - uses: actions/checkout@v4
                with:
                  repository: ebarti/homebrew-tap
                  ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}
              - run: install packaging/homebrew/Formula/jobctrl.rb homebrew-tap/Formula/jobctrl.rb
        """,
    )

    assert any(
        "does not detect an absent or untracked tap formula" in finding
        for finding in release_check._homebrew_sync_findings(tmp_path)
    )


def test_homebrew_formula_must_install_corepack(tmp_path: Path) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_PATH,
        'class Jobctrl < Formula\n  depends_on "node"\nend\n',
    )
    _write(
        tmp_path / release_check.HOMEBREW_SYNC_WORKFLOW_PATH,
        """
        on:
          push:
            branches: ["main"]
          release:
            types: [published]
        jobs:
          sync:
            steps:
              - run: python3 scripts/release_check.py --strict-prompt
              - uses: actions/checkout@v4
                with:
                  repository: ebarti/homebrew-tap
                  ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}
              - run: install packaging/homebrew/Formula/jobctrl.rb homebrew-tap/Formula/jobctrl.rb
              - run: git status --short --untracked-files=all -- Formula/jobctrl.rb
        """,
    )

    assert release_check._homebrew_sync_findings(tmp_path) == [
        "packaging/homebrew/Formula/jobctrl.rb: does not install Corepack required by the launcher and installer"
    ]


def test_homebrew_tap_sync_gates_before_loading_publish_credentials(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_PATH,
        'class Jobctrl < Formula\n  depends_on "corepack"\nend\n',
    )
    _write(
        tmp_path / release_check.HOMEBREW_SYNC_WORKFLOW_PATH,
        """
        on:
          push:
            branches: ["main"]
          release:
            types: [published]
        jobs:
          sync:
            steps:
              - uses: actions/checkout@v4
                with:
                  repository: ebarti/homebrew-tap
                  ssh-key: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}
              - run: python3 scripts/release_check.py --strict-prompt
              - run: install packaging/homebrew/Formula/jobctrl.rb homebrew-tap/Formula/jobctrl.rb
              - run: git status --short --untracked-files=all -- Formula/jobctrl.rb
        """,
    )

    assert any(
        "loads tap credentials before the strict release privacy gate" in finding
        for finding in release_check._homebrew_sync_findings(tmp_path)
    )


def test_publish_workflow_scans_built_archives_before_upload() -> None:
    workflow = (release_check.ROOT / release_check.PUBLISH_WORKFLOW_PATH).read_text(
        encoding="utf-8"
    )

    build = workflow.index("python -m build workers/automation")
    scan = workflow.index("python3 scripts/release_check.py --strict-prompt")
    publish = workflow.index("uses: pypa/gh-action-pypi-publish@release/v1")

    assert build < scan < publish
    assert 'test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"' in workflow
    assert "release:\n    types: [published]" in workflow
    assert "if: github.event.release.prerelease == false" in workflow
    assert "contents: read" in workflow
    assert "workflow_dispatch:" not in workflow


def test_release_privacy_workflow_enforces_strict_prompt_gate() -> None:
    workflow = (
        release_check.ROOT / ".github/workflows/release-check.yml"
    ).read_text(encoding="utf-8")

    assert "python3 scripts/release_check.py --strict-prompt" in workflow


def test_old_product_name_gate_blocks_shipping_surfaces(tmp_path: Path) -> None:
    old_names = ("Job" + "Hunter", "Job" + "Ctl")
    _write(
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
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
        tmp_path / release_check.PUBLISH_WORKFLOW_PATH,
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


def _write_version_surfaces(root: Path, version: str) -> None:
    _write(
        root / "workers/automation/pyproject.toml",
        f'[project]\nname = "jobctrl"\nversion = "{version}"\n',
    )
    _write(
        root / "workers/automation/src/jobctrl/__init__.py",
        f'__version__ = "{version}"\n',
    )
    _write(
        root / "workers/automation/uv.lock",
        f'[[package]]\nname = "jobctrl"\nversion = "{version}"\n',
    )
    for rel in release_check.PACKAGE_VERSION_PATHS:
        _write(root / rel, f'{{"name":"jobctrl","version":"{version}"}}\n')
    _write(
        root / release_check.EXTENSION_MANIFEST_PATH,
        f'{{"name":"JobCtrl","version":"{version}"}}\n',
    )


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
