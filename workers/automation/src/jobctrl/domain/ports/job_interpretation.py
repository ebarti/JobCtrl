"""Posting meaning is owned by one persisted determination."""

from typing import Protocol
from jobctrl.domain.enrichment.interpretation import JobInterpretation


class JobInterpreter(Protocol):
    def interpret(self, *, job: dict, employer_analysis) -> JobInterpretation: ...
