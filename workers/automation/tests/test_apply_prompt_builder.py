"""Phase 8 (S-28/S-29): ApplyPromptBuilder produces an ApplyPrompt with
the rendered text + MCP config bound to the requested CDP port."""

import json
import pytest
import sys

from jobhunter.apply import prompt as prompt_mod
from jobhunter.domain.apply.services import ApplyPromptBuilder, _default_mcp_config
from jobhunter.domain.apply.value_objects import ApplyPrompt
from jobhunter.infrastructure.apply import claude_code_cli


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


@pytest.fixture()
def builder():
    return ApplyPromptBuilder(
        mcp_config_factory=lambda port: {"playwright": {"port": port}}
    )


def test_build_returns_apply_prompt(monkeypatch, builder):
    # Stub out the legacy prompt.build_prompt — the builder is the
    # seam, not the underlying string assembly.
    monkeypatch.setattr(
        "jobhunter.apply.prompt.build_prompt",
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

    monkeypatch.setattr("jobhunter.apply.prompt.build_prompt", fake_build)
    builder.build(
        job={"url": "u", "tailored_resume_path": "/tmp/r.pdf"},
        tailored_resume="rt",
        snapshot=_FakeSnapshot(),
        cdp_port=9222,
        dry_run=True,
        upload_dir="/tmp/worker-0",
    )
    assert seen["dry_run"] is True
    assert seen["tailored_resume"] == "rt"
    assert seen["upload_dir"] == "/tmp/worker-0"


def test_legacy_prompt_copies_upload_files_into_worker_upload_dir(
    monkeypatch, tmp_path
):
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
        lambda: (False, "missing OAuth client at /tmp/.jobhunter/gmail/oauth-client.json"),
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
    assert expected_upload.exists()
    assert str(expected_upload) not in rendered
    assert 'upload_artifact(kind="resume")' in rendered
    assert "browser_file_upload" not in rendered
    assert "Do not solve CAPTCHAs manually" in rendered
    assert "call solve_captcha(kind, sitekey, page_url) exactly once" in rendered
    assert "solve_captcha failure -> output RESULT:CAPTCHA and stop" in rendered
    assert "missing_profile_data:<field>" in rendered
    assert "missing_attestation" not in rendered
    assert "answer YES only when" in rendered
    assert "Don't sell short" not in rendered
    assert "== EMAIL VERIFICATION ==" in rendered
    assert "get_verification_code" in rendered
    assert "search_emails" not in rendered
    assert "read_email" not in rendered
    assert "Do not open Gmail in the browser" in rendered
    assert 'type_credential(kind="job_site_password")' in rendered
    assert "RESULT:LOGIN_ISSUE" in rendered


def test_legacy_prompt_keeps_apply_secrets_and_fake_capabilities_out_of_model_context(
    monkeypatch, tmp_path
):
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
    assert "Background check consent: Yes" in rendered


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


def test_default_mcp_config_includes_scoped_owned_connectors(monkeypatch) -> None:
    monkeypatch.delenv("CAPSOLVER_API_KEY", raising=False)
    config = _default_mcp_config(
        9222,
        job={
            "url": "https://jobs.example.com/role",
            "application_url": "https://apply.example.com/job",
        },
        snapshot=_FakeSnapshot(),
        upload_dir="/tmp/worker-0",
    )

    playwright = config["mcpServers"]["playwright"]
    assert playwright["args"][0] == "@playwright/mcp@0.0.77"
    gmail = config["mcpServers"]["gmail"]
    assert gmail["command"] == sys.executable
    assert gmail["args"] == ["-m", "jobhunter.infrastructure.gmail.mcp_server"]
    assert gmail["env"]["JOBHUNTER_GMAIL_ALLOWED_DOMAINS"] == "example.com"
    assert gmail["env"]["JOBHUNTER_GMAIL_TO_EMAIL"] == "test@example.com"
    apply_tools = config["mcpServers"]["apply_tools"]
    assert apply_tools["command"] == sys.executable
    assert apply_tools["args"] == ["-m", "jobhunter.infrastructure.apply_tools.mcp_server"]
    assert apply_tools["env"]["JOBHUNTER_APPLY_CDP_ENDPOINT"] == "http://localhost:9222"
    assert apply_tools["env"]["JOBHUNTER_APPLY_UPLOAD_DIR"] == "/tmp/worker-0"
    assert "JOBHUNTER_APPLY_PROFILE_DB_PATH" in apply_tools["env"]
    assert "CAPSOLVER_API_KEY" not in apply_tools["env"]
    assert "mcp__apply_tools__solve_captcha" not in claude_code_cli._allowed_tools_for_mcp_config(config)
    assert "DistinctivePasswordShouldNeverRender" not in json.dumps(apply_tools["env"])


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
