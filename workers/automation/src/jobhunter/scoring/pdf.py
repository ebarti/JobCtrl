"""PDF generation for tailored resumes and cover letters.

Tailored resumes are rendered through the built-in moderncv LaTeX template and
compiled with pdflatex. Cover letters fall back to HTML/Playwright because they
do not use the resume template.
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from jobhunter.database import get_connection
from jobhunter.state import record_job_artifact, record_job_event, set_stage_state, utc_now

log = logging.getLogger(__name__)

DEFAULT_RESUME_LATEX_TEMPLATE = r"""\documentclass[11pt,a4paper,sans]{moderncv}

\moderncvstyle{banking}
\moderncvcolor{black}

\usepackage[utf8]{inputenc}
\usepackage[english]{babel}
\usepackage[scale=0.85]{geometry}
\usepackage{enumitem}

\setlength{\hintscolumnwidth}{3cm}

{{ personal_data }}

\begin{document}

\makecvtitle
\vspace*{-1.5em}

{{ resume_body }}

\end{document}
"""

REQUIRED_TEMPLATE_TOKENS = ("{{ personal_data }}",)
SECTION_TEMPLATE_TOKENS = (
    "{{ executive_profile_section }}",
    "{{ experience_section }}",
    "{{ education_section }}",
    "{{ skills_section }}",
)

DEFAULT_RESUME_STYLE = {
    "document_font_size": "11pt",
    "paper_size": "a4paper",
    "font_family": "sans",
    "moderncv_style": "banking",
    "moderncv_color": "black",
    "page_scale": 0.85,
    "hints_column_width_cm": 3.0,
    "body_alignment": "justified",
}

_STYLE_CHOICES = {
    "document_font_size": {"10pt", "11pt", "12pt"},
    "paper_size": {"a4paper", "letterpaper"},
    "font_family": {"sans", "roman"},
    "moderncv_style": {"banking", "classic", "casual", "oldstyle", "fancy"},
    "moderncv_color": {"black", "blue", "burgundy", "green", "grey", "orange", "purple", "red"},
    "body_alignment": {"justified", "left"},
}


# ── LaTeX Utilities ──────────────────────────────────────────────────────

def _find_pdflatex() -> str:
    """Locate the pdflatex binary, checking common MacTeX/TeX Live paths."""
    # Check env override first
    env = os.environ.get("PDFLATEX_PATH")
    if env and Path(env).exists():
        return env

    # Check PATH
    found = shutil.which("pdflatex")
    if found:
        return found

    # Common MacTeX / TeX Live locations
    candidates = [
        "/Library/TeX/texbin/pdflatex",
        "/usr/local/bin/pdflatex",
        "/opt/homebrew/bin/pdflatex",
    ]
    for c in candidates:
        if Path(c).exists():
            return c

    raise FileNotFoundError(
        "pdflatex not found. Install a TeX distribution (e.g. MacTeX, TeX Live) "
        "or set PDFLATEX_PATH."
    )


def _escape_latex(text: str) -> str:
    """Escape special LaTeX characters in user/LLM-generated text."""
    # Order matters: & must come before others that might create &
    replacements = [
        ("\\", "\\textbackslash{}"),
        ("&", "\\&"),
        ("%", "\\%"),
        ("$", "\\$"),
        ("#", "\\#"),
        ("_", "\\_"),
        ("{", "\\{"),
        ("}", "\\}"),
        ("~", "\\textasciitilde{}"),
        ("^", "\\textasciicircum{}"),
    ]
    for old, new in replacements:
        text = text.replace(old, new)
    # Fix euro sign — common in this resume
    text = text.replace("€", "\\texteuro ")
    # Fix em/en dashes
    text = text.replace("\u2014", "---")
    text = text.replace("\u2013", "--")
    # Smart quotes → straight quotes
    text = text.replace("\u201c", "``").replace("\u201d", "''")
    text = text.replace("\u2018", "`").replace("\u2019", "'")
    return text


def _escape_latex_light(text: str) -> str:
    """Escape LaTeX specials but preserve intentional LaTeX commands.

    For fields that may contain intentional LaTeX like \\texteuro, \\`{e}, etc.
    Only escapes the dangerous characters that are unlikely in authored content.
    """
    # Only escape truly dangerous chars that appear in LLM output
    text = text.replace("&", "\\&")
    text = text.replace("%", "\\%")
    text = text.replace("#", "\\#")
    # Fix euro sign if raw €
    text = text.replace("€", "\\texteuro ")
    # Fix em/en dashes
    text = text.replace("\u2014", "---")
    text = text.replace("\u2013", "--")
    # Smart quotes → straight quotes
    text = text.replace("\u201c", "``").replace("\u201d", "''")
    text = text.replace("\u2018", "`").replace("\u2019", "'")
    return text


