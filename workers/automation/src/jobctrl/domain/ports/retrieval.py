"""Retrieval ports used before expensive scoring work.

The Scoring context consumes ranked job candidates, but semantic embedding
storage is infrastructure. This port keeps local operation independent from
hosted embedding services: callers may inject a concrete adapter, while the
default disabled adapter lets lexical retrieval run on its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol, Sequence


@dataclass(frozen=True)
class EmbeddingSearchResult:
    """One semantic-search hit returned by an embedding adapter."""

    job_id: str
    score: float


class EmbeddingIndexPort(Protocol):
    """Optional semantic retrieval port.

    ``document_texts`` maps JobId strings to normalized posting text. Adapters
    can upsert/cache embeddings internally, call a hosted vector index, or
    decline by returning ``enabled=False``. Domain retrieval treats this port as
    advisory and falls back to lexical ranking if it is unavailable.
    """

    @property
    def enabled(self) -> bool:
        """Whether semantic retrieval is configured for the current run."""
        ...

    def rank(
        self,
        *,
        query_text: str,
        document_texts: Mapping[str, str],
        top_k: int,
    ) -> Sequence[EmbeddingSearchResult]:
        """Return semantic hits sorted best-first."""
        ...


__all__ = ["EmbeddingIndexPort", "EmbeddingSearchResult"]
