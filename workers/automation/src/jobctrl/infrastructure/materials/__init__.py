"""Infrastructure adapters for the Materials Generation context.

See ddd-target.md §5.5. This package wires the domain ports defined in
``jobctrl.domain.ports.materials`` to concrete local-mode implementations:

  * :class:`SqliteMaterialsRepository` — persists MaterialsSet aggregates
    to ``job_materials`` + ``job_materials_artifacts``.
  * :class:`HtmlResumePdfAdapter` — wraps Playwright headless Chromium for
    default HTML/CSS resume rendering.
  * :class:`PlaywrightHtmlPdfAdapter` — wraps Playwright headless Chromium
    for cover-letter rendering.
"""

from __future__ import annotations

from jobctrl.infrastructure.materials.bullet_provenance_repository import (
    SqliteBulletProvenanceRepository,
)
from jobctrl.infrastructure.materials.employer_analysis_repository import (
    SqliteEmployerAnalysisRepository,
)
from jobctrl.infrastructure.materials.html_resume_pdf import HtmlResumePdfAdapter
from jobctrl.infrastructure.materials.playwright_html_pdf import (
    PlaywrightHtmlPdfAdapter,
)
from jobctrl.infrastructure.materials.sqlite_repository import (
    LearningRecommendationReviewError,
    MaterialsGenerationConflict,
    SqliteLearningRecommendationReviewRepository,
    SqliteMaterialsRepository,
    SqliteTailoringPolicyRepository,
)
from jobctrl.infrastructure.materials.unit_of_work import SqliteUnitOfWork

__all__ = [
    "HtmlResumePdfAdapter",
    "LearningRecommendationReviewError",
    "MaterialsGenerationConflict",
    "PlaywrightHtmlPdfAdapter",
    "SqliteBulletProvenanceRepository",
    "SqliteEmployerAnalysisRepository",
    "SqliteLearningRecommendationReviewRepository",
    "SqliteMaterialsRepository",
    "SqliteTailoringPolicyRepository",
    "SqliteUnitOfWork",
]
