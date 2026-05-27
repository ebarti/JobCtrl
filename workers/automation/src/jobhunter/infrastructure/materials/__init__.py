"""Infrastructure adapters for the Materials Generation context.

See ddd-target.md §5.5. This package wires the domain ports defined in
``jobhunter.domain.ports.materials`` to concrete local-mode implementations:

  * :class:`SqliteMaterialsRepository` — persists MaterialsSet aggregates
    to ``job_materials`` + ``job_materials_artifacts``.
  * :class:`LatexPdfAdapter` — wraps ``pdflatex`` for resume rendering.
  * :class:`PlaywrightHtmlPdfAdapter` — wraps Playwright headless Chromium
    for cover-letter rendering.
"""

from __future__ import annotations

from jobhunter.infrastructure.materials.latex_pdf import LatexPdfAdapter
from jobhunter.infrastructure.materials.playwright_html_pdf import (
    PlaywrightHtmlPdfAdapter,
)
from jobhunter.infrastructure.materials.sqlite_repository import (
    MaterialsGenerationConflict,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
)

__all__ = [
    "LatexPdfAdapter",
    "MaterialsGenerationConflict",
    "PlaywrightHtmlPdfAdapter",
    "SqliteMaterialsRepository",
    "SqliteTailoringPolicyRepository",
]
