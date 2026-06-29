"""Import profile and resume style drafts from an uploaded resume PDF."""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from io import BytesIO
from statistics import median
from typing import Any

from jobhunter.resume_profile import DEFAULT_WRITING_STYLE, get_tailoring_policy
from jobhunter.infrastructure.materials.latex_pdf import normalize_resume_style

MAX_IMPORT_BYTES = 12 * 1024 * 1024

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>]+", re.I)
_PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}")
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_DATE_RANGE_RE = re.compile(
    r"\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+)?(?:19|20)\d{2}"
    r"\s*(?:[-–—]|to)\s*"
    r"(?:(?:Present|Current|Now)|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+)?(?:19|20)\d{2})\b",
    re.I,
)
_BULLET_RE = re.compile(r"^\s*(?:[•●▪◦\-*]|[\d]+[.)])\s+")
_METRIC_RE = re.compile(
    r"(?:[$€£]\s?\d+(?:[.,]\d+)?\s?[kKmMbB]?|\d+(?:\.\d+)?%|\d+(?:[.,]\d+)?\s?[kKmMbB]?\+?\s?"
    r"(?:users|customers|requests|events|engineers|teams|apps|services|systems|employees|incidents|"
    r"deployments|minutes|hours|days|revenue|savings|costs|cost))",
    re.I,
)

