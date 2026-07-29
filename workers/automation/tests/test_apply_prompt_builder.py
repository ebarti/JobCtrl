"""Phase 8 (S-28/S-29): ApplyPromptBuilder produces an ApplyPrompt with
the rendered text + MCP config bound to the requested CDP port."""

import json
import pytest
import sys
from pathlib import Path

from jobctrl import config as jobctrl_config
from jobctrl.apply import prompt as prompt_mod
from jobctrl.domain.apply.services import (
    ApplyPromptBuilder,
    _credential_origins,
    _default_mcp_config,
    _verification_sender_domains,
)
from jobctrl.domain.apply.value_objects import ApplyPrompt
from jobctrl.infrastructure.apply import claude_code_cli


class _FakeSnapshot:
    """Minimal stand-in for ProfileSnapshot used by the prompt builder."""

    @property
    def personal(self):
        return self.as_dict()["personal"]

    def as_dict(self):
        return {
            "personal": {
                "full_name": "Test Applicant",
                "email": "test@example.com",
                "password": "DistinctivePasswordShouldNeverRender",
                "phone": "+1 555 0100",
                "address": "",
                "city": "Barcelona",
                "province_state": "",
                "country": "Spain",
                "postal_code": "",
            },
            "work_authorization": {
                "legally_authorized_to_work": "Yes",
                "require_sponsorship": "No",
            },
            "compensation": {
                "salary_expectation": "100000",
                "salary_currency": "EUR",
            },
            "experience": {
                "years_of_experience_total": "10",
                "target_role": "Engineering leader",
            },
            "availability": {"earliest_start_date": "Immediately"},
            "eeo_voluntary": {},
            "application_attestations": {
                "background_check_consent": True,
            },
            "application_preferences": {"how_heard": "Referral"},
        }


class _PrivateSnapshotMustStayUnread:
    @property
    def personal(self):
        raise AssertionError("inspection MCP config must not read profile data")


@pytest.fixture()
def builder():
    return ApplyPromptBuilder(mcp_config_factory=lambda port: {"playwright": {"port": port}})


def test_build_returns_apply_prompt(monkeypatch, builder):
    # Stub out the legacy prompt.build_prompt — the builder is the
    # seam, not the underlying string assembly.
    monkeypatch.setattr(
        "jobctrl.apply.prompt.build_prompt",
        lambda **_kwargs: "rendered prompt body",
    )
    prompt = builder.build(
        job={
            "url": "https://x",
            "title": "Eng",
            "site": "ExampleCo",
            "application_url": "https://x/apply",
            "fit_score": 8,
            "tailored_resume_path": "/tmp/resume.pdf",
        },
        tailored_resume="resume text",
        snapshot=_FakeSnapshot(),
        cdp_port=9242,
        dry_run=False,
    )
    assert isinstance(prompt, ApplyPrompt)
    assert prompt.text == "rendered prompt body"
    assert prompt.mcp_config == {"playwright": {"port": 9242}}


def test_build_passes_dry_run_through_to_legacy_builder(monkeypatch, builder):
    seen = {}

    def fake_build(**kwargs):
        seen.update(kwargs)
        return "rendered"

    monkeypatch.setattr("jobctrl.apply.prompt.build_prompt", fake_build)
    builder.build(
        job={"url": "u", "tailored_resume_path": "/tmp/r.pdf"},
        tailored_resume="rt",
        snapshot=_FakeSnapshot(),
        cdp_port=9222,
        dry_run=True,
        upload_dir="/tmp/worker-0",
    )
    assert seen["dry_run"] is True
    assert "tailored_resume" not in seen
    assert "cover_letter" not in seen
    assert "search_config" not in seen
    assert seen["upload_dir"] == "/tmp/worker-0"


