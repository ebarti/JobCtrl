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


def test_public_copyright_attribution_does_not_disable_private_name_detection() -> None:
    holder = "El" + "oi Barti"
    first_name = "El" + "oi"

    assert release_check.scan_text(
        "NOTICE",
        f"Copyright (C) 2026 {holder}\n",
        Path("NOTICE"),
    ) == []
    assert release_check.scan_text(
        "README.md",
        f"Candidate profile: {first_name}\n",
        Path("README.md"),
    ) == ["README.md: contains private first name"]


def test_public_controller_disclosures_are_limited_to_exact_public_surfaces() -> None:
    controller = "El" + "oi Barti"
    email = "me@" + "el" + "oi" + "barti" + ".com"
    source_disclosure = (
        f"Data controller: {controller}, acting as an individual. Privacy questions:\n"
        f'<a href="mailto:{email}">{email}</a>'
    )
    docs_disclosure = (
        f"The data controller for the public demo is {controller}, acting as an individual.\n"
        f"For privacy questions, contact [{email}](mailto:{email})."
    )
    docs_analytics_disclosure = (
        f"The data controller for this documentation measurement is {controller}, acting as\n"
        "an individual. For privacy questions, contact\n"
        f"[{email}](mailto:{email})."
    )
    test_disclosure = (
        f"screen.getByText(/data controller: {controller.lower()}, acting as an individual/i)\n"
        f'screen.getByRole("link", {{ name: "{email}" }})).toHaveAttribute(\n'
        f'  "href",\n  "mailto:{email}",\n)'
    )
    emitted_demo_disclosure = (
        f'Data controller: {controller}, acting as an individual. Privacy questions: "," '
        f'I.jsx("a",{{href:"mailto:{email}",children:"{email}"}})'
    )

    assert release_check.scan_text(
        "apps/web/src/demo/consent/DemoConsentGate.tsx",
        source_disclosure,
        Path("apps/web/src/demo/consent/DemoConsentGate.tsx"),
    ) == []
    assert release_check.scan_text(
        "docs/user/data-and-safety.md",
        docs_disclosure,
        Path("docs/user/data-and-safety.md"),
    ) == []
    assert release_check.scan_text(
        "docs/user/data-and-safety.md",
        docs_analytics_disclosure,
        Path("docs/user/data-and-safety.md"),
    ) == []
    assert release_check.scan_text(
        "apps/web/src/demo/consent/DemoConsentGate.test.tsx",
        test_disclosure,
        Path("apps/web/src/demo/consent/DemoConsentGate.test.tsx"),
    ) == []
    assert release_check.scan_text(
        "dist/web/assets/demo.js",
        emitted_demo_disclosure,
        Path("dist/web/assets/demo.js"),
    ) == []
    assert release_check.scan_text(
        "dist/web/assets/demo.js.map",
        source_disclosure.replace('"', '\\"'),
        Path("dist/web/assets/demo.js.map"),
    ) == []
    assert release_check.scan_text(
        "docs/.vitepress/dist/user/data-and-safety.html",
        (
            f"The data controller for the public demo is {controller}, acting as an individual. "
            "For privacy questions, contact "
            f'<a href="mailto:{email}" target="_blank" rel="noreferrer">{email}</a>.'
        ),
        Path("docs/.vitepress/dist/user/data-and-safety.html"),
    ) == []
    assert release_check.scan_text(
        "docs/.vitepress/dist/user/data-and-safety.html",
        (
            f"The data controller for this documentation measurement is {controller}, "
            "acting as an individual. For privacy questions, contact "
            f'<a href="mailto:{email}" target="_blank" rel="noreferrer">{email}</a>.'
        ),
        Path("docs/.vitepress/dist/user/data-and-safety.html"),
    ) == []

    expected = {
        "contains private username/domain",
        "contains private first name",
        "contains private personal domain",
    }
    same_page_findings = release_check.scan_text(
        "docs/user/data-and-safety.md",
        f"Unapproved controller reference: {controller} {email}",
        Path("docs/user/data-and-safety.md"),
    )
    assert {finding.split(": ", 1)[1] for finding in same_page_findings} == expected
    emitted_same_page_findings = release_check.scan_text(
        "docs/.vitepress/dist/user/data-and-safety.html",
        (
            "Unapproved contact: "
            f'<a href="mailto:{email}" target="_blank" rel="noreferrer">{email}</a>'
        ),
        Path("docs/.vitepress/dist/user/data-and-safety.html"),
    )
    assert {
        finding.split(": ", 1)[1] for finding in emitted_same_page_findings
    } == expected
    for label, rel in (
        ("docs/unrelated.md", Path("docs/unrelated.md")),
        ("dist/web/assets/unrelated.js", Path("dist/web/assets/unrelated.js")),
        ("dist/web/assets/unrelated.js.map", Path("dist/web/assets/unrelated.js.map")),
    ):
        findings = release_check.scan_text(label, f"{controller} {email}", rel)
        assert {finding.split(": ", 1)[1] for finding in findings} == expected


