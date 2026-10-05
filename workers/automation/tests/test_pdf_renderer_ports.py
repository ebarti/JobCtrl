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

from collections import Counter
import hashlib
from html.parser import HTMLParser
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET

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

    profile["resume"]["tailoring_rules"]["required_experience_entry_ids"] = ["older", "current", "recent"]
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


def test_pdf_adapter_receives_selected_optional_roles_and_mandatory_metadata(monkeypatch, tmp_path) -> None:
    profile = _profile()
    profile["resume"]["experience_entries"].extend([
        {"id": "older", "title": "Engineer", "company": "Mandatory Older Co", "bullets": []},
        {"id": "unselected", "title": "Researcher", "company": "Unselected Lab", "bullets": ["Catalogued samples."]},
    ])
    profile["resume"]["tailoring_rules"]["required_experience_entry_ids"] = ["older"]
    payload = _payload()
    payload["experience_updates"].append({"id": "older", "title": "", "bullets": []})
    captured = []

    def render(html_content, output_path):
        captured.append(html_content)
        Path(output_path).write_bytes(b"%PDF-owned-render-boundary")
        return []

    monkeypatch.setattr(html_resume_pdf, "_render_resume_pdf_playwright", render)
    out = tmp_path / "selected.pdf"
    artifact = HtmlResumePdfAdapter().render_resume_to_pdf(
        tailored_payload=payload, profile_dict=profile, output_path=str(out), created_at="2026-09-13T00:00:00Z",
    )
    assert artifact.path == str(out)
    assert captured == [out.with_suffix(".html").read_text()]
    assert "Acme" in captured[0] and "Cut latency." in captured[0]
    assert "Mandatory Older Co" in captured[0] and "Unselected Lab" not in captured[0]


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


# ---------------------------------------------------------------------------
# #907: bounded, opt-in measurement of the real HTML/CSS/Chromium product path.
# Ordinary port tests need no browser. The explicit trial invocation MUST set
# JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1; missing prerequisites fail, never skip.
# ---------------------------------------------------------------------------


_PAGINATION_MARKER = re.compile(r"R907M\d{5}")
_PAGINATION_CASES = ("dense", "boundary-below", "boundary-above", "oversized")
_PAGINATION_GEOMETRY_TOLERANCE_PT = 0.25
_PAGINATION_BOX_TOLERANCE_PT = 2.0


def _pagination_normalize(text: str) -> str:
    # Ignore line wrapping/whitespace and CSS heading capitalization, not words.
    return re.sub(r"\s+", "", text).casefold()


def _pagination_profile(case: str, *, boundary_bullets: int = 1) -> tuple[dict, list[str]]:
    """Only invented facts; mark every field and every oversized-bullet segment."""
    markers: list[str] = []

    def marked(text: str) -> str:
        marker = f"R907M{len(markers) + 1:05d}"
        markers.append(marker)
        return f"{marker} {text}"

    profile = {
        "personal": {"full_name": marked("Synthetic Pagination Candidate")},
        "resume": {
            "executive_profile": {"baseline_text": marked("Measured invented systems in a synthetic QA workspace.")},
            "experience_entries": [],
            "education_entries": [],
            "skill_categories": [],
            "tailoring_rules": {"max_experience_bullets": 96,
                                "tailoring_policy": {"allow_summary_rewrite": False}},
        },
    }
    resume = profile["resume"]
    for role_index in range(6 if case == "dense" else 1):
        role = {
            "id": f"trial-role-{role_index}",
            "company": marked(f"Invented Laboratory {role_index}"),
            "title": marked("Synthetic Systems Engineer"),
            "location": "QA City",
            "date_range": "2020 -- 2024",
            "summary": marked("Owned only invented experiments and deterministic test records."),
            "bullets": [],
        }
        if case == "oversized":
            # One li is taller than a page; break-inside: avoid cannot keep it whole.
            role["bullets"] = [" ".join(
                marked("Recorded an invented experiment with synthetic inputs, explicit checkpoints and repeatable outcomes.")
                for _ in range(96)
            )]
        elif case == "dense":
            role["bullets"] = [
                marked("Measured invented queues with wrapped explanatory text, synthetic evidence, repeatable checkpoints "
                       "and a deliberately verbose description of an imaginary outcome.")
                for _ in range(8)
            ]
        else:
            role["bullets"] = [marked("Recorded synthetic boundary evidence.") for _ in range(boundary_bullets)]
        resume["experience_entries"].append(role)
    resume["education_entries"] = [{
        "id": "trial-education",
        "institution": marked("Invented QA Institute"),
        "degree": marked("Synthetic Computing Degree"),
        "details": marked("Studied deterministic examples and imaginary systems."),
        "location": "QA City",
        "date": "2019",
    }]
    resume["skill_categories"] = [{
        "id": "trial-skills",
        "label": marked("Synthetic Tools"),
        "items": [marked("Invented Queue"), marked("X" * 144)],
    }]
    return profile, markers


