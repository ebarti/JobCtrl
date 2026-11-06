"""Independent checks of one grounded employer-analysis proposal."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from jobctrl.domain.determinations import DeterminationEnvelope
from jobctrl.domain.enrichment.interpretation import JobInterpretation
from jobctrl.domain.ports.claim_verification import ClaimVerification


@dataclass(frozen=True)
class AnalysisCheckResults:
    claims: tuple[ClaimVerification, DeterminationEnvelope]
    interpretation: JobInterpretation


class AnalysisChecks(Protocol):
    def review(
        self, *, claim_request: dict[str, Any], interpretation_request: dict[str, Any],
        execution_guard: Callable[[], None] | None = None,
    ) -> AnalysisCheckResults: ...