# ── LaTeX Resume Builder ─────────────────────────────────────────────────

def validate_latex_template(template: str) -> None:
    """Validate that a resume template can receive generated resume fragments."""
    if not template.strip():
        raise ValueError("LaTeX template cannot be empty.")
    missing = [token for token in REQUIRED_TEMPLATE_TOKENS if token not in template]
    if missing:
        raise ValueError(f"LaTeX template is missing required token(s): {', '.join(missing)}")
    if "{{ resume_body }}" not in template and not all(token in template for token in SECTION_TEMPLATE_TOKENS):
        raise ValueError(
            "LaTeX template must include {{ resume_body }} or all section tokens: "
            + ", ".join(SECTION_TEMPLATE_TOKENS)
        )


def _coerce_style_choice(style: dict, key: str) -> str:
    value = str(style.get(key, DEFAULT_RESUME_STYLE[key]) or "").strip()
    if value not in _STYLE_CHOICES[key]:
        allowed = ", ".join(sorted(_STYLE_CHOICES[key]))
        raise ValueError(f"{key} must be one of: {allowed}.")
    return value


def _coerce_style_float(style: dict, key: str, *, minimum: float, maximum: float) -> float:
    try:
        value = float(style.get(key, DEFAULT_RESUME_STYLE[key]))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a number.") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{key} must be between {minimum:g} and {maximum:g}.")
    return round(value, 2)


def normalize_resume_style(values: dict | None = None, *, base: dict | None = None) -> dict:
    """Validate editable resume style settings."""
    source = {**DEFAULT_RESUME_STYLE, **(base or {}), **(values or {})}
    return {
        "document_font_size": _coerce_style_choice(source, "document_font_size"),
        "paper_size": _coerce_style_choice(source, "paper_size"),
        "font_family": _coerce_style_choice(source, "font_family"),
        "moderncv_style": _coerce_style_choice(source, "moderncv_style"),
        "moderncv_color": _coerce_style_choice(source, "moderncv_color"),
        "page_scale": _coerce_style_float(source, "page_scale", minimum=0.7, maximum=1.0),
        "hints_column_width_cm": _coerce_style_float(
            source,
            "hints_column_width_cm",
            minimum=1.5,
            maximum=5.0,
        ),
        "body_alignment": _coerce_style_choice(source, "body_alignment"),
    }


def build_latex_template_from_style(style_values: dict | None = None) -> str:
    """Generate a LaTeX resume template from user-friendly style settings."""
    style = normalize_resume_style(style_values)
    alignment = r"\AtBeginDocument{\raggedright}" if style["body_alignment"] == "left" else ""
    return rf"""\documentclass[{style["document_font_size"]},{style["paper_size"]},{style["font_family"]}]{{moderncv}}

\moderncvstyle{{{style["moderncv_style"]}}}
\moderncvcolor{{{style["moderncv_color"]}}}

\usepackage[utf8]{{inputenc}}
\usepackage[english]{{babel}}
\usepackage[scale={style["page_scale"]:.2f}]{{geometry}}
\usepackage{{enumitem}}

\setlength{{\hintscolumnwidth}}{{{style["hints_column_width_cm"]:.2f}cm}}
{alignment}

{{{{ personal_data }}}}

\begin{{document}}

\makecvtitle
\vspace*{{-1.5em}}

{{{{ resume_body }}}}

\end{{document}}
"""


