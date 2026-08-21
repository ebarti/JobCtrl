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


def _write_homebrew_p4_contract(tmp_path: Path, workflow: str | None = None) -> None:
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_TEMPLATE_PATH,
        'class Jobctrl < Formula\n  url "{{ARTIFACT_URL}}"\n  version_scheme 1\nend\n',
    )
    _write(tmp_path / release_check.HOMEBREW_FORMULA_GENERATOR_PATH, "// generator\n")
    _write(tmp_path / release_check.HOMEBREW_RELEASE_TRUST_PATH, '{"schemaVersion": 1, "keys": {}}\n')
    if workflow is not None:
        _write(tmp_path / release_check.HOMEBREW_SYNC_WORKFLOW_PATH, workflow)


def test_homebrew_template_requires_p6_gated_tap_sync_workflow(tmp_path: Path) -> None:
    _write_homebrew_p4_contract(tmp_path)

    assert release_check._homebrew_sync_findings(tmp_path) == [
        ".github/workflows/sync-homebrew-tap.yml: canonical Homebrew template has no P6-gated tap synchronization workflow"
    ]


def test_homebrew_tap_sync_requires_reusable_signed_render_gate(tmp_path: Path) -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    _write_homebrew_p4_contract(
        tmp_path,
        workflow,
    )

    assert release_check._homebrew_sync_findings(tmp_path) == []


def test_homebrew_template_requires_version_scheme_after_public_reset(tmp_path: Path) -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    _write_homebrew_p4_contract(tmp_path, workflow)
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_TEMPLATE_PATH,
        'class Jobctrl < Formula\n  url "{{ARTIFACT_URL}}"\nend\n',
    )

    assert release_check._homebrew_sync_findings(tmp_path) == [
        "packaging/homebrew/Formula/jobctrl.rb.tmpl: must preserve Homebrew "
        "version_scheme 1 after the public SemVer reset"
    ]


def test_homebrew_tap_key_is_resolved_only_behind_publication_environment() -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    interface = workflow.partition("\njobs:")[0]
    verify = release_check._workflow_job_body(workflow, "verify")

    assert "HOMEBREW_TAP_DEPLOY_KEY" not in interface
    assert verify is not None and "HOMEBREW_TAP_DEPLOY_KEY" not in verify
    assert release_check._workflow_job_body(workflow, "publish") is None
    release_workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    caller = release_check._workflow_job_body(release_workflow, "sync-homebrew")
    publish = release_check._workflow_job_body(release_workflow, "publish-homebrew")
    assert caller is not None
    assert "HOMEBREW_TAP_DEPLOY_KEY" not in caller
    assert "secrets:" not in caller
    assert publish is not None
    assert "environment: release-publication" in publish
    assert "secrets.HOMEBREW_TAP_DEPLOY_KEY" in publish


def test_homebrew_tap_key_cannot_be_a_workflow_call_secret(tmp_path: Path) -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    workflow = workflow.replace(
        "\npermissions:\n",
        "\n    secrets:\n"
        "      HOMEBREW_TAP_DEPLOY_KEY:\n"
        "        required: true\n"
        "\npermissions:\n",
        1,
    )
    _write_homebrew_p4_contract(tmp_path, workflow)

    findings = release_check._homebrew_sync_findings(tmp_path)
    assert any("must be an environment secret" in finding for finding in findings)


def test_homebrew_template_rejects_toolchain_or_head_spec(tmp_path: Path) -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    _write_homebrew_p4_contract(
        tmp_path,
        workflow,
    )
    _write(
        tmp_path / release_check.HOMEBREW_FORMULA_TEMPLATE_PATH,
        'class Jobctrl < Formula\n  version_scheme 1\n  depends_on "corepack"\n'
        '  head "https://example.test/jobctrl.git"\nend\n',
    )

    assert release_check._homebrew_sync_findings(tmp_path) == [
        "packaging/homebrew/Formula/jobctrl.rb.tmpl: must not declare Homebrew dependencies or a HEAD source path"
    ]


