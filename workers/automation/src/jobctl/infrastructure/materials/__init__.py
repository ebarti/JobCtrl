"""Infrastructure adapters for the Materials Generation context.

See ddd-target.md §5.5. This package wires the domain ports defined in
``jobctl.domain.ports.materials`` to concrete local-mode implementations:

  * :class:`SqliteMaterialsRepository` — persists MaterialsSet aggregates
    to ``job_materials`` + ``job_materials_artifacts``.
  * :class:`HtmlResumePdfAdapter` — wraps Playwright headless Chromium for
    default HTML/CSS resume rendering.
  * :class:`LatexPdfAdapter` — wraps ``pdflatex`` for legacy resume rendering.
  * :class:`PlaywrightHtmlPdfAdapter` — wraps Playwright headless Chromium
    for cover-letter rendering.
"""

from __future__ import annotations

from jobctl.infrastructure.materials.bullet_provenance_repository import (
    SqliteBulletProvenanceRepository,
)
from jobctl.infrastructure.materials.employer_analysis_repository import (
    SqliteEmployerAnalysisRepository,
)
from jobctl.infrastructure.materials.html_resume_pdf import HtmlResumePdfAdapter
from jobctl.infrastructure.materials.latex_pdf import LatexPdfAdapter
from jobctl.infrastructure.materials.playwright_html_pdf import (
    PlaywrightHtmlPdfAdapter,
)
from jobctl.infrastructure.materials.sqlite_repository import (
    MaterialsGenerationConflict,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
)
from jobctl.infrastructure.materials.unit_of_work import SqliteUnitOfWork

__all__ = [
    "HtmlResumePdfAdapter",
    "LatexPdfAdapter",
    "MaterialsGenerationConflict",
    "PlaywrightHtmlPdfAdapter",
    "SqliteBulletProvenanceRepository",
    "SqliteEmployerAnalysisRepository",
    "SqliteMaterialsRepository",
    "SqliteTailoringPolicyRepository",
    "SqliteUnitOfWork",
]
