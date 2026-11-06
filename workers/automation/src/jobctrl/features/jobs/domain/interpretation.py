"""Posting semantics determined once for the canonical job snapshot."""

from __future__ import annotations

from typing import Generic, TypeVar
from pydantic import Field, StrictStr

from jobctrl.semantic import Citation, DeterminationModel

T = TypeVar("T")


class InterpretedField(DeterminationModel, Generic[T]):
    value: T
    citations: list[Citation] = Field(min_length=1, max_length=8)
    rationale: StrictStr = Field(min_length=1, max_length=1000)
