"""Shared provider readiness, auth, and status probes."""

from __future__ import annotations

import json
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

import jobctrl.config
from jobctrl.infrastructure import setup_probes


def _sdk_ready(name: str):
    return setup_probes.ProbeResult(name, True, "stub")


def _stub_sdks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(setup_probes, "probe_claude_sdk", lambda: _sdk_ready("Claude analysis SDK"))
    monkeypatch.setattr(setup_probes, "probe_codex_sdk", lambda env=None: _sdk_ready("Codex analysis SDK"))
    monkeypatch.setattr(setup_probes, "probe_antigravity_sdk", lambda: _sdk_ready("Antigravity analysis SDK"))


def _write_adc(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "authorized_user",
                "client_id": "test-client",
                "client_secret": "test-secret",
                "refresh_token": "test-refresh",
            }
        ),
        encoding="utf-8",
    )


def _write_service_account_adc(path: Path) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "service_account",
                "project_id": "test-project",
                "private_key_id": "test-key-id",
                "private_key": private_key_pem,
                "client_email": "jobctrl-test@test-project.iam.gserviceaccount.com",
                "client_id": "1234567890",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                "client_x509_cert_url": (
                    "https://www.googleapis.com/robot/v1/metadata/x509/"
                    "jobctrl-test%40test-project.iam.gserviceaccount.com"
                ),
            }
        ),
        encoding="utf-8",
    )


def _write_codex_auth(path: Path, *, access_token: str = "test-access-token") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "tokens": {
                    "access_token": access_token,
                    "refresh_token": "test-refresh-token",
                }
            }
        ),
        encoding="utf-8",
    )


def _successful_codex_status(*_args, **_kwargs):
    return SimpleNamespace(returncode=0)


def test_enabled_analysis_legs_default_aliases_and_validation() -> None:
    assert setup_probes.parse_enabled_analysis_legs(None) == ("claude", "codex", "antigravity")
    assert setup_probes.parse_enabled_analysis_legs("gemini, openai") == ("codex", "antigravity")
    with pytest.raises(ValueError, match="unknown analysis leg"):
        setup_probes.parse_enabled_analysis_legs("claude,llama")


def test_analysis_sdk_set_version_includes_actual_synthesizer() -> None:
    assert setup_probes.analysis_sdk_set_version(
        ("claude", "antigravity"), synthesizer_provider="codex"
    ) == "claude+antigravity-v2-synth-codex"


def test_codex_requires_persisted_cli_auth_and_uses_stable_jobctrl_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")
    env = {"CODEX_HOME": str(source_home), "OPENAI_API_KEY": "sk-test"}

    raw_only = setup_probes.probe_codex_auth(env)
    assert raw_only.ok is False
    assert "not enrolled" in raw_only.note
    assert setup_probes.codex_auth_path(env) == app_dir / "codex_home/auth.json"

    source_home.mkdir()
    _write_codex_auth(source_home / "auth.json")
    target = setup_probes.ensure_jobctrl_codex_auth(
        env,
        runner=_successful_codex_status,
    )
    assert target == app_dir / "codex_home/auth.json"
    assert target.is_file()


@pytest.mark.parametrize(
    "env",
    [
        {"ANTHROPIC_API_KEY": "api"},
        {"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_PROFILE": "work"},
        {
            "CLAUDE_CODE_USE_ANTHROPIC_AWS": "1",
            "ANTHROPIC_AWS_WORKSPACE_ID": "workspace",
            "AWS_PROFILE": "work",
        },
        {
            "CLAUDE_CODE_USE_FOUNDRY": "1",
            "ANTHROPIC_FOUNDRY_RESOURCE": "resource",
            "ANTHROPIC_FOUNDRY_API_KEY": "secret",
        },
    ],
)
def test_claude_auth_accepts_api_and_official_cloud_provider_chains(env: dict[str, str]) -> None:
    assert setup_probes.probe_claude_auth(env).ok is True


def test_claude_vertex_requires_google_credentials(tmp_path: Path) -> None:
    credentials = tmp_path / "adc.json"
    missing = setup_probes.probe_claude_auth(
        {
            "CLAUDE_CODE_USE_VERTEX": "1",
            "ANTHROPIC_VERTEX_PROJECT_ID": "project",
            "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
        }
    )
    assert missing.ok is False
    _write_service_account_adc(credentials)
    ready = setup_probes.probe_claude_auth(
        {
            "CLAUDE_CODE_USE_VERTEX": "1",
            "ANTHROPIC_VERTEX_PROJECT_ID": "project",
            "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
        }
    )
    assert ready.ok is True