def test_public_demo_controller_build_assets_reject_archive_path_traversal(tmp_path: Path) -> None:
    controller = "El" + "oi Barti"
    email = "me@" + "el" + "oi" + "barti" + ".com"
    payload = (
        f'Data controller: {controller}, acting as an individual. Privacy questions: "," '
        f'I.jsx("a",{{href:"mailto:{email}",children:"{email}"}})'
    ).encode()
    member = "dist/web/assets/../../private.js"
    zip_path = tmp_path / "dist/controller.zip"
    zip_path.parent.mkdir(parents=True)
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr(member, payload)

    tar_path = tmp_path / "dist/controller.tar.gz"
    with tarfile.open(tar_path, "w:gz") as archive:
        info = tarfile.TarInfo(member)
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))

    assert not release_check._is_public_demo_controller_build_asset(Path(member))
    assert not release_check._is_public_demo_controller_build_asset(
        Path("/dist/web/assets/demo.js")
    )
    for archive_path, findings in (
        (zip_path, release_check.scan_zip_archive(tmp_path, zip_path)),
        (tar_path, release_check.scan_tar_archive(tmp_path, tar_path)),
    ):
        assert (
            f"{archive_path.relative_to(tmp_path)}!{member}: contains private username/domain"
            in findings
        )


def test_public_demo_fixture_allowlist_is_exact_and_keeps_the_pdf_ban() -> None:
    allowed = Path("apps/web/public/demo/profile-resume.pdf")

    assert release_check.scan_name(allowed.as_posix(), allowed) == []
    assert release_check.scan_name("uploads/resume.pdf", Path("uploads/resume.pdf")) == [
        "uploads/resume.pdf: private/runtime file should not be committed"
    ]
    assert release_check.scan_name(
        "apps/web/public/demo/unreviewed.pdf",
        Path("apps/web/public/demo/unreviewed.pdf"),
    ) == ["apps/web/public/demo/unreviewed.pdf: private/runtime file should not be committed"]


def test_demo_fixture_scanner_checks_allowed_pdf_bytes_for_privacy_needles() -> None:
    fixture = Path("apps/web/public/demo/profile-resume.pdf")
    findings = release_check.scan_file_contents(
        fixture.as_posix(),
        fixture,
        b"%PDF-1.4\ncontact@example.local\nsk-synthetic-token\n",
    )

    assert f"{fixture}: demo fixture contains email" in findings
    assert f"{fixture}: demo fixture contains secret" in findings
    assert f"{fixture}: demo PDF fixture does not match its pinned content digest" in findings


def test_demo_fixture_scanner_rejects_general_domains_and_phone_contacts() -> None:
    fixture = Path("apps/web/public/demo/source-preview.html")
    private_domain = "real-employer" + ".tech"
    private_phone = "+34 " + "612 345 678"

    findings = release_check.scan_file_contents(
        fixture.as_posix(),
        fixture,
        f"{private_domain}\n{private_phone}\n2031-01-02T03:04:05.000Z\n120000".encode(),
    )

    assert f"{fixture}: demo fixture contains domain" in findings
    assert f"{fixture}: demo fixture contains phone" in findings
    assert findings.count(f"{fixture}: demo fixture contains phone") == 1