def test_homebrew_tap_publish_cannot_mix_verification_with_deploy_key(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.HOMEBREW_SYNC_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    workflow = workflow.replace(
        "    permissions:\n      actions: read\n      contents: read\n",
        "    env:\n      LEAKED_TAP_KEY: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}\n"
        "    permissions:\n      actions: read\n      contents: read\n",
        1,
    )
    _write_homebrew_p4_contract(
        tmp_path,
        workflow,
    )

    findings = release_check._homebrew_sync_findings(tmp_path)
    assert any(
        "verify job must not receive tap publication credentials" in finding
        for finding in findings
    )
    assert any("must remain credential-free" in finding for finding in findings)


def test_pypi_workflow_keeps_build_verification_outside_oidc_publication() -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    resolve = release_check._workflow_job_body(workflow, "pypi-resolve")
    build = release_check._workflow_job_body(workflow, "pypi-build")
    publish = release_check._workflow_job_body(workflow, "publish-pypi")

    assert resolve is not None
    assert build is not None
    assert publish is not None
    assert not (release_check.ROOT / release_check.PUBLISH_WORKFLOW_PATH).exists()

    assert "needs: [resolve, publish-github-release, pypi-recovery-preflight]" in resolve
    assert "persist-credentials: false" in resolve
    assert "distribution-release.finalizer.bundle.mjs.sha256" in resolve
    assert "distribution-release-authority-bundles.NOTICE.txt" in resolve
    assert "sha256sum -c distribution-release.finalizer.bundle.mjs.sha256" in resolve
    assert "node scripts/distribution-release.finalizer.bundle.mjs verify-pypi-gate" in resolve
    assert "JOBCTRL_RELEASE_PUBLIC_KEY: ${{ needs.resolve.outputs.release_public_key }}" in resolve
    assert "JOBCTRL_RELEASE_KEY_ID: ${{ needs.resolve.outputs.release_key_id }}" in resolve
    assert 'filter="data"' in resolve
    assert "actions/setup-python@" not in resolve
    assert "astral-sh/setup-uv@" not in resolve
    assert "corepack pnpm" not in resolve
    assert "uv --project" not in resolve

    assert "needs: pypi-resolve" in build
    assert "if: ${{ !cancelled() && needs.pypi-resolve.result == 'success' }}" in build
    assert "actions/setup-python@" in build
    assert "astral-sh/setup-uv@" in build
    assert "actions/setup-node@" not in build
    assert "corepack pnpm" not in build
    assert "verify-pypi-gate" not in build
    assert "JOBCTRL_RELEASE_PUBLIC_KEY" not in build
    assert "JOBCTRL_RELEASE_KEY_ID" not in build
    assert "PYPI_RECOVERY_ONLY: ${{ inputs.pypi_recovery_only || false }}" in build
    assert '[[ "$PYPI_RECOVERY_ONLY" = true && "$RELEASE_TAG" = v0.1.0 ]]' in build
    assert 'grep -Fqx \'exclude-newer = "7 days"\'' in build
    assert 'grep -Fqx \'exclude-newer-span = "P8D"\'' in build
    assert 'UV_EXCLUDE_NEWER="8 days" uv --project workers/automation sync' in build
    sync = "uv --project workers/automation sync --python 3.12.13 --locked --no-default-groups --only-group release-build --no-install-project"
    build_command = "uv --project workers/automation run --python 3.12.13 --no-sync python -m build --no-isolation workers/automation"
    assert sync in build
    assert build_command in build
    assert build.index(sync) < build.index(build_command) < build.index(
        "python3 scripts/release_check.py --strict-prompt"
    ) < build.index("shasum -a 256 packages/* > SHA256SUMS") < build.index(
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    )
    assert "jobctrl-pypi-distributions-" in build
    assert "pypi-build-a" not in workflow
    assert "pypi-build-b" not in workflow
    assert "pypi-compare" not in workflow

    assert "environment: pypi" in publish
    assert "needs: [pypi-resolve, pypi-build]" in publish
    assert (
        "if: ${{ !cancelled() && needs.pypi-resolve.result == 'success' && "
        "needs.pypi-build.result == 'success' }}" in publish
    )
    assert "id-token: write" in publish
    assert "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" in publish
    assert "actions/checkout@" not in publish
    assert "actions/setup-python@" not in publish
    assert "actions/setup-node@" not in publish
    assert "astral-sh/setup-uv@" not in publish
    assert "uv --project" not in publish
    assert "python -m build" not in publish
    assert "JOBCTRL_RELEASE_PUBLIC_KEY" not in publish
    assert "JOBCTRL_RELEASE_KEY_ID" not in publish
    assert "EXPECTED_SOURCE_COMMIT: ${{ needs.pypi-resolve.outputs.source_commit }}" in publish
    assert 'gh api "repos/$GITHUB_REPOSITORY/commits/$RELEASE_TAG"' in publish
    assert 'gh api "repos/$GITHUB_REPOSITORY/compare/$tag_sha...main"' in publish
    assert 'test "$EXPECTED_SOURCE_COMMIT" = "$tag_sha"' in publish
    assert '[[ "$main_relation" = ahead || "$main_relation" = identical ]]' in publish
    assert "packages-dir: ${{ runner.temp }}/jobctrl-pypi-dists/packages" in publish
    assert "SHA256SUMS" in publish
    assert "jobctrl-pypi-distributions-" in publish
    assert "uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33" in publish
    assert "uses: pypa/gh-action-pypi-publish@a892a5a61159132606e93a2fa6f4358831b04d26" not in publish


def test_pypi_no_isolation_backend_is_exactly_pinned_and_locked() -> None:
    pyproject = (release_check.ROOT / release_check.PYTHON_PROJECT_PATH).read_text(
        encoding="utf-8"
    )
    lock = (release_check.ROOT / release_check.PYTHON_LOCK_PATH).read_text(
        encoding="utf-8"
    )

    assert 'requires = ["hatchling==1.29.0"]' in pyproject
    assert '"hatchling==1.29.0"' in pyproject
    assert 'release-build = ["build==1.4.3", "hatchling==1.29.0"]' in pyproject
    assert 'exclude-newer = "7 days"' not in pyproject
    assert "exclude-newer-span" not in lock
    assert 'name = "build"\nversion = "1.4.3"' in lock
    assert 'name = "hatchling"\nversion = "1.29.0"' in lock
    assert release_check._pypi_build_backend_findings(release_check.ROOT) == []


def test_pypi_lock_rejects_a_time_relative_global_cutoff(tmp_path: Path) -> None:
    pyproject = (release_check.ROOT / release_check.PYTHON_PROJECT_PATH).read_text(
        encoding="utf-8"
    ).replace('[tool.uv]\n', '[tool.uv]\nexclude-newer = "7 days"\n', 1)
    lock = (release_check.ROOT / release_check.PYTHON_LOCK_PATH).read_text(
        encoding="utf-8"
    ).replace(
        '[options.exclude-newer-package]\n',
        '[options]\nexclude-newer-span = "P7D"\n\n[options.exclude-newer-package]\n',
        1,
    )
    _write(tmp_path / release_check.PYTHON_PROJECT_PATH, pyproject)
    _write(tmp_path / release_check.PYTHON_LOCK_PATH, lock)

    findings = release_check._pypi_build_backend_findings(tmp_path)

    assert any("rolling dependency cooldown" in item for item in findings)
    assert any("time-relative global dependency cutoff" in item for item in findings)


def test_pypi_workflow_static_contract_is_clean() -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")

    assert release_check._pypi_release_workflow_findings(workflow) == []


def test_pypi_signed_release_gate_cannot_move_behind_builder_dependencies() -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    workflow = workflow.replace(
        "          node scripts/distribution-release.finalizer.bundle.mjs verify-pypi-gate \\\n",
        "          echo skipped-signed-release-gate \\\n",
        1,
    ).replace(
        "      - name: Build exact fixed-epoch PyPI distributions without isolation\n",
        "      - name: Run the signed-release gate too late\n"
        "        run: node scripts/distribution-release.finalizer.bundle.mjs verify-pypi-gate\n\n"
        "      - name: Build exact fixed-epoch PyPI distributions without isolation\n",
        1,
    )

    findings = release_check._pypi_release_workflow_findings(workflow)

    assert any("cleanly verify the immutable signed release" in item for item in findings)
    assert any("must only build after the clean shared gate" in item for item in findings)


def test_distribution_privileged_jobs_reject_dependency_or_repo_execution(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    workflow = workflow.replace(
        "      - name: Download the prepared candidate\n",
        "      - name: Install forbidden signing dependencies\n"
        "        run: |\n"
        "          corepack pnpm install --frozen-lockfile\n"
        "          node scripts/distribution-release.mjs inspect fixture fixture\n\n"
        "      - name: Download the prepared candidate\n",
        1,
    ).replace(
        "      - name: Download the immutable signed candidate\n",
        "      - name: Execute forbidden publication code\n"
        "        run: node scripts/distribution-release.mjs inspect fixture fixture\n\n"
        "      - name: Download the immutable signed candidate\n",
        1,
    ).replace(
        "  smoke-and-verify:\n",
        "  smoke-and-verify:\n"
        "    environment: release-publication\n",
        1,
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, workflow)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)

    assert any(
        "sign job must not install packages or dependency tooling" in item
        for item in findings
    )
    assert any(
        "sign job must execute only the sealed bundled finalizer" in item
        for item in findings
    )
    assert any(
        "publication job publish-immutable executes repository or dependency code"
        in item
        for item in findings
    )
    assert any(
        "credential-free job smoke-and-verify receives signing or publication authority"
        in item
        for item in findings
    )


def test_distribution_checkout_free_jobs_bind_github_cli_repository(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    workflow = workflow.replace(
        "env:\n"
        "  # Checkout-free publication jobs must never rely on gh inferring a repository.\n"
        "  GH_REPO: ${{ github.repository }}\n\n",
        "",
        1,
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, workflow)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)

    assert any(
        "does not bind checkout-free GitHub CLI release operations" in item
        for item in findings
    )


def test_distribution_preflights_checkout_free_release_access_before_signing(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    workflow = workflow.replace(
        "          test \"$(gh repo view \"$GH_REPO\" --json nameWithOwner --jq '.nameWithOwner')\" = \"$GITHUB_REPOSITORY\"\n",
        "",
        1,
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, workflow)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)

    assert any(
        "publication preflight does not prove checkout-free GitHub release access"
        in item
        for item in findings
    )


def test_distribution_signing_pins_darwin_arm64_python(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    sign = release_check._workflow_job_body(workflow, "sign")

    assert sign is not None
    assert 'python-version: "3.12.10"' in sign

    unsupported = workflow.replace(
        '          python-version: "3.12.10"\n',
        '          python-version: "3.12.13"\n',
        1,
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, unsupported)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)
    assert any(
        "sign safe extraction must pin Python 3.12.10" in item
        for item in findings
    )


def test_distribution_requires_native_conditional_r2_publication(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    assert "JOBCTRL_RELEASE_UPLOAD_BASE_URL" not in workflow
    assert "secrets.JOBCTRL_R2_ACCESS_KEY_ID" in workflow
    assert "secrets.JOBCTRL_R2_SECRET_ACCESS_KEY" in workflow
    assert "vars.JOBCTRL_R2_ACCOUNT_ID" in workflow
    assert "vars.JOBCTRL_R2_BUCKET" in workflow

    insecure = workflow.replace("--if-none-match '*'", "").replace(
        '--if-match "$etag"', ""
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, insecure)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)
    assert any("protect immutable R2 object creation" in item for item in findings)
    assert any("compare-and-swap an existing R2 channel pointer" in item for item in findings)

    comment_spoofed = workflow.replace("--if-none-match '*'", "").replace(
        '--if-match "$etag"', ""
    )
    comment_spoofed = comment_spoofed.replace(
        "  publish-immutable:\n",
        "  publish-immutable:\n    # aws s3api put-object --if-none-match '*'\n",
        1,
    ).replace(
        "  promote-channel-pointer:\n",
        "  promote-channel-pointer:\n"
        "    # aws s3api put-object --if-match \"$etag\"\n"
        "    # aws s3api put-object --if-none-match '*'\n",
        1,
    )
    spoof_root = tmp_path / "comment-spoof"
    _write(spoof_root / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, comment_spoofed)
    _write(spoof_root / release_check.SIGNING_POLICY_PATH, policy)

    spoof_findings = release_check._release_distribution_findings(spoof_root)
    assert any("protect immutable R2 object creation" in item for item in spoof_findings)
    assert any(
        "compare-and-swap an existing R2 channel pointer" in item
        for item in spoof_findings
    )


def test_distribution_dispatch_must_execute_from_the_audited_release_tag(
    tmp_path: Path,
) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    workflow = workflow.replace(
        '          test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"\n', "", 1
    ).replace('          test "$GITHUB_SHA" = "$head_sha"\n', "", 1)
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, workflow)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)
    assert any("workflow definition ref" in item for item in findings)
    assert any("workflow definition SHA" in item for item in findings)
    assert any("executing workflow comes from the audited release tag" in item for item in findings)


