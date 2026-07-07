"""Hybrid retrieval used to preselect jobs for scoring.

This module is deliberately pure Python and in-memory. Discovery and
Enrichment still own producing posting data; Scoring consumes their read-side
job dictionaries as retrieval candidates before spending LLM calls.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

from jobctl.domain.ports.retrieval import EmbeddingIndexPort, EmbeddingSearchResult
from jobctl.domain.profile.snapshot import ProfileSnapshot

_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9+#.-]*")
_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "the",
        "to",
        "with",
        "you",
        "your",
        "we",
        "our",
        "their",
        "this",
        "that",
        "will",
    }
)


def normalize_text(value: object) -> str:
    """Normalize text for local lexical retrieval."""

    if value is None:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold()
    text = re.sub(r"[^a-z0-9+#.-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokenize_text(value: object) -> tuple[str, ...]:
    """Return normalized lexical tokens, excluding short stop words."""

    normalized = normalize_text(value)
    return tuple(
        token
        for token in _TOKEN_RE.findall(normalized)
        if len(token) > 1 and token not in _STOP_WORDS
    )


@dataclass(frozen=True)
class SearchQuery:
    """Search text used by lexical and optional semantic retrieval."""

    text: str

    @classmethod
    def from_profile_snapshot(
        cls,
        profile_snapshot: ProfileSnapshot,
        *,
        resume_text: str | None = None,
        query_text: str | None = None,
    ) -> "SearchQuery":
        parts: list[str] = []
        if query_text:
            parts.append(query_text)
        if resume_text:
            parts.append(resume_text)

        profile = profile_snapshot.as_dict()
        resume = _as_mapping(profile.get("resume"))
        executive = _as_mapping(resume.get("executive_profile"))
        _append_text(parts, executive.get("baseline_text"))
        for entry in _as_sequence(resume.get("experience_entries")):
            _collect_profile_text(parts, entry)
        for category in _as_sequence(resume.get("skill_categories")):
            _collect_profile_text(parts, category)

        for key in ("skills_boundary", "resume_facts", "work_authorization", "availability"):
            _collect_profile_text(parts, profile.get(key))

        return cls(text=" ".join(part for part in parts if part))


@dataclass(frozen=True)
class PostingDocument:
    """Normalized job document consumed by the retrieval service."""

    job_id: str
    title: str = ""
    company: str = ""
    location: str = ""
    description: str = ""
    requirements: tuple[str, ...] = ()
    responsibilities: tuple[str, ...] = ()
    skills: tuple[str, ...] = ()
    source_metadata: tuple[str, ...] = ()
    discovered_at: str | None = None
    source_trust: float = 0.0

    @classmethod
    def from_job(cls, job: Mapping[str, Any]) -> "PostingDocument":
        job_id = str(job.get("url") or job.get("job_id") or job.get("id") or "").strip()
        if not job_id:
            raise ValueError("PostingDocument.from_job requires a url/job_id/id")

        description = str(job.get("full_description") or job.get("description") or "")
        metadata = tuple(
            text
            for text in (
                job.get("site"),
                job.get("strategy"),
                job.get("source_id"),
                job.get("source"),
                job.get("salary"),
                job.get("verification_confidence"),
            )
            if text
        )
        return cls(
            job_id=job_id,
            title=str(job.get("title") or ""),
            company=str(job.get("company") or job.get("site") or ""),
            location=str(job.get("location") or ""),
            description=description,
            requirements=_string_tuple(job.get("requirements")),
            responsibilities=_string_tuple(job.get("responsibilities")),
            skills=_string_tuple(job.get("skills")),
            source_metadata=metadata,
            discovered_at=str(job.get("discovered_at")) if job.get("discovered_at") else None,
            source_trust=_source_trust(job),
        )

    def field_tokens(self) -> Mapping[str, tuple[str, ...]]:
        return {
            "title": tokenize_text(self.title),
            "company": tokenize_text(self.company),
            "location": tokenize_text(self.location),
            "description": tokenize_text(self.description),
            "requirements": tokenize_text(" ".join(self.requirements)),
            "responsibilities": tokenize_text(" ".join(self.responsibilities)),
            "skills": tokenize_text(" ".join(self.skills)),
            "source_metadata": tokenize_text(" ".join(self.source_metadata)),
        }

    def embedding_text(self) -> str:
        return normalize_text(
            " ".join(
                (
                    self.title,
                    self.company,
                    self.location,
                    self.description,
                    " ".join(self.requirements),
                    " ".join(self.responsibilities),
                    " ".join(self.skills),
                    " ".join(self.source_metadata),
                )
            )
        )


@dataclass(frozen=True)
class RetrievedJobCandidate:
    """Hybrid retrieval result for one job."""

    job_id: str
    rank: int
    score: float
    lexical_score: float
    semantic_score: float
    recency_score: float
    source_trust_score: float
    matched_terms: tuple[str, ...]


class DisabledEmbeddingIndex:
    """Default semantic adapter: no hosted service, lexical retrieval only."""

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
        return ()


class HybridSearchIndex:
    """BM25-style lexical retrieval plus optional semantic reciprocal-rank fusion."""

    _FIELD_WEIGHTS: Mapping[str, float] = {
        "title": 4.0,
        "skills": 3.0,
        "requirements": 2.2,
        "responsibilities": 1.6,
        "description": 1.0,
        "company": 0.8,
        "location": 1.2,
        "source_metadata": 0.5,
    }

    def __init__(
        self,
        *,
        embedding_index: EmbeddingIndexPort | None = None,
        lexical_weight: float = 1.0,
        semantic_weight: float = 1.1,
        recency_weight: float = 0.05,
        source_trust_weight: float = 0.05,
    ) -> None:
        self._embedding_index = embedding_index or DisabledEmbeddingIndex()
        self._lexical_weight = lexical_weight
        self._semantic_weight = semantic_weight
        self._recency_weight = recency_weight
        self._source_trust_weight = source_trust_weight

    def search(
        self,
        query: SearchQuery,
        documents: Sequence[PostingDocument],
        *,
        top_k: int = 20,
    ) -> list[RetrievedJobCandidate]:
        if not documents:
            return []

        limit = len(documents) if top_k <= 0 else min(top_k, len(documents))
        query_tokens = tokenize_text(query.text)
        lexical_scores, matched_terms = self._lexical_scores(query_tokens, documents)
        semantic_scores = self._semantic_scores(query, documents)
        recency_scores = _recency_scores(documents)

        if not query_tokens and not semantic_scores:
            return [
                RetrievedJobCandidate(
                    job_id=doc.job_id,
                    rank=rank,
                    score=0.0,
                    lexical_score=0.0,
                    semantic_score=0.0,
                    recency_score=recency_scores.get(doc.job_id, 0.0),
                    source_trust_score=doc.source_trust,
                    matched_terms=(),
                )
                for rank, doc in enumerate(documents[:limit], start=1)
            ]

        max_lexical = max(lexical_scores.values(), default=0.0)
        max_semantic = max(semantic_scores.values(), default=0.0)

        candidates: list[RetrievedJobCandidate] = []
        for doc in documents:
            lexical = lexical_scores.get(doc.job_id, 0.0)
            semantic = semantic_scores.get(doc.job_id, 0.0)
            score = self._lexical_weight * _normalise_component(lexical, max_lexical)
            score += self._semantic_weight * _normalise_component(semantic, max_semantic)
            recency = recency_scores.get(doc.job_id, 0.0)
            score += self._recency_weight * recency
            score += self._source_trust_weight * doc.source_trust
            candidates.append(
                RetrievedJobCandidate(
                    job_id=doc.job_id,
                    rank=0,
                    score=score,
                    lexical_score=lexical,
                    semantic_score=semantic,
                    recency_score=recency,
                    source_trust_score=doc.source_trust,
                    matched_terms=matched_terms.get(doc.job_id, ()),
                )
            )

        ordered = sorted(
            candidates,
            key=lambda item: (
                item.score,
                item.lexical_score,
                item.semantic_score,
                item.recency_score,
                item.source_trust_score,
            ),
            reverse=True,
        )[:limit]
        return [
            RetrievedJobCandidate(
                job_id=item.job_id,
                rank=index,
                score=item.score,
                lexical_score=item.lexical_score,
                semantic_score=item.semantic_score,
                recency_score=item.recency_score,
                source_trust_score=item.source_trust_score,
                matched_terms=item.matched_terms,
            )
            for index, item in enumerate(ordered, start=1)
        ]

    def _lexical_scores(
        self,
        query_tokens: tuple[str, ...],
        documents: Sequence[PostingDocument],
    ) -> tuple[dict[str, float], dict[str, tuple[str, ...]]]:
        if not query_tokens:
            return {}, {}

        doc_field_tokens = {doc.job_id: doc.field_tokens() for doc in documents}
        document_frequencies: Counter[str] = Counter()
        lengths: dict[str, int] = {}
        for doc_id, fields in doc_field_tokens.items():
            all_tokens: list[str] = []
            for tokens in fields.values():
                all_tokens.extend(tokens)
            lengths[doc_id] = max(1, len(all_tokens))
            document_frequencies.update(set(all_tokens))

        total_docs = len(documents)
        avg_len = sum(lengths.values()) / max(1, total_docs)
        scores: dict[str, float] = {}
        matches: dict[str, tuple[str, ...]] = {}
        unique_query_terms = tuple(dict.fromkeys(query_tokens))

        for doc in documents:
            fields = doc_field_tokens[doc.job_id]
            score = 0.0
            matched: list[str] = []
            for term in unique_query_terms:
                term_score = 0.0
                for field_name, tokens in fields.items():
                    tf = Counter(tokens).get(term, 0)
                    if not tf:
                        continue
                    field_weight = self._FIELD_WEIGHTS.get(field_name, 1.0)
                    term_score += field_weight * tf
                if term_score <= 0:
                    continue
                matched.append(term)
                df = max(1, document_frequencies.get(term, 0))
                idf = math.log(1 + (total_docs - df + 0.5) / (df + 0.5))
                length_norm = 1.2 * (1 - 0.75 + 0.75 * lengths[doc.job_id] / max(avg_len, 1))
                bm25_tf = (term_score * 2.2) / (term_score + length_norm)
                score += idf * bm25_tf
            if score > 0:
                scores[doc.job_id] = score
                matches[doc.job_id] = tuple(matched)

        return scores, matches

    def _semantic_scores(
        self,
        query: SearchQuery,
        documents: Sequence[PostingDocument],
    ) -> dict[str, float]:
        if not self._embedding_index.enabled:
            return {}
        document_texts = {doc.job_id: doc.embedding_text() for doc in documents}
        try:
            results = self._embedding_index.rank(
                query_text=normalize_text(query.text),
                document_texts=document_texts,
                top_k=len(documents),
            )
        except Exception:
            return {}
        return {
            result.job_id: float(result.score)
            for result in results
            if result.job_id in document_texts and float(result.score) > 0
        }


def preselect_jobs_for_scoring(
    jobs: Sequence[Mapping[str, Any]],
    *,
    profile_snapshot: ProfileSnapshot,
    top_k: int = 0,
    resume_text: str | None = None,
    search_index: HybridSearchIndex | None = None,
) -> list[Mapping[str, Any]]:
    """Rank and optionally trim jobs before LLM scoring."""

    if not jobs:
        return []
    documents = [PostingDocument.from_job(job) for job in jobs]
    query = SearchQuery.from_profile_snapshot(profile_snapshot, resume_text=resume_text)
    index = search_index or HybridSearchIndex()
    results = index.search(query, documents, top_k=top_k or len(documents))
    by_id = {doc.job_id: job for doc, job in zip(documents, jobs)}
    selected = [by_id[result.job_id] for result in results if result.job_id in by_id]
    if top_k > 0:
        return selected[:top_k]
    return selected


def _normalise_component(value: float, maximum: float) -> float:
    if value <= 0 or maximum <= 0:
        return 0.0
    return value / maximum


def _source_trust(job: Mapping[str, Any]) -> float:
    raw = normalize_text(
        job.get("verification_confidence")
        or job.get("source_quality")
        or job.get("canonical_confidence")
        or ""
    )
    if raw in {"verified", "high", "canonical", "trusted"}:
        return 1.0
    if raw in {"medium", "probable"}:
        return 0.65
    if raw in {"low", "unknown", "unverified"}:
        return 0.25
    if job.get("canonical_url") or job.get("application_url"):
        return 0.55
    return 0.35


def _recency_scores(documents: Sequence[PostingDocument]) -> dict[str, float]:
    parsed = {
        doc.job_id: _parse_datetime(doc.discovered_at)
        for doc in documents
        if doc.discovered_at
    }
    parsed = {job_id: value for job_id, value in parsed.items() if value is not None}
    if not parsed:
        return {}
    newest = max(parsed.values())
    out: dict[str, float] = {}
    for job_id, timestamp in parsed.items():
        age_days = max(0.0, (newest - timestamp).total_seconds() / 86400)
        out[job_id] = 1 / (1 + age_days / 30)
    return out


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _collect_profile_text(parts: list[str], value: object) -> None:
    if value is None:
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if str(key).casefold() in {
                "email",
                "phone",
                "address",
                "full_name",
                "preferred_name",
            }:
                continue
            _collect_profile_text(parts, item)
    elif isinstance(value, str):
        _append_text(parts, value)
    elif isinstance(value, Iterable):
        for item in value:
            _collect_profile_text(parts, item)


def _append_text(parts: list[str], value: object) -> None:
    if isinstance(value, str) and value.strip():
        parts.append(value.strip())


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_sequence(value: object) -> Sequence[object]:
    return value if isinstance(value, Sequence) and not isinstance(value, str) else ()


def _string_tuple(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, Iterable):
        return tuple(str(item) for item in value if item)
    return (str(value),)


__all__ = [
    "DisabledEmbeddingIndex",
    "HybridSearchIndex",
    "PostingDocument",
    "RetrievedJobCandidate",
    "SearchQuery",
    "normalize_text",
    "preselect_jobs_for_scoring",
    "tokenize_text",
]