def test_explicit_non_service_account_adc_is_rejected_for_claude_and_google_vertex(
    tmp_path: Path,
) -> None:
    credentials = tmp_path / "adc.json"
    _write_adc(credentials)

    claude = setup_probes.probe_claude_auth(
        {
            "CLAUDE_CODE_USE_VERTEX": "1",
            "ANTHROPIC_VERTEX_PROJECT_ID": "project",
            "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
        }
    )
    google = setup_probes.probe_antigravity_auth(
        {
            "GOOGLE_GENAI_USE_VERTEXAI": "1",
            "GOOGLE_CLOUD_PROJECT": "project",
            "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
        }
    )

    assert claude.ok is False
    assert google.ok is False


def test_google_vertex_requires_loadable_local_adc(tmp_path: Path) -> None:
    credentials = tmp_path / "adc.json"
    base = {
        "GOOGLE_GENAI_USE_VERTEXAI": "1",
        "GOOGLE_CLOUD_PROJECT": "configured-project",
        "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
    }

    with pytest.raises(RuntimeError, match="valid local Vertex AI ADC"):
        setup_probes.antigravity_auth_kwargs(base)

    credentials.mkdir()
    with pytest.raises(RuntimeError, match="valid local Vertex AI ADC"):
        setup_probes.antigravity_auth_kwargs(base)

    credentials.rmdir()
    credentials.write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="valid local Vertex AI ADC"):
        setup_probes.antigravity_auth_kwargs(base)

    _write_service_account_adc(credentials)
    assert setup_probes.antigravity_auth_kwargs(base) == {
        "vertex": True,
        "project": "configured-project",
    }


def test_google_vertex_project_and_location_alone_are_not_credentials(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="valid local Vertex AI ADC"):
        setup_probes.antigravity_auth_kwargs(
            {
                "HOME": str(tmp_path),
                "GOOGLE_GENAI_USE_VERTEXAI": "1",
                "GOOGLE_CLOUD_PROJECT": "configured-project",
                "GOOGLE_CLOUD_LOCATION": "europe-west4",
            }
        )


def test_google_vertex_uses_gcloud_well_known_adc_when_env_is_unset(tmp_path: Path) -> None:
    credentials = tmp_path / ".config" / "gcloud" / "application_default_credentials.json"
    _write_adc(credentials)

    assert setup_probes.antigravity_auth_kwargs(
        {
            "HOME": str(tmp_path),
            "GOOGLE_GENAI_USE_VERTEXAI": "1",
            "GOOGLE_CLOUD_LOCATION": "europe-west4",
        }
    ) == {"vertex": True, "location": "europe-west4"}


def test_invalid_explicit_adc_does_not_fall_back_to_gcloud_adc(tmp_path: Path) -> None:
    _write_adc(tmp_path / ".config" / "gcloud" / "application_default_credentials.json")
    explicit = tmp_path / "invalid.json"
    explicit.write_text("{}", encoding="utf-8")

    probe = setup_probes.probe_antigravity_auth(
        {
            "HOME": str(tmp_path),
            "GOOGLE_APPLICATION_CREDENTIALS": str(explicit),
            "GOOGLE_GENAI_USE_VERTEXAI": "1",
            "GOOGLE_CLOUD_PROJECT": "configured-project",
        }
    )

    assert probe.ok is False
    assert "valid local Vertex AI ADC" in probe.note