def _pagination_theme(page_size: str) -> dict:
    return {
        "pageSize": page_size,
        "fontFamily": "sans",  # bundled Geist, no host-font/network dependency
        "fontScale": 1.0,
        "density": "balanced",
        "bulletSpacing": "normal",
        "alignment": "left",
        "headerLayout": "centered",
        "sectionHeadingStyle": "rule",
        "sectionOrder": ["summary", "experience", "education", "skills"],
        "hiddenSections": [],
        "marginMm": {"top": 16.5, "right": 17.5, "bottom": 18, "left": 17.5},
        "accentColor": "#111111",
    }


class _PaginationTargets(HTMLParser):
    """Read target text from saved HTML, independently of the DOM box calculation."""

    def __init__(self, source: str) -> None:
        super().__init__()
        self.targets: list[dict] = []
        self.active: dict | None = None
        self.depth = 0
        self.feed(source)
        self.close()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if "data-resume-layout-target" in attributes:
            assert self.active is None, "nested layout targets need explicit measurement support"
            self.active = {"semantic_id": attributes["data-resume-layout-target"], "parts": []}
            self.depth = 1
        elif self.active is not None and tag not in {"br", "hr", "img", "input", "meta", "link"}:
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if self.active is None:
            return
        self.depth -= 1
        if self.depth == 0:
            self.targets.append({
                "semantic_id": self.active["semantic_id"],
                "text": " ".join(self.active["parts"]),
            })
            self.active = None

    def handle_data(self, data: str) -> None:
        if self.active is not None:
            self.active["parts"].append(data)


@pytest.fixture(scope="module")
def pagination_environment() -> dict:
    if not any(os.environ.get(flag) == "1" for flag in (
        "JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS", "JOBCTRL_RUN_PAGINATION_TRIAL",
    )):
        pytest.skip("explicit real-render trial: set JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1 (see catalog #907)")
    from playwright.sync_api import sync_playwright
    tools = {name: shutil.which(name) for name in ("pdftotext", "pdftoppm")}
    assert all(tools.values()), "pagination trial requires Poppler pdftotext and pdftoppm; no skipped cases"
    tool_versions = {}
    for name, executable in tools.items():
        result = subprocess.run([executable, "-v"], capture_output=True, text=True, check=True, timeout=10)
        tool_versions[name] = (result.stdout + result.stderr).splitlines()[0]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()  # same bundled browser selection as the product
        try:
            page = browser.new_page(viewport=html_resume_pdf.RESUME_PAGE_VIEWPORT)
            page.set_content(html_resume_pdf.build_resume_html_document("<main>Geist QA</main>", {"fontFamily": "sans"}))
            page.evaluate("() => document.fonts.ready")
            font_faces = page.evaluate("() => Array.from(document.fonts, f => ({family: f.family, status: f.status}))")
            assert any("Geist" in face["family"] and face["status"] == "loaded" for face in font_faces)
            browser_version = browser.version
        finally:
            browser.close()
    automation_root = Path(__file__).resolve().parents[1]
    font_root = automation_root / "src/jobctrl/assets/fonts"
    return {
        "tools": tools,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "dependencies": {name: version(name) for name in ("playwright", "pypdf", "pytest")},
        "chromium": browser_version,
        "chromium_launch": "product defaults: bundled headless Chromium, no channel or executable override",
        "poppler": tool_versions,
        "font_faces": font_faces,
        "font_sha256": {name: hashlib.sha256((font_root / name).read_bytes()).hexdigest()
                        for name, _ in html_resume_pdf.GEIST_FONT_RESOURCES},
        "uv_lock_sha256": hashlib.sha256((automation_root / "uv.lock").read_bytes()).hexdigest(),
        "viewport": html_resume_pdf.RESUME_PAGE_VIEWPORT,
    }


