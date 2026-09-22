"""Validate candidate prose at generation boundaries, without breaking legacy reads."""

from __future__ import annotations

import re

from jobctrl.domain.materials.analysis import JobAnalysis


# Process commentary narrates how the profile was produced: the experts, drafts,
# analyses, or model legs are the SUBJECT of a sentence or clause and they agree,
# conclude, or describe the candidate ("Both experts converge on…", "The combined
# analysis suggests…"). Domain prose uses the same nouns for the candidate's own
# work, usually as an object ("ensures the models converge under distributed
# training", "leads the assessments described in the study protocol") or in the
# passive voice ("all models are described in model cards"). The patterns below
# therefore match a process subject only at a sentence or clause start, and a
# passive participle never counts as a process verb.
_SENTENCE_START = r"(?:^\s*|(?<=[.!?;:\n\r—–(\[)\"”’'])\s*)(?:[-*•]\s+)?[\"'“‘]?"
_COUNT = r"(?:two|three|four|five|\d+)"
_ENSEMBLE_QUALIFIER = r"(?:independent|separate|individual|combined|reconciled|expert|model|ensemble)"
_SYNTHESIS_QUALIFIER = (
    r"(?:combined|overall|final|ensemble|reconciled|joint|merged|consolidated|synthesi[sz]ed|"
    r"cross-model|present|current|above|independent|expert|model)"
)

# Nouns that only name the production process. A bare or "the" subject is enough:
# "Experts converge on…", "The two drafts agree…", "Each expert identified…".
_PROCESS_SUBJECT = (
    r"(?:(?:both|all|the|these|those|our|each|every|several|multiple|one|another|"
    rf"{_COUNT}|the\s+(?:other|first|second|third|latter|former))\s+)?"
    rf"(?:{_COUNT}\s+)?(?:{_ENSEMBLE_QUALIFIER}\s+)?"
    r"(?:(?:experts?|models?|legs?)['’]s?\s+)?"
    r"(?:experts?|drafts?|analyses|(?:model\s+)?legs)"
)
# Nouns that are ordinary domain vocabulary (ML models, clinical or learning
# assessments). They read as process commentary only with a plurality or
# ensemble determiner: "Both models converge…", "The three independent models…".
_DOMAIN_NOUN_SUBJECT = (
    rf"(?:(?:both|all|several|multiple|{_COUNT})\s+(?:{_COUNT}\s+)?(?:{_ENSEMBLE_QUALIFIER}\s+)?"
    rf"|(?:the|our)\s+(?:{_COUNT}\s+(?:{_ENSEMBLE_QUALIFIER}\s+)?|{_ENSEMBLE_QUALIFIER}\s+))"
    r"(?:models?|assessments?)"
    r"|(?:each|every)\s+model"
    r"|(?:the|this|our)\s+ensemble"
)
# Singular self-reference to the analysis itself: "This analysis shows…",
# "The combined analysis suggests…", "Our assessment indicates…".
_SELF_REFERENCE_SUBJECT = (
    rf"(?:this|our)\s+(?:{_SYNTHESIS_QUALIFIER}\s+)?(?:analysis|synthesis|reconciliation|assessment|review|evaluation)"
    rf"|the\s+{_SYNTHESIS_QUALIFIER}\s+(?:analysis|synthesis|reconciliation|assessment|review|evaluation)"
    r"|(?:the|each|every|one|another|both|all)\s+(?:models?|experts?|legs?|drafts?)['’]s?\s+"
    r"(?:analysis|assessment|view|reading|conclusion|synthesis)"
)
# A bare "the analysis" is also how a security or data role names its own work
# ("the analysis identifies exploitable paths"), so it only counts as process
# commentary with a verb of conclusion or agreement, never identify/describe.
_BARE_ANALYSIS_SUBJECT = r"the\s+(?:analysis|synthesis|reconciliation)"