_SECTION_ALIASES = {
    "summary": {
        "summary",
        "profile",
        "professional summary",
        "executive profile",
        "about",
        "objective",
    },
    "experience": {
        "experience",
        "professional experience",
        "work experience",
        "employment",
        "employment history",
        "career history",
    },
    "education": {"education", "academic background", "academic history"},
    "skills": {
        "skills",
        "technical skills",
        "core skills",
        "competencies",
        "technologies",
        "toolbox",
    },
}


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
) -> dict[str, Any]:
    """Return a draft profile/style import payload from a resume PDF.

    The importer is intentionally local and draft-oriented: it extracts best-effort
    profile facts and visual style settings, but leaves persistence to the
    local UI/API save flow.
    """
    result = extract_pdf_text(pdf_bytes)
    profile = profile_from_resume_text(result.text, base_profile=base_profile)
    style = style_from_pdf_metadata(result, base_style=base_style)
    preview = "\n".join(_clean_lines(result.text.splitlines())[:80])
    return {
        "profile": profile,
        "style": style,
        "source": {
            "filename": filename,
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
        raise ValueError("Resume PDF import requires the pypdf package. Reinstall JobHunter dependencies.") from exc

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
        raise ValueError("Could not extract enough text from the PDF. Scanned/image-only resumes are not supported yet.")
    return PdfTextResult(
        text=text,
        page_count=len(reader.pages),
        page_sizes=page_sizes,
        font_names=font_names,
        font_sizes=font_sizes,
        warnings=warnings,
    )


def profile_from_resume_text(text: str, *, base_profile: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a canonical JobHunter profile draft from extracted resume text."""
    lines = _clean_lines(text.splitlines())
    sections = _split_sections(lines)
    profile = _base_profile(base_profile)

    personal = profile.setdefault("personal", {})
    personal.update({k: v for k, v in _parse_personal(lines).items() if v})

    summary = _parse_summary(sections, lines)
    experiences = _parse_experience(sections.get("experience", []))
    education = _parse_education(sections.get("education", []))
    skills = _parse_skills(sections.get("skills", []))
    if not skills:
        skills = [{"id": "skills", "label": "Skills", "items": []}]

    resume = profile.setdefault("resume", {})
    resume["executive_profile"] = {"baseline_text": summary or resume.get("executive_profile", {}).get("baseline_text", "")}
    resume["experience_entries"] = experiences
    resume["education_entries"] = education
    resume["skill_categories"] = skills

    rules = resume.setdefault("tailoring_rules", {})
    rules["required_experience_entry_ids"] = [entry["id"] for entry in experiences]
    rules["required_education_entry_ids"] = [entry["id"] for entry in education]
    rules["required_skill_category_ids"] = [category["id"] for category in skills]
    rules["required_bullets_by_experience_id"] = {}
    rules["required_skills_by_category_id"] = {}
    rules["max_experience_bullets"] = _coerce_positive_int(rules.get("max_experience_bullets"), default=4)
    rules["tailoring_policy"] = _dict_or_empty(rules.get("tailoring_policy"))
    rules["writing_style"] = {**DEFAULT_WRITING_STYLE, **_dict_or_empty(rules.get("writing_style"))}
    rules.setdefault("custom_tailoring_prompt", "")
    rules["tailoring_policy"] = get_tailoring_policy(profile)

    exp_meta = profile.setdefault("experience", {})
    if experiences:
        exp_meta["current_job_title"] = experiences[0].get("title", exp_meta.get("current_job_title", ""))
        exp_meta["current_company"] = experiences[0].get("company", exp_meta.get("current_company", ""))
    exp_meta["years_of_experience_total"] = str(_infer_years(lines) or exp_meta.get("years_of_experience_total", ""))
    exp_meta["education_level"] = _infer_education_level(education) or exp_meta.get("education_level", "")
    _infer_target_search_intent(exp_meta, lines=lines, experiences=experiences, skills=skills)

    constraints = profile.setdefault("resume_constraints", {})
    constraints["real_metrics"] = _extract_metrics(lines)
    profile.setdefault("work_authorization", {})
    profile.setdefault("availability", {})
    profile.setdefault("compensation", {})
    profile.setdefault("eeo_voluntary", {})
    return profile


def _infer_target_search_intent(
    exp_meta: dict[str, Any],
    *,
    lines: list[str],
    experiences: list[dict[str, Any]],
    skills: list[dict[str, Any]],
) -> None:
    """Add editable target-search suggestions from resume facts.

    These are suggestions, not persistence-time overrides: existing base
    profile values win so importing a newer resume cannot silently rewrite
    the user's intended search.
    """
    title_text = " ".join(str(entry.get("title") or "") for entry in experiences[:3])
    all_text = " ".join([title_text, *lines]).casefold()
    skill_text = " ".join(
        str(item)
        for category in skills
        for item in (category.get("items", []) if isinstance(category, dict) else [])
    ).casefold()

    _setdefault_nonblank(exp_meta, "target_track", _infer_target_track(title_text))
    _setdefault_nonblank(exp_meta, "target_seniority_floor", _infer_target_seniority(title_text))
    _setdefault_nonblank(exp_meta, "target_functions", "; ".join(_infer_target_functions(f"{all_text} {skill_text}")))
    _setdefault_nonblank(exp_meta, "target_specializations", "; ".join(_infer_target_specializations(all_text)))


def _setdefault_nonblank(target: dict[str, Any], key: str, value: str) -> None:
    if value and not str(target.get(key) or "").strip():
        target[key] = value


def _infer_target_track(title_text: str) -> str:
    text = title_text.casefold()
    if "vice president" in text or re.search(r"\b(?:chief|cto|cio|ciso|evp|svp|vp)\b", text):
        return "Executive"
    if any(token in text for token in ("manager", "director", "head of")):
        return "Management"
    if any(token in text for token in ("engineer", "architect", "staff", "principal", "lead")):
        return "IC"
    return ""


def _infer_target_seniority(title_text: str) -> str:
    text = title_text.casefold()
    if re.search(r"\b(?:chief|cto|cio|ciso)\b", text):
        return "C-level"
    if "vice president" in text or re.search(r"\b(?:evp|svp|vp)\b", text):
        return "VP"
    if "director" in text or "head of" in text:
        return "Director"
    if "principal" in text or "architect" in text:
        return "Principal"
    if "staff" in text:
        return "Staff"
    if "manager" in text:
        return "Manager"
    if "lead" in text:
        return "Lead"
    if "senior" in text or re.search(r"\bsr\b", text):
        return "Senior"
    return ""


def _infer_target_functions(text: str) -> list[str]:
    candidates = [
        ("Platform", ("platform", "sre", "reliability", "infrastructure", "cloud")),
        ("Security", ("security", "cybersecurity", "ciso", "devsecops")),
        ("Data", ("data", "analytics", "warehouse", "bi ")),
        ("AI", ("ai", "machine learning", " ml ", "llm", "genai")),
        ("Backend", ("backend", "api", "distributed systems", "microservice")),
        ("Engineering", ("engineering", "engineer", "software")),
    ]
    return [label for label, needles in candidates if any(needle in text for needle in needles)]


def _infer_target_specializations(text: str) -> list[str]:
    candidates = [
        ("SaaS", ("saas", "subscription", "b2b")),
        ("Robotics", ("robotics", "robot", "autonomous")),
        ("Healthcare", ("healthcare", "health care", "clinical", "patient")),
        ("Fintech", ("fintech", "payments", "banking", "finance")),
        ("Developer tools", ("developer tools", "devtools", "developer platform")),
    ]
    return [label for label, needles in candidates if any(needle in text for needle in needles)]


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


def _clean_lines(lines: list[str]) -> list[str]:
    cleaned: list[str] = []
    for line in lines:
        normalized = re.sub(r"\s+", " ", line.replace("\x00", " ")).strip()
        if normalized:
            cleaned.append(normalized)
    return cleaned


def _section_key(line: str) -> str | None:
    normalized = re.sub(r"[^a-z ]", "", line.lower()).strip()
    if len(normalized.split()) > 4:
        return None
    for key, aliases in _SECTION_ALIASES.items():
        if normalized in aliases:
            return key
    return None


def _split_sections(lines: list[str]) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {"preamble": []}
    current = "preamble"
    for line in lines:
        key = _section_key(line.rstrip(":"))
        if key:
            current = key
            sections.setdefault(current, [])
            continue
        sections.setdefault(current, []).append(line)
    return sections


def _parse_personal(lines: list[str]) -> dict[str, str]:
    text = "\n".join(lines[:30])
    email = _first_match(_EMAIL_RE, text)
    phone = _first_match(_PHONE_RE, text)
    urls = [url.rstrip(".,)") for url in _URL_RE.findall(text)]
    linkedin = next((url for url in urls if "linkedin.com" in url.lower()), "")
    github = next((url for url in urls if "github.com" in url.lower()), "")
    website = next((url for url in urls if url not in {linkedin, github}), "")
    name = ""
    for line in lines[:8]:
        if _section_key(line) or _EMAIL_RE.search(line) or _PHONE_RE.search(line) or _URL_RE.search(line):
            continue
        if len(line.split()) <= 5 and not any(char.isdigit() for char in line):
            name = line
            break
    return {
        "full_name": name,
        "preferred_name": name.split()[0] if name else "",
        "email": email,
        "phone": phone,
        "linkedin_url": linkedin,
        "github_url": github,
        "website_url": website,
        "portfolio_url": website,
    }


def _parse_summary(sections: dict[str, list[str]], lines: list[str]) -> str:
    summary_lines = sections.get("summary", [])
    if not summary_lines:
        summary_lines = [
            line for line in sections.get("preamble", [])[1:]
            if not (_EMAIL_RE.search(line) or _PHONE_RE.search(line) or _URL_RE.search(line))
        ]
    return " ".join(summary_lines[:5])[:900].strip()


def _parse_experience(lines: list[str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    def finish() -> None:
        nonlocal current
        if current and (current.get("title") or current.get("company") or current.get("bullets")):
            current.setdefault("id", _unique_slug(entries, current.get("company", ""), current.get("title", "")))
            current.setdefault("date_range", "")
            current.setdefault("location", "")
            current.setdefault("bullets", [])
            entries.append(current)
        current = None

    for raw in lines:
        line = _strip_bullet(raw)
        if not line:
            continue
        date = _extract_date_range(line)
        is_bullet = bool(_BULLET_RE.match(raw)) or len(line) > 110
        if is_bullet:
            if current is None:
                current = {"title": "Experience", "company": "", "date_range": "", "location": "", "bullets": []}
            current.setdefault("bullets", []).append(line)
            continue
        if date and current and not current.get("date_range") and len(line) <= 80:
            current["date_range"] = date
            remainder = line.replace(date, "").strip(" -–—|,")
            if remainder and not current.get("company"):
                current["company"] = remainder
            continue
        if current and current.get("bullets"):
            finish()
        if current is None:
            title, company, location = _parse_role_heading(line)
            current = {"title": title, "company": company, "date_range": date or "", "location": location, "bullets": []}
        else:
            if date and not current.get("date_range"):
                current["date_range"] = date
            elif not current.get("company"):
                current["company"] = line
            elif not current.get("location"):
                current["location"] = line
    finish()
    return entries


def _parse_role_heading(line: str) -> tuple[str, str, str]:
    clean = _DATE_RANGE_RE.sub("", line).strip(" -–—|,")
    for sep in (" at ", " @ "):
        if sep in clean:
            left, right = clean.split(sep, 1)
            return left.strip(), right.strip(), ""
    if "|" in clean:
        parts = [part.strip() for part in clean.split("|") if part.strip()]
        if len(parts) >= 2:
            return parts[0], parts[1], parts[2] if len(parts) > 2 else ""
    if "," in clean:
        parts = [part.strip() for part in clean.split(",") if part.strip()]
        if len(parts) >= 2:
            return parts[0], parts[1], ", ".join(parts[2:])
    return clean, "", ""


def _parse_education(lines: list[str]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    pending: dict[str, str] | None = None
    for line in lines:
        date = _first_match(_YEAR_RE, line)
        if _looks_like_degree(line):
            if pending:
                entries.append(_finish_education(entries, pending))
            degree = _YEAR_RE.sub("", line).strip(" ,|-")
            pending = {"degree": degree, "institution": "", "location": "", "date": date}
        elif pending and date and not _YEAR_RE.sub("", line).strip(" ,|-"):
            if not pending.get("date"):
                pending["date"] = date
        elif pending and not pending.get("institution"):
            pending["institution"] = _YEAR_RE.sub("", line).strip(" ,|-")
            if date and not pending.get("date"):
                pending["date"] = date
        elif pending and not pending.get("location"):
            pending["location"] = _YEAR_RE.sub("", line).strip(" ,|-")
        elif line:
            if pending:
                entries.append(_finish_education(entries, pending))
            entries.append(
                _finish_education(
                    entries,
                    {"degree": _YEAR_RE.sub("", line).strip(" ,|-"), "institution": "", "location": "", "date": date},
                )
            )
            pending = None
    if pending:
        entries.append(_finish_education(entries, pending))
    return entries


def _finish_education(existing: list[dict[str, str]], entry: dict[str, str]) -> dict[str, str]:
    entry = {key: str(value or "").strip() for key, value in entry.items()}
    entry["id"] = _unique_slug(existing, entry.get("institution", ""), entry.get("degree", ""), entry.get("date", ""))
    return entry


def _parse_skills(lines: list[str]) -> list[dict[str, Any]]:
    categories: list[dict[str, Any]] = []
    loose_items: list[str] = []
    for line in lines:
        if ":" in line:
            label, values = line.split(":", 1)
            items = _split_items(values)
            if items:
                categories.append(
                    {
                        "id": _unique_slug(categories, label),
                        "label": label.strip(),
                        "items": items,
                    }
                )
        else:
            loose_items.extend(_split_items(line))
    if loose_items:
        categories.append({"id": _unique_slug(categories, "skills"), "label": "Skills", "items": _dedupe(loose_items)})
    return categories


def _split_items(value: str) -> list[str]:
    return _dedupe([item.strip(" •;,.") for item in re.split(r"[,;|•]", value) if item.strip(" •;,.")])


def _extract_metrics(lines: list[str]) -> list[str]:
    metrics: list[str] = []
    for line in lines:
        metrics.extend(match.group(0).strip() for match in _METRIC_RE.finditer(line))
    return _dedupe(metrics)[:30]


def _infer_years(lines: list[str]) -> int | None:
    years = [int(match.group(0)) for line in lines for match in _YEAR_RE.finditer(line)]
    if not years:
        return None
    return max(0, datetime.now(UTC).year - min(years))


def _infer_education_level(entries: list[dict[str, str]]) -> str:
    degrees = " ".join(entry.get("degree", "") for entry in entries).lower()
    if any(term in degrees for term in ("phd", "doctor", "doctoral")):
        return "Doctorate"
    if any(term in degrees for term in ("master", "mba", "msc", "m.s.", "ma ")):
        return "Master's Degree"
    if any(term in degrees for term in ("bachelor", "bsc", "b.s.", "ba ")):
        return "Bachelor's Degree"
    return ""


def _looks_like_degree(line: str) -> bool:
    lowered = line.lower()
    return any(term in lowered for term in ("bachelor", "master", "phd", "doctor", "degree", "b.s.", "m.s.", "mba"))


def _extract_date_range(line: str) -> str:
    match = _DATE_RANGE_RE.search(line)
    return match.group(0).strip() if match else ""


def _strip_bullet(line: str) -> str:
    return _BULLET_RE.sub("", line).strip()


def _first_match(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    return match.group(0).strip() if match else ""


def _unique_slug(existing: list[dict[str, Any]], *parts: str) -> str:
    base = "_".join(part for part in (_slug_part(part) for part in parts) if part) or "entry"
    used = {str(item.get("id", "")) for item in existing}
    candidate = base[:72].strip("_") or "entry"
    suffix = 2
    while candidate in used:
        candidate = f"{base[:66].strip('_')}_{suffix}"
        suffix += 1
    return candidate


def _slug_part(value: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(value).lower())).strip("_")


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = value.lower()
        if value and key not in seen:
            result.append(value)
            seen.add(key)
    return result


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _coerce_positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
