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

The numeric/date/title/employer arms have no concept of a *skill or tool*, so a
fabricated in-demand technology (Kubernetes, Terraform, Kafka, …) woven into an
experience bullet or the executive summary would slip past them. The sibling
skill/tool gate (:func:`scan_prose_skill_fabrications`) closes that leak with an
allowlist, not a denylist: it flags a job-TARGET skill/tool keyword that appears
in the generated prose but traces to NEITHER the candidate's profile-backed skill
vocabulary (:func:`build_skill_vocabulary`) NOR the evidence corpus. Only
recognised target keywords are ever candidates, so ordinary English words are
never flagged; matching is word-boundary anchored so ``go`` never fires inside
``goals``. Claiming a technology the candidate cannot discuss is interview-fatal,
so a hit is HARD-REJECTED exactly like an invented metric.

This module has NO LLM call and NO I/O. It is unit-tested directly.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.materials.services import _build_allowed_skill_terms
from jobhunter.domain.materials.value_objects import ControlRule
from jobhunter.resume_profile import (
    get_achievement_evidence,
    get_education_entries,
    get_experience_entries,
    get_resume_constraints,
)

_WHITESPACE_RE = re.compile(r"\s+")
# Word-form terms (letters/digits/spaces) match on word boundaries so ``go`` never
# fires inside ``goals``; punctuated tool names (``c++``, ``node.js``) fall back to
# literal containment where ``\b`` is meaningless. Mirrors ``services._contains_watch_term``.
_WORD_FORM_TERM_RE = re.compile(r"[a-z0-9 ]+")

# Numeric/metric tokens: money, percentages, multipliers, and bare numbers with a
# unit or magnitude. Mirrors the metric grammar used by the quality evaluator so
# the detector and the validator agree on what counts as a "number" in a bullet.
#
# Magnitude-suffix adjacency is deliberate (CONTROL-03 precision):
#   * a SINGLE-LETTER suffix (k/m/b) is consumed ONLY when it directly abuts the
#     digits — ``$5K`` / ``10M`` — never across a space, so a grounded ``$1,200,000
#     budget`` does NOT have the "b" of "budget" eaten into the token (which would
#     mint a phantom ``money:1.2e15`` and hard-reject a real figure);
#   * the SPELLED-OUT words (million/billion) may take one optional space —
#     ``$1.2 million`` / ``35 million`` — because a whole magnitude word cannot be
#     the accidental first letter of an ordinary following word.
# The bare-magnitude branch comes BEFORE the plain bare-number branch so the
# suffix is consumed with its digits (``10M`` keys ``bare:10000000``, not ``10``).
_NUMERIC_RE = re.compile(
    r"(?ix)"
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?(?:k|m|b|\s?million|\s?billion)?)"  # money (suffix adjacent unless spelled out)
    r"|(?:\b\d+(?:\.\d+)?\s?%)"  # percentage
    r"|(?:\b\d+(?:\.\d+)?\s?x\b)"  # multiplier
    r"|(?:\b\d[\d,]*(?:\.\d+)?(?:k|m|b|\s?million|\s?billion)\b)"  # bare magnitude (no $): "10M", "5K", "35 million"
    r"|(?:\b\d[\d,]*(?:\.\d+)?\+?\b)"  # bare integer/decimal (incl. "5+")
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
# profile evidence corpus (CONTROL never_fabricate_titles). Keep this regex
# precision-biased: standalone "lead" is often a verb in prose, so only explicit
# lead-title phrases are classified as title claims.
_TITLE_TOKEN_RE = re.compile(
    r"(?ix)\b("
    r"chief|cto|ceo|cio|vp|vice\s+president|director|head\s+of|principal|staff|"
    r"senior|sr\.?|"
    r"lead\s+(?:engineer|developer|architect|manager)|"
    r"(?:engineering|technical|software|platform|security|backend|frontend|product|team)\s+lead|"
    r"architect|founder|co-?founder|manager|executive"
    r")\b"
)