_ADVERB = (
    r"(?:(?:also|independently|separately|clearly|broadly|largely|strongly|consistently|unanimously|"
    r"generally|similarly|likewise|each|both|all|now)\s+)?"
)
_AGREEMENT_VERB = (
    r"(?:converge[ds]?|agree[ds]?|concur(?:s|red)?|align(?:s|ed)?|coincide[ds]?|"
    r"suggest(?:s|ed)?|indicate[ds]?|conclude[ds]?|determine[ds]?|finds?|found|show(?:s|ed|n)?|"
    r"reveal(?:s|ed)?|note[ds]?|highlight(?:s|ed)?|emphasi[sz]e[ds]?|stress(?:es|ed)?|"
    r"identif(?:y|ies|ied)|point(?:s|ed)?|describe[ds]?|recogni[sz]e[ds]?|characteri[sz]e[ds]?|"
    r"portray(?:s|ed)?|frame[ds]?|call(?:s|ed)\s+for)"
)
_AGREEMENT_PROGRESSIVE = (
    r"(?:converging|agreeing|concurring|aligning|coinciding|suggesting|indicating|concluding|"
    r"determining|finding|showing|revealing|noting|highlighting|emphasi[sz]ing|stressing|identifying|"
    r"pointing|describing|recogni[sz]ing|characteri[sz]ing|portraying|framing|calling\s+for|"
    r"aligned|agreed|unanimous|consistent|split|divided|in\s+(?:agreement|accord|consensus))"
)
_PROCESS_PREDICATE = (
    rf"\s+{_ADVERB}"
    rf"(?:(?:(?:have|has|had)\s+{_ADVERB})?{_AGREEMENT_VERB}"
    rf"|(?:are|were|was|is)\s+{_ADVERB}{_AGREEMENT_PROGRESSIVE})\b"
)
_CONCLUSION_VERB = (
    r"(?:converge[ds]?|agree[ds]?|concur(?:s|red)?|align(?:s|ed)?|coincide[ds]?|suggest(?:s|ed)?|"
    r"indicate[ds]?|conclude[ds]?|determine[ds]?|finds?|found|show(?:s|ed|n)?|reveal(?:s|ed)?)"
)
_CONCLUSION_PROGRESSIVE = (
    r"(?:converging|agreeing|concurring|aligning|coinciding|suggesting|indicating|concluding|"
    r"determining|finding|showing|revealing|aligned|agreed|consistent|in\s+(?:agreement|accord))"
)
_CONCLUSION_PREDICATE = (
    rf"\s+{_ADVERB}"
    rf"(?:(?:(?:have|has|had)\s+{_ADVERB})?{_CONCLUSION_VERB}"
    rf"|(?:are|were|was|is)\s+{_ADVERB}{_CONCLUSION_PROGRESSIVE})\b"
)

# Sentence openers that narrate the inputs: "Based on the job description, …",
# "After reconciling both drafts, …", "Across the analyses, …".
_PROCESS_OPENER = (
    r"(?:based\s+on|after|by|from|per|across|in|between|among|according\s+to|drawing\s+on|"
    r"reconciling|combining|synthesi[sz]ing|comparing|reviewing|merging|weighing|considering|analy[sz]ing)\s+"
    r"(?:(?:reviewing|analy[sz]ing|reconciling|combining|synthesi[sz]ing|comparing|merging|weighing|reading)\s+)?"
    rf"(?:(?:both|all|the|these|those|our|each|{_COUNT})\s+(?:{_COUNT}\s+)?(?:{_ENSEMBLE_QUALIFIER}\s+)?"
    r"(?:experts?|drafts?|analyses|(?:model\s+)?legs)"
    r"|(?:the\s+|this\s+)?job\s+(?:description|posting|post|ad|advert|listing)"
    r"|(?:the|this)\s+(?:posting|listing|jd|role\s+description))\b"
)
# Mid-sentence subordinate clauses with an unmistakable ensemble subject:
# "…, as both experts agree, …".
_SUBORDINATE_PROCESS = (
    r"\b(?:as|since|because|which|where|although|though|whom)\s+"
    rf"(?:both|all|these|those|the\s+{_COUNT}|{_COUNT})\s+(?:{_ENSEMBLE_QUALIFIER}\s+)?"
    rf"(?:experts|drafts|analyses|(?:model\s+)?legs){_PROCESS_PREDICATE}"
)
_FIRST_PERSON = (
    r"\b(?:I|we)\s+(?:(?:have|had|also|then|both)\s+)?"
    r"(?:analy[sz]ed|reviewed|synthesi[sz]ed|reconciled|inferred|determined|concluded|compared|merged|"
    r"combined|examined|assessed|noted|observed|identified|found|believe|think)\b"
)
_CONSENSUS = (
    rf"\bconsensus\s+(?:among|across|between|of)\s+(?:the\s+)?(?:both\s+|all\s+|{_COUNT}\s+)?"
    r"(?:independent\s+|expert\s+)?(?:drafts|analyses|(?:model\s+)?legs)\b"
)

_PROCESS_COMMENTARY = re.compile(
    "|".join(
        (
            rf"{_SENTENCE_START}(?:{_PROCESS_SUBJECT}|{_DOMAIN_NOUN_SUBJECT}|{_SELF_REFERENCE_SUBJECT}){_PROCESS_PREDICATE}",
            rf"{_SENTENCE_START}{_BARE_ANALYSIS_SUBJECT}{_CONCLUSION_PREDICATE}",
            rf"{_SENTENCE_START}{_PROCESS_OPENER}",
            _SUBORDINATE_PROCESS,
            _FIRST_PERSON,
            _CONSENSUS,
        )
    ),
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
