"""Mechanical token formats; no currency, compensation or support decisions."""

from decimal import Decimal

import pytest

from jobctrl.domain.exact_values import numeric_literals


@pytest.mark.parametrize("text,raw,amount", [
    ("ABC44,000", "ABC44,000", "44000"),
    ("XYZ12,345.67", "XYZ12,345.67", "12345.67"),
    ("ABC150k", "ABC150k", "150000"),
    ("$44,000", "44,000", "44000"),
    ("10, 20", "10", "10"),
    ("12345.", "12345", "12345"),
    ("12345;", "12345", "12345"),
    ("1,234.50.", "1,234.50", "1234.50"),
    ("ABC150k. Next sentence.", "ABC150k", "150000"),
    ("2.5M.", "2.5M", "2500000"),
])
def test_complete_literal_formats_preserve_the_exact_token_and_numeric_component(text, raw, amount):
    assert numeric_literals(text)[0] == (raw, Decimal(amount))


@pytest.mark.parametrize("text", [
    "prefix44,000", "X44,000", "12,34", "4,0000", "12345.units", "1.2.3", ".50", "3.x", "12345suffix",
])
def test_incomplete_or_embedded_tokens_cannot_supply_a_numeric_fragment(text):
    assert numeric_literals(text) == ()
