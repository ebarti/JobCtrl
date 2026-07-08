"""Legacy profile resume-style settings.

These controls remain because profile import/storage schemas still persist them,
but new resume PDFs are rendered by the HTML/CSS adapter and the template text is
not an executable render source.
"""

from __future__ import annotations

DEFAULT_RESUME_TEMPLATE_TEXT = "{{ personal_data }}\n\n{{ resume_body }}\n"

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