@pytest.mark.parametrize("adc_state", ["missing", "invalid"])
def test_sole_google_missing_or_invalid_adc_is_not_ready_or_tier_two(
    adc_state: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _stub_sdks(monkeypatch)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", tmp_path / "jobctrl")
    monkeypatch.setattr(jobctrl.config, "load_env", lambda: None)
    credentials = tmp_path / "google-adc.json"
    if adc_state == "invalid":
        credentials.write_text("{}", encoding="utf-8")
    env = {
        "HOME": str(tmp_path),
        "CODEX_HOME": str(tmp_path / "absent-codex"),
        "GOOGLE_APPLICATION_CREDENTIALS": str(credentials),
        "GOOGLE_GENAI_USE_VERTEXAI": "1",
        "GOOGLE_CLOUD_PROJECT": "configured-project",
    }

    status = setup_probes.provider_status_snapshot("google", env)
    aggregate = next(
        row for row in setup_probes.probe_analysis_setup(env) if row.name == "core LLM provider"
    )
    assert status["configured"] is True
    assert status["ready"] is False
    assert aggregate.ok is False

    for key in (
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert jobctrl.config.get_tier() == 1


def test_claude_consumer_oauth_is_never_readiness() -> None:
    probe = setup_probes.probe_claude_auth({"CLAUDE_CODE_OAUTH_TOKEN": "consumer"})
    assert probe.ok is False
    assert "consumer OAuth" in probe.note


def test_claude_sdk_options_preserve_home_for_cloud_credential_discovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(jobctrl.config, "APP_DIR", tmp_path / "jobctrl")
    options = setup_probes.bundled_claude_sdk_options(
        {"ANTHROPIC_API_KEY": "api", "CLAUDE_CODE_OAUTH_TOKEN": "consumer"}
    )
    sdk_env = options["env"]
    assert "HOME" not in sdk_env
    assert sdk_env["CLAUDE_CODE_OAUTH_TOKEN"] == ""
    assert sdk_env["CLAUDE_CONFIG_DIR"].endswith("claude_home/config")


def test_any_one_provider_readiness_matrix(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_sdks(monkeypatch)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", tmp_path / "jobctrl")
    base = {"CODEX_HOME": str(tmp_path / "absent")}

    cases = (
        ({**base, "ANTHROPIC_API_KEY": "api"}, True),
        ({**base, "GOOGLE_API_KEY": "google"}, True),
        (base, False),
        ({**base, "OPENAI_API_KEY": "raw-only"}, False),
    )
    for env, expected in cases:
        result = setup_probes.probe_analysis_setup(env)
        core = next(row for row in result if row.name == "core LLM provider")
        assert core.ok is expected, (env, core)
        assert all(not row.required for row in result if row.name != "core LLM provider")


def test_provider_status_is_secret_free(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(setup_probes, "probe_claude_sdk", lambda: _sdk_ready("Claude analysis SDK"))
    status = setup_probes.provider_status_snapshot("claude", {"ANTHROPIC_API_KEY": "super-secret"})
    assert status == {
        "provider": "claude",
        "configured": True,
        "ready": True,
        "mode": "api_key",
        "message": "Claude provider is ready",
    }
    assert "super-secret" not in str(status)


def test_provider_status_does_not_copy_ambient_codex_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "source-codex"
    _write_codex_auth(source_home / "auth.json")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)

    status = setup_probes.provider_status_snapshot(
        "codex",
        {"CODEX_HOME": str(source_home)},
    )

    assert status["ready"] is False
    target = setup_probes.codex_auth_path()
    assert target.exists() is False
    assert target.parent.exists() is False


def test_verify_codex_uses_persisted_home_and_strips_raw_keys(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app_dir = tmp_path / "jobctrl"
    target = app_dir / "codex_home/auth.json"
    target.parent.mkdir(parents=True)
    _write_codex_auth(target)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")
    seen: dict[str, object] = {}

    def runner(command, **kwargs):
        seen.update(command=command, **kwargs)
        return SimpleNamespace(returncode=0)

    ambient_auth = {
        key: f"ambient-{key.lower()}"
        for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV
    }
    result = setup_probes.verify_codex_connection(ambient_auth, runner=runner)
    assert result == (True, "connected", "Codex CLI authentication verified")
    assert seen["command"][-2:] == ["login", "status"]
    child_env = seen["env"]
    assert all(key not in child_env for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV)
    assert child_env["CODEX_HOME"] == str(app_dir / "codex_home")


def test_reuse_and_verify_codex_connection_copies_ambient_auth_once_and_strips_raw_keys(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source_home = tmp_path / "regular-codex"
    source_auth = source_home / "auth.json"
    _write_codex_auth(source_auth)
    source_contents = source_auth.read_text(encoding="utf-8")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")
    calls: list[dict[str, object]] = []

    def runner(command, **kwargs):
        calls.append({"command": command, **kwargs})
        return SimpleNamespace(returncode=0)

    ambient_auth = {
        key: f"ambient-{key.lower()}"
        for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV
    }
    result = setup_probes.reuse_and_verify_codex_connection(
        {
            "CODEX_HOME": str(source_home),
            **ambient_auth,
        },
        runner=runner,
    )

    target = app_dir / "codex_home/auth.json"
    assert result == (True, "connected", "Codex CLI authentication verified")
    assert target.read_text(encoding="utf-8") == source_contents
    assert source_auth.read_text(encoding="utf-8") == source_contents
    assert len(calls) == 2
    staging_env = calls[0]["env"]
    stable_env = calls[1]["env"]
    assert calls[0]["command"][-2:] == ["login", "status"]
    assert Path(staging_env["CODEX_HOME"]).parent == app_dir
    assert Path(staging_env["CODEX_HOME"]).name.startswith(".codex-auth-import-")
    assert stable_env["CODEX_HOME"] == str(app_dir / "codex_home")
    for child_env in (staging_env, stable_env):
        assert all(
            key not in child_env
            for key in setup_probes.CODEX_NEUTRALIZED_AUTH_ENV
        )
    assert not list(app_dir.glob(".codex-auth-import-*"))


def test_reuse_and_verify_codex_connection_does_not_overwrite_isolated_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    target = app_dir / "codex_home/auth.json"
    source = tmp_path / "regular-codex/auth.json"
    _write_codex_auth(target, access_token="isolated-token")
    _write_codex_auth(source, access_token="ambient-token")
    target.chmod(0o644)
    target_contents = target.read_bytes()
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")

    result = setup_probes.reuse_and_verify_codex_connection(
        {"CODEX_HOME": str(source.parent)},
        runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=0),
    )

    assert result == (True, "connected", "Codex CLI authentication verified")
    assert target.read_bytes() == target_contents
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert "ambient-token" in source.read_text(encoding="utf-8")


def test_expired_codex_candidate_is_not_published_and_refreshed_source_can_retry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source = tmp_path / "regular-codex/auth.json"
    _write_codex_auth(source, access_token="expired-token")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")

    with pytest.raises(RuntimeError, match="could not be verified"):
        setup_probes.ensure_jobctrl_codex_auth(
            {"CODEX_HOME": str(source.parent)},
            runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=1),
        )

    target = app_dir / "codex_home/auth.json"
    assert target.exists() is False
    assert not list(app_dir.glob(".codex-auth-import-*"))
    _write_codex_auth(source, access_token="refreshed-token")

    result = setup_probes.ensure_jobctrl_codex_auth(
        {"CODEX_HOME": str(source.parent)},
        runner=_successful_codex_status,
    )

    assert result == target
    assert "refreshed-token" in target.read_text(encoding="utf-8")
    assert not list(app_dir.glob(".codex-auth-import-*"))


@pytest.mark.parametrize("mutation", ["symlink", "directory", "chmod"])
def test_codex_import_revalidates_and_hardens_candidate_after_live_verification(
    mutation: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    source = tmp_path / "regular-codex/auth.json"
    external = tmp_path / "replacement-auth.json"
    _write_codex_auth(source, access_token="source-token")
    _write_codex_auth(external, access_token="replacement-token")
    source_bytes = source.read_bytes()
    source_mode = stat.S_IMODE(source.stat().st_mode)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")

    def mutate_candidate(_command, **kwargs):
        candidate = Path(kwargs["env"]["CODEX_HOME"]) / "auth.json"
        if mutation == "chmod":
            candidate.chmod(0o644)
        else:
            candidate.unlink()
            if mutation == "symlink":
                candidate.symlink_to(external)
            else:
                candidate.mkdir()
        return SimpleNamespace(returncode=0)

    if mutation == "chmod":
        target = setup_probes.ensure_jobctrl_codex_auth(
            {"CODEX_HOME": str(source.parent)},
            runner=mutate_candidate,
        )
        assert target.read_bytes() == source_bytes
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
    else:
        with pytest.raises(RuntimeError, match="symlink|regular file"):
            setup_probes.ensure_jobctrl_codex_auth(
                {"CODEX_HOME": str(source.parent)},
                runner=mutate_candidate,
            )
        assert not (app_dir / "codex_home/auth.json").exists()
    assert source.read_bytes() == source_bytes
    assert stat.S_IMODE(source.stat().st_mode) == source_mode
    assert not list(app_dir.glob(".codex-auth-import-*"))


def test_codex_import_never_replaces_a_concurrent_valid_winner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    target = app_dir / "codex_home/auth.json"
    source = tmp_path / "regular-codex/auth.json"
    _write_codex_auth(source, access_token="candidate-token")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")

    def concurrent_winner(*_args, **_kwargs):
        _write_codex_auth(target, access_token="winner-token")
        target.chmod(0o644)
        return SimpleNamespace(returncode=0)

    result = setup_probes.ensure_jobctrl_codex_auth(
        {"CODEX_HOME": str(source.parent)},
        runner=concurrent_winner,
    )

    assert result == target
    assert "winner-token" in target.read_text(encoding="utf-8")
    assert "candidate-token" not in target.read_text(encoding="utf-8")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not list(app_dir.glob(".codex-auth-import-*"))


@pytest.mark.parametrize("unsafe_leaf", ["home", "auth"])
def test_codex_import_rejects_symlinks_in_the_owned_target_boundary(
    unsafe_leaf: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    app_dir.mkdir()
    source = tmp_path / "regular-codex/auth.json"
    _write_codex_auth(source)
    target_home = app_dir / "codex_home"
    if unsafe_leaf == "home":
        external_home = tmp_path / "external-home"
        external_home.mkdir()
        target_home.symlink_to(external_home, target_is_directory=True)
    else:
        target_home.mkdir()
        external_auth = tmp_path / "external-auth.json"
        _write_codex_auth(external_auth)
        (target_home / "auth.json").symlink_to(external_auth)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)

    with pytest.raises(RuntimeError, match="symlink"):
        setup_probes.ensure_jobctrl_codex_auth(
            {"CODEX_HOME": str(source.parent)},
            runner=_successful_codex_status,
        )


@pytest.mark.parametrize(
    "payload",
    [
        "",
        "{",
        "{}",
        '{"tokens":{"access_token":""}}',
    ],
)
def test_codex_rejects_empty_malformed_or_invalid_auth_json(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    payload: str,
) -> None:
    app_dir = tmp_path / "jobctrl"
    auth = app_dir / "codex_home/auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text(payload, encoding="utf-8")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)

    ok, status, _message = setup_probes.verify_codex_connection({}, runner=lambda *_args, **_kwargs: None)

    assert (ok, status) == (False, "not_configured")


def test_codex_rejects_auth_json_directory_or_symlink(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    auth = app_dir / "codex_home/auth.json"
    auth.parent.mkdir(parents=True)
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)

    auth.mkdir()
    assert setup_probes.verify_codex_connection({}, runner=lambda *_args, **_kwargs: None)[0] is False
    auth.rmdir()

    source = tmp_path / "source-auth.json"
    _write_codex_auth(source)
    auth.symlink_to(source)
    assert setup_probes.verify_codex_connection({}, runner=lambda *_args, **_kwargs: None)[0] is False


def test_failed_codex_cli_status_blocks_provider_status_core_gate_and_tier(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _stub_sdks(monkeypatch)
    app_dir = tmp_path / "jobctrl"
    _write_codex_auth(app_dir / "codex_home/auth.json")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(jobctrl.config, "load_env", lambda: None)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")

    def failed_runner(*_args, **_kwargs):
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(
        setup_probes,
        "_cached_verify_codex_connection",
        lambda values: setup_probes.verify_codex_connection(values, runner=failed_runner),
    )
    env = {"CODEX_HOME": str(tmp_path / "source-codex")}
    for key in (
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    assert setup_probes.provider_status_snapshot("codex", env)["ready"] is False
    assert setup_probes.ready_llm_providers(env) == ()
    assert setup_probes.core_llm_ready(env) is False
    assert next(
        probe for probe in setup_probes.probe_analysis_setup(env) if probe.name == "core LLM provider"
    ).ok is False
    monkeypatch.setenv("CODEX_HOME", env["CODEX_HOME"])
    monkeypatch.setattr(
        setup_probes,
        "_env",
        lambda supplied=None: supplied if supplied is not None else {"CODEX_HOME": env["CODEX_HOME"]},
    )
    assert jobctrl.config.get_tier() == 1


def test_codex_readiness_caches_successful_cli_status_for_unchanged_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app_dir = tmp_path / "jobctrl"
    _write_codex_auth(app_dir / "codex_home/auth.json")
    monkeypatch.setattr(jobctrl.config, "APP_DIR", app_dir)
    monkeypatch.setattr(setup_probes, "resolve_codex_binary", lambda env=None: tmp_path / "codex")
    checks = 0
    calls = 0

    def successful_runner(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return SimpleNamespace(returncode=0)

    verify = setup_probes.verify_codex_connection

    def verify_with_runner(values):
        nonlocal checks
        checks += 1
        return verify(values, runner=successful_runner)

    monkeypatch.setattr(setup_probes, "verify_codex_connection", verify_with_runner)

    assert setup_probes.probe_codex_auth({}).ok is True
    assert setup_probes.probe_codex_auth({}).ok is True
    assert checks == 1
    assert calls == 1

    (app_dir / "codex_home/auth.json").write_text("{}", encoding="utf-8")

    assert setup_probes.probe_codex_auth({}).ok is False
    assert checks == 2
    assert calls == 1


def test_resolve_codex_and_claude_binary_overrides(tmp_path: Path) -> None:
    assert setup_probes.resolve_codex_binary({"JOBCTRL_CODEX_BIN": str(tmp_path / "codex")}) == tmp_path / "codex"
    assert setup_probes.resolve_claude_apply_binary({"JOBCTRL_CLAUDE_BIN": str(tmp_path / "claude")}) == str(tmp_path / "claude")
