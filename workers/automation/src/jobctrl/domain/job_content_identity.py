"""Content-based job identity helpers shared by discovery and scoring."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Iterable, Literal

ContentMatchBasis = Literal["fingerprint"]
"""Exact identity over canonical fields; meaning never comes from similarity."""

_WHITESPACE_RE = re.compile(r"\s+")
_MARKDOWN_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>])")
_MARKDOWN_MARKER_RE = re.compile(r'[*_`>"]+')
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


def normalize_description_text(value: object) -> str:
    """Return a board-format-stable description identity component."""

    text = normalize_identity_text(value)
    text = _MARKDOWN_ESCAPE_RE.sub(r"\1", text)
    text = _MARKDOWN_MARKER_RE.sub("", text)
    return _WHITESPACE_RE.sub(" ", text).strip()


_NON_EMPLOYER_IDENTITY_LABELS: frozenset[str] = frozenset(
    {
        # ``Employer.unknown()`` sentinel + the SqliteJobRepository row fallback.
        "unknown",
        # Manual-capture board (production_wiring._manual_capture_posting).
        "user-mediated capture",
        # Workday board fallback used when the employer name is missing.
        "workday",
        # JobSpy platform boards (jobspy.model.Site): a board, never an employer.
        "linkedin",
        "indeed",
        "zip_recruiter",
        "glassdoor",
        "google",
        "bayt",
        "naukri",
        "bdjobs",
    }
)


def is_genuine_employer_identity(value: object) -> bool:
    """Return true when ``value`` names one specific hiring employer.

    Content dedup keys on the employer so DISTINCT employers' postings never
    collapse into one Job. Empty values, the ``Unknown`` sentinel, and
    non-employer platform/board labels (job boards plus the manual-capture and
    Workday fallbacks) are shared across many employers, so they must never be
    used as an employer key: a caller that hits one falls through to creating a
    distinct Job (a safe under-merge rather than a lossy cross-employer merge).
    """

    normalized = normalize_identity_text(value)
    return bool(normalized) and normalized not in _NON_EMPLOYER_IDENTITY_LABELS


def job_content_fingerprint(
    *,
    title: object,
    company: object,
    description: object,
) -> str | None:
    """Hash title + company + description when all content signals exist."""

    normalized_title = normalize_identity_text(title)
    normalized_company = normalize_identity_text(company)
    normalized_description = normalize_description_text(description)
    if not normalized_title or not normalized_company or not normalized_description:
        return None
    payload = "\x1f".join((normalized_title, normalized_company, normalized_description))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def content_match_basis(
    *,
    incoming_key: str,
    candidate_title: object,
    candidate_employer: object,
    candidate_descriptions: Iterable[object],
) -> ContentMatchBasis | None:
    """Match complete canonical identity keys; retain distinct non-exact rows."""

    texts: list[object] = []
    for text in candidate_descriptions:
        if normalize_description_text(text) and text not in texts:
            texts.append(text)
    for text in texts:
        candidate_key = job_content_fingerprint(
            title=candidate_title,
            company=candidate_employer,
            description=text,
        )
        if candidate_key is not None and candidate_key == incoming_key:
            return "fingerprint"
    return None
