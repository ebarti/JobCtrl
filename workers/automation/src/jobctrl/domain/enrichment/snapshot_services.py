"""Content acquisition and exact duplicate identity.

Page availability and description quality come from cited model determinations.
URL identity, HTTP status, structured extraction and canonical hashes remain
mechanical. Fuzzy duplicate candidates need an explicit duplicate determination.
"""

from __future__ import annotations

import logging
import hashlib
from datetime import datetime, timezone

from bs4 import BeautifulSoup
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from jobctrl.domain.enrichment.services import (
    ExtractionResult,
)
from jobctrl.domain.enrichment.snapshot_value_objects import (
    ActiveState,
    DuplicateEvidence,
    DuplicateEvidenceKind,
    FilterOverrideAudit,
    QuarantineReason,
    SnapshotApplyUrl,
    SnapshotConfidence,
    SnapshotDescriptionHash,
)
from jobctrl.domain.enrichment.value_objects import (
    DetailPage,
    ExtractionTier,
    FullDescription,
)
from jobctrl.infrastructure.observability.enrichment_spans import (
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


class ActiveStateVerifier:
    """Mechanical URL/status fencing around a cited page interpretation."""

    def __init__(self, *, page_interpreter):
        self._interpreter = page_interpreter

    def verify(self, page, *, signals=None):
        if not same_posting_url(page.url, page.final_url or page.url):
            return ActiveState.UNKNOWN, "identity_lost"
        if page.status in {404, 410}:
            if signals is not None:
                signals.append({"kind": "http_status", "value": str(page.status)})
            return ActiveState.REMOVED, "http_status"
        if page.status is not None and page.status not in {200, 201, 202, 203, 204, 404, 410}:
            return ActiveState.UNKNOWN, "http_error"
        if not page.status_evidence_complete:
            if signals is not None:
                signals.append(
                    {
                        "kind": "acquisition_failure",
                        "value": page.status_evidence_reason or "incomplete_status_evidence",
                    }
                )
            return ActiveState.UNKNOWN, page.status_evidence_reason or "incomplete_status_evidence"
        soup = BeautifulSoup(page.status_html or page.html or "", "html.parser")
        for element in list(soup.find_all(True)):
            if element.parent is None:
                continue
            style = str(element.get("style") or "")
            if (
                element.name in {"template", "noscript", "script", "style"}
                or element.has_attr("hidden")
                or element.has_attr("inert")
                or str(element.get("aria-hidden") or "").lower() == "true"
                or re.search(
                    r"(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)",
                    style,
                    re.I,
                )
            ):
                element.decompose()
        result, envelope = self._interpreter.interpret(
            entity_id=page.url,
            text=soup.get_text(" ", strip=True),
            metadata={
                "url": page.url,
                "final_url": page.final_url,
                "http_status": page.status,
                "title": page.page_title,
                "visibility_verified": page.status_visibility_verified,
                "structured_postings": page.json_ld,
            },
        )
        if signals is not None:
            signals.append({"kind": "page_determination", "determination_id": envelope.determination_id})
        reason = (
            "access_challenge"
            if result.access_state.value in {"login_required", "challenge"}
            else "model_determination"
        )
        return ActiveState(result.availability.value), reason

    def description_quality(self, *, tier, description, apply_url_present):
        result, envelope = self._interpreter.description_quality(
            text=description.text, metadata={"extraction_tier": tier.value, "apply_url_present": apply_url_present}
        )
        return SnapshotConfidence(result.confidence), envelope


_TRACKING_QUERY_KEYS = frozenset(
    {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source", "gh_src", "lever-source"}
)


def same_posting_url(expected: str, actual: str) -> bool:
    """Preserve every identity query field; discard only known tracking keys."""
    try:
        first, second = urlsplit(expected), urlsplit(actual)

        def path(value: str) -> str:
            return value.rstrip("/").removesuffix("/apply")

        def query(value: str) -> list[tuple[str, str]]:
            return sorted(
                (key, item)
                for key, item in parse_qsl(value, keep_blank_values=True)
                if key.lower() not in _TRACKING_QUERY_KEYS
            )

        host_match = first.hostname == second.hostname or {first.hostname, second.hostname} <= {
            "boards.greenhouse.io",
            "job-boards.greenhouse.io",
        }
        return bool(
            first.hostname
            and path(first.path)
            and first.scheme in {"http", "https"}
            and second.scheme in {"http", "https"}
            and host_match
            and first.port == second.port
            and path(first.path) == path(second.path)
            and query(first.query) == query(second.query)
        )
    except ValueError:
        return False


def _parse_deadline(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    # An unzoned date cannot prove an instant; do not silently assume UTC.
    return parsed if parsed.tzinfo is not None else None


def _find_job_postings(data: object) -> list[dict]:
    if isinstance(data, dict):
        type_ = data.get("@type")
        current = [data] if type_ == "JobPosting" or isinstance(type_, list) and "JobPosting" in type_ else []
        return current + _find_job_postings(data.get("@graph"))
    if isinstance(data, list):
        return [posting for item in data for posting in _find_job_postings(item)]
    return []


def _find_job_posting(data: object) -> dict | None:
    postings = _find_job_postings(data)
    return postings[0] if postings else None


def _is_past(iso_text: str) -> bool:
    parsed = _parse_deadline(iso_text)
    return parsed is not None and parsed < datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Confidence judge — extraction tier + result quality => SnapshotConfidence
# ---------------------------------------------------------------------------


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
        active_verifier: ActiveStateVerifier,
    ) -> None:
        if not extractors:
            raise ValueError("ContentAcquisitionService requires at least one TierExtractor")
        self._fetcher = fetcher
        self._extractors = tuple(extractors)
        self._active_verifier = active_verifier

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
        internal JobCtrl filter (e.g. ``low_confidence_extraction``
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
                determination_signals = []
                active_state, verification_method = self._active_verifier.verify(page, signals=determination_signals)
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
                    confidence, quality_envelope = self._active_verifier.description_quality(
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
                    evidence = (
                        *_capture_evidence(
                            tier=step.tier,
                            apply_url_present=final_apply is not None,
                            description_length=len(description.text),
                        ),
                        f"description_quality_determination:{quality_envelope.determination_id}",
                        *(
                            f"page_interpretation_determination:{signal['determination_id']}"
                            for signal in determination_signals
                            if signal["kind"] == "page_determination"
                        ),
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
                        raw_text_hash=page.raw_html_hash
                        or hashlib.sha256((page.status_html or page.html).encode("utf-8")).hexdigest(),
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
                error_message=(f"All extraction tiers failed (last: {last_tier_attempted.value})"),
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

      * Availability uncertainty alone does not change description trust.
      * LOW confidence WITHOUT a filter override → quarantine.
      * LOW confidence WITH an explicit filter override → admit; the
        override audit will be persisted on the snapshot, and the
        admission is logged via ``FilterOverrideLogger``.
      * Missing application URL → does not change description trust;
        application-target readiness is tracked separately.
      * Otherwise NONE.
    """
    if confidence is SnapshotConfidence.LOW and filter_override is None:
        return QuarantineReason.LOW_CONFIDENCE_EXTRACTION
    if not has_apply_url:
        return QuarantineReason.NONE
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


class ContentDedupeService:
    """Find content-duplicate candidates for a freshly captured snapshot.

    The service is pure: callers pass in the index of known jobs and
    receive zero or more findings. The use case decides which findings
    become ``ContentDuplicateCandidate`` records on the aggregate (and
    therefore which trigger ``ContentDuplicateCandidateDetected``).
    """

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
                and _normalize_url(entry.apply_url.value) == _normalize_url(apply_url.value)
            ):
                evidence.append(
                    DuplicateEvidence(
                        kind=DuplicateEvidenceKind.APPLY_URL_MATCH,
                        matched_value=_normalize_url(apply_url.value),
                        confidence=0.95,
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
]