def test_homebrew_sync_cannot_run_before_channel_pointer_cas(tmp_path: Path) -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    policy = (release_check.ROOT / release_check.SIGNING_POLICY_PATH).read_text(
        encoding="utf-8"
    )
    homebrew = release_check._workflow_job_body(workflow, "sync-homebrew")
    promote = release_check._workflow_job_body(workflow, "promote-channel-pointer")

    assert "group: release-distribution-${{ inputs.channel || 'stable' }}-darwin-arm64" in workflow
    assert homebrew is not None
    assert "needs: [resolve, sign, package-signed-candidate, smoke-and-verify, promote-channel-pointer]" in homebrew
    assert promote is not None
    assert "needs: [resolve, sign, package-signed-candidate, smoke-and-verify]" in promote
    assert "sync-homebrew" not in promote.partition("\n    steps:")[0]

    stale_order = workflow.replace(
        "group: release-distribution-${{ inputs.channel || 'stable' }}-darwin-arm64",
        "group: release-distribution-${{ inputs.release_tag }}",
        1,
    ).replace(
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify, promote-channel-pointer]",
        "__HOMEBREW_NEEDS__",
        1,
    ).replace(
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify]",
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify, sync-homebrew]",
        1,
    ).replace(
        "__HOMEBREW_NEEDS__",
        "needs: [resolve, sign, package-signed-candidate, smoke-and-verify]",
        1,
    )
    _write(tmp_path / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH, stale_order)
    _write(tmp_path / release_check.SIGNING_POLICY_PATH, policy)

    findings = release_check._release_distribution_findings(tmp_path)
    assert any("serialize release mutation" in item for item in findings)
    assert any("channel promotion must bind" in item for item in findings)
    assert any("Homebrew publication must bind" in item for item in findings)


