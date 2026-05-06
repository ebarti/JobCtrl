"""Phase 8 (S-28/S-29): ApplyPromptBuilder produces an ApplyPrompt with
the rendered text + MCP config bound to the requested CDP port."""

import pytest

from jobhunter.domain.apply.services import ApplyPromptBuilder
from jobhunter.domain.apply.value_objects import ApplyPrompt


class _FakeSnapshot:
    """Minimal stand-in for ProfileSnapshot used by the prompt builder."""


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
    )
    assert seen["dry_run"] is True
    assert seen["tailored_resume"] == "rt"
