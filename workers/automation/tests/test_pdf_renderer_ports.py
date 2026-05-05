"""Phase 6 / S-22: PdfRendererPort contract + adapter behaviour tests.

Two adapters implement the port:

  * :class:`LatexPdfAdapter` for tailored resumes (pdflatex).
  * :class:`PlaywrightHtmlPdfAdapter` for cover letters (Playwright).

The adapters intentionally raise :class:`NotImplementedError` from the
opposite half of the port so a mis-wired use case fails loudly. We
exercise both halves with a fake renderer to demonstrate the port
contract is honourable, then exercise the real LaTeX adapter against a
minimal profile when ``pdflatex`` is available.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from jobhunter.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)
from jobhunter.domain.ports.materials import PdfRendererPort
from jobhunter.infrastructure.materials import (
    LatexPdfAdapter,
    PlaywrightHtmlPdfAdapter,
)
from jobhunter.infrastructure.materials.latex_pdf import (
    DEFAULT_RESUME_LATEX_TEMPLATE,
    _escape_latex,
    _escape_latex_light,
    build_latex,
    validate_latex_template,
)
from jobhunter.infrastructure.materials.playwright_html_pdf import _build_letter_html


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _profile() -> dict:
    return {
        "personal": {
            "full_name": "Jane Doe",
            "email": "jane@example.com",
            "phone": "+1-555-0100",
        },
        "resume": {
            "executive_profile": {"baseline_text": "Engineer."},
            "experience_entries": [
                {
                    "id": "acme_swe",
                    "date_range": "2020-Present",
                    "title": "Senior SWE",
                    "company": "Acme",
                    "location": "Remote",
                    "bullets": ["Built systems."],
                }
            ],
            "education_entries": [
                {"id": "edu", "degree": "BS CS", "institution": "State", "location": "City", "date": "2015"}
            ],
            "skill_categories": [
                {"id": "languages", "label": "Languages", "items": ["Python", "Go"]}
            ],
            "tailoring_rules": {
                "required_experience_entry_ids": ["acme_swe"],
                "required_skill_category_ids": ["languages"],
                "max_experience_bullets": 4,
            },
        },
    }


def _payload() -> dict:
    return {
        "executive_profile": "Tailored summary.",
        "experience_updates": [{"id": "acme_swe", "bullets": ["Cut latency."]}],
        "skill_category_updates": [{"id": "languages", "items": ["Python"]}],
    }


# ---------------------------------------------------------------------------
# Port contract — fake adapter exercising both halves.
# ---------------------------------------------------------------------------


class _FakeRenderer:
    """Implements :class:`PdfRendererPort` for use-case tests.

    Captures every render call so tests can assert the use case
    delegated correctly without relying on subprocess or Chromium.
    """

    def __init__(self) -> None:
        self.resume_calls: list[dict] = []
        self.cover_calls: list[dict] = []

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload: dict,
        profile_dict: dict,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        self.resume_calls.append(
            {
                "tailored_payload": tailored_payload,
                "profile_dict": profile_dict,
                "output_path": output_path,
                "created_at": created_at,
            }
        )
        Path(output_path).write_bytes(b"%PDF-fake")
        return Artifact.create(
            type=ArtifactType.RESUME_PDF,
            path=output_path,
            created_at=created_at,
            render_format=RenderFormat.LATEX_PDF,
            size_bytes=len(b"%PDF-fake"),
        )

    def render_cover_letter_to_pdf(
        self,
        *,
        cover_letter_text: str,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        self.cover_calls.append(
            {
                "cover_letter_text": cover_letter_text,
                "output_path": output_path,
                "created_at": created_at,
            }
        )
        Path(output_path).write_bytes(b"%PDF-cover")
        return Artifact.create(
            type=ArtifactType.COVER_LETTER_PDF,
            path=output_path,
            created_at=created_at,
            render_format=RenderFormat.HTML_PDF,
            size_bytes=len(b"%PDF-cover"),
        )


def test_fake_renderer_satisfies_port_protocol() -> None:
    fake: PdfRendererPort = _FakeRenderer()
    assert hasattr(fake, "render_resume_to_pdf")
    assert hasattr(fake, "render_cover_letter_to_pdf")


def test_fake_renderer_returns_typed_artifact(tmp_path: Path) -> None:
    fake = _FakeRenderer()
    out = tmp_path / "x.pdf"
    artifact = fake.render_resume_to_pdf(
        tailored_payload={"x": 1},
        profile_dict={},
        output_path=str(out),
        created_at="2024-01-01T00:00:00+00:00",
    )
    assert artifact.type is ArtifactType.RESUME_PDF
    assert artifact.status is ArtifactStatus.CANDIDATE
    assert artifact.render_format is RenderFormat.LATEX_PDF


# ---------------------------------------------------------------------------
# LatexPdfAdapter — opposite-half guard
# ---------------------------------------------------------------------------


def test_latex_adapter_refuses_cover_letter() -> None:
    adapter = LatexPdfAdapter()
    with pytest.raises(NotImplementedError):
        adapter.render_cover_letter_to_pdf(
            cover_letter_text="Dear Hiring Manager",
            output_path="/tmp/x.pdf",
            created_at="2024-01-01T00:00:00+00:00",
        )


def test_playwright_adapter_refuses_resume() -> None:
    adapter = PlaywrightHtmlPdfAdapter()
    with pytest.raises(NotImplementedError):
        adapter.render_resume_to_pdf(
            tailored_payload={},
            profile_dict={},
            output_path="/tmp/x.pdf",
            created_at="2024-01-01T00:00:00+00:00",
        )


# ---------------------------------------------------------------------------
# LaTeX-side helpers (parity with deleted scoring/pdf.py tests)
# ---------------------------------------------------------------------------


class TestLatexEscape:
    def test_ampersand(self) -> None:
        assert _escape_latex("R&D") == "R\\&D"

    def test_percent(self) -> None:
        assert _escape_latex("100%") == "100\\%"

    def test_em_dash(self) -> None:
        assert "---" in _escape_latex("word—word")


class TestLatexEscapeLight:
    def test_preserves_backslash_commands(self) -> None:
        assert "\\texteuro" in _escape_latex_light("\\texteuro 500")

    def test_ampersand(self) -> None:
        assert _escape_latex_light("R&D") == "R\\&D"


class TestBuildLatex:
    def test_generates_valid_document(self) -> None:
        latex = build_latex(_payload(), _profile())
        assert r"\documentclass" in latex
        assert r"\begin{document}" in latex
        assert r"\end{document}" in latex
        assert r"\name{Jane}{Doe}" in latex

    def test_default_template_validates(self) -> None:
        validate_latex_template(DEFAULT_RESUME_LATEX_TEMPLATE)

    def test_template_requires_tokens(self) -> None:
        with pytest.raises(ValueError, match="resume_body"):
            validate_latex_template(r"\documentclass{article} {{ personal_data }}")


def test_build_letter_html_wraps_paragraphs() -> None:
    html = _build_letter_html("Dear Hiring Manager,\n\nFirst paragraph.\n\nSecond paragraph.")
    assert "<p>Dear Hiring Manager,</p>" in html
    assert "<p>First paragraph.</p>" in html
    assert "<p>Second paragraph.</p>" in html


# ---------------------------------------------------------------------------
# End-to-end pdflatex compile (skipped when pdflatex is unavailable)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    shutil.which("pdflatex") is None,
    reason="pdflatex not installed in this environment",
)
def test_latex_adapter_renders_real_pdf(tmp_path: Path) -> None:
    adapter = LatexPdfAdapter()
    out = tmp_path / "resume.pdf"
    artifact = adapter.render_resume_to_pdf(
        tailored_payload=_payload(),
        profile_dict=_profile(),
        output_path=str(out),
        created_at="2024-01-01T00:00:00+00:00",
    )
    assert out.exists()
    assert out.read_bytes()[:5] == b"%PDF-"
    assert artifact.size_bytes is not None and artifact.size_bytes > 0
