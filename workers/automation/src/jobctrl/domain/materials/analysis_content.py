"""Validate candidate prose at generation boundaries, without breaking legacy reads."""

from __future__ import annotations

import re

from jobctrl.domain.materials.analysis import JobAnalysis


# These expressions identify narration about producing the artifact, not mentions
# of experts, analysis, or models as actual candidate skills/responsibilities.
_PROCESS_COMMENTARY = re.compile(
    r"\b(?:both|all|the|these|our|\d+)\s+(?:independent\s+)?"
    r"(?:experts?|models?|drafts?|analyses|assessments?)\s+"
    r"(?:(?:have|has|had|are|were|was|is)\s+)?"
    r"(?:converg(?:e[ds]?|ing)|agre(?:e[ds]?|eing)|suggest(?:s|ed|ing)?|indicat(?:e[ds]?|ing)|"
    r"highlight(?:s|ed|ing)?|emphasiz(?:e[ds]?|ing)|identif(?:y|ies|ied|ying)|point(?:s|ed|ing)?|"
    r"describ(?:e[ds]?|ing)|recogniz(?:e[ds]?|ing)|concur(?:s|red|ring)?)\b"
    r"|\b(?:this|the|our)\s+(?:analysis|synthesis|reconciliation|assessment)\s+"
    r"(?:(?:have|has|had|are|were|was|is)\s+)?"
    r"(?:show(?:s|ed|n|ing)?|suggest(?:s|ed|ing)?|indicat(?:e[ds]?|ing)|reveal(?:s|ed|ing)?|"
    r"identif(?:y|ies|ied|ying)|conclud(?:e[ds]?|ing)|find(?:s|ing)?|found|"
    r"combin(?:e[ds]?|ing)|reconcil(?:e[ds]?|ing))\b"
    r"|(?:^|[.!?]\s+)(?:based on|after|by)\s+(?:reviewing\s+|analyzing\s+|reconciling\s+|combining\s+)?"
    r"(?:the\s+)?(?:expert\s+)?(?:drafts?|analyses|assessments?|job (?:description|posting))\b"
    r"|\b(?:I|we)\s+(?:analyzed|reviewed|synthesized|reconciled|inferred|determined|concluded)\b",
    re.IGNORECASE,
)


class AnalysisContentError(ValueError):
    """Generated profile text describes its production rather than the candidate."""


def validate_candidate_prose(analysis: JobAnalysis) -> None:
    """Reject process commentary before acceptance; never silently strip prose."""
    for field in ("role_framing", "ideal_candidate_narrative"):
        if _PROCESS_COMMENTARY.search(getattr(analysis, field)):
            raise AnalysisContentError(
                f"{field} must describe only the candidate and role. "
                "Remove commentary about experts, drafts, agreement, analysis, or how the profile was determined."
            )
