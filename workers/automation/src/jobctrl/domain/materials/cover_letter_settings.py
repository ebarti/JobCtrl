"""Bounded cover-letter print settings; parity with contracts/cover-letter.ts."""

from __future__ import annotations

import math

RENDERER_VERSION = "playwright-cover-letter-v2"
MAX_SOURCE_BYTES = 512_000
DEFAULT_SETTINGS = {
    "paper": "Letter", "fontFamily": "georgia", "fontSizePt": 11,
    "marginMm": 17.78, "lineHeight": 1.6, "paragraphSpacingPx": 14,
}
FONT_FAMILIES = {
    "georgia": "'Georgia', 'Times New Roman', serif",
    "times": "'Times New Roman', 'Times', serif",
    "arial": "'Arial', 'Helvetica', sans-serif",
}


def validate_settings(settings: dict | None = None) -> dict:
    if settings is None:
        return dict(DEFAULT_SETTINGS)
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS):
        raise ValueError("Invalid cover-letter settings fields")
    if (settings["paper"] not in ("Letter", "A4")
            or not isinstance(settings["fontFamily"], str) or settings["fontFamily"] not in FONT_FAMILIES):
        raise ValueError("Invalid cover-letter paper or font family")
    for key, low, high in (
        ("fontSizePt", 9, 14), ("marginMm", 8, 28),
        ("lineHeight", 1, 2), ("paragraphSpacingPx", 0, 24),
    ):
        value = settings[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"Invalid cover-letter {key}")
    return dict(settings)
