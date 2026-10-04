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
import hashlib
from datetime import datetime, timezone

from bs4 import BeautifulSoup
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

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

    def verify(self, page: DetailPage, *, signals: list[dict[str, object]] | None = None) -> tuple[ActiveState, str]:
        """Verify current source-bound evidence; body presence is never proof."""
        if page.status is not None and page.status not in {200, 201, 202, 203, 204, 404, 410}:
            return ActiveState.UNKNOWN, "http_error"
        if not same_posting_url(page.url, page.final_url or page.url):
            return ActiveState.UNKNOWN, "identity_lost"
        if not page.status_evidence_complete:
            reason = page.status_evidence_reason or "incomplete_status_evidence"
            if signals is not None:
                signals.append({"kind": "acquisition_failure", "value": reason})
            return ActiveState.UNKNOWN, reason
        soup = BeautifulSoup(page.status_html or page.html or "", "html.parser")
        if soup.select_one('input[type="password"], .g-recaptcha, #challenge-form') or any(
            phrase in soup.get_text(" ", strip=True).lower()[:1000]
            for phrase in ("verify you are human", "access denied", "sign in to continue", "just a moment")
        ):
            return ActiveState.UNKNOWN, "access_challenge"
        if page.status in {404, 410}:
            return ActiveState.REMOVED, "http_status"
        postings = [posting for ld in page.json_ld for posting in _find_job_postings(ld)]
        for posting in postings:
            identity_url = posting.get("url") or posting.get("@id")
            if not isinstance(identity_url, str) or not identity_url.strip():
                return ActiveState.UNKNOWN, "missing_posting_identity"
            if not same_posting_url(page.url, identity_url):
                return ActiveState.UNKNOWN, "identity_mismatch"
        # Remove historical descriptions and script text before inspecting current
        # status controls. Closure language in accepted content is not a banner.
        for element in soup.select('script, style, [itemprop="description"], .job-description, '
                                   '.posting-description, #job-description, .description, '
                                   '[data-testid*="description"], .jobs-description, '
                                   '.show-more-less-html__markup, .description__text, '
                                   '.jobs-box__html-content, .job-details-description'):
            element.decompose()
        for posting in postings:
            description = posting.get("description")
            if isinstance(description, str):
                description_text = " ".join(BeautifulSoup(description, "html.parser").stripped_strings)
                # Match a whole DOM subtree, including fragmented h2/p text.
                # Never remove an ancestor carrying a separate status/control.
                for element in list(soup.find_all(True)):
                    if element.parent is not None and description_text and " ".join(element.stripped_strings) == description_text:
                        element.decompose()
        controls = soup.select('[role="alert"], [role="status"], .alert, .job-closed, '
                               '.posting-closed, .job-unavailable, .job-alert, aside, header, h1, h2, button, input[type="submit"]')
        closed = any(marker in control.get_text(" ", strip=True).lower()
                     for control in controls for marker in _CLOSED_MARKERS)
        # A short standalone status page also counts; full descriptions do not.
        visible = soup.get_text(" ", strip=True).lower()
        closed = closed or (len(visible) < 300 and any(marker in visible for marker in _CLOSED_MARKERS)
                            and not postings)
        if signals is not None and closed:
            signals.append({"kind": "current_closed_status", "value": True})
        deadlines: list[bool] = []
        for posting in postings:
            deadline = posting.get("validThrough")
            if deadline is not None:
                parsed = _parse_deadline(deadline)
                if parsed is None:
                    if signals is not None:
                        signals.append({"kind": "invalid_deadline", "value": str(deadline)[:120]})
                    return ActiveState.UNKNOWN, "invalid_deadline"
                deadlines.append(parsed < datetime.now(timezone.utc))
                if signals is not None and len(signals) < 24:
                    signals.append({"kind": "posting_deadline", "value": parsed.isoformat(), "past": deadlines[-1]})
        if (closed and any(not past for past in deadlines)) or (any(deadlines) and not all(deadlines)):
            return ActiveState.UNKNOWN, "conflicting_signals"
        if closed:
            return ActiveState.CLOSED, "closed_marker"
        if deadlines and all(deadlines):
            return ActiveState.EXPIRED, "json_ld_valid_through"
        if postings and any(isinstance(posting.get("description"), str)
                            and posting["description"].strip() for posting in postings):
            return ActiveState.ACTIVE, "json_ld_valid_through" if deadlines else "source_job_posting"
        canonical = soup.select_one('link[rel="canonical"]')
        bound_page = canonical is not None and isinstance(canonical.get("href"), str) and same_posting_url(
            page.url, str(canonical["href"])
        )
        if page.page_title and bound_page:
            for control in soup.select('button, input[type="submit"], a[href]'):
                label = control.get_text(" ", strip=True) or str(control.get("value") or "")
                if not re.fullmatch(r"apply(?: now| for this (?:job|position))?", label, re.I):
                    continue
                if control.has_attr("disabled") or control.get("aria-disabled") == "true":
                    continue
                form = control.find_parent("form")
                target = control.get("href") or (form.get("action") if form else None)
                if isinstance(target, str) and same_posting_url(page.url, urljoin(page.final_url or page.url, target)):
                    return ActiveState.ACTIVE, "source_apply_control"
        return ActiveState.UNKNOWN, "missing_current_evidence"


_TRACKING_QUERY_KEYS = frozenset({"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source", "gh_src", "lever-source"})


def same_posting_url(expected: str, actual: str) -> bool:
    """Preserve every identity query field; discard only known tracking keys."""
    try:
        first, second = urlsplit(expected), urlsplit(actual)
        def path(value: str) -> str:
            return value.rstrip("/").removesuffix("/apply")
        def query(value: str) -> list[tuple[str, str]]:
            return sorted((key, item) for key, item in parse_qsl(value, keep_blank_values=True)
                          if key.lower() not in _TRACKING_QUERY_KEYS)
        host_match = first.hostname == second.hostname or {first.hostname, second.hostname} <= {
            "boards.greenhouse.io", "job-boards.greenhouse.io"
        }
        return bool(first.hostname and path(first.path) and first.scheme in {"http", "https"}
                    and second.scheme in {"http", "https"} and host_match
                    and first.port == second.port and path(first.path) == path(second.path)
                    and query(first.query) == query(second.query))
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
    apply URL is MEDIUM; a sufficiently complete LLM-assisted description
    is MEDIUM whether or not an application URL was recovered. Application
    target readiness is a separate fact and must not downgrade readable
    posting content.
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
        if length >= _HIGH_CONFIDENCE_MIN_LEN:
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
                        raw_text_hash=page.raw_html_hash or hashlib.sha256((page.status_html or page.html).encode("utf-8")).hexdigest(),
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
      * Missing application URL → does not change description trust;
        application-target readiness is tracked separately.
      * Otherwise NONE.
    """
    if active_state is ActiveState.UNKNOWN:
        return QuarantineReason.UNKNOWN_ACTIVE_STATE
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
