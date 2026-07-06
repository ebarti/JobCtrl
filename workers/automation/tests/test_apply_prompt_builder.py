"""Phase 8 (S-28/S-29): ApplyPromptBuilder produces an ApplyPrompt with
the rendered text + MCP config bound to the requested CDP port."""

import pytest
import sys

from jobhunter.apply import prompt as prompt_mod
from jobhunter.domain.apply.services import ApplyPromptBuilder, _default_mcp_config
from jobhunter.domain.apply.value_objects import ApplyPrompt


class _FakeSnapshot:
    """Minimal stand-in for ProfileSnapshot used by the prompt builder."""

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
    assert f"Resume PDF (upload this): {expected_upload}" in rendered
    assert "Do not solve CAPTCHAs manually" in rendered
    assert "RESULT:CAPTCHA and stop" in rendered
    assert "== EMAIL VERIFICATION ==" in rendered
    assert "search_emails" in rendered
    assert "read_email" in rendered
    assert "Do not open Gmail in the browser" in rendered
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
    assert "browser_evaluate" not in rendered
    assert "send_email" not in rendered
    assert "email_application_required" in rendered
    assert "Age 18+: Yes" not in rendered
    assert "Felony: No" not in rendered
    assert "Background check consent: Yes" in rendered


def test_default_mcp_config_includes_gmail_read_connector() -> None:
    config = _default_mcp_config(9222)

    gmail = config["mcpServers"]["gmail"]
    assert gmail["command"] == sys.executable
    assert gmail["args"] == ["-m", "jobhunter.infrastructure.gmail.mcp_server"]
