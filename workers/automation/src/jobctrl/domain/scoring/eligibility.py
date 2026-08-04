"""Shared downstream eligibility policy.

Compensation is a user preference, not a hard constraint. Keep that invariant
at the final automation boundary as well as in the scorer so historical or
imported score payloads cannot prevent materials preparation.
"""

from __future__ import annotations

import re

from jobctrl.domain.scoring.value_objects import EligibilityAssessment

ADVISORY_COMPENSATION_TERMS: tuple[str, ...] = (
    "salary",
    "compensation",
    "pay",
    "base pay",
    "base salary",
    "pay range",
    "remuneration",
    "wage",
    "ote",
    "on-target earnings",
    "earnings",
    "annual package",
    "cash package",
    "total rewards",
    "bonus",
    "benefit",
    "benefits",
    "commission",
    "equity",
)

_ADVISORY_COMPENSATION_REASON = re.compile(
    r"\b(?:salary|compensation|pay|base\s+pay|base\s+salary|pay\s+range|"
    r"remuneration|wage|ote|on-target\s+earnings|earnings|annual\s+package|"
    r"cash\s+package|total\s+rewards|bonus|benefits?|commission|equity)\b",
    re.IGNORECASE,
)
_ACTIONABLE_HARD_CONSTRAINT_REASON = re.compile(
    r"\b(?:"
    r"work\s+authori[sz](?:ation|ed)|right\s+to\s+work|work\s+permit|"
    r"sponsorship|sponsor(?:ship|ed|ing)?|visa|citizenship|"
    r"application\s+language|required\s+language|language\s+(?:is\s+)?required|"
    r"(?:must|(?:is\s+)?required\s+to|needs?\s+to)\s+"
    r"(?:speak|read|write|communicate)|"
    r"(?:language\s+)?proficiency|fluen(?:t|cy)|bilingual|native\s+speaker|"
    r"seniority|years?\s+of\s+experience|\d+\+?\s+years?|"
    r"minimum\s+experience|too\s+junior|"
    r"excluded?|exclusion|disqualif(?:y|ied|ication)|prohibited|do\s+not\s+apply|"
    r"security\s+clearance|required\s+(?:degree|licen[cs]e|certification)|"
    r"(?:degree|licen[cs]e|certification)\s+(?:is\s+)?required"
    r")\b",
    re.IGNORECASE,
)
_LEGACY_DETERMINISTIC_COMPENSATION_REASON = re.compile(
    r"posted compensation appears below profile minimum:\s*\$[\d,]+\s+vs\s+"
    r"profile minimum\s+\$[\d,]+\s+\(source jobs\.(?:salary|description),\s*"
    r"period (?:year|month|hour|day|week|unknown)(?:,\s*(?:"
    r"Source text states annual compensation\.|"
    r"Monthly amounts annualized by multiplying by 12\.|"
    r"Hourly amounts annualized by multiplying by 2,080 work hours\.|"
    r"daily rate annualized by multiplying by 260 working days|"
    r"weekly rate annualized by multiplying by 52 weeks|"
    r"amount without an explicit pay period; read as annual"
    r"))?\)\.?",
    re.IGNORECASE,
)
_REASON_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
_COMPENSATION_REASON_WORDS: frozenset[str] = frozenset(
    {
        "a",
        "above",
        "amount",
        "an",
        "and",
        "annual",
        "although",
        "appears",
        "are",
        "at",
        "base",
        "below",
        "benefit",
        "benefits",
        "bonus",
        "but",
        "candidate",
        "candidates",
        "cash",
        "commission",
        "competitive",
        "compensation",
        "discussed",
        "does",
        "earnings",
        "equity",
        "expectation",
        "expectations",
        "expected",
        "explicit",
        "falls",
        "flexible",
        "gbp",
        "higher",
        "however",
        "hourly",
        "is",
        "it",
        "later",
        "low",
        "lower",
        "maximum",
        "meet",
        "minimum",
        "monthly",
        "negotiable",
        "negotiation",
        "not",
        "of",
        "offer",
        "on",
        "open",
        "ote",
        "outside",
        "over",
        "package",
        "pay",
        "posted",
        "preference",
        "preferred",
        "profile",
        "range",
        "rate",
        "remains",
        "remuneration",
        "requirement",
        "required",
        "rewards",
        "s",
        "salary",
        "short",
        "subject",
        "target",
        "than",
        "that",
        "the",
        "this",
        "to",
        "total",
        "under",
        "usd",
        "wage",
        "whereas",
        "while",
        "within",
        "year",
        "yearly",
    }
)


def is_advisory_compensation_reason(reason: str) -> bool:
    """Return whether a purported hard blocker is compensation-only advice."""

    text = str(reason or "").strip()
    if not text or not _ADVISORY_COMPENSATION_REASON.search(text):
        return False
    if _LEGACY_DETERMINISTIC_COMPENSATION_REASON.fullmatch(text):
        return True
    words = tuple(word.lower() for word in _REASON_WORD.findall(text))
    return bool(words) and all(word in _COMPENSATION_REASON_WORDS for word in words)


def is_typed_compensation_only_reason(reason: str) -> bool:
    """Validate model-typed compensation advice without a phrase whitelist."""

    text = str(reason or "").strip()
    return bool(
        text
        and _ADVISORY_COMPENSATION_REASON.search(text)
        and not _ACTIONABLE_HARD_CONSTRAINT_REASON.search(text)
    )


def normalize_eligibility_for_downstream(
    eligibility: EligibilityAssessment,
) -> EligibilityAssessment:
    """Demote compensation hard blockers while preserving their audit text."""

    blocker_rows = tuple(
        zip(
            eligibility.hard_blockers,
            eligibility.hard_blocker_categories,
            strict=True,
        )
    )
    advisory = [
        blocker
        for blocker, category in blocker_rows
        if (
            category == "compensation_preference"
            and is_typed_compensation_only_reason(blocker)
        )
        or (category == "unknown" and is_advisory_compensation_reason(blocker))
    ]
    if not advisory:
        return eligibility
    actionable_rows = [
        (blocker, category)
        for blocker, category in blocker_rows
        if not (
            (
                category == "compensation_preference"
                and is_typed_compensation_only_reason(blocker)
            )
            or (category == "unknown" and is_advisory_compensation_reason(blocker))
        )
    ]
    return EligibilityAssessment(
        status="blocked" if actionable_rows else "warning",
        hard_blockers=tuple(blocker for blocker, _category in actionable_rows),
        hard_blocker_categories=tuple(category for _blocker, category in actionable_rows),
        warnings=(*eligibility.warnings, *advisory),
    )


def eligibility_blocks_downstream(eligibility: EligibilityAssessment) -> bool:
    """Return whether eligibility contains an actionable non-preference block."""

    normalized = normalize_eligibility_for_downstream(eligibility)
    if normalized.hard_blockers:
        return True
    # Preserve a provider's unexplained blocked status. A salary-only status is
    # changed to warning by normalization because its blocker text is known.
    return normalized.status == "blocked"