def test_legacy_prompt_keeps_reviewed_files_outside_worker_and_model(monkeypatch, tmp_path):
    worker_dir = tmp_path / "worker-0"
    materials_dir = tmp_path / "materials"
    materials_dir.mkdir()
    resume_txt = materials_dir / "resume.txt"
    resume_txt.write_text("Tailored resume", encoding="utf-8")
    resume_pdf = materials_dir / "resume.pdf"
    resume_pdf.write_bytes(b"%PDF-1.4\n")
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    monkeypatch.setattr(prompt_mod.config, "load_env", lambda: None)
    monkeypatch.setattr(
        prompt_mod.config,
        "gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client at /tmp/.jobctrl/gmail/oauth-client.json"),
    )

    rendered = prompt_mod.build_prompt(
        job={
            "url": "https://example.com/job",
            "application_url": "https://example.com/apply",
            "title": "Engineering Manager",
            "site": "ExampleCo",
            "fit_score": 9,
            "tailored_resume_path": str(resume_txt),
        },
        tailored_resume="Tailored resume text",
        snapshot=_FakeSnapshot(),
        search_config={"location": {"accept_patterns": ["Barcelona"]}},
        upload_dir=worker_dir,
    )

    expected_upload = worker_dir / "Test_Applicant_Resume.pdf"
    assert not expected_upload.exists()
    assert str(expected_upload) not in rendered
    assert "upload_artifact" not in rendered
    assert "Reviewed materials remain local for the user to handle manually" in rendered
    assert "browser_file_upload" not in rendered
    assert "Do not solve CAPTCHAs manually" in rendered
    assert "call solve_captcha(kind, sitekey, page_url) exactly once" in rendered
    assert "solve_captcha failure -> output RESULT:CAPTCHA and stop" in rendered
    assert "missing_profile_data:<field>" not in rendered
    assert "missing_attestation" not in rendered
    assert "answer YES only when" not in rendered
    assert "Don't sell short" not in rendered
    assert "== EMAIL VERIFICATION ==" not in rendered
    assert "get_verification_code" not in rendered
    assert "search_emails" not in rendered
    assert "read_email" not in rendered
    assert "Do not open Gmail in the browser" not in rendered
    assert 'type_credential(kind="job_site_password")' not in rendered
    assert "RESULT:LOGIN_ISSUE" in rendered
    assert "\nRESULT:DRY_RUN\n" in rendered
    assert "\nRESULT:APPLIED\n" not in rendered
    assert "RESULT:APPLIED --" not in rendered
    assert "terminal record must contain no explanation" in rendered
    assert "Do not upload into hidden controls" not in rendered

    dry_run_rendered = prompt_mod.build_prompt(
        job={
            "url": "https://example.com/job",
            "application_url": "https://example.com/apply",
            "title": "Engineering Manager",
            "site": "ExampleCo",
            "fit_score": 9,
            "tailored_resume_path": str(resume_txt),
        },
        tailored_resume="Tailored resume text",
        snapshot=_FakeSnapshot(),
        search_config={"location": {"accept_patterns": ["Barcelona"]}},
        upload_dir=worker_dir,
        dry_run=True,
    )
    assert "\nRESULT:DRY_RUN\n" in dry_run_rendered
    assert "RESULT:DRY_RUN with a note" not in dry_run_rendered


def test_legacy_prompt_keeps_apply_secrets_and_fake_capabilities_out_of_model_context(monkeypatch, tmp_path):
    worker_dir = tmp_path / "worker-0"
    materials_dir = tmp_path / "materials"
    materials_dir.mkdir()
    resume_txt = materials_dir / "resume.txt"
    resume_txt.write_text("Tailored resume", encoding="utf-8")
    resume_pdf = materials_dir / "resume.pdf"
    resume_pdf.write_bytes(b"%PDF-1.4\n")
    monkeypatch.setenv("CAPSOLVER_API_KEY", "capsolver-secret-never-render")
    monkeypatch.setattr(prompt_mod.config, "load_env", lambda: None)
    monkeypatch.setattr(
        prompt_mod.config,
        "gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client"),
    )

    rendered = prompt_mod.build_prompt(
        job={
            "url": "https://example.com/job",
            "application_url": "https://example.com/apply",
            "title": "Engineering Manager",
            "site": "ExampleCo",
            "fit_score": 9,
            "tailored_resume_path": str(resume_txt),
        },
        tailored_resume="Tailored resume text",
        snapshot=_FakeSnapshot(),
        search_config={"location": {"accept_patterns": ["Barcelona"]}},
        upload_dir=worker_dir,
    )

    assert "DistinctivePasswordShouldNeverRender" not in rendered
    assert "capsolver-secret-never-render" not in rendered
    assert "API key:" not in rendered
    assert "CAPSOLVER_API_KEY" not in rendered
    assert "browser_evaluate" not in rendered
    assert "browser_file_upload" not in rendered
    assert "send_email" not in rendered
    assert "RESULT:EMAIL_ONLY:<address>" in rendered
    assert "Age 18+: Yes" not in rendered
    assert "Felony: No" not in rendered
    assert "Background check consent: Yes" not in rendered


