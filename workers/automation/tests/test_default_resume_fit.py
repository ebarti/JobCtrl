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


@pytest.mark.parametrize("resume_theme", [None, {
    "fontFamily": "serif", "fontScale": 1.1, "headerLayout": "left",
    "marginMm": {"top": 18, "right": 19, "bottom": 20, "left": 21},
    "sectionOrder": ["experience", "summary", "skills", "education"],
}])
@pytest.mark.parametrize("compact_pages,compact_text,adopt", [
    (1, "Owned complete text", True), (2, "Owned complete text", False), (1, "Owned text", False),
])
def test_fit_adopts_only_complete_single_page_and_matching_html_boxes(
    monkeypatch, tmp_path, compact_pages, compact_text, adopt, resume_theme,
):
    path = tmp_path / "resume.pdf"
    path.write_bytes(b"original")
    signatures = iter([(2, "Owned complete text"), (compact_pages, compact_text)])
    monkeypatch.setattr(renderer, "_pdf_page_text", lambda _path: next(signatures))
    document = renderer.build_resume_document(_payload(), _profile())
    expected_html = renderer.build_resume_html(document, {**(resume_theme or {}), "density": "compact"})

    def compact(html, output):
        assert html == expected_html
        Path(output).write_bytes(b"compact")
        return [{"compact": True}]

    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", compact)
    html, boxes, decision = renderer._fit_default_resume(
        document, "original HTML", str(path), [{"original": True}], resume_theme=resume_theme,
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
    (None, {"templateId": "built_in:modern-html", "assignmentSource": "profile_default"}),
    (None, {"templateId": "built_in:modern-html", "assignmentSource": "job_override"}),
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


@pytest.mark.parametrize("assignment", ["built_in", "profile_default", "job_override"])
def test_saved_template_resolution_admits_only_the_unassigned_builtin(monkeypatch, tmp_path, assignment):
    from jobctrl.database import init_db
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository

    job_id = JobId("00000000-0000-4000-8000-000000000052")
    conn = init_db(tmp_path / "owned.db")
    try:
        conn.execute("INSERT INTO jobs (tenant_id, job_id, url, title, site) VALUES (?, ?, ?, ?, ?)",
                     (str(LOCAL_TENANT), str(job_id), "https://example.test/layout", "Engineer", "Owned"))
        if assignment == "profile_default":
            conn.execute("INSERT INTO resume_template_defaults (tenant_id, profile_id, template_id, version_id, updated_at) VALUES (?, 'default', 'built_in:modern-html', 'built_in:modern-html:v1', ?)",
                         (str(LOCAL_TENANT), "2026-10-22T00:00:00Z"))
        elif assignment == "job_override":
            conn.execute("INSERT INTO job_resume_template_assignments (tenant_id, job_id, template_id, version_id, updated_at) VALUES (?, ?, 'built_in:modern-html', 'built_in:modern-html:v1', ?)",
                         (str(LOCAL_TENANT), str(job_id), "2026-10-22T00:00:00Z"))
        conn.commit()
        resolved = SqliteMaterialsRepository(conn).resolve_effective_resume_template(LOCAL_TENANT, job_id)
    finally:
        conn.close()
    assert resolved["metadata"]["assignmentSource"] == assignment
    assert resolved["theme"] and resolved["theme"]["density"] == "balanced"
    admitted = []

    def render(_html, output):
        Path(output).write_bytes(b"owned PDF")
        return []

    def fit(document, html, output, boxes, *, resume_theme=None):
        admitted.append(resume_theme)
        return html, boxes, {"policy": "default-single-page-v1"}

    monkeypatch.setattr(renderer, "_render_resume_pdf_playwright", render)
    monkeypatch.setattr(renderer, "_fit_default_resume", fit)
    artifact = renderer.HtmlResumePdfAdapter().render_resume_to_pdf(
        tailored_payload=_payload(), profile_dict=_profile(), output_path=str(tmp_path / "resume.pdf"),
        created_at="2026-10-22T00:00:00Z", resume_template=resolved["metadata"], resume_theme=resolved["theme"],
    )
    assert admitted == ([resolved["theme"]] if assignment == "built_in" else [])
    assert ("layout_fit" in artifact.metadata) is (assignment == "built_in")
