"""Mechanical numeric literals; claim meaning and support remain model decisions."""

from decimal import Decimal
import re

# Format grammar only: digits, thousands separators, decimal fractions and
# explicit numeric multipliers and optional attached three-letter prefixes.
# Prefix syntax does not determine currency or any other meaning. A final
# period delimits a sentence; a period joining word characters belongs to the
# numeric/dotted token and must not expose a fragment.
_NUMBER_LITERAL = re.compile(
    r"(?<![\w.,])(?:[A-Z]{3})?(?P<number>\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmM](?!\w))?)(?!\w|\.\w|,\d)"
)


def numeric_literals(text: str) -> tuple[tuple[str, Decimal], ...]:
    result = []
    for match in _NUMBER_LITERAL.finditer(text):
        raw = match.group()
        numeric = match.group("number")
        suffix = numeric[-1].lower()
        multiplier = Decimal(1000) if suffix == "k" else Decimal(1000000) if suffix == "m" else Decimal(1)
        number = numeric[:-1] if suffix in {"k", "m"} else numeric
        result.append((raw, Decimal(number.replace(",", "")) * multiplier))
    return tuple(result)
