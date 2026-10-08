"""Mechanical numeric literals; claim meaning and support remain model decisions."""

from decimal import Decimal
import re

# Format grammar only: digits, thousands separators, decimal fractions and
# explicit numeric multipliers. No names, technologies, roles or semantic words.
_NUMBER_LITERAL = re.compile(r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmM](?!\w))?(?![\w.])")


def numeric_literals(text: str) -> tuple[tuple[str, Decimal], ...]:
    result = []
    for match in _NUMBER_LITERAL.finditer(text):
        raw = match.group()
        suffix = raw[-1].lower()
        multiplier = Decimal(1000) if suffix == "k" else Decimal(1000000) if suffix == "m" else Decimal(1)
        number = raw[:-1] if suffix in {"k", "m"} else raw
        result.append((raw, Decimal(number.replace(",", "")) * multiplier))
    return tuple(result)