def _pagination_pdf_observation(pdf: Path, environment: dict) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(pdf)
    dimensions = [[float(page.mediabox.width), float(page.mediabox.height)] for page in reader.pages]
    crop_boxes = [[float(value) for value in page.cropbox] for page in reader.pages]
    normalized_pages = [_pagination_normalize(page.extract_text()) for page in reader.pages]
    bbox_file = pdf.with_suffix(".bbox.html")
    subprocess.run([environment["tools"]["pdftotext"], "-bbox", str(pdf), str(bbox_file)],
                   check=True, capture_output=True, timeout=30)
    words: list[dict] = []
    # Poppler bbox uses top-left points, already the origin needed by layout_pct.
    for page_number, node in enumerate(ET.parse(bbox_file).getroot().iter("{http://www.w3.org/1999/xhtml}page"), 1):
        for word in node.iter("{http://www.w3.org/1999/xhtml}word"):
            words.append({
                "page": page_number,
                "text": word.text or "",
                "rect_pt": [float(word.attrib[key]) for key in ("xMin", "yMin", "xMax", "yMax")],
            })
    assert words, "independent PDF geometry extraction produced no words"
    image_prefix = pdf.with_suffix("")
    subprocess.run([environment["tools"]["pdftoppm"], "-png", "-r", "110", str(pdf), str(image_prefix)],
                   check=True, capture_output=True, timeout=60)
    images = sorted(pdf.parent.glob(f"{pdf.stem}-*.png"))
    assert len(images) == len(reader.pages), "every physical PDF page needs a visual inspection image"
    clipped = []
    overlaps = []
    for index, word in enumerate(words):
        x0, y0, x1, y1 = word["rect_pt"]
        width, height = dimensions[word["page"] - 1]
        if x0 < -1 or y0 < -1 or x1 > width + 1 or y1 > height + 1:
            clipped.append(word)
        # Bounding boxes can overlap without painted glyphs overlapping: candidates
        # need visual confirmation, and are not encoded as a renderer invariant.
        for other in reversed(words[:index]):
            if other["page"] != word["page"]:
                break
            a0, b0, a1, b1 = other["rect_pt"]
            if min(x1, a1) - max(x0, a0) > 1 and min(y1, b1) - max(y0, b0) > 1:
                overlaps.append({"first": other, "second": word})
    markers_by_page = []
    for page in reader.pages:
        markers_by_page.append(_PAGINATION_MARKER.findall(re.sub(r"\s+", "", page.extract_text())))
    return {
        "page_count": len(reader.pages),
        "dimensions_pt": dimensions,
        "crop_boxes_pt": crop_boxes,
        "rotations": [page.rotation for page in reader.pages],
        "normalized_pages": normalized_pages,
        "words": words,
        "markers_by_page": markers_by_page,
        "page_breaks": [{"page": index + 1, "first": markers[0] if markers else None,
                         "last": markers[-1] if markers else None, "marker_count": len(markers)}
                        for index, markers in enumerate(markers_by_page)],
        "blank_pages": [index + 1 for index, text in enumerate(normalized_pages) if not text],
        "outside_page_candidates": clipped,
        "overlap_candidates": overlaps,
        "page_images": [path.name for path in images],
        "visual_inspection": "pending independent inspection of every page image",
    }