# A company-like proper noun anchored by an explicit company suffix. Anchoring on
# the suffix keeps the employer check PRECISE: it fires on "Globex Corporation" /
# "Initech Inc." but never on ordinary prose like "with Python" or "for Docker",
# which a bare "<preposition> <Capitalized word>" heuristic would wrongly flag.
#
# KNOWN, INTENTIONAL LIMITATION (precision-over-recall, by design): a *bare-name*
# fabricated employer with no corporate suffix — e.g. "Owned the API at Netflix."
# — is deliberately NOT flagged at this deterministic layer, and that gap is
# acceptable for three concrete reasons:
#   1. The resume's per-entry employer is CODE-INJECTED from the master resume in
#      the assembler (``services.py`` ``entry.get("company")``), never authored by
#      the model, so the structured employer field cannot be fabricated through
#      this path. The model only authors bullet / summary / title prose.
#   2. A bare capitalised token is genuinely ambiguous with tools, products, and
#      methodologies ("Python", "Docker", "Kafka"); a non-suffix heuristic would
#      over-flag ordinary prose and falsely reject clean resumes.
#   3. The LLM judge is a second, prose-aware gate that explicitly fails
#      "unsupported ... employers" (see ``use_cases.py`` judge prompt), so a model
#      inventing a bare-name employer inside prose is caught there, not silently.
# The residual risk is therefore deferred to the judge by design — do NOT try to
# flag all bare names here. ``test_detector_defers_bare_name_employer_to_judge``
# pins this contract.
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


def _term_in_normalized_text(term: str, normalized_text: str) -> bool:
    """Word-boundary containment of an already-normalised ``term`` in normalised text.

    The shared boundary primitive for the skill/tool gate — used both when checking
    whether a target keyword appears in generated prose and when grounding it against
    the evidence corpus. Word-form terms are anchored on ``\\b`` so ``go`` never fires
    inside ``goals``; punctuated tool names fall back to literal containment.
    """
    if not term:
        return False
    if _WORD_FORM_TERM_RE.fullmatch(term):
        return re.search(r"\b" + re.escape(term) + r"\b", normalized_text) is not None
    return term in normalized_text


def _digits_only(token: str) -> str:
    """Return only the digit/decimal characters of a token for date matching.

    A four-digit year renders identically everywhere, so dates ground on the bare
    digit run (numbers use the stricter :func:`_normalize_numeric` instead).
    """
    return re.sub(r"[^\d.]", "", token).strip(".")


# Magnitude words/suffixes a money token may carry, resolved to a multiplier so a
# bullet's ``$1.2M`` and the evidence's ``1.2 million`` collapse to the same value.
_MAGNITUDE_FACTORS: dict[str, int] = {
    "k": 1_000,
    "m": 1_000_000,
    "b": 1_000_000_000,
    "million": 1_000_000,
    "billion": 1_000_000_000,
}
_MAGNITUDE_RE = re.compile(r"(?i)(k|m|b|million|billion)\b\.?$")