def test_demo_build_source_maps_and_archives_scan_fixture_bytes(tmp_path: Path) -> None:
    source_map = tmp_path / "dist/web/assets/app.js.map"
    _write(source_map, "SyntheticSecret")
    source_map_findings = release_check.scan_demo_build_outputs(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    )

    archive = tmp_path / "dist/web/demo-build.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "demo/profile-resume.pdf",
            b"%PDF-1.4\ncontact@example.local\nsk-synthetic-token\n",
        )
    archive_findings = release_check.scan_zip_archive(tmp_path, archive)

    assert "dist/web/assets/app.js.map: contains synthetic identity" in source_map_findings
    assert "dist/web/demo-build.zip!demo/profile-resume.pdf: demo fixture contains email" in archive_findings
    assert "dist/web/demo-build.zip!demo/profile-resume.pdf: demo fixture contains secret" in archive_findings
    assert "dist/web/demo-build.zip!demo/profile-resume.pdf: demo PDF fixture does not match its pinned content digest" in archive_findings


def test_release_scanner_ignores_non_release_qa_output_archives(tmp_path: Path) -> None:
    trace = tmp_path / "dist/playwright-report/failure/trace.zip"
    storybook_archive = tmp_path / "dist/web-storybook/assets/report.zip"
    for archive in (trace, storybook_archive):
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(b"not a ZIP archive")

    assert release_check.scan_dist_archives(tmp_path) == []
    _write(tmp_path / "dist/web-storybook/assets/app.js", "SyntheticSecret")
    assert release_check.scan_demo_build_outputs(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
    ) == []


