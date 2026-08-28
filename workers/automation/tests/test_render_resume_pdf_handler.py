"""The render_resume_pdf sync RPC handler used by the TS API's PDF seam."""

from __future__ import annotations

import pytest

from jobctrl.infrastructure.rpc import handlers
from jobctrl.infrastructure.rpc.server import _RpcParamError


def test_renders_html_file_via_the_playwright_adapter(tmp_path, monkeypatch):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "jobctrl.infrastructure.materials.html_resume_pdf.render_resume_html_to_pdf",
        lambda html, pdf_path: calls.append((html, pdf_path)),
    )
    html_path = tmp_path / "resume.html"
    html_path.write_text("<main>resume</main>", encoding="utf-8")
    pdf_path = str(tmp_path / "resume.pdf")

    result = handlers.render_resume_pdf({"htmlPath": str(html_path), "pdfPath": pdf_path})

    assert result == {"status": "succeeded", "pdfPath": pdf_path}
    assert calls == [("<main>resume</main>", pdf_path)]


def test_rejects_missing_html_file(tmp_path):
    with pytest.raises(_RpcParamError):
        handlers.render_resume_pdf(
            {"htmlPath": str(tmp_path / "absent.html"), "pdfPath": str(tmp_path / "out.pdf")}
        )


def test_rejects_empty_pdf_path(tmp_path):
    html_path = tmp_path / "resume.html"
    html_path.write_text("x", encoding="utf-8")
    with pytest.raises(_RpcParamError):
        handlers.render_resume_pdf({"htmlPath": str(html_path), "pdfPath": "  "})