def _pagination_correspondence(targets: list[dict], boxes: list[dict], observation: dict) -> dict:
    words = observation["words"]
    word_ranges = []
    cursor = 0
    for word in words:
        end = cursor + len(_pagination_normalize(word["text"]))
        word_ranges.append((cursor, end, word))
        cursor = end
    pdf_text = "".join(_pagination_normalize(word["text"]) for word in words)
    by_id = {box["semantic_id"]: box for box in boxes}
    results = []
    for target in targets:
        text = _pagination_normalize(target["text"])
        start = pdf_text.find(text)
        selected = [word for left, right, word in word_ranges if start >= 0 and left < start + len(text) and right > start]
        fragments = []
        for page_number in sorted({word["page"] for word in selected}):
            rects = [word["rect_pt"] for word in selected if word["page"] == page_number]
            fragments.append({"page": page_number, "rect_pt": [min(r[0] for r in rects), min(r[1] for r in rects),
                                                                   max(r[2] for r in rects), max(r[3] for r in rects)]})
        box = by_id.get(target["semantic_id"])
        errors = []
        predicted = None
        escape = None
        if not selected:
            errors.append("pdf_target_not_located")
        if box is None:
            errors.append("missing_layout_target")
        elif not 1 <= box["page_number"] <= observation["page_count"]:
            errors.append("layout_page_out_of_range")
        else:
            width, height = observation["dimensions_pt"][box["page_number"] - 1]
            predicted = [box["left_pct"] * width / 100, box["top_pct"] * height / 100,
                         (box["left_pct"] + box["width_pct"]) * width / 100,
                         (box["top_pct"] + box["height_pct"]) * height / 100]
            if fragments and [fragment["page"] for fragment in fragments] != [box["page_number"]]:
                errors.append("physical_page_or_fragment_mismatch")
            elif fragments:
                x0, y0, x1, y1 = fragments[0]["rect_pt"]
                escape = max(0, predicted[0] - x0, predicted[1] - y0, x1 - predicted[2], y1 - predicted[3])
                if escape > _PAGINATION_BOX_TOLERANCE_PT:
                    errors.append("pdf_text_outside_layout_box")
        results.append({"semantic_id": target["semantic_id"], "pdf_fragments": fragments,
                        "layout_box": box, "layout_rect_pt": predicted, "escape_pt": escape, "errors": errors})
    orphan_headings = []
    for current, following in zip(results, results[1:]):
        if (current["semantic_id"].startswith("section:") or current["semantic_id"].endswith(":heading")):
            pages = [fragment["page"] for fragment in current["pdf_fragments"]]
            next_pages = [fragment["page"] for fragment in following["pdf_fragments"]]
            if pages and next_pages and max(pages) < min(next_pages):
                orphan_headings.append({"heading": current["semantic_id"], "pages": pages, "following_pages": next_pages})
    return {"targets": results,
            "extra_layout_targets": sorted(set(by_id) - {target["semantic_id"] for target in targets}),
            "duplicate_layout_targets": [key for key, count in Counter(box["semantic_id"] for box in boxes).items()
                                         if count > 1],
            # An extraction gap has no independently observed rectangle/page.
            # Keep it visible without declaring a physical mismatch from [] != [1].
            "unlocated_pdf_targets": [result["semantic_id"] for result in results if not result["pdf_fragments"]],
            "mismatch_count": sum(any(error != "pdf_target_not_located" for error in result["errors"])
                                  for result in results),
            "orphan_heading_candidates": orphan_headings}


def _pagination_repeat_comparison(baseline: dict, current: dict) -> dict:
    first = baseline["words"]
    second = current["words"]
    same_words = [(word["page"], word["text"]) for word in first] == [(word["page"], word["text"]) for word in second]
    delta = max((abs(a - b) for left, right in zip(first, second)
                 for a, b in zip(left["rect_pt"], right["rect_pt"])), default=0.0) if same_words else None
    return {
        "same_page_count": baseline["page_count"] == current["page_count"],
        "same_normalized_pages": baseline["normalized_pages"] == current["normalized_pages"],
        "same_marker_pages": baseline["markers_by_page"] == current["markers_by_page"],
        "same_word_sequence": same_words,
        "max_geometry_delta_pt": delta,
        "geometry_within_tolerance": delta is not None and delta <= _PAGINATION_GEOMETRY_TOLERANCE_PT,
    }


@pytest.fixture(scope="module")
def pagination_boundaries(pagination_environment: dict, tmp_path_factory: pytest.TempPathFactory) -> dict:
    from pypdf import PdfReader

    root = tmp_path_factory.mktemp("pagination-boundaries")
    boundaries = {}
    for page_size in ("a4", "letter"):
        probes = []

        def page_count(count: int) -> int:
            profile, _ = _pagination_profile("boundary-below", boundary_bullets=count)
            source = build_resume_html(build_resume_document({}, profile), _pagination_theme(page_size))
            pdf = root / f"{page_size}-{count}.pdf"
            html_resume_pdf.render_resume_html_to_pdf(source, str(pdf))
            pages = len(PdfReader(pdf).pages)
            probes.append({"bullets": count, "pages": pages, "pdf": pdf.name})
            return pages

        low, high = 1, 96
        assert page_count(low) == 1 and page_count(high) > 1, "synthetic boundary search must bracket a physical break"
        while high - low > 1:
            middle = (low + high) // 2
            if page_count(middle) == 1:
                low = middle
            else:
                high = middle
        boundaries[page_size] = {"below": low, "above": high, "probes": probes}
        (root / "boundaries.json").write_text(json.dumps(boundaries, indent=2), encoding="utf-8")
    return boundaries