def test_apply_prompt_keeps_reviewed_material_and_profile_prose_opaque(
    monkeypatch,
    tmp_path,
) -> None:
    worker_dir = tmp_path / "worker-0"
    materials_dir = tmp_path / "materials"
    materials_dir.mkdir()
    resume_txt = materials_dir / "resume.txt"
    resume_txt.write_text("RESUME_CHAIN_REACHED", encoding="utf-8")
    resume_txt.with_suffix(".pdf").write_bytes(b"%PDF-1.4\n")
    cover_txt = materials_dir / "cover.txt"
    cover_txt.write_text("COVER_CHAIN_REACHED", encoding="utf-8")
    cover_txt.with_suffix(".pdf").write_bytes(b"%PDF-1.4\n")
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    monkeypatch.setattr(prompt_mod.config, "load_env", lambda: None)
    monkeypatch.setattr(
        prompt_mod.config,
        "gmail_mcp_auth_status",
        lambda: (False, "missing OAuth client"),
    )

    rendered = prompt_mod.build_prompt(
        job={
            "url": "https://example.com/job",
            "application_url": "https://example.com/apply",
            "title": "JOB_TITLE_CHAIN_REACHED",
            "site": "JOB_SITE_CHAIN_REACHED",
            "fit_score": 9,
            "tailored_resume_path": str(resume_txt),
            "cover_letter_path": str(cover_txt),
        },
        tailored_resume="RESUME_ARGUMENT_CHAIN_REACHED",
        cover_letter="COVER_ARGUMENT_CHAIN_REACHED",
        snapshot=_FakeSnapshot(),
        search_config={"location": {"accept_patterns": ["Barcelona"]}},
        upload_dir=worker_dir,
        dry_run=True,
    )

    for untrusted_or_private_value in (
        "RESUME_CHAIN_REACHED",
        "RESUME_ARGUMENT_CHAIN_REACHED",
        "COVER_CHAIN_REACHED",
        "COVER_ARGUMENT_CHAIN_REACHED",
        "JOB_TITLE_CHAIN_REACHED",
        "JOB_SITE_CHAIN_REACHED",
        "Test Applicant",
        "test@example.com",
        "+1 555 0100",
        "100000",
    ):
        assert untrusted_or_private_value not in rendered
    assert "https://example.com/apply" in rendered
    assert "upload_artifact" not in rendered
    assert not (worker_dir / "Test_Applicant_Resume.pdf").exists()
    assert not (worker_dir / "Test_Applicant_Cover_Letter.pdf").exists()
    assert "== RESUME TEXT" not in rendered
    assert "== COVER LETTER TEXT" not in rendered
    assert "== APPLICANT PROFILE" not in rendered


def test_attestation_lines_render_full_partial_and_empty_sets() -> None:
    base_profile = {"application_preferences": {"how_heard": "Referral"}}
    full = {
        **base_profile,
        "application_attestations": {
            "age_18_plus": True,
            "background_check_consent": True,
            "felony_conviction": False,
            "previously_worked_at_employer": False,
            "additional": {"can_travel": True},
        },
    }
    partial = {
        **base_profile,
        "application_attestations": {
            "age_18_plus": None,
            "background_check_consent": True,
            "felony_conviction": None,
            "previously_worked_at_employer": None,
        },
    }
    empty = {"application_attestations": {}, "application_preferences": {}}

    assert prompt_mod._build_profile_attestation_lines(full) == [
        "Age 18+: Yes",
        "Background check consent: Yes",
        "Felony conviction: No",
        "Previously worked at employer: No",
        "Can travel: Yes",
        "How heard: Referral",
    ]
    assert prompt_mod._build_profile_attestation_lines(partial) == [
        "Background check consent: Yes",
        "How heard: Referral",
    ]
    assert prompt_mod._build_profile_attestation_lines(empty) == []