def _normalize_numeric(token: str) -> str | None:
    """Canonicalise a numeric token to a ``kind:value`` key for grounding.

    Grounding on the bare digit run is unsafe: a fabricated ``$35M`` or
    ``35 million`` would "match" an unrelated profile ``35%`` because all three
    share the digit run ``35`` (the reviewer's digit-collision case). Instead we
    key on the token's KIND (percentage / currency / multiplier / bare number)
    *and* its magnitude-resolved value, so a number with a different unit or
    magnitude than any profile number is no longer silently grounded.

    Equivalent renderings of the SAME quantity still collapse: ``$1.2M`` /
    ``$1.2 million`` / ``$1,200,000`` all key to ``money:1200000``, so genuine
    formatting differences do not produce false fabrication flags.

    Returns ``None`` when the token carries no significant digits.
    """
    lowered = token.strip().lower()
    # Commas are thousands separators (US format); drop them so ``1,200,000``
    # parses as a number while ``1.2`` keeps its decimal point.
    number_text = re.sub(r"[^\d.]", "", lowered.replace(",", "")).strip(".")
    if not number_text:
        return None

    if lowered.startswith("$"):
        kind = "money"
    elif "%" in lowered:
        kind = "pct"
    elif re.search(r"\dx\b", lowered) or lowered.endswith("x"):
        kind = "mult"
    else:
        kind = "bare"

    try:
        value = float(number_text)
    except ValueError:
        return None
    magnitude = _MAGNITUDE_RE.search(lowered)
    if magnitude:
        value *= _MAGNITUDE_FACTORS[magnitude.group(1).lower()]

    # Render the value canonically: integers without a trailing ``.0`` so the
    # corpus key for ``5`` and the bullet key for ``5`` are byte-equal.
    canonical = format(value, ".4f").rstrip("0").rstrip(".") if value % 1 else str(int(value))
    return f"{kind}:{canonical}"