@pytest.mark.parametrize("page_size", ("a4", "letter"))
@pytest.mark.parametrize("case", _PAGINATION_CASES)
def test_dense_resume_pagination_trial(
    case: str,
    page_size: str,
    pagination_environment: dict,
    pagination_boundaries: dict,
    tmp_path: Path,
) -> None:
    """Measure three independent renders per entry point, saving evidence before assertions."""
    boundary = pagination_boundaries[page_size]
    count = boundary["above"] if case == "boundary-above" else boundary["below"]
    profile, expected_markers = _pagination_profile(case, boundary_bullets=count)
    theme = _pagination_theme(page_size)
    source = build_resume_html(build_resume_document({}, profile), theme)
    targets = _PaginationTargets(source).targets
    report = {
        "issue": 907, "case": case, "theme": theme, "environment": pagination_environment,
        "boundary": boundary, "expected_markers": expected_markers,
        "geometry_tolerance_pt": _PAGINATION_GEOMETRY_TOLERANCE_PT,
        "layout_containment_tolerance_pt": _PAGINATION_BOX_TOLERANCE_PT,
        "renders": [], "repeatability": [],
    }
    for repeat in range(1, 4):
        repeat_dir = tmp_path / f"repeat-{repeat}"
        repeat_dir.mkdir()
        for entry_point in ("adapter", "shared"):
            pdf = repeat_dir / f"{entry_point}.pdf"
            if entry_point == "adapter":
                artifact = HtmlResumePdfAdapter().render_resume_to_pdf(
                    tailored_payload={}, profile_dict=profile, output_path=str(pdf),
                    created_at="2026-10-03T00:00:00Z", resume_theme=theme,
                )
                boxes = artifact.metadata["layout_boxes"]
                assert pdf.with_suffix(".html").read_text(encoding="utf-8") == source
            else:
                pdf.with_suffix(".html").write_text(source, encoding="utf-8")
                boxes = html_resume_pdf.render_resume_html_to_pdf(source, str(pdf))
            observation = _pagination_pdf_observation(pdf, pagination_environment)
            observation["layout_correspondence"] = _pagination_correspondence(targets, boxes, observation)
            observation["repeat"] = repeat
            observation["entry_point"] = entry_point
            observation["pdf"] = str(pdf.relative_to(tmp_path))
            actual_markers = [marker for page in observation["markers_by_page"] for marker in page]
            observation["reading_order_matches"] = actual_markers == expected_markers
            observation["missing_markers"] = sorted(set(expected_markers) - set(actual_markers))
            observation["duplicate_markers"] = [marker for marker, n in Counter(actual_markers).items() if n > 1]
            all_text = "".join(observation["normalized_pages"])
            observation["missing_content_targets"] = [target["semantic_id"] for target in targets
                                                      if _pagination_normalize(target["text"]) not in all_text]
            report["renders"].append(observation)
            (tmp_path / "measurements.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    baseline = report["renders"][0]
    report["repeatability"] = [_pagination_repeat_comparison(baseline, render) for render in report["renders"][1:]]
    (tmp_path / "measurements.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    # These protect actual content/order and the trial's coverage, not the known
    # pre-pagination DOM approximation. Its mismatches stay explicit evidence.
    assert len(report["renders"]) == 6
    expected_dimensions = (612, 792) if page_size == "letter" else (210 / 25.4 * 72, 297 / 25.4 * 72)
    for render in report["renders"]:
        assert not render["missing_content_targets"], render["missing_content_targets"]
        assert render["reading_order_matches"], {key: render[key] for key in ("missing_markers", "duplicate_markers")}
        assert not render["blank_pages"], render["blank_pages"]
        assert all(abs(actual - expected) <= 1 for dims in render["dimensions_pt"]
                   for actual, expected in zip(dims, expected_dimensions))
        if case.startswith("boundary-"):
            assert render["page_count"] == (1 if case == "boundary-below" else 2)
        else:
            assert render["page_count"] >= 2, "dense and oversized fixtures must actually paginate"
        if case == "oversized":
            bullet = next(target for target in render["layout_correspondence"]["targets"]
                          if target["semantic_id"] == "experience:trial-role-0:bullet:1")
            assert len(bullet["pdf_fragments"]) >= 2, "one oversized bullet must fragment across physical pages"
    assert all(all(value is True for key, value in result.items() if key != "max_geometry_delta_pt")
               for result in report["repeatability"]), report["repeatability"]
