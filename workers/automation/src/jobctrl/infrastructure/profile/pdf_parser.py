"""PyPdfProfileParser — local adapter for ``PdfParserPort``.

Wraps the existing ``profile_import.import_resume_pdf`` text/regex pipeline
so the import use case talks to the domain port instead of an ad-hoc
function. Cloud deployments reuse the same adapter (``pypdf`` is pure-Python).
"""

from __future__ import annotations

from typing import Any

from jobctrl.domain.profile.ports import PdfParserPort


class PyPdfProfileParser(PdfParserPort):
    """Adapter wrapping the package-internal resume PDF importer.

    The actual extraction lives in ``jobctrl.profile_import`` because it
    pre-dates this adapter and is exercised by ``test_profile_import.py``.
    The adapter does not duplicate logic — it forwards through the port so
    consumers depend on the protocol, not the function.
    """

    def parse(
        self,
        pdf_bytes: bytes,
        *,
        filename: str,
        base_profile: dict[str, Any] | None,
        base_style: dict[str, Any] | None,
    ) -> dict[str, Any]:
        # Imported lazily so that constructing a parser doesn't pull in pypdf
        # for callers that never actually parse a PDF (e.g. unit tests that
        # stub the port).
        from jobctrl.profile_import import import_resume_pdf

        return import_resume_pdf(
            pdf_bytes,
            filename=filename,
            base_profile=base_profile,
            base_style=base_style,
        )