def test_default_mcp_config_includes_only_inspection_connectors(monkeypatch) -> None:
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    monkeypatch.setenv(
        "JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS",
        "https://apply.example.com",
    )
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    config = _default_mcp_config(
        9222,
        job={
            "url": "https://jobs.example.com/role",
            "application_url": "https://apply.example.com/job",
        },
        snapshot=_PrivateSnapshotMustStayUnread(),
        upload_dir="/tmp/worker-0",
    )

    assert set(config["mcpServers"]) == {"playwright", "apply_tools"}
    playwright = config["mcpServers"]["playwright"]
    assert playwright["command"] == "npx"
    assert playwright["args"][0] == "@playwright/mcp@0.0.77"
    apply_tools = config["mcpServers"]["apply_tools"]
    assert apply_tools["command"] == sys.executable
    assert apply_tools["args"] == ["-m", "jobctrl.infrastructure.apply_tools.mcp_server"]
    assert apply_tools["env"]["JOBCTRL_APPLY_CDP_ENDPOINT"] == "http://localhost:9222"
    assert apply_tools["env"]["JOBCTRL_APPLY_APPROVED_APPLICATION_URL"] == "https://apply.example.com/job"
    assert apply_tools["env"]["JOBCTRL_APPLY_UPLOAD_DIR"] == "/tmp/worker-0"
    assert "JOBCTRL_APPLY_ALLOWED_CREDENTIAL_ORIGINS" not in apply_tools["env"]
    assert "JOBCTRL_APPLY_PROFILE_DB_PATH" not in apply_tools["env"]
    assert "CAPSOLVER_API_KEY" not in apply_tools["env"]
    assert "mcp__apply_tools__solve_captcha" not in claude_code_cli._allowed_tools_for_mcp_config(config)
    assert "DistinctivePasswordShouldNeverRender" not in json.dumps(apply_tools["env"])


def test_default_mcp_config_does_not_derive_credential_authority_from_application_url(
    monkeypatch,
) -> None:
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    monkeypatch.delenv(
        "JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS",
        raising=False,
    )

    config = _default_mcp_config(
        9222,
        job={"application_url": "https://attacker.example/login"},
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )

    apply_tools = config["mcpServers"]["apply_tools"]
    assert "JOBCTRL_APPLY_ALLOWED_CREDENTIAL_ORIGINS" not in apply_tools["env"]
    assert "JOBCTRL_APPLY_PROFILE_DB_PATH" not in apply_tools["env"]
    assert (
        "mcp__apply_tools__type_credential"
        not in claude_code_cli._allowed_tools_for_mcp_config(config)
    )


def test_default_mcp_config_never_restores_credential_authority_for_enrolled_origin(
    monkeypatch,
) -> None:
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "source")
    monkeypatch.setenv(
        "JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS",
        "https://apply.example.com:443, https://other.example",
    )

    trusted = _default_mcp_config(
        9222,
        job={"application_url": "https://apply.example.com/job/123"},
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )
    hostile = _default_mcp_config(
        9223,
        job={"application_url": "https://attacker.example/login"},
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-1",
    )

    for config in (trusted, hostile):
        apply_env = config["mcpServers"]["apply_tools"]["env"]
        assert "JOBCTRL_APPLY_ALLOWED_CREDENTIAL_ORIGINS" not in apply_env
        assert "JOBCTRL_APPLY_PROFILE_DB_PATH" not in apply_env
        assert (
            claude_code_cli.CREDENTIAL_APPLY_TOOL
            not in claude_code_cli._allowed_tools_for_mcp_config(config)
        )