@dataclass(frozen=True)
class EvidenceCorpus:
    """The canonical profile text + token sets a real bullet fact must trace to.

    Assembled once from profile data via :func:`build_evidence_corpus`. ``text``
    is the normalised concatenation of every grounded source; the token sets are
    pre-extracted so per-bullet checks are cheap and deterministic.
    """

    text: str
    numeric_keys: frozenset[str]
    title_tokens: frozenset[str]
    date_tokens: frozenset[str]

    def contains_phrase(self, phrase: str) -> bool:
        normalized = _normalize(phrase)
        return bool(normalized) and normalized in self.text

    def contains_term(self, term: str) -> bool:
        """Word-boundary containment of a skill/tool term in the evidence text.

        Stricter than :meth:`contains_phrase` (which is a raw substring test): a
        term the candidate demonstrably wrote about (``latency`` in a real bullet)
        grounds, while a substring coincidence does not falsely ground it.
        """
        return _term_in_normalized_text(_normalize(term), self.text)

    def has_numeric(self, token: str) -> bool:
        key = _normalize_numeric(token)
        if key is None:
            return True  # nothing numeric to ground
        # Grounded only when a profile number of the SAME kind + magnitude exists
        # — a different-unit/different-magnitude number sharing the digit run
        # (``$35M`` vs a profile ``35%``) is no longer silently grounded.
        return key in self.numeric_keys

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
      * profile experience metadata — total years, current role/company, target
        role context;
      * resume baseline summary — canonical source-profile positioning text;
      * experience entries — titles, companies, date ranges, locations, bullets;
      * achievement evidence items — source text, metrics, tools, outcomes,
        scope, seniority signals;
      * resume constraints — the user's declared ``real_metrics``;
      * education entries — degrees, institutions, dates.

    Returns an :class:`EvidenceCorpus` whose token sets the detector checks each
    generated bullet against.
    """
    fragments: list[str] = []
    _collect(profile.get("experience"), fragments)
    _collect(profile.get("resume", {}).get("executive_profile"), fragments)

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
    numeric_keys = frozenset(
        key for token in _NUMERIC_RE.findall(text) if (key := _normalize_numeric(token))
    )
    date_tokens = frozenset(
        digits for token in _DATE_RE.findall(text) if (digits := _digits_only(token))
    )
    title_tokens = frozenset(_normalize(token) for token in _TITLE_TOKEN_RE.findall(text))
    return EvidenceCorpus(
        text=text,
        numeric_keys=numeric_keys,
        title_tokens=title_tokens,
        date_tokens=date_tokens,
    )


@dataclass(frozen=True)
class FabricationFinding:
    """One token in a generated bullet that does not trace to profile evidence."""

    bullet_id: str
    kind: str  # "numeric" | "date" | "title" | "employer" | "skill"
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
    # Bare-name fabricated employers ("at Netflix") are deliberately deferred to
    # the LLM judge — see the ``_EMPLOYER_RE`` limitation note above.
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


# ---------------------------------------------------------------------------
# Skill/tool fabrication gate (allowlist) — the sibling of the numeric detector
# ---------------------------------------------------------------------------


def build_skill_vocabulary(profile: dict) -> frozenset[str]:
    """Normalised allowlist of the candidate's profile-backed skill/tool terms.

    The set the prose skill/tool gate trusts as "the candidate really has this":
    the exact skill-category items the skills-section allowlist already validates
    (:func:`~jobhunter.domain.materials.services._build_allowed_skill_terms`) UNION
    every tool recorded on an achievement-evidence item. A job-target skill/tool
    absent from BOTH this set and the evidence corpus but woven into a generated
    bullet or the executive summary is a fabrication (an allowlist gate, never a
    denylist that would drift as tooling changes).
    """
    terms: set[str] = set()
    for item in _build_allowed_skill_terms(profile):
        if normalized := _normalize(item):
            terms.add(normalized)
    for evidence in get_achievement_evidence(profile):
        if not isinstance(evidence, dict):
            continue
        for tool in evidence.get("tools") or ():
            if normalized := _normalize(str(tool)):
                terms.add(normalized)
    return frozenset(terms)


def scan_prose_skill_fabrications(
    bullets: list[tuple[str, str]],
    *,
    target_skill_terms: Iterable[str],
    allowed_skill_terms: Iterable[str],
    corpus: EvidenceCorpus,
) -> list[FabricationFinding]:
    """Flag any job-target skill/tool woven into prose the profile cannot back.

    The prose analogue of :func:`scan_resume_bullets` for skills/tools (the
    numeric/date/title/employer arms have no concept of a tool). ``bullets`` are
    the ``(bullet_id, generated_text)`` pairs for the EXPERIENCE bullets +
    EXECUTIVE SUMMARY only — the skills SECTION is governed by the skills-section
    allowlist, not this prose gate.

    A finding fires when a job-target skill/tool keyword appears in the prose
    (word-boundary anchored) but grounds in NEITHER the candidate's profile-backed
    skill vocabulary (``allowed_skill_terms``) NOR the evidence corpus. Grounding
    against the corpus keeps false positives near zero: a concept term the
    candidate demonstrably wrote about (``latency`` in a real bullet) is allowed,
    while a named tool that appears nowhere in their materials is rejected. Only
    recognised target keywords are ever candidates, so ordinary English words are
    never flagged; single/two-character targets are skipped (mirroring the
    skills-section watchlist) so an ambiguous ``go``/``r`` cannot false-fire.
    """
    allowed = {norm for term in allowed_skill_terms if (norm := _normalize(term))}
    # First-seen original casing per normalised term, for a readable audit message.
    fabricated: dict[str, str] = {}
    for term in target_skill_terms:
        norm = _normalize(term)
        if len(norm) <= 2 or norm in fabricated or norm in allowed:
            continue
        if corpus.contains_term(norm):
            continue
        fabricated[norm] = term.strip()
    if not fabricated:
        return []

    findings: list[FabricationFinding] = []
    for bullet_id, generated_text in bullets:
        normalized_text = _normalize(generated_text)
        if not normalized_text:
            continue
        for norm, original in fabricated.items():
            if _term_in_normalized_text(norm, normalized_text):
                findings.append(
                    FabricationFinding(
                        bullet_id=bullet_id,
                        kind="skill",
                        token=original,
                        control=ControlRule.NEVER_FABRICATE_SKILLS,
                        generated_text=generated_text,
                    )
                )
    return findings


__all__ = [
    "EvidenceCorpus",
    "FabricationError",
    "FabricationFinding",
    "build_evidence_corpus",
    "build_skill_vocabulary",
    "employer_name_set",
    "find_fabricated_tokens",
    "scan_prose_skill_fabrications",
    "scan_resume_bullets",
]