def test_distribution_audit_tar_is_derived_outside_member_checksum_closure() -> None:
    workflow = (
        release_check.ROOT / release_check.RELEASE_DISTRIBUTION_WORKFLOW_PATH
    ).read_text(encoding="utf-8")
    package = release_check._workflow_job_body(workflow, "package-signed-candidate")

    assert package is not None
    assert "The deterministic transport container is intentionally outside" in package
    assert 'jobctrl-release-audit.tar >>' not in package
    assert package.index("shasum -a 256 -c SHA256SUMS") < package.index(
        'output = root / "jobctrl-release-audit.tar"'
    )


def test_release_privacy_workflow_enforces_strict_prompt_gate() -> None:
    workflow = (
        release_check.ROOT / ".github/workflows/release-check.yml"
    ).read_text(encoding="utf-8")

    sync = "uv --project workers/automation sync --locked --only-group release-check"
    scan = (
        "uv --project workers/automation run --locked --only-group release-check "
        "python scripts/release_check.py --strict-prompt"
    )
    self_test = (
        "uv --project workers/automation run --locked --only-group release-check "
        "pytest -q -c /dev/null -p no:cacheprovider --noconftest "
        "workers/automation/tests/test_release_check.py"
    )

    assert sync in workflow
    assert scan in workflow
    assert self_test in workflow
    assert workflow.index(sync) < workflow.index(scan) < workflow.index(self_test)
    assert "pip install" not in workflow


