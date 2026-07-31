"""Canonical built-in resume-template seed for v7 storage paths."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Final


_BUILT_IN_TEMPLATE_ID: Final = "built_in:modern-html"
_BUILT_IN_VERSION_ID: Final = "built_in:modern-html:v1"
_BUILT_IN_CREATED_AT: Final = "1970-01-01T00:00:00+00:00"
_BUILT_IN_THEME: Final = {
    "pageSize": "a4",
    "fontFamily": "sans",
    "fontScale": 1,
    "density": "balanced",
    "marginMm": {"top": 16.5, "right": 17.5, "bottom": 18, "left": 17.5},
    "headerLayout": "centered",
    "sectionHeadingStyle": "rule",
    "alignment": "justified",
    "bulletSpacing": "normal",
    "accentColor": "#111111",
    "sectionOrder": ["summary", "experience", "education", "skills"],
    "hiddenSections": [],
}
_BUILT_IN_LAYOUT: Final[dict[str, object]] = {}


def seed_builtin_resume_template(
    conn: sqlite3.Connection,
    *,
    created_at: str = _BUILT_IN_CREATED_AT,
) -> None:
    """Add the local built-in template without replacing a persisted seed."""
    theme_json = json.dumps(_BUILT_IN_THEME, sort_keys=True)
    layout_json = json.dumps(_BUILT_IN_LAYOUT, sort_keys=True)
    content_hash = hashlib.sha256(
        json.dumps([_BUILT_IN_THEME, _BUILT_IN_LAYOUT], separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_templates (
            tenant_id, template_id, display_name, status, built_in, created_at, updated_at
        ) VALUES ('local', ?, 'Modern HTML', 'active', 1, ?, ?)
        """,
        (_BUILT_IN_TEMPLATE_ID, created_at, created_at),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO resume_template_versions (
            tenant_id, version_id, template_id, version_number, display_name, status,
            theme_json, layout_json, content_hash, created_at
        ) VALUES ('local', ?, ?, 1, 'Modern HTML', 'active', ?, ?, ?, ?)
        """,
        (
            _BUILT_IN_VERSION_ID,
            _BUILT_IN_TEMPLATE_ID,
            theme_json,
            layout_json,
            content_hash,
            created_at,
        ),
    )