def load_resume_style(path: Path | None = None) -> dict:
    """Load saved resume style settings or return defaults."""
    from jobhunter import config

    style_path = path or config.RESUME_STYLE_PATH
    if not style_path.exists():
        return normalize_resume_style()
    try:
        raw = json.loads(style_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid resume style JSON at {style_path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"Resume style config at {style_path} must be a JSON object.")
    return normalize_resume_style(raw)


def save_resume_style(values: dict, path: Path | None = None) -> dict:
    """Persist style controls and regenerate the LaTeX template."""
    from jobhunter import config

    style = normalize_resume_style(values)
    style_path = path or config.RESUME_STYLE_PATH
    style_path.parent.mkdir(parents=True, exist_ok=True)
    style_path.write_text(json.dumps(style, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return style


def load_latex_template(path: Path | None = None) -> str:
    """Load the user resume LaTeX template or return the built-in default."""
    from jobhunter import config

    template_path = path or config.RESUME_TEMPLATE_PATH
    if template_path.exists():
        return template_path.read_text(encoding="utf-8")
    return DEFAULT_RESUME_LATEX_TEMPLATE


def ensure_latex_template(path: Path | None = None) -> str:
    """Create the user template file if missing and return its text."""
    from jobhunter import config

    template_path = path or config.RESUME_TEMPLATE_PATH
    if not template_path.exists():
        template_path.parent.mkdir(parents=True, exist_ok=True)
        template_path.write_text(DEFAULT_RESUME_LATEX_TEMPLATE, encoding="utf-8")
    return template_path.read_text(encoding="utf-8")


def save_latex_template(template: str, path: Path | None = None) -> str:
    """Validate and persist the editable resume LaTeX template."""
    from jobhunter import config

    validate_latex_template(template)
    template_path = path or config.RESUME_TEMPLATE_PATH
    template_path.parent.mkdir(parents=True, exist_ok=True)
    template_path.write_text(template, encoding="utf-8")
    return template


def _section(title: str, body: list[str]) -> str:
    return "\n".join([fr"\section{{{title}}}", *body, ""])


def _apply_latex_template(template: str, fragments: dict[str, str]) -> str:
    rendered = template
    for key, value in fragments.items():
        rendered = rendered.replace("{{ " + key + " }}", value)
    return rendered


def build_latex(
    data: dict,
    profile: dict,
    *,
    template_text: str | None = None,
    template_path: Path | None = None,
) -> str:
    """Build a complete moderncv LaTeX document from LLM tailoring JSON + profile.

    Args:
        data: Parsed LLM JSON with executive_profile, experience_updates,
              skill_category_updates.
        profile: User profile dict (typically ``ProfileSnapshot.as_dict()``).

    Returns:
        Complete LaTeX source string ready for pdflatex.
    """
    from jobhunter.resume_profile import (
        get_education_entries,
        get_experience_entries,
        get_required_education_entry_ids,
        get_required_experience_entry_ids,
        get_required_skill_category_ids,
        get_resume_master,
        get_skill_categories,
        get_tailoring_policy,
        tailored_experience_bullets,
        tailored_experience_title,
    )
    from jobhunter.scoring.validator import sanitize_text

    personal = profile.get("personal", {})
    tailoring_policy = get_tailoring_policy(profile)
    resume = get_resume_master(profile)
    required_experience_ids = get_required_experience_entry_ids(profile)
    required_education_ids = get_required_education_entry_ids(profile)
    required_skill_ids = get_required_skill_category_ids(profile)
    all_experience_entries = get_experience_entries(profile)
    all_education_entries = get_education_entries(profile)
    all_skill_categories = get_skill_categories(profile)
    experience_entries = [
        entry for entry in all_experience_entries
        if not required_experience_ids or entry.get("id") in required_experience_ids
    ] or all_experience_entries
    education_entries = [
        entry for entry in all_education_entries
        if not required_education_ids or entry.get("id") in required_education_ids
    ] or all_education_entries
    skill_categories = [
        category for category in all_skill_categories
        if not required_skill_ids or category.get("id") in required_skill_ids
    ] or all_skill_categories

    # Index LLM updates by id
    experience_updates = {
        entry.get("id"): entry
        for entry in data.get("experience_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }
    skill_updates = {
        entry.get("id"): entry
        for entry in data.get("skill_category_updates", [])
        if isinstance(entry, dict) and entry.get("id")
    }

    # ── Personal Data ──
    # Split full_name into first + last for moderncv \name{first}{last}
    full_name = personal.get("full_name", "")
    name_parts = full_name.strip().split(None, 1)
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    personal_lines = [f"\\name{{{first_name}}}{{{last_name}}}"]

    address = personal.get("address", "")
    city = personal.get("city", "")
    postal_code = personal.get("postal_code", "")
    country = personal.get("country", "")
    addr_line2 = " ".join(p for p in [postal_code, country] if p)
    if address or city:
        personal_lines.append(f"\\address{{{address}, {city}}}{{{addr_line2}}}")

    phone = personal.get("phone", "")
    if phone:
        personal_lines.append(f"\\phone[mobile]{{{phone}}}")

    email = personal.get("email", "")
    if email:
        personal_lines.append(f"\\email{{{email}}}")

    website = personal.get("website_url", "").replace("https://", "").replace("http://", "").rstrip("/")
    if website:
        personal_lines.append(f"\\homepage{{{website}}}")

    linkedin = personal.get("linkedin_url", "")
    if linkedin:
        # Extract handle from URL
        handle = linkedin.rstrip("/").rsplit("/", 1)[-1]
        personal_lines.append(f"\\social[linkedin]{{{handle}}}")

    # ── Executive Profile ──
    exec_profile_source = (
        data.get("executive_profile", "")
        if tailoring_policy["allow_summary_rewrite"]
        else resume.get("executive_profile", {}).get("baseline_text", "")
    )
    exec_profile = sanitize_text(exec_profile_source)
    exec_profile_escaped = _escape_latex_light(exec_profile)
    executive_profile_section = _section("Executive Profile", [f"\\small{{{exec_profile_escaped}}}"])

    # ── Experience ──
    experience_lines = [""]
    for entry in experience_entries:
        date_range = _escape_latex_light(entry.get("date_range", ""))
        company = _escape_latex_light(entry.get("company", ""))
        location = _escape_latex_light(entry.get("location", ""))

        # Get bullets: LLM update if available, else master bullets
        update = experience_updates.get(entry.get("id"), {})
        title = _escape_latex_light(tailored_experience_title(entry, update, profile))
        bullets = tailored_experience_bullets(entry, update, profile)

        experience_lines.append(
            f"\\cventry{{{date_range}}}{{{title}}}"
            f"{{{company}}}{{{location}}}{{}}{{",
        )
        experience_lines.append(r"\begin{itemize}")
        for bullet in bullets:
            bullet_clean = sanitize_text(str(bullet))
            bullet_escaped = _escape_latex_light(bullet_clean)
            experience_lines.append(f"    \\item {bullet_escaped}")
        experience_lines.append(r"\end{itemize}")
        experience_lines.append("}")
        experience_lines.append("")
    experience_section = _section("Experience", experience_lines)

    # ── Education ──
    education_lines = []
    for entry in education_entries:
        date = _escape_latex_light(entry.get("date", ""))
        degree = _escape_latex_light(entry.get("degree", ""))
        institution = _escape_latex_light(entry.get("institution", ""))
        location = _escape_latex_light(entry.get("location", ""))
        education_lines.append(
            f"\\cventry{{{date}}}{{{degree}}}"
            f"{{{institution}}}{{{location}}}{{}}{{}}",
        )
    education_section = _section("Education", education_lines)

    # ── Skills ──
    skill_lines = [r"\begin{itemize}[label=\textbullet]"]
    for category in skill_categories:
        update = skill_updates.get(category.get("id"), {})
        items = update.get("items", category.get("items", [])) if tailoring_policy["allow_skill_reordering"] else category.get("items", [])
        label = _escape_latex_light(category.get("label", "Skills"))
        sanitized_items = [_escape_latex_light(sanitize_text(str(item))) for item in items if str(item).strip()]
        items_str = ", ".join(sanitized_items)
        skill_lines.append(f"    \\item \\textbf{{{label}:}} {items_str}.")
    skill_lines.append(r"\end{itemize}")
    skills_section = _section("Skills", skill_lines)

    fragments = {
        "personal_data": "\n".join(personal_lines),
        "executive_profile_section": executive_profile_section,
        "experience_section": experience_section,
        "education_section": education_section,
        "skills_section": skills_section,
    }
    fragments["resume_body"] = "\n".join(
        [
            fragments["executive_profile_section"],
            fragments["experience_section"],
            fragments["education_section"],
            fragments["skills_section"],
        ]
    )

    template = template_text if template_text is not None else load_latex_template(template_path)
    validate_latex_template(template)
    return _apply_latex_template(template, fragments)


def render_pdf_latex(latex_source: str, output_path: str) -> None:
    """Compile LaTeX source to PDF using pdflatex.

    Args:
        latex_source: Complete LaTeX document string.
        output_path: Path to write the final PDF.
    """
    pdflatex = _find_pdflatex()

    with tempfile.TemporaryDirectory(prefix="jobhunter_latex_") as tmpdir:
        tex_path = Path(tmpdir) / "resume.tex"
        tex_path.write_text(latex_source, encoding="utf-8")

        # Run pdflatex twice for cross-references (moderncv needs it)
        for run in range(2):
            result = subprocess.run(
                [pdflatex, "-interaction=nonstopmode", "-halt-on-error", "resume.tex"],
                cwd=tmpdir,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                log.error("pdflatex run %d failed:\n%s", run + 1, result.stdout[-2000:])
                raise RuntimeError(
                    f"pdflatex compilation failed (run {run + 1}). "
                    f"Check LaTeX source for errors. Last output:\n{result.stdout[-500:]}"
                )

        pdf_result = Path(tmpdir) / "resume.pdf"
        if not pdf_result.exists():
            raise RuntimeError("pdflatex produced no PDF output")

        shutil.copy2(str(pdf_result), output_path)


# ── Cover Letter PDF (HTML/Playwright fallback) ─────────────────────────

def _build_letter_html(text: str) -> str:
    """Build simple HTML for a plain-text cover letter."""
    import html as html_mod

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


# ── Public API ───────────────────────────────────────────────────────────

def convert_resume_to_pdf(data: dict, profile: dict, output_path: Path) -> Path:
    """Convert tailored resume JSON to PDF via LaTeX.

    Args:
        data: Parsed LLM tailoring JSON.
        profile: User profile dict.
        output_path: Where to write the PDF.

    Returns:
        Path to the generated PDF.
    """
    output_path = Path(output_path)
    latex_source = build_latex(data, profile)

    # Also save the .tex source for debugging/manual editing
    tex_path = output_path.with_suffix(".tex")
    tex_path.write_text(latex_source, encoding="utf-8")
    log.info("LaTeX source saved: %s", tex_path)

    render_pdf_latex(latex_source, str(output_path))
    log.info("PDF generated: %s", output_path)
    return output_path


def convert_cover_letter_to_pdf(text_path: Path, output_path: Path | None = None) -> Path:
    """Convert a plain-text cover letter to PDF via HTML/Playwright.

    Args:
        text_path: Path to the .txt cover letter.
        output_path: Optional override for the output path.

    Returns:
        Path to the generated PDF.
    """
    text_path = Path(text_path)
    text = text_path.read_text(encoding="utf-8")
    html_content = _build_letter_html(text)

    out = Path(output_path) if output_path else text_path.with_suffix(".pdf")
    _render_pdf_playwright(html_content, str(out))
    log.info("Cover letter PDF generated: %s", out)
    return out


def get_pending_conversion_targets(limit: int = 0) -> list[Path]:
    """Return approved cover-letter text artifacts that still need PDF conversion."""
    candidates: list[Path] = []
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT cover_letter_path
        FROM jobs
        WHERE cover_letter_path IS NOT NULL
          AND cover_letter_path != ''
        ORDER BY cover_letter_at DESC NULLS LAST
        """
    ).fetchall()
    for row in rows:
        path = Path(row["cover_letter_path"])
        if path.exists() and not path.with_suffix(".pdf").exists():
            candidates.append(path)

    if limit > 0:
        return candidates[:limit]
    return candidates


def count_pending_conversions() -> int:
    """Count text artifacts that do not yet have sibling PDFs."""
    return len(get_pending_conversion_targets())


def batch_convert(limit: int = 0) -> int:
    """Convert pending cover letter text artifacts to PDF.

    Resume PDFs are now generated directly during tailoring (LaTeX path).
    This batch function handles cover letters that were generated without
    a PDF, using the HTML/Playwright fallback.

    Args:
        limit: Maximum number of files to convert. 0 means no limit.

    Returns:
        Number of PDFs generated.
    """
    to_convert = get_pending_conversion_targets(limit=limit)

    if not to_convert:
        log.info("All text artifacts already have PDFs.")
        return 0

    log.info("Converting %d files to PDF...", len(to_convert))
    converted = 0
    for f in to_convert:
        try:
            pdf_path = convert_cover_letter_to_pdf(f)
            converted += 1
            conn = get_connection()
            row = conn.execute(
                "SELECT url FROM jobs WHERE cover_letter_path = ?",
                (str(f),),
            ).fetchone()
            if row:
                now = utc_now()
                set_stage_state(conn, row["url"], "pdf", "succeeded", attempt_count=1, finished_at=now)
                record_job_artifact(conn, row["url"], "pdf", "cover_letter_pdf", pdf_path, status="active", created_at=now)
                record_job_event(conn, row["url"], "pdf", "StageCompleted", message="Cover letter PDF generated")
                conn.commit()
        except Exception as e:
            log.error("Failed to convert %s: %s", f.name, e)

    log.info("Done: %d/%d PDFs generated", converted, len(to_convert))
    return converted
