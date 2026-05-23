"""Content-based job identity helpers shared by discovery and scoring."""

from __future__ import annotations

import hashlib
import re
import unicodedata


_WHITESPACE_RE = re.compile(r"\s+")
_PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201e": '"',
        "\u201f": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2212": "-",
    }
)


def normalize_identity_text(value: object) -> str:
    """Return a case-insensitive, whitespace-stable identity component."""

    text = unicodedata.normalize("NFKC", str(value or "").strip()).translate(_PUNCT_TRANSLATION)
    return _WHITESPACE_RE.sub(" ", text).casefold()


def job_content_fingerprint(
    *,
    title: object,
    company: object,
    description: object,
    description_limit: int | None = None,
) -> str | None:
    """Hash title + company + description when all content signals exist."""

    normalized_title = normalize_identity_text(title)
    normalized_company = normalize_identity_text(company)
    normalized_description = normalize_identity_text(description)
    if description_limit is not None and description_limit > 0:
        normalized_description = normalized_description[:description_limit]
    if not normalized_title or not normalized_company or not normalized_description:
        return None
    payload = "\x1f".join((normalized_title, normalized_company, normalized_description))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