@pytest.mark.parametrize(
    ("enrollment", "application_url", "expected"),
    [
        (
            "https://apply.example.com:443",
            "https://apply.example.com/job",
            ("https://apply.example.com",),
        ),
        (
            "https://apply.example.com",
            "https://sub.apply.example.com/job",
            (),
        ),
        (
            "https://apply.example.com.evil.test",
            "https://apply.example.com/job",
            (),
        ),
        (
            "https://user:password@apply.example.com",
            "https://apply.example.com/job",
            (),
        ),
    ],
)
def test_credential_origin_enrollment_is_exact_and_canonical(
    monkeypatch,
    enrollment,
    application_url,
    expected,
) -> None:
    monkeypatch.setenv(
        "JOBCTRL_TRUSTED_JOB_SITE_CREDENTIAL_ORIGINS",
        enrollment,
    )

    assert _credential_origins(application_url) == expected


def test_bundled_mcp_config_uses_only_signed_payload_commands(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    payload = tmp_path / "payload"
    wrapper = payload / "playwright-mcp/bin/playwright-mcp"
    wrapper.parent.mkdir(parents=True)
    wrapper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    wrapper.chmod(0o755)
    monkeypatch.setenv("JOBCTRL_RUNTIME_MODE", "bundled")
    monkeypatch.setenv("JOBCTRL_PAYLOAD_DIR", str(payload))
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(payload / "chromium"))

    config = _default_mcp_config(
        9222,
        job={"application_url": "https://apply.example.com/job"},
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )

    serialized = json.dumps(config)
    assert "npx" not in serialized
    assert "@playwright/mcp" not in serialized
    playwright = config["mcpServers"]["playwright"]
    assert playwright["command"] == str(wrapper.resolve())
    assert playwright["args"] == [
        "--cdp-endpoint=http://localhost:9222",
        f"--viewport-size={jobctrl_config.DEFAULTS['viewport']}",
    ]
    for name, module in (
        ("apply_tools", "jobctrl.infrastructure.apply_tools.mcp_server"),
    ):
        server = config["mcpServers"][name]
        assert server["command"] == sys.executable
        assert server["args"] == ["-I", "-B", "-m", module]
        assert server["env"]["JOBCTRL_RUNTIME_MODE"] == "bundled"
        assert server["env"]["JOBCTRL_PAYLOAD_DIR"] == str(payload.resolve())
        assert server["env"]["JOBCTRL_DIR"] == str(jobctrl_config.APP_DIR)
        assert server["env"]["PYTHONNOUSERSITE"] == "1"
        assert server["env"]["PYTHONSAFEPATH"] == "1"


@pytest.mark.parametrize(
    ("application_url", "expected"),
    [
        ("https://jobs.example.com/role", ("example.com",)),
        ("https://careers.example.co.uk/apply", ("example.co.uk",)),
        ("https://co.uk/apply", ()),
        ("https://127.0.0.1/apply", ()),
        ("http://localhost/apply", ("localhost",)),
    ],
)
def test_verification_sender_domains_use_registrable_domain(
    application_url: str,
    expected: tuple[str, ...],
) -> None:
    assert _verification_sender_domains(application_url) == expected


def test_default_mcp_config_omits_gmail_connector(monkeypatch) -> None:
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    config = _default_mcp_config(
        9222,
        job={
            "url": "https://jobs.example.co.uk/role",
            "application_url": "https://careers.example.co.uk/apply",
        },
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )

    assert "gmail" not in config["mcpServers"]


def test_default_mcp_config_scopes_capsolver_key_to_apply_tools(monkeypatch) -> None:
    monkeypatch.setenv("CAPSOLVER_API_KEY", "capsolver-private-key")

    config = _default_mcp_config(
        9222,
        job={"application_url": "https://apply.example.com/job"},
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )

    apply_tools = config["mcpServers"]["apply_tools"]
    assert apply_tools["env"]["CAPSOLVER_API_KEY"] == "capsolver-private-key"
    assert "mcp__apply_tools__solve_captcha" in claude_code_cli._allowed_tools_for_mcp_config(config)
    captcha_section = prompt_mod._build_captcha_section()
    assert "capsolver-private-key" not in captcha_section
    assert "CAPSOLVER_API_KEY" not in captcha_section
