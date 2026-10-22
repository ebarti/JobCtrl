"""Mechanical default-layout fitting must conserve every approved word."""
from __future__ import annotations

from pathlib import Path

import pytest

from jobctrl.infrastructure.materials import html_resume_pdf as renderer
from .test_pdf_renderer_ports import _profile, _payload


@pytest.mark.parametrize("pages,text", [(1, "Owned text"), (3, "Owned text"), (2, "")])
def test_fit_does_not_try_unneeded_or_unverifiable_layout(monkeypatch, tmp_path, pages, text):
    path = tmp_path / "resume.pdf"
    path.write_bytes(b"original")
    monkeypatch.setattr(renderer, "_pdf_page_text", lambda _path: (pages, text))
    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", lambda *_args: pytest.fail("extra render"))
    html, boxes, decision = renderer._fit_default_resume(
        renderer.build_resume_document(_payload(), _profile()), "original HTML", str(path), [{"original": True}],
    )
    assert (html, boxes) == ("original HTML", [{"original": True}])
    assert path.read_bytes() == b"original" and not decision["compact_attempted"]
    assert decision["page_count"] == pages and decision["selected_density"] == "balanced"


@pytest.mark.parametrize("compact_pages,compact_text,adopt", [
    (1, "Owned complete text", True), (2, "Owned complete text", False), (1, "Owned text", False),
])
def test_fit_adopts_only_complete_single_page_and_matching_html_boxes(
    monkeypatch, tmp_path, compact_pages, compact_text, adopt,
):
    path = tmp_path / "resume.pdf"
    path.write_bytes(b"original")
    signatures = iter([(2, "Owned complete text"), (compact_pages, compact_text)])
    monkeypatch.setattr(renderer, "_pdf_page_text", lambda _path: next(signatures))
    document = renderer.build_resume_document(_payload(), _profile())
    expected_html = renderer.build_resume_html(document, {"density": "compact"})

    def compact(html, output):
        assert html == expected_html
        Path(output).write_bytes(b"compact")
        return [{"compact": True}]

    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", compact)
    html, boxes, decision = renderer._fit_default_resume(
        document, "original HTML", str(path), [{"original": True}],
    )
    assert path.read_bytes() == (b"compact" if adopt else b"original")
    assert html == (expected_html if adopt else "original HTML")
    assert boxes == ([{"compact": True}] if adopt else [{"original": True}])
    assert decision["compact_attempted"] and decision["original_page_count"] == 2
    assert decision["page_count"] == (1 if adopt else 2)
    assert decision["physical_text_preserved"] is (compact_text == "Owned complete text")
    assert list(tmp_path.iterdir()) == [path]


def test_failed_optional_render_preserves_original_bytes_and_cleans_candidate(monkeypatch, tmp_path):
    path = tmp_path / "resume.pdf"
    path.write_bytes(b"original")
    monkeypatch.setattr(renderer, "_pdf_page_text", lambda _path: (2, "Owned text"))

    def fail(_html, output):
        Path(output).write_bytes(b"incomplete")
        raise RuntimeError("synthetic renderer failure")

    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", fail)
    with pytest.raises(RuntimeError, match="synthetic renderer failure"):
        renderer._fit_default_resume(renderer.build_resume_document(_payload(), _profile()),
                                     "original HTML", str(path), [])
    assert path.read_bytes() == b"original" and list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("theme,template", [
    (None, None),
    (None, {"templateId": "custom:owned"}),
    ({}, {"templateId": "built_in:modern-html"}),
    ({"density": "balanced"}, {"templateId": "built_in:modern-html"}),
    ({"fontScale": 1.2}, {"templateId": "built_in:modern-html"}),
])
def test_explicit_template_and_theme_choices_bypass_fit(monkeypatch, tmp_path, theme, template):
    def render(_html, output):
        Path(output).write_bytes(b"owned PDF")
        return []

    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", render)
    monkeypatch.setattr(renderer, "_fit_default_resume", lambda *_args: pytest.fail("custom layout changed"))
    artifact = renderer.HtmlResumePdfAdapter().render_resume_to_pdf(
        tailored_payload=_payload(), profile_dict=_profile(), output_path=str(tmp_path / "resume.pdf"),
        created_at="2026-10-22T00:00:00Z", resume_theme=theme, resume_template=template,
    )
    assert "layout_fit" not in artifact.metadata
    assert (tmp_path / "resume.html").read_text() == renderer.build_resume_html(
        renderer.build_resume_document(_payload(), _profile()), theme,
    )
