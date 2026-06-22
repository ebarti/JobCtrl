"""PlaywrightHtmlPdfAdapter — HTML→PDF cover-letter renderer.

See ddd-target.md §5.5. Implements the cover-letter half of
:class:`PdfRendererPort` by wrapping the Playwright headless Chromium
HTML→PDF logic that previously lived in ``scoring/pdf.py``.

The resume half lives in :class:`HtmlResumePdfAdapter`. Cover letters use their
own HTML/Playwright scaffold because they don't share the resume layout map.
"""

from __future__ import annotations

import html as html_mod
import logging
import os
import uuid
from pathlib import Path

from jobhunter.domain.materials.entities import Artifact
from jobhunter.domain.materials.value_objects import (
    ArtifactStatus,
    ArtifactType,
    RenderFormat,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Cover-letter HTML scaffolding
# ---------------------------------------------------------------------------


def _build_letter_html(text: str) -> str:
    """Build simple HTML for a plain-text cover letter."""
    paragraphs: list[str] = []
    for block in text.strip().split("\n\n"):
        block_lines = [html_mod.escape(line.strip()) for line in block.splitlines() if line.strip()]
        if block_lines:
            paragraphs.append(f"<p>{'<br>'.join(block_lines)}</p>")

    body_html = "\n".join(paragraphs) or f"<p>{html_mod.escape(text.strip())}</p>"

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page {{
    size: letter;
    margin: 0.7in;
}}
* {{
    box-sizing: border-box;
}}
body {{
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1f1f1f;
}}
.letter {{
    width: 100%;
}}
p {{
    margin: 0 0 14px;
    white-space: normal;
}}
</style>
</head>
<body>
<div class="letter">
{body_html}
</div>
</body>
</html>"""


def _render_pdf_playwright(html_content: str, output_path: str) -> None:
    """Render HTML to PDF using Playwright's headless Chromium (cover letters only)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content(html_content, wait_until="networkidle")
        page.pdf(
            path=output_path,
            format="Letter",
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            print_background=True,
        )
        browser.close()


def convert_cover_letter_text_to_pdf(text: str, output_path: str | os.PathLike[str]) -> Path:
    """Render plain text cover letter to PDF at the given output path.

    Returns the resolved :class:`Path` to the generated PDF. Used by the
    adapter's port-shaped entry point and by the legacy CLI fallback in
    ``pipeline._run_pdf``.
    """
    out = Path(output_path)
    html_content = _build_letter_html(text)
    _render_pdf_playwright(html_content, str(out))
    log.info("Cover letter PDF generated: %s", out)
    return out


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class PlaywrightHtmlPdfAdapter:
    """Concrete :class:`PdfRendererPort` that renders cover letters via Playwright.

    Resumes use :class:`HtmlResumePdfAdapter`; this adapter raises
    :class:`NotImplementedError` from :meth:`render_resume_to_pdf` so a
    misconfigured wiring fails loudly instead of silently producing
    nothing.
    """

    def render_resume_to_pdf(
        self,
        *,
        tailored_payload: dict,
        profile_dict: dict,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        raise NotImplementedError(
            "PlaywrightHtmlPdfAdapter does not render resumes; use HtmlResumePdfAdapter."
        )

    def render_cover_letter_to_pdf(
        self,
        *,
        cover_letter_text: str,
        output_path: str,
        created_at: str,
    ) -> Artifact:
        out = convert_cover_letter_text_to_pdf(cover_letter_text, output_path)
        size = None
        try:
            size = out.stat().st_size if out.exists() else None
        except OSError:
            pass
        return Artifact(
            artifact_id=uuid.uuid4().hex,
            type=ArtifactType.COVER_LETTER_PDF,
            status=ArtifactStatus.CANDIDATE,
            path=str(out),
            render_format=RenderFormat.HTML_PDF,
            created_at=created_at,
            size_bytes=size,
            metadata={},
            superseded_at=None,
        )
