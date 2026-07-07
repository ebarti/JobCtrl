"""PR3 Enrichment domain services.

See ``docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md``
§"Content Acquisition Pipeline", §"Deduplication Boundary", and
§"Domain Events".

Three services live here:

  * ``ContentAcquisitionService`` — reusable wrapper around the
    existing tier cascade that turns a fetched detail page into a
    ``ContentAcquisitionResult`` (description, apply URL, active state,
    confidence, quarantine reason, evidence). The service is pure
    domain logic; the caller injects the detail-page fetcher and the
    extractor cascade so tests can swap fakes without monkey-patching.
  * ``ActiveStateVerifier`` — translates a fetched detail page into an
    ``ActiveState`` value object. The default implementation looks at
    the JSON-LD ``validThrough`` / ``employmentType`` fields, the
    HTTP status returned by the fetcher, and a small set of
    closed-page text markers. Source-specific verifiers can wrap or
    replace it.
  * ``ContentDedupeService`` — finds content-duplicate candidates by
    joining on description hash, apply URL, or high-confidence content
    similarity (currently described-hash near-equality at the value-
    object boundary; the fuzzy text scoring is delegated to a callable
    to keep the domain free of NLP dependencies).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence
from urllib.parse import urlsplit, urlunsplit

from jobctl.domain.enrichment.services import (
    ExtractionResult,
)
from jobctl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    DuplicateEvidence,
    DuplicateEvidenceKind,
    FilterOverrideAudit,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctl.domain.enrichment.value_objects import (
    DetailPage,
    ExtractionTier,
    FullDescription,
)
from jobctl.infrastructure.observability.enrichment_spans import (
    active_verify_span,
    content_acquire_span,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContentAcquisitionResult:
    """Outcome of ``ContentAcquisitionService.acquire``.

    ``ok=True`` and ``description``/``description_hash``/``confidence``
    populated when the cascade produced a usable extraction. ``ok=False``
    when every tier failed or the fetcher raised; the caller should
    record a ``PostingContentSnapshotFailed`` event in that case.
    """

    ok: bool
    extraction_tier: str
    confidence: SnapshotConfidence
    quarantine_reason: QuarantineReason
    active_state: ActiveState
    verification_method: str = "unknown"
    http_status_code: int | None = None
    description: FullDescription | None = None
    description_hash: SnapshotDescriptionHash | None = None
    apply_url: SnapshotApplyUrl | None = None
    raw_text_hash: str = ""
    evidence: tuple[str, ...] = field(default_factory=tuple)
    error_class: str = ""
    error_message: str = ""
    retryable: bool = True


@dataclass(frozen=True)
class TierExtractor:
    """One step in the cascade exposed to the acquisition service.

    Mirrors the narrower ``TierExtractor`` used by the legacy enrich
    use case so callers can re-use the same constructor list.
    """

    tier: ExtractionTier
    extractor: object  # ``.extract(DetailPage) -> ExtractionResult``


# ---------------------------------------------------------------------------
# ActiveStateVerifier
# ---------------------------------------------------------------------------


_CLOSED_MARKERS = (
    "this position is no longer accepting applications",
    "no longer accepting applications",
    "this job has been filled",
    "this position has been filled",
    "this job is no longer available",
    "we are no longer accepting applications",
    "applications are closed",
    "job is closed",
    "posting is closed",
    "this requisition has been closed",
)

_REMOVED_MARKERS = (
    "page not found",
    "404",
    "this page doesn't exist",
)


class ActiveStateVerifier:
    """Decide a posting's ``ActiveState`` from a fetched detail page.

    The verifier never raises on a missing signal: ``UNKNOWN`` is the
    safe default. Callers translate ``UNKNOWN`` into
    ``QuarantineReason.UNKNOWN_ACTIVE_STATE`` upstream.
    """

    def verify(self, page: DetailPage) -> tuple[ActiveState, str]:
        """Return ``(active_state, verification_method)``.

        ``verification_method`` is one of ``"http_status"``,
        ``"json_ld_valid_through"``, ``"closed_marker"``,
        ``"removed_marker"``, ``"default_body_present"``, or
        ``"unknown"``. The caller writes the method onto the resulting
        ``JobActiveStateChanged`` event so Operations can break down
        which signal moved which job.
        """
        # 1. HTTP status is the cheapest signal.
        if page.status is not None:
            if page.status == 410:
                return ActiveState.REMOVED, "http_status"
            if page.status == 404:
                return ActiveState.REMOVED, "http_status"
        # 2. JSON-LD ``validThrough`` carries an ISO-8601 deadline.
        for ld in page.json_ld:
            posting = _find_job_posting(ld)
            if not posting:
                continue
            valid_through = posting.get("validThrough")
            if isinstance(valid_through, str) and valid_through.strip():
                if _is_past(valid_through):
                    return ActiveState.EXPIRED, "json_ld_valid_through"
                return ActiveState.ACTIVE, "json_ld_valid_through"
        # 3. Body markers — closed, then removed.
        body = page.html.lower() if page.html else ""
        if body:
            for marker in _CLOSED_MARKERS:
                if marker in body:
                    return ActiveState.CLOSED, "closed_marker"
            for marker in _REMOVED_MARKERS:
                if marker in body:
                    return ActiveState.REMOVED, "removed_marker"
            # 4. Plain success body without closed markers — assume active.
            return ActiveState.ACTIVE, "default_body_present"
        return ActiveState.UNKNOWN, "unknown"


def _find_job_posting(data: object) -> dict | None:
    if isinstance(data, dict):
        if data.get("@type") == "JobPosting":
            return data
        graph = data.get("@graph")
        if isinstance(graph, list):
            for item in graph:
                result = _find_job_posting(item)
                if result:
                    return result
    elif isinstance(data, list):
        for item in data:
            result = _find_job_posting(item)
            if result:
                return result
    return None


def _is_past(iso_text: str) -> bool:
    """Return True when ``iso_text`` parses to a past instant.

    Returns False on parse failure to keep the verifier conservative
    (a broken date should not auto-expire a posting).
    """
    from datetime import datetime, timezone

    text = iso_text.strip()
    candidates = (
        text,
        text.replace("Z", "+00:00") if text.endswith("Z") else text,
    )
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed < datetime.now(tz=timezone.utc)
    return False


# ---------------------------------------------------------------------------
# Confidence judge — extraction tier + result quality => SnapshotConfidence
# ---------------------------------------------------------------------------


_HIGH_CONFIDENCE_MIN_LEN = 400
_MEDIUM_CONFIDENCE_MIN_LEN = 200


def judge_snapshot_confidence(
    *,
    tier: ExtractionTier,
    description: FullDescription,
    apply_url_present: bool,
) -> SnapshotConfidence:
    """Heuristic three-bucket judgement consistent with the RFC schema.

    JSON-LD with apply URL and a long description is HIGH; CSS without
    apply URL is MEDIUM; LLM fallback or short descriptions are LOW
    unless an apply URL is also present.
    """
    length = len(description.text)
    if tier is ExtractionTier.JSON_LD and apply_url_present and length >= _MEDIUM_CONFIDENCE_MIN_LEN:
        return SnapshotConfidence.HIGH
    if tier is ExtractionTier.CSS_SELECTORS:
        if length >= _HIGH_CONFIDENCE_MIN_LEN and apply_url_present:
            return SnapshotConfidence.HIGH
        if length >= _MEDIUM_CONFIDENCE_MIN_LEN:
            return SnapshotConfidence.MEDIUM
        return SnapshotConfidence.LOW
    if tier is ExtractionTier.LLM_ASSISTED:
        if length >= _HIGH_CONFIDENCE_MIN_LEN and apply_url_present:
            return SnapshotConfidence.MEDIUM
        return SnapshotConfidence.LOW
    if length < _MEDIUM_CONFIDENCE_MIN_LEN:
        return SnapshotConfidence.LOW
    return SnapshotConfidence.MEDIUM


# ---------------------------------------------------------------------------
# ContentAcquisitionService
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FetcherProtocol:
    """Minimal duck type — extracted so tests can hand in fakes."""

    fetch: Callable[[str], DetailPage]


class ContentAcquisitionService:
    """Reusable wrapper around fetch + extraction cascade + active verify.

    The legacy ``EnrichJobUseCase`` keeps owning the
    ``JobEnrichment`` aggregate. PR3 callers (the snapshot use case and
    any future scheduler integration) use this service to capture a
    versioned ``PostingContentSnapshot`` *without* touching the
    canonical ``JobEnrichment`` invariants. The first usable snapshot
    may *also* feed ``JobEnrichment`` if it is still in ``pending``;
    that decision lives in the use case, not the service.
    """

    def __init__(
        self,
        *,
        fetcher: object,  # ``.fetch(url) -> DetailPage``
        extractors: Sequence[TierExtractor],
        active_verifier: ActiveStateVerifier | None = None,
    ) -> None:
        if not extractors:
            raise ValueError(
                "ContentAcquisitionService requires at least one TierExtractor"
            )
        self._fetcher = fetcher
        self._extractors = tuple(extractors)
        self._active_verifier = active_verifier or ActiveStateVerifier()

    # ------------------------------------------------------------------

    def acquire(
        self,
        *,
        url: str,
        source_id: str,
        tenant_id: str = "",
        job_id: str = "",
        policy_id: str = "unknown",
        filter_override: FilterOverrideAudit | None = None,
    ) -> ContentAcquisitionResult:
        """Fetch and extract one detail page.

        ``filter_override``, when present, signals that the caller is
        admitting a snapshot through a policy-compliant override of an
        internal JobCtl filter (e.g. ``low_confidence_extraction``
        or ``short_description``). The override audit is propagated
        onto the resulting ``PostingContentSnapshot`` and logged.
        """
        with content_acquire_span(
            tenant_id=tenant_id,
            job_id=job_id,
            source_id=source_id,
            extraction_tier="pending",
            policy_id=policy_id,
        ) as acquire_span:
            try:
                page = self._fetcher.fetch(url)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001 — translate into structured failure
                log.warning(
                    "ContentAcquisitionService: fetch error source_id=%s url=%s err=%s",
                    source_id,
                    url,
                    exc,
                )
                acquire_span.set_attribute("extraction.tier", ExtractionTier.JSON_LD.value)
                return ContentAcquisitionResult(
                    ok=False,
                    extraction_tier=ExtractionTier.JSON_LD.value,
                    confidence=SnapshotConfidence.LOW,
                    quarantine_reason=QuarantineReason.NONE,
                    active_state=ActiveState.UNKNOWN,
                    error_class="FETCH_ERROR",
                    error_message=str(exc)[:500],
                    retryable=True,
                )

            with active_verify_span(
                tenant_id=tenant_id,
                job_id=job_id,
                source_id=source_id,
                active_state=ActiveState.UNKNOWN.value,
                verification_method="pending",
                http_status_code=page.status,
            ) as verify_span:
                active_state, verification_method = self._active_verifier.verify(page)
                verify_span.set_attribute("active.state", active_state.value)
                verify_span.set_attribute("verification.method", verification_method)

            last_apply_url: SnapshotApplyUrl | None = None
            last_tier_attempted: ExtractionTier = self._extractors[0].tier
            for step in self._extractors:
                last_tier_attempted = step.tier
                try:
                    result: ExtractionResult = step.extractor.extract(page)  # type: ignore[attr-defined]
                except Exception as exc:  # noqa: BLE001 — keep walking the cascade
                    log.warning(
                        "ContentAcquisitionService: extractor %s raised: %s",
                        step.tier.value,
                        exc,
                    )
                    continue
                if result.application_url is not None:
                    last_apply_url = SnapshotApplyUrl(value=result.application_url.value)
                if result.ok and result.full_description is not None:
                    final_apply = (
                        SnapshotApplyUrl(value=result.application_url.value)
                        if result.application_url is not None
                        else last_apply_url
                    )
                    description = result.full_description
                    hash_ = SnapshotDescriptionHash.from_text(description.text)
                    confidence = judge_snapshot_confidence(
                        tier=step.tier,
                        description=description,
                        apply_url_present=final_apply is not None,
                    )
                    quarantine = _quarantine_for_capture(
                        confidence=confidence,
                        active_state=active_state,
                        has_apply_url=final_apply is not None,
                        filter_override=filter_override,
                    )
                    evidence = _capture_evidence(
                        tier=step.tier,
                        apply_url_present=final_apply is not None,
                        description_length=len(description.text),
                    )
                    acquire_span.set_attribute("extraction.tier", step.tier.value)
                    acquire_span.set_attribute("snapshot.hash", hash_.value)
                    return ContentAcquisitionResult(
                        ok=True,
                        extraction_tier=step.tier.value,
                        confidence=confidence,
                        quarantine_reason=quarantine,
                        active_state=active_state,
                        verification_method=verification_method,
                        http_status_code=page.status,
                        description=description,
                        description_hash=hash_,
                        apply_url=final_apply,
                        raw_text_hash="",  # Reserved for forensics; populated by future fetchers.
                        evidence=evidence,
                    )

            log.info(
                "ContentAcquisitionService: extraction exhausted source_id=%s url=%s last_tier=%s",
                source_id,
                url,
                last_tier_attempted.value,
            )
            acquire_span.set_attribute("extraction.tier", last_tier_attempted.value)
            return ContentAcquisitionResult(
                ok=False,
                extraction_tier=last_tier_attempted.value,
                confidence=SnapshotConfidence.LOW,
                quarantine_reason=QuarantineReason.NONE,
                active_state=active_state,
                verification_method=verification_method,
                http_status_code=page.status,
                error_class="EXTRACTION_EXHAUSTED",
                error_message=(
                    f"All extraction tiers failed (last: {last_tier_attempted.value})"
                ),
                retryable=True,
            )


def _quarantine_for_capture(
    *,
    confidence: SnapshotConfidence,
    active_state: ActiveState,
    has_apply_url: bool,
    filter_override: FilterOverrideAudit | None,
) -> QuarantineReason:
    """Classify a captured snapshot's quarantine reason.

    The default rules match the RFC's "Quarantine" table:

      * UNKNOWN active state → quarantine for review.
      * LOW confidence WITHOUT a filter override → quarantine.
      * LOW confidence WITH an explicit filter override → admit; the
        override audit will be persisted on the snapshot, and the
        admission is logged via ``FilterOverrideLogger``.
      * Otherwise NONE.
    """
    if active_state is ActiveState.UNKNOWN:
        return QuarantineReason.UNKNOWN_ACTIVE_STATE
    if confidence is SnapshotConfidence.LOW and filter_override is None:
        return QuarantineReason.LOW_CONFIDENCE_EXTRACTION
    if not has_apply_url and active_state is ActiveState.ACTIVE and filter_override is None:
        return QuarantineReason.LOW_CONFIDENCE_EXTRACTION
    return QuarantineReason.NONE


def _capture_evidence(
    *,
    tier: ExtractionTier,
    apply_url_present: bool,
    description_length: int,
) -> tuple[str, ...]:
    """Stable evidence strings for the snapshot row.

    Kept short and parameter-free so traces and logs round-trip
    safely. Live text is never included.
    """
    parts: list[str] = [f"tier:{tier.value}", f"description_length:{description_length}"]
    parts.append(f"apply_url_present:{str(apply_url_present).lower()}")
    return tuple(parts)


# ---------------------------------------------------------------------------
# ContentDedupeService
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DedupeIndexEntry:
    """One row of the in-memory dedupe index keyed by another job.

    The Discovery context is the authoritative writer for actual
    duplicate links; this service surfaces *candidates* that
    Enrichment can publish via ``ContentDuplicateCandidateDetected``.
    """

    candidate_job_id: str
    description_hash: SnapshotDescriptionHash
    apply_url: SnapshotApplyUrl | None = None
    cleaned_text: str = ""


@dataclass(frozen=True)
class DedupeFinding:
    candidate_job_id: str
    evidence: tuple[DuplicateEvidence, ...]
    confidence: float


SimilarityScorer = Callable[[str, str], float]


def _default_similarity(left: str, right: str) -> float:
    """Conservative default similarity score in [0, 1].

    Token Jaccard over case-folded alphanumeric word tuples — small
    enough to live in the domain layer with no external dependency.
    Empty inputs return 0.
    """
    left_tokens = _tokenize(left)
    right_tokens = _tokenize(right)
    if not left_tokens or not right_tokens:
        return 0.0
    inter = left_tokens & right_tokens
    union = left_tokens | right_tokens
    return len(inter) / len(union)


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.casefold()))


_DEFAULT_SIMILARITY_THRESHOLD = 0.85


class ContentDedupeService:
    """Find content-duplicate candidates for a freshly captured snapshot.

    The service is pure: callers pass in the index of known jobs and
    receive zero or more findings. The use case decides which findings
    become ``ContentDuplicateCandidate`` records on the aggregate (and
    therefore which trigger ``ContentDuplicateCandidateDetected``).
    """

    def __init__(
        self,
        *,
        similarity: SimilarityScorer | None = None,
        similarity_threshold: float = _DEFAULT_SIMILARITY_THRESHOLD,
    ) -> None:
        if not 0.0 < similarity_threshold <= 1.0:
            raise ValueError(
                "ContentDedupeService.similarity_threshold must be in (0, 1]"
            )
        self._similarity = similarity or _default_similarity
        self._similarity_threshold = similarity_threshold

    def find_candidates(
        self,
        *,
        job_id: str,
        description_hash: SnapshotDescriptionHash,
        apply_url: SnapshotApplyUrl | None,
        cleaned_text: str | None,
        index: Iterable[DedupeIndexEntry],
    ) -> list[DedupeFinding]:
        """Return findings against the given index.

        ``job_id`` is the job we're testing — entries with the same
        id are skipped. Findings are deduplicated by candidate id;
        when multiple signals match (hash AND apply URL) the
        evidence list carries every contributing piece.
        """
        findings: dict[str, list[DuplicateEvidence]] = {}
        for entry in index:
            if entry.candidate_job_id == job_id:
                continue
            evidence: list[DuplicateEvidence] = []
            if entry.description_hash.value == description_hash.value:
                evidence.append(
                    DuplicateEvidence(
                        kind=DuplicateEvidenceKind.DESCRIPTION_HASH_MATCH,
                        matched_value=description_hash.value,
                        confidence=1.0,
                    )
                )
            if (
                apply_url is not None
                and entry.apply_url is not None
                and _normalize_url(entry.apply_url.value)
                == _normalize_url(apply_url.value)
            ):
                evidence.append(
                    DuplicateEvidence(
                        kind=DuplicateEvidenceKind.APPLY_URL_MATCH,
                        matched_value=_normalize_url(apply_url.value),
                        confidence=0.95,
                    )
                )
            if cleaned_text and entry.cleaned_text:
                score = self._similarity(cleaned_text, entry.cleaned_text)
                if score >= self._similarity_threshold:
                    evidence.append(
                        DuplicateEvidence(
                            kind=DuplicateEvidenceKind.HIGH_CONFIDENCE_CONTENT_SIMILARITY,
                            matched_value=f"similarity:{score:.4f}",
                            confidence=score,
                        )
                    )
            if evidence:
                findings.setdefault(entry.candidate_job_id, []).extend(evidence)
        result: list[DedupeFinding] = []
        for candidate_id, evidence_items in findings.items():
            confidence = max(item.confidence for item in evidence_items)
            result.append(
                DedupeFinding(
                    candidate_job_id=candidate_id,
                    evidence=tuple(evidence_items),
                    confidence=confidence,
                )
            )
        return result


def _normalize_url(value: str) -> str:
    """Normalize a URL for comparison purposes only.

    Lowercases scheme/host, removes default ports, removes a trailing
    slash, and strips fragments. We deliberately keep the path /
    query intact so distinct postings on the same board don't collide.
    """
    if not value:
        return value
    try:
        parts = urlsplit(value.strip())
    except Exception:
        return value.strip()
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()
    if netloc.endswith(":80") and scheme == "http":
        netloc = netloc[:-3]
    if netloc.endswith(":443") and scheme == "https":
        netloc = netloc[:-4]
    path = parts.path.rstrip("/") or parts.path
    return urlunsplit((scheme, netloc, path, parts.query, ""))


__all__ = [
    "ActiveStateVerifier",
    "ContentAcquisitionResult",
    "ContentAcquisitionService",
    "ContentDedupeService",
    "DedupeFinding",
    "DedupeIndexEntry",
    "TierExtractor",
    "judge_snapshot_confidence",
]