def test_release_scanner_rejects_corrupt_distribution_archives(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")
    archive = tmp_path / "dist/jobctrl-2.0.0-darwin-arm64.zip"
    wheel = tmp_path / "workers/automation/dist/jobctrl-2.0.0-py3-none-any.whl"
    archive.parent.mkdir(parents=True)
    wheel.parent.mkdir(parents=True)
    archive.write_bytes(b"not a ZIP archive")
    wheel.write_bytes(b"not a ZIP archive")

    assert release_check.scan_dist_archives(tmp_path) == [
        "dist/jobctrl-2.0.0-darwin-arm64.zip: unreadable ZIP archive",
        "workers/automation/dist/jobctrl-2.0.0-py3-none-any.whl: unreadable ZIP archive",
    ]


def test_release_scanner_keeps_stale_distribution_wheels_in_scope(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")
    wheel = tmp_path / "workers/automation/dist/jobctrl-0.3.0-py3-none-any.whl"
    wheel.parent.mkdir(parents=True)
    with zipfile.ZipFile(wheel, "w") as bundle:
        bundle.writestr(
            "jobctrl-0.3.0.dist-info/METADATA",
            "Name: jobctrl\nVersion: 0.3.0\n",
        )

    assert release_check.scan_dist_archives(tmp_path) == [
        "workers/automation/dist/jobctrl-0.3.0-py3-none-any.whl!"
        "jobctrl-0.3.0.dist-info/METADATA: distribution version '0.3.0' does not match "
        "workers/automation/pyproject.toml '2.0.0'"
    ]


def test_release_scanner_rejects_invalid_utf8_distribution_metadata(tmp_path: Path) -> None:
    _write_version_surfaces(tmp_path, "2.0.0")
    wheel = tmp_path / "workers/automation/dist/jobctrl-2.0.0-py3-none-any.whl"
    sdist = tmp_path / "workers/automation/dist/jobctrl-2.0.0.tar.gz"
    wheel.parent.mkdir(parents=True)
    with zipfile.ZipFile(wheel, "w") as bundle:
        bundle.writestr("jobctrl-2.0.0.dist-info/METADATA", b"\xff")
    with tarfile.open(sdist, "w:gz") as bundle:
        info = tarfile.TarInfo("jobctrl-2.0.0/PKG-INFO")
        info.size = 1
        bundle.addfile(info, io.BytesIO(b"\xff"))

    assert release_check.scan_dist_archives(tmp_path) == [
        "workers/automation/dist/jobctrl-2.0.0-py3-none-any.whl: unreadable ZIP archive",
        "workers/automation/dist/jobctrl-2.0.0.tar.gz: unreadable tar archive",
    ]


def test_source_tree_keeps_scanning_all_utf8_code_while_build_maps_are_scanned_explicitly(
    tmp_path: Path,
) -> None:
    source_ts = Path("apps/web/src/demo-fixture.ts")
    source_js = Path("apps/web/src/demo-fixture.js")
    _write(tmp_path / source_ts, "SyntheticSecret")
    _write(tmp_path / source_js, "SyntheticSecret")
    _write(tmp_path / "dist/web/assets/app.js", "SyntheticSecret")
    _write(tmp_path / "dist/web/assets/app.js.map", "SyntheticSecret")

    result = release_check.scan_tree(
        tmp_path,
        needles=(release_check.ForbiddenNeedle("SyntheticSecret", "synthetic identity"),),
        paths=(source_ts, source_js),
        tracked_paths=(),
    )

    assert "apps/web/src/demo-fixture.ts: contains synthetic identity" in result.findings
    assert "apps/web/src/demo-fixture.js: contains synthetic identity" in result.findings
    assert "dist/web/assets/app.js: contains synthetic identity" in result.findings
    assert "dist/web/assets/app.js.map: contains synthetic identity" in result.findings


def test_minified_build_scan_excludes_only_known_employer_collisions(
    tmp_path: Path,
) -> None:
    employers = ("Tes" + "la", "Well" + "tech")
    private_identifier = "el" + "oi" + "barti"
    private_secret = "sk-" + "release-secret"
    source = Path("apps/web/src/demo-fixture.ts")
    _write(tmp_path / source, employers[1])
    _write(
        tmp_path / "dist/web/assets/private-data.js",
        f'const demo = "{private_identifier} {private_secret}";',
    )
    _write(
        tmp_path / "dist/web/assets/literal-employers.js",
        f'const firstEmployer = "{employers[0]}"; const secondEmployer = "{employers[1]}";',
    )
    _write(tmp_path / "dist/web/assets/collision.js", "create" + "SlatePlugin")
    _write(tmp_path / "dist/web/assets/app.js.map", employers[1])

    result = release_check.scan_tree(
        tmp_path,
        needles=(
            *release_check.FORBIDDEN_TEXT,
            release_check.ForbiddenNeedle(private_secret, "private release secret"),
        ),
        paths=(source,),
        tracked_paths=(),
    )

    assert "apps/web/src/demo-fixture.ts: contains private employer evidence" in result.findings
    assert "dist/web/assets/private-data.js: contains private username/domain" in result.findings
    assert "dist/web/assets/private-data.js: contains private release secret" in result.findings
    assert result.findings.count(
        "dist/web/assets/literal-employers.js: contains private employer evidence"
    ) == 2
    assert "dist/web/assets/app.js.map: contains private employer evidence" in result.findings
    assert "dist/web/assets/collision.js: contains private employer evidence" not in result.findings


def test_release_check_catches_synthetic_violation_per_class(tmp_path: Path) -> None:
    blocked_distribution = "job" + "hunter"
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


def test_old_product_name_gate_blocks_shipping_surfaces(tmp_path: Path) -> None:
    old_names = ("Job" + "Hunter", "Job" + "Ctl")
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


def test_cli_strict_scan_ignores_corrupt_playwright_report_archives(
    tmp_path: Path,
    monkeypatch,
) -> None:
    trace = tmp_path / "dist/playwright-report/failure/trace.zip"
    trace.parent.mkdir(parents=True)
    trace.write_bytes(b"not a ZIP archive")
    _track_all(tmp_path)

    monkeypatch.setattr(release_check, "ROOT", tmp_path)

    assert release_check.main(("--strict-prompt",)) == 0


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
