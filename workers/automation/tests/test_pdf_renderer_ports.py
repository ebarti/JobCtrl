"""Phase 6 / S-22: PdfRendererPort contract + adapter behaviour tests.

Two adapters implement the port:

  * :class:`LatexPdfAdapter` for tailored resumes (pdflatex).
  * :class:`HtmlResumePdfAdapter` for tailored resumes (HTML/CSS + Playwright).
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
from jobhunter.domain.materials.services import ResumeAssembler
from jobhunter.domain.ports.materials import PdfRendererPort
from jobhunter.infrastructure.materials import html_resume_pdf
from jobhunter.infrastructure.materials import (
    HtmlResumePdfAdapter,
    LatexPdfAdapter,
    PlaywrightHtmlPdfAdapter,
)
from jobhunter.infrastructure.materials.html_resume_pdf import (
    build_resume_document,
    build_resume_html,
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
            "website_url": "https://janedoe.dev",
            "linkedin_url": "https://www.linkedin.com/in/janedoe",
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
        resume_theme: dict | None = None,
        resume_template: dict | None = None,
    ) -> Artifact:
        self.resume_calls.append(
            {
                "tailored_payload": tailored_payload,
                "profile_dict": profile_dict,
                "output_path": output_path,
                "created_at": created_at,
                "resume_theme": resume_theme,
                "resume_template": resume_template,
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


def test_html_resume_adapter_refuses_cover_letter() -> None:
    adapter = HtmlResumePdfAdapter()
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
# HtmlResumePdfAdapter — structured resume HTML/CSS seam
# ---------------------------------------------------------------------------


def test_build_resume_document_reuses_tailoring_policy_helpers() -> None:
    document = build_resume_document(_payload(), _profile())

    assert document["personal"]["full_name"] == "Jane Doe"
    assert document["personal"]["contact_items"] == [
        {"kind": "phone", "label": "+1-555-0100", "href": "tel:+15550100"},
        {"kind": "email", "label": "jane@example.com", "href": "mailto:jane@example.com"},
        {"kind": "website", "label": "janedoe.dev", "href": "https://janedoe.dev"},
        {"kind": "linkedin", "label": "janedoe", "href": "https://www.linkedin.com/in/janedoe"},
    ]
    assert document["summary"] == "Tailored summary."
    assert document["experience"][0]["title"] == "Senior SWE"
    assert document["experience"][0]["company"] == "Acme"
    assert document["experience"][0]["bullets"][0]["text"] == "Cut latency."
    assert document["skills"][0]["items"] == ["Python"]


def test_build_resume_html_escapes_text_and_marks_layout_targets() -> None:
    profile = _profile()
    profile["personal"]["full_name"] = "Jane <script>alert(1)</script>"
    html = build_resume_html(build_resume_document(_payload(), profile))

    assert "@page" in html
    assert "print-color-adjust: exact" in html
    assert "data-resume-layout-target=\"personal:full_name\"" in html
    assert "data-resume-line-number=\"1\"" in html
    assert "Jane &lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)</script>" not in html


def test_build_resume_html_matches_moderncv_contact_and_experience_layout() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["date_range"] = "Mar 2024 -- Present"
    document = build_resume_document(_payload(), profile)
    html = build_resume_html(document)

    assert '<span class="resume-contact-item resume-contact-phone"><a href="tel:+15550100">+1-555-0100</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-email"><a href="mailto:jane@example.com">jane@example.com</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-website"><a href="https://janedoe.dev">janedoe.dev</a></span>' in html
    assert '<span class="resume-contact-item resume-contact-linkedin"><a href="https://www.linkedin.com/in/janedoe">janedoe</a></span>' in html
    assert '<span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">Acme</span><span class="resume-entry-location">Remote</span></span>' in html
    assert document["experience"][0]["date_range"] == "Mar 2024 - Present"
    assert '<span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">Senior SWE</span><span class="resume-entry-date">Mar 2024 - Present</span></span>' in html
    assert "Mar 2024 -- Present" not in html
    assert html.index("resume-entry-company-row") < html.index("resume-entry-role-row")


def test_html_resume_adapter_returns_resume_pdf_with_layout_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def fake_render(html_content: str, output_path: str) -> list[dict]:
        assert "data-resume-layout-target" in html_content
        Path(output_path).write_bytes(b"%PDF-html")
        return [
            {
                "semantic_id": "experience:acme_swe:bullet:1",
                "page_number": 1,
                "line_number": 6,
                "text_excerpt": "Cut latency.",
                "left_pct": 10.0,
                "top_pct": 20.0,
                "width_pct": 50.0,
                "height_pct": 2.0,
            }
        ]

    monkeypatch.setattr(html_resume_pdf, "_render_resume_pdf_playwright", fake_render)

    adapter = HtmlResumePdfAdapter()
    out = tmp_path / "resume.pdf"
    artifact = adapter.render_resume_to_pdf(
        tailored_payload=_payload(),
        profile_dict=_profile(),
        output_path=str(out),
        created_at="2024-01-01T00:00:00+00:00",
    )

    assert out.exists()
    assert out.with_suffix(".html").exists()
    assert artifact.type is ArtifactType.RESUME_PDF
    assert artifact.status is ArtifactStatus.CANDIDATE
    assert artifact.render_format is RenderFormat.HTML_PDF
    assert artifact.size_bytes == len(b"%PDF-html")
    assert artifact.metadata["html_path"] == str(out.with_suffix(".html"))
    assert artifact.metadata["layout_source"] == "html_resume_dom"
    assert artifact.metadata["layout_boxes"][0]["semantic_id"] == "experience:acme_swe:bullet:1"


def test_render_resume_html_to_pdf_passes_full_html_to_playwright(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, str] = {}

    def fake_render(html_content: str, output_path: str) -> list[dict]:
        captured["html"] = html_content
        Path(output_path).write_bytes(b"%PDF-html")
        return []

    monkeypatch.setattr(html_resume_pdf, "_render_resume_pdf_playwright", fake_render)

    body = "<main data-resume-page='1'>" + "".join(f"<li>Line {index}</li>" for index in range(1, 71)) + "</main>"
    out = tmp_path / "edited.pdf"
    html_resume_pdf.render_resume_html_to_pdf(body, str(out))

    assert out.exists()
    assert captured["html"] == body
    assert "Line 70" in captured["html"]


def test_html_resume_adapter_applies_template_to_pdf_html_and_layout_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_html: list[str] = []

    def fake_render(html_content: str, output_path: str) -> list[dict]:
        captured_html.append(html_content)
        Path(output_path).write_bytes(b"%PDF-html")
        return [
            {
                "semantic_id": "section:experience",
                "page_number": 1,
                "line_number": 3,
                "text_excerpt": "Experience",
                "left_pct": 9.0,
                "top_pct": 18.0,
                "width_pct": 80.0,
                "height_pct": 2.5,
            }
        ]

    monkeypatch.setattr(html_resume_pdf, "_render_resume_pdf_playwright", fake_render)

    template = {
        "templateId": "template_custom",
        "templateVersionId": "template_custom:v2",
        "templateVersionNumber": 2,
        "templateName": "Custom Garamond",
        "templateHash": "sha256:test",
        "assignmentSource": "job_override",
    }
    adapter = HtmlResumePdfAdapter()
    out = tmp_path / "templated-resume.pdf"
    artifact = adapter.render_resume_to_pdf(
        tailored_payload=_payload(),
        profile_dict=_profile(),
        output_path=str(out),
        created_at="2024-01-01T00:00:00+00:00",
        resume_theme={
            "fontFamily": "garamond",
            "density": "compact",
            "bulletSpacing": "loose",
            "fontScale": 1.1,
            "accentColor": "#123456",
            "marginMm": {"top": 12, "right": 13, "bottom": 14, "left": 15},
            "alignment": "left",
            "headerLayout": "left",
            "sectionHeadingStyle": "boxed",
        },
        resume_template=template,
    )

    html = out.with_suffix(".html").read_text(encoding="utf-8")
    assert captured_html == [html]
    assert "Garamond" in html
    assert "color: #123456" in html
    assert "padding: 12.00mm 13.00mm 14.00mm 15.00mm" in html
    assert "line-height: 1.200" in html
    assert "line-height: 1.120" in html
    assert "margin-block-start: 0.35mm" in html
    assert "margin-block-end: 2.40mm" in html
    assert "text-align: left" in html
    assert artifact.metadata["resume_template"] == template
    assert artifact.metadata["html_path"] == str(out.with_suffix(".html"))
    assert artifact.metadata["layout_boxes"][0]["semantic_id"] == "section:experience"


# ---------------------------------------------------------------------------
# Cross-renderer parity — mandatory bullet overflow (submitted PDF == reviewed .txt)
# ---------------------------------------------------------------------------


_OVERFLOW_BULLETS = [
    "Reduced checkout latency across the payments platform.",
    "Led the migration to an event driven ingestion pipeline.",
    "Owned the on call rotation and cut incident volume.",
    "Mentored four engineers through promotion.",
    "Rebuilt the analytics warehouse for faster reporting.",
    "Shipped the customer facing status page.",
]


def _overflow_payload(*, mandatory: bool) -> dict:
    """Payload whose single entry pins six bullets past ``max_experience_bullets`` (4).

    When ``mandatory`` the payload carries ``generated_claim_mappings`` — the
    requirement-led signal the validator accepts — so every render path keeps all
    six bullets. Otherwise the cap still trims to four.
    """
    payload: dict = {
        "executive_profile": "Tailored summary.",
        "experience_updates": [{"id": "acme_swe", "bullets": list(_OVERFLOW_BULLETS)}],
        "skill_category_updates": [{"id": "languages", "items": ["Python"]}],
    }
    if mandatory:
        payload["generated_claim_mappings"] = [
            {
                "claim_id": f"claim-{index}",
                "location": f"experience.acme_swe.bullets[{index}]",
                "text": bullet,
                "coverage_edge_ids": ["edge_acme"],
                "requirement_ids": [],
                "evidence_ids": [],
                "review_required": False,
            }
            for index, bullet in enumerate(_OVERFLOW_BULLETS)
        ]
    return payload


def _txt_experience_bullets(payload: dict, profile: dict) -> list[str]:
    text = ResumeAssembler().assemble_resume_text(payload, profile)
    return [line.removeprefix("- ") for line in text.splitlines() if line.startswith("- ")]


def _html_experience_bullets(payload: dict, profile: dict) -> list[str]:
    document = build_resume_document(payload, profile)
    return [
        bullet["text"]
        for entry in document["experience"]
        for bullet in entry["bullets"]
    ]


def _latex_experience_bullets(payload: dict, profile: dict) -> list[str]:
    latex = build_latex(payload, profile)
    return [
        line.strip().removeprefix("\\item").strip()
        for line in latex.splitlines()
        if line.strip().startswith("\\item") and "\\textbf" not in line
    ]


def test_pdf_renderers_render_all_mandatory_overflow_bullets_like_txt() -> None:
    """Regression: a validated candidate that pins mandatory-overflow bullets must
    ship the identical bullet set in the reviewed .txt AND in both submitted PDFs.
    Previously the PDF renderers built their experience map without the overflow
    allowance and silently trimmed the pinned bullets, so the employer received a
    weaker resume than the one the user reviewed."""
    profile = _profile()
    payload = _overflow_payload(mandatory=True)

    txt_bullets = _txt_experience_bullets(payload, profile)
    assert txt_bullets == _OVERFLOW_BULLETS  # .txt keeps all six (past the cap of 4)

    assert _html_experience_bullets(payload, profile) == txt_bullets
    assert _latex_experience_bullets(payload, profile) == txt_bullets


def test_pdf_renderers_respect_max_experience_bullets_without_overflow() -> None:
    """Without the mandatory-overflow signal the cap still applies identically in
    every render path: the .txt trims to ``max_experience_bullets`` and both PDFs
    match it exactly (no silent divergence in either direction)."""
    profile = _profile()
    payload = _overflow_payload(mandatory=False)

    txt_bullets = _txt_experience_bullets(payload, profile)
    assert txt_bullets == _OVERFLOW_BULLETS[:4]  # capped at max_experience_bullets

    assert _html_experience_bullets(payload, profile) == txt_bullets
    assert _latex_experience_bullets(payload, profile) == txt_bullets


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
