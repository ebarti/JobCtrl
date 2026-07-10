"""Hash-pinned, traversal-safe provider-pack installation tests."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import stat
import sys
import zipfile
from pathlib import Path

import pytest

from jobctrl import runtime
from jobctrl import provider_packs as provider_packs_module
from jobctrl.provider_packs import (
    ProviderPackError,
    ProviderWheelSpec,
    expected_provider_tree_stats,
    install_provider_pack,
    load_provider_pack_spec,
    parse_provider_pack_lock,
    parse_provider_pack_spec,
    provider_tree_stats,
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_wheel(path: Path, members: dict[str, bytes], *, symlink: str | None = None) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
        if symlink is not None:
            info = zipfile.ZipInfo("demo/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, symlink)


def _payload(wheels: list[Path], *, version: str = "1.2.3") -> dict[str, object]:
    wheel_records = []
    for wheel in wheels:
        distribution, wheel_version, *_rest = wheel.name.split("-")
        package = re.sub(r"[_.]+", "-", distribution.lower())
        wheel_records.append(
            {
                "package": package,
                "version": wheel_version,
                "url": f"https://files.pythonhosted.org/packages/{wheel.name}",
                "sha256": _sha256(wheel),
                "sizeBytes": wheel.stat().st_size,
            }
        )
    wheel_records.sort(key=lambda record: record["package"].encode("utf-8"))
    return {
        "id": "claude-agent-sdk",
        "version": version,
        "owner": "Anthropic",
        "source": "https://pypi.org/project/claude-agent-sdk/",
        "license": "MIT with provider commercial terms",
        "redistribution": "official-download",
        "isolation": "independent-site-packages",
        "exactPackages": [record["package"] for record in wheel_records],
        "wheels": wheel_records,
    }


def _lock_payload(pack: dict[str, object]) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "platform": "darwin-arm64",
        "python": "cpython-3.12",
        "coreSelector": "test core selector",
        "packs": [pack],
    }


def _copy_fetcher(source_dir: Path):
    def fetch(wheel: ProviderWheelSpec, destination: Path) -> None:
        shutil.copyfile(source_dir / wheel.filename, destination)

    return fetch


def _enable_bundled_pack(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *packs: dict[str, object],
) -> None:
    payload = tmp_path / "payload"
    lock_path = payload / "release/provider-packs.lock.json"
    lock_path.parent.mkdir(parents=True)
    lock = _lock_payload(packs[0])
    lock["packs"] = list(packs)
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    monkeypatch.setenv(runtime.RUNTIME_MODE_ENV, "bundled")
    monkeypatch.setenv(runtime.PAYLOAD_DIR_ENV, str(payload))


def test_spec_rejects_extra_fields_insecure_urls_and_version_traversal(tmp_path: Path) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b""})
    payload = _payload([wheel])

    with pytest.raises(ProviderPackError, match="fields mismatch"):
        parse_provider_pack_spec({**payload, "untrusted": True})
    insecure = json.loads(json.dumps(payload))
    insecure["wheels"][0]["url"] = f"http://example.test/{wheel.name}"
    with pytest.raises(ProviderPackError, match="HTTPS"):
        parse_provider_pack_spec(insecure)
    alternate_host = json.loads(json.dumps(payload))
    alternate_host["wheels"][0]["url"] = f"https://example.test/{wheel.name}"
    with pytest.raises(ProviderPackError, match="locked PyPI wheel host"):
        parse_provider_pack_spec(alternate_host)
    with pytest.raises(ProviderPackError, match="version"):
        parse_provider_pack_spec({**payload, "version": "../escape"})


def test_signed_lock_requires_exact_full_wheel_closure(tmp_path: Path) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b""})
    pack = _payload([wheel])

    selected = parse_provider_pack_lock(_lock_payload(pack), pack_id="claude-agent-sdk")
    assert selected.exact_packages == ("demo",)

    missing = json.loads(json.dumps(pack))
    missing["exactPackages"] = []
    with pytest.raises(ProviderPackError, match="exactPackages"):
        parse_provider_pack_lock(_lock_payload(missing), pack_id="claude-agent-sdk")

    drifted = json.loads(json.dumps(pack))
    drifted["exactPackages"] = ["other"]
    with pytest.raises(ProviderPackError, match="exactly match"):
        parse_provider_pack_lock(_lock_payload(drifted), pack_id="claude-agent-sdk")


def test_checked_in_provider_lock_matches_installer_contract() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    lock_path = repo_root / "packaging/distribution/provider-packs.lock.json"
    expected = {
        "claude-agent-sdk": "claude-agent-sdk",
        "codex-provider-runtime": "openai-codex-cli-bin",
        "antigravity-provider-runtime": "google-antigravity",
    }

    for pack_id, required_package in expected.items():
        spec = load_provider_pack_spec(lock_path, pack_id=pack_id)
        assert required_package in spec.exact_packages
        assert tuple(wheel.package for wheel in spec.wheels) == spec.exact_packages


def test_installs_full_multi_wheel_closure_and_activates_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    sdk = wheels / "demo_sdk-1.0-py3-none-any.whl"
    cli = wheels / "demo_cli-1.0-py3-none-any.whl"
    _write_wheel(
        sdk,
        {
            "demo_sdk/__init__.py": b"VERSION = '1.0'\n",
            "demo_sdk-1.0.dist-info/METADATA": b"Name: demo-sdk\nVersion: 1.0\n",
        },
    )
    _write_wheel(
        cli,
        {
            "demo_cli/__init__.py": b"",
            "demo_cli-1.0.data/purelib/demo_cli/runtime.py": b"READY = True\n",
        },
    )
    spec = parse_provider_pack_spec(_payload([sdk, cli]))
    state = tmp_path / "state"

    installed = install_provider_pack(spec, app_dir=state, fetcher=_copy_fetcher(wheels))

    assert (installed / "site-packages/demo_sdk/__init__.py").is_file()
    assert (installed / "site-packages/demo_cli/runtime.py").is_file()
    assert {path.name for path in (installed / "wheels").iterdir()} == {
        sdk.name,
        cli.name,
    }
    metadata = json.loads((installed / "pack.json").read_text(encoding="utf-8"))
    assert [wheel["package"] for wheel in metadata["wheels"]] == ["demo-cli", "demo-sdk"]
    assert len(metadata["treeSha256"]) == 64
    active = json.loads(
        (state / "provider-packs/claude-agent-sdk/active.json").read_text(encoding="utf-8")
    )
    assert active["treeSha256"] == metadata["treeSha256"]

    _enable_bundled_pack(monkeypatch, tmp_path, _payload([sdk, cli]))
    monkeypatch.setattr(sys, "path", list(sys.path))
    site_packages = runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)
    assert site_packages == installed / "site-packages"
    assert str(site_packages) == sys.path[-1]


def test_locked_wheel_tree_stats_are_exact_and_reproducible(
    tmp_path: Path,
) -> None:
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    first = wheels / "first-1.0-py3-none-any.whl"
    second = wheels / "second-1.0-py3-none-any.whl"
    _write_wheel(
        first,
        {
            "first/__init__.py": b"first\n",
            "first-1.0.dist-info/METADATA": b"Name: first\nVersion: 1.0\n",
        },
    )
    _write_wheel(
        second,
        {
            "second/__init__.py": b"second\n",
            "second-1.0.data/purelib/second/runtime.py": b"runtime\n",
        },
    )
    spec = parse_provider_pack_spec(_payload([first, second]))
    installed = install_provider_pack(spec, app_dir=tmp_path / "state", fetcher=_copy_fetcher(wheels))

    actual = provider_tree_stats(installed / "site-packages")
    expected = expected_provider_tree_stats(spec, installed / "wheels")

    assert actual == expected
    assert actual.file_count == 4
    assert actual.installed_bytes == sum(
        path.stat().st_size
        for path in (installed / "site-packages").rglob("*")
        if path.is_file()
    )
    assert len(actual.tree_sha256) == 64


def test_activation_rejects_forged_mutable_metadata_and_tree(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b"original\n"})
    spec = parse_provider_pack_spec(_payload([wheel]))
    state = tmp_path / "state"
    installed = install_provider_pack(spec, app_dir=state, fetcher=_copy_fetcher(tmp_path))
    (installed / "site-packages/demo/__init__.py").write_text("tampered\n", encoding="utf-8")
    forged_digest = provider_packs_module.provider_tree_sha256(installed / "site-packages")
    metadata_path = installed / "pack.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["treeSha256"] = forged_digest
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    active_path = state / "provider-packs/claude-agent-sdk/active.json"
    active = json.loads(active_path.read_text(encoding="utf-8"))
    active["treeSha256"] = forged_digest
    active_path.write_text(json.dumps(active), encoding="utf-8")
    _enable_bundled_pack(monkeypatch, tmp_path, _payload([wheel]))

    with pytest.raises(runtime.RuntimeConfigurationError, match="signed payload lock"):
        runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)


def test_activation_rejects_retained_wheel_mutation_against_signed_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b"original\n"})
    pack = _payload([wheel])
    state = tmp_path / "state"
    installed = install_provider_pack(
        parse_provider_pack_spec(pack),
        app_dir=state,
        fetcher=_copy_fetcher(tmp_path),
    )
    retained = installed / "wheels" / wheel.name
    retained.write_bytes(retained.read_bytes() + b"tampered")
    _enable_bundled_pack(monkeypatch, tmp_path, pack)

    with pytest.raises(runtime.RuntimeConfigurationError, match="signed retained wheels"):
        runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)


def test_activation_rejects_distribution_overlap_with_core(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b"provider\n"})
    pack = _payload([wheel])
    spec = parse_provider_pack_spec(pack)
    state = tmp_path / "state"
    install_provider_pack(spec, app_dir=state, fetcher=_copy_fetcher(tmp_path))
    _enable_bundled_pack(monkeypatch, tmp_path, pack)

    core = tmp_path / "core"
    metadata = core / "demo-9.0.dist-info/METADATA"
    metadata.parent.mkdir(parents=True)
    metadata.write_text("Name: demo\nVersion: 9.0\n", encoding="utf-8")
    core_paths = [entry for entry in sys.path if "site-packages" not in entry]
    monkeypatch.setattr(sys, "path", [str(core), *core_paths])

    with pytest.raises(runtime.RuntimeConfigurationError, match="overlaps core distributions: demo"):
        runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)


def test_activation_allows_only_signed_identical_overlap_between_provider_packs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b"shared\n"})
    claude_pack = _payload([wheel])
    antigravity_pack = {
        **_payload([wheel]),
        "id": "antigravity-provider-runtime",
        "owner": "Google",
        "source": "https://pypi.org/project/google-antigravity/",
    }
    state = tmp_path / "state"
    claude = install_provider_pack(
        parse_provider_pack_spec(claude_pack),
        app_dir=state,
        fetcher=_copy_fetcher(tmp_path),
    )
    antigravity = install_provider_pack(
        parse_provider_pack_spec(antigravity_pack),
        app_dir=state,
        fetcher=_copy_fetcher(tmp_path),
    )
    _enable_bundled_pack(monkeypatch, tmp_path, claude_pack, antigravity_pack)
    monkeypatch.setattr(
        sys,
        "path",
        [entry for entry in sys.path if "site-packages" not in entry],
    )

    runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)
    runtime.activate_provider_pack("antigravity-provider-runtime", app_dir=state)

    assert sys.path[-2:] == [
        str(claude / "site-packages"),
        str(antigravity / "site-packages"),
    ]

    # The earlier pack supplies the shared module. Revalidating a later pack
    # must also revalidate that already-active dependency source before reuse.
    (claude / "site-packages/demo/__init__.py").write_text(
        "tampered-after-activation\n",
        encoding="utf-8",
    )
    with pytest.raises(runtime.RuntimeConfigurationError, match="not authorized"):
        runtime.activate_provider_pack("antigravity-provider-runtime", app_dir=state)


def test_install_rejects_state_symlink_escape(tmp_path: Path) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b""})
    spec = parse_provider_pack_spec(_payload([wheel]))
    state = tmp_path / "state"
    state.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (state / "provider-packs").symlink_to(outside, target_is_directory=True)

    with pytest.raises(runtime.RuntimeConfigurationError, match="inside the JobCtrl state"):
        install_provider_pack(spec, app_dir=state, fetcher=_copy_fetcher(tmp_path))

    assert not list(outside.iterdir())


def test_activation_rejects_symlinked_pack_parent_before_reading_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    packs = state / "provider-packs"
    packs.mkdir(parents=True)
    outside = tmp_path / "outside-pack"
    outside.mkdir()
    (packs / "claude-agent-sdk").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv(runtime.RUNTIME_MODE_ENV, "bundled")

    with pytest.raises(runtime.RuntimeConfigurationError, match="parent cannot be a symlink"):
        runtime.activate_provider_pack("claude-agent-sdk", app_dir=state)


@pytest.mark.parametrize(
    "redirect_url",
    [
        "https://user:password@files.pythonhosted.org/packages/demo.whl",
        "https://files.pythonhosted.org/packages/demo.whl#credential-fragment",
        "https://example.test/packages/demo.whl",
    ],
)
def test_download_rejects_authenticated_or_fragment_redirects(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    redirect_url: str,
) -> None:
    class Response:
        headers: dict[str, str] = {}

        def __enter__(self):
            return self

        def __exit__(self, *_exc: object) -> None:
            return None

        def geturl(self) -> str:
            return redirect_url

        def read(self, _size: int) -> bytes:
            return b""

    monkeypatch.setattr(provider_packs_module.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    wheel = ProviderWheelSpec(
        package="demo",
        version="1.0",
        filename="demo-1.0-py3-none-any.whl",
        url="https://files.pythonhosted.org/packages/demo-1.0-py3-none-any.whl",
        sha256="0" * 64,
        size_bytes=1,
    )

    with pytest.raises(ProviderPackError, match="redirected"):
        provider_packs_module._download_wheel(wheel, tmp_path / wheel.filename)


def test_internal_install_command_rejects_external_lock_selection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from typer.testing import CliRunner

    from jobctrl.cli import app

    payload = tmp_path / "payload"
    (payload / "release").mkdir(parents=True)
    external_lock = tmp_path / "attacker-selected-lock.json"
    checked_in = Path(__file__).resolve().parents[3] / "packaging/distribution/provider-packs.lock.json"
    external_lock.write_bytes(checked_in.read_bytes())
    monkeypatch.setenv(runtime.RUNTIME_MODE_ENV, "bundled")
    monkeypatch.setenv(runtime.PAYLOAD_DIR_ENV, str(payload))

    result = CliRunner().invoke(
        app,
        [
            "provider-pack-install",
            "--pack",
            "claude-agent-sdk",
            "--lock",
            str(external_lock),
        ],
    )

    assert result.exit_code == 2
    assert "No such option" in result.output


def test_hash_mismatch_leaves_no_pack_or_activation(tmp_path: Path) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, {"demo/__init__.py": b""})
    payload = _payload([wheel])
    payload["wheels"][0]["sha256"] = "0" * 64
    spec = parse_provider_pack_spec(payload)
    state = tmp_path / "state"

    with pytest.raises(ProviderPackError, match="SHA-256 mismatch"):
        install_provider_pack(spec, app_dir=state, fetcher=_copy_fetcher(tmp_path))

    pack_parent = state / "provider-packs/claude-agent-sdk"
    assert not (pack_parent / spec.version).exists()
    assert not (pack_parent / "active.json").exists()
    assert not list(pack_parent.glob(".*.staging-*"))


@pytest.mark.parametrize(
    "members",
    [
        {"../outside.py": b"owned = False\n"},
        {"demo-1.0.data/scripts/unsafe": b"#!/bin/sh\n"},
    ],
)
def test_rejects_wheel_traversal_and_non_library_install_schemes(
    tmp_path: Path,
    members: dict[str, bytes],
) -> None:
    wheel = tmp_path / "demo-1.0-py3-none-any.whl"
    _write_wheel(wheel, members)
    spec = parse_provider_pack_spec(_payload([wheel]))

    with pytest.raises(ProviderPackError, match="unsafe|unsupported"):
        install_provider_pack(spec, app_dir=tmp_path / "state", fetcher=_copy_fetcher(tmp_path))

    assert not (tmp_path / "outside.py").exists()


def test_rejects_symlinks_and_overlapping_multi_wheel_paths(tmp_path: Path) -> None:
    symlink_wheel = tmp_path / "symlink-1.0-py3-none-any.whl"
    _write_wheel(symlink_wheel, {"demo/__init__.py": b""}, symlink="../../outside")
    symlink_spec = parse_provider_pack_spec(_payload([symlink_wheel]))
    with pytest.raises(ProviderPackError, match="non-regular"):
        install_provider_pack(
            symlink_spec,
            app_dir=tmp_path / "state-symlink",
            fetcher=_copy_fetcher(tmp_path),
        )

    first = tmp_path / "first-1.0-py3-none-any.whl"
    second = tmp_path / "second-1.0-py3-none-any.whl"
    _write_wheel(first, {"shared/module.py": b"first\n"})
    _write_wheel(second, {"shared/module.py": b"second\n"})
    overlap_spec = parse_provider_pack_spec(_payload([first, second]))
    with pytest.raises(ProviderPackError, match="overlap"):
        install_provider_pack(
            overlap_spec,
            app_dir=tmp_path / "state-overlap",
            fetcher=_copy_fetcher(tmp_path),
        )
