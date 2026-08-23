"""Phase 6 / S-22: PdfRendererPort contract + adapter behaviour tests.

Two adapters implement the port:

  * :class:`HtmlResumePdfAdapter` for tailored resumes (HTML/CSS + Playwright).
  * :class:`PlaywrightHtmlPdfAdapter` for cover letters (Playwright).

The adapters intentionally raise :class:`NotImplementedError` from the
opposite half of the port so a mis-wired use case fails loudly. We
exercise both halves with a fake renderer to demonstrate the port
contract is honourable.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from jobctrl.domain.materials import (
    Artifact,
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)
from jobctrl.domain.materials.services import ResumeAssembler
from jobctrl.domain.ports.materials import PdfRendererPort
from jobctrl.infrastructure.materials import html_resume_pdf
from jobctrl.infrastructure.materials import (
    HtmlResumePdfAdapter,
    PlaywrightHtmlPdfAdapter,
)
from jobctrl.infrastructure.materials.html_resume_pdf import (
    build_resume_document,
    build_resume_html,
)
from jobctrl.infrastructure.materials.playwright_html_pdf import _build_letter_html


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
                    "summary": "Owned the distributed systems mandate.",
                    "bullets": ["Built systems."],
                }
            ],
            "education_entries": [
                {"id": "edu", "degree": "BS CS", "institution": "State", "location": "City", "date": "2015"}
            ],
            "skill_categories": [{"id": "languages", "label": "Languages", "items": ["Python", "Go"]}],
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
            render_format=RenderFormat.HTML_PDF,
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
    assert artifact.render_format is RenderFormat.HTML_PDF


# ---------------------------------------------------------------------------
# Retired LaTeX adapter
# ---------------------------------------------------------------------------


def test_legacy_latex_renderer_module_is_absent() -> None:
    assert importlib.util.find_spec("jobctrl.infrastructure.materials.latex_pdf") is None


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
    assert document["experience"][0]["summary"] == "Owned the distributed systems mandate."
    assert document["experience"][0]["bullets"][0]["text"] == "Cut latency."
    assert document["skills"][0]["items"] == ["Python"]


def test_build_resume_html_escapes_text_and_marks_layout_targets() -> None:
    profile = _profile()
    profile["personal"]["full_name"] = "Jane <script>alert(1)</script>"
    html = build_resume_html(build_resume_document(_payload(), profile))

    assert "@page" in html
    assert "print-color-adjust: exact" in html
    assert 'data-resume-layout-target="personal:full_name"' in html
    assert 'data-resume-line-number="1"' in html
    assert "Jane &lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)</script>" not in html


def test_build_resume_html_matches_moderncv_contact_and_experience_layout() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["date_range"] = "Mar 2024 -- Present"
    document = build_resume_document(_payload(), profile)
    html = build_resume_html(document)

    assert (
        '<span class="resume-contact-item resume-contact-phone"><a href="tel:+15550100">+1-555-0100</a></span>' in html
    )
    assert (
        '<span class="resume-contact-item resume-contact-email"><a href="mailto:jane@example.com">jane@example.com</a></span>'
        in html
    )
    assert (
        '<span class="resume-contact-item resume-contact-website"><a href="https://janedoe.dev">janedoe.dev</a></span>'
        in html
    )
    assert (
        '<span class="resume-contact-item resume-contact-linkedin"><a href="https://www.linkedin.com/in/janedoe">janedoe</a></span>'
        in html
    )
    assert (
        '<span class="resume-entry-row resume-entry-company-row"><span class="resume-entry-company">Acme</span><span class="resume-entry-location">Remote</span></span>'
        in html
    )
    assert document["experience"][0]["date_range"] == "Mar 2024 - Present"
    assert (
        '<span class="resume-entry-row resume-entry-role-row"><span class="resume-entry-title">Senior SWE</span><span class="resume-entry-date">Mar 2024 - Present</span></span>'
        in html
    )
    assert "Mar 2024 -- Present" not in html
    assert html.index("resume-entry-company-row") < html.index("resume-entry-role-row")
    assert 'data-resume-layout-target="experience:acme_swe:summary"' in html
    assert "Owned the distributed systems mandate." in html
    assert html.index("experience:acme_swe:heading") < html.index("experience:acme_swe:summary")
    assert html.index("experience:acme_swe:summary") < html.index("experience:acme_swe:bullet:1")


def test_resume_preserves_profile_experience_order_and_places_education_degree_below_institution() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"] = [
        {
            "id": "older",
            "date_range": "Jan 2018 - Dec 2020",
            "title": "Older role",
            "company": "Older company",
            "location": "",
            "bullets": ["Older work."],
        },
        {
            "id": "current",
            "date_range": "Mar 2024 - Present",
            "title": "Current role",
            "company": "Current company",
            "location": "",
            "bullets": ["Current work."],
        },
        {
            "id": "recent",
            "date_range": "Jun 2021 - Feb 2024",
            "title": "Recent role",
            "company": "Recent company",
            "location": "",
            "bullets": ["Recent work."],
        },
    ]

    document = build_resume_document({}, profile)
    text = ResumeAssembler().assemble_resume_text({}, profile)
    html = build_resume_html(document)

    assert [entry["id"] for entry in document["experience"]] == ["older", "current", "recent"]
    assert text.index("Older role | Older company") < text.index(
        "Current role | Current company"
    )
    assert text.index("Current role | Current company") < text.index(
        "Recent role | Recent company"
    )
    assert (
        '<span class="resume-entry-row resume-entry-education-row"><span class="resume-entry-main '
        'resume-entry-institution">State | City</span><span class="resume-entry-date">2015</span></span>'
        in html
    )
    assert html.index('data-resume-layout-target="education:edu:subtitle"') < html.index(
        'data-resume-layout-target="education:edu:degree"'
    )
    assert text.index("State | City | 2015") < text.index("BS CS")


def test_build_resume_html_omits_empty_position_summary() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["summary"] = ""

    html = build_resume_html(build_resume_document(_payload(), profile))

    assert 'data-resume-layout-target="experience:acme_swe:summary"' not in html
    assert '<p class="resume-entry-summary"' not in html


def test_build_resume_html_compacts_experience_without_bullets() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["bullets"] = []

    html = build_resume_html(build_resume_document({}, profile))

    assert '<article class="resume-entry resume-entry--no-bullets">' in html
    assert '<ul class="resume-bullets">' not in html
    assert ".resume-entry.resume-entry--no-bullets" in html
    assert ".resume-entry--no-bullets .resume-entry-summary:last-child" in html


def test_position_summary_matches_sanitized_text_and_html_ordering() -> None:
    profile = _profile()
    profile["resume"]["experience_entries"][0]["summary"] = (
        "Owned distributed systems — across regions."
    )
    payload = _payload()

    text = ResumeAssembler().assemble_resume_text(payload, profile)
    document = build_resume_document(payload, profile)
    html = build_resume_html(document)
    sanitized_summary = "Owned distributed systems, across regions."

    assert document["experience"][0]["summary"] == sanitized_summary
    assert sanitized_summary in text
    assert sanitized_summary in html
    assert text.index("Senior SWE | Acme") < text.index("Remote | 2020-Present")
    assert text.index("Remote | 2020-Present") < text.index(sanitized_summary)
    assert text.index(sanitized_summary) < text.index("- Cut latency.")
    assert html.index("experience:acme_swe:heading") < html.index(
        "experience:acme_swe:summary"
    )
    assert html.index("experience:acme_swe:summary") < html.index(
        "experience:acme_swe:bullet:1"
    )


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
            "pageSize": "letter",
            "fontFamily": "garamond",
            "density": "compact",
            "bulletSpacing": "loose",
            "fontScale": 1.1,
            "accentColor": "#123456",
            "marginMm": {"top": 12, "right": 13, "bottom": 14, "left": 15},
            "alignment": "left",
            "headerLayout": "left",
            "sectionHeadingStyle": "boxed",
            "sectionOrder": ["skills", "summary", "experience", "education"],
            "hiddenSections": ["education"],
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
    assert "size: Letter" in html
    assert "width: 8.5in" in html
    assert "min-height: 11in" in html
    assert ".resume-contact-items {\n  justify-content: flex-start;" in html
    assert ".resume-name,\n.resume-contact,\n.resume-address," in html
    assert ".resume-entry-company," in html
    assert ".resume-entry-title," in html
    assert html.index('data-resume-layout-target="section:skills"') < html.index(
        'data-resume-layout-target="section:executive_profile"'
    )
    assert html.index('data-resume-layout-target="section:executive_profile"') < html.index(
        'data-resume-layout-target="section:experience"'
    )
    assert 'data-resume-layout-target="section:education"' not in html
    assert artifact.metadata["resume_template"] == template
    assert artifact.metadata["html_path"] == str(out.with_suffix(".html"))
    assert artifact.metadata["layout_boxes"][0]["semantic_id"] == "section:experience"


def test_default_sans_resume_theme_uses_geist() -> None:
    geist_stack = '"Geist Variable", "Geist", ui-sans-serif, system-ui'
    html = html_resume_pdf.build_resume_html_document("<main>Resume</main>", {"fontFamily": "sans"})

    assert geist_stack in html_resume_pdf.RESUME_HTML_STYLE
    assert geist_stack in html_resume_pdf.resume_theme_css({"fontFamily": "sans"})
    assert html.count("@font-face {") == 2
    assert html.count("data:font/woff2;base64,") == 2
    assert "font-display: block" in html


# ---------------------------------------------------------------------------
# Cross-renderer parity — hard bullet ceiling (submitted PDF == reviewed .txt)
# ---------------------------------------------------------------------------


_OVERFLOW_BULLETS = [
    "Reduced checkout latency across the payments platform.",
    "Led the migration to an event driven ingestion pipeline.",
    "Owned the on call rotation and cut incident volume.",
    "Mentored four engineers through promotion.",
    "Rebuilt the analytics warehouse for faster reporting.",
    "Shipped the customer facing status page.",
]


def _overflow_payload(*, mapped: bool) -> dict:
    """Payload with six bullets and an optional requirement-coverage mapping."""
    payload: dict = {
        "executive_profile": "Tailored summary.",
        "experience_updates": [{"id": "acme_swe", "bullets": list(_OVERFLOW_BULLETS)}],
        "skill_category_updates": [{"id": "languages", "items": ["Python"]}],
    }
    if mapped:
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
    return [bullet["text"] for entry in document["experience"] for bullet in entry["bullets"]]


def test_html_pdf_renderer_preserves_legacy_approved_mandatory_overflow_like_txt() -> None:
    """Render-only refresh never truncates a previously approved mapped payload."""
    profile = _profile()
    payload = _overflow_payload(mapped=True)

    txt_bullets = _txt_experience_bullets(payload, profile)
    assert txt_bullets == _OVERFLOW_BULLETS

    assert _html_experience_bullets(payload, profile) == txt_bullets


def test_html_pdf_renderer_respects_max_experience_bullets_without_mappings() -> None:
    """The same hard cap applies when no generated mappings are present."""
    profile = _profile()
    payload = _overflow_payload(mapped=False)

    txt_bullets = _txt_experience_bullets(payload, profile)
    assert txt_bullets == _OVERFLOW_BULLETS[:4]  # capped at max_experience_bullets

    assert _html_experience_bullets(payload, profile) == txt_bullets
