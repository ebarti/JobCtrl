"""Deterministic never-fabricate detector — the cardinal grounding gate (CONTROL-03).

The Phase-2 analogue of Phase 1's ``analysis_grounding.py``: a pure, deterministic
check that runs **independently of the tailoring prompt**. Every numeric, date,
percentage, money, title, and employer token that appears in a generated resume
bullet MUST trace to recorded profile evidence. A token that does not is a
fabrication (the category's cardinal failure — invented metrics/titles/dates/
employers) and is HARD-REJECTED at generation time — never trusted from the model,
and never expressible in a JSON schema or a prompt instruction.

Why a separate deterministic detector at all (CONTROL-03 / GROUND-05):

  * The prompt can ask the model not to fabricate; the model can ignore it. The
    detector is the *real* gate — it does not ask, it checks.
  * It runs against the **actual generated bullet text** (the rendered line the
    user sees), not the model's self-reported provenance, so a model that lies
    about its own grounding still fails here.

The "evidence corpus" is assembled once from canonical profile data (experience
bullets, evidence items, verified metrics, titles, companies, date ranges,
education) — the source of truth a real fact must appear in. Membership is decided
by literal containment after normalising only insignificant whitespace and case,
so trivial formatting differences do not produce false rejections while genuine
fabrications still fail.

This module has NO LLM call and NO I/O. It is unit-tested directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.materials.value_objects import ControlRule
from jobhunter.resume_profile import (
    get_achievement_evidence,
    get_education_entries,
    get_experience_entries,
    get_resume_constraints,
)

_WHITESPACE_RE = re.compile(r"\s+")

# Numeric/metric tokens: money, percentages, multipliers, and bare numbers with a
# unit or magnitude. Mirrors the metric grammar used by the quality evaluator so
# the detector and the validator agree on what counts as a "number" in a bullet.
_NUMERIC_RE = re.compile(
    r"(?ix)"
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?)"  # money
    r"|(?:\b\d+(?:\.\d+)?\s?%)"  # percentage
    r"|(?:\b\d+(?:\.\d+)?\s?x\b)"  # multiplier
    r"|(?:\b\d[\d,]*(?:\.\d+)?\+?\b)"  # bare integer/decimal (incl. "10k", "5+")
)

# Four-digit years and explicit month/day-month-year date spans. Standalone small
# integers are handled by ``_NUMERIC_RE``; this catches calendar dates that a
# bullet might invent (e.g. "since 2019", "Jan 2020 - Mar 2021").
_DATE_RE = re.compile(
    r"(?ix)"
    r"\b(?:19|20)\d{2}\b"  # a four-digit year
    r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}\b"
)

# Leadership/seniority title tokens whose presence in a bullet implies a claimed
# level. They are only a fabrication when the same signal is absent from the
# profile evidence corpus (CONTROL never_fabricate_titles).
_TITLE_TOKEN_RE = re.compile(
    r"(?ix)\b("
    r"chief|cto|ceo|cio|vp|vice\s+president|director|head\s+of|principal|staff|"
    r"senior|sr\.?|lead|architect|founder|co-?founder|manager|executive"
    r")\b"
)

# A company-like proper noun anchored by an explicit company suffix. Anchoring on
# the suffix keeps the employer check PRECISE: it fires on "Globex Corporation" /
# "Initech Inc." but never on ordinary prose like "with Python" or "for Docker",
# which a bare "<preposition> <Capitalized word>" heuristic would wrongly flag.
_EMPLOYER_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*)*"
    r"\s+(?:Inc|Incorporated|LLC|Ltd|Limited|Corp|Corporation|Co|Company|GmbH|PLC|AG|SA|NV|LLP)\.?)\b"
)

# Tokens that, while numeric, never imply a fabricated claim on their own — they
# are structural/sequence numbers, not metrics. Kept tiny and explicit.
_BENIGN_NUMERIC_TOKENS = frozenset({"0", "1", "2", "3", "4", "5", "24", "365", "24/7"})


def _normalize(text: str) -> str:
    """Lowercase + collapse insignificant whitespace; preserve word content.

    Case and whitespace are normalised so a quote that differs only in spacing or
    capitalisation still matches; punctuation and digits are preserved so the
    check stays a genuine literal-containment test.
    """
    return _WHITESPACE_RE.sub(" ", text).strip().lower()


def _digits_only(token: str) -> str:
    """Return only the digit/decimal characters of a token for numeric matching.

    A bullet may render ``$1.2M`` while the evidence records ``1,200,000`` or
    ``1.2 million``; matching on the run of significant digits avoids false
    fabrication flags on equivalent renderings while still catching invented
    numbers (whose digits appear nowhere in the corpus).
    """
    return re.sub(r"[^\d.]", "", token).strip(".")


@dataclass(frozen=True)
class EvidenceCorpus:
    """The canonical profile text + token sets a real bullet fact must trace to.

    Assembled once from profile data via :func:`build_evidence_corpus`. ``text``
    is the normalised concatenation of every grounded source; the token sets are
    pre-extracted so per-bullet checks are cheap and deterministic.
    """

    text: str
    numeric_digits: frozenset[str]
    title_tokens: frozenset[str]
    date_tokens: frozenset[str]

    def contains_phrase(self, phrase: str) -> bool:
        normalized = _normalize(phrase)
        return bool(normalized) and normalized in self.text

    def has_numeric(self, token: str) -> bool:
        digits = _digits_only(token)
        if not digits:
            return True  # nothing numeric to ground
        return digits in self.numeric_digits

    def has_title(self, token: str) -> bool:
        return _normalize(token) in self.title_tokens

    def has_date(self, token: str) -> bool:
        return _digits_only(token) in self.date_tokens or _normalize(token) in self.text


def _collect(value: Any, into: list[str]) -> None:
    """Flatten arbitrary nested profile values into a list of non-empty strings."""
    if value is None:
        return
    if isinstance(value, str):
        if value.strip():
            into.append(value)
    elif isinstance(value, dict):
        for child in value.values():
            _collect(child, into)
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            _collect(child, into)
    else:
        text = str(value).strip()
        if text:
            into.append(text)


def build_evidence_corpus(profile: dict) -> EvidenceCorpus:
    """Assemble the grounded-fact corpus from canonical profile data.

    Sources (the explicit source of truth for every claim a bullet may make):
      * experience entries — titles, companies, date ranges, locations, bullets;
      * achievement evidence items — source text, metrics, tools, outcomes,
        scope, seniority signals;
      * resume constraints — the user's declared ``real_metrics``;
      * education entries — degrees, institutions, dates.

    Returns an :class:`EvidenceCorpus` whose token sets the detector checks each
    generated bullet against.
    """
    fragments: list[str] = []

    for entry in get_experience_entries(profile):
        if isinstance(entry, dict):
            _collect(
                {
                    "title": entry.get("title"),
                    "company": entry.get("company"),
                    "location": entry.get("location"),
                    "date_range": entry.get("date_range"),
                    "bullets": entry.get("bullets"),
                },
                fragments,
            )

    for item in get_achievement_evidence(profile):
        if isinstance(item, dict):
            _collect(
                {
                    "source_text": item.get("source_text"),
                    "scope": item.get("scope"),
                    "action": item.get("action"),
                    "outcome": item.get("outcome"),
                    "metrics": item.get("metrics"),
                    "tools": item.get("tools"),
                    "seniority_signal": item.get("seniority_signal"),
                },
                fragments,
            )

    _collect(get_resume_constraints(profile).get("real_metrics"), fragments)

    for entry in get_education_entries(profile):
        if isinstance(entry, dict):
            _collect(
                {
                    "degree": entry.get("degree"),
                    "institution": entry.get("institution"),
                    "date": entry.get("date"),
                    "details": entry.get("details"),
                },
                fragments,
            )

    text = _normalize("\n".join(fragments))
    numeric_digits = frozenset(
        digits for token in _NUMERIC_RE.findall(text) if (digits := _digits_only(token))
    )
    date_tokens = frozenset(
        digits for token in _DATE_RE.findall(text) if (digits := _digits_only(token))
    )
    title_tokens = frozenset(_normalize(token) for token in _TITLE_TOKEN_RE.findall(text))
    return EvidenceCorpus(
        text=text,
        numeric_digits=numeric_digits,
        title_tokens=title_tokens,
        date_tokens=date_tokens,
    )


@dataclass(frozen=True)
class FabricationFinding:
    """One token in a generated bullet that does not trace to profile evidence."""

    bullet_id: str
    kind: str  # "numeric" | "date" | "title" | "employer"
    token: str
    control: ControlRule
    generated_text: str = field(default="")

    def describe(self) -> str:
        preview = self.generated_text if len(self.generated_text) <= 80 else self.generated_text[:77] + "..."
        return (
            f"bullet {self.bullet_id!r} fabricated {self.kind} {self.token!r} "
            f"(violates {self.control.value}): {preview!r}"
        )


def find_fabricated_tokens(
    bullet_id: str,
    generated_text: str,
    corpus: EvidenceCorpus,
    *,
    employers: frozenset[str] = frozenset(),
) -> list[FabricationFinding]:
    """Return every fabricated numeric/date/title/employer token in one bullet.

    An empty list means the bullet is fully grounded. ``employers`` is the set of
    normalised company names the user actually worked at (so an employer claim is
    flagged only when it names a company absent from both the corpus and that
    set).
    """
    findings: list[FabricationFinding] = []
    seen: set[tuple[str, str]] = set()

    def record(kind: str, token: str, control: ControlRule) -> None:
        key = (kind, _normalize(token))
        if key in seen:
            return
        seen.add(key)
        findings.append(
            FabricationFinding(
                bullet_id=bullet_id,
                kind=kind,
                token=token.strip(),
                control=control,
                generated_text=generated_text,
            )
        )

    # Dates first so a year is reported as a date, not a bare numeric.
    date_tokens = {_normalize(token) for token in _DATE_RE.findall(generated_text)}
    for token in _DATE_RE.findall(generated_text):
        if not corpus.has_date(token):
            record("date", token, ControlRule.NEVER_FABRICATE_DATES)

    for token in _NUMERIC_RE.findall(generated_text):
        normalized_token = _normalize(token)
        if normalized_token in _BENIGN_NUMERIC_TOKENS or normalized_token in date_tokens:
            continue
        if not corpus.has_numeric(token):
            record("numeric", token, ControlRule.NEVER_FABRICATE_METRICS)

    for token in _TITLE_TOKEN_RE.findall(generated_text):
        if not corpus.has_title(token):
            record("title", token, ControlRule.NEVER_FABRICATE_TITLES)

    # Employer claims: a company-suffixed proper noun ("Globex Corporation") that
    # is neither one of the user's real employers nor present in the evidence
    # corpus is a fabricated employer. Suffix-anchoring avoids false positives on
    # ordinary prose ("with Python") that a bare preposition heuristic would hit.
    for match in _EMPLOYER_RE.finditer(generated_text):
        candidate = _normalize(match.group(1))
        if candidate and candidate not in corpus.text and candidate not in employers:
            record("employer", match.group(1).strip(), ControlRule.NEVER_FABRICATE_EMPLOYERS)

    return findings


class FabricationError(ValueError):
    """Raised when a generated resume carries one or more fabricated tokens.

    Carries the structured findings so the tailor use case can record them as the
    rejection reason and block persistence — a candidate that fabricates a
    metric/title/date/employer is never accepted (GROUND-05 hard reject).
    """

    def __init__(self, findings: list[FabricationFinding]) -> None:
        self.findings = findings
        detail = "; ".join(f.describe() for f in findings)
        super().__init__(f"never-fabricate detector rejected {len(findings)} token(s): {detail}")


def scan_resume_bullets(
    bullets: list[tuple[str, str]],
    corpus: EvidenceCorpus,
    *,
    employers: frozenset[str] = frozenset(),
) -> list[FabricationFinding]:
    """Scan ``(bullet_id, generated_text)`` pairs; return every fabrication finding.

    The deterministic whole-resume gate. An empty result means every numeric/date/
    title/employer token in every bullet traces to profile evidence.
    """
    findings: list[FabricationFinding] = []
    for bullet_id, generated_text in bullets:
        findings.extend(
            find_fabricated_tokens(bullet_id, generated_text, corpus, employers=employers)
        )
    return findings


def employer_name_set(profile: dict) -> frozenset[str]:
    """Return the normalised set of companies the user actually worked at."""
    names: list[str] = []
    for entry in get_experience_entries(profile):
        if isinstance(entry, dict):
            company = str(entry.get("company") or "").strip()
            if company:
                names.append(_normalize(company))
    return frozenset(name for name in names if name)


__all__ = [
    "EvidenceCorpus",
    "FabricationError",
    "FabricationFinding",
    "build_evidence_corpus",
    "employer_name_set",
    "find_fabricated_tokens",
    "scan_resume_bullets",
]
