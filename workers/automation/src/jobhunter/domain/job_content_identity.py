"""Content-based job identity helpers shared by discovery and scoring."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Iterable, Literal

ContentMatchBasis = Literal["fingerprint", "shingle"]
"""How an incoming posting matched an existing Job by content identity.

``fingerprint`` is an exact normalised title + employer + description hash
match; ``shingle`` is a substantial description-shingle similarity match. The
Discovery write boundary records a distinct ``DuplicateJobLink`` reason per
basis so the audit trail never overstates a fuzzy shingle match as an exact
fingerprint one.
"""


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


def content_match_basis(
    *,
    incoming_key: str,
    incoming_description: object,
    candidate_title: object,
    candidate_employer: object,
    candidate_descriptions: Iterable[object],
) -> ContentMatchBasis | None:
    """Return how an incoming posting matches a stored Job, or ``None``.

    The incoming posting is a raw board LISTING. Discovery stores the listing
    text in ``jobs.description`` and, once enriched, a much longer full text in
    ``job_enrichments.full_description``. Comparing the incoming listing only
    against the enriched text drops below the shingle threshold once the owner is
    enriched, so cross-source dedup silently stops working post-enrichment.

    Comparing like-for-like against BOTH stored texts (the listing and, if
    present, the enriched full text) and taking the strongest basis keeps dedup
    working before and after enrichment without lowering any threshold. An exact
    fingerprint against either stored text beats a shingle match against either.
    """

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
    for text in texts:
        if descriptions_substantially_match(incoming_description, text):
            return "shingle"
    return None


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
