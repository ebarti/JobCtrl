from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping, Sequence

from jobhunter.domain.ports.retrieval import EmbeddingSearchResult
from jobhunter.domain.scoring.retrieval import (
    DisabledEmbeddingIndex,
    HybridSearchIndex,
    PostingDocument,
    SearchQuery,
    normalize_text,
    tokenize_text,
)


class _DisabledRaisingEmbeddingIndex:
    @property
    def enabled(self) -> bool:
        return False

    def rank(
        self,
        *,
        query_text: str,
        document_texts: Mapping[str, str],
        top_k: int,
    ) -> Sequence[EmbeddingSearchResult]:
        raise AssertionError("disabled embedding index should not be called")


class _ScriptedEmbeddingIndex:
    def __init__(self, *results: EmbeddingSearchResult) -> None:
        self._results = results

    @property
    def enabled(self) -> bool:
        return True

    def rank(
        self,
        *,
        query_text: str,
        document_texts: Mapping[str, str],
        top_k: int,
    ) -> Sequence[EmbeddingSearchResult]:
        return self._results[:top_k]


def test_lexical_normalization_and_ranking() -> None:
    assert normalize_text("Líder de Ingeniería, KUBERNETES!") == "lider de ingenieria kubernetes"
    assert "the" not in tokenize_text("the platform lead")

    docs = [
        PostingDocument(
            job_id="platform",
            title="Líder de Ingeniería de Plataforma",
            location="Barcelona, Spain",
            description="KUBERNETES reliability and platform teams.",
        ),
        PostingDocument(
            job_id="sales",
            title="Sales Manager",
            location="Madrid, Spain",
            description="Pipeline forecasting and enterprise sales.",
        ),
    ]

    results = HybridSearchIndex(embedding_index=DisabledEmbeddingIndex()).search(
        SearchQuery("ingenieria plataforma kubernetes barcelona"),
        docs,
        top_k=2,
    )

    assert [result.job_id for result in results] == ["platform", "sales"]
    assert results[0].lexical_score > results[1].lexical_score
    assert results[0].matched_terms == (
        "ingenieria",
        "plataforma",
        "kubernetes",
        "barcelona",
    )


def test_embedding_disabled_falls_back_to_lexical_ranking() -> None:
    docs = [
        PostingDocument(job_id="good", title="Platform Engineering Manager", description="Kubernetes SRE"),
        PostingDocument(job_id="bad", title="Retail Operations Manager", description="Store staffing"),
    ]

    results = HybridSearchIndex(embedding_index=_DisabledRaisingEmbeddingIndex()).search(
        SearchQuery("kubernetes platform leadership"),
        docs,
        top_k=2,
    )

    assert [result.job_id for result in results] == ["good", "bad"]
    assert all(result.semantic_score == 0 for result in results)


def test_hybrid_merge_combines_lexical_and_embedding_ranks() -> None:
    docs = [
        PostingDocument(
            job_id="lexical-only",
            title="Kubernetes Platform Architect",
            description="Deep platform architecture role.",
        ),
        PostingDocument(
            job_id="hybrid",
            title="Platform Lead",
            description="Engineering leadership for infrastructure teams.",
        ),
        PostingDocument(
            job_id="other",
            title="Frontend Manager",
            description="React product delivery.",
        ),
    ]
    semantic = _ScriptedEmbeddingIndex(
        EmbeddingSearchResult("hybrid", 0.99),
        EmbeddingSearchResult("lexical-only", 0.2),
    )

    results = HybridSearchIndex(embedding_index=semantic).search(
        SearchQuery("kubernetes platform leadership"),
        docs,
        top_k=3,
    )

    assert results[0].job_id == "hybrid"
    assert results[0].semantic_score == 0.99
    assert results[0].lexical_score > 0


def test_top_k_evaluation_fixture() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "hybrid_search_topk.json").read_text(
            encoding="utf-8"
        )
    )
    case = fixture["cases"][0]
    docs = [PostingDocument.from_job(job) for job in case["jobs"]]

    results = HybridSearchIndex().search(
        SearchQuery(f"{case['query']} {case['profile']['summary']}"),
        docs,
        top_k=len(case["expected_top_k"]),
    )

    assert [result.job_id for result in results] == case["expected_top_k"]
