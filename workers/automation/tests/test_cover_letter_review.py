"""Synthetic structural/identity checks; no provider or real profile data."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.apply.cover_letter_binding import cover_letter_approval_current
from jobctrl.domain.materials.cover_letter_settings import DEFAULT_SETTINGS, RENDERER_VERSION, validate_settings
from jobctrl.infrastructure.materials.playwright_html_pdf import _build_letter_html
from jobctrl.infrastructure.rpc.handlers import render_cover_letter_pdf


def review_paths(tmp_path, monkeypatch):
    from jobctrl import config
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    directory = tmp_path / "generated" / "cover-letter-previews" / "00000000-0000-4000-8000-000000001042"
    directory.mkdir(parents=True)
    return directory / "source.txt", directory / "letter.pdf"


@pytest.mark.parametrize("settings", [
    {**DEFAULT_SETTINGS, "paper": "A4", "fontSizePt": 9, "marginMm": 8, "lineHeight": 1, "paragraphSpacingPx": 0},
    {**DEFAULT_SETTINGS, "paper": "Letter", "fontFamily": "arial", "fontSizePt": 14, "marginMm": 28, "lineHeight": 2, "paragraphSpacingPx": 24},
    DEFAULT_SETTINGS,
])
def test_full_escaped_letter_and_bounded_settings(settings):
    text = "<script>alert('synthetic')</script>\r\n\r\n" + "Full letter.\n\n" * 1000 + "FINAL LINE"
    html = _build_letter_html(text, settings)
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "FINAL LINE" in html
    assert html.count("Full letter.") == 1000
    assert f"size: {settings['paper']}" in html
    assert f"margin: {settings['marginMm']}mm" in html
    assert f"font-size: {settings['fontSizePt']}pt" in html
    assert f"line-height: {settings['lineHeight']}" in html
    assert f"margin: 0 0 {settings['paragraphSpacingPx']}px" in html


@pytest.mark.parametrize("key,value", [
    ("fontSizePt", 8), ("fontSizePt", 15), ("marginMm", 7.99), ("marginMm", 28.01),
    ("lineHeight", float("inf")), ("lineHeight", float("nan")), ("lineHeight", True),
    ("paragraphSpacingPx", -1), ("paragraphSpacingPx", 25),
    ("fontFamily", "Georgia; color:red"), ("fontFamily", []), ("paper", "A3"),
    ("marginMm", "8mm"), ("extra", "arbitrary-css"),
])
def test_invalid_settings_have_no_css_fallback(key, value):
    with pytest.raises(ValueError):
        validate_settings({**DEFAULT_SETTINGS, key: value})


def test_registered_handler_reads_exact_snapshot_and_checks_hash(tmp_path, monkeypatch):
    from jobctrl.infrastructure.materials import playwright_html_pdf

    source, output = review_paths(tmp_path, monkeypatch)
    source.write_text("Synthetic\n\n" * 500 + "END")
    calls = []
    def render(text, output, settings, **kwargs):
        from pypdf import PdfWriter
        calls.append((text, output, settings))
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.write(output)
    monkeypatch.setattr(playwright_html_pdf, "convert_cover_letter_text_to_pdf", render)
    params = {"sourcePath": str(source), "pdfPath": str(output),
              "textSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "settings": DEFAULT_SETTINGS, "rendererVersion": RENDERER_VERSION}
    assert render_cover_letter_pdf(params)["status"] == "succeeded"
    assert calls[0][0] == source.read_text()
    source.write_text("Same-generation replacement")
    with pytest.raises(Exception, match="source or settings invalid"):
        render_cover_letter_pdf(params)
    assert len(calls) == 1


def test_handler_rejects_structurally_corrupt_pdf_output(tmp_path, monkeypatch):
    source, output = review_paths(tmp_path, monkeypatch)
    source.write_text("Owned synthetic letter")
    def corrupt(*args, **kwargs):
        output.write_bytes(b"%PDF-1.4\nnot a PDF object graph\n%%EOF")
    monkeypatch.setattr("jobctrl.infrastructure.materials.playwright_html_pdf.convert_cover_letter_text_to_pdf", corrupt)
    with pytest.raises(Exception):
        render_cover_letter_pdf({"sourcePath":str(source),"pdfPath":str(output),
                                 "textSha256":hashlib.sha256(source.read_bytes()).hexdigest(),
                                 "settings":DEFAULT_SETTINGS,"rendererVersion":RENDERER_VERSION})


@pytest.mark.parametrize("settings", [None, [], "default", 0])
def test_registered_rpc_requires_settings_object_without_default_fallback(tmp_path, monkeypatch, settings):
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from tests.rpc_contract_probe import build_server

    source, output = review_paths(tmp_path, monkeypatch)
    source.write_text("Owned synthetic letter")
    calls = []
    monkeypatch.setattr("jobctrl.infrastructure.materials.playwright_html_pdf.convert_cover_letter_text_to_pdf",
                        lambda *args, **kwargs: calls.append(args))
    response = build_server().dispatch(JsonRpcRequest(method="render_cover_letter_pdf", id=1042, params={
        "sourcePath":str(source),"pdfPath":str(output),"textSha256":hashlib.sha256(source.read_bytes()).hexdigest(),
        "settings":settings,"rendererVersion":RENDERER_VERSION,
    }))
    assert response.error.code == -32602
    assert calls == [] and not output.exists()
    assert validate_settings() == DEFAULT_SETTINGS  # Existing internal optional default remains.


@pytest.mark.parametrize("target", ["directory", "source", "output", "traversal", "outside", "hardlink", "existing-output"])
def test_rpc_rejects_unowned_paths_before_renderer(tmp_path, tmp_path_factory, monkeypatch, target):
    source, output = review_paths(tmp_path, monkeypatch)
    source.write_text("Owned synthetic source")
    outside = tmp_path_factory.mktemp("cover-outside")
    external = outside / "external.txt"
    external.write_text("Owned synthetic source")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    calls = []
    monkeypatch.setattr("jobctrl.infrastructure.materials.playwright_html_pdf.convert_cover_letter_text_to_pdf",
                        lambda *args, **kwargs: calls.append(args))
    if target == "directory":
        source.parent.rename(outside / "attempt")
        source.parent.symlink_to(outside / "attempt", target_is_directory=True)
    elif target == "source":
        source.unlink()
        source.symlink_to(external)
    elif target == "output":
        output.symlink_to(external)
    elif target == "hardlink":
        source.unlink()
        source.hardlink_to(external)
    elif target == "existing-output":
        output.write_text("Existing owned output must not be overwritten")
    elif target == "outside":
        source = external
    else:
        source = source.parent / ".." / ".." / ".." / ".." / "outside.txt"
    with pytest.raises(Exception, match="source or settings invalid"):
        render_cover_letter_pdf({"sourcePath":str(source),"pdfPath":str(output),"textSha256":digest,
                                 "settings":DEFAULT_SETTINGS,"rendererVersion":RENDERER_VERSION})
    assert calls == []
    assert external.read_text() == "Owned synthetic source"
    if target == "existing-output":
        assert output.read_text() == "Existing owned output must not be overwritten"


def test_default_renderer_persists_hashes_and_approval_requires_them(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from pypdf import PdfWriter
    from jobctrl.domain.materials.use_cases import _pdf_with_accepted_source
    from jobctrl.infrastructure.materials.playwright_html_pdf import PlaywrightHtmlPdfAdapter

    def render(_html, output, **kwargs):
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.write(output)
    monkeypatch.setattr("jobctrl.infrastructure.materials.playwright_html_pdf._render_pdf_playwright", render)
    text = tmp_path / "source.txt"
    text.write_bytes(("Owned long Unicode résumé & <literal>\r\n\r\n" * 200).encode("utf-8"))
    pdf = PlaywrightHtmlPdfAdapter().render_cover_letter_to_pdf(cover_letter_text=text.read_bytes().decode("utf-8"),output_path=str(tmp_path/"default.pdf"),created_at="now")
    pdf = _pdf_with_accepted_source(pdf, SimpleNamespace(artifact_id="text",metadata={}),1)
    assert pdf.metadata["cover_letter_text_sha256"] == hashlib.sha256(text.read_bytes()).hexdigest()
    assert pdf.metadata["cover_letter_pdf_sha256"] == hashlib.sha256(Path(pdf.path).read_bytes()).hexdigest()
    conn = sqlite3.connect(tmp_path / "owned.db")
    conn.executescript("""
      CREATE TABLE job_materials_artifacts (tenant_id,job_id,artifact_type,artifact_id,path,metadata_json,status,superseded_at,generation,created_at);
      CREATE TABLE job_events (tenant_id,job_id,event_type,payload_json,event_id);
    """)
    source = {"tenantId":"local","jobId":"qa","artifactId":"text","generation":1,"textSha256":pdf.metadata["cover_letter_text_sha256"]}
    binding = {"source":source,"pdfArtifactId":pdf.artifact_id,"pdfSha256":pdf.metadata["cover_letter_pdf_sha256"],"settings":DEFAULT_SETTINGS,"rendererVersion":RENDERER_VERSION}
    for kind, aid, file, meta in [("cover_letter","text",text,{}),("cover_letter_pdf",pdf.artifact_id,pdf.path,pdf.metadata)]:
        conn.execute("INSERT INTO job_materials_artifacts VALUES ('local','qa',?,?,?,?, 'approved',NULL,1,'now')",(kind,aid,str(file),json.dumps(meta)))
    def decision():
        conn.execute("DELETE FROM job_events")
        conn.execute("INSERT INTO job_events VALUES ('local','qa','ApplyReviewDecisionRecorded',?,1)",(json.dumps({"decisionId":"decision","coverLetterBinding":binding}),))
        conn.commit()
    decision()
    assert cover_letter_approval_current(conn,"local","qa","decision")
    original = text.read_bytes()
    text.write_text("Same-generation replacement")
    binding["source"]["textSha256"] = hashlib.sha256(text.read_bytes()).hexdigest()
    decision()
    assert not cover_letter_approval_current(conn,"local","qa","decision")
    text.write_bytes(original)
    binding["source"]["textSha256"] = hashlib.sha256(original).hexdigest()
    Path(pdf.path).write_bytes(b"%PDF-1.4\ncorrupt but marker-preserving replacement\n%%EOF")
    binding["pdfSha256"] = hashlib.sha256(Path(pdf.path).read_bytes()).hexdigest()
    decision()
    assert not cover_letter_approval_current(conn,"local","qa","decision")
    conn.execute("UPDATE job_materials_artifacts SET metadata_json='{}' WHERE artifact_type='cover_letter_pdf'")
    assert not cover_letter_approval_current(conn,"local","qa","decision")
    conn.close()


def test_chromium_uses_css_paper_size(monkeypatch, tmp_path):
    from jobctrl.infrastructure.materials.playwright_html_pdf import _render_pdf_playwright

    class Fake:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        chromium = property(lambda self: self)
        def launch(self): return self
        def new_page(self): return self
        def set_content(self, *args, **kwargs): pass
        def pdf(self, **kwargs):
            assert kwargs["prefer_css_page_size"] is True
            assert kwargs["margin"] == {"top": "0", "right": "0", "bottom": "0", "left": "0"}
            assert "path" not in kwargs
            return b"%PDF-1.4\nsynthetic\n%%EOF"
        def close(self): pass

    monkeypatch.setattr("playwright.sync_api.sync_playwright", Fake)
    _render_pdf_playwright(_build_letter_html("Synthetic", {**DEFAULT_SETTINGS, "paper": "A4"}), str(tmp_path / "out.pdf"))


def test_apply_binding_detects_source_pdf_settings_and_tenant_drift(tmp_path: Path):
    conn = sqlite3.connect(tmp_path / "owned.db")
    conn.executescript("""
      CREATE TABLE job_materials_artifacts (tenant_id,job_id,artifact_type,artifact_id,path,metadata_json,status,superseded_at,generation,created_at);
      CREATE TABLE job_events (tenant_id,job_id,event_type,payload_json,event_id);
    """)
    text = tmp_path / "text.txt"
    text.write_text("Synthetic accepted letter")
    pdf = tmp_path / "cover.pdf"
    pdf.write_bytes(b"%PDF-1.4\nsynthetic\n%%EOF")
    source = {"tenantId": "local", "jobId": "qa", "artifactId": "text", "generation": 1, "textSha256": hashlib.sha256(text.read_bytes()).hexdigest()}
    printed = {"source": source, "settings": DEFAULT_SETTINGS, "rendererVersion": RENDERER_VERSION, "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest()}
    binding = {"source": source, "pdfArtifactId": "pdf", "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest(), "settings": DEFAULT_SETTINGS, "rendererVersion": RENDERER_VERSION}
    for kind, aid, file, meta in [("cover_letter", "text", text, {}), ("cover_letter_pdf", "pdf", pdf, {"cover_letter_review": printed})]:
        conn.execute("INSERT INTO job_materials_artifacts VALUES ('local','qa',?,?,?,?, 'approved',NULL,1,'now')", (kind, aid, str(file), json.dumps(meta)))
    conn.execute("INSERT INTO job_events VALUES ('local','qa','ApplyReviewDecisionRecorded',?,1)", (json.dumps({"decisionId": "decision", "coverLetterBinding": binding}),))
    assert cover_letter_approval_current(conn, "local", "qa", "decision")
    printed["source"] = {**source, "generation": 2}
    conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='cover_letter_pdf'", (json.dumps({"cover_letter_review": printed}),))
    assert not cover_letter_approval_current(conn, "local", "qa", "decision")
    printed["source"] = source
    conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='cover_letter_pdf'", (json.dumps({"cover_letter_review": printed}),))
    assert not cover_letter_approval_current(conn, "local", "qa", "another-decision")
    text.write_text("Replaced source")
    assert not cover_letter_approval_current(conn, "local", "qa", "decision")
    text.write_text("Synthetic accepted letter")
    pdf.write_bytes(b"%PDF-1.4\nchanged\n%%EOF")
    assert not cover_letter_approval_current(conn, "local", "qa", "decision")
    binding["pdfSha256"] = hashlib.sha256(pdf.read_bytes()).hexdigest()
    conn.execute("UPDATE job_events SET payload_json=?", (json.dumps({"decisionId":"decision","coverLetterBinding":binding}),))
    assert not cover_letter_approval_current(conn, "local", "qa", "decision")  # receipt, not a forged live-file binding, owns acceptance
    pdf.write_bytes(b"%PDF-1.4\nsynthetic\n%%EOF")
    binding["pdfSha256"] = hashlib.sha256(pdf.read_bytes()).hexdigest()
    conn.execute("UPDATE job_events SET payload_json=?", (json.dumps({"decisionId":"decision","coverLetterBinding":binding}),))
    printed["settings"] = {**DEFAULT_SETTINGS, "paper": "A4"}
    conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='cover_letter_pdf'", (json.dumps({"cover_letter_review": printed}),))
    assert not cover_letter_approval_current(conn, "local", "qa", "decision")
    assert cover_letter_approval_current(conn, "other", "qa", "decision")  # no foreign material/binding is read
    conn.close()
