"""Import profile and resume style drafts from an uploaded resume PDF."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from io import BytesIO
from statistics import median
from typing import Any

from jobctrl.resume_profile import DEFAULT_WRITING_STYLE, get_tailoring_policy
from jobctrl.infrastructure.materials.resume_style import normalize_resume_style

MAX_IMPORT_BYTES = 12 * 1024 * 1024


@dataclass
class PdfTextResult:
    text: str
    page_count: int
    page_sizes: list[tuple[float, float]] = field(default_factory=list)
    font_names: list[str] = field(default_factory=list)
    font_sizes: list[float] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def import_resume_pdf(
    pdf_bytes: bytes,
    *,
    filename: str = "",
    base_profile: dict[str, Any] | None = None,
    base_style: dict[str, Any] | None = None,
    extractor,
) -> dict[str, Any]:
    """Return a draft profile/style import payload from a resume PDF.

    The importer is intentionally local and draft-oriented: it extracts best-effort
    profile facts and visual style settings, but leaves persistence to the
    local UI/API save flow.
    """
    result = extract_pdf_text(pdf_bytes)
    extracted, envelope = extractor.extract(result.text)
    profile = profile_from_extraction(extracted, base_profile=base_profile)
    style = style_from_pdf_metadata(result, base_style=base_style)
    preview = "\n".join(line.strip() for line in result.text.splitlines() if line.strip())[:6000]
    return {
        "profile": profile,
        "style": style,
        "source": {
            "filename": filename,
            "determinationId": envelope.determination_id,
            "status": "pending_confirmation",
            "pages": result.page_count,
            "text_preview": preview[:6000],
            "warnings": result.warnings,
        },
    }


def extract_pdf_text(pdf_bytes: bytes) -> PdfTextResult:
    """Extract text and coarse style metadata from PDF bytes."""
    if not pdf_bytes:
        raise ValueError("Uploaded file is empty.")
    if len(pdf_bytes) > MAX_IMPORT_BYTES:
        raise ValueError(f"Resume PDF must be {MAX_IMPORT_BYTES // (1024 * 1024)}MB or smaller.")
    if b"%PDF" not in pdf_bytes[:1024]:
        raise ValueError("Uploaded file does not look like a PDF.")

    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - exercised only when dependency is missing
        raise ValueError("Resume PDF import requires the pypdf package. Reinstall JobCtrl dependencies.") from exc

    reader = PdfReader(BytesIO(pdf_bytes))
    text_parts: list[str] = []
    font_names: list[str] = []
    font_sizes: list[float] = []
    page_sizes: list[tuple[float, float]] = []
    warnings: list[str] = []

    for page in reader.pages:
        box = page.mediabox
        page_sizes.append((float(box.width), float(box.height)))

        def visitor_text(text: str, _cm: object, _tm: object, font_dict: Any, font_size: float) -> None:
            if text:
                text_parts.append(text)
            if font_size:
                font_sizes.append(float(font_size))
            if isinstance(font_dict, dict):
                base_font = font_dict.get("/BaseFont") or font_dict.get("BaseFont")
                if base_font:
                    font_names.append(str(base_font))

        try:
            page_text = page.extract_text(visitor_text=visitor_text) or ""
        except TypeError:
            page_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Could not extract text from one page: {exc}")
            continue
        if page_text and not text_parts:
            text_parts.append(page_text)

    text = "\n".join(part for part in text_parts if str(part).strip())
    if len(text.strip()) < 40:
        raise ValueError(
            "Could not extract enough text from the PDF. Scanned/image-only resumes are not supported yet."
        )
    return PdfTextResult(
        text=text,
        page_count=len(reader.pages),
        page_sizes=page_sizes,
        font_names=font_names,
        font_sizes=font_sizes,
        warnings=warnings,
    )


def profile_from_extraction(extracted, *, base_profile=None):
    profile = _base_profile(base_profile)

    def value(item):
        return item.value if item is not None else ""

    for key in type(extracted.personal).model_fields:
        item = getattr(extracted.personal, key)
        if item is not None:
            profile["personal"][key] = item.value
    experience = [
        {
            "id": f"import:experience:{index}",
            "title": value(item.title),
            "company": value(item.company),
            "date_range": value(item.date_range),
            "location": value(item.location),
            "summary": value(item.summary),
            "bullets": [bullet.value for bullet in item.bullets],
            "achievement_evidence": [],
        }
        for index, item in enumerate(extracted.experience)
    ]
    education = [
        {
            "id": f"import:education:{index}",
            "institution": value(item.institution),
            "degree": value(item.degree),
            "date": value(item.date),
            "location": value(item.location),
        }
        for index, item in enumerate(extracted.education)
    ]
    skills = [
        {"id": f"import:skills:{index}", "label": item.label.value, "items": [skill.value for skill in item.items]}
        for index, item in enumerate(extracted.skills)
    ]
    resume = profile["resume"]
    resume.update(
        executive_profile={"baseline_text": value(extracted.executive_profile)},
        experience_entries=experience,
        education_entries=education,
        skill_categories=skills,
    )
    rules = resume.setdefault("tailoring_rules", {})
    rules.update(
        required_experience_entry_ids=[item["id"] for item in experience],
        required_education_entry_ids=[item["id"] for item in education],
        required_skill_category_ids=[item["id"] for item in skills],
        required_bullets_by_experience_id={},
        required_skills_by_category_id={},
    )
    rules.setdefault("max_experience_bullets", 4)
    rules.setdefault("tailoring_policy", get_tailoring_policy(profile))
    rules.setdefault("writing_style", DEFAULT_WRITING_STYLE.copy())
    rules.setdefault("revision_gates", {"min_fit_score": 8, "must_have_coverage": 0.85, "max_revision_attempts": 1})
    rules.setdefault("custom_tailoring_prompt", "")
    return profile


def style_from_pdf_metadata(
    result: PdfTextResult,
    *,
    base_style: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Infer editable resume style controls from coarse PDF metadata."""
    inferred: dict[str, Any] = {}
    if result.page_sizes:
        width, height = result.page_sizes[0]
        inferred["paper_size"] = "letterpaper" if abs(width - 612) + abs(height - 792) < 60 else "a4paper"

    usable_font_sizes = [size for size in result.font_sizes if 6 <= size <= 24]
    if usable_font_sizes:
        med = median(usable_font_sizes)
        inferred["document_font_size"] = "10pt" if med < 10.5 else "12pt" if med >= 11.8 else "11pt"

    font_blob = " ".join(result.font_names).lower()
    serif_tokens = ("times", "serif", "garamond", "georgia", "cambria", "liberationserif", "cmr")
    inferred["font_family"] = "roman" if any(token in font_blob for token in serif_tokens) else "sans"
    inferred["body_alignment"] = "left"
    return normalize_resume_style({**(base_style or {}), **inferred})


def _base_profile(base_profile: dict[str, Any] | None) -> dict[str, Any]:
    profile = deepcopy(base_profile or {})
    profile.setdefault("personal", {})
    profile.setdefault("work_authorization", {})
    profile.setdefault("availability", {})
    profile.setdefault("compensation", {})
    profile.setdefault("experience", {})
    profile.setdefault("resume_constraints", {})
    profile.setdefault("eeo_voluntary", {})
    profile.setdefault("resume", {})
    profile["resume"].setdefault("tailoring_rules", {})
    return profile
