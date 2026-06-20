"""Posted compensation domain model and parser."""

from jobhunter.domain.compensation.posted import (
    CONFIDENCE_LEVELS,
    PARSER_VERSION,
    PARSE_STATES,
    PERIODS,
    SOURCE_TEXT_LIMIT,
    WARNING_CODES,
    PostedCompensationFact,
    parse_posted_compensation,
)

__all__ = [
    "CONFIDENCE_LEVELS",
    "PARSER_VERSION",
    "PARSE_STATES",
    "PERIODS",
    "SOURCE_TEXT_LIMIT",
    "WARNING_CODES",
    "PostedCompensationFact",
    "parse_posted_compensation",
]
