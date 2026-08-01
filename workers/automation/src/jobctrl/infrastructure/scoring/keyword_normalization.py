"""Deterministic canonicalization for persisted score keywords."""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable
from typing import TypeAlias


NormalizedKeyword: TypeAlias = tuple[str, str, int]


def canonicalize_keywords(values: Iterable[str]) -> tuple[NormalizedKeyword, ...]:
    """Normalize score keywords while retaining their first display spelling.

    NFKC normalization and whitespace collapse form the stored display value.
    Its casefolded form is the lookup key. Duplicate lookup keys are omitted
    after their first appearance so persisted positions stay contiguous.
    """
    normalized: list[NormalizedKeyword] = []
    seen: set[str] = set()
    for value in values:
        display = " ".join(unicodedata.normalize("NFKC", value).split())
        if not display:
            continue
        lookup = display.casefold()
        if lookup in seen:
            continue
        seen.add(lookup)
        normalized.append((lookup, display, len(normalized)))
    return tuple(normalized)


__all__ = ["NormalizedKeyword", "canonicalize_keywords"]