def test_release_privacy_workflow_scans_every_pull_request() -> None:
    """The privacy gate's ``pull_request`` trigger must stay exactly bare.

    A ``branches: ["main"]`` filter skipped the scan on every stacked pull
    request, because a stacked layer targets its parent branch rather than
    main. A ``paths`` filter would be self-defeating: any file in the
    repository can carry owner PII or a secret, so every excluded path is a
    path a leak can land in unscanned. Requiring the block to be exactly bare
    also rejects the ``branches-ignore``/``paths-ignore`` spellings and
    ``types`` narrowing such as ``types: [opened]``, which would leave every
    later push to an open pull request unscanned. A bare ``pull_request:`` key
    parses to YAML null, the same invariant ``scripts/stacked-ci-workflows.test.mjs``
    asserts as ``on.pull_request === null``; string equality is used here
    because this suite also runs in the gate workflow itself, whose
    environment installs only pytest and has no YAML parser.
    """
    workflow = (
        release_check.ROOT / ".github/workflows/release-check.yml"
    ).read_text(encoding="utf-8")
    on_block = workflow[workflow.index("\non:") : workflow.index("\njobs:")]
    pull_request = on_block[
        on_block.index("  pull_request:") : on_block.index("  workflow_dispatch:")
    ]

    assert pull_request == "  pull_request:\n", (
        "the pull_request trigger must stay exactly bare (YAML null): any "
        "branches/paths/types filter or -ignore variant narrows which pull "
        "requests or files the privacy gate scans"
    )


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
