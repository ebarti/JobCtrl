"""Content-based job identity helpers shared by discovery and scoring."""

from __future__ import annotations

import hashlib
import re
import unicodedata


_WHITESPACE_RE = re.compile(r"\s+")
_MARKDOWN_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>])")
_MARKDOWN_MARKER_RE = re.compile(r'[*_`>"]+')
_CONTENT_TOKEN_RE = re.compile(r"[\w+]+")
_DESCRIPTION_SHINGLE_SIZE = 5
_MIN_DESCRIPTION_TOKENS_FOR_SIMILARITY = 80
_DESCRIPTION_SHINGLE_JACCARD_THRESHOLD = 0.83
_ROLE_REFERENCE_SUFFIX_RE = re.compile(
    r"\s+-\s+(?=[a-z0-9-]*\d)[a-z][a-z0-9-]{2,24}$",
    re.IGNORECASE,
)
_LOCATION_REMOTE_MARKER_RE = re.compile(r"\s*\((?:remote|hybrid)\)\s*$", re.IGNORECASE)
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


def normalize_role_title_for_repost_match(value: object) -> str:
    """Return a stable role-title key for repost score-consistency checks.

    Staffing/recruiting reposts commonly append opaque requisition codes
    (for example ``"AI Security Director - TWE45972"``). Those codes are
    not part of the role identity, but arbitrary title words are. Keep the
    normalization intentionally narrow so unrelated same-city roles do not
    collapse just because their titles are generally similar.
    """

    text = normalize_identity_text(value)
    return _ROLE_REFERENCE_SUFFIX_RE.sub("", text).strip()


def role_title_has_reference_suffix(value: object) -> bool:
    """Return true when a role title carries a trailing reference code."""

    return bool(_ROLE_REFERENCE_SUFFIX_RE.search(normalize_identity_text(value)))


def normalize_location_for_repost_match(value: object) -> str:
    """Return a location key for reference-suffixed repost matching."""

    text = normalize_identity_text(value)
    text = _LOCATION_REMOTE_MARKER_RE.sub("", text)
    return _WHITESPACE_RE.sub(" ", text).strip()


def role_titles_match_as_repost(left: object, right: object) -> bool:
    """Return true for direct-title vs reference-suffixed repost matches."""

    left_title = normalize_role_title_for_repost_match(left)
    right_title = normalize_role_title_for_repost_match(right)
    if not left_title or left_title != right_title:
        return False
    if not (role_title_has_reference_suffix(left) or role_title_has_reference_suffix(right)):
        return False
    content_tokens = _CONTENT_TOKEN_RE.findall(left_title)
    return len(content_tokens) >= 3


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
    normalized_description = normalize_description_text(description)
    if description_limit is not None and description_limit > 0:
        normalized_description = normalized_description[:description_limit]
    if not normalized_title or not normalized_company or not normalized_description:
        return None
    payload = "\x1f".join((normalized_title, normalized_company, normalized_description))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def descriptions_substantially_match(left: object, right: object) -> bool:
    """Return true when two board descriptions represent the same posting."""

    left_text = normalize_description_text(left)
    right_text = normalize_description_text(right)
    if not left_text or not right_text:
        return False
    if left_text == right_text:
        return True

    left_shingles = _description_shingles(left_text)
    right_shingles = _description_shingles(right_text)
    if not left_shingles or not right_shingles:
        return False

    intersection = len(left_shingles & right_shingles)
    union = len(left_shingles | right_shingles)
    return union > 0 and intersection / union >= _DESCRIPTION_SHINGLE_JACCARD_THRESHOLD


def _description_shingles(text: str) -> set[tuple[str, ...]]:
    tokens = _CONTENT_TOKEN_RE.findall(text)
    if len(tokens) < _MIN_DESCRIPTION_TOKENS_FOR_SIMILARITY:
        return set()
    return {
        tuple(tokens[index : index + _DESCRIPTION_SHINGLE_SIZE])
        for index in range(len(tokens) - _DESCRIPTION_SHINGLE_SIZE + 1)
    }
