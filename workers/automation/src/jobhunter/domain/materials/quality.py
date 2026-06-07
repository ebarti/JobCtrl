"""Deterministic resume tailoring plan and quality checks.

The Materials use case owns I/O and LLM calls. This module stays pure: profile
dict + job dict + generated payload/text in, value objects out.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from jobhunter.domain.materials.value_objects import ValidationResult
from jobhunter.resume_profile import (
    get_achievement_evidence,
    get_claim_mode,
    get_experience_entries,
    get_resume_constraints,
    get_tailoring_quality_controls,
    get_writing_style,
)


SENIORITY_LEVELS = {"junior", "mid", "senior", "staff", "executive"}
SENIORITY_REQUIRED_LEVELS = {"senior", "staff", "executive"}

SENIORITY_SIGNAL_TERMS: tuple[str, ...] = (
    "own",
    "owned",
    "ownership",
    "scope",
    "influence",
    "influenced",
    "cross-team",
    "stakeholder",
    "stakeholders",
    "led",
    "lead",
    "mentor",
    "mentored",
    "architect",
    "architected",
    "strategy",
    "technical leadership",
)

EXECUTIVE_OVERREACH_MARKERS: tuple[str, ...] = (
    "company-wide strategy",
    "enterprise-wide strategy",
    "executive stakeholders",
    "board-level",
    "c-suite",
    "org-wide strategy",
    "multi-year strategy",
)

ANTI_AI_VOICE_MARKERS: tuple[str, ...] = (
    "results-driven",
    "leveraged",
    "dynamic professional",
    "impactful solutions",
    "drive value",
    "deliver value",
    "pivotal role",
    "strategic initiatives",
    "foster collaboration",
    "fostering collaboration",
    "fast-paced environment",
    "passion for",
    "unwavering commitment",
)

STANDARD_SECTION_HEADINGS: tuple[str, ...] = (
    "executive profile",
    "experience",
    "education",
    "skills",
)

_STOPWORDS: set[str] = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "build",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "our",
    "the",
    "their",
    "this",
    "to",
    "with",
    "work",
    "working",
    "role",
    "engineer",
    "engineering",
    "developer",
    "candidate",
    "team",
    "teams",
    "service",
    "services",
    "system",
    "systems",
}
_LOW_SIGNAL_JOB_KEYWORDS: set[str] = {
    "about",
    "across",
    "barcelona",
    "believe",
    "chain",
    "clinic",
    "company",
    "cool",
    "deserves",
    "europe",
    "everyone",
    "expert",
    "fast",
    "growth",
    "head",
    "health",
    "impress",
    "innovator",
    "international",
    "join",
    "largest",
    "leading",
    "love",
    "office",
    "ortho",
    "onsite",
    "rapid",
    "remote",
    "salary",
    "smile",
    "tech",
    "they",
    "worldwide",
}
_HIGH_SIGNAL_DESCRIPTION_KEYWORDS: set[str] = {
    "api",
    "architecture",
    "automation",
    "aws",
    "azure",
    "backend",
    "ci/cd",
    "cloud",
    "cost",
    "devops",
    "disaster",
    "docker",
    "gcp",
    "governance",
    "incident",
    "infrastructure",
    "java",
    "javascript",
    "kafka",
    "kubernetes",
    "latency",
    "management",
    "node.js",
    "observability",
    "optimization",
    "performance",
    "platform",
    "postgres",
    "postgresql",
    "productivity",
    "python",
    "react",
    "redis",
    "reliability",
    "resiliency",
    "scalability",
    "security",
    "sre",
    "terraform",
    "typescript",
}
_HIGH_SIGNAL_DESCRIPTION_PHRASES: tuple[str, ...] = (
    "api performance",
    "backend systems",
    "ci/cd",
    "cloud governance",
    "cloud infrastructure",
    "cost optimization",
    "developer productivity",
    "disaster recovery",
    "incident management",
    "infrastructure as code",
    "platform engineering",
    "service reliability",
)

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#./-]*")
_METRIC_RE = re.compile(
    r"(?ix)"
    r"(?:\$\s?\d+(?:[,.]\d+)*(?:\.\d+)?\s?(?:k|m|b|million|billion)?)"
    r"|(?:\b\d+(?:\.\d+)?\s?%)"
    r"|(?:\b\d+(?:\.\d+)?\s?x\b)"
    r"|(?:\b\d+(?:\.\d+)?\s?"
    r"(?:ms|milliseconds?|s|sec|seconds?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"users?|customers?|engineers?|teams?|services?|systems?|pipelines?|applications?|"
    r"requests?|req/s|qps|revenue|cost|latency|uptime)\b)"
)


@dataclass(frozen=True)
class EvidencePlanItem:
    evidence_id: str
    experience_entry_id: str
    source_text: str
    scope: str
    action: str
    tools: tuple[str, ...] = ()
    metrics: tuple[str, ...] = ()
    outcome: str = ""
    seniority_signal: str = ""
    evidence_strength: str = ""
    claim_confidence: float = 0.0
    user_confirmed: bool = False
    tags: tuple[str, ...] = ()

    @property
    def prompt_dict(self) -> dict[str, Any]:
        return {
            "id": self.evidence_id,
            "experience_entry_id": self.experience_entry_id,
            "source_text": self.source_text,
            "scope": self.scope,
            "action": self.action,
            "tools": list(self.tools),
            "metrics": list(self.metrics),
            "outcome": self.outcome,
            "seniority_signal": self.seniority_signal,
            "evidence_strength": self.evidence_strength,
            "claim_confidence": self.claim_confidence,
            "user_confirmed": self.user_confirmed,
            "tags": list(self.tags),
        }

    @property
    def metadata_dict(self) -> dict[str, Any]:
        return {
            "id": self.evidence_id,
            "experience_entry_id": self.experience_entry_id,
            "metrics": list(self.metrics),
            "tools": list(self.tools),
            "seniority_signal": self.seniority_signal,
            "evidence_strength": self.evidence_strength,
            "user_confirmed": self.user_confirmed,
            "tags": list(self.tags),
        }


@dataclass(frozen=True)
class TailoringPlan:
    claim_mode: str
    auto_approvable_claim_modes: tuple[str, ...]
    allow_adjacent_achievement_drafts: bool
    writing_style: dict[str, Any]
    target_seniority: str
    job_keywords: tuple[str, ...] = ()
    required_evidence_ids: tuple[str, ...] = ()
    seniority_evidence_ids: tuple[str, ...] = ()
    verified_metrics: tuple[str, ...] = ()
    evidence_items: tuple[EvidencePlanItem, ...] = ()

    @property
    def evidence_by_id(self) -> dict[str, EvidencePlanItem]:
        return {item.evidence_id: item for item in self.evidence_items}

    def to_prompt_dict(self) -> dict[str, Any]:
        required = self.evidence_by_id
        return {
            "claim_mode": self.claim_mode,
            "auto_approvable_claim_modes": list(self.auto_approvable_claim_modes),
            "allow_adjacent_achievement_drafts": self.allow_adjacent_achievement_drafts,
            "writing_style": dict(self.writing_style),
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords),
            "required_evidence": [
                required[evidence_id].prompt_dict
                for evidence_id in self.required_evidence_ids
                if evidence_id in required
            ],
            "seniority_evidence_ids": list(self.seniority_evidence_ids),
            "verified_metrics": list(self.verified_metrics),
            "deterministic_checks": [
                "Use standard sections: EXECUTIVE PROFILE, EXPERIENCE, EDUCATION, SKILLS.",
                "Use only verified profile metrics or evidence metrics.",
                "Cover relevant job keywords naturally; do not stuff repeated keywords.",
                "Match seniority to the job title and responsibilities.",
                "Avoid AI-sounding stock phrases and inflated claims.",
            ],
        }

    def to_prompt_context(self) -> str:
        return (
            "TAILORING QUALITY PLAN:\n"
            + json.dumps(self.to_prompt_dict(), indent=2, ensure_ascii=False)
        )

    def to_metadata(self) -> dict[str, Any]:
        return {
            "claim_mode": self.claim_mode,
            "auto_approvable_claim_modes": list(self.auto_approvable_claim_modes),
            "allow_adjacent_achievement_drafts": self.allow_adjacent_achievement_drafts,
            "writing_style": {
                key: self.writing_style.get(key)
                for key in ("tone", "bullet_style", "verbosity", "keyword_density")
                if key in self.writing_style
            },
            "target_seniority": self.target_seniority,
            "job_keywords": list(self.job_keywords[:16]),
            "required_evidence_ids": list(self.required_evidence_ids),
            "seniority_evidence_ids": list(self.seniority_evidence_ids),
            "verified_metric_count": len(self.verified_metrics),
        }


@dataclass(frozen=True)
class TailoringQualityResult:
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    covered_keywords: tuple[str, ...] = ()
    missing_keywords: tuple[str, ...] = ()
    represented_evidence_ids: tuple[str, ...] = ()
    missing_evidence_ids: tuple[str, ...] = ()
    metric_claims: tuple[str, ...] = ()
    repeated_keywords: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    @property
    def passed(self) -> bool:
        return not self.errors

    def to_validation_result(self) -> ValidationResult:
        if self.errors:
            return ValidationResult.failure(self.errors, warnings=self.warnings)
        return ValidationResult.success(warnings=self.warnings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
            "notes": list(self.notes),
            "keyword_coverage": {
                "covered": list(self.covered_keywords),
                "missing": list(self.missing_keywords),
            },
            "evidence_support": {
                "represented_ids": list(self.represented_evidence_ids),
                "missing_ids": list(self.missing_evidence_ids),
            },
            "metric_claims": list(self.metric_claims),
            "repeated_keywords": list(self.repeated_keywords),
        }


def build_tailoring_plan(profile: dict, job: dict) -> TailoringPlan:
    controls = get_tailoring_quality_controls(profile)
    writing_style = get_writing_style(profile)
    evidence_items = tuple(_evidence_item(item) for item in get_achievement_evidence(profile))
    job_keywords = _extract_job_keywords(job)
    target_seniority = _target_seniority(job)
    seniority_evidence_ids = tuple(
        item.evidence_id for item in evidence_items if _has_seniority_signal(item)
    )
    required_evidence_ids = _select_required_evidence_ids(
        evidence_items=evidence_items,
        job_keywords=job_keywords,
        target_seniority=target_seniority,
        seniority_evidence_ids=seniority_evidence_ids,
    )
    verified_metrics = tuple(
        dict.fromkeys(
            _text_list(get_resume_constraints(profile).get("real_metrics"))
            + [metric for item in evidence_items for metric in item.metrics]
            + _baseline_experience_metrics(profile)
        )
    )

    return TailoringPlan(
        claim_mode=get_claim_mode(profile),
        auto_approvable_claim_modes=tuple(
            str(mode) for mode in controls.get("auto_approvable_claim_modes", [])
        ),
        allow_adjacent_achievement_drafts=bool(
            controls.get("allow_adjacent_achievement_drafts", False)
        ),
        writing_style=writing_style,
        target_seniority=target_seniority,
        job_keywords=job_keywords,
        required_evidence_ids=required_evidence_ids,
        seniority_evidence_ids=seniority_evidence_ids,
        verified_metrics=verified_metrics,
        evidence_items=evidence_items,
    )


def evaluate_tailoring_quality(
    tailored_payload: dict,
    tailored_text: str,
    plan: TailoringPlan,
) -> TailoringQualityResult:
    payload_text = _payload_text(tailored_payload)
    text_lower = _normalize_space(tailored_text).lower()
    generated_lower = _normalize_space(payload_text).lower()

    errors: list[str] = []
    warnings: list[str] = []
    notes: list[str] = []

    missing_sections = [
        heading for heading in STANDARD_SECTION_HEADINGS if heading not in text_lower
    ]
    if missing_sections:
        errors.append("Missing standard resume sections: " + ", ".join(missing_sections))

    represented_evidence_ids, missing_evidence_ids = _check_required_evidence(
        generated_lower, plan
    )
    if missing_evidence_ids:
        errors.append(
            "Missing required evidence support: " + ", ".join(missing_evidence_ids)
        )

    metric_claims, unknown_metrics = _check_metrics(generated_lower, plan)
    for metric in unknown_metrics:
        errors.append(f"Unknown metric not found in verified profile evidence: {metric}")

    covered_keywords, missing_keywords = _keyword_coverage(generated_lower, plan.job_keywords)
    if plan.job_keywords:
        coverage_ratio = len(covered_keywords) / len(plan.job_keywords)
        if len(plan.job_keywords) >= 4 and not covered_keywords:
            errors.append("Keyword coverage extremely empty: no target job keywords covered")
        elif len(plan.job_keywords) >= 4 and coverage_ratio < 0.25:
            warnings.append(
                "Low keyword coverage: covered "
                f"{len(covered_keywords)}/{len(plan.job_keywords)} target keywords"
            )

    repeated_keywords = _keyword_repetition(generated_lower, plan.job_keywords)
    for item in repeated_keywords:
        term = str(item["keyword"])
        count = int(item["count"])
        if count >= 9:
            errors.append(f"Keyword stuffing: '{term}' repeated {count} times")
        elif count >= 5:
            warnings.append(f"Keyword repetition: '{term}' repeated {count} times")

    repeated_word = _consecutive_repeated_word(generated_lower)
    if repeated_word:
        warnings.append(f"Unusual repetition: '{repeated_word}' repeated consecutively")

    if (
        plan.target_seniority in SENIORITY_REQUIRED_LEVELS
        and plan.seniority_evidence_ids
        and not _has_seniority_output_signal(generated_lower)
    ):
        errors.append(
            "Seniority mismatch: senior/staff role needs ownership, scope, or "
            "influence language supported by profile evidence"
        )
    if plan.target_seniority in {"junior", "mid"}:
        found_overreach = [
            marker for marker in EXECUTIVE_OVERREACH_MARKERS if marker in generated_lower
        ]
        if found_overreach:
            warnings.append(
                "Executive phrasing for non-senior job: "
                + ", ".join(found_overreach[:3])
            )

    found_voice = [marker for marker in ANTI_AI_VOICE_MARKERS if marker in generated_lower]
    if len(found_voice) >= 3:
        errors.append("AI-sounding voice markers: " + ", ".join(found_voice[:5]))
    elif found_voice:
        warnings.append("AI-sounding voice markers: " + ", ".join(found_voice[:5]))

    if covered_keywords:
        notes.append(
            f"Keyword coverage: {len(covered_keywords)}/{len(plan.job_keywords)}"
        )
    if represented_evidence_ids:
        notes.append("Represented evidence: " + ", ".join(represented_evidence_ids))

    return TailoringQualityResult(
        errors=tuple(errors),
        warnings=tuple(warnings),
        notes=tuple(notes),
        covered_keywords=covered_keywords,
        missing_keywords=missing_keywords,
        represented_evidence_ids=represented_evidence_ids,
        missing_evidence_ids=missing_evidence_ids,
        metric_claims=metric_claims,
        repeated_keywords=tuple(repeated_keywords),
    )


def _evidence_item(item: dict) -> EvidencePlanItem:
    return EvidencePlanItem(
        evidence_id=str(item.get("id", "")).strip(),
        experience_entry_id=str(item.get("experience_entry_id", "")).strip(),
        source_text=str(item.get("source_text", "")).strip(),
        scope=str(item.get("scope", "")).strip(),
        action=str(item.get("action", "")).strip(),
        tools=tuple(_text_list(item.get("tools"))),
        metrics=tuple(_text_list(item.get("metrics"))),
        outcome=str(item.get("outcome", "")).strip(),
        seniority_signal=str(item.get("seniority_signal", "")).strip(),
        evidence_strength=str(item.get("evidence_strength", "")).strip(),
        claim_confidence=float(item.get("claim_confidence") or 0.0),
        user_confirmed=bool(item.get("user_confirmed", False)),
        tags=tuple(_text_list(item.get("tags"))),
    )


def _select_required_evidence_ids(
    *,
    evidence_items: tuple[EvidencePlanItem, ...],
    job_keywords: tuple[str, ...],
    target_seniority: str,
    seniority_evidence_ids: tuple[str, ...],
) -> tuple[str, ...]:
    if not evidence_items:
        return ()

    scored: list[tuple[int, str]] = []
    keyword_set = set(job_keywords)
    for item in evidence_items:
        evidence_terms = _evidence_terms(item)
        overlap = len(keyword_set & evidence_terms)
        if overlap:
            scored.append((overlap, item.evidence_id))

    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    selected = [evidence_id for _, evidence_id in scored[:3]]
    if target_seniority in SENIORITY_REQUIRED_LEVELS:
        for evidence_id in seniority_evidence_ids:
            if evidence_id not in selected:
                selected.append(evidence_id)
                break
    return tuple(selected)


def _extract_job_keywords(job: dict) -> tuple[str, ...]:
    ordered: list[str] = []

    for key in (
        "title",
        "role_title",
        "skills",
        "required_skills",
        "preferred_skills",
        "responsibilities",
        "requirements",
        "signals",
        "matched_signals",
        "missing_signals",
        "transferable_signals",
        "score_keywords",
        "keywords",
    ):
        for value in _flatten_text(job.get(key)):
            _append_keywords(ordered, value, include_phrase=key != "title")

    for key in ("score_breakdown", "score_breakdown_json", "score_reasoning"):
        for value in _flatten_text(job.get(key)):
            _append_keywords(ordered, value, include_phrase=False)

    description = " ".join(
        str(job.get(key) or "") for key in ("full_description", "description")
    )
    _append_description_keywords(ordered, description)

    return tuple(ordered[:32])


def _target_seniority(job: dict) -> str:
    text = _normalize_space(
        " ".join(
            str(job.get(key) or "")
            for key in ("title", "role_title", "full_description", "description")
        )
    ).lower()
    if re.search(r"\b(intern|internship|junior|entry[- ]level|graduate|associate)\b", text):
        return "junior"
    if re.search(r"\b(vp|vice president|director|head of|executive)\b", text):
        return "executive"
    if re.search(r"\b(staff|principal|lead|architect)\b", text):
        return "staff"
    if re.search(r"\b(senior|sr\.)\b", text):
        return "senior"
    return "mid"


def _append_keywords(ordered: list[str], value: str, *, include_phrase: bool) -> None:
    phrase = _normalize_phrase(value)
    if include_phrase and 1 < len(phrase.split()) <= 4:
        _add_keyword(ordered, phrase)
    for token in _significant_tokens(value):
        _add_keyword(ordered, token)


def _append_description_keywords(ordered: list[str], value: str) -> None:
    normalized = _normalize_phrase(value)
    for phrase in _HIGH_SIGNAL_DESCRIPTION_PHRASES:
        if _contains_term(normalized, phrase):
            _add_keyword(ordered, phrase, require_high_signal=True)
    tokens = _significant_tokens(value)
    for token in tokens:
        _add_keyword(ordered, token, require_high_signal=True)


def _add_keyword(
    ordered: list[str],
    keyword: str,
    *,
    require_high_signal: bool = False,
) -> None:
    keyword = _normalize_phrase(keyword)
    if not keyword or not _is_keyword_candidate(keyword, require_high_signal=require_high_signal):
        return
    if keyword not in ordered:
        ordered.append(keyword)


def _is_keyword_candidate(keyword: str, *, require_high_signal: bool) -> bool:
    tokens = keyword.split()
    if not tokens:
        return False
    if all(token in _STOPWORDS or token in _LOW_SIGNAL_JOB_KEYWORDS or token.isdigit() for token in tokens):
        return False
    if require_high_signal:
        return any(token in _HIGH_SIGNAL_DESCRIPTION_KEYWORDS for token in tokens)
    if len(tokens) == 1:
        token = tokens[0]
        if token in _STOPWORDS or token in _LOW_SIGNAL_JOB_KEYWORDS or token.isdigit():
            return False
    return True


def _flatten_text(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return [stripped]
        return _flatten_text(parsed)
    if isinstance(value, dict):
        items: list[str] = []
        for child in value.values():
            items.extend(_flatten_text(child))
        return items
    if isinstance(value, (list, tuple, set)):
        items = []
        for child in value:
            items.extend(_flatten_text(child))
        return items
    return [str(value).strip()] if str(value).strip() else []


def _payload_text(payload: dict) -> str:
    parts: list[str] = []
    executive = payload.get("executive_profile")
    if isinstance(executive, str):
        parts.append(executive)
    for update in payload.get("experience_updates") or []:
        if not isinstance(update, dict):
            continue
        for key in ("title", "bullets"):
            parts.extend(_flatten_text(update.get(key)))
    for update in payload.get("skill_category_updates") or []:
        if isinstance(update, dict):
            parts.extend(_flatten_text(update.get("items")))
    return "\n".join(parts)


def _check_required_evidence(
    generated_lower: str,
    plan: TailoringPlan,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    represented: list[str] = []
    missing: list[str] = []
    evidence_by_id = plan.evidence_by_id
    for evidence_id in plan.required_evidence_ids:
        item = evidence_by_id.get(evidence_id)
        if item is None:
            continue
        if _evidence_represented(generated_lower, item):
            represented.append(evidence_id)
        else:
            missing.append(evidence_id)
    return tuple(represented), tuple(missing)


def _evidence_represented(generated_lower: str, item: EvidencePlanItem) -> bool:
    if item.evidence_id and item.evidence_id.lower() in generated_lower:
        return True
    if any(_contains_metric_text(generated_lower, metric) for metric in item.metrics):
        return True
    terms = _evidence_terms(item)
    hits = [term for term in terms if _contains_term(generated_lower, term)]
    return len(hits) >= 2


def _check_metrics(
    generated_lower: str,
    plan: TailoringPlan,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    metric_claims = tuple(dict.fromkeys(_display_metric(match.group(0)) for match in _METRIC_RE.finditer(generated_lower)))
    allowed_text = " ".join(plan.verified_metrics).lower()
    unknown = tuple(
        metric for metric in metric_claims if metric and not _contains_metric_text(allowed_text, metric)
    )
    return metric_claims, unknown


def _baseline_experience_metrics(profile: dict) -> list[str]:
    metrics: list[str] = []
    for entry in get_experience_entries(profile):
        if not isinstance(entry, dict):
            continue
        for bullet in _text_list(entry.get("bullets")):
            metrics.extend(_normalize_metric(match.group(0)) for match in _METRIC_RE.finditer(bullet))
    return [metric for metric in metrics if metric]


def _keyword_coverage(
    generated_lower: str,
    job_keywords: tuple[str, ...],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    covered = tuple(keyword for keyword in job_keywords if _contains_term(generated_lower, keyword))
    missing = tuple(keyword for keyword in job_keywords if keyword not in covered)
    return covered, missing


def _keyword_repetition(
    generated_lower: str,
    job_keywords: tuple[str, ...],
) -> list[dict[str, Any]]:
    repeated: list[dict[str, Any]] = []
    for keyword in job_keywords:
        count = _term_count(generated_lower, keyword)
        if count >= 5:
            repeated.append({"keyword": keyword, "count": count})
    repeated.sort(key=lambda item: (-int(item["count"]), str(item["keyword"])))
    return repeated


def _consecutive_repeated_word(generated_lower: str) -> str:
    tokens = [token for token in _WORD_RE.findall(generated_lower) if token]
    if not tokens:
        return ""
    run_word = tokens[0]
    run_length = 1
    for token in tokens[1:]:
        if token == run_word:
            run_length += 1
            if run_length >= 4 and token not in {"and", "or"}:
                return token
        else:
            run_word = token
            run_length = 1
    return ""


def _has_seniority_signal(item: EvidencePlanItem) -> bool:
    text = _normalize_space(
        " ".join(
            [
                item.scope,
                item.action,
                item.outcome,
                item.seniority_signal,
                item.source_text,
            ]
        )
    ).lower()
    return any(term in text for term in SENIORITY_SIGNAL_TERMS)


def _has_seniority_output_signal(generated_lower: str) -> bool:
    return any(term in generated_lower for term in SENIORITY_SIGNAL_TERMS)


def _evidence_terms(item: EvidencePlanItem) -> set[str]:
    values = [
        item.source_text,
        item.scope,
        item.action,
        item.outcome,
        item.seniority_signal,
        *item.tools,
        *item.metrics,
        *item.tags,
    ]
    terms: set[str] = set()
    for value in values:
        terms.update(_significant_tokens(value))
    return terms


def _significant_tokens(text: str) -> list[str]:
    tokens = []
    for token in _WORD_RE.findall(str(text).lower()):
        token = token.strip("./-")
        if len(token) < 3 or token in _STOPWORDS or token in _LOW_SIGNAL_JOB_KEYWORDS:
            continue
        tokens.append(token)
    counts = Counter(tokens)
    return list(dict.fromkeys(token for token in tokens if counts[token] >= 1))


def _contains_term(text: str, term: str) -> bool:
    term = _normalize_phrase(term)
    if not term:
        return False
    if " " in term:
        return term in text
    return re.search(r"(?<![a-z0-9+#./-])" + re.escape(term) + r"(?![a-z0-9+#./-])", text) is not None


def _term_count(text: str, term: str) -> int:
    term = _normalize_phrase(term)
    if not term:
        return 0
    if " " in term:
        return text.count(term)
    return len(
        re.findall(
            r"(?<![a-z0-9+#./-])" + re.escape(term) + r"(?![a-z0-9+#./-])",
            text,
        )
    )


def _contains_metric_text(text: str, metric: str) -> bool:
    normalized_metric = _normalize_metric(metric)
    if not normalized_metric:
        return False
    return normalized_metric in _normalize_metric(text)


def _normalize_metric(value: str) -> str:
    return re.sub(r"\s+", "", str(value).lower().replace(",", "")).strip(".")


def _display_metric(value: str) -> str:
    return re.sub(r"\s+", " ", str(value).strip().replace(",", "")).strip(".")


def _normalize_phrase(value: str) -> str:
    return " ".join(_WORD_RE.findall(str(value).lower())).strip()


def _normalize_space(value: str) -> str:
    return " ".join(str(value or "").split())


def _text_list(value: object) -> list[str]:
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


__all__ = [
    "ANTI_AI_VOICE_MARKERS",
    "EvidencePlanItem",
    "TailoringPlan",
    "TailoringQualityResult",
    "build_tailoring_plan",
    "evaluate_tailoring_quality",
]
